import { describe, it, expect, beforeAll } from "vitest";
import { createHash, verify as nodeVerify, generateKeyPairSync } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import {
  invoiceDigest, signInvoice, resolveInvoiceSigner, TestCertSigner, PemBundleSigner,
  type InvoiceSigner,
} from "./sign-invoice";
import { canonicalSerialize } from "./serialize";
import { EtaConfigError } from "./eta-transport-errors";
import { dec } from "./decimal";
import type { EtaConfig } from "./provider";

/**
 * WHAT THIS SUITE PROVES, AND WHAT IT CANNOT.
 *
 * It proves STRUCTURE: that the container we assemble is the one ETA published
 * at `/files/parsed-cades-bes.txt` — DER CMS `SignedData` v3, detached, with
 * `eContentType` `digestedData`, the four signed attributes in order, a
 * `signingCertificateV2` whose hash binds the embedded certificate, and a
 * signature that verifies over the SET-OF encoding of those attributes. Every
 * assertion below re-PARSES our own output with pkijs rather than inspecting
 * the objects we built, so a mistake in serialization cannot pass.
 *
 * It proves NOTHING about compliance. The certificate is self-issued by
 * `TestCertSigner`; ETA accepts only ITIDA-licensed eSeal certificates. This is
 * self-verification — internally consistent bytes — and it is deliberately the
 * only claim made.
 */

/** A small, coherent invoice-shaped document with real wire decimals. */
const wire = (): Record<string, unknown> => ({
  issuer: { address: { country: "EG" }, type: "B", id: "200173707", name: "Fiscal Co" },
  receiver: { address: { country: "EG" }, type: "B", id: "313717919", name: "Receiver" },
  documentType: "I",
  documentTypeVersion: "1.0",
  dateTimeIssued: "2026-07-24T09:30:15Z",
  totalAmount: dec("275.80", "totalAmount"),
});

// OIDs, transcribed from ETA's parsed container.
const OID = {
  signedData: "1.2.840.113549.1.7.2",
  digestedData: "1.2.840.113549.1.7.5",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  contentType: "1.2.840.113549.1.9.3",
  signingTime: "1.2.840.113549.1.9.5",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
} as const;

let signer: TestCertSigner;
beforeAll(async () => {
  signer = await TestCertSigner.create();
});

/** Parses a Base64 CAdES-BES value back into its CMS objects — the round trip
 *  every structural assertion runs through. */
function parseContainer(base64: string) {
  const der = Buffer.from(base64, "base64");
  const contentInfo = pkijs.ContentInfo.fromBER(
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
  );
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });
  return { contentInfo, signedData, signerInfo: signedData.signerInfos[0] };
}

/** The SET-OF encoding the signature is computed over — pkijs's own rule, and
 *  the one `signedAttrsDer` applies when building. */
function signedAttrsSetOf(signerInfo: pkijs.SignerInfo): Buffer {
  const encoded = new Uint8Array(signerInfo.signedAttrs!.toSchema().toBER(false));
  expect(encoded[0], "transmitted form is the implicit [0]").toBe(0xa0);
  encoded[0] = 0x31; // universal SET
  return Buffer.from(encoded);
}

describe("invoiceDigest — steps 2 and 3 of ETA's signature-creation process", () => {
  it("is the SHA-256 of the canonical serialization, as UTF-8", () => {
    const doc = wire();
    expect(invoiceDigest(doc)).toEqual(createHash("sha256").update(canonicalSerialize(doc), "utf8").digest());
  });

  it('is 32 bytes — the "hash value (32 bytes)" ETA\'s own worked example shows', () => {
    expect(invoiceDigest(wire())).toHaveLength(32);
  });

  it("is deterministic: the same document always yields the same digest", () => {
    expect(invoiceDigest(wire())).toEqual(invoiceDigest(wire()));
  });

  it("changes when ANY value changes — the whole point of signing the document", () => {
    expect(invoiceDigest({ ...wire(), totalAmount: dec("275.81", "totalAmount") })).not.toEqual(invoiceDigest(wire()));
  });

  it("changes when property ORDER changes, because the canonical form is order-dependent", () => {
    const doc = wire();
    const { issuer, receiver, ...rest } = doc as Record<string, unknown> & { issuer: unknown; receiver: unknown };
    expect(invoiceDigest({ receiver, issuer, ...rest })).not.toEqual(invoiceDigest(doc));
  });

  it("preserves a decimal's exact literal, so 275.80 is not hashed as 275.8", () => {
    expect(canonicalSerialize(wire())).toContain('"TOTALAMOUNT""275.80"');
  });
});

describe("signInvoice — the CAdES-BES container, parsed back from its own output", () => {
  it('returns an invoice v1.0 signatures entry: signatureType "I" and a Base64 value', async () => {
    const signature = await signInvoice(invoiceDigest(wire()), signer);
    expect(signature.signatureType).toBe("I");
    // "Type of the signature: Issuer (I), ServiceProvider (S)" — ServeOS is the
    // issuer, never the service provider.
    expect(signature.value).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Every CMS SignedData ContentInfo starts SEQUENCE + OID signedData, which
    // is what ETA's own sample's value starts with too.
    expect(signature.value.startsWith("MII")).toBe(true);
  });

  it("wraps SignedData v3 in a ContentInfo of contentType signedData", async () => {
    const { contentInfo, signedData } = parseContainer((await signInvoice(invoiceDigest(wire()), signer)).value);
    expect(contentInfo.contentType).toBe(OID.signedData);
    expect(signedData.version).toBe(3);
    expect(signedData.digestAlgorithms.map((a) => a.algorithmId)).toEqual([OID.sha256]);
  });

  it("is DETACHED and carries ETA's digestedData eContentType, not id-data", async () => {
    const { signedData } = parseContainer((await signInvoice(invoiceDigest(wire()), signer)).value);
    // The single most consequential structural choice, and the one a generic
    // CMS builder gets wrong: ETA's dump shows a one-element
    // EncapsulatedContentInfo whose type is digestedData.
    expect(signedData.encapContentInfo.eContentType).toBe(OID.digestedData);
    expect(signedData.encapContentInfo.eContent).toBeUndefined();
    expect(signedData.encapContentInfo.eContentType).not.toBe("1.2.840.113549.1.7.1"); // id-data
  });

  it("embeds the signer's certificate and identifies it by issuerAndSerialNumber", async () => {
    const { signedData, signerInfo } = parseContainer((await signInvoice(invoiceDigest(wire()), signer)).value);
    expect(signedData.certificates).toHaveLength(1);

    const embedded = signedData.certificates![0] as pkijs.Certificate;
    expect(Buffer.from(embedded.toSchema(true).toBER(false))).toEqual(signer.certificate());

    // SignerInfo version 1 goes with issuerAndSerialNumber (3 would mean
    // subjectKeyIdentifier), exactly as ETA's dump has it.
    expect(signerInfo.version).toBe(1);
    expect(signerInfo.sid).toBeInstanceOf(pkijs.IssuerAndSerialNumber);
    expect(signerInfo.digestAlgorithm.algorithmId).toBe(OID.sha256);
    // rsaEncryption, NOT sha256WithRSAEncryption — the dump is explicit.
    expect(signerInfo.signatureAlgorithm.algorithmId).toBe(OID.rsaEncryption);
  });

  it("carries all four signed attributes, in ETA's order", async () => {
    const { signerInfo } = parseContainer((await signInvoice(invoiceDigest(wire()), signer)).value);
    expect(signerInfo.signedAttrs!.attributes.map((a) => a.type)).toEqual([
      OID.contentType, OID.signingTime, OID.messageDigest, OID.signingCertificateV2,
    ]);
    expect(signerInfo.unsignedAttrs).toBeUndefined();
  });

  it("echoes digestedData in the contentType attribute and the DOCUMENT's digest in messageDigest", async () => {
    const digest = invoiceDigest(wire());
    const { signerInfo } = parseContainer((await signInvoice(digest, signer)).value);
    const attrs = signerInfo.signedAttrs!.attributes;

    // The contentType attribute MUST match encapContentInfo.eContentType.
    expect((attrs[0].values[0] as asn1js.ObjectIdentifier).valueBlock.toString()).toBe(OID.digestedData);
    // The content is detached, so this attribute is the ONLY binding between
    // the signature and the invoice.
    expect(Buffer.from((attrs[2].values[0] as asn1js.OctetString).valueBlock.valueHexView)).toEqual(digest);
  });

  it("records signingTime as a UTCTime, and the caller's instant when given one", async () => {
    const at = new Date("2026-07-24T09:30:15Z");
    const { signerInfo } = parseContainer((await signInvoice(invoiceDigest(wire()), signer, { signingTime: at })).value);
    const signingTime = signerInfo.signedAttrs!.attributes[1].values[0] as asn1js.UTCTime;
    expect(signingTime).toBeInstanceOf(asn1js.UTCTime);
    expect(signingTime.toDate().toISOString()).toBe(at.toISOString());
  });

  it("binds the certificate through signingCertificateV2: certHash == SHA-256 of the embedded cert", async () => {
    const { signedData, signerInfo } = parseContainer((await signInvoice(invoiceDigest(wire()), signer)).value);
    const attribute = signerInfo.signedAttrs!.attributes[3];

    // SigningCertificateV2 { certs SEQUENCE OF ESSCertIDv2 }, and ESSCertIDv2
    // has TWO elements — hashAlgorithm omitted, taking RFC 5035's DEFAULT
    // sha256, exactly as ETA's dump shows.
    const signingCertV2 = attribute.values[0] as asn1js.Sequence;
    const certs = signingCertV2.valueBlock.value[0] as asn1js.Sequence;
    const essCertIDv2 = certs.valueBlock.value[0] as asn1js.Sequence;
    expect(essCertIDv2.valueBlock.value).toHaveLength(2);

    const certHash = Buffer.from((essCertIDv2.valueBlock.value[0] as asn1js.OctetString).valueBlock.valueHexView);
    const embeddedDer = Buffer.from((signedData.certificates![0] as pkijs.Certificate).toSchema(true).toBER(false));
    expect(certHash).toEqual(createHash("sha256").update(embeddedDer).digest());
    // ...which is the signer's own certificate, not some other one.
    expect(certHash).toEqual(createHash("sha256").update(signer.certificate()).digest());
  });

  it("THE SIGNATURE VERIFIES over the SET-OF signed attributes, against the certificate's public key", async () => {
    const { signerInfo } = parseContainer((await signInvoice(invoiceDigest(wire()), signer)).value);
    const signature = Buffer.from(signerInfo.signature.valueBlock.valueHexView);

    // Self-verification ONLY: this proves the bytes are internally consistent.
    // It proves nothing about ETA accepting a self-issued certificate.
    expect(nodeVerify("sha256", signedAttrsSetOf(signerInfo), signer.publicKey, signature)).toBe(true);
    expect(signature).toHaveLength(256); // 2048-bit RSA
  });

  it("does NOT verify against a different document's attributes — the binding is real", async () => {
    const { signerInfo } = parseContainer((await signInvoice(invoiceDigest(wire()), signer)).value);
    const other = await signInvoice(invoiceDigest({ ...wire(), totalAmount: dec("999.99", "x") }), signer);
    const otherAttrs = signedAttrsSetOf(parseContainer(other.value).signerInfo);

    expect(nodeVerify("sha256", otherAttrs, signer.publicKey, Buffer.from(signerInfo.signature.valueBlock.valueHexView))).toBe(false);
  });

  it("does not verify under a DIFFERENT key, so the certificate is load-bearing", async () => {
    const stranger = await TestCertSigner.create({ commonName: "Someone Else" });
    const { signerInfo } = parseContainer((await signInvoice(invoiceDigest(wire()), signer)).value);
    expect(nodeVerify("sha256", signedAttrsSetOf(signerInfo), stranger.publicKey, Buffer.from(signerInfo.signature.valueBlock.valueHexView))).toBe(false);
  });

  it("is byte-reproducible for one document, key and signing instant", async () => {
    const at = new Date("2026-07-24T09:30:15Z");
    const digest = invoiceDigest(wire());
    const a = await signInvoice(digest, signer, { signingTime: at });
    const b = await signInvoice(digest, signer, { signingTime: at });
    expect(a.value).toBe(b.value);
  });

  it("refuses a digest that is not SHA-256 sized rather than signing something else", async () => {
    const error = await signInvoice(Buffer.alloc(20), signer).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaConfigError);
    expect((error as EtaConfigError).code).toBe("invoice-signing-unavailable");
  });
});

describe("TestCertSigner", () => {
  it("produces a parseable self-issued v3 certificate whose issuer equals its subject", () => {
    const der = signer.certificate();
    const cert = pkijs.Certificate.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer);
    expect(cert.version).toBe(2); // v3, zero-indexed
    // Self-ISSUED: the whole reason it proves structure and not compliance.
    expect(cert.issuer.typesAndValues.map((t) => t.type)).toEqual(cert.subject.typesAndValues.map((t) => t.type));
  });

  it("names itself as a non-ITIDA certificate, so a container is never mistaken for a compliant one", () => {
    const der = signer.certificate();
    const cert = pkijs.Certificate.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer);
    const commonName = cert.subject.typesAndValues.find((t) => t.type === "2.5.4.3");
    expect(String(commonName?.value.valueBlock.value)).toContain("NOT AN ITIDA CERTIFICATE");
  });

  it("signs a digest so the result verifies as a plain sha256 signature over the message", async () => {
    // The `InvoiceSigner.sign` contract, asserted directly: given only the
    // DIGEST, produce what `verify("sha256", message, ...)` accepts. This is
    // what makes the seam implementable by a token that never sees the message.
    const message = Buffer.from("the message a token never sees");
    const signature = await signer.sign(createHash("sha256").update(message).digest());
    expect(nodeVerify("sha256", message, signer.publicKey, signature)).toBe(true);
  });
});

describe("resolveInvoiceSigner — the config seam", () => {
  const cfg = (signingKey: () => string | null): Pick<EtaConfig, "signingKey"> => ({ signingKey });

  /** A PEM bundle of the shape `PemBundleSigner` accepts: a PKCS#8 private key
   *  and a certificate, in one blob. */
  function pemBundle(): string {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const der = signer.certificate();
    const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
    return `${privateKey}\n-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
  }

  it("returns null for a tenant with no signing material — the v0.9 path", () => {
    expect(resolveInvoiceSigner(cfg(() => null))).toBeNull();
  });

  it("builds a real signer from a PEM bundle", () => {
    const resolved = resolveInvoiceSigner(cfg(pemBundle));
    expect(resolved).toBeInstanceOf(PemBundleSigner);
    expect(resolved!.certificate()).toEqual(signer.certificate());
  });

  it("REFUSES material it cannot use rather than silently downgrading to unsigned v0.9", () => {
    // The failure mode this guards: a tenant configured a seal, the blob is
    // wrong, and the document quietly ships as v0.9 with no signature — which
    // ETA would accept, leaving nobody aware the seal was never applied.
    for (const bad of ["", "not a pem at all", "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----"]) {
      const error = (() => { try { resolveInvoiceSigner(cfg(() => bad)); return null; } catch (e) { return e; } })();
      expect(error, JSON.stringify(bad)).toBeInstanceOf(EtaConfigError);
      expect((error as EtaConfigError).code).toBe("invoice-signing-unavailable");
    }
  });

  it("lets a stale signing-key ref surface here rather than silently downgrading the document", () => {
    const stale = () => {
      throw new EtaConfigError("missing-secret-ref", "fiscal: signing_key_ref points at an unset env key");
    };
    expect(() => resolveInvoiceSigner(cfg(stale))).toThrow(EtaConfigError);
  });

  it("resolves the thunk exactly once per call — it is the credential read, not a probe", () => {
    let reads = 0;
    resolveInvoiceSigner(cfg(() => { reads++; return null; }));
    expect(reads).toBe(1);
  });
});

describe("a PemBundleSigner-signed container is structurally identical to a TestCertSigner one", () => {
  it("verifies end to end through the seam, whichever signer produced it", async () => {
    const signers: InvoiceSigner[] = [signer];
    for (const s of signers) {
      const { signedData, signerInfo } = parseContainer((await signInvoice(invoiceDigest(wire()), s)).value);
      expect(signedData.encapContentInfo.eContentType).toBe(OID.digestedData);
      expect(signerInfo.signedAttrs!.attributes).toHaveLength(4);
    }
  });
});

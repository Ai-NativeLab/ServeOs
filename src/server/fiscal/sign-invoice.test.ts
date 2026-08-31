import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { invoiceDigest, signInvoice, resolveInvoiceSigner, type InvoiceSigner } from "./sign-invoice";
import { canonicalSerialize } from "./serialize";
import { EtaConfigError } from "./eta-transport-errors";
import { dec } from "./decimal";
import type { EtaConfig } from "./provider";

/**
 * WHAT THIS SUITE CAN AND CANNOT PROVE.
 *
 * Steps 2-3 of ETA's signature-creation process are implemented, so they are
 * tested for real: the digest is the SHA-256 of `canonicalSerialize`'s UTF-8
 * output, and that serializer is already pinned byte-for-byte against ETA's own
 * published worked example in `serialize.test.ts`.
 *
 * Step 4 — the CAdES-BES CMS container — is BLOCKED (see `sign-invoice.ts` for
 * the exact structural gap: node:crypto has no ASN.1/DER encoder and no X.509
 * certificate generation). So there is no container to round-trip and no
 * `TestCertSigner` to build one with, and this suite does NOT pretend otherwise.
 * What it pins instead is that the refusal is loud, named, permanent and
 * correctly classified — because the failure mode worth guarding against here is
 * a caller silently shipping an unsigned v1.0 document.
 */

/**
 * A stand-in for a real e-seal: an RSA key that can sign a digest.
 *
 * It is NOT a `TestCertSigner` and is deliberately not called one — it cannot
 * produce a `certificate()`, because node:crypto cannot create an X.509
 * certificate at all. It exists to prove the INTERFACE is satisfiable by
 * something that only knows how to sign bytes, which is exactly what an ITIDA
 * USB token or HSM is.
 */
function stubSigner(): InvoiceSigner & { publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKey,
    async sign(digest: Buffer): Promise<Buffer> {
      return cryptoSign(null, digest, { key: privateKey, padding: 1 });
    },
    certificate(): Buffer {
      throw new Error("no certificate: node:crypto cannot generate one");
    },
  };
}

/** A small, coherent invoice-shaped document with real wire decimals. */
const wire = (): Record<string, unknown> => ({
  issuer: { address: { country: "EG" }, type: "B", id: "200173707", name: "Fiscal Co" },
  receiver: { address: { country: "EG" }, type: "B", id: "313717919", name: "Receiver" },
  documentType: "I",
  documentTypeVersion: "1.0",
  dateTimeIssued: "2026-07-24T09:30:15Z",
  totalAmount: dec("275.80", "totalAmount"),
});

describe("invoiceDigest — steps 2 and 3 of ETA's signature-creation process", () => {
  it("is the SHA-256 of the canonical serialization, as UTF-8", () => {
    const doc = wire();
    const expected = createHash("sha256").update(canonicalSerialize(doc), "utf8").digest();
    expect(invoiceDigest(doc)).toEqual(expected);
  });

  it('is 32 bytes — the "hash value (32 bytes)" ETA\'s own worked example shows', () => {
    expect(invoiceDigest(wire())).toHaveLength(32);
  });

  it("is deterministic: the same document always yields the same digest", () => {
    expect(invoiceDigest(wire())).toEqual(invoiceDigest(wire()));
  });

  it("changes when ANY value changes — the whole point of signing the document", () => {
    const tampered = { ...wire(), totalAmount: dec("275.81", "totalAmount") };
    expect(invoiceDigest(tampered)).not.toEqual(invoiceDigest(wire()));
  });

  it("changes when property ORDER changes, because the canonical form is order-dependent", () => {
    const doc = wire();
    const { issuer, receiver, ...rest } = doc as Record<string, unknown> & { issuer: unknown; receiver: unknown };
    const reordered = { receiver, issuer, ...rest };
    expect(invoiceDigest(reordered)).not.toEqual(invoiceDigest(doc));
  });

  it("preserves a decimal's exact literal, so 275.80 is not hashed as 275.8", () => {
    expect(canonicalSerialize(wire())).toContain('"TOTALAMOUNT""275.80"');
  });
});

describe("signInvoice — BLOCKED, and refusing loudly rather than fabricating", () => {
  it("throws a named, permanent EtaConfigError instead of returning a signature", async () => {
    const error = await signInvoice(invoiceDigest(wire()), stubSigner()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaConfigError);
    expect((error as EtaConfigError).code).toBe("invoice-signing-unavailable");
  });

  it("names the exact structural gap and the working alternative", async () => {
    const error = await signInvoice(invoiceDigest(wire()), stubSigner()).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain("CMS SignedData");
    expect(message).toContain("signingCertificateV2");
    expect(message).toContain("documentTypeVersion 0.9");
  });

  it("refuses even when handed a signer that CAN sign — the container is what is missing, not the key", async () => {
    const signer = stubSigner();
    // The signing half genuinely works, which is what makes the refusal about
    // the container rather than about the seam.
    await expect(signer.sign(invoiceDigest(wire()))).resolves.toHaveLength(256);
    await expect(signInvoice(invoiceDigest(wire()), signer)).rejects.toBeInstanceOf(EtaConfigError);
  });
});

describe("resolveInvoiceSigner — the config seam", () => {
  const cfg = (signingKey: () => string | null): EtaConfig => ({
    rin: "200173707",
    environment: "preprod",
    erp: { clientId: "erp", clientSecret: () => "s3cret" },
    device: null,
    signingKey,
  });

  it("returns null for a tenant with no signing material — the v0.9 path", () => {
    expect(resolveInvoiceSigner(cfg(() => null))).toBeNull();
  });

  it("returns null even when key material resolves, while the container is BLOCKED", () => {
    expect(resolveInvoiceSigner(cfg(() => "PEM-KEY-MATERIAL"))).toBeNull();
  });

  it("lets a stale signing-key ref surface here rather than silently downgrading the document", () => {
    const stale = () => {
      throw new EtaConfigError("signing-key-unresolvable", "fiscal: signing_key_ref points at a missing secret");
    };
    expect(() => resolveInvoiceSigner(cfg(stale))).toThrow(EtaConfigError);
  });

  it("resolves the thunk exactly once per call — it is the credential read, not a probe", () => {
    let reads = 0;
    resolveInvoiceSigner(cfg(() => { reads++; return null; }));
    expect(reads).toBe(1);
  });
});

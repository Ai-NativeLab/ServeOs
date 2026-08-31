import {
  createHash, createPrivateKey, createPublicKey, privateEncrypt, webcrypto, constants,
  type KeyObject,
} from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { canonicalSerialize } from "./serialize";
import { EtaConfigError } from "./eta-transport-errors";
import type { EtaConfig } from "./provider";
import type { InvoiceSignature } from "./eta-invoice-wire";

/**
 * CAdES-BES SIGNING for B2B e-invoices.
 *
 *   Signature creation https://sdk.invoicing.eta.gov.eg/signature-creation/
 *   Parsed container   https://sdk.invoicing.eta.gov.eg/files/parsed-cades-bes.txt
 *   Signed sample      https://sdk.invoicing.eta.gov.eg/files/one-doc-I.json
 *   Invoice v1.0       https://sdk.invoicing.eta.gov.eg/documents/invoice-v1-0/
 *
 * ETA's five published steps, and where each one lives:
 *
 *   1. "Create document XML or JSON (no signature element yet) for a single
 *      document"                                    -> `toWireInvoice`
 *   2. "Create canonical version of the XML or JSON as per algorithm described"
 *                                                   -> `canonicalSerialize`
 *   3. "Apply sha256 hash on the byte array created from canonical version byte
 *      array (using UTF-8)"                         -> `invoiceDigest`
 *   4. "Sign the hash created using CADES-BES signature"
 *                                                   -> `signInvoice` (here)
 *   5. "Include Base64 encoded CADES-BES signature into original document XML or
 *      document JSON in a new element"              -> `attachSignatures`
 *
 * ===========================================================================
 * THE CONTAINER IS MIRRORED FIELD-FOR-FIELD FROM ETA'S OWN PARSED DUMP.
 * ===========================================================================
 *
 * `/files/parsed-cades-bes.txt` is the ASN.1 decode of the `value` in ETA's
 * signed sample invoice. Every structural choice below is read off it rather
 * than off a generic CMS recipe, because two of them are NOT what a generic
 * recipe produces (marked *):
 *
 *   ContentInfo
 *     contentType  1.2.840.113549.1.7.2  signedData
 *     content [0]
 *       SignedData
 *         version            INTEGER 3
 *         digestAlgorithms   SET { SEQUENCE { 2.16.840.1.101.3.4.2.1 sha-256 } }
 *                            * one element, and NO NULL parameters field
 *         encapContentInfo   SEQUENCE { 1.2.840.113549.1.7.5 digestedData }
 *                            * DETACHED — the SEQUENCE has ONE element, so there
 *                              is no eContent; and the type is digestedData, NOT
 *                              the customary id-data (1.2.840.113549.1.7.1). A
 *                              CMS builder that defaults to id-data emits a
 *                              container ETA did not publish.
 *         certificates [0]   { the signer's X.509 certificate }
 *         signerInfos        SET { SignerInfo }
 *           version          INTEGER 1
 *           sid              issuerAndSerialNumber { issuer DN, serialNumber }
 *                            (not subjectKeyIdentifier — hence version 1)
 *           digestAlgorithm  SEQUENCE { sha-256 }   * again no NULL params
 *           signedAttrs [0]  FOUR attributes, in this order:
 *             1.2.840.113549.1.9.3     contentType        = digestedData OID
 *             1.2.840.113549.1.9.5     signingTime        = UTCTime
 *             1.2.840.113549.1.9.4     messageDigest      = the step-3 hash
 *             1.2.840.113549.1.9.16.2.47 signingCertificateV2
 *           signatureAlgorithm SEQUENCE { 1.2.840.113549.1.1.1 rsaEncryption }
 *                            * rsaEncryption, NOT sha256WithRSAEncryption, and
 *                              with no NULL parameters. (The certificate's own
 *                              signature field in the same dump DOES use
 *                              sha256WithRSAEncryption WITH a NULL — so the
 *                              difference is deliberate on ETA's part, not an
 *                              artefact of the dump.)
 *           signature        OCTET STRING (256 byte for a 2048-bit key)
 *
 * SigningCertificateV2, read off the dump's own nesting:
 *
 *   SEQUENCE {                       -- SigningCertificateV2
 *     SEQUENCE {                     -- certs SEQUENCE OF ESSCertIDv2
 *       SEQUENCE {                   -- ESSCertIDv2, TWO elements
 *         OCTET STRING (32 byte)     -- certHash = SHA-256 of the DER cert
 *         SEQUENCE {                 -- issuerSerial
 *           SEQUENCE { [0] { issuer DN } }   -- GeneralNames, and see VERIFY-11
 *           INTEGER                  -- the certificate's serialNumber
 *   } } } }
 *
 * VERIFY-11 — THE ONE PLACE THIS MODULE DELIBERATELY DIVERGES FROM THE SAMPLE.
 * ETA wraps that issuer DN in tag `[0]`; this module emits `[4]`, RFC 5280's
 * `directoryName`. Both were measured off real bytes, not inferred. The full
 * reasoning, and the one-line flip if preprod disagrees, are at the call site in
 * `signingCertificateV2`; the divergence is tracked in the findings addendum's
 * §5 ledger and the round-1 plan's Blocked section.
 *
 * NOTE the ESSCertIDv2 has TWO elements, not three: its `hashAlgorithm` field
 * is absent, taking RFC 5035's DEFAULT of sha256. Emitting an explicit
 * AlgorithmIdentifier there would be legal ASN.1 and a DIFFERENT encoding from
 * the one ETA published, so it is omitted. The `policies` field of
 * SigningCertificateV2 is likewise absent (Optional).
 *
 * The one thing the dump cannot settle: the `issuer` inside `issuerSerial` is
 * printed as the CA's DN ("Egypt Trust Corporate CA G2"), which is the
 * certificate's ISSUER rather than its subject — consistent with RFC 5035, and
 * implemented that way. For a self-issued test certificate the two coincide, so
 * the test suite cannot distinguish them; a real ITIDA-issued seal can.
 *
 * ===========================================================================
 * REGISTRATION-GATED. THE TEST SIGNATURE PROVES STRUCTURE, NEVER COMPLIANCE.
 * ===========================================================================
 *
 * A signature ETA will accept must be made with "one of the approved eSeal or
 * natural person signature certificates in Egypt" — issued to the taxpayer by
 * an ITIDA-licensed CA (Egypt Trust, in ETA's own sample) and held on hardware
 * ServeOS never sees. `TestCertSigner` produces a self-issued certificate and a
 * structurally complete container; that container is CORRECTLY SHAPED and
 * COMPLETELY NON-COMPLIANT, and nothing in this module or its tests claims
 * otherwise. The tests verify the signature against the certificate that made
 * it — self-verification, which proves the bytes are internally consistent and
 * proves nothing at all about ETA accepting them.
 *
 * VALIDATION AGAINST PREPROD IS STILL OPEN. No document signed by this code has
 * been put in front of ETA, because doing so needs a registered taxpayer
 * profile. Until it has, the fallback below is what actually ships.
 *
 * AND THE FALLBACK IS ITSELF UNVERIFIED. With no signer configured, invoices go
 * out as `documentTypeVersion` "0.9", which ETA documents as "maintained as
 * v1.0, the only difference is that signature validation is disabled on this
 * version". That sentence is the entire published guidance; whether v0.9 is
 * still accepted in production is not stated anywhere in the SDK and is one
 * preprod submission away from being settled.
 */

// --- OIDs, every one of them read off ETA's parsed container ---------------

/** `1.2.840.113549.1.7.2 signedData (PKCS #7)` — the ContentInfo wrapper. */
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
/** `1.2.840.113549.1.7.5 digestedData (PKCS #7)` — ETA's `eContentType` AND the
 *  value of the `contentType` signed attribute. Deliberately not id-data. */
const OID_DIGESTED_DATA = "1.2.840.113549.1.7.5";
/** `2.16.840.1.101.3.4.2.1 sha-256 (NIST Algorithm)`. */
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
/** `1.2.840.113549.1.1.1 rsaEncryption (PKCS #1)` — the SignerInfo's
 *  `signatureAlgorithm`, exactly as the dump has it. */
const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const OID_ATTR_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_ATTR_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_ATTR_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_ATTR_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";

/**
 * The DER prefix of `DigestInfo { sha-256, OCTET STRING (32) }`, which RSASSA-
 * PKCS1-v1_5 wraps a SHA-256 digest in before the modular exponentiation:
 *
 *   30 31             SEQUENCE, 49 bytes
 *     30 0d           SEQUENCE, 13 bytes
 *       06 09 60 86 48 01 65 03 04 02 01   OID 2.16.840.1.101.3.4.2.1 sha-256
 *       05 00                              NULL
 *     04 20           OCTET STRING, 32 bytes  <- the digest follows
 *
 * Spelled out here because a signer is handed a DIGEST, not a message, and this
 * is the difference between "an RSA operation on 32 bytes" and "a signature a
 * verifier will accept as sha256WithRSAEncryption".
 */
const SHA256_DIGEST_INFO_PREFIX = Buffer.from("3031300d060960864801650304020105000420", "hex");

/**
 * pkijs 3.x needs an explicit crypto engine under Node. Registered once, at
 * module load, against Node's own WebCrypto — no polyfill, no extra dependency.
 */
let engineReady = false;
function ensureEngine(): void {
  if (engineReady) return;
  pkijs.setEngine("serveos-node", new pkijs.CryptoEngine({ name: "serveos-node", crypto: webcrypto as Crypto }));
  engineReady = true;
}

/**
 * A source of digital signatures for one taxpayer's documents.
 *
 * DELIBERATELY NARROW, and drawn at the DIGEST rather than at the document or
 * the container: the signer is handed 32 bytes and returns signature bytes. It
 * never sees the invoice, never learns ETA's container format, and never
 * touches a wire shape — which is exactly the surface a real ITIDA e-seal
 * exposes. A PKCS#11 USB token or an HSM performs precisely this operation
 * inside the device, and the private key never leaves it, so `CadesBesSigner`
 * below can build ETA's container around a key it can never read.
 *
 * THE CONTRACT OF `sign`, stated exactly because "sign a digest" is ambiguous:
 * given a 32-byte SHA-256 digest, return the RSASSA-PKCS1-v1_5 signature whose
 * message digest is that value — i.e. the RSA private-key operation over
 * `DigestInfo(sha-256, digest)`. A verifier must be able to check the result
 * with a plain `verify("sha256", message, key, signature)`. This is PKCS#11's
 * `CKM_RSA_PKCS` over a DigestInfo, which is what a token's "sign hash"
 * operation means.
 */
export interface InvoiceSigner {
  /** RSASSA-PKCS1-v1_5 over `DigestInfo(sha-256, digest)`. See above. */
  sign(digest: Buffer): Promise<Buffer>;
  /** The signer's X.509 certificate, DER-encoded. It goes into the container's
   *  `certificates` set and is hashed into the `signingCertificateV2` signed
   *  attribute. */
  certificate(): Buffer;
}

/**
 * Steps 2 and 3 of ETA's signature-creation process, on an UNSIGNED document.
 *
 *   "Create canonical version of the XML or JSON as per algorithm described"
 *   "Apply sha256 hash on the byte array created from canonical version byte
 *    array (using UTF-8)"
 *
 * The canonicalization is `./serialize`'s `canonicalSerialize`, already proven
 * byte-for-byte against ETA's own published worked example — the same function
 * and the same golden vector the e-receipt uuid is derived from. UTF-8 is stated
 * by ETA and is explicit here rather than left to a default.
 *
 * PASS THE DOCUMENT WITHOUT ITS `signatures` ELEMENT (step 1 says so in as many
 * words: "no signature element yet"). `toWireInvoice` produces exactly that
 * form, and `attachSignatures` adds the element afterwards.
 */
export function invoiceDigest(unsignedWire: Record<string, unknown>): Buffer {
  return createHash("sha256").update(canonicalSerialize(unsignedWire), "utf8").digest();
}

/**
 * Step 4: the CAdES-BES container for one document digest.
 *
 * Returns the `signatures[]` entry invoice v1.0 expects — `signatureType` "I"
 * (Issuer) and a Base64 `value` "that contains CADES-BES structure containing
 * signer certificate, hash value signed and actual signature value". The
 * Service-Provider ("S") signature is Optional and ServeOS is not one.
 *
 * `signingTime` is a parameter rather than `new Date()` so that a caller can
 * make the container reproducible; production passes nothing and gets the real
 * clock. It is the only non-deterministic input — the same document signed twice
 * at the same instant with the same key produces identical bytes.
 */
export async function signInvoice(
  digest: Buffer,
  signer: InvoiceSigner,
  opts: { signingTime?: Date } = {},
): Promise<InvoiceSignature> {
  ensureEngine();

  if (digest.length !== 32) {
    throw new EtaConfigError(
      "invoice-signing-unavailable",
      `fiscal: CAdES-BES signing was handed a ${digest.length}-byte digest; ETA's process specifies SHA-256, so it must be 32.`,
    );
  }

  const certificateDer = signer.certificate();
  const certificate = pkijs.Certificate.fromBER(bytesOf(certificateDer));

  const signedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 0, // [0] IMPLICIT — signedAttrs
    attributes: [
      // The contentType attribute MUST echo `encapContentInfo.eContentType`,
      // and ETA's is digestedData rather than id-data.
      new pkijs.Attribute({ type: OID_ATTR_CONTENT_TYPE, values: [new asn1js.ObjectIdentifier({ value: OID_DIGESTED_DATA })] }),
      new pkijs.Attribute({ type: OID_ATTR_SIGNING_TIME, values: [new asn1js.UTCTime({ valueDate: opts.signingTime ?? new Date() })] }),
      // THE DOCUMENT'S OWN DIGEST — the step-3 hash of the canonical form. This
      // is what makes the container a signature OVER the invoice rather than
      // over nothing: the content is detached, so this attribute is the only
      // binding between the signature and the document.
      new pkijs.Attribute({ type: OID_ATTR_MESSAGE_DIGEST, values: [new asn1js.OctetString({ valueHex: bytesOf(digest) })] }),
      new pkijs.Attribute({ type: OID_ATTR_SIGNING_CERTIFICATE_V2, values: [signingCertificateV2(certificate, certificateDer)] }),
    ],
  });

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: certificate.issuer, serialNumber: certificate.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_RSA_ENCRYPTION }),
    signedAttrs,
  });

  const signedData = new pkijs.SignedData({
    version: 3,
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 })],
    // DETACHED: an `EncapsulatedContentInfo` with a type and no `eContent`.
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID_DIGESTED_DATA }),
    certificates: [certificate],
    signerInfos: [signerInfo],
  });

  // The signature covers the DER of the signed attributes as a SET OF, which is
  // NOT how they are transmitted (they go out under an implicit [0] tag). See
  // `signedAttrsDer`.
  const attrsDer = signedAttrsDer(signedAttrs);
  signerInfo.signature = new asn1js.OctetString({
    valueHex: bytesOf(await signer.sign(createHash("sha256").update(attrsDer).digest())),
  });

  const contentInfo = new pkijs.ContentInfo({ contentType: OID_SIGNED_DATA, content: signedData.toSchema(true) });
  return { signatureType: "I", value: Buffer.from(contentInfo.toSchema().toBER(false)).toString("base64") };
}

/**
 * The bytes a CMS signature is actually computed over: `DER(SET OF Attribute)`.
 *
 * RFC 5652 §5.4 — the signed attributes travel inside the SignerInfo under an
 * IMPLICIT `[0]` tag, but "the IMPLICIT [0] tag is not used for the DER encoding,
 * rather an EXPLICIT SET OF tag is used". So the encoding is taken and its first
 * byte is retagged from `0xa0` (context-specific constructed 0) to `0x31`
 * (universal SET). That single-byte swap is pkijs's own documented approach in
 * `SignedData.sign`, reproduced here because this module signs through an
 * external `InvoiceSigner` rather than handing pkijs a private key it can use.
 *
 * Getting this wrong produces a container that parses perfectly and whose
 * signature verifies against nothing — which is exactly the failure the
 * round-trip test exists to catch.
 */
function signedAttrsDer(signedAttrs: pkijs.SignedAndUnsignedAttributes): Buffer {
  // `toSchema()` emits the transmitted form, whose first byte is `0xa0` — the
  // implicit `[0]`. The retag below is what turns it into the SET the signature
  // is computed over; the round-trip test asserts both bytes explicitly so this
  // cannot regress silently.
  const encoded = new Uint8Array(signedAttrs.toSchema().toBER(false));
  encoded[0] = 0x31;
  return Buffer.from(encoded);
}

/**
 * The `signingCertificateV2` attribute value — the attribute that makes this
 * container CAdES-BES rather than plain CMS, by binding the signature to one
 * specific certificate rather than merely to a public key.
 *
 * Structure mirrored from ETA's dump; see the module header for the nesting and
 * for why `hashAlgorithm` is omitted (RFC 5035 DEFAULT sha256) and why the
 * issuer is the certificate's ISSUER.
 *
 * TO CHECK THIS AGAINST ETA'S SAMPLE, RE-RUN THE TEST RATHER THAN RE-DERIVING
 * IT BY HAND. `sign-invoice.test.ts` -> "signInvoice — the CAdES-BES container,
 * parsed back from its own output" re-PARSES our own Base64 with pkijs and
 * asserts every field independently of how it was built: element counts, the
 * four attribute OIDs in order, `certHash` against the embedded certificate,
 * and — for the one deliberate divergence — the issuerSerial GeneralName tag
 * byte ("emits the issuerSerial DN under RFC 5280's [4] directoryName"). Point
 * the same parse at `/files/one-doc-I.json`'s `signatures[0].value` to compare
 * ETA's container field-for-field; that is exactly how the `[0]` vs `[4]`
 * divergence (VERIFY-11) was measured rather than inferred.
 */
function signingCertificateV2(certificate: pkijs.Certificate, certificateDer: Buffer): asn1js.Sequence {
  const essCertIDv2 = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: bytesOf(createHash("sha256").update(certificateDer).digest()) }),
      new pkijs.IssuerSerial({
        // ===================================================================
        // VERIFY-11 — A DELIBERATE DIVERGENCE FROM ETA'S SAMPLE. ONE LINE.
        // ===================================================================
        // `type: 4` is RFC 5280's `directoryName` CHOICE alternative, so this
        // emits the DN under tag `[4]` (first byte 0xa4).
        //
        // ETA'S PUBLISHED SIGNED SAMPLE DOES NOT. Decoding the `signatures[0]
        // .value` of /files/one-doc-I.json shows the same DN under tag `[0]`
        // (first byte 0xa0) — measured, not inferred. `[0]` is the `otherName`
        // alternative, whose contents are `SEQUENCE { type-id OID, [0] ANY }`;
        // what ETA actually put inside it is an RDNSequence, so their encoder
        // emitted a directoryName under the wrong tag number. Their container
        // is therefore self-consistent but not RFC-5280-conformant here.
        //
        // WE KEEP THE RFC-CORRECT [4], for two reasons. Signature validation is
        // not deployed, so nothing on ETA's side judges this today; and copying
        // a known-wrong tag to match a sample would be guessing that their
        // VALIDATOR shares their ENCODER's bug — which the sample cannot tell
        // us, because it was produced by the encoder.
        //
        // IF PREPROD REJECTS A SIGNED v1.0 DOCUMENT, THIS IS THE FIRST THING TO
        // TRY: change `4` to `0` here and nothing else. `sign-invoice.test.ts`
        // pins the emitted tag as 0xa4 so the flip can only ever be deliberate.
        // Tracked as VERIFY-11 in the findings addendum's §5 ledger and in the
        // round-1 plan's "Blocked — VERIFY with ETA" section; test BOTH forms
        // against preprod before any tenant configures a real seal.
        issuer: new pkijs.GeneralNames({ names: [new pkijs.GeneralName({ type: 4, value: certificate.issuer })] }),
        serialNumber: certificate.serialNumber,
      }).toSchema(),
    ],
  });
  // SigningCertificateV2 { certs SEQUENCE OF ESSCertIDv2 } — `policies` omitted.
  return new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIDv2] })] });
}

/** asn1js wants a plain `ArrayBuffer`, and a Node `Buffer` is a view into a
 *  possibly larger pool — so slice to this buffer's own bytes rather than
 *  handing over the whole pool. */
function bytesOf(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/**
 * An `InvoiceSigner` backed by a private key this process can read.
 *
 * THE SHAPE OF `eta_tenant_config.signing_key_ref`'s RESOLVED VALUE is a ServeOS
 * decision, not an ETA one — the SDK says nothing about how a taxpayer stores
 * its seal, because ETA's model assumes hardware. What is accepted here is a
 * single PEM blob containing BOTH a `PRIVATE KEY` block (PKCS#8) and a
 * `CERTIFICATE` block, in either order: that is the only self-contained form
 * that carries everything the container needs, and it round-trips through an
 * environment variable without extra encoding.
 *
 * IT IS NOT THE GO-LIVE PATH, and the JSDoc says so where the reader will be:
 * a real ITIDA e-seal lives on a USB token or an HSM and its private key is
 * NON-EXPORTABLE, so there is no PEM to put in a secret manager. That deployment
 * needs a different `InvoiceSigner` implementation — a PKCS#11 or remote-signing
 * one — behind this same interface, which is exactly why the interface is drawn
 * at the digest. This class covers the soft-certificate case (and preprod
 * testing) honestly rather than pretending the hardware case is solved.
 */
export class PemBundleSigner implements InvoiceSigner {
  readonly #privateKey: KeyObject;
  readonly #certificateDer: Buffer;

  private constructor(privateKey: KeyObject, certificateDer: Buffer) {
    this.#privateKey = privateKey;
    this.#certificateDer = certificateDer;
  }

  /**
   * Parses a PEM bundle, or throws the same named, permanent error the
   * unconfigured path uses.
   *
   * FAILING CLOSED IS THE POINT: material that cannot be parsed must never
   * silently downgrade the document to unsigned v0.9. The tenant configured a
   * seal; if it is unusable they need to be told, not quietly filed under a
   * different document version.
   */
  static fromPem(pem: string): PemBundleSigner {
    const certificate = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem)?.[0];
    if (!certificate || !/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(pem)) {
      throw new EtaConfigError(
        "invoice-signing-unavailable",
        "fiscal: eta_tenant_config.signing_key_ref resolved to material that is not a usable e-seal. " +
          "A PEM bundle containing BOTH a PRIVATE KEY block and a CERTIFICATE block is expected. " +
          "A hardware e-seal (ITIDA USB token / HSM) exports no private key and needs a PKCS#11 signer instead — " +
          "see PemBundleSigner in sign-invoice.ts.",
      );
    }

    try {
      return new PemBundleSigner(createPrivateKey(pem), derOfPemCertificate(certificate));
    } catch (cause) {
      throw new EtaConfigError(
        "invoice-signing-unavailable",
        "fiscal: eta_tenant_config.signing_key_ref resolved to a PEM bundle whose private key could not be read. " +
          `The certificate and key must be a matching pair. (${cause instanceof Error ? cause.name : "parse failure"})`,
      );
    }
  }

  /** RSASSA-PKCS1-v1_5 over `DigestInfo(sha-256, digest)` — see `InvoiceSigner`.
   *
   *  `privateEncrypt` with `RSA_PKCS1_PADDING`, not `sign("sha256", ...)`,
   *  because the message itself is long gone by this point: only its digest is
   *  in hand, which is the whole shape of a token's signing surface. Wrapping
   *  the digest in its DigestInfo and performing the raw private-key operation
   *  produces a signature byte-identical to `sign("sha256", message, key)`,
   *  which the round-trip test asserts directly. */
  async sign(digest: Buffer): Promise<Buffer> {
    return privateEncrypt(
      { key: this.#privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.concat([SHA256_DIGEST_INFO_PREFIX, digest]),
    );
  }

  certificate(): Buffer {
    return this.#certificateDer;
  }
}

/**
 * A self-issued signer for TESTS ONLY.
 *
 * REGISTRATION-GATED, AND THIS IS THE SENTENCE THAT MATTERS: the certificate
 * below is issued by nobody. ETA accepts "one of the approved eSeal or natural
 * person signature certificates in Egypt", issued by an ITIDA-licensed CA to the
 * taxpayer; this is a key pair generated in memory that vouches for itself. It
 * exists to prove the CONTAINER'S STRUCTURE — that the DER we assemble parses,
 * carries the four signed attributes, binds the right certificate hash, and
 * verifies against its own key — and it proves NOTHING about compliance,
 * validity, or whether ETA will accept a document signed this way.
 *
 * NEVER CONSTRUCT ONE OUTSIDE A TEST. `resolveInvoiceSigner` cannot reach it
 * today: the only route to a signer is a tenant's configured `signing_key_ref`,
 * which is parsed by `PemBundleSigner` and never by this class. Nothing
 * constructs a `TestCertSigner` outside `*.test.ts`.
 *
 * THAT UNREACHABILITY IS NOW ASSERTED, NOT MERELY CONVENTIONAL. It is the one
 * property in this module worth a guardrail — a self-issued seal reaching a
 * production document would attach a meaningless signature to a legal record and
 * look, from every surface ServeOS has, exactly like a correctly signed one. The
 * `TestCertSigner is unreachable from production code` describe in
 * `./sign-invoice.test.ts` is the assertion: a static scan in
 * `src/server/audit/coverage.ts`'s style over every `.ts`/`.tsx` under
 * `src/server` and `src/app` except `*.test.*` and this file, failing on any
 * mention of the identifier. Round 2 Task 4 landed it with the B2B invoice
 * trigger, which is the config-write surface the carry-forward marker named.
 *
 * The profile is minimal on purpose — version 3, a serial, matching issuer and
 * subject DNs, a validity window, the public key — because everything ETA's
 * container touches is exactly that: the DER for hashing, the issuer DN and
 * serial for `issuerAndSerialNumber` and `issuerSerial`, and the public key for
 * verification. Extensions would be decoration on a certificate no one trusts.
 */
export class TestCertSigner implements InvoiceSigner {
  readonly #privateKey: KeyObject;
  readonly #certificateDer: Buffer;
  /** The matching public key, so a test can verify without re-deriving it. */
  readonly publicKey: KeyObject;

  private constructor(privateKey: KeyObject, publicKey: KeyObject, certificateDer: Buffer) {
    this.#privateKey = privateKey;
    this.publicKey = publicKey;
    this.#certificateDer = certificateDer;
  }

  /** Async because generating a key pair and self-signing a certificate both
   *  go through WebCrypto. */
  static async create(opts: { commonName?: string; serialNumber?: number } = {}): Promise<TestCertSigner> {
    ensureEngine();

    const keys = await webcrypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );

    const certificate = new pkijs.Certificate();
    certificate.version = 2; // v3, zero-indexed
    certificate.serialNumber = new asn1js.Integer({ value: opts.serialNumber ?? 20260831 });
    for (const name of [certificate.issuer, certificate.subject]) {
      name.typesAndValues.push(new pkijs.AttributeTypeAndValue({
        type: "2.5.4.6", value: new asn1js.PrintableString({ value: "EG" }),
      }));
      name.typesAndValues.push(new pkijs.AttributeTypeAndValue({
        type: "2.5.4.3", value: new asn1js.Utf8String({ value: opts.commonName ?? "ServeOS Test Seal (NOT AN ITIDA CERTIFICATE)" }),
      }));
    }
    certificate.notBefore.value = new Date("2026-01-01T00:00:00Z");
    certificate.notAfter.value = new Date("2036-01-01T00:00:00Z");
    await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
    await certificate.sign(keys.privateKey, "SHA-256");

    const toKeyObject = async (key: CryptoKey, format: "pkcs8" | "spki") =>
      format === "pkcs8"
        ? createPrivateKey({ key: Buffer.from(await webcrypto.subtle.exportKey("pkcs8", key)), format: "der", type: "pkcs8" })
        : createPublicKey({ key: Buffer.from(await webcrypto.subtle.exportKey("spki", key)), format: "der", type: "spki" });

    return new TestCertSigner(
      await toKeyObject(keys.privateKey, "pkcs8"),
      await toKeyObject(keys.publicKey, "spki"),
      Buffer.from(certificate.toSchema(true).toBER(false)),
    );
  }

  async sign(digest: Buffer): Promise<Buffer> {
    return privateEncrypt(
      { key: this.#privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.concat([SHA256_DIGEST_INFO_PREFIX, digest]),
    );
  }

  certificate(): Buffer {
    return this.#certificateDer;
  }

  /**
   * This signer's key and certificate as the PEM bundle `PemBundleSigner`
   * consumes — i.e. a value that can be put in a `signing_key_ref` env var.
   *
   * TEST-ONLY, like the rest of this class, and it exists so an integration test
   * can drive the REAL config seam (`resolveInvoiceSigner` -> `PemBundleSigner`)
   * rather than injecting a signer past it. Exporting a private key is
   * acceptable precisely because this key is worthless: it was generated in
   * memory for one test and its certificate vouches for nobody.
   */
  pemBundle(): string {
    const body = this.#certificateDer.toString("base64").replace(/(.{64})/g, "$1\n");
    return `${this.#privateKey.export({ type: "pkcs8", format: "pem" }) as string}` +
      `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
  }
}

/**
 * THE CONFIG SEAM: the signer configured for this tenant, or `null`.
 *
 * `signingKey()` is the lazy thunk on `EtaConfig` (`signingKeyThunk` in
 * `./config`) — it resolves `eta_tenant_config.signing_key_ref` through the
 * secret manager and returns null when the tenant has no signing material at
 * all, or THROWS `EtaConfigError` when a ref is set but unresolvable. That throw
 * is deliberately not caught: a tenant who configured a seal and whose ref has
 * gone stale must be told, not silently downgraded to an unsigned v0.9 document
 * they did not ask for.
 *
 * NULL SELECTS v0.9. That is the state of every tenant today, and it is the
 * normal case rather than a degraded one — no ServeOS tenant has an ITIDA e-seal
 * yet, because obtaining one is part of the registration this whole subsystem is
 * gated behind.
 *
 * NON-NULL BUILDS A REAL SIGNER, through `PemBundleSigner`, which either
 * succeeds or throws the same named permanent error. There is no third
 * behaviour: material that is present but unusable never falls through to
 * unsigned.
 *
 * Takes only what it reads. `Pick<EtaConfig, "signingKey">` rather than the
 * whole config, so `./finalize` can call it without assembling a device
 * credential and an ERP secret it has no business resolving.
 */
export function resolveInvoiceSigner(cfg: Pick<EtaConfig, "signingKey">): InvoiceSigner | null {
  const material = cfg.signingKey();
  return material === null ? null : PemBundleSigner.fromPem(material);
}

/** A PEM `CERTIFICATE` block as DER. */
function derOfPemCertificate(pem: string): Buffer {
  const body = pem
    .replace("-----BEGIN CERTIFICATE-----", "")
    .replace("-----END CERTIFICATE-----", "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

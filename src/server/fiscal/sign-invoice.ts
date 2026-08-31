import { createHash } from "node:crypto";
import { canonicalSerialize } from "./serialize";
import { EtaConfigError } from "./eta-transport-errors";
import type { EtaConfig } from "./provider";
import type { InvoiceSignature } from "./eta-invoice-wire";

/**
 * THE B2B E-SEAL SEAM — and an honest statement of where it stops.
 *
 *   Signature creation https://sdk.invoicing.eta.gov.eg/signature-creation/
 *   Parsed reference   https://sdk.invoicing.eta.gov.eg/files/parsed-cades-bes.txt
 *   Signed sample      https://sdk.invoicing.eta.gov.eg/files/one-doc-I.json
 *   Invoice v1.0       https://sdk.invoicing.eta.gov.eg/documents/invoice-v1-0/
 *
 * ===========================================================================
 * STATUS: THE CMS CONTAINER IS **BLOCKED**. READ THIS BEFORE ADDING CODE HERE.
 * ===========================================================================
 *
 * Steps 1-3 of ETA's five-step process are implemented and tested below
 * (`invoiceDigest`). Steps 4-5 are not, and cannot be, with `node:crypto`
 * alone. This is a capability gap in the runtime, not an unfinished thought,
 * and it was verified rather than assumed:
 *
 *   THE PROCESS (verbatim, all five steps):
 *     1. "Create document XML or JSON (no signature element yet) for a single
 *        document"
 *     2. "Create canonical version of the XML or JSON as per algorithm
 *        described"
 *     3. "Apply sha256 hash on the byte array created from canonical version
 *        byte array (using UTF-8)"
 *     4. "Sign the hash created using CADES-BES signature"
 *     5. "Include Base64 encoded CADES-BES signature into original document XML
 *        or document JSON in a new element"
 *
 *   WHAT STEP 4 ACTUALLY REQUIRES. ETA publishes the exact container as a
 *   parsed ASN.1 dump (`files/parsed-cades-bes.txt`, the decode of the `value`
 *   in `files/one-doc-I.json`). It is a DER-encoded PKCS#7/CMS `SignedData`:
 *
 *     ContentInfo { contentType = 1.2.840.113549.1.7.2 signedData
 *       SignedData {
 *         version = 3
 *         digestAlgorithms = { 2.16.840.1.101.3.4.2.1 sha-256 }
 *         encapContentInfo { eContentType = 1.2.840.113549.1.7.5 digestedData }
 *           -- DETACHED: no eContent. Note the unusual eContentType, which is
 *           -- digestedData rather than the customary id-data; it is echoed in
 *           -- the contentType signed attribute, so a generic CMS builder that
 *           -- hard-codes id-data produces a container ETA did not publish.
 *         certificates = { the signer's X.509 cert }
 *         signerInfos = { SignerInfo {
 *           version = 1
 *           sid = issuerAndSerialNumber { issuer DN, serial }
 *           digestAlgorithm = sha-256
 *           signedAttrs [0] IMPLICIT = {
 *             1.2.840.113549.1.9.3  contentType        = digestedData OID
 *             1.2.840.113549.1.9.5  signingTime        = UTCTime
 *             1.2.840.113549.1.9.4  messageDigest      = the step-3 SHA-256
 *             1.2.840.113549.1.9.16.2.47 signingCertificateV2 =
 *                 ESSCertIDv2 { certHash (SHA-256 of the DER cert),
 *                               issuerSerial { GeneralNames[directoryName],
 *                                              serialNumber } }
 *           }
 *           signatureAlgorithm = 1.2.840.113549.1.1.1 rsaEncryption
 *           signature = RSA over DER(SET OF signedAttrs)
 *         } }
 *       }
 *     }
 *
 *   THE EXACT GAP, in two parts, both hard:
 *
 *     (a) NO ASN.1/DER ENCODER. `node:crypto` exposes `sign`/`createSign`
 *         (raw signature bytes over a buffer) and `X509Certificate` (a PARSER —
 *         it has no static constructor, no builder, no `create`). There is no
 *         DER writer of any kind in the standard library, so every SEQUENCE,
 *         SET, OBJECT IDENTIFIER, UTCTime and context-tag above would have to be
 *         emitted byte by byte by hand. That is writing an ASN.1 encoder, which
 *         this task was explicitly instructed not to do silently — and doing it
 *         quietly for a cryptographic container whose correctness cannot be
 *         checked without a counterparty is exactly the kind of code that looks
 *         finished and is not.
 *
 *     (b) NO X.509 CERTIFICATE GENERATION, which blocks the TEST signer even if
 *         (a) were solved. `crypto.generateKeyPairSync` produces keys, never a
 *         certificate; `X509Certificate` cannot be constructed from parts. So a
 *         self-issued test certificate — the `certificate()` half of the signer
 *         interface, and the thing that goes in `certificates` and in
 *         `signingCertificateV2` — is not obtainable either.
 *
 *   SMALLEST CANDIDATE DEPENDENCY, recorded for the decision and NOT taken:
 *   `pkijs` (with its peers `asn1js` + `pvutils`) is the only single addition
 *   that closes both halves — it builds `SignedData` with arbitrary signed
 *   attributes AND creates self-signed certificates, and it is pure JS with no
 *   native build. The alternative is a set: `@peculiar/asn1-schema` +
 *   `@peculiar/asn1-cms` + `@peculiar/asn1-x509` for (a) and `@peculiar/x509`
 *   for (b). `node-forge` is NOT sufficient on its own: its `pkcs7` builder
 *   supports contentType/messageDigest/signingTime authenticated attributes but
 *   has no `signingCertificateV2`, which is the attribute that makes a container
 *   CAdES-BES rather than plain CMS. Adding any of these is a dependency
 *   decision for a human, so none was added.
 *
 * WHAT SHIPS INSTEAD, and why it is not a stub with no purpose:
 *
 *   - `InvoiceSigner` is the real interface, and it is the one a hardware e-seal
 *     satisfies unchanged: an ITIDA USB token or HSM exposes exactly "sign these
 *     bytes" plus "here is my certificate", which is why the seam is drawn at
 *     the digest and not at the container.
 *   - `invoiceDigest` implements steps 2-3 exactly and is tested against the
 *     serializer's own golden vector.
 *   - `resolveInvoiceSigner` is the config seam the transport calls. It returns
 *     `null` today for every tenant, which is what routes every B2B submission
 *     down the v0.9 (signature-validation-disabled) path.
 *   - `signInvoice` refuses loudly with a named, permanent `EtaConfigError`
 *     rather than emitting something shaped like a signature. A fabricated
 *     container would be the single worst outcome available here: it would pass
 *     our own tests, fail ETA's validation for reasons no log line would
 *     explain, and — if it ever did pass — attach a meaningless seal to a legal
 *     document.
 *
 * REGISTRATION-GATED, TWICE OVER. Even with the container implemented, nothing
 * here would be compliant: an ETA-accepted signature must be made with "one of
 * the approved eSeal or natural person signature certificates in Egypt", issued
 * to the taxpayer by an ITIDA-licensed CA (Egypt Trust in ETA's own sample) and
 * held on a token ServeOS never sees. A self-issued test certificate proves
 * STRUCTURE and nothing else — never compliance, never validity — and any
 * `TestCertSigner` added later must carry that sentence in its own JSDoc.
 *
 * AND THE FALLBACK IS ITSELF UNVERIFIED. v0.9 is documented as "maintained as
 * v1.0, the only difference is that signature validation is disabled on this
 * version", which is the entire published guidance on it. Whether ETA still
 * ACCEPTS v0.9 in production is not stated anywhere in the SDK and cannot be
 * settled by reading — it is a preprod submission away, and it is an open
 * VERIFY item in the findings addendum, not an assumption this module makes.
 */

/**
 * A source of digital signatures for one taxpayer's documents.
 *
 * DELIBERATELY NARROW: the signer is handed a DIGEST and returns SIGNATURE
 * BYTES. It never sees the document, never learns ETA's container format, and
 * never touches a wire shape — which is what lets a real ITIDA e-seal (a USB
 * token, an HSM, a remote signing service) satisfy it without any of them
 * knowing what an invoice is. It is also what keeps private key material out of
 * every other module in this directory: nothing here can leak a key it is never
 * given.
 */
export interface InvoiceSigner {
  /** RSA signature over `digest` — the step-3 SHA-256 of the canonical
   *  document. A real e-seal performs this inside the token. */
  sign(digest: Buffer): Promise<Buffer>;
  /** The signer's X.509 certificate, DER-encoded. It goes into the container's
   *  `certificates` set and into the `signingCertificateV2` signed attribute. */
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
 * byte-for-byte against ETA's own published worked example — which is the same
 * function, and the same golden vector, that the e-receipt uuid is derived
 * from. UTF-8 is stated by ETA and is explicit here rather than left to a
 * default.
 *
 * PASS THE DOCUMENT WITHOUT ITS `signatures` ELEMENT (step 1 says so in as many
 * words: "no signature element yet"). `toWireInvoice` produces exactly that
 * form, and `attachSignatures` is what adds the element afterwards.
 */
export function invoiceDigest(unsignedWire: Record<string, unknown>): Buffer {
  return createHash("sha256").update(canonicalSerialize(unsignedWire), "utf8").digest();
}

/**
 * Would produce the CAdES-BES `signatures` entry for a document. **BLOCKED** —
 * see the module header for the exact structural gap and the candidate
 * dependencies that would close it.
 *
 * It throws rather than returning null so that a caller which believes it has a
 * signer can never quietly ship an unsigned v1.0 document, which ETA would
 * reject with a validation error naming the signature rather than the cause.
 * `EtaConfigError` is the right family: the document is fine, the account's
 * signing capability is not, it is PERMANENT, and the worker already maps it to
 * an owner-actionable "finish ETA setup" alert without burning retries.
 *
 * The two parameters are present and typed because they are the real inputs and
 * the signature of this function will not change when the container lands.
 */
export async function signInvoice(digest: Buffer, signer: InvoiceSigner): Promise<InvoiceSignature> {
  void digest;
  void signer;
  throw new EtaConfigError(
    "invoice-signing-unavailable",
    "fiscal: CAdES-BES signing is not implemented — ETA requires a DER-encoded CMS SignedData container " +
      "(detached, eContentType digestedData, with contentType/signingTime/messageDigest/signingCertificateV2 signed " +
      "attributes) and node:crypto provides neither an ASN.1 encoder nor X.509 certificate generation. " +
      "Submit as documentTypeVersion 0.9, which ETA documents as v1.0 with signature validation disabled, " +
      "until a signing dependency is approved. See sign-invoice.ts for the exact gap.",
  );
}

/**
 * THE CONFIG SEAM: the signer configured for this tenant, or `null`.
 *
 * `cfg.signingKey()` is the lazy thunk on `EtaConfig` — it resolves
 * `eta_tenant_config.signing_key_ref` through the secret manager and returns
 * null when the tenant has no signing material at all (the normal case today),
 * or THROWS `EtaConfigError` when a ref is set but unresolvable. That throw is
 * deliberately not caught: a tenant who configured signing material and whose
 * ref has gone stale must be told, not silently downgraded to an unsigned v0.9
 * document they did not ask for.
 *
 * IT RETURNS NULL EVEN WHEN A KEY RESOLVES, and that is the honest state today
 * rather than a bug: `signInvoice` is BLOCKED, so there is no signer to build
 * around the key material. The `null` is what selects the v0.9 path in
 * `EtaFiscalProvider.submit`. When the container lands, this function is the ONE
 * place that changes — it constructs the signer from the resolved key — and both
 * the transport branch and its tests already exercise the signed path through an
 * injected signer.
 */
export function resolveInvoiceSigner(cfg: EtaConfig): InvoiceSigner | null {
  // Calling the thunk is the point: it surfaces a stale ref now, at the one
  // path that would need it, rather than at every receipt this tenant issues.
  cfg.signingKey();
  return null;
}

import { createPrivateKey, createPublicKey, privateEncrypt, webcrypto, constants, type KeyObject } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { ensureCryptoEngine, SHA256_DIGEST_INFO_PREFIX, type InvoiceSigner } from "../sign-invoice";

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
 * NEVER CONSTRUCT ONE OUTSIDE A TEST — and it no longer even LIVES in
 * production code: it moved out of `../sign-invoice` into this test-support
 * module, so no production module graph contains it. `resolveInvoiceSigner`
 * cannot reach it: the only route to a signer is a tenant's configured
 * `signing_key_ref`, parsed by `PemBundleSigner`.
 *
 * THAT UNREACHABILITY IS NOW ASSERTED, NOT MERELY CONVENTIONAL. It is the one
 * property in this module worth a guardrail — a self-issued seal reaching a
 * production document would attach a meaningless signature to a legal record and
 * look, from every surface ServeOS has, exactly like a correctly signed one. The
 * `TestCertSigner is unreachable from production code` describe in
 * `../sign-invoice.test.ts` is the assertion: a static scan in
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
    ensureCryptoEngine();

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

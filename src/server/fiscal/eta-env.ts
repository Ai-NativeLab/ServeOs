import type { EtaEnvironment } from "./schema";

/**
 * The three ETA base addresses one environment needs.
 *
 * `identityBase` and `apiBase` are deliberately separate: the SDK's Authenticate
 * POS page states "Authentication of the systems is done on identity service,
 * not on the service hosting actual integration APIs. Use the Identity Service
 * base address when creating the full URL to be called."
 */
export type EtaEnvUrls = {
  /** OAuth2 token issuer — `POST {identityBase}/connect/token`. */
  identityBase: string;
  /** Integration APIs — `POST {apiBase}/api/v1/receiptsubmissions` etc. */
  apiBase: string;
  /** `{eInvoicingPortalURL}` — the base a printed receipt's QR url points at
   *  (see `buildQrUrl`). Presentation, not credentials, which is why it lives
   *  here and not on `EtaConfig`. */
  portalBase: string;
};

/**
 * The ONE place ETA's environment URLs are written down.
 *
 * Every value below is verbatim from the SDK FAQ's "URL/Environment" table
 * (https://sdk.invoicing.eta.gov.eg/faq/, "How to set up environment to access
 * test APIs and test portals?"), which publishes:
 *
 *   | URL/Environment    | PreProd                                  | Prod                            |
 *   | Registration Portal| https://profile.preprod.eta.gov.eg       | https://profile.eta.gov.eg      |
 *   | Invoicing Portal   | https://preprod.invoicing.eta.gov.eg     | https://invoicing.eta.gov.eg    |
 *   | System API         | https://api.preprod.invoicing.eta.gov.eg | https://api.invoicing.eta.gov.eg|
 *   | Identity Service   | https://id.preprod.eta.gov.eg            | https://id.eta.gov.eg           |
 *
 * The Registration Portal row is deliberately not carried: nothing in the
 * submission path calls it, and an unused base address is one more thing to
 * get wrong.
 *
 * No trailing slashes — every call site joins with a leading-slash path.
 */
const ETA_ENVIRONMENTS: Readonly<Record<EtaEnvironment, EtaEnvUrls>> = Object.freeze({
  preprod: Object.freeze({
    identityBase: "https://id.preprod.eta.gov.eg",
    apiBase: "https://api.preprod.invoicing.eta.gov.eg",
    portalBase: "https://preprod.invoicing.eta.gov.eg",
  }),
  prod: Object.freeze({
    identityBase: "https://id.eta.gov.eg",
    apiBase: "https://api.invoicing.eta.gov.eg",
    portalBase: "https://invoicing.eta.gov.eg",
  }),
});

/** The identity/API/portal bases for `environment`. Total over the enum, so a
 *  new `eta_environment` value is a compile error here rather than a runtime
 *  `undefined.apiBase` at submit time. */
export function getEtaEnv(environment: EtaEnvironment): EtaEnvUrls {
  return ETA_ENVIRONMENTS[environment];
}

/**
 * The preprod TLS trust seam.
 *
 * ETA's FAQ: "Test environment of the solution (PreProd environments) depends
 * on internally issued certificates. Therefore to be able to properly use
 * either the Invoicing Portal or get to APIs that solution is exposing, first
 * you need to configure trust of Root Certificate of the test environment in
 * your own test and development environments (Note: do not install this
 * certificate in your production environment)." The PEM is published at
 * https://sdk.invoicing.eta.gov.eg/files/preprod-root-ca.crt
 *
 * FORBIDDEN, without exception: `NODE_TLS_REJECT_UNAUTHORIZED=0`, an agent or
 * dispatcher with `rejectUnauthorized: false`, or any other switch that turns
 * certificate verification off. This code path carries a taxpayer's fiscal
 * documents and its ETA bearer token; an unverified TLS peer is a
 * man-in-the-middle away from both. Trust the ETA root explicitly or do not
 * connect at all.
 *
 * MECHANISM SHIPPED — `NODE_EXTRA_CA_CERTS`. Node's global `fetch` is undici,
 * and this codebase has no `undici` package to import (checked: it is not a
 * dependency and `require("undici")` throws MODULE_NOT_FOUND on Node 22), so
 * there is no clean way to hand `fetch` a per-request `ca` or a custom
 * `dispatcher` here. `NODE_EXTRA_CA_CERTS` is Node's own supported answer: it
 * appends the PEM at that path to the default trust store used by
 * `tls.createSecureContext`, which undici's connector inherits — so it
 * applies to `fetch` without a line of code. It is read ONCE at process
 * start, so it must be set in the deployment's environment, not at runtime.
 *
 *   NODE_EXTRA_CA_CERTS=/etc/ssl/eta/preprod-root-ca.crt
 *
 * Set it only where a preprod tenant is served — per the FAQ, this certificate
 * does not belong in a production environment.
 *
 * ESCAPE HATCH — if a deployment ever needs finer control (a per-connection CA
 * rather than a process-wide one, mTLS, a proxy), `EtaFiscalProvider` takes an
 * injectable `fetch`: install `undici`, build an `Agent` with
 * `connect: { ca }`, and pass a fetch bound to that dispatcher. Nothing in
 * this module needs to change.
 */
export const ETA_PREPROD_CA_ENV_VAR = "NODE_EXTRA_CA_CERTS";

/**
 * Whether the preprod root CA seam above is wired in this process, and to what
 * file. Reported, never enforced: a `prod` tenant needs no extra CA, and a
 * preprod deployment that has installed the certificate at the OS trust-store
 * level instead is equally correct. Exists so a deploy check or an admin
 * screen can say "preprod is selected but no extra CA is configured" rather
 * than leaving an operator to decode a TLS handshake failure.
 */
export function etaPreprodCaFile(): string | null {
  return process.env[ETA_PREPROD_CA_ENV_VAR] || null;
}

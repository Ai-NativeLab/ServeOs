import type { Tenant } from "@/server/tenancy/schema";
import type { FiscalProvider } from "./provider";
import { NoopFiscalProvider } from "./noop-provider";
import { EtaFiscalProvider } from "./eta-provider";

export * from "./provider";
export { NoopFiscalProvider } from "./noop-provider";
export { EtaFiscalProvider } from "./eta-provider";

const eta = new EtaFiscalProvider();
const noop = new NoopFiscalProvider();

/** One provider per process, chosen from the tenant's country (F1/F2). ETA
 *  e-invoicing/e-receipts is an Egypt-specific obligation — every other
 *  country gets the no-op. */
export function resolveFiscalProvider(tenant: Pick<Tenant, "country">): FiscalProvider {
  return tenant.country === "EG" ? eta : noop;
}

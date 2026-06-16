export { tenants, tenantSettings, tenantStatus, type Tenant, type NewTenant } from "./schema";
export {
  createTenant,
  resolveTenantByHost,
  subdomainFromHost,
  getTenantBySlug,
  isTenantServable,
} from "./service";
export { getTenantSettings, setVatRate, getVatRate, defaultVatRate, type TenantSettingsData } from "./settings";

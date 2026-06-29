export { tenants, tenantSettings, tenantStatus, type Tenant, type NewTenant } from "./schema";
export {
  createTenant,
  resolveTenantByHost,
  subdomainFromHost,
  getTenantBySlug,
  getTenantById,
  isTenantServable,
} from "./service";
export { getTenantSettings, setVatRate, getVatRate, defaultVatRate, type TenantSettingsData } from "./settings";

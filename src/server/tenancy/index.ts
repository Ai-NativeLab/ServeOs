export { tenants, tenantSettings, tenantStatus, type Tenant, type NewTenant } from "./schema";
export {
  createTenant,
  resolveTenantByHost,
  subdomainFromHost,
  getTenantBySlug,
  getTenantById,
  isTenantServable,
} from "./service";
export { getTenantSettings, setVatRate, getVatRate, defaultVatRate, getWhatsappNumber, setWhatsappNumber, type TenantSettingsData } from "./settings";
export { InvalidWhatsappNumberError } from "./errors";

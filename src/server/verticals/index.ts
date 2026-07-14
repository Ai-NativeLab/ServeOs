export {
  VERTICAL_IDS,
  type VerticalId, type VerticalCapabilities, type VerticalTerms, type VerticalDescriptor,
  type AdjustmentKind, type LocalizedLabel, type VerticalStorefrontCopy,
} from "./types";
export {
  getVerticalDescriptor, getCapabilities, getVerticalTerms, requireCapability,
  VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY, selectStorefrontTemplate,
} from "./registry";
export { CapabilityNotEnabledError } from "./errors";

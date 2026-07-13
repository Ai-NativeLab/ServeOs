import { VERTICAL_IDS, type VerticalCapabilities, type VerticalDescriptor, type VerticalId, type VerticalStorefrontCopy, type VerticalTerms } from "./types";
import { CapabilityNotEnabledError } from "./errors";

const restaurant: VerticalDescriptor = {
  key: "restaurant",
  accent: "#F0522B",
  capabilities: { modifiers: true, variants: false, stockTracking: false, serviceCharge: true },
  terminology: {
    businessNoun: { en: "restaurant", ar: "مطعم" },
    catalogNoun: { en: "Menu", ar: "القائمة" },
    storefrontHeading: { en: "Menu", ar: "القائمة" },
    businessTypeLabel: { en: "Cuisine", ar: "نوع المطبخ" },
    notFoundTitle: { en: "Restaurant not found", ar: "المطعم غير موجود" },
    gettingReadyBody: { en: "This restaurant is getting ready. Check back soon!", ar: "المطعم قيد التجهيز، عد قريباً!" },
    // Empty-catalog copy must stay byte-identical to the merged
    // VERTICAL_STOREFRONT_COPY values — the storefront shell renders it today.
    emptyCatalogTitle: { en: "Menu coming soon", ar: "القائمة قريباً" },
    emptyCatalogBody: { en: "This restaurant hasn't published a menu yet.", ar: "لم ينشر هذا المطعم قائمته بعد." },
    // Must equal the current labels in src/lib/order-status.ts —
    // restaurant tenants see byte-identical status copy after this change.
    statusPreparing: { en: "Preparing", ar: "قيد التحضير" },
    statusReady: { en: "Ready", ar: "جاهز" },
  },
  storefront: { template: "menu", showWhatsapp: true },
  checkout: { adjustments: ["vat", "service_charge"] },
};

const retail: VerticalDescriptor = {
  key: "retail",
  accent: "#2DD4C4",
  capabilities: { modifiers: false, variants: true, stockTracking: true, serviceCharge: false },
  terminology: {
    businessNoun: { en: "store", ar: "متجر" },
    catalogNoun: { en: "Products", ar: "المنتجات" },
    storefrontHeading: { en: "Shop", ar: "المتجر" },
    businessTypeLabel: { en: "Store type", ar: "نوع المتجر" },
    notFoundTitle: { en: "Store not found", ar: "المتجر غير موجود" },
    gettingReadyBody: { en: "This store is getting ready. Check back soon!", ar: "المتجر قيد التجهيز، عد قريباً!" },
    emptyCatalogTitle: { en: "Catalog coming soon", ar: "الكتالوج قريباً" },
    emptyCatalogBody: { en: "This shop hasn't published its catalog yet.", ar: "لم ينشر هذا المتجر كتالوجه بعد." },
    statusPreparing: { en: "Being packed", ar: "قيد التجهيز" },
    statusReady: { en: "Ready for collection", ar: "جاهز للاستلام" },
  },
  storefront: { template: "shop", showWhatsapp: false },
  checkout: { adjustments: ["vat"] },
};

const pharmacy: VerticalDescriptor = {
  key: "pharmacy",
  accent: "#38D08C",
  capabilities: { modifiers: false, variants: true, stockTracking: true, serviceCharge: false },
  terminology: {
    businessNoun: { en: "pharmacy", ar: "صيدلية" },
    catalogNoun: { en: "Products", ar: "المنتجات" },
    storefrontHeading: { en: "Shop", ar: "المتجر" },
    businessTypeLabel: { en: "Store type", ar: "نوع المتجر" },
    notFoundTitle: { en: "Pharmacy not found", ar: "الصيدلية غير موجودة" },
    gettingReadyBody: { en: "This pharmacy is getting ready. Check back soon!", ar: "الصيدلية قيد التجهيز، عد قريباً!" },
    emptyCatalogTitle: { en: "Catalog coming soon", ar: "الكتالوج قريباً" },
    emptyCatalogBody: { en: "This pharmacy hasn't published its catalog yet.", ar: "لم تنشر هذه الصيدلية كتالوجها بعد." },
    statusPreparing: { en: "Being packed", ar: "قيد التجهيز" },
    statusReady: { en: "Ready for collection", ar: "جاهز للاستلام" },
  },
  storefront: { template: "shop", showWhatsapp: false },
  checkout: { adjustments: ["vat"] },
};

const timber: VerticalDescriptor = {
  key: "timber",
  accent: "#E8A33D",
  capabilities: { modifiers: false, variants: true, stockTracking: true, serviceCharge: false },
  terminology: {
    businessNoun: { en: "yard", ar: "منشرة" },
    catalogNoun: { en: "Yard", ar: "المخزون" },
    storefrontHeading: { en: "Yard", ar: "المخزون" },
    businessTypeLabel: { en: "Yard type", ar: "نوع المنشرة" },
    notFoundTitle: { en: "Yard not found", ar: "المنشرة غير موجودة" },
    gettingReadyBody: { en: "This yard is getting ready. Check back soon!", ar: "المنشرة قيد التجهيز، عد قريباً!" },
    emptyCatalogTitle: { en: "Yard list coming soon", ar: "قائمة المخزون قريباً" },
    emptyCatalogBody: { en: "This yard hasn't published its stock list yet.", ar: "لم تنشر هذه المنشرة قائمة مخزونها بعد." },
    statusPreparing: { en: "Being packed", ar: "قيد التجهيز" },
    statusReady: { en: "Ready for collection", ar: "جاهز للاستلام" },
  },
  storefront: { template: "shop", showWhatsapp: false },
  checkout: { adjustments: ["vat"] },
};

const REGISTRY: Record<VerticalId, VerticalDescriptor> = { restaurant, retail, pharmacy, timber };

export { VERTICAL_IDS };
export type { VerticalId };

export function getVerticalDescriptor(key: VerticalId): VerticalDescriptor {
  return REGISTRY[key];
}
export function getCapabilities(key: VerticalId): VerticalCapabilities {
  return REGISTRY[key].capabilities;
}
export function getVerticalTerms(key: VerticalId): VerticalTerms {
  return REGISTRY[key].terminology;
}
/** Throws CapabilityNotEnabledError when the vertical lacks the capability. */
export function requireCapability(key: VerticalId, capability: keyof VerticalCapabilities): void {
  if (!REGISTRY[key].capabilities[capability]) throw new CapabilityNotEnabledError(capability);
}

// ── compat exports for the merged scaffold (derived from descriptors) ─────────

export const VERTICAL_ACCENTS: Record<VerticalId, string> = Object.fromEntries(
  VERTICAL_IDS.map((k) => [k, REGISTRY[k].accent]),
) as Record<VerticalId, string>;

export const VERTICAL_STOREFRONT_COPY: Record<VerticalId, VerticalStorefrontCopy> = Object.fromEntries(
  VERTICAL_IDS.map((k) => {
    const d = REGISTRY[k];
    return [k, {
      menuHeading: d.terminology.storefrontHeading.en,
      showWhatsapp: d.storefront.showWhatsapp,
      emptyMenuTitle: d.terminology.emptyCatalogTitle.en,
      emptyMenuDesc: d.terminology.emptyCatalogBody.en,
    }];
  }),
) as Record<VerticalId, VerticalStorefrontCopy>;

/** Resolve the storefront template for a tenant's vertical. Unknown → restaurant. */
export function selectStorefrontTemplate(vertical: VerticalId | null | undefined): VerticalId {
  return vertical && (VERTICAL_IDS as readonly string[]).includes(vertical) ? vertical : "restaurant";
}

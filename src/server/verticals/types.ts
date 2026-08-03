export const VERTICAL_IDS = ["restaurant", "retail", "pharmacy", "timber"] as const;
export type VerticalId = (typeof VERTICAL_IDS)[number];

export type VerticalCapabilities = {
  modifiers: boolean;
  variants: boolean;
  stockTracking: boolean;
  serviceCharge: boolean;
  /** P4 (timber): products priced per unit of measure instead of per each. */
  dimensionalProducts: boolean;
  /** P4: the UoM picker/label surfaces in dashboard product forms. */
  unitsOfMeasure: boolean;
  /** P4: a customer can be trade-approved for a per-order discount %. */
  tradeAccounts: boolean;
  /** P3 (pharmacy): customers upload a prescription for Rx-flagged products. */
  prescriptionUpload: boolean;
  /** P3: an Rx order is gated on pharmacist review before fulfilment. */
  pharmacistReview: boolean;
  /** P3 fast-follow: per-line tax classes (VAT-exempt medicines). */
  taxClasses: boolean;
};

export type LocalizedLabel = { en: string; ar: string };

export type VerticalTerms = {
  businessNoun: LocalizedLabel;      // "restaurant" / "store" / "pharmacy" / "yard"
  catalogNoun: LocalizedLabel;       // dashboard nav: "Menu" / "Products" / "Products" / "Yard"
  storefrontHeading: LocalizedLabel; // storefront section: "Menu" / "Shop" / "Shop" / "Yard"
  businessTypeLabel: LocalizedLabel; // "Cuisine" / "Store type" / "Store type" / "Yard type"
  notFoundTitle: LocalizedLabel;     // storefront: unknown slug
  gettingReadyBody: LocalizedLabel;  // storefront: tenant not servable
  emptyCatalogTitle: LocalizedLabel; // "Menu coming soon" / "Catalog coming soon" / ...
  emptyCatalogBody: LocalizedLabel;
  statusPreparing: LocalizedLabel;   // "Preparing" / "Being packed"
  statusReady: LocalizedLabel;       // "Ready" / "Ready for collection"
};

export type AdjustmentKind = "vat" | "service_charge";

export type VerticalDescriptor = {
  key: VerticalId;
  accent: string; // hex, shared with the marketing landing tokens
  capabilities: VerticalCapabilities;
  terminology: VerticalTerms;
  storefront: { template: "menu" | "shop"; showWhatsapp: boolean };
  checkout: { adjustments: AdjustmentKind[] };
};

/** Compat shape consumed by the merged StorefrontShell (derived, never hand-written). */
export type VerticalStorefrontCopy = {
  menuHeading: string;
  showWhatsapp: boolean;
  emptyMenuTitle: string;
  emptyMenuDesc: string;
};

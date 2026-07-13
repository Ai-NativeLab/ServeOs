export const VERTICAL_IDS = ["restaurant", "retail", "pharmacy", "timber"] as const;
export type VerticalId = (typeof VERTICAL_IDS)[number];

export type VerticalCapabilities = {
  modifiers: boolean;
  variants: boolean;
  stockTracking: boolean;
  serviceCharge: boolean;
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

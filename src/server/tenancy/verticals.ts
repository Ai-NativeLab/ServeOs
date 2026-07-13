export const VERTICAL_IDS = ["restaurant", "retail", "pharmacy", "timber"] as const;
export type VerticalId = (typeof VERTICAL_IDS)[number];

export const VERTICAL_ACCENTS: Record<VerticalId, string> = {
  restaurant: "#F0522B",
  retail: "#2DD4C4",
  pharmacy: "#38D08C",
  timber: "#E8A33D",
};

export type VerticalStorefrontCopy = {
  /** Section heading above the catalog (Menu / Shop / Yard). */
  menuHeading: string;
  /** Whether the storefront footer renders the WhatsApp contact CTA. */
  showWhatsapp: boolean;
  /** Title shown when the tenant has no published items. */
  emptyMenuTitle: string;
  /** Description shown when the tenant has no published items. */
  emptyMenuDesc: string;
};

export const VERTICAL_STOREFRONT_COPY: Record<VerticalId, VerticalStorefrontCopy> = {
  restaurant: {
    menuHeading: "Menu",
    showWhatsapp: true,
    emptyMenuTitle: "Menu coming soon",
    emptyMenuDesc: "This restaurant hasn't published a menu yet.",
  },
  retail: {
    menuHeading: "Shop",
    showWhatsapp: false,
    emptyMenuTitle: "Catalog coming soon",
    emptyMenuDesc: "This shop hasn't published its catalog yet.",
  },
  pharmacy: {
    menuHeading: "Shop",
    showWhatsapp: false,
    emptyMenuTitle: "Catalog coming soon",
    emptyMenuDesc: "This pharmacy hasn't published its catalog yet.",
  },
  timber: {
    menuHeading: "Yard",
    showWhatsapp: false,
    emptyMenuTitle: "Yard list coming soon",
    emptyMenuDesc: "This yard hasn't published its stock list yet.",
  },
};

/** Resolve the storefront template for a tenant's vertical. Unknown → restaurant. */
export function selectStorefrontTemplate(vertical: VerticalId | null | undefined): VerticalId {
  return vertical && (VERTICAL_IDS as readonly string[]).includes(vertical) ? vertical : "restaurant";
}

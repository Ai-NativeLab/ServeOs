import type { VerticalId } from "@/server/verticals";

const IMG = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;

/**
 * A photo committed to public/marketing/demo/ rather than hotlinked.
 *
 * Preferred over IMG() for anything new. Hotlinking puts a third party in the
 * render path of a customer-facing storefront: the id can be withdrawn, the
 * host can rate-limit, and product images bypass next/image so there is
 * nothing between a dead link and a broken tile. A committed file cannot rot.
 *
 * Only CC0 / public-domain sources, so redistributing them from our own domain
 * is unambiguously fine and no attribution is owed on a commercial page.
 */
const LOCAL = (file: string) => `/marketing/demo/${file}`;

/**
 * Demo photography, grouped by the trade it belongs to.
 *
 * Grouping is the point. These were inline `IMG("1584949...")` calls scattered
 * through the seed, and anonymous ids are how the wrong picture ends up in the
 * wrong shop: retail's entire Snacks aisle once shared one photo of a computer
 * screen, and its LOGO was Roma's "Starters" plate — an Italian restaurant
 * dish fronting an Egyptian mini-market. Nothing in the code said what any id
 * showed, so nobody could see it was wrong.
 *
 * Two rules, both enforced by images.test.ts rather than by good intentions:
 *
 *   1. No id may appear under more than one trade. Food stays in restaurants,
 *      medicines in pharmacies, boards in the timber yard.
 *   2. The seed may not write a bare IMG("…") anywhere — every picture it uses
 *      has to come from the group below, so it always carries a name saying
 *      what it depicts.
 *
 * Every id is checked to return 200 from images.unsplash.com. That matters
 * because product photos bypass next/image and render in a plain <img>, so a
 * dead id is a broken image on a customer's screen with nothing to catch it.
 *
 * NAMES DESCRIBE THE PHOTO, NOT ITS SLOT. If a name here turns out not to
 * match what the picture actually shows, the name is the bug — rename it and
 * move it to the trade it really belongs to.
 */
export const DEMO_IMAGES = {
  restaurant: {
    GRILL_PLATTER: IMG("1544025162-d76694265947"),
    MEZZE_SPREAD: IMG("1512621776951-a57141f2eefd"),
    RICE_SIDES: IMG("1587854692152-cbe660dbde88"),
    DRINKS_TRAY: IMG("1621905251189-08b45d6a269e"),
    LEMONADE: IMG("1621263764928-df1444c5e859"),
    DESSERTS: IMG("1551024601-bec78aea704b"),
    RESTAURANT_COVER: IMG("1600335895229-6e75511892c8"),
    RESTAURANT_LOGO: IMG("1607330289024-1535c6b4e1c1"),
  },
  retail: {
    // The Snacks aisle, one photo per product. It previously ran on a single
    // shot of blue gloved hands — the whole aisle, crisps to peanuts.
    //
    // All four are CC0 and committed locally. Sourced by searching Openverse
    // for the licence, then confirming the subject from the host's own
    // metadata rather than from a filename: Wikimedia Commons puts
    // potato-chips.jpg in categories "Potato chips" and "Side dishes", which
    // is human-curated and worth more than a name. That check matters — the
    // same search returned "Potato Chip Rock", which is a hiking trail.
    POTATO_CHIPS: LOCAL("potato-chips.jpg"),
    CHOCOLATE: LOCAL("chocolate.jpg"),
    BISCUITS: LOCAL("biscuits.jpg"),
    PEANUTS: LOCAL("peanuts.jpg"),

    // Kept as the shop's cover only. It reads as blue gloved hands, which
    // suits a mini-market poorly, but it is retail's own and it resolves.
    GLOVED_HANDS: IMG("1585421514738-01798e348b17"),
    SOFT_DRINKS: IMG("1607619056574-7b8d3ee536b2"),
    DAIRY_EGGS: IMG("1560343090-f0409e92791a"),
    HOUSEHOLD_CLEANING: IMG("1590212151175-e58edd96185b"),
  },
  pharmacy: {
    MEDICINES: IMG("1587293852726-70cdb56c2866"),
    PERSONAL_CARE: IMG("1583258292688-d0213dc5a3a8"),
    BABY_CARE: IMG("1512909006721-3d6018887383"),
    SUPPLEMENTS: IMG("1567620905732-2d1ec7ab7445"),
    PHARMACY_COVER: IMG("1550989460-0adf9ea622e2"),
    PHARMACY_LOGO: IMG("1584362917165-526a968579e8"),
  },
  timber: {
    SHEET_GOODS: IMG("1600585154340-be6161a56a0c"),
    PLANED_TIMBER: IMG("1583947215259-38e31be8751f"),
    MOULDINGS: IMG("1584308666744-24d5c474f2ae"),
    FIXINGS: IMG("1600891964092-4316c288032e"),
    HINGES: IMG("1530124566582-a618bc2615dc"),
    HANDLES: IMG("1556228453-efd6c1ff04f6"),
    TIMBER_COVER: IMG("1583947581924-860bda6a26df"),
    TIMBER_LOGO: IMG("1584017911766-d451b3d0e843"),
  },
} as const satisfies Record<VerticalId, Record<string, string>>;

/** Every image a trade is allowed to use. */
export function imagesFor(trade: VerticalId): string[] {
  return Object.values(DEMO_IMAGES[trade]);
}

/**
 * WHAT IS STILL WRONG, and why it is not fixed here.
 *
 * The rules above guarantee separation — no trade uses another's photo — and
 * that is machine-checkable, so it is checked. What they cannot guarantee is
 * that a photo DEPICTS its trade, because that needs eyes on the image.
 *
 * Known outstanding, both needing a human with a picture in front of them:
 *
 *   retail GLOVED_HANDS — currently the Snacks aisle and the shop's cover.
 *   It appears to show blue gloved hands. A mini-market's crisps and
 *   chocolate deserve better, and it reads as medical.
 *
 *   Every trade reuses one photo across a whole category. There is no
 *   per-dish, per-medicine or per-board photography in the verified pool, so
 *   eight grills share one grill platter.
 *
 * Do NOT fix either by inventing Unsplash ids. An invented id is a coin flip:
 * of the two tried while writing this file, one 404'd and the other resolved
 * to a photo nobody has seen — which is the worse outcome of the two, because
 * it ships.
 */

/**
 * A stable identity for a photo, so two trades can be compared for overlap
 * regardless of where the file lives — the Unsplash id for a hotlink, the path
 * for a committed file.
 */
export function photoId(url: string): string | null {
  if (url.startsWith("/")) return url;
  return url.match(/photo-([^?]+)/)?.[1] ?? null;
}

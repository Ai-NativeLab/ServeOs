import { VERTICAL_IDS, type VerticalId } from "@/server/verticals";
import type { Locale } from "@/shared/errors";

/**
 * The surfaces the Playwright pipeline can reach. POS is deliberately absent:
 * it is an Electron application in apps/pos, not a route in this Next app, so
 * no browser automation against localhost can render it.
 */
export const CAPTURED_SURFACES = ["storefront", "dashboard"] as const;
export type CapturedSurface = (typeof CAPTURED_SURFACES)[number];

export type Shot = { trade: VerticalId; surface: CapturedSurface; locale: Locale };

/**
 * Public URL for a capture. The single place these paths are constructed.
 *
 * PNG because Playwright writes PNG or JPEG only, and next/image serves the
 * browser a modern format regardless of the source — converting buys nothing.
 */
export function shotPath(trade: VerticalId, surface: CapturedSurface, locale: Locale): string {
  return `/marketing/shots/${trade}/${surface}.${locale}.png`;
}

/**
 * The POS band's image. Captured by hand from the running Electron app and
 * committed — see the capture task. Trade-independent, because the counter
 * looks the same whatever it is selling, so this is two files rather than
 * eight.
 */
export function posShotPath(locale: Locale): string {
  return `/marketing/shots/pos.${locale}.png`;
}

/**
 * 16 captures: every automated surface, for every trade, in both locales.
 *
 * Derived from CAPTURED_SURFACES rather than maintained beside the tour, so the
 * matrix cannot drift from what the page renders. Every band the tour shows in a
 * locale is captured in that locale — an earlier draft captured Arabic-only for
 * some surfaces while the tour rendered them in both, which would have shipped
 * four broken images on /en.
 */
export const SHOT_MATRIX: Shot[] = VERTICAL_IDS.flatMap((trade) =>
  CAPTURED_SURFACES.flatMap((surface) =>
    (["ar", "en"] as const).map((locale) => ({ trade, surface, locale })),
  ),
);

import { VERTICAL_IDS, type VerticalId } from "@/server/verticals";

/**
 * The surfaces the Playwright pipeline captures from a browser.
 *
 * POS is absent because it is a separate Vite/Electron app in apps/pos, not a
 * route in this Next app — it is captured against its own dev server and stored
 * as a single asset, see posShotPath.
 */
export const CAPTURED_SURFACES = ["storefront", "dashboard"] as const;
export type CapturedSurface = (typeof CAPTURED_SURFACES)[number];

export type Shot = { trade: VerticalId; surface: CapturedSurface };

/**
 * Public URL for a capture. The single place these paths are constructed.
 *
 * NO LOCALE IN THE PATH, deliberately. The app's UI chrome is English-only:
 * `VERTICAL_STOREFRONT_COPY` resolves `.en` in src/server/verticals/registry.ts
 * and the dashboard has no i18n at all. Capturing an "ar" variant would produce
 * a byte-identical English screenshot under a name claiming otherwise, so one
 * set is captured and served on both locales. When the app is localized, add the
 * locale back here and the matrix widens with it.
 *
 * PNG because Playwright writes PNG or JPEG only, and next/image serves the
 * browser a modern format regardless of source — converting buys nothing.
 */
export function shotPath(trade: VerticalId, surface: CapturedSurface): string {
  return `/marketing/shots/${trade}/${surface}.png`;
}

/**
 * The POS band's image. Trade-independent — the counter looks the same whatever
 * it is selling — and locale-independent for the same reason as above.
 */
export function posShotPath(): string {
  return "/marketing/shots/pos.png";
}

/**
 * 8 captures: every automated surface for every trade.
 *
 * Derived from CAPTURED_SURFACES rather than maintained beside the tour, so the
 * matrix cannot drift from what the page renders.
 */
export const SHOT_MATRIX: Shot[] = VERTICAL_IDS.flatMap((trade) =>
  CAPTURED_SURFACES.map((surface) => ({ trade, surface })),
);

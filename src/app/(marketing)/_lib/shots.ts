import { VERTICAL_IDS, type VerticalId } from "@/server/verticals";
import type { SurfaceKey } from "../_content/surfaces";

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
 * The device each surface is captured on, and therefore the frame the tour
 * draws around it.
 *
 * This is ONE fact with two consumers — the capture script sets its viewport
 * from it, the band picks its chrome and aspect ratio from it — so it lives
 * here rather than being asserted twice and drifting. A storefront captured at
 * 1440px but framed as a phone would letterbox; the reverse crops.
 *
 * The storefront is a phone because that is what it IS: the copy beside it says
 * "built mobile-first", and a mobile-first page screenshotted at desktop width
 * is ~60% empty cream — which is exactly how this section came to look bare.
 * The dashboard and the till are genuine desktop surfaces and stay landscape.
 */
export type Device = "phone" | "desktop" | "till";

export const SURFACE_DEVICE: Record<SurfaceKey, Device> = {
  storefront: "phone",
  dashboard: "desktop",
  pos: "till",
};

/** Whether a device is framed as a window (chrome bar) or as a handset. */
export function isWindowed(device: Device): boolean {
  return device !== "phone";
}

/**
 * Capture viewports, in CSS pixels. Every capture is taken at
 * deviceScaleFactor 2, so the committed PNG is twice these numbers.
 *
 * 390×844 is the iPhone 14/15 logical viewport — the most common phone size in
 * the region and a real breakpoint the storefront is designed against, not an
 * arbitrary tall box.
 */
export const DEVICE_VIEWPORT: Record<Device, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
  // The till is shorter than a dashboard on purpose. Its take-order screen is
  // a fixed, non-scrolling layout — a product grid and a ticket rail — so at
  // 900px the seeded four-item category leaves a third of the frame as bare
  // dark panel. 16:9 crops that slack out of the CAPTURE rather than out of
  // the image later, which is the difference between a tight screenshot and a
  // cropped one.
  till: { width: 1440, height: 810 },
};

/** The frame's aspect ratio, derived from the viewport it was captured at. */
export function deviceAspect(device: Device): string {
  const { width, height } = DEVICE_VIEWPORT[device];
  return `${width} / ${height}`;
}

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

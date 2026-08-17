"use client";
import Image from "next/image";
import { deviceAspect, isWindowed, type Device } from "../_lib/shots";

/**
 * The chrome drawn around a captured surface.
 *
 * Its job is to say WHERE a screenshot lives before the visitor reads a word:
 * a phone bezel for the storefront, a browser bar for the dashboard and the
 * till. That framing is also what lets the images keep their true aspect —
 * the previous version had no frame and stretched the image to fill the panel
 * instead, which cropped a 16:10 capture into a portrait slice and sliced the
 * tenant's own name in half.
 *
 * The aspect ratio is derived from the capture viewport (see SURFACE_DEVICE),
 * never hardcoded here, so a frame cannot disagree with the file inside it.
 */
/**
 * A phone bezel around arbitrary content.
 *
 * Height-driven, not width-driven: the phone is the tallest thing in a band,
 * so it takes its size from the space available and the column width follows.
 * `w-auto` against an aspect-ratio is what keeps it honest — no stretching.
 */
export function PhoneShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    // The aspect-ratio lives on the SCREEN, not on the outer shell, and the
    // bezel is padding wrapped around it. Putting the ratio on the outer box
    // instead makes the 6px bezel eat into it, leaving the screen ~3% off the
    // capture's ratio — enough for object-cover to shave a sliver off. This
    // way the screen is exactly the capture viewport and nothing is cropped.
    <div
      className={`mx-auto w-fit rounded-[2.2rem] bg-ink p-[6px] shadow-[0_28px_60px_rgba(58,51,44,0.28)] ring-1 ring-black/10 ${className}`}
    >
      <div className="relative">
        <div
          className="relative w-[min(60vw,248px)] overflow-hidden rounded-[1.85rem] bg-muted/40 lg:h-[min(54vh,500px)] lg:w-auto"
          style={{ aspectRatio: deviceAspect("phone") }}
        >
          {children}
        </div>
        {/* The earpiece slot. Enough to read as a phone; not a pixel replica of
            anyone's hardware. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[8px] h-[5px] w-14 -translate-x-1/2 rounded-full bg-white/25"
        />
      </div>
    </div>
  );
}

export function DeviceFrame({
  device,
  src,
  alt,
  priority = false,
}: {
  device: Device;
  src: string;
  alt: string;
  priority?: boolean;
}) {
  const aspectRatio = deviceAspect(device);

  if (!isWindowed(device)) {
    return (
      <PhoneShell>
        <Image
          src={src}
          alt={alt}
          fill
          sizes="(min-width: 1024px) 280px, 60vw"
          priority={priority}
          loading={priority ? undefined : "lazy"}
          className="object-cover object-top"
        />
      </PhoneShell>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_20px_50px_rgba(58,51,44,0.14)]">
      {/* Browser bar. Three dots and nothing else — a URL here would either be
          a localhost seed address or an invented one, and neither belongs on a
          marketing page. */}
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-3.5 py-2.5">
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
      </div>
      <div className="relative bg-muted/40" style={{ aspectRatio }}>
        <Image
          src={src}
          alt={alt}
          fill
          sizes="(min-width: 1024px) 62vw, 100vw"
          priority={priority}
          loading={priority ? undefined : "lazy"}
          className="object-cover object-top"
        />
      </div>
    </div>
  );
}

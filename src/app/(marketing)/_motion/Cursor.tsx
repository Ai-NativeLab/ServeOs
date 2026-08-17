"use client";
import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

/**
 * A trailing cursor ring that reacts to what it is over.
 *
 * Strictly an enhancement layered on top of the real cursor, never a
 * replacement: hiding the native cursor to draw your own is how sites end up
 * unusable when the script fails, and it wrecks the affordance people rely on
 * to know what is clickable.
 *
 * Fine pointers only. On touch there is no cursor to augment, and the listener
 * would burn battery on the mid-range Androids this page is mostly read on.
 * Under reduced motion it never mounts anything.
 *
 * `quickTo` reuses one tween per axis rather than allocating per pointer event,
 * which is what keeps this at 60fps.
 */
export function Cursor() {
  const ring = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const el = ring.current;
    if (!el) return;

    const mm = gsap.matchMedia();

    mm.add("(prefers-reduced-motion: no-preference) and (pointer: fine)", () => {
      gsap.set(el, { xPercent: -50, yPercent: -50, opacity: 0 });

      const xTo = gsap.quickTo(el, "x", { duration: 0.42, ease: "power3" });
      const yTo = gsap.quickTo(el, "y", { duration: 0.42, ease: "power3" });

      let visible = false;
      const move = (e: PointerEvent) => {
        if (!visible) {
          visible = true;
          gsap.to(el, { opacity: 1, duration: 0.3 });
        }
        xTo(e.clientX);
        yTo(e.clientY);

        // Grow and hollow out over anything actionable, so the ring reads as a
        // target rather than a decoration that happens to follow you.
        const over = (e.target as HTMLElement | null)?.closest(
          "a, button, [role='tab'], input, select, textarea",
        );
        gsap.to(el, {
          scale: over ? 2.1 : 1,
          borderColor: over
            ? "color-mix(in srgb, var(--trade-accent) 90%, transparent)"
            : "color-mix(in srgb, var(--foreground) 30%, transparent)",
          duration: 0.28,
          ease: "power3.out",
          overwrite: "auto",
        });
      };

      const leave = () => {
        visible = false;
        gsap.to(el, { opacity: 0, duration: 0.25 });
      };

      window.addEventListener("pointermove", move, { passive: true });
      document.addEventListener("pointerleave", leave);
      return () => {
        window.removeEventListener("pointermove", move);
        document.removeEventListener("pointerleave", leave);
      };
    });

    return () => mm.revert();
  }, {});

  return (
    <div
      ref={ring}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-[60] hidden size-6 rounded-full border opacity-0 [@media(pointer:fine)]:block"
      style={{ borderColor: "color-mix(in srgb, var(--foreground) 30%, transparent)" }}
    />
  );
}

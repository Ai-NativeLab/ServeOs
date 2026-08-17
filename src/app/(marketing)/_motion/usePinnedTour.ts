"use client";
import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger);

/**
 * Pins the product tour and advances its panels as you scroll through it.
 *
 * The section holds still while the copy and the screenshot for each surface
 * cross-fade in sequence, scrubbed to the scrollbar. This is the one mechanic
 * that suits a product tour better than a portfolio: the reader is walked
 * through four surfaces at their own pace instead of scrolling past four
 * near-identical bands.
 *
 * Deliberately desktop-only (`min-width: 1024px`). Pinning on a phone hijacks
 * the scroll of the audience most likely to be on a slow connection, and the
 * stacked bands read perfectly well there — the fallback IS the mobile design,
 * not a degraded one.
 *
 * Below that breakpoint, and under reduced-motion, nothing here runs and the
 * panels render as a plain stacked list.
 */
export function usePinnedTour(panelCount: number, dependencies: unknown[] = []) {
  const scope = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;

      const mm = gsap.matchMedia();

      mm.add("(prefers-reduced-motion: no-preference) and (min-width: 1024px)", () => {
        const panels = gsap.utils.toArray<HTMLElement>("[data-tour='panel']", root);
        const markers = gsap.utils.toArray<HTMLElement>("[data-tour='marker']", root);
        if (panels.length < 2) return;

        // Stack the panels: all but the first start hidden and slightly low.
        gsap.set(panels.slice(1), { autoAlpha: 0, yPercent: 8 });
        gsap.set(panels[0], { autoAlpha: 1, yPercent: 0 });
        if (markers.length) {
          gsap.set(markers, { scaleX: 0, transformOrigin: "left center" });
          gsap.set(markers[0], { scaleX: 1 });
        }

        const tl = gsap.timeline({
          defaults: { ease: "power2.inOut" },
          scrollTrigger: {
            trigger: root,
            start: "top top",
            // One viewport of scroll per transition, so each panel gets equal air.
            end: () => `+=${(panels.length - 1) * 100}%`,
            pin: true,
            scrub: 0.7,
            anticipatePin: 1,
            invalidateOnRefresh: true,
          },
        });

        panels.forEach((panel, i) => {
          if (i === 0) return;
          tl.to(panels[i - 1], { autoAlpha: 0, yPercent: -8, duration: 0.5 }, i - 1)
            .to(panel, { autoAlpha: 1, yPercent: 0, duration: 0.5 }, i - 1 + 0.15);

          if (markers[i - 1] && markers[i]) {
            tl.to(markers[i - 1], { scaleX: 0, duration: 0.4 }, i - 1)
              .to(markers[i], { scaleX: 1, duration: 0.4 }, i - 1 + 0.15);
          }
        });

        return () => {
          // Leave nothing hidden when the context reverts — a stranded
          // autoAlpha:0 would blank the section at a narrower breakpoint.
          gsap.set([...panels, ...markers], { clearProps: "all" });
        };
      });

      return () => mm.revert();
    },
    // revertOnUpdate is what makes the cleanup above run when `dependencies`
    // change. Without it useGSAP defers cleanup to unmount (see its
    // `deferCleanup` branch), so switching trade built a SECOND pinned
    // ScrollTrigger on this section without reverting the first. Two triggers
    // pinning one element makes ScrollTrigger drop pin spacing, which removed
    // ~2700px from the document, and Lenis then held a scroll limit measured
    // against the collapsed page — the reader could not scroll past the tour.
    { scope, dependencies: [panelCount, ...dependencies], revertOnUpdate: true },
  );

  return scope;
}

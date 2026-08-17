"use client";
import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger, SplitText);

/**
 * The hero's opening timeline, plus its scroll and pointer behaviour.
 *
 * Everything is `from()`, so the served HTML is the finished state and the page
 * survives with JavaScript off. All of it is registered inside a matchMedia
 * keyed on `no-preference`, so opting out of motion reverts the lot and leaves
 * the hero exactly as rendered.
 *
 * Elements are addressed by `data-hero` attributes rather than class names, so
 * restyling never silently breaks the choreography.
 */
export function useHeroTimeline(dependencies: unknown[] = []) {
  const scope = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;

      const mm = gsap.matchMedia();

      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const headline = root.querySelector<HTMLElement>("[data-hero='headline']");

        /**
         * WORDS, never characters — and no line mask. Both rules exist because
         * Arabic is the default locale:
         *
         * 1. Arabic is cursive and joins contextually. Wrapping each character
         *    in its own element severs those joins, so "ألا تملك" renders as
         *    isolated letterforms. Word boundaries are safe: joining happens
         *    inside a word, never across a space.
         * 2. `mask: "lines"` clips overflow, and Arabic descenders (ق ج ي) sit
         *    well below the baseline — they get sliced off.
         *
         * autoSplit re-splits after webfonts land and on resize, which also
         * fixes line measurement taken against the fallback font.
         */
        const split = headline
          ? SplitText.create(headline, {
              type: "lines,words",
              autoSplit: true,
              // The marker swipe is absolutely positioned and animated
              // separately; splitting it would tear it out of its anchor.
              ignore: "[data-hero='marker']",
              onSplit: (self) =>
                gsap.from(self.words, {
                  y: "0.55em",
                  opacity: 0,
                  duration: 1,
                  ease: "expo.out",
                  stagger: { each: 0.035, from: "start" },
                }),
            })
          : null;

        const tl = gsap.timeline({ defaults: { ease: "expo.out" } });

        tl.from("[data-hero='eyebrow']", { y: 14, opacity: 0, duration: 0.7 }, 0)
          .from("[data-hero='eyebrow-tick']", { scaleX: 0, transformOrigin: "left center", duration: 0.8 }, 0.05);

        // The headline reveal is owned by SplitText's onSplit above, so that it
        // re-runs correctly whenever autoSplit re-splits. The rest of the hero
        // is sequenced here against the same start.

        // The marker swipe draws itself after the words it underlines land.
        tl.from(
          "[data-hero='marker']",
          { scaleX: 0, transformOrigin: "left center", duration: 0.9, ease: "power3.inOut" },
          0.75,
        )
          .from("[data-hero='subhead']", { y: 18, opacity: 0, duration: 0.9 }, 0.5)
          .from("[data-hero='cta'] > *", { y: 16, opacity: 0, duration: 0.8, stagger: 0.08 }, 0.62)
          .from("[data-hero='trust'] > *", { opacity: 0, duration: 0.6, stagger: 0.06 }, 0.8)
          // The dashboard arrives as a slab, slightly further than its resting
          // rotation so it settles into place rather than snapping.
          .from(
            "[data-hero='shot']",
            { yPercent: 12, opacity: 0, rotate: -4, scale: 0.96, duration: 1.3 },
            0.25,
          )
          // The ticket lands last, with overshoot — an order just came in.
          .from(
            "[data-hero='ticket']",
            { y: 44, opacity: 0, rotate: 10, scale: 0.9, duration: 1, ease: "back.out(1.6)" },
            0.85,
          );

        // Depth on scroll: the slab and the ticket leave at different rates, so
        // the stack reads as layered rather than as one flat image.
        gsap.to("[data-hero='shot']", {
          yPercent: -12,
          ease: "none",
          scrollTrigger: { trigger: root, start: "top top", end: "bottom top", scrub: 0.8 },
        });
        gsap.to("[data-hero='ticket']", {
          yPercent: -34,
          ease: "none",
          scrollTrigger: { trigger: root, start: "top top", end: "bottom top", scrub: 0.5 },
        });

        // Pointer parallax, fine-pointer devices only — on touch there is no
        // hover to track and the listener would just cost battery.
        const stack = root.querySelector<HTMLElement>("[data-hero='stack']");
        let onMove: ((e: PointerEvent) => void) | undefined;

        if (stack && window.matchMedia("(pointer: fine)").matches) {
          const shotX = gsap.quickTo("[data-hero='shot']", "x", { duration: 0.9, ease: "power3" });
          const shotY = gsap.quickTo("[data-hero='shot']", "y", { duration: 0.9, ease: "power3" });
          const tickX = gsap.quickTo("[data-hero='ticket']", "x", { duration: 0.7, ease: "power3" });
          const tickY = gsap.quickTo("[data-hero='ticket']", "y", { duration: 0.7, ease: "power3" });

          onMove = (e: PointerEvent) => {
            const r = stack.getBoundingClientRect();
            const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
            const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
            shotX(dx * 16);
            shotY(dy * 12);
            tickX(dx * -28);
            tickY(dy * -20);
          };
          window.addEventListener("pointermove", onMove, { passive: true });
        }

        return () => {
          if (onMove) window.removeEventListener("pointermove", onMove);
          // Restores the original markup, so the headline is left as authored
          // rather than as a tree of word wrappers.
          split?.revert();
        };
      });

      return () => mm.revert();
    },
    { scope, dependencies },
  );

  return scope;
}

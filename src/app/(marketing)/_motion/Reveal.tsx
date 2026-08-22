"use client";
import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { motionDir } from "./ScrollProvider";

export type RevealKind = "rise" | "blur" | "scale" | "slide" | "wipe" | "stagger" | "scrub";

/**
 * A scroll reveal built on `gsap.from()`.
 *
 * Why `from` and not `to`: `from` reads the element's real rendered state and
 * animates toward it, so the served HTML is already the finished state. Nothing
 * is hidden in CSS, which keeps the page whole for crawlers and for anyone
 * without JavaScript. The previous CSS implementation needed a `data-armed`
 * dance to achieve the same thing; this gets it for free.
 *
 * `scrub` ties progress to the scrollbar rather than firing once — that is the
 * difference between "things fade in" and motion that feels authored.
 */
export function Reveal({
  children,
  kind = "rise",
  className,
  start = "top 85%",
}: {
  children: React.ReactNode;
  kind?: RevealKind;
  className?: string;
  start?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;

      // Everything below is registered inside this matchMedia, so opting out of
      // motion reverts all of it and leaves the page in its natural state.
      const mm = gsap.matchMedia();

      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const common = {
          scrollTrigger: { trigger: el, start, once: kind !== "scrub" },
          ease: "expo.out" as const,
          duration: 1.1,
        };

        if (kind === "stagger") {
          // Depth of two: each section renders one <section> root, so the pieces
          // worth staggering are its children.
          const items = el.querySelectorAll<HTMLElement>(":scope > * > *");
          if (!items.length) return;
          gsap.from(items, { ...common, y: 26, opacity: 0, stagger: 0.075 });
          return;
        }

        if (kind === "scrub") {
          gsap.from(el, {
            y: 60,
            opacity: 0.25,
            ease: "none",
            scrollTrigger: { trigger: el, start: "top 92%", end: "top 45%", scrub: 0.6 },
          });
          return;
        }

        const vars: Record<RevealKind, gsap.TweenVars> = {
          rise: { y: 34, opacity: 0 },
          blur: { y: 16, opacity: 0, filter: "blur(12px)" },
          scale: { scale: 0.94, opacity: 0, transformOrigin: "50% 60%" },
          // Signed by reading direction: enters from the right in Arabic.
          slide: { x: motionDir() * -56, opacity: 0 },
          wipe: { clipPath: "inset(0 0 100% 0)", opacity: 0 },
          stagger: {},
          scrub: {},
        };

        gsap.from(el, { ...common, ...vars[kind] });
      });

      return () => mm.revert();
    },
    { scope: ref, dependencies: [kind, start] },
  );

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

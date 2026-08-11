"use client";
import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

/**
 * The motion substrate: Lenis inertial scrolling driven by GSAP's ticker, so
 * smooth scroll and every ScrollTrigger share one clock. Two rAF loops fighting
 * each other is the classic cause of scrubbed animations juddering.
 *
 * Three rules this must never break:
 *
 * 1. NO-JS / SEO. Nothing here hides anything. Every reveal is a `gsap.from()`,
 *    which reads the element's real rendered state and animates toward it — so
 *    the served HTML is complete and visible, and a crawler that ignores our
 *    JavaScript sees the finished page. Never convert these to `gsap.to()` off a
 *    pre-hidden CSS state.
 *
 * 2. REDUCED MOTION. Everything animated is registered inside a
 *    `gsap.matchMedia()` context keyed on `(prefers-reduced-motion: no-preference)`.
 *    When the user opts out, GSAP reverts the whole context and Lenis never
 *    starts — native scrolling, no transforms, nothing stranded mid-animation.
 *
 * 3. RTL. Arabic is the default locale. Horizontal motion must be expressed
 *    through `motionDir()` rather than a hardcoded sign, or the page slides the
 *    wrong way for most of its readers.
 */

let registered = false;
function registerOnce() {
  if (registered) return;
  gsap.registerPlugin(ScrollTrigger);
  registered = true;
}

/** +1 when the document reads left-to-right, -1 in RTL. */
export function motionDir(): 1 | -1 {
  if (typeof document === "undefined") return 1;
  return document.documentElement.dir === "rtl" ? -1 : 1;
}

export function ScrollProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    registerOnce();

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // Native scrolling, no smoothing. ScrollTrigger still works for anything
      // that opts back in, but nothing is animated by default.
      ScrollTrigger.refresh();
      return;
    }

    const lenis = new Lenis({
      duration: 1.05,
      // A long, soft decelerate — the curve that reads as "expensive".
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      // Touch devices keep their native momentum; emulating it feels worse than
      // the real thing and costs battery on the mid-range Androids this sells to.
      syncTouch: false,
    });

    lenis.on("scroll", ScrollTrigger.update);

    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    // GSAP throttles delta after a stall; that desyncs Lenis, so turn it off.
    gsap.ticker.lagSmoothing(0);

    // Fonts land after first paint and change every measurement ScrollTrigger
    // took. Without this, pinned sections end up pinned at the wrong offsets.
    const onFonts = () => ScrollTrigger.refresh();
    document.fonts?.ready.then(onFonts);

    return () => {
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      lenis.destroy();
      ScrollTrigger.getAll().forEach((t) => t.kill());
    };
  }, []);

  return <>{children}</>;
}

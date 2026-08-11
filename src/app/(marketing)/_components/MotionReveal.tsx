"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A 12px rise on entry.
 *
 * The served HTML is fully VISIBLE — the animation is armed by script after
 * mount, never before. Rendering opacity:0 on the server would hide seven of
 * the thirteen sections from anyone without JavaScript and from any crawler
 * that does not execute it, on a page whose whole job is to be found and read.
 *
 * Honours prefers-reduced-motion by never arming at all.
 */
export function MotionReveal({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = ref.current;
    if (!el) return;

    // Already on screen at mount? Leave it alone — animating content the reader
    // is currently looking at is a flash, not a reveal.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) return;

    setArmed(true);
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const hidden = armed && !shown;

  return (
    <div
      ref={ref}
      className="transition-all duration-500 motion-reduce:transition-none"
      style={{ opacity: hidden ? 0 : 1, transform: hidden ? "translateY(12px)" : "none" }}
    >
      {children}
    </div>
  );
}

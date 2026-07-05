"use client";
import { useEffect, useRef, useState } from "react";

export function CategoryNav({ categories }: { categories: { id: string; nameEn: string }[] }) {
  const [activeId, setActiveId] = useState(categories[0]?.id ?? "");
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (categories.length === 0) return;
    observerRef.current = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id.replace("category-", ""));
      },
      { rootMargin: "-120px 0px -70% 0px" },
    );
    const els = categories
      .map((c) => document.getElementById(`category-${c.id}`))
      .filter((el): el is HTMLElement => el !== null);
    els.forEach((el) => observerRef.current?.observe(el));
    return () => observerRef.current?.disconnect();
  }, [categories]);

  if (categories.length === 0) return null;

  return (
    <nav className="sticky top-0 z-10 flex gap-2 overflow-x-auto border-b border-border bg-background/90 px-4 py-3 backdrop-blur-sm sm:px-6 [&::-webkit-scrollbar]:hidden">
      {categories.map((c) => (
        <a
          key={c.id}
          href={`#category-${c.id}`}
          className={`eyebrow shrink-0 rounded-full px-4 py-2 transition-colors ${
            activeId === c.id
              ? "bg-primary text-primary-foreground"
              : "border border-border text-muted-foreground"
          }`}
        >
          {c.nameEn}
        </a>
      ))}
    </nav>
  );
}

"use client";
import { useEffect, useState } from "react";

export function CategoryNav({ categories }: { categories: { id: string; nameEn: string }[] }) {
  const [active, setActive] = useState(categories[0]?.id ?? "");

  useEffect(() => {
    if (categories.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id.replace("category-", ""));
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    categories.forEach((c) => { const el = document.getElementById(`category-${c.id}`); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, [categories]);

  if (categories.length === 0) return null;

  return (
    <nav className="sticky top-0 z-20 -mx-4 border-b border-border bg-background/85 px-4 backdrop-blur-md sm:-mx-6 sm:px-6">
      <div className="flex gap-2 overflow-x-auto py-3 [&::-webkit-scrollbar]:hidden">
        {categories.map((c) => (
          <a
            key={c.id}
            href={`#category-${c.id}`}
            onClick={(e) => { e.preventDefault(); document.getElementById(`category-${c.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${active === c.id ? "bg-ink text-background" : "bg-card text-ink"}`}
          >
            {c.nameEn}
          </a>
        ))}
      </div>
    </nav>
  );
}

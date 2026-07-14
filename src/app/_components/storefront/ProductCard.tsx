"use client";
import type { PublishedMenu } from "@/server/catalog/schema";
import { formatMoney } from "@/lib/money";
import { Badge } from "./Badge";

export type MenuProduct = PublishedMenu["categories"][number]["products"][number];

export function ProductCard({
  product, interactive, onOpen, currency, badge,
}: {
  product: MenuProduct;
  interactive: boolean;
  onOpen: () => void;
  currency: string;
  badge?: "popular" | "new" | null;
}) {
  return (
    <button
      type="button"
      onClick={interactive ? onOpen : undefined}
      disabled={!interactive}
      aria-label={interactive ? `Configure ${product.nameEn}` : product.nameEn}
      className="card-lift group flex flex-col overflow-hidden rounded-2xl bg-card text-left"
    >
      <div className="relative aspect-[4/3] w-full">
        {product.imageUrl
          ? <img src={product.imageUrl} alt="" loading="lazy" className="sf-img h-full w-full" />
          : <div className="sf-img h-full w-full" />}
        {badge && <span className="absolute left-2 top-2"><Badge kind={badge} /></span>}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-tight text-ink">{product.nameEn}</h3>
        <span dir="rtl" className="text-xs text-muted-foreground">{product.nameAr}</span>
        {product.descriptionEn && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{product.descriptionEn}</p>}
        <div className="mt-auto flex items-center justify-between pt-2.5">
          <span className="font-display font-bold text-ink">{formatMoney(product.effectivePrice, currency)}</span>
          {interactive && <span className="grid size-8 place-items-center rounded-full bg-primary text-lg leading-none text-primary-foreground shadow-sm">+</span>}
        </div>
      </div>
    </button>
  );
}

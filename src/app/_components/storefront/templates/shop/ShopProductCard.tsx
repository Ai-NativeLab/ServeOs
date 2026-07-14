"use client";
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";

/** Dense retail card: brand eyebrow, image, name, price (or "From X" with variants), stock state. */
export function ShopProductCard({
  product, interactive, onOpen, currency,
}: {
  product: MenuProduct;
  interactive: boolean;
  onOpen: () => void;
  currency: string;
}) {
  const inStock = product.inStock;
  const prices = product.variants.length > 0 ? product.variants.map((v) => v.price) : [product.effectivePrice];
  const min = Math.min(...prices);
  const hasRange = product.variants.length > 1 && new Set(prices).size > 1;

  return (
    <button
      type="button"
      onClick={interactive && inStock ? onOpen : undefined}
      disabled={!interactive || !inStock}
      aria-label={product.nameEn}
      className="card-lift group relative flex flex-col overflow-hidden rounded-2xl bg-card text-left"
    >
      <div className="relative aspect-square w-full">
        {product.imageUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={product.imageUrl} alt="" loading="lazy" className={`sf-img h-full w-full ${!inStock ? "opacity-40 grayscale" : ""}`} />
          : <div className="sf-img h-full w-full" />}
        {!inStock && (
          <span className="absolute left-2 top-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Out of stock
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3">
        {product.brand && <span className="eyebrow truncate text-[10px] text-muted-foreground">{product.brand}</span>}
        <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-tight text-ink">{product.nameEn}</h3>
        <span dir="rtl" className="text-xs text-muted-foreground">{product.nameAr}</span>
        <div className="mt-auto flex items-center justify-between pt-2.5">
          <span className="font-display font-bold text-ink">
            {hasRange ? `From ${formatMoney(min, currency)}` : formatMoney(min, currency)}
          </span>
          {interactive && inStock && (
            <span className="grid size-8 place-items-center rounded-full bg-primary text-lg leading-none text-primary-foreground shadow-sm">+</span>
          )}
        </div>
      </div>
    </button>
  );
}

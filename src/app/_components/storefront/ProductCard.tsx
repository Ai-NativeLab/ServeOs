"use client";
import type { PublishedMenu } from "@/server/catalog/schema";
import { arabicDescription } from "./bilingual";
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
  const inStock = product.inStock;

  return (
    <button
      type="button"
      onClick={interactive && inStock ? onOpen : undefined}
      disabled={!interactive || !inStock}
      aria-label={!inStock ? `${product.nameEn} (Out of stock)` : interactive ? `Configure ${product.nameEn}` : product.nameEn}
      className={`card-lift ${interactive && inStock ? "card-lift-hover" : ""} group flex flex-col overflow-hidden rounded-2xl bg-card text-left`}
    >
      <div className="relative aspect-[4/3] w-full">
        {product.imageUrl
          ? /* eslint-disable-next-line @next/next/no-img-element */
            <img src={product.imageUrl} alt="" loading="lazy" className={`sf-img h-full w-full ${!inStock ? "opacity-40 grayscale" : ""}`} />
          : <div className="sf-img h-full w-full" />}
        {!inStock ? (
          <span className="absolute left-2 top-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Out of stock
          </span>
        ) : badge ? (
          <span className="absolute left-2 top-2"><Badge kind={badge} /></span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-tight text-ink">{product.nameEn}</h3>
        <span dir="rtl" className="text-xs text-muted-foreground">{product.nameAr}</span>
        {/* Both languages, the same way the name above shows both. The Arabic
            description is stored, editable in the dashboard and carried in the
            published menu, but no storefront template rendered it — so an
            Arabic-first storefront showed its customers English prose under a
            bilingual product name. */}
        {product.descriptionEn && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{product.descriptionEn}</p>}
        {arabicDescription(product.descriptionEn, product.descriptionAr) && (
          <p dir="rtl" className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {arabicDescription(product.descriptionEn, product.descriptionAr)}
          </p>
        )}
        <div className="mt-auto flex items-center justify-between pt-2.5">
          <span className="font-display font-bold text-ink">{formatMoney(product.effectivePrice, currency)}</span>
          {interactive && inStock && (
            <span className="grid size-8 place-items-center rounded-full bg-primary text-lg leading-none text-primary-foreground shadow-sm">+</span>
          )}
        </div>
      </div>
    </button>
  );
}

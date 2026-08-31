"use client";
import type { PublishedMenu } from "@/server/catalog/schema";
import { arabicDescription } from "./bilingual";
import { formatMoney } from "@/lib/money";
import { Badge } from "./Badge";
import { isProductConfigurable } from "../cart";

export type MenuProduct = PublishedMenu["categories"][number]["products"][number];

export function ProductCard({
  product,
  interactive,
  onOpen,
  currency,
  badge,
  quantity = 0,
  onQuickAdd,
  onIncrement,
  onDecrement,
}: {
  product: MenuProduct;
  interactive: boolean;
  onOpen: () => void;
  currency: string;
  badge?: "popular" | "new" | null;
  quantity?: number;
  onQuickAdd?: () => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
}) {
  const configurable = isProductConfigurable(product);
  const inStock = product.inStock !== false;

  return (
    <div
      role="button"
      tabIndex={interactive && inStock ? 0 : -1}
      onClick={interactive && inStock ? onOpen : undefined}
      onKeyDown={(e) => {
        if (interactive && inStock && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={interactive ? `${configurable ? "Configure" : "View"} ${product.nameEn}` : product.nameEn}
      className={`card-lift card-lift-hover group flex flex-col overflow-hidden rounded-2xl bg-card text-left ${
        !interactive || !inStock ? "cursor-default" : "cursor-pointer"
      }`}
    >
      <div className="relative aspect-[4/3] w-full">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt=""
            loading="lazy"
            className={`sf-img h-full w-full ${!inStock ? "opacity-40 grayscale" : ""}`}
          />
        ) : (
          <div className="sf-img h-full w-full" />
        )}
        {product.hasDiscount && product.discountPercent ? (
          <span className="absolute left-2 top-2">
            <Badge kind="discount" label={`-${product.discountPercent}%`} />
          </span>
        ) : badge ? (
          <span className="absolute left-2 top-2">
            <Badge kind={badge} />
          </span>
        ) : null}
        {!inStock && (
          <span className="absolute left-2 top-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Out of stock
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-tight text-ink">{product.nameEn}</h3>
        <span dir="rtl" className="text-xs text-muted-foreground">{product.nameAr}</span>
        {product.descriptionEn && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{product.descriptionEn}</p>}
        {arabicDescription(product.descriptionEn, product.descriptionAr) && (
          <p dir="rtl" className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {arabicDescription(product.descriptionEn, product.descriptionAr)}
          </p>
        )}
        <div className="mt-auto flex items-center justify-between pt-2.5">
          <div className="flex items-baseline gap-1.5">
            <span className="font-display font-bold text-ink">{formatMoney(product.effectivePrice, currency)}</span>
            {product.hasDiscount && (
              <span className="text-xs text-muted-foreground line-through font-sans">
                {formatMoney(product.originalPrice, currency)}
              </span>
            )}
          </div>
          {interactive && inStock && (
            <div>
              {configurable || quantity === 0 ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (configurable) {
                      onOpen();
                    } else if (onQuickAdd) {
                      onQuickAdd();
                    }
                  }}
                  aria-label={configurable ? `Configure ${product.nameEn}` : `Add ${product.nameEn} to cart`}
                  className="grid size-8 place-items-center rounded-full bg-primary text-lg leading-none text-primary-foreground shadow-sm transition-transform active:scale-90"
                >
                  +
                </button>
              ) : (
                <div
                  className="flex items-center gap-1 rounded-full bg-primary/10 p-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDecrement?.();
                    }}
                    aria-label={`Decrease quantity of ${product.nameEn}`}
                    className="grid size-7 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground shadow-sm transition-transform active:scale-90"
                  >
                    −
                  </button>
                  <span className="min-w-[1.25rem] text-center font-display text-xs font-bold text-ink" aria-live="polite">
                    {quantity}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onIncrement?.();
                    }}
                    aria-label={`Increase quantity of ${product.nameEn}`}
                    className="grid size-7 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground shadow-sm transition-transform active:scale-90"
                  >
                    +
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


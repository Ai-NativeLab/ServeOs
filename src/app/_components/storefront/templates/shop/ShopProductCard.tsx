"use client";
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";
import { isProductConfigurable } from "@/app/_components/cart";
import { Badge } from "@/app/_components/storefront/Badge";

/** Dense retail card: brand eyebrow, image, name, price (or "From X" with variants), stock state. */
export function ShopProductCard({
  product,
  interactive,
  onOpen,
  currency,
  quantity = 0,
  onQuickAdd,
  onIncrement,
  onDecrement,
}: {
  product: MenuProduct;
  interactive: boolean;
  onOpen: () => void;
  currency: string;
  quantity?: number;
  onQuickAdd?: () => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
}) {
  const inStock = product.inStock;
  const prices = product.variants.length > 0 ? product.variants.map((v) => v.price) : [product.effectivePrice];
  const min = Math.min(...prices);
  const hasRange = product.variants.length > 1 && new Set(prices).size > 1;
  const configurable = isProductConfigurable(product);

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
      aria-label={product.nameEn}
      aria-disabled={!interactive || !inStock ? true : undefined}
      className={`card-lift group relative flex flex-col overflow-hidden rounded-2xl bg-card text-left ${
        !interactive || !inStock ? "cursor-default" : "cursor-pointer"
      }`}
    >
      <div className="relative aspect-square w-full">
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
        {product.hasDiscount && product.discountPercent && !hasRange && (
          <span className="absolute left-2 top-2">
            <Badge kind="discount" label={`-${product.discountPercent}%`} />
          </span>
        )}
        {!inStock && (
          <span className="absolute left-2 top-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Out of stock
          </span>
        )}
        {product.requiresPrescription && (
          <span className="absolute right-2 top-2 rounded-full bg-status-pending/20 px-2 py-0.5 text-[11px] font-medium text-status-pending-fg">
            Rx
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3">
        {product.brand && <span className="eyebrow truncate text-[10px] text-muted-foreground">{product.brand}</span>}
        <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-tight text-ink">{product.nameEn}</h3>
        <span dir="rtl" className="text-xs text-muted-foreground">{product.nameAr}</span>
        <div className="mt-auto flex items-center justify-between pt-2.5">
          <div className="flex items-baseline gap-1.5">
            <span className="font-display font-bold text-ink">
              {hasRange ? `From ${formatMoney(min, currency)}` : formatMoney(min, currency)}
            </span>
            {product.hasDiscount && !hasRange && (
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
                  aria-label={configurable ? "Select options" : "Quick add"}
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
                    aria-label="Decrease quantity"
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
                    aria-label="Increase quantity"
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


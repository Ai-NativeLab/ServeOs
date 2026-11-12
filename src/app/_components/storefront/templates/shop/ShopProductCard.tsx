"use client";
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";
import { isProductConfigurable } from "@/app/_components/cart";
import { QuickAddControl } from "@/app/_components/storefront/QuickAddControl";
import { Badge, discountLabel } from "@/app/_components/storefront/Badge";

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

  const clickable = interactive && inStock;
  // Variant prices are absolute and never discounted (the server charges
  // variant.price as-is), so a variant product shows no promotion at all —
  // same rule as RetailProductSheet's !needsVariant.
  const discount = product.variants.length === 0 ? discountLabel(product) : null;

  // Real <button> for the card body with the add/stepper controls BESIDE it,
  // so their Enter/Space never open the sheet. The button's ::after covers
  // the card so a mouse click anywhere else still opens the product.
  return (
    <div className="card-lift group relative flex flex-col overflow-hidden rounded-2xl bg-card text-start">
      <button
        type="button"
        onClick={clickable ? onOpen : undefined}
        disabled={!clickable}
        aria-label={product.nameEn}
        className="flex flex-1 flex-col text-start outline-none after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-primary disabled:cursor-default"
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
          {discount ? (
            <span className="absolute start-2 top-2">
              <Badge kind="discount" label={discount} />
            </span>
          ) : null}
          {!inStock && (
            <span className="absolute start-2 top-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Out of stock
            </span>
          )}
          {/* P3: a customer should know a script is needed BEFORE they get to
              checkout and hit the gate. */}
          {product.requiresPrescription && (
            <span className="absolute end-2 top-2 rounded-full bg-status-pending/20 px-2 py-0.5 text-[11px] font-medium text-status-pending-fg">
              Rx
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col px-3 pt-3">
          {product.brand && <span className="eyebrow truncate text-[10px] text-muted-foreground">{product.brand}</span>}
          <h3 className="line-clamp-2 font-sans text-sm font-semibold leading-tight text-ink">{product.nameEn}</h3>
          <span dir="rtl" className="text-xs text-muted-foreground">{product.nameAr}</span>
        </div>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3 pt-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-display font-bold text-ink">
            {hasRange ? `From ${formatMoney(min, currency)}` : formatMoney(min, currency)}
          </span>
          {discount && (
            <span className="text-xs text-muted-foreground line-through font-sans">
              {formatMoney(product.originalPrice, currency)}
            </span>
          )}
        </div>
        {clickable && (
          <div className="relative z-10">
            <QuickAddControl
              productName={product.nameEn}
              configurable={configurable}
              quantity={quantity}
              onOpen={onOpen}
              onQuickAdd={onQuickAdd}
              onIncrement={onIncrement}
              onDecrement={onDecrement}
            />
          </div>
        )}
      </div>
    </div>
  );
}

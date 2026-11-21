"use client";
import type { PublishedMenu } from "@/server/catalog/schema";
import { arabicDescription } from "./bilingual";
import { formatMoney } from "@/lib/money";
import { Badge, discountLabel } from "./Badge";
import { isProductConfigurable } from "../cart";
import { QuickAddControl } from "./QuickAddControl";

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

  const clickable = interactive && inStock;
  const discount = discountLabel(product);

  // The card body is a real <button> and the add/stepper controls sit beside
  // it (not inside it), so their Enter/Space never bubble into "open sheet".
  // The button's ::after stretches over the whole card so a mouse click
  // anywhere outside the controls still opens the product, as before.
  return (
    <div className={`card-lift ${clickable ? "card-lift-hover" : ""} group relative flex flex-col overflow-hidden rounded-2xl bg-card text-start`}>
      <button
        type="button"
        onClick={clickable ? onOpen : undefined}
        disabled={!clickable}
        aria-label={
          !inStock
            ? `${product.nameEn} (Out of stock)`
            : clickable
              ? `${configurable ? "Configure" : "View"} ${product.nameEn}`
              : product.nameEn
        }
        className="flex flex-1 flex-col text-start outline-none after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-primary disabled:cursor-default"
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
          {(badge || discount || !inStock) && (
            <span className="absolute start-2 top-2 flex flex-wrap gap-1">
              {discount ? (
                <Badge kind="discount" label={discount} />
              ) : badge ? (
                <Badge kind={badge} />
              ) : null}
              {!inStock && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  Out of stock
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col px-3 pt-3">
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
        </div>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3 pt-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-display font-bold text-ink">{formatMoney(product.effectivePrice, currency)}</span>
          {product.hasDiscount && (
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

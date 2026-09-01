"use client";
import { useState } from "react";
import { arabicDescription } from "../../bilingual";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";
import type { CartLine } from "@/app/_components/cart";
import { computeDimensionalQuantity } from "@/server/catalog/dimensional-pricing";
import { isDimensionalUom, requiredDimensions, type DimensionField } from "@/server/catalog/uom-values";

const DIMENSION_LABEL: Record<DimensionField, string> = {
  lengthMm: "Length", widthMm: "Width", thicknessMm: "Thickness",
};

export function RetailProductSheet({
  product, open, onOpenChange, onAdd, currency,
}: {
  product: MenuProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (product: MenuProduct, variantId: string | null, quantity: number, dimensions?: CartLine["dimensions"]) => void;
  currency: string;
}) {
  const [variantId, setVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  // P4: cut-list dimension inputs, keyed by field so unfilled ones stay
  // undefined rather than a stray "0" that would price a zero-size cut.
  const [dims, setDims] = useState<Record<DimensionField, string>>({ lengthMm: "", widthMm: "", thicknessMm: "" });
  // Reset the picker each time a (possibly re-opened) product becomes active.
  // Adjusted during render rather than in a useEffect, per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [resetKey, setResetKey] = useState<string | null>(null);
  if (product && product.id !== resetKey) {
    setResetKey(product.id);
    setVariantId(product.variants.find((v) => v.inStock)?.id ?? null);
    setQuantity(1);
    setDims({ lengthMm: "", widthMm: "", thicknessMm: "" });
  } else if (!product && resetKey !== null) {
    setResetKey(null);
  }

  if (!product) return null;

  const selected = product.variants.find((v) => v.id === variantId) ?? null;
  const needsVariant = product.variants.length > 0;

  // P4: a dimensional product is priced from customer-entered measurements,
  // never a fixed each-price or a variant. Narrowed once here so every use
  // below has DimensionalUom, not the full UnitOfMeasure superset.
  const dimensionalUom = product.unitOfMeasure && isDimensionalUom(product.unitOfMeasure) ? product.unitOfMeasure : null;
  const isDimensional = dimensionalUom !== null;
  const fields = dimensionalUom ? requiredDimensions(dimensionalUom) : [];
  const parsedDims = Object.fromEntries(
    fields.map((f) => [f, dims[f].trim() === "" ? undefined : Number(dims[f])]),
  ) as Record<DimensionField, number | undefined>;
  const dimsComplete = fields.every((f) => parsedDims[f] !== undefined && parsedDims[f]! > 0);

  let dimensionalUnitPrice: number | null = null;
  if (dimensionalUom && dimsComplete) {
    try {
      dimensionalUnitPrice = product.effectivePrice * computeDimensionalQuantity(dimensionalUom, parsedDims);
    } catch {
      dimensionalUnitPrice = null; // shouldn't happen once dimsComplete, but never show a bad number
    }
  }

  const unitPrice = isDimensional ? (dimensionalUnitPrice ?? 0) : selected ? selected.price : product.effectivePrice;
  const canAdd = isDimensional ? dimsComplete : !needsVariant || selected !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-0">
        {/* mt-4 clears the sheet's absolutely-positioned close button — see the
            fuller note in ProductSheet. */}
        {product.imageUrl && (
          <div className="relative mt-4 mb-4 aspect-[16/10] w-full flex-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={product.imageUrl} alt={product.nameEn} loading="lazy" width={800} height={500} className="sf-img h-full w-full" />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SheetHeader>
            {product.brand && <span className="eyebrow text-muted-foreground">{product.brand}</span>}
            <div className="flex items-start justify-between gap-2">
              <SheetTitle className="text-xl sm:text-2xl">{product.nameEn}</SheetTitle>
              {product.hasDiscount && product.discountPercent && !needsVariant && (
                <span className="sf-badge bg-destructive text-destructive-foreground font-bold shadow-sm shrink-0">
                  {`-${product.discountPercent}%`}
                </span>
              )}
            </div>
            {product.nameAr && (
              <span dir="rtl" className="block text-sm text-muted-foreground">{product.nameAr}</span>
            )}
            {!needsVariant && !isDimensional && (
              <div className="flex items-baseline gap-2 pt-1">
                <span className="font-display text-lg font-bold text-ink">{formatMoney(product.effectivePrice, currency)}</span>
                {product.hasDiscount && (
                  <span className="text-sm text-muted-foreground line-through font-sans">
                    {formatMoney(product.originalPrice, currency)}
                  </span>
                )}
              </div>
            )}
            {product.descriptionEn && <SheetDescription>{product.descriptionEn}</SheetDescription>}
            {arabicDescription(product.descriptionEn, product.descriptionAr) && (
              <SheetDescription dir="rtl">
                {arabicDescription(product.descriptionEn, product.descriptionAr)}
              </SheetDescription>
            )}
          </SheetHeader>

          {isDimensional && (
            <div className="mt-5">
              <span className="eyebrow text-ink">Cut size</span>
              <p className="mt-1 text-xs text-muted-foreground">
                Priced at {formatMoney(product.effectivePrice, currency)} per {product.unitOfMeasure}.
              </p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {fields.map((f) => (
                  <label key={f} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{DIMENSION_LABEL[f]} (mm)</span>
                    <input
                      type="number" min={1} inputMode="numeric" value={dims[f]}
                      onChange={(e) => setDims((d) => ({ ...d, [f]: e.target.value }))}
                      className="rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-ink outline-none focus:border-primary/60"
                    />
                  </label>
                ))}
              </div>
              {dimsComplete && dimensionalUnitPrice !== null && (
                <p className="mt-2 text-sm font-medium text-ink">
                  {formatMoney(dimensionalUnitPrice, currency)} per piece
                </p>
              )}
            </div>
          )}

          {needsVariant && (
            <div className="mt-5">
              <span className="eyebrow text-ink">Options</span>
              <div className="mt-2 flex flex-col gap-2">
                {product.variants.map((v) => {
                  const isSelected = variantId === v.id;
                  return (
                    <label
                      key={v.id}
                      className={`flex items-center justify-between rounded-xl border px-3.5 py-3 text-sm transition-colors ${
                        !v.inStock ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                      } ${isSelected ? "border-primary bg-accent/60" : "border-border bg-card hover:border-primary/40"}`}
                    >
                      <span className="flex items-center gap-2.5">
                        <input
                          type="radio"
                          name={`${product.id}-variant`}
                          checked={isSelected}
                          disabled={!v.inStock}
                          onChange={() => setVariantId(v.id)}
                          className="accent-primary"
                        />
                        <span className={isSelected ? "font-medium text-ink" : "text-ink"}>{v.nameEn}</span>
                      </span>
                      <span className={isSelected ? "font-medium text-primary" : "text-muted-foreground"}>
                        {v.inStock ? formatMoney(v.price, currency) : "Out of stock"}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="-mx-6 -mb-6 mt-5 flex flex-none items-center gap-3 border-t border-border bg-card px-6 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <div className="inline-flex items-center gap-1 rounded-full border border-border pl-1 pr-1">
            {/* size-11 (44px) hit area — was a bare glyph with no padding, well under the 44px tap-target minimum */}
            <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="grid size-11 place-items-center rounded-full text-lg leading-none text-ink transition-colors hover:text-primary" aria-label="Decrease quantity">−</button>
            <span className="w-4 text-center font-display font-semibold text-ink">{quantity}</span>
            <button type="button" onClick={() => setQuantity((q) => q + 1)} className="grid size-11 place-items-center rounded-full text-lg leading-none text-ink transition-colors hover:text-primary" aria-label="Increase quantity">+</button>
          </div>
          <Button
            disabled={!canAdd}
            onClick={() => {
              onAdd(product, variantId, quantity, isDimensional ? (parsedDims as CartLine["dimensions"]) : undefined);
              onOpenChange(false);
            }}
            className="flex-1 rounded-full"
          >
            Add — {formatMoney(unitPrice * quantity, currency)}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

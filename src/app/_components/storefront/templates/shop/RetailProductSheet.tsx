"use client";
import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";

export function RetailProductSheet({
  product, open, onOpenChange, onAdd, currency,
}: {
  product: MenuProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (product: MenuProduct, variantId: string | null, quantity: number) => void;
  currency: string;
}) {
  const [variantId, setVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  // Reset the picker each time a (possibly re-opened) product becomes active.
  // Adjusted during render rather than in a useEffect, per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [resetKey, setResetKey] = useState<string | null>(null);
  if (product && product.id !== resetKey) {
    setResetKey(product.id);
    setVariantId(product.variants.find((v) => v.inStock)?.id ?? null);
    setQuantity(1);
  } else if (!product && resetKey !== null) {
    setResetKey(null);
  }

  if (!product) return null;

  const selected = product.variants.find((v) => v.id === variantId) ?? null;
  const needsVariant = product.variants.length > 0;
  const unitPrice = selected ? selected.price : product.effectivePrice;
  const canAdd = !needsVariant || selected !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-0">
        {product.imageUrl && (
          <div className="relative mb-4 aspect-[16/10] w-full flex-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={product.imageUrl} alt={product.nameEn} loading="lazy" width={800} height={500} className="sf-img h-full w-full" />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SheetHeader>
            {product.brand && <span className="eyebrow text-muted-foreground">{product.brand}</span>}
            <SheetTitle className="text-xl sm:text-2xl">{product.nameEn}</SheetTitle>
            {product.descriptionEn && <SheetDescription>{product.descriptionEn}</SheetDescription>}
          </SheetHeader>

          {needsVariant && (
            <div className="mt-5">
              <span className="eyebrow text-ink">Options</span>
              <div className="mt-2 flex flex-col gap-2">
                {product.variants.map((v) => {
                  const isSelected = variantId === v.id;
                  return (
                    <label
                      key={v.id}
                      className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
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

        <div className="-mx-6 -mb-6 mt-5 flex flex-none items-center gap-3 border-t border-border bg-card px-6 py-4">
          <div className="inline-flex items-center gap-4 rounded-full border border-border px-4 py-2">
            <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="text-lg leading-none text-ink transition-colors hover:text-primary" aria-label="Decrease quantity">−</button>
            <span className="w-4 text-center font-display font-semibold text-ink">{quantity}</span>
            <button type="button" onClick={() => setQuantity((q) => q + 1)} className="text-lg leading-none text-ink transition-colors hover:text-primary" aria-label="Increase quantity">+</button>
          </div>
          <Button
            disabled={!canAdd}
            onClick={() => {
              onAdd(product, variantId, quantity);
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

"use client";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "./ProductCard";

export function ProductSheet({
  product, open, onOpenChange, onAdd, currency,
}: {
  product: MenuProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (product: MenuProduct, optionIds: string[], quantity: number) => void;
  currency: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (product) {
      setSelected(product.modifierGroups.flatMap((g) => g.options).filter((o) => o.isDefault).map((o) => o.id));
      setQuantity(1);
    }
  }, [product]);

  if (!product) return null;

  function toggle(gMax: number, groupOptionIds: string[], id: string) {
    setSelected((prev) => {
      const inGroup = prev.filter((x) => groupOptionIds.includes(x));
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (gMax === 1) return [...prev.filter((x) => !groupOptionIds.includes(x)), id];
      if (inGroup.length >= gMax) return prev;
      return [...prev, id];
    });
  }

  const deltas = product.modifierGroups
    .flatMap((g) => g.options)
    .filter((o) => selected.includes(o.id))
    .reduce((s, o) => s + Number(o.priceDelta), 0);
  const unitPrice = product.effectivePrice + deltas;
  const total = unitPrice * quantity;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-0">
        {product.imageUrl && (
          <div className="relative mb-4 aspect-[16/10] w-full flex-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={product.imageUrl}
              alt={product.nameEn}
              loading="lazy"
              width={800}
              height={500}
              className="sf-img h-full w-full"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-xl sm:text-2xl">{product.nameEn}</SheetTitle>
            {product.descriptionEn && <SheetDescription>{product.descriptionEn}</SheetDescription>}
          </SheetHeader>

          {product.modifierGroups.map((g) => {
            const ids = g.options.map((o) => o.id);
            return (
              <div key={g.id} className="mt-5">
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow text-ink">{g.nameEn}</span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {g.required ? "Required" : "Optional"}
                  </span>
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  {g.options.map((o) => {
                    const isSelected = selected.includes(o.id);
                    return (
                      <label
                        key={o.id}
                        className={`flex cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                          isSelected
                            ? "border-primary bg-accent/60"
                            : "border-border bg-card hover:border-primary/40"
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <input
                            type={g.maxSelections === 1 ? "radio" : "checkbox"}
                            name={`${product.id}-${g.id}`}
                            checked={isSelected}
                            onChange={() => toggle(g.maxSelections, ids, o.id)}
                            className="accent-primary"
                          />
                          <span className={isSelected ? "font-medium text-ink" : "text-ink"}>{o.nameEn}</span>
                        </span>
                        {Number(o.priceDelta) > 0 && (
                          <span className={isSelected ? "font-medium text-primary" : "text-muted-foreground"}>
                            +{formatMoney(Number(o.priceDelta), currency)}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="-mx-6 -mb-6 mt-5 flex flex-none items-center gap-3 border-t border-border bg-card px-6 py-4">
          <div className="inline-flex items-center gap-4 rounded-full border border-border px-4 py-2">
            <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="text-lg leading-none text-ink transition-colors hover:text-primary" aria-label="Decrease quantity">
              −
            </button>
            <span className="w-4 text-center font-display font-semibold text-ink">{quantity}</span>
            <button type="button" onClick={() => setQuantity((q) => q + 1)} className="text-lg leading-none text-ink transition-colors hover:text-primary" aria-label="Increase quantity">
              +
            </button>
          </div>
          <Button
            onClick={() => {
              onAdd(product, selected, quantity);
              onOpenChange(false);
            }}
            className="flex-1 rounded-full"
          >
            Add — {formatMoney(total, currency)}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

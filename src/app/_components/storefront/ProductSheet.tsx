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
      <SheetContent>
        {product.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.nameEn}
            className="-mx-6 -mt-6 mb-2 h-48 w-[calc(100%+3rem)] object-cover sm:rounded-t-2xl"
          />
        )}
        <SheetHeader>
          <SheetTitle>{product.nameEn}</SheetTitle>
          {product.descriptionEn && <SheetDescription>{product.descriptionEn}</SheetDescription>}
        </SheetHeader>

        {product.modifierGroups.map((g) => {
          const ids = g.options.map((o) => o.id);
          return (
            <div key={g.id} className="mt-2">
              <div className="eyebrow text-muted-foreground">
                {g.nameEn}
                {g.required ? " · required" : ""}
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {g.options.map((o) => (
                  <label key={o.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <input
                        type={g.maxSelections === 1 ? "radio" : "checkbox"}
                        name={`${product.id}-${g.id}`}
                        checked={selected.includes(o.id)}
                        onChange={() => toggle(g.maxSelections, ids, o.id)}
                      />
                      {o.nameEn}
                    </span>
                    {Number(o.priceDelta) > 0 && (
                      <span className="text-muted-foreground">+{formatMoney(Number(o.priceDelta), currency)}</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          );
        })}

        <div className="mt-4 flex items-center gap-3">
          <div className="inline-flex items-center gap-3 rounded-full border border-border px-3 py-1.5">
            <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="text-lg leading-none" aria-label="Decrease quantity">
              −
            </button>
            <span className="w-4 text-center">{quantity}</span>
            <button type="button" onClick={() => setQuantity((q) => q + 1)} className="text-lg leading-none" aria-label="Increase quantity">
              +
            </button>
          </div>
          <Button
            onClick={() => {
              onAdd(product, selected, quantity);
              onOpenChange(false);
            }}
            className="flex-1"
          >
            Add — {formatMoney(total, currency)}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

"use client";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatMoney } from "@/lib/money";
import { cartSubtotal, type Cart } from "../cart";

export function CartDrawer({
  cart, slug, currency, preorderOnly, open, onOpenChange, onSetQuantity,
}: {
  cart: Cart;
  slug: string;
  currency: string;
  preorderOnly: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSetQuantity: (index: number, quantity: number) => void;
}) {
  const subtotal = cartSubtotal(cart.lines);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Your cart</SheetTitle>
          </SheetHeader>

          {cart.lines.length === 0 && (
            <p className="mt-4 text-sm text-muted-foreground">Cart is empty.</p>
          )}

          <div className="mt-2 flex flex-col divide-y divide-border">
            {cart.lines.map((l, i) => (
              <div key={`${l.productId}-${l.selectedOptionIds.join(".")}`} className="flex items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <div className="truncate font-sans font-semibold text-ink">{l.nameEn}</div>
                  {l.modifierSummaryEn && (
                    <div className="truncate text-xs text-muted-foreground">{l.modifierSummaryEn}</div>
                  )}
                  <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-border">
                    {/* size-11 (44px) hit area — was a bare glyph with no padding, well under the 44px tap-target minimum */}
                    <button type="button" onClick={() => onSetQuantity(i, l.quantity - 1)} className="grid size-11 place-items-center rounded-full text-base leading-none text-ink transition-colors hover:text-primary" aria-label={`Decrease ${l.nameEn}`}>−</button>
                    <span className="w-4 text-center text-sm font-medium text-ink">{l.quantity}</span>
                    <button type="button" onClick={() => onSetQuantity(i, l.quantity + 1)} className="grid size-11 place-items-center rounded-full text-base leading-none text-ink transition-colors hover:text-primary" aria-label={`Increase ${l.nameEn}`}>+</button>
                  </div>
                </div>
                <div className="shrink-0 text-right font-display font-bold text-ink">
                  {formatMoney(l.unitPrice * l.quantity, currency)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="-mx-6 -mb-6 mt-4 flex-none border-t border-border bg-card px-6 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <div className="flex justify-between font-display font-bold text-ink">
            <span>Subtotal</span>
            <span>{formatMoney(subtotal, currency)}</span>
          </div>

          {preorderOnly && cart.lines.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              The restaurant is closed right now — you'll pick a time at checkout.
            </p>
          )}

          {cart.lines.length > 0 && (
            <a
              href={`/checkout?slug=${encodeURIComponent(slug)}${cart.branchId ? `&branch=${cart.branchId}` : ""}`}
              className="card-lift mt-4 block rounded-full bg-primary p-3.5 text-center font-sans font-semibold text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.98]"
            >
              Checkout →
            </a>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

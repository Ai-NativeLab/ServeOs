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
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Your cart</SheetTitle>
        </SheetHeader>

        {cart.lines.length === 0 && (
          <p className="mt-4 text-sm text-muted-foreground">Cart is empty.</p>
        )}

        {cart.lines.map((l, i) => (
          <div key={`${l.productId}-${l.selectedOptionIds.join(".")}`} className="flex items-center justify-between gap-3 border-b border-border py-3">
            <div className="min-w-0">
              <div className="truncate font-sans font-semibold text-ink">{l.nameEn}</div>
              {l.modifierSummaryEn && (
                <div className="truncate text-xs text-muted-foreground">{l.modifierSummaryEn}</div>
              )}
              <div className="mt-1.5 inline-flex items-center gap-3 rounded-full border border-border px-2.5 py-1">
                <button type="button" onClick={() => onSetQuantity(i, l.quantity - 1)} className="text-base leading-none" aria-label={`Decrease ${l.nameEn}`}>−</button>
                <span className="w-4 text-center text-sm">{l.quantity}</span>
                <button type="button" onClick={() => onSetQuantity(i, l.quantity + 1)} className="text-base leading-none" aria-label={`Increase ${l.nameEn}`}>+</button>
              </div>
            </div>
            <div className="shrink-0 text-right font-display font-bold text-ink">
              {formatMoney(l.unitPrice * l.quantity, currency)}
            </div>
          </div>
        ))}

        <div className="mt-4 flex justify-between font-display font-bold text-ink">
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
            className="mt-4 block rounded-full bg-primary p-3 text-center font-sans font-semibold text-primary-foreground"
          >
            Checkout →
          </a>
        )}
      </SheetContent>
    </Sheet>
  );
}

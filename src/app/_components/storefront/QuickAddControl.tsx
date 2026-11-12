"use client";
import { useEffect, useRef } from "react";

/**
 * The card's add affordance. A configurable product gets one "+" that opens
 * its sheet; a simple product gets quick-add, which turns into an inline
 * `− qty +` stepper once it is in the cart.
 *
 * Rendered BESIDE the card's main button, never inside it, so Enter/Space on
 * these controls never reach the card (and there is no nested-interactive
 * role). Every control is 40px (size-10) to meet the 40px touch-target AC.
 */
export function QuickAddControl({
  productName,
  configurable,
  quantity,
  onOpen,
  onQuickAdd,
  onIncrement,
  onDecrement,
}: {
  productName: string;
  configurable: boolean;
  quantity: number;
  onOpen: () => void;
  onQuickAdd?: () => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
}) {
  const addRef = useRef<HTMLButtonElement>(null);
  const incRef = useRef<HTMLButtonElement>(null);
  // Which control should take focus after the add button and the stepper
  // swap places. The control that had focus unmounts, so without this a
  // keyboard user is dropped back to <body>.
  const pendingFocus = useRef<"stepper" | "add" | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (!target) return;
    // Only reclaim focus that was actually lost; never steal it from
    // something the user moved to (e.g. a branch-pick sheet).
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (target === "stepper" ? incRef : addRef).current?.focus();
  }, [quantity]);

  const button =
    "grid size-10 shrink-0 place-items-center rounded-full bg-primary leading-none text-primary-foreground shadow-sm transition-transform active:scale-90";

  if (configurable || quantity === 0) {
    return (
      <button
        ref={addRef}
        type="button"
        onClick={() => {
          if (configurable) {
            onOpen();
          } else {
            pendingFocus.current = "stepper";
            onQuickAdd?.();
          }
        }}
        aria-label={configurable ? `Select options for ${productName}` : `Add ${productName} to cart`}
        className={`${button} text-lg`}
      >
        +
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 rounded-full bg-primary/10 p-0.5">
      <button
        type="button"
        onClick={() => {
          if (quantity <= 1) pendingFocus.current = "add";
          onDecrement?.();
        }}
        aria-label={`Decrease quantity of ${productName}`}
        className={`${button} text-sm font-bold`}
      >
        −
      </button>
      <span className="min-w-[1.25rem] text-center font-display text-xs font-bold text-ink">{quantity}</span>
      <button
        ref={incRef}
        type="button"
        onClick={() => onIncrement?.()}
        aria-label={`Increase quantity of ${productName}`}
        className={`${button} text-sm font-bold`}
      >
        +
      </button>
    </div>
  );
}

/** One persistent polite live region per storefront, so quantity changes from
 * card controls are announced ("Cola: 2 in cart") without each card mounting
 * its own region. */
export function CartAnnouncer({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

export function quantityAnnouncement(name: string, quantity: number): string {
  return quantity > 0 ? `${name}: ${quantity} in cart` : `${name} removed from cart`;
}

"use client";
import { formatMoney } from "@/lib/money";

export function CartBar({ count, subtotal, onOpen, currency }: { count: number; subtotal: number; onOpen: () => void; currency: string }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="fixed inset-x-4 bottom-4 z-20 flex items-center justify-between rounded-full bg-primary px-5 py-3.5 text-primary-foreground shadow-lg transition-transform active:scale-[0.98] sm:inset-x-auto sm:left-auto sm:right-6 sm:w-80"
    >
      <span className="font-medium">
        View cart · {count} item{count > 1 ? "s" : ""}
      </span>
      <span className="font-display font-bold">{formatMoney(subtotal, currency)} →</span>
    </button>
  );
}

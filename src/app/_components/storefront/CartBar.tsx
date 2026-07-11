"use client";
import { formatMoney } from "@/lib/money";

export function CartBar({ count, subtotal, onOpen, currency }: { count: number; subtotal: number; onOpen: () => void; currency: string }) {
  if (count === 0) return null;
  return (
    <div className="fixed inset-x-4 bottom-0 z-20 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:inset-x-auto sm:left-auto sm:right-6 sm:w-80">
      <button
        type="button"
        onClick={onOpen}
        className="card-lift flex w-full items-center justify-between rounded-full bg-primary px-5 py-3.5 text-primary-foreground transition-transform active:scale-[0.98]"
      >
        <span className="font-sans font-semibold">
          View cart · {count} item{count > 1 ? "s" : ""}
        </span>
        <span className="font-display font-bold">{formatMoney(subtotal, currency)} →</span>
      </button>
    </div>
  );
}

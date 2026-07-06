import type { CartLine } from "../order/cart";

export type ReceiptData = {
  orderNumber: string;
  lines: CartLine[];
  total: number;
  timestamp: string;
};

export function Receipt({ data, onPrint, onNewOrder }: { data: ReceiptData; onPrint: () => void; onNewOrder: () => void }) {
  return (
    <div className="min-h-screen grid place-items-center bg-background px-4 py-6">
      <div className="w-full max-w-sm">
        <div id="receipt" className="rounded-2xl border border-border bg-card p-6 text-ink font-mono text-sm">
          <div className="text-center">
            <h1 className="text-base font-bold tracking-wider">SERVEOS POS</h1>
            <p className="text-xs text-muted-foreground mt-1">Walk-in · Pickup</p>
          </div>
          <div className="my-3 border-t border-dashed border-border" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{new Date(data.timestamp).toLocaleString()}</span>
            <span>Order #{data.orderNumber}</span>
          </div>
          <div className="my-3 border-t border-dashed border-border" />
          <ul className="flex flex-col gap-1.5">
            {data.lines.map((l, i) => (
              <li key={i} className="flex justify-between">
                <span className="truncate pr-2">
                  {l.quantity}× {l.name}
                </span>
                <span>{(l.unitPrice * l.quantity).toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <div className="my-3 border-t border-dashed border-border" />
          <div className="flex justify-between font-bold">
            <span>TOTAL</span>
            <span>{data.total.toFixed(2)}</span>
          </div>
          <div className="mt-3 text-center font-bold tracking-wider">PAID — CASH</div>
          <div className="mt-4 text-center text-xs text-muted-foreground">Thank you!</div>
        </div>

        <div className="no-print mt-4 flex gap-2">
          <button
            onClick={onPrint}
            className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground"
          >
            Print
          </button>
          <button
            onClick={onNewOrder}
            className="flex-1 rounded-xl border border-border bg-card px-4 py-3 font-semibold text-ink"
          >
            New order
          </button>
        </div>
      </div>
    </div>
  );
}

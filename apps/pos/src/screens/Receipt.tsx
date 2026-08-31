import type { SaleFiscalStatus } from "../../electron/preload";
import type { CartLine } from "../order/cart";

/** What the footer renders of a sale's ETA e-receipt — the server's payload
 *  minus `qrPayload`, which is the QR's INPUT and never printed itself. */
export type ReceiptFiscal = Pick<SaleFiscalStatus, "status" | "etaUuid" | "qrImageDataUrl">;

/**
 * The ETA block at the foot of a receipt. Renders nothing at all without a
 * `fiscal` value — the ordinary case for every non-EG tenant, and the country
 * gate's no-behavioural-change guarantee: their receipt is byte-identical to
 * the one this screen printed before ETA existed.
 *
 * THE QR PRINTS AS SOON AS IT EXISTS — at `pending`, not only at `accepted`.
 * ETA e-receipts are post-clearance: the uuid is self-computed and the QR
 * payload written at sale time, while the verdict lands minutes to hours later.
 * The copy handed to the customer must already carry the code, so gating the
 * image on `accepted` would print blank receipts all day and only ever show the
 * QR on a reprint. `rejected` keeps the code visible too and adds a note beside
 * it: the sale stands, and the correction is a dashboard action, not something
 * the cashier can act on with the customer at the counter.
 */
export function ReceiptFiscalFooter({ fiscal }: { fiscal?: ReceiptFiscal | null }) {
  if (!fiscal) return null;
  return (
    <div className="mt-4 border-t border-dashed border-border pt-3 text-center">
      {fiscal.qrImageDataUrl ? (
        <img src={fiscal.qrImageDataUrl} alt="ETA receipt QR" className="mx-auto h-28 w-28" />
      ) : (
        // The row exists but has not been finalized yet — rare, and it resolves
        // on its own; the customer copy simply says so rather than lying.
        <p className="text-[10px] text-muted-foreground">Fiscal receipt pending</p>
      )}
      {fiscal.etaUuid && (
        <p className="mt-1 text-[10px] break-all text-muted-foreground">ETA UUID: {fiscal.etaUuid}</p>
      )}
      {fiscal.status === "rejected" && (
        <p className="mt-1 text-[10px] text-status-danger-fg">Fiscal receipt rejected — correction pending</p>
      )}
    </div>
  );
}

export type ReceiptTender = { method: string; amount: number };
export type ReceiptData = {
  orderNumber: string;
  lines: CartLine[];
  subtotal: number;
  discountAmount: number;
  serviceChargeAmount: number;
  vatAmount: number;
  total: number;
  tenders: ReceiptTender[];
  changeAmount: number;
  cashierName: string;
  timestamp: string;
  /** False when the server has not confirmed this sale yet — `orderNumber` is
   *  then the till's own short code (SaleReceipt.clientOrderId derived), not a
   *  real order number, so the receipt says so instead of implying it's final. */
  synced: boolean;
};

/**
 * `fiscal` is a prop rather than a field of `ReceiptData` on purpose: the
 * receipt data is a snapshot of the sale, settled the moment it was rung, while
 * the fiscal block arrives afterwards and changes under it. Keeping it separate
 * also keeps this render a pure function of its inputs — the poll lives in the
 * screen that owns the receipt (see `../fiscal/sale-fiscal`), never here.
 */
export function Receipt({
  data,
  fiscal,
  onPrint,
  onNewOrder,
}: {
  data: ReceiptData;
  fiscal?: ReceiptFiscal | null;
  onPrint: () => void;
  onNewOrder: () => void;
}) {
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
          {!data.synced && (
            <p className="mt-1 text-center text-xs uppercase tracking-wider text-status-pending-fg">
              Pending sync — order number is provisional
            </p>
          )}
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
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>{data.subtotal.toFixed(2)}</span>
            </div>
            {data.discountAmount > 0 && (
              <div className="flex justify-between">
                <span>Discount</span>
                <span>−{data.discountAmount.toFixed(2)}</span>
              </div>
            )}
            {data.serviceChargeAmount > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Service charge</span>
                <span>{data.serviceChargeAmount.toFixed(2)}</span>
              </div>
            )}
            {data.vatAmount > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>VAT</span>
                <span>{data.vatAmount.toFixed(2)}</span>
              </div>
            )}
          </div>
          <div className="my-3 border-t border-dashed border-border" />
          <div className="flex justify-between font-bold">
            <span>TOTAL</span>
            <span>{data.total.toFixed(2)}</span>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {data.tenders.map((t, i) => (
              <div key={i} className="flex justify-between uppercase tracking-wider">
                <span>PAID — {t.method}</span>
                <span>{t.amount.toFixed(2)}</span>
              </div>
            ))}
            {data.changeAmount > 0 && (
              <div className="flex justify-between font-bold uppercase tracking-wider">
                <span>CHANGE</span>
                <span>{data.changeAmount.toFixed(2)}</span>
              </div>
            )}
          </div>
          <div className="mt-4 text-center text-xs text-muted-foreground">Cashier: {data.cashierName}</div>
          <div className="mt-1 text-center text-xs text-muted-foreground">Thank you!</div>
          {/* Inside #receipt so the print stylesheet's `#receipt *` rule keeps
              the QR visible on the customer copy. */}
          <ReceiptFiscalFooter fiscal={fiscal} />
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

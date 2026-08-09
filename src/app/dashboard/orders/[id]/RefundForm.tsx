"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { toastMessageFor } from "@/lib/errors-client";
import { Button } from "@/components/ui/button";
import { issueRefundAction } from "./refund-actions";

const REASON_CODES = ["staff_meal", "comp_service", "promo", "manager_discretion", "wrong_item", "customer_changed_mind", "other"] as const;
const reasonLabel = (code: string) => code.replace(/_/g, " ");
const round2 = (n: number) => Math.round(n * 100) / 100;
const newRefundId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type FormItem = { id: string; nameEn: string; quantity: number; lineTotal: string };
type RefundLine = { orderItemId: string; quantity: number; amount: number; restock: boolean };
type RefundTender = { method: "cash" | "card" | "store_credit" | "other"; amount: number; reference?: string };

const inputCls =
  "rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export function RefundForm({
  orderId, items, priorLineQtys, netPaidRemaining,
}: {
  orderId: string;
  items: FormItem[];
  priorLineQtys: { orderItemId: string; quantity: number }[];
  netPaidRemaining: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<"full" | "partial">("full");
  const [lines, setLines] = useState<RefundLine[]>(() =>
    items
      .filter((it) => {
        const returned = priorLineQtys
          .filter((l) => l.orderItemId === it.id)
          .reduce((s, l) => s + l.quantity, 0);
        return it.quantity - returned > 0;
      })
      .map((it) => ({ orderItemId: it.id, quantity: 1, amount: Number(it.lineTotal), restock: false })),
  );
  const [payments, setPayments] = useState<RefundTender[]>(() => [{ method: "cash", amount: netPaidRemaining > 0 ? netPaidRemaining : 0 }]);
  const [reasonCode, setReasonCode] = useState<(typeof REASON_CODES)[number]>("customer_changed_mind");
  const [reasonText, setReasonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per composer session: a submit retry (network blip) is a
  // replay, so the server returns the already-committed refund instead of
  // producing a second one. A fresh open of the form mints a new key.
  const [clientRefundId] = useState(newRefundId);

  const lineTotal = round2(lines.filter((l) => l.quantity > 0 && l.amount > 0).reduce((s, l) => s + l.amount, 0));
  const payTotal = round2(payments.filter((p) => p.amount > 0).reduce((s, p) => s + p.amount, 0));

  function submit() {
    const lineEntries = kind === "partial" ? lines.filter((l) => l.quantity > 0 && l.amount > 0) : [];
    const payEntries = payments.filter((p) => p.amount > 0);
    setError(null);
    if (!payEntries.length) { setError("Add at least one refund payment"); return; }
    if (kind === "partial" && !lineEntries.length) { setError("Pick at least one line to return"); return; }
    if (kind === "partial" && Math.abs(lineTotal - payTotal) > 0.005) {
      setError("Refund line amounts must equal the refund payments");
      return;
    }
    if (payTotal > netPaidRemaining + 0.005) {
      setError("Refund exceeds the amount still refundable");
      return;
    }

    startTransition(async () => {
      try {
        await issueRefundAction({
          orderId,
          kind,
          lines: lineEntries,
          payments: payEntries,
          reasonCode,
          reasonText: reasonText.trim() || undefined,
          clientRefundId,
        });
        toast.success("Refund issued");
        router.refresh();
      } catch (err) {
        toast.error(toastMessageFor(err));
      }
    });
  }

  return (
    <div className="rounded-xl border bg-card p-5">
      <h2 className="eyebrow text-primary mb-3">Refund this order</h2>

      <div className="flex gap-2">
        {(["full", "partial"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium capitalize ${kind === k ? "border-primary bg-accent text-ink" : "border-border text-muted-foreground"}`}
          >
            {k}
          </button>
        ))}
      </div>

      {kind === "partial" && (
        <div className="mt-3 space-y-1.5">
          {lines.map((l, i) => {
            const item = items.find((it) => it.id === l.orderItemId);
            const returned = priorLineQtys
              .filter((p) => p.orderItemId === l.orderItemId)
              .reduce((s, p) => s + p.quantity, 0);
            const max = item ? item.quantity - returned : 1;
            return (
              <div key={l.orderItemId} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{item?.nameEn ?? l.orderItemId}</span>
                <input
                  type="number" min={1} max={max} value={l.quantity}
                  onChange={(e) => {
                    const q = Math.max(1, Math.min(max, Number(e.target.value) || 1));
                    setLines(lines.map((x, j) => (j === i ? { ...x, quantity: q } : x)));
                  }}
                  className={`${inputCls} w-16 text-right`}
                  aria-label={`Quantity for ${item?.nameEn ?? "item"}`}
                />
                <input
                  type="number" min={0} step="0.01" value={l.amount}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) || 0 } : x)))}
                  className={`${inputCls} w-24 text-right`}
                  aria-label={`Refund amount for ${item?.nameEn ?? "item"}`}
                />
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={l.restock}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, restock: e.target.checked } : x)))}
                  />
                  Restock
                </label>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {payments.map((p, i) => (
          <div key={i} className="flex items-center gap-2 text-sm">
            <select
              value={p.method}
              onChange={(e) => setPayments(payments.map((x, j) => (j === i ? { ...x, method: e.target.value as RefundTender["method"] } : x)))}
              className={inputCls}
            >
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="store_credit">Store credit</option>
              <option value="other">Other</option>
            </select>
            <input
              type="number" min={0} step="0.01" value={p.amount}
              onChange={(e) => setPayments(payments.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) || 0 } : x)))}
              className={`${inputCls} w-28 text-right`}
              aria-label="Refund payment amount"
            />
            <button
              onClick={() => setPayments(payments.filter((_, j) => j !== i))}
              disabled={payments.length <= 1}
              className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-30"
            >
              Remove
            </button>
          </div>
        ))}
        <button onClick={() => setPayments([...payments, { method: "cash", amount: 0 }])} className="text-xs font-medium text-primary">
          + Add payment
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-1.5 text-sm">
        <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as (typeof REASON_CODES)[number])} className={inputCls}>
          {REASON_CODES.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
        </select>
        <input
          type="text"
          value={reasonText}
          onChange={(e) => setReasonText(e.target.value)}
          placeholder="Note (optional)"
          className={inputCls}
        />
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Refunding {payTotal.toFixed(2)} of {netPaidRemaining.toFixed(2)} still refundable
        {kind === "partial" && lineTotal !== payTotal && <span className="text-status-pending-fg"> · line total {lineTotal.toFixed(2)}</span>}
      </p>

      {error && <p role="alert" className="mt-2 text-sm text-status-danger-fg">{error}</p>}

      <Button onClick={submit} disabled={pending} className="mt-3 w-full" variant="destructive">
        {pending ? "Refunding…" : "Confirm refund"}
      </Button>
    </div>
  );
}

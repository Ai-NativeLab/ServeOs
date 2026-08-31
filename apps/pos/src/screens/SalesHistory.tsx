import { useCallback, useEffect, useRef, useState } from "react";
import type { RefundSaleInput, ReprintReceipt, SaleDetail, SaleFiscalStatus, SalesRow } from "../../electron/preload";
import { fetchSaleFiscal } from "../fiscal/sale-fiscal";
import { ReceiptFiscalFooter } from "./Receipt";
import { ManagerAuthModal } from "./ManagerAuthModal";

const REASON_CODES = ["staff_meal", "comp_service", "promo", "manager_discretion", "wrong_item", "customer_changed_mind", "other"] as const;
const reasonLabel = (code: string) => code.replace(/_/g, " ");
const round2 = (n: number) => Math.round(n * 100) / 100;
const newRefundId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type RefundLineEntry = { orderItemId: string; quantity: number; amount: number; restock: boolean };
type RefundTenderEntry = { method: "cash" | "card" | "store_credit" | "other"; amount: number; reference?: string };
type PendingGrant = { permission: string; action: string; onGranted: (grant: string) => void };

function PaymentBadge({ status }: { status: string }) {
  const cls =
    status === "paid" || status === "partially_paid"
      ? "bg-status-ready/10 text-status-ready-fg"
      : status === "refunded"
        ? "bg-status-danger/10 text-status-danger-fg"
        : "bg-status-pending/10 text-status-pending-fg";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function tendersTotal(sale: SaleDetail) {
  return sale.tenders.reduce((s, t) => s + Number(t.amount), 0);
}

function refundsTotal(sale: SaleDetail) {
  return sale.refunds.reduce((s, r) => s + r.payments.reduce((x, p) => x + Number(p.amount), 0), 0);
}

function returnedQty(sale: SaleDetail, itemId: string) {
  return sale.refunds.reduce(
    (s, r) => s + r.lines.filter((l) => l.orderItemId === itemId).reduce((x, l) => x + l.quantity, 0),
    0,
  );
}

/** Search, refunds and reprints are all server-backed (they read/write the
 *  authoritative Order rows, not till-local state) — Task 11 disables the
 *  whole tab with a notice rather than let each action fail individually. */
export function SalesHistory({ offline }: { offline: boolean }) {
  const [search, setSearch] = useState({ from: "", to: "", cashier: "", orderNumber: "", phone: "", amount: "" });
  const [rows, setRows] = useState<SalesRow[]>([]);
  const [selected, setSelected] = useState<SaleDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [refundOpen, setRefundOpen] = useState(false);
  const [kind, setKind] = useState<"full" | "partial">("full");
  const [lines, setLines] = useState<RefundLineEntry[]>([]);
  const [payments, setPayments] = useState<RefundTenderEntry[]>([{ method: "cash", amount: 0 }]);
  const [reasonCode, setReasonCode] = useState<string>("customer_changed_mind");
  const [reasonText, setReasonText] = useState("");
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [pendingGrant, setPendingGrant] = useState<PendingGrant | null>(null);
  // One idempotency key per composed refund: minted at open, reused across
  // submit retries (incl. a NEEDS_MANAGER grant round-trip), so a retry is a
  // replay — the server returns the committed refund instead of doubling it.
  const [clientRefundId, setClientRefundId] = useState("");

  const [reprint, setReprint] = useState<ReprintReceipt | null>(null);
  // The reprinted sale's STORED fiscal identity. Read once when the slip opens
  // — a reprint is a read, never a resubmission, and there is nothing to wait
  // for: whatever the row holds now is what the original receipt carried.
  const [reprintFiscal, setReprintFiscal] = useState<SaleFiscalStatus | null>(null);
  const [busySale, setBusySale] = useState<string | null>(null);

  const searchRef = useRef(search);
  useEffect(() => { searchRef.current = search; }, [search]);

  const runSearch = useCallback(async () => {
    const s = searchRef.current;
    setLoading(true);
    setError(null);
    try {
      const results = await window.pos.listSales({
        from: s.from || undefined,
        to: s.to || undefined,
        cashier: s.cashier || undefined,
        orderNumber: s.orderNumber ? Number(s.orderNumber) : undefined,
        phone: s.phone || undefined,
        amount: s.amount ? Number(s.amount) : undefined,
      });
      setRows(results);
    } catch {
      setError("Could not load sales history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (offline) return;
    // Fetch on mount; setState happens after the async fetch, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runSearch();
  }, [runSearch, offline]);

  async function openSale(id: string) {
    setBusySale(id);
    setError(null);
    try {
      setSelected(await window.pos.getSale(id));
    } catch {
      setError("Could not load the sale");
    } finally {
      setBusySale(null);
    }
  }

  async function doReprint(sale: SaleDetail) {
    setBusySale(sale.id);
    setError(null);
    setReprintFiscal(null);
    try {
      setReprint(await window.pos.reprintReceipt(sale.id));
    } catch {
      setError("Could not reprint the receipt");
      return;
    } finally {
      setBusySale(null);
    }
    // Off the critical path on purpose: the slip is already on screen and
    // printable, the read swallows its own failures, and a footer that never
    // arrives costs the QR — never the reprint.
    setReprintFiscal(await fetchSaleFiscal(sale.id));
  }

  function openRefund(sale: SaleDetail) {
    const remaining = sale.items
      .map((it) => ({ item: it, remainingQty: it.quantity - returnedQty(sale, it.id) }))
      .filter((r) => r.remainingQty > 0);
    setKind("full");
    setLines(
      remaining.map((r) => ({
        orderItemId: r.item.id,
        quantity: Math.min(1, r.remainingQty),
        amount: Number(r.item.lineTotal),
        restock: false,
      })),
    );
    const netPaid = round2(tendersTotal(sale) - refundsTotal(sale));
    setPayments([{ method: "cash", amount: netPaid > 0 ? netPaid : 0 }]);
    setReasonCode("customer_changed_mind");
    setReasonText("");
    setRefundError(null);
    setClientRefundId(newRefundId());
    setRefundOpen(true);
  }

  async function submitRefund(extra?: { grantToken: string }) {
    if (!selected) return;
    const lineEntries = kind === "partial" ? lines.filter((l) => l.quantity > 0 && l.amount > 0) : [];
    const payEntries = payments.filter((p) => p.amount > 0);
    if (!payEntries.length) { setRefundError("Add at least one refund payment"); return; }
    if (kind === "partial" && !lineEntries.length) { setRefundError("Pick at least one line to return"); return; }
    const lineTotal = round2(lineEntries.reduce((s, l) => s + l.amount, 0));
    const payTotal = round2(payEntries.reduce((s, p) => s + p.amount, 0));
    const netPaid = round2(tendersTotal(selected) - refundsTotal(selected));
    if (kind === "partial" && Math.abs(lineTotal - payTotal) > 0.005) {
      setRefundError("Refund line amounts must equal the refund payments");
      return;
    }
    if (payTotal > netPaid + 0.005) {
      setRefundError("Refund exceeds the amount still refundable");
      return;
    }

    const input: RefundSaleInput = {
      orderId: selected.id,
      kind,
      lines: lineEntries,
      payments: payEntries,
      reasonCode,
      reasonText: reasonText.trim() || undefined,
      clientRefundId,
      grantToken: extra?.grantToken,
    };

    setRefundBusy(true);
    setRefundError(null);
    try {
      await window.pos.refundSale(input);
      setRefundOpen(false);
      await openSale(selected.id);
      await runSearch();
    } catch (e) {
      if (e instanceof Error && (e as Error & { code?: string }).code === "NEEDS_MANAGER") {
        setPendingGrant({
          permission: "pos:refund",
          action: "Refund requires manager approval",
          onGranted: (grant) => void submitRefund({ grantToken: grant }),
        });
      } else {
        setRefundError(e instanceof Error ? e.message : "Refund failed");
      }
    } finally {
      setRefundBusy(false);
    }
  }

  const netPaid = selected ? round2(tendersTotal(selected) - refundsTotal(selected)) : 0;

  if (offline) {
    return (
      <div className="grid place-items-center gap-1 py-20 text-center text-sm text-muted-foreground">
        <p className="font-medium text-ink">History, refunds and reprints are unavailable offline</p>
        <p>These read and write the server&apos;s own sale records — they will work again once the till reconnects.</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* Search + results */}
        <section className="rounded-xl border border-border bg-card p-3">
          <h2 className="eyebrow text-primary mb-2">Find a sale</h2>
          <div className="space-y-2 text-sm">
            <div className="flex gap-2">
              <label className="flex-1">
                <span className="text-xs text-muted-foreground">From</span>
                <input type="date" value={search.from} onChange={(e) => setSearch({ ...search, from: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
              </label>
              <label className="flex-1">
                <span className="text-xs text-muted-foreground">To</span>
                <input type="date" value={search.to} onChange={(e) => setSearch({ ...search, to: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-muted-foreground">Order number</span>
              <input type="number" inputMode="numeric" value={search.orderNumber}
                onChange={(e) => setSearch({ ...search, orderNumber: e.target.value })}
                placeholder="e.g. 1042"
                className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Customer phone</span>
              <input type="text" inputMode="tel" value={search.phone}
                onChange={(e) => setSearch({ ...search, phone: e.target.value })}
                placeholder="e.g. 01012345678"
                className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
            </label>
            <div className="flex gap-2">
              <label className="flex-1">
                <span className="text-xs text-muted-foreground">Amount</span>
                <input type="number" inputMode="decimal" step="0.01" value={search.amount}
                  onChange={(e) => setSearch({ ...search, amount: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
              </label>
              <label className="flex-1">
                <span className="text-xs text-muted-foreground">Cashier ID</span>
                <input type="text" value={search.cashier}
                  onChange={(e) => setSearch({ ...search, cashier: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
              </label>
            </div>
            <button onClick={() => void runSearch()} disabled={loading}
              className="w-full rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {loading ? "Searching…" : "Search"}
            </button>
          </div>

          <div className="mt-3 border-t border-border pt-3 space-y-1.5 max-h-[55vh] overflow-y-auto">
            {rows.length === 0 && !loading && (
              <p className="py-6 text-center text-sm text-muted-foreground">No sales found.</p>
            )}
            {rows.map((r) => (
              <button key={r.id} onClick={() => void openSale(r.id)} disabled={busySale !== null}
                className={`w-full rounded-lg border p-2.5 text-left text-sm transition-colors ${selected?.id === r.id ? "border-primary bg-accent" : "border-border bg-background hover:bg-secondary"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-bold text-ink">#{r.orderNumber}</span>
                  <PaymentBadge status={r.paymentStatus} />
                </div>
                <div className="mt-0.5 truncate text-muted-foreground">{r.customerName} · {r.customerPhone}</div>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{new Date(r.placedAt).toLocaleString()}</span>
                  <span className="font-mono text-ink">{Number(r.total).toFixed(2)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Detail */}
        <section className="rounded-xl border border-border bg-card p-4">
          {!selected ? (
            <p className="grid place-items-center py-20 text-sm text-muted-foreground">
              Select a sale to see its items, payments and refunds.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-display text-lg font-bold text-ink">#{selected.orderNumber}</h2>
                    <PaymentBadge status={selected.paymentStatus} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {selected.customerName} · {selected.customerPhone} · {new Date(selected.placedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => void doReprint(selected)} disabled={busySale === selected.id}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-50">
                    Reprint
                  </button>
                  <button onClick={() => openRefund(selected)}
                    className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-semibold text-primary-foreground">
                    Refund
                  </button>
                </div>
              </div>

              <div>
                <h3 className="eyebrow text-primary mb-1.5">Items</h3>
                <ul className="space-y-1 text-sm">
                  {selected.items.map((it) => (
                    <li key={it.id} className="flex justify-between gap-2">
                      <span className="text-ink">
                        {it.quantity}× {it.nameEn}
                        {(it.selectedModifiers as { optionNameEn?: string }[])
                          .map((m) => m.optionNameEn).filter(Boolean).join(", ")}
                      </span>
                      <span className="font-mono text-muted-foreground">{Number(it.lineTotal).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex justify-between border-t border-border pt-1.5 text-sm">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-mono font-bold text-ink">{Number(selected.total).toFixed(2)}</span>
                </div>
              </div>

              {selected.tenders.length > 0 && (
                <div>
                  <h3 className="eyebrow text-primary mb-1.5">Payments</h3>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {selected.tenders.map((t) => (
                      <li key={t.id} className="flex justify-between gap-2">
                        <span className="uppercase">{t.method}{t.tipAmount && Number(t.tipAmount) > 0 ? ` + tip ${Number(t.tipAmount).toFixed(2)}` : ""}</span>
                        <span className="font-mono">{Number(t.amount).toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">Net paid (still refundable): {netPaid.toFixed(2)}</p>
                </div>
              )}

              {selected.adjustments.length > 0 && (
                <div>
                  <h3 className="eyebrow text-primary mb-1.5">Adjustments</h3>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {selected.adjustments.map((a) => (
                      <li key={a.id} className="flex justify-between gap-2">
                        <span className="lowercase">{a.type.replace(/_/g, " ")} · {reasonLabel(a.reasonCode)}</span>
                        <span className="font-mono">{Number(a.amount).toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selected.refunds.length > 0 && (
                <div>
                  <h3 className="eyebrow text-primary mb-1.5">Refunds</h3>
                  <div className="space-y-2">
                    {selected.refunds.map((r) => (
                      <div key={r.id} className="rounded-lg border border-border bg-background p-2.5 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium capitalize text-ink">{r.kind} refund · {reasonLabel(r.reasonCode)}</span>
                          <span className="font-mono font-bold text-status-danger-fg">−{Number(r.totalAmount).toFixed(2)}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}{r.authorizedByUserId ? " · manager-approved" : ""}</p>
                        {r.lines.length > 0 && (
                          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                            {r.lines.map((l) => (
                              <li key={l.id}>{l.quantity}× {selected.items.find((i) => i.id === l.orderItemId)?.nameEn ?? l.orderItemId}{l.restock ? " · restocked" : ""}</li>
                            ))}
                          </ul>
                        )}
                        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          {r.payments.map((p) => (
                            <li key={p.id} className="flex justify-between gap-2"><span className="uppercase">{p.method}</span><span className="font-mono">{Number(p.amount).toFixed(2)}</span></li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-status-danger-fg">{error}</p>}

      {/* Refund composer */}
      {refundOpen && selected && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => !refundBusy && setRefundOpen(false)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-ink">Refund #{selected.orderNumber}</h3>
            <p className="text-sm text-muted-foreground">Still refundable: {netPaid.toFixed(2)}</p>

            <div className="mt-3 flex gap-2">
              {(["full", "partial"] as const).map((k) => (
                <button key={k} onClick={() => setKind(k)}
                  className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium capitalize ${kind === k ? "border-primary bg-accent text-ink" : "border-border text-muted-foreground"}`}>
                  {k}
                </button>
              ))}
            </div>

            {kind === "full" && (
              <p className="mt-2 text-sm text-muted-foreground">Return the rest of the net-paid amount to the customer.</p>
            )}

            {kind === "partial" && (
              <div className="mt-3">
                <h4 className="eyebrow text-primary mb-1.5">Lines to return</h4>
                <div className="space-y-1.5">
                  {lines.map((l, i) => {
                    const item = selected.items.find((it) => it.id === l.orderItemId);
                    const max = item ? item.quantity - returnedQty(selected, item.id) : 1;
                    return (
                      <div key={l.orderItemId} className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{item?.nameEn ?? l.orderItemId}</span>
                        <input type="number" min={1} max={max} value={l.quantity}
                          onChange={(e) => {
                            const q = Math.max(1, Math.min(max, Number(e.target.value) || 1));
                            setLines(lines.map((x, j) => j === i ? { ...x, quantity: q } : x));
                          }}
                          className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-right text-sm" />
                        <input type="number" min={0} step="0.01" value={l.amount}
                          onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) || 0 } : x))}
                          className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-right text-sm" />
                        <label className="flex items-center gap-1 text-xs text-muted-foreground">
                          <input type="checkbox" checked={l.restock}
                            onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, restock: e.target.checked } : x))} />
                          Restock
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-3">
              <h4 className="eyebrow text-primary mb-1.5">Refund tenders</h4>
              <div className="space-y-1.5">
                {payments.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <select value={p.method}
                      onChange={(e) => setPayments(payments.map((x, j) => j === i ? { ...x, method: e.target.value as RefundTenderEntry["method"] } : x))}
                      className="rounded-lg border border-border bg-background px-2 py-1 text-sm">
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="store_credit">Store credit</option>
                      <option value="other">Other</option>
                    </select>
                    <input type="number" min={0} step="0.01" value={p.amount}
                      onChange={(e) => setPayments(payments.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) || 0 } : x))}
                      className="w-28 rounded-lg border border-border bg-background px-2 py-1 text-right text-sm" />
                    <button onClick={() => setPayments(payments.filter((_, j) => j !== i))}
                      disabled={payments.length <= 1}
                      className="text-xs text-muted-foreground hover:text-status-danger-fg disabled:opacity-30">Remove</button>
                  </div>
                ))}
              </div>
              <button onClick={() => setPayments([...payments, { method: "cash", amount: 0 }])}
                className="mt-1.5 text-xs font-medium text-primary">+ Add payment</button>
            </div>

            <div className="mt-3">
              <h4 className="eyebrow text-primary mb-1.5">Reason</h4>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm">
                {REASON_CODES.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
              </select>
              <input type="text" value={reasonText} onChange={(e) => setReasonText(e.target.value)}
                placeholder="Note (optional)"
                className="mt-1.5 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
            </div>

            {refundError && <p role="alert" className="mt-2 text-sm text-status-danger-fg">{refundError}</p>}

            <div className="mt-4 flex gap-2">
              <button onClick={() => void submitRefund()} disabled={refundBusy}
                className="flex-1 rounded-xl bg-destructive px-4 py-2.5 font-semibold text-primary-foreground disabled:opacity-50">
                {refundBusy ? "Refunding…" : "Confirm refund"}
              </button>
              <button onClick={() => setRefundOpen(false)} disabled={refundBusy}
                className="flex-1 rounded-xl border border-border px-4 py-2.5 font-semibold text-ink disabled:opacity-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manager authorization for a gated refund */}
      {pendingGrant && (
        <ManagerAuthModal
          permission={pendingGrant.permission}
          action={pendingGrant.action}
          onGranted={(grant) => {
            pendingGrant.onGranted(grant);
            setPendingGrant(null);
          }}
          onCancel={() => setPendingGrant(null)}
        />
      )}

      {/* Reprint modal */}
      {reprint && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setReprint(null)}>
          <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div id="receipt" className="rounded-2xl border border-border bg-card p-6 text-ink font-mono text-sm">
              <div className="text-center">
                <h1 className="text-base font-bold tracking-wider">SERVEOS POS</h1>
                <p className="mt-1 text-xs text-muted-foreground">Sales receipt · reprint</p>
              </div>
              <div className="my-3 border-t border-dashed border-border" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{new Date(reprint.sale.placedAt).toLocaleString()}</span>
                <span>Order #{reprint.sale.orderNumber}</span>
              </div>
              <div className="my-3 border-t border-dashed border-border" />
              <ul className="flex flex-col gap-1.5">
                {reprint.sale.items.map((l, i) => (
                  <li key={i} className="flex justify-between">
                    <span className="truncate pr-2">{l.quantity}× {l.nameEn}</span>
                    <span>{Number(l.lineTotal).toFixed(2)}</span>
                  </li>
                ))}
              </ul>
              <div className="my-3 border-t border-dashed border-border" />
              <div className="flex flex-col gap-1">
                {reprint.sale.tenders.map((t, i) => (
                  <div key={i} className="flex justify-between uppercase tracking-wider">
                    <span>PAID — {t.method}</span>
                    <span>{Number(t.amount).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="my-3 border-t border-dashed border-border" />
              <div className="flex justify-between font-bold">
                <span>TOTAL</span>
                <span>{Number(reprint.sale.total).toFixed(2)}</span>
              </div>
              {reprint.refundSlips.length > 0 && (
                <>
                  <div className="my-3 border-t border-dashed border-border" />
                  {reprint.refundSlips.map((slip, i) => (
                    <div key={i} className="mb-2">
                      <div className="flex justify-between font-bold uppercase tracking-wider text-status-danger-fg">
                        <span>REFUND — {slip.kind}</span>
                        <span>−{Number(slip.totalAmount).toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{reasonLabel(slip.reasonCode)}</span>
                        <span>{new Date(slip.createdAt).toLocaleString()}</span>
                      </div>
                      {slip.payments.map((p, j) => (
                        <div key={j} className="flex justify-between text-xs uppercase">
                          <span>{p.method}</span>
                          <span>{Number(p.amount).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              )}
              <div className="mt-4 text-center text-xs text-muted-foreground">{reprint.sale.customerName}</div>
              <div className="mt-1 text-center text-xs text-muted-foreground">Thank you!</div>
              <ReceiptFiscalFooter fiscal={reprintFiscal} />
            </div>

            <div className="no-print mt-4 flex gap-2">
              <button onClick={() => window.print()}
                className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground">
                Print
              </button>
              <button onClick={() => setReprint(null)}
                className="flex-1 rounded-xl border border-border bg-card px-4 py-3 font-semibold text-ink">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

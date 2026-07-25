import { useEffect, useMemo, useState } from "react";
import type { CheckoutPricing } from "@shared/order-totals";
import {
  listCategories,
  optionDeltaSum,
  parseMenu,
  type Menu,
  type MenuProduct,
} from "../order/menu";
import {
  addLine,
  cartTotals,
  changeQty,
  discountLine,
  removeLine,
  type CartLine,
} from "../order/cart";
import { Receipt, type ReceiptData } from "./Receipt";
import { PaymentScreen, changeFor, type TenderDraft } from "./PaymentScreen";
import { ManagerAuthModal } from "./ManagerAuthModal";

type Cashier = { name: string; permissions: string[] };
type PendingAuth = { permission: string; action: string; onGranted: () => void };
type RecalledDraft = { lines: CartLine[]; orderDiscount: number };

const REASON_CODES = [
  "staff_meal", "comp_service", "promo", "manager_discretion",
  "wrong_item", "customer_changed_mind", "other",
] as const;

const reasonLabel = (code: string) => code.replace(/_/g, " ");

export function OrderScreen({
  branchName,
  cashier,
  recalled,
  onCartConsumed,
}: {
  branchName: string;
  cashier: Cashier;
  recalled?: RecalledDraft | null;
  onCartConsumed?: () => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [pricing, setPricing] = useState<CheckoutPricing | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [sheetProduct, setSheetProduct] = useState<MenuProduct | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetSelected, setSheetSelected] = useState<string[]>([]);
  const [sheetQty, setSheetQty] = useState(1);

  const [cart, setCart] = useState<CartLine[]>(() => recalled?.lines ?? []);
  const [cartError, setCartError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  const [view, setView] = useState<"cart" | "payment">("cart");
  const [saleId, setSaleId] = useState<string | null>(null);

  const [orderDiscount, setOrderDiscount] = useState(() => recalled?.orderDiscount ?? 0);
  const [orderDiscountReason, setOrderDiscountReason] = useState<string>("promo");
  const [orderDiscountEntry, setOrderDiscountEntry] = useState("");

  const [discountGrant, setDiscountGrant] = useState<string | null>(null);
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);

  const [discountingIdx, setDiscountingIdx] = useState<number | null>(null);
  const [lineDiscountEntry, setLineDiscountEntry] = useState("");
  const [lineDiscountReason, setLineDiscountReason] = useState<string>("promo");

  const [parkLabel, setParkLabel] = useState("");

  async function reloadMenu() {
    try {
      const res = await window.pos.getMenu();
      if (!res) {
        setLoadError("No menu cached. Connect to sync.");
        return;
      }
      const m = parseMenu(res.json);
      setMenu(m);
      setPricing(res.pricing);
      setSyncedAt(res.syncedAt);
      if (m.categories.length > 0 && !activeCat) setActiveCat(m.categories[0].id);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load menu");
    }
  }

  useEffect(() => {
    window.pos
      .getMenu()
      .then((res) => {
        if (!res) {
          setLoadError("No menu cached. Connect to sync.");
          return;
        }
        const m = parseMenu(res.json);
        setMenu(m);
        setPricing(res.pricing);
        setSyncedAt(res.syncedAt);
        if (m.categories.length > 0) setActiveCat(m.categories[0].id);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load menu"));
  }, []);

  const categories = useMemo(() => (menu ? listCategories(menu) : []), [menu]);
  const totals = useMemo(
    () => (pricing ? cartTotals(pricing, cart, orderDiscount) : null),
    [pricing, cart, orderDiscount],
  );

  const canDiscount = cashier.permissions.includes("pos:discount") || discountGrant !== null;

  /** Runs `apply` if the cashier may discount; otherwise gets a manager grant first. */
  function gateDiscount(apply: () => void) {
    if (canDiscount) {
      apply();
      return;
    }
    setPendingAuth({
      permission: "pos:discount",
      action: "Apply a discount to this sale",
      onGranted: apply,
    });
  }

  function openProduct(p: MenuProduct) {
    if (p.modifierGroups.length === 0) {
      const unitPrice = p.effectivePrice;
      setCart((c) => addLine(c, { productId: p.id, name: p.nameEn, quantity: 1, selectedOptionIds: [], unitPrice }));
      return;
    }
    setSheetProduct(p);
    setSheetSelected(p.modifierGroups.flatMap((g) => g.options).filter((o) => o.isDefault).map((o) => o.id));
    setSheetQty(1);
    setSheetOpen(true);
  }

  function toggleOption(groupId: string, maxSel: number, groupOptionIds: string[], id: string) {
    setSheetSelected((prev) => {
      const inGroup = prev.filter((x) => groupOptionIds.includes(x));
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (maxSel === 1) return [...prev.filter((x) => !groupOptionIds.includes(x)), id];
      if (inGroup.length >= maxSel) return prev;
      return [...prev, id];
    });
  }

  function addFromSheet() {
    if (!sheetProduct) return;
    const p = sheetProduct;
    for (const g of p.modifierGroups) {
      if (g.required) {
        const sel = sheetSelected.filter((id) => g.options.some((o) => o.id === id));
        if (sel.length < g.minSelections) {
          setCartError(`Select at least ${g.minSelections} for ${g.nameEn}`);
          return;
        }
      }
    }
    const unitPrice = p.effectivePrice + optionDeltaSum(p, sheetSelected);
    setCart((c) =>
      addLine(c, { productId: p.id, name: p.nameEn, quantity: sheetQty, selectedOptionIds: [...sheetSelected], unitPrice }),
    );
    setSheetOpen(false);
    setSheetProduct(null);
    setCartError(null);
  }

  function applyLineDiscount() {
    if (discountingIdx === null) return;
    const idx = discountingIdx;
    const amount = Math.max(0, Number(lineDiscountEntry || 0));
    const reason = lineDiscountReason;
    gateDiscount(() => {
      setCart((c) => discountLine(c, idx, amount, reason));
      setDiscountingIdx(null);
      setLineDiscountEntry("");
    });
  }

  function applyOrderDiscount() {
    const amount = Math.max(0, Number(orderDiscountEntry || 0));
    gateDiscount(() => {
      setOrderDiscount(amount);
      setOrderDiscountEntry("");
    });
  }

  function resetSale() {
    setCart([]);
    setOrderDiscount(0);
    setOrderDiscountEntry("");
    setDiscountGrant(null);
    setDiscountingIdx(null);
    setParkLabel("");
    setCartError(null);
    // Once the cart is cleared, a recalled draft has been consumed — tell App to
    // drop it so a later remount does not re-seed a ticket that is already done.
    onCartConsumed?.();
  }

  async function park() {
    if (cart.length === 0) return;
    try {
      await window.pos.holdTicket(parkLabel.trim() || "Ticket", { lines: cart, orderDiscount });
      resetSale();
    } catch (e) {
      setCartError(e instanceof Error ? e.message : "Could not park the ticket");
    }
  }

  function startPayment() {
    if (cart.length === 0 || !totals) return;
    setSaleId(crypto.randomUUID());
    setCartError(null);
    setView("payment");
  }

  async function completeSale(tenders: TenderDraft[]) {
    if (!totals || !saleId) return;
    try {
      const receiptData = await window.pos.recordSale({
        lines: cart.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          selectedOptionIds: l.selectedOptionIds,
          discountAmount: l.discountAmount,
          discountReason: l.discountReason,
        })),
        orderDiscountAmount: orderDiscount || undefined,
        orderDiscountReason: orderDiscount ? orderDiscountReason : undefined,
        expectedTotal: totals.total,
        payments: tenders.map((t, i) => ({ ...t, clientPaymentId: `${saleId}-${i}` })),
        grants: discountGrant ? [{ permission: "pos:discount", token: discountGrant }] : undefined,
      });
      const change = Math.round(tenders.reduce((s, t) => s + changeFor(t), 0) * 100) / 100;
      setReceipt({
        orderNumber: receiptData.orderNumber,
        lines: [...cart],
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        serviceChargeAmount: totals.serviceChargeAmount,
        vatAmount: totals.vatAmount,
        total: totals.total,
        tenders: tenders.map((t) => ({ method: t.method, amount: t.amount })),
        changeAmount: change,
        cashierName: cashier.name,
        timestamp: new Date().toISOString(),
      });
      resetSale();
      setView("cart");
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "TOTAL_MISMATCH") {
        await reloadMenu();
        setView("cart");
        setCartError("Prices have changed — please review the cart and charge again.");
        return;
      }
      throw err;
    }
  }

  if (receipt) {
    return (
      <Receipt
        data={receipt}
        onPrint={() => window.print()}
        onNewOrder={() => { setReceipt(null); setCartError(null); }}
      />
    );
  }

  if (view === "payment" && totals) {
    return (
      <PaymentScreen
        total={totals.total}
        cashierName={cashier.name}
        onCancel={() => setView("cart")}
        onComplete={completeSale}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div>
          <h1 className="text-lg font-bold text-ink">{branchName}</h1>
          {syncedAt && (
            <p className="text-xs text-muted-foreground">Menu synced {new Date(syncedAt).toLocaleString()}</p>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: catalog */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {loadError && <p className="px-4 py-3 text-sm text-status-danger-fg">{loadError}</p>}
          {categories.length > 0 && (
            <nav className="flex gap-1 overflow-x-auto border-b border-border bg-card px-2 py-2">
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveCat(c.id)}
                  className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition ${
                    activeCat === c.id ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
                  }`}
                >
                  {c.nameEn}
                </button>
              ))}
            </nav>
          )}
          <div className="flex-1 overflow-y-auto p-3">
            {!menu && !loadError && <p className="text-sm text-muted-foreground">Loading menu…</p>}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {categories
                .filter((c) => !activeCat || c.id === activeCat)
                .flatMap((c) => c.products)
                .map((p) => (
                  <button
                    key={p.id}
                    onClick={() => openProduct(p)}
                    className="flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition hover:shadow-sm"
                  >
                    <div className="aspect-[4/3] w-full bg-secondary">
                      {p.imageUrl ? (
                        <img src={p.imageUrl} alt={p.nameEn} className="h-full w-full object-cover" />
                      ) : null}
                    </div>
                    <div className="flex flex-1 flex-col p-2.5">
                      <span className="text-sm font-semibold text-ink line-clamp-2">{p.nameEn}</span>
                      <span className="mt-1 text-sm font-medium text-primary">
                        {p.effectivePrice.toFixed(2)}
                      </span>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        </div>

        {/* Right: cart */}
        <aside className="flex w-80 flex-col gap-3 border-l border-border bg-card p-3 overflow-y-auto">
          <h2 className="text-sm font-semibold text-ink">Current order</h2>
          {cart.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tap products to add.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {cart.map((l, i) => (
                <li key={i} className="rounded-lg border border-border bg-background p-2 text-sm">
                  <div className="flex justify-between">
                    <span className="font-medium text-ink">{l.name}</span>
                    <button
                      onClick={() => setCart((c) => removeLine(c, i))}
                      className="text-muted-foreground hover:text-status-danger-fg"
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="inline-flex items-center gap-2 rounded-full border border-border px-2 py-0.5">
                      <button onClick={() => setCart((c) => changeQty(c, i, l.quantity - 1))} aria-label="Decrease">−</button>
                      <span className="w-5 text-center">{l.quantity}</span>
                      <button onClick={() => setCart((c) => changeQty(c, i, l.quantity + 1))} aria-label="Increase">+</button>
                    </div>
                    <span className="font-medium text-ink">{(l.unitPrice * l.quantity).toFixed(2)}</span>
                  </div>
                  {l.discountAmount ? (
                    <div className="mt-1 flex justify-between text-xs text-primary">
                      <span>Discount · {reasonLabel(l.discountReason ?? "")}</span>
                      <span>−{l.discountAmount.toFixed(2)}</span>
                    </div>
                  ) : null}
                  {discountingIdx === i ? (
                    <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-dashed border-border p-2">
                      <input
                        inputMode="decimal"
                        value={lineDiscountEntry}
                        onChange={(e) => setLineDiscountEntry(e.target.value.replace(/[^0-9.]/g, ""))}
                        placeholder="Discount amount"
                        aria-label="Line discount amount"
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-right tabular-nums"
                      />
                      <select
                        value={lineDiscountReason}
                        onChange={(e) => setLineDiscountReason(e.target.value)}
                        aria-label="Line discount reason"
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 capitalize"
                      >
                        {REASON_CODES.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
                      </select>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => { setDiscountingIdx(null); setLineDiscountEntry(""); }}
                          className="flex-1 rounded-md border border-border px-2 py-1.5 text-xs font-medium text-ink"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={applyLineDiscount}
                          className="flex-1 rounded-md bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground"
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setDiscountingIdx(i); setLineDiscountEntry(""); }}
                      className="mt-1 text-xs font-medium text-muted-foreground hover:text-primary"
                    >
                      Discount
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {cart.length > 0 && totals && (
            <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span className="tabular-nums">{totals.subtotal.toFixed(2)}</span>
              </div>
              {totals.discountAmount > 0 && (
                <div className="flex justify-between text-primary">
                  <span>Discount</span>
                  <span className="tabular-nums">−{totals.discountAmount.toFixed(2)}</span>
                </div>
              )}
              {totals.serviceChargeAmount > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Service charge</span>
                  <span className="tabular-nums">{totals.serviceChargeAmount.toFixed(2)}</span>
                </div>
              )}
              {totals.vatAmount > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>VAT</span>
                  <span className="tabular-nums">{totals.vatAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="mt-1 flex justify-between border-t border-border pt-1 font-bold text-ink">
                <span>Total</span>
                <span className="tabular-nums">{totals.total.toFixed(2)}</span>
              </div>
            </div>
          )}

          {cart.length > 0 && (
            <div className="flex items-center gap-1.5">
              <input
                inputMode="decimal"
                value={orderDiscountEntry}
                onChange={(e) => setOrderDiscountEntry(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="Order discount"
                aria-label="Order discount amount"
                className="w-24 rounded-lg border border-border bg-background px-2 py-1.5 text-right text-sm tabular-nums"
              />
              <select
                value={orderDiscountReason}
                onChange={(e) => setOrderDiscountReason(e.target.value)}
                aria-label="Order discount reason"
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm capitalize"
              >
                {REASON_CODES.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
              </select>
              <button
                onClick={applyOrderDiscount}
                disabled={!orderDiscountEntry}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          )}

          {cartError && <p role="alert" className="text-sm text-status-danger-fg">{cartError}</p>}

          {cart.length > 0 && (
            <div className="flex items-center gap-1.5">
              <input
                value={parkLabel}
                onChange={(e) => setParkLabel(e.target.value)}
                placeholder="Label (e.g. Table 4)"
                aria-label="Park ticket label"
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
              />
              <button
                onClick={park}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-ink"
              >
                Park
              </button>
            </div>
          )}

          <button
            onClick={startPayment}
            disabled={cart.length === 0 || !totals}
            className="rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
          >
            Charge
          </button>
        </aside>
      </div>

      {/* Manager authorization for a gated discount */}
      {pendingAuth && (
        <ManagerAuthModal
          permission={pendingAuth.permission}
          action={pendingAuth.action}
          onGranted={(grant) => {
            setDiscountGrant(grant);
            pendingAuth.onGranted();
            setPendingAuth(null);
          }}
          onCancel={() => setPendingAuth(null)}
        />
      )}

      {/* Modifier sheet */}
      {sheetOpen && sheetProduct && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setSheetOpen(false)}>
          <div
            className="w-full max-w-md rounded-t-2xl bg-card p-4 shadow-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-ink">{sheetProduct.nameEn}</h3>
                {sheetProduct.descriptionEn && (
                  <p className="text-sm text-muted-foreground">{sheetProduct.descriptionEn}</p>
                )}
              </div>
              <button onClick={() => setSheetOpen(false)} className="text-muted-foreground" aria-label="Close">✕</button>
            </div>

            {sheetProduct.modifierGroups.map((g) => {
              const ids = g.options.map((o) => o.id);
              return (
                <div key={g.id} className="mt-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {g.nameEn}
                    {g.required ? " · required" : ""}
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {g.options.map((o) => (
                      <label
                        key={o.id}
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type={g.maxSelections === 1 ? "radio" : "checkbox"}
                            name={`${sheetProduct.id}-${g.id}`}
                            checked={sheetSelected.includes(o.id)}
                            onChange={() => toggleOption(g.id, g.maxSelections, ids, o.id)}
                          />
                          {o.nameEn}
                        </span>
                        {Number(o.priceDelta) > 0 && (
                          <span className="text-muted-foreground">+{Number(o.priceDelta).toFixed(2)}</span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}

            <div className="mt-5 flex items-center gap-3">
              <div className="inline-flex items-center gap-3 rounded-full border border-border px-3 py-1.5">
                <button onClick={() => setSheetQty((q) => Math.max(1, q - 1))} aria-label="Decrease quantity">−</button>
                <span className="w-5 text-center">{sheetQty}</span>
                <button onClick={() => setSheetQty((q) => q + 1)} aria-label="Increase quantity">+</button>
              </div>
              <button
                onClick={addFromSheet}
                className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground"
              >
                Add
              </button>
            </div>
            {cartError && <p className="mt-2 text-sm text-status-danger-fg">{cartError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

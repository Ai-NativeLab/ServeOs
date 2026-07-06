import { useEffect, useMemo, useState } from "react";
import {
  findProduct,
  listCategories,
  optionDeltaSum,
  parseMenu,
  type Menu,
  type MenuProduct,
} from "../order/menu";
import { addLine, cartTotal, changeQty, removeLine, type CartLine } from "../order/cart";
import { Receipt, type ReceiptData } from "./Receipt";
import { TicketsPanel } from "./TicketsPanel";

export function OrderScreen({ branchName }: { branchName: string }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [sheetProduct, setSheetProduct] = useState<MenuProduct | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetSelected, setSheetSelected] = useState<string[]>([]);
  const [sheetQty, setSheetQty] = useState(1);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [ticketsKey, setTicketsKey] = useState(0);

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
        setSyncedAt(res.syncedAt);
        if (m.categories.length > 0) setActiveCat(m.categories[0].id);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load menu"));
  }, []);

  const categories = useMemo(() => (menu ? listCategories(menu) : []), [menu]);

  function openProduct(p: MenuProduct) {
    if (p.modifierGroups.length === 0) {
      // no modifiers: add directly with qty 1
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
    // validate required groups
    for (const g of p.modifierGroups) {
      if (g.required) {
        const sel = sheetSelected.filter((id) => g.options.some((o) => o.id === id));
        if (sel.length < g.minSelections) {
          setSubmitError(`Select at least ${g.minSelections} for ${g.nameEn}`);
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
    setSubmitError(null);
  }

  async function charge() {
    if (cart.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const draft = {
        lines: cart.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          selectedOptionIds: l.selectedOptionIds,
        })),
      };
      const res = await window.pos.submitOrder(draft);
      setReceipt({
        clientOrderId: res.clientOrderId,
        lines: [...cart],
        total: cartTotal(cart),
        timestamp: new Date().toISOString(),
      });
      setCart([]);
      setTicketsKey((k) => k + 1);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to submit order");
    } finally {
      setSubmitting(false);
    }
  }

  function newOrder() {
    setReceipt(null);
    setSubmitError(null);
  }

  if (receipt) {
    return (
      <Receipt
        data={receipt}
        onPrint={() => window.print()}
        onNewOrder={newOrder}
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

        {/* Right: cart + tickets */}
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
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between border-t border-border pt-2 text-sm font-bold text-ink">
            <span>Total</span>
            <span>{cartTotal(cart).toFixed(2)}</span>
          </div>
          {submitError && <p className="text-sm text-status-danger-fg">{submitError}</p>}
          <button
            onClick={charge}
            disabled={cart.length === 0 || submitting}
            className="rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Charge (cash)"}
          </button>

          <TicketsPanel refreshKey={ticketsKey} />
        </aside>
      </div>

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
            {submitError && <p className="mt-2 text-sm text-status-danger-fg">{submitError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

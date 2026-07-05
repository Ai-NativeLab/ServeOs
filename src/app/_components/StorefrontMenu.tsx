"use client";
import { useEffect, useState } from "react";
import type { PublishedMenu } from "@/server/catalog/schema";
import { addLine, loadCart, removeLine, cartSubtotal, type Cart } from "./cart";
import { CategoryNav } from "./storefront/CategoryNav";

type MenuProduct = PublishedMenu["categories"][number]["products"][number];

export function StorefrontMenu({ menu, branchId, slug, orderingEnabled }: { menu: PublishedMenu; branchId: string | null; slug: string; orderingEnabled: boolean }) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onChange = () => setCart(loadCart());
    // Sync initial cart from localStorage after mount, then subscribe
    onChange();
    window.addEventListener("serveos-cart-changed", onChange);
    return () => window.removeEventListener("serveos-cart-changed", onChange);
  }, []);

  function add(p: MenuProduct, optionIds: string[]) {
    const deltas = p.modifierGroups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).reduce((s, o) => s + Number(o.priceDelta), 0);
    const summary = p.modifierGroups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).map((o) => o.nameEn).join(", ");
    setCart(addLine(branchId, {
      productId: p.id, nameEn: p.nameEn, nameAr: p.nameAr, quantity: 1,
      unitPrice: p.effectivePrice + deltas, selectedOptionIds: optionIds, modifierSummaryEn: summary,
    }));
    setDrawerOpen(true);
  }

  return (
    <>
      <CategoryNav categories={menu.categories.map((c) => ({ id: c.id, nameEn: c.nameEn }))} />

      {orderingEnabled && (
        <button onClick={() => setDrawerOpen(true)} style={{ position: "fixed", insetInlineEnd: 16, top: 16, zIndex: 20, background: "#0f172a", color: "#fff", border: 0, borderRadius: 999, padding: "10px 16px", fontWeight: 700 }}>
          🛒 {cart.lines.reduce((s, l) => s + l.quantity, 0)}
        </button>
      )}

      {menu.categories.map((cat) => (
        <div key={cat.id} id={`category-${cat.id}`} className="scroll-mt-32 py-6">
          <h2 style={{ fontSize: 20, borderBottom: "2px solid currentColor", paddingBottom: 4 }}>{cat.nameEn} / {cat.nameAr}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16, marginTop: 12 }}>
            {cat.products.map((p) => <ProductCard key={p.id} product={p} onAdd={orderingEnabled ? add : undefined} />)}
          </div>
        </div>
      ))}

      {orderingEnabled && drawerOpen && (
        <CartDrawer cart={cart} slug={slug} onClose={() => setDrawerOpen(false)} onRemove={(i) => setCart(removeLine(i))} />
      )}
    </>
  );
}

function ProductCard({ product, onAdd }: { product: MenuProduct; onAdd?: (p: MenuProduct, ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>(() => product.modifierGroups.flatMap((g) => g.options).filter((o) => o.isDefault).map((o) => o.id));
  const toggle = (gMax: number, groupOptionIds: string[], id: string) => {
    setSelected((prev) => {
      const inGroup = prev.filter((x) => groupOptionIds.includes(x));
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (gMax === 1) return [...prev.filter((x) => !groupOptionIds.includes(x)), id];
      if (inGroup.length >= gMax) return prev;
      return [...prev, id];
    });
  };
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
      {product.imageUrl && <img src={product.imageUrl} alt={product.nameEn} style={{ width: "100%", height: 140, objectFit: "cover" }} />}
      <div style={{ padding: 12 }}>
        <div style={{ fontWeight: 600 }}>{product.nameEn}</div>
        <div dir="rtl" style={{ color: "#6b7280", fontSize: 14 }}>{product.nameAr}</div>
        {onAdd && product.modifierGroups.map((g) => {
          const ids = g.options.map((o) => o.id);
          return (
            <div key={g.id} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>{g.nameEn}{g.required ? " *" : ""}</div>
              {g.options.map((o) => (
                <label key={o.id} style={{ display: "flex", gap: 6, fontSize: 13, alignItems: "center" }}>
                  <input type={g.maxSelections === 1 ? "radio" : "checkbox"} name={`${product.id}-${g.id}`} checked={selected.includes(o.id)} onChange={() => toggle(g.maxSelections, ids, o.id)} />
                  {o.nameEn}{Number(o.priceDelta) ? ` (+${Number(o.priceDelta)})` : ""}
                </label>
              ))}
            </div>
          );
        })}
        <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>{product.effectivePrice.toFixed(2)}</strong>
          {onAdd && <button onClick={() => onAdd(product, selected)} style={{ background: "#f97316", color: "#fff", border: 0, borderRadius: 6, padding: "6px 14px", fontWeight: 600 }}>Add</button>}
        </div>
      </div>
    </div>
  );
}

function CartDrawer({ cart, slug, onClose, onRemove }: { cart: Cart; slug: string; onClose: () => void; onRemove: (i: number) => void }) {
  const subtotal = cartSubtotal(cart.lines);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 30 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", insetInlineEnd: 0, top: 0, bottom: 0, width: 340, maxWidth: "90vw", background: "#fff", padding: 16, overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}><h3>Your cart</h3><button onClick={onClose} style={{ border: 0, background: "none", fontSize: 20 }}>×</button></div>
        {cart.lines.length === 0 && <p style={{ color: "#6b7280" }}>Cart is empty.</p>}
        {cart.lines.map((l, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #eee", padding: "8px 0" }}>
            <div><div>{l.quantity}× {l.nameEn}</div>{l.modifierSummaryEn && <div style={{ fontSize: 11, color: "#6b7280" }}>{l.modifierSummaryEn}</div>}</div>
            <div style={{ textAlign: "end" }}>{(l.unitPrice * l.quantity).toFixed(2)}<br /><button onClick={() => onRemove(i)} style={{ border: 0, background: "none", color: "#b91c1c", fontSize: 12 }}>Remove</button></div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontWeight: 700 }}><span>Subtotal</span><span>{subtotal.toFixed(2)}</span></div>
        {cart.lines.length > 0 && (
          <a href={`/checkout?slug=${encodeURIComponent(slug)}${cart.branchId ? `&branch=${cart.branchId}` : ""}`} style={{ display: "block", textAlign: "center", marginTop: 16, background: "#0f172a", color: "#fff", padding: "12px", borderRadius: 6, textDecoration: "none", fontWeight: 600 }}>Checkout →</a>
        )}
      </div>
    </div>
  );
}

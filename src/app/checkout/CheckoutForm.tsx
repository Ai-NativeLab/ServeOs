"use client";
import { useEffect, useMemo, useState } from "react";
import { loadCart, clearCart, cartSubtotal, type Cart } from "../_components/cart";

type Area = { id: string; nameEn: string; nameAr: string; deliveryFee: string; minOrderAmount: string; etaMinutes: number | null };

export function CheckoutForm({ slug, branchId, vatRate }: { slug: string; branchId: string | null; vatRate: number }) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [fulfillment, setFulfillment] = useState<"pickup" | "delivery">("delivery");
  const [areas, setAreas] = useState<Area[]>([]);
  const [areaId, setAreaId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const sync = () => setCart(loadCart());
    sync();
    window.addEventListener("serveos-cart-changed", sync);
    return () => window.removeEventListener("serveos-cart-changed", sync);
  }, []);

  useEffect(() => {
    if (!branchId) return;
    fetch(`/api/delivery-areas?slug=${encodeURIComponent(slug)}&branch=${branchId}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setAreas(d))
      .catch(() => {});
  }, [slug, branchId]);

  const subtotal = cartSubtotal(cart.lines);
  const area = useMemo(() => areas.find((a) => a.id === areaId), [areas, areaId]);
  const deliveryFee = fulfillment === "delivery" && area ? Number(area.deliveryFee) : 0;
  const vat = subtotal * (vatRate / 100);
  const total = subtotal + vat + deliveryFee;

  async function submit() {
    setError(null);
    if (fulfillment === "delivery" && (!areaId || !address.trim())) { setError("Please choose an area and enter your address."); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug, branchId, fulfillmentType: fulfillment, customerName: name, customerPhone: phone, notes,
          areaId: fulfillment === "delivery" ? areaId : undefined,
          addressText: fulfillment === "delivery" ? address : undefined,
          lines: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, selectedOptionIds: l.selectedOptionIds })),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not place order."); setSubmitting(false); return; }
      clearCart();
      window.location.href = `/order/${data.statusToken}`;
    } catch {
      setError("Network error — please try again.");
      setSubmitting(false);
    }
  }

  if (cart.lines.length === 0) return <p style={{ color: "#6b7280" }}>Your cart is empty.</p>;

  const input = { display: "block", width: "100%", padding: 8, margin: "6px 0", border: "1px solid #d1d5db", borderRadius: 6 } as const;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        {(["delivery", "pickup"] as const).map((f) => (
          <button key={f} onClick={() => setFulfillment(f)} style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #d1d5db", background: fulfillment === f ? "#0f172a" : "#fff", color: fulfillment === f ? "#fff" : "#0f172a", fontWeight: 600, textTransform: "capitalize" }}>{f}</button>
        ))}
      </div>
      <input style={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input style={input} placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
      {fulfillment === "delivery" && (
        <>
          <select style={input} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">Select area…</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn} (fee {Number(a.deliveryFee)} · min {Number(a.minOrderAmount)})</option>)}
          </select>
          <input style={input} placeholder="Street / building details" value={address} onChange={(e) => setAddress(e.target.value)} />
        </>
      )}
      <input style={input} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />

      <div style={{ borderTop: "1px solid #eee", marginTop: 12, paddingTop: 8 }}>
        <Row label="Subtotal" value={subtotal} />
        <Row label={`VAT ${vatRate}%`} value={vat} />
        {fulfillment === "delivery" && <Row label="Delivery" value={deliveryFee} />}
        <Row label="Total" value={total} bold />
      </div>

      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      <button onClick={submit} disabled={submitting || !name || !phone} style={{ width: "100%", marginTop: 12, padding: 12, background: "#f97316", color: "#fff", border: 0, borderRadius: 6, fontWeight: 700 }}>
        {submitting ? "Placing…" : "Place order (Cash)"}
      </button>
      <p style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>Final price is confirmed by the restaurant.</p>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", fontWeight: bold ? 700 : 400 }}><span>{label}</span><span>{value.toFixed(2)}</span></div>;
}

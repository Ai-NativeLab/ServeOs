"use client";
import { useEffect, useMemo, useState } from "react";
import { loadCart, clearCart, cartSubtotal, type Cart } from "../_components/cart";
import { rememberOrder } from "../_components/recent-orders";
import { formatMoney } from "@/lib/money";
import { computeOrderTotals, type CheckoutPricing } from "@/lib/order-totals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type SlotOption = { iso: string; label: string; day: "Today" | "Tomorrow" };
type Area = { id: string; nameEn: string; nameAr: string; deliveryFee: string; minOrderAmount: string; etaMinutes: number | null };

const CUSTOMER_KEY = "serveos.customer";
type SavedCustomer = { name: string; phone: string; address: string };

function loadCustomer(): SavedCustomer {
  try {
    const raw = window.localStorage.getItem(CUSTOMER_KEY);
    return raw ? (JSON.parse(raw) as SavedCustomer) : { name: "", phone: "", address: "" };
  } catch {
    return { name: "", phone: "", address: "" };
  }
}

export function CheckoutForm({
  slug, branchId, branchName, pricing, currency, openNow, slots,
}: {
  slug: string;
  branchId: string;
  branchName: string;
  pricing: CheckoutPricing;
  currency: string;
  openNow: boolean;
  slots: SlotOption[];
}) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [fulfillment, setFulfillment] = useState<"pickup" | "delivery">("delivery");
  const [when, setWhen] = useState<"asap" | "scheduled">(openNow ? "asap" : "scheduled");
  const [slotIso, setSlotIso] = useState<string>(slots[0]?.iso ?? "");
  const [slotDay, setSlotDay] = useState<"Today" | "Tomorrow">(slots[0]?.day ?? "Today");
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
    const saved = loadCustomer();
    setName(saved.name);
    setPhone(saved.phone);
    setAddress(saved.address);
    window.addEventListener("serveos-cart-changed", sync);
    return () => window.removeEventListener("serveos-cart-changed", sync);
  }, []);

  useEffect(() => {
    fetch(`/api/delivery-areas?slug=${encodeURIComponent(slug)}&branch=${branchId}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setAreas(d))
      .catch(() => {});
  }, [slug, branchId]);

  const subtotal = cartSubtotal(cart.lines);
  const area = useMemo(() => areas.find((a) => a.id === areaId), [areas, areaId]);
  const deliveryFee = fulfillment === "delivery" && area ? Number(area.deliveryFee) : 0;
  const totals = computeOrderTotals(pricing, subtotal, deliveryFee);
  const minShortfall =
    fulfillment === "delivery" && area && subtotal < Number(area.minOrderAmount)
      ? Number(area.minOrderAmount) - subtotal
      : 0;
  const daySlots = slots.filter((s) => s.day === slotDay);
  const hasTomorrow = slots.some((s) => s.day === "Tomorrow");
  const branchMismatch = cart.lines.length > 0 && cart.branchId !== null && cart.branchId !== branchId;

  async function submit() {
    setError(null);
    if (fulfillment === "delivery" && (!areaId || !address.trim())) {
      setError("Please choose an area and enter your address.");
      return;
    }
    if (when === "scheduled" && !slotIso) {
      setError("Please pick a time.");
      return;
    }
    // Stale-slot pre-check (spec §3): if the picked slot slipped under the
    // 30-min lead while the customer dawdled, prompt a re-pick before the
    // server would 422 anyway.
    if (when === "scheduled" && new Date(slotIso).getTime() < Date.now() + 30 * 60_000) {
      setSlotIso("");
      setError("That time is no longer available — please pick a new one.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug, branchId, fulfillmentType: fulfillment,
          customerName: name, customerPhone: phone, notes,
          areaId: fulfillment === "delivery" ? areaId : undefined,
          addressText: fulfillment === "delivery" ? address : undefined,
          scheduledFor: when === "scheduled" ? slotIso : undefined,
          lines: cart.lines.map((l) => ({
            productId: l.productId, variantId: l.variantId, quantity: l.quantity, selectedOptionIds: l.selectedOptionIds,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "out_of_stock") {
          setError(`${data.error} — please remove it from your cart or reduce the quantity.`);
        } else {
          setError(data.error ?? "Something went wrong");
        }
        setSubmitting(false);
        return;
      }
      try {
        window.localStorage.setItem(CUSTOMER_KEY, JSON.stringify({ name, phone, address }));
      } catch { /* best-effort */ }
      rememberOrder({
        token: data.statusToken, orderNumber: data.orderNumber,
        placedAt: new Date().toISOString(), status: "pending",
      });
      clearCart();
      window.location.href = `/order/${data.statusToken}`;
    } catch {
      setError("Network error — please try again.");
      setSubmitting(false);
    }
  }

  if (cart.lines.length === 0) {
    return <p className="mt-6 text-sm text-muted-foreground">Your cart is empty.</p>;
  }

  if (branchMismatch) {
    return (
      <div className="card-lift mt-6 rounded-2xl border border-border bg-card p-5">
        <p className="text-sm text-ink">
          Your cart was built for a different branch than <strong className="font-semibold">{branchName}</strong>.
        </p>
        <a
          href={`/checkout?slug=${encodeURIComponent(slug)}&branch=${cart.branchId}`}
          className="mt-4 inline-flex rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.98]"
        >
          Continue with your cart's branch →
        </a>
      </div>
    );
  }

  const segment = (active: boolean) =>
    `flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40 ${
      active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-ink"
    }`;

  return (
    <div className="mt-6 space-y-6">
      <div className="flex gap-1 rounded-full bg-muted p-1">
        {(["delivery", "pickup"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFulfillment(f)} className={`${segment(fulfillment === f)} capitalize`}>
            {f}
          </button>
        ))}
      </div>

      <div>
        <div className="eyebrow text-muted-foreground">When</div>
        <div className="mt-2 flex gap-1 rounded-full bg-muted p-1">
          <button type="button" disabled={!openNow} onClick={() => setWhen("asap")} className={segment(when === "asap")}>
            ASAP{!openNow && " (closed)"}
          </button>
          <button type="button" disabled={slots.length === 0} onClick={() => setWhen("scheduled")} className={segment(when === "scheduled")}>
            Schedule
          </button>
        </div>
        {when === "scheduled" && slots.length > 0 && (
          <div className="mt-3">
            {hasTomorrow && (
              <div className="inline-flex gap-1 rounded-full bg-muted p-1">
                {(["Today", "Tomorrow"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setSlotDay(d)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                      slotDay === d ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-ink"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {daySlots.map((s) => (
                <button
                  key={s.iso}
                  type="button"
                  data-testid="slot"
                  onClick={() => setSlotIso(s.iso)}
                  className={`rounded-full border px-3 py-1.5 font-mono text-xs font-medium transition-colors ${
                    slotIso === s.iso
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-ink hover:border-primary/40"
                  }`}
                >
                  {s.label.split(" ")[1]}
                </button>
              ))}
              {daySlots.length === 0 && <p className="text-sm text-muted-foreground">No times available {slotDay.toLowerCase()}.</p>}
            </div>
          </div>
        )}
        {when === "scheduled" && slots.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">No schedulable times in the next two days.</p>
        )}
      </div>

      <div className="card-lift space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="co-name">Name</Label>
          <Input id="co-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="co-phone">Phone</Label>
          <Input id="co-phone" placeholder="Phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        {fulfillment === "delivery" && (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="co-area">Area</Label>
              <select
                id="co-area"
                value={areaId}
                onChange={(e) => setAreaId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">Select area…</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nameEn} · fee {formatMoney(Number(a.deliveryFee), currency)}
                    {a.etaMinutes ? ` · ~${a.etaMinutes} min` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="co-address">Address</Label>
              <Input id="co-address" placeholder="Street / building details" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
          </>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="co-notes">Notes (optional)</Label>
          <Input id="co-notes" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="card-lift rounded-2xl border border-border bg-card p-4">
        <div className="divide-y divide-border">
          {cart.lines.map((l, i) => (
            <div key={i} className="flex justify-between py-2 text-sm">
              <span className="text-ink">{l.quantity}× {l.nameEn}</span>
              <span className="font-mono text-ink">{formatMoney(l.unitPrice * l.quantity, currency)}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 space-y-1.5 border-t border-border pt-3 text-sm">
          <Row label="Subtotal" value={formatMoney(totals.subtotal, currency)} />
          {totals.serviceChargeAmount > 0 && (
            <Row label="Service charge" value={formatMoney(totals.serviceChargeAmount, currency)} />
          )}
          {totals.vatAmount > 0 && (
            <Row
              label={totals.vatIncludedInPrices ? `VAT ${totals.vatRate}% (included)` : `VAT ${totals.vatRate}%`}
              value={formatMoney(totals.vatAmount, currency)}
            />
          )}
          {fulfillment === "delivery" && <Row label="Delivery" value={formatMoney(totals.deliveryFee, currency)} />}
          <Row label="Total" value={formatMoney(totals.total, currency)} bold />
        </div>
        {minShortfall > 0 && (
          <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            Add {formatMoney(minShortfall, currency)} more to reach this area's minimum order.
          </p>
        )}
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>}

      <Button
        onClick={submit}
        disabled={submitting || !name || !phone || minShortfall > 0}
        className="card-lift w-full rounded-full py-6 text-base transition-all active:scale-[0.98]"
      >
        {submitting ? "Placing…" : `Place order (Cash) — ${formatMoney(totals.total, currency)}`}
      </Button>
      <p className="text-xs text-muted-foreground">Final price is confirmed by the restaurant.</p>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-display font-bold text-ink" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

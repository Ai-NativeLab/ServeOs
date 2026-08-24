"use client";
import { useEffect, useMemo, useState } from "react";
import { loadCart, clearCart, cartSubtotal, type Cart } from "../_components/cart";
import { rememberOrder } from "../_components/recent-orders";
import { formatMoney } from "@/lib/money";
import { computeOrderTotals, type CheckoutPricing } from "@/lib/order-totals";
import { isValidCustomerPhone, getPhoneFormatHint } from "@/lib/phone";
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

export type OfflineMethodOption = { type: string; label: string; payToDetail: string | null };

export function CheckoutForm({
  slug, branchId, branchName, pricing, currency, openNow, slots, methods,
  country = "EG",
  initialName = "", initialPhone = "", initialAddress = "",
  customer = null,
  initialCart,
}: {
  slug: string;
  branchId: string;
  branchName: string;
  pricing: CheckoutPricing;
  currency: string;
  openNow: boolean;
  slots: SlotOption[];
  methods: OfflineMethodOption[];
  country?: string;
  initialName?: string;
  initialPhone?: string;
  initialAddress?: string;
  customer?: { id: string; name: string; email: string } | null;
  /** Test seam only: production hydrates the cart from localStorage inside the
   *  form (see the sync effect below). Passing it from the server is impossible
   *  — the cart lives in the browser. */
  initialCart?: Cart;
}) {
  const [cart, setCart] = useState<Cart>(() => initialCart ?? { branchId: null, lines: [] });
  const [fulfillment, setFulfillment] = useState<"pickup" | "delivery">("delivery");
  const [when, setWhen] = useState<"asap" | "scheduled">(openNow ? "asap" : "scheduled");
  const [slotIso, setSlotIso] = useState<string>(slots[0]?.iso ?? "");
  const [slotDay, setSlotDay] = useState<"Today" | "Tomorrow">(slots[0]?.day ?? "Today");
  const [areas, setAreas] = useState<Area[]>([]);
  const [areaId, setAreaId] = useState("");
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [address, setAddress] = useState(initialAddress);
  const [notes, setNotes] = useState("");
  const [payMethod, setPayMethod] = useState<string>("cash");
  const [payRef, setPayRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Rx prescription upload state
  const [rxFile, setRxFile] = useState<File | null>(null);
  const [rxPreview, setRxPreview] = useState<string | null>(null);
  const [rxUploadedId, setRxUploadedId] = useState<string | null>(null);
  const [rxError, setRxError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setCart(loadCart());
    if (!initialCart) sync();
    const saved = loadCustomer();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrating client-only saved customer details after mount
    setName((prev) => prev || saved.name);
    setPhone((prev) => prev || saved.phone);
    setAddress((prev) => prev || saved.address);
    window.addEventListener("serveos-cart-changed", sync);
    return () => window.removeEventListener("serveos-cart-changed", sync);
  }, [initialCart]);

  useEffect(() => {
    fetch(`/api/delivery-areas?slug=${encodeURIComponent(slug)}&branch=${branchId}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setAreas(d))
      .catch(() => {});
  }, [slug, branchId]);

  const hasRxLine = cart.lines.some((l) => l.requiresPrescription);
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
  const selectedMethod = methods.find((m) => m.type === payMethod) ?? null;
  const missingPaymentRef = selectedMethod !== null && !payRef.trim();

  async function submit() {
    setError(null);
    if (hasRxLine && !customer) {
      setError("Please sign in or create an account to order prescription items.");
      return;
    }
    if (hasRxLine && !rxFile && !rxUploadedId) {
      setError("Please upload your prescription before placing this order.");
      return;
    }
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
    if (!isValidCustomerPhone(phone, country)) {
      setError(
        country === "SA"
          ? "Please enter a valid Saudi mobile number (e.g. 05XXXXXXXX) · يرجى إدخال رقم جوال سعودي صحيح"
          : "Please enter a valid Egyptian mobile number (e.g. 01XXXXXXXXX) · يرجى إدخال رقم هاتف مصري صحيح"
      );
      return;
    }
    if (missingPaymentRef) {
      setError("Please enter your payment reference.");
      return;
    }
    setSubmitting(true);
    try {
      if (hasRxLine && rxFile && !rxUploadedId) {
        const fd = new FormData();
        fd.append("file", rxFile);
        const rxRes = await fetch("/api/prescriptions", { method: "POST", body: fd });
        if (!rxRes.ok) {
          const rxData = (await rxRes.json().catch(() => ({}))) as { error?: string };
          setError(rxData.error ?? "Failed to upload prescription");
          setSubmitting(false);
          return;
        }
        const rxData = (await rxRes.json()) as { id: string };
        setRxUploadedId(rxData.id);
      }

      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug, branchId, fulfillmentType: fulfillment,
          customerName: name, customerPhone: phone, notes,
          areaId: fulfillment === "delivery" ? areaId : undefined,
          addressText: fulfillment === "delivery" ? address : undefined,
          scheduledFor: when === "scheduled" ? slotIso : undefined,
          paymentMethod: payMethod,
          paymentReference: selectedMethod ? payRef.trim() : undefined,
          lines: cart.lines.map((l) => ({
            productId: l.productId, variantId: l.variantId, quantity: l.quantity, selectedOptionIds: l.selectedOptionIds,
            dimensions: l.dimensions,
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
          Continue with your cart&apos;s branch →
        </a>
      </div>
    );
  }

  // py-3 (was py-2) brings these radio-style toggle rows up to the 44px tap-target minimum.
  const segment = (active: boolean) =>
    `flex-1 rounded-full px-4 py-3 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40 ${
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

      {hasRxLine && !customer && (
        <div className="card-lift rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-start gap-3">
            <span className="text-xl">📋</span>
            <div>
              <h4 className="text-sm font-semibold text-ink">Prescription required · روشتة طبية مطلوبة</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                Your cart contains prescription items. Legally, a pharmacist must review your doctor&apos;s prescription before dispensing. Please sign in or register to attach your prescription.
              </p>
              <p dir="rtl" className="mt-1 text-xs text-muted-foreground">
                تحتوي سلتك على أدوية تتطلب وصفة طبية. يرجى تسجيل الدخول أو إنشاء حساب لإرفاق الروشتة.
              </p>
              <a
                href={`/account?next=${encodeURIComponent(`/checkout?slug=${slug}&branch=${branchId}`)}`}
                className="mt-3 inline-flex items-center rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Sign in or Register →
              </a>
            </div>
          </div>
        </div>
      )}

      {hasRxLine && customer && (
        <div className="card-lift space-y-3 rounded-2xl border border-border bg-card p-4">
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="co-prescription" className="text-sm font-semibold text-ink">
                Prescription upload · إرفاق الروشتة
              </Label>
              <span className="rounded-full bg-status-pending/20 px-2 py-0.5 text-[10px] font-medium text-status-pending-fg">
                Rx required
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Please attach a clear photo or PDF of your doctor&apos;s prescription (JPG, PNG, WebP or PDF, max 8 MB).
            </p>
            <p dir="rtl" className="mt-0.5 text-xs text-muted-foreground">
              يرجى إرفاق صورة واضحة أو ملف PDF للروشتة (JPG، PNG، WebP أو PDF، بحد أقصى 8 ميجابايت).
            </p>
          </div>

          {rxFile ? (
            <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 p-3">
              <div className="flex items-center gap-3 overflow-hidden">
                {rxPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={rxPreview} alt="Prescription preview" className="size-12 rounded-lg object-cover" />
                ) : (
                  <div className="grid size-12 place-items-center rounded-lg bg-muted text-lg">📄</div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-ink">{rxFile.name}</p>
                  <p className="text-[11px] text-muted-foreground">{(rxFile.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setRxFile(null);
                  setRxPreview(null);
                  setRxUploadedId(null);
                }}
                className="text-xs font-medium text-destructive hover:underline"
              >
                Remove
              </button>
            </div>
          ) : (
            <div>
              <input
                id="co-prescription"
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="hidden"
                onChange={(e) => {
                  setRxError(null);
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
                  if (!allowed.includes(f.type)) {
                    setRxError("Please upload a JPG, PNG, WebP, or PDF file.");
                    return;
                  }
                  if (f.size > 8 * 1024 * 1024) {
                    setRxError("Prescription file must be under 8 MB.");
                    return;
                  }
                  setRxFile(f);
                  if (f.type.startsWith("image/")) {
                    setRxPreview(URL.createObjectURL(f));
                  } else {
                    setRxPreview(null);
                  }
                }}
              />
              <label
                htmlFor="co-prescription"
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-4 text-center transition-colors hover:border-primary/50 hover:bg-muted/40"
              >
                <span className="text-xl">📎</span>
                <span className="mt-1 text-xs font-semibold text-ink">Click to upload prescription</span>
                <span className="text-[11px] text-muted-foreground">JPG, PNG, WebP or PDF up to 8 MB</span>
              </label>
            </div>
          )}
          {rxError && <p className="text-xs text-destructive">{rxError}</p>}
        </div>
      )}

      <div className="card-lift space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="co-name">Name</Label>
          <Input id="co-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="co-phone">Phone · الهاتف</Label>
            <span className="text-xs text-muted-foreground">{getPhoneFormatHint(country)}</span>
          </div>
          <Input
            id="co-phone"
            placeholder={getPhoneFormatHint(country)}
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        {fulfillment === "delivery" && (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="co-area">Area</Label>
              <select
                id="co-area"
                value={areaId}
                onChange={(e) => setAreaId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-base outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
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
            Add {formatMoney(minShortfall, currency)} more to reach this area&apos;s minimum order.
          </p>
        )}
      </div>

      <div className="card-lift space-y-2 rounded-2xl border border-border bg-card p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="co-payment">Payment</Label>
          <select
            id="co-payment"
            value={payMethod}
            onChange={(e) => {
              setPayMethod(e.target.value);
              setPayRef("");
            }}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-base outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
          >
            <option value="cash">Cash on delivery</option>
            {methods.map((m) => (
              <option key={m.type} value={m.type}>{m.label}</option>
            ))}
          </select>
        </div>
        {selectedMethod && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <p className="text-ink">
              {selectedMethod.payToDetail ? (
                <>Send payment to <span className="font-semibold">{selectedMethod.payToDetail}</span>, then enter your reference below.</>
              ) : (
                "Enter your payment reference below."
              )}
            </p>
            <Input
              value={payRef}
              onChange={(e) => setPayRef(e.target.value)}
              placeholder="Transaction reference"
              aria-invalid={missingPaymentRef}
              className="mt-2"
            />
          </div>
        )}
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>}

      <Button
        onClick={submit}
        disabled={submitting || !name || !phone || minShortfall > 0 || missingPaymentRef}
        className="card-lift w-full rounded-full py-6 text-base transition-all active:scale-[0.98]"
      >
        {submitting ? "Placing…" : `Place order (${selectedMethod ? selectedMethod.label : "Cash"}) — ${formatMoney(totals.total, currency)}`}
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

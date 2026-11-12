"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";

/** UTC ISO instant -> the browser's local "YYYY-MM-DDTHH:mm" for datetime-local. */
function isoToLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The browser's local datetime-local value -> UTC ISO instant ("" stays ""). */
function localInputToIso(local: string): string {
  if (!local) return "";
  const d = new Date(local); // no zone suffix: parsed in the BROWSER's timezone
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function toIso(v: Date | string | null | undefined): string {
  if (!v) return "";
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

const noopSubscribe = () => () => {};
/** False during SSR and hydration, true after: local times are only rendered
 *  in the browser, so the server's timezone never reaches the markup. */
function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Follows the form's live "basePrice" field so the preview reflects an
 *  edited (or, on the create page, not-yet-saved) base price. */
function useLiveBasePrice(rootRef: React.RefObject<HTMLElement | null>, initial: number): number {
  const [price, setPrice] = useState(initial);
  useEffect(() => {
    const form = rootRef.current?.closest("form");
    if (!form) return;
    const read = () => {
      const field = form.elements.namedItem("basePrice");
      if (field instanceof HTMLInputElement) {
        const n = Number(field.value);
        setPrice(Number.isFinite(n) ? n : 0);
      }
    };
    const onInput = (e: Event) => {
      if (e.target instanceof HTMLInputElement && e.target.name === "basePrice") read();
    };
    form.addEventListener("input", onInput);
    return () => form.removeEventListener("input", onInput);
  }, [rootRef]);
  return price;
}

export function PromotionalPricingSection({
  initialActive = false,
  initialSalePrice = null,
  initialDiscountPercent = null,
  initialStartsAt = null,
  initialEndsAt = null,
  basePrice = 0,
  currency,
}: {
  initialActive?: boolean;
  initialSalePrice?: string | null;
  initialDiscountPercent?: number | null;
  initialStartsAt?: Date | string | null;
  initialEndsAt?: Date | string | null;
  basePrice?: number;
  currency: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isClient = useIsClient();
  const liveBase = useLiveBasePrice(rootRef, basePrice);
  const [active, setActive] = useState<boolean>(initialActive);
  // Only one method is ever stored, so the stored field IS the mode. (A
  // legacy row with both set was written by percent mode, which also derived
  // a salePrice — read it back as percent.)
  const [type, setType] = useState<"percent" | "sale_price">(
    initialSalePrice && !initialDiscountPercent ? "sale_price" : "percent",
  );
  const [percent, setPercent] = useState<string>(
    initialDiscountPercent ? String(initialDiscountPercent) : "20",
  );
  const [salePrice, setSalePrice] = useState<string>(
    initialSalePrice && !initialDiscountPercent ? String(initialSalePrice) : "",
  );
  // Canonical values are UTC instants; the datetime-local inputs only display them.
  const [startsAt, setStartsAt] = useState<string>(toIso(initialStartsAt));
  const [endsAt, setEndsAt] = useState<string>(toIso(initialEndsAt));
  // "Now" for the active/scheduled/expired hint, fixed at mount (the hint is
  // only rendered in the browser, so the server's clock never shows).
  const [now] = useState(() => Date.now());

  const preview = useMemo(() => {
    if (!active || liveBase <= 0) return null;

    let computedSale: number | null = null;
    let computedPercent: number | null = null;
    let error: string | null = null;

    if (type === "percent") {
      const p = Number(percent);
      if (!Number.isInteger(p) || p < 1 || p > 99) {
        error = "Discount percent must be a whole number from 1% to 99%.";
      } else {
        computedPercent = p;
        computedSale = Math.round(liveBase * (1 - p / 100) * 100) / 100;
      }
    } else {
      const s = Number(salePrice);
      if (salePrice === "" || Number.isNaN(s) || s <= 0) {
        error = "Please enter a valid sale price.";
      } else if (s >= liveBase) {
        error = `Sale price (${formatMoney(s, currency)}) must be lower than the base price (${formatMoney(liveBase, currency)}).`;
      } else {
        computedSale = Math.round(s * 100) / 100;
        computedPercent = Math.round(((liveBase - computedSale) / liveBase) * 100);
      }
    }

    const start = startsAt ? new Date(startsAt).getTime() : null;
    const end = endsAt ? new Date(endsAt).getTime() : null;

    let dateStatus: "active" | "scheduled" | "expired" = "active";
    if (start !== null && now < start) dateStatus = "scheduled";
    else if (end !== null && now > end) dateStatus = "expired";

    if (start !== null && end !== null && end <= start) {
      error = "The end date must be after the start date.";
    }

    return { computedSale, computedPercent, error, dateStatus };
  }, [active, liveBase, type, percent, salePrice, startsAt, endsAt, currency, now]);

  const methodButton = (selected: boolean) =>
    `flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-all ${
      selected
        ? "border-primary bg-primary/10 text-primary shadow-xs"
        : "border-border bg-card text-muted-foreground hover:bg-muted/50"
    }`;

  return (
    <div ref={rootRef} className="rounded-xl border border-border bg-card/60 p-4 transition-all">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span id="promo-pricing-title" className="font-semibold text-ink">Promotional Pricing & Offers</span>
            <span className="text-xs text-muted-foreground" dir="rtl">
              العروض والخصومات
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Run temporary discounts, markdown sales, or scheduled promotional campaigns.
          </p>
        </div>

        <label className="relative inline-flex items-center cursor-pointer select-none">
          <input
            type="checkbox"
            role="switch"
            name="discountActive"
            value="true"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            aria-label="Enable promotional pricing"
            className="sr-only peer"
          />
          <div className="relative w-11 h-6 bg-muted rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-ring after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary peer-checked:after:border-white peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full" />
        </label>
      </div>

      {active && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          <input type="hidden" name="discountType" value={type} />
          <input type="hidden" name="discountStartsAt" value={startsAt} />
          <input type="hidden" name="discountEndsAt" value={endsAt} />

          {/* Discount Type Selector */}
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Discount Method / نوع الخصم</Label>
            <div className="grid grid-cols-2 gap-2 max-w-md">
              <button
                type="button"
                aria-pressed={type === "percent"}
                onClick={() => setType("percent")}
                className={methodButton(type === "percent")}
              >
                <span>Percentage (%)</span>
                <span dir="rtl" className="text-[10px] opacity-75">
                  نسبة مئوية
                </span>
              </button>
              <button
                type="button"
                aria-pressed={type === "sale_price"}
                onClick={() => setType("sale_price")}
                className={methodButton(type === "sale_price")}
              >
                <span>Fixed Sale Price</span>
                <span dir="rtl" className="text-[10px] opacity-75">
                  سعر محدد
                </span>
              </button>
            </div>
          </div>

          {/* Amount Inputs */}
          <div className="grid md:grid-cols-2 gap-4">
            {type === "percent" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="discountPercent" className="text-xs">
                  Discount Percentage (% Off)
                </Label>
                <div className="relative">
                  <Input
                    id="discountPercent"
                    name="discountPercent"
                    type="number"
                    min="1"
                    max="99"
                    step="1"
                    value={percent}
                    onChange={(e) => setPercent(e.target.value)}
                    placeholder="20"
                    required
                    className="pe-8"
                  />
                  <span className="absolute end-3 top-2.5 text-xs text-muted-foreground font-bold">%</span>
                </div>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="salePrice" className="text-xs">
                  Promotional Sale Price ({currency})
                </Label>
                <Input
                  id="salePrice"
                  name="salePrice"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  placeholder={liveBase > 0 ? `e.g. ${(liveBase * 0.8).toFixed(2)}` : undefined}
                  required
                />
              </div>
            )}
          </div>

          {/* Scheduled Dates — shown in the merchant's local time, submitted as UTC */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="discountStartsAtLocal" className="text-xs">
                Start Date (Optional / اختياري)
              </Label>
              <Input
                id="discountStartsAtLocal"
                type="datetime-local"
                value={isClient ? isoToLocalInput(startsAt) : ""}
                onChange={(e) => setStartsAt(localInputToIso(e.target.value))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="discountEndsAtLocal" className="text-xs">
                End Date (Optional / اختياري)
              </Label>
              <Input
                id="discountEndsAtLocal"
                type="datetime-local"
                value={isClient ? isoToLocalInput(endsAt) : ""}
                onChange={(e) => setEndsAt(localInputToIso(e.target.value))}
              />
            </div>
          </div>

          {/* Live Preview Box */}
          {preview && (
            <div
              className={`rounded-lg border p-3 text-xs transition-colors ${
                preview.error
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-primary/30 bg-primary/5 text-ink"
              }`}
            >
              {preview.error ? (
                <div className="flex items-center gap-2 font-medium">
                  <span aria-hidden="true">⚠️</span>
                  <span>{preview.error}</span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Storefront Preview:</span>
                    <span className="line-through text-muted-foreground font-sans">
                      {formatMoney(liveBase, currency)}
                    </span>
                    <span className="font-bold text-ink text-sm">
                      {formatMoney(preview.computedSale ?? 0, currency)}
                    </span>
                    <span className="rounded-full bg-destructive px-2 py-0.5 text-[11px] font-bold text-destructive-foreground">
                      -{preview.computedPercent}%
                    </span>
                  </div>

                  {/* Status depends on "now", so it's browser-only too. */}
                  {isClient && (
                    <div>
                      {preview.dateStatus === "active" && (
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          Active immediately
                        </span>
                      )}
                      {preview.dateStatus === "scheduled" && (
                        <span className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
                          ⏳ Scheduled for later
                        </span>
                      )}
                      {preview.dateStatus === "expired" && (
                        <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
                          ⚠️ Schedule expired (will show base price)
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";
import { useState, useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";

function toLocalDatetimeString(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PromotionalPricingSection({
  initialActive = false,
  initialSalePrice = null,
  initialDiscountPercent = null,
  initialStartsAt = null,
  initialEndsAt = null,
  basePrice = 0,
  currency = "EGP",
}: {
  initialActive?: boolean;
  initialSalePrice?: string | null;
  initialDiscountPercent?: number | null;
  initialStartsAt?: Date | string | null;
  initialEndsAt?: Date | string | null;
  basePrice?: number;
  currency?: string;
}) {
  const [active, setActive] = useState<boolean>(initialActive);
  const [type, setType] = useState<"percent" | "sale_price">(
    initialSalePrice ? "sale_price" : "percent",
  );
  const [percent, setPercent] = useState<string>(
    initialDiscountPercent ? String(initialDiscountPercent) : "20",
  );
  const [salePrice, setSalePrice] = useState<string>(
    initialSalePrice ? String(initialSalePrice) : "",
  );
  const [startsAt, setStartsAt] = useState<string>(toLocalDatetimeString(initialStartsAt));
  const [endsAt, setEndsAt] = useState<string>(toLocalDatetimeString(initialEndsAt));

  // Compute live preview
  const preview = useMemo(() => {
    if (!active || basePrice <= 0) return null;

    let computedSale: number | null = null;
    let computedPercent: number | null = null;
    let error: string | null = null;

    if (type === "percent") {
      const p = Number(percent);
      if (Number.isNaN(p) || p < 1 || p > 99) {
        error = "Discount percent must be between 1% and 99%.";
      } else {
        computedPercent = Math.round(p);
        computedSale = Math.round(basePrice * (1 - p / 100) * 100) / 100;
      }
    } else {
      const s = Number(salePrice);
      if (Number.isNaN(s) || s <= 0) {
        error = "Please enter a valid sale price.";
      } else if (s >= basePrice) {
        error = `Sale price (${s} ${currency}) must be lower than base price (${basePrice} ${currency}).`;
      } else {
        computedSale = Math.round(s * 100) / 100;
        computedPercent = Math.round(((basePrice - computedSale) / basePrice) * 100);
      }
    }

    // Date status check
    const now = new Date();
    const startDate = startsAt ? new Date(startsAt) : null;
    const endDate = endsAt ? new Date(endsAt) : null;

    let dateStatus: "active" | "scheduled" | "expired" = "active";
    if (startDate && now < startDate) {
      dateStatus = "scheduled";
    } else if (endDate && now > endDate) {
      dateStatus = "expired";
    }

    if (startDate && endDate && endDate < startDate) {
      error = "End date cannot be earlier than start date.";
    }

    return { computedSale, computedPercent, error, dateStatus };
  }, [active, basePrice, type, percent, salePrice, startsAt, endsAt, currency]);

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 transition-all">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ink">Promotional Pricing & Offers</span>
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
            name="discountActive"
            value="true"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
        </label>
      </div>

      {active && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          <input type="hidden" name="discountType" value={type} />

          {/* Discount Type Selector */}
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Discount Method / نوع الخصم</Label>
            <div className="grid grid-cols-2 gap-2 max-w-md">
              <button
                type="button"
                onClick={() => setType("percent")}
                className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-all ${
                  type === "percent"
                    ? "border-primary bg-primary/10 text-primary shadow-xs"
                    : "border-border bg-card text-muted-foreground hover:bg-muted/50"
                }`}
              >
                <span>Percentage (%)</span>
                <span dir="rtl" className="text-[10px] opacity-75">
                  نسبة مئوية
                </span>
              </button>
              <button
                type="button"
                onClick={() => setType("sale_price")}
                className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-all ${
                  type === "sale_price"
                    ? "border-primary bg-primary/10 text-primary shadow-xs"
                    : "border-border bg-card text-muted-foreground hover:bg-muted/50"
                }`}
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
                    value={percent}
                    onChange={(e) => setPercent(e.target.value)}
                    placeholder="20"
                    required={active && type === "percent"}
                    className="pr-8"
                  />
                  <span className="absolute right-3 top-2.5 text-xs text-muted-foreground font-bold">%</span>
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
                  placeholder={`e.g. ${(basePrice * 0.8).toFixed(2)}`}
                  required={active && type === "sale_price"}
                />
              </div>
            )}
          </div>

          {/* Scheduled Dates */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="discountStartsAt" className="text-xs">
                Start Date (Optional / اختياري)
              </Label>
              <Input
                id="discountStartsAt"
                name="discountStartsAt"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="discountEndsAt" className="text-xs">
                End Date (Optional / اختياري)
              </Label>
              <Input
                id="discountEndsAt"
                name="discountEndsAt"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
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
                  <span>⚠️</span>
                  <span>{preview.error}</span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Storefront Preview:</span>
                    <span className="line-through text-muted-foreground font-sans">
                      {formatMoney(basePrice, currency)}
                    </span>
                    <span className="font-bold text-ink text-sm">
                      {formatMoney(preview.computedSale ?? 0, currency)}
                    </span>
                    <span className="rounded-full bg-destructive px-2 py-0.5 text-[11px] font-bold text-destructive-foreground">
                      -{preview.computedPercent}%
                    </span>
                  </div>

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
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

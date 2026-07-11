/** "EGP 120.00" (code + non-breaking space + amount). Display only — the
 * server recomputes all totals at order placement. */
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    currencyDisplay: "code",
  }).format(amount);
}

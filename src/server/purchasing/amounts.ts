/**
 * Purchasing has two kinds of number and they must not share a formatter.
 *
 *   CURRENCY TOTALS  — `purchase_orders.total`, `invoice_total`, variance
 *                      deltas. Real money, 2 decimals, `money()`.
 *   PER-UNIT RATES   — `purchase_order_lines.unit_cost`,
 *                      `po_receipt_lines.unit_cost`,
 *                      `supplier_items.last_unit_cost`, `tax_rate`. NOT money:
 *                      a price per gram is legitimately 0.0035, and a case of
 *                      24 divides to 2.0833… per can. Stored exactly.
 *
 * Rounding a rate with `money()` is what put the three-way match back on two
 * bases after the tax fix had put it on one: `po.total` was summed from the raw
 * caller input while `receivedTotal` summed the rounded column, so 1000 units
 * at 0.125 ordered 125.00 and "received" 130.00 — a 5.00 discrepancy on a
 * flawless PO. At 0.0035/g it was worse than a phantom delta: `money()` stored
 * 0.00 while `receiving.ts` used the raw cost for the lot, so the stock ledger
 * recorded 3.50 of goods and the variance screen reported 0.00.
 *
 * The columns are unbounded `numeric`, so the exact value is storable as-is.
 * This mirrors `inventory_lots.unit_cost`, which already stores the exact
 * per-base-unit quotient for the same reason.
 */

/** A per-unit rate, stored exactly. See the module docstring for why NOT `money()`. */
export function unitRate(n: number): string {
  return String(n);
}

/**
 * A rate formatted for a human-facing document. Keeps at least 2 decimals so it
 * reads as a price, and up to 6 so a sub-cent rate is not displayed as 0.00 —
 * the emailed PO must multiply out to the total the supplier is asked to bill.
 */
export function formatUnitRate(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const fixed = n.toFixed(6).replace(/0+$/, "");
  const [whole, frac = ""] = fixed.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

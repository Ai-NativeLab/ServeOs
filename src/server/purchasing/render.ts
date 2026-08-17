import type { PurchaseOrder, PurchaseOrderLine, Supplier } from "./schema";

/** The four-entity escape, kept local so the pure renderer never depends on the
 *  worker's escaping (they must match — both guard interpolated HTML). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Two-decimal money formatting, matching `money()` so PO line totals agree with totals. */
function money(n: number): string { return (Math.round(n * 100) / 100).toFixed(2); }

/**
 * Renders a PO to a self-contained HTML document (no external asset URLs).
 * Pure: takes the loaded rows, returns a string. Every interpolation is
 * escaped, so a hostile supplier name or item name cannot inject markup.
 */
export function renderPurchaseOrderHtml(
  po: PurchaseOrder,
  lines: PurchaseOrderLine[],
  itemNames: Map<string, string>,
  supplier: Supplier,
  branch: { name: string },
  tenant: { name: string },
): string {
  let subtotal = 0;
  let taxTotal = 0;
  const rows = lines.map((l) => {
    const name = itemNames.get(l.itemId) ?? l.itemId;
    const net = Number(l.qtyOrdered) * Number(l.unitCost);
    const tax = net * Number(l.taxRate ?? 0);
    subtotal += net;
    taxTotal += tax;
    // The row shows NET so the column sums to the subtotal; tax is broken out
    // once in the footer. `po.total` is gross, so without that block the
    // document would not add up to its own stated total.
    const lineTotal = money(net);
    return `<tr>
      <td style="padding:8px 16px 8px 0;color:#1A0F0A;">${escapeHtml(name)}</td>
      <td style="padding:8px 16px;color:#1A0F0A;text-align:right;">${escapeHtml(l.qtyOrdered)} ${escapeHtml(l.uom)}</td>
      <td style="padding:8px 16px;color:#1A0F0A;text-align:right;">${escapeHtml(l.unitCost)}</td>
      <td style="padding:8px 0;color:#1A0F0A;text-align:right;">${escapeHtml(lineTotal)}</td>
    </tr>`;
  }).join("");

  return `<!doctype html><html><body style="font-family:sans-serif;background:#FBF7F2;padding:24px;">
  <div style="max-width:620px;margin:0 auto;background:#FFFFFF;border:1px solid #E9E0D6;border-radius:12px;padding:24px;">
    <h2 style="margin:0 0 4px;color:#1A0F0A;">Purchase Order #${escapeHtml(String(po.poNumber))}</h2>
    <p style="margin:0 0 16px;color:#6E6459;font-size:13px;">${escapeHtml(tenant.name)} &mdash; ${escapeHtml(branch.name)}</p>
    <p style="margin:0 0 16px;color:#1A0F0A;"><strong>Supplier:</strong> ${escapeHtml(supplier.name)}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;border-top:1px solid #E9E0D6;">
      <thead><tr style="color:#6E6459;font-size:12px;text-align:left;">
        <th style="padding:8px 16px 8px 0;">Item</th>
        <th style="padding:8px 16px;text-align:right;">Qty</th>
        <th style="padding:8px 16px;text-align:right;">Unit</th>
        <th style="padding:8px 0;text-align:right;">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:16px 0 0;color:#6E6459;font-size:13px;text-align:right;">Subtotal: ${escapeHtml(money(subtotal))} ${escapeHtml(po.currency)}</p>
    <p style="margin:2px 0 0;color:#6E6459;font-size:13px;text-align:right;">Tax: ${escapeHtml(money(taxTotal))} ${escapeHtml(po.currency)}</p>
    <p style="margin:6px 0 0;color:#1A0F0A;font-size:16px;text-align:right;"><strong>Total: ${escapeHtml(po.total)} ${escapeHtml(po.currency)}</strong></p>
  </div></body></html>`;
}

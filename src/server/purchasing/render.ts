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
  const rows = lines.map((l) => {
    const name = itemNames.get(l.itemId) ?? l.itemId;
    const lineTotal = money(Number(l.qtyOrdered) * Number(l.unitCost));
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
    <p style="margin:16px 0 0;color:#1A0F0A;font-size:16px;text-align:right;"><strong>Total: ${escapeHtml(po.total)} ${escapeHtml(po.currency)}</strong></p>
  </div></body></html>`;
}

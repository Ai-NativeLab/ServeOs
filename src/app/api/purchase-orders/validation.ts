/**
 * Shared parser for PO line input used by both the create and update routes.
 * Lives beside the routes rather than in them because a route module may only
 * export its HTTP handlers.
 */
import type { createDraftPo } from "@/server/purchasing/service";

export type ParsedLines = Parameters<typeof createDraftPo>[1]["lines"] | { error: string };

export function parseLines(raw: unknown): ParsedLines {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "lines must be a non-empty array" };
  }
  const lines: Parameters<typeof createDraftPo>[1]["lines"] = [];
  for (const l of raw) {
    const row = (l ?? {}) as Record<string, unknown>;
    if (typeof row.itemId !== "string" || !row.itemId) return { error: "each line needs a string itemId" };
    const qtyOrdered = Number(row.qtyOrdered);
    const unitCost = Number(row.unitCost);
    if (!Number.isFinite(qtyOrdered) || qtyOrdered <= 0) return { error: "each line needs a positive qtyOrdered" };
    if (!Number.isFinite(unitCost) || unitCost < 0) return { error: "each line needs a non-negative unitCost" };
    if (typeof row.uom !== "string" || !row.uom) return { error: "each line needs a uom" };
    // The service floor (assertLineNumbers) rejects these too, but from inside
    // the route's blanket catch that surfaces as a 500. Validating here keeps a
    // bad body a 400, and keeps the two validators agreeing on every field.
    if (row.taxRate !== undefined) {
      const taxRate = Number(row.taxRate);
      if (!Number.isFinite(taxRate) || taxRate < 0) return { error: "each line needs a non-negative taxRate" };
    }
    lines.push({
      itemId: row.itemId,
      qtyOrdered,
      uom: row.uom as never,
      unitCost,
      taxRate: row.taxRate !== undefined ? Number(row.taxRate) : undefined,
    });
  }
  return lines;
}

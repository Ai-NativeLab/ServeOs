import { describe, it, expect } from "vitest";
import { eq, sql, is, getTableColumns, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { pool } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { seedItem } from "@/server/inventory/test-helpers";
import * as purchasingSchema from "./schema";
import { reorderRules } from "./reorder-schema";
import { purchaseOrders, purchaseOrderLines, poReceiptLines } from "./schema";
import { createDraftPo } from "./service";
import { runAudit, NUMERIC_RULES, PURCHASING_TABLES } from "./numeric-audit";
import type { AuditPool, AuditResult, NumericRule } from "./numeric-audit";
import { seedPurchasingTenant, rowIdFor } from "./test-helpers";
import type { PurchasingRowSet } from "./test-helpers";

/**
 * The audit's one promise is that it cannot report CLEAN for a database that
 * holds bad purchasing numerics. Everything here runs as the app role
 * (serveos_app: not superuser, not BYPASSRLS), so the audit has to find the
 * rows through RLS the same way it must in production.
 */

/** A finite value each column's shipped write path rejects. */
const ILLEGAL: Record<string, string> = {
  "supplier_items.last_unit_cost": "-1",
  "purchase_orders.total": "-1",
  "purchase_orders.invoice_total": "-5",
  "purchase_order_lines.qty_ordered": "0",
  "purchase_order_lines.unit_cost": "-0.5",
  "purchase_order_lines.tax_rate": "14", // a percentage where a fraction belongs
  "purchase_order_lines.qty_received": "-1",
  "po_receipt_lines.received_qty": "0",
  "po_receipt_lines.unit_cost": "-2",
  "reorder_rules.reorder_point": "-1",
  "reorder_rules.reorder_qty": "0",
};
const NON_FINITE = ["NaN", "Infinity", "-Infinity"] as const;

const key = (r: NumericRule) => `${r.table}.${r.column}`;

async function setColumn(tenantId: string, table: string, column: string, id: string, value: string) {
  await withTenant(tenantId, (tx) => tx.execute(
    sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${value}::numeric WHERE id = ${id}`,
  ));
}

function finding(result: AuditResult, check: string) {
  return result.findings.find((f) => f.check === check);
}

function idsOf(result: AuditResult, check: string): string[] {
  return (finding(result, check)?.rows ?? []).map((r) => String(r.id));
}

describe("runAudit — cannot report a false clean", () => {
  it("has a poison value and an illegal value for every audited column", () => {
    // Guards this file: a new rule without test data would go unexercised.
    expect(Object.keys(ILLEGAL).sort()).toEqual(NUMERIC_RULES.map(key).sort());
  });

  it("has a rule for every numeric column in the purchasing schema", () => {
    const tables = ([...Object.values(purchasingSchema), reorderRules] as unknown[])
      .filter((v): v is PgTable => is(v, PgTable));
    const declared = tables.flatMap((t) =>
      Object.values(getTableColumns(t))
        .filter((c) => c.columnType === "PgNumeric")
        .map((c) => `${getTableName(t)}.${c.name}`));

    expect(declared.length).toBeGreaterThanOrEqual(NUMERIC_RULES.length);
    expect(declared.sort()).toEqual(NUMERIC_RULES.map(key).sort());
    for (const t of tables) expect(PURCHASING_TABLES).toContain(getTableName(t));
  });

  it("finds every poisoned, out-of-range and drifted class across two tenants, and leaves a clean PO alone", async () => {
    // Row sets 0..N-1 take one mutation each; N is untouched; N+1.. are drift cases.
    const n = NUMERIC_RULES.length;
    const a = await seedPurchasingTenant(n + 3);
    const b = await seedPurchasingTenant(n + 3);

    const expected: { check: string; tenantId: string; id: string }[] = [];
    for (const [i, rule] of NUMERIC_RULES.entries()) {
      // Alternate which tenant carries which class, so both are iterated for both.
      const [nfTenant, oorTenant] = i % 2 === 0 ? [a, b] : [b, a];
      const nfId = rowIdFor(nfTenant.rowSets[i], rule.table);
      const oorId = rowIdFor(oorTenant.rowSets[i], rule.table);
      await setColumn(nfTenant.tenantId, rule.table, rule.column, nfId, NON_FINITE[i % NON_FINITE.length]);
      await setColumn(oorTenant.tenantId, rule.table, rule.column, oorId, ILLEGAL[key(rule)]);
      expected.push({ check: `${key(rule)}:non_finite`, tenantId: nfTenant.tenantId, id: nfId });
      expected.push({ check: `${key(rule)}:out_of_range`, tenantId: oorTenant.tenantId, id: oorId });
    }

    const clean: PurchasingRowSet = a.rowSets[n];
    // Every fixture PO totals 3 × 2.50 × 1.14 = 8.55.
    const driftByFive = b.rowSets[n];
    await withTenant(b.tenantId, (tx) => tx.update(purchaseOrders).set({ total: "13.55" }).where(eq(purchaseOrders.id, driftByFive.poId)));
    const driftByOneCent = a.rowSets[n + 1];
    await withTenant(a.tenantId, (tx) => tx.update(purchaseOrders).set({ total: "8.56" }).where(eq(purchaseOrders.id, driftByOneCent.poId)));
    const driftUnderOneCent = b.rowSets[n + 1];
    await withTenant(b.tenantId, (tx) => tx.update(purchaseOrders).set({ total: "8.559" }).where(eq(purchaseOrders.id, driftUnderOneCent.poId)));
    // A header with nothing under it: total 8.55 against no lines at all.
    const noLines = a.rowSets[n + 2];
    await withTenant(a.tenantId, async (tx) => {
      await tx.delete(poReceiptLines).where(eq(poReceiptLines.poLineId, noLines.poLineId));
      await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.poId, noLines.poId));
    });
    // Two lines, one poisoned: summing only the finite line would "find" a
    // drift of exactly the poisoned line's value against a correct header.
    const [itemX, itemY] = [await seedItem(b.tenantId), await seedItem(b.tenantId)];
    const { poId: partlyPoisonedPo } = await createDraftPo(b.actor, {
      supplierId: b.supplierId, branchId: b.branchId,
      lines: [
        { itemId: itemX, qtyOrdered: 1, uom: "each", unitCost: 10 },
        { itemId: itemY, qtyOrdered: 1, uom: "each", unitCost: 10 },
      ],
    });
    const [poisonedLine] = await withTenant(b.tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.itemId, itemY)));
    await setColumn(b.tenantId, "purchase_order_lines", "tax_rate", poisonedLine.id, "NaN");

    const result = await runAudit(pool);

    expect(result.bypass).toBe(false); // the app role: found through RLS, tenant by tenant
    expect(result.tenantCount).toBe(2);
    expect(result.status).toBe("findings");
    expect(result.refusal).toBeNull();
    expect(finding(result, "schema:unaudited_column")).toBeUndefined();

    for (const e of expected) {
      const rows = finding(result, e.check)?.rows ?? [];
      expect(rows.map((r) => r.id), e.check).toContain(e.id);
      expect(rows.find((r) => r.id === e.id)?.tenant_id, e.check).toBe(e.tenantId);
    }

    const drift = idsOf(result, "purchase_orders.total:drift");
    expect(drift).toContain(driftByFive.poId);
    expect(drift).toContain(driftByOneCent.poId); // >= 0.01, not > 0.01
    expect(drift).toContain(noLines.poId);
    expect(drift).not.toContain(driftUnderOneCent.poId);
    expect(drift).not.toContain(partlyPoisonedPo);
    expect(idsOf(result, "purchase_order_lines.tax_rate:non_finite")).toContain(poisonedLine.id);

    const reported = new Set(result.findings.flatMap((f) => f.rows.map((r) => String(r.id))));
    for (const id of Object.values(clean)) expect(reported.has(id), `clean row ${id} was flagged`).toBe(false);
  });

  it("reports CLEAN for a database whose purchasing rows are all legal", async () => {
    await seedPurchasingTenant(2);
    await seedPurchasingTenant(1);

    const result = await runAudit(pool);

    expect(result.findings).toEqual([]);
    expect(result.status).toBe("clean");
    expect(result.scanned.purchase_order_lines).toBe(3);
  });

  it("refuses to report on an empty database", async () => {
    const result = await runAudit(pool);

    expect(result.tenantCount).toBe(0);
    expect(result.status).toBe("refused");
    expect(result.refusal).toMatch(/no tenants/);
  });

  it("refuses to report when tenants exist but no purchasing row is visible", async () => {
    const { tenantId } = await seedPurchasingTenant(1);
    await withTenant(tenantId, async (tx) => {
      await tx.delete(poReceiptLines);
      await tx.delete(reorderRules);
      await tx.execute(sql`DELETE FROM po_receipts`);
      await tx.delete(purchaseOrderLines);
      await tx.delete(purchaseOrders);
      await tx.execute(sql`DELETE FROM supplier_items`);
      await tx.execute(sql`DELETE FROM suppliers`);
    });

    const result = await runAudit(pool);

    expect(result.status).toBe("refused");
    expect(result.refusal).toMatch(/zero purchasing rows/);
  });

  it("refuses rather than reports clean when RLS hides poisoned rows from it", async () => {
    const t = await seedPurchasingTenant(1);
    await setColumn(t.tenantId, "purchase_order_lines", "unit_cost", t.rowSets[0].poLineId, "NaN");

    // A pool that wrongly claims this role bypasses RLS, so the audit runs one
    // unscoped pass. FORCE RLS shows it zero rows: the poison is invisible.
    const lying: AuditPool = {
      query: ((text: string, params?: unknown[]) => /pg_roles/.test(text)
        ? Promise.resolve({ rows: [{ bypass: true, who: "serveos_app" }] })
        : pool.query(text, params)) as AuditPool["query"],
      connect: (() => pool.connect()) as AuditPool["connect"],
    };

    const result = await runAudit(lying);

    expect(result.findings.filter((f) => f.kind !== "unaudited_column")).toEqual([]);
    expect(Object.values(result.scanned).every((v) => v === 0)).toBe(true);
    expect(result.status).toBe("refused");
  });
});

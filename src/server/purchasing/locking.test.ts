import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { products, categories } from "@/server/catalog/schema";
import { seedInventoryTenant, seedItem, seedLocation } from "@/server/inventory/test-helpers";
import { inventoryLots, productInventoryLinks } from "@/server/inventory/schema";
import { adjustStock } from "@/server/inventory/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { purchaseOrders, purchaseOrderLines } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { createSupplier, upsertSupplierItem, updateSupplier } from "./suppliers";
import { reorderRules } from "./reorder-schema";
import { upsertReorderRule, checkReorder } from "./reorder";
import { createDraftPo, updateDraftPo, cancelPurchaseOrder } from "./service";
import { sendPurchaseOrder } from "./send";
import { postReceipt } from "./receiving";

/**
 * Deadlock regression suite for the lock-ordering rule in ./locking.ts:
 * rows first, tenant advisory key last. Both halves of that rule have been
 * broken in this codebase before, in opposite directions, and each break was
 * invisible to every other test:
 *
 *   - checkReorder took the key first, then UPDATEd an open draft PO   -> 12/12
 *   - the fix hoisted the key into every purchasing writer, inverting
 *     purchasing against every OTHER domain's "key last" order, so
 *     postReceipt (-> syncLinkedSellable -> UPDATE products) collided
 *     with adjustStock                                                 -> 11/12
 *
 * So this covers BOTH directions: purchasing against itself, and purchasing
 * against a neighbouring domain that writes the same rows. Verified to
 * reproduce on the two commits above and to be clean here.
 */
const ROUNDS = 6;

function is40P01(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    if ((cur as { code?: string }).code === "40P01") return true;
    const m = (cur as { message?: string }).message;
    if (typeof m === "string" && /deadlock detected/i.test(m)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function tally(round: () => Promise<unknown[]>) {
  let dl = 0, ok = 0, other = 0;
  for (let i = 0; i < ROUNDS; i++) {
    for (const r of (await round()) as PromiseSettledResult<unknown>[]) {
      if (r.status === "fulfilled") ok++;
      else if (is40P01(r.reason)) dl++;
      else other++;
    }
  }
  return dl;
}

async function seedActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [u] = await db.insert(users).values({
    tenantId, name: "O", email: `o-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: u.id, vertical: "restaurant" as const };
}

/** An item mirrored onto a `products` row — the shared resource that made
 *  postReceipt collide with adjustStock. */
async function seedLinkedItem(tenantId: string, branchId: string) {
  const itemId = await seedItem(tenantId, { baseUom: "each", nameEn: "Cola" });
  const locationId = await seedLocation(tenantId, branchId, "kitchen");
  const [cat] = await withTenant(tenantId, (tx) => tx.insert(categories).values({
    tenantId, nameEn: "Cat", nameAr: "فئة",
  }).returning({ id: categories.id }));
  const [p] = await withTenant(tenantId, (tx) => tx.insert(products).values({
    tenantId, categoryId: cat.id, nameEn: "Cola", nameAr: "كولا", basePrice: "10", trackStock: true,
  }).returning({ id: products.id }));
  await withTenant(tenantId, (tx) => tx.insert(productInventoryLinks).values({
    tenantId, productId: p.id, itemId, variantId: null, linkType: "finished_good",
  }));
  return { itemId, locationId, productId: p.id };
}

async function sentPo(actor: PurchasingActor, supplierId: string, itemId: string) {
  const { poId } = await createDraftPo(actor, {
    supplierId, branchId: actor.branchId,
    lines: [{ itemId, qtyOrdered: 100, uom: "each", unitCost: 1 }],
  });
  await withTenant(actor.tenantId, (tx) =>
    tx.update(purchaseOrders).set({ status: "sent" }).where(eq(purchaseOrders.id, poId)));
  const [l] = await withTenant(actor.tenantId, (tx) =>
    tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
  return { poId, poLineId: l.id };
}

async function buildMergeState() {
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedActor(tenantId, branchId);
  const supplierId = await createSupplier(actor, { name: "S", email: "s@x.com" });
  const a = await seedItem(tenantId, { baseUom: "g", nameEn: "A" });
  const b = await seedItem(tenantId, { baseUom: "g", nameEn: "B" });
  const locationId = await seedLocation(tenantId, branchId, "kitchen");
  for (const itemId of [a, b]) {
    await upsertSupplierItem(actor, { supplierId, itemId, lastUnitCost: 2 });
    await upsertReorderRule(actor, { itemId, locationId, reorderPoint: 20, reorderQty: 10, preferredSupplierId: supplierId });
  }
  for (const [itemId, q] of [[a, 5], [b, 999]] as const) {
    await withTenant(tenantId, (tx) => tx.insert(inventoryLots).values({
      tenantId, itemId, locationId, qtyReceived: String(q), qtyRemaining: String(q), unitCost: "1",
    }));
  }
  await checkReorder(actor);
  const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
  await withTenant(tenantId, (tx) =>
    tx.update(inventoryLots).set({ qtyRemaining: "1" }).where(eq(inventoryLots.itemId, b)));
  await withTenant(tenantId, (tx) => tx.update(reorderRules).set({ lastAlertedAt: null }));
  return { tenantId, branchId, actor, supplierId, poId: po.id as string, itemA: a, locationId };
}

describe("lock ordering — deadlock regressions", () => {
  it("postReceipt || adjustStock (the pairing the last fix broke)", async () => {
    const dl = await tally(async () => {
      const { tenantId, branchId } = await seedInventoryTenant();
      const actor = await seedActor(tenantId, branchId);
      const supplierId = await createSupplier(actor, { name: "S", email: "s@x.com" });
      const { itemId, locationId } = await seedLinkedItem(tenantId, branchId);
      const { poId, poLineId } = await sentPo(actor, supplierId, itemId);
      await withTenant(tenantId, (tx) => tx.insert(inventoryLots).values({
        tenantId, itemId, locationId, qtyReceived: "50", qtyRemaining: "50", unitCost: "1",
      }));
      return Promise.allSettled([
        postReceipt(actor, poId, { lines: [{ poLineId, receivedQty: 5, uom: "each", unitCost: 1 }] }),
        withTenant(tenantId, (tx) => adjustStock(tx, {
          tenantId, itemId, locationId, baseQty: -1, uom: "each",
          audit: { actorUserId: actor.actorUserId, fingerprint: emptyFingerprint() },
        })),
      ]);
    });
    expect(dl).toBe(0);
  });

  it("checkReorder || PO writers, and || itself", async () => {
    const build = async () => {
      const { tenantId, branchId } = await seedInventoryTenant();
      const actor = await seedActor(tenantId, branchId);
      const supplierId = await createSupplier(actor, { name: "S", email: "s@x.com" });
      const a = await seedItem(tenantId, { baseUom: "g", nameEn: "A" });
      const b = await seedItem(tenantId, { baseUom: "g", nameEn: "B" });
      const locationId = await seedLocation(tenantId, branchId, "kitchen");
      for (const itemId of [a, b]) {
        await upsertSupplierItem(actor, { supplierId, itemId, lastUnitCost: 2 });
        await upsertReorderRule(actor, { itemId, locationId, reorderPoint: 20, reorderQty: 10, preferredSupplierId: supplierId });
      }
      for (const [itemId, q] of [[a, 5], [b, 999]] as const) {
        await withTenant(tenantId, (tx) => tx.insert(inventoryLots).values({
          tenantId, itemId, locationId, qtyReceived: String(q), qtyRemaining: String(q), unitCost: "1",
        }));
      }
      await checkReorder(actor);                       // draft holding only A
      const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
      await withTenant(tenantId, (tx) =>
        tx.update(inventoryLots).set({ qtyRemaining: "1" }).where(eq(inventoryLots.itemId, b)));
      await withTenant(tenantId, (tx) => tx.update(reorderRules).set({ lastAlertedAt: null }));
      return { tenantId, branchId, actor, supplierId, poId: po.id as string, itemA: a, locationId };
    };

    let total = 0;
    total += await tally(async () => {
      const s = await build();
      return Promise.allSettled([
        updateDraftPo(s.actor, s.poId, {
          supplierId: s.supplierId, branchId: s.branchId,
          lines: [{ itemId: s.itemA, qtyOrdered: 7, uom: "g", unitCost: 2 }],
        }),
        checkReorder(s.actor),
      ]);
    });
    total += await tally(async () => {
      const s = await build();
      return Promise.allSettled([sendPurchaseOrder(s.actor, s.poId), checkReorder(s.actor)]);
    });
    total += await tally(async () => {
      const s = await build();
      return Promise.allSettled([cancelPurchaseOrder(s.actor, s.poId), checkReorder(s.actor)]);
    });
    total += await tally(async () => {
      const s = await build();
      return Promise.allSettled([
        upsertReorderRule(s.actor, { itemId: s.itemA, locationId: s.locationId, reorderPoint: 30, reorderQty: 10, preferredSupplierId: s.supplierId }),
        checkReorder(s.actor),
      ]);
    });
    total += await tally(async () => {
      const s = await build();
      return Promise.allSettled([checkReorder(s.actor), checkReorder(s.actor)]);
    });
    expect(total).toBe(0);
  });

  it("createDraftPo || createDraftPo keeps po_number unique, and || updateSupplier", async () => {
    const dl = await tally(async () => {
      const { tenantId, branchId } = await seedInventoryTenant();
      const actor = await seedActor(tenantId, branchId);
      const supplierId = await createSupplier(actor, { name: "S", email: "s@x.com" });
      const itemId = await seedItem(tenantId, { baseUom: "each" });
      const mk = () => createDraftPo(actor, {
        supplierId, branchId, lines: [{ itemId, qtyOrdered: 1, uom: "each", unitCost: 1 }],
      });
      const out = await Promise.allSettled([mk(), mk(), mk()]);
      const nums = (await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders))).map((p) => p.poNumber);
      expect(new Set(nums).size).toBe(nums.length);
      // Uniqueness alone is not enough: without the numbering lock the losing
      // insert is REJECTED by UNIQUE (tenant_id, po_number), leaving 2 unique
      // rows and a failed request. All three must succeed.
      expect(out.filter((r) => r.status === "rejected")).toHaveLength(0);
      expect(nums).toHaveLength(3);
      return out;
    });
    const dl2 = await tally(async () => {
      const { tenantId, branchId } = await seedInventoryTenant();
      const actor = await seedActor(tenantId, branchId);
      const supplierId = await createSupplier(actor, { name: "S", email: "s@x.com" });
      const itemId = await seedItem(tenantId, { baseUom: "each" });
      return Promise.allSettled([
        createDraftPo(actor, { supplierId, branchId, lines: [{ itemId, qtyOrdered: 1, uom: "each", unitCost: 1 }] }),
        updateSupplier(actor, supplierId, { name: "S renamed" }),
      ]);
    });
    expect(dl + dl2).toBe(0);
  });

  it("concurrent sweeps merging the same draft do not lose the update", async () => {
    // FOR UPDATE on the open draft is what makes the merge a read-modify-write
    // under a lock. Without it both sweeps read the same `open.total` and the
    // same "covered items" set, so both append the line and one total is lost.
    const s = await buildMergeState();
    await Promise.allSettled([checkReorder(s.actor), checkReorder(s.actor)]);

    const pos = await withTenant(s.tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos).toHaveLength(1);
    const lines = await withTenant(s.tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, s.poId)));
    // A and B exactly once — not B twice.
    expect(lines).toHaveLength(2);
    const sum = lines.reduce((n, l) => n + Number(l.qtyOrdered) * Number(l.unitCost), 0);
    expect(Number(pos[0].total)).toBeCloseTo(sum, 2);
  });

  it("a sweep drafting a new PO alongside createDraftPo keeps po_number unique", async () => {
    // Both paths do MAX(po_number)+1; both must take the same numbering lock or
    // they collide on UNIQUE (tenant_id, po_number).
    const dl = await tally(async () => {
      const { tenantId, branchId } = await seedInventoryTenant();
      const actor = await seedActor(tenantId, branchId);
      const supplierId = await createSupplier(actor, { name: "S", email: "s@x.com" });
      const a = await seedItem(tenantId, { baseUom: "g", nameEn: "A" });
      const other = await seedItem(tenantId, { baseUom: "each", nameEn: "Other" });
      const locationId = await seedLocation(tenantId, branchId, "kitchen");
      await upsertSupplierItem(actor, { supplierId, itemId: a, lastUnitCost: 2 });
      await upsertReorderRule(actor, { itemId: a, locationId, reorderPoint: 20, reorderQty: 10, preferredSupplierId: supplierId });
      await withTenant(tenantId, (tx) => tx.insert(inventoryLots).values({
        tenantId, itemId: a, locationId, qtyReceived: "5", qtyRemaining: "5", unitCost: "1",
      }));
      const out = await Promise.allSettled([
        checkReorder(actor),
        createDraftPo(actor, { supplierId, branchId, lines: [{ itemId: other, qtyOrdered: 1, uom: "each", unitCost: 1 }] }),
      ]);
      const nums = (await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders))).map((p) => p.poNumber);
      expect(new Set(nums).size).toBe(nums.length);
      expect(out.filter((r) => r.status === "rejected")).toHaveLength(0);
      return out;
    });
    expect(dl).toBe(0);
  });

  it("a merge racing updateDraftPo leaves the header consistent with its lines", async () => {
    // Both sides read-modify-write the same purchase_orders row: the merge adds
    // a line and bumps the total, updateDraftPo rewrites the lines and the
    // total. FOR UPDATE on the draft is what serializes them; without it the
    // last writer wins and the stored total no longer describes the stored lines.
    for (let i = 0; i < 6; i++) {
      const s = await buildMergeState();
      await Promise.allSettled([
        updateDraftPo(s.actor, s.poId, {
          supplierId: s.supplierId, branchId: s.branchId,
          lines: [{ itemId: s.itemA, qtyOrdered: 7, uom: "g", unitCost: 3 }],
        }),
        checkReorder(s.actor),
      ]);
      const [po] = await withTenant(s.tenantId, (tx) =>
        tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, s.poId)));
      const lines = await withTenant(s.tenantId, (tx) =>
        tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, s.poId)));
      const sum = lines.reduce((n, l) => n + Number(l.qtyOrdered) * Number(l.unitCost) * (1 + Number(l.taxRate ?? 0)), 0);
      expect(Number(po.total), `round ${i}: header ${po.total} vs lines ${sum}`).toBeCloseTo(sum, 2);
    }
  });
});

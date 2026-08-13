import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import {
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  deleteBranch,
} from "./service";
import { BranchNotFoundError } from "./errors";

async function makeTenant(slug = "t1") {
  const [t] = await db.insert(tenants).values({ slug, name: "Test", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("branches service", () => {
  // The seeding failure this guards: with a connection whose role BYPASSES RLS
  // (superuser — which the maintenance scripts use), listBranches returned a
  // DIFFERENT tenant's branch. The caller then handed that foreign id to an
  // ownership-checked update, which matched no rows and threw
  // "Branch not found". The query now carries its own tenant predicate.
  //
  // Note this test's own role has RLS enforced, so it would also pass without
  // the predicate. It pins the contract — a tenant's list is its own — rather
  // than reproducing the superuser case, which needs a privileged connection
  // the suite deliberately does not have.
  it("lists only the asking tenant's branches, never another's", async () => {
    const a = await makeTenant("scope-a");
    const b = await makeTenant("scope-b");
    const aBranch = await createBranch(a.id, { name: "A Main" });

    expect(await listBranches(b.id)).toEqual([]);

    const bBranch = await createBranch(b.id, { name: "B Main" });
    const aList = await listBranches(a.id);
    const bList = await listBranches(b.id);
    expect(aList.map((x) => x.id)).toEqual([aBranch.id]);
    expect(bList.map((x) => x.id)).toEqual([bBranch.id]);
  });

  it("creates and lists branches within tenant context", async () => {
    const t = await makeTenant();
    const b = await createBranch(t.id, { name: "Main Branch" });
    expect(b.name).toBe("Main Branch");
    expect(b.tenantId).toBe(t.id);
    const list = await listBranches(t.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.id);
  });

  it("getBranch throws BranchNotFoundError for unknown id", async () => {
    const t = await makeTenant("t2");
    await expect(getBranch(t.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(BranchNotFoundError);
  });

  it("updateBranch changes name", async () => {
    const t = await makeTenant("t3");
    const b = await createBranch(t.id, { name: "Old" });
    const updated = await updateBranch(t.id, b.id, { name: "New" });
    expect(updated.name).toBe("New");
  });

  it("deleteBranch soft-deletes (sets is_active=false)", async () => {
    const t = await makeTenant("t4");
    const b = await createBranch(t.id, { name: "Branch" });
    await deleteBranch(t.id, b.id);
    const all = await listBranches(t.id);
    expect(all).toHaveLength(0); // listBranches only returns active
    const found = await getBranch(t.id, b.id);
    expect(found.isActive).toBe(false);
  });

  it("createBranch throws QuotaExceededError when plan limit reached", async () => {
    // basic plan limit: branches = 1 (see src/server/subscription/plans.seed.ts)
    const t = await makeTenant("t5");
    const { QuotaExceededError } = await import("@/server/entitlements/errors");
    await createBranch(t.id, { name: "B1" }); // uses the 1 allowed branch
    await expect(createBranch(t.id, { name: "B2" })).rejects.toThrow(QuotaExceededError);
  });

  it("RLS: tenant A cannot see tenant B branches", async () => {
    const a = await makeTenant("rls-a");
    const b = await makeTenant("rls-b");
    await createBranch(a.id, { name: "A-Branch" });
    const bList = await listBranches(b.id);
    expect(bList).toHaveLength(0);
  });
});

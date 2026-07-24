import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { listOfflineMethods, listEnabledOfflineMethods, upsertOfflineMethod, deleteOfflineMethod, isMethodEnabled } from "./methods";

async function tenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}

describe("offline methods service", () => {
  it("creates, lists (all + enabled), checks, and deletes methods", async () => {
    const t = await tenant("om-svc1");
    const vc = await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash", payToDetail: "01001234567" });
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "shop@instapay", enabled: false });
    expect((await listOfflineMethods(t.id)).length).toBe(2);
    expect((await listEnabledOfflineMethods(t.id)).map((m) => m.type)).toEqual(["vodafone_cash"]);
    expect(await isMethodEnabled(t.id, "vodafone_cash")).toBe(true);
    expect(await isMethodEnabled(t.id, "instapay")).toBe(false);
    await deleteOfflineMethod(t.id, vc.id);
    expect((await listOfflineMethods(t.id)).length).toBe(1);
  });

  it("updates an existing method by id", async () => {
    const t = await tenant("om-svc2");
    const m = await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const updated = await upsertOfflineMethod(t.id, { id: m.id, type: "instapay", label: "InstaPay", payToDetail: "b@instapay", enabled: true });
    expect(updated.payToDetail).toBe("b@instapay");
    expect((await listOfflineMethods(t.id)).length).toBe(1);
  });

  it("dedupes concurrent/no-id creates of the same type via DB unique index + onConflictDoUpdate", async () => {
    const t = await tenant("om-svc3");
    await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash", payToDetail: "01001234567" });
    await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash (updated)", payToDetail: "01009999999" });
    const rows = (await listOfflineMethods(t.id)).filter((m) => m.type === "vodafone_cash");
    expect(rows.length).toBe(1);
    expect(rows[0].payToDetail).toBe("01009999999");
    expect(rows[0].label).toBe("Vodafone Cash (updated)");
  });
});

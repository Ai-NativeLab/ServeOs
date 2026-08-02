import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { whatsappConversations } from "./schema";

describe("whatsapp_conversations", () => {
  it("holds at most one conversation per (tenant, waId)", async () => {
    const [t] = await db.insert(tenants).values({ slug: "wa-conv-1", name: "T", country: "EG", vertical: "restaurant" }).returning();
    await withTenant(t.id, (tx) => tx.insert(whatsappConversations).values({
      tenantId: t.id, waId: "201111111111", state: "idle", cart: [],
    }));
    await expect(
      withTenant(t.id, (tx) => tx.insert(whatsappConversations).values({
        tenantId: t.id, waId: "201111111111", state: "idle", cart: [],
      })),
    ).rejects.toThrow();
  });

  it("is invisible outside its tenant (FORCE RLS)", async () => {
    const [a] = await db.insert(tenants).values({ slug: "wa-conv-2", name: "A", country: "EG", vertical: "restaurant" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "wa-conv-3", name: "B", country: "EG", vertical: "restaurant" }).returning();
    await withTenant(a.id, (tx) => tx.insert(whatsappConversations).values({
      tenantId: a.id, waId: "2012", state: "idle", cart: [],
    }));
    const seen = await withTenant(b.id, (tx) => tx.select().from(whatsappConversations));
    expect(seen).toHaveLength(0);
  });
});

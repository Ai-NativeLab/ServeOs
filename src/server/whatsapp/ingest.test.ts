import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { whatsappAccounts, whatsappMessages } from "./schema";
import { ingestWebhook } from "./ingest";

const SECRET = "app-secret";
const sign = (b: string) => "sha256=" + createHmac("sha256", SECRET).update(b).digest("hex");

process.env.WHATSAPP_APP_SECRET = SECRET;

const payload = (pnId: string, wamid: string) => JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{
    id: "e", changes: [{
      field: "messages",
      value: {
        metadata: { phone_number_id: pnId },
        contacts: [{ profile: { name: "A" }, wa_id: "201111111111" }],
        messages: [{ from: "201111111111", id: wamid, timestamp: "1750000000", type: "text", text: { body: "hi" } }],
      },
    }],
  }],
});

async function seedLinkedTenant(slug: string, pnId: string) {
  // status must be servable — a fresh tenant defaults to "onboarding" and the
  // ingest gate (correctly) refuses to take orders for it.
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant", status: "active" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro"); // pro has whatsapp: true
  await db.insert(whatsappAccounts).values({
    tenantId: t.id, wabaId: "w", phoneNumberId: pnId,
    displayPhoneNumber: "+20100", tokenRef: "env://X", status: "active",
  });
  return t.id;
}

describe("ingestWebhook", () => {
  it("rejects an unsigned payload without writing anything", async () => {
    await seedLinkedTenant("wa-ing-1", "pn-i1");
    const body = payload("pn-i1", "wamid.unsigned");
    await expect(ingestWebhook(body, null)).rejects.toThrow(/signature/i);
    const rows = await db.select().from(whatsappMessages);
    expect(rows.find((r) => r.providerMessageId === "wamid.unsigned")).toBeUndefined();
  });

  it("accepts a signed message for a linked tenant", async () => {
    await seedLinkedTenant("wa-ing-2", "pn-i2");
    const body = payload("pn-i2", "wamid.ok");
    expect(await ingestWebhook(body, sign(body))).toEqual({ accepted: 1, skipped: 0 });
  });

  it("skips a replayed message", async () => {
    await seedLinkedTenant("wa-ing-3", "pn-i3");
    const body = payload("pn-i3", "wamid.replay");
    await ingestWebhook(body, sign(body));
    expect(await ingestWebhook(body, sign(body))).toEqual({ accepted: 0, skipped: 1 });
  });

  it("skips a message for an unknown phone number id", async () => {
    const body = payload("pn-unknown", "wamid.orphan");
    expect(await ingestWebhook(body, sign(body))).toEqual({ accepted: 0, skipped: 1 });
  });

  it("routes each entry of a multi-tenant batch to its own tenant", async () => {
    const t1 = await seedLinkedTenant("wa-ing-4", "pn-i4");
    const t2 = await seedLinkedTenant("wa-ing-5", "pn-i5");
    const merged = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        JSON.parse(payload("pn-i4", "wamid.b1")).entry[0],
        JSON.parse(payload("pn-i5", "wamid.b2")).entry[0],
      ],
    });
    expect(await ingestWebhook(merged, sign(merged))).toEqual({ accepted: 2, skipped: 0 });

    // whatsapp_messages carries FORCE RLS, so each tenant's read proves both
    // the routing AND the isolation: t1 sees exactly its message, never t2's.
    const rows1 = await withTenant(t1, (tx) => tx.select().from(whatsappMessages));
    const rows2 = await withTenant(t2, (tx) => tx.select().from(whatsappMessages));
    expect(rows1.map((r) => r.providerMessageId)).toEqual(["wamid.b1"]);
    expect(rows2.map((r) => r.providerMessageId)).toEqual(["wamid.b2"]);
  });

  it("skips a suspended tenant so its bot stops taking orders", async () => {
    await seedLinkedTenant("wa-ing-6", "pn-i6");
    await db.update(tenants).set({ status: "suspended" });
    const body = payload("pn-i6", "wamid.susp");
    expect(await ingestWebhook(body, sign(body))).toEqual({ accepted: 0, skipped: 1 });
  });
});

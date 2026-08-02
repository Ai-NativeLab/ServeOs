import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { whatsappAccounts } from "./schema";

describe("whatsapp_accounts", () => {
  it("allows only one ACTIVE row per phoneNumberId, but permits relinking after disconnect", async () => {
    const [a] = await db.insert(tenants).values({ slug: "wa-a", name: "A", country: "EG", vertical: "restaurant" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "wa-b", name: "B", country: "EG", vertical: "restaurant" }).returning();

    await db.insert(whatsappAccounts).values({
      tenantId: a.id, wabaId: "waba-1", phoneNumberId: "pn-1",
      displayPhoneNumber: "+201000000000", tokenRef: "sm://wa/a", status: "active",
    });

    // A second ACTIVE claim on the same number must fail.
    await expect(
      db.insert(whatsappAccounts).values({
        tenantId: b.id, wabaId: "waba-2", phoneNumberId: "pn-1",
        displayPhoneNumber: "+201000000000", tokenRef: "sm://wa/b", status: "active",
      }),
    ).rejects.toThrow();

    // Disconnecting the first frees the number for a new owner.
    await db.update(whatsappAccounts).set({ status: "disconnected" });
    await expect(
      db.insert(whatsappAccounts).values({
        tenantId: b.id, wabaId: "waba-2", phoneNumberId: "pn-1",
        displayPhoneNumber: "+201000000000", tokenRef: "sm://wa/b", status: "active",
      }),
    ).resolves.toBeDefined();
  });
});

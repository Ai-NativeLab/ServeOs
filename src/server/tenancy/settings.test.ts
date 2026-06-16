import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "./schema";
import { getVatRate, setVatRate, getTenantSettings } from "./settings";

async function makeTenant(slug: string, country = "EG") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country }).returning();
  return t;
}

describe("tenant VAT settings", () => {
  it("defaults to 14 for EG and 15 for SA when unset", async () => {
    const eg = await makeTenant("vat-eg", "EG");
    const sa = await makeTenant("vat-sa", "SA");
    expect(await getVatRate(eg.id)).toBe(14);
    expect(await getVatRate(sa.id)).toBe(15);
  });
  it("setVatRate overrides the default and persists", async () => {
    const t = await makeTenant("vat-set", "EG");
    await setVatRate(t.id, 10);
    expect(await getVatRate(t.id)).toBe(10);
    expect((await getTenantSettings(t.id)).vatRate).toBe(10);
  });
});

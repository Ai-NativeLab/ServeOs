import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { listBanners, createBanner, updateBanner, deleteBanner, getActiveBanners } from "./service";

async function makeTenant(slug = "bn1") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}

describe("banners service", () => {
  it("creates and lists banners", async () => {
    const t = await makeTenant();
    const b = await createBanner(t.id, { imageUrl: "https://example.com/img.jpg" });
    expect(b.imageUrl).toBe("https://example.com/img.jpg");
    expect(await listBanners(t.id)).toHaveLength(1);
  });

  it("getActiveBanners returns only active banners within date range", async () => {
    const t = await makeTenant("bn2");
    const now = new Date();
    const past = new Date(now.getTime() - 1000 * 60 * 60);
    const future = new Date(now.getTime() + 1000 * 60 * 60);
    // active, no dates
    await createBanner(t.id, { imageUrl: "a.jpg", isActive: true });
    // active, within range
    await createBanner(t.id, { imageUrl: "b.jpg", isActive: true, startsAt: past, endsAt: future });
    // expired
    await createBanner(t.id, { imageUrl: "c.jpg", isActive: true, endsAt: past });
    // not yet started
    await createBanner(t.id, { imageUrl: "d.jpg", isActive: true, startsAt: future });
    // inactive
    await createBanner(t.id, { imageUrl: "e.jpg", isActive: false });
    const active = await getActiveBanners(t.id);
    expect(active.map((b) => b.imageUrl).sort()).toEqual(["a.jpg", "b.jpg"]);
  });

  it("updateBanner changes fields", async () => {
    const t = await makeTenant("bn3");
    const b = await createBanner(t.id, { imageUrl: "old.jpg" });
    const updated = await updateBanner(t.id, b.id, { imageUrl: "new.jpg" });
    expect(updated.imageUrl).toBe("new.jpg");
  });

  it("deleteBanner removes it", async () => {
    const t = await makeTenant("bn4");
    const b = await createBanner(t.id, { imageUrl: "x.jpg" });
    await deleteBanner(t.id, b.id);
    expect(await listBanners(t.id)).toHaveLength(0);
  });

  it("RLS: tenant A cannot see tenant B banners", async () => {
    const a = await makeTenant("rls-ban-a");
    const b = await makeTenant("rls-ban-b");
    await createBanner(a.id, { imageUrl: "a.jpg" });
    expect(await listBanners(b.id)).toHaveLength(0);
  });

  it("getActiveBanners includes banners that started in the past", async () => {
    const t = await makeTenant("bn-start");
    const past = new Date(Date.now() - 60_000);
    await createBanner(t.id, { imageUrl: "past.jpg", isActive: true, startsAt: past });
    const active = await getActiveBanners(t.id);
    expect(active.map((b) => b.imageUrl)).toContain("past.jpg");
  });

  it("getActiveBanners excludes banners whose startsAt is in the future", async () => {
    const t = await makeTenant("bn-future");
    const future = new Date(Date.now() + 60_000);
    await createBanner(t.id, { imageUrl: "future.jpg", isActive: true, startsAt: future });
    const active = await getActiveBanners(t.id);
    expect(active.map((b) => b.imageUrl)).not.toContain("future.jpg");
  });
});

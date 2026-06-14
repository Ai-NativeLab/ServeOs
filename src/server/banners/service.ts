import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { banners, type Banner, type NewBanner } from "./schema";
import { BannerNotFoundError } from "./errors";

export type CreateBannerInput = Partial<Omit<NewBanner, "id" | "tenantId" | "createdAt">> & { imageUrl: string };
export type UpdateBannerInput = Partial<Omit<NewBanner, "id" | "tenantId" | "createdAt">>;

export async function listBanners(tenantId: string): Promise<Banner[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(banners).orderBy(banners.sortOrder),
  );
}

export async function createBanner(tenantId: string, input: CreateBannerInput): Promise<Banner> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(banners).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateBanner(tenantId: string, bannerId: string, input: UpdateBannerInput): Promise<Banner> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(banners).set(input).where(and(eq(banners.id, bannerId), eq(banners.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BannerNotFoundError();
  return row;
}

export async function deleteBanner(tenantId: string, bannerId: string): Promise<void> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.delete(banners).where(and(eq(banners.id, bannerId), eq(banners.tenantId, tenantId))).returning({ id: banners.id }),
  );
  if (!row) throw new BannerNotFoundError();
}

export async function getActiveBanners(tenantId: string): Promise<Banner[]> {
  const now = new Date();
  return withTenant(tenantId, (tx) =>
    tx.select().from(banners).where(
      and(
        eq(banners.isActive, true),
        or(isNull(banners.startsAt), lt(banners.startsAt, now)),
        or(isNull(banners.endsAt), gt(banners.endsAt, now)),
      ),
    ).orderBy(banners.sortOrder),
  );
}

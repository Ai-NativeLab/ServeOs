import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { banners, type Banner, type NewBanner } from "./schema";
import { BannerNotFoundError } from "./errors";

export type CreateBannerInput = Partial<Omit<NewBanner, "id" | "tenantId" | "createdAt">> & { imageUrl: string };
export type UpdateBannerInput = Partial<Omit<NewBanner, "id" | "tenantId" | "createdAt">>;

function auditCtx(tenantId: string, audit?: AuditActorInput) {
  return { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
}
function auditMeta(audit: AuditActorInput | undefined, extra: Record<string, unknown> = {}) {
  return { roleKey: audit?.roleKey ?? null, ...extra };
}

export async function listBanners(tenantId: string): Promise<Banner[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(banners).orderBy(banners.sortOrder),
  );
}

export async function createBanner(tenantId: string, input: CreateBannerInput, audit?: AuditActorInput): Promise<Banner> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(banners).values({ ...input, tenantId }).returning();
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "banner.created", entityType: "banner", entityId: row.id,
      summary: `Banner created`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    return row;
  });
}

export async function updateBanner(tenantId: string, bannerId: string, input: UpdateBannerInput, audit?: AuditActorInput): Promise<Banner> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(banners).set(input).where(and(eq(banners.id, bannerId), eq(banners.tenantId, tenantId))).returning();
    if (!row) throw new BannerNotFoundError();
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "banner.updated", entityType: "banner", entityId: bannerId,
      summary: `Banner updated`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    return row;
  });
}

export async function deleteBanner(tenantId: string, bannerId: string, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.delete(banners).where(and(eq(banners.id, bannerId), eq(banners.tenantId, tenantId))).returning({ id: banners.id });
    if (!row) throw new BannerNotFoundError();
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "banner.deleted", entityType: "banner", entityId: bannerId,
      summary: `Banner deleted`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
  });
}

export async function getActiveBanners(tenantId: string): Promise<Banner[]> {
  const now = new Date();
  return withTenant(tenantId, (tx) =>
    tx.select().from(banners).where(
      and(
        eq(banners.isActive, true),
        or(isNull(banners.startsAt), lte(banners.startsAt, now)),
        or(isNull(banners.endsAt), gte(banners.endsAt, now)),
      ),
    ).orderBy(banners.sortOrder),
  );
}

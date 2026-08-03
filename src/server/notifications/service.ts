import { and, eq, inArray, or, isNull, desc, count, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users, roles, userRoles } from "@/server/auth/schema";
import { branches } from "@/server/branches/schema";
import { tenants } from "@/server/tenancy/schema";
import type { RoleKey } from "@/server/rbac/permissions";
import { CHANNELS, type Recipient } from "./channels";
import { notifications, type Notification } from "./schema";
import type { NotificationType, NotificationSeverity } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NotifyTarget = { userId: string } | { role: Extract<RoleKey, "owner" | "manager" | "staff"> };
export type NotifyChannel = "in_app" | "email";

export type NotifyEvent = {
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  targets: NotifyTarget[];
  channels: NotifyChannel[];
  /** Outbox template key; defaults to the notification type. */
  emailTemplate?: string;
  emailPayload?: Record<string, unknown>;
  /** Scopes Reply-To resolution: branch address → tenant contact → omitted. */
  branchId?: string;
};

/**
 * The one entry point every domain event calls (Specs 2/3/4/7/8/9). A cheap,
 * synchronous DB write — it NEVER touches the network; the outbox worker does.
 * Runs on the caller's tx when given, so the domain event and its
 * notifications commit or roll back together.
 *
 * Sending carries no user permission by design: the action that triggered it
 * was already authorized, exactly as placeOrder needs none.
 */
export async function notify(ctx: { tenantId: string }, event: NotifyEvent, tx?: Tx): Promise<void> {
  if (event.targets.length === 0 || event.channels.length === 0) return;
  const run = (t: Tx) => deliverAll(t, ctx.tenantId, event);
  if (tx) return run(tx);
  return withTenant(ctx.tenantId, run);
}

async function deliverAll(tx: Tx, tenantId: string, event: NotifyEvent): Promise<void> {
  const recipients = event.channels.includes("email")
    ? await resolveRecipients(tx, tenantId, event.targets)
    : [];
  const replyTo = event.channels.includes("email")
    ? await resolveReplyTo(tx, tenantId, event.branchId)
    : null;

  for (const key of event.channels) {
    await CHANNELS[key].deliver({ tx, tenantId, event, targets: event.targets, recipients, replyTo });
  }
}

/** Role targets expand to every active tenant user holding the role; user
 *  targets resolve directly. Deduped — a user targeted twice gets one email. */
async function resolveRecipients(tx: Tx, tenantId: string, targets: NotifyTarget[]): Promise<Recipient[]> {
  const byId = new Map<string, Recipient>();

  const userIds = targets.flatMap((t) => ("userId" in t ? [t.userId] : []));
  if (userIds.length > 0) {
    const rows = await tx.select({ id: users.id, email: users.email }).from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, userIds), eq(users.status, "active")));
    for (const r of rows) byId.set(r.id, { userId: r.id, email: r.email });
  }

  const roleKeys = targets.flatMap((t) => ("role" in t ? [t.role] : []));
  if (roleKeys.length > 0) {
    const rows = await tx.select({ id: users.id, email: users.email })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(users.tenantId, tenantId), eq(users.status, "active"), inArray(roles.key, roleKeys)));
    for (const r of rows) byId.set(r.id, { userId: r.id, email: r.email });
  }

  return [...byId.values()];
}

/** Branch address → tenant contact → omitted; a missing Reply-To never blocks
 *  the send (spec §Edge cases) — supplier replies just have nowhere special to go. */
async function resolveReplyTo(tx: Tx, tenantId: string, branchId?: string): Promise<string | null> {
  if (branchId) {
    const [b] = await tx.select({ replyToEmail: branches.replyToEmail }).from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).limit(1);
    if (b?.replyToEmail) return b.replyToEmail;
  }
  const [t] = await tx.select({ contactEmail: tenants.contactEmail }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1);
  return t?.contactEmail ?? null;
}

export type FeedFilters = { unread?: boolean; type?: NotificationType; severity?: NotificationSeverity; limit?: number };

/** The caller's feed: their own rows plus role-broadcast rows for any role
 *  they hold. Newest first. unreadCount uses the same visibility predicate. */
export async function listNotifications(
  tenantId: string,
  userId: string,
  roleKeys: string[],
  filters: FeedFilters = {},
): Promise<{ notifications: Notification[]; unreadCount: number }> {
  return withTenant(tenantId, async (tx) => {
    const visible = or(
      eq(notifications.userId, userId),
      roleKeys.length > 0 ? inArray(notifications.targetRole, roleKeys) : sql`false`,
    );
    const conds = [visible];
    if (filters.unread) conds.push(isNull(notifications.readAt));
    if (filters.type) conds.push(eq(notifications.type, filters.type));
    if (filters.severity) conds.push(eq(notifications.severity, filters.severity));

    const rows = await tx.select().from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt))
      .limit(Math.min(filters.limit ?? 50, 200));

    const [{ value: unreadCount }] = await tx.select({ value: count() }).from(notifications)
      .where(and(visible, isNull(notifications.readAt)));

    return { notifications: rows, unreadCount: Number(unreadCount) };
  });
}

/** Marks rows the caller is permitted to see. Omitted ids = mark all. Idempotent. */
export async function markNotificationsRead(
  tenantId: string,
  userId: string,
  roleKeys: string[],
  ids?: string[],
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const visible = or(
      eq(notifications.userId, userId),
      roleKeys.length > 0 ? inArray(notifications.targetRole, roleKeys) : sql`false`,
    );
    const conds = [visible, isNull(notifications.readAt)];
    if (ids && ids.length > 0) conds.push(inArray(notifications.id, ids));
    await tx.update(notifications).set({ readAt: new Date() }).where(and(...conds));
  });
}

/** Badge count only — the layout calls this on every dashboard render. */
export async function unreadNotificationCount(tenantId: string, userId: string, roleKeys: string[]): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const visible = or(
      eq(notifications.userId, userId),
      roleKeys.length > 0 ? inArray(notifications.targetRole, roleKeys) : sql`false`,
    );
    const [{ value }] = await tx.select({ value: count() }).from(notifications)
      .where(and(visible, isNull(notifications.readAt)));
    return Number(value);
  });
}

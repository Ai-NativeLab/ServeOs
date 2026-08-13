import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { posHeldTickets } from "./tender-schema";
import { posSyncEventReceipts } from "./schema";
import { findSyncReceipt, type SyncReceipt } from "./sync-receipt";
import type { PosCashierContext } from "./require-cashier";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** One advisory-lock key per (device, clientTicketId) — same discipline as
 *  openShift's device lock: taken before the idempotency check, so two
 *  concurrent replays of the same ticket event can't both pass "not found"
 *  and race each other into `pos_held_tickets_device_client`. */
async function lockTicketIdentity(tx: Tx, deviceId: string, clientTicketId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${deviceId}:${clientTicketId}`})::bigint)`);
}

export type HeldTicketSyncOptions = {
  /** The id the device minted while holding this ticket offline (Task 4's
   *  clientTicketId). A later discard/recall sync event references THIS, not
   *  the server-minted id — an offline device never learns that id without a
   *  round trip. Null/absent for a ticket held online. */
  clientTicketId?: string;
  /** The device-claimed time; defaults to now(). */
  occurredAt?: Date;
  syncReceipt?: SyncReceipt;
};

/** Discard deletes a row — there is no createdAt to backdate, so unlike
 *  HeldTicketSyncOptions this carries no occurredAt. */
export type HeldTicketDiscardOptions = {
  clientTicketId?: string;
  syncReceipt?: SyncReceipt;
};

export async function holdTicket(
  ctx: PosCashierContext,
  label: string,
  draft: unknown,
  opts: HeldTicketSyncOptions = {},
): Promise<{ id: string }> {
  const cleanLabel = label.trim() || "Ticket";
  const id = await withTenant(ctx.tenantId, async (tx) => {
    // Natural idempotency key, the same shape as openShift's clientShiftId
    // check: a replayed hold answers from here, never from the receipt.
    if (opts.clientTicketId) {
      await lockTicketIdentity(tx, ctx.deviceId, opts.clientTicketId);

      const [existing] = await tx
        .select({ id: posHeldTickets.id })
        .from(posHeldTickets)
        .where(and(eq(posHeldTickets.deviceId, ctx.deviceId), eq(posHeldTickets.clientTicketId, opts.clientTicketId)))
        .limit(1);
      if (existing) return existing.id;
    }

    const occurredAt = opts.occurredAt ?? new Date();
    const [row] = await tx.insert(posHeldTickets).values({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      deviceId: ctx.deviceId,
      cashierUserId: ctx.cashierUserId,
      label: cleanLabel,
      draftJson: draft,
      clientTicketId: opts.clientTicketId ?? null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }).returning({ id: posHeldTickets.id });
    await recordAuditEvent(
      { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint },
      { action: "ticket.held", entityType: "held_ticket", entityId: row.id,
        summary: `Ticket "${cleanLabel}" held`, metadata: { label: cleanLabel }, actorType: "user" },
      tx,
    );

    if (opts.syncReceipt) {
      await tx.insert(posSyncEventReceipts).values({ ...opts.syncReceipt, resultJson: { id: row.id } });
    }

    return row.id;
  });
  return { id };
}

/** Branch-scoped, not device-scoped: a ticket parked at till 1 is recallable at till 2. */
export async function listHeldTickets(ctx: PosCashierContext) {
  return withTenant(ctx.tenantId, (tx) =>
    tx.select({
      id: posHeldTickets.id,
      label: posHeldTickets.label,
      draftJson: posHeldTickets.draftJson,
      cashierUserId: posHeldTickets.cashierUserId,
      createdAt: posHeldTickets.createdAt,
    })
      .from(posHeldTickets)
      .where(eq(posHeldTickets.branchId, ctx.branchId))
      .orderBy(desc(posHeldTickets.createdAt)),
  );
}

/**
 * `id` is the server id, as it always has been for the live UI (which learns
 * it from `holdTicket`/`listHeldTickets`). Pass `null` and set
 * `opts.clientTicketId` instead when discarding a ticket the device only
 * knows by the id it minted — the offline replay path.
 */
export async function discardHeldTicket(
  ctx: PosCashierContext,
  id: string | null,
  opts: HeldTicketDiscardOptions = {},
): Promise<void> {
  // Neither identifier given is a caller bug, not a domain state to report:
  // left unguarded, `eq(posHeldTickets.id, null)` matches nothing and this
  // would silently no-op while still emitting a "ticket.discarded" audit
  // event and receipt for an id of null.
  if (id === null && !opts.clientTicketId) {
    throw new Error("discardHeldTicket needs an id or opts.clientTicketId");
  }

  await withTenant(ctx.tenantId, async (tx) => {
    if (opts.clientTicketId) await lockTicketIdentity(tx, ctx.deviceId, opts.clientTicketId);

    // No natural key on this table for a discard event itself — the receipt
    // is what makes a replay of "delete this row" exactly-once. Checked after
    // the lock above (when there is one) for the same reason every other
    // service checks inside its lock: two concurrent replays of the same
    // event must not both pass this and both write a receipt.
    if (opts.syncReceipt) {
      const stored = await findSyncReceipt(opts.syncReceipt, tx);
      if (stored) return;
    }

    const where = opts.clientTicketId
      ? and(eq(posHeldTickets.deviceId, ctx.deviceId), eq(posHeldTickets.clientTicketId, opts.clientTicketId))
      : and(eq(posHeldTickets.id, id!), eq(posHeldTickets.branchId, ctx.branchId));
    await tx.delete(posHeldTickets).where(where);

    const entityId = opts.clientTicketId ?? id!;
    await recordAuditEvent(
      { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint },
      { action: "ticket.discarded", entityType: "held_ticket", entityId,
        summary: `Ticket discarded`, metadata: {}, actorType: "user" },
      tx,
    );

    if (opts.syncReceipt) {
      await tx.insert(posSyncEventReceipts).values({ ...opts.syncReceipt, resultJson: { id: entityId } });
    }
  });
}

/**
 * Recall = the renderer loads the held draft back into the cart, then
 * discards the row — until offline replay there was no server verb for that
 * second half. Deletes by `clientTicketId`, not a server id: a device that
 * recalled a ticket while offline can only name it by the id it minted.
 */
export async function recallHeldTicket(
  ctx: PosCashierContext,
  clientTicketId: string,
  opts: { syncReceipt?: SyncReceipt } = {},
): Promise<void> {
  await withTenant(ctx.tenantId, async (tx) => {
    await lockTicketIdentity(tx, ctx.deviceId, clientTicketId);

    if (opts.syncReceipt) {
      const stored = await findSyncReceipt(opts.syncReceipt, tx);
      if (stored) return;
    }

    await tx.delete(posHeldTickets).where(and(
      eq(posHeldTickets.deviceId, ctx.deviceId),
      eq(posHeldTickets.clientTicketId, clientTicketId),
    ));

    await recordAuditEvent(
      { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint },
      { action: "ticket.recalled", entityType: "held_ticket", entityId: clientTicketId,
        summary: `Ticket recalled`, metadata: {}, actorType: "user" },
      tx,
    );

    if (opts.syncReceipt) {
      await tx.insert(posSyncEventReceipts).values({ ...opts.syncReceipt, resultJson: { clientTicketId } });
    }
  });
}

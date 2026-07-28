import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { posHeldTickets } from "./tender-schema";
import type { PosCashierContext } from "./require-cashier";

export async function holdTicket(
  ctx: PosCashierContext,
  label: string,
  draft: unknown,
): Promise<{ id: string }> {
  const cleanLabel = label.trim() || "Ticket";
  const id = await withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx.insert(posHeldTickets).values({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      deviceId: ctx.deviceId,
      cashierUserId: ctx.cashierUserId,
      label: cleanLabel,
      draftJson: draft,
    }).returning({ id: posHeldTickets.id });
    await recordAuditEvent(
      { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint },
      { action: "ticket.held", entityType: "held_ticket", entityId: row.id,
        summary: `Ticket "${cleanLabel}" held`, metadata: { label: cleanLabel }, actorType: "user" },
      tx,
    );
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

export async function discardHeldTicket(ctx: PosCashierContext, id: string): Promise<void> {
  await withTenant(ctx.tenantId, async (tx) => {
    await tx.delete(posHeldTickets).where(and(
      eq(posHeldTickets.id, id),
      eq(posHeldTickets.branchId, ctx.branchId),
    ));
    await recordAuditEvent(
      { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint },
      { action: "ticket.discarded", entityType: "held_ticket", entityId: id,
        summary: `Ticket discarded`, metadata: {}, actorType: "user" },
      tx,
    );
  });
}

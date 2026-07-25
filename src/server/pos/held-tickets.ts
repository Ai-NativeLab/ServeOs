import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { posHeldTickets } from "./tender-schema";
import type { PosCashierContext } from "./require-cashier";

export async function holdTicket(
  ctx: PosCashierContext,
  label: string,
  draft: unknown,
): Promise<{ id: string }> {
  const [row] = await withTenant(ctx.tenantId, (tx) =>
    tx.insert(posHeldTickets).values({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      deviceId: ctx.deviceId,
      cashierUserId: ctx.cashierUserId,
      label: label.trim() || "Ticket",
      draftJson: draft,
    }).returning({ id: posHeldTickets.id }),
  );
  return { id: row.id };
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
  await withTenant(ctx.tenantId, (tx) =>
    tx.delete(posHeldTickets).where(and(
      eq(posHeldTickets.id, id),
      eq(posHeldTickets.branchId, ctx.branchId),
    )),
  );
}

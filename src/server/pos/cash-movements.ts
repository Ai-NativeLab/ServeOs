import { withTenant } from "@/db/with-tenant";
import { money } from "@/server/ordering/service";
import { recordAuditEvent } from "@/server/audit/service";
import { getShiftPolicy } from "@/server/tenancy/settings";
import type { Permission } from "@/server/rbac/permissions";
import { cashMovements, cashMovementTypeEnum, type CashMovement } from "./shift-schema";
import { CashMovementError, NoOpenShiftError } from "./errors";
import { resolveAuthorizer } from "./grants";
import { findOpenShift, shiftAuditCtx } from "./shifts";
import { round2 } from "./shift-math";
import type { PosCashierContext } from "./require-cashier";

export type CashMovementType = (typeof cashMovementTypeEnum.enumValues)[number];

export type CashMovementInput = {
  type: CashMovementType;
  /** A positive magnitude — the service applies the sign for the type. */
  amount: number;
  reasonCode: string;
  reasonText?: string;
  grants?: { permission: Permission; token: string }[];
};

/**
 * Cash entering or leaving the drawer outside a sale.
 *
 * The caller passes a magnitude and the service applies the sign, so the stored
 * value, the DB CHECK, and the expected-cash formula can never disagree about
 * direction: a pay-in adds, a pay-out or safe-drop subtracts, a no-sale is a
 * drawer opening that moves nothing.
 */
export async function recordCashMovement(
  ctx: PosCashierContext,
  input: CashMovementInput,
): Promise<CashMovement> {
  const magnitude = round2(input.amount);
  if (input.type === "no_sale") {
    if (magnitude !== 0) throw new CashMovementError("A no_sale records no cash");
  } else if (!(magnitude > 0)) {
    throw new CashMovementError("A movement amount must be a positive magnitude");
  }
  const signed = input.type === "pay_in" ? magnitude : input.type === "no_sale" ? 0 : -magnitude;

  const shift = await findOpenShift(ctx.tenantId, ctx.deviceId);
  if (!shift) throw new NoOpenShiftError();

  // Routine pay-outs are the cashier's own call; a large one is a manager's.
  // resolveAuthorizer returns the cashier when they hold reconciliation:manage,
  // the grant's manager otherwise, and throws PosForbiddenError if neither.
  const policy = await getShiftPolicy(ctx.tenantId);
  let authorizedByUserId: string | null = null;
  if (input.type === "pay_out" && policy.payoutThreshold > 0 && magnitude > policy.payoutThreshold) {
    const grant = input.grants?.find((g) => g.permission === "reconciliation:manage")?.token;
    authorizedByUserId = resolveAuthorizer(ctx, "reconciliation:manage", grant);
  }

  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(cashMovements)
      .values({
        tenantId: ctx.tenantId,
        shiftId: shift.id,
        type: input.type,
        amount: money(signed),
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        byUserId: ctx.cashierUserId,
        authorizedByUserId,
      })
      .returning();

    await recordAuditEvent(shiftAuditCtx(ctx), {
      action: "cash.movement",
      entityType: "cash_movement",
      entityId: row.id,
      summary: `${input.type} ${money(signed)}`,
      metadata: {
        shiftId: shift.id,
        type: input.type,
        amount: money(signed),
        reasonCode: input.reasonCode,
        authorizedByUserId,
      },
      actorType: "user",
    }, tx);

    return row;
  });
}

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { recordAuditEvent, type AuditFingerprint } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { PERMISSIONS, type Permission } from "@/server/rbac/permissions";
import type { PlaceOrderLine, LineSnapshot } from "@/server/ordering/service";
import {
  TotalMismatchError, OrderValidationError, OutOfStockError, InvalidScheduleError,
  BranchNotAcceptingOrdersError, AreaNotDeliverableError, MinimumOrderNotMetError,
} from "@/server/ordering/errors";
import { InvalidVariantError } from "@/server/catalog/errors";
import { posSyncEventReceipts } from "./schema";
import { posShifts, type CashMovementType } from "./shift-schema";
import type { PosDeviceContext } from "./require-device";
import type { PosCashierContext } from "./require-cashier";
import { posPermissionsFor } from "./cashier";
import { findSyncReceipt, lastReceiptSeq, isReplayUniqueViolation, type SyncReceipt } from "./sync-receipt";
import { resolveOfflineAuthorizer } from "./grants";
import { openShift, closeShift, recordMidShiftCount } from "./shifts";
import { recordCashMovement } from "./cash-movements";
import { holdTicket, recallHeldTicket, discardHeldTicket } from "./held-tickets";
import { recordSale, type TenderInput, type ReasonCode } from "./record-sale";
import {
  NoOpenShiftError, PosForbiddenError, PosSaleError, ShiftAlreadyOpenError, ShiftClosedError,
  CashMovementError, CashCountMismatchError,
} from "./errors";

/**
 * Every event type Task 6b's ingestion dispatcher accepts. Deliberately a
 * plain string union, not a DB enum — an unknown value here is a per-event
 * `failed` result (see applyEvent's default case), never a crash, so a wire
 * value the server doesn't recognize (an older/newer client build) degrades
 * gracefully instead of taking the whole batch down.
 */
export type SyncEventType =
  | "sale.recorded"
  | "shift.opened"
  | "shift.closed"
  | "cash.movement"
  | "count.recorded"
  | "ticket.held"
  | "ticket.recalled"
  | "ticket.discarded"
  | "grant.issued"
  | "session.signed_in";

/**
 * One offline-queued action, as the device recorded it. `occurredAt` is the
 * till's own clock (ISO 8601) — till-wins, same as record-sale.ts's replay
 * input. `actorUserId` is mandatory on EVERY event (decision #1 of the sync
 * design: no live cashier token can survive the outage that produced this
 * batch), and `authorizedByUserId` is the offline substitute for a live
 * manager grant token (decision #2) — accepted on this ingest path only; a
 * live route must never read this field off its own request body.
 */
export type SyncEvent = {
  eventId: string;
  seq: number;
  type: SyncEventType;
  occurredAt: string;
  actorUserId: string;
  authorizedByUserId?: string;
  payload: Record<string, unknown>;
};

export type SyncResult =
  | { eventId: string; status: "applied" | "duplicate"; result: Record<string, unknown>; flags?: string[] }
  | { eventId: string; status: "failed"; error: { code: string; message: string } };

/** Malformed envelope or payload — a data problem the device sent us, never a
 *  domain refusal. Kept distinct from the domain error classes below so
 *  toErrorShape can give it its own stable code. */
export class SyncEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncEventValidationError";
  }
}

/** A `type` this server build has no handler for. */
export class UnknownSyncEventTypeError extends Error {
  constructor(type: string) {
    super(`Unknown sync event type: ${type}`);
    this.name = "UnknownSyncEventTypeError";
  }
}

/** actorUserId does not name a user in this tenant. Unlike a deactivated
 *  actor (flagged, not rejected — see resolveActor), a genuinely unknown
 *  actor has no one to attribute the event to and cannot proceed. */
export class UnknownActorError extends Error {
  constructor() {
    super("actorUserId does not name a user in this tenant");
    this.name = "UnknownActorError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK_SKEW_THRESHOLD_MS = 48 * 60 * 60 * 1000;

function isClockSkewed(occurredAtIso: string): boolean {
  const t = new Date(occurredAtIso).getTime();
  return Number.isNaN(t) ? false : Math.abs(Date.now() - t) > CLOCK_SKEW_THRESHOLD_MS;
}

/** Structural checks only — every field a handler or the receipt insert
 *  needs to be well-formed before it's safe to touch the DB with it. Per-type
 *  payload shape is each handler's own job (asXPayload below). */
function validateEnvelope(e: SyncEvent): void {
  if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 1) {
    throw new SyncEventValidationError("seq must be a positive integer");
  }
  if (typeof e.type !== "string" || !e.type) throw new SyncEventValidationError("type is required");
  if (typeof e.occurredAt !== "string" || Number.isNaN(new Date(e.occurredAt).getTime())) {
    throw new SyncEventValidationError("occurredAt must be a valid ISO timestamp");
  }
  if (typeof e.actorUserId !== "string" || !UUID_RE.test(e.actorUserId)) {
    throw new SyncEventValidationError("actorUserId must be a UUID");
  }
  if (e.authorizedByUserId !== undefined && !UUID_RE.test(e.authorizedByUserId)) {
    throw new SyncEventValidationError("authorizedByUserId must be a UUID");
  }
  if (!e.payload || typeof e.payload !== "object") throw new SyncEventValidationError("payload is required");
}

/** The offline stand-in for a live PosCashierContext — permissions and status
 *  as of INGEST time, not as of when the event actually happened at the till.
 *  `flags` carries anything about the actor worth surfacing without refusing
 *  the event (today: deactivated-since-outage). */
type ResolvedActor = { userId: string; name: string; permissions: Permission[]; flags?: string[] };

async function resolveActor(tenantId: string, actorUserId: string): Promise<ResolvedActor> {
  const [user] = await db
    .select({ id: users.id, name: users.name, status: users.status })
    .from(users)
    .where(and(eq(users.id, actorUserId), eq(users.tenantId, tenantId)))
    .limit(1);
  if (!user) throw new UnknownActorError();
  const permissions = await posPermissionsFor(user.id);
  return {
    userId: user.id,
    name: user.name,
    permissions,
    ...(user.status !== "active" ? { flags: ["actor_deactivated"] } : {}),
  };
}

function deviceFingerprint(device: PosDeviceContext): AuditFingerprint {
  return { ...emptyFingerprint(), deviceId: device.deviceId };
}

function toCashierContext(device: PosDeviceContext, actor: ResolvedActor): PosCashierContext {
  return {
    deviceId: device.deviceId,
    tenantId: device.tenantId,
    branchId: device.branchId,
    cashierUserId: actor.userId,
    cashierName: actor.name,
    permissions: actor.permissions,
    fingerprint: deviceFingerprint(device),
  };
}

/** jsonb round-trips through JSON — a "duplicate" result read back from
 *  `resultJson` never has a real Date instance in it. Every handler runs its
 *  fresh result through this too, so an "applied" result and the later
 *  "duplicate" replay of the SAME event are byte-identical, with no
 *  per-field revive bookkeeping at this layer. */
function toJsonSafe<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Resolves the shift a `shift.closed`/`count.recorded` event names: by the
 * client-minted id if the shift was opened offline (the device never learns
 * a server id for a shift it opened without a round trip), or the server id
 * directly if it was opened online. Same precedence as record-sale.ts's
 * private resolveReplayShift, duplicated rather than imported — that helper
 * is intentionally unexported (record-sale.ts has no callers upstream of it
 * besides itself), and closeShift/recordMidShiftCount need the id BEFORE the
 * call, not resolved internally the way recordSale resolves its own shift.
 */
async function resolveShiftId(
  tenantId: string,
  deviceId: string,
  ref: { shiftId?: string; clientShiftId?: string },
): Promise<string> {
  if (ref.clientShiftId) {
    const [s] = await withTenant(tenantId, (tx) =>
      tx.select({ id: posShifts.id }).from(posShifts)
        .where(and(eq(posShifts.deviceId, deviceId), eq(posShifts.clientShiftId, ref.clientShiftId!)))
        .limit(1),
    );
    if (s) return s.id;
  }
  if (ref.shiftId) return ref.shiftId;
  throw new SyncEventValidationError("could not resolve a shift from shiftId/clientShiftId");
}

// ---- Per-type payload contracts + handlers -------------------------------
// Each payload type is this dispatcher's own wire contract (Tasks 8-10 build
// the client against it) — none of these are shared with a live route's body.

type SaleRecordedPayload = {
  clientOrderId: string;
  lines: PlaceOrderLine[];
  /** Index-aligned with `lines` — the till-wins fallback (record-sale.ts's
   *  `replay.lineSnapshots`). */
  lineSnapshots: LineSnapshot[];
  orderDiscountAmount?: number;
  orderDiscountReason?: ReasonCode;
  expectedTotal: number;
  payments: TenderInput[];
  notes?: string;
  clientShiftId?: string;
  shiftId?: string;
  catalogVersion?: number;
};

function asSaleRecordedPayload(payload: Record<string, unknown>): SaleRecordedPayload {
  const p = payload as Partial<SaleRecordedPayload>;
  if (typeof p.clientOrderId !== "string" || !p.clientOrderId) {
    throw new SyncEventValidationError("sale.recorded requires clientOrderId");
  }
  if (!Array.isArray(p.lines) || p.lines.length === 0) {
    throw new SyncEventValidationError("sale.recorded requires lines");
  }
  if (!Array.isArray(p.lineSnapshots) || p.lineSnapshots.length !== p.lines.length) {
    throw new SyncEventValidationError("sale.recorded requires lineSnapshots index-aligned with lines");
  }
  if (typeof p.expectedTotal !== "number") throw new SyncEventValidationError("sale.recorded requires expectedTotal");
  if (!Array.isArray(p.payments)) throw new SyncEventValidationError("sale.recorded requires payments");
  return p as SaleRecordedPayload;
}

async function handleSaleRecorded(
  ctx: PosCashierContext, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const p = asSaleRecordedPayload(e.payload);
  const result = await recordSale(ctx, {
    clientOrderId: p.clientOrderId,
    lines: p.lines,
    orderDiscountAmount: p.orderDiscountAmount,
    orderDiscountReason: p.orderDiscountReason,
    expectedTotal: p.expectedTotal,
    payments: p.payments,
    notes: p.notes,
    clientShiftId: p.clientShiftId,
    shiftId: p.shiftId,
    replay: { occurredAt: receipt.occurredAt, lineSnapshots: p.lineSnapshots, catalogVersion: p.catalogVersion },
    authorizedByUserId: e.authorizedByUserId,
    syncReceipt: receipt,
  });
  return toJsonSafe(result);
}

type ShiftOpenedPayload = { openingFloat: number; denominations?: Record<string, number>; clientShiftId?: string };

function asShiftOpenedPayload(payload: Record<string, unknown>): ShiftOpenedPayload {
  const p = payload as Partial<ShiftOpenedPayload>;
  if (typeof p.openingFloat !== "number") throw new SyncEventValidationError("shift.opened requires openingFloat");
  return p as ShiftOpenedPayload;
}

async function handleShiftOpened(
  ctx: PosCashierContext, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const p = asShiftOpenedPayload(e.payload);
  const shift = await openShift(ctx, {
    openingFloat: p.openingFloat,
    denominations: p.denominations,
    clientShiftId: p.clientShiftId,
    occurredAt: receipt.occurredAt,
    syncReceipt: receipt,
  });
  return toJsonSafe(shift);
}

type ShiftClosedPayload = {
  shiftId?: string;
  clientShiftId?: string;
  countedTotal: number;
  denominations?: Record<string, number>;
};

function asShiftClosedPayload(payload: Record<string, unknown>): ShiftClosedPayload {
  const p = payload as Partial<ShiftClosedPayload>;
  if (typeof p.countedTotal !== "number") throw new SyncEventValidationError("shift.closed requires countedTotal");
  if (!p.shiftId && !p.clientShiftId) throw new SyncEventValidationError("shift.closed requires shiftId or clientShiftId");
  return p as ShiftClosedPayload;
}

async function handleShiftClosed(
  ctx: PosCashierContext, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const p = asShiftClosedPayload(e.payload);
  const shiftId = await resolveShiftId(ctx.tenantId, ctx.deviceId, p);
  const report = await closeShift(ctx, shiftId, {
    count: { countedTotal: p.countedTotal, denominations: p.denominations },
    occurredAt: receipt.occurredAt,
    syncReceipt: receipt,
    authorizedByUserId: e.authorizedByUserId,
  });
  return toJsonSafe(report);
}

const CASH_MOVEMENT_TYPES = new Set<CashMovementType>(["pay_in", "pay_out", "safe_drop", "no_sale"]);

type CashMovementPayload = { type: CashMovementType; amount: number; reasonCode: string; reasonText?: string };

function asCashMovementPayload(payload: Record<string, unknown>): CashMovementPayload {
  const p = payload as Partial<CashMovementPayload>;
  if (typeof p.type !== "string" || !CASH_MOVEMENT_TYPES.has(p.type)) {
    throw new SyncEventValidationError("cash.movement requires a valid type");
  }
  if (typeof p.amount !== "number") throw new SyncEventValidationError("cash.movement requires amount");
  if (typeof p.reasonCode !== "string" || !p.reasonCode) {
    throw new SyncEventValidationError("cash.movement requires reasonCode");
  }
  return p as CashMovementPayload;
}

async function handleCashMovement(
  ctx: PosCashierContext, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const p = asCashMovementPayload(e.payload);
  const row = await recordCashMovement(ctx, {
    type: p.type,
    amount: p.amount,
    reasonCode: p.reasonCode,
    reasonText: p.reasonText,
    occurredAt: receipt.occurredAt,
    syncReceipt: receipt,
    authorizedByUserId: e.authorizedByUserId,
  });
  return toJsonSafe(row);
}

type CountRecordedPayload = {
  shiftId?: string;
  clientShiftId?: string;
  countedTotal: number;
  denominations?: Record<string, number>;
};

function asCountRecordedPayload(payload: Record<string, unknown>): CountRecordedPayload {
  const p = payload as Partial<CountRecordedPayload>;
  if (typeof p.countedTotal !== "number") throw new SyncEventValidationError("count.recorded requires countedTotal");
  if (!p.shiftId && !p.clientShiftId) throw new SyncEventValidationError("count.recorded requires shiftId or clientShiftId");
  return p as CountRecordedPayload;
}

async function handleCountRecorded(
  ctx: PosCashierContext, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const p = asCountRecordedPayload(e.payload);
  const shiftId = await resolveShiftId(ctx.tenantId, ctx.deviceId, p);
  const count = await recordMidShiftCount(ctx, shiftId, {
    countedTotal: p.countedTotal,
    denominations: p.denominations,
    occurredAt: receipt.occurredAt,
    syncReceipt: receipt,
  });
  return toJsonSafe(count);
}

type TicketHeldPayload = { clientTicketId: string; label: string; draft?: unknown };

function asTicketHeldPayload(payload: Record<string, unknown>): TicketHeldPayload {
  const p = payload as Partial<TicketHeldPayload>;
  if (typeof p.clientTicketId !== "string" || !p.clientTicketId) {
    throw new SyncEventValidationError("ticket.held requires clientTicketId");
  }
  if (typeof p.label !== "string") throw new SyncEventValidationError("ticket.held requires label");
  return { clientTicketId: p.clientTicketId, label: p.label, draft: p.draft };
}

async function handleTicketHeld(
  ctx: PosCashierContext, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const p = asTicketHeldPayload(e.payload);
  const result = await holdTicket(ctx, p.label, p.draft ?? {}, {
    clientTicketId: p.clientTicketId,
    occurredAt: receipt.occurredAt,
    syncReceipt: receipt,
  });
  return toJsonSafe(result);
}

function asClientTicketId(payload: Record<string, unknown>, type: string): string {
  const clientTicketId = (payload as { clientTicketId?: unknown }).clientTicketId;
  if (typeof clientTicketId !== "string" || !clientTicketId) {
    throw new SyncEventValidationError(`${type} requires clientTicketId`);
  }
  return clientTicketId;
}

async function handleTicketRecalled(
  ctx: PosCashierContext, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const clientTicketId = asClientTicketId(e.payload, "ticket.recalled");
  await recallHeldTicket(ctx, clientTicketId, { syncReceipt: receipt });
  // recallHeldTicket returns void — its own internal receipt stores exactly
  // this shape, so this is what a fresh apply and a later duplicate agree on.
  return { clientTicketId };
}

async function handleTicketDiscarded(
  ctx: PosCashierContext, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const clientTicketId = asClientTicketId(e.payload, "ticket.discarded");
  await discardHeldTicket(ctx, null, { clientTicketId, syncReceipt: receipt });
  // Matches discardHeldTicket's own internal resultJson ({ id: entityId }).
  return { id: clientTicketId };
}

type GrantIssuedPayload = { permission: Permission };

function asGrantIssuedPayload(payload: Record<string, unknown>): GrantIssuedPayload {
  const permission = (payload as { permission?: unknown }).permission;
  if (typeof permission !== "string" || !PERMISSIONS.includes(permission as Permission)) {
    throw new SyncEventValidationError("grant.issued requires a valid permission");
  }
  return { permission: permission as Permission };
}

/**
 * Audit-only: offline authorization replays as data (decision #2). There is
 * no live grant token to spend here — the manager's authority was already
 * exercised, live, at the till; this event is the durable record of it,
 * exactly the way authz.manager_granted records the live path. The gated
 * action itself (a discount, an over-threshold pay-out, a cross-user close)
 * carries its OWN authorizedByUserId and is validated independently when it
 * lands — this event does not gate anything, it just makes the offline
 * authorization visible in the audit chain.
 */
async function handleGrantIssued(
  device: PosDeviceContext, actor: ResolvedActor, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  if (!e.authorizedByUserId) throw new SyncEventValidationError("grant.issued requires authorizedByUserId");
  const { permission } = asGrantIssuedPayload(e.payload);
  const authorizer = await resolveOfflineAuthorizer(device.tenantId, e.authorizedByUserId, permission);

  const result: Record<string, unknown> = {
    permission,
    authorizedByUserId: authorizer.userId,
    ...(authorizer.deactivated ? { authorizerDeactivated: true } : {}),
  };
  await withTenant(device.tenantId, async (tx) => {
    await recordAuditEvent(
      { tenantId: device.tenantId, branchId: device.branchId, actorUserId: actor.userId, fingerprint: deviceFingerprint(device) },
      {
        action: "pos.grant_issued_offline",
        entityType: "authorization",
        entityId: permission,
        summary: `${permission} authorized offline for ${actor.name}`,
        metadata: { permission, authorizedByUserId: authorizer.userId, occurredAt: e.occurredAt },
        actorType: "user",
      },
      tx,
    );
    await tx.insert(posSyncEventReceipts).values({ ...receipt, resultJson: result });
  });
  return result;
}

type SessionSignedInPayload = { outcome?: "success" | "failed" };

function asSessionSignedInPayload(payload: Record<string, unknown>): SessionSignedInPayload {
  const outcome = (payload as Partial<SessionSignedInPayload>).outcome;
  if (outcome !== undefined && outcome !== "success" && outcome !== "failed") {
    throw new SyncEventValidationError("session.signed_in outcome must be success or failed");
  }
  return { outcome };
}

/** Records an offline PIN/credential check the device already made against
 *  its own cached roster — never re-authenticates anything here. Both
 *  outcomes name a real actorUserId (the offline picker is by cached
 *  cashier, not by typed email), unlike the live auth.login_failed path. */
async function handleSessionSignedIn(
  device: PosDeviceContext, actor: ResolvedActor, e: SyncEvent, receipt: SyncReceipt,
): Promise<Record<string, unknown>> {
  const { outcome = "success" } = asSessionSignedInPayload(e.payload);
  const action = outcome === "failed" ? "auth.login_failed" : "auth.cashier_signed_in";
  const result: Record<string, unknown> = { actorUserId: actor.userId, outcome };

  await withTenant(device.tenantId, async (tx) => {
    await recordAuditEvent(
      { tenantId: device.tenantId, branchId: device.branchId, actorUserId: actor.userId, fingerprint: deviceFingerprint(device) },
      {
        action,
        entityType: "user",
        entityId: actor.userId,
        summary: outcome === "failed" ? `${actor.name} failed to sign in to POS offline` : `${actor.name} signed in to POS offline`,
        metadata: { occurredAt: e.occurredAt, offline: true },
        actorType: "user",
      },
      tx,
    );
    await tx.insert(posSyncEventReceipts).values({ ...receipt, resultJson: result });
  });
  return result;
}

/** Every event type dispatches somewhere — an unrecognized `type` is the
 *  only way out of this switch, and it fails just that one event. */
async function applyEvent(device: PosDeviceContext, actor: ResolvedActor, e: SyncEvent): Promise<Record<string, unknown>> {
  const receipt: SyncReceipt = {
    deviceId: device.deviceId,
    eventId: e.eventId,
    type: e.type,
    occurredAt: new Date(e.occurredAt),
    clockSkewFlagged: isClockSkewed(e.occurredAt),
    seq: e.seq,
  };

  switch (e.type) {
    case "sale.recorded": return handleSaleRecorded(toCashierContext(device, actor), e, receipt);
    case "shift.opened": return handleShiftOpened(toCashierContext(device, actor), e, receipt);
    case "shift.closed": return handleShiftClosed(toCashierContext(device, actor), e, receipt);
    case "cash.movement": return handleCashMovement(toCashierContext(device, actor), e, receipt);
    case "count.recorded": return handleCountRecorded(toCashierContext(device, actor), e, receipt);
    case "ticket.held": return handleTicketHeld(toCashierContext(device, actor), e, receipt);
    case "ticket.recalled": return handleTicketRecalled(toCashierContext(device, actor), e, receipt);
    case "ticket.discarded": return handleTicketDiscarded(toCashierContext(device, actor), e, receipt);
    case "grant.issued": return handleGrantIssued(device, actor, e, receipt);
    case "session.signed_in": return handleSessionSignedIn(device, actor, e, receipt);
    default: throw new UnknownSyncEventTypeError(String(e.type));
  }
}

function toErrorShape(err: unknown): { code: string; message: string } {
  const of = (code: string) => ({ code, message: err instanceof Error ? err.message : String(err) });
  if (err instanceof SyncEventValidationError) return of("invalid_event");
  if (err instanceof UnknownSyncEventTypeError) return of("unknown_event_type");
  if (err instanceof UnknownActorError) return of("unknown_actor");
  if (err instanceof TotalMismatchError) return of("total_mismatch");
  if (err instanceof NoOpenShiftError) return of("no_open_shift");
  if (err instanceof ShiftClosedError) return of("shift_closed");
  if (err instanceof ShiftAlreadyOpenError) return of("shift_already_open");
  if (err instanceof CashCountMismatchError) return of("cash_count_mismatch");
  if (err instanceof CashMovementError) return of("cash_movement_invalid");
  if (err instanceof PosSaleError) return of("sale_invalid");
  if (err instanceof PosForbiddenError) return of("forbidden");
  if (err instanceof OutOfStockError) return of("out_of_stock");
  if (err instanceof OrderValidationError) return of("order_invalid");
  if (err instanceof InvalidVariantError) return of("invalid_variant");
  if (err instanceof BranchNotAcceptingOrdersError) return of("branch_not_accepting_orders");
  if (err instanceof AreaNotDeliverableError) return of("area_not_deliverable");
  if (err instanceof MinimumOrderNotMetError) return of("minimum_order_not_met");
  if (err instanceof InvalidScheduleError) return of("invalid_schedule");
  return of("internal_error");
}

function fail(eventId: string, code: string, message: string): SyncResult {
  return { eventId, status: "failed", error: { code, message } };
}

/**
 * Device-authenticated: `device` is the terminal, NOT a cashier session (see
 * PosDeviceContext) — a live cashier token cannot exist after the outage
 * that produced this batch, so there is nothing to authenticate the BATCH
 * against except the device itself. Every event inside carries its own
 * `actorUserId` and is attributed individually; a batch may span cashiers.
 *
 * Strict, ordered, stop-on-first-failure: events apply in `seq` order and a
 * single failure halts the rest of the batch (undone work is what the next
 * flush retries) rather than skipping ahead and reordering what actually
 * happened at the till.
 */
export async function ingestEvents(device: PosDeviceContext, events: SyncEvent[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  let lastSeq = await lastReceiptSeq(device.deviceId);

  for (const e of events) {
    // eventId gates the very first DB call below (findSyncReceipt), which
    // runs unconditionally per the ordering contract — so a malformed one
    // must be caught here, before that call, not inside the try below.
    if (typeof e.eventId !== "string" || !UUID_RE.test(e.eventId)) {
      results.push(fail(String(e.eventId ?? "unknown"), "invalid_event", "eventId must be a UUID"));
      break;
    }

    const receipt = await findSyncReceipt({ deviceId: device.deviceId, eventId: e.eventId });
    if (receipt) {
      results.push({ eventId: e.eventId, status: "duplicate", result: receipt.resultJson });
      continue;
    }

    if (e.seq <= lastSeq) {
      results.push(fail(e.eventId, "out_of_order", `seq ${e.seq} is not after the device's last committed seq ${lastSeq}`));
      break;
    }

    try {
      validateEnvelope(e);
      const actor = await resolveActor(device.tenantId, e.actorUserId);
      const result = await applyEvent(device, actor, e);
      results.push({
        eventId: e.eventId,
        status: "applied",
        result,
        ...(actor.flags?.length ? { flags: actor.flags } : {}),
      });
      lastSeq = e.seq;
    } catch (err) {
      // A concurrent duplicate ingest of this SAME event races here, on
      // whichever unique constraint its natural key or receipt insert owns
      // (see isReplayUniqueViolation) — the loser re-reads and answers
      // duplicate instead of failing the batch.
      if (isReplayUniqueViolation(err)) {
        const r = await findSyncReceipt({ deviceId: device.deviceId, eventId: e.eventId });
        if (r) {
          results.push({ eventId: e.eventId, status: "duplicate", result: r.resultJson });
          lastSeq = e.seq;
          continue;
        }
      }
      const { code, message } = toErrorShape(err);
      results.push(fail(e.eventId, code, message));
      break;
    }
  }

  return results;
}

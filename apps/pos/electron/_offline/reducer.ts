import type { EventRow } from "./store";

/** Rebuilds till state from the confirmed snapshot + unsynced events. Pure:
 *  (snapshot, events) → state. Boot calls this; nothing else mutates
 *  local_state. Shape is rich enough to render a local X/Z report. */
export type TillState = {
  openShift: { clientShiftId: string; openedAt: string; openingFloat: number; openedByUserId: string } | null;
  tendersByMethod: { cash: number; card: number; other: number };
  /** How many tenders made up each method's amount — the X-report line reads
   *  "cash taken (3)", so the count is part of the projection, not a
   *  derivable extra. Kept beside the amounts rather than nested inside them
   *  so an older confirmed snapshot still spreads cleanly into a newer state. */
  tenderCounts: { cash: number; card: number; other: number };
  movements: { payIn: number; payOut: number; safeDrop: number; noSaleCount: number };
  movementCounts: { payIn: number; payOut: number; safeDrop: number };
  salesCount: number;
  discountTotal: number;
  heldTickets: { clientTicketId: string; label: string; draft: unknown; createdAt: string }[];
};

/** The state before any events have applied — the reducer's zero value and
 *  boot's fallback when there is no confirmed snapshot yet. */
export const EMPTY_TILL_STATE: TillState = {
  openShift: null,
  tendersByMethod: { cash: 0, card: 0, other: 0 },
  tenderCounts: { cash: 0, card: 0, other: 0 },
  movements: { payIn: 0, payOut: 0, safeDrop: 0, noSaleCount: 0 },
  movementCounts: { payIn: 0, payOut: 0, safeDrop: 0 },
  salesCount: 0,
  discountTotal: 0,
  heldTickets: [],
};

// Payload shapes appendEvent's callers write. These ARE the server's wire
// payloads (src/server/pos/sync-ingest.ts's asXPayload validators), field for
// field, so the sync engine forwards them with no translation beyond lifting
// the envelope fields off. local_events has no actor_user_id column (see
// db.ts), so per the plan's client wire contract every payload — not just
// these — carries its own `actorUserId`, and a gated action (discount,
// over-threshold pay-out, cross-user close) its own `authorizedByUserId`;
// sync.ts moves both onto the envelope on the way out.
type ShiftOpenedPayload = { clientShiftId: string; openingFloat: number; actorUserId: string };
type SaleRecordedPayload = {
  clientOrderId: string;
  /** Rule 1 of the wire contract: every sale.recorded — including card-only
   *  sales — must name its drawer, or a replay after close silently drops
   *  its tender from the Z-report. Required, not optional, for exactly that
   *  reason (a server-opened shift uses `shiftId` instead, carried the same
   *  way, outside this client-only payload). */
  clientShiftId: string;
  payments: { method: "cash" | "card" | "other"; amount: number }[];
  /** Order-level only (wire contract rule 4): a local X/Z that read this as
   *  "the discount" would under-report, because line discounts live on the
   *  lines — so `discountTotal` below sums both, the way the server's own
   *  report sums both kinds of pos_adjustment_events. */
  orderDiscountAmount?: number;
  lines?: { discountAmount?: number }[];
};
/** Rule 2: an over-threshold pay_out must carry `authorizedByUserId` in the
 *  raw payload (appended by offline-auth.ts, Task 9) or the server rejects
 *  it, and the sticky halt then jams the whole queue behind it. The till
 *  state math (expectedCash) only needs `type`/`amount`. */
type CashMovementPayload = { type: "pay_in" | "pay_out" | "safe_drop" | "no_sale"; amount: number };
type TicketHeldPayload = { clientTicketId: string; label: string; draft: unknown };
type TicketResolvedPayload = { clientTicketId: string }; // recalled or discarded

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function applyOne(state: TillState, event: EventRow): TillState {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;

  switch (event.type) {
    case "shift.opened": {
      const p = payload as ShiftOpenedPayload;
      // A new drawer starts with clean books (C2): tendersByMethod,
      // tenderCounts, movements, movementCounts, salesCount, and
      // discountTotal are all per-shift and must not carry the previous
      // drawer's totals into this one's expectedCash. heldTickets is the one
      // field deliberately excluded from the reset — it is parked-order
      // workflow state, not shift money, so a ticket held under the last
      // drawer is still a live, unresolved order under this one. Every
      // action that can append cash.movement/sale.recorded requires an open
      // shift (pos-main.ts's shiftRef guard), so nothing accumulates in the
      // gap between a close and the next open for this to lose.
      return {
        ...EMPTY_TILL_STATE,
        heldTickets: state.heldTickets,
        openShift: {
          clientShiftId: p.clientShiftId,
          openedAt: event.occurred_at,
          openingFloat: p.openingFloat,
          openedByUserId: p.actorUserId,
        },
      };
    }

    case "shift.closed":
      return { ...state, openShift: null };

    case "sale.recorded": {
      const p = payload as SaleRecordedPayload;
      const tendersByMethod = { ...state.tendersByMethod };
      const tenderCounts = { ...state.tenderCounts };
      for (const t of p.payments) {
        tendersByMethod[t.method] = round2(tendersByMethod[t.method] + t.amount);
        tenderCounts[t.method] += 1;
      }
      const lineDiscounts = (p.lines ?? []).reduce((sum, l) => sum + (l.discountAmount ?? 0), 0);
      return {
        ...state,
        tendersByMethod,
        tenderCounts,
        salesCount: state.salesCount + 1,
        discountTotal: round2(state.discountTotal + (p.orderDiscountAmount ?? 0) + lineDiscounts),
      };
    }

    case "cash.movement": {
      const p = payload as CashMovementPayload;
      const movements = { ...state.movements };
      const movementCounts = { ...state.movementCounts };
      if (p.type === "no_sale") {
        movements.noSaleCount += 1;
      } else if (p.type === "pay_in") {
        movements.payIn = round2(movements.payIn + p.amount);
        movementCounts.payIn += 1;
      } else if (p.type === "pay_out") {
        movements.payOut = round2(movements.payOut + p.amount);
        movementCounts.payOut += 1;
      } else if (p.type === "safe_drop") {
        movements.safeDrop = round2(movements.safeDrop + p.amount);
        movementCounts.safeDrop += 1;
      }
      return { ...state, movements, movementCounts };
    }

    case "ticket.held": {
      const p = payload as TicketHeldPayload;
      return {
        ...state,
        heldTickets: [
          ...state.heldTickets.filter((t) => t.clientTicketId !== p.clientTicketId),
          { clientTicketId: p.clientTicketId, label: p.label, draft: p.draft, createdAt: event.occurred_at },
        ],
      };
    }

    case "ticket.recalled":
    case "ticket.discarded": {
      const p = payload as TicketResolvedPayload;
      return {
        ...state,
        heldTickets: state.heldTickets.filter((t) => t.clientTicketId !== p.clientTicketId),
      };
    }

    default:
      // grant.issued, session.signed_in, count.recorded, and anything unknown
      // carry no till-state fields the X/Z report needs — audit-only.
      return state;
  }
}

export function reduce(snapshot: TillState, events: EventRow[]): TillState {
  return events.reduce(applyOne, snapshot);
}

/** openingFloat + cashTenders − payOuts − safeDrops + payIns — the same
 *  formula the server's computeExpectedCash uses (shift-math.ts), so a local
 *  X-report and the eventual server Z-report agree. */
export function expectedCash(s: TillState): number {
  const openingFloat = s.openShift?.openingFloat ?? 0;
  return round2(openingFloat + s.tendersByMethod.cash - s.movements.payOut - s.movements.safeDrop + s.movements.payIn);
}

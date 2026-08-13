import type { EventRow } from "./store";

/** Rebuilds till state from the confirmed snapshot + unsynced events. Pure:
 *  (snapshot, events) → state. Boot calls this; nothing else mutates
 *  local_state. Shape is rich enough to render a local X/Z report. */
export type TillState = {
  openShift: { clientShiftId: string; openedAt: string; openingFloat: number; openedByUserId: string } | null;
  tendersByMethod: { cash: number; card: number; other: number };
  movements: { payIn: number; payOut: number; safeDrop: number; noSaleCount: number };
  salesCount: number;
  discountTotal: number;
  heldTickets: { clientTicketId: string; label: string; draftJson: string }[];
};

/** The state before any events have applied — the reducer's zero value and
 *  boot's fallback when there is no confirmed snapshot yet. */
export const EMPTY_TILL_STATE: TillState = {
  openShift: null,
  tendersByMethod: { cash: 0, card: 0, other: 0 },
  movements: { payIn: 0, payOut: 0, safeDrop: 0, noSaleCount: 0 },
  salesCount: 0,
  discountTotal: 0,
  heldTickets: [],
};

// Payload shapes appendEvent's callers are expected to write, mirroring the
// server's wire vocabulary (record-sale.ts, shifts.ts, cash-movements.ts,
// held-tickets.ts) field for field so a future SyncEngine can forward them
// with minimal translation. local_events has no actor_user_id column (see
// db.ts), so per the plan's client wire contract every payload — not just
// these — is expected to carry its own `actorUserId`, and a gated action
// (discount, over-threshold pay-out, cross-user close) its own
// `authorizedByUserId`; both travel to the server untouched. Neither drives
// till-state math, so they are typed loosely here (present on the raw
// payload, not read by the reducer) rather than declared per event type.
type ShiftOpenedPayload = { clientShiftId: string; openingFloat: number; openedByUserId: string };
type SaleRecordedPayload = {
  clientOrderId: string;
  /** Rule 1 of the wire contract: every sale.recorded — including card-only
   *  sales — must name its drawer, or a replay after close silently drops
   *  its tender from the Z-report. Required, not optional, for exactly that
   *  reason (a server-opened shift uses `shiftId` instead, carried the same
   *  way, outside this client-only payload). */
  clientShiftId: string;
  tenders: { method: "cash" | "card" | "other"; amount: number }[];
  /** Order-level only (wire contract rule 4) — line discounts are not this. */
  orderDiscountAmount?: number;
};
/** Rule 2: an over-threshold pay_out must carry `authorizedByUserId` in the
 *  raw payload (appended by offline-auth.ts, Task 9) or the server rejects
 *  it, and the sticky halt then jams the whole queue behind it. The till
 *  state math (expectedCash) only needs `type`/`amount`. */
type CashMovementPayload = { type: "pay_in" | "pay_out" | "safe_drop" | "no_sale"; amount: number };
type TicketHeldPayload = { clientTicketId: string; label: string; draftJson: string };
type TicketResolvedPayload = { clientTicketId: string }; // recalled or discarded

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function applyOne(state: TillState, event: EventRow): TillState {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;

  switch (event.type) {
    case "shift.opened": {
      const p = payload as ShiftOpenedPayload;
      return {
        ...state,
        openShift: {
          clientShiftId: p.clientShiftId,
          openedAt: event.occurred_at,
          openingFloat: p.openingFloat,
          openedByUserId: p.openedByUserId,
        },
      };
    }

    case "shift.closed":
      return { ...state, openShift: null };

    case "sale.recorded": {
      const p = payload as SaleRecordedPayload;
      const tendersByMethod = { ...state.tendersByMethod };
      for (const t of p.tenders) {
        tendersByMethod[t.method] = round2(tendersByMethod[t.method] + t.amount);
      }
      return {
        ...state,
        tendersByMethod,
        salesCount: state.salesCount + 1,
        discountTotal: round2(state.discountTotal + (p.orderDiscountAmount ?? 0)),
      };
    }

    case "cash.movement": {
      const p = payload as CashMovementPayload;
      const movements = { ...state.movements };
      if (p.type === "no_sale") {
        movements.noSaleCount += 1;
      } else if (p.type === "pay_in") {
        movements.payIn = round2(movements.payIn + p.amount);
      } else if (p.type === "pay_out") {
        movements.payOut = round2(movements.payOut + p.amount);
      } else if (p.type === "safe_drop") {
        movements.safeDrop = round2(movements.safeDrop + p.amount);
      }
      return { ...state, movements };
    }

    case "ticket.held": {
      const p = payload as TicketHeldPayload;
      return {
        ...state,
        heldTickets: [
          ...state.heldTickets.filter((t) => t.clientTicketId !== p.clientTicketId),
          { clientTicketId: p.clientTicketId, label: p.label, draftJson: p.draftJson },
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

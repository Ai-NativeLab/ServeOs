import { InvalidPoTransitionError } from "./errors";

export type PoStatus = "draft" | "sent" | "partially_received" | "received" | "closed" | "cancelled";

/** The ONLY definition of legal PO transitions. `cancelled` is unreachable once
 *  any receipt exists (receiving only ever advances toward received). Terminals
 *  (closed, cancelled) have no outgoing edges. */
export const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["partially_received", "received"],
  received: ["closed"],
  closed: [],
  cancelled: [],
};

export function canTransition(from: PoStatus, to: PoStatus): boolean {
  return PO_TRANSITIONS[from].includes(to);
}
export function assertTransition(from: PoStatus, to: PoStatus): void {
  if (!canTransition(from, to)) throw new InvalidPoTransitionError(from, to);
}

/** Derive the received-state from ordered vs received totals across all lines. */
export function receiptStatus(lines: { qtyOrdered: string; qtyReceived: string }[]): "sent" | "partially_received" | "received" {
  const anyReceived = lines.some((l) => Number(l.qtyReceived) > 0);
  const allMet = lines.every((l) => Number(l.qtyReceived) >= Number(l.qtyOrdered));
  if (allMet) return "received";
  return anyReceived ? "partially_received" : "sent";
}

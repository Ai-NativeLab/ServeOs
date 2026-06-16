import type { OrderStatus, FulfillmentType } from "./schema";

/** Allowed next statuses from a given status, given the fulfillment type. */
export function nextStatuses(from: OrderStatus, fulfillment: FulfillmentType): OrderStatus[] {
  switch (from) {
    case "pending": return ["confirmed", "rejected", "cancelled"];
    case "confirmed": return ["preparing", "cancelled"];
    case "preparing": return ["ready", "cancelled"];
    case "ready": return fulfillment === "delivery" ? ["out_for_delivery", "cancelled"] : ["completed", "cancelled"];
    case "out_for_delivery": return ["completed", "cancelled"];
    default: return []; // completed, rejected, cancelled are terminal
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus, fulfillment: FulfillmentType): boolean {
  return nextStatuses(from, fulfillment).includes(to);
}

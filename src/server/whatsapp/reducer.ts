import { parseActionId } from "./ids";
import type { OutboundMessage } from "./provider";
import type { InboundEvent } from "./payload";
import type { CartLine, ConversationState } from "./schema";

export type CatalogSlice = {
  categories: { id: string; name: string }[];
  products: { id: string; categoryId: string; name: string; price: number; hasVariants: boolean; hasRequiredModifiers: boolean }[];
  variants: { id: string; productId: string; name: string; price: number }[];
};

export type ReducerInput = {
  state: ConversationState;
  stateVersion: number;
  cart: CartLine[];
  inbound: InboundEvent;
  catalog: CatalogSlice;
  branches: { id: string; name: string }[];
  branchId: string | null;
  profileName: string | null;
  customerName: string | null;
};

export type Effect = { kind: "placeOrder" } | { kind: "mintHandoff" };

export type ReducerOutput = {
  nextState: ConversationState;
  nextCart: CartLine[];
  nextBranchId: string | null;
  nextCustomerName: string | null;
  pendingProductId: string | null;
  outbound: OutboundMessage[];
  effects: Effect[];
};

/** Exact-match escape words. A lookup table, not NLU — D5 forbids interpreting
 *  free text, not recognising a fixed keyword. */
const CANCEL_WORDS = new Set(["cancel", "stop", "الغاء", "إلغاء"]);
const RESTART_WORDS = new Set(["menu", "start", "hi", "hello", "القائمة", "ابدأ"]);
const HUMAN_WORDS = new Set(["human", "agent", "موظف", "بشري"]);

function keep(input: ReducerInput, outbound: OutboundMessage[], over: Partial<ReducerOutput> = {}): ReducerOutput {
  return {
    nextState: input.state,
    nextCart: input.cart,
    nextBranchId: input.branchId,
    nextCustomerName: input.customerName,
    pendingProductId: null,
    outbound,
    effects: [],
    ...over,
  };
}

function reset(_input: ReducerInput, body: string): ReducerOutput {
  return {
    nextState: "idle", nextCart: [], nextBranchId: null, nextCustomerName: null,
    pendingProductId: null, outbound: [{ kind: "text", body }], effects: [],
  };
}

/** Rendered by every state so the customer is never trapped. */
function reprompt(input: ReducerInput, lead: string): ReducerOutput {
  return keep(input, [{ kind: "text", body: `${lead}\n\nReply "menu" to start over or "cancel" to stop.` }]);
}

/**
 * Pure. No I/O, no clock, no randomness — the runner supplies the catalog slice
 * and executes the effects.
 *
 * TOTAL by construction: every (state, input) pair returns a value and at least
 * one outbound message. A missing transition would throw inside the webhook
 * handler, and Meta would retry that same message for up to 7 days.
 */
export function reduce(input: ReducerInput): ReducerOutput {
  const { inbound } = input;

  if (inbound.kind === "text") {
    const word = inbound.text.trim().toLowerCase();
    if (CANCEL_WORDS.has(word)) return reset(input, "No problem — I've cleared that. Say \"menu\" whenever you'd like to order.");
    if (RESTART_WORDS.has(word)) return reset(input, "Welcome! Say \"menu\" to see what's available.");
    if (HUMAN_WORDS.has(word)) return keep(input, [{ kind: "text", body: "I'll pass you to the team — please call the number on our page and someone will help." }]);
  }

  if (inbound.kind === "interactive") {
    const parsed = parseActionId(inbound.replyId);
    // A tap on a superseded message: same customer, new wamid, so dedup cannot
    // catch it. Reject rather than act on a stale offer.
    if (!parsed || parsed.version !== input.stateVersion) {
      return reprompt(input, "That option has expired — here's the current step again.");
    }
  }

  // States are added in Tasks 11-15. Until then every state re-prompts.
  return reprompt(input, "Sorry, I didn't get that.");
}

import { actionId, parseActionId } from "./ids";
import { renderRows, truncateTitle } from "./render";
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
  /** This number's last WhatsApp order, supplied by the runner in idle only. */
  lastCart?: CartLine[] | null;
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

function nextVersion(input: ReducerInput): number {
  return input.stateVersion + 1;
}

function branchList(input: ReducerInput): OutboundMessage {
  const v = nextVersion(input);
  const { rows } = renderRows(input.branches.map((b) => ({ id: b.id, name: b.name })), 0, "branch", v);
  return { kind: "list", body: "Which branch would you like to order from?", button: "Choose", rows };
}

function categoryList(input: ReducerInput): OutboundMessage {
  const v = nextVersion(input);
  const { rows } = renderRows(input.catalog.categories.map((c) => ({ id: c.id, name: c.name })), 0, "cat", v);
  return { kind: "list", body: "What would you like?", button: "Browse", rows };
}

function productList(input: ReducerInput, categoryId: string): OutboundMessage {
  const v = nextVersion(input);
  const items = input.catalog.products
    .filter((p) => p.categoryId === categoryId)
    .map((p) => ({ id: p.id, name: p.name, description: `${p.price.toFixed(2)}` }));
  const { rows } = renderRows(items, 0, "add", v);
  return { kind: "list", body: "Pick an item.", button: "Choose", rows };
}

function confirmSummary(input: ReducerInput, name: string): OutboundMessage {
  const v = nextVersion(input);
  const lines = input.cart.map((l) => {
    const p = input.catalog.products.find((x) => x.id === l.productId);
    return `${l.quantity}× ${p ? truncateTitle(p.name) : "item"}`;
  }).join("\n");
  // No total here: the runner re-prices at confirm time and passes expectedTotal
  // to placeOrder, so the chat never quotes a number the server would not charge.
  return {
    kind: "buttons",
    body: `Pickup order for ${name}:\n${lines}\n\nConfirm?`,
    buttons: [
      { id: actionId("confirm", v, "yes"), title: "Confirm" },
      { id: actionId("confirm", v, "no"), title: "Back" },
    ],
  };
}

function cartSummary(input: ReducerInput, cart: CartLine[]): OutboundMessage {
  const v = nextVersion(input);
  const names = cart.map((l) => {
    const p = input.catalog.products.find((x) => x.id === l.productId);
    return `${l.quantity}× ${p ? truncateTitle(p.name) : "item"}`;
  }).join("\n");
  return {
    kind: "buttons",
    body: `Your order so far:\n${names}`,
    buttons: [
      { id: actionId("more", v, "x"), title: "Add more" },
      { id: actionId("checkout", v, "x"), title: "Checkout" },
    ],
  };
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

  const tap = inbound.kind === "interactive" ? parseActionId(inbound.replyId) : null;

  switch (input.state) {
    case "idle": {
      if (tap?.action === "reorder") {
        const cart = input.lastCart ?? [];
        if (cart.length === 0) return reprompt(input, "Those items aren't available any more — let's start fresh.");
        return keep(input, [cartSummary(input, cart)], { nextState: "cart", nextCart: cart });
      }
      if (!tap) {
        if (input.lastCart && input.lastCart.length > 0) {
          const v = nextVersion(input);
          return keep(input, [{
            kind: "buttons",
            body: "Welcome back! Order the same as last time?",
            buttons: [
              { id: actionId("reorder", v, "yes"), title: "Same as last time" },
              { id: actionId("start", v, "fresh"), title: "Something else" },
            ],
          }], { nextState: "idle" });
        }
        return reprompt(input, 'Say "menu" to start an order.');
      }
      // One branch means no choice worth asking for.
      if (input.branches.length === 1) {
        return keep(input, [categoryList({ ...input, branchId: input.branches[0].id })], {
          nextState: "categories", nextBranchId: input.branches[0].id,
        });
      }
      return keep(input, [branchList(input)], { nextState: "branch" });
    }

    case "branch": {
      if (!tap || tap.action !== "branch") return reprompt(input, "Please choose a branch.");
      const branch = input.branches.find((b) => b.id === tap.payload);
      if (!branch) return reprompt(input, "That branch is no longer available.");
      return keep(input, [categoryList(input)], { nextState: "categories", nextBranchId: branch.id });
    }

    case "categories": {
      if (!tap || tap.action !== "cat") return reprompt(input, "Please pick a category.");
      const cat = input.catalog.categories.find((c) => c.id === tap.payload);
      if (!cat) return reprompt(input, "That category is no longer available.");
      return keep(input, [productList(input, cat.id)], { nextState: "products" });
    }

    case "products": {
      if (!tap || tap.action !== "add") return reprompt(input, "Please pick an item.");
      const product = input.catalog.products.find((p) => p.id === tap.payload);
      if (!product) return reprompt(input, "That item is no longer available.");

      // Anything the chat cannot configure goes to the storefront with the cart.
      if (product.hasRequiredModifiers) {
        return keep(input, [{ kind: "text", body: `${product.name} needs a few choices — I'll send you a link with your basket ready.` }], {
          effects: [{ kind: "mintHandoff" }],
        });
      }
      if (product.hasVariants) {
        const v = nextVersion(input);
        const items = input.catalog.variants
          .filter((x) => x.productId === product.id)
          .map((x) => ({ id: x.id, name: x.name, description: x.price.toFixed(2) }));
        const { rows } = renderRows(items, 0, "var", v);
        return keep(input, [{ kind: "list", body: `Which ${truncateTitle(product.name)}?`, button: "Choose", rows }], {
          nextState: "variant", pendingProductId: product.id,
        });
      }
      const cart = [...input.cart, { productId: product.id, quantity: 1 }];
      return keep(input, [cartSummary(input, cart)], { nextState: "cart", nextCart: cart });
    }

    case "variant": {
      if (!tap || tap.action !== "var") return reprompt(input, "Please choose an option.");
      const variant = input.catalog.variants.find((v) => v.id === tap.payload);
      if (!variant) return reprompt(input, "That option is no longer available.");
      const cart = [...input.cart, { productId: variant.productId, variantId: variant.id, quantity: 1 }];
      return keep(input, [cartSummary(input, cart)], { nextState: "cart", nextCart: cart });
    }

    case "cart": {
      if (!tap) return reprompt(input, 'Tap "Checkout" when you\'re ready.');
      if (tap.action === "more") return keep(input, [categoryList(input)], { nextState: "categories" });
      if (tap.action === "checkout") {
        const v = nextVersion(input);
        return keep(input, [{
          kind: "buttons", body: "Pickup or delivery?",
          buttons: [
            { id: actionId("ful", v, "pickup"), title: "Pickup" },
            { id: actionId("ful", v, "delivery"), title: "Delivery" },
          ],
        }], { nextState: "fulfillment" });
      }
      return reprompt(input, 'Tap "Checkout" when you\'re ready.');
    }

    case "fulfillment": {
      if (!tap || tap.action !== "ful") return reprompt(input, "Pickup or delivery?");
      if (tap.payload === "delivery") {
        // placeOrder requires deliveryAddressText; no list can produce an
        // Egyptian landmark address, so delivery finishes on the storefront.
        return keep(input, [{ kind: "text", body: "For delivery I'll send you a link with your basket ready — you can add your address there." }], {
          effects: [{ kind: "mintHandoff" }],
        });
      }
      const v = nextVersion(input);
      const profile = input.profileName ?? "your name";
      return keep(input, [{
        kind: "buttons", body: "Almost done — what name should we put on the order?",
        buttons: [
          { id: actionId("name", v, "profile"), title: `Use ${profile}`.slice(0, 20) },
          { id: actionId("name", v, "type"), title: "Type a name" },
        ],
      }], { nextState: "contact" });
    }

    case "contact": {
      // The ONE bounded free-text field: stored verbatim, never parsed.
      if (inbound.kind === "text") {
        const name = inbound.text.trim().slice(0, 120);
        if (!name) return reprompt(input, "Please send a name for the order.");
        return keep(input, [confirmSummary(input, name)], { nextState: "confirm", nextCustomerName: name });
      }
      if (tap?.action === "name" && tap.payload === "profile" && input.profileName) {
        return keep(input, [confirmSummary(input, input.profileName)], {
          nextState: "confirm", nextCustomerName: input.profileName,
        });
      }
      if (tap?.action === "name" && tap.payload === "type") {
        return keep(input, [{ kind: "text", body: "Sure — send me the name to put on the order." }]);
      }
      return reprompt(input, "What name should we put on the order?");
    }

    case "confirm": {
      if (!tap || tap.action !== "confirm") return reprompt(input, 'Tap "Confirm" to place the order.');
      if (tap.payload !== "yes") return keep(input, [cartSummary(input, input.cart)], { nextState: "cart" });
      if (input.cart.length === 0) return reprompt(input, "Your basket is empty.");
      return keep(input, [], { effects: [{ kind: "placeOrder" }] });
    }

    case "placed":
      return reset(input, 'Your last order is on its way. Say "menu" to start a new one.');
  }
}

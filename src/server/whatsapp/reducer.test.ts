import { describe, it, expect } from "vitest";
import { reduce, type ReducerInput, type CatalogSlice } from "./reducer";
import type { ConversationState } from "./schema";

const catalog: CatalogSlice = {
  categories: [{ id: "c1", name: "Pizza" }],
  products: [{ id: "p1", categoryId: "c1", name: "Margherita", price: 120, hasVariants: false, hasRequiredModifiers: false }],
  variants: [],
};

const base = (over: Partial<ReducerInput> = {}): ReducerInput => ({
  state: "idle", stateVersion: 0, cart: [], inbound: { kind: "text", text: "hi" },
  catalog, branches: [{ id: "b1", name: "Main" }], branchId: null,
  profileName: "Ahmed", customerName: null, ...over,
});

const ALL_STATES: ConversationState[] = [
  "idle", "branch", "categories", "products", "variant", "cart", "fulfillment", "contact", "confirm", "placed",
];

describe("reduce — totality", () => {
  it("never throws for any (state, input type) pair", () => {
    const inbounds: ReducerInput["inbound"][] = [
      { kind: "text", text: "anything" },
      { kind: "interactive", replyId: "totally:unknown:id" },
      { kind: "location", lat: 30, lng: 31 },
      { kind: "unsupported" },
    ];
    for (const state of ALL_STATES) {
      for (const inbound of inbounds) {
        expect(() => reduce(base({ state, inbound }))).not.toThrow();
      }
    }
  });

  it("always replies with something — silence reads as broken", () => {
    for (const state of ALL_STATES) {
      const out = reduce(base({ state, inbound: { kind: "unsupported" } }));
      expect(out.outbound.length).toBeGreaterThan(0);
    }
  });

  it("rejects a tap carrying a stale state version and re-renders instead", () => {
    const out = reduce(base({
      state: "products", stateVersion: 7,
      inbound: { kind: "interactive", replyId: "add:3:p1" }, branchId: "b1",
    }));
    expect(out.nextCart).toEqual([]);
    expect(JSON.stringify(out.outbound)).toMatch(/expired|again/i);
  });

  it("honours the universal cancel keyword from any state", () => {
    for (const state of ALL_STATES) {
      const out = reduce(base({ state, inbound: { kind: "text", text: "cancel" } }));
      expect(out.nextState).toBe("idle");
      expect(out.nextCart).toEqual([]);
    }
  });

  it("honours the Arabic cancel keyword", () => {
    const out = reduce(base({ state: "cart", inbound: { kind: "text", text: "إلغاء" } }));
    expect(out.nextState).toBe("idle");
  });

  it("is pure — the same input twice yields deeply equal output", () => {
    const input = base({ state: "categories", inbound: { kind: "interactive", replyId: "cat:0:c1" }, branchId: "b1" });
    expect(reduce(input)).toEqual(reduce(input));
  });
});

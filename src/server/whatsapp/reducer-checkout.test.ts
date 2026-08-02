import { describe, it, expect } from "vitest";
import { reduce, type ReducerInput, type CatalogSlice } from "./reducer";

const catalog: CatalogSlice = {
  categories: [{ id: "c1", name: "Pizza" }],
  products: [{ id: "p1", categoryId: "c1", name: "Margherita", price: 120, hasVariants: false, hasRequiredModifiers: false }],
  variants: [],
};

const base = (over: Partial<ReducerInput> = {}): ReducerInput => ({
  state: "cart", stateVersion: 5, cart: [{ productId: "p1", quantity: 1 }],
  inbound: { kind: "interactive", replyId: "checkout:5:x" },
  catalog, branches: [{ id: "b1", name: "Main" }], branchId: "b1",
  profileName: "Ahmed", customerName: null, ...over,
});

describe("checkout flow", () => {
  it("cart -> fulfillment on checkout", () => {
    expect(reduce(base()).nextState).toBe("fulfillment");
  });

  it("cart -> categories on 'add more'", () => {
    expect(reduce(base({ inbound: { kind: "interactive", replyId: "more:5:x" } })).nextState).toBe("categories");
  });

  it("pickup continues in chat to the contact step", () => {
    const out = reduce(base({ state: "fulfillment", inbound: { kind: "interactive", replyId: "ful:5:pickup" } }));
    expect(out.nextState).toBe("contact");
    // The profile name is offered as a tap, with typing as the only alternative.
    const btns = out.outbound.find((m) => m.kind === "buttons");
    expect(btns && btns.kind === "buttons" && btns.buttons.map((b) => b.title)).toEqual(["Use Ahmed", "Type a name"]);
  });

  it("delivery leaves the chat and hands off with the cart", () => {
    const out = reduce(base({ state: "fulfillment", inbound: { kind: "interactive", replyId: "ful:5:delivery" } }));
    expect(out.effects).toContainEqual({ kind: "mintHandoff" });
    expect(out.nextState).not.toBe("contact");
  });

  it("accepts the profile name with a single tap", () => {
    const out = reduce(base({ state: "contact", inbound: { kind: "interactive", replyId: "name:5:profile" } }));
    expect(out.nextCustomerName).toBe("Ahmed");
    expect(out.nextState).toBe("confirm");
  });

  it("accepts a typed name verbatim without parsing it", () => {
    const typing = reduce(base({ state: "contact", inbound: { kind: "interactive", replyId: "name:5:type" } }));
    expect(typing.nextState).toBe("contact");
    const out = reduce(base({ state: "contact", customerName: null, inbound: { kind: "text", text: "Om Kalthoum" } }));
    expect(out.nextCustomerName).toBe("Om Kalthoum");
    expect(out.nextState).toBe("confirm");
  });

  it("caps an absurdly long typed name instead of storing it whole", () => {
    const out = reduce(base({ state: "contact", inbound: { kind: "text", text: "x".repeat(500) } }));
    expect(out.nextCustomerName!.length).toBeLessThanOrEqual(120);
  });

  it("emits the placeOrder effect on confirm", () => {
    const out = reduce(base({ state: "confirm", customerName: "Ahmed", inbound: { kind: "interactive", replyId: "confirm:5:yes" } }));
    expect(out.effects).toContainEqual({ kind: "placeOrder" });
  });

  it("refuses to confirm an empty cart", () => {
    const out = reduce(base({ state: "confirm", cart: [], customerName: "A", inbound: { kind: "interactive", replyId: "confirm:5:yes" } }));
    expect(out.effects).toEqual([]);
  });

  it("returns to idle from placed so a second order can start", () => {
    const out = reduce(base({ state: "placed", inbound: { kind: "text", text: "another order" } }));
    expect(out.nextState).toBe("idle");
  });
});

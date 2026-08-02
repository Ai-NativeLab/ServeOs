import { describe, it, expect } from "vitest";
import { reduce, type ReducerInput, type CatalogSlice } from "./reducer";

const catalog: CatalogSlice = {
  categories: [{ id: "c1", name: "Pizza" }, { id: "c2", name: "Drinks" }],
  products: [
    { id: "p1", categoryId: "c1", name: "Margherita", price: 120, hasVariants: false, hasRequiredModifiers: false },
    { id: "p2", categoryId: "c1", name: "Four Cheese", price: 160, hasVariants: false, hasRequiredModifiers: true },
    { id: "p3", categoryId: "c2", name: "Cola", price: 25, hasVariants: true, hasRequiredModifiers: false },
  ],
  variants: [{ id: "v1", productId: "p3", name: "330ml", price: 25 }, { id: "v2", productId: "p3", name: "1L", price: 45 }],
};

const base = (over: Partial<ReducerInput> = {}): ReducerInput => ({
  state: "idle", stateVersion: 0, cart: [], inbound: { kind: "text", text: "menu" },
  catalog, branches: [{ id: "b1", name: "Main" }, { id: "b2", name: "Maadi" }],
  branchId: null, profileName: "Ahmed", customerName: null, ...over,
});

describe("browse flow", () => {
  it("asks for a branch before showing any catalog", () => {
    const out = reduce(base({ state: "idle", inbound: { kind: "interactive", replyId: "start:0:go" } }));
    expect(out.nextState).toBe("branch");
    expect(out.outbound[0].kind).toBe("list");
  });

  it("skips the branch step when the tenant has exactly one branch", () => {
    const out = reduce(base({
      state: "idle", branches: [{ id: "b1", name: "Main" }],
      inbound: { kind: "interactive", replyId: "start:0:go" },
    }));
    expect(out.nextState).toBe("categories");
    expect(out.nextBranchId).toBe("b1");
  });

  it("moves branch -> categories and remembers the branch", () => {
    const out = reduce(base({ state: "branch", stateVersion: 1, inbound: { kind: "interactive", replyId: "branch:1:b2" } }));
    expect(out.nextState).toBe("categories");
    expect(out.nextBranchId).toBe("b2");
  });

  it("lists only the chosen category's products", () => {
    const out = reduce(base({
      state: "categories", stateVersion: 2, branchId: "b1",
      inbound: { kind: "interactive", replyId: "cat:2:c2" },
    }));
    expect(out.nextState).toBe("products");
    const list = out.outbound.find((m) => m.kind === "list");
    expect(list && list.kind === "list" && list.rows.map((r) => r.title)).toEqual(["Cola"]);
  });

  it("adds a simple product straight to the cart", () => {
    const out = reduce(base({
      state: "products", stateVersion: 3, branchId: "b1",
      inbound: { kind: "interactive", replyId: "add:3:p1" },
    }));
    expect(out.nextCart).toEqual([{ productId: "p1", quantity: 1 }]);
    expect(out.nextState).toBe("cart");
  });

  it("routes a product with required modifiers to the storefront handoff", () => {
    const out = reduce(base({
      state: "products", stateVersion: 3, branchId: "b1",
      inbound: { kind: "interactive", replyId: "add:3:p2" },
    }));
    expect(out.effects).toContainEqual({ kind: "mintHandoff" });
  });

  it("sends a product with variants to the variant state", () => {
    const out = reduce(base({
      state: "products", stateVersion: 3, branchId: "b1",
      inbound: { kind: "interactive", replyId: "add:3:p3" },
    }));
    expect(out.nextState).toBe("variant");
    expect(out.pendingProductId).toBe("p3");
  });

  it("adds the chosen variant to the cart", () => {
    const out = reduce(base({
      state: "variant", stateVersion: 4, branchId: "b1",
      inbound: { kind: "interactive", replyId: "var:4:v2" },
    }));
    expect(out.nextCart).toEqual([{ productId: "p3", variantId: "v2", quantity: 1 }]);
    expect(out.nextState).toBe("cart");
  });
});

import { describe, it, expect, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { CartDrawer } from "./CartDrawer";
import type { Cart, CartLine } from "../cart";

/**
 * #181: the drawer's per-line Remove and the Clear cart action. The suite runs
 * in node with no DOM, and CartDrawer is a hook-free function component, so
 * the test calls it directly and presses the buttons through their onClick
 * props — the same wiring a click reaches.
 */
type ButtonProps = { "aria-label"?: string; onClick?: () => void; children?: ReactNode };

function findButton(node: ReactNode, label: string): ButtonProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = (node as ReactElement<ButtonProps>).props;
  if (node.type === "button" && props["aria-label"] === label) return props;
  return findButton(props.children, label);
}

const line = (productId: string, nameEn: string): CartLine => ({
  productId, nameEn, nameAr: nameEn, quantity: 1, unitPrice: 10, selectedOptionIds: [], modifierSummaryEn: "",
});

function render(cart: Cart) {
  const onSetQuantity = vi.fn();
  const tree = CartDrawer({
    cart, slug: "roma", currency: "EGP", preorderOnly: false, open: true,
    onOpenChange: () => {}, onSetQuantity,
  });
  return { tree, onSetQuantity };
}

describe("CartDrawer (#181)", () => {
  const cart: Cart = { branchId: "b-1", lines: [line("p1", "Kofta"), line("p2", "Tahini"), line("p3", "Bread")] };

  it("Remove on a line sets exactly that line's quantity to 0", () => {
    const { tree, onSetQuantity } = render(cart);

    findButton(tree, "Remove Tahini")!.onClick!();

    expect(onSetQuantity).toHaveBeenCalledTimes(1);
    expect(onSetQuantity).toHaveBeenCalledWith(1, 0);
  });

  it("Clear cart zeroes every line, last index first so earlier indexes stay valid", () => {
    const { tree, onSetQuantity } = render(cart);

    findButton(tree, "Clear cart")!.onClick!();

    expect(onSetQuantity.mock.calls).toEqual([[2, 0], [1, 0], [0, 0]]);
  });

  it("offers Clear cart only when there is more than one line", () => {
    expect(findButton(render({ branchId: "b-1", lines: [line("p1", "Kofta")] }).tree, "Clear cart")).toBeNull();
    expect(findButton(render(cart).tree, "Clear cart")).not.toBeNull();
  });
});

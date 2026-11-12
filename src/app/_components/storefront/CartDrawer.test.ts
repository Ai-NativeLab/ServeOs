import { describe, it, expect, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { Cart, CartLine } from "../cart";

/**
 * The drawer's only hook is the "Clear all" confirmation flag. Stub useState
 * so each render starts from a chosen value and records what the buttons set.
 */
const clearState = vi.hoisted(() => ({ confirming: false, set: (() => {}) as (v: boolean) => void }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: () => [clearState.confirming, clearState.set] };
});

const { CartDrawer } = await import("./CartDrawer");

/**
 * #181: the drawer's per-line Remove and the Clear all action. The suite runs
 * in node with no DOM, so the test calls the component directly and presses
 * the buttons through their onClick props — the same wiring a click reaches.
 */
type ButtonProps = { "aria-label"?: string; onClick?: () => void; children?: ReactNode };

/** A button's accessible name: its aria-label, else its plain-text children. */
function buttonName(props: ButtonProps): string | undefined {
  if (props["aria-label"]) return props["aria-label"];
  return typeof props.children === "string" ? props.children : undefined;
}

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
  if (node.type === "button" && buttonName(props) === label) return props;
  return findButton(props.children, label);
}

const line = (productId: string, nameEn: string): CartLine => ({
  productId, nameEn, nameAr: nameEn, quantity: 1, unitPrice: 10, selectedOptionIds: [], modifierSummaryEn: "",
});

function render(cart: Cart, { confirming = false } = {}) {
  clearState.confirming = confirming;
  const setConfirming = vi.fn();
  clearState.set = setConfirming;
  const onSetQuantity = vi.fn();
  const onClear = vi.fn();
  const tree = CartDrawer({
    cart, slug: "roma", currency: "EGP", preorderOnly: false, open: true,
    onOpenChange: () => {}, onSetQuantity, onClear,
  });
  return { tree, onSetQuantity, onClear, setConfirming };
}

describe("CartDrawer (#181)", () => {
  const cart: Cart = { branchId: "b-1", lines: [line("p1", "Kofta"), line("p2", "Tahini"), line("p3", "Bread")] };

  it("Remove on a line sets exactly that line's quantity to 0", () => {
    const { tree, onSetQuantity } = render(cart);

    findButton(tree, "Remove Tahini")!.onClick!();

    expect(onSetQuantity).toHaveBeenCalledTimes(1);
    expect(onSetQuantity).toHaveBeenCalledWith(1, 0);
  });

  it("Clear all asks for confirmation first and clears nothing yet", () => {
    const { tree, onSetQuantity, onClear, setConfirming } = render(cart);

    findButton(tree, "Clear all")!.onClick!();

    expect(setConfirming).toHaveBeenCalledWith(true);
    expect(onClear).not.toHaveBeenCalled();
    expect(onSetQuantity).not.toHaveBeenCalled();
  });

  it("confirming Clear empties the cart in one call and closes the prompt", () => {
    const { tree, onSetQuantity, onClear, setConfirming } = render(cart, { confirming: true });

    expect(findButton(tree, "Clear all")).toBeNull();
    findButton(tree, "Clear")!.onClick!();

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSetQuantity).not.toHaveBeenCalled();
    expect(setConfirming).toHaveBeenCalledWith(false);
  });

  it("Cancel backs out of the prompt without clearing", () => {
    const { tree, onClear, setConfirming } = render(cart, { confirming: true });

    findButton(tree, "Cancel")!.onClick!();

    expect(setConfirming).toHaveBeenCalledWith(false);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("offers Clear all only when there is more than one line", () => {
    expect(findButton(render({ branchId: "b-1", lines: [line("p1", "Kofta")] }).tree, "Clear all")).toBeNull();
    expect(findButton(render(cart).tree, "Clear all")).not.toBeNull();
  });
});

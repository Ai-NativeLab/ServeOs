import { describe, it, expect } from "vitest";
import { renderPurchaseOrderHtml } from "./render";
import type { PurchaseOrder, PurchaseOrderLine, Supplier } from "./schema";

const po = {
  id: "po-1", poNumber: 9, currency: "EGP", total: "110.00", status: "sent",
} as PurchaseOrder;
const lines = [
  { id: "l-1", itemId: "i-1", qtyOrdered: "10", uom: "each", unitCost: "5.00" },
  { id: "l-2", itemId: "i-2", qtyOrdered: "2", uom: "kg", unitCost: "30.00" },
] as PurchaseOrderLine[];
const itemNames = new Map([
  ["i-1", "Cola Can"],
  ["i-2", "Flour"],
]);
const supplier = { id: "s-1", name: "Acme Foods" } as Supplier;
const branch = { id: "b-1", name: "Downtown" } as { id: string; name: string };
const tenant = { id: "t-1", name: "ServeOS Demo" } as { id: string; name: string };

describe("renderPurchaseOrderHtml", () => {
  it("contains the PO number, supplier name, lines, total, and branch name", () => {
    const html = renderPurchaseOrderHtml(po, lines, itemNames, supplier, branch, tenant);
    expect(html).toContain("#9");
    expect(html).toContain("Acme Foods");
    expect(html).toContain("Cola Can");
    expect(html).toContain("10 each");
    expect(html).toContain("5.00");
    expect(html).toContain("Flour");
    expect(html).toContain("110.00");
    expect(html).toContain("Downtown");
    expect(html).toContain("EGP");
    // C8: the line Total cell must be qty × unit cost, not the unit cost again.
    expect(html).toContain("50.00"); // 10 × 5.00
    expect(html).toContain("60.00"); // 2 × 30.00
  });

  it("HTML-escapes interpolated text", () => {
    const evil = renderPurchaseOrderHtml(
      po, lines, itemNames,
      { id: "s-1", name: "<script>alert(1)</script>" } as Supplier,
      branch, tenant,
    );
    expect(evil).toContain("&lt;script&gt;");
    expect(evil).not.toContain("<script>alert");
  });

  it("has no external asset URLs", () => {
    const html = renderPurchaseOrderHtml(po, lines, itemNames, supplier, branch, tenant);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/src\s*=\s*"/);
  });
});

it("the emailed PO adds up: subtotal + tax equals the stated total", () => {
  // po.total is gross; the line rows are net. Without a subtotal/tax block the
  // document's own column does not sum to its own footer — an arithmetic error
  // visible to the supplier receiving it.
  const html = renderPurchaseOrderHtml(
    { poNumber: 7, total: "57.00", currency: "EGP", expectedAt: null } as never,
    [{ itemId: "i1", qtyOrdered: "10.000", uom: "each", unitCost: "5.00", taxRate: "0.14" }] as never,
    new Map([["i1", "Cola"]]),
    { name: "Sup", email: "s@x.com" } as never,
    { name: "Main" },
    { name: "T" },
  );
  expect(html).toContain("Subtotal: 50.00");
  expect(html).toContain("Tax: 7.00");
  expect(html).toContain("Total: 57.00");
  // and the row itself shows NET, so the column sums to the subtotal
  const cells = [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1].trim());
  expect(cells).toContain("50.00");
});

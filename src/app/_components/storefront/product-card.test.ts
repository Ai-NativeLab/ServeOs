import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { ProductCard, type MenuProduct } from "./ProductCard";

const sampleProduct: MenuProduct = {
  id: "prod-1",
  nameEn: "Chicken Shawarma",
  nameAr: "شاورما دجاج",
  descriptionEn: "Marinated chicken in pita",
  descriptionAr: "شاورما دجاج متبلة",
  effectivePrice: 85,
  unitOfMeasure: null,
  requiresPrescription: false,
  imageUrl: "https://example.com/shawarma.jpg",
  brand: null,
  variants: [],
  inStock: true,
  isFeatured: false,
  createdAt: new Date().toISOString(),
  modifierGroups: [],
};

describe("ProductCard — out-of-stock treatment (Issue #167)", () => {
  it("renders standard interactive card when inStock is true", () => {
    const html = renderToString(
      React.createElement(ProductCard, {
        product: sampleProduct,
        interactive: true,
        onOpen: () => {},
        currency: "EGP",
      })
    );
    expect(html).not.toContain("Out of stock");
    expect(html).toContain("+");
    // Targeted: the CARD button itself must NOT be disabled (a blanket
    // "disabled" string-absence check would break the moment any other
    // element earns one).
    expect(html).not.toMatch(/<button[^>]*\bdisabled\b/);
    expect(html).not.toContain("grayscale");
  });

  it("renders out-of-stock badge and de-emphasised card when inStock is false", () => {
    const oosProduct: MenuProduct = { ...sampleProduct, inStock: false };
    const html = renderToString(
      React.createElement(ProductCard, {
        product: oosProduct,
        interactive: true,
        onOpen: () => {},
        currency: "EGP",
      })
    );
    expect(html).toContain("Out of stock");
    // Targeted: the CARD button itself is disabled for out-of-stock dishes.
    expect(html).toMatch(/<button[^>]*\bdisabled\b/);
    expect(html).toContain("grayscale");
    // Should NOT have the '+' add button
    expect(html).not.toContain("grid size-8 place-items-center rounded-full bg-primary");
  });
});

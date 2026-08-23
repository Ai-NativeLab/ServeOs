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
    expect(html).not.toContain("disabled");
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
    expect(html).toContain("disabled");
    expect(html).toContain("grayscale");
    // Should NOT have the '+' add button
    expect(html).not.toContain("grid size-8 place-items-center rounded-full bg-primary");
  });
});

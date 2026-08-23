import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { CheckoutForm, type SlotOption, type OfflineMethodOption } from "./CheckoutForm";
import type { Cart } from "@/app/_components/cart";
import type { CheckoutPricing } from "@/lib/order-totals";

const samplePricing: CheckoutPricing = {
  vatEnabled: true,
  vatRate: 14,
  pricesIncludeVat: true,
  serviceChargeRate: 0,
};

const defaultProps = {
  slug: "demo-pharmacy",
  branchId: "b-1",
  branchName: "Main Branch",
  pricing: samplePricing,
  currency: "EGP",
  openNow: true,
  slots: [] as SlotOption[],
  methods: [] as OfflineMethodOption[],
  initialName: "Ahmed",
  initialPhone: "01000000000",
  initialAddress: "123 Nile St",
};

const otcCart: Cart = {
  branchId: "b-1",
  lines: [
    {
      productId: "p-otc",
      nameEn: "Panadol Extra",
      nameAr: "بنادول إكسترا",
      quantity: 1,
      unitPrice: 35,
      selectedOptionIds: [],
      modifierSummaryEn: "",
      requiresPrescription: false,
    },
  ],
};

const rxCart: Cart = {
  branchId: "b-1",
  lines: [
    {
      productId: "p-rx",
      nameEn: "Augmentin 1g",
      nameAr: "أوجمنتين 1 جم",
      quantity: 1,
      unitPrice: 120,
      selectedOptionIds: [],
      modifierSummaryEn: "",
      requiresPrescription: true,
    },
  ],
};

describe("CheckoutForm — prescription upload for Rx items (Issue #168)", () => {
  it("does not render prescription upload section when cart has no Rx items", () => {
    const html = renderToString(
      React.createElement(CheckoutForm, {
        ...defaultProps,
        initialCart: otcCart,
      })
    );
    expect(html).not.toContain("Prescription required");
    expect(html).not.toContain("Prescription upload");
    expect(html).not.toContain("co-prescription");
  });

  it("renders prescription upload section when cart holds an Rx item and customer is signed in", () => {
    const html = renderToString(
      React.createElement(CheckoutForm, {
        ...defaultProps,
        initialCart: rxCart,
        customer: { id: "cust-1", name: "Ahmed", email: "ahmed@example.com" },
      })
    );

    expect(html).toContain("Prescription upload");
    expect(html).toContain("co-prescription");
    expect(html).toContain("JPG, PNG, WebP or PDF");
  });

  it("shows sign-in prompt when customer is not authenticated with Rx item", () => {
    const html = renderToString(
      React.createElement(CheckoutForm, {
        ...defaultProps,
        initialCart: rxCart,
        customer: null,
      })
    );

    expect(html).toContain("Prescription required");
    expect(html).toContain("/account");
    expect(html).toContain("Sign in or Register");
  });
});

import { describe, it, expect } from "vitest";
import {
  VERTICAL_IDS,
  VERTICAL_ACCENTS,
  VERTICAL_STOREFRONT_COPY,
  selectStorefrontTemplate,
  type VerticalId,
} from "./verticals";

describe("verticals config", () => {
  it("defines the four trades with distinct accents", () => {
    expect(VERTICAL_IDS).toEqual(["restaurant", "retail", "pharmacy", "timber"]);
    expect(new Set(Object.values(VERTICAL_ACCENTS)).size).toBe(4);
  });

  it("only the restaurant shows the WhatsApp CTA", () => {
    (Object.keys(VERTICAL_STOREFRONT_COPY) as VerticalId[]).forEach((v) => {
      expect(VERTICAL_STOREFRONT_COPY[v].showWhatsapp).toBe(v === "restaurant");
    });
  });

  it("selectStorefrontTemplate falls back to restaurant for unknown values", () => {
    expect(selectStorefrontTemplate("retail")).toBe("retail");
    expect(selectStorefrontTemplate(null)).toBe("restaurant");
    expect(selectStorefrontTemplate("bogus" as VerticalId)).toBe("restaurant");
  });
});

import { describe, it, expect } from "vitest";
import { buildOrderWhatsappMessage, whatsappChatLink } from "./whatsapp";

describe("buildOrderWhatsappMessage", () => {
  it("includes order number, fulfillment type, items, and total", () => {
    const msg = buildOrderWhatsappMessage({
      orderNumber: 42,
      fulfillmentType: "pickup",
      items: [{ quantity: 2, nameEn: "Margherita" }],
      total: "178.00",
    });
    expect(msg).toBe("Order #42\nPickup\n2x Margherita\nTotal: 178.00");
  });

  it("labels delivery orders", () => {
    const msg = buildOrderWhatsappMessage({
      orderNumber: 1, fulfillmentType: "delivery", items: [{ quantity: 1, nameEn: "Pie" }], total: "50.00",
    });
    expect(msg).toContain("Delivery");
  });

  it("caps long item lists and notes how many more", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ quantity: 1, nameEn: `Item ${i + 1}` }));
    const msg = buildOrderWhatsappMessage({ orderNumber: 1, fulfillmentType: "delivery", items, total: "500.00" });
    expect(msg).toContain("+2 more item(s)");
    expect(msg).not.toContain("Item 9");
  });
});

describe("whatsappChatLink", () => {
  it("builds a wa.me link with the number and URL-encoded text", () => {
    const link = whatsappChatLink("+201234567890", "hello world");
    expect(link).toBe("https://wa.me/201234567890?text=hello%20world");
  });
});

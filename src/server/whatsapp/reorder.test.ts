import { describe, it, expect } from "vitest";
import { placeOrder } from "@/server/ordering/service";
import { lastWhatsappCart } from "./reorder";
import { seedWhatsappContext } from "./test-helpers";

const WA = "201012345678"; // a VALID EG mobile once the #173 rule landed (+20 10 …)

describe("lastWhatsappCart", () => {
  it("returns null when this number has never ordered", async () => {
    const { tenantId } = await seedWhatsappContext();
    expect(await lastWhatsappCart(tenantId, WA)).toBeNull();
  });

  it("returns the lines of the most recent whatsapp order", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: `+${WA}`,
      channel: "whatsapp", lines: [{ productId, quantity: 3, selectedOptionIds: [] }],
    });
    expect(await lastWhatsappCart(tenantId, WA)).toEqual([{ productId, quantity: 3 }]);
  });

  it("ignores a web order placed with the same phone number", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Someone Else", customerPhone: `+${WA}`,
      channel: "web", lines: [{ productId, quantity: 9, selectedOptionIds: [] }],
    });
    // A recycled number must not expose the previous owner's storefront history.
    expect(await lastWhatsappCart(tenantId, WA)).toBeNull();
  });

  it("does not leak another tenant's order", async () => {
    const a = await seedWhatsappContext();
    const b = await seedWhatsappContext();
    await placeOrder(a.tenantId, {
      branchId: a.branchId, fulfillmentType: "pickup", customerName: "A", customerPhone: `+${WA}`,
      channel: "whatsapp", lines: [{ productId: a.productId, quantity: 1, selectedOptionIds: [] }],
    });
    expect(await lastWhatsappCart(b.tenantId, WA)).toBeNull();
  });

  it("normalises a waId without a leading plus to E.164 before matching", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: `+${WA}`,
      channel: "whatsapp", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    // Meta sends the wa_id bare; the stored column carries the plus.
    expect(await lastWhatsappCart(tenantId, WA)).not.toBeNull();
  });

  it("drops a line whose product is no longer published rather than failing whole", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: `+${WA}`,
      channel: "whatsapp", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    const { updateProduct } = await import("@/server/catalog/service");
    await updateProduct(tenantId, productId, { isPublished: false });
    expect(await lastWhatsappCart(tenantId, WA)).toEqual([]);
  });
});

import { describe, it, expect, vi } from "vitest";
import { submitCheckoutOrder, checkoutOrderLines, priceChangedLines } from "./submit-order";
import { checkoutEmailPayload } from "./checkout-email";
import { repriceCart, type Cart, type CartLine } from "../_components/cart";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const orderBody = { slug: "demo-pharmacy", branchId: "b-1", customerName: "Ahmed", lines: [] };

/** Pulls the parsed JSON body of the /api/orders call out of a fetch spy. */
function orderPost(fetchImpl: ReturnType<typeof vi.fn>) {
  const call = fetchImpl.mock.calls.find(([url]) => url === "/api/orders");
  return JSON.parse(String(call![1].body)) as Record<string, unknown>;
}

describe("submitCheckoutOrder (#187 review: Rx id on the FIRST submit)", () => {
  it("uploads the prescription and sends its id with the very same order POST", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(201, { id: "rx-123" }))
      .mockResolvedValueOnce(json(201, { statusToken: "tok", orderNumber: 7 }));

    const out = await submitCheckoutOrder({
      rxFile: new File(["%PDF"], "script.pdf", { type: "application/pdf" }),
      rxUploadedId: null,
      body: orderBody,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe("/api/prescriptions");
    expect(orderPost(fetchImpl).prescriptionId).toBe("rx-123");
    expect(out).toMatchObject({ kind: "response", ok: true, prescriptionId: "rx-123" });
  });

  it("reuses an earlier upload instead of uploading again", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(201, { statusToken: "tok" }));

    await submitCheckoutOrder({
      rxFile: new File(["%PDF"], "script.pdf"),
      rxUploadedId: "rx-earlier",
      body: orderBody,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(orderPost(fetchImpl).prescriptionId).toBe("rx-earlier");
  });

  it("stops before the order when the upload is refused", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(413, { error: "File too large" }));

    const out = await submitCheckoutOrder({
      rxFile: new File(["x"], "big.jpg"),
      rxUploadedId: null,
      body: orderBody,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toEqual({ kind: "upload_failed", error: "File too large" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends no prescriptionId for a basket without one", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(422, { error: "nope", code: "out_of_stock" }));

    const out = await submitCheckoutOrder({
      rxFile: null, rxUploadedId: null, body: orderBody, fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(orderPost(fetchImpl)).not.toHaveProperty("prescriptionId");
    expect(out).toMatchObject({ kind: "response", ok: false, data: { code: "out_of_stock" } });
  });
});

describe("submitCheckoutOrder: the fiscal tax-receipt email", () => {
  // The body is built in CheckoutForm exactly like this: the email fragment is
  // spread in, so a fiscal tenant's address must survive into the POST body.
  it("sends customerEmail with the order when a fiscal tenant's customer gave one", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(201, { statusToken: "tok", orderNumber: 1 }));

    await submitCheckoutOrder({
      rxFile: null,
      rxUploadedId: null,
      body: { ...orderBody, ...checkoutEmailPayload(true, "buyer@example.com") },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(orderPost(fetchImpl).customerEmail).toBe("buyer@example.com");
  });

  it("sends the email alongside a freshly uploaded prescription id", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(201, { id: "rx-9" }))
      .mockResolvedValueOnce(json(201, { statusToken: "tok", orderNumber: 2 }));

    await submitCheckoutOrder({
      rxFile: new File(["%PDF"], "script.pdf"),
      rxUploadedId: null,
      body: { ...orderBody, ...checkoutEmailPayload(true, "buyer@example.com") },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(orderPost(fetchImpl)).toMatchObject({ customerEmail: "buyer@example.com", prescriptionId: "rx-9" });
  });

  it("sends no customerEmail key for a non-fiscal tenant", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(201, { statusToken: "tok", orderNumber: 3 }));

    await submitCheckoutOrder({
      rxFile: null,
      rxUploadedId: null,
      body: { ...orderBody, ...checkoutEmailPayload(false, "buyer@example.com") },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(orderPost(fetchImpl)).not.toHaveProperty("customerEmail");
  });
});

describe("checkout price guard (#192: expectedUnitPrice and the price_changed reprice)", () => {
  const cartLine = (over: Partial<CartLine>): CartLine => ({
    productId: "p-1", nameEn: "Panadol", nameAr: "بنادول", quantity: 2, unitPrice: 45,
    selectedOptionIds: [], modifierSummaryEn: "", ...over,
  });

  it("sends each line's displayed unit price as expectedUnitPrice, next to the fiscal email", async () => {
    const lines = [
      cartLine({ productId: "p-1", unitPrice: 45 }),
      cartLine({ productId: "p-2", variantId: "v-1", quantity: 1, unitPrice: 12.5, selectedOptionIds: ["o-1"] }),
    ];
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(201, { statusToken: "tok", orderNumber: 4 }));

    await submitCheckoutOrder({
      rxFile: null,
      rxUploadedId: null,
      body: { ...orderBody, ...checkoutEmailPayload(true, "buyer@example.com"), lines: checkoutOrderLines(lines) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(orderPost(fetchImpl)).toMatchObject({
      customerEmail: "buyer@example.com",
      lines: [
        { productId: "p-1", quantity: 2, selectedOptionIds: [], expectedUnitPrice: 45 },
        { productId: "p-2", variantId: "v-1", quantity: 1, selectedOptionIds: ["o-1"], expectedUnitPrice: 12.5 },
      ],
    });
  });

  it("never sends the cart's line total or display-only fields", () => {
    const [sent] = checkoutOrderLines([cartLine({ unitPrice: 45 })]);
    expect(Object.keys(sent).sort()).toEqual(
      ["dimensions", "expectedUnitPrice", "productId", "quantity", "selectedOptionIds", "variantId"],
    );
  });

  it("surfaces a 409 price_changed answer with its live prices, keeping the prescription id", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(409, {
      error: "Some prices changed", code: "price_changed", lines: [{ index: 1, unitPrice: 60 }],
    }));

    const out = await submitCheckoutOrder({
      rxFile: null,
      rxUploadedId: "rx-earlier",
      body: { ...orderBody, lines: checkoutOrderLines([cartLine({}), cartLine({ productId: "p-2", unitPrice: 50 })]) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toMatchObject({ kind: "response", ok: false, prescriptionId: "rx-earlier" });
    if (out.kind !== "response") throw new Error("unreachable");
    const changed = priceChangedLines(out.data);
    expect(changed).toEqual([{ index: 1, unitPrice: 60 }]);

    const cart: Cart = { branchId: "b-1", lines: [cartLine({}), cartLine({ productId: "p-2", unitPrice: 50 })] };
    expect(repriceCart(cart, changed!).lines.map((l) => l.unitPrice)).toEqual([45, 60]);
  });

  it("is not a price change for any other refusal, or a malformed one", () => {
    expect(priceChangedLines({ code: "out_of_stock", error: "Out of stock" })).toBeNull();
    expect(priceChangedLines({ code: "price_changed" })).toBeNull();
    expect(priceChangedLines({ code: "price_changed", lines: "nope" })).toBeNull();
    expect(priceChangedLines({ code: "price_changed", lines: [null, 3, { index: 0, unitPrice: 9 }] }))
      .toEqual([{ index: 0, unitPrice: 9 }]);
  });
});

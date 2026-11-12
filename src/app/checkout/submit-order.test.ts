import { describe, it, expect, vi } from "vitest";
import { submitCheckoutOrder } from "./submit-order";

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

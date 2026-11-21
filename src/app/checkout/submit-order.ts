/**
 * The network half of the checkout submit: upload the prescription when one
 * is still pending, then POST the order carrying that upload's id.
 *
 * Lives outside CheckoutForm so the id hand-off is testable without a DOM —
 * and so it is a plain local value. Reading it back from React state in the
 * same submit (#187 review) sent `prescriptionId: undefined` on the first
 * attempt, because a state setter does not update the closure that called it.
 */
import type { CartLine } from "../_components/cart";

export type CheckoutOrderBody = Record<string, unknown>;

/** A line's live unit price, as a 409 `price_changed` answer reports it
 *  (`index` is the line's position in the `lines` that were sent). */
export type ChangedLinePrice = { index: unknown; unitPrice: unknown };

export type CheckoutSubmitOutcome =
  | { kind: "upload_failed"; error: string }
  | {
      kind: "response";
      ok: boolean;
      data: {
        error?: string; code?: string; statusToken?: string; orderNumber?: number;
        /** Present on a `price_changed` refusal: the live prices to reprice from. */
        lines?: unknown;
      };
      /** The prescription this order claimed (fresh upload or earlier one), or null. */
      prescriptionId: string | null;
    };

export async function submitCheckoutOrder(input: {
  /** A prescription file still to upload, or null when there is none to send. */
  rxFile: File | null;
  /** A prescription already uploaded for this basket on an earlier attempt. */
  rxUploadedId: string | null;
  /** Everything the order POST carries except `prescriptionId`. */
  body: CheckoutOrderBody;
  fetchImpl?: typeof fetch;
}): Promise<CheckoutSubmitOutcome> {
  const doFetch = input.fetchImpl ?? fetch;
  let prescriptionId = input.rxUploadedId;

  if (input.rxFile && !prescriptionId) {
    const fd = new FormData();
    fd.append("file", input.rxFile);
    const rxRes = await doFetch("/api/prescriptions", { method: "POST", body: fd });
    if (!rxRes.ok) {
      const rxData = (await rxRes.json().catch(() => ({}))) as { error?: string };
      return { kind: "upload_failed", error: rxData.error ?? "Failed to upload prescription" };
    }
    prescriptionId = ((await rxRes.json()) as { id: string }).id;
  }

  const res = await doFetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input.body, prescriptionId: prescriptionId ?? undefined }),
  });
  const data = (await res.json()) as Extract<CheckoutSubmitOutcome, { kind: "response" }>["data"];
  return { kind: "response", ok: res.ok, data, prescriptionId };
}

/**
 * The order POST's `lines`, built from the cart. `expectedUnitPrice` is the
 * per-unit price the customer was shown: the server compares it with the live
 * price and refuses (409 `price_changed`) on a mismatch — typically a
 * promotion that ended or started after the item was carted — instead of
 * charging a price the customer never saw. It is never used for charging.
 */
export function checkoutOrderLines(lines: CartLine[]) {
  return lines.map((l) => ({
    productId: l.productId, variantId: l.variantId, quantity: l.quantity, selectedOptionIds: l.selectedOptionIds,
    dimensions: l.dimensions,
    expectedUnitPrice: l.unitPrice,
  }));
}

/** The live prices a refused order carried, when the refusal was a price
 *  change; null for any other answer (or a malformed one). */
export function priceChangedLines(
  data: Extract<CheckoutSubmitOutcome, { kind: "response" }>["data"],
): ChangedLinePrice[] | null {
  if (data.code !== "price_changed" || !Array.isArray(data.lines)) return null;
  return data.lines.filter((l): l is ChangedLinePrice => typeof l === "object" && l !== null);
}

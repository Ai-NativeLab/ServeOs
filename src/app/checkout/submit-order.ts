/**
 * The network half of the checkout submit: upload the prescription when one
 * is still pending, then POST the order carrying that upload's id.
 *
 * Lives outside CheckoutForm so the id hand-off is testable without a DOM —
 * and so it is a plain local value. Reading it back from React state in the
 * same submit (#187 review) sent `prescriptionId: undefined` on the first
 * attempt, because a state setter does not update the closure that called it.
 */
export type CheckoutOrderBody = Record<string, unknown>;

export type CheckoutSubmitOutcome =
  | { kind: "upload_failed"; error: string }
  | {
      kind: "response";
      ok: boolean;
      data: { error?: string; code?: string; statusToken?: string; orderNumber?: number };
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

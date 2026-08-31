import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { PosAuthError, PosCashierError, PosForbiddenError } from "@/server/pos/errors";
import { getSaleFiscalStatus } from "@/server/fiscal/read-model";

/**
 * The fiscal state of one sale, for the receipt (Task 7).
 *
 * `pos:sell` and nothing more: reading whether the till's own sale has been
 * accepted by ETA is part of issuing the receipt, and every cashier who can
 * ring a sale must be able to print it. Configuring ETA is a different act
 * behind a different permission (`fiscal:manage`, owner only) — this endpoint
 * returns no credential, no reference and no configuration.
 *
 * A `null` BODY WITH A 200, not a 404, when the order has no submission: an
 * absent fiscal block is the ordinary state of a non-EG tenant and of an EG
 * sale in the seconds before its enqueue lands, and a 404 would make the POS
 * treat a normal receipt as an error. The screen renders no fiscal footer for
 * `null`, which is the country gate's no-behavioural-change guarantee.
 *
 * POLLING CONTRACT FOR THE CLIENT (Task 7 implements the bounded poll).
 * `qrImageDataUrl` is RE-RENDERED on every call from `qrPayload`, which
 * `finalize` writes once and never changes — so the image is byte-identical
 * every time, a client holding one gains nothing by asking again, and each
 * extra call costs a PNG encode on the server. Render the QR once, and STOP
 * polling as soon as you hold both the image and a terminal status. `accepted`
 * and `rejected` are terminal. `failed` is NOT: the worker retries it up to
 * `MAX_ATTEMPTS`, so "poll until it stops being failed" polls forever against a
 * permanently failed row. Bound the poll by attempts or elapsed time, not by
 * status alone.
 *
 * The segment is `[id]`, matching its `sales/[id]/…` siblings, because Next
 * refuses two different slug names at the same dynamic position
 * ("You cannot use different slug names for the same dynamic path").
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let ctx;
  try {
    ctx = await requirePosCashier(req);
    assertPermission(ctx, "pos:sell");
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  // Tenant-scoped by ctx.tenantId — a device token from another tenant reads
  // nothing, whatever order id it names.
  return NextResponse.json(await getSaleFiscalStatus(ctx.tenantId, id));
}

import { NextRequest, NextResponse } from "next/server";
import { resolveFiscalContext } from "@/app/dashboard/fiscal-permission";
import { actionAudit } from "@/server/audit/action-context";
import { getFiscalConfig, updateFiscalConfig, type UpdateFiscalConfigInput } from "@/server/fiscal/config-service";
import { fiscalErrorResponse, redactedCause } from "../fiscal-errors";

/**
 * The tenant's ETA configuration, MASKED — `hasSecret`/`hasSigningKey`
 * booleans in place of the `*_ref` columns, never a reference value and never a
 * secret (F7). `null` means ETA setup has not been started.
 */
export async function GET() {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  return NextResponse.json(await getFiscalConfig(ctx.tenantId));
}

/**
 * Upserts the configuration and returns the same masked shape `GET` does, so
 * the form re-renders from the saved state rather than from what it sent.
 *
 * Validation lives entirely in the service (the 9-digit RIN, the mandatory
 * wire-context set, the cross-tenant online-device check): a route that
 * duplicated any of it would be a second opinion that could drift from the one
 * the worker actually relies on.
 */
export async function PUT(req: NextRequest) {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid fiscal configuration" }, { status: 400 });
  }

  try {
    const view = await updateFiscalConfig(
      ctx.tenantId,
      body as UpdateFiscalConfigInput,
      await actionAudit(ctx),
    );
    return NextResponse.json(view);
  } catch (e) {
    const mapped = fiscalErrorResponse(e);
    if (mapped) return mapped;
    // The log line is REDACTED, unlike every other route's: a Drizzle failure
    // puts the query's parameters — the `*_ref` columns among them — in its
    // message. See `redactedCause`.
    console.error("updateFiscalConfig failed", { tenantId: ctx.tenantId, ...redactedCause(e) });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { FiscalConfigInputError } from "@/server/fiscal/config-service";

/**
 * The one fiscal-route error ladder.
 *
 * `FiscalConfigInputError` is the config service's single input error — it
 * carries a dotted field path per problem, so the 400 body names the field the
 * form should highlight rather than making the operator guess which of eleven
 * seller fields was rejected.
 *
 * Returns null when the error is not a known input error, so the caller logs it
 * and returns its own opaque 500. Note what is NOT mapped here: nothing that
 * could carry a credential reference. The service never puts a `*Ref` value in
 * a message, and this ladder must not become the place that starts.
 *
 * Lives beside the routes rather than in them because a route module may only
 * export its HTTP handlers.
 */
export function fiscalErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof FiscalConfigInputError) {
    return NextResponse.json({ error: e.message, issues: e.issues }, { status: 400 });
  }
  return null;
}

// `redactedCause` moved to `@/lib/redacted-cause` so the server domain (the
// till's after-commit fiscal enqueue in `record-sale.ts`) can share it without
// importing a route helper. Re-exported so every route keeps its import.
export { redactedCause } from "@/lib/redacted-cause";

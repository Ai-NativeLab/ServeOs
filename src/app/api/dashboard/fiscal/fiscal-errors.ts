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

/**
 * A loggable summary of an UNEXPECTED failure on a fiscal write.
 *
 * Every other route in this codebase logs the raw error (`{ …, error: e }`) and
 * is right to; this one deliberately does not, because of what a fiscal write
 * carries. Drizzle puts the failing query's PARAMETERS into `error.message` —
 * `Failed query: insert into "eta_tenant_config" … params: <tenant>,<rin>,
 * <client_secret_ref>,…` — so logging the error verbatim writes the credential
 * REFERENCE columns into the deployment's log stream, which is readable by
 * anyone with project access and outlives the request by weeks. A reference is
 * not itself a secret, but it is the map to the secret store, and the whole
 * service treats it as write-only.
 *
 * What survives is what actually identifies a fault and cannot contain a value:
 * the error's class name, and for a Postgres error its SQLSTATE and the
 * constraint it violated.
 */
export function redactedCause(e: unknown): Record<string, unknown> {
  const pg = e as { code?: unknown; constraint?: unknown } | null;
  return {
    errorName: e instanceof Error ? e.name : typeof e,
    ...(typeof pg?.code === "string" ? { pgCode: pg.code } : {}),
    ...(typeof pg?.constraint === "string" ? { pgConstraint: pg.constraint } : {}),
  };
}

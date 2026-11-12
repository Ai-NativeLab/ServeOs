/**
 * A loggable summary of an UNEXPECTED failure on a fiscal write.
 *
 * Every other route in this codebase logs the raw error (`{ …, error: e }`) and
 * is right to; the fiscal paths deliberately do not, because of what a fiscal
 * write carries. Drizzle puts the failing query's PARAMETERS into `error.message` —
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

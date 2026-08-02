/**
 * Resolves a token REFERENCE to the live Meta access token.
 *
 * whatsapp_accounts stores a reference, never the token and never ciphertext —
 * that table has no RLS, so a single unscoped query would otherwise leak every
 * tenant's credentials. This mirrors the ETA spec's clientSecretRef pattern.
 *
 * The env-backed implementation below is the local/dev path. Production must
 * point this at the deployment's secret manager before Phase 1 ships.
 */
export async function resolveToken(tokenRef: string): Promise<string> {
  const envKey = tokenRef.startsWith("env://") ? tokenRef.slice("env://".length) : null;
  if (envKey) {
    const v = process.env[envKey];
    if (!v) throw new Error(`WhatsApp token ref unresolved: ${tokenRef}`);
    return v;
  }
  throw new Error(`Unsupported WhatsApp token ref scheme: ${tokenRef}`);
}

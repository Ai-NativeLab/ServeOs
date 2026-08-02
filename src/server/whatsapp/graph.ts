const GRAPH = "https://graph.facebook.com/v21.0";

export type ExchangeResult = {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  tokenRef: string;
};

/**
 * Exchanges the Embedded Signup OAuth code for a token, then reads the WABA and
 * phone number id back from Meta.
 *
 * These identifiers MUST come from here and never from the browser callback:
 * a client that could name its own phoneNumberId could squat or misroute
 * another tenant's number, and every RLS boundary downstream would then be
 * protecting the wrong tenant.
 */
export async function exchangeCode(code: string): Promise<ExchangeResult> {
  const appId = process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appId || !appSecret) throw new Error("WhatsApp app credentials are not configured");

  const tokenRes = await fetch(
    `${GRAPH}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`,
  );
  if (!tokenRes.ok) throw new Error(`WhatsApp code exchange failed: ${tokenRes.status}`);
  const { access_token: token } = (await tokenRes.json()) as { access_token: string };

  const wabaRes = await fetch(`${GRAPH}/debug_token?input_token=${token}`, {
    headers: { Authorization: `Bearer ${appId}|${appSecret}` },
  });
  if (!wabaRes.ok) throw new Error(`WhatsApp token inspect failed: ${wabaRes.status}`);
  const debug = (await wabaRes.json()) as {
    data?: { granular_scopes?: { scope: string; target_ids?: string[] }[] };
  };
  const wabaId = debug.data?.granular_scopes
    ?.find((s) => s.scope === "whatsapp_business_management")?.target_ids?.[0];
  if (!wabaId) throw new Error("WhatsApp token carries no WABA");

  const phoneRes = await fetch(`${GRAPH}/${wabaId}/phone_numbers`, { headers: { Authorization: `Bearer ${token}` } });
  if (!phoneRes.ok) throw new Error(`WhatsApp phone lookup failed: ${phoneRes.status}`);
  const phones = (await phoneRes.json()) as { data?: { id: string; display_phone_number: string }[] };
  const phone = phones.data?.[0];
  if (!phone) throw new Error("WABA has no phone number");

  // Hand the token to the secret manager and keep only the reference.
  const tokenRef = await storeToken(wabaId, token);
  return { wabaId, phoneNumberId: phone.id, displayPhoneNumber: phone.display_phone_number, tokenRef };
}

/**
 * Persists the token in the deployment's secret manager and returns its
 * reference. The env-backed dev implementation expects the operator to have set
 * the variable already; production must replace this before go-live.
 */
async function storeToken(wabaId: string, _token: string): Promise<string> {
  return `env://WHATSAPP_TOKEN_${wabaId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

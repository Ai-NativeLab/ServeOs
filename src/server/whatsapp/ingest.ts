import { withTenant } from "@/db/with-tenant";
import { getTenantById, isTenantServable } from "@/server/tenancy/service";
import { hasFeature } from "@/server/entitlements/service";
import { verifyWebhookSignature } from "./signature";
import { parseWebhook } from "./payload";
import { resolveAccount, recordInbound } from "./routing";
import { handleInbound } from "./runner";
import { CloudApiProvider } from "./cloud-api-provider";
import type { WhatsAppProvider } from "./provider";

export class WebhookSignatureError extends Error {
  constructor() { super("invalid webhook signature"); }
}

function appSecret(): string {
  const s = process.env.WHATSAPP_APP_SECRET;
  if (!s) throw new Error("WHATSAPP_APP_SECRET is not set");
  return s;
}

/**
 * Verifies, then fans out. Every entry is resolved to its OWN tenant: a single
 * Meta POST can batch entries belonging to different tenants, so resolving once
 * per request would process one tenant's message under another's RLS context.
 */
export async function ingestWebhook(
  rawBody: string,
  signature: string | null,
  provider: WhatsAppProvider = new CloudApiProvider(),
): Promise<{ accepted: number; skipped: number }> {
  if (!verifyWebhookSignature(rawBody, signature, appSecret())) throw new WebhookSignatureError();

  let parsed;
  try {
    parsed = parseWebhook(JSON.parse(rawBody));
  } catch {
    return { accepted: 0, skipped: 0 };
  }

  let accepted = 0;
  let skipped = 0;

  for (const msg of parsed.messages) {
    const account = await resolveAccount(msg.phoneNumberId);
    if (!account) { skipped++; continue; }

    const tenant = await getTenantById(account.tenantId);
    if (!tenant || !isTenantServable(tenant)) { skipped++; continue; }
    if (!(await hasFeature(account.tenantId, "whatsapp"))) { skipped++; continue; }

    const fresh = await withTenant(account.tenantId, (tx) => recordInbound(account, msg, tx));
    if (fresh) {
      accepted++;
      await handleInbound(account, msg, provider);
    } else {
      skipped++;
    }
  }

  // Status callbacks never touch conversation state.
  for (const st of parsed.statuses) {
    void st; // Phase 2 Task 16 updates whatsapp_messages.deliveryStatus.
  }

  return { accepted, skipped };
}

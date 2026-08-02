import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { checkQuota } from "@/server/entitlements/service";
import { whatsappAccounts, type WhatsappAccount } from "./schema";
import { exchangeCode } from "./graph";

function auditCtx(tenantId: string, audit: AuditActorInput) {
  return { tenantId, actorUserId: audit.actorUserId ?? null, fingerprint: audit.fingerprint };
}

export async function linkAccount(
  tenantId: string,
  input: { code: string },
  audit: AuditActorInput,
): Promise<WhatsappAccount> {
  // Identifiers come from Meta, never from the caller.
  const meta = await exchangeCode(input.code);

  const existing = await withTenant(tenantId, (tx) =>
    tx.select().from(whatsappAccounts)
      .where(and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.status, "active"))));
  await checkQuota(tenantId, "whatsapp_numbers", existing.length);

  return withTenant(tenantId, async (tx) => {
    const [account] = await tx.insert(whatsappAccounts).values({
      tenantId,
      wabaId: meta.wabaId,
      phoneNumberId: meta.phoneNumberId,
      displayPhoneNumber: meta.displayPhoneNumber,
      tokenRef: meta.tokenRef,
      status: "active",
    }).returning();

    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "whatsapp.account_linked",
      entityType: "whatsapp_account",
      entityId: account.id,
      summary: `Linked WhatsApp number ${meta.displayPhoneNumber}`,
      metadata: { wabaId: meta.wabaId, phoneNumberId: meta.phoneNumberId },
    }, tx);

    return account;
  });
}

export async function unlinkAccount(tenantId: string, accountId: string, audit: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(whatsappAccounts)
      .set({ status: "disconnected", disconnectedAt: new Date() })
      .where(and(eq(whatsappAccounts.id, accountId), eq(whatsappAccounts.tenantId, tenantId)))
      .returning();
    if (!row) return;

    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "whatsapp.account_unlinked",
      entityType: "whatsapp_account",
      entityId: accountId,
      summary: `Unlinked WhatsApp number ${row.displayPhoneNumber}`,
    }, tx);
  });
}

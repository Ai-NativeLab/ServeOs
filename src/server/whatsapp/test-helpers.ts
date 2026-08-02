import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { whatsappAccounts, whatsappConversations, type WhatsappAccount } from "./schema";
import type { InboundMessage } from "./payload";

let n = 0;

/** A tenant with one branch, one published product, and a linked WhatsApp number. */
export async function seedWhatsappContext(): Promise<{
  account: WhatsappAccount; tenantId: string; branchId: string; categoryId: string; productId: string;
}> {
  const i = n++;
  const [t] = await db.insert(tenants).values({
    slug: `wa-run-${i}`, name: "T", country: "EG", vertical: "restaurant", status: "active",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");

  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const category = await createCategory(t.id, { nameEn: "Pizza", nameAr: "بيتزا" });
  const product = await createProduct(t.id, {
    categoryId: category.id, nameEn: "Margherita", nameAr: "مارغريتا", basePrice: "100",
  });
  await updateProduct(t.id, product.id, { isPublished: true });

  const [account] = await db.insert(whatsappAccounts).values({
    tenantId: t.id, wabaId: "w", phoneNumberId: `pn-run-${i}`,
    displayPhoneNumber: "+20100", tokenRef: "env://X", status: "active",
  }).returning();

  return { account, tenantId: t.id, branchId: branch.id, categoryId: category.id, productId: product.id };
}

let wamid = 0;

export function inboundText(text: string): InboundMessage {
  return {
    phoneNumberId: "pn", waId: "201111111111", profileName: "Ahmed",
    providerMessageId: `wamid.t.${wamid++}`, timestamp: 1750000000 + wamid,
    event: { kind: "text", text },
  };
}

/**
 * Builds a tap carrying the conversation's CURRENT stateVersion — exactly what a
 * real client echoes back. Async because it reads that version from the database.
 * Do not weaken the reducer's version check to make tests convenient.
 */
export async function inboundTap(tenantId: string, waId: string, action: string, payload: string): Promise<InboundMessage> {
  const [conv] = await withTenant(tenantId, (tx) =>
    tx.select().from(whatsappConversations)
      .where(and(eq(whatsappConversations.tenantId, tenantId), eq(whatsappConversations.waId, waId))).limit(1));
  const version = conv?.stateVersion ?? 0;
  return {
    phoneNumberId: "pn", waId, profileName: "Ahmed",
    providerMessageId: `wamid.i.${wamid++}`, timestamp: 1750000000 + wamid,
    event: { kind: "interactive", replyId: `${action}:${version}:${payload}` },
  };
}

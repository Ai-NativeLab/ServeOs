import { sql, and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { getPublishedMenu } from "@/server/catalog/service";
import { listBranches } from "@/server/branches/service";
import { placeOrder } from "@/server/ordering/service";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { computeCartTotals } from "@/lib/order-totals";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { reduce, type CatalogSlice } from "./reducer";
import { whatsappConversations, whatsappOrderReceipts, type WhatsappAccount, type CartLine } from "./schema";
import type { InboundMessage } from "./payload";
import type { WhatsAppProvider } from "./provider";

/**
 * Processes one inbound message end to end.
 *
 * The conversation row is shared mutable state and a customer can double-tap, so
 * the whole read-reduce-write cycle is serialized on an advisory lock keyed
 * `tenantId:waId`. That key is deliberately NOT hashtext(tenantId) — placeOrder
 * and the audit chain already own that one. The conversation lock is always
 * taken BEFORE placeOrder acquires the tenant lock, never the reverse.
 */
export async function handleInbound(
  account: WhatsappAccount,
  msg: InboundMessage,
  provider: WhatsAppProvider,
): Promise<void> {
  const { tenantId } = account;

  const outbound = await withTenant(tenantId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${msg.waId}`})::bigint)`);

    let [conv] = await tx.select().from(whatsappConversations)
      .where(and(eq(whatsappConversations.tenantId, tenantId), eq(whatsappConversations.waId, msg.waId)))
      .limit(1);

    if (!conv) {
      [conv] = await tx.insert(whatsappConversations)
        .values({ tenantId, waId: msg.waId, state: "idle", cart: [], profileName: msg.profileName })
        .returning();
    }

    // Drop a message older than the one we last processed: retries are
    // independent, so delivery order is not guaranteed.
    if (conv.lastInboundAt && msg.timestamp * 1000 < conv.lastInboundAt.getTime()) return [];

    const branches = (await listBranches(tenantId)).map((b) => ({ id: b.id, name: b.name }));
    const catalog = await loadCatalogSlice(tenantId, conv.branchId);

    const out = reduce({
      state: conv.state,
      stateVersion: conv.stateVersion,
      cart: conv.cart,
      inbound: msg.event,
      catalog,
      branches,
      branchId: conv.branchId,
      profileName: msg.profileName ?? conv.profileName,
      customerName: conv.customerName,
    });

    // Effects run before the state write so a failure rolls the whole turn back.
    for (const effect of out.effects) {
      if (effect.kind === "placeOrder") {
        await runPlaceOrder(
          tx, account, conv.id, msg, catalog,
          out.nextCart.length ? out.nextCart : conv.cart,
          conv.branchId, out.nextCustomerName ?? conv.customerName,
        );
      }
      // mintHandoff is Task 14.
    }

    const [updated] = await tx.update(whatsappConversations)
      .set({
        state: out.effects.some((e) => e.kind === "placeOrder") ? "placed" : out.nextState,
        stateVersion: conv.stateVersion + 1,
        cart: out.effects.some((e) => e.kind === "placeOrder") ? [] : out.nextCart,
        branchId: out.nextBranchId,
        customerName: out.nextCustomerName,
        profileName: msg.profileName ?? conv.profileName,
        pendingProductId: out.pendingProductId,
        lastInboundAt: new Date(msg.timestamp * 1000),
        updatedAt: new Date(),
      })
      // Optimistic guard, the same discipline transitionStatus uses.
      .where(and(eq(whatsappConversations.id, conv.id), eq(whatsappConversations.stateVersion, conv.stateVersion)))
      .returning({ id: whatsappConversations.id });
    if (!updated) return [];

    return out.outbound;
  });

  for (const m of outbound) {
    await provider.send(account, msg.waId, m);
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function runPlaceOrder(
  tx: Tx, account: WhatsappAccount, conversationId: string,
  msg: InboundMessage, catalog: CatalogSlice, cart: CartLine[],
  branchId: string | null, customerName: string | null,
): Promise<void> {
  if (!branchId || !customerName || cart.length === 0) return;

  // Reserve the receipt BEFORE placing — a Meta retry must not create a second
  // real order. Same ordering as record-sale.ts.
  const reserved = await tx.insert(whatsappOrderReceipts)
    .values({ tenantId: account.tenantId, conversationId, confirmMessageId: msg.providerMessageId })
    .onConflictDoNothing({ target: [whatsappOrderReceipts.conversationId, whatsappOrderReceipts.confirmMessageId] })
    .returning({ id: whatsappOrderReceipts.id });
  if (reserved.length === 0) return;

  // Re-price from the catalog now, and hand placeOrder the number we are about
  // to show, so it can refuse rather than quietly charge something else. A cart
  // line holds ids only — the price comes fresh from the published menu.
  const pricing = await getCheckoutPricing(account.tenantId);
  const priced = cart.map((l) => {
    const variant = l.variantId ? catalog.variants.find((v) => v.id === l.variantId) : undefined;
    const product = catalog.products.find((p) => p.id === l.productId);
    return { unitPrice: variant?.price ?? product?.price ?? 0, quantity: l.quantity };
  });
  const totals = computeCartTotals(pricing, priced, 0);

  const lines = cart.map((l) => ({
    productId: l.productId, variantId: l.variantId, quantity: l.quantity, selectedOptionIds: [] as string[],
  }));

  const result = await placeOrder(account.tenantId, {
    branchId,
    fulfillmentType: "pickup",
    customerName,
    customerPhone: `+${msg.waId}`,
    channel: "whatsapp",
    lines,
    expectedTotal: totals.total,
    audit: { fingerprint: emptyFingerprint(), actorType: "customer" },
  });

  await tx.update(whatsappOrderReceipts)
    .set({ orderId: result.orderId })
    .where(eq(whatsappOrderReceipts.id, reserved[0].id));

  await recordAuditEvent(
    { tenantId: account.tenantId, actorUserId: null, fingerprint: emptyFingerprint() },
    {
      action: "whatsapp.order_placed",
      entityType: "order",
      entityId: result.orderId,
      summary: `WhatsApp order #${result.orderNumber} for ${customerName}`,
      metadata: { waId: msg.waId, orderNumber: result.orderNumber },
      actorType: "customer",
    },
    tx,
  );
}

/**
 * Flattens PublishedMenu (src/server/catalog/schema.ts:103) into the shape the
 * reducer consumes. PublishedMenu nests products INSIDE categories, so products
 * and variants are flatMapped out and the category id is carried down.
 *
 * Out-of-stock products are dropped rather than shown and then rejected by
 * placeOrder at the last step.
 */
async function loadCatalogSlice(tenantId: string, branchId: string | null): Promise<CatalogSlice> {
  const menu = await getPublishedMenu(tenantId, branchId ?? undefined);
  return {
    categories: menu.categories.map((c) => ({ id: c.id, name: c.nameEn })),
    products: menu.categories.flatMap((c) =>
      c.products
        .filter((p) => p.inStock)
        .map((p) => ({
          id: p.id,
          categoryId: c.id,
          name: p.nameEn,
          price: p.effectivePrice,
          hasVariants: p.variants.length > 0,
          // The column is `required`, not `isRequired` (catalog/schema.ts).
          hasRequiredModifiers: p.modifierGroups.some((g) => g.required),
        })),
    ),
    variants: menu.categories.flatMap((c) =>
      c.products.flatMap((p) =>
        p.variants
          .filter((v) => v.inStock)
          .map((v) => ({ id: v.id, productId: p.id, name: v.nameEn, price: v.price })),
      ),
    ),
  };
}

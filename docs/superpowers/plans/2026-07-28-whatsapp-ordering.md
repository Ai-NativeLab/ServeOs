# WhatsApp Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer messages a merchant's own WhatsApp number, taps through a catalog, and places a real pickup order that lands in the same dashboard and POS as every other order.

**Architecture:** A control-plane `whatsapp_accounts` table maps an inbound `phone_number_id` to a tenant *before* `withTenant` can open. A webhook route verifies Meta's HMAC over the raw body, fans out batched entries per tenant, and drives a **pure reducer** — `(state, cart, inbound, catalog, branch) → (nextState, nextCart, outbound, effects)` — whose effects run in an impure runner. Orders go through the existing `placeOrder`; nothing new computes money.

**Tech Stack:** Next.js App Router (modified fork — read `node_modules/next/dist/docs/` before touching route handlers), Drizzle ORM + Postgres with FORCE RLS, vitest, Meta WhatsApp Cloud API.

**Spec:** `docs/superpowers/specs/2026-07-28-whatsapp-ordering-design.md`

## Global Constraints

- **Branch from `main`.** PRs #22 and #27 merged 2026-07-28; the Spec 4 audit implementation is on `main`.
- **Never invent a new entitlement.** `PlanFeatures.whatsapp`, `PlanLimits.whatsapp_numbers` and `PlanLimits.messages_per_month` already exist in `src/server/subscription/schema.ts`, seeded across all three plans. Use them.
- **Interactive lists cap at 10 rows TOTAL across all sections** — not per section. Page at 9 rows plus one "next".
- Row title ≤24 chars, row description ≤72, section title ≤24. Reply buttons: max 3, ≤20 chars each, labels unique.
- **Money math lives only in `src/lib/order-totals.ts`.** The bot stores selection ids and never a price.
- **`recordAuditEvent` must be called inside `withTenant`, on the caller's `tx`.** Signature: `recordAuditEvent(ctx: AuditContext, event: AuditEventInput, tx)`.
- **Conversation advisory lock is keyed `hashtext(tenantId || ':' || waId)`** — deliberately NOT `hashtext(tenantId)`, which `placeOrder` and the audit chain already use. Always take the conversation lock **before** calling `placeOrder`, never the reverse.
- **RLS convention:** `drizzle-kit generate` does not emit RLS. Hand-append `ENABLE` / `FORCE ROW LEVEL SECURITY` / `CREATE POLICY <table>_isolation` blocks to the generated `.sql`, matching `drizzle/0019_gorgeous_rocket_racer.sql:65-79`.
- After every migration: `npm run db:migrate && npm run db:migrate:test && npm run db:check`.
- Next migration index is **0021** (0020 is the newest on disk).

---

# Phase 1 — Onboarding and webhook plumbing

Deliverable: a merchant links their number; their messages arrive, verified, deduped, routed to the right tenant, and stored. The bot does not reply yet.

---

### Task 1: `whatsapp_accounts` schema and migration

**Files:**
- Create: `src/server/whatsapp/schema.ts`
- Modify: `src/db/schema.ts` (add the re-export line)
- Create: `drizzle/0021_<generated>.sql` (hand-edited)
- Test: `src/server/whatsapp/schema.test.ts`

**Interfaces:**
- Produces: `whatsappAccounts` table; types `WhatsappAccount`, `WhatsappAccountStatus`.

**Why no RLS:** the tenant is unknown until this table is read. This is the same control-plane role `pos_devices` plays (`src/server/pos/schema.ts:7`).

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/schema.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { whatsappAccounts } from "./schema";

describe("whatsapp_accounts", () => {
  it("allows only one ACTIVE row per phoneNumberId, but permits relinking after disconnect", async () => {
    const [a] = await db.insert(tenants).values({ slug: "wa-a", name: "A", country: "EG", vertical: "restaurant" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "wa-b", name: "B", country: "EG", vertical: "restaurant" }).returning();

    await db.insert(whatsappAccounts).values({
      tenantId: a.id, wabaId: "waba-1", phoneNumberId: "pn-1",
      displayPhoneNumber: "+201000000000", tokenRef: "sm://wa/a", status: "active",
    });

    // A second ACTIVE claim on the same number must fail.
    await expect(
      db.insert(whatsappAccounts).values({
        tenantId: b.id, wabaId: "waba-2", phoneNumberId: "pn-1",
        displayPhoneNumber: "+201000000000", tokenRef: "sm://wa/b", status: "active",
      }),
    ).rejects.toThrow();

    // Disconnecting the first frees the number for a new owner.
    await db.update(whatsappAccounts).set({ status: "disconnected" });
    await expect(
      db.insert(whatsappAccounts).values({
        tenantId: b.id, wabaId: "waba-2", phoneNumberId: "pn-1",
        displayPhoneNumber: "+201000000000", tokenRef: "sm://wa/b", status: "active",
      }),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/schema.test.ts`
Expected: FAIL — cannot resolve `./schema`.

- [ ] **Step 3: Write the schema**

```ts
// src/server/whatsapp/schema.ts
import { pgTable, uuid, text, timestamp, boolean, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";

export const whatsappAccountStatusEnum = pgEnum("whatsapp_account_status", ["active", "disconnected", "suspended"]);

/**
 * CONTROL-PLANE — intentionally NO RLS, like pos_devices. An inbound webhook
 * carries only a phone_number_id; the tenant must be resolved from this table
 * before withTenant can open. Writes still happen inside withTenant so the
 * audit insert has app.tenant_id set (Spec 4).
 *
 * tokenRef is a SECRET-MANAGER REFERENCE, never a token and never ciphertext.
 * This table has no RLS, so one unscoped query would otherwise expose every
 * tenant's Meta credentials at once.
 */
export const whatsappAccounts = pgTable("whatsapp_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  wabaId: text("waba_id").notNull(),
  phoneNumberId: text("phone_number_id").notNull(),
  displayPhoneNumber: text("display_phone_number").notNull(),
  tokenRef: text("token_ref").notNull(),
  status: whatsappAccountStatusEnum("status").notNull().default("active"),
  coexistence: boolean("coexistence").notNull().default(true),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
}, (t) => [
  // PARTIAL unique: a churned number must be re-linkable by its next owner.
  // Verify the WHERE predicate survives generation in Step 5.
  uniqueIndex("whatsapp_accounts_phone_active").on(t.phoneNumberId).where(sql`status = 'active'`),
]);

export type WhatsappAccount = typeof whatsappAccounts.$inferSelect;
export type WhatsappAccountStatus = (typeof whatsappAccountStatusEnum.enumValues)[number];
```

- [ ] **Step 4: Register the schema**

Add to `src/db/schema.ts`, matching the existing re-export style:

```ts
export * from "@/server/whatsapp/schema";
```

- [ ] **Step 5: Generate and verify the migration**

Run: `npm run db:generate`

Open the generated `drizzle/0021_*.sql` and confirm the index reads:

```sql
CREATE UNIQUE INDEX "whatsapp_accounts_phone_active" ON "whatsapp_accounts" USING btree ("phone_number_id") WHERE status = 'active';
```

If the `WHERE` clause is missing, add it by hand — without it a disconnected number can never be relinked. No RLS block for this table: it is deliberately control-plane.

- [ ] **Step 6: Apply and check**

Run: `npm run db:migrate && npm run db:migrate:test && npm run db:check`
Expected: both migrate cleanly, `db:check` reports nothing pending.

- [ ] **Step 7: Run the test**

Run: `npx vitest run src/server/whatsapp/schema.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/whatsapp/schema.ts src/server/whatsapp/schema.test.ts src/db/schema.ts drizzle/
git commit -m "feat(whatsapp): whatsapp_accounts control-plane table with partial-unique active number"
```

---

### Task 2: Webhook signature verification

**Files:**
- Create: `src/server/whatsapp/signature.ts`
- Test: `src/server/whatsapp/signature.test.ts`

**Interfaces:**
- Produces: `verifyWebhookSignature(rawBody: string, header: string | null, appSecret: string): boolean` — pure, no I/O.

This is the security boundary. It must **fail closed** on every abnormal input, and must never throw.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/signature.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "./signature";

const SECRET = "test-app-secret";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(verifyWebhookSignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("fails closed on a missing header", () => {
    expect(verifyWebhookSignature("{}", null, SECRET)).toBe(false);
  });

  it("fails closed on a malformed header rather than throwing", () => {
    // timingSafeEqual throws on unequal buffer lengths — that must not escape.
    expect(verifyWebhookSignature("{}", "sha256=abcd", SECRET)).toBe(false);
    expect(verifyWebhookSignature("{}", "garbage", SECRET)).toBe(false);
    expect(verifyWebhookSignature("{}", "sha256=", SECRET)).toBe(false);
    expect(verifyWebhookSignature("{}", "sha256=zzzz-not-hex", SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const body = "{}";
    const wrong = "sha256=" + createHmac("sha256", "other").update(body).digest("hex");
    expect(verifyWebhookSignature(body, wrong, SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/signature.test.ts`
Expected: FAIL — cannot resolve `./signature`.

- [ ] **Step 3: Implement**

```ts
// src/server/whatsapp/signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Meta's X-Hub-Signature-256 over the RAW request body.
 *
 * Fails closed on every abnormal input and never throws: timingSafeEqual raises
 * on unequal buffer lengths, and an uncaught raise here would turn "verify" into
 * "crash", which a caller could mistake for a transport error and retry.
 */
export function verifyWebhookSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);
  // Hex of a sha256 digest is always 64 chars; anything else cannot match.
  if (provided.length !== 64 || !/^[0-9a-f]+$/i.test(provided)) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/server/whatsapp/signature.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/whatsapp/signature.ts src/server/whatsapp/signature.test.ts
git commit -m "feat(whatsapp): fail-closed HMAC verification of Meta webhook signatures"
```

---

### Task 3: Webhook payload parsing — batching, and the statuses/errors/messages split

**Files:**
- Create: `src/server/whatsapp/payload.ts`
- Test: `src/server/whatsapp/payload.test.ts`

**Interfaces:**
- Produces:
  - `type InboundEvent = { kind: "text"; text: string } | { kind: "interactive"; replyId: string } | { kind: "location"; lat: number; lng: number } | { kind: "unsupported" }`
  - `type InboundMessage = { phoneNumberId: string; waId: string; profileName: string | null; providerMessageId: string; timestamp: number; event: InboundEvent }`
  - `type StatusUpdate = { providerMessageId: string; status: string }`
  - `parseWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] }`

A single POST can batch many `entry[]`/`changes[]`, **including entries for different tenants**. Reading only `entry[0].changes[0]` silently drops real messages.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/payload.test.ts
import { describe, it, expect } from "vitest";
import { parseWebhook } from "./payload";

const msg = (pnId: string, wamid: string, body: string) => ({
  id: "entry-" + wamid,
  changes: [{
    field: "messages",
    value: {
      metadata: { phone_number_id: pnId, display_phone_number: "+201000000000" },
      contacts: [{ profile: { name: "Ahmed" }, wa_id: "201111111111" }],
      messages: [{ from: "201111111111", id: wamid, timestamp: "1750000000", type: "text", text: { body } }],
    },
  }],
});

describe("parseWebhook", () => {
  it("returns every message in a batch spanning multiple tenants", () => {
    const { messages } = parseWebhook({
      object: "whatsapp_business_account",
      entry: [msg("pn-A", "wamid.1", "hi"), msg("pn-B", "wamid.2", "hello")],
    });
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.phoneNumberId)).toEqual(["pn-A", "pn-B"]);
    expect(messages[0].event).toEqual({ kind: "text", text: "hi" });
    expect(messages[0].profileName).toBe("Ahmed");
  });

  it("returns multiple messages batched inside one change", () => {
    const e = msg("pn-A", "wamid.1", "one");
    e.changes[0].value.messages.push({
      from: "201111111111", id: "wamid.2", timestamp: "1750000001", type: "text", text: { body: "two" },
    } as never);
    const { messages } = parseWebhook({ object: "whatsapp_business_account", entry: [e] });
    expect(messages).toHaveLength(2);
  });

  it("separates status callbacks from inbound messages", () => {
    const { messages, statuses } = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "e1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "pn-A" },
            statuses: [{ id: "wamid.out.1", status: "delivered", timestamp: "1750000000" }],
          },
        }],
      }],
    });
    expect(messages).toHaveLength(0);
    expect(statuses).toEqual([{ providerMessageId: "wamid.out.1", status: "delivered" }]);
  });

  it("maps an interactive reply to its stable id, not its localized title", () => {
    const { messages } = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "e1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "pn-A" },
            contacts: [{ profile: { name: "Ahmed" }, wa_id: "201111111111" }],
            messages: [{
              from: "201111111111", id: "wamid.3", timestamp: "1750000000", type: "interactive",
              interactive: { type: "list_reply", list_reply: { id: "add:7:prod-1", title: "Margherita" } },
            }],
          },
        }],
      }],
    });
    expect(messages[0].event).toEqual({ kind: "interactive", replyId: "add:7:prod-1" });
  });

  it("classifies media and stickers as unsupported rather than dropping them", () => {
    const { messages } = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "e1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "pn-A" },
            contacts: [{ profile: { name: "A" }, wa_id: "201111111111" }],
            messages: [{ from: "201111111111", id: "wamid.4", timestamp: "1750000000", type: "sticker", sticker: { id: "s1" } }],
          },
        }],
      }],
    });
    expect(messages[0].event).toEqual({ kind: "unsupported" });
  });

  it("returns empty for junk rather than throwing", () => {
    expect(parseWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook({ entry: "nope" })).toEqual({ messages: [], statuses: [] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/payload.test.ts`
Expected: FAIL — cannot resolve `./payload`.

- [ ] **Step 3: Implement**

```ts
// src/server/whatsapp/payload.ts

export type InboundEvent =
  | { kind: "text"; text: string }
  | { kind: "interactive"; replyId: string }
  | { kind: "location"; lat: number; lng: number }
  | { kind: "unsupported" };

export type InboundMessage = {
  phoneNumberId: string;
  waId: string;
  profileName: string | null;
  providerMessageId: string;
  /** Meta's unix seconds. Used to drop out-of-order replays. */
  timestamp: number;
  event: InboundEvent;
};

export type StatusUpdate = { providerMessageId: string; status: string };

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toEvent(m: Record<string, unknown>): InboundEvent {
  const type = m.type;
  if (type === "text") {
    const body = (m.text as { body?: string } | undefined)?.body;
    return typeof body === "string" ? { kind: "text", text: body } : { kind: "unsupported" };
  }
  if (type === "interactive") {
    const i = m.interactive as { list_reply?: { id?: string }; button_reply?: { id?: string } } | undefined;
    // Key off the stable id. Titles are localized and truncated to 24 chars.
    const id = i?.list_reply?.id ?? i?.button_reply?.id;
    return typeof id === "string" ? { kind: "interactive", replyId: id } : { kind: "unsupported" };
  }
  if (type === "location") {
    const l = m.location as { latitude?: number; longitude?: number } | undefined;
    if (typeof l?.latitude === "number" && typeof l?.longitude === "number") {
      return { kind: "location", lat: l.latitude, lng: l.longitude };
    }
    return { kind: "unsupported" };
  }
  return { kind: "unsupported" };
}

/**
 * Flattens Meta's entry[].changes[].value shape.
 *
 * A single POST may batch many entries — including entries belonging to
 * DIFFERENT tenants — so every level is iterated. Status callbacks arrive on the
 * same endpoint as customer messages and are separated here so they can never
 * reach conversation state.
 */
export function parseWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const root = (payload ?? {}) as { entry?: unknown };

  for (const entry of asArray(root.entry)) {
    for (const change of asArray((entry as { changes?: unknown }).changes)) {
      const value = (change as { value?: Record<string, unknown> }).value ?? {};
      const phoneNumberId = (value.metadata as { phone_number_id?: string } | undefined)?.phone_number_id;
      if (!phoneNumberId) continue;

      for (const s of asArray(value.statuses)) {
        const st = s as { id?: string; status?: string };
        if (st.id && st.status) statuses.push({ providerMessageId: st.id, status: st.status });
      }

      const contacts = asArray(value.contacts) as { profile?: { name?: string }; wa_id?: string }[];
      for (const raw of asArray(value.messages)) {
        const m = raw as Record<string, unknown>;
        const from = m.from as string | undefined;
        const id = m.id as string | undefined;
        if (!from || !id) continue;
        const contact = contacts.find((c) => c.wa_id === from) ?? contacts[0];
        messages.push({
          phoneNumberId,
          waId: from,
          profileName: contact?.profile?.name ?? null,
          providerMessageId: id,
          timestamp: Number(m.timestamp ?? 0),
          event: toEvent(m),
        });
      }
    }
  }
  return { messages, statuses };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/server/whatsapp/payload.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/whatsapp/payload.ts src/server/whatsapp/payload.test.ts
git commit -m "feat(whatsapp): parse batched webhook payloads, split statuses from messages"
```

---

### Task 4: `WhatsAppProvider` interface and the fake

**Files:**
- Create: `src/server/whatsapp/provider.ts`
- Create: `src/server/whatsapp/cloud-api-provider.ts`
- Create: `src/server/whatsapp/fake-provider.ts`
- Test: `src/server/whatsapp/fake-provider.test.ts`

**Interfaces:**
- Produces:
  - `type OutboundMessage = { kind: "text"; body: string } | { kind: "buttons"; body: string; buttons: {id:string;title:string}[] } | { kind: "list"; body: string; button: string; rows: {id:string;title:string;description?:string}[] }`
  - `interface WhatsAppProvider { send(account: WhatsappAccount, waId: string, msg: OutboundMessage): Promise<string>; }`
  - `class FakeWhatsAppProvider implements WhatsAppProvider` with a public `sent` array.

Mirrors `ManualBillingProvider` — the interface exists so tests never touch the network.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/fake-provider.test.ts
import { describe, it, expect } from "vitest";
import { FakeWhatsAppProvider } from "./fake-provider";
import type { WhatsappAccount } from "./schema";

const account = { id: "a", phoneNumberId: "pn-1", tokenRef: "sm://x" } as WhatsappAccount;

describe("FakeWhatsAppProvider", () => {
  it("records what was sent and returns a unique message id", async () => {
    const p = new FakeWhatsAppProvider();
    const id1 = await p.send(account, "201111111111", { kind: "text", body: "hi" });
    const id2 = await p.send(account, "201111111111", { kind: "text", body: "again" });
    expect(id1).not.toEqual(id2);
    expect(p.sent).toHaveLength(2);
    expect(p.sent[0]).toMatchObject({ waId: "201111111111", msg: { kind: "text", body: "hi" } });
  });

  it("rejects a list with more than 10 rows — Meta's hard cap across ALL sections", async () => {
    const p = new FakeWhatsAppProvider();
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));
    await expect(p.send(account, "2011", { kind: "list", body: "b", button: "Pick", rows }))
      .rejects.toThrow(/10 rows/);
  });

  it("rejects a row title over 24 characters", async () => {
    const p = new FakeWhatsAppProvider();
    await expect(p.send(account, "2011", {
      kind: "list", body: "b", button: "Pick",
      rows: [{ id: "r", title: "This title is definitely too long" }],
    })).rejects.toThrow(/24/);
  });

  it("rejects more than 3 buttons", async () => {
    const p = new FakeWhatsAppProvider();
    const buttons = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}` }));
    await expect(p.send(account, "2011", { kind: "buttons", body: "b", buttons })).rejects.toThrow(/3 buttons/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/fake-provider.test.ts`
Expected: FAIL — cannot resolve `./fake-provider`.

- [ ] **Step 3: Write the interface**

```ts
// src/server/whatsapp/provider.ts
import type { WhatsappAccount } from "./schema";

export type ListRow = { id: string; title: string; description?: string };
export type Button = { id: string; title: string };

export type OutboundMessage =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: Button[] }
  | { kind: "list"; body: string; button: string; rows: ListRow[] };

/** Meta's hard limits. Exported so the renderer and the providers agree. */
export const LIST_MAX_ROWS = 10;
export const ROW_TITLE_MAX = 24;
export const ROW_DESC_MAX = 72;
export const BUTTON_MAX = 3;
export const BUTTON_TITLE_MAX = 20;

/** Throws if `msg` would be rejected by Meta. Shared by every provider. */
export function assertSendable(msg: OutboundMessage): void {
  if (msg.kind === "list") {
    // 10 rows TOTAL across all sections — sections group, they do not add capacity.
    if (msg.rows.length > LIST_MAX_ROWS) throw new Error(`list exceeds ${LIST_MAX_ROWS} rows`);
    for (const r of msg.rows) {
      if (r.title.length > ROW_TITLE_MAX) throw new Error(`row title exceeds ${ROW_TITLE_MAX} chars: ${r.title}`);
      if (r.description && r.description.length > ROW_DESC_MAX) throw new Error(`row description exceeds ${ROW_DESC_MAX} chars`);
    }
  }
  if (msg.kind === "buttons") {
    if (msg.buttons.length > BUTTON_MAX) throw new Error(`more than ${BUTTON_MAX} buttons`);
    for (const b of msg.buttons) {
      if (b.title.length > BUTTON_TITLE_MAX) throw new Error(`button title exceeds ${BUTTON_TITLE_MAX} chars`);
    }
    const ids = new Set(msg.buttons.map((b) => b.title));
    if (ids.size !== msg.buttons.length) throw new Error("button labels must be unique");
  }
}

export interface WhatsAppProvider {
  /** Returns the provider message id (wamid) of the sent message. */
  send(account: WhatsappAccount, waId: string, msg: OutboundMessage): Promise<string>;
}
```

- [ ] **Step 4: Write the fake**

```ts
// src/server/whatsapp/fake-provider.ts
import { assertSendable, type OutboundMessage, type WhatsAppProvider } from "./provider";
import type { WhatsappAccount } from "./schema";

export class FakeWhatsAppProvider implements WhatsAppProvider {
  public sent: { waId: string; msg: OutboundMessage }[] = [];
  private n = 0;

  async send(_account: WhatsappAccount, waId: string, msg: OutboundMessage): Promise<string> {
    assertSendable(msg);
    this.sent.push({ waId, msg });
    return `wamid.fake.${this.n++}`;
  }
}
```

- [ ] **Step 5: Write the Cloud API provider**

```ts
// src/server/whatsapp/cloud-api-provider.ts
import { assertSendable, type OutboundMessage, type WhatsAppProvider } from "./provider";
import { resolveToken } from "./secrets";
import type { WhatsappAccount } from "./schema";

const GRAPH = "https://graph.facebook.com/v21.0";

function toBody(waId: string, msg: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: waId };
  if (msg.kind === "text") return { ...base, type: "text", text: { body: msg.body } };
  if (msg.kind === "buttons") {
    return {
      ...base, type: "interactive",
      interactive: {
        type: "button", body: { text: msg.body },
        action: { buttons: msg.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    };
  }
  return {
    ...base, type: "interactive",
    interactive: {
      type: "list", body: { text: msg.body },
      action: { button: msg.button, sections: [{ title: "Options", rows: msg.rows }] },
    },
  };
}

export class CloudApiProvider implements WhatsAppProvider {
  async send(account: WhatsappAccount, waId: string, msg: OutboundMessage): Promise<string> {
    assertSendable(msg);
    const token = await resolveToken(account.tokenRef);
    const res = await fetch(`${GRAPH}/${account.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(toBody(waId, msg)),
    });
    if (!res.ok) {
      // Never include the token or the raw response in the thrown message.
      throw new Error(`WhatsApp send failed: ${res.status}`);
    }
    const json = (await res.json()) as { messages?: { id: string }[] };
    const id = json.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp send returned no message id");
    return id;
  }
}
```

- [ ] **Step 6: Write the secret resolver**

```ts
// src/server/whatsapp/secrets.ts

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
```

- [ ] **Step 7: Run the test**

Run: `npx vitest run src/server/whatsapp/fake-provider.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add src/server/whatsapp/provider.ts src/server/whatsapp/cloud-api-provider.ts src/server/whatsapp/fake-provider.ts src/server/whatsapp/secrets.ts src/server/whatsapp/fake-provider.test.ts
git commit -m "feat(whatsapp): WhatsAppProvider interface, Cloud API impl, fake, Meta limit assertions"
```

---

### Task 5: `whatsapp_messages` and tenant routing

**Files:**
- Modify: `src/server/whatsapp/schema.ts`
- Create: `src/server/whatsapp/routing.ts`
- Create: `drizzle/0022_<generated>.sql` (hand-edited for RLS)
- Test: `src/server/whatsapp/routing.test.ts`

**Interfaces:**
- Consumes: `whatsappAccounts` (Task 1), `InboundMessage` (Task 3).
- Produces:
  - `whatsappMessages` table
  - `resolveAccount(phoneNumberId: string): Promise<WhatsappAccount | null>` — active rows only
  - `recordInbound(account, msg, tx): Promise<boolean>` — returns `false` if already seen

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/routing.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { whatsappAccounts } from "./schema";
import { resolveAccount, recordInbound } from "./routing";
import type { InboundMessage } from "./payload";

async function seedAccount(slug: string, pnId: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  const [a] = await db.insert(whatsappAccounts).values({
    tenantId: t.id, wabaId: "w", phoneNumberId: pnId,
    displayPhoneNumber: "+20100", tokenRef: "env://X", status: "active",
  }).returning();
  return { tenantId: t.id, account: a };
}

const inbound = (wamid: string): InboundMessage => ({
  phoneNumberId: "pn-r1", waId: "201111111111", profileName: "A",
  providerMessageId: wamid, timestamp: 1750000000, event: { kind: "text", text: "hi" },
});

describe("routing", () => {
  it("resolves an active account and ignores a disconnected one", async () => {
    const { tenantId } = await seedAccount("wa-route-1", "pn-r1");
    expect((await resolveAccount("pn-r1"))?.tenantId).toBe(tenantId);

    await db.update(whatsappAccounts).set({ status: "disconnected" });
    expect(await resolveAccount("pn-r1")).toBeNull();
  });

  it("records an inbound message once and reports a replay as already seen", async () => {
    const { tenantId, account } = await seedAccount("wa-route-2", "pn-r1");
    const m = inbound("wamid.dedup.1");

    const first = await withTenant(tenantId, (tx) => recordInbound(account, m, tx));
    expect(first).toBe(true);

    // Meta retries for up to 7 days; the same wamid must not be processed twice.
    const second = await withTenant(tenantId, (tx) => recordInbound(account, m, tx));
    expect(second).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/routing.test.ts`
Expected: FAIL — cannot resolve `./routing`.

- [ ] **Step 3: Add the messages table**

Append to `src/server/whatsapp/schema.ts`:

```ts
export const whatsappDirectionEnum = pgEnum("whatsapp_direction", ["inbound", "outbound"]);

/** Inbound + outbound log. The unique providerMessageId is the replay guard. */
export const whatsappMessages = pgTable("whatsapp_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  waId: text("wa_id").notNull(),
  direction: whatsappDirectionEnum("direction").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  deliveryStatus: text("delivery_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("whatsapp_messages_provider_id").on(t.providerMessageId),
  index("whatsapp_messages_tenant_wa").on(t.tenantId, t.waId),
]);

export type WhatsappMessage = typeof whatsappMessages.$inferSelect;
```

Add `jsonb` and `index` to the `drizzle-orm/pg-core` import at the top of the file.

- [ ] **Step 4: Implement routing**

```ts
// src/server/whatsapp/routing.ts
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { whatsappAccounts, whatsappMessages, type WhatsappAccount } from "./schema";
import type { InboundMessage } from "./payload";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Control-plane lookup: runs OUTSIDE withTenant because the tenant is exactly
 * what we are trying to discover. Only `active` rows route — a disconnected or
 * suspended account must stop receiving orders immediately.
 */
export async function resolveAccount(phoneNumberId: string): Promise<WhatsappAccount | null> {
  const [row] = await db.select().from(whatsappAccounts)
    .where(and(eq(whatsappAccounts.phoneNumberId, phoneNumberId), eq(whatsappAccounts.status, "active")))
    .limit(1);
  return row ?? null;
}

/**
 * Records an inbound message. Returns false when this providerMessageId has
 * already been stored, which is the signal to skip processing entirely — Meta
 * retries a failed delivery for up to 7 days.
 */
export async function recordInbound(account: WhatsappAccount, msg: InboundMessage, tx: Tx): Promise<boolean> {
  const inserted = await tx.insert(whatsappMessages).values({
    tenantId: account.tenantId,
    waId: msg.waId,
    direction: "inbound",
    providerMessageId: msg.providerMessageId,
    payload: { event: msg.event, timestamp: msg.timestamp, profileName: msg.profileName },
  }).onConflictDoNothing({ target: whatsappMessages.providerMessageId }).returning({ id: whatsappMessages.id });
  return inserted.length > 0;
}
```

- [ ] **Step 5: Generate the migration and hand-append RLS**

Run: `npm run db:generate`

Append to the generated `.sql`, matching `drizzle/0019_gorgeous_rocket_racer.sql:65-79`:

```sql
ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_messages_isolation ON "whatsapp_messages"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

- [ ] **Step 6: Migrate and test**

Run: `npm run db:migrate && npm run db:migrate:test && npm run db:check && npx vitest run src/server/whatsapp/routing.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/server/whatsapp/ drizzle/
git commit -m "feat(whatsapp): whatsapp_messages with RLS, active-only account routing, wamid dedup"
```

---

### Task 6: The webhook route

**Files:**
- Create: `src/app/api/whatsapp/webhook/route.ts`
- Create: `src/server/whatsapp/ingest.ts`
- Test: `src/server/whatsapp/ingest.test.ts`

**Interfaces:**
- Consumes: `parseWebhook`, `resolveAccount`, `recordInbound`, `verifyWebhookSignature`, `isTenantServable`, `requireFeature`.
- Produces: `ingestWebhook(rawBody: string, signature: string | null): Promise<{ accepted: number; skipped: number }>`

**Read first:** `node_modules/next/dist/docs/` on route handlers. The HMAC must be computed over the **raw** bytes, so the handler must call `await req.text()` and parse afterwards — never `req.json()` then re-stringify.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/ingest.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { whatsappAccounts, whatsappMessages } from "./schema";
import { ingestWebhook } from "./ingest";

const SECRET = "app-secret";
const sign = (b: string) => "sha256=" + createHmac("sha256", SECRET).update(b).digest("hex");

const payload = (pnId: string, wamid: string) => JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{
    id: "e", changes: [{
      field: "messages",
      value: {
        metadata: { phone_number_id: pnId },
        contacts: [{ profile: { name: "A" }, wa_id: "201111111111" }],
        messages: [{ from: "201111111111", id: wamid, timestamp: "1750000000", type: "text", text: { body: "hi" } }],
      },
    }],
  }],
});

async function seedLinkedTenant(slug: string, pnId: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro"); // pro has whatsapp: true
  await db.insert(whatsappAccounts).values({
    tenantId: t.id, wabaId: "w", phoneNumberId: pnId,
    displayPhoneNumber: "+20100", tokenRef: "env://X", status: "active",
  });
  return t.id;
}

describe("ingestWebhook", () => {
  it("rejects an unsigned payload without writing anything", async () => {
    await seedLinkedTenant("wa-ing-1", "pn-i1");
    const body = payload("pn-i1", "wamid.unsigned");
    await expect(ingestWebhook(body, null)).rejects.toThrow(/signature/i);
    const rows = await db.select().from(whatsappMessages);
    expect(rows.find((r) => r.providerMessageId === "wamid.unsigned")).toBeUndefined();
  });

  it("accepts a signed message for a linked tenant", async () => {
    await seedLinkedTenant("wa-ing-2", "pn-i2");
    const body = payload("pn-i2", "wamid.ok");
    expect(await ingestWebhook(body, sign(body))).toEqual({ accepted: 1, skipped: 0 });
  });

  it("skips a replayed message", async () => {
    await seedLinkedTenant("wa-ing-3", "pn-i3");
    const body = payload("pn-i3", "wamid.replay");
    await ingestWebhook(body, sign(body));
    expect(await ingestWebhook(body, sign(body))).toEqual({ accepted: 0, skipped: 1 });
  });

  it("skips a message for an unknown phone number id", async () => {
    const body = payload("pn-unknown", "wamid.orphan");
    expect(await ingestWebhook(body, sign(body))).toEqual({ accepted: 0, skipped: 1 });
  });

  it("routes each entry of a multi-tenant batch to its own tenant", async () => {
    const t1 = await seedLinkedTenant("wa-ing-4", "pn-i4");
    const t2 = await seedLinkedTenant("wa-ing-5", "pn-i5");
    const merged = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        JSON.parse(payload("pn-i4", "wamid.b1")).entry[0],
        JSON.parse(payload("pn-i5", "wamid.b2")).entry[0],
      ],
    });
    expect(await ingestWebhook(merged, sign(merged))).toEqual({ accepted: 2, skipped: 0 });

    const rows = await db.select().from(whatsappMessages);
    expect(rows.find((r) => r.providerMessageId === "wamid.b1")!.tenantId).toBe(t1);
    expect(rows.find((r) => r.providerMessageId === "wamid.b2")!.tenantId).toBe(t2);
  });

  it("skips a suspended tenant so its bot stops taking orders", async () => {
    const t = await seedLinkedTenant("wa-ing-6", "pn-i6");
    await db.update(tenants).set({ status: "suspended" });
    const body = payload("pn-i6", "wamid.susp");
    expect(await ingestWebhook(body, sign(body))).toEqual({ accepted: 0, skipped: 1 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/ingest.test.ts`
Expected: FAIL — cannot resolve `./ingest`.

- [ ] **Step 3: Implement ingest**

```ts
// src/server/whatsapp/ingest.ts
import { withTenant } from "@/db/with-tenant";
import { getTenantById, isTenantServable } from "@/server/tenancy/service";
import { hasFeature } from "@/server/entitlements/service";
import { verifyWebhookSignature } from "./signature";
import { parseWebhook } from "./payload";
import { resolveAccount, recordInbound } from "./routing";

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
export async function ingestWebhook(rawBody: string, signature: string | null): Promise<{ accepted: number; skipped: number }> {
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
    if (fresh) accepted++; else skipped++;
    // Phase 2 drives the reducer here, for `fresh` messages only.
  }

  // Status callbacks never touch conversation state.
  for (const st of parsed.statuses) {
    void st; // Phase 2 Task 16 updates whatsapp_messages.deliveryStatus.
  }

  return { accepted, skipped };
}
```

- [ ] **Step 4: Write the route handler**

```ts
// src/app/api/whatsapp/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import { ingestWebhook, WebhookSignatureError } from "@/server/whatsapp/ingest";

/** Meta will not deliver a body larger than this; anything bigger is abuse. */
const MAX_BODY_BYTES = 1_000_000;

/** Meta's subscription handshake. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  // RAW body: the HMAC is over exactly the bytes Meta signed, so this must not
  // be req.json() followed by a re-stringify.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return new NextResponse("payload too large", { status: 413 });

  try {
    await ingestWebhook(rawBody, req.headers.get("x-hub-signature-256"));
  } catch (e) {
    if (e instanceof WebhookSignatureError) return new NextResponse("forbidden", { status: 403 });
    throw e;
  }
  // Always 200 on accepted work — a non-2xx makes Meta retry for up to 7 days.
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/server/whatsapp/ingest.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/whatsapp/ingest.ts src/server/whatsapp/ingest.test.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "feat(whatsapp): webhook route with raw-body HMAC, per-entry tenant fan-out, servable+entitlement gates"
```

---

### Task 7: Account linking via Embedded Signup

**Files:**
- Create: `src/server/whatsapp/linking.ts`
- Create: `src/app/dashboard/settings/whatsapp/connect/actions.ts`
- Modify: `src/server/audit/coverage.ts` (add `src/server/whatsapp/linking.ts`)
- Test: `src/server/whatsapp/linking.test.ts`

**Interfaces:**
- Produces: `linkAccount(tenantId, input: { code: string }, audit): Promise<WhatsappAccount>`, `unlinkAccount(tenantId, accountId, audit): Promise<void>`
- Emits audit actions `whatsapp.account_linked`, `whatsapp.account_unlinked`.

**The trust boundary:** `phoneNumberId` and `wabaId` come **only** from a server-to-server Graph exchange of the OAuth `code`. Never from a client-submitted field — the entire isolation model rests on this.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/linking.test.ts
import { describe, it, expect, vi } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { auditEvents } from "@/server/audit/schema";
import { eq } from "drizzle-orm";
import { linkAccount } from "./linking";
import * as graph from "./graph";

const audit = { fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null } };

async function seedTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  return t.id;
}

describe("linkAccount", () => {
  it("takes the phone number id from the Graph exchange, never from the caller", async () => {
    const tenantId = await seedTenant("wa-link-1");
    vi.spyOn(graph, "exchangeCode").mockResolvedValue({
      wabaId: "waba-real", phoneNumberId: "pn-real", displayPhoneNumber: "+201234567890", tokenRef: "env://T",
    });

    const account = await linkAccount(tenantId, { code: "oauth-code" }, audit);
    expect(account.phoneNumberId).toBe("pn-real");
    expect(account.wabaId).toBe("waba-real");
  });

  it("emits a whatsapp.account_linked audit event", async () => {
    const tenantId = await seedTenant("wa-link-2");
    vi.spyOn(graph, "exchangeCode").mockResolvedValue({
      wabaId: "w2", phoneNumberId: "pn-2", displayPhoneNumber: "+2012", tokenRef: "env://T",
    });
    await linkAccount(tenantId, { code: "c" }, audit);

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    expect(rows.some((r) => r.action === "whatsapp.account_linked")).toBe(true);
  });

  it("refuses a number already actively linked to another tenant", async () => {
    const t1 = await seedTenant("wa-link-3");
    const t2 = await seedTenant("wa-link-4");
    vi.spyOn(graph, "exchangeCode").mockResolvedValue({
      wabaId: "w", phoneNumberId: "pn-dup", displayPhoneNumber: "+2013", tokenRef: "env://T",
    });
    await linkAccount(t1, { code: "c" }, audit);
    await expect(linkAccount(t2, { code: "c" }, audit)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/linking.test.ts`
Expected: FAIL — cannot resolve `./linking`.

- [ ] **Step 3: Write the Graph exchange**

```ts
// src/server/whatsapp/graph.ts
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
```

- [ ] **Step 4: Write linking**

```ts
// src/server/whatsapp/linking.ts
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
```

- [ ] **Step 5: Register with the audit coverage guardrail**

Add to `AUDITED_SERVICE_FILES` in `src/server/audit/coverage.ts`:

```ts
  "src/server/whatsapp/linking.ts",
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/server/whatsapp/linking.test.ts src/server/audit/coverage.test.ts`
Expected: PASS — both the linking tests and the coverage guardrail.

- [ ] **Step 7: Commit**

```bash
git add src/server/whatsapp/linking.ts src/server/whatsapp/graph.ts src/server/whatsapp/linking.test.ts src/server/audit/coverage.ts
git commit -m "feat(whatsapp): Embedded Signup linking with server-side Graph exchange + audit"
```

---

# Phase 2 — Conversational ordering

Deliverable: a customer taps through branch → catalog → cart → pickup → confirm and a real order appears in the dashboard.

---

### Task 8: `order_channel` gains `whatsapp`

**Files:**
- Modify: `src/server/ordering/schema.ts:9`
- Modify: `src/server/ordering/service.ts` (the `channel` field of `PlaceOrderInput`)
- Create: `drizzle/0023_<generated>.sql`
- Test: `src/server/ordering/orders.test.ts` (add one case)

Without this, WhatsApp orders are indistinguishable from web orders in `orders.channel`, in the `order.placed` audit metadata, and in every by-channel report Spec 10 builds.

- [ ] **Step 1: Write the failing test**

Add to `src/server/ordering/orders.test.ts`:

```ts
it("records a whatsapp order on the whatsapp channel", async () => {
  const { tenantId, branchId, productId } = await seedOrderingContext();
  const res = await placeOrder(tenantId, {
    branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: "+201111111111",
    channel: "whatsapp", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
  });
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(orders).where(eq(orders.id, res.orderId)));
  expect(row.channel).toBe("whatsapp");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/ordering/orders.test.ts -t "whatsapp channel"`
Expected: FAIL — type error on `channel: "whatsapp"`.

- [ ] **Step 3: Widen the enum and the input type**

In `src/server/ordering/schema.ts:9`:

```ts
export const orderChannelEnum = pgEnum("order_channel", ["web", "pos", "whatsapp"]);
```

In `src/server/ordering/service.ts`, change the `PlaceOrderInput` field:

```ts
  channel?: "web" | "pos" | "whatsapp";
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`

Confirm the generated `.sql` contains an enum extension, not a table rewrite:

```sql
ALTER TYPE "public"."order_channel" ADD VALUE 'whatsapp';
```

- [ ] **Step 5: Migrate and test**

Run: `npm run db:migrate && npm run db:migrate:test && npm run db:check && npx vitest run src/server/ordering/orders.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/ordering/schema.ts src/server/ordering/service.ts src/server/ordering/orders.test.ts drizzle/
git commit -m "feat(ordering): order_channel gains 'whatsapp' so bot orders are attributable"
```

---

### Task 9: Conversation, receipt and handoff schema

**Files:**
- Modify: `src/server/whatsapp/schema.ts`
- Create: `drizzle/0024_<generated>.sql` (hand-edited for RLS)
- Test: `src/server/whatsapp/conversation-schema.test.ts`

**Interfaces:**
- Produces: `whatsappConversations`, `whatsappOrderReceipts`, `cartHandoffTokens`; types `WhatsappConversation`, `CartLine`, `ConversationState`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/conversation-schema.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { whatsappConversations } from "./schema";

describe("whatsapp_conversations", () => {
  it("holds at most one conversation per (tenant, waId)", async () => {
    const [t] = await db.insert(tenants).values({ slug: "wa-conv-1", name: "T", country: "EG", vertical: "restaurant" }).returning();
    await withTenant(t.id, (tx) => tx.insert(whatsappConversations).values({
      tenantId: t.id, waId: "201111111111", state: "idle", cart: [],
    }));
    await expect(
      withTenant(t.id, (tx) => tx.insert(whatsappConversations).values({
        tenantId: t.id, waId: "201111111111", state: "idle", cart: [],
      })),
    ).rejects.toThrow();
  });

  it("is invisible outside its tenant (FORCE RLS)", async () => {
    const [a] = await db.insert(tenants).values({ slug: "wa-conv-2", name: "A", country: "EG", vertical: "restaurant" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "wa-conv-3", name: "B", country: "EG", vertical: "restaurant" }).returning();
    await withTenant(a.id, (tx) => tx.insert(whatsappConversations).values({
      tenantId: a.id, waId: "2012", state: "idle", cart: [],
    }));
    const seen = await withTenant(b.id, (tx) => tx.select().from(whatsappConversations));
    expect(seen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/conversation-schema.test.ts`
Expected: FAIL — `whatsappConversations` is not exported.

- [ ] **Step 3: Add the tables**

Append to `src/server/whatsapp/schema.ts`:

```ts
import { integer } from "drizzle-orm/pg-core";
import { orders } from "@/server/ordering/schema";
import { branches } from "@/server/branches/schema";

export const whatsappStateEnum = pgEnum("whatsapp_conversation_state", [
  "idle", "branch", "categories", "products", "variant", "cart", "fulfillment", "contact", "confirm", "placed",
]);

/** A cart line holds SELECTION IDS ONLY — never a price. Prices are resolved
 *  fresh at every render and again at confirm, so a stale chat cannot quote a
 *  number placeOrder would not charge. */
export type CartLine = { productId: string; variantId?: string; quantity: number };

export const whatsappConversations = pgTable("whatsapp_conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  waId: text("wa_id").notNull(),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  state: whatsappStateEnum("state").notNull().default("idle"),
  /** Bumped on every transition. Interactive ids embed it so a tap on a
   *  superseded message can be rejected instead of acted on. */
  stateVersion: integer("state_version").notNull().default(0),
  cart: jsonb("cart").$type<CartLine[]>().notNull().default([]),
  pendingProductId: uuid("pending_product_id"),
  customerName: text("customer_name"),
  profileName: text("profile_name"),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("whatsapp_conversations_tenant_wa").on(t.tenantId, t.waId)]);

/** Idempotency for the place-order effect — the pos_order_receipts pattern. */
export const whatsappOrderReceipts = pgTable("whatsapp_order_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => whatsappConversations.id, { onDelete: "cascade" }),
  confirmMessageId: text("confirm_message_id").notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("whatsapp_order_receipts_conv_msg").on(t.conversationId, t.confirmMessageId)]);

export const cartHandoffTokens = pgTable("cart_handoff_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  waId: text("wa_id").notNull(),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  cart: jsonb("cart").$type<CartLine[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("cart_handoff_tokens_token").on(t.token)]);

export type WhatsappConversation = typeof whatsappConversations.$inferSelect;
export type ConversationState = (typeof whatsappStateEnum.enumValues)[number];
export type CartHandoffToken = typeof cartHandoffTokens.$inferSelect;
```

- [ ] **Step 4: Generate and hand-append RLS for all three tables**

Run: `npm run db:generate`

Append to the generated `.sql`, once per table (`whatsapp_conversations`, `whatsapp_order_receipts`, `cart_handoff_tokens`):

```sql
ALTER TABLE "whatsapp_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_conversations_isolation ON "whatsapp_conversations"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
```

Repeat verbatim for the other two, changing only the table and policy names.

- [ ] **Step 5: Migrate and test**

Run: `npm run db:migrate && npm run db:migrate:test && npm run db:check && npx vitest run src/server/whatsapp/conversation-schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/whatsapp/schema.ts src/server/whatsapp/conversation-schema.test.ts drizzle/
git commit -m "feat(whatsapp): conversation, order-receipt and cart-handoff tables with FORCE RLS"
```

---

### Task 10: The reducer — types and the total-function guarantee

**Files:**
- Create: `src/server/whatsapp/ids.ts`
- Create: `src/server/whatsapp/reducer.ts`
- Test: `src/server/whatsapp/reducer.test.ts`

`actionId` lives in its own module because both `reducer.ts` and `render.ts` (Task 11) need it, and putting it in either would make them import each other.

**Interfaces:**
- Produces:
  - `type CatalogSlice = { categories: {id:string;name:string}[]; products: {id:string;categoryId:string;name:string;price:number;hasVariants:boolean;hasRequiredModifiers:boolean}[]; variants: {id:string;productId:string;name:string;price:number}[] }`
  - `type ReducerInput = { state: ConversationState; stateVersion: number; cart: CartLine[]; inbound: InboundEvent; catalog: CatalogSlice; branches: {id:string;name:string}[]; branchId: string | null; profileName: string | null; customerName: string | null }`
  - `type Effect = { kind: "placeOrder" } | { kind: "mintHandoff" }`
  - `type ReducerOutput = { nextState: ConversationState; nextCart: CartLine[]; nextBranchId: string | null; nextCustomerName: string | null; pendingProductId: string | null; outbound: OutboundMessage[]; effects: Effect[] }`
  - `reduce(input: ReducerInput): ReducerOutput` — pure. No clock, no randomness, no I/O.

This task establishes purity and totality. Later tasks add states.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/reducer.test.ts
import { describe, it, expect } from "vitest";
import { reduce, type ReducerInput, type CatalogSlice } from "./reducer";
import type { ConversationState } from "./schema";

const catalog: CatalogSlice = {
  categories: [{ id: "c1", name: "Pizza" }],
  products: [{ id: "p1", categoryId: "c1", name: "Margherita", price: 120, hasVariants: false, hasRequiredModifiers: false }],
  variants: [],
};

const base = (over: Partial<ReducerInput> = {}): ReducerInput => ({
  state: "idle", stateVersion: 0, cart: [], inbound: { kind: "text", text: "hi" },
  catalog, branches: [{ id: "b1", name: "Main" }], branchId: null,
  profileName: "Ahmed", customerName: null, ...over,
});

const ALL_STATES: ConversationState[] = [
  "idle", "branch", "categories", "products", "variant", "cart", "fulfillment", "contact", "confirm", "placed",
];

describe("reduce — totality", () => {
  it("never throws for any (state, input type) pair", () => {
    const inbounds: ReducerInput["inbound"][] = [
      { kind: "text", text: "anything" },
      { kind: "interactive", replyId: "totally:unknown:id" },
      { kind: "location", lat: 30, lng: 31 },
      { kind: "unsupported" },
    ];
    for (const state of ALL_STATES) {
      for (const inbound of inbounds) {
        expect(() => reduce(base({ state, inbound }))).not.toThrow();
      }
    }
  });

  it("always replies with something — silence reads as broken", () => {
    for (const state of ALL_STATES) {
      const out = reduce(base({ state, inbound: { kind: "unsupported" } }));
      expect(out.outbound.length).toBeGreaterThan(0);
    }
  });

  it("rejects a tap carrying a stale state version and re-renders instead", () => {
    const out = reduce(base({
      state: "products", stateVersion: 7,
      inbound: { kind: "interactive", replyId: "add:3:p1" }, branchId: "b1",
    }));
    expect(out.nextCart).toEqual([]);
    expect(JSON.stringify(out.outbound)).toMatch(/expired|again/i);
  });

  it("honours the universal cancel keyword from any state", () => {
    for (const state of ALL_STATES) {
      const out = reduce(base({ state, inbound: { kind: "text", text: "cancel" } }));
      expect(out.nextState).toBe("idle");
      expect(out.nextCart).toEqual([]);
    }
  });

  it("honours the Arabic cancel keyword", () => {
    const out = reduce(base({ state: "cart", inbound: { kind: "text", text: "إلغاء" } }));
    expect(out.nextState).toBe("idle");
  });

  it("is pure — the same input twice yields deeply equal output", () => {
    const input = base({ state: "categories", inbound: { kind: "interactive", replyId: "cat:0:c1" }, branchId: "b1" });
    expect(reduce(input)).toEqual(reduce(input));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/reducer.test.ts`
Expected: FAIL — cannot resolve `./reducer`.

- [ ] **Step 3: Write the shared id module**

```ts
// src/server/whatsapp/ids.ts

/**
 * Interactive ids are `<action>:<stateVersion>:<payload>`.
 *
 * The version is what makes a tap on a superseded message rejectable: that tap
 * arrives as a brand-new wamid, so providerMessageId dedup cannot catch it.
 *
 * Lives in its own module so reducer.ts and render.ts can both use it without
 * importing each other.
 */
export function actionId(action: string, version: number, payload: string): string {
  return `${action}:${version}:${payload}`;
}

export function parseActionId(id: string): { action: string; version: number; payload: string } | null {
  const parts = id.split(":");
  if (parts.length < 3) return null;
  const version = Number(parts[1]);
  if (!Number.isInteger(version)) return null;
  return { action: parts[0], version, payload: parts.slice(2).join(":") };
}
```

- [ ] **Step 4: Implement the reducer skeleton**

```ts
// src/server/whatsapp/reducer.ts
import { actionId, parseActionId } from "./ids";
import type { OutboundMessage } from "./provider";
import type { InboundEvent } from "./payload";
import type { CartLine, ConversationState } from "./schema";

export type CatalogSlice = {
  categories: { id: string; name: string }[];
  products: { id: string; categoryId: string; name: string; price: number; hasVariants: boolean; hasRequiredModifiers: boolean }[];
  variants: { id: string; productId: string; name: string; price: number }[];
};

export type ReducerInput = {
  state: ConversationState;
  stateVersion: number;
  cart: CartLine[];
  inbound: InboundEvent;
  catalog: CatalogSlice;
  branches: { id: string; name: string }[];
  branchId: string | null;
  profileName: string | null;
  customerName: string | null;
};

export type Effect = { kind: "placeOrder" } | { kind: "mintHandoff" };

export type ReducerOutput = {
  nextState: ConversationState;
  nextCart: CartLine[];
  nextBranchId: string | null;
  nextCustomerName: string | null;
  pendingProductId: string | null;
  outbound: OutboundMessage[];
  effects: Effect[];
};

/** Exact-match escape words. A lookup table, not NLU — D5 forbids interpreting
 *  free text, not recognising a fixed keyword. */
const CANCEL_WORDS = new Set(["cancel", "stop", "الغاء", "إلغاء"]);
const RESTART_WORDS = new Set(["menu", "start", "hi", "hello", "القائمة", "ابدأ"]);
const HUMAN_WORDS = new Set(["human", "agent", "موظف", "بشري"]);

function keep(input: ReducerInput, outbound: OutboundMessage[], over: Partial<ReducerOutput> = {}): ReducerOutput {
  return {
    nextState: input.state,
    nextCart: input.cart,
    nextBranchId: input.branchId,
    nextCustomerName: input.customerName,
    pendingProductId: null,
    outbound,
    effects: [],
    ...over,
  };
}

function reset(input: ReducerInput, body: string): ReducerOutput {
  return {
    nextState: "idle", nextCart: [], nextBranchId: null, nextCustomerName: null,
    pendingProductId: null, outbound: [{ kind: "text", body }], effects: [],
  };
}

/** Rendered by every state so the customer is never trapped. */
function reprompt(input: ReducerInput, lead: string): ReducerOutput {
  return keep(input, [{ kind: "text", body: `${lead}\n\nReply "menu" to start over or "cancel" to stop.` }]);
}

/**
 * Pure. No I/O, no clock, no randomness — the runner supplies the catalog slice
 * and executes the effects.
 *
 * TOTAL by construction: every (state, input) pair returns a value and at least
 * one outbound message. A missing transition would throw inside the webhook
 * handler, and Meta would retry that same message for up to 7 days.
 */
export function reduce(input: ReducerInput): ReducerOutput {
  const { inbound } = input;

  if (inbound.kind === "text") {
    const word = inbound.text.trim().toLowerCase();
    if (CANCEL_WORDS.has(word)) return reset(input, "No problem — I've cleared that. Say \"menu\" whenever you'd like to order.");
    if (RESTART_WORDS.has(word)) return reset(input, "Welcome! Say \"menu\" to see what's available.");
    if (HUMAN_WORDS.has(word)) return keep(input, [{ kind: "text", body: "I'll pass you to the team — please call the number on our page and someone will help." }]);
  }

  if (inbound.kind === "interactive") {
    const parsed = parseActionId(inbound.replyId);
    // A tap on a superseded message: same customer, new wamid, so dedup cannot
    // catch it. Reject rather than act on a stale offer.
    if (!parsed || parsed.version !== input.stateVersion) {
      return reprompt(input, "That option has expired — here's the current step again.");
    }
  }

  // States are added in Tasks 11-15. Until then every state re-prompts.
  return reprompt(input, "Sorry, I didn't get that.");
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/server/whatsapp/reducer.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/whatsapp/ids.ts src/server/whatsapp/reducer.ts src/server/whatsapp/reducer.test.ts
git commit -m "feat(whatsapp): total pure reducer skeleton with version-scoped ids and escape keywords"
```

---

### Task 11: Branch, category and product states with pagination

**Files:**
- Modify: `src/server/whatsapp/reducer.ts`
- Create: `src/server/whatsapp/render.ts`
- Test: `src/server/whatsapp/reducer-browse.test.ts`, `src/server/whatsapp/render.test.ts`

**Interfaces:**
- Consumes: `reduce`, `actionId`, `CatalogSlice`.
- Produces: `renderRows(items, page, action, version): { rows: ListRow[]; hasMore: boolean }`, and the `idle → branch → categories → products` transitions.

Branch is chosen **first** because `getPublishedMenu(tenantId, branchId)` is branch-scoped; a cart built before the branch is known would be priced against the wrong branch and rejected at the last step.

- [ ] **Step 1: Write the failing render test**

```ts
// src/server/whatsapp/render.test.ts
import { describe, it, expect } from "vitest";
import { renderRows, truncateTitle } from "./render";

describe("renderRows", () => {
  it("pages at 9 rows so a 10th slot remains for 'next'", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, name: `Item ${i}` }));
    const page0 = renderRows(items, 0, "pick", 1);
    expect(page0.rows).toHaveLength(9);
    expect(page0.hasMore).toBe(true);

    const page2 = renderRows(items, 2, "pick", 1);
    expect(page2.rows).toHaveLength(7); // 25 - 18
    expect(page2.hasMore).toBe(false);
  });

  it("embeds the state version in every row id", () => {
    const { rows } = renderRows([{ id: "x", name: "X" }], 0, "pick", 4);
    expect(rows[0].id).toBe("pick:4:x");
  });
});

describe("truncateTitle", () => {
  it("caps at Meta's 24-character row-title limit", () => {
    expect(truncateTitle("Panadol Extra 500mg 24 Tablets")).toHaveLength(24);
  });

  it("leaves a short title untouched", () => {
    expect(truncateTitle("Margherita")).toBe("Margherita");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/render.test.ts`
Expected: FAIL — cannot resolve `./render`.

- [ ] **Step 3: Implement the renderer**

```ts
// src/server/whatsapp/render.ts
import { actionId } from "./ids";
import { ROW_TITLE_MAX, type ListRow } from "./provider";

/** Meta allows 10 rows TOTAL across all sections; one is reserved for "next". */
export const PAGE_SIZE = 9;

export function truncateTitle(s: string): string {
  return s.length <= ROW_TITLE_MAX ? s : s.slice(0, ROW_TITLE_MAX - 1) + "…";
}

/**
 * Slices `items` into one Meta-legal page. Price and unit belong in the
 * 72-char description, never the 24-char title.
 */
export function renderRows(
  items: { id: string; name: string; description?: string }[],
  page: number,
  action: string,
  version: number,
): { rows: ListRow[]; hasMore: boolean } {
  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  return {
    rows: slice.map((i) => ({
      id: actionId(action, version, i.id),
      title: truncateTitle(i.name),
      ...(i.description ? { description: i.description.slice(0, 72) } : {}),
    })),
    hasMore: start + PAGE_SIZE < items.length,
  };
}
```

- [ ] **Step 4: Write the failing browse test**

```ts
// src/server/whatsapp/reducer-browse.test.ts
import { describe, it, expect } from "vitest";
import { reduce, type ReducerInput, type CatalogSlice } from "./reducer";

const catalog: CatalogSlice = {
  categories: [{ id: "c1", name: "Pizza" }, { id: "c2", name: "Drinks" }],
  products: [
    { id: "p1", categoryId: "c1", name: "Margherita", price: 120, hasVariants: false, hasRequiredModifiers: false },
    { id: "p2", categoryId: "c1", name: "Four Cheese", price: 160, hasVariants: false, hasRequiredModifiers: true },
    { id: "p3", categoryId: "c2", name: "Cola", price: 25, hasVariants: true, hasRequiredModifiers: false },
  ],
  variants: [{ id: "v1", productId: "p3", name: "330ml", price: 25 }, { id: "v2", productId: "p3", name: "1L", price: 45 }],
};

const base = (over: Partial<ReducerInput> = {}): ReducerInput => ({
  state: "idle", stateVersion: 0, cart: [], inbound: { kind: "text", text: "menu" },
  catalog, branches: [{ id: "b1", name: "Main" }, { id: "b2", name: "Maadi" }],
  branchId: null, profileName: "Ahmed", customerName: null, ...over,
});

describe("browse flow", () => {
  it("asks for a branch before showing any catalog", () => {
    const out = reduce(base({ state: "idle", inbound: { kind: "interactive", replyId: "start:0:go" } }));
    expect(out.nextState).toBe("branch");
    expect(out.outbound[0].kind).toBe("list");
  });

  it("skips the branch step when the tenant has exactly one branch", () => {
    const out = reduce(base({
      state: "idle", branches: [{ id: "b1", name: "Main" }],
      inbound: { kind: "interactive", replyId: "start:0:go" },
    }));
    expect(out.nextState).toBe("categories");
    expect(out.nextBranchId).toBe("b1");
  });

  it("moves branch -> categories and remembers the branch", () => {
    const out = reduce(base({ state: "branch", stateVersion: 1, inbound: { kind: "interactive", replyId: "branch:1:b2" } }));
    expect(out.nextState).toBe("categories");
    expect(out.nextBranchId).toBe("b2");
  });

  it("lists only the chosen category's products", () => {
    const out = reduce(base({
      state: "categories", stateVersion: 2, branchId: "b1",
      inbound: { kind: "interactive", replyId: "cat:2:c2" },
    }));
    expect(out.nextState).toBe("products");
    const list = out.outbound.find((m) => m.kind === "list");
    expect(list && list.kind === "list" && list.rows.map((r) => r.title)).toEqual(["Cola"]);
  });

  it("adds a simple product straight to the cart", () => {
    const out = reduce(base({
      state: "products", stateVersion: 3, branchId: "b1",
      inbound: { kind: "interactive", replyId: "add:3:p1" },
    }));
    expect(out.nextCart).toEqual([{ productId: "p1", quantity: 1 }]);
    expect(out.nextState).toBe("cart");
  });

  it("routes a product with required modifiers to the storefront handoff", () => {
    const out = reduce(base({
      state: "products", stateVersion: 3, branchId: "b1",
      inbound: { kind: "interactive", replyId: "add:3:p2" },
    }));
    expect(out.effects).toContainEqual({ kind: "mintHandoff" });
  });

  it("sends a product with variants to the variant state", () => {
    const out = reduce(base({
      state: "products", stateVersion: 3, branchId: "b1",
      inbound: { kind: "interactive", replyId: "add:3:p3" },
    }));
    expect(out.nextState).toBe("variant");
    expect(out.pendingProductId).toBe("p3");
  });

  it("adds the chosen variant to the cart", () => {
    const out = reduce(base({
      state: "variant", stateVersion: 4, branchId: "b1",
      inbound: { kind: "interactive", replyId: "var:4:v2" },
    }));
    expect(out.nextCart).toEqual([{ productId: "p3", variantId: "v2", quantity: 1 }]);
    expect(out.nextState).toBe("cart");
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/reducer-browse.test.ts`
Expected: FAIL — every transition still falls through to the re-prompt.

- [ ] **Step 6: Implement the transitions**

Replace the final `return reprompt(...)` in `reduce` with a state switch. Add above it:

```ts
import { renderRows, truncateTitle } from "./render";

function nextVersion(input: ReducerInput): number {
  return input.stateVersion + 1;
}

function branchList(input: ReducerInput): OutboundMessage {
  const v = nextVersion(input);
  const { rows } = renderRows(input.branches.map((b) => ({ id: b.id, name: b.name })), 0, "branch", v);
  return { kind: "list", body: "Which branch would you like to order from?", button: "Choose", rows };
}

function categoryList(input: ReducerInput): OutboundMessage {
  const v = nextVersion(input);
  const { rows } = renderRows(input.catalog.categories.map((c) => ({ id: c.id, name: c.name })), 0, "cat", v);
  return { kind: "list", body: "What would you like?", button: "Browse", rows };
}

function productList(input: ReducerInput, categoryId: string): OutboundMessage {
  const v = nextVersion(input);
  const items = input.catalog.products
    .filter((p) => p.categoryId === categoryId)
    .map((p) => ({ id: p.id, name: p.name, description: `${p.price.toFixed(2)}` }));
  const { rows } = renderRows(items, 0, "add", v);
  return { kind: "list", body: "Pick an item.", button: "Choose", rows };
}

function cartSummary(input: ReducerInput, cart: CartLine[]): OutboundMessage {
  const v = nextVersion(input);
  const names = cart.map((l) => {
    const p = input.catalog.products.find((x) => x.id === l.productId);
    return `${l.quantity}× ${p ? truncateTitle(p.name) : "item"}`;
  }).join("\n");
  return {
    kind: "buttons",
    body: `Your order so far:\n${names}`,
    buttons: [
      { id: actionId("more", v, "x"), title: "Add more" },
      { id: actionId("checkout", v, "x"), title: "Checkout" },
    ],
  };
}
```

Then the switch, inserted before the fallback `reprompt`:

```ts
  const tap = inbound.kind === "interactive" ? parseActionId(inbound.replyId) : null;

  switch (input.state) {
    case "idle": {
      if (!tap) return reprompt(input, "Say \"menu\" to start an order.");
      // One branch means no choice worth asking for.
      if (input.branches.length === 1) {
        return keep(input, [categoryList({ ...input, branchId: input.branches[0].id })], {
          nextState: "categories", nextBranchId: input.branches[0].id,
        });
      }
      return keep(input, [branchList(input)], { nextState: "branch" });
    }

    case "branch": {
      if (!tap || tap.action !== "branch") return reprompt(input, "Please choose a branch.");
      const branch = input.branches.find((b) => b.id === tap.payload);
      if (!branch) return reprompt(input, "That branch is no longer available.");
      return keep(input, [categoryList(input)], { nextState: "categories", nextBranchId: branch.id });
    }

    case "categories": {
      if (!tap || tap.action !== "cat") return reprompt(input, "Please pick a category.");
      const cat = input.catalog.categories.find((c) => c.id === tap.payload);
      if (!cat) return reprompt(input, "That category is no longer available.");
      return keep(input, [productList(input, cat.id)], { nextState: "products" });
    }

    case "products": {
      if (!tap || tap.action !== "add") return reprompt(input, "Please pick an item.");
      const product = input.catalog.products.find((p) => p.id === tap.payload);
      if (!product) return reprompt(input, "That item is no longer available.");

      // Anything the chat cannot configure goes to the storefront with the cart.
      if (product.hasRequiredModifiers) {
        return keep(input, [{ kind: "text", body: `${product.name} needs a few choices — I'll send you a link with your basket ready.` }], {
          effects: [{ kind: "mintHandoff" }],
        });
      }
      if (product.hasVariants) {
        const v = nextVersion(input);
        const items = input.catalog.variants
          .filter((x) => x.productId === product.id)
          .map((x) => ({ id: x.id, name: x.name, description: x.price.toFixed(2) }));
        const { rows } = renderRows(items, 0, "var", v);
        return keep(input, [{ kind: "list", body: `Which ${truncateTitle(product.name)}?`, button: "Choose", rows }], {
          nextState: "variant", pendingProductId: product.id,
        });
      }
      const cart = [...input.cart, { productId: product.id, quantity: 1 }];
      return keep(input, [cartSummary(input, cart)], { nextState: "cart", nextCart: cart });
    }

    case "variant": {
      if (!tap || tap.action !== "var") return reprompt(input, "Please choose an option.");
      const variant = input.catalog.variants.find((v) => v.id === tap.payload);
      if (!variant) return reprompt(input, "That option is no longer available.");
      const cart = [...input.cart, { productId: variant.productId, variantId: variant.id, quantity: 1 }];
      return keep(input, [cartSummary(input, cart)], { nextState: "cart", nextCart: cart });
    }
  }
```

- [ ] **Step 7: Run both tests**

Run: `npx vitest run src/server/whatsapp/render.test.ts src/server/whatsapp/reducer-browse.test.ts src/server/whatsapp/reducer.test.ts`
Expected: PASS — totality still holds because the switch falls through to the re-prompt for unhandled states.

- [ ] **Step 8: Commit**

```bash
git add src/server/whatsapp/reducer.ts src/server/whatsapp/render.ts src/server/whatsapp/render.test.ts src/server/whatsapp/reducer-browse.test.ts
git commit -m "feat(whatsapp): branch-first browse flow with 9-row paging and variant picker"
```

---

### Task 12: Cart, fulfillment, contact and confirm states

**Files:**
- Modify: `src/server/whatsapp/reducer.ts`
- Test: `src/server/whatsapp/reducer-checkout.test.ts`

**Interfaces:**
- Produces: the `cart → fulfillment → contact → confirm → placed` transitions and the `placeOrder` / `mintHandoff` effects.

Delivery ends the chat flow: `placeOrder` requires `deliveryAddressText`, which no list can produce.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/reducer-checkout.test.ts
import { describe, it, expect } from "vitest";
import { reduce, type ReducerInput, type CatalogSlice } from "./reducer";

const catalog: CatalogSlice = {
  categories: [{ id: "c1", name: "Pizza" }],
  products: [{ id: "p1", categoryId: "c1", name: "Margherita", price: 120, hasVariants: false, hasRequiredModifiers: false }],
  variants: [],
};

const base = (over: Partial<ReducerInput> = {}): ReducerInput => ({
  state: "cart", stateVersion: 5, cart: [{ productId: "p1", quantity: 1 }],
  inbound: { kind: "interactive", replyId: "checkout:5:x" },
  catalog, branches: [{ id: "b1", name: "Main" }], branchId: "b1",
  profileName: "Ahmed", customerName: null, ...over,
});

describe("checkout flow", () => {
  it("cart -> fulfillment on checkout", () => {
    expect(reduce(base()).nextState).toBe("fulfillment");
  });

  it("cart -> categories on 'add more'", () => {
    expect(reduce(base({ inbound: { kind: "interactive", replyId: "more:5:x" } })).nextState).toBe("categories");
  });

  it("pickup continues in chat to the contact step", () => {
    const out = reduce(base({ state: "fulfillment", inbound: { kind: "interactive", replyId: "ful:5:pickup" } }));
    expect(out.nextState).toBe("contact");
    // The profile name is offered as a tap, with typing as the only alternative.
    const btns = out.outbound.find((m) => m.kind === "buttons");
    expect(btns && btns.kind === "buttons" && btns.buttons.map((b) => b.title)).toEqual(["Use Ahmed", "Type a name"]);
  });

  it("delivery leaves the chat and hands off with the cart", () => {
    const out = reduce(base({ state: "fulfillment", inbound: { kind: "interactive", replyId: "ful:5:delivery" } }));
    expect(out.effects).toContainEqual({ kind: "mintHandoff" });
    expect(out.nextState).not.toBe("contact");
  });

  it("accepts the profile name with a single tap", () => {
    const out = reduce(base({ state: "contact", inbound: { kind: "interactive", replyId: "name:5:profile" } }));
    expect(out.nextCustomerName).toBe("Ahmed");
    expect(out.nextState).toBe("confirm");
  });

  it("accepts a typed name verbatim without parsing it", () => {
    const typing = reduce(base({ state: "contact", inbound: { kind: "interactive", replyId: "name:5:type" } }));
    expect(typing.nextState).toBe("contact");
    const out = reduce(base({ state: "contact", customerName: null, inbound: { kind: "text", text: "Om Kalthoum" } }));
    expect(out.nextCustomerName).toBe("Om Kalthoum");
    expect(out.nextState).toBe("confirm");
  });

  it("caps an absurdly long typed name instead of storing it whole", () => {
    const out = reduce(base({ state: "contact", inbound: { kind: "text", text: "x".repeat(500) } }));
    expect(out.nextCustomerName!.length).toBeLessThanOrEqual(120);
  });

  it("emits the placeOrder effect on confirm", () => {
    const out = reduce(base({ state: "confirm", customerName: "Ahmed", inbound: { kind: "interactive", replyId: "confirm:5:yes" } }));
    expect(out.effects).toContainEqual({ kind: "placeOrder" });
  });

  it("refuses to confirm an empty cart", () => {
    const out = reduce(base({ state: "confirm", cart: [], customerName: "A", inbound: { kind: "interactive", replyId: "confirm:5:yes" } }));
    expect(out.effects).toEqual([]);
  });

  it("returns to idle from placed so a second order can start", () => {
    const out = reduce(base({ state: "placed", inbound: { kind: "text", text: "another order" } }));
    expect(out.nextState).toBe("idle");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/reducer-checkout.test.ts`
Expected: FAIL — these states fall through to the re-prompt.

- [ ] **Step 3: Implement the remaining states**

Add these cases to the switch in `reduce`, before the closing brace:

```ts
    case "cart": {
      if (!tap) return reprompt(input, "Tap \"Checkout\" when you're ready.");
      if (tap.action === "more") return keep(input, [categoryList(input)], { nextState: "categories" });
      if (tap.action === "checkout") {
        const v = nextVersion(input);
        return keep(input, [{
          kind: "buttons", body: "Pickup or delivery?",
          buttons: [
            { id: actionId("ful", v, "pickup"), title: "Pickup" },
            { id: actionId("ful", v, "delivery"), title: "Delivery" },
          ],
        }], { nextState: "fulfillment" });
      }
      return reprompt(input, "Tap \"Checkout\" when you're ready.");
    }

    case "fulfillment": {
      if (!tap || tap.action !== "ful") return reprompt(input, "Pickup or delivery?");
      if (tap.payload === "delivery") {
        // placeOrder requires deliveryAddressText; no list can produce an
        // Egyptian landmark address, so delivery finishes on the storefront.
        return keep(input, [{ kind: "text", body: "For delivery I'll send you a link with your basket ready — you can add your address there." }], {
          effects: [{ kind: "mintHandoff" }],
        });
      }
      const v = nextVersion(input);
      const profile = input.profileName ?? "your name";
      return keep(input, [{
        kind: "buttons", body: `Almost done — what name should we put on the order?`,
        buttons: [
          { id: actionId("name", v, "profile"), title: `Use ${profile}`.slice(0, 20) },
          { id: actionId("name", v, "type"), title: "Type a name" },
        ],
      }], { nextState: "contact" });
    }

    case "contact": {
      // The ONE bounded free-text field: stored verbatim, never parsed.
      if (inbound.kind === "text") {
        const name = inbound.text.trim().slice(0, 120);
        if (!name) return reprompt(input, "Please send a name for the order.");
        return keep(input, [confirmSummary(input, name)], { nextState: "confirm", nextCustomerName: name });
      }
      if (tap?.action === "name" && tap.payload === "profile" && input.profileName) {
        return keep(input, [confirmSummary(input, input.profileName)], {
          nextState: "confirm", nextCustomerName: input.profileName,
        });
      }
      if (tap?.action === "name" && tap.payload === "type") {
        return keep(input, [{ kind: "text", body: "Sure — send me the name to put on the order." }]);
      }
      return reprompt(input, "What name should we put on the order?");
    }

    case "confirm": {
      if (!tap || tap.action !== "confirm") return reprompt(input, "Tap \"Confirm\" to place the order.");
      if (tap.payload !== "yes") return keep(input, [cartSummary(input, input.cart)], { nextState: "cart" });
      if (input.cart.length === 0) return reprompt(input, "Your basket is empty.");
      return keep(input, [], { effects: [{ kind: "placeOrder" }] });
    }

    case "placed":
      return reset(input, "Your last order is on its way. Say \"menu\" to start a new one.");
```

And add the `confirmSummary` helper alongside the other renderers:

```ts
function confirmSummary(input: ReducerInput, name: string): OutboundMessage {
  const v = nextVersion(input);
  const lines = input.cart.map((l) => {
    const p = input.catalog.products.find((x) => x.id === l.productId);
    return `${l.quantity}× ${p ? truncateTitle(p.name) : "item"}`;
  }).join("\n");
  // No total here: the runner re-prices at confirm time and passes expectedTotal
  // to placeOrder, so the chat never quotes a number the server would not charge.
  return {
    kind: "buttons",
    body: `Pickup order for ${name}:\n${lines}\n\nConfirm?`,
    buttons: [
      { id: actionId("confirm", v, "yes"), title: "Confirm" },
      { id: actionId("confirm", v, "no"), title: "Back" },
    ],
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/server/whatsapp/reducer-checkout.test.ts src/server/whatsapp/reducer.test.ts src/server/whatsapp/reducer-browse.test.ts`
Expected: PASS — all three suites.

- [ ] **Step 5: Commit**

```bash
git add src/server/whatsapp/reducer.ts src/server/whatsapp/reducer-checkout.test.ts
git commit -m "feat(whatsapp): cart/fulfillment/contact/confirm states, pickup-only with delivery handoff"
```

---

### Task 13: The runner — locking, catalog slice, effects

**Files:**
- Create: `src/server/whatsapp/runner.ts`
- Modify: `src/server/whatsapp/ingest.ts` (call the runner for fresh messages)
- Modify: `src/server/audit/coverage.ts`
- Test: `src/server/whatsapp/runner.test.ts`

**Interfaces:**
- Consumes: `reduce`, `getPublishedMenu`, `listBranches`, `placeOrder`, `FakeWhatsAppProvider`.
- Produces: `handleInbound(account, msg, provider): Promise<void>`
- Emits audit action `whatsapp.order_placed`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/runner.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { whatsappConversations, whatsappOrderReceipts } from "./schema";
import { FakeWhatsAppProvider } from "./fake-provider";
import { handleInbound } from "./runner";
import { seedWhatsappContext, inboundText, inboundTap } from "./test-helpers";

const WA = "201111111111";

describe("handleInbound", () => {
  it("walks a full pickup order into the orders table on the whatsapp channel", async () => {
    const { account, tenantId, productId } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();

    await handleInbound(account, inboundText("menu"), p);       // idle -> (single branch) categories
    await handleInbound(account, await inboundTap(tenantId, WA, "cat", "c-main"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "add", productId), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "checkout", "x"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "ful", "pickup"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "name", "profile"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "confirm", "yes"), p);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(orders));
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("whatsapp");
    expect(rows[0].customerName).toBe("Ahmed");
  });

  it("does not place a second order when Meta replays the confirm tap", async () => {
    const { account, tenantId, productId } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();
    await handleInbound(account, inboundText("menu"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "cat", "c-main"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "add", productId), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "checkout", "x"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "ful", "pickup"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "name", "profile"), p);

    const confirm = await inboundTap(tenantId, WA, "confirm", "yes");
    await handleInbound(account, confirm, p);
    await handleInbound(account, { ...confirm, providerMessageId: confirm.providerMessageId }, p);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(orders));
    expect(rows).toHaveLength(1);
    const receipts = await withTenant(tenantId, (tx) => tx.select().from(whatsappOrderReceipts));
    expect(receipts).toHaveLength(1);
  });

  it("bumps stateVersion on every transition so stale taps are rejected", async () => {
    const { account, tenantId } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();
    await handleInbound(account, inboundText("menu"), p);
    const [c1] = await withTenant(tenantId, (tx) => tx.select().from(whatsappConversations));
    await handleInbound(account, await inboundTap(tenantId, WA, "cat", "c-main"), p);
    const [c2] = await withTenant(tenantId, (tx) => tx.select().from(whatsappConversations));
    expect(c2.stateVersion).toBeGreaterThan(c1.stateVersion);
  });

  it("emits a whatsapp.order_placed audit event", async () => {
    const { account, tenantId, productId } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();
    await handleInbound(account, inboundText("menu"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "cat", "c-main"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "add", productId), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "checkout", "x"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "ful", "pickup"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "name", "profile"), p);
    await handleInbound(account, await inboundTap(tenantId, WA, "confirm", "yes"), p);

    const { auditEvents } = await import("@/server/audit/schema");
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    expect(rows.some((r) => r.action === "whatsapp.order_placed")).toBe(true);
  });
});
```

- [ ] **Step 2: Write the test helpers**

```ts
// src/server/whatsapp/test-helpers.ts
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { whatsappAccounts, whatsappConversations, type WhatsappAccount } from "./schema";
import type { InboundMessage } from "./payload";

let n = 0;

/** A tenant with one branch, one published product, and a linked WhatsApp number. */
export async function seedWhatsappContext(): Promise<{
  account: WhatsappAccount; tenantId: string; branchId: string; productId: string;
}> {
  const i = n++;
  const [t] = await db.insert(tenants).values({
    slug: `wa-run-${i}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");

  const branch = await createBranch(t.id, { nameEn: "Main", nameAr: "الرئيسي" });
  const category = await createCategory(t.id, { id: "c-main", nameEn: "Pizza", nameAr: "بيتزا" });
  const product = await createProduct(t.id, {
    categoryId: category.id, nameEn: "Margherita", nameAr: "مارغريتا", basePrice: 100,
  });
  await updateProduct(t.id, product.id, { isPublished: true });

  const [account] = await db.insert(whatsappAccounts).values({
    tenantId: t.id, wabaId: "w", phoneNumberId: `pn-run-${i}`,
    displayPhoneNumber: "+20100", tokenRef: "env://X", status: "active",
  }).returning();

  return { account, tenantId: t.id, branchId: branch.id, productId: product.id };
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
```

**Do not weaken the reducer's version check to make tests convenient.** `inboundTap`
reads the conversation's current `stateVersion` from the database and builds a real,
correctly-versioned id — the same thing a real customer's client would send back.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/runner.test.ts`
Expected: FAIL — cannot resolve `./runner`.

- [ ] **Step 4: Implement the runner**

```ts
// src/server/whatsapp/runner.ts
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

// A customer on WhatsApp has no device token, IP or user agent we control.
// emptyFingerprint() already exists — do not hand-roll the null shape.

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

    const branches = (await listBranches(tenantId)).map((b) => ({ id: b.id, name: b.nameEn }));
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
        await runPlaceOrder(tx, account, conv.id, msg, out.nextCart.length ? out.nextCart : conv.cart, conv.branchId, out.nextCustomerName ?? conv.customerName);
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
  msg: InboundMessage, cart: CartLine[], branchId: string | null, customerName: string | null,
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
  // to show, so it can refuse rather than quietly charge something else.
  const pricing = await getCheckoutPricing(account.tenantId);
  const menu = await getPublishedMenu(account.tenantId, branchId);
  const lines = cart.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, selectedOptionIds: [] }));
  const totals = computeCartTotals(menu, lines, pricing);

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
```

- [ ] **Step 5: Wire the runner into ingest**

In `src/server/whatsapp/ingest.ts`, replace the `// Phase 2 drives the reducer here` comment:

```ts
    if (fresh) {
      accepted++;
      await handleInbound(account, msg, provider);
    } else {
      skipped++;
    }
```

Add a `provider: WhatsAppProvider = new CloudApiProvider()` parameter to `ingestWebhook` so tests can inject the fake.

- [ ] **Step 6: Register with the coverage guardrail**

Add to `AUDITED_SERVICE_FILES`:

```ts
  "src/server/whatsapp/runner.ts",
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/server/whatsapp/ src/server/audit/coverage.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/whatsapp/ src/server/audit/coverage.ts
git commit -m "feat(whatsapp): runner with conversation advisory lock, receipt-before-placeOrder, expectedTotal"
```

---

### Task 14: Cart handoff to the storefront

**Files:**
- Create: `src/server/whatsapp/handoff.ts`
- Modify: `src/app/page.tsx` (accept and redeem `?handoff=`)
- Modify: `src/app/_components/storefront/templates/StorefrontShell.tsx` (thread `initialCart`)
- Modify: `src/app/_components/storefront/templates/shop/ShopBrowser.tsx:25` (seed `useState`)
- Test: `src/server/whatsapp/handoff.test.ts`

**Interfaces:**
- Produces: `mintHandoff(tenantId, waId, branchId, cart): Promise<string>`, `redeemHandoff(tenantId, token): Promise<CartHandoffToken | null>`

**Tenant is resolved from the storefront URL, never from the token.** A token minted for tenant A, opened on tenant B's domain, then fails safely under RLS instead of rendering A's cart under B's branding.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/handoff.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { mintHandoff, redeemHandoff } from "./handoff";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  return t.id;
}

describe("cart handoff", () => {
  it("redeems once and refuses the second attempt", async () => {
    const tenantId = await seed("wa-hand-1");
    const token = await mintHandoff(tenantId, "2011", null, [{ productId: "p1", quantity: 2 }]);
    const first = await redeemHandoff(tenantId, token);
    expect(first?.cart).toEqual([{ productId: "p1", quantity: 2 }]);
    expect(await redeemHandoff(tenantId, token)).toBeNull();
  });

  it("is invisible to another tenant, so a cross-tenant replay fails closed", async () => {
    const a = await seed("wa-hand-2");
    const b = await seed("wa-hand-3");
    const token = await mintHandoff(a, "2011", null, [{ productId: "p1", quantity: 1 }]);
    expect(await redeemHandoff(b, token)).toBeNull();
  });

  it("refuses an expired token", async () => {
    const tenantId = await seed("wa-hand-4");
    const token = await mintHandoff(tenantId, "2011", null, [{ productId: "p1", quantity: 1 }], -1);
    expect(await redeemHandoff(tenantId, token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/handoff.test.ts`
Expected: FAIL — cannot resolve `./handoff`.

- [ ] **Step 3: Implement**

```ts
// src/server/whatsapp/handoff.ts
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { cartHandoffTokens, type CartHandoffToken, type CartLine } from "./schema";

const DEFAULT_TTL_MINUTES = 60;

export async function mintHandoff(
  tenantId: string, waId: string, branchId: string | null, cart: CartLine[],
  ttlMinutes = DEFAULT_TTL_MINUTES,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withTenant(tenantId, (tx) => tx.insert(cartHandoffTokens).values({
    tenantId, token, waId, branchId, cart,
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  }));
  return token;
}

/**
 * Single-use redemption. `tenantId` MUST come from the storefront host the
 * customer opened, never from the token — RLS then makes a cross-tenant replay
 * return nothing rather than render another tenant's cart.
 */
export async function redeemHandoff(tenantId: string, token: string): Promise<CartHandoffToken | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(cartHandoffTokens)
      .set({ redeemedAt: new Date() })
      .where(and(
        eq(cartHandoffTokens.token, token),
        eq(cartHandoffTokens.tenantId, tenantId),
        isNull(cartHandoffTokens.redeemedAt),
        gt(cartHandoffTokens.expiresAt, new Date()),
      ))
      .returning();
    return row ?? null;
  });
}
```

- [ ] **Step 4: Wire the effect into the runner**

In `runner.ts`, inside the effects loop:

```ts
      if (effect.kind === "mintHandoff") {
        const token = await mintHandoff(account.tenantId, msg.waId, conv.branchId, out.nextCart.length ? out.nextCart : conv.cart);
        const url = `https://${tenant.slug}.${process.env.ROOT_DOMAIN ?? "serveos.com"}/?handoff=${token}`;
        out.outbound.push({ kind: "text", body: `Finish your order here:\n${url}` });
      }
```

Resolve `tenant` once via `getTenantById(account.tenantId)` at the top of `handleInbound`.

- [ ] **Step 5: Redeem on the storefront page, not a separate route**

The storefront cart is **in-memory React state** — `useState<Cart>` in
`src/app/_components/storefront/templates/shop/ShopBrowser.tsx:25`. Nothing persists
it, so there is no cookie or localStorage slot to write into. The handoff therefore
redeems **server-side on the storefront page** and passes the cart down as a prop,
which is how every other piece of storefront data already arrives.

The tenant comes from the `x-tenant-slug` header that `src/proxy.ts:13` sets from the
host and deletes on non-storefront hosts — the same resolution `src/app/page.tsx:32`
and `src/app/checkout/page.tsx:16` already use. Never from the token.

In `src/app/page.tsx`, where `searchParams` is already destructured:

```ts
const { branch: branchId, handoff } = await searchParams;

// A WhatsApp cart handed to the storefront. Redeemed server-side, single-use,
// and scoped by RLS to this host's tenant — a token minted for another tenant
// simply returns null here rather than rendering their cart under our brand.
const handoffCart = handoff ? await redeemHandoff(tenant.id, handoff) : null;
```

Pass `initialCart={handoffCart?.cart ?? []}` through `StorefrontShell` to `ShopBrowser`,
and seed the existing state with it:

```ts
const [cart, setCart] = useState<Cart>({
  branchId: initialBranchId ?? null,
  lines: initialCart,
});
```

Add `handoff?: string` to the page's `searchParams` type and `initialCart?: CartLine[]`
to both component prop types. Default it to `[]` so every existing caller is unchanged.

- [ ] **Step 6: Build the link in the runner**

The URL is the tenant's own storefront with the token as a query param — no new route:

```ts
const url = `https://${tenant.slug}.${process.env.ROOT_DOMAIN ?? "serveos.com"}/?handoff=${token}`;
```

Resolve `tenant` once at the top of `handleInbound` via `getTenantById(account.tenantId)`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/server/whatsapp/handoff.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), and the prop threading typechecks.

- [ ] **Step 8: Commit**

```bash
git add src/server/whatsapp/handoff.ts src/server/whatsapp/handoff.test.ts src/server/whatsapp/runner.ts src/app/page.tsx src/app/_components/storefront/
git commit -m "feat(whatsapp): single-use cart handoff seeded server-side, tenant from host not token"
```

---

### Task 15: Reorder-my-last, and conversation expiry

**Files:**
- Create: `src/server/whatsapp/reorder.ts`
- Modify: `src/server/whatsapp/reducer.ts` (offer reorder from `idle`)
- Modify: `src/server/whatsapp/runner.ts` (expire a stale conversation before reducing)
- Test: `src/server/whatsapp/reorder.test.ts`

**Interfaces:**
- Consumes: `orders`, `orderItems`, `CartLine`.
- Produces: `lastWhatsappCart(tenantId, waId): Promise<CartLine[] | null>`, `CONVERSATION_TTL_MS`.

Spec D4 includes "reorder my last order" and §7.2 requires that a stale cart is never resumed blind. Both land here.

**The lookup is deliberately narrow.** It reads only orders **this channel** created for this `waId`. Matching arbitrary `orders.customerPhone` would surface a stranger's name, address and history to whoever now holds a recycled number — that column is unvalidated free text typed at web checkout and by POS staff for walk-ins.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/whatsapp/reorder.test.ts
import { describe, it, expect } from "vitest";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { placeOrder } from "@/server/ordering/service";
import { lastWhatsappCart } from "./reorder";
import { seedWhatsappContext } from "./test-helpers";

const WA = "201111111111";

describe("lastWhatsappCart", () => {
  it("returns null when this number has never ordered", async () => {
    const { tenantId } = await seedWhatsappContext();
    expect(await lastWhatsappCart(tenantId, WA)).toBeNull();
  });

  it("returns the lines of the most recent whatsapp order", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: `+${WA}`,
      channel: "whatsapp", lines: [{ productId, quantity: 3, selectedOptionIds: [] }],
    });
    expect(await lastWhatsappCart(tenantId, WA)).toEqual([{ productId, quantity: 3 }]);
  });

  it("ignores a web order placed with the same phone number", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Someone Else", customerPhone: `+${WA}`,
      channel: "web", lines: [{ productId, quantity: 9, selectedOptionIds: [] }],
    });
    // A recycled number must not expose the previous owner's storefront history.
    expect(await lastWhatsappCart(tenantId, WA)).toBeNull();
  });

  it("does not leak another tenant's order", async () => {
    const a = await seedWhatsappContext();
    const b = await seedWhatsappContext();
    await placeOrder(a.tenantId, {
      branchId: a.branchId, fulfillmentType: "pickup", customerName: "A", customerPhone: `+${WA}`,
      channel: "whatsapp", lines: [{ productId: a.productId, quantity: 1, selectedOptionIds: [] }],
    });
    expect(await lastWhatsappCart(b.tenantId, WA)).toBeNull();
  });

  it("normalises a waId without a leading plus to E.164 before matching", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: `+${WA}`,
      channel: "whatsapp", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    // Meta sends the wa_id bare; the stored column carries the plus.
    expect(await lastWhatsappCart(tenantId, WA)).not.toBeNull();
  });

  it("drops a line whose product is no longer published rather than failing whole", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: `+${WA}`,
      channel: "whatsapp", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    const { updateProduct } = await import("@/server/catalog/service");
    await updateProduct(tenantId, productId, { isPublished: false });
    expect(await lastWhatsappCart(tenantId, WA)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/whatsapp/reorder.test.ts`
Expected: FAIL — cannot resolve `./reorder`.

- [ ] **Step 3: Implement**

```ts
// src/server/whatsapp/reorder.ts
import { and, desc, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders, orderItems } from "@/server/ordering/schema";
import { products } from "@/server/catalog/schema";
import type { CartLine } from "./schema";

/** A conversation idle longer than this restarts instead of resuming. */
export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Meta sends wa_id bare ("201..."); orders.customerPhone carries the plus. */
export function toE164(waId: string): string {
  return waId.startsWith("+") ? waId : `+${waId}`;
}

/**
 * The lines of this number's most recent order PLACED THROUGH WHATSAPP.
 *
 * Scoped to channel = 'whatsapp' on purpose. orders.customerPhone is unvalidated
 * free text from web checkout and POS walk-ins, so a broader match would show a
 * recycled number's new owner the previous owner's history.
 *
 * Unpublished products are dropped rather than returned, so a reorder degrades
 * to "some items are gone" instead of failing the whole order at placeOrder.
 */
export async function lastWhatsappCart(tenantId: string, waId: string): Promise<CartLine[] | null> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders)
      .where(and(
        eq(orders.tenantId, tenantId),
        eq(orders.channel, "whatsapp"),
        eq(orders.customerPhone, toE164(waId)),
      ))
      .orderBy(desc(orders.placedAt))
      .limit(1);
    if (!order) return null;

    const items = await tx.select({
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
    }).from(orderItems).where(eq(orderItems.orderId, order.id));
    if (items.length === 0) return [];

    const live = await tx.select({ id: products.id }).from(products)
      .where(and(
        inArray(products.id, items.map((i) => i.productId)),
        eq(products.isPublished, true),
      ));
    const liveIds = new Set(live.map((p) => p.id));

    return items
      .filter((i) => liveIds.has(i.productId))
      .map((i) => ({
        productId: i.productId,
        ...(i.variantId ? { variantId: i.variantId } : {}),
        quantity: i.quantity,
      }));
  });
}
```

Check the actual column names on `orderItems` (`src/server/ordering/schema.ts`) before writing the select — if the variant column is named differently, follow the schema, not this snippet.

- [ ] **Step 4: Expire stale conversations in the runner**

In `handleInbound`, immediately after loading `conv` and before calling `reduce`:

```ts
    // Never resume a cart blind: prices move, items get unpublished, branches
    // close. Past the TTL the conversation restarts.
    const stale = conv.updatedAt.getTime() < Date.now() - CONVERSATION_TTL_MS;
    if (stale && conv.state !== "idle") {
      conv = { ...conv, state: "idle", cart: [], branchId: null, customerName: null };
    }
```

- [ ] **Step 5: Offer reorder from idle**

In the reducer's `idle` case, when the customer has previous orders the runner
supplies them via a new optional `ReducerInput` field `lastCart: CartLine[] | null`.
Add it to `ReducerInput`, default `null`, and in `idle`:

```ts
      if (input.lastCart && input.lastCart.length > 0) {
        const v = nextVersion(input);
        return keep(input, [{
          kind: "buttons",
          body: "Welcome back! Order the same as last time?",
          buttons: [
            { id: actionId("reorder", v, "yes"), title: "Same as last time" },
            { id: actionId("start", v, "fresh"), title: "Something else" },
          ],
        }], { nextState: "idle" });
      }
```

and handle the reply in the same `idle` case:

```ts
      if (tap.action === "reorder") {
        const cart = input.lastCart ?? [];
        if (cart.length === 0) return reprompt(input, "Those items aren't available any more — let's start fresh.");
        return keep(input, [cartSummary(input, cart)], { nextState: "cart", nextCart: cart });
      }
```

The runner populates `lastCart` by calling `lastWhatsappCart(tenantId, msg.waId)` only when `conv.state === "idle"` — there is no reason to pay for that query mid-order.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/server/whatsapp/`
Expected: PASS — the whole WhatsApp suite.

- [ ] **Step 7: Commit**

```bash
git add src/server/whatsapp/reorder.ts src/server/whatsapp/reorder.test.ts src/server/whatsapp/reducer.ts src/server/whatsapp/runner.ts
git commit -m "feat(whatsapp): reorder-my-last scoped to the whatsapp channel, plus conversation TTL"
```

---

### Task 16: Enable the channel and correct the marketing claim

**Files:**
- Modify: `src/server/verticals/registry.ts` (retail, pharmacy, timber)
- Modify: `src/app/_components/marketing/verticals.ts:57` and `:87`
- Test: `src/server/verticals/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/server/verticals/registry.test.ts`:

```ts
it("offers WhatsApp on every vertical now that the bot handles variants", () => {
  for (const id of VERTICAL_IDS) {
    expect(getDescriptor(id).storefront.showWhatsapp).toBe(true);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/server/verticals/registry.test.ts`
Expected: FAIL — retail, pharmacy and timber are `false`.

- [ ] **Step 3: Flip the flags**

In `src/server/verticals/registry.ts`, set `storefront: { ..., showWhatsapp: true }` for `retail`, `pharmacy` and `timber`. Leave `template` untouched.

- [ ] **Step 4: Remove the "Soon" chip from the marketing copy**

The feature is live once this task ships, so the `roadmap: true` flag added during design comes off. In `src/app/_components/marketing/verticals.ts`, both the `en` entry (line ~57) and the `ar` entry (line ~87):

```ts
{ icon: MessageCircle, title: "WhatsApp Ordering", description: "No app required — customers order straight from a chat they already have open." },
```

```ts
{ icon: MessageCircle, title: "الطلب عبر واتساب", description: "دون تطبيق — يطلب العملاء مباشرة من محادثة مفتوحة لديهم بالفعل." },
```

Do this **only** when Phase 2 is genuinely deployed — Tasks 1-15 all shipped, including reorder, which D4 puts in v1. Until then the flag stays.

- [ ] **Step 5: Run the full suite**

Run: `npm run test && npx tsc --noEmit && npm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/server/verticals/registry.ts src/app/_components/marketing/verticals.ts src/server/verticals/registry.test.ts
git commit -m "feat(whatsapp): enable the channel on all verticals, drop the Soon chip"
```

---

# Phase 3 — Outbound order status

**Not planned here, by design.** Spec §11 and issue #63.

Phase 3 is blocked on Spec 5 (#48), which names a `NotificationProvider` interface in prose but never specifies it — only `EmailProvider` has method signatures, and Spec 5 has no code. Writing tasks against an interface that does not exist would produce a plan that goes stale before anyone runs it.

When Spec 5 lands, plan Phase 3 separately. Two things carry forward:

- The conversational reply path in `runner.ts` talks to the Cloud API **directly** and must not be routed through Spec 5's `notify()`. That layer is a cron-drained outbox, which is the wrong shape for a sub-second reply.
- Template approval is per-WABA and therefore per-tenant, submitted by ServeOS via the Business Management API, independently revocable, and subject to Meta's periodic recategorisation. Model it as ongoing per-tenant state fed by `message_template_status_update`, not a one-time registry populate.

---

## Verification checklist

Before opening the PR:

- [ ] `npm run test` — full suite green
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npm run db:check && npm run db:check:test` — no pending migrations
- [ ] `src/server/audit/coverage.test.ts` passes with `linking.ts` and `runner.ts` in `AUDITED_SERVICE_FILES`
- [ ] Manual: link a number in a Meta test app, message it, walk a pickup order end to end, confirm the order appears in the dashboard on the `whatsapp` channel
- [ ] Manual: send the same webhook twice with the same wamid, confirm exactly one order
- [ ] Manual: place an order, say "menu" again, confirm "Same as last time" is offered and works
- [ ] Manual: link two tenants and send one batched webhook covering both, confirm each message lands under its own tenant
- [ ] Confirm `WHATSAPP_APP_SECRET`, `WHATSAPP_APP_ID` and `WHATSAPP_VERIFY_TOKEN` are set in every deployed environment
- [ ] Confirm Meta Business Verification, App Review and Access Verification are submitted — without all three the onboarding cap stays at 10 merchants per rolling 7 days

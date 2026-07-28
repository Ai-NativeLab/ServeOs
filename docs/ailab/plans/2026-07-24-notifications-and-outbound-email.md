# Notifications & Outbound Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ServeOS's first comms layer. A single `notify(ctx, {type, targets, channels, payload})` entry point writes an in-app `notifications` row per target **and**, for the `email` channel, enqueues a `notification_outbox` row — never touching the network. A scheduled **outbox worker** drains the queue through an `EmailProvider` (shaped exactly like the existing `BillingProvider`, first concrete impl **Resend** per decision **D7**) with retry, exponential backoff, and per-row idempotency so a PO is **never double-sent**. Provider delivery webhooks land in `email_events`, deduped. Notifications are tenant-scoped (FORCE RLS); sending is a system action with **no user permission**; every send emits a Spec 4 audit event. Implements `docs/ailab/specs/2026-07-24-notifications-and-outbound-email-design.md` (Spec 5, decision **D7**).

**Architecture:** Two domains. `src/server/email/` owns the transport — the `EmailProvider` interface, `ResendEmailProvider`, and `getEmailProvider()` which resolves the active provider once from `EMAIL_PROVIDER` env (mirroring how `ManualBillingProvider` sits behind `BillingProvider` in `src/server/billing/`). `src/server/notifications/` owns the domain — `notify()` (the core surface, not HTTP), the `outbox-worker`, the webhook handler, and the dashboard reads. `notify` is a cheap synchronous DB write inside the caller's `withTenant` transaction, so a PO's "sent" state and its outbox row commit atomically; the provider call is deferred to the worker so a slow or down provider never blocks the sale. `EmailProvider.parseWebhook` is **pure** (HMAC verify + normalize, `node:crypto`, no I/O), tested with fixed vectors and importable by the webhook route.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres (RLS via `withTenant`), `node:crypto` (HMAC, no new dependency), Resend HTTP API called via `fetch` (no SDK dependency), Vitest against a remote Supabase Postgres.

## Global Constraints

- **No new runtime dependencies.** HMAC verification uses `node:crypto`; the Resend API is one `fetch` call — no `resend` SDK, exactly as `ManualBillingProvider` uses no vendor SDK.
- **`notify` never touches the network.** It performs DB writes only (in-app rows + outbox enqueue). The provider is called **exclusively** by the outbox worker. A domain transaction must never block on Resend.
- **Store-and-forward, one row = at most one send.** `providerMessageId` is written **before** an outbox row flips to `sent`; the worker passes the outbox row `id` as the provider **idempotency key** so a crash between provider-accept and DB-commit cannot produce a second email on reclaim.
- **Tenant-scoped tables are behind RLS.** `notifications` and `notification_outbox` are `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house policy `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` and the matching `WITH CHECK`; every read/write goes through `withTenant`. `email_events` is **provider-global** (no `tenant_id`, no RLS) — the webhook that writes it is signature-authenticated and carries **no session**, so it cannot set `app.tenant_id` (see Self-Review deviation).
- **Sending has no user permission and no client entry point.** `src/server/rbac/permissions.ts` is intentionally **unchanged** — sending is a system action initiated by domain events, like `placeOrder`. There is deliberately **no HTTP endpoint that injects a notification or enqueues an email**; a postable outbox is a spam cannon. The dashboard read routes are gated by an authenticated session (`requireDashboardUser`) + RLS, not a permission key.
- **The webhook is signature-authenticated.** `parseWebhook` verifies the provider HMAC and throws `WebhookSignatureError` on failure; a forged event returns `400` and is never inserted.
- **Every send emits a Spec 4 audit event.** The worker calls `recordAuditEvent(ctx, {action:'notification.email.sent'}, tx)` from `@/server/audit/service` (sibling plan `docs/ailab/plans/2026-07-24-audit-and-fingerprint-log.md`). That module is on the same `feat/pos-core-ops` branch; the worker is the single wiring point if audit lands after this.
- **Env (config, never committed):** `EMAIL_PROVIDER` (default `resend`), `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM` (default `no-reply@mail.serveos.com`), `CRON_SECRET` (guards the worker trigger route).
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Database**
- Create: `src/server/notifications/schema.ts` — `notifications`, `notification_outbox`, `email_events`; enums `notification_type`, `notification_severity`, `outbox_status`, `email_event_type`.
- Modify: `src/server/branches/schema.ts` — add `replyToEmail`.
- Modify: `src/server/tenancy/schema.ts` — add `contactEmail`.
- Modify: `src/db/schema.ts` — register the notifications barrel.
- Create: `drizzle/0017_*.sql` — generated migration; RLS policies hand-appended (email_events excluded).

**Email transport (mirrors `src/server/billing/`)**
- Create: `src/server/email/provider.ts` — `EmailProvider`, `EmailMessage`, `RawWebhook`, `ParsedEmailEvent`, `WebhookSignatureError`.
- Create: `src/server/email/resend-provider.ts` — `ResendEmailProvider` (send via `fetch`, `parseWebhook` HMAC).
- Create: `src/server/email/config.ts` — `getEmailProvider()`, `EMAIL_FROM`.
- Create: `src/server/email/fake-provider.ts` — `FakeEmailProvider` recording test double.
- Create: `src/server/email/index.ts` — re-exports.
- Test: `src/server/email/provider.test.ts`, `src/server/email/config.test.ts`.

**Notifications domain**
- Create: `src/server/notifications/notify.ts` — `notify`, `NotifyContext`, `NotifyEvent`, `NotifyTarget`, `pickReplyTo`.
- Create: `src/server/notifications/outbox-worker.ts` — `runOutboxWorker`, backoff.
- Create: `src/server/notifications/webhook.ts` — `handleEmailWebhook`.
- Create: `src/server/notifications/read.ts` — `listNotifications`, `markRead`.
- Test: `src/server/notifications/notify.test.ts`, `outbox-worker.test.ts`, `webhook.test.ts`, `read.test.ts`.

**HTTP surface**
- Create: `src/app/api/notifications/worker/route.ts` — `CRON_SECRET`-guarded worker trigger.
- Create: `src/app/api/notifications/webhook/[provider]/route.ts` — provider callback.
- Create: `src/app/api/dashboard/notifications/route.ts` — `GET` feed (mirrors `src/app/api/dashboard/orders/route.ts`).
- Create: `src/app/api/dashboard/notifications/mark-read/route.ts` — `POST` mark-read.

---

## Task 1: Schema — notifications, outbox, email_events + reply-to columns

Three new tables plus two nullable email columns. `notifications` (in-app feed) and `notification_outbox` (email send queue) are tenant-scoped with FORCE RLS. `email_events` (provider webhook feedback) is provider-global: keyed by `providerMessageId`, deduped on `(provider, providerEventId)`, written by a sessionless webhook — so it has **no `tenant_id`** and **no RLS**. Drizzle's generator does not emit RLS, so — exactly as `drizzle/0016_bitter_beast.sql:81+` did for the tender tables — the `ENABLE`/`FORCE`/`CREATE POLICY` block for the two tenant tables is hand-appended to the generated migration.

**Files:**
- Create: `src/server/notifications/schema.ts`
- Modify: `src/server/branches/schema.ts`, `src/server/tenancy/schema.ts`, `src/db/schema.ts`
- Create: `drizzle/0017_*.sql` (generated, then edited)

**Interfaces:**
- Produces: tables `notifications`, `notificationOutbox`, `emailEvents`; enums `notificationTypeEnum`, `notificationSeverityEnum`, `outboxStatusEnum`, `emailEventTypeEnum`; types `Notification`, `NotificationOutbox`, `EmailEvent`, `NotificationType`, `NotificationSeverity`, `OutboxStatus`, `EmailEventType`. Adds `branches.replyToEmail`, `tenants.contactEmail`.

- [ ] **Step 1: Write the schema.** Create `src/server/notifications/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, jsonb, integer, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";

export const notificationTypeEnum = pgEnum("notification_type", [
  "low_stock", "reorder_suggested", "po_sent", "po_received",
  "shift_variance", "reconciliation_exception", "refund_issued",
]);
export const notificationSeverityEnum = pgEnum("notification_severity", ["info", "warning", "critical"]);
export const outboxStatusEnum = pgEnum("outbox_status", ["queued", "sending", "sent", "failed"]);
export const emailEventTypeEnum = pgEnum("email_event_type", ["delivered", "bounced", "complained", "opened"]);

/** In-app feed. One row per (target, event). userId set = personal; targetRole set = role-broadcast. */
export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  targetRole: text("target_role"),
  type: notificationTypeEnum("type").notNull(),
  severity: notificationSeverityEnum("severity").notNull().default("info"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("notifications_tenant_user_read").on(t.tenantId, t.userId, t.readAt),
  index("notifications_tenant_role_created").on(t.tenantId, t.targetRole, t.createdAt),
]);

/** Email send queue — store-and-forward. notify inserts; the worker drains. */
export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  toEmail: text("to_email").notNull(),
  replyTo: text("reply_to"),
  subject: text("subject").notNull(),
  template: text("template").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  status: outboxStatusEnum("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  // Backoff scheduling column (beyond the spec's column list — the spec asks for
  // "exponential backoff" but names no scheduling field; this is the claim gate).
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  providerMessageId: text("provider_message_id"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  index("notification_outbox_claim").on(t.status, t.createdAt),
]);

/** Provider delivery feedback, deduped. Provider-global (no tenant_id, no RLS): the
 * sessionless webhook cannot set app.tenant_id. Joins to outbox via providerMessageId. */
export const emailEvents = pgTable("email_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: emailEventTypeEnum("event_type").notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("email_events_provider_event").on(t.provider, t.providerEventId),
  index("email_events_message").on(t.providerMessageId),
]);

export type Notification = typeof notifications.$inferSelect;
export type NotificationOutbox = typeof notificationOutbox.$inferSelect;
export type EmailEvent = typeof emailEvents.$inferSelect;
export type NotificationType = (typeof notificationTypeEnum.enumValues)[number];
export type NotificationSeverity = (typeof notificationSeverityEnum.enumValues)[number];
export type OutboxStatus = (typeof outboxStatusEnum.enumValues)[number];
export type EmailEventType = (typeof emailEventTypeEnum.enumValues)[number];
```

- [ ] **Step 2: Add the reply-to columns + register.**
  - In `src/server/branches/schema.ts`, add to the `branches` table (after `phone`): `replyToEmail: text("reply_to_email"),`.
  - In `src/server/tenancy/schema.ts`, add to the `tenants` table (after `name`): `contactEmail: text("contact_email"),`.
  - In `src/db/schema.ts`, append after the `pos/tender-schema` line:

```ts
export * from "../server/notifications/schema";
```

- [ ] **Step 3: Generate the migration.**

```bash
npm run db:generate
```

Expected: a new `drizzle/0017_*.sql` creating the four enums, three tables, indexes, the two `ALTER TABLE … ADD COLUMN` for reply-to. It will **not** contain RLS.

- [ ] **Step 4: Hand-append RLS for the two tenant tables.** Open the generated file and append (mirror `drizzle/0016_bitter_beast.sql:81+`). **Do not** add RLS to `email_events`:

```sql
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY notifications_isolation ON "notifications"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY notification_outbox_isolation ON "notification_outbox"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

- [ ] **Step 5: Apply and verify the existing suite still passes.**

```bash
npm run db:migrate:test
npm test
```

Expected: migration applies; full suite PASS (nothing references the new tables yet).

- [ ] **Step 6: Commit.**

```bash
git add src/server/notifications/schema.ts src/server/branches/schema.ts src/server/tenancy/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(notifications): notifications, notification_outbox (FORCE RLS) + provider-global email_events + reply-to columns"
```

---

## Task 2: `EmailProvider` interface + `ResendEmailProvider` + provider selection

The transport, shaped like `BillingProvider` (`src/server/billing/provider.ts`): a tiny `interface` (`readonly name` + async `send` + pure `parseWebhook`), one concrete impl behind it, chosen once from env. `parseWebhook` is pure (`node:crypto` HMAC, no I/O) so it is unit-tested with fixed vectors. A `FakeEmailProvider` recording double is created here for Tasks 3–4.

**Files:**
- Create: `src/server/email/provider.ts`, `resend-provider.ts`, `config.ts`, `fake-provider.ts`, `index.ts`
- Test: `src/server/email/provider.test.ts`, `config.test.ts`

**Interfaces:**
- Consumes: `node:crypto`.
- Produces:
  - `type EmailAttachment = { filename: string; content: string; contentType?: string }` (content base64)
  - `type EmailMessage = { from: string; replyTo?: string | null; to: string; subject: string; template: string; payload: Record<string, unknown>; attachments?: EmailAttachment[]; idempotencyKey?: string }`
  - `type RawWebhook = { headers: Record<string, string>; rawBody: string }`
  - `type ParsedEmailEvent = { provider: string; providerMessageId: string; providerEventId: string; eventType: EmailEventType; raw: Record<string, unknown> }`
  - `class WebhookSignatureError extends Error`
  - `interface EmailProvider { readonly name: string; send(message: EmailMessage): Promise<{ providerMessageId: string }>; parseWebhook(req: RawWebhook): ParsedEmailEvent }`
  - `function getEmailProvider(name?: string): EmailProvider`
  - `const EMAIL_FROM: string`
  - `class FakeEmailProvider implements EmailProvider` — records every `send`, returns a deterministic id; `parseWebhook` returns a fixed event.

- [ ] **Step 1: Write the failing tests.** Create `src/server/email/provider.test.ts` (pure `parseWebhook`) and `src/server/email/config.test.ts` (selection):

```ts
// provider.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { ResendEmailProvider } from "./resend-provider";
import { WebhookSignatureError } from "./provider";

const secret = "whsec_test";
function sign(id: string, ts: string, body: string) {
  return "v1," + createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64");
}

describe("ResendEmailProvider.parseWebhook", () => {
  const provider = new ResendEmailProvider({ apiKey: "x", webhookSecret: secret });
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg_1" } });
  const headers = { "webhook-id": "evt_1", "webhook-timestamp": "1700000000" };

  it("verifies a good signature and normalizes the event", () => {
    const parsed = provider.parseWebhook({
      headers: { ...headers, "webhook-signature": sign("evt_1", "1700000000", body) },
      rawBody: body,
    });
    expect(parsed).toMatchObject({
      provider: "resend", providerMessageId: "msg_1", providerEventId: "evt_1", eventType: "delivered",
    });
  });

  it("throws WebhookSignatureError on a tampered body", () => {
    expect(() => provider.parseWebhook({
      headers: { ...headers, "webhook-signature": sign("evt_1", "1700000000", body) },
      rawBody: body + "tampered",
    })).toThrow(WebhookSignatureError);
  });

  it("maps each provider event to delivered|bounced|complained|opened", () => {
    for (const [t, e] of [["email.bounced", "bounced"], ["email.complained", "complained"], ["email.opened", "opened"]] as const) {
      const b = JSON.stringify({ type: t, data: { email_id: "m" } });
      const p = provider.parseWebhook({ headers: { "webhook-id": "e", "webhook-timestamp": "1", "webhook-signature": sign("e", "1", b) }, rawBody: b });
      expect(p.eventType).toBe(e);
    }
  });
});
```

```ts
// config.test.ts
import { describe, it, expect } from "vitest";
import { getEmailProvider } from "./config";
import { ResendEmailProvider } from "./resend-provider";

describe("getEmailProvider", () => {
  it("returns Resend by default", () => {
    expect(getEmailProvider("resend")).toBeInstanceOf(ResendEmailProvider);
    expect(getEmailProvider("resend").name).toBe("resend");
  });
  it("throws on an unknown provider (no silent fallback)", () => {
    expect(() => getEmailProvider("carrier-pigeon")).toThrow(/carrier-pigeon/);
  });
});
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/email/`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the interface + errors.** Create `src/server/email/provider.ts`:

```ts
import type { EmailEventType } from "@/server/notifications/schema";

export type EmailAttachment = { filename: string; content: string; contentType?: string };

export type EmailMessage = {
  from: string;
  replyTo?: string | null;
  to: string;
  subject: string;
  template: string;
  payload: Record<string, unknown>;
  attachments?: EmailAttachment[];
  /** The outbox row id, passed to the provider as its idempotency key. */
  idempotencyKey?: string;
};

export type RawWebhook = { headers: Record<string, string>; rawBody: string };

export type ParsedEmailEvent = {
  provider: string;
  providerMessageId: string;
  providerEventId: string;
  eventType: EmailEventType;
  raw: Record<string, unknown>;
};

export class WebhookSignatureError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
  /** Pure: verify HMAC, throw WebhookSignatureError on failure, else normalize. */
  parseWebhook(req: RawWebhook): ParsedEmailEvent;
}
```

- [ ] **Step 4: Implement `ResendEmailProvider`.** Create `src/server/email/resend-provider.ts` — `send` is one `fetch` to `https://api.resend.com/emails` carrying `Idempotency-Key: message.idempotencyKey`; `parseWebhook` verifies the Svix-style HMAC over `${webhook-id}.${webhook-timestamp}.${rawBody}` (base64, timing-safe compare) and maps `email.*` types:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailProvider, EmailMessage, RawWebhook, ParsedEmailEvent } from "./provider";
import { WebhookSignatureError } from "./provider";
import type { EmailEventType } from "@/server/notifications/schema";

const EVENT_MAP: Record<string, EmailEventType> = {
  "email.delivered": "delivered", "email.bounced": "bounced",
  "email.complained": "complained", "email.opened": "opened",
};

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  constructor(private readonly cfg: { apiKey: string; webhookSecret: string }) {}

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    // One HTTP call. Idempotency-Key = the outbox row id → the provider dedupes a
    // retried identical request. Rendering (html/text from template+payload) is
    // Spec 9's concern; v1 forwards payload.html/text.
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json",
        ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: message.from, to: message.to, subject: message.subject, reply_to: message.replyTo ?? undefined,
        html: message.payload.html ?? undefined, text: message.payload.text ?? message.subject,
        attachments: message.attachments, tags: [{ name: "template", value: message.template }],
      }),
    });
    if (!res.ok) throw new Error(`resend send failed: ${res.status} ${await res.text()}`);
    return { providerMessageId: ((await res.json()) as { id: string }).id };
  }

  parseWebhook(req: RawWebhook): ParsedEmailEvent {
    const id = req.headers["webhook-id"] ?? "";
    const ts = req.headers["webhook-timestamp"] ?? "";
    const sigHeader = req.headers["webhook-signature"] ?? "";
    const expected = createHmac("sha256", this.cfg.webhookSecret).update(`${id}.${ts}.${req.rawBody}`).digest("base64");
    const ok = sigHeader.split(" ").some((s) => {
      const got = s.includes(",") ? s.split(",")[1]! : s;
      const a = Buffer.from(got); const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!ok) throw new WebhookSignatureError();
    const parsed = JSON.parse(req.rawBody) as { type: string; data: { email_id: string } };
    const eventType = EVENT_MAP[parsed.type];
    if (!eventType) throw new WebhookSignatureError(`unmapped event type: ${parsed.type}`);
    return { provider: "resend", providerMessageId: parsed.data.email_id, providerEventId: id, eventType, raw: parsed as unknown as Record<string, unknown> };
  }
}
```

- [ ] **Step 5: Implement selection + fake + barrel.** Create `src/server/email/config.ts`:

```ts
import type { EmailProvider } from "./provider";
import { ResendEmailProvider } from "./resend-provider";

export const EMAIL_FROM = process.env.EMAIL_FROM ?? "no-reply@mail.serveos.com";

/** Resolved once from env; no call site knows which provider is active. */
export function getEmailProvider(name: string = process.env.EMAIL_PROVIDER ?? "resend"): EmailProvider {
  switch (name) {
    case "resend":
      return new ResendEmailProvider({
        apiKey: process.env.RESEND_API_KEY ?? "",
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET ?? "",
      });
    // "brevo" / "ses" are future impls on the same interface.
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${name}`);
  }
}
```

Create `src/server/email/fake-provider.ts` — a recording double:

```ts
import type { EmailProvider, EmailMessage, RawWebhook, ParsedEmailEvent } from "./provider";

export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  readonly sent: EmailMessage[] = [];
  constructor(private readonly opts: { failTimes?: number } = {}) {}
  private calls = 0;

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    if (this.calls++ < (this.opts.failTimes ?? 0)) throw new Error("transient provider error");
    this.sent.push(message);
    return { providerMessageId: `fake_${message.idempotencyKey ?? this.sent.length}` };
  }
  parseWebhook(_req: RawWebhook): ParsedEmailEvent {
    return { provider: "fake", providerMessageId: "fake_1", providerEventId: "evt_fake", eventType: "delivered", raw: {} };
  }
}
```

Create `src/server/email/index.ts`:

```ts
export type { EmailProvider, EmailMessage, RawWebhook, ParsedEmailEvent } from "./provider";
export { WebhookSignatureError } from "./provider";
export { ResendEmailProvider } from "./resend-provider";
export { FakeEmailProvider } from "./fake-provider";
export { getEmailProvider, EMAIL_FROM } from "./config";
```

- [ ] **Step 6: Run to verify they pass + typecheck + commit.**

```bash
npx vitest run src/server/email/ && npx tsc --noEmit && npx eslint src/server/email
git add src/server/email
git commit -m "feat(email): EmailProvider interface + ResendEmailProvider + env-based selection (mirrors BillingProvider)"
```

---

## Task 3: `notify` — write in-app rows + enqueue outbox, in the caller's tx

The core surface, not HTTP. It writes one `notifications` row per target and, for the `email` channel, resolves each recipient + Reply-To and enqueues `notification_outbox` rows — **inside the caller's transaction** when one is passed, so a PO's "sent" state and its outbox row commit atomically. Reply-To resolution is branch → tenant → omitted; the pure chooser `pickReplyTo` is unit-tested.

**Files:**
- Create: `src/server/notifications/notify.ts`
- Test: `src/server/notifications/notify.test.ts`

**Interfaces:**
- Consumes: `withTenant` (`@/db/with-tenant`); `notifications`, `notificationOutbox`, `NotificationType`, `NotificationSeverity` (Task 1); `branches`, `tenants`, `users`.
- Produces:
  - `type NotifyTarget = { userId: string } | { role: string }`
  - `type NotifyChannel = "in_app" | "email"`
  - `type NotifyContext = { tenantId: string; branchId?: string | null; actorUserId?: string | null }`
  - `type NotifyEvent = { type: NotificationType; severity?: NotificationSeverity; title: string; body: string; entityType?: string | null; entityId?: string | null; targets: NotifyTarget[]; channels: NotifyChannel[]; email?: { subject: string; template: string; payload?: Record<string, unknown>; toEmail?: string } }`
  - `type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]`
  - `function notify(ctx: NotifyContext, event: NotifyEvent, tx?: Tx): Promise<void>`
  - `function pickReplyTo(branchEmail?: string | null, tenantEmail?: string | null): string | null`

- [ ] **Step 1: Write the failing tests.** Create `src/server/notifications/notify.test.ts` — assert:
  - in-app: `notify({channels:['in_app']})` writes one `notifications` row per target (`userId` set for `{userId}`, `targetRole` set for `{role}`), no outbox row.
  - email: `notify({channels:['in_app','email'], email:{toEmail}})` writes the in-app rows **and** one `notification_outbox` row (`status='queued'`, `attempts=0`) with the explicit `toEmail`.
  - Reply-To resolution: with `ctx.branchId` whose `replyToEmail` is set, the outbox `replyTo` is the branch address; with only `tenants.contactEmail`, it falls to the tenant; with neither, `replyTo` is null.
  - atomicity: `notify` called inside a `withTenant` tx that then throws leaves **zero** rows (rolls back with the caller).
  - RLS: tenant B never sees tenant A's notifications/outbox.
  - `pickReplyTo` unit: `pickReplyTo("b@x", "t@x") === "b@x"`, `pickReplyTo(null, "t@x") === "t@x"`, `pickReplyTo(null, null) === null`.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/notifications/notify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `src/server/notifications/notify.ts`:

```ts
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { branches } from "@/server/branches/schema";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { notifications, notificationOutbox, type NotificationType, type NotificationSeverity } from "./schema";

export type NotifyTarget = { userId: string } | { role: string };
export type NotifyChannel = "in_app" | "email";
export type NotifyContext = { tenantId: string; branchId?: string | null; actorUserId?: string | null };
export type NotifyEvent = {
  type: NotificationType;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  targets: NotifyTarget[];
  channels: NotifyChannel[];
  email?: { subject: string; template: string; payload?: Record<string, unknown>; toEmail?: string };
};
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Branch address wins, then tenant, else omitted. */
export function pickReplyTo(branchEmail?: string | null, tenantEmail?: string | null): string | null {
  return branchEmail ?? tenantEmail ?? null;
}

/**
 * Writes in-app rows + (for the email channel) enqueues outbox rows. Runs on the
 * caller's tx when passed (atomic with the domain event), else opens its own
 * withTenant. NEVER calls the network.
 */
export async function notify(ctx: NotifyContext, event: NotifyEvent, tx?: Tx): Promise<void> {
  const run = async (t: Tx) => {
    // 1. In-app feed: one row per target.
    if (event.channels.includes("in_app")) {
      await t.insert(notifications).values(event.targets.map((tg) => ({
        tenantId: ctx.tenantId,
        userId: "userId" in tg ? tg.userId : null,
        targetRole: "role" in tg ? tg.role : null,
        type: event.type, severity: event.severity ?? "info",
        title: event.title, body: event.body,
        entityType: event.entityType ?? null, entityId: event.entityId ?? null,
      })));
    }
    // 2. Email: resolve recipients + Reply-To, enqueue one outbox row each.
    if (event.channels.includes("email") && event.email) {
      const recipients = await resolveRecipients(t, event);
      if (recipients.length > 0) {
        const replyTo = await resolveReplyTo(t, ctx);
        await t.insert(notificationOutbox).values(recipients.map((toEmail) => ({
          tenantId: ctx.tenantId, toEmail, replyTo,
          subject: event.email!.subject, template: event.email!.template,
          payload: event.email!.payload ?? {}, status: "queued" as const,
        })));
      }
    }
  };
  return tx ? run(tx) : withTenant(ctx.tenantId, run);
}

/** Explicit toEmail wins (the supplier on a PO); else the emails of the {userId} targets. */
async function resolveRecipients(t: Tx, event: NotifyEvent): Promise<string[]> {
  if (event.email?.toEmail) return [event.email.toEmail];
  const ids = event.targets.flatMap((tg) => ("userId" in tg ? [tg.userId] : []));
  if (ids.length === 0) return [];
  return (await t.select({ email: users.email }).from(users).where(inArray(users.id, ids)))
    .map((r) => r.email).filter((e): e is string => !!e);
}

/** branches.replyToEmail (when ctx.branchId set) → tenants.contactEmail → null. */
async function resolveReplyTo(t: Tx, ctx: NotifyContext): Promise<string | null> {
  const b = ctx.branchId ? (await t.select({ e: branches.replyToEmail }).from(branches).where(eq(branches.id, ctx.branchId)).limit(1))[0]?.e : null;
  const tn = (await t.select({ e: tenants.contactEmail }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1))[0]?.e;
  return pickReplyTo(b, tn);
}
```

- [ ] **Step 4: Run to verify they pass + typecheck + commit.**

```bash
npx vitest run src/server/notifications/notify.test.ts && npx tsc --noEmit && npx eslint src/server/notifications
git add src/server/notifications/notify.ts src/server/notifications/notify.test.ts
git commit -m "feat(notifications): notify() writes in-app rows + enqueues outbox in the caller's tx"
```

---

## Task 4: Outbox worker — send, retry+backoff, idempotency, audit

The scheduled drainer. Per tenant, inside `withTenant`, it claims eligible rows with `SELECT … FOR UPDATE SKIP LOCKED` (so two workers never grab the same row), flips them to `sending`, calls `provider.send` with the outbox `id` as idempotency key, writes `providerMessageId` **before** `sent`, and emits the Spec 4 audit event. On failure it advances `attempts`, records `lastError`, and schedules the next attempt with exponential backoff; after `maxAttempts` it leaves the row `failed` and raises a `critical` in-app notification to the owner. It also reconciles `email_events` bounces/complaints into `outbox.lastError` (the linkage the spec sketches inside the webhook, relocated here because only a tenant context can touch the RLS-protected outbox — see Self-Review).

**Files:**
- Create: `src/server/notifications/outbox-worker.ts`
- Create: `src/app/api/notifications/worker/route.ts`
- Test: `src/server/notifications/outbox-worker.test.ts`

**Interfaces:**
- Consumes: `EmailProvider`, `EMAIL_FROM` (Task 2); `notificationOutbox`, `notifications`, `emailEvents` (Task 1); `withTenant`; `recordAuditEvent` (`@/server/audit/service`, sibling Spec 4).
- Produces:
  - `type OutboxWorkerDeps = { provider: EmailProvider; from?: string; maxAttempts?: number; batchSize?: number; backoffMs?: (attempts: number) => number; now?: () => Date; listTenantIds?: () => Promise<string[]> }`
  - `type OutboxWorkerResult = { claimed: number; sent: number; failed: number }`
  - `function runOutboxWorker(deps: OutboxWorkerDeps): Promise<OutboxWorkerResult>`

- [ ] **Step 1: Write the failing tests.** Create `src/server/notifications/outbox-worker.test.ts` — seed via `notify`, drive with a `FakeEmailProvider`, assert:
  - a `queued` row is sent: `provider.sent` has the message (with `from = EMAIL_FROM`, the right `to`/`replyTo`), the row flips to `sent` with a `providerMessageId` and `sentAt`.
  - **never double-sends:** running two `runOutboxWorker` concurrently over one queued row calls `provider.send` **exactly once** and leaves exactly one `sent` row (`SKIP LOCKED`).
  - **idempotency key:** the `send` call receives `idempotencyKey === row.id`.
  - retry/backoff: a `FakeEmailProvider({failTimes:1})` leaves the row `failed` with `attempts=1`, `lastError`, and a future `nextAttemptAt`; a second pass (clock advanced) sends it and flips to `sent`.
  - give up: with `maxAttempts:1` a permanently-failing provider leaves the row `failed` and inserts a `critical` `notifications` row targeted at `role:'owner'`.
  - audit: a successful send inserts an `audit_events` row `action='notification.email.sent'` (skip/guard this assertion if the audit module is not yet on the branch).
  - reconcile: an `email_events` `bounced` row for the sent message sets the outbox `lastError` on the next pass.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/notifications/outbox-worker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the worker.** Create `src/server/notifications/outbox-worker.ts`:

```ts
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { notificationOutbox, notifications } from "./schema";
import { EMAIL_FROM, type EmailProvider } from "@/server/email";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";

export type OutboxWorkerDeps = {
  provider: EmailProvider;
  from?: string;
  maxAttempts?: number;
  batchSize?: number;
  backoffMs?: (attempts: number) => number;
  now?: () => Date;
  listTenantIds?: () => Promise<string[]>;
};
export type OutboxWorkerResult = { claimed: number; sent: number; failed: number };

const defaultBackoff = (attempts: number) => Math.min(2 ** attempts, 60) * 60_000; // 2,4,8… min, capped 1h

export async function runOutboxWorker(deps: OutboxWorkerDeps): Promise<OutboxWorkerResult> {
  const from = deps.from ?? EMAIL_FROM;
  const maxAttempts = deps.maxAttempts ?? 5;
  const batchSize = deps.batchSize ?? 25;
  const backoffMs = deps.backoffMs ?? defaultBackoff;
  const now = deps.now ?? (() => new Date());
  const tenantIds = deps.listTenantIds
    ? await deps.listTenantIds()
    : (await db.select({ id: tenants.id }).from(tenants)).map((r) => r.id);

  const result: OutboxWorkerResult = { claimed: 0, sent: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    await withTenant(tenantId, async (tx) => {
      // 1. Claim: queued|failed, backoff-eligible, locked so no other worker grabs them.
      const rows = await tx.select().from(notificationOutbox)
        .where(and(
          inArray(notificationOutbox.status, ["queued", "failed"]),
          or(isNull(notificationOutbox.nextAttemptAt), lte(notificationOutbox.nextAttemptAt, now())),
        ))
        .orderBy(asc(notificationOutbox.createdAt)).limit(batchSize)
        .for("update", { skipLocked: true });
      result.claimed += rows.length;

      for (const row of rows) {
        // The row stays row-locked for the whole tx (claim + flip + send + finalize),
        // so a second worker's SKIP LOCKED select never grabs it. Flip to sending first.
        await tx.update(notificationOutbox).set({ status: "sending", attempts: row.attempts + 1 }).where(eq(notificationOutbox.id, row.id));
        try {
          const { providerMessageId } = await deps.provider.send({
            from, to: row.toEmail, replyTo: row.replyTo, subject: row.subject,
            template: row.template, payload: row.payload, idempotencyKey: row.id, // never double-send
          });
          // Record the id BEFORE flipping to sent, then emit the Spec 4 audit event.
          await tx.update(notificationOutbox).set({ providerMessageId, status: "sent", sentAt: now(), lastError: null }).where(eq(notificationOutbox.id, row.id));
          result.sent += 1;
          await recordAuditEvent(
            { tenantId, actorUserId: null, fingerprint: emptyFingerprint() },
            { action: "notification.email.sent", entityType: "notification_outbox", entityId: row.id,
              summary: `Email sent to ${row.toEmail} (${row.template})`, metadata: { template: row.template, providerMessageId }, actorType: "system" },
            tx,
          );
        } catch (e) {
          const attempts = row.attempts + 1;
          const giveUp = attempts >= maxAttempts;
          await tx.update(notificationOutbox).set({
            status: "failed", lastError: String((e as Error).message ?? e),
            nextAttemptAt: giveUp ? null : new Date(now().getTime() + backoffMs(attempts)),
          }).where(eq(notificationOutbox.id, row.id));
          result.failed += 1;
          // Retry budget spent → surface a critical alert to the owner (in-app only).
          if (giveUp) await tx.insert(notifications).values({
            tenantId, targetRole: "owner", type: "reconciliation_exception", severity: "critical",
            title: "Email delivery failed", body: `Could not deliver email to ${row.toEmail} after retries.`,
            entityType: "notification_outbox", entityId: row.id,
          });
        }
      }

      // 2. Reconcile provider feedback: a bounced/complained email_events row for this
      //    tenant's sent messages sets outbox.lastError (the webhook is sessionless and
      //    cannot touch the RLS-protected outbox — see Self-Review). Join
      //    notification_outbox.providerMessageId → email_events.providerMessageId where
      //    event_type IN ('bounced','complained') and lastError IS NULL; set lastError.
    });
  }
  return result;
}
```

- [ ] **Step 4: Add the cron trigger route.** Create `src/app/api/notifications/worker/route.ts` — `POST`, rejects without `Authorization: Bearer ${CRON_SECRET}` (`401`), else runs `runOutboxWorker({ provider: getEmailProvider() })` and returns the result:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getEmailProvider } from "@/server/email";
import { runOutboxWorker } from "@/server/notifications/outbox-worker";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runOutboxWorker({ provider: getEmailProvider() });
  return NextResponse.json(result);
}
```

- [ ] **Step 5: Run to verify they pass + typecheck + commit.**

```bash
npx vitest run src/server/notifications/outbox-worker.test.ts && npx tsc --noEmit && npx eslint src/server/notifications src/app/api/notifications
git add src/server/notifications/outbox-worker.ts src/server/notifications/outbox-worker.test.ts src/app/api/notifications/worker
git commit -m "feat(notifications): outbox worker — SKIP LOCKED claim, retry+backoff, never double-send, audit on send"
```

---

## Task 5: Provider webhook route — parseWebhook → email_events, deduped

The provider callback. Raw body → `getEmailProvider(provider).parseWebhook` verifies the signature → dedupe-insert into `email_events` on `(provider, providerEventId)` → returns `200` even on a duplicate (so the provider stops retrying) and `400` only on signature failure. `email_events` is provider-global, so the insert uses the raw `db` client (no `withTenant`). Bounce/complaint → outbox linkage is the worker's reconcile pass (Task 4), not here.

**Files:**
- Create: `src/server/notifications/webhook.ts`
- Create: `src/app/api/notifications/webhook/[provider]/route.ts`
- Test: `src/server/notifications/webhook.test.ts`

**Interfaces:**
- Consumes: `getEmailProvider`, `WebhookSignatureError` (Task 2); `emailEvents` (Task 1); raw `db`.
- Produces:
  - `function handleEmailWebhook(providerName: string, raw: RawWebhook): Promise<{ status: number }>`

- [ ] **Step 1: Write the failing tests.** Create `src/server/notifications/webhook.test.ts` — build a signed Resend body (as in Task 2), then assert:
  - a valid signature inserts one `email_events` row and returns `{status:200}`.
  - a **duplicate** delivery (same `webhook-id`/`providerEventId`) is a no-op second insert and still returns `{status:200}` (count stays 1).
  - a tampered body returns `{status:400}` and inserts **nothing**.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/notifications/webhook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler.** Create `src/server/notifications/webhook.ts`:

```ts
import { db } from "@/db/client";
import { emailEvents } from "./schema";
import { getEmailProvider, WebhookSignatureError, type RawWebhook } from "@/server/email";

export async function handleEmailWebhook(providerName: string, raw: RawWebhook): Promise<{ status: number }> {
  let parsed;
  try {
    parsed = getEmailProvider(providerName).parseWebhook(raw);
  } catch (e) {
    if (e instanceof WebhookSignatureError) return { status: 400 }; // never insert a forged event
    throw e;
  }
  // Dedupe on (provider, providerEventId); a retried delivery is a no-op.
  await db.insert(emailEvents).values({
    provider: parsed.provider, providerMessageId: parsed.providerMessageId,
    providerEventId: parsed.providerEventId, eventType: parsed.eventType, raw: parsed.raw,
  }).onConflictDoNothing({ target: [emailEvents.provider, emailEvents.providerEventId] });
  return { status: 200 };
}
```

- [ ] **Step 4: Implement the route.** Create `src/app/api/notifications/webhook/[provider]/route.ts` — read the **raw** body + headers, call `handleEmailWebhook`, return the status:

```ts
import { NextRequest, NextResponse } from "next/server";
import { handleEmailWebhook } from "@/server/notifications/webhook";

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const { status } = await handleEmailWebhook(provider, { headers, rawBody });
  return NextResponse.json({ ok: status === 200 }, { status });
}
```

- [ ] **Step 5: Run to verify they pass + typecheck + commit.**

```bash
npx vitest run src/server/notifications/webhook.test.ts && npx tsc --noEmit && npx eslint src/server/notifications src/app/api/notifications
git add src/server/notifications/webhook.ts src/server/notifications/webhook.test.ts src/app/api/notifications/webhook
git commit -m "feat(notifications): provider webhook — verify signature, dedupe into email_events, 200 on duplicate / 400 on forgery"
```

---

## Task 6: Dashboard feed — `GET /api/dashboard/notifications` + mark-read

The read surface, gated by an authenticated session (`requireDashboardUser`) and tenant-scoped through `withTenant`. Within the tenant, the query filters to `userId = me OR targetRole ∈ my roles`, so a user sees their own + role-broadcast notifications but never another user's. `mark-read` sets `readAt` on rows the caller can see. **No permission key is added** (deliberate, per spec §Authorization); **no route ever inserts** a notification.

**Files:**
- Create: `src/server/notifications/read.ts`
- Create: `src/app/api/dashboard/notifications/route.ts`
- Create: `src/app/api/dashboard/notifications/mark-read/route.ts`
- Test: `src/server/notifications/read.test.ts`

**Interfaces:**
- Consumes: `requireDashboardUser` + `DashboardContext` (`@/server/auth/dashboard-context`); `withTenant`; `notifications` (Task 1).
- Produces:
  - `type NotificationReadCtx = { tenantId: string; userId: string; roleKeys: string[] }`
  - `type ListNotificationsFilters = { type?: NotificationType; severity?: NotificationSeverity; read?: boolean; limit?: number }`
  - `function listNotifications(ctx: NotificationReadCtx, filters: ListNotificationsFilters): Promise<{ items: Notification[]; unreadCount: number }>`
  - `function markRead(ctx: NotificationReadCtx, ids?: string[]): Promise<{ updated: number }>`

- [ ] **Step 1: Write the failing tests.** Create `src/server/notifications/read.test.ts` — seed via `notify`, then assert:
  - `listNotifications` returns the caller's own + role-targeted rows, newest first, and an accurate `unreadCount`; a row targeted at a role the caller does **not** hold is excluded.
  - filters by `type`, `severity`, and `read` narrow the result.
  - `markRead(ctx, [id])` sets `readAt` (idempotent — a second call updates 0); `markRead(ctx)` (no ids) marks all visible unread read and drops `unreadCount` to 0.
  - RLS: `listNotifications(ctxTenantA)` never returns tenant B's rows.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/notifications/read.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reads.** Create `src/server/notifications/read.ts`:

```ts
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { notifications, type Notification, type NotificationType, type NotificationSeverity } from "./schema";

export type NotificationReadCtx = { tenantId: string; userId: string; roleKeys: string[] };
export type ListNotificationsFilters = { type?: NotificationType; severity?: NotificationSeverity; read?: boolean; limit?: number };

/** Visible to me: my personal rows OR rows broadcast to a role I hold. */
function visibleTo(ctx: NotificationReadCtx) {
  return or(
    eq(notifications.userId, ctx.userId),
    ctx.roleKeys.length > 0 ? inArray(notifications.targetRole, ctx.roleKeys) : sql`false`,
  );
}

export async function listNotifications(ctx: NotificationReadCtx, filters: ListNotificationsFilters): Promise<{ items: Notification[]; unreadCount: number }> {
  return withTenant(ctx.tenantId, async (tx) => {
    const conds = [visibleTo(ctx)];
    if (filters.type) conds.push(eq(notifications.type, filters.type));
    if (filters.severity) conds.push(eq(notifications.severity, filters.severity));
    if (filters.read === true) conds.push(sql`${notifications.readAt} is not null`);
    if (filters.read === false) conds.push(isNull(notifications.readAt));
    const items = await tx.select().from(notifications).where(and(...conds))
      .orderBy(desc(notifications.createdAt)).limit(Math.min(filters.limit ?? 50, 200));
    const [{ c }] = await tx.select({ c: sql<number>`count(*)::int` }).from(notifications)
      .where(and(visibleTo(ctx), isNull(notifications.readAt)));
    return { items, unreadCount: c };
  });
}

export async function markRead(ctx: NotificationReadCtx, ids?: string[]): Promise<{ updated: number }> {
  return withTenant(ctx.tenantId, async (tx) => {
    const conds = [visibleTo(ctx), isNull(notifications.readAt)];
    if (ids && ids.length > 0) conds.push(inArray(notifications.id, ids));
    const updated = await tx.update(notifications).set({ readAt: new Date() })
      .where(and(...conds)).returning({ id: notifications.id });
    return { updated: updated.length };
  });
}
```

- [ ] **Step 4: Implement the routes.** Create `src/app/api/dashboard/notifications/route.ts` (mirror `src/app/api/dashboard/orders/route.ts`):

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { listNotifications } from "@/server/notifications/read";

export async function GET(req: NextRequest) {
  const { tenantId, user, roleKeys } = await requireDashboardUser();
  const p = req.nextUrl.searchParams;
  const read = p.get("read");
  const result = await listNotifications({ tenantId, userId: user.id, roleKeys }, {
    type: (p.get("type") as never) ?? undefined,
    severity: (p.get("severity") as never) ?? undefined,
    read: read === null ? undefined : read === "true",
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
  });
  return NextResponse.json(result);
}
```

Create `src/app/api/dashboard/notifications/mark-read/route.ts` — `POST`, body `{ ids?: string[] }` (omit = mark all), calls `markRead(ctx, body.ids)`, returns `{ updated }`.

- [ ] **Step 5: Run to verify they pass + typecheck + commit.**

```bash
npx vitest run src/server/notifications/read.test.ts && npx tsc --noEmit && npx eslint src/server/notifications src/app/api/dashboard/notifications
git add src/server/notifications/read.ts src/server/notifications/read.test.ts src/app/api/dashboard/notifications
git commit -m "feat(notifications): dashboard feed (own + role-targeted) + idempotent mark-read, session-gated + RLS"
```

---

## Task 7: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test
npx tsc --noEmit
npx eslint src
```

Expected: all PASS, all clean. Fix anything that is not before continuing.

- [ ] **Step 2: Walk the spec's acceptance path.** Configure `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and a verified `mail.serveos.com`; set a branch `reply_to_email`.

- [ ] Trigger a test `po_sent` `notify({ channels:['in_app','email'], email:{ toEmail:<a real inbox> } })` → an in-app row appears and (after the worker runs) a real email arrives **From** `no-reply@mail.serveos.com` with **Reply-To** = the branch address.
- [ ] Reply to it → the reply reaches the branch mailbox (not the platform).
- [ ] Confirm the outbox row flipped to `sent` with a `providerMessageId`, and an `audit_events` row `action='notification.email.sent'` exists.
- [ ] Resend's webhook fires → an `email_events` `delivered` row appears; re-deliver the same event → no duplicate (count stays 1).
- [ ] Send to a known-bad address → a `bounced` `email_events` row and (next worker pass) the outbox `lastError` set + a `critical` owner notification.
- [ ] `POST /api/notifications/worker` without `CRON_SECRET` → `401`; the webhook with a tampered body → `400`, nothing inserted.
- [ ] `GET /api/dashboard/notifications` as the target user → sees own + role-targeted rows with `unreadCount`; `POST …/mark-read` clears the badge.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(notifications): notify() + outbox worker + EmailProvider (Resend) + delivery webhooks" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-notifications-and-outbound-email-design.md (Spec 5, decision D7).

- notifications + notification_outbox (FORCE RLS) + provider-global email_events; reply-to columns on branches/tenants.
- EmailProvider interface (shaped like BillingProvider) + ResendEmailProvider + env-based getEmailProvider(); no vendor SDK.
- notify(ctx, event, tx?) — in-app rows + outbox enqueue, in the caller's transaction, never touching the network.
- Outbox worker — SELECT … FOR UPDATE SKIP LOCKED claim, retry + exponential backoff, provider idempotency key so a PO is never double-sent; emits a Spec 4 audit event on send.
- Provider webhook — verify HMAC, dedupe into email_events, 200 on duplicate / 400 on forgery.
- Dashboard feed (own + role-targeted) + idempotent mark-read, session-gated + RLS. No sending permission, no client enqueue endpoint.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- *Data model* — `notifications`, `notification_outbox` (FORCE RLS), `email_events` (deduped), `notification_type` + severity/status/event enums, reply-to columns, the claim index, the `(provider, providerEventId)` unique index → **Task 1**.
- *`EmailProvider` interface + Resend + swappability* — `readonly name` + `send` + pure `parseWebhook`, `getEmailProvider()` from `EMAIL_PROVIDER`, mirrors `BillingProvider` → **Task 2**.
- *`notify(ctx, {type, targets, channels, payload})`* — in-app rows + outbox enqueue inside the caller's tx, Reply-To branch→tenant→omitted, never networks → **Task 3**.
- *Outbox worker / durability / idempotency / audit* — `SKIP LOCKED` claim, `sending` flip, `providerMessageId` before `sent`, idempotency key = row id, retry+backoff, give-up→critical alert, Spec 4 audit event → **Task 4**.
- *Webhook* — signature verify, dedupe insert, `200` on duplicate / `400` on forgery → **Task 5**.
- *Dashboard API + auth model* — `GET /api/dashboard/notifications` + `mark-read`, session-gated, tenant + own/role-scoped, no sending permission, no client enqueue → **Task 6**.
- *Testing* (unit / server / manual acceptance) — every task, plus **Task 7**.

**One deliberate deviation from the spec:** the spec's prose calls `email_events` one of "three tenant-scoped tables (FORCE RLS)," yet its own column list for `email_events` has **no `tenant_id`**, and the webhook that writes it is signature-authenticated with **no session** — so it can never set `app.tenant_id` to satisfy an RLS policy. I keep `email_events` **provider-global (no `tenant_id`, no RLS)**, faithful to its column definition and its writer's auth model, and FORCE-RLS only the two tables that actually carry `tenant_id`. The one consequence: the bounce/complaint → `outbox.lastError` linkage the spec sketches *inside the webhook* moves into the worker's per-tenant **reconcile pass** (Task 4), because only a tenant context can touch the RLS-protected outbox. Delivery feedback is never lost — it is applied one worker tick later. (A secondary, smaller elaboration: a `next_attempt_at` column beyond the spec's outbox column list, because "exponential backoff" needs a scheduling gate to claim on.)

**Type consistency:** `EmailMessage`/`ParsedEmailEvent`/`RawWebhook` (Task 2) are the exact shapes `notify`'s enqueue feeds (Task 3), the worker's `send` consumes (Task 4), and the webhook's `parseWebhook` produces (Task 5). `NotificationType`/`NotificationSeverity` (Task 1) flow unchanged through `NotifyEvent` (Task 3) and `ListNotificationsFilters` (Task 6). `EmailEventType` (Task 1) is the return type of every provider's `parseWebhook` and the `email_events.eventType` column. `getEmailProvider()` returns the single `EmailProvider` type that the worker (real Resend or `FakeEmailProvider`) and the webhook both depend on — the swappability guarantee: no call site names a concrete provider. The worker's audit call reuses Spec 4's `AuditContext`/`recordAuditEvent` signature verbatim, so it compiles the moment the sibling audit module is on the branch.

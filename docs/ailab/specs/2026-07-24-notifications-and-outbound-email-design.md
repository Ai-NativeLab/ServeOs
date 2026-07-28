# ServeOS — Notifications & Outbound Email Design

**Date:** 2026-07-24
**Status:** Draft — pending review
**Scope:** Spec 5 of the core POS & operations roadmap (`docs/ROADMAP.md`) — **the comms foundation.** It introduces the first notification and outbound-email infrastructure ServeOS has ever had, behind an `EmailProvider` interface that mirrors the existing `BillingProvider`, with **Resend** as the first concrete implementation (locked decision **D7**). It has no dependency on the unwritten Specs 2/3 and can start immediately. It is a **prerequisite** for Spec 8/9 low-stock alerts and send-PO-to-supplier, and is consumed by Spec 2 (shift variance) and Spec 3 (refund notifications), plus Spec 4's tamper-alert.

## Context

There is **no email, SMS, WhatsApp, push, or in-app notification infrastructure anywhere in ServeOS today** (`docs/ROADMAP.md`, "Comms"). Nothing tells an owner a shift came up short, a stock item hit its reorder point, or a refund was issued; nothing can email a purchase order to a supplier. Every downstream spec that wants to *reach a human* has been waiting on a layer that does not exist. This spec builds it once, generically, so Specs 3, 4, 8, and 9 register events against it rather than each inventing their own send path.

The one piece of prior art worth mirroring is `BillingProvider` (`src/server/billing/provider.ts`): a tiny `interface` (`readonly name` + a couple of async methods), one concrete implementation behind it (`ManualBillingProvider`), and a clean `index.ts` re-export. Spec 6 already reused that exact shape for `PaymentGateway`. The email layer takes the same shape.

## Problem

Two things are missing and they are different problems. First, an **operational feed**: staff and owners need to *see* that something happened — a low-stock warning, a variance, a refund — in the app, without an inbox. Second, **outbound transactional email**: a PO must actually leave ServeOS and land in a supplier's mailbox, and an alert must reach an owner who isn't looking at the dashboard. Email is the hard half — it needs a verified sending domain, DNS records for deliverability, a provider that won't land us in spam, retry/idempotency so a transient failure neither drops nor double-sends a PO, and delivery/bounce feedback so we know a supplier's address is dead. Building an SMTP server to do this ourselves is a deliverability and ops liability; we use a hosted provider.

## Goal

A single `notify(ctx, {type, targets, channels, payload})` entry point that any domain event calls. It writes an in-app `notifications` row for each targeted user/role **and** — for the `email` channel — enqueues a `notification_outbox` row. An **outbox worker** (scheduled) drains the queue through an `EmailProvider` with retry, exponential backoff, and per-row idempotency so a PO is never double-sent. The provider's delivery webhooks land in `email_events` (delivered / bounced / complained / opened), deduped. Notifications are tenant-scoped (FORCE RLS); a user reads their own plus role-targeted ones. Sending is a **system action** — no user permission gates it. Every send emits a Spec 4 audit event.

## Decisions (locked)

Inherited from the roadmap (`docs/ROADMAP.md`, decision **D7**) and binding here.

| Decision | Choice |
|---|---|
| Provider (D7) | **Resend first**, behind an `EmailProvider` interface shaped like `BillingProvider`. Hosted HTTP API — **no self-hosted SMTP server**. Free tier (3,000/mo, 100/day) comfortably covers POs + alerts at MVP volume. |
| Alternatives | **Brevo** (free-forever ~300/day, and offers an **SMTP relay** for tenants who prefer SMTP) and **Amazon SES** (cheapest at scale, but starts in a sandbox and is heavier to set up) are expressible on the *identical* interface. Provider is swappable via env/config; no call site knows which one is active. |
| Notification model | **Channels behind a `NotificationProvider` concept.** In-app + email ship now. SMS / WhatsApp / push are future channels on the same interface (Non-goal here). |
| Sending identity | **From** the verified platform domain (`no-reply@mail.serveos.com`); **Reply-To** set to the tenant/branch email, so a supplier replying to a PO reaches the *restaurant*, not the platform. Per-tenant sending domains are a future enhancement. |
| Delivery durability | **Store-and-forward via `notification_outbox`.** `notify` never calls the provider inline; a scheduled worker does, with retry + backoff + idempotency. A slow or down provider never blocks the domain transaction. |
| Idempotency | **One outbox row = at most one provider send.** A `providerMessageId` is recorded before the row flips to `sent`; a worker crash mid-send cannot produce a second email for the same row. |
| Auth model | **Notifications tenant-scoped (FORCE RLS), read own + role-targeted. Sending has no user permission** — it is a system action initiated by domain events, exactly as `placeOrder` needs none. The webhook is signature-authenticated, not RBAC-authenticated. |

## Non-goals (deferred by explicit decision)

- **SMS / WhatsApp / push channels** → future work on the same `NotificationProvider` interface; the `channel` enum and `notify(channels: [...])` shape leave room, but no transport is built here.
- **Per-tenant custom sending domains** (a tenant sending as `orders@theirrestaurant.com`) → future. v1 sends from the platform domain with tenant Reply-To.
- **The low-stock / reorder alert *logic*** (thresholds, reorder points, draft-PO pre-fill) → **Spec 8/9**; they *call* `notify` with `low_stock` / `reorder_suggested`. This spec only defines the types and the delivery mechanism.
- **The send-PO-to-supplier *rendering*** (PO PDF/HTML, line formatting) → **Spec 9**; it hands `notify` a rendered `payload` + attachment reference. The transport is here; the document is there.
- **Shift-variance and reconciliation-exception detection** → **Spec 2 / Spec 7**; **refund receipts** → **Spec 3**; **tamper-break alerts** → consume Spec 4's verifier finding. Each emits its own `notify` call.
- **Marketing / campaign email, customer order-status email, unsubscribe/preference center** → out of scope; this is internal transactional/operational comms only.
- **A rich notification-center UI** → a minimal feed + mark-read API ships here; the polished surface is a later dashboard iteration.

## Data model

Three new tenant-scoped tables (`FORCE ROW LEVEL SECURITY`), plus one small addition to hold the Reply-To address. The RLS policy mirrors every other tenant table: `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` with the matching `WITH CHECK`, scoped by `withTenant` (`src/db/with-tenant.ts`).

**A note on Reply-To source.** `tenants` (`src/server/tenancy/schema.ts`) has **no email field today**, and `branches` (`src/server/branches/schema.ts`) has `phone` but **no email**. This spec adds a nullable `reply_to_email` to `branches` (branch-level supplier correspondence) and a fallback `contact_email` on `tenants` (or in `tenant_settings.data`); a `notify` for a branch PO uses the branch address, else the tenant fallback, else omits Reply-To.

### New: `notifications`

The in-app feed. One row per (target, event). Read by the dashboard; never emailed directly (email goes through `notification_outbox`).

| Column | Notes |
|---|---|
| `id` | uuid, pk |
| `tenantId` | uuid → `tenants.id`, not null; RLS key |
| `userId` | uuid → `users.id`, **nullable** — a specific recipient. Null = role-targeted (see `targetRole`) |
| `targetRole` | text, **nullable** — `owner` / `manager` / `staff` when the notification is role-broadcast rather than user-specific |
| `type` | enum `notification_type` (below) |
| `severity` | enum `notification_severity`: `info \| warning \| critical` |
| `title` | text — short headline for the feed |
| `body` | text — human-readable detail |
| `entityType` | text, nullable — `purchase_order`, `shift`, `refund`, `stock_item`, … |
| `entityId` | text, nullable — the affected row's id (deep-link target) |
| `readAt` | timestamptz, nullable — null = unread |
| `createdAt` | timestamptz, default `now()` |

Read index on `(tenantId, userId, readAt)` and `(tenantId, targetRole, createdAt)`.

### New: `notification_outbox`

The email send queue — store-and-forward. `notify` inserts; the worker drains.

| Column | Notes |
|---|---|
| `id` | uuid, pk |
| `tenantId` | uuid → `tenants.id`, not null; RLS key |
| `toEmail` | text — resolved recipient address |
| `replyTo` | text, nullable — tenant/branch Reply-To (supplier replies route here) |
| `subject` | text |
| `template` | text — template key (`po_sent`, `low_stock_digest`, …) |
| `payload` | jsonb — template variables (+ attachment refs, e.g. the PO doc) |
| `status` | enum `outbox_status`: `queued \| sending \| sent \| failed` |
| `attempts` | int, default `0` — incremented each send try |
| `providerMessageId` | text, nullable — the provider's id, written **before** flipping to `sent` |
| `lastError` | text, nullable — last failure reason (for `failed`/retrying rows) |
| `createdAt` | timestamptz, default `now()` |
| `sentAt` | timestamptz, nullable |

Partial index on `(status, createdAt)` where `status IN ('queued','failed')` — the worker's claim query.

### New: `email_events`

Provider delivery feedback (webhooks), deduped. Append-only.

| Column | Notes |
|---|---|
| `id` | uuid, pk |
| `provider` | text — `"resend"` |
| `providerMessageId` | text — joins back to `notification_outbox.providerMessageId` |
| `providerEventId` | text — the provider's own delivery/event id |
| `eventType` | enum `email_event_type`: `delivered \| bounced \| complained \| opened` |
| `raw` | jsonb — verbatim webhook body, for forensics |
| `receivedAt` | timestamptz, default `now()` |

**Unique index on `(provider, providerEventId)`** — the dedupe key; a retried webhook delivery is a no-op second insert.

### Notification types (enum `notification_type`)

Forward-referenced by the specs that will raise them:

`low_stock` · `reorder_suggested` · `po_sent` · `po_received` · `shift_variance` · `reconciliation_exception` · `refund_issued`

The enum is defined here so those specs import a shared value rather than redefining it. (Spec 4's tamper-break alert can reuse `reconciliation_exception`-style `critical` severity or add its own value when it wires in.)

## Provider setup [what the owner must supply]

Identical across Resend / Brevo / SES — only the dashboard that generates the values differs. The owner (platform operator) must supply, **once**:

1. **A sending domain they control** — e.g. `mail.serveos.com` (a subdomain keeps the root domain's reputation isolated). This is the platform's domain, not the tenant's.
2. **Three DNS records for deliverability** — added to that domain, with the **exact values the provider generates**:
   - **SPF** — a TXT record authorizing the provider's servers to send as the domain.
   - **DKIM** — the provider's public-key record(s); the provider signs each message so receivers can verify it wasn't forged.
   - **DMARC** — a policy TXT record (`_dmarc`) telling receivers what to do with mail that fails SPF/DKIM, and where to send reports.
   Mail will send without these but will very likely land in spam; verification must be green before go-live.
3. **An API key in env** — `RESEND_API_KEY` (and `RESEND_WEBHOOK_SECRET` for signature verification). Selecting a different provider swaps the key name (`BREVO_API_KEY`, AWS credentials for SES) and an `EMAIL_PROVIDER` env value; **no application code changes.**

Every message sends **From** the verified platform domain (`no-reply@mail.serveos.com`) with **Reply-To** set to the tenant/branch address — so when a supplier hits reply on a PO, the message reaches the restaurant, not the platform's null mailbox. Per-tenant sending domains (a tenant verifying its own domain) are a future enhancement; the interface already carries `from`/`replyTo` so it slots in without a redesign.

## Authorization

- **Notifications are tenant-scoped, `FORCE ROW LEVEL SECURITY`.** All reads go through `withTenant(tenantId, tx => …)`. Within a tenant, the read query further filters to `userId = <me> OR targetRole = <my role>` so a staff user sees their own + staff-broadcast notifications but not another user's.
- **Sending has no user permission.** `notify` is called server-side from inside domain events (a PO being sent, a shift closing short); like `placeOrder` it needs no RBAC grant — the *action that triggers it* is already authorized. There is deliberately **no HTTP endpoint that injects a notification or enqueues an email** from the client; a postable outbox is a spam cannon.
- **The webhook is signature-authenticated, not RBAC-authenticated** — it carries no session; the provider's HMAC signature (verified in `parseWebhook`) is its authorization, exactly as Spec 6's gateway webhook.
- No new entry is added to `src/server/rbac/permissions.ts` for sending. (A future `notifications:manage` for admin/resend tooling is possible but not in v1.)

## API

- **`EmailProvider` interface** (`src/server/email/provider.ts`) — shaped like `BillingProvider`:
  ```
  export interface EmailProvider {
    readonly name: string;                                   // "resend"
    send(message: EmailMessage): Promise<{ providerMessageId: string }>;
    parseWebhook(req: RawWebhook): ParsedEmailEvent;         // verify signature + normalize
  }
  ```
  `EmailMessage` = `{ from, replyTo?, to, subject, template, payload, attachments? }`. `send` performs one HTTP call to the provider and returns its message id. `parseWebhook` is **pure** — verifies the HMAC signature, throws `WebhookSignatureError` on failure, else returns `{ provider, providerMessageId, providerEventId, eventType, raw }`. First concrete: `ResendEmailProvider`; `BrevoEmailProvider` / `SesEmailProvider` are future impls on the same contract. Re-exported from `src/server/email/index.ts`; the active provider is chosen once from `EMAIL_PROVIDER` env.
- **`notify(ctx, event)`** — **the core surface, not HTTP.** `notify(ctx: NotifyContext, event: { type, targets, channels, payload }): Promise<void>`. `targets` is a list of `{ userId }` or `{ role }`; `channels` ⊆ `['in_app','email']`. It writes the `notifications` row(s) and, for `email` targets, enqueues `notification_outbox` rows — **inside the caller's transaction** where one is passed, so a PO's "sent" state and its outbox row commit atomically.
- **`GET /api/dashboard/notifications`** — web dashboard (auth session resolves the tenant + user), via `withTenant`. Returns the caller's own + role-targeted notifications, newest first, with an `unreadCount`. Filterable by `type`/`severity`/`read`. (Matches the existing `src/app/api/dashboard/orders/route.ts` convention.)
- **`POST /api/dashboard/notifications/mark-read`** — body `{ ids?: string[] }` (omit = mark all read). Sets `readAt` for rows the caller is permitted to see. Idempotent.
- **`POST /api/notifications/webhook/:provider`** — the provider callback. Raw body → `parseWebhook` verifies signature → dedupe insert into `email_events` on `(provider, providerEventId)` → returns `200` even on a duplicate so the provider stops retrying; `400` only on signature failure. A `bounced`/`complained` event flips the matching outbox row's `lastError` for visibility.

## Architecture

`notify` is a cheap, synchronous DB write (it never touches the network); the provider call is deferred to a scheduled **outbox worker**, so a slow or down provider never blocks the sale, the PO, or the shift-close that triggered the notification.

```
  domain event (Spec 9 send-PO / Spec 8 low-stock / Spec 2 variance /
                Spec 3 refund / Spec 4 tamper-break)
        │  notify(ctx, { type, targets, channels:['in_app','email'], payload }, tx?)
        ▼
  ┌───────────────────────── notify() ─────────────────────────┐
  │  1. INSERT notifications  (one row per target)  ← in-app feed │
  │  2. for each email target: resolve toEmail + replyTo,         │
  │     INSERT notification_outbox (status='queued', attempts=0)  │
  └───────────────────────────────────────────────────────────────┘
        │  (commits with the caller's tx — atomic with the event)
        ▼
  ┌──────────────── outbox worker (cron / scheduled) ────────────────┐
  │  claim queued|failed rows (SKIP LOCKED, backoff-eligible only)    │
  │  status → 'sending'                                              │
  │  provider.send(message) ──► EmailProvider (Resend HTTP API)      │
  │  on ok:  record providerMessageId, status → 'sent', sentAt=now   │
  │  on err: attempts++, lastError, status → 'failed'                │
  │          (retry with exponential backoff; give up after N)       │
  │  recordAuditEvent(ctx, 'notification.email.sent', tx)  ← Spec 4  │
  └──────────────────────────────────────────────────────────────────┘
        │                                            ▲
        ▼                                            │ delivery feedback
  Resend / Brevo / SES  ──── webhook ───►  POST /api/notifications/webhook/:provider
                                            parseWebhook (verify sig) →
                                            dedupe INSERT email_events
                                            (delivered | bounced | complained | opened)
```

**Idempotency (never double-send).** The worker claims a row and flips it to `sending` in one statement (`SELECT … FOR UPDATE SKIP LOCKED`), so two worker instances never grab the same row. `send` returns a `providerMessageId` that is written **before** the row goes `sent`; if the worker crashes after the provider accepted the message but before the DB commit, the row is still `sending`/`failed` — a reclaim re-sends, which for a PO would double-email. To close that window, the worker passes a provider **idempotency key** (the outbox row `id`) on `send` so the provider itself deduplicates a retried identical request. Rows exhausting the retry budget stay `failed` with `lastError` and surface in the feed as a `critical` notification to the owner.

**Provider swappability.** Every call site depends only on `EmailProvider`; the concrete class is resolved once at startup from `EMAIL_PROVIDER`. Swapping Resend → Brevo → SES is an env change plus DNS re-verification on the new provider — no code path, no table, and no `notify` caller changes. Brevo additionally exposes an SMTP relay for a tenant who insists on SMTP, but the default remains the HTTP API on all three.

## Error handling / edge cases

- **Provider down / timeout:** the domain transaction already committed (row is `queued`); the worker retries with exponential backoff. The PO's own state is unaffected — "sent to supplier" means *enqueued*, and the feed shows delivery status once the webhook lands.
- **Transient send failure:** `attempts++`, `status='failed'`, `lastError` recorded; the worker's next pass retries eligible rows until the budget is spent, then leaves it `failed` and raises a `critical` in-app notification.
- **Duplicate webhook delivery:** the `(provider, providerEventId)` unique index makes the second insert a no-op; delivery state is never double-counted.
- **Bounce / complaint:** stored in `email_events`; the matching outbox row's `lastError` is set and an owner notification is raised so a dead supplier address gets fixed. (An auto-suppression list is future work.)
- **No Reply-To available** (branch and tenant both lack an email): send with Reply-To omitted rather than blocking; the message still goes From the platform domain. Log it so the owner is prompted to add a contact address.
- **Missing DNS / unverified domain at deploy:** the provider will reject or spam-file sends; the worker surfaces the provider error in `lastError` and the setup is flagged. Sending is disabled cleanly (rows stay `queued`) until verification is green, rather than blasting undeliverable mail.
- **Signature verification fails on webhook:** return `400`, do **not** insert; a forged delivery event cannot poison `email_events`.
- **In-app-only notification** (`channels:['in_app']`, e.g. a low-severity FYI): no outbox row is written; nothing is emailed.
- **Worker never runs / backlog:** rows accumulate as `queued` (durable); when the worker resumes it drains oldest-first. Nothing is lost.

## Testing

- **Unit (pure):** `parseWebhook` verifies a good signature and rejects a tampered body (`WebhookSignatureError`); event normalization maps each provider event to `delivered/bounced/complained/opened`; template + payload render to the expected subject/body; Reply-To resolution picks branch → tenant → omitted in that order.
- **Server (Vitest):** `notify` writes the right `notifications` rows and enqueues `notification_outbox` only for `email` targets, inside the caller's tx (rolls back with it); RLS hides one tenant's notifications from another and a user sees only own + role-targeted; the outbox worker claims a row (`SKIP LOCKED`), calls a stubbed `EmailProvider`, records `providerMessageId`, flips to `sent`, and **never sends the same row twice** across concurrent workers or a simulated mid-send crash; retry/backoff advances `attempts` and gives up after N; the webhook route dedupes on `(provider, providerEventId)` and returns `200` for a duplicate, `400` for a bad signature; a send emits the Spec 4 audit event.
- **Renderer:** the dashboard notification feed lists, filters, shows `unreadCount`, and mark-read (single + all) clears the badge; a `critical` notification is visually distinct.
- **Manual acceptance:** configure `RESEND_API_KEY` + a verified `mail.serveos.com`; trigger a test `po_sent` `notify` → an in-app row appears and a real email arrives From the platform domain with Reply-To = the branch address; reply to it → it reaches the branch mailbox; Resend's webhook flips the outbox row and adds a `delivered` `email_events` row; send to a known-bad address → a `bounced` event and an owner alert.

## Roadmap

- **Spec 8 — Inventory Core + Recipes:** the scheduled low-stock check calls `notify` with `low_stock` / `reorder_suggested`, targeting `owner`+`manager`, `warning` severity.
- **Spec 9 — Suppliers & Purchasing:** send-PO-to-supplier renders the PO and calls `notify({ type:'po_sent', channels:['in_app','email'], payload:{…, attachments } })`; receiving raises `po_received`.
- **Spec 2 — Shifts & Cash Drawer:** a short/over close raises `shift_variance`.
- **Spec 3 — Refunds:** issuing a refund raises `refund_issued` (and, later, a customer refund receipt when customer email is in scope).
- **Spec 7 — Reconciliation:** unmatched settlement / exception rows raise `reconciliation_exception`.
- **Spec 4 — Audit:** the chain verifier's break finding becomes a `critical` alert through this layer instead of only logging.
- **Future channels:** add `SmsProvider` / `WhatsAppProvider` / push on the same `NotificationProvider` interface; extend the `channel` enum and let `notify(channels:[…])` fan out — no change to existing callers. Per-tenant sending domains and a customer preference/unsubscribe center follow.

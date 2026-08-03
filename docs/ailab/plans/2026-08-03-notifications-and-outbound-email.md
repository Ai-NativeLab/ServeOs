# Notifications & Outbound Email — Implementation Plan

> Implements `docs/ailab/specs/2026-07-24-notifications-and-outbound-email-design.md`
> (Spec 5, decision D7). Issue #48. TDD task-by-task; checkboxes track progress.

**Goal:** one `notify()` entry point any domain event calls. In-app rows land in a
tenant-scoped feed; email targets enqueue into a store-and-forward outbox drained by a
scheduled worker through an `EmailProvider` (Resend first) with retry, backoff and
at-most-once sends. Delivery webhooks dedupe into `email_events`.

**Grounded against the real codebase (verified 2026-08-03):**
- `BillingProvider` (`src/server/billing/provider.ts`) is the interface shape to mirror.
- `AuditActorType` includes `"system"` (`src/server/audit/canonical.ts:5`) — worker sends audit as system.
- Dashboard API convention: `src/app/api/dashboard/orders/route.ts` (permission helper → service → JSON).
- Role→users resolution goes through `roles`/`userRoles` (`src/server/auth/schema.ts`); `users.email` is nullable.
- `vercel.json` has no crons today; the worker route is Vercel-Cron triggered, `CRON_SECRET`-gated.
- Next migration index: **0026**.
- Webhook signature: Resend delivers via **Svix** — HMAC-SHA256 over `"{svix-id}.{svix-timestamp}.{raw body}"`,
  secret is base64 after the `whsec_` prefix, compare in constant time, reject stale timestamps.

**Deliberate deviations from the spec (each noted in its task):**
- `notification_outbox` gains `nextAttemptAt` — backoff eligibility needs a timestamp the
  spec's column list lacks; computing it from `attempts` alone can't survive a restart.
- `email_events` stays **control-plane** (no tenantId, no RLS) exactly as the spec's column
  list implies — it is keyed by provider ids, like the webhook side of Spec 6.

## Global constraints
- Every tenant-scoped read/write inside `withTenant`; RLS blocks appended by hand to the
  generated migration (`drizzle/0019_*.sql:65-79` pattern) for `notifications` + `notification_outbox`.
- `notify` NEVER touches the network. The worker NEVER runs inside a domain transaction.
- No HTTP endpoint enqueues email from a client. The webhook authenticates by signature only.
- After the migration: `npm run db:migrate && npm run db:migrate:test && npm run db:check`.
- `npx tsc --noEmit` + eslint clean before every commit.

---

## Task 1: Schema + migration 0026
**Create** `src/server/notifications/schema.ts`; **modify** `src/db/schema.ts`,
`src/server/branches/schema.ts` (+`replyToEmail`), `src/server/tenancy/schema.ts` (+`contactEmail`).
**Test** `src/server/notifications/schema.test.ts`.

- Enums: `notification_type` (`low_stock, reorder_suggested, po_sent, po_received, shift_variance, reconciliation_exception, refund_issued, system_alert`),
  `notification_severity` (`info,warning,critical`), `outbox_status` (`queued,sending,sent,failed`),
  `email_event_type` (`delivered,bounced,complained,opened`).
- Tables per spec §Data model. `notifications`: userId nullable XOR targetRole nullable (CHECK — at least one set).
  Outbox partial index `(status, next_attempt_at)` WHERE status IN ('queued','failed').
  `email_events` unique `(provider, provider_event_id)`.
- Tests: RLS isolation on `notifications` (tenant B sees nothing); email_events dedupe unique index;
  outbox insert defaults (`queued`, attempts 0).
- Commit: `feat(notifications): notifications/outbox/email_events schema with FORCE RLS`

## Task 2: EmailProvider + Resend + fake + webhook parsing
**Create** `src/server/email/provider.ts`, `resend-provider.ts`, `fake-provider.ts`,
`webhook.ts` (Svix verification, pure), `index.ts` (env-selected singleton).
**Test** `fake-provider.test.ts`, `webhook.test.ts`.

```ts
export type EmailMessage = { from: string; replyTo?: string; to: string; subject: string;
  html: string; idempotencyKey: string };
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}
export type ParsedEmailEvent = { provider: string; providerMessageId: string;
  providerEventId: string; eventType: EmailEventType; raw: Record<string, unknown> };
// verifySvixSignature(rawBody, headers, secret): boolean  — fail-closed, never throws
// parseResendWebhook(rawBody, headers, secret): ParsedEmailEvent  — throws WebhookSignatureError
```
- Fake records `sent[]`, returns deterministic ids, honors `failNext` for retry tests.
- Tests mirror `whatsapp/signature.test.ts` discipline: good sig accepted, tampered body rejected,
  malformed headers fail closed, stale timestamp rejected, event types normalized.
- Commit: `feat(email): EmailProvider interface, Resend impl, fake, fail-closed Svix verification`

## Task 3: notify() + NotificationChannel (the #63 unblocker)
**Create** `src/server/notifications/service.ts`, `channels.ts`; **modify** audit coverage.
**Test** `service.test.ts`.

```ts
export type NotifyTarget = { userId: string } | { role: "owner" | "manager" | "staff" };
export type NotifyChannel = "in_app" | "email";
export type NotifyEvent = { type: NotificationType; severity: NotificationSeverity;
  title: string; body: string; entityType?: string; entityId?: string;
  targets: NotifyTarget[]; channels: NotifyChannel[]; emailTemplate?: string;
  emailPayload?: Record<string, unknown>; branchId?: string };
export async function notify(ctx: { tenantId: string }, event: NotifyEvent, tx?: Tx): Promise<void>;

/** THE NotificationProvider surface downstream channels implement (WhatsApp P3, SMS, push).
 *  A channel materializes one NotifyEvent for one resolved target. in_app and email are
 *  the two built-ins; registration is a map, not a conditional. */
export interface NotificationChannel {
  readonly key: NotifyChannel;
  deliver(tx: Tx, ctx: { tenantId: string }, event: NotifyEvent, target: ResolvedTarget): Promise<void>;
}
```
- Target resolution: `{userId}` → that user; `{role}` → all active tenant users holding the role
  (join `userRoles`×`roles`); email channel skips users with null email (log, don't fail).
- Reply-To: `branches.replyToEmail` (when `event.branchId`) → `tenants.contactEmail` → omitted.
- In-app: ONE row per target entry (role rows stored with `targetRole`, not fanned out).
  Email: one outbox row per resolved recipient.
- Runs on the caller's `tx` when given (atomic with the domain event), else opens `withTenant`.
- Tests: in-app row shapes; email-only targets enqueue outbox rows; role fan-out to emails;
  rollback with caller's tx; RLS isolation; null-email skip.
- Commit: `feat(notifications): notify() with channel registry, role fan-out and Reply-To resolution`

## Task 4: Outbox worker
**Create** `src/server/notifications/worker.ts`; register in audit coverage.
**Test** `worker.test.ts` (FakeEmailProvider).

- `drainOutbox(provider, { limit = 20 })`: per tenant-agnostic pass — claim rows
  `FOR UPDATE SKIP LOCKED` where `status IN ('queued','failed') AND next_attempt_at <= now()
  AND attempts < MAX_ATTEMPTS (5)`, flip to `sending` in the claim UPDATE.
- Send with `idempotencyKey = row.id`; on ok write `providerMessageId` BEFORE `sent` flip;
  on error `attempts++`, `lastError`, `status='failed'`, `nextAttemptAt = now + 2^attempts × 30s`.
- Budget exhausted → stays `failed` + a `critical` in-app `notify` to `owner` (`system_alert`).
- Audit `notification.email.sent` per successful send, actorType `system`, `emptyFingerprint()`.
- Tests: happy path; concurrent drains never double-send (two parallel drains, fake counts sends);
  crash window (providerMessageId written, row still `sending` → reclaim does NOT resend when
  providerMessageId present — flips to sent); backoff advances; give-up raises the owner alert.
- Commit: `feat(notifications): SKIP LOCKED outbox worker with backoff and at-most-once sends`

## Task 5: HTTP surface + cron
**Create** `src/app/api/dashboard/notifications/route.ts` (GET feed + unreadCount),
`.../notifications/mark-read/route.ts`, `src/app/api/notifications/webhook/[provider]/route.ts`,
`src/app/api/notifications/worker/route.ts`; **modify** `vercel.json` (crons).

- Feed: session → own + role-targeted, newest first, `?unread=1&type=&severity=` filters.
- mark-read: `{ids?: string[]}`, only rows the caller may see, idempotent.
- Webhook: raw body → parse/verify → dedupe insert (`onConflictDoNothing`) → bounce/complaint
  sets outbox `lastError` + owner alert; 200 on duplicate, 400 only on bad signature.
- Worker route: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron) → `drainOutbox`.
  `vercel.json` crons: `*/5 * * * *`.
- Commit: `feat(notifications): feed + mark-read + provider webhook + cron-driven worker route`

## Task 6: Dashboard bell + feed (minimal, on brand tokens)
**Create** `src/app/dashboard/notifications/page.tsx`, bell in the dashboard Topbar with
`unreadCount` badge; severity-tinted rows (`critical` uses the error tokens); mark-all-read.
- Verify with `npm run build`; keep to existing `Card`/`EmptyState`/`eyebrow` conventions.
- Commit: `feat(notifications): dashboard feed with unread badge and mark-read`

## Task 7: Verification + PR
- `npm run test` + `tsc` + eslint + `next build`; PR closes #48; body flags the DNS/env
  go-live gates (RESEND_API_KEY, RESEND_WEBHOOK_SECRET, CRON_SECRET, SPF/DKIM/DMARC on
  `mail.serveos.com`) and notes #63 is now implementable against `NotificationChannel`.

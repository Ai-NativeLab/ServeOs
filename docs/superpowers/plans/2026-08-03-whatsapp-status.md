# WhatsApp Phase 3 — Outbound Order Status (Implementation Plan)

> Issue #63 · Spec §11, decision D7 · unblocked by Spec 5 (PR #96).
> Phase 3 was deliberately unplanned until the notification surface existed;
> this plan is grounded against what Phases 1–2 and Spec 5 actually shipped.

**Goal:** a customer who ordered through WhatsApp gets proactive status
messages — confirmed / ready / out for delivery — on the same conversation.

**Design (v1 scope, recorded on the issue):**
- **Recipients are customers, not tenant users**, so this does NOT ride
  `notify()`'s target model. It follows Spec 5's *discipline* instead: a
  store-and-forward queue drained by the scheduled worker, never a network
  call inside the domain transaction.
- **Free-window only in v1.** A status message inside the 24h
  customer-service window (tracked as `whatsapp_conversations.lastInboundAt`)
  costs nothing. Outside it Meta requires a per-tenant approved utility
  template — that approval pipeline is real per-WABA state and ships as a
  follow-up; v1 marks those rows `skipped/template_required` rather than
  pretending to send.
- The enqueue hook lives in `transitionStatus` on the caller's tx — ordering
  already knows `channel === 'whatsapp'`; the row commits atomically with the
  status change it announces.

## Task 1 — `whatsapp_status_queue` + enqueue hook (migration 0027)
- Table (FORCE RLS): id, tenantId, orderId FK, waId, body, status
  `queued|sent|skipped|failed`, skipReason, attempts, nextAttemptAt, wamid,
  createdAt, sentAt. Claim index `(status, next_attempt_at)`.
- Hook in `transitionStatus`: `channel='whatsapp'` and `to ∈ {confirmed, ready,
  out_for_delivery}` → insert queue row (body from a small copy table keyed by
  status + orderNumber). waId = `orders.customerPhone` minus the leading `+`.
- Tests: transition on a whatsapp order enqueues exactly one row per matching
  status; web/pos orders never enqueue; rollback takes the row with it.

## Task 2 — `drainWhatsappStatus(provider)` worker
- Same discipline as the email worker: iterate tenants, claim
  FOR UPDATE SKIP LOCKED + stall deadline, attempts < 3, backoff 2^n × 30s.
- Per row: resolve the tenant's ACTIVE whatsapp account (Phase 1 routing) —
  none ⇒ `skipped/account_unlinked`. Conversation `lastInboundAt` older than
  24h (or missing) ⇒ `skipped/template_required`. Else `provider.send` text,
  record wamid on the row AND log direction='outbound' in `whatsapp_messages`,
  audit `whatsapp.status_sent` as system.
- Tests: happy path, window-expiry skip, unlinked skip, backoff, no double
  send across concurrent drains.

## Task 3 — delivery statuses close the loop
- `ingest.ts` finally consumes `parsed.statuses` (the Phase 2 TODO): update
  `whatsapp_messages.deliveryStatus` by providerMessageId, per tenant.
- Test: a `delivered` status callback lands on the logged outbound row.

## Task 4 — cron wiring + verification + PR
- `/api/notifications/worker` drains BOTH queues (one scheduled tick, two
  outboxes). Full suite, tsc, eslint, build; PR closes #63; follow-up issue
  filed for out-of-window utility templates (per-tenant approval state).

# Realtime propagation — setup & operations

Per-tenant Supabase Realtime broadcast: the server announces what changed, the
dashboard/storefront/POS refetch on the signal instead of waiting for their
next poll. Design: `docs/moai/specs/2026-08-09-pos-offline-sync-design.md`
(§Propagation).

**It is off until the two setup steps below are done, and off is safe.** With
no configuration the publisher no-ops, no subscriber opens a socket, and every
screen keeps the polling cadence it has today. Nothing degrades; it just
doesn't accelerate.

## What travels

| | |
|---|---|
| Topic | `tenant:{tenantId}` — one per tenant, **private** |
| Events | `orders.changed`, `sync.applied`, `stock.changed` |
| Payload | `{ entityIds: string[] }` — **ids only, never data** |
| Publisher | `src/server/realtime/publish.ts`, service-role REST, after commit |
| Subscribers | dashboard orders + payments + inventory, storefront status page, POS queue |

A subscriber treats a broadcast as "ask again", never as data: it refetches
through the same authenticated endpoint it already polls, so RLS and
permission checks apply exactly as before. Nothing a broadcast says can put a
row on a screen that the endpoint would not have returned anyway.

## Step 1 — environment variables

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | server (already set for storage) | broadcast endpoint |
| `SUPABASE_SERVICE_ROLE_KEY` | server (already set for storage) | authorizes publishing |
| `SUPABASE_JWT_SECRET` | server | signs each subscriber's tenant-scoped token |
| `NEXT_PUBLIC_SUPABASE_URL` | client | socket host |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client | socket apikey |

`SUPABASE_JWT_SECRET` is the project's **JWT Secret** (Supabase dashboard →
Project Settings → API/JWT Keys → legacy JWT secret). It must be the HS256
secret that project's Realtime verifies tokens with. If the project has been
migrated to asymmetric signing keys and the legacy secret disabled, this
mechanism will not authorize and the tokens must be re-issued with the new
key type instead — check before rollout rather than after.

Set them per environment (prod and QA are different Supabase projects, so the
JWT secret differs too).

## Step 2 — the topic authorization policy

The platform does not use Supabase Auth, so a browser or till arrives with no
identity of its own. `src/server/realtime/token.ts` mints a short-lived HS256
token carrying `role: authenticated` and `tenant_id`, from a session or paired
device the server already authenticated; this policy is what turns that claim
into permission to join one topic. Run once per Supabase project, in the SQL
editor:

```sql
-- Listening on tenant:{uuid} requires a token whose tenant_id IS that uuid.
create policy "tenant topic listen"
on realtime.messages
for select
to authenticated
using (
  extension = 'broadcast'
  and realtime.topic() = 'tenant:' || ((select auth.jwt()) ->> 'tenant_id')
);
```

Deliberately **no INSERT policy**: no client may publish. Broadcasting stays
with the service role, which no browser or till ever holds, so a tenant event
cannot be forged by anyone holding the anon key.

This lives here rather than in a Drizzle migration on purpose — `realtime` is
Supabase's own schema, and local development runs against a plain Postgres
that has no such schema to migrate.

## Verifying it works

1. Two browsers, same tenant: open `/dashboard/orders` in one, place an order
   from the storefront in the other. The row should appear in ~1s, not on the
   8s poll. With realtime off it takes up to 8s — that is the difference to
   look for.
2. Confirm a payment in one dashboard tab; a second tab on
   `/dashboard/payments` should drop the row without a reload.
3. Storefront `/order/{token}` open; move the order from the dashboard. The
   step list should advance in ~1s instead of on its 5s poll.
4. POS: with the till running and online, place a storefront order — it should
   land in the queue in ~1s rather than on its 8s poll.
5. Devtools → Network → WS: exactly one socket per tab, and it should stay
   open. A socket that reconnects in a loop means the policy or the token is
   wrong; the screens keep working at their normal cadence while you fix it.

## Operating notes

- **Connection budget.** Every open dashboard tab, every storefront status
  page, and every till holds one Realtime connection. Supabase's Free plan
  caps concurrent connections (200 at the time of writing) and Pro raises it —
  check the plan's cap against `tills + staff tabs + concurrent customers
  watching an order` before enabling this in production. Exceeding the cap
  does not break the platform: connections are refused, `live` stays false,
  and those clients keep polling.
- **Polling is still the guarantee.** Each subscriber relaxes its poll to 60s
  *only while its channel is actually joined*, and reverts the moment it is
  not. An outage, a bad policy, a missing env var, or an expired token can
  therefore never make a screen slower than it is today.
- **Tokens last 8 hours.** A tab open longer than that loses its channel and
  falls back to normal polling until the next navigation mints a new one. The
  POS re-fetches its own config on every reconnect, so a till heals itself.
- **Broadcast cost.** Publishing is an awaited HTTP call on the writing
  request, capped at 2s and swallowed on failure. Sync ingest publishes once
  per batch, not once per event, so a reconnecting till with a long queue pays
  for one broadcast.

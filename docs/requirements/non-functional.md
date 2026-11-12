# Non-Functional Requirements

Architectural qualities and the mechanisms that deliver them. Items marked **target** are goals, not measured results; nothing in the repo currently measures them.

---

## 1. Performance (targets)

| Surface | Target |
| :--- | :--- |
| Storefront | TTFB p95 < 200 ms, LCP p95 < 1.5 s |
| Dashboard | page load p95 < 500 ms, Server Action p95 < 300 ms |
| POS sale / tender routes | p99 < 100 ms server time |

These are targets only: there is no load test, RUM or latency SLO monitoring in the codebase.

Mechanisms that exist:
- The app uses a single lazily created `pg` pool per server instance (`src/db/client.ts`); in production it connects through the Supabase transaction pooler (port 6543 — see `docs/references/environments.md`).
- `GET /api/health` never touches the database, so a liveness probe stays cheap.

### POS offline tolerance
The till keeps working through a network outage:
- **Local store:** a `better-sqlite3` database in the Electron main process (`apps/pos/electron/_offline/`) caches the catalog, pricing, shift policy and the sign-in roster, and records every action as an event.
- **Replay:** queued events are sent in batches of at most **50** to `POST /api/pos/v1/sync/events`. Each event is idempotent on its `eventId` (`pos_sync_event_receipts`); replayed sales never fail for stock or price drift — drift is recorded in the audit chain instead.

---

## 2. Security & data isolation

### Row-Level Security
- 52 tenant tables have `ENABLE` **and** `FORCE ROW LEVEL SECURITY` with an isolation policy on `app.tenant_id`; 20 control-plane tables (tenants, users/sessions/roles, plans/subscriptions/invoices, POS device and session plumbing, idempotency receipts, email events, enquiries, `whatsapp_accounts`, `audit_logs`) have no RLS. Full list: [tables.md](../database/tables.md).
- `withTenant(tenantId, fn)` (`src/db/with-tenant.ts`) runs `fn` in a transaction after `SELECT set_config('app.tenant_id', $1, true)`. Outside it, RLS tables return nothing.

### Database roles
RLS only binds a role that is not a superuser and lacks `BYPASSRLS`. A superuser **bypasses** RLS and sees every tenant's rows.
- **Production / QA:** the app and build-time migrations use the `app` role (`NOBYPASSRLS`); only the backup/restore workflows use `postgres` (`BYPASSRLS`). See `docs/references/environments.md`.
- **CI:** tests run as `serveos_ci`, created `NOSUPERUSER NOBYPASSRLS` by `scripts/ci-db-bootstrap.sql`.
- **Local:** `serveos_app`, created `NOSUPERUSER NOBYPASSRLS` per `docs/NEW-LAPTOP-SETUP.md`.

### Authentication

| Interface | Mechanism |
| :--- | :--- |
| Dashboard and admin console | `serveos_session` cookie (httpOnly, `SameSite=Lax`) holding an opaque random token that is the primary key of a `sessions` row. Not a JWT. Admin pages additionally require the `super_admin` role. |
| Storefront customers | `serveos_customer` cookie; 30-day customer sessions, validated against the storefront's tenant. |
| POS | Device bearer token from pairing (64 hex chars) + `X-POS-Cashier` token (12 h, stored hashed in `pos_cashier_sessions`). Manager grants: single-use, 2 minutes, stored hashed in `pos_grants`. |
| WhatsApp webhook | HMAC SHA-256 over the raw body (`x-hub-signature-256`). |
| Resend webhook | Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`). |
| Notifications worker | `Authorization: Bearer $CRON_SECRET`. |

Passwords (staff and customers) are hashed with **scrypt** (`src/server/auth/password.ts`).

### Audit trail
- `audit_events` is a per-tenant hash chain: `entry_hash = sha256(canonical(prev_hash, seq, tenant_id, actor_user_id, action, entity_type, entity_id, metadata, created_at))` (`src/server/audit/canonical.ts`). The head (`seq`, `head_hash`) lives in `audit_chain_heads`.
- A database trigger (`audit_events_no_mutate`, migration `0018`) rejects UPDATE and DELETE on `audit_events`.
- `GET /api/audit/chain/status` re-verifies the chain for a tenant.
- `src/server/audit/coverage.ts` lists the service files whose mutating functions must each emit an audit event; a guardrail test scans them. Some sensitive reads are audited too (e.g. the POS roster pull).

---

## 3. Concurrency control

| Concern | Mechanism | Where |
| :--- | :--- | :--- |
| Order numbers (per-tenant `max + 1`) | `pg_advisory_xact_lock(hashtext(tenant_id))` | `placeOrder`, `src/server/ordering/service.ts` |
| Audit chain head | the **same** per-tenant advisory lock (one lock order avoids deadlock); correctness rests on the unique `(tenant_id, seq)` index | `recordAuditEvent`, `src/server/audit/service.ts` |
| Purchase orders | `SELECT … FOR UPDATE` on the PO header before every status guard | `src/server/purchasing/service.ts`, `send.ts`, `variance.ts`, `receiving.ts` |
| Reorder sweep | `FOR UPDATE` on the `reorder_rules` rows it may stamp (no advisory key — see `src/server/purchasing/locking.ts`) | `src/server/purchasing/reorder.ts` |
| Held tickets | advisory lock per `(device, clientTicketId)` | `src/server/pos/held-tickets.ts` |
| One open shift per device | partial unique index `pos_shifts_device_open` on `device_id WHERE status = 'open'` | `src/server/pos/shift-schema.ts` |
| Order status changes | guarded `UPDATE … WHERE status = <expected>` | `transitionStatus`, `src/server/ordering/service.ts` |

---

## 4. Reliability & recovery

- **Hosting:** Vercel (two projects: `serve-os` for production from `main`, `serve-os-qa` from `qa`); Supabase Postgres in Frankfurt (separate prod and QA projects).
- **Migrations on deploy:** `vercel-build` runs `scripts/release-migrate.ts` before `next build` when `VERCEL_ENV=production`; a failed migration fails the build, so the new deployment never serves traffic. Preview builds skip it.
- **Deploy verification:** `.github/workflows/deploy-watch.yml` runs on every push to `main`/`qa` and fails if the push never becomes a deployment, never reaches READY, or never serves the pushed SHA on the domain (via `/api/health`).
- **Backups:** `.github/workflows/db-backup.yml` takes a nightly `pg_dump --format=custom` of prod and QA at 03:00 UTC to Cloudflare R2 (`serveos-backups`; daily kept 14 days, weekly 90 days). Media in Supabase Storage is **not** backed up (known gap).
- **Recovery:** nightly dumps bound data loss to roughly a day. The restore runbook and the quarterly restore drill (`db-restore-drill.yml`) are in `docs/references/backup-restore.md`. No RTO is defined.

---

## 5. Compliance

- **Egyptian Tax Authority (ETA) e-invoicing / e-receipts — planned, not implemented.** In scope as Spec 11 (roadmap decision D8). There is no ETA client, signing, QR generation or tax-code mapping in the code today.
- **Saudi ZATCA — planned, not implemented.** Only a high-level PRD exists (`docs/prds/prd-high-zatca-einvoicing.md`).
- **Audit coverage** (roadmap D1) is implemented as described in §2.

---

## 6. Internationalization

- English and Arabic copy throughout; catalog data has separate `*_en` / `*_ar` columns.
- **Marketing site:** Arabic is the default locale and keeps the bare `/` URL; English is under `/en` (`src/marketing-locale.ts`). The proxy sets the `x-locale` request header for marketing pages only, and the root layout uses it for `lang`/`dir`.
- **Tenants:** each tenant has a `default_locale` column (default `ar`).
- **Currency:** each tenant has a `currency` (default `EGP`); plan prices are in EGP.
- **Units:** inventory and dimensional products use the `unit_of_measure` enum (`each`, `g`, `kg`, `ml`, `l`, `m`, `m2`, `bf`) with fractional `numeric` quantities; sellable order-line quantities are integers.

---

## 7. Observability

- `GET /api/health` — DB-free liveness probe returning the deployed SHA.
- In-app notifications for operational events (`low_stock`, `reorder_suggested`, `po_sent`, `po_received`, `shift_variance`, `reconciliation_exception`, `refund_issued`, `system_alert`), plus email through the outbox.
- There is no APM, structured logging or metrics pipeline; errors go to `console.error` (Vercel logs).

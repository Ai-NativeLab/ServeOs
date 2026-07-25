# ServeOS — Audit & Fingerprint Log Design

**Date:** 2026-07-24
**Status:** Draft — pending review
**Scope:** Spec 4 of the core POS & operations roadmap (`docs/ROADMAP.md`). It builds the tenant-side operational audit trail mandated by locked decision **D1**: every mutating action — plus authentication events and sensitive reads/exports — lands an **append-only, hash-chained (tamper-evident)** row carrying a **device/session fingerprint**. Coverage is **system-wide** across every domain and every actor type, and it is **enforced** by a coverage-guardrail test that fails CI when a mutating surface ships without an audit emission. It has no dependency on the unwritten Specs 2/3 and can start immediately. The platform `audit_logs` table (`src/server/platform/audit.schema.ts`) is untouched and continues to serve super-admin actions; this spec adds a *separate*, tenant-scoped log alongside it.

## Context

Today there is exactly one audit surface: the platform `audit_logs` table, written **only** by super-admin control-plane actions. There is no tenant-side trail. When a cashier voids a `250 EGP` line, changes an order's status, an owner rewrites a menu price, a manager flips the VAT rate, a staff account's role is escalated, or someone opens a customer's phone number and address — nothing durable records *who*, *from which device*, *at what app version*, or *from what IP*, and nothing makes the record hard to alter after the fact.

Spec 1 (Sale & Tender) already gave us the two ingredients we need. `recordSale` (`src/server/pos/record-sale.ts:51`) writes an append-only discount/void trail (`pos_adjustment_events`) with `byUserId`/`authorizedByUserId`, and `placeOrder` (`src/server/ordering/service.ts:59`) already serializes a per-tenant sequence under `pg_advisory_xact_lock(hashtext(tenantId)::bigint)` for order numbers. This spec generalizes the "append-only, attributed, per-tenant-serialized" idea into one chain that spans **every** mutation, auth event, and sensitive read across the whole product — not just POS adjustments.

## Problem

An append-only trail that a database admin (or a compromised app) can silently `UPDATE` or `DELETE` is not evidence — it is a suggestion. `pos_adjustment_events` records *that* a discount happened, but a row can be edited or removed with no trace, and it says nothing about the terminal or the network the action came from. It also covers only POS money adjustments: a role escalation, a price rewrite, a settings change, a failed login streak, or someone exporting the customer list leaves no trace at all. For dispute resolution, staff-fraud investigation, incident response, and eventual compliance, ServeOS needs one log where (a) any post-hoc mutation is **detectable**, (b) every entry carries a **fingerprint** of the device and session that produced it, and (c) coverage is **complete and enforced** — no domain quietly opts out.

## Goal

One tenant-scoped log — `audit_events` — that **every** mutating write, **every** authentication event, and **every** sensitive read/export appends to **inside the acting transaction** (mutations) or at the surface that performs the action (auth, reads). Each row is linked to its predecessor by a SHA-256 hash chain, so removing or editing any row breaks every hash after it. Each row carries `{deviceId, deviceTokenHash, appVersion, ip, userAgent}`. A DB trigger makes `UPDATE`/`DELETE` fail outright, and a periodic verifier walks each tenant's chain and reports the first broken link. Reads are gated behind a new `audit:view` permission (owner + manager). Coverage spans **all domains** (ordering, POS, catalog, branches, settings/tenancy, auth, staff/RBAC, banners, subscription/billing, onboarding) and **all actor types** (staff, manager, owner, customer, system/automated), and is held complete by a **coverage-guardrail test** (see *Coverage guardrail*).

## Decisions (locked)

| Decision | Choice |
|---|---|
| Coverage | **System-wide and enforced.** Log (a) **every** mutation (create/update/delete/state-change) in **every** domain; (b) **auth events** — login, logout, failed login, password change, session/device revoke; (c) **sensitive reads/exports** — customer PII, financial/reconciliation reports, another cashier's sales, and any data export. **Ordinary reads, page views, and list loads are NOT logged.** A guardrail test (below) fails if a mutating service/route ships without an emission. |
| Actor types | **All of them:** staff, manager, owner, customer (storefront), system/automated. `actorType` is `user \| system \| device \| customer`; staff/manager/owner all record as `user` with the role captured in `metadata`. |
| Chain model | **Per-tenant hash chain.** `audit_chain_heads` holds `(tenantId, seq, headHash)`; each `audit_events` row carries `prevHash`/`entryHash`. |
| Atomicity | **`recordAuditEvent(ctx, {...}, tx)` runs in the same transaction as the mutation.** The audit row commits with the change or not at all. Auth/read emissions that have no surrounding data transaction open their own single-statement `withTenant` append. |
| Serialization | **Per-tenant advisory lock**, `pg_advisory_xact_lock(hashtext(tenantId)::bigint)` — the exact pattern `placeOrder` uses for order numbers. No global lock. |
| Hash | **`entryHash = sha256(canonical(prevHash, seq, tenantId, actorUserId, action, entityType, entityId, metadata, createdAt))`.** Genesis `prevHash` = 64 zeros. |
| Tamper-evidence | **A DB trigger raises on `UPDATE`/`DELETE`** of `audit_events`, **plus** a periodic verifier that walks each chain and reports the first break. |
| Fingerprint | **Captured at the API boundary, threaded through `ctx`.** POS sends a new `X-POS-App-Version` header; web/server-actions derive from session + `User-Agent` + IP. The device token is stored **hashed**, never raw. |
| Authorization | **New `audit:view` permission (owner + manager).** Reads go through `withTenant`. |
| Coexistence | **`audit_events` is tenant-scoped (FORCE RLS) and independent of the platform `audit_logs` table** (`src/server/platform/audit.schema.ts`), which stays for super-admin actions. The new system covers **tenant + user + customer + system** actions only; it never folds in or replaces the platform log, and vice-versa. |

## Non-goals (deferred by explicit decision)

- **Emitting refund, inventory-ledger, and purchase-order events** → those *entities* do not exist yet; their mutations ship in Specs 3 / 8 / 9, and when they land they **must** emit against this same helper. Coverage of them is not deferred as a *policy* — it is deferred only because the code does not exist — and the coverage guardrail (below) will fail those specs' PRs if they add a mutation without an emission.
- **Hash-anchoring the daily close** into the chain → Spec 7 (Reconciliation) will emit a `reconciliation.closed` event; the anchoring hook lives there.
- **Emailing a tamper alert** when the verifier finds a break → Spec 5 (Notifications & Outbound Email). Until then the verifier logs and surfaces status via the read API.
- **A rich log-viewer UI / CSV export of the audit log itself** → a minimal paginated read API ships here; the manager reporting surface is Spec 10. (Note: when Spec 10 adds *data export*, the export action itself emits `data.exported` — see *Coverage*.)
- **External log shipping / SIEM streaming, keystroke or behavioural logging, PII beyond the fingerprint.** Out of scope entirely.

## Coverage (system-wide)

This is the authoritative list of what emits. It is grounded in the exported mutating functions and boundary surfaces that exist **today**; forward references mark the mutations that arrive with later specs and are held by the guardrail.

### Action-name taxonomy

Action names are lower-`snake` segments in the shape **`domain.entity.verb`**, collapsing to **`domain.verb`** when the domain is itself the entity (e.g. `auth`, `settings`, `report`, `data`, `subscription`, `tenant`). One name = one kind of event.

Examples: `catalog.product.updated`, `catalog.product.price_changed`, `staff.role_changed`, `auth.login_failed`, `settings.vat_changed`, `report.financial_viewed`, `data.exported`, `order.status_changed`.

### Domain → actions (grounded)

| Domain (source) | Trigger (real symbol) | Action(s) |
|---|---|---|
| **Ordering** (`src/server/ordering/service.ts`) | `placeOrder:59` | `order.placed` (web → `customer`; POS → `user`) |
| | `transitionStatus:380` | `order.status_changed` (`metadata:{before,after,reason}`; restock noted when → `cancelled`/`rejected`) |
| | `markPaid:400` | `order.marked_paid` |
| | `cancelOrderByToken:301` | `order.cancelled` (actor `customer`; restock) |
| **POS** (`src/server/pos/*`) | `recordSale:51` (`record-sale.ts`) | `sale.recorded`; per `pos_adjustment_events` row → `discount.line_applied` / `discount.order_applied`, carrying `byUserId`/`authorizedByUserId` |
| | `addTender:195` (`record-sale.ts`) | `payment.tender_added` |
| | `signInCashier:41` (`cashier.ts`) | `auth.cashier_signed_in`; wrong password → `auth.login_failed` |
| | `verifyAuthorizer` → `issueGrant` (`grants.ts`, via `/api/pos/v1/authorize`) | `authz.manager_granted` (a manager authorizing a cashier's discount/void) |
| | `holdTicket:6` / `discardHeldTicket:40` (`held-tickets.ts`) | `ticket.held` / `ticket.discarded` (`listHeldTickets` is a read — not logged) |
| | `createPairingCode:33` / `redeemPairingCode:47` / `revokeDevice:162` (`service.ts`) | `device.pairing_created` / `device.paired` / `device.revoked` |
| | `loginForPos:90` (`service.ts`) | `device.paired` + `auth.login` / `auth.login_failed` |
| **Catalog** (`src/server/catalog/service.ts`, `variants.ts`) | `createCategory:51` / `updateCategory:58` / `deleteCategory:69` | `catalog.category.created` / `.updated` / `.deleted` |
| | `createProduct:117` / `updateProduct:128` / `deleteProduct:139` | `catalog.product.created` / `.updated` / `.deleted`; a price delta → `catalog.product.price_changed` (`{before,after}`) |
| | `upsertModifierGroup:158` / `deleteModifierGroup:182` | `catalog.modifier_group.upserted` / `.deleted` |
| | `upsertModifierOption:199` / `deleteModifierOption:217` | `catalog.modifier_option.upserted` / `.deleted` |
| | `setBranchAvailability:225` | `catalog.branch_availability.changed` |
| | `upsertVariant:31` / `deleteVariant:51` (`variants.ts`) | `catalog.variant.upserted` / `.deleted` |
| | `setVariantStock:58` / `setProductStock:65` (`variants.ts`) | `catalog.stock.set` (`{before,after}`) |
| **Branches** (`src/server/branches/service.ts`) | `createBranch:24` / `updateBranch:35` / `deleteBranch:43` | `branch.created` / `.updated` / `.deleted` |
| | `updateBranchOrdering:52` (accepting-orders + hours, via `settings/fulfillment/actions.ts`) | `branch.ordering_changed` |
| | `createDeliveryArea:79` / `updateDeliveryArea:86` / `deleteDeliveryArea:94` | `branch.delivery_area.created` / `.updated` / `.deleted` |
| **Settings / tenancy** (`src/server/tenancy/settings.ts`, `service.ts`) | `setVatRate:43` / `setVatEnabled:71` / `setPricesIncludeVat:75` | `settings.vat_changed` (`{before,after}`) |
| | `setServiceChargeRate:79` | `settings.service_charge_changed` |
| | `setWhatsappNumber:90` | `settings.whatsapp_changed` |
| | `updateTenantProfile:24` (`service.ts`; name/logo/color/tagline/cuisine/locale/tz) | `settings.profile_updated`; a theme field delta → `settings.theme_changed` |
| **Staff / RBAC** (`src/server/auth/staff.ts`) | `createStaff:36` | `staff.invited` (also sets the initial password → covers `auth.password_changed` for a new account) |
| | `setStaffRole:63` | `staff.role_changed` (`{before,after}`) |
| | `deactivateStaff:73` (also deletes the user's sessions) | `staff.deactivated` (+ implies session revoke) |
| **Auth** (`src/server/auth/session.ts`, `src/app/login`, `register`, `dashboard`) | `createSession:8` via `loginAction` | `auth.login`; wrong password in `loginAction` → `auth.login_failed` |
| | `createSession:8` via `registerAction` | `auth.login` (paired with `tenant.registered`) |
| | `invalidateSession:29` via `signOutAction` | `auth.logout` |
| **Banners** (`src/server/banners/service.ts`) | `createBanner:15` / `updateBanner:22` / `deleteBanner:30` | `banner.created` / `.updated` / `.deleted` |
| **Subscription** (`src/server/subscription/service.ts`, `tenancy/settings.ts`) | `startTrial:17` / `transition:28` | `subscription.trial_started` / `subscription.status_changed` |
| | `requestPlanUpgrade:97` (`settings.ts`) | `subscription.upgrade_requested` |
| **Onboarding** (`src/server/onboarding/service.ts`) | `registerTenant:25` (creates tenant + owner + role + subscription + application) | `tenant.registered` (genesis event of that tenant's chain; actor = new `owner`) |
| **Sensitive reads / exports** | `getRevenueTrend:13` + `getAverageOrderValue:76` (`analytics/service.ts`), surfaced on `/dashboard/analytics` | `report.financial_viewed` |
| | customer PII read — `getOrder:328` (`ordering/service.ts`) on `/dashboard/orders/[id]` (name/phone/address) | `customer.pii_viewed` |
| | *(forward)* viewing another cashier's / branch-wide sales history → Spec 3 / Spec 10 X-Z reports | `report.cross_cashier_sales_viewed` |
| | *(forward)* any CSV/PDF data export → Spec 10 | `data.exported` |

### Sensitive reads / exports — exactly what qualifies

Log a **read** only when it exposes data the actor would not see in the ordinary course of their own work:

- **Customer PII** — opening a specific customer's contact details (name + phone + delivery address). The storefront customer viewing *their own* order via `getOrderByToken` does **not** qualify (own data); a staff/manager/owner opening `/dashboard/orders/[id]` **does**.
- **Financial / reconciliation reports** — revenue trend, average-order-value, and (from Spec 7) reconciliation summaries. Operational counts (orders-by-status, fulfillment split, peak hours, top products) are **not** financial and are not logged.
- **Another cashier's sales** — a user viewing sales they did not ring (X/Z reports, cross-cashier sales history). Forward reference to Spec 3 / Spec 10.
- **Data export** — any action that produces a downloadable file of tenant data (CSV/PDF/JSON). No such feature exists today (the only downloads are the storefront QR PNGs, which carry no tenant data); `data.exported` lands with Spec 10 and is held by the guardrail until then.

**Never logged:** ordinary page views, list loads, the live POS order queue used to operate the till, catalog/menu browsing, and a customer reading their own order status.

### Actor types

All five product actors are represented; the `audit_actor_type` enum has four values because staff/manager/owner collapse to `user`:

| Product actor | `actorType` | `actorUserId` | Notes |
|---|---|---|---|
| Owner | `user` | set | role captured in `metadata.roleKey` |
| Manager | `user` | set | role captured in `metadata.roleKey` |
| Staff / cashier | `user` | set | role captured in `metadata.roleKey` |
| Customer (storefront) | `customer` | null | web `placeOrder`, `cancelOrderByToken` |
| System / automated | `system` | null | verifier, seeds, scheduled jobs |
| POS terminal (no human) | `device` | null | device pairing/redeem where no cashier is signed in |

### Platform `audit_logs` stays separate

The existing platform super-admin log (`src/server/platform/audit.schema.ts`) is **not** folded into this system and this system is **not** folded into it. `audit_events` covers tenant + user + customer + system actions and is tenant-scoped under FORCE RLS; `audit_logs` covers control-plane super-admin actions and has no RLS. Neither replaces the other; they are read and written by different code paths.

### Coverage guardrail

Coverage is an invariant, not a convention, so it is enforced by a test (`src/server/audit/coverage.test.ts`) that **fails CI when a mutating surface has no audit emission**:

- It statically enumerates the exported functions of the domain service modules (`ordering`, `pos`, `catalog`, `branches`, `tenancy`, `auth`/staff, `banners`, `subscription`, `billing`, `onboarding`) and classifies each as **mutating** if its body performs a write (`.insert(` / `.update(` / `.delete(` / a write via `tx.execute`).
- For each mutating function it asserts **either** the function body references `recordAuditEvent` **or** its `domain.symbol` is present in a committed, commented `AUDIT_ALLOWLIST` of genuinely non-auditable functions (e.g. `hashPassword`, `verifyPassword`, `validateSession`, `resolveDevice`, `getOrCreateTenantRole`, cache/rollup writers). Every allowlist entry carries a one-line justification.
- It sweeps the mutating boundary surfaces — `src/app/**/actions.ts` and `src/app/api/**/route.ts` — and asserts each either calls an audited service or emits directly, with an allowlist for surfaces whose emission lives at a different layer (e.g. media upload).
- Anything not covered and not allowlisted **fails the test**. When Specs 3/8/9/11 add refund/inventory/PO/ETA mutations, this test goes red until those mutations emit — that is the point.

## Data model

### New: `audit_events`

Append-only, tenant-scoped, `FORCE ROW LEVEL SECURITY`. One row per mutating action, auth event, or sensitive read. Never updated, never deleted (the trigger enforces this).

| Column | Notes |
|---|---|
| `id` | uuid, pk |
| `tenantId` | uuid → `tenants.id`, not null; RLS key |
| `branchId` | uuid → `branches.id`, **nullable** — null for tenant-wide actions (menu, settings, staff) |
| `actorUserId` | uuid → `users.id`, **nullable** — null for `system`/`customer`/`device` actors |
| `actorType` | enum `audit_actor_type`: `user \| system \| device \| customer` (staff/manager/owner = `user`, with `metadata.roleKey`) |
| `action` | text, dotted verb — e.g. `order.placed`, `catalog.product.price_changed`, `staff.role_changed`, `auth.login_failed`, `report.financial_viewed` |
| `entityType` | text — `order`, `payment`, `product`, `category`, `branch`, `staff`, `settings`, `banner`, `subscription`, `tenant`, `session`, `customer`, `report`, … |
| `entityId` | text — the affected row's id (text so non-uuid keys fit; `"-"` for tenant-wide) |
| `summary` | text — short human line for the log viewer |
| `metadata` | jsonb — structured context; `{before, after}` where a value changed; `roleKey` for user actors |
| `fingerprint` | jsonb — `{deviceId, deviceTokenHash, appVersion, ip, userAgent}` |
| `seq` | bigint — per-tenant monotonic position in the chain |
| `prevHash` | char(64) — `entryHash` of the previous row; 64 zeros at genesis |
| `entryHash` | char(64) — sha256 over the canonical serialization (see Architecture) |
| `createdAt` | timestamptz, default `now()` — set by the DB inside the tx, part of the hash |

Unique index on `(tenantId, seq)`. Read index on `(tenantId, createdAt)`, `(tenantId, entityType, entityId)`, and `(tenantId, action)` (the log viewer filters by action). RLS policy mirrors every other tenant table: `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` with the same `WITH CHECK`.

### New: `audit_chain_heads`

One row per tenant — the current tip of that tenant's chain. Read-and-advanced under the advisory lock inside the same append transaction.

| Column | Notes |
|---|---|
| `tenantId` | uuid → `tenants.id`, **primary key** — one row per tenant |
| `seq` | bigint — the `seq` of the most recent `audit_events` row (0 before genesis) |
| `headHash` | char(64) — the `entryHash` of that row; 64 zeros before genesis |
| `updatedAt` | timestamptz |

`FORCE ROW LEVEL SECURITY`, same isolation policy. Unlike `audit_events`, this row **is** updated (it is the mutable pointer); the tamper-evidence trigger applies to `audit_events` only. Integrity is proven by re-walking the chain, not by trusting the head.

## Authorization

Extend `src/server/rbac/permissions.ts`:

- Add `audit:view` to `PERMISSIONS`.
- `ROLE_PERMISSIONS`: grant to `owner` and `manager`; **not** `staff`. (Matches the roadmap's default mapping.)

Reads (`GET /api/audit/*`) resolve the tenant from the authenticated web session, assert `audit:view`, and query through `withTenant(tenantId, tx => …)` so RLS scopes results. **Writes are never exposed** — no HTTP endpoint inserts into `audit_events`. The only writer is `recordAuditEvent`, called server-side from inside a mutation's transaction (or a boundary emission for auth/reads). This is deliberate: an audit row you can POST directly is an audit row an attacker can forge.

## API

- `recordAuditEvent(ctx, event, tx)` — **the core surface, not HTTP.** Signature: `recordAuditEvent(ctx: AuditContext, event: { action, entityType, entityId, summary, metadata?, actorType? }, tx: Tx): Promise<void>`. It **must** receive the caller's transaction handle so the insert is atomic with the mutation; it must never open its own. `AuditContext` = `{ tenantId, branchId?, actorUserId?, fingerprint }`. It takes the advisory lock, reads `audit_chain_heads`, computes the hashes, inserts the row, and advances the head (see Architecture).
- **Boundary emission for auth events and sensitive reads.** Actions that have no surrounding data transaction (login, logout, opening a report or a customer's PII) call a thin wrapper that opens a single-statement `withTenant(tenantId, tx => recordAuditEvent(ctx, event, tx))`. The append is still atomic (one row + one head advance under the advisory lock); there is simply no other write to bind to.
- **Fingerprint capture at the boundary.** POS: `requirePosCashier` (`src/server/pos/require-cashier.ts`) already resolves `{deviceId, tenantId, branchId, cashierUserId}` from the device Bearer token + `X-POS-Cashier`; extend it to also read a new **`X-POS-App-Version`** header and to compute `deviceTokenHash = sha256(deviceToken)` from the `pos_devices.token` it already looked up (`src/server/pos/schema.ts`). Web routes derive `{appVersion, ip, userAgent}` from the `Request`; server actions derive them from `await headers()`. `deviceId`/`deviceTokenHash` are null off the POS. The assembled `fingerprint` is attached to `ctx` and threaded to `recordAuditEvent`.
- `GET /api/audit/events` — web dashboard, requires `audit:view`. Paginated, filterable by `action`, `entityType`/`entityId`, `actorUserId`, `actorType`, and date range. Read-only, via `withTenant`.
- `GET /api/audit/chain/status` — requires `audit:view`. Returns the tenant's `{seq, headHash}` and the last verifier result (`ok` / first broken `seq`). This is how tamper state is surfaced until Spec 5 wires notifications.

## Architecture

`recordAuditEvent` is a synchronous step *inside* the mutation's existing transaction — the same `withTenant` block that writes the order, tender, menu change, branch, or settings row. It reuses `placeOrder`'s serialization discipline exactly: acquire the per-tenant advisory lock only after validation I/O, do the read-then-advance, and let the surrounding commit make it durable. If the mutation later throws, the audit row rolls back with it — there is no orphan audit and no lost audit. For auth events and sensitive reads there is no data write to bind to, so the emission opens its own one-statement `withTenant` append; it is still one atomic row + head advance.

```
  mutating service (placeOrder / recordSale / updateProduct / setVatRate / setStaffRole / …)
        │  withTenant(tenantId, tx => { ...write the change...;
        │                               recordAuditEvent(ctx, event, tx) })
        ▼
  ┌───────────────────────── recordAuditEvent(ctx, event, tx) ─────────────────────────┐
  │  1. SELECT pg_advisory_xact_lock(hashtext(tenantId)::bigint)   ← same as order no.  │
  │  2. SELECT seq, headHash FROM audit_chain_heads  (0 / 64·'0' if no row → genesis)   │
  │  3. seq' = seq + 1 ;  prevHash = headHash                                           │
  │  4. entryHash = sha256( canonical(                                                  │
  │           prevHash, seq', tenantId, actorUserId,                                    │
  │           action, entityType, entityId, metadata, createdAt ) )                     │
  │  5. INSERT INTO audit_events (…, seq', prevHash, entryHash, createdAt)               │
  │  6. UPSERT audit_chain_heads SET seq = seq', headHash = entryHash                    │
  └────────────────────────────────────────────────────────────────────────────────────┘
        │  (lock released + rows made durable on COMMIT of the outer tx)
        ▼
              ┌──────────────────────── tamper-evidence ────────────────────────┐
              │  trigger: RAISE on UPDATE/DELETE of audit_events (below)          │
              │  verifier (periodic): walk each tenant chain, report first break │
              └──────────────────────────────────────────────────────────────────┘
```

**Canonical serialization** is a stable, deterministic encoding — sorted JSON keys, UTF-8, explicit null tokens, `createdAt` as RFC3339 with fixed precision — so the same logical event always hashes identically. It lives in one module (`src/server/audit/canonical.ts`) imported by both the writer and the verifier; there must be exactly one implementation, or the verifier will "detect" tamper that is really just an encoding drift.

**Tamper-evidence trigger** (sketch), shipped in the migration that creates the table:

```sql
CREATE FUNCTION audit_events_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % rejected', TG_OP;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate();
```

The **verifier** is a scheduled server job: for each tenant it reads rows ordered by `seq`, recomputes `entryHash` from the stored fields, checks `prevHash == previous row's entryHash` and `entryHash` matches, and reports the first `seq` where the recomputation diverges (or the head that `audit_chain_heads` claims is absent). It never mutates or "repairs" — a break is a finding, not a bug to auto-fix.

## Emission points

Coverage is **system-wide** (see *Coverage* for the full grounded list). Every mutating write threads `ctx` and calls `recordAuditEvent` inside its transaction; every auth event and sensitive read emits at its boundary. The emission is organised into four executable groups, each following the same "assert a row + a valid chain, then wire it" rhythm (the plan builds them as Tasks 6–9):

- **A — Ordering + POS.** `placeOrder` → `order.placed`; `recordSale` → `sale.recorded` + `discount.line_applied`/`discount.order_applied`; `addTender` → `payment.tender_added`; `transitionStatus` → `order.status_changed` `{before,after}`; `markPaid` → `order.marked_paid`; `cancelOrderByToken` → `order.cancelled`; `signInCashier`/`loginForPos` → `auth.cashier_signed_in`/`auth.login`(+`auth.login_failed`); grants → `authz.manager_granted`; held tickets → `ticket.held`/`ticket.discarded`; device lifecycle → `device.pairing_created`/`device.paired`/`device.revoked`.
- **B — Catalog.** categories, products (+ `catalog.product.price_changed`), modifier groups/options, branch availability, variants, and stock (`catalog.stock.set`).
- **C — Auth + staff + settings + branches + banners + billing/subscription + onboarding.** login/logout/failed-login, staff invite/role/deactivate, VAT/service-charge/whatsapp/profile/theme, branch + delivery-area CRUD + ordering, banner CRUD, trial/status/upgrade, and `tenant.registered`.
- **D — Sensitive reads / exports.** `report.financial_viewed` on the analytics financial figures; `customer.pii_viewed` on the order-detail page; forward: `report.cross_cashier_sales_viewed`, `data.exported`.

Control-plane mutations (tenant/user/device/subscription tables have no RLS) still emit by wrapping their write **and** the `recordAuditEvent` call in a `withTenant(tenantId, tx => …)` block so the audit insert has `app.tenant_id` set; the RLS-free control write inside that block is unaffected.

Forward references — these specs add their own emission points against the same helper, and the **coverage guardrail** fails their PRs if they do not: **refund** events → Spec 3; **inventory** ledger/lot/count events → Spec 8; **purchase-order** lifecycle → Spec 9; **ETA** fiscal submissions → Spec 11; **reconciliation** close (hash-anchored) → Spec 7. The chain and `recordAuditEvent` are built to absorb them without change.

## Error handling / edge cases

- **First event for a tenant (genesis):** no `audit_chain_heads` row → treat as `seq = 0`, `headHash` = 64 zeros; the first insert becomes `seq = 1` with `prevHash` = 64 zeros, and the head row is created. For most tenants the genesis event is `tenant.registered`.
- **Mutation fails after the audit insert:** both are in one transaction → both roll back. There is no partial audit and no orphaned chain advance.
- **Concurrent appends for one tenant:** the advisory lock serializes the read-then-advance window only; it is per-tenant (`hashtext(tenantId)`), not global, so tenants never block each other. Multiple appends inside one transaction (e.g. `recordSale` emitting several `discount.*` rows then `sale.recorded`) each see the prior insert and advance the head again.
- **A mutation that should audit but its fingerprint is unavailable:** record `emptyFingerprint()` (all null) and still audit. A missing fingerprint field never blocks the mutation — losing the sale (or the settings change) to protect the log is the wrong trade.
- **Missing `X-POS-App-Version` (older POS build):** record `appVersion: null` and still audit.
- **Failed login (no session, wrong password):** still emits `auth.login_failed` with the attempted email in `metadata` and a null `actorUserId` — a failed login has no authenticated actor by definition, and the streak is exactly what an investigation needs.
- **Verifier finds a broken link:** report the first divergent `seq` via `GET /api/audit/chain/status`; do not self-heal or truncate. (Spec 5 turns this finding into an alert.)
- **Someone disables the trigger and edits a row:** the trigger stops casual/accidental mutation; the chain is the real defence — the verifier still detects the edit because every subsequent `entryHash` no longer reconciles.
- **Device token rotation:** `deviceTokenHash` is a hash of whatever token was valid at capture time; a rotated token simply produces a new hash. The raw token is never stored, so a leaked `audit_events` dump cannot be replayed to authenticate.
- **Clock/`createdAt` integrity:** `createdAt` is set by the database (`now()`) inside the tx and is part of the hash, so it cannot be back-dated after the fact without breaking the chain.
- **Historical backfill:** actions that predate this deploy are **not** retro-chained; the chain starts at genesis on rollout. Backfilling would require fabricating hashes and defeats the purpose.

## Testing

- **Unit (pure):** canonical serialization is deterministic and stable across key order; a known input produces a known sha256 (fixed vector); genesis `prevHash` is 64 zeros; linking `prevHash → entryHash` holds across a synthetic chain; the verifier flags a hand-corrupted row at the correct `seq`.
- **Server (Vitest):** `recordAuditEvent` appends within the caller's tx and rolls back when the mutation throws; `seq` is strictly monotonic per tenant under concurrent appends; RLS hides one tenant's events from another; the trigger raises on `UPDATE` and on `DELETE`; the verifier walks a good chain (`ok`) and reports the first break on a tampered one; `GET /api/audit/events` is gated by `audit:view` (403 for `staff`) and scoped by `withTenant`.
- **Emission (per group A–D):** each representative mutation writes exactly one row with the expected `action`, and the tenant chain still verifies `ok` afterwards; auth-event and sensitive-read emissions produce a row with a null `actorUserId`/authenticated actor as appropriate; `{before,after}` is captured where a value changed.
- **Coverage guardrail:** the enumerate-and-assert test (see *Coverage guardrail*) passes with the shipped emissions + allowlist, and is proven to go red if a mutating function is stripped of its emission and removed from the allowlist.
- **Renderer:** the web audit log view lists, filters (action/entity/actor/date), and paginates; the chain-status banner reflects `ok` vs. a reported break.
- **Manual acceptance:** ring a POS sale → an `audit_events` row appears with `fingerprint` containing `deviceTokenHash` (not the raw token) and the `X-POS-App-Version` value; change a menu price, flip the VAT rate, and escalate a staff role → three more rows with `{before,after}`; open a customer's order-detail page → a `customer.pii_viewed` row; attempt `UPDATE audit_events …` in `psql` → the trigger raises; run the verifier → `ok`; disable the trigger, edit one row, re-run the verifier → it reports the first broken `seq`.

## Roadmap

- **Spec 5 — Notifications & Outbound Email:** consume the verifier's break findings and email the owner; deliver the tamper alert this spec only logs.
- **Spec 7 — Transaction Reconciliation:** hash-anchor each daily close into the chain (`reconciliation.closed`), making the day's totals tamper-evident too; its financial/reconciliation reports emit `report.financial_viewed`.
- **Specs 3 / 8 / 9 / 11:** register refund, inventory-ledger, purchase-order, and ETA-fiscal emission points against the existing `recordAuditEvent` helper — no chain changes required; the coverage guardrail enforces that they do.
- **Spec 10 — Cross-Channel Reporting:** promote the minimal read API into a full manager-facing audit/activity surface with export; the export action emits `data.exported`, and cross-cashier sales views emit `report.cross_cashier_sales_viewed`.

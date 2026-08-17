# QA — Cross-cutting concerns

**Surface code:** `XC` · **Spans:** every surface
**Last verified against code:** 2026-08-17

The properties that are not any one screen's job: who may do what, whose data is
whose, what a plan buys, how the product behaves in Arabic and on a phone, and
how failures are reported. A defect here is usually systemic — one missing
`authorize()` call, one query outside `withTenant`.

Run this file **last**. It assumes accounts, tenants and data created by the
five surface files, and several cases are cross-surface by construction.

---

## How to run this file

```bash
npm run db:seed && npm run demo:seed && npm run dev
```

Two environment requirements that change whether these cases mean anything:

1. **The database role must be `NOBYPASSRLS`.** A superuser silently bypasses
   row-level security, so every `XC-ISO` case would pass vacuously. CI runs the
   suite as a non-superuser for exactly this reason — check your local role
   before trusting an `XC-ISO` pass.
2. **You need two tenants with overlapping data.** `roma` and `demo-retail` both
   seeded, each with orders, products and a customer using the same email
   (`SF-ACCT-004`).

---

## XC-RBAC — The permission matrix, end to end

**Goal:** every role can do exactly what the matrix says and nothing more
**Reference:** the full 5 × 25 matrix is in [personas.md](personas.md)

Surface files test the permissions that gate their own screens. This journey
sweeps the matrix as a whole, and specifically probes the two directions an
escalation could come from.

The rule being tested is that **hiding a control is not the control**. Every case
here checks the direct URL or API call, not just the absence of a nav item.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| XC-RBAC-001 | Each role sees exactly its own nav set | permission | P1 | PARTIAL (`dashboard.spec.ts › staff cannot reach settings…` covers staff only) | 1. Sign in as owner, manager, staff and pharmacist in turn. 2. Count sidebar items. | 13, 12, 3, 5 respectively — matching [personas.md](personas.md). |
| XC-RBAC-002 | Staff cannot reach any `menu:manage` page by URL | permission | P1 | MANUAL | 1. As staff request `/dashboard/menu`, `/dashboard/analytics`, `/dashboard/branches`, `/dashboard/banners`. | All four refused or redirected. None renders data. |
| XC-RBAC-003 | Staff cannot reach any owner-only page | permission | P1 | MANUAL | 1. As staff request `/dashboard/settings/profile`, `/settings/billing`, `/settings/pos-devices`, `/dashboard/audit`, `/dashboard/customers`. | All refused. |
| XC-RBAC-004 | Manager cannot reach owner-only pages | permission | P1 | MANUAL | 1. As manager request `/dashboard/settings/profile`, `/settings/billing`, `/settings/pos-devices`. | All three refused — they are `tenant:manage` / `billing:manage` only. Manager keeps its own 5 settings tabs. |
| XC-RBAC-005 | Manager cannot review prescriptions | permission | P1 | MANUAL | 1. As manager on `demo-pharmacy` request `/dashboard/prescriptions`. | Refused. `rx:review` is owner + pharmacist only, so a compliance record always names a licensed reviewer. |
| XC-RBAC-006 | A super admin holds no tenant permission | permission | P1 | AUTOMATED (`admin.spec.ts › a tenant user visiting /admin…` covers the mirror case) | 1. Signed in as `admin@serveos.com`, request `/dashboard`, `/dashboard/orders`, `/dashboard/menu`. | No tenant data is served. A platform admin is not a member of any tenant. |
| XC-RBAC-007 | An owner holds no platform permission | permission | P1 | AUTOMATED (`admin.spec.ts › a tenant user visiting /admin gets an explanation, not the login form`) | 1. As `owner@roma.com` request `/admin`, `/admin/tenants`, `/admin/billing`. | Routed to `/admin/no-access`. No tenant list and no revenue figure. |
| XC-RBAC-008 | A manager cannot grant themselves owner | permission | P1 | MANUAL | 1. As manager, attempt to assign the `owner` role — through the UI, then by POSTing the role id directly. | Refused both ways. A manager escalating to owner would defeat the entire matrix. |
| XC-RBAC-009 | POS permissions are a distinct subset | permission | P1 | MANUAL | 1. Sign in to the POS as staff. 2. Inspect the permissions the session carries. | Only `pos:*` plus `reconciliation:manage` — never `menu:manage` or `tenant:manage`, even for an owner signed in at the till. |
| XC-RBAC-010 | Every gated write refuses without its permission | permission | P1 | MANUAL | 1. As staff, POST directly to a sample of gated endpoints: `/api/inventory/items` (needs `inventory:manage`), a menu mutation (`menu:manage`), a refund (`pos:refund`). | Each refused with a permission error, not a 500 and not a silent success. |

---

## XC-ISO — Tenant isolation

**Goal:** no tenant can read or write another's data, ever

Isolation is a `tenant_id` column **plus FORCE row-level security**, enforced
through the `withTenant()` transaction wrapper. Control-plane tables — `users`,
`pos_devices`, `pos_order_receipts`, platform `audit_logs`, `usage_counters` —
intentionally have **no** RLS, so their isolation is enforced by explicit
predicates instead. Both mechanisms need testing, and the second is where a bug
is more likely.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| XC-ISO-001 | The marketing host serves no tenant | permission | P1 | AUTOMATED (`onboarding.spec.ts › marketing host does not leak a tenant`) | 1. Request the bare root domain. | Marketing renders. No tenant name, catalogue or branding. |
| XC-ISO-002 | `x-tenant-slug` cannot be spoofed | permission | P1 | MANUAL | 1. Request the marketing host, then `app.` and `admin.`, each with a forged `x-tenant-slug: roma`. | The proxy strips the header on every non-storefront host. No `roma` data anywhere. |
| XC-ISO-003 | An order id from another tenant is not readable | permission | P1 | MANUAL | 1. Note a `roma` order id. 2. Signed in to `demo-retail`, request that order's dashboard detail page and its API route. | Not found in both cases — never the order, and never a permission message that confirms it exists. |
| XC-ISO-004 | A status token cannot cross tenants | permission | P1 | MANUAL | 1. Take a valid `roma` order's status token. 2. Open `/order/<token>` on `demo-retail`'s host. | Not found. |
| XC-ISO-005 | A product id from another tenant cannot be ordered | permission | P1 | MANUAL | 1. POST an order to `demo-retail` naming a `roma` product id. | 422 `product unavailable` — never a cross-tenant line. |
| XC-ISO-006 | A branch id from another tenant is refused | permission | P1 | MANUAL | 1. POST an order to `demo-retail` naming a `roma` `branchId`. | 422 `unknown branch`. |
| XC-ISO-007 | A delivery area from another branch is refused | permission | P1 | MANUAL | 1. POST a delivery order naming an area belonging to a different branch. | 422 `area_not_deliverable`. The area must be active **and** belong to the chosen branch. |
| XC-ISO-008 | A refund cannot be attributed to a foreign branch | permission | P1 | MANUAL | 1. Issue a refund supplying a `branchId` from another tenant. | Refused with `Refund branch does not belong to this tenant`. Branch attribution is owned server-side — the foreign key alone only proves the branch exists. |
| XC-ISO-009 | Audit events do not cross tenants | permission | P1 | MANUAL | 1. Act on both tenants. 2. Read each tenant's `/dashboard/audit`. | Each shows only its own events. |
| XC-ISO-010 | A demo session is confined to its demo tenant | permission | P1 | MANUAL | 1. Enter the demo dashboard via `/api/demo/login?trade=retail`. 2. Attempt to read `roma` records by id. | Nothing is returned. A credential-less visitor is contained exactly as any user is. |
| XC-ISO-011 | Usage counters are scoped to their tenant | edge | P1 | MANUAL | 1. Place orders on both tenants. 2. Compare each tenant's monthly usage on Billing. | Each counts only its own orders. `usage_counters` has no RLS, so this is enforced by an explicit predicate — a recent fix (`02227f3`) addressed exactly this. |
| XC-ISO-012 | A cashier session cannot act on another tenant | permission | P1 | MANUAL | 1. Pair a POS to `roma`. 2. Attempt a POS API call carrying a `roma` device token but referencing a `demo-retail` order. | Refused. `requirePosCashier` scopes reads and writes to the device's own tenant and branch. |

---

## XC-ENT — Plan limits and features

**Goal:** a plan's limits are enforced, and its features are actually gated

| Plan | branches | staff | products | whatsapp_numbers | orders/mo | Features on |
|---|---|---|---|---|---|---|
| basic | 1 | 2 | 50 | 0 | 200 | online_ordering |
| pro | 3 | 10 | 500 | 1 | 2000 | + whatsapp, custom_theme, reservations |
| enterprise | 50 | 200 | 100000 | 10 | 100000 | + custom_domain, advanced_analytics |

Two things carry over from the surface files: **`advanced_analytics` may be
dormant** (`DSH-ANL-006` settles it), and `custom_domain`, `custom_theme` and
`reservations` need their enforcement points confirmed rather than assumed.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| XC-ENT-001 | The branch limit is enforced | permission | P1 | MANUAL | 1. On `basic` (1), create a second branch. 2. Move to `pro` (3) and create up to a fourth. | Refused at the limit with a quota error naming it. `pro` allows 3 and refuses the 4th. |
| XC-ENT-002 | The staff limit is enforced | permission | P1 | MANUAL | 1. On `basic` (2), invite a third user. | Refused with a quota error naming the limit of 2. |
| XC-ENT-003 | The product limit is enforced | permission | P1 | MANUAL | 1. On `basic` (50), create the 51st product. | Refused with a quota error. |
| XC-ENT-004 | The monthly order quota is enforced | permission | P1 | MANUAL | 1. Set the tenant's `usage_counters` orders count to its limit for this period. 2. Place an order. | Refused with `quota_exceeded`. The counter is scoped to the current billing period, which begins on the first of the month. |
| XC-ENT-005 | Quota errors are bilingual | i18n | P2 | MANUAL | 1. Trigger a quota error with an Arabic locale. | The message is in Arabic. `quota_exceeded` and `feature_unavailable` both carry `en` and `ar` copy. |
| XC-ENT-006 | WhatsApp is gated on the feature flag | permission | P1 | MANUAL | 1. On `basic`, send a WhatsApp message to the tenant's number. 2. Move to `pro` and repeat. | Skipped silently on `basic` (`WA-GATE-004`); the greeting arrives on `pro`. |
| XC-ENT-007 | Downgrading removes access to a feature | edge | P1 | MANUAL | 1. On `pro` with WhatsApp working, cancel or downgrade to `basic`. 2. Send a message. | The channel goes quiet again. Downgrades take effect, not just upgrades. |
| XC-ENT-008 | Exceeding a limit does not corrupt existing data | edge | P1 | MANUAL | 1. On `pro` with 3 branches, downgrade to `basic` (limit 1). 2. Inspect the branches. | The existing 3 remain and keep working. The limit blocks *creation*; it must not delete or hide data the tenant already has. Record the actual behaviour — silently hiding two branches would be a serious defect. |
| XC-ENT-009 | A tenant with no plan fails loudly, not silently | negative | P2 | MANUAL | 1. Detach a tenant's subscription so no plan resolves. 2. Attempt a quota-checked action. | An explicit error (`No plan for tenant …`), not a permissive default. Fail-closed is the correct behaviour for an entitlement gate. |
| XC-ENT-010 | Confirm which features are actually enforced | edge | P1 | MANUAL | 1. On `basic`, exercise each flagged feature: `advanced_analytics`, `custom_theme`, `custom_domain`, `reservations`. | **Record the real behaviour for each.** Any flag with no `requireFeature`/`hasFeature` call behind it is dormant — the plan table promises something the code does not enforce. Cross-check against `DSH-ANL-006`. |

---

## XC-I18N — Arabic, English and RTL

**Goal:** the product is genuinely bilingual, not English with a translation layer

Arabic is not an afterthought here — the marketing site is Arabic **by default**,
and domain errors carry `ar` copy. Two distinct things need testing: that the
translation exists, and that the layout mirrors.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| XC-I18N-001 | Marketing is Arabic-first and RTL | i18n | P1 | AUTOMATED (`marketing.spec.ts › the homepage is Arabic and right-to-left in the served HTML`) | 1. Open the root domain. | `lang="ar"`, `dir="rtl"`, Arabic H1. |
| XC-I18N-002 | Arabic needs no JavaScript | i18n | P1 | AUTOMATED (`marketing.spec.ts › Arabic ships without JavaScript…`) | 1. With scripting off, open `/`. | Still Arabic and RTL — proving there is no client-side language flash. |
| XC-I18N-003 | The storefront renders Arabic content and mirrors | i18n | P1 | MANUAL | 1. Switch a storefront to Arabic. 2. Walk browse → cart → checkout. | Arabic product and category names where they exist, RTL layout throughout, correctly formatted prices, and no clipped text at the left edge. |
| XC-I18N-004 | Domain errors are translated | i18n | P1 | MANUAL | 1. In Arabic, trigger `area_not_deliverable`, `minimum_order_not_met`, `branch_not_accepting_orders` and a quota error. | Each returns its Arabic message — e.g. `منطقة التوصيل غير متاحة`, `الحد الأدنى للطلب هو …`. No English leaks into an Arabic response. |
| XC-I18N-005 | Order status wording follows the vertical *and* the locale | i18n | P1 | MANUAL | 1. Track a `demo-retail` order in Arabic through preparing and ready. | The retail Arabic wording, not the restaurant Arabic wording — status copy varies on both axes. |
| XC-I18N-006 | An untranslated field falls back rather than blanking | edge | P2 | MANUAL | 1. Create a product with an English name and no Arabic name. 2. View the Arabic storefront. | The English name is shown. The card is never blank or `null`. |
| XC-I18N-007 | RTL holds at 360px | responsive | P2 | MANUAL | 1. At 360px in Arabic, walk the storefront and checkout. | No horizontal overflow. Icons, chevrons and progress indicators point right-to-left. |

---

## XC-RESP — Responsive behaviour

**Goal:** every surface is usable on the phone a shop actually owns

Three viewports: **360px** (small phone), **768px** (tablet), **1280px**
(desktop). The 360px case is the one that breaks.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| XC-RESP-001 | Public pages do not overflow at 360px | responsive | P1 | AUTOMATED (`responsive.spec.ts › public pages do not overflow`) | 1. At 360px open marketing, a storefront and checkout. | No horizontal scrollbar on `<body>` on any of them. |
| XC-RESP-002 | Dashboard pages do not overflow at 360px | responsive | P1 | AUTOMATED (`responsive.spec.ts › dashboard pages do not overflow`) | 1. At 360px open every dashboard page. | No horizontal overflow, including analytics and the Topbar. |
| XC-RESP-003 | The mobile nav drawer works | responsive | P1 | AUTOMATED (`responsive.spec.ts › hamburger opens a drawer that navigates and closes`) | 1. At 360px open the dashboard, use the hamburger. | The drawer opens, navigates, and closes on selection. |
| XC-RESP-004 | Wide tables become cards on mobile | responsive | P1 | AUTOMATED (`responsive.spec.ts › menu shows product cards…` and `orders shows cards…`) | 1. At 360px open Menu and Orders. | Cards, not horizontally-scrolling tables. |
| XC-RESP-005 | Tap targets are big enough | responsive | P2 | AUTOMATED (`storefront-responsive.spec.ts › tap targets…`) | 1. At 360px measure storefront add buttons. | At least 40px. |
| XC-RESP-006 | Inputs do not trigger iOS zoom | responsive | P2 | AUTOMATED (`storefront-responsive.spec.ts › checkout page does not overflow, inputs do not trigger iOS zoom, and totals breakdown renders`) | 1. At 360px inspect checkout inputs. | Font size at least 16px, so mobile Safari does not zoom on focus. |
| XC-RESP-007 | The admin console is usable at 360px | responsive | P2 | MANUAL | 1. At 360px open every admin page. | The admin mobile nav works and no page overflows. **Not covered by the automated suite** — `responsive.spec.ts` tests the dashboard, not the console. |
| XC-RESP-008 | Tablet and desktop layouts are correct | responsive | P2 | MANUAL | 1. At 768px and 1280px walk each surface. | Layouts adapt without leaving huge empty gutters or cramped columns. Tables may return at these widths. |

---

## XC-SESS — Session security

**Goal:** three independent session lanes that never substitute for each other

| Lane | Credential | Storage | Lifetime |
|---|---|---|---|
| Staff / dashboard | `serveos_session` cookie, path `/` | `sessions` table | 30 days (2 hours for a demo session) |
| Customer / storefront | `serveos_customer` cookie | `customer_sessions` table, sha256 of the token | 30 days |
| POS device | Bearer token | `pos_devices` row | durable until revoked |
| POS cashier | `X-POS-Cashier` header | **server process memory** | 12 hours |

The staff cookie is scoped to `/`, which is why a dashboard session reaches
`/admin` and gets the no-access page rather than a login form. The customer lane
is deliberately separate so a customer token can never open the dashboard.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| XC-SESS-001 | A customer token cannot open the dashboard | permission | P1 | MANUAL | 1. Signed in as a storefront customer, request `app.serveos.localhost:3000/dashboard`. | Redirected to the staff login. The staff lane never accepts a customer token. |
| XC-SESS-002 | A staff token cannot act as a customer | permission | P1 | MANUAL | 1. Signed in to the dashboard, open `/account` on a storefront host. | The customer login form — a staff session does not authenticate a customer. |
| XC-SESS-003 | A dashboard session reaching `/admin` gets no-access | permission | P1 | AUTOMATED (`admin.spec.ts › a tenant user visiting /admin gets an explanation, not the login form`) | 1. Signed in as owner, open `/admin`. | `/admin/no-access` with an explanation, never the login form. |
| XC-SESS-004 | Sign-out invalidates the session server-side | permission | P1 | AUTOMATED (`dashboard.spec.ts › sign out from the user menu ends the session`) | 1. Sign out. 2. Replay the old cookie value against `/dashboard`. | Refused. The session is invalidated in the database, not merely dropped by the browser. |
| XC-SESS-005 | Customer tokens are never stored in the clear | permission | P1 | MANUAL | 1. Register a customer. 2. Inspect `customer_sessions`. | `tokenHash` holds a sha256; the raw token appears nowhere in the table. |
| XC-SESS-006 | A revoked POS device stops working immediately | permission | P1 | MANUAL | 1. Revoke the device (`DSH-POSD-003`). 2. Use the POS. | `Device unpaired — please pair again`, and the local token is cleared. |
| XC-SESS-007 | A cashier session dies with the server process | edge | P2 | MANUAL | 1. Sign in a cashier. 2. Restart the web server. 3. Act on the POS. | The cashier is signed out; the device stays paired. Cashier sessions live in process memory by design. |
| XC-SESS-008 | A demo session is short and confined | permission | P1 | MANUAL | 1. Enter the demo dashboard. 2. Inspect the cookie expiry and attempt cross-tenant reads. | ~2 hours, not 30 days, and confined to the demo tenant (`XC-ISO-010`). |
| XC-SESS-009 | An expired session is refused | edge | P2 | MANUAL | 1. Set a session's `expiresAt` into the past. 2. Use it. | Refused and treated as signed out. No stale-session access. |
| XC-SESS-010 | Session cookies carry the right flags | edge | P1 | MANUAL | 1. Inspect the staff and customer cookies. | Both `httpOnly` and `sameSite=lax`. `secure` is set when served over HTTPS — verify on QA, where the site is HTTPS, rather than on local HTTP. |

---

## XC-ERR — The error contract

**Goal:** failures are modelled, localised, and never leak internals

The contract: `DomainError` → **422** with `{ error, code }` and a localised
message. `UnauthorizedError` → **403** on an API route, a redirect on a page.
Anything else → **500**. So a 500 in place of a 422 means an unmodelled failure,
and that is the signal these cases hunt for.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| XC-ERR-001 | Domain failures are 422 with a code | negative | P1 | MANUAL | 1. Trigger `minimum_order_not_met`, `area_not_deliverable`, `invalid_schedule` and `order_validation`. | Each returns 422 with the matching `code`. Testing the code rather than the prose keeps these stable across copy changes. |
| XC-ERR-002 | Malformed JSON is 400, not 500 | negative | P1 | MANUAL | 1. POST `/api/orders` with a broken body. | 400 `Invalid JSON`. |
| XC-ERR-003 | A permission failure on an API route is 403 | negative | P1 | MANUAL | 1. As staff GET `/api/audit/chain/status`. | 403 `Forbidden` — not a redirect, and not a 500. |
| XC-ERR-004 | Unhandled input never returns a stack trace | negative | P1 | MANUAL | 1. Fuzz a sample of API routes with wrong types, nulls, oversized strings and unexpected fields. | Nothing returns a stack trace, SQL text, table name or file path. A generic `Something went wrong` is acceptable; internals are not. |
| XC-ERR-005 | Not-found never confirms existence | permission | P1 | MANUAL | 1. Request an unknown tenant slug, an unknown order token, and a real order token belonging to another tenant. | All three are indistinguishable. A different response for "exists but not yours" would confirm the record exists. |
| XC-ERR-006 | Sweep for 500s across every surface | negative | P1 | MANUAL | 1. While executing all five surface files, log every 500 encountered. | Zero. Each 500 found is a defect with a named cause — an unmodelled failure path. Track them here rather than in the individual files, since the fix is usually one error class. |

---

## Coverage summary

| Journey | Cases | P1 | Automated |
|---|---|---|---|
| XC-RBAC permission matrix | 10 | 10 | 2 |
| XC-ISO tenant isolation | 12 | 12 | 1 |
| XC-ENT plan limits & features | 10 | 8 | 0 |
| XC-I18N Arabic, English, RTL | 7 | 5 | 2 |
| XC-RESP responsive | 8 | 4 | 6 |
| XC-SESS session security | 10 | 8 | 2 |
| XC-ERR error contract | 6 | 6 | 0 |
| **Total** | **63** | **53** | **13** |

63 cases against a budget of 45. Isolation and the permission matrix earned the
extra room: every one of those cases is a way for one business to see another
business's money.

**13 of 63 automated**, and they are lopsided — responsive is well covered
(6 of 8), while **tenant isolation has exactly one automated case** and the
**error contract has none**. Given that RLS is the product's primary security
boundary, `XC-ISO` is the most under-tested high-stakes area in the codebase.

Three cases here are **open questions rather than assertions**, and each needs a
decision recorded when it is run:

- `XC-ENT-008` — what happens to existing branches when a plan is downgraded below the limit.
- `XC-ENT-010` — which plan feature flags are genuinely enforced, and which are dormant.
- `XC-RESP-007` — the admin console has no automated responsive coverage at all.

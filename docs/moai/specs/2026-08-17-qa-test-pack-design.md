# QA Test Pack — All Surfaces — Design

**Date:** 2026-08-17
**Status:** Approved (design)
**Author:** Claude Opus 5 (with Mohaned)
**Owner:** QA
**Depends on:** nothing — documentation only, no code changes

## 1. Goal

Give the QA engineer one executable pack that covers every ServeOS surface: the
user journeys a real person walks, and under each journey the individual test
cases with steps and expected results. A full pass over the pack is a release
sign-off. A single case is quotable in a bug report by a stable ID.

Today there is no such artifact. There are 11 Playwright specs (`tests/e2e/`,
about 30 assertions) that smoke the happy paths, and nothing that tells a human
what to test or what "correct" looks like.

## 2. Decisions (locked)

Taken with the owner on 2026-08-17.

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Issue shape | **Epic + one child issue per surface** (6 children). Each child is independently assignable and closeable so the board shows per-surface progress. |
| Q2 | Where cases live | **Versioned markdown under `docs/qa/`**, one file per surface. Issues link to the files; issue bodies stay short. Cases get reviewed in PRs and diffed as features change. |
| Q3 | Functional scope | **Only what ships today.** Everything in the pack must be executable against `qa.serveos.tech` plus a paired POS build. Unbuilt roadmap work is excluded, not stubbed. |
| Q4 | Automation tagging | **Every case carries an automation tag** (`AUTOMATED` / `PARTIAL` / `MANUAL`) resolved against `tests/e2e/`. QA spends effort on gaps; the tag list doubles as the automation backlog. |
| Q5 | Depth | **P1 + P2, about 420 cases.** Every happy path, plus every negative and edge case that changes money, permissions, tenancy or order state, plus i18n and responsive spot checks. Field-level validation permutations get one representative case each rather than an exhaustive sweep. |
| Q6 | Sequencing | **Spec + the POS file first**, reviewed by the owner, then the remaining six files written to the approved shape. |

## 3. Ground truth — what exists to test

Code is the authority here, not `docs/ROADMAP.md`.

### 3.1 Roadmap drift (must be corrected separately)

`docs/ROADMAP.md` understates what has shipped. Verified against the route
tree, `src/server/`, and merge history:

| Spec | ROADMAP state | Actual state | Evidence |
|------|---------------|--------------|----------|
| 2 Shifts & Cash Drawer | `☐ spec drafting` | **shipped** | `/api/pos/v1/shifts/{open,close,current,movements}`, `apps/pos/src/screens/{Open,Close}Drawer*` |
| 3 Refunds & Sales History | `☐ spec drafting` | **shipped** | PR #116; `/api/pos/v1/sales/[id]/refund`, `SalesHistory.tsx`, `/dashboard/orders/history` |
| 4 Audit & Fingerprint Log | `☐ spec written` | **shipped** | `/api/audit/{events,chain/status}`, `/dashboard/audit` |
| 5 Notifications & Email | `☐ spec drafting` | **shipped** | `/api/notifications/{worker,webhook/[provider]}`, `/dashboard/notifications` |
| 8 Inventory + Recipes | Part A/B only | **shipped incl. backfill** | PR #127, PR #132; 12 `/api/inventory/*` routes |
| WhatsApp ordering | design says "It is not [built]" | **shipped** | 37 modules in `src/server/whatsapp/` incl. `reducer`, `cloud-api-provider`, `status-worker` |
| 6 Payments gateway | parked | **not built** — confirmed | `payment_method` still cash/offline only |
| 7 Reconciliation | not built | **not built** — confirmed | no reconciliation module |
| 9 Suppliers & Purchasing | not built | **not built** — confirmed | `/dashboard/analytics/purchasing` exists but no PO lifecycle |
| 11 ZATCA / ETA e-invoicing | drafting | **not built** — confirmed | design only, branch `docs/zatca-einvoicing-design` |

The pack tests the **shipped** column. Specs 6, 7, 9 and 11 are out of scope
per Q3. Fixing `ROADMAP.md` is filed as its own task, not done here — the pack
must not be blocked on a roadmap edit.

### 3.1b Shipped-but-unreachable — found while writing `05-pos.md`

Three things exist in code but cannot be reached by a user. They are **not**
journeys (there is nothing to walk) and **not** bugs the pack should file
repeatedly. Each gets one case asserting it is still unreachable, so the pack
notices if that changes:

| # | Finding | Evidence |
|---|---------|----------|
| G1 | **`pos:void` is dead.** Owner and manager hold it, `pos_adjustment_events` accepts `line_void`/`order_void`, and `dashboard/analytics/financial` renders a Voids table — but nothing in the codebase writes a void and the POS has no void UI. The permission and the report are both unreachable. | `rbac/permissions.ts:16`; `pos/tender-schema.ts:10`; `analytics/financial/page.tsx:149`; no writer anywhere |
| G2 | **Pairing-code entry is unreachable.** `pos.pair(code)` exists on the bridge and in the main process, and the dashboard mints codes, but no renderer screen calls it. `README.md` documents a flow the UI does not offer. | `electron/preload.ts:82`; `electron/pos-main.ts:338`; no caller in `apps/pos/src` |
| G3 | **The POS has no offline mode.** `apps/pos/electron/_offline/` (store, sync, db, api) is imported by nothing. `tests/e2e/offline-payment.spec.ts` covers offline *payment methods*, not network loss. | `apps/pos/electron/pos-main.ts:288` ("parked"); no import outside `_offline/` |

G1–G3 are why the POS journey count moved from 17 to 18: an offline journey was
dropped as unwritable, and a `POS-GAP` journey was added to hold the assertions.
The same audit must be run per surface before its file is written, rather than
assuming a design doc describes shipped behaviour.

### 3.2 Surfaces

Host classification lives in `src/middleware-routing.ts`; the desktop app is
separate.

| Code | Surface | Host / entry | Primary users |
|------|---------|--------------|---------------|
| `MKT` | Marketing site | `www.serveos.tech` | prospect |
| `SF` | Tenant storefront (installable PWA) | `{slug}.serveos.tech` | customer |
| `DSH` | Merchant dashboard | `app.serveos.tech` | owner, manager, staff, pharmacist |
| `ADM` | Platform admin console | `admin.serveos.tech` | super_admin |
| `POS` | Electron POS | `apps/pos` desktop build | cashier, manager |
| `WA` | WhatsApp ordering channel | tenant's WhatsApp number | customer |
| `XC` | Cross-cutting | all of the above | all |

### 3.3 Roles and permissions

`src/server/rbac/permissions.ts` — 5 role keys over **25** permissions (22
tenant-scoped + 3 platform). The `XC` file carries the full matrix; each surface
file tests only the permissions that gate its own screens.

- `owner` — all 22 tenant permissions
- `manager` — 18: owner minus `tenant:manage`, `plan:change`, `billing:manage`, `rx:review`
- `staff` — 5: `plan:view`, `orders:manage`, `pos:sell`, `inventory:view`, `inventory:count`
- `pharmacist` — 5: `plan:view`, `orders:manage`, `fulfillment:manage`, `pos:sell`, `rx:review`
- `super_admin` — 3, platform only: `platform:{approve_tenant,suspend_tenant,view_revenue}`

`rx:review` is held by **owner and pharmacist only** — deliberately not manager,
because the compliance trail must name a licensed reviewer rather than "a
manager" (`permissions.ts:36`).

`super_admin` holds **no** tenant permissions and `owner` holds **no** platform
permissions — the separation is itself a P1 case.

### 3.4 Verticals

`src/server/verticals/registry.ts` — four descriptors, each changing
storefront template, terminology (EN + AR), capabilities and checkout
adjustments.

| Vertical | Template | Distinguishing capabilities | Checkout adjustments |
|----------|----------|-----------------------------|----------------------|
| restaurant | `menu` | modifiers, recipes, service charge | vat, service_charge |
| retail | `shop` | variants | vat |
| pharmacy | `shop` | variants, prescriptionUpload, pharmacistReview | vat |
| timber | `yard` | variants, dimensionalProducts, unitsOfMeasure, tradeAccounts | vat |

### 3.5 Plans

`src/server/subscription/plans.seed.ts` — the gates the pack must prove are
enforced.

| Plan | Price | branches | staff | products | whatsapp_numbers | orders/mo | Features on |
|------|-------|----------|-------|----------|------------------|-----------|-------------|
| basic | 0 | 1 | 2 | 50 | 0 | 200 | online_ordering |
| pro | 499 | 3 | 10 | 500 | 1 | 2000 | + whatsapp, custom_theme, reservations |
| enterprise | 1499 | 50 | 200 | 100000 | 10 | 100000 | + custom_domain, advanced_analytics |

Note for the `XC` file: `advanced_analytics` is documented in `ROADMAP.md` D6
as "now-enforced". Whether `requireFeature` actually gates the analytics pages
is an **open question the pack must answer**, written as a case rather than
assumed either way.

### 3.6 State machines the pack must walk

- **Order status** (`src/lib/order-status.ts`) — `pending → confirmed →
  preparing → ready → out_for_delivery → completed`, plus `rejected` and
  `cancelled`. Pharmacy/retail/timber relabel `preparing`/`ready` per vertical
  terminology; the relabelling is a case.
- **Tenant status** (`src/server/tenancy/schema.ts`) — `active | suspended | rejected`.
- **Onboarding application** (`src/server/onboarding/schema.ts`) — `pending | approved | rejected`.
- **POS session** (`apps/pos/src/App.tsx`) — `unpaired → paired → cashier
  signed in → drawer open (or explicitly skipped) → 6 tabs`. The drawer is
  *offered, not forced*: card-only selling without a drawer is legitimate and
  the server refuses cash tenders when no shift is open. Both halves are cases.

### 3.7 Existing automation, for the `Auto` tags

11 spec files, listed here so tags can be resolved without re-reading them:

| Spec file | Covers | Tag target |
|-----------|--------|------------|
| `admin.spec.ts` | admin sign-in, tenant-user at `/admin`, non-admin platform account | `ADM-LOGIN`, `ADM-NOACC` |
| `dashboard.spec.ts` | owner sign-in → Orders, settings tabs, staff redirect, sign-out | `DSH-LOGIN`, `DSH-SET`, `XC-RBAC` |
| `marketing.spec.ts` | hero/features/auth links, trade re-skin, docket height, roadmap flags, AR + RTL | `MKT-HOME`, `MKT-TRADE`, `MKT-I18N` |
| `menu.spec.ts` | `/api/menu` 200/404/400, storefront renders menu | `SF-BROWSE` |
| `offline-payment.spec.ts` | method + pay-to on checkout, `pending_verification` order, merchant queue | `SF-PAY`, `DSH-PAY` |
| `onboarding.spec.ts` | PWA manifest, storefront brand, marketing host does not leak a tenant | `SF-PWA`, `XC-ISO` |
| `ordering.spec.ts` | browse → cart → checkout | `SF-CART` |
| `responsive.spec.ts` | mobile dashboard nav, cards not tables, no 360px overflow | `XC-RESP` |
| `scheduling.spec.ts` | schedule an order, cancel while pending | `SF-SCHED` |
| `shop.spec.ts` | retail shop template, restaurant menu template | `SF-BROWSE` |
| `storefront-responsive.spec.ts` | storefront 360px, search, variant add, out-of-stock, tap targets, checkout | `XC-RESP`, `SF-CART` |

Nothing automated touches the POS, WhatsApp, inventory, audit, refunds,
analytics or the admin approval flow. Those files will be almost entirely
`MANUAL`, which is the point of tagging.

## 4. Structure

### 4.1 Files

```
docs/qa/
  README.md            how to run a pass · environments · seed accounts · defect template · sign-off
  personas.md          9 personas · credentials · the 5 × 25 permission matrix
  01-marketing.md      MKT   5 journeys   ~20 cases
  02-storefront.md     SF   14 journeys   ~90 cases
  03-dashboard.md      DSH  24 journeys  ~115 cases
  04-admin-console.md  ADM   7 journeys   ~25 cases
  05-pos.md            POS  18 journeys   101 cases  ← written
  06-whatsapp.md       WA   10 journeys   ~40 cases
  99-cross-cutting.md  XC    7 journeys   ~45 cases
```

85 journeys, 420 cases. These per-file counts are the budget, not a quota: a
journey gets the cases its risk earns. If a file needs to run over, it takes
the room from the total rather than padding elsewhere. `05-pos.md` is written
and came in at 101 against a budget of 85 — the overrun is in the refund and
drawer-close guards, where each guard is a distinct way to lose money.

### 4.2 Case IDs

`<SURFACE>-<JOURNEY>-<NNN>` — for example `SF-CHK-014`, `POS-DRW-003`,
`DSH-INV-021`.

IDs are **append-only and never reused**. A retired case is struck through with
its ID kept, so an old bug report still resolves. Numbering is per journey and
starts at `001`.

### 4.3 Journey block

Every journey renders the same way:

```markdown
### POS-DRW — Opening and skipping the cash drawer

**Persona:** Nadia (cashier) · **Goal:** start a till session that can take cash
**Preconditions:** POS paired to Roma / Main branch · no shift currently open

The POS asks about the drawer once, after cashier sign-in and before the tabs
appear. Nadia counts the float, enters it by denomination, and opens the
drawer. A cashier selling card-only can skip the prompt instead — the app
allows it and the server then refuses cash tenders, which is the behaviour to
confirm rather than treat as a bug.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-DRW-001 | Drawer prompt appears once after cashier sign-in | happy | P1 | MANUAL | 1. … | … |
```

Narrative first, because a case table alone tells QA what to click but not what
the feature is *for* — and a tester who understands intent finds bugs the table
never listed.

### 4.4 Column vocabulary

| Column | Values |
|--------|--------|
| `Type` | `happy` · `edge` · `negative` · `permission` · `i18n` · `responsive` |
| `Pri` | `P1` release blocker (money, data loss, permission or tenancy failure) · `P2` functional defect with a workaround |
| `Auto` | `AUTOMATED (spec.ts › test name)` · `PARTIAL (what is left manual)` · `MANUAL` |

`Steps` are numbered and imperative. `Expected` states the observable result —
a message, a status, a number — never "works correctly".

## 5. Test data

The pack runs against the QA environment (`qa.serveos.tech`) or a local seed;
both come from `npm run db:seed`, so the accounts in `docs/references/environments.md`
and the README table hold. `personas.md` maps each persona to a seeded account
and states what still has to be created by hand.

Two seeding commands cover almost everything, which is better than this spec
first assumed:

| Command | Creates |
|---------|---------|
| `npm run db:seed` | platform super admin, `roma` (restaurant) with owner/manager/staff |
| `npm run demo:seed` | one tenant per vertical — `demo-restaurant`, `demo-retail`, `demo-pharmacy`, `demo-timber`, each with an owner and a seeded catalogue, orders and order history |

So the four-vertical storefront journeys need **no** manual register → approve
flow. `demo:seed` also supports `--reset` to drop and rebuild each demo tenant.

Genuine gaps that remain:

1. **No `pharmacist` user is seeded anywhere.** `rx:review` journeys need one
   created by hand through `DSH-STAFF` (staff invite + role assignment) on
   `demo-pharmacy`. The storefront and dashboard files state this at the top.
2. **POS journeys need a paired device.** Pairing is `POS-PAIR`, so `05-pos.md`
   is ordered to be executed top to bottom.
3. **WhatsApp needs no Meta number.** `scripts/whatsapp-sandbox.ts` walks the
   real reducer, runner, advisory lock and database writes in a terminal, with
   only the provider substituted for one that prints instead of sends — a
   confirmed pickup order lands on the `whatsapp` channel for real. The `WA`
   file uses the sandbox as its primary harness, so no case is
   environment-blocked. A `pro`-or-above plan is still required
   (`whatsapp_numbers: 0` on basic).

## 6. Non-goals

- **No new automation.** The pack tags what is automated; converting `MANUAL`
  cases into Playwright specs is separate, prioritised work that the tags feed.
- **No unbuilt features.** Per Q3.
- **No test-management tool import.** Markdown is the format of record. The
  table shape is CSV-convertible if a tool is adopted later, but no exporter
  ships here.
- **No load, penetration or accessibility audit.** Functional and permission
  testing only. A11y beyond tap-target and RTL spot checks needs its own pass.
- **No roadmap edit.** §3.1 documents the drift; correcting `ROADMAP.md` is a
  separate task.

## 7. Deliverables

1. `docs/qa/` — 10 files as laid out in §4.1.
2. A GitHub epic, `QA: user journeys and test scenarios for all surfaces`, on
   project board #10.
3. Six child issues, one per surface, each linking its file and carrying that
   file's journey list as a checklist.

## 8. Definition of done

- Every one of the 84 journeys has a narrative and at least one `P1` case.
- Every case has steps, an expected result, a type, a priority and an
  automation tag — no blanks, no `TBD`.
- Every `AUTOMATED` tag names a real spec file and test title in `tests/e2e/`.
- Every expected result was checked against the code path that produces it, not
  inferred from the UI or from a design doc. Where code and design doc disagree,
  the pack records both and files a question.
- The epic and six children exist on board #10 with the epic as parent.

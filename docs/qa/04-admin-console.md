# QA — Platform admin console

**Surface code:** `ADM` · **Host:** `admin.serveos.tech`
**Persona:** platform admin (`super_admin`) — `admin@serveos.com` / `admin1234`
**Last verified against code:** 2026-08-17

ServeOS staff looking at ServeOS itself: who has applied, who is trading, who
owes money, and what everyone did. Small surface, high stakes — every action
here changes whether a paying business can serve customers, so almost everything
in this file is P1.

The `super_admin` role holds **exactly three** permissions —
`platform:approve_tenant`, `platform:suspend_tenant`, `platform:view_revenue` —
and **no tenant permissions at all**. The reverse also holds: an owner has no
platform permission. That separation is the single most important thing on this
surface and it gets its own cases in both directions.

---

## How to run this file

```bash
npm run db:seed        # platform admin + roma
npm run demo:seed      # more tenants to filter and act on
npm run dev
```

Open `http://admin.serveos.localhost:3000/admin/login`.

Run `ADM-LOGIN` and `ADM-NOACC` first — they establish the two session lanes
every later journey assumes. `ADM-SUSP` takes a storefront down, so run it after
`ADM-TEN` and reactivate before moving to the storefront file.

### Console navigation

Five items, from `AdminNav`: **Overview**, **Approvals**, **Billing**,
**Tenants**, **Audit**. Every page calls `requireSuperAdminOrRedirect()` — never
bare `requireSuperAdmin` — because layouts and pages render in parallel, so a
layout that caught the error alone would not stop a sibling page throwing an
unhandled render error.

### The state machines this file drives

| Thing | States | Set by |
|---|---|---|
| Tenant | `active` · `suspended` · `rejected` | approve / reject / suspend / reactivate |
| Onboarding application | `pending` · `approved` · `rejected` | approve / reject |
| Storefront servability | servable when tenant is `active` or `trial` | `isTenantServable` |

`isTenantServable` is what connects this surface to the customer's experience:
suspending a tenant here takes their public shop offline. That link is
`ADM-SUSP-003`, and it is the case most worth running end to end.

---

## ADM-LOGIN — Signing in to the console

**Goal:** only platform staff get a session, and nobody gets a useless one

The important design decision is *when* authorization is checked:
`authenticatePlatformAdmin` verifies the `super_admin` role **before any session
exists**. Issuing a cookie to someone without the role would produce an account
that signs in successfully and is then refused by every `/admin` page — an
endless bounce back to a clean login form. That failure mode caused a production
outage, so the ordering is deliberate and worth protecting.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| ADM-LOGIN-001 | Platform admin signs in and reaches Overview | happy | P1 | AUTOMATED (`admin.spec.ts › platform admin signs in and reaches the console`) | 1. Open `/admin/login`. 2. Enter `admin@serveos.com` / `admin1234`. 3. Submit. | Lands on `/admin` with the "Overview" heading visible. The page renders — it does not error. |
| ADM-LOGIN-002 | A tenant owner is refused at the form, not after | permission | P1 | AUTOMATED (`admin.spec.ts › a non-admin platform account is told why…`) | 1. At `/admin/login` enter `owner@roma.com` / `owner1234`. 2. Submit. | Stays on `/admin/login?error=…` with a message. **No session cookie is issued** — check that the browser has no new `serveos_session`. The visitor is never handed a session that every admin page then refuses. |
| ADM-LOGIN-003 | A wrong password is refused generically | negative | P1 | MANUAL | 1. Enter `admin@serveos.com` with password `wrong`. | `Invalid email or password.` — the message does not distinguish a wrong password from an unknown email. |
| ADM-LOGIN-004 | A real account lacking the role gets a distinct message | permission | P1 | MANUAL | 1. Create a platform user (null `tenantId`) with no `super_admin` role. 2. Sign in at `/admin/login`. | Redirects to `/admin/login?error=not_admin` and reads "That account is not a platform admin. Retyping the password will not help — it needs the super admin role." The wording explicitly tells them retrying is pointless. |
| ADM-LOGIN-005 | Signed out, every console page routes to the login form | permission | P1 | MANUAL | 1. Clear cookies. 2. Request `/admin`, `/admin/approvals`, `/admin/billing`, `/admin/tenants`, `/admin/audit` in turn. | Each redirects to `/admin/login`. None renders content, and none shows a raw error page. |

---

## ADM-NOACC — The no-access page

**Goal:** a signed-in tenant user is explained to, not interrogated

The session cookie is scoped to `/`, so a dashboard session genuinely reaches
`/admin`. Bouncing that visitor to the admin login form would reject their
*correct* credentials with "Invalid email or password" — a false statement that
reads as a broken login rather than a missing permission. So they get an
explanation and two useful exits instead.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| ADM-NOACC-001 | A signed-in tenant user gets an explanation | permission | P1 | AUTOMATED (`admin.spec.ts › a tenant user visiting /admin gets an explanation, not the login form`) | 1. Sign in at `/login` as `owner@roma.com` (slug `roma`). 2. Navigate to `/admin`. | Redirects to `/admin/no-access` showing "No platform access". **Not** the login form, and no password prompt. |
| ADM-NOACC-002 | The page offers both useful exits | happy | P2 | MANUAL | 1. Reach `/admin/no-access`. | Two links: "Go to your dashboard →" pointing at `/dashboard`, and "Sign in with an admin account →" pointing at `/admin/login`. Both work. |
| ADM-NOACC-003 | A tenant session cannot read any console data | permission | P1 | MANUAL | 1. As `owner@roma.com`, request `/admin/tenants`, `/admin/billing` and `/admin/audit` directly. | Each redirects to `/admin/no-access`. No tenant list, no revenue figure and no audit row is rendered at any point. |

---

## ADM-OVER — The overview

**Goal:** the landing page tells staff the state of the platform at a glance
**Preconditions:** `demo:seed` run, so there is more than one tenant

Six aggregations: tenants by status, signups over 30 days, MRR, MRR trend over
30 days, trials ending within 7 days, and pending applications, plus recent
audit activity. Three charts render from them.

This page is called out in its own automated test because **it is the page that
threw in production** — so "it renders at all" is a real assertion, not a
formality.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| ADM-OVER-001 | The overview renders every stat and chart | happy | P1 | PARTIAL (`admin.spec.ts` asserts the heading renders, not the contents) | 1. Open `/admin`. | Tenant-status counts, 30-day signups, MRR, trials ending within 7 days and pending-application count all render as numbers. The signup, MRR and status charts all draw. No empty or errored chart frames. |
| ADM-OVER-002 | Counts agree with the tenants list | edge | P1 | MANUAL | 1. Note the by-status counts on Overview. 2. Filter `/admin/tenants` by each status and count rows. | The numbers match. A drift here means one of the two queries is wrong. |
| ADM-OVER-003 | MRR reflects only paying subscriptions | edge | P2 | MANUAL | 1. Note MRR. 2. Cancel a paid tenant's subscription (`ADM-BILL-004`). 3. Reload Overview. | MRR falls by that plan's monthly price. A tenant on the free `basic` plan contributes nothing. |
| ADM-OVER-004 | A fresh platform renders zeroes, not errors | edge | P2 | MANUAL | 1. On a database with no tenants, open `/admin`. | Stats read `0`. Charts render empty axes rather than throwing. This is the exact shape of the production failure, so it is worth reproducing deliberately. |

---

## ADM-APPR — Approving and rejecting applications

**Goal:** a new business is let in, or turned away with a reason
**Preconditions:** at least one `pending` application — create one via `DSH-REG`

Approval is one transaction that moves **two** rows: the tenant becomes `active`
and the application becomes `approved` with the reviewing admin recorded. A
platform `audit_logs` row is written in the same transaction. Rejection mirrors
it, and additionally stores `reviewNotes`.

The two-row atomicity is the thing to probe: a tenant that went `active` while
its application stayed `pending` would re-appear in the queue forever.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| ADM-APPR-001 | A pending application is listed | happy | P1 | MANUAL | 1. Register a new tenant (`DSH-REG`). 2. Open `/admin/approvals`. | The application appears with the business name and its details. |
| ADM-APPR-002 | Approving activates the tenant and clears the queue | happy | P1 | MANUAL | 1. Press "Approve". | The row leaves the queue. The tenant's status is `active` on `/admin/tenants` and the application is `approved` with `reviewedBy` set to this admin. |
| ADM-APPR-003 | An approved tenant's storefront goes live | happy | P1 | MANUAL | 1. Before approving, open the tenant's storefront — note it is not servable. 2. Approve. 3. Reload the storefront. | Before: a "getting ready" message. After: the storefront serves. This is `isTenantServable` flipping. |
| ADM-APPR-004 | Rejecting records the reason | happy | P1 | MANUAL | 1. Press "Reject" on a pending application, supplying notes. | The tenant's status is `rejected`, the application is `rejected`, `reviewNotes` holds the text and `reviewedBy` names this admin. |
| ADM-APPR-005 | A rejected tenant cannot serve a storefront | permission | P1 | MANUAL | 1. Open the rejected tenant's storefront host. | Not servable — the "getting ready" state, never the catalogue. `isTenantServable` accepts only `active` and `trial`. |
| ADM-APPR-006 | Both actions write a platform audit row | edge | P1 | MANUAL | 1. Approve one application and reject another. 2. Open `/admin/audit`. | Two rows, each naming the action, the target tenant and the acting admin. Written in the same transaction as the status change — there is no approved tenant without its audit row. |
| ADM-APPR-007 | An empty queue says so | edge | P2 | MANUAL | 1. Clear all pending applications. 2. Open `/admin/approvals`. | An empty state renders. No error and no bare table header. |

---

## ADM-TEN — The tenants list and detail

**Goal:** find any business on the platform and see its real state

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| ADM-TEN-001 | Every tenant is listed with status and plan | happy | P1 | MANUAL | 1. Open `/admin/tenants`. | All tenants appear, each with tenant status, plan name and subscription status. |
| ADM-TEN-002 | Filtering by status narrows the list | happy | P2 | MANUAL | 1. Filter by `active`, then `suspended`, then `rejected`. | Only matching tenants appear in each case. Counts agree with Overview (`ADM-OVER-002`). |
| ADM-TEN-003 | Pagination works past one page | edge | P2 | MANUAL | 1. With more tenants than fit one page, use the pager. | Next and previous both work and no tenant is duplicated or skipped across pages. |
| ADM-TEN-004 | Tenant detail shows status, plan, subscription and recent audit | happy | P1 | MANUAL | 1. Open a tenant's detail page. | Three badges — tenant status, plan name, subscription status — plus the tenant's recent platform audit entries. The "← All tenants" link returns to the list. |

---

## ADM-SUSP — Suspending and reactivating

**Goal:** take a business offline, and put it back
**Preconditions:** an `active` tenant with a live storefront

Suspension is the console's sharpest tool: it flips the tenant to `suspended`,
which fails `isTenantServable`, which takes the public storefront down. Run this
end to end — checking the storefront, not just the badge — because the badge
changing while the shop stayed up would be the worst possible outcome to miss.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| ADM-SUSP-001 | Suspending sets the status and confirms | happy | P1 | MANUAL | 1. On tenant detail, press Suspend. | Confirmation reads "Tenant suspended". The status badge becomes `suspended` in the destructive style. |
| ADM-SUSP-002 | Suspension is audited | edge | P1 | MANUAL | 1. After suspending, open `/admin/audit`. | A row names the suspend action, the target tenant and this admin. |
| ADM-SUSP-003 | A suspended tenant's storefront goes offline | permission | P1 | MANUAL | 1. Confirm the storefront serves. 2. Suspend the tenant. 3. Reload the storefront. | The catalogue is gone, replaced by the tenant's "getting ready" state. No products, no cart, no checkout. |
| ADM-SUSP-004 | Reactivating restores service | happy | P1 | MANUAL | 1. Press Reactivate on the suspended tenant. 2. Reload the storefront. | Confirmation reads "Tenant reactivated", status returns to `active`, and the storefront serves its catalogue again. |
| ADM-SUSP-005 | A suspended tenant's staff cannot trade | permission | P1 | MANUAL | 1. Suspend `roma`. 2. Attempt to sign in to the dashboard as `owner@roma.com`, and to ring a sale on a paired POS. | Neither surface lets the tenant transact. Record the exact behaviour of each — if the dashboard still allows ordinary operation while the storefront is down, that is a **finding**, so capture what happens rather than assuming it is blocked. |

---

## ADM-BILL — Billing and subscriptions

**Goal:** confirm a manual payment, and correct a subscription by hand
**Preconditions:** a tenant with a submitted payment proof — see `DSH-BILL`

Billing is manual: there is no payment gateway (roadmap Spec 6 is parked). A
tenant submits a reference and proof; an admin verifies and marks it paid. The
tenant-detail page also carries three override actions — force active, mark
paid, cancel subscription — which exist precisely because the billing provider
is manual today.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| ADM-BILL-001 | Pending invoices are listed with their proof | happy | P1 | MANUAL | 1. Open `/admin/billing`. | A table of invoices awaiting verification: tenant, amount, reference, proof, submitted date, actions. The proof is openable. |
| ADM-BILL-002 | Marking an invoice paid clears it from the queue | happy | P1 | MANUAL | 1. Press the mark-paid action on an invoice. | It leaves the pending queue. The tenant's subscription reflects the payment on their detail page and on `DSH-BILL`. |
| ADM-BILL-003 | Force-active overrides an unpaid subscription | edge | P1 | MANUAL | 1. On a tenant whose subscription is not active, press Force active. | The subscription becomes active. The tenant regains entitlements. An audit row records the override — this is an admin overriding the money, so it must be attributable. |
| ADM-BILL-004 | Cancelling a subscription removes entitlements | edge | P1 | MANUAL | 1. On a Pro tenant, press Cancel subscription. 2. Check a Pro-only feature (e.g. WhatsApp settings). | The subscription is cancelled and Pro-only features are refused with the feature-unavailable error, not a crash. |
| ADM-BILL-005 | An empty billing queue says so | edge | P2 | MANUAL | 1. With no invoices awaiting verification, open `/admin/billing`. | An empty state renders rather than a bare table header. |

---

## ADM-AUD — The platform audit log

**Goal:** every platform action is attributable and findable

This is the **platform** audit log (`audit_logs`), written only by super-admin
actions and deliberately kept **separate** from the tenant-side hash-chained
`audit_events` that `DSH-AUD` covers. Confusing the two is the likeliest tester
mistake on this surface: a tenant's own activity does not appear here, and
platform actions do not appear in the tenant's audit page.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| ADM-AUD-001 | Actions appear newest first with actor and target | happy | P1 | MANUAL | 1. Perform an approve, a suspend and a reactivate. 2. Open `/admin/audit`. | All three appear, newest first, each naming the action, the target tenant and the acting admin. |
| ADM-AUD-002 | Filters narrow by action, tenant and date | happy | P2 | MANUAL | 1. Filter by a single action, then by a single tenant, then by a date range. | Each filter returns only matching rows. Combining filters intersects them. |
| ADM-AUD-003 | Tenant-side activity does **not** appear here | edge | P1 | MANUAL | 1. Ring a POS sale and apply a discount as a tenant user. 2. Search `/admin/audit` for it. | Neither appears. They belong to the tenant's own hash-chained `audit_events`, visible at `/dashboard/audit`. The two logs are separate by design. |
| ADM-AUD-004 | The log is read-only | permission | P1 | MANUAL | 1. Look for any edit or delete affordance on an audit row. 2. Attempt a delete via the API if one is guessable. | No affordance exists and no deletion succeeds. An audit log that can be edited is not an audit log. |

---

## Coverage summary

| Journey | Cases | P1 | Automated |
|---|---|---|---|
| ADM-LOGIN sign-in | 5 | 5 | 2 |
| ADM-NOACC no-access | 3 | 2 | 1 |
| ADM-OVER overview | 4 | 2 | 0 |
| ADM-APPR approvals | 7 | 6 | 0 |
| ADM-TEN tenants | 4 | 2 | 0 |
| ADM-SUSP suspend/reactivate | 5 | 5 | 0 |
| ADM-BILL billing | 5 | 4 | 0 |
| ADM-AUD audit log | 4 | 3 | 0 |
| **Total** | **37** | **29** | **3** |

37 cases against a budget of 25. The overrun is in `ADM-APPR` and `ADM-SUSP`,
where each action changes whether a real business can serve customers and the
storefront-side effect needs verifying separately from the status badge.

**Only 3 cases are automated**, all three in the auth lanes — and notably the
three the existing spec covers are exactly the ones that caused a production
outage. Everything that *changes* platform state (approve, reject, suspend,
mark-paid, cancel) is manual. Those are the strongest automation candidates on
this surface, `ADM-APPR-002`/`003` and `ADM-SUSP-003` first, since they span the
console and the storefront in one flow.

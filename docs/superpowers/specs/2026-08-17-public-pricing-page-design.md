# Public pricing page, and the subscribe fork that sends prospects into a demo tenant

**Date:** 2026-08-17
**Status:** approved, ready for an implementation plan

## The problem

Clicking a paid plan on the marketing site takes the visitor to
`/dashboard/settings/billing?plan=enterprise` — a logged-in tenant dashboard.
When the visitor had previously opened a demo, that dashboard belongs to
**El Salam Pharmacy**, the seeded `demo-pharmacy` tenant, complete with its usage
meters and a Subscribe button that would raise an invoice against a throwaway
tenant reset nightly.

This is not a broken implementation. `/subscribe` behaves exactly as specified,
and `docs/qa/01-marketing.md` (MKT-SUB-002) documents the behaviour as correct:
*"Signed in, a paid plan CTA goes straight to billing… No login step."* The spec
never accounted for the marketing page handing out a real session one click
earlier, via `/api/demo/login`.

Three distinct defects sit behind the one symptom:

| # | Defect | Who hits it |
|---|---|---|
| 1 | A demo session counts as "a customer", so prospects land in a throwaway tenant's billing page | anyone who opened the demo first |
| 2 | A signed-out prospect is sent to `/login`, not `/register` — the wrong door for someone with no account, while the *free* plan correctly goes to `/register` | every new visitor |
| 3 | There is no public pricing page at all; pricing exists only as a section on the marketing home page, so "send me your pricing" has no link to send | everyone |

`?plan=enterprise` rendering as "Professional" is *not* a defect: `enterprise` is
the plan key, "Professional" its English label (`_content/pricing.ts`). It only
reads as a mismatch in the URL.

## Goals

- A public, linkable, indexable pricing page in both locales.
- A paid CTA that never delivers a prospect into a tenant dashboard.
- One source of truth for prices, so the page and the home section cannot disagree.

## Non-goals

- Card checkout. Subscribing raises an invoice; the owner uploads proof and an
  admin verifies it (`dashboard/settings/billing/actions.ts`). That flow is
  unchanged here.
- Automatically raising an invoice on signup. Being charged stays an explicit act
  on the billing page — the principle already written into `subscribe/page.tsx`.
- Any change to plan pricing, limits, or the plans themselves.

## Approach

The page lives inside the marketing route group and reuses the existing pricing
components, rather than standing alone outside it.

The decisive reason is a single source of truth for prices. Reusing `PlanCard`
means a plan change cannot make the home section and the pricing page quote
different numbers — the classic way a pricing page starts lying. A standalone
route would also sit outside the `[lang]` segment, giving up the header, footer,
Arabic-default URL scheme and locale handling on the one page most likely to be
shared and indexed.

Rejected alternatives: a top-level `/pricing` outside the marketing group
(hand-rolled chrome and locale on the most-shared page); expanding pricing in
place on the home page (nothing to link — and a link is the actual requirement).

## Section 1 — Routing and locale

Route: `src/app/(marketing)/[lang]/pricing/page.tsx`. It inherits the `[lang]`
layout, including the `HtmlLocale` component, so `dir`/`lang` stay correct on a
soft navigation into and out of the page.

URLs mirror the existing scheme:

| URL | Locale | Mechanism | Status |
|---|---|---|---|
| `/pricing` | Arabic (canonical) | rewrite → `/ar/pricing` | **needs the change below** |
| `/en/pricing` | English | passes through | already handled by the `/en/*` rule |
| `/ar/pricing` | — | redirects → `/pricing` | already handled by the `/ar/*` rule |

`marketingLocaleAction` currently returns `{ kind: "none" }` for `/pricing`,
which would 404 it. The fix is an explicit allowlist, checked before the final
fallthrough:

```ts
const MARKETING_PATHS = new Set(["/pricing"]);
// ...before returning { kind: "none" }:
if (MARKETING_PATHS.has(pathname)) {
  return { kind: "rewrite", pathname: `/ar${pathname}`, locale: "ar" };
}
```

It must be an allowlist and not "rewrite anything unmatched". That fallthrough is
what keeps `/login`, `/register`, `/api/health`, `/article` and `/enroll` out of
the marketing segment, and `marketing-locale.test.ts` asserts each of them
returns `none`. A catch-all would break sign-in.

The page carries the same `x-surface !== "marketing" → notFound()` guard as the
home page, so it is unreachable on a tenant or admin host, and
`generateMetadata` mirrors the home page's canonical + `hreflang` alternates as
`ar: /pricing`, `en: /en/pricing`.

## Section 2 — The conversion path

Every plan CTA — on the home section and on `/pricing` — points at
`/subscribe?plan=<key>`. Keeping the fork in one route is why this was a
one-file defect rather than a hunt; splitting the rules across two pages is how
they drift.

### Corrected fork rules

Implemented in `subscribe/page.tsx`:

| Visitor | Destination | Today |
|---|---|---|
| Real customer (session + `tenantId`, slug **not** `demo-*`) | `/dashboard/settings/billing?plan=X` | unchanged — always correct |
| Demo session (`isDemoSlug(tenant.slug)`) | `/register?plan=X` | ❌ demo tenant's billing page |
| Signed out | `/register?plan=X` | ❌ `/login` |
| Unknown or absent plan key | `/pricing` | ❌ bare billing page |

Demo detection reuses `isDemoSlug()` from `src/server/demo/entry.ts` — the same
guard `/api/demo/login` trusts, so the two cannot drift on what "demo" means.
This requires resolving the tenant slug from `tenantId`; `validateSession`
returns the id only.

The rules are extracted into a pure `subscribeDestination()` function, leaving
`page.tsx` a thin wrapper. Rules that live inside a redirect-only server
component are otherwise testable only through a browser.

### Carrying the plan through registration

1. `/register?plan=<key>` — validated against `listPlans()`, the same guard
   `/subscribe` applies. An invalid key is ignored, never carried.
2. `RegisterForm` holds it as a hidden field.
3. `register/actions.ts` redirects to `/dashboard/settings/billing?plan=<key>`
   on success, instead of the currently hard-coded `/dashboard`.

A validated `plan` key is used rather than the general `next` pattern that login
uses. `next` is an open-redirect surface requiring the `safeNext` guard; a plan
key is a closed set checked against the database, so there is nothing to escape.

The **Free plan keeps going to plain `/register`** → `/dashboard`. Carrying
`?plan=basic` would land a new signup on a billing page highlighting the plan
they already have.

Nothing in this path raises an invoice.

## Section 3 — Page composition

Content, in order: plan cards with the term switcher; the full limits and
features comparison; how payment actually works; a pricing FAQ.

The **payment block** states plainly that a plan is chosen inside the dashboard,
an invoice is raised, the owner uploads proof of payment, and an admin verifies
it — there is no card checkout. This exists for the same reason the feature grid
marks unshipped features rather than hiding them: a pricing page that implies
instant card payment is selling something that does not ship.

### The home page pricing section

The home section keeps its four plan cards and term switcher — they work and they
sell, and the page has just been through a motion fix. Two changes only:

- its CTAs route through the corrected `/subscribe?plan=<key>` fork, like the
  pricing page's;
- a "compare all plans" link points at `/pricing` for the full limits and
  feature comparison, which is the detail the home cards cannot show well.

`/pricing` does not replace the home section; it is where the detail lives.

**Reused unchanged:** `PricingTerms`, `PlanCard`, the `PRICING` content, and
`formatEgp` / `monthlyEquivalent` / `termTotal`.

**Refactored:** `Faq` currently hard-binds to `FAQ[locale]` and hard-codes
`id="faq"`. It takes its content and id as props instead — home passes
`FAQ[locale]`, pricing passes `PRICING[locale].faq`. The alternative is a
near-duplicate FAQ component, which is how two FAQ styles drift apart.

**New:** `PlanComparison.tsx`, a server component taking `{ plans, locale }`. Rows
are built from the same `PRICING[locale].limits` / `.features` label maps that
`PlanCard` uses, reading values off `plan.limits` / `plan.features` — the same
database rows the cards render, so the table cannot contradict them.

Two existing rules it must inherit:

- **Zero-valued limits render as "—", never "0".** `PlanCard` filters them out
  because "0 WhatsApp numbers" is not a benefit; a comparison table is the
  easiest place to reintroduce that mistake.
- **Unshipped features stay marked**, per the rule `marketing.spec.ts` already
  enforces on the feature grid.

Five columns do not fit a phone, so the table scrolls horizontally inside its own
container. The page body must never scroll sideways.

New content (`faq`, the payment explainer) goes in `_content/pricing.ts`, so
`_content/parity.test.ts` covers it automatically — it compares Arabic/English
key paths for `PRICING`, meaning a missing Arabic string fails the suite rather
than shipping half-translated.

## Testing

**Unit**

- `subscribeDestination()` — all four rows of the fork table.
- `marketingLocaleAction` — `/pricing` rewrites to `/ar/pricing`; and the
  regression that `/login`, `/register` and `/api/health` still return `none`.
  That regression is the allowlist's entire risk.
- Register redirect target for a valid, invalid, and absent plan key.
- Content parity picks up the new strings automatically.

**E2E** — `tests/e2e/pricing.spec.ts`

- `/pricing` serves Arabic RTL; `/en/pricing` serves English LTR.
- The comparison table renders a row per limit and per feature.
- A signed-out paid CTA lands on `/register?plan=<key>`.
- `/login` and `/register` still load — guards the allowlist change.
- **The regression that matters:** open `/api/demo/login?trade=pharmacy`, return
  to `/pricing`, click a paid CTA, and assert it lands on `/register` and never
  on a billing page. This is the reported defect; without this test nothing stops
  it returning.

## Risks

- **The allowlist change touches sign-in routing.** Mitigated by keeping it an
  allowlist and by the explicit `none` regression tests above.
- **Demo detection depends on the `demo-` slug prefix.** Acceptable because
  `isDemoSlug()` is already the sole guard protecting the public demo login from
  reaching a real tenant; if that assumption breaks, a much more serious bug
  exists already.
- **A comparison table is a new place for prices to be stated.** Mitigated by
  deriving every value from the same `plan` rows the cards use, never from
  hardcoded copy.

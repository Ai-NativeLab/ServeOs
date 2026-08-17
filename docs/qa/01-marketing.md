# QA — Marketing site

**Surface code:** `MKT` · **Host:** `www.serveos.tech` (and the bare root domain)
**Persona:** prospect — never signed in · see [personas.md](personas.md)
**Last verified against code:** 2026-08-17

The public shop window: one long page that re-skins itself per trade, in Arabic
or English, ending in either a demo door or a pricing table. It is the most
heavily automated surface in the pack — 11 of the suite's 43 Playwright tests
live here — so most of this file is `AUTOMATED` and the manual effort goes to
the demo door, the subscribe fork and the honesty claims.

> **This surface was rebuilt in PR #137** (`worktree-marketing-site`). It is now
> Arabic-first with `[lang]` routing, and it grew a demo band, a pricing term
> switcher and a subscribe fork. The design spec budgeted 5 journeys for the old
> single-page version; the rebuilt surface needs 8.

---

## How to run this file

```bash
npm run db:seed        # plans must exist or the pricing section has no rows
npm run demo:seed      # required for MKT-DEMO — creates the four demo tenants
npm run dev
```

Open `http://serveos.localhost:3000` (or `www.serveos.localhost:3000`). Both
classify as `marketing`; a tenant slug host does **not** — that separation is
`XC-ISO`.

### Locale routing

Marketing is the only surface with locale prefixes, because `/` is shared: on a
tenant host it is a storefront, on the root domain it is marketing. So the
prefix is applied by `marketingLocaleAction` only after `classifyHost` has
returned `marketing`.

| URL | Action | Locale | `<html>` |
|---|---|---|---|
| `/` | rewrite → `/ar` | ar | `lang="ar" dir="rtl"` |
| `/en`, `/en/…` | pass through | en | `lang="en" dir="ltr"` |
| `/ar` | **redirect → `/`** | — | — |
| `/ar/foo` | **redirect → `/foo`** | — | — |

**Arabic is the default and keeps the bare URL.** Each language has exactly one
canonical URL, which is why `/ar` redirects rather than rendering.

### Trades

Four, from `TRADE_CONTENT` — restaurant, retail, pharmacy, timber. Each supplies
its own label, badge, headline lead, subhead, feature grid, steps and a sample
docket. One thing is deliberately identical across all four: the headline
highlight (`HEADLINE_HIGHLIGHT`) — "Create your own in 1 minute." /
"أنشئ موقعك في دقيقة واحدة." The promise does not change with the shop.

---

## MKT-LANG — Language and direction

**Goal:** land on the right language, in the right direction, with no flash

Arabic is server-rendered at the bare URL. The no-JavaScript case is not
pedantry: it is the only way to *prove* there is no client-side language flash,
because a rendering that is already correct with scripting off cannot have been
corrected by a script.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| MKT-LANG-001 | The bare URL serves Arabic, right-to-left | i18n | P1 | AUTOMATED (`marketing.spec.ts › the homepage is Arabic and right-to-left in the served HTML`) | 1. Open `/`. 2. Inspect `<html>`. | `lang="ar"` and `dir="rtl"`. The H1 contains `أنشئ موقعك في دقيقة واحدة.` |
| MKT-LANG-002 | Arabic renders with JavaScript disabled | i18n | P1 | AUTOMATED (`marketing.spec.ts › Arabic ships without JavaScript…`) | 1. Disable JavaScript. 2. Open `/`. | Still `dir="rtl"` and the Arabic H1. No English is visible at any point — proving the direction is not corrected client-side. |
| MKT-LANG-003 | `/en` serves English, left-to-right | i18n | P1 | AUTOMATED (`marketing.spec.ts › /en serves English left-to-right`) | 1. Open `/en`. | `lang="en"`, `dir="ltr"`, H1 contains `Create your own in 1 minute.` |
| MKT-LANG-004 | `/ar` redirects to the canonical root | i18n | P2 | AUTOMATED (`marketing.spec.ts › /ar redirects to the canonical root`) | 1. Open `/ar`. | The browser lands on `/`. Arabic has exactly one canonical URL. |
| MKT-LANG-005 | A nested `/ar/` path redirects with its path preserved | i18n | P2 | MANUAL | 1. Open `/ar/anything`. | Redirects to `/anything` — the `/ar` prefix is stripped, the rest of the path survives. |
| MKT-LANG-006 | Arabic layout does not overflow at 360px | responsive | P2 | PARTIAL (`responsive.spec.ts › public pages do not overflow` covers width, not RTL) | 1. At a 360px viewport open `/`. 2. Scroll the full page. | No horizontal scrollbar on `<body>`. Text and buttons mirror correctly — icons and chevrons point right-to-left, and nothing is clipped at the left edge. |

---

## MKT-HERO — The hero

**Goal:** the first screen states the offer for this trade

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| MKT-HERO-001 | The headline names the visitor's trade | happy | P1 | AUTOMATED (`marketing.spec.ts › switching trade re-copies…`) | 1. Open `/en` with Restaurant selected. | H1 reads `No restaurant website?` followed by `Create your own in 1 minute.` |
| MKT-HERO-002 | Both auth doors are reachable from the header | happy | P1 | MANUAL | 1. Open `/en`. 2. Find the header actions. | Links to register and to sign in are both present and resolve to the dashboard host, not to the marketing host. |
| MKT-HERO-003 | The live docket renders sample data, not an empty frame | happy | P2 | AUTOMATED (`marketing.spec.ts › switching trade re-copies…`) | 1. Open `/en`. 2. Locate `[data-testid="ticket"]`. | The docket shows the restaurant sample — including `Table 4` — with lines, a status and a total. |

---

## MKT-TRADE — The trade switcher

**Goal:** switching trade re-skins the page without breaking its layout

Four tabs re-copy the hero, the docket, the feature grid and the steps.
Restaurant is selected on load. The docket's **constant height** across all four
trades is an explicit layout guarantee: without it, switching tabs would jump
the page under the visitor's cursor, and it is easy to break by adding a line to
one trade's sample.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| MKT-TRADE-001 | Restaurant is selected on load | happy | P2 | AUTOMATED (`marketing.spec.ts › switching trade re-copies…`) | 1. Open `/en`. | The Restaurant tab has `aria-selected="true"`; the other three are false. |
| MKT-TRADE-002 | Switching trade re-copies hero and docket together | happy | P1 | AUTOMATED (`marketing.spec.ts › switching trade re-copies…`) | 1. Open `/en`. 2. Click the Timber tab. | H1 becomes `No timber yard website?` **and** the docket switches to the timber sample containing `Oak plank`. Both change — copy and sample must not drift apart. |
| MKT-TRADE-003 | Every trade re-skins its own accent and terminology | happy | P2 | MANUAL | 1. Cycle Restaurant → Retail → Pharmacy → Timber. | Each shows its own badge, subhead, feature set and steps. The trade's accent colour changes with it. The headline highlight stays identical across all four — that is by design. |
| MKT-TRADE-004 | The docket keeps one height across every trade | responsive | P1 | AUTOMATED (`marketing.spec.ts › the docket keeps one height across every trade`) | 1. Measure the docket's height on each of the four tabs. | All four heights are identical. The page does not jump when switching. |
| MKT-TRADE-005 | The switcher works in Arabic | i18n | P2 | MANUAL | 1. Open `/` (Arabic). 2. Switch through all four trades. | Arabic labels and copy for each trade; RTL layout holds; the docket height guarantee still holds. |

---

## MKT-FEAT — Feature honesty

**Goal:** never sell something that does not exist, and never hide something that does

`TradeFeature.roadmap` renders a "Soon" chip (`قريبًا` in Arabic). The rule in
the code is explicit: **do not clear a flag until the domain exists in
`src/server`.** The automated test is deliberately two-sided — it fails if the
site advertises vapour, and equally if it chips a feature that genuinely ships.
That second half is the one a manual tester is most likely to miss.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| MKT-FEAT-001 | An unbuilt feature carries a "Soon" chip | happy | P1 | AUTOMATED (`marketing.spec.ts › features the product does not ship yet are marked, not sold`) | 1. Open `/en`. 2. Select Pharmacy. 3. Find "Generic Substitutes". | The card carries a `Soon` chip. There is no implementation of it anywhere in `src/server`. |
| MKT-FEAT-002 | A shipped feature is **not** chipped | happy | P1 | AUTOMATED (same test) | 1. On Pharmacy, find "Batch & Expiry". | It carries **no** chip — it has `lotCode`/`expiryAt` schema and dashboard UI, so chipping it would under-sell something real. |
| MKT-FEAT-003 | The chip is translated | i18n | P2 | MANUAL | 1. Open `/` (Arabic). 2. Select Pharmacy. | The chip reads `قريبًا`, not `Soon`. |
| MKT-FEAT-004 | Every trade's roadmap flags match reality | edge | P1 | MANUAL | 1. For each of the four trades, list every feature card and whether it is chipped. 2. For each unchipped claim, confirm a corresponding domain exists under `src/server/`. | No unchipped card describes a feature with no server domain. Flag any mismatch as a **product-honesty** defect, not a copy defect — the marketing claim is the thing that is wrong. |

---

## MKT-DEMO — The demo band and the demo door

**Goal:** let a stranger into a real dashboard without letting them near real data
**Preconditions:** `npm run demo:seed` has run

This is the most security-sensitive thing on a public page in the whole product:
`/api/demo/login?trade=<trade>` **mints a real dashboard session for whoever
asks, with no credentials.** It is a deliberate design, and the safety comes
entirely from how narrowly it is scoped, so each guard deserves its own case.

Two independent guards keep it to the demo tenants: `trade` is validated against
`VERTICAL_IDS` so the slug is built from a closed set rather than from user
input, and the resolved tenant's slug is re-checked with `isDemoSlug` before a
token is minted. Row-level security contains everything after that. The session
is **2 hours**, against 30 days for a real login. Failures never reveal which
kind of failure they were.

Visitors *can* deface the demo — that is accepted, and undone nightly by
`.github/workflows/demo-reset.yml`.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| MKT-DEMO-001 | Every trade offers both doors | happy | P1 | AUTOMATED (`marketing.spec.ts › the demo band offers two doors for every trade`) | 1. Open `/en#demo`. | Exactly 4 "Open the storefront" links and 4 "Open the dashboard" links. The first dashboard link points at `/api/demo/login?trade=restaurant`. |
| MKT-DEMO-002 | The storefront door opens the demo shop | happy | P1 | MANUAL | 1. Click "Open the storefront" for Retail. | The `demo-retail` storefront loads with its seeded catalogue. No session is created — it is a plain public storefront. |
| MKT-DEMO-003 | The dashboard door signs the visitor in with no credentials | happy | P1 | MANUAL | 1. In a clean browser profile, click "Open the dashboard" for Restaurant. | Lands on `/dashboard` already signed in as the demo tenant's owner, with no login form. The seeded catalogue and orders are visible. |
| MKT-DEMO-004 | An unknown trade is a dead end, not an error | negative | P1 | MANUAL | 1. Request `/api/demo/login?trade=bakery`. | Redirects (303) to `/#demo?demo=unknown`. No session cookie is set. No stack trace or error page. |
| MKT-DEMO-005 | An unseeded trade fails identically | negative | P1 | MANUAL | 1. Delete the `demo-timber` tenant. 2. Request `/api/demo/login?trade=timber`. | Redirects to `/#demo?demo=unavailable`. Crucially, a tester cannot tell from the response whether the trade was invalid or merely unseeded — both are the same dead end. |
| MKT-DEMO-006 | A demo session cannot reach another tenant's data | permission | P1 | MANUAL | 1. Enter the demo dashboard for `demo-retail`. 2. Attempt to read another tenant's records — e.g. edit a URL to a `roma` order or product id. | Nothing from another tenant is returned. RLS scopes every query to the demo tenant, exactly as it does for a real user. |
| MKT-DEMO-007 | The demo session is short-lived | edge | P2 | MANUAL | 1. Enter the demo dashboard. 2. Inspect the session cookie's expiry. | Roughly 2 hours from now — not the 30 days a real login receives. |
| MKT-DEMO-008 | The shared-demo caveat is stated to the visitor | happy | P2 | MANUAL | 1. Read the demo band. | It says the demo is shared and resets daily — English "Shared demo — data resets to its original state daily.", Arabic equivalent. A visitor is not led to think their changes are private or permanent. |

---

## MKT-PRICE — Pricing and terms

**Goal:** show real plans at real prices, on a term the buyer chose

The pricing section is driven by **the actual `plans` table**, not by hardcoded
copy — so a plan seeded wrong shows up here. Terms are quarterly (default),
half-yearly (10% off) and annual (20% off). **There is no monthly term by
design:** quarterly is the minimum commitment.

The arithmetic is display-only. `termTotal = round(priceMonthly × months ×
(1 − discount))`, and the number buyers actually compare is
`monthlyEquivalent = round(termTotal ÷ months)`. What a subscription *records*
when a term is chosen belongs to the billing spec, not this page.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| MKT-PRICE-001 | Quarterly is preselected and Pro is shown | happy | P1 | AUTOMATED (`marketing.spec.ts › pricing renders plans and the term switcher changes the figure`) | 1. Open `/en#pricing`. | The Quarterly tab has `aria-selected="true"`. A Pro plan card is visible. |
| MKT-PRICE-002 | Switching term changes the figures | happy | P1 | AUTOMATED (same test) | 1. Click the Annual tab. | Annual becomes selected and the section's text changes — the displayed prices are recomputed, not static. |
| MKT-PRICE-003 | The discounts compute correctly | happy | P1 | MANUAL | 1. Read Pro (499/month) on each term. | Quarterly: 1497 total, 499/month. Half-yearly (10% off): `round(499×6×0.9)` = **2695** total, 449/month. Annual (20% off): `round(499×12×0.8)` = **4790** total, 399/month. Note both discounted totals round **up** from `.6`/`.4` fractions — an off-by-one here means the rounding was dropped. |
| MKT-PRICE-004 | No monthly term is offered | edge | P2 | MANUAL | 1. Inspect the term switcher. | Only three terms: quarterly, half-yearly, annual. The copy states quarterly is the minimum commitment. |
| MKT-PRICE-005 | The plans shown match the plans table | edge | P1 | MANUAL | 1. Compare the rendered cards against `plans` in the database. | Every active plan appears, with the seeded price: basic 0 (shown as free), pro 499, enterprise 1499. An extra or stale plan key rendering here is a **seed** defect — `seed-plans.ts` warns about exactly this. |
| MKT-PRICE-006 | The currency is stated | happy | P2 | AUTOMATED (`marketing.spec.ts › the footer carries every navigation column`) | 1. Read the footer. | It contains `Priced in EGP`. A visitor is never shown a bare number with no currency. |

---

## MKT-SUB — The subscribe fork

**Goal:** "I want to pay" leads somewhere useful whether or not you are signed in
**Preconditions:** an owner account exists for the signed-in half

A public page cannot know whether the visitor is signed in, but the right
destination differs entirely. `/subscribe?plan=<key>` is where that fork lives:
signed in goes to billing with the plan highlighted, signed out goes to login
carrying that billing URL as `next`. The plan key is **validated against the
real plan table** so an unknown key cannot ride through login and land on
billing highlighting nothing.

It deliberately creates nothing — raising an invoice is an explicit act on the
billing page, never a side effect of following a link.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| MKT-SUB-001 | Signed out, a paid plan CTA routes through login | happy | P1 | MANUAL | 1. Signed out, click the Pro plan CTA. | Lands on login with a `next` parameter pointing at the billing page for Pro. After signing in, billing opens with Pro highlighted. |
| MKT-SUB-002 | Signed in, a paid plan CTA goes straight to billing | happy | P1 | MANUAL | 1. Signed in as an owner, click the Enterprise CTA. | Billing opens directly with Enterprise highlighted. No login step. |
| MKT-SUB-003 | An unknown plan key is rejected, not carried | negative | P1 | MANUAL | 1. Open `/subscribe?plan=platinum`. | The unknown key is not honoured — the visitor is not delivered to billing highlighting a plan that does not exist. |
| MKT-SUB-004 | Following the CTA creates nothing | edge | P1 | MANUAL | 1. Note the tenant's subscription and invoices. 2. Follow a paid CTA through to billing. 3. Re-check. | No subscription change and no invoice. The link is navigation only. |

---

## MKT-NAV — Navigation, proof and FAQ

**Goal:** the page's supporting claims are honest and its navigation is complete

`#outcomes` must read as **illustrative** rather than attributed. Numbers on a
marketing page that look like real customer results, without a real customer
behind them, are the kind of claim that is legally and reputationally
expensive — hence a dedicated automated test.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| MKT-NAV-001 | The footer carries every navigation column | happy | P2 | AUTOMATED (`marketing.spec.ts › the footer carries every navigation column`) | 1. Inspect the footer. | Four labelled navigation groups: Platform, Trades, Pricing, Company. Each link resolves — no 404s. |
| MKT-NAV-002 | Outcomes are labelled illustrative, not attributed | happy | P1 | AUTOMATED (`marketing.spec.ts › outcomes are labelled as illustrative rather than attributed`) | 1. Read `#outcomes`. | It contains `Illustrative`. No figure is attributed to a named customer, and no testimonial is presented as real. |
| MKT-NAV-003 | The FAQ answers render in both languages | i18n | P2 | MANUAL | 1. Open the FAQ on `/en`, then on `/`. | Every question expands and its answer is fully translated — no English strings leaking into the Arabic page. |
| MKT-NAV-004 | The surface tour renders its screenshots | happy | P2 | MANUAL | 1. Scroll the surface tour band. | Each surface (storefront, dashboard, POS, admin) shows its screenshot. No broken image placeholders. |

---

## Coverage summary

| Journey | Cases | P1 | Automated |
|---|---|---|---|
| MKT-LANG language & direction | 6 | 3 | 4 |
| MKT-HERO hero | 3 | 2 | 2 |
| MKT-TRADE trade switcher | 5 | 2 | 3 |
| MKT-FEAT feature honesty | 4 | 3 | 2 |
| MKT-DEMO demo band & door | 8 | 6 | 1 |
| MKT-PRICE pricing & terms | 6 | 4 | 3 |
| MKT-SUB subscribe fork | 4 | 4 | 0 |
| MKT-NAV navigation & proof | 4 | 1 | 2 |
| **Total** | **40** | **25** | **17** |

40 cases against a design budget of 20 — the surface doubled in PR #137 and
grew a credential-less demo door that justifies 8 cases on its own.

**17 of 40 are automated**, the highest ratio in the pack. The manual effort
concentrates in three places, and they are the right three: the **demo door**
(`MKT-DEMO`, 6 P1 cases, 1 automated) because it hands out sessions to
strangers; the **subscribe fork** (`MKT-SUB`, entirely manual) because it
crosses an auth boundary; and **feature honesty** (`MKT-FEAT-004`) because only
a human can check a marketing claim against whether the code exists.

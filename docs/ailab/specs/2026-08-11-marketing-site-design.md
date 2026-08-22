# ServeOS Marketing Site — Design

**Date:** 2026-08-11
**Status:** Approved
**Spec 1 of 3** — see [Follow-on specs](#follow-on-specs)

## Context

`serveos.tech` runs six components in `src/app/_components/marketing/` — Header, Hero,
Features, HowItWorks, CtaBand, Footer — rendered from `src/app/page.tsx` when the proxy
classifies the host as the `marketing` surface. The page has never shown the product: the
hero displays a hand-drawn `TicketCard` mock rather than the app. There is no pricing
surface, no social proof, no route into a demo, and no way for a visitor to see what a
dashboard or POS actually looks like before registering.

Locale handling compounds it. `LangProvider` renders English on the server and flips to the
saved locale after mount, mutating `<html dir>` in an effect. For an Arabic-majority
audience this is backwards — the majority language arrives late and the layout visibly
reflows on every load.

The backend the page should be selling is already built: `plans` with per-tier limits and
features enforced through `src/server/entitlements/`, subdomain routing where
`<slug>.serveos.tech` resolves a tenant storefront, and showcase seed scripts for `roma`
(restaurant) and `nobio` (retail).

## Goal

Rebuild the marketing surface as an Arabic-first, screenshot-led page that shows the real
product across all four trades, routes prospects into live demos they can touch, and
publishes pricing that is read from the database rather than written into the markup.

## Scope

**In scope**
- Path-based locales: `/` (Arabic, default) and `/en`, both server-rendered with correct
  `lang`/`dir` in the first byte.
- Marketing moved to its own route tree, decoupled from the storefront entry point.
- Thirteen sections (see [Part D](#part-d--page-sections)), single long page, anchor nav.
- Visual system: paper grain, warm light wash, layered screenshot depth, live trade accent,
  editorial numerals, marker highlight, scroll/counter motion.
- A Playwright capture pipeline producing committed screenshots of real app surfaces.
- Pricing section rendering four plans and a billing-term switcher, priced from the `plans`
  table and a shared `TERMS` constant.
- `getDemoEntry(trade)` — the pure URL contract the demo CTAs depend on.
- Versatile footer: five nav columns, trust row, legal row, language switch.

**Out of scope (owned by follow-on specs)**
- Any change to `plans`, `subscriptions`, or billing-term persistence — **Spec 2**.
- Creating, seeding, or resetting demo tenants; the `/api/demo/login` endpoint and its demo
  role — **Spec 3**.
- Storefront, dashboard, POS, or admin UI changes. This spec only photographs them.
- Blog/insights, case studies, `/pricing` and `/demo` as separate routes.

## Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| 1 | Visual direction A+ — editorial light on brand paper | The app background is `#fbf7f2`; on a dark page every real screenshot becomes a glowing rectangle fighting the design |
| 2 | All seven soul levers adopted | Restraint is about quantity of accent, not flatness of surface |
| 3 | Hybrid screenshots — Playwright captures for surfaces, live components for foreground widgets | Captures stay truthful; widgets stay animatable and RTL-native |
| 4 | Demo = public storefront + demo login to dashboard, writable, reset daily | The dashboard and POS are what justify the top tier; they have to be touchable |
| 5 | Path-based locales, `/` Arabic and `/en` English | Real URLs per language: no flash, indexable, correct language when shared |
| 6 | 499/699/1099 are monthly EGP list prices; quarterly is the minimum term | Matches the existing `priceMonthly` column and how the market quotes |
| 7 | Term ladder 0% / 10% / 20% for 3 / 6 / 12 months | Round numbers a shop owner can verify mentally |
| 8 | Free tier = today's `basic` limits | Already defined and already enforced; zero new backend work |
| 9 | Illustrative labelled scenarios, not invented testimonials | Fabricated named quotes are false advertising under Egypt's consumer protection law |
| 10 | Single long page | SMB buyers scroll; a pricing page nobody clicks through to converts nothing |

## Part A — Routing and locale

### The obstacle

`/` is shared. On a tenant host it is a storefront; on the root domain it is marketing.
`src/app/page.tsx` branches on the `x-surface` header. The documented Next.js i18n pattern
(`app/[lang]` plus a proxy redirect from `/`) cannot be applied globally without breaking
every storefront.

### Structure

Marketing moves to `src/app/(marketing)/[lang]/page.tsx`, which produces the routes `/ar`
and `/en`. `src/app/page.tsx` keeps serving storefronts and is stripped of every marketing
import — today it imports both storefront templates and marketing components in one module,
so this split also stops storefront requests pulling marketing code.

### Proxy rules

`src/proxy.ts` already classifies the host. It gains three rules, applied **only** when
`cls.surface === "marketing"`:

1. `/` → `NextResponse.rewrite` to `/ar`. The visitor's URL stays `/`.
2. `/en` → passes through untouched.
3. `/ar` → `NextResponse.redirect` to `/`, so Arabic has exactly one canonical URL.

Storefront, dashboard and admin hosts are unaffected. Proxy runs on the Node.js runtime by
default in Next 16, so there is no edge-runtime constraint on this logic.

The proxy also sets `x-locale: "ar" | "en"` on the forwarded request headers, alongside the
existing `x-surface`.

### `<html lang>` and `dir`

Only the root layout may render `<html>`, and `src/app/layout.tsx` is already `async` and
already calls `headers()`. It reads `x-locale` and applies:

```tsx
const h = await headers();
const locale = h.get("x-locale") === "ar" ? "ar" : "en";
<html lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} …>
```

Non-marketing surfaces send no `x-locale` and fall through to `en`/`ltr`, preserving current
behaviour exactly.

**Rendering mode:** the root layout's `headers()` call already makes every route in this app
dynamic. Marketing pages therefore render per-request; `generateStaticParams` would have no
effect and is not used. This is a deliberate acceptance, not an oversight — CDN caching for
the marketing routes is a follow-up optimisation, not part of this spec.

### Metadata

`generateMetadata` in `(marketing)/[lang]/page.tsx` emits per-locale `title`/`description`
and `alternates.languages` with `ar` → `https://serveos.tech/` and `en` →
`https://serveos.tech/en`, plus a canonical matching the current locale.

### Removed

`LangProvider.tsx`, `LangToggle.tsx` and `i18n.ts` are deleted. Locale is a route parameter,
not client state, and the `<html>` mutation effects they exist to manage no longer have
anything to manage. The language switch becomes a `<Link>` to the other locale's URL.

## Part B — Content and component architecture

### Content

`src/app/_components/marketing/verticals.ts` is 20KB for six sections. Thirteen sections
would make it unmaintainable, so content splits into `src/app/(marketing)/_content/`:

| File | Holds |
|---|---|
| `chrome.ts` | Header nav, footer columns, trust row, legal line |
| `trades/restaurant.ts`, `retail.ts`, `pharmacy.ts`, `timber.ts` | Per-trade hero, features, steps, ticket, photo caption |
| `surfaces.ts` | Surface-tour band headings, sentences and detail callouts — shared across trades, since only the screenshot changes per trade |
| `demo.ts` | Demo band heading, the two door labels, the shared-and-resets-daily note |
| `pricing.ts` | Plan display names by plan key, feature-row labels, term labels |
| `faq.ts` | Six questions |
| `outcomes.ts` | Three illustrative scenarios |
| `story.ts` | The "ليه بنينا ServeOS" copy |

Each module exports `{ ar, en }` of the same shape, and the shape is a single exported type
per module so a missing key in either locale is a compile error rather than a runtime hole.
All of it is server-only data and none of it reaches the client bundle.

Trade accents keep coming from `src/server/verticals/registry.ts`. This spec introduces no
second source of truth for colour.

### Client islands

Locale is resolved entirely on the server. Trade is not: switching trade must not cost a page
navigation, so the sections that vary by trade — hero, trade band, surface tour, features,
steps, photo — are client components reading a `TradeProvider`, the same shape the old
`VerticalProvider` used. The honest consequence is that all four trades' copy for the current
locale ships to the browser. That is a few KB of text, and it buys instant switching; the
alternative — rendering four copies of every trade-dependent section and toggling them with
CSS — costs four times the markup and four times the images.

The provider imports its content directly rather than receiving it as props. Trade content
carries `LucideIcon` values, and lucide-react ships no `"use client"` directive, so those are
plain functions in the server graph — passing them across the boundary throws at render.

Sections that do not vary by trade — story, outcomes, pricing, FAQ, header, footer, demo band
— stay server components. Beyond the provider, three islands carry interactivity:

- **`TradeSwitcher`** — sets the active trade. Writes `--trade-accent` as a CSS custom
  property on a wrapper element; every section reads that variable, so re-tinting the page
  is pure CSS with no React re-render. Selection is mirrored to the URL as `?trade=pharmacy`
  so a shared link opens on the right trade and screenshots can be deep-linked.
- **`PricingTerms`** — the 3 / 6 / 12-month toggle. Receives plan rows as props from the
  server and computes displayed totals client-side.
- **`MotionReveal`** — a small wrapper applying entry transitions and the stat counters,
  no-op under `prefers-reduced-motion`.

Everything else is a server component.

### Component inventory

New, under `src/app/(marketing)/_components/`: `Header`, `Hero`, `TradeSwitcher`,
`TradeBand`, `Story`, `SurfaceTour`, `SurfaceBand`, `WhatsappBand`, `PhotoBand`,
`FeatureGrid`, `Steps`, `DemoBand`, `DemoCard`, `Outcomes`, `Pricing`, `PricingTerms`,
`PlanCard`, `Faq`, `ClosingCta`, `Footer`, `MotionReveal`, `LiveTicket`, `PaperSurface`.

`src/app/_components/marketing/` is deleted once the new tree renders, including
`TicketCard.tsx` — `LiveTicket` supersedes it.

## Part C — Visual system

Implemented once in `PaperSurface` and a small set of tokens, then reused:

1. **Paper grain + wash** — one absolutely-positioned grain layer (inline SVG `feTurbulence`
   data URI, `mix-blend-mode: multiply`, ~0.22 opacity) over three radial washes tinted from
   `--trade-accent`. No image requests.
2. **Layered depth** — screenshot stacks are never a single flat frame: a primary capture at
   `rotate(-1.2deg)` with a foreground live widget at `rotate(2.4deg)`, two-layer shadows.
3. **Live accent** — `--trade-accent` drives washes, chips, chart bars, numerals and the
   photo duotone. Four moods, one page.
4. **Editorial furniture** — `٠١ ٠٢ ٠٣` section numerals, a 120px hairline column grid,
   monospace eyebrows with a short accent tick, Arabic-Indic digits for money in the Arabic
   locale (`٢١٥٫٠٠`) via `Intl.NumberFormat("ar-EG")`.
5. **Marker highlight** — the payoff phrase gets a translucent accent swipe as a background,
   not a colour swap. Direction-agnostic, so it survives RTL unchanged.
6. **Duotone photography** — two full-bleed placements, tinted to the active accent.
7. **Motion** — ticket entry and a 12px rise on section entry, behind `prefers-reduced-motion`.
   No stat counters: no section on this page renders a statistic, so there is nothing to count
   up. Sections render visible in the served HTML and the animation is armed by script, so a
   visitor without JavaScript — or a crawler that doesn't execute it — sees the whole page.

Typography uses the existing `fonts.ts`: Bricolage for display, Space Grotesk for Latin body,
IBM Plex Sans Arabic for Arabic body and display, JetBrains Mono for eyebrows and numerals.

## Part D — Page sections

Order is the narrative: *who this is for → why we built it → what it looks like → prove it,
touch it → what it costs → objections → start.*

| # | Section | Notes |
|---|---|---|
| ٠١ | Header | Sticky, blurred over paper. Anchor nav, locale `<Link>`, ابدأ مجانًا |
| ٠٢ | Hero | Trade-aware headline, marker highlight, dual CTA, layered stack with `LiveTicket`, trust line |
| ٠٣ | Trade band | Four chips; switching re-tints and re-copies the whole page |
| ٠٤ | ليه بنينا ServeOS | Two paragraphs: a POS, a delivery app's commission, and a designer for a menu — three systems that don't talk |
| ٠٥ | Surface tour | Four bands — storefront, dashboard, POS, WhatsApp. Storefront and dashboard are automated captures; POS is a manual asset; WhatsApp is a live component (see below) |
| ٠٦ | Photo band | Duotone, full-bleed, one line of copy |
| ٠٧ | Feature grid | Six per trade from existing copy; `roadmap: true` items keep their قريبًا chip |
| ٠٨ | كيف تعمل | Three steps in editorial numerals |
| ٠٩ | جرّب بنفسك | The single dark band on the page. Four cards × two doors |
| ١٠ | Illustrative outcomes | Three Egyptian scenarios, labelled نماذج توضيحية |
| ١١ | الأسعار | Four plans, term switcher |
| ١٢ | أسئلة شائعة | Six objections |
| ١٣ | Closing CTA + Footer | Second photo placement doubles as the closing CTA |

**Admin console is excluded from the tour.** `admin.serveos.tech` is the platform operator
console — internal to ServeOS, not something a tenant ever sees. Showing it would advertise a
surface no customer receives.

**WhatsApp is a live component, not a capture.** The band renders a styled chat exchange
built from ServeOS's own tokens. Screenshotting WhatsApp would reproduce Meta's interface,
and mocking their UI pixel-for-pixel and calling it a screenshot would misrepresent whose
product the visitor is looking at.

### Section ٠٩ — demo cards

Each of the four cards renders two actions from `getDemoEntry(trade)`:

- **افتح المتجر** → `storefrontUrl`, public, opens instantly.
- **ادخل لوحة التحكم** → `dashboardUrl`, the demo login.

Each card carries a plain note that the demo is shared and resets daily, so a visitor who
finds someone else's test order understands why.

### Section ١٠ — outcomes

Three scenarios, written as situations rather than quotes attributed to people: a three-branch
koshary chain, a Faisal pharmacy, a Sheikh Zayed timber yard. The section carries a visible
نماذج توضيحية / *Illustrative* label. `Outcomes` accepts an optional `attribution` field so a
real quote drops in later without a redesign.

## Part E — Screenshot pipeline

`scripts/capture-marketing-shots.ts`, run manually and re-run whenever the captured surfaces
change:

1. Boots Playwright against a target (`--base-url`, defaulting to `http://localhost:3000`).
2. For each trade, signs into that trade's demo tenant and visits each surface.
3. Waits for network idle and a per-surface settled selector before capturing.
4. Writes `public/marketing/shots/<trade>/<surface>.<locale>.webp`.

### Matrix — 16 automated files

| Set | Count |
|---|---|
| storefront, dashboard × 4 trades × both locales, desktop 1440 | 16 |

Every band the page renders is captured in every locale it renders in. The matrix is derived
from what the tour actually shows, not maintained beside it, so the two cannot drift.

**POS is captured manually — it is not a web route.** The point of sale is a separate Electron
application in `apps/pos`, not a page in this Next app, so the Playwright pipeline cannot
reach it. Its band is served by two committed one-off assets
(`/marketing/shots/pos.ar.png`, `pos.en.png`) captured by hand from the running POS. The
counter is too central to what justifies the paid tiers to drop from the page, and automating
an Electron capture for two images is not worth a second pipeline. The manual origin is
recorded in the capture manifest so the assets' age stays visible.

No mobile captures. The storefront is the only surface a customer meets on a phone, but the
page frames every screenshot in browser chrome that scales legibly, and a mobile set that no
section renders is a set that silently rots.

### Guards

- A test walks the rendered section content, collects every `shots/` path it references, and
  asserts the file exists. A missing capture fails CI rather than shipping a gap.
- The capture list contains no surface whose primary feature is still flagged
  `roadmap: true` in the trade content. This is the same failure the two `docs(marketing)`
  commits corrected, and the guard exists so it cannot recur silently.

Images render through `next/image` with explicit dimensions.

## Part F — Contracts

### Pricing — consumed from `plans`

The page reads active `plans` rows ordered by `priceMonthly`. The layout is designed for four
tiers, which is what Spec 2 produces; it renders however many active rows exist rather than
assuming a count, and a plan `key` with no entry in `_content/pricing.ts` falls back to
`plans.name` rather than rendering blank. Against today's three seeded plans the section
renders three cards at today's prices — correct, just not yet the intended pricing.

Display names are **not** read from `plans.name`, which is English-only; they are mapped by
plan `key` through `_content/pricing.ts`, keeping marketing i18n in one place and requiring no
schema change here.

Term maths lives in `src/app/(marketing)/_lib/terms.ts`:

```ts
export const TERMS = [
  { months: 3,  discount: 0    },
  { months: 6,  discount: 0.10 },
  { months: 12, discount: 0.20 },
] as const;

export function termTotal(priceMonthly: number, months: number, discount: number): number
```

Each card shows the term total and the effective monthly rate. The Free tier renders as
مجاني with no term applied.

Feature rows on each card are generated from that plan's `limits` and `features` JSON with
localized labels — so a card can only promise what the entitlements layer actually grants.

**Prices are never hardcoded in markup.** If a price is wrong on the page, it is wrong in the
database, and the fix is a data change.

### Demos — `getDemoEntry`

`src/server/demo/entry.ts`, owned by this spec — a pure function, no database access:

```ts
export function getDemoEntry(trade: VerticalId): {
  storefrontUrl: string;
  dashboardUrl: string;
};
```

`storefrontUrl` is `<protocol>//demo-<trade>.<ROOT_DOMAIN>`, where protocol is `http:` when
`ROOT_DOMAIN` ends in `.localhost` and `https:` otherwise — the same split the proxy already
assumes. `dashboardUrl` is `/api/demo/login?trade=<trade>`.

The tenants themselves, their seed data, the login route and the daily reset are **Spec 3**.
Until Spec 3 lands these links resolve to nothing.

New demo slugs (`demo-restaurant`, `demo-retail`, `demo-pharmacy`, `demo-timber`) rather than
reusing `roma` and `nobio`: those are showcase tenants, and pointing a publicly writable,
nightly-reset demo at them couples two things that should stay separate.

## Part G — Footer

Five columns, a trust row, and a legal row:

| Column | Contents |
|---|---|
| المنصة | نقطة البيع · المتجر · واتساب · المخزون · التقارير |
| الأنشطة | مطاعم · تجزئة · صيدليات · أخشاب — each linking to that trade's demo |
| الأسعار | الباقات · مدد الاشتراك · الأسئلة الشائعة |
| الشركة | من نحن · تواصل معنا · الدعم عبر واتساب |
| قانوني | الشروط · الخصوصية · سياسة الاسترداد |

Trust row: بالجنيه المصري · دعم بالعربي · بياناتك ملكك. Legal row carries the copyright and
the language switch. Legal pages that do not exist yet are omitted rather than linked to a
404 — the footer renders only the links whose targets exist.

## Tests

**Unit**
- Every content module exports matching `ar` and `en` shapes; enforced by a shared exported
  type per module, with a test asserting key parity at runtime for nested records.
- `termTotal` — all three terms against all four plan prices, including the Free tier.
- `getDemoEntry` — URL construction for all four trades under a stubbed `ROOT_DOMAIN`.
- Money formatting renders Arabic-Indic digits under `ar` and Latin digits under `en`.

**Proxy** — extends `src/middleware-routing.test.ts`:
- Marketing host `/` rewrites to `/ar`; `/en` passes through; `/ar` redirects to `/`.
- Storefront, dashboard and admin hosts are untouched by all three rules.
- `x-locale` is set on marketing requests and absent elsewhere.

**E2E** (`tests/e2e`)
- `/` server-renders `lang="ar" dir="rtl"` with the Arabic headline present in the initial
  HTML — asserted with JavaScript disabled, which is what proves the flash is gone.
- `/en` server-renders `lang="en" dir="ltr"`.
- Switching trade updates the accent variable, the copy, and `?trade=` in the URL.
- Pricing cards match the `plans` rows; the term toggle produces the documented totals.
- Demo cards link to the four expected URLs.
- Every referenced screenshot file exists.

## Risks and dependencies

**Build order is Spec 2 → Spec 3 → Spec 1.** This page can be built and reviewed at any time,
but it is not deployed to production until both dependencies have landed: without Spec 2 the
pricing section shows three old tiers, and without Spec 3 every demo link is dead.

| Risk | Handling |
|---|---|
| Egyptian photography for lever ٦ — free stock has thin coverage of Egyptian retail interiors | Treated as swappable assets; the build is not blocked on them. May require purchase or a phone camera |
| Pricing shows three old tiers until Spec 2 ships | Renders correctly against whatever plans exist; no crash, no hardcoded fallback prices |
| Demo links are dead until Spec 3 ships | Build order above; not deployed to production before it |
| Deleting `LangProvider` touches anything else importing it | Only the marketing components import it; verified before deletion |
| Screenshots drift as the app changes | Regeneration is one command; the existence guard catches deletions but not staleness. A dated manifest is written alongside the captures so age is visible |

## Follow-on specs

- **Spec 2 — Plans and billing terms.** Four tiers replacing three; `enterprise` moves
  1499 → 1099, which affects any tenant already on that plan and needs a deliberate migration
  rather than a seed overwrite. Persisting a chosen billing term on `subscriptions` lives here.
- **Spec 3 — Demo tenants.** Four `demo-*` tenants, generalised showcase seeds covering
  pharmacy and timber, `/api/demo/login` with a restricted demo role, and a daily reset added
  as a second task inside the existing `/api/notifications/worker` cron rather than a new
  `crons` entry — the Vercel cron budget is already tight.

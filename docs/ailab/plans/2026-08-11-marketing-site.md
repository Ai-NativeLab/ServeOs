# ServeOS Marketing Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `serveos.tech` as an Arabic-first, screenshot-led marketing page across four trades, with live demo entry points and pricing read from the `plans` table.

**Architecture:** Marketing moves out of the shared `/` route into `src/app/(marketing)/[lang]/`, which produces `/ar` and `/en`. The host-aware proxy rewrites `/` → `/ar` (URL unchanged), redirects `/ar` → `/`, and stamps an `x-locale` header the root layout reads to set `<html lang dir>` server-side. Copy lives in server-only content modules under `_content/`, typed so a missing translation is a compile error. Three client islands (`TradeSwitcher`, `PricingTerms`, `MotionReveal`) carry all interactivity; the trade accent propagates as a CSS custom property so re-tinting costs no re-render.

**Tech Stack:** Next.js 16.2.9 (App Router, `proxy.ts` — `middleware` is deprecated in v16), React server components, Tailwind v4, Drizzle + PostgreSQL, Vitest (node env), Playwright.

**Spec:** `docs/ailab/specs/2026-08-11-marketing-site-design.md`

---

## Global Constraints

- **Vitest only runs `src/**/*.test.ts` in a `node` environment.** There is no jsdom and no `.tsx` test support. Do **not** attempt React component unit tests — component behaviour is verified by Playwright E2E only. Unit tests cover pure TypeScript: locale routing, term maths, formatting, content parity, demo URLs.
- Vitest boots a real Postgres via `src/db/test-global-setup.ts`. Tests are serialised (`fileParallelism: false`); this is expected and slow.
- E2E requires a seeded DB (`npm run db:seed`) and the dev server. `playwright.config.ts` starts it automatically at `http://localhost:3000`.
- On `localhost`, `classifyHost` falls through to `marketing`, so `/` in E2E is the marketing surface. This is how the existing marketing E2E works and must keep working.
- The four trade accents come from `src/server/verticals/registry.ts` (`VERTICAL_ACCENTS`). Never hardcode a hex for a trade.
- **Never hardcode a price.** Prices come from the `plans` table via `listPlans()`.
- Features flagged `roadmap: true` keep their قريبًا / Soon chip. Do not silently promote one.
- Commits are signed and attributed to the repo owner. Do not add a Claude co-author trailer.
- This page is **not deployed to production** until Spec 2 (plans) and Spec 3 (demo tenants) land. Building and reviewing it now is fine, with one exception: **Task 20 requires Spec 3's demo tenants to exist**, because the capture script signs into them. Every other task runs standalone. Until Task 20 has run, the screenshot slots render broken images in development and the shots existence test stays skipped — both are expected, neither blocks the other tasks.

## File Structure

**New — routing and layout**

| File | Responsibility |
|---|---|
| `src/marketing-locale.ts` | Pure locale-routing decision for a marketing pathname |
| `src/marketing-locale.test.ts` | Unit tests for the above |
| `src/app/(marketing)/[lang]/page.tsx` | The page — composes every section, loads plans |
| `src/app/(marketing)/[lang]/layout.tsx` | Marketing-only wrapper: fonts scope, `PaperSurface`, trade CSS variable root |

**New — content (server-only data, `_content/`)**

| File | Responsibility |
|---|---|
| `types.ts` | Shared `Localized<T>` type and the shape of every content module |
| `chrome.ts` | Header nav, footer columns, trust row, legal line |
| `story.ts` | The "ليه بنينا ServeOS" copy |
| `surfaces.ts` | Surface-tour band headings, sentences, callouts |
| `demo.ts` | Demo band heading, door labels, reset note |
| `outcomes.ts` | Three illustrative scenarios |
| `pricing.ts` | Plan display names by key, feature-row labels, term labels |
| `faq.ts` | Six questions |
| `trades/index.ts` | `TRADE_CONTENT: Record<VerticalId, Localized<TradeContent>>` |
| `trades/restaurant.ts`, `retail.ts`, `pharmacy.ts`, `timber.ts` | Per-trade copy, migrated from the old `verticals.ts` |
| `parity.test.ts` | Asserts `ar` and `en` key parity across every module |

**New — lib (`_lib/`)**

| File | Responsibility |
|---|---|
| `terms.ts` | `TERMS`, `termTotal`, `monthlyEquivalent` |
| `terms.test.ts` | Term maths against all four price points |
| `format.ts` | `formatEgp` — Arabic-Indic digits under `ar` |
| `format.test.ts` | Digit-system assertions |
| `shots.ts` | `shotPath(trade, surface, locale, viewport)` — the one place capture paths are constructed |
| `shots.test.ts` | Path construction + every referenced file exists on disk |

**New — server**

| File | Responsibility |
|---|---|
| `src/server/demo/entry.ts` | `getDemoEntry(trade)` — pure URL construction |
| `src/server/demo/entry.test.ts` | URL tests for all four trades |

**New — components (`src/app/(marketing)/_components/`)**

`PaperSurface`, `Header`, `Hero`, `LiveTicket`, `TradeSwitcher`, `TradeBand`, `Story`, `SurfaceTour`, `SurfaceBand`, `WhatsappBand`, `PhotoBand`, `FeatureGrid`, `Steps`, `DemoBand`, `DemoCard`, `Outcomes`, `Pricing`, `PricingTerms`, `PlanCard`, `Faq`, `ClosingCta`, `Footer`, `MotionReveal`

**New — scripts**

| File | Responsibility |
|---|---|
| `scripts/capture-marketing-shots.ts` | Playwright capture pipeline → `public/marketing/shots/` |

**Modified**

| File | Change |
|---|---|
| `src/proxy.ts` | Apply locale rules + `x-locale` on the marketing surface |
| `src/app/layout.tsx` | Read `x-locale`, set `<html lang dir>` |
| `src/app/page.tsx` | Remove every marketing import and the marketing branch |
| `tests/e2e/marketing.spec.ts` | Rewritten for Arabic-default, path locales, new sections |

**Deleted (Task 20, last)**

`src/app/_components/marketing/` in full — `Header`, `Hero`, `Features`, `HowItWorks`, `CtaBand`, `Footer`, `LangProvider`, `LangToggle`, `TicketCard`, `VerticalProvider`, `VerticalSwitcher`, `i18n.ts`, `verticals.ts`.

---

## Task 1: Locale routing decision (pure function)

**Files:**
- Create: `src/marketing-locale.ts`
- Test: `src/marketing-locale.test.ts`

**Interfaces:**
- Produces: `LocaleAction`, `marketingLocaleAction(pathname: string): LocaleAction`
- Consumed by: Task 2 (`src/proxy.ts`)

Keeping the decision in a pure function means it is unit-testable without constructing a `NextRequest`, which mirrors how `classifyHost` is already split out of the proxy.

- [ ] **Step 1: Write the failing test**

Create `src/marketing-locale.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { marketingLocaleAction } from "./marketing-locale";

describe("marketingLocaleAction", () => {
  it("rewrites the bare root to the Arabic route", () => {
    expect(marketingLocaleAction("/")).toEqual({ kind: "rewrite", pathname: "/ar", locale: "ar" });
  });

  it("passes /en through and reports the English locale", () => {
    expect(marketingLocaleAction("/en")).toEqual({ kind: "pass", locale: "en" });
  });

  it("passes nested English paths through", () => {
    expect(marketingLocaleAction("/en/anything")).toEqual({ kind: "pass", locale: "en" });
  });

  it("redirects an explicit /ar to the canonical root", () => {
    expect(marketingLocaleAction("/ar")).toEqual({ kind: "redirect", pathname: "/" });
  });

  it("redirects a nested /ar path to its unprefixed form", () => {
    expect(marketingLocaleAction("/ar/anything")).toEqual({ kind: "redirect", pathname: "/anything" });
  });

  it("leaves non-marketing paths alone", () => {
    expect(marketingLocaleAction("/login")).toEqual({ kind: "none" });
    expect(marketingLocaleAction("/register")).toEqual({ kind: "none" });
    expect(marketingLocaleAction("/api/health")).toEqual({ kind: "none" });
  });

  it("does not treat a path that merely starts with the letters as a locale", () => {
    expect(marketingLocaleAction("/article")).toEqual({ kind: "none" });
    expect(marketingLocaleAction("/enroll")).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/marketing-locale.test.ts`
Expected: FAIL — `Failed to load ./marketing-locale` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `src/marketing-locale.ts`:

```ts
/**
 * Locale routing for the marketing surface only.
 *
 * `/` is shared: on a tenant host it is a storefront, on the root domain it is
 * marketing. So the locale prefix cannot be applied globally — the proxy calls
 * this only after classifyHost() has returned `marketing`.
 *
 * Arabic is the default and keeps the bare `/` URL; `/ar` exists as a route
 * internally but redirects, so each language has exactly one canonical URL.
 */
export type LocaleAction =
  | { kind: "rewrite"; pathname: string; locale: "ar" }
  | { kind: "pass"; locale: "en" }
  | { kind: "redirect"; pathname: string }
  | { kind: "none" };

export function marketingLocaleAction(pathname: string): LocaleAction {
  if (pathname === "/") return { kind: "rewrite", pathname: "/ar", locale: "ar" };
  if (pathname === "/en" || pathname.startsWith("/en/")) return { kind: "pass", locale: "en" };
  if (pathname === "/ar") return { kind: "redirect", pathname: "/" };
  if (pathname.startsWith("/ar/")) return { kind: "redirect", pathname: pathname.slice(3) };
  return { kind: "none" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/marketing-locale.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/marketing-locale.ts src/marketing-locale.test.ts
git commit -m "feat(marketing): locale routing decision for the marketing surface"
```

---

## Task 2: Apply locale rules in the proxy

**Files:**
- Modify: `src/proxy.ts`
- Test: `src/proxy.test.ts` (create)

**Interfaces:**
- Consumes: `marketingLocaleAction` (Task 1), `classifyHost`
- Produces: `x-locale` request header on marketing requests

Before writing, read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` — this project is on Next 16 where `middleware` was renamed to `proxy`, and the rewrite signature matters here.

- [ ] **Step 1: Write the failing test**

Create `src/proxy.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

beforeAll(() => {
  process.env.ROOT_DOMAIN = "serveos.localhost";
});

function request(host: string, path: string) {
  return new NextRequest(new URL(`http://${host}${path}`), { headers: { host } });
}

describe("proxy locale handling on the marketing surface", () => {
  it("rewrites / to /ar and stamps the Arabic locale", () => {
    const res = proxy(request("serveos.localhost", "/"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/ar");
    expect(res.headers.get("x-middleware-request-x-locale")).toBe("ar");
  });

  it("passes /en through with the English locale", () => {
    const res = proxy(request("serveos.localhost", "/en"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-locale")).toBe("en");
  });

  it("redirects /ar to the canonical root", () => {
    const res = proxy(request("serveos.localhost", "/ar"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://serveos.localhost/");
  });

  it("leaves the storefront surface untouched", () => {
    const res = proxy(request("roma.serveos.localhost", "/"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-locale")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBe("roma");
  });

  it("leaves /login on the marketing host untouched", () => {
    const res = proxy(request("serveos.localhost", "/login"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-locale")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/proxy.test.ts`
Expected: FAIL — `x-middleware-request-x-locale` is null on the first assertion; no locale handling exists yet.

- [ ] **Step 3: Write the implementation**

Replace the body of `src/proxy.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { classifyHost } from "./middleware-routing";
import { marketingLocaleAction } from "./marketing-locale";

export function proxy(req: NextRequest) {
  const root = process.env.ROOT_DOMAIN ?? "serveos.localhost";
  const host = req.headers.get("host") ?? root;
  const cls = classifyHost(host, root);

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-surface", cls.surface);
  if (cls.surface === "storefront") {
    requestHeaders.set("x-tenant-slug", cls.slug);
  } else {
    // Prevent a client from spoofing x-tenant-slug on non-storefront hosts.
    requestHeaders.delete("x-tenant-slug");
  }
  // Same reasoning: only this function may declare the marketing locale.
  requestHeaders.delete("x-locale");

  if (cls.surface === "marketing") {
    const action = marketingLocaleAction(req.nextUrl.pathname);

    if (action.kind === "redirect") {
      const url = req.nextUrl.clone();
      url.pathname = action.pathname;
      return NextResponse.redirect(url);
    }

    if (action.kind === "rewrite") {
      requestHeaders.set("x-locale", action.locale);
      const url = req.nextUrl.clone();
      url.pathname = action.pathname;
      return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    }

    if (action.kind === "pass") {
      requestHeaders.set("x-locale", action.locale);
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js).*)"],
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/proxy.test.ts src/marketing-locale.test.ts src/middleware-routing.test.ts`
Expected: PASS. If the rewrite header name differs from `x-middleware-rewrite` on this Next version, read the returned headers with `console.log([...res.headers])` and correct the **test's** expectation — the implementation is what the docs prescribe.

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat(marketing): route / to Arabic and /en to English via the proxy"
```

---

## Task 3: Root layout sets lang and dir from the locale header

**Files:**
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `x-locale` (Task 2)

`<html>` may only be rendered by the root layout, which is why the locale travels as a header rather than a route param. The layout already calls `headers()`, so this adds no rendering cost.

- [ ] **Step 1: Apply the change**

In `src/app/layout.tsx`, replace the component body:

```tsx
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const surface = h.get("x-surface");
  const isStorefront = surface === "storefront";
  // Marketing is Arabic-first and the proxy declares the locale, so the correct
  // dir/lang ship in the first byte — no client-side flip, no layout reflow.
  // Every other surface is unchanged: no x-locale, so en/ltr as before.
  const locale = h.get("x-locale") === "ar" ? "ar" : "en";
  return (
    <html
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className={`${bricolage.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${plexArabic.variable}`}
    >
      <head>{isStorefront && <link rel="manifest" href="/manifest.webmanifest" />}</head>
      <body>
        {isStorefront && <ServiceWorkerRegister />}
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Verify nothing else regressed**

Run: `npx vitest run`
Expected: PASS — the full suite. No test asserts on `<html>` yet; this step is a regression guard.

- [ ] **Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat(marketing): server-render lang and dir from the locale header"
```

---

## Task 4: Content types and the parity guard

**Files:**
- Create: `src/app/(marketing)/_content/types.ts`
- Create: `src/app/(marketing)/_content/parity.test.ts`

**Interfaces:**
- Produces: `Localized<T>`, `keyPaths(value)`
- Consumed by: every content module (Tasks 5–6)

The parity test is written before any content exists so that each content module added afterwards is covered the moment it lands.

- [ ] **Step 1: Write the failing test**

Create `src/app/(marketing)/_content/parity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { keyPaths } from "./types";

describe("keyPaths", () => {
  it("lists nested object paths", () => {
    expect(keyPaths({ a: 1, b: { c: 2 } })).toEqual(["a", "b.c"]);
  });

  it("treats an array as one path regardless of length", () => {
    expect(keyPaths({ items: [{ x: 1 }, { x: 2 }] })).toEqual(["items[]"]);
  });

  it("descends into the first element of an array so item shape is compared", () => {
    expect(keyPaths({ items: [{ x: 1, y: 2 }] })).toEqual(["items[]"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: FAIL — `Failed to load ./types`.

- [ ] **Step 3: Write the implementation**

Create `src/app/(marketing)/_content/types.ts`:

```ts
import type { Locale } from "@/shared/errors";

/**
 * Every content module exports the same shape in both languages. The type makes
 * a missing translation a compile error; keyPaths + parity.test.ts catch the
 * cases types cannot, such as an array whose items gained a field in one
 * language only.
 */
export type Localized<T> = Record<Locale, T>;

/** Sorted, dot-joined key paths. Arrays collapse to `name[]` — length may
 *  legitimately differ between languages, item shape may not. */
export function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return [`${prefix}[]`];
  if (value === null || typeof value !== "object") return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)/_content/types.ts" "src/app/(marketing)/_content/parity.test.ts"
git commit -m "feat(marketing): localized content type and key-parity helper"
```

---

## Task 5: Chrome, story, surfaces, demo and FAQ content

**Files:**
- Create: `src/app/(marketing)/_content/chrome.ts`
- Create: `src/app/(marketing)/_content/story.ts`
- Create: `src/app/(marketing)/_content/surfaces.ts`
- Create: `src/app/(marketing)/_content/demo.ts`
- Create: `src/app/(marketing)/_content/faq.ts`
- Modify: `src/app/(marketing)/_content/parity.test.ts`

**Interfaces:**
- Produces: `CHROME`, `STORY`, `SURFACES`, `DEMO`, `FAQ`, and their types
- Consumed by: Tasks 10–13, 15, 17

- [ ] **Step 1: Write the failing test**

Append to `src/app/(marketing)/_content/parity.test.ts`:

```ts
import { CHROME } from "./chrome";
import { STORY } from "./story";
import { SURFACES } from "./surfaces";
import { DEMO } from "./demo";
import { FAQ } from "./faq";

describe("content parity between Arabic and English", () => {
  const modules = { CHROME, STORY, SURFACES, DEMO, FAQ };

  for (const [name, mod] of Object.entries(modules)) {
    it(`${name} has identical key paths in both languages`, () => {
      expect(keyPaths(mod.ar)).toEqual(keyPaths(mod.en));
    });

    it(`${name} has no empty strings`, () => {
      const empties: string[] = [];
      const walk = (v: unknown, path: string) => {
        if (typeof v === "string" && v.trim() === "") empties.push(path);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (v && typeof v === "object")
          Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
      };
      walk(mod, name);
      expect(empties).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: FAIL — `Failed to load ./chrome`.

- [ ] **Step 3: Write the content modules**

Create `src/app/(marketing)/_content/chrome.ts`:

```ts
import type { Localized } from "./types";

export type ChromeContent = {
  nav: { platform: string; trades: string; pricing: string; demo: string };
  signIn: string;
  getStarted: string;
  otherLocale: string;
  footer: {
    columns: { heading: string; links: { label: string; href: string }[] }[];
    trust: string[];
    copyright: string;
  };
};

export const CHROME: Localized<ChromeContent> = {
  ar: {
    nav: { platform: "المنصة", trades: "الأنشطة", pricing: "الأسعار", demo: "تجربة حية" },
    signIn: "تسجيل الدخول",
    getStarted: "ابدأ مجانًا",
    otherLocale: "English",
    footer: {
      columns: [
        { heading: "المنصة", links: [
          { label: "نقطة البيع", href: "#surfaces" },
          { label: "المتجر", href: "#surfaces" },
          { label: "واتساب", href: "#surfaces" },
          { label: "التقارير", href: "#features" },
        ]},
        { heading: "الأنشطة", links: [
          { label: "مطاعم", href: "#demo" },
          { label: "تجزئة", href: "#demo" },
          { label: "صيدليات", href: "#demo" },
          { label: "أخشاب", href: "#demo" },
        ]},
        { heading: "الأسعار", links: [
          { label: "الباقات", href: "#pricing" },
          { label: "مدد الاشتراك", href: "#pricing" },
          { label: "الأسئلة الشائعة", href: "#faq" },
        ]},
        { heading: "الشركة", links: [
          { label: "من نحن", href: "#story" },
          { label: "ابدأ مجانًا", href: "/register" },
          { label: "تسجيل الدخول", href: "/login" },
        ]},
      ],
      trust: ["بالجنيه المصري", "دعم بالعربي", "بياناتك ملكك"],
      copyright: "© ٢٠٢٦ ServeOS",
    },
  },
  en: {
    nav: { platform: "Platform", trades: "Trades", pricing: "Pricing", demo: "Live demo" },
    signIn: "Sign in",
    getStarted: "Start free",
    otherLocale: "العربية",
    footer: {
      columns: [
        { heading: "Platform", links: [
          { label: "Point of sale", href: "#surfaces" },
          { label: "Storefront", href: "#surfaces" },
          { label: "WhatsApp", href: "#surfaces" },
          { label: "Reporting", href: "#features" },
        ]},
        { heading: "Trades", links: [
          { label: "Restaurants", href: "#demo" },
          { label: "Retail", href: "#demo" },
          { label: "Pharmacies", href: "#demo" },
          { label: "Timber", href: "#demo" },
        ]},
        { heading: "Pricing", links: [
          { label: "Plans", href: "#pricing" },
          { label: "Billing terms", href: "#pricing" },
          { label: "FAQ", href: "#faq" },
        ]},
        { heading: "Company", links: [
          { label: "About", href: "#story" },
          { label: "Start free", href: "/register" },
          { label: "Sign in", href: "/login" },
        ]},
      ],
      trust: ["Priced in EGP", "Arabic support", "Your data is yours"],
      copyright: "© 2026 ServeOS",
    },
  },
};
```

> **Legal links are deliberately absent.** The spec says the footer renders only links whose targets exist; there are no terms/privacy routes in this repo yet. Adding them is a follow-up, not this task.

Create `src/app/(marketing)/_content/story.ts`:

```ts
import type { Localized } from "./types";

export type StoryContent = { eyebrow: string; heading: string; body: string[] };

export const STORY: Localized<StoryContent> = {
  ar: {
    eyebrow: "ليه بنينا ServeOS",
    heading: "ثلاثة أنظمة، ولا واحد فيهم بيكلّم التاني.",
    body: [
      "المحل المصري النهارده بيدفع لنظام كاشير، وعمولة لتطبيق توصيل، ومصمم يعملّه قائمة على السوشيال ميديا. تلات حاجات منفصلة، وكل واحدة بتشوف نص الصورة.",
      "بنينا ServeOS عشان الطلب اللي جاي من الطاولة، ومن واتساب، ومن المتجر، ومن الكاشير — كله يوصل لمكان واحد، بالعربي، وبالجنيه المصري.",
    ],
  },
  en: {
    eyebrow: "Why we built ServeOS",
    heading: "Three systems, none of them talking.",
    body: [
      "An Egyptian shop today pays for a POS, a commission to a delivery app, and a designer to make a menu for social media. Three separate things, each seeing half the picture.",
      "We built ServeOS so an order from the table, from WhatsApp, from your storefront and from the counter all land in one place — in Arabic, priced in Egyptian pounds.",
    ],
  },
};
```

Create `src/app/(marketing)/_content/surfaces.ts`:

```ts
import type { Localized } from "./types";

/** The surface keys are also the screenshot filenames — see _lib/shots.ts. */
export const SURFACE_KEYS = ["storefront", "dashboard", "pos"] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

export type SurfacesContent = {
  eyebrow: string;
  heading: string;
  bands: Record<SurfaceKey, { title: string; body: string; callout: string }>;
  whatsapp: { title: string; body: string; callout: string; chat: { from: "shop" | "customer"; text: string }[] };
};

export const SURFACES: Localized<SurfacesContent> = {
  ar: {
    eyebrow: "المنتج",
    heading: "ده شكل الشغل من جوه.",
    bands: {
      storefront: {
        title: "المتجر",
        body: "صفحة طلب بالعربي على النطاق بتاعك، شغالة على الموبايل قبل أي حاجة.",
        callout: "بدون تطبيق ينزّله الزبون",
      },
      dashboard: {
        title: "لوحة التحكم",
        body: "الطلبات، المنتجات، الفروع، والتقارير — في مكان واحد ولحظة بلحظة.",
        callout: "الطلبات بتوصل وهي جاية",
      },
      pos: {
        title: "نقطة البيع",
        body: "كاشير كامل على أي جهاز، والمبيعات بتتجمع مع الأونلاين في نفس التقرير.",
        callout: "من غير مصالحة يدوية",
      },
    },
    whatsapp: {
      title: "واتساب",
      body: "الزبون بيطلب من شات فاتح عنده أصلًا، والطلب بيدخل لوحة التحكم زي أي طلب تاني.",
      callout: "نفس القناة اللي بيستخدمها كل يوم",
      chat: [
        { from: "customer", text: "عايز أطلب" },
        { from: "shop", text: "أهلًا 👋 اتفضل القائمة" },
        { from: "customer", text: "٢ شاورما و١ ليمون بالنعناع" },
        { from: "shop", text: "تمام — الإجمالي ٢١٥ ج.م" },
      ],
    },
  },
  en: {
    eyebrow: "The product",
    heading: "This is what the work actually looks like.",
    bands: {
      storefront: {
        title: "Storefront",
        body: "An Arabic ordering page on your own domain, built mobile-first.",
        callout: "No app for the customer to install",
      },
      dashboard: {
        title: "Dashboard",
        body: "Orders, products, branches and reporting — one place, updating live.",
        callout: "Orders arrive as they happen",
      },
      pos: {
        title: "Point of sale",
        body: "A full counter on any device, with till sales landing in the same report as online.",
        callout: "Nothing to reconcile by hand",
      },
    },
    whatsapp: {
      title: "WhatsApp",
      body: "Customers order from a chat they already have open, and it lands in the dashboard like any other order.",
      callout: "The channel they already use daily",
      chat: [
        { from: "customer", text: "I'd like to order" },
        { from: "shop", text: "Hi 👋 here's the menu" },
        { from: "customer", text: "2 shawarma and 1 mint lemonade" },
        { from: "shop", text: "Done — total is EGP 215" },
      ],
    },
  },
};
```

Create `src/app/(marketing)/_content/demo.ts`:

```ts
import type { Localized } from "./types";

export type DemoContent = {
  eyebrow: string;
  heading: string;
  body: string;
  openStorefront: string;
  openDashboard: string;
  resetNote: string;
};

export const DEMO: Localized<DemoContent> = {
  ar: {
    eyebrow: "جرّب بنفسك",
    heading: "ادخل على حساب شغّال، مش صور.",
    body: "أربع تجارب حية، واحدة لكل نشاط، متملية ببيانات حقيقية الشكل. افتح المتجر زي أي زبون، أو ادخل لوحة التحكم زي صاحب المحل.",
    openStorefront: "افتح المتجر",
    openDashboard: "ادخل لوحة التحكم",
    resetNote: "تجربة مشتركة — البيانات بترجع لأصلها كل يوم.",
  },
  en: {
    eyebrow: "Try it yourself",
    heading: "Open a working account, not a screenshot.",
    body: "Four live demos, one per trade, filled with realistic data. Open the storefront like a customer, or sign into the dashboard like the owner.",
    openStorefront: "Open the storefront",
    openDashboard: "Open the dashboard",
    resetNote: "Shared demo — data resets to its original state daily.",
  },
};
```

Create `src/app/(marketing)/_content/faq.ts`:

```ts
import type { Localized } from "./types";

export type FaqContent = { eyebrow: string; heading: string; items: { q: string; a: string }[] };

export const FAQ: Localized<FaqContent> = {
  ar: {
    eyebrow: "أسئلة شائعة",
    heading: "الأسئلة اللي بتيجي قبل الاشتراك.",
    items: [
      { q: "محتاج أجهزة معينة؟", a: "لأ. ServeOS شغّال من المتصفح على أي لابتوب أو تابلت أو موبايل. لو عندك طابعة أو درج كاش موجود، بيشتغلوا معاه." },
      { q: "بياناتي ملكي؟", a: "أيوه. المنتجات والطلبات والزباين بتاعتك، وتقدر تصدّرها في أي وقت." },
      { q: "لو وقّفت الاشتراك بيحصل إيه؟", a: "حسابك بينزل للباقة المجانية وبياناتك بتفضل موجودة. مفيش حذف عند الإيقاف." },
      { q: "بتشتغل من غير إنترنت؟", a: "نقطة البيع بتكمّل بيع وقت انقطاع النت وبتزامن أول ما يرجع. المتجر وواتساب محتاجين اتصال." },
      { q: "الدعم بالعربي؟", a: "أيوه، والواجهة كلها عربي بالكامل من اليمين لليسار." },
      { q: "فيه عقد أو التزام طويل؟", a: "أقل مدة اشتراك ثلاثة شهور، وتقدر تلغي التجديد في أي وقت. الباقة المجانية من غير أي التزام." },
    ],
  },
  en: {
    eyebrow: "FAQ",
    heading: "What people ask before signing up.",
    items: [
      { q: "Do I need specific hardware?", a: "No. ServeOS runs in the browser on any laptop, tablet or phone. If you already have a printer or cash drawer, they work with it." },
      { q: "Is my data mine?", a: "Yes. Your products, orders and customers are yours, and you can export them at any time." },
      { q: "What happens if I stop paying?", a: "Your account drops to the free plan and your data stays. Nothing is deleted on cancellation." },
      { q: "Does it work offline?", a: "The point of sale keeps selling through a dropout and syncs when the connection returns. The storefront and WhatsApp need a connection." },
      { q: "Is support in Arabic?", a: "Yes, and the entire interface is fully Arabic, right-to-left." },
      { q: "Is there a contract?", a: "The minimum term is three months and you can cancel renewal at any time. The free plan has no commitment at all." },
    ],
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: PASS — 3 helper tests plus 10 parity/empty tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)/_content"
git commit -m "feat(marketing): chrome, story, surface, demo and FAQ content in both languages"
```

---

## Task 6: Trade content migrated from the old verticals module

**Files:**
- Create: `src/app/(marketing)/_content/trades/restaurant.ts`, `retail.ts`, `pharmacy.ts`, `timber.ts`, `index.ts`
- Modify: `src/app/(marketing)/_content/parity.test.ts`

**Interfaces:**
- Produces: `TradeContent`, `TRADE_CONTENT: Record<VerticalId, Localized<TradeContent>>`
- Consumed by: Tasks 11, 12, 13

`src/app/_components/marketing/verticals.ts` already holds this copy in both languages for all four trades. **Migrate it verbatim** — this task is a move plus a shape change, not a rewrite. The only additions are `photoCaption` and `outcome`.

- [ ] **Step 1: Write the failing test**

Append to `src/app/(marketing)/_content/parity.test.ts`:

```ts
import { TRADE_CONTENT } from "./trades";
import { VERTICAL_IDS } from "@/server/verticals";

describe("trade content", () => {
  it("covers every registered trade", () => {
    expect(Object.keys(TRADE_CONTENT).sort()).toEqual([...VERTICAL_IDS].sort());
  });

  for (const id of VERTICAL_IDS) {
    it(`${id} has identical key paths in both languages`, () => {
      expect(keyPaths(TRADE_CONTENT[id].ar)).toEqual(keyPaths(TRADE_CONTENT[id].en));
    });

    it(`${id} offers exactly six features and three steps in both languages`, () => {
      for (const locale of ["ar", "en"] as const) {
        expect(TRADE_CONTENT[id][locale].features).toHaveLength(6);
        expect(TRADE_CONTENT[id][locale].steps).toHaveLength(3);
      }
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: FAIL — `Failed to load ./trades`.

- [ ] **Step 3: Define the shape and the index**

Create `src/app/(marketing)/_content/trades/index.ts`:

```ts
import type { LucideIcon } from "lucide-react";
import type { VerticalId } from "@/server/verticals";
import type { Localized } from "../types";
import { restaurant } from "./restaurant";
import { retail } from "./retail";
import { pharmacy } from "./pharmacy";
import { timber } from "./timber";

/** `roadmap` marks a feature the product does not ship yet; the card renders a
 *  "Soon" chip. Do not clear a flag until the domain exists in src/server. */
export type TradeFeature = { icon: LucideIcon; title: string; description: string; roadmap?: boolean };
export type TicketLine = { qty: string; name: string; meta: string; amount: string };

export type TradeContent = {
  label: string;
  badge: string;
  headlineLead: string;
  subhead: string;
  photoCaption: string;
  features: TradeFeature[];
  steps: { title: string; description: string }[];
  ticket: { ref: string; channel: string; lines: TicketLine[]; status: string; total: string };
};

/** Identical across all four trades by design — the promise does not change with the shop. */
export const HEADLINE_HIGHLIGHT: Localized<string> = {
  ar: "أنشئ موقعك في دقيقة واحدة.",
  en: "Create your own in 1 minute.",
};

export const SOON: Localized<string> = { ar: "قريبًا", en: "Soon" };

export const TRADE_CONTENT: Record<VerticalId, Localized<TradeContent>> = {
  restaurant,
  retail,
  pharmacy,
  timber,
};
```

- [ ] **Step 4: Migrate each trade**

For each of the four trades, create `src/app/(marketing)/_content/trades/<trade>.ts` by copying that trade's `copy.en` and `copy.ar` blocks out of `src/app/_components/marketing/verticals.ts` unchanged, dropping the `accent` field (it now comes from `VERTICAL_ACCENTS`), and adding one new `photoCaption` string per language. Restaurant is shown in full as the template:

```ts
import { QrCode, MessageCircle, CalendarCheck, Monitor, Package, ChartColumn } from "lucide-react";
import type { Localized } from "../types";
import type { TradeContent } from "./index";

export const restaurant: Localized<TradeContent> = {
  ar: {
    label: "مطاعم",
    badge: "قائمة QR · واتساب · طلب أونلاين",
    headlineLead: "مش لاقي موقع لمطعمك؟",
    subhead:
      "قائمتك أونلاين، والطلبات من كل مكان — الزبون يمسح كود على الطاولة، أو يبعت على واتساب، أو يطلب من صفحتك. كله بيوصل لوحة تحكم واحدة.",
    photoCaption: "من ورا الكاونتر، مش من ورا مكتب.",
    features: [
      { icon: QrCode, title: "قائمة وطلب بالـ QR", description: "كل ترابيزة ليها قائمة الزبون يتصفحها ويطلب منها في ثواني." },
      { icon: MessageCircle, title: "الطلب من واتساب", description: "من غير تطبيق — الزبون يطلب من شات فاتح عنده أصلًا." },
      { icon: CalendarCheck, title: "حجز الطاولات", description: "احجز من غير ما التليفون يفضل مشغول طول الخدمة.", roadmap: true },
      { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للطلبات الأونلاين والمبيعات في المحل — من غير مصالحة يدوية." },
      { icon: Package, title: "إدارة المخزون", description: "المخزون بيتحدث مع كل طلب، فتعرف اللي قرب يخلص.", roadmap: true },
      { icon: ChartColumn, title: "تقارير لحظية", description: "اعرف بيتباع إيه، وإمتى، وفين — أول بأول." },
    ],
    steps: [
      { title: "ابنِ قائمتك", description: "أقسام ومنتجات وصور — بالعربي والإنجليزي." },
      { title: "الزبون يطلب", description: "كود على الطاولة، واتساب، أو لينك الطلب." },
      { title: "كله في لوحة واحدة", description: "الطلبات والكاشير والمخزون بيتحدثوا سوا." },
    ],
    ticket: {
      ref: "ترابيزة ٤",
      channel: "في المحل · QR",
      lines: [
        { qty: "٢×", name: "طبق شاورما", meta: "توم زيادة، من غير مخلل", amount: "١٨٠٫٠٠" },
        { qty: "١×", name: "ليمون بالنعناع", meta: "كبير", amount: "٣٥٫٠٠" },
      ],
      status: "جهّز دلوقتي",
      total: "٢١٥٫٠٠",
    },
  },
  en: {
    label: "Restaurant",
    badge: "QR menu · WhatsApp · Web ordering",
    headlineLead: "No restaurant website?",
    subhead:
      "Your menu online, orders everywhere — customers order by scanning a table QR, messaging WhatsApp, or your own ordering page. No app to install, and it all lands in one dashboard.",
    photoCaption: "Built for behind the counter, not behind a desk.",
    features: [
      { icon: QrCode, title: "QR Menu & Ordering", description: "Every table gets a menu customers can browse and order from in seconds." },
      { icon: MessageCircle, title: "WhatsApp Ordering", description: "No app required — customers order straight from a chat they already have open." },
      { icon: CalendarCheck, title: "Table Reservations", description: "Take bookings without a phone tied up all service.", roadmap: true },
      { icon: Monitor, title: "Point of Sale", description: "One system for online orders and in-house sales — nothing to reconcile by hand." },
      { icon: Package, title: "Inventory Control", description: "Stock updates as orders come in, so you know what's running low.", roadmap: true },
      { icon: ChartColumn, title: "Live Analytics", description: "See what's selling, when, and where — as it happens." },
    ],
    steps: [
      { title: "Build your menu", description: "Categories, products, photos — in English and Arabic." },
      { title: "Customers order", description: "QR at the table, WhatsApp, or your ordering link." },
      { title: "It all lands in your dashboard", description: "Orders, POS, and stock update together." },
    ],
    ticket: {
      ref: "Table 4",
      channel: "Dine-in · QR",
      lines: [
        { qty: "2×", name: "Shawarma Plate", meta: "extra garlic, no pickles", amount: "180.00" },
        { qty: "1×", name: "Mint Lemonade", meta: "large", amount: "35.00" },
      ],
      status: "Fire now",
      total: "215.00",
    },
  },
};
```

Repeat for `retail.ts`, `pharmacy.ts` and `timber.ts`, taking each block verbatim from the old file — including every `roadmap: true` flag, which must survive the migration exactly. Add one `photoCaption` per language:

- retail — ar: `"من الرف للفاتورة في نفس النظام."` / en: `"From the shelf to the receipt in one system."`
- pharmacy — ar: `"صيدلية شغّالة، مش برنامج تاني."` / en: `"A working pharmacy, not another program."`
- timber — ar: `"المقاس بالمتر، والحساب مظبوط."` / en: `"Cut to size, priced to the millimetre."`

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: PASS — including 9 new trade tests.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(marketing)/_content/trades" "src/app/(marketing)/_content/parity.test.ts"
git commit -m "feat(marketing): migrate per-trade copy into content modules"
```

---

## Task 7: Term maths and money formatting

**Files:**
- Create: `src/app/(marketing)/_lib/terms.ts`, `terms.test.ts`
- Create: `src/app/(marketing)/_lib/format.ts`, `format.test.ts`

**Interfaces:**
- Produces: `TERMS`, `TermKey`, `termTotal`, `monthlyEquivalent`, `formatEgp`
- Consumed by: Task 16 (`Pricing`, `PricingTerms`, `PlanCard`)

- [ ] **Step 1: Write the failing tests**

Create `src/app/(marketing)/_lib/terms.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TERMS, termTotal, monthlyEquivalent } from "./terms";

describe("TERMS", () => {
  it("offers three terms starting at a three-month minimum", () => {
    expect(TERMS.map((t) => t.months)).toEqual([3, 6, 12]);
  });

  it("discounts nothing quarterly, a tenth half-yearly, a fifth annually", () => {
    expect(TERMS.map((t) => t.discount)).toEqual([0, 0.1, 0.2]);
  });
});

describe("termTotal", () => {
  it("charges list price for the quarterly term", () => {
    expect(termTotal(499, 3, 0)).toBe(1497);
    expect(termTotal(699, 3, 0)).toBe(2097);
    expect(termTotal(1099, 3, 0)).toBe(3297);
  });

  it("applies the half-yearly discount and rounds to whole pounds", () => {
    expect(termTotal(499, 6, 0.1)).toBe(2695);
    expect(termTotal(699, 6, 0.1)).toBe(3775);
    expect(termTotal(1099, 6, 0.1)).toBe(5935);
  });

  it("applies the annual discount", () => {
    expect(termTotal(499, 12, 0.2)).toBe(4790);
    expect(termTotal(699, 12, 0.2)).toBe(6710);
    expect(termTotal(1099, 12, 0.2)).toBe(10550);
  });

  it("keeps the free tier free on every term", () => {
    for (const t of TERMS) expect(termTotal(0, t.months, t.discount)).toBe(0);
  });
});

describe("monthlyEquivalent", () => {
  it("reports what the discounted term works out to per month", () => {
    expect(monthlyEquivalent(499, 3, 0)).toBe(499);
    expect(monthlyEquivalent(499, 12, 0.2)).toBe(399);
  });

  it("does not divide by zero for the free tier", () => {
    expect(monthlyEquivalent(0, 12, 0.2)).toBe(0);
  });
});
```

Create `src/app/(marketing)/_lib/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatEgp } from "./format";

const ARABIC_INDIC = /[٠-٩]/;
const WESTERN = /[0-9]/;

describe("formatEgp", () => {
  it("renders Arabic-Indic digits in Arabic", () => {
    const out = formatEgp(1497, "ar");
    expect(out).toMatch(ARABIC_INDIC);
    expect(out).not.toMatch(WESTERN);
  });

  it("renders Western digits in English", () => {
    const out = formatEgp(1497, "en");
    expect(out).toMatch(WESTERN);
    expect(out).not.toMatch(ARABIC_INDIC);
  });

  it("shows no fractional pounds", () => {
    expect(formatEgp(1497, "en")).not.toContain(".");
  });

  it("formats zero without throwing", () => {
    expect(formatEgp(0, "ar")).toMatch(ARABIC_INDIC);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run "src/app/(marketing)/_lib"`
Expected: FAIL — both modules missing.

- [ ] **Step 3: Write the implementations**

Create `src/app/(marketing)/_lib/terms.ts`:

```ts
/**
 * Billing terms shown on the pricing section. Quarterly is the minimum
 * commitment — there is no monthly term by design.
 *
 * These are DISPLAY maths only. What a subscription actually records when a
 * term is chosen is owned by the plans/billing spec, not by this page.
 */
export const TERMS = [
  { key: "quarterly", months: 3, discount: 0 },
  { key: "halfYearly", months: 6, discount: 0.1 },
  { key: "annual", months: 12, discount: 0.2 },
] as const;

export type Term = (typeof TERMS)[number];
export type TermKey = Term["key"];

/** Total charged for one term, in whole pounds. */
export function termTotal(priceMonthly: number, months: number, discount: number): number {
  return Math.round(priceMonthly * months * (1 - discount));
}

/** What that total works out to per month — the number buyers compare on. */
export function monthlyEquivalent(priceMonthly: number, months: number, discount: number): number {
  return Math.round(termTotal(priceMonthly, months, discount) / months);
}
```

Create `src/app/(marketing)/_lib/format.ts`:

```ts
import type { Locale } from "@/shared/errors";

/**
 * Money for the marketing page. Arabic gets Arabic-Indic digits, which is what
 * an Egyptian buyer reads on a receipt — src/lib/money.ts stays English-only
 * for the app surfaces and is deliberately not reused here.
 */
export function formatEgp(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-EG", {
    style: "currency",
    currency: "EGP",
    maximumFractionDigits: 0,
  }).format(amount);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run "src/app/(marketing)/_lib"`
Expected: PASS — 12 tests. If `en-EG` renders Arabic-Indic digits on this ICU build, change the English locale tag to `en-US` in `format.ts` and re-run; the test is asserting the requirement, not the tag.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)/_lib"
git commit -m "feat(marketing): billing term maths and locale-aware EGP formatting"
```

---

## Task 8: Demo entry URLs

**Files:**
- Create: `src/server/demo/entry.ts`, `src/server/demo/entry.test.ts`

**Interfaces:**
- Produces: `getDemoEntry(trade, rootDomain?)`
- Consumed by: Task 16 (`DemoCard`)

This is the entire contract between this page and the demo-tenant spec. Pure URL construction, no database access — the tenants, the login route and the daily reset are built separately.

- [ ] **Step 1: Write the failing test**

Create `src/server/demo/entry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getDemoEntry } from "./entry";
import { VERTICAL_IDS } from "@/server/verticals";

describe("getDemoEntry", () => {
  it("points at a per-trade demo subdomain over https in production", () => {
    expect(getDemoEntry("pharmacy", "serveos.tech")).toEqual({
      storefrontUrl: "https://demo-pharmacy.serveos.tech",
      dashboardUrl: "/api/demo/login?trade=pharmacy",
    });
  });

  it("uses http for local development domains", () => {
    expect(getDemoEntry("restaurant", "serveos.localhost").storefrontUrl).toBe(
      "http://demo-restaurant.serveos.localhost",
    );
  });

  it("builds a distinct entry for every registered trade", () => {
    const urls = VERTICAL_IDS.map((id) => getDemoEntry(id, "serveos.tech").storefrontUrl);
    expect(new Set(urls).size).toBe(VERTICAL_IDS.length);
  });

  it("never points a demo at the showcase tenants", () => {
    for (const id of VERTICAL_IDS) {
      const { storefrontUrl } = getDemoEntry(id, "serveos.tech");
      expect(storefrontUrl).not.toContain("roma");
      expect(storefrontUrl).not.toContain("nobio");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/demo/entry.test.ts`
Expected: FAIL — `Failed to load ./entry`.

- [ ] **Step 3: Write the implementation**

Create `src/server/demo/entry.ts`:

```ts
import type { VerticalId } from "@/server/verticals";

export type DemoEntry = { storefrontUrl: string; dashboardUrl: string };

/**
 * Where the marketing page's two demo doors lead.
 *
 * Deliberately separate slugs from the `roma` / `nobio` showcase tenants: the
 * demo is publicly writable and reset nightly, and coupling that to a showcase
 * tenant would mean one visitor's test order defaces the other.
 *
 * The tenants themselves, the /api/demo/login route and the reset job are owned
 * by the demo-tenants spec. Until it ships, these links resolve to nothing.
 */
export function getDemoEntry(
  trade: VerticalId,
  rootDomain: string = process.env.ROOT_DOMAIN ?? "serveos.localhost",
): DemoEntry {
  const isLocal = rootDomain === "localhost" || rootDomain.endsWith(".localhost");
  const protocol = isLocal ? "http:" : "https:";
  return {
    storefrontUrl: `${protocol}//demo-${trade}.${rootDomain}`,
    dashboardUrl: `/api/demo/login?trade=${trade}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/demo/entry.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/demo
git commit -m "feat(marketing): demo entry URL contract"
```

---

## Task 9: Screenshot paths and the existence guard

**Files:**
- Create: `src/app/(marketing)/_lib/shots.ts`, `shots.test.ts`
- Create: `public/marketing/shots/.gitkeep`

**Interfaces:**
- Produces: `SHOT_MATRIX`, `shotPath(trade, surface, locale, viewport)`
- Consumed by: Task 14 (`SurfaceBand`), Task 19 (capture script)

One module builds every capture path so the page and the capture script cannot disagree about where a file lives. The existence test is written now and **will fail until Task 19 produces the files** — it is skipped until then via an explicit guard, and Task 19 removes the guard.

- [ ] **Step 1: Write the failing test**

Create `src/app/(marketing)/_lib/shots.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { SHOT_MATRIX, shotPath } from "./shots";

describe("shotPath", () => {
  it("builds a public path from trade, surface, locale and viewport", () => {
    expect(shotPath("pharmacy", "dashboard", "ar", "desktop")).toBe(
      "/marketing/shots/pharmacy/dashboard.ar.desktop.webp",
    );
  });

  it("distinguishes viewports", () => {
    expect(shotPath("retail", "storefront", "ar", "mobile")).toBe(
      "/marketing/shots/retail/storefront.ar.mobile.webp",
    );
  });
});

describe("SHOT_MATRIX", () => {
  it("captures 24 shots", () => {
    expect(SHOT_MATRIX).toHaveLength(24);
  });

  it("captures three surfaces in Arabic for every trade", () => {
    const ar = SHOT_MATRIX.filter((s) => s.locale === "ar" && s.viewport === "desktop");
    expect(ar).toHaveLength(12);
  });

  it("captures storefront and dashboard in English for every trade", () => {
    const en = SHOT_MATRIX.filter((s) => s.locale === "en");
    expect(en).toHaveLength(8);
    expect(new Set(en.map((s) => s.surface))).toEqual(new Set(["storefront", "dashboard"]));
  });

  it("captures the storefront on mobile only", () => {
    const mobile = SHOT_MATRIX.filter((s) => s.viewport === "mobile");
    expect(mobile).toHaveLength(4);
    expect(new Set(mobile.map((s) => s.surface))).toEqual(new Set(["storefront"]));
  });

  it("has no duplicate paths", () => {
    const paths = SHOT_MATRIX.map((s) => shotPath(s.trade, s.surface, s.locale, s.viewport));
    expect(new Set(paths).size).toBe(paths.length);
  });

  // Enabled by the capture task once the files exist. Until then the page
  // renders a documented placeholder rather than a broken image.
  it.skip("every shot in the matrix exists on disk", () => {
    const missing = SHOT_MATRIX.map((s) => shotPath(s.trade, s.surface, s.locale, s.viewport))
      .filter((p) => !existsSync(path.join(process.cwd(), "public", p)));
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(marketing)/_lib/shots.test.ts"`
Expected: FAIL — `Failed to load ./shots`.

- [ ] **Step 3: Write the implementation**

Create `src/app/(marketing)/_lib/shots.ts`:

```ts
import { VERTICAL_IDS, type VerticalId } from "@/server/verticals";
import type { Locale } from "@/shared/errors";
import { SURFACE_KEYS, type SurfaceKey } from "../_content/surfaces";

export type Viewport = "desktop" | "mobile";
export type Shot = { trade: VerticalId; surface: SurfaceKey; locale: Locale; viewport: Viewport };

/** Public URL for a capture. The single place these paths are constructed. */
export function shotPath(trade: VerticalId, surface: SurfaceKey, locale: Locale, viewport: Viewport): string {
  // PNG because Playwright writes PNG or JPEG only, and next/image serves the
  // browser a modern format regardless of the source — converting buys nothing.
  return `/marketing/shots/${trade}/${surface}.${locale}.${viewport}.png`;
}

/**
 * 24 captures.
 *
 * Arabic desktop covers all three surfaces because Arabic is the default and
 * every band is shown in it. English only needs the two surfaces a non-Arabic
 * visitor is shown before deciding. Mobile covers the storefront alone — it is
 * the only surface a customer meets on a phone; dashboard and POS are desk
 * surfaces and the page frames them in a browser chrome that scales down
 * legibly.
 */
export const SHOT_MATRIX: Shot[] = [
  ...VERTICAL_IDS.flatMap((trade) =>
    SURFACE_KEYS.map((surface) => ({ trade, surface, locale: "ar" as const, viewport: "desktop" as const })),
  ),
  ...VERTICAL_IDS.flatMap((trade) =>
    (["storefront", "dashboard"] as const).map((surface) => ({
      trade, surface, locale: "en" as const, viewport: "desktop" as const,
    })),
  ),
  ...VERTICAL_IDS.map((trade) => ({
    trade, surface: "storefront" as const, locale: "ar" as const, viewport: "mobile" as const,
  })),
];
```

- [ ] **Step 4: Create the output directory**

```bash
mkdir -p public/marketing/shots && touch public/marketing/shots/.gitkeep
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run "src/app/(marketing)/_lib/shots.test.ts"`
Expected: PASS — 7 passing, 1 skipped.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(marketing)/_lib/shots.ts" "src/app/(marketing)/_lib/shots.test.ts" public/marketing/shots/.gitkeep
git commit -m "feat(marketing): screenshot path matrix and existence guard"
```

---

## Task 10: Route tree, paper surface, and the trade provider

**Files:**
- Create: `src/app/(marketing)/[lang]/layout.tsx`
- Create: `src/app/(marketing)/[lang]/page.tsx`
- Create: `src/app/(marketing)/_components/PaperSurface.tsx`
- Create: `src/app/(marketing)/_components/TradeProvider.tsx`

**Interfaces:**
- Produces: the `/ar` and `/en` routes, `useTrade()`
- Consumed by: every section task after this one

**Note on the spec's "three client islands".** Trade-dependent copy has to change without a page navigation, so the sections that vary by trade (hero, trade band, surface tour, features, steps, photo) are client components reading a `TradeProvider` context — the same pattern the old `VerticalProvider` used. Locale stays entirely server-side, which is the part that mattered. Non-trade sections (story, outcomes, pricing, FAQ, footer) remain server components.

- [ ] **Step 1: Write the provider**

Create `src/app/(marketing)/_components/TradeProvider.tsx`:

```tsx
"use client";
import { createContext, useContext, useState } from "react";
import type { VerticalId } from "@/server/verticals";
import type { Locale } from "@/shared/errors";
import type { TradeContent } from "../_content/trades";

type TradeBundle = { content: Record<VerticalId, TradeContent>; accents: Record<VerticalId, string> };

type TradeContextValue = {
  id: VerticalId;
  setTrade: (id: VerticalId) => void;
  trade: TradeContent;
  accent: string;
  locale: Locale;
  all: Record<VerticalId, TradeContent>;
};

const TradeContext = createContext<TradeContextValue | null>(null);

export function TradeProvider({
  bundle, locale, initial, children,
}: {
  bundle: TradeBundle;
  locale: Locale;
  initial: VerticalId;
  children: React.ReactNode;
}) {
  const [id, setTrade] = useState<VerticalId>(initial);
  return (
    <TradeContext.Provider
      value={{ id, setTrade, trade: bundle.content[id], accent: bundle.accents[id], locale, all: bundle.content }}
    >
      {/* Every section reads --trade-accent, so switching trade re-tints the
          page through CSS rather than re-rendering anything that doesn't care. */}
      <div style={{ ["--trade-accent" as string]: bundle.accents[id] }} data-trade={id}>
        {children}
      </div>
    </TradeContext.Provider>
  );
}

export function useTrade(): TradeContextValue {
  const ctx = useContext(TradeContext);
  if (!ctx) throw new Error("useTrade must be used within TradeProvider");
  return ctx;
}
```

- [ ] **Step 2: Write the paper surface**

Create `src/app/(marketing)/_components/PaperSurface.tsx`:

```tsx
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E\")";

/**
 * The page's material. A flat hex reads as a filled div; grain over three warm
 * radial washes reads as lit paper. Both layers are decorative and inert.
 */
export function PaperSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            "radial-gradient(900px 420px at 88% -12%, color-mix(in srgb, var(--trade-accent) 16%, transparent), transparent 62%)",
            "radial-gradient(700px 340px at 6% 34%, color-mix(in srgb, var(--trade-accent) 10%, transparent), transparent 64%)",
            "radial-gradient(600px 500px at 50% 108%, color-mix(in srgb, var(--trade-accent) 8%, transparent), transparent 60%)",
          ].join(","),
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.22] mix-blend-multiply"
        style={{ backgroundImage: GRAIN }}
      />
      {/* Editorial furniture: a 120px hairline column grid, barely visible, that
          gives the page an underlying measure rather than free-floating blocks. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: "linear-gradient(to right, color-mix(in srgb, var(--foreground) 4.5%, transparent) 1px, transparent 1px)",
          backgroundSize: "120px 100%",
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
```

- [ ] **Step 3: Write the layout**

Create `src/app/(marketing)/[lang]/layout.tsx`:

```tsx
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
```

It exists so marketing can gain shared chrome later without touching the app-wide root layout. `<html>` stays in the root layout — only it may render one.

- [ ] **Step 4: Write the page skeleton**

Create `src/app/(marketing)/[lang]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Locale } from "@/shared/errors";
import { VERTICAL_IDS, VERTICAL_ACCENTS, type VerticalId } from "@/server/verticals";
import { TRADE_CONTENT, type TradeContent } from "../_content/trades";
import { PaperSurface } from "../_components/PaperSurface";
import { TradeProvider } from "../_components/TradeProvider";

function toLocale(lang: string): Locale {
  if (lang !== "ar" && lang !== "en") notFound();
  return lang;
}

const META: Record<Locale, { title: string; description: string }> = {
  ar: {
    title: "ServeOS — نظام واحد للمحل: طلبات، كاشير، وواتساب",
    description:
      "قائمتك أونلاين، والطلبات من الطاولة ومن واتساب ومن متجرك — كلها في لوحة تحكم واحدة. بالعربي وبالجنيه المصري.",
  },
  en: {
    title: "ServeOS — one system for orders, counter and WhatsApp",
    description:
      "Your menu online and orders from the table, WhatsApp and your storefront in one dashboard. Arabic-first, priced in EGP.",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  const site = "https://serveos.tech";
  return {
    title: META[locale].title,
    description: META[locale].description,
    alternates: {
      canonical: locale === "ar" ? `${site}/` : `${site}/en`,
      languages: { ar: `${site}/`, en: `${site}/en` },
    },
  };
}

export default async function MarketingPage({ params }: { params: Promise<{ lang: string }> }) {
  const locale = toLocale((await params).lang);

  // /ar and /en are reachable on any host; only the marketing surface serves them.
  const surface = (await headers()).get("x-surface");
  if (surface !== "marketing") notFound();

  const content = Object.fromEntries(
    VERTICAL_IDS.map((id) => [id, TRADE_CONTENT[id][locale]]),
  ) as Record<VerticalId, TradeContent>;

  return (
    <TradeProvider
      bundle={{ content, accents: VERTICAL_ACCENTS }}
      locale={locale}
      initial="restaurant"
    >
      <PaperSurface>
        <main id="hero" />
      </PaperSurface>
    </TradeProvider>
  );
}
```

- [ ] **Step 5: Verify the routes render**

```bash
npm run dev
```

Visit `http://localhost:3000/` — expect a blank warm page and, in the page source, `<html lang="ar" dir="rtl">`.
Visit `http://localhost:3000/en` — expect `<html lang="en" dir="ltr">`.
Visit `http://localhost:3000/ar` — expect a redirect to `/`.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): route tree, paper surface and trade provider"
```

---

## Task 11: Header and footer

**Files:**
- Create: `src/app/(marketing)/_components/Header.tsx`, `Footer.tsx`
- Modify: `src/app/(marketing)/[lang]/page.tsx`

**Interfaces:**
- Consumes: `CHROME` (Task 5)

Both are server components — neither depends on the selected trade.

- [ ] **Step 1: Write the header**

Create `src/app/(marketing)/_components/Header.tsx`:

```tsx
import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/shared/errors";
import { CHROME } from "../_content/chrome";

export function Header({ locale }: { locale: Locale }) {
  const t = CHROME[locale];
  const otherHref = locale === "ar" ? "/en" : "/";

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="#hero" className="flex items-center gap-2">
          <LogoMark className="size-7 text-primary" />
          <Wordmark className="text-lg" />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-8 text-sm font-medium text-muted-foreground md:flex">
          <a href="#surfaces" className="hover:text-foreground">{t.nav.platform}</a>
          <a href="#features" className="hover:text-foreground">{t.nav.trades}</a>
          <a href="#pricing" className="hover:text-foreground">{t.nav.pricing}</a>
          <a href="#demo" className="hover:text-foreground">{t.nav.demo}</a>
        </nav>

        <div className="flex items-center gap-3">
          <Link href={otherHref} className="text-sm text-muted-foreground hover:text-foreground" hrefLang={locale === "ar" ? "en" : "ar"}>
            {t.otherLocale}
          </Link>
          <Link href="/login" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">
            {t.signIn}
          </Link>
          <Button asChild size="sm">
            <Link href="/register">{t.getStarted}</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Write the footer**

Create `src/app/(marketing)/_components/Footer.tsx`:

```tsx
import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { Wordmark } from "@/components/brand/Wordmark";
import type { Locale } from "@/shared/errors";
import { CHROME } from "../_content/chrome";

export function Footer({ locale }: { locale: Locale }) {
  const t = CHROME[locale];
  const otherHref = locale === "ar" ? "/en" : "/";

  return (
    <footer className="border-t border-border/60 bg-card/40">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-1">
            <div className="flex items-center gap-2">
              <LogoMark className="size-6 text-primary" />
              <Wordmark className="text-base" />
            </div>
          </div>

          {t.footer.columns.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{col.heading}</h3>
              <ul className="mt-4 space-y-2.5 text-sm">
                {col.links.map((l) => (
                  <li key={`${col.heading}-${l.label}`}>
                    <Link href={l.href} className="text-foreground/80 hover:text-foreground">{l.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <ul className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/60 pt-6 text-xs text-muted-foreground">
          {t.footer.trust.map((item) => <li key={item}>{item}</li>)}
        </ul>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{t.footer.copyright}</span>
          <Link href={otherHref} className="hover:text-foreground" hrefLang={locale === "ar" ? "en" : "ar"}>
            {t.otherLocale}
          </Link>
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 3: Mount them**

In `src/app/(marketing)/[lang]/page.tsx`, import both and replace the `<main id="hero" />` placeholder:

```tsx
      <PaperSurface>
        <Header locale={locale} />
        <main />
        <Footer locale={locale} />
      </PaperSurface>
```

- [ ] **Step 4: Verify**

With `npm run dev` running, visit `http://localhost:3000/` — the header and five-column footer render in Arabic, right-to-left. Visit `/en` and confirm the mirror.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): header and versatile footer"
```

---

## Task 12: Trade switcher and trade band

**Files:**
- Create: `src/app/(marketing)/_components/TradeSwitcher.tsx`, `TradeBand.tsx`
- Modify: `src/app/(marketing)/[lang]/page.tsx`

**Interfaces:**
- Consumes: `useTrade()` (Task 10)

The switcher exposes `role="tab"` with `aria-selected`, which the existing E2E suite already relies on for trade switching. Keep that contract.

- [ ] **Step 1: Write the switcher**

Create `src/app/(marketing)/_components/TradeSwitcher.tsx`:

```tsx
"use client";
import { VERTICAL_IDS } from "@/server/verticals";
import { useTrade } from "./TradeProvider";

export function TradeSwitcher() {
  const { id, setTrade, all } = useTrade();

  return (
    <div role="tablist" aria-label="Trade" className="flex flex-wrap items-center gap-2">
      {VERTICAL_IDS.map((tradeId) => {
        const selected = tradeId === id;
        return (
          <button
            key={tradeId}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => setTrade(tradeId)}
            className={
              selected
                ? "rounded-full border px-4 py-1.5 text-sm transition-colors motion-reduce:transition-none"
                : "rounded-full border border-border px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
            }
            style={
              selected
                ? {
                    borderColor: "color-mix(in srgb, var(--trade-accent) 45%, transparent)",
                    backgroundColor: "color-mix(in srgb, var(--trade-accent) 12%, transparent)",
                    color: "color-mix(in srgb, var(--trade-accent) 75%, black)",
                  }
                : undefined
            }
          >
            {all[tradeId].label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Write the band**

Create `src/app/(marketing)/_components/TradeBand.tsx`:

```tsx
"use client";
import { useTrade } from "./TradeProvider";
import { TradeSwitcher } from "./TradeSwitcher";

const LABEL = { ar: "اختر نشاطك", en: "Choose your trade" } as const;
const NOTE = { ar: "اللون والمحتوى بيتغيروا مع النشاط", en: "Colour and copy follow the trade" } as const;

export function TradeBand() {
  const { locale } = useTrade();
  return (
    <section className="border-y border-border/60 bg-card/50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-6 py-4">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{LABEL[locale]}</span>
        <TradeSwitcher />
        <span className="ms-auto hidden text-[11px] text-muted-foreground lg:inline">{NOTE[locale]}</span>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Mount it**

In `page.tsx`, inside `<main>`:

```tsx
        <main>
          <TradeBand />
        </main>
```

- [ ] **Step 4: Verify**

Visit `/`. Four chips render; clicking one moves `aria-selected` and re-tints the chip. Confirm the wash behind the page shifts colour when you pick Retail (teal) or Timber (amber).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): trade switcher and accent band"
```

---

## Task 13: Hero and the live ticket

**Files:**
- Create: `src/app/(marketing)/_components/Hero.tsx`, `LiveTicket.tsx`
- Modify: `src/app/(marketing)/[lang]/page.tsx`

**Interfaces:**
- Consumes: `useTrade()`, `HEADLINE_HIGHLIGHT`, `shotPath`

`LiveTicket` replaces the old `TicketCard`. It carries `data-testid="ticket"`, which the E2E suite asserts on — including a test that the ticket keeps one height across all four trades, so keep the fixed minimum height.

- [ ] **Step 1: Write the ticket**

Create `src/app/(marketing)/_components/LiveTicket.tsx`:

```tsx
"use client";
import { useTrade } from "./TradeProvider";

export function LiveTicket() {
  const { trade, locale } = useTrade();
  const t = trade.ticket;

  return (
    <div
      data-testid="ticket"
      // Fixed min-height: the docket must not resize when the trade changes,
      // or the hero jumps on every switch. An E2E test pins this.
      className="min-h-[260px] w-full max-w-[280px] rounded-lg border border-border bg-card shadow-[0_18px_40px_rgba(58,51,44,0.20)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2"
      style={{ transform: "rotate(2.4deg)" }}
    >
      <div className="flex items-center justify-between border-b border-dashed border-border px-3.5 py-2.5">
        <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
        <span
          className="rounded-full px-2.5 py-0.5 text-[10px]"
          style={{
            backgroundColor: "color-mix(in srgb, var(--trade-accent) 14%, transparent)",
            color: "color-mix(in srgb, var(--trade-accent) 75%, black)",
          }}
        >
          {t.status}
        </span>
      </div>

      <div className="px-3.5 py-3 text-[13px] leading-7">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{t.channel}</p>
        {t.lines.map((line) => (
          <div key={`${line.name}-${line.meta}`} className="mb-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span>{line.qty} {line.name}</span>
              <span className="text-muted-foreground">{line.amount}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{line.meta}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border bg-muted/50 px-3.5 py-2.5 text-sm font-bold">
        <span>{locale === "ar" ? "الإجمالي" : "Total"}</span>
        <span style={{ color: "var(--trade-accent)" }}>{t.total}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the hero**

Create `src/app/(marketing)/_components/Hero.tsx`:

```tsx
"use client";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { HEADLINE_HIGHLIGHT } from "../_content/trades";
import { shotPath } from "../_lib/shots";
import { useTrade } from "./TradeProvider";
import { LiveTicket } from "./LiveTicket";

const TRUST = {
  ar: ["بدون بطاقة ائتمان", "بالجنيه المصري", "عربي وإنجليزي"],
  en: ["No credit card", "Priced in EGP", "Arabic and English"],
} as const;

const CTA = {
  ar: { start: "ابدأ مجانًا", demo: "شوف تجربة حية" },
  en: { start: "Start free", demo: "See a live demo" },
} as const;

export function Hero() {
  const { id, trade, locale } = useTrade();

  return (
    <section id="hero" className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:py-28">
      <div>
        <p className="mb-5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <span aria-hidden="true" className="inline-block h-px w-6" style={{ backgroundColor: "var(--trade-accent)" }} />
          {trade.badge}
        </p>

        <h1 className="text-4xl font-extrabold leading-[1.18] tracking-[-0.035em] sm:text-5xl">
          {trade.headlineLead}
          <br />
          {/* A marker swipe rather than coloured text — warmer, and being a
              background it needs no direction handling when the page flips. */}
          <span className="relative inline-block">
            <span className="relative z-10">{HEADLINE_HIGHLIGHT[locale]}</span>
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-1 z-0 h-3 rounded-sm"
              style={{ backgroundColor: "color-mix(in srgb, var(--trade-accent) 30%, transparent)" }}
            />
          </span>
        </h1>

        <p className="mt-5 max-w-xl text-[15px] leading-8 text-muted-foreground">{trade.subhead}</p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Button asChild size="lg"><Link href="/register">{CTA[locale].start}</Link></Button>
          <Button asChild size="lg" variant="outline"><Link href="#demo">{CTA[locale].demo}</Link></Button>
        </div>

        <ul className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {TRUST[locale].map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>

      <div className="relative min-h-[300px]">
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_26px_60px_rgba(58,51,44,0.16)]" style={{ transform: "rotate(-1.2deg)" }}>
          <Image
            src={shotPath(id, "dashboard", locale, "desktop")}
            alt=""
            width={1440}
            height={900}
            priority
            className="h-auto w-full"
          />
        </div>
        <div className="absolute -bottom-6 end-0">
          <LiveTicket />
        </div>
      </div>
    </section>
  );
}
```

> Until Task 19 captures the images, `next/image` renders a broken image here. That is expected and is why the shots existence test is skipped until then.

- [ ] **Step 3: Mount it**

In `page.tsx`, place `<Hero />` above `<TradeBand />` inside `<main>`.

- [ ] **Step 4: Verify**

Visit `/`. The Arabic headline renders with the marker swipe, the ticket sits rotated over the (broken) screenshot frame, and switching trade changes headline, badge and ticket contents without the docket resizing.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): hero with layered screenshot stack and live ticket"
```

---

## Task 14: Story, surface tour, WhatsApp band and photo band

**Files:**
- Create: `src/app/(marketing)/_components/Story.tsx`, `SurfaceTour.tsx`, `SurfaceBand.tsx`, `WhatsappBand.tsx`, `PhotoBand.tsx`
- Modify: `src/app/(marketing)/[lang]/page.tsx`

**Interfaces:**
- Consumes: `STORY`, `SURFACES`, `useTrade()`, `shotPath`

- [ ] **Step 1: Write the story section**

Create `src/app/(marketing)/_components/Story.tsx`:

```tsx
import type { Locale } from "@/shared/errors";
import { STORY } from "../_content/story";

export function Story({ locale }: { locale: Locale }) {
  const t = STORY[locale];
  return (
    <section id="story" className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>
      {t.body.map((para) => (
        <p key={para.slice(0, 24)} className="mt-5 text-[15px] leading-8 text-muted-foreground">{para}</p>
      ))}
    </section>
  );
}
```

- [ ] **Step 2: Write one surface band**

Create `src/app/(marketing)/_components/SurfaceBand.tsx`:

```tsx
"use client";
import Image from "next/image";
import type { SurfaceKey } from "../_content/surfaces";
import { SURFACES } from "../_content/surfaces";
import { shotPath } from "../_lib/shots";
import { useTrade } from "./TradeProvider";

export function SurfaceBand({ surface, index }: { surface: SurfaceKey; index: number }) {
  const { id, locale } = useTrade();
  const t = SURFACES[locale].bands[surface];
  const flip = index % 2 === 1;

  return (
    <div className="grid items-center gap-10 py-12 lg:grid-cols-2 lg:gap-16">
      <div className={flip ? "lg:order-2" : undefined}>
        <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
          {String(index + 1).padStart(2, "0")}
        </p>
        <h3 className="mt-3 text-2xl font-bold tracking-[-0.02em]">{t.title}</h3>
        <p className="mt-3 max-w-md text-[15px] leading-8 text-muted-foreground">{t.body}</p>
        <p className="mt-4 inline-block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">{t.callout}</p>
      </div>

      <div className={flip ? "lg:order-1" : undefined}>
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_20px_50px_rgba(58,51,44,0.14)]">
          <Image
            src={shotPath(id, surface, locale, "desktop")}
            alt={t.title}
            width={1440}
            height={900}
            loading="lazy"
            className="h-auto w-full"
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the WhatsApp band**

Create `src/app/(marketing)/_components/WhatsappBand.tsx`:

```tsx
"use client";
import { SURFACES } from "../_content/surfaces";
import { useTrade } from "./TradeProvider";

/**
 * Rendered from ServeOS tokens, never captured. Screenshotting WhatsApp would
 * reproduce Meta's interface, and dressing a mock up as a screenshot would
 * misrepresent whose product the visitor is looking at.
 */
export function WhatsappBand({ index }: { index: number }) {
  const { locale } = useTrade();
  const t = SURFACES[locale].whatsapp;

  return (
    <div className="grid items-center gap-10 py-12 lg:grid-cols-2 lg:gap-16">
      <div>
        <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
          {String(index + 1).padStart(2, "0")}
        </p>
        <h3 className="mt-3 text-2xl font-bold tracking-[-0.02em]">{t.title}</h3>
        <p className="mt-3 max-w-md text-[15px] leading-8 text-muted-foreground">{t.body}</p>
        <p className="mt-4 inline-block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">{t.callout}</p>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-[0_20px_50px_rgba(58,51,44,0.14)]">
        <ul className="space-y-2.5">
          {t.chat.map((msg) => (
            <li
              key={msg.text}
              className={msg.from === "shop" ? "flex justify-end" : "flex justify-start"}
            >
              <span
                className="max-w-[80%] rounded-2xl px-3.5 py-2 text-[13px] leading-6"
                style={
                  msg.from === "shop"
                    ? { backgroundColor: "color-mix(in srgb, var(--trade-accent) 14%, transparent)" }
                    : { backgroundColor: "var(--muted)" }
                }
              >
                {msg.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the tour wrapper**

Create `src/app/(marketing)/_components/SurfaceTour.tsx`:

```tsx
"use client";
import { SURFACE_KEYS, SURFACES } from "../_content/surfaces";
import { useTrade } from "./TradeProvider";
import { SurfaceBand } from "./SurfaceBand";
import { WhatsappBand } from "./WhatsappBand";

export function SurfaceTour() {
  const { locale } = useTrade();
  const t = SURFACES[locale];

  return (
    <section id="surfaces" className="mx-auto max-w-6xl px-6 py-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <div className="mt-6 divide-y divide-border/60">
        {SURFACE_KEYS.map((surface, i) => (
          <SurfaceBand key={surface} surface={surface} index={i} />
        ))}
        <WhatsappBand index={SURFACE_KEYS.length} />
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Write the photo band**

Create `src/app/(marketing)/_components/PhotoBand.tsx`:

```tsx
"use client";
import Image from "next/image";
import { useTrade } from "./TradeProvider";

/**
 * Duotone: a full-bleed photograph under an accent wash in multiply. The source
 * images are swappable assets — until real Egyptian photography is sourced the
 * band renders the accent field alone, which is a deliberate empty state rather
 * than a broken image.
 */
export function PhotoBand({ src }: { src?: string }) {
  const { trade } = useTrade();

  return (
    <section className="relative isolate my-8 h-[280px] overflow-hidden sm:h-[340px]">
      {src ? (
        <Image src={src} alt="" fill sizes="100vw" className="object-cover grayscale" />
      ) : null}
      <div
        aria-hidden="true"
        className="absolute inset-0 mix-blend-multiply"
        style={{ backgroundColor: "color-mix(in srgb, var(--trade-accent) 55%, transparent)" }}
      />
      <div className="relative flex h-full items-end">
        <p className="mx-auto w-full max-w-6xl px-6 pb-8 text-2xl font-bold tracking-[-0.02em] text-background">
          {trade.photoCaption}
        </p>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Mount them**

In `page.tsx` inside `<main>`, in order: `<Hero />`, `<TradeBand />`, `<Story locale={locale} />`, `<SurfaceTour />`, `<PhotoBand />`.

- [ ] **Step 7: Verify**

Visit `/`. The story reads in Arabic, four tour bands alternate sides, the WhatsApp exchange renders right-aligned for the shop, and the photo band shows the accent field with the trade caption. Switch trade and confirm the caption and accent both change.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): story, surface tour, WhatsApp band and photo band"
```

---

## Task 15: Feature grid and steps

**Files:**
- Create: `src/app/(marketing)/_components/FeatureGrid.tsx`, `Steps.tsx`
- Modify: `src/app/(marketing)/[lang]/page.tsx`

**Interfaces:**
- Consumes: `useTrade()`, `SOON`

The قريبًا / Soon chip is load-bearing: an E2E test asserts that a `roadmap: true` feature is marked rather than sold. Do not drop it.

- [ ] **Step 1: Write the feature grid**

Create `src/app/(marketing)/_components/FeatureGrid.tsx`:

```tsx
"use client";
import { SOON } from "../_content/trades";
import { useTrade } from "./TradeProvider";

const HEADING = {
  ar: { eyebrow: "ما الذي تحصل عليه", heading: "كل ما تحتاجه خلف الكاونتر." },
  en: { eyebrow: "What you get", heading: "Everything you need behind the counter." },
} as const;

export function FeatureGrid() {
  const { trade, locale } = useTrade();
  const t = HEADING[locale];

  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <div className="mt-10 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
        {trade.features.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.title}>
              <Icon aria-hidden="true" className="size-5" style={{ color: "var(--trade-accent)" }} />
              <h3 className="mt-3 flex items-center gap-2 text-base font-bold tracking-[-0.01em]">
                {f.title}
                {f.roadmap ? (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
                    {SOON[locale]}
                  </span>
                ) : null}
              </h3>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">{f.description}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Write the steps**

Create `src/app/(marketing)/_components/Steps.tsx`:

```tsx
"use client";
import { useTrade } from "./TradeProvider";

const HEADING = {
  ar: { eyebrow: "كيف تعمل", heading: "انطلق في ثلاث خطوات." },
  en: { eyebrow: "How it works", heading: "Live in three steps." },
} as const;

/** Arabic-Indic section numerals — ٠١ ٠٢ ٠٣ — part of the editorial furniture. */
function ordinal(index: number, locale: "ar" | "en"): string {
  const n = String(index + 1).padStart(2, "0");
  return locale === "ar" ? new Intl.NumberFormat("ar-EG").format(index + 1).padStart(2, "٠") : n;
}

export function Steps() {
  const { trade, locale } = useTrade();
  const t = HEADING[locale];

  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <ol className="mt-10 grid gap-10 sm:grid-cols-3">
        {trade.steps.map((step, i) => (
          <li key={step.title} className={i > 0 ? "border-border/60 sm:border-s sm:ps-8" : undefined}>
            <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
              {ordinal(i, locale)}
            </p>
            <h3 className="mt-3 text-base font-bold tracking-[-0.01em]">{step.title}</h3>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 3: Mount them**

In `page.tsx`, after `<PhotoBand />`: `<FeatureGrid />` then `<Steps />`.

- [ ] **Step 4: Verify**

Visit `/`, switch to Pharmacy, and confirm a roadmap feature shows the قريبًا chip. Confirm step numerals render as ٠١ ٠٢ ٠٣ in Arabic and 01 02 03 at `/en`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): feature grid with roadmap chips and numbered steps"
```

---

## Task 16: Demo band

**Files:**
- Create: `src/app/(marketing)/_components/DemoBand.tsx`, `DemoCard.tsx`
- Modify: `src/app/(marketing)/[lang]/page.tsx`

**Interfaces:**
- Consumes: `DEMO` (Task 5), `getDemoEntry` (Task 8), `VERTICAL_ACCENTS`

This is the one dark band on the page — used exactly once, so it lands. Both components are server components: all four trades are shown at once, so nothing here depends on the selected trade.

- [ ] **Step 1: Write the card**

Create `src/app/(marketing)/_components/DemoCard.tsx`:

```tsx
import Link from "next/link";
import { getDemoEntry } from "@/server/demo/entry";
import { VERTICAL_ACCENTS, type VerticalId } from "@/server/verticals";

export function DemoCard({
  trade, label, openStorefront, openDashboard,
}: {
  trade: VerticalId;
  label: string;
  openStorefront: string;
  openDashboard: string;
}) {
  const { storefrontUrl, dashboardUrl } = getDemoEntry(trade);
  const accent = VERTICAL_ACCENTS[trade];

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <span
        className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs"
        style={{ backgroundColor: `${accent}1F`, color: accent }}
      >
        <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: accent }} />
        {label}
      </span>

      <div className="mt-5 flex flex-col gap-2">
        <Link
          href={storefrontUrl}
          className="rounded-md px-4 py-2.5 text-center text-sm font-medium text-[#14120F]"
          style={{ backgroundColor: accent }}
        >
          {openStorefront}
        </Link>
        <Link
          href={dashboardUrl}
          className="rounded-md border border-white/20 px-4 py-2.5 text-center text-sm text-white/90 hover:bg-white/5"
        >
          {openDashboard}
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the band**

Create `src/app/(marketing)/_components/DemoBand.tsx`:

```tsx
import type { Locale } from "@/shared/errors";
import { VERTICAL_IDS } from "@/server/verticals";
import { DEMO } from "../_content/demo";
import { TRADE_CONTENT } from "../_content/trades";
import { DemoCard } from "./DemoCard";

export function DemoBand({ locale }: { locale: Locale }) {
  const t = DEMO[locale];

  return (
    <section id="demo" className="bg-[#14120F] text-[#F7F4F1]">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/50">{t.eyebrow}</p>
        <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>
        <p className="mt-4 max-w-xl text-[15px] leading-8 text-white/70">{t.body}</p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {VERTICAL_IDS.map((trade) => (
            <DemoCard
              key={trade}
              trade={trade}
              label={TRADE_CONTENT[trade][locale].label}
              openStorefront={t.openStorefront}
              openDashboard={t.openDashboard}
            />
          ))}
        </div>

        <p className="mt-6 text-xs text-white/50">{t.resetNote}</p>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Mount it**

In `page.tsx`, after `<Steps />`: `<DemoBand locale={locale} />`.

- [ ] **Step 4: Verify**

Visit `/`. One dark band, four cards, each with two doors. Hover a storefront link and confirm the URL is `demo-<trade>.serveos.localhost` in development.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): live demo band with two doors per trade"
```

---

## Task 17: Illustrative outcomes

**Files:**
- Create: `src/app/(marketing)/_content/outcomes.ts`
- Create: `src/app/(marketing)/_components/Outcomes.tsx`
- Modify: `src/app/(marketing)/_content/parity.test.ts`, `src/app/(marketing)/[lang]/page.tsx`

**Interfaces:**
- Produces: `OUTCOMES`, `OutcomesContent`

Scenarios, not quotes attributed to invented people, carrying a visible illustrative label. The `attribution` field exists so a real customer quote drops in later without a redesign — it is optional and currently unset everywhere.

- [ ] **Step 1: Write the failing test**

In `src/app/(marketing)/_content/parity.test.ts`, add `OUTCOMES` to the imports and to the `modules` object in the existing parity describe block:

```ts
import { OUTCOMES } from "./outcomes";
```

```ts
  const modules = { CHROME, STORY, SURFACES, DEMO, FAQ, OUTCOMES };
```

And add:

```ts
describe("outcomes", () => {
  it("ships three scenarios in both languages", () => {
    for (const locale of ["ar", "en"] as const) {
      expect(OUTCOMES[locale].items).toHaveLength(3);
    }
  });

  it("attributes nothing to a named person until a real quote exists", () => {
    for (const locale of ["ar", "en"] as const) {
      for (const item of OUTCOMES[locale].items) {
        expect(item.attribution).toBeUndefined();
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: FAIL — `Failed to load ./outcomes`.

- [ ] **Step 3: Write the content**

Create `src/app/(marketing)/_content/outcomes.ts`:

```ts
import type { Localized } from "./types";

export type OutcomeItem = {
  scenario: string;
  situation: string;
  result: string;
  /** Set only when a real, consenting customer has given a quote. */
  attribution?: { name: string; role: string };
};

export type OutcomesContent = { eyebrow: string; heading: string; label: string; items: OutcomeItem[] };

export const OUTCOMES: Localized<OutcomesContent> = {
  ar: {
    eyebrow: "أمثلة من السوق",
    heading: "شكل الشغل قبل وبعد.",
    label: "نماذج توضيحية",
    items: [
      {
        scenario: "سلسلة كشري بثلاثة فروع",
        situation: "كل فرع بيسجّل مبيعاته لوحده، والمقارنة بينهم آخر الشهر على ورق.",
        result: "تقرير واحد بيقارن الفروع لحظيًا، والطلب الأونلاين داخل نفس الحساب.",
      },
      {
        scenario: "صيدلية في فيصل",
        situation: "طلبات الواتساب بتضيع بين الرسايل، والمخزون بيتراجع يدوي.",
        result: "الطلب بيتحوّل لأوردر في اللوحة، والصرف بيتسجّل مع البيع.",
      },
      {
        scenario: "مخزن أخشاب في الشيخ زايد",
        situation: "كل مقاس بيتحسب بالآلة الحاسبة، والسعر بيختلف من بائع للتاني.",
        result: "التسعير بالمقاس متسجّل في النظام، فالسعر واحد مهما كان اللي بيبيع.",
      },
    ],
  },
  en: {
    eyebrow: "Examples from the market",
    heading: "What the work looks like before and after.",
    label: "Illustrative",
    items: [
      {
        scenario: "A three-branch koshary chain",
        situation: "Each branch records its own sales, and comparing them happens on paper at month end.",
        result: "One report compares branches live, with online orders in the same account.",
      },
      {
        scenario: "A pharmacy in Faisal",
        situation: "WhatsApp orders get lost between messages and stock is adjusted by hand.",
        result: "The message becomes an order in the dashboard, and dispensing is recorded with the sale.",
      },
      {
        scenario: "A timber yard in Sheikh Zayed",
        situation: "Every cut is priced on a calculator, and the number changes with whoever is serving.",
        result: "Dimensional pricing lives in the system, so the price is the same whoever sells it.",
      },
    ],
  },
};
```

- [ ] **Step 4: Write the component**

Create `src/app/(marketing)/_components/Outcomes.tsx`:

```tsx
import type { Locale } from "@/shared/errors";
import { OUTCOMES } from "../_content/outcomes";

export function Outcomes({ locale }: { locale: Locale }) {
  const t = OUTCOMES[locale];

  return (
    <section id="outcomes" className="mx-auto max-w-6xl px-6 py-20">
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
        {/* Stated plainly: these are scenarios, not customer quotes. */}
        <span className="rounded-full border border-border px-2.5 py-0.5 text-[10px] text-muted-foreground">{t.label}</span>
      </div>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <div className="mt-10 grid gap-8 sm:grid-cols-3">
        {t.items.map((item) => (
          <article key={item.scenario} className="rounded-xl border border-border bg-card/60 p-5">
            <h3 className="text-base font-bold tracking-[-0.01em]">{item.scenario}</h3>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">{item.situation}</p>
            <p className="mt-3 border-t border-border/60 pt-3 text-sm leading-7">{item.result}</p>
            {item.attribution ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {item.attribution.name} — {item.attribution.role}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run test and mount**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: PASS.

In `page.tsx`, after `<DemoBand />`: `<Outcomes locale={locale} />`.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): illustrative outcome scenarios, labelled as such"
```

---

## Task 18: Pricing

**Files:**
- Create: `src/app/(marketing)/_content/pricing.ts`
- Create: `src/app/(marketing)/_components/Pricing.tsx`, `PricingTerms.tsx`, `PlanCard.tsx`
- Modify: `src/app/(marketing)/_content/parity.test.ts`, `src/app/(marketing)/[lang]/page.tsx`

**Interfaces:**
- Consumes: `listPlans()` from `@/server/subscription`, `TERMS`/`termTotal`/`monthlyEquivalent`, `formatEgp`

**`plans.priceMonthly` is a Postgres `numeric`, which Drizzle returns as a `string`.** Convert with `Number()` before any arithmetic.

Against today's three seeded plans this renders three cards at today's prices. Four tiers at 0/499/699/1099 arrive with the plans spec; nothing here hardcodes a price or assumes a count.

- [ ] **Step 1: Write the failing test**

In `parity.test.ts`, add `PRICING` to the imports and the `modules` object:

```ts
import { PRICING } from "./pricing";
```

```ts
  const modules = { CHROME, STORY, SURFACES, DEMO, FAQ, OUTCOMES, PRICING };
```

Add:

```ts
import { TERMS } from "../_lib/terms";

describe("pricing content", () => {
  it("labels every billing term in both languages", () => {
    for (const locale of ["ar", "en"] as const) {
      for (const term of TERMS) {
        expect(PRICING[locale].terms[term.key]).toBeTruthy();
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: FAIL — `Failed to load ./pricing`.

- [ ] **Step 3: Write the content**

Create `src/app/(marketing)/_content/pricing.ts`:

```ts
import type { PlanFeatures, PlanLimits } from "@/server/subscription";
import type { TermKey } from "../_lib/terms";
import type { Localized } from "./types";

export type PricingContent = {
  eyebrow: string;
  heading: string;
  note: string;
  terms: Record<TermKey, string>;
  save: string;
  perMonth: string;
  freePrice: string;
  cta: string;
  ctaFree: string;
  /** By plan key. Unknown keys fall back to plans.name — the plans spec owns the final key set. */
  planNames: Record<string, string>;
  limits: Record<keyof PlanLimits, string>;
  features: Record<keyof PlanFeatures, string>;
};

export const PRICING: Localized<PricingContent> = {
  ar: {
    eyebrow: "الأسعار",
    heading: "باقات بالجنيه المصري، من غير مفاجآت.",
    note: "أقل مدة اشتراك ثلاثة شهور. الأسعار معروضة شهريًا وبتتحاسب على المدة اللي تختارها.",
    terms: { quarterly: "ربع سنوي", halfYearly: "نصف سنوي", annual: "سنوي" },
    save: "وفّر",
    perMonth: "شهريًا",
    freePrice: "مجاني",
    cta: "ابدأ الآن",
    ctaFree: "ابدأ مجانًا",
    planNames: { basic: "الأساسية", pro: "الاحترافية", enterprise: "المؤسسات" },
    limits: {
      branches: "فرع",
      staff: "مستخدم",
      products: "منتج",
      whatsapp_numbers: "رقم واتساب",
      orders_per_month: "طلب شهريًا",
      messages_per_month: "رسالة شهريًا",
    },
    features: {
      whatsapp: "الطلب من واتساب",
      custom_domain: "نطاق خاص",
      custom_theme: "تخصيص الهوية",
      reservations: "الحجوزات",
      advanced_analytics: "تقارير متقدمة",
      online_ordering: "الطلب الأونلاين",
    },
  },
  en: {
    eyebrow: "Pricing",
    heading: "Plans in Egyptian pounds, with no surprises.",
    note: "Three-month minimum term. Prices are shown monthly and billed over the term you choose.",
    terms: { quarterly: "Quarterly", halfYearly: "Half-yearly", annual: "Annual" },
    save: "Save",
    perMonth: "per month",
    freePrice: "Free",
    cta: "Get started",
    ctaFree: "Start free",
    planNames: { basic: "Basic", pro: "Pro", enterprise: "Enterprise" },
    limits: {
      branches: "branches",
      staff: "staff",
      products: "products",
      whatsapp_numbers: "WhatsApp numbers",
      orders_per_month: "orders / month",
      messages_per_month: "messages / month",
    },
    features: {
      whatsapp: "WhatsApp ordering",
      custom_domain: "Custom domain",
      custom_theme: "Custom branding",
      reservations: "Reservations",
      advanced_analytics: "Advanced reporting",
      online_ordering: "Online ordering",
    },
  },
};
```

- [ ] **Step 4: Write the card**

Create `src/app/(marketing)/_components/PlanCard.tsx`:

```tsx
"use client";
import Link from "next/link";
import type { Plan } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { PRICING } from "../_content/pricing";
import { formatEgp } from "../_lib/format";
import { monthlyEquivalent, termTotal, type Term } from "../_lib/terms";

export function PlanCard({ plan, term, locale }: { plan: Plan; term: Term; locale: Locale }) {
  const t = PRICING[locale];
  const monthly = Number(plan.priceMonthly);
  const isFree = monthly === 0;
  const name = t.planNames[plan.key] ?? plan.name;

  const rows = [
    ...Object.entries(plan.limits).map(([k, v]) => `${v} ${t.limits[k as keyof typeof t.limits]}`),
    ...Object.entries(plan.features)
      .filter(([, on]) => on)
      .map(([k]) => t.features[k as keyof typeof t.features]),
  ];

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card/60 p-6">
      <h3 className="text-base font-bold tracking-[-0.01em]">{name}</h3>

      <p className="mt-4 text-3xl font-extrabold tracking-[-0.03em]">
        {isFree ? t.freePrice : formatEgp(monthlyEquivalent(monthly, term.months, term.discount), locale)}
      </p>
      {!isFree ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t.perMonth} · {formatEgp(termTotal(monthly, term.months, term.discount), locale)} / {t.terms[term.key]}
        </p>
      ) : null}

      <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
        {rows.map((row) => <li key={row}>{row}</li>)}
      </ul>

      <Link
        href="/register"
        className="mt-6 rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium hover:bg-muted"
      >
        {isFree ? t.ctaFree : t.cta}
      </Link>
    </div>
  );
}
```

- [ ] **Step 5: Write the term switcher**

Create `src/app/(marketing)/_components/PricingTerms.tsx`:

```tsx
"use client";
import { useState } from "react";
import type { Plan } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { PRICING } from "../_content/pricing";
import { TERMS, type TermKey } from "../_lib/terms";
import { PlanCard } from "./PlanCard";

export function PricingTerms({ plans, locale }: { plans: Plan[]; locale: Locale }) {
  const [key, setKey] = useState<TermKey>("quarterly");
  const t = PRICING[locale];
  const term = TERMS.find((x) => x.key === key) ?? TERMS[0];
  const pct = new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en", { style: "percent" });

  return (
    <>
      <div role="tablist" aria-label={t.eyebrow} className="mt-8 inline-flex flex-wrap gap-2 rounded-full border border-border p-1">
        {TERMS.map((option) => {
          const selected = option.key === key;
          return (
            <button
              key={option.key}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setKey(option.key)}
              className={selected
                ? "rounded-full bg-foreground px-4 py-1.5 text-sm text-background"
                : "rounded-full px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground"}
            >
              {t.terms[option.key]}
              {option.discount > 0 ? (
                <span className="ms-2 text-[11px] opacity-80">{t.save} {pct.format(option.discount)}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => <PlanCard key={plan.id} plan={plan} term={term} locale={locale} />)}
      </div>
    </>
  );
}
```

- [ ] **Step 6: Write the section**

Create `src/app/(marketing)/_components/Pricing.tsx`:

```tsx
import type { Plan } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { PRICING } from "../_content/pricing";
import { PricingTerms } from "./PricingTerms";

export function Pricing({ plans, locale }: { plans: Plan[]; locale: Locale }) {
  const t = PRICING[locale];

  return (
    <section id="pricing" className="mx-auto max-w-6xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>
      <p className="mt-4 max-w-xl text-sm leading-7 text-muted-foreground">{t.note}</p>
      <PricingTerms plans={plans} locale={locale} />
    </section>
  );
}
```

- [ ] **Step 7: Load the plans in the page**

In `src/app/(marketing)/[lang]/page.tsx`, add the import and the query, then mount after `<Outcomes />`:

```tsx
import { listPlans } from "@/server/subscription";
```

```tsx
  const plans = await listPlans();
```

```tsx
          <Pricing plans={plans} locale={locale} />
```

- [ ] **Step 8: Verify**

Run: `npx vitest run "src/app/(marketing)"` — expect PASS.
Visit `/#pricing` with the dev server. Cards render from the database; switching term changes both the monthly figure and the term total, and Arabic shows Arabic-Indic digits.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): pricing section priced from the plans table"
```

---

## Task 19: FAQ, closing CTA and motion

**Files:**
- Create: `src/app/(marketing)/_components/Faq.tsx`, `ClosingCta.tsx`, `MotionReveal.tsx`
- Modify: `src/app/(marketing)/[lang]/page.tsx`

- [ ] **Step 1: Write the FAQ**

Create `src/app/(marketing)/_components/Faq.tsx`:

```tsx
import type { Locale } from "@/shared/errors";
import { FAQ } from "../_content/faq";

export function Faq({ locale }: { locale: Locale }) {
  const t = FAQ[locale];

  return (
    <section id="faq" className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <dl className="mt-10 divide-y divide-border/60">
        {t.items.map((item) => (
          <div key={item.q} className="py-5">
            <dt className="text-base font-bold tracking-[-0.01em]">{item.q}</dt>
            <dd className="mt-2 text-sm leading-7 text-muted-foreground">{item.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
```

- [ ] **Step 2: Write the closing CTA**

Create `src/app/(marketing)/_components/ClosingCta.tsx`:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/shared/errors";
import { CHROME } from "../_content/chrome";

const COPY = {
  ar: { heading: "ابدأ النهارده. الباقة المجانية من غير بطاقة.", sub: "دقيقة واحدة، وأول طلب يقدر يوصلك." },
  en: { heading: "Start today. The free plan needs no card.", sub: "One minute, and your first order can arrive." },
} as const;

export function ClosingCta({ locale }: { locale: Locale }) {
  const t = COPY[locale];

  return (
    <section className="mx-auto max-w-6xl px-6 py-24 text-center">
      <h2 className="mx-auto max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>
      <p className="mt-4 text-sm text-muted-foreground">{t.sub}</p>
      <div className="mt-8">
        <Button asChild size="lg"><Link href="/register">{CHROME[locale].getStarted}</Link></Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Write the motion wrapper**

Create `src/app/(marketing)/_components/MotionReveal.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A 12px fade-rise on entry. Honours prefers-reduced-motion by rendering the
 * revealed state immediately and never observing.
 */
export function MotionReveal({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="transition-all duration-500 motion-reduce:transition-none"
      style={{ opacity: shown ? 1 : 0, transform: shown ? "none" : "translateY(12px)" }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Mount everything and wrap the sections**

Final `<main>` order in `page.tsx` — `Hero`, `TradeBand`, then each remaining section wrapped in `MotionReveal`:

```tsx
        <main>
          <Hero />
          <TradeBand />
          <MotionReveal><Story locale={locale} /></MotionReveal>
          <MotionReveal><SurfaceTour /></MotionReveal>
          <PhotoBand />
          <MotionReveal><FeatureGrid /></MotionReveal>
          <MotionReveal><Steps /></MotionReveal>
          <DemoBand locale={locale} />
          <MotionReveal><Outcomes locale={locale} /></MotionReveal>
          <MotionReveal><Pricing plans={plans} locale={locale} /></MotionReveal>
          <MotionReveal><Faq locale={locale} /></MotionReveal>
          <PhotoBand />
          <ClosingCta locale={locale} />
        </main>
```

The hero and trade band are never wrapped — above-the-fold content must not depend on JavaScript to become visible.

- [ ] **Step 5: Verify**

Visit `/` and scroll: sections rise into place once. Enable "Reduce motion" in macOS System Settings, reload, and confirm everything is visible immediately with no transition.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): FAQ, closing CTA and reduced-motion-safe reveals"
```

---

## Task 20: Screenshot capture pipeline

**Files:**
- Create: `scripts/capture-marketing-shots.ts`
- Modify: `package.json` (add the script), `src/app/(marketing)/_lib/shots.test.ts` (un-skip)

**PRECONDITION — this task requires the demo-tenants spec to have landed.** The capture logs into `demo-<trade>` tenants that do not exist yet. Tasks 1–19 and 21 can be completed without it; this one cannot. If the demo tenants are not available, stop here, complete Task 21, and return to this task afterwards.

- [ ] **Step 1: Write the capture script**

Create `scripts/capture-marketing-shots.ts`:

```ts
import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { SHOT_MATRIX, shotPath, type Shot } from "../src/app/(marketing)/_lib/shots";

/**
 * Captures the marketing page's app screenshots from the demo tenants.
 *
 *   npx tsx scripts/capture-marketing-shots.ts --base-url http://localhost:3000
 *
 * Re-run whenever a captured surface changes. Output is committed: the page
 * references these paths and a test asserts every one of them exists.
 */
const args = process.argv.slice(2);
const baseUrl = args[args.indexOf("--base-url") + 1] ?? "http://localhost:3000";
const email = process.env.DEMO_USER_EMAIL ?? "demo@serveos.com";
const password = process.env.DEMO_USER_PASSWORD ?? "demo1234";

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

/** Where each surface lives, and what proves it has finished rendering. */
const SURFACE_ROUTE: Record<Shot["surface"], { path: (slug: string) => string; settled: string; auth: boolean }> = {
  storefront: { path: (slug) => `/?tenant=${slug}`, settled: "[data-testid='storefront']", auth: false },
  dashboard: { path: () => "/dashboard", settled: "main", auth: true },
  pos: { path: () => "/dashboard/pos", settled: "main", auth: true },
};

async function signIn(page: Page, slug: string) {
  await page.goto(`${baseUrl}/login`);
  await page.getByPlaceholder("e.g. roma").fill(slug);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/dashboard/);
}

async function main() {
  const browser = await chromium.launch();

  for (const shot of SHOT_MATRIX) {
    const slug = `demo-${shot.trade}`;
    const route = SURFACE_ROUTE[shot.surface];
    const context = await browser.newContext({
      viewport: VIEWPORTS[shot.viewport],
      locale: shot.locale === "ar" ? "ar-EG" : "en-US",
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    if (route.auth) await signIn(page, slug);
    await page.goto(`${baseUrl}${route.path(slug)}`);
    await page.waitForSelector(route.settled, { timeout: 30_000 });
    await page.waitForLoadState("networkidle");

    const out = path.join(process.cwd(), "public", shotPath(shot.trade, shot.surface, shot.locale, shot.viewport));
    await mkdir(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, type: "png" });
    console.log(`captured ${path.relative(process.cwd(), out)}`);

    await context.close();
  }

  // A dated manifest beside the captures. The existence test catches a deleted
  // file; nothing catches a stale one, so record when these were taken.
  const manifest = {
    capturedAt: new Date().toISOString(),
    baseUrl,
    shots: SHOT_MATRIX.map((s) => shotPath(s.trade, s.surface, s.locale, s.viewport)),
  };
  await writeFile(
    path.join(process.cwd(), "public", "marketing", "shots", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  await browser.close();
  console.log(`\n${SHOT_MATRIX.length} shots captured ✓`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`:

```json
    "marketing:shots": "tsx scripts/capture-marketing-shots.ts",
```

- [ ] **Step 3: Run the capture**

```bash
npm run dev          # in one terminal
npm run marketing:shots
```

Expected: 24 lines of `captured public/marketing/shots/…` and a final `24 shots captured ✓`.

- [ ] **Step 4: Enable the existence test**

In `src/app/(marketing)/_lib/shots.test.ts`, change `it.skip("every shot in the matrix exists on disk"` to `it("every shot in the matrix exists on disk"` and delete the two-line comment above it.

- [ ] **Step 5: Run the test**

Run: `npx vitest run "src/app/(marketing)/_lib/shots.test.ts"`
Expected: PASS — 8 tests, none skipped.

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-marketing-shots.ts package.json "src/app/(marketing)/_lib/shots.test.ts" public/marketing/shots
git commit -m "feat(marketing): capture app screenshots from the demo tenants"
```

---

## Task 21: E2E suite and removal of the old marketing tree

**Files:**
- Modify: `tests/e2e/marketing.spec.ts` (rewrite), `src/app/page.tsx`
- Delete: `src/app/_components/marketing/`

The old suite asserts English-by-default and a localStorage toggle, both of which are gone by design. It is replaced, not patched.

- [ ] **Step 1: Rewrite the E2E suite**

Replace `tests/e2e/marketing.spec.ts` entirely:

```ts
import { test, expect } from "@playwright/test";

// Requires: `npm run db:seed` (plans seeded, so the pricing section has rows).

test("the homepage is Arabic and right-to-left in the served HTML", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("أنشئ موقعك في دقيقة واحدة.");
});

test("Arabic ships without JavaScript, which is what proves there is no flash", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("أنشئ موقعك في دقيقة واحدة.");
  await context.close();
});

test("/en serves English left-to-right", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Create your own in 1 minute.");
});

test("/ar redirects to the canonical root", async ({ page }) => {
  await page.goto("/ar");
  await expect(page).toHaveURL(/\/$/);
});

test("switching trade re-copies the hero and the docket", async ({ page }) => {
  await page.goto("/en");
  await expect(page.getByRole("tab", { name: "Restaurant" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No restaurant website?");
  await expect(page.getByTestId("ticket")).toContainText("Table 4");

  await page.getByRole("tab", { name: "Timber", exact: true }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText("No timber yard website?");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Create your own in 1 minute.");
  await expect(page.getByTestId("ticket")).toContainText("Oak plank");
});

test("the docket keeps one height across every trade", async ({ page }) => {
  await page.goto("/en");
  const ticket = page.getByTestId("ticket");

  const heights: number[] = [];
  for (const trade of ["Restaurant", "Retail", "Pharmacy", "Timber"]) {
    await page.getByRole("tab", { name: trade, exact: true }).click();
    await expect(ticket).toBeVisible();
    const box = await ticket.boundingBox();
    heights.push(Math.round(box!.height));
  }

  expect(new Set(heights).size).toBe(1);
});

test("features the product does not ship yet are marked, not sold", async ({ page }) => {
  await page.goto("/en");
  await page.getByRole("tab", { name: "Pharmacy", exact: true }).click();
  const batch = page.locator("h3").filter({ hasText: /Batch & Expiry/ }).first();
  await expect(batch).toContainText("Soon");
});

test("the demo band offers two doors for every trade", async ({ page }) => {
  await page.goto("/en");
  const demo = page.locator("#demo");
  await expect(demo.getByRole("link", { name: "Open the storefront" })).toHaveCount(4);
  await expect(demo.getByRole("link", { name: "Open the dashboard" })).toHaveCount(4);
  await expect(demo.getByRole("link", { name: "Open the dashboard" }).first())
    .toHaveAttribute("href", "/api/demo/login?trade=restaurant");
});

test("pricing renders plans and the term switcher changes the figure", async ({ page }) => {
  await page.goto("/en");
  const pricing = page.locator("#pricing");
  await expect(pricing.getByRole("tab", { name: /Quarterly/ })).toHaveAttribute("aria-selected", "true");

  const firstPaid = pricing.locator("h3").filter({ hasText: /Pro/ }).first();
  await expect(firstPaid).toBeVisible();

  const before = await pricing.innerText();
  await pricing.getByRole("tab", { name: /Annual/ }).click();
  await expect(pricing.getByRole("tab", { name: /Annual/ })).toHaveAttribute("aria-selected", "true");
  expect(await pricing.innerText()).not.toBe(before);
});

test("outcomes are labelled as illustrative rather than attributed", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("#outcomes")).toContainText("Illustrative");
});

test("the footer carries every navigation column", async ({ page }) => {
  await page.goto("/en");
  const footer = page.locator("footer");
  for (const heading of ["Platform", "Trades", "Pricing", "Company"]) {
    await expect(footer.getByRole("navigation", { name: heading })).toBeVisible();
  }
  await expect(footer).toContainText("Priced in EGP");
});
```

- [ ] **Step 2: Run the E2E suite**

Run: `npm run db:seed && npm run test:e2e -- marketing.spec.ts`
Expected: PASS — 11 tests.

- [ ] **Step 3: Strip marketing out of the storefront entry**

In `src/app/page.tsx`, delete these eight imports:

```tsx
import { MarketingHeader } from "./_components/marketing/Header";
import { MarketingHero } from "./_components/marketing/Hero";
import { MarketingFeatures } from "./_components/marketing/Features";
import { MarketingHowItWorks } from "./_components/marketing/HowItWorks";
import { MarketingCtaBand } from "./_components/marketing/CtaBand";
import { MarketingFooter } from "./_components/marketing/Footer";
import { LangProvider } from "./_components/marketing/LangProvider";
import { VerticalProvider } from "./_components/marketing/VerticalProvider";
```

Then delete the marketing branch at the end of the component — the block that renders `<LangProvider><VerticalProvider>…`. The proxy rewrites `/` to `/ar` on marketing hosts, so this branch is unreachable. Replace it with:

```tsx
  // Marketing lives at src/app/(marketing)/[lang]; the proxy rewrites the
  // marketing host's "/" to "/ar", so this route only ever serves storefronts.
  notFound();
```

Add `import { notFound } from "next/navigation";` if it is not already imported.

- [ ] **Step 4: Delete the old tree**

```bash
git rm -r src/app/_components/marketing
```

- [ ] **Step 5: Verify nothing referenced it**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. If anything still imports from `_components/marketing`, it is a leftover — fix the import to the new location rather than restoring the file.

Run: `npx vitest run`
Expected: full suite PASS.

Run: `npm run test:e2e`
Expected: full E2E PASS. `responsive.spec.ts` and `storefront-responsive.spec.ts` also touch `/` — if either asserts on old marketing copy, update it to the new sections.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(marketing): replace the old landing page with the new marketing surface"
```

---

## Done

The marketing surface is Arabic-first, screenshot-led, priced from the database, and routed by URL rather than by client state. Two follow-on specs remain: plans and billing terms, and the demo tenants that Task 20 and the demo band depend on.


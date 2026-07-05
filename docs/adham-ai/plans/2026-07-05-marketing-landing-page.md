# Marketing Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ailab:subagent-driven-development (recommended) or ailab:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder marketing homepage with a branded landing page (animated dark hero, 6-feature grid, how-it-works, closing CTA, footer) using the ServeOS brand foundation (tokens, fonts, `LogoMark`/`Wordmark`) and copy that leads with online menu + ordering.

**Architecture:** Six new presentational components under `src/app/_components/marketing/` (Header, Hero, Features, HowItWorks, CtaBand, Footer) plus one shared icon-sprite component (`src/components/brand/FeatureIcon.tsx`). `src/app/page.tsx`'s marketing (`else`) branch becomes a thin composition of these components. No new dependencies, no new design tokens — everything reuses `src/app/globals.css`'s existing brand variables and `src/app/fonts.ts`'s font variables, both already on `main`.

**Tech Stack:** Next.js 16.2.9 (App Router, React 19), Tailwind CSS v4, lucide-react, existing shadcn `Button` (`src/components/ui/button.tsx`).

**Spec:** `docs/adham-ai/specs/2026-07-05-marketing-landing-page-design.md` (authoritative for all copy and visual values).

## Global Constraints

- **Presentational only.** Do not modify anything under `src/server/`, `src/db/`, `src/proxy.ts`, `src/middleware-routing.ts`, or the `surface === "storefront"` branch of `src/app/page.tsx`. Only the marketing (`else`) branch of that file changes.
- **No new routes, no new dependencies.** Nav only links to what exists: `#features`, `#how-it-works` (in-page anchors), `/login`, `/register`.
- **No fabricated stats.** Do not use venue counts or trial-length claims. Trust line is exactly: "No hardware lock-in" · "English, Spanish, Arabic".
- **Reuse brand foundation as-is** (already on `main`): `LogoMark` / `Wordmark` from `@/components/brand/*`; CSS variables `--primary` (`#f0522b`), `--background` (`#fbf7f2`), `--foreground`/`--ink`, `--card`, `--accent` (`#fbe3da`, coral-soft); Tailwind utilities `font-display`, `font-sans`, `font-mono`, `eyebrow`.
- **Hero-only decorative colors** (not tokenized, used via Tailwind arbitrary values): bright coral `#FF7A54`/`#FFB496`, bright teal `#2DD4C4`/`#5EEBDD`, dark canvas `#17100B`, cream `#FBF1EC`/`#FFF8F4`. Teal feature-card tile: icon `#0FB5A6` on tile `#DBF3F0`.
- **All hero animations must respect reduced motion** via Tailwind's `motion-safe:` variant (renders static, no separate media query needed) — never a bare `animate-*`/`animate-[...]` class on a decorative element.
- **Verification commands:** `npx tsc --noEmit` after every task; `npx next build` (mandatory per `AGENTS.md` — this is a non-standard Next.js build) and `npx playwright test tests/e2e/marketing.spec.ts` in the final task.
- All work happens directly on `main` (project convention: direct commits, conventional-commit messages).

## File Structure

```text
src/app/globals.css                                (mod)  hero keyframes appended
src/components/brand/FeatureIcon.tsx               (new)  6 icon <symbol> defs + <use> wrapper
src/app/_components/marketing/Header.tsx           (new)  logo + anchor nav + auth links
src/app/_components/marketing/Hero.tsx             (new)  animated dark hero
src/app/_components/marketing/Features.tsx         (new)  6-card feature grid
src/app/_components/marketing/HowItWorks.tsx       (new)  3-step explainer
src/app/_components/marketing/CtaBand.tsx          (new)  closing CTA band
src/app/_components/marketing/Footer.tsx           (new)  logo + copyright
src/app/page.tsx                                   (mod)  marketing branch composes the above
tests/e2e/marketing.spec.ts                        (new)  homepage smoke test
```

---

### Task 1: Feature icon sprite + Header

**Files:**
- Create: `src/components/brand/FeatureIcon.tsx`, `src/app/_components/marketing/Header.tsx`

**Interfaces:**
- Consumes: `LogoMark`, `Wordmark` from `@/components/brand/*` (existing); `Button` from `@/components/ui/button` (existing).
- Produces (later tasks rely on these exact names):
  - `type FeatureIconId = "ic-qr" | "ic-pos" | "ic-chat" | "ic-table" | "ic-inventory" | "ic-analytics"` from `@/components/brand/FeatureIcon`
  - `FeatureIconSprite()` — renders the hidden `<defs>` once per page
  - `FeatureIcon({ id, className }: { id: FeatureIconId; className?: string })` — renders one icon via `<use>`
  - `MarketingHeader()` from `@/app/_components/marketing/Header` (default export not used — named export)

- [ ] **Step 1: Create `src/components/brand/FeatureIcon.tsx`**

```tsx
export type FeatureIconId =
  | "ic-qr"
  | "ic-pos"
  | "ic-chat"
  | "ic-table"
  | "ic-inventory"
  | "ic-analytics";

export function FeatureIconSprite() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        <symbol id="ic-qr" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x={3} y={3} width={7} height={7} rx={1.6} />
            <rect x={14} y={3} width={7} height={7} rx={1.6} />
            <rect x={3} y={14} width={7} height={7} rx={1.6} />
          </g>
          <g fill="currentColor">
            <rect x={15} y={15} width={2.6} height={2.6} rx={0.7} />
            <rect x={18.4} y={18.4} width={2.6} height={2.6} rx={0.7} />
            <rect x={15} y={19} width={2.6} height={2} rx={0.7} />
            <rect x={19} y={15} width={2} height={2.6} rx={0.7} />
          </g>
        </symbol>

        <symbol id="ic-pos" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x={5} y={2.5} width={14} height={19} rx={2.6} />
            <rect x={8} y={5.5} width={8} height={4.5} rx={1} />
          </g>
          <g fill="currentColor">
            <circle cx={9.4} cy={14.2} r={1.15} />
            <circle cx={14.6} cy={14.2} r={1.15} />
            <circle cx={9.4} cy={18} r={1.15} />
            <circle cx={14.6} cy={18} r={1.15} />
          </g>
        </symbol>

        <symbol id="ic-chat" viewBox="0 0 24 24">
          <path
            d="M7 4 h10 a4 4 0 0 1 4 4 v4 a4 4 0 0 1 -4 4 h-6 l-4.5 3.4 v-3.4 a4 4 0 0 1 -3.5 -4 v-4 a4 4 0 0 1 4 -4 z"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <g fill="currentColor">
            <circle cx={8.6} cy={10} r={1.15} />
            <circle cx={12} cy={10} r={1.15} />
            <circle cx={15.4} cy={10} r={1.15} />
          </g>
        </symbol>

        <symbol id="ic-table" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx={12} cy={12} r={5.5} />
            <rect x={9} y={1.6} width={6} height={2.6} rx={1.3} />
            <rect x={9} y={19.8} width={6} height={2.6} rx={1.3} />
            <rect x={1.6} y={9} width={2.6} height={6} rx={1.3} />
            <rect x={19.8} y={9} width={2.6} height={6} rx={1.3} />
          </g>
        </symbol>

        <symbol id="ic-inventory" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x={4} y={6} width={16} height={14} rx={2.2} />
            <path d="M4 11 H20" />
            <path d="M12 6 V11" />
            <path d="M9.5 15 H14.5" />
          </g>
        </symbol>

        <symbol id="ic-analytics" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 3.5 V20 H20.5" />
            <path d="M7.5 15 L11 11 L14 13.5 L19.5 7" />
          </g>
          <circle cx={19.5} cy={7} r={1.7} fill="currentColor" />
        </symbol>
      </defs>
    </svg>
  );
}

export function FeatureIcon({ id, className }: { id: FeatureIconId; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      <use href={`#${id}`} />
    </svg>
  );
}
```

- [ ] **Step 2: Create `src/app/_components/marketing/Header.tsx`**

```tsx
import Link from "next/link";
import { LogoMark } from "@/components/brand/LogoMark";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-sidebar-border bg-sidebar/85 text-sidebar-foreground backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="#hero" className="flex items-center gap-2">
          <LogoMark className="size-7 text-primary" />
          <Wordmark className="text-lg" />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-8 text-sm font-medium text-sidebar-foreground/70 md:flex">
          <a href="#features" className="hover:text-sidebar-foreground">Features</a>
          <a href="#how-it-works" className="hover:text-sidebar-foreground">How it works</a>
        </nav>

        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="hidden text-sm font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground md:inline"
          >
            Sign in
          </Link>
          <Button asChild size="sm">
            <Link href="/register">Get Started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/brand/FeatureIcon.tsx src/app/_components/marketing/Header.tsx
git commit -m "feat(marketing): feature icon sprite and branded header"
```

---

### Task 2: Animated hero

**Files:**
- Modify: `src/app/globals.css`
- Create: `src/app/_components/marketing/Hero.tsx`

**Interfaces:**
- Consumes: `LogoMark` from `@/components/brand/LogoMark`; `Button` from `@/components/ui/button`; `ArrowRight` from `lucide-react` (existing dependency, already used in the dashboard).
- Produces: `MarketingHero()` from `@/app/_components/marketing/Hero`.

- [ ] **Step 1: Append hero keyframes to `src/app/globals.css`**

Add this block at the end of the file, after the existing `@utility eyebrow { ... }` block:

```css
/* Marketing hero decorative animations (motion-safe only — see MarketingHero.tsx) */
@keyframes drift1 {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(60px, -40px) scale(1.08); }
}
@keyframes drift2 {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(-50px, 50px) scale(1.1); }
}
@keyframes drift3 {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(30px, 40px) scale(1.06); }
}
@keyframes dash {
  to { stroke-dashoffset: -400; }
}
@keyframes pulse-node {
  0%, 100% { opacity: 0.35; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.5); }
}
@keyframes floaty {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-14px); }
}
```

> Named `pulse-node`, not `pulse` — Tailwind's built-in `animate-pulse` (used by the dashboard's `Skeleton` component) already defines a `pulse` keyframe; redefining it here would silently change skeleton loaders elsewhere in the app.

- [ ] **Step 2: Create `src/app/_components/marketing/Hero.tsx`**

```tsx
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/LogoMark";

export function MarketingHero() {
  return (
    <section
      id="hero"
      className="relative overflow-hidden bg-[#17100B] px-6 py-28 text-[#FBF1EC] sm:py-36"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-56 size-[75rem] rounded-full bg-[radial-gradient(circle_at_center,#FF5E34_0%,rgba(240,82,43,0.55)_34%,rgba(240,82,43,0)_66%)] motion-safe:animate-[drift1_22s_ease-in-out_infinite]" />
        <div className="absolute -bottom-64 -right-36 size-[72rem] rounded-full bg-[radial-gradient(circle_at_center,#F0522B_0%,rgba(210,63,28,0.5)_36%,rgba(210,63,28,0)_68%)] motion-safe:animate-[drift2_26s_ease-in-out_infinite]" />
        <div className="absolute right-[6%] top-[44%] size-[40rem] rounded-full bg-[radial-gradient(circle_at_center,rgba(45,212,196,0.5)_0%,rgba(15,181,166,0)_62%)] motion-safe:animate-[drift3_20s_ease-in-out_infinite]" />
        <div className="absolute -bottom-32 left-[8%] h-[32rem] w-[47rem] rounded-full bg-[radial-gradient(circle_at_center,rgba(216,204,190,0.28)_0%,rgba(216,204,190,0)_60%)]" />

        <svg viewBox="0 0 1920 1080" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <g fill="none" stroke="#2DD4C4" strokeWidth={2} strokeLinecap="round" opacity={0.55}>
            <path d="M-40 210 C 320 120, 520 300, 860 220" strokeDasharray="7 16" className="motion-safe:animate-[dash_9s_linear_infinite]" />
            <path d="M1960 320 C 1600 250, 1420 430, 1120 330" strokeDasharray="6 18" className="motion-safe:animate-[dash_11s_linear_infinite]" />
            <path d="M1960 780 C 1560 700, 1440 900, 1080 820" strokeDasharray="7 16" className="motion-safe:animate-[dash_10s_linear_infinite]" />
            <path d="M-40 900 C 280 820, 500 980, 820 900" strokeDasharray="6 18" className="motion-safe:animate-[dash_13s_linear_infinite]" />
          </g>
          <g fill="#5EEBDD">
            <circle cx={860} cy={220} r={5} className="motion-safe:animate-[pulse-node_3.2s_ease-in-out_infinite]" />
            <circle cx={1120} cy={330} r={5} className="motion-safe:animate-[pulse-node_3.8s_ease-in-out_infinite_0.6s]" />
            <circle cx={1080} cy={820} r={5} className="motion-safe:animate-[pulse-node_3.4s_ease-in-out_infinite_1.1s]" />
            <circle cx={820} cy={900} r={5} className="motion-safe:animate-[pulse-node_4s_ease-in-out_infinite_0.3s]" />
          </g>
        </svg>

        <LogoMark className="absolute right-[8%] top-24 hidden size-40 text-[#FFB496]/15 lg:block motion-safe:animate-[floaty_9s_ease-in-out_infinite]" />
        <LogoMark className="absolute bottom-24 left-[7%] hidden size-32 text-[#5EEBDD]/15 lg:block motion-safe:animate-[floaty_11s_ease-in-out_infinite_1.2s]" />

        <div className="absolute inset-0 bg-[radial-gradient(ellipse_46%_54%_at_42%_52%,rgba(20,13,9,0.72)_0%,rgba(20,13,9,0.35)_45%,rgba(20,13,9,0)_78%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(20,13,9,0.4)_0%,rgba(20,13,9,0)_18%,rgba(20,13,9,0)_82%,rgba(20,13,9,0.35)_100%)]" />
      </div>

      <div className="relative mx-auto max-w-3xl">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#2DD4C4]/30 bg-[#2DD4C4]/10 px-4 py-1.5 font-mono text-xs uppercase tracking-[0.14em] text-[#5EEBDD]">
          <span className="size-1.5 rounded-full bg-[#5EEBDD] motion-safe:animate-pulse" />
          QR menu · WhatsApp · Web ordering
        </div>

        <h1 className="font-display text-[clamp(2.5rem,6vw,6rem)] font-extrabold leading-[0.98] tracking-tight text-[#FFF8F4]">
          Your menu, online. <span className="text-[#FF7A54]">Orders, everywhere.</span>
        </h1>

        <p className="mt-6 max-w-[40ch] text-lg text-[#FBF1EC]/90 sm:text-2xl">
          Customers order by scanning a table QR, messaging WhatsApp, or your own ordering page —
          no app to install. It all lands in one dashboard, synced with your POS and stock.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Button asChild size="lg" className="shadow-[0_20px_44px_-18px_rgba(240,82,43,0.9)]">
            <Link href="/register">
              Get Started <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="border-[#FBF1EC]/35 bg-transparent text-[#FBF1EC] hover:bg-white/5 hover:text-[#FBF1EC]"
          >
            <Link href="/login">Sign in</Link>
          </Button>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-2 text-sm text-[#FBF1EC]/70">
          <span className="text-[#5EEBDD]">●</span>
          <span>No hardware lock-in</span>
          <span aria-hidden="true">·</span>
          <span>English, Spanish, Arabic</span>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css src/app/_components/marketing/Hero.tsx
git commit -m "feat(marketing): animated dark hero with reduced-motion support"
```

---

### Task 3: Features, How it works, CTA band, Footer

**Files:**
- Create: `src/app/_components/marketing/Features.tsx`, `src/app/_components/marketing/HowItWorks.tsx`, `src/app/_components/marketing/CtaBand.tsx`, `src/app/_components/marketing/Footer.tsx`

**Interfaces:**
- Consumes: `FeatureIcon`, `FeatureIconSprite`, `type FeatureIconId` from Task 1; `LogoMark`, `Wordmark` from `@/components/brand/*`; `Button` from `@/components/ui/button`.
- Produces: `MarketingFeatures()`, `MarketingHowItWorks()`, `MarketingCtaBand()`, `MarketingFooter()`.

- [ ] **Step 1: Create `src/app/_components/marketing/Features.tsx`**

```tsx
import { FeatureIcon, FeatureIconSprite, type FeatureIconId } from "@/components/brand/FeatureIcon";

const FEATURES: {
  id: FeatureIconId;
  title: string;
  description: string;
  tone: "coral" | "teal";
}[] = [
  {
    id: "ic-qr",
    title: "QR Menu & Ordering",
    description: "Every table gets a menu customers can browse and order from in seconds.",
    tone: "coral",
  },
  {
    id: "ic-chat",
    title: "WhatsApp Ordering",
    description: "No app required — customers order straight from a chat they already have open.",
    tone: "coral",
  },
  {
    id: "ic-table",
    title: "Table Reservations",
    description: "Take bookings without a phone tied up all service.",
    tone: "coral",
  },
  {
    id: "ic-pos",
    title: "Point of Sale",
    description: "One system for online orders and in-house sales — nothing to reconcile by hand.",
    tone: "coral",
  },
  {
    id: "ic-inventory",
    title: "Inventory Control",
    description: "Stock updates as orders come in, so you know what's running low.",
    tone: "teal",
  },
  {
    id: "ic-analytics",
    title: "Live Analytics",
    description: "See what's selling, when, and where — as it happens.",
    tone: "teal",
  },
];

export function MarketingFeatures() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24">
      <FeatureIconSprite />

      <div className="mb-12 max-w-2xl">
        <p className="eyebrow text-primary">What you get</p>
        <h2 className="mt-2 font-display text-3xl font-bold text-ink sm:text-4xl">
          Everything your restaurant needs to take orders online.
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.id} className="rounded-xl border bg-card p-6">
            <div
              className={
                f.tone === "coral"
                  ? "mb-4 grid size-12 place-items-center rounded-lg bg-accent text-primary"
                  : "mb-4 grid size-12 place-items-center rounded-lg bg-[#DBF3F0] text-[#0FB5A6]"
              }
            >
              <FeatureIcon id={f.id} className="size-6" />
            </div>
            <h3 className="font-display text-lg font-bold text-ink">{f.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{f.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Create `src/app/_components/marketing/HowItWorks.tsx`**

```tsx
const STEPS = [
  {
    n: "01",
    title: "Build your menu",
    description: "Categories, products, photos — in English and Arabic.",
  },
  {
    n: "02",
    title: "Customers order",
    description: "QR at the table, WhatsApp, or your ordering link.",
  },
  {
    n: "03",
    title: "It all lands in your dashboard",
    description: "Orders, POS, and stock update together.",
  },
];

export function MarketingHowItWorks() {
  return (
    <section id="how-it-works" className="border-t bg-secondary/40 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow text-primary">How it works</p>
        <h2 className="mt-2 font-display text-3xl font-bold text-ink sm:text-4xl">
          Live in three steps.
        </h2>

        <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n}>
              <div className="font-mono text-sm font-medium text-primary">{s.n}</div>
              <h3 className="mt-2 font-display text-lg font-bold text-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{s.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Create `src/app/_components/marketing/CtaBand.tsx`**

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function MarketingCtaBand() {
  return (
    <section className="bg-primary/5 px-6 py-20 text-center">
      <h2 className="font-display text-3xl font-bold text-ink sm:text-4xl">
        Get your menu online today.
      </h2>
      <Button asChild size="lg" className="mt-8">
        <Link href="/register">Get Started</Link>
      </Button>
    </section>
  );
}
```

- [ ] **Step 4: Create `src/app/_components/marketing/Footer.tsx`**

```tsx
import { LogoMark } from "@/components/brand/LogoMark";
import { Wordmark } from "@/components/brand/Wordmark";

export function MarketingFooter() {
  return (
    <footer className="border-t px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-2 text-ink">
          <LogoMark className="size-5 text-primary" />
          <Wordmark className="text-sm" />
        </div>
        <p className="text-sm text-muted-foreground">© 2026 ServeOS</p>
      </div>
    </footer>
  );
}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/_components/marketing/Features.tsx src/app/_components/marketing/HowItWorks.tsx src/app/_components/marketing/CtaBand.tsx src/app/_components/marketing/Footer.tsx
git commit -m "feat(marketing): features grid, how-it-works, closing CTA, footer"
```

---

### Task 4: Compose the homepage, e2e smoke test, final verification

**Files:**
- Modify: `src/app/page.tsx`
- Create: `tests/e2e/marketing.spec.ts`

**Interfaces:**
- Consumes: `MarketingHeader`, `MarketingHero`, `MarketingFeatures`, `MarketingHowItWorks`, `MarketingCtaBand`, `MarketingFooter` from Tasks 1–3.
- Produces: nothing consumed later.

- [ ] **Step 1: Replace the marketing branch of `src/app/page.tsx`**

The `if (surface === "storefront" && slug) { ... }` block (everything through its closing `}`) stays byte-for-byte unchanged. Only the trailing placeholder — from the file's final `return (` through the end of the component — changes.

Find this import block at the top of the file:

```tsx
import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches } from "@/server/branches/service";
import { hasFeature } from "@/server/entitlements/service";
import { BranchSelector } from "./_components/BranchSelector";
import { StorefrontMenu } from "./_components/StorefrontMenu";
```

Replace it with (adding six new imports, nothing removed):

```tsx
import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches } from "@/server/branches/service";
import { hasFeature } from "@/server/entitlements/service";
import { BranchSelector } from "./_components/BranchSelector";
import { StorefrontMenu } from "./_components/StorefrontMenu";
import { MarketingHeader } from "./_components/marketing/Header";
import { MarketingHero } from "./_components/marketing/Hero";
import { MarketingFeatures } from "./_components/marketing/Features";
import { MarketingHowItWorks } from "./_components/marketing/HowItWorks";
import { MarketingCtaBand } from "./_components/marketing/CtaBand";
import { MarketingFooter } from "./_components/marketing/Footer";
```

Find this trailing block (the marketing placeholder — everything from the final `return` to the end of the file):

```tsx
  return (
    <div style={{ fontFamily: "system-ui", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{ background: "#0f172a", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, background: "#f97316", borderRadius: 6 }} />
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 18 }}>ServeOS</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a href="/login" style={{ color: "#94a3b8", textDecoration: "none", fontSize: 14 }}>Sign in</a>
          <a href="/register" style={{ background: "#f97316", color: "#fff", padding: "8px 18px", borderRadius: 6, textDecoration: "none", fontSize: 14, fontWeight: 600 }}>Get started</a>
        </div>
      </nav>

      <section style={{ background: "#0f172a", padding: "80px 32px", textAlign: "center", flex: 1 }}>
        <h1 style={{ color: "#fff", fontSize: 40, fontWeight: 800, margin: 0, lineHeight: 1.15 }}>
          Run your restaurant.<br />Not your software.
        </h1>
        <p style={{ color: "#64748b", fontSize: 18, marginTop: 12 }}>
          Menu, orders, WhatsApp commerce — one platform.
        </p>
        <div style={{ marginTop: 32, display: "inline-flex", gap: 12 }}>
          <a href="/register" style={{ background: "#f97316", color: "#fff", padding: "12px 24px", borderRadius: 6, textDecoration: "none", fontSize: 15, fontWeight: 600 }}>Get started free</a>
          <a href="/login" style={{ border: "1px solid #334155", color: "#94a3b8", padding: "12px 24px", borderRadius: 6, textDecoration: "none", fontSize: 15 }}>Sign in →</a>
        </div>
      </section>

      <section style={{ background: "#fff", display: "grid", gridTemplateColumns: "repeat(3,1fr)", borderTop: "1px solid #f1f5f9" }}>
        {[
          { emoji: "🍽️", title: "Menu & Catalog", desc: "Products, categories, branches, and modifiers. Your full menu online." },
          { emoji: "📦", title: "Online Ordering", desc: "Cart, checkout, and real-time order tracking for your customers." },
          { emoji: "💬", title: "WhatsApp Commerce", desc: "Let customers order via WhatsApp chatbot — no app needed." },
        ].map((pillar, i) => (
          <div key={pillar.title} style={{ padding: "32px 24px", borderRight: i < 2 ? "1px solid #f1f5f9" : undefined }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>{pillar.emoji}</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a", marginBottom: 6 }}>{pillar.title}</div>
            <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>{pillar.desc}</div>
          </div>
        ))}
      </section>

      <footer style={{ background: "#0f172a", padding: "20px 32px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "#475569", fontSize: 13 }}>© 2026 ServeOS</span>
        <div style={{ display: "flex", gap: 16 }}>
          <a href="#" style={{ color: "#475569", fontSize: 13, textDecoration: "none" }}>Privacy</a>
          <a href="#" style={{ color: "#475569", fontSize: 13, textDecoration: "none" }}>Terms</a>
        </div>
      </footer>
    </div>
  );
}
```

Replace it with:

```tsx
  return (
    <div className="min-h-screen">
      <MarketingHeader />
      <MarketingHero />
      <MarketingFeatures />
      <MarketingHowItWorks />
      <MarketingCtaBand />
      <MarketingFooter />
    </div>
  );
}
```

- [ ] **Step 2: Create `tests/e2e/marketing.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("marketing homepage renders hero, features, and auth links", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your menu, online.");

  await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: "Get Started" }).first()).toHaveAttribute("href", "/register");

  await expect(
    page.getByRole("heading", { name: "Everything your restaurant needs to take orders online." }),
  ).toBeVisible();
  await expect(page.getByText("QR Menu & Ordering")).toBeVisible();
  await expect(page.getByText("Live Analytics")).toBeVisible();
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npx next build`
Expected: build succeeds (mandatory gate per `AGENTS.md` — this is a non-standard Next.js build).

- [ ] **Step 5: Run the e2e smoke test**

Run: `npx playwright test tests/e2e/marketing.spec.ts`
Expected: 1 passed.

- [ ] **Step 6: Manual visual pass**

Run `npm run dev`, open `http://localhost:3000` (bare host resolves to the marketing surface per `classifyHost` in `src/middleware-routing.ts`). Confirm:
- Dark animated hero with coral/teal glows, headline "Your menu, online. Orders, everywhere.", both CTAs working.
- Toggle OS-level "reduce motion" (macOS: System Settings → Accessibility → Display → Reduce motion) and reload — glows/lines/floating marks should be static, no motion.
- Resize to 375px wide — header collapses to logo + Get Started, feature grid goes to 1 column, hero headline scales down.
- Feature grid shows all 6 cards in order (QR Menu & Ordering, WhatsApp Ordering, Table Reservations, Point of Sale, Inventory Control, Live Analytics), last two tinted teal.

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx tests/e2e/marketing.spec.ts
git commit -m "feat(marketing): compose branded homepage from section components"
```

- [ ] **Step 8: Push**

```bash
git push origin main
```

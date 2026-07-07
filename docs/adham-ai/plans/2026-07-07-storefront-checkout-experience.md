# Storefront Checkout Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-credible customer transactional flow: branded checkout/cart/tracking, tenant-timezone open-state + scheduling with pre-orders, customer cancel of pending orders, currency everywhere, plus footer / recent-order strip / ETA display.

**Architecture:** Approach 1 from the spec (`docs/adham-ai/specs/2026-07-07-storefront-checkout-experience-design.md`): minimal extension of the existing ordering core — one nullable `orders.scheduled_for` column, a pure tz-correct slots module beside `orderability.ts`, one new public cancel endpoint keyed by the status token, and a UI pass built from the existing storefront component family. No quote API; totals stay client-computed for display, server-validated at submit.

**Tech Stack:** Next.js 16 (App Router, Server Components), Tailwind v4 tokens from `globals.css`, Radix via existing `src/components/ui/*`, Drizzle + Postgres (FORCE RLS via `withTenant`), Vitest (real test DB), Playwright.

## Global Constraints

- Read `node_modules/next/dist/docs/` before assuming any Next.js API behaves like training data (`AGENTS.md`). Run `npm install` first if `node_modules/` is missing.
- **No new npm dependencies.** All timezone math uses `Intl.DateTimeFormat` with the `timeZone` option.
- Every new server failure is a `DomainError` subclass (`src/shared/errors.ts`) with EN **and** AR `messageFor`, surfaced as HTTP 422 by API routes (pattern: `src/app/api/orders/route.ts:48-54`).
- Currency format is `Intl.NumberFormat("en", { style: "currency", currencyDisplay: "code", currency })` → `"EGP 120.00"`. **Note:** Intl separates code and amount with a non-breaking space (` `) — tests must assert `"EGP 120.00"`.
- Scheduling constants (exact values, exported from the slots module): `SLOT_STEP_MINUTES = 30`, `MIN_LEAD_MINUTES = 30`, horizon = today + tomorrow in the tenant's timezone.
- Customer cancel is allowed **only** from `pending` (the dashboard keeps its wider state-machine rights).
- This repo has **no `.test.tsx` files** — UI components are verified by `npx tsc --noEmit`, `npm run build`, Playwright, and a manual pass. Only server/pure logic gets Vitest tests.
- Migrations: `npm run db:generate` (never hand-written SQL), then `npm run db:migrate:test` (Vitest DB), then `npm run db:migrate` (production DB — additive nullable columns only, per repo convention).
- localStorage keys: `serveos.cart` (existing), `serveos.customer` (new, checkout prefill), `serveos.recent-orders` (new, tracking re-entry). All parse with try/catch-to-default.
- Client-side money/totals are display only; `placeOrder` remains the source of truth.
- Storefront visual language: tokens/fonts from `src/app/globals.css` + `src/app/fonts.ts` (`font-display`, `font-sans`, `eyebrow` utility, `--primary`, `--ink`, `bg-background`, `bg-card`, `text-muted-foreground`). No `animate-in`/`fade-in-0` classes (plugin not installed) — plain Tailwind `transition`/`translate` only.

---

### Task 1: Formatting helpers — `formatMoney` and `formatSlotLabel`

**Files:**
- Create: `src/lib/money.ts`
- Create: `src/lib/money.test.ts`
- Create: `src/lib/datetime.ts`
- Create: `src/lib/datetime.test.ts`

**Interfaces:**
- Produces: `formatMoney(amount: number, currency: string): string` — e.g. `formatMoney(120, "EGP")` → `"EGP 120.00"`. Used by Tasks 8, 9, 10.
- Produces: `formatSlotLabel(date: Date, timeZone: string): string` — e.g. `"Tue 18:30"`. Used by Tasks 9, 10, 11.
- Produces: `formatDayTime(date: Date, timeZone: string): string` — e.g. `"Tue 7 Jul, 18:30"` (used where a bare weekday is ambiguous: tracking + dashboard).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/money.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatMoney } from "./money";

describe("formatMoney", () => {
  it("formats EGP with code and two decimals", () => {
    expect(formatMoney(120, "EGP")).toBe("EGP 120.00");
  });
  it("formats SAR", () => {
    expect(formatMoney(45.5, "SAR")).toBe("SAR 45.50");
  });
  it("rounds to two decimals", () => {
    expect(formatMoney(10.005, "EGP")).toBe("EGP 10.01");
  });
});
```

Create `src/lib/datetime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatSlotLabel, formatDayTime } from "./datetime";

// 2026-07-07T16:30:00Z is 18:30 in Africa/Cairo (UTC+2, no DST in July 2026? —
// Egypt re-adopted DST 2023; July is DST, UTC+3 → 19:30. The test pins the
// exact expected output; if ICU data shifts, fix the expectation, not the fn.)
const d = new Date("2026-07-07T16:30:00Z");

describe("datetime helpers", () => {
  it("formatSlotLabel renders weekday + 24h time in the tenant tz", () => {
    expect(formatSlotLabel(d, "Africa/Cairo")).toMatch(/^Tue \d{2}:\d{2}$/);
    expect(formatSlotLabel(d, "Asia/Riyadh")).toBe("Tue 19:30");
  });
  it("formatDayTime includes the date", () => {
    expect(formatDayTime(d, "Asia/Riyadh")).toMatch(/Tue.*7.*Jul.*19:30/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/money.test.ts src/lib/datetime.test.ts`
Expected: FAIL — cannot resolve `./money` / `./datetime`.

- [ ] **Step 3: Implement**

Create `src/lib/money.ts`:

```ts
/** "EGP 120.00" (code + non-breaking space + amount). Display only — the
 * server recomputes all totals at order placement. */
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    currencyDisplay: "code",
  }).format(amount);
}
```

Create `src/lib/datetime.ts`:

```ts
/** "Tue 18:30" in the given IANA timezone. */
export function formatSlotLabel(date: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
  return `${weekday} ${time}`;
}

/** "Tue 7 Jul, 18:30" in the given IANA timezone. */
export function formatDayTime(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
  return `${day}, ${time}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/money.test.ts src/lib/datetime.test.ts`
Expected: PASS. If `formatSlotLabel` output differs (e.g. `"Tue, 18:30"`), adjust the implementation (not the test) to strip commas: the contract is exactly `"Tue 18:30"`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts src/lib/money.test.ts src/lib/datetime.ts src/lib/datetime.test.ts
git commit -m "feat(lib): formatMoney and tenant-timezone datetime helpers"
```

---

### Task 2: Opening-hours core + tz-correct slots module

**Files:**
- Modify: `src/server/branches/orderability.ts` (extract `withinOpeningHours`, keep `isBranchOrderable` delegating)
- Create: `src/server/branches/slots.ts`
- Create: `src/server/branches/slots.test.ts`

**Interfaces:**
- Consumes: `Branch`, `OpeningHours` from `src/server/branches/schema.ts`.
- Produces (all pure, no DB):
  - `withinOpeningHours(hours: OpeningHours, at: { day: number; minutes: number }): boolean` (exported from `orderability.ts`)
  - `toMinutes(hhmm: string): number` (exported from `orderability.ts`)
  - `wallClock(date: Date, timeZone: string): { day: number; minutes: number }`
  - `localDateKey(date: Date, timeZone: string): string` — `"2026-07-07"`
  - `isBranchOrderableAt(branch: Branch, timeZone: string, at: Date): boolean`
  - `isWithinSchedulingHorizon(timeZone: string, now: Date, at: Date): boolean`
  - `listSlots(branch: Branch, timeZone: string, now: Date): Date[]`
  - `getBranchOpenState(branch: Branch, timeZone: string, now: Date): { open: boolean; opensAt?: string; closesAt?: string }` — `opensAt`/`closesAt` are `"HH:MM"` strings straight from `DayHours` (already tenant-local wall-clock).
  - `SLOT_STEP_MINUTES = 30`, `MIN_LEAD_MINUTES = 30`
- Note: existing `isBranchOrderable(branch, now)` keeps its exact signature/behavior (its tests in `orderability.test.ts` stay green); `placeOrder` switches to `isBranchOrderableAt` in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `src/server/branches/slots.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Branch, OpeningHours } from "./schema";
import {
  wallClock, localDateKey, isBranchOrderableAt, isWithinSchedulingHorizon,
  listSlots, getBranchOpenState, SLOT_STEP_MINUTES, MIN_LEAD_MINUTES,
} from "./slots";

const CAIRO = "Africa/Cairo"; // UTC+3 in July (DST since 2023)
const RIYADH = "Asia/Riyadh"; // UTC+3, no DST

function branch(openingHours: OpeningHours, over: Partial<Branch> = {}): Branch {
  return {
    id: "b1", tenantId: "t1", name: "Main", address: null, phone: null,
    isActive: true, acceptingOrders: true, openingHours, sortOrder: 0,
    createdAt: new Date(), ...over,
  } as Branch;
}
// Tue 2026-07-07. 16:30Z = 19:30 Cairo/Riyadh.
const NOW = new Date("2026-07-07T16:30:00Z");
const ALL_WEEK_10_23: OpeningHours = Array.from({ length: 7 }, (_, day) => ({
  day, open: "10:00", close: "23:00", closed: false,
}));

describe("wallClock / localDateKey", () => {
  it("converts an instant to tenant wall-clock", () => {
    expect(wallClock(NOW, RIYADH)).toEqual({ day: 2, minutes: 19 * 60 + 30 });
  });
  it("rolls the weekday across midnight in the tenant tz", () => {
    // 22:30Z Tue = 01:30 Wed in Riyadh
    expect(wallClock(new Date("2026-07-07T22:30:00Z"), RIYADH)).toEqual({ day: 3, minutes: 90 });
  });
  it("localDateKey is the tenant-local date", () => {
    expect(localDateKey(new Date("2026-07-07T22:30:00Z"), RIYADH)).toBe("2026-07-08");
  });
});

describe("isBranchOrderableAt", () => {
  it("open inside window, closed outside, in tenant tz", () => {
    const b = branch(ALL_WEEK_10_23);
    expect(isBranchOrderableAt(b, RIYADH, NOW)).toBe(true); // 19:30 local
    expect(isBranchOrderableAt(b, RIYADH, new Date("2026-07-07T05:00:00Z"))).toBe(false); // 08:00 local
  });
  it("handles a window wrapping past midnight (yesterday's tail)", () => {
    const wrap: OpeningHours = [{ day: 2, open: "22:00", close: "02:00", closed: false }];
    // Wed 01:00 local = inside Tuesday's wrap tail
    expect(isBranchOrderableAt(branch(wrap), RIYADH, new Date("2026-07-07T22:00:00Z"))).toBe(true);
  });
  it("paused or inactive branch is never orderable", () => {
    expect(isBranchOrderableAt(branch(ALL_WEEK_10_23, { acceptingOrders: false }), RIYADH, NOW)).toBe(false);
    expect(isBranchOrderableAt(branch(ALL_WEEK_10_23, { isActive: false }), RIYADH, NOW)).toBe(false);
  });
  it("empty openingHours means always within hours", () => {
    expect(isBranchOrderableAt(branch([]), RIYADH, new Date("2026-07-07T02:00:00Z"))).toBe(true);
  });
});

describe("isWithinSchedulingHorizon", () => {
  it("today and tomorrow tenant-local are in, the day after is out", () => {
    expect(isWithinSchedulingHorizon(RIYADH, NOW, new Date("2026-07-07T19:00:00Z"))).toBe(true);
    expect(isWithinSchedulingHorizon(RIYADH, NOW, new Date("2026-07-08T18:00:00Z"))).toBe(true);
    expect(isWithinSchedulingHorizon(RIYADH, NOW, new Date("2026-07-09T10:00:00Z"))).toBe(false);
  });
});

describe("listSlots", () => {
  it("starts at the first 30-min boundary ≥ now + lead, inside opening hours", () => {
    const slots = listSlots(branch(ALL_WEEK_10_23), RIYADH, NOW); // 19:30 local
    // first candidate: 20:00 local (19:30 + 30min lead → ceil to 20:00)
    expect(slots[0].toISOString()).toBe("2026-07-07T17:00:00.000Z");
    expect(slots.every((s, i) => i === 0 || s.getTime() - slots[i - 1].getTime() >= SLOT_STEP_MINUTES * 60_000)).toBe(true);
  });
  it("skips closed hours and continues into tomorrow", () => {
    const slots = listSlots(branch(ALL_WEEK_10_23), RIYADH, NOW);
    const labels = slots.map((s) => localDateKey(s, RIYADH));
    expect(labels).toContain("2026-07-07");
    expect(labels).toContain("2026-07-08");
    expect(labels).not.toContain("2026-07-09");
    // no slot between 23:00 and 10:00 local
    const local = slots.map((s) => wallClock(s, RIYADH).minutes);
    expect(local.every((m) => m >= 10 * 60 && m < 23 * 60)).toBe(true);
  });
  it("returns [] for a paused branch", () => {
    expect(listSlots(branch(ALL_WEEK_10_23, { acceptingOrders: false }), RIYADH, NOW)).toEqual([]);
  });
  it("uses MIN_LEAD_MINUTES", () => {
    expect(MIN_LEAD_MINUTES).toBe(30);
  });
});

describe("getBranchOpenState", () => {
  it("open now → closesAt of the current window", () => {
    expect(getBranchOpenState(branch(ALL_WEEK_10_23), RIYADH, NOW)).toEqual({ open: true, closesAt: "23:00" });
  });
  it("closed now → opensAt of the next window", () => {
    const morning = new Date("2026-07-07T05:00:00Z"); // 08:00 local
    expect(getBranchOpenState(branch(ALL_WEEK_10_23), RIYADH, morning)).toEqual({ open: false, opensAt: "10:00" });
  });
  it("closed today entirely → opensAt from the next open day", () => {
    const hours: OpeningHours = ALL_WEEK_10_23.map((h) => (h.day === 2 ? { ...h, closed: true } : h));
    expect(getBranchOpenState(branch(hours), RIYADH, NOW)).toEqual({ open: false, opensAt: "10:00" });
  });
  it("no schedule → open, no times", () => {
    expect(getBranchOpenState(branch([]), RIYADH, NOW)).toEqual({ open: true });
  });
  it("Cairo DST is honoured", () => {
    // 07:30Z = 10:30 Cairo (UTC+3 with DST) → inside the 10:00 window
    expect(getBranchOpenState(branch(ALL_WEEK_10_23), CAIRO, new Date("2026-07-07T07:30:00Z")).open).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/branches/slots.test.ts`
Expected: FAIL — cannot resolve `./slots`.

- [ ] **Step 3: Extract `withinOpeningHours` in `orderability.ts`**

Replace the full contents of `src/server/branches/orderability.ts`:

```ts
import type { Branch, OpeningHours } from "./schema";

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Whether a wall-clock moment (day 0=Sun…6=Sat, minutes since midnight)
 * falls inside the opening hours. Empty hours → always open. Handles windows
 * wrapping past midnight, including yesterday's early-morning tail. */
export function withinOpeningHours(hours: OpeningHours, at: { day: number; minutes: number }): boolean {
  if (hours.length === 0) return true;
  const cur = at.minutes;

  const today = hours.find((h) => h.day === at.day);
  if (today && !today.closed) {
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);
    if (open === close) return true; // 24h
    if (close > open) {
      if (cur >= open && cur < close) return true; // same-day window
    } else if (cur >= open || cur < close) {
      return true; // wraps past midnight
    }
  }

  // The early-morning tail of *yesterday's* wrap window. E.g. a Friday 22:00–02:00
  // window keeps the branch open until Saturday 02:00 even if Saturday itself is
  // marked closed — the tail belongs to Friday, not Saturday.
  const yesterday = hours.find((h) => h.day === (at.day + 6) % 7);
  if (yesterday && !yesterday.closed) {
    const yOpen = toMinutes(yesterday.open);
    const yClose = toMinutes(yesterday.close);
    if (yClose < yOpen && cur < yClose) return true;
  }

  return false;
}

/**
 * Whether a branch can take an order at `now`, using server-local wall-clock.
 * Prefer `isBranchOrderableAt` (slots.ts) which is tenant-timezone-correct;
 * this remains for callers that already normalised `now`.
 */
export function isBranchOrderable(branch: Branch, now: Date): boolean {
  if (!branch.isActive) return false;
  if (!branch.acceptingOrders) return false;
  return withinOpeningHours(branch.openingHours ?? [], {
    day: now.getDay(),
    minutes: now.getHours() * 60 + now.getMinutes(),
  });
}
```

- [ ] **Step 4: Write `slots.ts`**

Create `src/server/branches/slots.ts`:

```ts
import type { Branch } from "./schema";
import { toMinutes, withinOpeningHours } from "./orderability";

export const SLOT_STEP_MINUTES = 30;
export const MIN_LEAD_MINUTES = 30;

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock (weekday + minutes since midnight) of an instant in an IANA tz. */
export function wallClock(date: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24; // some ICU versions emit "24" at midnight
  return { day: DAY_INDEX[get("weekday")], minutes: hour * 60 + Number(get("minute")) };
}

/** "YYYY-MM-DD" of an instant in an IANA tz. */
export function localDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

/** Tenant-timezone-correct orderability at an arbitrary instant. */
export function isBranchOrderableAt(branch: Branch, timeZone: string, at: Date): boolean {
  if (!branch.isActive) return false;
  if (!branch.acceptingOrders) return false;
  return withinOpeningHours(branch.openingHours ?? [], wallClock(at, timeZone));
}

/** Scheduling horizon: `at` falls on today or tomorrow, tenant-local. */
export function isWithinSchedulingHorizon(timeZone: string, now: Date, at: Date): boolean {
  const key = localDateKey(at, timeZone);
  const today = localDateKey(now, timeZone);
  const tomorrow = localDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
  return key === today || key === tomorrow;
}

/** Orderable slot instants: SLOT_STEP-aligned, ≥ now + MIN_LEAD, within the
 * horizon, inside opening hours. Epoch-aligned 30-min steps land on :00/:30
 * local time for whole/half-hour UTC offsets (all target markets). */
export function listSlots(branch: Branch, timeZone: string, now: Date): Date[] {
  const step = SLOT_STEP_MINUTES * 60_000;
  const first = Math.ceil((now.getTime() + MIN_LEAD_MINUTES * 60_000) / step) * step;
  const slots: Date[] = [];
  for (let t = first; ; t += step) {
    const at = new Date(t);
    if (!isWithinSchedulingHorizon(timeZone, now, at)) break;
    if (isBranchOrderableAt(branch, timeZone, at)) slots.push(at);
  }
  return slots;
}

export type BranchOpenState = { open: boolean; opensAt?: string; closesAt?: string };

/** Open/closed by hours alone (callers check acceptingOrders/isActive for
 * "paused"). opensAt/closesAt are "HH:MM" from DayHours — already tenant-local. */
export function getBranchOpenState(branch: Branch, timeZone: string, now: Date): BranchOpenState {
  const hours = branch.openingHours ?? [];
  const wc = wallClock(now, timeZone);
  const open = withinOpeningHours(hours, wc);
  if (hours.length === 0) return { open };

  if (open) {
    const today = hours.find((h) => h.day === wc.day);
    if (today && !today.closed) {
      const o = toMinutes(today.open);
      const c = toMinutes(today.close);
      const inToday = o === c || (c > o ? wc.minutes >= o && wc.minutes < c : wc.minutes >= o);
      if (inToday) return { open, closesAt: today.close };
    }
    const yesterday = hours.find((h) => h.day === (wc.day + 6) % 7);
    if (yesterday && !yesterday.closed && toMinutes(yesterday.close) < toMinutes(yesterday.open)) {
      return { open, closesAt: yesterday.close }; // in yesterday's wrap tail
    }
    return { open };
  }

  for (let d = 0; d < 7; d++) {
    const h = hours.find((x) => x.day === (wc.day + d) % 7);
    if (!h || h.closed) continue;
    if (d === 0 && toMinutes(h.open) <= wc.minutes) continue; // today's window already passed
    return { open, opensAt: h.open };
  }
  return { open };
}
```

- [ ] **Step 5: Run the new and the existing orderability tests**

Run: `npx vitest run src/server/branches/slots.test.ts src/server/branches/orderability.test.ts src/server/branches/fulfillment.test.ts`
Expected: PASS — slots tests green, and the pre-existing orderability behavior unchanged by the extraction. (If `orderability.test.ts` doesn't exist under that exact name, run `npx vitest run src/server/branches/` instead.)

- [ ] **Step 6: Commit**

```bash
git add src/server/branches/orderability.ts src/server/branches/slots.ts src/server/branches/slots.test.ts
git commit -m "feat(branches): tenant-timezone slots module + open-state (fixes tz limitation)"
```

---

### Task 3: Order scheduling — schema column + `placeOrder` validation

**Files:**
- Modify: `src/server/ordering/schema.ts` (orders table)
- Modify: `src/server/ordering/errors.ts` (add `InvalidScheduleError`)
- Modify: `src/server/ordering/service.ts` (`PlaceOrderInput`, `placeOrder`)
- Modify: `src/app/api/orders/route.ts` (allowlist passthrough)
- Modify: `src/server/ordering/place-order.test.ts`
- Create: `drizzle/00XX_<auto-generated-name>.sql` (via `npm run db:generate`)

**Interfaces:**
- Consumes: `isBranchOrderableAt`, `isWithinSchedulingHorizon`, `MIN_LEAD_MINUTES` from `src/server/branches/slots.ts` (Task 2); `getTenantById` from `@/server/tenancy`.
- Produces: `Order["scheduledFor"]: Date | null`; `PlaceOrderInput.scheduledFor?: string` (ISO 8601); `InvalidScheduleError` with `detail: "unparseable" | "too_soon" | "too_far" | "closed_at_time"` and `code = "invalid_schedule"`. Consumed by Tasks 9, 10, 11.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("placeOrder", ...)` block in `src/server/ordering/place-order.test.ts` (the file's `setup()` helper gives a branch with `openingHours: []` = always open):

```ts
  it("persists a valid scheduledFor", async () => {
    const { t, branch, pizza } = await setup("po-sched1");
    const scheduled = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2h
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: scheduled.toISOString(),
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrderByToken } = await import("./service");
    const order = await getOrderByToken(t.id, res.statusToken);
    expect(order?.scheduledFor).not.toBeNull();
    expect(Math.abs(order!.scheduledFor!.getTime() - scheduled.getTime())).toBeLessThan(1000);
  });

  it("rejects a scheduledFor under the minimum lead", async () => {
    const { t, branch, pizza } = await setup("po-sched2");
    const { InvalidScheduleError } = await import("./errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // +10min < 30min lead
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidScheduleError);
  });

  it("rejects a scheduledFor beyond today+tomorrow", async () => {
    const { t, branch, pizza } = await setup("po-sched3");
    const { InvalidScheduleError } = await import("./errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // +3 days
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidScheduleError);
  });

  it("rejects an unparseable scheduledFor", async () => {
    const { t, branch, pizza } = await setup("po-sched4");
    const { InvalidScheduleError } = await import("./errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: "not-a-date",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidScheduleError);
  });

  it("rejects a scheduledFor when the branch is closed at that time, but allows a pre-order while closed now", async () => {
    const { t, branch, pizza } = await setup("po-sched5");
    const { InvalidScheduleError } = await import("./errors");
    // Open 10:00–23:00 every day (tenant tz Africa/Cairo, the default).
    await updateBranchOrdering(t.id, branch.id, {
      acceptingOrders: true,
      openingHours: Array.from({ length: 7 }, (_, day) => ({ day, open: "10:00", close: "23:00", closed: false })),
    });
    const { listSlots } = await import("@/server/branches/slots");
    const { getBranch } = await import("@/server/branches/service");
    const b = await getBranch(t.id, branch.id);
    const slots = listSlots(b, "Africa/Cairo", new Date());
    // A valid slot exists regardless of current wall-clock (today or tomorrow):
    expect(slots.length).toBeGreaterThan(0);
    const ok = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: slots[0].toISOString(),
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    expect(ok.orderNumber).toBe(1);
    // Tomorrow 01:00 UTC = 04:00 Cairo — inside the horizon, outside the
    // 10:00–23:00 hours. (setUTCDate(getUTCDate()+1) rolls months correctly.)
    const closedAt = new Date();
    closedAt.setUTCDate(closedAt.getUTCDate() + 1);
    closedAt.setUTCHours(1, 0, 0, 0);
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: closedAt.toISOString(),
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidScheduleError);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/ordering/place-order.test.ts`
Expected: FAIL — TypeScript: `scheduledFor` not in `PlaceOrderInput`; `InvalidScheduleError` not exported.

- [ ] **Step 3: Add the column**

In `src/server/ordering/schema.ts`, in the `orders` table, directly after `statusToken`:

```ts
  statusToken: text("status_token").notNull().unique(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
```

- [ ] **Step 4: Generate + apply the migration**

Run: `npm run db:generate`
Expected: new `drizzle/00XX_*.sql` containing `ALTER TABLE "orders" ADD COLUMN "scheduled_for" timestamp with time zone;`.

Run: `npm run db:migrate:test`
Expected: exits 0.

- [ ] **Step 5: Add `InvalidScheduleError`**

Append to `src/server/ordering/errors.ts`:

```ts
export class InvalidScheduleError extends DomainError {
  readonly code = "invalid_schedule";
  constructor(public readonly detail: "unparseable" | "too_soon" | "too_far" | "closed_at_time") {
    super(`Invalid schedule: ${detail}`);
    this.name = "InvalidScheduleError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "هذا الموعد غير متاح — يرجى اختيار وقت آخر"
      : "That time isn't available — please pick another time";
  }
}
```

- [ ] **Step 6: Wire scheduling into `placeOrder`**

In `src/server/ordering/service.ts`:

1. Imports — replace the `isBranchOrderable` import and add the new ones:

```ts
import { isBranchOrderableAt, isWithinSchedulingHorizon, MIN_LEAD_MINUTES } from "@/server/branches/slots";
import { getTenantById } from "@/server/tenancy";
```

and add `InvalidScheduleError` to the `./errors` import list.

2. `PlaceOrderInput` — add after `addressText?: string;`:

```ts
  /** ISO 8601. Absent/undefined = ASAP. */
  scheduledFor?: string;
```

3. In `placeOrder`, after `const now = input.now ?? new Date();` add:

```ts
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new OrderValidationError("unknown tenant");
  const tz = tenant.timezone;

  let scheduledFor: Date | null = null;
  if (input.scheduledFor !== undefined) {
    const at = new Date(input.scheduledFor);
    if (Number.isNaN(at.getTime())) throw new InvalidScheduleError("unparseable");
    if (at.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60_000) throw new InvalidScheduleError("too_soon");
    if (!isWithinSchedulingHorizon(tz, now, at)) throw new InvalidScheduleError("too_far");
    scheduledFor = at;
  }
```

4. Replace the orderability check inside the transaction (`if (!isBranchOrderable(branch, now)) throw new BranchNotAcceptingOrdersError();`) with:

```ts
    if (scheduledFor) {
      if (!isBranchOrderableAt(branch, tz, scheduledFor)) throw new InvalidScheduleError("closed_at_time");
    } else if (!isBranchOrderableAt(branch, tz, now)) {
      throw new BranchNotAcceptingOrdersError();
    }
```

5. In the `tx.insert(orders).values({...})` object, add `scheduledFor,` after `statusToken,`.

- [ ] **Step 7: Pass `scheduledFor` through the API route**

In `src/app/api/orders/route.ts`, in the `input: PlaceOrderInput` allowlist, after `addressText:`:

```ts
    scheduledFor: typeof body.scheduledFor === "string" ? body.scheduledFor : undefined,
```

(`now` remains server-controlled — do not accept it from the body.)

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/server/ordering/`
Expected: PASS — all new scheduling tests plus every pre-existing ordering test (ASAP paths unchanged).

- [ ] **Step 9: Apply the migration to the primary database**

Run: `npm run db:migrate`
Expected: exits 0. Additive nullable column — safe per repo convention.

- [ ] **Step 10: Commit**

```bash
git add src/server/ordering/ src/app/api/orders/route.ts drizzle/
git commit -m "feat(ordering): scheduled orders with tz-correct validation and pre-orders"
```

---

### Task 4: Customer cancel — service + public endpoint

**Files:**
- Modify: `src/server/ordering/service.ts` (add `cancelOrderByToken`)
- Create: `src/app/api/orders/[token]/cancel/route.ts`
- Modify: `src/server/ordering/orders.test.ts` (add cancel tests; this file already covers `getOrderByToken`/`transitionStatus` patterns)

**Interfaces:**
- Consumes: `canTransition` (existing), `orders`/`orderStatusEvents` schema, `InvalidTransitionError`, `OrderNotFoundError`.
- Produces: `cancelOrderByToken(tenantId: string, token: string): Promise<Order>`; `POST /api/orders/[token]/cancel?slug=<slug>` → `201`-less plain `200 { status: "cancelled" }`, or 422 `{ error, code }`. Consumed by Task 10 (tracking page).

- [ ] **Step 1: Write the failing tests**

Append to the existing top-level `describe` in `src/server/ordering/orders.test.ts`. Read that file's existing setup helper first: if it already creates a tenant/branch/product (and a user for `transitionStatus` calls), reuse it verbatim; if not, copy the `setup()` function from `src/server/ordering/place-order.test.ts:12-25` into this file and extend it with a user the same way this file's existing `transitionStatus` tests create one. The assertions below are the contract:

```ts
  it("cancelOrderByToken cancels a pending order and records the event", async () => {
    const { t, branch, pizza } = await setup("cx1");
    const placed = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { cancelOrderByToken, getOrder } = await import("./service");
    const cancelled = await cancelOrderByToken(t.id, placed.statusToken);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("cancelled_by_customer");
    const detail = await getOrder(t.id, placed.orderId);
    const evt = detail.events.find((e) => e.toStatus === "cancelled");
    expect(evt).toBeDefined();
    expect(evt!.changedByUserId).toBeNull();
    expect(evt!.reason).toBe("cancelled_by_customer");
  });

  it("cancelOrderByToken rejects a non-pending order", async () => {
    const { t, branch, pizza, userId } = await setup("cx2");
    const { InvalidTransitionError } = await import("./errors");
    const placed = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { cancelOrderByToken, transitionStatus } = await import("./service");
    await transitionStatus(t.id, placed.orderId, "confirmed", userId);
    await expect(cancelOrderByToken(t.id, placed.statusToken)).rejects.toThrow(InvalidTransitionError);
  });

  it("cancelOrderByToken 404s an unknown token", async () => {
    const { t } = await setup("cx3");
    const { cancelOrderByToken } = await import("./service");
    const { OrderNotFoundError } = await import("./errors");
    await expect(cancelOrderByToken(t.id, "no-such-token")).rejects.toThrow(OrderNotFoundError);
  });
```

If the file's setup doesn't return a `userId`, create one the way its existing `transitionStatus` tests do (copy that file's local pattern verbatim).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/ordering/orders.test.ts`
Expected: FAIL — `cancelOrderByToken` is not exported.

- [ ] **Step 3: Implement the service function**

Append to `src/server/ordering/service.ts` (after `getOrderByToken`):

```ts
/** Customer-initiated cancel, authorised by possession of the status token.
 * Policy: only while still `pending` — once the restaurant confirms, the
 * customer escalates via phone/WhatsApp instead. Dashboard cancels keep their
 * wider state-machine rights via transitionStatus. */
export async function cancelOrderByToken(tenantId: string, token: string): Promise<Order> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.statusToken, token)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (order.status !== "pending" || !canTransition(order.status, "cancelled", order.fulfillmentType)) {
      throw new InvalidTransitionError(order.status, "cancelled");
    }
    const [updated] = await tx.update(orders)
      .set({ status: "cancelled", cancelReason: "cancelled_by_customer", updatedAt: new Date() })
      .where(eq(orders.id, order.id)).returning();
    await tx.insert(orderStatusEvents).values({
      tenantId, orderId: order.id, fromStatus: order.status, toStatus: "cancelled",
      changedByUserId: null, reason: "cancelled_by_customer",
    });
    return updated;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/ordering/orders.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the API route**

Create `src/app/api/orders/[token]/cancel/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug } from "@/server/tenancy";
import { cancelOrderByToken } from "@/server/ordering/service";
import { DomainError } from "@/shared/errors";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const slug = req.headers.get("x-tenant-slug") ?? new URL(req.url).searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const order = await cancelOrderByToken(tenant.id, token);
    return NextResponse.json({ status: order.status });
  } catch (e) {
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.messageFor("en"), code: e.code }, { status: 422 });
    }
    console.error("cancelOrderByToken failed", { tenantId: tenant.id, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/ordering/service.ts src/server/ordering/orders.test.ts "src/app/api/orders/[token]/cancel/route.ts"
git commit -m "feat(ordering): customer cancel of pending orders via status token"
```

---

### Task 5: Cart helpers — line merging + quantity editing

**Files:**
- Modify: `src/app/_components/cart.ts`
- Modify: `src/app/_components/cart.test.ts`

**Interfaces:**
- Produces (pure, node-testable): `mergeLine(current: Cart, branchId: string | null, line: CartLine): Cart`; `withLineQuantity(cart: Cart, index: number, quantity: number): Cart` (quantity ≤ 0 removes the line).
- Produces (localStorage wrappers, existing call-sites keep working): `addLine(branchId, line): Cart` (now merges); `setLineQuantity(index: number, quantity: number): Cart`; `removeLine(index): Cart` (unchanged signature).
- Consumed by Tasks 8 and 9.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/_components/cart.test.ts`:

```ts
import { mergeLine, withLineQuantity, type Cart } from "./cart";

const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: "p1", nameEn: "A", nameAr: "أ", quantity: 1, unitPrice: 100,
  selectedOptionIds: [], modifierSummaryEn: "", ...over,
});

describe("mergeLine", () => {
  it("merges identical product + options (order-insensitive) by adding quantities", () => {
    const cart: Cart = { branchId: "b1", lines: [line({ selectedOptionIds: ["o1", "o2"], quantity: 2 })] };
    const next = mergeLine(cart, "b1", line({ selectedOptionIds: ["o2", "o1"], quantity: 1 }));
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0].quantity).toBe(3);
  });
  it("keeps different option sets as separate lines", () => {
    const cart: Cart = { branchId: "b1", lines: [line({ selectedOptionIds: ["o1"] })] };
    const next = mergeLine(cart, "b1", line({ selectedOptionIds: [] }));
    expect(next.lines).toHaveLength(2);
  });
  it("resets the cart when the branch changes", () => {
    const cart: Cart = { branchId: "b1", lines: [line()] };
    const next = mergeLine(cart, "b2", line({ productId: "p9" }));
    expect(next.branchId).toBe("b2");
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0].productId).toBe("p9");
  });
});

describe("withLineQuantity", () => {
  it("sets a line's quantity", () => {
    const cart: Cart = { branchId: null, lines: [line({ quantity: 1 })] };
    expect(withLineQuantity(cart, 0, 4).lines[0].quantity).toBe(4);
  });
  it("removes the line at quantity 0", () => {
    const cart: Cart = { branchId: null, lines: [line()] };
    expect(withLineQuantity(cart, 0, 0).lines).toHaveLength(0);
  });
  it("ignores an out-of-range index", () => {
    const cart: Cart = { branchId: null, lines: [line()] };
    expect(withLineQuantity(cart, 5, 2).lines).toHaveLength(1);
  });
});
```

(Also add `CartLine` to the existing type-only import at the top of the test file if not already imported.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/_components/cart.test.ts`
Expected: FAIL — `mergeLine` / `withLineQuantity` not exported.

- [ ] **Step 3: Implement**

In `src/app/_components/cart.ts`, replace `addLine` and `removeLine` with:

```ts
function sameOptions(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Pure merge: same product + same option set (order-insensitive) adds
 * quantities; a branch change resets the cart to the new branch first. */
export function mergeLine(current: Cart, branchId: string | null, line: CartLine): Cart {
  const cart: Cart = current.branchId && current.branchId !== branchId
    ? { branchId, lines: [] }
    : { branchId: branchId ?? current.branchId, lines: [...current.lines] };
  const i = cart.lines.findIndex(
    (l) => l.productId === line.productId && sameOptions(l.selectedOptionIds, line.selectedOptionIds),
  );
  if (i >= 0) cart.lines[i] = { ...cart.lines[i], quantity: cart.lines[i].quantity + line.quantity };
  else cart.lines.push(line);
  return cart;
}

/** Pure quantity update; quantity ≤ 0 removes the line. */
export function withLineQuantity(cart: Cart, index: number, quantity: number): Cart {
  if (!cart.lines[index]) return cart;
  const lines = [...cart.lines];
  if (quantity <= 0) lines.splice(index, 1);
  else lines[index] = { ...lines[index], quantity };
  return { ...cart, lines };
}

/** Adds a line (merging duplicates). If the branch changed, the cart resets first. */
export function addLine(branchId: string | null, line: CartLine): Cart {
  const cart = mergeLine(loadCart(), branchId, line);
  saveCart(cart);
  return cart;
}

export function setLineQuantity(index: number, quantity: number): Cart {
  const cart = withLineQuantity(loadCart(), index, quantity);
  saveCart(cart);
  return cart;
}

export function removeLine(index: number): Cart {
  return setLineQuantity(index, 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/_components/cart.test.ts`
Expected: PASS (new tests + the pre-existing `cartSubtotal` tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (existing callers of `addLine`/`removeLine` in `StorefrontMenu.tsx` are signature-compatible).

- [ ] **Step 6: Commit**

```bash
git add src/app/_components/cart.ts src/app/_components/cart.test.ts
git commit -m "feat(storefront): cart line merging and quantity editing helpers"
```

---

### Task 6: Menu page — open-state banner, paused gating, branch-pick sheet

**Files:**
- Create: `src/app/_components/storefront/OpenStateBanner.tsx`
- Create: `src/app/_components/storefront/BranchPickSheet.tsx`
- Modify: `src/app/page.tsx` (storefront branch)
- Modify: `src/app/_components/StorefrontMenu.tsx`

**Interfaces:**
- Consumes: `getBranchOpenState`, `isBranchOrderableAt` (Task 2); `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle` from `src/components/ui/sheet.tsx` (existing).
- Produces: `OpenStateBanner({ state, paused }: { state: { open: boolean; opensAt?: string; closesAt?: string }; paused: boolean })` (server-renderable).
- Produces: `BranchPickSheet({ branches, open, onOpenChange, productId }: { branches: { id: string; name: string; open: boolean }[]; open: boolean; onOpenChange: (o: boolean) => void; productId: string | null })` — on pick, navigates to `?branch=<id>&product=<productId>`.
- Changes `StorefrontMenu` props to:
  `{ menu: PublishedMenu; branchId: string | null; slug: string; orderingEnabled: boolean; preorderOnly: boolean; branches: { id: string; name: string; open: boolean }[]; currency: string }`
  — `currency` is threaded in Task 8; include it in the type now, pass `tenant.currency` from `page.tsx` immediately so this task compiles once.
- Contract: when `?product=<id>` is present on load, `StorefrontMenu` opens that product's sheet and strips the param via `history.replaceState`.

- [ ] **Step 1: Write `OpenStateBanner.tsx`**

```tsx
import type { BranchOpenState } from "@/server/branches/slots";

export function OpenStateBanner({ state, paused }: { state: BranchOpenState; paused: boolean }) {
  if (paused) {
    return (
      <div className="border-b border-border bg-muted px-4 py-2.5 text-sm text-muted-foreground sm:px-6">
        Not taking orders right now.
      </div>
    );
  }
  if (state.open) {
    if (!state.closesAt) return null;
    return (
      <div className="border-b border-border bg-background px-4 py-2.5 text-sm text-muted-foreground sm:px-6">
        Open · closes {state.closesAt}
      </div>
    );
  }
  return (
    <div className="border-b border-border bg-primary/10 px-4 py-2.5 text-sm font-medium text-ink sm:px-6">
      Closed{state.opensAt ? ` · pre-order for when we open at ${state.opensAt}` : " · pre-orders welcome"}
    </div>
  );
}
```

- [ ] **Step 2: Write `BranchPickSheet.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";

export function BranchPickSheet({
  branches, open, onOpenChange, productId,
}: {
  branches: { id: string; name: string; open: boolean }[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  productId: string | null;
}) {
  const router = useRouter();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Choose a branch</SheetTitle>
          <SheetDescription>Prices and availability can differ per branch.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 flex flex-col gap-2">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                const params = new URLSearchParams(window.location.search);
                params.set("branch", b.id);
                if (productId) params.set("product", productId);
                router.push(`?${params.toString()}`);
                onOpenChange(false);
              }}
              className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary"
            >
              <span className="font-sans font-semibold text-ink">{b.name}</span>
              <span className={`text-xs font-medium ${b.open ? "text-status-ready-fg" : "text-muted-foreground"}`}>
                {b.open ? "Open" : "Closed · pre-order"}
              </span>
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

(If `text-status-ready-fg` doesn't exist in `globals.css`, use `text-primary` — check with `grep -n "status-ready" src/app/globals.css`; the dashboard's `OrdersTable.tsx:102` uses it, so it should.)

- [ ] **Step 3: Wire the storefront branch of `page.tsx`**

In `src/app/page.tsx`:

1. Add imports:

```tsx
import { getBranchOpenState, isBranchOrderableAt } from "@/server/branches/slots";
import { OpenStateBanner } from "./_components/storefront/OpenStateBanner";
```

2. After the existing `Promise.all` (line 47-52), resolve the active branch and states:

```tsx
    const activeBranch =
      branches.length === 1 ? branches[0] : (branches.find((b) => b.id === branchId) ?? null);
    const now = new Date();
    const openState = activeBranch ? getBranchOpenState(activeBranch, tenant.timezone, now) : null;
    const paused = activeBranch ? !activeBranch.isActive || !activeBranch.acceptingOrders : false;
    const branchSummaries = branches.map((b) => ({
      id: b.id,
      name: b.name,
      open: isBranchOrderableAt(b, tenant.timezone, now),
    }));
```

3. Render the banner directly under `<Hero ... />`:

```tsx
        {openState && <OpenStateBanner state={openState} paused={paused} />}
```

4. Update the `StorefrontMenu` call:

```tsx
            <StorefrontMenu
              menu={menu}
              branchId={activeBranch?.id ?? null}
              slug={slug!}
              orderingEnabled={orderingEnabled && !paused}
              preorderOnly={openState !== null && !openState.open && !paused}
              branches={branchSummaries}
              currency={tenant.currency}
            />
```

- [ ] **Step 4: Extend `StorefrontMenu.tsx`**

Changes (full-body context is 127 lines; apply surgically):

1. Props type becomes the one in **Interfaces** above. Add imports:

```tsx
import { BranchPickSheet } from "./storefront/BranchPickSheet";
```

2. New state + deep-link effect inside the component:

```tsx
  const [branchPickFor, setBranchPickFor] = useState<string | null>(null);
  const needsBranchPick = branchId === null && branches.length > 1;

  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("product");
    if (!wanted) return;
    const product = menu.categories.flatMap((c) => c.products).find((p) => p.id === wanted);
    if (product) setActiveProduct(product);
    const params = new URLSearchParams(window.location.search);
    params.delete("product");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [menu]);
```

3. Card open handler — replace `onOpen={() => setActiveProduct(p)}` with:

```tsx
                onOpen={() => (needsBranchPick ? setBranchPickFor(p.id) : setActiveProduct(p))}
```

4. Render the pick sheet next to `ProductSheet` (inside the `orderingEnabled` fragment):

```tsx
          <BranchPickSheet
            branches={branches}
            open={branchPickFor !== null}
            onOpenChange={(o) => !o && setBranchPickFor(null)}
            productId={branchPickFor}
          />
```

5. `currency` and `preorderOnly` are consumed in Task 8 (drawer, cards, cart bar). In this task, include them in the props **type** but don't destructure them yet — an un-destructured prop compiles cleanly and keeps the contract stable for Task 8.

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 6: Manual verification**

`npm run dev`, visit `roma.serveos.localhost:3000`: single-branch tenant → banner shows "Open · closes 23:00" (seed hours 10:00–23:00); temporarily set the branch's `acceptingOrders=false` in the dashboard (Branches → ordering toggle) → "Not taking orders" banner, cards non-interactive; revert. To exercise the pick sheet, add a second branch in the dashboard, reload without `?branch=`, tap a card → pick sheet appears; picking navigates and opens the tapped product's sheet.

- [ ] **Step 7: Commit**

```bash
git add src/app/_components/storefront/OpenStateBanner.tsx src/app/_components/storefront/BranchPickSheet.tsx src/app/page.tsx src/app/_components/StorefrontMenu.tsx
git commit -m "feat(storefront): open-state banner, paused gating, pick-before-cart branch flow"
```

---

### Task 7: Recent-order strip + storefront footer

**Files:**
- Create: `src/app/_components/recent-orders.ts`
- Create: `src/app/_components/recent-orders.test.ts`
- Create: `src/app/_components/storefront/RecentOrderStrip.tsx`
- Create: `src/app/_components/storefront/StorefrontFooter.tsx`
- Modify: `src/app/page.tsx` (render both)

**Interfaces:**
- Produces (pure): `pruneRecentOrders(list: RecentOrder[], now: Date): RecentOrder[]` where `RecentOrder = { token: string; orderNumber: number; placedAt: string; status?: string }` — drops terminal (`completed`/`rejected`/`cancelled`) and >24h-old entries, keeps max 3 newest.
- Produces (localStorage, key `serveos.recent-orders`): `loadRecentOrders(): RecentOrder[]`, `rememberOrder(o: RecentOrder): void`, `updateRecentOrderStatus(token: string, status: string): void`.
- Produces: `RecentOrderStrip()` (client, self-contained — reads localStorage, polls each entry once via `GET /api/orders/[token]/status?slug=` using the page origin's slug from a `slug` prop).
- Produces: `StorefrontFooter({ branch, whatsappNumber }: { branch: { name: string; address: string | null; phone: string | null; openingHours: OpeningHours } | null; whatsappNumber: string | null })` (server component).
- Consumed by: Task 9 records orders via `rememberOrder` after checkout success.

- [ ] **Step 1: Write the failing test**

Create `src/app/_components/recent-orders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pruneRecentOrders, type RecentOrder } from "./recent-orders";

const now = new Date("2026-07-07T12:00:00Z");
const entry = (over: Partial<RecentOrder>): RecentOrder => ({
  token: "t", orderNumber: 1, placedAt: "2026-07-07T11:00:00Z", ...over,
});

describe("pruneRecentOrders", () => {
  it("drops terminal statuses", () => {
    const list = [entry({ status: "completed" }), entry({ token: "u", status: "pending" })];
    expect(pruneRecentOrders(list, now).map((e) => e.token)).toEqual(["u"]);
  });
  it("drops entries older than 24h", () => {
    const list = [entry({ placedAt: "2026-07-06T11:00:00Z" }), entry({ token: "u" })];
    expect(pruneRecentOrders(list, now).map((e) => e.token)).toEqual(["u"]);
  });
  it("keeps at most the 3 newest", () => {
    const list = [1, 2, 3, 4].map((n) =>
      entry({ token: `t${n}`, orderNumber: n, placedAt: `2026-07-07T0${n}:00:00Z` }));
    expect(pruneRecentOrders(list, now).map((e) => e.orderNumber)).toEqual([4, 3, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/_components/recent-orders.test.ts`
Expected: FAIL — cannot resolve `./recent-orders`.

- [ ] **Step 3: Implement `recent-orders.ts`**

```ts
export type RecentOrder = { token: string; orderNumber: number; placedAt: string; status?: string };

const KEY = "serveos.recent-orders";
const TERMINAL = new Set(["completed", "rejected", "cancelled"]);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function pruneRecentOrders(list: RecentOrder[], now: Date): RecentOrder[] {
  return list
    .filter((o) => !TERMINAL.has(o.status ?? ""))
    .filter((o) => now.getTime() - new Date(o.placedAt).getTime() < MAX_AGE_MS)
    .sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime())
    .slice(0, 3);
}

export function loadRecentOrders(): RecentOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentOrder[]) : [];
    return pruneRecentOrders(list, new Date());
  } catch {
    return [];
  }
}

function save(list: RecentOrder[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(list));
}

export function rememberOrder(o: RecentOrder): void {
  save(pruneRecentOrders([o, ...loadRecentOrders().filter((e) => e.token !== o.token)], new Date()));
}

export function updateRecentOrderStatus(token: string, status: string): void {
  save(pruneRecentOrders(
    loadRecentOrders().map((e) => (e.token === token ? { ...e, status } : e)),
    new Date(),
  ));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/_components/recent-orders.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `RecentOrderStrip.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { loadRecentOrders, updateRecentOrderStatus, type RecentOrder } from "../recent-orders";

export function RecentOrderStrip({ slug }: { slug: string }) {
  const [orders, setOrders] = useState<RecentOrder[]>([]);

  useEffect(() => {
    const current = loadRecentOrders();
    setOrders(current);
    // Refresh each entry's status once per page view; prune on the next load.
    current.forEach((o) => {
      fetch(`/api/orders/${o.token}/status?slug=${encodeURIComponent(slug)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.status && updateRecentOrderStatus(o.token, d.status))
        .catch(() => {});
    });
  }, [slug]);

  if (orders.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 pt-4 sm:px-6">
      {orders.map((o) => (
        <a
          key={o.token}
          href={`/order/${o.token}`}
          className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-2.5 text-sm shadow-sm transition-shadow hover:shadow-md"
        >
          <span className="font-sans font-semibold text-ink">Your order · #{o.orderNumber}</span>
          <span className="text-muted-foreground">{o.status ?? "view"} →</span>
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Write `StorefrontFooter.tsx`**

```tsx
import type { OpeningHours } from "@/server/branches/schema";
import { whatsappChatLink } from "@/lib/whatsapp";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function StorefrontFooter({
  branch, whatsappNumber,
}: {
  branch: { name: string; address: string | null; phone: string | null; openingHours: OpeningHours } | null;
  whatsappNumber: string | null;
}) {
  if (!branch && !whatsappNumber) return null;
  return (
    <footer className="mt-12 border-t border-border bg-card px-4 py-8 sm:px-6">
      <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-2">
        {branch && (
          <div>
            <div className="eyebrow text-muted-foreground">Find us</div>
            <p className="mt-2 font-sans font-semibold text-ink">{branch.name}</p>
            {branch.address && <p className="text-sm text-muted-foreground">{branch.address}</p>}
            {branch.phone && (
              <a href={`tel:${branch.phone}`} className="mt-1 block text-sm font-medium text-primary">
                {branch.phone}
              </a>
            )}
            {whatsappNumber && (
              <a
                href={whatsappChatLink(whatsappNumber, "")}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block text-sm font-medium text-primary"
              >
                WhatsApp us
              </a>
            )}
          </div>
        )}
        {branch && branch.openingHours.length > 0 && (
          <div>
            <div className="eyebrow text-muted-foreground">Opening hours</div>
            <dl className="mt-2 space-y-1 text-sm">
              {branch.openingHours.map((h) => (
                <div key={h.day} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{DAYS[h.day]}</dt>
                  <dd className="font-mono text-ink">{h.closed ? "Closed" : `${h.open}–${h.close}`}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </footer>
  );
}
```

(Check `whatsappChatLink`'s exact signature in `src/lib/whatsapp.ts` before use — if the message argument is required-nonempty, pass `"Hi!"`.)

- [ ] **Step 7: Render both in `page.tsx`**

In the storefront branch of `src/app/page.tsx`:

```tsx
import { RecentOrderStrip } from "./_components/storefront/RecentOrderStrip";
import { StorefrontFooter } from "./_components/storefront/StorefrontFooter";
import { getWhatsappNumber } from "@/server/tenancy/settings";
```

Add `getWhatsappNumber(tenant.id)` to the existing `Promise.all`, then render `<RecentOrderStrip slug={slug!} />` directly under the `OpenStateBanner`, and before `</main>`:

```tsx
        <StorefrontFooter
          branch={activeBranch ?? branches[0] ?? null}
          whatsappNumber={whatsappNumber}
        />
```

(The footer intentionally falls back to the first branch when none is chosen — informational only.)

- [ ] **Step 8: Typecheck, build, manual check**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.
Manual: menu page shows footer with seed branch hours (10:00–23:00 all week) and the two links; after Task 9 lands, placing an order makes the strip appear.

- [ ] **Step 9: Commit**

```bash
git add src/app/_components/recent-orders.ts src/app/_components/recent-orders.test.ts src/app/_components/storefront/RecentOrderStrip.tsx src/app/_components/storefront/StorefrontFooter.tsx src/app/page.tsx
git commit -m "feat(storefront): recent-order re-entry strip + info footer"
```

---

### Task 8: Cart drawer rebuild + currency threading through the menu family

**Files:**
- Create: `src/app/_components/storefront/CartDrawer.tsx`
- Modify: `src/app/_components/StorefrontMenu.tsx` (use new drawer; pass `currency` down; delete the inline `CartDrawer` function)
- Modify: `src/app/_components/storefront/ProductCard.tsx` (price via `formatMoney`)
- Modify: `src/app/_components/storefront/ProductSheet.tsx` (Add button + price deltas via `formatMoney`)
- Modify: `src/app/_components/storefront/CartBar.tsx` (subtotal via `formatMoney`)

**Interfaces:**
- Consumes: `formatMoney` (Task 1); `setLineQuantity` (Task 5); `Sheet` primitives; `StorefrontMenu` props incl. `currency`, `preorderOnly` (Task 6).
- Produces: `CartDrawer({ cart, slug, currency, preorderOnly, open, onOpenChange, onSetQuantity }: { cart: Cart; slug: string; currency: string; preorderOnly: boolean; open: boolean; onOpenChange: (o: boolean) => void; onSetQuantity: (index: number, quantity: number) => void })`.
- `ProductCard`, `ProductSheet`, `CartBar` each gain a `currency: string` prop (all call-sites are inside `StorefrontMenu.tsx`).

- [ ] **Step 1: Write `CartDrawer.tsx`**

```tsx
"use client";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatMoney } from "@/lib/money";
import { cartSubtotal, type Cart } from "../cart";

export function CartDrawer({
  cart, slug, currency, preorderOnly, open, onOpenChange, onSetQuantity,
}: {
  cart: Cart;
  slug: string;
  currency: string;
  preorderOnly: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSetQuantity: (index: number, quantity: number) => void;
}) {
  const subtotal = cartSubtotal(cart.lines);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Your cart</SheetTitle>
        </SheetHeader>

        {cart.lines.length === 0 && (
          <p className="mt-4 text-sm text-muted-foreground">Cart is empty.</p>
        )}

        {cart.lines.map((l, i) => (
          <div key={`${l.productId}-${l.selectedOptionIds.join(".")}`} className="flex items-center justify-between gap-3 border-b border-border py-3">
            <div className="min-w-0">
              <div className="truncate font-sans font-semibold text-ink">{l.nameEn}</div>
              {l.modifierSummaryEn && (
                <div className="truncate text-xs text-muted-foreground">{l.modifierSummaryEn}</div>
              )}
              <div className="mt-1.5 inline-flex items-center gap-3 rounded-full border border-border px-2.5 py-1">
                <button type="button" onClick={() => onSetQuantity(i, l.quantity - 1)} className="text-base leading-none" aria-label={`Decrease ${l.nameEn}`}>−</button>
                <span className="w-4 text-center text-sm">{l.quantity}</span>
                <button type="button" onClick={() => onSetQuantity(i, l.quantity + 1)} className="text-base leading-none" aria-label={`Increase ${l.nameEn}`}>+</button>
              </div>
            </div>
            <div className="shrink-0 text-right font-display font-bold text-ink">
              {formatMoney(l.unitPrice * l.quantity, currency)}
            </div>
          </div>
        ))}

        <div className="mt-4 flex justify-between font-display font-bold text-ink">
          <span>Subtotal</span>
          <span>{formatMoney(subtotal, currency)}</span>
        </div>

        {preorderOnly && cart.lines.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            The restaurant is closed right now — you'll pick a time at checkout.
          </p>
        )}

        {cart.lines.length > 0 && (
          <a
            href={`/checkout?slug=${encodeURIComponent(slug)}${cart.branchId ? `&branch=${cart.branchId}` : ""}`}
            className="mt-4 block rounded-full bg-primary p-3 text-center font-sans font-semibold text-primary-foreground"
          >
            Checkout →
          </a>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Swap it into `StorefrontMenu.tsx`**

1. Delete the inline `function CartDrawer(...)` at the bottom of the file entirely.
2. Replace the import of `removeLine` with `setLineQuantity` in the `./cart` import, and add:

```tsx
import { CartDrawer } from "./storefront/CartDrawer";
```

3. Replace the old conditional drawer render (`{drawerOpen && (<CartDrawer ... />)}`) with:

```tsx
          <CartDrawer
            cart={cart}
            slug={slug}
            currency={currency}
            preorderOnly={preorderOnly}
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            onSetQuantity={(i, q) => setCart(setLineQuantity(i, q))}
          />
```

4. Pass `currency` to the children: `<ProductCard ... currency={currency} />`, `<ProductSheet ... currency={currency} />`, `<CartBar ... currency={currency} />`.

- [ ] **Step 3: Currency in the three leaf components**

`ProductCard.tsx` — add `currency: string` to props; replace the price span with:

```tsx
          <span className="font-display font-bold text-ink">{formatMoney(product.effectivePrice, currency)}</span>
```

and add `import { formatMoney } from "@/lib/money";`.

`ProductSheet.tsx` — add `currency: string` to props, `import { formatMoney } from "@/lib/money";`; option delta becomes `+{formatMoney(Number(o.priceDelta), currency)}` and the Add button becomes:

```tsx
            Add — {formatMoney(total, currency)}
```

(The Playwright regex `/Add —/` still matches.)

`CartBar.tsx` — add `currency: string` to props, `import { formatMoney } from "@/lib/money";`; subtotal span becomes:

```tsx
      <span className="font-display font-bold">{formatMoney(subtotal, currency)} →</span>
```

- [ ] **Step 4: Typecheck, build, existing e2e**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.
Run: `npx playwright test tests/e2e/ordering.spec.ts`
Expected: PASS — the flow's roles/names are unchanged (`Configure`, `Add —`, `View cart`, `Checkout`).

- [ ] **Step 5: Manual verification**

Add the same product with the same options twice → one line with quantity 2; steppers adjust and remove at 0; all prices show `EGP …`; drawer renders as a bottom sheet on a narrow viewport.

- [ ] **Step 6: Commit**

```bash
git add src/app/_components/storefront/CartDrawer.tsx src/app/_components/StorefrontMenu.tsx src/app/_components/storefront/ProductCard.tsx src/app/_components/storefront/ProductSheet.tsx src/app/_components/storefront/CartBar.tsx
git commit -m "feat(storefront): sheet-based cart drawer with quantity editing + currency display"
```

---

### Task 9: Checkout rebuild — branding, branch guard, scheduling, prefill, min-order

**Files:**
- Modify: `src/app/checkout/page.tsx` (full rewrite)
- Modify: `src/app/checkout/CheckoutForm.tsx` (full rewrite)

**Interfaces:**
- Consumes: `listSlots`, `getBranchOpenState`, `localDateKey` (Task 2); `formatSlotLabel`, `formatMoney` (Task 1); `rememberOrder` (Task 7); cart helpers (Task 5); `Button`, `Input`, `Label` from `src/components/ui/`; `EmptyState`.
- Produces: `SlotOption = { iso: string; label: string; day: "Today" | "Tomorrow" }` (defined in `CheckoutForm.tsx`, built in `page.tsx`).
- Produces: `CheckoutForm({ slug, branchId, branchName, vatRate, currency, openNow, slots }: { slug: string; branchId: string; branchName: string; vatRate: number; currency: string; openNow: boolean; slots: SlotOption[] })`.
- localStorage key `serveos.customer`: `{ name: string; phone: string; address: string }`.

- [ ] **Step 1: Rewrite `src/app/checkout/page.tsx`**

```tsx
import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable, getVatRate } from "@/server/tenancy";
import { listBranches } from "@/server/branches/service";
import { getBranchOpenState, listSlots, localDateKey } from "@/server/branches/slots";
import { formatSlotLabel } from "@/lib/datetime";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { CheckoutForm, type SlotOption } from "./CheckoutForm";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string; branch?: string }>;
}) {
  const h = await headers();
  const headerSlug = h.get("x-tenant-slug");
  const { slug: querySlug, branch: branchParam } = await searchParams;
  const slug = headerSlug ?? querySlug;
  if (!slug) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState title="Not found" />
      </main>
    );
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState title="Restaurant not available" />
      </main>
    );
  }

  const [branches, vatRate] = await Promise.all([listBranches(tenant.id), getVatRate(tenant.id)]);
  // No silent fallback: resolve only an explicit ?branch= or the single branch.
  const branch =
    branches.length === 1 ? branches[0] : (branches.find((b) => b.id === branchParam) ?? null);
  if (!branch) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState
          title="Choose a branch first"
          description="Head back to the menu and pick a branch before checking out."
        />
      </main>
    );
  }

  const now = new Date();
  const openState = getBranchOpenState(branch, tenant.timezone, now);
  const today = localDateKey(now, tenant.timezone);
  const slots: SlotOption[] = listSlots(branch, tenant.timezone, now).map((d) => ({
    iso: d.toISOString(),
    label: formatSlotLabel(d, tenant.timezone),
    day: localDateKey(d, tenant.timezone) === today ? "Today" : "Tomorrow",
  }));

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-md">
        <div className="eyebrow text-muted-foreground">Checkout</div>
        <h1 className="mt-1 font-display text-2xl font-extrabold text-ink">{tenant.name}</h1>
        <p className="text-sm text-muted-foreground">{branch.name}</p>
        <CheckoutForm
          slug={slug}
          branchId={branch.id}
          branchName={branch.name}
          vatRate={vatRate}
          currency={tenant.currency}
          openNow={openState.open && branch.isActive && branch.acceptingOrders}
          slots={slots}
        />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Rewrite `src/app/checkout/CheckoutForm.tsx`**

```tsx
"use client";
import { useEffect, useMemo, useState } from "react";
import { loadCart, clearCart, cartSubtotal, type Cart } from "../_components/cart";
import { rememberOrder } from "../_components/recent-orders";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type SlotOption = { iso: string; label: string; day: "Today" | "Tomorrow" };
type Area = { id: string; nameEn: string; nameAr: string; deliveryFee: string; minOrderAmount: string; etaMinutes: number | null };

const CUSTOMER_KEY = "serveos.customer";
type SavedCustomer = { name: string; phone: string; address: string };

function loadCustomer(): SavedCustomer {
  try {
    const raw = window.localStorage.getItem(CUSTOMER_KEY);
    return raw ? (JSON.parse(raw) as SavedCustomer) : { name: "", phone: "", address: "" };
  } catch {
    return { name: "", phone: "", address: "" };
  }
}

export function CheckoutForm({
  slug, branchId, branchName, vatRate, currency, openNow, slots,
}: {
  slug: string;
  branchId: string;
  branchName: string;
  vatRate: number;
  currency: string;
  openNow: boolean;
  slots: SlotOption[];
}) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [fulfillment, setFulfillment] = useState<"pickup" | "delivery">("delivery");
  const [when, setWhen] = useState<"asap" | "scheduled">(openNow ? "asap" : "scheduled");
  const [slotIso, setSlotIso] = useState<string>(slots[0]?.iso ?? "");
  const [slotDay, setSlotDay] = useState<"Today" | "Tomorrow">(slots[0]?.day ?? "Today");
  const [areas, setAreas] = useState<Area[]>([]);
  const [areaId, setAreaId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const sync = () => setCart(loadCart());
    sync();
    const saved = loadCustomer();
    setName(saved.name);
    setPhone(saved.phone);
    setAddress(saved.address);
    window.addEventListener("serveos-cart-changed", sync);
    return () => window.removeEventListener("serveos-cart-changed", sync);
  }, []);

  useEffect(() => {
    fetch(`/api/delivery-areas?slug=${encodeURIComponent(slug)}&branch=${branchId}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setAreas(d))
      .catch(() => {});
  }, [slug, branchId]);

  const subtotal = cartSubtotal(cart.lines);
  const area = useMemo(() => areas.find((a) => a.id === areaId), [areas, areaId]);
  const deliveryFee = fulfillment === "delivery" && area ? Number(area.deliveryFee) : 0;
  const vat = subtotal * (vatRate / 100);
  const total = subtotal + vat + deliveryFee;
  const minShortfall =
    fulfillment === "delivery" && area && subtotal < Number(area.minOrderAmount)
      ? Number(area.minOrderAmount) - subtotal
      : 0;
  const daySlots = slots.filter((s) => s.day === slotDay);
  const hasTomorrow = slots.some((s) => s.day === "Tomorrow");
  const branchMismatch = cart.lines.length > 0 && cart.branchId !== null && cart.branchId !== branchId;

  async function submit() {
    setError(null);
    if (fulfillment === "delivery" && (!areaId || !address.trim())) {
      setError("Please choose an area and enter your address.");
      return;
    }
    if (when === "scheduled" && !slotIso) {
      setError("Please pick a time.");
      return;
    }
    // Stale-slot pre-check (spec §3): if the picked slot slipped under the
    // 30-min lead while the customer dawdled, prompt a re-pick before the
    // server would 422 anyway.
    if (when === "scheduled" && new Date(slotIso).getTime() < Date.now() + 30 * 60_000) {
      setSlotIso("");
      setError("That time is no longer available — please pick a new one.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug, branchId, fulfillmentType: fulfillment,
          customerName: name, customerPhone: phone, notes,
          areaId: fulfillment === "delivery" ? areaId : undefined,
          addressText: fulfillment === "delivery" ? address : undefined,
          scheduledFor: when === "scheduled" ? slotIso : undefined,
          lines: cart.lines.map((l) => ({
            productId: l.productId, quantity: l.quantity, selectedOptionIds: l.selectedOptionIds,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not place order.");
        setSubmitting(false);
        return;
      }
      try {
        window.localStorage.setItem(CUSTOMER_KEY, JSON.stringify({ name, phone, address }));
      } catch { /* best-effort */ }
      rememberOrder({
        token: data.statusToken, orderNumber: data.orderNumber,
        placedAt: new Date().toISOString(), status: "pending",
      });
      clearCart();
      window.location.href = `/order/${data.statusToken}`;
    } catch {
      setError("Network error — please try again.");
      setSubmitting(false);
    }
  }

  if (cart.lines.length === 0) {
    return <p className="mt-6 text-sm text-muted-foreground">Your cart is empty.</p>;
  }

  if (branchMismatch) {
    return (
      <div className="mt-6 rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-ink">
          Your cart was built for a different branch than <strong>{branchName}</strong>.
        </p>
        <a
          href={`/checkout?slug=${encodeURIComponent(slug)}&branch=${cart.branchId}`}
          className="mt-3 inline-block rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
        >
          Continue with your cart's branch →
        </a>
      </div>
    );
  }

  const pill = (active: boolean) =>
    `flex-1 rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors ${
      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-ink"
    }`;

  return (
    <div className="mt-6 space-y-6">
      <div className="flex gap-2">
        {(["delivery", "pickup"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFulfillment(f)} className={`${pill(fulfillment === f)} capitalize`}>
            {f}
          </button>
        ))}
      </div>

      <div>
        <div className="eyebrow text-muted-foreground">When</div>
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={!openNow} onClick={() => setWhen("asap")} className={`${pill(when === "asap")} disabled:opacity-50`}>
            ASAP{!openNow && " (closed)"}
          </button>
          <button type="button" disabled={slots.length === 0} onClick={() => setWhen("scheduled")} className={`${pill(when === "scheduled")} disabled:opacity-50`}>
            Schedule
          </button>
        </div>
        {when === "scheduled" && slots.length > 0 && (
          <div className="mt-3">
            {hasTomorrow && (
              <div className="flex gap-2">
                {(["Today", "Tomorrow"] as const).map((d) => (
                  <button key={d} type="button" onClick={() => setSlotDay(d)} className={pill(slotDay === d)}>
                    {d}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {daySlots.map((s) => (
                <button
                  key={s.iso}
                  type="button"
                  onClick={() => setSlotIso(s.iso)}
                  className={`rounded-full border px-3 py-1.5 font-mono text-xs transition-colors ${
                    slotIso === s.iso ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-ink"
                  }`}
                >
                  {s.label.split(" ")[1]}
                </button>
              ))}
              {daySlots.length === 0 && <p className="text-sm text-muted-foreground">No times available {slotDay.toLowerCase()}.</p>}
            </div>
          </div>
        )}
        {when === "scheduled" && slots.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">No schedulable times in the next two days.</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="co-name">Name</Label>
          <Input id="co-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="co-phone">Phone</Label>
          <Input id="co-phone" placeholder="Phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        {fulfillment === "delivery" && (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="co-area">Area</Label>
              <select
                id="co-area"
                value={areaId}
                onChange={(e) => setAreaId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="">Select area…</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nameEn} · fee {formatMoney(Number(a.deliveryFee), currency)}
                    {a.etaMinutes ? ` · ~${a.etaMinutes} min` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="co-address">Address</Label>
              <Input id="co-address" placeholder="Street / building details" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
          </>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="co-notes">Notes (optional)</Label>
          <Input id="co-notes" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        {cart.lines.map((l, i) => (
          <div key={i} className="flex justify-between py-1 text-sm">
            <span className="text-ink">{l.quantity}× {l.nameEn}</span>
            <span className="font-mono">{formatMoney(l.unitPrice * l.quantity, currency)}</span>
          </div>
        ))}
        <div className="mt-2 space-y-1 border-t border-border pt-2 text-sm">
          <Row label="Subtotal" value={formatMoney(subtotal, currency)} />
          <Row label={`VAT ${vatRate}%`} value={formatMoney(vat, currency)} />
          {fulfillment === "delivery" && <Row label="Delivery" value={formatMoney(deliveryFee, currency)} />}
          <Row label="Total" value={formatMoney(total, currency)} bold />
        </div>
        {minShortfall > 0 && (
          <p className="mt-2 text-sm font-medium text-destructive">
            Add {formatMoney(minShortfall, currency)} more to reach this area's minimum order.
          </p>
        )}
      </div>

      {error && <p className="text-sm font-medium text-destructive">{error}</p>}

      <Button
        onClick={submit}
        disabled={submitting || !name || !phone || minShortfall > 0}
        className="w-full rounded-full py-6 text-base"
      >
        {submitting ? "Placing…" : `Place order (Cash) — ${formatMoney(total, currency)}`}
      </Button>
      <p className="text-xs text-muted-foreground">Final price is confirmed by the restaurant.</p>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-display font-bold text-ink" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
```

Keep `placeholder="Name"` / `placeholder="Phone"` — `tests/e2e/ordering.spec.ts` asserts `getByPlaceholder("Name")`.

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Run the ordering e2e**

Run: `npx playwright test tests/e2e/ordering.spec.ts`
Expected: PASS (heading `/Checkout/` and placeholder `Name` both still present).

- [ ] **Step 5: Manual verification**

On `roma.serveos.localhost:3000`: cart → checkout; ASAP preselected while open; Schedule shows Today/Tomorrow pills with 30-min times inside 10:00–23:00; pick a slot and place → tracking page; return to checkout → name/phone/address prefilled; set an area with a high minimum in the dashboard and confirm the shortfall warning disables submit; craft a URL with the wrong `?branch=` and confirm the mismatch card appears.

- [ ] **Step 6: Commit**

```bash
git add src/app/checkout/page.tsx src/app/checkout/CheckoutForm.tsx
git commit -m "feat(checkout): branded checkout with scheduling, branch guard, prefill, min-order pre-check"
```

---

### Task 10: Order tracking rebuild — branded timeline, receipt, customer cancel

**Files:**
- Modify: `src/app/order/[token]/page.tsx` (full rewrite)
- Modify: `src/app/order/[token]/StatusPoller.tsx` (full rewrite — gains the timeline styling and the cancel button)

**Interfaces:**
- Consumes: `cancelOrderByToken` endpoint `POST /api/orders/[token]/cancel` (Task 4); `formatMoney`, `formatDayTime` (Task 1); `listBranches`, `listDeliveryAreas` from `@/server/branches/service`; AlertDialog primitives from `src/components/ui/alert-dialog.tsx` (`AlertDialog`, `AlertDialogTrigger`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogCancel`, `AlertDialogAction`).
- Produces: `StatusPoller({ token, slug, initialStatus, steps, terminal, cancellable }: { token: string; slug: string; initialStatus: string; steps: string[]; terminal: string[]; cancellable: boolean })` — `cancellable` gates whether the cancel affordance is offered at all (it self-hides once status ≠ pending).

- [ ] **Step 1: Rewrite `StatusPoller.tsx`**

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";

export function StatusPoller({
  token, slug, initialStatus, steps, terminal, cancellable,
}: {
  token: string;
  slug: string;
  initialStatus: string;
  steps: string[];
  terminal: string[];
  cancellable: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const terminalRef = useRef(terminal);

  useEffect(() => {
    if (terminalRef.current.includes(status)) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${token}/status?slug=${encodeURIComponent(slug)}`);
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status);
          if (terminalRef.current.includes(data.status)) clearInterval(id);
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(id);
  }, [token, slug, status]);

  async function cancel() {
    setCancelError(null);
    try {
      const res = await fetch(`/api/orders/${token}/cancel?slug=${encodeURIComponent(slug)}`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setStatus(data.status);
      } else if (data.code === "invalid_transition") {
        setCancelError("The restaurant has already confirmed this order — contact them directly to change it.");
        // re-sync to the true status
        const s = await fetch(`/api/orders/${token}/status?slug=${encodeURIComponent(slug)}`);
        if (s.ok) setStatus((await s.json()).status);
      } else {
        setCancelError(data.error ?? "Couldn't cancel the order.");
      }
    } catch {
      setCancelError("Network error — please try again.");
    }
  }

  const label = (s: string) => s.replace(/_/g, " ");
  const currentIdx = steps.indexOf(status);
  const failed = status === "cancelled" || status === "rejected";

  return (
    <div className="mt-6">
      {failed ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 font-sans font-semibold capitalize text-destructive">
          {label(status)}
        </div>
      ) : (
        <ol className="space-y-0">
          {steps.map((s, i) => (
            <li key={s} className="flex items-start gap-3">
              <span className="flex flex-col items-center">
                <span
                  className={`mt-0.5 size-3.5 rounded-full border-2 ${
                    i < currentIdx
                      ? "border-primary bg-primary"
                      : i === currentIdx
                        ? "border-primary bg-background"
                        : "border-border bg-background"
                  }`}
                />
                {i < steps.length - 1 && <span className={`h-5 w-0.5 ${i < currentIdx ? "bg-primary" : "bg-border"}`} />}
              </span>
              <span
                className={`text-sm capitalize ${
                  i === currentIdx ? "font-sans font-bold text-ink" : i < currentIdx ? "text-ink" : "text-muted-foreground"
                }`}
              >
                {label(s)}
              </span>
            </li>
          ))}
        </ol>
      )}

      {cancellable && status === "pending" && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              className="mt-4 rounded-full border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/5"
            >
              Cancel order
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
              <AlertDialogDescription>
                This can't be undone. You can only cancel while the restaurant hasn't confirmed yet.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep order</AlertDialogCancel>
              <AlertDialogAction onClick={cancel}>Cancel order</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {cancelError && <p className="mt-2 text-sm text-destructive">{cancelError}</p>}
    </div>
  );
}
```

(If `AlertDialogAction`'s existing styling clashes, check how `src/components/dashboard/ConfirmActionButton.tsx` composes these primitives and mirror it.)

- [ ] **Step 2: Rewrite `src/app/order/[token]/page.tsx`**

```tsx
import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";
import { getOrderByToken } from "@/server/ordering/service";
import { getWhatsappNumber } from "@/server/tenancy/settings";
import { listBranches, listDeliveryAreas } from "@/server/branches/service";
import { buildOrderWhatsappMessage, whatsappChatLink } from "@/lib/whatsapp";
import { formatMoney } from "@/lib/money";
import { formatDayTime } from "@/lib/datetime";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { StatusPoller } from "./StatusPoller";

const STEPS_DELIVERY = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed"];
const STEPS_PICKUP = ["pending", "confirmed", "preparing", "ready", "completed"];

export default async function OrderStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const slug = h.get("x-tenant-slug");
  if (!slug) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState title="Not found" />
      </main>
    );
  }

  const tenant = await getTenantBySlug(slug);
  const order = tenant ? await getOrderByToken(tenant.id, token) : null;
  if (!tenant || !order) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState title="Order not found" />
      </main>
    );
  }

  const [whatsappNumber, branches] = await Promise.all([
    getWhatsappNumber(tenant.id),
    listBranches(tenant.id),
  ]);
  const branch = branches.find((b) => b.id === order.branchId) ?? null;
  const areas = order.fulfillmentType === "delivery" && order.deliveryAreaId
    ? await listDeliveryAreas(tenant.id, order.branchId)
    : [];
  const eta = areas.find((a) => a.id === order.deliveryAreaId)?.etaMinutes ?? null;
  const steps = order.fulfillmentType === "delivery" ? STEPS_DELIVERY : STEPS_PICKUP;
  const currency = tenant.currency;

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-md">
        <div className="eyebrow text-muted-foreground">{tenant.name}</div>
        <h1 className="mt-1 font-display text-2xl font-extrabold text-ink">Order #{order.orderNumber}</h1>
        <p className="text-sm text-muted-foreground">
          Placed {formatDayTime(order.placedAt, tenant.timezone)}
        </p>

        {order.scheduledFor && (
          <div className="mt-3 rounded-xl bg-primary/10 px-4 py-2.5 text-sm font-semibold text-ink">
            Scheduled for {formatDayTime(order.scheduledFor, tenant.timezone)}
          </div>
        )}

        <StatusPoller
          token={token}
          slug={slug}
          initialStatus={order.status}
          steps={steps}
          terminal={["completed", "rejected", "cancelled"]}
          cancellable={order.status === "pending"}
        />

        <section className="mt-6 rounded-xl border border-border bg-card p-4">
          <div className="eyebrow text-muted-foreground">Receipt</div>
          <div className="mt-2 space-y-2">
            {order.items.map((it) => (
              <div key={it.id} className="flex justify-between gap-3 text-sm">
                <div>
                  <div className="text-ink">{it.quantity}× {it.nameEn}</div>
                  {it.selectedModifiers.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {it.selectedModifiers.map((m) => m.optionNameEn).join(", ")}
                    </div>
                  )}
                </div>
                <span className="font-mono">{formatMoney(Number(it.lineTotal), currency)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1 border-t border-border pt-2 text-sm text-muted-foreground">
            <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{formatMoney(Number(order.subtotal), currency)}</span></div>
            <div className="flex justify-between"><span>VAT {Number(order.vatRateSnapshot)}%</span><span className="font-mono">{formatMoney(Number(order.vatAmount), currency)}</span></div>
            {order.fulfillmentType === "delivery" && (
              <div className="flex justify-between"><span>Delivery</span><span className="font-mono">{formatMoney(Number(order.deliveryFee), currency)}</span></div>
            )}
            <div className="flex justify-between font-display font-bold text-ink">
              <span>Total</span><span className="font-mono">{formatMoney(Number(order.total), currency)}</span>
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-border bg-card p-4 text-sm">
          <div className="eyebrow text-muted-foreground">
            {order.fulfillmentType === "delivery" ? "Delivery" : "Pickup"}
          </div>
          {order.fulfillmentType === "delivery" ? (
            <p className="mt-1 text-ink">
              {order.deliveryAreaNameSnapshot}
              {eta ? ` · ~${eta} min` : ""}
              {order.deliveryAddressText && <><br /><span className="text-muted-foreground">{order.deliveryAddressText}</span></>}
            </p>
          ) : (
            <p className="mt-1 text-ink">
              {branch?.name ?? "Branch"}
              {branch?.address && <><br /><span className="text-muted-foreground">{branch.address}</span></>}
            </p>
          )}
          <p className="mt-2 text-muted-foreground">Cash · {order.paymentStatus}</p>
        </section>

        {whatsappNumber && (
          <a
            href={whatsappChatLink(
              whatsappNumber,
              buildOrderWhatsappMessage({
                orderNumber: order.orderNumber,
                fulfillmentType: order.fulfillmentType,
                items: order.items.map((it) => ({ quantity: it.quantity, nameEn: it.nameEn })),
                total: Number(order.total).toFixed(2),
              }),
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block rounded-full bg-[#25D366] px-5 py-2.5 text-sm font-semibold text-white"
          >
            Send order via WhatsApp
          </a>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Place an order (ASAP + scheduled): tracking shows branded timeline, receipt with modifiers and currency, fulfillment recap (pickup shows branch address; delivery shows area + `~35 min` from the seed's Maadi area), scheduled banner when applicable. While `pending`: Cancel order → confirm → status flips to `cancelled` and the button disappears. Confirm from the dashboard first on a second order, then try cancelling from a stale tracking tab → the "already confirmed" message appears and status re-syncs.

- [ ] **Step 5: Commit**

```bash
git add "src/app/order/[token]/page.tsx" "src/app/order/[token]/StatusPoller.tsx"
git commit -m "feat(tracking): branded status timeline, full receipt, customer cancel"
```

---

### Task 11: Dashboard — surface scheduled orders

**Files:**
- Modify: `src/server/ordering/service.ts` (`OrderRow` + `toOrderRow`)
- Modify: `src/app/dashboard/orders/page.tsx` (pass timezone)
- Modify: `src/app/dashboard/orders/OrdersTable.tsx` (scheduled chip)
- Modify: `src/app/dashboard/orders/[id]/page.tsx` (scheduled line in the detail header area)

**Interfaces:**
- Consumes: `formatDayTime` (Task 1); `Order.scheduledFor` (Task 3); `getTenantById` from `@/server/tenancy`.
- Produces: `OrderRow` gains `scheduledFor: string | null` (ISO — serialization-safe for both the SSR pass and the `/api/dashboard/orders` JSON poller, which both go through `toOrderRow`); `OrdersTable` gains a `timezone: string` prop.

- [ ] **Step 1: Extend `OrderRow`**

In `src/server/ordering/service.ts` replace the `OrderRow` block:

```ts
/** The compact order shape the dashboard list (SSR + polling endpoint) renders. */
export type OrderRow = Pick<Order, "id" | "orderNumber" | "customerName" | "fulfillmentType" | "total" | "status" | "paymentStatus"> & {
  scheduledFor: string | null;
};

export function toOrderRow(o: Order): OrderRow {
  const { id, orderNumber, customerName, fulfillmentType, total, status, paymentStatus } = o;
  return {
    id, orderNumber, customerName, fulfillmentType, total, status, paymentStatus,
    scheduledFor: o.scheduledFor ? o.scheduledFor.toISOString() : null,
  };
}
```

- [ ] **Step 2: Pass the timezone from the list page**

In `src/app/dashboard/orders/page.tsx`:

```tsx
import { getTenantById } from "@/server/tenancy";
```

and inside the component:

```tsx
  const tenant = await getTenantById(tenantId);
  // …
  <OrdersTable initial={orders.map(toOrderRow)} timezone={tenant?.timezone ?? "Africa/Cairo"} />
```

- [ ] **Step 3: Scheduled chip in `OrdersTable.tsx`**

1. Props: `export function OrdersTable({ initial, timezone }: { initial: OrderRow[]; timezone: string })`.
2. Import: `import { formatDayTime } from "@/lib/datetime";` and a small local helper inside the component file:

```tsx
function ScheduledChip({ iso, timezone }: { iso: string | null; timezone: string }) {
  if (!iso) return null;
  return (
    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-ink">
      Scheduled · {formatDayTime(new Date(iso), timezone)}
    </span>
  );
}
```

3. Mobile card: directly under the fulfillment row (after the `paymentStatus` line's flex container), add:

```tsx
                  <ScheduledChip iso={r.scheduledFor} timezone={timezone} />
```

4. Desktop table: in the `Type` cell, wrap the existing content and add the chip below it:

```tsx
                    <TableCell>
                      <div className="space-y-0.5">
                        {r.fulfillmentType === "delivery"
                          ? <span className="inline-flex items-center gap-1.5 text-sm"><Bike className="size-4" strokeWidth={1.5} />Delivery</span>
                          : <span className="inline-flex items-center gap-1.5 text-sm"><ShoppingBag className="size-4" strokeWidth={1.5} />Pickup</span>}
                        <ScheduledChip iso={r.scheduledFor} timezone={timezone} />
                      </div>
                    </TableCell>
```

- [ ] **Step 4: Scheduled line on the order detail page**

In `src/app/dashboard/orders/[id]/page.tsx`, load the tenant timezone the same way as Step 2, and directly after the fulfillment line (the `Bike`/`ShoppingBag` block around line 47), add:

```tsx
              {order.scheduledFor && (
                <div className="flex items-center gap-2 text-sm font-medium text-ink">
                  <Clock className="size-4" strokeWidth={1.5} />
                  Scheduled — {formatDayTime(order.scheduledFor, tenant?.timezone ?? "Africa/Cairo")}
                </div>
              )}
```

with `Clock` added to the existing `lucide-react` import and `formatDayTime` imported from `@/lib/datetime`. Adapt placement to the file's actual structure — the requirement is: the detail page shows the scheduled time near the fulfillment info.

- [ ] **Step 5: Typecheck, build, tests**

Run: `npx tsc --noEmit && npm run build && npx vitest run src/server/ordering/`
Expected: all pass (`toOrderRow` consumers — SSR page and `/api/dashboard/orders/route.ts` — compile against the extended row).

- [ ] **Step 6: Manual verification**

Place a scheduled order on the storefront; dashboard orders list shows the "Scheduled · …" chip on that row (mobile + desktop); the detail page shows the scheduled line; ASAP orders show nothing new.

- [ ] **Step 7: Commit**

```bash
git add src/server/ordering/service.ts src/app/dashboard/orders/
git commit -m "feat(dashboard): show scheduled time on order list and detail"
```

---

### Task 12: E2E — scheduling + cancel spec, and full verification pass

**Files:**
- Create: `tests/e2e/scheduling.spec.ts`
- Modify: `tests/e2e/ordering.spec.ts` (only if Step 1's run shows drift)

- [ ] **Step 1: Run the existing suites against the finished UI**

Run: `npx playwright test tests/e2e/ordering.spec.ts tests/e2e/menu.spec.ts tests/e2e/responsive.spec.ts`
Expected: PASS. If `ordering.spec.ts` fails on a renamed control, fix the spec to target the new roles/names (the flow itself is unchanged: card → sheet → `Add —` → `View cart` → `Checkout`).

- [ ] **Step 2: Write `tests/e2e/scheduling.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

// Requires the roma seed (npm run db:seed): one branch, hours 10:00–23:00
// daily, ≥1 published product, and roma.serveos.localhost → 127.0.0.1.

test("customer can schedule an order and cancel it while pending", async ({ page }) => {
  await page.goto("http://roma.serveos.localhost:3000/");

  // Add something to the cart via the product sheet.
  await page.getByRole("button", { name: /Configure/ }).first().click();
  await page.getByRole("button", { name: /Add —/ }).click();
  await page.getByRole("button", { name: /View cart/ }).click();
  await page.getByRole("link", { name: /Checkout/ }).click();

  // Switch to a scheduled time (first available slot pill).
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.locator("button.font-mono").first().click();

  // Pickup avoids area/address requirements.
  await page.getByRole("button", { name: "Pickup" }).click();
  await page.getByPlaceholder("Name").fill("E2E Scheduler");
  await page.getByPlaceholder("Phone").fill("01000000000");
  await page.getByRole("button", { name: /Place order/ }).click();

  // Tracking page: scheduled banner + pending timeline + cancel.
  await expect(page.getByText(/Scheduled for/)).toBeVisible();
  await expect(page.getByText("pending", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Cancel order" }).click();
  await page.getByRole("button", { name: "Cancel order" }).last().click(); // dialog action
  await expect(page.getByText(/cancelled/i)).toBeVisible();
});
```

Run: `npx playwright test tests/e2e/scheduling.spec.ts`
Expected: PASS. If the slot-pill locator is brittle, add `data-testid="slot"` to the slot buttons in `CheckoutForm.tsx` and target `page.getByTestId("slot").first()` — prefer the testid fix over a looser regex.

**Timing caveat:** if run between 22:30 and 23:00 tenant-local, today has no slots and the picker auto-shows Tomorrow — the spec still passes because it takes the first available pill.

- [ ] **Step 3: Full verification**

Run, in order, expecting all green:

```bash
npm run test          # full Vitest suite against the serveos_test DB
npm run build         # type-safe production build
npm run test:e2e      # full Playwright suite
```

- [ ] **Step 4: Manual pass on the live storefront**

Against `roma.serveos.tech` (or local seed): one continuous journey — menu shows open-state banner + footer; add duplicate items (merged); drawer steppers; checkout with prefill remembered from a previous order; schedule a slot; tracking shows scheduled banner, receipt, ETA; cancel while pending; recent-order strip on returning to the menu; dashboard shows the scheduled chip. Verify all amounts read `EGP …`.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/
git commit -m "test(e2e): scheduling + customer-cancel flow"
```





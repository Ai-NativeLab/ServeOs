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

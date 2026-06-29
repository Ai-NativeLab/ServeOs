import { describe, it, expect } from "vitest";
import { isBranchOrderable } from "./orderability";
import type { Branch } from "./schema";

function branch(overrides: Partial<Branch>): Branch {
  return {
    id: "b", tenantId: "t", name: "B", address: null, phone: null,
    isActive: true, acceptingOrders: true, openingHours: [],
    sortOrder: 0, createdAt: new Date(),
    ...overrides,
  } as Branch;
}

// 2026-06-16 is a Tuesday (getDay() === 2).
const tue14 = new Date(2026, 5, 16, 14, 30);
const tue02 = new Date(2026, 5, 16, 2, 0);

describe("isBranchOrderable", () => {
  it("false when acceptingOrders is off", () => {
    expect(isBranchOrderable(branch({ acceptingOrders: false }), tue14)).toBe(false);
  });
  it("false when the branch is inactive (soft-deleted)", () => {
    expect(isBranchOrderable(branch({ isActive: false }), tue14)).toBe(false);
  });
  it("true when openingHours empty (no schedule) and toggle on", () => {
    expect(isBranchOrderable(branch({ openingHours: [] }), tue14)).toBe(true);
  });
  it("within a normal same-day window", () => {
    const hours = [{ day: 2, open: "10:00", close: "23:00", closed: false }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue14)).toBe(true);
  });
  it("outside a normal same-day window", () => {
    const hours = [{ day: 2, open: "10:00", close: "13:00", closed: false }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue14)).toBe(false);
  });
  it("closed flag wins", () => {
    const hours = [{ day: 2, open: "10:00", close: "23:00", closed: true }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue14)).toBe(false);
  });
  it("crosses midnight: open at 02:00 when window is 18:00-04:00", () => {
    const hours = [{ day: 2, open: "18:00", close: "04:00", closed: false }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue02)).toBe(true);
  });
  it("no entry for today's weekday → closed", () => {
    const hours = [{ day: 5, open: "10:00", close: "23:00", closed: false }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue14)).toBe(false);
  });
  it("yesterday's wrap tail keeps it open even when today is marked closed", () => {
    // Monday (day 1) 18:00 → 02:00 wrap; Tuesday (day 2) explicitly closed.
    const hours = [
      { day: 1, open: "18:00", close: "02:00", closed: false },
      { day: 2, open: "00:00", close: "00:00", closed: true },
    ];
    const tue01 = new Date(2026, 5, 16, 1, 0);
    expect(isBranchOrderable(branch({ openingHours: hours }), tue01)).toBe(true); // Tue 01:00 is in Mon's tail (< 02:00)
    expect(isBranchOrderable(branch({ openingHours: hours }), tue02)).toBe(false); // 02:00 is the exclusive close
  });
});

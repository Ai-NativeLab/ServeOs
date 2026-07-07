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

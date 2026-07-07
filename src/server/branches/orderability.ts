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

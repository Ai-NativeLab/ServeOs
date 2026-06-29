import type { Branch } from "./schema";

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Whether a branch can take an order at `now`. Uses the wall-clock fields of
 * `now` (getDay/getHours/getMinutes). Tenant-timezone normalisation of `now` is
 * the caller's responsibility; v1 uses server-local time (documented limitation).
 */
export function isBranchOrderable(branch: Branch, now: Date): boolean {
  if (!branch.isActive) return false; // soft-deleted / decommissioned branch
  if (!branch.acceptingOrders) return false;
  const hours = branch.openingHours ?? [];
  if (hours.length === 0) return true; // no schedule configured → open

  const cur = now.getHours() * 60 + now.getMinutes();

  // Today's window: a normal same-day range, or a range that wraps past midnight.
  const today = hours.find((h) => h.day === now.getDay());
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
  const yesterday = hours.find((h) => h.day === (now.getDay() + 6) % 7);
  if (yesterday && !yesterday.closed) {
    const yOpen = toMinutes(yesterday.open);
    const yClose = toMinutes(yesterday.close);
    if (yClose < yOpen && cur < yClose) return true;
  }

  return false;
}

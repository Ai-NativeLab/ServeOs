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
  if (!branch.acceptingOrders) return false;
  const hours = branch.openingHours ?? [];
  if (hours.length === 0) return true; // no schedule configured → open

  const entry = hours.find((h) => h.day === now.getDay());
  if (!entry || entry.closed) return false;

  const cur = now.getHours() * 60 + now.getMinutes();
  const open = toMinutes(entry.open);
  const close = toMinutes(entry.close);

  if (open === close) return true; // 24h
  if (close > open) return cur >= open && cur < close; // same-day window
  return cur >= open || cur < close; // crosses midnight
}

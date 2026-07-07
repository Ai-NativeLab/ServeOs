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

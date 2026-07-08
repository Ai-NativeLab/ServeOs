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

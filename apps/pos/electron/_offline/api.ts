import type { AuthUser } from "./store";
import type { CatalogSnapshot, PosApiClient, SyncEvent, SyncResult } from "./sync";

/**
 * The engine treats `isNetwork` as "try again later, nobody needs to be told"
 * and everything else as "the server has an opinion about this request". A
 * 5xx and a timeout belong on the first side: the till is not at fault and no
 * event may be marked failed because of one.
 */
function networkError(e: unknown, fallback: string): Error & { isNetwork: true } {
  const err = e instanceof Error ? e : new Error(fallback);
  return Object.assign(err, { isNetwork: true as const });
}

function serverError(message: string): Error & { isNetwork: false } {
  return Object.assign(new Error(message), { isNetwork: false as const });
}

/** Long enough for a slow café uplink, short enough that a hung socket can
 *  never stall the sale the cashier is standing in front of. */
const TIMEOUT_MS = 15_000;

export type TokenSource = {
  deviceToken(): string | null;
  cashierToken(): string | null;
};

export function createApiClient(baseUrl: string, tokens: TokenSource): PosApiClient {
  const base = baseUrl.replace(/\/$/, "");

  async function request(path: string, init: RequestInit & { cashier?: boolean } = {}): Promise<unknown> {
    const { cashier, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("Authorization", `Bearer ${tokens.deviceToken() ?? ""}`);
    // Only the roster pull is cashier-gated. sync/events is device-authenticated
    // by design (sync-ingest.ts): no live cashier token can survive the outage
    // that produced the batch, so sending one would be meaningless at best.
    if (cashier) {
      const token = tokens.cashierToken();
      if (token) headers.set("X-POS-Cashier", token);
    }
    if (rest.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { ...rest, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw networkError(e, "network unreachable");
    }
    if (res.status >= 500) throw networkError(new Error(`Server error: ${res.status}`), "server error");
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      throw serverError(`HTTP ${res.status}: ${body?.error ?? res.statusText}`);
    }
    return res.json();
  }

  return {
    async ping() {
      await request("/api/pos/v1/ping");
    },

    async getCatalog(): Promise<CatalogSnapshot> {
      return (await request("/api/pos/v1/catalog")) as CatalogSnapshot;
    },

    async getAuthRoster(): Promise<{ users: AuthUser[]; syncedAt: string }> {
      return (await request("/api/pos/v1/sync/auth", { cashier: true })) as { users: AuthUser[]; syncedAt: string };
    },

    async postEvents(events: SyncEvent[]): Promise<SyncResult[]> {
      const data = (await request("/api/pos/v1/sync/events", {
        method: "POST",
        body: JSON.stringify({ events }),
      })) as { results: SyncResult[] };
      return data.results;
    },
  };
}

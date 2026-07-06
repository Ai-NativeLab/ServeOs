import type { PosApiClient } from "./sync";

interface NetworkError extends Error {
  isNetwork?: boolean;
}

function withNetworkFlag(e: unknown): Error & { isNetwork: boolean } {
  const err = e as Error & { isNetwork?: boolean };
  if (err instanceof TypeError || err instanceof Error && /fetch|network|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(err.message)) {
    err.isNetwork = true;
  } else {
    err.isNetwork = false;
  }
  return err as Error & { isNetwork: boolean };
}

export function createApiClient(baseUrl: string, getToken: () => string | null): PosApiClient {
  const base = baseUrl.replace(/\/$/, "");

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const token = getToken();
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { ...init, headers });
    } catch (e) {
      throw withNetworkFlag(e);
    }
    if (res.status >= 500) {
      const err = new Error(`Server error: ${res.status}`) as Error & { isNetwork: boolean };
      err.isNetwork = true;
      throw err;
    }
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
      const err = new Error(`HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`) as Error & { isNetwork: boolean };
      err.isNetwork = false;
      throw err;
    }
    return res.json();
  }

  return {
    async getCatalog() {
      const data = (await request("/api/pos/v1/catalog", { method: "GET" })) as {
        menu: unknown;
        syncedAt: string;
      };
      return data;
    },
    async postOrder(body) {
      const data = (await request("/api/pos/v1/orders", {
        method: "POST",
        body: JSON.stringify(body),
      })) as { orderId: string; orderNumber: string };
      return data;
    },
  };
}

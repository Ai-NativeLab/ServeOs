import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `electron` only exists inside an Electron process, so the runtime itself is
// the one unavoidable mock here. Everything else is real: real fs, real JSON,
// real PosMain. safeStorage reports encryption unavailable so the device file
// round-trips as plaintext and the test can assert on what was actually stored.
const hoisted = vi.hoisted(() => ({ userDataDir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => hoisted.userDataDir },
  safeStorage: { isEncryptionAvailable: () => false },
}));

// The offline store's better-sqlite3 binding is a NATIVE module: importing the
// real _offline/db here would need a compiled binary in every environment that
// runs these tests. Only openDb is faked, simulating exactly the surface
// PosMain touches at boot — local_state get/set and the event-log MAX(seq) —
// keyed off the SQL so the statements stay authoritative in Store. The store
// map lives in shared hoisted state and MUST be reset between tests
// (dbMock.reset() in beforeEach) or values leak across cases.
const dbMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    reset: () => store.clear(),
  };
});
vi.mock("./_offline/db", () => ({
  openDb: () => ({
    pragma: () => {},
    exec: () => {},
    prepare: (sql: string) => ({
      // Store.setLocalState / Store.getLocalState persist key-value pairs.
      run: (...args: unknown[]) => {
        if (sql.includes("INSERT OR REPLACE INTO local_state")) {
          dbMock.store.set(args[0] as string, args[1] as string);
        }
        return { changes: 1 };
      },
      get: (...args: unknown[]) => {
        if (sql.includes("MAX(seq)")) return { maxSeq: 0 };
        if (sql.includes("SELECT value FROM local_state")) {
          const val = dbMock.store.get(args[0] as string);
          return val ? { value: val } : undefined;
        }
        return undefined;
      },
      all: () => [],
    }),
    transaction: <T>(fn: () => T): () => T => fn,
  }),
  noCipher: {
    isAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

// Static import is safe: vitest hoists the vi.mock factory above it, and
// PosMain only reaches for electron inside its constructor.
import { PosMain } from "./pos-main";

const BACKEND_A = "https://backend-a.test";
const BACKEND_B = "https://backend-b.test";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Queues one response per call, in order. */
function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const res of responses) fn.mockResolvedValueOnce(res);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

async function pairedPos(baseUrl: string) {
  process.env.POS_API_URL = baseUrl;
  const pos = new PosMain();
  stubFetch(
    jsonResponse(200, {
      deviceToken: "device-token-for-" + baseUrl,
      tenantId: "tenant-1",
      branchId: "branch-1",
      branchName: "Main Branch",
    }),
  );
  await pos.pair("ABCD1234");
  return pos;
}

beforeEach(() => {
  hoisted.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-main-test-"));
  dbMock.reset();
});

afterEach(() => {
  fs.rmSync(hoisted.userDataDir, { recursive: true, force: true });
  delete process.env.POS_API_URL;
  delete process.env.VITE_DEV_SERVER_URL;
  vi.restoreAllMocks();
});

describe("device rejected by the backend", () => {
  it("unpairs and says so when cashier sign-in is refused", async () => {
    const pos = await pairedPos(BACKEND_A);
    expect(pos.isPaired()).toBe(true);

    stubFetch(jsonResponse(401, { error: "Unauthorized" }));

    await expect(pos.signInCashier("cashier@example.com", "pw123456")).rejects.toThrow(
      "Device unpaired — please pair again",
    );
    expect(pos.isPaired()).toBe(false);
  });

  it("keeps the device paired when it is only the cashier's password that is wrong", async () => {
    const pos = await pairedPos(BACKEND_A);

    // A bad password is also a 401, but carries PosCashierError's message.
    // Unpairing here would make every typo cost a manager re-pairing the till.
    stubFetch(jsonResponse(401, { error: "Invalid cashier credentials" }));

    await expect(pos.signInCashier("cashier@example.com", "wrong")).rejects.toThrow(
      "Invalid cashier credentials",
    );
    expect(pos.isPaired()).toBe(true);
  });
});

describe("suspended tenant (#164 / #187 C3)", () => {
  // The server-side sweep answers 403 {code:"tenant_blocked"} for every POS
  // route once a tenant is suspended. These pin the client half of the fix:
  // suspension is reversible, so it must never destroy the pairing or be
  // mistaken for a permission problem a manager override could solve.

  it("keeps the device paired when sign-in is refused because the tenant is blocked", async () => {
    const pos = await pairedPos(BACKEND_A);

    stubFetch(
      jsonResponse(403, {
        error: "This store is suspended — ask the platform team to reactivate it before using the till",
        code: "tenant_blocked",
      }),
    );

    await expect(pos.signInCashier("cashier@example.com", "pw123456")).rejects.toThrow(
      /suspended/,
    );
    expect(pos.isPaired()).toBe(true);
  });

  it("does not ask for a manager override when a refund hits tenant_blocked", async () => {
    const pos = await pairedPos(BACKEND_A);
    signInCashierDirectly(pos);

    stubFetch(
      jsonResponse(403, {
        error: "This store is suspended — ask the platform team to reactivate it before using the till",
        code: "tenant_blocked",
      }),
    );

    const err = await pos
      .refundSale({
        orderId: "o1", clientRefundId: "r1", kind: "full", reasonCode: "other",
        lines: [], payments: [{ method: "cash", amount: 10 }],
      })
      .then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.message).toMatch(/suspended/);
    expect(err?.code).toBeUndefined();
    expect(pos.isPaired()).toBe(true);
  });

  it("still asks for a manager override on an ordinary refund 403", async () => {
    const pos = await pairedPos(BACKEND_A);
    signInCashierDirectly(pos);

    stubFetch(jsonResponse(403, { error: "Missing permission: pos:refund" }));

    const err = await pos
      .refundSale({
        orderId: "o1", clientRefundId: "r1", kind: "full", reasonCode: "other",
        lines: [], payments: [{ method: "cash", amount: 10 }],
      })
      .then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.code).toBe("NEEDS_MANAGER");
  });
});

/** Skips the login round-trip (roster tick + shift adoption make its fetch
 *  sequence brittle to stub) and installs the session state a successful
 *  signInCashier would have left behind. */
function signInCashierDirectly(pos: PosMain): void {
  (pos as unknown as { cashier: { token: string; userId: string; name: string; permissions: string[] } }).cashier = {
    token: "cashier-token",
    userId: "user-1",
    name: "Cashier",
    permissions: ["pos:sell"],
  };
}

describe("device file is scoped to the backend it was paired against", () => {
  it("ignores a device paired against a different backend", async () => {
    await pairedPos(BACKEND_A);

    // Same machine, same userData directory — dev and the packaged build share
    // one, so a localhost pairing must not become production's credentials.
    process.env.POS_API_URL = BACKEND_B;

    expect(new PosMain().isPaired()).toBe(false);
  });

  it("ignores a device file written before the backend was recorded", () => {
    // Exactly the shape every POS wrote before this change: a token, no idea
    // which backend minted it. Trusting it is what produced 401 Unauthorized on
    // the first packaged build, so an upgrade must start unpaired instead.
    fs.writeFileSync(
      path.join(hoisted.userDataDir, "pos-device.json"),
      JSON.stringify({
        token: "token-from-a-dev-pairing",
        tenantId: "tenant-1",
        branchId: "branch-1",
        branchName: "Main Branch",
      }),
    );
    process.env.POS_API_URL = BACKEND_A;

    expect(new PosMain().isPaired()).toBe(false);
  });

  it("still trusts the device when the backend is unchanged", async () => {
    await pairedPos(BACKEND_A);

    process.env.POS_API_URL = BACKEND_A;

    expect(new PosMain().isPaired()).toBe(true);
  });

  // #163 AC6: a till paired against an explicit host must not silently carry
  // that pairing into a dev session whose resolved base URL differs — the
  // resolved value participates in the scoping exactly like POS_API_URL does.
  it("ignores a pairing when dev resolution changes the effective base URL", async () => {
    await pairedPos(BACKEND_A);

    delete process.env.POS_API_URL;
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5173"; // resolves http://localhost:3000

    expect(new PosMain().isPaired()).toBe(false);
  });
});

describe("base URL resolution (Issue #163)", () => {
  it("resolves to localhost:3000 lazily when VITE_DEV_SERVER_URL is set after module load", () => {
    delete process.env.POS_API_URL;
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
    const pos = new PosMain();
    expect(pos.getBaseUrl()).toBe("http://localhost:3000");
  });

  it("defaults to production host when neither POS_API_URL nor VITE_DEV_SERVER_URL is set", () => {
    delete process.env.POS_API_URL;
    delete process.env.VITE_DEV_SERVER_URL;
    const pos = new PosMain();
    expect(pos.getBaseUrl()).toBe("https://app.serveos.tech");
  });

  it("prioritizes POS_API_URL over VITE_DEV_SERVER_URL and production fallback", () => {
    process.env.POS_API_URL = "http://custom-api.test";
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
    const pos = new PosMain();
    expect(pos.getBaseUrl()).toBe("http://custom-api.test");
  });

  it("logs the resolved base URL at startup", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.POS_API_URL = "http://logged-backend.test";
    new PosMain();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("http://logged-backend.test"));
  });
});

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
});

describe("which backend a fresh till targets", () => {
  const pairBody = {
    deviceToken: "device-token",
    tenantId: "tenant-1",
    branchId: "branch-1",
    branchName: "Main Branch",
  };

  it("targets the local backend when the vite dev server is running", async () => {
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";

    const pos = new PosMain();
    const fetchFn = stubFetch(jsonResponse(200, pairBody));
    await pos.pair("ABCD1234");

    expect(fetchFn).toHaveBeenCalledWith("http://localhost:3000/api/pos/v1/pair", expect.anything());
  });

  it("targets production when launched outside vite — packaged build or built output run from source", async () => {
    // No POS_API_URL, no vite: this is both the packaged app and an
    // unpackaged `electron .` over the build output. Both must default to
    // production, or a till paired from source drops its pairing on the
    // next launch (load() only trusts a device whose baseUrl matches).
    const pos = new PosMain();
    const fetchFn = stubFetch(jsonResponse(200, pairBody));
    await pos.pair("ABCD1234");

    expect(fetchFn).toHaveBeenCalledWith("https://app.serveos.tech/api/pos/v1/pair", expect.anything());
  });
});

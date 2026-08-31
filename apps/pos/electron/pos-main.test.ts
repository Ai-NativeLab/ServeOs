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

/**
 * The one place the fiscal read's WIRE is checked. `saleFiscalStatus` never
 * throws by design — a non-2xx, an unreachable backend and the endpoint's own
 * literal `null` body all answer `null`, because the receipt does the same thing
 * with all of them — so a typo in the path or a missing auth header would not
 * surface as an error anywhere. It would present as a receipt that quietly never
 * grows a fiscal footer, on every EG sale, forever. This pin is the only thing
 * that would catch it.
 */
describe("saleFiscalStatus", () => {
  async function signedInPos(baseUrl: string) {
    const pos = await pairedPos(baseUrl);
    // One success-path stub, for the login itself. Everything sign-in fires
    // afterwards — the engine's connectivity probe, the drawer adoption — gets
    // no queued response and swallows its own failure; "offline" is a perfectly
    // good state to read a fiscal record from a stubbed fetch in.
    stubFetch(
      jsonResponse(200, { cashierToken: "cashier-token", userId: "user-1", name: "Nadia", permissions: ["pos:sell"] }),
    );
    await pos.signInCashier("cashier@example.com", "pw123456");
    // The probe above is fired with `void`, not awaited: let it settle before
    // the fetch mock is swapped, so it cannot land on the next test's stub.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return pos;
  }

  it("calls the sale's fiscal endpoint with both the device and cashier tokens", async () => {
    const pos = await signedInPos(BACKEND_A);
    const body = {
      status: "pending",
      etaUuid: "uuid-1",
      qrPayload: "payload-1",
      qrImageDataUrl: "data:image/png;base64,iVBORw0KGgo",
    };
    const fetchMock = stubFetch(jsonResponse(200, body));

    await expect(pos.saleFiscalStatus("order-9")).resolves.toEqual(body);

    const call = fetchMock.mock.calls.find((args) => String(args[0]).endsWith("/fiscal"));
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    // `[id]`, not `[orderId]`: Next refuses two slug names at one dynamic
    // position, so the fiscal route shares its siblings' segment name.
    expect(url).toBe(`${BACKEND_A}/api/pos/v1/sales/order-9/fiscal`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer device-token-for-${BACKEND_A}`);
    expect(headers["X-POS-Cashier"]).toBe("cashier-token");
  });

  it("asks nothing at all when no cashier is signed in", async () => {
    // The route is `pos:sell`-gated, so a device token alone cannot read it —
    // and a signed-out till has no receipt on screen to decorate anyway.
    const pos = await pairedPos(BACKEND_A);
    const fetchMock = stubFetch();

    await expect(pos.saleFiscalStatus("order-9")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

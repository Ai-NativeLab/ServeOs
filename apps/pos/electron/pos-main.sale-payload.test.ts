import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// Split out of pos-main.test.ts, which fakes `./_offline/db` so it can run
// without the native better-sqlite3 binding. These tests cannot: what they pin
// is the event body `recordSale` actually WRITES to the SQLite log, so the
// offline store here is the real one, in a throwaway userData directory. Only
// the Electron runtime is mocked; safeStorage reports encryption unavailable.
const hoisted = vi.hoisted(() => ({ userDataDir: "" }));
vi.mock("electron", () => ({
  app: {
    getPath: () => hoisted.userDataDir,
    isPackaged: true,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

// Static import is safe: vitest hoists the vi.mock factory above it, and
// PosMain only reaches for electron inside its constructor.
import { PosMain } from "./pos-main";

const BACKEND_A = "https://backend-a.test";

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

async function signedInPos(baseUrl: string) {
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
  // One success-path stub, for the login itself. Everything sign-in fires
  // afterwards — the engine's connectivity probe, the drawer adoption — gets
  // no queued response and swallows its own failure.
  stubFetch(
    jsonResponse(200, { cashierToken: "cashier-token", userId: "user-1", name: "Nadia", permissions: ["pos:sell"] }),
  );
  await pos.signInCashier("cashier@example.com", "pw123456");
  // The probe above is fired with `void`, not awaited: let it settle before
  // the fetch mock is swapped, so it cannot land on the next test's stub.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return pos;
}

beforeEach(() => {
  hoisted.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-main-sale-test-"));
});

afterEach(() => {
  fs.rmSync(hoisted.userDataDir, { recursive: true, force: true });
  delete process.env.POS_API_URL;
  vi.restoreAllMocks();
});

describe("recordSale — the appended sale.recorded payload", () => {
  /**
   * The event log as it was actually written to disk.
   *
   * Read straight out of the SQLite file rather than through `PosMain`, which
   * exposes no reader for it — and that is the point. THIS IS THE ONE HOP
   * NOTHING ELSE CAN COVER: `recordSale` builds the event body field by field,
   * so a payload field it does not NAME is discarded here, before the queue,
   * before the wire, before any server test could see it. A sale rung during an
   * outage is replayed from exactly these bytes and nothing else.
   */
  function appendedSales(): Record<string, unknown>[] {
    const db = new Database(path.join(hoisted.userDataDir, "pos.db"), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT payload FROM local_events WHERE type = 'sale.recorded' ORDER BY seq ASC")
        .all() as { payload: string }[];
      return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    } finally {
      db.close();
    }
  }

  const CARD_SALE = {
    lines: [{ productId: "prod-1", quantity: 1, selectedOptionIds: [] }],
    expectedTotal: 100,
    // Card, not cash: a cash tender needs an open drawer, and this test is about
    // the payload rather than about drawer rules.
    payments: [{ clientPaymentId: "pay-1", method: "card" as const, amount: 100 }],
  };

  /** A cached menu, so `snapshotLine` can price the line — the till refuses to
   *  ring an item it cannot resolve, which is a different rule than this one. */
  async function withCachedMenu(pos: Awaited<ReturnType<typeof signedInPos>>) {
    stubFetch(jsonResponse(200, {
      menu: {
        categories: [{
          id: "cat-1", nameEn: "All", nameAr: "الكل",
          products: [{
            id: "prod-1", nameEn: "Flat white", nameAr: "فلات وايت",
            effectivePrice: 100, variants: [], modifierGroups: [],
          }],
        }],
      },
      pricing: { vatRate: 14, serviceChargeRate: 0, pricesIncludeVat: false },
      shiftPolicy: {},
      catalogVersion: 1,
      syncedAt: new Date().toISOString(),
    }));
    await pos.getMenu();
  }

  it("carries the business buyer into the event, so an outage cannot lose it", async () => {
    const pos = await signedInPos(BACKEND_A);
    await withCachedMenu(pos);
    // No further stubs: the engine never came online, so `syncNow` returns null
    // without a flush and the sale stays queued — which is precisely the offline
    // B2B case this pins.
    stubFetch();

    const buyer = {
      rin: "313717919",
      name: "Receiver Company LLC",
      address: {
        country: "EG", governate: "Cairo", regionCity: "Nasr City",
        street: "580 Clementina Key", buildingNumber: "Bldg. 0",
      },
    };
    const receipt = await pos.recordSale({ ...CARD_SALE, buyer });
    expect(receipt.synced).toBe(false);

    const [payload] = appendedSales();
    expect(payload.buyer).toEqual(buyer);
  });

  it("appends NO `buyer` key at all on an ordinary sale", async () => {
    // Not `"buyer": undefined`, not `null` — absent. The queue stores these as
    // JSON text and replays them verbatim, so an ordinary sale's recorded bytes
    // must be exactly what they were before B2B capture existed.
    const pos = await signedInPos(BACKEND_A);
    await withCachedMenu(pos);
    stubFetch();

    await pos.recordSale(CARD_SALE);

    const [payload] = appendedSales();
    expect("buyer" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("buyer");
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { money } from "@/server/ordering/service";
import { orders } from "@/server/ordering/schema";
import { GET as pingRoute } from "@/app/api/pos/v1/ping/route";
import { GET as catalogRoute } from "@/app/api/pos/v1/catalog/route";
import { GET as authRosterRoute } from "@/app/api/pos/v1/sync/auth/route";
import { POST as syncEventsRoute } from "@/app/api/pos/v1/sync/events/route";
import { posSyncEventReceipts } from "./schema";
import { cashCounts, cashMovements, posShifts } from "./shift-schema";
import { createPairingCode, redeemPairingCode, resolveDevice } from "./service";
import { seedPosContext } from "./test-helpers";
import { openDb } from "../../../apps/pos/electron/_offline/db";
import { Store, type EventRow } from "../../../apps/pos/electron/_offline/store";
import { createApiClient } from "../../../apps/pos/electron/_offline/api";
import { SyncEngine } from "../../../apps/pos/electron/_offline/sync";

/**
 * The one place the till's real HTTP client and the server's real route
 * handlers meet. Every other client test injects a `FakeApi`, and every other
 * server test calls `ingestEvents` in-process — so nothing else covers the
 * seam itself: JSON encoding, the `Authorization` header, `requirePosDevice`,
 * the envelope the engine builds, or how a `results` array maps back onto the
 * event log.
 *
 * Only the socket is stubbed. `fetch` is replaced by an adapter that turns the
 * client's own outbound `Request` into bytes and feeds those bytes to the real
 * route handler, whose real `Response` goes back to the client untouched.
 * Serialisation, headers, auth, validation, handlers, DB writes and result
 * mapping are all production code. What this therefore does NOT cover: TCP,
 * TLS, body-size limits, Next's own dispatch to these handlers (there is no
 * middleware and no rewrite over `/api/pos`, so that layer is a pass-through
 * today — a future one would be invisible here), and anything Electron's main
 * process does above `PosMain.append`: IPC, safeStorage, the GUI.
 */

const BASE_URL = "http://till.test";

const ROUTES: Record<string, (req: NextRequest) => Promise<Response>> = {
  "/api/pos/v1/ping": pingRoute,
  "/api/pos/v1/catalog": catalogRoute,
  "/api/pos/v1/sync/auth": authRosterRoute,
  "/api/pos/v1/sync/events": syncEventsRoute,
};

/** One request/response pair as it crossed the seam — headers and bodies as
 *  the server actually received them, so assertions are about the wire rather
 *  than about either side agreeing with itself. */
type WireCall = {
  path: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  request: unknown;
  status: number;
  response: unknown;
};

function installWire(): WireCall[] {
  const calls: WireCall[] = [];
  const passthrough = globalThis.fetch;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const outbound = new Request(input as RequestInfo, init);
    const path = new URL(outbound.url).pathname;
    const route = ROUTES[path];
    // Anything the server fetches for its own reasons (a realtime broadcast)
    // is not this harness's traffic.
    if (!route) return passthrough(input as RequestInfo, init);

    // The body as bytes, which is the only form a socket would have carried:
    // re-parsing them is what proves the client's encoding is what `req.json()`
    // accepts, rather than handing the handler an object the client never made.
    const raw = await outbound.arrayBuffer();
    const inbound = new NextRequest(outbound.url, {
      method: outbound.method,
      headers: outbound.headers,
      ...(raw.byteLength > 0 ? { body: raw } : {}),
    });

    const res = await route(inbound);
    calls.push({
      path,
      method: outbound.method,
      authorization: outbound.headers.get("authorization"),
      contentType: outbound.headers.get("content-type"),
      request: raw.byteLength > 0 ? JSON.parse(new TextDecoder().decode(raw)) : null,
      status: res.status,
      response: await res.clone().json().catch(() => null),
    });
    return res;
  });

  return calls;
}

type Till = {
  store: Store;
  sqlite: ReturnType<typeof openDb>;
  engine: SyncEngine;
};

function makeTill(deviceToken: () => string): Till {
  const sqlite = openDb(":memory:");
  const store = new Store(sqlite);
  const api = createApiClient(BASE_URL, { deviceToken, cashierToken: () => null });
  return { store, sqlite, engine: new SyncEngine(store, api) };
}

/** Including synced rows, which `Store` deliberately exposes no reader for. */
function allEvents(till: Till): EventRow[] {
  return till.sqlite.prepare("SELECT * FROM local_events ORDER BY seq ASC").all() as EventRow[];
}

function storedResults(till: Till): unknown[] {
  return allEvents(till).map((e) => (e.server_response ? JSON.parse(e.server_response) : null));
}

function batchesSent(calls: WireCall[]): WireCall[] {
  return calls.filter((c) => c.path === "/api/pos/v1/sync/events");
}

/** Everything a batch of these events can write, counted — a replay that
 *  applied anything a second time moves one of these. */
async function countServerRows(tenantId: string, deviceId: string): Promise<Record<string, number>> {
  const [shifts, placed, movements, counts, receipts] = await Promise.all([
    withTenant(tenantId, (tx) => tx.select().from(posShifts)),
    withTenant(tenantId, (tx) => tx.select().from(orders)),
    withTenant(tenantId, (tx) => tx.select().from(cashMovements)),
    withTenant(tenantId, (tx) => tx.select().from(cashCounts)),
    db.select().from(posSyncEventReceipts).where(eq(posSyncEventReceipts.deviceId, deviceId)),
  ]);
  return {
    shifts: shifts.length,
    orders: placed.length,
    movements: movements.length,
    counts: counts.length,
    receipts: receipts.length,
  };
}

/** A device paired through the real flow, so the token under test is one
 *  `resolveDevice` minted — not a fixture string. */
async function pairTill(tenantId: string, branchId: string, byUserId: string): Promise<{ deviceToken: string; deviceId: string }> {
  const { code } = await createPairingCode(tenantId, branchId, "wire-till", byUserId);
  const { deviceToken } = await redeemPairingCode(code);
  const device = await resolveDevice(deviceToken);
  return { deviceToken, deviceId: device!.deviceId };
}

/** Exactly the payload `PosMain.recordSale` appends: envelope fields ride
 *  inside it until `sync.ts` lifts them onto the wire. */
function salePayload(
  actorUserId: string, clientShiftId: string, productId: string, expectedTotal: number, clientOrderId: string,
): Record<string, unknown> {
  return {
    actorUserId,
    clientOrderId,
    clientShiftId,
    lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    lineSnapshots: [{
      productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
      unitPrice: 100, quantity: 1, lineTotal: 100,
    }],
    expectedTotal,
    payments: [{ clientPaymentId: `pay-${clientOrderId}`, method: "cash", amount: expectedTotal, tenderedAmount: expectedTotal }],
  };
}

// Numeric-string keys, one of them sub-unit. The full path is a JS object →
// SQLite TEXT → JSON body → jsonb → the server's cash math, and any layer that
// coerced these keys to numbers, reordered them lossily or dropped "0.25"
// would change what the drawer is said to hold.
const OPENING_DENOMS = { "100": 2, "50": 2 };                            // 300.00
const COUNT_DENOMS = { "200": 2, "100": 1, "50": 1, "5": 3, "0.25": 4 }; // 566.00
const CLOSING_DENOMS = { "200": 1, "100": 1, "20": 2, "0.5": 4 };        // 342.00

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POS sync over the wire", () => {
  it("round-trips a real offline batch from the event log into the server's tables", async () => {
    const { ctx, tenantId, branchId, productId, total, managerId } = await seedPosContext("owner");
    const { deviceToken, deviceId } = await pairTill(tenantId, branchId, managerId);
    const calls = installWire();
    const till = makeTill(() => deviceToken);
    const actorUserId = ctx.cashierUserId;
    const clientShiftId = crypto.randomUUID();

    till.store.appendEvent("shift.opened", { actorUserId, clientShiftId, openingFloat: 300, denominations: OPENING_DENOMS });
    till.store.appendEvent("sale.recorded", salePayload(actorUserId, clientShiftId, productId, total, "wire-sale-1"));
    till.store.appendEvent("cash.movement", { actorUserId, type: "pay_in", amount: 50, reasonCode: "float_top_up" });
    till.store.appendEvent("count.recorded", { actorUserId, clientShiftId, countedTotal: 566, denominations: COUNT_DENOMS });
    till.store.appendEvent("shift.closed", { actorUserId, clientShiftId, countedTotal: 342, denominations: CLOSING_DENOMS });

    // A full tick, not a bare flush: probe and catalog pull are the other two
    // device-authenticated calls the till makes, and they share the header.
    await till.engine.tick();

    expect(calls.map((c) => c.path)).toEqual([
      "/api/pos/v1/ping", "/api/pos/v1/catalog", "/api/pos/v1/sync/auth", "/api/pos/v1/sync/events",
    ]);
    expect([...new Set(calls.map((c) => c.authorization))]).toEqual([`Bearer ${deviceToken}`]);
    // The roster is cashier-gated and nobody is signed in; it must stay a
    // best-effort miss rather than failing the tick behind it.
    expect(calls[2].status).toBe(401);
    expect(till.store.getCatalog()?.catalogVersion).toEqual(expect.any(Number));

    const batch = batchesSent(calls)[0];
    expect(batch.status).toBe(200);
    expect(batch.contentType).toBe("application/json");
    const sent = batch.request as {
      events: { seq: number; type: string; actorUserId: string; occurredAt: string; payload: Record<string, unknown> }[];
    };
    expect(sent.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "shift.opened"], [2, "sale.recorded"], [3, "cash.movement"], [4, "count.recorded"], [5, "shift.closed"],
    ]);
    // Rule: actorUserId is an envelope field. A per-type validator never looks
    // for it in the payload, so leaving a copy behind would be a silent drift.
    expect(sent.events.every((e) => e.actorUserId === actorUserId)).toBe(true);
    expect(sent.events.some((e) => "actorUserId" in e.payload)).toBe(false);

    expect(till.engine.status()).toMatchObject({ state: "online", pending: 0 });
    expect(allEvents(till).map((e) => e.status)).toEqual(["synced", "synced", "synced", "synced", "synced"]);

    const [shift] = await withTenant(tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.deviceId, deviceId)));
    expect(shift).toMatchObject({
      branchId, clientShiftId, status: "closed",
      openingFloat: money(300), openedByUserId: actorUserId, closedByUserId: actorUserId,
    });

    const placed = await withTenant(tenantId, (tx) => tx.select().from(orders));
    expect(placed).toHaveLength(1);

    const [movement] = await withTenant(tenantId, (tx) =>
      tx.select().from(cashMovements).where(eq(cashMovements.shiftId, shift.id)));
    expect(movement).toMatchObject({ type: "pay_in", amount: money(50), reasonCode: "float_top_up", byUserId: actorUserId });

    const counts = await withTenant(tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.shiftId, shift.id)));
    expect(counts.map((c) => c.kind).sort()).toEqual(["closing", "mid_shift", "opening"]);

    // The Z-report's expected cash is float + this batch's cash tender + its
    // pay-in, which only holds if the sale and the movement bound to the same
    // drawer the shift events named — three separate wire payloads agreeing.
    const closing = counts.find((c) => c.kind === "closing")!;
    expect(closing.expectedTotal).toBe(money(300 + total + 50));
    expect(closing.countedTotal).toBe(money(342));
    expect(closing.variance).toBe(money(342 - (300 + total + 50)));

    // The device's receipts, in the order it claimed — this is what makes the
    // next flush's ordering check (`out_of_order`) and its replay answers work.
    const receipts = await db.select().from(posSyncEventReceipts).where(eq(posSyncEventReceipts.deviceId, deviceId));
    const bySeq = [...receipts].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    expect(bySeq.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(bySeq.map((r) => r.eventId)).toEqual(allEvents(till).map((e) => e.event_id));
    // What the till stored as the server's answer IS the row the server kept.
    expect(storedResults(till)).toEqual(bySeq.map((r) => r.resultJson));
  });

  it("carries denominations with numeric-string keys through to the server's cash math", async () => {
    const { ctx, tenantId, branchId, managerId } = await seedPosContext("owner");
    const { deviceToken, deviceId } = await pairTill(tenantId, branchId, managerId);
    const calls = installWire();
    const till = makeTill(() => deviceToken);
    const actorUserId = ctx.cashierUserId;
    const clientShiftId = crypto.randomUUID();

    till.store.appendEvent("shift.opened", { actorUserId, clientShiftId, openingFloat: 300, denominations: OPENING_DENOMS });
    till.store.appendEvent("count.recorded", { actorUserId, clientShiftId, countedTotal: 566, denominations: COUNT_DENOMS });

    await till.engine.flush();
    expect(till.engine.status()).toMatchObject({ state: "online", pending: 0 });

    // The keys as the server parsed them off the request body.
    const sent = batchesSent(calls)[0].request as { events: { payload: { denominations: Record<string, number> } }[] };
    expect(sent.events[0].payload.denominations).toEqual(OPENING_DENOMS);
    expect(sent.events[1].payload.denominations).toEqual(COUNT_DENOMS);

    const [shift] = await withTenant(tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.deviceId, deviceId)));
    const counts = await withTenant(tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.shiftId, shift.id)));

    const opening = counts.find((c) => c.kind === "opening")!;
    expect(opening.denominations).toEqual(OPENING_DENOMS);
    expect(opening.countedTotal).toBe(money(300));

    // No sales and no movements, so expected is the float alone: the count is
    // 266.00 over, which only holds if every key — "0.25" included — survived.
    const mid = counts.find((c) => c.kind === "mid_shift")!;
    expect(mid.denominations).toEqual(COUNT_DENOMS);
    expect(mid.countedTotal).toBe(money(566));
    expect(mid.expectedTotal).toBe(money(300));
    expect(mid.variance).toBe(money(266));
  });

  it("accepts the paired device's token and refuses anything else, marking nothing on a refusal", async () => {
    const { ctx, tenantId, branchId, managerId } = await seedPosContext("owner");
    const { deviceToken, deviceId } = await pairTill(tenantId, branchId, managerId);
    const calls = installWire();

    let token = "not-a-token-this-server-ever-minted";
    const till = makeTill(() => token);
    const actorUserId = ctx.cashierUserId;
    const clientShiftId = crypto.randomUUID();
    till.store.appendEvent("shift.opened", { actorUserId, clientShiftId, openingFloat: 300, denominations: OPENING_DENOMS });

    await till.engine.flush();

    expect(batchesSent(calls)[0].status).toBe(401);
    // A refusal of the batch envelope is not attributable to one event: the
    // queue must stay intact and unhalted, or an operator has to clear a halt
    // that a re-pair would have fixed on its own.
    expect(allEvents(till).map((e) => e.status)).toEqual(["pending"]);
    expect(till.engine.status()).toMatchObject({ state: "offline", pending: 1 });
    expect(till.engine.status().haltedOn).toBeUndefined();
    expect(await withTenant(tenantId, (tx) => tx.select().from(posShifts))).toHaveLength(0);

    token = deviceToken;
    await till.engine.flush();

    expect(batchesSent(calls)[1].status).toBe(200);
    expect(allEvents(till).map((e) => e.status)).toEqual(["synced"]);
    const [shift] = await withTenant(tenantId, (tx) => tx.select().from(posShifts));
    // Bound to the device the token names, not to whichever device the tenant
    // happens to own — seedPosContext paired one of its own.
    expect(shift.deviceId).toBe(deviceId);
  });

  it("halts the queue on a domain refusal and sends nothing afterwards", async () => {
    // A staff cashier holds pos:sell but not pos:discount — the gated action
    // whose offline authorizer this event is missing.
    const { ctx, tenantId, branchId, productId, total, managerId } = await seedPosContext("staff");
    const { deviceToken } = await pairTill(tenantId, branchId, managerId);
    const calls = installWire();
    const till = makeTill(() => deviceToken);
    const actorUserId = ctx.cashierUserId;
    const clientShiftId = crypto.randomUUID();

    till.store.appendEvent("shift.opened", { actorUserId, clientShiftId, openingFloat: 300, denominations: OPENING_DENOMS });
    // A real domain refusal, not a malformed envelope: a discounted sale whose
    // authorizedByUserId never made it onto the event (wire contract rule 2).
    // Note that expectedTotal cannot be used to provoke this — a replayed sale
    // is till-wins and the server deliberately does not re-litigate the total.
    till.store.appendEvent("sale.recorded", {
      ...salePayload(actorUserId, clientShiftId, productId, total, "wire-bad-sale"),
      orderDiscountAmount: 10,
      orderDiscountReason: "manager_approval",
    });
    till.store.appendEvent("cash.movement", { actorUserId, type: "pay_in", amount: 50, reasonCode: "float_top_up" });

    await till.engine.flush();

    const results = (batchesSent(calls)[0].response as { results: { status: string; error?: { code: string } }[] }).results;
    // Stop-on-first-failure: the tail is never touched, so it stays pending.
    expect(results.map((r) => r.status)).toEqual(["applied", "failed"]);
    expect(results[1].error?.code).toBe("forbidden");

    const events = allEvents(till);
    expect(events.map((e) => e.status)).toEqual(["synced", "failed", "pending"]);
    expect(JSON.parse(events[1].server_response!)).toEqual({ error: expect.stringContaining("forbidden:") });
    expect(till.engine.status()).toMatchObject({
      state: "halted",
      pending: 1,
      haltedOn: { eventId: events[1].event_id, type: "sale.recorded" },
    });

    // Sticky: replaying the pending tail past a refused event would land a
    // movement before the sale that belongs in front of it.
    till.store.appendEvent("cash.movement", { actorUserId, type: "pay_in", amount: 10, reasonCode: "float_top_up" });
    await till.engine.flush();

    expect(batchesSent(calls)).toHaveLength(1);
    expect(till.engine.status().state).toBe("halted");
    expect(await withTenant(tenantId, (tx) => tx.select().from(cashMovements))).toHaveLength(0);
  });

  it("answers a replayed batch as duplicates, byte-identically and without writing again", async () => {
    const { ctx, tenantId, branchId, productId, total, managerId } = await seedPosContext("owner");
    const { deviceToken, deviceId } = await pairTill(tenantId, branchId, managerId);
    const calls = installWire();
    const till = makeTill(() => deviceToken);
    const actorUserId = ctx.cashierUserId;
    const clientShiftId = crypto.randomUUID();

    till.store.appendEvent("shift.opened", { actorUserId, clientShiftId, openingFloat: 300, denominations: OPENING_DENOMS });
    till.store.appendEvent("sale.recorded", salePayload(actorUserId, clientShiftId, productId, total, "wire-replay-sale"));
    till.store.appendEvent("cash.movement", { actorUserId, type: "pay_in", amount: 50, reasonCode: "float_top_up" });
    till.store.appendEvent("shift.closed", { actorUserId, clientShiftId, countedTotal: 342, denominations: CLOSING_DENOMS });

    await till.engine.flush();
    const firstResults = storedResults(till);
    const rowsAfterFirst = await countServerRows(tenantId, deviceId);

    // The window the receipts exist for: the server committed, the response
    // never reached the till, and the queue comes back up still owing them.
    till.sqlite.prepare("UPDATE local_events SET status = 'pending', server_response = NULL").run();
    await till.engine.flush();

    const replay = (batchesSent(calls)[1].response as { results: { status: string }[] }).results;
    expect(replay.map((r) => r.status)).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"]);
    expect(await countServerRows(tenantId, deviceId)).toEqual(rowsAfterFirst);

    // A duplicate answer is served from the receipt, so it must be the same
    // answer the apply gave — a till that took a different one would advance
    // its confirmed snapshot to a different state than the first flush did.
    expect(storedResults(till)).toEqual(firstResults);
    expect(allEvents(till).map((e) => e.status)).toEqual(["synced", "synced", "synced", "synced"]);
    expect(till.engine.status()).toMatchObject({ state: "online", pending: 0 });
  });
});

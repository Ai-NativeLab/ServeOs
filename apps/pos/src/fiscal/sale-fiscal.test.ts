import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleFiscalStatus } from "../../electron/preload";
import {
  FISCAL_POLL_INTERVAL_MS,
  FISCAL_POLL_MAX_MS,
  fetchSaleFiscal,
  isFiscalPollDone,
  keyedFiscalFor,
  sameFiscal,
  settleKeyedFiscalRead,
  startKeyedFiscalRead,
  startSaleFiscalPoll,
} from "./sale-fiscal";

const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";

const status = (over: Partial<SaleFiscalStatus> = {}): SaleFiscalStatus => ({
  docType: "e_receipt",
  status: "pending",
  etaUuid: "uuid-1",
  etaLongId: null,
  qrPayload: "payload-1",
  qrImageDataUrl: QR,
  ...over,
});

/** A B2B sale's row: filed as an `e_invoice`, so it has no QR at any point and
 *  ETA's assigned long id is the only identity it will ever show. */
const invoice = (over: Partial<SaleFiscalStatus> = {}): SaleFiscalStatus =>
  status({ docType: "e_invoice", etaUuid: null, qrPayload: null, qrImageDataUrl: null, ...over });

/** One poll at t=0 and one every interval up to and including the cap. */
const POLLS_TO_CAP = FISCAL_POLL_MAX_MS / FISCAL_POLL_INTERVAL_MS + 1;

/** Drains the very first tick, which fires synchronously on start. */
const firstTick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("isFiscalPollDone", () => {
  it("needs BOTH the printable QR and a settled verdict", () => {
    expect(isFiscalPollDone(null)).toBe(false);
    expect(isFiscalPollDone(status({ status: "accepted" }))).toBe(true);
    expect(isFiscalPollDone(status({ status: "rejected" }))).toBe(true);
    // A verdict with nothing to print is not something to stop on.
    expect(isFiscalPollDone(status({ status: "accepted", qrImageDataUrl: null }))).toBe(false);
  });

  it("does not treat `failed` as terminal — the worker retries it", () => {
    // "Poll until it stops being failed" is the trap this guards: a row that
    // exhausts its attempts stays `failed` forever, so only the cap ends it.
    expect(isFiscalPollDone(status({ status: "failed" }))).toBe(false);
    expect(isFiscalPollDone(status({ status: "pending" }))).toBe(false);
    expect(isFiscalPollDone(status({ status: "submitted" }))).toBe(false);
  });

  it("settles a B2B invoice on the verdict ALONE — there is no QR to wait for", () => {
    // The whole point: an `e_invoice` never has a `qrImageDataUrl`, so the
    // receipt's "QR and a verdict" rule is unsatisfiable for it and the till
    // would burn its entire budget re-reading a settled row.
    expect(isFiscalPollDone(invoice({ status: "accepted", etaLongId: "LONG-1" }))).toBe(true);
    expect(isFiscalPollDone(invoice({ status: "rejected" }))).toBe(true);
    // An acceptance ETA has not yet named a number for still settles: the poll
    // is waiting on a VERDICT, and the footer prints "pending" for the number.
    expect(isFiscalPollDone(invoice({ status: "accepted", etaLongId: null }))).toBe(true);

    // The terminal half of the rule is unchanged — an invoice in flight is not
    // done, and `failed` is still not terminal for either family.
    expect(isFiscalPollDone(invoice({ status: "pending" }))).toBe(false);
    expect(isFiscalPollDone(invoice({ status: "submitted" }))).toBe(false);
    expect(isFiscalPollDone(invoice({ status: "failed" }))).toBe(false);
  });

  it("keeps the e_receipt rule intact — a QR-less accepted receipt is NOT done", () => {
    // The regression this pins: widening the predicate for invoices must not
    // relax it for receipts, whose printed QR is the thing being waited on.
    expect(isFiscalPollDone(status({ status: "accepted", qrImageDataUrl: null }))).toBe(false);
    expect(isFiscalPollDone(status({ status: "accepted", qrImageDataUrl: QR }))).toBe(true);
  });
});

describe("sameFiscal", () => {
  it("ignores the re-encoded payload and compares what the footer prints", () => {
    expect(sameFiscal(status(), status({ qrPayload: "re-read from the same row" }))).toBe(true);
    expect(sameFiscal(status(), status({ status: "accepted" }))).toBe(false);
    expect(sameFiscal(status(), status({ etaUuid: "uuid-2" }))).toBe(false);
    expect(sameFiscal(null, status())).toBe(false);
    expect(sameFiscal(null, null)).toBe(true);
  });

  it("sees an invoice's long id arriving — it is the only field that changes", () => {
    // An accepted invoice differs from the pending one it replaces in
    // `etaLongId` and nothing else once the status has settled. Omitting the
    // field from the comparison would leave "pending ETA number" on the receipt
    // permanently, with the number sitting in a response nobody reported.
    expect(sameFiscal(
      invoice({ status: "accepted", etaLongId: null }),
      invoice({ status: "accepted", etaLongId: "LONG-1" }),
    )).toBe(false);
    expect(sameFiscal(invoice({ etaLongId: "LONG-1" }), invoice({ etaLongId: "LONG-1" }))).toBe(true);
    // And the family itself is compared, so a footer can never carry across it.
    expect(sameFiscal(status(), invoice())).toBe(false);
  });
});

describe("the bounded poll", () => {
  it("stops the moment it holds the QR and a terminal verdict", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(status({ status: "accepted" }));
    const onFiscal = vi.fn();

    startSaleFiscalPoll("order-1", onFiscal, { fetchStatus });
    await firstTick();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(onFiscal).toHaveBeenCalledTimes(1);
    expect(onFiscal).toHaveBeenCalledWith(status({ status: "accepted" }));

    // Nothing more, ever — the image is byte-identical on every call and the
    // verdict cannot change once it is terminal.
    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS * 4);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("gives up at the cap when the verdict never lands", async () => {
    // The normal shape of an ETA sale: the QR is there immediately, the verdict
    // is minutes to hours away. The till must not still be polling by then.
    const fetchStatus = vi.fn().mockResolvedValue(status({ status: "submitted" }));
    const onFiscal = vi.fn();

    startSaleFiscalPoll("order-1", onFiscal, { fetchStatus });
    await firstTick();
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(POLLS_TO_CAP);

    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS * 4);
    expect(fetchStatus).toHaveBeenCalledTimes(POLLS_TO_CAP);
    // The footer keeps what it has: one QR, reported once.
    expect(onFiscal).toHaveBeenCalledTimes(1);
  });

  it("settles a B2B invoice on the FIRST poll, not eleven polls later", async () => {
    // The regression this exists for. Before the predicate split on `docType`,
    // an accepted invoice could never satisfy "QR and a verdict" — so the till
    // ran POLLS_TO_CAP reads on a row that was already final on the first, and
    // ten of them were pure waste against a server that re-encodes a PNG per
    // call. One read, then silence.
    const accepted = invoice({ status: "accepted", etaLongId: "LONG-1" });
    const fetchStatus = vi.fn().mockResolvedValue(accepted);
    const onFiscal = vi.fn();

    startSaleFiscalPoll("order-b2b", onFiscal, { fetchStatus });
    await firstTick();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(onFiscal).toHaveBeenCalledTimes(1);
    expect(onFiscal).toHaveBeenCalledWith(accepted);

    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS * 4);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    // Stated as the number it would otherwise have been, so this reads as the
    // saving it is rather than as an arbitrary 1.
    expect(POLLS_TO_CAP).toBeGreaterThan(1);
  });

  it("keeps polling an in-flight invoice to the cap, same as a receipt", async () => {
    // The other half: settling early must be about the VERDICT, not about the
    // family. A pending invoice is still waiting for something.
    const fetchStatus = vi.fn().mockResolvedValue(invoice({ status: "submitted" }));
    startSaleFiscalPoll("order-b2b", vi.fn(), { fetchStatus });

    await firstTick();
    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS * 4);
    expect(fetchStatus).toHaveBeenCalledTimes(POLLS_TO_CAP);
  });

  it("keeps polling to the cap on a permanently `failed` row without looping forever", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(status({ status: "failed" }));
    startSaleFiscalPoll("order-1", vi.fn(), { fetchStatus });

    await firstTick();
    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS * 4);
    expect(fetchStatus).toHaveBeenCalledTimes(POLLS_TO_CAP);
  });

  it("treats a `null` body as the ordinary no-record answer, not an error", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(null);
    const onFiscal = vi.fn();

    startSaleFiscalPoll("order-1", onFiscal, { fetchStatus });
    await firstTick();
    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS * 4);

    // No footer is offered, nothing throws, and the poll still ends at the cap
    // — the enqueue may land during the window, so it is worth asking again.
    expect(onFiscal).not.toHaveBeenCalled();
    expect(fetchStatus).toHaveBeenCalledTimes(POLLS_TO_CAP);
  });

  it("swallows a failed read and leaves the last known value standing", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(status({ status: "pending" }))
      .mockRejectedValueOnce(new Error("network unreachable"))
      .mockResolvedValue(status({ status: "accepted" }));
    const onFiscal = vi.fn();

    startSaleFiscalPoll("order-1", onFiscal, { fetchStatus });
    await firstTick();
    expect(onFiscal).toHaveBeenCalledTimes(1);

    // The outage neither throws nor blanks the footer.
    await vi.advanceTimersByTimeAsync(FISCAL_POLL_INTERVAL_MS);
    expect(onFiscal).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(FISCAL_POLL_INTERVAL_MS);
    expect(onFiscal).toHaveBeenNthCalledWith(2, status({ status: "accepted" }));
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("reports only what changed, so the QR is rendered once", async () => {
    // The endpoint re-encodes the PNG on every call from an immutable payload:
    // an equal answer must not push new state and re-render the image.
    const fetchStatus = vi.fn().mockImplementation(async () => status({ status: "pending" }));
    const onFiscal = vi.fn();

    startSaleFiscalPoll("order-1", onFiscal, { fetchStatus });
    await firstTick();
    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS);

    expect(fetchStatus).toHaveBeenCalledTimes(POLLS_TO_CAP);
    expect(onFiscal).toHaveBeenCalledTimes(1);
  });

  it("stops on cancel and reports nothing afterwards", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(status({ status: "pending" }));
    const onFiscal = vi.fn();

    const cancel = startSaleFiscalPoll("order-1", onFiscal, { fetchStatus });
    await firstTick();
    cancel();

    await vi.advanceTimersByTimeAsync(FISCAL_POLL_MAX_MS * 4);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(onFiscal).toHaveBeenCalledTimes(1);
  });
});

describe("fetchSaleFiscal", () => {
  it("asks main exactly once — a reprint reads, it never resubmits", async () => {
    const saleFiscalStatus = vi.fn().mockResolvedValue(status({ status: "accepted" }));
    vi.stubGlobal("window", { pos: { saleFiscalStatus } });

    await expect(fetchSaleFiscal("order-1")).resolves.toEqual(status({ status: "accepted" }));
    expect(saleFiscalStatus).toHaveBeenCalledTimes(1);
    expect(saleFiscalStatus).toHaveBeenCalledWith("order-1");
  });

  it("answers null rather than throwing when the read does not get through", async () => {
    const saleFiscalStatus = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("window", { pos: { saleFiscalStatus } });

    await expect(fetchSaleFiscal("order-1")).resolves.toBeNull();
  });
});

describe("startSaleFiscalPoll — onFirstPoll", () => {
  it("fires exactly once, after the first read settles, even when that read found nothing", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(null);
    const onFirstPoll = vi.fn();
    const cancel = startSaleFiscalPoll("order-1", vi.fn(), { fetchStatus, onFirstPoll });
    expect(onFirstPoll).not.toHaveBeenCalled();
    await firstTick();
    expect(onFirstPoll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FISCAL_POLL_INTERVAL_MS * 3);
    expect(onFirstPoll).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("does not fire for a poll cancelled before its first read lands", async () => {
    const onFirstPoll = vi.fn();
    const cancel = startSaleFiscalPoll("order-1", vi.fn(), {
      fetchStatus: () => new Promise((r) => setTimeout(() => r(status()), 50)),
      onFirstPoll,
    });
    cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(onFirstPoll).not.toHaveBeenCalled();
  });
});

describe("the reprint slip's keyed fiscal read", () => {
  it("drops a late answer for sale A once the slip has moved on to sale B", () => {
    // Open A, close it, open B — then A's slow read lands.
    let state = startKeyedFiscalRead("A");
    state = startKeyedFiscalRead("B");
    const afterLateA = settleKeyedFiscalRead(state, "A", status({ etaUuid: "uuid-A" }));
    expect(afterLateA).toBe(state);
    expect(keyedFiscalFor(afterLateA, "B")).toEqual({ fiscal: null, fetching: true });
    // B's own answer is applied.
    const settled = settleKeyedFiscalRead(afterLateA, "B", status({ etaUuid: "uuid-B" }));
    expect(keyedFiscalFor(settled, "B").fiscal?.etaUuid).toBe("uuid-B");
    expect(keyedFiscalFor(settled, "B").fetching).toBe(false);
  });

  it("drops an answer that lands after the slip was CLOSED (state reset to null)", () => {
    expect(settleKeyedFiscalRead(null, "A", status())).toBeNull();
  });

  it("never shows one order's footer on another order's slip", () => {
    const a = settleKeyedFiscalRead(startKeyedFiscalRead("A"), "A", status());
    expect(keyedFiscalFor(a, "B")).toEqual({ fiscal: null, fetching: false });
    expect(keyedFiscalFor(a, null)).toEqual({ fiscal: null, fetching: false });
    expect(keyedFiscalFor(a, "A").fiscal).toEqual(status());
  });
});

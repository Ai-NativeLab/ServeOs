import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleFiscalStatus } from "../../electron/preload";
import {
  FISCAL_POLL_INTERVAL_MS,
  FISCAL_POLL_MAX_MS,
  fetchSaleFiscal,
  isFiscalPollDone,
  sameFiscal,
  startSaleFiscalPoll,
} from "./sale-fiscal";

const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";

const status = (over: Partial<SaleFiscalStatus> = {}): SaleFiscalStatus => ({
  status: "pending",
  etaUuid: "uuid-1",
  qrPayload: "payload-1",
  qrImageDataUrl: QR,
  ...over,
});

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
});

describe("sameFiscal", () => {
  it("ignores the re-encoded payload and compares what the footer prints", () => {
    expect(sameFiscal(status(), status({ qrPayload: "re-read from the same row" }))).toBe(true);
    expect(sameFiscal(status(), status({ status: "accepted" }))).toBe(false);
    expect(sameFiscal(status(), status({ etaUuid: "uuid-2" }))).toBe(false);
    expect(sameFiscal(null, status())).toBe(false);
    expect(sameFiscal(null, null)).toBe(true);
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

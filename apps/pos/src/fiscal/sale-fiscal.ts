import { useEffect, useState } from "react";
import type { SaleFiscalStatus } from "../../electron/preload";

/**
 * The till's side of the ETA e-receipt: one read of `GET /api/pos/v1/sales/:id/
 * fiscal` (through main, which holds the device token), and the bounded poll the
 * receipt screen runs while it waits for a verdict.
 *
 * WHY BOUNDED, AND WHY NOT "POLL UNTIL ACCEPTED".
 * `accepted` and `rejected` are terminal. `failed` is NOT — the worker retries
 * it — so a client polling "until it stops being failed" polls forever against a
 * row that will never move. And the verdict itself is minutes-to-hours away: ETA
 * is post-clearance, so waiting for it would leave a till polling all afternoon
 * for a receipt the customer walked out with. The poll therefore stops at the
 * FIRST of: holding the QR image AND a terminal status, or the elapsed cap.
 * Whatever the footer holds when polling stops is what the receipt shows.
 *
 * WHY THE QR IS USUALLY THERE ON THE FIRST POLL. `finalize` runs inline at sale
 * time, so `qrPayload` — and with it the uuid and the QR image — exists from the
 * moment the submission row does, long before ETA has said anything. That is the
 * whole point: the customer copy must carry the QR at issuance.
 *
 * The endpoint re-renders the PNG from an immutable payload on every call, so it
 * is byte-identical each time and there is nothing to gain by asking again —
 * `startSaleFiscalPoll` only reports a value that actually differs, so the image
 * is rendered once and never churned.
 */

/** ~3s between polls: fast enough that the QR lands while the cashier is still
 *  tearing off the receipt, slow enough to cost the server ten PNG encodes. */
export const FISCAL_POLL_INTERVAL_MS = 3_000;

/** ~30s total. Past this the till stops asking and the footer keeps what it has;
 *  the dashboard, not the queue at the counter, is where a verdict is watched. */
export const FISCAL_POLL_MAX_MS = 30_000;

const TERMINAL_STATUSES: readonly SaleFiscalStatus["status"][] = ["accepted", "rejected"];

/** What the poll is waiting for: the printable QR *and* a settled verdict.
 *  `failed` and `pending` are not settled — the cap is what stops those. */
export function isFiscalPollDone(fiscal: SaleFiscalStatus | null): boolean {
  return fiscal !== null && fiscal.qrImageDataUrl !== null && TERMINAL_STATUSES.includes(fiscal.status);
}

/** Compares only what the footer renders — a re-encoded but identical PNG must
 *  not count as a change, or the receipt would re-render the QR on every poll. */
export function sameFiscal(a: SaleFiscalStatus | null, b: SaleFiscalStatus | null): boolean {
  if (a === null || b === null) return a === b;
  return a.status === b.status && a.etaUuid === b.etaUuid && a.qrImageDataUrl === b.qrImageDataUrl;
}

/**
 * One read, never throwing. `null` covers both "this sale has no fiscal record"
 * (a non-EG tenant, or an enqueue that has not landed) and "the read did not get
 * through" — the receipt treats them the same, because in both cases all it can
 * honestly print is the receipt it would have printed anyway. A caller that
 * needs to tell them apart must widen the type at the source
 * (`PosMain.saleFiscalStatus`) rather than read meaning into `null`.
 */
export async function fetchSaleFiscal(orderId: string): Promise<SaleFiscalStatus | null> {
  try {
    return await window.pos.saleFiscalStatus(orderId);
  } catch {
    return null;
  }
}

/**
 * Polls until the verdict is in or the cap runs out, whichever is first, and
 * calls `onFiscal` only when the value actually changes. Returns the canceller;
 * calling it stops the poll and guarantees no further `onFiscal`.
 *
 * Nothing here is on the checkout path: the sale is already committed and the
 * receipt already on screen before the first call goes out, and a rejection or
 * an outage leaves the last known value standing rather than surfacing an error.
 */
export function startSaleFiscalPoll(
  orderId: string,
  onFiscal: (fiscal: SaleFiscalStatus) => void,
  opts: {
    fetchStatus?: (orderId: string) => Promise<SaleFiscalStatus | null>;
    intervalMs?: number;
    maxMs?: number;
  } = {},
): () => void {
  const fetchStatus = opts.fetchStatus ?? fetchSaleFiscal;
  const intervalMs = opts.intervalMs ?? FISCAL_POLL_INTERVAL_MS;
  const maxMs = opts.maxMs ?? FISCAL_POLL_MAX_MS;
  const startedAt = Date.now();

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: SaleFiscalStatus | null = null;

  async function tick(): Promise<void> {
    let next: SaleFiscalStatus | null = null;
    try {
      next = await fetchStatus(orderId);
    } catch {
      // A failed poll is not news: it changes nothing the footer shows, and the
      // next one may well succeed. `fetchSaleFiscal` already swallows; an
      // injected fetcher might not.
      next = null;
    }
    if (cancelled) return;

    if (next !== null && !sameFiscal(last, next)) {
      last = next;
      onFiscal(next);
    }
    if (isFiscalPollDone(last)) return;
    // Schedule only while the next attempt still lands inside the window, so
    // the last poll is the one at the cap itself and never one past it.
    if (Date.now() - startedAt + intervalMs > maxMs) return;
    timer = setTimeout(() => void tick(), intervalMs);
  }

  void tick();

  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * The receipt screen's view of it: pass the SERVER order id once the sale is
 * confirmed, `null` otherwise (an unsynced offline sale has no server order to
 * ask about yet, and nothing to print a QR from).
 *
 * The result is keyed by the order it was fetched for, so a footer can never be
 * carried from one receipt onto the next — and so nothing has to be reset in an
 * effect on the way in.
 */
export function useSaleFiscal(orderId: string | null): SaleFiscalStatus | null {
  const [state, setState] = useState<{ orderId: string; fiscal: SaleFiscalStatus } | null>(null);

  useEffect(() => {
    if (!orderId) return;
    return startSaleFiscalPoll(orderId, (fiscal) => setState({ orderId, fiscal }));
  }, [orderId]);

  return state !== null && state.orderId === orderId ? state.fiscal : null;
}

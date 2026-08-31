import { app, safeStorage } from "electron";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { openDb, type AtRestCipher } from "./_offline/db";
import { Store, type EventRow } from "./_offline/store";
import {
  offlineSignIn, offlineGrant, createGrantVault, consumeOfflineGrant, rememberGrant,
  type OfflineGrantVault,
} from "./_offline/offline-auth";
import { EMPTY_TILL_STATE, reduce, type TillState } from "./_offline/reducer";
import { createApiClient, type PosApi } from "./_offline/api";
import { SyncEngine, type SyncStatus } from "./_offline/sync";
import { TenantSignal, type RealtimeEvent, type TenantEventType } from "./_offline/realtime";
import { createRealtimeTransport } from "./_offline/realtime-transport";
import {
  money, payoutNeedsManager, round2, shortCode, snapshotLine, sumDenominations, tillReport,
  type CachedMenu, type ShiftPolicy,
} from "./_offline/till";

export type { SyncStatus } from "./_offline/sync";
export type { RealtimeEvent } from "./_offline/realtime";

/**
 * What main pushes to the renderer on `pos:realtimeEvent`. The status half is
 * what lets the queue relax its poll only while a channel is genuinely joined
 * — with realtime off, unreachable, or unauthorized, it never arrives and the
 * queue keeps polling exactly as it does today.
 */
export type PosRealtimeMessage =
  | { kind: "status"; live: boolean }
  | { kind: "event"; event: RealtimeEvent };

/** The till only cares about work arriving in its queue. */
const REALTIME_EVENTS: TenantEventType[] = ["orders.changed", "sync.applied"];

/** The real at-rest cipher (Task 14), over the same `safeStorage` `load`/
 *  `persist` below already use for `pos-device.json` — `isAvailable()` and
 *  `encrypt/decryptString` map straight onto safeStorage's own methods, so
 *  the degrade-to-plaintext behavior (encryption unavailable, e.g. headless
 *  Linux) is identical to the device-file precedent. */
const authCacheCipher: AtRestCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (s) => safeStorage.encryptString(s),
  decryptString: (b) => safeStorage.decryptString(b),
};

// In dev (vite serving), default to the local backend; otherwise the live
// dashboard host on serveos.tech (serveos.com only 302-redirects there, which
// a packaged build cannot follow for POSTs with an Authorization header).
// POS_API_URL always wins.
const DEFAULT_BASE_URL = process.env.VITE_DEV_SERVER_URL ? "http://localhost:3000" : "https://app.serveos.tech";

/**
 * The body a POS route returns when the *device* token is missing, unknown or
 * revoked (PosAuthError). A wrong cashier password is also a 401, but carries
 * PosCashierError's own message — so the status alone cannot tell the two
 * apart, and unpairing on any 401 would wipe a till's pairing every time
 * somebody mistyped their password.
 *
 * Note this only discriminates on the routes that report the two separately.
 * Most cashier-authenticated routes still collapse PosAuthError and
 * PosCashierError into this same string, which is why unpair-on-401 is applied
 * only to the device-authenticated calls below.
 */
const DEVICE_UNAUTHORIZED = "Unauthorized";

/** Shown to the operator, and the renderer's cue to return to pairing. */
const DEVICE_UNPAIRED_MESSAGE = "Device unpaired — please pair again";

type Device = { token: string; tenantId: string; branchId: string; branchName: string };

/**
 * What actually lands on disk. `baseUrl` is part of the record because a device
 * token only means anything to the backend that minted it: dev and the packaged
 * build share one userData directory (Electron derives it from the package
 * `name`, which is "pos" for both), so without this a pairing made against
 * localhost silently becomes the production app's credentials — and production
 * answers every call with 401 Unauthorized.
 */
type StoredDevice = Device & { baseUrl: string };

export type OrderLine = { productId: string; quantity: number; selectedOptionIds: string[] };
export type OrderDraft = { lines: OrderLine[]; notes?: string };
export type OrderSummary = {
  id: string;
  orderNumber: number;
  customerName: string;
  fulfillmentType: "pickup" | "delivery";
  total: string;
  status: string;
  paymentStatus: string;
  placedAt: string;
  source: "walkin" | "online";
};

export type CheckoutPricing = {
  vatEnabled: boolean;
  vatRate: number;
  pricesIncludeVat: boolean;
  serviceChargeRate: number;
};
// `userId` is the server user id — every offline event's `actorUserId` (Task
// 9's client wire contract) is attributed by it, not by name/email. `token`
// is optional because an offline-signed-in cashier has no live server
// session: there was no round trip to mint one.
export type Cashier = { token?: string; userId: string; name: string; permissions: string[] };
export type TenderInput = {
  clientPaymentId: string;
  method: "cash" | "card" | "other";
  amount: number;
  tipAmount?: number;
  tenderedAmount?: number;
  reference?: string;
};
export type SaleLine = {
  productId: string;
  variantId?: string;
  quantity: number;
  selectedOptionIds: string[];
  discountAmount?: number;
  discountReason?: string;
};
export type RecordSaleInput = {
  lines: SaleLine[];
  orderDiscountAmount?: number;
  orderDiscountReason?: string;
  expectedTotal: number;
  payments: TenderInput[];
  grants?: { permission: string; token: string }[];
  notes?: string;
};
export type SaleReceipt = {
  orderId: string;
  orderNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  paymentStatus: "paid" | "partially_paid";
  idempotent: boolean;
  /** The till's own id for this sale, minted when the draft was paid. Stable
   *  across the local receipt and the server's later confirmation. */
  clientOrderId?: string;
  /** False when the server has not confirmed this sale yet — `orderNumber` is
   *  then the short client code, not a server order number (Task 11 prints it
   *  as such). */
  synced?: boolean;
};
export type HeldTicket = { id: string; label: string; draftJson: unknown; createdAt: string };

/** Sales-history search. Mirrors /api/pos/v1/sales query params. */
export type SalesSearch = {
  from?: string;
  to?: string;
  cashier?: string;
  orderNumber?: number;
  phone?: string;
  amount?: number;
  page?: number;
};

/** One finalized sale as the search list renders it (server Order → summary). */
export type SalesRow = {
  id: string;
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  fulfillmentType: "pickup" | "delivery";
  total: string;
  status: string;
  paymentStatus: string;
  placedAt: string;
};

export type SaleDetailItem = {
  id: string;
  nameEn: string;
  nameAr: string;
  variantNameEn: string | null;
  variantNameAr: string | null;
  quantity: number;
  lineTotal: string;
  discountAmount: string;
  selectedModifiers: unknown[];
};

export type SaleDetailTender = {
  id: string;
  method: string;
  amount: string;
  tipAmount: string;
  changeAmount: string | null;
};

export type SaleDetailAdjustment = {
  id: string;
  type: string;
  amount: string;
  reasonCode: string;
  reasonText: string | null;
};

export type SaleRefund = {
  id: string;
  kind: "full" | "partial";
  totalAmount: string;
  reasonCode: string;
  reasonText: string | null;
  byUserId: string;
  authorizedByUserId: string | null;
  createdAt: string;
  lines: { id: string; orderItemId: string; quantity: number; amount: string; restock: boolean }[];
  payments: { id: string; method: string; amount: string }[];
};

export type SaleDetail = {
  id: string;
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  fulfillmentType: "pickup" | "delivery";
  total: string;
  subtotal: string;
  vatAmount: string;
  serviceChargeAmount: string | null;
  deliveryFee: string;
  status: string;
  paymentStatus: string;
  placedAt: string;
  branchId: string;
  items: SaleDetailItem[];
  tenders: SaleDetailTender[];
  adjustments: SaleDetailAdjustment[];
  refunds: SaleRefund[];
};

export type RefundSaleInput = {
  orderId: string;
  kind: "full" | "partial";
  lines: { orderItemId: string; quantity: number; amount: number; restock: boolean }[];
  payments: { method: "cash" | "card" | "store_credit" | "other"; amount: number; reference?: string }[];
  reasonCode: string;
  reasonText?: string;
  clientRefundId: string;
  grantToken?: string;
};

export type RefundSaleResult = {
  refundId: string;
  totalAmount: number;
  paymentStatus: string;
  idempotent: boolean;
};

/** The re-rendered receipt for a Reprint (sale + one slip per prior refund). */
export type ReprintReceipt = {
  sale: {
    orderNumber: number;
    customerName: string;
    customerPhone: string;
    placedAt: string;
    total: string;
    paymentStatus: string;
    items: {
      nameEn: string;
      nameAr: string;
      variantNameEn: string | null;
      variantNameAr: string | null;
      quantity: number;
      lineTotal: string;
      discountAmount: string;
    }[];
    tenders: { method: string; amount: string; tipAmount: string; changeAmount: string | null }[];
    adjustments: { type: string; amount: string; reasonCode: string; reasonText: string | null }[];
  };
  refundSlips: {
    kind: "full" | "partial";
    totalAmount: string;
    reasonCode: string;
    reasonText: string | null;
    createdAt: string;
    lines: { orderItemId: string; quantity: number; amount: string; restock: boolean }[];
    payments: { method: string; amount: string }[];
  }[];
};

/**
 * One sale's ETA e-receipt state, as `GET /api/pos/v1/sales/:id/fiscal` returns
 * it. Mirrors `SaleFiscalStatus` in `src/server/fiscal/read-model.ts`.
 *
 * The whole block is `null` when the order has no submission row — the ORDINARY
 * state of a non-EG tenant and of an EG sale in the moment before its enqueue
 * lands. Never an error, and never a footer: see `saleFiscalStatus` below.
 */
export type SaleFiscalStatus = {
  status: "pending" | "submitted" | "accepted" | "rejected" | "failed";
  etaUuid: string | null;
  qrPayload: string | null;
  /** `data:image/png;base64,…`, re-rendered server-side on every call from an
   *  immutable payload — so it is byte-identical each time. Render it once. */
  qrImageDataUrl: string | null;
};

export type PosShiftSummary = {
  id: string;
  status: "open" | "closed";
  openingFloat: string;
  openedAt: string;
  openedByUserId: string;
  closedByUserId: string | null;
  closedAt: string | null;
};
export type TenderTotal = { method: "cash" | "card" | "other"; amount: number; tips: number; count: number };
export type CashMovementType = "pay_in" | "pay_out" | "safe_drop" | "no_sale";
export type MovementTotal = { type: CashMovementType; total: number; count: number };

/**
 * The X/Z projection as the server builds it. `cash.expected` and
 * `cash.variance` are null when blind close withholds them — the till renders
 * what it is given and never derives a hidden number.
 */
export type ShiftReport = {
  kind: "x" | "z";
  shiftId: string;
  openedAt: string;
  openedByUserId: string;
  openingFloat: number;
  tenders: TenderTotal[];
  movements: MovementTotal[];
  salesCount: number;
  discountTotal: number;
  voidTotal: number;
  refundTotal: number;
  cash: { expected: number | null; counted?: number; variance?: number | null };
  flagged?: boolean;
  approvedByUserId?: string | null;
  closedByUserId?: string;
  closedAt?: string;
};
export type CashCountRow = { id: string; kind: string; countedTotal: string; expectedTotal: string; variance: string };
export type CashMovementRow = {
  id: string; type: CashMovementType; amount: string; reasonCode: string;
  authorizedByUserId: string | null;
};

/** The branch's business-day X report, as served by /api/pos/v1/reports/x. */
export type DayReport = {
  window: { from: string; to: string };
  grossSales: number;
  orderCount: number;
  tenders: { method: string; amount: number; count: number }[];
  tips: number;
  discounts: number;
  voids: number;
  refunds: number;
  perCashier: { cashierUserId: string; cashierName: string | null; sales: number; orders: number }[];
  expectedDrawerCash: number;
};

/** The Z: the same totals tied to a shift. Null countedCash = not counted yet. */
export type DayZReport = DayReport & {
  shiftId: string | null;
  countedCash: number | null;
  overShort: number | null;
  frozen: boolean;
};

/**
 * Electron's IPC serializes a thrown Error down to its message — custom
 * properties do not survive the boundary. So the drawer calls return an outcome
 * the renderer can branch on structurally, rather than matching error strings.
 */
export type DrawerResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "conflict" | "needs_manager" | "bad_count" | "error"; message: string };

export type CashMovementInput = {
  type: CashMovementType;
  amount: number;
  reasonCode: string;
  reasonText?: string;
  grant?: string;
};

/** The confirmed till-state snapshot: the reduction of every event the server
 *  has accepted. Live state is this plus everything not yet synced. */
const TILL_STATE_KEY = "till_state";

/** How deep the queue may be before a sale stops waiting for the server's
 *  confirmation. Matches the engine's batch size: anything beyond it cannot be
 *  answered in one round trip anyway. */
const CONFIRM_WAIT_MAX_QUEUE = 20;

/**
 * Write-through POS glue: every operator action is appended to the local
 * event log FIRST and answered from local state, then flushed to the server
 * when there is a network. Nothing the cashier does waits on a round trip, and
 * an outage changes only how long the queue is — not what the till can do.
 *
 * The server-backed reads that have no offline answer (web-order queue, sales
 * history, refunds, reprints, business-day reports) still call the API
 * directly and simply come back empty when there is no network; Task 11
 * disables their entry points from the sync state instead.
 */
export class PosMain {
  private baseUrl = process.env.POS_API_URL || DEFAULT_BASE_URL;
  private device: Device | null = null;
  /** In memory only: closing the app signs the cashier out but leaves the device paired. */
  private cashier: Cashier | null = null;
  private readonly file = path.join(app.getPath("userData"), "pos-device.json");
  private readonly store = new Store(openDb(path.join(app.getPath("userData"), "pos.db")), authCacheCipher);
  /** Single-use manager grants (Task 9) — device-local, never persisted. */
  private readonly grantVault: OfflineGrantVault = createGrantVault();
  private readonly api: PosApi = createApiClient(this.baseUrl, {
    deviceToken: () => this.device?.token ?? null,
    cashierToken: () => this.cashier?.token ?? null,
  });
  private readonly engine: SyncEngine;
  /** Hears the tenant's broadcasts so a web order reaches the queue in
   *  seconds. Purely an accelerant — the queue's own poll is the guarantee. */
  private readonly realtime: TenantSignal;
  /** The reduction of every CONFIRMED event; durable in local_state. */
  private snapshot: TillState;
  /** What the till believes right now: the snapshot plus every event the
   *  server has not accepted yet. Rebuilt from the log at boot, advanced by
   *  each append — never read from the network. */
  private till: TillState;
  /**
   * A drawer this device opened ONLINE, before the event log owned shifts
   * (or from an older build). It has no clientShiftId, so everything that
   * names it uses the server id — see `shiftRef`. Adopting it is what keeps
   * `openShift` from queueing a second open behind the server's, which would
   * be refused as `shift_already_open` and jam the queue.
   */
  private serverShift: { shift: PosShiftSummary; report: ShiftReport | null } | null = null;
  /** Resolves the local receipt of a sale into the server's, when the flush
   *  that follows the sale confirms it before the cashier's eyes leave the
   *  screen. Keyed by eventId; empty at rest. */
  private readonly awaitingResult = new Map<string, (result: Record<string, unknown>) => void>();

  constructor(
    onSyncState?: (status: SyncStatus) => void,
    onRealtime?: (message: PosRealtimeMessage) => void,
  ) {
    this.load();
    // Retention (Task 14): synced rows older than the window are dead weight
    // on every pendingEvents/unsyncedEvents scan — pending and failed rows are
    // untouched (pruneSyncedEvents only ever deletes status = 'synced').
    this.store.pruneSyncedEvents();
    this.snapshot = this.store.getState<TillState>(TILL_STATE_KEY) ?? EMPTY_TILL_STATE;
    // Crash-safe boot: the durable snapshot plus the tail of the log IS the
    // till's state. No network call gates the first render.
    this.till = reduce(this.snapshot, this.store.unsyncedEvents());
    this.engine = new SyncEngine(
      this.store,
      this.api,
      { onApplied: (row, result) => this.onEventApplied(row, result) },
    );
    if (onSyncState) this.engine.onState(onSyncState);
    this.realtime = new TenantSignal({
      loadConfig: () => this.api.getRealtimeConfig(),
      transport: createRealtimeTransport(),
      types: REALTIME_EVENTS,
      onEvent: (event) => onRealtime?.({ kind: "event", event }),
      onLive: (live) => onRealtime?.({ kind: "status", live }),
    });
    // No timer of its own: the engine's heartbeat already knows when the till
    // has a network, and reconnecting is what an idempotent ensureConnected is
    // for. Offline drops the channel — it would die with the network anyway.
    this.engine.onState((status) => {
      if (!this.device || status.state === "offline") this.realtime.disconnect();
      else void this.realtime.ensureConnected();
    });
  }

  /** Started by main.ts once the window exists, so the first state push has
   *  somewhere to land. */
  start(): void {
    this.engine.start();
  }

  stop(): void {
    this.engine.stop();
    this.realtime.disconnect();
  }

  syncState(): SyncStatus {
    return this.engine.status();
  }

  /** Task 11's Retry action on the halt alert. */
  async retryFailedSync(): Promise<SyncStatus> {
    await this.engine.retryFailed();
    return this.engine.status();
  }

  // ---- event log plumbing ----

  /**
   * Appends one event and folds it into live till state. `actorUserId` (and
   * `authorizedByUserId` for a gated action) travel inside the payload;
   * sync.ts lifts them onto the wire envelope.
   */
  private append(type: string, payload: Record<string, unknown>): EventRow {
    const { eventId, seq, occurredAt } = this.store.appendEvent(type, payload);
    const row: EventRow = {
      event_id: eventId, seq, type,
      payload: JSON.stringify(payload),
      occurred_at: occurredAt,
      status: "pending",
      server_response: null,
    };
    this.till = reduce(this.till, [row]);
    return row;
  }

  /** The confirmed snapshot only ever advances one accepted event at a time,
   *  in seq order — so "everything not synced" stays exactly the delta boot
   *  needs to replay on top of it. */
  private onEventApplied(row: EventRow, result: Record<string, unknown>): void {
    this.snapshot = reduce(this.snapshot, [row]);
    this.store.setState(TILL_STATE_KEY, this.snapshot);
    this.awaitingResult.get(row.event_id)?.(result);
  }

  /** Fire-and-forget: push the queue now if there is a network, otherwise just
   *  let the badge know it got longer. */
  private syncSoon(): void {
    if (this.engine.isOnline()) void this.engine.flush();
    else this.engine.notify();
  }

  /** Flush now and hand back this event's server result if the flush reached
   *  it. Null means "queued" — every caller has a local answer to fall back on. */
  private async syncNow(eventId: string): Promise<Record<string, unknown> | null> {
    // Waiting is only worth it when this event is in the first batch. After an
    // outage the queue is long, and the cashier must not stand there while it
    // drains — the sale is already recorded either way.
    if (!this.engine.isOnline() || this.engine.status().pending > CONFIRM_WAIT_MAX_QUEUE) {
      this.engine.notify();
      return null;
    }
    const box: { result: Record<string, unknown> | null } = { result: null };
    this.awaitingResult.set(eventId, (r) => { box.result = r; });
    try {
      await this.engine.flush();
    } finally {
      this.awaitingResult.delete(eventId);
    }
    return box.result;
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file);
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
      const stored = JSON.parse(json) as Partial<StoredDevice>;
      // A file written before baseUrl was recorded has none, so it is not
      // trusted either — which is the point: those are the dev pairings that
      // were being replayed against production.
      this.device =
        stored.baseUrl === this.baseUrl && stored.token
          ? {
              token: stored.token,
              tenantId: stored.tenantId ?? "",
              branchId: stored.branchId ?? "",
              branchName: stored.branchName ?? "",
            }
          : null;
    } catch {
      this.device = null;
    }
  }

  private persist(): void {
    if (!this.device) return;
    const json = JSON.stringify({ ...this.device, baseUrl: this.baseUrl } satisfies StoredDevice);
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, "utf8");
    fs.writeFileSync(this.file, data);
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.device?.token ?? ""}`,
    };
    if (this.cashier?.token) h["X-POS-Cashier"] = this.cashier.token;
    return h;
  }

  isPaired(): boolean {
    return this.device !== null;
  }

  branchName(): string {
    return this.device?.branchName ?? "";
  }

  async pair(code: string): Promise<{ branchName: string }> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Pairing failed (${res.status})`);
    }
    const d = (await res.json()) as { deviceToken: string; tenantId: string; branchId: string; branchName: string };
    this.device = { token: d.deviceToken, tenantId: d.tenantId, branchId: d.branchId, branchName: d.branchName };
    this.persist();
    return { branchName: d.branchName };
  }

  async login(
    slug: string,
    email: string,
    password: string,
    branchId?: string,
  ): Promise<{ status: "branch_required"; branches: { id: string; name: string }[] } | { status: "paired"; branchName: string }> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, email, password, branchId }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Login failed (${res.status})`);
    }
    const d = (await res.json()) as
      | { status: "branch_required"; branches: { id: string; name: string }[] }
      | { status: "paired"; deviceToken: string; tenantId: string; branchId: string; branchName: string };
    if (d.status === "branch_required") return { status: "branch_required", branches: d.branches };
    this.device = { token: d.deviceToken, tenantId: d.tenantId, branchId: d.branchId, branchName: d.branchName };
    this.persist();
    return { status: "paired", branchName: d.branchName };
  }

  /**
   * Cache first, always: the cart renders from the last synced catalog and a
   * refresh runs behind it. Only a cold cache (a device that has never pulled)
   * has to wait for the network, because there is genuinely nothing to show.
   */
  async getMenu(): Promise<{ json: string; pricing: CheckoutPricing; syncedAt: string } | null> {
    if (!this.device) return null;
    const cached = this.cachedCatalog();
    if (cached) {
      // A revoked device still surfaces, via the blocking pull below on the
      // next cold read — but revocation must not block a till that already has
      // a menu to sell from, which is the whole point of the cache.
      void this.engine.pull().catch(() => { /* the cached menu stands */ });
      return { json: cached.json, pricing: cached.pricing, syncedAt: cached.syncedAt };
    }
    try {
      await this.engine.pull();
    } catch (e) {
      // A revoked device token only surfaces here, on the one call that still
      // blocks — the engine treats every refusal as "try again later".
      if (e instanceof Error && e.message.includes("401")) {
        this.unpair();
        throw new Error("Device unpaired — please pair again");
      }
      throw new Error("The menu has not synced to this till yet");
    }
    const fresh = this.cachedCatalog();
    return fresh ? { json: fresh.json, pricing: fresh.pricing, syncedAt: fresh.syncedAt } : null;
  }

  /**
   * Online when it can be, offline when it must: a live session is worth
   * having (it authenticates the roster pull and every server-backed read),
   * so it is tried first and the cached roster catches the fall. A wrong
   * password is NOT a fall — the server said no, and asking the cache for a
   * second opinion would let a stale hash outvote it.
   */
  async signInCashier(email: string, password: string): Promise<{ name: string; permissions: string[] }> {
    if (!this.device) throw new Error("Not paired");
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/pos/v1/cashier/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.device.token}` },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      return this.offlineSignInCashier(email, password);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      // The device check runs before credentials are looked at, so a device
      // rejection here is terminal: no password will get past it.
      if (res.status === 401 && err.error === DEVICE_UNAUTHORIZED) {
        this.unpair();
        throw new Error(DEVICE_UNPAIRED_MESSAGE);
      }
      throw new Error(err.error ?? `Sign-in failed (${res.status})`);
    }
    const d = (await res.json()) as { cashierToken: string; userId: string; name: string; permissions: string[] };
    this.cashier = { token: d.cashierToken, userId: d.userId, name: d.name, permissions: d.permissions };
    // Now that there IS a cashier token, the roster (cashier-gated) can be
    // pulled — this is what makes the NEXT outage survivable.
    void this.engine.tick();
    // Awaited, unlike the roster: the very next thing the UI asks is "is a
    // drawer open?", and answering "no" for a drawer the server has open ends
    // with a second shift.opened jamming the queue.
    await this.adoptServerShift();
    return { name: d.name, permissions: d.permissions };
  }

  /**
   * Offline counterpart of signInCashier: checks the synced roster
   * (auth_cache) instead of calling the server, and appends its own
   * session.signed_in event either way (Task 9's offline-auth.ts).
   */
  offlineSignInCashier(email: string, password: string): { name: string; permissions: string[] } {
    const session = offlineSignIn(this.store, email, password);
    if (!session) throw new Error("Sign-in failed");
    this.cashier = { userId: session.userId, name: session.name, permissions: session.permissions };
    this.syncSoon();
    return { name: session.name, permissions: session.permissions };
  }

  currentCashier(): { name: string; permissions: string[] } | null {
    return this.cashier ? { name: this.cashier.name, permissions: this.cashier.permissions } : null;
  }

  signOutCashier(): void {
    this.cashier = null;
  }

  /**
   * The manager is always verified against the SYNCED ROSTER, online or off.
   * A replayed gated event names its authorizer by id (`authorizedByUserId`)
   * and the live /authorize route answers only with a name, so the roster is
   * the one source that can produce what the event needs. When there is a
   * network the live route is called too, purely to mint a server-redeemable
   * token for the routes that still take one (refunds), and the vault is
   * re-keyed onto it so ONE token works for both worlds.
   */
  async authorize(email: string, password: string, permission: string): Promise<{ grant: string; authorizedBy: string }> {
    if (!this.cashier) throw new Error("No cashier signed in");
    const local = offlineGrant(this.store, this.grantVault, this.cashier.userId, email, password, permission);
    if (!local) throw new Error("Authorization failed");
    const authorizedBy = this.store.findAuthUser(email)?.name ?? "";

    if (this.engine.isOnline() && this.cashier.token) {
      try {
        const res = await fetch(`${this.baseUrl}/api/pos/v1/authorize`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ email, password, permission }),
        });
        if (res.ok) {
          const server = (await res.json()) as { grant: string; authorizedBy: string };
          rememberGrant(this.grantVault, server.grant, permission, local.authorizedByUserId);
          consumeOfflineGrant(this.grantVault, local.token, permission);
          return { grant: server.grant, authorizedBy: server.authorizedBy };
        }
      } catch { /* the roster already approved this — the local grant stands */ }
    }
    return { grant: local.token, authorizedBy };
  }

  /** Kept as its own entry point for the offline path Task 9 introduced;
   *  `authorize` above is the same check with an optional live upgrade. */
  offlineAuthorize(email: string, password: string, permission: string): { grant: string; authorizedBy: string } {
    if (!this.cashier) throw new Error("No cashier signed in");
    const grant = offlineGrant(this.store, this.grantVault, this.cashier.userId, email, password, permission);
    if (!grant) throw new Error("Authorization failed");
    return { grant: grant.token, authorizedBy: this.store.findAuthUser(email)?.name ?? "" };
  }

  /**
   * The sale is recorded LOCALLY and answered from the cart's own numbers; the
   * server confirms it afterwards (immediately, when there is a network) and
   * upgrades the receipt's order number in place.
   *
   * `clientOrderId` is minted here, at the moment the draft is paid, and is
   * the sale's identity everywhere after: the local receipt's short code, the
   * event payload, and the server's idempotency key when the event replays.
   */
  async recordSale(input: RecordSaleInput): Promise<SaleReceipt> {
    if (!this.device) throw new Error("Not paired");
    if (!this.cashier) throw new Error("No cashier signed in");
    // Mirrors recordSale's own refusal server-side: cash must land in an
    // accounted drawer. Refusing here keeps an event that could only ever be
    // rejected (and would jam the queue behind it) out of the log.
    const drawer = this.shiftRef();
    if (!drawer && input.payments.some((p) => p.method === "cash")) {
      throw new Error("Open a drawer before taking cash");
    }

    const clientOrderId = crypto.randomUUID();
    const catalog = this.cachedCatalog();
    const paidAmount = round2(input.payments.reduce((s, p) => s + p.amount, 0));
    const changeAmount = round2(input.payments.reduce(
      (s, p) => s + (p.method === "cash" && p.tenderedAmount !== undefined ? Math.max(0, p.tenderedAmount - p.amount) : 0),
      0,
    ));
    const authorizedByUserId = this.spendGrant(input.grants, "pos:discount");

    const row = this.append("sale.recorded", {
      actorUserId: this.cashier.userId,
      ...(authorizedByUserId ? { authorizedByUserId } : {}),
      clientOrderId,
      lines: input.lines,
      lineSnapshots: input.lines.map((l) => snapshotLine(catalog?.menu, l)),
      orderDiscountAmount: input.orderDiscountAmount,
      orderDiscountReason: input.orderDiscountReason,
      expectedTotal: input.expectedTotal,
      payments: input.payments,
      notes: input.notes,
      // Wire contract rule 1: name the drawer on EVERY sale, card-only
      // included — a sale that replays after its shift closed would otherwise
      // drop out of that shift's Z-report entirely.
      ...drawer,
      ...(catalog ? { catalogVersion: catalog.catalogVersion } : {}),
    });

    const local: SaleReceipt = {
      orderId: clientOrderId,
      orderNumber: shortCode(clientOrderId),
      total: input.expectedTotal,
      paidAmount,
      changeAmount,
      paymentStatus: paidAmount >= input.expectedTotal - 0.001 ? "paid" : "partially_paid",
      idempotent: false,
      clientOrderId,
      synced: false,
    };

    const confirmed = (await this.syncNow(row.event_id)) as Partial<SaleReceipt> | null;
    return confirmed ? { ...local, ...confirmed, clientOrderId, synced: true } : local;
  }

  async holdTicket(label: string, draft: unknown): Promise<{ id: string }> {
    if (!this.cashier) throw new Error("No cashier signed in");
    const clientTicketId = crypto.randomUUID();
    this.append("ticket.held", { actorUserId: this.cashier.userId, clientTicketId, label, draft });
    this.syncSoon();
    return { id: clientTicketId };
  }

  /** Parked tickets are till-local state, so they read straight out of the
   *  reducer's projection — the same list whether or not there is a network. */
  async listHeldTickets(): Promise<HeldTicket[]> {
    return this.till.heldTickets.map((t) => ({
      id: t.clientTicketId,
      label: t.label,
      draftJson: t.draft,
      createdAt: t.createdAt,
    }));
  }

  /** The renderer discards on recall too, so this is the one resolution event
   *  it can emit; `ticket.recalled` stays available for a later Recall action
   *  that wants to say which it was. */
  async discardTicket(id: string): Promise<void> {
    if (!this.cashier) throw new Error("No cashier signed in");
    this.append("ticket.discarded", { actorUserId: this.cashier.userId, clientTicketId: id });
    this.syncSoon();
  }

  /** Web orders live only on the server — there is no offline answer, so an
   *  outage returns an empty queue rather than throwing at a poller (Task 11
   *  puts the "unavailable offline" notice on it). */
  async getOrders(): Promise<OrderSummary[]> {
    if (!this.device) return [];
    try {
      const res = await fetch(`${this.baseUrl}/api/pos/v1/orders/list`, { headers: this.authHeaders() });
      if (!res.ok) return [];
      const d = (await res.json()) as { orders: OrderSummary[] };
      return d.orders;
    } catch {
      return [];
    }
  }

  async advanceOrder(orderId: string, toStatus: string): Promise<void> {
    if (!this.device) return;
    try {
      await fetch(`${this.baseUrl}/api/pos/v1/orders/status`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ orderId, toStatus }),
      });
    } catch { /* the queue is server-owned; the next poll shows the truth */ }
  }

  /** Finalized-sale search. Only pos:sell is needed to LOOK a sale up — the
   *  privileged refund step is resolved server-side via issueRefund. */
  async listSales(search: SalesSearch = {}): Promise<SalesRow[]> {
    if (!this.device || !this.cashier) return [];
    const qs = new URLSearchParams();
    if (search.from) qs.set("from", search.from);
    if (search.to) qs.set("to", search.to);
    if (search.cashier) qs.set("cashier", search.cashier);
    if (search.orderNumber !== undefined) qs.set("orderNumber", String(search.orderNumber));
    if (search.phone) qs.set("phone", search.phone);
    if (search.amount !== undefined) qs.set("amount", String(search.amount));
    if (search.page !== undefined) qs.set("page", String(search.page));
    const res = await fetch(`${this.baseUrl}/api/pos/v1/sales?${qs.toString()}`, { headers: this.authHeaders() });
    if (!res.ok) return [];
    return (await res.json()) as SalesRow[];
  }

  async getSale(orderId: string): Promise<SaleDetail> {
    if (!this.device) throw new Error("Not paired");
    if (!this.cashier) throw new Error("No cashier signed in");
    const res = await fetch(`${this.baseUrl}/api/pos/v1/sales/${orderId}`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`Could not load the sale (${res.status})`);
    return (await res.json()) as SaleDetail;
  }

  /** Reprint = pos:sell; returns the re-rendered receipt with prior refund slips. */
  async reprintReceipt(orderId: string): Promise<ReprintReceipt> {
    if (!this.device) throw new Error("Not paired");
    if (!this.cashier) throw new Error("No cashier signed in");
    const res = await fetch(`${this.baseUrl}/api/pos/v1/sales/${orderId}/reprint`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`Could not reprint (${res.status})`);
    return (await res.json()) as ReprintReceipt;
  }

  /**
   * The ETA fiscal state of one finalized sale, for the receipt footer (Task 7).
   * Read-only and `pos:sell`-gated server-side — it never submits anything, so a
   * reprint may call it as freely as the sale that minted the receipt.
   *
   * NEVER THROWS, and answers `null` for every "we do not have one": no server
   * order id yet (an offline sale), no pairing, no cashier, an unreachable
   * backend, a refused request, or the endpoint's own literal `null` body — a
   * non-EG tenant, and every EG sale until its enqueue lands. All of them mean
   * the same thing to the receipt: print it exactly as a non-fiscal till would.
   * Mirrors `getOrders`, which swallows for the same reason — the till is
   * offline-first and no fiscal read may cost a cashier a printed receipt.
   */
  async saleFiscalStatus(orderId: string): Promise<SaleFiscalStatus | null> {
    if (!this.device || !this.cashier) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/pos/v1/sales/${orderId}/fiscal`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) return null;
      return (await res.json()) as SaleFiscalStatus | null;
    } catch {
      return null;
    }
  }

  /** Full or partial refund. A 403 (missing pos:refund) is surfaced with a
   *  code so the renderer can open ManagerAuthModal and resubmit with the grant. */
  async refundSale(input: RefundSaleInput): Promise<RefundSaleResult> {
    if (!this.device) throw new Error("Not paired");
    if (!this.cashier) throw new Error("No cashier signed in");
    const { orderId, ...body } = input;
    const res = await fetch(`${this.baseUrl}/api/pos/v1/sales/${orderId}/refund`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      const e = new Error(err.error ?? `Refund failed (${res.status})`) as Error & { code?: string };
      if (res.status === 403) e.code = "NEEDS_MANAGER";
      throw e;
    }
    return (await res.json()) as RefundSaleResult;
  }

  /** The two things every drawer action needs before it can answer at all. */
  private drawerGuard(): DrawerResult<never> | null {
    if (!this.device) return { ok: false, code: "error", message: "Not paired" };
    if (!this.cashier) return { ok: false, code: "error", message: "No cashier signed in" };
    return null;
  }

  async openShift(openingFloat: number, denominations?: Record<string, number>): Promise<DrawerResult<{ shift: PosShiftSummary }>> {
    const guard = this.drawerGuard();
    if (guard) return guard;
    // One open drawer per till, checked locally for the same reason the server
    // checks it: a second `shift.opened` is refused as `shift_already_open`,
    // and a refusal jams every event queued behind it. Ask the server too when
    // we can — a drawer opened by the online-only build has no local trace.
    if (!this.shiftRef() && this.engine.isOnline()) await this.adoptServerShift();
    if (this.shiftRef()) return { ok: false, code: "conflict", message: "A drawer is already open on this till" };
    if (denominations && sumDenominations(denominations) !== round2(openingFloat)) {
      return { ok: false, code: "bad_count", message: "The notes counted do not add up to the opening float" };
    }

    this.append("shift.opened", {
      actorUserId: this.cashier!.userId,
      clientShiftId: crypto.randomUUID(),
      openingFloat,
      denominations,
    });
    this.syncSoon();
    const shift = this.localShiftSummary();
    return shift ? { ok: true, data: { shift } } : { ok: false, code: "error", message: "Could not open the drawer" };
  }

  /**
   * The X-report, projected from this till's own event log — the same events
   * the server builds its copy from, so the two agree once the queue drains.
   * Reading it records nothing and never resets.
   */
  async currentShift(): Promise<{ shift: PosShiftSummary | null; report: ShiftReport | null }> {
    if (!this.device || !this.cashier) return { shift: null, report: null };
    const shift = this.localShiftSummary();
    if (shift) return { shift, report: tillReport("x", this.till) };
    if (this.serverShift) {
      // A drawer opened online before the log owned shifts: the server's copy
      // is the only complete one, so it is served and refreshed behind the UI.
      void this.adoptServerShift();
      return { shift: this.serverShift.shift, report: this.serverShift.report };
    }
    return { shift: null, report: null };
  }

  /** Business-day X report for this branch. Read-only and repeatable. */
  async xReport(): Promise<DayReport | null> {
    if (!this.device || !this.cashier) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/pos/v1/reports/x`, { headers: this.authHeaders() });
      if (!res.ok) return null;
      return (await res.json()) as DayReport;
    } catch {
      return null;
    }
  }

  /** Z report — this device's shift (or a named one). */
  async zReport(shiftId?: string): Promise<DayZReport | null> {
    if (!this.device || !this.cashier) return null;
    try {
      const qs = shiftId ? `?shiftId=${encodeURIComponent(shiftId)}` : "";
      const res = await fetch(`${this.baseUrl}/api/pos/v1/reports/z${qs}`, { headers: this.authHeaders() });
      if (!res.ok) return null;
      return (await res.json()) as DayZReport;
    } catch {
      return null;
    }
  }

  async countDrawer(countedTotal: number, denominations?: Record<string, number>): Promise<DrawerResult<{ count: CashCountRow; report: ShiftReport }>> {
    const guard = this.drawerGuard();
    if (guard) return guard;
    const drawer = this.shiftRef();
    if (!drawer) return { ok: false, code: "conflict", message: "No drawer is open" };
    if (denominations && sumDenominations(denominations) !== round2(countedTotal)) {
      return { ok: false, code: "bad_count", message: "The notes counted do not add up to the total" };
    }

    // A count never closes anything: the report handed back is the same live X
    // the screen was already showing, with the count folded in. Built before
    // the append only because a count changes no till state — the numbers are
    // identical either side of it.
    const report = tillReport("x", this.till, countedTotal) ?? this.serverShift?.report ?? null;
    if (!report) return { ok: false, code: "error", message: "No drawer report to count against" };

    const row = this.append("count.recorded", {
      actorUserId: this.cashier!.userId,
      ...drawer,
      countedTotal,
      denominations,
    });
    this.syncSoon();

    const expected = report.cash.expected;
    return {
      ok: true,
      data: {
        count: {
          id: row.event_id,
          kind: "mid_shift",
          countedTotal: money(countedTotal),
          expectedTotal: expected === null ? "" : money(expected),
          variance: expected === null ? "" : money(countedTotal - expected),
        },
        report,
      },
    };
  }

  async closeShift(countedTotal: number, denominations?: Record<string, number>, grant?: string): Promise<DrawerResult<{ report: ShiftReport }>> {
    const guard = this.drawerGuard();
    if (guard) return guard;
    const drawer = this.shiftRef();
    if (!drawer) return { ok: false, code: "conflict", message: "No drawer is open" };
    if (denominations && sumDenominations(denominations) !== round2(countedTotal)) {
      return { ok: false, code: "bad_count", message: "The notes counted do not add up to the total" };
    }

    const authorizedByUserId = this.spendGrant(grant, "reconciliation:manage");
    // The server refuses a close of someone else's drawer without an
    // authorizer, so the same rule is enforced here — where the manager is
    // still standing at the till and CAN be captured. There is no way to add
    // one after the fact (wire contract rule 2's reasoning, applied to closes).
    const openedBy = this.localShiftSummary()?.openedByUserId ?? this.serverShift?.shift.openedByUserId;
    if (openedBy && openedBy !== this.cashier!.userId
        && !this.cashier!.permissions.includes("reconciliation:manage") && !authorizedByUserId) {
      return { ok: false, code: "needs_manager", message: "A manager must approve closing another cashier's drawer" };
    }

    // The Z is what the drawer looked like BEFORE the close event nulls it.
    const before = this.till;
    this.append("shift.closed", {
      actorUserId: this.cashier!.userId,
      ...(authorizedByUserId ? { authorizedByUserId } : {}),
      ...drawer,
      countedTotal,
      denominations,
    });
    this.syncSoon();

    const report = this.closingReport(before, countedTotal);
    this.serverShift = null;
    return report
      ? { ok: true, data: { report } }
      : { ok: false, code: "error", message: "The drawer closed but its report could not be built" };
  }

  async cashMovement(input: CashMovementInput): Promise<DrawerResult<{ movement: CashMovementRow }>> {
    const guard = this.drawerGuard();
    if (guard) return guard;
    if (!this.shiftRef()) return { ok: false, code: "conflict", message: "No drawer is open" };
    const { grant, ...movement } = input;
    const amount = round2(movement.amount);
    if (movement.type === "no_sale" ? amount !== 0 : !(amount > 0)) {
      return { ok: false, code: "bad_count", message: "A movement amount must be a positive magnitude" };
    }

    const authorizedByUserId = this.spendGrant(grant, "reconciliation:manage");
    // Wire contract rule 2: an over-threshold pay-out MUST name its manager or
    // the server refuses it and the sticky halt jams the whole queue. The
    // catalog response now carries shiftPolicy.payoutThreshold (Part B
    // fold-in fix), so payoutNeedsManager applies the SAME rule the server
    // does instead of nagging for a manager on every pay-out — except when
    // the policy hasn't synced yet (cachedCatalog's shiftPolicy is null),
    // where it keeps requiring one: the safe fallback never relaxes toward
    // letting an over-threshold pay-out through unchecked.
    const policy = this.cachedCatalog()?.shiftPolicy ?? null;
    if (!authorizedByUserId && !this.cashier!.permissions.includes("reconciliation:manage")
        && payoutNeedsManager(policy, movement.type, amount)) {
      return { ok: false, code: "needs_manager", message: "A manager must approve a pay-out" };
    }

    const row = this.append("cash.movement", {
      actorUserId: this.cashier!.userId,
      ...(authorizedByUserId ? { authorizedByUserId } : {}),
      type: movement.type,
      amount,
      reasonCode: movement.reasonCode,
      reasonText: movement.reasonText,
    });
    this.syncSoon();

    const signed = movement.type === "pay_in" ? amount : movement.type === "no_sale" ? 0 : -amount;
    return {
      ok: true,
      data: {
        movement: {
          id: row.event_id,
          type: movement.type,
          amount: money(signed),
          reasonCode: movement.reasonCode,
          authorizedByUserId: authorizedByUserId ?? null,
        },
      },
    };
  }

  unpair(): void {
    this.device = null;
    this.cashier = null;
    this.serverShift = null;
    try { fs.unlinkSync(this.file); } catch { /* nothing to remove */ }
  }

  // ---- local projections ----

  /** The cached catalog, parsed. Null until the first successful pull.
   *  `shiftPolicy` is null on an older cache row (pre-Part-B) even once
   *  `pricingJson` exists — the safe fallback in `payoutNeedsManager` treats
   *  that identically to "never synced". */
  private cachedCatalog(): {
    json: string; menu: CachedMenu; pricing: CheckoutPricing; shiftPolicy: ShiftPolicy | null;
    catalogVersion: number; syncedAt: string;
  } | null {
    const row = this.store.getCatalog();
    if (!row?.pricingJson) return null;
    return {
      json: row.json,
      menu: JSON.parse(row.json) as CachedMenu,
      pricing: JSON.parse(row.pricingJson) as CheckoutPricing,
      shiftPolicy: row.shiftPolicyJson ? (JSON.parse(row.shiftPolicyJson) as ShiftPolicy) : null,
      catalogVersion: row.catalogVersion ?? 0,
      syncedAt: row.syncedAt,
    };
  }

  /**
   * How an event names the drawer it belongs to: the client id for a shift
   * this till opened (online or off), the server id for one it adopted.
   * Undefined only when no drawer is open at all.
   */
  private shiftRef(): { clientShiftId: string } | { shiftId: string } | undefined {
    const open = this.till.openShift;
    if (open) return { clientShiftId: open.clientShiftId };
    if (this.serverShift) return { shiftId: this.serverShift.shift.id };
    return undefined;
  }

  private localShiftSummary(): PosShiftSummary | null {
    const open = this.till.openShift;
    if (!open) return null;
    return {
      id: open.clientShiftId,
      status: "open",
      openingFloat: money(open.openingFloat),
      openedAt: open.openedAt,
      openedByUserId: open.openedByUserId,
      closedByUserId: null,
      closedAt: null,
    };
  }

  private closingReport(before: TillState, counted: number): ShiftReport | null {
    const closedAt = new Date().toISOString();
    const local = tillReport("z", before, counted);
    if (local) return { ...local, closedByUserId: this.cashier?.userId, closedAt };
    const adopted = this.serverShift?.report;
    if (!adopted) return null;
    const expected = adopted.cash.expected;
    return {
      ...adopted,
      kind: "z",
      cash: { expected, counted, variance: expected === null ? null : round2(counted - expected) },
      closedByUserId: this.cashier?.userId,
      closedAt,
    };
  }

  /** Redeems a manager grant (from either the live route or the cached
   *  roster) for the user id the event must carry. Single-use, exactly like
   *  the server's own grants. */
  private spendGrant(grant: string | { permission: string; token: string }[] | undefined, permission: string): string | undefined {
    const token = typeof grant === "string" ? grant : grant?.find((g) => g.permission === permission)?.token;
    if (!token) return undefined;
    return consumeOfflineGrant(this.grantVault, token, permission) ?? undefined;
  }

  /**
   * Picks up a drawer this device has open server-side that the local log
   * knows nothing about — an upgrade from the online-only build, or a shift
   * opened before this one. Only ever consulted when there is no local
   * drawer; a local one always wins, because its events are the ones the
   * server has yet to see.
   */
  private async adoptServerShift(): Promise<void> {
    if (this.till.openShift || !this.device || !this.cashier?.token) return;
    try {
      const res = await fetch(`${this.baseUrl}/api/pos/v1/shifts/current`, {
        headers: this.authHeaders(),
        // Bounded: this is the one read a drawer action waits on, and a hung
        // socket must not hold the till.
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return;
      const d = (await res.json()) as { shift: PosShiftSummary | null; report: ShiftReport | null };
      this.serverShift = d.shift ? { shift: d.shift, report: d.report } : null;
    } catch { /* offline: whatever was adopted earlier still stands */ }
  }
}

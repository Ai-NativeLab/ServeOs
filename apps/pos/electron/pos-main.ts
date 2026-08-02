import { app, safeStorage } from "electron";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

// In dev (vite serving), default to the local backend; otherwise the
// configured/placeholder production host. POS_API_URL always wins.
const DEFAULT_BASE_URL = process.env.VITE_DEV_SERVER_URL ? "http://localhost:3000" : "https://app.serveos.com";

type Device = { token: string; tenantId: string; branchId: string; branchName: string };

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
export type Cashier = { token: string; name: string; permissions: string[] };
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
};
export type HeldTicket = { id: string; label: string; draftJson: unknown; createdAt: string };

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

/**
 * Online-first POS glue: talks straight to the cloud backend. No local
 * database — the offline store/sync engine lives (parked) in electron/_offline
 * and can be reintroduced later behind this same surface.
 */
export class PosMain {
  private baseUrl = process.env.POS_API_URL || DEFAULT_BASE_URL;
  private device: Device | null = null;
  /** In memory only: closing the app signs the cashier out but leaves the device paired. */
  private cashier: Cashier | null = null;
  private readonly file = path.join(app.getPath("userData"), "pos-device.json");

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file);
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
      this.device = JSON.parse(json) as Device;
    } catch {
      this.device = null;
    }
  }

  private persist(): void {
    if (!this.device) return;
    const json = JSON.stringify(this.device);
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
    if (this.cashier) h["X-POS-Cashier"] = this.cashier.token;
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

  async getMenu(): Promise<{ json: string; pricing: CheckoutPricing; syncedAt: string } | null> {
    if (!this.device) return null;
    const res = await fetch(`${this.baseUrl}/api/pos/v1/catalog`, { headers: this.authHeaders() });
    if (res.status === 401) {
      this.unpair();
      throw new Error("Device unpaired — please pair again");
    }
    if (!res.ok) throw new Error(`Menu fetch failed (${res.status})`);
    const d = (await res.json()) as { menu: unknown; pricing: CheckoutPricing; syncedAt: string };
    return { json: JSON.stringify(d.menu), pricing: d.pricing, syncedAt: d.syncedAt };
  }

  async signInCashier(email: string, password: string): Promise<{ name: string; permissions: string[] }> {
    if (!this.device) throw new Error("Not paired");
    const res = await fetch(`${this.baseUrl}/api/pos/v1/cashier/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.device.token}` },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Sign-in failed (${res.status})`);
    }
    const d = (await res.json()) as { cashierToken: string; name: string; permissions: string[] };
    this.cashier = { token: d.cashierToken, name: d.name, permissions: d.permissions };
    return { name: d.name, permissions: d.permissions };
  }

  currentCashier(): { name: string; permissions: string[] } | null {
    return this.cashier ? { name: this.cashier.name, permissions: this.cashier.permissions } : null;
  }

  signOutCashier(): void {
    this.cashier = null;
  }

  async authorize(email: string, password: string, permission: string): Promise<{ grant: string; authorizedBy: string }> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/authorize`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ email, password, permission }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Authorization failed (${res.status})`);
    }
    return (await res.json()) as { grant: string; authorizedBy: string };
  }

  async recordSale(input: RecordSaleInput): Promise<SaleReceipt> {
    if (!this.device) throw new Error("Not paired");
    if (!this.cashier) throw new Error("No cashier signed in");
    const res = await fetch(`${this.baseUrl}/api/pos/v1/sales`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ clientOrderId: crypto.randomUUID(), ...input }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      // A 409 means live prices moved under a stale catalog. The renderer must
      // re-pull and make the cashier re-check the cart — never retry silently.
      const e = new Error(err.error ?? `Sale failed (${res.status})`) as Error & { code?: string };
      if (res.status === 409) e.code = "TOTAL_MISMATCH";
      throw e;
    }
    return (await res.json()) as SaleReceipt;
  }

  async holdTicket(label: string, draft: unknown): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/held-tickets`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ label, draft }),
    });
    if (!res.ok) throw new Error(`Could not park the ticket (${res.status})`);
    return (await res.json()) as { id: string };
  }

  async listHeldTickets(): Promise<HeldTicket[]> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/held-tickets`, { headers: this.authHeaders() });
    if (!res.ok) return [];
    const d = (await res.json()) as { tickets: HeldTicket[] };
    return d.tickets;
  }

  async discardTicket(id: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/pos/v1/held-tickets/${id}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
  }

  async getOrders(): Promise<OrderSummary[]> {
    if (!this.device) return [];
    const res = await fetch(`${this.baseUrl}/api/pos/v1/orders/list`, { headers: this.authHeaders() });
    if (!res.ok) return [];
    const d = (await res.json()) as { orders: OrderSummary[] };
    return d.orders;
  }

  async advanceOrder(orderId: string, toStatus: string): Promise<void> {
    if (!this.device) return;
    await fetch(`${this.baseUrl}/api/pos/v1/orders/status`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ orderId, toStatus }),
    });
  }

  /** Maps the drawer routes' status codes onto something the renderer can branch on. */
  private async drawerCall<T>(path: string, init: RequestInit): Promise<DrawerResult<T>> {
    if (!this.device) return { ok: false, code: "error", message: "Not paired" };
    if (!this.cashier) return { ok: false, code: "error", message: "No cashier signed in" };
    try {
      const res = await fetch(`${this.baseUrl}/api/pos/v1/shifts/${path}`, {
        ...init,
        headers: this.authHeaders(),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
      if (res.ok) return { ok: true, data: body as T };
      const code =
        res.status === 403 ? "needs_manager" :
        res.status === 409 ? "conflict" :
        res.status === 400 ? "bad_count" : "error";
      return { ok: false, code, message: body.error ?? `Request failed (${res.status})` };
    } catch (e) {
      return { ok: false, code: "error", message: e instanceof Error ? e.message : "Network error" };
    }
  }

  openShift(openingFloat: number, denominations?: Record<string, number>): Promise<DrawerResult<{ shift: PosShiftSummary }>> {
    return this.drawerCall("open", { method: "POST", body: JSON.stringify({ openingFloat, denominations }) });
  }

  /** The live X-report. Reading it records nothing and never resets. */
  async currentShift(): Promise<{ shift: PosShiftSummary | null; report: ShiftReport | null }> {
    if (!this.device || !this.cashier) return { shift: null, report: null };
    try {
      const res = await fetch(`${this.baseUrl}/api/pos/v1/shifts/current`, { headers: this.authHeaders() });
      if (!res.ok) return { shift: null, report: null };
      return (await res.json()) as { shift: PosShiftSummary | null; report: ShiftReport | null };
    } catch {
      return { shift: null, report: null };
    }
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

  countDrawer(countedTotal: number, denominations?: Record<string, number>): Promise<DrawerResult<{ count: CashCountRow; report: ShiftReport }>> {
    return this.drawerCall("current", { method: "POST", body: JSON.stringify({ countedTotal, denominations }) });
  }

  closeShift(countedTotal: number, denominations?: Record<string, number>, grant?: string): Promise<DrawerResult<{ report: ShiftReport }>> {
    return this.drawerCall("close", {
      method: "POST",
      body: JSON.stringify({
        count: { countedTotal, denominations },
        grants: grant ? [{ permission: "reconciliation:manage", token: grant }] : undefined,
      }),
    });
  }

  cashMovement(input: CashMovementInput): Promise<DrawerResult<{ movement: CashMovementRow }>> {
    const { grant, ...movement } = input;
    return this.drawerCall("movements", {
      method: "POST",
      body: JSON.stringify({
        ...movement,
        grants: grant ? [{ permission: "reconciliation:manage", token: grant }] : undefined,
      }),
    });
  }

  unpair(): void {
    this.device = null;
    this.cashier = null;
    try { fs.unlinkSync(this.file); } catch { /* nothing to remove */ }
  }
}

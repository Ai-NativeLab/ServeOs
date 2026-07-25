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

  unpair(): void {
    this.device = null;
    this.cashier = null;
    try { fs.unlinkSync(this.file); } catch { /* nothing to remove */ }
  }
}

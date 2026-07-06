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

/**
 * Online-first POS glue: talks straight to the cloud backend. No local
 * database — the offline store/sync engine lives (parked) in electron/_offline
 * and can be reintroduced later behind this same surface.
 */
export class PosMain {
  private baseUrl = process.env.POS_API_URL || DEFAULT_BASE_URL;
  private device: Device | null = null;
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
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.device?.token ?? ""}` };
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

  async getMenu(): Promise<{ json: string; syncedAt: string } | null> {
    if (!this.device) return null;
    const res = await fetch(`${this.baseUrl}/api/pos/v1/catalog`, { headers: this.authHeaders() });
    if (res.status === 401) {
      this.unpair();
      throw new Error("Device unpaired — please pair again");
    }
    if (!res.ok) throw new Error(`Menu fetch failed (${res.status})`);
    const d = (await res.json()) as { menu: unknown; syncedAt: string };
    return { json: JSON.stringify(d.menu), syncedAt: d.syncedAt };
  }

  async submitOrder(draft: OrderDraft): Promise<{ orderNumber: string }> {
    if (!this.device) throw new Error("Not paired");
    const clientOrderId = crypto.randomUUID();
    const res = await fetch(`${this.baseUrl}/api/pos/v1/orders`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ clientOrderId, lines: draft.lines, notes: draft.notes }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Order failed (${res.status})`);
    }
    const d = (await res.json()) as { orderNumber: string };
    return { orderNumber: d.orderNumber };
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
    try { fs.unlinkSync(this.file); } catch { /* nothing to remove */ }
  }
}

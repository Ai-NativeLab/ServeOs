import { app, safeStorage } from "electron";
import path from "node:path";
import crypto from "node:crypto";
import { openDb } from "./db";
import { Store } from "./store";
import { SyncEngine, type SyncState } from "./sync";
import { createApiClient } from "./api";

const DEFAULT_BASE_URL = "https://app.serveos.com";

export interface OrderDraft {
  lines: { productId: string; quantity: number; selectedOptionIds: string[] }[];
  notes?: string;
}

export class PosMain {
  private store: Store;
  private engine: SyncEngine;
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.POS_API_URL || DEFAULT_BASE_URL;
    const dbPath = path.join(app.getPath("userData"), "pos.sqlite");
    this.store = new Store(openDb(dbPath));
    this.engine = new SyncEngine(this.store, this.makeClient(), (state, pending) => {
      this.stateCb?.(state, pending);
    });
  }

  private stateCb: ((s: SyncState, pending: number) => void) | null = null;

  private makeClient() {
    return createApiClient(this.baseUrl, () => this.getToken());
  }

  private encryptToken(token: string): string {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(token).toString("base64");
      }
    } catch {
      // fall through to plaintext
    }
    return `plain:${token}`;
  }

  private decryptToken(stored: string | null): string | null {
    if (!stored) return null;
    if (stored.startsWith("plain:")) return stored.slice(6);
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored, "base64"));
      }
    } catch {
      return null;
    }
    return null;
  }

  private getToken(): string | null {
    const dev = this.store.getDevice();
    if (!dev || !dev.token) return null;
    return this.decryptToken(dev.token);
  }

  isPaired(): boolean {
    return this.getToken() != null && this.store.getDevice()?.branch_id != null;
  }

  async pair(code: string): Promise<{ branchName: string }> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      deviceToken: string;
      tenantId: string;
      branchId: string;
      branchName: string;
    };
    this.store.saveDevice({
      token: this.encryptToken(data.deviceToken),
      tenantId: data.tenantId,
      branchId: data.branchId,
      branchName: data.branchName,
    });
    return { branchName: data.branchName };
  }

  getMenu(): { json: string; syncedAt: string } | null {
    return this.store.getCatalog();
  }

  submitOrder(draft: OrderDraft): { clientOrderId: string } {
    const clientOrderId = crypto.randomUUID();
    this.store.enqueueOrder(clientOrderId, JSON.stringify(draft));
    // Kick a flush in the background; do not block the renderer.
    void this.engine.flush();
    return { clientOrderId };
  }

  getTickets() {
    return this.store.allTickets().map((t) => ({
      client_order_id: t.client_order_id,
      status: t.status,
      order_number: t.order_number,
    }));
  }

  onState(cb: (s: SyncState, pending: number) => void): void {
    this.stateCb = cb;
  }

  async tick(): Promise<void> {
    if (!this.isPaired()) return;
    try {
      await this.engine.pull();
    } catch {
      // pull() swallows network errors; non-network errors are surfaced via state
    }
    try {
      await this.engine.flush();
    } catch {
      // flush() never throws (errors handled per-order)
    }
  }
}

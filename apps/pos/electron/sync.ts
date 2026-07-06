import type { Store } from "./store";

export type SyncState = "online" | "offline" | "syncing";

export interface PosApiClient {
  getCatalog(): Promise<{ menu: unknown; syncedAt: string }>;
  postOrder(body: {
    clientOrderId: string;
    lines: unknown[];
    notes?: string;
  }): Promise<{ orderId: string; orderNumber: string }>;
}

interface NetworkError extends Error {
  isNetwork?: boolean;
}

export class SyncEngine {
  constructor(
    private store: Store,
    private api: PosApiClient,
    private onState: (s: SyncState, pending: number) => void,
  ) {}

  private emit(state: SyncState): void {
    this.onState(state, this.store.pendingOrders().length);
  }

  async pull(): Promise<void> {
    this.emit("syncing");
    try {
      const { menu, syncedAt } = await this.api.getCatalog();
      this.store.saveCatalog(JSON.stringify(menu), syncedAt);
      this.emit("online");
    } catch (e) {
      if ((e as NetworkError).isNetwork) {
        this.emit("offline");
      } else {
        this.emit("online");
        throw e;
      }
    }
  }

  async flush(): Promise<void> {
    this.emit("syncing");
    const pending = this.store.pendingOrders();
    let offline = false;
    for (const row of pending) {
      let body: { clientOrderId: string; lines: unknown[]; notes?: string };
      try {
        body = JSON.parse(row.draft_json);
      } catch {
        this.store.markFailed(row.client_order_id, "Invalid draft JSON");
        continue;
      }
      try {
        const res = await this.api.postOrder({
          clientOrderId: row.client_order_id,
          lines: body.lines ?? [],
          notes: body.notes,
        });
        this.store.markSynced(row.client_order_id, res.orderNumber);
      } catch (e) {
        if ((e as NetworkError).isNetwork) {
          offline = true;
        } else {
          this.store.markFailed(row.client_order_id, (e as Error).message);
        }
      }
    }
    this.emit(offline ? "offline" : "online");
  }
}

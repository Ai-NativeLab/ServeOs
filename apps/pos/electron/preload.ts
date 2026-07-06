import { contextBridge, ipcRenderer } from "electron";

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

export type PosLoginResult =
  | { status: "branch_required"; branches: { id: string; name: string }[] }
  | { status: "paired"; branchName: string };

export interface PosBridge {
  isPaired(): Promise<boolean>;
  branchName(): Promise<string>;
  pair(code: string): Promise<{ branchName: string }>;
  login(slug: string, email: string, password: string, branchId?: string): Promise<PosLoginResult>;
  getMenu(): Promise<{ json: string; syncedAt: string } | null>;
  submitOrder(draft: {
    lines: { productId: string; quantity: number; selectedOptionIds: string[] }[];
    notes?: string;
  }): Promise<{ orderNumber: string }>;
  getOrders(): Promise<OrderSummary[]>;
  advanceOrder(orderId: string, toStatus: string): Promise<void>;
}

contextBridge.exposeInMainWorld("pos", {
  isPaired: () => ipcRenderer.invoke("pos:isPaired"),
  branchName: () => ipcRenderer.invoke("pos:branchName"),
  pair: (code: string) => ipcRenderer.invoke("pos:pair", code),
  login: (slug: string, email: string, password: string, branchId?: string) =>
    ipcRenderer.invoke("pos:login", slug, email, password, branchId),
  getMenu: () => ipcRenderer.invoke("pos:getMenu"),
  submitOrder: (draft: Parameters<PosBridge["submitOrder"]>[0]) => ipcRenderer.invoke("pos:submitOrder", draft),
  getOrders: () => ipcRenderer.invoke("pos:getOrders"),
  advanceOrder: (orderId: string, toStatus: string) => ipcRenderer.invoke("pos:advanceOrder", orderId, toStatus),
} satisfies PosBridge);

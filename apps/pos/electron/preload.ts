import { contextBridge, ipcRenderer } from "electron";

export interface PosBridge {
  isPaired(): Promise<boolean>;
  pair(code: string): Promise<{ branchName: string }>;
  getMenu(): Promise<{ json: string; syncedAt: string } | null>;
  submitOrder(draft: {
    lines: { productId: string; quantity: number; selectedOptionIds: string[] }[];
    notes?: string;
  }): Promise<{ clientOrderId: string }>;
  getTickets(): Promise<
    Array<{ client_order_id: string; status: string; order_number: string | null }>
  >;
  onState(cb: (s: "online" | "offline" | "syncing", pending: number) => void): void;
}

contextBridge.exposeInMainWorld("pos", {
  isPaired: () => ipcRenderer.invoke("pos:isPaired"),
  pair: (code: string) => ipcRenderer.invoke("pos:pair", code),
  getMenu: () => ipcRenderer.invoke("pos:getMenu"),
  submitOrder: (draft: Parameters<PosBridge["submitOrder"]>[0]) =>
    ipcRenderer.invoke("pos:submitOrder", draft),
  getTickets: () => ipcRenderer.invoke("pos:getTickets"),
  onState: (cb: Parameters<PosBridge["onState"]>[0]) => {
    ipcRenderer.on("pos:state", (_e, state, pending) => cb(state, pending));
  },
} satisfies PosBridge);

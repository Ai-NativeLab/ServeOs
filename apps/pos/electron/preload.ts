import { contextBridge, ipcRenderer } from "electron";
import type {
  CheckoutPricing,
  RecordSaleInput,
  SaleReceipt,
  HeldTicket,
  PosShiftSummary,
  ShiftReport,
  CashCountRow,
  CashMovementRow,
  CashMovementInput,
  DrawerResult,
  DayReport,
  DayZReport,
  SalesSearch,
  SalesRow,
  SaleDetail,
  RefundSaleInput,
  RefundSaleResult,
  ReprintReceipt,
  SyncStatus,
} from "./pos-main";

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

export type CashierInfo = { name: string; permissions: string[] };

export type {
  SalesSearch,
  SalesRow,
  SaleDetail,
  RefundSaleInput,
  RefundSaleResult,
  ReprintReceipt,
  SyncStatus,
} from "./pos-main";

export interface PosBridge {
  isPaired(): Promise<boolean>;
  branchName(): Promise<string>;
  pair(code: string): Promise<{ branchName: string }>;
  login(slug: string, email: string, password: string, branchId?: string): Promise<PosLoginResult>;
  getMenu(): Promise<{ json: string; pricing: CheckoutPricing; syncedAt: string } | null>;
  getOrders(): Promise<OrderSummary[]>;
  advanceOrder(orderId: string, toStatus: string): Promise<void>;
  listSales(search?: SalesSearch): Promise<SalesRow[]>;
  getSale(orderId: string): Promise<SaleDetail>;
  reprintReceipt(orderId: string): Promise<ReprintReceipt>;
  refundSale(input: RefundSaleInput): Promise<RefundSaleResult>;
  signInCashier(email: string, password: string): Promise<CashierInfo>;
  cashier(): Promise<CashierInfo | null>;
  signOutCashier(): Promise<void>;
  authorize(email: string, password: string, permission: string): Promise<{ grant: string; authorizedBy: string }>;
  recordSale(input: RecordSaleInput): Promise<SaleReceipt>;
  holdTicket(label: string, draft: unknown): Promise<{ id: string }>;
  listHeldTickets(): Promise<HeldTicket[]>;
  discardTicket(id: string): Promise<void>;
  openShift(openingFloat: number, denominations?: Record<string, number>): Promise<DrawerResult<{ shift: PosShiftSummary }>>;
  currentShift(): Promise<{ shift: PosShiftSummary | null; report: ShiftReport | null }>;
  countDrawer(countedTotal: number, denominations?: Record<string, number>): Promise<DrawerResult<{ count: CashCountRow; report: ShiftReport }>>;
  closeShift(countedTotal: number, denominations?: Record<string, number>, grant?: string): Promise<DrawerResult<{ report: ShiftReport }>>;
  cashMovement(input: CashMovementInput): Promise<DrawerResult<{ movement: CashMovementRow }>>;
  xReport(): Promise<DayReport | null>;
  zReport(shiftId?: string): Promise<DayZReport | null>;
  /** Current connectivity/queue state. Cheap — it reads local state only. */
  syncState(): Promise<SyncStatus>;
  /** Pushes on every change (Task 11's badge). Returns the unsubscribe. */
  onSyncState(cb: (status: SyncStatus) => void): () => void;
  /** Clears a sticky halt: the refused event goes back to pending and the
   *  queue resumes from its seq. */
  retryFailedSync(): Promise<SyncStatus>;
}

contextBridge.exposeInMainWorld("pos", {
  isPaired: () => ipcRenderer.invoke("pos:isPaired"),
  branchName: () => ipcRenderer.invoke("pos:branchName"),
  pair: (code: string) => ipcRenderer.invoke("pos:pair", code),
  login: (slug: string, email: string, password: string, branchId?: string) =>
    ipcRenderer.invoke("pos:login", slug, email, password, branchId),
  getMenu: () => ipcRenderer.invoke("pos:getMenu"),
  getOrders: () => ipcRenderer.invoke("pos:getOrders"),
  advanceOrder: (orderId: string, toStatus: string) => ipcRenderer.invoke("pos:advanceOrder", orderId, toStatus),
  listSales: (search?: SalesSearch) => ipcRenderer.invoke("pos:listSales", search),
  getSale: (orderId: string) => ipcRenderer.invoke("pos:getSale", orderId),
  reprintReceipt: (orderId: string) => ipcRenderer.invoke("pos:reprintReceipt", orderId),
  refundSale: (input: RefundSaleInput) => ipcRenderer.invoke("pos:refundSale", input),
  signInCashier: (email: string, password: string) => ipcRenderer.invoke("pos:signInCashier", email, password),
  cashier: () => ipcRenderer.invoke("pos:cashier"),
  signOutCashier: () => ipcRenderer.invoke("pos:signOutCashier"),
  authorize: (email: string, password: string, permission: string) =>
    ipcRenderer.invoke("pos:authorize", email, password, permission),
  recordSale: (input: RecordSaleInput) => ipcRenderer.invoke("pos:recordSale", input),
  holdTicket: (label: string, draft: unknown) => ipcRenderer.invoke("pos:holdTicket", label, draft),
  listHeldTickets: () => ipcRenderer.invoke("pos:listHeldTickets"),
  discardTicket: (id: string) => ipcRenderer.invoke("pos:discardTicket", id),
  openShift: (openingFloat: number, denominations?: Record<string, number>) =>
    ipcRenderer.invoke("pos:openShift", openingFloat, denominations),
  currentShift: () => ipcRenderer.invoke("pos:currentShift"),
  countDrawer: (countedTotal: number, denominations?: Record<string, number>) =>
    ipcRenderer.invoke("pos:countDrawer", countedTotal, denominations),
  closeShift: (countedTotal: number, denominations?: Record<string, number>, grant?: string) =>
    ipcRenderer.invoke("pos:closeShift", countedTotal, denominations, grant),
  cashMovement: (input: CashMovementInput) => ipcRenderer.invoke("pos:cashMovement", input),
  xReport: () => ipcRenderer.invoke("pos:xReport"),
  zReport: (shiftId?: string) => ipcRenderer.invoke("pos:zReport", shiftId),
  syncState: () => ipcRenderer.invoke("pos:syncState"),
  onSyncState: (cb: (status: SyncStatus) => void) => {
    // The IpcRendererEvent never crosses the bridge — a renderer callback that
    // received it would hold a handle to the sender.
    const listener = (_e: unknown, status: SyncStatus) => cb(status);
    ipcRenderer.on("pos:syncState", listener);
    return () => ipcRenderer.removeListener("pos:syncState", listener);
  },
  retryFailedSync: () => ipcRenderer.invoke("pos:retryFailedSync"),
} satisfies PosBridge);

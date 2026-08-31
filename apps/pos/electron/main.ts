import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { PosMain, type RecordSaleInput, type CashMovementInput } from "./pos-main";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let posMain: PosMain | null = null;
let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
}

app.whenReady().then(() => {
  // The engine pushes state changes; the window may not exist yet on the very
  // first one, and a destroyed one must never be sent to.
  posMain = new PosMain(
    (status) => {
      if (win && !win.isDestroyed()) win.webContents.send("pos:syncState", status);
    },
    // Main owns the tenant subscription; the renderer receives the signal
    // only — never the Supabase url, key or token.
    (message) => {
      if (win && !win.isDestroyed()) win.webContents.send("pos:realtimeEvent", message);
    },
  );

  ipcMain.handle("pos:isPaired", () => posMain?.isPaired() ?? false);
  ipcMain.handle("pos:branchName", () => posMain?.branchName() ?? "");
  ipcMain.handle("pos:pair", (_e, code: string) => posMain!.pair(code));
  ipcMain.handle("pos:login", (_e, slug: string, email: string, password: string, branchId?: string) =>
    posMain!.login(slug, email, password, branchId));
  ipcMain.handle("pos:getMenu", () => posMain!.getMenu());
  ipcMain.handle("pos:getOrders", () => posMain!.getOrders());
  ipcMain.handle("pos:advanceOrder", (_e, orderId: string, toStatus: string) => posMain!.advanceOrder(orderId, toStatus));
  ipcMain.handle("pos:listSales", (_e, search: Parameters<PosMain["listSales"]>[0]) => posMain!.listSales(search));
  ipcMain.handle("pos:getSale", (_e, orderId: string) => posMain!.getSale(orderId));
  ipcMain.handle("pos:reprintReceipt", (_e, orderId: string) => posMain!.reprintReceipt(orderId));
  ipcMain.handle("pos:saleFiscalStatus", (_e, orderId: string) => posMain!.saleFiscalStatus(orderId));
  ipcMain.handle("pos:refundSale", (_e, input: Parameters<PosMain["refundSale"]>[0]) => posMain!.refundSale(input));
  ipcMain.handle("pos:signInCashier", (_e, email: string, password: string) => posMain!.signInCashier(email, password));
  ipcMain.handle("pos:cashier", () => posMain!.currentCashier());
  ipcMain.handle("pos:signOutCashier", () => posMain!.signOutCashier());
  ipcMain.handle("pos:authorize", (_e, email: string, password: string, permission: string) =>
    posMain!.authorize(email, password, permission));
  ipcMain.handle("pos:recordSale", (_e, input: RecordSaleInput) => posMain!.recordSale(input));
  ipcMain.handle("pos:holdTicket", (_e, label: string, draft: unknown) => posMain!.holdTicket(label, draft));
  ipcMain.handle("pos:listHeldTickets", () => posMain!.listHeldTickets());
  ipcMain.handle("pos:discardTicket", (_e, id: string) => posMain!.discardTicket(id));
  ipcMain.handle("pos:openShift", (_e, openingFloat: number, denominations?: Record<string, number>) =>
    posMain!.openShift(openingFloat, denominations));
  ipcMain.handle("pos:currentShift", () => posMain!.currentShift());
  ipcMain.handle("pos:countDrawer", (_e, countedTotal: number, denominations?: Record<string, number>) =>
    posMain!.countDrawer(countedTotal, denominations));
  ipcMain.handle("pos:closeShift", (_e, countedTotal: number, denominations?: Record<string, number>, grant?: string) =>
    posMain!.closeShift(countedTotal, denominations, grant));
  ipcMain.handle("pos:cashMovement", (_e, input: CashMovementInput) => posMain!.cashMovement(input));
  ipcMain.handle("pos:xReport", () => posMain!.xReport());
  ipcMain.handle("pos:zReport", (_e, shiftId?: string) => posMain!.zReport(shiftId));
  ipcMain.handle("pos:syncState", () => posMain!.syncState());
  ipcMain.handle("pos:retryFailedSync", () => posMain!.retryFailedSync());

  createWindow();
  // Started after the window exists so the first state push has somewhere to
  // land; nothing here blocks the first render either way.
  posMain.start();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => posMain?.stop());
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

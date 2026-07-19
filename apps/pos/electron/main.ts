import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { PosMain, type RecordSaleInput } from "./pos-main";

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
  posMain = new PosMain();

  ipcMain.handle("pos:isPaired", () => posMain?.isPaired() ?? false);
  ipcMain.handle("pos:branchName", () => posMain?.branchName() ?? "");
  ipcMain.handle("pos:pair", (_e, code: string) => posMain!.pair(code));
  ipcMain.handle("pos:login", (_e, slug: string, email: string, password: string, branchId?: string) =>
    posMain!.login(slug, email, password, branchId));
  ipcMain.handle("pos:getMenu", () => posMain!.getMenu());
  ipcMain.handle("pos:getOrders", () => posMain!.getOrders());
  ipcMain.handle("pos:advanceOrder", (_e, orderId: string, toStatus: string) => posMain!.advanceOrder(orderId, toStatus));
  ipcMain.handle("pos:signInCashier", (_e, email: string, password: string) => posMain!.signInCashier(email, password));
  ipcMain.handle("pos:cashier", () => posMain!.currentCashier());
  ipcMain.handle("pos:signOutCashier", () => posMain!.signOutCashier());
  ipcMain.handle("pos:authorize", (_e, email: string, password: string, permission: string) =>
    posMain!.authorize(email, password, permission));
  ipcMain.handle("pos:recordSale", (_e, input: RecordSaleInput) => posMain!.recordSale(input));
  ipcMain.handle("pos:holdTicket", (_e, label: string, draft: unknown) => posMain!.holdTicket(label, draft));
  ipcMain.handle("pos:listHeldTickets", () => posMain!.listHeldTickets());
  ipcMain.handle("pos:discardTicket", (_e, id: string) => posMain!.discardTicket(id));

  createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

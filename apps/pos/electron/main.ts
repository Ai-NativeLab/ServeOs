import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { PosMain } from "./pos-main";

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
  posMain.onState((state, pending) => {
    win?.webContents.send("pos:state", state, pending);
  });

  ipcMain.handle("pos:isPaired", () => posMain?.isPaired() ?? false);
  ipcMain.handle("pos:pair", (_e, code: string) => posMain?.pair(code));
  ipcMain.handle("pos:getMenu", () => posMain?.getMenu() ?? null);
  ipcMain.handle("pos:submitOrder", (_e, draft) => posMain?.submitOrder(draft));
  ipcMain.handle("pos:getTickets", () => posMain?.getTickets() ?? []);

  createWindow();

  setInterval(() => {
    void posMain?.tick();
  }, 15000);
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

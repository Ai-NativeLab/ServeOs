import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("pos", {
  ping: () => "pong",
});

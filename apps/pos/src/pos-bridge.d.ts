import type { PosBridge } from "../electron/preload";

export {};
declare global {
  interface Window {
    pos: PosBridge;
  }
}

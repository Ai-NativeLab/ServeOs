import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Neither `electron` nor `electron-updater` can run outside an Electron
// process, so both are replaced by the smallest fakes the updater touches.
const h = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const handlers = new Map<string, Handler[]>();
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null as null | { info(m?: unknown): void; warn(m?: unknown): void; error(m?: unknown): void },
    on: (event: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return autoUpdater;
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
    checkForUpdates: (() => Promise.resolve(null)) as () => Promise<unknown>,
    quitAndInstall: () => {},
  };
  return { autoUpdater, handlers, app: { isPackaged: true, getPath: (_name: string): string => "" } };
});

vi.mock("electron", () => ({ app: h.app }));
vi.mock("electron-updater", () => ({ autoUpdater: h.autoUpdater }));

import { createFileLogger, initAutoUpdate } from "./updater";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
let logsDir: string;

const logText = () => {
  const file = path.join(logsDir, "updater.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

beforeEach(() => {
  // Only the interval is faked; setImmediate stays real so the rejection test
  // can let Node's unhandled-rejection check run.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  logsDir = mkdtempSync(path.join(tmpdir(), "pos-updater-"));
  h.app.isPackaged = true;
  h.app.getPath = () => logsDir;
  h.handlers.clear();
  h.autoUpdater.logger = null;
  h.autoUpdater.autoDownload = false;
  h.autoUpdater.autoInstallOnAppQuit = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(logsDir, { recursive: true, force: true });
});

describe("initAutoUpdate", () => {
  it("does nothing in an unpackaged (dev) run", () => {
    h.app.isPackaged = false;
    const check = vi.spyOn(h.autoUpdater, "checkForUpdates");

    initAutoUpdate();
    vi.advanceTimersByTime(SIX_HOURS_MS * 2);

    expect(check).not.toHaveBeenCalled();
    expect(h.autoUpdater.logger).toBeNull();
  });

  it("checks at launch and every six hours, installing only on quit", async () => {
    const check = vi.spyOn(h.autoUpdater, "checkForUpdates");
    const quitAndInstall = vi.spyOn(h.autoUpdater, "quitAndInstall");

    initAutoUpdate();
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SIX_HOURS_MS);
    expect(check).toHaveBeenCalledTimes(2);

    expect(h.autoUpdater.autoDownload).toBe(true);
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(true);

    // A staged update must never restart the till mid-shift.
    h.autoUpdater.emit("update-downloaded", { version: "9.9.9" });
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(logText()).toContain("9.9.9 staged; installs on next quit");
  });

  it("swallows a failed check and logs it to the file exactly once", async () => {
    // Mirrors the real AppUpdater.checkForUpdates: on failure it emits 'error'
    // — which its own constructor-registered listener writes to
    // `autoUpdater.logger` — and then rejects with the same error.
    vi.spyOn(h.autoUpdater, "checkForUpdates").mockImplementation(() => {
      const err = new Error("getaddrinfo ENOTFOUND github.com");
      h.autoUpdater.logger?.error(`Error: ${err.message}`);
      h.autoUpdater.emit("error", err);
      return Promise.reject(err);
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      initAutoUpdate();
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(logText().match(/ENOTFOUND/g)).toHaveLength(1);
  });

  it("keeps a listener on 'error' so an emitted error can never throw", () => {
    initAutoUpdate();
    expect(h.handlers.get("error")?.length ?? 0).toBeGreaterThan(0);
    expect(() => h.autoUpdater.emit("error", new Error("boom"))).not.toThrow();
  });
});

describe("createFileLogger", () => {
  it("appends timestamped, levelled lines", () => {
    const file = path.join(logsDir, "nested", "updater.log");
    const log = createFileLogger(file);

    log.info("Checking for update");
    log.error(new Error("bad feed"));

    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT\S+ INFO Checking for update\n/);
    // Errors keep their stack: it is the only trace a field failure leaves.
    expect(text).toMatch(/\n\d{4}-\d\d-\d\dT\S+ ERROR Error: bad feed\n\s+at /);
  });

  it("never throws when the log cannot be written", () => {
    // A file where a directory should be: mkdir and append both fail.
    const blocker = path.join(logsDir, "blocker");
    createFileLogger(blocker).info("make it a file");
    const log = createFileLogger(path.join(blocker, "updater.log"));

    expect(() => log.error("lost")).not.toThrow();
  });
});

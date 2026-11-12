import { app } from "electron";
import { autoUpdater, type Logger } from "electron-updater";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;

/**
 * Background auto-update against the GitHub Releases the pos-release workflow
 * publishes. The `publish` block in package.json is what puts latest-mac.yml /
 * latest.yml beside the installers and app-update.yml inside the bundle; this
 * reads them.
 *
 * The till's constraint drives every choice here: **it must never interrupt a
 * shift.** A restart between taking a customer's money and printing their
 * receipt is worse than running an old version for another day. So the update
 * downloads quietly in the background and is swapped in on the next quit —
 * whenever the venue closes and someone shuts the terminal down. Nothing is
 * ever prompted, and `quitAndInstall` is deliberately never called.
 *
 * Failures are logged and swallowed. An unreachable update server, a rate
 * limit, or a malformed feed must not take the till down; selling is the job,
 * updating is a convenience. The log is a file — `updater.log` in Electron's
 * logs directory, ~/Library/Logs/pos/ on macOS and %APPDATA%\pos\logs\ on
 * Windows (named after the package `name`) — because a packaged GUI app has no
 * console anyone reads.
 *
 * **macOS does not update yet, and needs more than a certificate to start.**
 * Squirrel.Mac refuses to apply an update unless the running app carries a
 * valid Developer ID signature, and ours is ad-hoc (see
 * build/adhoc-sign-mac.mjs — enough to clear the "damaged" wall, not a real
 * identity). The check fails with a code-signature error and is logged. Once
 * the notarization secrets in docs/pos-code-signing.md are in place, the next
 * signed release updates from the `.zip` the mac build emits beside the `.dmg`
 * (MacUpdater installs from the zip, never the dmg). Tills still running an
 * ad-hoc build cannot take that update — each needs one manual install of the
 * first signed release. Windows updates work now: NSIS has no equivalent
 * requirement.
 */
export function initAutoUpdate(): void {
  // `npm run pos:dev` serves from vite and has no packaged bundle to replace;
  // electron-updater would throw looking for dev-app-update.yml.
  if (!app.isPackaged) return;

  // electron-updater narrates its own work (checking, found version, download
  // URL) and — from a listener it registers on itself — writes every 'error'
  // event to this logger with its stack. That covers both failure paths, so
  // nothing below logs an error a second time.
  autoUpdater.logger = createFileLogger(path.join(app.getPath("logs"), "updater.log"));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", (info) => {
    autoUpdater.logger?.info(`${info.version} staged; installs on next quit`);
  });
  // Already logged by electron-updater's own listener. This one exists so an
  // 'error' event can never be the unhandled kind, which EventEmitter throws.
  autoUpdater.on("error", () => {});

  const check = () => {
    // The promise rejects for the same failures that emit 'error', so it is
    // only swallowed here — the log line came from the event.
    autoUpdater.checkForUpdates().catch(() => {});
  };

  check();
  // A till can stay open for days at a time, so a launch-only check would never
  // fire in the venues that most need patching.
  setInterval(check, SIX_HOURS_MS);
}

/**
 * The smallest logger electron-updater accepts: one appended line per message,
 * rolled over to `<name>.old` at 1 MB so a till that runs for years cannot fill
 * its disk. It never throws — a log that cannot be written is not a reason to
 * stop the till.
 */
export function createFileLogger(file: string): Logger {
  const write = (level: string, message: unknown) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.old`);
      } catch {
        // No file yet — nothing to roll over.
      }
      const text = message instanceof Error ? message.stack ?? message.message : String(message);
      appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch {
      // Unwritable log directory: drop the line rather than the till.
    }
  };
  return {
    info: (m) => write("INFO", m),
    warn: (m) => write("WARN", m),
    error: (m) => write("ERROR", m),
  };
}

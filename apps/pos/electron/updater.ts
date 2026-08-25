import { app } from "electron";
import { autoUpdater } from "electron-updater";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

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
 * updating is a convenience.
 *
 * **macOS does not work yet, by design of the platform.** Squirrel.Mac refuses
 * to apply an update unless the running app carries a valid Developer ID
 * signature, and ours is ad-hoc (see build/adhoc-sign-mac.mjs — enough to clear
 * the "damaged" wall, not a real identity). The check will fail with a code
 * signature error and be logged. It starts working the day the notarization
 * secrets described in docs/pos-code-signing.md are in place, with no code
 * change here. Windows updates work now: NSIS has no equivalent requirement.
 */
export function initAutoUpdate(): void {
  // `npm run pos:dev` serves from vite and has no packaged bundle to replace;
  // electron-updater would throw looking for dev-app-update.yml.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] ${info.version} available, downloading in background`);
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] ${info.version} staged; installs on next quit`);
  });
  autoUpdater.on("error", (err) => {
    console.error("[updater] check failed:", err instanceof Error ? err.message : err);
  });

  const check = () => {
    // Both arms matter: the promise rejects for network/feed errors, and the
    // 'error' event fires for others. Neither may reach the operator.
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.error("[updater] check failed:", err instanceof Error ? err.message : err);
    });
  };

  check();
  // A till can stay open for days at a time, so a launch-only check would never
  // fire in the venues that most need patching.
  setInterval(check, SIX_HOURS_MS);
}

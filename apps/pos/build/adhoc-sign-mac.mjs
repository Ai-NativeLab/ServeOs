// electron-builder afterPack hook: give the unsigned macOS build a *valid*
// ad-hoc signature.
//
// `mac.identity: null` makes electron-builder skip signing altogether
// (macPackager.sign() logs "skipped macOS code signing" and returns false — v25
// has no ad-hoc fallback). What ships is then not "unsigned" in the harmless
// sense: the .app still carries the Electron binary's own linker-signed ad-hoc
// signature, over a resource set that packaging has since changed. The result
// fails validation outright —
//
//   $ codesign --verify --deep --strict "ServeOS POS.app"
//   code has no resources but signature indicates they must be present
//
// — and that distinction decides which Gatekeeper wall a customer hits. A valid
// signature without a Developer ID gives "cannot be opened because the developer
// cannot be verified", which right-click → Open bypasses; that is what the
// release notes tell people to do. A *broken* signature gives "is damaged and
// can't be opened. You should move it to the Trash", which right-click → Open
// does not bypass — the download is simply dead.
//
// Re-signing ad-hoc costs nothing, needs no certificate, and puts the build back
// on the documented path. It is not a substitute for a Developer ID: the app is
// still unnotarized, and `syspolicy_check distribution` still reports the missing
// notary ticket as fatal for real distribution.
//
// This file is .mjs, not .cjs, so it can use imports: electron-builder's
// resolveModule dynamically imports .mjs and only falls back to require() for
// other extensions.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") return;

  // The day a real certificate exists, electron-builder signs with the Developer
  // ID before hooks run — and re-signing ad-hoc here would silently replace that
  // identity with none, so notarization would reject the upload and the reason
  // would be nowhere near this file. Stand down whenever credentials are
  // present. See docs/pos-code-signing.md.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log("  • ad-hoc signing skipped  reason=signing credentials present");
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // --deep is the wrong tool for Developer ID distribution, where each nested
  // helper and framework wants signing on its own terms. For an ad-hoc pass it
  // is the right one: no entitlements, no identity, and every nested Mach-O in
  // the bundle needs to end up sealed under the same (empty) identity.
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath]);

  // Verify rather than assume. A hook that silently no-ops would leave exactly
  // the failure it exists to prevent, and the build is the last place anyone
  // looks once a DMG is on a customer's machine.
  await run("codesign", ["--verify", "--deep", "--strict", appPath]);
}

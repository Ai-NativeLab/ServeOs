# Signing and notarizing the POS

**Status:** not done. Blocked on an Apple Developer Program membership, not on
engineering — every code change this needs is already in place; what remains
is secrets plus the config and workflow edits in steps 5–6. This is the runbook
for whoever has the account.

## What being unsigned actually costs

| | Today (ad-hoc signed) | Signed + notarized |
|---|---|---|
| macOS first launch | "developer cannot be verified" → right-click → **Open** | opens normally |
| Windows first launch | SmartScreen "unknown publisher" → **More info → Run anyway** | opens normally |
| macOS auto-update | **does not work** — Squirrel.Mac refuses to update an app without a Developer ID | works, from the release's `.zip` (after one manual install — see below) |
| Windows auto-update | works | works |

The macOS auto-update line is the expensive one. Every mac till has to be
updated by hand until this is done, which for a fleet means someone visiting
each venue.

> The builds are *ad-hoc signed*, not unsigned — see `apps/pos/build/adhoc-sign-mac.mjs`.
> That distinction is what keeps macOS at "cannot be verified" (which
> right-click → Open bypasses) rather than "is damaged and can't be opened"
> (which it does not). Do not remove that hook while the app is unsigned.

## macOS

**1. Membership** — Apple Developer Program, $99/yr, at
<https://developer.apple.com/programs/>. An individual account is enough; an
organization account needs a D-U-N-S number and takes longer.

**2. Certificate** — create a **Developer ID Application** certificate (Xcode →
Settings → Accounts → Manage Certificates, or the Certificates section of the
developer portal). Export it from Keychain Access as a `.p12` with a password,
then base64 it:

```bash
base64 -i DeveloperID.p12 | pbcopy
```

**3. Notarization credentials** — prefer an App Store Connect API key over an
Apple ID: it survives password rotations and 2FA changes. App Store Connect →
Users and Access → Integrations → generate a key with **Developer** access, and
download the `.p8` once.

**4. GitHub secrets** — repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `CSC_LINK` | the base64 `.p12` from step 2 |
| `CSC_KEY_PASSWORD` | the password used on export |
| `APPLE_API_KEY_P8_B64` | base64 of the `.p8` (`base64 -i AuthKey_ABC123DEFG.p8 \| pbcopy`) |
| `APPLE_API_KEY_ID` | the key ID (`ABC123DEFG`) |
| `APPLE_API_ISSUER` | the issuer UUID from App Store Connect |

Note the `.p8` secret is **not** called `APPLE_API_KEY`. electron-builder hands
`APPLE_API_KEY` to `@electron/notarize`, which reads it as a **path to the
`.p8` file** — the key's contents in that variable fail notarization. The
workflow decodes the secret to a file and points `APPLE_API_KEY` at it (step 6).

**5. Config** — in `apps/pos/package.json`, delete `mac.identity: null` and add:

```json
"hardenedRuntime": true,
"notarize": true
```

Hardened runtime is mandatory for notarization; electron-builder supplies the
JIT entitlements Electron needs. Nothing else changes — `adhoc-sign-mac.mjs`
detects `CSC_LINK` and stands down on its own, so the real signature is not
overwritten.

**6. Workflow** — in `.github/workflows/pos-release.yml`, replace the single
`Build installers` step with one step per OS. The scoping is not tidiness — see
the warning below.

```yaml
      # electron-builder / @electron/notarize want APPLE_API_KEY to be a path
      # to the .p8, so the key is written to the runner's temp dir first.
      - name: Write App Store Connect key
        if: runner.os == 'macOS'
        shell: bash
        env:
          APPLE_API_KEY_P8_B64: ${{ secrets.APPLE_API_KEY_P8_B64 }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
        run: |
          key="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"
          printf '%s' "$APPLE_API_KEY_P8_B64" | base64 --decode > "$key"
          echo "APPLE_API_KEY=$key" >> "$GITHUB_ENV"

      - name: Build installers (macOS — signed + notarized)
        if: runner.os == 'macOS'
        run: npm run pos:build
        env:
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          # APPLE_API_KEY comes from $GITHUB_ENV, set by the step above.

      - name: Build installers (Windows)
        if: runner.os == 'Windows'
        run: npm run pos:build
        # No CSC_LINK here, ever. Add WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD
        # once the Windows certificate exists (see "Windows" below).
```

> **Never let `CSC_LINK` reach the Windows build.** When `WIN_CSC_LINK` is
> unset, electron-builder on Windows falls back to `CSC_LINK` and signs the
> installer with the Apple `.p12`. It also bakes that certificate's subject into
> `publisherName` in the shipped `app-update.yml`, and from then on every till
> rejects any update not signed by that same subject — so the day a real
> Windows certificate arrives, Windows auto-update stops dead. Job-level or
> unconditional step-level `env` both cause this.

Secrets are not exposed to workflows triggered from forks, which is fine here —
releases are cut from tags on this repo.

**7. Verify** — on the built `.app`, not the DMG:

```bash
codesign --verify --deep --strict --verbose=2 "ServeOS POS.app"
spctl -a -vvv -t install "ServeOS POS.app"     # expect: accepted, source=Notarized Developer ID
xcrun stapler validate "ServeOS POS.app"       # expect: The validate action worked!
```

Notarization runs during the build and adds a few minutes; Apple occasionally
queues for longer.

## Windows

An OV certificate (~$200-400/yr) clears SmartScreen's "unknown publisher"
warning. Add `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` as secrets and pass them
to the **Windows** build step only (step 6 above) — no config change needed,
electron-builder picks them up.

Note that EV certificates ship on hardware tokens and cannot be used from a CI
runner. If you want EV, use a cloud signing service (Azure Trusted Signing,
DigiCert KeyLocker) rather than a token.

**The certificate subject must stay stable across renewals.** The first signed
build writes the certificate's subject into `publisherName` in the shipped
`app-update.yml`, and electron-updater refuses any later update whose
signature does not match it. Renew with the same legal entity name and CN.
If the subject has to change (new company name, new CA that formats it
differently), ship one transitional release, signed with the *old*
certificate, whose `win.signtoolOptions.publisherName` lists **both** subjects;
only then switch certificates. Unsigned tills have no `publisherName` and accept
the first signed release without fuss.

Until then, Windows updates are verified against nothing but the SHA-512 in
`latest.yml` — which is fetched from the same release as the installer, so it
proves the download is intact, not who made it. That, and the lack of any
rollback, is why releases are promoted by hand (see "Releasing" below).

## After it lands

macOS auto-update needs two things, and the certificate is only one of them:

- **The `.zip`.** MacUpdater installs from a zip and never from a dmg. The mac
  build emits a zip per arch beside each DMG and the release workflow uploads
  them, so `latest-mac.yml` points at a zip. This is already in place.
- **A signed app on the till.** Squirrel.Mac checks the *running* app's
  signature, so a till on an ad-hoc build cannot auto-update to the first
  signed release. Every mac till needs that one release installed by hand from
  the DMG; from then on they update themselves.

`apps/pos/electron/updater.ts` already runs the check on every packaged build
and logs the code-signature failure it currently gets to `updater.log`
(`~/Library/Logs/pos/` on macOS, `%APPDATA%\pos\logs\` on Windows — Electron
names the directory after the package `name`, which is `pos`). Confirm by shipping two consecutive signed tags and watching a mac
till pick up the second one after a quit.

## Releasing

A pushed `pos-v<version>` tag builds the installers and leaves them on a
**draft** release. Drafts are invisible to the tills, so nothing has shipped
yet. Publishing is the moment every till starts downloading the new version,
and a staged update installs on the next quit with no rollback — so a person
does it, after looking:

1. Download the draft's installer for each platform (drafts are visible to
   repo members) and install it over the previous release on a test machine.
2. Launch it, pair or sign in, take a test sale, quit and relaunch.
3. Promote it, marking it latest:

   ```bash
   gh release edit pos-v<version> --repo Ai-NativeLab/ServeOs --draft=false --latest
   ```

The workflow's job summary prints the exact command. If the draft is bad, delete
it, fix forward, and cut the next version — re-running the workflow against an
already-published tag is refused rather than swapping live assets.

## Update feed constraints

The `publish` block points electron-updater at GitHub Releases on
**Ai-NativeLab/ServeOs**, read anonymously. Two things follow, and both fail
silently — tills keep selling, they just stop updating:

- **The feed is the repo's `/releases/latest`.** The github provider asks for
  the repo-wide latest release, not the latest `pos-v*` one. Any other release
  in this repo that GitHub marks latest (a web release, a CLI) hides the POS
  feed from every till until the next POS release is promoted with `--latest`.
  Create non-POS releases with `--latest=false`.
- **The repo must stay public.** Anonymous reads stop the moment it goes
  private — which has already happened once. Shipping a GitHub token inside the
  app to work around that is not an option.

The durable fix is to move the feed off this repo: a dedicated public releases
repo (e.g. `Ai-NativeLab/serveos-pos-releases`, with the workflow uploading
there) or a `generic` provider pointing at a static URL (S3, R2, Vercel Blob).
Either removes both constraints. It is a follow-up, not a blocker — but do it
before the repo's visibility is next up for debate. Changing the feed URL is
itself a release: tills only learn the new location from the `app-update.yml`
inside the build they are running.

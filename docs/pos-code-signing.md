# Signing and notarizing the POS

**Status:** not done. Blocked on an Apple Developer Program membership, not on
engineering — every code change this needs is already in place. This is the
runbook for whoever has the account.

## What being unsigned actually costs

| | Today (ad-hoc signed) | Signed + notarized |
|---|---|---|
| macOS first launch | "developer cannot be verified" → right-click → **Open** | opens normally |
| Windows first launch | SmartScreen "unknown publisher" → **More info → Run anyway** | opens normally |
| macOS auto-update | **does not work** — Squirrel.Mac refuses to update an app without a Developer ID | works |
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
| `APPLE_API_KEY` | base64 of the `.p8` |
| `APPLE_API_KEY_ID` | the key ID (`ABC123DEFG`) |
| `APPLE_API_ISSUER` | the issuer UUID from App Store Connect |

**5. Config** — in `apps/pos/package.json`, delete `mac.identity: null` and add:

```json
"hardenedRuntime": true,
"notarize": true
```

Hardened runtime is mandatory for notarization; electron-builder supplies the
JIT entitlements Electron needs. Nothing else changes — `adhoc-sign-mac.mjs`
detects `CSC_LINK` and stands down on its own, so the real signature is not
overwritten.

**6. Workflow** — pass the secrets to the build step in
`.github/workflows/pos-release.yml`, macOS only:

```yaml
      - name: Build installers
        run: npm run pos:build
        env:
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
```

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
warning. Set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` the same way — no config
change needed, electron-builder picks them up.

Note that EV certificates ship on hardware tokens and cannot be used from a CI
runner. If you want EV, use a cloud signing service (Azure Trusted Signing,
DigiCert KeyLocker) rather than a token.

Windows auto-update already works unsigned, so this is cosmetic — worth doing
before a customer-facing launch, not before a pilot.

## After it lands

macOS auto-update starts working with no code change: `apps/pos/electron/updater.ts`
already runs the check on every packaged build and logs the code-signature
failure it currently gets. Confirm by shipping two consecutive tags and watching
a mac till pick up the second one after a quit.

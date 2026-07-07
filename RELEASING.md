# Releasing Pi-Vis

## macOS Build & Distribution

### Signing and notarization credentials

Best practice for local releases is to keep both the signing certificate and
notarization credentials in macOS Keychain:

- Install the `Developer ID Application` certificate in Keychain. Do not pass
  the certificate private key to the release command.
- Store notarization credentials once with notarytool:

```bash
xcrun notarytool store-credentials "pivis-notary" \
  --apple-id "your@email.com" \
  --team-id "ABCDEF1234" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

`npm run release` defaults to the `pivis-notary` keychain profile, so you do not
need to export Apple credentials for normal local releases.

Optional/fallback environment variables:

| Variable | Description |
|---|---|
| `APPLE_KEYCHAIN_PROFILE` | Override the notarytool profile name if you did not use `pivis-notary` |
| `APPLE_ID` | Fallback Apple ID email address |
| `APPLE_APP_SPECIFIC_PASSWORD` | Fallback app-specific password (generate at appleid.apple.com, *not* your iCloud password) |
| `APPLE_TEAM_ID` | Fallback Team ID from [Apple Developer](https://developer.apple.com/account) (e.g. `ABCDEF1234`) |
| `CSC_LINK` | (optional) Path or base64-encoded signing certificate; auto-resolved by electron-builder when a valid Developer ID cert is in the keychain |
| `CSC_KEY_PASSWORD` | (optional) Password for the signing certificate |

`npm run dist` remains a local build command. Electron Builder's built-in
notarization runs only when `APPLE_KEYCHAIN_PROFILE` or fallback Apple credential
env vars are set; otherwise it skips notarization with a logged message. For
signed local testing, prefer `npm run dist:signed`: it selects the Developer ID
Application identity from Keychain (`CSC_NAME`) and defaults notarization to the
`pivis-notary` keychain profile. `--skip-notarize` is available for signed-only
local updater smoke tests, but public releases should be notarized.

### Build commands

```bash
# Unsigned local development build (dmg + zip, arm64)
npm run dist

# Signed & notarized build without publishing a release, using the keychain profile
npm run dist:signed

# If your notarytool profile is not named pivis-notary
npm run dist:signed -- --notary-profile your-profile-name

# Signed-only local build for updater smoke tests when notarization is not set up yet
npm run dist:signed -- --skip-notarize
```

### One-command release

`npm run release` is the supported release entry point. It defaults to the
`pivis-notary` notarytool keychain profile. It fails if the git working tree is
dirty, the keychain profile/fallback Apple credentials are unavailable, `gh` is
not authenticated, or no `Developer ID Application` signing identity is
available (unless `CSC_LINK` supplies the certificate).

```bash
# Defaults to a patch bump, e.g. 0.3.3 -> 0.3.4
npm run release -- --notes-file docs/releases/v0.4.2.md --yes

# Other supported bumps
npm run release -- --minor --notes-file docs/releases/v0.5.0.md --yes
npm run release -- --major --notes-file docs/releases/v1.0.0.md --yes
npm run release -- --version 0.4.0 --notes-file docs/releases/v0.4.0.md --yes

# Inspect the planned commands without mutating files
npm run release -- --patch --generate-notes --dry-run
```

The command bumps `package.json`/`package-lock.json`, runs typecheck, lint, unit
tests, and E2E tests, builds signed/notarized artifacts, verifies codesigning,
Gatekeeper acceptance, and notarization stapling, commits the version bump, tags
`vX.Y.Z`, pushes the tag, and creates the GitHub Release with the zip and dmg
assets. Public GitHub Releases require release notes: create and commit a curated notes
file under `docs/releases/vX.Y.Z.md`, then pass `--notes-file <path>`
(preferred), or pass `--generate-notes` to use GitHub's auto-generated notes. If
both are passed, the curated notes file is used. Useful options: `--draft`
creates a draft GitHub Release, `--no-push` stops after creating the local
release commit/tag (skipping both git push and GitHub Release creation), and
`--skip-tests` is available only for emergency reruns after the exact same commit
has already passed verification.

### Mandatory pre-release checks

The automated suite (`typecheck`, `lint`, `test`, `test:render`, `test:e2e`) is
run by `npm run release`. Two behavior contracts are NOT covered by that suite
and MUST be verified manually before publishing:

1. **Real-pi end-to-end (Kitty keyboard protocol)**: Shift+Enter inserts a
   newline (not a submit) in the unified editor; Enter submits; a multiline
   paste inserts lines without submitting; session-switch keeps Shift+Enter
   working. Run the gated spec against a real `pi` + provider auth (real API
   spend):

   ```bash
   PI_E2E=1 npx playwright test -c tests/e2e/playwright.config.mts --grep kitty-real
   ```

   This is the one test that proves the user-visible fix across the real host +
   real pi-tui + real xterm. If the `PI_E2E` lane is added to CI, this manual
   step may be dropped once it runs green there.
2. **Manual smoke** (`npm run dev`): Shift+Enter newline / Enter submit /
   Alt+Enter follow-up in the unified editor; a 3-line paste (no submit); a
   session switch away/back then repeat; ESC with autocomplete open and with an
   overlay open; custom-panel arrows/Tab/Shift+Tab; the `/login` flow. Include
   IME composition and macOS Option/dead-key input (not covered by any suite).

### Architecture

Builds target **arm64 (Apple Silicon) only**. Apple Silicon is the assumed
audience; an arm64 app does **not** run on Intel Macs (Rosetta only translates
x64→arm64, not the reverse). To support Intel later, add `x64` (or a `universal`
target) under `mac.target` in `electron-builder.yml` — note that `node-pty` ships
no macOS prebuilts, so the x64 slice must be built from source on/for an x64
toolchain (e.g. a per-arch CI job).

### Publishing a GitHub release

The README install command (`curl … | bash` → `scripts/install.sh`) pulls the
latest GitHub release's `*-mac.zip` asset. `npm run release` is preferred because
it publishes the same assets and performs the required verification.

Manual fallback:

```bash
# 1. Build the artifacts (signed+notarized if Apple env vars are set)
npm run dist

# 2. Publish a release tagged vX.Y.Z and upload the dmg + zip
VERSION=$(node -p "require('./package.json').version")
cp "release/${VERSION}/Pi-Vis-${VERSION}-arm64.dmg" "release/${VERSION}/Pi-Vis-arm64.dmg"

gh release create "v${VERSION}" \
  "release/${VERSION}/Pi-Vis-${VERSION}-arm64-mac.zip" \
  "release/${VERSION}/Pi-Vis-${VERSION}-arm64.dmg" \
  "release/${VERSION}/Pi-Vis-arm64.dmg" \
  --title "v${VERSION}" \
  --notes-file "docs/releases/v${VERSION}.md"
```

`install.sh` resolves the asset via the GitHub API (`releases/latest`), so it
keeps working across versions with no edits — it just needs each release to
carry a `*-mac.zip` asset. The `.zip` (not the `.dmg`) is what the installer
unpacks into `/Applications`.

The GitHub Pages landing page links directly to
`releases/latest/download/Pi-Vis-arm64.dmg`, so public releases should also
include the stable `Pi-Vis-arm64.dmg` alias alongside the versioned DMG.

### Auto updates

Packaged macOS builds use Electron's built-in `autoUpdater` with Electron's
hosted GitHub release feed:

```txt
https://update.electronjs.org/rsingapuri/pi-vis/darwin-arm64/<current-version>
```

The feed requires a public GitHub repository, a signed macOS app, and a GitHub
Release that contains a compatible zip asset. The existing artifact name
`Pi-Vis-${VERSION}-arm64-mac.zip` satisfies the macOS arm64 asset matcher. The
updater checks only in packaged, signed macOS builds; development runs and tests
report app updates as unavailable. The first updater-capable build still has to
be installed manually by users already on older ad-hoc builds; future signed
builds can update themselves.

### CI

See `.github/workflows/ci.yml` for the current CI pipeline (typecheck → lint → test → build on push/PR). Notarization credentials should be stored as repository secrets and injected in a release workflow.
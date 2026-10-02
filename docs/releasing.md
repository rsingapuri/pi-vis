# Releasing

See [`RELEASING.md`](../RELEASING.md) for the full macOS signing, notarization,
release-command, and build instructions.

## Release command

`npm run release` is the preferred release path. It performs release preflight,
requires release notes for public GitHub Releases, bumps the package version,
runs verification, builds signed/notarized macOS artifacts, verifies the
resulting `.app`, commits/tags the release, pushes the tag, and creates the
GitHub Release with the zip and dmg assets.

The automated contract is fail-closed: clean `npm ci` (whose root lifecycle
serially provisions and verifies Electron, verifies the installed Pi security
closure against the authoritative root lock, and only then applies the exact
node-pty patch), a zero-advisory production `npm audit`, typecheck, lint, unit, render, Electron E2E, and
`npm ls --all`, followed by the signed `dist` and its
final-app verifier. The macOS signer admits only genuine Mach-O/fat code (rather
than detached-xattr-signing arbitrary unpacked fonts, images, WASM, or foreign
binaries), and the artifact gate requires strict signatures to survive both the
real installer ZIP extraction and a copy out of the mounted DMG. Signed entry
points fail if an unsigned artifact is produced; plain unsigned `dist`
rehearsals log that the signature-transfer portion was skipped. The runtime
artifact verifier independently requires packaged
Electron to match the exact safe lock version (at least 43.5.0) and resolves
`brace-expansion@5.0.12` from packaged Pi's actual minimatch location. There is
no supported test-skip path. For a pinned-Pi
candidate, also rehearse `npm ci`, `npm run test:full`, and `npm run dist`, then
complete the provider-spending Kitty journey and manual GUI/IME checks in the
root release guide before publishing.

Common forms:

```bash
npm run dist:signed                   # signed/notarized local build, no tag/release
npm run dist:signed -- --skip-notarize # signed-only local smoke-test build
npm run release -- --notes-file docs/releases/v0.4.2.md --yes              # patch release
npm run release -- --minor --notes-file docs/releases/v0.5.0.md --yes
npm run release -- --version 0.4.0 --notes-file docs/releases/v0.4.0.md --yes
npm run release -- --patch --generate-notes --dry-run
```

Local releases default to the notarytool keychain profile `pivis-notary`, so no
Apple password needs to be exported after running `xcrun notarytool
store-credentials "pivis-notary" ...` once. Optional overrides:
`APPLE_KEYCHAIN_PROFILE` (or `npm run release -- --notary-profile <name>`),
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` as a fallback, and
`CSC_LINK` / `CSC_KEY_PASSWORD` / `CSC_NAME` for signing identity overrides.

## Landing page

GitHub Pages serves the static download site from `site/` via
`.github/workflows/pages.yml`. The page links users to the latest GitHub Release
and the existing installer command. The public URL is expected to be:

```txt
https://rsingapuri.github.io/pi-vis/
```

Keep the page static (plain HTML/CSS plus small progressive-enhancement JS, no
build step): release downloads should continue to come from GitHub Release
assets, not checked-in binaries. The primary DMG link uses GitHub's stable
latest-release URL:

```txt
https://github.com/rsingapuri/pi-vis/releases/latest/download/Pi-Vis-arm64.dmg
```

`npm run release` uploads `Pi-Vis-arm64.dmg` as a stable alias beside the
versioned `Pi-Vis-${VERSION}-arm64.dmg` asset. Keep that alias intact if the
landing page direct-download button changes.

### Screenshots

The screenshots in `site/assets/screenshots/` are generated, not hand-taken.
After a UI change that shows in them (theming, transcript, diff viewer, tree
view, sidebar, status bar), regenerate and commit:

```bash
npm run site:screenshots
```

`scripts/site-screenshots.mjs` boots the browser-only dev renderer
(`npm run dev:renderer` + `preview-stub.ts`), seeds a curated fictional
session (a queue-backoff fix in a made-up "tidepool" sync service) through
the same store APIs the render tests use, and captures the hero/diff/tree
shots plus one gallery shot per bundled colorscheme at 1440×900@2x. macOS
traffic lights are drawn into the titlebar inset before capture because the
browser preview has no native window chrome. Set `PIVIS_SHOTS_URL` to reuse
an already-running dev renderer instead of spawning one.

If a bundled colorscheme is added/removed/renamed, update the `SCHEMES` list
in the script **and** the gallery section of `site/index.html` together.

## Install and app-update assets

End users install via `curl … | bash` → `scripts/install.sh`, which downloads
the latest release's `*-mac.zip` and unpacks it to `/Applications`. Electron's
built-in app updater also consumes the GitHub Release zip through
`update.electronjs.org`:

```txt
https://update.electronjs.org/rsingapuri/pi-vis/darwin-arm64/<current-version>
```

This means each public release must include the arm64 mac zip asset
(`Pi-Vis-${VERSION}-arm64-mac.zip`). The `.dmg` remains useful for manual
installs, but the zip is the critical installer/updater asset.

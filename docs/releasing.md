# Releasing

See [`RELEASING.md`](../RELEASING.md) for the full macOS signing, notarization,
release-command, and build instructions.

## Release command

`npm run release` is the preferred release path. It performs release preflight,
bumps the package version, runs verification, builds signed/notarized macOS
artifacts, verifies the resulting `.app`, commits/tags the release, pushes the
tag, and creates the GitHub Release with the zip and dmg assets.

Common forms:

```bash
npm run dist:signed                   # signed/notarized local build, no tag/release
npm run dist:signed -- --skip-notarize # signed-only local smoke-test build
npm run release -- --yes              # patch release
npm run release -- --minor --yes
npm run release -- --version 0.4.0 --yes
npm run release -- --patch --dry-run
```

Local releases default to the notarytool keychain profile `pivis-notary`, so no
Apple password needs to be exported after running `xcrun notarytool
store-credentials "pivis-notary" ...` once. Optional overrides:
`APPLE_KEYCHAIN_PROFILE` (or `npm run release -- --notary-profile <name>`),
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` as a fallback, and
`CSC_LINK` / `CSC_KEY_PASSWORD` / `CSC_NAME` for signing identity overrides.

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

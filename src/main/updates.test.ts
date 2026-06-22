import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────
// updates.ts pulls in settings-store (which imports electron) and auth (which
// spawns a login shell). Mock both so the test runs in plain Node and so we
// can point pi at the fake binary. locate-pi.ts imports the same auth module,
// so its getSubprocessEnv is mocked too.

const mocks = vi.hoisted(() => ({ piBinaryPath: undefined as string | undefined }));

vi.mock("./settings-store.js", () => ({
  getSettings: () => ({ piBinaryPath: mocks.piBinaryPath }),
}));

vi.mock("./auth.js", () => ({
  // Pass the real process.env through so the spawned fake-pi inherits the
  // FAKE_PI_* knobs we set per test.
  getSubprocessEnv: async () => ({ ...process.env }),
}));

import { clearPiLocationCache } from "./pi/locate-pi.js";
import {
  checkForUpdates,
  comparePackageVersions,
  isNewerPackageVersion,
  startUpdate,
} from "./updates.js";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/fake-pi.mjs");

/** Stub global fetch with a single canned latest-version response. */
function stubLatestVersion(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch,
  );
}

// ── Layer 1: pure semver helpers ─────────────────────────────────────────────

describe("comparePackageVersions", () => {
  it("orders by numeric segments", () => {
    expect(comparePackageVersions("1.2.3", "1.2.3")).toBe(0);
    expect(comparePackageVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(comparePackageVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
  });

  it("strips a leading v and pads missing segments", () => {
    expect(comparePackageVersions("v1.2.0", "1.2")).toBe(0);
    expect(comparePackageVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("treats non-numeric segments as 0 rather than NaN", () => {
    expect(comparePackageVersions("1.2.x", "1.2.0")).toBe(0);
    expect(comparePackageVersions("1.beta", "1.0")).toBe(0);
  });

  it("compares extra segments (e.g. 1.2.3.4)", () => {
    expect(comparePackageVersions("1.2.3.4", "1.2.3")).toBeGreaterThan(0);
    expect(comparePackageVersions("1.2.3", "1.2.3.1")).toBeLessThan(0);
  });
});

describe("isNewerPackageVersion", () => {
  it("is true only when latest exceeds current", () => {
    expect(isNewerPackageVersion("1.0.0", "1.0.1")).toBe(true);
    expect(isNewerPackageVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerPackageVersion("1.0.1", "1.0.0")).toBe(false);
  });
});

// ── Layers 2 & 3: orchestration against a sandboxed fake pi ───────────────────

describe("update flow (sandboxed fake pi)", () => {
  let home: string;
  let versionFile: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "pivis-update-"));
    versionFile = join(home, "pi-version");
    fs.writeFileSync(versionFile, "1.0.0\n");

    mocks.piBinaryPath = FAKE_PI;
    clearPiLocationCache();

    // Hermetic PATH: a bin dir with only `node` symlinked in. This lets the
    // fake binary's `#!/usr/bin/env node` shebang resolve, while ensuring
    // locate-pi's `which pi` / `$SHELL -ilc 'command -v pi'` fallbacks never
    // find — and accidentally run — the real pi installed on this machine.
    const binDir = join(home, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(process.execPath, join(binDir, "node"));

    // Empty sandbox HOME → no ~/.pi/agent/settings.json → no extension checks,
    // keeping these tests focused on the pi-binary update path.
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("SHELL", join(home, "no-such-shell"));
    vi.stubEnv("FAKE_PI_VERSION_FILE", versionFile);
    vi.stubEnv("PI_OFFLINE", "");
    vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearPiLocationCache();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // ── Layer 2: checkForUpdates ──

  it("reports an available update when the endpoint advertises a newer version", async () => {
    stubLatestVersion({ version: "2.0.0", note: "big release" });
    const status = await checkForUpdates();
    expect(status.pi).toMatchObject({
      current: "1.0.0",
      latest: "2.0.0",
      updateAvailable: true,
      note: "big release",
    });
    expect(status.extensions).toEqual([]);
  });

  it("reports no update when already on the latest version", async () => {
    fs.writeFileSync(versionFile, "2.0.0\n");
    clearPiLocationCache();
    stubLatestVersion({ version: "2.0.0" });
    const status = await checkForUpdates();
    expect(status.pi).toMatchObject({ current: "2.0.0", updateAvailable: false });
  });

  it("treats an HTTP error as no update available", async () => {
    stubLatestVersion({}, false);
    const status = await checkForUpdates();
    expect(status.pi.updateAvailable).toBe(false);
    expect(status.pi.current).toBe("1.0.0");
  });

  it("treats a malformed response as no update available", async () => {
    stubLatestVersion({ note: "no version field" });
    const status = await checkForUpdates();
    expect(status.pi.updateAvailable).toBe(false);
  });

  it("swallows network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );
    const status = await checkForUpdates();
    expect(status.pi.updateAvailable).toBe(false);
  });

  it("skips the network check when PI_OFFLINE is set", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    const status = await checkForUpdates();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(status.pi).toMatchObject({ current: "1.0.0", updateAvailable: false });
  });

  // ── Layer 3: runUpdate, full loop ──

  /** Run startUpdate to completion, collecting streamed output. */
  function runToCompletion(target: "all" | "pi" | { extension: string }) {
    return new Promise<{
      output: string;
      exitCode: number;
      status: Awaited<ReturnType<typeof checkForUpdates>>;
    }>((resolve) => {
      let output = "";
      startUpdate(
        target,
        (_runId, chunk) => {
          output += chunk;
        },
        (_runId, exitCode, status) => {
          resolve({ output, exitCode, status });
        },
      );
    });
  }

  it("runs the update, streams progress, and re-checks the bumped version", async () => {
    // Before: on 1.0.0, latest is 2.0.0. The fake binary bumps its version
    // stamp to 2.0.0 on success, so the post-update re-check sees parity.
    stubLatestVersion({ version: "2.0.0" });
    const { output, exitCode, status } = await runToCompletion("pi");

    expect(exitCode).toBe(0);
    expect(output).toContain("Checking for updates...");
    expect(output).toContain("Updated pi to 2.0.0");
    expect(fs.readFileSync(versionFile, "utf8").trim()).toBe("2.0.0");
    expect(status.pi).toMatchObject({ current: "2.0.0", updateAvailable: false });
  });

  it("passes the right `pi update` flags per target", async () => {
    stubLatestVersion({ version: "2.0.0" });

    // "all" must use --all so extensions are updated too — bare `pi update`
    // updates pi only and prints "Extensions are skipped."
    const all = await runToCompletion("all");
    expect(all.output).toContain("ARGV update --all --no-approve");

    // "pi" updates pi only.
    const pi = await runToCompletion("pi");
    expect(pi.output).toContain("ARGV update --self --no-approve");

    // A single extension targets just that package.
    const ext = await runToCompletion({ extension: "npm:foo-ext" });
    expect(ext.output).toContain("ARGV update --extension npm:foo-ext --no-approve");
  });

  it("surfaces a non-zero exit code without bumping the version", async () => {
    vi.stubEnv("FAKE_PI_UPDATE_EXIT", "3");
    stubLatestVersion({ version: "2.0.0" });
    const { exitCode, status } = await runToCompletion("pi");

    expect(exitCode).toBe(3);
    expect(fs.readFileSync(versionFile, "utf8").trim()).toBe("1.0.0");
    // Still on 1.0.0, so the update remains available after the failed run.
    expect(status.pi).toMatchObject({ current: "1.0.0", updateAvailable: true });
  });

  it("returns exit code 1 when no pi binary can be located", async () => {
    mocks.piBinaryPath = join(home, "does-not-exist");
    clearPiLocationCache();
    stubLatestVersion({ version: "2.0.0" });
    const { exitCode } = await runToCompletion("pi");
    expect(exitCode).toBe(1);
  });
});

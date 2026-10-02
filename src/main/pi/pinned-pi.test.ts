import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PINNED_PI_VERSION, TEST_PI_BINARY_OVERRIDE_ENV, getPinnedPi } from "./pinned-pi.js";

describe("getPinnedPi", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves the bundled pi runtime with its exact pinned version", () => {
    const info = getPinnedPi();
    expect(info).not.toBeNull();
    expect(info!.path.endsWith(path.join("dist", "cli.js"))).toBe(true);
    expect(info!.cliPath.endsWith(path.join("dist", "bundle", "cli.js"))).toBe(true);
    expect(info!.path).toContain(path.join("@earendil-works", "pi-coding-agent"));
    expect(existsSync(info!.path)).toBe(true);
    expect(info!.version).toBe(PINNED_PI_VERSION);
    expect(PINNED_PI_VERSION).toBe("0.99.2");
  });

  it("ignores an existing override path unless the E2E seam is explicitly active", () => {
    const override = fileURLToPath(import.meta.url);
    const info = getPinnedPi(override);
    expect(info).not.toBeNull();
    expect(info!.path).not.toBe(override);
    expect(info!.version).toBe(PINNED_PI_VERSION);
  });

  it("honors an existing override path only with the explicit test activation", () => {
    // Any real file works as an override target; the resolver only checks existence.
    vi.stubEnv(TEST_PI_BINARY_OVERRIDE_ENV, "1");
    const override = fileURLToPath(import.meta.url);
    const info = getPinnedPi(override);
    expect(info).toEqual({ path: override, cliPath: override, version: "test-override" });
  });

  it("falls back to the bundled runtime when the override path does not exist", () => {
    const info = getPinnedPi("/nonexistent/fake-pi");
    expect(info).not.toBeNull();
    expect(info!.path).toContain(path.join("@earendil-works", "pi-coding-agent"));
  });
});

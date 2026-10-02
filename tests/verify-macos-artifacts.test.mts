import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  hasCodeSignature,
  macArtifactPaths,
  runChecked,
  verifyCodeSignature,
  verifyMacArtifactPortability,
} from "../scripts/verify-macos-artifacts.mjs";

describe("macOS artifact portability verifier", () => {
  it("derives only the versioned app, ZIP, and DMG artifacts", () => {
    expect(macArtifactPaths("/repo", "1.2.3")).toEqual({
      appBundle: path.join("/repo", "release", "1.2.3", "mac-arm64", "Pi-Vis.app"),
      zipArchive: path.join("/repo", "release", "1.2.3", "Pi-Vis-1.2.3-arm64-mac.zip"),
      dmgArchive: path.join("/repo", "release", "1.2.3", "Pi-Vis-1.2.3-arm64.dmg"),
    });
  });

  it("uses strict deep verification for every copied bundle", () => {
    const run = vi.fn();
    verifyCodeSignature("/tmp/Pi-Vis.app", run);
    expect(run).toHaveBeenCalledWith("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=4",
      "/tmp/Pi-Vis.app",
    ]);
  });

  it("fails closed when an external verifier command exits nonzero", () => {
    expect(() => runChecked("false", [])).toThrow("exited with status 1");
  });

  it("skips only an explicitly unsigned local bundle and rejects other inspection errors", () => {
    const unsigned = vi.fn().mockReturnValue({
      error: undefined,
      status: 1,
      stdout: "",
      stderr: "/tmp/Pi-Vis.app: code object is not signed at all\n",
    });
    expect(hasCodeSignature("/tmp/Pi-Vis.app", unsigned)).toBe(false);

    const signed = vi.fn().mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
      stderr: "Identifier=dev.pivis.app\n",
    });
    expect(hasCodeSignature("/tmp/Pi-Vis.app", signed)).toBe(true);

    const damaged = vi.fn().mockReturnValue({
      error: undefined,
      status: 1,
      stdout: "",
      stderr: "invalid signature\n",
    });
    expect(() => hasCodeSignature("/tmp/Pi-Vis.app", damaged)).toThrow(
      "codesign could not inspect",
    );
  });

  it("fails closed on an unsigned bundle when the signed release path requires one", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-artifact-required-"));
    const artifacts = macArtifactPaths(temporaryRoot, "1.2.3");
    for (const artifact of Object.values(artifacts)) {
      if (artifact.endsWith(".app")) fs.mkdirSync(artifact, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, "fixture");
      }
    }
    try {
      expect(() =>
        verifyMacArtifactPortability(artifacts, {
          inspectSignature: () => false,
          platform: "darwin",
          requireSigned: true,
          temporaryRoot,
        }),
      ).toThrow("Required signed macOS artifact is unsigned");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("verifies the real ZIP extraction and the mounted and copied DMG payloads", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-artifact-test-"));
    const appBundle = path.join(temporaryRoot, "source", "Pi-Vis.app");
    const zipArchive = path.join(temporaryRoot, "Pi-Vis.zip");
    const dmgArchive = path.join(temporaryRoot, "Pi-Vis.dmg");
    fs.mkdirSync(appBundle, { recursive: true });
    fs.writeFileSync(zipArchive, "zip");
    fs.writeFileSync(dmgArchive, "dmg");
    const run = vi.fn();
    try {
      expect(
        verifyMacArtifactPortability(
          { appBundle, zipArchive, dmgArchive },
          { run, inspectSignature: () => true, platform: "darwin", temporaryRoot },
        ),
      ).toEqual({ skipped: false });
      const commands = run.mock.calls.map(([command]) => command);
      expect(commands).toEqual([
        "codesign",
        "unzip",
        "codesign",
        "hdiutil",
        "codesign",
        "ditto",
        "codesign",
        "hdiutil",
      ]);
      expect(run.mock.calls[1][1]).toEqual(["-q", zipArchive, "-d", expect.any(String)]);
      expect(run.mock.calls[3][1]).toContain("-readonly");
      expect(run.mock.calls[5][1][0]).toContain("/dmg/Pi-Vis.app");
      expect(run.mock.calls[7][1][0]).toBe("detach");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

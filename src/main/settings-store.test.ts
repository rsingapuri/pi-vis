import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSettings, loadSettings, saveSettings } from "./settings-store.js";

// settings-store resolves its file via PIVIS_SETTINGS_DIR when set, so these
// tests never touch electron's app.getPath (mirrors session-discovery.test).
let dir: string;
let envBackup: string | undefined;

function writeSettings(obj: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj), "utf8");
}

beforeEach(() => {
  envBackup = process.env["PIVIS_SETTINGS_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-settings-"));
  process.env["PIVIS_SETTINGS_DIR"] = dir;
});

afterEach(() => {
  if (envBackup === undefined) delete process.env["PIVIS_SETTINGS_DIR"];
  else process.env["PIVIS_SETTINGS_DIR"] = envBackup;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("saveSettings", () => {
  it("does not stage an unpersisted in-memory update when the atomic write fails", () => {
    saveSettings({ workspaceOrder: ["/persisted"] });
    const committed = getSettings();

    const notADirectory = path.join(dir, "not-a-directory");
    fs.writeFileSync(notADirectory, "blocking file", "utf8");
    process.env["PIVIS_SETTINGS_DIR"] = notADirectory;

    expect(() => saveSettings({ workspaceOrder: ["/unpersisted"] })).toThrow();
    expect(getSettings()).toBe(committed);
    expect(getSettings().workspaceOrder).toEqual(["/persisted"]);
  });
});

describe("loadSettings — workspace migration & recovery", () => {
  it("migrates legacy recentWorkspaces into workspaceOrder", () => {
    writeSettings({ recentWorkspaces: ["/a", "/b"] });
    const s = loadSettings();
    expect(s.workspaceOrder).toEqual(["/a", "/b"]);
    expect("recentWorkspaces" in s).toBe(false);
  });

  it("does not migrate when workspaceOrder is already present", () => {
    writeSettings({ recentWorkspaces: ["/a"], workspaceOrder: ["/x", "/y"] });
    expect(loadSettings().workspaceOrder).toEqual(["/x", "/y"]);
  });

  it("recovers lastActiveWorkspace into an empty workspaceOrder", () => {
    // Reproduces the data-loss case: recentWorkspaces was already stripped by
    // a pre-migration build, leaving an empty order but a valid last-active.
    writeSettings({ workspaceOrder: [], lastActiveWorkspace: "/repo" });
    expect(loadSettings().workspaceOrder).toEqual(["/repo"]);
  });

  it("does not seed from lastActiveWorkspace when the order is non-empty", () => {
    writeSettings({ workspaceOrder: ["/a"], lastActiveWorkspace: "/repo" });
    expect(loadSettings().workspaceOrder).toEqual(["/a"]);
  });

  it("leaves the order empty when there is no last-active workspace", () => {
    writeSettings({ workspaceOrder: [], lastActiveWorkspace: null });
    expect(loadSettings().workspaceOrder).toEqual([]);
  });

  it("migrates a legacy light colorScheme into the light theme picker", () => {
    writeSettings({ colorScheme: "latte" });
    const s = loadSettings();
    expect(s.lightColorScheme).toBe("latte");
    expect(s.darkColorScheme).toBe("mocha");
    expect(s.themeMode).toBe("light");
  });

  it("migrates a legacy dark colorScheme into the dark theme picker", () => {
    writeSettings({ colorScheme: "gruvbox-material-dark" });
    const s = loadSettings();
    expect(s.lightColorScheme).toBe("latte");
    expect(s.darkColorScheme).toBe("gruvbox-material-dark");
    expect(s.themeMode).toBe("dark");
  });

  it("sanitizes a stale saved light theme to the light default", () => {
    writeSettings({ lightColorScheme: "deleted-custom-light", darkColorScheme: "mocha" });
    const s = loadSettings();
    expect(s.lightColorScheme).toBe("latte");
    expect(s.darkColorScheme).toBe("mocha");
  });
});

import { describe, expect, it } from "vitest";
import { AppSettingsSchema, resolveActiveColorScheme } from "./settings.js";

// The pi-theme luminance mapping moved to @shared/theme (piThemeForTheme,
// keyed off each theme's `appearance`); see theme/*.test.ts.

describe("AppSettingsSchema", () => {
  it("returns sensible defaults for an empty input", () => {
    const parsed = AppSettingsSchema.parse({});
    // Tab persistence is gone: openTabs / activeSessionFile must not
    // appear on the parsed type at all.
    expect("openTabs" in parsed).toBe(false);
    expect("activeSessionFile" in parsed).toBe(false);
    expect(parsed.lightColorScheme).toBe("latte");
    expect(parsed.darkColorScheme).toBe("mocha");
    expect(parsed.themeMode).toBe("system");
    expect(parsed.piEnv).toEqual({});
    expect(parsed.transcriptStyle).toBe("verbose");
    expect(parsed.groupModelsByProvider).toBe(false);
    expect(parsed.fonts.display).toEqual({ sizePx: 14 });
    expect(parsed.fonts.code).toEqual({ family: "IBM Plex Mono", sizePx: 14 });
  });

  it("strips the legacy display font family on parse", () => {
    const result = AppSettingsSchema.safeParse({
      fonts: {
        display: { family: "Nimbus Sans", sizePx: 16 },
        code: { family: "JetBrains Mono", sizePx: 13 },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect("family" in result.data.fonts.display).toBe(false);
    expect(result.data.fonts.display.sizePx).toBe(16);
    expect(result.data.fonts.code).toEqual({ family: "JetBrains Mono", sizePx: 13 });
  });

  it("strips the legacy openTabs / activeSessionFile / openSessions keys on parse (plain z.object)", () => {
    // Regression: a user's existing settings.json may still have
    // openTabs / activeSessionFile from before we removed tab
    // persistence. The schema must not fail to parse — and the
    // legacy keys must be dropped, since the store no longer reads
    // or writes them.
    const result = AppSettingsSchema.safeParse({
      openSessions: [{ workspacePath: "/a", sessionFile: "/b.jsonl" }],
      openTabs: [{ workspacePath: "/a", sessionFile: "/b.jsonl" }],
      activeSessionFile: "/b.jsonl",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect("openSessions" in result.data).toBe(false);
    expect("openTabs" in result.data).toBe(false);
    expect("activeSessionFile" in result.data).toBe(false);
  });

  it("accepts and round-trips any light/dark theme ids", () => {
    // Theme ids are free strings (theme-registry ids), not enums: bundled
    // themes AND user-theme ids must round-trip. Missing ids are handled by
    // appearance-aware fallback at load/apply time, not rejected here.
    const result = AppSettingsSchema.safeParse({
      lightColorScheme: "my-custom-light",
      darkColorScheme: "gruvbox-material-dark",
      themeMode: "dark",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.lightColorScheme).toBe("my-custom-light");
    expect(result.data.darkColorScheme).toBe("gruvbox-material-dark");
    expect(result.data.themeMode).toBe("dark");
  });

  it("resolves the active theme from mode plus system appearance", () => {
    const settings = AppSettingsSchema.parse({
      lightColorScheme: "latte",
      darkColorScheme: "mocha",
    });
    expect(resolveActiveColorScheme(settings, "light")).toBe("latte");
    expect(resolveActiveColorScheme(settings, "dark")).toBe("mocha");
    expect(resolveActiveColorScheme({ ...settings, themeMode: "light" }, "dark")).toBe("latte");
    expect(resolveActiveColorScheme({ ...settings, themeMode: "dark" }, "light")).toBe("mocha");
  });

  it("strips the legacy recentWorkspaces key and defaults workspaceOrder / expandedWorkspaces to empty", () => {
    // Migration target: recentWorkspaces (recency-sorted) was replaced by
    // workspaceOrder (manual order). Zod must drop the legacy key on parse;
    // the settings-store migration carries its value into workspaceOrder.
    const result = AppSettingsSchema.safeParse({
      recentWorkspaces: ["/a", "/b"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect("recentWorkspaces" in result.data).toBe(false);
    expect(result.data.workspaceOrder).toEqual([]);
    expect(result.data.expandedWorkspaces).toEqual([]);
  });

  it("round-trips user-configured pi environment variables", () => {
    const result = AppSettingsSchema.safeParse({ piEnv: { PI_AGENT_DIR: "/tmp/pi", FOO: "bar" } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.piEnv).toEqual({ PI_AGENT_DIR: "/tmp/pi", FOO: "bar" });
  });

  it("round-trips workspaceOrder and expandedWorkspaces", () => {
    const result = AppSettingsSchema.safeParse({
      workspaceOrder: ["/repo-a", "/repo-b"],
      expandedWorkspaces: ["/repo-a"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.workspaceOrder).toEqual(["/repo-a", "/repo-b"]);
    expect(result.data.expandedWorkspaces).toEqual(["/repo-a"]);
  });

  it("round-trips display preferences", () => {
    const result = AppSettingsSchema.safeParse({
      transcriptStyle: "compact",
      groupModelsByProvider: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.transcriptStyle).toBe("compact");
    expect(result.data.groupModelsByProvider).toBe(true);
  });
});

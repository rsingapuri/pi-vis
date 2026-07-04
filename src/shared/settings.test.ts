import { describe, expect, it } from "vitest";
import { AppSettingsSchema } from "./settings.js";

// The pi-theme luminance mapping moved to @shared/theme (piThemeForTheme,
// keyed off each theme's `appearance`); see theme/*.test.ts.

describe("AppSettingsSchema", () => {
  it("returns sensible defaults for an empty input", () => {
    const parsed = AppSettingsSchema.parse({});
    // Tab persistence is gone: openTabs / activeSessionFile must not
    // appear on the parsed type at all.
    expect("openTabs" in parsed).toBe(false);
    expect("activeSessionFile" in parsed).toBe(false);
    // Catppuccin flavor defaults to Mocha (dark) — the pre-existing
    // baseline so first-launch UI is unchanged.
    expect(parsed.colorScheme).toBe("mocha");
    expect(parsed.piEnv).toEqual({});
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

  it("accepts and round-trips any colorScheme id", () => {
    // colorScheme is now a free string (a theme-registry id), not an enum:
    // bundled flavors AND user-theme ids must round-trip. An id that no
    // longer resolves is handled at apply time by resolveTheme's fallback,
    // not rejected here.
    for (const id of ["mocha", "latte", "gruvbox-material-dark", "my-custom-theme"]) {
      const result = AppSettingsSchema.safeParse({ colorScheme: id });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.colorScheme).toBe(id);
    }
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
});

import { describe, expect, it } from "vitest";
import { AppSettingsSchema, piThemeForColorScheme } from "./settings.js";

describe("piThemeForColorScheme", () => {
  it("maps Latte (the only light flavor) to pi's light theme", () => {
    expect(piThemeForColorScheme("latte")).toBe("light");
  });

  it("maps the dark flavors to pi's dark theme", () => {
    expect(piThemeForColorScheme("frappe")).toBe("dark");
    expect(piThemeForColorScheme("macchiato")).toBe("dark");
    expect(piThemeForColorScheme("mocha")).toBe("dark");
  });
});

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

  it("accepts and round-trips every valid colorScheme flavor", () => {
    for (const flavor of ["mocha", "macchiato", "frappe", "latte"] as const) {
      const result = AppSettingsSchema.safeParse({ colorScheme: flavor });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.colorScheme).toBe(flavor);
    }
  });

  it("rejects an unknown colorScheme flavor", () => {
    const result = AppSettingsSchema.safeParse({ colorScheme: "frappuccino" });
    expect(result.success).toBe(false);
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

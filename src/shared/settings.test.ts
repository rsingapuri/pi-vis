import { describe, expect, it } from "vitest";
import { AppSettingsSchema } from "./settings.js";

describe("AppSettingsSchema", () => {
  it("returns openTabs=[] and activeSessionFile=null for an empty input", () => {
    const parsed = AppSettingsSchema.parse({});
    expect(parsed.openTabs).toEqual([]);
    expect(parsed.activeSessionFile).toBeNull();
  });

  it("strips the legacy openSessions key on parse (plain z.object)", () => {
    const result = AppSettingsSchema.safeParse({
      openSessions: [{ workspacePath: "/a", sessionFile: "/b.jsonl" }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect("openSessions" in result.data).toBe(false);
    expect(result.data.openTabs).toEqual([]);
    expect(result.data.activeSessionFile).toBeNull();
  });

  it("preserves explicit openTabs and activeSessionFile across a round trip", () => {
    const entry = { workspacePath: "/ws", sessionFile: "/sessions/x.jsonl" };
    const result = AppSettingsSchema.safeParse({
      openTabs: [entry],
      activeSessionFile: "/sessions/x.jsonl",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.openTabs).toEqual([entry]);
    expect(result.data.activeSessionFile).toBe("/sessions/x.jsonl");
  });
});

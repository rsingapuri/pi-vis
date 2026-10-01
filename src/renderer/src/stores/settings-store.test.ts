// @vitest-environment jsdom
import { defaultSettings } from "@shared/settings.js";
import type { AppSettings } from "@shared/settings.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFonts, useSettingsStore } from "./settings-store.js";

describe("settings font application", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    Reflect.deleteProperty(window, "pivis");
  });

  it("installs independent reading stacks without changing the interface family", () => {
    applyFonts({
      ...defaultSettings,
      fonts: {
        ...defaultSettings.fonts,
        title: { family: "Avenir Next" },
        transcriptHeader: { family: "Charter" },
        transcriptBody: { family: "Atkinson Hyperlegible" },
      },
    });

    const styles = document.documentElement.style;
    expect(styles.getPropertyValue("--font-title")).toBe('"Avenir Next", var(--font-accent)');
    expect(styles.getPropertyValue("--font-transcript-heading")).toBe(
      '"Charter", "IBM Plex Serif", var(--font-display)',
    );
    expect(styles.getPropertyValue("--font-thinking")).toBe(
      styles.getPropertyValue("--font-transcript-heading"),
    );
    expect(styles.getPropertyValue("--font-reading-heading")).toBe("");
    expect(styles.getPropertyValue("--font-transcript-body")).toBe(
      '"Atkinson Hyperlegible", var(--font-display)',
    );
    expect(styles.getPropertyValue("--font-display")).toBe(
      '"Inter", system-ui, -apple-system, sans-serif',
    );
  });

  it("quotes hostile family punctuation and falls back for blank selections", () => {
    applyFonts({
      ...defaultSettings,
      fonts: {
        ...defaultSettings.fonts,
        title: { family: 'Quoted "Title"; }' },
        transcriptHeader: { family: "  " },
        transcriptBody: { family: "Body\\Face\nVariant" },
      },
    });

    const styles = document.documentElement.style;
    expect(styles.getPropertyValue("--font-title")).toBe(
      '"Quoted \\"Title\\"; }", var(--font-accent)',
    );
    expect(styles.getPropertyValue("--font-transcript-heading")).toBe(
      '"IBM Plex Serif", var(--font-display)',
    );
    expect(styles.getPropertyValue("--font-thinking")).toBe(
      '"IBM Plex Serif", var(--font-display)',
    );
    expect(styles.getPropertyValue("--font-transcript-body")).toBe(
      '"Body\\\\Face Variant", var(--font-display)',
    );
  });

  it("serializes rapid reading-font writes without reverting optimistic state", async () => {
    type PendingWrite = {
      updates: Partial<AppSettings>;
      resolve: (settings: AppSettings) => void;
    };
    const pending: PendingWrite[] = [];
    let persisted = structuredClone(defaultSettings);
    const invoke = vi.fn(
      (_channel: string, updates: Partial<AppSettings>) =>
        new Promise<AppSettings>((resolve) => pending.push({ updates, resolve })),
    );
    Object.defineProperty(window, "pivis", {
      configurable: true,
      value: { invoke },
    });
    useSettingsStore.setState({ settings: structuredClone(defaultSettings) });

    const titleWrite = useSettingsStore
      .getState()
      .updateReadingFonts({ title: { family: "Avenir Next" } });
    const headerWrite = useSettingsStore
      .getState()
      .updateReadingFonts({ transcriptHeader: { family: "Charter" } });

    expect(useSettingsStore.getState().settings.fonts.title.family).toBe("Avenir Next");
    expect(useSettingsStore.getState().settings.fonts.transcriptHeader.family).toBe("Charter");
    expect(document.documentElement.style.getPropertyValue("--font-title")).toContain(
      "Avenir Next",
    );
    expect(document.documentElement.style.getPropertyValue("--font-transcript-heading")).toContain(
      "Charter",
    );

    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]?.updates.fonts?.title.family).toBe("Avenir Next");
    expect(pending[0]?.updates.fonts?.transcriptHeader.family).toBe("IBM Plex Serif");
    persisted = { ...persisted, ...pending[0]!.updates };
    pending[0]!.resolve(structuredClone(persisted));

    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // The first acknowledgement lacks the newer header choice, but may not
    // repaint it away while the second serialized write is pending.
    expect(useSettingsStore.getState().settings.fonts.title.family).toBe("Avenir Next");
    expect(useSettingsStore.getState().settings.fonts.transcriptHeader.family).toBe("Charter");
    expect(pending[1]?.updates.fonts).toMatchObject({
      title: { family: "Avenir Next" },
      transcriptHeader: { family: "Charter" },
    });

    persisted = { ...persisted, ...pending[1]!.updates };
    pending[1]!.resolve(structuredClone(persisted));
    await Promise.all([titleWrite, headerWrite]);

    expect(persisted.fonts.title.family).toBe("Avenir Next");
    expect(persisted.fonts.transcriptHeader.family).toBe("Charter");
    expect(useSettingsStore.getState().settings.fonts).toEqual(persisted.fonts);
  });

  it("restores the last persisted reading fonts when the latest write fails", async () => {
    const persisted = structuredClone(defaultSettings);
    const failure = new Error("settings file is read-only");
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "themes.listUser") return [];
      if (channel === "settings.get") return structuredClone(persisted);
      if (channel === "settings.set") throw failure;
      throw new Error(`Unexpected channel: ${channel}`);
    });
    Object.defineProperty(window, "pivis", {
      configurable: true,
      value: { invoke },
    });

    await useSettingsStore.getState().load();
    const write = useSettingsStore
      .getState()
      .updateReadingFonts({ title: { family: "Avenir Next" } });

    expect(useSettingsStore.getState().settings.fonts.title.family).toBe("Avenir Next");
    await expect(write).rejects.toBe(failure);
    expect(useSettingsStore.getState().settings.fonts.title.family).toBe(
      persisted.fonts.title.family,
    );
    expect(document.documentElement.style.getPropertyValue("--font-title")).toContain(
      persisted.fonts.title.family,
    );
  });
});

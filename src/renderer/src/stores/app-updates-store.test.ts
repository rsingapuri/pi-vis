import type { AppUpdateStatus } from "@shared/app-updates.js";
import { beforeEach, describe, expect, it } from "vitest";
import { readyPromptKey, useAppUpdatesStore } from "./app-updates-store.js";

const downloaded = (releaseName?: string): AppUpdateStatus => ({
  state: "downloaded",
  currentVersion: "0.3.3",
  supported: true,
  releaseName,
});

describe("app update store", () => {
  beforeEach(() => {
    useAppUpdatesStore.setState({ status: null, dismissedReadyFor: null });
  });

  it("dismisses only the prompt, not the downloaded update state", () => {
    useAppUpdatesStore.getState().setStatus(downloaded("0.3.4"));
    useAppUpdatesStore.getState().dismissReadyPrompt();

    expect(useAppUpdatesStore.getState().status?.state).toBe("downloaded");
    expect(useAppUpdatesStore.getState().dismissedReadyFor).toBe("0.3.4");
  });

  it("resets prompt dismissal when a different update is downloaded", () => {
    useAppUpdatesStore.getState().setStatus(downloaded("0.3.4"));
    useAppUpdatesStore.getState().dismissReadyPrompt();
    useAppUpdatesStore.getState().setStatus(downloaded("0.3.5"));

    expect(useAppUpdatesStore.getState().dismissedReadyFor).toBeNull();
  });

  it("can dismiss downloaded updates with empty metadata", () => {
    useAppUpdatesStore.getState().setStatus(downloaded(""));
    useAppUpdatesStore.getState().dismissReadyPrompt();

    expect(useAppUpdatesStore.getState().status?.state).toBe("downloaded");
    expect(useAppUpdatesStore.getState().dismissedReadyFor).toBe("0.3.3:downloaded");
  });
});

describe("readyPromptKey", () => {
  it("keys downloaded updates by non-empty release metadata", () => {
    expect(readyPromptKey(downloaded("0.3.4"))).toBe("0.3.4");
    expect(readyPromptKey(downloaded(""))).toBe("0.3.3:downloaded");
    expect(readyPromptKey({ state: "idle", currentVersion: "0.3.3", supported: true })).toBeNull();
  });
});

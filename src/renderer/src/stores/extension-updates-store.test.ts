import type { ExtensionUpdateStatus } from "@shared/extension-updates.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkExtensionUpdates, useExtensionUpdatesStore } from "./extension-updates-store.js";

const status: ExtensionUpdateStatus = {
  updates: [
    {
      source: "npm:@pi/mcp",
      displayName: "@pi/mcp",
      type: "npm",
      scope: "user",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updateAvailable: true,
    },
  ],
  checkedAt: 123,
};

describe("extension update store", () => {
  beforeEach(() => {
    useExtensionUpdatesStore.setState({ status: null, checking: false, error: null });
  });

  it("shares concurrent checks and retains the successful status", async () => {
    let resolveCheck!: (value: ExtensionUpdateStatus) => void;
    const invoke = vi.fn(
      () =>
        new Promise<ExtensionUpdateStatus>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const competingInvoke = vi.fn(async () => ({ updates: [], checkedAt: 456 }));

    const first = checkExtensionUpdates(invoke);
    const second = checkExtensionUpdates(competingInvoke);
    expect(second).toBe(first);
    expect(useExtensionUpdatesStore.getState().checking).toBe(true);

    resolveCheck(status);
    await expect(first).resolves.toBe(status);
    expect(invoke).toHaveBeenCalledOnce();
    expect(competingInvoke).not.toHaveBeenCalled();
    expect(useExtensionUpdatesStore.getState()).toMatchObject({
      status,
      checking: false,
      error: null,
    });
  });

  it("allows retry after a failed check", async () => {
    await expect(
      checkExtensionUpdates(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(useExtensionUpdatesStore.getState()).toMatchObject({
      status: null,
      checking: false,
      error: "offline",
    });

    await expect(checkExtensionUpdates(async () => status)).resolves.toBe(status);
    expect(useExtensionUpdatesStore.getState()).toMatchObject({
      status,
      checking: false,
      error: null,
    });
  });

  it("does not let a stale cache read overwrite a newer launch event", () => {
    useExtensionUpdatesStore.getState().setStatus({ updates: [], checkedAt: 200 });
    useExtensionUpdatesStore.getState().setStatus(status);

    expect(useExtensionUpdatesStore.getState().status).toEqual({
      updates: [],
      checkedAt: 200,
    });
  });
});

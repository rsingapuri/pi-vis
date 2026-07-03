import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.3.3",
    isPackaged: true,
  },
  autoUpdater: {
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

import { buildAppUpdateFeedUrl } from "./app-updates.js";

describe("buildAppUpdateFeedUrl", () => {
  it("builds the update.electronjs.org feed with platform and arch", () => {
    expect(
      buildAppUpdateFeedUrl({
        owner: "rsingapuri",
        repo: "pi-vis",
        platform: "darwin",
        arch: "arm64",
        version: "0.3.3",
      }),
    ).toBe("https://update.electronjs.org/rsingapuri/pi-vis/darwin-arm64/0.3.3");
  });
});

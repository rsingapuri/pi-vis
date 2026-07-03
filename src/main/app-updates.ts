import type { AppUpdateStatus } from "@shared/app-updates.js";
import { app, autoUpdater } from "electron";

const UPDATE_OWNER = "rsingapuri";
const UPDATE_REPO = "pi-vis";
const UPDATE_SERVER = "https://update.electronjs.org";

export type AppUpdateStatusCallback = (status: AppUpdateStatus) => void;

let initialized = false;
let feedConfigured = false;
let sendStatus: AppUpdateStatusCallback | null = null;
let status: AppUpdateStatus = makeStatus("idle");

export function buildAppUpdateFeedUrl({
  owner = UPDATE_OWNER,
  repo = UPDATE_REPO,
  platform = process.platform,
  arch = process.arch,
  version,
}: {
  owner?: string;
  repo?: string;
  platform?: NodeJS.Platform | string;
  arch?: NodeJS.Architecture | string;
  version: string;
}): string {
  return `${UPDATE_SERVER}/${owner}/${repo}/${platform}-${arch}/${version}`;
}

export function getAppUpdateStatus(): AppUpdateStatus {
  return status;
}

export function initAppUpdates(onStatus: AppUpdateStatusCallback): void {
  sendStatus = onStatus;
  status = makeStatus(isAppUpdaterUsable() ? "idle" : "disabled");

  if (initialized) return;
  initialized = true;

  autoUpdater.on("checking-for-update", () => {
    updateStatus({ state: "checking", checkedAt: Date.now(), error: undefined });
  });

  autoUpdater.on("update-available", () => {
    updateStatus({ state: "available", checkedAt: Date.now(), error: undefined });
  });

  autoUpdater.on("update-not-available", () => {
    updateStatus({ state: "not-available", checkedAt: Date.now(), error: undefined });
  });

  autoUpdater.on(
    "update-downloaded",
    (_event, releaseNotes, releaseName, releaseDate, updateUrl) => {
      updateStatus({
        state: "downloaded",
        releaseNotes: nonEmptyString(releaseNotes),
        releaseName: nonEmptyString(releaseName),
        releaseDate:
          releaseDate instanceof Date ? releaseDate.toISOString() : nonEmptyString(releaseDate),
        updateUrl: nonEmptyString(updateUrl),
        checkedAt: Date.now(),
        error: undefined,
      });
    },
  );

  autoUpdater.on("error", (error) => {
    updateStatus({
      state: "error",
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    });
  });
}

export function checkForAppUpdate(): AppUpdateStatus {
  if (!isAppUpdaterUsable()) {
    status = makeStatus("disabled");
    emitStatus();
    return status;
  }

  configureFeed();

  // Squirrel.Mac already has the update staged. Do not overwrite this state
  // with a new check; the renderer may have dismissed only the prompt while
  // Settings still needs to offer "Restart to install".
  if (status.state === "downloaded") {
    emitStatus();
    return status;
  }

  try {
    autoUpdater.checkForUpdates();
    updateStatus({ state: "checking", checkedAt: Date.now(), error: undefined });
  } catch (error) {
    updateStatus({
      state: "error",
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    });
  }

  return status;
}

export function installAppUpdate(): AppUpdateStatus {
  if (status.state !== "downloaded") return status;

  try {
    autoUpdater.quitAndInstall();
  } catch (error) {
    updateStatus({
      state: "error",
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    });
  }

  return status;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function configureFeed(): void {
  if (feedConfigured) return;
  const url = getFeedUrl();
  autoUpdater.setFeedURL({ url });
  status = { ...status, feedUrl: url };
  feedConfigured = true;
}

function getFeedUrl(): string {
  return (
    process.env["PIVIS_APP_UPDATE_FEED_URL"] ?? buildAppUpdateFeedUrl({ version: app.getVersion() })
  );
}

function isAppUpdaterUsable(): boolean {
  return (
    process.platform === "darwin" &&
    app.isPackaged &&
    process.env["PIVIS_DISABLE_APP_UPDATES"] !== "1"
  );
}

function makeStatus(state: AppUpdateStatus["state"]): AppUpdateStatus {
  return {
    state,
    currentVersion: app.getVersion(),
    supported: process.platform === "darwin" && app.isPackaged,
    ...(feedConfigured ? { feedUrl: getFeedUrl() } : {}),
  };
}

function updateStatus(next: Partial<AppUpdateStatus>): void {
  status = {
    ...status,
    ...next,
    currentVersion: app.getVersion(),
    supported: process.platform === "darwin" && app.isPackaged,
    ...(feedConfigured ? { feedUrl: getFeedUrl() } : {}),
  };
  emitStatus();
}

function emitStatus(): void {
  sendStatus?.(status);
}

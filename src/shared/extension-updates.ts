/** Extension-package update awareness, intentionally separate from Pi-Vis app updates. */

export interface ExtensionUpdate {
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: "user";
  /** Version read from the installed package or checkout. */
  currentVersion: string | null;
  /** Latest version reported by the package registry or git remote. */
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface ExtensionUpdateStatus {
  /** All installed user extensions, not only extensions with updates. */
  updates: ExtensionUpdate[];
  checkedAt: number;
}

/** The pinned pi runtime is deliberately not an update target. */
export type ExtensionUpdateTarget = "all" | { extension: string };

export interface ExtensionUpdateRunResult {
  exitCode: number;
  timedOut: boolean;
}

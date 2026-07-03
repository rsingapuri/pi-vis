/**
 * Update types for the Pi-Vis desktop app itself.
 *
 * This is intentionally separate from updates.ts, which tracks the user's
 * installed pi binary and pi extensions.
 */

export type AppUpdateState =
  | "idle"
  | "disabled"
  | "checking"
  | "available"
  | "not-available"
  | "downloaded"
  | "error";

export interface AppUpdateStatus {
  state: AppUpdateState;
  currentVersion: string;
  /** Release name/version reported by the update feed when known. */
  releaseName?: string | undefined;
  /** Release notes reported by the update feed when known. */
  releaseNotes?: string | undefined;
  /** Published date reported by the update feed when known. */
  releaseDate?: string | undefined;
  /** Download URL reported by Squirrel.Mac when known. */
  updateUrl?: string | undefined;
  /** Human-readable error when state === "error". */
  error?: string | undefined;
  /** Whether this runtime/platform can use Electron's built-in autoUpdater. */
  supported: boolean;
  /** Current feed URL, present after the updater is configured. */
  feedUrl?: string | undefined;
  checkedAt?: number | undefined;
}

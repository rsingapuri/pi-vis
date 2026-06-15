/**
 * Update types for pi-vis in-app update awareness.
 */

export interface PiUpdateStatus {
  current: string;
  latest?: string | undefined;
  updateAvailable: boolean;
  note?: string | undefined;
}

export interface ExtensionUpdate {
  source: string;
  name: string;
  current?: string | undefined;
  latest?: string | undefined;
  updateAvailable: boolean;
  kind: "npm" | "git" | "local";
}

export interface UpdateStatus {
  pi: PiUpdateStatus;
  extensions: ExtensionUpdate[];
  checkedAt: number;
}

import type { AppUpdateStatus } from "@shared/app-updates.js";
import { create } from "zustand";

interface AppUpdatesStore {
  status: AppUpdateStatus | null;
  dismissedReadyFor: string | null;
  setStatus: (status: AppUpdateStatus) => void;
  dismissReadyPrompt: () => void;
}

export const useAppUpdatesStore = create<AppUpdatesStore>((set) => ({
  status: null,
  dismissedReadyFor: null,

  setStatus: (status) =>
    set((state) => {
      const previousKey = readyPromptKey(state.status);
      const nextKey = readyPromptKey(status);
      return {
        status,
        dismissedReadyFor:
          previousKey !== null && nextKey !== null && previousKey === nextKey
            ? state.dismissedReadyFor
            : null,
      };
    }),

  dismissReadyPrompt: () =>
    set((state) => {
      const key = readyPromptKey(state.status);
      return key !== null ? { dismissedReadyFor: key } : {};
    }),
}));

export function readyPromptKey(status: AppUpdateStatus | null): string | null {
  if (status?.state !== "downloaded") return null;
  return (
    firstNonEmpty(status.releaseName, status.updateUrl, status.releaseDate) ??
    `${status.currentVersion}:downloaded`
  );
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

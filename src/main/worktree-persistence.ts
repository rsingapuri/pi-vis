import type { AppSettings } from "@shared/settings.js";
import { getSettings, saveSettings } from "./settings-store.js";

type WorktreeAssociation = AppSettings["worktrees"][string];

interface RespawnAndPersistWorktreeOptions {
  worktreePath: string;
  association: WorktreeAssociation;
  respawn: () => Promise<void>;
}

/**
 * Commit a session's worktree association only after its replacement host is
 * ready. The settings read intentionally happens after the await: concurrent
 * worktree operations must merge into the latest persisted map rather than
 * replacing it with a snapshot captured before either respawn completed.
 */
export async function respawnAndPersistWorktree({
  worktreePath,
  association,
  respawn,
}: RespawnAndPersistWorktreeOptions): Promise<void> {
  await respawn();

  // Keep this read-modify-write synchronous. Yielding here would reintroduce
  // the lost-update race this commit boundary is designed to prevent.
  saveSettings({
    worktrees: {
      ...getSettings().worktrees,
      [worktreePath]: association,
    },
  });
}

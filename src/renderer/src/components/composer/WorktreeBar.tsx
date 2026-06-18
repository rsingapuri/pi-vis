import type { GitBranch } from "@shared/git.js";
import type { SessionId } from "@shared/ids.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { gitRootForSession, useSessionsStore } from "../../stores/sessions-store.js";
import { BranchDropdown } from "../common/BranchDropdown.js";
import "./WorktreeBar.css";

interface WorktreeBarProps {
  sessionId: SessionId;
}

export function WorktreeBar({ sessionId }: WorktreeBarProps): React.ReactElement | null {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const setWorktreeCreate = useSessionsStore((s) => s.setWorktreeCreate);
  const setWorktreeBase = useSessionsStore((s) => s.setWorktreeBase);
  const addToast = useSessionsStore((s) => s.addToast);
  const gitRoot = gitRootForSession(session);

  // Load branches via IPC
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeRemote, setIncludeRemote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!gitRoot) {
      setLoading(false);
      setLoadError("No workspace path");
      return;
    }
    setLoading(true);
    setLoadError(null);
    window.pivis
      .invoke("git.branches", { root: gitRoot })
      .then(
        (res: {
          kind: string;
          current?: string | null;
          branches?: GitBranch[];
          message?: string;
        }) => {
          if (cancelled) return;
          if (res.kind === "ok" && res.branches) {
            setBranches(res.branches);
            setCurrentBranch(res.current ?? null);
          } else {
            setLoadError((res as { message?: string }).message ?? "Could not load branches");
          }
          setLoading(false);
        },
      )
      .catch((err: Error) => {
        if (!cancelled) {
          setLoadError(String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [gitRoot]);

  // Load the diffIncludeRemoteBranches setting
  useEffect(() => {
    window.pivis
      .invoke("settings.get", undefined)
      .then((s: { diffIncludeRemoteBranches?: boolean }) => {
        if (s?.diffIncludeRemoteBranches != null) {
          setIncludeRemote(s.diffIncludeRemoteBranches);
        }
      })
      .catch(() => {});
  }, []);

  const handleToggleRemote = useCallback(() => {
    const next = !includeRemote;
    setIncludeRemote(next);
    window.pivis.invoke("settings.set", {
      diffIncludeRemoteBranches: next,
    });
  }, [includeRemote]);

  // Self-gate: hide once a worktree already exists for this session (so it
  // never reappears after the transcript resets via /new, /fork, /clone),
  // if the session has any transcript blocks (already sent), or if we're not
  // in a git repo context.
  if (!session) return null;
  if (session.worktreePath) return null;
  if (session.transcript.blocks.length > 0) return null;
  if (loading) return null;
  if (loadError || branches.length === 0) return null;

  const checked = session.worktreeCreate ?? false;
  const creating = session.worktreeCreating ?? false;
  const base = session.worktreeBase ?? currentBranch;

  const handleCheck = () => {
    const next = !checked;
    setWorktreeCreate(sessionId, next);
    if (!next) {
      // Reverting: reset the shown branch to the checked-out one
      setWorktreeBase(sessionId, null);
    } else {
      // Just checked: default to current branch
      setWorktreeBase(sessionId, currentBranch);
    }
  };

  return (
    <div className="worktree-bar">
      <label className="worktree-bar__checkbox-label">
        <input
          type="checkbox"
          className="worktree-bar__checkbox"
          checked={checked}
          onChange={handleCheck}
          disabled={creating}
        />
        <span>Create worktree</span>
      </label>

      <BranchDropdown
        branches={branches}
        currentBranch={currentBranch}
        value={checked ? base : currentBranch}
        onChange={(b) => {
          if (checked && b !== null) {
            setWorktreeBase(sessionId, b);
          }
        }}
        includeRemoteBranches={includeRemote}
        onToggleRemote={handleToggleRemote}
        disabled={!checked || creating}
        triggerLabel={checked ? (base ?? "branch") : (currentBranch ?? "branch")}
        placement="top"
      />

      {creating && <span className="worktree-bar__spinner">Creating worktree…</span>}
    </div>
  );
}

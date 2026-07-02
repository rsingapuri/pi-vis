import type { GitBranch } from "@shared/git.js";
import type { SessionId } from "@shared/ids.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitRootForSession, useSessionsStore } from "../../stores/sessions-store.js";
import { BranchDropdown } from "../common/BranchDropdown.js";
import { IconCheck } from "../common/icons.js";
import "./WorktreeBar.css";

interface WorktreeBarProps {
  sessionId: SessionId;
}

type AttachStatus =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "ok"; branch: string; name: string }
  | { kind: "error"; message: string };

type WorktreeMode = "none" | "create" | "attach";

export function WorktreeBar({ sessionId }: WorktreeBarProps): React.ReactElement | null {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const setWorktreeMode = useSessionsStore((s) => s.setWorktreeMode);
  const setWorktreeAttachPath = useSessionsStore((s) => s.setWorktreeAttachPath);
  const setWorktreeBase = useSessionsStore((s) => s.setWorktreeBase);
  const gitRoot = gitRootForSession(session);

  // Load branches via IPC (used by the "New" mode's BranchDropdown).
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

  // Load the diffIncludeRemoteBranches setting once.
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

  // Stable remote-toggle handler — keeps BranchDropdown's memoization intact
  // across re-renders (e.g. while the validation status line is updating).
  const handleToggleRemote = useMemo(
    () => () => {
      setIncludeRemote((prev) => {
        void window.pivis.invoke("settings.set", {
          diffIncludeRemoteBranches: !prev,
        });
        return !prev;
      });
    },
    [],
  );

  // Self-gate: hide once a worktree already exists for this session (so it
  // never reappears after the transcript resets via /new, /fork, /clone),
  // if the session has any transcript blocks (already sent), or if we're not
  // in a git repo context (no branches to base from).
  if (!session) return null;
  if (session.worktreePath) return null;
  if (session.transcript.blocks.length > 0) return null;
  if (loading) return null;
  if (loadError || branches.length === 0) return null;

  const mode = (session.worktreeMode ?? "none") as WorktreeMode;
  const creating = session.worktreeCreating ?? false;
  const worktreeError = session.worktreeError ?? null;
  const base = session.worktreeBase ?? currentBranch;

  return (
    <div className="worktree-bar">
      <div className="worktree-bar__row">
        <SegmentedControl
          mode={mode}
          disabled={creating}
          onChange={(next) => {
            if (next === "create") {
              // Just switched to "New": seed the base branch to the
              // currently checked-out one (same default the old checkbox
              // had on first check).
              setWorktreeMode(sessionId, "create");
              setWorktreeBase(sessionId, currentBranch);
            } else if (next === "attach") {
              setWorktreeMode(sessionId, "attach");
            } else {
              // "none" — clear the intent entirely.
              setWorktreeMode(sessionId, "none");
              setWorktreeBase(sessionId, null);
            }
          }}
        />

        {/* Mode-specific controls — sit next to the segmented control so
            the whole bar reads as one row when the window is wide. */}
        {mode === "create" && (
          <BranchDropdown
            branches={branches}
            currentBranch={currentBranch}
            value={base}
            onChange={(b) => {
              if (b !== null) setWorktreeBase(sessionId, b);
            }}
            includeRemoteBranches={includeRemote}
            onToggleRemote={handleToggleRemote}
            disabled={creating}
            triggerLabel={base ?? "branch"}
            placement="top"
          />
        )}

        {mode === "attach" && (
          <AttachMode
            sessionId={sessionId}
            attachPath={session.worktreeAttachPath ?? ""}
            disabled={creating}
            onPathChange={(p) => setWorktreeAttachPath(sessionId, p)}
          />
        )}

        {creating && (
          <span className="worktree-bar__spinner">
            <span className="worktree-bar__spinner-dot" aria-hidden="true" />
            {mode === "attach" ? "Attaching worktree…" : "Creating worktree…"}
          </span>
        )}
      </div>

      {/* Validation status line for attach mode (advisory — does not gate send). */}
      {mode === "attach" && !creating && <AttachStatusLine sessionId={sessionId} />}

      {/* Inline, durable failure message (create or attach). */}
      {worktreeError && !creating && (
        <div className="worktree-bar__error" role="alert">
          <span className="worktree-bar__error-icon" aria-hidden="true">
            ⚠
          </span>
          <span className="worktree-bar__error-text">{worktreeError}</span>
        </div>
      )}
    </div>
  );
}

// ── Segmented control ────────────────────────────────────────────────
//
// Three-way selector: In Workspace | New Worktree | Existing Worktree.
// pill with the active segment highlighted in mauve (matching the
// BranchDropdown's accent). Keyboard-operable (button group).
function SegmentedControl({
  mode,
  disabled,
  onChange,
}: {
  mode: WorktreeMode;
  disabled: boolean;
  onChange: (next: WorktreeMode) => void;
}): React.ReactElement {
  const segments: { value: WorktreeMode; label: string }[] = [
    { value: "none", label: "In Workspace" },
    { value: "create", label: "New Worktree" },
    { value: "attach", label: "Existing Worktree" },
  ];
  return (
    <div className="worktree-bar__segmented" role="group" aria-label="Worktree mode">
      {segments.map((seg) => {
        const active = mode === seg.value;
        return (
          <button
            key={seg.value}
            type="button"
            className={`worktree-bar__segment${active ? " worktree-bar__segment--active" : ""}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => {
              if (!active) onChange(seg.value);
            }}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Attach mode (path input + Browse) ───────────────────────────────
//
// `setWorktreeAttachPath` is the single source of truth for the path
// value. Live validation runs as a debounced side-effect on every
// change; the result is shown by AttachStatusLine (advisory — the
// authoritative validation happens server-side in
// `session.attachWorktree`).
function AttachMode({
  sessionId,
  attachPath,
  disabled,
  onPathChange,
}: {
  sessionId: SessionId;
  attachPath: string;
  disabled: boolean;
  onPathChange: (p: string) => void;
}): React.ReactElement {
  const [browseBusy, setBrowseBusy] = useState(false);

  const handleBrowse = useCallback(async () => {
    const session = useSessionsStore.getState().sessions.get(sessionId);
    const workspacePath = session?.workspacePath;
    if (!workspacePath) return;
    setBrowseBusy(true);
    try {
      const picked = await window.pivis.invoke("worktree.pickDirectory", {
        workspacePath,
      });
      if (typeof picked === "string" && picked.length > 0) {
        onPathChange(picked);
      }
    } catch {
      // Swallow — the picker may have failed (e.g. dialog dismissed
      // unexpectedly). The text input still works as a fallback.
    } finally {
      setBrowseBusy(false);
    }
  }, [sessionId, onPathChange]);

  return (
    <div className="worktree-bar__attach">
      <input
        type="text"
        className="worktree-bar__attach-input"
        value={attachPath}
        onChange={(e) => onPathChange(e.target.value)}
        placeholder="/path/to/worktree"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        disabled={disabled}
        aria-label="Worktree directory path"
      />
      <button
        type="button"
        className="worktree-bar__attach-browse"
        onClick={() => void handleBrowse()}
        disabled={disabled || browseBusy}
      >
        {browseBusy ? "…" : "Browse…"}
      </button>
    </div>
  );
}

// ── Attach validation status line ────────────────────────────────────
//
// Debounced live validation of the path in `worktreeAttachPath`. Stale
// responses are dropped via a monotonic request id so a slow validate
// for an older path can't overwrite a newer one. The line is advisory
// only — the actual submit is gated by `session.attachWorktree`
// re-running `inspectWorktree` server-side.
function AttachStatusLine({ sessionId }: { sessionId: SessionId }): React.ReactElement | null {
  // Subscribe to the path directly so we re-run when it changes (and to
  // the workspace path so we re-run when the workspace context shifts).
  const attachPath = useSessionsStore((s) => s.sessions.get(sessionId)?.worktreeAttachPath ?? "");
  const workspacePath = useSessionsStore((s) => s.sessions.get(sessionId)?.workspacePath);
  const [status, setStatus] = useState<AttachStatus>({ kind: "idle" });
  const requestIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workspacePath) return;
    if (!attachPath.trim()) {
      // Empty path: show a quiet hint (no error, no spinner).
      setStatus({ kind: "idle" });
      return;
    }
    // Bump the request id so any in-flight (older) response is ignored.
    const myId = ++requestIdRef.current;
    setStatus({ kind: "validating" });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      window.pivis
        .invoke("worktree.validate", { workspacePath, path: attachPath })
        .then((res: { ok: true; branch: string; name: string } | { ok: false; error: string }) => {
          if (myId !== requestIdRef.current) return; // stale
          if (res.ok) {
            setStatus({ kind: "ok", branch: res.branch, name: res.name });
          } else {
            setStatus({ kind: "error", message: res.error });
          }
        })
        .catch((err: Error) => {
          if (myId !== requestIdRef.current) return; // stale
          setStatus({ kind: "error", message: String(err) });
        });
    }, 300); // ~300ms — keeps the line responsive without thrashing IPC

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [attachPath, workspacePath]);

  if (status.kind === "idle") return null;

  if (status.kind === "validating") {
    return (
      <div className="worktree-bar__status worktree-bar__status--validating">
        <span className="worktree-bar__spinner-dot" aria-hidden="true" />
        <span>Checking…</span>
      </div>
    );
  }

  if (status.kind === "ok") {
    return (
      <div className="worktree-bar__status worktree-bar__status--ok">
        <IconCheck />
        <span>On branch {status.branch}</span>
      </div>
    );
  }

  // error
  return (
    <div className="worktree-bar__error" role="alert">
      <span className="worktree-bar__error-icon" aria-hidden="true">
        ⚠
      </span>
      <span className="worktree-bar__error-text">{status.message}</span>
    </div>
  );
}

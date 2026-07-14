import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { runWorktreeOperation } from "../../lib/worktree-operation.js";
import { authoritySnapshotFor, useSessionsStore } from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";
import { WorktreeAttachField } from "../common/WorktreeAttachField.js";
import { IconBranch, IconChevronDown, IconCopy } from "../common/icons.js";
import "./WorktreeSwitcher.css";

type SwitchMode = "create" | "attach";

export function WorktreeSwitcher({
  sessionId,
}: { sessionId: SessionId }): React.ReactElement | null {
  const session = useSessionsStore((state) => state.sessions.get(sessionId));
  const addToast = useSessionsStore((state) => state.addToast);
  const setWorktreeAttachPath = useSessionsStore((state) => state.setWorktreeAttachPath);
  const setWorktreeError = useSessionsStore((state) => state.setWorktreeError);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SwitchMode>("create");
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const createModeRef = useRef<HTMLButtonElement>(null);

  useEscapeClaim(open);

  const close = useCallback(() => {
    if (session?.worktreeCreating) return;
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, [session?.worktreeCreating]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => createModeRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent): void => {
      if (!popupRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [close, open]);

  // Deliberately use a native bubble listener so nested controls can consume
  // Escape before this closes the whole card.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  if (!session || (!session.worktreePath && !session.sessionFile)) return null;

  const path = session.worktreePath ?? session.workspacePath;
  const locationName = session.worktreeName ?? "Workspace";
  const branchDetail = session.worktreeBranch
    ? `${session.worktreeBranch}${
        session.worktreeFromBase && session.worktreeFromBase !== session.worktreeBranch
          ? ` · from ${session.worktreeFromBase}`
          : ""
      }`
    : "Workspace checkout";
  const authoritySnapshot = authoritySnapshotFor(session);
  const runtimeCanApply =
    session.status === "ready" &&
    session.availability === "available" &&
    authoritySnapshot?.sdk.isIdle === true &&
    !session.worktreeCreating;
  const canApply = runtimeCanApply && (mode === "create" || !!session.worktreeAttachPath?.trim());
  const blockedReason = session.worktreeCreating
    ? "Switching worktree…"
    : session.status !== "ready"
      ? "Wait for the session to be ready."
      : session.availability !== "available"
        ? "Session runtime is unavailable."
        : authoritySnapshot?.sdk.isIdle !== true
          ? "Wait for the current turn to finish."
          : null;

  const toggleOpen = (): void => {
    if (open) {
      close();
    } else {
      setOpen(true);
    }
  };

  const copyPath = (): void => {
    void window.pivis
      .invoke("clipboard.writeText", { text: path })
      .then(() => addToast(sessionId, "Worktree path copied", "info"))
      .catch(() => addToast(sessionId, "Failed to copy worktree path", "error"));
  };

  const changeMode = (next: SwitchMode): void => {
    setMode(next);
    setWorktreeError(sessionId, null);
  };

  const apply = async (): Promise<void> => {
    if (!canApply) return;
    const result = await runWorktreeOperation({
      sessionId,
      mode,
      ...(mode === "create" ? { fromCurrentCheckout: true } : { path: session.worktreeAttachPath }),
    });
    if (result.ok) close();
  };

  return (
    <div className="worktree-switcher" ref={popupRef}>
      <button
        ref={triggerRef}
        type="button"
        className="worktree-switcher__trigger fade-scope"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="worktree-switcher-trigger"
      >
        <IconBranch />
        <FadeText className="worktree-switcher__trigger-label">{locationName}</FadeText>
        <IconChevronDown className="worktree-switcher__caret" />
      </button>
      {open && (
        <div className="worktree-switcher__card" role="dialog" aria-label="Switch worktree">
          <div className="worktree-switcher__location">
            <div className="worktree-switcher__location-copy">
              <span className="worktree-switcher__eyebrow">Current location</span>
              <strong>{locationName}</strong>
              <FadeText className="worktree-switcher__branch-detail" title={branchDetail}>
                {branchDetail}
              </FadeText>
              <FadeText className="worktree-switcher__path" title={path} head>
                {path}
              </FadeText>
            </div>
            <button
              type="button"
              className="icon-btn worktree-switcher__copy"
              aria-label="Copy worktree path"
              title="Copy path"
              onClick={copyPath}
            >
              <IconCopy />
            </button>
          </div>
          <div className="worktree-switcher__segments" role="group" aria-label="Worktree type">
            <button
              ref={createModeRef}
              type="button"
              className={
                mode === "create"
                  ? "worktree-switcher__segment worktree-switcher__segment--active"
                  : "worktree-switcher__segment"
              }
              onClick={() => changeMode("create")}
              disabled={!!session.worktreeCreating}
              aria-pressed={mode === "create"}
            >
              New worktree
            </button>
            <button
              type="button"
              className={
                mode === "attach"
                  ? "worktree-switcher__segment worktree-switcher__segment--active"
                  : "worktree-switcher__segment"
              }
              onClick={() => changeMode("attach")}
              disabled={!!session.worktreeCreating}
              aria-pressed={mode === "attach"}
            >
              Existing
            </button>
          </div>
          {mode === "attach" && (
            <div className="worktree-switcher__field">
              <WorktreeAttachField
                workspacePath={session.workspacePath}
                currentCheckoutPath={session.worktreePath ?? session.workspacePath}
                path={session.worktreeAttachPath ?? ""}
                onPathChange={(next) => setWorktreeAttachPath(sessionId, next)}
                disabled={!!session.worktreeCreating}
              />
            </div>
          )}
          {session.worktreeError && (
            <div className="worktree-switcher__error" role="alert">
              {session.worktreeError}
            </div>
          )}
          {blockedReason && <p className="worktree-switcher__blocked">{blockedReason}</p>}
          <div className="worktree-switcher__actions">
            <button
              type="button"
              className="worktree-switcher__cancel"
              onClick={close}
              disabled={!!session.worktreeCreating}
            >
              Cancel
            </button>
            <button
              type="button"
              className="worktree-switcher__apply"
              onClick={() => void apply()}
              disabled={!canApply}
            >
              {mode === "create" ? "Create & switch" : "Switch worktree"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

import type { SessionId } from "@shared/ids.js";
import type { ModelInfo } from "@shared/pi-protocol/responses.js";
import type {
  IntentOutcome,
  RuntimeIdentity,
  SessionIntent,
  SessionQuery,
} from "@shared/pi-protocol/runtime-state.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import {
  BUILTIN_COMMANDS,
  InputNotConsumedError,
  type PickerRequest,
  executeAction,
  parseComposerInput,
} from "../../lib/commands/index.js";
import {
  type FileAttachment,
  type ImageAttachment,
  type ReplicatedComposerAttachment,
  parseReplicatedAttachments,
  runtimeImagesFromAttachments,
  serializeComposerAttachments,
  textWithAppendedFilePaths,
  textWithPrependedFilePaths,
} from "../../lib/composer-attachments.js";
import { prependCodeCommentsToPrompt } from "../../lib/diff-comments.js";
import { findCurrentModel } from "../../lib/model-utils.js";
import { RENDERER_GENERATION } from "../../lib/renderer-generation.js";
import { dispatchSessionIntent, querySession } from "../../lib/session-intent.js";
import { runWorktreeOperation } from "../../lib/worktree-operation.js";
import { useChangelogStore } from "../../stores/changelog-store.js";
import { openDiffForSession } from "../../stores/diff-store.js";
import { useImageViewerStore } from "../../stores/image-viewer-store.js";
import { useOverlayStore } from "../../stores/overlay-store.js";
import {
  authoritySnapshotFor,
  hasAuthoritativeSemanticState,
  isNewSessionPending,
  isSessionWorking,
  sessionHasHistory,
  submissionDispositionKey,
  useSessionsStore,
} from "../../stores/sessions-store.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconClose, IconComment, IconFile } from "../common/icons.js";
import "./Composer.css";

interface ComposerProps {
  sessionId: SessionId;
}

type FileWithLegacyPath = File & { path?: string };

const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSION.test(file.name);
}

function pathForPickedFile(file: File): string {
  try {
    const path = window.pivis.getPathForFile(file);
    if (path) return path;
  } catch {
    // Older Electron builds exposed a non-standard File.path property; keep it
    // as a defensive fallback if contextBridge cannot proxy the File object.
  }
  return (file as FileWithLegacyPath).path || file.name;
}

function nameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}

function mayFocusComposer(textarea: HTMLTextAreaElement): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    active === document.documentElement ||
    active === textarea
  );
}

function mayExplicitlyFocusComposer(textarea: HTMLTextAreaElement): boolean {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement || active === textarea)
    return true;
  if (!(active instanceof HTMLElement)) return false;
  // Sidebar and ordinary buttons are deliberate entry controls. Never pull
  // focus from an input, editable surface, Composer, or terminal/panel slot.
  if (
    active.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) ||
    active.closest(".composer, .custom-panel, .unified-tui, .picker-slot")
  ) {
    return false;
  }
  return true;
}

function fileAttachmentsFromEditorText(text: string): FileAttachment[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  if (!lines.every((line) => /^\/(?!\s)(?:.*\/)?[^/\s]+$/.test(line))) return null;
  return lines.map((path) => ({ path, name: nameFromPath(path) }));
}

interface SuggestionEntry {
  name: string;
  badge: "built-in" | "extension" | "prompt" | "skill";
  description?: string | undefined;
  argHint?: string | undefined;
  scope?: string | undefined;
  /** Composite key for React list reconciliation. */
  key: string;
}

/**
 * Composer — terminal-style prompt input.
 *
 * The TUI parity flow:
 *   1. Type → updates `text` + the slash-suggestion list.
 *   2. Enter → parseComposerInput → executeAction via injected deps.
 *   3. Slash commands route to dedicated RPC commands (`/model`, `/name`,
 *      `/new`, `/compact`, etc.); extension/prompt/skill names + unknown
 *      `/foo` are sent to pi as `prompt` (pi expands templates/skills and
 *      dispatches extensions immediately, even mid-stream).
 *
 * The no-model guard applies ONLY to plain-text prompts — `/model` and
 * bash work without a model selected, because they're not asking the
 * LLM for anything.
 */
export function Composer({ sessionId }: ComposerProps): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renderedSessionIdRef = useRef(sessionId);
  renderedSessionIdRef.current = sessionId;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [text, setText] = useState("");
  const textRef = useRef("");
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Container for the slash-suggestion list. Used to scroll the
  // keyboard-selected row into view during arrow-key navigation so the
  // highlight can't outrun the visible viewport (the list scrolls, not the
  // whole pane — see .composer__suggestion-list's internal overflow-y).
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  // Re-entrancy guard for `handleSubmit`. De-duplicate only the same content:
  // a distinct command/prompt typed while an earlier operation is finishing is
  // a legitimate rapid submission and must still reach host custody.
  const submissionsInFlightRef = useRef(new Set<string>());
  const editorRevisionRef = useRef(0);
  // Host snapshots may advance the editor revision when an accepted submit
  // clears custody. Track renderer-originated edits separately so that
  // acknowledgement cannot be confused with newer user typing/attachments.
  const localEditGenerationRef = useRef(0);
  const editorPatchTailRef = useRef<Promise<"accepted" | "rejected" | "failed">>(
    Promise.resolve("accepted"),
  );
  const editorPatchEpochRef = useRef(0);
  const editorPatchRetryNeededRef = useRef(false);
  const replicatedAttachmentsRef = useRef<ReplicatedComposerAttachment[]>([]);
  const pendingOrdinaryPromptRef = useRef<
    | {
        intentId: string;
        owner: RuntimeIdentity;
        editorRevision: number;
        text: string;
        attachmentsKey: string;
        localEditGeneration: number;
        editorInjectionNonce?: number;
      }
    | undefined
  >(undefined);

  // Pull the active session's state. We read everything we might need at
  // submit time from the same snapshot to avoid a render-during-update race.
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const submissionDispositions = useSessionsStore((s) => s.submissionDispositions);
  const composerFocusRequest = useSessionsStore((s) => s.composerFocusRequest);
  const consumeComposerFocus = useSessionsStore((s) => s.consumeComposerFocus);
  const escapeClaimCount = useOverlayStore((s) => s.count);
  const semanticSnapshot = authoritySnapshotFor(session);
  const commands = session?.commands ?? [];
  const discovered = useMemo(() => new Map(commands.map((c) => [c.name, c])), [commands]);
  // The nonce is a monotonic counter; the effect below re-runs whenever
  // it changes (even if the text is identical) so the user can re-inject
  // the same prefix on demand.
  const editorInjectionNonce = session?.editorInjection?.nonce;
  const editorInjectionMayPreserveDraft = session?.editorInjection?.preserveRendererDraft === true;
  const processedEditorInjectionRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    replicatedAttachmentsRef.current = serializeComposerAttachments(attachments, fileAttachments);
  }, [attachments, fileAttachments]);

  const editorHostInstanceId = semanticSnapshot?.owner.hostInstanceId;
  const editorSessionEpoch = semanticSnapshot?.owner.sessionEpoch;
  useEffect(() => {
    // Re-seed from the latest replicated value whenever composer custody moves
    // to another session/host generation. Reading through the store avoids
    // resetting the serialized patch chain on every snapshot revision.
    const current = useSessionsStore.getState().sessions.get(sessionId);
    const currentSnapshot = authoritySnapshotFor(current);
    editorRevisionRef.current = currentSnapshot?.editor.revision ?? 0;
    editorPatchEpochRef.current++;
    editorPatchRetryNeededRef.current = false;
    editorPatchTailRef.current = Promise.resolve("accepted");
    const restored = parseReplicatedAttachments(currentSnapshot?.editor.attachments ?? []);
    replicatedAttachmentsRef.current = serializeComposerAttachments(
      restored.images,
      restored.files,
    );
    setAttachments(restored.images);
    setFileAttachments(restored.files);
    void editorHostInstanceId;
    void editorSessionEpoch;
  }, [sessionId, editorHostInstanceId, editorSessionEpoch]);

  const authoritativeEditorRevision = semanticSnapshot?.editor.revision;
  useEffect(() => {
    // External host edits (extensions/unified TUI) advance the revision. Local
    // optimistic patches already advance the ref first, so only move forward.
    if (
      authoritativeEditorRevision !== undefined &&
      authoritativeEditorRevision > editorRevisionRef.current
    ) {
      editorRevisionRef.current = authoritativeEditorRevision;
    }
  }, [authoritativeEditorRevision]);

  const synchronizeEditorText = useCallback(
    (nextText: string, nextAttachments = replicatedAttachmentsRef.current): number => {
      localEditGenerationRef.current++;
      const baseRevision = editorRevisionRef.current;
      const revision = baseRevision + 1;
      const patchEpoch = editorPatchEpochRef.current;
      const runtimeIdentity = useSessionsStore.getState().sessions.get(sessionId);
      const runtimeSnapshot = authoritySnapshotFor(runtimeIdentity);
      if (!runtimeSnapshot) return baseRevision;
      const expectedHostInstanceId = runtimeSnapshot.owner.hostInstanceId;
      const expectedSessionEpoch = runtimeSnapshot.owner.sessionEpoch;
      editorRevisionRef.current = revision;
      // Component-local file/image objects are a retention root immediately,
      // before the async host acknowledgement, so a rapid session switch
      // cannot reap an attachment-only pending composer.
      useSessionsStore.getState().stageEditorAttachments(sessionId, nextAttachments);
      useSessionsStore.getState().beginEditorPatch(sessionId);
      editorPatchTailRef.current = editorPatchTailRef.current.then(async () => {
        try {
          // A rejection fences every patch that was already queued from the
          // rejected optimistic revision chain. Only a subsequent user edit,
          // created in the new epoch and rebased to the host revision, may
          // resolve the preserved conflict.
          if (patchEpoch !== editorPatchEpochRef.current) return "rejected";
          // A local command may synchronously replace the host (/new, reload,
          // worktree switch) before this serialized optimistic patch reaches
          // IPC. Silently retire that stale patch instead of invoking main
          // against an owner that can no longer accept it.
          const latestSnapshot = authoritySnapshotFor(
            useSessionsStore.getState().sessions.get(sessionId),
          );
          if (
            !latestSnapshot ||
            latestSnapshot.owner.hostInstanceId !== expectedHostInstanceId ||
            latestSnapshot.owner.sessionEpoch !== expectedSessionEpoch
          ) {
            return "rejected";
          }
          const result = await window.pivis.invoke("session.editorPatch", {
            sessionId,
            expectedHostInstanceId,
            expectedSessionEpoch,
            baseRevision,
            revision,
            text: nextText,
            attachments: nextAttachments,
          });
          if (patchEpoch !== editorPatchEpochRef.current) return "rejected";
          // /new and host replacement can begin in the narrow interval after
          // the renderer fence above and before main admits this patch. They
          // are normal owner-bound rejections, not synchronization conflicts:
          // retire this whole optimistic chain, retain the visible draft, and
          // never let queued predecessor work cross into the replacement.
          if (
            result.rejection === "runtime_unavailable" ||
            result.rejection === "runtime_replaced"
          ) {
            editorPatchEpochRef.current++;
            editorRevisionRef.current =
              useSessionsStore.getState().sessions.get(sessionId)?.editorRevision ??
              result.revision;
            return "rejected";
          }
          if (result.accepted) {
            useSessionsStore.getState().acknowledgeEditorPatch(sessionId, result.revision);
            // A snapshot sent just before this acknowledgement may have
            // scheduled an older editor injection. Re-assert the accepted
            // local value, but never overwrite typing at a newer revision.
            if (editorRevisionRef.current === result.revision) setText(nextText);
            editorPatchRetryNeededRef.current = false;
            return "accepted";
          }
          editorPatchEpochRef.current++;
          editorRevisionRef.current = result.revision;
          // Preserve both values. The host snapshot carries conflictText and
          // the local textarea remains untouched for explicit user review.
          useSessionsStore
            .getState()
            .addToast(
              sessionId,
              "Editor changed in an extension; both versions were preserved.",
              "warning",
            );
          return "rejected";
        } catch (error) {
          if (patchEpoch === editorPatchEpochRef.current) {
            editorPatchEpochRef.current++;
            editorRevisionRef.current =
              useSessionsStore.getState().sessions.get(sessionId)?.editorRevision ?? baseRevision;
            editorPatchRetryNeededRef.current = true;
            useSessionsStore
              .getState()
              .addToast(
                sessionId,
                `Editor synchronization failed; input was not sent: ${String(error)}`,
                "error",
              );
          }
          return "failed";
        } finally {
          useSessionsStore.getState().endEditorPatch(sessionId);
        }
      });
      return revision;
    },
    [sessionId],
  );

  const editorConflict = session?.editorConflict;
  const resolveEditorConflict = useCallback(
    (choice: "authoritative" | "local" | "alternate" | "additional", index = 0) => {
      if (!editorConflict) return;
      const additional = editorConflict.additionalCandidates?.[index];
      const value =
        choice === "authoritative"
          ? editorConflict.authoritativeText
          : choice === "alternate"
            ? (editorConflict.alternateText ?? editorConflict.localText)
            : choice === "additional"
              ? (additional?.text ?? editorConflict.localText)
              : editorConflict.localText;
      const chosenAttachments =
        choice === "authoritative"
          ? editorConflict.authoritativeAttachments
          : choice === "alternate"
            ? (editorConflict.alternateAttachments ?? editorConflict.localAttachments)
            : choice === "additional"
              ? (additional?.attachments ?? editorConflict.localAttachments)
              : editorConflict.localAttachments;
      const parsedAttachments = parseReplicatedAttachments(chosenAttachments);
      const replicated = serializeComposerAttachments(
        parsedAttachments.images,
        parsedAttachments.files,
      );
      replicatedAttachmentsRef.current = replicated;
      setText(value);
      setAttachments(parsedAttachments.images);
      setFileAttachments(parsedAttachments.files);
      synchronizeEditorText(value, replicated);
      useSessionsStore.getState().clearEditorConflict(sessionId);
    },
    [editorConflict, sessionId, synchronizeEditorText],
  );

  // Whether the active session is a brand-new (still-empty) one. For such
  // sessions the unsent composer text is mirrored into a per-workspace store
  // slot (`newSessionDrafts`) while the placeholder is active — the "+ New
  // session" button is shown as selected instead of a session row. Switching
  // to another session reaps that empty placeholder but preserves the draft
  // (and WorktreeBar setup) for the next "+ New session" in the workspace. For
  // normal sessions we keep the text in local state as before.
  const workspacePath = session?.workspacePath;
  const pending = useMemo(() => isNewSessionPending(session), [session]);
  // Track which workspace's draft is currently mirrored into `text`, so a
  // switch to a different pending session re-seeds from that workspace's
  // draft rather than showing the previous session's leftover text.
  const seededWorkspaceRef = useRef<string | null>(null);
  // Ref mirrors of `pending`/`workspacePath` so the editorInjection effect
  // can read the current values without re-running on the pending→real
  // transition (which would spuriously re-inject stale text).
  const pendingRef = useRef(pending);
  const workspacePathRef = useRef(workspacePath);
  pendingRef.current = pending;
  workspacePathRef.current = workspacePath;

  // Seed / re-seed local text from the store draft when the pending session
  // or its workspace changes. For pending sessions this covers remounts while
  // the placeholder remains active and the fresh placeholder created after a
  // switch-away reap (session setup is restored when that placeholder session
  // is created). Non-pending sessions restore their own per-session draft the
  // same way, so typed text survives switching to another session and back.
  // We read the draft via getState() (not a reactive subscription) so
  // per-keystroke draft writes don't trigger an extra render here — the setText
  // in handleChange already does.
  useEffect(() => {
    if (pending && workspacePath) {
      if (seededWorkspaceRef.current !== workspacePath) {
        seededWorkspaceRef.current = workspacePath;
        const draft = useSessionsStore.getState().newSessionDrafts.get(workspacePath);
        setText(draft ?? "");
        setSlashIndex(0);
      }
    } else {
      seededWorkspaceRef.current = null;
      const draft = useSessionsStore.getState().sessionDrafts.get(sessionId) ?? "";
      setText(draft);
    }
  }, [pending, workspacePath, sessionId]);
  const editorInjectionText = session?.editorInjection?.text;
  const editorInjectionAttachments = session?.editorInjection?.attachments;

  const addUserMessage = useSessionsStore((s) => s.addUserMessage);
  const addToast = useSessionsStore((s) => s.addToast);
  const addCustomMessage = useSessionsStore((s) => s.addCustomMessage);
  const openPicker = useSessionsStore((s) => s.openPicker);
  const openImages = useImageViewerStore((s) => s.openImages);
  // Shared with the unified-TUI submit path (handleUnifiedSubmitRequest) so a
  // /fork|/clone|/switch_session|/resume hydrates the transcript + sidebar the
  // same way regardless of which surface dispatched it.
  const closeSessionTab = useSessionsStore((s) => s.closeSessionTab);
  const setNewSessionDraft = useSessionsStore((s) => s.setNewSessionDraft);
  const setSessionDraft = useSessionsStore((s) => s.setSessionDraft);
  const clearEditorInjection = useSessionsStore((s) => s.clearEditorInjection);
  const diffCommentCount = useSessionsStore((s) => s.diffComments.get(sessionId)?.size ?? 0);
  const clearDiffComments = useSessionsStore((s) => s.clearDiffComments);
  const clearSubmittedDiffComments = useSessionsStore((s) => s.clearSubmittedDiffComments);

  const worktreeCreating = session?.worktreeCreating ?? false;
  // The composer is interactive only when the session is live AND we're not
  // mid worktree-creation (the submit is already in flight — the input is
  // frozen so it reads as "sending", not "still unsubmitted text").
  const live = session?.status === "ready" && !!semanticSnapshot && !worktreeCreating;

  // Image-attach capability. Pi only forwards image content to models whose
  // registry record lists "image" as an input modality; for a text-only
  // model the image is silently dropped before the provider call. The +
  // affordance still opens for every model because non-image files mirror
  // pi's TUI path-insertion behavior, and images can fall back to paths.
  // Unknown capability (model not yet in availableModels) defaults to
  // allowed so we never downgrade a vision model on a data race.
  const currentModelInfo = useMemo<ModelInfo | undefined>(
    () =>
      findCurrentModel(
        session?.availableModels ?? [],
        semanticSnapshot?.model?.id,
        semanticSnapshot?.model?.provider,
      ),
    [session?.availableModels, semanticSnapshot?.model?.id, semanticSnapshot?.model?.provider],
  );
  const modelSupportsImages = currentModelInfo?.input
    ? currentModelInfo.input.includes("image")
    : true;
  const modelLabel = currentModelInfo?.name ?? semanticSnapshot?.model?.id ?? "This model";

  // Editor injection is keyed by its monotonic nonce so a catalog refresh or
  // other render cannot apply the same host value twice.
  useEffect(() => {
    if (editorInjectionNonce === undefined || editorInjectionText === undefined) return;
    const injectionKey = `${sessionId}:${editorInjectionNonce}`;
    if (processedEditorInjectionRef.current === injectionKey) return;
    processedEditorInjectionRef.current = injectionKey;

    // An initial owner baseline can contain an empty editor injection while a
    // renderer draft is being restored. Keep that renderer-owned draft and
    // rebase it to the attached editor exactly once; this is synchronization,
    // never a submit.
    const rendererDraft =
      pendingRef.current && workspacePathRef.current
        ? useSessionsStore.getState().newSessionDrafts.get(workspacePathRef.current)
        : useSessionsStore.getState().sessionDrafts.get(sessionId);
    if (editorInjectionMayPreserveDraft && editorInjectionText === "" && rendererDraft) {
      textRef.current = rendererDraft;
      setText(rendererDraft);
      setSlashIndex(0);
      synchronizeEditorText(rendererDraft, replicatedAttachmentsRef.current);
      const textarea = textareaRef.current;
      if (textarea && mayFocusComposer(textarea)) textarea.focus();
      return;
    }

    const injectedAction = parseComposerInput(editorInjectionText, { discovered });
    // An extension command may arrive before the refreshed catalog entry.
    // Treat any single-component slash token as command text: Pi does not
    // restrict extension command names to identifier syntax. Normal absolute
    // paths such as /tmp/file.txt contain another separator and retain the
    // existing file-tile restoration behavior.
    const slashCommandShaped = /^\/[^/\n\s]+(?:\s.*)?$/.test(editorInjectionText);
    const injectedTextIsCommand =
      slashCommandShaped ||
      injectedAction.kind !== "send-prompt" ||
      injectedAction.commandSource !== undefined;
    const injectedFiles = injectedTextIsCommand
      ? undefined
      : fileAttachmentsFromEditorText(editorInjectionText);
    const nextText = injectedFiles ? "" : editorInjectionText;
    textRef.current = nextText;
    setText(nextText);
    // Mirror the injected text into the per-workspace draft when the session
    // is still pending. Read `pending` from a ref so this effect only fires
    // on nonce/text changes — not on the pending→real transition after the
    // first send (which would spuriously re-inject stale text).
    if (pendingRef.current && workspacePathRef.current) {
      setNewSessionDraft(workspacePathRef.current, nextText);
    } else {
      setSessionDraft(sessionId, nextText);
    }
    setSlashIndex(0);
    const restored = parseReplicatedAttachments(
      editorInjectionAttachments ??
        useSessionsStore.getState().sessions.get(sessionId)?.editorAttachments ??
        [],
    );
    setAttachments(restored.images);
    setFileAttachments(injectedFiles ?? restored.files);
    const textarea = textareaRef.current;
    if (textarea && mayFocusComposer(textarea)) textarea.focus();
  }, [
    editorInjectionNonce,
    editorInjectionText,
    editorInjectionMayPreserveDraft,
    editorInjectionAttachments,
    discovered,
    sessionId,
    synchronizeEditorText,
    setNewSessionDraft,
    setSessionDraft,
  ]);

  // Focus the composer so the user can type right away on app open, session
  // switch, and new-session — all of which mount a fresh Composer (the
  // session subtree is keyed on the active session id).
  //
  // The catch: the textarea is `disabled` until the session is `live`
  // (starting/ready), and `.focus()` is a no-op on a disabled element. A
  // just-opened session mounts as "cold", so focusing on mount alone silently
  // fails for every freshly opened/created session and only happened to work
  // when switching to an already-ready one. So we wait for the enabled
  // (`live`) transition instead of focusing once on mount.
  //
  // `didAutofocusRef` makes this fire at most once per mount, so we never yank
  // focus back to the composer mid-session; the "typing elsewhere" guard
  // avoids stealing focus from another field the user already moved to.
  const didAutofocusRef = useRef(false);
  useEffect(() => {
    if (didAutofocusRef.current || !live) return;
    // Live is a one-shot autofocus opportunity. Consume it before inspecting
    // overlays or focus so closing an overlay later can never steal focus.
    didAutofocusRef.current = true;
    if (escapeClaimCount > 0) return;
    const el = textareaRef.current;
    if (!el || !mayFocusComposer(el)) return;
    el.focus();
  }, [live, escapeClaimCount]);

  // Explicit entry focus is deliberately separate from ordinary selection.
  // Consume the matching request at its first live native-Composer chance,
  // even when an overlay or a typing control means focus must be declined.
  useEffect(() => {
    const request = composerFocusRequest;
    if (!request || request.sessionId !== sessionId || !live) return;
    consumeComposerFocus(sessionId, request.nonce);
    if (escapeClaimCount > 0) return;
    const el = textareaRef.current;
    if (el && mayExplicitlyFocusComposer(el)) el.focus();
  }, [composerFocusRequest, consumeComposerFocus, escapeClaimCount, live, sessionId]);

  // Accepted custody/consumption feedback is presentation-only, but it lets
  // the originating ordinary prompt disappear before its terminal frame. Do
  // not patch the host editor here: its revision/custody remains authoritative.
  useEffect(() => {
    const pending = pendingOrdinaryPromptRef.current;
    if (!pending) return;
    const receipt = submissionDispositions.get(submissionDispositionKey(pending.intentId, pending.owner));
    if (
      !receipt ||
      !["in_custody", "consumed"].includes(receipt.disposition) ||
      receipt.editorRevision !== pending.editorRevision ||
      !mountedRef.current ||
      renderedSessionIdRef.current !== sessionId ||
      textRef.current !== pending.text ||
      JSON.stringify(replicatedAttachmentsRef.current) !== pending.attachmentsKey ||
      localEditGenerationRef.current !== pending.localEditGeneration
    ) {
      return;
    }
    pendingOrdinaryPromptRef.current = undefined;
    textRef.current = "";
    setText("");
    setAttachments([]);
    setFileAttachments([]);
    replicatedAttachmentsRef.current = [];
    setSlashIndex(0);
    const current = useSessionsStore.getState().sessions.get(sessionId);
    if (current?.isNewPending && workspacePathRef.current) {
      useSessionsStore.getState().clearNewSessionDraft(workspacePathRef.current);
    } else {
      useSessionsStore.getState().setSessionDraft(sessionId, "");
    }
    if (current?.editorInjection?.nonce === pending.editorInjectionNonce) {
      useSessionsStore.getState().clearEditorInjection(sessionId);
    }
  }, [sessionId, submissionDispositions]);

  // ── Attachment handling ─────────────────────────────────────────────

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFilesSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const selected = Array.from(files).map((file) => ({
        file,
        path: pathForPickedFile(file),
        image: isImageFile(file),
      }));
      const imageCount = selected.filter((entry) => entry.image).length;
      const genericFiles = selected
        .filter((entry) => !entry.image || !modelSupportsImages)
        .map((entry) => ({ name: entry.file.name, path: entry.path }));

      if (!modelSupportsImages && imageCount > 0) {
        addToast(
          sessionId,
          `${modelLabel} doesn't support image input — attaching image${imageCount === 1 ? "" : "s"} as file path${imageCount === 1 ? "" : "s"}`,
          "warning",
        );
      }

      if (genericFiles.length > 0) {
        const next = [
          ...replicatedAttachmentsRef.current,
          ...genericFiles.map((item) => ({ kind: "file" as const, ...item })),
        ];
        replicatedAttachmentsRef.current = next;
        setFileAttachments(parseReplicatedAttachments(next).files);
        synchronizeEditorText(text, next);
        textareaRef.current?.focus();
      }

      const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
      const MAX_ATTACHMENTS = 8;
      let slots = MAX_ATTACHMENTS - attachments.length;
      for (const { file, path, image } of selected) {
        if (!image || !modelSupportsImages) continue;
        if (slots <= 0) {
          addToast(sessionId, "Too many image attachments (max 8)", "error");
          break;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          addToast(sessionId, `${file.name} is too large (max 10 MB)`, "error");
          continue;
        }
        slots--;
        const reader = new FileReader();
        const readSessionId = sessionId;
        const readEditorEpoch = editorPatchEpochRef.current;
        useSessionsStore.getState().beginEditorAttachmentRead(readSessionId);
        let readFinished = false;
        const finishRead = (): void => {
          if (readFinished) return;
          readFinished = true;
          useSessionsStore.getState().endEditorAttachmentRead(readSessionId);
        };
        reader.onload = () => {
          try {
            if (
              renderedSessionIdRef.current !== readSessionId ||
              editorPatchEpochRef.current !== readEditorEpoch
            ) {
              useSessionsStore
                .getState()
                .addToast(
                  readSessionId,
                  `Discarded ${file.name} after the session changed`,
                  "warning",
                );
              return;
            }
            const dataUrl = reader.result as string;
            const next = [
              ...replicatedAttachmentsRef.current,
              { kind: "image" as const, name: file.name, path, dataUrl },
            ];
            replicatedAttachmentsRef.current = next;
            setAttachments(parseReplicatedAttachments(next).images);
            synchronizeEditorText(textRef.current, next);
          } finally {
            finishRead();
          }
        };
        reader.onerror = () => {
          addToast(sessionId, `Could not read ${file.name}`, "error");
          finishRead();
        };
        reader.onabort = finishRead;
        try {
          reader.readAsDataURL(file);
        } catch (error) {
          finishRead();
          addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
        }
      }
      e.target.value = "";
    },
    [
      addToast,
      attachments,
      sessionId,
      modelSupportsImages,
      modelLabel,
      synchronizeEditorText,
      text,
    ],
  );

  const removeAttachment = useCallback(
    (index: number) => {
      let imageIndex = -1;
      const next = replicatedAttachmentsRef.current.filter((item) => {
        if (item.kind !== "image") return true;
        imageIndex++;
        return imageIndex !== index;
      });
      replicatedAttachmentsRef.current = next;
      setAttachments(parseReplicatedAttachments(next).images);
      synchronizeEditorText(text, next);
    },
    [synchronizeEditorText, text],
  );

  const removeFileAttachment = useCallback(
    (index: number) => {
      let fileIndex = -1;
      const next = replicatedAttachmentsRef.current.filter((item) => {
        if (item.kind !== "file") return true;
        fileIndex++;
        return fileIndex !== index;
      });
      replicatedAttachmentsRef.current = next;
      setFileAttachments(parseReplicatedAttachments(next).files);
      synchronizeEditorText(text, next);
    },
    [synchronizeEditorText, text],
  );

  const viewAttachment = useCallback(
    (index: number) => {
      openImages(
        attachments.map((att) => ({ src: att.dataUrl, alt: att.name })),
        index,
      );
    },
    [attachments, openImages],
  );

  // ── Suggestion list ────────────────────────────────────────────────

  const suggestions = useMemo<SuggestionEntry[]>(() => {
    if (!text.startsWith("/")) return [];
    const prefix = text.slice(1).toLowerCase();
    const hasSpace = text.includes(" ");
    if (hasSpace) return []; // suggestions only for the bare command token

    // pi's TUI (createBaseAutocompleteProvider) lists ALL builtins first,
    // then prompt templates, then extension commands, then skill commands,
    // and truncates by autocompleteMaxVisible (default 8) with the menu
    // scrolling. Mirror that: build the full ordered list (builtins →
    // discovered), then cap — don't cap builtins before discovered, or
    // the discovered commands never surface on a bare `/`.
    const entries: SuggestionEntry[] = [];
    // Built-ins first. pi's TUI lists EVERY built-in slash command in
    // autocomplete (it has no "unsupported" category); we match that.
    for (const b of BUILTIN_COMMANDS) {
      if (!b.name.toLowerCase().startsWith(prefix)) continue;
      entries.push({
        name: b.name,
        badge: "built-in",
        description: b.description,
        argHint: b.argHint || undefined,
        key: `builtin:${b.name}`,
      });
    }
    // Discovered (prompt / extension / skill, in pi's order). pi's TUI
    // includes all of these in autocomplete too (promptTemplates +
    // getRegisteredCommands + skills), skipping only names that collide
    // with built-ins (built-in wins for discoverability; the parser still
    // routes the discovered one at execute time since it carries the
    // actual extension data).
    for (const c of commands) {
      if (!c.name.toLowerCase().startsWith(prefix)) continue;
      // If the same name appears as both a built-in and discovered, the
      // built-in is the user-facing entry. The parser's shadowing rule
      // makes the discovered one take effect at execute time (it carries
      // the actual extension data), but the visible command is the built-in.
      // Skip the discovered duplicate.
      if (BUILTIN_COMMANDS.some((b) => b.name === c.name)) continue;
      const badge = c.source === "skill" ? "skill" : c.source === "prompt" ? "prompt" : "extension";
      const scope =
        (c as { sourceInfo?: { scope?: string }; location?: string }).sourceInfo?.scope ??
        (c as { location?: string }).location;
      entries.push({
        name: c.name,
        badge,
        description: c.description,
        scope: scope || undefined,
        key: `disc:${c.source ?? "x"}:${c.name}`,
      });
    }
    // pi's TUI doesn't hard-truncate the command list — it builds all
    // matches and lets the menu scroll (autocompleteMaxVisible is a
    // visible-rows hint, not a list cap). The suggestion-list already
    // scrolls (max-height + overflow-y: auto), so return the full list.
    return entries;
  }, [text, commands]);

  const showSuggestions = suggestions.length > 0 && !dismissed; // A1

  // Claim ESC while autocomplete is visible (A2): the global interrupt handler
  // defers while a claim is active, so the first ESC hides suggestions instead
  // of aborting the agent (two-press model). This holds REGARDLESS of streaming
  // — an open autocomplete always consumes the first ESC; only once it is closed
  // does ESC abort. (See docs/ui-conventions.md, "ESC-to-interrupt".)
  useEscapeClaim(showSuggestions);

  // Reset highlight when the suggestion list shape changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on shape, not identity; recompute on each keystroke is intentional
  useEffect(() => {
    setSlashIndex(0);
  }, [suggestions.length, text]);

  // Keep the keyboard-selected suggestion scrolled into view during
  // arrow-key navigation. Rather than scrollIntoView({block:"nearest"}) —
  // which, when the list's height isn't an exact multiple of a row's
  // height, leaves a fractional row at one viewport edge and then swaps
  // it to the opposite edge when you cross the boundary (items visibly
  // shift) — we scroll manually and snap the viewport's *top* edge to an
  // item boundary. That way a partial row can only ever sit at the bottom
  // edge, so the row grid never reflows as you arrow up/down. Scrolls the
  // list's own viewport, never the pane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional re-trigger flags; the body reads the rendered selection from the DOM, not the values directly
  useEffect(() => {
    const list = suggestionListRef.current;
    if (!list) return;
    const sel = list.querySelector<HTMLElement>(".composer__suggestion--selected");
    if (!sel) return;
    const listRect = list.getBoundingClientRect();
    const selRect = sel.getBoundingClientRect();
    const EPS = 1; // tolerate sub-pixel rounding
    if (selRect.top < listRect.top - EPS) {
      // Selected is above the viewport — align its top to the viewport's
      // top. sel's top is itself an item boundary, so the top edge stays
      // flush with a row (no partial row introduced).
      list.scrollTop += selRect.top - listRect.top;
    } else if (selRect.bottom > listRect.bottom + EPS) {
      // Selected is below the viewport. First compute the minimal scroll
      // that brings its bottom flush with the viewport's bottom, then snap
      // that scroll position *down* to the nearest following item-top
      // boundary so the viewport's top edge lands flush with a row instead
      // of mid-item. The extra nudge is < one row, so sel stays visible.
      const minScroll = list.scrollTop + (selRect.bottom - listRect.bottom);
      const items = list.querySelectorAll<HTMLElement>(".composer__suggestion");
      let target = minScroll;
      for (const it of items) {
        const r = it.getBoundingClientRect();
        const itTopInScroll = list.scrollTop + (r.top - listRect.top);
        if (itTopInScroll >= minScroll - EPS) {
          target = itTopInScroll;
          break;
        }
      }
      list.scrollTop = target;
    }
  }, [slashIndex, suggestions]);

  // ── Submit ─────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (overrideContent?: string) => {
      const content = overrideContent ?? text;
      if (overrideContent !== undefined) textRef.current = overrideContent;
      const store = useSessionsStore.getState();
      if (!hasAuthoritativeSemanticState(store.sessions.get(sessionId))) {
        store.addToast(sessionId, "Session semantic state is synchronizing", "warning");
        return;
      }
      if ((store.sessions.get(sessionId)?.editorAttachmentReads ?? 0) > 0) {
        store.addToast(sessionId, "Wait for image attachments to finish loading", "warning");
        return;
      }
      const pendingDiffComments = store.getDiffCommentsForPrompt(sessionId);
      if (
        !content.trim() &&
        attachments.length === 0 &&
        fileAttachments.length === 0 &&
        pendingDiffComments.length === 0
      )
        return;
      const parsedAction = parseComposerInput(content, { discovered });
      const isSlashCommand = content.startsWith("/");
      const isRealPrompt = parsedAction.kind === "send-prompt" && !isSlashCommand;
      // Comments and attachments are staged prompt context. Slash commands may
      // use the prompt transport for extension/template dispatch, but they must
      // receive only their command text and leave that context for a later
      // ordinary prompt.
      let effectiveImages = isRealPrompt ? attachments : [];
      const attachedFilePaths = fileAttachments.map((attachment) => attachment.path);
      let effectivePromptText = parsedAction.kind === "send-prompt" ? parsedAction.text : content;
      if (parsedAction.kind !== "send-prompt" && !isSlashCommand && attachedFilePaths.length > 0) {
        addToast(sessionId, "File attachments can only be sent with prompts", "error");
        return;
      }
      if (isRealPrompt && attachedFilePaths.length > 0) {
        effectivePromptText = textWithPrependedFilePaths(parsedAction.text, attachedFilePaths);
      }
      if (isRealPrompt && pendingDiffComments.length > 0) {
        effectivePromptText = prependCodeCommentsToPrompt(effectivePromptText, pendingDiffComments);
      }
      if (isRealPrompt && effectiveImages.length > 0 && !modelSupportsImages) {
        addToast(
          sessionId,
          `${modelLabel} doesn't support image input — sending image file paths instead`,
          "warning",
        );
        effectivePromptText = textWithAppendedFilePaths(
          effectivePromptText,
          effectiveImages.map((attachment) => attachment.path),
        );
        effectiveImages = [];
      }
      const finalAction =
        parsedAction.kind === "send-prompt"
          ? {
              ...parsedAction,
              text: effectivePromptText,
              ...(effectiveImages.length > 0
                ? {
                    images: runtimeImagesFromAttachments(effectiveImages),
                  }
                : {}),
            }
          : parsedAction;
      // Drop only an exact duplicate effective payload. Same text with
      // different files/images remains a distinct intent and reaches host
      // custody with its own explicit disposition.
      const submissionInFlightKey = JSON.stringify(finalAction);
      if (submissionsInFlightRef.current.has(submissionInFlightKey)) return;
      submissionsInFlightRef.current.add(submissionInFlightKey);

      // ── Worktree creation / attachment on first send ──
      // Only run when this session has not already been placed in a
      // worktree (worktreePath unset). After `/new` etc. the transcript
      // resets to empty, so guarding on the transcript alone would
      // re-create a worktree for a session that already has one.
      //
      // `worktreeMode` is the segmented-control selection in the
      // WorktreeBar:
      //   - "none"   → no pre-send action (run in the workspace).
      //   - "create" → cut a fresh worktree (the original checkbox flow).
      //   - "attach" → re-point this session into an existing worktree
      //                on disk. The IPC is the authoritative validation
      //                gate — no client-side path check; an invalid path
      //                just comes back `{ok:false}` and the inline error
      //                shows up in the bar.
      const isNewSession = !sessionHasHistory(session);
      // Truthy-check on `session?.worktreeMode` narrows `session` to
      // defined inside this block (TS flow analysis), so the `session.*`
      // accesses below don't need optional chaining.
      const worktreeMode = session?.worktreeMode;
      if (
        session &&
        isNewSession &&
        !session.worktreePath &&
        (worktreeMode === "create" || worktreeMode === "attach")
      ) {
        const operation = await runWorktreeOperation({
          sessionId,
          mode: worktreeMode,
          // HEAD is the safe detached/no-branch fallback; never assume main.
          ...(worktreeMode === "create"
            ? { base: session.worktreeBase ?? "HEAD" }
            : { path: session.worktreeAttachPath }),
        });
        if (!operation.ok) {
          // Keep the submission text and release this intent for a retry.
          submissionsInFlightRef.current.delete(submissionInFlightKey);
          return;
        }
      }

      try {
        // No-model guard: only for plain user prompts. /model (which fixes
        // the guard!) and bash bypass it. Must run inside `try` so the
        // `finally` below still resets `submittingRef`.
        if (
          finalAction.kind === "send-prompt" &&
          !semanticSnapshot?.model &&
          finalAction.commandSource === undefined
        ) {
          addToast(sessionId, "No model selected", "error");
          return;
        }

        // Serialize command dispatch behind the editor patch that produced its
        // text. Otherwise a fast built-in response can race the host's own
        // `/command` editor acknowledgement, mistake that acknowledgement for
        // a later extension injection, and leave the Composer uncleared.
        let dispatchIdentity = useSessionsStore.getState().sessions.get(sessionId);
        if (editorPatchRetryNeededRef.current) {
          editorPatchRetryNeededRef.current = false;
          try {
            const attached = await window.pivis.invoke("session.authorityAttach", {
              sessionId,
              rendererGeneration: RENDERER_GENERATION,
            });
            if (attached.status !== "ready") {
              editorPatchRetryNeededRef.current = true;
              return;
            }
            useSessionsStore.getState().applyAuthorityAttach(sessionId, attached);
            dispatchIdentity = useSessionsStore.getState().sessions.get(sessionId);
          } catch {
            editorPatchRetryNeededRef.current = true;
            addToast(
              sessionId,
              "Editor state is synchronizing; retry when it is current",
              "warning",
            );
            return;
          }
          const snapshot = authoritySnapshotFor(dispatchIdentity);
          if (!snapshot) {
            editorPatchRetryNeededRef.current = true;
            addToast(
              sessionId,
              "Editor state is synchronizing; retry when it is current",
              "warning",
            );
            return;
          }
          editorRevisionRef.current = snapshot.editor.revision;
          synchronizeEditorText(textRef.current, replicatedAttachmentsRef.current);
          dispatchIdentity = useSessionsStore.getState().sessions.get(sessionId);
        }
        const patchOutcome = await editorPatchTailRef.current;
        const currentDispatchIdentity = useSessionsStore.getState().sessions.get(sessionId);
        if (patchOutcome !== "accepted") return;
        const dispatchSnapshot = authoritySnapshotFor(dispatchIdentity);
        const currentDispatchSnapshot = authoritySnapshotFor(currentDispatchIdentity);
        if (
          !dispatchSnapshot ||
          dispatchSnapshot.owner.hostInstanceId !== currentDispatchSnapshot?.owner.hostInstanceId ||
          dispatchSnapshot.owner.sessionEpoch !== currentDispatchSnapshot?.owner.sessionEpoch
        ) {
          addToast(sessionId, "Session changed before input could be dispatched", "warning");
          return;
        }
        // Keep editor custody until the host returns a matching explicit
        // disposition. New typing during the round trip advances this revision
        // and is therefore never cleared by the older submit.
        const submittedEditorRevision = editorRevisionRef.current;
        const submittedEditorInjectionNonce = session?.editorInjection?.nonce;
        const submittedLocalText = content;
        const submittedAttachmentsKey = JSON.stringify(replicatedAttachmentsRef.current);
        const submittedLocalEditGeneration = localEditGenerationRef.current;

        const intentObservation = (sid: SessionId) => {
          const runtime = useSessionsStore.getState().sessions.get(sid);
          const snapshot = authoritySnapshotFor(runtime);
          const semantic = runtime?.authorityProjection?.semantic;
          if (!runtime || !snapshot || semantic?.state !== "following") return undefined;
          return {
            owner: snapshot.owner,
            cursor: semantic.cursor,
            editorRevision: editorRevisionRef.current,
            userMessageSequence: runtime.transcript.userMessageSequence,
          };
        };
        const awaitIntentOutcome = (
          sid: SessionId,
          intentId: string,
          owner: RuntimeIdentity,
        ): Promise<IntentOutcome> => {
          const findOutcome = (): IntentOutcome | undefined => {
            const projection = useSessionsStore.getState().sessions.get(sid)?.authorityProjection;
            return projection?.authoritativeSnapshot?.recentIntentOutcomes.find(
              (outcome) =>
                outcome.intentId === intentId &&
                outcome.owner.hostInstanceId === owner.hostInstanceId &&
                outcome.owner.sessionEpoch === owner.sessionEpoch,
            );
          };
          const immediate = findOutcome();
          if (immediate) return Promise.resolve(immediate);
          return new Promise((resolve, reject) => {
            const unsubscribe = useSessionsStore.subscribe(() => {
              const outcome = findOutcome();
              if (outcome) {
                unsubscribe();
                resolve(outcome);
                return;
              }
              const runtime = useSessionsStore.getState().sessions.get(sid);
              if (
                !runtime?.hostInstanceId ||
                runtime.hostInstanceId !== owner.hostInstanceId ||
                runtime.sessionEpoch !== owner.sessionEpoch
              ) {
                unsubscribe();
                reject(new InputNotConsumedError("Session changed before intent outcome"));
              }
            });
          });
        };
        // Admission proves the child owns the command, so its stale text can
        // clear immediately (notably long-running /compact). A later failed
        // outcome is a domain error the user already sees in the transcript
        // and toasts; the command text is deliberately not re-injected.
        const clearOnAdmission = (intent: SessionIntent) => {
          if (
            !["compact", "export", "reload", "rename", "setModel", "runBash", "navigate"].includes(
              intent.kind,
            ) ||
            !mountedRef.current ||
            renderedSessionIdRef.current !== sessionId ||
            textRef.current !== submittedLocalText ||
            localEditGenerationRef.current !== submittedLocalEditGeneration
          ) {
            return;
          }
          synchronizeEditorText("", replicatedAttachmentsRef.current);
          textRef.current = "";
          setText("");
          setSlashIndex(0);
          useSessionsStore.getState().setSessionDraft(sessionId, "");
        };
        const deps = {
          // Register before dispatch: main can forward a correlated admission
          // disposition before executeAction receives its receipt or terminal
          // authority outcome.
          createIntentId: isRealPrompt
            ? () => {
                const intentId = crypto.randomUUID();
                pendingOrdinaryPromptRef.current = {
                  intentId,
                  owner: dispatchSnapshot.owner,
                  editorRevision: submittedEditorRevision,
                  text: submittedLocalText,
                  attachmentsKey: submittedAttachmentsKey,
                  localEditGeneration: submittedLocalEditGeneration,
                  ...(submittedEditorInjectionNonce !== undefined
                    ? { editorInjectionNonce: submittedEditorInjectionNonce }
                    : {}),
                };
                return intentId;
              }
            : undefined,
          dispatch: (sid: SessionId, intent: SessionIntent, intentId?: string) => {
            const observation = intentObservation(sid);
            if (!observation)
              return Promise.reject(new InputNotConsumedError("Runtime snapshot is unavailable"));
            return dispatchSessionIntent(
              sid,
              intent,
              {
                owner: observation.owner,
                ...(observation.cursor ? { cursor: observation.cursor } : {}),
              },
              intentId,
            );
          },
          query: (sid: SessionId, query: SessionQuery) => {
            const observation = intentObservation(sid);
            if (!observation)
              return Promise.reject(new InputNotConsumedError("Runtime snapshot is unavailable"));
            return querySession(sid, query, {
              owner: observation.owner,
              ...(observation.cursor ? { cursor: observation.cursor } : {}),
            });
          },
          awaitIntentOutcome,
          getIntentObservation: intentObservation,
          onAdmitted: (_sid: SessionId, intent: SessionIntent) => clearOnAdmission(intent),
          uiSurface: "composer" as const,
          invoke: async <T = unknown>(channel: string, payload: unknown) =>
            window.pivis.invoke(
              channel as Parameters<typeof window.pivis.invoke>[0],
              payload as Parameters<typeof window.pivis.invoke>[1],
            ) as Promise<T>,
          addToast,
          addUserMessage: (
            sid: SessionId,
            message: string,
            images?: string[],
            opts?: { registerEcho?: boolean; afterUserMessageSequence?: number; intentId?: string },
          ) => addUserMessage(sid, message, images, { ...opts, clearDraft: false }),
          addCustomMessage,
          openChangelog: (markdown: string) => useChangelogStore.getState().openChangelog(markdown),
          openPicker: (sid: SessionId, picker: PickerRequest) =>
            openPicker(sid, {
              ...picker,
              expectedHostInstanceId: dispatchSnapshot.owner.hostInstanceId,
              expectedSessionEpoch: dispatchSnapshot.owner.sessionEpoch,
            }),
          closeSessionTab: async (sid: SessionId) => closeSessionTab(sid),
          openAppSettings: () => window.dispatchEvent(new CustomEvent("pivis:open-settings")),
          openDiffViewer: (sid: SessionId) => openDiffForSession(sid),
          openTreeViewer: (sid: SessionId) => {
            void useTreeStore.getState().openTreeForSession(sid);
          },
          openLogin: () => window.dispatchEvent(new CustomEvent("pivis:open-login")),
          copyToClipboard: async (t: string) => {
            await window.pivis.invoke("clipboard.writeText", { text: t });
          },
          getAvailableModels: (sid: SessionId): ModelInfo[] =>
            useSessionsStore.getState().sessions.get(sid)?.availableModels ?? [],
          getSessionWorkspacePath: (sid: SessionId) =>
            useSessionsStore.getState().sessions.get(sid)?.workspacePath,
          listSessions: (workspacePath: string) =>
            window.pivis.invoke("workspace.listSessions", { workspacePath }),
        };

        const completion = await executeAction(sessionId, finalAction, deps);
        const currentSession = useSessionsStore.getState().sessions.get(sessionId);
        const originatingComposerStillMounted =
          mountedRef.current && renderedSessionIdRef.current === sessionId;
        const currentAttachmentsKey = JSON.stringify(replicatedAttachmentsRef.current);
        const localPayloadUnchanged =
          localEditGenerationRef.current === submittedLocalEditGeneration &&
          textRef.current === submittedLocalText &&
          currentAttachmentsKey === submittedAttachmentsKey;
        // Receipt admission never reaches this branch: executeAction returns
        // only after the semantic authority projection published a terminal
        // outcome. Unknown/cancelled/rejected work remains in editor custody.
        const terminalOutcome =
          completion?.outcome.state === "completed" || completion?.outcome.state === "failed";
        const acceptedPromptOutcome =
          finalAction.kind === "send-prompt" &&
          terminalOutcome &&
          ((completion?.outcome.kind === "submit" &&
            ["in_custody", "consumed", "completed", "extension_error"].includes(
              completion.outcome.result?.disposition ?? "",
            )) ||
            completion?.outcome.kind === "invokeCommand");
        const acceptedPromptCanClear =
          acceptedPromptOutcome && originatingComposerStillMounted && localPayloadUnchanged;
        // Local UI commands (for example /tree) settle synchronously and have
        // no intent completion, so clear their stale command text once the UI
        // opens. `/name` without an argument is different: it is a read-only
        // query that deliberately leaves the completed `/name ` prefix ready
        // for the user to enter a value.
        const preservesReadOnlyNamePrefix =
          finalAction.kind === "name" && finalAction.name === undefined;
        const completedCommandCanClear =
          finalAction.kind !== "send-prompt" &&
          finalAction.kind !== "unsupported" &&
          !preservesReadOnlyNamePrefix &&
          (completion === undefined || terminalOutcome) &&
          originatingComposerStillMounted &&
          localPayloadUnchanged;
        if (acceptedPromptCanClear || completedCommandCanClear) {
          if (completedCommandCanClear || !isRealPrompt) {
            synchronizeEditorText("", replicatedAttachmentsRef.current);
          }
          textRef.current = "";
          setText("");
          if (isRealPrompt) {
            setAttachments([]);
            setFileAttachments([]);
            replicatedAttachmentsRef.current = [];
          }
          setSlashIndex(0);
          const stillPending = !!useSessionsStore.getState().sessions.get(sessionId)?.isNewPending;
          if (stillPending && workspacePathRef.current) {
            useSessionsStore.getState().clearNewSessionDraft(workspacePathRef.current);
          } else {
            useSessionsStore.getState().setSessionDraft(sessionId, "");
          }
          const injection = currentSession?.editorInjection;
          if (injection?.nonce === submittedEditorInjectionNonce) {
            useSessionsStore.getState().clearEditorInjection(sessionId);
          }
        }
        // Diff comments have their own stable revision fence. A concurrent
        // composer edit must preserve text/attachments, but must not keep the
        // exact comment revisions that authority already accepted.
        if (acceptedPromptOutcome && pendingDiffComments.length > 0) {
          clearSubmittedDiffComments(sessionId, pendingDiffComments);
        }
      } catch (err) {
        if (err instanceof InputNotConsumedError) return;
        throw err;
      } finally {
        submissionsInFlightRef.current.delete(submissionInFlightKey);
      }
    },
    [
      text,
      discovered,
      session,
      sessionId,
      addToast,
      addUserMessage,
      addCustomMessage,
      openPicker,
      closeSessionTab,
      attachments,
      fileAttachments,
      modelSupportsImages,
      modelLabel,
      semanticSnapshot?.model,
      clearSubmittedDiffComments,
      synchronizeEditorText,
    ],
  );

  // ── Suggestion completion ───────────────────────────────────────────
  // Mirrors pi's TUI editor (pi-tui components/editor.js): Tab applies the
  // highlighted completion and stays in the editor; Enter applies it *and*
  // falls through to submit (slash commands only — suggestions are only
  // shown for the bare command token, no args yet). Clicking a suggestion
  // behaves like Tab (fill, don't submit) so the user can review/append args.
  const completionFor = useCallback((entry: SuggestionEntry): string => {
    const isArg = BUILTIN_COMMANDS.find((b) => b.name === entry.name)?.takesArgs;
    return isArg ? `/${entry.name} ` : `/${entry.name}`;
  }, []);

  // ── Keyboard ───────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSuggestions) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => Math.min(i + 1, suggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const chosen = suggestions[slashIndex];
          if (chosen) {
            // Built-ins that take args get a trailing space to invite the
            // user to type the argument. Arg-less ones don't.
            const v = completionFor(chosen);
            textRef.current = v;
            setText(v);
            synchronizeEditorText(v);
            if (pending && workspacePath) setNewSessionDraft(workspacePath, v);
            else setSessionDraft(sessionId, v);
            if (
              useSessionsStore.getState().sessions.get(sessionId)?.editorInjection !== undefined
            ) {
              clearEditorInjection(sessionId);
            }
            setSlashIndex(0);
          }
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // IME composition-Enter: confirm-Enter inside a CJK/IME candidate
          // window fires `keydown` with `keyCode === 229` and
          // `isComposing === true`. Submitting on that key would steal the
          // composition end from the user.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          // TUI parity: apply the highlighted completion, then submit. For
          // arg-taking built-ins the completion is `/<name> ` which parses
          // to the no-arg form (e.g. opens the model picker); the user
          // uses Tab instead to keep typing args.
          const chosen = suggestions[slashIndex];
          if (chosen) {
            const completed = completionFor(chosen);
            textRef.current = completed;
            setText(completed);
            synchronizeEditorText(completed);
            if (pending && workspacePath) setNewSessionDraft(workspacePath, completed);
            else setSessionDraft(sessionId, completed);
            if (
              useSessionsStore.getState().sessions.get(sessionId)?.editorInjection !== undefined
            ) {
              clearEditorInjection(sessionId);
            }
            setSlashIndex(0);
            void handleSubmit(completed);
          } else {
            void handleSubmit();
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setDismissed(true); // A2: actually hide, not just reset highlight
          setSlashIndex(0);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        // IME composition-Enter: confirm-Enter inside a CJK/IME candidate
        // window fires `keydown` with `keyCode === 229` and
        // `isComposing === true`. Submitting on that key would steal the
        // composition end from the user.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        void handleSubmit();
      }
    },
    [
      showSuggestions,
      suggestions,
      slashIndex,
      handleSubmit,
      completionFor,
      pending,
      workspacePath,
      setNewSessionDraft,
      setSessionDraft,
      sessionId,
      clearEditorInjection,
      synchronizeEditorText,
    ],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      textRef.current = v;
      setText(v);
      synchronizeEditorText(v);
      setDismissed(false); // A3 reset on text change
      if (pending && workspacePath) setNewSessionDraft(workspacePath, v);
      else setSessionDraft(sessionId, v);
      // Consume any pending editor injection — the user has taken over the
      // textarea, so a stale injection must not re-fire on remount and
      // clobber the restored draft. No-op once cleared (subsequent
      // keystrokes skip the store read-and-write).
      if (useSessionsStore.getState().sessions.get(sessionId)?.editorInjection !== undefined) {
        clearEditorInjection(sessionId);
      }
    },
    [
      pending,
      workspacePath,
      setNewSessionDraft,
      setSessionDraft,
      sessionId,
      clearEditorInjection,
      synchronizeEditorText,
    ],
  );

  // ── Click to pick a suggestion ─────────────────────────────────────

  const handleSuggestionClick = useCallback(
    (entry: SuggestionEntry) => {
      const v = completionFor(entry);
      textRef.current = v;
      setText(v);
      synchronizeEditorText(v);
      setDismissed(false); // A3 reset on pick
      if (pending && workspacePath) setNewSessionDraft(workspacePath, v);
      else setSessionDraft(sessionId, v);
      // Consume any pending editor injection (same rationale as handleChange).
      if (useSessionsStore.getState().sessions.get(sessionId)?.editorInjection !== undefined) {
        clearEditorInjection(sessionId);
      }
      setSlashIndex(0);
      textareaRef.current?.focus();
    },
    [
      completionFor,
      pending,
      workspacePath,
      setNewSessionDraft,
      setSessionDraft,
      sessionId,
      clearEditorInjection,
      synchronizeEditorText,
    ],
  );

  const isBashMode = text.startsWith("!");
  const isSlashMode = text.startsWith("/");

  return (
    <div className="composer">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="composer__file-input"
        onChange={handleFilesSelected}
      />
      <div
        className={`composer__input-row ${isBashMode ? "composer__input-row--bash" : ""} ${isSlashMode ? "composer__input-row--slash" : ""}`}
      >
        {/* Slash suggestions — a detached floating popover anchored above
            the input box. Mirrors the app's picker card language
            (.picker / .picker__list in AppPickerHost.css): a padded card
            wrapping an inner scrolling list of rounded rows. See
            .composer__suggestions in Composer.css. */}
        {showSuggestions && (
          <div className="composer__suggestions">
            <div className="composer__suggestion-list" role="listbox" ref={suggestionListRef}>
              {suggestions.map((s, i) => (
                <button
                  type="button"
                  key={s.key}
                  className={`composer__suggestion fade-scope ${i === slashIndex ? "composer__suggestion--selected" : ""}`}
                  onClick={() => handleSuggestionClick(s)}
                  onMouseEnter={() => setSlashIndex(i)}
                  role="option"
                  aria-selected={i === slashIndex}
                >
                  <span className="composer__suggestion-name">/{s.name}</span>
                  <span className="composer__suggestion-arg">{s.argHint ?? ""}</span>
                  <FadeText className="composer__suggestion-desc">{s.description ?? ""}</FadeText>
                  <span
                    className={`composer__suggestion-badge composer__suggestion-badge--${s.badge}`}
                  >
                    <span className="composer__suggestion-dot" aria-hidden />
                    {s.badge}
                    {s.scope ? `:${s.scope}` : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="composer__input-box">
          {/* Image previews live inside the input card, above the typed text,
              so attachments read as part of the pending message rather than a
              separate horizontal tray. */}
          {(attachments.length > 0 || fileAttachments.length > 0 || diffCommentCount > 0) && (
            <div className="composer__attachments">
              {diffCommentCount > 0 && (
                <div className="composer__attachment-item composer__attachment-item--comments">
                  <div
                    className="composer__file-attachment composer__comment-attachment"
                    title={`${diffCommentCount} code ${diffCommentCount === 1 ? "comment" : "comments"} will be prepended to your next prompt`}
                  >
                    <span className="composer__comment-attachment-icon-wrap" aria-hidden>
                      <IconComment className="composer__file-attachment-icon" size="1.55em" />
                    </span>
                    <span className="composer__comment-attachment-count" aria-hidden>
                      {diffCommentCount}
                    </span>
                    <span className="composer__file-attachment-name">
                      {diffCommentCount === 1 ? "comment" : "comments"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="composer__attachment-remove"
                    onClick={() => clearDiffComments(sessionId)}
                    aria-label="Clear code comments"
                  >
                    <IconClose size="0.714em" />
                  </button>
                </div>
              )}
              {fileAttachments.map((att, i) => (
                <div
                  key={`${att.path}-${i}`}
                  className="composer__attachment-item composer__attachment-item--file"
                >
                  <div className="composer__file-attachment" title={att.path}>
                    <IconFile className="composer__file-attachment-icon" size="1.6em" />
                    <FadeText className="composer__file-attachment-name">{att.name}</FadeText>
                  </div>
                  <button
                    type="button"
                    className="composer__attachment-remove"
                    onClick={() => removeFileAttachment(i)}
                    aria-label={`Remove ${att.name}`}
                  >
                    <IconClose size="0.714em" />
                  </button>
                </div>
              ))}
              {attachments.map((att, i) => (
                <div key={`${att.name}-${i}`} className="composer__attachment-item">
                  <button
                    type="button"
                    className="composer__attachment-preview"
                    onClick={() => viewAttachment(i)}
                    aria-label={`Open ${att.name} larger`}
                    title="Open image preview"
                  >
                    <img src={att.dataUrl} alt={att.name} className="composer__attachment-thumb" />
                  </button>
                  <button
                    type="button"
                    className="composer__attachment-remove"
                    onClick={() => removeAttachment(i)}
                    aria-label={`Remove ${att.name}`}
                  >
                    <IconClose size="0.714em" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {editorConflict && (
            <div className="composer__editor-conflict" role="status">
              <span>An extension and your local edit changed the composer.</span>
              <button type="button" onClick={() => resolveEditorConflict("local")}>
                Keep my edit
              </button>
              {editorConflict.alternateText !== undefined && (
                <button type="button" onClick={() => resolveEditorConflict("alternate")}>
                  Use retained alternate
                </button>
              )}
              {editorConflict.additionalCandidates?.map((candidate, index) => (
                <button
                  type="button"
                  key={`${candidate.text}:${index}`}
                  onClick={() => resolveEditorConflict("additional", index)}
                >
                  Use retained candidate {index + 2}
                </button>
              ))}
              <button type="button" onClick={() => resolveEditorConflict("authoritative")}>
                Use extension edit
              </button>
            </div>
          )}
          <div className="composer__entry-row">
            <button
              type="button"
              className="composer__attach-btn"
              onClick={handleAttachClick}
              aria-label="Attach files"
              title="Attach files"
              disabled={!live}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 3.25v9.5M3.25 8h9.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <div className="composer__textarea-wrap">
              <textarea
                ref={textareaRef}
                className="composer__textarea"
                value={text}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                aria-label="Message pi"
                disabled={!live}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

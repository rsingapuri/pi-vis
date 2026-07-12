import type { SessionId } from "@shared/ids.js";
import { type PiRpcCommand, commandNeedsIntent } from "@shared/pi-protocol/commands.js";
import type { ModelInfo } from "@shared/pi-protocol/responses.js";
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
import { useChangelogStore } from "../../stores/changelog-store.js";
import { openDiffForSession } from "../../stores/diff-store.js";
import { useImageViewerStore } from "../../stores/image-viewer-store.js";
import { useOverlayStore } from "../../stores/overlay-store.js";
import {
  isNewSessionPending,
  isSessionWorking,
  sessionHasHistory,
  sessionMatchesRuntime,
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

  // Pull the active session's state. We read everything we might need at
  // submit time from the same snapshot to avoid a render-during-update race.
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const escapeClaimCount = useOverlayStore((s) => s.count);
  const commands = session?.commands ?? [];
  const discovered = useMemo(() => new Map(commands.map((c) => [c.name, c])), [commands]);
  // The nonce is a monotonic counter; the effect below re-runs whenever
  // it changes (even if the text is identical) so the user can re-inject
  // the same prefix on demand.
  const editorInjectionNonce = session?.editorInjection?.nonce;

  useEffect(() => {
    replicatedAttachmentsRef.current = serializeComposerAttachments(attachments, fileAttachments);
  }, [attachments, fileAttachments]);

  const editorHostInstanceId = session?.hostInstanceId;
  const editorSessionEpoch = session?.sessionEpoch;
  useEffect(() => {
    // Re-seed from the latest replicated value whenever composer custody moves
    // to another session/host generation. Reading through the store avoids
    // resetting the serialized patch chain on every snapshot revision.
    const current = useSessionsStore.getState().sessions.get(sessionId);
    editorRevisionRef.current = current?.editorRevision ?? 0;
    editorPatchEpochRef.current++;
    editorPatchRetryNeededRef.current = false;
    editorPatchTailRef.current = Promise.resolve("accepted");
    const restored = parseReplicatedAttachments(current?.editorAttachments ?? []);
    replicatedAttachmentsRef.current = serializeComposerAttachments(
      restored.images,
      restored.files,
    );
    setAttachments(restored.images);
    setFileAttachments(restored.files);
    void editorHostInstanceId;
    void editorSessionEpoch;
  }, [sessionId, editorHostInstanceId, editorSessionEpoch]);

  const authoritativeEditorRevision = session?.editorRevision;
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
      if (!runtimeIdentity?.hostInstanceId) return baseRevision;
      const expectedHostInstanceId = runtimeIdentity.hostInstanceId;
      const expectedSessionEpoch = runtimeIdentity.sessionEpoch;
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

  const addUserMessage = useSessionsStore((s) => s.addUserMessage);
  const addBashCommand = useSessionsStore((s) => s.addBashCommand);
  const finishBashCommand = useSessionsStore((s) => s.finishBashCommand);
  const addToast = useSessionsStore((s) => s.addToast);
  const applyModelChange = useSessionsStore((s) => s.applyModelChange);
  const addCustomMessage = useSessionsStore((s) => s.addCustomMessage);
  const openPicker = useSessionsStore((s) => s.openPicker);
  const openImages = useImageViewerStore((s) => s.openImages);
  // Shared with the unified-TUI submit path (handleUnifiedSubmitRequest) so a
  // /fork|/clone|/switch_session|/resume hydrates the transcript + sidebar the
  // same way regardless of which surface dispatched it.
  const adoptSessionFileAndHydrate = useSessionsStore((s) => s.adoptSessionFileAndHydrate);
  const closeSessionTab = useSessionsStore((s) => s.closeSessionTab);
  const setWorktreeCreating = useSessionsStore((s) => s.setWorktreeCreating);
  const setWorktreeError = useSessionsStore((s) => s.setWorktreeError);
  const applyWorktree = useSessionsStore((s) => s.applyWorktree);
  const clearWorktreeIntent = useSessionsStore((s) => s.clearWorktreeIntent);
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
  const live =
    session?.status === "ready" && session.availability === "available" && !worktreeCreating;

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
        session?.currentModel,
        session?.currentProvider,
      ),
    [session?.availableModels, session?.currentModel, session?.currentProvider],
  );
  const modelSupportsImages = currentModelInfo?.input
    ? currentModelInfo.input.includes("image")
    : true;
  const modelLabel = currentModelInfo?.name ?? session?.currentModel ?? "This model";

  // Editor injection: a useEffect on the nonce (monotonic) re-picks up the
  // same text without thrashing on identical payloads.
  useEffect(() => {
    if (editorInjectionNonce === undefined || editorInjectionText === undefined) return;
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
      useSessionsStore.getState().sessions.get(sessionId)?.editorAttachments ?? [],
    );
    setAttachments(restored.images);
    setFileAttachments(injectedFiles ?? restored.files);
    textareaRef.current?.focus();
  }, [
    editorInjectionNonce,
    editorInjectionText,
    discovered,
    setNewSessionDraft,
    setSessionDraft,
    sessionId,
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
    if (didAutofocusRef.current) return;
    if (!live) return; // textarea still disabled — focus() would be a no-op
    // A dialog/dropdown/overlay owns focus and ESC precedence. Never steal
    // focus merely because the session became live behind that surface.
    if (escapeClaimCount > 0) return;
    const el = textareaRef.current;
    if (!el) return;
    const active = document.activeElement;
    const typingElsewhere =
      active instanceof HTMLElement &&
      active !== el &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    didAutofocusRef.current = true;
    if (typingElsewhere) return;
    el.focus();
  }, [live, escapeClaimCount]);

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
      if (store.sessions.get(sessionId)?.availability !== "available") {
        store.addToast(sessionId, "Session runtime is not currently available", "warning");
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
        // Empty path in "attach" mode is a client-side gate (the input
        // is just a text field — easy to send with nothing in it). Show
        // the inline error and retire this in-flight content so the composer
        // doesn't wedge behind the re-entrancy guard at the top of this
        // callback.
        if (worktreeMode === "attach" && !session.worktreeAttachPath?.trim()) {
          setWorktreeError(sessionId, "Choose a worktree directory first.");
          submissionsInFlightRef.current.delete(submissionInFlightKey);
          return;
        }
        try {
          // setWorktreeCreating(true) also clears any prior worktreeError.
          setWorktreeCreating(sessionId, true);
          let res:
            | { ok: true; worktreePath: string; branch: string; name: string; base: string }
            | { ok: false; error: string };
          if (worktreeMode === "create") {
            // Fall back to HEAD (current commit) when no base branch is
            // resolved — e.g. a detached HEAD where there is no current
            // branch to default to. Never assume a literal "main"; it
            // may not exist.
            const base = session.worktreeBase ?? "HEAD";
            res = await window.pivis.invoke("session.createWorktree", {
              sessionId,
              base,
            });
          } else {
            // "attach" — the IPC re-runs `inspectWorktree` server-side
            // and returns the canonical toplevel path, so a stale or
            // edited live-validate result can never persist a bad path.
            res = await window.pivis.invoke("session.attachWorktree", {
              sessionId,
              path: session.worktreeAttachPath ?? "",
            });
          }
          if (!res.ok) {
            // Surface the failure *inline* in the WorktreeBar (durable,
            // unlike a toast) and keep the prompt text intact so the
            // user can retry or switch modes and send without a
            // worktree — nothing is lost.
            setWorktreeError(sessionId, res.error ?? "Worktree operation failed");
            submissionsInFlightRef.current.delete(submissionInFlightKey);
            return;
          }
          // Past the narrowing: `res` is `{ok:true, ...}` here. Compose
          // the success toast after the narrowing check so `res.name` is
          // accessible without a union cast.
          const successToast =
            worktreeMode === "create"
              ? `Worktree ${res.name} created`
              : `Attached worktree ${res.name}`;
          applyWorktree(sessionId, {
            worktreePath: res.worktreePath,
            branch: res.branch,
            name: res.name,
            base: res.base,
          });
          // Drop the pre-send intent so the bar doesn't reappear
          // (still in the same mode) if the transcript later resets
          // via /new, /fork, or /clone.
          clearWorktreeIntent(sessionId);
          addToast(sessionId, successToast, "success");
        } catch (err) {
          setWorktreeError(sessionId, String(err));
          submissionsInFlightRef.current.delete(submissionInFlightKey);
          return;
        } finally {
          setWorktreeCreating(sessionId, false);
        }
      }

      try {
        // No-model guard: only for plain user prompts. /model (which fixes
        // the guard!) and bash bypass it. Must run inside `try` so the
        // `finally` below still resets `submittingRef`.
        if (
          finalAction.kind === "send-prompt" &&
          !session?.currentModel &&
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
            const resynced = await window.pivis.invoke("session.runtimeResync", { sessionId });
            if (
              !dispatchIdentity?.hostInstanceId ||
              resynced.availability !== "available" ||
              !resynced.snapshot ||
              resynced.hostInstanceId !== dispatchIdentity.hostInstanceId ||
              resynced.sessionEpoch !== dispatchIdentity.sessionEpoch
            ) {
              addToast(sessionId, "Session changed before editor retry", "warning");
              return;
            }
            useSessionsStore.getState().applyRuntimeState(sessionId, resynced);
            editorRevisionRef.current = resynced.snapshot.editor.revision;
            dispatchIdentity = useSessionsStore.getState().sessions.get(sessionId);
            synchronizeEditorText(textRef.current, replicatedAttachmentsRef.current);
          } catch (error) {
            editorPatchRetryNeededRef.current = true;
            addToast(sessionId, `Could not resynchronize editor: ${String(error)}`, "error");
            return;
          }
        }
        const patchOutcome = await editorPatchTailRef.current;
        const currentDispatchIdentity = useSessionsStore.getState().sessions.get(sessionId);
        if (patchOutcome !== "accepted") return;
        if (
          !dispatchIdentity?.hostInstanceId ||
          dispatchIdentity.hostInstanceId !== currentDispatchIdentity?.hostInstanceId ||
          dispatchIdentity.sessionEpoch !== currentDispatchIdentity?.sessionEpoch
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

        const deps = {
          // The executeAction interface is intentionally generic-string for
          // testability; the real invoke has a typed channel union, but the
          // runtime call sites pass the right channel so the runtime contract
          // is honored. We narrow at the boundary by giving the casted
          // wrapper the right call signature.
          invoke: async <T = unknown>(channel: string, payload: unknown) => {
            let identityBoundPayload =
              channel === "session.sendCommand" && payload && typeof payload === "object"
                ? {
                    ...payload,
                    expectedHostInstanceId: dispatchIdentity.hostInstanceId,
                    expectedSessionEpoch: dispatchIdentity.sessionEpoch,
                  }
                : payload;
            if (channel === "session.sendCommand") {
              const command = (payload as { command: PiRpcCommand }).command;
              identityBoundPayload = {
                ...(identityBoundPayload as object),
                requestId: crypto.randomUUID(),
                ...(commandNeedsIntent(command) ? { intentId: crypto.randomUUID() } : {}),
                sourceText: submittedLocalText,
                editorRevision: submittedEditorRevision,
                uiSurface: "composer",
              };
            } else if (channel === "session.reload") {
              identityBoundPayload = {
                sessionId,
                request: {
                  requestId: crypto.randomUUID(),
                  intentId: crypto.randomUUID(),
                  expectedHostInstanceId: dispatchIdentity.hostInstanceId,
                  expectedSessionEpoch: dispatchIdentity.sessionEpoch,
                  sourceText: submittedLocalText,
                },
              };
            } else if (channel === "session.share") {
              identityBoundPayload = {
                ...(payload as object),
                expectedHostInstanceId: dispatchIdentity.hostInstanceId,
                expectedSessionEpoch: dispatchIdentity.sessionEpoch,
                exportIntentId: crypto.randomUUID(),
              };
            }
            const result = (await window.pivis.invoke(
              channel as Parameters<typeof window.pivis.invoke>[0],
              identityBoundPayload as Parameters<typeof window.pivis.invoke>[1],
            )) as unknown as {
              success: boolean;
              data?: T;
              error?: string;
              disposition?: "not_executed" | "completed" | "outcome_unknown";
              successorIdentity?: { hostInstanceId: string; sessionEpoch: number };
            };
            if (
              (channel === "session.sendCommand" || channel === "session.reload") &&
              result.disposition &&
              result.disposition !== "completed"
            ) {
              throw new InputNotConsumedError(result.error ?? `Command ${result.disposition}`);
            }
            if (
              channel === "session.sendCommand" &&
              !result.successorIdentity &&
              !sessionMatchesRuntime(useSessionsStore.getState().sessions.get(sessionId), {
                hostInstanceId: dispatchIdentity.hostInstanceId!,
                sessionEpoch: dispatchIdentity.sessionEpoch,
              })
            ) {
              throw new InputNotConsumedError("Session changed before command continuation");
            }
            return result;
          },
          uiSurface: "composer" as const,
          submit: async (
            sid: SessionId,
            submission: import("@shared/pi-protocol/runtime-state.js").SessionSubmission,
          ) => {
            await editorPatchTailRef.current;
            return window.pivis.invoke("session.submit", {
              sessionId: sid,
              submission,
            });
          },
          getSubmissionContext: (sid: SessionId) => {
            const runtime = useSessionsStore.getState().sessions.get(sid);
            if (!runtime?.hostInstanceId || runtime.availability !== "available") return undefined;
            return {
              hostInstanceId: runtime.hostInstanceId,
              sessionEpoch: runtime.sessionEpoch,
              editorRevision: editorRevisionRef.current,
              userMessageSequence: runtime.transcript.userMessageSequence,
            };
          },
          addToast,
          addUserMessage: (
            sid: SessionId,
            message: string,
            images?: string[],
            opts?: {
              registerEcho?: boolean;
              clearDraft?: boolean;
              afterUserMessageSequence?: number;
              intentId?: string;
            },
          ) => addUserMessage(sid, message, images, { ...opts, clearDraft: false }),
          clearPendingUserEcho: useSessionsStore.getState().clearPendingUserEcho,
          addBashCommand,
          finishBashCommand,
          applyModelChange,
          addCustomMessage,
          openChangelog: (markdown: string) => {
            // The changelog modal is mounted at the App level (overlay over
            // the session area). The store owns its state; we just call
            // the action — same pattern as openDiffViewer / openLogin.
            useChangelogStore.getState().openChangelog(markdown);
          },
          openPicker: (sid: SessionId, picker: PickerRequest) =>
            openPicker(sid, {
              ...picker,
              expectedHostInstanceId: dispatchIdentity.hostInstanceId!,
              expectedSessionEpoch: dispatchIdentity.sessionEpoch,
            }),
          adoptSessionFile: (sid: SessionId, file?: string, name?: string) =>
            adoptSessionFileAndHydrate(sid, file, name),
          closeSessionTab: async (sid: SessionId) => closeSessionTab(sid),
          openAppSettings: () => {
            // The settings panel is owned by App.tsx; we dispatch a custom
            // event that the App subscribes to. Keeps Composer free of
            // cross-tree prop drilling.
            window.dispatchEvent(new CustomEvent("pivis:open-settings"));
          },
          openDiffViewer: (sid: SessionId) => {
            // The diff viewer is mounted at the App level (overlay over
            // the session area). The store owns its state; we just call
            // the helper.
            openDiffForSession(sid);
          },
          openTreeViewer: (sid: SessionId) => {
            // Tree viewer mirrors diff viewer's lifecycle: store-owned,
            // App-mounted. Calling openTreeForSession triggers the
            // get_tree fetch and flips phase to loading→ready.
            void useTreeStore.getState().openTreeForSession(sid);
          },
          openLogin: () => {
            window.dispatchEvent(new CustomEvent("pivis:open-login"));
          },
          copyToClipboard: async (t: string) => {
            await window.pivis.invoke("clipboard.writeText", { text: t });
          },
          getAvailableModels: (sid: SessionId): ModelInfo[] => {
            const s = useSessionsStore.getState().sessions.get(sid);
            return s?.availableModels ?? [];
          },
          getSessionName: (sid: SessionId) =>
            useSessionsStore.getState().sessions.get(sid)?.sessionName,
          setSessionName: useSessionsStore.getState().setSessionName,
          getCurrentModel: (sid: SessionId) =>
            useSessionsStore.getState().sessions.get(sid)?.currentModel,
          isWorking: (sid: SessionId) =>
            isSessionWorking(useSessionsStore.getState().sessions.get(sid)),
          getSessionWorkspacePath: (sid: SessionId) =>
            useSessionsStore.getState().sessions.get(sid)?.workspacePath,
          listSessions: (p: string) =>
            window.pivis.invoke("workspace.listSessions", { workspacePath: p }),
          onPromptAccepted: () => {
            if (isRealPrompt && pendingDiffComments.length > 0) {
              clearSubmittedDiffComments(sessionId, pendingDiffComments);
            }
          },
        };

        const actionResult = await executeAction(sessionId, finalAction, deps);
        const submissionResult =
          actionResult && "disposition" in actionResult ? actionResult : undefined;
        const commandCompletion =
          actionResult && "completionRuntime" in actionResult ? actionResult : undefined;
        if (commandCompletion) {
          try {
            const resynced = await window.pivis.invoke("session.runtimeResync", { sessionId });
            if (
              resynced.hostInstanceId === commandCompletion.completionRuntime.hostInstanceId &&
              resynced.sessionEpoch === commandCompletion.completionRuntime.sessionEpoch
            ) {
              useSessionsStore.getState().applyRuntimeState(sessionId, resynced);
              if (resynced.snapshot) editorRevisionRef.current = resynced.snapshot.editor.revision;
            }
          } catch {
            // Without the acknowledged successor snapshot, preserve the command;
            // clearing it against the retired epoch would lose editor custody.
          }
        }
        const acceptedDisposition =
          submissionResult &&
          ["in_custody", "consumed", "completed", "extension_error"].includes(
            submissionResult.disposition,
          );
        const sameCustody =
          submissionResult?.hostInstanceId === session?.hostInstanceId &&
          submissionResult?.sessionEpoch === session?.sessionEpoch &&
          submissionResult?.editorRevision === submittedEditorRevision;
        const currentSession = useSessionsStore.getState().sessions.get(sessionId);
        const originatingComposerStillMounted =
          mountedRef.current && renderedSessionIdRef.current === sessionId;
        const dispatchRuntimeStillCurrent =
          currentSession?.availability === "available" &&
          currentSession.status === "ready" &&
          dispatchIdentity.hostInstanceId === currentSession.hostInstanceId &&
          dispatchIdentity.sessionEpoch === currentSession.sessionEpoch;
        const completionIdentity = commandCompletion?.completionRuntime;
        const completionRuntimeStillCurrent =
          !!completionIdentity &&
          currentSession?.availability === "available" &&
          currentSession.status === "ready" &&
          completionIdentity.hostInstanceId === currentSession.hostInstanceId &&
          completionIdentity.sessionEpoch === currentSession.sessionEpoch;
        const commandRuntimeStillCurrent = commandCompletion
          ? completionRuntimeStillCurrent
          : dispatchRuntimeStillCurrent;
        const currentAttachmentsKey = JSON.stringify(replicatedAttachmentsRef.current);
        const noNewLocalEdit = localEditGenerationRef.current === submittedLocalEditGeneration;
        const noLaterHostEditorMutation =
          (currentSession?.editorRevision ?? submittedEditorRevision) <=
          submittedEditorRevision + 1;
        const currentInjection = currentSession?.editorInjection;
        const noLaterHostInjection =
          currentInjection === undefined ||
          currentInjection.nonce === submittedEditorInjectionNonce ||
          (currentInjection.text === "" &&
            (currentInjection.revision ?? submittedEditorRevision + 1) <=
              submittedEditorRevision + 1);
        const localPayloadUnchanged =
          noNewLocalEdit &&
          textRef.current === submittedLocalText &&
          currentAttachmentsKey === submittedAttachmentsKey;
        const hostAlreadyClearedPayload =
          noNewLocalEdit &&
          textRef.current === "" &&
          currentAttachmentsKey === (isRealPrompt ? "[]" : submittedAttachmentsKey);
        const acceptedPromptCanClear =
          finalAction.kind === "send-prompt" &&
          originatingComposerStillMounted &&
          dispatchRuntimeStillCurrent &&
          acceptedDisposition &&
          sameCustody &&
          noLaterHostEditorMutation &&
          noLaterHostInjection &&
          (localPayloadUnchanged || hostAlreadyClearedPayload);
        const completedCommandCanClear =
          finalAction.kind !== "send-prompt" &&
          originatingComposerStillMounted &&
          commandRuntimeStillCurrent &&
          finalAction.kind !== "unsupported" &&
          localPayloadUnchanged;
        // Prompt custody may advance the authoritative revision before the RPC
        // response arrives. Renderer-local edit generation, payload identity,
        // and runtime identity distinguish that acknowledgement from newer
        // typing without relying on the now-stale pre-submit revision.
        if (acceptedPromptCanClear || completedCommandCanClear) {
          if (completedCommandCanClear) {
            synchronizeEditorText("", replicatedAttachmentsRef.current);
          }
          textRef.current = "";
          setText("");
          // Only an ordinary prompt consumes staged context. Commands clear
          // their own text while keeping images/files for the next prompt.
          if (isRealPrompt) {
            setAttachments([]);
            setFileAttachments([]);
            replicatedAttachmentsRef.current = [];
          }
          setSlashIndex(0);
        }
        if (isRealPrompt && pendingDiffComments.length > 0) {
          clearSubmittedDiffComments(sessionId, pendingDiffComments);
        }

        // The store actions for content-bearing sends
        // (addUserMessage/addBashCommand/addCustomMessage) and applyEvent's
        // user-echo backstop already clear the per-workspace draft for
        // prompts/bash/template/skill sends. But non-promoting slash
        // commands (/model, /name, /settings, /diff, /login, …) add no
        // transcript block, so they'd leave their command text lingering in
        // the active pending draft (or, for non-pending sessions, on
        // switch-back). Clear here too, once the action has dispatched
        // successfully past all guards. This is idempotent with the
        // store-side clears.
        // Read isNewPending from the store (authoritative at this moment)
        // rather than pendingRef.current, which may not have re-rendered yet
        // after addUserMessage flipped isNewPending to false during the await
        // above. In practice both agree (the store actions already cleared
        // the relevant draft for content sends; this clear is load-bearing
        // only for non-promoting slash commands where isNewPending is
        // unchanged), but reading the store is robust against future
        // mutations added between executeAction and here.
        if (acceptedPromptCanClear || completedCommandCanClear) {
          const stillPending = !!useSessionsStore.getState().sessions.get(sessionId)?.isNewPending;
          if (stillPending && workspacePathRef.current) {
            useSessionsStore.getState().clearNewSessionDraft(workspacePathRef.current);
          } else {
            useSessionsStore.getState().setSessionDraft(sessionId, "");
          }
        }
        // Consume only the injection that existed before this send. An
        // extension may call setEditorText while its command is executing;
        // clearing that newer nonce would discard replacement text before the
        // Composer's effect can apply it.
        if (
          originatingComposerStillMounted &&
          currentInjection?.nonce === submittedEditorInjectionNonce
        ) {
          useSessionsStore.getState().clearEditorInjection(sessionId);
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
      addBashCommand,
      finishBashCommand,
      applyModelChange,
      addCustomMessage,
      openPicker,
      adoptSessionFileAndHydrate,
      closeSessionTab,
      setWorktreeCreating,
      setWorktreeError,
      applyWorktree,
      clearWorktreeIntent,
      attachments,
      fileAttachments,
      modelSupportsImages,
      modelLabel,
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

import type { SessionId } from "@shared/ids.js";
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
import { prependCodeCommentsToPrompt } from "../../lib/diff-comments.js";
import { findCurrentModel } from "../../lib/model-utils.js";
import { useChangelogStore } from "../../stores/changelog-store.js";
import { openDiffForSession } from "../../stores/diff-store.js";
import { useImageViewerStore } from "../../stores/image-viewer-store.js";
import {
  isNewSessionPending,
  sessionHasHistory,
  useSessionsStore,
} from "../../stores/sessions-store.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconClose, IconComment, IconFile } from "../common/icons.js";
import "./Composer.css";

interface ComposerProps {
  sessionId: SessionId;
}

interface ImageAttachment {
  name: string;
  path: string;
  dataUrl: string;
}

interface FileAttachment {
  name: string;
  path: string;
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

function textWithPrependedFilePaths(current: string, paths: string[]): string {
  if (paths.length === 0) return current;
  const separator = current.length === 0 || /^\r?\n/.test(current) ? "" : "\n";
  return `${paths.join("\n")}${separator}${current}`;
}

function textWithAppendedFilePaths(current: string, paths: string[]): string {
  if (paths.length === 0) return current;
  const separator = current.length === 0 || /\s$/.test(current) ? "" : "\n";
  return `${current}${separator}${paths.join("\n")}`;
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
  const [text, setText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Container for the slash-suggestion list. Used to scroll the
  // keyboard-selected row into view during arrow-key navigation so the
  // highlight can't outrun the visible viewport (the list scrolls, not the
  // whole pane — see .composer__suggestion-list's internal overflow-y).
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  // Re-entrancy guard for `handleSubmit`. Without this, a rapid/auto-repeat
  // keydown can read the stale `text` closure before `setText("")` commits
  // and dispatch two submissions (two optimistic bubbles + two prompts).
  // Set to true for the duration of the submit, reset in `finally` so a
  // rejected/throwing call doesn't lock the composer permanently.
  const submittingRef = useRef(false);

  // Pull the active session's state. We read everything we might need at
  // submit time from the same snapshot to avoid a render-during-update race.
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const commands = session?.commands ?? [];
  const discovered = useMemo(() => new Map(commands.map((c) => [c.name, c])), [commands]);
  // The nonce is a monotonic counter; the effect below re-runs whenever
  // it changes (even if the text is identical) so the user can re-inject
  // the same prefix on demand.
  const editorInjectionNonce = session?.editorInjection?.nonce;

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
        setAttachments([]);
        setFileAttachments([]);
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
  const beginPromptInFlight = useSessionsStore((s) => s.beginPromptInFlight);
  const endPromptInFlight = useSessionsStore((s) => s.endPromptInFlight);
  const enqueueOptimisticSteer = useSessionsStore((s) => s.enqueueOptimisticSteer);
  const removeOptimisticQueuedMessage = useSessionsStore((s) => s.removeOptimisticQueuedMessage);
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
  const live = (session?.status === "starting" || session?.status === "ready") && !worktreeCreating;

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
    const injectedFiles = fileAttachmentsFromEditorText(editorInjectionText);
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
    setAttachments([]);
    setFileAttachments(injectedFiles ?? []);
    textareaRef.current?.focus();
  }, [editorInjectionNonce, editorInjectionText, setNewSessionDraft, setSessionDraft, sessionId]);

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
  }, [live]);

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
        setFileAttachments((prev) => [...prev, ...genericFiles]);
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
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setAttachments((prev) => [...prev, { name: file.name, path, dataUrl }]);
        };
        reader.readAsDataURL(file);
      }
      e.target.value = "";
    },
    [addToast, attachments, sessionId, modelSupportsImages, modelLabel],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeFileAttachment = useCallback((index: number) => {
    setFileAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

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
      const pendingDiffComments = useSessionsStore.getState().getDiffCommentsForPrompt(sessionId);
      if (!content.trim() && fileAttachments.length === 0 && pendingDiffComments.length === 0)
        return;
      // Drop a second concurrent invocation: a held/auto-repeat Enter can
      // re-fire this before the `text` state below commits, which would
      // otherwise read the same `content` twice and dispatch two sends.
      if (submittingRef.current) return;
      submittingRef.current = true;

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
        // the inline error and reset `submittingRef` so the composer
        // doesn't wedge behind the re-entrancy guard at the top of this
        // callback.
        if (worktreeMode === "attach" && !session.worktreeAttachPath?.trim()) {
          setWorktreeError(sessionId, "Choose a worktree directory first.");
          submittingRef.current = false;
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
            submittingRef.current = false;
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
          submittingRef.current = false;
          return;
        } finally {
          setWorktreeCreating(sessionId, false);
        }
      }

      try {
        const action = parseComposerInput(content, { discovered });
        let imgs = attachments;
        const attachedFilePaths = fileAttachments.map((a) => a.path);
        let promptText = action.kind === "send-prompt" ? action.text : content;
        if (action.kind !== "send-prompt" && attachedFilePaths.length > 0) {
          addToast(sessionId, "File attachments can only be sent with prompts", "error");
          return;
        }
        if (action.kind === "send-prompt" && attachedFilePaths.length > 0) {
          promptText = textWithPrependedFilePaths(action.text, attachedFilePaths);
        }
        if (action.kind === "send-prompt" && pendingDiffComments.length > 0) {
          promptText = prependCodeCommentsToPrompt(promptText, pendingDiffComments);
        }
        // If the user attached enhanced image previews and then switched to a
        // text-only model, preserve TUI parity by sending the image paths in
        // the prompt instead of silently dropping the attachments.
        if (action.kind === "send-prompt" && imgs.length > 0 && !modelSupportsImages) {
          addToast(
            sessionId,
            `${modelLabel} doesn't support image input — sending image file paths instead`,
            "warning",
          );
          promptText = textWithAppendedFilePaths(
            promptText,
            imgs.map((a) => a.path),
          );
          imgs = [];
        }

        const finalAction =
          action.kind === "send-prompt"
            ? {
                ...action,
                text: promptText,
                ...(imgs.length > 0
                  ? {
                      images: imgs.map((a) => {
                        const comma = a.dataUrl.indexOf(",");
                        const header = a.dataUrl.slice(0, comma);
                        const mimeType = /^data:([^;]+)/.exec(header)?.[1] ?? "image/png";
                        return {
                          data: a.dataUrl.slice(comma + 1),
                          mimeType,
                          dataUrl: a.dataUrl,
                        };
                      }),
                    }
                  : {}),
              }
            : action;

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

        // Clear the composer only after the send is past every early-return
        // guard above. Clearing earlier (before the no-model guard) wiped the
        // visible text on a bail while the per-workspace draft silently held
        // it — leaving the user staring at an empty composer with no obvious
        // way to recover their prompt. The draft itself is cleared in the
        // store actions (addUserMessage / addBashCommand / addCustomMessage)
        // the moment content lands, so an aborted send still preserves it.
        setText("");
        setAttachments([]);
        setFileAttachments([]);
        setSlashIndex(0);

        const deps = {
          // The executeAction interface is intentionally generic-string for
          // testability; the real invoke has a typed channel union, but the
          // runtime call sites pass the right channel so the runtime contract
          // is honored. We narrow at the boundary by giving the casted
          // wrapper the right call signature.
          invoke: <T = unknown>(channel: string, payload: unknown) =>
            window.pivis.invoke(
              channel as Parameters<typeof window.pivis.invoke>[0],
              payload as Parameters<typeof window.pivis.invoke>[1],
            ) as unknown as Promise<{ success: boolean; data?: T; error?: string }>,
          uiSurface: "composer" as const,
          beginPromptInFlight,
          endPromptInFlight,
          enqueueOptimisticSteer,
          removeOptimisticQueuedMessage,
          addToast,
          addUserMessage,
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
          openPicker: (sid: SessionId, picker: PickerRequest) => openPicker(sid, picker),
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
          isWorking: (sid: SessionId) => {
            const sess = useSessionsStore.getState().sessions.get(sid);
            return !!sess && (sess.isStreaming || sess.promptsInFlight > 0);
          },
          getSessionWorkspacePath: (sid: SessionId) =>
            useSessionsStore.getState().sessions.get(sid)?.workspacePath,
          listSessions: (p: string) =>
            window.pivis.invoke("workspace.listSessions", { workspacePath: p }),
          onPromptAccepted: () => {
            if (finalAction.kind === "send-prompt" && pendingDiffComments.length > 0) {
              clearSubmittedDiffComments(sessionId, pendingDiffComments);
            }
          },
        };

        await executeAction(sessionId, finalAction, deps);
        if (
          finalAction.kind === "send-prompt" &&
          finalAction.commandSource !== "extension" &&
          pendingDiffComments.length > 0
        ) {
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
        const stillPending = !!useSessionsStore.getState().sessions.get(sessionId)?.isNewPending;
        if (stillPending && workspacePathRef.current) {
          useSessionsStore.getState().clearNewSessionDraft(workspacePathRef.current);
        } else {
          useSessionsStore.getState().setSessionDraft(sessionId, "");
        }
        // A send also consumes any editor injection — otherwise the stale
        // injection would re-fire on the next remount and pollute the draft.
        useSessionsStore.getState().clearEditorInjection(sessionId);
      } catch (err) {
        if (err instanceof InputNotConsumedError) {
          setText(content);
          setAttachments(attachments);
          setFileAttachments(fileAttachments);
          if (pendingRef.current && workspacePathRef.current) {
            useSessionsStore.getState().setNewSessionDraft(workspacePathRef.current, content);
          } else {
            useSessionsStore.getState().setSessionDraft(sessionId, content);
          }
          return;
        }
        throw err;
      } finally {
        submittingRef.current = false;
      }
    },
    [
      text,
      discovered,
      session,
      sessionId,
      addToast,
      beginPromptInFlight,
      endPromptInFlight,
      enqueueOptimisticSteer,
      removeOptimisticQueuedMessage,
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
            setText(v);
            if (pending && workspacePath) setNewSessionDraft(workspacePath, v);
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
            setText(completed);
            if (pending && workspacePath) setNewSessionDraft(workspacePath, completed);
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
    ],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      setText(v);
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
    [pending, workspacePath, setNewSessionDraft, setSessionDraft, sessionId, clearEditorInjection],
  );

  // ── Click to pick a suggestion ─────────────────────────────────────

  const handleSuggestionClick = useCallback(
    (entry: SuggestionEntry) => {
      const v = completionFor(entry);
      setText(v);
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

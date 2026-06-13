import type { SessionId } from "@shared/ids.js";
import type { ModelInfo } from "@shared/pi-protocol/responses.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnsiText } from "../../lib/ansi.js";
import {
  BUILTIN_COMMANDS,
  type PickerRequest,
  UNSUPPORTED_TUI_COMMANDS,
  executeAction,
  parseComposerInput,
} from "../../lib/commands/index.js";
import { openDiffForSession } from "../../stores/diff-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import "./Composer.css";

interface ComposerProps {
  sessionId: SessionId;
}

interface Attachment {
  name: string;
  dataUrl: string;
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
  const [text, setText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pull the active session's state. We read everything we might need at
  // submit time from the same snapshot to avoid a render-during-update race.
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const commands = session?.commands ?? [];
  const discovered = useMemo(() => new Map(commands.map((c) => [c.name, c])), [commands]);
  // The nonce is a monotonic counter; the effect below re-runs whenever
  // it changes (even if the text is identical) so the user can re-inject
  // the same prefix on demand.
  const editorInjectionNonce = session?.editorInjection?.nonce;
  const editorInjectionText = session?.editorInjection?.text;

  const addUserMessage = useSessionsStore((s) => s.addUserMessage);
  const addBashCommand = useSessionsStore((s) => s.addBashCommand);
  const finishBashCommand = useSessionsStore((s) => s.finishBashCommand);
  const setStreaming = useSessionsStore((s) => s.setStreaming);
  const addToast = useSessionsStore((s) => s.addToast);
  const setCurrentModel = useSessionsStore((s) => s.setCurrentModel);
  const addCustomMessage = useSessionsStore((s) => s.addCustomMessage);
  const openPicker = useSessionsStore((s) => s.openPicker);
  const adoptSessionFile = useSessionsStore((s) => s.adoptSessionFile);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const closeSessionTab = useSessionsStore((s) => s.closeSessionTab);
  const seedHistory = useSessionsStore((s) => s.seedHistory);
  const updateSettings = useSettingsStore((s) => s.update);

  const isStreaming = session?.isStreaming ?? false;
  const live = session?.status === "starting" || session?.status === "ready";

  // Editor injection: a useEffect on the nonce (monotonic) re-picks up the
  // same text without thrashing on identical payloads.
  useEffect(() => {
    if (editorInjectionNonce === undefined || editorInjectionText === undefined) return;
    setText(editorInjectionText);
    setSlashIndex(0);
    setAttachments([]);
    textareaRef.current?.focus();
  }, [editorInjectionNonce, editorInjectionText]);

  // ── Attachment handling ─────────────────────────────────────────────

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setAttachments((prev) => [...prev, { name: file.name, dataUrl }]);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Suggestion list ────────────────────────────────────────────────

  const suggestions = useMemo<SuggestionEntry[]>(() => {
    if (!text.startsWith("/")) return [];
    const prefix = text.slice(1).toLowerCase();
    const hasSpace = text.includes(" ");
    if (hasSpace) return []; // suggestions only for the bare command token

    const entries: SuggestionEntry[] = [];
    // Built-ins first. We filter out unsupported TUI commands from the
    // suggestions list — they have a dedicated toast on invocation, not
    // a "click to fill" entry.
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
    // Discovered (extension / prompt / skill). Skip names that collide with
    // built-ins (TUI priority: built-in wins for discoverability, the parser
    // also gives built-ins precedence; surfacing both would be confusing).
    for (const c of commands) {
      if (!c.name.toLowerCase().startsWith(prefix)) continue;
      if (UNSUPPORTED_TUI_COMMANDS.has(c.name)) continue;
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
    return entries.slice(0, 8);
  }, [text, commands]);

  // Reset highlight when the suggestion list shape changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on shape, not identity; recompute on each keystroke is intentional
  useEffect(() => {
    setSlashIndex(0);
  }, [suggestions.length, text]);

  // ── Submit ─────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    const content = text;
    if (!content.trim()) return;
    setText("");
    setAttachments([]);
    setSlashIndex(0);

    const action = parseComposerInput(content, { discovered });
    const imgs = attachments;

    const finalAction =
      action.kind === "send-prompt" && imgs.length > 0
        ? {
            ...action,
            images: imgs.map((a) => {
              const comma = a.dataUrl.indexOf(",");
              const header = a.dataUrl.slice(0, comma);
              const mimeType = /^data:([^;]+)/.exec(header)?.[1] ?? "image/png";
              return { data: a.dataUrl.slice(comma + 1), mimeType, dataUrl: a.dataUrl };
            }),
          }
        : action;

    // No-model guard: only for plain user prompts. /model (which fixes
    // the guard!) and bash bypass it.
    if (
      finalAction.kind === "send-prompt" &&
      !session?.currentModel &&
      finalAction.commandSource === undefined
    ) {
      addToast(sessionId, "No model selected", "error");
      return;
    }

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
      setStreaming,
      addToast,
      addUserMessage,
      addBashCommand,
      finishBashCommand,
      setCurrentModel,
      updateLastUsedModel: async (provider: string, modelId: string) => {
        await updateSettings({ lastUsedModel: { provider, modelId } });
      },
      addCustomMessage,
      openPicker: (sid: SessionId, picker: PickerRequest) => openPicker(sid, picker),
      adoptSessionFile: async (sid: SessionId, file?: string, name?: string) => {
        await adoptSessionFile(sid, file, name);
        if (file) {
          const history = await window.pivis.invoke("session.loadHistory", { sessionId: sid });
          seedHistory(sid, history ?? []);
          if (session?.workspacePath) {
            void refreshWorkspaceSessions(session.workspacePath);
          }
        }
      },
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
      copyToClipboard: async (t: string) => {
        await navigator.clipboard.writeText(t);
      },
      getAvailableModels: (sid: SessionId): ModelInfo[] => {
        const s = useSessionsStore.getState().sessions.get(sid);
        return s?.availableModels ?? [];
      },
      getSessionName: (sid: SessionId) =>
        useSessionsStore.getState().sessions.get(sid)?.sessionName,
      getCurrentModel: (sid: SessionId) =>
        useSessionsStore.getState().sessions.get(sid)?.currentModel,
      getSessionWorkspacePath: (sid: SessionId) =>
        useSessionsStore.getState().sessions.get(sid)?.workspacePath,
      listSessions: (p: string) =>
        window.pivis.invoke("workspace.listSessions", { workspacePath: p }),
    };

    await executeAction(sessionId, finalAction, deps);
  }, [
    text,
    discovered,
    session,
    sessionId,
    addToast,
    setStreaming,
    addUserMessage,
    addBashCommand,
    finishBashCommand,
    setCurrentModel,
    updateSettings,
    addCustomMessage,
    openPicker,
    adoptSessionFile,
    closeSessionTab,
    seedHistory,
    refreshWorkspaceSessions,
    attachments,
  ]);

  // ── Abort ──────────────────────────────────────────────────────────

  const handleAbort = useCallback(() => {
    window.pivis
      .invoke("session.sendCommand", {
        sessionId,
        command: { type: "abort" },
      })
      .catch(console.error);
  }, [sessionId]);

  // ── Keyboard ───────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestions.length > 0) {
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
            const isArg = BUILTIN_COMMANDS.find((b) => b.name === chosen.name)?.takesArgs;
            setText(isArg ? `/${chosen.name} ` : `/${chosen.name}`);
            setSlashIndex(0);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashIndex(0);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }

      if (e.key === "Escape" && isStreaming) {
        handleAbort();
      }
    },
    [suggestions, slashIndex, handleSubmit, isStreaming, handleAbort],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
  }, []);

  // ── Click to pick a suggestion ─────────────────────────────────────

  const handleSuggestionClick = useCallback((entry: SuggestionEntry) => {
    const isArg = BUILTIN_COMMANDS.find((b) => b.name === entry.name)?.takesArgs;
    setText(isArg ? `/${entry.name} ` : `/${entry.name}`);
    setSlashIndex(0);
    textareaRef.current?.focus();
  }, []);

  const isBashMode = text.startsWith("!");
  const isSlashMode = text.startsWith("/");

  return (
    <div className="composer">
      {/* Image preview strip */}
      {attachments.length > 0 && (
        <div className="composer__attachments">
          {attachments.map((att, i) => (
            <div key={`${att.name}-${i}`} className="composer__attachment-item">
              <img src={att.dataUrl} alt={att.name} className="composer__attachment-thumb" />
              <button
                type="button"
                className="composer__attachment-remove"
                onClick={() => removeAttachment(i)}
                aria-label={`Remove ${att.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Widget strip */}
      {session && session.widgets.size > 0 && (
        <div className="composer__widget-strip">
          {Array.from(session.widgets.entries()).map(([key, lines]) => (
            <div key={key} className="widget-strip__item">
              {lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: widget lines are appended and stable per key
                <div key={i} className="widget-strip__line">
                  <AnsiText text={line} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Slash suggestions */}
      {suggestions.length > 0 && (
        <div className="composer__suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <button
              type="button"
              key={s.key}
              className={`composer__suggestion ${i === slashIndex ? "composer__suggestion--selected" : ""}`}
              onClick={() => handleSuggestionClick(s)}
              role="option"
              aria-selected={i === slashIndex}
            >
              <span className="composer__suggestion-name">/{s.name}</span>
              <span className="composer__suggestion-arg">{s.argHint ?? ""}</span>
              <span className="composer__suggestion-desc">{s.description ?? ""}</span>
              <span className={`composer__suggestion-badge composer__suggestion-badge--${s.badge}`}>
                {s.badge}
                {s.scope ? `:${s.scope}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="composer__file-input"
        onChange={handleFilesSelected}
      />
      <div
        className={`composer__input-row ${isBashMode ? "composer__input-row--bash" : ""} ${isSlashMode ? "composer__input-row--slash" : ""}`}
      >
        <div className="composer__input-box">
          <button
            type="button"
            className="composer__attach-btn"
            onClick={handleAttachClick}
            aria-label="Attach images"
            title="Attach images"
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
            {text === "" && (
              <div className="composer__placeholder" aria-hidden="true">
                {isStreaming
                  ? "Streaming… (Enter to queue, Esc to abort)"
                  : "Message pi… (Enter to send, !cmd for bash, /cmd for commands)"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

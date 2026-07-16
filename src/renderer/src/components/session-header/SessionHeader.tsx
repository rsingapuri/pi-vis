import type { SessionId } from "@shared/ids.js";
import type { ModelInfo, SessionStats } from "@shared/pi-protocol/responses.js";
import { ModelInfoSchema, SessionStatsSchema } from "@shared/pi-protocol/responses.js";
import { THINKING_LEVELS, type ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useVirtualList } from "../../hooks/useVirtualList.js";
import { findCurrentModel, modelDisplayName, modelKey } from "../../lib/model-utils.js";
import {
  type AuthorityObservation,
  dispatchSessionIntent,
  querySession,
} from "../../lib/session-intent.js";
import { openDiffForSession, useDiffStore } from "../../stores/diff-store.js";
import {
  type SessionViewState,
  gitRootForSession,
  useSessionsStore,
} from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconCheck, IconChevronDown } from "../common/icons.js";
import { UnifiedViewToggle } from "../ext-ui/UnifiedViewToggle.js";
import { NotificationBellButton } from "../notifications/NotificationStack.js";
import { ContextMeter } from "./ContextMeter.js";
import { WorktreeSwitcher } from "./WorktreeSwitcher.js";
import "./SessionHeader.css";

interface SessionHeaderProps {
  sessionId: SessionId;
}

type GroupedModelHighlight =
  | { type: "provider"; providerKey: string }
  | { type: "model"; providerKey: string; modelKey: string };

type GroupedModelKeyboardItem = GroupedModelHighlight & { model?: ModelInfo };

type PendingIntent<T> = { intentId: string; value: T };

function authorityObservationFor(
  projection: SessionViewState["authorityProjection"],
): AuthorityObservation | undefined {
  if (projection?.semantic.state !== "following" || !projection.authoritativeSnapshot) {
    return undefined;
  }
  return { owner: projection.authoritativeSnapshot.owner, cursor: projection.semantic.cursor };
}

function sameOwner(a: AuthorityObservation["owner"], b: AuthorityObservation["owner"]): boolean {
  return a.hostInstanceId === b.hostInstanceId && a.sessionEpoch === b.sessionEpoch;
}

function sameObservation(a: AuthorityObservation, b: AuthorityObservation | undefined): boolean {
  return !!(
    b &&
    sameOwner(a.owner, b.owner) &&
    a.cursor?.transportSequence === b.cursor?.transportSequence &&
    a.cursor?.snapshotSequence === b.cursor?.snapshotSequence
  );
}

function observationForSession(
  session: SessionViewState | undefined,
): AuthorityObservation | undefined {
  return authorityObservationFor(session?.authorityProjection);
}

function observationOwnerIsCurrent(
  sessionId: SessionId,
  observation: AuthorityObservation,
): boolean {
  const current = observationForSession(useSessionsStore.getState().sessions.get(sessionId));
  return !!current && sameOwner(observation.owner, current.owner);
}

/** Mirror pi-ai's getSupportedThinkingLevels without importing pi internals. */
export function thinkingLevelsForModel(model?: ModelInfo): readonly ThinkingLevel[] {
  if (model?.reasoning === false) return ["off"];
  const levelMap = model?.thinkingLevelMap;
  return THINKING_LEVELS.filter((level) => {
    const mapped = levelMap?.[level];
    if (mapped === null) return false;
    // Pi 0.80.6 makes the two highest levels opt-in per model. Older model
    // records lack these keys and must not advertise a level pi will clamp.
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function SessionHeader({ sessionId }: SessionHeaderProps): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const setStats = useSessionsStore((s) => s.setStats);
  const setSessionFile = useSessionsStore((s) => s.setSessionFile);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);

  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [pendingRename, setPendingRename] = useState<PendingIntent<string> | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Claim ESC while the rename field is open so a background streaming
  // session isn't aborted.
  useEscapeClaim(editingName);

  // A semantic authority cursor, rather than process liveness alone, gates
  // header controls and reads. Retained legacy values are diagnostics while a
  // semantic plane is synchronizing and must not drive a mutation.
  const authorityProjection = session?.authorityProjection;
  const observation = useMemo(
    () => authorityObservationFor(authorityProjection),
    [authorityProjection],
  );
  const live = session?.status === "ready" && observation !== undefined;
  // Read-only catalog/stat responses are owner-fenced but are not canonical
  // semantic projections. Keeping this observation stable across heartbeat
  // cursor advances prevents slow SDK reads from being restarted forever.
  const readHostInstanceId = observation?.owner.hostInstanceId;
  const readSessionEpoch = observation?.owner.sessionEpoch;
  const readObservation = useMemo<AuthorityObservation | undefined>(
    () =>
      readHostInstanceId !== undefined && readSessionEpoch !== undefined
        ? { owner: { hostInstanceId: readHostInstanceId, sessionEpoch: readSessionEpoch } }
        : undefined,
    [readHostInstanceId, readSessionEpoch],
  );

  useEffect(() => {
    if (!live || !readObservation) return;
    void querySession(sessionId, { type: "get_available_models" }, readObservation)
      .then((result) => {
        if (
          result.status !== "ok" ||
          !result.response.success ||
          !sameOwner(result.owner, readObservation.owner) ||
          !observationOwnerIsCurrent(sessionId, readObservation)
        )
          return;
        const raw = result.response.data as { models?: unknown[] } | undefined;
        const models = (raw?.models ?? [])
          .map((model) => {
            const parsed = ModelInfoSchema.safeParse(model);
            return parsed.success ? parsed.data : null;
          })
          .filter((model): model is ModelInfo => model !== null);
        useSessionsStore.getState().setAvailableModels(sessionId, models);
      })
      .catch(() => {});
  }, [sessionId, live, readObservation]);

  // Poll stats after each agent_end and periodically while streaming. Queries
  // carry the observed cursor and only write their result while it remains the
  // current semantic owner/cursor.
  const fetchStats = useCallback(
    (capturedObservation: AuthorityObservation) => {
      void querySession(sessionId, { type: "get_session_stats" }, capturedObservation)
        .then((result) => {
          if (
            result.status !== "ok" ||
            !result.response.success ||
            !sameOwner(result.owner, capturedObservation.owner) ||
            !observationOwnerIsCurrent(sessionId, capturedObservation)
          ) {
            return;
          }
          const parsed = SessionStatsSchema.safeParse(result.response.data);
          if (!parsed.success) return;
          const stats = parsed.data as SessionStats;
          setStats(sessionId, stats);
          if (stats.sessionFile) setSessionFile(sessionId, stats.sessionFile);
        })
        .catch(() => {});
    },
    [sessionId, setSessionFile, setStats],
  );

  useEffect(() => {
    if (!live || !readObservation) return;
    fetchStats(readObservation);
    const interval = setInterval(() => fetchStats(readObservation), 60_000);
    return () => clearInterval(interval);
  }, [fetchStats, live, readObservation]);

  useEffect(() => {
    return window.pivis.on("session.events", ({ sessionId: sid, events }) => {
      if (
        sid === sessionId &&
        events.some((event) => event.type === "agent_end") &&
        readObservation
      ) {
        fetchStats(readObservation);
      }
    });
  }, [fetchStats, readObservation, sessionId]);

  // The model + thinking pickers (and their handlers) live in
  // <SessionControls> — this component only owns the name, the worktree chip,
  // the data-loading effects, and the compact-mode reflow.

  const handleRenameStart = useCallback(() => {
    if (!observation) return;
    setNameInput(session?.sessionName ?? session?.sessionTitle ?? "");
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 10);
  }, [observation, session]);

  const handleRenameConfirm = useCallback(async () => {
    const name = nameInput.trim();
    if (!name || !observation) {
      setEditingName(false);
      return;
    }
    const intentId = crypto.randomUUID();
    setPendingRename({ intentId, value: name });
    setEditingName(false);
    try {
      const receipt = await dispatchSessionIntent(
        sessionId,
        { kind: "rename", name },
        observation,
        intentId,
      );
      // A receipt acknowledges delivery/admission only. It never changes the
      // displayed canonical name; that arrives in a semantic authority frame.
      if (receipt.status === "not_admitted") {
        setPendingRename((pending) => (pending?.intentId === intentId ? null : pending));
        useSessionsStore
          .getState()
          .addToast(sessionId, `Failed to rename session: ${receipt.reason}`, "error");
      }
    } catch {
      // Dispatch may have crossed the transport boundary. Keep the request
      // visibly pending until a frame settles it rather than guessing failure.
    }
  }, [nameInput, observation, sessionId]);

  useEffect(() => {
    if (!pendingRename || !observation) return;
    const outcome = session?.authorityProjection?.authoritativeSnapshot?.recentIntentOutcomes.find(
      (candidate) => candidate.intentId === pendingRename.intentId,
    );
    if (!outcome) return;
    setPendingRename(null);
    if (outcome.state === "completed") {
      if (session?.workspacePath) void refreshWorkspaceSessions(session.workspacePath);
    } else {
      useSessionsStore
        .getState()
        .addToast(
          sessionId,
          `Failed to rename session: ${outcome.error ?? outcome.state}`,
          "error",
        );
    }
  }, [observation, pendingRename, refreshWorkspaceSessions, session, sessionId]);

  // ── Compact mode (responsive reflow) ───────────────────────────────
  const headerRef = useRef<HTMLDivElement>(null);
  const setHeaderCompact = useSessionsStore((s) => s.setHeaderCompact);
  const compact = useSessionsStore((s) => s.headerCompact);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Reflow the secondary controls into the SessionSubBar once the header
        // can't hold the name + the full controls cluster. The cluster maxes
        // out around ~540px (capped model id + longest thinking label + token
        // stats); 560 keeps a margin so nothing clips at the boundary. The
        // header's own `min-width: 0` (SessionHeader.css) is what makes this
        // measure the *available* width rather than the content-overflow width.
        const w = entry.contentRect.width;
        setHeaderCompact(w < 560);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setHeaderCompact]);

  return (
    <div className="session-header" ref={headerRef}>
      {/* Primary row: name on the left; worktree + controls on the right. */}
      <div className="session-header__primary">
        <div className="session-header__name">
          {editingName ? (
            <input
              ref={nameInputRef}
              className="session-header__name-input"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={() => void handleRenameConfirm()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleRenameConfirm();
                if (e.key === "Escape") setEditingName(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="session-header__name-btn fade-scope"
              onClick={handleRenameStart}
              disabled={!observation}
              title={
                session?.piVersion
                  ? `${session?.sessionName ?? session?.sessionTitle ?? "Untitled session"} · pi ${session.piVersion}`
                  : (session?.sessionName ?? session?.sessionTitle ?? "Untitled session")
              }
            >
              <FadeText>
                {session?.sessionName ?? session?.sessionTitle ?? "Untitled session"}
              </FadeText>
              {pendingRename && <span className="session-header__pending">Renaming…</span>}
            </button>
          )}
        </div>

        <WorktreeSwitcher sessionId={sessionId} />
        {!compact && <SessionControls sessionId={sessionId} />}
        <NotificationBellButton sessionId={sessionId} />
      </div>
    </div>
  );
}

/**
 * The secondary controls cluster — rendered in the title bar (wide) or
 * in SessionSubBar (compact). Extracted so the same JSX renders in
 * either position.
 */
export function SessionControls({
  sessionId,
}: {
  sessionId: SessionId;
}): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const addToast = useSessionsStore((s) => s.addToast);
  const groupModelsByProvider = useSettingsStore((s) => s.settings.groupModelsByProvider);
  const observation = observationForSession(session);
  const semanticSnapshot = session?.authorityProjection?.authoritativeSnapshot;
  // Semantic authority still gates every interaction via `observation`, but
  // retained compatibility fields keep the last-known presentation stable
  // while a fenced plane awaits its next baseline.
  const currentModel = semanticSnapshot?.model?.id ?? session?.currentModel;
  const currentProvider = semanticSnapshot?.model?.provider ?? session?.currentProvider;
  const currentThinkingLevel = semanticSnapshot?.thinkingLevel ?? session?.thinkingLevel;
  const [pendingModel, setPendingModel] = useState<PendingIntent<ModelInfo> | null>(null);
  const [pendingThinking, setPendingThinking] = useState<PendingIntent<ThinkingLevel> | null>(null);

  // ── Model picker state ────────────────────────────────────────────
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [activeProviderKey, setActiveProviderKey] = useState<string | null>(null);
  const [groupedHighlight, setGroupedHighlight] = useState<GroupedModelHighlight | null>(null);
  const modelHighlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  const filteredModels = useMemo(() => {
    const q = modelSearch.toLowerCase();
    return (session?.availableModels ?? []).filter((m) => {
      if (!q) return true;
      const label = m.name ?? m.id;
      return (
        label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.provider ?? "").toLowerCase().includes(q)
      );
    });
  }, [session?.availableModels, modelSearch]);

  const providerGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; models: ModelInfo[] }>();
    for (const model of session?.availableModels ?? []) {
      const key = model.provider ?? "";
      const label = model.provider ?? "Other";
      const existing = groups.get(key);
      if (existing) {
        existing.models.push(model);
      } else {
        groups.set(key, { key, label, models: [model] });
      }
    }
    return [...groups.values()];
  }, [session?.availableModels]);

  const showProviderGroups =
    groupModelsByProvider && modelSearch.trim().length === 0 && providerGroups.length > 0;

  const groupedKeyboardItems = useMemo<GroupedModelKeyboardItem[]>(() => {
    const items: GroupedModelKeyboardItem[] = [];
    for (const group of providerGroups) {
      items.push({ type: "provider", providerKey: group.key });
      if (activeProviderKey === group.key) {
        for (const model of group.models) {
          items.push({ type: "model", providerKey: group.key, modelKey: modelKey(model), model });
        }
      }
    }
    return items;
  }, [activeProviderKey, providerGroups]);

  useEffect(() => {
    if (!modelOpen) {
      setModelSearch("");
      modelHighlightSourceRef.current = "programmatic";
      setHighlightedIndex(0);
      setGroupedHighlight(null);
      return;
    }
    setModelSearch("");
    modelHighlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
    setActiveProviderKey(null);
    setGroupedHighlight(null);
    setTimeout(() => searchInputRef.current?.focus(), 10);
  }, [modelOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on search value
  useEffect(() => {
    modelHighlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [modelSearch]);

  useEffect(() => {
    if (!modelOpen || !showProviderGroups) return;
    setActiveProviderKey((current) =>
      current && providerGroups.some((group) => group.key === current) ? current : null,
    );
    setGroupedHighlight((current) => {
      if (!current) return null;
      const group = providerGroups.find((candidate) => candidate.key === current.providerKey);
      if (!group) return null;
      if (current.type === "provider") return current;
      if (activeProviderKey !== current.providerKey) return null;
      return group.models.some((model) => modelKey(model) === current.modelKey) ? current : null;
    });
  }, [activeProviderKey, modelOpen, providerGroups, showProviderGroups]);

  const modelVirtualList = useVirtualList<HTMLDivElement>({
    count: filteredModels.length,
    rowHeight: 34,
    minOverscan: 32,
    overscanScreens: 2,
  });

  useEffect(() => {
    modelHighlightSourceRef.current = "programmatic";
    setHighlightedIndex((i) =>
      filteredModels.length === 0 ? 0 : Math.min(i, filteredModels.length - 1),
    );
  }, [filteredModels.length]);

  useEffect(() => {
    if (!modelOpen || showProviderGroups) return;
    // Hover should update only the visual highlight; keyboard/programmatic
    // navigation is the only path that should scroll the dropdown.
    if (modelHighlightSourceRef.current === "pointer") return;
    modelVirtualList.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, modelOpen, modelVirtualList.ensureIndexVisible, showProviderGroups]);

  useEffect(() => {
    if (!modelOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!modelPickerRef.current?.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [modelOpen]);

  const handleModelChange = useCallback(
    async (model: ModelInfo) => {
      setModelOpen(false);
      if (!observation) return;
      const intentId = crypto.randomUUID();
      setPendingModel({ intentId, value: model });
      try {
        const receipt = await dispatchSessionIntent(
          sessionId,
          {
            kind: "setModel",
            ...(model.provider ? { provider: model.provider } : { provider: "" }),
            modelId: model.id,
          },
          observation,
          intentId,
        );
        // Do not update the current model or preferences from a receipt. The
        // semantic frame is the only canonical confirmation.
        if (receipt.status === "not_admitted") {
          setPendingModel((pending) => (pending?.intentId === intentId ? null : pending));
          addToast(sessionId, `Failed to set model: ${receipt.reason}`, "error");
        }
      } catch {
        // Possible post-dispatch loss remains pending until authority reports
        // its terminal outcome (or outcome_unknown).
      }
    },
    [addToast, observation, sessionId],
  );

  const activateGroupedKeyboardItem = useCallback((item: GroupedModelKeyboardItem): void => {
    setGroupedHighlight(
      item.type === "provider"
        ? { type: "provider", providerKey: item.providerKey }
        : { type: "model", providerKey: item.providerKey, modelKey: item.modelKey },
    );
    setActiveProviderKey(item.providerKey);
  }, []);

  const moveGroupedHighlight = useCallback(
    (delta: -1 | 1): void => {
      if (groupedKeyboardItems.length === 0) return;
      const currentIndex = groupedKeyboardItems.findIndex((item) => {
        if (!groupedHighlight) return false;
        if (
          item.type !== groupedHighlight.type ||
          item.providerKey !== groupedHighlight.providerKey
        ) {
          return false;
        }
        if (groupedHighlight.type === "provider") return true;
        return item.type === "model" && item.modelKey === groupedHighlight.modelKey;
      });
      const nextIndex =
        currentIndex === -1
          ? delta > 0
            ? 0
            : groupedKeyboardItems.length - 1
          : (currentIndex + delta + groupedKeyboardItems.length) % groupedKeyboardItems.length;
      activateGroupedKeyboardItem(groupedKeyboardItems[nextIndex]!);
    },
    [activateGroupedKeyboardItem, groupedHighlight, groupedKeyboardItems],
  );

  const chooseGroupedHighlight = useCallback((): void => {
    if (groupedKeyboardItems.length === 0) return;
    const currentItem = groupedKeyboardItems.find((item) => {
      if (!groupedHighlight) return false;
      if (
        item.type !== groupedHighlight.type ||
        item.providerKey !== groupedHighlight.providerKey
      ) {
        return false;
      }
      if (groupedHighlight.type === "provider") return true;
      return item.type === "model" && item.modelKey === groupedHighlight.modelKey;
    });
    const item = currentItem ?? groupedKeyboardItems[0];
    if (!item) return;
    if (item.type === "model" && item.model) {
      void handleModelChange(item.model);
      return;
    }
    const group = providerGroups.find((candidate) => candidate.key === item.providerKey);
    const firstModel = group?.models[0];
    if (firstModel) {
      void handleModelChange(firstModel);
    }
  }, [groupedHighlight, groupedKeyboardItems, handleModelChange, providerGroups]);

  // ── Thinking level picker state ───────────────────────────────────
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const thinkingPickerRef = useRef<HTMLDivElement>(null);

  // Claim ESC while either the model or thinking dropdown is open so a
  // background streaming session isn't aborted (each dropdown's own
  // outside-click / Escape handling closes it).
  useEscapeClaim(modelOpen || thinkingOpen);

  useLayoutEffect(() => {
    if (!modelOpen && !thinkingOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      // Preserve the model search field's two-step Escape behavior even if a
      // background runtime update briefly moved focus away from the search:
      // non-empty search clears first; only the next Escape closes.
      if (modelOpen && modelSearch) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setModelSearch("");
        queueMicrotask(() => searchInputRef.current?.focus());
        return;
      }
      // The focused input handles the same branch itself. React's
      // preventDefault reaches this native bubble listener.
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setModelOpen(false);
      setThinkingOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modelOpen, modelSearch, thinkingOpen]);

  const currentModelInfo = useMemo<ModelInfo | undefined>(
    () => findCurrentModel(session?.availableModels ?? [], currentModel, currentProvider),
    [currentModel, currentProvider, session?.availableModels],
  );
  // Button label: the active model's name with its provider in brackets
  // (mirrors pi's TUI "glm-5.2 [zai]"), so when the same model id is offered
  // by several providers the user can see which subscription/API is in use.
  const canonicalModel = semanticSnapshot?.model ?? session?.runtimeSnapshot?.model;
  const modelButtonLabel = currentModelInfo
    ? modelDisplayName(currentModelInfo)
    : canonicalModel?.name
      ? `${canonicalModel.name}${canonicalModel.provider ? ` [${canonicalModel.provider}]` : ""}`
      : currentModel
        ? `${currentModel}${currentProvider ? ` [${currentProvider}]` : ""}`
        : "model";
  const thinkingOptions = useMemo(
    () => thinkingLevelsForModel(currentModelInfo),
    [currentModelInfo],
  );
  const thinkingDisabled = thinkingOptions.length <= 1;

  const handleThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      setThinkingOpen(false);
      if (!observation) return;
      const intentId = crypto.randomUUID();
      setPendingThinking({ intentId, value: level });
      try {
        const receipt = await dispatchSessionIntent(
          sessionId,
          { kind: "setThinking", level },
          observation,
          intentId,
        );
        if (receipt.status === "not_admitted") {
          setPendingThinking((pending) => (pending?.intentId === intentId ? null : pending));
          addToast(sessionId, `Failed to set thinking level: ${receipt.reason}`, "error");
        }
      } catch {
        // Keep a possible dispatch visible until its authority-frame outcome.
      }
    },
    [addToast, observation, sessionId],
  );

  useEffect(() => {
    const outcomes = semanticSnapshot?.recentIntentOutcomes;
    if (!outcomes) return;
    if (pendingModel) {
      const outcome = outcomes.find((candidate) => candidate.intentId === pendingModel.intentId);
      if (outcome) {
        setPendingModel(null);
        if (outcome.state === "completed") {
          // Persist only after an authority frame confirms completion; the
          // receipt is deliberately not completion evidence.
          const confirmed = semanticSnapshot?.model;
          if (confirmed?.id) {
            void useSettingsStore.getState().update({
              lastUsedModel: {
                ...(confirmed.provider ? { provider: confirmed.provider } : {}),
                modelId: confirmed.id,
              },
            });
          }
        } else {
          addToast(sessionId, `Failed to set model: ${outcome.error ?? outcome.state}`, "error");
        }
      }
    }
    if (pendingThinking) {
      const outcome = outcomes.find((candidate) => candidate.intentId === pendingThinking.intentId);
      if (outcome) {
        setPendingThinking(null);
        if (outcome.state === "completed") {
          const confirmed = semanticSnapshot?.thinkingLevel;
          if (confirmed) {
            void useSettingsStore.getState().update({ lastUsedThinkingLevel: confirmed });
            if (confirmed !== pendingThinking.value) {
              addToast(
                sessionId,
                `Model does not support thinking level: ${pendingThinking.value} — using ${confirmed} instead.`,
                "warning",
              );
            }
          }
        } else {
          addToast(
            sessionId,
            `Failed to set thinking level: ${outcome.error ?? outcome.state}`,
            "error",
          );
        }
      }
    }
  }, [addToast, pendingModel, pendingThinking, semanticSnapshot, sessionId]);

  useEffect(() => {
    if (!thinkingOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!thinkingPickerRef.current?.contains(e.target as Node)) {
        setThinkingOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [thinkingOpen]);

  const highlightMatch = useCallback((text: string, query: string): React.ReactNode => {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="session-header__match">{text.slice(idx, idx + query.length)}</mark>
        {text.slice(idx + query.length)}
      </>
    );
  }, []);

  return (
    <div className="session-header__controls">
      {/* Unified-TUI view toggle — shown only while a factory `setWidget` panel is live.
          Placed in the right-side controls cluster after the worktree chip (when present)
          and before the changes button. Uses text labels "Extension" and "Input" for clarity. */}
      {session?.unifiedPanel && (
        <UnifiedViewToggle sessionId={sessionId} extensionLabel="Extension" inputLabel="Input" />
      )}
      <ChangesButton sessionId={sessionId} />
      {/* Model picker */}
      <div className="session-header__model-picker" ref={modelPickerRef}>
        <button
          type="button"
          className="session-header__picker-btn session-header__model-btn fade-scope"
          onClick={() => setModelOpen((v) => !v)}
          disabled={!observation}
          title={pendingModel ? `${modelButtonLabel} · change pending` : modelButtonLabel}
        >
          <FadeText className="session-header__picker-label">{modelButtonLabel}</FadeText>
          {pendingModel && <span className="session-header__pending">Pending…</span>}
          <IconChevronDown className="session-header__caret" />
        </button>
        {modelOpen && (
          <div
            className={`session-header__dropdown${showProviderGroups ? " session-header__dropdown--providers" : ""}`}
          >
            <div className="session-header__dropdown-search">
              <input
                ref={searchInputRef}
                className="session-header__dropdown-search-input"
                placeholder="Search models…"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                onKeyDown={(e) => {
                  switch (e.key) {
                    case "Escape":
                      // Read the input's current DOM value so a rapid
                      // fill/type→Escape cannot observe a stale React closure
                      // and close the entire picker instead of clearing first.
                      if (e.currentTarget.value) {
                        setModelSearch("");
                      } else {
                        setModelOpen(false);
                      }
                      e.preventDefault();
                      e.stopPropagation();
                      break;
                    case "ArrowDown":
                      e.preventDefault();
                      modelHighlightSourceRef.current = "keyboard";
                      if (showProviderGroups) {
                        moveGroupedHighlight(1);
                      } else {
                        setHighlightedIndex((i) => (i < filteredModels.length - 1 ? i + 1 : 0));
                      }
                      break;
                    case "ArrowUp":
                      e.preventDefault();
                      modelHighlightSourceRef.current = "keyboard";
                      if (showProviderGroups) {
                        moveGroupedHighlight(-1);
                      } else {
                        setHighlightedIndex((i) => (i > 0 ? i - 1 : filteredModels.length - 1));
                      }
                      break;
                    case "Home":
                      e.preventDefault();
                      modelHighlightSourceRef.current = "keyboard";
                      if (showProviderGroups) {
                        const firstItem = groupedKeyboardItems[0];
                        if (firstItem) activateGroupedKeyboardItem(firstItem);
                      } else {
                        setHighlightedIndex(0);
                      }
                      break;
                    case "End":
                      e.preventDefault();
                      modelHighlightSourceRef.current = "keyboard";
                      if (showProviderGroups) {
                        const lastItem = groupedKeyboardItems[groupedKeyboardItems.length - 1];
                        if (lastItem) activateGroupedKeyboardItem(lastItem);
                      } else {
                        setHighlightedIndex(filteredModels.length - 1);
                      }
                      break;
                    case "Enter":
                      e.preventDefault();
                      if (showProviderGroups) {
                        chooseGroupedHighlight();
                        return;
                      }
                      if (filteredModels[highlightedIndex]) {
                        void handleModelChange(filteredModels[highlightedIndex]);
                      }
                      break;
                  }
                }}
                role="combobox"
                aria-expanded={modelOpen}
                aria-controls="model-listbox"
                aria-activedescendant={
                  !showProviderGroups && filteredModels.length > 0
                    ? `model-option-${highlightedIndex}`
                    : undefined
                }
                aria-autocomplete="list"
              />
            </div>
            {showProviderGroups ? (
              <div className="session-header__provider-menu">
                <div
                  role="listbox"
                  id="model-listbox"
                  className="session-header__dropdown-list session-header__provider-list"
                >
                  {providerGroups.map((group) => {
                    const active = group.key === activeProviderKey;
                    const providerHighlighted =
                      groupedHighlight?.type === "provider" &&
                      groupedHighlight.providerKey === group.key;
                    const selected = group.models.some(
                      (model) =>
                        currentModelInfo != null && modelKey(model) === modelKey(currentModelInfo),
                    );
                    return (
                      <div key={group.key} className="session-header__provider-group">
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          aria-expanded={active}
                          className={`session-header__dropdown-item session-header__provider-item${providerHighlighted ? " session-header__dropdown-item--highlighted" : ""}${selected ? " session-header__dropdown-item--active" : ""}`}
                          onClick={() => {
                            setGroupedHighlight({ type: "provider", providerKey: group.key });
                            setActiveProviderKey(active ? null : group.key);
                          }}
                          onMouseEnter={() => {
                            setGroupedHighlight({ type: "provider", providerKey: group.key });
                          }}
                        >
                          <span className="session-header__dropdown-item-check" aria-hidden>
                            {selected ? <IconCheck /> : null}
                          </span>
                          <span className="session-header__dropdown-item-label" title={group.label}>
                            {group.label}
                          </span>
                          <span className="session-header__provider-count">
                            {group.models.length.toLocaleString()}
                          </span>
                          <IconChevronDown className="session-header__provider-caret" />
                        </button>
                        {active && (
                          <div className="session-header__provider-model-list" role="group">
                            {group.models.map((m) => {
                              const label = modelDisplayName(m);
                              const key = modelKey(m);
                              const modelSelected =
                                currentModelInfo != null && key === modelKey(currentModelInfo);
                              const modelHighlighted =
                                groupedHighlight?.type === "model" &&
                                groupedHighlight.modelKey === key;
                              return (
                                <button
                                  type="button"
                                  key={key}
                                  role="option"
                                  aria-selected={modelSelected}
                                  className={`session-header__dropdown-item session-header__provider-model-item fade-scope${modelHighlighted ? " session-header__dropdown-item--highlighted" : ""}${modelSelected ? " session-header__dropdown-item--active" : ""}`}
                                  onClick={() => void handleModelChange(m)}
                                  onMouseEnter={() => {
                                    setGroupedHighlight({
                                      type: "model",
                                      providerKey: group.key,
                                      modelKey: key,
                                    });
                                  }}
                                >
                                  <span className="session-header__dropdown-item-check" aria-hidden>
                                    {modelSelected ? <IconCheck /> : null}
                                  </span>
                                  <span
                                    className="session-header__dropdown-item-label"
                                    title={label}
                                  >
                                    {label}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="session-header__dropdown-empty">No models found</div>
            ) : (
              <div
                ref={modelVirtualList.containerRef}
                onScroll={modelVirtualList.onScroll}
                role="listbox"
                id="model-listbox"
                className="session-header__dropdown-list session-header__dropdown-list--virtual"
              >
                <div
                  className="session-header__virtual-spacer"
                  style={{ height: modelVirtualList.totalHeight }}
                >
                  <div
                    className="session-header__virtual-window"
                    style={{ transform: `translateY(${modelVirtualList.offsetY}px)` }}
                  >
                    {modelVirtualList.rows.map(({ index: idx }) => {
                      const m = filteredModels[idx];
                      if (!m) return null;
                      const label = modelDisplayName(m);
                      const q = modelSearch;
                      const active = idx === highlightedIndex;
                      // Compare against the single resolved current entry by key
                      // (not per-item id matching) so that when the provider is
                      // unknown and duplicate same-id entries exist, at most ONE
                      // row highlights instead of every same-id copy getting a ✓.
                      const selected =
                        currentModelInfo != null && modelKey(m) === modelKey(currentModelInfo);
                      return (
                        <button
                          type="button"
                          key={modelKey(m)}
                          id={`model-option-${idx}`}
                          role="option"
                          aria-selected={selected}
                          className={`session-header__dropdown-item fade-scope${active ? " session-header__dropdown-item--highlighted" : ""}${selected ? " session-header__dropdown-item--active" : ""}`}
                          onClick={() => void handleModelChange(m)}
                          onMouseEnter={() => {
                            modelHighlightSourceRef.current = "pointer";
                            setHighlightedIndex(idx);
                          }}
                        >
                          <span className="session-header__dropdown-item-check" aria-hidden>
                            {selected ? <IconCheck /> : null}
                          </span>
                          <span className="session-header__dropdown-item-label" title={label}>
                            {q ? highlightMatch(label, q) : label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Thinking level — custom dropdown so its popup uses the
          Catppuccin surface like the model selector, and its line-height
          can accommodate descenders ('g' in "high") without clipping. */}
      <div className="session-header__thinking" ref={thinkingPickerRef}>
        <button
          type="button"
          className="session-header__picker-btn"
          onClick={() => setThinkingOpen((v) => !v)}
          disabled={thinkingDisabled || !observation}
          title={
            currentModelInfo?.reasoning === false
              ? "Current model does not support reasoning."
              : undefined
          }
        >
          <span>{currentThinkingLevel ?? "off"}</span>
          {pendingThinking && <span className="session-header__pending">Pending…</span>}
          <IconChevronDown className="session-header__caret" />
        </button>
        {thinkingOpen && !thinkingDisabled && (
          <div className="session-header__dropdown">
            <div className="session-header__dropdown-list">
              {thinkingOptions.map((l) => {
                const selected = currentThinkingLevel === l;
                return (
                  <button
                    type="button"
                    key={l}
                    role="option"
                    aria-selected={selected}
                    className={`session-header__dropdown-item${selected ? " session-header__dropdown-item--active" : ""}`}
                    onClick={() => {
                      void handleThinkingLevel(l);
                      setThinkingOpen(false);
                    }}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Context ring — click for a usage breakdown dropdown. */}
      <ContextMeter sessionId={sessionId} />
    </div>
  );
}

// ── Changes button (WP5a) ──────────────────────────────────────────
//
// Mirrors the existing agent_end → stats refresh pattern. Renders a
// ghost button matching the model/thinking picker style with a live
// badge showing the changed-file count, or just `±` dimmed when the
// working tree is clean.
function ChangesButton({ sessionId }: { sessionId: SessionId }): React.ReactElement | null {
  const live = useSessionsStore((s) => {
    const st = s.sessions.get(sessionId)?.status;
    return st === "ready" || st === "starting";
  });
  // The git root (worktree path when present, else workspace path). Derived
  // via a selector so the effect can depend on the primitive root directly
  // rather than the whole session object.
  const root = useSessionsStore((s) => {
    const sess = s.sessions.get(sessionId);
    return sess ? gitRootForSession(sess) : undefined;
  });
  const badge = useDiffStore((s) => s.badge);
  const badgeKind = useDiffStore((s) => s.badgeKind);
  const refreshBadge = useDiffStore((s) => s.refreshBadge);

  // Refresh on session live, agent_end, every tool call, and window
  // focus. Refreshing after each tool_execution_end keeps the changed-file
  // count live as the agent edits files; refreshBadge is debounced so a
  // burst of tool calls collapses into one git invocation. Mirrors the
  // existing stats effect in this file.
  useEffect(() => {
    if (!live || !root) return;
    void refreshBadge(root);

    const unsubEvent = window.pivis.on("session.events", ({ sessionId: sid, events }) => {
      if (sid !== sessionId) return;
      if (
        events.some((event) => event.type === "agent_end" || event.type === "tool_execution_end")
      ) {
        void refreshBadge(root);
      }
    });
    const onFocus = (): void => {
      void refreshBadge(root);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      unsubEvent();
      window.removeEventListener("focus", onFocus);
    };
  }, [live, root, sessionId, refreshBadge]);

  // Don't render when the workspace is not a repo (badge resolved
  // "not-a-repo" or "git-missing") or when the badge is still loading.
  if (badgeKind === "not-a-repo" || badgeKind === "git-missing") return null;
  if (badge === null) return null;

  const hasChanges = badge.fileCount > 0;
  const countLabel = badge.truncated
    ? `>${(badge.fileCount - 1).toLocaleString()}`
    : badge.fileCount.toLocaleString();
  return (
    <button
      type="button"
      className={`session-header__picker-btn session-header__changes-btn${hasChanges ? "" : " session-header__changes-btn--clean"}`}
      onClick={() => openDiffForSession(sessionId)}
      title="View changes (⌘G)"
      aria-label="View changes"
      data-testid="changes-button"
    >
      <span aria-hidden>±</span>
      {hasChanges && <span className="session-header__changes-count">{countLabel}</span>}
    </button>
  );
}

import type { SessionId } from "@shared/ids.js";
import type { SessionSummary } from "@shared/ipc-contract.js";
import type { ProjectTrustOption } from "@shared/pi-protocol/commands.js";
import type { LoginProvider, ModelInfo } from "@shared/pi-protocol/responses.js";
import type { IntentOutcome, RuntimeIdentity } from "@shared/pi-protocol/runtime-state.js";
import type { ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useVirtualList } from "../../hooks/useVirtualList.js";
import type { PickerRequest } from "../../lib/commands/execute.js";
import { findCurrentModel, modelDisplayName, modelKey } from "../../lib/model-utils.js";
import { dispatchSessionIntent } from "../../lib/session-intent.js";
import {
  authoritySnapshotFor,
  sessionMatchesRuntime,
  useSessionsStore,
} from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";
import { ScrollFadeFrame } from "../common/ScrollFadeFrame.js";
import { IconCheck } from "../common/icons.js";
import "./AppPickerHost.css";

interface PickerHostProps {
  sessionId: SessionId;
}

interface PickerActivation {
  pending: boolean;
}

// This is keyed by the store-owned request object, not by a React mount. A
// session switch may unmount and remount the same picker after delivery became
// uncertain; that must not create a second activation opportunity.
const pickerActivations = new WeakMap<PickerRequest, PickerActivation>();

function activationForPicker(picker: PickerRequest): PickerActivation {
  const existing = pickerActivations.get(picker);
  if (existing) return existing;
  const created = { pending: false };
  pickerActivations.set(picker, created);
  return created;
}

function findPickerIntentOutcome(
  sessionId: SessionId,
  intentId: string,
  owner: RuntimeIdentity,
): IntentOutcome | undefined {
  return useSessionsStore
    .getState()
    .sessions.get(sessionId)
    ?.authorityProjection?.authoritativeSnapshot?.recentIntentOutcomes.find(
      (outcome) =>
        outcome.intentId === intentId &&
        outcome.owner.hostInstanceId === owner.hostInstanceId &&
        outcome.owner.sessionEpoch === owner.sessionEpoch,
    );
}

function waitForPickerIntentOutcome(
  sessionId: SessionId,
  intentId: string,
  owner: RuntimeIdentity,
  timeoutMs = 10_000,
): Promise<IntentOutcome> {
  const immediate = findPickerIntentOutcome(sessionId, intentId, owner);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      operation();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Timed out waiting for the selection to finish."))),
      timeoutMs,
    );
    unsubscribe = useSessionsStore.subscribe(() => {
      const outcome = findPickerIntentOutcome(sessionId, intentId, owner);
      if (outcome) {
        finish(() => resolve(outcome));
        return;
      }
      if (!sessionMatchesRuntime(useSessionsStore.getState().sessions.get(sessionId), owner)) {
        finish(() => reject(new Error("Session changed before the selection completed.")));
      }
    });
  });
}

/**
 * AppPickerHost — built-in pickers for /model, /thinking, /fork, /resume.
 *
 * Why a separate host from ExtensionDialogHost?
 *   - Extension dialogs come from the wire and use the request/response
 *     RPC protocol. Built-in pickers are local UI: the executor decides
 *     which picker to open (via store.openPicker) and the host renders it.
 *   - Extension dialogs queue; built-in pickers are single-slot (a
 *     subsequent /model replaces an open model picker).
 *   - Extension dialogs can have a server-side timeout; built-in pickers
 *     have no timeout — the user is the one driving the choice.
 *
 * The picker replaces the Composer in the flex slot (same in-place
 * treatment as ExtensionDialogHost and CustomPanelHost) rather than
 * opening as a modal scrim. The slot is invisible chrome (transparent,
 * no top border, matching the Composer's outer treatment) and the inner
 * `.picker` card mirrors the Composer's surface0 / border / radius —
 * so the layout doesn't shift when a picker opens. The transcript
 * above stays scrollable, the session header stays clickable, and the
 * diff viewer (Cmd+G) still works while a picker is open.
 *
 * The host is mounted in place of the Composer by App.tsx when a
 * picker is pending, so the Composer and the picker are never both
 * visible.
 *
 * The model picker mirrors SessionHeader's dropdown behaviour: same
 * search/highlight/keyboard pattern, but standalone (we deliberately do
 * not programmatically open the header dropdown — its anchor sits on the
 * header bar and wouldn't be in the right place when /model is invoked
 * from the composer).
 */
export function AppPickerHost({ sessionId }: PickerHostProps): React.ReactElement | null {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const picker = session?.pendingPicker;
  const closePicker = useSessionsStore((s) => s.closePicker);
  const addToast = useSessionsStore((s) => s.addToast);
  const openSessionTab = useSessionsStore((s) => s.openSessionTab);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const requestComposerFocus = useSessionsStore((s) => s.requestComposerFocus);

  // Claim ESC while any picker is open so a background streaming session
  // isn't aborted (the picker's own ESC handler closes it).
  useEscapeClaim(!!picker);

  if (!picker) return null;
  const pickerActivation = activationForPicker(picker);
  const pickerRuntime =
    picker.expectedHostInstanceId && picker.expectedSessionEpoch !== undefined
      ? {
          hostInstanceId: picker.expectedHostInstanceId,
          sessionEpoch: picker.expectedSessionEpoch,
        }
      : undefined;
  const pickerCursor = (() => {
    const semantic = useSessionsStore.getState().sessions.get(sessionId)
      ?.authorityProjection?.semantic;
    return semantic?.state === "following" &&
      semantic.cursor.hostInstanceId === pickerRuntime?.hostInstanceId &&
      semantic.cursor.sessionEpoch === pickerRuntime.sessionEpoch
      ? semantic.cursor
      : undefined;
  })();
  const requirePickerObservation = () => {
    if (!pickerRuntime) throw new Error("Picker has no originating runtime identity");
    return { owner: pickerRuntime, ...(pickerCursor ? { cursor: pickerCursor } : {}) };
  };
  const pickerSlotIsCurrent = () =>
    useSessionsStore.getState().sessions.get(sessionId)?.pendingPicker === picker;
  const beginPickerAction = (): boolean => {
    if (!pickerSlotIsCurrent() || pickerActivation.pending) return false;
    pickerActivation.pending = true;
    return true;
  };
  const allowPickerRetry = (): void => {
    if (pickerSlotIsCurrent()) pickerActivation.pending = false;
  };
  const pickerRuntimeIsCurrent = () => {
    const current = useSessionsStore.getState().sessions.get(sessionId);
    return (
      pickerRuntime !== undefined &&
      pickerSlotIsCurrent() &&
      sessionMatchesRuntime(current, pickerRuntime)
    );
  };

  // The picker sub-components are mounted when a picker is active. They
  // each receive the same close-on-cancel pattern.
  return (
    <div className="picker-slot" role="dialog" aria-label="Picker">
      {picker.kind === "model" && (
        <ModelPicker
          sessionId={sessionId}
          {...(picker.search !== undefined ? { search: picker.search } : {})}
          onClose={() => closePicker(sessionId)}
          onPick={async (model, persist = false) => {
            if (!beginPickerAction()) return;
            try {
              const observation = requirePickerObservation();
              const receipt = await dispatchSessionIntent(
                sessionId,
                {
                  kind: "setModel",
                  provider: model.provider ?? "",
                  modelId: model.id,
                  ...(persist ? { persist: true } : {}),
                },
                observation,
              );
              if (!pickerRuntimeIsCurrent()) return;
              if (receipt.status === "not_admitted") {
                allowPickerRetry();
                addToast(sessionId, "Failed to request model change", "error");
                return;
              }
              if (receipt.status === "delivery_unknown") {
                addToast(
                  sessionId,
                  "Model-change delivery is unknown; verify before retrying",
                  "error",
                );
                return;
              }
              const outcome = await waitForPickerIntentOutcome(
                sessionId,
                receipt.intentId,
                observation.owner,
              );
              if (!pickerRuntimeIsCurrent()) return;
              if (outcome.kind !== "setModel" || outcome.state !== "completed") {
                if (outcome.state === "rejected") allowPickerRetry();
                addToast(sessionId, outcome.error ?? "The model could not be changed.", "error");
                return;
              }
              closePicker(sessionId);
            } catch {
              if (!pickerRuntimeIsCurrent()) return;
              addToast(sessionId, "Failed to request model change", "error");
            }
          }}
        />
      )}
      {picker.kind === "thinking" && (
        <ThinkingPicker
          levels={authoritySnapshotFor(session)?.availableThinkingLevels ?? []}
          currentLevel={authoritySnapshotFor(session)?.thinkingLevel ?? "off"}
          {...(picker.search !== undefined ? { search: picker.search } : {})}
          onClose={() => closePicker(sessionId)}
          onInvalidSearch={(search, levels) => {
            addToast(
              sessionId,
              `Unknown thinking level "${search}". Available levels: ${levels.join(", ")}.`,
              "error",
            );
            closePicker(sessionId);
          }}
          onPick={async (level, persist = false) => {
            if (!beginPickerAction()) return;
            try {
              const observation = requirePickerObservation();
              const receipt = await dispatchSessionIntent(
                sessionId,
                { kind: "setThinking", level, ...(persist ? { persist: true } : {}) },
                observation,
              );
              if (!pickerRuntimeIsCurrent()) return;
              if (receipt.status === "not_admitted") {
                allowPickerRetry();
                addToast(sessionId, "Failed to request thinking-level change", "error");
                return;
              }
              if (receipt.status === "delivery_unknown") {
                addToast(
                  sessionId,
                  "Thinking-level delivery is unknown; verify before retrying",
                  "error",
                );
                return;
              }
              const outcome = await waitForPickerIntentOutcome(
                sessionId,
                receipt.intentId,
                observation.owner,
              );
              if (!pickerRuntimeIsCurrent()) return;
              if (outcome.kind !== "setThinking" || outcome.state !== "completed") {
                if (outcome.state === "rejected") allowPickerRetry();
                addToast(
                  sessionId,
                  outcome.error ?? "The thinking level could not be changed.",
                  "error",
                );
                return;
              }
              closePicker(sessionId);
            } catch {
              if (!pickerRuntimeIsCurrent()) return;
              addToast(sessionId, "Failed to request thinking-level change", "error");
            }
          }}
        />
      )}
      {picker.kind === "fork" && (
        <ForkPicker
          messages={picker.messages}
          onClose={() => closePicker(sessionId)}
          onPick={async (entryId) => {
            if (!beginPickerAction()) return;
            try {
              const receipt = await dispatchSessionIntent(
                sessionId,
                {
                  kind: "pickerAction",
                  selection: { action: "fork", entryId },
                  surface: picker.sourceSurface ?? "composer",
                },
                requirePickerObservation(),
              );
              if (!pickerRuntimeIsCurrent()) return;
              if (receipt.status === "not_admitted") {
                allowPickerRetry();
                addToast(sessionId, "Failed to request fork", "error");
                return;
              }
              if (receipt.status === "delivery_unknown") {
                addToast(sessionId, "Fork delivery is unknown; verify before retrying", "error");
                return;
              }
              // Authority frames own the successor, transcript, and editor.
              closePicker(sessionId);
            } catch {
              if (pickerRuntimeIsCurrent()) addToast(sessionId, "Failed to request fork", "error");
            }
          }}
        />
      )}
      {picker.kind === "resume" && (
        <ResumePicker
          sessions={picker.sessions}
          onClose={() => closePicker(sessionId)}
          onPick={async (target) => {
            if (!beginPickerAction()) return;
            if (!pickerRuntimeIsCurrent()) return;
            // Focus an existing tab if the file is already open, else
            // open a new tab. `openSessionTab` returns the id either way.
            const liveTab = Array.from(useSessionsStore.getState().sessions.values()).find(
              (s) => s.sessionFile === target.filePath,
            );
            if (liveTab) {
              requestComposerFocus(liveTab.sessionId);
              const activated = await setActiveSession(liveTab.sessionId);
              if (!pickerSlotIsCurrent()) return;
              if (activated) closePicker(sessionId);
              else {
                allowPickerRetry();
                addToast(sessionId, "Couldn't activate that session", "error");
              }
              return;
            }
            const workspacePath = useSessionsStore
              .getState()
              .sessions.get(sessionId)?.workspacePath;
            if (!workspacePath) {
              allowPickerRetry();
              addToast(sessionId, "No active workspace", "error");
              return;
            }
            const id = await openSessionTab(workspacePath, target.filePath, {
              focus: true,
              requestComposerFocus: true,
            });
            if (!pickerRuntimeIsCurrent()) return;
            if (id) {
              void setActiveSession(id);
              closePicker(sessionId);
            } else {
              allowPickerRetry();
              addToast(sessionId, "Couldn't open that session", "error");
            }
          }}
        />
      )}
      {picker.kind === "scoped-models" && (
        <ScopedModelsPicker
          models={picker.models}
          enabledIds={picker.enabledIds}
          onClose={() => closePicker(sessionId)}
          onApply={async (enabledIds, persist) => {
            if (!beginPickerAction()) return;
            try {
              const receipt = await dispatchSessionIntent(
                sessionId,
                {
                  kind: "pickerAction",
                  selection: { action: "setScopedModels", enabledIds, persist },
                  surface: picker.sourceSurface ?? "composer",
                },
                requirePickerObservation(),
              );
              if (!pickerRuntimeIsCurrent()) return;
              if (receipt.status === "not_admitted") {
                allowPickerRetry();
                addToast(sessionId, "Failed to request model scope update", "error");
                return;
              }
              if (receipt.status === "delivery_unknown") {
                addToast(
                  sessionId,
                  "Model-scope delivery is unknown; verify before retrying",
                  "error",
                );
                return;
              }
              closePicker(sessionId);
            } catch {
              if (pickerRuntimeIsCurrent()) {
                addToast(sessionId, "Failed to request model scope update", "error");
              }
            }
          }}
        />
      )}
      {picker.kind === "login" && (
        <LoginPicker
          providers={picker.providers}
          onClose={() => closePicker(sessionId)}
          onPick={async (provider, authType) => {
            if (!beginPickerAction()) return;
            try {
              const observation = requirePickerObservation();
              const receipt = await dispatchSessionIntent(
                sessionId,
                { kind: "loginProvider", providerId: provider.id, authType },
                observation,
              );
              if (!pickerRuntimeIsCurrent()) return;
              if (receipt.status === "not_admitted") {
                allowPickerRetry();
                addToast(sessionId, "Couldn't start sign-in", "error");
                return;
              }
              if (receipt.status === "delivery_unknown") {
                addToast(sessionId, "Sign-in delivery is unknown; verify before retrying", "error");
                return;
              }
              closePicker(sessionId);
              if (provider.id !== "radius" || authType !== "oauth") return;

              // Pi 1.0's Radius MCP offer is app-owned because pi-vis does not
              // instantiate upstream InteractiveMode. Wait for the bounded
              // login/config outcome, then request the normal owner-fenced
              // reload only after the login intent has fully settled.
              const outcome = await waitForPickerIntentOutcome(
                sessionId,
                receipt.intentId,
                observation.owner,
                30 * 60_000,
              );
              const current = useSessionsStore.getState().sessions.get(sessionId);
              if (!sessionMatchesRuntime(current, observation.owner)) return;
              if (outcome.kind !== "loginProvider" || outcome.state !== "completed") return;
              const catalogSynchronizationFailed = outcome.result?.synchronized === false;
              if (outcome.result?.radiusMcp === "failed") {
                addToast(
                  sessionId,
                  catalogSynchronizationFailed
                    ? "Signed in to Radius, but its MCP server could not be configured and the local model catalog could not be refreshed. Check your global mcp.json, refresh models, and try again."
                    : "Signed in to Radius, but its MCP server could not be configured. Check your global mcp.json and try again.",
                  "warning",
                );
                return;
              }
              if (outcome.result?.radiusMcp !== "configured") return;

              const semantic = current?.authorityProjection?.semantic;
              const reloadReceipt = await dispatchSessionIntent(
                sessionId,
                { kind: "reload" },
                {
                  owner: observation.owner,
                  ...(semantic?.state === "following" &&
                  semantic.cursor.hostInstanceId === observation.owner.hostInstanceId &&
                  semantic.cursor.sessionEpoch === observation.owner.sessionEpoch
                    ? { cursor: semantic.cursor }
                    : {}),
                },
              );
              if (
                reloadReceipt.status === "not_admitted" ||
                reloadReceipt.status === "delivery_unknown"
              ) {
                addToast(
                  sessionId,
                  catalogSynchronizationFailed
                    ? "Radius MCP was configured, but the local model catalog could not be refreshed. MCP will load on the next session reload; refresh models and try again."
                    : "Radius MCP was configured; it will load on the next session reload.",
                  "warning",
                );
              } else if (catalogSynchronizationFailed) {
                addToast(
                  sessionId,
                  "Radius MCP configured. Reloading session… Sign-in was saved, but the local model catalog still needs a manual refresh.",
                  "warning",
                );
              } else {
                addToast(sessionId, "Radius MCP configured. Reloading session…", "success");
              }
            } catch {
              const current = useSessionsStore.getState().sessions.get(sessionId);
              if (pickerRuntime && sessionMatchesRuntime(current, pickerRuntime)) {
                addToast(
                  sessionId,
                  provider.id === "radius"
                    ? "Couldn't complete Radius MCP setup"
                    : "Couldn't start sign-in",
                  "error",
                );
              }
            }
          }}
        />
      )}
      {picker.kind === "logout" && (
        <LogoutPicker
          providers={picker.providers}
          onClose={() => closePicker(sessionId)}
          onPick={async (provider) => {
            if (!beginPickerAction()) return;
            try {
              const receipt = await dispatchSessionIntent(
                sessionId,
                {
                  kind: "pickerAction",
                  selection: { action: "logoutProvider", providerId: provider.id },
                  surface: picker.sourceSurface ?? "composer",
                },
                requirePickerObservation(),
              );
              if (!pickerRuntimeIsCurrent()) return;
              if (receipt.status === "not_admitted") {
                allowPickerRetry();
                addToast(sessionId, "Failed to request logout", "error");
                return;
              }
              if (receipt.status === "delivery_unknown") {
                addToast(sessionId, "Logout delivery is unknown; verify before retrying", "error");
                return;
              }
              closePicker(sessionId);
            } catch {
              if (pickerRuntimeIsCurrent()) {
                addToast(sessionId, "Failed to request logout", "error");
              }
            }
          }}
        />
      )}
      {picker.kind === "trust" && (
        <TrustPicker
          sessionId={sessionId}
          runtime={requirePickerObservation().owner}
          cwd={picker.cwd}
          savedDecision={picker.savedDecision}
          projectTrusted={picker.projectTrusted}
          options={picker.options}
          beginAction={beginPickerAction}
          allowRetry={allowPickerRetry}
          isPickerCurrent={pickerRuntimeIsCurrent}
          onClose={() => {
            if (pickerSlotIsCurrent()) closePicker(sessionId);
          }}
        />
      )}
    </div>
  );
}

// ── Helper: re-seed transcript when fork changes the file ────────────────

// AdoptHelper removed: the fork command triggers fileChanged in main,
// which already calls adoptSessionFile + loadHistory + refreshWorkspaceSessions
// via the App-level subscription.

// ── /model picker ────────────────────────────────────────────────────────

function ModelPicker({
  sessionId,
  search,
  onClose,
  onPick,
}: {
  sessionId: SessionId;
  search?: string;
  onClose: () => void;
  onPick: (model: ModelInfo, persist?: boolean) => void;
}): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const refreshModelsSilently = useSessionsStore((s) => s.refreshModelsSilently);
  const semanticSnapshot = authoritySnapshotFor(session);
  const modelOwner =
    session?.authorityProjection?.semantic.state === "following"
      ? session.authorityProjection.semantic.cursor
      : undefined;
  const availableModels = semanticSnapshot ? (session?.availableModels ?? []) : [];
  const currentModel = semanticSnapshot?.model?.id;
  const currentProvider = semanticSnapshot?.model?.provider;
  const refreshFailed = Boolean(
    session?.modelRefreshFailure &&
      modelOwner &&
      session.modelRefreshFailure.hostInstanceId === modelOwner.hostInstanceId &&
      session.modelRefreshFailure.sessionEpoch === modelOwner.sessionEpoch,
  );
  // Resolve the single active entry once and compare items by key — so that
  // when the provider is unknown and duplicate same-id entries exist, at most
  // ONE row is marked selected (not every same-id copy).
  const currentModelInfo = findCurrentModel(availableModels, currentModel, currentProvider);
  const selectedKey = currentModelInfo ? modelKey(currentModelInfo) : null;
  const [query, setQuery] = useState(search ?? "");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const searchRef = useRef<HTMLInputElement>(null);

  // Pin focus on the search input and silently revalidate the cached catalog.
  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
    void refreshModelsSilently(sessionId);
  }, [refreshModelsSilently, sessionId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter((m) => {
      const label = m.name ?? m.id;
      return (
        label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.provider ?? "").toLowerCase().includes(q)
      );
    });
  }, [availableModels, query]);

  // Reset highlight when the filter changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the filter value, not on identity
  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [query]);

  const virtualList = useVirtualList<HTMLDivElement>({
    count: filtered.length,
    rowHeight: 38,
    minOverscan: 32,
    overscanScreens: 2,
  });

  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll keyboard/programmatic highlight changes into view. Pointer hover
  // only updates the visual highlight; it must not auto-scroll the list.
  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    virtualList.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, virtualList.ensureIndexVisible]);

  return (
    <div className="picker picker--model">
      <div className="picker__title">Switch model</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.ctrlKey &&
              !e.metaKey &&
              !e.altKey &&
              !e.shiftKey &&
              e.key.toLowerCase() === "s"
            ) {
              e.preventDefault();
              const model = filtered[highlightedIndex];
              if (model) onPick(model, true);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) =>
                filtered.length === 0 ? 0 : Math.min(i + 1, filtered.length - 1),
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const m = filtered[highlightedIndex];
              if (m) onPick(m);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        scrollerRef={virtualList.containerRef}
        onScroll={virtualList.onScroll}
        className="picker__list picker__list--virtual"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No models found</div>}
        {filtered.length > 0 && (
          <div className="picker__virtual-spacer" style={{ height: virtualList.totalHeight }}>
            <div
              className="picker__virtual-window"
              style={{ transform: `translateY(${virtualList.offsetY}px)` }}
            >
              {virtualList.rows.map(({ index: idx }) => {
                const m = filtered[idx];
                if (!m) return null;
                const label = modelDisplayName(m);
                const selected = selectedKey != null && modelKey(m) === selectedKey;
                return (
                  <button
                    type="button"
                    key={modelKey(m)}
                    className={`picker__item ${idx === highlightedIndex ? "picker__item--highlighted" : ""} ${selected ? "picker__item--selected" : ""}`}
                    onClick={() => onPick(m)}
                    onMouseEnter={() => {
                      highlightSourceRef.current = "pointer";
                      setHighlightedIndex(idx);
                    }}
                    role="option"
                    aria-selected={selected}
                  >
                    <span className="picker__selected-mark" aria-hidden>
                      {selected ? <IconCheck /> : null}
                    </span>
                    <span className="picker__item-name" title={label}>
                      {label}
                    </span>
                    <span className="picker__item-meta">{m.id}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <span className="picker__key-hint">Enter selects · Ctrl+S sets default</span>
        {refreshFailed && (
          <button
            type="button"
            className="picker__btn"
            onClick={() => void refreshModelsSilently(sessionId)}
          >
            {availableModels.length === 0 ? "Try again" : "Refresh models"}
          </button>
        )}
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /thinking picker ───────────────────────────────────────────────────

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

function ThinkingPicker({
  levels,
  currentLevel,
  search,
  onClose,
  onInvalidSearch,
  onPick,
}: {
  levels: readonly ThinkingLevel[];
  currentLevel: ThinkingLevel;
  search?: string;
  onClose: () => void;
  onInvalidSearch: (search: string, levels: readonly ThinkingLevel[]) => void;
  onPick: (level: ThinkingLevel, persist?: boolean) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(() => {
    const currentIndex = levels.indexOf(currentLevel);
    return currentIndex < 0 ? 0 : currentIndex;
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const exactSearchHandled = useRef(false);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [...levels];
    return levels.filter((level) =>
      `${level} ${THINKING_LEVEL_DESCRIPTIONS[level]}`.toLowerCase().includes(normalized),
    );
  }, [levels, query]);

  useEffect(() => {
    if (search === undefined || exactSearchHandled.current) return;
    exactSearchHandled.current = true;
    const normalized = search.trim().toLowerCase();
    const exact = levels.find((level) => level.toLowerCase() === normalized);
    if (exact) onPick(exact, false);
    else onInvalidSearch(search, levels);
  }, [levels, onInvalidSearch, onPick, search]);

  useEffect(() => {
    if (search === undefined) setTimeout(() => searchRef.current?.focus(), 10);
  }, [search]);

  useEffect(() => {
    setHighlightedIndex((index) =>
      filtered.length === 0 ? 0 : Math.min(index, filtered.length - 1),
    );
  }, [filtered.length]);

  if (search !== undefined) return <div className="picker picker--thinking" />;

  const activate = (persist: boolean): void => {
    const level = filtered[highlightedIndex];
    if (level) onPick(level, persist);
  };

  return (
    <div className="picker picker--thinking">
      <div className="picker__title">Thinking level</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search thinking levels…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlightedIndex(0);
          }}
          onKeyDown={(event) => {
            if (
              event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.shiftKey &&
              event.key.toLowerCase() === "s"
            ) {
              event.preventDefault();
              activate(true);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlightedIndex((index) =>
                filtered.length === 0 ? 0 : Math.min(index + 1, filtered.length - 1),
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlightedIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              activate(false);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        className="picker__list"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No thinking levels found</div>}
        {filtered.map((level, index) => {
          const selected = level === currentLevel;
          return (
            <button
              type="button"
              key={level}
              className={`picker__item ${index === highlightedIndex ? "picker__item--highlighted" : ""} ${selected ? "picker__item--selected" : ""}`}
              onClick={() => onPick(level, false)}
              onMouseEnter={() => setHighlightedIndex(index)}
              role="option"
              aria-selected={selected}
            >
              <span className="picker__selected-mark" aria-hidden>
                {selected ? <IconCheck /> : null}
              </span>
              <span className="picker__item-name">{level}</span>
              <span className="picker__item-meta">{THINKING_LEVEL_DESCRIPTIONS[level]}</span>
            </button>
          );
        })}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <span className="picker__key-hint">Enter selects · Ctrl+S sets default</span>
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /fork picker ────────────────────────────────────────────────────────

function ForkPicker({
  messages,
  onClose,
  onPick,
}: {
  messages: Array<{ entryId: string; text: string }>;
  onClose: () => void;
  onPick: (entryId: string) => void;
}): React.ReactElement {
  const [highlightedIndex, setHighlightedIndex] = useState(messages.length - 1);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => rootRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(messages.length - 1);
  }, [messages.length]);

  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div
      className="picker picker--fork"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightSourceRef.current = "keyboard";
          setHighlightedIndex((i) => Math.min(i + 1, messages.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightSourceRef.current = "keyboard";
          setHighlightedIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const m = messages[highlightedIndex];
          if (m) onPick(m.entryId);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="picker__title">Fork from user message</div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        scrollerRef={listRef}
        className="picker__list"
        role="listbox"
        fill
      >
        {messages.map((m, idx) => {
          const preview = m.text.split("\n", 1)[0] ?? m.text;
          const truncated = preview.length > 96 ? `${preview.slice(0, 96)}…` : preview;
          return (
            <button
              type="button"
              key={m.entryId}
              ref={(el) => {
                if (el) itemRefs.current.set(idx, el);
                else itemRefs.current.delete(idx);
              }}
              className={`picker__item fade-scope ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
              onClick={() => onPick(m.entryId)}
              onMouseEnter={() => {
                highlightSourceRef.current = "pointer";
                setHighlightedIndex(idx);
              }}
              role="option"
              aria-selected={idx === highlightedIndex}
            >
              <FadeText className="picker__item-name">{truncated}</FadeText>
            </button>
          );
        })}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /resume picker ──────────────────────────────────────────────────────

function ResumePicker({
  sessions,
  onClose,
  onPick,
}: {
  sessions: SessionSummary[];
  onClose: () => void;
  onPick: (s: SessionSummary) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      return (s.name ?? "").toLowerCase().includes(q) || s.preview.toLowerCase().includes(q);
    });
  }, [sessions, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the filter value, not on identity
  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  return (
    <div className="picker picker--resume">
      <div className="picker__title">Resume session</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlightedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const s = filtered[highlightedIndex];
              if (s) onPick(s);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        className="picker__list"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No sessions found</div>}
        {filtered.map((s, idx) => (
          <button
            type="button"
            key={s.filePath}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            className={`picker__item fade-scope ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
            onClick={() => onPick(s)}
            onMouseEnter={() => setHighlightedIndex(idx)}
            role="option"
            aria-selected={idx === highlightedIndex}
          >
            <FadeText className="picker__item-name">
              {s.name ?? s.preview ?? s.filePath.split("/").pop()}
            </FadeText>
            <span className="picker__item-meta">{s.messageCount} messages</span>
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /scoped-models picker ──────────────────────────────────────────────────
// Multi-select checkbox list of models. Pre-checks enabledIds (or all when
// enabledIds === null, meaning no scope = everything available). Two submit
// actions mirror pi's TUI showModelsSelector:
//   - Apply (persist=false): set_scoped_models — THIS session only, lost on
//     /reload (a fresh process rebuilds from settingsManager.getEnabledModels()).
//   - Save to settings (persist=true): save_scoped_models — persists to pi's
//     settings.json so ALL sessions (current + future + after reload) honor
//     it, AND applies to the current session immediately.
// "Select all" / "Select none" are bulk-toggle helpers that update only the
// local checked set (no submit). On submit, sends the checked provider/id
// strings, or null if everything is checked (mirrors pi's submit logic).
function ScopedModelsPicker({
  models,
  enabledIds,
  onClose,
  onApply,
}: {
  models: ModelInfo[];
  enabledIds: string[] | null;
  onClose: () => void;
  onApply: (enabledIds: string[] | null, persist: boolean) => void;
}): React.ReactElement {
  const allIds = useMemo(() => models.map((m) => `${m.provider ?? ""}/${m.id}`), [models]);
  const rows = useMemo(() => {
    const availableById = new Map(
      models.map((model) => [`${model.provider ?? ""}/${model.id}`.toLowerCase(), model]),
    );
    const availableRows = models.map((model) => ({
      id: `${model.provider ?? ""}/${model.id}`,
      model,
    }));
    const unavailableRows = (enabledIds ?? [])
      .filter((id) => !availableById.has(id.toLowerCase()))
      .map((id) => ({ id, model: undefined }));
    return [...availableRows, ...unavailableRows];
  }, [enabledIds, models]);
  const [checked, setChecked] = useState<Set<string>>(() => {
    if (enabledIds === null) return new Set(allIds);
    const canonicalAvailableIds = new Map(allIds.map((id) => [id.toLowerCase(), id]));
    return new Set(enabledIds.map((id) => canonicalAvailableIds.get(id.toLowerCase()) ?? id));
  });
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ id, model }) => {
      const label = model ? (model.name ?? model.id) : id;
      return (
        label.toLowerCase().includes(q) ||
        id.toLowerCase().includes(q) ||
        (model?.provider ?? "").toLowerCase().includes(q)
      );
    });
  }, [query, rows]);

  // Reset highlight when the filter changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the filter value, not on identity
  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [query]);

  const virtualList = useVirtualList<HTMLDivElement>({
    count: filtered.length,
    rowHeight: 38,
    minOverscan: 32,
    overscanScreens: 2,
  });

  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    virtualList.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, virtualList.ensureIndexVisible]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allChecked = checked.size === allIds.length && allIds.every((id) => checked.has(id));
  const noneChecked = checked.size === 0;
  const selectedCount = checked.size;

  const handleApply = (persist: boolean) => {
    // pi convention: all checked → setScopedModels([]) (empty = no scope).
    if (allChecked || checked.size === 0) {
      onApply(null, persist);
      return;
    }
    onApply([...checked], persist);
  };

  return (
    <div className="picker picker--scoped-models">
      <div className="picker__title">Model scope</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const row = filtered[highlightedIndex];
              if (row) toggle(row.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        scrollerRef={virtualList.containerRef}
        onScroll={virtualList.onScroll}
        className="picker__list picker__list--virtual"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No models found</div>}
        {filtered.length > 0 && (
          <div className="picker__virtual-spacer" style={{ height: virtualList.totalHeight }}>
            <div
              className="picker__virtual-window"
              style={{ transform: `translateY(${virtualList.offsetY}px)` }}
            >
              {virtualList.rows.map(({ index: idx }) => {
                const row = filtered[idx];
                if (!row) return null;
                const { id, model } = row;
                const isChecked = checked.has(id);
                const label = model ? modelDisplayName(model) : id;
                return (
                  <button
                    type="button"
                    key={id}
                    className={`picker__item picker__item--check ${model ? "" : "picker__item--unavailable"} ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
                    onClick={() => toggle(id)}
                    onMouseEnter={() => {
                      highlightSourceRef.current = "pointer";
                      setHighlightedIndex(idx);
                    }}
                    role="option"
                    aria-selected={isChecked}
                  >
                    <span
                      className={`picker__checkbox ${isChecked ? "picker__checkbox--checked" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="picker__item-name" title={label}>
                      {label}
                    </span>
                    <span className="picker__item-meta">{model?.id ?? "Unavailable"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <span className="picker__count">
          {selectedCount} selected
          {rows.length > models.length ? ` · ${rows.length - models.length} unavailable` : ""}
        </span>
        <button
          type="button"
          className="picker__btn picker__btn--cancel picker__btn--bulk"
          onClick={() => setChecked(new Set(allIds))}
          disabled={allChecked}
        >
          Select all
        </button>
        <button
          type="button"
          className="picker__btn picker__btn--cancel picker__btn--bulk"
          onClick={() => setChecked(new Set())}
          disabled={noneChecked}
        >
          Select none
        </button>
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="picker__btn picker__btn--primary"
          onClick={() => handleApply(false)}
        >
          Apply
        </button>
        <button
          type="button"
          className="picker__btn picker__btn--save"
          onClick={() => handleApply(true)}
        >
          Save to settings
        </button>
      </div>
    </div>
  );
}

// ── /login picker ───────────────────────────────────────────────────────────
function LoginPicker({
  providers,
  onClose,
  onPick,
}: {
  providers: LoginProvider[];
  onClose: () => void;
  onPick: (provider: LoginProvider, authType: "oauth" | "api_key") => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const choices = useMemo(
    () =>
      providers.flatMap((provider) => provider.methods.map((authType) => ({ provider, authType }))),
    [providers],
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return choices;
    return choices.filter(({ provider, authType }) =>
      `${provider.name} ${provider.id} ${
        authType === "oauth" ? (provider.oauthKind ?? "account") : "api key"
      }`
        .toLowerCase()
        .includes(normalized),
    );
  }, [choices, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => searchRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    setHighlightedIndex((index) =>
      filtered.length === 0 ? 0 : Math.min(index, filtered.length - 1),
    );
  }, [filtered.length]);
  useEffect(() => {
    itemRefs.current.get(highlightedIndex)?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const choose = (index: number): void => {
    const choice = filtered[index];
    if (choice) onPick(choice.provider, choice.authType);
  };

  return (
    <div className="picker picker--login">
      <div className="picker__title">Sign in</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search providers…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlightedIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlightedIndex((index) => Math.min(index + 1, filtered.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlightedIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(highlightedIndex);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        className="picker__list"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No providers found</div>}
        {filtered.map(({ provider, authType }, index) => (
          <button
            type="button"
            key={`${provider.id}:${authType}`}
            ref={(element) => {
              if (element) itemRefs.current.set(index, element);
              else itemRefs.current.delete(index);
            }}
            className={`picker__item fade-scope ${index === highlightedIndex ? "picker__item--highlighted" : ""}`}
            onClick={() => choose(index)}
            onMouseEnter={() => setHighlightedIndex(index)}
            role="option"
            aria-selected={index === highlightedIndex}
          >
            <FadeText className="picker__item-name">{provider.name}</FadeText>
            {provider.configured && <span className="picker__badge">Connected</span>}
            <span className={`picker__badge picker__badge--${authType}`}>
              {authType === "oauth"
                ? provider.oauthKind === "subscription"
                  ? "Subscription"
                  : "Account"
                : "API key"}
            </span>
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /logout picker ──────────────────────────────────────────────────────────
// Single-select list of providers with stored auth. On pick, sends
// logout_provider and toasts the result (the message differs for oauth vs
// api_key, mirroring pi's TUI).
function LogoutPicker({
  providers,
  onClose,
  onPick,
}: {
  providers: Array<{
    id: string;
    name: string;
    authType: "oauth" | "api_key";
    oauthKind?: "account" | "subscription";
  }>;
  onClose: () => void;
  onPick: (provider: {
    id: string;
    name: string;
    authType: "oauth" | "api_key";
    oauthKind?: "account" | "subscription";
  }) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) => {
      return p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
    });
  }, [providers, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the filter value, not on identity
  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [query]);

  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div className="picker picker--logout">
      <div className="picker__title">Sign out</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const p = filtered[highlightedIndex];
              if (p) onPick(p);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        className="picker__list"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No providers found</div>}
        {filtered.map((p, idx) => (
          <button
            type="button"
            key={p.id}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            className={`picker__item fade-scope ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
            onClick={() => onPick(p)}
            onMouseEnter={() => {
              highlightSourceRef.current = "pointer";
              setHighlightedIndex(idx);
            }}
            role="option"
            aria-selected={idx === highlightedIndex}
          >
            <FadeText className="picker__item-name">{p.name}</FadeText>
            <span className={`picker__badge picker__badge--${p.authType}`}>
              {p.authType === "oauth"
                ? p.oauthKind === "subscription"
                  ? "Subscription"
                  : "Account"
                : "API Key"}
            </span>
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /trust picker ───────────────────────────────────────────────────────────
// Single-select list of pi's project-trust options for the session cwd
// (mirrors pi's TUI TrustSelectorComponent). On pick, sends only the exact
// child-produced label; the host rebuilds and revalidates that option before
// persisting it, then the renderer reloads the session after its typed terminal
// outcome (pi's TUI also tells the user "Restart pi for this to take effect.").
//
// Reload rather than live re-bind: re-running createAgentSessionServices
// mid-session would risk the transcript/session identity. The persisted
// decision is read by resolveProjectTrust on the next session start, so a
// /reload (which re-spawns the host) honors it immediately — faithful to
// pi's TUI, which likewise requires a restart.
function findTrustOutcome(
  sessionId: SessionId,
  intentId: string,
  owner: RuntimeIdentity,
): Extract<IntentOutcome, { kind: "setTrust" }> | undefined {
  const outcomes = useSessionsStore.getState().sessions.get(sessionId)?.authorityProjection
    ?.authoritativeSnapshot?.recentIntentOutcomes;
  return outcomes?.find(
    (outcome): outcome is Extract<IntentOutcome, { kind: "setTrust" }> =>
      outcome.intentId === intentId &&
      outcome.kind === "setTrust" &&
      outcome.owner.hostInstanceId === owner.hostInstanceId &&
      outcome.owner.sessionEpoch === owner.sessionEpoch,
  );
}

function waitForTrustOutcome(
  sessionId: SessionId,
  intentId: string,
  owner: RuntimeIdentity,
): Promise<Extract<IntentOutcome, { kind: "setTrust" }>> {
  const immediate = findTrustOutcome(sessionId, intentId, owner);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the trust update to finish."));
    }, 10_000);
    unsubscribe = useSessionsStore.subscribe(() => {
      const outcome = findTrustOutcome(sessionId, intentId, owner);
      if (outcome) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(outcome);
        return;
      }
      const session = useSessionsStore.getState().sessions.get(sessionId);
      const snapshot = authoritySnapshotFor(session);
      if (
        session?.status === "failed" ||
        session?.status === "exited" ||
        (snapshot !== undefined &&
          (snapshot.owner.hostInstanceId !== owner.hostInstanceId ||
            snapshot.owner.sessionEpoch !== owner.sessionEpoch))
      ) {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error("Session changed before the trust update completed."));
      }
    });
  });
}

function TrustPicker({
  sessionId,
  runtime,
  cwd,
  savedDecision,
  projectTrusted,
  options,
  beginAction,
  allowRetry,
  isPickerCurrent,
  onClose,
}: {
  sessionId: SessionId;
  runtime: { hostInstanceId: string; sessionEpoch: number };
  cwd: string;
  savedDecision: boolean | null;
  projectTrusted: boolean;
  options: ProjectTrustOption[];
  beginAction: () => boolean;
  allowRetry: () => void;
  isPickerCurrent: () => boolean;
  onClose: () => void;
}): React.ReactElement {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const addToast = useSessionsStore((s) => s.addToast);

  // Mirror pi-vis's other pickers: auto-focus the list so arrow-key nav
  // works without a search field (the trust option set is small and fixed).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setTimeout(() => listRef.current?.focus(), 10);
  }, []);

  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const choose = useCallback(
    async (idx: number) => {
      const option = options[idx];
      if (!option || saving) return;
      // Session-only options have updates === []: persisting them changes nothing,
      // so a reload re-runs resolveProjectTrust with no saved decision and
      // re-prompts — destroying the session-only choice. Session-only trust
      // is a runtime override pi applies only during the initial resolve;
      // it can't be toggled post-startup via /trust. Surface that without a
      // no-op RPC round-trip.
      if (Array.isArray(option.updates) && option.updates.length === 0) {
        addToast(
          sessionId,
          "Session-only trust can't be changed after startup — choose a persistent option.",
          "warning",
        );
        return;
      }
      if (!beginAction()) return;
      setSaving(true);
      const semantic = useSessionsStore.getState().sessions.get(sessionId)
        ?.authorityProjection?.semantic;
      const cursor =
        semantic?.state === "following" &&
        semantic.cursor.hostInstanceId === runtime.hostInstanceId &&
        semantic.cursor.sessionEpoch === runtime.sessionEpoch
          ? semantic.cursor
          : undefined;
      const observation = { owner: runtime, ...(cursor ? { cursor } : {}) };
      try {
        const receipt = await dispatchSessionIntent(
          sessionId,
          { kind: "setTrust", optionLabel: option.label },
          observation,
        );
        if (!isPickerCurrent()) return;
        if (receipt.status === "not_admitted") {
          addToast(sessionId, "Failed to request trust update", "error");
          allowRetry();
          setSaving(false);
          return;
        }
        if (receipt.status === "delivery_unknown") {
          addToast(sessionId, "Trust-update delivery is unknown; verify before retrying", "error");
          return;
        }
        const outcome = await waitForTrustOutcome(sessionId, receipt.intentId, runtime);
        if (!isPickerCurrent()) return;
        if (
          outcome.state !== "completed" ||
          outcome.result?.persisted !== true ||
          outcome.result.trusted !== option.trusted
        ) {
          addToast(sessionId, outcome.error ?? "The trust choice could not be saved.", "error");
          if (outcome.state === "rejected") {
            allowRetry();
            setSaving(false);
          }
          return;
        }
        // Trust changes take effect through the same owner-bound replacement
        // protocol; authority frames publish the successor. Admission itself
        // advances the semantic cursor, so capture the fresh observation
        // rather than treating that expected advance as a stale selection.
        const currentSemantic = useSessionsStore.getState().sessions.get(sessionId)
          ?.authorityProjection?.semantic;
        if (!isPickerCurrent()) return;
        const reloadObservation = {
          owner: runtime,
          ...(currentSemantic?.state === "following" &&
          currentSemantic.cursor.hostInstanceId === runtime.hostInstanceId &&
          currentSemantic.cursor.sessionEpoch === runtime.sessionEpoch
            ? { cursor: currentSemantic.cursor }
            : {}),
        };
        const reloadReceipt = await dispatchSessionIntent(
          sessionId,
          { kind: "reload" },
          reloadObservation,
        );
        if (
          reloadReceipt.status === "not_admitted" ||
          reloadReceipt.status === "delivery_unknown"
        ) {
          addToast(
            sessionId,
            "Trust was requested; it applies on the next session start.",
            "warning",
          );
          onClose();
          return;
        }
        onClose();
      } catch (err) {
        if (!isPickerCurrent()) return;
        addToast(sessionId, err instanceof Error ? err.message : String(err), "error");
      }
    },
    [
      options,
      saving,
      beginAction,
      sessionId,
      addToast,
      allowRetry,
      isPickerCurrent,
      onClose,
      runtime,
    ],
  );

  return (
    <div className="picker picker--trust">
      <div className="picker__title">Project trust</div>
      <FadeText head className="picker__trust-cwd" title={cwd}>
        {cwd}
      </FadeText>
      <div className="picker__trust-status">
        {savedDecision === null
          ? "No saved decision"
          : savedDecision
            ? "Currently trusted (this folder)"
            : "Currently untrusted (this folder)"}
        {!projectTrusted && " · global default: untrusted"}
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        scrollerRef={listRef}
        className="picker__list"
        role="listbox"
        aria-label="Trust options"
        tabIndex={0}
        fill
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            highlightSourceRef.current = "keyboard";
            setHighlightedIndex((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            highlightSourceRef.current = "keyboard";
            setHighlightedIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            void choose(highlightedIndex);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {options.map((option, idx) => (
          <button
            key={option.label}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            type="button"
            className={`picker__item fade-scope ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
            disabled={saving}
            onMouseEnter={() => {
              highlightSourceRef.current = "pointer";
              setHighlightedIndex(idx);
            }}
            onClick={() => void choose(idx)}
          >
            <FadeText className="picker__item-name">{option.label}</FadeText>
            <span className="picker__item-meta">{option.trusted ? "trusted" : "untrusted"}</span>
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

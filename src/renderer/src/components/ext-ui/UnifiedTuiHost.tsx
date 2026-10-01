/**
 * UnifiedTuiHost — embedded xterm.js for the persistent unified-TUI panel.
 *
 * Rendered (in place of the Composer) when a session has a `unifiedPanel` —
 * i.e. an extension registered a factory `setWidget` and the SDK host built a
 * real pi-tui `TUI` hosting the Editor + widget components. The host writes
 * ANSI to this panel; keystrokes flow back over `session.panelInput` exactly as
 * for a custom() panel, so the TUI's `handleInput` chain (`inputListeners` +
 * the focused Editor) receives them.
 *
 * Sibling of `CustomPanelHost`, but:
 *  - persistent + non-modal (no `done()`/force-close) — the extension owns the
 *    lifecycle via `setWidget(key, undefined)` → `panel_close`;
 *  - reads `unifiedPanel` (not `panel`), so it never collides with a custom()
 *    overlay and `extensionUiActive` doesn't treat it as a blocking dialog.
 *
 * Lifecycle mirrors CustomPanelHost: rebuild xterm only on panel-identity
 * change (not on every streamed frame). On remount after a session/view switch
 * we start from a clean xterm and force the host to send a complete repaint;
 * live `panel_data` then arrives via the `session.panelEvent` subscription.
 */

import type { SessionId } from "@shared/ids.js";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRoutedEscapeClaim } from "../../hooks/useEscapeClaim.js";
import type { PanelInputIdentity } from "../../lib/panel-input-buffer.js";
import {
  type PanelInputGenerationHandle,
  acknowledgePanelInput,
  enqueuePanelInputAttempt,
  isPanelInputBlocked,
  isPanelInputGenerationCurrent,
  nextPanelInputSequence,
  panelInputGapMessage,
  queuePanelInput,
  releaseQueuedPanelInput,
  resetPanelInputSequenceToAcknowledged,
  retirePanelInputIdentity,
} from "../../lib/panel-input-sequence.js";
import {
  type AppliedPanelOutput,
  PANEL_REPLAY_CLEAR_ANSI,
  initialAppliedPanelOutput,
  panelOutputActionRequiresDrain,
  reconcilePanelOutput,
} from "../../lib/panel-output-reconciler.js";
import { useOverlayStore } from "../../stores/overlay-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { getTheme } from "../../theme/registry.js";
import { basePanelTerminalOptions, buildXtermTheme } from "../../theme/xterm.js";
import { type EscapePanelIdentity, routePanelEscape } from "./panel-escape.js";
import { PANEL_SCROLLBACK_ROWS, createPanelSizer } from "./panel-sizer.js";
import "@xterm/xterm/css/xterm.css";
import "./CustomPanelHost.css";

// ─── Props ───────────────────────────────────────────────────────────────

interface UnifiedTuiHostProps {
  sessionId: SessionId;
  visible?: boolean;
}

function resolveMonoFont(): string {
  const fromVar = getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim();
  return fromVar || "ui-monospace, Menlo, monospace";
}

function mayExplicitlyFocusTerminal(container: HTMLElement): boolean {
  const active = document.activeElement;
  if (
    !active ||
    active === document.body ||
    active === document.documentElement ||
    container.contains(active)
  )
    return true;
  if (!(active instanceof HTMLElement)) return false;
  // A session row/button is an entry control and may hand focus to the target
  // surface. Never pull it from another typing surface or composer replacement.
  return !(
    active.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) ||
    active.closest(".composer, .custom-panel, .ext-dialog, .picker-slot")
  );
}

// ─── Component ────────────────────────────────────────────────────────────

export function UnifiedTuiHost({
  sessionId,
  visible = true,
}: UnifiedTuiHostProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const termPanelRef = useRef<EscapePanelIdentity | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const panelRef = useRef<{
    id: number;
    hostInstanceId: string;
    sessionEpoch: number;
    buffer: string[];
    mode?: "content" | "viewport";
    authority?: boolean;
    inputEnabled?: boolean;
    renderRevision?: number;
    keyframeReady?: boolean;
    outputSequence?: number;
    outputKind?: "keyframe" | "delta" | "reset" | "repaint_required";
    outputAnsi?: string;
    inputAcknowledgedThrough?: number;
    syncState?: "following" | "synchronizing" | "unavailable";
  } | null>(null);
  const appliedOutputRef = useRef<AppliedPanelOutput | null>(null);
  // Identity of the authority projection that has actually drained through
  // xterm. A safe projection in React state is not enough: input must remain
  // fenced until its anchor/keyframe is present in the terminal grid.
  const replayReadyRef = useRef<string | null>(null);
  const [replayReadyGeneration, setReplayReadyGeneration] = useState(0);
  const authorityAckRef = useRef<string | null>(null);
  // Mount/reset and input recovery are single-flight per panel identity.
  const authorityRepaintRequestRef = useRef<string | null>(null);
  // A slow repaint may transiently publish keyframeReady before a redundant
  // force request's repaint_required frame arrives. Preserve each identity's
  // quiet-window generation across those effect restarts; resetting to the
  // shortest delay would recreate the fixed-interval invalidation loop.
  const authorityRepaintRetryStateRef = useRef(
    new Map<string, { delayMs: number; observedRenderRevision: number | undefined }>(),
  );
  // While a terminal identity is mounting, its first measured resize owns the
  // reconstruction request. Reactive projection updates must not race it with
  // a default-size force before xterm has measured its actual grid.
  const initialPanelSizingRef = useRef<string | null>(null);
  // Unsafe replay replacement is deduplicated per output generation. A newer
  // unanchored segment needs its own recovery request even if an older request
  // has not produced a frame.
  const replayRepaintRequestRef = useRef<string | null>(null);
  const dispatchPanelInputRef = useRef<((data: string) => void) | null>(null);
  const panelIpcRetryTimerRef = useRef<number | null>(null);
  const [panelIpcRetryGeneration, setPanelIpcRetryGeneration] = useState(0);
  // The current sizing pass, exposed by the lifecycle effect so the mode-change
  // effect below can re-run it without taking sync's deps.
  const syncRef = useRef<(() => void) | null>(null);
  const contentSyncRef = useRef<(() => void) | null>(null);
  // Display mode, read live by sync() without being a rebuild dep (mode flips
  // mid-panel must NOT tear down xterm).
  const modeRef = useRef<"content" | "viewport">("content");
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusAfterRevealRef = useRef(false);
  const { unifiedPanel } = useSessionsStore((s) => s.sessions.get(sessionId)) ?? {};
  const composerFocusRequest = useSessionsStore((s) => s.composerFocusRequest);
  const consumeComposerFocus = useSessionsStore((s) => s.consumeComposerFocus);
  const escapeClaimCount = useOverlayStore((s) => s.count);
  // Keep panelRef in sync so the lifecycle effect (dep = panelId only) can read
  // the current buffer without taking it as a reactive dep (which would rebuild
  // xterm on every streamed frame).
  panelRef.current = unifiedPanel ?? null;
  const panelId = unifiedPanel?.id;
  const panelHostInstanceId = unifiedPanel?.hostInstanceId;
  const panelSessionEpoch = unifiedPanel?.sessionEpoch;
  const panelAuthority = unifiedPanel?.authority;
  const panelKeyframeReady = unifiedPanel?.keyframeReady;
  const panelSyncState = unifiedPanel?.syncState;
  const panelMode = unifiedPanel?.mode ?? "content";
  modeRef.current = panelMode;
  const panelIdentityKey = unifiedPanel
    ? `${unifiedPanel.hostInstanceId}:${unifiedPanel.sessionEpoch}:${unifiedPanel.id}`
    : null;
  const appliedOutput = appliedOutputRef.current;
  const terminalPanel = termPanelRef.current;
  const terminalOwnsProjection =
    unifiedPanel !== undefined &&
    terminalPanel?.hostInstanceId === unifiedPanel.hostInstanceId &&
    terminalPanel.sessionEpoch === unifiedPanel.sessionEpoch &&
    terminalPanel.id === unifiedPanel.id;
  const pendingOutputReconciliation =
    unifiedPanel && appliedOutput && terminalOwnsProjection
      ? reconcilePanelOutput(appliedOutput, unifiedPanel)
      : null;
  const replayProjectionReady =
    unifiedPanel?.authority !== true ||
    !(pendingOutputReconciliation
      ? pendingOutputReconciliation.applied.repaintRequired
      : initialAppliedPanelOutput(unifiedPanel).repaintRequired);
  const replayReplacementPending = pendingOutputReconciliation
    ? panelOutputActionRequiresDrain(pendingOutputReconciliation.action)
    : false;
  const replayAppliedToTerminal =
    unifiedPanel?.authority !== true ||
    (terminalOwnsProjection &&
      replayProjectionReady &&
      !replayReplacementPending &&
      replayReadyRef.current === panelIdentityKey);

  // Input can arrive between DOM commit and passive effects. Close the gate in
  // the synchronous commit phase when the next projection is unsafe, replaces
  // the grid, or changes owner. Keeping this mutation out of render also means
  // an abandoned concurrent render cannot fence the committed terminal forever.
  // A reconstructable hard-clear/keyframe is safe to queue, but only its xterm
  // drain callback may reopen input.
  useLayoutEffect(() => {
    if (!terminalOwnsProjection || !replayProjectionReady || replayReplacementPending) {
      replayReadyRef.current = null;
    }
  }, [terminalOwnsProjection, replayProjectionReady, replayReplacementPending]);

  const schedulePanelIpcRetry = useCallback(() => {
    if (panelIpcRetryTimerRef.current !== null) return;
    panelIpcRetryTimerRef.current = window.setTimeout(() => {
      panelIpcRetryTimerRef.current = null;
      setPanelIpcRetryGeneration((generation) => generation + 1);
    }, 100);
  }, []);

  useEffect(
    () => () => {
      if (panelIpcRetryTimerRef.current !== null) {
        window.clearTimeout(panelIpcRetryTimerRef.current);
        panelIpcRetryTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    // A write-drain callback increments this token to re-run input-buffer
    // reconciliation after it opens replayReadyRef.
    void replayReadyGeneration;
    void panelIpcRetryGeneration;
    if (unifiedPanel?.inputAcknowledgedThrough !== undefined) {
      acknowledgePanelInput(
        sessionId,
        unifiedPanel.hostInstanceId,
        unifiedPanel.sessionEpoch,
        unifiedPanel.id,
        unifiedPanel.inputAcknowledgedThrough,
      );
    }
    if (!unifiedPanel) return;
    const repaintKey = `${unifiedPanel.hostInstanceId}:${unifiedPanel.sessionEpoch}:${unifiedPanel.id}`;
    if (unifiedPanel.syncState === "following") {
      authorityRepaintRequestRef.current = null;
      authorityRepaintRetryStateRef.current.delete(repaintKey);
      replayRepaintRequestRef.current = null;
      authorityAckRef.current = null;
    }
    const term = termRef.current;
    if (!term) return;
    if (
      unifiedPanel.authority === true &&
      unifiedPanel.syncState === "synchronizing" &&
      unifiedPanel.keyframeReady === false &&
      unifiedPanel.outputKind !== "repaint_required" &&
      initialPanelSizingRef.current !== repaintKey &&
      authorityRepaintRequestRef.current !== repaintKey
    ) {
      authorityRepaintRequestRef.current = repaintKey;
      void window.pivis
        .invoke("session.panelResize", {
          sessionId,
          expectedHostInstanceId: unifiedPanel.hostInstanceId,
          expectedSessionEpoch: unifiedPanel.sessionEpoch,
          panelId: unifiedPanel.id,
          cols: term.cols,
          rows: term.rows,
          force: true,
        })
        .catch(() => {
          if (authorityRepaintRequestRef.current === repaintKey) {
            authorityRepaintRequestRef.current = null;
          }
          schedulePanelIpcRetry();
        });
    }
    let requestReplayRepaint: string | null = null;
    let releaseReplayAfterDrain: AppliedPanelOutput | null = null;
    let terminalContentChanged = false;
    const applied = appliedOutputRef.current;
    if (applied) {
      const reconciliation = reconcilePanelOutput(applied, unifiedPanel);
      appliedOutputRef.current = reconciliation.applied;
      if (reconciliation.applied.repaintRequired) {
        replayReadyRef.current = null;
      } else if (unifiedPanel.authority === true && replayReadyRef.current !== repaintKey) {
        releaseReplayAfterDrain = reconciliation.applied;
      }
      switch (reconciliation.action.kind) {
        case "append":
          term.write(reconciliation.action.ansi);
          terminalContentChanged = true;
          break;
        case "replace":
          // Queue the clear with the replay. Unlike term.reset(), this cannot
          // race already-queued writes and does not disable Kitty keyboard mode.
          term.write(`${PANEL_REPLAY_CLEAR_ANSI}${reconciliation.action.ansi}`);
          terminalContentChanged = true;
          replayRepaintRequestRef.current = null;
          break;
        case "clear":
          term.write(PANEL_REPLAY_CLEAR_ANSI);
          terminalContentChanged = true;
          break;
        case "request_repaint": {
          term.write(PANEL_REPLAY_CLEAR_ANSI);
          terminalContentChanged = true;
          break;
        }
        case "none":
          break;
      }
      // A repaint_required operation means the host's complete frame is
      // already in flight. Request a repaint here only for a genuinely
      // unanchored replay replacement; reset/open reconstruction is owned by
      // the force path above (or by the first measured lifecycle resize).
      if (reconciliation.action.kind === "request_repaint") {
        const key = `${repaintKey}:${unifiedPanel.outputSequence ?? 0}`;
        if (replayRepaintRequestRef.current !== key) {
          replayRepaintRequestRef.current = key;
          requestReplayRepaint = key;
        }
      }
    }
    const ackKey = `${unifiedPanel.hostInstanceId}:${unifiedPanel.sessionEpoch}:${unifiedPanel.id}:${unifiedPanel.renderRevision ?? 0}`;
    const shouldAcknowledge =
      unifiedPanel.authority === true &&
      unifiedPanel.syncState === "synchronizing" &&
      unifiedPanel.keyframeReady === true &&
      authorityAckRef.current !== ackKey;
    if (shouldAcknowledge) authorityAckRef.current = ackKey;
    term.write("", () => {
      if (visibleRef.current) {
        if (terminalContentChanged) contentSyncRef.current?.();
        else syncRef.current?.();
      }
      if (releaseReplayAfterDrain) {
        const active = panelRef.current;
        const currentApplied = appliedOutputRef.current;
        if (
          active &&
          active.hostInstanceId === unifiedPanel.hostInstanceId &&
          active.sessionEpoch === unifiedPanel.sessionEpoch &&
          active.id === unifiedPanel.id &&
          currentApplied === releaseReplayAfterDrain &&
          !currentApplied.repaintRequired &&
          (active.outputSequence ?? null) === currentApplied.sequence &&
          (active.renderRevision ?? null) === currentApplied.renderRevision &&
          replayReadyRef.current !== repaintKey
        ) {
          replayReadyRef.current = repaintKey;
          setReplayReadyGeneration((generation) => generation + 1);
        }
      }
      if (requestReplayRepaint) {
        const active = panelRef.current;
        if (
          active &&
          active.hostInstanceId === unifiedPanel.hostInstanceId &&
          active.sessionEpoch === unifiedPanel.sessionEpoch &&
          active.id === unifiedPanel.id &&
          replayRepaintRequestRef.current === requestReplayRepaint &&
          initialPanelSizingRef.current !== repaintKey
        ) {
          void window.pivis
            .invoke("session.panelResize", {
              sessionId,
              expectedHostInstanceId: unifiedPanel.hostInstanceId,
              expectedSessionEpoch: unifiedPanel.sessionEpoch,
              panelId: unifiedPanel.id,
              cols: term.cols,
              rows: term.rows,
              force: true,
            })
            .catch(() => {
              if (replayRepaintRequestRef.current === requestReplayRepaint) {
                replayRepaintRequestRef.current = null;
              }
              schedulePanelIpcRetry();
            });
        }
      }
      if (!shouldAcknowledge) return;
      const active = panelRef.current;
      if (
        !active ||
        active.hostInstanceId !== unifiedPanel.hostInstanceId ||
        active.sessionEpoch !== unifiedPanel.sessionEpoch ||
        active.id !== unifiedPanel.id ||
        active.renderRevision !== unifiedPanel.renderRevision
      )
        return;
      void window.pivis
        .invoke("session.panelRepaintAck", {
          sessionId,
          expectedHostInstanceId: unifiedPanel.hostInstanceId,
          expectedSessionEpoch: unifiedPanel.sessionEpoch,
          panelId: unifiedPanel.id,
          revision: unifiedPanel.renderRevision ?? 0,
        })
        .then((result) => {
          if (!result.acknowledged && authorityAckRef.current === ackKey) {
            authorityAckRef.current = null;
            schedulePanelIpcRetry();
          }
        })
        .catch(() => {
          if (authorityAckRef.current === ackKey) authorityAckRef.current = null;
          schedulePanelIpcRetry();
        });
    });

    const authorityReady =
      unifiedPanel.authority === true &&
      unifiedPanel.syncState === "following" &&
      unifiedPanel.inputEnabled === true &&
      unifiedPanel.renderRevision !== undefined &&
      replayReadyRef.current === repaintKey;
    const inputIdentity = {
      hostInstanceId: unifiedPanel.hostInstanceId,
      sessionEpoch: unifiedPanel.sessionEpoch,
      panelId: unifiedPanel.id,
    };
    for (const chunk of releaseQueuedPanelInput(
      sessionId,
      inputIdentity,
      authorityReady,
      unifiedPanel.inputAcknowledgedThrough,
    )) {
      dispatchPanelInputRef.current?.(chunk);
    }
  }, [
    panelIpcRetryGeneration,
    replayReadyGeneration,
    schedulePanelIpcRetry,
    sessionId,
    unifiedPanel,
  ]);

  // Viewport mode is a pi-tui overlay. Its Escape must traverse xterm's
  // onData sequencer rather than defer to a DOM event that may be fenced while
  // authority reconstruction is in progress. Content mode remains unclaimed
  // so an ordinary streaming Escape can request the host interrupt.
  useRoutedEscapeClaim(visible && panelMode === "viewport", () => {
    routePanelEscape(panelRef.current, termPanelRef.current, termRef.current);
  });

  // Live re-theme: the host emits role-identity ANSI indices, and xterm
  // resolves them against `term.options.theme.extendedAnsi` at paint time, so
  // swapping the palette recolors every buffered cell with no re-emit. The
  // Terminal persists across scheme changes (the lifecycle effect only
  // rebuilds on panel-identity change), so we update its theme in place here.
  const activeColorScheme = useSettingsStore((s) => s.activeColorScheme);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(getTheme(activeColorScheme));
  }, [activeColorScheme]);

  // Re-run the sizing pass when the mode flips (overlay shown/hidden). The
  // lifecycle effect is keyed on panelId only, so it doesn't re-fire here — but
  // viewport↔content needs an immediate re-size, not just on the next frame.
  const panelInputReady =
    unifiedPanel?.authority === true &&
    unifiedPanel.syncState === "following" &&
    unifiedPanel.inputEnabled === true &&
    unifiedPanel.renderRevision !== undefined &&
    replayAppliedToTerminal;
  const panelFocusReady =
    unifiedPanel !== undefined && (unifiedPanel.authority !== true || panelInputReady);
  useEffect(() => {
    // Read the mode explicitly: its value is not otherwise needed, but each
    // mode transition must trigger this sizing pass.
    void panelMode;
    if (!visible) {
      focusAfterRevealRef.current = true;
      return;
    }
    syncRef.current?.();
    // An explicit Input → Extension reveal focuses only after reconstruction
    // is acknowledged. Ordinary background publications never steal focus.
    if (focusAfterRevealRef.current && panelInputReady) {
      // Pickers close on keydown. Focusing xterm in the same task lets the
      // corresponding Kitty key-release land in the newly revealed terminal,
      // where it can start a stale input/repaint chain ahead of the user's
      // first real key. Handoff after the browser completes that key cycle and
      // recheck the exact live owner before consuming the reveal request.
      const frame = window.requestAnimationFrame(() => {
        const container = containerRef.current;
        const live = panelRef.current;
        const terminalIdentity = termPanelRef.current;
        const ownRoutedEscapeClaim = panelMode === "viewport" ? 1 : 0;
        if (
          !focusAfterRevealRef.current ||
          !visibleRef.current ||
          !container ||
          !live ||
          !terminalIdentity ||
          live.hostInstanceId !== terminalIdentity.hostInstanceId ||
          live.sessionEpoch !== terminalIdentity.sessionEpoch ||
          live.id !== terminalIdentity.id ||
          live.authority !== true ||
          live.syncState !== "following" ||
          live.inputEnabled !== true ||
          escapeClaimCount > ownRoutedEscapeClaim ||
          !mayExplicitlyFocusTerminal(container)
        )
          return;
        focusAfterRevealRef.current = false;
        termRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [escapeClaimCount, panelMode, panelInputReady, visible]);

  // A repaint-required publication is a fence, not completion. A best-effort
  // resize can be dropped, so retry with progress-aware exponential backoff.
  // The growing quiet window is load-bearing: issuing force repaints at a
  // fixed cadence can continually invalidate a valid but slow keyframe before
  // its acknowledgement reaches the host, leaving input fenced forever.
  useEffect(() => {
    if (
      !visible ||
      panelId === undefined ||
      panelHostInstanceId === undefined ||
      panelSessionEpoch === undefined ||
      panelAuthority !== true ||
      panelSyncState === "following" ||
      panelKeyframeReady === true
    )
      return;
    const identity = {
      hostInstanceId: panelHostInstanceId,
      sessionEpoch: panelSessionEpoch,
      panelId,
    };
    const repaintKey = `${identity.hostInstanceId}:${identity.sessionEpoch}:${identity.panelId}`;
    const retryState = authorityRepaintRetryStateRef.current.get(repaintKey) ?? {
      delayMs: 1_000,
      observedRenderRevision: panelRef.current?.renderRevision,
    };
    authorityRepaintRetryStateRef.current.set(repaintKey, retryState);
    let cancelled = false;
    let timer: number | undefined;
    const retry = (): void => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        const live = useSessionsStore.getState().sessions.get(sessionId)?.unifiedPanel;
        const term = termRef.current;
        const terminalIdentity = termPanelRef.current;
        if (
          !live ||
          !term ||
          !visibleRef.current ||
          !terminalIdentity ||
          live.hostInstanceId !== identity.hostInstanceId ||
          live.sessionEpoch !== identity.sessionEpoch ||
          live.id !== identity.panelId ||
          terminalIdentity.hostInstanceId !== identity.hostInstanceId ||
          terminalIdentity.sessionEpoch !== identity.sessionEpoch ||
          terminalIdentity.id !== identity.panelId ||
          live.authority !== true ||
          live.syncState === "following" ||
          live.keyframeReady === true
        )
          return;
        const nextDelayMs = Math.min(retryState.delayMs * 2, 30_000);
        // A newer revision proves that the preceding force reached the host.
        // Give its matching keyframe a full, progressively larger quiet window
        // instead of invalidating it merely because publication is slow.
        if (live.renderRevision !== retryState.observedRenderRevision) {
          retryState.observedRenderRevision = live.renderRevision;
          retryState.delayMs = nextDelayMs;
          retry();
          return;
        }
        authorityRepaintRequestRef.current = repaintKey;
        void window.pivis
          .invoke("session.panelResize", {
            sessionId,
            expectedHostInstanceId: identity.hostInstanceId,
            expectedSessionEpoch: identity.sessionEpoch,
            panelId: identity.panelId,
            cols: term.cols,
            rows: term.rows,
            force: true,
          })
          .catch(() => {
            if (authorityRepaintRequestRef.current === repaintKey) {
              authorityRepaintRequestRef.current = null;
            }
          })
          .finally(() => {
            retryState.delayMs = nextDelayMs;
            retry();
          });
      }, retryState.delayMs);
    };
    retry();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    panelHostInstanceId,
    panelId,
    panelSessionEpoch,
    panelAuthority,
    panelKeyframeReady,
    panelSyncState,
    sessionId,
    visible,
  ]);

  // One lifecycle effect: build terminal, stream data, handle input, cleanup.
  // Rebuild xterm ONLY when the panel identity changes (NOT on buffer appends).

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild terminal on panel identity change only, not buffer appends
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const currentPanel = panelRef.current;
    if (!currentPanel) return;
    const currentPanelKey = `${currentPanel.hostInstanceId}:${currentPanel.sessionEpoch}:${currentPanel.id}`;
    initialPanelSizingRef.current = currentPanelKey;
    // This lifecycle is identity-bound. Never carry blocked or buffered input
    // into a replacement owner that reuses the numeric panel id.
    let disposed = false;
    let unsubPanel: (() => void) | null = null;
    let repaintRevision = 0;
    let repaintAcknowledged = false;

    const fontFamily = resolveMonoFont();
    const { settings, activeColorScheme } = useSettingsStore.getState();
    const { fonts } = settings;
    const term = new Terminal({
      ...basePanelTerminalOptions(),
      scrollback: PANEL_SCROLLBACK_ROWS,
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: fonts?.code?.sizePx ?? 14,
      fontFamily,
      theme: buildXtermTheme(getTheme(activeColorScheme)),
    });
    termRef.current = term;
    termPanelRef.current = {
      id: currentPanel.id,
      hostInstanceId: currentPanel.hostInstanceId,
      sessionEpoch: currentPanel.sessionEpoch,
    };
    const focusBeforeOpen = document.activeElement;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    term.open(container);
    // A session/view switch destroys the renderer xterm but NOT the host-side
    // pi-tui instance. Do not let any previous terminal modes/scrollback leak
    // into the remounted surface; the first resize report below forces pi-tui
    // to repaint a complete frame into this clean terminal.
    term.reset();
    term.clear();

    // A background factory widget may appear while the user is interacting
    // with header chrome (notably while the rename button is becoming its
    // input). Do not steal any meaningful focus merely because the panel
    // mounted. When focus was on the document body we keep the convenient TUI
    // autofocus; an explicit click in the panel always focuses it.
    const focusOwnedElsewhere =
      focusBeforeOpen instanceof HTMLElement &&
      focusBeforeOpen !== document.body &&
      !container.contains(focusBeforeOpen);
    if (visibleRef.current && !focusOwnedElsewhere) term.focus();
    const refocus = () => {
      const live = panelRef.current;
      if (
        visibleRef.current &&
        live?.hostInstanceId === currentPanel.hostInstanceId &&
        live.sessionEpoch === currentPanel.sessionEpoch &&
        live.id === currentPanel.id &&
        mayExplicitlyFocusTerminal(container)
      ) {
        term.focus();
      }
    };
    container.addEventListener("mousedown", refocus);

    // The card (.unified-panel) is the visible box we clip/scroll; the mount
    // (.custom-panel__xterm) holds the terminal grid.
    const panelEl = container.parentElement as HTMLElement;
    const sessionEl = container.closest(".app__session") as HTMLElement | null;

    // Deterministic grid-tracks-content sizing (shared with CustomPanelHost —
    // see panel-sizer.ts). The grid resizes toward the content height, the card
    // hugs it capped at ~half the transcript column, and scrolls only past that
    // cap. `getMode` reads modeRef live so a viewport↔content flip (a pi-tui
    // overlay showing/hiding) reconfigures sizing without tearing down xterm.
    let forceNextResize = true;
    const sizer = createPanelSizer({
      term,
      container,
      panelEl,
      sessionEl,
      fitAddon,
      getMode: () => modeRef.current,
      // Above/editor/below need room to converge even when two startup factory
      // renders race the first size probe. The visible card still hugs measured
      // content once the complete frame arrives.
      minimumRows: 6,
      fallbackFontSize: fonts?.code?.sizePx ?? 14,
      onReportSize: (cols, rows) => {
        const firstReport = forceNextResize;
        forceNextResize = false;
        const activePanel = panelRef.current ?? currentPanel;
        if (firstReport && initialPanelSizingRef.current === currentPanelKey) {
          initialPanelSizingRef.current = null;
        }
        const repaintAlreadyInFlight =
          activePanel.authority === true &&
          (authorityRepaintRequestRef.current === currentPanelKey ||
            activePanel.outputKind === "repaint_required");
        const force = firstReport && !repaintAlreadyInFlight;
        if (force && activePanel.authority) {
          // The measured lifecycle force is the one mount-time reconstruction
          // request. A repaint_required publication means that request is
          // already in flight and therefore must not be echoed by the
          // projection effect above.
          if (authorityRepaintRequestRef.current === currentPanelKey) return;
          authorityRepaintRequestRef.current = currentPanelKey;
        }
        if (
          activePanel.authority &&
          !firstReport &&
          (activePanel.syncState !== "following" || !activePanel.inputEnabled)
        )
          return;
        void window.pivis
          .invoke("session.panelResize", {
            sessionId,
            expectedHostInstanceId: currentPanel.hostInstanceId,
            expectedSessionEpoch: currentPanel.sessionEpoch,
            panelId: currentPanel.id,
            cols,
            rows,
            ...(force ? { force: true } : {}),
          })
          .catch(() => {
            if (force && authorityRepaintRequestRef.current === currentPanelKey) {
              authorityRepaintRequestRef.current = null;
            }
            schedulePanelIpcRetry();
          });
      },
    });
    // Expose the (coalesced) sizing pass so the mode-change effect can re-run it.
    syncRef.current = sizer.scheduleSync;
    contentSyncRef.current = sizer.scheduleContentSync;

    // Replay only the store's bounded CURRENT segment (trimmed after the latest
    // hard full-screen clear), never the whole historical ANSI log. This gives
    // the sizer enough content to choose a sane first height for tall panels;
    // the first resize report still carries force:true, so the host immediately
    // replaces the replay with an authoritative complete repaint.
    const initialOutput = initialAppliedPanelOutput(currentPanel);
    appliedOutputRef.current = initialOutput;
    replayReadyRef.current = null;
    if (!initialOutput.repaintRequired) {
      for (const chunk of currentPanel.buffer) term.write(chunk);
    }
    term.write("", () => {
      if (disposed) return;
      sizer.scheduleContentSync();
      const active = panelRef.current;
      if (
        currentPanel.authority === true &&
        !initialOutput.repaintRequired &&
        active &&
        active.hostInstanceId === currentPanel.hostInstanceId &&
        active.sessionEpoch === currentPanel.sessionEpoch &&
        active.id === currentPanel.id &&
        appliedOutputRef.current === initialOutput &&
        (active.outputSequence ?? null) === initialOutput.sequence &&
        (active.renderRevision ?? null) === initialOutput.renderRevision &&
        replayReadyRef.current !== currentPanelKey
      ) {
        replayReadyRef.current = currentPanelKey;
        setReplayReadyGeneration((generation) => generation + 1);
      }
      const ackKey = `${currentPanel.hostInstanceId}:${currentPanel.sessionEpoch}:${currentPanel.id}:${currentPanel.renderRevision ?? 0}`;
      if (
        currentPanel.authority &&
        currentPanel.syncState === "synchronizing" &&
        currentPanel.keyframeReady &&
        authorityAckRef.current !== ackKey
      ) {
        authorityAckRef.current = ackKey;
        void window.pivis
          .invoke("session.panelRepaintAck", {
            sessionId,
            expectedHostInstanceId: currentPanel.hostInstanceId,
            expectedSessionEpoch: currentPanel.sessionEpoch,
            panelId: currentPanel.id,
            revision: currentPanel.renderRevision ?? 0,
          })
          .then((result) => {
            if (!result.acknowledged && authorityAckRef.current === ackKey) {
              authorityAckRef.current = null;
              schedulePanelIpcRetry();
            }
          })
          .catch(() => {
            if (authorityAckRef.current === ackKey) authorityAckRef.current = null;
            schedulePanelIpcRetry();
          });
      }
    });

    unsubPanel = window.pivis.on("session.panelEvent", ({ sessionId: eventSid, event }) => {
      if (eventSid !== sessionId) return;
      const activePanel = panelRef.current ?? currentPanel;
      if (
        !activePanel.authority &&
        event.type === "panel_data" &&
        event.panelId === currentPanel.id
      ) {
        term.write(event.data, () => {
          if (!disposed) sizer.scheduleContentSync();
        });
      }
      if (
        !activePanel.authority &&
        event.type === "panel_repaint" &&
        event.panelId === currentPanel.id
      ) {
        repaintAcknowledged = false;
        repaintRevision = event.revision;
        term.write("", () => {
          if (disposed) return;
          void window.pivis
            .invoke("session.panelRepaintAck", {
              sessionId,
              expectedHostInstanceId: currentPanel.hostInstanceId,
              expectedSessionEpoch: currentPanel.sessionEpoch,
              panelId: currentPanel.id,
              revision: repaintRevision,
            })
            .then((result) => {
              const active = panelRef.current;
              if (
                disposed ||
                !active ||
                active.hostInstanceId !== currentPanel.hostInstanceId ||
                active.sessionEpoch !== currentPanel.sessionEpoch ||
                active.id !== currentPanel.id ||
                active.authority ||
                !result.acknowledged
              )
                return;
              repaintAcknowledged = true;
              const inputIdentity = {
                hostInstanceId: currentPanel.hostInstanceId,
                sessionEpoch: currentPanel.sessionEpoch,
                panelId: currentPanel.id,
              };
              for (const chunk of releaseQueuedPanelInput(sessionId, inputIdentity, true)) {
                dispatchPanelInputRef.current?.(chunk);
              }
            })
            .catch(() => {});
        });
      }
    });

    // User keystrokes → host TUI (panelInput is shared with custom() panels).
    const dispatchPanelInput = (data: string): void => {
      const activePanel = panelRef.current;
      // React updates the live ref during render before the predecessor
      // terminal's passive cleanup. Never relabel a final predecessor key as
      // input for the successor owner/panel.
      if (
        !activePanel ||
        activePanel.hostInstanceId !== currentPanel.hostInstanceId ||
        activePanel.sessionEpoch !== currentPanel.sessionEpoch ||
        activePanel.id !== currentPanel.id
      )
        return;
      const activePanelKey = `${activePanel.hostInstanceId}:${activePanel.sessionEpoch}:${activePanel.id}`;
      const authorityReady =
        activePanel.authority === true &&
        activePanel.syncState === "following" &&
        activePanel.inputEnabled === true &&
        activePanel.renderRevision !== undefined &&
        replayReadyRef.current === activePanelKey;
      const identity = {
        hostInstanceId: activePanel.hostInstanceId,
        sessionEpoch: activePanel.sessionEpoch,
        panelId: activePanel.id,
      };
      const bufferInput = (attemptedSequence?: number): void => {
        queuePanelInput(sessionId, identity, data, attemptedSequence);
      };
      if (activePanel.authority && !authorityReady) {
        bufferInput();
        return;
      }
      if (!activePanel.authority && !repaintAcknowledged) {
        bufferInput();
        return;
      }
      if (isPanelInputBlocked(sessionId, identity)) {
        // A reconstruction may become ready while this component is hidden
        // without another projection change to drive the release effect. Drain
        // synchronously at the first post-reveal key so retained chunks, this
        // key, and the immediately-following Enter are enqueued in that order.
        bufferInput();
        for (const chunk of releaseQueuedPanelInput(
          sessionId,
          identity,
          true,
          activePanel.inputAcknowledgedThrough,
        )) {
          dispatchPanelInput(chunk);
        }
        return;
      }
      const target = {
        ...identity,
        revision: activePanel.authority ? activePanel.renderRevision! : repaintRevision,
      };
      const forceInputRecoveryRepaint = (generation: PanelInputGenerationHandle): void => {
        // Input custody belongs to the global identity sequencer, but this
        // terminal alone owns its measured grid and repaint scheduling. A
        // hidden/unmounted predecessor must leave the bytes queued for the
        // exact same-owner remount instead of issuing a resize with stale
        // dimensions or mutating a successor component's refs.
        if (disposed || !visibleRef.current || !isPanelInputGenerationCurrent(generation)) return;
        const active = useSessionsStore.getState().sessions.get(sessionId)?.unifiedPanel;
        const visiblePanel = panelRef.current;
        if (
          !active ||
          active.hostInstanceId !== target.hostInstanceId ||
          active.sessionEpoch !== target.sessionEpoch ||
          active.id !== target.panelId ||
          !visiblePanel ||
          visiblePanel.hostInstanceId !== target.hostInstanceId ||
          visiblePanel.sessionEpoch !== target.sessionEpoch ||
          visiblePanel.id !== target.panelId
        )
          return;
        const repaintKey = `${target.hostInstanceId}:${target.sessionEpoch}:${target.panelId}`;
        if (authorityRepaintRequestRef.current === repaintKey) return;
        authorityRepaintRequestRef.current = repaintKey;
        void window.pivis
          .invoke("session.panelResize", {
            sessionId,
            expectedHostInstanceId: target.hostInstanceId,
            expectedSessionEpoch: target.sessionEpoch,
            panelId: target.panelId,
            cols: term.cols,
            rows: term.rows,
            force: true,
          })
          .catch(() => {
            if (authorityRepaintRequestRef.current === repaintKey) {
              authorityRepaintRequestRef.current = null;
            }
            // Retry while this exact terminal remains visible. If it hides or
            // unmounts, the identity-owned queue survives and its successor
            // mount starts a fresh reconstruction with current dimensions.
            window.setTimeout(() => forceInputRecoveryRepaint(generation), 250);
          });
      };
      enqueuePanelInputAttempt(sessionId, identity, async (inputGeneration) => {
        // The serialized attempt can begin after this React component has
        // hidden, unmounted, or started rendering another session. Consult the
        // session store for exact authority ownership; panelRef is a visibility
        // concern and must never be allowed to discard an already-captured
        // key. Owner/panel replacement is the one terminal case where those
        // predecessor bytes are intentionally retired.
        const latest = useSessionsStore.getState().sessions.get(sessionId)?.unifiedPanel;
        if (
          !latest ||
          latest.hostInstanceId !== target.hostInstanceId ||
          latest.sessionEpoch !== target.sessionEpoch ||
          latest.id !== target.panelId
        ) {
          retirePanelInputIdentity(sessionId, identity);
          return;
        }
        const latestAuthorityReady =
          latest.authority !== true ||
          (latest.syncState === "following" &&
            latest.inputEnabled === true &&
            latest.renderRevision !== undefined);
        if (!latestAuthorityReady) {
          bufferInput();
          return;
        }
        if (isPanelInputBlocked(sessionId, identity)) {
          bufferInput();
          return;
        }
        let rebasedStaleSequence = false;
        for (;;) {
          const sequence = nextPanelInputSequence(
            sessionId,
            target.hostInstanceId,
            target.sessionEpoch,
            target.panelId,
            inputGeneration,
          );
          let result: {
            acknowledgedThrough: number;
            rejection?: "runtime_unavailable" | "runtime_replaced";
            gap?: { expected: number; received: number };
            repaintRequired?: { revision: number; repaintRequired: boolean };
          };
          try {
            result = await window.pivis.invoke("session.panelInput", {
              sessionId,
              expectedHostInstanceId: target.hostInstanceId,
              expectedSessionEpoch: target.sessionEpoch,
              panelId: target.panelId,
              revision: target.revision,
              sequence,
              data,
            });
          } catch (error) {
            if (!isPanelInputGenerationCurrent(inputGeneration)) return;
            // The identity-owned sequencer deliberately outlives this React
            // view. Preserve ambiguous delivery even if the user switched
            // sessions while IPC was pending; a later same-owner remount will
            // reconcile it against the authoritative repaint watermark.
            resetPanelInputSequenceToAcknowledged(
              sessionId,
              target.hostInstanceId,
              target.sessionEpoch,
              target.panelId,
              Math.max(0, sequence - 1),
              inputGeneration,
            );
            bufferInput(sequence);
            forceInputRecoveryRepaint(inputGeneration);
            useSessionsStore.getState().addToast(sessionId, String(error), "error");
            return;
          }
          if (!isPanelInputGenerationCurrent(inputGeneration)) return;
          if (result.rejection === "runtime_replaced") {
            // Main proved the effect-bound owner is gone. Retire the whole
            // predecessor tail; replaying it into a successor would cross
            // authority identities and can also create an unbounded stale
            // resize/input loop.
            retirePanelInputIdentity(sessionId, identity);
            return;
          }
          if (result.rejection === "runtime_unavailable") {
            // Main also proved these bytes were not forwarded, but the exact
            // owner may merely be detach-fenced or temporarily unavailable.
            // Keep this key and every queued successor with that identity;
            // same-owner reconstruction will release them from ack + 1.
            resetPanelInputSequenceToAcknowledged(
              sessionId,
              target.hostInstanceId,
              target.sessionEpoch,
              target.panelId,
              result.acknowledgedThrough,
              inputGeneration,
            );
            bufferInput();
            forceInputRecoveryRepaint(inputGeneration);
            return;
          }
          acknowledgePanelInput(
            sessionId,
            target.hostInstanceId,
            target.sessionEpoch,
            target.panelId,
            result.acknowledgedThrough,
            inputGeneration,
          );
          if (result.acknowledgedThrough > sequence) {
            // Main short-circuited this stale local sequence without forwarding
            // its bytes. Retry within the same serialized attempt at ack+1 so
            // a later Enter cannot overtake the replayed key.
            if (!rebasedStaleSequence) {
              rebasedStaleSequence = true;
              continue;
            }
            bufferInput();
            forceInputRecoveryRepaint(inputGeneration);
            return;
          }
          if (result.acknowledgedThrough < sequence) {
            resetPanelInputSequenceToAcknowledged(
              sessionId,
              target.hostInstanceId,
              target.sessionEpoch,
              target.panelId,
              result.acknowledgedThrough,
              inputGeneration,
            );
            bufferInput();
            forceInputRecoveryRepaint(inputGeneration);
          }
          if (result.gap) {
            useSessionsStore
              .getState()
              .addToast(sessionId, panelInputGapMessage(result.gap), "warning");
          }
          return;
        }
      });
    };
    dispatchPanelInputRef.current = dispatchPanelInput;
    // Preserve complete xterm chunks (user keys, routed Escape, and terminal
    // protocol replies) in order. Readiness fences IPC allocation inside the
    // dispatcher; filtering by byte length would discard valid CSI-u keys.
    const onDataDispose = term.onData(dispatchPanelInput);

    // Re-derive sizing when the transcript column resizes (window resize,
    // sidebar collapse, font change) — both cols and the display cap depend on
    // it. The column is never sized BY us, so this can't feed back.
    const resizeObserver = new ResizeObserver(() => {
      if (visibleRef.current) sizer.scheduleSync();
    });
    if (sessionEl) resizeObserver.observe(sessionEl);

    // Wait for the render service to measure cell dimensions before the first
    // sizing pass (double rAF: layout + paint).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (disposed || !visibleRef.current) return;
        sizer.sync();
      });
    });

    return () => {
      disposed = true;
      syncRef.current = null;
      contentSyncRef.current = null;
      container.removeEventListener("mousedown", refocus);
      onDataDispose.dispose();
      unsubPanel?.();
      resizeObserver.disconnect();
      sizer.dispose();
      term.dispose();
      if (dispatchPanelInputRef.current === dispatchPanelInput) {
        dispatchPanelInputRef.current = null;
      }
      if (termRef.current === term) {
        termRef.current = null;
        termPanelRef.current = null;
        fitAddonRef.current = null;
        appliedOutputRef.current = null;
        replayReadyRef.current = null;
        replayRepaintRequestRef.current = null;
        authorityRepaintRequestRef.current = null;
        if (initialPanelSizingRef.current === currentPanelKey) {
          initialPanelSizingRef.current = null;
        }
        authorityAckRef.current = null;
      }
    };
  }, [sessionId, panelId, panelHostInstanceId, panelSessionEpoch]);

  // Sidebar/session-entry focus is a surface request, even though the legacy
  // store name says Composer. Consume it only once the visible terminal can
  // accept input. This preserves the background-mount guard above
  // while allowing an explicit session click to transfer focus from its button.
  useEffect(() => {
    const request = composerFocusRequest;
    const container = containerRef.current;
    const term = termRef.current;
    if (
      !request ||
      request.sessionId !== sessionId ||
      !visible ||
      !panelFocusReady ||
      !container ||
      !term
    )
      return;
    const ownRoutedEscapeClaim = panelMode === "viewport" ? 1 : 0;
    const acceptFocus = (): boolean => {
      if (escapeClaimCount > ownRoutedEscapeClaim) return false;
      if (!mayExplicitlyFocusTerminal(container)) return false;
      term.focus();
      consumeComposerFocus(sessionId, request.nonce);
      return true;
    };
    if (acceptFocus()) return;
    // A foreign text field can release focus without changing React state.
    // Keep the one-shot request live and retry after the browser completes its
    // focus transition; overlay ownership changes still rerun this effect.
    const retry = (): void => {
      queueMicrotask(acceptFocus);
    };
    document.addEventListener("focusout", retry);
    return () => document.removeEventListener("focusout", retry);
  }, [
    composerFocusRequest,
    consumeComposerFocus,
    escapeClaimCount,
    panelFocusReady,
    panelMode,
    sessionId,
    visible,
  ]);

  return (
    <div
      className="custom-panel unified-panel"
      hidden={!visible}
      aria-hidden={!visible}
      data-sync-state={unifiedPanel?.syncState}
      data-input-enabled={panelInputReady ? "true" : "false"}
    >
      {/* No header/close button: the unified panel is persistent and the
          extension owns its lifecycle (setWidget(key, undefined) → panel_close).
          A modal-style ✕ would contradict that. */}
      <div ref={containerRef} className="custom-panel__xterm" />
    </div>
  );
}

import type { SessionId } from "@shared/ids.js";
import type {
  IntentOutcome,
  RuntimeIdentity,
  SessionIntent,
} from "@shared/pi-protocol/runtime-state.js";
import {
  type AsyncStatusSnapshotNodeV1,
  type AsyncStatusSnapshotOmittedV1,
  type AsyncStatusSnapshotState,
  type AsyncStatusSnapshotV1,
  parseSubagentAsyncSnapshot,
} from "@shared/pi-protocol/subagents.js";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { type AuthorityObservation, dispatchSessionIntent } from "../../lib/session-intent.js";
import { type SessionViewState, useSessionsStore } from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";
import {
  IconActivityRotor,
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconStop,
  IconSubagents,
} from "../common/icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import "./SubagentsFleet.css";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const STOPPABLE_STATES: readonly AsyncStatusSnapshotState[] = ["running", "queued"];

function isStoppableState(state: AsyncStatusSnapshotState): boolean {
  return STOPPABLE_STATES.includes(state);
}

function authorityObservationFor(
  session: SessionViewState | undefined,
): AuthorityObservation | undefined {
  const snapshot = session?.authorityProjection?.authoritativeSnapshot;
  const semantic = session?.authorityProjection?.semantic;
  if (!snapshot || semantic?.state !== "following") return undefined;
  return { owner: snapshot.owner, cursor: semantic.cursor };
}

function awaitIntentOutcome(
  sessionId: SessionId,
  intentId: string,
  owner: RuntimeIdentity,
  timeoutMs = 5000,
): Promise<IntentOutcome | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome?: IntentOutcome) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = useSessionsStore.subscribe(() => {
      const outcome = useSessionsStore
        .getState()
        .sessions.get(sessionId)
        ?.authorityProjection?.authoritativeSnapshot?.recentIntentOutcomes.find(
          (o) =>
            o.intentId === intentId &&
            o.owner.hostInstanceId === owner.hostInstanceId &&
            o.owner.sessionEpoch === owner.sessionEpoch,
        );
      if (outcome) finish(outcome);
    });
    const timer = globalThis.setTimeout(() => finish(undefined), timeoutMs);
  });
}

async function stopSubagentRun(
  sessionId: SessionId,
  runId: string,
  observation: AuthorityObservation,
  editorRevision: number,
): Promise<string | undefined> {
  const intent: SessionIntent = {
    kind: "invokeCommand",
    text: `/subagents-stop ${runId}`,
    editorRevision,
  };
  try {
    const receipt = await dispatchSessionIntent(sessionId, intent, observation);
    if (receipt.status === "not_admitted") {
      return `Stop not admitted: ${receipt.reason.replaceAll("_", " ")}`;
    }
    if (receipt.status === "delivery_unknown") {
      return undefined;
    }
    const outcome = await awaitIntentOutcome(sessionId, receipt.intentId, observation.owner);
    if (!outcome) return undefined;
    if (outcome.state !== "completed") {
      return outcome.error ?? "Stop failed";
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function StateBadge({ state }: { state: AsyncStatusSnapshotState }): React.ReactElement {
  const className = `subagents-fleet__badge subagents-fleet__badge--${state}`;
  let icon: React.ReactElement | null = null;
  if (state === "running") {
    icon = <IconActivityRotor size="0.75em" />;
  } else if (state === "complete") {
    icon = <IconCheck size="0.75em" />;
  } else if (state === "failed" || state === "rejected") {
    icon = <IconAlert size="0.75em" />;
  } else if (state === "paused" || state === "stopped") {
    icon = <IconStop size="0.75em" />;
  }
  return (
    <span className={className}>
      {icon}
      {state}
    </span>
  );
}

function buildOmissionNotice(
  caps: AsyncStatusSnapshotV1["caps"],
  omitted: AsyncStatusSnapshotOmittedV1,
): string | null {
  const parts: string[] = [];
  if (omitted.byteLimitExceeded) {
    parts.push(`truncated to ${formatBytes(caps.maxSerializedBytes)} budget`);
  }
  if (omitted.runs > 0) {
    parts.push(`${omitted.runs} run${omitted.runs === 1 ? "" : "s"} omitted`);
  }
  if (omitted.children > 0) {
    parts.push(`${omitted.children} nested children omitted`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function StopButton({
  confirming,
  error,
  onRequestConfirm,
  onConfirm,
  onCancel,
  title,
}: {
  confirming: boolean;
  error?: string | undefined;
  onRequestConfirm: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  title?: string;
}): React.ReactElement {
  if (confirming) {
    return (
      <span className="subagents-fleet__stop-confirm" title={title}>
        <span className="subagents-fleet__stop-confirm-label">Stop?</span>
        <button
          type="button"
          className="icon-btn subagents-fleet__stop-confirm-btn"
          aria-label="Confirm stop"
          onClick={onConfirm}
        >
          <IconCheck size="0.75em" />
        </button>
        <button
          type="button"
          className="icon-btn subagents-fleet__stop-confirm-btn"
          aria-label="Cancel"
          onClick={onCancel}
        >
          <IconClose size="0.75em" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="icon-btn subagents-fleet__stop-btn"
      aria-label={title ?? "Stop run"}
      title={title ?? "Stop run"}
      onClick={onRequestConfirm}
    >
      <IconStop size="0.75em" />
    </button>
  );
}

function StopAllButton({
  confirming,
  onRequestConfirm,
  onConfirm,
  onCancel,
}: {
  confirming: boolean;
  onRequestConfirm: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <>
      <button
        type="button"
        className="icon-btn subagents-fleet__stop-all"
        aria-label="Stop all work"
        title="Interrupt the session and stop every running subagent run"
        onClick={onRequestConfirm}
      >
        <IconStop size="0.75em" />
        <span>Stop all</span>
      </button>
      {confirming && (
        <ConfirmDialog
          title="Stop all work?"
          message="This will interrupt the current session turn and stop every running subagent run."
          tone="danger"
          initialFocus="cancel"
          confirmLabel="Stop all"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </>
  );
}

function RunNode({
  node,
  generatedAt,
  depth = 0,
  confirmingRunId,
  runErrors,
  onRequestStop,
  onConfirmStop,
  onCancelStop,
}: {
  node: AsyncStatusSnapshotNodeV1;
  generatedAt: number;
  depth?: number;
  confirmingRunId: string | null;
  runErrors: Map<string, string>;
  onRequestStop: (runId: string) => void;
  onConfirmStop: (runId: string) => void;
  onCancelStop: (runId: string) => void;
}): React.ReactElement {
  const activity = node.activity;
  const confirming = confirmingRunId === node.id;
  const error = runErrors.get(node.id);

  const durationMs =
    node.startedAt !== undefined
      ? (node.endedAt ?? node.updatedAt ?? generatedAt) - node.startedAt
      : undefined;

  const stats: { key: string; text: string }[] = [];
  if (durationMs !== undefined) {
    stats.push({ key: "duration", text: formatDuration(durationMs) });
  }
  if (activity?.currentTool !== undefined) {
    stats.push({ key: "tool", text: `tool: ${activity.currentTool}` });
  }
  if (activity?.turnCount !== undefined) {
    stats.push({
      key: "turns",
      text: `${activity.turnCount} turn${activity.turnCount === 1 ? "" : "s"}`,
    });
  }
  if (activity?.toolCount !== undefined) {
    stats.push({
      key: "tools",
      text: `${activity.toolCount} tool${activity.toolCount === 1 ? "" : "s"}`,
    });
  }

  return (
    <div className="subagents-fleet__node" style={{ paddingLeft: `${depth * 1.2}rem` }}>
      <div className="subagents-fleet__node-header">
        <StateBadge state={node.state} />
        <span className="subagents-fleet__node-kind">{node.kind}</span>
        <span className="subagents-fleet__node-label">
          <FadeText>{node.label}</FadeText>
        </span>
        {isStoppableState(node.state) && (
          <StopButton
            confirming={confirming}
            error={error}
            title={`Stop ${node.label}`}
            onRequestConfirm={() => onRequestStop(node.id)}
            onConfirm={() => onConfirmStop(node.id)}
            onCancel={() => onCancelStop(node.id)}
          />
        )}
      </div>
      {error && (
        <div className="subagents-fleet__stop-error">
          <IconAlert size="0.75em" />
          <FadeText>{error}</FadeText>
        </div>
      )}
      {node.id !== node.label && (
        <div className="subagents-fleet__node-meta">
          <FadeText>{node.id}</FadeText>
        </div>
      )}
      {stats.length > 0 && (
        <div className="subagents-fleet__node-stats">
          {stats.map((stat) => (
            <span key={stat.key}>{stat.text}</span>
          ))}
        </div>
      )}
      {node.children?.map((child) => (
        <RunNode
          key={child.id}
          node={child}
          generatedAt={generatedAt}
          depth={depth + 1}
          confirmingRunId={confirmingRunId}
          runErrors={runErrors}
          onRequestStop={onRequestStop}
          onConfirmStop={onConfirmStop}
          onCancelStop={onCancelStop}
        />
      ))}
    </div>
  );
}

interface SubagentsFleetProps {
  sessionId: SessionId;
  lines: string[];
}

/**
 * Render the pi-subagents live fleet for the `subagent-async` widget.
 *
 * Parses the latest `PI_SUBAGENT_ASYNC_JSON:` line and displays the run tree
 * with state badges, the node label, derived duration, activity counters, and
 * stop affordances for running/queued runs. A session-level "Stop all" header
 * control interrupts the main session turn and stops every active top-level run.
 *
 * Malformed payloads are ignored so the panel never crashes on bad extension
 * output, and a previously valid snapshot is kept so a transient malformed
 * update does not blank the panel. Clearing the widget lines (retract) resets
 * to the empty state. The panel never fakes local state transitions; run
 * states update only from the next valid widget snapshot.
 */
export function SubagentsFleet({ sessionId, lines }: SubagentsFleetProps): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const observation = authorityObservationFor(session);
  const editorRevision = session?.editorRevision ?? 0;
  const isMainStreaming =
    session?.authorityProjection?.authoritativeSnapshot?.sdk.isStreaming ?? false;

  const currentSnapshot = parseSubagentAsyncSnapshot(lines);
  const lastGoodRef = useRef<AsyncStatusSnapshotV1 | undefined>(currentSnapshot);

  if (currentSnapshot !== undefined) {
    lastGoodRef.current = currentSnapshot;
  } else if (lines.length === 0) {
    lastGoodRef.current = undefined;
  }

  const snapshot = currentSnapshot ?? lastGoodRef.current;
  const hasRuns = snapshot && snapshot.runs.length > 0;
  const omissionNotice = snapshot ? buildOmissionNotice(snapshot.caps, snapshot.omitted) : null;
  const [collapsed, setCollapsed] = useState(false);
  const [confirmingRunId, setConfirmingRunId] = useState<string | null>(null);
  const [runErrors, setRunErrors] = useState<Map<string, string>>(new Map());
  const [stopAllConfirming, setStopAllConfirming] = useState(false);
  const [stopAllError, setStopAllError] = useState<string | null>(null);

  const setRunError = useCallback((runId: string, message: string) => {
    setRunErrors((prev) => {
      const next = new Map(prev);
      next.set(runId, message);
      return next;
    });
  }, []);

  const requestStop = useCallback(
    (runId: string) => {
      setConfirmingRunId(runId);
      setRunErrors((prev) => {
        if (!prev.has(runId)) return prev;
        const next = new Map(prev);
        next.delete(runId);
        return next;
      });
    },
    [],
  );

  const cancelStop = useCallback(
    (runId: string) => {
      if (confirmingRunId === runId) setConfirmingRunId(null);
    },
    [confirmingRunId],
  );

  const confirmStop = useCallback(
    async (runId: string) => {
      setConfirmingRunId(null);
      if (!observation) {
        setRunError(runId, "Session is not ready");
        return;
      }
      const error = await stopSubagentRun(sessionId, runId, observation, editorRevision);
      if (error) setRunError(runId, error);
    },
    [sessionId, observation, editorRevision, setRunError],
  );

  const activeCount = snapshot
    ? snapshot.runs.filter((run) => isStoppableState(run.state)).length
    : 0;
  const summary = hasRuns
    ? activeCount > 0
      ? `${activeCount} active`
      : `${snapshot!.runs.length} run${snapshot!.runs.length === 1 ? "" : "s"}`
    : "No active subagent runs";

  const showStopAll = isMainStreaming || activeCount > 0;

  const handleStopAll = useCallback(async () => {
    setStopAllConfirming(false);
    setStopAllError(null);
    if (!observation) {
      setStopAllError("Session is not ready");
      return;
    }
    try {
      useSessionsStore.getState().abortSession(sessionId);
      const activeRuns = snapshot?.runs.filter((run) => isStoppableState(run.state)) ?? [];
      const errors: string[] = [];
      for (const run of activeRuns) {
        const error = await stopSubagentRun(sessionId, run.id, observation, editorRevision);
        if (error) errors.push(`${run.label}: ${error}`);
      }
      if (errors.length > 0) setStopAllError(errors.join("; "));
    } catch (error) {
      setStopAllError(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId, observation, editorRevision, snapshot]);

  return (
    <div className="subagents-fleet">
      <div className="subagents-fleet__header">
        <button
          type="button"
          className="subagents-fleet__header-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <IconSubagents size="1em" />
          <span>Subagents</span>
          <span className="subagents-fleet__summary">{summary}</span>
          {collapsed ? <IconChevronRight size="1em" /> : <IconChevronDown size="1em" />}
        </button>
        {showStopAll && (
          <StopAllButton
            confirming={stopAllConfirming}
            onRequestConfirm={() => setStopAllConfirming(true)}
            onConfirm={handleStopAll}
            onCancel={() => setStopAllConfirming(false)}
          />
        )}
      </div>
      {!collapsed && stopAllError && (
        <div className="subagents-fleet__stop-all-error">
          <IconAlert size="0.75em" />
          <FadeText>{stopAllError}</FadeText>
        </div>
      )}
      {!collapsed && omissionNotice && (
        <div
          className={`subagents-fleet__notice ${
            snapshot?.omitted.byteLimitExceeded ? "subagents-fleet__notice--warning" : ""
          }`}
        >
          {omissionNotice}
        </div>
      )}
      {!collapsed &&
        (hasRuns ? (
          <div className="subagents-fleet__runs">
            {snapshot!.runs.map((run) => (
              <RunNode
                key={run.id}
                node={run}
                generatedAt={snapshot!.generatedAt}
                confirmingRunId={confirmingRunId}
                runErrors={runErrors}
                onRequestStop={requestStop}
                onConfirmStop={confirmStop}
                onCancelStop={cancelStop}
              />
            ))}
          </div>
        ) : (
          <div className="subagents-fleet__empty">No active subagent runs</div>
        ))}
    </div>
  );
}

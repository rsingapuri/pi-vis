import {
  type AsyncStatusSnapshotNodeV1,
  type AsyncStatusSnapshotOmittedV1,
  type AsyncStatusSnapshotState,
  type AsyncStatusSnapshotV1,
  parseSubagentAsyncSnapshot,
} from "@shared/pi-protocol/subagents.js";
import type React from "react";
import { useRef, useState } from "react";
import { FadeText } from "../common/FadeText.js";
import {
  IconActivityRotor,
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconStop,
  IconSubagents,
} from "../common/icons.js";
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

function RunNode({
  node,
  generatedAt,
  depth = 0,
}: {
  node: AsyncStatusSnapshotNodeV1;
  generatedAt: number;
  depth?: number;
}): React.ReactElement {
  const activity = node.activity;

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
      </div>
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
        <RunNode key={child.id} node={child} generatedAt={generatedAt} depth={depth + 1} />
      ))}
    </div>
  );
}

interface SubagentsFleetProps {
  lines: string[];
}

/**
 * Render the pi-subagents live fleet for the `subagent-async` widget.
 *
 * Parses the latest `PI_SUBAGENT_ASYNC_JSON:` line and displays the run tree
 * with state badges, the node label, derived duration, and activity counters.
 * Malformed payloads are ignored so the panel never crashes on bad extension
 * output, and a previously valid snapshot is kept so a transient malformed
 * update does not blank the panel. Clearing the widget lines (retract) resets
 * to the empty state.
 */
export function SubagentsFleet({ lines }: SubagentsFleetProps): React.ReactElement {
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
  const activeCount = snapshot
    ? snapshot.runs.filter((run) => run.state === "running" || run.state === "queued").length
    : 0;
  const summary = hasRuns
    ? activeCount > 0
      ? `${activeCount} active`
      : `${snapshot!.runs.length} run${snapshot!.runs.length === 1 ? "" : "s"}`
    : "No active subagent runs";

  return (
    <div className="subagents-fleet">
      <button
        type="button"
        className="subagents-fleet__header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <IconSubagents size="1em" />
        <span>Subagents</span>
        <span className="subagents-fleet__summary">{summary}</span>
        {collapsed ? <IconChevronRight size="1em" /> : <IconChevronDown size="1em" />}
      </button>
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
              <RunNode key={run.id} node={run} generatedAt={snapshot!.generatedAt} />
            ))}
          </div>
        ) : (
          <div className="subagents-fleet__empty">No active subagent runs</div>
        ))}
    </div>
  );
}

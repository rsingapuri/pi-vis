// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type {
  IntentEnvelope,
  IntentOutcome,
  RuntimeIdentity,
  SemanticSnapshot,
} from "@shared/pi-protocol/runtime-state.js";
import { type ReactElement, act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type RendererAuthorityState,
  createRendererAuthorityState,
} from "../../stores/authority-reducer.js";
import { useOverlayStore } from "../../stores/overlay-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { AppPickerHost } from "./AppPickerHost.js";

const SESSION_ID = "trust-session" as SessionId;
const OWNER: RuntimeIdentity = {
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  sessionEpoch: 1,
};

function mount(node: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => flushSync(() => root.render(node)));
  return {
    container,
    unmount: () => {
      act(() => flushSync(() => root.unmount()));
      container.remove();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function installRuntime(): void {
  useSessionsStore.setState({
    sessions: new Map(),
    workspaces: new Map(),
    activeSessionId: null,
    activeWorkspacePath: null,
  });
  useSessionsStore.getState().createSession(SESSION_ID, "/workspace", "/session.jsonl");
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID)!;
    const cursor = {
      ...OWNER,
      transportSequence: 1,
      snapshotSequence: 1,
    };
    const snapshot: SemanticSnapshot = {
      owner: OWNER,
      snapshotSequence: 1,
      capturedAt: 1,
      sdk: {
        isStreaming: false,
        isIdle: true,
        isCompacting: false,
        isRetrying: false,
        retryAttempt: 0,
        isBashRunning: false,
      },
      activity: {},
      queues: { steering: [], followUp: [], steeringIntentIds: [], followUpIntentIds: [] },
      custody: [],
      editor: { revision: 0, text: "", attachments: [] },
      activeIntents: [],
      recentIntentOutcomes: [],
      recentObservedOperations: [],
      operationJournalLowWatermark: 0,
      operationJournalHighWatermark: 0,
      operationJournalTruncated: false,
      model: null,
      thinkingLevel: "off",
      catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
    };
    const authorityProjection: RendererAuthorityState = {
      ...createRendererAuthorityState(),
      owner: OWNER,
      semantic: { state: "following", cursor },
      authoritativeSnapshot: snapshot,
    };
    sessions.set(SESSION_ID, {
      ...session,
      status: "ready",
      hostInstanceId: OWNER.hostInstanceId,
      sessionEpoch: OWNER.sessionEpoch,
      authorityProjection,
    });
    return { sessions };
  });
  useSessionsStore.getState().openPicker(SESSION_ID, {
    kind: "trust",
    cwd: "/workspace/project",
    savedDecision: null,
    projectTrusted: false,
    options: [
      {
        label: "Trust parent folder (/workspace)",
        trusted: true,
        updates: [
          { path: "/workspace", decision: true },
          { path: "/workspace/project", decision: null },
        ],
      },
      {
        label: "Do not trust",
        trusted: false,
        updates: [{ path: "/workspace/project", decision: false }],
      },
    ],
    expectedHostInstanceId: OWNER.hostInstanceId,
    expectedSessionEpoch: OWNER.sessionEpoch,
  });
}

function publishTrustOutcome(envelope: IntentEnvelope): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID)!;
    const projection = session.authorityProjection!;
    const snapshot = projection.authoritativeSnapshot!;
    const outcome: IntentOutcome = {
      intentId: envelope.intentId,
      owner: OWNER,
      kind: "setTrust",
      state: "completed",
      result: { trusted: true, persisted: true },
    };
    sessions.set(SESSION_ID, {
      ...session,
      authorityProjection: {
        ...projection,
        semantic: {
          state: "following",
          cursor: {
            ...OWNER,
            transportSequence: 3,
            snapshotSequence: 3,
          },
        },
        authoritativeSnapshot: {
          ...snapshot,
          snapshotSequence: 3,
          recentIntentOutcomes: [...snapshot.recentIntentOutcomes, outcome],
        },
      },
    });
    return { sessions };
  });
}

describe("AppPickerHost trust selection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useOverlayStore.setState({ claims: [], count: 0 });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts the admission cursor advance, saves the exact option, then reloads", async () => {
    installRuntime();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const intents: IntentEnvelope[] = [];
    Object.defineProperty(window, "pivis", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string, payload: unknown) => {
          expect(channel).toBe("session.dispatchIntent");
          const envelope = payload as IntentEnvelope;
          intents.push(envelope);
          if (envelope.intent.kind === "setTrust") publishTrustOutcome(envelope);
          return { status: "admitted", intentId: envelope.intentId, owner: OWNER };
        }),
      },
    });

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const option = [...view.container.querySelectorAll<HTMLButtonElement>(".picker__item")].find(
      (button) => button.textContent?.includes("Trust parent folder"),
    );
    expect(option).toBeTruthy();
    await act(async () => option!.click());
    await settle();

    expect(intents.map((envelope) => envelope.intent)).toEqual([
      {
        kind: "setTrust",
        optionLabel: "Trust parent folder (/workspace)",
      },
      { kind: "reload" },
    ]);
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker).toBeUndefined();
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.toasts).toEqual([]);
    view.unmount();
  });

  it("uses Enter to save the highlighted exact option, reload, and close", async () => {
    installRuntime();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const intents: IntentEnvelope[] = [];
    Object.defineProperty(window, "pivis", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string, payload: unknown) => {
          expect(channel).toBe("session.dispatchIntent");
          const envelope = payload as IntentEnvelope;
          intents.push(envelope);
          if (envelope.intent.kind === "setTrust") publishTrustOutcome(envelope);
          return { status: "admitted", intentId: envelope.intentId, owner: OWNER };
        }),
      },
    });

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const list = view.container.querySelector<HTMLElement>(
      "[role=listbox][aria-label='Trust options']",
    );
    expect(list).toBeTruthy();
    await act(async () => {
      list!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(intents.map((envelope) => envelope.intent)).toEqual([
      {
        kind: "setTrust",
        optionLabel: "Trust parent folder (/workspace)",
      },
      { kind: "reload" },
    ]);
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker).toBeUndefined();
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.toasts).toEqual([]);
    view.unmount();
  });
});

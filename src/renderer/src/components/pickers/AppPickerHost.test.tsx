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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

function publishPickerOutcome(
  envelope: IntentEnvelope,
  state: "completed" | "failed" = "completed",
  error?: string,
): void {
  if (envelope.intent.kind !== "setModel" && envelope.intent.kind !== "setThinking") {
    throw new Error(`unexpected picker intent: ${envelope.intent.kind}`);
  }
  useSessionsStore.setState((store) => {
    const sessions = new Map(store.sessions);
    const session = sessions.get(SESSION_ID)!;
    const projection = session.authorityProjection!;
    const snapshot = projection.authoritativeSnapshot!;
    const base = {
      intentId: envelope.intentId,
      owner: OWNER,
      state,
      ...(error ? { error } : {}),
    } as const;
    const outcome: IntentOutcome =
      envelope.intent.kind === "setModel"
        ? { ...base, kind: "setModel" }
        : { ...base, kind: "setThinking" };
    sessions.set(SESSION_ID, {
      ...session,
      authorityProjection: {
        ...projection,
        authoritativeSnapshot: {
          ...snapshot,
          recentIntentOutcomes: [...snapshot.recentIntentOutcomes, outcome],
        },
      },
    });
    return { sessions };
  });
}

function installModelThinkingState(): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID)!;
    const projection = session.authorityProjection!;
    sessions.set(SESSION_ID, {
      ...session,
      availableModels: [
        { provider: "openai", id: "gpt-6-astra", name: "GPT-6 Astra" },
        { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
      ],
      authorityProjection: {
        ...projection,
        authoritativeSnapshot: {
          ...projection.authoritativeSnapshot!,
          model: { provider: "openai", id: "gpt-6-astra" },
          thinkingLevel: "medium",
          availableThinkingLevels: ["off", "low", "medium", "high", "max"],
        },
      },
    });
    return { sessions };
  });
}

function installPickerBrowser(
  intents: IntentEnvelope[],
  respond: (envelope: IntentEnvelope) => unknown = (envelope) => {
    publishPickerOutcome(envelope);
    return {
      status: "admitted",
      intentId: envelope.intentId,
      owner: OWNER,
    };
  },
): void {
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
  Object.defineProperty(window, "pivis", {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string, payload: unknown) => {
        expect(channel).toBe("session.dispatchIntent");
        const envelope = payload as IntentEnvelope;
        intents.push(envelope);
        return respond(envelope);
      }),
    },
  });
}

describe("AppPickerHost pinned-Pi model/thinking defaults", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useOverlayStore.setState({ claims: [], count: 0 });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses Ctrl+S to persist the highlighted model through a typed intent", async () => {
    installRuntime();
    installModelThinkingState();
    useSessionsStore.getState().openPicker(SESSION_ID, { kind: "model" });
    const intents: IntentEnvelope[] = [];
    installPickerBrowser(intents);

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const input = view.container.querySelector<HTMLInputElement>(".picker__search-input");
    expect(input).toBeTruthy();
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(intents.map((envelope) => envelope.intent)).toContainEqual({
      kind: "setModel",
      provider: "openai",
      modelId: "gpt-6-astra",
      persist: true,
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker).toBeUndefined();
    view.unmount();
  });

  it("keeps the model picker open, reports failed admission, and dispatches only once", async () => {
    installRuntime();
    installModelThinkingState();
    useSessionsStore.getState().openPicker(SESSION_ID, { kind: "model" });
    const intents: IntentEnvelope[] = [];
    installPickerBrowser(intents, (envelope) => ({
      status: "not_admitted",
      intentId: envelope.intentId,
      reason: "busy",
    }));

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const input = view.container.querySelector<HTMLInputElement>(".picker__search-input");
    expect(input).toBeTruthy();
    await act(async () => {
      const save = () =>
        input!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      save();
      save();
    });
    await settle();

    expect(intents).toHaveLength(1);
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker?.kind).toBe("model");
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.toasts.at(-1)).toMatchObject({
      message: "Failed to request model change",
      type: "error",
    });
    view.unmount();
  });

  it("applies an exact /thinking argument session-only without showing a picker", async () => {
    installRuntime();
    installModelThinkingState();
    useSessionsStore.getState().openPicker(SESSION_ID, { kind: "thinking", search: "HIGH" });
    const intents: IntentEnvelope[] = [];
    installPickerBrowser(intents);

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    await settle();

    expect(intents.map((envelope) => envelope.intent)).toContainEqual({
      kind: "setThinking",
      level: "high",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker).toBeUndefined();
    view.unmount();
  });

  it("keeps the thinking picker open when admitted persistence fails terminally", async () => {
    installRuntime();
    installModelThinkingState();
    useSessionsStore.getState().openPicker(SESSION_ID, { kind: "thinking" });
    const intents: IntentEnvelope[] = [];
    installPickerBrowser(intents, (envelope) => {
      publishPickerOutcome(envelope, "failed", "Settings write failed");
      return { status: "admitted", intentId: envelope.intentId, owner: OWNER };
    });

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const input = view.container.querySelector<HTMLInputElement>(".picker__search-input");
    expect(input).toBeTruthy();
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(intents).toHaveLength(1);
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker?.kind).toBe(
      "thinking",
    );
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.toasts.at(-1)).toMatchObject({
      message: "Settings write failed",
      type: "error",
    });
    view.unmount();
  });

  it("rejects an unknown /thinking argument with Pi's available-level guidance", async () => {
    installRuntime();
    installModelThinkingState();
    useSessionsStore.getState().openPicker(SESSION_ID, {
      kind: "thinking",
      search: "impossible",
    });
    const intents: IntentEnvelope[] = [];
    installPickerBrowser(intents);

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    await settle();

    expect(intents).toEqual([]);
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.toasts.at(-1)?.message).toContain(
      'Unknown thinking level "impossible". Available levels: off, low, medium, high, max.',
    );
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker).toBeUndefined();
    view.unmount();
  });

  it("uses Ctrl+S to persist the highlighted thinking level", async () => {
    installRuntime();
    installModelThinkingState();
    useSessionsStore.getState().openPicker(SESSION_ID, { kind: "thinking" });
    const intents: IntentEnvelope[] = [];
    installPickerBrowser(intents);

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const input = view.container.querySelector<HTMLInputElement>(".picker__search-input");
    expect(input).toBeTruthy();
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(intents.map((envelope) => envelope.intent)).toContainEqual({
      kind: "setThinking",
      level: "medium",
      persist: true,
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker).toBeUndefined();
    view.unmount();
  });
});

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
    await act(async () => {
      option!.click();
      option!.click();
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

  it("does not let a stale trust completion reload a successor picker", async () => {
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
        invoke: vi.fn(async (_channel: string, payload: unknown) => {
          const envelope = payload as IntentEnvelope;
          intents.push(envelope);
          return { status: "admitted", intentId: envelope.intentId, owner: OWNER };
        }),
      },
    });

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const option = [...view.container.querySelectorAll<HTMLButtonElement>(".picker__item")].find(
      (button) => button.textContent?.includes("Trust parent folder"),
    );
    await act(async () => {
      option!.click();
      await Promise.resolve();
    });
    expect(intents).toHaveLength(1);
    expect(intents[0]!.intent.kind).toBe("setTrust");

    act(() => {
      const cancel = view.container.querySelector<HTMLButtonElement>(".picker__btn--cancel");
      cancel!.click();
      installModelThinkingState();
      useSessionsStore.getState().openPicker(SESSION_ID, { kind: "model" });
    });
    await act(async () => {
      publishTrustOutcome(intents[0]!);
      await Promise.resolve();
    });
    await settle();

    expect(intents.map((envelope) => envelope.intent.kind)).not.toContain("reload");
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker?.kind).toBe("model");
    view.unmount();
  });
});

describe("AppPickerHost once-only picker activation", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useOverlayStore.setState({ claims: [], count: 0 });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dispatches one typed fork continuation when Enter and click race", async () => {
    installRuntime();
    useSessionsStore.getState().openPicker(SESSION_ID, {
      kind: "fork",
      messages: [{ entryId: "entry-1", text: "Choose me" }],
      sourceSurface: "unified",
    });
    const intents: IntentEnvelope[] = [];
    const receipt = deferred<unknown>();
    installPickerBrowser(intents, () => receipt.promise);

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const picker = view.container.querySelector<HTMLElement>(".picker--fork");
    const row = view.container.querySelector<HTMLButtonElement>(".picker__item");
    expect(picker).toBeTruthy();
    expect(row).toBeTruthy();
    await act(async () => {
      picker!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      row!.click();
      await Promise.resolve();
    });

    expect(intents.map((envelope) => envelope.intent)).toEqual([
      {
        kind: "pickerAction",
        selection: { action: "fork", entryId: "entry-1" },
        surface: "unified",
      },
    ]);
    receipt.resolve({ status: "admitted", intentId: intents[0]!.intentId, owner: OWNER });
    await settle();
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker).toBeUndefined();
    view.unmount();
  });

  it("starts one login intent when keyboard and pointer activation race", async () => {
    installRuntime();
    useSessionsStore.getState().openPicker(SESSION_ID, {
      kind: "login",
      providers: [
        {
          id: "provider-a",
          name: "Provider A",
          configured: false,
          methods: ["oauth"],
        },
      ],
    });
    const intents: IntentEnvelope[] = [];
    const receipt = deferred<unknown>();
    installPickerBrowser(intents, () => receipt.promise);

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const input = view.container.querySelector<HTMLInputElement>(".picker__search-input");
    const row = view.container.querySelector<HTMLButtonElement>(".picker__item");
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      row!.click();
      await Promise.resolve();
    });

    expect(intents.map((envelope) => envelope.intent)).toEqual([
      { kind: "loginProvider", providerId: "provider-a", authType: "oauth" },
    ]);
    receipt.resolve({ status: "admitted", intentId: intents[0]!.intentId, owner: OWNER });
    await settle();
    view.unmount();
  });

  it("opens a resume target once when keyboard and pointer activation race", async () => {
    installRuntime();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const target = {
      filePath: "/workspace/target.jsonl",
      id: "target",
      name: "Target",
      mtime: 1,
      preview: "Target preview",
      messageCount: 2,
      cwd: "/workspace",
    };
    useSessionsStore.getState().openPicker(SESSION_ID, { kind: "resume", sessions: [target] });
    const opening = deferred<SessionId | null>();
    const openSessionTab = vi
      .spyOn(useSessionsStore.getState(), "openSessionTab")
      .mockImplementation(() => opening.promise);

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const input = view.container.querySelector<HTMLInputElement>(".picker__search-input");
    const row = view.container.querySelector<HTMLButtonElement>(".picker__item");
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      row!.click();
      await Promise.resolve();
    });

    expect(openSessionTab).toHaveBeenCalledOnce();
    expect(openSessionTab).toHaveBeenCalledWith("/workspace", target.filePath, {
      focus: true,
      requestComposerFocus: true,
    });
    opening.resolve(null);
    await settle();
    view.unmount();
  });

  it("does not release a picker fence after ambiguous delivery", async () => {
    installRuntime();
    installModelThinkingState();
    useSessionsStore.getState().openPicker(SESSION_ID, { kind: "model" });
    const intents: IntentEnvelope[] = [];
    installPickerBrowser(intents, (envelope) => ({
      status: "delivery_unknown",
      intentId: envelope.intentId,
      reason: "transport_unavailable",
    }));

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const input = view.container.querySelector<HTMLInputElement>(".picker__search-input");
    const activate = () =>
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    await act(async () => activate());
    await settle();
    await act(async () => activate());
    await settle();

    expect(intents.filter((envelope) => envelope.intent.kind === "setModel")).toHaveLength(1);
    view.unmount();

    const remounted = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const remountedInput =
      remounted.container.querySelector<HTMLInputElement>(".picker__search-input");
    await act(async () => {
      remountedInput!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(intents.filter((envelope) => envelope.intent.kind === "setModel")).toHaveLength(1);
    remounted.unmount();
  });
});

describe("AppPickerHost scoped model selection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useOverlayStore.setState({ claims: [], count: 0 });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows an unavailable saved model and lets the user remove it", async () => {
    installRuntime();
    useSessionsStore.getState().openPicker(SESSION_ID, {
      kind: "scoped-models",
      models: [
        { provider: "p", id: "m", name: "Model M" },
        { provider: "q", id: "n", name: "Model N" },
      ],
      enabledIds: ["p/m", "gone/retired"],
    });
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
        invoke: vi.fn(async (_channel: string, payload: unknown) => {
          const envelope = payload as IntentEnvelope;
          intents.push(envelope);
          return { status: "admitted", intentId: envelope.intentId, owner: OWNER };
        }),
      },
    });

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const unavailable = [
      ...view.container.querySelectorAll<HTMLButtonElement>(".picker__item"),
    ].find((button) => button.textContent?.includes("gone/retired"));
    expect(unavailable).toBeTruthy();
    expect(unavailable?.textContent).toContain("Unavailable");

    await act(async () => unavailable!.click());
    const save = [...view.container.querySelectorAll<HTMLButtonElement>(".picker__btn")].find(
      (button) => button.textContent === "Save to settings",
    );
    await act(async () => {
      save!.click();
      save!.click();
    });
    await settle();

    expect(intents.map((envelope) => envelope.intent)).toEqual([
      {
        kind: "pickerAction",
        selection: { action: "setScopedModels", enabledIds: ["p/m"], persist: true },
        surface: "composer",
      },
    ]);
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingPicker).toBeUndefined();
    view.unmount();
  });

  it("preserves an unavailable saved model when saving without toggling", async () => {
    installRuntime();
    useSessionsStore.getState().openPicker(SESSION_ID, {
      kind: "scoped-models",
      models: [
        { provider: "p", id: "m", name: "Model M" },
        { provider: "q", id: "n", name: "Model N" },
      ],
      enabledIds: ["p/m", "gone/retired"],
    });
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
        invoke: vi.fn(async (_channel: string, payload: unknown) => {
          const envelope = payload as IntentEnvelope;
          intents.push(envelope);
          return { status: "admitted", intentId: envelope.intentId, owner: OWNER };
        }),
      },
    });

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const save = [...view.container.querySelectorAll<HTMLButtonElement>(".picker__btn")].find(
      (button) => button.textContent === "Save to settings",
    );
    await act(async () => save!.click());
    await settle();

    expect(intents.map((envelope) => envelope.intent)).toEqual([
      {
        kind: "pickerAction",
        selection: {
          action: "setScopedModels",
          enabledIds: ["p/m", "gone/retired"],
          persist: true,
        },
        surface: "composer",
      },
    ]);
    view.unmount();
  });

  it("encodes whitespace and commas in unavailable patterns without changing them", async () => {
    installRuntime();
    useSessionsStore.getState().openPicker(SESSION_ID, {
      kind: "scoped-models",
      models: [
        { provider: "p", id: "m", name: "Model M" },
        { provider: "q", id: "n", name: "Model N" },
      ],
      enabledIds: ["p/m", "Old Claude, Model"],
    });
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
        invoke: vi.fn(async (_channel: string, payload: unknown) => {
          const envelope = payload as IntentEnvelope;
          intents.push(envelope);
          return { status: "admitted", intentId: envelope.intentId, owner: OWNER };
        }),
      },
    });

    const view = mount(<AppPickerHost sessionId={SESSION_ID} />);
    const save = [...view.container.querySelectorAll<HTMLButtonElement>(".picker__btn")].find(
      (button) => button.textContent === "Save to settings",
    );
    await act(async () => save!.click());
    await settle();

    expect(intents.map((envelope) => envelope.intent)).toEqual([
      {
        kind: "pickerAction",
        selection: {
          action: "setScopedModels",
          enabledIds: ["p/m", "Old Claude, Model"],
          persist: true,
        },
        surface: "composer",
      },
    ]);
    view.unmount();
  });
});

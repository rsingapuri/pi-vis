import { AsyncLocalStorage } from "node:async_hooks";
import { createStateAuthority } from "./state-authority.mjs";

/**
 * pi-session-host: Command/event bridge between Electron main and pi SDK.
 *
 * This module:
 * 1. Translates pi-vis commands → AgentSession / AgentSessionRuntime methods
 * 2. Forwards AgentSession events → main process via process.send()
 * 3. Handles session lifecycle (newSession, fork, switchSession) with rebind
 *
 * Response shapes remain compatible with the renderer's typed command surface.
 * Every command the renderer emits is handled here; method signatures are
 * verified against the installed
 * pi's .d.ts (AgentSession getters/methods, ExtensionRunner.getRegisteredCommands,
 * SessionManager.getLeafId, and the public model runtime/registry surfaces).
 */

/**
 * Pi 0.80.8 replaced AgentSession.modelRegistry with modelRuntime. Production
 * still supports the public 0.80.6 SDK, so keep that release difference behind
 * one bridge-local adapter rather than importing either implementation's
 * internals or forcing the test-only pin to become the production minimum.
 */
function modelAccess(session) {
  if (session?.modelRuntime) {
    const runtime = session.modelRuntime;
    return {
      getAvailable: () => runtime.getAvailable(),
      getModel: (provider, modelId) => runtime.getModel(provider, modelId),
      refresh: () => runtime.refresh(),
      logout: (provider) => runtime.logout(provider),
      listCredentials: () => runtime.listCredentials(),
      getProviders: () => runtime.getProviders?.() ?? [],
      login: (providerId, authType, interaction) =>
        runtime.login(providerId, authType, interaction),
      getProviderName: (provider) => {
        try {
          return runtime.getProvider?.(provider)?.name ?? provider;
        } catch {
          return provider;
        }
      },
    };
  }

  const registry = session?.modelRegistry;
  return {
    getAvailable: () => registry.getAvailable(),
    getModel: (provider, modelId) => registry.find(provider, modelId),
    refresh: async () => registry.refresh(),
    logout: async (provider) => {
      registry.authStorage.logout(provider);
      registry.refresh();
    },
    listCredentials: async () => {
      const credentials = [];
      for (const providerId of registry.authStorage.list()) {
        try {
          const credential = registry.authStorage.get(providerId);
          if (credential) credentials.push({ providerId, type: credential.type });
        } catch {
          // One unreadable credential must not hide other logout options.
        }
      }
      return credentials;
    },
    getProviders: () => [],
    login: async () => {
      throw new Error("Native provider login is unavailable");
    },
    getProviderName: (provider) => {
      try {
        return registry.getProviderDisplayName?.(provider) ?? provider;
      } catch {
        return provider;
      }
    },
  };
}

/**
 * Fail fast if the installed pi is missing any SDK surface this bridge calls.
 *
 * The host is plain .mjs (not type-checked against pi's .d.ts), so a method
 * pi renames in a future release would otherwise surface as a cryptic crash
 * mid-session. Verifying the surface at startup turns that into a clean throw
 * during initialization. Keep this list in sync with the methods/getters used
 * below and in host.mjs.
 */
export function assertHostCapabilities(session, runtime) {
  const missing = [];
  const fn = (obj, name, label) => {
    if (!obj || typeof obj[name] !== "function") missing.push(label);
  };

  for (const m of [
    "prompt",
    "steer",
    "followUp",
    "abort",
    "abortCompaction",
    "abortBranchSummary",
    "abortRetry",
    "abortBash",
    "clearQueue",
    "navigateTree",
    "setModel",
    "setThinkingLevel",
    "executeBash",
    "compact",
    "getSessionStats",
    "getLastAssistantText",
    "exportToHtml",
    "getUserMessagesForForking",
    "setSessionName",
    "subscribe",
    "bindExtensions",
    "reload",
    "getSteeringMessages",
    "getFollowUpMessages",
  ]) {
    fn(session, m, `session.${m}`);
  }
  if (session?.modelRuntime) {
    for (const m of ["getAvailable", "getModel", "refresh", "logout", "listCredentials"]) {
      fn(session.modelRuntime, m, `session.modelRuntime.${m}`);
    }
  } else {
    for (const m of ["getAvailable", "find", "refresh"]) {
      fn(session?.modelRegistry, m, `session.modelRegistry.${m}`);
    }
    for (const m of ["logout", "list", "get"]) {
      fn(session?.modelRegistry?.authStorage, m, `session.modelRegistry.authStorage.${m}`);
    }
  }
  fn(session?.extensionRunner, "getCommand", "session.extensionRunner.getCommand");
  fn(
    session?.extensionRunner,
    "getRegisteredCommands",
    "session.extensionRunner.getRegisteredCommands",
  );
  fn(session?.resourceLoader, "getSkills", "session.resourceLoader.getSkills");
  fn(session?.sessionManager, "getLeafId", "session.sessionManager.getLeafId");
  fn(session?.sessionManager, "getBranch", "session.sessionManager.getBranch");

  for (const m of [
    "newSession",
    "fork",
    "switchSession",
    "setRebindSession",
    "setBeforeSessionInvalidate",
    "dispose",
  ]) {
    fn(runtime, m, `runtime.${m}`);
  }

  // Getters read by getState(); presence (not callability) is what matters.
  for (const g of [
    "model",
    "thinkingLevel",
    "isStreaming",
    "isIdle",
    "isCompacting",
    "isRetrying",
    "retryAttempt",
    "isBashRunning",
    "steeringMode",
    "followUpMode",
    "sessionFile",
    "sessionId",
    "sessionName",
    "autoCompactionEnabled",
    "messages",
    "pendingMessageCount",
    "promptTemplates",
  ]) {
    if (!(g in session)) missing.push(`session.${g}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Installed pi is missing expected SDK surface (likely an incompatible version): ${missing.join(", ")}`,
    );
  }
}

/**
 * Register the command handler + rebind logic.
 *
 * @param {object} ctx
 * @param {object} ctx.runtime - AgentSessionRuntime
 * @param {object} ctx.session - AgentSession (current)
 * @param {object} ctx.uiContext - the host's ExtensionUIContext (cwd-independent;
 *   reused across rebinds — NOT read from runtime.services, which is replaced
 *   on every session swap and would lose the uiContext reference)
 * @param {object} ctx.send - process.send (IPC to main)
 * @param {object} ctx.panelBridge - the host panel bridge (for closeAll on swap)
 * @param {function} [ctx.runWithInvocationSurface] - runs a command callback
 *   under the renderer surface that invoked it ("composer" or "unified") so
 *   uiContext.custom can choose the matching render target.
 * @param {object} ctx.pi - the imported pi SDK (for /trust: ProjectTrustStore,
 *   hasTrustRequiringProjectResources)
 * @param {string} ctx.agentDir - pi.getAgentDir() (for the ProjectTrustStore)
 * @param {string} ctx.cwd - the session cwd (for /trust state + options)
 * @returns {{ handleCommand: Function, bindExtensions: Function, interruptActiveOperation: Function }}
 */
export function setupCommandBridge({
  runtime,
  session,
  uiContext,
  send,
  panelBridge,
  disposeUnifiedTui,
  cancelDialogs = () => {},
  runWithInvocationSurface,
  pi,
  agentDir,
  cwd,
  hostInstanceId = "test-host",
  sendControl = () => {},
  // Host-owned presentation reconstruction baselines. The child authority
  // serializes these only after prior ingress commits.
  authorityPresentation = {},
  sendFrame = null,
  sendPresentation = null,
  // Main owns target validation and advisory locks. The child uses this only
  // after freezing its serialized semantic ingress.
  // Unit-level bridge consumers without a parent transport retain the legacy
  // in-process behavior; host.mjs always supplies the real main handshake.
  requestTransitionPermit = async () => ({ allowed: true, reason: "test/local permit" }),
  initialBinding = false,
  lifecycleUiTracker = { track: (promise) => promise },
  uiState = {
    catalogSnapshot: () => ({}),
    editorSnapshot: () => ({ revision: 0, text: "" }),
    acceptEditorSubmission: () => false,
    applyEditorPatch: () => ({ accepted: false }),
  },
}) {
  let _session = session;
  let _unsubscribe = null;
  const activeInterrupts = new Map();
  let activeCommands = 0;
  let nextInterruptId = 1;
  const lifecycleContext = new AsyncLocalStorage();
  const admissionContext = new AsyncLocalStorage();
  const lifecycleBlockers = new Map();
  let nextLifecycleId = 0;
  lifecycleUiTracker.track = (promise) => {
    const lifecycleId = lifecycleContext.getStore();
    if (lifecycleId === undefined) return promise;
    lifecycleBlockers.set(lifecycleId, (lifecycleBlockers.get(lifecycleId) ?? 0) + 1);
    return Promise.resolve(promise).finally(() => {
      const remaining = (lifecycleBlockers.get(lifecycleId) ?? 1) - 1;
      if (remaining > 0) lifecycleBlockers.set(lifecycleId, remaining);
      else lifecycleBlockers.delete(lifecycleId);
    });
  };

  const authority = createStateAuthority({
    hostInstanceId,
    initialSession: session,
    sendControl,
    sendFrame,
    sendPresentation,
    sendRecord: (record) => {
      if (record.type === "event") send({ type: "event", event: record.event });
      else if (record.type === "submission")
        send({ type: "submission_disposition", result: record.result });
      else if (record.type === "queue_restoration") send(record);
      else if (record.type === "intent_outcome")
        send({ type: "intent_outcome", outcome: record.outcome });
      // Escape dispositions are represented in an atomic transition batch.
      // Outside one, the request/response path is its authoritative delivery.
    },
    getCatalog: () => ({
      ...uiState.catalogSnapshot(),
      pendingDialogs: uiState.pendingDialogCount?.() ?? 0,
    }),
    getEditor: () => uiState.editorSnapshot(),
    acceptEditorSubmission: (request) => uiState.acceptEditorSubmission?.(request) ?? false,
    onAdmissionStuck: ({ intentId }) => {
      send({
        type: "fatal_transition_error",
        message: `Prompt admission remained unresolved for intent ${intentId}`,
      });
    },
    runWithSurface: (surface, operation, intentId) =>
      admissionContext.run(intentId, () =>
        typeof runWithInvocationSurface === "function"
          ? runWithInvocationSurface(surface, operation)
          : operation(),
      ),
  });

  if (initialBinding) authority.beginTransition(authority.sessionEpoch, false);

  function trackInterruptibleOperation(kind, interrupt, run) {
    const id = nextInterruptId++;
    activeInterrupts.set(id, { kind, interrupt });
    // compact() has its own command/invocation barrier below. Recording it as
    // an observed compaction start here would lie about Pi lifecycle evidence.
    const observedId = ["agent", "bash"].includes(kind)
      ? authority.beginObservedOperation(kind)
      : null;
    let promise;
    try {
      promise = run();
    } catch (err) {
      activeInterrupts.delete(id);
      if (observedId) {
        authority.settleObservedOperation(kind, observedId, {
          failed: true,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
    return Promise.resolve(promise)
      .then(
        (result) => {
          if (observedId) authority.settleObservedOperation(kind, observedId, result ?? {});
          return result;
        },
        (err) => {
          if (observedId) {
            authority.settleObservedOperation(kind, observedId, {
              failed: true,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
          throw err;
        },
      )
      .finally(() => {
        activeInterrupts.delete(id);
      });
  }

  async function interruptActiveOperation() {
    const ops = [...activeInterrupts.values()];
    for (const op of ops) {
      try {
        await op.interrupt();
      } catch (err) {
        console.error(
          `[pi-session-host] Failed to interrupt ${op.kind}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  function endInterruptibleOperationsByKind(kind) {
    for (const [id, op] of activeInterrupts) {
      if (op.kind === kind) activeInterrupts.delete(id);
    }
  }

  // ─── Event forwarding ──────────────────────────────────────────────────

  function subscribeSession(s) {
    _unsubscribe?.();
    _unsubscribe = s.subscribe((event) => {
      // Events repair transcript/UI detail; direct snapshots own runtime state.
      authority.observeEvent(event);
      // Pi 0.80.4's cache-miss notices normally live in InteractiveMode, which
      // the SDK host does not instantiate. Re-derive the same opt-in notice
      // from public session/message data so showCacheMissNotices still works.
      const cacheMissNotice = buildCacheMissNotice(s, event);
      if (cacheMissNotice) authority.observeEvent(cacheMissNotice);
      if (event?.type === "agent_settled") endInterruptibleOperationsByKind("agent");
    });
    authority.publishSnapshot(true);
  }

  subscribeSession(_session);

  // ─── Extension binding (shared by initial bind + rebind) ───────────────
  // The SAME uiContext + commandContextActions + shutdown/onError wiring must
  // apply to the initial session and every rebound session (after /new, /fork,
  // /clone, /switch_session). Centralizing it here prevents the old bug where
  // the initial bind passed `commandContextActions: null` + a no-op
  // shutdownHandler while rebind passed real ones — extensions that called
  // ctx.actions.newSession() worked only after the first rebind.

  function bindExtensions(s) {
    return s.bindExtensions({
      uiContext,
      mode: "tui",
      commandContextActions: buildCommandContextActions({
        runtime,
        authority,
        reload: () => handleReload(),
        replace: (operation, details) =>
          runReplacement(operation, {
            ...details,
            // An extension action can be called from a renderer-owned slash
            // invocation. Preserve that predecessor correlation through rebind.
            initiatingIntentId: admissionContext.getStore(),
          }),
        waitForIdle: () => waitForSessionIdle(),
      }),
      // An extension requested app shutdown (e.g. a TUI-style /exit). In a GUI
      // the user — not an extension — owns session lifecycle, so this is a
      // deliberate no-op: we don't tear down the user's session (and its
      // transcript) on an extension's say-so. Present to satisfy bindExtensions.
      shutdownHandler: () => {},
      onError: (error) => {
        // ExtensionError is not an AgentSession event, so bindExtensions must
        // inject it into the same authoritative transcript presentation plane.
        // A raw legacy host message is ignored once frame transport is active
        // and would make throwing extensions silently disappear in the GUI.
        authority.observeEvent({
          type: "extension_error",
          extensionPath: error?.extensionPath,
          event: error?.event,
          error: error?.error,
        });
      },
    });
  }

  // ─── Rebind ────────────────────────────────────────────────────────────

  runtime.setRebindSession(async (newSession) => {
    _session = newSession;
    authority.adoptSession(newSession);
    // Subscribe before binding so binding/session_start events cannot be lost.
    subscribeSession(newSession);
    await bindExtensions(newSession);
  });

  runtime.setBeforeSessionInvalidate(() => {
    // Pi has crossed the last boundary at which the old AgentSession is proven
    // usable. Any later replacement failure must retire this host rather than
    // publish a rolled-back epoch around a potentially disposed session.
    authority.markTransitionBoundaryCrossed();
    // P3-c: tear down any open custom() panels before the session is replaced:
    // closeAll() settles each panel's custom() promise and stops its TUI
    // render loop on the HOST side. Only emit panel_clear_all to the renderer
    // when a panel was actually open — every /new//fork//clone//switch used
    // to spam a no-op event the renderer handled as a no-op.
    const hadPanels = panelBridge.closeAll();
    if (hadPanels) send({ type: "panel_clear_all" });
    // Dialogs that survived until invalidation belong to the old extension
    // generation. Causally awaited lifecycle dialogs have already settled;
    // fire-and-forget dialogs must not remain answerable after rebind.
    cancelDialogs();
    // Also dispose the unified TUI if a factory widget left one mounted. The
    // controller is passed in explicitly (not via globalThis) so the wiring is
    // testable and there's no implicit host-global coupling.
    disposeUnifiedTui?.();
    activeInterrupts.clear();
  });

  // ─── State helpers (mirror RpcSessionState / RPC get_commands) ─────────

  /** Build the get_state response, matching RpcSessionState exactly. */
  function getState() {
    const s = _session;
    return {
      // s.model is a pure-data Model object (id/name/api/provider/baseUrl/...),
      // structured-clone-safe over IPC. `?? null` matches the nullable schema.
      model: s.model ?? null,
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      isIdle: s.isIdle,
      isCompacting: s.isCompacting,
      isRetrying: s.isRetrying,
      retryAttempt: s.retryAttempt,
      isBashRunning: s.isBashRunning,
      steeringMode: s.steeringMode,
      followUpMode: s.followUpMode,
      sessionFile: s.sessionFile,
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      autoCompactionEnabled: s.autoCompactionEnabled,
      messageCount: s.messages.length,
      pendingMessageCount: s.pendingMessageCount,
      steering:
        typeof s.getSteeringMessages === "function" ? [...s.getSteeringMessages()] : undefined,
      followUp:
        typeof s.getFollowUpMessages === "function" ? [...s.getFollowUpMessages()] : undefined,
    };
  }

  /** Build the get_commands response, mirroring rpc-mode.js exactly. */
  function getCommands() {
    const commands = [];
    for (const command of _session.extensionRunner.getRegisteredCommands()) {
      commands.push({
        name: command.invocationName,
        description: command.description,
        source: "extension",
        sourceInfo: command.sourceInfo,
      });
    }
    for (const template of _session.promptTemplates) {
      commands.push({
        name: template.name,
        description: template.description,
        source: "prompt",
        sourceInfo: template.sourceInfo,
      });
    }
    for (const skill of _session.resourceLoader.getSkills().skills) {
      commands.push({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
        sourceInfo: skill.sourceInfo,
      });
    }
    return commands;
  }

  /**
   * Render Pi 0.80.4's display-only custom session entry through the
   * extension's public EntryRenderer. Rendering stays in the SDK host because
   * the callback returns a pi-tui Component that cannot cross Electron IPC.
   */
  function renderEntry(entryId, cols, expanded) {
    const manager = _session.sessionManager;
    const runner = _session.extensionRunner;
    if (typeof manager?.getEntry !== "function" || typeof runner?.getEntryRenderer !== "function") {
      return { rendered: false };
    }
    const entry = manager.getEntry(entryId);
    if (!entry || entry.type !== "custom" || typeof entry.customType !== "string") {
      return { rendered: false };
    }
    const renderer = runner.getEntryRenderer(entry.customType);
    if (typeof renderer !== "function") return { rendered: false };

    let component;
    try {
      component = renderer(entry, { expanded: expanded === true }, uiContext?.theme);
      if (!component || typeof component.render !== "function") return { rendered: false };
      const lines = component.render(Math.max(20, Math.min(240, Math.floor(cols))));
      if (!Array.isArray(lines)) return { rendered: false };
      return { rendered: true, ansi: lines.map((line) => String(line)).join("\n") };
    } catch (err) {
      const message = `[${entry.customType}] renderer failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      const ansi =
        typeof uiContext?.theme?.fg === "function" ? uiContext.theme.fg("error", message) : message;
      return { rendered: true, ansi, error: true };
    } finally {
      try {
        component?.dispose?.();
      } catch {
        /* ignore renderer teardown errors */
      }
    }
  }

  // ─── Command handler ───────────────────────────────────────────────────

  const LIFECYCLE_TIMEOUT_MS = 60_000;
  function runLifecycle(operation, label) {
    const lifecycleId = ++nextLifecycleId;
    let ticker;
    let remaining = LIFECYCLE_TIMEOUT_MS;
    let lastTick = Date.now();
    const timeout = new Promise((_, reject) => {
      ticker = setInterval(() => {
        const now = Date.now();
        // Only promises opened under this lifecycle's async context suspend
        // its watchdog. Persistent panels and unrelated dialogs cannot wedge
        // it, while a lifecycle hook awaiting its own dialog/custom panel gets
        // a genuine user-custody lease.
        if ((lifecycleBlockers.get(lifecycleId) ?? 0) === 0) remaining -= now - lastTick;
        lastTick = now;
        if (remaining <= 0) {
          clearInterval(ticker);
          const error = new Error(`${label} lifecycle timed out`);
          error.lifecycleTimeout = true;
          reject(error);
        }
      }, 100);
      ticker.unref?.();
    });
    const operationPromise = lifecycleContext.run(lifecycleId, () =>
      Promise.resolve().then(operation),
    );
    return Promise.race([operationPromise, timeout]).finally(() => {
      if (ticker) clearInterval(ticker);
      lifecycleBlockers.delete(lifecycleId);
    });
  }

  async function waitForSessionIdle() {
    const deadline = Date.now() + LIFECYCLE_TIMEOUT_MS;
    while (!authority.currentSession.isIdle) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for session idle");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref?.();
      });
    }
  }

  function bindInitialExtensions(s) {
    return initialBinding
      ? runLifecycle(() => bindExtensions(s), "Initial extension binding")
      : bindExtensions(s);
  }

  async function requestReplacementPermit(transitionId, phase, kind, targetFile) {
    const verdict = await requestTransitionPermit({
      transitionId,
      phase,
      kind,
      ...(typeof targetFile === "string" && targetFile.length > 0 ? { targetFile } : {}),
    });
    if (!verdict?.allowed) {
      throw new Error(verdict?.reason || "Session transition was not permitted");
    }
  }

  async function runReplacement(operation, details = {}) {
    const current = authority.snapshot();
    const owningIntentId = details.initiatingIntentId ?? admissionContext.getStore();
    const ownsOnlyActiveSubmission =
      typeof owningIntentId === "string" && authority.canReplaceFromIntent(owningIntentId);
    // A renderer replacement command itself owns one active command slot. An
    // extension command-context replacement may own exactly one admission;
    // unrelated commands, intents, custody, navigation, and compaction still
    // block it.
    const unsafe = ownsOnlyActiveSubmission
      ? activeCommands > 0
      : !current.isIdle ||
        current.hostFacts.submitting ||
        current.hostFacts.custodyCount > 0 ||
        authority.hasActiveWork ||
        activeCommands > 1;
    if (unsafe) {
      throw new Error("Wait for current session work to finish before replacing the session.");
    }
    const oldSession = _session;
    const transitionId = authority.beginTransition(authority.sessionEpoch + 1);
    try {
      // Freezing happens in beginTransition before this request is sent. Main
      // may now validate a known switch target and reserve its lock.
      await requestReplacementPermit(
        transitionId,
        "prepare",
        details.kind ?? "replacement",
        details.targetFile,
      );
      const result = await runLifecycle(operation, "Session replacement");
      if (result?.cancelled) {
        if (authority.transitionBoundaryCrossed) {
          throw new Error("Session replacement cancelled after invalidation boundary");
        }
        authority.cancelTransition(oldSession);
      } else {
        // /new and /fork discover their file only after SDK preparation. This
        // second permit acquires that successor lock before any batch can be
        // published as following.
        await requestReplacementPermit(
          transitionId,
          "successor",
          details.kind ?? "replacement",
          _session.sessionFile,
        );
        // Runtime replacement rebinds before its promise resolves. Settle the
        // renderer/extension intent while the main process still follows its
        // predecessor epoch, then atomically install the lock-held successor
        // baseline. The authority prevents this old-owner outcome from ever
        // appearing in the successor frame.
        authority.settleTransitionInitiator(owningIntentId, {
          response: { replacement: details.kind ?? "replacement" },
        });
        authority.commitTransition();
      }
      return result;
    } catch (err) {
      // A failure before rebind leaves the old public session valid. Once
      // rebind adopted a new session, the caller must retire the host rather
      // than pretending disposed state is usable.
      if (
        _session === oldSession &&
        !authority.transitionBoundaryCrossed &&
        !err?.lifecycleTimeout
      ) {
        authority.cancelTransition(oldSession);
      } else {
        send({
          type: "fatal_transition_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  async function handleSubmit(msg) {
    return authority.submit(msg.submission);
  }

  async function handleEscape(requestId) {
    return authority.requestEscape(requestId);
  }

  async function handleReload(alreadySerialized = false, reloadEditorCommand = undefined) {
    // Repeat child-owned admission immediately before transition creation. The
    // main-process permit only authorizes transport; it never makes this
    // semantic decision from a retained snapshot.
    if (activeCommands > 0) {
      throw new Error("Wait for the current response to finish before reloading.");
    }
    const permit = await authority.beginLifecycleTransition(
      "reload",
      authority.sessionEpoch + 1,
      alreadySerialized,
    );
    if (!permit.allowed) {
      throw new Error("Wait for the current response to finish before reloading.");
    }
    const oldSession = _session;
    const transitionId = authority.transitionId;
    try {
      await requestReplacementPermit(transitionId, "prepare", "reload", _session.sessionFile);
      // Reload retains the AgentSession and therefore its host-owned editor.
      // Consume only the exact Composer command that its intent identified.
      // This child-owned acknowledgement closes the renderer-patch/reload race
      // while preserving attachments, extension/picker drafts, newer typing,
      // and conflict custody. It follows the main permit so a denied
      // replacement leaves a never-dispatched command in editor custody.
      const editor = uiState.editorSnapshot();
      if (
        reloadEditorCommand &&
        editor.revision === reloadEditorCommand.editorRevision &&
        editor.text === reloadEditorCommand.editorText &&
        editor.conflictText === undefined
      ) {
        uiState.acceptEditorSubmission({
          editorRevision: reloadEditorCommand.editorRevision,
          text: reloadEditorCommand.editorText,
        });
      }
      await runLifecycle(
        () =>
          _session.reload({
            beforeSessionStart: async () => {
              authority.markTransitionBoundaryCrossed();
              panelBridge.closeAll();
              disposeUnifiedTui?.();
              cancelDialogs();
              authority.adoptSession(_session, authority.sessionEpoch + 1);
            },
          }),
        "Reload",
      );
      // reload keeps the AgentSession object and subscription but replaces
      // extension bindings; publish all buffered events with one terminal read.
      await requestReplacementPermit(transitionId, "successor", "reload", _session.sessionFile);
      authority.commitTransition();
    } catch (err) {
      if (!err?.lifecycleTimeout && !authority.transitionBoundaryCrossed) {
        authority.cancelTransition(oldSession);
      } else {
        send({
          type: "fatal_transition_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  /**
   * Resolve app-owned slash commands before Pi's prompt path. Pi's prompt()
   * only understands extension/templates/skills (and intentional unknown
   * prompt text); forwarding a GUI built-in there silently turns it into an
   * agent message instead of performing its public SDK/runtime operation.
   */
  async function invokeBuiltinCommand(text, intentId) {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return { handled: false };
    const [, name, rawArgs = ""] = match;
    const args = rawArgs.trim();
    // Match renderer parsing: every discovered command shadows an app
    // built-in. Prompt templates/skills and unknown names intentionally
    // continue to prompt(), where Pi owns their parsing/expansion.
    const isDiscovered =
      _session.extensionRunner.getCommand(name) ||
      _session.promptTemplates.some((template) => template.name === name) ||
      _session.resourceLoader.getSkills().skills.some((skill) => `skill:${skill.name}` === name);
    if (isDiscovered) return { handled: false };
    const words = args ? args.split(/\s+/) : [];
    const modelResponse = async () => {
      const models = await modelAccess(_session).getAvailable();
      return { response: { models } };
    };
    const setModelByReference = async (reference) => {
      const models = await modelAccess(_session).getAvailable();
      const slash = reference.indexOf("/");
      const provider = slash >= 0 ? reference.slice(0, slash) : "";
      const modelId = slash >= 0 ? reference.slice(slash + 1) : reference;
      const matches = models.filter(
        (model) => model.id === modelId && (provider ? model.provider === provider : true),
      );
      if (matches.length !== 1) throw new Error(`Model not found or ambiguous: ${reference}`);
      await _session.setModel(matches[0]);
      return { response: { provider: matches[0].provider ?? "", modelId: matches[0].id } };
    };
    const replace = async (operation, details) => {
      const result = await runReplacement(operation, { ...details, initiatingIntentId: intentId });
      return { response: { cancelled: result?.cancelled === true } };
    };

    switch (name) {
      case "new":
        if (args) throw new Error("Usage: /new");
        return {
          handled: true,
          result: await replace(() => runtime.newSession(), { kind: "new" }),
        };
      case "clone": {
        if (args) throw new Error("Usage: /clone");
        const leafId = _session.sessionManager.getLeafId();
        if (!leafId) throw new Error("Cannot clone session: no current entry selected");
        return {
          handled: true,
          result: await replace(() => runtime.fork(leafId, { position: "at" }), { kind: "clone" }),
        };
      }
      case "fork":
        if (!args)
          return {
            handled: true,
            result: { response: { messages: _session.getUserMessagesForForking() } },
          };
        if (words.length !== 1) throw new Error("Usage: /fork <entry-id>");
        return {
          handled: true,
          result: await replace(() => runtime.fork(words[0]), { kind: "fork" }),
        };
      case "resume":
      case "switch":
        if (!args) throw new Error(`Usage: /${name} <session-path>`);
        return {
          handled: true,
          result: await replace(() => runtime.switchSession(args), {
            kind: "switch",
            targetFile: args,
          }),
        };
      case "export":
        return {
          handled: true,
          result: { response: { path: await _session.exportToHtml(args || undefined) } },
        };
      case "model":
        return {
          handled: true,
          result: args ? await setModelByReference(args) : await modelResponse(),
        };
      case "models": {
        if (!args) {
          const models = await modelAccess(_session).getAvailable();
          return {
            handled: true,
            result: { response: { models, enabledIds: resolveEnabledModelIds(_session, models) } },
          };
        }
        const [verb, csv = ""] = args.split(/\s+/, 2);
        if (verb !== "apply" && verb !== "save")
          throw new Error("Usage: /models [apply|save] [provider/model,...]");
        const models = await modelAccess(_session).getAvailable();
        const enabledIds = csv ? csv.split(",").filter(Boolean) : null;
        const scoped = buildScopedModels(_session, models, enabledIds);
        _session.setScopedModels(scoped);
        if (verb === "save") {
          const isAll =
            enabledIds === null || enabledIds.length === 0 || enabledIds.length >= models.length;
          _session.settingsManager.setEnabledModels(isAll ? undefined : enabledIds);
        }
        return { handled: true, result: { response: { enabledIds } } };
      }
      case "logout":
        if (!args)
          return {
            handled: true,
            result: { response: { providers: await collectLogoutProviders(_session) } },
          };
        if (words.length !== 1) throw new Error("Usage: /logout <provider>");
        await modelAccess(_session).logout(words[0]);
        return { handled: true, result: { response: { provider: words[0] } } };
      case "label": {
        const targetId = words.shift();
        if (!targetId) throw new Error("Usage: /label <entry-id> [label]");
        const label = words.join(" ") || undefined;
        if (typeof _session.sessionManager.appendLabelChange !== "function") {
          throw new Error("Session labels are not supported by this Pi version");
        }
        _session.sessionManager.appendLabelChange(targetId, label);
        return { handled: true, result: { response: { targetId, ...(label ? { label } : {}) } } };
      }
      case "name":
        if (!args) return { handled: true, result: { response: { name: _session.sessionName } } };
        _session.setSessionName(args);
        return { handled: true, result: { response: { name: args } } };
      case "session":
        if (args) throw new Error("Usage: /session");
        return {
          handled: true,
          result: { response: { stats: _session.getSessionStats(), state: getState() } },
        };
      case "compact": {
        // Same deferral as the compact intent below: the invocation barrier
        // opens here, in the serialized slot, while the long compaction
        // settles off-scheduler so later ingress keeps flowing.
        const compactIntentId = authority.beginCompactionInvocation(`invoke:${intentId}`);
        const operation = trackInterruptibleOperation(
          "compact",
          () => _session.abort(),
          () => _session.compact(args || undefined),
        ).then(
          () => {
            authority.settleCompactionInvocation(compactIntentId);
            return { response: { compactionId: compactIntentId } };
          },
          (error) => {
            authority.settleCompactionInvocation(compactIntentId, {
              failed: true,
              detail: error instanceof Error ? error.message : String(error),
            });
            throw error;
          },
        );
        return { handled: true, result: { deferredOutcome: operation } };
      }
      case "reload":
        if (args) throw new Error("Usage: /reload");
        await handleReload(true);
        return {
          handled: true,
          result: {
            response: {
              successorIdentity: { hostInstanceId, sessionEpoch: authority.sessionEpoch },
            },
          },
        };
      case "trust": {
        const { buildProjectTrustOptions } = await import("./bootstrap.mjs");
        const liveCwd = _session.sessionManager?.getCwd?.() ?? cwd;
        const options = buildProjectTrustOptions(liveCwd);
        if (!args) {
          return { handled: true, result: { response: { cwd: liveCwd, options } } };
        }
        if (args !== "trust" && args !== "untrust")
          throw new Error("Usage: /trust [trust|untrust]");
        const option = options.find((candidate) => candidate.trusted === (args === "trust"));
        if (!option) throw new Error("Requested trust choice is unavailable");
        new pi.ProjectTrustStore(agentDir).setMany(option.updates);
        return { handled: true, result: { response: { trusted: option.trusted } } };
      }
      // Renderer-local commands must still never become agent prompts.
      case "copy":
        return { handled: true, result: { response: { text: _session.getLastAssistantText() } } };
      case "scoped-models":
        return invokeBuiltinCommand("/models", intentId);
      case "settings":
      case "login":
      case "diff":
      case "tree":
      case "quit":
      case "share":
      case "changelog":
        throw new Error(`/${name} is handled by the renderer and cannot run in the session host`);
      default:
        return { handled: false };
    }
  }

  async function dispatchIntent(envelope) {
    return authority.dispatchIntent(envelope, async (intent, owner) => {
      const submission = (text, overrides = {}) =>
        authority.submit(
          {
            intentId: envelope.intentId,
            expectedHostId: owner.hostInstanceId,
            expectedEpoch: owner.sessionEpoch,
            editorRevision: intent.editorRevision,
            text,
            images: intent.images ?? [],
            requestedMode: intent.requestedMode ?? "followUp",
            surface: intent.surface ?? "composer",
            ...overrides,
          },
          true,
        );

      switch (intent.kind) {
        case "interrupt":
          return authority.requestEscape(envelope.intentId);
        case "refreshModels":
          // ModelRuntime.refresh is a mutation, never a read query. Keep its
          // authority outcome bounded; the renderer owner-fenced read obtains
          // the catalog only after this settles.
          await modelAccess(_session).refresh();
          return { refreshed: true };
        case "loginProvider": {
          // Re-read the live runtime immediately before crossing the SDK
          // boundary; picker metadata is advisory and may be stale.
          if (!_session.modelRuntime || _session.settingsManager?.isProjectTrusted?.() === false) {
            throw new Error("Login unavailable");
          }
          const provider = modelAccess(_session)
            .getProviders()
            .find((item) => item?.id === intent.providerId);
          const auth = provider?.auth;
          const method = intent.authType === "oauth" ? auth?.oauth : auth?.apiKey?.login;
          if (!provider || !method) throw new Error("Login unavailable");
          const controller = new AbortController();
          const interaction = uiContext?.createProviderAuthInteraction?.(
            String(provider.name ?? provider.id),
            intent.authType,
            controller.signal,
          );
          const operation = trackInterruptibleOperation(
            "login",
            () => controller.abort(),
            async () => {
              // Deliberately discard Credential and provider-native errors.
              await modelAccess(_session).login(intent.providerId, intent.authType, interaction);
              return { authenticated: true };
            },
          ).catch(() => {
            throw new Error("Sign in could not be completed");
          });
          return { deferredOutcome: operation };
        }
        case "submit":
          return submission(intent.text);
        case "manageQueue":
          return authority.manageQueue(intent);
        case "invokeCommand": {
          if (typeof intent.text !== "string" || !intent.text.startsWith("/")) {
            throw new Error("invokeCommand requires slash command text");
          }
          const resolved = await invokeBuiltinCommand(intent.text, envelope.intentId);
          if (resolved.handled) return resolved.result;
          // Only extension/template/skill commands (and intentional unknown
          // slash prompt text) reach Pi's public prompt parser.
          return submission(intent.text, { images: [] });
        }
        case "compact": {
          // beginCompactionInvocation opens the admission barrier inside this
          // serialized execution slot, then the compaction itself runs as a
          // deferred outcome: it can take minutes, and holding the single
          // ingress scheduler for that long silently freezes every later
          // intent (prompts that must enter custody, ESC, tree navigation).
          const compactIntentId = authority.beginCompactionInvocation(envelope.intentId);
          const operation = trackInterruptibleOperation(
            "compact",
            () => _session.abort(),
            () => _session.compact(intent.instructions),
          ).then(
            () => {
              authority.settleCompactionInvocation(compactIntentId);
              return { compactionId: compactIntentId };
            },
            (error) => {
              authority.settleCompactionInvocation(compactIntentId, {
                failed: true,
                detail: error instanceof Error ? error.message : String(error),
              });
              throw error;
            },
          );
          return { deferredOutcome: operation };
        }
        case "runBash":
          // Bash can run arbitrarily long; settle it off-scheduler too.
          return {
            deferredOutcome: trackInterruptibleOperation(
              "bash",
              () => _session.abortBash(),
              () =>
                _session
                  .executeBash(intent.command, undefined, {
                    ...(intent.excludeFromContext !== undefined
                      ? { excludeFromContext: intent.excludeFromContext }
                      : {}),
                  })
                  .then((result) => ({
                    started: true,
                    ...(typeof result?.output === "string" ? { output: result.output } : {}),
                    ...(Number.isInteger(result?.exitCode) ? { exitCode: result.exitCode } : {}),
                    ...(typeof result?.cancelled === "boolean"
                      ? { cancelled: result.cancelled }
                      : {}),
                    ...(typeof result?.truncated === "boolean"
                      ? { truncated: result.truncated }
                      : {}),
                  })),
            ),
          };
        case "navigate": {
          // Renderer idle is observation context only. Recheck the public SDK
          // getter inside serialized child execution so a prompt admitted
          // after that observation cannot race navigateTree and corrupt an
          // active turn.
          if (!_session.isIdle) {
            throw new Error("Wait for the current operation to finish before switching branches.");
          }
          // Capture the empty pre-navigation editor once. Navigation can await
          // summarization, so a patch made while it runs must make this
          // compare-and-apply fail rather than lose the newer draft.
          const editorAtNavigationStart = uiState.editorSnapshot();
          const editorIsEmptyForNavigation = (editor) =>
            editor.text === "" &&
            (editor.attachments?.length ?? 0) === 0 &&
            editor.conflictText === undefined &&
            (editor.conflictAttachments?.length ?? 0) === 0 &&
            editor.alternateConflictText === undefined &&
            (editor.alternateConflictAttachments?.length ?? 0) === 0 &&
            (editor.additionalConflictCandidates?.length ?? 0) === 0;
          // runNavigation opens the navigation barrier synchronously; the
          // navigation itself (which can await a branch summarization) then
          // settles as a deferred outcome so serialized ingress keeps
          // flowing and later prompts join navigation custody.
          const navigationOperation = authority
            .runNavigation(() =>
              _session.navigateTree(intent.targetId, { summarize: intent.summarize }),
            )
            .then((result) => {
              const cancelled = result?.cancelled === true || result?.aborted === true;
              // Pi returns restored editor text as navigation evidence, but
              // only an empty editor may accept it. The terminal snapshot then
              // carries the revisioned host editor state; stale/non-empty
              // drafts remain authoritative instead of being overwritten.
              if (
                !cancelled &&
                typeof result?.editorText === "string" &&
                editorIsEmptyForNavigation(editorAtNavigationStart)
              ) {
                // A rejected concurrent renderer patch can retain a conflict
                // candidate without changing the revision. Re-read all editor
                // custody before applying so navigation never clears it.
                const editorBeforeInjection = uiState.editorSnapshot();
                if (
                  editorBeforeInjection.revision === editorAtNavigationStart.revision &&
                  editorIsEmptyForNavigation(editorBeforeInjection)
                ) {
                  uiState.applyEditorPatch({
                    baseRevision: editorAtNavigationStart.revision,
                    revision: editorAtNavigationStart.revision + 1,
                    text: result.editorText,
                    attachments: [],
                  });
                }
              }
              return {
                targetId: intent.targetId,
                ...(typeof result?.summaryEntry === "object" ? { summarized: true } : {}),
                ...(result?.cancelled === true ? { cancelled: true } : {}),
                ...(result?.aborted === true ? { aborted: true } : {}),
                // Read post-navigation state only after Pi has settled the
                // navigation. getBranch() is the public root-to-leaf,
                // in-memory branch; copying it makes the authority outcome
                // serializable without relying on the session file.
                ...(!cancelled && typeof result?.editorText === "string"
                  ? { editorText: result.editorText }
                  : {}),
                ...(!cancelled ? { leafId: _session.sessionManager.getLeafId() } : {}),
                ...(!cancelled ? { branch: [..._session.sessionManager.getBranch()] } : {}),
              };
            });
          return { deferredOutcome: navigationOperation };
        }
        case "setModel": {
          const models = await modelAccess(_session).getAvailable();
          const model = models.find(
            (candidate) =>
              candidate.provider === intent.provider && candidate.id === intent.modelId,
          );
          if (!model) throw new Error(`Model not found: ${intent.provider}/${intent.modelId}`);
          await _session.setModel(model);
          return { provider: model.provider ?? intent.provider, modelId: model.id };
        }
        case "setThinking":
          _session.setThinkingLevel(intent.level);
          return { level: intent.level };
        case "rename":
          _session.setSessionName(intent.name);
          return { name: intent.name };
        case "reload":
          await handleReload(true, {
            editorRevision: intent.editorRevision,
            editorText: intent.editorText,
          });
          return {
            successorIdentity: { hostInstanceId, sessionEpoch: authority.sessionEpoch },
          };
        case "export": {
          const path = await _session.exportToHtml(intent.outputPath);
          if (typeof path !== "string" || path.length === 0)
            throw new Error("Session export did not return a file path");
          return { path };
        }
        default:
          throw new Error(`Unknown intent kind: ${intent.kind}`);
      }
    });
  }

  async function handleCommand(msg) {
    const { id, command } = msg;
    if (authority.isTransitioning) {
      send({
        type: "response",
        id,
        success: false,
        error: "Session replacement is in progress",
      });
      authority.publishSnapshot();
      return;
    }
    activeCommands++;
    const runForSurface = (fn) =>
      typeof runWithInvocationSurface === "function"
        ? runWithInvocationSurface(msg.uiSurface, fn)
        : fn();

    try {
      switch (command.type) {
        // ── Prompting ──────────────────────────────────────────────────
        // prompt() does NOT resolve until the turn completes, so — like
        // rpc-mode — we fire-and-forget it and respond early via the
        // preflightResult callback (success = "prompt accepted by the guards").
        // A `responded` guard ensures exactly one response even if preflight
        // rejects AND the promise later rejects.
        case "prompt": {
          let responded = false;
          const respond = (ok, errMsg) => {
            if (responded) return;
            responded = true;
            authority.publishSnapshot();
            send({
              type: "response",
              id,
              success: ok,
              ...(errMsg ? { error: errMsg } : {}),
            });
          };
          void trackInterruptibleOperation(
            "agent",
            () => _session.abort(),
            () =>
              runForSurface(() =>
                _session.prompt(command.message, {
                  ...(command.images?.length ? { images: command.images } : {}),
                  ...(command.streamingBehavior
                    ? { streamingBehavior: command.streamingBehavior }
                    : {}),
                  source: "rpc",
                  preflightResult: (didSucceed) => {
                    if (didSucceed) respond(true);
                    else respond(false, "Prompt rejected");
                  },
                }),
              ),
          )
            .catch((err) => respond(false, err instanceof Error ? err.message : String(err)))
            .finally(() => authority.publishSnapshot());
          break;
        }

        // steer()/followUp() queue a message; they resolve promptly (no full
        // turn), so a plain await + success is correct.
        case "steer": {
          await runForSurface(() => _session.steer(command.message, command.images));
          send({ type: "response", id, success: true });
          break;
        }

        case "follow_up": {
          await runForSurface(() => _session.followUp(command.message, command.images));
          send({ type: "response", id, success: true });
          break;
        }

        case "abort": {
          await _session.abort();
          send({ type: "response", id, success: true });
          break;
        }

        // ── Model / thinking ───────────────────────────────────────────
        // setModel takes a Model object, not provider/modelId — resolve via
        // Pi's public model surface exactly as rpc-mode does.
        case "set_model": {
          const models = await modelAccess(_session).getAvailable();
          const provider = typeof command.provider === "string" ? command.provider : "";
          const candidates = models.filter((m) => m.id === command.modelId);
          const model = provider
            ? candidates.find((m) => m.provider === provider)
            : candidates.length === 1
              ? candidates[0]
              : candidates.find((m) => !m.provider);
          if (!model) {
            const label = provider ? `${provider}/${command.modelId}` : command.modelId;
            send({
              type: "response",
              id,
              success: false,
              error: `Model not found: ${label}`,
            });
            return;
          }
          await _session.setModel(model);
          send({ type: "response", id, success: true });
          break;
        }

        case "cycle_model": {
          const result = await _session.cycleModel();
          send({ type: "response", id, success: true, data: result ?? null });
          break;
        }

        case "set_thinking_level": {
          _session.setThinkingLevel(command.level);
          send({ type: "response", id, success: true });
          break;
        }

        case "cycle_thinking_level": {
          const level = _session.cycleThinkingLevel();
          send({
            type: "response",
            id,
            success: true,
            data: level ? { level } : null,
          });
          break;
        }

        case "set_steering_mode": {
          _session.setSteeringMode(command.mode);
          send({ type: "response", id, success: true });
          break;
        }

        case "set_follow_up_mode": {
          _session.setFollowUpMode(command.mode);
          send({ type: "response", id, success: true });
          break;
        }

        case "get_login_providers": {
          // Runtime-native only. Legacy ModelRegistry intentionally reports
          // native:false so the embedded terminal remains its fallback.
          if (!_session.modelRuntime) {
            send({ type: "response", id, success: true, data: { native: false, providers: [] } });
            break;
          }
          const credentials = await modelAccess(_session).listCredentials();
          const configured = new Set(credentials.map((credential) => credential?.providerId));
          const providers = modelAccess(_session)
            .getProviders()
            .slice(0, 100)
            .flatMap((provider) => {
              if (!provider || typeof provider.id !== "string") return [];
              const auth = provider.auth ?? {};
              const methods = [];
              if (auth.oauth) methods.push("oauth");
              if (auth.apiKey?.login) methods.push("apiKey");
              if (!methods.length) return [];
              return [
                {
                  id: provider.id.slice(0, 160),
                  name: String(provider.name ?? provider.id).slice(0, 160),
                  checkAuth: typeof auth.checkAuth === "function",
                  configured: configured.has(provider.id),
                  source:
                    typeof provider.source === "string" ? provider.source.slice(0, 120) : undefined,
                  methods,
                },
              ];
            });
          send({ type: "response", id, success: true, data: { native: true, providers } });
          break;
        }

        case "get_available_models": {
          // Mirror pi's effective available-models logic so the /model
          // dropdown cycles only the in-scope subset, NOT every enabled
          // model. Two sources of scope, checked in priority order:
          //   1. session.scopedModels (session-only scope, e.g. from a prior
          //      set_scoped_models this session). The scoped entry's `.model`
          //      is a plain data Model object safe for IPC.
          //   2. settingsManager.getEnabledModels() — the SAVED scope
          //      persisted by save_scoped_models. The SDK starts every
          //      session with scopedModels: [] and, unlike pi's CLI main.js,
          //      NEVER resolves these saved patterns into session.scopedModels,
          //      so without this fallback a persisted scope would be invisible
          //      to the dropdown on a fresh session / after relaunch. We
          //      resolve the patterns with the same best-effort matcher
          //      (resolveModelScopePatterns) the scoped-models picker uses for
          //      its initial checkboxes; it is advisory — the authoritative
          //      scope lives in pi's settingsManager.
          const scoped = _session.scopedModels;
          if (Array.isArray(scoped) && scoped.length > 0) {
            const scopedModels = scoped
              .map((entry) => entry?.model)
              .filter((m) => m && typeof m === "object");
            send({ type: "response", id, success: true, data: { models: scopedModels } });
            break;
          }
          const models = await modelAccess(_session).getAvailable();
          let effective = models;
          const settingsPatterns = _session.settingsManager?.getEnabledModels?.();
          if (Array.isArray(settingsPatterns) && settingsPatterns.length > 0) {
            const enabledIds = new Set(resolveModelScopePatterns(settingsPatterns, models));
            // Only filter when it actually narrows the list: an empty or
            // full match means "no scope" (mirrors resolveEnabledModelIds →
            // null), so fall through to the unfiltered registry list.
            if (enabledIds.size > 0 && enabledIds.size < models.length) {
              effective = models.filter((m) =>
                enabledIds.has(`${m.provider}/${m.id}`.toLowerCase()),
              );
            }
          }
          send({ type: "response", id, success: true, data: { models: effective } });
          break;
        }

        // ── Scoped models / login state ──────────────────────────────────
        // These mirror pi's TUI /scoped-models and /logout flows through
        // the SDK host's public session APIs.
        case "get_scoped_models": {
          // Refresh so a freshly-added credential (e.g. /login) is reflected
          // immediately — refresh Pi's public model surface before reading the
          // current available-model snapshot.
          const modelsApi = modelAccess(_session);
          await modelsApi.refresh();
          const models = await modelsApi.getAvailable();
          const enabledIds = resolveEnabledModelIds(_session, models);
          send({ type: "response", id, success: true, data: { models, enabledIds } });
          break;
        }

        case "set_scoped_models": {
          const models = await modelAccess(_session).getAvailable();
          const scoped = buildScopedModels(_session, models, command.enabledIds);
          _session.setScopedModels(scoped);
          send({ type: "response", id, success: true });
          break;
        }

        // ── Global persistence (Ctrl-S in pi's TUI) ──────────────────────
        // save_scoped_models persists the scope to pi's settings.json via
        // settingsManager.setEnabledModels(patterns) so ALL sessions
        // (current + future + after /reload) honor it, AND applies it to the
        // current session immediately via setScopedModels (mirrors pi's TUI
        // onPersist following its live onChange updates). patterns=undefined
        // clears the settings filter (all enabled / empty / == all).
        case "save_scoped_models": {
          const models = await modelAccess(_session).getAvailable();
          const isAll =
            command.enabledIds === null ||
            command.enabledIds.length === 0 ||
            command.enabledIds.length >= models.length;
          const patterns = isAll ? undefined : [...command.enabledIds];
          _session.settingsManager.setEnabledModels(patterns);
          // Apply to the current session so it takes effect immediately.
          const scoped = buildScopedModels(_session, models, command.enabledIds);
          _session.setScopedModels(scoped);
          send({ type: "response", id, success: true });
          break;
        }

        case "get_logout_providers": {
          const providers = await collectLogoutProviders(_session);
          send({ type: "response", id, success: true, data: { providers } });
          break;
        }

        case "logout_provider": {
          await modelAccess(_session).logout(command.provider);
          send({ type: "response", id, success: true });
          break;
        }

        // ── Bash ───────────────────────────────────────────────────────
        // executeBash(command, onChunk?, options?). The renderer reads
        // data.output / data.exitCode; returning the full BashResult (which
        // also carries cancelled/truncated) matches rpc-mode and is a superset.
        case "bash": {
          const result = await trackInterruptibleOperation(
            "bash",
            () => _session.abortBash(),
            () =>
              _session.executeBash(command.command, undefined, {
                ...(command.excludeFromContext !== undefined
                  ? { excludeFromContext: command.excludeFromContext }
                  : {}),
              }),
          );
          send({ type: "response", id, success: true, data: result });
          break;
        }

        case "abort_bash": {
          _session.abortBash();
          send({ type: "response", id, success: true });
          break;
        }

        // ── Compaction ─────────────────────────────────────────────────
        // compact(customInstructions?: string) — a STRING, not an options
        // object. The old bridge passed { customInstructions } and pi silently
        // stringified it to "[object Object]".
        case "compact": {
          // Invocation admission itself is a conservative child-side barrier;
          // it is not treated as proof of a Pi compaction start. Public
          // start/end events (or getter evidence) own the observed lifecycle.
          const compactIntentId = authority.beginCompactionInvocation(`compact:${id}`);
          try {
            const result = await trackInterruptibleOperation(
              "compact",
              () => _session.abort(),
              () => _session.compact(command.customInstructions),
            );
            authority.settleCompactionInvocation(compactIntentId);
            send({ type: "response", id, success: true, data: result });
          } catch (error) {
            authority.settleCompactionInvocation(compactIntentId, {
              failed: true,
              detail: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          break;
        }

        case "set_auto_compaction": {
          _session.setAutoCompactionEnabled(command.enabled);
          send({ type: "response", id, success: true });
          break;
        }

        case "set_auto_retry": {
          _session.setAutoRetryEnabled(command.enabled);
          send({ type: "response", id, success: true });
          break;
        }

        case "abort_retry": {
          _session.abortRetry();
          send({ type: "response", id, success: true });
          break;
        }

        // ── Introspection ──────────────────────────────────────────────
        case "get_session_stats": {
          send({ type: "response", id, success: true, data: _session.getSessionStats() });
          break;
        }

        case "get_commands": {
          send({ type: "response", id, success: true, data: { commands: getCommands() } });
          break;
        }

        case "get_state": {
          send({ type: "response", id, success: true, data: getState() });
          break;
        }

        case "get_messages": {
          send({
            type: "response",
            id,
            success: true,
            data: { messages: _session.messages },
          });
          break;
        }

        case "get_last_assistant_text": {
          send({
            type: "response",
            id,
            success: true,
            data: { text: _session.getLastAssistantText() },
          });
          break;
        }

        case "export_html": {
          const outPath = await _session.exportToHtml(command.outputPath);
          send({ type: "response", id, success: true, data: { path: outPath } });
          break;
        }

        case "render_entry": {
          send({
            type: "response",
            id,
            success: true,
            data: renderEntry(command.entryId, command.cols, command.expanded),
          });
          break;
        }

        case "get_cache_miss_notices": {
          send({
            type: "response",
            id,
            success: true,
            data: { notices: buildHistoricalCacheMissNotices(_session) },
          });
          break;
        }

        // ── Trust (pi-vis host-only /trust) ─────────────────────────────
        // get_trust_state returns the cwd, whether it has trust-requiring
        // project resources, and pi's full project-trust choice set (each
        // option carries the `trusted` answer + the `updates` to persist).
        // The renderer uses this to render the /trust picker; if
        // hasTrustRequiringResources is false it toasts and skips.
        case "get_trust_state": {
          // Lazily import so the bridge's startup surface check
          // (assertHostCapabilities) doesn't need to know about trust.
          const { buildProjectTrustOptions } = await import("./bootstrap.mjs");
          // Derive cwd from the LIVE session (not the closure `cwd`, which
          // is stale after a worktree respawn uses a different cwd and a
          // /new//fork//switch rebind keeps it). sessionManager.getCwd() is
          // the authoritative current cwd.
          const liveCwd =
            typeof _session.sessionManager?.getCwd === "function"
              ? _session.sessionManager.getCwd()
              : cwd;
          const hasTrustRequiringResources = pi.hasTrustRequiringProjectResources(liveCwd);
          const currentOptions = buildProjectTrustOptions(liveCwd);
          // Surface the cwd's saved decision + the global projectTrusted
          // setting so the picker can show current state (pi's
          // TrustSelectorComponent does the same).
          const trustStore = new pi.ProjectTrustStore(agentDir);
          const savedDecision = trustStore.getEntry(liveCwd)?.decision ?? null;
          const projectTrusted = _session.settingsManager?.isProjectTrusted?.() ?? true;
          send({
            type: "response",
            id,
            success: true,
            data: {
              cwd: liveCwd,
              hasTrustRequiringResources,
              savedDecision,
              projectTrusted,
              currentOptions,
            },
          });
          break;
        }

        // set_trust persists the chosen option's updates via the public
        // ProjectTrustStore and returns. The persisted decision takes effect
        // on the NEXT session start (resolveProjectTrust reads the store); a
        // live re-apply would require re-running createAgentSessionServices
        // mid-session, which risks the transcript/session identity. The
        // renderer triggers a /reload after a successful set_trust so the
        // new decision is honored — mirroring pi's TUI, which also tells the
        // user "Restart pi for this to take effect."
        case "set_trust": {
          const trustStore = new pi.ProjectTrustStore(agentDir);
          trustStore.setMany(command.updates);
          send({
            type: "response",
            id,
            success: true,
            data: { trusted: command.trusted },
          });
          break;
        }

        case "get_fork_messages": {
          send({
            type: "response",
            id,
            success: true,
            data: { messages: _session.getUserMessagesForForking() },
          });
          break;
        }

        case "set_session_name": {
          _session.setSessionName(command.name);
          send({ type: "response", id, success: true });
          break;
        }

        // ── Session lifecycle (runtime) ────────────────────────────────
        // These replace the session; the rebind callback (registered above)
        // re-binds extensions + re-subscribes before the runtime resolves, so
        // _session is already the new session when we send the response. ipc.ts
        // then harvests the new sessionFile via a follow-up get_state.
        case "new_session": {
          const result = await runReplacement(() => runtime.newSession(), { kind: "new" });
          send({
            type: "response",
            id,
            success: !result.cancelled,
            data: { cancelled: result.cancelled },
          });
          break;
        }

        case "fork": {
          const result = await runReplacement(() => runtime.fork(command.entryId), {
            kind: "fork",
          });
          send({
            type: "response",
            id,
            success: !result.cancelled,
            data: { text: result.selectedText, cancelled: result.cancelled },
          });
          break;
        }

        case "switch_session": {
          const result = await runReplacement(() => runtime.switchSession(command.sessionPath), {
            kind: "switch",
            targetFile: command.sessionPath,
          });
          send({
            type: "response",
            id,
            success: !result.cancelled,
            data: { cancelled: result.cancelled },
          });
          break;
        }

        // clone = fork the leaf entry at-position (mirrors rpc-mode). The old
        // bridge read a nonexistent stats.lastEntryId; the real source of truth
        // is sessionManager.getLeafId().
        case "clone": {
          const leafId = _session.sessionManager.getLeafId();
          if (!leafId) {
            send({
              type: "response",
              id,
              success: false,
              error: "Cannot clone session: no current entry selected",
            });
            return;
          }
          const result = await runReplacement(() => runtime.fork(leafId, { position: "at" }), {
            kind: "clone",
          });
          send({
            type: "response",
            id,
            success: !result.cancelled,
            data: { cancelled: result.cancelled },
          });
          break;
        }

        // Conversation-tree commands (SDK-host-only — see plan §2).
        // NOT gated by assertHostCapabilities so older pi versions that
        // lack session.sessionManager.getTree()/getBranch() or
        // session.navigateTree() degrade per-command (TypeError → success:false
        // from the outer try/catch) without making the entire host unavailable.
        case "get_tree": {
          // Capability gate (NOT a thrown TypeError). The tree surface is
          // intentionally NOT in assertHostCapabilities (gating it there would
          // disable inline panels too on an older pi). So detect it per-command:
          // if getTree/getLeafId are missing, return a structured `unsupported`
          // flag the renderer maps to the permanent "unsupported" phase. Every
          // OTHER failure (host restart, transient, a real error) surfaces as a
          // thrown command → the renderer's retryable "error" phase. Without
          // this distinction a transient made the viewer stick on "unsupported".
          const sm = _session.sessionManager;
          if (!sm || typeof sm.getTree !== "function" || typeof sm.getLeafId !== "function") {
            send({
              type: "response",
              id,
              success: true,
              data: { unsupported: true, nodes: [], leafId: null },
            });
            break;
          }
          // session.sessionManager.getTree() returns a structured-clone-safe
          // defensive copy; .getLeafId() is the authoritative active leaf
          // (null in the pre-leaf state).
          //
          // FLATTEN the nested tree into a parentId-keyed list before sending.
          // pi's tree is recursively nested ({entry, children:[...]}) whose
          // depth equals the longest root→leaf chain — unbounded. Electron's
          // contextBridge hardcodes a 1000-level nesting limit, so a long
          // (1000+ message) linear session threw "recursion depth exceeded"
          // when the response crossed preload→renderer. The flat list caps
          // wire depth at a constant; the renderer re-nests in its own world
          // (buildNestedTree) which has no such limit.
          const nested = sm.getTree();
          const nodes = [];
          // Pre-order DFS preserving sibling order (push children reversed so
          // they pop in original order). parentId tracks TREE POSITION
          // (undefined for top-level roots), not entry.parentId — the nested
          // tree already resolved pi's orphan/root rules.
          const stack = nested.map((n) => ({ node: n, parentId: undefined })).reverse();
          while (stack.length > 0) {
            const { node, parentId } = stack.pop();
            nodes.push({
              entry: node.entry,
              parentId,
              label: node.label,
              labelTimestamp: node.labelTimestamp,
            });
            const kids = node.children ?? [];
            for (let i = kids.length - 1; i >= 0; i--) {
              stack.push({ node: kids[i], parentId: node.entry.id });
            }
          }
          const leafId = sm.getLeafId();
          send({
            type: "response",
            id,
            success: true,
            data: { nodes, leafId },
          });
          break;
        }

        case "navigate_tree": {
          // session.navigateTree() mutates only agent.state.messages — it
          // does NOT change session.model / thinkingLevel, so the renderer
          // doesn't need to reconcile those (review S4). It returns
          // { editorText?, cancelled, aborted?, summaryEntry? }; the host
          // also captures the new active leaf + branch so the renderer can
          // rebuild the transcript in-place without re-reading the session
          // file (which may be stale for freshly-appended entries such as
          // the synthesized branch_summary).
          const result = await authority.runNavigation(() =>
            _session.navigateTree(command.targetId, {
              summarize: command.summarize,
              label: command.label,
            }),
          );
          const data = {
            cancelled: result.cancelled,
            editorText: result.editorText,
            aborted: result.aborted,
          };
          if (!result.cancelled) {
            // Post-navigation: capture the new active leaf + the new branch.
            // getBranch() is SYNCHRONOUS in pi's SessionManager and returns
            // the chain in root→leaf order (already reversed internally).
            // Empty array when the new leaf is null (navigated past the
            // root / first user message — review S3).
            data.leafId = _session.sessionManager.getLeafId();
            data.branch = _session.sessionManager.getBranch();
          }
          send({ type: "response", id, success: true, data });
          break;
        }

        case "set_label": {
          // appendLabelChange(targetId, label?) is synchronous; label:undefined
          // or empty string clears. After it returns, getTree() will surface
          // node.label/node.labelTimestamp from the in-memory labelsById map
          // (session-manager.js:900), so the renderer's `refresh()` is the
          // only follow-up needed (review N2).
          _session.sessionManager.appendLabelChange(command.targetId, command.label);
          send({ type: "response", id, success: true });
          break;
        }

        default: {
          send({
            type: "response",
            id,
            success: false,
            error: `Unknown command type: ${command.type}`,
          });
        }
      }
    } catch (err) {
      send({
        type: "response",
        id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      activeCommands--;
      authority.publishSnapshot();
    }
  }

  return {
    handleCommand,
    handleSubmit,
    handleEscape,
    handleReload,
    requestLifecyclePermit: (kind) => authority.requestLifecyclePermit(kind),
    dispatchIntent,
    publishSnapshot: (full = true) => authority.publishSnapshot(full),
    requestAuthorityAttach: (rendererGeneration) =>
      authority.requestAuthorityAttach(rendererGeneration, authorityPresentation),
    applyEditorPatch: (patch) => uiState.applyEditorPatch(patch),
    bindExtensions: bindInitialExtensions,
    interruptActiveOperation,
    authority,
  };
}

// ── Pi 0.80.4 cache-miss notice parity ──────────────────────────────────

const CACHE_MISS_NOISE_FLOOR = 1024;
const CACHE_NOTICE_TOKEN_THRESHOLD = 20_000;
const CACHE_NOTICE_COST_THRESHOLD = 0.1;

function usageNumber(usage, key) {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function previousCacheRequest(message, reportedCache) {
  const usage = message?.usage;
  const promptTokens =
    usageNumber(usage, "input") +
    usageNumber(usage, "cacheRead") +
    usageNumber(usage, "cacheWrite");
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    modelKey: `${message?.provider ?? ""}/${message?.model ?? ""}`,
    timestamp: typeof message?.timestamp === "number" ? message.timestamp : 0,
    reportedCache:
      reportedCache || usageNumber(usage, "cacheRead") + usageNumber(usage, "cacheWrite") > 0,
  };
}

function cacheMissNoticeId(message) {
  const usage = message?.usage;
  return [
    "cache-miss",
    typeof message?.timestamp === "number" ? message.timestamp : 0,
    message?.provider ?? "",
    message?.model ?? "",
    usageNumber(usage, "input"),
    usageNumber(usage, "cacheRead"),
    usageNumber(usage, "cacheWrite"),
    usageNumber(usage, "output"),
  ].join(":");
}

function detectCacheMissNotice(session, message, previous) {
  const usage = message?.usage;
  const input = usageNumber(usage, "input");
  const cacheRead = usageNumber(usage, "cacheRead");
  const cacheWrite = usageNumber(usage, "cacheWrite");
  const promptTokens = input + cacheRead + cacheWrite;
  if (!previous || promptTokens <= 0 || (cacheRead + cacheWrite === 0 && !previous.reportedCache)) {
    return undefined;
  }

  const missedTokens = Math.min(previous.promptTokens, promptTokens) - cacheRead;
  if (missedTokens <= CACHE_MISS_NOISE_FLOOR) return undefined;

  const paidTokens = input + cacheWrite;
  const cost = usage?.cost;
  const paidPerToken =
    paidTokens > 0
      ? (usageNumber(cost, "input") + usageNumber(cost, "cacheWrite")) / paidTokens
      : 0;
  const model = modelAccess(session).getModel(message.provider, message.model);
  const readPerToken =
    cacheRead > 0
      ? usageNumber(cost, "cacheRead") / cacheRead
      : (typeof model?.cost?.cacheRead === "number" ? model.cost.cacheRead : 0) / 1_000_000;
  const missedCost = missedTokens * Math.max(0, paidPerToken - readPerToken);
  if (missedTokens < CACHE_NOTICE_TOKEN_THRESHOLD && missedCost < CACHE_NOTICE_COST_THRESHOLD) {
    return undefined;
  }

  return {
    type: "cache_miss_notice",
    noticeId: cacheMissNoticeId(message),
    missedTokens,
    missedCost,
    idleMs: Math.max(
      0,
      (typeof message.timestamp === "number" ? message.timestamp : 0) - previous.timestamp,
    ),
    modelChanged: `${message.provider ?? ""}/${message.model ?? ""}` !== previous.modelKey,
  };
}

function cacheEntries(session) {
  // Cache continuity follows the active root→leaf branch, not append order
  // across the full session tree. An abandoned fork's later file entry must
  // never become the "previous request" for the active branch.
  return session.sessionManager?.getBranch?.() ?? session.sessionManager?.getEntries?.() ?? [];
}

function buildCacheMissNotice(session, event) {
  if (
    event?.type !== "message_end" ||
    event.message?.role !== "assistant" ||
    event.message?.stopReason === "error" ||
    event.message?.stopReason === "aborted" ||
    session.settingsManager?.getShowCacheMissNotices?.() !== true
  ) {
    return undefined;
  }

  let previous;
  for (const entry of cacheEntries(session)) {
    if (entry?.type === "compaction" || entry?.type === "branch_summary") {
      previous = undefined;
      continue;
    }
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      previous = previousCacheRequest(entry.message, previous?.reportedCache ?? false) ?? previous;
    }
  }
  return detectCacheMissNotice(session, event.message, previous);
}

function buildHistoricalCacheMissNotices(session) {
  if (session.settingsManager?.getShowCacheMissNotices?.() !== true) return [];
  const notices = [];
  let previous;
  for (const entry of cacheEntries(session)) {
    if (entry?.type === "compaction" || entry?.type === "branch_summary") {
      previous = undefined;
      continue;
    }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant") continue;
    const notice = detectCacheMissNotice(session, message, previous);
    if (
      notice &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      typeof entry.id === "string"
    ) {
      notices.push({ ...notice, afterEntryId: entry.id });
    }
    previous = previousCacheRequest(message, previous?.reportedCache ?? false) ?? previous;
  }
  return notices;
}

// ── Scoped-models helpers ────────────────────────────────────────────────

/**
 * Resolve the pre-checked `provider/id` ids for the scoped-models picker,
 * mirroring pi's showModelsSelector initial-state derivation (interactive-mode):
 *   1. session.scopedModels (non-empty) → those ids directly.
 *   2. else settingsManager.getEnabledModels() patterns → resolve patterns
 *      locally (we cannot import pi's private resolveModelScope).
 *   3. else → null (all models checked = no scope).
 *
 * Returns `null` when nothing is scoped (the picker checks everything).
 */
function resolveEnabledModelIds(session, models) {
  const scoped = session.scopedModels;
  if (Array.isArray(scoped) && scoped.length > 0) {
    return scoped
      .map((entry) => {
        const m = entry?.model;
        return m ? `${m.provider}/${m.id}` : null;
      })
      .filter((s) => typeof s === "string");
  }
  const settingsPatterns = session.settingsManager?.getEnabledModels?.();
  if (Array.isArray(settingsPatterns) && settingsPatterns.length > 0) {
    return resolveModelScopePatterns(settingsPatterns, models);
  }
  return null;
}

/**
 * Minimal local replacement for pi's (private) resolveModelScope.
 *
 * For each pattern, match against the available models where a match is:
 *   - exact `provider/id` equality (case-insensitive), OR
 *   - exact `id` equality (case-insensitive), OR
 *   - if the pattern contains glob chars (* ? [), a minimatch-style match
 *     against both `provider/id` and bare `id`.
 *
 * An optional `:thinkingLevel` suffix is stripped before matching
 * (valid levels: off, minimal, low, medium, high, xhigh, max).
 *
 * This is best-effort for the *initial checkbox state*; the authoritative
 * scope is what the user submits (set_scoped_models).
 */
function resolveModelScopePatterns(patterns, models) {
  const VALID_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const matched = new Set();
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    let pattern = raw.trim();
    if (!pattern) continue;
    // Strip optional ":thinkingLevel" suffix.
    const colon = pattern.lastIndexOf(":");
    if (colon !== -1) {
      const suffix = pattern.slice(colon + 1).toLowerCase();
      if (VALID_LEVELS.has(suffix)) pattern = pattern.slice(0, colon);
    }
    const lower = pattern.toLowerCase();
    const hasGlob = /[\*\?\[]/.test(pattern);
    for (const m of models) {
      const providerId = `${m.provider}/${m.id}`.toLowerCase();
      const id = String(m.id).toLowerCase();
      let isMatch = providerId === lower || id === lower;
      if (!isMatch && hasGlob) {
        // Match against both the canonical "provider/id" and the bare id
        // (so "*sonnet*" matches without requiring "anthropic/*sonnet*").
        isMatch = minimatchSimple(pattern, providerId) || minimatchSimple(pattern, id);
      }
      if (isMatch) matched.add(providerId);
    }
  }
  return [...matched];
}

/**
 * Minimal glob: supports `*` (any chars), `?` (one char), `[...]` (char class).
 * Faithful enough for the enabled-models pattern list; not a full minimatch.
 */
function minimatchSimple(pattern, str) {
  // Case-insensitive, like the exact-match branches above.
  const re = globToRegExp(pattern.toLowerCase());
  return re.test(str.toLowerCase());
}

function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      // Pass through a char class (closing ] is the next ] after a leading !
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        out += glob.slice(i, end + 1);
        i = end;
      }
    } else if (".+^$(){}|\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Build the scoped-models array for setScopedModels().
 * - enabledIds null / empty / == all available → [] (no scope).
 * - otherwise → [{ model, thinkingLevel? }], preserving an existing
 *   scoped entry's thinkingLevel for a model that was already scoped.
 */
function buildScopedModels(session, models, enabledIds) {
  const prevScoped = new Map();
  if (Array.isArray(session.scopedModels)) {
    for (const entry of session.scopedModels) {
      const m = entry?.model;
      if (m) prevScoped.set(`${m.provider}/${m.id}`, entry.thinkingLevel);
    }
  }
  if (enabledIds === null || enabledIds.length === 0 || enabledIds.length >= models.length) {
    return [];
  }
  const wanted = new Set(enabledIds);
  const scoped = [];
  for (const m of models) {
    const providerId = `${m.provider}/${m.id}`;
    if (!wanted.has(providerId)) continue;
    const entry = { model: m };
    const prev = prevScoped.get(providerId);
    if (prev !== undefined) entry.thinkingLevel = prev;
    scoped.push(entry);
  }
  return scoped;
}

/**
 * Collect providers with stored auth for the /logout picker.
 * Returns [{ id, name, authType }] where name is a best-effort title-case
 * (pi's provider display names aren't a public export).
 */
async function collectLogoutProviders(session) {
  // Mirror Pi's public getLogoutProviderOptions path: list stored credentials
  // from the version-appropriate model surface rather than scanning available
  // models. A provider with
  // stored auth but no currently-listed model (e.g. expired key) is still
  // surfaced.
  const models = modelAccess(session);
  const credentials = await models.listCredentials();
  const out = credentials.map(({ providerId, type }) => ({
    id: providerId,
    name: models.getProviderName(providerId),
    authType: type,
  }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Build ExtensionCommandContextActions for bindExtensions.
 * Mirrors the ExtensionCommandContextActions interface (waitForIdle/newSession/
 * fork/navigateTree/switchSession/reload). navigateTree maps to fork with
 * position "before" (the closest runtime equivalent).
 */
function buildCommandContextActions({ runtime, authority, reload, replace, waitForIdle }) {
  return {
    waitForIdle,
    newSession: async (options) => replace(() => runtime.newSession(options), { kind: "new" }),
    fork: async (entryId, options) =>
      replace(() => runtime.fork(entryId, options), { kind: "fork" }),
    navigateTree: async (targetId, options) =>
      authority.runNavigation(() => authority.currentSession.navigateTree(targetId, options)),

    switchSession: async (sessionPath, options) =>
      replace(() => runtime.switchSession(sessionPath, options), {
        kind: "switch",
        targetFile: sessionPath,
      }),
    // Use the same transition-aware path as the external reload message.
    // Reload can emit extension/UI events before and after its rebind point.
    reload: async () => reload(),
  };
}

import { AsyncLocalStorage } from "node:async_hooks";
import { constants as osConstants } from "node:os";
import { basename } from "node:path";
import {
  MARKDOWN_TRANSFORM_MAX_OUTPUT_BYTES,
  MARKDOWN_TRANSFORM_MAX_RESPONSE_BATCH_BYTES,
  markdownTransformJsonBytes,
  markdownTransformUtf8Bytes,
} from "./markdown-transform-limits.mjs";
import { SHELL_ADMISSION_CANCELLED_CODE, createStateAuthority } from "./state-authority.mjs";

function exitSignalName(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return (
    Object.entries(osConstants.signals).find(([, number]) => number === value)?.[0] ??
    `SIGNAL_${value}`
  );
}

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
      refresh: (options) => runtime.refresh(options),
      logout: (provider) => runtime.logout(provider),
      listCredentials: () => runtime.listCredentials(),
      getProviders: () => runtime.getProviders?.() ?? [],
      checkAuth: (providerId) => runtime.checkAuth(providerId),
      login: (providerId, authType, interaction) =>
        runtime.login(providerId, authType, interaction, {
          // OpenAI's ChatGPT OAuth flow binds its token exchange to a stable
          // installation UUID. Pi's CLI supplies this public settings-backed
          // callback; SDK embedders must do the same.
          getDeviceId: () => {
            const getOrCreateDeviceId = session.settingsManager?.getOrCreateDeviceId;
            if (typeof getOrCreateDeviceId !== "function") {
              throw new Error("Pinned Pi settings do not expose a stable device ID");
            }
            return getOrCreateDeviceId.call(session.settingsManager);
          },
        }),
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
    checkAuth: async () => undefined,
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

function hasNativeProviderLogin(session) {
  const runtime = session?.modelRuntime;
  return Boolean(
    runtime &&
      typeof runtime.getProviders === "function" &&
      typeof runtime.checkAuth === "function" &&
      typeof runtime.login === "function",
  );
}

/**
 * Pi 0.84 refreshes can complete with provider-scoped errors or cancellation.
 * Keep those details inside the child authority (they can contain provider
 * URLs or headers), while refusing to publish a false successful refresh.
 * An undefined result remains the compatibility success shape for the public
 * pre-0.84 ModelRegistry adapter above.
 */
function completedModelRefresh(result) {
  if (result === undefined) return { refreshed: true };
  if (result?.aborted === true || (result?.errors && result.errors.size > 0)) {
    throw new Error("Model catalog refresh could not be completed");
  }
  return { refreshed: true };
}

function isCommittedCredentialSynchronizationError(pi, error, providerId, operation) {
  const ErrorType = pi?.CredentialSynchronizationError;
  return (
    typeof ErrorType === "function" &&
    error instanceof ErrorType &&
    error.operation === operation &&
    error.providerId === providerId
  );
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
export function assertHostCapabilities(session, runtime, pi) {
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
    "cycleModel",
    "setThinkingLevel",
    "cycleThinkingLevel",
    "setSteeringMode",
    "setFollowUpMode",
    "setScopedModels",
    "setAutoCompactionEnabled",
    "setAutoRetryEnabled",
    "executeBash",
    "recordBashResult",
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
  fn(session?.extensionRunner, "hasHandlers", "session.extensionRunner.hasHandlers");
  fn(session?.extensionRunner, "emitInput", "session.extensionRunner.emitInput");
  fn(session?.extensionRunner, "emitUserBash", "session.extensionRunner.emitUserBash");
  fn(session?.resourceLoader, "getSkills", "session.resourceLoader.getSkills");
  fn(session?.sessionManager, "getLeafId", "session.sessionManager.getLeafId");
  fn(session?.sessionManager, "getBranch", "session.sessionManager.getBranch");
  fn(session?.sessionManager, "getCwd", "session.sessionManager.getCwd");
  fn(session?.sessionManager, "appendCustomEntry", "session.sessionManager.appendCustomEntry");
  fn(pi, "resolveModelScopeWithDiagnostics", "pi.resolveModelScopeWithDiagnostics");
  fn(pi, "getShellConfig", "pi.getShellConfig");

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
  cancelDialogs = () => {},
  createProviderAuthSurface,
  runWithInvocationSurface,
  pi,
  agentDir,
  cwd,
  hostInstanceId = "test-host",
  sendControl = () => {},
  // Host-owned presentation reconstruction baselines. The child authority
  // serializes these only after prior ingress commits.
  authorityPresentation = {},
  createShellController = null,
  sendFrame = null,
  sendPresentation = null,
  // Main owns target validation and advisory locks. The child uses this only
  // after freezing its serialized semantic ingress.
  // Unit-level bridge consumers without a parent transport retain the legacy
  // in-process behavior; host.mjs always supplies the real main handshake.
  requestTransitionPermit = async () => ({ allowed: true, reason: "test/local permit" }),
  initialBinding = false,
  initialPresentedSessionFile,
  lifecycleUiTracker = { track: (promise) => promise },
  uiState = {
    catalogSnapshot: () => ({}),
    editorSnapshot: () => ({ revision: 0, text: "" }),
    acceptEditorSubmission: () => false,
    inspectShellEditorSubmission: () => ({ accepted: false }),
    acceptShellEditorSubmission: () => false,
    publishShellEditorSubmission: () => false,
    rollbackShellEditorSubmission: () => false,
    consumeEditorSource: () => ({
      accepted: false,
      editor: { revision: 0, text: "", attachments: [] },
    }),
    applyEditorPatch: () => ({ accepted: false }),
  },
}) {
  let _session = session;
  let _unsubscribe = null;
  const activeInterrupts = new Map();
  let activeCommands = 0;
  let nextInterruptId = 1;
  let activeShell = null;
  let activeNonPtyShell = null;
  const pendingUserBashPreparations = new Set();
  const lifecycleContext = new AsyncLocalStorage();
  const admissionContext = new AsyncLocalStorage();
  const inputEmissionContext = new AsyncLocalStorage();

  async function logoutProvider(providerId) {
    try {
      await modelAccess(_session).logout(providerId);
      return { provider: providerId, synchronized: true };
    } catch (error) {
      if (!isCommittedCredentialSynchronizationError(pi, error, providerId, "logout")) {
        // Provider logout errors may contain endpoints, headers, or credential
        // material. The app boundary needs only the mutation failure.
        throw new Error("Credential could not be removed");
      }
      uiContext?.notify?.(
        "Credential removed, but the local model catalog could not be refreshed. Refresh models before selecting another model.",
        "warning",
      );
      return { provider: providerId, synchronized: false };
    }
  }
  const observedInputRunners = new WeakMap();
  const lifecycleBlockers = new Map();
  let nextLifecycleId = 0;
  const resolveModelScope = async (patterns, targetSession = _session) => {
    if (typeof pi?.resolveModelScopeWithDiagnostics !== "function") {
      throw new Error("Pi is missing public resolveModelScopeWithDiagnostics()");
    }
    // Pi 0.80.8+ exposes ModelRuntime directly. Earlier supported releases
    // expose the public ModelRegistry shape accepted by their resolver.
    const modelSurface = targetSession?.modelRuntime ?? targetSession?.modelRegistry;
    if (!modelSurface) throw new Error("Pi session is missing its public model surface");
    return pi.resolveModelScopeWithDiagnostics(patterns, modelSurface);
  };
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
    initialPresentedSessionFile,
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
      ...(registeredMarkdownTransformers().length > 0
        ? { markdownTransformersAvailable: true }
        : {}),
      pendingDialogs: uiState.pendingDialogCount?.() ?? 0,
    }),
    getEditor: () => uiState.editorSnapshot(),
    inspectEditorSubmission: (request) => {
      if (typeof uiState.inspectEditorSubmission === "function") {
        return uiState.inspectEditorSubmission(request);
      }
      if (request.surface === "unified") return { accepted: false };
      const editor = uiState.editorSnapshot();
      return request.editorRevision === editor.revision
        ? { accepted: true, text: editor.text }
        : { accepted: false };
    },
    acceptEditorSubmission: (request) => uiState.acceptEditorSubmission?.(request) ?? false,
    inspectShellEditorSubmission: (request) => {
      if (typeof uiState.inspectShellEditorSubmission === "function") {
        return uiState.inspectShellEditorSubmission(request);
      }
      const editor = uiState.editorSnapshot();
      return {
        accepted: request.editorRevision === editor.revision && request.editorText === editor.text,
      };
    },
    acceptShellEditorSubmission: (request) =>
      uiState.acceptShellEditorSubmission?.(request) ?? false,
    publishShellEditorSubmission: (request) =>
      uiState.publishShellEditorSubmission?.(request) ?? false,
    rollbackShellEditorSubmission: (request) =>
      uiState.rollbackShellEditorSubmission?.(request) ?? false,
    onAdmissionStuck: ({ intentId }) => {
      send({
        type: "fatal_transition_error",
        message: `Prompt admission remained unresolved for intent ${intentId}`,
      });
    },
    hasPendingBashPreparation: () => pendingUserBashPreparations.size > 0,
    cancelPendingBashPreparation: () => cancelPendingUserBashPreparations(),
    runWithSurface: (surface, operation, intentId) =>
      admissionContext.run(intentId, () => {
        ensureInputResultObserver(_session.extensionRunner);
        return typeof runWithInvocationSurface === "function"
          ? runWithInvocationSurface(surface, operation)
          : operation();
      }),
  });

  function ensureInputResultObserver(runner) {
    if (!runner || typeof runner.emitInput !== "function") return;
    const installed = observedInputRunners.get(runner);
    if (installed && runner.emitInput === installed) return;
    const emitInput = runner.emitInput;
    const wrapped = function (...args) {
      const nested = inputEmissionContext.getStore() === true;
      const initiatingIntentId = admissionContext.getStore();
      return inputEmissionContext.run(true, async () => {
        const result = await Reflect.apply(emitInput, this, args);
        if (!nested) {
          authority.observeInputAdmissionResult(
            initiatingIntentId,
            {
              text: args[0],
              images: args[1],
              source: args[2],
              streamingBehavior: args[3],
            },
            result,
          );
        }
        return result;
      });
    };
    try {
      // ExtensionRunner.emitInput() is a public Pi method. Wrapping the live
      // runner here observes its final continue/transform/handled result
      // without executing handlers twice. The current runner is checked at
      // each operation, so Pi reload/rebind replacements are covered too.
      runner.emitInput = wrapped;
      if (runner.emitInput === wrapped) observedInputRunners.set(runner, wrapped);
    } catch {
      // A non-writable/non-conforming runner retains conservative anonymous
      // queue attribution rather than making prompt admission fail.
    }
  }

  // A confined search open gives Pi an inode-stable transport path while the
  // authority presents the validated canonical source. Extensions can read
  // that transport path through Pi's public ReadonlySessionManager and pass it
  // back through replacement actions. Translate only the exact initial pin;
  // arbitrary extension-supplied paths remain untouched.
  const initialRuntimeSessionFile =
    typeof initialPresentedSessionFile === "string" &&
    typeof session.sessionFile === "string" &&
    initialPresentedSessionFile !== session.sessionFile
      ? session.sessionFile
      : undefined;
  function canonicalizeSessionReference(reference) {
    return initialRuntimeSessionFile && reference === initialRuntimeSessionFile
      ? initialPresentedSessionFile
      : reference;
  }

  function canonicalizeNewSessionOptions(options) {
    if (!options || typeof options.parentSession !== "string") return options;
    const parentSession = canonicalizeSessionReference(options.parentSession);
    return parentSession === options.parentSession ? options : { ...options, parentSession };
  }

  function defaultExportOutputPath(outputPath) {
    if (typeof outputPath === "string" && outputPath.length > 0) return outputPath;
    const sessionFile = authority.presentedSessionFile;
    if (typeof sessionFile !== "string" || sessionFile.length === 0) return outputPath;
    // Pi's public export API accepts an explicit path. Supplying the same
    // default shape Pi uses keeps all file I/O inside that public operation
    // while deriving the visible name from canonical session identity.
    return `pi-session-${basename(sessionFile, ".jsonl")}.html`;
  }

  function exportSessionToHtml(outputPath) {
    return _session.exportToHtml(defaultExportOutputPath(outputPath));
  }

  if (initialBinding) authority.beginTransition(authority.sessionEpoch, false);

  function presentShellSnapshot(
    shell,
    snapshot,
    keyframe,
    reconstructionFenceToken = shell.reconstructionFenceToken,
  ) {
    const replay = snapshot.replay;
    const hasKeyframe = typeof keyframe?.ansi === "string";
    const omitted = hasKeyframe
      ? keyframe.truncated === true || replay.gap
      : replay.gap || replay.truncated;
    if (
      activeShell === shell &&
      shell.inputFenced &&
      shell.reconstructionFenceToken === reconstructionFenceToken
    ) {
      shell.inputFenceThrough = snapshot.outputSequence;
    }
    const ansi = hasKeyframe
      ? `${keyframe.ansi}${replay.chunks.map((chunk) => chunk.data).join("")}`
      : `${omitted ? "\r\n[Earlier live terminal output omitted]\r\n" : ""}${replay.chunks
          .map((chunk) => chunk.data)
          .join("")}`;
    return {
      id: shell.executionId,
      command: shell.command,
      startedAt: shell.startedAt,
      cwd: shell.cwd,
      ...(shell.excludeFromContext !== undefined
        ? { excludeFromContext: shell.excludeFromContext }
        : {}),
      cols: snapshot.cols,
      rows: snapshot.rows,
      mode: shell.mode,
      ansi,
      reconstructionFenceToken,
      outputThroughSequence: snapshot.outputSequence,
      inputAcknowledgedThrough: snapshot.inputAcknowledgedThrough,
      resizeRevision: snapshot.resizeRevision,
      ...(shell.interruptRequestedAt !== undefined
        ? { interruptRequestedAt: shell.interruptRequestedAt }
        : {}),
      ...(omitted ? { replayTruncated: true } : {}),
    };
  }

  function retainedShellSnapshot() {
    if (!activeShell) return undefined;
    return presentShellSnapshot(activeShell, activeShell.controller.snapshot());
  }

  async function prepareRetainedShellSnapshot(reconstructionFence) {
    const shell = reconstructionFence?.shell ?? activeShell;
    if (!shell) return undefined;
    const reconstructionFenceToken = reconstructionFence?.token ?? shell.reconstructionFenceToken;
    if (typeof shell.controller.reconstructionSnapshot !== "function") {
      return presentShellSnapshot(
        shell,
        shell.controller.snapshot(),
        undefined,
        reconstructionFenceToken,
      );
    }

    const reconstruction = await shell.controller.reconstructionSnapshot();
    if (activeShell !== shell) return undefined;
    return presentShellSnapshot(
      shell,
      reconstruction.snapshot,
      reconstruction.keyframe,
      reconstructionFenceToken,
    );
  }

  function sendShellInput(executionId, sequence, data) {
    if (!activeShell || activeShell.executionId !== executionId) {
      return { accepted: false, acknowledgedThrough: 0 };
    }
    if (activeShell.inputFenced) {
      return {
        accepted: false,
        acknowledgedThrough: activeShell.controller.snapshot().inputAcknowledgedThrough,
      };
    }
    const result = activeShell.controller.writeInput({ sequence, data });
    return {
      accepted: result.accepted === true,
      acknowledgedThrough: result.acknowledgedThrough,
      ...(result.gap
        ? {
            gap: {
              expected: result.expectedSequence,
              received: sequence,
            },
          }
        : {}),
    };
  }

  function resizeShell(executionId, revision, cols, rows) {
    if (!activeShell || activeShell.executionId !== executionId) return false;
    if (activeShell.inputFenced) return false;
    return activeShell.controller.resize({ revision, cols, rows }).accepted === true;
  }

  function fenceShellReconstruction() {
    if (!activeShell) return undefined;
    if (
      !Number.isSafeInteger(activeShell.reconstructionFenceToken) ||
      activeShell.reconstructionFenceToken < 0 ||
      activeShell.reconstructionFenceToken === Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Shell reconstruction fence token exhausted");
    }
    activeShell.reconstructionFenceToken += 1;
    activeShell.inputFenced = true;
    activeShell.inputFenceThrough = activeShell.controller.snapshot().outputSequence;
    authority.setShellInputReady(activeShell.executionId, false);
    return { shell: activeShell, token: activeShell.reconstructionFenceToken };
  }

  function acknowledgeShellReconstruction(
    executionId,
    reconstructionFenceToken,
    outputThroughSequence,
  ) {
    if (!activeShell || activeShell.executionId !== executionId) return false;
    if (
      !Number.isSafeInteger(reconstructionFenceToken) ||
      reconstructionFenceToken !== activeShell.reconstructionFenceToken ||
      !Number.isSafeInteger(outputThroughSequence) ||
      outputThroughSequence !== activeShell.inputFenceThrough
    ) {
      return false;
    }
    // The renderer retries acknowledgements while reconstruction is fenced.
    // Keep that fence in place until stdin-transport bootstrap output has been
    // removed and the controller can actually accept input.
    if (activeShell.controller.snapshot().inputReady !== true) return false;
    activeShell.inputFenced = false;
    authority.setShellInputReady(executionId, true);
    return true;
  }

  function signalShell(executionId, signal) {
    if (!activeShell || activeShell.executionId !== executionId) return false;
    if (activeShell.inputFenced) return false;
    if (signal === "interrupt") {
      const result = activeShell.controller.interrupt();
      if (result.requested === true) {
        activeShell.interruptRequestedAt = Date.now();
        _session.abortBash();
      }
      return result.requested === true || result.alreadyRequested === true;
    }
    if (signal === "kill") {
      const result = activeShell.controller.forceKill();
      // Mark Pi's public bash operation cancelled as well as terminating the
      // PTY, so its canonical persisted BashExecutionMessage is truthful.
      if (result.requested === true) _session.abortBash();
      return result.requested === true || result.alreadyRequested === true;
    }
    return false;
  }

  function disposeShell() {
    cancelPendingUserBashPreparations();
    activeShell?.controller.forceKill();
    _session.abortBash();
  }

  function setShellTransportBackpressure(backpressured) {
    activeShell?.controller.setTransportBackpressured?.(backpressured === true);
  }

  function cancelPendingUserBashPreparations() {
    let cancelled = 0;
    for (const preparation of [...pendingUserBashPreparations]) {
      if (preparation.cancel()) cancelled += 1;
    }
    return cancelled;
  }

  function emitUserBash(command, excludeFromContext) {
    const shellCwd = _session.sessionManager.getCwd();
    const event = {
      type: "user_bash",
      command,
      excludeFromContext: excludeFromContext ?? false,
      cwd: shellCwd,
    };

    // UserBashEvent intentionally has no AbortSignal. Race the public emitter
    // against a host-owned cancellation token and keep consuming the losing
    // promise: ESC/abort can release serialized admission immediately, while
    // a late handler result or rejection can never execute, persist, or become
    // an unhandled rejection.
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return false;
        settled = true;
        pendingUserBashPreparations.delete(preparation);
        callback(value);
        return true;
      };
      const preparation = {
        cancel: () => {
          const error = new Error("Shell command was cancelled before it started");
          error.code = SHELL_ADMISSION_CANCELLED_CODE;
          return settle(reject, error);
        },
      };
      pendingUserBashPreparations.add(preparation);

      let operation;
      try {
        operation = _session.extensionRunner.emitUserBash(event);
      } catch (error) {
        settle(reject, error);
        return;
      }
      Promise.resolve(operation).then(
        (result) => settle(resolve, result),
        (error) => settle(reject, error),
      );
    });
  }

  function emitUserBashForSurface(surface, command, excludeFromContext) {
    const operation = () => emitUserBash(command, excludeFromContext);
    return typeof runWithInvocationSurface === "function"
      ? runWithInvocationSurface(surface, operation)
      : operation();
  }

  function executeNonPtyBash(executionId, command, excludeFromContext, eventResult) {
    if (activeShell || activeNonPtyShell) throw new Error("A Shell Turn is already running");
    const shellSession = _session;
    const shellToken = { executionId, session: shellSession };
    activeNonPtyShell = shellToken;
    const startedAt = Date.now();
    const shellCwd = shellSession.sessionManager.getCwd();
    const release = () => {
      if (activeNonPtyShell === shellToken) activeNonPtyShell = null;
    };
    try {
      shellSession.sessionManager.appendCustomEntry("pivis.shell_turn_start", {
        version: 1,
        executionId,
        command,
        excludeFromContext: excludeFromContext === true,
        startedAt,
        cwd: shellCwd,
        pty: false,
      });
      authority.observeEvent({
        type: "bash_execution_start",
        id: executionId,
        command,
        ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
        pty: false,
        startedAt,
        cwd: shellCwd,
      });
    } catch (error) {
      release();
      throw error;
    }

    const finish = (result, errorMessage) => {
      const endedAt = Date.now();
      try {
        authority.observeEvent({
          type: "bash_execution_end",
          id: executionId,
          command,
          output: typeof result?.output === "string" ? result.output : "",
          ...(Number.isInteger(result?.exitCode) ? { exitCode: result.exitCode } : {}),
          ...(typeof result?.cancelled === "boolean" ? { cancelled: result.cancelled } : {}),
          ...(typeof result?.truncated === "boolean" ? { truncated: result.truncated } : {}),
          ...(typeof result?.fullOutputPath === "string"
            ? { fullOutputPath: result.fullOutputPath }
            : {}),
          ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
          ...(errorMessage ? { errorMessage } : {}),
          pty: false,
          durationMs: Math.max(0, endedAt - startedAt),
        });
        try {
          shellSession.sessionManager.appendCustomEntry("pivis.shell_turn_complete", {
            version: 1,
            executionId,
            endedAt,
            durationMs: Math.max(0, endedAt - startedAt),
            ...(Number.isInteger(result?.exitCode) ? { exitCode: result.exitCode } : {}),
            ...(typeof result?.cancelled === "boolean" ? { cancelled: result.cancelled } : {}),
            ...(typeof result?.truncated === "boolean" ? { truncated: result.truncated } : {}),
            ...(errorMessage ? { errorMessage } : {}),
          });
        } catch (error) {
          console.error(
            "[pi-session-host] Failed to persist Shell Turn metadata:",
            error instanceof Error ? error.message : error,
          );
        }
      } finally {
        release();
      }
    };

    const recordFailure = (error, persist = true) => {
      const detail = (error instanceof Error ? error.message : String(error))
        .replaceAll("\u0000", "")
        .replaceAll("\u001b", "")
        .slice(0, 4_096);
      const result = {
        output: `[Shell execution failed: ${detail || "unknown error"}]`,
        cancelled: false,
        truncated: false,
      };
      if (persist) {
        try {
          shellSession.recordBashResult(command, result, {
            ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
          });
        } catch (recordError) {
          console.error(
            "[pi-session-host] Failed to persist Shell Turn failure:",
            recordError instanceof Error ? recordError.message : recordError,
          );
        }
      }
      return { result, detail: detail || "unknown error" };
    };

    if (eventResult.result) {
      try {
        shellSession.recordBashResult(command, eventResult.result, {
          ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
        });
        finish(eventResult.result);
        return Promise.resolve(eventResult.result);
      } catch (error) {
        // The replacement result already made its one canonical recording
        // attempt. Do not append a second Bash message if that attempt threw.
        const failure = recordFailure(error, false);
        finish(failure.result, failure.detail);
        return Promise.reject(error);
      }
    }

    let operation;
    try {
      operation = shellSession.executeBash(command, undefined, {
        id: executionId,
        ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
        operations: eventResult.operations,
      });
    } catch (error) {
      const failure = recordFailure(error);
      finish(failure.result, failure.detail);
      return Promise.reject(error);
    }
    return Promise.resolve(operation).then(
      (result) => {
        finish(result);
        return result;
      },
      (error) => {
        const failure = recordFailure(error);
        finish(failure.result, failure.detail);
        throw error;
      },
    );
  }

  function executeStreamingBash(executionId, command, excludeFromContext, eventResult) {
    if (eventResult?.result || eventResult?.operations) {
      return executeNonPtyBash(executionId, command, excludeFromContext, eventResult);
    }
    if (typeof createShellController !== "function") {
      throw new Error("Shell PTY capability is unavailable");
    }
    if (activeShell || activeNonPtyShell) throw new Error("A Shell Turn is already running");
    if (typeof pi?.getShellConfig !== "function") {
      throw new Error("Pi is missing public getShellConfig()");
    }
    const startedAt = Date.now();
    const shellCwd =
      typeof _session.sessionManager?.getCwd === "function"
        ? _session.sessionManager.getCwd()
        : cwd;
    let terminalMode = "compact";
    let controller;
    controller = createShellController({
      executionId,
      shellConfig: pi.getShellConfig(_session.settingsManager?.getShellPath?.()),
      baseEnv: process.env,
      onRawData: ({ sequence, data }) => {
        authority.observeEvent({
          type: "bash_terminal_data",
          id: executionId,
          data,
          sequence,
          mode: terminalMode,
        });
      },
      onStateChange: (snapshot) => {
        if (activeShell?.executionId === executionId) {
          authority.setShellInputReady(
            executionId,
            snapshot.inputReady === true && activeShell.inputFenced !== true,
          );
        }
        const nextMode = snapshot.terminal?.activeBuffer === "alternate" ? "fullscreen" : "compact";
        if (nextMode === terminalMode) return;
        terminalMode = nextMode;
        if (activeShell?.executionId === executionId) activeShell.mode = terminalMode;
        authority.observeEvent({
          type: "bash_terminal_data",
          id: executionId,
          data: "",
          mode: terminalMode,
        });
      },
      onCallbackError: (error) => {
        console.error(
          "[pi-session-host] Shell PTY presentation error:",
          error instanceof Error ? error.message : error,
        );
      },
    });
    activeShell = {
      executionId,
      command,
      startedAt,
      cwd: shellCwd,
      excludeFromContext,
      mode: terminalMode,
      controller,
      inputFenced: false,
      inputFenceThrough: 0,
      reconstructionFenceToken: 0,
    };
    try {
      _session.sessionManager.appendCustomEntry("pivis.shell_turn_start", {
        version: 1,
        executionId,
        command,
        excludeFromContext: excludeFromContext === true,
        startedAt,
        cwd: shellCwd,
        pty: true,
      });
    } catch (error) {
      activeShell = null;
      controller.dispose();
      throw error;
    }
    const finish = (result, errorMessage) => {
      const endedAt = Date.now();
      let snapshot;
      try {
        snapshot = controller.snapshot();
      } catch {
        snapshot = {
          interruptRequested: false,
          forceKillRequested: false,
          terminal: { alternateScreenSeen: false },
        };
      }
      const interrupted = snapshot.interruptRequested === true;
      const forceKilled = snapshot.forceKillRequested === true;
      const normalization = snapshot.terminal.alternateScreenSeen
        ? "alternate_screen_final"
        : "terminal_buffer";
      const processSignal = exitSignalName(snapshot.exitSignal);
      const signal = processSignal
        ? processSignal
        : forceKilled
          ? "SIGKILL"
          : interrupted
            ? "SIGINT"
            : undefined;
      const cancelled = result?.cancelled === true || interrupted || forceKilled;
      const reportsCancellation =
        typeof result?.cancelled === "boolean" || interrupted || forceKilled;
      authority.observeEvent({
        type: "bash_execution_end",
        id: executionId,
        command,
        output: typeof result?.output === "string" ? result.output : "",
        ...(Number.isInteger(result?.exitCode) ? { exitCode: result.exitCode } : {}),
        ...(reportsCancellation ? { cancelled } : {}),
        ...(typeof result?.truncated === "boolean" ? { truncated: result.truncated } : {}),
        ...(typeof result?.fullOutputPath === "string"
          ? { fullOutputPath: result.fullOutputPath }
          : {}),
        ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        pty: true,
        durationMs: Math.max(0, endedAt - startedAt),
        ...(signal ? { signal } : {}),
        normalization,
      });
      try {
        _session.sessionManager.appendCustomEntry("pivis.shell_turn_complete", {
          version: 1,
          executionId,
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          ...(Number.isInteger(result?.exitCode) ? { exitCode: result.exitCode } : {}),
          ...(reportsCancellation ? { cancelled } : {}),
          ...(typeof result?.truncated === "boolean" ? { truncated: result.truncated } : {}),
          ...(errorMessage ? { errorMessage } : {}),
          ...(signal ? { signal } : {}),
          normalization,
        });
      } catch (error) {
        console.error(
          "[pi-session-host] Failed to persist Shell Turn metadata:",
          error instanceof Error ? error.message : error,
        );
      }
      if (activeShell?.executionId === executionId) activeShell = null;
      controller.dispose();
    };

    const recordFailedShell = (error) => {
      const detail = (error instanceof Error ? error.message : String(error))
        .replaceAll("\u0000", "")
        .replaceAll("\u001b", "")
        .slice(0, 4_096);
      const output = `[Shell execution failed: ${detail || "unknown error"}]`;
      const result = {
        output,
        cancelled: false,
        truncated: false,
      };
      try {
        _session.recordBashResult(command, result, {
          id: executionId,
          ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
        });
      } catch (recordError) {
        console.error(
          "[pi-session-host] Failed to persist Shell Turn failure:",
          recordError instanceof Error ? recordError.message : recordError,
        );
      }
      return { result, detail: detail || "unknown error" };
    };

    let operation;
    try {
      const startedSnapshot = controller.snapshot();
      authority.observeEvent({
        type: "bash_execution_start",
        id: executionId,
        command,
        ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
        pty: true,
        startedAt,
        cwd: shellCwd,
        cols: startedSnapshot.cols,
        rows: startedSnapshot.rows,
      });
      operation = _session.executeBash(command, undefined, {
        id: executionId,
        ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
        operations: controller.operations,
      });
    } catch (error) {
      const failure = recordFailedShell(error);
      try {
        finish(failure.result, failure.detail);
      } catch (finishError) {
        if (activeShell?.executionId === executionId) activeShell = null;
        controller.dispose();
        console.error(
          "[pi-session-host] Failed to settle Shell Turn startup error:",
          finishError instanceof Error ? finishError.message : finishError,
        );
      }
      return Promise.reject(error);
    }
    return Promise.resolve(operation).then(
      (result) => {
        finish(result);
        return result;
      },
      (error) => {
        const failure = recordFailedShell(error);
        finish(failure.result, failure.detail);
        throw error;
      },
    );
  }

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
    cancelPendingUserBashPreparations();
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
      // Queue work started by an input hook is extension-owned even when that
      // hook ultimately returns `continue`. Detached/nested work inherits this
      // context, so never let it claim the outer GUI admission's queue slot.
      const initiatingIntentId =
        inputEmissionContext.getStore() === true ? undefined : admissionContext.getStore();
      authority.observeEvent(event, initiatingIntentId);
      // Pi 0.80.4's cache-miss notices normally live in InteractiveMode, which
      // the SDK host does not instantiate. Re-derive the same opt-in notice
      // from public session/message data so showCacheMissNotices still works.
      const cacheMissNotice = buildCacheMissNotice(s, event);
      if (cacheMissNotice) authority.observeEvent(cacheMissNotice);
      const cacheWarmingNotice = buildCacheWarmingNotice(s, event);
      if (cacheWarmingNotice) authority.observeEvent(cacheWarmingNotice);
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
        canonicalizeSessionReference,
        canonicalizeNewSessionOptions,
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
    uiState.resetExtensionPresentation?.();
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
      ...(s.routedModel ? { routedModel: structuredClone(s.routedModel) } : {}),
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      isIdle: s.isIdle,
      isCompacting: s.isCompacting,
      isRetrying: s.isRetrying,
      retryAttempt: s.retryAttempt,
      isBashRunning: s.isBashRunning,
      steeringMode: s.steeringMode,
      followUpMode: s.followUpMode,
      sessionFile: authority.presentedSessionFile,
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

  function getSessionStats() {
    const stats = _session.getSessionStats();
    const sessionFile = authority.presentedSessionFile;
    return typeof sessionFile === "string" ? { ...stats, sessionFile } : stats;
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

  /** Render and dispose one public extension pi-tui component in the SDK host. */
  function renderExtensionComponent(renderer, value, customType, cols, expanded, options = {}) {
    let component;
    try {
      component = renderer(value, { expanded: expanded === true, ...options }, uiContext?.theme);
      if (!component || typeof component.render !== "function") return { rendered: false };
      const lines = component.render(Math.max(20, Math.min(240, Math.floor(cols))));
      if (!Array.isArray(lines)) return { rendered: false };
      return { rendered: true, ansi: lines.map((line) => String(line)).join("\n") };
    } catch (err) {
      const message = `[${customType}] renderer failed: ${
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
    return renderExtensionComponent(renderer, entry, entry.customType, cols, expanded);
  }

  /**
   * Render a uniquely identified public AgentSession custom message through
   * the extension's public MessageRenderer. Pi messages expose no stable ID,
   * so customType + timestamp is accepted only when it selects exactly one.
   */
  function renderMessage(customType, timestamp, cols, expanded) {
    const runner = _session.extensionRunner;
    const messages = _session.messages;
    if (!Array.isArray(messages) || typeof runner?.getMessageRenderer !== "function") {
      return { rendered: false };
    }

    let match;
    for (const message of messages) {
      if (
        message?.role !== "custom" ||
        message.customType !== customType ||
        message.timestamp !== timestamp
      ) {
        continue;
      }
      if (match !== undefined) return { rendered: false };
      match = message;
    }
    if (match === undefined) return { rendered: false };

    const renderer = runner.getMessageRenderer(customType);
    if (typeof renderer !== "function") return { rendered: false };
    return renderExtensionComponent(renderer, match, customType, cols, expanded, {
      outputPad: _session.settingsManager?.getOutputPad?.() ?? 0,
    });
  }

  /** Keep extension functions in the child and return display-only strings. */
  function registeredMarkdownTransformers() {
    try {
      const transformers = _session.extensionRunner?.getMarkdownTransformers?.();
      return Array.isArray(transformers)
        ? transformers.filter((transformer) => typeof transformer === "function")
        : [];
    } catch {
      return [];
    }
  }

  function transformMarkdown(items) {
    const transformers = registeredMarkdownTransformers();
    const rawItems = items.map((item) => ({ requestId: item.requestId, markdown: item.markdown }));
    let projectedBytes = markdownTransformJsonBytes({ items: rawItems });
    const transformedItems = [];
    for (const [index, item] of items.entries()) {
      let markdown = item.markdown;
      const context = {
        messageType: item.messageType,
        isStreaming: item.isStreaming,
        availableWidth: item.availableWidth,
      };
      for (const transformer of transformers) {
        try {
          const transformed = transformer(markdown, context);
          if (
            typeof transformed === "string" &&
            markdownTransformUtf8Bytes(transformed) <= MARKDOWN_TRANSFORM_MAX_OUTPUT_BYTES
          ) {
            markdown = transformed;
          }
        } catch {
          // Match Pi: preserve the current value and continue the chain.
        }
      }
      const transformedItem = { requestId: item.requestId, markdown };
      projectedBytes +=
        markdownTransformJsonBytes(transformedItem) - markdownTransformJsonBytes(rawItems[index]);
      if (projectedBytes > MARKDOWN_TRANSFORM_MAX_RESPONSE_BATCH_BYTES) {
        // Stop invoking extension code and return the complete raw batch. This
        // avoids retaining or emitting a partially transformed oversized batch.
        return { items: rawItems };
      }
      transformedItems.push(transformedItem);
    }
    return { items: transformedItems };
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
    let editorSourceConsumed = reloadEditorCommand?.surface === "unified";
    try {
      await requestReplacementPermit(
        transitionId,
        "prepare",
        "reload",
        authority.presentedSessionFile,
      );
      await runLifecycle(
        () =>
          _session.reload({
            beforeSessionStart: async () => {
              authority.markTransitionBoundaryCrossed();
              panelBridge.closeAll();
              uiState.resetExtensionPresentation?.();
              cancelDialogs();
              authority.adoptSession(_session, authority.sessionEpoch + 1);
            },
          }),
        "Reload",
      );
      // reload keeps the AgentSession object and subscription but replaces
      // extension bindings; publish all buffered events with one terminal read.
      await requestReplacementPermit(
        transitionId,
        "successor",
        "reload",
        authority.presentedSessionFile,
      );
      // Reload retains the AgentSession and therefore its host-owned editor.
      // Consume the exact native command only after both replacement permits
      // and the reload itself succeeded. A refusal/failure before this point
      // leaves the still-visible Composer source in custody. Unified dispatch
      // was already cleared and preclaimed at its onSubmit boundary.
      const editor = uiState.editorSnapshot();
      if (
        reloadEditorCommand &&
        reloadEditorCommand.surface !== "unified" &&
        editor.revision === reloadEditorCommand.editorRevision &&
        editor.text === reloadEditorCommand.editorText
      ) {
        editorSourceConsumed =
          uiState.acceptEditorSubmission({
            intentId: reloadEditorCommand.intentId,
            editorRevision: reloadEditorCommand.editorRevision,
            text: reloadEditorCommand.editorText,
            inputKind: "slash_command",
          }) === true;
      }
      authority.commitTransition();
      return { editorSourceConsumed };
    } catch (err) {
      if (err && typeof err === "object") err.editorSourceConsumed = editorSourceConsumed;
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
      const cancelled = result?.cancelled === true;
      return { cancelled, response: { cancelled } };
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
      case "switch": {
        if (!args) throw new Error(`Usage: /${name} <session-path>`);
        const sessionPath = canonicalizeSessionReference(args);
        return {
          handled: true,
          result: await replace(() => runtime.switchSession(sessionPath), {
            kind: "switch",
            targetFile: sessionPath,
          }),
        };
      }
      case "export":
        return {
          handled: true,
          result: { response: { path: await exportSessionToHtml(args || undefined) } },
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
            result: {
              response: {
                models,
                enabledIds: await resolveEnabledModelIds(_session, resolveModelScope),
              },
            },
          };
        }
        const scopeCommand = /^(apply|save)(?:\s+([\s\S]*))?$/.exec(args);
        if (!scopeCommand) throw new Error("Usage: /models [apply|save] [provider/model,...]");
        const [, verb, payload = ""] = scopeCommand;
        const models = await modelAccess(_session).getAvailable();
        let enabledIds = null;
        if (payload.startsWith("--json ")) {
          let decoded;
          try {
            decoded = JSON.parse(payload.slice("--json ".length));
          } catch {
            throw new Error("Invalid /models JSON payload");
          }
          if (!Array.isArray(decoded) || !decoded.every((value) => typeof value === "string")) {
            throw new Error("Invalid /models JSON payload");
          }
          enabledIds = decoded;
        } else if (payload) {
          // Preserve the user-facing legacy CSV form. Pi-Vis-owned picker
          // submissions use the JSON form so saved partial/name patterns may
          // contain whitespace or commas without being split or truncated.
          enabledIds = payload.split(",").filter(Boolean);
        }
        const scoped = await buildScopedModels(models, enabledIds, resolveModelScope);
        _session.setScopedModels(scoped);
        if (verb === "save") {
          const isAll = selectsEveryAvailableModel(models, enabledIds);
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
        return { handled: true, result: { response: await logoutProvider(words[0]) } };
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
          result: { response: { stats: getSessionStats(), state: getState() } },
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

  function commandForPickerAction(selection) {
    switch (selection.action) {
      case "fork":
        return `/fork ${selection.entryId}`;
      case "setScopedModels":
        return `/models ${selection.persist ? "save" : "apply"}${
          selection.enabledIds === null ? "" : ` --json ${JSON.stringify(selection.enabledIds)}`
        }`;
      case "logoutProvider":
        return `/logout ${selection.providerId}`;
      default:
        throw new Error("Unknown picker action");
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
            inputKind: intent.inputKind,
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
          // ModelRuntime.refresh is a mutation, never a read query. Settle it
          // off-scheduler so provider network refresh cannot freeze ingress;
          // the renderer owner-fenced read obtains the catalog afterward.
          return {
            deferredOutcome: Promise.resolve()
              .then(() => modelAccess(_session).refresh({ signal: AbortSignal.timeout(15_000) }))
              .then(completedModelRefresh, () => {
                // A thrown provider/config error can contain endpoints,
                // headers, or credential hints. Publish only the bounded
                // app-owned failure used for resolved error maps above.
                throw new Error("Model catalog refresh could not be completed");
              }),
          };
        case "loginProvider": {
          // Re-read the live runtime immediately before crossing the SDK
          // boundary; picker metadata is advisory and may be stale.
          if (
            !hasNativeProviderLogin(_session) ||
            _session.settingsManager?.isProjectTrusted?.() === false ||
            typeof createProviderAuthSurface !== "function"
          ) {
            throw new Error("Sign in is unavailable for this session");
          }
          const provider = modelAccess(_session)
            .getProviders()
            .find((item) => item?.id === intent.providerId);
          const authMethod =
            intent.authType === "oauth"
              ? provider?.auth?.oauth?.login
              : provider?.auth?.apiKey?.login;
          if (!provider || typeof authMethod !== "function") {
            throw new Error("This sign-in method is no longer available");
          }
          const controller = new AbortController();
          const surface = createProviderAuthSurface(
            String(provider.name ?? provider.id),
            intent.authType,
            controller.signal,
            () => controller.abort(),
          );
          const operation = trackInterruptibleOperation(
            "login",
            () => controller.abort(),
            async () => {
              try {
                // Deliberately discard Credential. The bounded intent result
                // proves only which public login method completed.
                await modelAccess(_session).login(
                  intent.providerId,
                  intent.authType,
                  surface.interaction,
                );
                surface.complete();
                return {
                  providerId: intent.providerId,
                  authType: intent.authType,
                  synchronized: true,
                };
              } catch (error) {
                if (
                  isCommittedCredentialSynchronizationError(pi, error, intent.providerId, "login")
                ) {
                  // Pi 0.84 deliberately distinguishes a committed credential
                  // from a failed local model/auth snapshot refresh. Do not
                  // call the completed write a failed sign-in, and never let
                  // the Credential carried by the SDK error cross authority.
                  surface.warn?.();
                  return {
                    providerId: intent.providerId,
                    authType: intent.authType,
                    synchronized: false,
                  };
                }
                if (controller.signal.aborted) surface.complete();
                else surface.fail();
                // Never forward provider-native errors: they can include a URL,
                // code, header, or provider-supplied secret.
                throw new Error("Sign in could not be completed");
              }
            },
          );
          return { deferredOutcome: operation };
        }
        case "submit":
          return submission(intent.text);
        case "manageQueue":
          return authority.manageQueue(intent);
        case "pickerAction": {
          // The source slash command was already durably cleared before the
          // picker became visible. The typed selection can resolve only one
          // bounded app-owned operation; discovered slash bindings never
          // intercept it or claim the successor empty editor as their source.
          const operation = async () => {
            const resolved = await invokeBuiltinCommand(
              commandForPickerAction(intent.selection),
              envelope.intentId,
            );
            if (!resolved.handled) {
              throw new Error("The selected picker action is no longer available");
            }
            return resolved.result;
          };
          return typeof runWithInvocationSurface === "function"
            ? runWithInvocationSurface(intent.surface, operation)
            : operation();
        }
        case "invokeCommand": {
          if (typeof intent.text !== "string" || !intent.text.startsWith("/")) {
            throw new Error("invokeCommand requires slash command text");
          }
          const operation = async () => {
            const resolved = await invokeBuiltinCommand(intent.text, envelope.intentId);
            if (resolved.handled) return resolved.result;
            // Only extension/template/skill commands (and intentional unknown
            // slash prompt text) reach Pi's public prompt parser.
            return submission(intent.text, { inputKind: "slash_command", images: [] });
          };
          return typeof runWithInvocationSurface === "function"
            ? runWithInvocationSurface(intent.surface ?? "composer", operation)
            : operation();
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
        case "runBash": {
          return {
            // user_bash handlers may await arbitrary work. The
            // authority awaits this preparation outside its scheduler, then
            // calls startShell in a fresh serialized slot after revalidating
            // owner, editor, lifecycle, and foreground-work fences.
            shellPreparation: emitUserBashForSurface(
              intent.surface ?? "composer",
              intent.command,
              intent.excludeFromContext,
            ),
            startShell: (eventResult) => {
              const shellOperation = executeStreamingBash(
                envelope.intentId,
                intent.command,
                intent.excludeFromContext,
                eventResult,
              );
              return {
                deferredOutcome: trackInterruptibleOperation(
                  "bash",
                  () => _session.abortBash(),
                  () => shellOperation,
                ).then((result) => {
                  return {
                    started: true,
                    ...(typeof result?.output === "string" ? { output: result.output } : {}),
                    ...(Number.isInteger(result?.exitCode) ? { exitCode: result.exitCode } : {}),
                    ...(typeof result?.cancelled === "boolean"
                      ? { cancelled: result.cancelled }
                      : {}),
                    ...(typeof result?.truncated === "boolean"
                      ? { truncated: result.truncated }
                      : {}),
                  };
                }),
              };
            },
          };
        }
        case "setTrust": {
          const { buildProjectTrustOptions } = await import("./bootstrap.mjs");
          const liveCwd = _session.sessionManager?.getCwd?.() ?? cwd;
          const option = buildProjectTrustOptions(liveCwd).find(
            (candidate) => candidate.label === intent.optionLabel,
          );
          if (!option) throw new Error("Requested trust choice is unavailable");
          // A session-only answer is meaningful during resource resolution,
          // but cannot be replayed by a post-start /trust reload. Refuse it
          // explicitly instead of reporting success for a no-op.
          if (option.updates.length === 0) {
            throw new Error(
              "Session-only trust can't be changed after startup; choose a persistent option.",
            );
          }
          new pi.ProjectTrustStore(agentDir).setMany(option.updates);
          return { trusted: option.trusted, persisted: true };
        }
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
          const navigationOperation = authority.runNavigation(async () => {
            const result = await _session.navigateTree(intent.targetId, {
              summarize: intent.summarize,
            });
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
            const navigationEvidence = {
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
            // Capture the exact post-navigation branch before runNavigation
            // releases its barrier and schedules custody drain. The entry is
            // provisional until dispatch settlement publishes its terminal
            // outcome, but it already prevents later activity from advancing
            // the session past this presentation boundary.
            if (!cancelled) {
              authority.captureNavigationPresentation(envelope.intentId, owner, navigationEvidence);
            }
            return navigationEvidence;
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
          await _session.setModel(model, { persist: intent.persist === true });
          return { provider: model.provider ?? intent.provider, modelId: model.id };
        }
        case "setThinking":
          _session.setThinkingLevel(intent.level, { persist: intent.persist === true });
          return { level: intent.level };
        case "rename":
          _session.setSessionName(intent.name);
          return { name: intent.name };
        case "reload":
          await handleReload(true, {
            intentId: envelope.intentId,
            editorRevision: intent.editorRevision,
            editorText: intent.editorText,
            surface: intent.surface,
          });
          return {
            successorIdentity: { hostInstanceId, sessionEpoch: authority.sessionEpoch },
          };
        case "export": {
          const path = await exportSessionToHtml(intent.outputPath);
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
          const respond = (ok, errMsg, data) => {
            if (responded) return;
            responded = true;
            authority.publishSnapshot();
            send({
              type: "response",
              id,
              success: ok,
              ...(errMsg ? { error: errMsg } : {}),
              ...(data !== undefined ? { data } : {}),
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
                  preflightResult: (disposition) => {
                    if (!["handled", "queued", "started"].includes(disposition)) {
                      throw new Error("Pinned Pi returned an invalid prompt disposition");
                    }
                    respond(true, undefined, { disposition });
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
          const disposition = await runForSurface(() =>
            _session.steer(command.message, command.images, { source: "rpc" }),
          );
          send({ type: "response", id, success: true, data: { disposition } });
          break;
        }

        case "follow_up": {
          const disposition = await runForSurface(() =>
            _session.followUp(command.message, command.images, { source: "rpc" }),
          );
          send({ type: "response", id, success: true, data: { disposition } });
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
          if (!hasNativeProviderLogin(_session)) {
            send({ type: "response", id, success: true, data: { native: false, providers: [] } });
            break;
          }
          const access = modelAccess(_session);
          const candidates = access
            .getProviders()
            .slice(0, 100)
            .flatMap((provider) => {
              if (!provider || typeof provider.id !== "string") return [];
              const methods = [];
              if (typeof provider.auth?.oauth?.login === "function") methods.push("oauth");
              if (typeof provider.auth?.apiKey?.login === "function") methods.push("api_key");
              return methods.length ? [{ provider, methods }] : [];
            });
          const providers = await Promise.all(
            candidates.map(async ({ provider, methods }) => {
              let auth;
              try {
                auth = await access.checkAuth(provider.id);
              } catch {
                auth = undefined;
              }
              return {
                id: provider.id.slice(0, 160),
                name: String(provider.name ?? provider.id).slice(0, 160),
                configured: auth !== undefined,
                ...(typeof auth?.source === "string" ? { source: auth.source.slice(0, 120) } : {}),
                methods,
              };
            }),
          );
          providers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
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
          //   2. settingsManager.getEnabledModels() — a defensive fallback
          //      for a legacy/custom runtime that did not project SAVED scope
          //      into AgentSession at construction. The production host now
          //      resolves these patterns before construction so
          //      ctx.scopedModels is populated for session_start hooks too.
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
            const configuredScope = await resolveModelScope(settingsPatterns);
            const resolvedModels = configuredScope.scopedModels.map((entry) => entry.model);
            // Only filter when it actually narrows the list: an empty or
            // full match means "no scope" (mirrors resolveEnabledModelIds →
            // null), so fall through to the unfiltered registry list.
            if (resolvedModels.length > 0 && resolvedModels.length < models.length) {
              effective = resolvedModels;
            }
          }
          send({ type: "response", id, success: true, data: { models: effective } });
          break;
        }

        // ── Scoped models / login state ──────────────────────────────────
        // These mirror pi's TUI /scoped-models and /logout flows through
        // the SDK host's public session APIs.
        case "get_scoped_models": {
          // Pi 0.84 deliberately opens scoped-model selection from the cached
          // snapshot instead of blocking on remote catalogs. Login and the
          // explicit refresh intent synchronize this public runtime snapshot.
          const modelsApi = modelAccess(_session);
          const models = await modelsApi.getAvailable();
          const enabledIds = await resolveEnabledModelIds(_session, resolveModelScope);
          send({ type: "response", id, success: true, data: { models, enabledIds } });
          break;
        }

        case "set_scoped_models": {
          const models = await modelAccess(_session).getAvailable();
          const scoped = await buildScopedModels(models, command.enabledIds, resolveModelScope);
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
          const isAll = selectsEveryAvailableModel(models, command.enabledIds);
          const patterns = isAll ? undefined : [...command.enabledIds];
          _session.settingsManager.setEnabledModels(patterns);
          // Apply to the current session so it takes effect immediately.
          const scoped = await buildScopedModels(models, command.enabledIds, resolveModelScope);
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
          const result = await logoutProvider(command.provider);
          send({ type: "response", id, success: true, data: result });
          break;
        }

        // ── Bash ───────────────────────────────────────────────────────
        // executeBash(command, onChunk?, options?). The renderer reads
        // data.output / data.exitCode; returning the full BashResult (which
        // also carries cancelled/truncated) matches rpc-mode and is a superset.
        case "bash": {
          const eventResult = await emitUserBashForSurface(
            msg.uiSurface,
            command.command,
            command.excludeFromContext,
          );
          const result = await trackInterruptibleOperation(
            "bash",
            () => _session.abortBash(),
            () =>
              executeStreamingBash(id, command.command, command.excludeFromContext, eventResult),
          );
          send({ type: "response", id, success: true, data: result });
          break;
        }

        case "abort_bash": {
          cancelPendingUserBashPreparations();
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
          send({ type: "response", id, success: true, data: getSessionStats() });
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
          const outPath = await exportSessionToHtml(command.outputPath);
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

        case "render_message": {
          send({
            type: "response",
            id,
            success: true,
            data: renderMessage(
              command.customType,
              command.timestamp,
              command.cols,
              command.expanded,
            ),
          });
          break;
        }

        case "transform_markdown": {
          send({
            type: "response",
            id,
            success: true,
            data: transformMarkdown(command.items),
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
        // project resources, and pi's persistent post-start choice subset
        // (each option carries the `trusted` answer + updates to persist).
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
          // /trust runs after resource resolution. Session-only answers are
          // meaningful only during that initial callback and cannot survive
          // the reload required to apply a post-start change, so do not expose
          // choices that this surface must deterministically reject.
          const currentOptions = buildProjectTrustOptions(liveCwd).filter(
            (option) => option.updates.length > 0,
          );
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
          const sessionPath = canonicalizeSessionReference(command.sessionPath);
          const result = await runReplacement(() => runtime.switchSession(sessionPath), {
            kind: "switch",
            targetFile: sessionPath,
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
    requestAuthorityAttach: async (rendererGeneration) => {
      const reconstructionFence = fenceShellReconstruction();
      const retainedShell = await prepareRetainedShellSnapshot(reconstructionFence);
      return authority.requestAuthorityAttach(rendererGeneration, {
        ...authorityPresentation,
        shell: () => retainedShell,
      });
    },
    applyEditorPatch: (patch) => uiState.applyEditorPatch(patch),
    consumeEditorSource: (request) => uiState.consumeEditorSource(request),
    bindExtensions: bindInitialExtensions,
    interruptActiveOperation,
    sendShellInput,
    resizeShell,
    acknowledgeShellReconstruction,
    fenceShellReconstruction,
    signalShell,
    disposeShell,
    setShellTransportBackpressure,
    retainedShellSnapshot,
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

function previousCacheWarm(entry) {
  const usage = entry?.usage;
  const promptTokens =
    usageNumber(usage, "input") +
    usageNumber(usage, "cacheRead") +
    usageNumber(usage, "cacheWrite");
  if (promptTokens <= 0) return undefined;
  const rawTimestamp = entry?.timestamp;
  const parsedTimestamp =
    typeof rawTimestamp === "number"
      ? rawTimestamp
      : typeof rawTimestamp === "string"
        ? Date.parse(rawTimestamp)
        : 0;
  return {
    promptTokens,
    modelKey: `${entry?.provider ?? ""}/${entry?.model ?? ""}`,
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0,
    reportedCache: true,
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

function cacheWarmingNotice(entry, afterEntryId) {
  if (entry?.type !== "usage" || entry.kind !== "cache_warm") return undefined;
  if (
    typeof entry.id !== "string" ||
    typeof entry.provider !== "string" ||
    typeof entry.model !== "string" ||
    !entry.usage
  ) {
    return undefined;
  }
  return {
    type: "cache_warming_notice",
    noticeId: `cache-warm:${entry.id}`,
    usage: entry.usage,
    provider: entry.provider,
    model: entry.model,
    ...(typeof entry.note === "string" ? { note: entry.note } : {}),
    ...(afterEntryId ? { afterEntryId } : {}),
  };
}

function buildCacheWarmingNotice(session, event) {
  if (
    event?.type !== "entry_appended" ||
    session.settingsManager?.getShowCacheMissNotices?.() !== true
  ) {
    return undefined;
  }
  return cacheWarmingNotice(event.entry);
}

function assistantMessageIsError(message) {
  return (
    message?.stopReason === "error" ||
    (typeof message?.errorMessage === "string" && message.errorMessage.length > 0)
  );
}

function buildCacheMissNotice(session, event) {
  if (
    event?.type !== "message_end" ||
    event.message?.role !== "assistant" ||
    assistantMessageIsError(event.message) ||
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
    if (entry?.type === "usage" && entry.kind === "cache_warm") {
      previous = previousCacheWarm(entry) ?? previous;
      continue;
    }
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      previous = previousCacheRequest(entry.message, previous?.reportedCache ?? false) ?? previous;
    }
  }
  return detectCacheMissNotice(session, event.message, previous);
}

function assistantMessagePresentation(message, entryId) {
  const content = message?.content;
  const hasText =
    (typeof content === "string" && content.length > 0) ||
    (Array.isArray(content) &&
      content.some(
        (part) =>
          (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) ||
          (part?.type === "thinking" &&
            typeof part.thinking === "string" &&
            part.thinking.length > 0),
      ));
  const toolCallIds = Array.isArray(content)
    ? content
        .filter((part) => part?.type === "toolCall" && typeof part.id === "string")
        .map((part) => part.id)
    : [];
  const isError = assistantMessageIsError(message);

  // Match entriesToTranscript exactly. An error without assistant text emits
  // one error block at entryId and suppresses tool calls. With text, the error
  // row follows the assistant unless tool cards follow it in turn.
  if (isError && !hasText) return { anchor: entryId, toolCallIds: [] };
  if (isError && toolCallIds.length === 0) {
    return { anchor: `${entryId}-error`, toolCallIds };
  }
  return {
    anchor: hasText || toolCallIds.length > 0 ? entryId : undefined,
    toolCallIds,
  };
}

function entryPresentationAnchor(entry, projectedToolCallIds) {
  if (typeof entry?.id !== "string") return undefined;
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.id;
  if (entry.type === "custom_message") {
    if (!entry.display) return undefined;
    return Object.hasOwn(entry, "content") ||
      Object.hasOwn(entry, "details") ||
      typeof entry.customType === "string"
      ? entry.id
      : undefined;
  }
  if (entry.type === "custom") {
    return typeof entry.customType === "string" &&
      entry.customType !== "pivis.shell_turn_start" &&
      entry.customType !== "pivis.shell_turn_complete"
      ? entry.id
      : undefined;
  }
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  if (message?.role === "user" || message?.role === "bashExecution") return entry.id;
  if (message?.role === "assistant") {
    const presentation = assistantMessagePresentation(message, entry.id);
    for (const toolCallId of presentation.toolCallIds) projectedToolCallIds.add(toolCallId);
    return presentation.anchor;
  }
  if (message?.role === "toolResult") {
    return typeof message.toolCallId === "string" && projectedToolCallIds.has(message.toolCallId)
      ? undefined
      : entry.id;
  }
  if (message?.role === "custom" && message.display) {
    return Object.hasOwn(message, "content") ||
      Object.hasOwn(message, "details") ||
      typeof message.customType === "string"
      ? entry.id
      : undefined;
  }
  return undefined;
}

function buildHistoricalCacheMissNotices(session) {
  if (session.settingsManager?.getShowCacheMissNotices?.() !== true) return [];
  const notices = [];
  let previous;
  // Warming notices are synthetic transcript rows. Advance this anchor to
  // each notice as it is projected so multiple usage entries after one
  // assistant retain their persisted order instead of repeatedly inserting
  // at the same assistant boundary in reverse order.
  let lastPresentationAnchorId;
  const projectedToolCallIds = new Set();
  for (const entry of cacheEntries(session)) {
    if (entry?.type === "compaction" || entry?.type === "branch_summary") {
      previous = undefined;
      lastPresentationAnchorId =
        entryPresentationAnchor(entry, projectedToolCallIds) ?? lastPresentationAnchorId;
      continue;
    }
    if (entry?.type === "usage" && entry.kind === "cache_warm") {
      const warmingNotice = cacheWarmingNotice(entry, lastPresentationAnchorId);
      if (warmingNotice) {
        notices.push(warmingNotice);
        lastPresentationAnchorId = warmingNotice.noticeId;
      }
      previous = previousCacheWarm(entry) ?? previous;
      continue;
    }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant") {
      lastPresentationAnchorId =
        entryPresentationAnchor(entry, projectedToolCallIds) ?? lastPresentationAnchorId;
      continue;
    }
    const assistantAnchor = entryPresentationAnchor(entry, projectedToolCallIds);
    const notice = detectCacheMissNotice(session, message, previous);
    if (
      notice &&
      !assistantMessageIsError(message) &&
      message.stopReason !== "aborted" &&
      typeof entry.id === "string"
    ) {
      const noticeAnchor = assistantAnchor ?? lastPresentationAnchorId;
      const anchoredNotice = {
        ...notice,
        ...(noticeAnchor ? { afterEntryId: noticeAnchor } : {}),
      };
      notices.push(anchoredNotice);
      lastPresentationAnchorId = anchoredNotice.noticeId;
    } else {
      lastPresentationAnchorId = assistantAnchor ?? lastPresentationAnchorId;
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
 *      with Pi's public resolveModelScopeWithDiagnostics().
 *   3. append saved patterns with `no-match` diagnostics even when a
 *      session-only scope is active.
 *   4. else → null (all models checked = no scope).
 *
 * Returns `null` when nothing is scoped (the picker checks everything).
 */
async function resolveEnabledModelIds(session, resolveModelScope) {
  const scoped = session.scopedModels;
  let enabledIds = null;
  if (Array.isArray(scoped) && scoped.length > 0) {
    enabledIds = scoped
      .map((entry) => {
        const m = entry?.model;
        return m ? `${m.provider}/${m.id}` : null;
      })
      .filter((s) => typeof s === "string");
  }
  const settingsPatterns = session.settingsManager?.getEnabledModels?.();
  if (Array.isArray(settingsPatterns) && settingsPatterns.length > 0) {
    const configuredScope = await resolveModelScope(settingsPatterns, session);
    enabledIds ??= configuredScope.scopedModels.map(
      (entry) => `${entry.model.provider}/${entry.model.id}`,
    );
    // Pi 0.81.0 keeps configured patterns that no longer resolve visible in
    // the picker. Mirror its TUI by retaining only diagnostics that represent
    // a no-match pattern; invalid thinking-level warnings still resolve to a
    // concrete model and must not create a second "Unavailable" row.
    for (const diagnostic of configuredScope.diagnostics) {
      if (
        diagnostic.code === "no-match" &&
        typeof diagnostic.pattern === "string" &&
        !enabledIds.includes(diagnostic.pattern)
      ) {
        enabledIds.push(diagnostic.pattern);
      }
    }
  }
  return enabledIds;
}

/**
 * Build the scoped-models array for setScopedModels() with Pi's public
 * resolver, matching interactive-mode's live selector update.
 * - enabledIds null / empty / == all available → [] (no scope).
 * - an unavailable-only selection → [] (no usable live scope).
 * - otherwise → Pi's resolved [{ model, thinkingLevel? }] entries.
 */
async function buildScopedModels(models, enabledIds, resolveModelScope) {
  if (enabledIds === null || enabledIds.length === 0) {
    return [];
  }
  const enabled = enabledIds.map((id) => String(id));
  const wanted = new Set(enabled.map((id) => id.toLowerCase()));
  const availableIds = new Set(models.map((m) => `${m.provider}/${m.id}`.toLowerCase()));
  const hasEnabledAvailableModel = [...wanted].some((id) => availableIds.has(id));
  const allAvailableModelsEnabled = [...availableIds].every((id) => wanted.has(id));
  if (!hasEnabledAvailableModel || allAvailableModelsEnabled) {
    return [];
  }
  const { scopedModels } = await resolveModelScope(enabled);
  return scopedModels.map((entry) => ({
    model: entry.model,
    ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
  }));
}

function selectsEveryAvailableModel(models, enabledIds) {
  if (enabledIds === null || enabledIds.length === 0) return true;
  const availableIds = new Set(models.map((m) => `${m.provider}/${m.id}`.toLowerCase()));
  const selectedIds = new Set(enabledIds.map((id) => String(id).toLowerCase()));
  return (
    selectedIds.size === availableIds.size && [...availableIds].every((id) => selectedIds.has(id))
  );
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
function buildCommandContextActions({
  runtime,
  authority,
  reload,
  replace,
  waitForIdle,
  canonicalizeSessionReference,
  canonicalizeNewSessionOptions,
}) {
  return {
    waitForIdle,
    newSession: async (options) =>
      replace(() => runtime.newSession(canonicalizeNewSessionOptions(options)), { kind: "new" }),
    fork: async (entryId, options) =>
      replace(() => runtime.fork(entryId, options), { kind: "fork" }),
    navigateTree: async (targetId, options) =>
      authority.runNavigation(() => authority.currentSession.navigateTree(targetId, options)),

    switchSession: async (sessionPath, options) => {
      const canonicalSessionPath = canonicalizeSessionReference(sessionPath);
      return replace(() => runtime.switchSession(canonicalSessionPath, options), {
        kind: "switch",
        targetFile: canonicalSessionPath,
      });
    },
    // Use the same transition-aware path as the external reload message.
    // Reload can emit extension/UI events before and after its rebind point.
    reload: async () => reload(),
  };
}

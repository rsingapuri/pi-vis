/**
 * pi-session-host: Command/event bridge between Electron main and pi SDK.
 *
 * This module:
 * 1. Translates pi-vis commands → AgentSession / AgentSessionRuntime methods
 * 2. Forwards AgentSession events → main process via process.send()
 * 3. Handles session lifecycle (newSession, fork, switchSession) with rebind
 *
 * Response shapes mirror `pi --mode rpc` (modes/rpc/rpc-mode.js) exactly, so
 * the renderer cannot tell the SDK host apart from the RPC subprocess and the
 * `pi --mode rpc` fallback behaves identically. Every command the renderer
 * emits is handled here; method signatures are verified against the installed
 * pi's .d.ts (AgentSession getters/methods, ExtensionRunner.getRegisteredCommands,
 * SessionManager.getLeafId, ModelRegistry.getAvailable).
 */

/**
 * Fail fast if the installed pi is missing any SDK surface this bridge calls.
 *
 * The host is plain .mjs (not type-checked against pi's .d.ts), so a method
 * pi renames in a future release would otherwise surface as a cryptic crash
 * mid-session. Verifying the surface at startup turns that into a clean throw
 * during init → the registry falls back to `pi --mode rpc` with a clear reason.
 * Keep this list in sync with the methods/getters used below + in host.mjs.
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
  ]) {
    fn(session, m, `session.${m}`);
  }
  fn(session?.modelRegistry, "getAvailable", "session.modelRegistry.getAvailable");
  fn(
    session?.extensionRunner,
    "getRegisteredCommands",
    "session.extensionRunner.getRegisteredCommands",
  );
  fn(session?.resourceLoader, "getSkills", "session.resourceLoader.getSkills");
  fn(session?.sessionManager, "getLeafId", "session.sessionManager.getLeafId");

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
    "isCompacting",
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
 * @param {object} ctx.pi - the imported pi SDK (for /trust: ProjectTrustStore,
 *   hasTrustRequiringProjectResources)
 * @param {string} ctx.agentDir - pi.getAgentDir() (for the ProjectTrustStore)
 * @param {string} ctx.cwd - the session cwd (for /trust state + options)
 * @returns {{ handleCommand: Function, bindExtensions: Function }}
 */
export function setupCommandBridge({
  runtime,
  session,
  uiContext,
  send,
  panelBridge,
  pi,
  agentDir,
  cwd,
}) {
  let _session = session;
  let _unsubscribe = null;

  // ─── Event forwarding ──────────────────────────────────────────────────

  function subscribeSession(s) {
    _unsubscribe?.();
    _unsubscribe = s.subscribe((event) => {
      // Forward raw event to main process (structured clone over process.send).
      // AgentSessionEvent is a plain serializable object.
      send({ type: "event", event });
    });
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
      commandContextActions: buildCommandContextActions(runtime),
      // An extension requested app shutdown (e.g. a TUI-style /exit). In a GUI
      // the user — not an extension — owns session lifecycle, so this is a
      // deliberate no-op: we don't tear down the user's session (and its
      // transcript) on an extension's say-so. Present to satisfy bindExtensions.
      shutdownHandler: () => {},
      onError: (error) => {
        // ExtensionError = { extensionPath, event, error, stack? }
        send({
          type: "event",
          event: {
            type: "extension_error",
            extensionPath: error?.extensionPath,
            event: error?.event,
            error: error?.error,
          },
        });
      },
    });
  }

  // ─── Rebind ────────────────────────────────────────────────────────────

  runtime.setRebindSession(async (newSession) => {
    _session = newSession;
    await bindExtensions(newSession);
    subscribeSession(newSession);
  });

  runtime.setBeforeSessionInvalidate(() => {
    // P3-c: tear down any open custom() panels before the session is replaced:
    // closeAll() settles each panel's custom() promise and stops its TUI
    // render loop on the HOST side. Only emit panel_clear_all to the renderer
    // when a panel was actually open — every /new//fork//clone//switch used
    // to spam a no-op event the renderer handled as a no-op.
    const hadPanels = panelBridge.closeAll();
    if (hadPanels) send({ type: "panel_clear_all" });
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
      isCompacting: s.isCompacting,
      steeringMode: s.steeringMode,
      followUpMode: s.followUpMode,
      sessionFile: s.sessionFile,
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      autoCompactionEnabled: s.autoCompactionEnabled,
      messageCount: s.messages.length,
      pendingMessageCount: s.pendingMessageCount,
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

  // ─── Command handler ───────────────────────────────────────────────────

  async function handleCommand(msg) {
    const { id, command } = msg;

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
            send({
              type: "response",
              id,
              success: ok,
              ...(errMsg ? { error: errMsg } : {}),
            });
          };
          void _session
            .prompt(command.message, {
              ...(command.images?.length ? { images: command.images } : {}),
              ...(command.streamingBehavior
                ? { streamingBehavior: command.streamingBehavior }
                : {}),
              source: "rpc",
              preflightResult: (didSucceed) => {
                if (didSucceed) respond(true);
                else respond(false, "Prompt rejected");
              },
            })
            .catch((err) => respond(false, err instanceof Error ? err.message : String(err)));
          break;
        }

        // steer()/followUp() queue a message; they resolve promptly (no full
        // turn), so a plain await + success is correct.
        case "steer": {
          await _session.steer(command.message, command.images);
          send({ type: "response", id, success: true });
          break;
        }

        case "follow_up": {
          await _session.followUp(command.message, command.images);
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
        // the registry exactly as rpc-mode does.
        case "set_model": {
          const models = await _session.modelRegistry.getAvailable();
          const model = models.find(
            (m) => m.provider === command.provider && m.id === command.modelId,
          );
          if (!model) {
            send({
              type: "response",
              id,
              success: false,
              error: `Model not found: ${command.provider}/${command.modelId}`,
            });
            return;
          }
          await _session.setModel(model);
          send({ type: "response", id, success: true });
          break;
        }

        case "set_thinking_level": {
          _session.setThinkingLevel(command.level);
          send({ type: "response", id, success: true });
          break;
        }

        case "get_available_models": {
          // Mirror pi's effective available-models logic (AgentSession's
          // cycleModel filters to scoped models when scopedModels is
          // non-empty): when the session has a scope, the /model dropdown
          // must cycle only the scoped subset, NOT every enabled model. The
          // scoped entry's `.model` is a plain data Model object safe for
          // IPC, matching the existing shape returned by getAvailable().
          const scoped = _session.scopedModels;
          if (Array.isArray(scoped) && scoped.length > 0) {
            const scopedModels = scoped
              .map((entry) => entry?.model)
              .filter((m) => m && typeof m === "object");
            send({ type: "response", id, success: true, data: { models: scopedModels } });
          } else {
            const models = await _session.modelRegistry.getAvailable();
            send({ type: "response", id, success: true, data: { models } });
          }
          break;
        }

        // ── Scoped models / login state ──────────────────────────────────
        // These mirror pi's TUI /scoped-models and /logout flows but over
        // the SDK host. They are NOT supported by the `pi --mode rpc` fallback
        // (no RPC command exists), so a host_fallback session surfaces the
        // failure as an error toast at session.sendCommand time.
        case "get_scoped_models": {
          // Refresh so a freshly-added credential (e.g. /login) is reflected
          // immediately — mirrors pi's showModelsSelector, which calls
          // modelRegistry.refresh() before getAvailable().
          await _session.modelRegistry.refresh?.();
          const models = await _session.modelRegistry.getAvailable();
          const enabledIds = resolveEnabledModelIds(_session, models);
          send({ type: "response", id, success: true, data: { models, enabledIds } });
          break;
        }

        case "set_scoped_models": {
          const models = await _session.modelRegistry.getAvailable();
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
          const models = await _session.modelRegistry.getAvailable();
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
          _session.modelRegistry.authStorage.logout(command.provider);
          await _session.modelRegistry.refresh();
          send({ type: "response", id, success: true });
          break;
        }

        // ── Bash ───────────────────────────────────────────────────────
        // executeBash(command, onChunk?, options?). The renderer reads
        // data.output / data.exitCode; returning the full BashResult (which
        // also carries cancelled/truncated) matches rpc-mode and is a superset.
        case "bash": {
          const result = await _session.executeBash(command.command, undefined, {
            ...(command.excludeFromContext !== undefined
              ? { excludeFromContext: command.excludeFromContext }
              : {}),
          });
          send({ type: "response", id, success: true, data: result });
          break;
        }

        // ── Compaction ─────────────────────────────────────────────────
        // compact(customInstructions?: string) — a STRING, not an options
        // object. The old bridge passed { customInstructions } and pi silently
        // stringified it to "[object Object]".
        case "compact": {
          await _session.compact(command.customInstructions);
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
          const result = await runtime.newSession();
          send({
            type: "response",
            id,
            success: !result.cancelled,
            data: { cancelled: result.cancelled },
          });
          break;
        }

        case "fork": {
          const result = await runtime.fork(command.entryId);
          send({
            type: "response",
            id,
            success: !result.cancelled,
            data: { text: result.selectedText, cancelled: result.cancelled },
          });
          break;
        }

        case "switch_session": {
          const result = await runtime.switchSession(command.sessionPath);
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
          const result = await runtime.fork(leafId, { position: "at" });
          send({
            type: "response",
            id,
            success: !result.cancelled,
            data: { cancelled: result.cancelled },
          });
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
    }
  }

  return { handleCommand, bindExtensions };
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
 * (valid levels: off, minimal, low, medium, high, xhigh).
 *
 * This is best-effort for the *initial checkbox state*; the authoritative
 * scope is what the user submits (set_scoped_models).
 */
function resolveModelScopePatterns(patterns, models) {
  const VALID_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
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
  // Mirror pi's getLogoutProviderOptions (interactive-mode.js:3868):
  // iterate authStorage.list() — the authoritative set of stored
  // credentials — rather than scanning available models. A provider with
  // stored auth but no currently-listed model (e.g. expired key) is still
  // surfaced. Name comes from modelRegistry.getProviderDisplayName()
  // (pi's BUILT_IN_PROVIDER_DISPLAY_NAMES), not a hand-rolled title-case.
  const modelRegistry = session.modelRegistry;
  const authStorage = modelRegistry?.authStorage;
  if (!authStorage || typeof authStorage.list !== "function") return [];
  const out = [];
  for (const providerId of authStorage.list()) {
    let credential;
    try {
      credential = authStorage.get?.(providerId);
    } catch {
      continue;
    }
    if (!credential) continue;
    let name = providerId;
    try {
      name = modelRegistry.getProviderDisplayName?.(providerId) ?? providerId;
    } catch {
      /* fall back to the raw id */
    }
    out.push({ id: providerId, name, authType: credential.type });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Build ExtensionCommandContextActions for bindExtensions.
 * Mirrors the ExtensionCommandContextActions interface (waitForIdle/newSession/
 * fork/navigateTree/switchSession/reload). navigateTree maps to fork with
 * position "before" (the closest runtime equivalent).
 */
function buildCommandContextActions(runtime) {
  return {
    waitForIdle: async () => {
      // The runtime exposes no public idle-await; pi-vis drives commands
      // serially over the wire, so this is effectively a no-op here. Kept to
      // satisfy the interface so extensions that call it don't throw.
    },
    newSession: async (options) => runtime.newSession(options),
    fork: async (entryId, options) => runtime.fork(entryId, options),
    navigateTree: async (targetId, options) =>
      runtime.fork(targetId, { position: "before", ...options }),
    switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
    reload: async () => {
      // In-process reload, exactly as pi --mode rpc does (rpc-mode.js calls
      // session.reload()). It swaps the extension runner in place on the SAME
      // session object — so it does NOT trigger setRebindSession, our event
      // subscription stays valid, and our mode:"tui" uiContext binding is
      // preserved. This is what makes extension flows like `/mcp setup` →
      // ctx.actions.reload() actually pick up the new config. (The old code
      // fired a `reload_requested` message that nothing in main consumed, so
      // extension-initiated reload was a silent no-op.)
      await runtime.session.reload();
    },
  };
}

import type { SessionId } from "@shared/ids.js";
import type {
  RuntimeIdentity,
  SessionIntent,
  SessionQuery,
} from "@shared/pi-protocol/runtime-state.js";
import { dispatchSessionIntent, querySession } from "./session-intent.js";

/**
 * Transitional adapter for callers outside the Composer migration slice.
 * It deliberately exposes no Pi command union and never uses the retired
 * command bridge. New callers should use session-intent directly.
 */
export async function invokeSessionCommand(
  sessionId: SessionId,
  operation: { type: string; [key: string]: unknown },
  runtime: RuntimeIdentity,
  _options?: unknown,
): Promise<{ success: boolean; data?: unknown | undefined; error?: string | undefined }> {
  const queryTypes = new Set<SessionQuery["type"]>([
    "get_available_models",
    "get_scoped_models",
    "get_logout_providers",
    "get_commands",
    "get_state",
    "get_session_stats",
    "get_messages",
    "get_fork_messages",
    "get_last_assistant_text",
    "get_trust_state",
    "get_tree",
    "get_cache_miss_notices",
  ]);
  if (queryTypes.has(operation.type as SessionQuery["type"])) {
    const result = await querySession(sessionId, operation as SessionQuery, { owner: runtime });
    return result.response;
  }
  const intent = commandIntent(operation);
  const receipt = await dispatchSessionIntent(sessionId, intent, { owner: runtime });
  return receipt.status === "admitted" || receipt.status === "duplicate"
    ? { success: true }
    : {
        success: false,
        error: receipt.status === "not_admitted" ? receipt.reason : "delivery_unknown",
      };
}

function commandIntent(operation: { type: string; [key: string]: unknown }): SessionIntent {
  switch (operation.type) {
    case "set_model":
      return {
        kind: "setModel",
        provider: String(operation.provider ?? ""),
        modelId: String(operation.modelId ?? operation.model ?? ""),
      };
    case "set_session_name":
      return { kind: "rename", name: String(operation.name ?? "") };
    case "compact":
      return {
        kind: "compact",
        ...(typeof operation.customInstructions === "string"
          ? { instructions: operation.customInstructions }
          : {}),
      };
    default:
      return { kind: "invokeCommand", text: `/${operation.type}`, editorRevision: 0 };
  }
}

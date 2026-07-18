import { describe, expect, it } from "vitest";
import { PI_COMMAND_POLICY, type PiRpcCommand } from "./commands.js";

const COMMAND_TYPES = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "bash",
  "abort_bash",
  "set_model",
  "cycle_model",
  "get_available_models",
  "get_login_providers",
  "get_scoped_models",
  "set_scoped_models",
  "save_scoped_models",
  "get_logout_providers",
  "logout_provider",
  "set_thinking_level",
  "cycle_thinking_level",
  "new_session",
  "switch_session",
  "fork",
  "clone",
  "set_session_name",
  "get_commands",
  "get_state",
  "get_session_stats",
  "get_messages",
  "get_fork_messages",
  "get_last_assistant_text",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "set_steering_mode",
  "set_follow_up_mode",
  "export_html",
  "get_trust_state",
  "set_trust",
  "get_tree",
  "navigate_tree",
  "set_label",
  "render_entry",
  "get_cache_miss_notices",
] as const satisfies readonly PiRpcCommand["type"][];

describe("Pi command admission policy", () => {
  it("classifies every schema discriminant exactly once", () => {
    expect(Object.keys(PI_COMMAND_POLICY).sort()).toEqual([...COMMAND_TYPES].sort());
    for (const type of COMMAND_TYPES) {
      expect(["read_only", "idempotent", "effectful", "replacement"]).toContain(
        PI_COMMAND_POLICY[type].class,
      );
    }
  });

  it("keeps text commands submission-only", () => {
    for (const type of ["prompt", "steer", "follow_up"] as const) {
      expect(PI_COMMAND_POLICY[type]).toMatchObject({
        class: "effectful",
        submissionOnly: true,
      });
    }
  });
});

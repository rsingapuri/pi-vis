import { describe, expect, it, vi } from "vitest";
import {
  buildProjectTrustOptions,
  createTrustResolver,
  promptProjectTrustChoice,
} from "./bootstrap.mjs";

// The trust resolver is the security linchpin of the SDK-host architecture:
// without it, DefaultResourceLoader leaves projectTrusted at its `true` default
// and auto-loads project-local .pi/ extensions UNGATED. These tests pin the
// deny-by-default decision flow (mirrors pi's core/project-trust.js) using a
// fully-faked pi SDK so no real pi install is needed.

/**
 * Build a fake `pi` whose ProjectTrustStore is backed by an in-memory map and
 * whose hasTrustRequiringProjectResources is controllable.
 */
function makeFakePi({ requiresTrust = true, stored = null } = {}) {
  const setMany = vi.fn();
  const get = vi.fn(() => stored);
  class ProjectTrustStore {
    constructor(agentDir) {
      this.agentDir = agentDir;
    }
    get(cwd) {
      return get(cwd);
    }
    setMany(updates) {
      return setMany(updates);
    }
  }
  return {
    pi: {
      ProjectTrustStore,
      hasTrustRequiringProjectResources: vi.fn(() => requiresTrust),
    },
    get,
    setMany,
  };
}

describe("createTrustResolver — deny-by-default flow", () => {
  const CWD = "/Users/me/project";
  const AGENT_DIR = "/Users/me/.pi/agent";

  it("allows without prompting when there are no trust-requiring resources", async () => {
    const { pi, setMany } = makeFakePi({ requiresTrust: false });
    const prompt = vi.fn();
    const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);

    await expect(resolveTrust({})).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(setMany).not.toHaveBeenCalled();
  });

  it("honors a stored ALLOW decision without prompting", async () => {
    const { pi, setMany } = makeFakePi({ stored: true });
    const prompt = vi.fn();
    const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);

    await expect(resolveTrust({})).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(setMany).not.toHaveBeenCalled();
  });

  it("honors a stored DENY decision without prompting", async () => {
    const { pi, setMany } = makeFakePi({ stored: false });
    const prompt = vi.fn();
    const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);

    await expect(resolveTrust({})).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(setMany).not.toHaveBeenCalled();
  });

  it("prompts when undecided; 'Trust this folder' persists ALLOW and returns true", async () => {
    const { pi, setMany } = makeFakePi({ stored: null });
    const prompt = vi.fn(async () => "Trust this folder");
    const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);

    await expect(resolveTrust({})).resolves.toBe(true);
    expect(setMany).toHaveBeenCalledWith([{ path: CWD, decision: true }]);
  });

  it("binds cross-cwd switch/resume/import prompts and decisions to each effective runtime cwd", async () => {
    const initialCwd = "/workspace/initial";
    for (const [operation, effectiveCwd] of [
      ["switch", "/workspace/switched"],
      ["resume", "/workspace/resumed"],
      ["import", "/workspace/imported"],
    ]) {
      const { pi, setMany } = makeFakePi({ stored: null });
      const createDialog = vi.fn(async () => ({ value: "Trust this folder" }));
      const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, effectiveCwd, (labels) =>
        promptProjectTrustChoice(createDialog, effectiveCwd, labels),
      );

      await expect(resolveTrust({ reason: operation })).resolves.toBe(true);
      expect(createDialog).toHaveBeenCalledWith(
        "select",
        expect.stringContaining(`Trust ${effectiveCwd}?`),
        { options: expect.arrayContaining(["Trust this folder", "Do not trust"]) },
      );
      expect(createDialog.mock.calls[0][1]).not.toContain(initialCwd);
      expect(setMany).toHaveBeenCalledWith([{ path: effectiveCwd, decision: true }]);
    }
  });

  it("'Do not trust' persists DENY and returns false", async () => {
    const { pi, setMany } = makeFakePi({ stored: null });
    const prompt = vi.fn(async () => "Do not trust");
    const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);

    await expect(resolveTrust({})).resolves.toBe(false);
    expect(setMany).toHaveBeenCalledWith([{ path: CWD, decision: false }]);
  });

  it("session-only choices return the decision WITHOUT persisting", async () => {
    {
      const { pi, setMany } = makeFakePi({ stored: null });
      const prompt = vi.fn(async () => "Trust for this session only");
      const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);
      await expect(resolveTrust({})).resolves.toBe(true);
      expect(setMany).not.toHaveBeenCalled();
    }
    {
      const { pi, setMany } = makeFakePi({ stored: null });
      const prompt = vi.fn(async () => "Do not trust (this session only)");
      const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);
      await expect(resolveTrust({})).resolves.toBe(false);
      expect(setMany).not.toHaveBeenCalled();
    }
  });

  it("DENIES (ephemerally) when the prompt is cancelled (null)", async () => {
    const { pi, setMany } = makeFakePi({ stored: null });
    const prompt = vi.fn(async () => null);
    const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);

    await expect(resolveTrust({})).resolves.toBe(false);
    expect(setMany).not.toHaveBeenCalled(); // not persisted → re-prompt next time
  });

  it("DENIES (ephemerally) when the prompt throws", async () => {
    const { pi, setMany } = makeFakePi({ stored: null });
    const prompt = vi.fn(async () => {
      throw new Error("IPC lost");
    });
    const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);

    await expect(resolveTrust({})).resolves.toBe(false);
    expect(setMany).not.toHaveBeenCalled();
  });

  it("DENIES when the prompt returns an unknown label (no matching option)", async () => {
    const { pi, setMany } = makeFakePi({ stored: null });
    const prompt = vi.fn(async () => "Some bogus label");
    const { resolveTrust } = createTrustResolver(pi, AGENT_DIR, CWD, prompt);

    await expect(resolveTrust({})).resolves.toBe(false);
    expect(setMany).not.toHaveBeenCalled();
  });
});

describe("buildProjectTrustOptions", () => {
  it("includes a parent-folder option that grants the parent and clears cwd", () => {
    const cwd = "/Users/me/project";
    const opts = buildProjectTrustOptions(cwd);
    const parent = opts.find((o) => o.label.startsWith("Trust parent folder"));
    expect(parent).toBeDefined();
    expect(parent.trusted).toBe(true);
    expect(parent.updates).toEqual([
      { path: "/Users/me", decision: true },
      { path: cwd, decision: null },
    ]);
  });

  it("omits the parent option at the filesystem root (parent === cwd)", () => {
    const opts = buildProjectTrustOptions("/");
    expect(opts.some((o) => o.label.startsWith("Trust parent folder"))).toBe(false);
  });

  it("always offers both persistent and session-only forms of allow and deny", () => {
    const labels = buildProjectTrustOptions("/Users/me/project").map((o) => o.label);
    expect(labels).toContain("Trust this folder");
    expect(labels).toContain("Trust for this session only");
    expect(labels).toContain("Do not trust");
    expect(labels).toContain("Do not trust (this session only)");
  });
});

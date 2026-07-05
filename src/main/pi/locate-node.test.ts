import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// locate-node resolves the user's system `node` (the same Node pi runs under)
// and decides whether to retarget the SDK-host subprocess onto it. The parity
// gap: the host is forked from Electron's main process and so defaults to
// Electron's bundled Node (Electron 31 → 20.14), which lacks `node:sqlite`
// (Node ≥ 22.5) — breaking @cursor/sdk's default SqliteLocalAgentStore in
// Pi-Vis while it works in terminal pi (which runs under the user's Node).
//
// These tests mirror locate-pi.test.ts for the resolution/cache behavior and
// pin the decision logic (chooseHostExecPath) that gates the retarget.

const h = vi.hoisted(() => ({
  execFileImpl: vi.fn(),
  getSubprocessEnv: vi.fn(async () => ({ PATH: "/login/bin", FROM_LOGIN: "yes" })),
}));

vi.mock("node:child_process", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: thin callback-style passthrough for promisify.
  execFile: (...args: any[]) => h.execFileImpl(...args),
}));
vi.mock("../auth.js", () => ({ getSubprocessEnv: h.getSubprocessEnv }));

import {
  chooseHostExecPath,
  clearNodeLocationCache,
  compareNodeVersions,
  resolveSystemNode,
} from "./locate-node.js";

type ExecCb = (err: Error | null, result?: { stdout: string }) => void;

let shellResolution: { shell: string | null; which: string | null };
let validation: Record<string, string | null>;

function installExecFileMock() {
  h.execFileImpl.mockImplementation((file: string, args: unknown, _opts: unknown, cb: ExecCb) => {
    const argv = Array.isArray(args) ? args : [];
    if (argv[0] === "-ilc" && argv[1] === "command -v node") {
      return cb(null, { stdout: shellResolution.shell ? `${shellResolution.shell}\n` : "" });
    }
    if (file === "which" && argv[0] === "node") {
      return cb(null, { stdout: shellResolution.which ? `${shellResolution.which}\n` : "" });
    }
    const v = validation[file];
    if (v) return cb(null, { stdout: `${v}\n` });
    return cb(new Error("env: node: No such file or directory"));
  });
}

/** Make safe execFile resolution answer the login-shell / which probes. */
function setShellResolution(next: { shell: string | null; which: string | null }) {
  shellResolution = next;
  installExecFileMock();
}

/** Make `execFile` validate specific candidates: map path → version|null(fail). */
function setValidation(map: Record<string, string | null>) {
  validation = map;
  installExecFileMock();
}

beforeEach(() => {
  clearNodeLocationCache();
  h.execFileImpl.mockReset();
  h.getSubprocessEnv.mockClear();
  shellResolution = { shell: null, which: null };
  validation = {};
  installExecFileMock();
});

afterEach(() => {
  clearNodeLocationCache();
});

describe("resolveSystemNode", () => {
  it("resolves node via the login shell and validates --version under the login-shell env", async () => {
    setShellResolution({ shell: "/usr/local/bin/node", which: null });
    setValidation({ "/usr/local/bin/node": "v22.19.0" });

    const result = await resolveSystemNode();
    expect(result).toEqual({ path: "/usr/local/bin/node", version: "v22.19.0" });

    // Regression guard (mirrors locate-pi): execFile must run with
    // getSubprocessEnv()'s env, not the bare process env — a GUI-launched app
    // has a stripped PATH.
    expect(h.getSubprocessEnv).toHaveBeenCalled();
    const validateCall = h.execFileImpl.mock.calls.find((c) => c[0] === "/usr/local/bin/node");
    if (!validateCall) throw new Error("expected execFile validation to have been called");
    const opts = validateCall[2] as { env?: Record<string, string> };
    expect(opts.env).toMatchObject({ FROM_LOGIN: "yes" });
  });

  it("falls through to the next candidate when one fails --version", async () => {
    setShellResolution({ shell: "/a/node", which: "/b/node" });
    setValidation({ "/a/node": null, "/b/node": "v22.5.0" });

    const result = await resolveSystemNode();
    expect(result).toEqual({ path: "/b/node", version: "v22.5.0" });
    expect(
      h.execFileImpl.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === "--version"),
    ).toHaveLength(2);
  });

  it("returns null when no candidate can be resolved", async () => {
    setShellResolution({ shell: null, which: null });
    const result = await resolveSystemNode();
    expect(result).toBeNull();
    expect(h.getSubprocessEnv).not.toHaveBeenCalled();
  });

  it("caches a successful result and does not re-run resolution", async () => {
    setShellResolution({ shell: "/a/node", which: null });
    setValidation({ "/a/node": "v22.19.0" });

    const first = await resolveSystemNode();
    expect(first).toEqual({ path: "/a/node", version: "v22.19.0" });
    const execCallsAfterFirst = h.execFileImpl.mock.calls.length;

    const second = await resolveSystemNode();
    expect(second).toEqual(first);
    expect(h.execFileImpl.mock.calls.length).toBe(execCallsAfterFirst);

    clearNodeLocationCache();
    await resolveSystemNode();
    expect(h.execFileImpl.mock.calls.length).toBeGreaterThan(execCallsAfterFirst);
  });
});

describe("compareNodeVersions", () => {
  it("orders plain numeric versions and tolerates a leading v", () => {
    expect(compareNodeVersions("v22.5.0", "20.14.0")).toBe(1);
    expect(compareNodeVersions("20.14.0", "22.5.0")).toBe(-1);
    expect(compareNodeVersions("v22.5.0", "22.5.0")).toBe(0);
  });

  it("compares component-wise (not lexicographically)", () => {
    // "9.0.0" must be LOWER than "10.0.0" — lexicographic compare would get this wrong.
    expect(compareNodeVersions("9.0.0", "10.0.0")).toBe(-1);
    expect(compareNodeVersions("22.5.0", "22.10.0")).toBe(-1);
  });
});

describe("chooseHostExecPath (the retarget decision)", () => {
  const ELECTRON_31_NODE = "20.14.0"; // Electron 31's bundled Node

  it("retargets to system node when it is strictly NEWER than Electron's", () => {
    // The cursor-sdk / node:sqlite case: user has 22.19, Electron ships 20.14.
    const decision = chooseHostExecPath({ path: "/n/node", version: "v22.19.0" }, ELECTRON_31_NODE);
    expect(decision).toEqual({ execPath: "/n/node", reason: "system-node" });
  });

  it("keeps Electron's node when system node is MISSING (the fallback)", () => {
    // Today's behavior: no node on PATH → host runs under Electron's bundled
    // Node. Extensions needing newer built-ins still break here, but nothing
    // regresses — this is exactly the pre-fix state.
    const decision = chooseHostExecPath(null, ELECTRON_31_NODE);
    expect(decision).toEqual({ execPath: undefined, reason: "electron-node-no-system" });
  });

  it("keeps Electron's node when system node is NOT newer (equal or older)", () => {
    // Equal → no benefit, avoid user-node oddities (nvm shims etc.).
    expect(chooseHostExecPath({ path: "/n/node", version: "v20.14.0" }, ELECTRON_31_NODE)).toEqual({
      execPath: undefined,
      reason: "electron-node-not-newer",
    });
    // Older → would be a downgrade.
    expect(chooseHostExecPath({ path: "/n/node", version: "v18.20.0" }, ELECTRON_31_NODE)).toEqual({
      execPath: undefined,
      reason: "electron-node-not-newer",
    });
  });

  it("stops retargeting once Electron's bundled node catches up (adapts to a future bump)", () => {
    // If Pi-Vis ships an Electron whose bundled Node already covers node:sqlite
    // (Node ≥ 22.5), and the user's node is equal/older, the retarget correctly
    // goes dormant — no floor constant to maintain.
    const futureElectron = "22.18.0";
    expect(chooseHostExecPath({ path: "/n/node", version: "v22.5.0" }, futureElectron)).toEqual({
      execPath: undefined,
      reason: "electron-node-not-newer",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// locate-pi resolves the user's pi binary and validates it. The historically
// shipped crash (memory): GUI launches have a stripped PATH, and pi is a
// `#!/usr/bin/env node` script, so validating with `--version` under the bare
// app env fails `env: node` (exit 127) → pi wrongly reported missing. The fix
// validates under the login-shell env (getSubprocessEnv). These tests pin that
// and the candidate/cache behavior, with child_process + auth fully mocked.

const h = vi.hoisted(() => ({
  // (file, args, opts, cb) — `execFile`, used for safe resolution and validation.
  execFileImpl: vi.fn(),
  getSubprocessEnv: vi.fn(async () => ({ PATH: "/login/bin", FROM_LOGIN: "yes" })),
}));

vi.mock("node:child_process", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: thin callback-style passthrough for promisify.
  execFile: (...args: any[]) => h.execFileImpl(...args),
}));
vi.mock("../auth.js", () => ({ getSubprocessEnv: h.getSubprocessEnv }));

import { clearPiLocationCache, locatePi } from "./locate-pi.js";

type ExecCb = (err: Error | null, result?: { stdout: string }) => void;

let shellResolution: { shell: string | null; which: string | null };
let validation: Record<string, string | null>;

function installExecFileMock() {
  h.execFileImpl.mockImplementation((file: string, args: unknown, _opts: unknown, cb: ExecCb) => {
    const argv = Array.isArray(args) ? args : [];
    if (argv[0] === "-ilc" && argv[1] === "command -v pi") {
      return cb(null, { stdout: shellResolution.shell ? `${shellResolution.shell}\n` : "" });
    }
    if (file === "which" && argv[0] === "pi") {
      return cb(null, { stdout: shellResolution.which ? `${shellResolution.which}\n` : "" });
    }
    const v = validation[file];
    if (v) return cb(null, { stdout: `${v}\n` });
    return cb(new Error("env: node: No such file or directory")); // the real failure
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
  clearPiLocationCache();
  h.execFileImpl.mockReset();
  h.getSubprocessEnv.mockClear();
  shellResolution = { shell: null, which: null };
  validation = {};
  installExecFileMock();
});

afterEach(() => {
  clearPiLocationCache();
});

describe("locatePi", () => {
  it("validates the override path under the LOGIN-SHELL env (the stripped-PATH fix)", async () => {
    setShellResolution({ shell: null, which: null });
    setValidation({ "/custom/pi": "0.81.0" });

    const result = await locatePi("/custom/pi");
    expect(result).toEqual({ path: "/custom/pi", version: "0.81.0" });

    // The regression guard: execFile must run with getSubprocessEnv()'s env,
    // not the bare process env — otherwise `env: node` fails on GUI launch.
    expect(h.getSubprocessEnv).toHaveBeenCalled();
    const validateCall = h.execFileImpl.mock.calls.find((c) => c[0] === "/custom/pi");
    if (!validateCall) throw new Error("expected execFile validation to have been called");
    const opts = validateCall[2] as { env?: Record<string, string> };
    expect(opts.env).toMatchObject({ FROM_LOGIN: "yes" });
  });

  it("falls through to the next candidate when one fails --version", async () => {
    setShellResolution({ shell: "/a/pi", which: "/b/pi" });
    setValidation({ "/a/pi": null, "/b/pi": "0.80.0" }); // /a fails, /b works

    const result = await locatePi();
    expect(result).toEqual({ path: "/b/pi", version: "0.80.0" });
    expect(
      h.execFileImpl.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === "--version"),
    ).toHaveLength(2);
  });

  it("returns null when no candidate can be resolved", async () => {
    setShellResolution({ shell: null, which: null });
    const result = await locatePi();
    expect(result).toBeNull();
    expect(h.getSubprocessEnv).not.toHaveBeenCalled(); // nothing to validate
  });

  it("returns null when every candidate fails validation", async () => {
    setShellResolution({ shell: "/a/pi", which: "/b/pi" });
    setValidation({ "/a/pi": null, "/b/pi": null });
    const result = await locatePi();
    expect(result).toBeNull();
  });

  it("caches a successful result and does not re-run resolution", async () => {
    setShellResolution({ shell: "/a/pi", which: null });
    setValidation({ "/a/pi": "0.82.0" });

    const first = await locatePi();
    expect(first).toEqual({ path: "/a/pi", version: "0.82.0" });
    const execCallsAfterFirst = h.execFileImpl.mock.calls.length;

    const second = await locatePi();
    expect(second).toEqual(first);
    // No additional resolution/validation happened — served from cache.
    expect(h.execFileImpl.mock.calls.length).toBe(execCallsAfterFirst);

    // clearPiLocationCache forces a fresh resolution.
    clearPiLocationCache();
    await locatePi();
    expect(h.execFileImpl.mock.calls.length).toBeGreaterThan(execCallsAfterFirst);
  });

  it("bypasses the cache when an override path is supplied", async () => {
    setShellResolution({ shell: "/a/pi", which: null });
    setValidation({ "/a/pi": "0.82.0", "/other/pi": "0.83.0" });

    await locatePi(); // populates cache with /a/pi
    const result = await locatePi("/other/pi"); // override → ignore cache
    expect(result).toEqual({ path: "/other/pi", version: "0.83.0" });
  });

  it("does not reuse an override result after the override is cleared", async () => {
    setShellResolution({ shell: "/auto/pi", which: null });
    setValidation({ "/custom/pi": "0.83.0", "/auto/pi": "0.82.0" });

    const custom = await locatePi("/custom/pi");
    expect(custom).toEqual({ path: "/custom/pi", version: "0.83.0" });

    const auto = await locatePi(null);
    expect(auto).toEqual({ path: "/auto/pi", version: "0.82.0" });
  });

  it("does not cache an auto-discovered fallback under a failing override key", async () => {
    setShellResolution({ shell: "/auto/pi", which: null });
    setValidation({ "/custom/pi": null, "/auto/pi": "0.82.0" });

    const fallback = await locatePi("/custom/pi");
    expect(fallback).toEqual({ path: "/auto/pi", version: "0.82.0" });

    setValidation({ "/custom/pi": "0.83.0", "/auto/pi": "0.82.0" });
    const custom = await locatePi("/custom/pi");
    expect(custom).toEqual({ path: "/custom/pi", version: "0.83.0" });
  });
});

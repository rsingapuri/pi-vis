import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({
  getSubprocessEnv: async () => ({ PATH: "/login-shell/bin", HOME: "/tmp/pivis-home" }),
}));

vi.mock("./settings-store.js", () => ({
  getSettings: () => ({
    piBinaryPath: null,
    piEnv: { PI_CODING_AGENT_DIR: "/custom/pi-agent", PIVIS_PRIVATE_TEST: "blocked" },
  }),
}));

vi.mock("./pi/pinned-pi.js", () => ({
  getPinnedPi: () => ({ path: "/tmp/pi", version: "test" }),
}));

import { checkUserExtensionUpdates } from "./extension-update-check.js";
import type {
  ExtensionUpdateWorkerRequest,
  ExtensionUpdateWorkerResponse,
} from "./extension-update-worker.js";
import {
  buildExtensionUpdateArgs,
  checkForExtensionUpdates,
  getExtensionUpdateStatus,
  initExtensionUpdates,
  resolveExtensionUpdateWorkerPath,
  runExtensionUpdate,
} from "./extension-updates.js";

class FakeWorker extends EventEmitter {
  request: ExtensionUpdateWorkerRequest | null = null;
  terminate = vi.fn(async () => 0);

  constructor(private readonly response: ExtensionUpdateWorkerResponse) {
    super();
  }

  postMessage(request: ExtensionUpdateWorkerRequest): void {
    this.request = request;
    queueMicrotask(() => this.emit("message", this.response));
  }
}

class FakeUpdateChild extends EventEmitter {
  kill = vi.fn(() => true);
  readonly pid: number | undefined;

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

describe("extension updates", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    initExtensionUpdates(() => {});
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks user packages in a worker with the login-shell environment", async () => {
    const worker = new FakeWorker({
      ok: true,
      updates: [
        {
          source: "npm:@pi/mcp",
          displayName: "@pi/mcp",
          type: "npm",
          scope: "user",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          updateAvailable: true,
        },
      ],
    });
    let workerEnv: Record<string, string> | undefined;

    const status = await checkForExtensionUpdates((env) => {
      workerEnv = env;
      return worker;
    });

    expect(workerEnv).toMatchObject({ PATH: "/login-shell/bin", HOME: "/tmp/pivis-home" });
    expect(workerEnv).toMatchObject({ PI_CODING_AGENT_DIR: "/custom/pi-agent" });
    expect(workerEnv).not.toHaveProperty("PIVIS_PRIVATE_TEST");
    expect(worker.request?.cwd).toBeTruthy();
    expect(status.updates).toEqual([
      {
        source: "npm:@pi/mcp",
        displayName: "@pi/mcp",
        type: "npm",
        scope: "user",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateAvailable: true,
      },
    ]);
    expect(status.checkedAt).toBeTypeOf("number");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("shares a launch/Settings check and publishes one cached result", async () => {
    const worker = new FakeWorker({
      ok: true,
      updates: [
        {
          source: "npm:@pi/mcp",
          displayName: "@pi/mcp",
          type: "npm",
          scope: "user",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          updateAvailable: true,
        },
      ],
    });
    const firstFactory = vi.fn(() => worker);
    const competingFactory = vi.fn(() => new FakeWorker({ ok: true, updates: [] }));
    const listener = vi.fn();
    initExtensionUpdates(listener);

    const launchCheck = checkForExtensionUpdates(firstFactory);
    const settingsCheck = checkForExtensionUpdates(competingFactory);

    expect(settingsCheck).toBe(launchCheck);
    await expect(launchCheck).resolves.toMatchObject({
      updates: [{ source: "npm:@pi/mcp" }],
    });
    expect(firstFactory).toHaveBeenCalledOnce();
    expect(competingFactory).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(getExtensionUpdateStatus()).toEqual(listener.mock.calls[0]?.[0]);
  });

  it("clears a failed check claim so a manual retry can succeed", async () => {
    await expect(
      checkForExtensionUpdates(
        () => new FakeWorker({ ok: false, error: "temporary registry failure" }),
      ),
    ).rejects.toThrow("temporary registry failure");

    await expect(
      checkForExtensionUpdates(() => new FakeWorker({ ok: true, updates: [] })),
    ).resolves.toMatchObject({ updates: [] });
  });

  it("keeps every runner target extension-only", () => {
    const allArgs = buildExtensionUpdateArgs("all");
    const oneArgs = buildExtensionUpdateArgs({ extension: "npm:@pi/mcp" });

    expect(allArgs).toEqual(["update", "--extensions", "--no-approve"]);
    expect(oneArgs).toEqual(["update", "--extension", "npm:@pi/mcp", "--no-approve"]);
    expect([...allArgs, ...oneArgs]).not.toContain("--self");
    expect([...allArgs, ...oneArgs]).not.toContain("--all");
  });

  it("rejects option-shaped extension sources", () => {
    expect(() => buildExtensionUpdateArgs({ extension: "--self" })).toThrow(
      "Invalid extension update target",
    );
    expect(() => buildExtensionUpdateArgs({ extension: " --self" })).toThrow(
      "Invalid extension update target",
    );
  });

  it("runs the pinned CLI with the same filtered pi environment", async () => {
    const child = new FakeUpdateChild();
    let invocation:
      | { file: string; args: string[]; options: { env: Record<string, string> } }
      | undefined;
    const resultPromise = runExtensionUpdate(
      { extension: " npm:@pi/mcp " },
      (file, args, options) => {
        invocation = { file, args, options };
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
    );

    await expect(resultPromise).resolves.toEqual({ exitCode: 0, timedOut: false });
    expect(invocation).toMatchObject({
      file: "/tmp/pi",
      args: ["update", "--extension", "npm:@pi/mcp", "--no-approve"],
      options: {
        env: {
          PATH: "/login-shell/bin",
          HOME: "/tmp/pivis-home",
          PI_CODING_AGENT_DIR: "/custom/pi-agent",
          FORCE_COLOR: "0",
        },
      },
    });
    expect(invocation?.options.env).not.toHaveProperty("PIVIS_PRIVATE_TEST");
  });

  it("force-kills a timed-out update and waits for the direct child to close", async () => {
    vi.useFakeTimers();
    const child = new FakeUpdateChild();

    const result = runExtensionUpdate("all", () => child);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 5_000);

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    child.emit("close", null);
    await expect(result).resolves.toEqual({ exitCode: 1, timedOut: true });
  });

  it.runIf(process.platform !== "win32")(
    "keeps escalation armed when the CLI closes before an npm/git descendant",
    async () => {
      vi.useFakeTimers();
      const child = new FakeUpdateChild(424_242);
      const processKill = vi.spyOn(process, "kill").mockReturnValue(true);

      const result = runExtensionUpdate("all", () => child);
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      child.emit("close", null);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(processKill).toHaveBeenCalledWith(-424_242, "SIGTERM");
      expect(processKill).toHaveBeenCalledWith(-424_242, 0);

      await vi.advanceTimersByTimeAsync(5_000 + 1_000);

      expect(processKill).toHaveBeenCalledWith(-424_242, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
      await expect(result).resolves.toEqual({ exitCode: 1, timedOut: true });
    },
  );

  it("keeps forced tree cleanup armed after a timed-out Windows CLI closes", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = new FakeUpdateChild();

    const result = runExtensionUpdate("all", () => child);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    child.emit("close", null);

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000 + 1_000);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await expect(result).resolves.toEqual({ exitCode: 1, timedOut: true });
  });

  it("queues overlapping update targets behind one main-owned mutation", async () => {
    const firstChild = new FakeUpdateChild();
    const secondChild = new FakeUpdateChild();
    const firstSpawn = vi.fn(() => firstChild);
    const secondSpawn = vi.fn(() => secondChild);

    const first = runExtensionUpdate("all", firstSpawn);
    const second = runExtensionUpdate({ extension: "npm:other" }, secondSpawn);

    await vi.waitFor(() => expect(firstSpawn).toHaveBeenCalledOnce());
    expect(secondSpawn).not.toHaveBeenCalled();
    firstChild.emit("close", 0);
    await expect(first).resolves.toEqual({ exitCode: 0, timedOut: false });
    await vi.waitFor(() => expect(secondSpawn).toHaveBeenCalledOnce());
    secondChild.emit("close", 0);
    await expect(second).resolves.toEqual({ exitCode: 0, timedOut: false });
  });

  it("resolves the packaged worker from the asar-unpacked mirror", () => {
    expect(
      resolveExtensionUpdateWorkerPath(
        "file:///Applications/Pi-Vis.app/Contents/Resources/app.asar/out/main/chunks/ipc.js",
      ),
    ).toBe(
      "/Applications/Pi-Vis.app/Contents/Resources/app.asar.unpacked/out/main/extension-update-worker.js",
    );
  });

  it("uses pi's public package manager for user packages and ignores project settings", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-extension-check-"));
    tempDirs.push(root);
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "workspace");
    const installedDir = path.join(agentDir, "npm", "node_modules", "test-extension");
    const currentInstalledDir = path.join(agentDir, "npm", "node_modules", "current-extension");
    const npmLog = path.join(root, "npm.log");
    const projectNpmMarker = path.join(root, "project-npm-ran");
    const fakeNpm = path.join(root, "fake-npm.mjs");
    const projectNpm = path.join(root, "project-npm.mjs");
    fs.mkdirSync(installedDir, { recursive: true });
    fs.mkdirSync(currentInstalledDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      fakeNpm,
      [
        'import fs from "node:fs";',
        'fs.appendFileSync(process.env.FAKE_NPM_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
        'process.stdout.write(JSON.stringify("2.0.0"));',
      ].join("\n"),
    );
    fs.writeFileSync(
      projectNpm,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(projectNpmMarker)}, "ran");`,
    );
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:test-extension", "npm:current-extension"],
        npmCommand: [process.execPath, fakeNpm],
      }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        packages: ["npm:project-extension"],
        npmCommand: [process.execPath, projectNpm],
      }),
    );
    fs.writeFileSync(
      path.join(installedDir, "package.json"),
      JSON.stringify({ name: "test-extension", version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(currentInstalledDir, "package.json"),
      JSON.stringify({ name: "current-extension", version: "2.0.0" }),
    );
    vi.stubEnv("FAKE_NPM_LOG", npmLog);
    vi.stubEnv("PI_OFFLINE", "");

    await expect(checkUserExtensionUpdates(cwd, agentDir)).resolves.toEqual([
      {
        source: "npm:test-extension",
        displayName: "test-extension",
        type: "npm",
        scope: "user",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateAvailable: true,
      },
      {
        source: "npm:current-extension",
        displayName: "current-extension",
        type: "npm",
        scope: "user",
        currentVersion: "2.0.0",
        latestVersion: "2.0.0",
        updateAvailable: false,
      },
    ]);
    expect(fs.readFileSync(npmLog, "utf8")).toContain("view test-extension version --json");
    expect(fs.existsSync(projectNpmMarker)).toBe(false);

    fs.writeFileSync(npmLog, "");
    vi.stubEnv("PI_OFFLINE", "1");
    await expect(checkUserExtensionUpdates(cwd, agentDir)).resolves.toEqual([
      {
        source: "npm:test-extension",
        displayName: "test-extension",
        type: "npm",
        scope: "user",
        currentVersion: "1.0.0",
        latestVersion: null,
        updateAvailable: false,
      },
      {
        source: "npm:current-extension",
        displayName: "current-extension",
        type: "npm",
        scope: "user",
        currentVersion: "2.0.0",
        latestVersion: null,
        updateAvailable: false,
      },
    ]);
    expect(fs.readFileSync(npmLog, "utf8")).toBe("");
  });
});

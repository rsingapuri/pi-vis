import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOST_PATH = fileURLToPath(new URL("./host.mjs", import.meta.url));

async function spawnedHost() {
  const child = fork(HOST_PATH, [], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const stderr = [];
  child.stderr?.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Host did not announce spawned state")),
      5_000,
    );
    child.once("error", reject);
    child.on("message", (message) => {
      if (message?.type !== "control" || message.payload?.type !== "spawned") return;
      clearTimeout(timeout);
      resolve();
    });
  });
  return { child, stderr };
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("SDK host shutdown ownership", () => {
  it("owns SIGTERM instead of relying on Node's listener-sensitive default exit", async () => {
    const { child, stderr } = await spawnedHost();
    try {
      // Registering the host handler itself suppresses Node's default signal
      // exit, exactly as third-party extension listeners do. Reaching a coded
      // exit (rather than a signal exit or hang) proves the owned path ran.
      const exited = waitForExit(child);
      child.kill("SIGTERM");
      await expect(exited).resolves.toEqual({ code: 143, signal: null });
      expect(stderr.join("")).not.toContain("Forced exit after shutdown timed out");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("treats the parent IPC disconnect as a clean graceful shutdown", async () => {
    const { child, stderr } = await spawnedHost();
    try {
      const exited = waitForExit(child);
      child.disconnect();
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      expect(stderr.join("")).not.toContain("Forced exit after shutdown timed out");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

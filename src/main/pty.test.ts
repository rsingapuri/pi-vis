import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./settings-store.js", () => ({
  getSettings: () => ({ piBinaryPath: undefined, piEnv: "" }),
}));
vi.mock("./pi/locate-pi.js", () => ({
  locatePi: async () => ({ path: "/fake/pi" }),
}));
vi.mock("./auth.js", () => ({
  getSubprocessEnv: async () => ({}),
}));
vi.mock("./pi-env.js", () => ({
  mergeUserPiEnv: (env: Record<string, string>) => env,
}));

import { __ptyTest, initPty, startPty } from "./pty.js";

class FakePty {
  private data = new EventEmitter();
  private exit = new EventEmitter();
  writes: string[] = [];

  onData(cb: (data: string) => void): { dispose(): void } {
    this.data.on("data", cb);
    return { dispose: () => this.data.off("data", cb) };
  }

  onExit(cb: (result: { exitCode: number }) => void): { dispose(): void } {
    this.exit.on("exit", cb);
    return { dispose: () => this.exit.off("exit", cb) };
  }

  emitData(data: string): void {
    this.data.emit("data", data);
  }

  emitExit(exitCode: number): void {
    this.exit.emit("exit", { exitCode });
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}
  kill(): void {}
}

describe("pty autoLogin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __ptyTest.resetForTests();
  });

  it("does not write /login after the pty exits during the delay", async () => {
    const fake = new FakePty();
    __ptyTest.setSpawnForTests(() => fake);
    initPty(() => {});

    await startPty({ autoLogin: true });
    fake.emitData("ready");
    fake.emitExit(1);

    await vi.advanceTimersByTimeAsync(400);
    expect(fake.writes).toEqual([]);
  });
});

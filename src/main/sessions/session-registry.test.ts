import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SessionRegistry } from "./session-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../../../tests/fixtures/fake-pi.mjs");

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

describe("SessionRegistry", () => {
  let sessionsDir: string;
  let workspaceDir: string;
  let statusChanges: Array<{
    sessionId: SessionId;
    status: SessionStatus;
    error?: string | undefined;
  }>;
  let registry: SessionRegistry;

  beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
  });

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-reg-sessions-"));
    workspaceDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-reg-ws-")));
    process.env.FAKE_PI_SESSIONS_DIR = sessionsDir;

    statusChanges = [];
    registry = new SessionRegistry(
      (_sid: SessionId, _ev: PiEvent) => {},
      (_sid: SessionId, _req: ExtensionUiRequest) => {},
      (sessionId, status, error) => {
        statusChanges.push({ sessionId, status, error });
      },
    );
  });

  afterEach(() => {
    delete process.env.FAKE_PI_SESSIONS_DIR;
    try {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("openSession creates a cold record without spawning", () => {
    const id = registry.openSession(workspaceDir);
    const rec = registry.getSession(id);
    expect(rec).toBeDefined();
    expect(rec?.status).toBe("cold");
    expect(rec?.proc).toBeUndefined();
    expect(statusChanges.filter((s) => s.sessionId === id)).toHaveLength(0);
  });

  it("double-open guard rejects opening the same file twice while cold", () => {
    // First create a file on disk via fake-pi so we can reference it.
    const fileA = join(sessionsDir, "test-a.jsonl");
    fs.writeFileSync(fileA, "");
    const id1 = registry.openSession(workspaceDir, fileA);
    expect(id1).toBeDefined();
    expect(() => registry.openSession(workspaceDir, fileA)).toThrow(/already open/);
  });

  it("activateSession transitions cold → starting → ready and exposes the proc", async () => {
    const id = registry.openSession(workspaceDir);
    registry.activateSession(id, FAKE_PI);

    const rec = registry.getSession(id);
    expect(rec).toBeDefined();
    // We should have seen at least the "starting" event.
    const starting = statusChanges.find((s) => s.sessionId === id && s.status === "starting");
    expect(starting).toBeDefined();
    expect(rec?.proc).toBeDefined();

    // The proc is live — a get_state roundtrip should land.
    const proc = rec?.proc;
    expect(proc).toBeDefined();
    if (!proc) return;
    const res = await proc.sendCommand({ type: "get_state" });
    expect(res.success).toBe(true);

    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "ready"),
      5000,
      "ready status",
    );
    expect(statusChanges.some((s) => s.sessionId === id && s.status === "ready")).toBe(true);
  }, 15_000);

  it("activateSession is idempotent while a process is alive", () => {
    const id = registry.openSession(workspaceDir);
    registry.activateSession(id, FAKE_PI);
    const first = registry.getSession(id)?.proc;
    expect(first).toBeDefined();
    registry.activateSession(id, FAKE_PI);
    const second = registry.getSession(id)?.proc;
    expect(second).toBe(first);
  });

  it("activateSession respawns after the previous process exits", async () => {
    const id = registry.openSession(workspaceDir);
    registry.activateSession(id, FAKE_PI);
    const first = registry.getSession(id)?.proc;
    expect(first).toBeDefined();
    if (!first) return;

    first.stop();
    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "exited"),
      5000,
      "exited status",
    );

    statusChanges.length = 0;
    registry.activateSession(id, FAKE_PI);
    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "ready"),
      5000,
      "ready after respawn",
    );
    const second = registry.getSession(id)?.proc;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // Stale exit events from the old proc must not perturb the new state.
    await new Promise((r) => setTimeout(r, 500));
    const stillReady = statusChanges.filter((s) => s.sessionId === id && s.status === "exited");
    expect(stillReady).toHaveLength(0);
    expect(registry.getSession(id)?.status).toBe("ready");
  }, 15_000);

  it("closeSession removes the record and frees the byFile slot", async () => {
    const fileA = join(sessionsDir, "test-a.jsonl");
    fs.writeFileSync(fileA, "");
    const id = registry.openSession(workspaceDir, fileA);
    registry.closeSession(id);
    expect(registry.getSession(id)).toBeUndefined();

    // Re-opening with the same file should now succeed.
    const id2 = registry.openSession(workspaceDir, fileA);
    expect(id2).toBeDefined();
    expect(id2).not.toBe(id);

    // No status changes should have been emitted for the closed id after the close call.
    const afterClose = statusChanges.filter(
      (s) =>
        s.sessionId === id &&
        statusChanges.indexOf(s) > statusChanges.findIndex((x) => x.sessionId === id),
    );
    // The above may be brittle; simpler assertion: nothing after the close event.
    expect(statusChanges.every((s) => s.sessionId !== id)).toBe(true);
  });

  it("getByFile returns the record after openSession(ws, fileA); undefined for unknown; undefined after close", () => {
    const fileA = join(sessionsDir, "lookup-a.jsonl");
    fs.writeFileSync(fileA, "");
    const id = registry.openSession(workspaceDir, fileA);

    const found = registry.getByFile(fileA);
    expect(found).toBeDefined();
    expect(found?.sessionId).toBe(id);

    // Unknown path returns undefined.
    expect(registry.getByFile(join(sessionsDir, "nope.jsonl"))).toBeUndefined();

    // After close, the byFile slot is freed and getByFile returns undefined.
    registry.closeSession(id);
    expect(registry.getByFile(fileA)).toBeUndefined();
  });

  it("getByFile still returns an exited record (handler uses it to decide on a fresh open)", async () => {
    const fileA = join(sessionsDir, "exited-lookup.jsonl");
    fs.writeFileSync(fileA, "");
    const id = registry.openSession(workspaceDir, fileA);
    registry.activateSession(id, FAKE_PI);

    const proc = registry.getSession(id)?.proc;
    expect(proc).toBeDefined();
    if (!proc) return;

    proc.stop();
    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "exited"),
      5000,
      "exited status",
    );

    const found = registry.getByFile(fileA);
    expect(found).toBeDefined();
    expect(found?.sessionId).toBe(id);
    expect(found?.status).toBe("exited");
  }, 15_000);

  it("noteSessionFile sets once and ignores later changes", () => {
    const id = registry.openSession(workspaceDir);
    const fileA = join(sessionsDir, "first.jsonl");
    const fileB = join(sessionsDir, "second.jsonl");
    registry.noteSessionFile(id, fileA);
    expect(registry.getSession(id)?.sessionFile).toBe(fileA);

    registry.noteSessionFile(id, fileB);
    expect(registry.getSession(id)?.sessionFile).toBe(fileA);
  });

  describe("updateSessionFile (WP4 fileChanged flow)", () => {
    it("re-points byFile to the new path, freeing the old slot", () => {
      const id = registry.openSession(workspaceDir);
      const fileA = join(sessionsDir, "orig.jsonl");
      const fileB = join(sessionsDir, "new.jsonl");
      registry.noteSessionFile(id, fileA);
      expect(registry.getByFile(fileA)?.sessionId).toBe(id);

      registry.updateSessionFile(id, fileB);
      expect(registry.getSession(id)?.sessionFile).toBe(fileB);
      // Old slot freed so a future openSession(ws, fileA) doesn't
      // collide with the just-moved session.
      expect(registry.getByFile(fileA)).toBeUndefined();
      expect(registry.getByFile(fileB)?.sessionId).toBe(id);
    });

    it("clears the file when called with undefined (lazy new_session)", () => {
      const id = registry.openSession(workspaceDir);
      const fileA = join(sessionsDir, "lazy.jsonl");
      registry.noteSessionFile(id, fileA);
      registry.updateSessionFile(id, undefined);
      expect(registry.getSession(id)?.sessionFile).toBeUndefined();
      expect(registry.getByFile(fileA)).toBeUndefined();
    });

    it("is a no-op for unknown session ids", () => {
      const fileA = join(sessionsDir, "unknown.jsonl");
      // Should not throw.
      registry.updateSessionFile("unknown" as SessionId, fileA);
      expect(registry.getByFile(fileA)).toBeUndefined();
    });

    it("preserves ownership of the previous byFile slot when it points at a different session", () => {
      const fileA = join(sessionsDir, "shared.jsonl");
      fs.writeFileSync(fileA, "");
      const id1 = registry.openSession(workspaceDir, fileA);
      const id2 = registry.openSession(workspaceDir);
      // id1 owns fileA in byFile; move id2 to fileA — should free id1's
      // prior mapping (which is fileA) and re-claim it for id2.
      registry.updateSessionFile(id2, fileA);
      expect(registry.getByFile(fileA)?.sessionId).toBe(id2);
    });
  });
});

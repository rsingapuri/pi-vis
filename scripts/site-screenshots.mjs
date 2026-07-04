#!/usr/bin/env node
/**
 * Regenerates the landing-page screenshots in site/assets/screenshots/.
 *
 * Drives the browser-only dev renderer (`npm run dev:renderer`, which serves
 * the real React app against the preview stub in
 * src/renderer/src/preview-stub.ts) with headless Chromium, seeds a curated
 * demo workspace through the same store APIs the render tests use, and
 * captures:
 *
 *   hero.png                 — transcript view (Catppuccin Mocha)
 *   diff.png                 — diff viewer over a realistic changeset
 *   tree.png                 — conversation-tree navigator
 *   scheme-<id>.png          — one transcript shot per bundled colorscheme
 *
 * Usage:
 *   npm run site:screenshots
 *   PIVIS_SHOTS_URL=http://127.0.0.1:5173/ npm run site:screenshots   # reuse a running dev server
 *
 * The demo content is deliberately mundane (a queue-backoff fix in a made-up
 * sync service) so the screenshots read like a real session, not a fixture.
 * macOS traffic lights are drawn into the titlebar inset before capture —
 * the browser preview has no native window chrome, the packaged app does.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const OUT_DIR = join(root, "site", "assets", "screenshots");
const PORT = Number.parseInt(process.env["PIVIS_SHOTS_PORT"] ?? "5217", 10);
const EXTERNAL_URL = process.env["PIVIS_SHOTS_URL"];

const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;

// Gallery order is deliberate (matches the site's colorscheme section).
const SCHEMES = [
  { id: "mocha", file: "scheme-catppuccin-mocha", appearance: "dark" },
  { id: "macchiato", file: "scheme-catppuccin-macchiato", appearance: "dark" },
  { id: "frappe", file: "scheme-catppuccin-frappe", appearance: "dark" },
  { id: "everforest-dark", file: "scheme-everforest-dark", appearance: "dark" },
  { id: "gruvbox-material-dark", file: "scheme-gruvbox-material-dark", appearance: "dark" },
  { id: "glow-sticks", file: "scheme-glow-sticks", appearance: "dark" },
  { id: "latte", file: "scheme-catppuccin-latte", appearance: "light" },
  { id: "everforest-light", file: "scheme-everforest-light", appearance: "light" },
  { id: "gruvbox-material-light", file: "scheme-gruvbox-material-light", appearance: "light" },
];

const SEED_MODELS = [
  { id: "anthropic/claude-opus-4-8", name: "Opus 4.8", provider: "anthropic" },
  { id: "openai-codex/gpt-5-5", name: "GPT 5.5", provider: "openai-codex" },
  { id: "zai/glm-5-2", name: "GLM 5.2", provider: "zai" },
];

// ── Curated demo data ────────────────────────────────────────────────────
// A single coherent scenario: adding jittered retry backoff to the queue
// consumer of "tidepool", a fictional sync service.

const WS = "/Users/maya/code/tidepool";

const READ_OUTPUT = `import { Redis } from "ioredis";
import { logger } from "../log.js";
import type { SyncJob } from "./types.js";

const MAX_ATTEMPTS = 5;

export async function consume(redis: Redis, handler: (job: SyncJob) => Promise<void>) {
  for (;;) {
    const raw = await redis.blpop("sync:jobs", 0);
    if (!raw) continue;
    const job = JSON.parse(raw[1]) as SyncJob;
    try {
      await handler(job);
    } catch (err) {
      logger.warn({ err, job: job.id }, "job failed, requeueing");
      if (job.attempts < MAX_ATTEMPTS) {
        await redis.rpush("sync:jobs", JSON.stringify({ ...job, attempts: job.attempts + 1 }));
      }
    }
  }
}`;

const EDIT_DIFF = `--- a/src/queue/consumer.ts
+++ b/src/queue/consumer.ts
@@ -1,5 +1,6 @@
 import { Redis } from "ioredis";
 import { logger } from "../log.js";
+import { backoffMs } from "./backoff.js";
 import type { SyncJob } from "./types.js";

@@ -14,7 +15,9 @@ export async function consume(
     } catch (err) {
       logger.warn({ err, job: job.id }, "job failed, requeueing");
       if (job.attempts < MAX_ATTEMPTS) {
-        await redis.rpush("sync:jobs", JSON.stringify({ ...job, attempts: job.attempts + 1 }));
+        const next = { ...job, attempts: job.attempts + 1 };
+        const score = Date.now() + backoffMs(next.attempts);
+        await redis.zadd("sync:delayed", score, JSON.stringify(next));
       }
     }`;

const TEST_OUTPUT = `> tidepool@2.4.1 test
> vitest run backoff

 ✓ src/queue/backoff.test.ts (5 tests) 31ms
   ✓ grows exponentially up to the cap
   ✓ never exceeds MAX_DELAY_MS
   ✓ applies full jitter across the delay window
   ✓ promotes delayed jobs after their deadline
   ✓ reconnect does not re-deliver in-flight jobs

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  480ms`;

const TRANSCRIPT = [
  {
    id: "h1",
    type: "user",
    data: {
      content:
        "Sync jobs that fail during a Redis reconnect get retried immediately, and the burst is hammering the upstream API. Can you add jittered backoff to the queue consumer? There should also be a test covering the reconnect path.",
    },
  },
  {
    id: "h2",
    type: "assistant",
    data: {
      thinking:
        "Immediate-retry storms usually mean the requeue path has no delay in it. Before touching anything I want to see how failed jobs get requeued.",
      content: "Let me look at how the consumer requeues failed jobs first.",
    },
  },
  {
    id: "h3",
    type: "tool_call",
    data: {
      toolCallId: "c1",
      toolName: "read",
      input: { file_path: "src/queue/consumer.ts" },
      outputText: READ_OUTPUT,
      isError: false,
      isStreaming: false,
    },
  },
  {
    id: "h4",
    type: "assistant",
    data: {
      content:
        "Found it — the catch block pushes the job straight back onto `sync:jobs`, so after a reconnect every failed job is retried within milliseconds. I will add a capped exponential backoff with full jitter, and keep the delay in Redis itself so it survives a worker restart.",
    },
  },
  {
    id: "h5",
    type: "tool_call",
    data: {
      toolCallId: "c2",
      toolName: "edit",
      input: { file_path: "src/queue/consumer.ts" },
      outputText: "",
      diff: EDIT_DIFF,
      isError: false,
      isStreaming: false,
    },
  },
  {
    id: "h6",
    type: "tool_call",
    data: {
      toolCallId: "c3",
      toolName: "bash",
      input: { command: "npm test -- backoff" },
      outputText: TEST_OUTPUT,
      isError: false,
      isStreaming: false,
    },
  },
  {
    id: "h7",
    type: "assistant",
    data: {
      content: [
        "Done. Failed jobs now land in a `sync:delayed` sorted set scored by their retry deadline, instead of going straight back onto the list.",
        "",
        "- `backoffMs` is capped exponential with full jitter: `min(30s, 500ms · 2^attempt)`, scaled by `Math.random()`",
        "- promotion back onto `sync:jobs` happens in the existing poll loop, so there are no new timers to manage",
        "- the reconnect path is covered in `src/queue/backoff.test.ts` — it kills the connection mid-handler and asserts exactly one delayed re-delivery",
        "",
        "One caveat worth knowing: jobs already in flight when Redis drops are still re-run from scratch. Deduplicating those would need idempotency keys upstream, which I left alone.",
        "",
        "A follow-up worth considering: a small gauge on `sync:delayed` depth, so reconnect storms show up on the dashboard instead of in API error budgets.",
      ].join("\n"),
    },
  },
];

// Working-tree contents backing the diff viewer shot. Old/new text pairs are
// full files so the viewer produces real hunks with real syntax highlighting.
const DIFF_FILES = {
  "src/queue/consumer.ts": {
    status: "M",
    old: `import { Redis } from "ioredis";
import { logger } from "../log.js";
import type { SyncJob } from "./types.js";

const MAX_ATTEMPTS = 5;

export async function consume(
  redis: Redis,
  handler: (job: SyncJob) => Promise<void>,
): Promise<void> {
  for (;;) {
    const raw = await redis.blpop("sync:jobs", 0);
    if (!raw) continue;
    const job = JSON.parse(raw[1]) as SyncJob;
    try {
      await handler(job);
    } catch (err) {
      logger.warn({ err, job: job.id }, "job failed, requeueing");
      if (job.attempts < MAX_ATTEMPTS) {
        await redis.rpush(
          "sync:jobs",
          JSON.stringify({ ...job, attempts: job.attempts + 1 }),
        );
      }
    }
  }
}
`,
    nw: `import { Redis } from "ioredis";
import { logger } from "../log.js";
import { backoffMs } from "./backoff.js";
import type { SyncJob } from "./types.js";

const MAX_ATTEMPTS = 5;
const PROMOTE_BATCH = 100;

/** Move due delayed jobs back onto the main list. */
async function promoteDue(redis: Redis): Promise<void> {
  const due = await redis.zrangebyscore("sync:delayed", 0, Date.now(), "LIMIT", 0, PROMOTE_BATCH);
  if (due.length === 0) return;
  const multi = redis.multi();
  for (const raw of due) multi.rpush("sync:jobs", raw).zrem("sync:delayed", raw);
  await multi.exec();
}

export async function consume(
  redis: Redis,
  handler: (job: SyncJob) => Promise<void>,
): Promise<void> {
  for (;;) {
    await promoteDue(redis);
    const raw = await redis.blpop("sync:jobs", 5);
    if (!raw) continue;
    const job = JSON.parse(raw[1]) as SyncJob;
    try {
      await handler(job);
    } catch (err) {
      logger.warn({ err, job: job.id, attempt: job.attempts }, "job failed");
      if (job.attempts < MAX_ATTEMPTS) {
        const next = { ...job, attempts: job.attempts + 1 };
        const score = Date.now() + backoffMs(next.attempts);
        await redis.zadd("sync:delayed", score, JSON.stringify(next));
      } else {
        await redis.rpush("sync:dead", JSON.stringify(job));
      }
    }
  }
}
`,
  },
  "src/queue/backoff.ts": {
    status: "A",
    old: "",
    nw: `/**
 * Capped exponential backoff with full jitter.
 *
 * Base doubles per attempt and the result is scaled by Math.random(),
 * so concurrent failures spread across the whole window instead of
 * retrying in lockstep (the "thundering herd" reconnect problem).
 */
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

export function backoffMs(attempt: number): number {
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(cap * Math.random());
}
`,
  },
  "src/queue/backoff.test.ts": {
    status: "A",
    old: "",
    nw: `import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs } from "./backoff.js";
import { consume } from "./consumer.js";
import { fakeRedis } from "../test/fake-redis.js";

describe("backoffMs", () => {
  it("grows exponentially up to the cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(10)).toBe(30_000);
  });

  it("applies full jitter across the delay window", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    expect(backoffMs(3)).toBe(1000);
  });
});

describe("consume", () => {
  let redis: ReturnType<typeof fakeRedis>;

  beforeEach(() => {
    redis = fakeRedis();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("promotes delayed jobs after their deadline", async () => {
    await redis.zadd("sync:delayed", Date.now() - 1, payload({ id: "j1" }));
    const seen: string[] = [];
    void consume(redis, async (job) => void seen.push(job.id));
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(["j1"]);
  });

  it("does not re-deliver in-flight jobs on reconnect", async () => {
    const seen: string[] = [];
    void consume(redis, async (job) => {
      redis.dropConnection();
      seen.push(job.id);
    });
    await redis.rpush("sync:jobs", payload({ id: "j2" }));
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toEqual(["j2"]);
  });
});
`,
  },
  "src/queue/types.ts": {
    status: "M",
    old: `export interface SyncJob {
  id: string;
  source: string;
  cursor: string | null;
  attempts: number;
}
`,
    nw: `export interface SyncJob {
  id: string;
  source: string;
  cursor: string | null;
  attempts: number;
  /** Epoch-ms deadline set when the job is parked in sync:delayed. */
  notBefore?: number;
}
`,
  },
};

// Conversation tree for the /tree shot: one abandoned (labeled) branch, one
// active branch with a follow-up question, flat wire shape (parentId-keyed).
function buildTreeNodes(modelId) {
  const ts = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
  const msg = (id, role, content, parentId, label) => ({
    entry: { id, type: "message", timestamp: ts(60), message: { role, content } },
    parentId,
    label,
  });
  const toolResult = (id, toolCallId, content, parentId) => ({
    entry: {
      id,
      type: "message",
      timestamp: ts(60),
      message: { role: "toolResult", toolCallId, content },
    },
    parentId,
  });
  return [
    {
      entry: {
        id: "mc1",
        type: "model_change",
        timestamp: ts(95),
        modelId,
      },
      parentId: undefined,
    },
    {
      entry: {
        id: "tl1",
        type: "thinking_level_change",
        timestamp: ts(95),
        thinkingLevel: "medium",
      },
      parentId: "mc1",
    },
    {
      entry: { id: "si1", type: "session_info", timestamp: ts(94), name: "sync retry backoff" },
      parentId: "tl1",
    },
    msg(
      "u1",
      "user",
      "Sync jobs that fail during a Redis reconnect get retried immediately, and the burst is hammering the upstream API. Can you add jittered backoff to the queue consumer?",
      "si1",
    ),
    // Abandoned attempt: sleep inline in the consumer loop.
    msg(
      "a1",
      "assistant",
      [
        { type: "text", text: "Simplest fix: sleep before requeueing inside the catch block." },
        { type: "toolCall", id: "tc1", name: "edit", arguments: { path: "src/queue/consumer.ts" } },
      ],
      "u1",
    ),
    toolResult("tr1", "tc1", "…consumer.ts updated…", "a1"),
    msg(
      "a1b",
      "assistant",
      [
        {
          type: "text",
          text: "This works but the worker blocks while it sleeps — a burst of failures stalls the whole queue. Backing this out.",
        },
      ],
      "tr1",
      "inline-sleep",
    ),
    // Active branch.
    msg(
      "a2",
      "assistant",
      [
        { type: "text", text: "Let me look at how the consumer requeues failed jobs first." },
        { type: "toolCall", id: "tc2", name: "read", arguments: { path: "src/queue/consumer.ts" } },
      ],
      "u1",
    ),
    toolResult("tr2", "tc2", "…src/queue/consumer.ts…", "a2"),
    msg(
      "a3",
      "assistant",
      [
        {
          type: "text",
          text: "Found it — the catch block pushes the job straight back onto sync:jobs. Parking retries in a sorted set instead.",
        },
        { type: "toolCall", id: "tc3", name: "edit", arguments: { path: "src/queue/consumer.ts" } },
      ],
      "tr2",
    ),
    toolResult("tr3", "tc3", "…consumer.ts updated…", "a3"),
    msg("u2", "user", "Nice. Does the delay survive a worker restart?", "tr3"),
    msg(
      "a4",
      "assistant",
      [
        {
          type: "text",
          text: "Yes — the deadline lives in Redis as the member score, not in process memory, so a restarted worker picks up exactly where it left off.",
        },
      ],
      "u2",
      "delayed-set",
    ),
    msg(
      "u3",
      "user",
      "What happens to a job that exhausts all five attempts? I would rather not lose it silently.",
      "a4",
    ),
    msg(
      "a5",
      "assistant",
      [
        {
          type: "text",
          text: "Right now it is dropped after the warn log. Parking exhausted jobs in a dead-letter list instead.",
        },
        { type: "toolCall", id: "tc4", name: "edit", arguments: { path: "src/queue/consumer.ts" } },
      ],
      "u3",
    ),
    toolResult("tr4", "tc4", "…consumer.ts updated…", "a5"),
    msg(
      "a6",
      "assistant",
      [
        {
          type: "text",
          text: "Exhausted jobs now land in sync:dead with their last error attached, so nothing disappears silently. The runbook can drain it with a one-liner.",
        },
      ],
      "tr4",
    ),
  ];
}

function seedDataFor(model) {
  return {
    ws: WS,
    transcript: TRANSCRIPT,
    diffFiles: DIFF_FILES,
    treeNodes: buildTreeNodes(model.id),
    treeLeafId: "a6",
    model,
  };
}

// ── In-page seeding (runs inside the renderer) ──────────────────────────

async function seedPage(page, model = SEED_MODELS[0]) {
  await page.waitForFunction(() => {
    const w = window;
    return Boolean(w.__pivisStore && document.querySelector(".sidebar"));
  });
  await page.evaluate(async (data) => {
    const st = window.__pivisStore.getState();
    const bootId = st.activeSessionId;

    // Curated workspace + sessions replace the stub's demo seed.
    st.addWorkspace(data.ws);
    st.createSession("shot-main", data.ws);
    st.setSessionName("shot-main", "sync retry backoff");
    st.setSessionStatus("shot-main", "ready");
    st.setActiveWorkspace(data.ws);
    st.setActiveSession("shot-main");
    st.expandWorkspace(data.ws);
    if (bootId) st.closeSessionTab(bootId);
    st.removeSession("demo-session-1");
    st.removeWorkspace("/Users/demo/src/pi-vis");

    const now = Date.now();
    st.setWorkspaceSessions(data.ws, [
      {
        filePath: "/Users/maya/.pi/agent/sessions/tidepool/a1.jsonl",
        id: "stored-1",
        name: "shutdown handler cleanup",
        mtime: now - 45 * 60 * 1000,
        lastActiveAt: now - 45 * 60 * 1000,
        messageCount: 24,
        preview: "The worker leaks the SIGTERM listener",
      },
      {
        filePath: "/Users/maya/.pi/agent/sessions/tidepool/a2.jsonl",
        id: "stored-2",
        name: "ioredis upgrade",
        mtime: now - 26 * 60 * 60 * 1000,
        lastActiveAt: now - 26 * 60 * 60 * 1000,
        messageCount: 41,
        preview: "Bump ioredis and fix the type breaks",
      },
      {
        filePath: "/Users/maya/.pi/agent/sessions/tidepool/a3.jsonl",
        id: "stored-3",
        name: "nightly export pipeline",
        mtime: now - 3 * 24 * 60 * 60 * 1000,
        lastActiveAt: now - 3 * 24 * 60 * 60 * 1000,
        messageCount: 67,
        preview: "Exports time out when the batch exceeds",
      },
    ]);

    st.seedHistory("shot-main", data.transcript);
    st.setCurrentModel("shot-main", data.model.id, data.model.provider);
    st.setThinkingLevel("shot-main", "medium");
    st.setStats("shot-main", {
      sessionId: "shot-main",
      tokens: { input: 148230, output: 9412, cacheRead: 121050, cacheWrite: 0, total: 157642 },
      cost: 0.87,
      contextUsage: { tokens: 46800, contextWindow: 200000, percent: 23.4 },
    });

    // An extension-provided status line (pi-headroom), as the real host
    // forwards it: raw ANSI colors in statusText.
    st.addUiRequest("shot-main", {
      type: "extension_ui_request",
      id: "status-headroom",
      method: "setStatus",
      statusKey: "pi-headroom",
      statusText:
        "\u001b[38;2;166;227;161m✓ \u001b[39m\u001b[38;2;108;112;134mHeadroom −19% (8,204 saved)\u001b[39m",
    });

    // Route git + tree IPC to the curated dataset. Everything else falls
    // through to the preview stub.
    const counts = {};
    for (const [p, f] of Object.entries(data.diffFiles)) {
      const oldLines = new Map();
      for (const l of f.old ? f.old.split("\n") : []) oldLines.set(l, (oldLines.get(l) ?? 0) + 1);
      const newLines = new Map();
      for (const l of f.nw.split("\n")) newLines.set(l, (newLines.get(l) ?? 0) + 1);
      let ins = 0;
      for (const [l, c] of newLines) ins += Math.max(0, c - (oldLines.get(l) ?? 0));
      let del = 0;
      for (const [l, c] of oldLines) del += Math.max(0, c - (newLines.get(l) ?? 0));
      counts[p] = { ins, del };
    }
    const orig = window.pivis.invoke.bind(window.pivis);
    window.pivis.invoke = async (channel, req) => {
      if (channel === "git.changes") {
        return {
          kind: "ok",
          repoRoot: data.ws,
          truncated: false,
          fingerprint: "shot",
          files: Object.entries(data.diffFiles).map(([path, f]) => ({
            path,
            status: f.status,
            untracked: f.status === "A",
            insertions: counts[path].ins,
            deletions: counts[path].del,
            binary: false,
          })),
        };
      }
      if (channel === "git.changesCount") {
        return { kind: "ok", fileCount: Object.keys(data.diffFiles).length };
      }
      if (channel === "git.fileDiff") {
        const f = data.diffFiles[req?.filePath ?? req?.path];
        if (f) {
          return {
            kind: "ok",
            oldText: f.old,
            newText: f.nw,
            binary: false,
            tooLarge: false,
            oldMissingNewline: false,
            newMissingNewline: false,
          };
        }
      }
      if (channel === "git.branches") {
        return {
          kind: "ok",
          current: "main",
          branches: [
            { name: "main", remote: false, current: true },
            { name: "queue-backoff", remote: false, current: false },
            { name: "export-timeouts", remote: false, current: false },
            { name: "origin/main", remote: true, current: false },
          ],
        };
      }
      if (channel === "session.sendCommand" && req?.command?.type === "get_tree") {
        return {
          type: "response",
          command: "get_tree",
          success: true,
          data: { nodes: data.treeNodes, leafId: data.treeLeafId },
        };
      }
      if (channel === "session.sendCommand" && req?.command?.type === "get_available_models") {
        return {
          type: "response",
          command: "get_available_models",
          success: true,
          data: {
            models: [{ ...data.model, reasoning: true, input: ["text", "image"] }],
            currentModelId: data.model.id,
          },
        };
      }
      if (channel === "session.sendCommand" && req?.command?.type === "get_state") {
        return {
          type: "response",
          command: "get_state",
          success: true,
          data: {
            model: data.model,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            sessionId: "shot-main",
          },
        };
      }
      return orig(channel, req);
    };
  }, seedDataFor(model));

  // The session's model bootstrap races the seed above and resolves against
  // the preview stub's defaults, so re-pin the curated model once it settles.
  await page.waitForTimeout(400);
  await page.evaluate((model) => {
    const st = window.__pivisStore.getState();
    st.setCurrentModel("shot-main", model.id, model.provider);
    st.setThinkingLevel("shot-main", "medium");
  }, model);
}

async function applyScheme(page, scheme) {
  await page.evaluate(async ({ id, appearance }) => {
    const mod = await import("/src/stores/settings-store.ts");
    const patch =
      appearance === "dark"
        ? { themeMode: "dark", darkColorScheme: id }
        : { themeMode: "light", lightColorScheme: id };
    await mod.useSettingsStore.getState().update(patch);
  }, scheme);
  await page.waitForTimeout(400); // let Shiki re-tokenize
}

/** Draw macOS traffic lights into the titlebar inset (12px dots at x=20). */
async function addWindowChrome(page) {
  await page.evaluate(() => {
    if (document.getElementById("__shot-traffic-lights")) return;
    const wrap = document.createElement("div");
    wrap.id = "__shot-traffic-lights";
    wrap.style.cssText =
      "position:fixed;top:0;left:0;height:38px;display:flex;align-items:center;gap:8px;padding-left:20px;z-index:2147483647;pointer-events:none";
    for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
      const dot = document.createElement("span");
      dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c};box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.2)`;
      wrap.appendChild(dot);
    }
    document.body.appendChild(wrap);
  });
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function capture(page, name) {
  await addWindowChrome(page);
  await settle(page);
  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path, type: "png" });
  console.log(`  ✓ ${name}.png`);
}

// ── Shots ────────────────────────────────────────────────────────────────

async function shotTranscript(context, url, scheme, name, model = SEED_MODELS[0]) {
  const page = await context.newPage();
  await page.goto(url);
  await seedPage(page, model);
  await applyScheme(page, scheme);
  await capture(page, name);
  await page.close();
}

async function shotDiff(context, url, scheme, model = SEED_MODELS[0]) {
  const page = await context.newPage();
  await page.goto(url);
  await seedPage(page, model);
  await applyScheme(page, scheme);
  await page.evaluate(async (ws) => {
    const mod = await import("/src/stores/diff-store.ts");
    mod.useDiffStore.getState().openViewer("shot-main", ws);
  }, WS);
  // Wait until every file section has rendered highlighted rows.
  await page.waitForFunction((count) => {
    const sections = document.querySelectorAll(".diff-file");
    if (sections.length !== count) return false;
    return document.querySelectorAll(".diff-file table, .diff-file [class*='row']").length > 0;
  }, Object.keys(DIFF_FILES).length);
  await capture(page, "diff");
  await page.close();
}

async function shotTree(context, url, scheme, model = SEED_MODELS[0]) {
  const page = await context.newPage();
  await page.goto(url);
  await seedPage(page, model);
  await applyScheme(page, scheme);
  await page.evaluate(async () => {
    const mod = await import("/src/stores/tree-store.ts");
    await mod.useTreeStore.getState().openTreeForSession("shot-main");
  });
  await page.waitForSelector(".tree-overlay");
  await capture(page, "tree");
  await page.close();
}

// ── Server + main ────────────────────────────────────────────────────────

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Dev server at ${url} did not come up`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let server = null;
  let url = EXTERNAL_URL;
  if (!url) {
    url = `http://127.0.0.1:${PORT}/`;
    console.log(`Starting dev renderer on :${PORT} …`);
    server = spawn(
      "npm",
      ["run", "dev:renderer", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
      { cwd: root, stdio: "ignore" },
    );
  }

  try {
    await waitForServer(url);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: "dark",
    });

    console.log("Capturing feature shots …");
    const mocha = SCHEMES[0];
    await shotTranscript(context, url, mocha, "hero", SEED_MODELS[0]);
    await shotDiff(context, url, mocha, SEED_MODELS[1]);
    await shotTree(context, url, mocha, SEED_MODELS[2]);

    console.log("Capturing colorscheme gallery …");
    for (const [index, scheme] of SCHEMES.entries()) {
      await shotTranscript(
        context,
        url,
        scheme,
        scheme.file,
        SEED_MODELS[index % SEED_MODELS.length],
      );
    }

    await browser.close();
    console.log(`Done → ${OUT_DIR}`);
  } finally {
    if (server) server.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

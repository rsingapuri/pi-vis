import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { type LaunchedElectronApplication, launchElectron } from "./electron-launch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ENTRY = join(__dirname, "../../out/main/index.js");
const PROJECT_WORKSPACE = join(__dirname, "../..");
const FIXTURE_EXTENSION = join(__dirname, "../fixtures/real-host-smoke-extension/smoke-e2e.ts");

function locatePiBin(): string | null {
  const candidates = [process.env.PIVIS_TEST_PI_BIN];
  try {
    candidates.push(execSync("command -v pi", { encoding: "utf8" }).trim());
  } catch {
    // Pi is optional in generic CI, but mandatory on developer machines where
    // this compatibility smoke test can run without model API usage.
  }
  candidates.push("/opt/homebrew/bin/pi", "/usr/local/bin/pi");
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

const PI_BIN = locatePiBin();
const PI_VERSION = PI_BIN
  ? execFileSync(PI_BIN, ["--version"], { encoding: "utf8" }).trim().replace(/^v/, "")
  : null;

function rmrf(path: string): void {
  try {
    fs.rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of throwaway SDK state.
  }
}

async function launchRealHostApp(): Promise<{
  app: LaunchedElectronApplication;
  window: Page;
  stderr: string[];
  dirs: string[];
}> {
  if (!PI_BIN) throw new Error("Pi binary is unavailable");
  const settingsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-real-host-settings-"));
  const workspaceDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-real-host-workspace-"));
  const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-real-host-agent-"));
  const sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-real-host-sessions-"));
  fs.mkdirSync(join(agentDir, "extensions"), { recursive: true });
  fs.copyFileSync(FIXTURE_EXTENSION, join(agentDir, "extensions", "smoke-e2e.ts"));
  fs.writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      piBinaryPath: PI_BIN,
      workspaceOrder: [workspaceDir],
      fonts: { display: { sizePx: 14 }, code: { family: "IBM Plex Mono", sizePx: 14 } },
    }),
  );

  const app = await launchElectron({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: settingsDir,
      PIVIS_SESSIONS_DIR: sessionsDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  const stderr: string[] = [];
  app.process().stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  app
    .process()
    .stdout?.on("data", (chunk: Buffer) => stderr.push(`[stdout] ${chunk.toString("utf8")}`));
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 30_000 });
  return {
    app,
    window,
    stderr,
    dirs: [settingsDir, workspaceDir, agentDir, sessionsDir],
  };
}

async function launchUserConfiguredHostApp(): Promise<{
  app: LaunchedElectronApplication;
  window: Page;
  stderr: string[];
  dirs: string[];
}> {
  if (!PI_BIN) throw new Error("Pi binary is unavailable");
  const settingsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-user-host-settings-"));
  const sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-user-host-sessions-"));
  fs.writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      piBinaryPath: PI_BIN,
      workspaceOrder: [PROJECT_WORKSPACE],
      fonts: { display: { sizePx: 14 }, code: { family: "IBM Plex Mono", sizePx: 14 } },
    }),
  );
  const app = await launchElectron({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: settingsDir,
      PIVIS_SESSIONS_DIR: sessionsDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  const stderr: string[] = [];
  app.process().stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  app
    .process()
    .stdout?.on("data", (chunk: Buffer) => stderr.push(`[stdout] ${chunk.toString("utf8")}`));
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 30_000 });
  return { app, window, stderr, dirs: [settingsDir, sessionsDir] };
}

interface LocalProviderRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

async function startLocalProvider(): Promise<{
  baseUrl: string;
  requests: LocalProviderRequest[];
  close: () => Promise<void>;
}> {
  const requests: LocalProviderRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      if (request.method !== "POST" || url !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: `Unexpected local-provider route: ${request.method} ${url}` }),
        );
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ method: request.method, url, body });
      const serializedMessages = JSON.stringify(body.messages ?? []);
      const isCompaction = /summariz|compaction|context to preserve/i.test(serializedMessages);
      const text = isCompaction
        ? "## Goal\nDeterministic compacted summary.\n\n## Progress\n- Seeded local-provider turns were processed."
        : `Deterministic local assistant response ${requests.length}.`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1_752_192_000,
          model: "pivis-test-model",
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1_752_192_000,
          model: "pivis-test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function launchLocalProviderHostApp(baseUrl: string) {
  if (!PI_BIN) throw new Error("Pi binary is unavailable");
  const settingsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-local-provider-settings-"));
  const workspaceDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-local-provider-workspace-"));
  const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-local-provider-agent-"));
  const sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-local-provider-sessions-"));
  fs.writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pivis-local": {
          baseUrl,
          api: "openai-completions",
          apiKey: "test-key",
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
          },
          models: [
            {
              id: "pivis-test-model",
              name: "Pi-Vis Test Model",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 200 },
    }),
  );
  fs.writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      piBinaryPath: PI_BIN,
      workspaceOrder: [workspaceDir],
      fonts: { display: { sizePx: 14 }, code: { family: "IBM Plex Mono", sizePx: 14 } },
    }),
  );
  const app = await launchElectron({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: settingsDir,
      PIVIS_SESSIONS_DIR: sessionsDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      ELECTRON_RENDERER_URL: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
    },
  });
  const stderr: string[] = [];
  app.process().stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  app
    .process()
    .stdout?.on("data", (chunk: Buffer) => stderr.push(`[stdout] ${chunk.toString("utf8")}`));
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 30_000 });
  return {
    app,
    window,
    stderr,
    sessionsDir,
    dirs: [settingsDir, workspaceDir, agentDir, sessionsDir],
  };
}

function findSessionFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? findSessionFiles(path) : path.endsWith(".jsonl") ? [path] : [];
  });
}

function sessionHasCompaction(path: string, summary: string): boolean {
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        const entry = JSON.parse(line) as { type?: unknown };
        return entry.type === "compaction" && JSON.stringify(entry).includes(summary);
      } catch {
        return false;
      }
    });
}

test.describe("Real SDK-host smoke", () => {
  test.skip(!PI_BIN, "No real Pi binary found");
  test.beforeAll(() => expect(PI_VERSION).toBe("0.80.6"));

  test("starts cleanly, executes an extension, and reports empty-session compaction as a domain failure", async () => {
    test.setTimeout(120_000);
    const { app, window, stderr, dirs } = await launchRealHostApp();
    try {
      await window.getByRole("button", { name: "New session" }).click();
      const textarea = window.locator(".composer__textarea");
      await expect(textarea).toBeEnabled({ timeout: 60_000 });
      await expect(
        window.getByText(
          "Pi public API cannot install the pi-vis palette globally; extension panels use a local semantic theme.",
          { exact: true },
        ),
      ).toHaveCount(0);

      // Exercise the domain-failure path before adding any extension-owned content.
      await textarea.fill("/compact");
      await textarea.press("Enter");
      await expect(window.getByText("Nothing to compact", { exact: false }).first()).toBeVisible();
      await expect(window.getByText("Context compacted", { exact: false })).toHaveCount(0);
      await expect(window.getByText("Compaction failed", { exact: false }).first()).toBeVisible();
      await expect(textarea).toHaveValue("");

      // A missing compaction_end leaves that authority conservatively fenced;
      // do not prove extension execution by overtaking its unknown boundary.
      // A fresh session verifies the independent extension command path.
      await window.getByRole("button", { name: "New session" }).click();
      const freshTextarea = window.locator(".composer__textarea");
      await expect(freshTextarea).toBeEnabled({ timeout: 60_000 });
      await freshTextarea.fill("/smoke-e2e");
      await expect(
        window.locator(".composer__suggestion").filter({ hasText: "smoke-e2e" }),
      ).toBeVisible();
      await freshTextarea.press("Enter");
      await expect(freshTextarea).toHaveValue("");
      await expect(
        window.getByText("Real SDK host command completed", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(window.getByText(/Host process exited/)).toHaveCount(0);
    } catch (error) {
      throw new Error(`${String(error)}\nElectron stderr:\n${stderr.join("")}`);
    } finally {
      await app.close();
      for (const dir of dirs) rmrf(dir);
    }
  });

  test("successfully compacts through a deterministic localhost provider", async () => {
    test.setTimeout(180_000);
    const provider = await startLocalProvider();
    const { app, window, stderr, sessionsDir, dirs } = await launchLocalProviderHostApp(
      provider.baseUrl,
    );
    try {
      await window.getByRole("button", { name: "New session" }).click();
      const textarea = window.locator(".composer__textarea");
      await expect(textarea).toBeEnabled({ timeout: 60_000 });
      await expect(
        window.getByText(
          "Pi public API cannot install the pi-vis palette globally; extension panels use a local semantic theme.",
          { exact: true },
        ),
      ).toHaveCount(0);

      await textarea.fill("/model pivis-local/pivis-test-model");
      await textarea.press("Enter");
      await expect(textarea).toHaveValue("");
      await expect(
        window.getByText(/Model:.*Pi-Vis Test Model|Model:.*pivis-test-model/).first(),
      ).toBeVisible();

      await textarea.fill(`First deterministic turn ${"alpha beta gamma ".repeat(80)}`);
      await textarea.press("Enter");
      await expect(
        window.getByText("Deterministic local assistant response 1.", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await textarea.fill(`Second deterministic turn ${"delta epsilon zeta ".repeat(80)}`);
      await textarea.press("Enter");
      await expect(
        window.getByText("Deterministic local assistant response 2.", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });

      await textarea.fill("/compact");
      await textarea.press("Enter");
      await expect(window.getByText("Context compacted", { exact: false }).first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(window.getByText("Nothing to compact", { exact: false })).toHaveCount(0);
      await expect(window.getByText("Compaction failed", { exact: false })).toHaveCount(0);
      await expect(textarea).toHaveValue("");

      expect(provider.requests).toHaveLength(3);
      const compactRequest = provider.requests[2]!;
      expect(compactRequest.method).toBe("POST");
      expect(compactRequest.url).toBe("/v1/chat/completions");
      expect(compactRequest.body.model).toBe("pivis-test-model");
      expect(compactRequest.body.stream).toBe(true);
      expect(JSON.stringify(compactRequest.body.messages)).toContain("First deterministic turn");

      await expect
        .poll(() =>
          findSessionFiles(sessionsDir).some((file) =>
            sessionHasCompaction(file, "Deterministic compacted summary"),
          ),
        )
        .toBe(true);

      await textarea.fill("/session");
      await textarea.press("Enter");
      await expect(window.getByText(/Host process exited/)).toHaveCount(0);
    } catch (error) {
      const body = await window
        .locator("body")
        .innerText()
        .catch(() => "<body unavailable>");
      throw new Error(
        `${String(error)}\nVisible UI:\n${body.slice(-4_000)}\nElectron output:\n${stderr.join("")}\nSession files:\n${findSessionFiles(
          sessionsDir,
        )
          .map((file) => `${file}\n${fs.readFileSync(file, "utf8").slice(-4_000)}`)
          .join("\n---\n")}\nProvider requests:\n${JSON.stringify(provider.requests, null, 2)}`,
      );
    } finally {
      await app.close();
      await provider.close();
      for (const dir of dirs) rmrf(dir);
    }
  });

  test("user extension environment survives built-in command traffic", async () => {
    test.skip(
      process.env.PIVIS_REAL_USER_HOST_SMOKE !== "1",
      "Opt in to load the developer's real global/project extensions",
    );
    test.setTimeout(120_000);
    const { app, window, stderr, dirs } = await launchUserConfiguredHostApp();
    try {
      await window.getByRole("button", { name: "New session" }).click();
      const textarea = window.locator(".composer__textarea");
      await expect(textarea).toBeEnabled({ timeout: 60_000 });

      await textarea.fill("/session");
      await textarea.press("Enter");
      await expect(textarea).toHaveValue("");
      await expect(window.getByText("Session", { exact: false }).first()).toBeVisible();

      await textarea.fill("/compact");
      await textarea.press("Enter");
      await expect(textarea).toHaveValue("");

      await textarea.fill("/session");
      await textarea.press("Enter");
      await expect(textarea).toHaveValue("");
      await expect(window.getByText(/Host process exited/)).toHaveCount(0);
    } catch (error) {
      const body = await window
        .locator("body")
        .innerText()
        .catch(() => "<body unavailable>");
      throw new Error(
        `${String(error)}\nVisible UI:\n${body.slice(-4_000)}\nElectron output:\n${stderr.join("")}`,
      );
    } finally {
      await app.close();
      for (const dir of dirs) rmrf(dir);
    }
  });
});

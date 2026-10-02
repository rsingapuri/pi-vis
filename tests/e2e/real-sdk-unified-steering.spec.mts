import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/invariants.mjs";
import {
  REAL_SDK_PROVIDER_LATENCY,
  type RealSdkFixture,
  type RealSdkLaunch,
  createRealSdkFixture,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import {
  type ScriptedOpenAIProvider,
  createScriptedOpenAIProvider,
} from "./support/scripted-openai-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(here, "../fixtures/real-sdk-regressions-extension/regressions-e2e.ts");
const IPC_LOG = join(tmpdir(), `pivis-unified-steering-${process.pid}.jsonl`);

type Owner = { hostInstanceId: string; sessionEpoch: number };
type Attach = { status: string; baseline?: { owner: Owner } };
type LogEntry = {
  channel?: string;
  payload?: {
    sessionId?: string;
    rendererGeneration?: number;
    expectedOwner?: Owner;
    intent?: { kind?: string; text?: string; surface?: string };
  };
};
type PivisBridge = { invoke(channel: string, args: unknown): Promise<unknown> };

const readIpcLog = (): LogEntry[] =>
  fs
    .readFileSync(IPC_LOG, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as LogEntry] : [];
      } catch {
        return [];
      }
    });

async function invoke(page: Page, channel: string, args: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ channel, args }) =>
      (window as unknown as { pivis: PivisBridge }).pivis.invoke(channel, args),
    { channel, args },
  );
}

async function fixtureIdentity(): Promise<{ sessionId: string; generation: number }> {
  await expect
    .poll(
      () => {
        const entries = readIpcLog();
        const sessionId = entries.filter((entry) => entry.channel === "session.activate").at(-1)
          ?.payload?.sessionId;
        const generation = entries
          .filter((entry) => entry.channel === "session.authorityAttach")
          .at(-1)?.payload?.rendererGeneration;
        return sessionId && generation ? { sessionId, generation } : undefined;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  const entries = readIpcLog();
  const sessionId = entries.filter((entry) => entry.channel === "session.activate").at(-1)
    ?.payload?.sessionId;
  const generation = entries.filter((entry) => entry.channel === "session.authorityAttach").at(-1)
    ?.payload?.rendererGeneration;
  if (!sessionId || !generation) throw new Error("missing real authority IPC identity");
  return { sessionId, generation };
}

async function readyAttach(page: Page, sessionId: string, generation: number): Promise<Attach> {
  let response: Attach | undefined;
  await expect
    .poll(
      async () => {
        response = (await invoke(page, "session.authorityAttach", {
          sessionId,
          rendererGeneration: generation,
        })) as Attach;
        return response.status;
      },
      { timeout: 45_000 },
    )
    .toBe("ready");
  if (!response?.baseline) throw new Error("ready authority attach had no baseline");
  return response;
}

function steeringDispatches(): LogEntry[] {
  return readIpcLog().filter(
    (entry) =>
      entry.channel === "session.dispatchIntent" &&
      entry.payload?.intent?.kind === "submit" &&
      entry.payload.intent.text === "UNIFIED-STEERING",
  );
}

async function closeFixture(
  launch: RealSdkLaunch | undefined,
  fixture: RealSdkFixture,
  provider: ScriptedOpenAIProvider,
): Promise<void> {
  await launch?.close();
  await provider.close();
  fixture.cleanup();
}

async function withDiagnostics(
  error: unknown,
  fixture: RealSdkFixture,
  launch: RealSdkLaunch | undefined,
  provider: ScriptedOpenAIProvider,
): Promise<Error> {
  const ipcLog = fs.existsSync(IPC_LOG) ? fs.readFileSync(IPC_LOG, "utf8") : "<none>";
  const diagnosticLog = join(fixture.dirs.settings, "diagnostics.log");
  const diagnostics = fs.existsSync(diagnosticLog)
    ? fs.readFileSync(diagnosticLog, "utf8")
    : "<none>";
  return new Error(
    `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}\nDiagnostics log:\n${diagnostics}\nIPC invocations:\n${ipcLog}\nProvider requests:\n${JSON.stringify(provider.requests, null, 2)}`,
  );
}

test("Unified TUI admits a steering prompt without retiring its live host", async () => {
  test.setTimeout(180_000);
  fs.rmSync(IPC_LOG, { force: true });
  const provider = await createScriptedOpenAIProvider(
    [
      {
        expect: { promptIncludes: "UNIFIED-PRIMARY", compaction: false },
        response: {
          type: "text",
          chunks: ["UNIFIED-FIRST-CHUNK", "UNIFIED-FIRST-DONE"],
          afterFirstChunkGate: "hold-first-turn",
        },
      },
      {
        expect: {
          promptIncludes: ["UNIFIED-PRIMARY", "UNIFIED-STEERING"],
          compaction: false,
        },
        response: { type: "text", chunks: ["UNIFIED-STEERING-DONE"] },
      },
    ],
    { latency: REAL_SDK_PROVIDER_LATENCY },
  );
  const fixture = createRealSdkFixture({
    providerBaseUrl: provider.baseUrl,
    extensionFiles: [EXTENSION],
    ipcInvocationLog: IPC_LOG,
  });
  let launch: RealSdkLaunch | undefined;
  try {
    launch = await fixture.launch();
    const { window } = launch;
    await window.getByRole("button", { name: "New session" }).click();
    const panel = window.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel).toHaveAttribute("data-sync-state", "following", { timeout: 60_000 });
    await expect(panel).toHaveAttribute("data-input-enabled", "true", { timeout: 60_000 });

    await window.getByRole("tab", { name: "Input" }).click();
    const textarea = window.locator(".composer__textarea");
    await expect(textarea).toBeVisible();
    await selectLocalTestModel(window, textarea);

    // Start the turn from the native surface so this gate isolates the
    // streaming-time Unified submission rather than testing initial Enter.
    await textarea.fill("UNIFIED-PRIMARY");
    await textarea.press("Enter");
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(1);
    await expect(window.getByText("UNIFIED-FIRST-CHUNK", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const { sessionId, generation } = await fixtureIdentity();
    const beforeSubmit = await readyAttach(window, sessionId, generation);

    await window.getByRole("tab", { name: "Extension" }).click();
    await expect(panel).toHaveAttribute("data-sync-state", "following", { timeout: 30_000 });
    await expect(panel).toHaveAttribute("data-input-enabled", "true", { timeout: 30_000 });
    const helper = panel.locator(".xterm-helper-textarea");
    await panel.locator(".xterm").click();
    await expect(helper).toBeFocused();
    await window.keyboard.type("UNIFIED-STEERING");
    await window.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await expect(window.getByText(/Host process exited/)).toHaveCount(0);
    await expect.poll(() => steeringDispatches().length, { timeout: 30_000 }).toBe(1);
    expect(steeringDispatches()[0]?.payload).toMatchObject({
      expectedOwner: beforeSubmit.baseline?.owner,
      intent: { kind: "submit", text: "UNIFIED-STEERING", surface: "unified" },
    });
    const afterSubmit = await readyAttach(window, sessionId, generation);
    expect(afterSubmit.baseline?.owner).toEqual(beforeSubmit.baseline?.owner);

    provider.releaseGate("hold-first-turn");
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(2);
    await expect(window.getByText("UNIFIED-STEERING-DONE", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel).toBeVisible();
    const afterCompletion = await readyAttach(window, sessionId, generation);
    expect(afterCompletion.baseline?.owner).toEqual(beforeSubmit.baseline?.owner);
    expect(steeringDispatches()).toHaveLength(1);
    provider.assertExhausted();
  } catch (error) {
    throw await withDiagnostics(error, fixture, launch, provider);
  } finally {
    await closeFixture(launch, fixture, provider);
    fs.rmSync(IPC_LOG, { force: true });
  }
});

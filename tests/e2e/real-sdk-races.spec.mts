import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/invariants.mjs";
import {
  REAL_SDK_PROVIDER_LATENCY,
  assertValidSessionJsonl,
  createRealSdkFixture,
  openNewRealSession,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import { createScriptedOpenAIProvider } from "./support/scripted-openai-provider.mjs";

type Owner = { hostInstanceId: string; sessionEpoch: number };
type Attach = { status: string; baseline?: { rendererGeneration: number; owner: Owner } };
type LogEntry = { channel?: string; payload?: { sessionId?: string; rendererGeneration?: number } };
type PivisBridge = { invoke(channel: string, args: unknown): Promise<unknown> };

const readLog = (file: string): LogEntry[] =>
  fs
    .readFileSync(file, "utf8")
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

async function slash(textarea: Locator, command: string): Promise<void> {
  await textarea.fill(command);
  await textarea.press("Escape");
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("");
}

async function fixtureIdentity(
  logFile: string,
): Promise<{ sessionId: string; generation: number }> {
  await expect
    .poll(
      () => {
        const entries = readLog(logFile);
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
  const entries = readLog(logFile);
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

async function focusStorm(page: Page, textarea: Locator): Promise<void> {
  // Deliberately focus real interactive surfaces while lifecycle commands are
  // in flight. The important assertion is the IPC attach budget below, not
  // that a synthetic focus event happened to fire.
  const sidebar = page.locator(".sidebar__session--active").first();
  for (let index = 0; index < 16; index++) {
    await (index % 2 === 0 ? textarea : sidebar).focus();
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  }
}

test.describe("real Pi races", () => {
  test("racing /new survives a focus storm with bounded authority attaches and provider recovery", async () => {
    test.setTimeout(240_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "race establishing turn", compaction: false },
          response: { type: "text", chunks: ["RACE-ESTABLISHED"] },
        },
        {
          expect: { promptIncludes: "race successor turn", compaction: false },
          response: { type: "text", chunks: ["RACE-SUCCESSOR"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const directory = fs.mkdtempSync(join(os.tmpdir(), "pivis-real-races-"));
    const logFile = join(directory, "ipc.jsonl");
    fs.writeFileSync(logFile, "");
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      ipcInvocationLog: logFile,
    });
    let launch: Awaited<ReturnType<typeof fixture.launch>> | undefined;
    try {
      launch = await fixture.launch();
      const textarea = await openNewRealSession(launch.window);
      await selectLocalTestModel(launch.window, textarea);
      await textarea.fill("race establishing turn");
      await textarea.press("Enter");
      await expect(launch.window.getByText("RACE-ESTABLISHED", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const { sessionId, generation } = await fixtureIdentity(logFile);
      const before = readLog(logFile).filter(
        (entry) => entry.channel === "session.authorityAttach",
      ).length;

      const predecessor = await readyAttach(launch.window, sessionId, generation);
      if (!predecessor.baseline) throw new Error("predecessor attach omitted its baseline");
      await launch.window.evaluate(() => {
        const target = window as unknown as { __raceFileChanges?: unknown[] };
        target.__raceFileChanges = [];
        window.pivis.on("session.fileChanged", (event) => target.__raceFileChanges?.push(event));
      });
      // Exercise the actual Composer /new path. Focus events overlap the
      // child-owned transition so every attach trigger still funnels through
      // the bounded single-flight coordinator.
      await textarea.fill("/new");
      await textarea.press("Escape");
      await textarea.press("Enter");
      // /new may retain its predecessor editor text until the successor
      // terminal frame commits; admission-time clearing is asserted separately
      // for intent-shaped commands such as /compact.
      await focusStorm(launch.window, textarea);
      let recovered: Attach | undefined;
      await expect
        .poll(
          async () => {
            const candidate = await readyAttach(launch!.window, sessionId, generation);
            if (
              candidate.baseline &&
              candidate.baseline.owner.sessionEpoch > predecessor!.baseline!.owner.sessionEpoch
            ) {
              recovered = candidate;
            }
            return recovered?.baseline?.owner.sessionEpoch;
          },
          { timeout: 60_000 },
        )
        .toBeGreaterThan(predecessor.baseline.owner.sessionEpoch);
      expect(recovered?.baseline?.owner.hostInstanceId).toBeTruthy();
      await expect
        .poll(
          () =>
            launch!.window.evaluate(
              () =>
                (window as unknown as { __raceFileChanges?: unknown[] }).__raceFileChanges
                  ?.length ?? 0,
            ),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      await expect(launch.window.getByText("RACE-ESTABLISHED", { exact: true })).toBeHidden();

      // Prove the successor is usable rather than merely observing an epoch
      // counter: one new prompt reaches Pi once after the transition.
      const successorTextarea = launch.window.locator(".composer__textarea");
      await selectLocalTestModel(launch.window, successorTextarea);
      await successorTextarea.fill("race successor turn");
      await successorTextarea.press("Enter");
      await expect(launch.window.getByText("RACE-SUCCESSOR", { exact: true })).toBeVisible({
        timeout: 60_000,
      });

      // Bounded recovery is asserted at the main IPC seam. A focus storm must
      // not become one attach per focus event.
      const after = readLog(logFile).filter(
        (entry) => entry.channel === "session.authorityAttach",
      ).length;
      expect(after - before).toBeLessThanOrEqual(8);

      expect(provider.requests).toHaveLength(2);
      expect(provider.unexpectedRequests).toEqual([]);
      assertValidSessionJsonl(fixture.sessionFiles());
      provider.assertExhausted();
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nProvider requests:\n${JSON.stringify(provider.requests, null, 2)}`,
      );
    } finally {
      await launch?.close();
      await provider.close();
      fixture.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("racing /reload stays attached through a bounded focus storm", async () => {
    test.setTimeout(120_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "reload race seed", compaction: false },
          response: { type: "text", chunks: ["RELOAD-RACE-SEED"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const directory = fs.mkdtempSync(join(os.tmpdir(), "pivis-reload-race-"));
    const logFile = join(directory, "ipc.jsonl");
    fs.writeFileSync(logFile, "");
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      ipcInvocationLog: logFile,
    });
    let launch: Awaited<ReturnType<typeof fixture.launch>> | undefined;
    try {
      launch = await fixture.launch();
      const textarea = await openNewRealSession(launch.window);
      await selectLocalTestModel(launch.window, textarea);
      await textarea.fill("reload race seed");
      await textarea.press("Enter");
      await expect(launch.window.getByText("RELOAD-RACE-SEED", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const { sessionId, generation } = await fixtureIdentity(logFile);
      await expect(launch.window.locator(".working-row, .status-dot--streaming")).toHaveCount(0);
      const before = readLog(logFile).filter(
        (entry) => entry.channel === "session.authorityAttach",
      ).length;
      const predecessor = await readyAttach(launch.window, sessionId, generation);
      const attaching = readyAttach(launch.window, sessionId, generation);
      await textarea.fill("/reload");
      await textarea.press("Escape");
      await textarea.press("Enter");
      // Command custody is observed through the concurrently active attach;
      // a transition may replace this editor before its old DOM value clears.
      await focusStorm(launch.window, textarea);
      await attaching.catch(() => undefined);
      const recovered = await readyAttach(launch.window, sessionId, generation);
      expect(recovered.baseline!.owner.hostInstanceId).toBe(
        predecessor.baseline!.owner.hostInstanceId,
      );
      expect(recovered.baseline!.owner.sessionEpoch).toBeGreaterThan(
        predecessor.baseline!.owner.sessionEpoch,
      );
      const after = readLog(logFile).filter(
        (entry) => entry.channel === "session.authorityAttach",
      ).length;
      expect(after - before).toBeLessThanOrEqual(8);
      expect(provider.requests).toHaveLength(1);
      provider.assertExhausted();
      assertValidSessionJsonl(fixture.sessionFiles());
    } finally {
      await launch?.close();
      await provider.close();
      fixture.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("/compact clears on admission while an attach races its gated real-Pi completion", async () => {
    test.setTimeout(240_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "attach compact seed one", compaction: false },
          response: { type: "text", chunks: ["ATTACH-COMPACT-ONE"] },
        },
        {
          expect: { promptIncludes: "attach compact seed two", compaction: false },
          response: { type: "text", chunks: ["ATTACH-COMPACT-TWO"] },
        },
        {
          expect: { compaction: { includes: "attach compact seed one" } },
          response: { type: "text", chunks: ["ATTACH-COMPACT-SUMMARY"], gate: "compact" },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const directory = fs.mkdtempSync(join(os.tmpdir(), "pivis-compact-race-"));
    const logFile = join(directory, "ipc.jsonl");
    fs.writeFileSync(logFile, "");
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      compactionEnabled: false,
      ipcInvocationLog: logFile,
      // Hold this test-controlled attach across admission; it is delivered
      // only after the gated provider response can settle compaction.
      faultPlan: {
        outbound: [
          {
            action: "delay",
            match: { type: "authority_attach", nth: 2 },
            delayMs: 1_500,
          },
        ],
      },
    });
    let launch: Awaited<ReturnType<typeof fixture.launch>> | undefined;
    try {
      launch = await fixture.launch();
      const textarea = await openNewRealSession(launch.window);
      await selectLocalTestModel(launch.window, textarea);
      for (const seed of ["attach compact seed one", "attach compact seed two"]) {
        await textarea.fill(`${seed} ${"context ".repeat(250)}`);
        await textarea.press("Enter");
        await expect(
          launch.window.getByText(
            seed === "attach compact seed one" ? "ATTACH-COMPACT-ONE" : "ATTACH-COMPACT-TWO",
            { exact: true },
          ),
        ).toBeVisible({ timeout: 60_000 });
      }
      const { sessionId, generation } = await fixtureIdentity(logFile);
      await textarea.fill("/compact");
      await textarea.press("Enter");
      await provider.waitForRequestCount(3);
      // Admission is proven before releasing the provider gate: the command
      // is no longer editable and exactly one compaction has crossed HTTP.
      await expect(textarea).toHaveValue("");
      const attaching = readyAttach(launch.window, sessionId, generation);
      expect(provider.requests).toHaveLength(3);
      provider.releaseGate("compact");
      await attaching;
      await expect
        .poll(() =>
          fixture
            .sessionFiles()
            .some((file) => fs.readFileSync(file, "utf8").includes("ATTACH-COMPACT-SUMMARY")),
        )
        .toBe(true);
      await expect(launch.window.locator(".working-row, .status-dot--streaming")).toHaveCount(0);
      expect(provider.requests).toHaveLength(3);
      expect(provider.unexpectedRequests).toEqual([]);
      assertValidSessionJsonl(fixture.sessionFiles());
      provider.assertExhausted();
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nProvider requests:\n${JSON.stringify(provider.requests, null, 2)}`,
      );
    } finally {
      await launch?.close();
      await provider.close();
      fixture.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("gated real-Pi streaming silent close leaves no tab or dialog and persists valid JSONL", async () => {
    test.setTimeout(120_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "silent-close-stream", compaction: false },
          response: {
            type: "disconnect",
            chunks: ["SILENT-CLOSE-PARTIAL"],
            disconnectGate: "close",
          },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({ providerBaseUrl: provider.baseUrl });
    let launch: Awaited<ReturnType<typeof fixture.launch>> | undefined;
    try {
      launch = await fixture.launch();
      const textarea = await openNewRealSession(launch.window);
      await selectLocalTestModel(launch.window, textarea);
      await textarea.fill("silent-close-stream");
      await textarea.press("Enter");
      await provider.waitForRequestCount(1);
      await expect(launch.window.getByText("SILENT-CLOSE-PARTIAL", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      // /quit is the real renderer tab-close path (not a Playwright page
      // teardown); it must detach the active session without a native dialog.
      await textarea.fill("/quit");
      await textarea.press("Escape");
      await textarea.press("Enter");
      await expect.poll(() => launch!.window.locator(".sidebar__session--active").count()).toBe(0);
      await expect(launch.window.locator(".composer__textarea")).toHaveCount(0);
      provider.releaseGate("close");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assertValidSessionJsonl(fixture.sessionFiles());
      expect(provider.requests).toHaveLength(1);
      expect(provider.unexpectedRequests).toEqual([]);
      provider.assertExhausted();
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nProvider requests:\n${JSON.stringify(provider.requests, null, 2)}`,
      );
    } finally {
      await launch?.close();
      await provider.close();
      fixture.cleanup();
    }
  });
});

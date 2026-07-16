import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { allowInvariant, expect, test } from "./support/invariants.mjs";
import {
  REAL_SDK_PROVIDER_LATENCY,
  type RealSdkFixture,
  type RealSdkLaunch,
  createRealSdkFixture,
  openNewRealSession,
  parseSessionEntries,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import {
  type ScriptedOpenAIProvider,
  createScriptedOpenAIProvider,
} from "./support/scripted-openai-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const LIFECYCLE_EXTENSION = join(
  here,
  "../fixtures/real-host-lifecycle-extension/lifecycle-e2e.ts",
);

async function closeFixture(
  launch: RealSdkLaunch | undefined,
  fixture: RealSdkFixture,
  provider?: ScriptedOpenAIProvider,
): Promise<void> {
  await launch?.close();
  await provider?.close();
  fixture.cleanup();
}

async function failureWithDiagnostics(
  error: unknown,
  fixture: RealSdkFixture,
  launch?: RealSdkLaunch,
  provider?: ScriptedOpenAIProvider,
): Promise<Error> {
  const diagnostics = await fixture.diagnostics(launch?.window);
  return new Error(
    `${String(error)}\n${diagnostics}\nElectron output:\n${launch?.output.join("") ?? "<none>"}\nProvider requests:\n${JSON.stringify(
      provider?.requests ?? [],
      null,
      2,
    )}\nUnexpected provider requests:\n${JSON.stringify(provider?.unexpectedRequests ?? [], null, 2)}`,
  );
}

async function submitSlash(textarea: Locator, command: string): Promise<void> {
  await textarea.fill(command);
  await textarea.press("Enter");
}

async function expectIdle(page: Page): Promise<void> {
  await expect(page.locator(".status-dot--streaming")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".working-row")).toHaveCount(0, { timeout: 30_000 });
}

async function restoreStoredSession(page: Page, expectedText: string): Promise<void> {
  const alreadyVisible = page.getByText(expectedText, { exact: false });
  if ((await alreadyVisible.count()) > 0) return;
  const stored = page.locator(".sidebar__session:not(.sidebar__session--active)");
  await expect(stored.first()).toBeVisible({ timeout: 30_000 });
  const matching = stored.filter({ hasText: expectedText });
  await ((await matching.count()) > 0 ? matching.first() : stored.first()).click();
  await expect(page.getByText(expectedText, { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  });
}

test.describe("Pinned real Pi transcript lifecycle", () => {
  test("composer keyboard semantics and real extension slash surfaces preserve editor custody", async () => {
    test.setTimeout(180_000);
    const fixture = createRealSdkFixture({ extensionFiles: [LIFECYCLE_EXTENSION] });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      const { window } = launch;
      const textarea = await openNewRealSession(window);

      await test.step("non-submitting Enter variants preserve text", async () => {
        await textarea.fill("   ");
        await textarea.press("Enter");
        await expect(textarea).toHaveValue("   ");
        await expect(window.locator(".transcript-block--user")).toHaveCount(0);

        await textarea.fill("line one");
        await textarea.press("Shift+Enter");
        await expect(textarea).toHaveValue("line one\n");
        await textarea.type("line two");
        await expect(textarea).toHaveValue("line one\nline two");

        await textarea.fill("ime candidate");
        await textarea.evaluate((element) => {
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
              cancelable: true,
              isComposing: true,
            }),
          );
        });
        await expect(textarea).toHaveValue("ime candidate");
        await expect(window.getByText("No model selected", { exact: true })).toHaveCount(0);
        await textarea.fill("");
      });

      const stagedFile = join(fixture.dirs.workspace, "staged-context.txt");
      fs.writeFileSync(stagedFile, "staged extension context\n");
      await window.locator(".composer__file-input").setInputFiles(stagedFile);
      const stagedTile = window.locator(".composer__attachment-item--file");
      await expect(stagedTile).toContainText("staged-context.txt");

      await test.step("fire-and-forget extension UI is real and command-only", async () => {
        await submitSlash(textarea, "/e2e-notify");
        await expect(textarea).toHaveValue("");
        await expect(window.getByText("e2e lifecycle notification", { exact: true })).toBeVisible();
        await expect(stagedTile).toHaveCount(1);

        await submitSlash(textarea, "/e2e-status-on");
        await expect(
          window.locator(".statusbar__line").filter({ hasText: "e2e lifecycle status enabled" }),
        ).toHaveCount(1);
        await submitSlash(textarea, "/e2e-widget-on");
        await expect(window.locator(".dock__widget-line")).toHaveText([
          "e2e lifecycle widget enabled",
        ]);
        await submitSlash(textarea, "/e2e-widget-off");
        await expect(window.locator(".dock__widget-line")).toHaveCount(0);
        await submitSlash(textarea, "/e2e-status-off");
        await expect(
          window.locator(".statusbar__line").filter({ hasText: "e2e lifecycle status enabled" }),
        ).toHaveCount(0);
        await expect(stagedTile).toHaveCount(1);
      });

      await test.step("all blocking dialog forms settle against the originating command", async () => {
        await submitSlash(textarea, "/e2e-select");
        const select = window.locator(".ext-dialog");
        await expect(select).toContainText("E2E select dialog");
        await select.locator(".ext-dialog__option").nth(1).click();
        await expect(select).toBeHidden({ timeout: 30_000 });
        await expect(
          window.getByText("e2e select result: e2e-option-beta", { exact: true }),
        ).toBeVisible({ timeout: 30_000 });

        await submitSlash(textarea, "/e2e-confirm");
        const confirm = window.locator(".ext-dialog");
        await expect(confirm).toContainText("E2E confirm dialog");
        await confirm.getByRole("button", { name: "Confirm" }).click();
        await expect(confirm).toBeHidden({ timeout: 30_000 });
        await expect(
          window.getByText("e2e confirm result: confirmed", { exact: true }),
        ).toBeVisible({ timeout: 30_000 });

        await submitSlash(textarea, "/e2e-input");
        const input = window.locator(".ext-dialog__input");
        await input.fill("typed dialog value");
        await input.press("Enter");
        await expect(window.locator(".ext-dialog")).toBeHidden({ timeout: 30_000 });
        await expect(
          window.getByText("e2e input result: typed dialog value", { exact: true }),
        ).toBeVisible({ timeout: 30_000 });

        await submitSlash(textarea, "/e2e-editor");
        const editor = window.locator(".ext-dialog__editor");
        await expect(editor).toHaveValue("e2e editor line 1\ne2e editor line 2");
        await editor.fill("edited line 1\nedited line 2");
        await window.locator(".ext-dialog").getByRole("button", { name: "OK" }).click();
        await expect(window.locator(".ext-dialog")).toBeHidden({ timeout: 30_000 });
        await expect(
          window.getByText("e2e editor result: edited line 1\nedited line 2", { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(stagedTile).toHaveCount(1);
      });

      await test.step("custom records render, errors are surfaced, and host editor mutation wins", async () => {
        await submitSlash(textarea, "/e2e-custom-message");
        await expect(window.getByText("e2e visible custom message", { exact: true })).toBeVisible();

        await submitSlash(textarea, "/e2e-custom-entry");
        await expect(
          window.getByText(/E2E persisted entry: e2e persisted lifecycle entry/),
        ).toBeVisible({ timeout: 30_000 });

        allowInvariant("error-toast", "e2e lifecycle command error");
        await submitSlash(textarea, "/e2e-throw");
        const showNotifications = window.getByRole("button", { name: "Show notifications" });
        await expect(showNotifications).toBeVisible({ timeout: 30_000 });
        await showNotifications.click();
        const extensionError = window
          .locator('article[aria-label="Error notification"]')
          .filter({ hasText: "e2e lifecycle command error" });
        await expect(extensionError).toHaveCount(1);
        await expect(extensionError).toContainText("e2e lifecycle command error");
        await window.getByRole("button", { name: "Hide notifications" }).click();
        await expect(textarea).toHaveValue("");

        await submitSlash(textarea, "/e2e-set-editor-text");
        await expect(textarea).toHaveValue("e2e lifecycle editor text", { timeout: 15_000 });
        await expect(stagedTile).toHaveCount(1);
        await expect(window.locator(".transcript-block--user")).toHaveCount(0);
        await expect(window.getByText(/Host process exited/)).toHaveCount(0);
      });
    } catch (error) {
      throw await failureWithDiagnostics(error, fixture, launch);
    } finally {
      await closeFixture(launch, fixture);
    }
  });

  test("ordinary turns, exact duplicate admission, transformed echoes, tools, errors, and reload stay coherent", async () => {
    test.setTimeout(300_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: {
            model: "pivis-test-model",
            promptIncludes: ["staged-prompt.txt", "[[E2E_LIFECYCLE_TRANSFORMED]]"],
            compaction: false,
          },
          response: {
            type: "text",
            chunks: ["first streamed ", "assistant response"],
            afterFirstChunkGate: "first-turn",
          },
        },
        {
          expect: { promptIncludes: "exact duplicate payload", compaction: false },
          response: { type: "text", chunks: ["duplicate accepted once"], gate: "duplicate-turn" },
        },
        {
          expect: { promptIncludes: "exact duplicate payload", compaction: false },
          response: { type: "text", chunks: ["same payload accepted after settlement"] },
        },
        {
          expect: {
            promptIncludes: "invoke the deterministic lifecycle tool",
            toolNames: ["e2e-lifecycle-tool"],
            compaction: false,
          },
          response: {
            type: "tool_call",
            name: "e2e-lifecycle-tool",
            id: "call_e2e_lifecycle",
            argumentChunks: ['{"value":"', "from-provider", '"}'],
          },
        },
        {
          expect: {
            promptIncludes: ["e2e-tool-adjacent-first", "e2e-tool-adjacent-second:from-provider"],
            compaction: false,
          },
          response: { type: "text", chunks: ["tool continuation complete"] },
        },
        {
          expect: { promptIncludes: "partial disconnect turn", compaction: false },
          response: {
            type: "disconnect",
            chunks: ["partial output before disconnect"],
            disconnectGate: "partial-disconnect",
          },
        },
        {
          expect: { promptIncludes: "terminal provider failure turn", compaction: false },
          response: {
            type: "error",
            status: 500,
            message: "e2e scripted terminal provider failure",
            errorType: "api_error",
          },
        },
        {
          expect: { promptIncludes: "recovery after provider failure", compaction: false },
          response: { type: "text", chunks: ["provider recovery complete"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      extensionFiles: [LIFECYCLE_EXTENSION],
    });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      const { window } = launch;
      const textarea = await openNewRealSession(window);
      await selectLocalTestModel(window, textarea);

      const stagedFile = join(fixture.dirs.workspace, "staged-prompt.txt");
      fs.writeFileSync(stagedFile, "real Pi staged prompt fixture\n");
      await window.locator(".composer__file-input").setInputFiles(stagedFile);
      await submitSlash(textarea, "/e2e-notify");
      await expect(window.locator(".composer__attachment-item--file")).toHaveCount(1);

      await test.step("Enter transfers text and attachments only after real Pi accepts custody", async () => {
        await textarea.fill("first [[E2E_LIFECYCLE_TRANSFORM_MARKER]] prompt");
        await textarea.press("Enter");
        await provider.waitForRequestCount(1);
        await expect(textarea).toHaveValue("");
        await expect(window.locator(".composer__attachment-item--file")).toHaveCount(0);
        await expect(window.locator(".working-row, .status-dot--streaming").first()).toBeVisible();
        await expect(
          window.locator(".transcript-block--assistant").filter({ hasText: "first streamed" }),
        ).toHaveCount(1, { timeout: 30_000 });
        await expect(
          window.getByText("first streamed assistant response", { exact: true }),
        ).toHaveCount(0);
        expect(provider.requests).toHaveLength(1);
        provider.releaseGate("first-turn");
        await expect(
          window.getByText("first streamed assistant response", { exact: true }),
        ).toBeVisible({
          timeout: 60_000,
        });
        await expectIdle(window);
        await expect(
          window
            .locator(".transcript-block--user")
            .filter({ hasText: "[[E2E_LIFECYCLE_TRANSFORMED]]" }),
        ).toHaveCount(1);
      });

      await test.step("two physical Enter events while one payload is in flight dispatch once", async () => {
        await textarea.fill("exact duplicate payload");
        await textarea.press("Enter");
        await textarea.press("Enter");
        await provider.waitForRequestCount(2);
        expect(provider.requests).toHaveLength(2);
        provider.releaseGate("duplicate-turn");
        await expect(window.getByText("duplicate accepted once", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await expectIdle(window);
        await expect(
          window.locator(".transcript-block--user").filter({ hasText: "exact duplicate payload" }),
        ).toHaveCount(1);

        await textarea.fill("exact duplicate payload");
        await textarea.press("Enter");
        await expect(
          window.getByText("same payload accepted after settlement", { exact: true }),
        ).toBeVisible({ timeout: 60_000 });
        await expect(
          window.locator(".transcript-block--user").filter({ hasText: "exact duplicate payload" }),
        ).toHaveCount(2);
      });

      await test.step("a real Pi extension tool has one settled card with complete final data", async () => {
        await textarea.fill("invoke the deterministic lifecycle tool now");
        await textarea.press("Enter");
        const toolCard = window
          .locator(".tool-card")
          .filter({ hasText: "e2e-lifecycle-tool" })
          .first();
        await expect(toolCard).toBeVisible({ timeout: 60_000 });
        await expect(window.getByText("tool continuation complete", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await expect(toolCard.locator(".tool-card__spinner")).toHaveCount(0);
        await toolCard.locator("button.tool-card__header").click();
        await expect(toolCard).toContainText("e2e-tool-adjacent-first");
        await expect(toolCard).toContainText("e2e-tool-adjacent-second:from-provider");
        await expect(toolCard.locator(".diff-block__line--del")).toContainText("- before");
        await expect(toolCard.locator(".diff-block__line--add")).toContainText("+ after");
      });

      await test.step("partial and empty provider failures stay visible without wedging the next turn", async () => {
        await textarea.fill("partial disconnect turn");
        await textarea.press("Enter");
        await expect(
          window
            .locator(".transcript-block--assistant")
            .filter({ hasText: "partial output before disconnect" }),
        ).toHaveCount(1, { timeout: 60_000 });
        provider.releaseGate("partial-disconnect");
        await expect(window.getByRole("alert").last()).toContainText("Model response failed", {
          timeout: 60_000,
        });
        await expect(textarea).toHaveValue("");
        await expectIdle(window);

        await textarea.fill("terminal provider failure turn");
        await textarea.press("Enter");
        const alert = window.getByRole("alert").last();
        await expect(alert).toContainText("Model response failed", { timeout: 60_000 });
        await expect(alert).toContainText("e2e scripted terminal provider failure");
        await expect(textarea).toHaveValue("");
        await expectIdle(window);

        await textarea.fill("recovery after provider failure");
        await textarea.press("Enter");
        await expect(window.getByText("provider recovery complete", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await expectIdle(window);
      });

      provider.assertExhausted();
      expect(provider.unexpectedRequests).toEqual([]);
      await expect.poll(() => fixture.sessionFiles().length).toBeGreaterThan(0);
      const entries = fixture.sessionFiles().flatMap(parseSessionEntries);
      expect(entries.filter((entry) => entry.type === "message").length).toBeGreaterThanOrEqual(10);

      await launch.close();
      launch = await fixture.launch();
      await restoreStoredSession(launch.window, "tool continuation complete");
      const reloadedTool = launch.window
        .locator(".tool-card")
        .filter({ hasText: "e2e-lifecycle-tool" })
        .first();
      await expect(reloadedTool.locator(".tool-card__spinner")).toHaveCount(0);
      await reloadedTool.locator("button.tool-card__header").click();
      await expect(reloadedTool).toContainText("e2e-tool-adjacent-first");
      await expect(reloadedTool).toContainText("e2e-tool-adjacent-second:from-provider");
      await expect(
        launch.window
          .locator(".transcript-block--user")
          .filter({ hasText: "[[E2E_LIFECYCLE_TRANSFORMED]]" }),
      ).toHaveCount(1);
      await expect(
        launch.window.getByText("provider recovery complete", { exact: true }),
      ).toHaveCount(1);
    } catch (error) {
      throw await failureWithDiagnostics(error, fixture, launch, provider);
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });

  test("streaming queue ownership restores directly to the composer on Escape and never dispatches twice", async () => {
    test.setTimeout(180_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "hold the first streaming turn", compaction: false },
          response: { type: "text", chunks: ["must not appear after interruption"], gate: "held" },
        },
        {
          expect: { promptIncludes: "recovery after interruption", compaction: false },
          response: { type: "text", chunks: ["interrupt recovery complete"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      extensionFiles: [LIFECYCLE_EXTENSION],
    });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      const { window } = launch;
      const textarea = await openNewRealSession(window);
      await selectLocalTestModel(window, textarea);
      await window.evaluate(() => {
        const target = window as unknown as { __e2ePublications: unknown[] };
        target.__e2ePublications = [];
        window.pivis.on("session.publication", (publication) => {
          target.__e2ePublications.push(publication);
        });
      });

      await textarea.fill("hold the first streaming turn");
      await textarea.press("Enter");
      await provider.waitForRequestCount(1);
      await expect(window.locator(".working-row, .status-dot--streaming").first()).toBeVisible();

      // A handled extension command reports successful prompt preflight but
      // creates no Pi queue slot. Its temporary claim must retire before the
      // following ordinary prompt becomes visible in the queue getter.
      await submitSlash(textarea, "/e2e-notify");
      await expect(window.getByText("e2e lifecycle notification", { exact: true })).toBeVisible();
      expect(provider.requests).toHaveLength(1);

      const queuedText = "queued steering must have one owner";
      await textarea.fill(queuedText);
      await textarea.press("Enter");
      const visibleOwners = window
        .locator(".transcript-block--user, .queued-bubble__content")
        .filter({ hasText: queuedText });
      await expect(visibleOwners).toHaveCount(1, { timeout: 30_000 });
      expect(provider.requests).toHaveLength(1);

      await window.keyboard.press("Escape");
      await expect(textarea).toHaveValue(queuedText, { timeout: 30_000 });
      await expect(window.getByText(/Review interrupted (message|command)/)).toHaveCount(0);
      const restorationEvents = await window.evaluate(() => {
        const target = window as unknown as { __e2ePublications: unknown[] };
        const semanticSnapshots = target.__e2ePublications.flatMap((publication) => {
          if (!publication || typeof publication !== "object") return [];
          const payload = (publication as { payload?: unknown }).payload;
          if (!payload || typeof payload !== "object") return [];
          const snapshot = (payload as { terminalSnapshot?: unknown }).terminalSnapshot;
          return snapshot ? [snapshot] : [];
        });
        const queueRecords = target.__e2ePublications.flatMap((publication) => {
          if (!publication || typeof publication !== "object") return [];
          const payload = (publication as { payload?: unknown }).payload;
          if (!payload || typeof payload !== "object") return [];
          const records = (payload as { records?: unknown }).records;
          return Array.isArray(records)
            ? records.filter(
                (record) =>
                  !!record &&
                  typeof record === "object" &&
                  (record as { type?: unknown }).type === "queue_restoration",
              )
            : [];
        });
        return { queueRecords, semanticSnapshots };
      });
      if (
        !restorationEvents.queueRecords.some(
          (record) =>
            !!record &&
            typeof record === "object" &&
            Array.isArray((record as { clearedIntentIds?: unknown }).clearedIntentIds) &&
            ((record as { clearedIntentIds: unknown[] }).clearedIntentIds.length ?? 0) > 0,
        )
      ) {
        throw new Error(`Queue identity was not restored: ${JSON.stringify(restorationEvents)}`);
      }
      expect(restorationEvents.queueRecords).toEqual([
        expect.objectContaining({
          type: "queue_restoration",
          steering: [queuedText],
          clearedIntentIds: [expect.any(String)],
        }),
      ]);
      await expect(visibleOwners).toHaveCount(0);
      expect(provider.requests).toHaveLength(1);
      provider.releaseGate("held");
      await expect(
        window.getByText("must not appear after interruption", { exact: true }),
      ).toHaveCount(0);
      await textarea.fill("recovery after interruption");
      await textarea.press("Enter");
      await expect(window.getByText("interrupt recovery complete", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expectIdle(window);
      provider.assertExhausted();
      expect(provider.requests).toHaveLength(2);
      expect(provider.unexpectedRequests).toEqual([]);
    } catch (error) {
      throw await failureWithDiagnostics(error, fixture, launch, provider);
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });

  test("Escape cancels a real extension tool and a real Pi retry wait without stale work", async () => {
    test.setTimeout(180_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: {
            promptIncludes: "start the cancellable lifecycle tool",
            toolNames: ["e2e-cancellable-tool"],
            compaction: false,
          },
          response: {
            type: "tool_call",
            name: "e2e-cancellable-tool",
            id: "call_e2e_cancellable",
            argumentChunks: ['{"value":"held"}'],
          },
        },
        {
          expect: { promptIncludes: "cancel this retry wait", compaction: false },
          response: {
            type: "error",
            status: 503,
            message: "e2e retry cancellation outage",
            errorType: "service_unavailable_error",
          },
        },
        {
          expect: { promptIncludes: "recovery after cancellation checks", compaction: false },
          response: { type: "text", chunks: ["cancellation recovery complete"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      extensionFiles: [LIFECYCLE_EXTENSION],
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 30_000 },
    });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      const { window } = launch;
      const textarea = await openNewRealSession(window);
      await selectLocalTestModel(window, textarea);
      await window.evaluate(() => {
        const target = window as unknown as { __e2eRetrySnapshots: unknown[] };
        target.__e2eRetrySnapshots = [];
        window.pivis.on("session.publication", (publication) => {
          if (!publication || typeof publication !== "object") return;
          const payload = (publication as { payload?: unknown }).payload;
          if (!payload || typeof payload !== "object") return;
          const snapshot = (payload as { terminalSnapshot?: unknown }).terminalSnapshot;
          if (snapshot) target.__e2eRetrySnapshots.push(snapshot);
        });
      });

      await textarea.fill("start the cancellable lifecycle tool");
      await textarea.press("Enter");
      const toolCard = window
        .locator(".tool-card")
        .filter({ hasText: "e2e-cancellable-tool" })
        .first();
      await expect(toolCard.locator(".tool-card__spinner")).toBeVisible({ timeout: 60_000 });
      await window.keyboard.press("Escape");
      await expect(toolCard.locator(".tool-card__spinner")).toHaveCount(0, { timeout: 30_000 });
      await expect(toolCard).toHaveClass(/tool-card--error/);
      await expectIdle(window);
      expect(provider.requests).toHaveLength(1);

      await textarea.fill("cancel this retry wait");
      await textarea.press("Enter");
      await provider.waitForRequestCount(2);
      await expect
        .poll(
          () =>
            window.evaluate(() => {
              const snapshots = (window as unknown as { __e2eRetrySnapshots: unknown[] })
                .__e2eRetrySnapshots;
              return snapshots.some(
                (snapshot) =>
                  !!snapshot &&
                  typeof snapshot === "object" &&
                  (snapshot as { sdk?: { isRetrying?: unknown } }).sdk?.isRetrying === true,
              );
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
      await window.keyboard.press("Escape");
      await expectIdle(window);
      expect(provider.requests).toHaveLength(2);
      await expect(
        window.locator(".transcript-block--user").filter({ hasText: "cancel this retry wait" }),
      ).toHaveCount(1);

      await textarea.fill("recovery after cancellation checks");
      await textarea.press("Enter");
      await expect(window.getByText("cancellation recovery complete", { exact: true })).toBeVisible(
        {
          timeout: 60_000,
        },
      );
      await expectIdle(window);
      provider.assertExhausted();
      expect(provider.requests).toHaveLength(3);
      expect(provider.unexpectedRequests).toEqual([]);
    } catch (error) {
      throw await failureWithDiagnostics(error, fixture, launch, provider);
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });

  test("real Pi automatic retry preserves one user turn and settles to one successful answer", async () => {
    test.setTimeout(180_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "retry this transient provider failure", compaction: false },
          response: {
            type: "error",
            status: 503,
            message: "e2e transient provider outage",
            errorType: "service_unavailable_error",
          },
        },
        {
          expect: { promptIncludes: "retry this transient provider failure", compaction: false },
          response: { type: "text", chunks: ["automatic retry recovered"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      extensionFiles: [LIFECYCLE_EXTENSION],
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
    });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      const { window } = launch;
      const textarea = await openNewRealSession(window);
      await selectLocalTestModel(window, textarea);

      await textarea.fill("retry this transient provider failure");
      await textarea.press("Enter");
      await expect(window.getByText("automatic retry recovered", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expectIdle(window);
      await expect(
        window
          .locator(".transcript-block--user")
          .filter({ hasText: "retry this transient provider failure" }),
      ).toHaveCount(1);
      await expect(
        window
          .locator(".transcript-block--assistant")
          .filter({ hasText: "automatic retry recovered" }),
      ).toHaveCount(1);
      provider.assertExhausted();
      expect(provider.requests).toHaveLength(2);
      expect(provider.unexpectedRequests).toEqual([]);
    } catch (error) {
      throw await failureWithDiagnostics(error, fixture, launch, provider);
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });
});

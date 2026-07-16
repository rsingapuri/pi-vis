import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
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
const STATIC_DOCK = "REAL-REGRESSION-STATIC-DOCK";
const ABOVE = "REAL-REGRESSION-FACTORY-ABOVE";
const BELOW = "REAL-REGRESSION-FACTORY-BELOW";
const REPLACED = "REAL-REGRESSION-FACTORY-REPLACED";
const CUSTOM = "REAL-REGRESSION-CUSTOM-OVERLAY";
const CUSTOM_DONE = "REAL-REGRESSION-CUSTOM-DONE";
const NAME = "REAL-REGRESSION-EXACT-SESSION-NAME";
const WRONG_COMPACT = "REAL-REGRESSION-WRONG-COMPACT-COLLISION";

async function closeFixture(
  launch: RealSdkLaunch | undefined,
  fixture: RealSdkFixture,
  provider?: ScriptedOpenAIProvider,
): Promise<void> {
  await launch?.close();
  await provider?.close();
  fixture.cleanup();
}

async function withDiagnostics(
  error: unknown,
  fixture: RealSdkFixture,
  launch?: RealSdkLaunch,
  provider?: ScriptedOpenAIProvider,
): Promise<Error> {
  return new Error(
    `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}\nProvider requests:\n${JSON.stringify(provider?.requests ?? [], null, 2)}`,
  );
}

async function openNewRegressionSession(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "New session" }).click();
  const panel = page.locator(".unified-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.locator(".xterm")).toBeVisible();
  // Panel preview can paint while initial extension binding is still running;
  // wait on the authority/input fence directly without perturbing view state.
  await expect(panel).toHaveAttribute("data-sync-state", "following", { timeout: 60_000 });
  await expect(panel).toHaveAttribute("data-input-enabled", "true", { timeout: 60_000 });
  return panel;
}

async function slash(textarea: Locator, command: string): Promise<void> {
  await textarea.fill(command);
  await textarea.press("Enter");
  await expect
    .poll(async () => (await textarea.count()) === 0 || (await textarea.inputValue()) === "")
    .toBe(true);
}

async function inputView(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: "Input" }).click();
  const textarea = page.locator(".composer__textarea");
  await expect(textarea).toBeVisible();
  await expect(textarea).toBeFocused();
  return textarea;
}

async function extensionView(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: "Extension" }).click();
  const panel = page.locator(".unified-panel");
  const helper = panel.locator(".xterm-helper-textarea");
  await expect(panel).toHaveAttribute("data-sync-state", "following", { timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-input-enabled", "true", { timeout: 30_000 });
  await panel.locator(".xterm").click();
  await expect(helper).toBeFocused();
  return panel;
}

function dockObserver(page: Page): Promise<void> {
  return page.evaluate((sentinel) => {
    const state = window as unknown as { __realRegressionDockMissing?: boolean };
    state.__realRegressionDockMissing = false;
    const present = () => document.body.innerText.includes(sentinel);
    new MutationObserver(() => {
      if (!present()) state.__realRegressionDockMissing = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }, STATIC_DOCK);
}

async function assertDockNeverFlashed(page: Page): Promise<void> {
  // A short observation window is intentional: it catches asynchronous panel
  // authority commits without converting the test into a timing-based wait.
  await page.waitForTimeout(120);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __realRegressionDockMissing?: boolean })
            .__realRegressionDockMissing,
      ),
    )
    .toBe(false);
}

test.describe("Pinned real Pi 0.80.6 regressions", () => {
  test("real factory widgets, unified draft custody, and custom Escape share one live authority", async () => {
    test.setTimeout(180_000);
    const fixture = createRealSdkFixture({ extensionFiles: [EXTENSION] });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      const { window } = launch;
      await openNewRegressionSession(window);

      await test.step("factory widgets mount in a real unified TUI without a Composer", async () => {
        const panel = window.locator(".unified-panel");
        await expect(panel).toBeVisible({ timeout: 45_000 });
        await expect(panel.locator(".xterm")).toBeVisible();
        await expect(window.locator(".composer__textarea")).toHaveCount(0);
        await expect(panel.locator(".xterm-rows")).toContainText(ABOVE);
        await expect(panel.locator(".xterm-rows")).toContainText(BELOW);
        await expect(window.locator(".dock__widget-line")).toHaveText([STATIC_DOCK]);
        const box = await panel.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThan(20);
        expect(box!.height).toBeGreaterThan(20);
        expect(box!.height).toBeLessThan(await window.evaluate(() => window.innerHeight));
        await dockObserver(window);
      });

      await test.step("Input and Extension toggles retain exactly one shared unsent draft", async () => {
        const textarea = await inputView(window);
        const draft = "REAL-REGRESSION-UNIFIED-DRAFT";
        await textarea.fill(draft);
        await expect(textarea).toHaveValue(draft);
        await expect(window.locator(".transcript-block--user")).toHaveCount(0);

        const panel = await extensionView(window);
        await window.keyboard.type(" + EXTENSION");
        await expect(panel.locator(".xterm-rows")).toContainText("EXTENSION");
        const returned = await inputView(window);
        await expect(returned).toHaveValue(`${draft} + EXTENSION`);
        await expect(window.locator(".transcript-block--user")).toHaveCount(0);
      });

      await test.step("factory replacement and final-root removal have exact lifecycle boundaries", async () => {
        const textarea = window.locator(".composer__textarea");
        await slash(textarea, "/regression-replace-factory");
        const panel = await extensionView(window);
        await expect(panel.locator(".xterm-rows")).toContainText(REPLACED);
        await expect(panel.locator(".xterm-rows")).not.toContainText(BELOW);

        const input = await inputView(window);
        await slash(input, "/regression-remove-above");
        await expect(window.locator(".unified-panel")).toHaveCount(1);
        await expect(window.locator(".unified-panel")).toBeHidden();
        await expect(window.locator(".dock__widget-line")).toHaveText([STATIC_DOCK]);
        const secondInput = await inputView(window);
        await secondInput.fill("");
        await slash(secondInput, "/regression-remove-below");
        await expect(window.locator(".unified-panel")).toHaveCount(0);
        await expect(window.locator(".composer__textarea")).toBeVisible();
        await expect(window.locator(".composer__textarea")).toBeFocused();
        await expect(window.locator(".dock__widget-line")).toHaveText([STATIC_DOCK]);
        await assertDockNeverFlashed(window);
      });

      await test.step("real custom overlay consumes bare Escape once and restores the unified surface", async () => {
        const textarea = window.locator(".composer__textarea");
        await slash(textarea, "/regression-custom");
        const overlay = window.locator(".custom-panel");
        await expect(overlay).toBeVisible({ timeout: 30_000 });
        await expect(overlay.locator(".xterm-rows")).toContainText(CUSTOM);
        expect(await overlay.evaluate((element) => element.clientHeight)).toBeGreaterThan(20);
        await window.keyboard.press("Escape");
        await expect(overlay).toHaveCount(0);
        await expect(window.getByText(CUSTOM_DONE, { exact: true })).toHaveCount(1);
        await expect(window.locator(".transcript-block--user")).toHaveCount(0);
        await expect(window.getByText(/Review interrupted (message|command)/)).toHaveCount(0);
        await expect(window.locator(".composer__textarea")).toBeVisible();
        await assertDockNeverFlashed(window);
      });
    } catch (error) {
      throw await withDiagnostics(error, fixture, launch);
    } finally {
      await closeFixture(launch, fixture);
    }
  });

  test("provider-backed names, session-specific factory reconstruction, and /tree persist across relaunch", async () => {
    test.setTimeout(240_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: {
            model: "pivis-test-model",
            promptIncludes: "real regression tree turn",
            compaction: false,
          },
          response: { type: "text", chunks: ["REAL-REGRESSION-TREE-ANSWER"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      extensionFiles: [EXTENSION],
    });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      let { window } = launch;
      await openNewRegressionSession(window);
      const textarea = await inputView(window);
      await selectLocalTestModel(window, textarea);
      await textarea.fill("real regression tree turn");
      await textarea.press("Enter");
      await expect(window.getByText("REAL-REGRESSION-TREE-ANSWER", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      provider.assertExhausted();

      await test.step("extension naming updates header and live sidebar with no factory identity crossover", async () => {
        const input = await inputView(window);
        await slash(input, "/regression-name");
        await expect(window.locator(".session-header__name-btn")).toHaveText(NAME);
        await expect(window.locator(".sidebar__session--active .sidebar__session-name")).toHaveText(
          NAME,
        );
        const firstPanel = await extensionView(window);
        const firstText = await firstPanel.locator(".xterm-rows").innerText();
        expect(firstText).toContain(ABOVE);

        await openNewRegressionSession(window);
        const secondPanel = window.locator(".unified-panel");
        await expect(secondPanel.locator(".xterm-rows")).toContainText(ABOVE, { timeout: 45_000 });
        const secondText = await secondPanel.locator(".xterm-rows").innerText();
        expect(secondText).not.toBe(firstText);
        const namedRow = window.locator(".sidebar__session").filter({ hasText: NAME }).first();
        await namedRow.click();
        await expect(window.locator(".session-header__name-btn")).toHaveText(NAME);
        await expect(window.locator(".sidebar__session--active .sidebar__session-name")).toHaveText(
          NAME,
        );
        const restoredPanel = await extensionView(window);
        await expect(restoredPanel.locator(".xterm-rows")).toContainText(
          firstText.match(/session=\S+/)![0]!,
          { timeout: 30_000 },
        );
        await expect(restoredPanel.locator(".xterm-rows")).not.toContainText(
          secondText.match(/session=\S+/)![0]!,
        );
      });

      await test.step("tree loading resolves to its current leaf and Escape only closes the overlay", async () => {
        const input = await inputView(window);
        await slash(input, "/tree");
        const tree = window.locator(".tree-viewer");
        await expect(tree).toBeVisible();
        await expect
          .poll(() => tree.locator(".tree-viewer__row").count(), { timeout: 30_000 })
          .toBeGreaterThan(0);
        await expect(tree.getByText("Loading tree…", { exact: true })).toHaveCount(0);
        await expect(tree.locator(".tree-viewer__row")).toHaveCount(2);
        await expect(tree).toContainText("real regression tree turn");
        await expect(tree).toContainText("REAL-REGRESSION-TREE-ANSWER");
        await window.keyboard.press("Escape");
        await expect(tree).toHaveCount(0);
        await expect(window.locator(".working-row, .status-dot--streaming")).toHaveCount(0);
      });

      await launch.close();
      launch = await fixture.launch();
      window = launch.window;
      const stored = window.locator(".sidebar__session").filter({ hasText: NAME }).first();
      await stored.click();
      await expect(window.locator(".session-header__name-btn")).toHaveText(NAME);
      await expect(window.locator(".sidebar__session--active .sidebar__session-name")).toHaveText(
        NAME,
      );
      const input = await inputView(window);
      await slash(input, "/tree");
      await expect(window.locator(".tree-viewer .tree-viewer__row")).toHaveCount(2, {
        timeout: 30_000,
      });
    } catch (error) {
      throw await withDiagnostics(error, fixture, launch, provider);
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });

  test("native /compact dispatches immediately once and cannot be shadowed by the extension", async () => {
    test.setTimeout(240_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "compact seed one", compaction: false },
          response: { type: "text", chunks: ["REAL-REGRESSION-COMPACT-SEED-ONE"] },
        },
        {
          expect: { promptIncludes: "compact seed two", compaction: false },
          response: { type: "text", chunks: ["REAL-REGRESSION-COMPACT-SEED-TWO"] },
        },
        {
          expect: { compaction: { includes: "compact seed one" } },
          response: { type: "text", chunks: ["REAL-REGRESSION-COMPACT-SUMMARY"], gate: "compact" },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      extensionFiles: [EXTENSION],
      compactionEnabled: false,
    });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      const { window } = launch;
      await openNewRegressionSession(window);
      const textarea = await inputView(window);
      await selectLocalTestModel(window, textarea);
      for (const seed of ["compact seed one", "compact seed two"]) {
        await textarea.fill(`${seed} ${"alpha beta gamma ".repeat(80)}`);
        await textarea.press("Enter");
        await expect(
          window.getByText(
            seed === "compact seed one"
              ? "REAL-REGRESSION-COMPACT-SEED-ONE"
              : "REAL-REGRESSION-COMPACT-SEED-TWO",
            { exact: true },
          ),
        ).toBeVisible({ timeout: 60_000 });
      }

      await test.step("the built-in compact request crosses the provider boundary before its gated response", async () => {
        await textarea.fill("/compact");
        await textarea.press("Enter");
        await provider.waitForRequestCount(3);
        expect(provider.requests).toHaveLength(3);
        expect(JSON.stringify(provider.requests[2]!.parsedBody).toLowerCase()).toContain("summary");
        await expect(window.getByText(WRONG_COMPACT, { exact: true })).toHaveCount(0);
        await expect(window.getByText("Context compacted", { exact: false })).toHaveCount(0);
        // Admission transfers command custody immediately. It must not remain
        // in the editor while the native compact request is in flight.
        await expect(textarea).toHaveValue("");
        await expect(textarea).toBeEnabled();
        await textarea.evaluate((element) => {
          element.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          );
        });
        expect(provider.requests).toHaveLength(3);
        // The provider request proves admission was immediate; the cleared
        // editor means a duplicate Enter cannot redispatch the command.
        await expect(textarea).toHaveValue("");
        provider.releaseGate("compact");
      });

      await test.step("settlement is one success, one persisted compaction, and no duplicate request", async () => {
        await expect(window.getByText("Context compacted", { exact: false }).first()).toBeVisible({
          timeout: 60_000,
        });
        await expect(window.getByText(/Compaction failed|Nothing to compact/)).toHaveCount(0);
        await expect(textarea).toHaveValue("");
        await expect
          .poll(() =>
            fixture
              .sessionFiles()
              .some((file) =>
                fs.readFileSync(file, "utf8").includes("REAL-REGRESSION-COMPACT-SUMMARY"),
              ),
          )
          .toBe(true);
        expect(provider.requests).toHaveLength(3);
        provider.assertExhausted();
      });
    } catch (error) {
      throw await withDiagnostics(error, fixture, launch, provider);
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });

  test("pending-session draft and saved-session search retain focus during real authority attachment", async () => {
    test.setTimeout(180_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "draft recovery establishing turn", compaction: false },
          response: { type: "text", chunks: ["REAL-REGRESSION-DRAFT-ESTABLISHED"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      extensionFiles: [EXTENSION],
    });
    let launch: RealSdkLaunch | undefined;
    try {
      launch = await fixture.launch();
      const { window } = launch;
      await openNewRegressionSession(window);
      const textarea = await inputView(window);
      await selectLocalTestModel(window, textarea);
      await textarea.fill("draft recovery establishing turn");
      await textarea.press("Enter");
      await expect(
        window.getByText("REAL-REGRESSION-DRAFT-ESTABLISHED", { exact: true }),
      ).toBeVisible({
        timeout: 60_000,
      });
      await slash(textarea, "/name REAL-REGRESSION-DRAFT-SESSION");
      const established = window
        .locator(".sidebar__session")
        .filter({ hasText: "REAL-REGRESSION-DRAFT-SESSION" });
      await expect(established).toHaveCount(1);
      await openNewRegressionSession(window);
      const draftInput = await inputView(window);
      const draft = "REAL-REGRESSION-PENDING-DRAFT";
      await draftInput.fill(draft);
      expect(provider.requests).toHaveLength(1);
      await expect(
        window.locator(".transcript-block--user").filter({ hasText: draft }),
      ).toHaveCount(0);

      await test.step("switching away reaps only the placeholder and preserves its draft", async () => {
        await established.dispatchEvent("click");
        await expect(
          window.getByText("REAL-REGRESSION-DRAFT-ESTABLISHED", { exact: true }),
        ).toBeVisible();
        await openNewRegressionSession(window);
        const restored = await inputView(window);
        await expect(restored).toHaveValue(draft);
        expect(provider.requests).toHaveLength(1);
      });

      await test.step("immediate saved-session search owns focus and returns it to its trigger without dispatch", async () => {
        const trigger = window.getByRole("button", { name: "Search sessions in workspace" });
        // Dispatch directly so this assertion probes the attach-race itself
        // rather than Playwright waiting for a continuously re-rendered button
        // to satisfy pointer-action stability.
        await trigger.dispatchEvent("click");
        const search = window.getByRole("combobox", { name: "Search saved sessions" });
        await expect(search).toBeVisible();
        await expect(search).toBeFocused();
        await expect(window.locator(".dock__widget-line")).toHaveText([STATIC_DOCK]);
        await expect(window.locator(".composer__textarea")).toHaveValue(draft);
        await window.keyboard.press("Escape");
        await expect(search).toHaveCount(0);
        await expect(window.locator(".composer__textarea")).not.toBeFocused();
        await expect(trigger).toBeFocused();
        await expect(window.locator(".composer__textarea")).toHaveValue(draft);
        await expect(
          window.locator(".transcript-block--user").filter({ hasText: draft }),
        ).toHaveCount(0);
        expect(provider.requests).toHaveLength(1);
        provider.assertExhausted();
      });
    } catch (error) {
      throw await withDiagnostics(error, fixture, launch, provider);
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });
});

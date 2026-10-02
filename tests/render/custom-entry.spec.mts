import { expect, test } from "@playwright/test";

test.describe("Pinned-Pi extension entry inspectors", () => {
  test("shows a collapsed raw card only after the extension renderer accepts the entry", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/?customEntry=1");

    const entry = page.locator(".custom-entry");
    const card = entry.locator(".tool-card");
    const header = card.getByRole("button", { name: "status-card extension entry details" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    const controlledId = await header.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
    await expect(card.locator(".tool-card__extension-render")).toHaveCount(0);
    await expect(card).not.toContainText("Indexed files: 17");

    await header.click();

    const body = card.locator(".tool-card__body");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
    await expect(header).toHaveAttribute("aria-controls", await body.getAttribute("id"));
    await expect(card).toContainText("preview-custom-entry");
    await expect(card).toContainText('"title": "Indexed files"');
    await expect(card).toContainText('"count": 17');
    await expect(card.locator(".tool-card__extension-render")).toContainText("Indexed files: 17");
    await expect(card.locator(".tool-card__extension-render")).toContainText(
      /Rendered responsively at \d+ columns/,
    );
    await expect(card.locator(".tool-card__extension-render span").first()).toHaveCSS(
      "font-weight",
      "700",
    );
    await expect(card.locator("details")).toHaveCount(0);

    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(body).toHaveCount(0);
  });

  test("hides the raw record when renderer ownership disappears and restores it on rebind", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/?customEntry=1");

    const entry = page.locator(".custom-entry");
    const card = entry.locator(".tool-card");
    const header = card.getByRole("button", { name: "status-card extension entry details" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await header.click();
    await expect(card.locator(".tool-card__extension-render")).toContainText("renderer v1");
    await expect(card).toContainText('"count": 17');

    await page.evaluate(() => {
      const preview = (
        window as unknown as {
          __pivisPreview: {
            replaceCustomEntryRuntime: (available: boolean, version?: number) => void;
          };
        }
      ).__pivisPreview;
      preview.replaceCustomEntryRuntime(false);
    });
    await expect(card).toHaveCount(0);

    await page.evaluate(() => {
      const preview = (
        window as unknown as {
          __pivisPreview: {
            replaceCustomEntryRuntime: (available: boolean, version?: number) => void;
          };
        }
      ).__pivisPreview;
      preview.replaceCustomEntryRuntime(true, 2);
    });
    await expect(card).toBeVisible();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".tool-card__extension-render")).toContainText("renderer v2");
    await expect(card).toContainText('"count": 17');
  });

  test("keeps an entry hidden when no extension renderer owns it", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/?customEntry=1");
    await page.waitForFunction(
      () =>
        !!(
          window as unknown as {
            __pivisPreview?: { replaceCustomEntryRuntime?: unknown };
          }
        ).__pivisPreview?.replaceCustomEntryRuntime,
    );
    await page.evaluate(() => {
      (
        window as unknown as {
          __pivisPreview: {
            replaceCustomEntryRuntime: (available: boolean, version?: number) => void;
          };
        }
      ).__pivisPreview.replaceCustomEntryRuntime(false);
    });

    const entry = page.locator(".custom-entry");
    await expect(entry).toHaveCount(1, { timeout: 10_000 });
    await expect(entry.locator(".tool-card")).toHaveCount(0);
    await expect(page.getByText("status-card", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    const transcriptStyle = page.getByRole("group", { name: "Transcript style" });
    await transcriptStyle.getByRole("button", { name: "Compact" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".compact-transcript-group__summary")).toHaveCount(0);
    await expect(entry.locator(".tool-card")).toHaveCount(0);
  });

  test("hands width-dependent entries into compact grouping without hidden breaks", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

    await page.evaluate(() => {
      type PreviewState = {
        activeSessionId: string;
        seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
        addToast: (sessionId: string, message: string, type?: string) => void;
      };
      const target = window as unknown as {
        __customEntryQueryWidths?: number[];
        __customEntryRendererVisible?: boolean;
        __pivisStore: { getState: () => PreviewState };
      };
      target.__customEntryQueryWidths = [];
      target.__customEntryRendererVisible = false;
      const pivis = window.pivis as unknown as {
        invoke: (channel: string, args: unknown) => Promise<unknown>;
      };
      const originalInvoke = pivis.invoke.bind(pivis);
      pivis.invoke = async (channel, args) => {
        const result = await originalInvoke(channel, args);
        const envelope = args as {
          query?: { type?: string; cols?: number };
        };
        if (channel !== "session.query" || envelope.query?.type !== "render_entry") return result;
        const cols = Number(envelope.query.cols ?? 80);
        target.__customEntryQueryWidths?.push(cols);
        const queryResult = result as {
          response?: { success?: boolean; data?: unknown };
          [key: string]: unknown;
        };
        if (queryResult.response?.success !== true) return result;
        return {
          ...queryResult,
          response: {
            ...queryResult.response,
            data: {
              ...(queryResult.response.data as Record<string, unknown> | undefined),
              rendered: target.__customEntryRendererVisible === true && cols !== 80,
            },
          },
        };
      };
      const state = target.__pivisStore.getState();
      state.seedHistory(state.activeSessionId, [
        {
          id: "transparent-thinking",
          type: "assistant",
          data: {
            segments: [{ kind: "thinking", content: "Before the hidden notice" }],
            isStreaming: false,
          },
        },
        {
          id: "transparent-extension-entry",
          type: "custom_entry",
          data: {
            entryId: "transparent-extension-entry",
            customType: "hidden-notice",
            data: { message: "Not rendered in the transcript" },
          },
        },
        {
          id: "transparent-tool",
          type: "tool_call",
          data: {
            toolCallId: "transparent-call",
            toolName: "read",
            outputText: "done",
            isError: false,
            isStreaming: false,
          },
        },
      ]);
      state.addToast(state.activeSessionId, "Notification-center only", "info");
    });

    await page.getByRole("button", { name: "Settings" }).click();
    await page
      .getByRole("group", { name: "Transcript style" })
      .getByRole("button", { name: "Compact" })
      .click();
    await page.keyboard.press("Escape");

    const summaries = page.locator(".compact-transcript-group__summary");
    await expect(summaries).toHaveCount(1);
    await expect(summaries).toHaveText("Thinking, 1 tool call");
    await expect(page.locator(".custom-entry .tool-card")).toHaveCount(0);

    await page.evaluate(() => {
      (
        window as unknown as {
          __customEntryRendererVisible?: boolean;
        }
      ).__customEntryRendererVisible = true;
    });
    await page.setViewportSize({ width: 980, height: 800 });

    await expect(
      page.getByRole("button", { name: "hidden-notice extension entry details" }),
    ).toBeVisible({ timeout: 10_000 });
    expect(
      await page.evaluate(() =>
        (
          window as unknown as {
            __customEntryQueryWidths?: number[];
          }
        ).__customEntryQueryWidths?.some((cols) => cols !== 80),
      ),
    ).toBe(true);
    await expect(summaries).toHaveCount(2);
    await expect(summaries.nth(0)).toHaveText("Thinking");
    await expect(summaries.nth(1)).toHaveText("1 tool call");
    await page.waitForTimeout(250);
    await expect(
      page.getByRole("button", { name: "hidden-notice extension entry details" }),
    ).toBeVisible();

    await page.evaluate(() => {
      (
        window as unknown as {
          __customEntryRendererVisible?: boolean;
        }
      ).__customEntryRendererVisible = false;
    });
    await page.setViewportSize({ width: 860, height: 800 });

    await expect(page.locator(".custom-entry .tool-card")).toHaveCount(0);
    await expect(summaries).toHaveCount(1);
    await expect(summaries).toHaveText("Thinking, 1 tool call");
  });

  test("trailing hidden archive entries do not starve visible compact history", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

    await page.evaluate(() => {
      type PreviewState = {
        activeSessionId: string;
        seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
      };
      const target = window as unknown as {
        __archivedProbeCounts?: number[];
        __archivedProbeObserver?: MutationObserver;
        __pivisPreview: {
          replaceCustomEntryRuntime: (available: boolean, version?: number) => void;
        };
        __pivisStore: { getState: () => PreviewState };
      };
      target.__archivedProbeCounts = [];
      target.__pivisPreview.replaceCustomEntryRuntime(false);
      const state = target.__pivisStore.getState();
      state.seedHistory(state.activeSessionId, [
        {
          id: "visible-before-hidden-suffix",
          type: "user",
          data: { content: "Visible history must mount immediately" },
        },
        ...Array.from({ length: 250 }, (_, index) => ({
          id: `hidden-archive-entry-${index}`,
          type: "custom_entry",
          data: {
            entryId: `hidden-archive-entry-${index}`,
            customType: "hidden-notice",
            data: { index },
          },
        })),
      ]);
      const transcript = document.querySelector(".transcript-blocks");
      if (!transcript) throw new Error("missing transcript");
      target.__archivedProbeObserver = new MutationObserver(() => {
        target.__archivedProbeCounts?.push(
          transcript.querySelectorAll(".custom-entry--visibility-probe").length,
        );
      });
      target.__archivedProbeObserver.observe(transcript, { childList: true, subtree: true });
    });

    await page.getByRole("button", { name: "Settings" }).click();
    await page
      .getByRole("group", { name: "Transcript style" })
      .getByRole("button", { name: "Compact" })
      .click();
    await page.keyboard.press("Escape");

    await expect(
      page.getByText("Visible history must mount immediately", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".history-loading-row--earlier")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __archivedProbeCounts?: number[];
              }
            ).__archivedProbeCounts?.at(-1) ?? 0,
        ),
      )
      .toBe(250);

    const visibleCounts = await page.evaluate(
      () =>
        (
          window as unknown as {
            __archivedProbeCounts?: number[];
          }
        ).__archivedProbeCounts ?? [],
    );
    const increases = visibleCounts
      .map((count, index) => count - (visibleCounts[index - 1] ?? 0))
      .filter((increase) => increase > 0);
    expect(increases.length).toBeGreaterThan(1);
    expect(Math.max(...increases)).toBeLessThanOrEqual(100);
  });

  test("measures extension columns using the configured code font", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/?customEntry=1");

    const entry = page.locator(".custom-entry");
    const card = entry.locator(".tool-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--font-size-code-root", "28px");
      document.documentElement.style.setProperty("--font-code", "monospace");
    });
    await card.getByRole("button", { name: "status-card extension entry details" }).click();

    const renderedCols = async (): Promise<number> => {
      const text = (await card.locator(".tool-card__extension-render").textContent()) ?? "";
      return Number(/Rendered responsively at (\d+) columns/.exec(text)?.[1] ?? 0);
    };
    await expect.poll(renderedCols).toBeLessThan(70);
    const largeFontCols = await renderedCols();

    await page.evaluate(() => {
      document.documentElement.style.setProperty("--font-size-code-root", "14px");
    });
    await page.setViewportSize({ width: 1099, height: 800 });
    await expect.poll(renderedCols).toBeGreaterThan(largeFontCols + 20);
  });
});

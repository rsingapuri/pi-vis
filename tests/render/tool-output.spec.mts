import { type Locator, type Page, expect, test } from "@playwright/test";

type PreviewStoreState = {
  activeSessionId: string;
  seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
  applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
};

async function waitForPreview(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => {
    const store = (
      window as unknown as {
        __pivisStore?: { getState: () => { activeSessionId?: string | null } };
      }
    ).__pivisStore;
    return !!store?.getState().activeSessionId;
  });
  // Let the preview's initial session selection/hydration settle before a
  // test replaces history; otherwise that first asynchronous mount can reset
  // a freshly opened disclosure mid-assertion.
  await page.waitForTimeout(800);
}

async function seedHistory(page: Page, history: Array<Record<string, unknown>>): Promise<void> {
  await page.evaluate((nextHistory) => {
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewStoreState } }
    ).__pivisStore.getState();
    state.seedHistory(state.activeSessionId, nextHistory);
  }, history);
}

async function installClipboardSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as {
      __clipboardWrites?: Array<{ text: string }>;
      pivis: { invoke: (channel: string, args?: unknown) => Promise<unknown> };
    };
    target.__clipboardWrites = [];
    const originalInvoke = target.pivis.invoke;
    target.pivis.invoke = (channel, args) => {
      if (channel === "clipboard.writeText") {
        target.__clipboardWrites?.push(args as { text: string });
        return Promise.resolve({ ok: true });
      }
      return originalInvoke(channel, args);
    };
  });
}

async function installSessionQuerySpy(page: Page, queryType: string): Promise<void> {
  await page.evaluate((type) => {
    const target = window as unknown as {
      __matchingSessionQueries?: number;
      pivis: { invoke: (channel: string, args?: unknown) => Promise<unknown> };
    };
    target.__matchingSessionQueries = 0;
    const originalInvoke = target.pivis.invoke.bind(target.pivis);
    target.pivis.invoke = (channel, args) => {
      const query = (args as { query?: { type?: unknown } } | undefined)?.query;
      if (channel === "session.query" && query?.type === type) {
        target.__matchingSessionQueries = (target.__matchingSessionQueries ?? 0) + 1;
      }
      return originalInvoke(channel, args);
    };
  }, queryType);
}

function section(card: Locator, title: string): Locator {
  return card
    .locator(".tool-card__section-title")
    .filter({ hasText: new RegExp(`^${title}$`) })
    .locator("..")
    .locator("..");
}

test.describe("unified tool card disclosure", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto("/");
    await waitForPreview(page);
  });

  test("one disclosure exposes every retained tool result field at full fidelity", async ({
    page,
  }) => {
    const outputText = "output line 1\nOUTPUT FINAL SENTINEL";
    const longInputValue = `${"x".repeat(512)}LONG INPUT FINAL SENTINEL`;
    const imageData =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const resultContent = [
      {
        type: "text",
        text: "output line 1",
        textSignature: "RESULT FIRST SIGNATURE",
      },
      {
        type: "image",
        data: imageData.slice(imageData.indexOf(",") + 1),
        mimeType: "image/png",
        assetId: "RESULT MIDDLE IMAGE",
      },
      {
        type: "text",
        text: "OUTPUT FINAL SENTINEL",
        textSignature: "RESULT LAST SIGNATURE",
      },
    ];
    await seedHistory(page, [
      {
        id: "full-fidelity-tool",
        type: "tool_call",
        data: {
          toolCallId: "full-fidelity-call-id",
          toolName: "inspect_everything",
          input: {
            prompt: "first input line\nINPUT FINAL SENTINEL",
            emptyString: "",
            nested: { retained: true },
            payload: longInputValue,
          },
          outputText,
          outputImages: [imageData],
          resultContent,
          diff: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+DIFF FINAL SENTINEL",
          patch: "*** Begin Patch\n*** Update File: file.txt\n+PATCH FINAL SENTINEL\n*** End Patch",
          resultDetails: {
            fullOutputPath: "/tmp/DETAIL FINAL SENTINEL.log",
            truncation: { truncated: false },
          },
          resultMetadata: {
            addedToolNames: ["audit-tool"],
            terminate: true,
            output: "LEGACY OUTPUT FINAL SENTINEL",
          },
          isError: false,
          isStreaming: false,
        },
      },
    ]);
    await installClipboardSpy(page);

    const card = page.locator(".tool-card").filter({ hasText: "inspect_everything" });
    const accessibleName =
      "inspect_everything tool call details — first input line · 2 lines · 1 image · changes";
    const header = card.getByRole("button", { name: accessibleName, exact: true });
    await expect(card).toBeVisible();
    await expect(header).toHaveAccessibleName(accessibleName);
    await expect(header).toHaveAttribute("aria-expanded", "false");
    const controlledId = await header.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();

    // A collapsed card is an authored header, not a differently truncated body preview.
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
    await expect(card).not.toContainText("INPUT FINAL SENTINEL");
    await expect(card).not.toContainText("OUTPUT FINAL SENTINEL");
    await expect(card.locator("details")).toHaveCount(0);

    await header.click();
    await expect(header).toHaveAccessibleName(accessibleName);

    const body = card.locator(".tool-card__body");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
    await expect(header).toHaveAttribute("aria-controls", await body.getAttribute("id"));
    await expect(body).toContainText("full-fidelity-call-id");

    const input = section(card, "Input");
    await expect(input).toContainText("INPUT FINAL SENTINEL");
    await expect(input).toContainText('"emptyString": ""');
    await expect(input).toContainText('"retained": true');
    await expect(input).toContainText(longInputValue);

    await expect(section(card, "Diff")).toContainText("DIFF FINAL SENTINEL");
    await expect(section(card, "Patch")).toContainText("PATCH FINAL SENTINEL");

    const output = card.locator(".tool-card__output-panel");
    await expect(output).toContainText("output line 1");
    await expect(output).toContainText("OUTPUT FINAL SENTINEL");
    const images = section(card, "Images");
    await expect(images.locator("img.tool-card__image")).toHaveCount(1);
    const mimeLabel = images.locator(".tool-card__image-meta");
    await expect(mimeLabel).toHaveText("image/png");
    await expect(mimeLabel).toHaveCSS("white-space", "normal");
    await expect(mimeLabel).toHaveCSS("overflow-wrap", "anywhere");
    await expect(mimeLabel).toHaveCSS("text-overflow", "clip");

    const completeResultContent = section(card, "Result content");
    await expect(completeResultContent).toContainText("RESULT FIRST SIGNATURE");
    await expect(completeResultContent).toContainText("RESULT MIDDLE IMAGE");
    await expect(completeResultContent).toContainText("RESULT LAST SIGNATURE");
    const renderedResultContent =
      (await completeResultContent.locator(".tool-card__structured-value").textContent()) ?? "";
    expect(renderedResultContent.indexOf("RESULT FIRST SIGNATURE")).toBeLessThan(
      renderedResultContent.indexOf("RESULT MIDDLE IMAGE"),
    );
    expect(renderedResultContent.indexOf("RESULT MIDDLE IMAGE")).toBeLessThan(
      renderedResultContent.indexOf("RESULT LAST SIGNATURE"),
    );

    await expect(section(card, "Result metadata")).toContainText("DETAIL FINAL SENTINEL");
    const resultFields = section(card, "Result fields");
    await expect(resultFields).toContainText("audit-tool");
    await expect(resultFields).toContainText('"terminate": true');
    await expect(resultFields).toContainText("LEGACY OUTPUT FINAL SENTINEL");
    await expect(card.locator("details")).toHaveCount(0);

    await output.getByRole("button", { name: "Copy all" }).click();
    await expect(output.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __clipboardWrites?: Array<{ text: string }> })
              .__clipboardWrites?.[0]?.text,
        ),
      )
      .toBe(outputText);

    await completeResultContent.getByRole("button", { name: "Copy all" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __clipboardWrites?: Array<{ text: string }> })
              .__clipboardWrites?.[1]?.text,
        ),
      )
      .toBe(JSON.stringify(resultContent, null, 2));

    // The same control owns both states and works from the keyboard.
    await header.focus();
    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(body).toHaveCount(0);
    await page.keyboard.press("Space");
    await expect(header).toHaveAttribute("aria-expanded", "true");
  });

  test("empty input objects and empty output remain inspectable without nested toggles", async ({
    page,
  }) => {
    await seedHistory(page, [
      {
        id: "empty-input-tool",
        type: "tool_call",
        data: {
          toolCallId: "empty-input-call",
          toolName: "empty_input",
          input: {},
          outputText: "",
          resultContent: "",
          isError: false,
          isStreaming: false,
        },
      },
    ]);

    const card = page.locator(".tool-card").filter({ hasText: "empty_input" });
    const header = card.getByRole("button", { name: "empty_input tool call details" });
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
    await header.click();

    await expect(section(card, "Input")).toContainText("{}");
    await expect(section(card, "Output")).toContainText("The tool returned no text output.");
    await expect(section(card, "Result content").locator(".tool-card__section-meta")).toHaveText(
      "0 characters",
    );
    await expect(card.locator("details")).toHaveCount(0);
  });

  test("header chrome stays neutral, centered, seamless, and keyboard controlled", async ({
    page,
  }) => {
    await seedHistory(page, [
      {
        id: "chrome-tool",
        type: "tool_call",
        data: {
          toolCallId: "chrome-call",
          toolName: "chrome_tool",
          input: { path: "chrome.txt" },
          outputText: "chrome output",
          isError: false,
          isStreaming: false,
        },
      },
    ]);

    const card = page.locator(".tool-card").filter({ hasText: "chrome_tool" });
    const header = card.getByRole("button", { name: /^chrome_tool tool call details/u });
    const chevron = card.locator(".tool-card__chevron");
    const label = card.locator(".tool-card__name");
    await expect(header).toHaveAttribute("aria-expanded", "false");

    const centeredChevron = async (): Promise<{ viewBoxDelta: number; labelDelta: number }> =>
      card.evaluate((element) => {
        const svg = element.querySelector<SVGSVGElement>(".tool-card__chevron");
        const shape = svg?.querySelector<SVGGraphicsElement>("polyline");
        const name = element.querySelector<HTMLElement>(".tool-card__name");
        if (!svg || !shape || !name) throw new Error("tool card header geometry is incomplete");
        const box = shape.getBBox();
        const viewBox = svg.viewBox.baseVal;
        const svgRect = svg.getBoundingClientRect();
        const nameRect = name.getBoundingClientRect();
        return {
          viewBoxDelta: box.y + box.height / 2 - (viewBox.y + viewBox.height / 2),
          labelDelta: svgRect.top + svgRect.height / 2 - (nameRect.top + nameRect.height / 2),
        };
      });

    const collapsedCenter = await centeredChevron();
    expect(collapsedCenter.viewBoxDelta).toBe(0);
    expect(Math.abs(collapsedCenter.labelDelta)).toBeLessThanOrEqual(0.1);
    await expect(chevron).toBeVisible();
    await expect(label).toBeVisible();

    const restingChrome = await card.evaluate((element) => {
      const headerElement = element.querySelector<HTMLElement>(".tool-card__header");
      if (!headerElement) throw new Error("tool card header is missing");
      return {
        background: getComputedStyle(headerElement).backgroundColor,
        borderColor: getComputedStyle(element).borderColor,
      };
    });
    await header.hover();
    await page.waitForTimeout(200);
    await expect
      .poll(() =>
        card.evaluate((element) => {
          const headerElement = element.querySelector<HTMLElement>(".tool-card__header");
          if (!headerElement) throw new Error("tool card header is missing");
          return {
            background: getComputedStyle(headerElement).backgroundColor,
            borderColor: getComputedStyle(element).borderColor,
          };
        }),
      )
      .toEqual(restingChrome);

    // Establish keyboard modality before focusing directly so :focus-visible
    // is exercised, not merely the pointer-focus suppression rule.
    await page.keyboard.press("Tab");
    await header.focus();
    await expect(header).toBeFocused();
    await expect
      .poll(() => header.evaluate((element) => element.matches(":focus-visible")))
      .toBe(true);
    await expect(header).toHaveCSS("outline-style", "none");
    await expect(chevron).toHaveCSS("stroke-width", "2px");

    await page.keyboard.press("Enter");
    await expect(header).toBeFocused();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".tool-card__body")).toHaveCSS("border-top-style", "none");
    const expandedCenter = await centeredChevron();
    expect(expandedCenter.viewBoxDelta).toBe(0);
    expect(Math.abs(expandedCenter.labelDelta)).toBeLessThanOrEqual(0.1);

    await page.keyboard.press("Space");
    await expect(header).toBeFocused();
    await expect(header).toHaveAttribute("aria-expanded", "false");
  });

  test("errors and interruptions stay collapsed until the user opens them", async ({ page }) => {
    await seedHistory(page, [
      {
        id: "seeded-error-tool",
        type: "tool_call",
        data: {
          toolCallId: "seeded-error-call",
          toolName: "seeded_error_tool",
          input: { path: "seeded-error.txt" },
          outputText: "SEEDED ERROR OUTPUT",
          isError: true,
          isStreaming: false,
        },
      },
      {
        id: "failed-bash",
        type: "bash",
        data: {
          command: "failing-command-sentinel",
          outputText: "FAILED BASH OUTPUT",
          isStreaming: false,
          exitCode: 7,
        },
      },
      {
        id: "interrupted-tool",
        type: "tool_call",
        data: {
          toolCallId: "interrupted-call",
          toolName: "interrupted_tool",
          outputText: "INTERRUPTED TOOL OUTPUT",
          interrupted: true,
          isError: false,
          isStreaming: false,
        },
      },
      {
        id: "failed-compaction",
        type: "compaction",
        data: {
          errorMessage: "FAILED COMPACTION OUTPUT",
          reason: "manual",
        },
      },
    ]);

    const seededCases = [
      page.locator(".tool-card").filter({ hasText: "seeded_error_tool" }),
      page.locator(".tool-card").filter({ hasText: "failing-command-sentinel" }),
      page.locator(".tool-card").filter({ hasText: "interrupted_tool" }),
      page.locator(".tool-card").filter({ hasText: "Compaction failed" }),
    ];
    for (const card of seededCases) {
      await expect(card.locator(".tool-card__header")).toHaveAttribute("aria-expanded", "false");
      await expect(card.locator(".tool-card__body")).toHaveCount(0);
    }

    await page.evaluate(() => {
      const state = (
        window as unknown as { __pivisStore: { getState: () => PreviewStoreState } }
      ).__pivisStore.getState();
      state.applyEvent(state.activeSessionId, {
        type: "tool_execution_start",
        toolCallId: "attention-call",
        toolName: "attention_tool",
        args: { path: "attention.txt" },
      });
    });

    const card = page.locator(".tool-card").filter({ hasText: "attention_tool" });
    const header = card.getByRole("button", {
      name: /^attention_tool tool call details — attention\.txt/u,
    });
    await expect(header).toHaveAttribute("aria-expanded", "false");

    await page.evaluate(() => {
      const state = (
        window as unknown as { __pivisStore: { getState: () => PreviewStoreState } }
      ).__pivisStore.getState();
      state.applyEvent(state.activeSessionId, {
        type: "tool_execution_end",
        toolCallId: "attention-call",
        toolName: "attention_tool",
        result: { content: [{ type: "text", text: "ATTENTION ERROR OUTPUT" }] },
        isError: true,
      });
    });

    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
    await expect(card).not.toContainText("ATTENTION ERROR OUTPUT");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(card).toContainText("ATTENTION ERROR OUTPUT");
    await expect(card.locator(".tool-card__body")).toHaveCSS("border-top-style", "none");

    // Enriching a failed record must not override the user's disclosure state.
    await page.evaluate(() => {
      const state = (
        window as unknown as { __pivisStore: { getState: () => PreviewStoreState } }
      ).__pivisStore.getState();
      state.applyEvent(state.activeSessionId, {
        type: "message_start",
        message: {
          role: "toolResult",
          toolCallId: "attention-call",
          toolName: "attention_tool",
          content: [{ type: "text", text: "UPDATED ATTENTION OUTPUT" }],
          isError: true,
        },
      });
    });
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(card).toContainText("UPDATED ATTENTION OUTPUT");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
  });

  test("direct shell records expose the complete command, output, and execution metadata", async ({
    page,
  }) => {
    const command = "printf 'first line' && printf 'COMMAND FINAL SENTINEL'";
    await seedHistory(page, [
      {
        id: "direct-bash",
        type: "bash",
        data: {
          command,
          outputText: "shell output\nSHELL OUTPUT FINAL SENTINEL",
          isStreaming: false,
          exitCode: 0,
          cancelled: false,
          truncated: true,
          fullOutputPath: "/tmp/SHELL METADATA FINAL SENTINEL.log",
          excludeFromContext: true,
          timestamp: 1_786_000_000_000,
        },
      },
    ]);

    const card = page.locator(".tool-card").filter({ hasText: "COMMAND FINAL SENTINEL" });
    const header = card.getByRole("button", { name: /^shell command details — /u });
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
    await header.click();

    await expect(section(card, "Command")).toContainText(command);
    await expect(card.locator(".tool-card__output-panel")).toContainText(
      "SHELL OUTPUT FINAL SENTINEL",
    );
    const metadata = section(card, "Execution metadata");
    await expect(metadata).toContainText("SHELL METADATA FINAL SENTINEL");
    await expect(metadata).toContainText('"truncated": true');
    await expect(metadata).toContainText('"excludeFromContext": true');
  });

  test("wide and tall payloads use one native scroll owner while prose wraps", async ({ page }) => {
    const wideStructuredSentinel = `${"STRUCTURED-WIDE-".repeat(180)}END`;
    const structuredInput = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `structured_row_${String(index).padStart(3, "0")}`,
        index === 0 ? wideStructuredSentinel : `structured value ${index}`,
      ]),
    );
    const wideDiffSentinel = `+${"DIFF-WIDE-".repeat(220)}END`;
    const diff = [
      "--- a/scroll.txt",
      "+++ b/scroll.txt",
      "@@ -1,80 +1,80 @@",
      wideDiffSentinel,
      ...Array.from({ length: 80 }, (_, index) => `+diff row ${String(index).padStart(3, "0")}`),
    ].join("\n");
    const activityContent = Array.from(
      { length: 36 },
      (_, index) =>
        `Wrapping activity paragraph ${index}: ${"ordinary prose with spaces ".repeat(14)}`,
    ).join("\n\n");
    const wideCodeSentinel = `${"CODE-WIDE-".repeat(180)}END`;
    const wideTableSentinel = `${"TABLE-WIDE-".repeat(180)}END`;
    const markdownScrollContent = [
      "Tall Markdown payload",
      "",
      "```text",
      wideCodeSentinel,
      ...Array.from({ length: 48 }, (_, index) => `code row ${String(index).padStart(3, "0")}`),
      "```",
      "",
      "| Kind | Complete value |",
      "| --- | --- |",
      `| table | ${wideTableSentinel} |`,
    ].join("\n");

    await seedHistory(page, [
      {
        id: "native-scroll-tool",
        type: "tool_call",
        data: {
          toolCallId: "native-scroll-call",
          toolName: "native_scroll_tool",
          input: structuredInput,
          outputText: "",
          diff,
          isError: false,
          isStreaming: false,
        },
      },
      {
        id: "wrapping-activity",
        type: "custom_message",
        data: {
          customType: "wrapping-activity",
          content: activityContent,
        },
      },
      {
        id: "markdown-scroll-activity",
        type: "custom_message",
        data: {
          customType: "markdown-scroll-activity",
          content: markdownScrollContent,
        },
      },
    ]);

    const toolCard = page.locator(".tool-card").filter({ hasText: "native_scroll_tool" });
    await toolCard.getByRole("button", { name: /^native_scroll_tool tool call details/u }).click();

    const structuredRegion = toolCard.getByRole("region", {
      name: "Input, complete value",
    });
    const diffRegion = toolCard.getByRole("region", { name: "Complete diff" });
    for (const region of [structuredRegion, diffRegion]) {
      await expect(region).toHaveCSS("overflow-x", "auto");
      await expect(region).toHaveCSS("overflow-y", "auto");
      const initial = await region.evaluate((element) => ({
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
        scrollTop: element.scrollTop,
      }));
      expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
      expect(initial.scrollWidth).toBeGreaterThan(initial.clientWidth);
      expect(initial.scrollTop).toBe(0);

      const scrolled = await region.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        return { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
      });
      expect(scrolled.scrollLeft).toBeGreaterThan(0);
      expect(scrolled.scrollTop).toBe(0);
    }
    await expect(structuredRegion).toContainText(wideStructuredSentinel);
    await expect(diffRegion).toContainText(wideDiffSentinel);
    await expect(toolCard.locator(".tool-card__horizontal-scroll")).toHaveCount(0);
    await expect(toolCard.locator(".diff-block__scroll")).toHaveCount(0);
    await expect(toolCard.locator(".scroll-fade-frame")).toHaveCount(0);

    const activityCard = page.locator(".tool-card").filter({ hasText: "wrapping-activity" });
    await activityCard
      .getByRole("button", { name: /^extension activity details — wrapping-activity/u })
      .click();
    const activityRegion = activityCard.getByRole("region", {
      name: "Complete activity message",
    });
    const activityGeometry = await activityRegion.evaluate((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
    }));
    expect(activityGeometry.scrollHeight).toBeGreaterThan(activityGeometry.clientHeight);
    expect(activityGeometry.scrollWidth).toBeLessThanOrEqual(activityGeometry.clientWidth + 1);
    await expect(activityCard.locator(".scroll-fade-frame")).toHaveCount(0);

    const markdownCard = page.locator(".tool-card").filter({ hasText: "markdown-scroll-activity" });
    await markdownCard
      .getByRole("button", { name: /^extension activity details — markdown-scroll-activity/u })
      .click();
    const markdownRegion = markdownCard.getByRole("region", {
      name: "Complete activity message",
    });
    await expect(markdownRegion).toContainText(wideCodeSentinel);
    await expect(markdownRegion).toContainText(wideTableSentinel);
    await expect(markdownRegion).toHaveCSS("overflow-x", "auto");
    await expect(markdownRegion).toHaveCSS("overflow-y", "auto");
    await expect(markdownCard.locator(".markdown-table-scroll")).toHaveCSS("overflow-x", "visible");
    await expect(
      markdownCard.locator(".shiki > code, .code-block--plain > code").first(),
    ).toHaveCSS("overflow-x", "visible");

    const markdownGeometry = await markdownRegion.evaluate((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      scrollTop: element.scrollTop,
    }));
    expect(markdownGeometry.scrollHeight).toBeGreaterThan(markdownGeometry.clientHeight);
    expect(markdownGeometry.scrollWidth).toBeGreaterThan(markdownGeometry.clientWidth);
    expect(markdownGeometry.scrollTop).toBe(0);

    const nestedHorizontalOwners = await markdownRegion.evaluate((element) =>
      Array.from(element.querySelectorAll<HTMLElement>("*"))
        .filter((candidate) => {
          const overflow = getComputedStyle(candidate).overflowX;
          return (
            (overflow === "auto" || overflow === "scroll") &&
            candidate.scrollWidth > candidate.clientWidth + 1
          );
        })
        .map((candidate) => candidate.className),
    );
    expect(nestedHorizontalOwners).toEqual([]);

    const markdownScrolled = await markdownRegion.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
    });
    expect(markdownScrolled.scrollLeft).toBeGreaterThan(0);
    expect(markdownScrolled.scrollTop).toBe(0);
    await expect(markdownCard.locator(".scroll-fade-frame")).toHaveCount(0);
  });

  test("compaction, branch, and extension activity share the one-click inspector", async ({
    page,
  }) => {
    await seedHistory(page, [
      {
        id: "compaction-card",
        type: "compaction",
        data: {
          summary: "Compaction summary\nCOMPACTION FINAL SENTINEL",
          reason: "threshold",
          tokensBefore: 12345,
          estimatedTokensAfter: 4567,
          firstKeptEntryId: "first-kept-sentinel",
          details: { retained: "compaction-details-sentinel" },
          fromHook: true,
        },
      },
      {
        id: "branch-card",
        type: "branch_summary",
        data: {
          summary: "Branch summary\nBRANCH FINAL SENTINEL",
          fromId: "branch-origin-sentinel",
          details: { retained: "branch-details-sentinel" },
        },
      },
      {
        id: "custom-message-card",
        type: "custom_message",
        data: {
          content: "Extension notice\nEXTENSION FINAL SENTINEL",
          customType: "activity-sentinel",
          details: { retained: "extension-details-sentinel" },
        },
      },
    ]);

    const cases = [
      {
        name: /^context activity details — Context compacted/u,
        collapsedText: "Context compacted",
        fullText: "COMPACTION FINAL SENTINEL",
        metadataText: "first-kept-sentinel",
        secondaryMetadataText: '"estimatedTokensAfter": 4567',
      },
      {
        name: /^branch activity details — Branch summarized/u,
        collapsedText: "Branch summarized",
        fullText: "BRANCH FINAL SENTINEL",
        metadataText: "branch-origin-sentinel",
        secondaryMetadataText: null,
      },
      {
        name: /^extension activity details — activity-sentinel/u,
        collapsedText: "activity-sentinel",
        fullText: "EXTENSION FINAL SENTINEL",
        metadataText: "extension-details-sentinel",
        secondaryMetadataText: null,
      },
    ] as const;

    await expect(
      page.locator(".tool-card").filter({ hasText: "Context compacted" }).first(),
    ).toContainText("≈4,567 tokens after");

    for (const item of cases) {
      const card = page.locator(".tool-card").filter({ hasText: item.collapsedText }).first();
      const header = card.getByRole("button", { name: item.name });
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(card).not.toContainText(item.fullText);
      await header.click();
      await expect(card).toContainText(item.fullText);
      const metadata = section(card, "Metadata");
      await expect(metadata).toContainText(item.metadataText);
      if (item.secondaryMetadataText) {
        await expect(metadata).toContainText(item.secondaryMetadataText);
      }
      await expect(card.locator("details")).toHaveCount(0);
    }
  });

  test("activity disclosures keep unique stable names and copy exact whitespace", async ({
    page,
  }) => {
    const paddedContent = "\n  Exact activity message with trailing spaces  \n\n";
    const whitespaceOnlyContent = " \n\t  ";
    await seedHistory(page, [
      {
        id: "padded-custom-message",
        type: "custom_message",
        data: {
          content: paddedContent,
          rawContent: paddedContent,
          customType: "padded-message",
        },
      },
      {
        id: "whitespace-custom-message",
        type: "custom_message",
        data: {
          content: whitespaceOnlyContent,
          customType: "whitespace-message",
        },
      },
    ]);
    await installClipboardSpy(page);

    const paddedCard = page.locator(".tool-card").filter({ hasText: "padded-message" });
    const paddedName =
      "extension activity details — padded-message · Exact activity message with trailing spaces";
    const paddedHeader = paddedCard.getByRole("button", { name: paddedName, exact: true });
    await expect(paddedHeader).toHaveAccessibleName(paddedName);
    await paddedHeader.click();
    await expect(paddedHeader).toHaveAccessibleName(paddedName);
    const paddedMessage = section(paddedCard, "Message");
    await expect(section(paddedCard, "Raw content")).toHaveCount(0);
    await expect(paddedMessage.locator(".tool-card__section-meta")).toHaveText(
      `${paddedContent.length} characters`,
    );
    await paddedMessage.getByRole("button", { name: "Copy all" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __clipboardWrites?: Array<{ text: string }> })
              .__clipboardWrites?.[0]?.text,
        ),
      )
      .toBe(paddedContent);

    const whitespaceCard = page.locator(".tool-card").filter({ hasText: "whitespace-message" });
    const whitespaceName = "extension activity details — whitespace-message";
    const whitespaceHeader = whitespaceCard.getByRole("button", {
      name: whitespaceName,
      exact: true,
    });
    await expect(whitespaceHeader).toHaveAccessibleName(whitespaceName);
    await whitespaceHeader.click();
    await expect(whitespaceHeader).toHaveAccessibleName(whitespaceName);
    const whitespaceMessage = section(whitespaceCard, "Message");
    await expect(whitespaceMessage).not.toContainText("No message content was retained.");
    await expect(whitespaceMessage.locator(".tool-card__section-meta")).toHaveText(
      `${whitespaceOnlyContent.length} characters`,
    );
    expect(await whitespaceMessage.locator(".activity-card__raw").textContent()).toBe(
      whitespaceOnlyContent,
    );
    await whitespaceMessage.getByRole("button", { name: "Copy all" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __clipboardWrites?: Array<{ text: string }> })
              .__clipboardWrites?.[1]?.text,
        ),
      )
      .toBe(whitespaceOnlyContent);
  });

  test("custom message rendering is additive and begins only after disclosure", async ({
    page,
  }) => {
    const rawContent = [
      {
        type: "text",
        text: "Raw extension message",
        textSignature: "RAW FIRST SIGNATURE",
      },
      {
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
        assetId: "RAW MIDDLE IMAGE",
      },
      {
        type: "text",
        text: "RAW MESSAGE FINAL SENTINEL",
        textSignature: "RAW LAST SIGNATURE",
      },
    ];
    await seedHistory(page, [
      {
        id: "rendered-custom-message",
        type: "custom_message",
        data: {
          content: "Raw extension message\nRAW MESSAGE FINAL SENTINEL",
          rawContent,
          customType: "render-message-sentinel",
          timestamp: 1_786_000_000_123,
          details: { retained: "MESSAGE DETAILS FINAL SENTINEL" },
        },
      },
    ]);
    await installClipboardSpy(page);
    await installSessionQuerySpy(page, "render_message");

    const card = page.locator(".tool-card").filter({ hasText: "render-message-sentinel" });
    const header = card.getByRole("button", {
      name: /^extension activity details — render-message-sentinel/u,
    });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(
        () => (window as unknown as { __matchingSessionQueries?: number }).__matchingSessionQueries,
      ),
    ).toBe(0);

    await header.click();

    await expect(section(card, "Message")).toContainText("RAW MESSAGE FINAL SENTINEL");
    await expect(section(card, "Metadata")).toContainText("MESSAGE DETAILS FINAL SENTINEL");
    const completeRawContent = section(card, "Raw content");
    await expect(completeRawContent).toContainText("RAW FIRST SIGNATURE");
    await expect(completeRawContent).toContainText("RAW MIDDLE IMAGE");
    await expect(completeRawContent).toContainText("RAW LAST SIGNATURE");
    const renderedRawContent =
      (await completeRawContent.locator(".tool-card__structured-value").textContent()) ?? "";
    expect(renderedRawContent.indexOf("RAW FIRST SIGNATURE")).toBeLessThan(
      renderedRawContent.indexOf("RAW MIDDLE IMAGE"),
    );
    expect(renderedRawContent.indexOf("RAW MIDDLE IMAGE")).toBeLessThan(
      renderedRawContent.indexOf("RAW LAST SIGNATURE"),
    );
    await completeRawContent.getByRole("button", { name: "Copy all" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __clipboardWrites?: Array<{ text: string }> })
              .__clipboardWrites?.[0]?.text,
        ),
      )
      .toBe(JSON.stringify(rawContent, null, 2));
    await expect(section(card, "Extension view")).toContainText("Extension status");
    await expect(section(card, "Extension view")).toContainText(/rendered at \d+ columns/);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __matchingSessionQueries?: number }).__matchingSessionQueries,
        ),
      )
      .toBeGreaterThan(0);
    await expect(card.locator("details")).toHaveCount(0);
  });

  test("opening a tall card anchors the clicked header instead of following the new bottom", async ({
    page,
  }) => {
    const longOutput = Array.from(
      { length: 220 },
      (_, index) => `anchored-output-${String(index + 1).padStart(3, "0")}`,
    ).join("\n");
    await seedHistory(page, [
      ...Array.from({ length: 35 }, (_, index) => ({
        id: `anchor-user-${index}`,
        type: "user",
        data: { content: `scroll anchor setup ${index}` },
      })),
      {
        id: "anchor-tool",
        type: "tool_call",
        data: {
          toolCallId: "anchor-call",
          toolName: "anchored_long_output",
          input: { path: "anchor.txt" },
          outputText: longOutput,
          isError: false,
          isStreaming: false,
        },
      },
    ]);

    const transcript = page.locator(".transcript-view");
    const card = page.locator(".tool-card").filter({ hasText: "anchored_long_output" });
    const header = card.getByRole("button", {
      name: /^anchored_long_output tool call details — anchor\.txt/u,
    });
    await expect(header).toBeVisible();
    await transcript.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(100);

    const before = await transcript.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
    const viewportBefore = await transcript.boundingBox();
    const headerBefore = await header.boundingBox();
    expect(viewportBefore).not.toBeNull();
    expect(headerBefore).not.toBeNull();
    expect(headerBefore!.y).toBeGreaterThanOrEqual(viewportBefore!.y - 1);
    expect(headerBefore!.y + headerBefore!.height).toBeLessThanOrEqual(
      viewportBefore!.y + viewportBefore!.height + 1,
    );

    await header.click();
    await expect(card.locator(".tool-card__body")).toBeVisible();
    await expect(card.getByRole("region", { name: "output (220 lines)" })).toBeVisible();
    await page.waitForTimeout(100);

    const after = await transcript.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    }));
    expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight + 200);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
    const viewportAfter = await transcript.boundingBox();
    const headerAfter = await header.boundingBox();
    expect(viewportAfter).not.toBeNull();
    expect(headerAfter).not.toBeNull();
    expect(headerAfter!.y).toBeGreaterThanOrEqual(viewportAfter!.y - 1);
    expect(headerAfter!.y + headerAfter!.height).toBeLessThanOrEqual(
      viewportAfter!.y + viewportAfter!.height + 1,
    );
  });
});

test.describe("large tool output inspector", () => {
  test("expanded long output is complete, copyable, and virtualized", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto("/?toolOutput=1");
    await waitForPreview(page);

    const expectedOutput = Array.from({ length: 180 }, (_, i) => {
      const n = String(i + 1).padStart(3, "0");
      return `preview-line-${n}  ${"0123456789abcdef ".repeat((i % 7) + 1)}done`;
    }).join("\n");
    const card = page.locator(".tool-card").filter({ hasText: "generate-report" }).first();
    const header = card.getByRole("button", { name: /^bash tool call details — /u });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
    await expect(card).not.toContainText("preview-line-001");

    await installClipboardSpy(page);
    await header.click();

    const metadata = section(card, "Result metadata");
    await expect(metadata).toContainText('"outputLines": 180');
    await expect(metadata).toContainText('"totalLines": 4200');
    await expect(metadata).toContainText("/tmp/pi-bash-preview-full-output.log");
    await expect(card.locator(".tool-card__output-panel")).toBeVisible();
    const outputRegion = card.getByRole("region", { name: "output (180 lines)" });
    await expect(outputRegion).toHaveAttribute("tabindex", "0");
    await outputRegion.focus();
    await expect(outputRegion).toBeFocused();
    await expect(card.locator(".tool-card__output-line").first()).toContainText("preview-line-001");
    await expect.poll(() => card.locator(".tool-card__output-line").count()).toBeLessThan(90);
    await expect(card.locator("details")).toHaveCount(0);

    await card
      .locator(".tool-card__output-panel")
      .getByRole("button", { name: "Copy all" })
      .click();
    await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __clipboardWrites?: Array<{ text: string }> })
              .__clipboardWrites?.[0]?.text,
        ),
      )
      .toBe(expectedOutput);

    await outputRegion.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(card.locator(".tool-card__output-line").last()).toContainText("preview-line-180");
    await expect(card.locator(".scroll-fade-frame")).toHaveCount(0);
  });
});

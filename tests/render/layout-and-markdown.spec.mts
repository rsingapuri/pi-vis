import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

interface PreviewStoreState {
  activeSessionId: string;
  sessions: Map<
    string,
    {
      widgets?: Map<string, string[]>;
      authorityProjection?: {
        rendererGeneration?: number;
        owner?: { hostInstanceId: string; sessionEpoch: number };
        publicationSequence?: number;
        semantic:
          | {
              state: "following";
              cursor: {
                hostInstanceId: string;
                sessionEpoch: number;
                transportSequence: number;
                snapshotSequence: number;
              };
            }
          | { state: string };
        authoritativeSnapshot?: {
          owner: { hostInstanceId: string; sessionEpoch: number };
          snapshotSequence: number;
          sdk: Record<string, unknown>;
          activity: Record<string, unknown>;
          [key: string]: unknown;
        };
      };
    }
  >;
  setSessionName: (sessionId: string, name: string) => void;
  seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
  applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
  applyAuthorityPublication: (publication: Record<string, unknown>) => void;
  markAuthorityUnavailable: (sessionId: string, reason: string) => void;
}

async function setLongTitle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
      .__pivisStore;
    const state = store.getState();
    state.setSessionName(
      state.activeSessionId,
      "A very long session title that should fade instead of forcing the application grid wider than the viewport when the sidebar is collapsed",
    );
  });
}

async function seedHorizontalRuleMessage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
      .__pivisStore;
    const state = store.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "hr-assistant",
        type: "assistant",
        data: { content: "Before\n\n* * *\n\nAfter" },
      },
    ]);
  });
}

async function seedHierarchicalMarkdownMessage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
      .__pivisStore;
    const state = store.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "hierarchical-markdown-assistant",
        type: "assistant",
        data: {
          thinking: "# Thinking H1\n\n> ## Thinking quoted H2",
          content: [
            "# H1",
            "## H2",
            "### H3",
            "#### H4",
            "##### H5",
            "###### H6",
            "",
            "Body paragraph for typography.",
            "",
            "> # Quoted H1",
            "> ## Quoted H2",
            "> Paragraph with `inline code`.",
            "",
            "- List item",
            "  > ### Heading in quote in list",
          ].join("\n"),
        },
      },
    ]);
  });
}

async function seedMarkdownLinks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
      .__pivisStore;
    const state = store.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "markdown-links-assistant",
        type: "assistant",
        data: {
          content: [
            "Read [the **nested docs**](https://example.com/guide?q=pi#start).",
            "[![linked diagram](data:image/png;base64,dGh1bWI=)](https://example.com/diagram)",
            "[unsafe target](javascript:alert(1))",
          ].join("\n\n"),
        },
      },
    ]);
    Reflect.set(window, "__previewExternalLinks", []);
  });
}

test.describe("layout overflow and markdown separators", () => {
  test("dropping an operating-system file stages it in the composer", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    // File staging is runtime-backed even though the textarea is intentionally
    // usable before authority attaches. Wait for the same readiness gate as
    // the attachment button before asserting the enabled drop treatment.
    await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });

    await page.locator(".composer").evaluate((composer) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["drop content"], "dropped-notes.txt", { type: "text/plain" }));
      Reflect.set(window, "__pivisDropTransfer", transfer);
      composer.dispatchEvent(
        new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await expect(page.locator(".composer__file-drop")).toContainText("Drop files to attach");
    await page.locator(".composer").evaluate((composer) => {
      const transfer = Reflect.get(window, "__pivisDropTransfer") as DataTransfer;
      composer.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      Reflect.deleteProperty(window, "__pivisDropTransfer");
    });

    await expect(page.locator(".composer__file-drop")).toHaveCount(0);
    await expect(page.locator(".composer__attachment-item--file")).toHaveCount(1);
    await expect(page.locator(".composer__file-attachment")).toHaveAttribute(
      "title",
      "dropped-notes.txt",
    );
  });

  test("shell drafts replace the attachment affordance without moving the insertion edge", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const composer = page.locator(".composer");
    const textarea = composer.locator(".composer__textarea");
    const attach = composer.locator(".composer__attach-btn");
    await expect(attach).toBeEnabled({ timeout: 20_000 });
    const ordinaryAffordance = await attach.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return { color: style.color, fontFamily: style.fontFamily, width: bounds.width };
    });
    const accentColor = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    const ordinaryInsertionEdge = await textarea.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.getBoundingClientRect().left +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.paddingLeft)
      );
    });

    await composer.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["kept"], "kept.txt", { type: "text/plain" }));
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await expect(composer.locator(".composer__attachment-item")).toHaveCount(1);

    await textarea.fill("!echo ready");
    const prefix = composer.locator(".composer__shell-prefix");
    await expect(prefix).toHaveText("!");
    await expect(attach).toHaveCount(0);
    await expect(composer.locator(".composer__attachment-item")).toHaveCount(0);
    await expect(composer.locator(".composer__shell-guidance")).toHaveCount(0);
    await expect(textarea).toHaveClass(/composer__textarea--shell-prefix-1/);
    const includedInsertionEdge = await textarea.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.getBoundingClientRect().left + Number.parseFloat(style.borderLeftWidth);
    });
    expect(Math.abs(includedInsertionEdge - ordinaryInsertionEdge)).toBeLessThan(0.5);

    await textarea.fill("!!echo ready");
    await expect(prefix).toHaveText("!!");
    await expect(textarea).toHaveClass(/composer__textarea--shell-prefix-2/);
    const excludedInsertionEdge = await textarea.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.getBoundingClientRect().left + Number.parseFloat(style.borderLeftWidth);
    });
    expect(Math.abs(excludedInsertionEdge - ordinaryInsertionEdge)).toBeLessThan(0.5);
    expect(Math.abs(excludedInsertionEdge - includedInsertionEdge)).toBeLessThan(0.5);
    const prefixBounds = await prefix.boundingBox();
    if (!prefixBounds) throw new Error("Shell prefix has no fixed-slot geometry");
    expect(Math.abs(prefixBounds.width - ordinaryAffordance.width)).toBeLessThan(0.5);

    const shellTypography = await composer.evaluate((element) => {
      const prefixStyle = getComputedStyle(element.querySelector(".composer__shell-prefix")!);
      const textareaStyle = getComputedStyle(element.querySelector(".composer__textarea")!);
      return {
        prefixColor: prefixStyle.color,
        prefixFontFamily: prefixStyle.fontFamily,
        commandFontFamily: textareaStyle.fontFamily,
        textIndent: textareaStyle.textIndent,
      };
    });
    expect(shellTypography.prefixColor).toBe(accentColor);
    expect(shellTypography.prefixColor).not.toBe(ordinaryAffordance.color);
    expect(shellTypography.prefixFontFamily).toBe(ordinaryAffordance.fontFamily);
    expect(shellTypography.commandFontFamily).not.toBe(shellTypography.prefixFontFamily);
    expect(shellTypography.textIndent).not.toBe("0px");

    await textarea.fill("ordinary message");
    await expect(prefix).toHaveCount(0);
    await expect(attach).toBeVisible();
    await expect(composer.locator(".composer__attachment-item")).toHaveCount(1);
  });

  test("clipped shell prefixes preserve native textarea editing state", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const composer = page.locator(".composer");
    const textarea = composer.locator(".composer__textarea");
    const prefix = composer.locator(".composer__shell-prefix");
    await expect(textarea).toBeEnabled({ timeout: 20_000 });

    await textarea.fill("ls");
    await textarea.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(0, 0);
    });
    await page.keyboard.type("!");
    await expect(textarea).toHaveValue("!ls");
    await expect(prefix).toHaveText("!");
    await expect
      .poll(() =>
        textarea.evaluate((element) => ({
          start: (element as HTMLTextAreaElement).selectionStart,
          end: (element as HTMLTextAreaElement).selectionEnd,
        })),
      )
      .toEqual({ start: 1, end: 1 });

    await page.keyboard.press("ControlOrMeta+z");
    await expect(textarea).toHaveValue("ls");
    await expect(prefix).toHaveCount(0);

    await textarea.fill("!!ls");
    await textarea.press("Home");
    await expect(prefix.locator(".composer__shell-prefix-caret")).toHaveCount(1);
    await textarea.press("Shift+ArrowRight");
    await textarea.press("Shift+ArrowRight");
    await expect(prefix.locator(".composer__shell-prefix-char--selected")).toHaveCount(2);
    await expect(prefix.locator(".composer__shell-prefix-caret")).toHaveCount(0);

    const prefixText = prefix.locator(".composer__shell-prefix-text");
    const prefixBounds = await prefixText.boundingBox();
    if (!prefixBounds) throw new Error("shell prefix has no pointer geometry");
    await page.mouse.click(prefixBounds.x + 1, prefixBounds.y + prefixBounds.height / 2);
    await expect
      .poll(() =>
        textarea.evaluate((element) => ({
          start: (element as HTMLTextAreaElement).selectionStart,
          end: (element as HTMLTextAreaElement).selectionEnd,
        })),
      )
      .toEqual({ start: 0, end: 0 });
    await expect(prefix.locator(".composer__shell-prefix-caret")).toHaveCount(1);

    const commandBounds = await textarea.boundingBox();
    if (!commandBounds) throw new Error("shell textarea has no pointer geometry");
    await page.mouse.click(commandBounds.x + 48, commandBounds.y + commandBounds.height / 2);
    await expect
      .poll(() =>
        textarea.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return input.selectionStart === input.selectionEnd && input.selectionStart > 2;
        }),
      )
      .toBe(true);
    await expect(prefix.locator(".composer__shell-prefix-caret")).toHaveCount(0);

    await page.mouse.move(prefixBounds.x + 1, prefixBounds.y + prefixBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      prefixBounds.x + prefixBounds.width - 1,
      prefixBounds.y + prefixBounds.height / 2,
    );
    await page.mouse.up();
    await expect
      .poll(() =>
        textarea.evaluate((element) => ({
          start: (element as HTMLTextAreaElement).selectionStart,
          end: (element as HTMLTextAreaElement).selectionEnd,
        })),
      )
      .toEqual({ start: 0, end: 2 });
    await expect(prefix.locator(".composer__shell-prefix-char--selected")).toHaveCount(2);

    const textareaBounds = await textarea.boundingBox();
    if (!textareaBounds) throw new Error("shell textarea has no pointer geometry");
    await page.mouse.move(prefixBounds.x + 1, prefixBounds.y + prefixBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(textareaBounds.x + 48, textareaBounds.y + textareaBounds.height / 2);
    await page.mouse.up();
    await expect
      .poll(() =>
        textarea.evaluate((element) => ({
          start: (element as HTMLTextAreaElement).selectionStart,
          end: (element as HTMLTextAreaElement).selectionEnd,
        })),
      )
      .toMatchObject({ start: 0 });
    expect(
      await textarea.evaluate((element) => (element as HTMLTextAreaElement).selectionEnd),
    ).toBeGreaterThan(2);

    await textarea.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(2, 2);
    });
    await page.keyboard.press("Backspace");
    await expect(textarea).toHaveValue("!ls");
    await expect(prefix).toHaveText("!");
    await page.keyboard.press("Backspace");
    await expect(textarea).toHaveValue("ls");
    await expect(prefix).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+z");
    await expect(textarea).toHaveValue("!ls");
    await expect(prefix).toHaveText("!");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(textarea).toHaveValue("!!ls");
    await expect(prefix).toHaveText("!!");

    await textarea.press("ControlOrMeta+a");
    await expect
      .poll(() =>
        textarea.evaluate((element) => ({
          start: (element as HTMLTextAreaElement).selectionStart,
          end: (element as HTMLTextAreaElement).selectionEnd,
          value: (element as HTMLTextAreaElement).value,
        })),
      )
      .toEqual({ start: 0, end: 4, value: "!!ls" });

    await textarea.fill("!!!echo ready");
    await expect(textarea).toHaveValue("!!!echo ready");
    await expect(prefix).toHaveText("!!");
    await expect(textarea).toHaveClass(/composer__textarea--shell-prefix-2/);
  });

  test("prefix drags autoscroll through wrapped tabs and wide glyphs", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const composer = page.locator(".composer");
    const textarea = composer.locator(".composer__textarea");
    const prefix = composer.locator(".composer__shell-prefix");
    await expect(textarea).toBeEnabled({ timeout: 20_000 });

    const command = `!!${Array.from(
      { length: 28 },
      (_, index) => `printf '\\t界🙂 ${index.toString().padStart(2, "0")} wrapped shell text'`,
    ).join("\n")}`;
    await textarea.fill(command);
    await textarea.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(0, 0);
      input.scrollTop = 0;
    });
    await expect
      .poll(() =>
        textarea.evaluate(
          (element) =>
            (element as HTMLTextAreaElement).scrollHeight >
            (element as HTMLTextAreaElement).clientHeight,
        ),
      )
      .toBe(true);

    const prefixBounds = await prefix.locator(".composer__shell-prefix-text").boundingBox();
    const textareaBounds = await textarea.boundingBox();
    if (!prefixBounds || !textareaBounds) throw new Error("shell drag geometry is unavailable");
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("shell drag viewport is unavailable");
    await page.mouse.move(prefixBounds.x + 1, prefixBounds.y + prefixBounds.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.move(
      textareaBounds.x + textareaBounds.width / 2,
      Math.min(viewport.height - 2, textareaBounds.y + textareaBounds.height + 24),
      { steps: 5 },
    );
    await expect
      .poll(() =>
        textarea.evaluate((element) => ({
          start: (element as HTMLTextAreaElement).selectionStart,
          end: (element as HTMLTextAreaElement).selectionEnd,
        })),
      )
      .toEqual({ start: 0, end: command.length });
    await page.mouse.up();
    await expect
      .poll(() =>
        textarea.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return input.scrollTop / (input.scrollHeight - input.clientHeight);
        }),
      )
      .toBeGreaterThan(0.9);
  });

  test("a recoverable Shell semantic fence never flashes the Composer into its slot", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const store = (
              window as unknown as {
                __pivisStore: {
                  getState: () => PreviewStoreState;
                };
              }
            ).__pivisStore;
            const state = store.getState();
            const projection = state.sessions.get(state.activeSessionId)?.authorityProjection;
            return (
              projection?.owner !== undefined &&
              projection.semantic.state === "following" &&
              projection.authoritativeSnapshot !== undefined
            );
          }),
        { timeout: 20_000 },
      )
      .toBe(true);

    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __pivisStore: {
            getState: () => PreviewStoreState;
            setState: (partial: Partial<PreviewStoreState>) => void;
          };
        }
      ).__pivisStore;
      const state = store.getState();
      const sessionId = state.activeSessionId;
      const session = state.sessions.get(sessionId);
      const projection = session?.authorityProjection;
      if (
        !session ||
        !projection?.owner ||
        projection.semantic.state !== "following" ||
        !projection.authoritativeSnapshot
      ) {
        throw new Error("Preview authority did not attach");
      }
      const originalInvoke = window.pivis.invoke.bind(window.pivis);
      Reflect.set(window.pivis, "invoke", (channel: string, input: unknown) =>
        channel === "session.authorityAttach"
          ? new Promise(() => {})
          : originalInvoke(channel as never, input as never),
      );

      const executionId = "render-fenced-shell";
      const startedAt = Date.now();
      state.applyEvent(sessionId, {
        type: "bash_execution_start",
        id: executionId,
        command: "interactive-command",
        excludeFromContext: false,
        pty: true,
        startedAt,
      });

      const cursor = projection.semantic.cursor;
      const activeSnapshot = {
        ...projection.authoritativeSnapshot,
        snapshotSequence: projection.authoritativeSnapshot.snapshotSequence + 1,
        sdk: {
          ...projection.authoritativeSnapshot.sdk,
          isStreaming: false,
          isIdle: false,
          isBashRunning: true,
        },
        activity: {
          ...projection.authoritativeSnapshot.activity,
          bash: {
            kind: "bash",
            state: "active",
            intentId: executionId,
            command: "interactive-command",
            startedAt,
            excludeFromContext: false,
            pty: true,
            inputReady: true,
            terminalMode: "compact",
          },
        },
      };
      const publicationSequence = (projection.publicationSequence ?? 0) + 1;
      const transportSequence = cursor.transportSequence + 1;
      state.applyAuthorityPublication({
        sessionId,
        rendererGeneration: projection.rendererGeneration ?? 0,
        publicationSequence,
        plane: "semantic",
        owner: projection.owner,
        payload: {
          owner: projection.owner,
          transportSequence,
          frameId: "render-shell-active",
          records: [],
          terminalSnapshot: activeSnapshot,
        },
      });
      state.applyAuthorityPublication({
        sessionId,
        rendererGeneration: projection.rendererGeneration ?? 0,
        publicationSequence: publicationSequence + 2,
        plane: "semantic",
        owner: projection.owner,
        payload: {
          owner: projection.owner,
          transportSequence: transportSequence + 1,
          frameId: "render-shell-gap",
          records: [],
          terminalSnapshot: {
            ...activeSnapshot,
            snapshotSequence: activeSnapshot.snapshotSequence + 1,
          },
        },
      });
      const latestState = store.getState();
      const latestSessions = new Map(latestState.sessions);
      latestSessions.set(sessionId, {
        ...latestSessions.get(sessionId)!,
        widgets: new Map([["usage", ["Codex / 11% (6d 6h 17m)"]]]),
      });
      store.setState({ sessions: latestSessions });
    });

    const shell = page.locator(".shell-terminal");
    await expect(shell).toBeVisible();
    const resizeHandle = page.getByRole("separator", { name: /Resize shell terminal/ });
    await expect(resizeHandle).toBeVisible();
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "50");
    await expect(
      shell.getByRole("button", { name: /(?:Interrupt|Force stop) shell command/ }),
    ).toHaveCount(0);
    const shellViewportGeometry = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".shell-terminal__viewport");
      const session = document.querySelector<HTMLElement>(".app__session");
      if (!viewport || !session) return null;
      return {
        viewportHeight: viewport.getBoundingClientRect().height,
        sessionHeight: session.getBoundingClientRect().height,
      };
    });
    expect(shellViewportGeometry).not.toBeNull();
    expect(shellViewportGeometry!.viewportHeight).toBeGreaterThan(
      shellViewportGeometry!.sessionHeight * 0.35,
    );
    expect(shellViewportGeometry!.viewportHeight).toBeLessThanOrEqual(
      shellViewportGeometry!.sessionHeight * 0.5 + 12,
    );

    // The shared resize affordance remains live while authority is fenced:
    // keyboard input, pointer drag, and double-click reset all resize the
    // restoring viewport itself instead of waiting for xterm to mount.
    await resizeHandle.focus();
    await resizeHandle.press("ArrowUp");
    await expect(resizeHandle).toBeFocused();
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "55");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.pivis
            .invoke("settings.get", undefined)
            .then((settings) => settings.customPanelHeightFraction),
        ),
      )
      .toBe(0.55);
    const keyboardHeight = await shell
      .locator(".shell-terminal__viewport")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(keyboardHeight).toBeGreaterThan(shellViewportGeometry!.viewportHeight + 20);

    const handleBounds = await resizeHandle.boundingBox();
    expect(handleBounds).not.toBeNull();
    const shellBottom = await shell.evaluate((element) => element.getBoundingClientRect().bottom);
    const targetY = shellBottom - shellViewportGeometry!.sessionHeight * 0.75;
    await page.mouse.move(
      handleBounds!.x + handleBounds!.width / 2,
      handleBounds!.y + handleBounds!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, targetY, { steps: 8 });
    const liveDraggedHeight = await shell
      .locator(".shell-terminal__viewport")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(liveDraggedHeight).toBeGreaterThan(keyboardHeight + 80);
    // Pointer movement is live presentation; persistence waits for mouseup.
    expect(
      await page.evaluate(() =>
        window.pivis
          .invoke("settings.get", undefined)
          .then((settings) => settings.customPanelHeightFraction),
      ),
    ).toBe(0.55);
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.pivis
            .invoke("settings.get", undefined)
            .then((settings) => settings.customPanelHeightFraction),
        ),
      )
      .toBeGreaterThan(0.65);

    await resizeHandle.dblclick();
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "50");
    await expect
      .poll(() =>
        shell
          .locator(".shell-terminal__viewport")
          .evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBeLessThanOrEqual(shellViewportGeometry!.viewportHeight + 4);

    const dock = page.locator(".dock");
    await expect(dock).toBeVisible();
    await dock.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const connectedStack = await page.evaluate(() => {
      const dockElement = document.querySelector<HTMLElement>(".dock");
      const shellElement = document.querySelector<HTMLElement>(".shell-terminal");
      if (!dockElement || !shellElement) return null;
      const dockBounds = dockElement.getBoundingClientRect();
      const shellBounds = shellElement.getBoundingClientRect();
      const shellStyle = getComputedStyle(shellElement);
      return {
        leftDelta: Math.abs(dockBounds.left - shellBounds.left),
        rightDelta: Math.abs(dockBounds.right - shellBounds.right),
        seamDelta: Math.abs(dockBounds.bottom - shellBounds.top),
        topLeftRadius: shellStyle.borderTopLeftRadius,
        topRightRadius: shellStyle.borderTopRightRadius,
      };
    });
    expect(connectedStack).toMatchObject({
      topLeftRadius: "0px",
      topRightRadius: "0px",
    });
    expect(connectedStack!.leftDelta).toBeLessThan(0.2);
    expect(connectedStack!.rightDelta).toBeLessThan(0.2);
    expect(connectedStack!.seamDelta).toBeLessThan(0.2);
    await expect(shell).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".composer")).toHaveCount(0);
    await page.waitForTimeout(1_250);
    await expect(shell).toBeVisible();
    await expect(page.locator(".composer")).toHaveCount(0);

    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __pivisStore: {
            getState: () => PreviewStoreState;
          };
        }
      ).__pivisStore;
      const state = store.getState();
      state.markAuthorityUnavailable(state.activeSessionId, "render_transport_lost");
    });
    await expect(shell).toHaveCount(0);
    await expect(page.locator(".composer")).toBeVisible();
  });

  test("collapsing the sidebar with a fading long title does not widen or clip the main grid", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 780, height: 620 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

    await setLongTitle(page);
    await expect(page.locator(".fade-text[data-overflow='true']").first()).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator(".app--sidebar-collapsed")).toBeVisible();

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const viewport = window.innerWidth;
          const selectors = [".titlebar", ".app__main", ".transcript-region", ".composer"];
          return selectors.map((selector) => {
            const el = document.querySelector(selector) as HTMLElement | null;
            if (!el) return { selector, ok: false, left: Number.NaN, right: Number.NaN, viewport };
            const rect = el.getBoundingClientRect();
            return {
              selector,
              ok: rect.left >= -1 && rect.right <= viewport + 1,
              left: rect.left,
              right: rect.right,
              viewport,
            };
          });
        });
      })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ selector: ".titlebar", ok: true }),
          expect.objectContaining({ selector: ".app__main", ok: true }),
          expect.objectContaining({ selector: ".transcript-region", ok: true }),
          expect.objectContaining({ selector: ".composer", ok: true }),
        ]),
      );
  });

  test("markdown thematic breaks render as the styled separator, not a default thick rule", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 620 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await seedHorizontalRuleMessage(page);

    const hr = page.locator(".transcript-block__content hr");
    await expect(hr).toHaveCount(1);
    await expect
      .poll(() =>
        hr.evaluate((el) => {
          const style = getComputedStyle(el as HTMLElement);
          return {
            height: style.height,
            borderTopWidth: style.borderTopWidth,
            backgroundImage: style.backgroundImage,
          };
        }),
      )
      .toEqual(
        expect.objectContaining({
          height: "1px",
          borderTopWidth: "0px",
          backgroundImage: expect.stringContaining("linear-gradient"),
        }),
      );
  });

  test("transcript links open externally without navigating the renderer", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await seedMarkdownLinks(page);

    const originalUrl = page.url();
    const docsLink = page.getByRole("link", { name: "the nested docs" });
    await expect(docsLink).toHaveAttribute("target", "_blank");
    await docsLink.locator("strong").click({ modifiers: ["Meta", "Shift"] });
    await expect.poll(() => page.url()).toBe(originalUrl);
    await docsLink.press("Enter");
    await expect.poll(() => page.url()).toBe(originalUrl);

    const linkedImage = page.getByRole("link", { name: "linked diagram" });
    await linkedImage.click({ button: "middle" });
    await expect.poll(() => page.url()).toBe(originalUrl);

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (Reflect.get(window, "__previewExternalLinks") as Array<{ url: string }> | undefined) ??
            [],
        ),
      )
      .toEqual([
        { url: "https://example.com/guide?q=pi#start" },
        { url: "https://example.com/guide?q=pi#start" },
        { url: "https://example.com/diagram" },
      ]);
    await expect(page.getByText("unsafe target", { exact: true })).not.toHaveAttribute("href");
    await expect(page.getByRole("link", { name: "unsafe target" })).toHaveCount(0);
  });

  test("reading font settings stay isolated from interface and Composer typography", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await seedHierarchicalMarkdownMessage(page);

    await page.getByRole("button", { name: "Settings" }).click();
    const chooseFont = async (label: string, family: string): Promise<void> => {
      const trigger = page.getByRole("button", { name: label });
      await trigger.click();
      await page.getByRole("option", { name: family, exact: true }).click();
      await expect(trigger).toContainText(family);
    };
    await chooseFont("Title font family", "IBM Plex Mono");
    await chooseFont("Transcript header and thinking font family", "Fraunces");
    await chooseFont("Transcript body font family", "IBM Plex Serif");
    await page.getByRole("button", { name: "Close settings" }).click();
    const composer = page.locator(".composer__textarea");
    await composer.fill("/changelog");
    await composer.press("Enter");
    await expect(page.locator(".changelog-modal__body h1")).toHaveText("Preview changelog heading");

    const families = await page.evaluate(() => {
      const family = (selector: string) =>
        getComputedStyle(document.querySelector(selector) as HTMLElement).fontFamily;
      const root = document.documentElement.style;
      return {
        title: family(".session-header__name-btn"),
        heading: family(".transcript-block__content.markdown-body > h1"),
        thinking: family(".thinking-block.markdown-body"),
        body: family(".transcript-block__content.markdown-body > p"),
        composer: family(".composer__textarea"),
        control: family(".sidebar__settings-btn"),
        changelogHeading: family(".changelog-modal__body h1"),
        changelogBody: family(".changelog-modal__body p"),
        titleToken: root.getPropertyValue("--font-title"),
        headerToken: root.getPropertyValue("--font-transcript-heading"),
        bodyToken: root.getPropertyValue("--font-transcript-body"),
        interfaceToken: root.getPropertyValue("--font-display"),
      };
    });

    expect(families.title).toContain("IBM Plex Mono");
    expect(families.heading).toContain("Fraunces");
    expect(families.thinking).toContain("Fraunces");
    expect(families.body).toContain("IBM Plex Serif");
    expect(families.composer).toContain("Inter");
    expect(families.control).toContain("Inter");
    expect(families.changelogHeading).toContain("IBM Plex Serif");
    expect(families.changelogHeading).not.toContain("Fraunces");
    expect(families.changelogBody).toContain("Inter");
    expect(families.titleToken).toContain("var(--font-accent)");
    expect(families.headerToken).toContain("IBM Plex Serif");
    expect(families.headerToken).toContain("var(--font-display)");
    expect(families.bodyToken).toContain("var(--font-display)");
    expect(families.interfaceToken).not.toContain("IBM Plex Serif");
    expect(families.interfaceToken).not.toContain("IBM Plex Mono");
  });

  test("failed reading-font saves restore the persisted choice without an unhandled rejection", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

    await page.evaluate(() => {
      const originalInvoke = Reflect.get(window.pivis, "invoke") as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const unhandledReasons: string[] = [];
      window.addEventListener("unhandledrejection", (event) => {
        unhandledReasons.push(String(event.reason));
        event.preventDefault();
      });
      Reflect.set(window, "__fontSaveUnhandledReasons", unhandledReasons);
      Reflect.set(window.pivis, "invoke", (...args: unknown[]) => {
        if (args[0] === "settings.set") {
          return Promise.reject(new Error("settings file is read-only"));
        }
        return originalInvoke.apply(window.pivis, args);
      });
    });

    await page.getByRole("button", { name: "Settings" }).click();
    const titleFont = page.getByRole("button", { name: "Title font family" });
    await expect(titleFont).toContainText("Fraunces");
    await titleFont.click();
    await page.getByRole("option", { name: "IBM Plex Mono", exact: true }).click();

    await expect(page.getByRole("alert")).toHaveText(
      "Couldn’t save reading typography. The last saved fonts were restored.",
    );
    await expect(titleFont).toContainText("Fraunces");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(
      await page.evaluate(
        () => (Reflect.get(window, "__fontSaveUnhandledReasons") as string[] | undefined) ?? [],
      ),
    ).toEqual([]);
  });

  test("transcript markdown headings compose with quote and thinking voice", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await seedHierarchicalMarkdownMessage(page);

    await expect(page.locator(".transcript-block__content.markdown-body h4")).toHaveText("H4");
    await expect(page.locator(".transcript-block__content.markdown-body h6")).toHaveText("H6");

    await expect
      .poll(() =>
        page.evaluate(() => {
          const px = (selector: string) => {
            const el = document.querySelector(selector) as HTMLElement | null;
            return el ? Number.parseFloat(getComputedStyle(el).fontSize) : 0;
          };
          return {
            h1: px(".transcript-block__content.markdown-body > h1"),
            h2: px(".transcript-block__content.markdown-body > h2"),
            h3: px(".transcript-block__content.markdown-body > h3"),
            h4: px(".transcript-block__content.markdown-body > h4"),
            h5: px(".transcript-block__content.markdown-body > h5"),
            h6: px(".transcript-block__content.markdown-body > h6"),
          };
        }),
      )
      .toEqual(
        expect.objectContaining({
          h1: expect.any(Number),
          h2: expect.any(Number),
          h3: expect.any(Number),
          h4: expect.any(Number),
          h5: expect.any(Number),
          h6: expect.any(Number),
        }),
      );

    const headingSizes = await page.evaluate(() => {
      const px = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement;
        return Number.parseFloat(getComputedStyle(el).fontSize);
      };
      return {
        h1: px(".transcript-block__content.markdown-body > h1"),
        h2: px(".transcript-block__content.markdown-body > h2"),
        h3: px(".transcript-block__content.markdown-body > h3"),
        h4: px(".transcript-block__content.markdown-body > h4"),
        h5: px(".transcript-block__content.markdown-body > h5"),
        h6: px(".transcript-block__content.markdown-body > h6"),
      };
    });
    expect(headingSizes.h1).toBeGreaterThan(headingSizes.h2);
    expect(headingSizes.h2).toBeGreaterThan(headingSizes.h3);
    expect(headingSizes.h3).toBeGreaterThan(headingSizes.h4);
    expect(headingSizes.h4).toBeGreaterThan(headingSizes.h5);
    expect(headingSizes.h5).toBeGreaterThan(headingSizes.h6);

    const composition = await page.evaluate(() => {
      const styles = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector) as HTMLElement);
        return { color: style.color, fontFamily: style.fontFamily, fontStyle: style.fontStyle };
      };
      return {
        quote: styles(".transcript-block__content.markdown-body blockquote"),
        quotedHeading: styles(".transcript-block__content.markdown-body blockquote h2"),
        thinking: styles(".thinking-block.markdown-body"),
        thinkingHeading: styles(".thinking-block.markdown-body > h1"),
        thinkingQuote: styles(".thinking-block.markdown-body blockquote"),
        thinkingQuotedHeading: styles(".thinking-block.markdown-body blockquote h2"),
      };
    });

    expect(composition.quotedHeading.color).toBe(composition.quote.color);
    expect(composition.quotedHeading.fontStyle).toBe(composition.quote.fontStyle);
    expect(composition.thinkingHeading.color).toBe(composition.thinking.color);
    expect(composition.thinkingHeading.fontFamily).toBe(composition.thinking.fontFamily);
    expect(composition.thinkingHeading.fontStyle).toBe(composition.thinking.fontStyle);
    expect(composition.thinkingQuotedHeading.color).toBe(composition.thinkingQuote.color);
    expect(composition.thinkingQuotedHeading.fontFamily).toBe(composition.thinking.fontFamily);
    expect(composition.thinkingQuotedHeading.fontStyle).toBe(composition.thinkingQuote.fontStyle);
  });
});

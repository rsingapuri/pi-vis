/**
 * Render test: the factory-`setWidget` unified-TUI panel mounts UnifiedTuiHost
 * and renders streamed panel_data into xterm.js.
 *
 * Drives the REAL renderer (served by `npm run dev:renderer` with the stubbed
 * window.pivis) with headless chromium — no Electron, no real pi. The preview
 * stub (?unified=1) emits the panel_open{unified} + panel_data events an
 * extension's factory setWidget produces, so this exercises the exact path:
 * session.panelEvent subscription → store handlePanelEvent → hasUnifiedPanel →
 * UnifiedTuiHost → xterm.js render. This is the regression gate for
 * "the composer was replaced by nothing" failures.
 */
import { expect, test } from "@playwright/test";

interface PreviewStoreState {
  activeSessionId: string;
  applyWorktree: (
    sessionId: string,
    result: { worktreePath: string; branch: string; name: string; base: string },
  ) => void;
}

interface PreviewHooks {
  panelInputLog: string[];
  panelResizeLog: Array<{
    panelId: number | undefined;
    cols: number | undefined;
    rows: number | undefined;
  }>;
  emitUnifiedPanelUpdate: () => void;
  openUnifiedPanel: () => void;
}

/**
 * Strip Kitty key-RELEASE sequences so a test asserts on PRESS bytes. xterm 6.1
 * with flag 2 emits a release CSI-u after every press; the real TUI filters
 * releases before the editor, and this mirrors that for byte assertions.
 */
function stripKittyReleases(s: string): string {
  return s.replace(/\x1b\[[\d:;]*:3[u~]/g, "");
}

test.describe("Unified-TUI panel (factory setWidget) — renderer", () => {
  test("mounts UnifiedTuiHost with rendered roster content, replacing the composer", async ({
    page,
  }) => {
    await page.goto("/?unified=1");
    await page.waitForLoadState("domcontentloaded");

    // The unified panel replaces the Composer in the flex slot.
    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });

    // While a factory widget is live the native composer is NOT rendered.
    await expect(page.locator(".composer__textarea")).toHaveCount(0);

    // xterm.js mounted inside the unified panel.
    await expect(panel.locator(".xterm")).toBeVisible({ timeout: 10_000 });

    // The streamed panel_data (the fake roster) rendered as glyphs in xterm.
    // The roster is emitted by preview-stub's startUnifiedPanelPreview().
    await expect(panel.locator(".xterm-rows")).toContainText("Fleet", { timeout: 15_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("swift-otter");
  });

  test("does not steal focus from an in-progress session rename when it appears", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    // Sidebar boot asynchronously adopts the real preview session; wait for
    // that keyed session subtree to settle before starting its local rename.
    await expect(page.locator(".composer__textarea")).toBeEnabled();

    await page.locator(".session-header__name-btn").click();
    const nameInput = page.locator(".session-header__name-input");
    await expect(nameInput).toBeFocused();
    await nameInput.fill("Renaming");
    await page.evaluate(() => {
      const preview = (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview;
      preview?.openUnifiedPanel();
    });

    await expect(page.locator(".unified-panel .xterm")).toBeVisible({ timeout: 20_000 });
    await expect(nameInput).toBeFocused();
    await page.keyboard.type(" safely");
    await expect(nameInput).toHaveValue("Renaming safely");
  });

  test("a short roster: card hugs the content, no scroll (trailing blanks trimmed)", async ({
    page,
  }) => {
    await page.goto("/?unified=1");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("Fleet", { timeout: 15_000 });

    // The grid tracks the content (mount holds it + a one-row sentinel); the card
    // clips down to the content. A few-row roster is well under the ~50%-column
    // cap, so the card is shorter than the mount (the gap is the trimmed blanks)
    // and is NOT scrollable (overflow hidden).
    const m = await page.evaluate(() => {
      const card = document.querySelector(".unified-panel") as HTMLElement;
      const mount = document.querySelector(".unified-panel .custom-panel__xterm") as HTMLElement;
      return {
        cardH: card.getBoundingClientRect().height,
        mountH: mount.getBoundingClientRect().height,
        overflowY: card.style.overflowY,
      };
    });
    expect(m.cardH).toBeGreaterThan(0);
    expect(m.cardH).toBeLessThan(m.mountH);
    expect(m.overflowY).toBe("hidden");
  });

  test("a tall roster: card caps at the max, scrolls, and keeps the top reachable", async ({
    page,
  }) => {
    await page.goto("/?unified=tall");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("agent-01", { timeout: 15_000 });

    // Content taller than the cap → the card caps at ~half the column and
    // scrolls (the spec's "scrollbar only past the max"). It opens scrolled to
    // the TOP so the header row is visible — the bug being guarded is the host
    // bottom-anchoring and the top scrolling out of view.
    const m = await page.evaluate(() => {
      const card = document.querySelector(".unified-panel") as HTMLElement;
      const session = document.querySelector(".app__session") as HTMLElement;
      const first = document.querySelector(
        ".unified-panel .xterm-rows > div",
      ) as HTMLElement | null;
      return {
        cardH: card.getBoundingClientRect().height,
        sessionH: session.clientHeight,
        overflowY: card.style.overflowY,
        scrollTop: card.scrollTop,
        scrollable: card.scrollHeight - card.clientHeight,
        firstRow: first?.innerText ?? "",
      };
    });
    expect(m.overflowY).toBe("auto");
    // Capped near the ~50% display max, not the full content height.
    expect(m.cardH).toBeLessThanOrEqual(m.sessionH * 0.5 + 4);
    // Scrollable, opened at the top, header in view.
    expect(m.scrollable).toBeGreaterThan(0);
    expect(m.scrollTop).toBe(0);
    expect(m.firstRow).toContain("Fleet");
  });

  test("oversized intrinsic content grows past the viewport ceiling and remains fully reachable", async ({
    page,
  }) => {
    await page.goto("/?unified=oversized");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("END OF OVERSIZED ROSTER", {
      timeout: 15_000,
    });

    const m = await page.evaluate(() => {
      const card = document.querySelector(".unified-panel") as HTMLElement;
      const session = document.querySelector(".app__session") as HTMLElement;
      const rows = [...document.querySelectorAll(".unified-panel .xterm-rows > div")];
      return {
        cardH: card.getBoundingClientRect().height,
        sessionH: session.clientHeight,
        overflowY: card.style.overflowY,
        scrollTop: card.scrollTop,
        scrollable: card.scrollHeight - card.clientHeight,
        renderedRows: rows.length,
        firstRow: (rows[0] as HTMLElement | undefined)?.innerText ?? "",
        allText: (document.querySelector(".unified-panel .xterm-rows") as HTMLElement).innerText,
      };
    });
    expect(m.overflowY).toBe("auto");
    expect(m.cardH).toBeLessThanOrEqual(m.sessionH * 0.5 + 4);
    expect(m.scrollable).toBeGreaterThan(0);
    expect(m.scrollTop).toBe(0);
    expect(m.renderedRows).toBeGreaterThan(160);
    expect(m.firstRow).toContain("Fleet (160 agents)");
    expect(m.allText).toContain("agent-001");
    expect(m.allText).toContain("agent-160");
  });

  test("1025-row intrinsic content is not mistaken for a row-coupled viewport", async ({
    page,
  }) => {
    await page.goto("/?unified=scrollback-alignment");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("END OF 1025-ROW ROSTER", {
      timeout: 30_000,
    });

    const m = await page.evaluate(() => {
      const card = document.querySelector(".unified-panel") as HTMLElement;
      const rows = [...document.querySelectorAll(".unified-panel .xterm-rows > div")];
      const preview = (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview;
      return {
        overflowY: card.style.overflowY,
        scrollable: card.scrollHeight - card.clientHeight,
        renderedRows: rows.length,
        firstRow: (rows[0] as HTMLElement).innerText,
        footerRow: (rows[1024] as HTMLElement).innerText,
        resizeCount: preview?.panelResizeLog.length ?? 0,
        lastReportedRows: preview?.panelResizeLog.at(-1)?.rows,
      };
    });
    expect(m.overflowY).toBe("auto");
    expect(m.scrollable).toBeGreaterThan(0);
    expect(m.renderedRows).toBe(1026);
    expect(m.firstRow).toContain("Boundary roster (1025 rows)");
    expect(m.footerRow).toContain("END OF 1025-ROW ROSTER");
    expect(m.resizeCount).toBeLessThanOrEqual(6);
    expect(m.lastReportedRows).toBe(1026);
  });

  for (const scenario of [
    { param: "boundary", contentRows: 2048 },
    { param: "above-boundary", contentRows: 2050 },
  ]) {
    test(`${scenario.contentRows}-row intrinsic content virtualizes and stays reachable`, async ({
      page,
    }) => {
      await page.goto(`/?unified=${scenario.param}`);
      await page.waitForLoadState("domcontentloaded");

      const panel = page.locator(".unified-panel");
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(panel.locator(".xterm-rows")).toContainText(
        `Boundary roster (${scenario.contentRows} rows)`,
        { timeout: 30_000 },
      );

      const top = await page.evaluate(() => {
        const card = document.querySelector(".unified-panel") as HTMLElement;
        const viewport = document.querySelector(".unified-panel .xterm-viewport") as HTMLElement;
        const preview = (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview;
        return {
          cardOverflowY: card.style.overflowY,
          cardScrollable: card.scrollHeight - card.clientHeight,
          viewportScrollTop: viewport.scrollTop,
          renderedRows: document.querySelectorAll(".unified-panel .xterm-rows > div").length,
          visibleText: (document.querySelector(".unified-panel .xterm-rows") as HTMLElement)
            .innerText,
          resizeCount: preview?.panelResizeLog.length ?? 0,
          lastReportedRows: preview?.panelResizeLog.at(-1)?.rows,
        };
      });

      expect(top.cardOverflowY).toBe("hidden");
      expect(top.cardScrollable).toBe(0);
      expect(top.viewportScrollTop).toBe(0);
      expect(top.renderedRows).toBeLessThan(100);
      expect(top.visibleText).toContain(`Boundary roster (${scenario.contentRows} rows)`);
      expect(top.resizeCount).toBeLessThanOrEqual(6);
      expect(top.lastReportedRows).toBe(top.renderedRows);

      // The small xterm grid is only the viewport; all intrinsic rows remain in
      // xterm's retained scrollback. PageDown uses xterm's native scrollback
      // navigation (not extension input) and reaches the final row.
      await panel.locator(".xterm-helper-textarea").focus();
      for (let i = 0; i < 100; i++) await page.keyboard.press("PageDown");
      await expect(panel.locator(".xterm-rows")).toContainText(
        `END OF ${scenario.contentRows}-ROW ROSTER`,
        { timeout: 10_000 },
      );

      const bottomText = await panel.locator(".xterm-rows").innerText();
      expect(bottomText).toContain(`END OF ${scenario.contentRows}-ROW ROSTER`);

      // A boundary bug used to alternate forever between the grid ceiling and
      // implicit viewport mode. Once settled, no delayed cooldown resize may fire.
      await page.waitForTimeout(1_200);
      const laterResizeCount = await page.evaluate(
        () =>
          (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview?.panelResizeLog
            .length ?? 0,
      );
      expect(laterResizeCount).toBe(top.resizeCount);
    });
  }

  test("a later update preserves scroll position for exactly 2048 virtualized rows", async ({
    page,
  }) => {
    await page.goto("/?unified=boundary");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("Boundary roster (2048 rows)", {
      timeout: 30_000,
    });

    await panel.locator(".xterm-helper-textarea").focus();
    await panel.locator(".xterm-screen").hover();
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 2_000);
    const before = await panel.locator(".xterm-rows").innerText();
    expect(before).not.toContain("Boundary roster (2048 rows)");
    expect(before).not.toContain("END OF 2048-ROW ROSTER");

    const resizeCount = await page.evaluate(() => {
      const preview = (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview;
      preview?.emitUnifiedPanelUpdate();
      return preview?.panelResizeLog.length ?? 0;
    });

    await page.waitForTimeout(250);
    const after = await panel.locator(".xterm-rows").innerText();
    const laterResizeCount = await page.evaluate(
      () =>
        (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview?.panelResizeLog
          .length ?? 0,
    );
    expect(after).toBe(before);
    expect(laterResizeCount).toBe(resizeCount);
  });

  test("an unsignalled row-coupled widget is pinned to the visible viewport", async ({ page }) => {
    await page.goto("/?unified=expanding");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("Adaptive viewport", {
      timeout: 15_000,
    });

    // This fixture emits exactly as many rows as the renderer reports. Content
    // tracking must probe it once, recognize that it expanded with the grid, and
    // pin a real viewport. Otherwise it grows to a full-column terminal hidden
    // inside a half-column scrolling card — the corruption/duplication setup.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const card = document.querySelector(".unified-panel") as HTMLElement;
            const mount = document.querySelector(
              ".unified-panel .custom-panel__xterm",
            ) as HTMLElement;
            return {
              cardH: card.getBoundingClientRect().height,
              mountH: mount.getBoundingClientRect().height,
              overflowY: card.style.overflowY,
              scrollable: card.scrollHeight - card.clientHeight,
            };
          }),
        { timeout: 15_000 },
      )
      .toMatchObject({ overflowY: "hidden", scrollable: 0 });

    const m = await page.evaluate(() => {
      const card = document.querySelector(".unified-panel") as HTMLElement;
      const mount = document.querySelector(".unified-panel .custom-panel__xterm") as HTMLElement;
      const session = document.querySelector(".app__session") as HTMLElement;
      return {
        cardH: card.getBoundingClientRect().height,
        mountH: mount.getBoundingClientRect().height,
        sessionH: session.clientHeight,
      };
    });
    expect(Math.abs(m.mountH - (m.cardH - 10))).toBeLessThan(4);
    expect(m.cardH).toBeGreaterThan(m.sessionH * 0.4);
    expect(m.cardH).toBeLessThanOrEqual(m.sessionH * 0.5 + 4);
  });

  test("a row-coupled widget with fixed overhead is also pinned", async ({ page }) => {
    await page.goto("/?unified=expanding-offset");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("END OF ADAPTIVE VIEWPORT", {
      timeout: 15_000,
    });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const card = document.querySelector(".unified-panel") as HTMLElement;
            const preview = (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview;
            return {
              overflowY: card.style.overflowY,
              cardScrollable: card.scrollHeight - card.clientHeight,
              renderedRows: document.querySelectorAll(".unified-panel .xterm-rows > div").length,
              resizeCount: preview?.panelResizeLog.length ?? 0,
            };
          }),
        { timeout: 15_000 },
      )
      .toMatchObject({ overflowY: "hidden", cardScrollable: 0 });

    const settled = await page.evaluate(
      () =>
        (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview?.panelResizeLog
          .length ?? 0,
    );
    expect(settled).toBeLessThanOrEqual(6);
    await page.waitForTimeout(1_200);
    const later = await page.evaluate(
      () =>
        (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview?.panelResizeLog
          .length ?? 0,
    );
    expect(later).toBe(settled);
  });

  for (const scenario of [
    { param: "expanding-blank", label: "rows with a trailing blank" },
    { param: "expanding-offset-blank", label: "rows plus overhead with a trailing blank" },
  ]) {
    test(`a row-coupled widget rendering ${scenario.label} is pinned`, async ({ page }) => {
      await page.goto(`/?unified=${scenario.param}`);
      await page.waitForLoadState("domcontentloaded");

      const panel = page.locator(".unified-panel");
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(panel.locator(".xterm-rows")).toContainText("viewport row", {
        timeout: 15_000,
      });

      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const card = document.querySelector(".unified-panel") as HTMLElement;
              const preview = (window as unknown as { __pivisPreview?: PreviewHooks })
                .__pivisPreview;
              return {
                overflowY: card.style.overflowY,
                cardScrollable: card.scrollHeight - card.clientHeight,
                resizeCount: preview?.panelResizeLog.length ?? 0,
              };
            }),
          { timeout: 15_000 },
        )
        .toMatchObject({ overflowY: "hidden", cardScrollable: 0 });

      const settled = await page.evaluate(
        () =>
          (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview?.panelResizeLog
            .length ?? 0,
      );
      expect(settled).toBeLessThanOrEqual(6);
      await page.waitForTimeout(1_200);
      const later = await page.evaluate(
        () =>
          (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview?.panelResizeLog
            .length ?? 0,
      );
      expect(later).toBe(settled);
    });
  }

  test("implicit viewport pin releases when the widget changes to intrinsic overflow", async ({
    page,
  }) => {
    await page.goto("/?unified=expanding-transition");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("END OF OVERSIZED ROSTER", {
      timeout: 15_000,
    });

    const m = await page.evaluate(() => {
      const card = document.querySelector(".unified-panel") as HTMLElement;
      const rows = [...document.querySelectorAll(".unified-panel .xterm-rows > div")];
      return {
        overflowY: card.style.overflowY,
        scrollable: card.scrollHeight - card.clientHeight,
        renderedRows: rows.length,
        firstRow: (rows[0] as HTMLElement | undefined)?.innerText ?? "",
        allText: (document.querySelector(".unified-panel .xterm-rows") as HTMLElement).innerText,
      };
    });
    expect(m.overflowY).toBe("auto");
    expect(m.scrollable).toBeGreaterThan(0);
    expect(m.renderedRows).toBeGreaterThan(160);
    expect(m.firstRow).toContain("Fleet (160 agents)");
    expect(m.allText).toContain("agent-001");
    expect(m.allText).toContain("agent-160");
  });

  test("an overlay (viewport mode): the grid pins to a fixed screen, not the small box", async ({
    page,
  }) => {
    await page.goto("/?unified=overlay");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // The overlay box painted into the panel.
    await expect(panel.locator(".xterm-rows")).toContainText("inspect", { timeout: 15_000 });

    // In viewport mode the renderer pins a FIXED grid (the ~50%-column display
    // cap) instead of hugging the 3-row box — this is the wiggle fix. So the
    // card is the full cap height (NOT a few-row box height) and does NOT scroll.
    // The contrast with the "short roster" test (where the card hugs down to the
    // content) is exactly what distinguishes viewport-pin from content-tracking.
    const m = await page.evaluate(() => {
      const card = document.querySelector(".unified-panel") as HTMLElement;
      const session = document.querySelector(".app__session") as HTMLElement;
      return {
        cardH: card.getBoundingClientRect().height,
        sessionH: session.clientHeight,
        overflowY: card.style.overflowY,
      };
    });
    // Pinned near the cap — far taller than a 3-row box would hug to.
    expect(m.cardH).toBeGreaterThan(m.sessionH * 0.4);
    expect(m.cardH).toBeLessThanOrEqual(m.sessionH * 0.5 + 4);
    expect(m.overflowY).toBe("hidden");
  });

  test("orders the title-bar worktree chip before unified toggle and changes", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 760 });
    await page.goto("/?unified=1");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator(".session-header__controls .unified-toggle")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('[data-testid="changes-button"]')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
        .__pivisStore;
      const state = store.getState();
      state.applyWorktree(state.activeSessionId, {
        worktreePath: "/tmp/stub-worktree/swift-otter",
        branch: "pi-vis-swift-otter",
        name: "swift-otter",
        base: "main",
      });
    });

    const chip = page.locator('[data-testid="worktree-chip"]');
    await expect(chip).toBeVisible({ timeout: 10_000 });

    const order = await page.evaluate(() => {
      const chipEl = document.querySelector('[data-testid="worktree-chip"]');
      const toggleEl = document.querySelector(".session-header__controls .unified-toggle");
      const changesEl = document.querySelector('[data-testid="changes-button"]');
      const before = (a: Element | null, b: Element | null): boolean =>
        !!a && !!b && Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        chipBeforeToggle: before(chipEl, toggleEl),
        toggleBeforeChanges: before(toggleEl, changesEl),
        chipBeforeChanges: before(chipEl, changesEl),
      };
    });

    expect(order).toEqual({
      chipBeforeToggle: true,
      toggleBeforeChanges: true,
      chipBeforeChanges: true,
    });
  });

  test("UnifiedViewToggle switches between the panel and the native composer", async ({ page }) => {
    await page.goto("/?unified=1");
    await page.waitForLoadState("domcontentloaded");

    // While a unified panel is live, the view switcher is in the right-side
    // controls cluster of the session header, before the changes button.
    const toggle = page.locator(".unified-toggle");
    await expect(toggle).toBeVisible({ timeout: 20_000 });

    // Verify it's in the controls cluster (right side of header)
    const toggleInControls = page.locator(".session-header__controls .unified-toggle");
    await expect(toggleInControls).toBeVisible();

    // Verify labels are "Extension" and "Input"
    await expect(toggle.getByRole("tab", { name: "Extension" })).toBeVisible();
    await expect(toggle.getByRole("tab", { name: "Input" })).toBeVisible();

    // Default: unified panel visible (Extension selected), composer absent.
    await expect(page.locator(".unified-panel")).toBeVisible();
    await expect(page.locator(".composer__textarea")).toHaveCount(0);
    await expect(toggle.getByRole("tab", { name: "Extension" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Click "Input" → the native Composer takes the slot, the panel unmounts.
    await toggle.getByRole("tab", { name: "Input" }).click();
    await expect(page.locator(".composer__textarea")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".unified-panel")).toHaveCount(0);
    await expect(toggle.getByRole("tab", { name: "Input" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Click "Extension" → back to the unified TUI. The remounted xterm starts
    // clean and asks the host for a forced repaint, so content returns without
    // relying on replaying the old ANSI log.
    await toggle.getByRole("tab", { name: "Extension" }).click();
    await expect(page.locator(".unified-panel")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".composer__textarea")).toHaveCount(0);
    await expect(page.locator(".unified-panel .xterm-rows")).toContainText("Fleet", {
      timeout: 10_000,
    });
    await expect(toggle.getByRole("tab", { name: "Extension" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  // ── Renderer-only Kitty keyboard proof ───────────────────────────────
  // Isolates xterm 6.1's behavior from host logic: the preview stub pushes the
  // kitty handshake (on panel open AND on the force:true first resize — the
  // replay buffer trims the open-time push at the frame's hard clear, exactly
  // like the real host path); xterm (served with vtExtensions.kittyKeyboard)
  // ANSWERS it and encodes Shift+Enter as CSI-u. This is the renderer half of
  // the fix; the host half (decoding) is covered by the unit + host suites.
  test("xterm answers the kitty handshake and emits \x1b[13;2u for Shift+Enter", async ({
    page,
  }) => {
    await page.goto("/?unified=1");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm")).toBeVisible({ timeout: 10_000 });

    // xterm must answer the stub's push with a nonzero kitty-flags reply over
    // panelInput — proof the kitty enhancement is ACTIVE in this xterm.
    await expect
      .poll(
        async () =>
          stripKittyReleases(
            (await page.evaluate(() => {
              const h = (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview;
              return h ? h.panelInputLog.join("") : "";
            })) ?? "",
          ),
        { timeout: 10_000 },
      )
      .toMatch(/\x1b\[\?[1-9]\d*u/);

    // Focus the terminal and press Shift+Enter through real xterm 6.1.
    await panel.locator(".xterm").click();
    await page.keyboard.press("Shift+Enter");

    // THE renderer-half invariant: Shift+Enter encodes as a distinct CSI-u,
    // not an indistinguishable \r.
    await expect
      .poll(
        async () =>
          stripKittyReleases(
            (await page.evaluate(() => {
              const h = (window as unknown as { __pivisPreview?: PreviewHooks }).__pivisPreview;
              return h ? h.panelInputLog.join("") : "";
            })) ?? "",
          ),
        { timeout: 10_000 },
      )
      .toContain("\x1b[13;2u");
  });
});

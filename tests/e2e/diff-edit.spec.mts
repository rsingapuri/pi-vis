// E2E tests for inline diff editing (the diff edit card).
//
// We make a real git repo with a file that has a clear block of added lines,
// open the viewer, drag-select two of them, and exercise:
//   - the Edit bubble appears and opens the card (zero layout shift on open),
//   - typing + ⌘Enter writes the working-tree file (no "Loading…" flash),
//   - a dirty Escape raises the Discard confirm,
//   - no bubble for a del-only selection.
//
// Real Electron + real git IPC (fake pi suffices — PI_E2E only gates panels).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import {
  type LaunchedElectronApplication,
  launchElectron,
} from "./support/instrumented-launch.mjs";
import { expect, test } from "./support/invariants.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");
const FAKE_SESSION_HOST = join(__dirname, "../fixtures/fake-session-host.mjs");
const APP_ENTRY = join(__dirname, "../../out/main/index.js");

interface Folders {
  settingsDir: string;
  workspaceDir: string;
  piSessionsDir: string;
}

async function makeFolders(): Promise<Folders> {
  return {
    settingsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-edit-"))),
    workspaceDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-edit-ws-"))),
    piSessionsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-edit-pi-"))),
  };
}

async function launchApp(
  folders: Folders,
): Promise<{ app: LaunchedElectronApplication; window: Page }> {
  const settingsPath = join(folders.settingsDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        piBinaryPath: FAKE_PI,
        workspaceOrder: [folders.workspaceDir],
        fonts: { display: { sizePx: 14 }, code: { family: "monospace", sizePx: 13 } },
      }),
    );
  }
  const app = await launchElectron({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: folders.settingsDir,
      FAKE_PI_SESSIONS_DIR: folders.piSessionsDir,
      PIVIS_SESSIONS_DIR: folders.piSessionsDir,
      PIVIS_TEST_HOST_SCRIPT: FAKE_SESSION_HOST,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  app.process().stderr?.on("data", () => {});
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.setViewportSize({ width: 1600, height: 900 });
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 15_000 });
  return { app, window };
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function initRepo(workspaceDir: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: workspaceDir });
  try {
    execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: workspaceDir });
  } catch {
    /* best effort */
  }
}

function commitFile(workspaceDir: string, path: string, lines: string[]): void {
  fs.writeFileSync(join(workspaceDir, path), `${lines.join("\n")}\n`);
  execFileSync("git", ["add", path], { cwd: workspaceDir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
    cwd: workspaceDir,
  });
}

/** A repo with a tracked file containing both a block of 8 added lines (to
 *  drag-select) and 2 deleted lines (a del-only selection target). The diff
 *  therefore shows a contiguous add run AND a separate del run. */
function setupRepoForEdit(workspaceDir: string): string {
  initRepo(workspaceDir);
  const committed = [
    "// header line one",
    "// header line two",
    "export const DELETABLE_1 = 1;",
    "export const DELETABLE_2 = 2;",
    "export const tail = 0;",
  ];
  commitFile(workspaceDir, "edit.ts", committed);
  const added: string[] = [];
  for (let i = 1; i <= 8; i++) added.push(`export const EDIT_${i} = ${i};`);
  // Insert the add block after the headers and REMOVE the DELETABLE lines.
  const working = [committed[0]!, committed[1]!, ...added, committed[4]!];
  fs.writeFileSync(join(workspaceDir, "edit.ts"), `${working.join("\n")}\n`);
  return join(workspaceDir, "edit.ts");
}

/** Open the diff viewer and wait for the edit.ts section to render rows. */
async function openViewer(window: Page, waitForAdd = true): Promise<void> {
  await window.getByRole("button", { name: "New session" }).click();
  await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
    timeout: 15_000,
  });
  await window
    .getByRole("button", { name: /Changes|changes/i })
    .first()
    .click();
  await expect(window.locator(".diff-viewer")).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('[data-testid="diff-section-edit.ts"]')).toBeVisible({
    timeout: 10_000,
  });
  // Wait for diff rows to paint; most tests use add rows, but removal-only
  // fixtures may only have context/del rows.
  await expect(
    window.locator(waitForAdd ? ".diff-row--add" : ".diff-row[data-line-idx]").first(),
  ).toBeVisible({ timeout: 10_000 });
}

/** Drag-select through rendered code text from the `fromIdx` cell to the `toIdx` cell. */
async function selectRange(window: Page, fromIdx: number, toIdx: number): Promise<void> {
  const from = window.locator(`.diff-row--add[data-line-idx="${fromIdx}"] .diff-row__code`).first();
  const to = window.locator(`.diff-row--add[data-line-idx="${toIdx}"] .diff-row__code`).first();
  await dragThroughCodeText(window, from, to);
}

/** Drag-select new-side cells in split mode. */
async function selectSplitNewRange(window: Page, fromIdx: number, toIdx: number): Promise<void> {
  const from = window
    .locator(`.diff-row--split [data-side="new"][data-line-idx="${fromIdx}"]`)
    .first();
  const to = window.locator(`.diff-row--split [data-side="new"][data-line-idx="${toIdx}"]`).first();
  await dragBetweenCells(window, from, to);
}

async function dragBetweenCells(window: Page, from: Locator, to: Locator): Promise<void> {
  await from.waitFor();
  await to.waitFor();
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("could not resolve selection cells");
  await window.mouse.move(a.x + a.width / 2, a.y + a.height / 4);
  await window.mouse.down();
  await window.mouse.move(b.x + b.width / 2, b.y + (b.height * 3) / 4, { steps: 8 });
  await window.mouse.up();
}

async function dragThroughCodeText(window: Page, from: Locator, to: Locator): Promise<void> {
  await from.waitFor();
  await to.waitFor();
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("could not resolve selection cells");
  // Stay inside rendered glyphs rather than the center of the flex code cell.
  // On a wide diff the center is empty trailing whitespace, where Chromium's
  // pointer hit-testing does not consistently create a text selection.
  const textInset = (width: number, preferred: number): number =>
    Math.max(2, Math.min(width - 2, preferred));
  await window.mouse.move(a.x + textInset(a.width, 32), a.y + a.height / 4);
  await window.mouse.down();
  await window.mouse.move(b.x + textInset(b.width, 160), b.y + (b.height * 3) / 4, { steps: 8 });
  await window.mouse.up();
}

async function selectTextInCell(
  window: Page,
  selector: string,
  start: number,
  end: number,
): Promise<void> {
  await selectTextAcrossCells(window, selector, start, selector, end);
}

async function selectTextAcrossCells(
  window: Page,
  startSelector: string,
  start: number,
  endSelector: string,
  end: number,
): Promise<void> {
  await window.evaluate(
    ({ startSelector, start, endSelector, end }) => {
      const startCell = document.querySelector<HTMLElement>(startSelector);
      const endCell = document.querySelector<HTMLElement>(endSelector);
      if (!startCell) throw new Error(`cell not found: ${startSelector}`);
      if (!endCell) throw new Error(`cell not found: ${endSelector}`);
      const pointAt = (root: HTMLElement, offset: number): { node: Text; offset: number } => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let remaining = offset;
        let node = walker.nextNode() as Text | null;
        while (node) {
          const len = node.textContent?.length ?? 0;
          if (remaining <= len) return { node, offset: remaining };
          remaining -= len;
          node = walker.nextNode() as Text | null;
        }
        throw new Error("offset outside cell text");
      };
      const a = pointAt(startCell, start);
      const b = pointAt(endCell, end);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { startSelector, start, endSelector, end },
  );
}

async function firstGlyphRect(window: Page, selector: string): Promise<{ x: number; y: number }> {
  return await window
    .locator(selector)
    .first()
    .evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node && (node.textContent ?? "").trim() === "") node = walker.nextNode();
      if (!node) throw new Error("No text node found");
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach();
      return { x: rect.x, y: rect.y };
    });
}

test.describe("Diff inline edit", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_SESSION_HOST, 0o755);
  });

  test("drag-select shows the bubble; opening the card shifts no glyph", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      // Geometry is the oracle below. Wait for the packaged code font before
      // capturing it so a cold CI font load cannot masquerade as a card shift.
      await window.evaluate(async () => {
        await document.fonts.ready;
      });
      // The added lines are add rows; pick two consecutive ones. Find their
      // data-line-idx values dynamically.
      const addIdxs = await window
        .locator(".diff-row--add[data-line-idx]")
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      expect(addIdxs.length).toBeGreaterThanOrEqual(2);
      const fromIdx = addIdxs[1]!;
      const toIdx = addIdxs[2] ?? addIdxs[1]!;

      // Zero-shift probes: capture a context row's code rect OUTSIDE the range
      // and the selected line's first glyph. The latter catches accidental
      // double-padding inside the edit card (the cell rect can stay fixed while
      // the text itself nudges right).
      const probe = window.locator(".diff-row .diff-row__code").first();
      await probe.waitFor();
      const before = await probe.boundingBox();
      const selectedGlyphBefore = await firstGlyphRect(
        window,
        `.diff-row--add[data-line-idx="${fromIdx}"] .diff-row__code`,
      );

      await selectRange(window, fromIdx, toIdx);
      const bubble = window.getByTestId("diff-edit-bubble");
      await expect(bubble).toBeVisible({ timeout: 5_000 });
      await expect(bubble).toContainText("Edit selection");
      const placement = await bubble.evaluate((el, targetIdx) => {
        const b = el.getBoundingClientRect();
        const cell = document
          .querySelector(`.diff-row--add[data-line-idx="${targetIdx}"] .diff-row__code`)
          ?.getBoundingClientRect();
        const pane = document.querySelector(".diff-content")?.getBoundingClientRect();
        if (!cell || !pane) throw new Error("missing placement reference");
        return {
          bubbleCenterX: b.left + b.width / 2,
          bubbleRight: b.right,
          codeLeft: cell.left,
          codeWidth: cell.width,
          paneRight: pane.right,
        };
      }, toIdx);
      expect(placement.bubbleCenterX).toBeLessThan(
        placement.codeLeft + Math.min(placement.codeWidth * 0.65, 520),
      );
      expect(placement.bubbleRight).toBeLessThan(placement.paneRight - 120);
      expect(placement.bubbleRight).toBeLessThan(placement.codeLeft);

      const selectedComment = window
        .locator(`.diff-row--add[data-line-idx="${fromIdx}"] [data-testid="diff-comment-button"]`)
        .first();
      await expect(selectedComment).toHaveCSS("opacity", "0");
      const outsideIdx = addIdxs[0]!;
      await window.locator(`.diff-row--add[data-line-idx="${outsideIdx}"]`).first().hover();
      await expect(
        window
          .locator(
            `.diff-row--add[data-line-idx="${outsideIdx}"] [data-testid="diff-comment-button"]`,
          )
          .first(),
      ).toHaveCSS("opacity", "1");

      await bubble.click();
      await expect(window.getByTestId("diff-edit-card")).toBeVisible({ timeout: 5_000 });

      // Zero-shift: the probe row did not move when the card opened. A real
      // layout shift would be multiple pixels; a sub-pixel fractional change
      // (rendering noise) is within epsilon.
      const after = await probe.boundingBox();
      expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(1);
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);
      const selectedGlyphAfter = await firstGlyphRect(window, ".diff-edit-pre");
      expect(Math.abs(selectedGlyphAfter.x - selectedGlyphBefore.x)).toBeLessThan(1);
      expect(Math.abs(selectedGlyphAfter.y - selectedGlyphBefore.y)).toBeLessThan(1);
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("opening edit keeps the highlighted text selected", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const addIdxs = await window
        .locator(".diff-row--add[data-line-idx]")
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      expect(addIdxs.length).toBeGreaterThanOrEqual(2);
      const lineIdx = addIdxs[1]!;
      const cellSelector = `.diff-row--add[data-line-idx="${lineIdx}"] .diff-row__code`;
      const lineText = await window.locator(cellSelector).first().textContent();
      const start = lineText?.indexOf("EDIT_2") ?? -1;
      expect(start).toBeGreaterThanOrEqual(0);
      const end = start + "EDIT_2".length;

      await selectTextInCell(window, cellSelector, start, end);
      const bubble = window.getByTestId("diff-edit-bubble");
      await expect(bubble).toBeVisible({ timeout: 5_000 });
      await expect(bubble).toContainText("Edit selection");
      await bubble.click();
      const ta = window.locator(".diff-edit-textarea").first();
      await expect(ta).toBeFocused({ timeout: 5_000 });
      const cursor = await ta.evaluate((el) => ({
        start: el.selectionStart,
        end: el.selectionEnd,
      }));
      expect(cursor).toEqual({ start, end });
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("many-line drags show the bubble (down and up)", async () => {
    test.setTimeout(120_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const addIdxs = await window
        .locator(".diff-row--add[data-line-idx]")
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      expect(addIdxs.length).toBeGreaterThanOrEqual(6);

      // Downward drags spanning 3, 4, and 6 rows.
      for (const span of [2, 3, 5]) {
        await window.evaluate(() => window.getSelection()?.removeAllRanges());
        await expect(window.getByTestId("diff-edit-bubble")).toHaveCount(0);
        await selectRange(window, addIdxs[0]!, addIdxs[span]!);
        await expect(window.getByTestId("diff-edit-bubble")).toBeVisible({ timeout: 5_000 });
      }

      // Upward drag (anchor at the bottom) spanning 4 rows.
      await window.evaluate(() => window.getSelection()?.removeAllRanges());
      await expect(window.getByTestId("diff-edit-bubble")).toHaveCount(0);
      const from = window
        .locator(`.diff-row--add[data-line-idx="${addIdxs[4]!}"] .diff-row__code`)
        .first();
      const to = window
        .locator(`.diff-row--add[data-line-idx="${addIdxs[1]!}"] .diff-row__code`)
        .first();
      await dragBetweenCells(window, from, to);
      await expect(window.getByTestId("diff-edit-bubble")).toBeVisible({ timeout: 5_000 });

      // Mixed drag: from the first context row down across BOTH del rows into
      // the add block (context + del + add in one selection).
      await window.evaluate(() => window.getSelection()?.removeAllRanges());
      await expect(window.getByTestId("diff-edit-bubble")).toHaveCount(0);
      const contextSelector =
        '[data-testid="diff-section-edit.ts"] .diff-row[data-line-idx] .diff-row__code';
      const addSelector = `.diff-row--add[data-line-idx="${addIdxs[2]!}"] .diff-row__code`;
      // Chromium's pointer hit-testing cannot drag a native selection across
      // the intervening deletion-only rows reliably. Build the same DOM range
      // explicitly; the preceding cases already cover physical drag gestures.
      await selectTextAcrossCells(window, contextSelector, 1, addSelector, 1);
      await expect(window.getByTestId("diff-edit-bubble")).toBeVisible({ timeout: 5_000 });
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("long wrapped lines mid-text drag shows the bubble", async () => {
    test.setTimeout(120_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    // Long comment-style lines that soft-wrap in the pane (like a real JSDoc
    // block), committed then replaced so they render as add rows.
    const longCommitted = ["// base"];
    fs.writeFileSync(join(folders.workspaceDir, "long.ts"), `${longCommitted.join("\n")}\n`);
    execFileSync("git", ["add", "long.ts"], { cwd: folders.workspaceDir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "l"], {
      cwd: folders.workspaceDir,
    });
    const longLines = ["// base"];
    for (let i = 1; i <= 8; i++) {
      longLines.push(
        ` * LINE_${i} ${"the renderer sends expectedHash sha256 of the UTF-8 bytes of the newText its edit buffer was derived from and we re-read the file hash the decoded string re-encoding the same way ".repeat(2)}`,
      );
    }
    fs.writeFileSync(join(folders.workspaceDir, "long.ts"), `${longLines.join("\n")}\n`);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const section = window.locator('[data-testid="diff-section-long.ts"]');
      await section.scrollIntoViewIfNeeded();
      const rows = section.locator(".diff-row--add[data-line-idx] .diff-row__code");
      await expect(rows.first()).toBeVisible({ timeout: 10_000 });
      const idxs = await section
        .locator(".diff-row--add[data-line-idx]")
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      expect(idxs.length).toBeGreaterThanOrEqual(6);
      // Drag mid-text of row 1 to mid-text of row 5 (5 wrapped rows).
      const from = section
        .locator(`.diff-row--add[data-line-idx="${idxs[0]!}"] .diff-row__code`)
        .first();
      const to = section
        .locator(`.diff-row--add[data-line-idx="${idxs[4]!}"] .diff-row__code`)
        .first();
      const a = await from.boundingBox();
      const b = await to.boundingBox();
      if (!a || !b) throw new Error("no boxes");
      await window.mouse.move(a.x + 60, a.y + 8);
      await window.mouse.down();
      await window.mouse.move(b.x + 300, b.y + b.height - 8, { steps: 12 });
      await window.mouse.up();
      await expect(window.getByTestId("diff-edit-bubble")).toBeVisible({ timeout: 5_000 });
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("row-boundary multi-line selection shows the bubble", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const addIdxs = await window
        .locator(".diff-row--add[data-line-idx]")
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      expect(addIdxs.length).toBeGreaterThanOrEqual(2);
      const from = window.locator(`.diff-row--add[data-line-idx="${addIdxs[1]!}"]`).first();
      const to = window
        .locator(`.diff-row--add[data-line-idx="${addIdxs[2] ?? addIdxs[1]!}"]`)
        .first();
      await dragBetweenCells(window, from, to);
      await expect(window.getByTestId("diff-edit-bubble")).toBeVisible({ timeout: 5_000 });
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("split old-side context selection shows the bubble", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const viewer = window.locator(".diff-viewer");
      await viewer.getByRole("button", { name: "Split" }).click();
      await expect(viewer.locator(".diff-row--split").first()).toBeVisible({ timeout: 5_000 });

      await window.evaluate(() => {
        const oldContext = Array.from(
          document.querySelectorAll<HTMLElement>(
            '.diff-row--split [data-side="old"][data-line-idx]',
          ),
        ).find((el) => el.textContent?.includes("header line"));
        if (!oldContext) throw new Error("old context cell not found");
        const range = document.createRange();
        range.selectNodeContents(oldContext);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await expect(window.getByTestId("diff-edit-bubble")).toBeVisible({ timeout: 5_000 });
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("split mode edit card uses split row layout", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const viewer = window.locator(".diff-viewer");
      await viewer.getByRole("button", { name: "Split" }).click();
      await expect(viewer.locator(".diff-row--split").first()).toBeVisible({ timeout: 5_000 });

      const addIdxs = await viewer
        .locator('.diff-row--split [data-side="new"][data-line-idx]')
        .filter({ hasText: "EDIT_" })
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      expect(addIdxs.length).toBeGreaterThanOrEqual(2);
      await selectSplitNewRange(window, addIdxs[0]!, addIdxs[1]!);
      await window.getByTestId("diff-edit-bubble").click();

      const card = window.getByTestId("diff-edit-card");
      await expect(card).toBeVisible({ timeout: 5_000 });
      await expect(card.locator(".diff-row--edit-segment.diff-row--split").first()).toBeVisible();
      await expect(
        card.locator(".diff-row--edit-segment .diff-row__code--empty").first(),
      ).toBeVisible();
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("type + ⌘Enter writes the working-tree file with no Loading flash", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const filePath = setupRepoForEdit(folders.workspaceDir);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const addIdxs = await window
        .locator(".diff-row--add[data-line-idx]")
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      const fromIdx = addIdxs[1]!;
      const toIdx = addIdxs[2] ?? addIdxs[1]!;
      await selectRange(window, fromIdx, toIdx);
      await window.getByTestId("diff-edit-bubble").click();
      await expect(window.getByTestId("diff-edit-card")).toBeVisible();

      const ta = window.locator(".diff-edit-textarea").first();
      await ta.click();
      await ta.fill("export const REPLACED = true;\nexport const ALSO = 1;");
      await window.keyboard.press("Meta+Enter");

      // The card closes on save; no "Loading…" notice appears.
      await expect(window.getByTestId("diff-edit-card")).toBeHidden({ timeout: 10_000 });
      await expect(window.locator(".diff-file__notice--loading")).toHaveCount(0);

      // Disk content reflects the edit (the replaced lines are gone, REPLACED in).
      const onDisk = fs.readFileSync(filePath, "utf8");
      expect(onDisk).toContain("export const REPLACED = true;");
      expect(onDisk).not.toContain("EDIT_2");
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("dirty Escape raises the Discard confirm; Discard restores rows and leaves disk", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const filePath = setupRepoForEdit(folders.workspaceDir);
    const before = fs.readFileSync(filePath, "utf8");
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const addIdxs = await window
        .locator(".diff-row--add[data-line-idx]")
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      await selectRange(window, addIdxs[1]!, addIdxs[2] ?? addIdxs[1]!);
      await window.getByTestId("diff-edit-bubble").click();
      const ta = window.locator(".diff-edit-textarea").first();
      await ta.click();
      await ta.fill("dirty unsaved content");
      // Escape from inside the editor → confirm dialog (not an immediate close).
      await ta.press("Escape");
      await expect(window.locator(".confirm-dialog")).toBeVisible({ timeout: 5_000 });
      await window.getByRole("button", { name: "Discard" }).click();
      await expect(window.getByTestId("diff-edit-card")).toBeHidden({ timeout: 5_000 });
      // Disk untouched.
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("no bubble for a del-only selection", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const delIdxs = await window
        .locator(".diff-row--del[data-line-idx]")
        .evaluateAll((els) =>
          els
            .map((e) => Number(e.getAttribute("data-line-idx")))
            .filter((n) => Number.isInteger(n)),
        );
      if (delIdxs.length < 2) {
        throw new Error("expected at least 2 del rows in the fixture");
      }
      // Set a selection across two del-row code cells programmatically, then
      // synthesize a mouseup so the bubble controller recomputes.
      await window.evaluate(
        ({ a, b }: { a: number; b: number }) => {
          const ea = document.querySelector(`.diff-row--del[data-line-idx="${a}"] .diff-row__code`);
          const eb = document.querySelector(`.diff-row--del[data-line-idx="${b}"] .diff-row__code`);
          if (!ea || !eb) return;
          const range = document.createRange();
          range.selectNodeContents(ea);
          const end = document.createRange();
          end.selectNodeContents(eb);
          range.setEnd(eb, eb.childNodes.length || 0);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        },
        { a: delIdxs[0]!, b: delIdxs[1]! },
      );
      // Give the controller a tick; the bubble must not appear for a del-only
      // selection (resolveEditRange returns null — also unit-covered).
      await window.waitForTimeout(300);
      await expect(window.getByTestId("diff-edit-bubble")).toHaveCount(0);
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("overshoot into the next file's section still shows the bubble", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    setupRepoForEdit(folders.workspaceDir);
    // A second changed file that sorts after edit.ts: a drag overshooting past
    // edit.ts's rows parks the selection focus in THIS section, which must not
    // count as a second file (zero selected row characters there).
    fs.writeFileSync(join(folders.workspaceDir, "zz-tail.ts"), "export const z = 1;\n");
    execFileSync("git", ["add", "zz-tail.ts"], { cwd: folders.workspaceDir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "z"], {
      cwd: folders.workspaceDir,
    });
    fs.writeFileSync(join(folders.workspaceDir, "zz-tail.ts"), "export const z = 2;\n");
    const { app, window } = await launchApp(folders);
    try {
      await openViewer(window);
      const zzSection = window.locator('[data-testid="diff-section-zz-tail.ts"]');
      await expect(zzSection).toBeVisible({ timeout: 10_000 });

      // Reproduce the boundary artifact deterministically: a full-line drag
      // past a file's last rows parks the selection focus at the next
      // section's boundary (offset 0 — zero selected characters in it). The
      // next file intersects the range but must not count as a second file.
      await window.evaluate(() => {
        const rows = document.querySelectorAll(
          '[data-testid="diff-section-edit.ts"] .diff-row--add[data-line-idx] .diff-row__code',
        );
        const startCell = rows[rows.length - 2] ?? rows[0];
        const zz = document.querySelector('[data-testid="diff-section-zz-tail.ts"]');
        if (!startCell || !zz) throw new Error("fixture rows missing");
        const range = document.createRange();
        range.setStart(startCell, 0);
        range.setEnd(zz, 0);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });

      await expect(window.getByTestId("diff-edit-bubble")).toBeVisible({ timeout: 5_000 });
      await window.getByTestId("diff-edit-bubble").click();
      await expect(window.getByTestId("diff-edit-card")).toBeVisible({ timeout: 5_000 });
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });
});

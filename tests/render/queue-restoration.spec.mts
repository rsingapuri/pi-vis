import { expect, test } from "@playwright/test";

async function waitForStore(page: import("@playwright/test").Page): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/?customEntry=1");
  await page.waitForFunction(() => {
    const store = (
      window as unknown as { __pivisStore?: { getState: () => { activeSessionId: string | null } } }
    ).__pivisStore;
    return !!store?.getState().activeSessionId;
  });
  await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });
}

async function applyRestoreDraft(page: import("@playwright/test").Page, restoration: unknown) {
  await page.evaluate((value) => {
    const store = (
      window as unknown as {
        __pivisStore: {
          getState: () => {
            activeSessionId: string;
            applyRestoreDraft: (sessionId: string, restoration: unknown) => void;
          };
        };
      }
    ).__pivisStore;
    const state = store.getState();
    state.applyRestoreDraft(state.activeSessionId, value);
  }, restoration);
}

test("automatically restores an interrupted draft and attachments directly into the composer", async ({
  page,
}) => {
  await waitForStore(page);

  await applyRestoreDraft(page, {
    restorationId: "restore-render",
    text: "queued text restored automatically",
    attachments: [
      {
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      },
    ],
    disposition: "restore",
  });

  await expect(page.locator(".composer__textarea")).toHaveValue(
    "queued text restored automatically",
  );
  await expect(page.locator(".composer__attachment-thumb")).toHaveCount(1);
  await expect(page.locator(".composer__attachment-thumb")).toHaveAttribute(
    "alt",
    "restored-image-1.png",
  );
  await expect(page.getByText(/Review interrupted (message|command)/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Dismiss|Restore to Composer/ })).toHaveCount(0);
});

test("dropped command recoveries do not inject executable text or review UI", async ({ page }) => {
  await waitForStore(page);
  await applyRestoreDraft(page, {
    restorationId: "dropped-command",
    text: "!touch marker",
    attachments: [],
    disposition: "dropped",
  });

  await expect(page.locator(".composer__textarea")).toHaveValue("");
  await expect(page.getByText(/Review interrupted (message|command)/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Dismiss|Restore to Composer/ })).toHaveCount(0);
});

test("failed compaction is not presented as successful", async ({ page }) => {
  await waitForStore(page);
  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __pivisStore: {
          getState: () => {
            activeSessionId: string;
            applyEvent: (sessionId: string, event: unknown) => void;
          };
        };
      }
    ).__pivisStore;
    const state = store.getState();
    state.applyEvent(state.activeSessionId, {
      type: "compaction_end",
      reason: "manual",
      errorMessage: "Nothing to compact",
    });
  });

  await expect(page.getByText(/Compaction failed · manual/)).toBeVisible();
  await expect(page.getByText("Nothing to compact", { exact: true })).toBeVisible();
  await expect(page.getByText(/Context compacted/)).toHaveCount(0);
});

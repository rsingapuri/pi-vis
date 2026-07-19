import { expect, test } from "@playwright/test";

test("late-mounted sidebar working dots inherit one shared pulse phase", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator(".composer__textarea");
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });

  await composer.fill("Show synchronized sidebar activity");
  await composer.press("Enter");

  const workspaceList = page.locator(".sidebar__workspaces--working");
  await expect(workspaceList).toBeVisible();

  const result = await workspaceList.evaluate(async (list) => {
    const firstDot = document.createElement("span");
    firstDot.className = "status-dot status-dot--streaming";
    list.append(firstDot);

    await new Promise((resolve) => setTimeout(resolve, 275));
    const lateDot = firstDot.cloneNode(true) as HTMLElement;
    list.append(lateDot);

    const differences: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const firstOpacity = Number.parseFloat(getComputedStyle(firstDot).opacity);
      const lateOpacity = Number.parseFloat(getComputedStyle(lateDot).opacity);
      differences.push(Math.abs(firstOpacity - lateOpacity));
      await new Promise((resolve) => setTimeout(resolve, 70));
    }

    const styles = {
      clockAnimation: getComputedStyle(list).animationName,
      firstAnimation: getComputedStyle(firstDot).animationName,
      lateAnimation: getComputedStyle(lateDot).animationName,
      maxDifference: Math.max(...differences),
    };
    firstDot.remove();
    lateDot.remove();
    return styles;
  });

  expect(result.clockAnimation).toBe("status-dot-pulse-clock");
  expect(result.firstAnimation).toBe("none");
  expect(result.lateAnimation).toBe("none");
  expect(result.maxDifference).toBeLessThan(0.001);
});

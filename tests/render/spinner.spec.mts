import { expect, test } from "@playwright/test";

test("ongoing work uses the slow, continuous five-spoke rotor", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator(".composer__textarea");
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });

  await composer.fill("Show the activity indicator");
  await composer.press("Enter");

  const rotor = page.locator(".working-row .spinner__rotor");
  await expect(rotor).toBeVisible();
  await expect(rotor.locator("path")).toHaveAttribute("d", /^M6 6/);

  const motion = await rotor.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      animationTimingFunction: style.animationTimingFunction,
      transformOrigin: style.transformOrigin,
    };
  });
  expect(motion.animationName).toBe("spinner-spin");
  expect(motion.animationDuration).toBe("3.2s");
  expect(motion.animationTimingFunction).toBe("linear");
  expect(motion.transformOrigin).not.toBe("0px 0px");
});

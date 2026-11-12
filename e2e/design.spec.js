import { test, expect } from "@playwright/test";

test("artwork loads at desktop and phone sizes without horizontal overflow", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    for (const selector of [".hero-art img", ".community-coin", ".brand-banner img"]) {
      const image = page.locator(selector);
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    }
    const coin = await page.locator(".community-coin").boundingBox();
    expect(Math.abs(coin.width - coin.height)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await expect(page.locator("#jcq-option")).toBeDisabled();
  }
});

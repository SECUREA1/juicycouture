import { test, expect } from '@playwright/test';

test('restored coin page, section toggles, reward preview and back navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Dripping in sweetness.');
  await expect(page.locator('#panel-coin')).toBeVisible();
  await expect(page.locator('#panel-live')).toBeHidden();
  await page.locator('[data-panel="rewards"]').click();
  await expect(page.locator('#panel-coin')).toBeHidden();
  await page.locator('[data-reward="build"]').click();
  await expect(page.locator('#preview-value')).toHaveText('A lasting result, not a bigger crowd.');
  await expect(page.locator('[data-reward="care"]')).toHaveAttribute('aria-pressed', 'false');
  await page.goBack();
  await expect(page.locator('#panel-coin')).toBeVisible();
  await page.getByRole('link', { name: 'FAQ', exact: true }).click();
  await page.getByText('Is the coin live?', { exact: true }).click();
  await expect(page.locator('#faq details').first()).toHaveAttribute('open', '');
  for (const key of ['live', 'feed', 'tips', 'market', 'coin']) {
    await page.locator(`[data-panel="${key}"]`).click();
    await expect(page.locator(`[data-app-panel="${key}"]`)).toBeVisible();
    await expect(page.locator('[data-app-panel]:visible')).toHaveCount(1);
  }
});

test('video room stays connected when switching to tipping and back', async ({ page }) => {
  await page.goto('/#live-room');
  await page.locator('#room-code').fill(`sections-${Date.now()}`);
  await page.locator('#join-room').click();
  await expect(page.locator('#live-room')).toHaveClass(/connected/);
  await page.locator('[data-panel="tips"]').click();
  await expect(page.locator('#panel-tips')).toBeVisible();
  await page.locator('[data-panel="live"]').click();
  await expect(page.locator('#live-room')).toHaveClass(/connected/);
  await expect(page.locator('#chat-input')).toBeEnabled();
  await page.locator('#leave-room').click();
  await expect(page.locator('#live-room')).not.toHaveClass(/connected/);
});

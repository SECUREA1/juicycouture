import { test, expect } from '@playwright/test';

test('market feed shows pending configuration and community ticker has no invented activity', async ({ page }) => {
  await page.goto('/#panel-market');
  await expect(page.locator('#market-feed')).toContainText('official Solana mint');
  await expect(page.locator('#activity-track')).toContainText('Share the first photo');
});

test('tickers render market metrics and community captions safely, with pause controls', async ({ page }) => {
  await page.route('**/api/market', route => route.fulfill({ json: {
    status: 'live', priceUsd: '0.0123', change24h: -2.5, volume24h: 1000,
    liquidityUsd: null, updatedAt: new Date().toISOString(),
  } }));
  await page.route('**/api/feed', route => route.fulfill({ json: { posts: [{
    id: 1, author: '123456789ABCDEFG', caption: '<img src=x onerror=alert(1)>',
    imageUrl: '/missing.webp', createdAt: new Date().toISOString(),
  }], nextCursor: null } }));
  await page.goto('/#panel-market');
  await expect(page.locator('#market-feed')).toContainText('$0.0123');
  await expect(page.locator('#market-feed')).toContainText('-2.5%');
  await expect(page.locator('#market-feed')).toContainText('Unavailable');
  await expect(page.locator('#activity-track')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#activity-track img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause ticker' }).click();
  await expect(page.getByRole('button', { name: 'Resume ticker' })).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

import { test, expect } from '@playwright/test';

test('every app option includes its banner and motion respects pause and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  for (const key of ['coin', 'rewards', 'live', 'feed', 'tips', 'market']) {
    await page.locator(`[data-panel="${key}"]`).click();
    const panel = page.locator(`[data-app-panel="${key}"]`);
    await expect(panel).toBeVisible();
    const banner = panel.locator('.section-banner img').first();
    await banner.scrollIntoViewIfNeeded();
    await expect.poll(() => banner.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.locator('.section-ribbon')).toHaveCount(1);
    await expect(panel.locator('.sparkle-field')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await page.locator('.section-ribbon-track').evaluate(track => getComputedStyle(track).animationName)).toBe('none');
  }

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('[data-panel="coin"]').click();
  const ribbon = page.locator('.section-ribbon-track');
  await expect.poll(() => ribbon.evaluate(track => getComputedStyle(track).animationName)).not.toBe('none');
  await page.locator('#toggle-motion').click();
  await expect(page.locator('body')).toHaveClass(/motion-paused/);
  await expect.poll(() => ribbon.evaluate(track => getComputedStyle(track).animationPlayState)).toBe('paused');
  await page.locator('#toggle-motion').click();
  await expect(page.locator('body')).not.toHaveClass(/motion-paused/);
  await expect.poll(() => ribbon.evaluate(track => getComputedStyle(track).animationPlayState)).toBe('running');
});

test('room dock keeps actual participants, hidden chat and media state while switching options', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({
    baseURL, permissions: ['camera', 'microphone'],
  })));
  try {
    const [host, guest] = await Promise.all(contexts.map(context => context.newPage()));
    const room = `experience-${Date.now()}`;
    for (const [page, name] of [[host, 'Banner Host'], [guest, 'Banner Guest']]) {
      await page.goto('/#live-room');
      await expect(page.locator('#room-dock')).toBeHidden();
      await page.locator('#display-name').fill(name);
      await page.locator('#room-code').fill(room);
      await page.locator(page === host ? '#host-room' : '#join-room').click();
      await expect(page.locator('#live-room')).toHaveClass(/connected/);
      await expect(page.locator('#room-dock')).toBeVisible();
      await expect(page.locator('#dock-room')).toHaveText(room);
    }
    for (const page of [host, guest]) {
      await expect(page.locator('#dock-participants')).toContainText('2');
      await expect(page.locator('#live-members-summary')).toContainText('2');
      await expect(page.locator('#live-host-summary')).toContainText('Banner Host');
    }
    await expect(guest.locator('#dock-chat-count')).toBeHidden();
    await guest.locator('[data-panel="feed"]').click();
    await expect(guest.locator('#room-dock')).toBeVisible();
    await host.locator('#chat-input').fill('A real message while you browse the feed');
    await host.locator('#chat-form button').click();
    await expect(guest.locator('#dock-chat-count')).toBeVisible();
    await expect(guest.locator('#dock-chat-count')).toContainText('1');
    await guest.locator('#dock-chat').click();
    await expect(guest.locator('#panel-live')).toBeVisible();
    await expect(guest.locator('#live-room')).toHaveAttribute('data-view', 'chat');
    await expect(guest.locator('#chat-messages')).toContainText('A real message while you browse the feed');
    await expect(guest.locator('#dock-chat-count')).toBeHidden();
    await expect(guest.locator('#live-chat-summary')).toContainText('1');

    await guest.locator('[data-live-view="video"]').click();
    await expect(guest.locator('#live-room')).toHaveAttribute('data-view', 'video');
    await expect(guest.locator('#chat-input')).toBeHidden();
    await host.locator('#chat-input').fill('Chat is still live while you watch video');
    await host.locator('#chat-form button').click();
    await expect(guest.locator('#dock-chat-count')).toContainText('1');
    await guest.locator('#dock-chat').click();
    await expect(guest.locator('#chat-messages li')).toHaveCount(2);
    await expect(guest.locator('#dock-chat-count')).toBeHidden();
    await guest.locator('[data-live-view="split"]').click();
    await expect(guest.locator('#live-room')).toHaveAttribute('data-view', 'split');
    await expect(guest.locator('#chat-input')).toBeVisible();

    await expect(host.locator('#dock-media')).toContainText(/camera.*on/i);
    await host.locator('#toggle-camera').click();
    await host.locator('#toggle-mic').click();
    await expect(host.locator('#dock-media')).toContainText(/camera.*off/i);
    await expect(host.locator('#dock-media')).toContainText(/mic.*(?:off|muted)/i);
    await host.locator('[data-panel="tips"]').click();
    await expect(host.locator('#room-dock')).toBeVisible();
    await host.locator('#dock-leave').click();
    await expect(host.locator('#room-dock')).toBeHidden();
    await expect(host.locator('#live-room')).not.toHaveClass(/connected/);
    await expect(guest.locator('#dock-participants')).toContainText('1');
    await guest.locator('#dock-leave').click();
    await expect(guest.locator('#room-dock')).toBeHidden();
    await expect(guest.locator('#dock-chat-count')).toBeHidden();
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

import { expect, test, type Browser, type Page } from '@playwright/test';

/** Each player gets an isolated browser context so they have separate storage, accounts and sockets. */
async function newPlayer(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  await page.goto('/');
  await page.locator('#name').fill(name);
  return page;
}

async function readCode(page: Page): Promise<string> {
  await expect(page.locator('#room-label')).toHaveText(/Code \d{6}/, { timeout: 30_000 });
  const text = (await page.locator('#room-label').textContent()) ?? '';
  return text.replace('Code ', '').trim();
}

test.describe('multi-client session', () => {
  test('host creates a six-digit code and a joiner enters the world', async ({ browser }) => {
    const host = await newPlayer(browser, 'Alex');
    const friend = await newPlayer(browser, 'Sam');

    await host.locator('#btn-host').click();
    const code = await readCode(host);
    expect(code).toMatch(/^\d{6}$/);
    await expect(host.locator('#hud')).toBeVisible();

    await friend.locator('#code').fill(code);
    await friend.locator('#btn-join').click();
    // The joiner waits until the host's world sync arrives, then the HUD appears.
    await expect(friend.locator('#hud')).toBeVisible({ timeout: 45_000 });
    await expect(host.locator('#roster')).toContainText('Players (2)', { timeout: 20_000 });
    await expect(friend.locator('#roster')).toContainText('Alex');
    // The joiner reports how it reaches the host: a direct WebRTC channel, or the relay fallback.
    await expect(friend.locator('#link-label')).toHaveText(/direct|relay/, { timeout: 30_000 });
  });

  test('chat from one client is shown on the other', async ({ browser }) => {
    const host = await newPlayer(browser, 'Alex');
    const friend = await newPlayer(browser, 'Sam');
    await host.locator('#btn-host').click();
    const code = await readCode(host);
    await friend.locator('#code').fill(code);
    await friend.locator('#btn-join').click();
    await expect(friend.locator('#hud')).toBeVisible({ timeout: 45_000 });

    await friend.keyboard.press('KeyT');
    await friend.locator('#chat-input').fill('hello from sam');
    await friend.locator('#chat-input').press('Enter');
    await expect(host.locator('#chat-log')).toContainText('hello from sam', { timeout: 20_000 });
  });

  test('a wrong join code is refused with a message', async ({ browser }) => {
    const player = await newPlayer(browser, 'Lost');
    await player.locator('#code').fill('000000');
    await player.locator('#btn-join').click();
    await expect(player.locator('#menu-msg')).not.toHaveText('', { timeout: 15_000 });
    await expect(player.locator('#hud')).toBeHidden();
  });
});

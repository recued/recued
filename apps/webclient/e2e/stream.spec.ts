import { expect, test, type Page } from '@playwright/test';

/** D-340 slice 2 (§3.1, §3.7; rulings 10, 11) — the streams' settings, opened over Today: Daily and
 *  Weekly tabs, each its own schedule with its parts and channels, a preview with the full text on
 *  request, and Close the day under them. The harness keeps the server in memory, and declares
 *  `window.__stream`. */
const open = async (page: Page) => {
  await page.goto('/stream-harness.html'); await page.waitForFunction(() => window.__stream !== undefined);
  await page.getByRole('button', { name: 'Daily stream', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Daily stream' });
  await expect(dialog.getByRole('tab', { name: 'Daily · On' })).toBeVisible();
  return dialog;
};

test('opens over Today with a tab for each stream, each saying whether it is on, the arrow keys moving between them', async ({ page }) => {
  const dialog = await open(page);
  await expect(dialog.getByRole('tab', { name: 'Daily · On' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tab', { name: 'Weekly · On' })).toHaveAttribute('aria-selected', 'false');
  await expect(dialog.getByRole('tabpanel', { name: 'Daily · On' })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Daily · On' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('tab', { name: 'Weekly · On' })).toBeFocused();
  await expect(dialog.getByRole('tabpanel', { name: 'Weekly · On' })).toBeVisible();
  await expect(dialog.getByRole('tabpanel', { name: 'Daily · On' })).toBeHidden();
  // The weekly one goes on a day, and looks at least a week ahead; Due today is the daily one's.
  const weekly = dialog.getByRole('tabpanel', { name: 'Weekly · On' });
  await expect(weekly.getByLabel('Day', { exact: true })).toHaveValue('1');
  await expect(weekly.getByLabel('Looks ahead', { exact: true }).locator('option')).toHaveText(['7 days', '14 days']);
  await expect(weekly.getByLabel('Due today', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('saves only what changed, and its tab follows on and off', async ({ page }) => {
  const dialog = await open(page);
  const daily = dialog.getByRole('tabpanel', { name: 'Daily · On' });
  await daily.getByLabel('Time', { exact: true }).fill('06:45');
  await daily.getByLabel('Coming up', { exact: true }).check();
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Daily stream saved.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.saves)).toEqual([{ stream: 'daily', settings: { time: '06:45', coming_up: true } }]);
  await daily.getByLabel('Send me my day', { exact: true }).uncheck();
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: 'Daily · Off' })).toBeVisible();
  expect((await page.evaluate(() => window.__stream.saves)).at(-1)).toEqual({ stream: 'daily', settings: { enabled: false } });
});

test('offers AI suggestions only with the Agenda, and Due today only without it', async ({ page }) => {
  const dialog = await open(page);
  const daily = dialog.getByRole('tabpanel', { name: 'Daily · On' });
  await expect(daily.getByLabel('AI suggestions', { exact: true })).toBeVisible();
  await expect(daily.getByLabel('Due today', { exact: true })).toBeHidden();
  // Checked, then the Agenda goes: they look the Agenda over, so they go with it and are not saved on.
  await daily.getByLabel('AI suggestions', { exact: true }).check();
  await daily.getByLabel('Agenda', { exact: true }).uncheck();
  await expect(daily.getByLabel('AI suggestions', { exact: true })).toBeHidden();
  await expect(daily.getByLabel('Due today', { exact: true })).toBeVisible();
  await daily.getByLabel('Due today', { exact: true }).check();
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Daily stream saved.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.saves)).toEqual([{ stream: 'daily', settings: { agenda: false, due_today: true } }]);
});

// D-340 slice 5 (§3.4) — one switch, saying where they will be named.
test('includes private items by one switch, which says where they will be named', async ({ page }) => {
  const dialog = await open(page);
  const daily = dialog.getByRole('tabpanel', { name: 'Daily · On' });
  const box = daily.getByLabel('Include private items', { exact: true });
  await expect(box).not.toBeChecked();
  await expect(daily).toContainText('Private items, such as how you slept or a passport’s expiry, will be named in the channels this goes to, Close the day included.');
  await box.check();
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Daily stream saved.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.saves)).toEqual([{ stream: 'daily', settings: { include_private: true } }]);
  await dialog.getByRole('tab', { name: 'Weekly · On' }).click();
  await expect(dialog.getByRole('tabpanel', { name: 'Weekly · On' }))
    .toContainText('Private items, such as how you slept or a passport’s expiry, will be named in the channels this goes to.');
});

// D-340 slice 3 (§3.1) — the day's reminders inside the daily stream that lists that day.
test('offers the day\'s reminders in a daily stream that lists today, which then leaves Due today out', async ({ page }) => {
  const dialog = await open(page);
  const daily = dialog.getByRole('tabpanel', { name: 'Daily · On' });
  const box = daily.getByLabel('Reminders from Yours', { exact: true });
  await expect(box).toBeVisible(); await expect(box).not.toBeChecked();
  await expect(daily).toContainText('The reminders due that day, each with its buttons, in this message instead of one by one.');
  // Without the Agenda, Due today is offered until the reminders are.
  await daily.getByLabel('Agenda', { exact: true }).uncheck();
  await expect(daily.getByLabel('Due today', { exact: true })).toBeVisible();
  await box.check();
  await expect(daily.getByLabel('Due today', { exact: true })).toBeHidden();
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Daily stream saved.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.saves)).toEqual([{ stream: 'daily', settings: { agenda: false, reminders: true } }]);
  // A stream that lists tomorrow goes the evening before: no reminders in it.
  await daily.getByLabel('Which day', { exact: true }).selectOption('tomorrow');
  await expect(box).toBeHidden();
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Daily stream saved.', { exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.__stream.saves)).at(-1)).toEqual({ stream: 'daily', settings: { day: 'tomorrow', reminders: false } });
  // The weekly stream carries none.
  await dialog.getByRole('tab', { name: 'Weekly · On' }).click();
  await expect(dialog.getByRole('tabpanel', { name: 'Weekly · On' }).getByLabel('Reminders from Yours', { exact: true })).toHaveCount(0);
});

test('a server from before reminders and private items offers neither, and a save sends it nothing it does not know', async ({ page }) => {
  await page.goto('/stream-harness.html?older=1'); await page.waitForFunction(() => window.__stream !== undefined);
  await page.getByRole('button', { name: 'Daily stream', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Daily stream' });
  const daily = dialog.getByRole('tabpanel', { name: 'Daily · On' });
  await expect(daily.getByLabel('Time', { exact: true })).toHaveValue('07:00');
  await expect(daily.getByLabel('Reminders from Yours', { exact: true })).toBeHidden();
  await expect(daily.getByLabel('Include private items', { exact: true })).toBeHidden();
  await daily.getByLabel('Time', { exact: true }).fill('06:45');
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Daily stream saved.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.saves)).toEqual([{ stream: 'daily', settings: { time: '06:45' } }]);
});

test('sends to every channel set up, or only those picked, and never to none', async ({ page }) => {
  const dialog = await open(page);
  const daily = dialog.getByRole('tabpanel', { name: 'Daily · On' });
  await expect(daily.getByLabel('Every channel you set up', { exact: true })).toBeChecked();
  await expect(daily.getByLabel('Telegram', { exact: true })).toBeHidden();
  await daily.getByLabel('Only these', { exact: true }).check();
  await daily.getByLabel('The app', { exact: true }).uncheck();
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Daily stream saved.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.saves)).toEqual([{ stream: 'daily', settings: { channels: ['telegram'] } }]);
  await daily.getByLabel('Telegram', { exact: true }).uncheck();
  await daily.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: 'Pick a channel, or send it to every channel you set up.' })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.saves)).toHaveLength(1);
});

test('previews its next message, the full text on request, and Send now asks the server to check', async ({ page }) => {
  const dialog = await open(page);
  const daily = dialog.getByRole('tabpanel', { name: 'Daily · On' });
  const next = daily.locator('[data-stream-next]');
  await expect(next).toContainText('· 1 that holds today, 2 agenda items, 1 coming up');
  await expect(next).toContainText('Next: ');
  await expect(daily.getByText('13:00 Lunch with Sam', { exact: false })).toBeHidden();
  await daily.getByText('Show the full text', { exact: true }).click();
  await expect(daily.locator('[data-stream-text]')).toHaveText(/^Short night · Oura ring\s+Agenda\s+07:00 Run 5 km/u);
  await daily.getByRole('button', { name: 'Send now', exact: true }).click();
  await expect(dialog.getByText('Checked. It is sent only when something is on.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.sends)).toEqual(['daily']);
  // The weekly one, off its Agenda and with nothing changed: nothing to send yet.
  await dialog.getByRole('tab', { name: 'Weekly · On' }).click();
  await expect(dialog.getByRole('tabpanel', { name: 'Weekly · On' }).locator('[data-stream-next]')).toContainText('nothing to send yet');
});

test('holds Close the day under the tabs, sent where the daily stream goes', async ({ page }) => {
  const dialog = await open(page);
  const card = dialog.locator('[data-situation-close-day]');
  await expect(card.getByLabel('Ask me each evening what I did', { exact: true })).toBeVisible();
  await expect(card).toContainText('sent where your daily stream goes');
});

test('says once that changes are not saved before it closes, and closes on the second Close', async ({ page }) => {
  const dialog = await open(page);
  await dialog.getByRole('tabpanel', { name: 'Daily · On' }).getByLabel('Time', { exact: true }).fill('06:15');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog.getByText('Your changes are not saved. Save them, or Close again to leave without them.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__stream.closed)).toBe(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__stream.closed)).toBe(1);
  // Escape closes one with nothing changed at once.
  await page.getByRole('button', { name: 'Daily stream', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Daily stream' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Daily stream' })).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('fills the screen and fits it, every control inside', async ({ page }) => {
    const dialog = await open(page);
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const close = await dialog.getByRole('button', { name: 'Close', exact: true }).boundingBox();
    expect(close!.x + close!.width).toBeLessThanOrEqual(390);
  });
});

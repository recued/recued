/** D-405 slice 4, in a real browser: the "Set up" page, reached from the drawer, says what the server
 *  says (mail, a calendar, files; what each pack still needs; the hints set aside), each line with the step
 *  that does it, and "Show it again" brings a hint back. */
import { expect, test } from '@playwright/test';
import { DRAWER_LINK, DRAWER_TOGGLE, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

declare global { interface Window { __setupMailConnected?: boolean } }

installFullAppHooks();

const open = async (page: import('@playwright/test').Page, hash = '#setup') => {
  await page.goto(`${HARNESS_URL}?setup=demo${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};

test('D-405 slice 4 — the drawer\'s Set up opens the page; each line says what the server said, with its step', async ({ page }) => {
  await open(page, '#chat');
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_LINK}="setup"]`).click();
  const setup = page.locator('[data-recued-setup-route]');
  await expect(setup.getByRole('heading', { level: 1, name: 'Set up' })).toBeVisible();
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('setup');
  const mail = setup.locator('[data-setup-row="feature:mail"]');
  await expect(mail).toContainText('No mailbox is connected yet.');
  await expect(mail.getByRole('link', { name: 'Connect your mail', exact: true })).toHaveAttribute('href', '#connections/mail');
  await expect(setup.locator('[data-setup-row="feature:calendar"]')).toContainText('A calendar of yours is connected.');
  await expect(setup.locator('[data-setup-row="feature:file"]')).toHaveAttribute('data-setup-state', 'todo');
  const pack = setup.locator('[data-setup-row="pack:body-signals"]');
  await expect(pack).toContainText('Body signals');
  await expect(pack).toContainText('Needs a Body');
  await expect(setup.locator('[data-setup-summary]')).toContainText('to set up.');
  await mail.getByRole('link', { name: 'Connect your mail', exact: true }).click();
  await expect(page).toHaveURL(/#connections\/mail$/u);
});

test('D-405 slice 4 — a hint set aside is listed with the day it comes back, and "Show it again" brings it back', async ({ page }) => {
  await open(page);
  const setup = page.locator('[data-recued-setup-route]');
  const hint = setup.locator('[data-setup-row="hint:feature:file"]');
  await expect(hint).toContainText('“Connect your files”');
  await expect(hint).toContainText('Hidden until ');
  await hint.getByRole('button', { name: 'Show it again', exact: true }).click();
  await expect(hint).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __setupHints?: unknown[] }).__setupHints)).toEqual([]);
});

test('D-405 slice 4 — the page fits a phone: no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await open(page);
  await expect(page.locator('[data-recued-setup-route]').getByRole('heading', { level: 1, name: 'Set up' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('D-405 slice 9 — while open: a mailbox connected elsewhere shows without a reload, focus kept on its line', async ({ page }) => {
  await open(page);
  const setup = page.locator('[data-recued-setup-route]');
  const mail = setup.locator('[data-setup-row="feature:mail"]');
  await expect(mail).toHaveAttribute('data-setup-state', 'todo');
  await mail.getByRole('link', { name: 'Connect your mail', exact: true }).focus();
  const reads = await page.evaluate(() => window.__app.rpcCallCount('chat.setup.features'));
  // Connected in another tab: the server now says so, and its first records arrive.
  await page.evaluate(() => { window.__setupMailConnected = true; });
  const record = (id: string) => page.evaluate((recordId) => window.__app.fireMessage({ type: 'server_event',
    event: { kind: 'warehouse', collection: 'mail', op: 'insert', id: recordId, cursor: Date.now() } }), id);
  await record('m1');
  await expect(mail).toHaveAttribute('data-setup-state', 'done');
  await expect(mail).toContainText('A mailbox is connected.');
  // Drawn again, and focus is still on the mail line's step.
  expect(await page.evaluate(() => document.activeElement?.closest('[data-setup-row]')?.getAttribute('data-setup-row'))).toBe('feature:mail');
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.setup.features'))).toBe(reads + 1);
  // The sync's next records read nothing more.
  await record('m2');
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.setup.features'))).toBe(reads + 1);
});

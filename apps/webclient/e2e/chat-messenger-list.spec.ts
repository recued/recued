import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createMessengerListFixture as CreateFixture } from './harness/chat-messenger-list-backend.js';
import type { MessengerSessionListReply } from '../src/chat/messenger-session-list.js';
import { openChatHistory } from './helpers/chat-history.js';

let createFixture: typeof CreateFixture;
test.beforeAll(async () => {
  const target = resolve('node_modules/.cache/messenger-list-e2e/backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-messenger-list-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const imported = await import(pathToFileURL(target).href) as { createMessengerListFixture: typeof CreateFixture };
  createFixture = imported.createMessengerListFixture;
});
const notify = (page: Page, session = 'slack-chat') => page.evaluate(session_id => {
  (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent({ kind: 'chat.session_changed', session_id, field: 'delivery', value: true, cursor: Date.now() });
}, session);
const row = (page: Page, session: string) => page.locator(`[data-chat-messenger-row="${session}"]`);
const menu = (page: Page, session: string) => page.locator(`[data-recued-chat-route-session-actions="${session}"]`);
const boot = async (page: Page) => {
  await page.goto('/chat-queue-harness.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await openChatHistory(page);
  await expect(row(page, 'slack-chat').locator('[data-chat-messenger-receive]')).toContainText('Receiving');
};

test('two independent webclients retain Messenger identity after renaming and see receive loss with an empty outbox', async ({ browser }) => {
  const pages: Page[] = [];
  const deliveryReads: string[] = [];
  const fixture = createFixture({ emit: event => { for (const page of pages) void page.evaluate(event => {
    (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } });
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    for (const context of contexts) {
      await context.route('**/d265-rpc', async route => {
        const { method, args } = route.request().postDataJSON();
        if (method === 'chat.deliveries.list') deliveryReads.push(args.session_id);
        await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
      });
      const page = await context.newPage(); pages.push(page); await boot(page);
    }
    fixture.rename('slack-chat', 'Owner edited title');
    for (const page of pages) {
      await expect(page.locator('[data-recued-chat-route-session-row="slack-chat"]')).toContainText('Owner edited title');
      for (const [vendor, label] of [['slack', 'Slack'], ['telegram', 'Telegram'], ['discord', 'Discord']]) {
        await expect(row(page, `${vendor}-chat`).locator('[data-chat-messenger-identity]')).toHaveText(`${label}${vendor}-destination`);
      }
      await expect(row(page, 's')).toBeHidden();
      await expect(row(page, 'messenger:slack:old-channel')).toContainText('Not set up to deliver here');
      await page.locator('[data-recued-chat-route-input]').fill('Keep this unsent draft');
    }
    // No delivery event: the outbox has nothing to send, while the actual
    // receiver disconnects. Only the list's health refresh can surface it.
    fixture.receive('slack', 'retrying');
    for (const page of pages) {
      await expect(row(page, 'slack-chat')).toContainText('Receive: Reconnecting');
      await expect(row(page, 'slack-chat')).toContainText('Send: All sent');
      await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('Keep this unsent draft');
      await expect(page.locator('[data-recued-chat-route-input]')).toBeFocused();
    }
    const page = pages[0]!;
    const search = page.locator('[data-recued-chat-route-history-search]'); await search.fill('Owner');
    fixture.receive('slack', 'active'); await notify(page);
    await expect(row(page, 'slack-chat')).toContainText('Receive: Receiving'); await expect(search).toBeFocused();
    await menu(page, 'slack-chat').locator('summary').click();
    const settings = page.locator('[data-chat-messenger-connection="slack-chat"]'); await settings.focus();
    fixture.account('slack', 'replacement-bot'); await notify(page);
    await expect(row(page, 'slack-chat')).toContainText('The account or where it goes has changed');
    await expect(settings).toBeFocused(); await expect(settings).toHaveAttribute('href', '#connections/others');
    await expect(menu(page, 'slack-chat')).toHaveAttribute('open', '');
    expect(deliveryReads.length).toBeGreaterThan(0);
    expect(deliveryReads.every(id => id === 's')).toBe(true);
  } finally { for (const context of contexts) await context.close(); fixture.close(); }
});

test('row recovery protects drafts, focuses the existing delivery panel, and retries the retained answer', async ({ page }) => {
  const fixture = createFixture({ emit: event => { void page.evaluate(event => {
    (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } });
  try {
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
    });
    await boot(page); await fixture.loseReceipt('slack');
    await expect(row(page, 'slack-chat')).toContainText('1 that Recued cannot account for unknown');
    await page.locator('[data-recued-chat-route-input]').fill('My draft');
    await menu(page, 'slack-chat').locator('summary').click();
    await page.locator('[data-chat-messenger-delivery="slack-chat"]').click();
    await expect(page.locator('[data-recued-chat-route-history-draft-guard]')).toBeVisible();
    await page.getByRole('button', { name: 'Keep writing', exact: true }).click();
    await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('My draft');
    await menu(page, 'slack-chat').locator('summary').click();
    await page.locator('[data-chat-messenger-delivery="slack-chat"]').click();
    await page.getByRole('button', { name: 'Throw it away and open', exact: true }).click();
    const panel = page.locator('[data-chat-delivery]');
    await expect(panel).toBeFocused(); await expect(panel).toContainText('Recued does not know if it arrived');
    await panel.getByRole('button', { name: 'Send again. It may arrive twice', exact: true }).click();
    await expect(row(page, 'slack-chat')).toContainText('Send: All sent');
    expect(fixture.sends()).toBe(2);
    await expect(page.locator('[data-role="assistant"]')).toContainText('The retained answer');
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('stale and failed list reads cannot revive success, and older server replies keep ordinary history usable', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} });
  let fail = false; let older = false; let hold = false; let release: (() => void) | undefined;
  let held!: Promise<void>; let heldRead = false;
  try {
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      const result = await fixture.rpc(method, args);
      if (method === 'chat.sessions.list') {
        if (fail) { await route.fulfill({ json: { error: 'fixture offline' } }); return; }
        if (older) {
          const reply = result as MessengerSessionListReply;
          await route.fulfill({ json: { result: { sessions: reply.sessions.map(({ messenger: _messenger, ...session }) => session) } } }); return;
        }
        if (hold) { hold = false; heldRead = true; await held; }
      }
      await route.fulfill({ json: { result } });
    });
    await boot(page);
    fail = true; await notify(page);
    await expect(row(page, 'slack-chat')).toContainText('Recued cannot tell if it is receiving');
    await expect(row(page, 'slack-chat')).toContainText('Recued cannot tell what was sent');
    fail = false; await notify(page); await expect(row(page, 'slack-chat')).toContainText('Receiving');
    held = new Promise<void>(resolve => { release = resolve; }); hold = true; await notify(page);
    await expect.poll(() => heldRead).toBe(true);
    fixture.receive('slack', 'retrying');
    await page.evaluate(() => (window as unknown as { queueTestRefresh(): Promise<void> }).queueTestRefresh());
    await expect(row(page, 'slack-chat')).toContainText('Reconnecting');
    release!(); await notify(page);
    await expect(row(page, 'slack-chat')).toContainText('Reconnecting');
    older = true; await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(row(page, 'slack-chat')).toBeHidden();
    await expect(page.locator('[data-recued-chat-route-session-row="slack-chat"]')).toContainText('My slack project');
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('Messenger actions remain reachable on the final history row in a narrow viewport', async ({ page }, testInfo) => {
  const fixture = createFixture({ emit: () => {} });
  try {
    await page.setViewportSize({ width: 390, height: 680 });
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
    });
    await boot(page);
    const actions = menu(page, 'messenger:slack:old-channel');
    await actions.locator('summary').click();
    const settings = page.locator('[data-chat-messenger-connection="messenger:slack:old-channel"]');
    await expect(settings).toBeInViewport();
    const remove = actions.getByRole('button', { name: 'Delete chat', exact: true });
    await expect(remove).toBeInViewport();
    await remove.click({ trial: true }); await settings.click({ trial: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await actions.locator('summary').click();
    await page.screenshot({ path: testInfo.outputPath('messenger-list.png'), fullPage: true });
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

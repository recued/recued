import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatMessageSearchRequest } from '@recued/contracts';
import type { createMessengerListFixture as CreateFixture } from './harness/chat-messenger-list-backend.js';
import type { MessengerSessionListReply } from '../src/chat/messenger-session-list.js';

let createFixture: typeof CreateFixture;
test.beforeAll(async () => {
  const target = resolve('node_modules/.cache/history-filters-e2e/backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-messenger-list-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const imported = await import(pathToFileURL(target).href) as { createMessengerListFixture: typeof CreateFixture };
  createFixture = imported.createMessengerListFixture;
});
const filter = (page: Page, id: string) => page.locator(`[data-chat-history-filter="${id}"]`);
const search = (page: Page) => page.locator('[data-recued-chat-route-history-search]');
const hits = (page: Page) => page.locator('[data-recued-chat-history-message]');
const row = (page: Page, id: string) => page.locator(`[data-recued-chat-route-session-row="${id}"]`);
const boot = async (page: Page) => {
  await page.goto('/chat-queue-harness.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('[data-chat-messenger-row="telegram-chat"]')).toContainText('Receive: Receiving');
};
const seed = async (fixture: ReturnType<typeof createFixture>) => {
  for (const session of ['s', 'telegram-chat', 'slack-chat', 'discord-chat']) {
    await fixture.addMessage(session, `hit-${session}`, `A needle in ${session}`, 1);
  }
};

test('vendor filters constrain rows and real message hits, and exact jumps protect drafts', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} });
  const requests: ChatMessageSearchRequest[] = [];
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'chat.messages.search') requests.push(args);
      await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
    });
    await boot(page);
    await expect(page.locator('[data-recued-chat-route-history-empty]')).toBeHidden();
    await page.locator('[data-recued-chat-route-input]').fill('Keep my draft');
    await filter(page, 'vendor').selectOption('telegram');
    await expect(row(page, 'telegram-chat')).toBeVisible();
    await expect(row(page, 's')).toBeHidden(); await expect(row(page, 'slack-chat')).toBeHidden();
    await expect(page.locator('[data-recued-chat-route-history-empty]')).toBeHidden();
    await search(page).fill('needle');
    await expect(hits(page)).toHaveCount(1); await expect(hits(page)).toContainText('A needle in telegram-chat');
    await filter(page, 'scope').selectOption('current');
    await expect(hits(page)).toHaveCount(0);
    await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('No matching messages');
    expect(requests.at(-1)).toMatchObject({ session_id: 's', filters: { vendor: 'telegram' } });
    await filter(page, 'scope').selectOption('all');
    await expect(hits(page)).toHaveCount(1); await hits(page).click();
    await expect(page.locator('[data-recued-chat-route-history-draft-guard]')).toBeVisible();
    await page.getByRole('button', { name: 'Keep writing', exact: true }).click();
    await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('Keep my draft');
    await hits(page).click(); await page.getByRole('button', { name: 'Throw it away and open', exact: true }).click();
    await expect(page.locator('[data-recued-chat-route-message="hit-telegram-chat"]')).toBeVisible();
    await filter(page, 'scope').selectOption('current');
    await expect(hits(page)).toHaveCount(1);
    expect(requests.at(-1)).toMatchObject({ session_id: 'telegram-chat' });
    const searchesBeforeDraft = requests.length;
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('Open a chat first, then you can search inside it');
    await expect(hits(page)).toHaveCount(0); expect(requests.length).toBe(searchesBeforeDraft);
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('pagination resets on filters and refresh restores preferences without query or cursor', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); const requests: ChatMessageSearchRequest[] = [];
  try {
    await seed(fixture);
    for (let i = 0; i < 35; i++) await fixture.addMessage('telegram-chat', `older-${i}`, 'needle older', i + 2);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'chat.messages.search') requests.push(args);
      await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
    });
    await boot(page); await filter(page, 'vendor').selectOption('telegram'); await search(page).fill('needle');
    await expect(hits(page)).toHaveCount(30);
    await page.locator('[data-recued-chat-history-message-more]').click(); await expect(hits(page)).toHaveCount(36);
    expect(requests.at(-1)?.before).toBeDefined();
    await filter(page, 'vendor').selectOption('discord'); await expect(hits(page)).toHaveCount(1);
    expect(requests.at(-1)?.before).toBeUndefined();
    await expect.poll(async () => (await fixture.rpc('prefs.get', {}) as { prefs: Record<string, unknown> }).prefs['ui.chat.history.vendor']).toBe('discord');
    await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(filter(page, 'vendor')).toHaveValue('discord'); await expect(search(page)).toHaveValue('');
    await expect(hits(page)).toHaveCount(0); await expect(row(page, 'discord-chat')).toBeVisible();
    await search(page).fill('needle'); await expect(hits(page)).toHaveCount(1); expect(requests.at(-1)?.before).toBeUndefined();
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('attention follows receive loss and recovery with an empty outbox while retaining focus', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} });
  try {
    // Local delivery catches up before the simulated receive outage.
    await seed(fixture);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
    });
    await boot(page); await filter(page, 'vendor').selectOption('slack'); await filter(page, 'attention').check();
    await expect(row(page, 'slack-chat')).toBeHidden();
    await search(page).fill('needle'); await expect(hits(page)).toHaveCount(0);
    fixture.receive('slack', 'retrying');
    await expect(hits(page)).toHaveCount(1); await expect(search(page)).toBeFocused();
    await search(page).fill(''); await expect(row(page, 'slack-chat')).toBeVisible();
    await expect(row(page, 'slack-chat')).toContainText('Send: All sent');
    await page.locator('[data-recued-chat-route-session-actions="slack-chat"] summary').click();
    const settings = page.locator('[data-chat-messenger-connection="slack-chat"]'); await settings.focus();
    fixture.receive('slack', 'active');
    await expect(row(page, 'slack-chat')).toContainText('Receive: Receiving');
    await expect(settings).toBeFocused(); await expect(row(page, 'slack-chat')).toBeVisible();
    await search(page).focus(); await expect(row(page, 'slack-chat')).toBeHidden();
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('late broad responses cannot overwrite a newer vendor scope', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); let held = false; let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON(); const result = await fixture.rpc(method, args);
      if (method === 'chat.messages.search' && !args.filters && !held) { held = true; await wait; }
      await route.fulfill({ json: { result } });
    });
    await boot(page); await search(page).fill('needle'); await expect.poll(() => held).toBe(true);
    await filter(page, 'vendor').selectOption('telegram'); await expect(hits(page)).toHaveCount(1);
    release(); await expect(hits(page)).toHaveText(/A needle in telegram-chat/);
    await filter(page, 'scope').selectOption('current'); await expect(hits(page)).toHaveCount(0);
    await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('No matching messages');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('older servers keep default search usable and never present broad hits under a scoped label', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); let searches = 0;
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON(); let result = await fixture.rpc(method, args);
      if (method === 'chat.sessions.list') {
        const { history_filters_available: _capability, ...old } = result as MessengerSessionListReply; result = old;
      }
      if (method === 'chat.messages.search') searches++;
      await route.fulfill({ json: { result } });
    });
    await boot(page); await filter(page, 'vendor').selectOption('telegram'); await search(page).fill('needle');
    await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('This server cannot filter chats');
    expect(searches).toBe(0); await expect(hits(page)).toHaveCount(0);
    await filter(page, 'clear').click(); await expect(hits(page)).toHaveCount(4);
    await filter(page, 'scope').selectOption('current');
    await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('This server cannot narrow the search');
    await expect(hits(page)).toHaveCount(0); expect(searches).toBe(1);
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('slow preference reads cannot replace edits and rapid changes persist in order', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); let reading = false; let writing = false;
  let releaseRead!: () => void; let releaseWrite!: () => void;
  const readWait = new Promise<void>(resolve => { releaseRead = resolve; });
  const writeWait = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writes: string[] = [];
  try {
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'prefs.get' && !reading) {
        const result = await fixture.rpc(method, args); reading = true; await readWait;
        await route.fulfill({ json: { result } }); return;
      }
      if (method === 'prefs.set') {
        writes.push(args.patch['ui.chat.history.vendor']);
        if (!writing) { writing = true; await writeWait; }
      }
      await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
    });
    await page.goto('/chat-queue-harness.html'); await expect(filter(page, 'vendor')).toBeVisible();
    await filter(page, 'vendor').selectOption('telegram'); await expect.poll(() => writing).toBe(true);
    await filter(page, 'vendor').selectOption('discord'); await filter(page, 'scope').selectOption('current');
    releaseRead(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(filter(page, 'vendor')).toHaveValue('discord'); expect(writes).toEqual(['telegram']);
    releaseWrite();
    await expect.poll(async () => (await fixture.rpc('prefs.get', {}) as { prefs: Record<string, unknown> }).prefs['ui.chat.history.scope']).toBe('current');
    expect(writes).toEqual(['telegram', 'discord']);
    await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(filter(page, 'vendor')).toHaveValue('discord'); await expect(filter(page, 'scope')).toHaveValue('current');
  } finally { releaseRead(); releaseWrite(); await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('unavailable status clears scoped hits and a failed preference save can be retried', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); let unavailable = false; let failSave = true;
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'prefs.set' && failSave) { await route.fulfill({ json: { error: 'fixture save failed' } }); return; }
      let result = await fixture.rpc(method, args);
      if (method === 'chat.sessions.list' && unavailable) result = { ...result as MessengerSessionListReply, messenger_status_available: false };
      await route.fulfill({ json: { result } });
    });
    await boot(page); await filter(page, 'vendor').selectOption('telegram'); await search(page).fill('needle');
    await expect(hits(page)).toHaveCount(1);
    await expect(page.locator('.chat-history-filter-note')).toContainText('Recued will forget them');
    failSave = false; await filter(page, 'retry').click(); await expect(filter(page, 'retry')).toBeHidden();
    unavailable = true;
    await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('Recued cannot tell whether Chat is connected');
    await expect(hits(page)).toHaveCount(0);
    unavailable = false; await expect(hits(page)).toHaveCount(1);
    await expect(filter(page, 'vendor')).toHaveValue('telegram');
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

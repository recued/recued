import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatSessionListRequest } from '@recued/contracts';
import type { createMessengerListFixture as CreateFixture } from './harness/chat-messenger-list-backend.js';
import { openChatHistory, openChatHistoryFilters } from './helpers/chat-history.js';

let createFixture: typeof CreateFixture;
test.beforeAll(async () => {
  const target = resolve('node_modules/.cache/history-batches-e2e/backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-messenger-list-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href) as { createMessengerListFixture: typeof CreateFixture }).createMessengerListFixture;
});
const rows = (page: Page) => page.locator('[data-recued-chat-route-session-row]:visible');
const more = (page: Page) => page.locator('[data-chat-history-load-more]');
const search = (page: Page) => page.locator('[data-recued-chat-route-history-search]');
const seed = async (fixture: ReturnType<typeof createFixture>, tied = false) => {
  const now = Date.now() + 1000;
  for (let i = 0; i < 120; i++) fixture.addSession(`bulk-${String(i).padStart(3, '0')}`, `Saved chat ${i}`, now + (tied ? 0 : i));
  fixture.addSession('old-target', 'ÉCOLE discussion', 1);
  await fixture.addMessage('old-target', 'old-hit', 'An école message in the older chat.', 1);
  fixture.rename('s', 'Draft source chat');
};
const boot = async (page: Page, draft?: string) => {
  await page.goto('/chat-queue-harness.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  if (draft) await page.locator('[data-recued-chat-route-input]').fill(draft);
  await openChatHistory(page);
  await expect(rows(page)).toHaveCount(50);
};

for (const width of [1440, 390]) test(`Load more appends bounded batches and keeps the reading position at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = createFixture({ emit: () => {} }); const requests: ChatSessionListRequest[] = [];
  let release!: () => void; let held = true;
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    await seed(fixture, width === 1440);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      const result = await fixture.rpc(method, args);
      if (method === 'chat.sessions.list') { requests.push(args); if (args?.before && held) { held = false; await wait; } }
      await route.fulfill({ json: { result } });
    });
    await boot(page, 'Keep this draft'); expect(requests[0]).toEqual({ limit: 50 });
    const firstIds = await rows(page).evaluateAll(nodes => nodes.map(row => row.getAttribute('data-recued-chat-route-session-row')));
    await more(page).scrollIntoViewIfNeeded();
    const scroller = page.locator('[data-recued-chat-route-session-list]');
    const top = await scroller.evaluate(el => el.scrollTop);
    await more(page).click(); await expect(more(page)).toHaveAttribute('aria-disabled', 'true');
    await more(page).dispatchEvent('click'); await expect.poll(() => requests.filter(r => r.before).length).toBe(1);
    release(); await expect(rows(page)).toHaveCount(100);
    expect((await rows(page).evaluateAll(nodes => nodes.map(row => row.getAttribute('data-recued-chat-route-session-row')))).slice(0, 50)).toEqual(firstIds);
    await expect(page.locator('[data-recued-chat-route-session-row="bulk-069"]')).toBeFocused();
    expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - top)).toBeLessThan(2);
    await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('Keep this draft');
    await more(page).click(); await expect(more(page)).toHaveCount(0);
    const ids = await rows(page).evaluateAll(nodes => nodes.map(n => n.getAttribute('data-recued-chat-route-session-row')));
    expect(new Set(ids).size).toBe(ids.length); expect(ids).toContain('old-target');
    expect(requests.every(r => r.limit === 50)).toBe(true);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('title and message search reach older unloaded chats and preserve parked drafts', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} });
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => { const { method, args } = route.request().postDataJSON(); await route.fulfill({ json: { result: await fixture.rpc(method, args) } }); });
    await boot(page); await page.locator('[data-recued-chat-route-input]').fill('Park this draft');
    await search(page).fill('école'); await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toHaveAttribute('data-recued-chat-route-session-row', 'old-target');
    await expect(page.locator('[data-recued-chat-history-message="old-hit"]')).toBeVisible();
    await page.locator('[data-recued-chat-history-message="old-hit"]').click();
    await expect(page.locator('[data-role="user"]')).toContainText('An école message');
    await search(page).fill('Draft source chat');
    await page.locator('[data-recued-chat-route-session-row="s"]').click();
    await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('Park this draft');
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('global filters discover an unloaded receive outage even when no chats initially need attention', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} });
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => { const { method, args } = route.request().postDataJSON(); await route.fulfill({ json: { result: await fixture.rpc(method, args) } }); });
    await boot(page); await openChatHistoryFilters(page);
    await page.locator('[data-chat-history-filter="vendor"]').selectOption('telegram');
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('[data-chat-messenger-row="telegram-chat"]')).toContainText('Receive: Receiving');
    await page.locator('[data-chat-history-filter="attention"]').focus();
    await page.locator('[data-chat-history-filter="attention"]').check(); await expect(rows(page)).toHaveCount(0);
    await page.locator('[data-chat-history-filter="attention"]').focus();
    await expect(page.locator('[data-chat-history-filter="attention"]')).toBeFocused();
    fixture.receive('telegram', 'retrying');
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('[data-chat-messenger-row="telegram-chat"]')).toContainText('Reconnecting');
    await expect(page.locator('[data-chat-history-filter="attention"]')).toBeFocused();
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('one filtered refresh retains three loaded batches, focus and the parked draft', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} });
  const requests: ChatSessionListRequest[] = []; const completed: number[] = []; let statusReads = 0;
  try {
    await seed(fixture);
    for (let i = 120; i < 200; i++) fixture.addSession(`bulk-${String(i).padStart(3, '0')}`, `Saved chat ${i}`, Date.now() + i);
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'chat.messenger.status') statusReads++;
      if (method === 'chat.sessions.list') requests.push(args);
      const result = await fixture.rpc(method, args);
      if (method === 'chat.sessions.list') completed.push((result as { sessions: unknown[] }).sessions.length);
      await route.fulfill({ json: { result } });
    });
    await boot(page, 'Keep this filtered draft'); await openChatHistoryFilters(page);
    await page.locator('[data-chat-history-filter="source"]').selectOption('webclient');
    await page.clock.fastForward(200); await expect(rows(page)).toHaveCount(50);
    await more(page).click(); await expect(rows(page)).toHaveCount(100);
    await more(page).click(); await expect(rows(page)).toHaveCount(150);
    await search(page).focus();
    const scroller = page.locator('[data-recued-chat-route-session-list]');
    await scroller.evaluate(el => { el.scrollTop = 500; });
    const top = await scroller.evaluate(el => el.scrollTop);
    requests.length = 0; completed.length = 0; statusReads = 0;
    await page.clock.fastForward(5_200);
    await expect.poll(() => completed).toEqual([150]);
    expect(requests).toEqual([{ limit: 50, filters: { source: 'webclient', vendor: 'all', needs_attention: false }, refresh_count: 150 }]);
    expect(statusReads).toBe(0); await expect(rows(page)).toHaveCount(150);
    await expect(search(page)).toBeFocused();
    expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - top)).toBeLessThan(2);
    await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('Keep this filtered draft');
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('a failed next batch keeps its rows and a new search supersedes an older pending batch', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); let fail = true; let hold = false; let held = false; let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON(); const result = await fixture.rpc(method, args);
      if (method === 'chat.sessions.list' && args?.before) {
        if (fail) { fail = false; await route.fulfill({ json: { error: 'fixture offline' } }); return; }
        if (hold) { held = true; await wait; }
      }
      await route.fulfill({ json: { result } });
    });
    await boot(page); await more(page).click(); await expect(more(page)).toHaveText('Try loading chats again'); await expect(rows(page)).toHaveCount(50);
    await more(page).click(); await expect(rows(page)).toHaveCount(100);
    hold = true; await more(page).click(); await expect.poll(() => held).toBe(true);
    await search(page).fill('école'); await expect(rows(page)).toHaveCount(1);
    release(); await expect(rows(page)).toHaveAttribute('data-recued-chat-route-session-row', 'old-target'); await expect(more(page)).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('an immediate Load more after a search change starts with the new scope', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); const requests: ChatSessionListRequest[] = [];
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'chat.sessions.list') requests.push(args);
      await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
    });
    await boot(page);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-recued-chat-route-history-search]')!;
      input.value = 'école'; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector<HTMLButtonElement>('[data-chat-history-load-more]')!.click();
    });
    await expect.poll(() => requests.length).toBeGreaterThan(1);
    expect(requests[1]).toEqual({ limit: 50, query: 'école' });
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toHaveAttribute('data-recued-chat-route-session-row', 'old-target');
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('initial readiness waits for the saved filter scope and active chat', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); let firstStarted = false; let filteredStarted = false; let opened = false;
  let releaseFirst!: () => void; let releaseFiltered!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const filtered = new Promise<void>(resolve => { releaseFiltered = resolve; });
  try {
    await fixture.rpc('prefs.set', { patch: { 'ui.chat.history.source': 'messenger', 'ui.chat.history.vendor': 'telegram' } });
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON(); const result = await fixture.rpc(method, args);
      if (method === 'chat.sessions.list') {
        if (args.filters) { filteredStarted = true; await filtered; }
        else { firstStarted = true; await first; }
      }
      if (method === 'chat.session.get') opened = true;
      await route.fulfill({ json: { result } });
    });
    const prefsResponse = page.waitForResponse(response => {
      try { return response.request().postDataJSON()?.method === 'prefs.get'; } catch { return false; }
    });
    await page.goto('/chat-queue-harness.html'); await (await prefsResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect.poll(() => firstStarted).toBe(true); releaseFirst();
    await expect.poll(() => filteredStarted).toBe(true);
    expect(await page.locator('body').getAttribute('data-ready')).not.toBe('true');
    releaseFiltered(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true'); expect(opened).toBe(true);
  } finally { releaseFirst(); releaseFiltered(); await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('deleting the final empty chat restores the empty state and keyboard focus', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} });
  try {
    const all = await fixture.rpc('chat.sessions.list', undefined) as { sessions: Array<{ id: string }> };
    for (const session of all.sessions) if (session.id !== 's') await fixture.rpc('chat.session.delete', { session_id: session.id });
    await page.route('**/d265-rpc', async route => { const { method, args } = route.request().postDataJSON(); await route.fulfill({ json: { result: await fixture.rpc(method, args) } }); });
    await page.goto('/chat-queue-harness.html'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true'); await openChatHistory(page);
    await expect(rows(page)).toHaveCount(1);
    await page.locator('[data-recued-chat-route-session-actions="s"] summary').click();
    await page.locator('[data-recued-chat-route-session-delete="s"]').click();
    await page.locator('[data-recued-chat-route-session-delete-confirm="s"]').click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('[data-recued-chat-route-history-empty]')).toContainText('No saved chats yet');
    await expect(page.locator('[data-recued-chat-route-new-session]')).toBeFocused();
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createMessengerListFixture as CreateFixture } from './harness/chat-messenger-list-backend.js';
import { openChatHistory } from './helpers/chat-history.js';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';

let createFixture: typeof CreateFixture;
test.beforeAll(async () => {
  const target = resolve('node_modules/.cache/chat-rename-e2e/backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-messenger-list-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href)).createMessengerListFixture;
});

const row = (page: Page) => page.locator('[data-recued-chat-route-session-row="s"]');
const editor = (page: Page) => page.getByRole('form', { name: 'Rename chat' });
const name = (page: Page) => editor(page).getByRole('textbox', { name: 'Chat name' });
const composer = (page: Page) => page.locator('[data-recued-chat-route-input]');
const save = (page: Page) => editor(page).getByRole('button', { name: 'Save', exact: true });
const startRename = async (page: Page) => {
  await openChatHistory(page);
  await page.locator('[data-recued-chat-route-session-actions="s"] summary').click();
  await page.locator('[data-recued-chat-route-session-actions="s"]').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(name(page)).toBeFocused();
};
const setup = async () => {
  const pages: Page[] = []; const requests: unknown[] = [];
  let silentTitles = false;
  const fixture = createFixture({ emit: event => { if (silentTitles && event.kind === 'chat.session_changed' && event.field === 'title') return;
    for (const page of pages) void page.evaluate(event => {
    window.__app.fireMessage({ type: 'server_event', event });
  }, { ...event, cursor: Date.now() }).catch(() => {}); } });
  await fixture.addMessage('s', 'kept', 'The retained answer stays here.');
  let loseReply = false; let gate: Promise<void> | undefined; let listGate: Promise<void> | undefined; let pendingLists = 0; let failLists = false;
  const boot = async (context: BrowserContext) => {
    await context.route('**/rename-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      try {
        if (method === 'chat.session.rename') requests.push(args);
        const result = await fixture.rpc(method, args);
        if (method === 'chat.sessions.list') {
          if (listGate) { pendingLists++; try { await listGate; } finally { pendingLists--; } }
          if (failLists) throw Object.assign(new Error('History refresh unavailable.'), { code: 'UNAVAILABLE' });
        }
        if (method === 'chat.session.rename') {
          if (gate) await gate;
          if (loseReply) { loseReply = false; throw Object.assign(new Error('The reply was lost.'), { code: 'UNAVAILABLE' }); }
        }
        await route.fulfill({ json: { result } });
      } catch (error) {
        await route.fulfill({ json: { error: { code: (error as { code?: string }).code ?? 'UNAVAILABLE', message: (error as Error).message } } });
      }
    });
    await context.addInitScript(() => Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (!['chat.sessions.list', 'chat.messenger.status', 'chat.session.get', 'chat.session.rename', 'chat.messages.search', 'chat.deliveries.list', 'chat.turns.list',
        'server.getLLMConfig', 'chat.default_model_pref.get', 'chat.picker.list', 'collection.connection.list', 'recipe.list', 'prefs.get', 'prefs.set'].includes(method)) return undefined;
      return (await fetch('/rename-rpc', { method: 'POST', body: JSON.stringify({ method, args }) })).json();
    } }));
    const page = await context.newPage(); pages.push(page);
    await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html#chat/session/s`); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(composer(page)).toBeVisible(); return page;
  };
  return { fixture, requests, boot, loseNextReply: () => { loseReply = true; }, hold: (promise: Promise<void>) => { gate = promise; },
    silentTitles: () => { silentTitles = true; }, failLists: () => { failLists = true; },
    holdLists: (promise: Promise<void>) => { listGate = promise; }, pendingLists: () => pendingLists,
    currentTitle: async () => ((await fixture.rpc('chat.sessions.list', undefined)) as { sessions: Array<{ id: string; title?: string }> }).sessions.find(session => session.id === 's')?.title,
  };
};

for (const width of [1280, 390]) test(`Rename stays in the existing menu, cancels safely and updates both clients at ${width}px`, async ({ browser }) => {
  const h = await setup(); const contexts = [await browser.newContext({ viewport: { width, height: 900 } }), await browser.newContext({ viewport: { width, height: 900 } })];
  try {
    const a = await h.boot(contexts[0]!); const b = await h.boot(contexts[1]!);
    await composer(a).fill('Keep my unsent draft'); await composer(b).fill('A different draft');
    await startRename(a); await name(a).fill('Discard this name'); await a.keyboard.press('Escape');
    await expect(editor(a)).toHaveCount(0); expect(h.requests).toHaveLength(0); await expect(row(a)).toBeFocused();
    await startRename(a); await name(a).fill('Japan planning 🧭 <notes>'); await name(a).press('Enter');
    await expect(editor(a)).toHaveCount(0); await openChatHistory(b);
    for (const page of [a, b]) { await expect(row(page)).toContainText('Japan planning 🧭 <notes>'); await expect(row(page).locator('notes')).toHaveCount(0); }
    await expect(composer(a)).toHaveValue('Keep my unsent draft'); await expect(composer(b)).toHaveValue('A different draft');
    await expect(a.locator('[data-recued-chat-route-thread-title]')).toHaveText('Japan planning 🧭 <notes>');
    expect(h.requests).toHaveLength(1);
  } finally { for (const context of contexts) await context.close(); h.fixture.close(); }
});

test('Rename retains its draft and retries a lost success reply without creating another message', async ({ browser }) => {
  const h = await setup(); const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await h.boot(context); await startRename(page); await name(page).fill('Confirmed name'); h.loseNextReply(); await save(page).click();
    await expect(editor(page).getByRole('alert')).toContainText('Could not rename'); await expect(name(page)).toHaveValue('Confirmed name');
    await expect(save(page)).toBeFocused(); await page.keyboard.press('Enter'); await expect(editor(page)).toHaveCount(0);
    await expect(row(page)).toContainText('Confirmed name'); expect(h.requests).toHaveLength(2);
    const snapshot = await h.fixture.rpc('chat.session.get', { session_id: 's' }) as { messages: unknown[] };
    expect(snapshot.messages).toHaveLength(1);
  } finally { await context.close(); h.fixture.close(); }
});

test('Rename keeps an edited name through an external update and refuses to overwrite it silently', async ({ browser }) => {
  const h = await setup(); const context = await browser.newContext();
  try {
    const page = await h.boot(context); await startRename(page); await name(page).fill('My proposed name');
    await name(page).evaluate(input => (input as HTMLInputElement).setSelectionRange(3, 8));
    await h.fixture.rpc('chat.session.rename', { session_id: 's', title: 'Other client name', expected_title: 'Web conversation' });
    await expect(row(page)).toContainText('Other client name'); await expect(name(page)).toBeFocused(); await expect(name(page)).toHaveValue('My proposed name');
    expect(await name(page).evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([3, 8]);
    await save(page).click(); await expect(editor(page).getByRole('alert')).toContainText('renamed elsewhere'); await expect(name(page)).toHaveValue('My proposed name');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await startRename(page); await expect(name(page)).toHaveValue('Other client name');
  } finally { await context.close(); h.fixture.close(); }
});

test('a delayed Rename reply preserves a newer title and the composer focus and selection', async ({ browser }) => {
  const h = await setup(); const context = await browser.newContext(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await h.boot(context); await startRename(page); await name(page).fill('First name'); h.hold(pending); await save(page).click();
    await expect(editor(page).getByRole('button', { name: 'Saving…' })).toBeFocused();
    await expect.poll(h.currentTitle).toBe('First name');
    await h.fixture.rpc('chat.session.rename', { session_id: 's', title: 'Newer name', expected_title: 'First name' });
    await expect(row(page)).toContainText('Newer name'); await composer(page).fill('Keep this next thought'); await composer(page).evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(2, 7));
    release(); await expect(editor(page)).toHaveCount(0); await expect(row(page)).toContainText('Newer name');
    await expect(composer(page)).toBeFocused(); await expect(composer(page)).toHaveValue('Keep this next thought');
    expect(await composer(page).evaluate(input => [(input as HTMLTextAreaElement).selectionStart, (input as HTMLTextAreaElement).selectionEnd])).toEqual([2, 7]);
  } finally { release(); await context.close(); h.fixture.close(); }
});

test('a known Rename conflict remains cancellable while the history refresh is pending', async ({ browser }) => {
  const h = await setup(); const context = await browser.newContext(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await h.boot(context); await startRename(page); await name(page).fill('My proposed name');
    h.silentTitles(); await h.fixture.rpc('chat.session.rename', { session_id: 's', title: 'Other client name', expected_title: 'Web conversation' });
    h.holdLists(pending); await save(page).click(); await expect.poll(h.pendingLists).toBeGreaterThan(0);
    await expect(editor(page).getByRole('alert')).toContainText('renamed elsewhere', { timeout: 1500 });
    await expect(name(page)).toBeEditable(); await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor(page)).toHaveCount(0); release(); await expect(row(page)).toContainText('Other client name');
  } finally { release(); await expect.poll(h.pendingLists).toBe(0); await context.close(); h.fixture.close(); }
});

test('newer title broadcasts survive a failed list refresh and an older Rename reply', async ({ browser }) => {
  const h = await setup(); const context = await browser.newContext(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await h.boot(context); await startRename(page); await name(page).fill('First name'); h.hold(pending); await save(page).click();
    await expect.poll(h.currentTitle).toBe('First name'); h.failLists();
    await h.fixture.rpc('chat.session.rename', { session_id: 's', title: 'Newer name', expected_title: 'First name' });
    await expect(page.locator('[data-recued-chat-route-thread-title]')).toHaveText('Newer name');
    release(); await expect(editor(page)).toHaveCount(0); await expect(row(page)).toContainText('Newer name');
    const search = page.getByRole('searchbox', { name: 'Search chats and messages' }); await search.fill('retained');
    await expect(page.locator('[data-recued-chat-history-message="kept"] .chat-session-title')).toHaveText('Newer name');
  } finally { release(); await context.close(); h.fixture.close(); }
});

test('a list read begun before Rename cannot revert it or lose other session updates', async ({ browser }) => {
  const h = await setup(); const context = await browser.newContext(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await h.boot(context); h.silentTitles();
    await h.fixture.rpc('chat.session.rename', { session_id: 'discord-chat', title: 'Read response arrived', expected_title: 'My discord project' });
    h.holdLists(pending);
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
      kind: 'chat.session_changed', session_id: 's', field: 'title', value: 'Web conversation', cursor: Date.now(),
    } }));
    await expect.poll(h.pendingLists).toBeGreaterThan(0);
    await startRename(page); await name(page).fill('Confirmed name'); await save(page).click(); await expect(editor(page)).toHaveCount(0);
    await expect(row(page)).toContainText('Confirmed name'); release();
    await expect(page.locator('[data-recued-chat-route-session-row="discord-chat"]')).toContainText('Read response arrived');
    await expect(row(page)).toContainText('Confirmed name');
  } finally { release(); await expect.poll(h.pendingLists).toBe(0); await context.close(); h.fixture.close(); }
});

test('a renamed row that no longer matches search returns focus to the search field', async ({ browser }) => {
  const h = await setup(); const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await h.boot(context); await openChatHistory(page);
    const search = page.getByRole('searchbox', { name: 'Search chats and messages' }); await search.fill('Web conversation');
    await startRename(page); await name(page).fill('Japan planning'); await save(page).click();
    await expect(editor(page)).toHaveCount(0); await expect(row(page)).toHaveCount(0); await expect(search).toBeFocused();
    await search.fill('Japan planning'); await expect(row(page)).toContainText('Japan planning');
  } finally { await context.close(); h.fixture.close(); }
});

import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatMessageSearchRequest, InstancePrefs } from '@recued/contracts';
import type { createMessengerListFixture as CreateFixture } from './harness/chat-messenger-list-backend.js';
import type { MessengerSessionListReply } from '../src/chat/messenger-session-list.js';
import { openChatHistory, openChatHistoryFilters } from './helpers/chat-history.js';

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
  await openChatHistoryFilters(page);
};
const seed = async (fixture: ReturnType<typeof createFixture>) => {
  for (const session of ['s', 'telegram-chat', 'slack-chat', 'discord-chat']) {
    await fixture.addMessage(session, `hit-${session}`, `A needle in ${session}`, 1);
  }
};

test('vendor filters constrain rows and real message hits, and exact jumps keep drafts', async ({ page }) => {
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
    // Since 04844efda a typed draft stays with the chat it was written in, so an exact jump asks nothing.
    await expect(hits(page)).toHaveCount(1); await hits(page).click();
    await expect(page.locator('[data-recued-chat-route-history-draft-guard]')).toHaveCount(0);
    await expect(page.locator('[data-recued-chat-route-message="hit-telegram-chat"]')).toBeVisible();
    await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('');
    await filter(page, 'scope').selectOption('current');
    await expect(hits(page)).toHaveCount(1);
    expect(requests.at(-1)).toMatchObject({ session_id: 'telegram-chat' });
    const searchesBeforeDraft = requests.length;
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('Open a chat first, then you can search inside it');
    await expect(hits(page)).toHaveCount(0); expect(requests.length).toBe(searchesBeforeDraft);
    // The draft is still with the chat it was written in.
    await filter(page, 'clear').click(); await search(page).fill(''); await row(page, 's').click();
    await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('Keep my draft');
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

test('a retained status reply cannot restore a recovery row after focus moves to search', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); let hold = false; let held = false;
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await seed(fixture);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON(); const result = await fixture.rpc(method, args);
      if (hold && method === 'chat.messenger.status' && args.session_ids?.length === 1 && args.session_ids[0] === 'slack-chat') {
        held = true; await pending;
      }
      await route.fulfill({ json: { result } });
    });
    await boot(page); await filter(page, 'vendor').selectOption('slack'); await filter(page, 'attention').check();
    await expect(row(page, 'slack-chat')).toBeHidden();
    fixture.receive('slack', 'retrying'); await expect(row(page, 'slack-chat')).toBeVisible();
    await page.locator('[data-recued-chat-route-session-actions="slack-chat"] summary').click();
    await page.locator('[data-chat-messenger-connection="slack-chat"]').focus();
    hold = true; fixture.receive('slack', 'active'); await expect.poll(() => held).toBe(true);
    await search(page).focus(); release();
    await expect(row(page, 'slack-chat')).toBeHidden(); await expect(search(page)).toBeFocused();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

test('an obsolete filtered refresh cannot stall outage discovery in the new filter', async ({ page }) => {
  const fixture = createFixture({ emit: () => {} }); let hold = false; let held = false; let firstFilterReady = false; let newFilterReady = false;
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await seed(fixture);
    await page.clock.install();
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON(); const result = await fixture.rpc(method, args);
      if (hold && method === 'chat.sessions.list' && args.filters?.vendor === 'telegram') { held = true; await pending; }
      await route.fulfill({ json: { result } });
      if (method === 'chat.sessions.list' && args.filters?.vendor === 'telegram') firstFilterReady = true;
      if (method === 'chat.sessions.list' && args.filters?.vendor === 'discord' && args.filters.needs_attention
        && (result as { sessions: unknown[] }).sessions.length === 0) newFilterReady = true;
    });
    await boot(page); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await filter(page, 'vendor').selectOption('telegram');
    await expect.poll(async () => { await page.clock.runFor(200); return firstFilterReady; }).toBe(true);
    await expect(page.locator('.chat-history-filter-note')).not.toContainText('Loading matching chats');
    await expect(row(page, 'telegram-chat')).toBeVisible();
    hold = true; await page.clock.fastForward(5_200); await expect.poll(() => held).toBe(true);
    await filter(page, 'vendor').selectOption('discord'); await filter(page, 'attention').check();
    await expect.poll(async () => { await page.clock.runFor(200); return newFilterReady; }).toBe(true);
    await expect(page.locator('.chat-history-filter-note')).not.toContainText('Loading matching chats');
    await expect(row(page, 'discord-chat')).toBeHidden();
    fixture.receive('discord', 'retrying'); await page.clock.fastForward(5_200);
    await expect(row(page, 'discord-chat')).toBeVisible();
    await expect(row(page, 'discord-chat')).toContainText('Reconnecting');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
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
    await page.goto('/chat-queue-harness.html'); await openChatHistoryFilters(page); await expect(filter(page, 'vendor')).toBeVisible();
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
      if ((method === 'chat.sessions.list' || method === 'chat.messenger.status') && unavailable) result = { ...result as MessengerSessionListReply, messenger_status_available: false };
      await route.fulfill({ json: { result } });
    });
    await boot(page); await filter(page, 'vendor').selectOption('telegram'); await search(page).fill('needle');
    await expect(hits(page)).toHaveCount(1);
    await expect(page.locator('.chat-history-filter-note')).toContainText('Recued will forget them');
    const filterSummary = page.locator('.chat-history-filter-panel summary');
    await filterSummary.click(); await expect(filterSummary).toContainText('Not saved');
    await filterSummary.click();
    failSave = false; await filter(page, 'retry').click(); await expect(filter(page, 'retry')).toBeHidden();
    await expect(filterSummary).not.toContainText('Not saved');
    unavailable = true;
    await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('Recued cannot tell whether Chat is connected');
    await expect(hits(page)).toHaveCount(0);
    unavailable = false; await expect(hits(page)).toHaveCount(1);
    await expect(filter(page, 'vendor')).toHaveValue('telegram');
  } finally { await page.unrouteAll({ behavior: 'wait' }); fixture.close(); }
});

type SaveOutcome = 'success' | 'error' | 'mismatch';
const withHeldPreferences = async (page: Page, run: (state: {
  writes: Array<Partial<InstancePrefs>>;
  release(index: number, outcome?: SaveOutcome): Promise<void>;
}) => Promise<void>): Promise<void> => {
  const fixture = createFixture({ emit: () => {} });
  const writes: Array<Partial<InstancePrefs>> = [];
  const pending: Array<{ release(outcome: SaveOutcome): void; done: Promise<void> }> = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let closing = false;
  try {
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      if (method !== 'prefs.set') {
        await route.fulfill({ json: { result: await fixture.rpc(method, args) } }); return;
      }
      writes.push(args.patch);
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const wait = new Promise<SaveOutcome>(release => { pending.push({ release, done }); if (closing) release('error'); });
      try {
        const outcome = await wait;
        if (outcome === 'error') await route.fulfill({ json: { error: 'fixture preference save failed' } });
        else await route.fulfill({ json: { result: await fixture.rpc(outcome === 'mismatch' ? 'prefs.get' : method, args) } });
      } finally { finish(); }
    });
    await page.goto('/chat-queue-harness.html');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await openChatHistory(page);
    const panel = page.locator('.chat-history-filter-panel');
    if (!await panel.evaluate(element => (element as HTMLDetailsElement).open)) await panel.locator('summary').click();
    await run({ writes, release: async (index, outcome = 'success') => {
      await expect.poll(() => pending.length).toBeGreaterThan(index);
      pending[index]!.release(outcome); await pending[index]!.done;
    } });
    expect(errors).toEqual([]);
  } finally {
    closing = true; for (const request of pending) request.release('error');
    await page.unrouteAll({ behavior: 'wait' }); fixture.close();
  }
};
const saveNotice = (page: Page) => page.locator('.chat-history-filter-note');
const retrySave = async (page: Page) => { await filter(page, 'retry').focus(); await page.keyboard.press('Enter'); };

for (const width of [390, 1280]) {
  test(`keyboard retry announces saving and saved and returns to the edited filter at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await withHeldPreferences(page, async ({ writes, release }) => {
      await expect(saveNotice(page)).toBeHidden(); await filter(page, 'vendor').selectOption('telegram');
      await expect(saveNotice(page)).toHaveText('Saving chat filters…');
      await expect(filter(page, 'vendor')).toBeEnabled(); await expect(filter(page, 'retry')).toBeHidden();
      await release(0, 'error'); await expect(saveNotice(page)).toContainText('Recued will forget them');
      await retrySave(page); await expect(saveNotice(page)).toHaveText('Saving chat filters…');
      await expect(filter(page, 'retry')).toBeFocused(); await expect(filter(page, 'retry')).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Enter'); await page.keyboard.press('Space'); expect(writes).toHaveLength(2);
      await release(1); await expect(saveNotice(page)).toHaveText('Chat filters saved.');
      await expect(saveNotice(page)).toHaveAttribute('role', 'status'); await expect(filter(page, 'retry')).toBeHidden();
      await expect(filter(page, 'vendor')).toBeFocused(); await expect(filter(page, 'vendor')).toHaveValue('telegram');
      expect(writes[1]).toEqual(writes[0]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });

  test(`a retry failure keeps keyboard recovery available at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await withHeldPreferences(page, async ({ writes, release }) => {
      await filter(page, 'vendor').selectOption('telegram'); await release(0, 'error');
      await expect(filter(page, 'retry')).toBeVisible(); await retrySave(page); await release(1, 'error');
      await expect(saveNotice(page)).toContainText('Recued will forget them'); await expect(filter(page, 'retry')).toBeFocused();
      await expect(filter(page, 'retry')).toHaveAttribute('aria-disabled', 'false');
      await page.keyboard.press('Enter'); await release(2); await expect(saveNotice(page)).toHaveText('Chat filters saved.');
      await expect(filter(page, 'vendor')).toBeFocused(); expect(writes).toHaveLength(3);
    });
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`retry ${outcome} respects focus moved to search at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await withHeldPreferences(page, async ({ release }) => {
        await filter(page, 'vendor').selectOption('telegram'); await release(0, 'error');
        await expect(filter(page, 'retry')).toBeVisible(); await retrySave(page); await search(page).focus();
        await release(1, outcome);
        await expect(saveNotice(page)).toHaveText(outcome === 'success' ? 'Chat filters saved.' : 'These work now, but Recued will forget them.');
        await expect(search(page)).toBeFocused(); await expect(filter(page, 'vendor')).toHaveValue('telegram');
      });
    });
  }

  test(`recovery returns to each filter and rejects an unconfirmed save at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await withHeldPreferences(page, async ({ writes, release }) => {
      const edits = [
        ['source', () => filter(page, 'source').selectOption('webclient')],
        ['vendor', () => filter(page, 'vendor').selectOption('telegram')],
        ['attention', () => filter(page, 'attention').check()],
        ['scope', () => filter(page, 'scope').selectOption('current')],
        ['clear', () => filter(page, 'clear').click()],
      ] as const;
      for (const [index, [id, edit]] of edits.entries()) {
        await edit(); await release(index * 2, 'mismatch'); await expect(saveNotice(page)).toContainText('Recued will forget them');
        await retrySave(page); await release(index * 2 + 1); await expect(saveNotice(page)).toHaveText('Chat filters saved.');
        await expect(filter(page, id)).toBeFocused(); await expect(filter(page, 'retry')).toBeHidden();
        expect(writes[index * 2 + 1]).toEqual(writes[index * 2]);
      }
    });
  });

  for (const olderOutcome of ['success', 'error'] as const) {
    test(`an older retry ${olderOutcome} waits for newer filter edits before reporting saved at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await withHeldPreferences(page, async ({ writes, release }) => {
        await filter(page, 'vendor').selectOption('telegram'); await release(0, 'error');
        await expect(filter(page, 'retry')).toBeVisible(); await retrySave(page);
        await filter(page, 'vendor').selectOption('discord'); await filter(page, 'scope').selectOption('current');
        expect(writes).toHaveLength(2); await release(1, olderOutcome);
        await expect.poll(() => writes.length).toBe(3); await expect(saveNotice(page)).toHaveText('Saving chat filters…');
        expect(writes[2]).toMatchObject({ 'ui.chat.history.vendor': 'discord', 'ui.chat.history.scope': 'current' });
        await release(2); await expect(saveNotice(page)).toHaveText('Chat filters saved.');
        await expect(filter(page, 'vendor')).toHaveValue('discord'); await expect(filter(page, 'scope')).toHaveValue('current');
        await expect(filter(page, 'scope')).toBeFocused(); await expect(filter(page, 'retry')).toBeHidden();
      });
    });
  }
}

test('disposing Chat stops queued filter writes and late feedback', async ({ page }) => {
  await withHeldPreferences(page, async ({ writes, release }) => {
    await filter(page, 'vendor').selectOption('telegram');
    await expect.poll(() => writes.length).toBe(1); await filter(page, 'vendor').selectOption('discord');
    await page.evaluate(() => (window as unknown as { queueTestRePair(): Promise<void> }).queueTestRePair());
    await expect(filter(page, 'vendor')).toHaveValue('all'); await expect(saveNotice(page)).toBeHidden();
    await release(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(writes).toHaveLength(1); await expect(saveNotice(page)).toBeHidden();
  });
});

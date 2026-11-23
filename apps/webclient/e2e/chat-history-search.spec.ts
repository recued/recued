import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { expect, test, type Page } from '@playwright/test';
import type { ChatMessageSearchMatch, ChatMessageSearchRequest } from '@recued/contracts';
import { SHELL_CONTENT } from './helpers/full-app.js';
import { openChatHistory } from './helpers/chat-history.js';

const URL = `${HARNESS_ORIGIN}/full-app-harness.html?chat_search=1`;
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search chats and messages' });
const result = (page: Page, id: string) => page.locator(`[data-recued-chat-history-message="${id}"]`);
const message = (page: Page, id: string) => page.locator(`[data-recued-chat-route-message="${id}"]`);
const input = (page: Page) => page.locator('[data-recued-chat-route-input]');
const more = (page: Page) => page.locator('[data-recued-chat-history-message-more]');
const ready = async (page: Page) => { await page.waitForFunction(() => window.__app?.ready === true); };
const requests = (page: Page): Promise<Array<{ method: string; args?: Record<string, unknown> }>> =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-chat-search-requests') ?? '[]'));

declare global {
  interface Window {
    __globalChatSearch: { rows: ChatMessageSearchMatch[]; calls: ChatMessageSearchRequest[]; pageSize: number;
      holdNext: boolean; waiting: boolean; release(): void; failNext: boolean; emptyFirst: boolean; incomplete: boolean };
  }
}
const globalSearch = (page: Page) => page.getByRole('searchbox', { name: 'Search everything' });
const chatGroup = (page: Page) => page.getByRole('region', { name: 'Chat message search results' });
const globalResult = (page: Page, id: string) => page.locator(`[data-search-chat-message="${id}"]`);
const bootGlobal = async (page: Page, populated = false, saved = false) => {
  await page.addInitScript(({ populated, saved }) => {
    const state: Window['__globalChatSearch'] = {
      rows: populated ? Array.from({ length: 18 }, (_, index) => {
        const n = 47 - index;
        return { session_id: 'a', message_id: `a-m${String(n).padStart(3, '0')}`, ts: 1000 + n,
          role: n % 2 ? 'assistant' : 'user', title: 'Weekly planning', snippet: `Ordinary a message ${n}` };
      }) : [
        { session_id: 'b', message_id: 'b-m001', ts: 2001, role: 'assistant', title: 'Travel notes', snippet: 'The Kyoto needle is packed.' },
        { session_id: 'a', message_id: 'a-m021', ts: 1021, role: 'assistant', title: 'Weekly planning', snippet: 'The needle is safely stored.' },
        { session_id: 'a', message_id: 'a-m020', ts: 1020, role: 'user', title: 'Weekly planning', snippet: 'Remember the secret needle <img src=x onerror=alert(1)> in this old message.' },
      ], calls: [], pageSize: populated ? 6 : 2, holdNext: false, waiting: false, release() {}, failNext: false, emptyFirst: false, incomplete: false,
    };
    window.__globalChatSearch = state;
    window.__connectionsFixture = async (method, raw) => {
      if (method === 'chat.messages.search') {
        const request = raw as ChatMessageSearchRequest; state.calls.push(structuredClone(request));
        if (state.failNext) { state.failNext = false; return { error: { code: 'fixture_offline', message: 'Chat search unavailable. Try again.' } }; }
        const hits = state.rows.filter(row => row.snippet.toLowerCase().includes(request.query.toLowerCase()))
          .filter(row => !request.before || row.ts < request.before.ts);
        const matches = hits.slice(0, state.pageSize), last = matches.at(-1);
        const result = state.emptyFirst && !request.before
          ? { matches: [], incomplete: state.incomplete, next_cursor: { ts: 3000, message_id: 'scanned-row' } }
          : { matches, incomplete: state.incomplete, ...(hits.length > matches.length && last ? { next_cursor: { ts: last.ts, message_id: last.message_id } } : {}) };
        state.emptyFirst = false;
        if (state.holdNext) {
          state.holdNext = false; state.waiting = true;
          await new Promise<void>(done => { state.release = () => { state.waiting = false; done(); }; });
        }
        return { result };
      }
      if (method === 'collection.searchAll' || method === 'work.search') return { result: { groups: [] } };
      if (method === 'contact.search.local') return { result: { contacts: [], total: 0 } };
      if (method === 'yours.read') return { result: { assets: [], classes: [], total_assets: 0 } };
      if (method === 'recipe.list') return { result: { recipes: [] } };
      if (method === 'packs.list') return { result: { packs: [] } };
      if (saved && (method === 'data_views.get' || method === 'data_views.list')) {
        const view = { id: 'research', name: 'Research search', definition: { tab: 'search', query: 'Ordinary' }, revision: 1, created_at: 1, updated_at: 1 };
        return { result: method === 'data_views.get' ? { view } : { views: [view] } };
      }
      return undefined;
    };
  }, { populated, saved });
  await page.goto(`${URL}${saved ? '#views/research' : '#data/search'}`); await ready(page);
};

test('universal search opens an older exact chat message and returns to its result without sending', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await bootGlobal(page); await globalSearch(page).fill('needle');
  await expect(chatGroup(page).locator('[data-search-chat-message]')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('chat');
  await expect(globalResult(page, 'b-m001')).toContainText('Travel notes');
  await chatGroup(page).getByRole('button', { name: 'More chat messages', exact: true }).focus();
  await page.keyboard.press('Enter');
  const old = globalResult(page, 'a-m020'); await expect(old).toBeFocused();
  await expect(old).toContainText('secret needle <img'); await expect(old.locator('img')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#chat\/session\/a\/answer\/a-m020$/);
  await expect(message(page, 'a-m020')).toBeFocused();
  expect((await requests(page)).filter(call => call.method === 'chat.session.get').at(-1)?.args).toMatchObject({ around_message_id: 'a-m020' });
  await input(page).fill('Keep this unfinished question.');
  const prompts: string[] = [];
  page.once('dialog', prompt => { prompts.push(prompt.message()); void prompt.dismiss(); });
  await page.getByRole('link', { name: 'Back to search', exact: true }).click();
  await expect.poll(() => prompts.length).toBe(1); await expect(input(page)).toHaveValue('Keep this unfinished question.');
  await input(page).fill('');
  await page.getByRole('link', { name: 'Back to search', exact: true }).click();
  await expect(globalSearch(page)).toHaveValue('needle'); await expect(old).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Result type', exact: true })).toHaveValue('chat');
  await expect(chatGroup(page).locator('[data-search-chat-message]')).toHaveCount(3);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
  expect(errors).toEqual([]);
});

test('universal chat search retains saved-view pages, scroll and focus through Back and Forward', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await bootGlobal(page, true, true);
  await expect(chatGroup(page).locator('[data-search-chat-message]')).toHaveCount(6);
  const more = chatGroup(page).getByRole('button', { name: 'More chat messages', exact: true });
  await more.click(); await expect(chatGroup(page).locator('[data-search-chat-message]')).toHaveCount(12);
  await more.focus(); await page.keyboard.press('Enter');
  await expect(chatGroup(page).locator('[data-search-chat-message]')).toHaveCount(18);
  const target = globalResult(page, 'a-m030'); await target.scrollIntoViewIfNeeded(); await target.focus();
  await page.screenshot({ path: testInfo.outputPath('chat-global-search-phone.png'), fullPage: true });
  const content = page.locator(`[${SHELL_CONTENT}]`);
  const scroll = await content.evaluate(node => node.scrollTop);
  await page.keyboard.press('Enter'); await expect(message(page, 'a-m030')).toBeFocused();
  await page.getByRole('link', { name: 'Back to search', exact: true }).click();
  await expect(page).toHaveURL(/#views\/research$/); await expect(globalSearch(page)).toHaveValue('Ordinary');
  await expect(chatGroup(page)).toHaveAttribute('aria-busy', 'false');
  await expect(chatGroup(page).locator('[data-search-chat-message]')).toHaveCount(18); await expect(target).toBeFocused();
  await expect.poll(() => content.evaluate(node => node.scrollTop)).toBe(scroll);
  await page.goBack(); await expect(message(page, 'a-m030')).toBeFocused();
  await page.goBack(); await expect(target).toBeFocused();
  await page.goForward(); await expect(page.getByRole('link', { name: 'Back to search', exact: true })).toBeVisible();
  await openChatHistory(page);
  await page.locator('[data-recued-chat-route-session-row="b"]').click();
  await expect(message(page, 'b-m001')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to search', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#data/task'));
  await page.evaluate(() => window.__app.setHash('#chat/session/a/answer/a-m030'));
  await expect(message(page, 'a-m030')).toBeFocused();
  await expect(page.getByRole('link', { name: 'Back to search', exact: true })).toHaveCount(0);
});

test('universal chat scans distinguish older unsearched rows, retry the same failed page and retire stale queries', async ({ page }) => {
  await bootGlobal(page);
  await page.evaluate(() => { window.__globalChatSearch.emptyFirst = true; window.__globalChatSearch.incomplete = true; });
  await globalSearch(page).fill('needle');
  await expect(chatGroup(page)).toContainText('Older messages remain to search');
  await expect(chatGroup(page)).toContainText('Results may be incomplete');
  await expect(page.getByText(/No matches in the searched sources/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Look for/ })).toHaveCount(0);
  await page.evaluate(() => { window.__globalChatSearch.failNext = true; });
  await chatGroup(page).getByRole('button', { name: 'More chat messages', exact: true }).click();
  await expect(chatGroup(page).getByRole('alert')).toContainText('Chat search unavailable');
  await chatGroup(page).getByRole('button', { name: 'Retry chat messages', exact: true }).click();
  await expect(globalResult(page, 'b-m001')).toBeFocused();
  const calls = await page.evaluate(() => window.__globalChatSearch.calls);
  expect(calls[2]).toEqual(calls[1]);
  await page.evaluate(() => { window.__globalChatSearch.holdNext = true; });
  await globalSearch(page).fill('secret needle'); await page.waitForFunction(() => window.__globalChatSearch.waiting);
  await globalSearch(page).fill('Kyoto'); await expect(globalResult(page, 'b-m001')).toBeVisible();
  await page.evaluate(() => window.__globalChatSearch.release());
  await expect(globalResult(page, 'a-m020')).toHaveCount(0); await expect(globalSearch(page)).toBeFocused();
  await expect(globalSearch(page)).toHaveValue('Kyoto');
  const hash = await page.evaluate(() => {
    const old = document.querySelector<HTMLAnchorElement>('[data-search-chat-message="b-m001"]')!;
    const box = document.querySelector<HTMLInputElement>('[data-recued-universal-search-input]')!;
    box.value = 'unmatched'; box.dispatchEvent(new Event('input', { bubbles: true })); old.click(); return location.hash;
  });
  expect(hash).toBe('#data/search');
});

test('a deleted universal-search message has an explicit notice and a usable return to the refreshed search', async ({ page }) => {
  await bootGlobal(page); await globalSearch(page).fill('secret needle');
  const target = globalResult(page, 'a-m020'); await expect(target).toBeVisible();
  await page.evaluate(() => {
    sessionStorage.setItem('recued-test-chat-missing-target', 'a-m020');
    window.__globalChatSearch.rows = window.__globalChatSearch.rows.filter(row => row.message_id !== 'a-m020');
  });
  await target.click();
  await expect(page.locator('[data-recued-chat-route-return-missing]')).toBeVisible();
  await page.getByRole('link', { name: 'Back to search', exact: true }).click();
  await expect(globalSearch(page)).toHaveValue('secret needle');
  await expect(target).toHaveCount(0); await expect(globalSearch(page)).toBeFocused();
});

test('a failed universal-search message read keeps a usable Back to search and can be opened again', async ({ page }) => {
  await bootGlobal(page); await globalSearch(page).fill('secret needle');
  const target = globalResult(page, 'a-m020'); await expect(target).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('recued-test-chat-fail-target', 'a-m020'));
  await target.click();
  await expect(page.locator('[data-recued-chat-route-error]')).toContainText('Could not load this message');
  await page.getByRole('link', { name: 'Back to search', exact: true }).click();
  await expect(globalSearch(page)).toHaveValue('secret needle'); await expect(target).toBeFocused();
  await page.evaluate(() => sessionStorage.removeItem('recued-test-chat-fail-target'));
  await target.press('Enter'); await expect(message(page, 'a-m020')).toBeFocused();
});

test('History searches messages across chats, shows safe snippets, and jumps to an older exact user message', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${URL}#chat`);
  await ready(page);
  await search(page).fill('needle');
  await expect(result(page, 'b-m001')).toContainText('Travel notes');
  await expect(result(page, 'a-m021')).toContainText('The needle is safely stored.');
  await expect(search(page)).toBeFocused();
  await expect(page.locator('[data-recued-chat-route-session-row]')).toHaveCount(0);
  await more(page).focus();
  await page.keyboard.press('Enter');
  await expect(result(page, 'a-m020')).toContainText('secret needle <img src=x onerror=alert(1)>');
  await expect(result(page, 'a-m020').locator('img')).toHaveCount(0);
  await expect(more(page)).toHaveCount(0);
  await expect(result(page, 'a-m020')).toBeFocused();
  await result(page, 'a-m020').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#chat\/session\/a\/answer\/a-m020$/);
  await expect(message(page, 'a-m020')).toBeFocused();
  await expect(message(page, 'a-m020')).toHaveAttribute('data-recued-chat-route-return-target', '');
  await expect(page.locator('[data-recued-chat-route-return-missing]')).toHaveCount(0);
  expect((await requests(page)).filter(request => request.method === 'chat.session.get').at(-1)?.args)
    .toMatchObject({ session_id: 'a', around_message_id: 'a-m020', limit: 100 });
  await page.getByRole('button', { name: 'Load later messages', exact: true }).click();
  await expect(message(page, 'a-m199')).toBeAttached();
  await page.getByRole('button', { name: 'Load later messages', exact: true }).click();
  await expect(message(page, 'a-m249')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Load later messages', exact: true })).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(message(page, 'a-m020')).toBeFocused();
  expect(errors).toEqual([]);
});

test('message navigation carries the exact target and keeps the unsent draft', async ({ page }) => {
  await page.goto(`${URL}#chat/new`);
  await ready(page);
  await input(page).fill('Keep this unsent draft');
  await search(page).fill('secret needle');
  // Since 04844efda a typed draft stays with the chat it was written in, so opening a message asks nothing.
  await result(page, 'a-m020').click();
  await expect(page.locator('[data-recued-chat-route-history-draft-guard]')).toHaveCount(0);
  await expect(message(page, 'a-m020')).toBeFocused();
  await expect(input(page)).toHaveValue('');
  const newChat = page.getByRole('button', { name: 'New chat', exact: true });
  await expect(newChat).toContainText('Draft');
  await newChat.click();
  await expect(input(page)).toHaveValue('Keep this unsent draft');
});

test('searching within the open chat preserves the draft while loading an earlier target', async ({ page }) => {
  await page.goto(`${URL}#chat/session/a`);
  await ready(page);
  await expect(message(page, 'a-m249')).toBeAttached();
  await expect(message(page, 'a-m020')).toHaveCount(0);
  await input(page).fill('Draft in the current conversation');
  await search(page).fill('secret needle');
  await result(page, 'a-m020').click();
  await expect(message(page, 'a-m020')).toBeFocused();
  await expect(input(page)).toHaveValue('Draft in the current conversation');
  await expect(page.getByRole('button', { name: 'Throw it away and open', exact: true })).toHaveCount(0);
});

test('stale searches cannot overwrite a newer query or repopulate a cleared query', async ({ page }) => {
  await page.goto(`${URL}&hold_rpc=chat.messages.search#chat`);
  await ready(page);
  await search(page).fill('needle');
  await expect.poll(async () => (await requests(page)).filter(request => request.method === 'chat.messages.search').length).toBe(1);
  await search(page).fill('Kyoto');
  await expect.poll(async () => (await requests(page)).filter(request => request.method === 'chat.messages.search').length).toBe(2);
  await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.messages.search'));
  await expect(result(page, 'b-m001')).toBeVisible();
  await expect(result(page, 'a-m021')).toHaveCount(0);
  await expect(search(page)).toHaveValue('Kyoto');
  await expect(search(page)).toBeFocused();
  await search(page).fill('secret needle');
  await expect.poll(async () => (await requests(page)).filter(request => request.method === 'chat.messages.search').length).toBe(3);
  await search(page).fill('');
  await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.messages.search'));
  await expect(page.locator('[data-recued-chat-history-messages]')).toBeHidden();
  await expect(page.locator('[data-recued-chat-route-session-row]')).toHaveCount(2);
});

test('an older server keeps title search usable and explains unavailable message search', async ({ page }) => {
  await page.goto(`${URL.replace('chat_search=1', 'chat_search=unsupported')}#chat`);
  await ready(page);
  await search(page).fill('Weekly');
  await expect(page.locator('[data-recued-chat-route-session-row="a"]')).toBeVisible();
  await expect(page.locator('[data-recued-chat-history-messages]')).toContainText('This server cannot search inside messages');
  await expect(more(page)).toHaveText('Retry message search');
  await more(page).focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await requests(page)).filter(request => request.method === 'chat.messages.search').length).toBe(2);
  await expect(more(page)).toHaveText('Retry message search');
  await expect(more(page)).toBeFocused();
});

test('a removed target opens the chat with an explicit missing-message notice', async ({ page }) => {
  await page.goto(`${URL}#chat`);
  await ready(page);
  await search(page).fill('secret needle');
  await expect(result(page, 'a-m020')).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('recued-test-chat-missing-target', 'a-m020'));
  await result(page, 'a-m020').click();
  await expect(page.locator('[data-recued-chat-route-return-missing]')).toContainText('is gone');
  await expect(message(page, 'a-m249')).toBeAttached();
  await expect(message(page, 'a-m020')).toHaveCount(0);
});

test('a slow rejected message open keeps focus on the exact result for retry', async ({ page }) => {
  await page.goto(`${URL}&chat_session_open_response=fail-slow#chat`);
  await ready(page);
  await search(page).fill('secret needle');
  await result(page, 'a-m020').focus();
  await page.keyboard.press('Enter');
  await expect(result(page, 'a-m020')).toHaveAttribute('aria-busy', 'true');
  await expect(result(page, 'a-m020')).toBeFocused();
  await expect(page.locator('[data-recued-chat-route-error]')).toBeVisible();
  await expect(result(page, 'a-m020')).not.toHaveAttribute('aria-busy');
  await expect(result(page, 'a-m020')).toBeFocused();
});

test('choosing a loaded result supersedes an outstanding open of another chat', async ({ page }) => {
  await page.goto(`${URL}#chat/session/a/answer/a-m020`);
  await ready(page);
  await expect(message(page, 'a-m020')).toBeFocused();
  await page.evaluate(() => {
    const url = new window.URL(location.href);
    url.searchParams.set('hold_rpc', 'chat.session.get');
    history.replaceState(null, '', url);
  });
  await search(page).fill('needle');
  await result(page, 'b-m001').click();
  await result(page, 'a-m021').click();
  await expect(message(page, 'a-m021')).toBeFocused();
  await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.session.get'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page).toHaveURL(/#chat\/session\/a\/answer\/a-m021$/);
  await expect(message(page, 'a-m021')).toBeFocused();
  await expect(message(page, 'b-m001')).toHaveCount(0);
});

test('a rejected jump within the open chat preserves its address and focuses the result for retry', async ({ page }) => {
  await page.goto(`${URL}#chat/session/a/answer/a-m249`);
  await ready(page);
  await expect(message(page, 'a-m249')).toBeAttached();
  await page.evaluate(() => sessionStorage.setItem('recued-test-chat-fail-target', 'a-m020'));
  await search(page).fill('secret needle');
  await result(page, 'a-m020').click();
  await expect(page.locator('[data-recued-chat-route-error]')).toContainText('Could not load this message');
  await expect(page).toHaveURL(/#chat\/session\/a\/answer\/a-m249$/);
  await expect(result(page, 'a-m020')).toBeFocused();
  await expect(result(page, 'a-m020')).not.toHaveAttribute('aria-busy');
  await expect(message(page, 'a-m249')).toBeAttached();
  await expect(message(page, 'a-m249')).toHaveAttribute('data-recued-chat-route-return-target', '');
  await expect(message(page, 'a-m020')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.removeItem('recued-test-chat-fail-target'));
  await page.keyboard.press('Enter');
  await expect(message(page, 'a-m020')).toBeFocused();
  await expect(page).toHaveURL(/#chat\/session\/a\/answer\/a-m020$/);
});

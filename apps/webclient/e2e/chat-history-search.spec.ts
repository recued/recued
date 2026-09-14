import { expect, test, type Page } from '@playwright/test';

const URL = 'http://127.0.0.1:4319/full-app-harness.html?chat_search=1';
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search chats and messages' });
const result = (page: Page, id: string) => page.locator(`[data-recued-chat-history-message="${id}"]`);
const message = (page: Page, id: string) => page.locator(`[data-recued-chat-route-message="${id}"]`);
const input = (page: Page) => page.locator('[data-recued-chat-route-input]');
const more = (page: Page) => page.locator('[data-recued-chat-history-message-more]');
const ready = async (page: Page) => { await page.waitForFunction(() => window.__app?.ready === true); };
const requests = (page: Page): Promise<Array<{ method: string; args?: Record<string, unknown> }>> =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-chat-search-requests') ?? '[]'));

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

test('message navigation carries the exact target through the unsent draft guard', async ({ page }) => {
  await page.goto(`${URL}#chat/new`);
  await ready(page);
  await input(page).fill('Keep this unsent draft');
  await search(page).fill('secret needle');
  await result(page, 'a-m020').click();
  await expect(page.getByRole('button', { name: 'Throw it away and open', exact: true })).toBeVisible();
  expect((await requests(page)).filter(request => request.method === 'chat.session.get')).toHaveLength(0);
  await page.getByRole('button', { name: 'Keep writing', exact: true }).click();
  await expect(input(page)).toHaveValue('Keep this unsent draft');
  await expect(input(page)).toBeFocused();
  await result(page, 'a-m020').click();
  await page.getByRole('button', { name: 'Throw it away and open', exact: true }).click();
  await expect(message(page, 'a-m020')).toBeFocused();
  await expect(input(page)).toHaveValue('');
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

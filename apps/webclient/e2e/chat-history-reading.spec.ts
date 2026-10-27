import { expect, test, type Page } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { openChatHistory } from './helpers/chat-history.js';

const url = () => `${HARNESS_ORIGIN}/full-app-harness.html?chat_search=1`;
const message = (page: Page, id: string) => page.locator(`[data-recued-chat-route-message="${id}"]`);
const input = (page: Page) => page.locator('[data-recued-chat-route-input]');
const latest = (page: Page) => page.getByRole('button', { name: 'Go to latest messages', exact: true });
const ready = (page: Page) => page.waitForFunction(() => window.__app?.ready === true);

test('an ordinary open reaches the latest reply, and returning restores the visible message and draft', async ({ page }) => {
  await page.goto(`${url()}#chat/session/a`); await ready(page);
  await expect(message(page, 'a-m249')).toBeInViewport(); await expect(latest(page)).toBeHidden();
  await input(page).fill('Keep this draft with the old conversation');
  await message(page, 'a-m190').scrollIntoViewIfNeeded(); await expect(message(page, 'a-m190')).toBeInViewport();
  await expect(latest(page)).toBeVisible();
  await openChatHistory(page); await page.locator('[data-recued-chat-route-session-row="b"]').click();
  await expect(message(page, 'b-m001')).toBeInViewport();
  await openChatHistory(page); await page.locator('[data-recued-chat-route-session-row="a"]').click();
  await expect(message(page, 'a-m190')).toBeInViewport();
  await expect(input(page)).toHaveValue('Keep this draft with the old conversation');
  const reads = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-chat-search-requests') ?? '[]') as Array<{ method: string; args?: Record<string, unknown> }>);
  expect(reads.filter(row => row.method === 'chat.session.get').at(-1)?.args?.around_message_id).toBeTruthy();
});

test('Latest uses bounded reads and keeps the older window and phone draft through keyboard retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url()}#chat/session/a/answer/a-m020`); await ready(page);
  await expect(message(page, 'a-m020')).toBeFocused(); await expect(latest(page)).toBeVisible();
  await input(page).fill('Continue from this draft');
  await page.evaluate(() => Object.assign(window, { __connectionsFixture: async (method: string) => method === 'chat.session.get'
    ? { error: { code: 'UNAVAILABLE', message: 'Latest messages are temporarily unavailable.' } } : undefined }));
  await latest(page).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-recued-chat-route-error]')).toContainText('Latest messages are temporarily unavailable.');
  await expect(latest(page)).toBeFocused(); await expect(message(page, 'a-m020')).toBeInViewport();
  await page.evaluate(() => Object.assign(window, { __connectionsFixture: undefined }));
  await page.keyboard.press('Enter');
  await expect(message(page, 'a-m249')).toBeInViewport(); await expect(latest(page)).toBeHidden();
  await expect(input(page)).toHaveValue('Continue from this draft'); await expect(page).toHaveURL(/#chat\/session\/a$/u);
  await expect(page.getByRole('heading', { name: 'Weekly planning', exact: true })).toBeFocused();
  const reads = await page.evaluate(() => (JSON.parse(sessionStorage.getItem('recued-test-chat-search-requests') ?? '[]') as Array<{ method: string; args?: Record<string, unknown> }>).filter(row => row.method === 'chat.session.get'));
  expect(reads).toHaveLength(3); expect(reads[2]?.args).toEqual({ session_id: 'a', limit: 100 });
});

test('phone search exposes message hits before many chat titles and explains collapsed active filters', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.assign(window, { __connectionsFixture: async (method: string) => {
      if (method === 'chat.sessions.list') return { result: { history_filters_available: true, messenger_status_available: true,
        sessions: Array.from({ length: 40 }, (_, i) => ({ id: `title-${i}`, title: `Needle planning ${i}`, created_at: 1, last_active_at: 2,
          message_count: 2, archived: false, picker_state: { current: 'self' }, model_routing: { current: 'byok' } })) } };
      if (method === 'chat.messages.search') return { result: { incomplete: false, matches: [{ session_id: 'title-0', message_id: 'match', role: 'assistant',
        ts: 2, title: 'Needle planning 0', snippet: 'The needle <img src=x onerror=alert(1)> remains literal.' }] } };
      return undefined;
    } });
  });
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html#chat/new`); await ready(page); await openChatHistory(page);
  const panel = page.locator('.chat-history-filter-panel'); const summary = panel.locator('summary');
  await expect(panel).not.toHaveAttribute('open'); await summary.click();
  await page.locator('[data-chat-history-filter="source"]').selectOption('webclient'); await summary.click();
  await expect(summary).toHaveText('Filters · Webclient');
  await page.getByRole('button', { name: 'Clear active filters', exact: true }).click(); await expect(summary).toHaveText('Filters');
  await summary.focus();
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'chat.session_changed', session_id: 'title-0', field: 'busy', value: true, cursor: 1,
  } }));
  await expect(summary).toBeFocused();
  await page.getByRole('searchbox', { name: 'Search chats and messages' }).fill('needle');
  const hit = page.locator('[data-recued-chat-history-message="match"]');
  await expect(hit).toBeInViewport(); await expect(hit.locator('mark')).toHaveText(['Needle', 'needle']);
  await expect(hit.locator('img')).toHaveCount(0); await expect(hit).toContainText('<img src=x onerror=alert(1)>');
});

test('completed success activity is quiet, problems remain visible and source details survive a repaint', async ({ page }) => {
  await page.addInitScript(() => {
    const session = { id: 'reading', title: 'Reading history', created_at: 1, last_active_at: 2, archived: false,
      picker_state: { current: 'self' }, model_routing: { current: 'byok' } };
    const base = { session_id: session.id, target_server: 'self', picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: '1', instance_id: 'fixture' } },
      model_used: { provider: 'local', model_id: 'fixture' }, contributor: 'model', ts: 2, role: 'assistant' };
    Object.assign(window, { __connectionsFixture: async (method: string) => {
      if (method === 'chat.sessions.list') return { result: { sessions: [{ ...session, message_count: 2 }] } };
      if (method === 'chat.session.get') return { result: { ...session, quoted_replies_available: true, messages: [
        { ...base, id: 'success', content: 'The passport record has been read.', tool_calls: [{ tool_name: 'work.read', tier: 1, args: {}, status: 'ok', started_at: 1 }],
          source_citations: [{ id: 'src_aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'asset', asset_id: 'passport', label: 'Passport', read_at: 2, read_version: 'a'.repeat(64) }] },
        { ...base, id: 'problem', content: 'The second check could not finish.', tool_calls: [{ tool_name: 'document.read', tier: 1, args: {}, status: 'error', reason: 'execution_error', detail: 'The file is unavailable.', started_at: 1 }] },
      ] } };
      return undefined;
    } });
  });
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html#chat/session/reading`); await ready(page);
  const success = message(page, 'success'); const activity = success.locator('[data-recued-chat-route-activity-toggle]');
  await expect(activity).toHaveAttribute('aria-expanded', 'false');
  await expect(success.getByRole('link', { name: 'Passport', exact: true })).toHaveAttribute('href', '#yours/asset/passport');
  const details = success.locator('.chat-source-details'); await details.locator('summary').click(); await expect(details).toHaveAttribute('open');
  await activity.click(); await expect(activity).toHaveAttribute('aria-expanded', 'true'); await expect(details).toHaveAttribute('open');
  await details.locator('summary').focus();
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'chat.session_changed', session_id: 'reading', field: 'busy', value: true, cursor: 1,
  } }));
  await expect(details.locator('summary')).toBeFocused(); await expect(details).toHaveAttribute('open');
  const source = success.getByRole('link', { name: 'Passport', exact: true }); await source.focus();
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'chat.session_changed', session_id: 'reading', field: 'busy', value: false, cursor: 2,
  } }));
  await expect(source).toBeFocused();
  await expect(message(page, 'problem').locator('[data-recued-chat-route-activity-toggle]')).toHaveAttribute('aria-expanded', 'true');
  await expect(message(page, 'problem')).toContainText('The file is unavailable.');
});

const installSeenFixture = async (page: Page) => page.addInitScript(() => {
  const session = { id: 'seen', title: 'Seen replies', created_at: 1, last_active_at: 2, archived: false,
    picker_state: { current: 'self' }, model_routing: { current: 'byok' } };
  const initial = { id: 'initial', session_id: 'seen', role: 'assistant', contributor: 'model', content: 'Earlier answer.',
    target_server: 'self', ts: 1, picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: '1', instance_id: 'fixture' } },
    model_used: { provider: 'local', model_id: 'fixture' } };
  const audit = { total: 1, seen: 0, marks: 0 };
  Object.assign(window, { __chatReadingSeen: audit, __connectionsFixture: async (method: string, args: { around_message_id?: string }) => {
    if (method === 'chat.sessions.list') return { result: { sessions: [{ ...session, message_count: audit.total, last_seen_message_count: audit.seen }] } };
    if (method === 'chat.session.get') { if (!args.around_message_id) audit.seen = audit.total; return { result: { ...session, messages: [initial] } }; }
    if (method === 'chat.send') { audit.total++; return { result: { turn_id: 'seen-turn' } }; }
    if (method === 'chat.session.mark_seen') {
      audit.marks++;
      if (sessionStorage.getItem('reading-fail-mark')) return { error: { code: 'UNAVAILABLE', message: 'Seen acknowledgement unavailable.' } };
      audit.seen = audit.total; return { result: { ok: true } };
    }
    return undefined;
  } });
});
const finishSeenReply = async (page: Page) => page.evaluate(() => {
  const audit = (window as unknown as { __chatReadingSeen: { total: number } }).__chatReadingSeen;
  audit.total++;
  window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'chat.message_complete', session_id: 'seen', turn_id: 'seen-turn', cursor: 1,
    final: { id: 'seen-final', session_id: 'seen', role: 'assistant', contributor: 'model', content: 'The new answer.',
      target_server: 'self', ts: 3, picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: '1', instance_id: 'fixture' } },
      model_used: { provider: 'local', model_id: 'fixture' } },
  } });
});
const seenCounts = (page: Page) => page.evaluate(() =>
  (window as unknown as { __chatReadingSeen: { total: number; seen: number; marks: number } }).__chatReadingSeen);

test('a reply watched at the tail is acknowledged after the completed message replaces the old tail', async ({ page }) => {
  await installSeenFixture(page); await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html#chat/session/seen`); await ready(page);
  await expect(message(page, 'initial')).toBeInViewport();
  await input(page).fill('Please continue'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(input(page)).toHaveValue(''); await finishSeenReply(page); await expect(message(page, 'seen-final')).toBeInViewport();
  await expect.poll(() => seenCounts(page)).toEqual({ total: 3, seen: 3, marks: 1 });
});

test('a hidden-tab reply remains unread until the visible tail is shown, then repeated visibility does not rewrite it', async ({ page }) => {
  await installSeenFixture(page); await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html#chat/session/seen`); await ready(page);
  await expect(message(page, 'initial')).toBeInViewport();
  await input(page).fill('Please continue'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(input(page)).toHaveValue('');
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }));
  await finishSeenReply(page); await expect(message(page, 'seen-final')).toHaveText(/The new answer/u);
  expect(await seenCounts(page)).toEqual({ total: 3, seen: 1, marks: 0 });
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => seenCounts(page)).toEqual({ total: 3, seen: 3, marks: 1 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await seenCounts(page)).toEqual({ total: 3, seen: 3, marks: 1 });
});

test('a failed seen acknowledgement remains eligible when the owner shows the tail again', async ({ page }) => {
  await installSeenFixture(page); await page.addInitScript(() => sessionStorage.setItem('reading-fail-mark', '1'));
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html#chat/session/seen/answer/initial`); await ready(page);
  await expect(message(page, 'initial')).toBeInViewport();
  await expect.poll(async () => (await seenCounts(page)).marks).toBeGreaterThan(0);
  expect((await seenCounts(page)).seen).toBe(0);
  await page.evaluate(() => { sessionStorage.removeItem('reading-fail-mark'); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(async () => (await seenCounts(page)).seen).toBe(1);
  const confirmed = await seenCounts(page);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await seenCounts(page)).toEqual(confirmed);
});

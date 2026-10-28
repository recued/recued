import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

declare global { interface Window {
  __answerReading: { event(event: Record<string, unknown>): void; refresh(): Promise<void>; dispose(): void };
  __answerClipboard: { texts: string[]; mode: 'success' | 'pending' | 'denied'; release(ok?: boolean): void };
} }

let bundle: string;
let tokens: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { bootstrapChatRoute } from './apps/webclient/src/chat/bootstrap-chat-route.ts';
    const handlers = new Map();
    const route = bootstrapChatRoute({root: document.getElementById('app'), initialSessionId: 'a',
      conn: async (method, args) => {
        const reply = await fetch('/answer-rpc', {method:'POST', body: JSON.stringify({method,args})});
        const body = await reply.json(); if(body.error) throw new Error(body.error); return body.result;
      }, subscribe: (kind, handler) => {
        const set = handlers.get(kind) ?? new Set(); set.add(handler); handlers.set(kind,set); return () => set.delete(handler);
      }});
    window.__answerReading = {refresh: () => route.refresh(), dispose: () => route.dispose(),
      event: event => {for(const handler of handlers.get(event.kind) ?? []) handler(event);}};
    await route.whenLoaded(); document.body.dataset.ready = 'true';
  ` }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: 'apps/webclient/tsconfig.json', logLevel: 'silent' });
  bundle = result.outputFiles[0]!.text;
  tokens = await readFile('packages/ui-shared/src/theme/tokens.css', 'utf8');
});

const record = '#data/mail/record/work/example';
const sourceId = `src_${'a'.repeat(24)}`;
const rawCode = `[Example record](${record})\r\n**literal** <img src=x onerror=alert(1)>\r\nconst greeting = "你好 👋";  \r\n${'long_value_'.repeat(35)}\r\n`;
const message = (id: string, content: string, ts: number, session = 'a') => ({ id, session_id: session,
  role: 'assistant', contributor: 'model', content, ts, target_server: 'self',
  picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'fixture', instance_id: 'answers' } },
  model_used: { provider: 'local', model_id: 'fixture' } });
const input = (page: Page) => page.locator('[data-recued-chat-route-input]');
const codeBox = (page: Page) => page.locator('[data-chat-answer-code-block]');
const publish = (page: Page, event: Record<string, unknown>) => page.evaluate(event => window.__answerReading.event(event), event);

const setup = async (page: Page, older = 0, sharedTurn = false) => {
  const session = (id: string) => ({ id, title: id === 'a' ? 'Reading answers' : 'Another conversation', archived: false,
    created_at: 1, last_active_at: 3, picker_state: { current: 'self' },
    model_routing: { current: 'byok', provider: 'local', model_id: 'fixture', overridden: false } });
  let finalMessage: (ReturnType<typeof message> & { turn_id?: string }) | undefined;
  const example = message('code', `Example to copy:\n\n\`\`\`md\r\n${rawCode}\`\`\``, older + 2);
  const codeMessages = sharedTurn
    ? [{ ...example, turn_id: 'shared' }, { ...message('second-code', 'Example to copy:\n\n```md\r\nDifferent code.\r\n```', older + 3), turn_id: 'shared' }]
    : [example];
  const messages = () => [
    ...Array.from({ length: older }, (_, i) => message(`old-${i}`, `Retained answer ${i}. ${'Earlier useful details. '.repeat(6)}`, i + 1)),
    { ...message('prose', `## Plan\n\n**Check** the \`item_count\`.\n\n4. First\n6. Second\n\n- Parent\n  - Child\n\n[Saved hose](#source/${sourceId})\n[Unknown](#source/src_${'e'.repeat(24)})`, older + 1),
      source_citations: [{ kind: 'asset', id: sourceId, asset_id: 'asset:reading', label: 'Saved hose', read_at: 1000, read_version: 'b'.repeat(64) }] },
    ...codeMessages,
    ...(finalMessage ? [finalMessage] : []),
  ];
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  await page.addInitScript(() => {
    const waits: Array<{ resolve(): void; reject(error: Error): void }> = [];
    const fixture: Window['__answerClipboard'] = { texts: [], mode: 'success', release: (ok = true) => {
      for (const wait of waits.splice(0)) if (ok) wait.resolve(); else wait.reject(new Error('Clipboard refused'));
    } };
    window.__answerClipboard = fixture;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      fixture.texts.push(text);
      if (fixture.mode === 'pending') await new Promise<void>((resolve, reject) => waits.push({ resolve, reject }));
      if (fixture.mode === 'denied') throw new Error('Clipboard refused');
    } } });
  });
  await page.route('**/answer-rpc', async route => {
    const { method, args = {} } = route.request().postDataJSON(); calls.push({ method, args });
    let result: unknown = {};
    if (method === 'chat.sessions.list') result = { sessions: ['a', 'b'].map(id => ({ ...session(id), message_count: id === 'a' ? messages().length : 1 })) };
    if (method === 'chat.session.get') result = { ...session(args.session_id), plans: [],
      messages: args.session_id === 'a' ? messages() : [message('other-answer', 'A separate saved answer.', 1, 'b')] };
    if (method === 'chat.turns.list') result = { generation: 'g', revision: 1, turns: [] };
    if (method === 'server.getLLMConfig') result = { config: { slot_1: { provider: 'anthropic', model: 'fixture', has_key: true } } };
    if (method === 'chat.default_model_pref.get') result = { source_id: null, updated_at: 1 };
    if (method === 'prefs.get') result = { prefs: {} };
    if (method === 'chat.send') result = { turn_id: 'live', status: 'running' };
    await route.fulfill({ json: { result } });
  });
  await page.route('**/answer-reading.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route('**/answer-reading.html', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}
    body{margin:0;font-family:system-ui,sans-serif;color:var(--fg);background:var(--bg)}#app{height:100dvh}</style></head>
    <body><main id="app"></main><script type="module" src="/answer-reading.js"></script></body></html>` }));
  await page.goto('/answer-reading.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  return { calls, refresh: () => page.evaluate(() => window.__answerReading.refresh()),
    complete: async (content: string) => {
      finalMessage = { ...message('final-live', content, Date.now()), turn_id: 'live' };
      await publish(page, { kind: 'chat.message_complete', session_id: 'a', turn_id: 'live', final: finalMessage, cursor: Date.now() });
    },
  };
};

for (const width of [390, 1280]) {
  test(`prose and literal code remain readable with verified sources at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    await setup(page);
    const prose = page.locator('[data-recued-chat-route-message="prose"] .chat-message-content');
    await expect(prose.getByRole('heading', { name: 'Plan', level: 4 })).toBeVisible();
    await expect(prose.locator('strong')).toHaveText('Check');
    await expect(prose.locator('code')).toHaveText('item_count');
    await expect(prose.locator('ol li')).toHaveText(['First', 'Second']);
    await expect(prose.getByRole('link', { name: 'Saved hose', exact: true })).toHaveAttribute('href', '#yours/asset/asset%3Areading');
    await expect(prose.getByRole('link', { name: 'Unknown', exact: true })).toHaveCount(0);
    expect(await codeBox(page).locator('pre code').textContent()).toBe(rawCode);
    await expect(codeBox(page).locator('a, img, script')).toHaveCount(0);
    const copy = codeBox(page).getByRole('button', { name: 'Copy code', exact: true });
    await expect(copy).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`answers-${width}.png`) });
  });
}

test('Copy uses exact code text and keeps feedback, focus and horizontal position through a refresh', async ({ page }) => {
  const f = await setup(page);
  await input(page).fill('Keep this unsent question.');
  const box = codeBox(page), pre = box.locator('pre'), copy = box.getByRole('button', { name: 'Copy code', exact: true });
  await pre.evaluate(element => { element.scrollLeft = 90; });
  await copy.focus(); await copy.press('Enter');
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => window.__answerClipboard.texts)).toEqual([rawCode]);
  await f.refresh();
  await expect(copy).toHaveText('Copied'); await expect(copy).toBeFocused();
  expect(await pre.evaluate(element => element.scrollLeft)).toBe(90);
  await expect(input(page)).toHaveValue('Keep this unsent question.');
  expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
});

test('a pending copy is single-flight and never claims changed code was copied or steals a newer caret', async ({ page }) => {
  const f = await setup(page);
  await input(page).fill('Stream an example'); await page.locator('[data-recued-chat-route-send]').click();
  await expect(input(page)).toHaveValue('');
  const original = 'First code line.\n';
  await publish(page, { kind: 'chat.token_streamed', session_id: 'a', turn_id: 'live', delta: `\`\`\`text\n${original}`, cursor: 1 });
  await page.evaluate(() => { window.__answerClipboard.mode = 'pending'; });
  const liveCode = page.locator('[data-recued-chat-route-message="live"] [data-chat-answer-code-block]');
  const copy = liveCode.getByRole('button', { name: 'Copy code', exact: true });
  await copy.focus(); await copy.press('Enter'); await expect(copy).toHaveText('Copying…');
  await publish(page, { kind: 'chat.token_streamed', session_id: 'a', turn_id: 'live', delta: 'A newer code line.\n', cursor: 2 });
  await expect(liveCode.locator('pre code')).toContainText('A newer code line.');
  await f.refresh();
  await expect(copy).toBeDisabled(); await expect(copy).toBeFocused();
  await copy.dispatchEvent('click');
  expect(await page.evaluate(() => window.__answerClipboard.texts)).toEqual([original]);
  await input(page).fill('Keep this draft.');
  await input(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 9));
  await page.evaluate(() => window.__answerClipboard.release());
  await expect(copy).toHaveText('Copy');
  await expect(liveCode.getByRole('status')).toContainText('code changed');
  await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue('Keep this draft.');
  expect(await input(page).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([5, 9]);
});

test('clipboard denial offers native code selection and a later denial respects a moved focus', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.__answerClipboard.mode = 'denied'; });
  const copy = codeBox(page).getByRole('button', { name: 'Copy code', exact: true });
  await copy.focus(); await copy.press('Enter');
  await expect(codeBox(page).getByRole('status')).toContainText('Could not copy');
  await expect(codeBox(page).locator('pre')).toBeFocused();
  expect(await page.evaluate(() => getSelection()?.getRangeAt(0).cloneContents().textContent)).toBe(rawCode);
  await page.evaluate(() => { window.__answerClipboard.mode = 'pending'; });
  await copy.focus(); await copy.press('Enter'); await expect(copy).toBeDisabled();
  await input(page).fill('Continue writing.');
  await page.evaluate(() => window.__answerClipboard.release(false));
  await expect(copy).toBeEnabled(); await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue('Continue writing.');
});

test('a delayed clipboard denial preserves a newer text selection even when Copy retains focus', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.__answerClipboard.mode = 'pending'; });
  const copy = codeBox(page).getByRole('button', { name: 'Copy code', exact: true });
  await copy.focus(); await copy.press('Enter'); await expect(copy).toBeDisabled();
  const prose = page.locator('[data-recued-chat-route-message="prose"] .chat-message-content strong');
  await prose.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await expect(copy).toBeFocused();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('Check');
  await page.evaluate(() => window.__answerClipboard.release(false));
  await expect(codeBox(page).getByRole('status')).toContainText('Could not copy');
  await expect(copy).toBeFocused();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('Check');
});

test('distinct replies sharing a turn keep independent Copy operations and feedback', async ({ page }) => {
  await setup(page, 0, true);
  await page.evaluate(() => { window.__answerClipboard.mode = 'pending'; });
  const first = page.locator('[data-recued-chat-route-message="code"] [data-chat-answer-code-block]');
  const second = page.locator('[data-recued-chat-route-message="second-code"] [data-chat-answer-code-block]');
  const copy = first.getByRole('button', { name: 'Copy code', exact: true });
  const otherCopy = second.getByRole('button', { name: 'Copy code', exact: true });
  await copy.focus(); await copy.press('Enter'); await expect(copy).toBeDisabled();
  await expect(otherCopy).toBeEnabled(); await expect(otherCopy).toHaveText('Copy');
  await page.evaluate(() => window.__answerClipboard.release());
  await expect(copy).toHaveText('Copied');
  await expect(otherCopy).toBeEnabled(); await expect(otherCopy).toHaveText('Copy');
  await expect(second.getByRole('status')).toBeEmpty();
  expect(await page.evaluate(() => window.__answerClipboard.texts)).toEqual([rawCode]);
});

test('a missing clipboard and a disposed route cannot report a successful copy', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
  const copy = codeBox(page).getByRole('button', { name: 'Copy code', exact: true });
  await copy.focus(); await copy.press('Enter');
  await expect(codeBox(page).getByRole('status')).toContainText('Could not copy');
  await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => { window.__answerClipboard.mode = 'pending'; });
  await copy.focus(); await copy.press('Enter'); await expect(copy).toHaveText('Copying…');
  await page.evaluate(() => { window.__answerReading.dispose(); window.__answerClipboard.release(); });
  await expect(page.locator('[data-chat-answer-code-copy]')).toHaveCount(0);
});

test('streaming keeps code literal, preserves its selection, and holds the older reading position and draft', async ({ page }) => {
  const f = await setup(page, 35);
  await input(page).fill('Write an example'); await page.locator('[data-recued-chat-route-send]').click();
  await expect(input(page)).toHaveValue(''); await input(page).fill('Keep my next question.');
  const live = page.locator('[data-recued-chat-route-message="live"]');
  const prefix = `## Result\n\n\`\`\`md\n[Example](${record})\n**literal**`;
  await publish(page, { kind: 'chat.token_streamed', session_id: 'a', turn_id: 'live', delta: prefix, cursor: 1 });
  await expect(live.locator('pre code')).toContainText('**literal**');
  await expect(live.locator('pre a')).toHaveCount(0);
  const retained = await live.locator('pre').elementHandle();
  await live.locator('pre code').evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 9);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  const suffix = `\n\`\`\`\n\n**Ready** [source](${record})`;
  await publish(page, { kind: 'chat.token_streamed', session_id: 'a', turn_id: 'live', delta: suffix, cursor: 2 });
  await expect(live.locator('strong')).toHaveText('Ready');
  expect(await retained!.evaluate(element => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('[Example]');
  const scroller = page.locator('[data-recued-chat-route-messages]');
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('[data-chat-latest]')).toBeVisible();
  const anchor = page.locator('[data-recued-chat-route-message="old-0"]');
  const before = (await anchor.boundingBox())!.y - (await scroller.boundingBox())!.y;
  const beforeScroll = await scroller.evaluate(element => element.scrollTop);
  const tail = '\n\n' + 'Later details. '.repeat(150);
  await publish(page, { kind: 'chat.token_streamed', session_id: 'a', turn_id: 'live', delta: tail, cursor: 3 });
  await expect(live).toContainText('Later details.');
  const after = (await anchor.boundingBox())!.y - (await scroller.boundingBox())!.y;
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(beforeScroll);
  await expect(input(page)).toHaveValue('Keep my next question.');
  const liveCopy = live.getByRole('button', { name: 'Copy code', exact: true });
  await liveCopy.focus(); await liveCopy.press('Enter'); await expect(liveCopy).toHaveText('Copied');
  await f.complete(prefix + suffix + tail);
  const final = page.locator('[data-recued-chat-route-message="final-live"]');
  await expect(final.getByRole('button', { name: 'Copy code', exact: true })).toBeFocused();
  await expect(final.getByRole('button', { name: 'Copy code', exact: true })).toHaveText('Copied');
});

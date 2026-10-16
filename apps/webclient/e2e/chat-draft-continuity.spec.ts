import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import { openChatHistory } from './helpers/chat-history.js';

// Real Chat UI, local RPC fixtures. No paired server, providers or production
// bundle is needed to exercise composer ownership and browser navigation.
const root = resolve(import.meta.dirname, '../../..');
const origin = 'http://127.0.0.1:4319';
const input = (page: Page) => page.locator('[data-recued-chat-route-input]');
const selected = { file_id: 'file:quote', filename: 'Quote.pdf', media_class: 'document',
  mime_type: 'application/pdf', size: 10, selection_revision: 'a'.repeat(64) };
let bundle: string;
let tokens: string;
test.beforeAll(async () => {
  tokens = await readFile(resolve(root, 'packages/ui-shared/src/theme/tokens.css'), 'utf8');
  const result = await build({
    stdin: { resolveDir: root, contents: `
      import { bootstrapChatRoute, CHAT_ROUTE_STYLES } from './apps/webclient/src/chat/bootstrap-chat-route.ts';
      const style = document.createElement('style'); style.textContent = CHAT_ROUTE_STYLES; document.head.append(style);
      const conn = async (method, args) => {
        const response = await fetch('/chat-drafts-rpc', { method: 'POST', body: JSON.stringify({ method, args }) });
        const { result, error } = await response.json(); if (error) throw new Error(error); return result;
      };
      const route = bootstrapChatRoute({ root: document.getElementById('app'), conn, initialSessionId: 'a',
        initialRecoveryDraft: { text: '', protected: true, modelSourceId: null, attachments: [${JSON.stringify(selected)}] },
        fileSelectionCaller: args => conn('file.attachment.select', args),
        onAddressChange: hash => history.pushState(null, '', hash) });
      await route.whenLoaded(); document.body.dataset.ready = 'true';
    ` },
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
    tsconfig: resolve(root, 'apps/webclient/tsconfig.json'), logLevel: 'silent',
  });
  bundle = result.outputFiles[0]!.text;
});

const setup = async (page: Page) => {
  const sends: Array<Record<string, unknown>> = [];
  const held = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  const fail = new Set<string>();
  const hold = (key: string) => gates.set(key, new Promise(resolve => { held.set(key, resolve); }));
  const release = (key: string) => { held.get(key)?.(); held.delete(key); gates.delete(key); };
  const session = (id: string) => ({ id, title: `Conversation ${id}`, archived: false,
    created_at: 1, last_active_at: 2, picker_state: { current: 'self' },
    model_routing: { current: 'byok', provider: 'local', model_id: 'fixture', overridden: false } });
  await page.route('**/chat-drafts-rpc', async route => {
    const { method, args = {} } = route.request().postDataJSON();
    const key = method === 'chat.session.get' ? `open:${args.session_id}` : method;
    if (method === 'chat.send') sends.push(args);
    await gates.get(key);
    let result: unknown = {};
    if (method === 'chat.sessions.list') result = { sessions: ['a', 'b', 'c'].map(id => ({ ...session(id), message_count: 1 })) };
    if (method === 'chat.session.get') result = { ...session(args.session_id), plans: [], quoted_replies_available: true,
      messages: [{ id: `question-${args.session_id}`, session_id: args.session_id, role: 'assistant', contributor: 'model',
        content: `Question in ${args.session_id}`, target_server: 'self', ts: 1,
        picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'fixture', instance_id: 'drafts' } },
        model_used: { provider: 'local', model_id: 'fixture' } }] };
    if (method === 'server.getLLMConfig') result = { config: { slot_1: { provider: 'anthropic', model: 'fixture', has_key: true } } };
    if (method === 'chat.default_model_pref.get') result = { source_id: null, updated_at: 1 };
    if (method === 'prefs.get') result = { prefs: {} };
    if (method === 'file.attachment.select') result = selected;
    if (method === 'chat.send') result = { turn_id: `turn-${sends.length}` };
    const error = fail.delete(key) ? 'The fixture connection was interrupted.' : undefined;
    await route.fulfill({ json: error ? { error } : { result } });
  });
  await page.route('**/chat-drafts.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route('**/chat-drafts.html*', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${tokens}
      body{margin:0}#app{height:100dvh}</style></head><body><main id="app"></main><script type="module" src="/chat-drafts.js"></script></body></html>` }));
  await page.goto(`${origin}/chat-drafts.html#chat/session/a`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const open = async (id: string) => {
    await openChatHistory(page);
    await page.locator(`[data-recued-chat-route-session-row="${id}"]`).click();
  };
  return { sends, hold, release, fail, open };
};

for (const width of [1280, 390]) {
  test(`separate drafts retain replies and files and survive a rejected send at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page);
    await input(page).fill('First draft');
    await page.locator('[data-chat-reply-action="question-a"]').click();
    await f.open('b');
    await expect(input(page)).toHaveValue('');
    await expect(page.locator('[data-chat-reply-draft]')).toHaveCount(0);
    await input(page).fill('Second draft');
    await f.open('a');
    await expect(input(page)).toHaveValue('First draft');
    await expect(page.locator('[data-chat-reply-draft="question-a"]')).toBeVisible();
    await expect(page.getByText('Quote.pdf', { exact: true })).toBeVisible();
    f.fail.add('chat.send');
    await page.locator('[data-recued-chat-route-send]').click();
    await expect(page.locator('[data-recued-chat-route-send]')).toBeEnabled();
    await expect(input(page)).toHaveValue('First draft');
    await f.open('b'); await expect(input(page)).toHaveValue('Second draft');
    await f.open('a'); await page.locator('[data-recued-chat-route-send]').click();
    await expect(input(page)).toHaveValue('');
    expect(f.sends).toHaveLength(2);
    expect(f.sends[1]).toEqual(f.sends[0]);
    expect(f.sends[1]).toMatchObject({ session_id: 'a', reply_to_message_id: 'question-a',
      attachments: [{ file_id: selected.file_id, selection_revision: selected.selection_revision }] });
    await f.open('b'); await expect(input(page)).toHaveValue('Second draft');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('failed and superseded opens keep newly typed text with the visible conversation', async ({ page }) => {
  const f = await setup(page);
  await input(page).fill('Original');
  f.fail.add('open:b'); await f.open('b');
  await expect(page.locator('[data-recued-chat-route-error]')).toBeVisible();
  await expect(input(page)).toHaveValue('Original');
  f.hold('open:b'); await f.open('b');
  await input(page).fill('Typed during the load');
  await f.open('c'); await expect(input(page)).toHaveValue('');
  f.release('open:b');
  await f.open('a'); await expect(input(page)).toHaveValue('Typed during the load');
});

test('a late acknowledgement clears only its submitted draft and files', async ({ page }) => {
  const f = await setup(page);
  await input(page).fill('Send from a');
  f.hold('chat.send'); await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => f.sends.length).toBe(1);
  await f.open('b'); await input(page).fill('Keep b');
  f.release('chat.send');
  await f.open('a'); await expect(input(page)).toHaveValue('');
  await expect(page.getByText('Quote.pdf', { exact: true })).toHaveCount(0);
  await f.open('b'); await expect(input(page)).toHaveValue('Keep b');
});

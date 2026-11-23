/** D-402 slice A4 — "Make a recipe" under an answer whose request worked in a web page, in the real
 *  chat route: beside "Copy answer" on that answer and on no other, it asks the server for the
 *  request's recipe, says so while it waits, and opens the draft. Kitchen's item page then shows
 *  the draft's notes between its header and the editor. */

import { expect, test, type Page } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import { readFile } from 'node:fs/promises';

declare global { interface Window {
  __requestRecipe: { made: Array<{ session_id: string; turn_id: string }>; opened: string[]; release(answer: unknown): void };
} }

const esbuild: BuildOptions = { bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: 'apps/webclient/tsconfig.json', logLevel: 'silent' };
let chatBundle: string;
let kitchenBundle: string;
let tokens: string;
test.beforeAll(async () => {
  chatBundle = (await build({ ...esbuild, stdin: { resolveDir: process.cwd(), contents: `
    import { bootstrapChatRoute } from './apps/webclient/src/chat/bootstrap-chat-route.ts';
    const waits = [];
    const fixture = { made: [], opened: [], release: answer => { for (const resolve of waits.splice(0)) resolve(answer); } };
    window.__requestRecipe = fixture;
    const route = bootstrapChatRoute({ root: document.getElementById('app'), initialSessionId: 'a',
      conn: async (method, args) => {
        const reply = await fetch('/recipe-rpc', { method: 'POST', body: JSON.stringify({ method, args }) });
        const body = await reply.json(); if (body.error) throw new Error(body.error); return body.result;
      },
      subscribe: () => () => {},
      requestRecipe: {
        make: args => { fixture.made.push(args); return new Promise(resolve => waits.push(resolve)); },
        open: draft_id => { fixture.opened.push(draft_id); return true; },
      } });
    await route.whenLoaded(); document.body.dataset.ready = 'true';
  ` } })).outputFiles![0]!.text;
  kitchenBundle = (await build({ ...esbuild, stdin: { resolveDir: process.cwd(), contents: `
    import { mountKitchenWorkItemRoute } from './apps/webclient/src/kitchen/work-item-route.ts';
    const draft = { draft_id: 'd-1', kind: 'recipe', title: 'Create a repository',
      source: JSON.stringify({ recipe_id: 'create-repository', metadata: { name: 'Create a repository' } }),
      source_hash: 'h', revision: 1, created_at: 1, updated_at: 1, validation: { valid: true, issues: [], total_issues: 0 },
      notes: ['Step 2 has no selector (SELECTOR-TO-FILL): pick the element before you run it.',
        'Asked for at each run: the repository name.'],
      made_from: { kind: 'chat_request', session_id: 'a', turn_id: 't-browser' } };
    const editor = { dispose() {}, hasUnsavedChanges: () => false, hasInFlightWork: () => false };
    mountKitchenWorkItemRoute({ root: document.getElementById('app'), draftId: 'd-1', get: async () => draft,
      create: async () => draft, update: async () => draft, discard: async () => ({ draft_id: 'd-1', discarded: true }),
      openRecipe: (_recipe, root) => {
        const shown = document.createElement('div'); shown.setAttribute('data-test-editor', '');
        shown.textContent = 'Recipe editor'; root.append(shown); return editor;
      },
      openPack: () => editor });
    document.body.dataset.ready = 'true';
  ` } })).outputFiles![0]!.text;
  tokens = await readFile('packages/ui-shared/src/theme/tokens.css', 'utf8');
});

const picked = { display_name: 'Self', signature: { server_kind: 'recued', version: 'fixture', instance_id: 'recipes' } };
const message = (id: string, role: 'user' | 'assistant', content: string, ts: number, extra: Record<string, unknown> = {}) => ({
  id, session_id: 'a', role, contributor: role === 'user' ? 'owner' : 'model', content, ts, target_server: 'self',
  picker_at_send: picked, model_used: { provider: 'local', model_id: 'fixture' }, ...extra });
const call = (tool_name: string, at: number, browser: boolean) => ({ tool_name, tier: tool_name.includes('/') ? 2 : 1,
  args: {}, status: 'ok', started_at: at - 2_000, completed_at: at - 1_000, ...(browser ? { browser: true } : {}) });

const harnessPage = (name: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${tokens} body{margin:0;font-family:system-ui,sans-serif;color:var(--fg);background:var(--bg)}#app{height:100dvh}</style></head>
  <body><main id="app"></main><script type="module" src="/${name}.js"></script></body></html>`;

const open = async (page: Page, name: string, bundle: string) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`**/${name}.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route(`**/${name}.html`, route => route.fulfill({ contentType: 'text/html', body: harnessPage(name) }));
  await page.goto(`/${name}.html`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  return errors;
};

const chat = async (page: Page) => {
  const now = Date.now();
  const messages = [
    message('ask-browser', 'user', 'Create a repository called recued-notes on GitHub', now - 120_000, { turn_id: 't-browser' }),
    message('browser-answer', 'assistant', 'I created the repository recued-notes.', now - 60_000, { turn_id: 't-browser',
      tool_calls: [call('recued-core/inspect-web-page', now - 60_000, true), call('recued-core/click-web-element', now - 60_000, true)] }),
    message('ask-mail', 'user', 'Any mail from Ada?', now - 30_000, { turn_id: 't-mail' }),
    message('mail-answer', 'assistant', 'Ada wrote once this week, about the rent.', now - 20_000, { turn_id: 't-mail',
      tool_calls: [call('mail.search', now - 20_000, false)] }),
  ];
  await page.route('**/recipe-rpc', async route => {
    const { method, args = {} } = route.request().postDataJSON();
    const session = { id: 'a', title: 'Making recipes', archived: false, created_at: 1, last_active_at: now,
      picker_state: { current: 'self' }, model_routing: { current: 'byok', provider: 'local', model_id: 'fixture', overridden: false } };
    let result: unknown = {};
    if (method === 'chat.sessions.list') result = { sessions: [{ ...session, message_count: messages.length }] };
    if (method === 'chat.session.get') result = { ...session, plans: [], messages: args.session_id === 'a' ? messages : [] };
    if (method === 'chat.turns.list') result = { generation: 'g', revision: 1, turns: [] };
    if (method === 'server.getLLMConfig') result = { config: { slot_1: { provider: 'anthropic', model: 'fixture', has_key: true } } };
    if (method === 'chat.default_model_pref.get') result = { source_id: null, updated_at: 1 };
    if (method === 'prefs.get') result = { prefs: {} };
    await route.fulfill({ json: { result } });
  });
  return open(page, 'request-recipe', chatBundle);
};
const answer = (page: Page, id: string) => page.locator(`[data-recued-chat-route-message="${id}"]`);

for (const width of [390, 1280]) {
  test(`an answer that worked in a web page offers "Make a recipe" beside Copy answer, at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    const errors = await chat(page);
    const make = answer(page, 'browser-answer').getByRole('button', { name: 'Make a recipe', exact: true });
    await expect(make).toBeVisible();
    const copy = answer(page, 'browser-answer').getByRole('button', { name: 'Copy answer', exact: true });
    await expect(copy).toBeVisible();
    // The same row of actions, after Copy answer.
    expect(await make.evaluate((button) => button.parentElement?.hasAttribute('data-chat-answer-actions'))).toBe(true);
    expect(await make.evaluate((button, copyLabel) => {
      const row = button.parentElement!;
      const copyButton = [...row.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === copyLabel);
      return copyButton !== undefined && (copyButton.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }, 'Copy answer')).toBe(true);
    await expect(answer(page, 'mail-answer').getByRole('button', { name: 'Make a recipe', exact: true })).toHaveCount(0);
    await expect(answer(page, 'mail-answer').getByRole('button', { name: 'Copy answer', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`make-a-recipe-${width}.png`) });

    await make.click();
    expect(await page.evaluate(() => window.__requestRecipe.made)).toEqual([{ session_id: 'a', turn_id: 't-browser' }]);
    const line = answer(page, 'browser-answer').getByRole('status').filter({ hasText: 'Making a recipe…' });
    await expect(line).toBeVisible();
    await expect(make).toHaveAttribute('aria-disabled', 'true');
    await page.screenshot({ path: info.outputPath(`make-a-recipe-making-${width}.png`) });
    // A person can still click it while it is marked unavailable; that click starts nothing.
    await make.click({ force: true });
    expect(await page.evaluate(() => window.__requestRecipe.made)).toHaveLength(1);

    await page.evaluate(() => window.__requestRecipe.release({ ok: true, draft_id: 'd-1', kitchen_path: '/webclient/#kitchen/import/d-1', issues: [] }));
    await expect.poll(() => page.evaluate(() => window.__requestRecipe.opened)).toEqual(['d-1']);
    await expect(answer(page, 'browser-answer').getByRole('status').filter({ hasText: 'Opened in Kitchen.' })).toBeVisible();
    await expect(make).not.toHaveAttribute('aria-disabled', 'true');
    expect(errors).toEqual([]);
  });
}

test('says why when no recipe could be made', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await chat(page);
  await answer(page, 'browser-answer').getByRole('button', { name: 'Make a recipe', exact: true }).click();
  await page.evaluate(() => window.__requestRecipe.release({ ok: false, reason: 'nothing_kept',
    issues: ['Recued no longer holds what this request did: it keeps it for an hour after the request.'] }));
  await expect(answer(page, 'browser-answer').getByRole('status')
    .filter({ hasText: 'Recued no longer holds what this request did' })).toBeVisible();
  expect(await page.evaluate(() => window.__requestRecipe.opened)).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [390, 1280]) {
  test(`Kitchen shows a compiled draft's notes between its header and the editor, at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = await open(page, 'compiled-draft', kitchenBundle);
    const notes = page.locator('[data-recued-kitchen-work-notes]');
    await expect(notes).toBeVisible();
    await expect(notes.locator('li')).toHaveText([
      'Step 2 has no selector (SELECTOR-TO-FILL): pick the element before you run it.',
      'Asked for at each run: the repository name.',
    ]);
    const header = await page.locator('[data-recued-kitchen-work] header').boundingBox();
    const list = await notes.boundingBox();
    const editor = await page.locator('[data-test-editor]').boundingBox();
    expect(header!.y + header!.height).toBeLessThanOrEqual(list!.y);
    expect(list!.y + list!.height).toBeLessThanOrEqual(editor!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`compiled-draft-notes-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

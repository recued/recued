/** D-402 slice E4 — a hand-off, in a real browser.
 *
 *  - The notice's link (`#chat/carry-on/<run>`) in the whole app: it asks the server for the chat kept
 *    for the run and hands over to it in place, its message in the composer, sending nothing; Back
 *    returns to where the owner was. A run it cannot carry on says why, and the address becomes Chat.
 *  - Kitchen's recipe, holding the changes Recued made from that chat: the bar says so, with its notes.
 *  - Notices as the realtime bus delivers them: a hand-off's carry-on link, and a failure's rules and
 *    pack links (D-268), each offer "Open"; an address the app does not admit offers none. */

import { expect, test, type Page } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import { readFile } from 'node:fs/promises';

const esbuild: BuildOptions = { bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: 'apps/webclient/tsconfig.json', logLevel: 'silent' };
const bundle = async (contents: string): Promise<string> =>
  (await build({ ...esbuild, stdin: { resolveDir: process.cwd(), contents } })).outputFiles![0]!.text;

const DRAFT = 'Carry on with “Buy the lamp” from where its run stopped. The run said why:\n'
  + 'The page showed something this recipe has not met: the job went on when shop.example.com showed “In stock”. '
  + 'Carry on from here in the chat; the way taken then can be added to the recipe in Kitchen.\n\n'
  + 'Look at that page as it is now and tell me what it shows. If the way on is clear, go on; if not, ask me which way to take.';
const REFUSED = 'This run did not stop at a page its recipe has not met, so there is nothing to carry on from.';
const T = '{{step.act_1.tabs.0.reads.0.text}}';
const SAVED = { recipe_id: 'buy-lamp', version: 3, ttl: 0,
  metadata: { name: 'Buy the lamp', description: 'Does in your browser what your AI did in the chat on shop.example.com: 2 steps '
    + 'through the Browser Bridge. It finds each page among your open tabs by its address, or opens it. It uses no AI.',
  author: 'you', supported_platforms: [], tags: ['browser', 'web', 'browser-plan'] },
  variables: {},
  steps: [
    { id: 'act_1', op: 'core.dom.act', args: { target: 'https://shop.example.com/*', steps: [{ url: 'https://shop.example.com/item/7', do: 'read', form: 'text' }] } },
    { id: 'decide_1', guard: `${T} not_contains In stock`, hand_off: true, fail_reason: 'The page showed something this recipe has not met: the job '
      + 'went on when shop.example.com showed “In stock”. Carry on from here in the chat; the way taken then can be added to the recipe in Kitchen.' },
    { id: 'act_2', op: 'core.dom.act', args: { target: 'https://shop.example.com/*', steps: [{ page: '{{step.act_1.tabs.0.page}}', do: 'click', selector: '#buy' }] } },
  ],
  output: { render: [{ type: 'json', source: 'step.act_2', label: 'Done' }] } };
const MERGED = { ...SAVED,
  metadata: { ...SAVED.metadata, description: `${SAVED.metadata.description} When shop.example.com shows “Out of stock”, it goes on the way your AI took then in the chat.` },
  steps: [
    SAVED.steps[0],
    { id: 'decide_1_met', transform: 'any', conditions: [`${T} contains In stock`, `${T} contains Out of stock`] },
    { ...SAVED.steps[1], guard: '{{step.decide_1_met}} equal false', fail_reason: 'The page showed something this recipe has not met: the job went on '
      + 'when shop.example.com showed “In stock” or “Out of stock”. Carry on from here in the chat; the way taken then can be added to the recipe in Kitchen.' },
    { ...SAVED.steps[2], skip_when: `${T} not_contains In stock` },
    { id: 'decide_1_b', transform: 'any', conditions: [`${T} not_contains Out of stock`, `${T} contains In stock`] },
    { id: 'decide_1_b_act_2', op: 'core.dom.act', skip_when: '{{step.decide_1_b}} equal true',
      args: { target: 'https://shop.example.com/*', steps: [{ page: '{{step.act_1.tabs.0.page}}', do: 'click', selector: '#wishlist' }] } },
  ] };
const NOTE = 'When shop.example.com shows “Out of stock”, the recipe now goes on the way your AI took in the chat. '
  + 'It still stops, for you to carry on, on a page that shows none of “In stock”, “Out of stock”.';

let appBundle: string;
let kitchenBundle: string;
let toastsBundle: string;
let tokens: string;
test.beforeAll(async () => {
  // The whole app, as `mail-work-harness.ts` mounts it: no hash source, so the shell's own browser source
  // makes the hand-over, with the shipped History behaviour. The fake server answers through `/carry-on-rpc`.
  appBundle = await bundle(`
    import { bootstrapWebclient } from './apps/webclient/src/webclient-bootstrap.ts';
    import { createInMemoryWebclientLocalStore } from './apps/webclient/src/storage/local-store.ts';
    import { HARNESS_SERVER_PUBLIC_KEY } from './apps/webclient/e2e/harness/server-identity.ts';
    const messages = new Set(); const states = new Set();
    const transport = {
      async open() { for (const listener of states) listener('connected'); }, async close() {},
      onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
      onState(listener) { states.add(listener); return () => states.delete(listener); },
      async send(payload) {
        if (payload.type !== 'rpc' || !/^(chat\\.|server\\.getLLMConfig$|prefs\\.get$)/u.test(payload.method)) return;
        const response = await fetch('/carry-on-rpc', { method: 'POST', body: JSON.stringify({ method: payload.method, args: payload.args ?? {} }) });
        const envelope = await response.json();
        for (const listener of messages) listener({ type: 'rpc_result', request_id: payload.request_id,
          ...(envelope.error ? { error: { code: 'bad_request', message: envelope.error } } : { result: envelope.result }) });
      },
    };
    const token = { token_id: 'fixture', ciphertext_b64: 'ZmFrZQ==', iv_b64: 'ZmFrZQ==', issued_at: Date.now() };
    await bootstrapWebclient({ root: document.getElementById('app'), document, transport,
      localStore: createInMemoryWebclientLocalStore({ server_url: 'wss://fixture.invalid/ws', server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: token, pair_metadata: { paired_at: Date.now(), server_passport_fingerprint: 'fixture', server_handle_at_pair: 'fixture',
          instance_id: 'carry-on-browser' }, cert_pin_state: null }),
      tokenStore: { wrap: async () => token, unwrap: async () => 'fixture-bearer' },
      exposureProfile: 'community-shareable', enablePassportFetchVerify: false, rpcMaxInFlight: Number.POSITIVE_INFINITY });
    document.body.dataset.ready = 'true';
  `);
  kitchenBundle = await bundle(`
    import { mountRecipeEditorRoute } from './apps/webclient/src/kitchen/recipe-editor/mount-recipe-editor-route.ts';
    const saved = ${JSON.stringify(SAVED)};
    const merged = ${JSON.stringify(MERGED)};
    const base = { recipe_id: 'buy-lamp', version: 3 };
    const item = { draft_id: 'w1', kind: 'recipe', title: 'Buy the lamp', source: JSON.stringify(merged, null, 2), source_hash: 'h',
      revision: 1, created_at: 1, updated_at: 2, validation: { valid: true, issues: [], total_issues: 0 }, base,
      notes: [${JSON.stringify(NOTE)}], made_from: { kind: 'chat_request', session_id: 'chat-carry', turn_id: 't-1' } };
    const storage = new Map();
    mountRecipeEditorRoute({ root: document.getElementById('app'), document, recipeId: 'buy-lamp',
      listCaller: async () => ({ recipes: [] }),
      getCaller: async () => ({ recipe: { recipe_id: 'buy-lamp', publisher_id: 'recued-core', version: 3, recipe_hash: 'h', recipe: saved,
        source: 'bundled', installed_at: 0 } }),
      validateCaller: async () => ({ ok: true, issues: [] }),
      saveCaller: async args => { window.__saved = args.recipe; return { saved: true, recipe_id: 'buy-lamp', version: 4, name: 'Buy the lamp' }; },
      recovery: { key: 'k', storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); },
        removeItem: key => { storage.delete(key); } } },
      changes: {
        list: async () => ({ items: [{ draft_id: 'w1', kind: 'recipe', title: 'Buy the lamp', revision: 1, created_at: 1, updated_at: 2,
          from: 'your chat', ready: true, problems: 0, base }] }),
        get: async () => item, create: async () => item,
        update: async (draft_id, revision, source) => { window.__kept = source; return { ...item, draft_id, revision: revision + 1, source }; },
        discard: async draft_id => ({ draft_id, discarded: true }),
      },
      confirm: () => true });
    document.body.dataset.ready = 'true';
  `);
  toastsBundle = await bundle(`
    import { mountNotifyToasts, NOTIFY_TOASTS_STYLES, NOTIFY_TOASTS_STYLES_MARKER } from './apps/webclient/src/notify-toasts.ts';
    // The styles the bootstrap injects once.
    const style = document.createElement('style'); style.setAttribute(NOTIFY_TOASTS_STYLES_MARKER, '');
    style.textContent = NOTIFY_TOASTS_STYLES; document.head.append(style);
    const listeners = new Map();
    mountNotifyToasts({ host: document.getElementById('app'), document, durationMs: 600000,
      subscribe: (kind, listener) => { listeners.set(kind, listener); return () => listeners.delete(kind); } });
    window.__notify = event => listeners.get('notification.notify')?.(event);
    document.body.dataset.ready = 'true';
  `);
  tokens = await readFile('packages/ui-shared/src/theme/tokens.css', 'utf8');
});

const harnessPage = (name: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${tokens} body{margin:0;font-family:system-ui,sans-serif;color:var(--fg);background:var(--bg)}#app{min-height:100dvh}</style></head>
  <body><main id="app"></main><script type="module" src="/${name}.js"></script></body></html>`;

const open = async (page: Page, name: string, script: string, hash = '') => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`**/${name}.js`, route => route.fulfill({ contentType: 'text/javascript', body: script }));
  await page.route(`**/${name}.html`, route => route.fulfill({ contentType: 'text/html', body: harnessPage(name) }));
  await page.goto(`/${name}.html${hash}`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  return errors;
};

/** The fake server: the chat kept for a run, or a refusal; the chat itself, empty, as a new one is. */
const serve = async (page: Page) => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const session = { id: 'chat-carry', title: 'Carry on: Buy the lamp', archived: false, created_at: 1, last_active_at: 2,
    picker_state: { current: 'self' }, model_routing: { current: 'byok', provider: 'local', model_id: 'fixture', overridden: false } };
  await page.route('**/carry-on-rpc', async route => {
    const { method, args = {} } = route.request().postDataJSON() as { method: string; args?: Record<string, unknown> };
    calls.push({ method, args });
    let result: unknown = {};
    if (method === 'chat.execution.carry_on') {
      result = args.run_id === 'run-7' ? { ok: true, session_id: 'chat-carry', draft: DRAFT }
        : { ok: false, reason: 'not_a_hand_off', message: REFUSED };
    }
    if (method === 'chat.sessions.list') result = { sessions: [{ ...session, message_count: 0 }] };
    if (method === 'chat.session.get') result = { ...session, plans: [], messages: [] };
    if (method === 'chat.turns.list') result = { generation: 'g', revision: 1, turns: [] };
    if (method === 'server.getLLMConfig') result = { config: { slot_1: { provider: 'anthropic', model: 'fixture', has_key: true } } };
    if (method === 'chat.default_model_pref.get') result = { source_id: null, updated_at: 1 };
    if (method === 'prefs.get') result = { prefs: {} };
    await route.fulfill({ json: { result } });
  });
  return calls;
};

for (const width of [390, 1280]) {
  test(`the notice's link opens the run's chat in place, its message in the composer, sending nothing, at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    const calls = await serve(page);
    const errors = await open(page, 'carry-on', appBundle, '#reception');
    const before = await page.evaluate(() => history.length);
    // As the notice's Open does: one navigation to the run's address.
    await page.evaluate(() => { location.hash = '#chat/carry-on/run-7'; });
    await expect(page).toHaveURL(/#chat\/session\/chat-carry$/u);
    // In place: the link's one entry, replaced by the chat's.
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
    const composer = page.locator('[data-recued-chat-route-input]');
    await expect(composer).toHaveValue(DRAFT);
    await expect(composer).toBeVisible();
    expect(calls.filter(call => call.method === 'chat.execution.carry_on').map(call => call.args)).toEqual([{ run_id: 'run-7' }]);
    expect(calls.some(call => call.method === 'chat.send')).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`carry-on-chat-${width}.png`) });
    // Back returns to where the owner was, never to the run's address, which would open it again. The message
    // waits unsent, so the shell first asks, as it does for any unsent draft (contact, event and asset
    // hand-overs into Chat too); leaving discards only this tab's copy: the notice opens the same chat again.
    const dialogs: string[] = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.goBack();
    await expect(page).toHaveURL(/#reception$/u);
    expect(dialogs).toEqual(['Discard unsaved changes?']);
    expect(calls.filter(call => call.method === 'chat.execution.carry_on')).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test('a run it cannot carry on: a notice says why, and the address becomes Chat', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await serve(page);
  const errors = await open(page, 'carry-on', appBundle, '#reception');
  await page.evaluate(() => { location.hash = '#chat/carry-on/run-8'; });
  await expect(page).toHaveURL(/#chat$/u);
  await expect(page.getByText(REFUSED)).toBeVisible();
  expect(calls.some(call => call.method === 'chat.send')).toBe(false);
  await page.screenshot({ path: info.outputPath('carry-on-refused-390.png') });
  expect(errors).toEqual([]);
});

for (const width of [390, 1280]) {
  test(`Kitchen holds Recued's changes to the recipe and says where they came from, at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = await open(page, 'recued-changes', kitchenBundle);
    const bar = page.locator('[data-recued-recipe-changes=""]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Recued made these changes from your chat. They are kept until you save or discard them.');
    await expect(bar.locator('[data-recued-recipe-changes-notes] li')).toHaveText([NOTE]);
    await expect(bar.getByRole('button', { name: 'Discard changes', exact: true })).toBeVisible();
    // The editor holds the merged recipe, the chat's way among its steps (the list is folded on a phone).
    await expect(page.getByText('6 steps', { exact: true }).first()).toBeVisible();
    const added = page.getByText('decide_1_b_act_2').first();
    if (!(await added.isVisible())) await page.locator('summary').filter({ hasText: 'The steps' }).click();
    await expect(added).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`recued-changes-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('notices offer Open for a hand-off\'s chat and a failure\'s rules or pack, and for no other address', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await open(page, 'notices', toastsBundle);
  const notices = [
    { title: 'Buy the lamp failed', text: 'The page showed something this recipe has not met. Open it to carry on in Chat.', link_url: '#chat/carry-on/run-7' },
    { title: 'Renewal notice failed', text: 'Provider said no. Recued will stop this automation if it fails 5 times.', link_url: '#automation/pub%2Frenewal-notice' },
    { title: 'Sync deals has stopped', text: 'HubSpot did not accept its sign-in: reconnect it from its pack’s page.', link_url: '#packs/hubspot' },
    { title: 'Not an address', text: 'This link is not one the app admits.', link_url: '#automation/x/../settings' },
  ];
  for (const notice of notices) await page.evaluate(event => (window as unknown as { __notify(e: unknown): void }).__notify(event), notice);
  const card = (title: string) => page.locator('[data-recued-notify-toast]').filter({ hasText: title });
  await expect(card('Buy the lamp failed').getByRole('link', { name: 'Open' })).toHaveAttribute('href', '#chat/carry-on/run-7');
  await expect(card('Renewal notice failed').getByRole('link', { name: 'Open' })).toHaveAttribute('href', '#automation/pub%2Frenewal-notice');
  await expect(card('Sync deals has stopped').getByRole('link', { name: 'Open' })).toHaveAttribute('href', '#packs/hubspot');
  await expect(card('Not an address')).toBeVisible();
  await expect(card('Not an address').getByRole('link')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('notices-390.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('saving in Kitchen keeps the hand-off: the decision still hands off, with its reason, and each way its condition', async ({ page }) => {
  // ⛔ The guard card shows neither \`hand_off\` nor its reason. An editor that rebuilt steps from the fields it
  // shows would drop them, and the saved recipe would stop in silence again (D-402 E4a).
  page.on('dialog', async dialog => { await dialog.accept(); });
  const errors = await open(page, 'recued-changes', kitchenBundle);
  await expect(page.locator('[data-recued-recipe-changes=""]')).toBeVisible();
  await page.locator('[data-recued-recipe-editor-recipe-name]').fill('Buy the lamp, or wish for it');
  const shape = (recipe: { steps: Array<Record<string, unknown>> }) => recipe.steps.map(step => ({ id: step.id,
    ...(step.hand_off !== undefined ? { hand_off: step.hand_off } : {}), ...(step.fail_reason !== undefined ? { fail_reason: step.fail_reason } : {}),
    ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}) }));
  const expected = shape(MERGED as unknown as { steps: Array<Record<string, unknown>> });
  // As kept while it is typed...
  await expect.poll(() => page.evaluate(() => (window as unknown as { __kept?: string }).__kept ?? ''), { timeout: 10_000 }).not.toBe('');
  expect(shape(JSON.parse(await page.evaluate(() => (window as unknown as { __kept: string }).__kept)))).toEqual(expected);
  // ...and as saved.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __saved?: unknown }).__saved !== undefined)).toBe(true);
  expect(shape(await page.evaluate(() => (window as unknown as { __saved: { steps: Array<Record<string, unknown>> } }).__saved))).toEqual(expected);
  expect(errors).toEqual([]);
});

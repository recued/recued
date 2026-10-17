import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import { openChatHistory } from './helpers/chat-history.js';

declare global { interface Window {
  __voiceLeaveFixture: {
    attempts: Array<{ granted: boolean; started: boolean; stopped: boolean }>;
    allow: (attempt: number) => void;
    refuse: (attempt: number) => void;
    holdStop: (attempt: number) => void;
    finishStop: (attempt: number, empty?: boolean) => void;
    failStop: (attempt: number) => void;
  };
  __repairChatDrafts: () => Promise<void>;
  __refreshChatDrafts: () => Promise<void>;
  __draftVoiceFixture: {
    attempts: Array<{ stopped: boolean; cancelled: boolean }>;
    allow: (attempt: number) => void;
    refuse: (attempt: number) => void;
    fail: (attempt: number) => void;
    holdStop: (attempt: number) => void;
    finishStop: (attempt: number) => void;
    failStop: (attempt: number) => void;
  };
  __draftUploadFixture: {
    attempts: Array<{ filename: string; destroyed: boolean }>;
    progress: (attempt: number, sent: number) => void;
    finish: (attempt: number, fileId: string) => void;
    fail: (attempt: number) => void;
  };
} }

// Real Chat UI, local RPC fixtures. No paired server, providers or production
// bundle is needed to exercise composer ownership and browser navigation.
const root = resolve(import.meta.dirname, '../../..');
const origin = 'http://127.0.0.1:4319';
const input = (page: Page) => page.locator('[data-recued-chat-route-input]');
const voiceControl = (page: Page) => page.locator('[data-recued-chat-route-voice]:not([data-recued-chat-route-voice="discard"])');
const tabToVoiceDismiss = async (page: Page, browserName: string, name = 'Discard recording') => {
  const dismiss = page.getByRole('button', { name, exact: true });
  await expect(voiceControl(page)).toBeFocused();
  await page.keyboard.press('Tab');
  // WebKit can reserve plain Tab for text fields; Option+Tab includes buttons.
  if (browserName === 'webkit' && !await dismiss.evaluate(button => button === document.activeElement)) {
    await voiceControl(page).focus();
    await page.keyboard.press('Alt+Tab');
  }
  await expect(dismiss).toBeFocused();
  return dismiss;
};
const selected = { file_id: 'file:quote', filename: 'Quote.pdf', media_class: 'document',
  mime_type: 'application/pdf', size: 10, selection_revision: 'a'.repeat(64) };
let bundle: string;
let tokens: string;
// The UI and attachment controller are real. A fixture upload engine gives
// both route-only and full-shell cases control over completion and late events.
const uploadFixturePlugin: Plugin = { name: 'draft-upload-fixture', setup(builder) {
  builder.onLoad({ filter: /[\\/]upload[\\/]engine\.(?:js|ts)$/ }, () => ({ contents: `
    const attempts = [];
    window.__draftUploadFixture = { attempts,
      progress: (n, sent) => attempts[n].listener?.({ sent, total: 10 }),
      finish: (n, fileId) => attempts[n].listener?.({ sent: 10, total: 10, recordId: fileId }),
      fail: n => attempts[n].listener?.({ sent: 0, total: 10, error: 'Connection lost' }) };
    export const createUploadEngine = () => {
      const attempt = { filename: '', destroyed: false, listener: undefined }; attempts.push(attempt);
      return { start: file => { attempt.filename = file.name; }, cancel() {},
        on: (_, listener) => { attempt.listener = listener; return () => {}; },
        destroy: () => { attempt.destroyed = true; } };
    };
  `, loader: 'js' }));
} };
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
      const create = (sessionId, recovery) => bootstrapChatRoute({
        root: document.getElementById('app'), conn,
        ...(sessionId ? { initialSessionId: sessionId } : { initialLanding: 'new' }),
        initialRecoveryDraft: recovery,
        uploadCallers: {}, uploadConnect: async () => { throw new Error('The upload engine is fixture-owned.'); },
        voiceCapture: new URL(location.href).searchParams.get('voice') === 'true' ? captureVoice : null,
        ...(new URL(location.href).searchParams.get('picker') === 'menu'
          ? { fileListCaller: async () => ({ files: [] }) } : {}),
        fileSelectionCaller: args => conn('file.attachment.select', args),
        filePreviewCallers: { preview: args => conn('file.preview', args), read: args => conn('file.read', args) },
        onAddressChange: hash => history.pushState(null, '', hash) });
      const voiceAttempts = [];
      const voiceControls = [];
      window.__draftVoiceFixture = { attempts: voiceAttempts,
        allow: n => voiceControls[n].allow(), refuse: n => voiceControls[n].refuse(),
        fail: n => voiceControls[n].fail(), holdStop: n => voiceControls[n].holdStop(),
        finishStop: n => voiceControls[n].finishStop(), failStop: n => voiceControls[n].failStop() };
      const captureVoice = onError => new Promise((resolve, reject) => {
        const attempt = { stopped: false, cancelled: false }; voiceAttempts.push(attempt);
        const recording = { blob: new Blob(['voice']), filename: 'Voice.webm', mime_type: 'audio/webm' };
        let holdStop = false, finishStop, failStop;
        voiceControls.push({
          holdStop: () => { holdStop = true; },
          finishStop: () => finishStop(recording),
          failStop: () => failStop(new Error('The recorder failed to stop.')),
          allow: () => resolve({
            stop: async () => {
              attempt.stopped = true;
              return holdStop ? new Promise((resolve, reject) => { finishStop = resolve; failStop = reject; }) : recording;
            },
            cancel: () => { attempt.cancelled = true; } }),
          refuse: () => reject(Object.assign(new Error('Microphone refused'), { name: 'NotAllowedError' })),
          fail: () => onError?.() });
      });
      let route = create('a', { text: '', protected: true, modelSourceId: null, attachments: [${JSON.stringify(selected)}] });
      window.__refreshChatDrafts = () => route.refresh();
      window.__repairChatDrafts = async () => {
        const recovery = route.getRecoveryDraft(); const sessionId = route.getThread().session?.id;
        route.dispose(); route = create(sessionId, recovery); await route.whenLoaded();
      };
      await route.whenLoaded(); document.body.dataset.ready = 'true';
    ` },
    plugins: [uploadFixturePlugin],
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
    tsconfig: resolve(root, 'apps/webclient/tsconfig.json'), logLevel: 'silent',
  });
  bundle = result.outputFiles[0]!.text;
});

const setup = async (page: Page, picker: 'direct' | 'menu' = 'direct', voice = false, prefs: Record<string, unknown> = {}) => {
  const sends: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  const held = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  const fail = new Set<string>();
  const deleted = new Set<string>();
  const hold = (key: string) => gates.set(key, new Promise(resolve => { held.set(key, resolve); }));
  const release = (key: string) => { held.get(key)?.(); held.delete(key); gates.delete(key); };
  const session = (id: string) => ({ id, title: `Conversation ${id}`, archived: false,
    created_at: 1, last_active_at: 2, picker_state: { current: 'self' },
    model_routing: { current: 'byok', provider: 'local', model_id: 'fixture', overridden: false } });
  await page.route('**/chat-drafts-rpc', async route => {
    const { method, args = {} } = route.request().postDataJSON();
    const key = method === 'chat.session.get' ? `open:${args.session_id}` : method;
    if (method === 'chat.send') sends.push(args);
    if (method === 'chat.session.delete') deletes.push(args.session_id);
    await gates.get(key);
    const error = fail.delete(key) ? 'The fixture connection was interrupted.' : undefined;
    let result: unknown = {};
    if (method === 'chat.session.delete' && !error) deleted.add(args.session_id);
    if (method === 'chat.sessions.list') result = { sessions: ['a', 'b', 'c'].filter(id => !deleted.has(id)).map(id => ({ ...session(id), message_count: 1 })) };
    if (method === 'chat.session.get') result = { ...session(args.session_id), plans: [], quoted_replies_available: true,
      messages: [{ id: `question-${args.session_id}`, session_id: args.session_id, role: 'assistant', contributor: 'model',
        content: `Question in ${args.session_id}`, target_server: 'self', ts: 1,
        picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'fixture', instance_id: 'drafts' } },
        model_used: { provider: 'local', model_id: 'fixture' } }] };
    if (method === 'server.getLLMConfig') result = { config: {
      slot_1: { provider: 'anthropic', model: 'fixture', has_key: true },
      ...(voice ? { transcription_slot: { provider: 'openai', model: 'fixture', has_key: true } } : {}),
    } };
    if (method === 'chat.default_model_pref.get') result = { source_id: null, updated_at: 1 };
    if (method === 'prefs.get') result = { prefs };
    if (method === 'file.attachment.select') result = selected;
    if (method === 'file.preview') result = { record_id: args.record_id, filename: 'Quote.pdf', mime_type: 'application/pdf',
      transient: false, can_download: false, unavailable_reason: 'No preview bytes in this fixture.' };
    if (method === 'chat.send') result = { turn_id: `turn-${sends.length}` };
    if (method === 'chat.session.create') result = { session_id: 'draft-created' };
    await route.fulfill({ json: error ? { error } : { result } });
  });
  await page.route('**/chat-drafts.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route('**/chat-drafts.html*', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${tokens}
      body{margin:0}#app{height:100dvh}</style></head><body><main id="app"></main><script type="module" src="/chat-drafts.js"></script></body></html>` }));
  await page.goto(`${origin}/chat-drafts.html?picker=${picker}&voice=${voice}#chat/session/a`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const open = async (id: string) => {
    await openChatHistory(page);
    await page.locator(`[data-recued-chat-route-session-row="${id}"]`).click();
  };
  return { sends, deletes, hold, release, fail, open };
};

for (const width of [1280, 390]) {
  test(`keeps a selected file and recorded note for explicit Send at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    const mic = voiceControl(page);
    await mic.focus(); await page.keyboard.press('Enter');
    await page.evaluate(() => window.__draftVoiceFixture.allow(0));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    const stopLabel = await mic.getAttribute('aria-label');
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:note'));
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
    expect(f.sends).toHaveLength(0);
    expect(stopLabel).toBe('Stop recording and attach');
    await expect(mic).toBeFocused();
    await page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0]).toMatchObject({ session_id: 'a', message: '', attachments: [
      { file_id: selected.file_id, selection_revision: selected.selection_revision },
      { file_id: 'file:note', media_class: 'voice' },
    ] });
    await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
  });

  for (const other of ['document', 'voice'] as const) {
    for (const last of ['other', 'note'] as const) {
      test(`keeps pending ${other} and voice uploads for explicit Send when ${last} finishes last at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        const f = await setup(page, 'direct', true);
        await page.getByRole('button', { name: 'Remove Quote.pdf', exact: true }).click();
        const mic = voiceControl(page);
        if (other === 'document') {
          await page.locator('[data-recued-chat-route-attach-input]').setInputFiles({
            name: 'Other.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf'),
          });
        } else {
          await mic.click(); await page.evaluate(() => window.__draftVoiceFixture.allow(0));
          await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
          await mic.click();
        }
        await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
        await mic.focus(); await page.keyboard.press('Enter');
        await page.evaluate(n => window.__draftVoiceFixture.allow(n), other === 'voice' ? 1 : 0);
        await expect(mic).toHaveAccessibleName('Stop recording and attach');
        await expect(mic).toBeFocused();
        await page.keyboard.press('Space');
        await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(2);
        const first = last === 'other' ? 1 : 0;
        await page.evaluate(n => window.__draftUploadFixture.finish(n, n === 0 ? 'file:other' : 'file:note'), first);
        await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
        expect(f.sends).toHaveLength(0);
        await page.evaluate(n => window.__draftUploadFixture.finish(n, n === 0 ? 'file:other' : 'file:note'), 1 - first);
        await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
        expect(f.sends).toHaveLength(0);
        await expect(mic).toBeFocused();
        await page.locator('[data-recued-chat-route-send]').click();
        await expect.poll(() => f.sends.length).toBe(1);
        expect(f.sends[0]).toMatchObject({ session_id: 'a', message: '', attachments: [
          { file_id: 'file:other', media_class: other }, { file_id: 'file:note', media_class: 'voice' },
        ] });
        await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
      });
    }
  }

  test(`removing a pending extra upload keeps the completed voice note for explicit Send at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    await page.getByRole('button', { name: 'Remove Quote.pdf', exact: true }).click();
    await page.locator('[data-recued-chat-route-attach-input]').setInputFiles({
      name: 'Other.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf'),
    });
    const mic = voiceControl(page);
    await mic.click(); await page.evaluate(() => window.__draftVoiceFixture.allow(0));
    await expect(mic).toHaveAccessibleName('Stop recording and attach');
    await mic.click();
    await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(2);
    await page.evaluate(() => window.__draftUploadFixture.finish(1, 'file:note'));
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove Other.pdf', exact: true }).click();
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:removed'));
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
    await expect(page.locator('[data-recued-chat-route-send]')).toBeEnabled();
    expect(f.sends).toHaveLength(0);
    await page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0]).toMatchObject({ session_id: 'a', message: '',
      attachments: [{ file_id: 'file:note', media_class: 'voice' }],
    });
  });

  test(`voice Stop action follows adding and removing another attachment at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    await page.getByRole('button', { name: 'Remove Quote.pdf', exact: true }).click();
    const mic = voiceControl(page);
    await mic.click(); await page.evaluate(() => window.__draftVoiceFixture.allow(0));
    await expect(mic).toHaveAccessibleName('Stop recording and send');
    await page.locator('[data-recued-chat-route-attach-input]').setInputFiles({
      name: 'Other.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf'),
    });
    await expect(mic).toHaveAccessibleName('Stop recording and attach');
    await page.getByRole('button', { name: 'Remove Other.pdf', exact: true }).click();
    await expect(mic).toHaveAccessibleName('Stop recording and send');
    await mic.focus(); await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(2);
    await page.evaluate(() => window.__draftUploadFixture.finish(1, 'file:note'));
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0]).toMatchObject({ session_id: 'a', message: '',
      attachments: [{ file_id: 'file:note', media_class: 'voice' }],
    });
  });

  for (const outcome of ['accepted', 'rejected'] as const) {
    for (const upload of ['before', 'after'] as const) {
      test(`keeps Stop available and the newer note when its upload finishes ${upload} the ${outcome} send at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        const f = await setup(page, 'direct', true);
        await page.getByRole('button', { name: 'Remove Quote.pdf', exact: true }).click();
        const mic = voiceControl(page);
        await mic.click();
        await page.evaluate(() => window.__draftVoiceFixture.allow(0));
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
        await mic.click();
        await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
        await mic.focus(); await page.keyboard.press('Enter');
        await page.evaluate(() => window.__draftVoiceFixture.allow(1));
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
        f.hold('chat.send');
        if (outcome === 'rejected') f.fail.add('chat.send');
        await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:earlier'));
        await expect.poll(() => f.sends.length).toBe(1);
        expect(f.sends[0]).toMatchObject({
          session_id: 'a', message: '', attachments: [{ file_id: 'file:earlier', media_class: 'voice' }],
        });
        await expect(mic).toBeEnabled();
        await expect(mic).toHaveAccessibleName('Stop recording');
        await expect(mic).toBeFocused();
        await page.keyboard.press('Space');
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
        await expect(mic).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Discard recording', exact: true })).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(2);
        expect(await page.evaluate(() => window.__draftVoiceFixture.attempts)).toEqual([
          { stopped: true, cancelled: false }, { stopped: true, cancelled: false },
        ]);
        const finish = () => page.evaluate(() => window.__draftUploadFixture.finish(1, 'file:later'));
        if (upload === 'before') await finish();
        await input(page).focus();
        f.release('chat.send');
        await expect(mic).toBeEnabled();
        if (upload === 'after') await finish();
        await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(outcome === 'accepted' ? 1 : 2);
        await expect(input(page)).toHaveValue('');
        await expect(input(page)).toBeFocused();
        expect(await input(page).evaluate(element => {
          const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd];
        })).toEqual([0, 0]);
        expect(f.sends).toHaveLength(1);
        await page.locator('[data-recued-chat-route-send]').click();
        await expect.poll(() => f.sends.length).toBe(2);
        expect(f.sends[1]).toMatchObject({ session_id: 'a', message: '',
          attachments: (outcome === 'accepted' ? ['file:later'] : ['file:earlier', 'file:later'])
            .map(file_id => ({ file_id, media_class: 'voice' })),
        });
        await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
      });
    }
  }

  for (const cancelPhase of ['opening', 'recording'] as const) {
    test(`keeps earlier draft audio when cancelling a newer ${cancelPhase} attempt at ${width}px`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: 844 });
      const f = await setup(page, 'direct', true);
      const mic = voiceControl(page);
      await input(page).fill('Keep a');
      await mic.click();
      await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
      await mic.click();
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
      await f.open('b'); await expect(page).toHaveURL(/#chat\/session\/b$/);
      await input(page).fill('Keep b');
      await mic.focus(); await page.keyboard.press('Enter');
      if (cancelPhase === 'recording') await page.evaluate(() => window.__draftVoiceFixture.allow(1));
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', cancelPhase);
      await tabToVoiceDismiss(page, browserName, cancelPhase === 'opening' ? 'Cancel recording request' : 'Discard recording');
      await page.keyboard.press('Space');
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
      await expect(mic).toBeFocused();
      await input(page).focus();
      await input(page).evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(1, 4));
      await page.evaluate(() => window.__draftVoiceFixture.finishStop(0));
      await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
      if (cancelPhase === 'opening') await page.evaluate(() => window.__draftVoiceFixture.allow(1));
      await page.evaluate(() => window.__draftVoiceFixture.fail(1));
      await expect.poll(() => page.evaluate(() => window.__draftVoiceFixture.attempts[1]?.cancelled)).toBe(true);
      await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:earlier-voice'));
      await expect(input(page)).toBeFocused();
      await expect(input(page)).toHaveValue('Keep b');
      expect(await input(page).evaluate(element => {
        const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd];
      })).toEqual([1, 4]);
      await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
      await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(0);
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
      await f.open('a'); await expect(page).toHaveURL(/#chat\/session\/a$/);
      await expect(input(page)).toHaveValue('Keep a');
      await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
      await expect(page.getByText('Voice.webm', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.__draftVoiceFixture.attempts)).toEqual([
        { stopped: true, cancelled: false }, { stopped: false, cancelled: true },
      ]);
      expect(f.sends).toHaveLength(0);
    });
  }

  test(`discarding a new draft drops its audio and retains another draft's pending audio at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    const mic = voiceControl(page);
    await input(page).fill('Keep a');
    await mic.click();
    await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await mic.click();
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
    await expect(page).toHaveURL(/#chat\/new$/);
    await expect(input(page)).toHaveValue('');
    await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
    for (const attempt of [1, 2]) {
      await mic.click();
      await page.evaluate(n => { window.__draftVoiceFixture.allow(n); window.__draftVoiceFixture.holdStop(n); }, attempt);
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
      await mic.click();
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    }
    await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
    await expect(page.locator('[data-recued-chat-route-history-draft-guard]')).toBeVisible();
    await page.getByRole('button', { name: 'Throw it away and start a new one', exact: true }).click();
    expect(await page.evaluate(() => window.__draftVoiceFixture.attempts.map(attempt => attempt.cancelled)))
      .toEqual([false, true, true]);
    await input(page).fill('Keep the replacement draft');
    await input(page).evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 5));
    await page.evaluate(() => { for (const n of [0, 1, 2]) window.__draftVoiceFixture.finishStop(n); });
    await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:retained-voice'));
    await expect(input(page)).toHaveValue('Keep the replacement draft');
    await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate(element => {
      const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd];
    })).toEqual([2, 5]);
    await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
    await f.open('a'); await expect(page).toHaveURL(/#chat\/session\/a$/);
    await expect(input(page)).toHaveValue('Keep a');
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
    expect(f.sends).toHaveLength(0);
  });

  test(`Escape keeps a draft with only finishing voice notes after New chat at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': false });
    await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
    await expect(page).toHaveURL(/#chat\/new$/);
    const mic = voiceControl(page);
    for (const n of [0, 1]) {
      await mic.click();
      await page.evaluate(n => { window.__draftVoiceFixture.allow(n); window.__draftVoiceFixture.holdStop(n); }, n);
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording'); await mic.click();
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    }
    await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
    const guard = page.locator('[data-recued-chat-route-history-draft-guard]');
    await expect(guard).toBeFocused(); await page.keyboard.press('Escape');
    await expect(guard).toHaveCount(0); await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('');
    expect(await page.evaluate(() => window.__draftVoiceFixture.attempts.map(attempt => attempt.cancelled))).toEqual([false, false]);
    await page.evaluate(() => { window.__draftVoiceFixture.finishStop(0); window.__draftVoiceFixture.finishStop(1); });
    await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(2);
    await page.evaluate(() => {
      window.__draftUploadFixture.finish(0, 'file:kept-first'); window.__draftUploadFixture.finish(1, 'file:kept-second');
    });
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
    await expect(input(page)).toBeFocused(); expect(f.sends).toHaveLength(0);
  });

  for (const destination of ['New chat', 'Open chat'] as const) {
    for (const outcome of ['attached', 'failed'] as const) {
      for (const choice of ['prompt', 'keep', 'discard'] as const) {
        test(`keeps ${choice} focused through ${outcome} voice updates before ${destination} at ${width}px`, async ({ page, browserName }) => {
          await page.setViewportSize({ width, height: 844 });
          const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': false });
          await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
          await expect(page).toHaveURL(/#chat\/new$/);
          const mic = voiceControl(page);
          await mic.click();
          await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
          await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording'); await mic.click();
          await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
          if (destination === 'Open chat') {
            // Opening another chat guards a live capture. An earlier stopped
            // note can finish and upload while that decision remains open.
            await mic.click(); await page.evaluate(() => window.__draftVoiceFixture.allow(1));
            await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
            await f.open('b');
          } else {
            await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
          }
          const guard = page.locator('[data-recued-chat-route-history-draft-guard]');
          await expect(guard).toBeFocused();
          const discardLabel = destination === 'New chat' ? 'Throw it away and start a new one' : 'Throw it away and open';
          let focused = guard;
          const buttons = choice === 'prompt' ? [] : choice === 'keep' ? ['Keep writing'] : ['Keep writing', discardLabel];
          for (const name of buttons) {
            const next = guard.getByRole('button', { name, exact: true });
            await page.keyboard.press('Tab');
            if (browserName === 'webkit' && !await next.evaluate(button => button === document.activeElement)) {
              await focused.focus(); await page.keyboard.press('Alt+Tab');
            }
            await expect(next).toBeFocused(); focused = next;
          }
          await page.evaluate(() => window.__draftVoiceFixture.finishStop(0));
          await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
          await expect(focused).toBeFocused();
          await page.evaluate(() => window.__draftUploadFixture.progress(0, 3));
          await expect(focused).toBeFocused();
          await page.evaluate(outcome => {
            if (outcome === 'attached') window.__draftUploadFixture.finish(0, 'file:guarded-note');
            else window.__draftUploadFixture.fail(0);
          }, outcome);
          await expect(page.locator(`[data-recued-chat-route-attachment="${outcome}"]`)).toHaveCount(1);
          await expect(focused).toBeFocused(); expect(f.sends).toHaveLength(0);
          const key = choice === 'prompt' || (choice === 'keep' && outcome === 'failed')
            ? 'Escape' : choice === 'discard' && outcome === 'attached' ? 'Space' : 'Enter';
          await page.keyboard.press(key);
          await expect(guard).toHaveCount(0);
          await expect(page).toHaveURL(choice === 'discard' && destination === 'Open chat' ? /#chat\/session\/b$/ : /#chat\/new$/);
          await expect(choice === 'discard' && destination === 'Open chat'
            ? page.locator('[data-recued-chat-route-thread-title]') : input(page)).toBeFocused();
          await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(choice === 'discard' ? 0 : 1);
          if (choice !== 'discard') {
            await expect(page.locator(`[data-recued-chat-route-attachment="${outcome}"]`)).toHaveCount(1);
          }
          if (destination === 'Open chat') {
            expect(await page.evaluate(() => window.__draftVoiceFixture.attempts[1]?.cancelled)).toBe(choice === 'discard');
          }
          expect(f.sends).toHaveLength(0);
        });
      }
    }
  }

  for (const choice of ['keep', 'discard'] as const) {
    test(`voice auto-send waits for ${choice} when New chat confirmation is open at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': true });
      await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
      await expect(page).toHaveURL(/#chat\/new$/);
      const mic = voiceControl(page);
      await mic.click();
      await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording'); await mic.click();
      await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
      const guard = page.locator('[data-recued-chat-route-history-draft-guard]');
      await expect(guard).toBeFocused();
      await page.evaluate(() => window.__draftVoiceFixture.finishStop(0));
      await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
      await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:finished-during-confirmation'));
      await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
      await expect(guard).toBeVisible(); expect(f.sends).toHaveLength(0);
      await expect(page).toHaveURL(/#chat\/new$/);
      await guard.getByRole('button', { name: choice === 'keep' ? 'Keep writing' : 'Throw it away and start a new one', exact: true }).click();
      await expect(guard).toHaveCount(0);
      if (choice === 'keep') {
        await expect.poll(() => f.sends.length).toBe(1);
        expect(f.sends[0]).toMatchObject({ session_id: 'draft-created', message: '',
          attachments: [{ file_id: 'file:finished-during-confirmation', media_class: 'voice' }] });
      } else {
        await expect(input(page)).toBeFocused(); await expect(page).toHaveURL(/#chat\/new$/);
        expect(f.sends).toHaveLength(0);
      }
      await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
    });
  }

  for (const outcome of ['attached', 'failed'] as const) {
    for (const action of ['cancel', 'confirm'] as const) {
      test(`keeps delete ${action} focused through ${outcome} voice updates at ${width}px`, async ({ page, browserName }) => {
        await page.setViewportSize({ width, height: 844 });
        const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': false });
        await input(page).fill('Keep this draft');
        const mic = voiceControl(page);
        await mic.click();
        await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording'); await mic.click();
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
        const sessionId = action === 'cancel' ? 'b' : 'a';
        await openChatHistory(page);
        await page.locator(`[data-recued-chat-route-session-actions="${sessionId}"] summary`).click();
        await page.locator(`[data-recued-chat-route-session-delete="${sessionId}"]`).click();
        const confirm = page.locator(`[data-recued-chat-route-session-delete-confirm="${sessionId}"]`);
        await expect(confirm).toBeFocused();
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
        if (action === 'cancel') {
          await page.keyboard.press('Shift+Tab');
          if (browserName === 'webkit' && !await cancel.evaluate(button => button === document.activeElement)) {
            await confirm.focus(); await page.keyboard.press('Alt+Shift+Tab');
          }
          await expect(cancel).toBeFocused();
        }
        const control = action === 'cancel' ? cancel : confirm;
        await page.evaluate(() => window.__draftVoiceFixture.finishStop(0));
        await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
        await expect(control).toBeFocused();
        await page.evaluate(() => window.__draftUploadFixture.progress(0, 3));
        await expect(control).toBeFocused();
        await page.evaluate(outcome => {
          if (outcome === 'attached') window.__draftUploadFixture.finish(0, 'file:delete-guard-note');
          else window.__draftUploadFixture.fail(0);
        }, outcome);
        await expect(page.locator(`[data-recued-chat-route-attachment="${outcome}"]`)).toHaveCount(outcome === 'attached' ? 2 : 1);
        await expect(control).toBeFocused(); expect(f.deletes).toEqual([]);
        if (action === 'cancel') {
          await page.keyboard.press(outcome === 'attached' ? 'Space' : 'Enter');
          await expect(confirm).toHaveCount(0);
          await expect(page.locator('[data-recued-chat-route-session-row="b"]')).toBeFocused();
          await expect(input(page)).toHaveValue('Keep this draft');
          await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(2);
          expect(f.deletes).toEqual([]);
        } else {
          f.hold('chat.session.delete');
          await page.keyboard.press(outcome === 'attached' ? 'Enter' : 'Space');
          await expect(confirm).toHaveText('Deleting…'); await expect(confirm).toBeFocused();
          await expect.poll(() => f.deletes).toEqual(['a']);
          f.release('chat.session.delete');
          await expect(page.locator('[data-recued-chat-route-session-row="a"]')).toHaveCount(0);
          await expect(page.locator('[data-recued-chat-route-history-continue="b"]')).toBeFocused();
          await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
          expect(f.deletes).toEqual(['a']);
        }
        expect(f.sends).toHaveLength(0);
      });
    }
  }

  for (const sessionId of ['a', 'b']) {
    for (const control of ['confirm', 'cancel'] as const) {
      test(`Escape cancels deletion from ${control} for chat ${sessionId} at ${width}px`, async ({ page, browserName }) => {
        await page.setViewportSize({ width, height: 844 });
        const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': false });
        await input(page).fill('Keep this draft');
        const mic = voiceControl(page);
        await mic.click();
        await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording'); await mic.click();
        await openChatHistory(page);
        await page.locator(`[data-recued-chat-route-session-actions="${sessionId}"] summary`).click();
        await page.locator(`[data-recued-chat-route-session-delete="${sessionId}"]`).click();
        const confirm = page.locator(`[data-recued-chat-route-session-delete-confirm="${sessionId}"]`);
        await expect(confirm).toBeFocused();
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
        if (control === 'cancel') {
          await page.keyboard.press('Shift+Tab');
          if (browserName === 'webkit' && !await cancel.evaluate(button => button === document.activeElement)) {
            await confirm.focus(); await page.keyboard.press('Alt+Shift+Tab');
          }
        }
        const focused = control === 'confirm' ? confirm : cancel;
        await expect(focused).toBeFocused();
        await page.evaluate(() => window.__draftVoiceFixture.finishStop(0));
        await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
        await expect(focused).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(confirm).toHaveCount(0);
        const row = page.locator(`[data-recued-chat-route-session-row="${sessionId}"]`);
        await expect(row).toBeFocused(); expect(f.deletes).toEqual([]);
        await page.evaluate(() => window.__draftUploadFixture.progress(0, 3));
        await expect(row).toBeFocused();
        await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:escape-kept-note'));
        await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
        await expect(row).toBeFocused();
        await expect(input(page)).toHaveValue('Keep this draft');
        await expect(page).toHaveURL(/#chat\/session\/a$/);
        expect(await page.evaluate(() => window.__draftVoiceFixture.attempts[0]?.cancelled)).toBe(false);
        expect(f.deletes).toEqual([]); expect(f.sends).toHaveLength(0);
      });
    }
  }

  for (const outcome of ['deleted', 'rejected'] as const) {
    test(`keeps Deleting focused through voice updates before a ${outcome === 'deleted' ? 'successful' : 'rejected'} deletion at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': false });
      await input(page).fill('Keep this draft');
      const mic = voiceControl(page);
      await mic.click();
      await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording'); await mic.click();
      const sessionId = outcome === 'deleted' ? 'b' : 'a';
      await openChatHistory(page);
      const actions = page.locator(`[data-recued-chat-route-session-actions="${sessionId}"]`);
      const remove = actions.locator(`[data-recued-chat-route-session-delete="${sessionId}"]`);
      await actions.locator('summary').click(); await remove.click();
      const confirm = page.locator(`[data-recued-chat-route-session-delete-confirm="${sessionId}"]`);
      await expect(confirm).toBeFocused();
      f.hold('chat.session.delete'); await page.keyboard.press('Enter');
      await expect(confirm).toHaveText('Deleting…'); await expect(confirm).toBeFocused();
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await expect.poll(() => f.deletes).toEqual([sessionId]);
      await page.keyboard.press('Escape');
      await expect(confirm).toHaveText('Deleting…'); await expect(confirm).toBeFocused();
      await page.evaluate(() => window.__draftVoiceFixture.finishStop(0));
      await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
      await expect(confirm).toBeFocused();
      await page.evaluate(() => window.__draftUploadFixture.progress(0, 3));
      await expect(confirm).toBeFocused();
      await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:pending-delete-note'));
      await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
      await expect(confirm).toBeFocused();
      await expect(confirm).toHaveAttribute('aria-busy', 'true');
      await expect(confirm).toHaveAttribute('aria-disabled', 'true');
      await expect(confirm).not.toHaveAttribute('disabled', '');
      await page.keyboard.press('Escape'); await expect(confirm).toBeFocused();
      await page.keyboard.press('Enter'); await page.keyboard.press('Space');
      expect(f.deletes).toEqual([sessionId]);
      if (outcome === 'rejected') f.fail.add('chat.session.delete');
      f.release('chat.session.delete'); await expect(confirm).toHaveCount(0);
      if (outcome === 'rejected') {
        await expect(page.getByRole('alert')).toContainText('Recued could not delete this chat.');
        await expect(actions).toHaveAttribute('open', ''); await expect(remove).toBeFocused();
        await expect(page.locator('[data-recued-chat-route-session-row="a"]')).toHaveCount(1);
        await page.keyboard.press('Space'); await expect(confirm).toBeFocused();
        await expect(confirm).toHaveText('Delete permanently');
        await page.keyboard.press('Escape'); await expect(confirm).toHaveCount(0);
        await expect(page.locator('[data-recued-chat-route-session-row="a"]')).toBeFocused();
        expect(f.deletes).toEqual([sessionId]);
      } else {
        await expect(page.locator('[data-recued-chat-route-session-row="b"]')).toHaveCount(0);
        await expect(page.locator('[data-recued-chat-route-history-search]')).toBeFocused();
      }
      await expect(input(page)).toHaveValue('Keep this draft');
      await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
      expect(f.sends).toHaveLength(0);
    });
  }

  test(`voice updates leave search focus alone while delete confirmation is open at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': false });
    const mic = voiceControl(page);
    await mic.click();
    await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording'); await mic.click();
    await openChatHistory(page);
    await page.locator('[data-recued-chat-route-session-actions="b"] summary').click();
    await page.locator('[data-recued-chat-route-session-delete="b"]').click();
    const search = page.locator('[data-recued-chat-route-history-search]');
    await search.fill('Conversation');
    await search.evaluate(element => (element as HTMLInputElement).setSelectionRange(1, 4));
    await page.evaluate(() => window.__draftVoiceFixture.finishStop(0));
    await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
    await expect(search).toBeFocused();
    await page.evaluate(() => window.__draftUploadFixture.progress(0, 3)); await expect(search).toBeFocused();
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:search-focused-note'));
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
    await expect(search).toBeFocused(); await expect(search).toHaveValue('Conversation');
    expect(await search.evaluate(element => {
      const field = element as HTMLInputElement; return [field.selectionStart, field.selectionEnd];
    })).toEqual([1, 4]);
    await expect(page.locator('[data-recued-chat-route-session-delete-confirm="b"]')).toBeVisible();
    expect(f.deletes).toEqual([]); expect(f.sends).toHaveLength(0);
  });

  test(`deleting a parked chat cancels all its finishing notes and preserves the current recording at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    const mic = voiceControl(page);
    for (const n of [0, 1]) {
      await mic.click();
      await page.evaluate(n => { window.__draftVoiceFixture.allow(n); window.__draftVoiceFixture.holdStop(n); }, n);
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
      await mic.click();
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    }
    await f.open('b'); await expect(page).toHaveURL(/#chat\/session\/b$/);
    await input(page).fill('Keep the current draft');
    await mic.click(); await page.evaluate(() => window.__draftVoiceFixture.allow(2));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await openChatHistory(page);
    await page.locator('[data-recued-chat-route-session-actions="a"] summary').click();
    await page.locator('[data-recued-chat-route-session-delete="a"]').click();
    await page.locator('[data-recued-chat-route-session-delete-confirm="a"]').click();
    await expect(page.locator('[data-recued-chat-route-session-row="a"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__draftVoiceFixture.attempts.map(attempt => attempt.cancelled)))
      .toEqual([true, true, false]);
    await page.evaluate(() => {
      window.__draftVoiceFixture.finishStop(0); window.__draftVoiceFixture.failStop(1);
      window.__draftVoiceFixture.fail(0); window.__draftVoiceFixture.fail(1);
    });
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(0);
    await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
    const backToChat = page.getByRole('button', { name: 'Back to chat', exact: true });
    if (await backToChat.isVisible()) await backToChat.click();
    await mic.click();
    await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:current-note'));
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
    await expect(input(page)).toHaveValue('Keep the current draft');
    expect(f.sends).toHaveLength(0);
  });

  for (const outcome of ['allow', 'refuse'] as const) {
    test(`cancels pending voice requests before late ${outcome} at ${width}px`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: 844 });
      const f = await setup(page, 'direct', true);
      await input(page).fill('Keep this typed request');
      const mic = voiceControl(page);
      await mic.focus(); await page.keyboard.press('Enter');
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'opening');
      await expect(mic).toHaveAttribute('aria-disabled', 'true');
      const cancel = page.getByRole('button', { name: 'Cancel recording request', exact: true });
      await expect(cancel).toBeVisible();
      await expect(cancel).toHaveText('Cancel');
      await expect(cancel).toBeEnabled();
      await tabToVoiceDismiss(page, browserName, 'Cancel recording request');
      await page.evaluate(() => window.__refreshChatDrafts());
      await expect(cancel).toBeFocused();
      await page.keyboard.press('Space');
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
      await expect(mic).toHaveAccessibleName('Record a voice note');
      await expect(mic).toBeFocused();
      await expect(cancel).toHaveCount(0);
      await expect(input(page)).toHaveValue('Keep this typed request');
      await expect(page.getByText('Quote.pdf', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
      expect(f.sends).toHaveLength(0);

      await page.keyboard.press('Enter');
      await page.evaluate(() => window.__draftVoiceFixture.allow(1));
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
      await page.evaluate(method => window.__draftVoiceFixture[method](0), outcome);
      await page.evaluate(() => window.__draftVoiceFixture.fail(0));
      if (outcome === 'allow') {
        await expect.poll(() => page.evaluate(() => window.__draftVoiceFixture.attempts[0]?.cancelled)).toBe(true);
      }
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
      await expect(mic).toBeFocused();
      await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(0);
      await expect(input(page)).toHaveValue('Keep this typed request');
      expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
      await page.keyboard.press('Space');
      await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
      await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:retry-voice'));
      await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
      expect(await page.evaluate(() => window.__draftVoiceFixture.attempts)).toEqual([
        { stopped: false, cancelled: outcome === 'allow' }, { stopped: true, cancelled: false },
      ]);
      expect(f.sends).toHaveLength(0);
    });
  }

  for (const autoSend of [false, true]) {
    test(`voice Stop label and send follow auto-send=${autoSend} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': autoSend });
      await page.getByRole('button', { name: 'Remove Quote.pdf', exact: true }).click();
      const mic = voiceControl(page);
      await mic.focus(); await page.keyboard.press('Enter');
      await expect(mic).toHaveAccessibleName('Waiting for you to allow the microphone');
      await page.evaluate(() => window.__draftVoiceFixture.allow(0));
      await expect(mic).toHaveAccessibleName(autoSend ? 'Stop recording and send' : 'Stop recording and attach');
      await expect(mic).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
      expect(f.sends).toHaveLength(0);
      await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:voice'));
      if (!autoSend) {
        await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toContainText('Voice.webm');
        const send = page.locator('[data-recued-chat-route-send]');
        await expect(send).toBeEnabled();
        expect(f.sends).toHaveLength(0);
        await send.click();
      }
      await expect.poll(() => f.sends.length).toBe(1);
      expect(f.sends[0]).toMatchObject({
        session_id: 'a', message: '', attachments: [{ file_id: 'file:voice', media_class: 'voice' }],
      });
    });

    test(`voice Stop label follows edits with auto-send=${autoSend} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const f = await setup(page, 'direct', true, { 'ui.voice.auto_send': autoSend });
      await page.getByRole('button', { name: 'Remove Quote.pdf', exact: true }).click();
      const mic = voiceControl(page);
      await mic.click();
      await page.evaluate(() => window.__draftVoiceFixture.allow(0));
      const emptyLabel = autoSend ? 'Stop recording and send' : 'Stop recording and attach';
      await expect(mic).toHaveAccessibleName(emptyLabel);
      const originalInput = (await input(page).elementHandle())!;
      const originalMic = (await mic.elementHandle())!;
      const expectDraft = async (text: string, caret: number) => {
        await expect(input(page)).toHaveValue(text);
        await expect(input(page)).toBeFocused();
        expect(await originalInput.evaluate(field => field.isConnected)).toBe(true);
        expect(await originalMic.evaluate(button => button.isConnected)).toBe(true);
        expect(await input(page).evaluate(element => {
          const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd];
        })).toEqual([caret, caret]);
      };
      await input(page).focus();
      await page.keyboard.type('draft');
      await expect(mic).toHaveAccessibleName('Stop recording and attach');
      await expectDraft('draft', 5);
      await input(page).evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(1, 4));
      await page.keyboard.insertText('X');
      await expect(mic).toHaveAccessibleName('Stop recording and attach');
      await expectDraft('dXt', 2);
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
      await expect(mic).toHaveAccessibleName(emptyLabel);
      await expectDraft('', 0);
      await page.keyboard.type('  ');
      await expect(mic).toHaveAccessibleName(emptyLabel);
      await expectDraft('  ', 2);
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
      await expect(mic).toHaveAccessibleName(emptyLabel);
      await expectDraft('', 0);
      await mic.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
      expect(f.sends).toHaveLength(0);
      await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:edited-voice'));
      if (!autoSend) await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toContainText('Voice.webm');
      await expect.poll(() => f.sends.length).toBe(autoSend ? 1 : 0);
    });
  }

  test(`clears voice feedback only when a conversation switch succeeds at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    const error = page.locator('[data-recued-chat-route-voice-error]');
    await input(page).fill('Keep the original draft');
    await voiceControl(page).click();
    await page.evaluate(() => window.__draftVoiceFixture.refuse(0));
    await expect(error).toContainText('permission was refused');
    f.fail.add('open:b');
    await f.open('b');
    await expect(page.getByText('The fixture connection was interrupted.', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#chat\/session\/a$/);
    await expect(input(page)).toHaveValue('Keep the original draft');
    await expect(error).toContainText('permission was refused');

    await f.open('b'); await expect(page).toHaveURL(/#chat\/session\/b$/);
    await expect(error).toHaveCount(0);
    await f.open('a'); await expect(page).toHaveURL(/#chat\/session\/a$/);
    await expect(input(page)).toHaveValue('Keep the original draft');
    await expect(error).toHaveCount(0);
    await voiceControl(page).click();
    await page.evaluate(() => window.__draftVoiceFixture.allow(1));
    await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await page.evaluate(() => window.__draftVoiceFixture.fail(1));
    await expect(error).toContainText('Try recording again');
    await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
    await expect(page).toHaveURL(/#chat\/new$/);
    await expect(error).toHaveCount(0);
    await voiceControl(page).click();
    await page.evaluate(() => window.__draftVoiceFixture.refuse(2));
    await expect(error).toContainText('permission was refused');
    await f.open('a'); await expect(page).toHaveURL(/#chat\/session\/a$/);
    await expect(input(page)).toHaveValue('Keep the original draft');
    await expect(error).toHaveCount(0);
    expect(f.sends).toHaveLength(0);
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
  });

  test(`clears an interruption that arrives during a conversation switch at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    const error = page.locator('[data-recued-chat-route-voice-error]');
    await input(page).fill('Original draft');
    await voiceControl(page).click();
    await page.evaluate(() => window.__draftVoiceFixture.allow(0));
    await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    f.hold('open:b');
    await f.open('b');
    await page.getByRole('button', { name: 'Throw it away and open', exact: true }).click();
    await page.evaluate(() => window.__draftVoiceFixture.fail(0));
    await expect(error).toContainText('Try recording again');
    await expect(page).toHaveURL(/#chat\/session\/a$/);
    f.release('open:b');
    await expect(page).toHaveURL(/#chat\/session\/b$/);
    await expect(error).toHaveCount(0);
    await page.evaluate(() => window.__draftVoiceFixture.fail(0));
    await expect(error).toHaveCount(0);
    await voiceControl(page).click();
    await page.evaluate(() => window.__draftVoiceFixture.allow(1));
    await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await page.evaluate(() => window.__draftVoiceFixture.fail(1));
    await expect(error).toContainText('Try recording again');
    expect(f.sends).toHaveLength(0);
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
  });

  test(`retires late Stop failures but keeps successful audio with its original draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    const error = page.locator('[data-recued-chat-route-voice-error]');
    await input(page).fill('Keep a');
    await voiceControl(page).click();
    await page.evaluate(() => { window.__draftVoiceFixture.allow(0); window.__draftVoiceFixture.holdStop(0); });
    await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await voiceControl(page).click();
    await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await f.open('b'); await expect(page).toHaveURL(/#chat\/session\/b$/);
    await input(page).fill('Keep b');
    await page.evaluate(() => window.__draftVoiceFixture.failStop(0));
    await expect.poll(() => page.evaluate(() => window.__draftVoiceFixture.attempts[0]?.cancelled)).toBe(true);
    await expect(error).toHaveCount(0);
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('Keep b');
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);

    await f.open('a'); await expect(page).toHaveURL(/#chat\/session\/a$/);
    await expect(input(page)).toHaveValue('Keep a');
    await voiceControl(page).click();
    await page.evaluate(() => { window.__draftVoiceFixture.allow(1); window.__draftVoiceFixture.holdStop(1); });
    await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await voiceControl(page).click();
    await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await f.open('b'); await expect(page).toHaveURL(/#chat\/session\/b$/);
    await input(page).focus();
    await input(page).evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(1, 4));
    await page.evaluate(() => window.__draftVoiceFixture.finishStop(1));
    await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:parked-voice'));
    await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate(element => {
      const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd];
    })).toEqual([1, 4]);
    await expect(input(page)).toHaveValue('Keep b');
    await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
    await expect(error).toHaveCount(0);
    await f.open('a'); await expect(page).toHaveURL(/#chat\/session\/a$/);
    await expect(input(page)).toHaveValue('Keep a');
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
    await expect(page.getByText('Voice.webm', { exact: true })).toBeVisible();
    await expect(error).toHaveCount(0);
    expect(f.sends).toHaveLength(0);
  });

  test(`keeps voice control focused through permission, Stop and discard at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    await input(page).fill('Keep this typed request');
    const mic = voiceControl(page);
    await mic.focus(); await page.keyboard.press('Enter');
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'opening');
    await expect(mic).toBeFocused();
    await expect(mic).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.__draftVoiceFixture.attempts.length)).toBe(1);
    await tabToVoiceDismiss(page, browserName, 'Cancel recording request');
    await page.evaluate(() => window.__draftVoiceFixture.allow(0));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await expect(mic).toHaveAccessibleName('Stop recording and attach');
    await expect(page.getByRole('button', { name: 'Discard recording', exact: true })).toBeFocused();
    await mic.focus();
    await expect(mic).toBeFocused();
    await page.evaluate(() => window.__refreshChatDrafts());
    await expect(mic).toBeFocused();
    await page.keyboard.press('Space');
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await expect(mic).toBeFocused();
    await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:voice'));
    await expect(mic).toBeFocused();

    await page.keyboard.press('Enter');
    await page.evaluate(() => window.__draftVoiceFixture.allow(1));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    const discard = await tabToVoiceDismiss(page, browserName);
    await page.evaluate(() => window.__refreshChatDrafts());
    await expect(discard).toBeFocused();
    await page.keyboard.press('Space');
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await expect(mic).toBeFocused();
    expect(await page.evaluate(() => window.__draftVoiceFixture.attempts)).toEqual([
      { stopped: true, cancelled: false }, { stopped: false, cancelled: true },
    ]);
    await expect(input(page)).toHaveValue('Keep this typed request');
    expect(f.sends).toHaveLength(0);
  });

  test(`keeps voice controls focused after denial and interruption at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    const mic = voiceControl(page);
    await mic.focus(); await page.keyboard.press('Enter');
    await page.evaluate(() => window.__draftVoiceFixture.refuse(0));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await expect(mic).toBeFocused();
    await expect(page.locator('[data-recued-chat-route-voice-error]')).toContainText('permission was refused');
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.__draftVoiceFixture.allow(1));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await tabToVoiceDismiss(page, browserName);
    await page.evaluate(() => window.__draftVoiceFixture.fail(1));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await expect(mic).toBeFocused();
    await expect(page.locator('[data-recued-chat-route-voice-error]')).toContainText('Try recording again');
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.__draftVoiceFixture.allow(2));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await page.evaluate(() => window.__draftVoiceFixture.fail(1));
    await expect(mic).toBeFocused();
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(0);
    expect(f.sends).toHaveLength(0);
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
  });

  test(`voice changes preserve the typing caret and preview focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page, 'direct', true);
    await input(page).fill('Keep this typed request');
    const mic = voiceControl(page);
    await mic.focus(); await page.keyboard.press('Enter');
    await input(page).focus();
    await input(page).evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 8));
    await page.evaluate(() => window.__draftVoiceFixture.allow(0));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate(element => {
      const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd];
    })).toEqual([2, 8]);
    await page.evaluate(() => window.__draftVoiceFixture.fail(0));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate(element => {
      const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd];
    })).toEqual([2, 8]);

    await mic.focus(); await page.keyboard.press('Enter');
    const preview = page.getByRole('button', { name: 'Preview Quote.pdf', exact: true });
    await preview.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'File preview', exact: true });
    const close = dialog.getByRole('button', { name: 'Close preview', exact: true });
    await expect(close).toBeFocused();
    await page.evaluate(() => window.__draftVoiceFixture.allow(1));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
    await expect(close).toBeFocused();
    await page.evaluate(() => window.__draftVoiceFixture.fail(1));
    await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(preview).toBeFocused();
    await expect(input(page)).toHaveValue('Keep this typed request');
    expect(f.sends).toHaveLength(0);
  });

  for (const navigation of ['switch', 'repair'] as const) {
    test(`late voice permission cannot reclaim focus after ${navigation} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const f = await setup(page, 'direct', true);
      await input(page).fill('Keep the original draft');
      await voiceControl(page).focus(); await page.keyboard.press('Enter');
      if (navigation === 'switch') {
        await f.open('b');
        await page.getByRole('button', { name: 'Throw it away and open', exact: true }).click();
        await expect(page).toHaveURL(/#chat\/session\/b$/);
      } else await page.evaluate(() => window.__repairChatDrafts());
      await input(page).fill('Continue here');
      await page.evaluate(() => window.__draftVoiceFixture.allow(0));
      await page.evaluate(() => window.__draftVoiceFixture.fail(0));
      await expect(input(page)).toBeFocused();
      await expect(input(page)).toHaveValue('Continue here');
      await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'idle');
      await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(0);
      expect(await page.evaluate(() => window.__draftVoiceFixture.attempts[0]?.cancelled)).toBe(true);
      expect(f.sends).toHaveLength(0);
    });
  }

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
    await f.open('a'); await expect(input(page)).toHaveValue('First draft');
    await page.locator('[data-recued-chat-route-send]').click();
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
  await f.open('b'); await expect(input(page)).toHaveValue(''); await input(page).fill('Keep b');
  f.release('chat.send');
  await f.open('a'); await expect(input(page)).toHaveValue('');
  await expect(page.getByText('Quote.pdf', { exact: true })).toHaveCount(0);
  await f.open('b'); await expect(input(page)).toHaveValue('Keep b');
});

for (const width of [1280, 390]) {
  test(`pairing remount retains all drafts and exact file selections at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page);
    await input(page).fill('Keep a');
    await page.locator('[data-chat-reply-action="question-a"]').click();
    await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
    await input(page).fill('Keep the new chat');
    await f.open('b'); await expect(input(page)).toHaveValue(''); await input(page).fill('Keep b');
    await page.evaluate(() => window.__repairChatDrafts());
    await page.evaluate(() => window.__repairChatDrafts());
    await expect(input(page)).toHaveValue('Keep b');
    await f.open('a'); await expect(input(page)).toHaveValue('Keep a');
    await expect(page.locator('[data-chat-reply-draft="question-a"]')).toBeVisible();
    await expect(page.getByText('Quote.pdf', { exact: true })).toBeVisible();
    await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
    await expect(input(page)).toHaveValue('Keep the new chat');
    expect(f.sends).toHaveLength(0);
  });
}

for (const width of [1280, 390]) {
  test(`interrupted uploads survive repair and explicit file picking stays with its chat at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page);
    const filename = 'Customer proposal needing a fresh file selection.pdf';
    await input(page).fill('Keep this file with a');
    await page.locator('[data-recued-chat-route-attach-input]').setInputFiles({
      name: filename, mimeType: 'application/pdf', buffer: Buffer.from('fixture bytes'),
    });
    await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
    await f.open('b'); await expect(input(page)).toHaveValue(''); await input(page).fill('Keep b');
    await page.evaluate(() => window.__repairChatDrafts());
    await page.evaluate(() => window.__repairChatDrafts());
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts)).toEqual([
      expect.objectContaining({ filename, destroyed: true }),
    ]);
    await f.open('a'); await expect(input(page)).toHaveValue('Keep this file with a');
    const chip = page.locator('[data-recued-chat-route-attachment="needs-file"]');
    await expect(chip).toContainText(filename);
    await expect(chip).toContainText('Upload interrupted.');
    const send = page.locator('[data-recued-chat-route-send]');
    await expect(send).toBeDisabled();
    expect(f.sends).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    // Cancelling the native picker keeps the reminder. Keyboard activation
    // then picks a file after navigating away; it must replace a's own row.
    const retry = page.getByRole('button', { name: `Choose ${filename} again`, exact: true });
    let chooserEvent = page.waitForEvent('filechooser');
    await retry.click(); await (await chooserEvent).setFiles([]);
    await expect(chip).toHaveCount(1); await expect(send).toBeDisabled();
    chooserEvent = page.waitForEvent('filechooser');
    await retry.focus(); await page.keyboard.press('Enter');
    const chooser = await chooserEvent;
    await f.open('b'); await expect(input(page)).toHaveValue('Keep b');
    await chooser.setFiles({ name: filename, mimeType: 'application/pdf', buffer: Buffer.from('chosen bytes') });
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(2);
    await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:retired'));
    await f.open('a'); await expect(input(page)).toHaveValue('Keep this file with a');
    await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
    await expect(send).toBeDisabled();
    await page.evaluate(() => window.__draftUploadFixture.finish(1, 'file:chosen'));
    await expect(page.locator('[data-recued-chat-route-attachment="needs-file"]')).toHaveCount(0);
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(2);
    await expect(send).toBeEnabled(); expect(f.sends).toHaveLength(0);
    await send.click();
    await expect(input(page)).toHaveValue('');
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ session_id: 'a', attachments: [
      { file_id: selected.file_id, selection_revision: selected.selection_revision }, { file_id: 'file:chosen' },
    ] });
    await f.open('b'); await expect(input(page)).toHaveValue('Keep b');
  });
}


const openNativePicker = async (page: Page, menu = false) => {
  const pending = page.waitForEvent('filechooser');
  const attach = page.getByRole('button', { name: 'Attach a file', exact: true });
  if (menu) {
    await attach.click();
    const upload = page.getByRole('button', { name: 'Upload files', exact: true });
    await upload.focus(); await page.keyboard.press('Enter');
  } else {
    await attach.focus(); await page.keyboard.press('Enter');
  }
  return pending;
};

for (const width of [1280, 390]) {
  test(`normal file selection stays with its originating chat and preserves current focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const menu = width === 390;
    const f = await setup(page, menu ? 'menu' : 'direct');
    await input(page).fill('Keep a');
    await (await openNativePicker(page, menu)).setFiles([]);
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
    const chooser = await openNativePicker(page, menu);
    await f.open('b'); await expect(input(page)).toHaveValue(''); await input(page).fill('Keep b');
    await chooser.setFiles([
      { name: 'First.pdf', mimeType: 'application/pdf', buffer: Buffer.from('first fixture') },
      { name: 'Second.pdf', mimeType: 'application/pdf', buffer: Buffer.from('second fixture') },
    ]);
    await expect(input(page)).toHaveValue('Keep b'); await expect(input(page)).toBeFocused();
    await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__draftUploadFixture.attempts.map(attempt => attempt.filename)))
      .toEqual(['First.pdf', 'Second.pdf']);
    await openChatHistory(page);
    await expect(page.locator('[data-recued-chat-route-session-row="a"] [data-chat-session-draft]')).toBeVisible();
    await page.evaluate(() => {
      window.__draftUploadFixture.finish(0, 'file:first'); window.__draftUploadFixture.finish(1, 'file:second');
    });
    await f.open('a'); await expect(input(page)).toHaveValue('Keep a');
    await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(3);
    await expect(page.getByText('First.pdf', { exact: true })).toBeVisible();
    await expect(page.getByText('Second.pdf', { exact: true })).toBeVisible();
    await f.open('b'); await expect(input(page)).toHaveValue('Keep b');
    expect(f.sends).toHaveLength(0);
  });
}

test('a discarded new draft ignores its outstanding native picker and the new picker still works', async ({ page }) => {
  const f = await setup(page);
  await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
  await input(page).fill('Discard this new draft');
  const chooser = await openNativePicker(page);
  await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
  await page.getByRole('button', { name: 'Throw it away and start a new one', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  await chooser.setFiles({ name: 'Retired.pdf', mimeType: 'application/pdf', buffer: Buffer.from('retired') });
  expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
  await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
  await (await openNativePicker(page)).setFiles({ name: 'Current.pdf', mimeType: 'application/pdf', buffer: Buffer.from('current') });
  await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toContainText('Current.pdf');
  expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
  expect(f.sends).toHaveLength(0);
});

test('a native picker returning after pairing teardown cannot start an upload on the retired route', async ({ page }) => {
  const f = await setup(page);
  const chooser = await openNativePicker(page);
  await page.evaluate(() => window.__repairChatDrafts());
  await chooser.setFiles({ name: 'Old-mount.pdf', mimeType: 'application/pdf', buffer: Buffer.from('old mount') });
  expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
  await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
  await expect(page.getByText('Old-mount.pdf', { exact: true })).toHaveCount(0);
  expect(f.sends).toHaveLength(0);
});

test('deleting the parked source conversation invalidates its outstanding native picker', async ({ page }) => {
  const f = await setup(page);
  const chooser = await openNativePicker(page);
  await f.open('b'); await expect(input(page)).toHaveValue('');
  await openChatHistory(page);
  await page.locator('[data-recued-chat-route-session-actions="a"] summary').click();
  await page.locator('[data-recued-chat-route-session-delete="a"]').click();
  await page.locator('[data-recued-chat-route-session-delete-confirm="a"]').click();
  await expect(page.locator('[data-recued-chat-route-session-row="a"]')).toHaveCount(0);
  await chooser.setFiles({ name: 'Deleted-chat.pdf', mimeType: 'application/pdf', buffer: Buffer.from('deleted chat') });
  expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
  await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
  expect(f.sends).toHaveLength(0);
});


for (const width of [1280, 390]) {
  test(`keeps attachment controls focused through progress and refresh at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page);
    await page.locator('[data-recued-chat-route-attach-input]').setInputFiles([
      { name: 'Shared.pdf', mimeType: 'application/pdf', buffer: Buffer.from('first') },
      { name: 'Shared.pdf', mimeType: 'application/pdf', buffer: Buffer.from('second') },
    ]);
    const attach = page.getByRole('button', { name: 'Attach a file', exact: true });
    await attach.focus();
    await page.evaluate(() => window.__draftUploadFixture.progress(0, 1));
    await expect(attach).toBeFocused();
    const preview = page.getByRole('button', { name: 'Preview Quote.pdf', exact: true });
    await preview.focus();
    await page.evaluate(() => window.__draftUploadFixture.progress(0, 2));
    await expect(preview).toBeFocused();
    const secondRemove = page.getByRole('button', { name: 'Remove Shared.pdf', exact: true }).nth(1);
    const secondId = await secondRemove.getAttribute('data-recued-chat-route-attachment-remove');
    await secondRemove.focus();
    await page.evaluate(() => window.__draftUploadFixture.fail(1));
    await expect(page.locator(`[data-recued-chat-route-attachment-remove="${secondId}"]`)).toBeFocused();
    const retry = page.getByRole('button', { name: 'Choose Shared.pdf again', exact: true });
    await retry.focus();
    await page.evaluate(() => window.__draftUploadFixture.progress(0, 3));
    await expect(retry).toBeFocused();
    await page.evaluate(() => window.__refreshChatDrafts());
    await expect(retry).toBeFocused();
    await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:first'));
    await expect(retry).toBeFocused();
    const chooserEvent = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooserEvent).setFiles({ name: 'Shared.pdf', mimeType: 'application/pdf', buffer: Buffer.from('retry') });
    await expect(input(page)).toBeFocused();
    await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
    expect(f.sends).toHaveLength(0);
  });

  test(`keeps the attach menu and its keyboard target through redraws at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, 'menu');
    await page.locator('[data-recued-chat-route-attach-input]').setInputFiles({ name: 'Progress.pdf', mimeType: 'application/pdf', buffer: Buffer.from('progress') });
    const attach = page.getByRole('button', { name: 'Attach a file', exact: true });
    await attach.click();
    const choose = page.getByRole('button', { name: 'Choose from Files', exact: true });
    await expect(choose).toBeFocused();
    await page.evaluate(() => window.__draftUploadFixture.progress(0, 1));
    await expect(choose).toBeFocused(); await expect(attach).toHaveAttribute('aria-expanded', 'true');
    const upload = page.getByRole('button', { name: 'Upload files', exact: true });
    await upload.focus();
    await page.evaluate(() => window.__refreshChatDrafts());
    await expect(upload).toBeFocused(); await expect(attach).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(attach).toBeFocused(); await expect(attach).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => window.__draftUploadFixture.progress(0, 2));
    await expect(attach).toBeFocused(); await expect(upload).toBeHidden();
  });

  test(`removing attachments moves focus by stable row order at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page);
    await page.locator('[data-recued-chat-route-attach-input]').setInputFiles([
      { name: 'Shared.pdf', mimeType: 'application/pdf', buffer: Buffer.from('first') },
      { name: 'Shared.pdf', mimeType: 'application/pdf', buffer: Buffer.from('second') },
      { name: 'Last.pdf', mimeType: 'application/pdf', buffer: Buffer.from('last') },
    ]);
    await page.getByRole('button', { name: 'Remove Shared.pdf', exact: true }).nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Remove Last.pdf', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Remove Shared.pdf', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Remove Quote.pdf', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Attach a file', exact: true })).toBeFocused();
    await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
    expect(f.sends).toHaveLength(0);
  });

  test(`preview return focus survives redraws without escaping the modal or a repair at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page);
    await page.locator('[data-recued-chat-route-attach-input]').setInputFiles({ name: 'Progress.pdf', mimeType: 'application/pdf', buffer: Buffer.from('progress') });
    const preview = page.getByRole('button', { name: 'Preview Quote.pdf', exact: true });
    await preview.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'File preview', exact: true });
    const close = dialog.getByRole('button', { name: 'Close preview', exact: true });
    await expect(close).toBeFocused();
    await page.evaluate(() => window.__draftUploadFixture.progress(0, 2));
    await expect(close).toBeFocused();
    await page.evaluate(() => window.__refreshChatDrafts());
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(preview).toBeFocused();
    await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
    await page.evaluate(() => window.__repairChatDrafts());
    await expect(dialog).toHaveCount(0); await expect(input(page)).toBeFocused();
    expect(f.sends).toHaveLength(0);
  });

  test(`closing a preview after send acceptance returns to an available control at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await setup(page); await input(page).fill('Send the selected file');
    f.hold('chat.send'); await page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.sends.length).toBe(1);
    await page.getByRole('button', { name: 'Preview Quote.pdf', exact: true }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'File preview', exact: true });
    await expect(dialog.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused();
    f.release('chat.send');
    await expect(input(page)).toHaveValue('');
    await expect(page.locator('[data-recued-chat-route-attachments]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Attach a file', exact: true })).toBeFocused();
    expect(f.sends).toHaveLength(1);
  });
}

test.describe('voice capture in the full-app leave guards', () => {
  let shellBundle: string;
  const pageErrors: Error[] = [];
  test.beforeAll(async () => {
    const result = await build({
      entryPoints: [resolve(root, 'apps/webclient/e2e/harness/full-app-harness.ts')],
      plugins: [uploadFixturePlugin],
      bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
      resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
      tsconfig: resolve(root, 'apps/webclient/tsconfig.json'), logLevel: 'silent',
    });
    shellBundle = result.outputFiles[0]!.text;
  });
  test.beforeEach(({ page }) => {
    pageErrors.length = 0;
    page.on('pageerror', error => pageErrors.push(error));
  });
  test.afterEach(() => expect(pageErrors, 'uncaught full-app errors').toEqual([]));

  // The real shell, route and browser capture adapter use fixture-owned device
  // primitives. No native microphone permission, hardware or provider is used.
  const bootShell = async (page: Page) => {
    await page.addInitScript(() => {
      type Attempt = { granted: boolean; started: boolean; stopped: boolean };
      const attempts: Attempt[] = [];
      const controls: Array<{ allow(): void; refuse(): void }> = [];
      const recorders = new Map<Attempt, Recorder>();
      class Track extends EventTarget {
        readyState = 'live';
        attempt: Attempt;
        constructor(attempt: Attempt) { super(); this.attempt = attempt; }
        stop() { this.readyState = 'ended'; this.attempt.stopped = true; }
      }
      class Recorder {
        static isTypeSupported() { return true; }
        attempt: Attempt;
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        onerror: (() => void) | null = null;
        holdStop = false;
        constructor(stream: { attempt: Attempt }) {
          this.attempt = stream.attempt; recorders.set(this.attempt, this);
        }
        start() { this.attempt.started = true; }
        finish(empty = false) {
          this.ondataavailable?.({ data: new Blob(empty ? [] : ['voice']) }); this.onstop?.();
        }
        stop() { if (!this.holdStop) this.finish(); }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Recorder });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: () => new Promise((resolve, reject) => {
          const attempt = { granted: false, started: false, stopped: false }; attempts.push(attempt);
          controls.push({
            allow: () => { attempt.granted = true; resolve({ attempt, getTracks: () => [new Track(attempt)] }); },
            refuse: () => reject(Object.assign(new Error('Microphone refused'), { name: 'NotAllowedError' })),
          });
        }),
      } });
      window.__voiceLeaveFixture = { attempts,
        allow: n => controls[n]!.allow(), refuse: n => controls[n]!.refuse(),
        holdStop: n => { recorders.get(attempts[n]!)!.holdStop = true; },
        finishStop: (n, empty) => recorders.get(attempts[n]!)!.finish(empty),
        failStop: n => recorders.get(attempts[n]!)!.onerror?.() };
    });
    await page.route('**/full-app-harness.js', route => route.fulfill({ contentType: 'text/javascript', body: shellBundle }));
    await page.route('**/tokens.css', route => route.fulfill({ contentType: 'text/css', body: tokens }));
    await page.goto(`${origin}/full-app-harness.html?chat=session&ai_transcription=configured#chat/session/chat_1`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(voiceControl(page)).toHaveAttribute('data-recued-chat-route-voice', 'idle');
  };
  const unloadIsAllowed = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
  const leaveChat = async (page: Page, accept: boolean) => {
    const dialogReady = page.waitForEvent('dialog', { timeout: 5000 });
    const navigation = page.evaluate(() => window.__app.setHash('#reception'));
    const dialog = await dialogReady;
    const message = dialog.message();
    if (accept) await dialog.accept(); else await dialog.dismiss();
    await navigation;
    return message;
  };

  for (const width of [1280, 390]) {
    test(`releases every discarded draft recorder while preserving parked audio at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await bootShell(page);
      const mic = voiceControl(page);
      await mic.click(); await page.evaluate(() => window.__voiceLeaveFixture.allow(0));
      await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
      await page.evaluate(() => window.__voiceLeaveFixture.holdStop(0)); await mic.click();
      await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
      await expect(input(page)).toHaveValue('');
      for (const n of [1, 2]) {
        await mic.click(); await page.evaluate(n => window.__voiceLeaveFixture.allow(n), n);
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
        await page.evaluate(n => window.__voiceLeaveFixture.holdStop(n), n); await mic.click();
      }
      await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click();
      await expect(page.locator('[data-recued-chat-route-history-draft-guard]')).toBeVisible();
      await page.getByRole('button', { name: 'Throw it away and start a new one', exact: true }).click();
      expect(await page.evaluate(() => window.__voiceLeaveFixture.attempts.map(attempt => attempt.stopped)))
        .toEqual([false, true, true]);
      await page.evaluate(() => { window.__voiceLeaveFixture.finishStop(1); window.__voiceLeaveFixture.failStop(2); });
      await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(0);
      await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
      expect(await page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(0);
      await page.evaluate(() => window.__voiceLeaveFixture.finishStop(0));
      await expect.poll(() => page.evaluate(() => window.__draftUploadFixture.attempts.length)).toBe(1);
      expect(await page.evaluate(() => window.__voiceLeaveFixture.attempts[0]?.stopped)).toBe(true);
      expect(await unloadIsAllowed(page)).toBe(false);
      await openChatHistory(page); await page.locator('[data-recued-chat-route-session-row="chat_1"]').click();
      await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
      await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:parked-note'));
      await expect(page.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
      expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
    });

    for (const outcome of ['audio', 'empty', 'failure'] as const) {
      test(`protects a stopped recording until ${outcome} settles at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await bootShell(page);
        const mic = voiceControl(page);
        await mic.click(); await page.evaluate(() => window.__voiceLeaveFixture.allow(0));
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
        await page.evaluate(() => window.__voiceLeaveFixture.holdStop(0));
        await mic.click();
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
        await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
        expect(await unloadIsAllowed(page)).toBe(false);
        expect(await leaveChat(page, false)).toBe('Discard unfinished voice notes and leave Chat?');
        expect(await page.evaluate(() => window.__voiceLeaveFixture.attempts[0]?.stopped)).toBe(false);
        await expect(page).toHaveURL(/#chat\/session\/chat_1$/);

        if (outcome === 'failure') await page.evaluate(() => window.__voiceLeaveFixture.failStop(0));
        else await page.evaluate(empty => window.__voiceLeaveFixture.finishStop(0, empty), outcome === 'empty');
        await expect.poll(() => page.evaluate(() => window.__voiceLeaveFixture.attempts[0]?.stopped)).toBe(true);
        if (outcome === 'audio') {
          await expect(page.locator('[data-recued-chat-route-attachment="uploading"]')).toHaveCount(1);
          expect(await unloadIsAllowed(page)).toBe(false);
          expect(await leaveChat(page, false)).toBe('Discard unsaved changes?');
          await page.evaluate(() => window.__draftUploadFixture.finish(0, 'file:finished-note'));
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(1);
          await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
        } else {
          await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(outcome === 'failure' ? 1 : 0);
          expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
        }
        await expect.poll(() => unloadIsAllowed(page)).toBe(true);
      });
    }

    test(`cancels finishing recordings when route leave is confirmed at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await bootShell(page);
      const mic = voiceControl(page);
      // Both stopped sessions still own a device; teardown must cancel all of
      // them, including the one superseded by the second press.
      for (const n of [0, 1]) {
        await mic.click(); await page.evaluate(n => window.__voiceLeaveFixture.allow(n), n);
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'recording');
        await page.evaluate(n => window.__voiceLeaveFixture.holdStop(n), n);
        await mic.click();
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
      }
      expect(await leaveChat(page, true)).toBe('Discard unfinished voice notes and leave Chat?');
      expect(await page.evaluate(() => window.__app.activeRoute())).toBe('reception');
      expect(await page.evaluate(() => window.__voiceLeaveFixture.attempts.every(attempt => attempt.stopped))).toBe(true);
      await page.evaluate(() => {
        window.__voiceLeaveFixture.finishStop(0); window.__voiceLeaveFixture.failStop(1);
      });
      await expect(page.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
      await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(0);
      expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
      expect(await unloadIsAllowed(page)).toBe(true);
    });

    for (const phase of ['opening', 'recording'] as const) {
      const prompt = phase === 'opening'
        ? 'Cancel this microphone request and leave Chat?'
        : 'Discard this voice recording and leave Chat?';
      test(`guards ${phase} capture on reload and cross-route leave at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await bootShell(page);
        expect(await unloadIsAllowed(page)).toBe(true);
        const mic = voiceControl(page);
        await mic.focus(); await page.keyboard.press('Enter');
        if (phase === 'recording') await page.evaluate(() => window.__voiceLeaveFixture.allow(0));
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', phase);
        expect(await unloadIsAllowed(page)).toBe(false);
        expect(await leaveChat(page, false)).toBe(prompt);
        await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
        expect(await page.evaluate(() => window.__app.activeRoute())).toBe('chat');
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', phase);
        expect(await page.evaluate(() => window.__voiceLeaveFixture.attempts[0]?.stopped)).toBe(false);
        expect(await unloadIsAllowed(page)).toBe(false);
        expect(await leaveChat(page, true)).toBe(prompt);
        expect(await page.evaluate(() => window.__app.activeRoute())).toBe('reception');
        await expect(mic).toHaveCount(0);
        if (phase === 'opening') await page.evaluate(() => window.__voiceLeaveFixture.allow(0));
        await expect.poll(() => page.evaluate(() => window.__voiceLeaveFixture.attempts[0]?.stopped)).toBe(true);
        expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
        expect(await unloadIsAllowed(page)).toBe(true);
      });

      test(`clears the leave guard after dismissing ${phase} capture at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await bootShell(page);
        const mic = voiceControl(page);
        await mic.click();
        if (phase === 'recording') await page.evaluate(() => window.__voiceLeaveFixture.allow(0));
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', phase);
        expect(await unloadIsAllowed(page)).toBe(false);
        await page.getByRole('button', { name: phase === 'opening' ? 'Cancel recording request' : 'Discard recording', exact: true }).focus();
        await page.keyboard.press('Space');
        await expect(mic).toHaveAttribute('data-recued-chat-route-voice', 'idle');
        if (phase === 'opening') await page.evaluate(() => window.__voiceLeaveFixture.allow(0));
        await expect.poll(() => page.evaluate(() => window.__voiceLeaveFixture.attempts[0]?.stopped)).toBe(true);
        expect(await unloadIsAllowed(page)).toBe(true);
        const messages: string[] = [];
        page.on('dialog', async dialog => { messages.push(dialog.message()); await dialog.dismiss(); });
        await page.evaluate(() => window.__app.setHash('#reception'));
        expect(await page.evaluate(() => window.__app.activeRoute())).toBe('reception');
        expect(messages).toEqual([]);
      });
    }

    test(`ignores a refused microphone after confirmed route leave at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await bootShell(page);
      await voiceControl(page).click();
      expect(await unloadIsAllowed(page)).toBe(false);
      expect(await leaveChat(page, true)).toBe('Cancel this microphone request and leave Chat?');
      await page.evaluate(() => window.__voiceLeaveFixture.refuse(0));
      expect(await page.evaluate(() => window.__app.activeRoute())).toBe('reception');
      await expect(page.locator('[data-recued-chat-route-voice-error]')).toHaveCount(0);
      expect(await unloadIsAllowed(page)).toBe(true);
      expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
    });
  }
});

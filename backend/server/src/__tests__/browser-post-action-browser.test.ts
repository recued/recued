import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BRIDGE_ACTIONS, BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS, readBrowserFailure } from '@recued/contracts';
import { createReviewedBrowserFixture, observedFixturePage } from './d-261-browser-fixture.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import { createBridgeDispatcher, createBridgeResultListener } from '../bridges/dispatcher.js';
import { createBoundExecutor, createNamespaceStores } from '../server-executor.js';
import { createManifestRegistry } from '../manifest-loader.js';

let base: string;
let server: Server;
let chrome: Awaited<ReturnType<typeof createReviewedBrowserFixture>>;
let posts = 0;
let staleSubmissionReply = false;
let turn_id: string;
let call: (slug: string, input: Record<string, unknown>) => Promise<Record<string, any>>;
const commands: string[] = [];
const answers: unknown[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url!, base ?? 'http://fixture').pathname;
    if (request.method === 'POST') {
      posts += 1;
      request.resume();
      if (path === '/send') { response.writeHead(303, { location: base + '/notes' }); response.end(); }
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"saved":true}'); }
      return;
    }
    const body = path === '/start' ? '<h1>Welcome</h1><a id="go-login" href="/login">Login</a>'
      : path === '/hidden' ? '<h1>Welcome</h1><input id="email" hidden><a id="go-login" href="/login">Login</a>'
      : path === '/notes' ? '<h1>My notes</h1><button id="add">Add note</button><a href="/notes/1">View</a>'
      : `<h1>Login</h1><form action="/send" method="post"><label>Email<input id="email" name="email" required></label><button id="login">Login</button></form>
        <script>window.originalFetch=window.fetch;window.domReadyCount=0;document.addEventListener('DOMContentLoaded',()=>window.domReadyCount++);
        ${path === '/ajax' || path === '/late' ? `document.querySelector('form').onsubmit=async e=>{e.preventDefault();
          await fetch('/persist',{method:'POST',body:'fixture'});${path === '/late' ? 'window.renderPending=true;await new Promise(resolve=>window.finishPendingRender=resolve);window.renderPending=false;' : ''}
          ${path === '/ajax' ? "history.pushState({},'', '/notes');" : ''}
          document.body.innerHTML='<main><h1>My notes</h1><button id="add">Add note</button><a href="/notes/1">View</a></main>';};` : ''}</script>`;
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Notes</title><main>' + body + '</main>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  chrome = await createReviewedBrowserFixture('about:blank', { siteGrants: 'chrome', hostPermissions: ['*://*/*'] });
  const registry = createBridgeRegistry(), listener = createBridgeResultListener();
  registry.attach({ client_token_id: 'fixture', client_label: 'Chrome', session_id: 'fixture', online_since: 1, last_seen_at: 1,
    capabilities: { software_version: '0.0.12', chrome_version: '140', permissions_granted: ['tabs', 'scripting'],
      granted_origins: ['*://*/*'], offscreen_supported: true, alarms_supported: true, supported_actions: [...BRIDGE_ACTIONS], dom_readiness: true, wait_read: true } });
  const dispatcher = createBridgeDispatcher({ registry, listener, transport: { cancel: async () => ({ ok: true }),
    send: async (_id, envelope) => {
      if (envelope.kind !== 'command') throw new Error('Expected command');
      commands.push(envelope.command.action);
      const { result } = await chrome.ordinaryCommand(envelope.command);
      // Reproduce the real race: Chrome has committed the POST destination,
      // while the acknowledged submit still carries its old document handle.
      if (staleSubmissionReply && envelope.command.action === 'submit' && result.status === 'ok' && result.outputs) {
        result.outputs = { ...result.outputs, page: envelope.command.args.page };
      }
      answers.push({ action: envelope.command.action, pattern: envelope.command.target_domain_pattern, status: result.status,
        outputs: result.outputs && { page: result.outputs.page, url: result.outputs.url, moved: result.outputs.moved, found: result.outputs.found }, error: result.error });
      listener.resolveResult(result); return { ok: true };
    } } });
  const manifests = createManifestRegistry(), bridgeDispatcherRef = () => dispatcher;
  turn_id = randomUUID();
  call = (slug, input) => {
    // The production recipe handler builds a new bound executor for every call.
    const executor = createBoundExecutor({ manifests, bridgeDispatcherRef }, createNamespaceStores({}, {}, {}));
    return executor(slug, { target: '*://*/*', ...input }, undefined, undefined,
      { run_id: randomUUID(), recipe_id: 'fixture', step_id: 'browser', execution_source: {
        channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'post-action-chrome', turn_id,
      } }) as Promise<Record<string, any>>;
  };
}, 90_000);
afterAll(async () => { await chrome?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

const read = async (path: string) => {
  await chrome.reset(base + path); turn_id = randomUUID(); posts = 0; staleSubmissionReply = false; commands.length = 0; answers.length = 0;
  const page = await observedFixturePage(() => call('dom-tabs', {}), base + path, BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS);
  return call('dom-inspect', { page, form: 'outline' });
};

it.each(['/start', '/hidden'])('returns a failed visible condition with a fresh view and distinct absent/hidden evidence (%s)', async path => {
  const before = await read(path); commands.length = 0;
  const error = await call('dom-act', { page: before.page, steps: [
    { do: 'wait', selector: '#email', seconds: 0.1 }, { do: 'read' },
  ] }).catch(error => error);
  expect(error).toMatchObject({ code: 'DOM_CHECK_FAILED' });
  const details = readBrowserFailure(error)?.details;
  expect(details).toMatchObject({ check_failure: { status: 'failed', kind: 'condition_not_met', selector: '#email', match_state: path === '/start' ? 'absent' : 'hidden' },
    batch_progress: { completed_steps: [], effects: [] }, failure_observation: { diagnostic_only: true, view_status: 'fresh', view: { page: before.page } } });
  expect(details?.failure_observation?.view?.outline).toContain('Login');
  expect(details?.completed_reads).toBeUndefined();
  expect(commands).toEqual(['wait_for_element', 'reread']);
  if (path === '/start') await expect(call('dom-act', { page: before.page, steps: [
    { do: 'wait', selector: '#email', until: 'gone', seconds: 0.1 }, { do: 'read' },
  ] })).resolves.toMatchObject({ done: 2 });
}, 90_000);

it('continues the landing URL onto Login across fresh executors, then submits by the exact document handle', async () => {
  const before = await read('/start');
  const stopped = await call('dom-act', { page: base + '/start', steps: [
    { do: 'click', selector: '#go-login' }, { do: 'wait', selector: '.guessed-email', seconds: 0.1 },
  ] }).catch(error => error);
  const login = readBrowserFailure(stopped)?.details.post_action?.current_page;
  expect(login).toBeDefined(); expect(login).not.toBe(before.page);
  commands.length = 0;
  const continued = await call('dom-act', { page: base + '/start', steps: [{ do: 'read' }] });
  expect(continued).toMatchObject({ page: login, url: base + '/login' });
  expect(commands).toEqual(['inspect']);
  commands.length = 0;
  await expect(call('dom-act', { page: base + '/start', steps: [
    { do: 'type', selector: '#email', value: 'fixture@example.org' }, { do: 'click', ref: 'e3' },
  ] })).rejects.toMatchObject({ code: 'DOM_SELECTOR_MISSING', details: { executed: false } });
  expect(commands).toEqual(['reread']);
  const saved = await call('dom-act', { page: login, steps: [
    { do: 'type', selector: '#email', value: 'fixture@example.org' },
    { do: 'submit', selector: '#email', success_when: { url_includes: '/notes' } },
  ] });
  expect(saved.post_action).toMatchObject({ action_status: 'acknowledged', view_status: 'fresh', view: { url: base + '/notes' } });
  expect(posts).toBe(1);
  expect(commands).not.toContain('open_tab'); expect(commands).not.toContain('reload_page');
}, 90_000);

it('returns the AJAX notes view after a wrong wait without DOM-ready events or a second POST', async () => {
  const before = await read('/ajax');
  const error = await call('dom-act', { page: before.page, steps: [
    { do: 'type', selector: '#email', value: 'fixture@example.org' },
    { do: 'click', selector: '#login', success_when: { shows: '#add' } },
    { do: 'wait', selector: '.guessed-note-card', seconds: 0.1 }, { do: 'read' },
  ] }).catch(error => error);
  const state = readBrowserFailure(error)?.details.post_action;
  expect(state).toMatchObject({ action_status: 'acknowledged', check_status: 'failed', view_status: 'fresh', transition: 'same_document',
    before_page: before.page, current_page: before.page, application_outcome: 'unverified' });
  expect(state?.view?.outline).toContain('Add note');
  expect(state?.view?.url).toBe(base + '/notes');
  expect(posts).toBe(1);
  expect(commands.filter(action => action === 'click')).toHaveLength(1);
  expect(commands).not.toContain('reload_page');
  expect(await chrome.page.evaluate(() => ({ ready: (window as any).domReadyCount, native: window.fetch === (window as any).originalFetch }))).toEqual({ ready: 1, native: true });
}, 90_000);

it('observes a native POST redirect as a new document and leaves application acceptance unverified', async () => {
  const before = await read('/login');
  const result = await call('dom-act', { page: before.page, steps: [
    { do: 'type', selector: '#email', value: 'fixture@example.org' }, { do: 'submit', selector: '#email', success_when: { url_includes: '/notes' } },
  ] }).catch(async error => { throw new Error(`${String(error)} ${JSON.stringify(answers)} actual=${chrome.page.url()} ${await chrome.page.title()}`); });
  expect(result.post_action).toMatchObject({ action_status: 'acknowledged', check_status: 'passed', view_status: 'fresh', transition: 'new_document', application_outcome: 'unverified' });
  expect(result.post_action.view.page).not.toBe(before.page);
  expect(result.post_action.view.outline).toContain('View');
  expect(posts).toBe(1);
}, 90_000);

it('reads the committed POST document once after a stale acknowledgment without replaying the form', async () => {
  const before = await read('/login');
  staleSubmissionReply = true; commands.length = 0;
  const result = await call('dom-act', { page: before.page, steps: [
    { do: 'type', selector: '#email', value: 'fixture@example.org' },
    { do: 'submit', selector: '#email', success_when: { page_changes: true } },
    { do: 'read', page: before.page },
  ] });
  expect(result).toMatchObject({ done: 3, post_action: { action_status: 'acknowledged', check_status: 'passed',
    transition: 'new_document', view_status: 'fresh', view: { url: base + '/notes' }, application_outcome: 'unverified' } });
  expect(result.page).not.toBe(before.page);
  expect(result.tabs[0].reads[0].outline).toContain('Add note');
  expect(posts).toBe(1);
  expect(commands.filter(action => action === 'submit')).toHaveLength(1);
  expect(commands.slice(-3)).toEqual(['inspect', 'list_tabs', 'inspect']);
  expect(commands).not.toContain('reload_page'); expect(commands).not.toContain('open_tab');
}, 90_000);

it('keeps native validation refusal separate from a submitted form and does not send it', async () => {
  const before = await read('/login');
  const error = await call('dom-act', { page: before.page, steps: [{ do: 'submit', selector: '#email' }] }).catch(error => error);
  expect(error).toMatchObject({ code: 'DOM_WRITE_FAILED' });
  expect(String(error.message)).toContain('not sent');
  expect(readBrowserFailure(error)?.details.post_action).toMatchObject({ action_status: 'refused', view_status: 'fresh', transition: 'same_document' });
  expect(posts).toBe(0);
}, 90_000);

it('keeps a completed POST separate from a pending same-page render without refreshing or replaying it', async () => {
  const before = await read('/late');
  try {
    const error = await call('dom-act', { page: before.page, steps: [
      { do: 'type', selector: '#email', value: 'fixture@example.org' },
      { do: 'click', selector: '#login', success_when: { shows: '#add', seconds: 0.1 } },
    ] }).catch(error => error);
    const state = readBrowserFailure(error)?.details.post_action;
    expect(error, JSON.stringify(answers)).toMatchObject({ code: 'DOM_CHECK_FAILED' });
    expect(state).toMatchObject({ action_status: 'acknowledged', check_status: 'failed', application_outcome: 'unverified', view_status: 'fresh' });
    expect(state?.view?.outline).toContain('Login');
    expect(posts).toBe(1);
    expect(commands.filter(action => action === 'click')).toHaveLength(1);
    expect(commands).not.toContain('reload_page');
    // The POST has completed, while the UI remains held independently of CPU
    // scheduling. Its receipt alone still does not prove application success.
    await expect.poll(() => chrome.page.evaluate(() => (window as any).renderPending === true),
      { timeout: BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS }).toBe(true);
    expect(await chrome.page.locator('h1').textContent()).toBe('Login');
  } finally {
    await chrome.page.evaluate(() => (window as any).finishPendingRender?.());
  }
}, 90_000);

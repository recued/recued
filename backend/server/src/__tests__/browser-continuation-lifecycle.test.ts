import { expect, it, vi } from 'vitest';
import { readBrowserFailure, type ExecutionSource } from '@recued/contracts';
import { createBoundExecutor, createNamespaceStores, createServerExecutor } from '../server-executor.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const root = 'https://example.org/app/', login = root + 'login';
const source: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'chat', turn_id: 'turn' };
const ok = (outputs: Record<string, unknown>): Extract<DispatchOutcome, { kind: 'completed' }> => ({ kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
  result: { command_id: 'c', status: 'ok', bridge_version: '0.0.12', duration_ms: 1, idempotency_key_seen: false, outputs } });
const fixture = (bound: boolean) => {
  const manifests = createManifestRegistry('/nonexistent');
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  let current = { page: '7:ROOT', url: root }, runs = 0;
  const dispatch = vi.fn(async (request: DispatchRequest) => {
    if (request.action === 'list_tabs') return ok({ tabs: [{ ...current, title: 'App' }], truncated: false });
    if (request.action === 'open_tab') { current = { page: '8:ROOT', url: root }; return ok({ ...current, title: 'App' }); }
    if (request.action === 'click') { current = { page: '7:LOGIN', url: login }; return ok({ ...current, clicked: true, moved: true }); }
    if (request.action === 'wait_for_element') return ok({ ...current, found: false });
    if (request.action === 'fill') return ok({ ...current, filled: true });
    return ok({ ...current, title: 'App', loading: false, truncated: false,
      html: current.url === login ? '<main><h1>Login</h1><input id="email" ref="e2"><button ref="e3">Login</button></main>'
        : '<main><a ref="e1" href="/app/login">Login</a></main>' });
  });
  const dispatcher = { dispatch, cancel: vi.fn(), canResolve: () => true };
  const getDispatcher = () => dispatcher;
  const run = (slug: string, input: Record<string, unknown>, execution_source = source, runtime = getDispatcher) => {
    // handleExecute makes this fresh config/executor for each recipe run.
    const config = { manifests, bridgeDispatcherRef: runtime };
    const executor = bound ? createBoundExecutor(config, createNamespaceStores({}, {}, {})) : createServerExecutor(config);
    return executor(slug, { target: '*://*/*', ...input }, undefined, undefined,
      { run_id: `recipe-${++runs}`, recipe_id: 'browser-test', step_id: 'browser', execution_source });
  };
  return { run, dispatch, dispatcher };
};

it.each([false, true])('retains URL lineage across real executor recreation and failed checks (bound=%s)', async bound => {
  const { run, dispatch } = fixture(bound);
  await run('dom-inspect', { page: '7:ROOT', form: 'outline' });
  const stopped = await run('dom-act', { page: root, steps: [{ do: 'click', selector: 'a' },
    { do: 'wait', selector: '.guessed-login', seconds: 0.1 }] }).catch(error => error);
  expect(readBrowserFailure(stopped)?.details.post_action).toMatchObject({ action_status: 'acknowledged', view_status: 'fresh', current_page: '7:LOGIN' });
  dispatch.mockClear();
  const read = await run('dom-act', { page: root, steps: [{ do: 'read' }] }) as any;
  expect(read.page).toBe('7:LOGIN');
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect']);
  dispatch.mockClear();
  await expect(run('dom-act', { page: root, steps: [{ do: 'type', selector: '#email', value: 'fixture@example.org' },
    { do: 'click', ref: 'e3' }] })).rejects.toMatchObject({ code: 'DOM_SELECTOR_MISSING', details: { executed: false } });
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['reread']);
  await run('dom-act', { page: '7:LOGIN', steps: [{ do: 'type', ref: 'e2', value: 'fixture@example.org' }] });
  expect(dispatch.mock.calls.filter(([request]) => request.action === 'fill')).toHaveLength(1);
});

it.each(['caller', 'turn', 'runtime'] as const)('does not inherit URL lineage across a different %s', async boundary => {
  const { run, dispatch, dispatcher } = fixture(true);
  await run('dom-inspect', { page: '7:ROOT', form: 'outline' });
  await run('dom-act', { page: root, steps: [{ do: 'click', selector: 'a' }] });
  dispatch.mockClear();
  await run('dom-act', { page: root, steps: [{ do: 'read' }] },
    boundary === 'caller' ? { ...source, user_id: 'other' } : boundary === 'turn' ? { ...source, turn_id: 'other' } : source,
    boundary === 'runtime' ? () => dispatcher : undefined);
  expect(dispatch.mock.calls.filter(([request]) => request.action === 'open_tab')).toHaveLength(1);
});

it('keeps delivery uncertainty across executor recreation until an explicit read, with no action replay', async () => {
  const { run, dispatch } = fixture(true);
  await run('dom-inspect', { page: '7:ROOT', form: 'outline' });
  dispatch.mockResolvedValueOnce({ ...ok({}), result: { command_id: 'c', status: 'error', bridge_version: '0.0.12', duration_ms: 1,
    idempotency_key_seen: false, error: { code: 'delivery_uncertain', message: 'Missing receipt' } } });
  await expect(run('dom-act', { page: root, steps: [{ do: 'click', selector: 'a' }] })).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  dispatch.mockClear();
  await expect(run('dom-act', { page: root, steps: [{ do: 'read' }] })).rejects.toMatchObject({ code: 'DOM_PAGE_NOT_MATCHING' });
  expect(dispatch).not.toHaveBeenCalled();
  await run('dom-inspect', { page: '7:ROOT', form: 'outline' });
  await run('dom-act', { page: root, steps: [{ do: 'read' }] });
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect', 'inspect']);
});

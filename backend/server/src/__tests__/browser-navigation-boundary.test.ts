import { expect, it, vi } from 'vitest';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { readBrowserFailure, type ChatPriorToolCall, type ExecutionSource, type RecipeDefinition } from '@recued/contracts';
import { createServerExecutor } from '../server-executor.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const root = 'https://example.org/app/', login = root + 'login';
const source: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'navigation', turn_id: 'turn' };
const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
  result: { command_id: 'c', status: 'ok', bridge_version: '0.0.12', duration_ms: 1, idempotency_key_seen: false, outputs } });
const setup = (sameDocument = false) => {
  const manifests = createManifestRegistry('/nonexistent'); for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  let current = { page: '7:ROOT', url: root }, opened = false, loading = false, unavailable = false, count = 0;
  const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
    if (request.action === 'list_tabs') return ok({ tabs: [{ ...current, title: 'App' }], truncated: false });
    if (request.action === 'click') {
      opened = true; loading = !sameDocument;
      if (!sameDocument) current = { page: '7:LOGIN', url: login };
      return ok({ ...current, clicked: true, moved: !sameDocument });
    }
    if (request.action === 'wait_for_element') return ok({ ...current, found: false, match_counts: { matched: 0, visible: 0, text_matched: 0 } });
    if (request.action === 'fill') return ok({ ...current, filled: true });
    if (unavailable) throw Error('Read unavailable');
    return ok({ ...current, title: 'App', loading, truncated: false, html: opened
      ? '<main><label for="email">Email address</label><input id="email" name="email" type="text" ref="e2"><button ref="e3" type="submit">Login</button></main>'
      : '<main><a ref="e1" href="/app/login">Login</a></main>' });
  });
  const dispatcher = { dispatch, cancel: vi.fn(), canResolve: () => true }, runtime = () => dispatcher;
  const run = (slug: string, input: Record<string, unknown>) => createServerExecutor({ manifests, bridgeDispatcherRef: runtime })(slug,
    { target: '*://*/*', ...input }, undefined, undefined, { run_id: `navigation-${++count}`, recipe_id: 'browser-test', step_id: 'act', execution_source: source });
  const recipe = (input: Record<string, unknown>) => {
    const recipe: RecipeDefinition = { recipe_id: 'act-on-web-page', version: 29, ttl: 0,
      metadata: { name: 'Act', description: 'Fixture', author: 'recued-core', supported_platforms: [] }, variables: {}, prefetch_steps: [],
      steps: [{ id: 'act', ingredient: 'dom-act', input }], output: { render: [{ type: 'json', source: 'step.act' }] } };
    const context: ExecutionContext = { recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} }, ingredientExecutor: run };
    return executeRecipe(context);
  };
  return { dispatch, run, recipe, settle: () => { loading = false; }, failRead: () => { unavailable = true; } };
};
const native = (result: unknown) => {
  const call: ChatPriorToolCall = { tool_name: 'recued-core/act-on-web-page', tier: 2, args: {}, status: 'error', result, started_at: 1, completed_at: 2 };
  return JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Continue the browser task.' }, prior_tool_calls: [call] }).body).prior_tool_calls[0].result;
};

it('returns the new form through engine/native before a guessed wait or credential step, then accepts an observed exact-document plan', async () => {
  const f = setup(); await f.run('dom-inspect', { page: '7:ROOT', form: 'outline' }); f.dispatch.mockClear();
  const first = await f.recipe({ page: root, steps: [{ do: 'click', ref: 'e1' },
    { do: 'wait', selector: 'input[type=email]', seconds: 2 }, { do: 'type', selector: 'input[type=email]', value: 'fixture' }] });
  expect(first.success).toBe(false);
  expect(f.dispatch.mock.calls.map(([request]) => request.action)).toEqual(['click', 'reread']);
  const sent = native(first);
  expect(sent.browser_navigation).toMatchObject({ kind: 'unobserved_form_document', page: '7:LOGIN', pending_step: 2 });
  expect(sent.browser_state).toMatchObject({ action_status: 'acknowledged', check_status: 'not_requested', transition: 'new_document',
    current_page: '7:LOGIN', view: { read_state: { loading: true, complete: false } } });
  expect(sent.browser_state.view.outline).toContain('[input type="text": Email address](e2 #email)');
  expect(sent.browser_attention.page_state).toBe('loading');
  expect(sent.browser_check).toBeUndefined();
  f.settle(); f.dispatch.mockClear();
  await f.run('dom-act', { page: sent.browser_state.current_page, steps: [{ do: 'type', selector: '#email', value: 'fixture' }] });
  expect(f.dispatch.mock.calls.filter(([request]) => request.action === 'fill')).toHaveLength(1);
});

it('keeps a whole-batch binding refusal factual and diagnostic, even when its exact document is still loading', async () => {
  const f = setup(); await f.run('dom-inspect', { page: '7:ROOT', form: 'outline' });
  await f.run('dom-act', { page: root, steps: [{ do: 'click', ref: 'e1' }] }); f.dispatch.mockClear();
  const refused = await f.recipe({ page: root, steps: [{ do: 'type', selector: '#email', value: 'fixture' }, { do: 'click', ref: 'e3' }] });
  const sent = native(refused);
  expect(f.dispatch.mock.calls.map(([request]) => request.action)).toEqual(['reread']);
  expect(sent.browser_binding).toMatchObject({ kind: 'document_binding_mismatch', executed: false, requested_page: root, page: '7:LOGIN', url: login, refs_scope: 'document', ref_step: 2 });
  expect(sent.browser_attention).toMatchObject({ completed_steps: [], effects: [], page_state: 'loading', current_page: '7:LOGIN' });
  expect(sent.browser_observation.view.read_state.loading).toBe(true);
  expect(sent.browser_check).toBeUndefined();
  const error = refused.errors[0]!;
  const original = readBrowserFailure({ code: error.code, browser_failure: { slug: 'dom-act', details: error.details } });
  expect(original).toBeDefined();
  const details = original!.details;
  for (const page_state of ['loading', 'unknown']) expect(readBrowserFailure({ code: error.code,
    browser_failure: { slug: 'dom-act', details: { ...details, batch_progress: { ...details.batch_progress, page_state } } } })).toBeDefined();
  expect(readBrowserFailure({ code: error.code, browser_failure: { slug: 'dom-act', details: { ...details,
    batch_progress: { ...details.batch_progress, effects: [{ step: 1, attempted: 1, acknowledged: 1 }] } } } })).toBeUndefined();
  f.failRead();
  const unknown = native(await f.recipe({ page: login, steps: [{ do: 'click', ref: 'e3' }] }));
  expect(unknown.browser_attention.page_state).toBe('unknown');
  expect(unknown.browser_observation.view_status).toBe('unavailable');
});

it('keeps same-document forms batchable and reports actual zero-match evidence for a failed observed wait', async () => {
  const f = setup(true); await f.run('dom-inspect', { page: '7:ROOT', form: 'outline' }); f.dispatch.mockClear();
  await f.run('dom-act', { page: '7:ROOT', steps: [{ do: 'click', ref: 'e1' }, { do: 'type', selector: '#email', value: 'fixture' }] });
  expect(f.dispatch.mock.calls.filter(([request]) => request.action === 'fill')).toHaveLength(1);
  const failed = native(await f.recipe({ page: '7:ROOT', steps: [{ do: 'wait', selector: 'input[type=email]', seconds: 0.01 }, { do: 'read' }] }));
  expect(failed.browser_check).toMatchObject({ status: 'failed', match_state: 'absent', match_counts: { matched: 0, visible: 0, text_matched: 0 } });
  expect(failed.browser_observation.view.outline).toContain('input type="text"');
});

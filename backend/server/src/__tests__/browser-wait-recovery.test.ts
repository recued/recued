import { expect, it, vi } from 'vitest';
import { readBrowserFailure, isBrowserConditionFailure, type ChatPriorToolCall, type RecipeDefinition } from '@recued/contracts';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { projectRunResultForAgent } from '../run-result-agent-projection.js';
import { withRunAbortContext } from '../execution/run-abort-context.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const page = '7:WAIT', url = 'https://example.org/app/';
const ok = (outputs: Record<string, unknown>): Extract<DispatchOutcome, { kind: 'completed' }> => ({ kind: 'completed', attempts: 1, bridge_client_token_id: 'b',
  result: { command_id: 'c', status: 'ok', bridge_version: '0.0.12', duration_ms: 1, idempotency_key_seen: false, outputs } });
const fixture = () => {
  let loading = true, readFails = false, controlsWhileLoading = false;
  const dispatch = vi.fn(async (r: DispatchRequest): Promise<DispatchOutcome> => {
    if (r.action === 'wait_for_element') return ok({ page, url, title: 'App', found: r.args.until === 'gone', waited_ms: 100 });
    if (r.action === 'click') return { ...ok({}), result: { ...ok({}).result, status: 'error', error: { code: 'selector_not_found', message: 'No element matches #missing' } } };
    if (readFails) throw new Error('No snapshot available');
    return ok({ page, url, title: 'App', loading, truncated: false, html: loading && !controlsWhileLoading ? '<main>Loading</main>'
      : '<main><h1>Notes app</h1><a ref="e24" href="/login">Login</a><input id="email" ref="e25" type="text"></main>' });
  });
  const adapter = createBridgeDomAdapter({ getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }),
    pageReads: createPageReadStore(), manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null } });
  const read = () => adapter({ slug: 'dom-inspect', risk_tier: 'read', input: { target: '*://*/*', page, form: 'outline' }, output: {} });
  const act = (steps: unknown[]) => adapter({ slug: 'dom-act', risk_tier: 'read', input: { target: '*://*/*', page, steps }, output: {} });
  return { dispatch, read, act, adapter, settle: () => { loading = false; }, failReads: () => { readFails = true; }, showControlsWhileLoading: () => { controlsWhileLoading = true; } };
};
const call = (tool: string, result: unknown, args: unknown): ChatPriorToolCall => ({ tool_name: `recued-core/${tool}`, tier: 2,
  args, result, status: tool === 'act-on-web-page' ? 'error' : 'ok', started_at: 1, completed_at: 2 });

it('returns current controls after readiness timeout without passing the wait or completing the planned read', async () => {
  const f = fixture(); await f.read(); f.showControlsWhileLoading(); f.dispatch.mockClear();
  const error = await f.act([{ do: 'wait', until: 'ready', seconds: 0.1 }, { do: 'read' }]).catch(error => error);
  expect(error).toMatchObject({ code: 'DOM_CHECK_FAILED' });
  const details = readBrowserFailure(error)!.details;
  expect(details.batch_progress).toMatchObject({ failed_step: 1, completed_steps: [], effects: [], page_state: 'loading' });
  expect(details.ready_failure).toMatchObject({ status: 'failed', kind: 'readiness_not_established', timeout_ms: 100 });
  expect(details.failure_observation).toMatchObject({ diagnostic_only: true, view_status: 'fresh', view: { read_state: { loading: true, complete: false } } });
  expect(details.failure_observation!.view!.outline).toContain('Login');
  expect(details).not.toHaveProperty('completed_reads');
  expect(f.dispatch.mock.calls.every(([request]) => request.action === 'reread')).toBe(true);
  for (const ready_failure of [{ ...details.ready_failure, step: 2 }, { ...details.ready_failure, timeout_ms: 0 }]) {
    expect(readBrowserFailure({ code: 'DOM_CHECK_FAILED', browser_failure: { slug: 'dom-act', details: { ...details, ready_failure } } })).toBeUndefined();
  }
});

it('returns an explicit failed condition and fresh diagnostic view, with no completed planned read or action', async () => {
  const f = fixture(); await f.read(); f.settle(); f.dispatch.mockClear();
  const error = await f.act([{ do: 'wait', selector: 'input[type="email"]', seconds: 0.1 }, { do: 'read' }]).catch(error => error);
  expect(error).toMatchObject({ code: 'DOM_CHECK_FAILED' });
  const failure = readBrowserFailure(error)!;
  expect(failure.details).toMatchObject({ check_failure: { status: 'failed', kind: 'condition_not_met', selector: 'input[type="email"]',
    until: 'shown', timeout_ms: 100, waited_ms: 100, match_state: 'unknown' },
    batch_progress: { failed_step: 1, completed_steps: [], effects: [] },
    failure_observation: { diagnostic_only: true, view_status: 'fresh', view: { page, read_state: { loading: false, complete: true } } } });
  expect(failure.details.failure_observation?.view?.outline).toContain('Login');
  expect(failure.details).not.toHaveProperty('completed_reads'); expect(failure.details).not.toHaveProperty('post_action');
  expect(f.dispatch.mock.calls.map(([r]) => r.action)).toEqual(['wait_for_element', 'reread']);
  expect(isBrowserConditionFailure({ ...failure.details.check_failure, match_state: 'absent' })).toBe(false);
});

it('makes superseded loading advice historical in the native packet while retaining pinned data and original results', async () => {
  const f = fixture(); const old = await f.read() as Record<string, unknown>; f.settle();
  const steps = [{ do: 'wait', selector: 'input[type="email"]', seconds: 0.1 }, { do: 'read' }];
  const recipe: RecipeDefinition = { recipe_id: 'act-on-web-page', version: 26, ttl: 0,
    metadata: { name: 'Act', description: 'Wait recovery fixture', author: 'recued-core', supported_platforms: [] }, variables: {}, prefetch_steps: [],
    steps: [{ id: 'act', ingredient: 'dom-act', input: { target: '*://*/*', page, steps } }], output: { render: [{ type: 'json', source: 'step.act' }] } };
  const context: ExecutionContext = { recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
    ingredientExecutor: async (slug, input) => f.adapter({ slug, input, output: {}, risk_tier: 'read' }) };
  const result = await executeRecipe(context);
  expect(result.success).toBe(false);
  const input = [call('inspect-web-page', { recipe_id: 'inspect-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: { ...old, data_ref: 'pinned-data' } }] } }, { page }),
    call('act-on-web-page', projectRunResultForAgent(result), { page, steps })];
  const before = JSON.stringify(input);
  const sent = JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Log in.' }, prior_tool_calls: input }).body).prior_tool_calls;
  const earlier = sent[0].result.output.render[0].data;
  expect(earlier.read_state).toMatchObject({ complete: false, loading: true, context: { latest_for_same_scope: false, current_for_controls: false } });
  expect(earlier.loading_recovery).toBeUndefined(); expect(earlier.data_ref).toBe('pinned-data');
  expect(sent[0].result.browser_attention).toMatchObject({ historical: true });
  expect(sent[1].result.browser_check).toMatchObject({ status: 'failed', kind: 'condition_not_met' });
  expect(sent[1].result.browser_observation.view.read_state.context.current_for_controls).toBe(true);
  expect(sent[1].result.browser_attention.next_step).toBeUndefined();
  expect(JSON.stringify(input)).toBe(before);
});

it('preserves the original failed condition if diagnostic reading fails', async () => {
  const f = fixture(); f.failReads();
  const error = await f.act([{ do: 'wait', selector: '#missing', seconds: 0.1 }, { do: 'read' }]).catch(error => error);
  expect(error).toMatchObject({ code: 'DOM_CHECK_FAILED' });
  expect(readBrowserFailure(error)?.details).toMatchObject({ check_failure: { status: 'failed' }, failure_observation: { view_status: 'unavailable', reason: 'read_failed' } });
});

it('preserves immediate lookup refusal and does not turn it into a wait timeout', async () => {
  const f = fixture();
  const error = await f.act([{ do: 'click', selector: '#missing' }]).catch(error => error);
  expect(error).toMatchObject({ code: 'DOM_SELECTOR_NOT_FOUND' });
  expect(readBrowserFailure(error)?.details.check_failure).toBeUndefined();
  expect(f.dispatch.mock.calls.filter(([r]) => r.action === 'click')).toHaveLength(1);
  expect(f.dispatch.mock.calls.some(([r]) => r.action === 'wait_for_element')).toBe(false);
});

it('treats an absent gone target as success', async () => {
  const f = fixture();
  await expect(f.act([{ do: 'wait', selector: '#missing', until: 'gone', seconds: 0.1 }, { do: 'read' }])).resolves.toMatchObject({ done: 2 });
});

it('does not advertise a fresh diagnostic view when cancellation arrives during its read', async () => {
  const f = fixture(), abort = new AbortController();
  const implementation = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async request => {
    const answer = await implementation(request);
    if (request.action === 'reread') abort.abort();
    return answer;
  });
  const error = await withRunAbortContext({ signal: abort.signal }, () => f.act([
    { do: 'wait', selector: '#missing', seconds: 0.1 }, { do: 'read' },
  ])).catch(error => error);
  expect(readBrowserFailure(error)?.details.failure_observation).toMatchObject({ view_status: 'unavailable', reason: 'cancelled' });
  expect(f.dispatch.mock.calls.map(([r]) => r.action)).toEqual(['wait_for_element', 'reread']);
});

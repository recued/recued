import { expect, it, vi } from 'vitest';
import { BRIDGE_PAGE_GONE_MESSAGE, isBrowserPostActionState, readBrowserFailure, type ChatPriorToolCall, type RecipeDefinition, type BrowserPageObservation } from '@recued/contracts';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { browserPostActionState } from '../bridges/browser-post-action.js';
import { limitBrowserFailureDetails } from '../bridges/browser-failure-budget.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { withRunAbortContext } from '../execution/run-abort-context.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { projectRunResultForAgent } from '../run-result-agent-projection.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const page = 'bridge:work:7:DOC', url = 'https://example.org/notes/login';
const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'work', attempts: 1,
  result: { command_id: 'c', status: 'ok', bridge_version: '0.0.12', duration_ms: 1, idempotency_key_seen: false, outputs } });
const setup = (answer?: (request: DispatchRequest) => DispatchOutcome) => {
  let view = '<main><h1>Login</h1><input id="email"><button>Login</button></main>';
  let currentUrl = url;
  const dispatch = vi.fn(async (request: DispatchRequest) => answer?.(request) ?? (['inspect', 'reread'].includes(request.action)
    ? ok({ page: request.args.page, url: currentUrl, title: 'Notes', html: view, loading: false, truncated: false })
    : request.action === 'wait_for_element' ? ok({ page, url: 'https://example.org/notes/', title: 'Notes', found: false })
    : (view = '<main><h1>My notes</h1><button>Add note</button><a>View</a></main>', currentUrl = 'https://example.org/notes/',
      ok({ page, url: 'https://example.org/notes/', title: 'Notes', clicked: true, sent: true, moved: false }))));
  const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
  const act = (steps: unknown[]) => adapter({ slug: 'dom-act', risk_tier: 'write', input: { target: '*://*/*', page, steps }, output: {},
    stepMeta: { run_id: 'post-action', recipe_id: 'act-on-web-page', step_id: 'act' } });
  return { dispatch, adapter, act };
};

it('keeps the acknowledged submission, failed check and fresh same-document view separate through engine and native packet', async () => {
  const { dispatch, adapter } = setup();
  const old = await adapter({ slug: 'dom-inspect', risk_tier: 'read', input: { target: '*://*/*', page, form: 'outline' }, output: {} });
  const steps = [{ do: 'click', selector: 'button' }, { do: 'wait', selector: '.guessed-note-card', seconds: 0.1 }, { do: 'read' }];
  const recipe: RecipeDefinition = { recipe_id: 'act-on-web-page', version: 25, ttl: 0,
    metadata: { name: 'Act', description: 'Fixture', author: 'recued-core', supported_platforms: [] }, variables: {}, prefetch_steps: [],
    steps: [{ id: 'act', ingredient: 'dom-act', input: { target: '*://*/*', page, steps } }],
    output: { render: [{ type: 'json', source: 'step.act', label: 'Done' }] } };
  const context: ExecutionContext = { recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
    ingredientExecutor: async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' }) };
  const run = await executeRecipe(context);
  expect(run.success).toBe(false);
  const details = run.errors[0]!.details as any;
  expect(details.batch_progress).toMatchObject({ failed_step: 2, completed_steps: [1], effects: [{ step: 1, attempted: 1, acknowledged: 1 }] });
  expect(details.completed_reads).toBeUndefined();
  expect(details.post_action).toMatchObject({ after_step: 1, action_status: 'acknowledged', check_status: 'failed',
    application_outcome: 'unverified', view_status: 'fresh', transition: 'same_document', view: { page, read_state: { source: 'bridge_read' } } });
  expect(details.post_action.view.outline).toContain('Add note');
  expect(dispatch.mock.calls.filter(([r]) => r.action === 'click')).toHaveLength(1);
  const reads = dispatch.mock.calls.filter(([r]) => ['inspect', 'reread'].includes(r.action));
  expect(reads).toHaveLength(2);
  expect(reads[1]![0]).toMatchObject({ timeout_ms: 4_000, args: { page } });
  expect(reads[1]![0].idempotency_key).not.toBe(reads[0]![0].idempotency_key);
  expect(dispatch.mock.calls.some(([r]) => ['navigate', 'reload_page', 'open_tab'].includes(r.action))).toBe(false);
  const call = (tool: string, result: unknown, args: Record<string, unknown>): ChatPriorToolCall => ({ tool_name: `recued-core/${tool}`, tier: 2,
    args, result, status: tool === 'act-on-web-page' ? 'error' : 'ok', started_at: 1, completed_at: 2 });
  const prior = [call('inspect-web-page', { recipe_id: 'inspect-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: old }] } }, { page }),
    call('act-on-web-page', projectRunResultForAgent(run), { page, steps })];
  const before = JSON.stringify(prior);
  const sent = JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Continue the notes task.' }, prior_tool_calls: prior }).body).prior_tool_calls;
  expect(sent[0].result.output.render[0].data.read_state).toMatchObject({ complete: true, context: { latest_for_same_scope: true, current_for_controls: false, invalidated_by_call: 2 } });
  expect(sent[1].result.browser_state.view.read_state.context.current_for_controls).toBe(true);
  expect(sent[1].result.browser_attention.effects).toEqual([{ step: 1, attempted: 1, acknowledged: 1 }]);
  expect(sent[1].result.browser_attention.next_step).toBeUndefined();
  expect(JSON.stringify(prior)).toBe(before);
});

it('accepts an acknowledged AJAX submission without claiming application success and reuses an explicit fresh read', async () => {
  const { act, dispatch } = setup();
  const result = await act([{ do: 'submit', selector: 'button' }, { do: 'read' }]) as any;
  expect(result.post_action).toMatchObject({ action_status: 'acknowledged', check_status: 'not_requested', view_status: 'fresh', application_outcome: 'unverified' });
  expect(dispatch.mock.calls.map(([r]) => r.action)).toEqual(['submit', 'inspect']);
});

it.each(['value_not_applied', 'selector_not_found'])('reads a confirmed %s refusal once, without repeating a write', async code => {
  const { act, dispatch } = setup(request => request.action === 'submit'
    ? { ...ok({}), result: { command_id: 'c', status: 'error', bridge_version: '0.0.12', duration_ms: 1,
      idempotency_key_seen: false, error: { code: code as 'value_not_applied', message: 'The form was not sent' } } }
    : ok({ page, url, title: 'Login', html: '<form><input required><p>Please fill this field</p></form>', loading: false, truncated: false }));
  const error = await act([{ do: 'submit', selector: 'button' }]).catch(error => error);
  expect(readBrowserFailure(error)?.details.post_action).toMatchObject({ action_status: 'refused', view_status: 'fresh', application_outcome: 'unverified' });
  expect(dispatch.mock.calls.filter(([r]) => r.action === 'submit')).toHaveLength(1);
  expect(dispatch.mock.calls.filter(([r]) => r.action === 'reread')).toHaveLength(1);
});

it('does not read or replay an uncertain delivery, and never changes its original failure code', async () => {
  const { act, dispatch } = setup(() => ({ ...ok({}), result: { command_id: 'c', status: 'error', bridge_version: '0.0.12', duration_ms: 1,
    idempotency_key_seen: false, error: { code: 'delivery_uncertain', message: 'No acknowledgment' } } }));
  const error = await act([{ do: 'click', selector: 'button' }]).catch(error => error);
  expect(error).toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  expect(readBrowserFailure(error)?.details.post_action).toMatchObject({ action_status: 'uncertain', view_status: 'unavailable', reason: 'delivery_uncertain' });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('does not send a diagnostic read after cancellation', async () => {
  const abort = new AbortController();
  const { act, dispatch } = setup(() => { abort.abort(); return ok({ page, clicked: true }); });
  await expect(withRunAbortContext({ signal: abort.signal }, () => act([{ do: 'click', selector: 'button' }, { do: 'wait', selector: '#x', seconds: 0.1 }]))).rejects.toBeDefined();
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('preserves the failed check when the extra read cannot be delivered', async () => {
  const { act, dispatch } = setup(request => request.action === 'click' ? ok({ page, clicked: true, sent: true })
    : request.action === 'wait_for_element' ? ok({ page, found: false }) : { kind: 'timeout', command_id: 'read' } as DispatchOutcome);
  const error = await act([{ do: 'click', selector: 'button' }, { do: 'wait', selector: '#missing', seconds: 0.1 }]).catch(error => error);
  expect(error).toMatchObject({ code: 'DOM_CHECK_FAILED' });
  expect(readBrowserFailure(error)?.details).toMatchObject({ batch_progress: { completed_steps: [1] },
    post_action: { action_status: 'acknowledged', check_status: 'failed', view_status: 'unavailable', reason: 'read_failed' } });
  expect(dispatch.mock.calls.filter(([r]) => r.action === 'click')).toHaveLength(1);
});

it('takes a new observation after a failed wait even when the batch read before waiting', async () => {
  const { act, dispatch } = setup();
  const error = await act([{ do: 'click', selector: 'button' }, { do: 'read' }, { do: 'wait', selector: '#missing', seconds: 0.1 }]).catch(error => error);
  expect(readBrowserFailure(error)?.details.post_action?.view_status).toBe('fresh');
  expect(dispatch.mock.calls.map(([r]) => r.action)).toEqual(['click', 'inspect', 'wait_for_element', 'reread']);
});

it('does not attribute another tab\'s successful wait to an unchecked action', async () => {
  const { act } = setup(request => request.action === 'click' ? ok({ page, clicked: true })
    : request.action === 'wait_for_element' ? ok({ page: request.args.page, found: true })
    : ok({ page: request.args.page, url, title: 'Notes', html: '<main>Current page</main>', loading: false, truncated: false }));
  const result = await act([{ do: 'click', selector: 'button' },
    { do: 'wait', page: 'bridge:work:8:DOC', selector: '#result', seconds: 0.1 }]) as any;
  expect(result.tabs.find((tab: any) => tab.page === page).post_action.check_status).toBe('not_requested');
});

const gone = (): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'work', attempts: 1, result: { command_id: 'gone', status: 'error', bridge_version: '0.0.12',
  duration_ms: 1, idempotency_key_seen: false, error: { code: 'selector_not_found', message: BRIDGE_PAGE_GONE_MESSAGE } } });
const nextPage = 'bridge:work:7:NEXT', nextUrl = 'https://example.org/notes/';
const currentRead = (p = nextPage) => ok({ page: p, url: nextUrl, title: 'Saved notes', html: '<main><h1>Saved notes</h1><button>View</button></main>', loading: false, truncated: false });

it('recovers one standalone whole-page inspection in its owning tab without replaying an action', async () => {
  const { adapter, dispatch } = setup(request => request.action === 'list_tabs' ? ok({ tabs: [
    { page: 'bridge:personal:7:OTHER', url: nextUrl, title: 'Other browser' }, { page: 'bridge:work:8:OTHER', url: nextUrl, title: 'Other tab' },
    { page: nextPage, url: nextUrl, title: 'Saved notes' }], truncated: false }) : request.args.page === page ? gone() : currentRead());
  const answer = await adapter({ slug: 'dom-inspect', risk_tier: 'read', input: {
    target: '*://*/*', page, form: 'outline', find: '', block: '', from: 0 }, output: {} });
  expect(answer).toMatchObject({ page: nextPage, url: nextUrl, outline: expect.stringContaining('Saved notes') });
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect', 'list_tabs', 'inspect']);
  expect(dispatch.mock.calls[1]![0].bridge_id).toBe('work');
  expect(dispatch.mock.calls[2]![0].args.page).toBe(nextPage);
});

it('keeps an unavailable batch binding unverified instead of presenting it as the current page', async () => {
  const { act, dispatch } = setup(() => gone());
  const error = await act([{ do: 'table' }]).catch(error => error);
  const failure = readBrowserFailure(error);
  expect(failure?.details.batch_progress).toMatchObject({ failed_step: 1, completed_steps: [], page_state: 'unknown' });
  expect(failure?.details.batch_progress).not.toHaveProperty('current_page');
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['read_table']);
});

it('recovers a post-submission whole read once in the owning tab/browser and keeps the passed check', async () => {
  const { act, dispatch } = setup(request => request.action === 'submit' ? ok({ page, url: nextUrl, submitted: true, moved: true })
    : request.action === 'list_tabs' ? ok({ truncated: false, tabs: [
      { page: 'bridge:personal:7:OTHER', url: nextUrl, title: 'Other browser' },
      { page: 'bridge:work:8:OTHER', url: nextUrl, title: 'Other tab' }, { page: nextPage, url: nextUrl, title: 'Saved notes' }] })
    : request.args.page === page ? gone() : currentRead());
  const result = await act([{ do: 'submit', selector: 'button', success_when: { page_changes: true } }, { do: 'read' }]) as any;
  expect(result).toMatchObject({ done: 2, page: nextPage, post_action: { action_status: 'acknowledged', check_status: 'passed',
    transition: 'new_document', current_page: nextPage, application_outcome: 'unverified', view_status: 'fresh' } });
  expect(result.tabs[0].reads[0]).toMatchObject({ step: 2, outline: expect.stringContaining('Saved notes') });
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['submit', 'inspect', 'list_tabs', 'inspect']);
  expect(dispatch.mock.calls[2]![0]).toMatchObject({ bridge_id: 'work' });
  expect(dispatch.mock.calls[3]![0].args.page).toBe(nextPage);
  expect(dispatch.mock.calls.every(([request]) => request.ingredient.domain_allowlist?.includes('*://*/*'))).toBe(true);
});

it('does not turn a passed predicate into a failed check when the following whole read fails', async () => {
  const { act, dispatch } = setup(request => request.action === 'submit' ? ok({ page, url: nextUrl, submitted: true, moved: true })
    : { kind: 'timeout', command_id: 'read', attempts: 1 });
  const error = await act([{ do: 'submit', selector: 'button', success_when: { page_changes: true } }, { do: 'read' }]).catch(error => error);
  expect(readBrowserFailure(error)?.details.post_action).toMatchObject({ action_status: 'acknowledged', check_status: 'passed',
    transition: 'unknown', view_status: 'unavailable', reason: 'read_failed' });
  expect(readBrowserFailure(error)?.details.batch_progress?.current_page).toBeUndefined();
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['submit', 'inspect']);
});

it('keeps an unobserved predicate unknown when its wait cannot be delivered', async () => {
  const { act } = setup(request => request.action === 'click' ? ok({ page, clicked: true })
    : request.action === 'wait_for_element' ? { kind: 'timeout', command_id: 'wait', attempts: 1 } : currentRead(page));
  const error = await act([{ do: 'click', selector: 'button' }, { do: 'wait', selector: '#saved', seconds: 0.1 }]).catch(error => error);
  expect(readBrowserFailure(error)?.details.post_action).toMatchObject({ action_status: 'acknowledged', check_status: 'unknown',
    view_status: 'fresh', application_outcome: 'unverified' });
});

it.each(['missing', 'other-browser', 'ambiguous', 'truncated'])('does not retarget a stale read with %s discovery evidence', async kind => {
  const tab = { page: nextPage, url: nextUrl, title: 'Notes' };
  const tabs = kind === 'missing' ? [] : kind === 'other-browser' ? [{ ...tab, page: 'bridge:personal:7:NEXT' }]
    : kind === 'ambiguous' ? [tab, { ...tab, page: 'bridge:work:7:ANOTHER' }] : [tab];
  const { act, dispatch } = setup(request => request.action === 'submit' ? ok({ page, submitted: true, moved: true, url: nextUrl })
    : request.action === 'list_tabs' ? ok({ tabs, truncated: kind === 'truncated' }) : gone());
  await expect(act([{ do: 'submit', selector: 'button' }, { do: 'read' }])).rejects.toThrow(BRIDGE_PAGE_GONE_MESSAGE);
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['submit', 'inspect', 'list_tabs']);
});

it('never retargets a document ref, selector, search or continuation offset', async () => {
  for (const scope of [{ ref: 'e1' }, { selector: 'main' }, { find: 'Saved' }, { from: 2 }]) {
    const { adapter, dispatch } = setup(() => gone());
    await expect(adapter({ slug: 'dom-inspect', risk_tier: 'read', input: { target: '*://*/*', page, ...scope }, output: {} })).rejects.toThrow(BRIDGE_PAGE_GONE_MESSAGE);
    expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect']);
  }
});

it('does not repeat a failed recovery through the post-action observer or replay its submission', async () => {
  const { act, dispatch } = setup(request => request.action === 'submit' ? ok({ page, submitted: true, moved: true, url: nextUrl })
    : request.action === 'list_tabs' ? ok({ truncated: false, tabs: [{ page: nextPage, url: nextUrl, title: 'Notes' }] }) : gone());
  const error = await act([{ do: 'submit', selector: 'button', success_when: { page_changes: true } }, { do: 'read' }]).catch(error => error);
  expect(readBrowserFailure(error)?.details.post_action).toMatchObject({ check_status: 'passed', transition: 'unknown', view_status: 'unavailable' });
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['submit', 'inspect', 'list_tabs', 'inspect']);
});

it('honors cancellation before discovering or reading a replacement document', async () => {
  const abort = new AbortController();
  const { act, dispatch } = setup(request => {
    if (request.action === 'submit') return ok({ page, submitted: true, moved: true, url: nextUrl });
    abort.abort(new Error('cancelled qualification')); return gone();
  });
  await expect(withRunAbortContext({ signal: abort.signal }, () => act([{ do: 'submit', selector: 'button' }, { do: 'read' }])))
    .rejects.toThrow('cancelled qualification');
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['submit', 'inspect']);
});

it('does not follow an unrelated stale whole-page read without an acknowledged action in this batch', async () => {
  const { act, dispatch } = setup(() => gone());
  await expect(act([{ do: 'read' }])).rejects.toThrow(BRIDGE_PAGE_GONE_MESSAGE);
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect']);
});

it('keeps a stale scoped read failed while a separate passive whole-page view observes the action result', async () => {
  const { act, dispatch } = setup(request => request.action === 'submit' ? ok({ page, submitted: true, moved: true, url: nextUrl })
    : request.action === 'list_tabs' ? ok({ truncated: false, tabs: [{ page: nextPage, url: nextUrl, title: 'Notes' }] })
      : request.args.page === page ? gone() : currentRead());
  const error = await act([{ do: 'submit', selector: 'button' }, { do: 'read', selector: 'main' }]).catch(error => error);
  const failure = readBrowserFailure(error)?.details;
  expect(failure?.batch_progress?.completed_steps).toEqual([1]);
  expect(failure?.completed_reads).toBeUndefined();
  expect(failure?.post_action).toMatchObject({ view_status: 'fresh', transition: 'new_document', current_page: nextPage });
  expect(dispatch.mock.calls.filter(([request]) => request.args.page === nextPage)
    .every(([request]) => request.args.selector === undefined && request.args.ref === undefined)).toBe(true);
});

it('bounds display text honestly and refuses cached or forged fresh views', () => {
  const state = { after_step: 1, action_status: 'acknowledged', check_status: 'failed', application_outcome: 'unverified', before_page: page,
    current_page: page, transition: 'same_document' } as const;
  const read = { page, url, outline: 'x'.repeat(20_000), read_state: { source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, complete: true, loading: false, truncated: false } };
  const bounded = browserPostActionState(state, read);
  expect(isBrowserPostActionState(bounded)).toBe(true);
  expect(bounded.view?.read_state).toMatchObject({ complete: false, truncated: true });
  expect(browserPostActionState(state, { ...read, read_state: { ...read.read_state, source: 'kept_snapshot' } })).toMatchObject({ view_status: 'unavailable', reason: 'not_fresh' });
  expect(isBrowserPostActionState({ ...bounded, application_outcome: 'success' })).toBe(false);
});

it('preserves the action receipt and valid error carrier under the aggregate evidence limit', () => {
  const observation: BrowserPageObservation = { state: 'snapshot', page, loading: false, source_truncated: false,
    changes: { added: Array.from({ length: 16 }, () => ({ text: 'x'.repeat(200) })), removed: [], added_total: 16, removed_total: 0, complete: true } };
  const post = browserPostActionState({ after_step: 19, action_status: 'acknowledged', check_status: 'failed', application_outcome: 'unverified',
    before_page: page, current_page: page, transition: 'same_document' }, { page, url: 'https://example.org/' + 'u'.repeat(2_000), outline: 'x'.repeat(3_000),
    read_state: { source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, loading: false, complete: true, truncated: false } });
  const details = limitBrowserFailureDetails({ post_action: post, page_observation: structuredClone(observation),
    completed_files: [{ step: 1, file_ref: 'file:' + 'a'.repeat(32), filename: 'report.pdf', mime_type: 'application/pdf', size_bytes: 128 }],
    batch_progress: { total_steps: 20, failed_step: 20, completed_steps: Array.from({ length: 19 }, (_, i) => i + 1),
      effects: Array.from({ length: 19 }, (_, i) => ({ step: i + 1, attempted: 1, acknowledged: 1 })), recovery: 'inspect_before_repeating_actions' },
    completed_reads: [{ step: 1, form: 'outline', content: 'old'.repeat(1_000), observation: { state: 'snapshot', page, loading: false, source_truncated: false } }] });
  expect(JSON.stringify(details).length).toBeLessThanOrEqual(12_000);
  expect(details.completed_files?.[0]?.filename).toBe('report.pdf');
  expect(readBrowserFailure({ code: 'DOM_CHECK_FAILED', browser_failure: { slug: 'dom-act', details } })?.details.post_action).toMatchObject({
    action_status: 'acknowledged', check_status: 'failed', application_outcome: 'unverified' });
});

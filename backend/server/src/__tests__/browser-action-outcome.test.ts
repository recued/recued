import { expect, it, vi } from 'vitest';
import { BRIDGE_PAGE_CHANGED_MESSAGE, BRIDGE_PAGE_GONE_MESSAGE, bridgeElementChangedMessage, readBrowserFailure, type ChatPriorToolCall, type RecipeDefinition } from '@recued/contracts';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { projectRunResultForAgent } from '../run-result-agent-projection.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const page = '7:OUTCOME', url = 'https://example.org/app/';
const html = '<main><h1>Welcome</h1><a ref="e14" href="/login">Login</a></main>';
const native = (result: unknown) => {
  const recipe = result && typeof result === 'object' && 'recipe_id' in result ? String(result.recipe_id) : 'act-on-web-page';
  const call: ChatPriorToolCall = { tool_name: `recued-core/${recipe}`, tier: 2, args: {}, status: 'error', result, started_at: 1, completed_at: 2 };
  return JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Use the browser.' }, prior_tool_calls: [call] }).body).prior_tool_calls[0].result;
};

it.each([BRIDGE_PAGE_CHANGED_MESSAGE, BRIDGE_PAGE_GONE_MESSAGE, bridgeElementChangedMessage('e14', 'New Login', 'Old Login')])(
  'projects legacy browser instructions as factual outcomes for native chat and MCP without changing the audit (%s)', legacy => {
  const message = `Stopped at step 1 of 2: ${legacy} No step was confirmed complete.`;
  const result = { recipe_id: 'act-on-web-page', success: false, errors: [{ code: 'DOM_SELECTOR_NOT_FOUND',
    source: { ingredient_slug: 'dom-act' }, message,
    details: { batch_progress: { total_steps: 2, failed_step: 1, completed_steps: [], effects: [], page_state: 'ready', current_page: page,
      next_step: { do: 'read', page, form: 'outline' }, recovery: 'inspect_before_repeating_actions' } } }],
    steps: [{ id: 'act', type: 'ingredient', error: message }],
    output: { render: [{ type: 'json', data: { outline: 'The page literally says: inspect it again.' } }] } };
  const before = JSON.stringify(result);
  for (const sent of [native(result), projectRunResultForAgent(result) as typeof result]) {
    expect(sent.errors[0].message).not.toMatch(/inspect.*again/i);
    expect(sent.errors[0].details.batch_progress).toEqual({ total_steps: 2, failed_step: 1, completed_steps: [], effects: [], page_state: 'ready', current_page: page });
    expect(sent.browser_attention).toMatchObject({ kind: 'batch_stopped', failed_step: 1, completed_steps: [] });
    expect(sent.browser_attention).not.toHaveProperty('next_step');
    expect(sent.steps[0].error).not.toMatch(/inspect.*again/i);
    expect(sent.output.render[0].data.outline).toBe(result.output.render[0].data.outline);
  }
  expect(JSON.stringify(result)).toBe(before);
});

it.each([
  ['inspect-web-page', 'dom-inspect', 'DOM_SELECTOR_NOT_FOUND', BRIDGE_PAGE_GONE_MESSAGE, 'The referenced page document is no longer available.'],
  ['click-web-element', 'dom-click', 'DOM_SELECTOR_NOT_FOUND', BRIDGE_PAGE_GONE_MESSAGE, 'The referenced page document is no longer available.'],
  ['read-web-table', 'dom-table', 'DOM_SELECTOR_NOT_FOUND', BRIDGE_PAGE_GONE_MESSAGE, 'The referenced page document is no longer available.'],
  ['open-web-page', 'dom-open', 'ACTION_DELIVERY_UNCERTAIN', 'The tab opened, but its page had not finished loading. List the tabs, or inspect it, before opening it again.', 'The tab opened, but its page had not finished loading.'],
  ['open-web-page', 'dom-open', 'ACTION_DELIVERY_UNCERTAIN', 'The tab opened, but its page could not be read yet. List the tabs, or inspect it, before opening it again.', 'The tab opened, but its page could not be read yet.'],
])('reports standalone %s outcomes without prescribing inspection', (recipe_id, ingredient_slug, code, message, expected) => {
    const run = { recipe_id, success: false, errors: [{ code, source: { ingredient_slug }, message }] };
    for (const sent of [native(run), projectRunResultForAgent(run) as typeof run]) {
      expect(sent.errors[0].code).toBe(code);
      expect(sent.errors[0].message).toBe(expected);
    }
    expect(run.errors[0].message).toBe(message);
  });

const fixture = (changed: 'none' | 'url' | 'document' | 'loading' | 'truncated' | 'editable' | 'read-failed' | 'uncertain' | 'unknown-url' = 'none') => {
  let reads = 0;
  const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
    const reply = { kind: 'completed' as const, bridge_client_token_id: 'owner', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.12', idempotency_key_seen: false, status: 'ok' as const, outputs: {} } };
    if (request.action === 'fill') return { ...reply, result: { ...reply.result, status: 'error',
      error: changed === 'uncertain' ? { code: 'delivery_uncertain', message: 'No acknowledgment' }
        : { code: 'value_not_applied', message: 'The element is not a field or an editor.' } } };
    reads++;
    if (reads > 1 && changed === 'read-failed') throw Error('No observation');
    return { ...reply, result: { ...reply.result, outputs: { page: reads > 1 && changed === 'document' ? '7:OTHER' : page,
      url: reads === 1 && changed === 'unknown-url' ? '' : reads > 1 && changed === 'url' ? url + 'redirect' : url, title: 'App',
      html: reads > 1 && changed === 'editable' ? '<main><input ref="e14" aria-label="Email"></main>' : html,
      loading: reads === 1 || changed === 'loading', truncated: changed === 'truncated' } } };
  });
  const dispatcher = { dispatch, canResolve: () => true, cancel: vi.fn() };
  const adapter = createBridgeDomAdapter({ getDispatcher: () => dispatcher, pageReads: createPageReadStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null } });
  return { adapter, dispatch };
};

const failedFill = async (changed?: Parameters<typeof fixture>[0]) => {
  const { adapter, dispatch } = fixture(changed);
  await adapter({ slug: 'dom-inspect', input: { target: '*://*/*', page, form: 'outline' }, output: {}, risk_tier: 'read' });
  const recipe: RecipeDefinition = { recipe_id: 'act-on-web-page', version: 27, ttl: 0,
    metadata: { name: 'Act', description: 'Action outcome fixture', author: 'recued-core', supported_platforms: [] }, variables: {}, prefetch_steps: [],
    steps: [{ id: 'act', ingredient: 'dom-act', input: { target: '*://*/*', page, steps: [{ do: 'type', ref: 'e14', value: 'fixture' }, { do: 'read' }] } }],
    output: { render: [{ type: 'json', source: 'step.act' }] } };
  const context: ExecutionContext = { recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
    ingredientExecutor: async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' }) };
  return { run: await executeRecipe(context), dispatch };
};

it('adds the existing control correction from a refused fill\'s passive observation, without replaying or clicking', async () => {
  const { run, dispatch } = await failedFill();
  expect(run.success).toBe(false);
  const failure = readBrowserFailure({ ...run.errors[0], browser_failure: { slug: 'dom-act', details: run.errors[0]?.details } });
  expect(failure?.details.control_correction).toMatchObject({ ref: 'e14', kind: 'link', name: 'Login', requested_action: 'type', supported_actions: ['click'] });
  expect(failure?.details.batch_progress).toMatchObject({ failed_step: 1, completed_steps: [], effects: [{ step: 1, attempted: 1, acknowledged: 0 }] });
  expect(failure?.details.batch_progress).not.toHaveProperty('recovery');
  expect(failure?.details.batch_progress).not.toHaveProperty('next_step');
  expect(native(run).control_correction).toMatchObject({ ref: 'e14', kind: 'link', supported_actions: ['click'] });
  expect(native(run).browser_state).toMatchObject({ action_status: 'refused', application_outcome: 'unverified', view_status: 'fresh' });
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect', 'fill', 'reread']);
});

it.each(['url', 'document', 'loading', 'truncated', 'editable', 'read-failed', 'uncertain', 'unknown-url'] as const)(
  'does not infer a clickable replacement after a %s observation', async changed => {
    const { run, dispatch } = await failedFill(changed);
    expect(run.success).toBe(false);
    const failure = readBrowserFailure({ ...run.errors[0], browser_failure: { slug: 'dom-act', details: run.errors[0]?.details } });
    expect(failure?.details.batch_progress).toBeDefined();
    expect(failure?.details.control_correction).toBeUndefined();
    expect(native(run)).not.toHaveProperty('control_correction');
    if (changed === 'uncertain') expect(native(run).browser_state).toMatchObject({ action_status: 'uncertain', view_status: 'unavailable', reason: 'delivery_uncertain' });
    expect(dispatch.mock.calls.filter(([request]) => request.action === 'fill')).toHaveLength(1);
    expect(dispatch.mock.calls.some(([request]) => request.action === 'click')).toBe(false);
  });

// 2026-11-21 (the owner: "c yes", the notice) — text sent to a field behind the dialog open on the page: the Bridge's
// write refuses any field outside an open dialog, so nothing was typed, and the host's fresh, whole read after the
// refusal says why (`control_blocked`). On browser task P two runs failed on the notice alone after one
// (`recued-bridge-vs-browser-use/results/analysis/2026-11-21-P-calibration-F-ec66850f1`, T64-r3 and r4).
const DIALOG_REFUSAL = 'An open dialog blocks this field. Use the control inside the active dialog.';
const dialogPage = (dialog: 'open' | 'closed' | 'no-controls') => '<main><h1>Notes</h1><input ref="e14" aria-label="Search notes"></main>'
  + (dialog === 'closed' ? '' : `<div role="dialog" aria-modal="true" aria-label="Edit note"><h2>Edit note</h2>${dialog === 'open'
    ? '<input ref="e20" aria-label="Title"><button ref="e21">Save</button>' : '<p>Saving…</p>'}</div>`);
const refusedBehindDialog = async (after: 'open' | 'closed' | 'no-controls') => {
  let reads = 0;
  const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
    const reply = { kind: 'completed' as const, bridge_client_token_id: 'owner', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.13', idempotency_key_seen: false, status: 'ok' as const, outputs: {} } };
    if (request.action === 'fill') return { ...reply, result: { ...reply.result, status: 'error', error: { code: 'value_not_applied', message: DIALOG_REFUSAL } } };
    reads++;
    return { ...reply, result: { ...reply.result, outputs: { page, url, title: 'Notes', html: dialogPage(reads === 1 ? (after === 'no-controls' ? 'no-controls' : 'open') : after),
      loading: reads === 1, truncated: false } } };
  });
  const adapter = createBridgeDomAdapter({ getDispatcher: () => ({ dispatch, canResolve: () => true, cancel: vi.fn() }), pageReads: createPageReadStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null } });
  await adapter({ slug: 'dom-inspect', input: { target: '*://*/*', page, form: 'outline' }, output: {}, risk_tier: 'read' });
  const recipe: RecipeDefinition = { recipe_id: 'act-on-web-page', version: 27, ttl: 0,
    metadata: { name: 'Act', description: 'Dialog fixture', author: 'recued-core', supported_platforms: [] }, variables: {}, prefetch_steps: [],
    steps: [{ id: 'act', ingredient: 'dom-act', input: { target: '*://*/*', page, steps: [{ do: 'type', ref: 'e14', value: 'stock' }, { do: 'read' }] } }],
    output: { render: [{ type: 'json', source: 'step.act' }] } };
  const run = await executeRecipe({ recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
    ingredientExecutor: async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' }) });
  return { run, dispatch, failure: readBrowserFailure({ ...run.errors[0], browser_failure: { slug: 'dom-act', details: run.errors[0]?.details } }) };
};

it('records a refused fill\'s target behind the open dialog, from its fresh read, without replaying it', async () => {
  const { run, dispatch, failure } = await refusedBehindDialog('open');
  expect(run.success).toBe(false);
  expect(failure?.details.control_blocked).toEqual({ ref: 'e14', kind: expect.any(String), name: 'Search notes', requested_action: 'type',
    blocked_by: 'dialog', source: 'fresh_kept_read' });
  expect(failure?.details.control_correction).toBeUndefined();
  expect(failure?.details.batch_progress).toMatchObject({ failed_step: 1, effects: [{ step: 1, attempted: 1, acknowledged: 0 }] });
  expect(failure?.details.post_action).toMatchObject({ action_status: 'refused', view_status: 'fresh', transition: 'same_document' });
  expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect', 'fill', 'reread']);
});

it.each(['closed', 'no-controls'] as const)('records no block when the fresh read shows the dialog %s', async after => {
  const { failure, dispatch } = await refusedBehindDialog(after);
  expect(failure?.details.batch_progress).toBeDefined();
  expect(failure?.details.control_blocked).toBeUndefined();
  expect(dispatch.mock.calls.filter(([request]) => request.action === 'fill')).toHaveLength(1);
});

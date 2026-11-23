import { expect, it, vi } from 'vitest';
import { BROWSER_POST_ACTION_CHARS, isBrowserCurrentView, readBrowserFailure, type BrowserFieldEvidence, type ChatPriorToolCall, type RecipeDefinition } from '@recued/contracts';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { browserPostActionState } from '../bridges/browser-post-action.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { projectRunResultForAgent } from '../run-result-agent-projection.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const page = '7:PARITY', url = 'https://example.org/orders';
const native = (result: unknown, tool = 'act-on-web-page') => {
  const call: ChatPriorToolCall = { tool_name: `recued-core/${tool}`, tier: 2, args: {}, status: 'error', result, started_at: 1, completed_at: 2 };
  return JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Use the browser.' }, prior_tool_calls: [call] }).body).prior_tool_calls[0].result;
};
const fields: BrowserFieldEvidence = { scope: 'main', complete: true, note: 'Literal fields',
  items: [{ tag: 'a', ref: 'e14', fields: { text: { value: '.name Grandfathered', source: 'textContent' } } }] };
const targets = { source: 'captured_dom', scope: 'page', source_complete: true, tables_complete: true,
  tables: [{ step: { do: 'table', selector: '#orders' } }] };
const state = { after_step: 1, action_status: 'acknowledged', check_status: 'not_requested', application_outcome: 'unverified',
  before_page: page, current_page: page, transition: 'same_document' } as const;
const read = () => ({ page, url, title: 'Orders', outline: 'Current controls',
  read_state: { source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, loading: false, complete: true, truncated: false },
  field_evidence: fields, extraction_targets: targets });

it('promotes the existing standalone typing correction through native chat and MCP without changing its audit', () => {
  const correction = { ref: 'e14', kind: 'link', name: 'Login', requested_action: 'type', supported_actions: ['click'], source: 'fresh_kept_read' };
  const run = { recipe_id: 'type-into-web-page', success: false, errors: [{ code: 'DOM_WRITE_FAILED', source: { ingredient_slug: 'dom-write' },
    message: 'Typing targeted a link.', details: { control_correction: correction } }] };
  const before = JSON.stringify(run);
  for (const sent of [native(run, run.recipe_id), projectRunResultForAgent(run) as Record<string, unknown>]) expect(sent.control_correction).toEqual(correction);
  expect(JSON.stringify(run)).toBe(before);
  expect(native({ ...run, errors: [{ ...run.errors[0], details: { control_correction: { ...correction, supported_actions: ['submit'] } } }] }, run.recipe_id)).not.toHaveProperty('control_correction');
});

it.each(['action', 'condition'] as const)('preserves literal fields and table targets from the existing %s-failure read through the engine and native boundary', async kind => {
  const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'owner', attempts: 1,
    result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.12', idempotency_key_seen: false, status: 'ok',
      outputs: request.action === 'click' ? { page, url, clicked: true, sent: true }
        : request.action === 'wait_for_element' ? { page, url, found: false }
        : { page, url, title: 'Orders', loading: false, truncated: false,
          html: '<main><a ref="e14" href="/article">.name Grandfathered</a><table id="orders"><tr><th>ID</th><th>Name</th></tr><tr><td>1</td><td>Arden</td></tr></table></main>' } } }));
  const adapter = createBridgeDomAdapter({ getDispatcher: () => ({ dispatch, canResolve: () => true, cancel: vi.fn() }), pageReads: createPageReadStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null } });
  const steps = kind === 'action' ? [{ do: 'click', selector: '#save' }, { do: 'wait', selector: '#missing', seconds: 0.01 }, { do: 'read' }]
    : [{ do: 'wait', selector: '#missing', seconds: 0.01 }, { do: 'read' }];
  const recipe: RecipeDefinition = { recipe_id: 'act-on-web-page', version: 27, ttl: 0,
    metadata: { name: 'Act', description: 'View parity fixture', author: 'recued-core', supported_platforms: [] }, variables: {}, prefetch_steps: [],
    steps: [{ id: 'act', ingredient: 'dom-act', input: { target: '*://*/*', page, steps } }], output: { render: [{ type: 'json', source: 'step.act' }] } };
  const context: ExecutionContext = { recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
    ingredientExecutor: async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' }) };
  const run = await executeRecipe(context);
  expect(run.success).toBe(false);
  const failure = readBrowserFailure({ ...run.errors[0], browser_failure: { slug: 'dom-act', details: run.errors[0]?.details } });
  expect(failure).toBeDefined();
  const sent = native(run), view = kind === 'action' ? sent.browser_state.view : sent.browser_observation.view;
  expect(view.field_evidence.items.some((item: { fields: { text?: { value: string } } }) => item.fields.text?.value === '.name Grandfathered')).toBe(true);
  expect(view.extraction_targets.tables).toHaveLength(1);
  expect(view.extraction_targets.tables[0].step).toEqual({ do: 'table', selector: '#orders' });
  expect(view.read_state).toMatchObject({ loading: false, complete: true });
  expect(dispatch.mock.calls.filter(([request]) => ['inspect', 'reread'].includes(request.action)).map(([request]) => request.action)).toEqual(['reread']);
  expect(failure?.details.batch_progress?.completed_steps).toEqual(kind === 'action' ? [1] : []);
});

it('omits oversized optional metadata explicitly while preserving the existing outline and its coverage', () => {
  const input = { ...read(), field_evidence: { ...fields, items: Array.from({ length: 16 }, () => ({ tag: 'a', fields: { text: { value: '名'.repeat(900), source: 'textContent' } } })) } };
  const before = JSON.stringify(input), result = browserPostActionState(state, input);
  expect(result.view_status).toBe('fresh');
  expect(result.view?.outline).toBe(input.outline);
  expect(result.view?.read_state.complete).toBe(true);
  expect(result.view?.field_evidence).toBeUndefined();
  expect(result.view?.omitted).toContain('field_evidence');
  expect(result.view?.extraction_targets).toEqual(targets);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(BROWSER_POST_ACTION_CHARS);
  expect(isBrowserCurrentView({ ...result.view, field_evidence: fields })).toBe(false);
  expect(JSON.stringify(input)).toBe(before);
});

it('preserves small Unicode literals exactly and rejects unrelated metadata in the current-view contract', () => {
  const input = { ...read(), field_evidence: { ...fields, items: [{ tag: 'a', fields: { text: { value: '.name 中文 العربية', source: 'textContent' } } }] } };
  const result = browserPostActionState(state, input);
  expect(result.view?.field_evidence?.items[0]?.fields.text?.value).toBe('.name 中文 العربية');
  expect(result.view?.omitted).toBeUndefined();
  expect(isBrowserCurrentView({ ...result.view, field_evidence: { ...fields, secret: 'extra' } })).toBe(false);
});

it('returns a factual continuation cursor for a partial read without changing its captured source', () => {
  const captured = { ...read(), read_state: { ...read().read_state, complete: false }, next_step: { do: 'read', page, form: 'outline', from: 20 } };
  const run = { recipe_id: 'inspect-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: captured }] } };
  const before = JSON.stringify(run), sent = native(run, run.recipe_id);
  expect(sent.browser_attention).toMatchObject({ kind: 'partial_read', complete: false, continuation: { page, form: 'outline', from: 20 } });
  expect(sent.browser_attention).not.toHaveProperty('next_step');
  expect(sent.browser_attention.continuation).not.toHaveProperty('do');
  expect(sent.browser_attention.note).not.toMatch(/continue the view|query the|inspect|restart/i);
  expect(sent.output.render[0].data.read_state.complete).toBe(false);
  expect(JSON.stringify(run)).toBe(before);
});

it('retires a partial view\'s continuation when a newer full-page observation supersedes it', () => {
  const earlier = { ...read(), read_state: { ...read().read_state, complete: false }, next_step: { do: 'read', page, from: 20 } };
  const calls: ChatPriorToolCall[] = [earlier, read()].map((value, index) => ({ tool_name: 'recued-core/inspect-web-page', tier: 2, args: { page },
    status: 'ok', started_at: index, completed_at: index + 1,
    result: { recipe_id: 'inspect-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: value }] } } }));
  const sent = JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Use the browser.' }, prior_tool_calls: calls }).body).prior_tool_calls;
  expect(sent[0].result.browser_attention.historical).toBe(true);
  expect(sent[0].result.browser_attention).not.toHaveProperty('continuation');
  expect(sent[0].result.output.render[0].data.read_state.complete).toBe(false);
  expect(sent[1].result.output.render[0].data.read_state.context.current_for_controls).toBe(true);
});

it('does not promote literal fields from a loading snapshot or upgrade its table-source coverage', () => {
  const input = { ...read(), read_state: { ...read().read_state, loading: true, complete: false },
    extraction_targets: { ...targets, source_complete: false, tables_complete: false } };
  const result = browserPostActionState(state, input);
  expect(result.view_status).toBe('fresh');
  expect(result.view?.field_evidence).toBeUndefined();
  expect(result.view?.extraction_targets?.source_complete).toBe(false);
  expect(result.view?.read_state.complete).toBe(false);
  expect(isBrowserCurrentView({ ...result.view, field_evidence: fields })).toBe(false);
});

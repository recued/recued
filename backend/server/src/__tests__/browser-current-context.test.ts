import { expect, it, vi } from 'vitest';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { isBrowserInteractionTargets, BROWSER_INTERACTION_TARGETS_CHARS, BROWSER_COLLECT_MAX_PAGES, BROWSER_COLLECT_MAX_ITEMS,
  BROWSER_COLLECT_MAX_SECONDS, parseBrowserActSteps, type ChatPriorToolCall, type RecipeDefinition } from '@recued/contracts';
import { browserEditorTextTargets, browserInteractionTargets } from '../bridges/browser-interaction-targets.js';
import { browserFieldEvidence } from '../bridges/browser-field-evidence.js';
import { browserPostActionState } from '../bridges/browser-post-action.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { projectRunResultForAgent } from '../run-result-agent-projection.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const page = '7:LANDING', url = 'https://example.org/app';
const landing = '<main><a ref="e24" href="/app/login">Login</a></main>';
const form = '<main><form><label for="email">Email address</label><input id="email" name="email" type="text" ref="e23" value="PRIVATE-EMAIL">'
  + '<input type="password" name="password" ref="e25" value="PRIVATE-PASSWORD"><button type="submit" ref="e26">Login</button></form></main>';
const read = (html = landing, target = page, loading = false) => ({ page: target, url, title: 'App', outline: 'Observed page',
  read_state: { source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, loading, complete: !loading, truncated: false },
  interaction_targets: browserInteractionTargets(html, { whole: true, truncated: false, loading }) });
const inspection = (value = read()) => ({ recipe_id: 'inspect-web-page', success: true, errors: [],
  output: { render: [{ type: 'json', data: value }] } });
const post = (value = read(form, '7:LOGIN'), before = page) => browserPostActionState({ after_step: 1, action_status: 'acknowledged',
  check_status: 'not_requested', application_outcome: 'unverified', before_page: before, current_page: value.page,
  transition: value.page === before ? 'same_document' : 'new_document' }, value);
const call = (result: unknown, args: Record<string, unknown> = { page }, tool = 'inspect-web-page'): ChatPriorToolCall => ({
  tool_name: `recued-core/${tool}`, tier: 2, args, status: 'ok', result, started_at: 1, completed_at: 2 });
const packet = (calls: ChatPriorToolCall[], dedup = true) => composeChatMainTurnPromptParts({ available_tools: [{ recipe_slug: 'recued-core/act-on-web-page' }],
  content: { chat_tail: [], user_message: 'Use my browser.' }, prior_tool_calls: calls, deduplicate_browser_reads: dedup });

it('projects exact, unambiguous tooltip labels in request order from the current observation', () => {
  const row = (label: string, title: string) => '<li>' + label + ' <abbr title="' + title + '">AC</abbr></li>';
  const entries = row('West dock', 'Anchor clearance') + row('East dock', 'Access check');
  const prompt = (html: string, request: string) => {
    const observation = { ...read(html), field_evidence: browserFieldEvidence(html, { whole: true, truncated: false }) };
    return JSON.parse(composeChatMainTurnPromptParts({
      available_tools: [{ recipe_slug: 'recued-core/inspect-web-page' }],
      content: { chat_tail: [], user_message: request },
      prior_tool_calls: [call(inspection(observation))],
    }).body);
  };
  const question = 'Read the definitions for East dock, then West dock.';
  const sent = prompt('<ul>' + entries + '</ul>', question);
  expect(sent.browser_context.pages[0].titles_in_request_order).toEqual([
    { label: 'East dock', title_attribute: 'Access check' },
    { label: 'West dock', title_attribute: 'Anchor clearance' },
  ]);
  const original = sent.prior_tool_calls[0].result.output.render[0].data.field_evidence;
  expect(original.items[0].fields.title_attribute.value).toBe('Anchor clearance');
  const ambiguous = prompt('<ul>' + entries + row('East dock', 'Alternate check') + '</ul>', question);
  expect(ambiguous.browser_context.pages[0]).not.toHaveProperty('titles_in_request_order');
  const partialLabel = prompt('<ul>' + entries + '</ul>', 'Read the definitions for East dockside and West dock.');
  expect(partialLabel.browser_context.pages[0]).not.toHaveProperty('titles_in_request_order');
});

it('grounds partial rich-text edits in editable children and leaves ambiguous or read-only text out', () => {
  const html = '<div ref="e1" id="note" contenteditable="true"><b>Notice</b><p>First paragraph</p>'
    + '<p>Another paragraph with <time>3:30</time> and a <span contenteditable="false"><em>locked note</em></span></p></div>';
  expect(browserEditorTextTargets(html)).toEqual([{ text: 'Notice', selector: '#note b' }, { text: '3:30', selector: '#note time' }]);
});

it('exposes the observed selector of a labelled board lane when the capture includes drag sources', () => {
  const html = '<section id="queue" aria-labelledby="heading"><h2 id="heading">Queue</h2>'
    + '<ul><li ref="e1" draggable="true">Card</li></ul></section><section id="ready" aria-label="Ready"></section>';
  const targets = browserInteractionTargets(html, { whole: true, truncated: false });
  expect(isBrowserInteractionTargets(targets)).toBe(true);
  expect(targets.drag_destinations).toEqual([{ label: 'Queue', selector: '#queue' }, { label: 'Ready', selector: '#ready' }]);
});

it('separates links from actual fields without copying field values, and keeps fields before a large menu', () => {
  const menu = '<nav>' + Array.from({ length: 25 }, (_, i) => `<a ref="e${i + 100}">Menu ${i}</a>`).join('') + '</nav>';
  const target = browserInteractionTargets(menu + form, { whole: true, truncated: false });
  expect(isBrowserInteractionTargets(target)).toBe(true);
  expect(target).toMatchObject({ captured_editable_fields: 2, items_complete: false });
  expect(target.items.slice(0, 3)).toMatchObject([
    { ref: 'e23', tag: 'input', type: 'text', label: 'Email address', actions: ['type'] },
    { ref: 'e25', tag: 'input', type: 'password', label: 'password', actions: ['type'] },
    { ref: 'e26', tag: 'button', type: 'submit', label: 'Login', actions: ['click'] },
  ]);
  expect(JSON.stringify(target)).not.toContain('PRIVATE-');
  expect(JSON.stringify(target).length).toBeLessThanOrEqual(BROWSER_INTERACTION_TARGETS_CHARS);
  expect(browserInteractionTargets(menu + landing, { whole: true, truncated: false }).items[0]).toMatchObject({ ref: 'e24', actions: ['click'] });
  expect(browserInteractionTargets(landing, { whole: true, truncated: false })).toMatchObject({
    captured_editable_fields: 0, items: [{ ref: 'e24', tag: 'a', label: 'Login', actions: ['click'] }],
  });
});

it('keeps a submit before reset in a crowded form and offers a current-document submit/read batch without field values', () => {
  const html = '<main><form>' + Array.from({ length: 11 }, (_, i) => `<input ref="e${i + 1}" placeholder="Field ${i}"`
    + (i === 0 ? ' type="password" value="PRIVATE"' : '') + '>').join('')
    + '<button ref="e12" type="reset">Reset</button><button ref="e13" type="submit">Send</button></form></main>';
  const sent = JSON.parse(packet([call(inspection(read(html)))]).body).browser_context;
  const targets = sent.pages[0].interaction_targets;
  expect(targets.captured_editable_fields).toBe(11);
  expect(targets.items.map((item: { ref: string }) => item.ref)).toEqual([...Array.from({ length: 11 }, (_, i) => `e${i + 1}`), 'e13']);
  const example = targets.items.at(-1).call_example;
  expect(example.args).toEqual({ page, steps: [{ do: 'click', ref: 'e13' }, { do: 'read', form: 'outline' }] });
  expect(parseBrowserActSteps(example.args.steps, { page }).ok).toBe(true);
  expect(JSON.stringify(sent).length).toBeLessThanOrEqual(6_000);
  expect(JSON.stringify(sent)).not.toContain('PRIVATE');
});

it('retains literal attributes and modal/disabled scope, including the first-legend exception', () => {
  const html = '<input ref="e1"><div role="dialog" aria-modal="true"><fieldset disabled><legend><input ref="e2"></legend><input ref="e3"></fieldset>'
    + '<textarea ref="e4" readonly>PRIVATE-TEXT</textarea><div ref="e5" contenteditable="plaintext-only">PRIVATE-EDITOR</div>'
    + '<span ref="e6" role="combobox" aria-label="Category"></span><select ref="e7"><option>Work</option></select>'
    + '<input ref="e8" type="text" hidden><input ref="e9" type="checkbox" readonly></div>';
  const out = browserInteractionTargets(html, { whole: true, truncated: false });
  expect(out.scope).toBe('dialog');
  expect(out.items.map(item => item.ref)).not.toContain('e1');
  expect(out.items.map(item => item.ref)).not.toContain('e8');
  expect(out.items.find(item => item.ref === 'e2')).toMatchObject({ actions: ['type'] });
  expect(out.items.find(item => item.ref === 'e2')).not.toHaveProperty('type');
  expect(out.items.find(item => item.ref === 'e3')).toMatchObject({ disabled: true, actions: [] });
  expect(out.items.find(item => item.ref === 'e4')).toMatchObject({ readonly: true, actions: [] });
  expect(out.items.find(item => item.ref === 'e5')).toMatchObject({ contenteditable: 'plaintext-only', actions: ['type'] });
  expect(out.items.find(item => item.ref === 'e6')).toMatchObject({ tag: 'span', role: 'combobox', actions: ['click'] });
  expect(out.items.find(item => item.ref === 'e7')).toMatchObject({ tag: 'select', actions: ['type'] });
  expect(out.items.find(item => item.ref === 'e9')).toMatchObject({ type: 'checkbox', actions: ['type'] });
  expect(JSON.stringify(out)).not.toContain('PRIVATE-');
});

it('keeps duplicate record actions associated with their titles across record order changes and a nested dialog', () => {
  const record = (title: string, n: number, modal = '') => `<div><div><div></div><div>${title}</div><input ref="e${n}" type="checkbox">`
    + `<a ref="e${n + 1}">View</a><button ref="e${n + 2}">Edit</button><button ref="e${n + 3}">Remove</button>${modal}</div></div>`;
  const heading = '<main><input ref="e1" placeholder="Search">' + Array.from({ length: 10 }, (_, i) => `<button ref="e${70 + i}">Filter ${i}</button>`).join('');
  const alpha = record('Alpha record', 10), beta = record('Beta record', 20);
  for (const cards of [alpha + beta, beta + alpha]) {
    const out = browserInteractionTargets(heading + '<div>' + cards + '</div></main>', { whole: true, truncated: false });
    expect(isBrowserInteractionTargets(out)).toBe(true);
    for (const [ref, label] of [['e12', 'Alpha record'], ['e22', 'Beta record']]) {
      const action = out.items.find(item => item.ref === ref)!;
      expect(action).toMatchObject({ label: 'Edit', actions: ['click'] });
      expect(out.contexts!.find(context => context.id === action.context)?.label).toBe(label);
    }
    expect(out.contexts!.find(context => context.position === 1)?.label).toBe(cards.startsWith(alpha) ? 'Alpha record' : 'Beta record');
  }
  const modal = '<div role="dialog" aria-modal="true"><h5>Edit item</h5><input ref="e40" value="PRIVATE-TITLE">'
    + '<input ref="e41" type="password" value="PRIVATE-PASSWORD"><button ref="e42" type="submit">Save</button></div>';
  const out = browserInteractionTargets('<main><div>' + record('Beta record', 20, modal) + alpha + '</div></main>', { whole: true, truncated: false });
  expect(out.scope).toBe('dialog');
  expect(out.items.map(item => item.ref)).toEqual(['e40', 'e41', 'e42']);
  expect(out.items.every(item => out.contexts!.find(context => context.id === item.context)?.label === 'Beta record')).toBe(true);
  expect(JSON.stringify(out)).not.toContain('PRIVATE-');
});

it('uses one ordered record for nested list/article wrappers and prioritizes its heading link despite a longer title attribute', () => {
  const html = '<main><h1>Results</h1><ol>' + ['First', 'Second', 'Third'].map((label, i) => `<li><article>`
    + `<a ref="e${i * 3 + 1}"><img alt="${label}"></a><h3><a ref="e${i * 3 + 2}" title="${label} complete title">${label} ...</a></h3>`
    + `<button ref="e${i * 3 + 3}">Buy</button></article></li>`).join('') + '</ol></main>';
  const out = browserInteractionTargets(html, { whole: true, truncated: false });
  expect(isBrowserInteractionTargets(out)).toBe(true);
  expect(out.items.slice(0, 3).map(item => item.ref)).toEqual(['e2', 'e5', 'e8']);
  expect(out.contexts!.map(context => [context.label, context.position])).toEqual([['First ...', 1], ['Second ...', 2], ['Third ...', 3]]);
  expect(out.headings).toEqual(['Results']);
});

it('keeps literal rank and title/ref associations ahead of navigation without sorting by score', () => {
  const nav = '<nav>' + Array.from({ length: 20 }, (_, i) => `<a ref="e${100 + i}">Navigation ${i}</a>`).join('') + '</nav>';
  const html = nav + '<table><tbody><tr><td>1.</td><td><a ref="e1"></a></td><td><a ref="e2">First ranked item</a></td></tr>'
    + '<tr><td></td><td colspan="2">3 points by <a ref="e3">User one</a><a ref="e4">2 comments</a></td></tr>'
    + '<tr><td>2.</td><td><a ref="e5"></a></td><td><a ref="e6">Higher score item</a></td></tr>'
    + '<tr><td></td><td colspan="2">900 points by <a ref="e7">User two</a><a ref="e8">100 comments</a></td></tr></tbody></table>';
  const sent = JSON.parse(packet([call(inspection(read(html)))]).body).browser_context.pages[0].interaction_targets;
  expect(sent.items[0]).toMatchObject({ ref: 'e2', label: 'First ranked item', target: { page, ref: 'e2' } });
  expect(sent.contexts.find((context: { ordinal?: string }) => context.ordinal === '1.')).toMatchObject({ label: 'First ranked item' });
  expect(sent.contexts.find((context: { ordinal?: string }) => context.ordinal === '2.')).toMatchObject({ label: 'Higher score item' });
  expect(sent.contexts).toHaveLength(2);
});

it('does not infer a portalled dialog record, invent field values, or accept a dangling context reference', () => {
  const html = '<main><article><h3>Alpha</h3><button ref="e1">Edit</button></article>'
    + '<article><h3>Beta</h3><button ref="e2">Edit</button></article>'
    + '<div role="dialog" aria-modal="true"><h2>Edit item</h2><input ref="e3" value="PRIVATE">'
    + '<button ref="e4" disabled>Save</button><div contenteditable="true"><h3>PRIVATE-EDITOR</h3></div></div>'
    + '<footer><h2>Unrelated footer</h2></footer></main>';
  const out = browserInteractionTargets(html, { whole: true, truncated: false, loading: true });
  expect(isBrowserInteractionTargets(out)).toBe(true);
  expect(out).toMatchObject({ scope: 'dialog', source_complete: false, headings: ['Edit item'] });
  expect(out).not.toHaveProperty('contexts');
  expect(out.items.every(item => item.context === undefined)).toBe(true);
  expect(out.items.find(item => item.ref === 'e4')).toMatchObject({ disabled: true, actions: [] });
  expect(JSON.stringify(out)).not.toContain('PRIVATE');
  expect(isBrowserInteractionTargets({ ...out, items: [{ ...out.items[0], context: 'g1' }] })).toBe(false);
  expect(isBrowserInteractionTargets({ ...out, contexts: [{ id: 'g1', kind: 'item', label: 'Alpha', position: 1, value: 'PRIVATE' }] })).toBe(false);
});

it('offers application controls before navigation nested inside main without guessing labels or field values', () => {
  const navigation = '<nav>' + Array.from({ length: 20 }, (_, i) => `<a ref="e${100 + i}">Crumb ${i}</a>`).join('') + '</nav>';
  const html = '<main>' + navigation + '<a ref="e1">Enter workspace</a><a ref="e2">Enroll</a><a ref="e3">Recover access</a></main>';
  const sent = JSON.parse(packet([call(inspection(read(html, page, true)))]).body);
  const items = sent.browser_context.pages[0].interaction_targets.items;
  expect(items.slice(0, 3).map((item: { ref: string }) => item.ref)).toEqual(['e1', 'e2', 'e3']);
  expect(sent.browser_context.pages[0].interaction_targets).toMatchObject({ captured_clickable_controls: 23, items_complete: false });
  for (const item of items.slice(0, 3)) {
    expect(item.call_example.args).toEqual({ page, steps: [{ do: 'click', ref: item.ref }, { do: 'read', form: 'outline' }] });
    expect(parseBrowserActSteps(item.call_example.args.steps).ok).toBe(true);
  }
  expect(JSON.stringify(sent.browser_context).length).toBeLessThanOrEqual(6_000);
});

it('keeps positive loading targets incomplete, bounds unsafe sources and rejects malformed counters or extra data', () => {
  const loading = browserInteractionTargets(form, { whole: true, truncated: false, loading: true });
  expect(loading).toMatchObject({ source_complete: false, captured_editable_fields: 2 });
  expect(isBrowserInteractionTargets(loading)).toBe(true);
  expect(browserInteractionTargets(form, { whole: false, truncated: true })).toMatchObject({ scope: 'region', source_complete: false });
  expect(browserInteractionTargets('x'.repeat(600_001), { whole: true, truncated: false })).toMatchObject({ source_complete: false, items_complete: false });
  expect(isBrowserInteractionTargets({ ...loading, captured_editable_fields: 0 })).toBe(false);
  expect(isBrowserInteractionTargets({ ...loading, items: [{ ...loading.items[0], value: 'PRIVATE' }] })).toBe(false);
  const link = browserInteractionTargets(landing, { whole: true, truncated: false });
  expect(isBrowserInteractionTargets({ ...link, captured_editable_fields: 1, captured_clickable_controls: 0,
    items: [{ ...link.items[0], actions: ['type'] }] })).toBe(false);
});

it('carries a real adapter/engine inspection to native current-page facts and MCP without another dispatch', async () => {
  const dispatch = vi.fn(async (_request: DispatchRequest): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
    result: { command_id: 'c', status: 'ok', duration_ms: 1, bridge_version: '0.0.12', idempotency_key_seen: false,
      outputs: { page, url, title: 'App', html: landing, truncated: false, loading: true } } }));
  const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(), getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null } });
  const recipe: RecipeDefinition = { recipe_id: 'inspect-web-page', version: 1, ttl: 0,
    metadata: { name: 'Inspect', description: 'Fixture', author: 'recued-core', supported_platforms: [] }, variables: {}, prefetch_steps: [],
    steps: [{ id: 'inspect', ingredient: 'dom-inspect', input: { page, target: '*://*/*', form: 'outline' } }],
    output: { render: [{ type: 'json', source: 'step.inspect' }] } };
  const context: ExecutionContext = { recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
    ingredientExecutor: (slug, input) => adapter({ slug, input, risk_tier: 'read', output: {} }) };
  const run = await executeRecipe(context), before = JSON.stringify(run);
  const sent = JSON.parse(packet([call(run)]).body);
  expect(sent.browser_context.collection_limits).toEqual({ max_pages: BROWSER_COLLECT_MAX_PAGES,
    max_items: BROWSER_COLLECT_MAX_ITEMS, max_seconds: BROWSER_COLLECT_MAX_SECONDS });
  expect(sent.browser_context.pages).toMatchObject([{ page, source_call: 1, read_state: { loading: true, complete: false },
    typing_context: { observed_editable_fields: 0, type_step_supported_by_capture: false, capture_only: true },
    interaction_targets: { source_complete: false, captured_editable_fields: 0, items: [{ ref: 'e24', actions: ['click'] }] } }]);
  const navigation = sent.browser_context.pages[0].interaction_targets.items[0].call_example;
  expect(navigation).toEqual({ tool: 'recued-core/act-on-web-page', args: { page, steps: [{ do: 'click', ref: 'e24' }, { do: 'read', form: 'outline' }] } });
  expect(parseBrowserActSteps(navigation.args.steps, { page: navigation.args.page }).ok).toBe(true);
  const mcp = JSON.parse(JSON.stringify(projectRunResultForAgent(run)));
  expect(mcp.output.render[0].data).toHaveProperty('interaction_targets.items.0.actions', ['click']);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(run)).toBe(before);
});

it('uses the new owning document after navigation and never replaces it with its starting URL', () => {
  const state = post();
  const run = { recipe_id: 'act-on-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: { post_action: state } }] } };
  const calls = [call(inspection()), call(run, { page: url, steps: [{ do: 'click', ref: 'e24' }] }, 'act-on-web-page')];
  const sent = JSON.parse(packet(calls).body);
  expect(sent.browser_context.pages).toHaveLength(1);
  expect(sent.browser_context.pages[0]).not.toHaveProperty('typing_context');
  expect(sent.browser_context.pages[0]).toMatchObject({ page: '7:LOGIN', source_call: 2,
    interaction_targets: { items: expect.arrayContaining([expect.objectContaining({ ref: 'e23', type: 'text', actions: ['type'],
      target: { page: '7:LOGIN', ref: 'e23' } })]) } });
  const fields = sent.browser_context.pages[0].interaction_targets.items;
  const secret = fields.find((item: { ref: string }) => item.ref === 'e25').call_example;
  const submit = fields.find((item: { ref: string }) => item.ref === 'e26').call_example;
  expect(secret).toEqual({ tool: 'recued-core/act-on-web-page', args: { page: '7:LOGIN', steps: [{ do: 'type', ref: 'e25', secret: 'password' }] } });
  expect(submit.args).toEqual({ page: '7:LOGIN', steps: [{ do: 'click', ref: 'e26' }, { do: 'read', form: 'outline' }] });
  expect(parseBrowserActSteps(secret.args.steps, { page: secret.args.page }).ok).toBe(true);
  expect(fields.find((item: { ref: string }) => item.ref === 'e23')).not.toHaveProperty('call_example');
  expect(JSON.stringify(sent.browser_context)).not.toContain('PRIVATE-');
  expect(sent.prior_tool_calls[0].result.output.render[0].data.read_state.context.current_for_controls).toBe(false);
});

it('keeps browsers separate and does not treat unknown delivery, Tier 3 or computed data as current controls', () => {
  const second = read(form, '8:OTHER');
  expect(JSON.parse(packet([call(inspection()), call(inspection(second), { page: second.page })]).body).browser_context.pages).toHaveLength(2);
  const tier3 = { ...call(inspection()), tier: 3 as const };
  expect(JSON.parse(packet([tier3]).body)).not.toHaveProperty('browser_context');
  const fakeData = { recipe_id: 'act-on-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: {
    tabs: [{ page, url, reads: [{ ...read(), step: 1 }] }],
  } }] } };
  expect(JSON.parse(packet([call(fakeData, { page, steps: [{ do: 'data', source: 'latest', pipeline: [{ transform: 'count' }] }] }, 'act-on-web-page')]).body)).not.toHaveProperty('browser_context');
  const uncertain = { after_step: 1, action_status: 'uncertain', check_status: 'not_requested', application_outcome: 'unverified',
    before_page: page, transition: 'unknown', view_status: 'unavailable', reason: 'delivery_uncertain' };
  const run = { recipe_id: 'act-on-web-page', success: false, errors: [{ code: 'ACTION_DELIVERY_UNCERTAIN', source: { ingredient_slug: 'dom-act' },
    message: 'Delivery uncertain', details: { batch_progress: { total_steps: 1, failed_step: 1, completed_steps: [],
      effects: [{ step: 1, attempted: 1, acknowledged: 0 }], page_state: 'unknown' }, post_action: uncertain } }] };
  expect(JSON.parse(packet([call(inspection()), call(run, { page, steps: [{ do: 'click', ref: 'e24' }] }, 'act-on-web-page')]).body)).not.toHaveProperty('browser_context');
});

it('accepts an empty-computation receipt only from a matching trusted data step with actual returned data', () => {
  const ref = 'data:12345678-1234-1234-1234-123456789abc';
  const value = { step: 1, data_ref: ref, input_source: { data_ref: ref }, kind: 'array', row_count: 0, value: [], source_complete: false };
  const run = { recipe_id: 'act-on-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: { data: [value] } }] } };
  const valid = call(run, { steps: [{ do: 'data', source: ref, pipeline: [{ transform: 'slice', start: 0, end: 1 }] }] }, 'act-on-web-page');
  expect(JSON.parse(packet([valid]).body).browser_context).toMatchObject({ pages: [], latest_computation: { source_complete: false } });
  for (const invalid of [
    { ...valid, tier: 3 as const }, { ...valid, tool_name: 'other/act-on-web-page' },
    { ...valid, args: { steps: [{ do: 'click', ref: 'e1' }] } },
    { ...valid, result: { ...run, output: { render: [{ type: 'json', data: { data: [{ ...value, value: undefined }] } }] } } },
    { ...valid, result: { ...run, output: { render: [{ type: 'json', data: { data: [{ ...value, input_source: { data_ref: 'invalid' } }] } }] } } },
  ]) expect(JSON.parse(packet([invalid]).body)).not.toHaveProperty('browser_context');
});

it('deduplicates identical passive views with resolvable same-packet references while preserving every receipt', () => {
  const state = post(), run = { recipe_id: 'act-on-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: {
    done: 1, of: 1, post_action: state, tabs: [{ page: state.current_page, url, post_action: structuredClone(state), reads: [] }],
  } }] } };
  const calls = [call(run, { page, steps: [{ do: 'click', ref: 'e24' }] }, 'act-on-web-page')], original = JSON.stringify(calls);
  const compact = packet(calls), full = packet(calls, false), sent = JSON.parse(compact.body);
  const result = sent.prior_tool_calls[0].result;
  expect(result.browser_state.view.interaction_targets).toMatchObject({ captured_editable_fields: 2 });
  expect(result.output.render[0].data).toMatchObject({ done: 1, of: 1, post_action: { action_status: 'acknowledged', view_ref: {
    observation_id: expect.any(String), path: '/prior_tool_calls/0/result/browser_state/view',
  } } });
  const pointer = result.output.render[0].data.post_action.view_ref.path as string;
  expect(pointer.split('/').slice(1).reduce<unknown>((value, key) => value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key] : undefined, sent)).toEqual(result.browser_state.view);
  expect(compact.browser_read_context!.snapshot_copies_elided).toBeGreaterThanOrEqual(2);
  expect(compact.body.length).toBeLessThan(full.body.length);
  expect(JSON.stringify(calls)).toBe(original);
  expect(JSON.parse(full.body).prior_tool_calls[0].result.output.render[0].data.post_action).toHaveProperty('view');
});

it('preserves differing passive views and adds no reference after evidence was trimmed away', () => {
  const state = post(), changed = post({ ...read(form, '7:LOGIN'), outline: 'Different view' });
  const run = { recipe_id: 'act-on-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: {
    post_action: state, tabs: [{ page: '7:LOGIN', url, post_action: changed, reads: [] }],
  } }] } };
  const sent = JSON.parse(packet([call(run, { page, steps: [{ do: 'click', ref: 'e24' }] }, 'act-on-web-page')]).body);
  expect(sent.prior_tool_calls[0].result.output.render[0].data.tabs[0].post_action.view.outline).toBe('Different view');
  const trimmed = JSON.parse(packet([call({ recipe_id: 'act-on-web-page', success: false, summary: 'Output omitted' }, {}, 'act-on-web-page')]).body);
  expect(trimmed).not.toHaveProperty('browser_context');
  expect(JSON.stringify(trimmed)).not.toContain('view_ref');
});

it('keeps settled history in the reusable prompt prefix when another tab changes its latest targets', () => {
  const first = call(inspection({ ...read(), outline: 'DURABLE-HISTORY-CONTENT' }));
  const a = call(inspection(read(form, '8:OTHER')), { page: '8:OTHER' });
  const b = call(inspection(read(form.replace('Email address', 'Account address'), '8:OTHER')), { page: '8:OTHER' });
  const before = packet([first, a]).body, after = packet([first, b]).body;
  let shared = 0; while (shared < Math.min(before.length, after.length) && before[shared] === after[shared]) shared++;
  expect(before.slice(0, shared)).toContain('DURABLE-HISTORY-CONTENT');
});

const readAndPost = () => {
  const value = { ...read(form, '7:LOGIN'), outline: 'Literal observed form content. '.repeat(30) };
  const state = post(value);
  const run = { recipe_id: 'act-on-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: {
    done: 2, of: 2, post_action: state, tabs: [{ page: value.page, url, post_action: structuredClone(state), reads: [{ ...value, step: 2 }] }],
  } }] } };
  return { value, run, calls: [call(run, { page, steps: [{ do: 'click', ref: 'e24' }, { do: 'read' }] }, 'act-on-web-page')] };
};
const pointed = (packet: unknown, path: string): unknown => path.split('/').slice(1).reduce<unknown>((value, key) =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, packet);

it('references identical explicit-read fields while retaining independent post-action coverage and receipts', () => {
  const { calls, value } = readAndPost(), original = JSON.stringify(calls);
  const compact = packet(calls), full = packet(calls, false), sent = JSON.parse(compact.body);
  const state = sent.prior_tool_calls[0].result.browser_state;
  expect(state).toMatchObject({ action_status: 'acknowledged', check_status: 'not_requested', application_outcome: 'unverified', view_status: 'fresh' });
  expect(state.view).not.toHaveProperty('outline');
  expect(pointed(sent, state.view.field_refs.outline.path)).toBe(value.outline);
  expect(state.view.field_refs.outline.observation_id).toBe(sent.prior_tool_calls[0].result.output.render[0].data.tabs[0].reads[0].read_state.context.observation_id);
  expect(state.view.read_state).toMatchObject({ source: 'bridge_read', complete: true, truncated: false });
  expect(sent.browser_context.pages[0].interaction_targets.items[0].target).toEqual({ page: value.page, ref: 'e23' });
  expect(compact.browser_read_context!.field_copies_elided).toBeGreaterThan(0);
  expect(compact.body.length).toBeLessThan(full.body.length);
  expect(JSON.stringify(calls)).toBe(original);
  expect(JSON.parse(full.body).prior_tool_calls[0].result.browser_state.view).not.toHaveProperty('field_refs');
});

it('keeps differing literals, documents, scopes and loading sources instead of referring to a similar read', () => {
  for (const change of ['literal', 'document', 'read_document', 'scope', 'loading', 'computed', 'missing'] as const) {
    const { calls, run } = readAndPost();
    const tab = run.output.render[0]!.data.tabs[0]!;
    if (change === 'literal') tab.reads[0]!.outline += ' Different.';
    if (change === 'document') tab.page = '8:OTHER';
    if (change === 'read_document') tab.reads[0]!.page = '8:OTHER';
    if (change === 'scope') Object.assign(tab.reads[0]!.read_state, { scope: { kind: 'element', form: 'outline', ref: 'e23' } });
    if (change === 'loading') tab.reads[0]!.read_state.loading = true;
    if (change === 'computed') calls[0]!.args = { page, steps: [{ do: 'click', ref: 'e24' }, { do: 'data', pipeline: [{ transform: 'count' }] }] };
    if (change === 'missing') tab.reads = [];
    const sent = JSON.parse(packet(calls).body);
    expect(sent.prior_tool_calls[0].result.browser_state.view.outline, change).toContain('Literal observed form content.');
    expect(sent.prior_tool_calls[0].result.browser_state.view.field_refs?.outline, change).toBeUndefined();
  }
});

it('bounds complete control examples, keeps browsers separate and omits disabled or readonly actions', () => {
  const html = '<main><input ref="e1" type="PASSWORD" value="PRIVATE-PASSWORD">'
    + '<input ref="e2" type="password" readonly><input ref="e3" type="password" disabled>'
    + '<button ref="e4" type="submit" disabled>Save</button><input ref="e5" type="text" value="PRIVATE-TEXT"></main>';
  const one = read(html, 'bridge:one:7:DOC'), two = read(html, 'bridge:two:7:DOC');
  const calls = [call(inspection(one)), call(inspection(two))], original = JSON.stringify(calls);
  const sent = JSON.parse(packet(calls).body);
  expect(sent.browser_context.pages).toHaveLength(2);
  for (const page of sent.browser_context.pages) {
    const examples = page.interaction_targets.items.filter((item: { call_example?: unknown }) => item.call_example);
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({ ref: 'e1', call_example: { args: { page: page.page, steps: [{ secret: 'password', ref: 'e1' }] } } });
    expect(parseBrowserActSteps(examples[0].call_example.args.steps, { page: page.page }).ok).toBe(true);
  }
  expect(JSON.stringify(sent.browser_context).length).toBeLessThanOrEqual(6_000);
  expect(JSON.stringify(sent.browser_context)).not.toContain('PRIVATE-');
  expect(JSON.stringify(calls)).toBe(original);
});

it('keeps observed targets without call examples when Act is not advertised', () => {
  const sent = JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Read my browser.' },
    prior_tool_calls: [call(inspection(read(form)))], deduplicate_browser_reads: true }).body);
  expect(sent.browser_context.pages[0].interaction_targets.captured_editable_fields).toBe(2);
  expect(sent.browser_context).not.toHaveProperty('call_examples_note');
  expect(sent.browser_context.pages[0].interaction_targets.items.every((item: { call_example?: unknown }) => item.call_example === undefined)).toBe(true);
});


it('exposes upload separately from typing without copying a file input value or claiming complete coverage', () => {
  const html = '<main><form><label for="file">Document</label><input ref="e1" id="file" type="file" value="PRIVATE-LOCAL-PATH">'
    + '<input ref="e2" type="file" disabled><input ref="e3" type="file" aria-readonly="true"><button ref="e4" type="submit">Send</button></form></main>';
  const out = browserInteractionTargets(html, { whole: true, truncated: false, loading: true });
  expect(out).toMatchObject({ captured_editable_fields: 0, captured_upload_fields: 1, source_complete: false });
  expect(out.items.find(item => item.ref === 'e1')).toMatchObject({ type: 'file', label: 'Document', actions: ['upload'] });
  expect(out.items.find(item => item.ref === 'e2')).toMatchObject({ disabled: true, actions: [] });
  expect(out.items.find(item => item.ref === 'e3')).toMatchObject({ readonly: true, actions: [] });
  expect(JSON.stringify(out)).not.toContain('PRIVATE'); expect(isBrowserInteractionTargets(out)).toBe(true);
  expect(isBrowserInteractionTargets({ ...out, captured_upload_fields: 0 })).toBe(false);
  expect(isBrowserInteractionTargets({ ...out, items: out.items.map(item => item.ref === 'e1' ? { ...item, actions: ['type'] } : item) })).toBe(false);
  expect(isBrowserInteractionTargets({ ...out, items: out.items.map(item => item.ref === 'e4' ? { ...item, actions: ['upload'] } : item) })).toBe(false);
});

it('offers a complete upload example only for an unambiguous current-turn attachment and the current owning document', () => {
  const html = '<main><input ref="e12" name="document" type="file"><button ref="e13" type="submit">Upload</button></main>';
  const attachment = { file_ref: 'file:' + 'a'.repeat(32), filename: 'document.txt' }, calls = [call(inspection(read(html)))];
  const sent = (attachments: typeof attachment[]) => JSON.parse(composeChatMainTurnPromptParts({
    available_tools: [{ recipe_slug: 'recued-core/act-on-web-page' }], attachment_refs: attachments,
    content: { chat_tail: [], user_message: 'Upload document.txt.' }, prior_tool_calls: calls,
  }).body).browser_context;
  const result = sent([attachment]), target = result.pages[0].interaction_targets.items.find((item: { ref: string }) => item.ref === 'e12');
  expect(target.target).toEqual({ page, ref: 'e12' });
  expect(target.call_example).toEqual({ tool: 'recued-core/act-on-web-page', args: { page, steps: [{ do: 'upload', ref: 'e12', file: attachment.file_ref }] } });
  expect(result.pages[0].typing_context.type_step_supported_by_capture).toBe(false);
  for (const attachments of [[], [attachment, { ...attachment, file_ref: 'file:' + 'b'.repeat(32) }], [{ ...attachment, file_ref: 'file:bad' }]]) {
    expect(sent(attachments).pages[0].interaction_targets.items.find((item: { ref: string }) => item.ref === 'e12')).not.toHaveProperty('call_example');
  }
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(6_000);
  expect(JSON.stringify(calls)).not.toContain('call_example');
});

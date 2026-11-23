import { describe, expect, it, vi } from 'vitest';
import { readBrowserFailure, type BridgeResult } from '@recued/contracts';
import { IngredientError, type ResolvedCall } from '@recued/ingredients';
import { browserBatchReadsOnly, createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createBrowserDataStore } from '../bridges/browser-data-store.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import type { BridgeDispatcher, DispatchRequest } from '../bridges/dispatcher.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import type { ChatPriorToolCall } from '@recued/contracts';

const PAGE = '8:DATA';
const url = 'https://example.com/items';
const manifests = { get: (slug: string) => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null };
const harness = (output: (request: DispatchRequest) => Record<string, unknown>) => {
  let connected = true;
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async request => ({ kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
    result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false, status: 'ok',
      outputs: output(request) } as BridgeResult }));
  const pageReads = createPageReadStore();
  const adapter = createBridgeDomAdapter({ manifests, data: createBrowserDataStore(), pageReads,
    getDispatcher: () => connected ? { dispatch, cancel: vi.fn(), canResolve: () => true } : undefined });
  let turn = 0;
  const call = (slug: string, input: Record<string, unknown>, session = 'chat-a') => {
    const execution_source = { channel: 'chat' as const, actor: 'user_self' as const, user_id: 'u1', chat_session_id: session, turn_id: String(++turn) };
    const resolved: ResolvedCall = { slug, input: { target: '*://*/*', ...input }, risk_tier: 'write', output: {},
      stepMeta: { run_id: `run-${turn}`, recipe_id: 'browser', step_id: 'act', execution_source } };
    return adapter(resolved) as Promise<Record<string, any>>;
  };
  const batch = (steps: unknown[], input = {}, session?: string) => call('dom-act', { page: PAGE, steps, ...input }, session);
  return { call, batch, dispatch, pageReads, disconnect() { connected = false; } };
};
const page = (html: string, extra = {}) => ({ page: PAGE, url, title: 'Items', html: `<main>${html}</main>`, truncated: false, ...extra });

describe('data steps inside the browser batch', () => {
  it('keeps exact section labels and an empty-query receipt without changing selection or replaying the browser', async () => {
    const h = harness(() => page('<h2 id="See_also">See also</h2><ul><li>First article</li><li>Last article</li></ul>'));
    const steps = [{ do: 'read', data_format: 'entries' }, { do: 'data', source: 'latest', pipeline: [
      { transform: 'filter', field: 'section', operator: 'equal', value: 'See_also' }] }];
    const answer = await h.batch(steps);
    const capture = answer.tabs[0].reads[0], value = answer.tabs[0].reads[1].data;
    expect(capture).toMatchObject({ captured_sections: ['See also'], captured_sections_complete: true, data_source_complete: true });
    expect(capture).not.toHaveProperty('entry_view');
    expect(JSON.stringify(capture)).not.toContain('Last article');
    expect(value).toMatchObject({ value: [], source_complete: true });
    expect(value.query_diagnostics?.issues ?? []).toEqual([]);
    const calls: ChatPriorToolCall[] = [];
    const sent = (result: unknown, authored: unknown[]) => {
      calls.push({ tool_name: 'recued-core/act-on-web-page', tier: 2, args: { steps: authored }, status: 'ok', started_at: 1, completed_at: 2,
        result: { recipe_id: 'act-on-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: result }] } } });
      return JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], prior_tool_calls: calls,
        content: { chat_tail: [], user_message: 'Give the last item in See also.' } }).body);
    };
    const empty = sent(answer, steps);
    expect(empty.browser_context).toMatchObject({ pages: [], latest_computation: { source_call: 1, step: 2,
      data_ref: value.data_ref, input_ref: capture.data_ref, result_kind: 'empty_array', item_facts_returned: false, source_complete: true } });
    const guidance = empty.prior_tool_calls[0].result.browser_guidance;
    expect(JSON.stringify(guidance).length).toBeLessThanOrEqual(1_800);
    expect(guidance.result_use).toMatchObject({ result_kind: 'empty_array', item_facts_returned: false });
    const preview = guidance.options.find((option: { kind: string }) => option.kind === 'inspect_query_source').step;
    expect(preview.source).toBe(capture.data_ref);
    expect((await h.batch([preview])).data[0].value).toMatchObject([{ text: 'First article' }, { text: 'Last article' }]);
    h.disconnect();
    const corrected = [{ do: 'data', source: capture.data_ref, pipeline: [
      { transform: 'filter', field: 'section', operator: 'equal', value: capture.captured_sections[0] },
      { transform: 'sort', field: 'position', direction: 'desc' }, { transform: 'slice', start: 0, end: 1 }] }];
    const fixed = await h.batch(corrected);
    expect(fixed.data[0].value).toMatchObject([{ text: 'Last article' }]);
    expect(sent(fixed, corrected).browser_context).toBeUndefined();
    const count = [{ do: 'data', source: value.data_ref, pipeline: [{ transform: 'count' }] }];
    const zero = await h.batch(count);
    expect(zero.data[0].value).toBe(0);
    expect(sent(zero, count).browser_context).toBeUndefined();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps alternate entry refs after a consumed line read and repairs a field query without another browser call', async () => {
    const h = harness(() => page('<h2>See also</h2><ul><li>First article</li><li>Middle article</li><li>Last article</li></ul>'));
    const answer = await h.batch([{ do: 'read', find: 'See also' }, { do: 'data', source: 'latest', pipeline: [
      { transform: 'filter', field: 'heading_path', operator: 'equal', value: ['See also'] }, { transform: 'slice', start: 0, end: 1 }] }]);
    const captured = answer.tabs[0].reads[0];
    expect(captured).toMatchObject({ data_format: 'lines', entry_data: { data_source_complete: true } });
    expect(captured).not.toHaveProperty('outline'); expect(captured).not.toHaveProperty('entry_view');
    expect(JSON.stringify(captured)).not.toContain('Last article');
    const computed = answer.tabs[0].reads[1].data;
    expect(computed).toMatchObject({ value: [], query_diagnostics: { issues: [{ kind: 'field_not_observed' }] } });
    const calls = h.dispatch.mock.calls.length;
    const fixed = await h.batch([{ do: 'data', source: captured.entry_data.data_ref, pipeline: [
      { transform: 'filter', field: 'section', operator: 'equal', value: 'See also' },
      { transform: 'sort', field: 'position', direction: 'desc' }, { transform: 'slice', start: 0, end: 1 }] }]);
    expect(fixed.data[0].value).toMatchObject([{ text: 'Last article' }]);
    expect(h.dispatch).toHaveBeenCalledTimes(calls);
  });
  it('runs the section-specific entry hint returned by an Act read without recapturing or counting another section', async () => {
    const h = harness(() => page('<h2>Catalog</h2><h3>Group</h3><dl><dt>A</dt><dt>B</dt></dl>'
      + '<h2>Other</h2><h3>Group</h3><dl><dt>C</dt></dl>'));
    const answer = await h.batch([{ do: 'read', form: 'text', find: 'Catalog' }]);
    const hint = answer.tabs[0].reads[0].entry_data.data_hint;
    expect(hint.requested_section).toBe('Catalog');
    const calls = h.dispatch.mock.calls.length;
    const grouped = await h.batch([hint.step]);
    expect(grouped.data[0].value).toEqual([{ group: '["Catalog","Group"]', count: 2, last: 'B' }]);
    expect(h.dispatch).toHaveBeenCalledTimes(calls);
  });

  it('preserves table captures and computed data after a later browser step fails, without replaying browser commands', async () => {
    const h = harness(request => {
      if (request.args.selector === '#missing') throw new IngredientError('DOM_SELECTOR_NOT_FOUND', 'No such table');
      return { page: PAGE, url, title: 'Items', columns: ['Name'], rows: [['Arden'], ['Blake']], truncated: false };
    });
    let error: unknown;
    try { await h.batch([{ do: 'table' }, { do: 'data', pipeline: [{ transform: 'count' }] }, { do: 'table', selector: '#missing' }]); }
    catch (caught) { error = caught; }
    const receipts = readBrowserFailure(error)?.details.completed_data;
    expect(receipts).toMatchObject([
      { step: 1, from: 'table', kind: 'array', row_count: 2, source_complete: true, value_omitted: false,
        value: [{ Name: 'Arden' }, { Name: 'Blake' }], fields: [{ field: 'Name', types: ['string'] }] },
      { step: 2, from: 'data', kind: 'number', source_complete: true, value_omitted: false, value: 2 },
    ]);
    h.disconnect();
    const calls = h.dispatch.mock.calls.length;
    const answer = await h.batch([{ do: 'data', source: receipts![0]!.data_ref, pipeline: [{ transform: 'pluck', field: 'Name' }] },
      { do: 'data', source: receipts![1]!.data_ref, pipeline: [{ transform: 'to_number' }] }]);
    expect(answer.data.map((item: any) => item.value)).toEqual([['Arden', 'Blake'], 2]);
    await expect(h.batch([{ do: 'data', source: receipts![0]!.data_ref, pipeline: [{ transform: 'count' }] }], {}, 'other-chat')).rejects.toThrow('unavailable');
    expect(h.dispatch).toHaveBeenCalledTimes(calls);
  });

  it('suggests and executes the array projection repair with prior filtering/sorting and no browser replay', async () => {
    const h = harness(() => ({ page: PAGE, url, title: 'Items', columns: ['Full Name', 'Category'],
      rows: [['Blake', 'keep'], ['Arden', 'keep'], ['Cedar', 'skip']], truncated: false }));
    let caught: unknown;
    const pipeline = [{ transform: 'filter', field: 'Category', operator: 'equal', value: 'keep' },
      { transform: 'sort', field: 'Full Name' },
      { transform: 'project', expression: { name: '{{item["Full Name"]}}' } }];
    try { await h.batch([{ do: 'table' }, { do: 'data', source: 'latest', pipeline }]); }
    catch (error) { caught = error; }
    const failure = readBrowserFailure(caught)!.details;
    expect(failure.completed_data![0]).toMatchObject({ value_omitted: false, row_count: 3, source_complete: true });
    expect(failure.data_failure).toMatchObject({ operation: 3, input_kind: 'array', transform: 'project',
      repair_step: { do: 'data', source: failure.completed_data![0]!.data_ref,
        pipeline: [...pipeline.slice(0, 2), { transform: 'map', expression: { name: '{{item["Full Name"]}}' } }] } });
    h.disconnect();
    const calls = h.dispatch.mock.calls.length;
    const answer = await h.batch([failure.data_failure!.repair_step]);
    expect(answer.data[0].value).toEqual([{ name: 'Arden' }, { name: 'Blake' }]);
    expect(h.dispatch).toHaveBeenCalledTimes(calls);
    const original = await h.batch([{ do: 'data', source: failure.completed_data![0]!.data_ref, pipeline: [{ transform: 'count' }] }]);
    expect(original.data[0].value).toBe(3);
  });

  it('keeps a large earlier value queryable without copying it into a later error', async () => {
    const h = harness(request => {
      if (request.args.selector === '#missing') throw new IngredientError('DOM_SELECTOR_NOT_FOUND', 'No such table');
      return { page: PAGE, url, title: 'Items', columns: ['Name'], rows: [['LARGE_ROW_VALUE'.repeat(1_000)]], truncated: false };
    });
    let caught: unknown;
    try { await h.batch([{ do: 'table' }, { do: 'table', selector: '#missing' }]); } catch (error) { caught = error; }
    const capture = readBrowserFailure(caught)!.details.completed_data![0]!;
    expect(capture).toMatchObject({ row_count: 1, source_complete: true, value_omitted: true });
    expect(capture).not.toHaveProperty('value');
    expect(JSON.stringify(caught)).not.toContain('LARGE_ROW_VALUE');
    h.disconnect();
    const answer = await h.batch([{ do: 'data', source: capture.data_ref, pipeline: [{ transform: 'count' }] }]);
    expect(answer.data[0].value).toBe(1);
  });

  it('preserves read and collection references with their capture coverage after a later data failure', async () => {
    const h = harness(request => page('<ul><li>Read entry</li></ul><article><b>Arden</b></article><article><b>Blake</b></article>', { truncated: request.action !== 'reread' }));
    let error: unknown;
    try { await h.batch([{ do: 'read', data_format: 'entries' },
      { do: 'collect', items: 'article', fields: { name: 'b' }, max_pages: 1 },
      { do: 'data', pipeline: [{ transform: 'count' }] },
      { do: 'data', pipeline: [{ transform: 'map', expression: { name: '{{item.name}}' } }] }]); }
    catch (caught) { error = caught; }
    const receipts = readBrowserFailure(error)?.details.completed_data;
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 1, from: 'read', source_complete: false }),
      expect.objectContaining({ step: 2, from: 'collection', source_complete: true }),
      expect.objectContaining({ step: 3, from: 'data', kind: 'number', source_complete: true }),
    ]));
    const collection = receipts!.find(item => item.from === 'collection')!;
    h.disconnect();
    const calls = h.dispatch.mock.calls.length;
    const answer = await h.batch([{ do: 'data', source: collection.data_ref, pipeline: [{ transform: 'pluck', field: 'name' }] }]);
    expect(answer.data[0]).toMatchObject({ value: ['Arden', 'Blake'], source_complete: true });
    expect(h.dispatch).toHaveBeenCalledTimes(calls);
  });

  it('returns a queryable descriptor when table rows exceed the batch output limit', async () => {
    const h = harness(() => ({ page: PAGE, url, title: 'Items', columns: ['Name'],
      rows: Array.from({ length: 90 }, () => ['x'.repeat(1_000)]), truncated: false }));
    const answer = await h.batch([{ do: 'table' }]);
    const table = answer.tabs[0].reads[0].table;
    expect(table).toMatchObject({ kind: 'array', row_count: 90, value_omitted: true, source_complete: true, fields: [{ field: 'Name', types: ['string'] }] });
    expect(table).not.toHaveProperty('rows');
    expect(JSON.stringify(answer).length).toBeLessThan(4_000);
    h.disconnect();
    const calls = h.dispatch.mock.calls.length;
    const queried = await h.batch([{ do: 'data', source: table.data_ref, pipeline: [{ transform: 'count' }] }]);
    expect(queried.data[0].value).toBe(90);
    expect(h.dispatch).toHaveBeenCalledTimes(calls);
  });

  it('diagnoses an invalid operation output and reuses its original capture for a corrected pipeline without browser I/O', async () => {
    const h = harness(() => page('<ul><li>Arden</li><li>Blake</li></ul>', { loading: false }));
    const group = { transform: 'group_by', field: 'kind', aggregate: { count: { operator: 'count' } } };
    let caught: unknown;
    try { await h.batch([{ do: 'read', data_format: 'entries' }, { do: 'data', pipeline: [group,
      { transform: 'map', expression: { kind: '{{item.kind}}', total: '{{item.not_a_field}}' } }] }]); }
    catch (error) { caught = error; }
    const detail = readBrowserFailure(caught)?.details.data_failure;
    expect(detail).toMatchObject({ operation: 2, transform: 'map', stage: 'output', problem: 'undefined', output_path: '$[0]["total"]',
      input_fields: expect.arrayContaining([{ name: 'count', types: ['number'] }]), schema_step: { do: 'data', describe: ['map'] } });
    const calls = h.dispatch.mock.calls.length;
    const corrected = await h.batch([{ do: 'data', source: detail!.source_ref, pipeline: [group,
      { transform: 'map', expression: { kind: '{{item.kind}}', total: '{{item.count}}' } }] }]);
    expect(corrected.data[0].value).toEqual([{ kind: 'list_item', total: 2 }]);
    expect(h.dispatch).toHaveBeenCalledTimes(calls);
  });

  it('keeps a scoped entry capture separate from the full page and preserves both datasets for reuse', async () => {
    const h = harness(request => page(request.args.selector === '#selected'
      ? '<ul id="selected"><li>Arden</li><li>Blake</li></ul><button ref="e2">Inside</button>'
      : '<h1>Full page</h1><ul><li>Arden</li><li>Blake</li><li>Outside</li></ul><a ref="e1" href="/elsewhere">Outside link</a>', { loading: false }));
    const full = await h.batch([{ do: 'read', data_format: 'entries' }]);
    const fullRef = full.tabs[0].reads[0].data_ref;
    const snapshot = h.pageReads.dataSnapshot(PAGE);
    const scope = await h.batch([{ do: 'read', selector: '#selected', data_format: 'entries' },
      { do: 'data', pipeline: [{ transform: 'count' }] }]);
    expect(scope.tabs[0].reads[0]).toMatchObject({ data_scope: 'captured_element_entries', data_source_complete: true,
      read_state: { scope: { kind: 'element', form: 'outline', selector: '#selected', first_match: true }, complete: true } });
    expect(scope.tabs[0].reads[1].data).toMatchObject({ value: 2, source_complete: true,
      sources: [{ coverage: { scope: { kind: 'element', selector: '#selected' }, representation: 'entries' } }] });
    expect(h.pageReads.dataSnapshot(PAGE)).toEqual(snapshot);
    expect(h.pageReads.controlOf(PAGE, 'e1')).toMatchObject({ ref: 'e1' });
    expect(h.pageReads.controlOf(PAGE, 'e2')).toMatchObject({ ref: 'e2' });
    const original = await h.batch([{ do: 'data', source: fullRef, pipeline: [{ transform: 'count' }] }]);
    expect(original.data[0].value).toBe(3);
  });

  it('refuses an ambiguous scoped read before an earlier mutation could run', async () => {
    const h = harness(() => page('Unused'));
    await expect(h.batch([{ do: 'click', selector: '#save' }, { do: 'read', ref: 'e1', selector: '#panel' }]))
      .rejects.toThrow('give one of ref and selector');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])('executes explicit readiness recovery and fails honestly at its bound (settles=%s)', async settles => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const h = harness(() => {
        reads++;
        return page(reads > 1 && settles ? '<ul><li>Ready</li></ul>' : '<p>Loading</p>', { loading: !(settles && reads > 1) });
      });
      const first = await h.batch([{ do: 'read', data_format: 'entries', form: 'text' }]);
      const steps = first.tabs[0].reads[0].loading_recovery.steps;
      expect(h.pageReads.age(PAGE)).toBe(Infinity); // loading evidence is still unavailable for ordinary action reuse
      expect(h.pageReads.readIdentity(PAGE)).toBeDefined();
      const started = Date.now();
      const pending = h.batch(steps).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
      await vi.runAllTimersAsync();
      const { result: out, error } = await pending;
      if (!settles) {
        expect(error).toMatchObject({ code: 'DOM_CHECK_FAILED' });
        expect(String(error)).toContain('Document readiness was not observed');
        expect(Date.now() - started).toBe(10_000);
        expect(h.dispatch.mock.calls.every(([request]) => ['inspect', 'reread'].includes(request.action))).toBe(true);
        return;
      }
      expect(error).toBeUndefined();
      expect(out).toBeDefined();
      const read = out!.tabs[0].reads[0];
      expect(read).toMatchObject({ data_format: 'entries', complete: settles, data_source_complete: settles });
      expect(read.text).toContain(settles ? 'Ready' : 'Loading');
      expect(h.dispatch.mock.calls.every(([request]) => ['inspect', 'reread'].includes(request.action))).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { vi.useRealTimers(); }
  });

  it('omits a repeated capture only for the exact consumed ref, preserving a new read when an older snapshot is selected', async () => {
    let loading = true;
    const h = harness(() => page('<ul><li>Observed</li></ul>', { loading }));
    const first = await h.batch([{ do: 'read', data_format: 'entries' }]);
    expect(first.tabs[0].reads[0]).toMatchObject({ complete: false, loading_recovery: { steps: [
      { do: 'wait', page: PAGE, until: 'ready', seconds: 10 }, { do: 'read', form: 'outline', data_format: 'entries' },
    ] } });
    const older = first.tabs[0].reads[0].data_ref;
    loading = false;
    const mixed = await h.batch([{ do: 'read', data_format: 'entries' },
      { do: 'data', source: older, pipeline: [{ transform: 'count' }] }]);
    const fresh = mixed.tabs[0].reads[0].data_ref;
    expect(fresh).not.toBe(older);
    expect(mixed.tabs[0].reads[0]).toHaveProperty('outline');
    expect(mixed.tabs[0].reads[1].data).toMatchObject({ value: 1, source_complete: false,
      input_source: { data_ref: older, latest_in_batch: fresh } });
    const repeated = await h.batch([{ do: 'read', data_format: 'entries' },
      { do: 'data', source: fresh, pipeline: [{ transform: 'count' }] }]);
    expect(repeated.tabs[0].reads[0]).toMatchObject({ data_ref: fresh, data_source_complete: true });
    expect(repeated.tabs[0].reads[0]).not.toHaveProperty('outline');
    expect(repeated.tabs[0].reads[0]).not.toHaveProperty('entry_view');
    expect(repeated.tabs[0].reads[1].data).toMatchObject({ value: 1, input_source: { data_ref: fresh, selection: 'explicit' } });
    expect(h.dispatch).toHaveBeenCalledTimes(3); // all browser reads still run
  });

  it('finishes explicit readiness on unchanged text while a plain wait keeps its content-change contract', async () => {
    vi.useFakeTimers();
    try {
      for (const ready of [true, false]) {
        let captures = 0;
        const h = harness(() => page('<p>Already visible text.</p>', { loading: ++captures === 1 }));
        await h.batch([{ do: 'read' }]);
        const started = Date.now();
        const pending = h.batch([{ do: 'wait', seconds: 2, ...(ready ? { until: 'ready' } : {}) }, { do: 'read' }]);
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result.tabs[0].reads[0].read_state).toMatchObject({ source: 'bridge_read', loading: false, complete: true });
        expect(Date.now() - started).toBe(ready ? 0 : 2000);
      }
    } finally { vi.useRealTimers(); }
  });

  it('does not treat unknown document readiness as success or dispatch a following action', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => page('<button ref="e1">Save</button>'));
      const pending = h.batch([{ do: 'wait', until: 'ready', seconds: 1 }, { do: 'click', ref: 'e1' }])
        .then(() => undefined, error => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ code: 'DOM_CHECK_FAILED' });
      expect(h.dispatch.mock.calls.some(([request]) => request.action === 'click')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('rejects contradictory readiness conditions before an earlier mutation can run', async () => {
    const h = harness(() => page('Unused'));
    await expect(h.batch([{ do: 'click', selector: '#save' }, { do: 'wait', until: 'ready', selector: '#result' }]))
      .rejects.toThrow('document readiness only');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('validates code-shaped projections before any earlier browser action executes', async () => {
    const h = harness(() => page('<button>Continue</button>'));
    await expect(h.batch([{ do: 'click', text: 'Continue' }, { do: 'read' },
      { do: 'data', pipeline: [{ transform: 'map', expression: 'parseInt({{item.text}}.split(" ")[0])' }] }])).rejects.toThrow('JavaScript');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('repairs a malformed wait before an earlier click can execute', async () => {
    const h = harness(() => page('<button>Start</button>'));
    await expect(h.batch([{ do: 'click', text: 'Start' }, { do: 'wait', gone: '.loading', seconds: 10 }, { do: 'read' }]))
      .rejects.toThrow('"until":"gone"');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('selects observed entries as implicit batch data, including small/empty captures, without changing the default line input', async () => {
    const h = harness(() => page('<h2>Catalog</h2><h3>First</h3><dl><dt>99 Zulu</dt><dt>2 Alpha (annotation)</dt></dl>'
      + '<h2>Other</h2><h3>First</h3><dl><dt>3 Other</dt></dl>'));
    const answer = await h.batch([{ do: 'read', find: 'Catalog', data_format: 'entries' }, { do: 'data', pipeline: [
      { transform: 'filter', conditions: [{ field: 'kind', operator: 'equal', value: 'definition_term' },
        { field: 'section', operator: 'equal', value: 'Catalog' }] },
      { transform: 'group_by', field: 'group', aggregate: { count: { operator: 'count' }, last: { operator: 'last', field: 'text' } } }] }]);
    expect(answer.tabs[0].reads[0]).toMatchObject({ data_format: 'entries', data_scope: 'captured_entries' });
    expect(answer.tabs[0].reads[1].data).toMatchObject({ value: [{ group: '["Catalog","First"]', count: 2, last: '2 Alpha (annotation)' }], source_complete: true });
    expect(h.dispatch.mock.calls.map(([r]) => r.action)).toEqual(['inspect']);
    const paginated = harness(() => page('<ul>' + Array.from({ length: 30 }, (_, i) => `<li>Item ${i} ${'x'.repeat(200)}</li>`).join('') + '</ul>'));
    const part = await paginated.batch([{ do: 'read', data_format: 'entries', form: 'text', chars: 100 }]);
    expect(part.tabs[0].reads[0]).toMatchObject({ complete: false, data_source_complete: true,
      next_step: { do: 'read', data_format: 'entries' } });
    const lines = await h.batch([{ do: 'read' }, { do: 'data', pipeline: [{ transform: 'slice', end: 1 }] }]);
    expect(lines.tabs[0].reads[1].data.value[0]).toHaveProperty('line');
    for (const html of ['<ul><li>Only entry</li></ul>', '<p>No entries</p>']) {
      const small = harness(() => page(html));
      const out = await small.batch([{ do: 'read', data_format: 'entries' }, { do: 'data', pipeline: [{ transform: 'count' }] }]);
      expect(out.tabs[0].reads[1].data.value).toBe(html.includes('<li>') ? 1 : 0);
    }
  });

  it('keeps incomplete entry coverage and refuses an invalid representation before browser effects', async () => {
    const h = harness(() => page('<dl><dt>Observed term</dt></dl>', { loading: true, truncated: true }));
    const out = await h.batch([{ do: 'read', data_format: 'entries' }, { do: 'data', pipeline: [{ transform: 'count' }] }]);
    expect(out.tabs[0].reads[1].data).toMatchObject({ value: 1, source_complete: false, sources: [{ coverage: { representation: 'entries' } }] });
    const unused = harness(() => page('Unused'));
    await expect(unused.batch([{ do: 'click', selector: 'button' }, { do: 'read', data_format: 'guessed' }])).rejects.toThrow('data_format');
    expect(unused.dispatch).not.toHaveBeenCalled();
  });

  it('collects more than the legacy response budget and computes without sending raw rows to the model', async () => {
    const html = Array.from({ length: 60 }, (_, i) => `<article><b class="name">${i}</b><p>${'x'.repeat(1_000)}</p><i class="tag">${i % 2 ? 'other' : 'news'}</i></article>`).join('');
    const h = harness(() => page(html));
    const answer = await h.batch([{ do: 'collect', items: 'article', fields: { name: '.name', body: 'p', tags: { selector: '.tag', many: true } }, max_pages: 1 },
      { do: 'data', pipeline: [{ transform: 'filter', field: 'tags', operator: 'contains', value: 'news' }, { transform: 'reduce', operator: 'count' }] }]);
    expect(answer.tabs[0].reads[0].collection).toMatchObject({ count: 60, records_omitted: true, data_source_complete: true });
    expect(answer.tabs[0].reads[0].collection.records).toBeUndefined();
    expect(answer.tabs[0].reads[1].data).toMatchObject({ value: 30, source_complete: true });
    expect(JSON.stringify(answer).length).toBeLessThan(5_000);
    expect(h.dispatch.mock.calls.map(([r]) => r.action)).toEqual(['reread']);
  });

  it('reuses the returned ref in the same session after disconnect, while rejecting a different session', async () => {
    const h = harness(() => page('<article><b>Ada</b></article>'));
    const capture = await h.batch([{ do: 'collect', items: 'article', fields: { name: 'b' }, max_pages: 1 }]);
    const source = capture.tabs[0].reads[0].collection.data_ref;
    const repeated = await h.batch([{ do: 'collect', items: 'article', fields: { name: 'b' }, max_pages: 1 },
      { do: 'data', source, pipeline: [{ transform: 'pluck', field: 'name' }] }]);
    expect(repeated.tabs[0].reads[0].collection).toMatchObject({ data_ref: source, records_omitted: true });
    expect(repeated.tabs[0].reads[0].collection).not.toHaveProperty('records');
    expect(repeated.tabs[0].reads[1].data.value).toEqual(['Ada']);
    h.disconnect();
    const steps = [{ do: 'data', source, pipeline: [{ transform: 'pluck', field: 'name' }] }];
    const answer = await h.batch(steps, { page: '' });
    expect(answer.data[0].value).toEqual(['Ada']);
    await expect(h.batch(steps, { page: '' }, 'chat-b')).rejects.toThrow('unavailable');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(await browserBatchReadsOnly({ input: { target: '*://*/*', steps }, manifests, dispatcher: undefined, run_id: 'later' })).toBe(true);
  });

  it('captures full read lines for processing even when the ordinary text answer is paginated', async () => {
    const h = harness(() => page(Array.from({ length: 100 }, (_, i) => `<p>Row ${i}: ${'x'.repeat(200)}</p>`).join('')));
    const read = await h.call('dom-inspect', { page: PAGE, form: 'text' });
    expect(read.complete).toBe(false);
    expect(read.data_source_complete).toBe(true);
    const answer = await h.batch([{ do: 'data', source: read.data_ref, pipeline: [{ transform: 'filter', field: 'text', operator: 'contains', value: 'Row ' },
      { transform: 'reduce', operator: 'count' }] }], { page: '' });
    expect(answer.data[0].value).toBe(100);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not turn a loading or truncated read into a complete data source', async () => {
    const h = harness(() => page('<p>Partial source</p>', { truncated: true, loading: true }));
    const read = await h.call('dom-inspect', { page: PAGE, form: 'text' });
    const answer = await h.batch([{ do: 'data', source: read.data_ref, pipeline: [{ transform: 'reduce', operator: 'count' }] }], { page: '' });
    expect(answer.data[0]).toMatchObject({ source_complete: false, sources: [{ complete: false, loading: true, truncated: true }] });
  });

  it('uses the existing table command and preserves every column when labels collide or are unsafe', async () => {
    const h = harness(() => ({ page: PAGE, url, title: 'Items', columns: ['!', 'column_1', '__proto__'], rows: [['A', 'B', 'C']], truncated: false }));
    const answer = await h.batch([{ do: 'table', selector: 'table' }, { do: 'data', pipeline: [{ transform: 'slice', end: 1 }] }]);
    expect(answer.tabs[0].reads[1].data.value).toEqual([{ '!': 'A', column_1: 'B', column_3: 'C' }]);
    expect(h.dispatch.mock.calls.map(([r]) => [r.action, r.args])).toEqual([['read_table', { page: PAGE, selector: 'table' }]]);
    const repeated = await h.batch([{ do: 'table', selector: 'table' },
      { do: 'data', source: answer.tabs[0].reads[0].table.data_ref, pipeline: [{ transform: 'slice', end: 1 }] }]);
    expect(repeated.tabs[0].reads[0].table).not.toHaveProperty('rows');
    expect(repeated.tabs[0].reads[1].data.value).toEqual(answer.tabs[0].reads[1].data.value);
  });

  it('retains Unicode and punctuation headers, resolves duplicates without shadowing original keys, and queries the exact columns', async () => {
    const h = harness(() => ({ page: PAGE, url, title: '多言語',
      columns: ['姓名', '姓名', '姓名_2', '金額.含税', '', '__proto__', '!', 'column_6'],
      rows: [['阿明', 'A', 'B', '¥12.00', 'empty', 'protected', 'punctuation', 'original'],
        ['王五', 'C', 'D', '¥3.00', '', '', '', '']], truncated: false }));
    const answer = await h.batch([{ do: 'table', selector: '#records' }]);
    const table = answer.tabs[0].reads[0].table;
    expect(table.data_columns.map((column: { field: string }) => column.field))
      .toEqual(['姓名', '姓名_3', '姓名_2', '金額.含税', 'column_5', 'column_6_2', '!', 'column_6']);
    expect(table.data_hint.note).toContain('Header rows are already excluded');
    h.disconnect();
    const result = await h.batch([{ do: 'data', source: table.data_ref,
      pipeline: [{ transform: 'min_by', field: '金額.含税', value_type: 'number', format: { style: 'currency', unit: '¥' } }],
      select: ['姓名', '金額.含税'] }], { page: '' });
    expect(result.data[0].value).toEqual({ 姓名: '王五', '金額.含税': '¥3.00' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed transforms and foreign references before the first browser effect', async () => {
    const h = harness(() => page('<p>Unused</p>'));
    await expect(h.batch([{ do: 'click', selector: 'button' }, { do: 'data', pipeline: [{ transform: 'filter', field: 'name', operator: 'typo', value: 'x' }] }])).rejects.toThrow('choice');
    await expect(h.batch([{ do: 'click', selector: 'button' }, { do: 'data', source: 'data:00000000-0000-0000-0000-000000000000', pipeline: [{ transform: 'count' }] }])).rejects.toThrow('unavailable');
    await expect(h.batch([{ do: 'click', selector: 'button' }, { do: 'data', pipeline: [{ transform: 'group_by', field: 'section',
      aggregate: { last: { operator: 'last', field: 42 } } }] }])).rejects.toThrow('group_by.aggregate');
    expect(h.dispatch).not.toHaveBeenCalled();
    h.disconnect();
    expect(await h.batch([{ do: 'data', describe: ['table.join'] }], { page: '' })).toMatchObject({ done: 1, data: [{ schemas: expect.any(Object) }] });
  });

  it('bounds schema-only batch output without requiring a browser', async () => {
    const h = harness(() => page('Unused')); h.disconnect();
    const answer = await h.batch(new Array(20).fill({ do: 'data', describe: ['table.map', 'table.join', 'table.aggregate', 'table.sort', 'filter', 'map'] }), { page: '' });
    expect(JSON.stringify(answer).length).toBeLessThan(60_000);
    expect(answer.data.some((item: Record<string, unknown>) => item.value_omitted === true)).toBe(true);
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

it('keeps loading entries incomplete while offering no readiness batch when controls are already captured', async () => {
  const h = harness(() => page('<main><input ref="e1" type="password"><ul><li>Observed row</li></ul></main>', { loading: true }));
  const result = await h.batch([{ do: 'read', data_format: 'entries' }]);
  const first = result.tabs[0].reads[0];
  expect(first).toMatchObject({ complete: false, data_source_complete: false,
    interaction_targets: { source_complete: false, captured_editable_fields: 1 },
    loading_recovery: { observed_controls_usable: true } });
  expect(first.loading_recovery).not.toHaveProperty('steps');
  expect(first).not.toHaveProperty('next_step');
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});

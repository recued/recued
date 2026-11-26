import { describe, expect, it, vi } from 'vitest';
import { parseBrowserDataStep, isBrowserExtractionTargets, type ChatPriorToolCall } from '@recued/contracts';
import { projectBrowserAgentEvidence } from '../browser-agent-evidence.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { createBrowserDataStore } from '../bridges/browser-data-store.js';
import { browserDataHint } from '../bridges/browser-data-hints.js';
import { browserRetainedData } from '../bridges/browser-retained-data.js';
import { browserDataResult, runBrowserDataPipeline } from '../bridges/browser-data-pipeline.js';
import { browserCollectHint, collectBrowserPages } from '../bridges/browser-collect.js';
import { browserExtractionTargets } from '../bridges/browser-extraction-targets.js';
import { parseBrowserActSteps, readBrowserFailure } from '@recued/contracts';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome } from '../bridges/dispatcher.js';

const page = 'bridge:owner:7:DESTINATION';
const render = (recipe_id: string, data: unknown) => ({ recipe_id, success: true, errors: [], output: { render: [{ type: 'json', data }] } });
const native = (result: Record<string, unknown>) => {
  const call: ChatPriorToolCall = { tool_name: 'recued-core/act-on-web-page', tier: 2, args: {}, status: result.success === false ? 'error' : 'ok', started_at: 1, completed_at: 2, result };
  return JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Verify the browser result.' },
    prior_tool_calls: [call] }).body).prior_tool_calls[0].result;
};

describe('host browser evidence at the native model boundary', () => {
  it('marks separate returned tables and supplies an executable same-owner merge without copying cells, repeating reads or upgrading coverage', async () => {
    const values = [[['CELL-SENTINEL', 'East'], ['Blake', 'West']], [['Casey', 'North']], [['Drew', 'South']], [['Emery', 'East']]];
    let captured = 0;
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'owner', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.12', idempotency_key_seen: false, status: 'ok',
        outputs: { page, url: 'https://example.test/tables', title: 'Tables', columns: ['Name', 'State'],
          rows: values[captured++], loading: captured === 4, truncated: false } } }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      pageReads: createPageReadStore(), data: createBrowserDataStore(),
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const invoke = (steps: unknown[]) => adapter({ slug: 'dom-act', risk_tier: 'read',
      input: { target: '*://*/*', page, steps }, output: {} });
    const answer = await invoke([{ do: 'table' }, { do: 'table' }, { do: 'table' }, { do: 'table' }]);
    const before = JSON.stringify(answer), sent = native(render('act-on-web-page', answer)), guide = sent.browser_guidance;
    expect(guide.result_use).toMatchObject({ table_rows_returned: true,
      table_snapshots: [{ rows: 2, complete: true, step: 1 }, { rows: 1, complete: true, step: 2 },
        { rows: 1, complete: true, step: 3 }, { rows: 1, complete: false, step: 4 }] });
    expect(JSON.stringify(guide)).not.toContain('CELL-SENTINEL');
    expect(JSON.stringify(guide).length).toBeLessThanOrEqual(1_800);
    const merge = guide.options.find((option: { kind: string }) => option.kind === 'combine_tables').step;
    expect(parseBrowserActSteps([merge]).ok).toBe(true);
    const combined = await invoke([merge]) as { data: Array<{ value: unknown; source_complete: boolean }> };
    expect(combined.data[0]).toMatchObject({ value: [
      { Name: 'CELL-SENTINEL', State: 'East' }, { Name: 'Blake', State: 'West' }, { Name: 'Casey', State: 'North' },
      { Name: 'Drew', State: 'South' }, { Name: 'Emery', State: 'East' },
    ], source_complete: false });
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(answer)).toBe(before);
  });

  it('does not offer a table merge for mismatched columns, omitted rows or an unrelated recipe', () => {
    const table = (ref: number, field: string) => ({ data_ref: `data:00000000-0000-0000-0000-00000000000${ref}`,
      data_columns: [{ field }], rows: [['Visible']], data_source_complete: true });
    const result = render('act-on-web-page', { tabs: [{ reads: [{ table: table(1, 'Name') }, { table: table(2, 'Other') }] }] });
    const guide = native(result).browser_guidance;
    expect(guide.result_use.table_snapshots).toHaveLength(2);
    expect(guide.options.some((option: { kind: string }) => option.kind === 'combine_tables')).toBe(false);
    const repeated = native(render('act-on-web-page', { tabs: [{ reads: [{ table: table(1, 'Name') }, { table: table(1, 'Name') }] }] })).browser_guidance;
    expect(repeated.result_use.table_snapshots).toHaveLength(2);
    expect(repeated.options.some((option: { kind: string }) => option.kind === 'combine_tables')).toBe(false);
    expect(native(render('act-on-web-page', { tabs: [{ reads: [{ table: { ...table(1, 'Name'), rows: undefined, value_omitted: true } }] }] }))
      .browser_guidance?.result_use).toBeUndefined();
    expect(projectBrowserAgentEvidence({ ...result, recipe_id: 'unrelated-recipe' })).not.toHaveProperty('browser_guidance');
  });

  it('offers literal traversal caps for observed linked records and preserves a single-page hint when Next is absent', () => {
    const cards = '<main>' + ['Arden', 'Blake', 'Casey'].map(name => `<article class="card"><b class="name">${name}</b><i class="price">£2.00</i></article>`).join('');
    for (const next of ['', '<a href="/items/2">Next</a>']) {
      const html = cards + next + '</main>', url = 'https://example.test/items/1';
      const hint = browserCollectHint(html, url)!, before = JSON.stringify(hint);
      expect(hint.step.max_pages).toBe(1);
      const extraction_targets = browserExtractionTargets(html, { url, whole: true, complete: true, collection: hint });
      const sent = native(render('inspect-web-page', { page, collection_hint: hint, extraction_targets }));
      const step = sent.browser_guidance.options.find((option: { kind: string }) => option.kind === 'collect').step;
      expect(step).toMatchObject({ max_pages: next ? 20 : 1, max_items: next ? 500 : 200 });
      expect(parseBrowserActSteps([step]).ok).toBe(true);
      expect(parseBrowserActSteps([{ ...step, max_pages: 0, max_items: 0 }]).ok).toBe(false);
      expect(JSON.stringify(hint)).toBe(before);
    }
  });

  it.each([false, true])('offers prose for an actual empty scoped entry capture without changing coverage or executing the option (loading=%s)', async loading => {
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'owner', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.12', idempotency_key_seen: false, status: 'ok',
        outputs: { page: '7:DOC1', url: 'https://example.test/prose', title: 'Prose', loading, truncated: false,
          html: '<article class="card"><p>Observed prose remains readable.</p></article>', selector_matches: 10, selected_index: 1 } } }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      pageReads: createPageReadStore(), data: createBrowserDataStore(),
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const answer = await adapter({ slug: 'dom-act', risk_tier: 'read', input: { target: '*://*/*', page: '7:DOC1',
      steps: [{ do: 'read', selector: '.card', data_format: 'entries' }] }, output: {} });
    const packet = native(render('act-on-web-page', answer));
    const read = packet.output.render[0].data.tabs[0].reads[0];
    expect(read.data_hint).toMatchObject({ representation: 'semantic_entries', row_count: 0 });
    expect(read.data_hint).not.toHaveProperty('step');
    expect(read.read_state).toMatchObject({ scope: { kind: 'element', matched_count: 10, selected_index: 1 }, complete: !loading });
    expect(packet.browser_guidance.empty_entries).toMatchObject({ captured_rows: 0, source_complete: !loading, scope: 'captured_element_entries' });
    const options = packet.browser_guidance.options;
    expect(options.map((option: { kind: string }) => option.kind)).toEqual(['read_prose']);
    expect(options[0].step).toEqual({ do: 'read', page: packet.output.render[0].data.tabs[0].page, form: 'text' });
    expect(parseBrowserActSteps([options[0].step]).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // Zero remains a legitimate explicit count of this retained representation.
    const counted = await adapter({ slug: 'dom-act', risk_tier: 'read', input: { target: '*://*/*',
      steps: [{ do: 'data', source: read.data_ref, pipeline: [{ transform: 'count' }] }] }, output: {} });
    expect(counted).toMatchObject({ data: [{ value: 0, source_complete: !loading }] });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps empty-entry feedback without inventing a prose action from a URL', () => {
    const store = createBrowserDataStore();
    const saved = store.keep('owner', [], [{ kind: 'read', page: '7:DOC1', url: 'https://example.test', title: '',
      complete: true, truncated: false, loading: false, coverage: { representation: 'entries' } }]);
    const packet = native(render('inspect-web-page', { page: 'https://example.test', data_format: 'entries',
      data_ref: saved.descriptor.data_ref, data_source_complete: true, data_hint: browserDataHint(saved) }));
    expect(packet.browser_guidance).toMatchObject({ empty_entries: { captured_rows: 0, scope: 'unknown', source_complete: true }, options: [] });
  });
  it('puts selector cardinality and selected ordinal at the native boundary without prescribing another read', () => {
    const read = { page, outline: 'First quote', complete: true, read_state: { source: 'bridge_read',
      scope: { kind: 'element', form: 'outline', selector: '.quote', first_match: true, matched_count: 10, selected_index: 1 },
      loading: false, complete: true, truncated: false } };
    const packet = native(render('act-on-web-page', { tabs: [{ page, reads: [read] }] }));
    expect(packet.browser_attention).toMatchObject({ kind: 'element_selection', scope: { matched_count: 10, selected_index: 1 },
      selection: { index_base: 1, order: 'dom', selected_roots: 1 }, page });
    expect(packet.browser_attention).not.toHaveProperty('next_step');
    expect(packet.output.render[0].data.tabs[0].reads[0].read_state.complete).toBe(true);
  });
  it('shows a checked projection repair and earlier whole values at the native boundary without executing it', () => {
    const store = createBrowserDataStore();
    const saved = store.keep('owner', [{ 'Full Name': 'Blake' }, { 'Full Name': 'Arden' }],
      [{ kind: 'table', page, url: 'https://example.test', title: '', complete: true, truncated: false, loading: false }]);
    let caught: unknown;
    try { runBrowserDataPipeline({ step: { do: 'data', source: saved.descriptor.data_ref,
      pipeline: [{ transform: 'sort', field: 'Full Name' }, { transform: 'project', expression: { name: '{{item["Full Name"]}}' } }] },
      store, scope: 'owner', assertActive() {} }); } catch (error) { caught = error; }
    const details = { ...readBrowserFailure(caught)!.details,
      batch_progress: { total_steps: 2, failed_step: 2, completed_steps: [1], effects: [], recovery: 'inspect_before_repeating_actions' },
      completed_data: [{ step: 1, from: 'table',
      ...browserRetainedData(saved.descriptor), value_omitted: false, value: saved.value }] };
    const result = { recipe_id: 'act-on-web-page', success: false,
      errors: [{ code: 'DOM_CHECK_FAILED', source: { ingredient_slug: 'dom-act' }, details }] };
    const before = JSON.stringify(result), packet = native(result);
    const repair = packet.browser_guidance.options.find((option: { kind: string }) => option.kind === 'data_repair');
    expect(repair).toMatchObject({ input_kind: 'array', step: { source: saved.descriptor.data_ref } });
    const parsed = parseBrowserDataStep(repair.step);
    if (!parsed.ok) throw Error(parsed.error);
    expect(runBrowserDataPipeline({ step: parsed.step, store, scope: 'owner', assertActive() {} }).value)
      .toEqual([{ name: 'Arden' }, { name: 'Blake' }]);
    expect(packet.errors[0].details.completed_data[0].value).toEqual(saved.value);
    expect(packet.browser_guidance.result_use).toBeDefined();
    expect(JSON.stringify(packet.browser_guidance).length).toBeLessThanOrEqual(1_800);
    expect(JSON.stringify(result)).toBe(before);
    for (const repair_step of [{ do: 'click', ref: 'e1' }, { ...repair.step, source: 'data:00000000-0000-0000-0000-000000000000' }]) {
      expect(readBrowserFailure({ code: 'DOM_CHECK_FAILED', browser_failure: { slug: 'dom-act',
        details: { data_failure: { ...details.data_failure, repair_step } } } })).toBeUndefined();
    }
  });

  it('promotes formatting sufficient computed results in both actual batch shapes without promoting partial coverage', () => {
    const ref = 'data:12345678-1234-1234-1234-123456789abc';
    for (const source_complete of [true, false]) for (const shape of [
      { data: [{ data_ref: ref, source_complete, value: [{ count: 2, last: 'Observed phrase' }] }] },
      { tabs: [{ page, reads: [{ data: { data_ref: ref, source_complete, value: [{ count: 2, last: 'Observed phrase' }] } }] }] },
    ]) {
      const sent = native(render('act-on-web-page', shape));
      expect(sent.browser_guidance.result_use).toMatchObject({ value_returned: true, source_complete });
      expect(JSON.stringify(sent.browser_guidance).length).toBeLessThanOrEqual(1_800);
    }
    expect(native(render('act-on-web-page', { data: [{ data_ref: ref, source_complete: true, value_omitted: true }] })).browser_guidance?.result_use)
      .toBeUndefined();
  });

  it('recovers missing record facts from a scalar query through its exact retained input without browser replay', () => {
    const store = createBrowserDataStore();
    const saved = store.keep('owner', [{ author: 'FACT-SENTINEL', labels: ['selected'] }, { author: 'Other', labels: [] }],
      [{ kind: 'collection', page, url: 'https://example.test/records', title: '', complete: false, truncated: false, loading: false }]);
    for (const named of [false, true]) {
      const count = runBrowserDataPipeline({ step: { do: 'data', source: saved.descriptor.data_ref, pipeline: [
        { transform: 'filter', field: 'labels', operator: 'contains', value: 'selected' }, { transform: 'count', id: 'count' },
      ], ...(named ? { return: ['count'] } : {}) }, store, scope: 'owner', assertActive() {} });
      const result = render('act-on-web-page', { data: [browserDataResult(count)] }), before = JSON.stringify(result);
      const guide = native(result).browser_guidance;
      expect(guide.result_use).toMatchObject({ value_returned: true, result_kind: named ? 'scalar_fields' : 'scalar', record_rows_returned: false, source_complete: false });
      const option = guide.options.find((option: { kind: string }) => option.kind === 'inspect_query_source');
      expect(option.step).toMatchObject({ do: 'data', source: saved.descriptor.data_ref });
      const preview = parseBrowserDataStep(option.step);
      if (!preview.ok) throw Error(preview.error);
      expect(runBrowserDataPipeline({ step: preview.step, store, scope: 'owner', assertActive() {} }).value).toEqual(saved.value);
      const query = parseBrowserDataStep({ ...option.step, pipeline: [
        { transform: 'filter', field: 'labels', operator: 'contains', value: 'selected' },
        { transform: 'map', expression: { author: '{{item.author}}' } },
      ] });
      if (!query.ok) throw Error(query.error);
      const recovered = runBrowserDataPipeline({ step: query.step, store, scope: 'owner', assertActive() {} });
      expect(recovered.value).toEqual([{ author: 'FACT-SENTINEL' }]); expect(recovered.descriptor.source_complete).toBe(false);
      expect(() => runBrowserDataPipeline({ step: query.step, store, scope: 'different-owner', assertActive() {} })).toThrow();
      expect(count.value).toEqual(named ? { count: 1 } : 1); expect(JSON.stringify(result)).toBe(before);
      expect(JSON.stringify(guide)).not.toContain('FACT-SENTINEL'); expect(JSON.stringify(guide).length).toBeLessThanOrEqual(1_800);
      for (const input_source of [undefined, { data_ref: saved.descriptor.data_ref, kind: 'number' }, { data_ref: 'forged', kind: 'array' }]) {
        const packet = native(render('act-on-web-page', { data: [{ ...browserDataResult(count), input_source }] }));
        expect(packet.browser_guidance.result_use.value_returned).toBe(true);
        expect(packet.browser_guidance.options).toEqual([]);
      }
    }
  });

  it('executes the rows-and-count branch example with a requested filter while preserving source coverage', () => {
    const store = createBrowserDataStore();
    const saved = store.keep('owner', [{ name: 'Arden', labels: ['chosen'] }, { name: 'Blake', labels: [] }, { name: 'Cedar', labels: ['chosen'] }],
      [{ kind: 'collection', page, url: 'https://example.test', title: '', complete: false, truncated: true, loading: false }]);
    const hint = browserDataHint(saved);
    const view = { data_ref: saved.descriptor.data_ref, data_source_complete: false, data_hint: hint };
    const packet = native(render('act-on-web-page', { tabs: [{ page, reads: [{ collection: view }] }] }));
    const example = packet.browser_guidance.options.find((option: { kind: string }) => option.kind === 'data').step;
    const whole = parseBrowserDataStep(example);
    if (!whole.ok) throw Error(whole.error);
    expect(runBrowserDataPipeline({ step: whole.step, store, scope: 'owner', assertActive() {} }).value)
      .toEqual({ rows: saved.value, count: 3 });
    const parsed = parseBrowserDataStep({ ...example, pipeline: [
      { transform: 'filter', field: 'labels', operator: 'contains', value: 'chosen', id: 'rows' }, ...example.pipeline.slice(1)] });
    if (!parsed.ok) throw Error(parsed.error);
    const result = runBrowserDataPipeline({ step: parsed.step, store, scope: 'owner', assertActive() {} });
    expect(result.value).toEqual({ rows: [{ name: 'Arden', labels: ['chosen'] }, { name: 'Cedar', labels: ['chosen'] }], count: 2 });
    expect(result.descriptor.source_complete).toBe(false);
  });

  it('offers an exact file-link save and aligned header metadata without inventing actions from active links', () => {
    const html = '<main><table id="records" data-recued-table-layout="1"><thead><tr><th rowspan="2">ID</th><th colspan="2">Identity</th></tr>'
      + '<tr><th>Student Name</th><th>Price</th></tr></thead><tbody><tr><td>001</td><td>Arden</td><td>£9.00</td></tr></tbody></table>'
      + '<a ref="e12" href="/files/report.zip">Report</a><a ref="e13" href="javascript:alert(1)" data-recued-download>Bad</a></main>';
    const targets = browserExtractionTargets(html, { url: 'https://example.test', whole: true, complete: true });
    expect(isBrowserExtractionTargets(targets)).toBe(true);
    expect(targets.tables[0]).toMatchObject({ columns: ['ID', 'Identity / Student Name', 'Identity / Price'], columns_complete: true });
    expect(targets.files).toEqual([{ step: { do: 'download', ref: 'e12' }, label: 'Report' }]);
    const sent = native(render('inspect-web-page', { page, text: 'Observed page', extraction_targets: targets }));
    expect(sent.browser_guidance.options[0]).toMatchObject({ kind: 'save_file', step: { do: 'download', ref: 'e12', page } });
    expect(parseBrowserActSteps([sent.browser_guidance.options[0].step]).ok).toBe(true);
    const legacy = browserExtractionTargets(html.replace(' data-recued-table-layout="1"', ''), { url: 'https://example.test', whole: true, complete: true });
    expect(legacy.tables[0]).toMatchObject({ headers: ['ID', 'Identity', 'Student Name', 'Price'], columns_complete: false });
    expect(legacy.tables[0]).not.toHaveProperty('columns');
  });

  it('surfaces derived incomplete coverage and an explicitly older source without silently changing either', () => {
    const old = 'data:12345678-1234-1234-1234-123456789abc', newer = 'data:12345678-1234-1234-1234-123456789abd';
    const issue = { kind: 'collection', stop_reason: 'missing_field:tags', records: 27, scanned: 28, requested_pages: 3,
      pages_processed: 2, coverage_complete: false, field: { name: 'tags', many: true, required: true, matches: 0 } };
    const value = { value: 6, source_complete: false, source_issues: [issue], input_source: { selection: 'explicit', data_ref: old, latest_in_batch: newer } };
    for (const shape of [{ data: [value] }, { tabs: [{ page, reads: [{ data: value }] }] }]) {
      const result = render('act-on-web-page', shape), before = JSON.stringify(result);
      expect(native(result).browser_attention).toMatchObject({ kind: 'partial_data', complete: false, source_issues: [issue], source_selection: { selected_ref: old, newer_ref: newer } });
      expect(JSON.stringify(result)).toBe(before);
    }
    expect(native(render('act-on-web-page', { data: [{ ...value, source_issues: undefined }] })).browser_attention)
      .toMatchObject({ kind: 'source_selection', selected_ref: old, newer_ref: newer });
  });

  it('offers checked table and exact-column examples that execute with spaced keys without mutating source evidence', () => {
    const store = createBrowserDataStore();
    const rows = [{ 'Last Name': 'Arden', Amount: '$7.50' }, { 'Last Name': 'Blake', Amount: '$3.00' }];
    const saved = store.keep('owner', rows, [{ kind: 'table', page, url: 'https://example.test', title: '', complete: false, truncated: true, loading: false }]);
    const view = { page, columns: ['Last Name', 'Amount'], rows: rows.map(row => Object.values(row)), data_ref: saved.descriptor.data_ref,
      data_source_complete: false, data_hint: browserDataHint(saved), extraction_targets: { source: 'captured_dom', scope: 'page', source_complete: true,
        tables_complete: true, tables: [{ step: { do: 'table', selector: '#observed' } }] } };
    const result = { ...render('read-web-table', view), browser_guidance: { options: [{ kind: 'forged', step: { do: 'click', ref: 'e1' } }] } };
    const before = JSON.stringify(result), sent = native(result);
    expect(sent.browser_guidance.options[0]).toMatchObject({ kind: 'table', step: { do: 'table', page, selector: '#observed' } });
    const select = sent.browser_guidance.options.find((option: { kind: string }) => option.kind === 'select_columns');
    expect(select).toMatchObject({ source_complete: false, step: { source: saved.descriptor.data_ref, select: ['Last Name', 'Amount'] } });
    const parsed = parseBrowserDataStep(select.step);
    if (!parsed.ok) throw Error(parsed.error);
    const output = runBrowserDataPipeline({ step: parsed.step, store, scope: 'owner', assertActive() {} });
    expect(output.value).toEqual(rows);
    expect(output.descriptor.source_complete).toBe(false);
    expect(JSON.stringify(result)).toBe(before);
    expect(JSON.stringify(sent.browser_guidance).length).toBeLessThanOrEqual(1_800);
    const omitted = { ...saved.descriptor, value_omitted: true };
    for (const shape of [{ data: [omitted] }, { tabs: [{ page, reads: [{ data: omitted }] }] }]) {
      const packet = native(render('act-on-web-page', shape));
      const reuse = packet.browser_guidance.options.find((option: { kind: string }) => option.kind === 'reuse_data');
      const correction = parseBrowserDataStep(reuse.step);
      if (!correction.ok) throw Error(correction.error);
      expect(runBrowserDataPipeline({ step: correction.step, store, scope: 'owner', assertActive() {} }).value).toEqual(rows);
      expect(reuse.source_complete).toBe(false);
    }
  });

  it('offers a checked card collector whose supplied fields can return a filtered set and count in one step', async () => {
    const html = '<main>' + ['Arden', 'Blake', 'Cedar'].map(name => '<article class="card"><b class="name">' + name + '</b><span class="amount">$3.00</span></article>').join('') + '</main>';
    const url = 'https://example.test/items', collection = browserCollectHint(html, url);
    expect(collection).toBeDefined();
    const view = { page, text: 'Cards', collection_hint: collection,
      extraction_targets: browserExtractionTargets(html, { url, whole: true, complete: true, collection }) };
    const sent = native(render('inspect-web-page', view));
    const option = sent.browser_guidance.options.find((value: { kind: string }) => value.kind === 'collect');
    expect(sent.browser_guidance.options.some((value: { kind: string }) => value.kind === 'table')).toBe(false);
    const parsed = parseBrowserActSteps([{ ...option.step, where: { field: 'name', equals: 'Blake' } }]);
    if (!parsed.ok || parsed.steps[0]?.do !== 'collect') throw Error('Expected an executable collection');
    const output = await collectBrowserPages({ spec: parsed.steps[0], read: async () => ({ page, url, title: '', html, truncated: false }),
      navigate: async () => { throw Error('One-page advice must not navigate'); }, assertActive() {} });
    expect(output.records.map(row => row.values.name)).toEqual(['Blake']);
    expect(output).toMatchObject({ count: 1, scanned: 3, coverage: { complete: true } });
    expect(native(render('inspect-web-page', { text: JSON.stringify(view) }))).not.toHaveProperty('browser_guidance');
    expect(native(render('another-recipe', view))).not.toHaveProperty('browser_guidance');
  });

  it('returns schema discovery for a statically invalid mixed collect/data plan before any browser effect', async () => {
    const dispatch = vi.fn();
    const adapter = createBridgeDomAdapter({ getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }),
      pageReads: createPageReadStore(), data: createBrowserDataStore(),
      manifests: { get: slug => KERNEL_MANIFESTS.find(manifest => manifest.slug === slug) ?? null } });
    const error = await adapter({ slug: 'dom-act', risk_tier: 'read', input: { target: '*://*/*', page,
      steps: [{ do: 'collect', items: '.quote', fields: { text: '.text' }, max_pages: 1 },
        { do: 'data', source: 'latest', pipeline: [{ transform: 'filter', field: 'text', operator: 'contains', value: 'chosen' },
          { transform: 'count' }, { transform: 'project', expression: { text: '{{item.text}}' } }] }] }, output: {} }).catch(error => error);
    const details = readBrowserFailure(error)!.details;
    expect(details).toMatchObject({ executed: false, data_schema_step: { do: 'data', describe: ['project', 'map'] } });
    expect(details).not.toHaveProperty('batch_progress'); expect(dispatch).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'DOM_SELECTOR_MISSING' });
    const packet = native({ recipe_id: 'act-on-web-page', success: false, errors: [{ code: 'DOM_SELECTOR_MISSING',
      source: { ingredient_slug: 'dom-act' }, details }] });
    expect(packet.browser_guidance.options[0]).toMatchObject({ kind: 'data_schema', step: details.data_schema_step });
    expect(parseBrowserActSteps([packet.browser_guidance.options[0].step]).ok).toBe(true);
  });

  it('promotes canonical refused-data discovery to an executable schema call without replaying the rejected plan', () => {
    const rejected = parseBrowserActSteps([{ do: 'read' }, { do: 'data', pipeline: [{ transform: 'map', expression: '{{item.parts[0]}}' }] }]);
    if (rejected.ok) throw Error('Expected refusal');
    const details = { executed: false, data_schema_step: rejected.data_schema_step };
    const failure = { code: 'DOM_SELECTOR_MISSING', browser_failure: { slug: 'dom-act', details } };
    expect(readBrowserFailure(failure)?.details.data_schema_step).toEqual({ do: 'data', describe: ['map'] });
    const sent = native({ recipe_id: 'act-on-web-page', success: false, errors: [{ code: failure.code, source: { ingredient_slug: 'dom-act' }, details }] });
    const parsed = parseBrowserActSteps([sent.browser_guidance.options[0].step]);
    expect(parsed).toMatchObject({ ok: true, steps: [{ do: 'data', describe: ['map'] }] });
    expect(sent.browser_guidance.options[0].step).not.toHaveProperty('pipeline');
    for (const invalid of [
      { executed: false, data_schema_step: { do: 'click', ref: 'e1' } },
      { data_schema_step: rejected.data_schema_step },
    ]) expect(readBrowserFailure({ ...failure, browser_failure: { slug: 'dom-act', details: invalid } })).toBeUndefined();
  });

  it('promotes the validated acknowledged-page read without changing the run or inventing recovery for uncertain delivery', () => {
    const progress = { total_steps: 2, failed_step: 2, completed_steps: [1], effects: [{ step: 1, attempted: 1, acknowledged: 1 }],
      page_state: 'ready', current_page: page, recovery: 'inspect_before_repeating_actions', next_step: { do: 'read', page, form: 'outline' } };
    const result = { recipe_id: 'act-on-web-page', success: false, errors: [{ code: 'DOM_CHECK_FAILED', source: { ingredient_slug: 'dom-act' },
      details: { batch_progress: progress } }], output: { render: [{ type: 'json', data: null }] } };
    const before = JSON.stringify(result), sent = native(result);
    expect(sent.browser_attention).toMatchObject({ kind: 'batch_stopped', failed_step: 2, completed_steps: [1], effects: progress.effects });
    expect(sent.browser_attention).not.toHaveProperty('next_step');
    expect(sent.errors[0].details.batch_progress).not.toHaveProperty('next_step');
    expect(sent.errors[0].details.batch_progress).not.toHaveProperty('recovery');
    expect(JSON.stringify(result)).toBe(before);
    for (const changed of [
      { ...result, recipe_id: 'unrelated-recipe' },
      { ...result, errors: [{ ...result.errors[0], code: 'ACTION_DELIVERY_UNCERTAIN' }] },
      { ...result, errors: [{ ...result.errors[0], details: { batch_progress: { ...progress, next_step: { do: 'click', ref: 'e1' } } } }] },
    ]) expect(projectBrowserAgentEvidence(changed)).not.toHaveProperty('browser_attention');
  });

  it('distinguishes a stopped required field from completed requested-page coverage in the native packet', () => {
    const collection = { complete: false, count: 27, scanned: 28, stop_reason: 'missing_field:labels', coverage: { complete: false },
      field_failure: { field: 'labels', required: true, many: true, matches: 0, restart_url: 'https://example.com/list/1',
        read_step: { do: 'read', page, form: 'outline' } }, records: [{ values: { text: 'Earlier captured item' } }] };
    const result = render('act-on-web-page', { tabs: [{ reads: [{ collection }] }] });
    const sent = native(result);
    expect(sent.browser_attention).toMatchObject({ kind: 'partial_collection', required: true, matches: 0, continuation: { page, form: 'outline' }, restart_url: collection.field_failure.restart_url });
    expect(sent.browser_attention).not.toHaveProperty('next_step');
    expect(sent.browser_attention.note).not.toMatch(/required:false|inspect|restart at/i);
    expect(result.output.render[0]!.data).toEqual({ tabs: [{ reads: [{ collection }] }] });
    const completeBound = render('act-on-web-page', { tabs: [{ reads: [{ collection: { ...collection, stop_reason: 'max_pages', coverage: { complete: true } } }] }] });
    expect(native(completeBound)).not.toHaveProperty('browser_attention');
  });

  it('describes a scoped retained source without prescribing a pipeline for the incomplete excerpt', () => {
    const store = createBrowserDataStore();
    const rows = [{ kind: 'definition_term', section: 'Catalog', group: 'A', text: 'First' },
      { kind: 'definition_term', section: 'Catalog', group: 'A', text: 'Last' },
      { kind: 'definition_term', section: 'Other', group: 'B', text: 'Excluded' }];
    const saved = store.keep('owner', rows, [{ kind: 'read', page, url: 'https://example.com', title: '', complete: true, truncated: false, loading: false }]);
    const data_hint = browserDataHint(saved, 'catalog');
    const view = { page, text: 'First', complete: false, read_state: { source: 'kept_snapshot', scope: { kind: 'section', form: 'text', find: 'Catalog' },
      loading: false, complete: false, truncated: false }, next_step: { do: 'read', page, form: 'text', from: 10 },
      entry_data: { data_ref: saved.descriptor.data_ref, data_source_complete: true, data_hint } };
    const sent = native(render('act-on-web-page', { tabs: [{ reads: [view] }] }));
    expect(sent.browser_attention).toMatchObject({ kind: 'partial_read', complete: false, entry_data: { source_complete: true, requested_section: 'Catalog' } });
    expect(sent.browser_attention.entry_data).not.toHaveProperty('step');
    expect(sent.browser_attention.continuation).toEqual({ page, form: 'text', from: 10 });
    const parsed = parseBrowserActSteps([data_hint.step]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw Error(parsed.error);
    const step = parsed.steps[0];
    if (step?.do !== 'data') throw Error('Expected the retained data hint');
    expect(runBrowserDataPipeline({ step, store, scope: 'owner', assertActive() {} }).value).toEqual([{ group: 'A', count: 2, last: 'Last' }]);
    expect(browserDataHint(saved, 'Not observed')).not.toHaveProperty('requested_section');
    const partial = native(render('act-on-web-page', { tabs: [{ reads: [{ ...view, entry_data: { ...view.entry_data, data_source_complete: false } }] }] }));
    expect(partial.browser_attention.entry_data.source_complete).toBe(false);
    const followup = partial.browser_guidance.options.find((option: { kind: string }) => option.kind === 'entries');
    expect(followup.steps).toMatchObject([{ do: 'read', page, data_format: 'entries' }, { do: 'data', source: 'latest' }]);
    expect(parseBrowserActSteps(followup.steps).ok).toBe(true);
    const omitted = { llm_gateway_context_omitted: true, preview: JSON.stringify(view) };
    expect(projectBrowserAgentEvidence(omitted)).toBe(omitted);
  });
});

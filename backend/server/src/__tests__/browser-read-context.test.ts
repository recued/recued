import { describe, expect, it, vi } from 'vitest';
import type { ChatPriorToolCall, RecipeDefinition } from '@recued/contracts';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { browserPartialPreviewNote, projectBrowserReadContext, projectBrowserObservationOrder } from '../browser-read-context.js';
import { composeChatMainTurnPromptParts, runChatTurn } from '../chat-turn-executor.js';
import { projectRunResultForAgent } from '../run-result-agent-projection.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome } from '../bridges/dispatcher.js';

const page = { page: '7:DOC1', url: 'https://example.org/article', title: '.name Grandfathered',
  outline: `${'1 | Article detail.\n'.repeat(100)}2 | [.name Grandfathered](e1)`, truncated: false,
  field_evidence: { scope: 'page', items: [{ tag: 'a', ref: 'e1', fields: {
    text: { value: '.name Grandfathered', source: 'textContent' },
  } }], complete: true, note: 'Literal fields from the page' } };
const call = (data: unknown = page, time = 1): ChatPriorToolCall => ({ tool_name: 'recued-core/inspect-web-page', tier: 2,
  args: { page: page.url, find: '', block: '', from: 0 }, status: 'ok', started_at: time, completed_at: time + 1,
  result: { recipe_id: 'inspect-web-page', run_id: `run-${time}`, success: true, errors: [],
    steps: [{ step_id: 'inspect', status: 'completed', output: data }],
    output: { render: [{ type: 'json', label: 'Page', data }] } } });

describe('identical browser reads in model context', () => {
  it('separates historical controls from retained data within a read/write/read batch and across browser profiles', () => {
    const state = { source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, loading: false, complete: true, truncated: false };
    const old = call({ ...page, page: 'bridge:A:7:LOGIN', read_state: state, data_ref: 'pinned-earlier-data' });
    const other = call({ ...page, page: 'bridge:B:7:LOGIN', read_state: state }, 3);
    const batch = { ...call({}, 5), tool_name: 'recued-core/act-on-web-page',
      args: { page: 'bridge:A:7:LOGIN', steps: [{ do: 'read' }, { do: 'click', selector: 'button' }, { do: 'read' }] },
      result: { recipe_id: 'act-on-web-page', success: true, errors: [], output: { render: [{ type: 'json', data: {
        page: 'bridge:A:7:LOGIN', url: page.url, tabs: [{ page: 'bridge:A:7:LOGIN', url: page.url, reads: [
          { step: 1, outline: 'Login controls', read_state: state }, { step: 3, outline: 'Updated controls', read_state: state },
        ] }],
      } }] } } };
    const projected = projectBrowserObservationOrder([old, other, batch]) as any;
    expect(projected[0].result.output.render[0].data.read_state.context.current_for_controls).toBe(false);
    expect(projected[0].result.output.render[0].data.data_ref).toBe('pinned-earlier-data');
    expect(projected[1].result.output.render[0].data.read_state.context.current_for_controls).toBe(true);
    const reads = projected[2].result.output.render[0].data.tabs[0].reads;
    expect(reads[0].read_state.context.current_for_controls).toBe(false);
    expect(reads[1].read_state.context.current_for_controls).toBe(true);
    expect(reads[0].read_state.complete).toBe(true);
    const proposal = { ...batch, result: { ...batch.result, success: false, errors: [] } };
    expect((projectBrowserObservationOrder([old, proposal])[0]!.result as any).output.render[0].data.read_state.context.current_for_controls).toBe(true);
  });

  it('retires an opening document after read-only pagination and retains the collected data', () => {
    const first = 'bridge:A:7:LIST1', second = 'bridge:A:7:LIST2', other = 'bridge:B:7:LIST1';
    const state = { source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, loading: false, complete: true, truncated: false };
    const opening = call({ ...page, page: first, read_state: state });
    const unrelated = call({ ...page, page: other, read_state: state }, 3);
    const args = { page: first, steps: [{ do: 'collect', items: '.card', fields: { title: '.title' },
      next: { text: 'Next' }, max_pages: 2 }, { do: 'data', pipeline: [{ transform: 'count' }] }] };
    const dataRef = 'data:7664a948-ec66-4ea6-972d-39009d286722';
    for (const destination of [first, second]) {
      const moved = destination !== first;
      const pages = [{ page: first, url: page.url, items: 2 }, ...(moved ? [{ page: second, url: page.url + '?page=2', items: 1 }] : [])];
      const batch: ChatPriorToolCall = { ...call({}, 5), tool_name: 'recued-core/act-on-web-page', args,
        result: { recipe_id: 'act-on-web-page', success: true, output: { render: [{ type: 'json', data: {
          page: destination, tabs: [{ page: destination, reads: [
            { step: 1, collection: { pages, data_ref: dataRef, records_omitted: true } },
            { step: 2, data: { value: moved ? 3 : 2 } },
          ] }],
        } }] } } };
      const packet = JSON.parse(composeChatMainTurnPromptParts({ available_tools: [],
        content: { chat_tail: [], user_message: 'Count the matching cards.' },
        prior_tool_calls: [opening, unrelated, batch], native_browser_page_key: 'collector-regression-test' }).body);
      expect(packet.prior_tool_calls[0].result.output.render[0].data.read_state.context).toMatchObject({
        current_for_controls: !moved, ...(moved ? { invalidated_by_call: 3 } : {}),
      });
      expect(packet.browser_context.pages.map((entry: { page: string; document_handle?: string }) => entry.document_handle ?? entry.page))
        .toEqual(moved ? [other] : [other, first]);
      expect(packet.prior_tool_calls[2].result.output.render[0].data.tabs[0].reads).toMatchObject([
        { step: 1, collection: { data_ref: dataRef } }, { step: 2, data: { value: moved ? 3 : 2 } },
      ]);
    }
  });

  it('marks only matching page, address and read scopes as superseded in the actual native packet', async () => {
    const state = { source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, loading: true, complete: false, truncated: false };
    const old = call({ ...page, loading: true, complete: false, read_state: state });
    const narrow = call({ ...page, complete: true, read_state: { ...state, scope: { kind: 'element', form: 'outline', ref: 'e1' }, loading: false, complete: true } }, 3);
    const fresh = call({ ...page, loading: false, complete: true, read_state: { ...state, loading: false, complete: true } }, 5);
    const input = [old, narrow, fresh], before = JSON.stringify(input);
    const packets: string[] = [];
    await runChatTurn({ session_id: 's', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
      available_tools: [], content: { chat_tail: [], user_message: 'Use the latest matching page observation.' },
      correction_context: [], model_layer: 'byok', held_results: input }, {
      registry: { list: () => [], listByTier: () => [], getByName: () => undefined, dispatch: async () => ({ ok: true, result: null }),
        subscribeRefresh: () => () => undefined } as never,
      dispatchTool: async () => { throw Error('No tool required'); }, executeAiCall: async (_manifest, args) => {
        packets.push(String(args['llm.prompt'])); return { body: { response: 'Current content', events: [], tool_calls: [] } };
      }, emit: () => undefined, now: () => 1000,
    });
    const sent = JSON.parse(packets.find(p => p.includes('prior_tool_calls'))!).prior_tool_calls;
    const states = sent.map((c: { result: unknown }) => JSON.parse(JSON.stringify(c.result)).output.render[0].data.read_state);
    expect(states[0].context).toMatchObject({ latest_for_same_scope: false, superseded_by: states[2].context.observation_id });
    expect(states[1].context.latest_for_same_scope).toBe(true);
    expect(states[2].context.latest_for_same_scope).toBe(true);
    expect(states.map((s: { loading: unknown }) => s.loading)).toEqual([true, false, false]);
    expect(JSON.stringify(input)).toBe(before);
    const others = [old, call({ ...page, page: '8:DOC1', read_state: state }, 7), call({ ...page, url: 'https://example.org/other', read_state: state }, 9),
      call({ ...page, read_state: { ...state, scope: { kind: 'page_part', form: 'outline', from: 50 } } }, 11)];
    const distinct = projectBrowserObservationOrder(others);
    expect(JSON.stringify(distinct)).not.toContain('superseded_by');
    const stable = { ...page, loading: false, complete: true, read_state: { ...state, loading: false, complete: true } };
    const deduped = projectBrowserReadContext([call(stable), call(stable, 3)]);
    expect(deduped.stats.reads_elided).toBe(1);
    expect(JSON.stringify(projectBrowserObservationOrder(deduped.calls))).toContain('duplicate_read');
  });

  it('the native main-turn boundary honors both A/B settings', async () => {
    const calls = [call(), call(page, 3)];
    for (const enabled of [false, true]) {
      vi.stubEnv('RECUED_BROWSER_READ_DEDUP', enabled ? '1' : '0');
      const packets: string[] = [];
      try {
        await runChatTurn({ session_id: 's', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
          available_tools: [], content: { chat_tail: [], user_message: 'State the literal article title.' },
          correction_context: [], model_layer: 'byok', held_results: calls }, {
          registry: { list: () => [], listByTier: () => [], getByName: () => undefined,
            dispatch: async () => ({ ok: true, result: null }), subscribeRefresh: () => () => undefined } as never,
          dispatchTool: async () => { throw new Error('The supplied observations already answer this fixture'); },
          executeAiCall: async (_manifest, input) => {
            packets.push(String(input['llm.prompt']));
            return { body: { response: '.name Grandfathered', events: [], tool_calls: [] } };
          }, emit: () => undefined, now: () => 1000,
        });
        const packet = packets.find(body => body.includes('prior_tool_calls'))!;
        expect(packet).toBeDefined();
        expect(packet.includes('duplicate_read')).toBe(enabled);
        const sent = JSON.parse(packet).prior_tool_calls;
        expect(sent.at(-1).result.output.render[0].data.field_evidence.items[0].fields.text.value).toBe('.name Grandfathered');
        expect(JSON.stringify(calls[0]!.result)).not.toContain('duplicate_read');
      } finally { vi.unstubAllEnvs(); }
    }
  });

  it('retains the latest full snapshot, pointing older copies straight at it without changing stored calls', () => {
    const calls = [call(page, 1), call(page, 3), call(page, 5)];
    const before = JSON.stringify(calls);
    const projected = projectBrowserReadContext(calls);
    expect(projected.stats).toMatchObject({ reads_considered: 3, reads_elided: 2, snapshot_copies_elided: 4 });
    expect(projected.stats.chars_saved).toBeGreaterThan(4000);
    expect(projected.calls[2]).toBe(calls[2]);
    for (const older of projected.calls.slice(0, 2)) {
      expect(older.started_at).toBe(calls[projected.calls.indexOf(older)]!.started_at);
      expect(older.result).toMatchObject({ run_id: expect.any(String), steps: [{ step_id: 'inspect', status: 'completed',
        output: { page: page.page, duplicate_read: { prior_tool_call: 3, snapshot_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } }] });
      expect(JSON.stringify(older.result)).not.toContain('Article detail');
    }
    expect(JSON.stringify(calls)).toBe(before);
    expect(JSON.stringify(projected.calls[2])).toContain('textContent');
  });

  it('preserves changed pages, document handles, refs, literal field values and different read forms', () => {
    const variants = [
      { ...page, outline: page.outline + '\nA new fact' }, { ...page, page: '7:DOC2' },
      { ...page, outline: page.outline.replace('e1', 'e2') },
      { ...page, field_evidence: { ...page.field_evidence, items: [] } },
      { ...page, outline: undefined, text: page.outline }, { ...page, url: page.url + '?other' },
    ];
    for (const changed of variants) expect(projectBrowserReadContext([call(), call(changed, 3)]).stats.reads_elided).toBe(0);
    // Seeing A, then B, then A is a real change sequence, not a duplicate.
    expect(projectBrowserReadContext([call(), call(variants[0], 3), call(page, 5)]).stats.reads_elided).toBe(0);
  });

  it('keeps partial/loading reads and never crosses a write, error, unknown operation or filtered read', () => {
    for (const data of [{ ...page, loading: true }, { ...page, truncated: true }, { ...page, next: 200 }]) {
      expect(projectBrowserReadContext([call(data), call(data, 3)]).stats.reads_elided).toBe(0);
    }
    for (const barrier of [ { ...call(), tool_name: 'recued-core/act-on-web-page' },
      { ...call(), status: 'error' as const }, { ...call(), tool_name: 'unrecognized/read' },
      { ...call(), args: { page: page.url, find: 'article' } } ]) {
      expect(projectBrowserReadContext([call(), barrier, call(page, 5)]).stats.reads_elided).toBe(0);
    }
  });

  it('recomputes after fitting and keeps full data when the later snapshot is missing or elided', () => {
    const old = call();
    expect(projectBrowserReadContext([old]).calls[0]).toBe(old);
    const shortened = { ...call(page, 3), result: { context_elided: true, ref: 'ctx_1' } };
    expect(projectBrowserReadContext([old, shortened]).calls[0]).toBe(old);
    const fitted = projectBrowserReadContext([old, call(page, 3)]);
    expect(fitted.stats.reads_elided).toBe(1);
    expect(projectBrowserReadContext([old]).stats.reads_elided).toBe(0);
  });

  it('deduplicates only raw reads of actual pure batches, keeping differing computations and all browser execution', async () => {
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
      result: { command_id: 'c', status: 'ok', bridge_version: '0.0.10', duration_ms: 1, idempotency_key_seen: false,
        outputs: { page: page.page, url: page.url, title: page.title,
          html: '<main><h1>Catalog</h1><dl><dt>First item</dt><dt>Middle item</dt><dt>Last item</dt></dl>' + '<p>Details.</p>'.repeat(50) + '</main>', truncated: false } } }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const seed = await adapter({ slug: 'dom-inspect', input: { target: '*://*/*', page: page.page, form: 'outline' }, output: {}, risk_tier: 'read' }) as any;
    // Deliberately process entries while the new read captures lines. Different
    // explicit input keeps that raw read in the result, available for dedup.
    const read = async (pipeline: unknown[], time: number): Promise<ChatPriorToolCall> => {
      const steps = [{ do: 'read' }, { do: 'data', source: seed.entry_data.data_ref, pipeline }];
      const recipe: RecipeDefinition = { recipe_id: 'act-on-web-page', version: 12, ttl: 0,
        metadata: { name: 'Act', description: 'Pure batch fixture', author: 'recued-core', supported_platforms: [] },
        variables: {}, prefetch_steps: [], steps: [{ id: 'act', ingredient: 'dom-act', input: { target: '*://*/*', page: page.page, steps } }],
        output: { render: [{ type: 'json', source: 'step.act', label: 'Done' }] } };
      const context: ExecutionContext = { recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
        ingredientExecutor: async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'read' }) };
      return { ...call(page, time), tool_name: 'recued-core/act-on-web-page', args: { page: page.page, steps },
        result: projectRunResultForAgent(await executeRecipe(context)) };
    };
    const calls = [await read([{ transform: 'count' }], 1), await read([{ transform: 'pluck', field: 'text' }], 3)];
    const before = JSON.stringify(calls);
    const projected = projectBrowserReadContext(calls);
    expect(projected.stats).toMatchObject({ reads_elided: 1 });
    expect(projected.stats.chars_saved).toBeGreaterThan(1000);
    const first = (projected.calls[0]!.result as any).output.render[0].data;
    const last = (projected.calls[1]!.result as any).output.render[0].data;
    expect(first.tabs[0].reads[0]).toMatchObject({ step: 1, duplicate_read: { prior_tool_call: 2 } });
    expect(first.tabs[0].reads[1].data.value).toBe(3);
    expect(last.tabs[0].reads[1].data.value).toEqual(['First item', 'Middle item', 'Last item']);
    expect(last.tabs[0].reads[0].outline).toContain('Catalog');
    expect(JSON.stringify(projected.calls[0]!.result)).not.toContain('Details.'); // every mirrored read is projected
    expect(JSON.stringify(calls)).toBe(before);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(projectBrowserReadContext([calls[0]!]).stats.reads_elided).toBe(0);

    // A malformed/edited recipe, partial observation or possible browser side
    // effect is a barrier, even if its displayed read is byte-identical.
    const change = (mutate: (c: any) => void): ChatPriorToolCall => {
      const copy = structuredClone(calls[1]!); mutate(copy); return copy;
    };
    for (const barrier of [
      change(c => { c.tier = 3; }),
      change(c => { c.args.steps[0] = { do: 'hover', ref: 'e1' }; }),
      change(c => { c.result.steps.push({ id: 'hidden-write' }); }),
      change(c => { c.args.steps[0].from = 2; }),
      change(c => { c.result.output.render[0].data.tabs[0].reads[0].loading = true; }),
      change(c => { c.result.output.render[0].data.tabs[0].opened = true; }),
      change(c => { c.result.output.render[0].data.tabs[0].reads[0].data_ref = 'changed'; }),
    ]) expect(projectBrowserReadContext([calls[0]!, barrier, calls[1]!]).stats.reads_elided).toBe(0);
  });

  it('projects actual engine read results at prompt assembly, with the off path and stored audit unchanged', async () => {
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
      result: { command_id: 'c', status: 'ok', bridge_version: '0.0.9', duration_ms: 1, idempotency_key_seen: false,
        outputs: { page: page.page, url: page.url, title: page.title,
          html: '<main><h1>.name Grandfathered</h1>' + '<p>Article detail.</p>'.repeat(80) + '</main>', truncated: false } } }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const recipe: RecipeDefinition = { recipe_id: 'inspect-web-page', version: 4, ttl: 0,
      metadata: { name: 'Inspect', description: 'Read fixture', author: 'recued-core', supported_platforms: [] },
      variables: {}, prefetch_steps: [], steps: [{ id: 'inspect', ingredient: 'dom-inspect',
        input: { target: '*://*/*', page: page.page, form: 'outline' } }],
      output: { render: [{ type: 'json', source: 'step.inspect', label: 'Page' }] } };
    const read = async () => {
      const context: ExecutionContext = { recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
        ingredientExecutor: async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'read' }) };
      return projectRunResultForAgent(await executeRecipe(context));
    };
    const calls = [{ ...call(), result: await read() }, { ...call(page, 3), result: await read() }];
    const before = JSON.stringify(calls);
    const packet = { available_tools: [], content: { chat_tail: [], user_message: 'Give the exact headline' }, prior_tool_calls: calls };
    const off = composeChatMainTurnPromptParts({ ...packet, deduplicate_browser_reads: false });
    const on = composeChatMainTurnPromptParts({ ...packet, deduplicate_browser_reads: true });
    expect(on.browser_read_context?.reads_elided).toBe(1);
    expect(on.body.length).toBeLessThan(off.body.length);
    expect(on.cacheable_prefix).toBe(off.cacheable_prefix);
    expect(on.body.startsWith(on.cacheable_prefix)).toBe(true);
    const sent = JSON.parse(on.body).prior_tool_calls;
    expect(JSON.stringify(sent[0].result)).toContain('duplicate_read');
    expect(sent[1].result.output.render[0].data.field_evidence.items[0].fields.text.value).toBe('.name Grandfathered');
    expect(JSON.stringify(calls)).toBe(before);
    expect(dispatch).toHaveBeenCalledTimes(2); // projection never replaces an actual read
  });
});

// 2026-11-20 (the owner: "go ahead") — on task I (the cheapest of 11 books) the view after the click, cut at 3,000
// characters, showed 7 books first; the batch's own complete read of the page followed. The model answered the
// cheapest of the 7, though the preview said it was partial and historical.
describe('a partial preview the complete read shows line for line', () => {
  const HOME = 'bridge:A:7:HOME', TRAVEL = 'bridge:A:7:TRAVEL', url = 'https://books.example/travel';
  const books = Array.from({ length: 11 }, (_, i) => `- [link: Book ${i + 1}](e${i + 20}) £${(40 - i * 2).toFixed(2)}`);
  const full = ['[link: Books](e1)', '- Travel', ...books].join('\n');
  const cut = full.slice(0, full.indexOf('Book 8') + 4);
  const state = (complete: boolean) => ({ source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, loading: false,
    complete, truncated: !complete });
  const batch = (preview: string, previewComplete = false, read: string | null = full) => {
    const post = { after_step: 1, action_status: 'acknowledged', check_status: 'not_requested', application_outcome: 'unverified',
      before_page: HOME, current_page: TRAVEL, transition: 'new_document', view_status: 'fresh',
      view: { page: TRAVEL, url, title: 'Travel', outline: preview, read_state: state(previewComplete) } };
    return { ...call({}, 5), tool_name: 'recued-core/act-on-web-page',
      args: { page: HOME, steps: [{ do: 'click', ref: 'e5' }, { do: 'wait', seconds: 2 }, { do: 'read', form: 'outline' }] },
      result: { recipe_id: 'act-on-web-page', success: true, errors: [], browser_state: post, output: { render: [{ type: 'json', data: {
        post_action: post, page: TRAVEL, url, tabs: [{ page: TRAVEL, url,
          reads: read === null ? [] : [{ step: 3, outline: read, read_state: state(true) }] }] } }] } } } as ChatPriorToolCall;
  };
  const previews = (projected: readonly ChatPriorToolCall[]) => {
    const result = projected.at(-1)!.result as any;
    return [result.browser_state.view.outline, result.output.render[0].data.post_action.view.outline];
  };

  it('leaves a pointer to the complete read in its place, in both places it is shown', () => {
    const projected = projectBrowserObservationOrder([batch(cut)]);
    const result = projected[0]!.result as any;
    const fullRead = result.output.render[0].data.tabs[0].reads[0];
    expect(previews(projected)).toEqual([browserPartialPreviewNote(fullRead.read_state.context.observation_id),
      browserPartialPreviewNote(fullRead.read_state.context.observation_id)]);
    expect(fullRead.outline).toBe(full);
    expect(result.browser_state.view.read_state).toMatchObject({ complete: false, truncated: true });
    // A page read again numbers its elements afresh: the same lines under other refs are the same lines.
    const renumbered = cut.replace(/\(e(\d+)\)/g, (_m, n: string) => `(e${String(Number(n) + 100)})`);
    expect(previews(projectBrowserObservationOrder([batch(renumbered)]))[0]).toMatch(/^\(A partial preview of this page was here/);
  });

  it('keeps a preview that shows a line the complete read lacks, or that is itself complete', () => {
    const toast = `Saved!\n${cut}`;
    expect(previews(projectBrowserObservationOrder([batch(toast)]))).toEqual([toast, toast]);
    const whole = full.slice(0, full.indexOf('- [link: Book 9]') - 1);
    expect(previews(projectBrowserObservationOrder([batch(whole, true)]))).toEqual([whole, whole]);
  });

  it('keeps a preview no complete read in the same result supersedes', () => {
    expect(previews(projectBrowserObservationOrder([batch(cut, false, null)]))).toEqual([cut, cut]);
    const later = { ...call({ page: TRAVEL, url, title: 'Travel', outline: full, read_state: state(true) }, 9) } as ChatPriorToolCall;
    const projected = projectBrowserObservationOrder([batch(cut, false, null), later]);
    expect(previews([projected[0]!])).toEqual([cut, cut]);
  });
});


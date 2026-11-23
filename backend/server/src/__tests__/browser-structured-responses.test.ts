import { describe, expect, it, vi } from 'vitest';
import { createBridgeDomAdapter, heldBrowserTargetRefusal } from '../bridges/dom-adapter.js';
import { browserPageObservation, limitPageObservation, BROWSER_PAGE_OBSERVATION_CHARS } from '../bridges/browser-page-observation.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { executeRecipe } from '@recued/engine';
import type { ExecutionContext } from '@recued/engine';
import { readBrowserFailure, type RecipeDefinition } from '@recued/contracts';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { projectRunResultForAgent } from '../run-result-agent-projection.js';
import { completedBrowserReads } from '../bridges/browser-completed-reads.js';
import { linkTransition } from '../bridges/browser-link-handoff.js';

const recipeFor = (slug: string, input: Record<string, unknown>): RecipeDefinition => ({
  recipe_id: 'browser-failure-test', version: 1, ttl: 300,
  metadata: { name: 'Browser failure', description: 'Engine boundary fixture', author: 'test', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps: [{ id: 'act', ingredient: slug, input }],
  output: { render: [{ type: 'json', source: 'step.act' }] },
});
const contextFor = (recipe: RecipeDefinition, ingredientExecutor: ExecutionContext['ingredientExecutor']): ExecutionContext => ({
  recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} }, ingredientExecutor,
});

describe('structured browser corrections and observations', () => {
  it('offers observed card fields while loading, preserving incomplete source and pending-control limits', async () => {
    const html = '<main>' + ['A', 'B', 'C'].map((name, i) => `<article class="product"><h3><a href="/book/${i}" title="Book ${name}">Book ${name}</a></h3><p class="price">£${20 + i}.00</p></article>`).join('') + '</main>';
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'b', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.12', idempotency_key_seen: false, status: 'ok',
        outputs: { page: '7:DOC1', url: 'https://example.org/books', title: 'Books', html, loading: true, truncated: false } } }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: createPageReadStore() });
    const result = await adapter({ slug: 'dom-inspect', input: { target: '*://*/*', page: '7:DOC1', form: 'outline' }, output: {}, risk_tier: 'read' });
    expect(result).toMatchObject({ collection_hint: { rows_in_snapshot: 3 }, extraction_targets: { source_complete: false, collection: { rows_in_snapshot: 3 } }, read_state: { loading: true, complete: false } });
    expect(result).not.toHaveProperty('control_evidence');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('puts main-content recovery choices ahead of site navigation without another inspection', async () => {
    const store = createPageReadStore();
    const html = '<header><nav>' + Array.from({ length: 30 }, (_, i) => `<a ref="e${i + 1}">Navigation ${i}</a>`).join('')
      + '</nav></header><main><a ref="e50">Login</a><input ref="e51" aria-label="Search" value="private-field-value"></main>';
    store.outline('7:DOC1', { url: 'https://example.org/', title: 'Landing', html, whole: true, truncated: false });
    const dispatch = vi.fn();
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: store });
    const recipe = recipeFor('dom-write', { target: '*://*/*', page: '7:DOC1', text: 'Email', value: 'private-attempt' });
    const result = await executeRecipe(contextFor(recipe, async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const error = JSON.parse(JSON.stringify(projectRunResultForAgent(result))).errors[0];
    const lookup = error.details?.control_lookup;
    expect(lookup).toMatchObject({ complete: false, total: 32 });
    expect((lookup as { controls: Array<{ name: string }> }).controls.slice(0, 2).map(control => control.name)).toEqual(['Login', 'Search']);
    expect((lookup as { controls: unknown[] }).controls).toHaveLength(6);
    expect(JSON.stringify(error)).not.toMatch(/private-field-value|private-attempt/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])('loading-field refusal supplies fresh choices only in the same document (changed=%s)', async changed => {
    const store = createPageReadStore(), actions: string[] = [];
    const html = '<nav>' + Array.from({ length: 10 }, (_, i) => `<a ref="e${i + 1}">Navigation ${i}</a>`).join('')
      + '</nav><main><a ref="e50">Login</a></main>';
    let inspected = false;
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
      actions.push(request.action);
      const page = changed && inspected ? '7:DOC2' : '7:DOC1'; inspected = true;
      return { kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false, status: 'ok',
          outputs: { page, url: 'https://example.org/', title: 'Landing', html, loading: true, truncated: false } } };
    });
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: store });
    await adapter({ slug: 'dom-inspect', input: { target: '*://*/*', page: '7:DOC1', form: 'outline' }, output: {}, risk_tier: 'read' });
    const recipe = recipeFor('dom-act', { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'type', text: 'Email', value: 'private-attempt' }] });
    const result = await executeRecipe(contextFor(recipe, async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const error = JSON.parse(JSON.stringify(projectRunResultForAgent(result))).errors[0];
    expect(result.success).toBe(false);
    if (changed) expect(error.details?.control_lookup).toBeUndefined();
    else {
      expect(error.message).toContain('not uniquely observed');
      expect(error.details?.control_lookup).toMatchObject({ complete: false, controls: [{ name: 'Login' }, ...Array.from({ length: 5 }, () => ({}))] });
    }
    expect(actions).toContain('inspect');
    expect(actions.every(action => action === 'inspect' || action === 'reread')).toBe(true);
    expect(JSON.stringify(error)).not.toContain('private-attempt');
  });

  // 2026-11-21 (D-402, benchmark task I, live) — a collect asked over its bounds (50 pages and 1,000 items, in every run of
  // task I) is read at them, and the result the model reads says so, through the engine and the agent's projection.
  it('tells the model a collect asked over its bounds was read at them', async () => {
    const html = '<main>' + ['A', 'B'].map((name, i) => `<article class="product"><h3><a href="/book/${i}">Book ${name}</a></h3></article>`).join('') + '</main>';
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'b', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.14', idempotency_key_seen: false, status: 'ok',
        outputs: { page: '7:DOC1', url: 'https://example.org/books', title: 'Books', html, loading: false, truncated: false } } }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: createPageReadStore() });
    const recipe = recipeFor('dom-act', { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'collect', items: 'article.product',
      fields: { title: 'h3 a' }, next: { text: 'Next' }, max_pages: 50, max_items: 1000 }] });
    const result = await executeRecipe(contextFor(recipe, async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.stringify(projectRunResultForAgent(result));
    expect(JSON.parse(projected).success).toBe(true);
    expect(projected).toContain('this one asked for more, so it read up to those');
    expect(projected).toContain('"read_at_most":{"max_pages":20,"max_items":500}');
  });

  it('an invalid follow-up read returns a valid whole-page alternative before any browser action', async () => {
    const dispatch = vi.fn();
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: createPageReadStore() });
    const recipe = recipeFor('dom-act', { target: '*://*/*', page: '7:DOC1', steps: [
      { do: 'type', ref: 'e1', value: 'private-attempted-value' }, { do: 'submit', ref: 'e2', then_read_form: 'text' }] });
    const result = await executeRecipe(contextFor(recipe, async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
    expect(projected.success).toBe(false);
    expect(projected.errors[0]).toMatchObject({ code: 'DOM_SELECTOR_MISSING', details: { executed: false } });
    expect(projected.errors[0].message).toContain('add a separate {"do":"read","form":"text"} step');
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(projected.errors)).not.toContain('private-attempted-value');
  });

  it.each(['batch', 'standalone'] as const)('missing-field errors carry current controls through the engine: %s', async mode => {
    for (const scope of ['page', 'dialog', 'partial'] as const) {
      const store = createPageReadStore();
      const html = '<main><a ref="e24" href="/login">Login</a><input ref="e25" aria-label="Search" value="private-field-value">'
        + '<a ref="e99" data-recued-structural-only>Hidden link</a>'
        + (scope === 'dialog' ? '<div role="dialog" aria-modal="true"><button ref="e26">Continue</button></div>' : '') + '</main>';
      const commands: string[] = [];
      const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
        commands.push(request.action);
        return { kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
          result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false, status: 'ok',
            outputs: { page: '7:DOC1', url: 'https://example.org/', title: 'Landing', html, truncated: scope === 'partial' } } };
      });
      const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
        getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: store });
      const input = { target: '*://*/*', page: '7:DOC1' };
      await adapter({ slug: 'dom-inspect', input: { ...input, form: 'outline' }, output: {}, risk_tier: 'read' });
      const action = { do: 'type', text: 'Email', role: 'field', value: 'private-attempted-value' };
      const recipe = recipeFor(mode === 'batch' ? 'dom-act' : 'dom-write', mode === 'batch'
        ? { ...input, steps: [action] } : { ...input, text: action.text, role: action.role, value: action.value });
      const result = await executeRecipe(contextFor(recipe, async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
      const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
      expect(projected.success).toBe(false);
      const lookup = projected.errors[0].details.control_lookup;
      expect(lookup).toMatchObject({ source: 'page_read', page: '7:DOC1', url: 'https://example.org/', complete: scope !== 'partial' });
      expect(lookup.controls).toEqual(scope === 'dialog' ? [{ ref: 'e26', kind: 'button', name: 'Continue' }] : [
        { ref: 'e24', kind: 'link', name: 'Login' }, { ref: 'e25', kind: 'text field', name: 'Search' }]);
      expect(commands).toEqual(['inspect']);
      expect(JSON.stringify(projected.errors)).not.toMatch(/private-field-value|private-attempted-value|Hidden link/);
    }
  });

  it('bounds control suggestions and does not claim an exhaustive list', async () => {
    const store = createPageReadStore();
    store.outline('7:DOC1', { url: 'https://example.org/', title: 'Page', whole: true, truncated: false,
      html: Array.from({ length: 20 }, (_, i) => `<a ref="e${i + 1}" href="/p${i}">Page ${i}</a>`).join('') });
    const dispatch = vi.fn();
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: store });
    const error = await adapter({ slug: 'dom-write', input: { target: '*://*/*', page: '7:DOC1', text: 'Email', value: 'secret' },
      output: {}, risk_tier: 'write' }).then(() => undefined, error => error);
    const lookup = readBrowserFailure(error)?.details.control_lookup;
    expect(lookup).toMatchObject({ complete: false, total: 20 });
    expect(lookup!.controls).toHaveLength(6);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects malformed control evidence at the explicit error-carrier boundary', () => {
    const control = { ref: 'e24', kind: 'link', name: 'Login' };
    const lookup = { source: 'page_read', scope: 'interaction', page: '7:DOC1', complete: true, total: 1, controls: [control] };
    const error = (control_lookup: unknown) => ({ code: 'DOM_SELECTOR_NOT_FOUND', browser_failure: {
      slug: 'dom-write', details: { control_lookup } } });
    expect(readBrowserFailure(error(lookup))?.details.control_lookup).toEqual(lookup);
    for (const invalid of [
      { ...lookup, controls: [{ ...control, value: 'private' }] },
      { ...lookup, controls: Array.from({ length: 7 }, () => control) },
      { ...lookup, total: 2 },
    ]) expect(readBrowserFailure(error(invalid))).toBeUndefined();
  });

  it('retains a loading-field rescout request across the batch stop and returns the refreshed page', async () => {
    const commands: string[] = [];
    const html = '<main><a ref="e24" href="/login">Login</a></main>';
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
      commands.push(request.action);
      return { kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false,
          status: 'ok', outputs: { page: '7:DOC1', url: 'https://example.org/app/', title: 'Landing', html,
            loading: request.action !== 'reread', truncated: false } } };
    });
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: createPageReadStore() });
    const input = { target: '*://*/*', page: '7:DOC1' };
    await adapter({ slug: 'dom-inspect', input: { ...input, form: 'outline' }, output: {}, risk_tier: 'read' });
    const result = await executeRecipe(contextFor(recipeFor('dom-act', { ...input,
      steps: [{ do: 'type', text: 'Email', value: 'private-attempted-value' }, { do: 'click', ref: 'e24' }] }),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
    expect(projected.success).toBe(false);
    expect(projected.errors[0].details.page_observation).toMatchObject({ page: '7:DOC1', loading: false,
      field_evidence: { items: [{ tag: 'a', ref: 'e24', fields: { text: { value: 'Login' } } }] } });
    expect(commands).toEqual(['inspect', 'inspect', 'reread']);
    expect(JSON.stringify(projected.errors)).not.toContain('private-attempted-value');
  });

  it.each(['batch', 'standalone'] as const)('a fresh non-editable ref returns corrective facts before typing: %s', async mode => {
    const commands: string[] = [];
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
      commands.push(request.action);
      return { kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false,
          status: 'ok', outputs: { page: '7:DOC1', url: 'https://example.org/app/', title: 'Landing',
            html: '<main><a ref="e24" href="/login">Login</a></main>', loading: false, truncated: false } } };
    });
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: createPageReadStore() });
    const input = { target: '*://*/*', page: '7:DOC1' };
    await adapter({ slug: 'dom-inspect', input: { ...input, form: 'outline' }, output: {}, risk_tier: 'read' });
    const recipe = mode === 'batch' ? recipeFor('dom-act', { ...input, steps: [
      { do: 'type', ref: 'e24', value: 'private-attempted-value' }, { do: 'click', ref: 'e24' }] })
      : recipeFor('dom-write', { ...input, ref: 'e24', value: 'private-attempted-value' });
    const result = await executeRecipe(contextFor(recipe, async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
    expect(projected.success).toBe(false);
    expect(projected.errors[0]).toMatchObject({ code: 'DOM_WRITE_FAILED', details: {
      control_correction: { ref: 'e24', kind: 'link', name: 'Login', requested_action: 'type',
        supported_actions: ['click'], source: 'fresh_kept_read' }, page_observation: { page: '7:DOC1', loading: false } } });
    expect(commands).toEqual(['inspect', 'reread']);
    expect(JSON.stringify(projected.errors)).not.toContain('private-attempted-value');
  });

  it.each(['stale', 'changed', 'truncated', 'region', 'loading'] as const)(
    'does not reject a now-editable control using an ineligible old snapshot: %s', async mode => {
      let now = 0;
      const store = createPageReadStore({ now: () => now });
      store.outline('7:DOC1', { url: 'https://example.org/', title: 'Page', html: '<a ref="e24">Login</a>',
        whole: mode !== 'region', truncated: mode === 'truncated' });
      if (mode === 'stale') now = 16000;
      if (mode === 'changed') store.markChanged('7:DOC1');
      if (mode === 'loading') store.markLoading('7:DOC1', true);
      const commands: string[] = [];
      const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
        commands.push(request.action);
        return { kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
          result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false, status: 'ok',
            outputs: request.action === 'fill' ? { filled: true } : { page: '7:DOC1', url: 'https://example.org/', title: 'Page',
              html: '<input ref="e24" aria-label="Email">', loading: false, truncated: false } } };
      });
      const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
        getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: store });
      const result = await executeRecipe(contextFor(recipeFor('dom-act', { target: '*://*/*', page: '7:DOC1',
        steps: [{ do: 'type', ref: 'e24', value: 'fixture' }] }),
        async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
      expect(result.success).toBe(true);
      expect(commands.filter(action => action === 'fill')).toHaveLength(1);
      expect(commands.some(action => ['click', 'navigate', 'reload_page', 'submit'].includes(action))).toBe(false);
    });

  it('does not reject a control that an earlier write in the same batch could have replaced', async () => {
    const store = createPageReadStore();
    store.outline('7:DOC1', { url: 'https://example.org/', title: 'Page',
      html: '<input ref="e1" aria-label="Mode"><a ref="e24">Login</a>', whole: true, truncated: false });
    const commands: string[] = [];
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
      commands.push(request.action);
      return { kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false,
          status: 'ok', outputs: { filled: true } } };
    });
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: store });
    const result = await executeRecipe(contextFor(recipeFor('dom-act', { target: '*://*/*', page: '7:DOC1',
      steps: [{ do: 'type', ref: 'e1', value: 'edit' }, { do: 'type', ref: 'e24', value: 'fixture' }] }),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    expect(result.success).toBe(true);
    expect(commands).toEqual(['fill', 'fill', 'reread']);
  });

  it('carries control evidence through reads, cached parts and failed-recipe projection without another inspect', async () => {
    const html = '<main><label>Category<select ref="e1"><option selected>Home</option><option>Work</option></select></label>'
      + '<input type="checkbox" ref="e2" aria-label="Completed"></main>';
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({
      kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false,
        ...(request.action === 'click' ? { status: 'error', error: { code: 'selector_not_found', message: 'The page changed since it was inspected: inspect it again.' } }
          : { status: 'ok', outputs: { page: '7:DOC1', url: 'https://example.org/', title: 'Notes', html, truncated: false } }) },
    }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: createPageReadStore() });
    const input = { target: '*://*/*', page: '7:DOC1' };
    const read = await adapter({ slug: 'dom-inspect', input: { ...input, form: 'outline' }, output: {}, risk_tier: 'read' });
    expect(read).toMatchObject({ control_evidence: { items: [{ ref: 'e1', action: { do: 'type' } }, { ref: 'e2', checked: false }] } });
    const cached = await adapter({ slug: 'dom-inspect', input: { ...input, form: 'outline', from: 1 }, output: {}, risk_tier: 'read' });
    expect(cached).toMatchObject({ control_evidence: { items: [{ ref: 'e1' }, { ref: 'e2' }] } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const result = await executeRecipe(contextFor(recipeFor('dom-click', { ...input, ref: 'e1' }),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
    expect(projected.errors[0].details.page_observation.control_evidence).toMatchObject({ complete: true,
      items: [{ options: [{ selected: true }, { label: 'Work' }] }, { checked: false }] });
    expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect', 'click', 'reread']);
  });

  // 2026-11-20 — a control no navigation guard covers (a form's button, a link to the same address, a `#` on it
  // such as a table's page numbers) used to be refused while the page kept loading; it now goes on as a lookup
  // on a loading page does (`d-335-browser-act.test.ts`): clicked once two reads agree on it, with no guard.
  it.each(['stable', 'state-changed', 'destination-changed', 'url-changed', 'document-changed', 'form', 'same-url', 'hash-only',
    'uncertain', 'no-navigation'] as const)(
    'a pending navigation link is only continued after an unchanged read, and anything else as a loading page allows: %s', async mode => {
      const url = 'https://example.org/page/2/', after = 'https://example.org/page/3/';
      const original = `<main><h1>.name Grandfathered</h1>${mode === 'form' ? '<form><button ref="e2">Next</button></form>'
        : `<a ref="e2" href="${mode === 'same-url' ? url : mode === 'hash-only' ? `${url}#` : after}">Next</a>`}</main>`;
      const unguarded = mode === 'form' || mode === 'same-url' || mode === 'hash-only';
      let inspections = 0, clicks = 0;
      const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
        const click = request.action === 'click'; if (click) clicks++;
        if (request.action === 'inspect') inspections++;
        const refreshed = inspections > 1;
        const html = refreshed && mode === 'state-changed' ? original.replace('.name Grandfathered', 'Different cursor state')
          : refreshed && mode === 'destination-changed' ? original.replace(after, 'https://example.org/other/') : original;
        return { kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
          result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.9', idempotency_key_seen: false,
            ...(click && mode === 'uncertain' ? { status: 'error' as const, error: { code: 'delivery_uncertain' as const, message: 'Reply lost' } }
              : { status: 'ok' as const, outputs: click ? { clicked: true, page: mode === 'no-navigation' ? '7:DOC2' : '7:DOC3',
                url: mode === 'no-navigation' ? url : after, title: 'Page', moved: mode !== 'no-navigation' }
                : { page: refreshed && mode === 'document-changed' ? '7:OTHER' : '7:DOC2',
                  url: refreshed && mode === 'url-changed' ? 'https://example.org/other/' : url, title: 'Page', html, truncated: false, loading: true } }) } };
      });
      const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
        getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
      const input = { target: '*://*/*', page: '7:DOC2', steps: [{ do: 'read' }, { do: 'click', text: 'Next' }] };
      const result = await executeRecipe(contextFor(recipeFor('dom-act', input),
        async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
      const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
      expect(projected.success).toBe(mode === 'stable' || unguarded);
      expect(clicks).toBe(['stable', 'uncertain', 'no-navigation'].includes(mode) || unguarded ? 1 : 0);
      if (clicks) expect(dispatch.mock.calls.find(([request]) => request.action === 'click')![0].args.navigation_guard)
        .toEqual(unguarded ? undefined : { before_url: url, after_url: after });
      if (mode !== 'stable' && !unguarded) {
        expect(projected.errors[0].details.completed_reads[0]).toMatchObject({ step: 1, form: 'outline',
          observation: { page: '7:DOC2', url, loading: true }, content: expect.stringContaining('.name Grandfathered') });
        if (['uncertain', 'no-navigation'].includes(mode)) expect(projected.errors[0].details.batch_progress.page_state).toBe('unknown');
      }
      expect(dispatch.mock.calls.some(([request]) => ['reload_page', 'navigate', 'go_back', 'submit'].includes(request.action))).toBe(false);
    });

  it('a link is a navigation only to another address of its site: never a bare `#`, which parses with no hash', () => {
    const link = (href: string) => ({ ref: 'e2', kind: 'link', names: ['2'], href }) as Parameters<typeof linkTransition>[0];
    const page = 'https://example.org/table';
    expect(linkTransition(link('https://example.org/other'), page)).toEqual({ before_url: page, after_url: 'https://example.org/other' });
    for (const href of [`${page}#`, `${page}#top`, page, 'https://elsewhere.example/other']) expect(linkTransition(link(href), page)).toBeUndefined();
    expect(linkTransition(link('https://example.org/other'), `${page}#`)).toBeUndefined();
  });

  // 2026-11-20 — a trial asks before each change, describing its element first. A link found on a page still
  // loading carries its click's `navigation_guard`, which routing refuses on any command but a click: the
  // describe names the element alone (benchmark task M's page loop, tried while its page was still loading).
  it('a trial describes a link found on a loading page by its ref alone, and the click keeps its guard', async () => {
    const url = 'https://example.org/page/2/', after = 'https://example.org/page/3/';
    const html = `<main><h1>Results</h1><a ref="e2" href="${after}">Next</a></main>`;
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({
      kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.13', idempotency_key_seen: false, status: 'ok' as const,
        outputs: request.action === 'click' ? { clicked: true, page: '7:DOC3', url: after, title: 'Page', moved: true }
          : request.action === 'describe' ? { page: '7:DOC2', url, title: 'Page', role: 'link', label: 'Next' }
            : { page: '7:DOC2', url, title: 'Page', html, truncated: false, loading: true } } }));
    const asked: string[] = [];
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }),
      trials: { isTrial: run => run === 'trial-1', ask: async request => { asked.push(request.prompt.action); return { done: true }; } } });
    const input = { target: '*://*/*', page: '7:DOC2', steps: [{ do: 'read' }, { do: 'click', text: 'Next' }] };
    const result = await executeRecipe(contextFor(recipeFor('dom-act', input), async (slug, input) => adapter({ slug, input, output: {},
      risk_tier: 'write', stepMeta: { run_id: 'trial-1', recipe_id: 'browser-failure-test', step_id: 'act' } })));
    expect(JSON.parse(JSON.stringify(projectRunResultForAgent(result))).success).toBe(true);
    expect(asked).toEqual(['click']);
    const sent = (action: string) => dispatch.mock.calls.find(([request]) => request.action === action)![0].args;
    expect(sent('describe')).toMatchObject({ page: '7:DOC2', ref: 'e2' });
    expect(sent('describe')).not.toHaveProperty('navigation_guard');
    expect(sent('click').navigation_guard).toEqual({ before_url: url, after_url: after });
  });

  it.each(['stable', 'unrelated-change', 'sibling-value', 'old-bridge-unrelated-change', 'field-value', 'form-changed',
    'modal-open', 'replaced', 'renamed', 'ambiguous', 'hidden', 'url-changed', 'document-changed', 'truncated'] as const)(
    'typing by name requires a stable fresh field while the page is loading: %s', async mode => {
      const url = 'https://example.org/login';
      const marker = mode === 'old-bridge-unrelated-change' ? '' : ' data-recued-field-context="observed-form-owner"';
      const original = `<main><label for="email">Email address</label><input ref="e2" id="email" name="email"${marker}>`
        + '<input ref="e4" name="sibling" value="before"><p>External status before</p></main>';
      let inspections = 0;
      const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
        if (request.action === 'inspect') inspections++;
        const refreshed = inspections > 1;
        const html = !refreshed ? original : mode === 'replaced' ? original.replace('e2', 'e3')
          : mode === 'renamed' ? original.replace('name="email"', 'name="other"')
            : mode === 'ambiguous' ? original.replace('</main>', '<input ref="e3" name="email" aria-label="Email address"></main>')
              : mode === 'hidden' ? '<main>Loading</main>'
                : mode === 'unrelated-change' || mode === 'old-bridge-unrelated-change' ? original.replace('External status before', 'External status after')
                  : mode === 'sibling-value' ? original.replace('value="before"', 'value="after"')
                    : mode === 'field-value' ? original.replace('id="email"', 'id="email" value="changed"')
                      : mode === 'form-changed' ? original.replace('observed-form-owner', 'different-form-owner')
                        : mode === 'modal-open' ? original + '<dialog modal><button ref="e5">Close</button></dialog>' : original;
        return { kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
          result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.9', idempotency_key_seen: false, status: 'ok',
            outputs: request.action === 'fill' ? { filled: true, page: '7:DOC1', url, title: 'Login' }
              : { page: refreshed && mode === 'document-changed' ? '7:OTHER' : '7:DOC1',
                url: refreshed && mode === 'url-changed' ? 'https://example.org/other' : url,
                title: 'Login', html, truncated: refreshed && mode === 'truncated', loading: true } } };
      });
      const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(), manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
        getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
      const input = { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'read' }, { do: 'type', text: 'Email', value: 'fixture' }] };
      const result = await executeRecipe(contextFor(recipeFor('dom-act', input),
        async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
      const allowed = ['stable', 'unrelated-change', 'sibling-value'].includes(mode);
      expect(result.success).toBe(allowed);
      const fills = dispatch.mock.calls.filter(([request]) => request.action === 'fill');
      expect(fills).toHaveLength(allowed ? 1 : 0);
      if (fills.length) expect(fills[0]![0].args).toMatchObject({ page: '7:DOC1', ref: 'e2', value: 'fixture' });
      expect(dispatch.mock.calls.some(([request]) => ['reload_page', 'navigate', 'submit', 'click'].includes(request.action))).toBe(false);
    });

  it.each(['legacy', 'valid', 'mismatched'] as const)('a blocked click carries only matching observed evidence and never replays: %s', async mode => {
    let reads = 0, clicks = 0;
    const obstruction = { operation: 'click', executed: false, reason: 'target_occluded', source: 'hit_test',
      target: { tag: 'button', ref: mode === 'mismatched' ? 'e99' : 'e2' },
      blocker: { tag: 'iframe', label: 'Advertisement' }, waited_ms: 8000 } as const;
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
      if (request.action === 'click') {
        clicks++;
        return { kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
          result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false, status: 'error',
            error: { code: 'value_not_applied', message: 'Something else on the page covers it (Advertisement), so it was not clicked.',
              ...(mode !== 'legacy' ? { obstruction } : {}) } } };
      }
      reads++;
      return { kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false, status: 'ok', outputs: {
          page: '7:DOC1', url: 'https://example.org/editor', title: 'Editor', loading: false, truncated: false,
          html: '<main><button ref="e2">Edit</button></main><dialog modal aria-label="Notice"><button ref="e3">Close notice</button></dialog>' } } };
    });
    const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(), manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const result = await executeRecipe(contextFor(recipeFor('dom-act', { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'click', ref: 'e2' }] }),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
    expect(projected.success).toBe(false);
    expect(projected.errors[0].details.post_action).toMatchObject({ view_status: 'fresh', view: { page: '7:DOC1' } });
    if (mode === 'valid') expect(projected.errors[0].details.click_obstruction).toEqual(obstruction);
    else expect(projected.errors[0].details).not.toHaveProperty('click_obstruction');
    expect(projected.errors[0].details).not.toHaveProperty('executed');
    expect(projected.errors[0].details.post_action.view.outline).toContain('Close notice');
    expect(reads).toBeGreaterThan(0);
    expect(clicks).toBe(1);
  });

  it.each(['<textarea ref="e2" aria-label="Description"></textarea>',
    '<select ref="e2" aria-label="Description"><option>Home</option><option>Work</option></select>',
    '<div ref="e2" contenteditable="true" aria-label="Description">Draft</div>'])(
    'resolves a stable editable control beyond a single-line input: %s', async field => {
      const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({ kind: 'completed',
        bridge_client_token_id: 'fixture', attempts: 1, result: { command_id: 'c', duration_ms: 1,
          bridge_version: '0.0.9', idempotency_key_seen: false, status: 'ok', outputs: { page: '7:DOC1',
            url: 'https://example.org/editor', title: 'Editor', html: `<main>${field}</main>`, truncated: false,
            loading: true, ...(request.action === 'fill' ? { filled: true } : {}) } } }));
      const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(), manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
        getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
      const input = { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'type', text: 'Description', value: 'Work' }] };
      const result = await executeRecipe(contextFor(recipeFor('dom-act', input),
        async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
      expect(result.success).toBe(true);
      expect(dispatch.mock.calls.filter(([request]) => request.action === 'fill')).toHaveLength(1);
    });

  it('establishes two fresh loading snapshots before a named field lookup with no prior read', async () => {
    const html = '<main><input ref="e2" aria-label="Email" name="email"></main>';
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({ kind: 'completed',
      bridge_client_token_id: 'fixture', attempts: 1, result: { command_id: 'c', duration_ms: 1,
        bridge_version: '0.0.9', idempotency_key_seen: false, status: 'ok', outputs: { page: '7:DOC1',
          url: 'https://example.org/login', title: 'Login', html, truncated: false, loading: true,
          ...(request.action === 'fill' ? { filled: true } : {}) } } }));
    const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(), manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const input = { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'type', text: 'Email', value: 'fixture' }] };
    const result = await executeRecipe(contextFor(recipeFor('dom-act', input),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    expect(result.success).toBe(true);
    expect(dispatch.mock.calls.slice(0, 3).map(([request]) => request.action)).toEqual(['inspect', 'inspect', 'fill']);
  });

  it('bounds retained read data and ignores non-read fields without mutating the stored observations', () => {
    const reads = Array.from({ length: 19 }, (_, i) => ({ step: i + 1, page: `7:DOC${i + 1}`, url: 'https://example.org/',
      title: 'Article', data: { outline: 'Observed text '.repeat(500), input_value: 'SECRET_NOT_READ', truncated: false } }));
    const before = JSON.stringify(reads);
    const receipt = completedBrowserReads(reads, 20);
    expect(JSON.stringify(receipt.completed_reads).length).toBeLessThanOrEqual(5_000);
    expect(receipt.completed_reads_truncated).toBe(true);
    expect(receipt.completed_reads!.at(-1)!.step).toBe(19);
    expect(JSON.stringify(receipt)).not.toContain('SECRET_NOT_READ');
    expect(JSON.stringify(reads)).toBe(before);
  });

  it('uses a fused then_read snapshot without issuing a second region inspection', async () => {
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.9', idempotency_key_seen: false, status: 'ok',
        outputs: request.action === 'wait_for_element' ? { page: '7:DOC1', url: 'https://example.org/', title: 'Result', found: true,
          html: '<section><h1>.name Grandfathered</h1><input type="password"></section>', truncated: false }
          : request.action === 'fill' ? { filled: true, page: '7:DOC1', url: 'https://example.org/', title: 'Result' }
            : { page: '7:DOC1', url: 'https://example.org/', title: 'Result', html: '<h1>Result</h1>', truncated: false } } }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const input = { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'type', selector: '#q', value: 'example', then_read: '#result' }] };
    const result = await executeRecipe(contextFor(recipeFor('dom-act', input),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.output)).toContain('.name Grandfathered');
    expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['fill', 'wait_for_element', 'reread']);
    expect(dispatch.mock.calls[1]![0].args.capture_read).toMatchObject({ expected_url: 'https://example.org/' });
  });

  it('reports a later tab already opened by a parallel read group when its first read fails', async () => {
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({
      kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.9', idempotency_key_seen: false,
        ...(request.action === 'inspect' && request.args.page === '7:DOC1'
          ? { status: 'error' as const, error: { code: 'unknown' as const, message: 'First read failed' } }
          : { status: 'ok' as const, outputs: request.action === 'list_tabs' ? { tabs: [], truncated: false }
            : { page: '8:DOC2', url: 'https://example.org/other', title: 'Other', html: '<h1>Other</h1>', truncated: false } }) } }));
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const input = { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'read' }, { do: 'read', url: 'https://example.org/other' }] };
    const result = await executeRecipe(contextFor(recipeFor('dom-act', input),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
    expect(projected.errors[0].details.batch_progress).toMatchObject({ total_steps: 2, failed_step: 1,
      completed_steps: [], effects: [{ step: 2, attempted: 1, acknowledged: 1 }] });
    expect(projected.errors[0].message).toContain('No step was confirmed complete.');
    expect(dispatch.mock.calls.filter(([request]) => request.action === 'open_tab')).toHaveLength(1);
  });

  it.each(['check', 'uncertain', 'rescout'] as const)('carries partial batch progress through the engine: %s', async failure => {
    const actions: string[] = [];
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => {
      actions.push(request.action);
      const click = request.action === 'click';
      return { kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.9', idempotency_key_seen: false,
          ...(click && failure !== 'check' ? { status: 'error' as const, error: failure === 'uncertain'
            ? { code: 'delivery_uncertain' as const, message: 'Response was lost. Inspect before retrying.' }
            : { code: 'selector_not_found' as const, message: 'The page changed since it was inspected: inspect it again.' } }
            : { status: 'ok' as const, outputs: click ? { clicked: true, page: '7:DOC1', url: 'https://example.org/', title: 'Directory' }
              : request.action === 'fill' ? { filled: true, page: '7:DOC1' }
                : { page: '7:DOC1', url: 'https://example.org/', title: 'Directory',
                  html: '<main><h1>.name Grandfathered</h1><input ref="e1"><button ref="e2">Next</button></main>', truncated: false } }) } };
    });
    const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: createPageReadStore() });
    const input = { target: '*://*/*', page: '7:DOC1', steps: [
      { do: 'type', selector: '#q', value: 'PRIVATE_TYPED_VALUE' },
      { do: 'click', selector: '#next', success_when: { page_changes: true } },
      { do: 'type', selector: '#after', value: 'MUST_NOT_RUN' },
    ] };
    const result = await executeRecipe(contextFor(recipeFor('dom-act', input),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
    expect(projected.success).toBe(false);
    const detail = projected.errors[0].details;
    expect(detail.batch_progress).toEqual({ total_steps: 3, failed_step: 2, completed_steps: [1],
      effects: [{ step: 1, attempted: 1, acknowledged: 1 }, { step: 2, attempted: 1, acknowledged: failure === 'check' ? 1 : 0 }],
      page_state: 'unknown', ...(failure === 'uncertain' ? {} : { current_page: '7:DOC1' }) });
    if (failure === 'rescout') expect(detail.post_action).toMatchObject({ action_status: 'refused', view_status: 'fresh', view: { page: '7:DOC1' } });
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_TYPED_VALUE');
    expect(actions.filter(action => action === 'fill')).toHaveLength(1);
    expect(actions.filter(action => action === 'click')).toHaveLength(1);
    expect(projected.steps[0].error.details).toEqual(detail);
  });

  it('returns both bad collection bounds before approval or dispatch, including when a write precedes them', async () => {
    const input = { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'click', text: 'Travel' },
      { do: 'collect', items: '.book', fields: { title: 'a' }, next: { text: 'Next' }, max_pages: 0, max_items: 0 }] };
    const dispatch = vi.fn(async () => { throw new Error('No command may run for malformed steps'); });
    const adapter = createBridgeDomAdapter({
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }),
    });
    const correction = { executed: false, violations: [
      { path: 'steps[1].max_pages', min: 1, max: 20, received: 0 },
      { path: 'steps[1].max_items', min: 1, max: 500, received: 0 },
    ] };
    expect(heldBrowserTargetRefusal('dom-act', undefined, input)).toMatchObject({
      code: 'DOM_SELECTOR_MISSING', details: { ...correction, refused_before_asking: true },
    });
    await expect(adapter({ slug: 'dom-act', risk_tier: 'write', output: {}, input,
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'invalid' } })).rejects.toMatchObject({
      code: 'DOM_SELECTOR_MISSING', message: 'core.dom.act: step 2: max_pages must be an integer from 1 to 20', details: correction,
    });
    // The original test ended at the adapter. Exercise the actual engine and
    // agent projection: this is where both violations used to be discarded.
    for (const held of [false, true]) {
      const result = await executeRecipe(contextFor(recipeFor('dom-act', input), async (slug, input) => {
        if (held) throw heldBrowserTargetRefusal(slug, undefined, input);
        return adapter({ slug, input, output: {}, risk_tier: 'write' });
      }));
      const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
      expect(projected.success).toBe(false);
      expect(projected.errors[0]).toMatchObject({ code: 'DOM_SELECTOR_MISSING', details: correction,
        source: { ingredient_slug: 'dom-act' } });
      expect(projected.steps[0].error.details).toEqual(projected.errors[0].details);
      expect(projected.errors[0].details.slug).toBeUndefined();
      expect(projected.errors[0].details.refused_before_asking).toBeUndefined();
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a fresh rescout through the failed recipe and model projection, with no extra read', async () => {
    let html = '<main><h1>Directory</h1><a ref="e5">Before</a></main>';
    const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({
      kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.8', idempotency_key_seen: false,
        ...(request.action === 'click' ? { status: 'error', error: { code: 'selector_not_found',
          message: 'The page changed since it was inspected: inspect it again.' } }
          : { status: 'ok', outputs: { page: '7:DOC1', url: 'https://example.org/', title: 'Directory', html, truncated: false } }) },
    }));
    const adapter = createBridgeDomAdapter({
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }), pageReads: createPageReadStore(),
    });
    const input = { target: '*://*/*', page: '7:DOC1', ref: 'e5' };
    await adapter({ slug: 'dom-inspect', input: { ...input, form: 'outline', ref: '' }, output: {}, risk_tier: 'read' });
    html = html.replace('Before', '.name Grandfathered');
    const result = await executeRecipe(contextFor(recipeFor('dom-click', input),
      async (slug, input) => adapter({ slug, input, output: {}, risk_tier: 'write' })));
    const projected = JSON.parse(JSON.stringify(projectRunResultForAgent(result)));
    expect(projected.success).toBe(false);
    expect(projected.errors[0].details).toMatchObject({
      page_observation: { state: 'changed', page: '7:DOC1', comparison: 'outline', loading: false,
        changes: { added_total: 1, removed_total: 1, complete: true } } });
    expect(JSON.stringify(projected.errors[0].details.page_observation.field_evidence)).toContain('.name Grandfathered');
    expect(dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect', 'click', 'reread']);
  });

  it('bounds large deltas and field views while preserving literal sources and explicit continuation', () => {
    const observation = browserPageObservation({ page: '7:DOC1', url: 'https://example.org/', title: 'Example',
      state: 'changed', loading: false, source_truncated: false,
      html: '<main><h1>.name Grandfathered</h1><input value="SECRET_VALUE">'
        + Array.from({ length: 20 }, (_, i) => `<a ref="e${i + 1}">${'Long text '.repeat(70)}</a>`).join('') + '</main>',
      changes: { url: 'https://example.org/', title: 'Example',
        added: Array.from({ length: 100 }, (_, i) => ({ number: i + 1, shown: `Added ${i} ${'x'.repeat(300)}` })),
        gone: Array.from({ length: 100 }, (_, i) => `Removed ${i} ${'y'.repeat(300)}`) },
    });
    expect(JSON.stringify(observation).length).toBeLessThanOrEqual(BROWSER_PAGE_OBSERVATION_CHARS);
    expect(observation.changes).toMatchObject({ added_total: 100, removed_total: 100, complete: false,
      next_line: expect.any(Number) });
    expect(observation.field_evidence!.items[0]!.fields.text).toEqual({ value: '.name Grandfathered', source: 'textContent' });
    expect(observation.field_evidence!.complete).toBe(false);
    expect(JSON.stringify(observation)).not.toContain('SECRET_VALUE');
    const original = JSON.stringify(observation);
    const small = limitPageObservation(observation, 256);
    expect(small).toBeDefined();
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(256);
    expect(small).toMatchObject({ truncated: true });
    expect(limitPageObservation(observation, 0)).toBeUndefined();
    expect(JSON.stringify(observation)).toBe(original);
  });

  it('omits overlong actionable identifiers instead of inventing shortened page handles or addresses', () => {
    const observation = browserPageObservation({ page: 'p'.repeat(200), url: `https://example.org/${'x'.repeat(3000)}`,
      title: 't'.repeat(300), html: '<h1>Known text</h1>', state: 'snapshot', loading: false, source_truncated: false });
    expect(observation.page).toBeUndefined();
    expect(observation.url).toBeUndefined();
    expect(observation).toMatchObject({ truncated: true, omitted: ['page', 'url', 'title_suffix'] });
    expect(observation.title).toHaveLength(200);
  });
});

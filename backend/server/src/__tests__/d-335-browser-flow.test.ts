/** D-335 slice W — the browser steps of the owner's chat: what the Bridge says each action was on
 *  (`acted_on`), taken out of what the model reads and recorded under the run's chat turn (W2), and
 *  the flows the owner keeps, sealed (W3). The offer that keeps them is pinned by
 *  `d-219-execution-case-offer-lifecycle.test.ts`; the Bridge working the selector out in a page, by
 *  `browser-toolkit-browser.test.ts`. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import { parseRecipe } from '@recued/recipes';

import { createBrowserFlowRecorder, BROWSER_FLOW_HOLD_MS, BROWSER_FLOW_MAX_STEPS } from '../bridges/browser-flow-record.js';
import { BROWSER_FLOW_SELECTOR_TO_FILL, recipeFromBrowserFlow } from '../browser-flow-recipe.js';
import { handleExecutionBrowserFlowForget, handleExecutionBrowserFlowRecipe, handleExecutionCaseLearned,
  type ChatRpcDeps } from '../chat-handler.js';
import { validateRecipeInline } from '../recipe-save-handler.js';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';
import { createExecutionCaseBrowserFlowStore } from '../storage/execution-case-browser-flow-store.js';

const PAGE = '7:DOC1';
const acted = (role: string, label: string, selector?: string, isProtected = false) => ({ url: 'https://github.com/new',
  title: 'New repository', role, label, protected: isProtected, ...(selector !== undefined ? { selector } : {}) });
const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
    outputs } as BridgeResult });

describe('D-335 slice W2 — the recorder', () => {
  const step = { do: 'click' as const, url: 'https://github.com/new', title: 'New repository',
    element: { role: 'button', label: 'Create repository', selector: '#create' } };

  it('files a run\'s steps under the chat turn it was bound to; a run bound to none records nothing', () => {
    const flows = createBrowserFlowRecorder({ now: () => 10 });
    flows.bindRun('run-1', { session_id: 's1', turn_id: 't1' });
    flows.record('run-1', step);
    flows.record('run-unbound', step);
    expect(flows.stepsFor('s1', (turn) => turn === 't1')).toEqual([{ ...step, at: 10 }]);
    expect(flows.stepsFor('s1', (turn) => turn === 't2')).toEqual([]);
    flows.forget('s1', (turn) => turn === 't1');
    expect(flows.stepsFor('s1', () => true)).toEqual([]);
  });

  it('holds steps nobody kept for an hour, and the latest ones of a long session', () => {
    let now = 0;
    const flows = createBrowserFlowRecorder({ now: () => now });
    flows.bindRun('run-1', { session_id: 's1', turn_id: 't1' });
    for (let i = 0; i < BROWSER_FLOW_MAX_STEPS + 5; i += 1) flows.record('run-1', { ...step, element: { ...step.element, label: `n${i}` } });
    const held = flows.stepsFor('s1', () => true);
    expect(held).toHaveLength(BROWSER_FLOW_MAX_STEPS);
    expect(held[0]!.element.label).toBe('n5');
    now = BROWSER_FLOW_HOLD_MS + 1;
    expect(flows.stepsFor('s1', () => true)).toEqual([]);
  });
});

describe('D-335 slice W3 — the flows the owner kept, sealed', () => {
  const key = (): D214KeyProvider => {
    const bytes = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
    return () => bytes;
  };
  const steps = [{ do: 'type' as const, url: 'https://github.com/new', title: 'New repository',
    element: { role: 'text box', label: 'Repository name', selector: '#repository-name-input' }, value: 'recued-notes', at: 1 }];

  it('keeps, lists newest first, opens and forgets a flow; the typed text is never in the row as written', async () => {
    const db = new Database(':memory:');
    const store = createExecutionCaseBrowserFlowStore(db, key());
    const first = await store.keep({ session_id: 's1', root_request_id: 'r1', kept_at: 100, steps });
    const second = await store.keep({ session_id: 's2', root_request_id: 'r2', kept_at: 200, steps });
    expect((await store.list()).map((flow) => flow.flow_id)).toEqual([second, first]);
    expect(await store.get(first!)).toEqual({ flow_id: first, session_id: 's1', root_request_id: 'r1', kept_at: 100, steps });
    const raw = JSON.stringify(db.prepare('SELECT * FROM execution_case_browser_flows').all());
    expect(raw).not.toContain('recued-notes');
    expect(raw).not.toContain('github.com');
    expect(store.forget(first!)).toBe(true);
    expect(store.forget(first!)).toBe(false);
    expect(store.deleteForSession('s2')).toBe(1);
    expect(await store.list()).toEqual([]);
  });

  it('a locked vault keeps nothing, rather than keep it raw', async () => {
    const store = createExecutionCaseBrowserFlowStore(new Database(':memory:'), () => null);
    expect(await store.keep({ session_id: 's1', root_request_id: 'r1', kept_at: 1, steps })).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

describe('D-335 slice W2 — the adapter takes acted_on out of what the model reads, and records it', () => {
  const harness = (answer: (request: DispatchRequest) => DispatchOutcome) => {
    const flows = createBrowserFlowRecorder({ now: () => 50 });
    flows.bindRun('run-1', { session_id: 's1', turn_id: 't1' });
    const requests: DispatchRequest[] = [];
    const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
      requests.push(request);
      return answer(request);
    });
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
      pageReads: createPageReadStore(),
      browserFlows: flows,
    });
    const run = (slug: string, input: Record<string, unknown>) => {
      const manifest = KERNEL_MANIFESTS.find((m) => m.slug === slug)!;
      const call: ResolvedCall = { slug, risk_tier: 'write', output: manifest.output, input: { target: '*://*/*', ...input },
        stepMeta: { recipe_id: slug, step_id: 'act', run_id: 'run-1' } };
      return adapter(call) as Promise<Record<string, unknown>>;
    };
    return { flows, requests, run, steps: () => flows.stepsFor('s1', () => true) };
  };

  it('a click and typing: asked for, out of the answer, and recorded with what was typed', async () => {
    const t = harness((request) => request.action === 'click' ? ok({ clicked: true, acted_on: acted('button', 'Create', '#create') })
      : request.action === 'fill' ? ok({ filled: true, acted_on: acted('text box', 'Repository name', '#name') })
        : ok({}));
    expect(await t.run('dom-write', { page: PAGE, ref: 'e3', value: 'recued-notes' })).not.toHaveProperty('acted_on');
    expect(await t.run('dom-click', { page: PAGE, ref: 'e4' })).not.toHaveProperty('acted_on');
    expect(t.requests.filter((r) => r.action !== 'reread').every((r) => r.expects_output_keys.includes('acted_on'))).toBe(true);
    expect(t.steps()).toEqual([
      { do: 'type', url: 'https://github.com/new', title: 'New repository', element: { role: 'text box', label: 'Repository name',
        selector: '#name' }, value: 'recued-notes', at: 50 },
      { do: 'click', url: 'https://github.com/new', title: 'New repository', element: { role: 'button', label: 'Create',
        selector: '#create' }, at: 50 },
    ]);
  });

  it('what a field for a password takes is never recorded; a key is', async () => {
    const t = harness((request) => request.action === 'fill' ? ok({ filled: true, acted_on: acted('password field', 'Password', '#pw', true) })
      : request.action === 'press' ? ok({ pressed: 'Enter', acted_on: acted('password field', 'Password', '#pw', true) })
        : ok({}));
    await t.run('dom-write', { page: PAGE, ref: 'e3', value: 'hunter2' });
    await t.run('dom-click', { page: PAGE, ref: 'e3', key: 'Enter' });
    expect(t.steps().map(({ do: kind, value, secret, key }) => ({ kind, value, secret, key }))).toEqual([
      { kind: 'type', value: undefined, secret: true, key: undefined },
      { kind: 'press', value: undefined, secret: undefined, key: 'Enter' }]);
    expect(JSON.stringify(t.steps())).not.toContain('hunter2');
  });

  it('each step of a sequence is recorded; a Bridge that answers no acted_on records nothing', async () => {
    const t = harness((request) => request.action === 'fill'
      ? ok({ filled: true, acted_on: acted('search box', 'Search', '#q') })
      : request.action === 'submit' ? ok({ submitted: true, filled: true, moved: true, page: '7:DOC2', url: 'https://github.com/search',
        title: 'Search', acted_on: acted('search box', 'Search', '#q') }) : ok({}));
    const answer = await t.run('dom-act', { page: PAGE, steps: [{ do: 'type', ref: 'e3', value: 'recued' },
      { do: 'type', ref: 'e3', value: 'recued notes', submit: true }] });
    expect(JSON.stringify(answer)).not.toContain('acted_on');
    expect(t.steps().map((step) => [step.do, step.value])).toEqual([['type', 'recued'], ['submit', 'recued notes']]);
    const older = harness((request) => request.action === 'click' ? ok({ clicked: true }) : ok({}));
    await older.run('dom-click', { page: PAGE, ref: 'e4' });
    expect(older.steps()).toEqual([]);
  });

  it('reuses an acknowledged double-click when drafting a recipe from the browser flow', async () => {
    const t = harness(request => request.action === 'click' && request.args.click_count === 2
      ? ok({ clicked: true, acted_on: acted('button', 'Edit', '#edit') }) : ok({}));
    await t.run('dom-act', { page: PAGE, steps: [{ do: 'click', ref: 'e4', count: 2 }] });
    const { recipe } = recipeFromBrowserFlow({ flow_id: 'double-click', steps: t.steps() });
    expect(recipe.steps).toContainEqual(expect.objectContaining({ op: 'core.dom.act', args: expect.objectContaining({
      steps: [{ do: 'click', selector: '#edit', count: 2 }],
    }) }));
  });
  it('preserves paste delivery when drafting a recipe from an acknowledged browser flow', async () => {
    const t = harness(request => request.action === 'fill' && request.args.delivery === 'paste'
      ? ok({ pasted: true, acted_on: acted('grid', 'Import rows', '#import') }) : ok({}));
    await t.run('dom-act', { page: PAGE, steps: [{ do: 'type', ref: 'e4', delivery: 'paste', value: 'a\tb\nc\td' }] });
    const { recipe } = recipeFromBrowserFlow({ flow_id: 'paste', steps: t.steps() });
    expect(recipe.steps).toContainEqual(expect.objectContaining({ op: 'core.dom.act', args: expect.objectContaining({
      steps: [{ do: 'type', selector: '#import', value: '{{config.text_1}}', delivery: 'paste' }],
    }) }));
  });
});

describe('D-335 slice W4 — a kept flow made into a recipe, without a model', () => {
  const flow = { flow_id: 'f-1a2b3c4d-5e6f', steps: [
    { do: 'type' as const, url: 'https://github.com/new?ref=nav', title: 'New repository',
      element: { role: 'text box', label: 'Repository name', selector: '#repository-name-input' }, value: 'recued-notes', at: 1 },
    { do: 'type' as const, url: 'https://github.com/new?ref=nav', title: 'New repository',
      element: { role: 'password field', label: 'Confirm password', selector: '#sudo_password' }, secret: true as const, at: 2 },
    { do: 'click' as const, url: 'https://github.com/new?ref=nav', title: 'New repository',
      element: { role: 'button', label: 'Create repository' }, at: 3 },
    { do: 'press' as const, url: 'https://github.com/x/recued-notes', title: 'recued-notes',
      element: { role: 'text box', label: 'Search', selector: '#q' }, key: 'Enter', at: 4 },
  ] };

  it('finds the page by its address or opens it, then does every step by its selector, each text a setting', () => {
    const { recipe, issues } = recipeFromBrowserFlow(flow);
    const parsed = parseRecipe(recipe);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(validateRecipeInline(parsed.recipe)).toMatchObject({ ok: true });
    expect(recipe.recipe_id).toBe('browser-flow-github-com-f1a2b3c4');
    const steps = recipe.steps as Array<{ id: string; op?: string; args?: Record<string, unknown>; value?: unknown }>;
    expect(steps.map((step) => step.id)).toEqual(['tabs', 'tab', 'opened', 'page', 'act']);
    // The tab found by the page's address without its query; opened at the address used.
    expect(steps[1]!.value).toBe('https://github.com/new');
    expect(steps[2]!.args).toEqual({ target: '*://*/*', address: 'https://github.com/new?ref=nav' });
    expect(steps[4]!.args!.steps).toEqual([
      { do: 'type', selector: '#repository-name-input', value: '{{config.text_1}}' },
      { do: 'type', selector: '#sudo_password', value: '{{config.text_2}}' },
      { do: 'click', selector: BROWSER_FLOW_SELECTOR_TO_FILL },
      { do: 'press', selector: '#q', key: 'Enter' },
    ]);
    // What was typed is the default; a secret has none, so it is asked for.
    expect(recipe.variables).toMatchObject({ text_1: { label: 'Repository name', type: 'string', default: 'recued-notes' } });
    expect(recipe.variables!.text_2).not.toHaveProperty('default');
    expect(issues).toEqual([
      'Step 2 types into the password field “Confirm password”: what was typed was not kept, so the recipe asks for it.',
      `Step 3 (click the button “Create repository”) has no selector that finds it alone: replace ${BROWSER_FLOW_SELECTOR_TO_FILL} with one in Kitchen.`,
    ]);
  });
});

describe('D-335 slice W4 — the owner\'s rpcs: Learning lists kept flows beside the cases, forgets one, drafts its recipe', () => {
  const entry = { flow_id: 'f1', kept_at: 9, sites: ['github.com'], steps: [] };
  const deps = (withFlows: boolean) => ({
    executionCaseLearned: async () => [],
    ...(withFlows ? { executionBrowserFlows: {
      list: async () => [entry],
      forget: async (flow_id: string) => flow_id === 'f1',
      recipe: async (flow_id: string) => ({ ok: flow_id === 'f1', issues: [] }),
    } } : {}),
  }) as unknown as ChatRpcDeps;

  it('the learned answer carries the kept flows, and a server without them answers the cases alone', async () => {
    expect(await handleExecutionCaseLearned(deps(true))).toEqual({ cases: [], browser_flows: [entry] });
    expect(await handleExecutionCaseLearned(deps(false))).toEqual({ cases: [] });
  });

  it('forget and recipe take a flow id, and refuse a call without one', async () => {
    expect(await handleExecutionBrowserFlowForget(deps(true), { flow_id: 'f1' })).toEqual({ removed: true });
    expect(await handleExecutionBrowserFlowForget(deps(true), { flow_id: 'gone' })).toEqual({ removed: false });
    expect(await handleExecutionBrowserFlowRecipe(deps(true), { flow_id: 'f1' })).toEqual({ ok: true, issues: [] });
    await expect(handleExecutionBrowserFlowRecipe(deps(true), {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleExecutionBrowserFlowForget(deps(false), { flow_id: 'f1' })).rejects.toMatchObject({ code: 'not_configured' });
  });
});

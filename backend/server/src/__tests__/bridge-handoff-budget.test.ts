import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCapabilityProfile, BridgeResult, Commit, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { createAuditLogStore, createCommitStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createBridgeDispatcher, createBridgeResultListener, type BridgeTransport, type DispatchRequest, type DispatcherOptions } from '../bridges/dispatcher.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { withRunAbortContext } from '../execution/run-abort-context.js';
import { handleExecute } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.useRealTimers(); vi.restoreAllMocks();
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const observe = <T>(promise: Promise<T>) => promise.then(result => ({ result }), error => ({ error }));
const reached = <T>(entered: Promise<void>, execution: Promise<T>) => Promise.race([
  entered, execution.then(result => { throw new Error('Execution settled before the fixture gate: ' + JSON.stringify(result)); }),
]);
const target = 'https://app.fixture.invalid/*';
const document = { tab_id: 1, document_id: 'fixture-document', url: 'https://app.fixture.invalid/page' };
const capabilities: BridgeCapabilityProfile = { software_version: 'fixture', chrome_version: 'fixture',
  permissions_granted: [], granted_origins: [target], offscreen_supported: true, alarms_supported: true,
  dom_documents: { version: 1, documents: [document] } };
const receipt = (command_id: string, extra: Partial<BridgeResult> = {}): BridgeResult => ({
  command_id, status: 'ok', outputs: { text: 'receipt', filled: true, clicked: true }, duration_ms: 1,
  bridge_version: 'fixture', idempotency_key_seen: false, ...extra,
});
const fixture = (options: Partial<Pick<DispatcherOptions, 'auditLog' | 'sleep'>> = {}) => {
  const registry = createBridgeRegistry(); const listener = createBridgeResultListener();
  cleanups.push(() => listener.clear?.());
  const attach = (id: string, online_since = 1) => registry.attach({ client_token_id: id, client_label: id,
    session_id: id, online_since, last_seen_at: online_since, capabilities });
  attach('one', 2);
  const send = vi.fn<BridgeTransport['send']>(async (_id, envelope) => {
    if (envelope.kind === 'command') listener.resolveResult(receipt(envelope.command.command_id));
    return { ok: true };
  });
  const cancel = vi.fn<BridgeTransport['cancel']>(async () => ({ ok: true }));
  let serial = 0;
  const dispatcher = createBridgeDispatcher({ registry, listener, transport: { send, cancel },
    generateCommandId: () => 'command-' + ++serial, ...options });
  const request: DispatchRequest = { recipe_run_id: 'wire-run-id', step_id: 'read', action: 'read_dom', args: { selector: '#first' },
    expects_output_keys: ['text'], idempotency_key: 'fixture-key', timeout_ms: 1_000,
    ingredient: { publisher_id: 'fixture', slug: 'fixture-dom', version: '1', surface_kind: 'reading',
      domain_allowlist: [target], domain_allowlist_signature: 'fixture' } };
  return { registry, listener, dispatcher, request, send, cancel, attach };
};
const auditLog = () => createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
const manifest = (write = false): IngredientManifest => ({ slug: 'fixture-dom', version: 1, name: 'DOM fixture', description: '',
  author: 'fixture', kind: 'dom', category: 'data', risk_tier: write ? 'write' : 'read', surface_kind: write ? 'authoring' : 'reading',
  input: {}, output: { [target]: 'trigger', ...(write ? { '#first': 'dom.value', '#second': 'click' } : { '#first': 'first', '#second': 'second' }) } });
const recipeFixture = (options: Parameters<typeof fixture>[0] = {}) => {
  const f = fixture(options); const manifests = createManifestRegistry('/nonexistent'); manifests.register(manifest());
  const recipes = createRecipeStore('/nonexistent');
  for (const id of ['budgeted', 'independent']) {
    const recipe: RecipeDefinition = { recipe_id: id, version: 1, ttl: 0,
      metadata: { name: id, description: 'Bridge budget fixture.', author: 'fixture', supported_platforms: [],
        ...(id === 'budgeted' ? { budget_ms: 1_000 } : {}) },
      variables: {}, prefetch_steps: [], steps: [{ id: 'read', ingredient: 'fixture-dom', input: {} }], output: { render: [] } };
    recipes.register(recipe);
  }
  const store = createCommitStore(createInMemoryCollection<Commit>()); const ids = new Map<string, string>();
  return { ...f, commits: (id = 'budgeted') => store.listByRun(ids.get(id)!),
    run: (id = 'budgeted') => handleExecute({ recipeStore: recipes, baseVault: {}, commitStore: store,
      executorConfig: { manifests, bridgeDispatcherRef: () => f.dispatcher } }, { recipe_id: id,
      execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } },
    { onRunMinted: run_id => { ids.set(id, run_id); } }),
  };
};

describe('browser bridge handoffs respect their dispatching run', () => {
  it.each([undefined, 'one'])('refuses a stopped run before an ordinary send (preferred bridge: %s)', async preferred_bridge_label => {
    vi.useFakeTimers(); const f = fixture(); const controller = new AbortController(); controller.abort();
    const register = vi.spyOn(f.listener, 'awaitResult');
    await expect(withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.dispatch({ ...f.request, preferred_bridge_label })))
      .rejects.toMatchObject({ code: 'run_killed' });
    expect(f.send).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a send after asynchronous history ordering crosses stop', async () => {
    const log = auditLog(); const entered = gate(); const held = gate(); const f = fixture({ auditLog: log });
    vi.spyOn(log, 'lastSuccessfulBridgeDispatch').mockImplementationOnce(async () => { entered.release(); await held.promise; return null; });
    const controller = new AbortController();
    const execution = observe(withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.dispatch(f.request)));
    try {
      await reached(entered.promise, execution); controller.abort(); held.release();
      expect(await execution).toMatchObject({ error: { code: 'run_killed' } }); expect(f.send).not.toHaveBeenCalled();
    } finally { held.release(); await execution; }
  });

  it('refuses a reviewed send after its asynchronous host check crosses stop', async () => {
    vi.useFakeTimers(); const f = fixture(); const entered = gate(); const held = gate(); const controller = new AbortController();
    const execution = observe(withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.dispatch(f.request, {
      binding: { client_token_id: 'one', document }, beforeSend: async () => { entered.release(); await held.promise; },
    })));
    try {
      await reached(entered.promise, execution); controller.abort(); held.release();
      expect(await execution).toMatchObject({ error: { code: 'run_killed' } }); expect(f.send).not.toHaveBeenCalled();
      expect(f.dispatcher.canResolve('command-1', 'one')).toBe(false); expect(vi.getTimerCount()).toBe(0);
    } finally { held.release(); await execution; }
  });

  it('cleans a registered result slot if stop happens at the final send boundary', async () => {
    vi.useFakeTimers(); const f = fixture(); const controller = new AbortController(); const register = f.listener.awaitResult;
    const cancelAwait = vi.spyOn(f.listener, 'cancelAwait');
    vi.spyOn(f.listener, 'awaitResult').mockImplementation((...args) => {
      const pending = register(...args); controller.abort(); return pending;
    });
    await expect(withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.dispatch(f.request)))
      .rejects.toMatchObject({ code: 'run_killed' });
    expect(f.send).not.toHaveBeenCalled(); expect(cancelAwait).toHaveBeenCalledWith('command-1');
    expect(f.dispatcher.canResolve('command-1', 'one')).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['send', 'result'] as const)('refuses a retry after %s queue-full backoff crosses stop', async source => {
    vi.useFakeTimers(); const entered = gate(); const held = gate();
    const f = fixture({ sleep: async () => { entered.release(); await held.promise; } });
    f.send.mockImplementationOnce(async (_id, envelope) => {
      if (source === 'result' && envelope.kind === 'command') f.listener.resolveResult(receipt(envelope.command.command_id, {
        status: 'rejected', error: { code: 'queue_full', message: 'Fixture queue full' },
      }));
      return source === 'send' ? { ok: false, reason: 'queue_full' } : { ok: true };
    });
    const controller = new AbortController();
    const execution = observe(withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.dispatch(f.request)));
    try {
      await reached(entered.promise, execution); controller.abort(); held.release();
      expect(await execution).toMatchObject({ error: { code: 'run_killed' } }); expect(f.send).toHaveBeenCalledOnce();
      expect(f.dispatcher.canResolve('command-1', 'one')).toBe(false); expect(vi.getTimerCount()).toBe(0);
    } finally { held.release(); await execution; }
  });

  it('does not fall through to another bridge after an admitted capacity-gap result crosses stop', async () => {
    const f = fixture(); f.attach('two'); const controller = new AbortController();
    f.send.mockImplementationOnce(async (_id, envelope) => {
      controller.abort();
      if (envelope.kind === 'command') f.listener.resolveResult(receipt(envelope.command.command_id, {
        status: 'error', error: { code: 'capacity_gap_tab_unavailable', message: 'No tab' },
      }));
      return { ok: true };
    });
    await expect(withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.dispatch(f.request)))
      .rejects.toMatchObject({ code: 'run_killed' });
    expect(f.send).toHaveBeenCalledOnce(); expect(f.dispatcher.canResolve('command-2', 'two')).toBe(false);
  });

  it.each(['ok', 'error'] as const)('drains an admitted %s result after stop and releases result ownership', async status => {
    vi.useFakeTimers(); const f = fixture(); const entered = gate(); const held = gate(); const controller = new AbortController();
    f.send.mockImplementationOnce(async (_id, envelope) => {
      entered.release(); await held.promise;
      if (envelope.kind === 'command') f.listener.resolveResult(receipt(envelope.command.command_id, { status,
        ...(status === 'error' ? { error: { code: 'selector_not_found', message: 'Missing selector' } } : {}) }));
      return { ok: true };
    });
    let settled = false;
    const execution = withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.dispatch(f.request))
      .then(result => { settled = true; return result; });
    try {
      await reached(entered.promise, execution); controller.abort();
      expect(settled).toBe(false); expect(f.dispatcher.canResolve('command-1', 'one')).toBe(true);
      held.release(); expect(await execution).toMatchObject({ kind: 'completed', result: { status } });
      expect(f.cancel).not.toHaveBeenCalled(); expect(f.dispatcher.canResolve('command-1', 'one')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { held.release(); await execution; }
  });

  it('still routes an explicit cancel after stop while an admitted command drains', async () => {
    const f = fixture(); const entered = gate(); const held = gate(); const controller = new AbortController();
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementationOnce(async (...args) => { entered.release(); await held.promise; return send(...args); });
    const execution = withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.dispatch(f.request));
    try {
      await reached(entered.promise, execution); controller.abort();
      await expect(withRunAbortContext({ signal: controller.signal }, () => f.dispatcher.cancel('command-1', 'owner stop'))).resolves.toEqual({ ok: true });
      expect(f.cancel).toHaveBeenCalledWith('one', { command_id: 'command-1', reason: 'owner stop' });
      held.release(); expect(await execution).toMatchObject({ kind: 'completed' });
    } finally { held.release(); await execution; }
  });

  it('uses the current run when a pooled dispatcher was created by an earlier run', async () => {
    const opener = new AbortController(); const f = withRunAbortContext({ signal: opener.signal }, () => fixture());
    await withRunAbortContext({ signal: opener.signal }, () => f.dispatcher.dispatch(f.request)); opener.abort();
    await expect(withRunAbortContext({ signal: new AbortController().signal }, () => f.dispatcher.dispatch(f.request)))
      .resolves.toMatchObject({ kind: 'completed' });
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it.each(['send', 'result'] as const)('keeps timely %s queue-full retries working with stable command identity', async source => {
    const f = fixture({ sleep: async () => {} });
    f.send.mockImplementationOnce(async (_id, envelope) => {
      if (source === 'result' && envelope.kind === 'command') f.listener.resolveResult(receipt(envelope.command.command_id, {
        status: 'rejected', error: { code: 'queue_full', message: 'Busy' },
      }));
      return source === 'send' ? { ok: false, reason: 'queue_full' } : { ok: true };
    });
    await expect(f.dispatcher.dispatch(f.request)).resolves.toMatchObject({ kind: 'completed', attempts: 2 });
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]);
  });
});

describe('each DOM action retains its invocation budget fence', () => {
  it.each([false, true])('does not start another action after an admitted result crosses stop (write: %s)', async write => {
    const m = manifest(write); const entered = gate(); const held = gate(); const controller = new AbortController();
    const dispatch = vi.fn(async () => {
      entered.release(); await held.promise;
      return { kind: 'completed' as const, result: receipt('fixture'), bridge_client_token_id: 'one', attempts: 1 };
    });
    const adapter = createBridgeDomAdapter({ manifests: { get: () => m }, getDispatcher: () => ({ dispatch,
      cancel: async () => ({ ok: true }), canResolve: () => false }) });
    const execution = observe(withRunAbortContext({ signal: controller.signal }, () => adapter({ slug: m.slug,
      risk_tier: m.risk_tier, input: { value: 'hello' }, output: m.output })));
    try {
      await reached(entered.promise, execution); controller.abort(); held.release();
      expect(await execution).toMatchObject({ error: { code: 'run_killed' } }); expect(dispatch).toHaveBeenCalledOnce();
    } finally { held.release(); await execution; }
  });
});

describe('real recipe budgets fence browser bridge commands', () => {
  it('refuses the first bridge command when history ordering crosses expiry', async () => {
    vi.useFakeTimers(); const log = auditLog(); const f = recipeFixture({ auditLog: log }); const entered = gate(); const held = gate();
    vi.spyOn(log, 'lastSuccessfulBridgeDispatch').mockImplementationOnce(async () => { entered.release(); await held.promise; return null; });
    const execution = f.run();
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.send).not.toHaveBeenCalled(); expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
    } finally { held.release(); await execution; }
  });

  it.each(['send', 'result'] as const)('refuses another command after %s queue-full backoff crosses expiry', async source => {
    vi.useFakeTimers(); const entered = gate(); const held = gate(); const f = recipeFixture({ sleep: async () => { entered.release(); await held.promise; } });
    f.send.mockImplementationOnce(async (_id, envelope) => {
      if (source === 'result' && envelope.kind === 'command') f.listener.resolveResult(receipt(envelope.command.command_id, {
        status: 'rejected', error: { code: 'queue_full', message: 'Busy' },
      }));
      return source === 'send' ? { ok: false, reason: 'queue_full' } : { ok: true };
    });
    const execution = f.run();
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.send).toHaveBeenCalledOnce(); expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
      expect(f.dispatcher.canResolve('command-1', 'one')).toBe(false); expect(vi.getTimerCount()).toBe(0);
    } finally { held.release(); await execution; }
  });

  it('drains the first command across expiry and suppresses the next DOM action', async () => {
    vi.useFakeTimers(); const f = recipeFixture(); const entered = gate(); const held = gate(); const send = f.send.getMockImplementation()!;
    f.send.mockImplementationOnce(async (...args) => { entered.release(); await held.promise; return send(...args); });
    let settled = false; const execution = f.run().then(result => { settled = true; return result; });
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false); expect(f.dispatcher.canResolve('command-1', 'one')).toBe(true);
      held.release(); expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.send).toHaveBeenCalledOnce(); expect(f.cancel).not.toHaveBeenCalled();
      expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]); expect((await f.commits())[0]).not.toHaveProperty('output');
      expect(f.dispatcher.canResolve('command-1', 'one')).toBe(false); expect(vi.getTimerCount()).toBe(0);
    } finally { held.release(); await execution; }
  });

  it('keeps timely multi-action recipes working', async () => {
    const f = recipeFixture(); expect((await f.run()).success).toBe(true); expect(f.send).toHaveBeenCalledTimes(2);
    expect(await f.commits()).toMatchObject([{ status: 'succeeded', output: { first: 'receipt', second: 'receipt' } }]);
  });

  it('keeps an independent root recipe live on the same dispatcher after another root expires', async () => {
    vi.useFakeTimers(); const f = recipeFixture(); const firstEntered = gate(); const secondEntered = gate(); const first = gate(); const second = gate();
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementationOnce(async (...args) => { firstEntered.release(); await first.promise; return send(...args); });
    f.send.mockImplementationOnce(async (...args) => { secondEntered.release(); await second.promise; return send(...args); });
    const expiring = f.run(); await reached(firstEntered.promise, expiring); const independent = f.run('independent');
    try {
      await reached(secondEntered.promise, independent); await vi.advanceTimersByTimeAsync(1_000);
      first.release(); expect((await expiring).success).toBe(false); second.release(); expect((await independent).success).toBe(true);
      expect(f.send).toHaveBeenCalledTimes(3); expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
      expect(await f.commits('independent')).toMatchObject([{ status: 'succeeded' }]); expect(vi.getTimerCount()).toBe(0);
    } finally { first.release(); second.release(); await Promise.all([expiring, independent]); }
  });
});

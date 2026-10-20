import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionRow, IngredientManifest } from '@recued/contracts';
import { createConnectionCacheScopes, type ConnectionCacheStore } from '../connection-cache-scope.js';
import { withRunAbortContext } from '../execution/run-abort-context.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const fixture = async (options: { recoverySignal?: AbortSignal; checkRecovery?(): void } = {}) => {
  let row: ConnectionRow = { pk: 'api:sales', kind: 'api', name: 'sales', display_name: 'Sales',
    config_json: '{"base_url":"https://example.test"}', auth_ciphertext: 'fixture', enrolled_at: 1, updated_at: 1 };
  let revision: string | undefined = '0';
  let current: IngredientManifest = { slug: 'read', name: 'Read', description: '', author: 'fixture', kind: 'connection',
    category: 'data', risk_tier: 'read', input: { connection_kind: 'api', connection: 'sales', method: 'GET', path: '/items' }, output: {} };
  const get = vi.fn<ConnectionCacheStore['get']>(() => row);
  const store: ConnectionCacheStore = { get, getReadCacheRevision: () => revision, beginReadCacheWrite: () => () => {} };
  const scopes = createConnectionCacheScopes(store, { ...options, manifest: () => current });
  const call = { slug: current.slug, input: current.input!, manifest: current, stepMeta: undefined };
  const scope = (await scopes.cacheScope(call))!;
  if (!scope) throw new Error('Fixture scope missing');
  revision = undefined;
  let invalidation: unknown;
  try { await scope.validate(); } catch (error) { invalidation = error; }
  const rebind = scope.retry?.(invalidation);
  if (!rebind) throw new Error('Fixture invalidation was not recognized');
  return { call, scope, scopes, recover: () => rebind(call), get,
    revision: (next: string | undefined) => { revision = next; },
    replace: () => { row = { ...row, enrolled_at: 2 }; },
    reclassify: () => { current = { ...current, risk_tier: 'write' }; },
  };
};

describe('bounded pending-write recovery', () => {
  it.each([false, true])('retains an ancestor deadline when a nested run has its own signal %s', async linked => {
    const parent = new AbortController(); const child = new AbortController();
    const f = await withRunAbortContext({ signal: parent.signal }, () =>
      withRunAbortContext({ signal: linked ? child.signal : undefined }, () => fixture()));
    vi.useFakeTimers(); let stopped: string | undefined;
    const recovery = f.recover().then(() => {}, (error: { code: string }) => { stopped = error.code; });
    try {
      parent.abort(); await vi.advanceTimersByTimeAsync(25);
      expect(stopped).toBe('run_killed'); expect(child.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await vi.advanceTimersByTimeAsync(250); await recovery; }
  });

  it.each(['owner', 'engine'] as const)('retains the %s signal after the calling scope returns', async source => {
    const owner = new AbortController(); const engine = new AbortController();
    const f = await withRunAbortContext({ signal: engine.signal }, () => fixture({ recoverySignal: owner.signal }));
    vi.useFakeTimers();
    const recovery = f.recover(); const rejected = expect(recovery).rejects.toMatchObject({ code: 'run_killed' });
    await vi.advanceTimersByTimeAsync(25);
    (source === 'owner' ? owner : engine).abort(); await rejected;
    const reads = f.get.mock.calls.length; await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get).toHaveBeenCalledTimes(reads); expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates concurrent calls through the same cache-scope factory', async () => {
    const f = await fixture(); const controller = new AbortController(); f.revision('0');
    const limited = (await withRunAbortContext({ signal: controller.signal }, () => f.scopes.cacheScope(f.call)))!;
    const independent = (await f.scopes.cacheScope(f.call))!;
    f.revision(undefined);
    let limitedError: unknown; let independentError: unknown;
    try { await limited.validate(); } catch (error) { limitedError = error; }
    try { await independent.validate(); } catch (error) { independentError = error; }
    const limitedRetry = limited.retry!(limitedError)!; const independentRetry = independent.retry!(independentError)!;
    vi.useFakeTimers();
    const stopped = limitedRetry(f.call); const rejected = expect(stopped).rejects.toMatchObject({ code: 'run_killed' });
    let otherSettled = false;
    const other = independentRetry(f.call).then(scope => { otherSettled = true; return scope; });
    controller.abort(); await rejected; await vi.advanceTimersByTimeAsync(25);
    expect(otherSettled).toBe(false);
    f.revision('1'); await vi.advanceTimersByTimeAsync(25);
    const refreshed = (await other)!; await expect(refreshed.validate()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a stable generation and cleans up its timers and abort listener', async () => {
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const f = await fixture({ recoverySignal: controller.signal });
    vi.useFakeTimers();
    let settled = false;
    const recovery = f.recover().then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    f.revision('1'); await vi.advanceTimersByTimeAsync(1);
    const refreshed = await recovery;
    expect(refreshed?.key).not.toBe(f.scope.key);
    await expect(refreshed?.validate()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('declines at the fixed deadline when a writer never completes', async () => {
    const f = await fixture(); vi.useFakeTimers();
    let settled = false;
    const recovery = f.recover().then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(249); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await recovery).toBeUndefined();
    const reads = f.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get).toHaveBeenCalledTimes(reads); expect(vi.getTimerCount()).toBe(0);
  });

  it('returns immediately if the writer already completed', async () => {
    const f = await fixture(); vi.useFakeTimers(); f.revision('1');
    expect((await f.recover())?.key).not.toBe(f.scope.key);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('declines a late generation even when a slow probe keeps the deadline timer from running', async () => {
    const f = await fixture(); const row = await f.get('api', 'sales');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    f.get.mockImplementationOnce(() => { elapsed = 251; f.revision('1'); return row; });
    expect(await f.recover()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can recover after a rejected write leaves the original generation intact', async () => {
    const f = await fixture(); vi.useFakeTimers();
    const recovery = f.recover(); await vi.advanceTimersByTimeAsync(25);
    f.revision('0'); await vi.advanceTimersByTimeAsync(25);
    expect((await recovery)?.key).toBe(f.scope.key); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['before', 'during'] as const)('honors cancellation %s the wait and stops polling', async when => {
    const controller = new AbortController(); const f = await fixture({ recoverySignal: controller.signal });
    vi.useFakeTimers(); if (when === 'before') controller.abort();
    const recovery = f.recover(); const rejected = expect(recovery).rejects.toMatchObject({ code: 'run_killed' });
    if (when === 'during') { await vi.advanceTimersByTimeAsync(25); controller.abort(); }
    await rejected; const reads = f.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get).toHaveBeenCalledTimes(reads); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['account', 'operation', 'authority'] as const)('refuses a changed %s while waiting', async change => {
    let admitted = true; const refused = new Error('Fixture run admission changed');
    const f = await fixture({ checkRecovery: () => { if (!admitted) throw refused; } });
    vi.useFakeTimers(); const recovery = f.recover();
    const rejected = change === 'authority' ? expect(recovery).rejects.toBe(refused)
      : expect(recovery).rejects.toMatchObject({ details: { reason: change === 'account' ? 'connection_changed' : 'cache_operation_changed' } });
    await vi.advanceTimersByTimeAsync(25);
    if (change === 'account') f.replace();
    if (change === 'operation') f.reclassify();
    if (change === 'authority') admitted = false;
    await vi.advanceTimersByTimeAsync(25); await rejected; expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'cancel'] as const)('does not revive recovery when an asynchronous probe resolves after %s', async stop => {
    const controller = new AbortController(); const f = await fixture({ recoverySignal: controller.signal });
    vi.useFakeTimers();
    const row = await f.get('api', 'sales');
    let release!: () => void;
    const delayed = new Promise<ConnectionRow | null>(resolve => { release = () => resolve(row); });
    f.get.mockReturnValueOnce(delayed);
    const recovery = f.recover();
    const settled = stop === 'cancel' ? expect(recovery).rejects.toMatchObject({ code: 'run_killed' })
      : expect(recovery).resolves.toBeUndefined();
    if (stop === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(250);
    await settled; const reads = f.get.mock.calls.length;
    f.revision('1'); release(); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get).toHaveBeenCalledTimes(reads); expect(vi.getTimerCount()).toBe(0);
  });
});

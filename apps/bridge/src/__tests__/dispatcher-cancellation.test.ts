import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { BridgeCommand } from '@recued/contracts';
import { buildActionExecutor } from '../actions/executor.js';
import { executeReviewedBridgeDocument } from '../actions/reviewed-document.js';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import { BRIDGE_RECEIPT_STORE_NAME, createIndexedDbIdempotencyCache } from '../idempotency/indexed-db-cache.js';
import { buildGrant, createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import { dispatchBridgeCommand, type ActionExecutorOutcome, type BridgeActionExecutor } from '../queue/dispatcher.js';

afterEach(() => vi.restoreAllMocks());

const fixture = async (storage: 'memory' | 'IndexedDB' = 'IndexedDB') => {
  const indexedDB = new IDBFactory();
  const scope = { server_public_key: 'original-server', token_id: 'original-pair' };
  const memory = createInMemoryIdempotencyCache();
  const reopen = () => storage === 'memory' ? memory : createIndexedDbIdempotencyCache({ indexedDB, scope });
  const cache = reopen(), grants = createInMemoryBridgeGrantStore();
  const ingredient = { publisher_id: 'fixture', slug: 'cancelled-write', version: '1', surface_kind: 'authoring' as const,
    domain_allowlist: ['https://fixture.invalid/*'], domain_allowlist_signature: 'fixture-signature' };
  await grants.put(buildGrant(ingredient, ingredient.domain_allowlist, Date.now()));
  const command: BridgeCommand = { command_id: 'original', idempotency_key: 'original-key', recipe_run_id: 'original-run',
    step_id: 'write', ingredient, action: 'click', target_domain_pattern: ingredient.domain_allowlist[0]!,
    args: { selector: '#submit', value: 'confirmed value' }, expects_output_keys: ['clicked'], timeout_ms: 5_000 };
  let release!: (outcome: ActionExecutorOutcome) => void; let reject!: (error: Error) => void; let enter!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<ActionExecutorOutcome>((resolve, no) => { release = resolve; reject = no; });
  const execute = vi.fn<BridgeActionExecutor['execute']>(() => { enter(); return held; });
  const cancel = { signalled: false };
  const deps = { bridge_version: 'fixture', now: Date.now, grants, executor: { execute }, idempotency: cache };
  return { command, cache, reopen, deps, cancel, release, reject, execute, started };
};

describe('confirmed completion after explicit bridge cancellation', () => {
  it.each(['memory', 'IndexedDB'] as const)('persists the confirmed %s receipt while keeping the original reply cancelled', async storage => {
    const f = await fixture(storage);
    await f.cache.claim('independent', 'independent-key');
    const dispatch = dispatchBridgeCommand(f.command, f.deps, f.cancel);
    await f.started;
    f.cancel.signalled = true; f.release({ status: 'ok', outputs: { clicked: true } });
    const original = await dispatch;
    expect(original.result).toMatchObject({ status: 'cancelled', outputs: undefined, idempotency_key_seen: false });
    expect((await f.reopen().lookup('original'))?.result).toMatchObject({
      command_id: 'original', status: 'ok', outputs: { clicked: true }, idempotency_key_seen: false,
    });
    expect((await f.reopen().inspectInFlight()).entries.map(entry => entry.command_id)).toEqual(['independent']);
    const retry = await dispatchBridgeCommand({ ...f.command, command_id: 'explicit-retry' }, { ...f.deps, idempotency: f.reopen() });
    expect(retry).toMatchObject({ replayed_from_cache: true, result: { command_id: 'explicit-retry', status: 'ok',
      outputs: { clicked: true }, idempotency_key_seen: true } });
    expect(original.result).toMatchObject({ status: 'cancelled', outputs: undefined });
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('honours cancellation arriving during a receipt transaction and waits for commit before replying', async () => {
    const f = await fixture();
    let committed = false;
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === BRIDGE_RECEIPT_STORE_NAME) {
        request.addEventListener('success', () => { f.cancel.signalled = true; });
        this.transaction.addEventListener('complete', () => { committed = true; });
      }
      return request;
    });
    const dispatch = dispatchBridgeCommand(f.command, f.deps, f.cancel);
    await f.started; f.release({ status: 'ok', outputs: { clicked: true } });
    const original = await dispatch;
    expect(committed).toBe(true);
    expect(original.result).toMatchObject({ status: 'cancelled', outputs: undefined });
    expect((await f.reopen().lookup('original'))?.result).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect((await f.reopen().inspectInFlight()).count).toBe(0);
  });

  it.each(['memory', 'IndexedDB'] as const)('keeps a %s cache replay cancelled when cancellation arrives during lookup', async storage => {
    const f = await fixture(storage);
    await f.cache.store('original', 'original-key', { command_id: 'original', status: 'ok',
      outputs: { clicked: true }, duration_ms: 10, bridge_version: 'fixture', idempotency_key_seen: false });
    const claim = f.cache.claim.bind(f.cache);
    vi.spyOn(f.cache, 'claim').mockImplementation(async (id, key) => {
      const found = await claim(id, key); f.cancel.signalled = true; return found;
    });
    const replay = await dispatchBridgeCommand({ ...f.command, command_id: 'cancelled-retry' }, f.deps, f.cancel);
    expect(replay).toMatchObject({ replayed_from_cache: true, result: { command_id: 'cancelled-retry', status: 'cancelled',
      outputs: undefined, idempotency_key_seen: true } });
    expect((await f.reopen().lookup('original'))?.result).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('retains uncertainty and write quarantine when the confirmed receipt cannot commit after cancellation', async () => {
    const f = await fixture();
    const put = IDBObjectStore.prototype.put;
    const abort = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === BRIDGE_RECEIPT_STORE_NAME) request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    const dispatch = dispatchBridgeCommand(f.command, f.deps, f.cancel);
    const failed = expect(dispatch).rejects.toThrow();
    await f.started; f.cancel.signalled = true; f.release({ status: 'ok', outputs: { clicked: true } });
    await failed; abort.mockRestore();
    expect((await f.reopen().inspectInFlight()).count).toBe(1);
    expect(await f.reopen().lookup('original')).toBeNull();
    await expect(f.cache.claim('same-worker-retry', 'original-key')).rejects.toThrow('prior receipt write failed');
    const retry = await dispatchBridgeCommand({ ...f.command, command_id: 'fresh-worker-retry' }, { ...f.deps, idempotency: f.reopen() });
    expect(retry.result.error?.code).toBe('delivery_uncertain');
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it.each<ActionExecutorOutcome>([
    { status: 'cancelled' }, { status: 'timeout' },
    { status: 'error', error: { code: 'delivery_uncertain', message: 'Acknowledgement missing' } },
    { status: 'error', error: { code: 'mv3_lifecycle_killed', message: 'Worker interrupted' } },
  ])('keeps an unconfirmed $status / $error.code unresolved after cancellation', async outcome => {
    const f = await fixture();
    const dispatch = dispatchBridgeCommand(f.command, f.deps, f.cancel);
    await f.started; f.cancel.signalled = true; f.release(outcome);
    expect((await dispatch).result.status).toBe(outcome.status);
    expect((await f.reopen().inspectInFlight()).count).toBe(1);
    await f.cache.clear(); await f.cache.sweepExpired(Infinity);
    const retry = await dispatchBridgeCommand({ ...f.command, command_id: 'explicit-retry' }, { ...f.deps, idempotency: f.reopen() });
    expect(retry.result.error?.code).toBe('delivery_uncertain');
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('does not invent a receipt when cancellation is followed by an executor rejection', async () => {
    const f = await fixture();
    const dispatch = dispatchBridgeCommand(f.command, f.deps, f.cancel);
    const failed = expect(dispatch).rejects.toThrow('Acknowledgement lost');
    await f.started; f.cancel.signalled = true; f.reject(new Error('Acknowledgement lost'));
    await failed;
    expect((await f.reopen().inspectInFlight()).count).toBe(1);
    expect(await f.reopen().lookup('original')).toBeNull();
  });

  const writes = (['click', 'fill'] as const).flatMap(action => (['tab', 'reviewed document'] as const).map(target => ({ action, target })));
  it.each(writes)('records a real $target $action acknowledgement after cancellation without exposing outputs on the reply', async ({ action, target }) => {
    const f = await fixture();
    const document = { tab_id: 4, document_id: 'reviewed', url: 'https://fixture.invalid/record/1' };
    let release!: () => void; let enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { enter = resolve; });
    let scriptCalls = 0;
    const outputs = { [action === 'click' ? 'clicked' : 'filled']: true };
    const browserExecutor = buildActionExecutor({
      findTabByUrlPattern: async () => ({ tab_id: 4, url: document.url, window_id: 1 }),
      // click and fill both answer in the shared field shape.
      executeScript: async () => { scriptCalls++; enter(); await held; return { outputs }; },
      executeReviewedDocument: (doc, operation, args) => executeReviewedBridgeDocument({
        executeScript: async () => { scriptCalls++; enter(); await held; return [{ documentId: doc.document_id, result: { outputs } }]; },
      }, doc, operation, args),
      captureVisibleTab: async () => null, showNotification: async id => id,
    });
    const command = { ...f.command, action, expects_output_keys: Object.keys(outputs),
      ...(target === 'reviewed document' ? { reviewed_document: document } : {}) };
    const dispatch = dispatchBridgeCommand(command, { ...f.deps, executor: browserExecutor }, f.cancel);
    await started; f.cancel.signalled = true; release();
    const original = await dispatch;
    expect(original.result).toMatchObject({ status: 'cancelled', outputs: undefined });
    expect((await f.reopen().inspectInFlight()).count).toBe(0);
    expect((await f.reopen().lookup('original'))?.result).toMatchObject({ status: 'ok', outputs });
    expect(scriptCalls).toBe(1);
  });
});

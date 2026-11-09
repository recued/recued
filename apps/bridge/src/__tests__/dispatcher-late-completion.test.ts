import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { BridgeCommand } from '@recued/contracts';
import { buildActionExecutor } from '../actions/executor.js';
import { executeReviewedBridgeDocument } from '../actions/reviewed-document.js';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import { BRIDGE_RECEIPT_STORE_NAME, createIndexedDbIdempotencyCache } from '../idempotency/indexed-db-cache.js';
import { buildGrant, createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import { bridgeCommandActivity, dispatchBridgeCommand, type ActionExecutorOutcome, type BridgeActionExecutor } from '../queue/dispatcher.js';

afterEach(() => vi.restoreAllMocks());

const fixture = async (storage: 'memory' | 'IndexedDB' = 'memory') => {
  const indexedDB = new IDBFactory();
  const scope = { server_public_key: 'original-server', token_id: 'original-pair' };
  let clock = 1_000;
  const now = () => clock;
  const memory = createInMemoryIdempotencyCache({ now });
  const reopen = () => storage === 'memory' ? memory : createIndexedDbIdempotencyCache({ indexedDB, scope, now });
  const cache = reopen();
  const ingredient = { publisher_id: 'fixture', slug: 'late-write', version: '1', surface_kind: 'authoring' as const,
    domain_allowlist: ['https://fixture.invalid/*'], domain_allowlist_signature: 'fixture-signature' };
  const grants = createInMemoryBridgeGrantStore();
  await grants.put(buildGrant(ingredient, ingredient.domain_allowlist, clock));
  const command: BridgeCommand = { command_id: 'original', idempotency_key: 'original-key', recipe_run_id: 'original-run',
    step_id: 'write', ingredient, action: 'click', target_domain_pattern: ingredient.domain_allowlist[0]!,
    args: { selector: '#submit' }, expects_output_keys: ['clicked'], timeout_ms: 10 };
  let resolve!: (outcome: ActionExecutorOutcome) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<ActionExecutorOutcome>((yes, no) => { resolve = yes; reject = no; });
  const execute = vi.fn<BridgeActionExecutor['execute']>(() => pending);
  const deps = { bridge_version: 'fixture-version', now, executor: { execute }, grants, idempotency: cache };
  return { cache, reopen, indexedDB, scope, command, execute, deps, resolve, reject, setClock: (value: number) => { clock = value; } };
};

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

describe('confirmed executor completions after the bridge deadline', () => {
  it('records a confirmed late completion after the wall clock moves backwards without quarantining dispatch', async () => {
    const f = await fixture('IndexedDB');
    const original = await dispatchBridgeCommand(f.command, f.deps);
    f.setClock(250); f.resolve({ status: 'ok', outputs: { clicked: true } });
    await vi.waitFor(async () => expect((await f.reopen().inspectInFlight()).count).toBe(0));
    expect((await f.reopen().lookup('original'))?.result).toMatchObject({ status: 'ok', duration_ms: 0 });
    expect((await f.cache.claim('independent', 'independent-key')).kind).toBe('claimed');
    expect(original.result.status).toBe('timeout');
  });

  it.each(['ok', 'timeout'] as const)('commits a nonnegative %s receipt if the clock moves backwards during execution', async status => {
    const f = await fixture('IndexedDB');
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(req => {
      f.setClock(250);
      return status === 'ok' ? Promise.resolve({ status: 'ok', outputs: { clicked: true } }) : execute(req);
    });
    try {
      const out = await dispatchBridgeCommand(f.command, f.deps);
      expect(out.result).toMatchObject({ status, duration_ms: 0 });
      expect((await f.reopen().lookup('original'))?.result).toMatchObject({ status, duration_ms: 0 });
    } finally { f.resolve({ status: 'cancelled' }); await settled(); }
  });

  it.each(['tab', 'reviewed document'] as const)('keeps a missing late write acknowledgement unresolved through the real %s executor', async target => {
    const f = await fixture('IndexedDB');
    const document = { tab_id: 4, document_id: 'reviewed', url: 'https://fixture.invalid/record/1' };
    let release!: () => void; let entered!: () => void; let finished!: () => void;
    const enteredScript = new Promise<void>(resolve => { entered = resolve; });
    const executorFinished = new Promise<void>(resolve => { finished = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let scriptCalls = 0;
    const executeScript = async () => { scriptCalls++; entered(); await held; return undefined; };
    const realExecutor = buildActionExecutor({
      findTabByUrlPattern: async () => ({ tab_id: 4, url: document.url, window_id: 1 }), executeScript,
      executeReviewedDocument: (doc, action, args) => executeReviewedBridgeDocument({
        executeScript: async () => { scriptCalls++; entered(); await held; return [{ documentId: doc.document_id, result: { outputs: {} } }]; },
      }, doc, action, args),
      captureVisibleTab: async () => null, showNotification: async id => id,
    });
    const executor: BridgeActionExecutor = { execute: async req => {
      const outcome = await realExecutor.execute(req); finished(); return outcome;
    } };
    const command = { ...f.command, ...(target === 'reviewed document' ? { reviewed_document: document } : {}) };
    const store = vi.spyOn(f.cache, 'store');
    const dispatch = dispatchBridgeCommand(command, { ...f.deps, executor });
    await enteredScript;
    try {
      expect((await dispatch).result.status).toBe('timeout');
      release(); await executorFinished; await settled();
      expect((await f.reopen().inspectInFlight()).count).toBe(1);
      expect(store).toHaveBeenCalledOnce();
      await f.cache.clear();
      const retry = await dispatchBridgeCommand({ ...command, command_id: 'explicit-retry' }, { ...f.deps, executor, idempotency: f.reopen() });
      expect(retry.result.error?.code).toBe('delivery_uncertain');
      expect(scriptCalls).toBe(1);
    } finally { release(); }
  });

  it.each(['memory', 'IndexedDB'] as const)('records a late %s completion for explicit replay without changing the original timeout', async storage => {
    const f = await fixture(storage);
    const original = await dispatchBridgeCommand(f.command, f.deps);
    expect(original.result.status).toBe('timeout');
    expect(f.execute.mock.calls[0]![0].cancel.signalled).toBe(true);
    expect((await f.reopen().inspectInFlight()).count).toBe(1);
    const earlyRetry = await dispatchBridgeCommand({ ...f.command, command_id: 'retry-before-completion' }, f.deps);
    expect(earlyRetry.result.status).toBe('timeout');
    expect(earlyRetry.replayed_from_cache).toBe(true);

    // Clearing receipts and sweeping expiry cannot discard admission evidence.
    await f.cache.clear(); await f.cache.sweepExpired(Infinity);
    await f.cache.claim('independent', 'independent-key');
    f.setClock(1_750);
    f.resolve({ status: 'ok', outputs: { clicked: true } });
    await vi.waitFor(async () => expect((await f.reopen().inspectInFlight()).entries)
      .toEqual([{ command_id: 'independent', started_at: 1_000 }]));
    const replay = await dispatchBridgeCommand({ ...f.command, command_id: 'explicit-retry' },
      { ...f.deps, idempotency: f.reopen() });
    expect(replay).toMatchObject({ command_id: 'explicit-retry', replayed_from_cache: true,
      result: { command_id: 'explicit-retry', status: 'ok', outputs: { clicked: true }, duration_ms: 750,
        bridge_version: 'fixture-version', idempotency_key_seen: true } });
    expect((await f.reopen().lookup('original'))?.result).toMatchObject({ command_id: 'original', idempotency_key_seen: false });
    expect(original.result).toMatchObject({ status: 'timeout', outputs: undefined });
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it.each<ActionExecutorOutcome>([
    { status: 'error', error: { code: 'selector_not_found', message: 'Confirmed missing target' } },
    { status: 'rejected', error: { code: 'authority_invalid_grant_scope', message: 'Confirmed rejection' } },
  ])('also records a confirmed late $status', async outcome => {
    const f = await fixture('IndexedDB');
    await dispatchBridgeCommand(f.command, f.deps);
    f.resolve(outcome);
    await vi.waitFor(async () => expect((await f.reopen().inspectInFlight()).count).toBe(0));
    expect((await f.reopen().lookup('original'))?.result).toMatchObject(outcome);
  });

  it.each<ActionExecutorOutcome>([
    { status: 'cancelled' }, { status: 'timeout' },
    { status: 'error', error: { code: 'delivery_uncertain', message: 'Acknowledgement lost' } },
    { status: 'error', error: { code: 'mv3_lifecycle_killed', message: 'Worker interrupted' } },
  ])('keeps the marker when the late outcome is $status / $error.code', async outcome => {
    const f = await fixture('IndexedDB');
    const store = vi.spyOn(f.cache, 'store');
    await dispatchBridgeCommand(f.command, f.deps);
    f.resolve(outcome); await settled();
    expect((await f.reopen().inspectInFlight()).count).toBe(1);
    expect((await f.reopen().lookup('original'))?.result.status).toBe('timeout');
    expect(store).toHaveBeenCalledOnce();
  });

  it('consumes a late executor rejection without inventing a completion', async () => {
    const f = await fixture('IndexedDB');
    await dispatchBridgeCommand(f.command, f.deps);
    f.reject(new Error('Lost browser acknowledgement')); await settled();
    expect((await f.reopen().inspectInFlight()).count).toBe(1);
    expect((await f.reopen().lookup('original'))?.result.status).toBe('timeout');
  });

  it('waits for the initial timeout receipt before persisting a completion that arrives during that write', async () => {
    const f = await fixture();
    const store = f.cache.store.bind(f.cache);
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const writes: string[] = [];
    vi.spyOn(f.cache, 'store').mockImplementation(async (id, key, result) => {
      writes.push(result.status);
      if (result.status === 'timeout') { enter(); await held; }
      await store(id, key, result);
    });
    const dispatch = dispatchBridgeCommand(f.command, f.deps);
    try {
      await entered;
      f.resolve({ status: 'ok', outputs: { clicked: true } }); await settled();
      expect(writes).toEqual(['timeout']);
      expect(await f.cache.lookup('original')).toBeNull();
    } finally { release(); }
    expect((await dispatch).result.status).toBe('timeout');
    await vi.waitFor(async () => expect((await f.cache.lookup('original'))?.result.status).toBe('ok'));
    expect(writes).toEqual(['timeout', 'ok']);
    expect((await f.cache.inspectInFlight()).count).toBe(0);
  });

  it('keeps admission evidence and quarantines dispatch when the late receipt transaction aborts', async () => {
    const f = await fixture('IndexedDB');
    await dispatchBridgeCommand(f.command, f.deps);
    const put = IDBObjectStore.prototype.put;
    let aborted!: () => void;
    const abortObserved = new Promise<void>(resolve => { aborted = resolve; });
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === BRIDGE_RECEIPT_STORE_NAME) {
        request.addEventListener('success', () => this.transaction.abort());
        this.transaction.addEventListener('abort', aborted);
      }
      return request;
    });
    f.resolve({ status: 'ok', outputs: { clicked: true } });
    await abortObserved; await settled();
    await expect(f.cache.claim('retry', 'original-key')).rejects.toThrow('prior receipt write failed');
    expect((await f.reopen().inspectInFlight()).count).toBe(1);
    expect((await f.reopen().lookup('original'))?.result.status).toBe('timeout');
  });

  it('does not bypass an initial receipt failure when the executor later confirms completion', async () => {
    const f = await fixture('IndexedDB');
    const put = IDBObjectStore.prototype.put;
    const writeStatuses: string[] = [];
    const abort = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === BRIDGE_RECEIPT_STORE_NAME) {
        writeStatuses.push(value.result.status);
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    });
    await expect(dispatchBridgeCommand(f.command, f.deps)).rejects.toThrow();
    abort.mockRestore();
    f.resolve({ status: 'ok', outputs: { clicked: true } }); await settled();
    expect(writeStatuses).toEqual(['timeout']);
    expect((await f.reopen().inspectInFlight()).count).toBe(1);
    expect(await f.reopen().lookup('original')).toBeNull();
    await expect(f.cache.claim('retry', 'original-key')).rejects.toThrow('prior receipt write failed');
  });
});

// D-347 follow-up 19 — Keep signed in leaves the browser alone while a command runs (`keep-signed-in.ts`).
describe('whether a command is running, for Keep signed in', () => {
  it('counts a command as running until its executor settles, past its deadline too, then says when it ended', async () => {
    const f = await fixture();
    const before = bridgeCommandActivity.running;
    const answered = await dispatchBridgeCommand(f.command, f.deps);
    expect(answered.result.status).toBe('timeout');
    expect(bridgeCommandActivity.running).toBe(before + 1);
    f.setClock(5_000);
    f.resolve({ status: 'ok', outputs: { clicked: true } });
    await vi.waitFor(() => expect(bridgeCommandActivity.running).toBe(before));
    expect(bridgeCommandActivity.last_ended_at).toBe(5_000);
  });
});

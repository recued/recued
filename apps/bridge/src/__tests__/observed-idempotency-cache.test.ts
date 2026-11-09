import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { BRIDGE_IDEMPOTENCY_TTL_MS, type BridgeResult } from '@recued/contracts';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import { createIndexedDbIdempotencyCache } from '../idempotency/indexed-db-cache.js';
import { observeIdempotencyChanges } from '../idempotency/observed-cache.js';

const receipt = (status: BridgeResult['status'] = 'ok'): BridgeResult => ({ command_id: 'original', status,
  outputs: { secret: 'private-output' }, duration_ms: 1, bridge_version: 'fixture', idempotency_key_seen: false });
afterEach(() => vi.restoreAllMocks());

describe.each(['memory', 'IndexedDB'])('observed cache (%s)', storage => {
  const cache = (kind: string) => kind === 'memory' ? createInMemoryIdempotencyCache({ now: () => 500 })
    : createIndexedDbIdempotencyCache({ scope: { server_public_key: 'server', token_id: 'owner' }, indexedDB: new IDBFactory(), now: () => 500 });

  it('notifies mutations while leaving reads, replays and existing admissions silent', async () => {
    const underlying = cache(storage), changed = vi.fn(), observed = observeIdempotencyChanges(underlying, changed);
    expect((await observed.claim('original', 'private-key')).kind).toBe('claimed');
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await observed.claim('retry', 'private-key')).kind).toBe('in_flight');
    await observed.lookup('original'); await observed.lookupByIdempotencyKey('private-key'); await observed.list();
    await observed.inspectInFlight(); await observed.inspectReceipts(); await observed.inspectDiagnostics();
    expect(changed).toHaveBeenCalledTimes(1);
    await observed.store('original', 'private-key', receipt('timeout'));
    expect(changed).toHaveBeenCalledTimes(2);
    expect((await observed.claim('retry', 'private-key')).kind).toBe('completed');
    await observed.store('original', 'private-key', receipt());
    expect(changed).toHaveBeenCalledTimes(3);
    expect((await underlying.inspectInFlight()).count).toBe(0);
    await observed.sweepExpired(500); expect(changed).toHaveBeenCalledTimes(3);
    expect(await observed.sweepExpired(500 + BRIDGE_IDEMPOTENCY_TTL_MS)).toBe(1);
    expect(changed).toHaveBeenCalledTimes(4);
    await observed.clear(); expect(changed).toHaveBeenCalledTimes(5);
    expect(changed.mock.calls.every(args => args.length === 0)).toBe(true);
  });

  it('waits for the underlying admission promise before notifying', async () => {
    const underlying = cache(storage), claim = underlying.claim.bind(underlying), changed = vi.fn();
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    underlying.claim = async (id, key) => { const result = await claim(id, key); await held; return result; };
    const observed = observeIdempotencyChanges(underlying, changed);
    const pending = observed.claim('original', 'private-key');
    await underlying.inspectInFlight(); expect(changed).not.toHaveBeenCalled();
    release(); expect((await pending).kind).toBe('claimed');
    expect(changed).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['throw', 'reject', 'hang'])('does not hold up committed results when the observer fails by %s', async mode => {
    const underlying = cache(storage);
    const observed = observeIdempotencyChanges(underlying, () => {
      if (mode === 'throw') throw new Error('no receiver');
      if (mode === 'reject') return Promise.reject(new Error('no receiver'));
      return new Promise<void>(() => {});
    });
    expect((await observed.claim('original', 'private-key')).kind).toBe('claimed');
    await observed.store('original', 'private-key', receipt());
    expect((await underlying.lookup('original'))?.result.status).toBe('ok');
    expect((await underlying.inspectInFlight()).count).toBe(0);
  });
});

it.each(['claim', 'store'] as const)('does not notify when an IndexedDB %s transaction aborts', async operation => {
  const indexedDB = new IDBFactory(), scope = { server_public_key: 'server', token_id: 'owner' };
  const underlying = createIndexedDbIdempotencyCache({ scope, indexedDB }), changed = vi.fn();
  if (operation === 'store') await underlying.claim('original', 'private-key');
  const observed = observeIdempotencyChanges(underlying, changed);
  const method = operation === 'claim' ? 'add' : 'put';
  const write = IDBObjectStore.prototype[method];
  vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = write.call(this, value, key);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
  await expect(operation === 'claim' ? observed.claim('original', 'private-key')
    : observed.store('original', 'private-key', receipt())).rejects.toThrow();
  expect(changed).not.toHaveBeenCalled();
});

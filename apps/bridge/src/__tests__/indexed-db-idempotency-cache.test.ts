import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb';
import { BRIDGE_IDEMPOTENCY_TTL_MS, type BridgeResult } from '@recued/contracts';
import { createIndexedDbIdempotencyCache, BRIDGE_RECEIPT_DATABASE_NAME,
  BRIDGE_RECEIPT_STORE_NAME, BRIDGE_IN_FLIGHT_STORE_NAME } from '../idempotency/indexed-db-cache.js';
import { BRIDGE_IN_FLIGHT_INSPECTION_LIMIT, createInMemoryIdempotencyCache, type BridgeIdempotencyScope } from '../idempotency/cache.js';

const pair: BridgeIdempotencyScope = { server_public_key: 'server-a', token_id: 'client-a' };
const result = (command_id = 'cmd-1', status: BridgeResult['status'] = 'ok'): BridgeResult => ({
  command_id, status, outputs: { value: ['retained', 42] },
  ...(status === 'ok' ? {} : { error: { code: 'unknown', message: 'retained failure' } }),
  duration_ms: 17, bridge_version: 'original-version', idempotency_key_seen: false,
});

const fixture = () => {
  const indexedDB = new IDBFactory();
  let clock = 1_000;
  return { indexedDB, advance: (ms: number) => { clock += ms; },
    reopen: (scope = pair, onStored?: (at: number) => Promise<void> | void) =>
      createIndexedDbIdempotencyCache({ scope, indexedDB, now: () => clock,
        ...(onStored ? { onStored } : {}) }),
  };
};

/** Raw access is only for corrupt-data and rollback assertions, never the
 *  implementation under test's storage path. */
const withStore = async <T>(indexedDB: IDBFactory,
  run: (store: IDBObjectStore, set: (value: T) => void) => void,
  storeName = BRIDGE_RECEIPT_STORE_NAME): Promise<T> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(BRIDGE_RECEIPT_DATABASE_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      let value!: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error);
      run(tx.objectStore(storeName), next => { value = next; });
    });
  } finally { db.close(); }
};

afterEach(() => vi.restoreAllMocks());

describe('read-only in-flight inspection', () => {
  it.each(['memory', 'IndexedDB'])('projects unresolved %s identities without changing admission', async storage => {
    const f = fixture(); const memory = createInMemoryIdempotencyCache({ now: () => 1_000 });
    const reopen = storage === 'memory' ? () => memory : () => f.reopen();
    await reopen().claim('pending', 'private-retry-key');
    await reopen().store('finished', 'finished-key', result('finished'));
    const view = await reopen().inspectInFlight();
    expect(view).toEqual({ count: 1, entries: [{ command_id: 'pending', started_at: 1_000 }] });
    view.entries[0]!.command_id = 'mutated-view';
    await reopen().clear();
    expect((await reopen().claim('retry', 'private-retry-key')).kind).toBe('in_flight');
    expect(await reopen().inspectInFlight()).toEqual({ count: 1, entries: [{ command_id: 'pending', started_at: 1_000 }] });
    await reopen().store('pending', 'private-retry-key', result('pending'));
    expect(await reopen().inspectInFlight()).toEqual({ count: 0, entries: [] });
  });

  it('counts only its pair and bounds the IndexedDB read before projecting rows', async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: BRIDGE_IN_FLIGHT_INSPECTION_LIMIT + 5 }, (_, i) =>
      f.reopen().claim(`cmd-${String(i).padStart(3, '0')}`, `key-${i}`)));
    await f.reopen({ ...pair, token_id: 'other-pair' }).claim('other-command', 'other-key');
    const read = vi.spyOn(IDBIndex.prototype, 'getAll');
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const view = await f.reopen().inspectInFlight();
    expect(view.count).toBe(55);
    expect(view.entries).toHaveLength(50);
    expect(view.entries[0]?.command_id).toBe('cmd-000');
    expect(view.entries.at(-1)?.command_id).toBe('cmd-049');
    expect(read).toHaveBeenCalledWith(JSON.stringify([pair.server_public_key, pair.token_id]), 50);
    expect(transaction).toHaveBeenCalledWith([BRIDGE_RECEIPT_STORE_NAME, BRIDGE_IN_FLIGHT_STORE_NAME], 'readonly', {});
    expect((await f.reopen().claim('retry', 'key-54')).kind).toBe('in_flight');
  });

  it('keeps unresolved diagnostics available during a receipt-write quarantine', async () => {
    const f = fixture(), cache = f.reopen();
    await cache.claim('original', 'key');
    const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('receipt write failed'); });
    await expect(cache.store('original', 'key', result('original'))).rejects.toThrow('write failed');
    write.mockRestore();
    expect(await cache.inspectInFlight()).toEqual({ count: 1, entries: [{ command_id: 'original', started_at: 1_000 }] });
    await expect(cache.claim('retry', 'key')).rejects.toThrow('prior receipt write failed');
  });

  it('adds the v3 scope index without releasing v2 markers', async () => {
    const f = fixture();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = f.indexedDB.open(BRIDGE_RECEIPT_DATABASE_NAME, 2);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const receipts = request.result.createObjectStore(BRIDGE_RECEIPT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
        receipts.createIndex('by_scope', 'scope'); receipts.createIndex('by_key', ['scope', 'idempotency_key']);
        receipts.createIndex('by_expiry', 'expires_at');
        const pending = request.result.createObjectStore(BRIDGE_IN_FLIGHT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
        pending.createIndex('by_key', ['scope', 'idempotency_key'], { unique: true });
        pending.put({ scope: JSON.stringify([pair.server_public_key, pair.token_id]), command_id: 'v2-command',
          idempotency_key: 'v2-key', started_at: 500 });
      };
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    expect(await f.reopen().inspectInFlight()).toEqual({ count: 1, entries: [{ command_id: 'v2-command', started_at: 500 }] });
    expect((await f.reopen().claim('retry', 'v2-key')).kind).toBe('in_flight');
  });
});

describe('durable in-flight admission', () => {
  it.each(['delivery_uncertain', 'mv3_lifecycle_killed'] as const)('retains admission when a %s error receipt expires or is cleared', async code => {
    const f = fixture();
    await f.reopen().claim('original', 'same-key');
    await f.reopen().store('original', 'same-key', { ...result('original', 'error'),
      error: { code, message: 'Completion was not confirmed' } });
    f.advance(BRIDGE_IDEMPOTENCY_TTL_MS * 2);
    await f.reopen().sweepExpired(Infinity); await f.reopen().clear();
    expect((await f.reopen().claim('retry', 'same-key')).kind).toBe('in_flight');
  });

  it('admits exactly one contender across independent cache instances', async () => {
    const f = fixture();
    const claims = await Promise.all(['one', 'two', 'three'].map(id => f.reopen().claim(id, 'same-key')));
    const admitted = claims.find(claim => claim.kind === 'claimed');
    expect(claims.filter(claim => claim.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter(claim => claim.kind === 'in_flight')).toHaveLength(2);
    expect(new Set(claims.map(claim => claim.entry.command_id))).toEqual(new Set([admitted!.entry.command_id]));
  });

  it('retains an unresolved marker after recreation, receipt expiry, and cache clearing', async () => {
    const f = fixture();
    const admitted = await f.reopen().claim('original', 'same-key');
    f.advance(BRIDGE_IDEMPOTENCY_TTL_MS * 2);
    expect(await f.reopen().sweepExpired(Infinity)).toBe(0);
    await f.reopen().clear();
    expect(await f.reopen().claim('retry', 'same-key')).toEqual({ kind: 'in_flight', entry: admitted.entry });
    expect(await f.reopen().claim('original', 'different-key')).toEqual({ kind: 'in_flight', entry: admitted.entry });
  });

  it('isolates unresolved markers by server identity and client token', async () => {
    const f = fixture();
    await f.reopen().claim('same-command', 'same-key');
    for (const scope of [{ ...pair, token_id: 'other-token' }, { ...pair, server_public_key: 'other-server' }]) {
      expect((await f.reopen(scope).claim('same-command', 'same-key')).kind).toBe('claimed');
    }
    expect((await f.reopen().claim('same-command', 'same-key')).kind).toBe('in_flight');
  });

  it.each<BridgeResult['status']>(['ok', 'error', 'rejected', 'timeout', 'cancelled'])(
    'retires admission only when a %s receipt confirms a terminal outcome', async status => {
      const f = fixture();
      await f.reopen().claim('original', 'same-key');
      await f.reopen().store('original', 'same-key', result('original', status));
      expect((await f.reopen().claim('retry', 'same-key')).kind).toBe('completed');
      f.advance(BRIDGE_IDEMPOTENCY_TTL_MS);
      expect((await f.reopen().claim('retry', 'same-key')).kind)
        .toBe(status === 'timeout' || status === 'cancelled' ? 'in_flight' : 'claimed');
    });

  it('accepts a separately verified completion for the original marker', async () => {
    const f = fixture();
    await f.reopen().claim('original', 'same-key');
    await f.reopen().store('original', 'same-key', result('original', 'timeout'));
    await f.reopen().clear();
    expect((await f.reopen().claim('retry', 'same-key')).kind).toBe('in_flight');
    await f.reopen().store('original', 'same-key', result('original', 'ok'));
    const replay = await f.reopen().claim('retry', 'same-key');
    expect(replay).toMatchObject({ kind: 'completed', entry: { result: { status: 'ok' } } });
  });

  it.each([['other-command', 'same-key'], ['original', 'other-key']])(
    'refuses a mismatched completion (%s, %s)', async (command_id, key) => {
      const f = fixture();
      await f.reopen().claim('original', 'same-key');
      await expect(f.reopen().store(command_id, key, result(command_id))).rejects.toThrow('another command');
      expect((await f.reopen().claim('retry', 'same-key')).kind).toBe('in_flight');
    });

  it('rolls back both receipt insertion and marker removal when completion aborts', async () => {
    const f = fixture();
    await f.reopen().claim('original', 'same-key');
    const remove = IDBObjectStore.prototype.delete;
    const abort = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = remove.call(this, key);
      if (this.name === BRIDGE_IN_FLIGHT_STORE_NAME) request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(f.reopen().store('original', 'same-key', result('original'))).rejects.toThrow();
    abort.mockRestore();
    expect(await f.reopen().lookup('original')).toBeNull();
    expect((await f.reopen().claim('retry', 'same-key')).kind).toBe('in_flight');
  });

  it('does not reinterpret a malformed marker as permission to execute', async () => {
    const f = fixture();
    await f.reopen().lookup('absent');
    await withStore<void>(f.indexedDB, (store, done) => {
      store.put({ scope: JSON.stringify([pair.server_public_key, pair.token_id]),
        command_id: 'original', idempotency_key: 'same-key', started_at: 'corrupt' });
      done(undefined);
    }, BRIDGE_IN_FLIGHT_STORE_NAME);
    await expect(f.reopen().claim('retry', 'same-key')).rejects.toThrow('invalid in-flight marker');
  });

  it('upgrades a v1 receipt database without losing its completed results', async () => {
    const f = fixture();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = f.indexedDB.open(BRIDGE_RECEIPT_DATABASE_NAME, 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(BRIDGE_RECEIPT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
        store.createIndex('by_scope', 'scope'); store.createIndex('by_key', ['scope', 'idempotency_key']);
        store.createIndex('by_expiry', 'expires_at');
        store.put({ scope: JSON.stringify([pair.server_public_key, pair.token_id]), command_id: 'old',
          idempotency_key: 'old-key', result: result('old'), stored_at: 1_000,
          expires_at: 1_000 + BRIDGE_IDEMPOTENCY_TTL_MS });
      };
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    expect(await f.reopen().claim('retry', 'old-key')).toMatchObject({ kind: 'completed', entry: { command_id: 'old' } });
    expect((await f.reopen().claim('new', 'new-key')).kind).toBe('claimed');
    expect(await f.indexedDB.databases()).toEqual([{ name: BRIDGE_RECEIPT_DATABASE_NAME, version: 5 }]);
  });
});

describe('durable completed bridge receipts', () => {
  it.each<BridgeResult['status']>(['ok', 'error', 'rejected', 'cancelled', 'timeout'])(
    'retains an entire %s receipt through fresh cache instances', async status => {
      const f = fixture(); const original = result('cmd-1', status);
      await f.reopen().store('cmd-1', 'key-1', original);
      // Mutating either the caller's object or a read result cannot rewrite
      // the canonical receipt: IndexedDB uses structured clones.
      original.duration_ms = 999;
      const fresh = f.reopen();
      const receipt = await fresh.lookup('cmd-1');
      expect(receipt).toEqual({ command_id: 'cmd-1', idempotency_key: 'key-1',
        result: result('cmd-1', status), stored_at: 1_000, expires_at: 1_000 + BRIDGE_IDEMPOTENCY_TTL_MS });
      receipt!.result.duration_ms = 123;
      expect((await f.reopen().lookupByIdempotencyKey('key-1'))?.result).toEqual(result('cmd-1', status));
    });

  it('isolates identical command and retry keys by server identity and client token', async () => {
    const f = fixture();
    const otherToken = { ...pair, token_id: 'client-b' };
    const otherServer = { ...pair, server_public_key: 'server-b' };
    await f.reopen().store('cmd-1', 'key-1', result());
    for (const scope of [otherToken, otherServer]) {
      expect(await f.reopen(scope).lookup('cmd-1')).toBeNull();
      expect(await f.reopen(scope).lookupByIdempotencyKey('key-1')).toBeNull();
      expect(await f.reopen(scope).list()).toEqual([]);
      await f.reopen(scope).store('cmd-1', 'key-1', { ...result(), outputs: { owner: scope } });
    }
    await f.reopen().clear();
    expect(await f.reopen().list()).toEqual([]);
    for (const scope of [otherToken, otherServer]) {
      expect((await f.reopen(scope).lookup('cmd-1'))?.result.outputs).toEqual({ owner: scope });
    }
  });

  it('expires at the exact TTL boundary and removes both lookup paths', async () => {
    const f = fixture();
    await f.reopen().store('by-command', 'key-c', result('by-command'));
    await f.reopen().store('by-key', 'key-k', result('by-key'));
    f.advance(BRIDGE_IDEMPOTENCY_TTL_MS - 1);
    expect(await f.reopen().lookup('by-command')).not.toBeNull();
    f.advance(1);
    expect(await f.reopen().lookup('by-command')).toBeNull();
    expect(await f.reopen().lookupByIdempotencyKey('key-k')).toBeNull();
    expect(await f.reopen().lookupByIdempotencyKey('key-c')).toBeNull();
    expect(await f.reopen().list()).toEqual([]);
    expect(await f.reopen().sweepExpired(Infinity)).toBe(0);
  });

  it.each(['retry lookup', 'inspector list'] as const)(
    'checks expiry when a queued %s cursor reads the row', async method => {
      const f = fixture();
      await f.reopen().store('cmd-1', 'key-1', result());
      const openCursor = IDBIndex.prototype.openCursor;
      const delayedRead = vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (this: IDBIndex, query, direction) {
        const request = openCursor.call(this, query, direction);
        // Model a cursor queued before expiry whose storage read completes
        // after the boundary. The actual IndexedDB request still runs.
        request.addEventListener('success', () => f.advance(BRIDGE_IDEMPOTENCY_TTL_MS), { once: true });
        return request;
      });
      const found = method === 'retry lookup' ? await f.reopen().lookupByIdempotencyKey('key-1') : await f.reopen().list();
      delayedRead.mockRestore();
      expect(found).toEqual(method === 'retry lookup' ? null : []);
      expect(await f.reopen().sweepExpired(Infinity)).toBe(0);
    });

  it('skips expired duplicate retry keys and updates the index when a command is overwritten', async () => {
    const f = fixture();
    await f.reopen().store('a-expired', 'shared', result('a-expired'));
    f.advance(100);
    await f.reopen().store('z-fresh', 'shared', result('z-fresh'));
    f.advance(BRIDGE_IDEMPOTENCY_TTL_MS - 100);
    expect((await f.reopen().lookupByIdempotencyKey('shared'))?.command_id).toBe('z-fresh');
    await f.reopen().store('z-fresh', 'replacement', result('z-fresh'));
    expect(await f.reopen().lookupByIdempotencyKey('shared')).toBeNull();
    expect((await f.reopen().lookupByIdempotencyKey('replacement'))?.command_id).toBe('z-fresh');
  });

  it('filters expired inspector entries and sweeps abandoned pair namespaces', async () => {
    const f = fixture();
    const orphan = { ...pair, token_id: 'old-client' };
    await f.reopen().store('expired', 'expired', result('expired'));
    await f.reopen(orphan).store('orphan', 'orphan', result('orphan'));
    f.advance(10);
    await f.reopen().store('fresh', 'fresh', result('fresh'));
    f.advance(BRIDGE_IDEMPOTENCY_TTL_MS - 10);
    expect((await f.reopen().list()).map(entry => entry.command_id)).toEqual(['fresh']);
    expect(await f.reopen().sweepExpired(1_000 + BRIDGE_IDEMPOTENCY_TTL_MS)).toBe(1);
    expect(await f.reopen(orphan).list()).toEqual([]);
    expect((await f.reopen().list()).map(entry => entry.command_id)).toEqual(['fresh']);
  });

  it('waits for transaction completion rather than the put request success', async () => {
    const f = fixture();
    let settled = false; let sawRequest = false; let committed = false;
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => {
        sawRequest = true;
        expect(settled).toBe(false);
      });
      this.transaction.addEventListener('complete', () => { committed = true; });
      return request;
    });
    await f.reopen().store('cmd-1', 'key-1', result()).then(() => { settled = true; });
    expect({ sawRequest, committed, settled }).toEqual({ sawRequest: true, committed: true, settled: true });
    expect(await f.reopen().lookup('cmd-1')).not.toBeNull();
  });

  it('rejects an abort after put success, rolls back, and refuses another dispatch until explicitly cleared', async () => {
    const f = fixture(); const cache = f.reopen();
    const put = IDBObjectStore.prototype.put;
    const injected = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(cache.store('cmd-1', 'key-1', result())).rejects.toThrow();
    injected.mockRestore();
    expect(await f.reopen().lookup('cmd-1')).toBeNull(); // No committed receipt exists.
    await expect(cache.lookup('cmd-1')).rejects.toThrow('prior receipt write failed');
    await expect(cache.lookupByIdempotencyKey('key-1')).rejects.toThrow('prior receipt write failed');
    await expect(cache.store('cmd-2', 'key-2', result('cmd-2'))).rejects.toThrow('prior receipt write failed');
    await cache.clear();
    await cache.store('cmd-2', 'key-2', result('cmd-2'));
    expect(await cache.lookup('cmd-2')).not.toBeNull();
  });

  it('propagates database and transaction failures instead of returning a miss', async () => {
    const f = fixture();
    const open = vi.spyOn(f.indexedDB, 'open').mockImplementation(() => { throw new Error('storage offline'); });
    await expect(f.reopen().lookup('cmd-1')).rejects.toThrow('storage offline');
    open.mockRestore();
    await f.reopen().store('cmd-1', 'key-1', result());
    const getOriginal = IDBObjectStore.prototype.get;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = getOriginal.call(this, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(f.reopen().lookup('cmd-1')).rejects.toThrow();
    get.mockRestore();
    expect(await f.reopen().lookup('cmd-1')).not.toBeNull();
  });

  it('refuses malformed stored evidence instead of allowing re-execution', async () => {
    const f = fixture();
    await f.reopen().store('cmd-1', 'key-1', result());
    await withStore<void>(f.indexedDB, (store, set) => {
      const request = store.get([JSON.stringify([pair.server_public_key, pair.token_id]), 'cmd-1']);
      request.onsuccess = () => { store.put({ ...request.result, result: { status: 'ok' } }); set(undefined); };
    });
    await expect(f.reopen().lookup('cmd-1')).rejects.toThrow('invalid stored receipt');
    await expect(f.reopen().lookupByIdempotencyKey('key-1')).rejects.toThrow('invalid stored receipt');
  });

  it('does not hold a committed receipt while ancillary metadata is still pending', async () => {
    const f = fixture();
    let entered!: () => void; let release!: () => void; let settled = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const stored = f.reopen(pair, () => { entered(); return held; })
      .store('cmd-1', 'key-1', result()).then(() => { settled = true; });
    try {
      await started;
      await Promise.resolve();
      expect(settled).toBe(true);
      expect(await f.reopen().lookup('cmd-1')).not.toBeNull();
    } finally { release(); await stored; }
  });

  it('publishes ancillary metadata after commit and retains the receipt if metadata fails', async () => {
    const f = fixture();
    let observed: { at: number; command_id: string | undefined } | undefined;
    const onStored = vi.fn(async (at: number) => {
      const receipt = await f.reopen().lookup('cmd-1');
      observed = { at, command_id: receipt?.command_id };
      throw new Error('chrome.storage unavailable');
    });
    await expect(f.reopen(pair, onStored).store('cmd-1', 'key-1', result())).resolves.toBeUndefined();
    expect(onStored).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(observed).toEqual({ at: 1_000, command_id: 'cmd-1' }));
    expect(await f.reopen().lookupByIdempotencyKey('key-1')).not.toBeNull();
  });
});

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBCursor, IDBDatabase, IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb';
import { BRIDGE_IDEMPOTENCY_TTL_MS, type BridgeErrorCode, type BridgeResult } from '@recued/contracts';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import { BRIDGE_IN_FLIGHT_STORE_NAME, BRIDGE_RECEIPT_DATABASE_NAME, BRIDGE_RECEIPT_STORE_NAME,
  createIndexedDbIdempotencyCache } from '../idempotency/indexed-db-cache.js';

const scope = { server_public_key: 'server', token_id: 'owner' };
const receipt = (command_id: string, status: BridgeResult['status'] = 'ok',
  code: NonNullable<BridgeResult['error']>['code'] = 'unknown'): BridgeResult => ({
  command_id, status, duration_ms: 5, bridge_version: 'fixture', idempotency_key_seen: false,
  outputs: { secret: 'private-output' }, error: { code, message: 'private-error-message' },
});
const fixture = (storage: string) => {
  let clock = 1_000;
  const indexedDB = new IDBFactory(), memory = createInMemoryIdempotencyCache({ now: () => clock });
  return { indexedDB, advance: (ms: number) => { clock += ms; },
    cache: (pair = scope) => storage === 'memory' ? memory
      : createIndexedDbIdempotencyCache({ scope: pair, indexedDB, now: () => clock }) };
};
afterEach(() => vi.restoreAllMocks());

describe.each(['memory', 'IndexedDB'])('confirmed receipt inspection (%s)', storage => {
  it('projects definitive outcomes and leaves uncertain admissions alone', async () => {
    const f = fixture(storage);
    for (const [id, status, code] of [
      ['ok', 'ok', 'unknown'], ['error', 'error', 'unknown'], ['rejected', 'rejected', 'authority_invalid_grant_scope'],
      ['timeout', 'timeout', 'unknown'], ['cancelled', 'cancelled', 'unknown'],
      ['uncertain', 'error', 'delivery_uncertain'], ['interrupted', 'error', 'mv3_lifecycle_killed'],
    ] as const) {
      await f.cache().claim(id, `private-${id}`);
      await f.cache().store(id, `private-${id}`, receipt(id, status, code));
      f.advance(1);
    }
    const view = await f.cache().inspectReceipts();
    expect(view).toEqual({ count: 7, confirmed: { count: 3, entries: [
      { command_id: 'rejected', status: 'rejected', stored_at: 1_002, error_code: 'authority_invalid_grant_scope' },
      { command_id: 'error', status: 'error', stored_at: 1_001, error_code: 'unknown' },
      { command_id: 'ok', status: 'ok', stored_at: 1_000 },
    ] } });
    expect(JSON.stringify(view)).not.toContain('private-');
    view.confirmed.entries[0]!.command_id = 'mutated-view';
    expect((await f.cache().lookup('rejected'))?.command_id).toBe('rejected');
    expect((await f.cache().inspectInFlight()).count).toBe(4);
    expect((await f.cache().claim('retry', 'private-uncertain')).kind).toBe('completed');
    await f.cache().clear();
    expect(await f.cache().inspectReceipts()).toEqual({ count: 0, confirmed: { count: 0, entries: [] } });
    expect((await f.cache().claim('retry', 'private-uncertain')).kind).toBe('in_flight');
  });

  it('projects known failure codes without exposing unknown codes or error payloads', async () => {
    const f = fixture(storage);
    await f.cache().store('known', 'private-known', receipt('known', 'error', 'selector_not_found'));
    await f.cache().store('future', 'private-future', receipt('future', 'error', 'private-future-code' as BridgeErrorCode));
    const missing = receipt('missing', 'rejected'); delete missing.error;
    await f.cache().store('missing', 'private-missing', missing);
    await f.cache().store('successful', 'private-ok', receipt('successful', 'ok', 'selector_not_found'));
    const view = await f.cache().inspectDiagnostics();
    expect(view.receipts?.confirmed.entries).toEqual([
      { command_id: 'successful', status: 'ok', stored_at: 1_000 },
      { command_id: 'missing', status: 'rejected', stored_at: 1_000 },
      { command_id: 'known', status: 'error', stored_at: 1_000, error_code: 'selector_not_found' },
      { command_id: 'future', status: 'error', stored_at: 1_000 },
    ]);
    expect(JSON.stringify(view)).not.toContain('private-');
    expect((await f.cache().lookup('future'))?.result.error?.code).toBe('private-future-code');
  });

  it('bounds the list at 50 and orders ties by descending command ID', async () => {
    const f = fixture(storage);
    for (let i = 0; i < 55; i++) {
      const id = `command-${String(i).padStart(3, '0')}`;
      await f.cache().store(id, `key-${i}`, receipt(id));
    }
    f.advance(1);
    for (let i = 0; i < 100; i++) {
      await f.cache().store(`timeout-${i}`, `pending-key-${i}`, receipt(`timeout-${i}`, 'timeout'));
    }
    const continueRead = vi.spyOn(IDBCursor.prototype, 'continue');
    const view = await f.cache().inspectReceipts();
    expect(view.count).toBe(155); expect(view.confirmed.count).toBe(55);
    expect(view.confirmed.entries).toHaveLength(50);
    expect(view.confirmed.entries[0]?.command_id).toBe('command-054');
    expect(view.confirmed.entries.at(-1)?.command_id).toBe('command-005');
    if (storage === 'IndexedDB') expect(continueRead).toHaveBeenCalledTimes(49);
  });

  it('excludes TTL-boundary receipts without sweeping or deleting them on inspection', async () => {
    const f = fixture(storage);
    await f.cache().store('expired', 'expired-key', receipt('expired'));
    f.advance(1);
    await f.cache().store('live', 'live-key', receipt('live'));
    await f.cache().store('unconfirmed', 'pending-key', receipt('unconfirmed', 'cancelled'));
    f.advance(BRIDGE_IDEMPOTENCY_TTL_MS - 1);
    expect(await f.cache().inspectReceipts()).toEqual({ count: 2, confirmed: { count: 1,
      entries: [{ command_id: 'live', status: 'ok', stored_at: 1_001 }] } });
    expect(await f.cache().sweepExpired(1_000 + BRIDGE_IDEMPOTENCY_TTL_MS)).toBe(1);
  });

  it('moves a late known completion into recent outcomes without duplicating its timeout', async () => {
    const f = fixture(storage);
    await f.cache().claim('late', 'key');
    await f.cache().store('late', 'key', receipt('late', 'timeout'));
    expect((await f.cache().inspectReceipts()).confirmed.count).toBe(0);
    f.advance(100);
    await f.cache().store('late', 'key', receipt('late'));
    expect(await f.cache().inspectReceipts()).toEqual({ count: 1, confirmed: { count: 1,
      entries: [{ command_id: 'late', status: 'ok', stored_at: 1_100 }] } });
    expect((await f.cache().inspectInFlight()).count).toBe(0);
  });
});

describe('IndexedDB metadata inspection', () => {
  it.each(['inspectReceipts', 'inspectDiagnostics'] as const)('%s evaluates expiry after storage opens', async method => {
    const f = fixture('IndexedDB');
    await f.cache().store('expired-during-open', 'private-key', receipt('expired-during-open'));
    const open = f.indexedDB.open.bind(f.indexedDB);
    vi.spyOn(f.indexedDB, 'open').mockImplementation((name, version) => {
      const request = open(name, version);
      request.addEventListener('success', () => f.advance(BRIDGE_IDEMPOTENCY_TTL_MS));
      return request;
    });
    const empty = { count: 0, confirmed: { count: 0, entries: [] } };
    expect(await f.cache()[method]()).toEqual(method === 'inspectReceipts' ? empty
      : { receipts: empty, in_flight: { count: 0, entries: [] } });
  });

  it.each(['inspectReceipts', 'inspectDiagnostics'] as const)('%s evaluates expiry after its queued read starts', async method => {
    const f = fixture('IndexedDB');
    await f.cache().store('expired-while-queued', 'private-key', receipt('expired-while-queued'));
    const count = IDBIndex.prototype.count;
    vi.spyOn(IDBIndex.prototype, 'count').mockImplementation(function (this: IDBIndex, range) {
      const request = count.call(this, range);
      if (this.objectStore.name === BRIDGE_RECEIPT_STORE_NAME && this.name === 'by_scope') {
        request.addEventListener('success', () => f.advance(BRIDGE_IDEMPOTENCY_TTL_MS));
      }
      return request;
    });
    const empty = { count: 0, confirmed: { count: 0, entries: [] } };
    expect(await f.cache()[method]()).toEqual(method === 'inspectReceipts' ? empty
      : { receipts: empty, in_flight: { count: 0, entries: [] } });
  });

  it('captures bounded receipt and marker metadata in one read-only transaction', async () => {
    const f = fixture('IndexedDB');
    for (let i = 0; i < 55; i++) {
      await f.cache().claim(`pending-${i}`, `private-pending-${i}`);
      await f.cache().store(`finished-${i}`, `private-finished-${i}`, receipt(`finished-${i}`));
    }
    const tx = vi.spyOn(IDBDatabase.prototype, 'transaction'), read = vi.spyOn(IDBIndex.prototype, 'getAll');
    const values = vi.spyOn(IDBIndex.prototype, 'openCursor'), get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const view = await f.cache().inspectDiagnostics();
    expect(view.receipts?.count).toBe(55); expect(view.receipts?.confirmed.entries).toHaveLength(50);
    expect(view.in_flight?.count).toBe(55); expect(view.in_flight?.entries).toHaveLength(50);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(tx).toHaveBeenCalledWith([BRIDGE_RECEIPT_STORE_NAME, BRIDGE_IN_FLIGHT_STORE_NAME], 'readonly', {});
    expect(read).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledWith(JSON.stringify(['server', 'owner']), 50);
    expect(values).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toContain('private-');
  });

  it('keeps a concurrent confirmed completion outside the entire inspection snapshot', async () => {
    const f = fixture('IndexedDB');
    await f.cache().claim('late', 'private-key');
    let completion: Promise<void> | undefined;
    const getAll = IDBIndex.prototype.getAll;
    vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, range, limit) {
      const request = getAll.call(this, range, limit);
      if (this.objectStore.name === BRIDGE_IN_FLIGHT_STORE_NAME) request.addEventListener('success', () => {
        if (!completion) completion = f.cache().store('late', 'private-key', receipt('late'));
      });
      return request;
    });
    const before = await f.cache().inspectDiagnostics();
    expect(before).toEqual({ receipts: { count: 0, confirmed: { count: 0, entries: [] } },
      in_flight: { count: 1, entries: [{ command_id: 'late', started_at: 1_000 }] } });
    expect(completion).toBeDefined(); await completion;
    expect(await f.cache().inspectDiagnostics()).toEqual({ receipts: { count: 1, confirmed: { count: 1,
      entries: [{ command_id: 'late', status: 'ok', stored_at: 1_000 }] } }, in_flight: { count: 0, entries: [] } });
  });

  it.each(['receipt', 'marker'])('preserves the other diagnostic section when a %s row is corrupt', async kind => {
    const f = fixture('IndexedDB');
    await f.cache().claim('pending', 'private-key');
    await f.cache().store('finished', 'finished-key', receipt('finished'));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = f.indexedDB.open(BRIDGE_RECEIPT_DATABASE_NAME);
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const store = kind === 'receipt' ? BRIDGE_RECEIPT_STORE_NAME : BRIDGE_IN_FLIGHT_STORE_NAME;
        const tx = db.transaction(store, 'readwrite');
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        tx.objectStore(store).put({ scope: JSON.stringify(['server', 'owner']),
          ...(kind === 'receipt' ? { command_id: 'corrupt-receipt', idempotency_key: 'corrupt-key' }
            : { command_id: 'pending', idempotency_key: 'private-key', started_at: 'corrupt' }) });
      });
    } finally { db.close(); }
    const snapshot = await f.cache().inspectDiagnostics();
    if (kind === 'receipt') {
      expect(snapshot).toEqual({ receipts: null,
        in_flight: { count: 1, entries: [{ command_id: 'pending', started_at: 1_000 }] } });
      expect((await f.cache().claim('retry', 'private-key')).kind).toBe('in_flight');
    } else {
      expect(snapshot).toEqual({ receipts: { count: 1, confirmed: { count: 1,
        entries: [{ command_id: 'finished', status: 'ok', stored_at: 1_000 }] } }, in_flight: null });
      await expect(f.cache().claim('retry', 'private-key')).rejects.toThrow('invalid in-flight marker');
    }
  });

  it('uses only bounded key cursors and counts, in one read-only transaction for the selected pair', async () => {
    const f = fixture('IndexedDB');
    for (const [server_public_key, token_id] of [['server', 'owner'], ['server', 'other'], ['other', 'owner']]) {
      await f.cache({ server_public_key, token_id }).store('same-id', 'private-key', receipt('same-id'));
    }
    const get = vi.spyOn(IDBObjectStore.prototype, 'get'), all = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const storeCursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    const indexAll = vi.spyOn(IDBIndex.prototype, 'getAll'), valueCursor = vi.spyOn(IDBIndex.prototype, 'openCursor');
    const keys = vi.spyOn(IDBIndex.prototype, 'openKeyCursor'), tx = vi.spyOn(IDBDatabase.prototype, 'transaction');
    expect((await f.cache().inspectReceipts()).confirmed.entries).toEqual([{ command_id: 'same-id', status: 'ok', stored_at: 1_000 }]);
    expect(get).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled(); expect(indexAll).not.toHaveBeenCalled();
    expect(storeCursor).not.toHaveBeenCalled(); expect(valueCursor).not.toHaveBeenCalled();
    expect(keys).toHaveBeenCalledTimes(1); expect(keys.mock.calls[0]?.[1]).toBe('prev');
    expect(tx).toHaveBeenCalledTimes(1);
    expect(tx).toHaveBeenCalledWith([BRIDGE_RECEIPT_STORE_NAME, BRIDGE_IN_FLIGHT_STORE_NAME], 'readonly', {});
  });

  it('keeps the view available after a failed receipt write without clearing quarantine or admission', async () => {
    const f = fixture('IndexedDB'), cache = f.cache();
    await cache.store('finished', 'finished-key', receipt('finished'));
    await cache.claim('unresolved', 'unresolved-key');
    const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('disk failed'); });
    await expect(cache.store('unresolved', 'unresolved-key', receipt('unresolved'))).rejects.toThrow('disk failed');
    fail.mockRestore();
    expect((await cache.inspectReceipts()).confirmed.entries.map(entry => entry.command_id)).toEqual(['finished']);
    const snapshot = await cache.inspectDiagnostics();
    expect(snapshot.receipts?.confirmed.entries.map(entry => entry.command_id)).toEqual(['finished']);
    expect(snapshot.in_flight?.count).toBe(1);
    await expect(cache.claim('retry', 'unresolved-key')).rejects.toThrow('prior receipt write failed');
    expect((await f.cache().inspectInFlight()).count).toBe(1);
  });

  it.each(['inspectReceipts', 'inspectDiagnostics'] as const)('%s does not publish an aborted transaction', async method => {
    const f = fixture('IndexedDB');
    await f.cache().store('finished', 'key', receipt('finished'));
    const count = IDBIndex.prototype.count;
    vi.spyOn(IDBIndex.prototype, 'count').mockImplementation(function (this: IDBIndex, range) {
      const request = count.call(this, range);
      request.addEventListener('success', () => this.objectStore.transaction.abort());
      return request;
    });
    await expect(f.cache()[method]()).rejects.toThrow();
  });

  it('upgrades v3 receipts in place while preserving unresolved markers and corrupt rows', async () => {
    const f = fixture('IndexedDB'), namespace = JSON.stringify([scope.server_public_key, scope.token_id]);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = f.indexedDB.open(BRIDGE_RECEIPT_DATABASE_NAME, 3);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(BRIDGE_RECEIPT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
        store.createIndex('by_scope', 'scope'); store.createIndex('by_key', ['scope', 'idempotency_key']);
        store.createIndex('by_expiry', 'expires_at');
        for (const status of ['ok', 'timeout'] as const) store.put({ scope: namespace, command_id: status,
          idempotency_key: `key-${status}`, result: receipt(status, status), stored_at: 500,
          expires_at: 500 + BRIDGE_IDEMPOTENCY_TTL_MS });
        store.put({ scope: JSON.stringify(['other', 'corrupt']), command_id: 'broken', idempotency_key: 'broken-key' });
        const pending = request.result.createObjectStore(BRIDGE_IN_FLIGHT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
        pending.createIndex('by_scope', 'scope'); pending.createIndex('by_key', ['scope', 'idempotency_key'], { unique: true });
        pending.put({ scope: namespace, command_id: 'timeout', idempotency_key: 'key-timeout', started_at: 400 });
      };
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    expect(await f.cache().inspectReceipts()).toEqual({ count: 2, confirmed: { count: 1,
      entries: [{ command_id: 'ok', status: 'ok', stored_at: 500 }] } });
    expect((await f.cache().lookup('ok'))?.result).toEqual(receipt('ok'));
    await expect(f.cache({ server_public_key: 'other', token_id: 'corrupt' }).inspectReceipts()).rejects.toThrow('metadata');
    await expect(f.cache({ server_public_key: 'other', token_id: 'corrupt' }).lookup('broken')).rejects.toThrow('invalid stored receipt');
    await f.cache().clear();
    expect((await f.cache().claim('retry', 'key-timeout')).kind).toBe('in_flight');
    expect(await f.indexedDB.databases()).toEqual([{ name: BRIDGE_RECEIPT_DATABASE_NAME, version: 5 }]);
  });

  it.each([false, true])('backfills v4 error metadata while preserving receipts, uncertain admissions and read bounds (aborted first: %s)', async abortFirst => {
    const f = fixture('IndexedDB'), namespace = JSON.stringify([scope.server_public_key, scope.token_id]);
    const saved = [receipt('known', 'error', 'selector_not_found'), receipt('rejected', 'rejected', 'authority_invalid_grant_scope'),
      receipt('future', 'error', 'private-future-code' as BridgeErrorCode), receipt('uncertain', 'error', 'delivery_uncertain')];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = f.indexedDB.open(BRIDGE_RECEIPT_DATABASE_NAME, 4);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(BRIDGE_RECEIPT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
        store.createIndex('by_scope', 'scope'); store.createIndex('by_key', ['scope', 'idempotency_key']);
        store.createIndex('by_expiry', 'expires_at');
        store.createIndex('by_confirmation', ['scope', 'confirmation', 'stored_at', 'command_id', 'result.status']);
        for (const result of saved) store.put({ scope: namespace, command_id: result.command_id,
          idempotency_key: `private-${result.command_id}`, result, stored_at: 500, expires_at: 500 + BRIDGE_IDEMPOTENCY_TTL_MS,
          confirmation: result.command_id === 'uncertain' ? 0 : 1 });
        const pending = request.result.createObjectStore(BRIDGE_IN_FLIGHT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
        pending.createIndex('by_scope', 'scope'); pending.createIndex('by_key', ['scope', 'idempotency_key'], { unique: true });
        pending.put({ scope: namespace, command_id: 'uncertain', idempotency_key: 'private-uncertain', started_at: 400 });
      };
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    if (abortFirst) {
      const update = IDBCursor.prototype.update;
      const interrupted = vi.spyOn(IDBCursor.prototype, 'update').mockImplementation(function (this: IDBCursor, value) {
        const request = update.call(this, value);
        if (this.source instanceof IDBObjectStore && this.source.transaction.mode === 'versionchange') {
          const tx = this.source.transaction;
          request.addEventListener('success', () => tx.abort(), { once: true });
        }
        return request;
      });
      await expect(f.cache().inspectReceipts()).rejects.toThrow();
      expect(interrupted).toHaveBeenCalled(); interrupted.mockRestore();
      const original = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = f.indexedDB.open(BRIDGE_RECEIPT_DATABASE_NAME);
        request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
      });
      try {
        expect(original.version).toBe(4);
        await new Promise<void>((resolve, reject) => {
          const tx = original.transaction([BRIDGE_RECEIPT_STORE_NAME, BRIDGE_IN_FLIGHT_STORE_NAME], 'readonly');
          const store = tx.objectStore(BRIDGE_RECEIPT_STORE_NAME);
          expect(store.index('by_confirmation').keyPath).toEqual(['scope', 'confirmation', 'stored_at', 'command_id', 'result.status']);
          const rows = store.getAll(), markers = tx.objectStore(BRIDGE_IN_FLIGHT_STORE_NAME).getAll();
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            try {
              expect(rows.result).toEqual(saved.map(result => ({ scope: namespace, command_id: result.command_id,
                idempotency_key: `private-${result.command_id}`, result, stored_at: 500, expires_at: 500 + BRIDGE_IDEMPOTENCY_TTL_MS,
                confirmation: result.command_id === 'uncertain' ? 0 : 1 })).sort((a, b) => a.command_id < b.command_id ? -1 : 1));
              expect(markers.result).toEqual([{ scope: namespace, command_id: 'uncertain', idempotency_key: 'private-uncertain', started_at: 400 }]);
              resolve();
            } catch (error) { reject(error); }
          };
        });
      } finally { original.close(); }
    }
    expect(await f.cache().inspectReceipts()).toEqual({ count: 4, confirmed: { count: 3, entries: [
      { command_id: 'rejected', status: 'rejected', stored_at: 500, error_code: 'authority_invalid_grant_scope' },
      { command_id: 'known', status: 'error', stored_at: 500, error_code: 'selector_not_found' },
      { command_id: 'future', status: 'error', stored_at: 500 },
    ] } });
    for (const result of saved) expect((await f.cache().lookup(result.command_id))?.result).toEqual(result);
    const values = vi.spyOn(IDBIndex.prototype, 'openCursor'), get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const snapshot = await f.cache().inspectDiagnostics();
    expect(snapshot.in_flight?.entries).toEqual([{ command_id: 'uncertain', started_at: 400 }]);
    expect(JSON.stringify(snapshot)).not.toContain('private-');
    expect(values).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    values.mockRestore(); get.mockRestore();
    await f.cache().clear();
    expect((await f.cache().claim('retry', 'private-uncertain')).kind).toBe('in_flight');
    expect(await f.indexedDB.databases()).toEqual([{ name: BRIDGE_RECEIPT_DATABASE_NAME, version: 5 }]);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  buildIndexedDbKeyValue,
  runIndexedDbStoreRequest,
} from './indexed-db-key-value.js';

interface FakeIndexedDbOperation<T> {
  readonly db: IDBDatabase;
  readonly request: IDBRequest<T>;
  readonly transaction: IDBTransaction;
  readonly store: IDBObjectStore;
}

const fakeOperation = <T>(initialResult: T): FakeIndexedDbOperation<T> => {
  const requestState = {
    error: null,
    result: initialResult,
    onsuccess: null,
    onerror: null,
  };
  const request = requestState as unknown as IDBRequest<T>;
  const store = {} as IDBObjectStore;
  const transactionState = {
    error: null,
    onabort: null,
    oncomplete: null,
    onerror: null,
    objectStore: vi.fn(() => store),
  };
  const transaction = transactionState as unknown as IDBTransaction;
  const db = {
    transaction: vi.fn(() => transaction),
  } as unknown as IDBDatabase;
  return {
    db,
    request,
    transaction,
    store,
  };
};

describe('transaction-safe IndexedDB key/value adapter', () => {
  it('does not resolve a successful request until its transaction commits', async () => {
    const fake = fakeOperation('saved');
    const promise = runIndexedDbStoreRequest(
      fake.db,
      'local',
      'readwrite',
      () => fake.request,
    );
    let state = 'pending';
    void promise.then(
      () => { state = 'resolved'; },
      () => { state = 'rejected'; },
    );

    fake.request.onsuccess?.call(fake.request, new Event('success'));
    await Promise.resolve();
    expect(state).toBe('pending');

    fake.transaction.oncomplete?.call(
      fake.transaction,
      new Event('complete'),
    );
    await expect(promise).resolves.toBe('saved');
    expect(state).toBe('resolved');
  });

  it('rejects when the transaction aborts after request success', async () => {
    const fake = fakeOperation(undefined);
    const promise = runIndexedDbStoreRequest(
      fake.db,
      'local',
      'readwrite',
      () => fake.request,
    );

    fake.request.onsuccess?.call(fake.request, new Event('success'));
    fake.transaction.onabort?.call(fake.transaction, new Event('abort'));

    await expect(promise).rejects.toThrow('idb tx aborted');
  });

  it('uses one committed clear request for an atomic store wipe', async () => {
    const fake = fakeOperation(undefined);
    const clear = vi.fn(() => fake.request);
    Object.assign(fake.store, { clear });
    const kv = buildIndexedDbKeyValue(fake.db, 'local');
    const promise = kv.clear();

    expect(clear).toHaveBeenCalledTimes(1);
    fake.request.onsuccess?.call(fake.request, new Event('success'));
    fake.transaction.oncomplete?.call(
      fake.transaction,
      new Event('complete'),
    );

    await expect(promise).resolves.toBeUndefined();
    expect(fake.db.transaction).toHaveBeenCalledWith('local', 'readwrite');
  });
});

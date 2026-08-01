/** Transaction-safe IndexedDB adapter for the webclient's two key/value stores.
 *
 * An IDB request can report success before its containing transaction commits.
 * Callers that begin a recovery handoff after a write therefore need the
 * transaction's `complete` event, not only the request's `success` event. */

import type { IndexedDbKeyValue } from './local-store.js';

export const runIndexedDbStoreRequest = <T = unknown>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  operate: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operate(tx.objectStore(storeName));
    let settled = false;
    let requestResult: { readonly value: T } | undefined;

    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.onsuccess = (): void => {
      requestResult = { value: request.result };
    };
    request.onerror = (): void => {
      rejectOnce(request.error ?? new Error('idb request rejected'));
    };
    tx.onerror = (): void => {
      rejectOnce(tx.error ?? new Error('idb tx rejected'));
    };
    tx.onabort = (): void => {
      rejectOnce(tx.error ?? new Error('idb tx aborted'));
    };
    tx.oncomplete = (): void => {
      if (settled) return;
      if (requestResult === undefined) {
        rejectOnce(new Error('idb tx completed before request succeeded'));
        return;
      }
      settled = true;
      resolve(requestResult.value);
    };
  });

export const buildIndexedDbKeyValue = (
  db: IDBDatabase,
  storeName: string,
): IndexedDbKeyValue => ({
  async get(key) {
    return runIndexedDbStoreRequest(db, storeName, 'readonly', (store) =>
      store.get(key),
    );
  },
  async set(key, value) {
    await runIndexedDbStoreRequest(db, storeName, 'readwrite', (store) =>
      store.put(value as Parameters<IDBObjectStore['put']>[0], key),
    );
  },
  async delete(key) {
    await runIndexedDbStoreRequest(db, storeName, 'readwrite', (store) =>
      store.delete(key),
    );
  },
  async clear() {
    await runIndexedDbStoreRequest(db, storeName, 'readwrite', (store) =>
      store.clear(),
    );
  },
  async keys() {
    const raw = await runIndexedDbStoreRequest<IDBValidKey[]>(
      db,
      storeName,
      'readonly',
      (store) => store.getAllKeys(),
    );
    return raw.map((key) => String(key));
  },
});

/** Generic IndexedDB-backed Collection.
 *
 *  A simple, reusable KV collection stored in IndexedDB. Drop-in for
 *  `createInMemoryCollection<V>` — same interface, different backing.
 *  Use it anywhere state needs to survive Chrome MV3 service worker
 *  restarts: audit log entries, install registry records, future
 *  checkpoint state.
 *
 *  One database + one object store per Collection instance. Callers
 *  choose distinct `dbName` values to isolate stores — e.g.
 *    createIDBCollection<AuditEntry>({ dbName: 'recued-audit' })
 *    createIDBCollection<InstalledRecipe>({ dbName: 'recued-installs' })
 *
 *  Schema (v1):
 *    Database: <dbName>
 *    Object store: 'entries' (fixed name)
 *    Out-of-line keys — callers pass the key explicitly on every op.
 *    No indexes — list/prefix ops walk the store with a cursor, which
 *    is fine for the modest sizes expected (thousands of entries).
 *
 *  Lazy open: the factory is synchronous; the first op awaits the
 *  database open. One long-lived connection per instance, cleared when
 *  another tab/context upgrades the schema.
 */

import type { Collection } from './types.js';

const DEFAULT_DB_NAME = 'recued-collection';
const STORE_NAME = 'entries';
const DB_VERSION = 1;

export interface IDBCollectionOptions {
  /** IndexedDB database name. Defaults to 'recued-collection'. Callers
   *  SHOULD override this per use — two collections sharing a name
   *  share state, which is only correct for truly identical data
   *  shapes (e.g. a client and a background handler hitting the same
   *  audit log). */
  dbName?: string;
  /** Override IDB factory for tests. Defaults to globalThis.indexedDB. */
  indexedDB?: IDBFactory;
}

/** Extended Collection with an optional `close()` for callers that want
 *  to release the IDB connection (uncommon in a service worker). */
export interface IDBCollection<V> extends Collection<V> {
  close(): Promise<void>;
}

/** Build an IDB-backed Collection. Opens the database lazily on first
 *  use so the factory itself never throws. */
export const createIDBCollection = <V>(
  options: IDBCollectionOptions = {},
): IDBCollection<V> => {
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  const idbFactory =
    options.indexedDB ?? (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;

  if (!idbFactory) {
    throw new Error(
      'createIDBCollection: no IndexedDB implementation available. ' +
      'In tests, import "fake-indexeddb/auto" or pass options.indexedDB.',
    );
  }

  let dbPromise: Promise<IDBDatabase> | null = null;

  const openDb = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = idbFactory.open(dbName, DB_VERSION);
      req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
    });
    return dbPromise;
  };

  /** Wrap an IDBRequest as a Promise. */
  const req = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IDB request failed'));
    });

  const readTx = async <T>(fn: (store: IDBObjectStore) => Promise<T> | T): Promise<T> => {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    return fn(tx.objectStore(STORE_NAME));
  };

  const writeTx = async <T>(fn: (store: IDBObjectStore) => Promise<T> | T): Promise<T> => {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const result = await fn(tx.objectStore(STORE_NAME));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
    });
    return result;
  };

  /** Walk the store's primary key range with a cursor, invoking `visit`
   *  for each entry. `visit` can return `true` to continue or `false`
   *  to stop early. */
  const walk = async (
    tx: 'readonly' | 'readwrite',
    range: IDBKeyRange | undefined,
    visit: (cursor: IDBCursorWithValue, key: string, value: V) => boolean | void,
  ): Promise<void> => {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, tx);
    const store = transaction.objectStore(STORE_NAME);
    await new Promise<void>((resolve, reject) => {
      const cursorReq = store.openCursor(range);
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        const keepGoing = visit(cursor, cursor.primaryKey as string, cursor.value as V);
        if (keepGoing === false) {
          resolve();
          return;
        }
        cursor.continue();
      };
    });
    if (tx === 'readwrite') {
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
  };

  /** Build an IDBKeyRange that matches all keys starting with `prefix`.
   *  Upper bound uses `\uffff` as a sentinel — no real key will exceed
   *  it in lexicographic order. */
  const prefixRange = (prefix: string): IDBKeyRange =>
    IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);

  return {
    async get(key) {
      return readTx(async (store) => {
        const value = await req<V | undefined>(store.get(key));
        return value ?? null;
      });
    },

    async set(key, value) {
      await writeTx(async (store) => {
        await req(store.put(value as unknown as object, key));
      });
    },

    async delete(key) {
      await writeTx(async (store) => {
        await req(store.delete(key));
      });
    },

    async has(key) {
      return readTx(async (store) => {
        // count() with a single-key range is the cheapest way to check
        // existence without fetching the value.
        const count = await req<number>(store.count(IDBKeyRange.only(key)));
        return count > 0;
      });
    },

    async list() {
      return readTx(async (store) => {
        return req<V[]>(store.getAll() as unknown as IDBRequest<V[]>);
      });
    },

    async listKeys() {
      return readTx(async (store) => {
        return req<string[]>(store.getAllKeys() as unknown as IDBRequest<string[]>);
      });
    },

    async listByPrefix(prefix) {
      const results: Array<{ key: string; value: V }> = [];
      await walk('readonly', prefixRange(prefix), (_cursor, key, value) => {
        results.push({ key, value });
      });
      return results;
    },

    async deleteByPrefix(prefix) {
      let count = 0;
      await walk('readwrite', prefixRange(prefix), (cursor) => {
        cursor.delete();
        count++;
      });
      return count;
    },

    async clear() {
      await writeTx(async (store) => {
        await req(store.clear());
      });
    },

    async size() {
      return readTx(async (store) => {
        return req<number>(store.count());
      });
    },

    async close() {
      if (!dbPromise) return;
      const db = await dbPromise;
      db.close();
      dbPromise = null;
    },
  };
};

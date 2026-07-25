/** IndexedDB-backed CacheStore.
 *
 *  Persistent cache for the extension's service worker. Chrome MV3 kills
 *  service workers after ~30s of inactivity; in-memory cache evaporates
 *  on every wake. This store survives sw restarts, which is the whole
 *  point of caching AI responses (real tokens) and deal fetches (real
 *  network cost) in the first place.
 *
 *  Schema (v1):
 *    Database: `<name>` (caller-configurable; defaults to 'recued-cache')
 *    Object store: 'entries' keyed by `key` (SHA-256 hex)
 *    Indexes:
 *      - by_recipe         on `recipe_id`         (deleteByRecipe)
 *      - by_last_accessed  on `last_accessed_at`  (evictLRU scan order)
 *      - by_expires_at     on `expires_at`        (future: proactive cleanup)
 *
 *  Design:
 *    - Lazy DB open: the factory returns synchronously; the first op
 *      awaits the open. This matches `createInMemoryStore`'s shape so
 *      the two implementations are drop-in swappable.
 *    - One long-lived connection per store instance. Release via
 *      `close()` (not part of CacheStore but exposed on the returned
 *      object) or by letting the DB handle GC.
 *    - All writes are single-op transactions (IDB's atomic primitive).
 *      No cross-store composite transactions — we have one store.
 *    - Size is computed by scanning on demand. At realistic cache sizes
 *      (hundreds of entries, ~100 KB total) this is ~1-2ms. For larger
 *      caches, maintain a running total in a `_meta` key — deferred.
 */

import type { CacheEntry, CacheStore } from './types.js';

const DEFAULT_DB_NAME = 'recued-cache';
const STORE_NAME = 'entries';
const DB_VERSION = 1;

/** Extended CacheStore that also exposes a `close()` helper. The base
 *  CacheStore interface doesn't have close() because in-memory stores
 *  don't need it; IDB consumers can cast to this to release the
 *  connection when they're shutting down (uncommon in a service worker). */
export interface IDBCacheStore extends CacheStore {
  /** Close the underlying IDB connection. After calling this, further
   *  operations will reopen. */
  close(): Promise<void>;
  /** IDB always ships a native prefix-delete; narrow the base interface's
   *  optional so callers don't need a redundant null check. */
  deleteByPrefix(prefix: string): Promise<number>;
  /** IDB always ships a native touch; same narrowing as `deleteByPrefix`. */
  touch(
    key: string,
    at: { last_accessed_at: number; expires_at?: number },
  ): Promise<void>;
}

export interface IDBStoreOptions {
  /** IDB database name. Defaults to 'recued-cache'. Separate names give
   *  tests isolated databases. */
  dbName?: string;
  /** Override for tests — defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

/** Create an IndexedDB-backed CacheStore. The database is opened lazily
 *  on the first operation, so this factory is synchronous and safe to
 *  call at module load. */
export const createIDBStore = (options: IDBStoreOptions = {}): IDBCacheStore => {
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  const idbFactory = options.indexedDB ?? (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;

  if (!idbFactory) {
    throw new Error(
      'createIDBStore: no IndexedDB implementation available. ' +
      'In tests, import "fake-indexeddb/auto" or pass options.indexedDB.',
    );
  }

  // Promise of the open DB connection — initialized on first use.
  let dbPromise: Promise<IDBDatabase> | null = null;

  const openDb = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = idbFactory.open(dbName, DB_VERSION);
      req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('by_recipe', 'recipe_id', { unique: false });
          store.createIndex('by_last_accessed', 'last_accessed_at', { unique: false });
          store.createIndex('by_expires_at', 'expires_at', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // If another tab/context upgrades the schema, close our handle
        // so the next op reopens against the new version.
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

  /** Run a read-only transaction and pass the object store to a callback. */
  const readTx = async <T>(
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> => {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    return fn(store);
  };

  /** Run a read-write transaction and pass the object store to a callback. */
  const writeTx = async <T>(
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> => {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const result = await fn(store);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
    });
    return result;
  };

  return {
    async get(key) {
      return readTx(async (store) => {
        const entry = await req<CacheEntry | undefined>(store.get(key));
        return entry ?? null;
      });
    },

    async set(entry) {
      await writeTx(async (store) => {
        await req(store.put(entry));
      });
    },

    async delete(key) {
      await writeTx(async (store) => {
        await req(store.delete(key));
      });
    },

    async deleteByRecipe(recipe_id) {
      await writeTx(async (store) => {
        const index = store.index('by_recipe');
        // Cursor over all entries with this recipe_id, deleting each
        await new Promise<void>((resolve, reject) => {
          const cursorReq = index.openCursor(IDBKeyRange.only(recipe_id));
          cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
              resolve();
              return;
            }
            cursor.delete();
            cursor.continue();
          };
        });
      });
    },

    async deleteByPrefix(prefix) {
      // Primary key on this object store IS the cache key (string). A
      // bounded range [prefix, prefix + \uffff) selects exactly the keys
      // that start with prefix — no full scan needed.
      const upper = prefix + '\uffff';
      let deleted = 0;
      await writeTx(async (store) => {
        await new Promise<void>((resolve, reject) => {
          const cursorReq = store.openCursor(IDBKeyRange.bound(prefix, upper, false, true));
          cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) { resolve(); return; }
            cursor.delete();
            deleted++;
            cursor.continue();
          };
        });
      });
      return deleted;
    },

    async size() {
      return readTx(async (store) => {
        // Walk all entries summing size_bytes. For the realistic cache
        // sizes we expect (<1 MB total, <1000 entries), this is fast.
        let total = 0;
        await new Promise<void>((resolve, reject) => {
          const cursorReq = store.openCursor();
          cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
              resolve();
              return;
            }
            const entry = cursor.value as CacheEntry;
            total += entry.size_bytes ?? 0;
            cursor.continue();
          };
        });
        return total;
      });
    },

    async evictLRU(target_bytes) {
      // First pass: compute current size. Stop early if we're already
      // under target — no transaction needed for the eviction phase.
      const current = await this.size();
      if (current <= target_bytes) return;

      // Second pass: walk the `by_last_accessed` index ascending,
      // deleting oldest entries until total is under the target.
      await writeTx(async (store) => {
        const index = store.index('by_last_accessed');
        let total = current;
        await new Promise<void>((resolve, reject) => {
          const cursorReq = index.openCursor();
          cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor || total <= target_bytes) {
              resolve();
              return;
            }
            const entry = cursor.value as CacheEntry;
            total -= entry.size_bytes ?? 0;
            cursor.delete();
            cursor.continue();
          };
        });
      });
    },

    async clear() {
      await writeTx(async (store) => {
        await req(store.clear());
      });
    },

    async touch(key, at) {
      await writeTx(async (store) => {
        const existing = (await req(store.get(key))) as CacheEntry | undefined;
        if (!existing) return;
        existing.last_accessed_at = at.last_accessed_at;
        if (at.expires_at !== undefined) existing.expires_at = at.expires_at;
        await req(store.put(existing));
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

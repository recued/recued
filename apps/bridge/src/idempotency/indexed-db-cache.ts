/** Admission markers and completed receipts, scoped to an authenticated pair.
 *
 * A write resolves only after its IndexedDB transaction commits. It requests
 * strict durability and never falls back to a volatile cache on storage errors.
 * Admission is committed before the executor runs. An unresolved marker blocks
 * redispatch across worker restarts, cache clears, and receipt expiry. A known
 * completion retires its matching marker in the receipt's transaction. This
 * records uncertainty; it does not make a browser effect exactly-once.
 *
 * Connections are short lived so one worker cannot block a later schema upgrade.
 * Request callbacks enqueue further requests synchronously within the transaction.
 */
import { BRIDGE_IDEMPOTENCY_TTL_MS, type BridgeResult } from '@recued/contracts';
import { receiptResolvesInFlight, confirmedErrorMetadata, isUncertainBridgeErrorCode,
  BRIDGE_IN_FLIGHT_INSPECTION_LIMIT, BRIDGE_CONFIRMED_INSPECTION_LIMIT,
  type BridgeConfirmedOutcome, type BridgeReceiptInspection, type BridgeIdempotencyInspection, type BridgeInFlightInspection,
  type BridgeIdempotencyScope, type BridgeInFlightEntry,
  type IdempotencyCache, type IdempotencyClaim, type IdempotencyEntry } from './cache.js';

export const BRIDGE_RECEIPT_DATABASE_NAME = 'recued.bridge.receipts.v1';
export const BRIDGE_RECEIPT_STORE_NAME = 'recued.bridge.idempotency';
export const BRIDGE_IN_FLIGHT_STORE_NAME = 'recued.bridge.in_flight';
const statuses = new Set(['ok', 'error', 'rejected', 'cancelled', 'timeout']);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const readInFlight = (raw: unknown, scope: string): BridgeInFlightEntry => {
  if (!record(raw) || raw.scope !== scope || typeof raw.command_id !== 'string' || !raw.command_id
    || typeof raw.idempotency_key !== 'string' || !raw.idempotency_key || !finite(raw.started_at)) {
    throw new Error('bridge.receipts: invalid in-flight marker; refusing another dispatch');
  }
  return { command_id: raw.command_id, idempotency_key: raw.idempotency_key, started_at: raw.started_at };
};

const readEntry = (raw: unknown, scope?: string): IdempotencyEntry => {
  if (!record(raw) || typeof raw.scope !== 'string' || (scope !== undefined && raw.scope !== scope)
    || typeof raw.command_id !== 'string' || !raw.command_id || typeof raw.idempotency_key !== 'string' || !raw.idempotency_key
    || !finite(raw.stored_at) || !finite(raw.expires_at) || raw.expires_at !== raw.stored_at + BRIDGE_IDEMPOTENCY_TTL_MS
    || !record(raw.result) || raw.result.command_id !== raw.command_id
    || typeof raw.result.status !== 'string' || !statuses.has(raw.result.status)
    || !finite(raw.result.duration_ms) || raw.result.duration_ms < 0 || typeof raw.result.bridge_version !== 'string'
    || typeof raw.result.idempotency_key_seen !== 'boolean'
    || (raw.result.outputs !== undefined && !record(raw.result.outputs))
    || (raw.result.error !== undefined && (!record(raw.result.error)
      || typeof raw.result.error.code !== 'string' || typeof raw.result.error.message !== 'string'))) {
    throw new Error('bridge.receipts: invalid stored receipt; refusing to treat it as a cache miss');
  }
  return { command_id: raw.command_id, idempotency_key: raw.idempotency_key,
    stored_at: raw.stored_at, expires_at: raw.expires_at, result: raw.result as unknown as BridgeResult };
};

const openDatabase = (factory: IDBFactory | undefined, name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (!factory) { reject(new Error('bridge.receipts: IndexedDB is unavailable')); return; }
    const request = factory.open(name, 5); let failed = false;
    request.onerror = () => { failed = true; reject(request.error ?? new Error('bridge.receipts: database open failed')); };
    request.onblocked = () => { failed = true; reject(new Error('bridge.receipts: database open is blocked')); };
    request.onupgradeneeded = (event) => {
      if (failed) { request.transaction?.abort(); return; }
      const db = request.result;
      // Keep v1 receipts in place. A schema upgrade cannot reconstruct actions
      // that were admitted by an older bridge without a marker.
      if (!db.objectStoreNames.contains(BRIDGE_RECEIPT_STORE_NAME)) {
        const store = db.createObjectStore(BRIDGE_RECEIPT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
        store.createIndex('by_scope', 'scope');
        store.createIndex('by_key', ['scope', 'idempotency_key']);
        store.createIndex('by_expiry', 'expires_at');
      }
      const inFlight = db.objectStoreNames.contains(BRIDGE_IN_FLIGHT_STORE_NAME)
        ? request.transaction!.objectStore(BRIDGE_IN_FLIGHT_STORE_NAME)
        : db.createObjectStore(BRIDGE_IN_FLIGHT_STORE_NAME, { keyPath: ['scope', 'command_id'] });
      if (!inFlight.indexNames.contains('by_key')) inFlight.createIndex('by_key', ['scope', 'idempotency_key'], { unique: true });
      // v3 indexes existing markers in place; no admitted command is removed.
      if (!inFlight.indexNames.contains('by_scope')) inFlight.createIndex('by_scope', 'scope');
      const receipts = request.transaction!.objectStore(BRIDGE_RECEIPT_STORE_NAME);
      if (event.oldVersion < 5) {
        if (receipts.indexNames.contains('by_confirmation')) receipts.deleteIndex('by_confirmation');
        // Index keys carry only diagnostic metadata. Normal reads never load
        // result bodies, even if many large outputs or uncertain receipts exist.
        receipts.createIndex('by_confirmation', ['scope', 'confirmation', 'stored_at', 'command_id', 'result.status', 'diagnostic_error_code']);
        const migration = receipts.openCursor();
        migration.onsuccess = () => {
          const cursor = migration.result;
          if (!cursor) return;
          let entry: IdempotencyEntry;
          try { entry = readEntry(cursor.value); }
          catch {
            // Preserve corrupt evidence. Its namespace's metadata inspection
            // fails coverage below; it must not block another pair's upgrade.
            cursor.continue(); return;
          }
          // v5 backfills a known code (or the empty sentinel) for existing
          // receipts without changing their result or unresolved admission.
          cursor.update({ ...cursor.value, confirmation: receiptResolvesInFlight(entry.result) ? 1 : 0,
            diagnostic_error_code: confirmedErrorMetadata(entry.result.status, entry.result.error?.code).error_code ?? '' });
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });

export const createIndexedDbIdempotencyCache = (options: {
  scope: BridgeIdempotencyScope;
  indexedDB?: IDBFactory;
  database_name?: string;
  now?: () => number;
  /** Ancillary inspector metadata. Neither a delay nor a failure may hold up
   *  acknowledgement of the committed receipt. */
  onStored?(committed_at: number): Promise<void> | void;
}): IdempotencyCache => {
  if (!options.scope.server_public_key || !options.scope.token_id) throw new Error('bridge.receipts: an explicit pair scope is required');
  const scope = JSON.stringify([options.scope.server_public_key, options.scope.token_id]);
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const name = options.database_name ?? BRIDGE_RECEIPT_DATABASE_NAME;
  const now = options.now ?? Date.now;
  // A failed post-action write must not turn into an ordinary miss on a retry
  // in this worker. Explicit clear is the only reset of this local quarantine.
  let writeFailed = false;
  const assertDispatchAvailable = () => {
    if (writeFailed) throw new Error('bridge.receipts: a prior receipt write failed; refusing another dispatch');
  };
  const transact = async <T>(body: (store: IDBObjectStore, done: (value: T) => void,
    fail: (error: unknown) => void, inFlight: IDBObjectStore) => void,
    mode: IDBTransactionMode = 'readwrite'): Promise<T> => {
    const db = await openDatabase(factory, name);
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction([BRIDGE_RECEIPT_STORE_NAME, BRIDGE_IN_FLIGHT_STORE_NAME], mode,
          mode === 'readwrite' ? { durability: 'strict' } : {});
        let value!: T; let failure: unknown;
        const fail = (error: unknown) => {
          failure = error;
          try { tx.abort(); } catch { reject(error); }
        };
        tx.onerror = () => { failure ??= tx.error ?? new Error('bridge.receipts: transaction request failed'); };
        tx.onabort = () => reject(failure ?? tx.error ?? new Error('bridge.receipts: transaction aborted'));
        tx.oncomplete = () => { if (failure) reject(failure); else resolve(value); };
        try { body(tx.objectStore(BRIDGE_RECEIPT_STORE_NAME), result => { value = result; }, fail,
          tx.objectStore(BRIDGE_IN_FLIGHT_STORE_NAME)); }
        catch (error) { fail(error); }
      });
    } finally { db.close(); }
  };
  const lookupCommand = (store: IDBObjectStore, command_id: string,
    done: (entry: IdempotencyEntry | null) => void, fail: (error: unknown) => void): void => {
    const request = store.get([scope, command_id]);
    request.onsuccess = () => {
      try {
        if (request.result === undefined) { done(null); return; }
        const entry = readEntry(request.result, scope);
        if (entry.expires_at <= now()) { store.delete([scope, command_id]); done(null); }
        else done(entry);
      } catch (error) { fail(error); }
    };
  };
  const lookupKey = (store: IDBObjectStore, key: string,
    done: (entry: IdempotencyEntry | null) => void, fail: (error: unknown) => void): void => {
    const request = store.index('by_key').openCursor([scope, key]);
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) { done(null); return; }
        const entry = readEntry(cursor.value, scope);
        if (entry.expires_at <= now()) { cursor.delete(); cursor.continue(); }
        else done(entry);
      } catch (error) { fail(error); }
    };
  };
  const findInFlight = (store: IDBObjectStore, command_id: string, key: string,
    done: (entry: BridgeInFlightEntry | null) => void, fail: (error: unknown) => void): void => {
    const request = store.get([scope, command_id]);
    request.onsuccess = () => {
      try {
        if (request.result !== undefined) { done(readInFlight(request.result, scope)); return; }
        const byKey = store.index('by_key').get([scope, key]);
        byKey.onsuccess = () => {
          try { done(byKey.result === undefined ? null : readInFlight(byKey.result, scope)); }
          catch (error) { fail(error); }
        };
      } catch (error) { fail(error); }
    };
  };
  const readReceiptInspection = (store: IDBObjectStore, done: (value: BridgeReceiptInspection) => void,
    fail: (error: unknown) => void): void => {
    const all = store.index('by_scope').count(scope);
    all.onsuccess = () => {
      try {
        // Opening or waiting for another transaction may have taken time. Take
        // the TTL boundary only after this transaction actually begins reading.
        const cutoff = now() - BRIDGE_IDEMPOTENCY_TTL_MS;
        if (!finite(cutoff)) throw new Error('bridge.receipts: invalid inspection time');
        const index = store.index('by_confirmation');
        // Array sentinels sort after numeric timestamps and string command IDs.
        // The lower bound excludes all receipts exactly at the TTL boundary.
        const range = (flag: number, live: boolean) => IDBKeyRange.bound(
          live ? [scope, flag, cutoff, []] : [scope, flag], [scope, flag, []]);
        const confirmed = index.count(range(1, true)), uncertain = index.count(range(0, true));
        const allConfirmed = index.count(range(1, false)), allUncertain = index.count(range(0, false));
        const entries: BridgeConfirmedOutcome[] = [];
        const request = index.openKeyCursor(range(1, true), 'prev');
        request.onsuccess = () => {
          try {
            if (all.result !== allConfirmed.result + allUncertain.result) {
              throw new Error('bridge.receipts: incomplete receipt metadata');
            }
            const cursor = request.result;
            if (cursor) {
              const key = cursor.key;
              if (!Array.isArray(key) || key.length !== 6 || key[0] !== scope || key[1] !== 1
                || !finite(key[2]) || !Number.isFinite(new Date(key[2]).getTime())
                || typeof key[3] !== 'string' || !key[3] || (key[4] !== 'ok' && key[4] !== 'error' && key[4] !== 'rejected')
                || typeof key[5] !== 'string' || isUncertainBridgeErrorCode(key[5])) {
                throw new Error('bridge.receipts: invalid receipt metadata');
              }
              entries.push({ command_id: key[3], stored_at: key[2], status: key[4], ...confirmedErrorMetadata(key[4], key[5]) });
              if (entries.length < BRIDGE_CONFIRMED_INSPECTION_LIMIT) { cursor.continue(); return; }
            }
            done({ count: confirmed.result + uncertain.result, confirmed: { count: confirmed.result, entries } });
          } catch (error) { fail(error); }
        };
      } catch (error) { fail(error); }
    };
  };
  const readInFlightInspection = (inFlight: IDBObjectStore, done: (value: BridgeInFlightInspection) => void,
    fail: (error: unknown) => void): void => {
    const index = inFlight.index('by_scope');
    const count = index.count(scope);
    const rows = index.getAll(scope, BRIDGE_IN_FLIGHT_INSPECTION_LIMIT);
    rows.onsuccess = () => {
      try {
        done({ count: count.result, entries: rows.result.map(raw => {
          const entry = readInFlight(raw, scope);
          return { command_id: entry.command_id, started_at: entry.started_at };
        }) });
      } catch (error) { fail(error); }
    };
  };
  return {
    async claim(command_id, idempotency_key) {
      assertDispatchAvailable();
      if (typeof command_id !== 'string' || !command_id || typeof idempotency_key !== 'string' || !idempotency_key) {
        throw new Error('bridge.receipts: command identity is required');
      }
      // The read/check/add sequence shares one transaction across both stores.
      // Other cache instances and workers cannot race this admission decision.
      return transact<IdempotencyClaim>((store, done, fail, inFlight) => {
        lookupCommand(store, command_id, prior => {
          if (prior) { done({ kind: 'completed', entry: prior }); return; }
          lookupKey(store, idempotency_key, byKey => {
            if (byKey) { done({ kind: 'completed', entry: byKey }); return; }
            findInFlight(inFlight, command_id, idempotency_key, pending => {
              if (pending) { done({ kind: 'in_flight', entry: pending }); return; }
              const entry = { command_id, idempotency_key, started_at: now() };
              readInFlight({ scope, ...entry }, scope);
              inFlight.add({ scope, ...entry });
              done({ kind: 'claimed', entry });
            }, fail);
          }, fail);
        }, fail);
      });
    },
    async store(command_id, idempotency_key, result) {
      assertDispatchAvailable();
      try {
        const stored_at = now();
        const row = { scope, command_id, idempotency_key, result, stored_at,
          expires_at: stored_at + BRIDGE_IDEMPOTENCY_TTL_MS, confirmation: receiptResolvesInFlight(result) ? 1 : 0,
          diagnostic_error_code: confirmedErrorMetadata(result.status, result.error?.code).error_code ?? '' };
        readEntry(row, scope);
        await transact<void>((store, done, fail, inFlight) => {
          findInFlight(inFlight, command_id, idempotency_key, pending => {
            if (pending && (pending.command_id !== command_id || pending.idempotency_key !== idempotency_key)) {
              throw new Error('bridge.receipts: cannot finish another command\'s in-flight marker');
            }
            store.put(row);
            if (pending && receiptResolvesInFlight(result)) inFlight.delete([scope, command_id]);
            done(undefined);
          }, fail);
        });
      } catch (error) { writeFailed = true; throw error; }
      try {
        void Promise.resolve(options.onStored?.(now())).catch(() => undefined);
      } catch { /* The receipt itself has already committed. */ }
    },
    async lookup(command_id) {
      assertDispatchAvailable();
      return transact<IdempotencyEntry | null>((store, done, fail) => lookupCommand(store, command_id, done, fail));
    },
    async lookupByIdempotencyKey(key) {
      assertDispatchAvailable();
      return transact<IdempotencyEntry | null>((store, done, fail) => lookupKey(store, key, done, fail));
    },
    async sweepExpired(at) {
      return transact<number>((store, done, fail) => {
        let removed = 0; const request = store.index('by_expiry').openCursor();
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor || readEntry(cursor.value).expires_at > at) { done(removed); return; }
            cursor.delete(); removed++; cursor.continue();
          } catch (error) { fail(error); }
        };
      });
    },
    async list() {
      return transact<IdempotencyEntry[]>((store, done, fail) => {
        const entries: IdempotencyEntry[] = [];
        const request = store.index('by_scope').openCursor(scope);
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor) { done(entries); return; }
            const entry = readEntry(cursor.value, scope);
            if (entry.expires_at <= now()) cursor.delete(); else entries.push(entry);
            cursor.continue();
          } catch (error) { fail(error); }
        };
      });
    },
    async inspectReceipts() {
      return transact<BridgeReceiptInspection>((store, done, fail) => readReceiptInspection(store, done, fail), 'readonly');
    },
    async inspectInFlight() {
      return transact<BridgeInFlightInspection>((_store, done, fail, inFlight) => readInFlightInspection(inFlight, done, fail), 'readonly');
    },
    async inspectDiagnostics() {
      // Both stores share a snapshot across concurrent completion transactions.
      // Schema/row validation can make one section unavailable independently;
      // request errors still abort the transaction and reject the whole read.
      return transact<BridgeIdempotencyInspection>((store, done, _fail, inFlight) => {
        const snapshot: BridgeIdempotencyInspection = { receipts: null, in_flight: null };
        try { readReceiptInspection(store, value => { snapshot.receipts = value; }, () => undefined); }
        catch { /* Receipt metadata is unavailable. */ }
        try { readInFlightInspection(inFlight, value => { snapshot.in_flight = value; }, () => undefined); }
        catch { /* Unresolved markers are unavailable. */ }
        // transact resolves only on commit, after both projections finish.
        done(snapshot);
      }, 'readonly');
    },
    async clear() {
      await transact<void>((store, done, fail) => {
        const request = store.index('by_scope').openCursor(scope);
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor) { done(undefined); return; }
            cursor.delete(); cursor.continue();
          } catch (error) { fail(error); }
        };
      });
      writeFailed = false;
    },
  };
};

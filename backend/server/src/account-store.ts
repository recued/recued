/** Server-side per-pair key-value store.
 *
 *  D-125 P5.2 retired the `account.*` namespace and the cloud-sync
 *  pipeline this store was originally built to mirror; the SQLite table
 *  + interface are preserved as a durable per-pair KV surface for the
 *  remaining consumers — primarily the calendar OAuth + caldav etag
 *  storage paths threaded through `OAuthAccountStore` (mail/oauth.ts)
 *  and the calendar adapter wiring in `bin.ts`. The historical
 *  `ServerAccountStore` name is kept for API stability since renaming
 *  would touch every calendar/oauth call site without changing
 *  semantics; consumers should treat it as a generic pair-local KV
 *  store, not as an account-namespace mirror.
 *
 *  Plaintext at rest. Per Phase B, this is a gated surface —
 *  `totalBytes()` seeds the `account_store` gate at boot and the
 *  gate-wiring in `bin.ts` wraps `set` / `delete` with `canWrite` +
 *  `addUsed` / `subUsed`.
 */

import type Database from 'better-sqlite3';
import type { Collection } from '@recued/storage';
import { createSQLiteCollection } from './sqlite-collection.js';

const TABLE = 'account_store';

export interface ServerAccountStore {
  /** Write a plaintext value. Overwrites any prior value at the key. */
  set(key: string, value: string): Promise<void>;
  /** Read a plaintext value. Null when absent. */
  get(key: string): Promise<string | null>;
  /** Dump every key → value as a flat object. */
  getAll(): Promise<Record<string, string>>;
  /** Remove a single key. No-op when absent. */
  delete(key: string): Promise<void>;
  /** Wipe every entry. */
  clear(): Promise<void>;
  /** Sum of JSON-encoded value bytes across all entries. Used by the
   *  Phase B storage gate to seed initial usage on boot. Cheap:
   *  one `SUM(length(data))` when backed by SQLite. */
  totalBytes(): Promise<number>;
}

export interface CreateServerAccountStoreOptions {
  /** Override the backing collection. Tests inject an in-memory double;
   *  production wiring passes `db` and lets this module build the
   *  SQLite-backed collection. */
  collection?: Collection<string>;
  /** Phase B gate hook. Every `set` / `delete` / `clear` reports the
   *  signed byte delta so the surface gate stays aligned with live
   *  usage. Accounting uses the same `JSON.stringify(value).length`
   *  metric `totalBytes` uses at boot. Exceptions thrown by the sink
   *  are swallowed. */
  onBytesChanged?: (delta: number) => void;
}

export const createServerAccountStore = (
  db: Database.Database | undefined,
  options: CreateServerAccountStoreOptions = {},
): ServerAccountStore => {
  const collection: Collection<string> = options.collection
    ?? (() => {
      if (!db) {
        throw new Error(
          'createServerAccountStore: either `db` or `options.collection` must be provided',
        );
      }
      return createSQLiteCollection<string>(db, TABLE);
    })();

  const onBytesChanged = options.onBytesChanged;
  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch (_err) { /* never break writes */ }
  };
  const measureBytes = (v: string | null): number =>
    v == null ? 0 : JSON.stringify(v).length;

  return {
    async set(key, value) {
      let prevBytes = 0;
      if (onBytesChanged) {
        const existing = await collection.get(key);
        prevBytes = measureBytes(existing ?? null);
      }
      await collection.set(key, value);
      reportDelta(measureBytes(value) - prevBytes);
    },
    async get(key) {
      return (await collection.get(key)) ?? null;
    },
    async getAll() {
      const keys = await collection.listKeys();
      const entries = Object.create(null) as Record<string, string>;
      for (const k of keys) {
        const v = await collection.get(k);
        if (v != null) entries[k] = v;
      }
      return entries;
    },
    async delete(key) {
      let prevBytes = 0;
      if (onBytesChanged) {
        const existing = await collection.get(key);
        prevBytes = measureBytes(existing ?? null);
      }
      await collection.delete(key);
      if (prevBytes > 0) reportDelta(-prevBytes);
    },
    async clear() {
      let freed = 0;
      if (onBytesChanged) {
        for (const v of await collection.list()) freed += measureBytes(v);
      }
      await collection.clear();
      if (freed > 0) reportDelta(-freed);
    },
    async totalBytes() {
      if (db && !options.collection) {
        const row = db
          .prepare(`SELECT SUM(length(data)) AS total FROM ${TABLE}`)
          .get() as { total: number | null } | undefined;
        return row?.total ?? 0;
      }
      const values = await collection.list();
      let total = 0;
      for (const v of values) {
        total += JSON.stringify(v).length;
      }
      return total;
    },
  };
};

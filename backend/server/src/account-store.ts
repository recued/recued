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
 *  ⚠ No application-layer encryption — values are stored exactly as
 *  written, and this store holds no key of its own. On an enrolled realm
 *  the bytes are ciphertext on disk only because D-212 encrypts the whole
 *  database file; that is a property of the file, not of this store. Two
 *  consequences that matter, since the table currently holds OAuth
 *  refresh tokens and caldav passwords: any component with the `db`
 *  handle reads values in the clear, and they stay readable while the
 *  vault is LOCKED (the lock gates the Master DEK, which this store never
 *  touches). Do not treat it as vault-equivalent for credentials.
 *
 *  Per Phase B, this is a gated surface — `totalBytes()` seeds the
 *  `account_store` gate at boot and the gate-wiring in `bin.ts` wraps
 *  `set` / `delete` with `canWrite` + `addUsed` / `subUsed`.
 */

import type Database from 'better-sqlite3';
import type { Collection } from '@recued/storage';
import { createSQLiteCollection } from './sqlite-collection.js';

const TABLE = 'account_store';
const oauthGrantLeases = new WeakMap<Database.Database, Map<string, Promise<void>>>();

export interface AccountStoreWrite {
  key: string; value: string | null;
  /** Omitted = unconditional. Null requires the key to be absent. */
  expected?: string | null;
}

export interface ServerAccountStore {
  /** Serialize native token refresh and its durable write across store handles. */
  withOAuthGrantLease?<T>(prefix: string, run: () => Promise<T>): Promise<T>;
  /** SQLite-only: compare/write a batch and caller metadata in one transaction.
   * Byte accounting is reported only after commit. */
  transactionalWrite?(entries: readonly AccountStoreWrite[], commit?: () => void): void;
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
    ...(db && !options.collection ? {
      async withOAuthGrantLease<T>(prefix: string, run: () => Promise<T>): Promise<T> {
        let leases = oauthGrantLeases.get(db); if (!leases) { leases = new Map(); oauthGrantLeases.set(db, leases); }
        const waiting = leases.get(prefix); let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; }); leases.set(prefix, held);
        try { await waiting; return await run(); }
        finally { release(); if (leases.get(prefix) === held) leases.delete(prefix); }
      },
      transactionalWrite(entries: readonly AccountStoreWrite[], commit?: () => void): void {
        let delta = 0;
        db.transaction(() => {
          for (const entry of entries) {
            const row = db.prepare<[string], { data: string }>('SELECT data FROM account_store WHERE key = ?').get(entry.key);
            const previous = row ? JSON.parse(row.data) as string : null;
            if (entry.expected !== undefined && previous !== entry.expected) throw new Error('oauth_grant_changed');
          }
          for (const entry of entries) {
            const row = db.prepare<[string], { data: string }>('SELECT data FROM account_store WHERE key = ?').get(entry.key);
            delta += measureBytes(entry.value) - (row?.data.length ?? 0);
            if (entry.value === null) db.prepare('DELETE FROM account_store WHERE key = ?').run(entry.key);
            else db.prepare('INSERT OR REPLACE INTO account_store (key, data) VALUES (?, ?)').run(entry.key, JSON.stringify(entry.value));
          }
          commit?.();
        })();
        reportDelta(delta);
      },
    } : {}),
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

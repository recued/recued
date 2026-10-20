import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CacheStore } from '@recued/cache';
import { canonicalJSONStringify, type CacheEntry } from '@recued/contracts';

export interface RecordOutputSourceCache {
  get(entry: CacheEntry): unknown;
  set(entry: CacheEntry, evidence: unknown): void;
}

// Evidence is private to the host. CacheEntry and cache.get/put/since never
// carry it, so a peer or provider cannot promote its payload into source proof.
const stores = new WeakMap<CacheStore, { db: Database.Database | undefined; evidence: RecordOutputSourceCache }>();
const entryHash = (entry: CacheEntry): string => createHash('sha256').update(canonicalJSONStringify([
  entry.key, entry.ingredient_slug, entry.created_at, entry.expires_at, entry.value,
])).digest('hex');

/** A durable host receipt bound to the exact cached value and its lifetime.
 * Without SQLite, an ephemeral host retains at most 1,000 receipts per store. */
export const recordOutputSourceCache = (
  cache: CacheStore, db?: Database.Database,
): RecordOutputSourceCache => {
  const existing = stores.get(cache);
  if (existing && existing.db === db) return existing.evidence;
  let evidence: RecordOutputSourceCache;
  if (db) {
    db.exec(`CREATE TABLE IF NOT EXISTS record_output_cache_sources (
      cache_key TEXT PRIMARY KEY, entry_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS record_output_cache_sources_expiry
      ON record_output_cache_sources(expires_at);`);
    // Explicit cache deletion (eviction, uninstall, reset and housekeeping)
    // removes the receipt in the same transaction, including raw SQL deletes.
    // Other cache backends may share the realm DB without a cache_entries table.
    const hasCacheTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache_entries'").get());
    if (hasCacheTable) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS record_output_cache_sources_delete
        AFTER DELETE ON cache_entries BEGIN
          DELETE FROM record_output_cache_sources WHERE cache_key = OLD.key;
        END;`);
      db.prepare(`DELETE FROM record_output_cache_sources WHERE NOT EXISTS
        (SELECT 1 FROM cache_entries WHERE key = cache_key)`).run();
    }
    const read = db.prepare('SELECT entry_hash, evidence_json FROM record_output_cache_sources WHERE cache_key = ? AND expires_at > ?');
    const write = db.prepare(`INSERT OR REPLACE INTO record_output_cache_sources
      (cache_key, entry_hash, evidence_json, expires_at) SELECT ?, ?, ?, ?
      ${hasCacheTable ? 'WHERE EXISTS (SELECT 1 FROM cache_entries WHERE key = ?)' : ''}`);
    const prune = db.prepare('DELETE FROM record_output_cache_sources WHERE expires_at <= ?');
    evidence = {
      get(entry) {
        if (entry.expires_at <= Date.now()) return undefined;
        const row = read.get(entry.key, Date.now()) as { entry_hash: string; evidence_json: string } | undefined;
        return row?.entry_hash === entryHash(entry) ? JSON.parse(row.evidence_json) : undefined;
      },
      set(entry, proof) {
        const serialized = canonicalJSONStringify(proof);
        const hash = entryHash(entry);
        db.transaction(() => {
          prune.run(Date.now());
          // A storage-pressure eviction can finish before the cache write's
          // promise resolves. Do not create an orphan receipt after that delete.
          if (hasCacheTable) write.run(entry.key, hash, serialized, entry.expires_at, entry.key);
          else write.run(entry.key, hash, serialized, entry.expires_at);
        })();
      },
    };
  } else {
    const receipts = new Map<string, { hash: string; json: string; expires: number }>();
    evidence = {
      get(entry) {
        const receipt = receipts.get(entry.key);
        if (!receipt || receipt.expires <= Date.now() || receipt.hash !== entryHash(entry)) return undefined;
        return JSON.parse(receipt.json);
      },
      set(entry, proof) {
        receipts.delete(entry.key);
        receipts.set(entry.key, { hash: entryHash(entry), json: canonicalJSONStringify(proof), expires: entry.expires_at });
        if (receipts.size > 1_000) receipts.delete(receipts.keys().next().value!);
      },
    };
  }
  stores.set(cache, { db, evidence });
  return evidence;
};

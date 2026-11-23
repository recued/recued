/** D-403 (D-403) — what takes space on the owner's server, by kind, and the purge the
 *  owner runs: *"manual for owner to take action"*.
 *
 *  - **The read** (`read`) lists each kind with its items, size where the server already accounts it,
 *    oldest item and growth over 30 days, plus the database file and the space free inside it. Every
 *    figure is an index, a counter, a gate or a grouped read: better-sqlite3 runs on the server's one
 *    thread, so nothing here scans a large table without an index. Cached for a minute.
 *  - **The purge** (`preview`, then `run`) deletes one kind's items older than a date: Records rows by
 *    when they were last saved, runs by when they started, readings by when they were taken. A
 *    preview counts them and hands out a token; a run takes the token within its minute, counts
 *    again, and refuses when the count moved, so it never deletes more than the owner was shown. It
 *    deletes in batches and yields between them, then records itself as a reserve activity
 *    (`source_data_purged`), which no prune deletes.
 *
 *  Nothing here deletes on its own (ruling 1). */
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  STORAGE_KIND_GROUPS,
  STORAGE_PURGE_MIN_AGE_MS,
  STORAGE_PURGE_PREVIEW_TTL_MS,
  parseRecordsStorageKind,
  recordsStorageKind,
  storageKeyWords,
  type RecordsPackRef,
  type StorageKindRow,
  type StorageKindsResponse,
  type StoragePurgePreview,
  type StoragePurgeRunResult,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { RecordsStore } from './records/store.js';
import { readAuditUsageBytes } from './audit-usage-counter.js';

const DAY = 86_400_000;
const READ_TTL_MS = 60_000;
const RUN_BATCH = 1_000;
const RECORDS_BATCH = 500;

/** The run log's rows a purge never takes: a reserve row (the ledger of pressure, halts, prunes and
 *  purges), and a run still waiting for the owner's approval (D-157 N.8). As `audit-retention.ts`. */
const NOT_RESERVE = `(json_extract(data, '$.reserve') IS NULL OR json_extract(data, '$.reserve') != 1)`;
const NOT_AWAITING = `(json_extract(data, '$.commit_status') IS NULL OR json_extract(data, '$.commit_status') != 'awaiting_approval')`;
const STARTED = `json_extract(data, '$.started_at')`;
const AT = `json_extract(data, '$.timestamp')`;

export class OwnerStorageError extends Error {
  constructor(readonly code: 'unknown_kind' | 'not_purgeable' | 'bad_cutoff' | 'stale_preview', message: string) {
    super(message);
    this.name = 'OwnerStorageError';
  }
}

export interface OwnerStorageDeps {
  db: Database.Database;
  records?: Pick<RecordsStore, 'listNamespaces' | 'ownerKindAges' | 'ownerCountOlderThan' | 'ownerDeleteOlderThan'>;
  /** A pack's name as the Packs screen shows it; null or absent ⇒ its slug in words. */
  packName?: (owner: RecordsPackRef) => string | null;
  /** The storage gates' use, for the copies (mail, calendar, files) and shared data. */
  gates?: () => ReadonlyArray<{ surface: string; used: number }>;
  /** Where a purge records itself. Absent ⇒ the purge still runs, without the record. */
  auditLog?: Pick<AuditLogStore, 'logActivity'>;
  now?: () => number;
}

interface Counted { items: number; bytes?: number; oldest_at?: number; newest_at?: number }

export interface OwnerStorage {
  read(): StorageKindsResponse;
  preview(kind: string, before: number): StoragePurgePreview;
  run(kind: string, before: number, token: string): Promise<StoragePurgeRunResult>;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export const createOwnerStorage = (deps: OwnerStorageDeps): OwnerStorage => {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const tokens = new Map<string, { kind: string; before: number; items: number; expires_at: number }>();
  let cached: StorageKindsResponse | undefined;

  /** A read of a table that may not exist on this server (a dbless boot, a store not composed). */
  const optional = <T>(read: () => T): T | undefined => {
    try { return read(); } catch { return undefined; }
  };
  const one = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T;

  const database = () => {
    const pageSize = Number(db.pragma('page_size', { simple: true }));
    return { file_bytes: Number(db.pragma('page_count', { simple: true })) * pageSize,
      free_bytes: Number(db.pragma('freelist_count', { simple: true })) * pageSize };
  };

  // ── The kinds ────────────────────────────────────────────────────────────────────────────────
  const recordsKinds = (since: number): StorageKindRow[] => {
    if (!deps.records) return [];
    const ready = new Set(deps.records.listNamespaces().filter((ns) => ns.state.state === 'ready')
      .map((ns) => `${ns.owner.publisher}/${ns.owner.pack_slug}`));
    const names = new Map<string, string>();
    const packWords = (owner: RecordsPackRef): string => {
      const key = `${owner.publisher}/${owner.pack_slug}`;
      if (!names.has(key)) {
        let name: string | null = null;
        try { name = deps.packName?.(owner) ?? null; } catch { name = null; }
        names.set(key, typeof name === 'string' && name.trim() ? name.trim() : storageKeyWords(owner.pack_slug));
      }
      return names.get(key)!;
    };
    return deps.records.ownerKindAges(since).map((row) => ({
      kind: recordsStorageKind(row.owner.publisher, row.owner.pack_slug, row.kind),
      group: 'records' as const,
      label: `${packWords(row.owner)} · ${storageKeyWords(row.kind)}`,
      items: row.rows,
      item_words: 'rows',
      bytes: row.payload_bytes,
      ...(row.oldest_updated_at !== null ? { oldest_at: row.oldest_updated_at } : {}),
      added_30d: row.added_since,
      ...(ready.has(`${row.owner.publisher}/${row.owner.pack_slug}`)
        ? { purge: { by: 'saved' as const, export: 'records' as const } } : { hold: 'not_yet' as const }),
    }));
  };

  const runsKind = (since: number): StorageKindRow | undefined => optional(() => {
    const { items, oldest } = one<{ items: number; oldest: number | null }>(`SELECT count(*) AS items, min(${STARTED}) AS oldest FROM audit_entries`);
    const added = one<{ n: number }>(`SELECT count(*) AS n FROM audit_entries WHERE ${STARTED} >= ?`, since).n;
    const bytes = optional(() => readAuditUsageBytes(db));
    return { kind: 'runs', group: 'activity', label: 'Run history', items, item_words: 'runs',
      ...(bytes !== undefined ? { bytes } : {}), ...(finite(oldest) !== undefined ? { oldest_at: oldest! } : {}), added_30d: added,
      purge: { by: 'started', export: 'runs' } };
  });

  const readingsKind = (since: number): StorageKindRow | undefined => optional(() => {
    const row = one<{ items: number; bytes: number; oldest: number | null; added: number }>(`SELECT count(*) AS items,
      coalesce(sum(length(value)),0) AS bytes, min(as_of) AS oldest, coalesce(sum(as_of >= ?),0) AS added FROM asset_reading_history`, since);
    return { kind: 'reading_history', group: 'assets', label: 'Reading history', items: row.items, item_words: 'readings',
      bytes: row.bytes, ...(row.oldest !== null ? { oldest_at: row.oldest } : {}), added_30d: row.added, purge: { by: 'taken' } };
  });

  const conversationsKind = (since: number): StorageKindRow | undefined => optional(() => {
    const row = one<{ items: number; oldest: number | null; added: number }>(`SELECT count(*) AS items, min(last_active_at) AS oldest,
      coalesce(sum(created_at >= ?),0) AS added FROM chat_sessions`, since);
    return { kind: 'conversations', group: 'conversations', label: 'Conversations', items: row.items, item_words: 'conversations',
      ...(row.oldest !== null ? { oldest_at: row.oldest } : {}), added_30d: row.added, hold: 'not_yet' };
  });

  const derivedKind = (since: number): StorageKindRow | undefined => optional(() => {
    const row = one<{ items: number; oldest: number | null; added: number }>(`SELECT count(*) AS items, min(ingested_at) AS oldest,
      coalesce(sum(ingested_at >= ?),0) AS added FROM data_enrichment`, since);
    return { kind: 'derived', group: 'derived', label: 'Derived facts', items: row.items, item_words: 'facts',
      ...(row.oldest !== null ? { oldest_at: row.oldest } : {}), added_30d: row.added, hold: 'with_source' };
  });

  const knowledgeKind = (): StorageKindRow | undefined => optional(() => ({
    kind: 'knowledge', group: 'yours', label: 'Your knowledge', items: one<{ n: number }>('SELECT count(*) AS n FROM user_memory').n,
    item_words: 'notes', hold: 'yours' as const,
  }));

  /** The copies and the shared data, from their gates: a size, with no count. */
  const gatedKinds = (): StorageKindRow[] => (optional(() => deps.gates?.() ?? []) ?? []).flatMap((gate): StorageKindRow[] => {
    const copy = /^collection:(mail|calendar|file):(.+)$/u.exec(gate.surface);
    if (copy) {
      const [, platform, slug] = copy;
      const words = platform === 'mail' ? 'Mail copies' : platform === 'calendar' ? 'Calendar copies' : 'File copies';
      return [{ kind: `${platform === 'file' ? 'files' : platform}:${slug}`, group: 'copies', label: `${words} · ${slug!}`, item_words: 'items',
        bytes: gate.used, hold: platform === 'mail' ? 'resyncs' : 'not_yet' }];
    }
    if (gate.surface === 'shared_store') {
      return [{ kind: 'shared', group: 'yours', label: 'Shared data', item_words: 'items', bytes: gate.used, hold: 'yours' }];
    }
    return [];
  });

  const read = (): StorageKindsResponse => {
    const at = now();
    if (cached && at - cached.measured_at < READ_TTL_MS) return cached;
    const since = at - 30 * DAY;
    const kinds = [
      ...recordsKinds(since),
      runsKind(since), readingsKind(since), conversationsKind(since), derivedKind(since), knowledgeKind(),
      ...gatedKinds(),
    ].filter((kind): kind is StorageKindRow => kind !== undefined);
    const order = (kind: StorageKindRow) => STORAGE_KIND_GROUPS.indexOf(kind.group);
    kinds.sort((a, b) => order(a) - order(b) || (b.bytes ?? 0) - (a.bytes ?? 0) || a.label.localeCompare(b.label));
    cached = { measured_at: at, database: database(), kinds };
    return cached;
  };

  // ── The purge ────────────────────────────────────────────────────────────────────────────────
  const count = (kind: string, before: number): Counted => {
    const pack = parseRecordsStorageKind(kind);
    if (pack) {
      if (!deps.records) throw new OwnerStorageError('unknown_kind', `${kind} is not a kind this server holds`);
      const row = deps.records.ownerCountOlderThan({ publisher: pack.publisher, pack_slug: pack.pack_slug }, pack.kind, before);
      return { items: row.rows, bytes: row.payload_bytes, ...(row.oldest !== null ? { oldest_at: row.oldest } : {}),
        ...(row.newest !== null ? { newest_at: row.newest } : {}) };
    }
    if (kind === 'runs') {
      const runs = one<{ items: number; bytes: number; oldest: number | null; newest: number | null }>(`SELECT count(*) AS items,
        coalesce(sum(length(data)),0) AS bytes, min(${STARTED}) AS oldest, max(${STARTED}) AS newest FROM audit_entries
        WHERE ${STARTED} < ? AND ${NOT_RESERVE} AND ${NOT_AWAITING}`, before);
      const activities = one<{ bytes: number }>(`SELECT coalesce(sum(length(data)),0) AS bytes FROM audit_activities
        WHERE ${AT} < ? AND ${NOT_RESERVE}`, before);
      return { items: runs.items, bytes: runs.bytes + activities.bytes, ...(finite(runs.oldest) !== undefined ? { oldest_at: runs.oldest! } : {}),
        ...(finite(runs.newest) !== undefined ? { newest_at: runs.newest! } : {}) };
    }
    if (kind === 'reading_history') {
      const row = one<{ items: number; bytes: number; oldest: number | null; newest: number | null }>(`SELECT count(*) AS items,
        coalesce(sum(length(value)),0) AS bytes, min(as_of) AS oldest, max(as_of) AS newest FROM asset_reading_history WHERE as_of < ?`, before);
      return { items: row.items, bytes: row.bytes, ...(row.oldest !== null ? { oldest_at: row.oldest } : {}), ...(row.newest !== null ? { newest_at: row.newest } : {}) };
    }
    const known = read().kinds.some((row) => row.kind === kind);
    throw known
      ? new OwnerStorageError('not_purgeable', `${kind} can't be purged here yet`)
      : new OwnerStorageError('unknown_kind', `${kind} is not a kind this server holds`);
  };

  const checkCutoff = (before: number) => {
    if (!Number.isSafeInteger(before) || before <= 0) throw new OwnerStorageError('bad_cutoff', 'before must be an epoch ms');
    if (before > now() - STORAGE_PURGE_MIN_AGE_MS) throw new OwnerStorageError('bad_cutoff', 'a purge keeps the last day: choose a date at least a day ago');
  };

  const preview = (kind: string, before: number): StoragePurgePreview => {
    checkCutoff(before);
    const counted = count(kind, before);
    const at = now();
    for (const [token, held] of tokens) if (held.expires_at <= at) tokens.delete(token);
    const token = randomBytes(16).toString('hex');
    const expires_at = at + STORAGE_PURGE_PREVIEW_TTL_MS;
    tokens.set(token, { kind, before, items: counted.items, expires_at });
    return { kind, before, ...counted, token, expires_at };
  };

  const purgeRecords = async (kind: string, before: number) => {
    const pack = parseRecordsStorageKind(kind)!;
    const owner = { publisher: pack.publisher, pack_slug: pack.pack_slug };
    let deleted = 0; let blocked = 0; let bytes = 0;
    for (;;) {
      // The rows a reference holds stay the oldest, so the next batch starts after them.
      const batch = deps.records!.ownerDeleteOlderThan(owner, pack.kind, before, RECORDS_BATCH, blocked);
      deleted += batch.deleted; blocked += batch.blocked; bytes += batch.payload_bytes;
      if (batch.deleted + batch.blocked < RECORDS_BATCH) break;
      await yieldToLoop();
    }
    return { deleted, blocked, bytes_freed: bytes };
  };

  const purgeRuns = async (before: number) => {
    const usage = () => optional(() => readAuditUsageBytes(db));
    const startBytes = usage();
    const pick = db.prepare(`SELECT key FROM audit_entries WHERE ${STARTED} < ? AND ${NOT_RESERVE} AND ${NOT_AWAITING} LIMIT ${RUN_BATCH}`);
    const dropRun = db.prepare('DELETE FROM audit_entries WHERE key = ?');
    // Each run's provenance links go with it: `links.memory_id` is the run's id.
    const dropLinks = optional(() => db.prepare('DELETE FROM links WHERE memory_id = ?'));
    let deleted = 0;
    for (;;) {
      const keys = (pick.all(before) as Array<{ key: string }>).map((row) => row.key);
      if (!keys.length) break;
      db.transaction(() => { for (const key of keys) { dropRun.run(key); dropLinks?.run(key); } })();
      deleted += keys.length;
      await yieldToLoop();
    }
    const dropActivities = db.prepare(`DELETE FROM audit_activities WHERE rowid IN
      (SELECT rowid FROM audit_activities WHERE ${AT} < ? AND ${NOT_RESERVE} LIMIT ${RUN_BATCH})`);
    while (dropActivities.run(before).changes > 0) await yieldToLoop();
    const endBytes = usage();
    return { deleted, blocked: 0, ...(startBytes !== undefined && endBytes !== undefined ? { bytes_freed: Math.max(0, startBytes - endBytes) } : {}) };
  };

  const purgeReadings = async (before: number, bytes?: number) => {
    const drop = db.prepare(`DELETE FROM asset_reading_history WHERE rowid IN
      (SELECT rowid FROM asset_reading_history WHERE as_of < ? LIMIT 2000)`);
    let deleted = 0;
    for (;;) {
      const changes = drop.run(before).changes;
      if (!changes) break;
      deleted += changes;
      await yieldToLoop();
    }
    return { deleted, blocked: 0, ...(bytes !== undefined ? { bytes_freed: bytes } : {}) };
  };

  const run = async (kind: string, before: number, token: string): Promise<StoragePurgeRunResult> => {
    checkCutoff(before);
    const held = tokens.get(token);
    tokens.delete(token);
    if (!held || held.kind !== kind || held.before !== before || held.expires_at <= now()) {
      throw new OwnerStorageError('stale_preview', 'That preview has expired. Preview again.');
    }
    const counted = count(kind, before);
    if (counted.items !== held.items) {
      throw new OwnerStorageError('stale_preview', `The items changed since the preview (${String(held.items)}, now ${String(counted.items)}). Preview again.`);
    }
    const result = parseRecordsStorageKind(kind) ? await purgeRecords(kind, before)
      : kind === 'runs' ? await purgeRuns(before)
        : await purgeReadings(before, counted.bytes);
    cached = undefined;
    if (deps.auditLog && result.deleted > 0) {
      try {
        await deps.auditLog.logActivity({ activity_id: '', timestamp: now(), action: 'source_data_purged', target: `storage:${kind}`,
          detail: JSON.stringify({ by: 'owner', kind, before, deleted: result.deleted, blocked: result.blocked,
            ...(result.bytes_freed !== undefined ? { bytes_freed: result.bytes_freed } : {}) }) });
      } catch { /* the purge happened; its record is best-effort, as a connection teardown's is */ }
    }
    return { kind, before, ...result };
  };

  return { read, preview, run };
};

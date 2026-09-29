import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  createAuditLogStore,
  type AuditLogStore,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';

import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  createCollectionTable,
  type CollectionTable,
} from '../collections/table.js';
import {
  createCollectionRetention,
  type CollectionRetention,
  type CollectionRetentionConfig,
} from '../collections/retention.js';
import type { CollectionRecord } from '@recued/contracts';

const MS_PER_DAY = 86_400_000;
const NOW = 1_700_000_000_000;

let db: Database.Database;
let table: CollectionTable;
let auditLog: AuditLogStore;
let retention: CollectionRetention;
let cfg: CollectionRetentionConfig;

const mkRecord = (overrides: Partial<CollectionRecord> = {}): CollectionRecord => {
  const record: CollectionRecord = {
    record_id: 'uid:1',
    received_at: NOW,
    modified_at: NOW,
    hot_fields: {},
    size_bytes: 10,
    source_id: '<msg>',
    body_inline: 'body',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete (record as unknown as Record<string, unknown>)[k];
    else (record as unknown as Record<string, unknown>)[k] = v;
  }
  return record;
};

beforeEach(() => {
  db = new Database(':memory:');
  table = createCollectionTable({ db, platform: 'mail', slug: 'work' });
  const entries = createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  const activities = createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  auditLog = createAuditLogStore(entries, activities);
  cfg = { retentionDays: 7 };
  retention = createCollectionRetention({
    table,
    platform: 'mail',
    slug: 'work',
    config: () => cfg,
    auditLog,
    now: () => NOW,
  });
});

afterEach(() => { db.close(); });

describe('age-based prune', () => {
  it('drops rows older than retentionDays', async () => {
    // Three records: 10 days old (prune), 5 days old (keep), now (keep).
    table.upsert(mkRecord({ record_id: 'old',  received_at: NOW - 10 * MS_PER_DAY, size_bytes: 40 }));
    table.upsert(mkRecord({ record_id: 'mid',  received_at: NOW - 5  * MS_PER_DAY, size_bytes: 20 }));
    table.upsert(mkRecord({ record_id: 'new',  received_at: NOW, size_bytes: 10 }));

    const result = await retention.run();
    expect(result.pruned_count).toBe(1);
    expect(result.bytes_freed).toBe(40);
    expect(result.skipped_reason).toBeUndefined();
    expect(table.get('old')).toBeNull();
    expect(table.get('mid')).not.toBeNull();
    expect(table.get('new')).not.toBeNull();
  });

  it('surfaces freed blob hashes for the orphan-CAS sweep', async () => {
    table.upsert(mkRecord({
      record_id: 'old',
      received_at: NOW - 10 * MS_PER_DAY,
      size_bytes: 100_000,
      body_inline: undefined,
      blob_hash: 'sha256:aabbcc',
    }));
    table.upsert(mkRecord({
      record_id: 'old2',
      received_at: NOW - 10 * MS_PER_DAY,
      size_bytes: 50,
      body_inline: 'inline-body',
    }));
    const result = await retention.run();
    expect(result.pruned_count).toBe(2);
    // Only the CAS record contributes to blob_hashes_freed.
    expect(result.blob_hashes_freed).toEqual(['sha256:aabbcc']);
  });

  it('returns a zero summary when nothing matches', async () => {
    table.upsert(mkRecord({ record_id: 'a', received_at: NOW, size_bytes: 10 }));
    const result = await retention.run();
    expect(result.pruned_count).toBe(0);
    expect(result.bytes_freed).toBe(0);
    expect(result.blob_hashes_freed).toEqual([]);
  });
});

describe('onPruned (D-315: a mail fact follows its email)', () => {
  const withHook = (onPruned: (ids: readonly string[]) => void): CollectionRetention =>
    createCollectionRetention({ table, platform: 'mail', slug: 'work', config: () => cfg, now: () => NOW, onPruned });

  it('is told which rows went, and only when some did', async () => {
    const calls: (readonly string[])[] = [];
    const pruner = withHook((ids) => calls.push(ids));
    table.upsert(mkRecord({ record_id: 'old', received_at: NOW - 10 * MS_PER_DAY }));
    table.upsert(mkRecord({ record_id: 'new', received_at: NOW }));
    await pruner.run();
    await pruner.run();
    expect(calls).toEqual([['old']]);
  });

  it('never fails the prune when it throws — the rows are already gone', async () => {
    const pruner = withHook(() => {
      throw new Error('fact store locked');
    });
    table.upsert(mkRecord({ record_id: 'old', received_at: NOW - 10 * MS_PER_DAY }));
    await expect(pruner.run()).resolves.toMatchObject({ pruned_count: 1 });
    expect(table.get('old')).toBeNull();
  });
});

describe('retention disabled (retentionDays = 0)', () => {
  it('skips pruning and reports the reason', async () => {
    cfg = { retentionDays: 0 };
    table.upsert(mkRecord({ record_id: 'ancient', received_at: 1_000, size_bytes: 10 }));
    const result = await retention.run();
    expect(result.skipped_reason).toBe('retention_disabled');
    expect(result.pruned_count).toBe(0);
    expect(table.get('ancient')).not.toBeNull();
  });

  it('coerces invalid retentionDays to 0', async () => {
    cfg = { retentionDays: -5 };
    table.upsert(mkRecord({ record_id: 'ancient', received_at: 1_000, size_bytes: 10 }));
    const result = await retention.run();
    expect(result.skipped_reason).toBe('retention_disabled');
    expect(table.get('ancient')).not.toBeNull();
  });

  it('coerces non-integer retentionDays to its floor', async () => {
    cfg = { retentionDays: 7.9 };
    // 7.9 floors to 7. A 10-day-old row still gets pruned.
    table.upsert(mkRecord({ record_id: 'old', received_at: NOW - 10 * MS_PER_DAY, size_bytes: 10 }));
    const result = await retention.run();
    expect(result.pruned_count).toBe(1);
    expect(result.skipped_reason).toBeUndefined();
  });
});

describe('audit activity', () => {
  it('emits a reserve-class collection_retention_prune on successful prune', async () => {
    table.upsert(mkRecord({ record_id: 'old', received_at: NOW - 10 * MS_PER_DAY, size_bytes: 40 }));
    await retention.run();
    const activities = await auditLog.listActivities(10);
    const prune = activities.find((a) => a.action === 'collection_retention_prune');
    expect(prune).toBeDefined();
    expect(prune?.target).toBe('collection:mail:work');
    expect(prune?.detail).toMatch(/rows=1/);
    expect(prune?.detail).toMatch(/bytes=40/);
    // Auto-classified as reserve via RESERVE_ACTIONS.
    expect(prune?.reserve).toBe(true);
  });

  it('does not emit an activity when nothing was pruned', async () => {
    // Retention enabled but no old rows.
    table.upsert(mkRecord({ record_id: 'fresh', received_at: NOW, size_bytes: 10 }));
    await retention.run();
    const activities = await auditLog.listActivities(10);
    expect(activities.find((a) => a.action === 'collection_retention_prune')).toBeUndefined();
  });

  it('is skipped entirely (no audit) when retention is disabled', async () => {
    cfg = { retentionDays: 0 };
    table.upsert(mkRecord({ record_id: 'old', received_at: NOW - 10 * MS_PER_DAY }));
    await retention.run();
    const activities = await auditLog.listActivities(10);
    expect(activities.find((a) => a.action === 'collection_retention_prune')).toBeUndefined();
  });
});

describe('runSafe — error handling', () => {
  it('returns null and logs an error activity on throw', async () => {
    const boomRetention = createCollectionRetention({
      table: {
        ...table,
        pruneOlderThan: () => { throw new Error('disk full'); },
      } as CollectionTable,
      platform: 'mail',
      slug: 'work',
      config: () => ({ retentionDays: 7 }),
      auditLog,
      now: () => NOW,
    });
    const result = await boomRetention.runSafe();
    expect(result).toBeNull();
    const activities = await auditLog.listActivities(10);
    const err = activities.find((a) => a.action === 'collection_retention_prune');
    expect(err?.detail).toMatch(/^error: disk full/);
    // Even the error row gets auto-classified reserve.
    expect(err?.reserve).toBe(true);
  });

  it('does not throw when the audit log is itself broken', async () => {
    const noopAuditLog = {
      ...auditLog,
      logActivity: async () => { throw new Error('audit broken'); },
    } as AuditLogStore;
    const broken = createCollectionRetention({
      table: {
        ...table,
        pruneOlderThan: () => { throw new Error('disk full'); },
      } as CollectionTable,
      platform: 'mail',
      slug: 'work',
      config: () => ({ retentionDays: 7 }),
      auditLog: noopAuditLog,
      now: () => NOW,
    });
    // Must return null, not throw, even when the error-path audit log
    // also throws.
    await expect(broken.runSafe()).resolves.toBeNull();
  });
});

describe('coalesce', () => {
  it('returns the same Promise while a run is in flight', async () => {
    // Seed a pruneable row so each call has real work.
    table.upsert(mkRecord({ record_id: 'old', received_at: NOW - 10 * MS_PER_DAY, size_bytes: 10 }));
    // Both calls hit run() before the first resolves. A well-behaved
    // coalesce returns the same result from the same execution.
    const [a, b] = await Promise.all([retention.run(), retention.run()]);
    expect(a).toEqual(b);
    // Only one audit activity, proving both callers shared the one
    // execution (not two separate prunes).
    const activities = await auditLog.listActivities(10);
    expect(activities.filter((x) => x.action === 'collection_retention_prune').length).toBe(1);
  });

  it('runs independently once the prior call resolves', async () => {
    table.upsert(mkRecord({ record_id: 'old1', received_at: NOW - 10 * MS_PER_DAY, size_bytes: 10 }));
    await retention.run();
    table.upsert(mkRecord({ record_id: 'old2', received_at: NOW - 10 * MS_PER_DAY, size_bytes: 20 }));
    const second = await retention.run();
    expect(second.pruned_count).toBe(1);
    expect(second.bytes_freed).toBe(20);
  });
});

describe('works without an audit log', () => {
  it('prunes silently when auditLog is omitted', async () => {
    const noAudit = createCollectionRetention({
      table,
      platform: 'mail',
      slug: 'work',
      config: () => ({ retentionDays: 7 }),
      now: () => NOW,
    });
    table.upsert(mkRecord({ record_id: 'old', received_at: NOW - 10 * MS_PER_DAY, size_bytes: 10 }));
    const result = await noAudit.run();
    expect(result.pruned_count).toBe(1);
  });
});

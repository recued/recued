/** D-145 PA9 — `task_signal_density_per_thread` producer tests.
 *
 *  Ninth D-145 PA9 producer impl + second per-record producer on
 *  `walker_kind: 'mail-thread'`, after [[thread_signals]]. Shares the
 *  body-blind mail walker; differs in what it counts (task signals,
 *  not participants / span). Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration two-collection shape)
 *    - threadIdOfMail extractor (string / missing / non-string)
 *    - computeTaskSignalDensity pure cases (zero divisor guard,
 *      non-finite defensiveness, density > 1)
 *    - countTasksLinkedToThread SQL (linkage narrow, tombstone exclusion,
 *      sync_state filter, empty-id short-circuit)
 *    - countMailSiblingsInThread SQL (cross-table scan, thread_id JSON
 *      narrow, empty-id short-circuit)
 *    - produce() integration: empty thread_id → density 0 row,
 *      thread of N + M tasks, deleted tasks excluded, multi-mail-account
 *      sibling sum, defensive single-mail fallback when sibling scan returns 0
 *    - Registry value_schema acceptance round-trip
 *    - Registry shape + cadence + scope alignment
 *    - Declaration + registry producer_kind alignment ('housekeeping') */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  TASK_SIGNAL_DENSITY_PER_THREAD_DECLARATION,
  type CollectionRecord,
  type TaskSignalDensityValue,
} from '@recued/contracts';

import {
  computeTaskSignalDensity,
  countMailSiblingsInThread,
  countTasksLinkedToThread,
  taskSignalDensityPerThreadProducer,
  threadIdOfMail,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import { TASK_TABLE } from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;

// One mail collection table for the simple-thread tests + a second
// table for the multi-account sibling-sum case.
const MAIL_TABLE_PRIMARY = 'collection_mail_primary';
const MAIL_TABLE_SECONDARY = 'collection_mail_secondary';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-task-density-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Mirror columns the producer reads. The mail-collection layer uses
  // `collection_mail_<hash>`; the producer enumerates them via
  // sqlite_master + scans each, so the fixture table names need only
  // start with the `collection_mail_` prefix.
  const createMailTable = (name: string): void => {
    db.exec(`
      CREATE TABLE ${name} (
        record_id   TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        hot_fields  TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        source_id   TEXT NOT NULL,
        body_inline TEXT,
        blob_hash   TEXT
      );
    `);
  };
  createMailTable(MAIL_TABLE_PRIMARY);
  createMailTable(MAIL_TABLE_SECONDARY);
  // Minimal task table — only the columns the producer reads.
  db.exec(`
    CREATE TABLE ${TASK_TABLE} (
      id                    TEXT PRIMARY KEY,
      linked_mail_thread_id TEXT,
      sync_state            TEXT NOT NULL DEFAULT 'live',
      deleted_at            INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const insertMail = (
  table: string,
  record_id: string,
  hot: Record<string, unknown>,
): void => {
  db.prepare(
    `INSERT INTO ${table} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(record_id, NOW, NOW, JSON.stringify(hot), 100, record_id);
};

interface TaskRow {
  id: string;
  linked_mail_thread_id?: string | null;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertTask = (row: TaskRow): void => {
  db.prepare(
    `INSERT INTO ${TASK_TABLE} (id, linked_mail_thread_id, sync_state, deleted_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    row.id,
    row.linked_mail_thread_id ?? null,
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
});

const sourceFor = (table: string, record_id: string): SourceRecord => {
  const row = db
    .prepare(`SELECT * FROM ${table} WHERE record_id = ?`)
    .get(record_id) as
    | {
        record_id: string;
        received_at: number;
        modified_at: number;
        hot_fields: string;
        size_bytes: number;
        source_id: string;
      }
    | undefined;
  if (!row) throw new Error(`fixture mail '${record_id}' missing from '${table}'`);
  const data: CollectionRecord = {
    record_id: row.record_id,
    received_at: row.received_at,
    modified_at: row.modified_at,
    hot_fields: JSON.parse(row.hot_fields) as Record<string, unknown>,
    size_bytes: row.size_bytes,
    source_id: row.source_id,
  };
  return { target_id: record_id, data, cursor_token: record_id };
};

const expectValue = async (
  ctx: HousekeepingContext,
  src: SourceRecord,
): Promise<TaskSignalDensityValue> => {
  const out = await taskSignalDensityPerThreadProducer.produce(ctx, src);
  if (out === null) throw new Error(`expected producer output, got null`);
  return out.value as TaskSignalDensityValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('taskSignalDensityPerThreadProducer surface contract', () => {
  it('targets the task_signal_density_per_thread registry topic', () => {
    expect(taskSignalDensityPerThreadProducer.topic).toBe(
      'task_signal_density_per_thread',
    );
  });

  it('targets the mail source scope (shared with thread_signals)', () => {
    expect(taskSignalDensityPerThreadProducer.source_scope).toBe('mail');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(taskSignalDensityPerThreadProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(taskSignalDensityPerThreadProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(taskSignalDensityPerThreadProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for mail + task with the load-bearing fields', () => {
    const decls = taskSignalDensityPerThreadProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual(['data.mail', 'data.task']);
    expect(decls.find((e) => e.collection === 'data.mail')!.sample_field_paths).toEqual([
      'thread_id',
      'record_id',
    ]);
    expect(decls.find((e) => e.collection === 'data.task')!.sample_field_paths).toEqual([
      'linked_mail_thread_id',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Producer-kind alignment (declaration + registry both housekeeping)
// ────────────────────────────────────────────────────────────────

describe('producer_kind alignment', () => {
  it('declaration carries producer_kind: "housekeeping" (matches outbound_commitment_overdue_count precedent)', () => {
    expect(TASK_SIGNAL_DENSITY_PER_THREAD_DECLARATION.producer_kind).toBe('housekeeping');
  });

  it('registry entry carries producer_kind: "housekeeping" so buildEnrichmentProducerTask accepts it', () => {
    expect(ENRICHMENT_REGISTRY.task_signal_density_per_thread.producer_kind).toBe(
      'housekeeping',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// threadIdOfMail pure cases
// ────────────────────────────────────────────────────────────────

describe('threadIdOfMail', () => {
  const record = (hot: Record<string, unknown>): CollectionRecord => ({
    record_id: 'm1',
    received_at: NOW,
    modified_at: NOW,
    hot_fields: hot,
    size_bytes: 100,
    source_id: 'm1',
  });

  it('returns the thread_id string when present', () => {
    expect(threadIdOfMail(record({ thread_id: 'T123' }))).toBe('T123');
  });

  it('returns "" when thread_id is missing entirely', () => {
    expect(threadIdOfMail(record({}))).toBe('');
  });

  it('returns "" when thread_id is null', () => {
    expect(threadIdOfMail(record({ thread_id: null }))).toBe('');
  });

  it('returns "" when thread_id is a non-string', () => {
    expect(threadIdOfMail(record({ thread_id: 42 }))).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────
// computeTaskSignalDensity pure cases
// ────────────────────────────────────────────────────────────────

describe('computeTaskSignalDensity', () => {
  it('returns 0.2 for 1 task over 5 messages', () => {
    expect(computeTaskSignalDensity(1, 5)).toBeCloseTo(0.2, 10);
  });

  it('returns 0 when message_count is 0 (zero-divisor guard)', () => {
    expect(computeTaskSignalDensity(3, 0)).toBe(0);
  });

  it('returns 0 when message_count is negative (defensive)', () => {
    expect(computeTaskSignalDensity(3, -1)).toBe(0);
  });

  it('allows density > 1 (high-signal thread-of-one with multiple tasks)', () => {
    expect(computeTaskSignalDensity(3, 1)).toBe(3);
  });

  it('returns 0 for non-finite signal_count (NaN defensiveness)', () => {
    expect(computeTaskSignalDensity(Number.NaN, 5)).toBe(0);
  });

  it('returns 0 for non-finite message_count (Infinity defensiveness)', () => {
    expect(computeTaskSignalDensity(2, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// countTasksLinkedToThread SQL
// ────────────────────────────────────────────────────────────────

describe('countTasksLinkedToThread', () => {
  it('returns 0 for an empty thread_id', () => {
    expect(countTasksLinkedToThread(stubCtx(), '')).toBe(0);
  });

  it('returns 0 when no tasks link to the thread', () => {
    insertTask({ id: 't1', linked_mail_thread_id: 'OTHER' });
    expect(countTasksLinkedToThread(stubCtx(), 'T123')).toBe(0);
  });

  it('counts tasks linked to the thread', () => {
    insertTask({ id: 't1', linked_mail_thread_id: 'T123' });
    insertTask({ id: 't2', linked_mail_thread_id: 'T123' });
    insertTask({ id: 't3', linked_mail_thread_id: 'OTHER' });
    expect(countTasksLinkedToThread(stubCtx(), 'T123')).toBe(2);
  });

  it('excludes tombstoned tasks (deleted_at set)', () => {
    insertTask({ id: 't1', linked_mail_thread_id: 'T123' });
    insertTask({ id: 't2', linked_mail_thread_id: 'T123', deleted_at: NOW });
    expect(countTasksLinkedToThread(stubCtx(), 'T123')).toBe(1);
  });

  it('excludes tombstoned sync_state (non-live, non-stale_unreachable)', () => {
    insertTask({ id: 't1', linked_mail_thread_id: 'T123' });
    insertTask({ id: 't2', linked_mail_thread_id: 'T123', sync_state: 'tombstoned' });
    expect(countTasksLinkedToThread(stubCtx(), 'T123')).toBe(1);
  });

  it('includes stale_unreachable sync_state (mid-flight resync still counts)', () => {
    insertTask({ id: 't1', linked_mail_thread_id: 'T123', sync_state: 'stale_unreachable' });
    expect(countTasksLinkedToThread(stubCtx(), 'T123')).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// countMailSiblingsInThread SQL
// ────────────────────────────────────────────────────────────────

describe('countMailSiblingsInThread', () => {
  it('returns 0 for an empty thread_id', () => {
    expect(countMailSiblingsInThread(stubCtx(), '')).toBe(0);
  });

  it('returns 0 when no mails carry the thread_id', () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'OTHER' });
    expect(countMailSiblingsInThread(stubCtx(), 'T123')).toBe(0);
  });

  it('counts siblings within one collection table', () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_PRIMARY, 'm2', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_PRIMARY, 'm3', { thread_id: 'OTHER' });
    expect(countMailSiblingsInThread(stubCtx(), 'T123')).toBe(2);
  });

  it('sums siblings across multiple mail collection tables (multi-account)', () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_PRIMARY, 'm2', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_SECONDARY, 's1', { thread_id: 'T123' });
    expect(countMailSiblingsInThread(stubCtx(), 'T123')).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('taskSignalDensityPerThreadProducer.produce', () => {
  it('emits density=0 for a mail with no thread_id (degenerate thread of one)', async () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: '' });
    const value = await expectValue(stubCtx(), sourceFor(MAIL_TABLE_PRIMARY, 'm1'));
    expect(value).toEqual({ density: 0, signal_count: 0, computed_at: NOW });
  });

  it('emits density=0 when the thread has messages but no linked tasks', async () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_PRIMARY, 'm2', { thread_id: 'T123' });
    const value = await expectValue(stubCtx(), sourceFor(MAIL_TABLE_PRIMARY, 'm1'));
    expect(value).toEqual({ density: 0, signal_count: 0, computed_at: NOW });
  });

  it('emits density = task_count / message_count for a thread with linked tasks', async () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_PRIMARY, 'm2', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_PRIMARY, 'm3', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_PRIMARY, 'm4', { thread_id: 'T123' });
    insertMail(MAIL_TABLE_PRIMARY, 'm5', { thread_id: 'T123' });
    insertTask({ id: 't1', linked_mail_thread_id: 'T123' });
    const value = await expectValue(stubCtx(), sourceFor(MAIL_TABLE_PRIMARY, 'm1'));
    expect(value.density).toBeCloseTo(0.2, 10);
    expect(value.signal_count).toBe(1);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits density > 1 for a thread-of-one with multiple linked tasks (high-signal short thread)', async () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'T_SHORT' });
    insertTask({ id: 't1', linked_mail_thread_id: 'T_SHORT' });
    insertTask({ id: 't2', linked_mail_thread_id: 'T_SHORT' });
    insertTask({ id: 't3', linked_mail_thread_id: 'T_SHORT' });
    const value = await expectValue(stubCtx(), sourceFor(MAIL_TABLE_PRIMARY, 'm1'));
    expect(value.density).toBe(3);
    expect(value.signal_count).toBe(3);
  });

  it('excludes tombstoned tasks from signal_count', async () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'T123' });
    insertTask({ id: 't1', linked_mail_thread_id: 'T123' });
    insertTask({ id: 't2', linked_mail_thread_id: 'T123', deleted_at: NOW });
    const value = await expectValue(stubCtx(), sourceFor(MAIL_TABLE_PRIMARY, 'm1'));
    expect(value.signal_count).toBe(1);
    expect(value.density).toBe(1);
  });

  it('sums siblings across multiple mail collection tables (multi-account thread)', async () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'T_CROSS' });
    insertMail(MAIL_TABLE_SECONDARY, 's1', { thread_id: 'T_CROSS' });
    insertMail(MAIL_TABLE_SECONDARY, 's2', { thread_id: 'T_CROSS' });
    insertTask({ id: 't1', linked_mail_thread_id: 'T_CROSS' });
    const value = await expectValue(stubCtx(), sourceFor(MAIL_TABLE_PRIMARY, 'm1'));
    expect(value.density).toBeCloseTo(1 / 3, 10);
    expect(value.signal_count).toBe(1);
  });

  it('falls back to "thread of one" when sibling SQL scan misses (defensive)', async () => {
    // Source mail isn't committed to any mail collection table —
    // simulates a transient case where the walker handed us a record
    // whose row hasn't landed yet. Producer treats the input mail as
    // its own thread of one so we never divide by zero.
    const orphanSource: SourceRecord = {
      target_id: 'm_orphan',
      data: {
        record_id: 'm_orphan',
        received_at: NOW,
        modified_at: NOW,
        hot_fields: { thread_id: 'T_ORPHAN' },
        size_bytes: 100,
        source_id: 'm_orphan',
      },
      cursor_token: 'm_orphan',
    };
    insertTask({ id: 't1', linked_mail_thread_id: 'T_ORPHAN' });
    insertTask({ id: 't2', linked_mail_thread_id: 'T_ORPHAN' });
    const value = await expectValue(stubCtx(), orphanSource);
    expect(value.density).toBe(2);
    expect(value.signal_count).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value-schema round-trip
// ────────────────────────────────────────────────────────────────

describe('registry value_schema acceptance', () => {
  it('registry validator accepts a producer-shaped value', async () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', { thread_id: 'T123' });
    insertTask({ id: 't1', linked_mail_thread_id: 'T123' });
    const value = await expectValue(stubCtx(), sourceFor(MAIL_TABLE_PRIMARY, 'm1'));
    const result =
      ENRICHMENT_REGISTRY.task_signal_density_per_thread.value_schema(value);
    expect(result.ok).toBe(true);
  });
});

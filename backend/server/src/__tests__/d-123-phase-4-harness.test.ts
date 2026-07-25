/** D-123 Phase 4 — Enrichment producer harness tests.
 *
 *  Drives the harness with a stub `SourceCollectionWalker` so the
 *  contract is exercised in isolation from live mail collections.
 *  Verifies cursor advancement, hash-based skip-rule, upsert
 *  authorship, stale-row sweep, budget yield, and `onInvalidate`
 *  no-op semantics. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CollectionRecord,
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import {
  buildEnrichmentProducerTask,
  enrichmentProducerAuthoredBy,
  HOUSEKEEPING_AUTHORED_BY_PREFIX,
} from '../housekeeping/enrichment-producer.js';
import type { HousekeepingEnrichmentProducer } from '../housekeeping/enrichment-producer.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import type {
  SourceCollectionWalker,
  SourceRecord,
} from '../housekeeping/source-walkers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let now = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-p4-harness-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
  now = 1_700_000_000_000;
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const fakeMail = (record_id: string, hot: Record<string, unknown> = {}): CollectionRecord => ({
  record_id,
  received_at: now,
  modified_at: now,
  hot_fields: hot,
  size_bytes: 100,
  source_id: record_id,
});

/** Stub walker — yields a fixed list of records, hashes by JSON
 *  string of `target_id + hash_seed`. */
const stubWalker = (records: SourceRecord[], hash_seed = 'v1'): SourceCollectionWalker => ({
  *walkAfter(cursor_token: string, batch_size: number) {
    let yielded = 0;
    for (const record of records) {
      if (record.cursor_token <= cursor_token) continue;
      if (yielded >= batch_size) return;
      yield record;
      yielded += 1;
    }
  },
  hashOf(record) {
    return `${hash_seed}:${record.target_id}`;
  },
  fetchOne(target_id) {
    return records.find((r) => r.target_id === target_id) ?? null;
  },
});

const sourceRecord = (id: string, hot: Record<string, unknown> = {}): SourceRecord => ({
  target_id: id,
  data: fakeMail(id, hot),
  cursor_token: id, // monotonic by id; tests sort to ensure ASC
});

const STUB_SCOPE_READ_DECLARATION = [
  { collection: 'data.mail', sample_field_paths: ['subject', 'thread_id'] },
] as const;

const dependentProducer = (
  produceImpl?: (rec: SourceRecord) => unknown | null,
): HousekeepingEnrichmentProducer => ({
  // 'purpose' is a `dependent` policy / scope:'mail' / housekeeping
  // topic with a permissive `acceptObject` schema — fine for the
  // harness-shape tests below, which don't care about the value
  // payload. (Using 'embedding' here would clash with the strict
  // schema D-131 A.3 ships alongside this file.)
  topic: 'purpose',
  source_scope: 'mail',
  scope_read_declaration: STUB_SCOPE_READ_DECLARATION,
  estimate_per_record_tokens: () => 0,
  async produce(_ctx, record) {
    const value = produceImpl ? produceImpl(record) : { sample: record.target_id };
    if (value === null) return null;
    return { value };
  },
});

const aggregateProducer = (
  produceImpl?: (rec: SourceRecord) => unknown | null,
): HousekeepingEnrichmentProducer => ({
  // thread_signals is `aggregate` policy. D-136 P3 follow-up replaced
  // the legacy `acceptObject` schema with a concrete validator
  // (Codex review fix), so the default value here returns a well-
  // formed ThreadSignalsValue instead of the original `{ sample: ... }`
  // shape — the harness-shape tests below don't care about the
  // payload contents, just that produce was called.
  topic: 'thread_signals',
  source_scope: 'mail',
  scope_read_declaration: STUB_SCOPE_READ_DECLARATION,
  estimate_per_record_tokens: () => 0,
  async produce(_ctx, record) {
    const value = produceImpl
      ? produceImpl(record)
      : {
          thread_id: record.target_id,
          message_count: 1,
          participant_count: 1,
          span_days: 0,
          has_unread: false,
        };
    if (value === null) return null;
    return { value };
  },
});

const stepWith = async (
  task: HousekeepingTaskInstance,
  cursor: HousekeepingCursor,
  budget_ms = 60_000,
): Promise<HousekeepingStepResult> =>
  task.step(stubCtx(), cursor, budget_ms);

describe('buildEnrichmentProducerTask — registry validation', () => {
  it('throws when topic is unknown', () => {
    expect(() =>
      buildEnrichmentProducerTask({
        producer: { ...aggregateProducer(), topic: 'NOPE' as never },
        walker: stubWalker([]),
      }),
    ).toThrow(/enrichment_topic_unknown/);
  });

  it("throws when topic's producer_kind is 'reactive'", () => {
    expect(() =>
      buildEnrichmentProducerTask({
        producer: {
          ...aggregateProducer(),
          topic: 'contact_timeline_rollup',
          source_scope: 'contact',
        },
        walker: stubWalker([]),
      }),
    ).toThrow(/enrichment_producer_kind_mismatch/);
  });

  it('throws when source_scope is outside the registry valid_scopes', () => {
    expect(() =>
      buildEnrichmentProducerTask({
        producer: {
          ...aggregateProducer(),
          source_scope: 'contact', // thread_signals only allows 'mail'
        },
        walker: stubWalker([]),
      }),
    ).toThrow(/enrichment_scope_unsupported/);
  });

  it('builds metadata with kind:enrichment + id:enrichment.<topic>', () => {
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer(),
      walker: stubWalker([]),
    });
    expect(task.meta.id).toBe('enrichment.thread_signals');
    expect(task.meta.kind).toBe('enrichment');
    expect(task.meta.interruptible).toBe(true);
    expect(typeof task.meta.description).toBe('string');
  });
});

describe('buildEnrichmentProducerTask — forward walk', () => {
  it('processes every source record and writes one enrichment row per target_id', async () => {
    const records = ['a', 'b', 'c'].map((id) => sourceRecord(id));
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer(),
      walker: stubWalker(records),
    });
    const result = await stepWith(task, { kind: 'complete' });
    expect(result.status).toBe('complete');

    const rows = store.list({ topic: 'thread_signals' });
    expect(rows.map((r) => r.target_id).sort()).toEqual(['a', 'b', 'c']);
    for (const row of rows) {
      expect(row.authored_by).toBe(`${HOUSEKEEPING_AUTHORED_BY_PREFIX}.thread_signals`);
      expect(row.scope).toBe('mail');
    }
  });

  it('advances the cursor to the last seen cursor_token on complete', async () => {
    const records = ['a', 'b', 'c'].map((id) => sourceRecord(id));
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer(),
      walker: stubWalker(records),
    });
    const result = await stepWith(task, { kind: 'complete' });
    expect(result.cursor).toMatchObject({
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: 'c',
    });
  });

  it('skips records whose source_record_hash matches existing fresh enrichment row', async () => {
    const produceImpl = vi.fn();
    const records = [sourceRecord('a'), sourceRecord('b')];
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer((rec) => {
        produceImpl();
        return {
          thread_id: rec.target_id,
          message_count: 1,
          participant_count: 1,
          span_days: 0,
          has_unread: false,
        };
      }),
      walker: stubWalker(records, 'v1'),
    });
    // First run — produces both.
    await stepWith(task, { kind: 'complete' });
    expect(store.list({ topic: 'thread_signals' })).toHaveLength(2);
    expect(produceImpl).toHaveBeenCalledTimes(2);
    produceImpl.mockClear();

    // Second run starts from cursor=empty so forward-walk re-visits
    // every record; same hash → harness skips produce() entirely.
    await stepWith(task, {
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: '',
    });
    expect(produceImpl).not.toHaveBeenCalled();
  });

  it('re-runs produce when the source hash changes (walker hash_seed differs)', async () => {
    const records = [sourceRecord('a')];
    let walker = stubWalker(records, 'v1');
    const produced: string[] = [];
    const producer: HousekeepingEnrichmentProducer = {
      ...aggregateProducer(),
      async produce(_ctx, rec) {
        produced.push(rec.target_id);
        return {
          value: {
            thread_id: rec.target_id,
            message_count: produced.length,
            participant_count: 1,
            span_days: 0,
            has_unread: false,
          },
        };
      },
    };
    let task = buildEnrichmentProducerTask({ producer, walker });
    await stepWith(task, { kind: 'complete' });
    expect(produced).toEqual(['a']);

    // Walker now hashes the same record differently — a source
    // change. Harness re-runs produce().
    walker = stubWalker(records, 'v2');
    task = buildEnrichmentProducerTask({ producer, walker });
    await stepWith(task, {
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: '',
    });
    expect(produced).toEqual(['a', 'a']);

    const rows = store.list({ topic: 'thread_signals' });
    expect(rows).toHaveLength(1);
    expect((rows[0].value as { message_count: number }).message_count).toBe(2);
  });

  it('skips records the producer returns null for (no row written)', async () => {
    const records = [sourceRecord('a'), sourceRecord('b'), sourceRecord('c')];
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer((rec) =>
        rec.target_id === 'b'
          ? null
          : {
              thread_id: rec.target_id,
              message_count: 1,
              participant_count: 1,
              span_days: 0,
              has_unread: false,
            },
      ),
      walker: stubWalker(records),
    });
    await stepWith(task, { kind: 'complete' });
    const rows = store.list({ topic: 'thread_signals' });
    expect(rows.map((r) => r.target_id).sort()).toEqual(['a', 'c']);
  });
});

describe('buildEnrichmentProducerTask — budget yield', () => {
  it('yields when budget runs out mid-walk', async () => {
    const records = Array.from({ length: 50 }, (_, i) => sourceRecord(`r${String(i).padStart(3, '0')}`));
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer(),
      walker: stubWalker(records),
    });
    const result = await task.step(stubCtx(), { kind: 'complete' }, 0);
    expect(result.status).toBe('yield');
    if (result.status === 'yield') {
      expect(result.reason).toBe('budget_exhausted');
      expect(result.cursor.kind).toBe('topic');
    }
  });

  it('persists the cursor at yield so the next call resumes', async () => {
    let nowCounter = now;
    const ctxThatBleedsBudget: HousekeepingContext = {
      ...stubCtx(),
      now: () => {
        // Each call advances 100ms so a budget of 250ms allows
        // ~2 records before the yield trips.
        const t = nowCounter;
        nowCounter += 100;
        return t;
      },
    };
    const records = ['a', 'b', 'c', 'd', 'e'].map((id) => sourceRecord(id));
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer(),
      walker: stubWalker(records),
    });

    const first = await task.step(ctxThatBleedsBudget, { kind: 'complete' }, 250);
    expect(first.status).toBe('yield');
    if (first.status === 'yield') {
      // Cursor must point at one of the early records.
      expect(['a', 'b', 'c']).toContain((first.cursor as { max_target_id_seen?: string }).max_target_id_seen);
    }
  });
});

describe('buildEnrichmentProducerTask — stale-row sweep (dependent policy)', () => {
  it('re-derives stale rows for dependent topics on subsequent step', async () => {
    const records = [sourceRecord('a'), sourceRecord('b')];
    let producedHashes: string[] = [];
    const producer: HousekeepingEnrichmentProducer = {
      ...dependentProducer(),
      async produce(_ctx, rec) {
        producedHashes.push(rec.target_id);
        return { value: { tag: rec.target_id } };
      },
    };
    const task = buildEnrichmentProducerTask({
      producer,
      walker: stubWalker(records),
    });

    // First step — produces both.
    await stepWith(task, { kind: 'complete' });
    expect(producedHashes).toEqual(['a', 'b']);
    producedHashes = [];

    // Mark row for 'a' stale, then step again — sweep re-derives it
    // even though the forward-cursor is past 'b'.
    const rowsBefore = store.list({ topic: 'purpose' });
    expect(rowsBefore).toHaveLength(2);
    db.prepare(`UPDATE data_enrichment SET staleness_class = 'stale' WHERE target_id = 'a'`).run();

    await stepWith(task, {
      kind: 'topic',
      topic: 'purpose',
      scope: 'mail',
      max_target_id_seen: 'b', // forward walk has nothing left
    });
    expect(producedHashes).toEqual(['a']);
    const rowsAfter = store.list({ topic: 'purpose' });
    expect(rowsAfter.find((r) => r.target_id === 'a')?.staleness_class).toBe('fresh');
  });

  it('re-derives stale aggregate-policy rows on subsequent step (D-145 § A.7.9)', async () => {
    const records = [sourceRecord('a')];
    const producer: HousekeepingEnrichmentProducer = aggregateProducer();
    const task = buildEnrichmentProducerTask({
      producer,
      walker: stubWalker(records),
    });
    await stepWith(task, { kind: 'complete' });
    // Mark stale.
    db.prepare(
      `UPDATE data_enrichment SET staleness_class = 'stale' WHERE target_id = 'a'`,
    ).run();

    // D-145 § A.7.9 — aggregate topics now participate in stale-row
    // sweep so cross-entity input changes (which the source-record
    // hash doesn't capture) trigger re-derivation. Run past 'a' so
    // only the sweep can pick it up.
    await stepWith(task, {
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: 'a',
    });
    const rows = store.list({ topic: 'thread_signals', fresh_only: false });
    expect(rows.find((r) => r.target_id === 'a')?.staleness_class).toBe('fresh');
  });

  it('deletes the row when the stale source has vanished from the walker', async () => {
    // Producer ran against 'a' once; walker.fetchOne returns null
    // → harness defensively deletes the orphan row.
    const records = [sourceRecord('a')];
    const producer = dependentProducer();
    let task = buildEnrichmentProducerTask({
      producer,
      walker: stubWalker(records),
    });
    await stepWith(task, { kind: 'complete' });
    expect(store.list({ topic: 'purpose' })).toHaveLength(1);

    db.prepare(`UPDATE data_enrichment SET staleness_class = 'stale' WHERE target_id = 'a'`).run();
    // Walker now reports no records — fetchOne returns null.
    task = buildEnrichmentProducerTask({
      producer,
      walker: stubWalker([]),
    });
    await stepWith(task, {
      kind: 'topic',
      topic: 'purpose',
      scope: 'mail',
      max_target_id_seen: 'a',
    });
    expect(store.list({ topic: 'purpose', fresh_only: false })).toHaveLength(0);
  });
});

describe('buildEnrichmentProducerTask — onInvalidate', () => {
  it('is callable without throwing on every invalidation reason', () => {
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer(),
      walker: stubWalker([]),
    });
    expect(typeof task.onInvalidate).toBe('function');
    for (const reason of ['source_update', 'source_delete', 'recipe_upgrade', 'config_change'] as const) {
      task.onInvalidate?.(stubCtx(), { reason, source_id: 'x', topic: 'thread_signals', scope: 'mail' });
    }
  });
});

describe('enrichmentProducerAuthoredBy', () => {
  it('returns the system.housekeeping.<topic> stamp', () => {
    expect(enrichmentProducerAuthoredBy('thread_signals')).toBe(
      'system.housekeeping.thread_signals',
    );
    expect(enrichmentProducerAuthoredBy('embedding')).toBe(
      'system.housekeeping.embedding',
    );
  });
});

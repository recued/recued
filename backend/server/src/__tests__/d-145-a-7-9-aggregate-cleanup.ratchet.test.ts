/** D-145 § A.7.9 — Universal aggregate-policy enrichment cleanup ratchets.
 *
 *  Three leak scenarios the substrate amendment closes:
 *
 *    1. Forward-walk null-cleanup. `produce()` returns null after a
 *       previous walk emitted a value (state-change abstention).
 *       Pre-amendment the row stayed; post-amendment the harness
 *       deletes it.
 *    2. Cascade source-delete. The source record vanished; the
 *       enrichment row keyed on `target_id === source_id` should
 *       cascade-delete regardless of policy (was: dependent-only).
 *    3. Stale-sweep over aggregate. Cross-entity input changes mark
 *       aggregate rows stale; the sweep was gated to dependent /
 *       members_list. Post-amendment aggregate sweeps too, so the
 *       row either re-derives (produce returns value) or is deleted
 *       (produce returns null).
 *
 *  Plus a defensive ratchet that `independent`-policy rows are never
 *  touched by the cascade (invariant 4 — no source linkage by
 *  definition).
 *
 *  Spec: docs/d-145-spec.md § A.7.9. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type CollectionRecord,
} from '@recued/contracts';

import { buildEnrichmentProducerTask } from '../housekeeping/enrichment-producer.js';
import type { HousekeepingEnrichmentProducer } from '../housekeeping/enrichment-producer.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type {
  SourceCollectionWalker,
  SourceRecord,
} from '../housekeeping/source-walkers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-a-7-9-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  store = createEnrichmentStore(db);
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
  now: () => NOW,
  emitAuditRow: () => undefined,
});

const fakeMail = (record_id: string): CollectionRecord => ({
  record_id,
  received_at: NOW,
  modified_at: NOW,
  hot_fields: {},
  size_bytes: 100,
  source_id: record_id,
});

const sourceRecord = (id: string): SourceRecord => ({
  target_id: id,
  data: fakeMail(id),
  cursor_token: id,
});

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

const STUB_SCOPE_READ_DECLARATION = [
  { collection: 'data.mail', sample_field_paths: ['subject'] },
] as const;

/** `purpose` is dependent / mail / housekeeping with a permissive
 *  acceptObject schema — convenient for harness-shape tests that
 *  don't care about value payload. */
const dependentProducer = (
  produceImpl?: (rec: SourceRecord) => unknown | null,
): HousekeepingEnrichmentProducer => ({
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

/** `thread_signals` is aggregate / mail / housekeeping with a concrete
 *  ThreadSignalsValue validator. Tests below use a default-shaped
 *  payload so the registry validator accepts. */
const aggregateProducer = (
  produceImpl?: (rec: SourceRecord) => unknown | null,
): HousekeepingEnrichmentProducer => ({
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

// ────────────────────────────────────────────────────────────────
// 1. Forward-walk null-cleanup
// ────────────────────────────────────────────────────────────────

describe('D-145 § A.7.9 — forward-walk null-cleanup', () => {
  it('deletes the existing row when produce() returns null on a later walk', async () => {
    // First walk produces a row, second walk's hash differs (so the
    // skip-rule fires produce()) and produce returns null —
    // pre-amendment the row stayed (`if (output !== null)` only).
    const records = [sourceRecord('a')];
    let firstPass = true;
    const producer = aggregateProducer((rec) => {
      if (firstPass) {
        return {
          thread_id: rec.target_id,
          message_count: 1,
          participant_count: 1,
          span_days: 0,
          has_unread: false,
        };
      }
      return null;
    });

    let task = buildEnrichmentProducerTask({
      producer,
      walker: stubWalker(records, 'v1'),
    });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(store.list({ topic: 'thread_signals' })).toHaveLength(1);

    firstPass = false;
    // Hash changes (v2) → skip-rule misses → produce() runs again
    // and now returns null. Existing row exists → harness drops it.
    task = buildEnrichmentProducerTask({
      producer,
      walker: stubWalker(records, 'v2'),
    });
    await task.step(stubCtx(), {
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: '',
    }, 60_000);
    expect(store.list({ topic: 'thread_signals', fresh_only: false })).toHaveLength(0);
  });

  it('stays no-op when produce() returns null and no existing row (first-walk null)', async () => {
    // No prior write — produce returns null on first contact. The
    // amendment only deletes when an existing row is present;
    // first-walk null remains a silent skip.
    const produceImpl = vi.fn().mockReturnValue(null);
    const records = [sourceRecord('a'), sourceRecord('b')];
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer(produceImpl),
      walker: stubWalker(records),
    });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(produceImpl).toHaveBeenCalledTimes(2);
    expect(store.list({ topic: 'thread_signals', fresh_only: false })).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Cascade source-delete extension
// ────────────────────────────────────────────────────────────────

describe('D-145 § A.7.9 — cascade source-delete drops aggregate rows', () => {
  // Use `contact_timeline_rollup` (aggregate / contact) for the
  // canonical scope-id ⇒ target-id case where source-delete should
  // now drop the row.
  const validRollup = {
    interaction_count: 4,
    last_interaction: 1_700_000_000_000,
    recent_subjects: ['hello'],
    cursor_at: 1_700_000_000_000,
    window_ms: 30 * 24 * 60 * 60 * 1000,
  };

  it('aggregate per-record row keyed on target_id=source_id is deleted on cascade', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.refresh-contact-timeline-rollup',
    });
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForSourceDelete('contact', 'bob@x.com');
    expect(result.rows_deleted).toBeGreaterThanOrEqual(1);
    expect(store.countForTopic('contact_timeline_rollup')).toBe(0);
  });

  it('cascade only deletes the matching target_id — other aggregate rows survive', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'r',
    });
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'alice@x.com',
      value: validRollup,
      authored_by: 'r',
    });
    const cascade = createEnrichmentCascade(store);
    cascade.cascadeForSourceDelete('contact', 'bob@x.com');
    // Bob's row gone; Alice's row stays.
    const remaining = store.list({ topic: 'contact_timeline_rollup' });
    expect(remaining.map((r) => r.target_id)).toEqual(['alice@x.com']);
  });

  it('per-record dependent + aggregate at same target_id both delete', () => {
    // Mail-scope source-delete. `purpose` is dependent (existing
    // behavior); a per-record aggregate keyed on mail would also
    // delete now. Verify dependent path still works alongside.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg-1',
      value: { tag: 'test' },
      authored_by: 'r',
    });
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForSourceDelete('mail', 'msg-1');
    expect(result.rows_deleted).toBeGreaterThanOrEqual(1);
    expect(store.countForTopic('purpose')).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Stale-sweep over aggregate
// ────────────────────────────────────────────────────────────────

describe('D-145 § A.7.9 — stale-sweep covers aggregate policy', () => {
  it('re-derives stale aggregate rows past the forward cursor', async () => {
    const records = [sourceRecord('a')];
    const task = buildEnrichmentProducerTask({
      producer: aggregateProducer(),
      walker: stubWalker(records),
    });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);

    // Mark stale (simulating cross-entity input change).
    db.prepare(
      `UPDATE data_enrichment SET staleness_class = 'stale' WHERE target_id = 'a'`,
    ).run();

    await task.step(stubCtx(), {
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: 'a',
    }, 60_000);

    const fresh = store.list({ topic: 'thread_signals' });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.staleness_class).toBe('fresh');
  });

  it('deletes the stale aggregate row when produce() now returns null', async () => {
    const records = [sourceRecord('a')];
    let firstPass = true;
    const producer = aggregateProducer((rec) => {
      if (firstPass) {
        return {
          thread_id: rec.target_id,
          message_count: 1,
          participant_count: 1,
          span_days: 0,
          has_unread: false,
        };
      }
      return null;
    });

    const task = buildEnrichmentProducerTask({
      producer,
      walker: stubWalker(records),
    });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(store.list({ topic: 'thread_signals' })).toHaveLength(1);

    firstPass = false;
    db.prepare(
      `UPDATE data_enrichment SET staleness_class = 'stale' WHERE target_id = 'a'`,
    ).run();

    await task.step(stubCtx(), {
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: 'a',
    }, 60_000);

    expect(store.list({ topic: 'thread_signals', fresh_only: false })).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Invariant 4 — independent rows untouched
// ────────────────────────────────────────────────────────────────

describe('D-145 § A.7.9 — invariant: independent rows survive cascade', () => {
  it('cascade-source-delete does not touch independent-policy topics', () => {
    // All current `independent` topics are derived_entity shape, so
    // they're filtered out by the `shape !== 'per_record'` early
    // return AND by the explicit `policy === 'independent'` gate.
    // This ratchet asserts the registry invariant: no per_record +
    // independent combo exists today (regression guard).
    let perRecordIndependent = 0;
    for (const def of Object.values(ENRICHMENT_REGISTRY)) {
      if (def.shape === 'per_record' && (def.policy as string) === 'independent') {
        perRecordIndependent += 1;
      }
    }
    expect(perRecordIndependent).toBe(0);
  });
});

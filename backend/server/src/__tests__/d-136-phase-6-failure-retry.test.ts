/** D-136 P6 — Failure / retry / backoff escalation tests.
 *
 *  Storage:
 *    - `RETRY_BACKOFFS_MS` schedule + `parseRetryAtToken` /
 *      `composeRetryAtToken` round-trip
 *    - `recordProducerFailure` insert path (no prior row → placeholder)
 *    - `recordProducerFailure` update path (existing row → bump count)
 *    - 4-attempt escalation walk → `'permanently_failed'` on attempt 5
 *    - successful upsert clears the LAP + counter (P5b carry-over)
 *
 *  Producer harness:
 *    - producer error returns the `producer_failure` outcome (no throw)
 *    - retry-armed rows skipped while their wake-time is future
 *    - retry-armed rows retried once their wake-time has passed
 *    - permanently-failed rows skipped indefinitely
 *
 *  Spec: docs/d-136-spec.md §A.6 + audit §9.1. */

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
  composeRetryAtToken,
  createEnrichmentStore,
  parseRetryAtToken,
  RETRY_BACKOFFS_MS,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let now = 1_750_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p6-failure-retry-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db, { now: () => now });
  now = 1_750_000_000_000;
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

const fakeMail = (record_id: string): CollectionRecord => ({
  record_id,
  received_at: now,
  modified_at: now,
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
  *walkAfter(cursor_token, batch_size) {
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
  { collection: 'data.mail', sample_field_paths: ['subject', 'thread_id'] },
] as const;

/** A flaky producer — invokes `behaviour(record, callCount)` each
 *  produce(); the closure decides whether to throw or return a value.
 *  `'purpose'` topic chosen because it's `dependent` (so stale-sweep
 *  fires) + permissive value schema. */
const flakyPurposeProducer = (
  behaviour: (rec: SourceRecord, attempt: number) => unknown | null,
): HousekeepingEnrichmentProducer => {
  let calls = 0;
  return {
    topic: 'purpose',
    source_scope: 'mail',
    scope_read_declaration: STUB_SCOPE_READ_DECLARATION,
    estimate_per_record_tokens: () => 0,
    async produce(_ctx, record) {
      calls += 1;
      const out = behaviour(record, calls);
      if (out === null) return null;
      if (out instanceof Error) throw out;
      return { value: out };
    },
  };
};

const stepWith = async (
  task: HousekeepingTaskInstance,
  cursor: HousekeepingCursor,
  budget_ms = 60_000,
): Promise<HousekeepingStepResult> => task.step(stubCtx(), cursor, budget_ms);

// ────────────────────────────────────────────────────────────────
// 1. Backoff schedule round-trip
// ────────────────────────────────────────────────────────────────

describe('RETRY_BACKOFFS_MS schedule', () => {
  it('declares 4 monotonically increasing slots: 2m / 8m / 30m / 2h', () => {
    expect(RETRY_BACKOFFS_MS).toEqual([
      2 * 60 * 1000,
      8 * 60 * 1000,
      30 * 60 * 1000,
      2 * 60 * 60 * 1000,
    ]);
  });

  it('parseRetryAtToken / composeRetryAtToken round-trip', () => {
    const ts = 1_750_000_000_000;
    const token = composeRetryAtToken(ts);
    expect(token).toBe('retry_at_1750000000000');
    expect(parseRetryAtToken(token)).toBe(ts);
  });

  it('parseRetryAtToken returns null for non-retry tokens', () => {
    expect(parseRetryAtToken(null)).toBeNull();
    expect(parseRetryAtToken('recompute')).toBeNull();
    expect(parseRetryAtToken('discard')).toBeNull();
    expect(parseRetryAtToken('permanently_failed')).toBeNull();
    expect(parseRetryAtToken('retry_at_')).toBeNull();
    expect(parseRetryAtToken('retry_at_abc')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. recordProducerFailure — insert path (no prior row)
// ────────────────────────────────────────────────────────────────

describe('recordProducerFailure — insert placeholder', () => {
  it('creates a stale row with NULL value + LAP retry_at on first failure', () => {
    const out = store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_42',
      authored_by: 'system.housekeeping.purpose',
      reason: 'transient_5xx',
      source_record_hash: 'h1',
      now,
    });
    expect(out.attempt_count).toBe(1);
    expect(parseRetryAtToken(out.lifecycle_action)).toBe(now + RETRY_BACKOFFS_MS[0]!);

    const row = store.getByRecord('purpose', 'mail', 'mail_42', 'system.housekeeping.purpose');
    expect(row).not.toBeNull();
    expect(row!.value).toBeNull();
    expect(row!.staleness_class).toBe('stale');
    expect(row!.failure_attempt_count).toBe(1);
    expect(row!.last_failure_reason).toBe('transient_5xx');
    expect(row!.source_record_hash).toBe('h1');
    expect(row!.lifecycle_action_pending).toBe(out.lifecycle_action);
  });

  it('omits source_record_hash when not provided', () => {
    const out = store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_99',
      authored_by: 'system.housekeeping.purpose',
      reason: 'unknown',
      now,
    });
    expect(out.attempt_count).toBe(1);
    const row = store.getByRecord('purpose', 'mail', 'mail_99', 'system.housekeeping.purpose');
    expect(row!.source_record_hash).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. recordProducerFailure — update path + escalation walk
// ────────────────────────────────────────────────────────────────

describe('recordProducerFailure — update existing row', () => {
  it('bumps failure_attempt_count + updates LAP per attempt', () => {
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
      source_record_hash: 'h1',
    });
    const out1 = store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      reason: 'rate_limit',
      now,
    });
    expect(out1.attempt_count).toBe(1);
    expect(parseRetryAtToken(out1.lifecycle_action)).toBe(now + RETRY_BACKOFFS_MS[0]!);
    const row1 = store.getByRecord('purpose', 'mail', 'mail_1', 'system.housekeeping.purpose')!;
    expect(row1.failure_attempt_count).toBe(1);
    expect(row1.staleness_class).toBe('stale');
    // Existing value is NOT cleared on failure — only on tombstone.
    expect(row1.value).toEqual({ purpose: 'inquiry', confidence: 0.5 });

    const out2 = store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      reason: 'rate_limit',
      now,
    });
    expect(out2.attempt_count).toBe(2);
    expect(parseRetryAtToken(out2.lifecycle_action)).toBe(now + RETRY_BACKOFFS_MS[1]!);
  });

  it('escalates to permanently_failed on attempt 5 (after 4 retry slots used)', () => {
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_2',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    for (let i = 1; i <= 4; i += 1) {
      const out = store.recordProducerFailure({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'mail_2',
        authored_by: 'system.housekeeping.purpose',
        reason: `attempt_${i}_failed`,
        now,
      });
      expect(out.attempt_count).toBe(i);
      expect(parseRetryAtToken(out.lifecycle_action)).toBe(now + RETRY_BACKOFFS_MS[i - 1]!);
    }
    const out5 = store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_2',
      authored_by: 'system.housekeeping.purpose',
      reason: 'attempt_5_failed',
      now,
    });
    expect(out5.attempt_count).toBe(5);
    expect(out5.lifecycle_action).toBe('permanently_failed');
    const row = store.getByRecord('purpose', 'mail', 'mail_2', 'system.housekeeping.purpose')!;
    expect(row.lifecycle_action_pending).toBe('permanently_failed');
    expect(row.staleness_class).toBe('expired');
    expect(row.last_failure_reason).toBe('attempt_5_failed');
    expect(row.failure_attempt_count).toBe(5);
  });

  it('successful upsert after a failure clears LAP + failure counter (P5b carry-over)', () => {
    store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_3',
      authored_by: 'system.housekeeping.purpose',
      reason: 'rate_limit',
      now,
    });
    const failed = store.getByRecord('purpose', 'mail', 'mail_3', 'system.housekeeping.purpose')!;
    expect(failed.failure_attempt_count).toBe(1);
    expect(parseRetryAtToken(failed.lifecycle_action_pending)).not.toBeNull();

    // Successful re-derive → upsert clears the failure metadata.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_3',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.6 },
      source_record_hash: 'h2',
    });
    const restored = store.getByRecord('purpose', 'mail', 'mail_3', 'system.housekeeping.purpose')!;
    expect(restored.failure_attempt_count).toBe(0);
    expect(restored.last_failure_reason).toBeNull();
    expect(restored.lifecycle_action_pending).toBeNull();
    expect(restored.staleness_class).toBe('fresh');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Producer harness — error → producer_failure outcome
// ────────────────────────────────────────────────────────────────

describe('producer harness — failure handling', () => {
  it('records failure + advances cursor instead of throwing on producer error', async () => {
    const records = [sourceRecord('a'), sourceRecord('b')];
    const calls: string[] = [];
    const producer = flakyPurposeProducer((rec) => {
      calls.push(rec.target_id);
      if (rec.target_id === 'a') return new Error('rate_limit_429');
      return { purpose: 'other', confidence: 0.8 };
    });
    const task = buildEnrichmentProducerTask({ producer, walker: stubWalker(records) });
    const result = await stepWith(task, { kind: 'complete' });

    expect(result.status).toBe('complete');
    // Both records were attempted.
    expect(calls).toEqual(['a', 'b']);

    // 'a' got a placeholder failure row.
    const aRow = store.getByRecord('purpose', 'mail', 'a', enrichmentProducerAuthoredBy('purpose'))!;
    expect(aRow).not.toBeNull();
    expect(aRow.value).toBeNull();
    expect(aRow.failure_attempt_count).toBe(1);
    expect(aRow.last_failure_reason).toBe('rate_limit_429');
    expect(parseRetryAtToken(aRow.lifecycle_action_pending)).toBe(now + RETRY_BACKOFFS_MS[0]!);

    // 'b' wrote a fresh row normally.
    const bRow = store.getByRecord('purpose', 'mail', 'b', enrichmentProducerAuthoredBy('purpose'))!;
    expect(bRow).not.toBeNull();
    expect(bRow.value).toEqual({ purpose: 'other', confidence: 0.8 });
    expect(bRow.failure_attempt_count).toBe(0);
  });

  it('skips retry-armed rows whose wake-time has not opened yet', async () => {
    // Pre-seed a stale failure row whose retry_at is 2 minutes in
    // the future — the harness should NOT call produce() for it.
    store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'a',
      authored_by: enrichmentProducerAuthoredBy('purpose'),
      reason: 'rate_limit',
      now,
    });

    const produceImpl = vi.fn();
    const records = [sourceRecord('a')];
    const producer = flakyPurposeProducer((rec) => {
      produceImpl();
      return { purpose: 'inquiry', confidence: 0.5, target: rec.target_id };
    });
    const task = buildEnrichmentProducerTask({ producer, walker: stubWalker(records) });

    // Forward walk runs; cursor advances; produce() never called.
    await stepWith(task, { kind: 'complete' });
    expect(produceImpl).not.toHaveBeenCalled();
  });

  it('retries armed rows once the backoff window has passed', async () => {
    store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'a',
      authored_by: enrichmentProducerAuthoredBy('purpose'),
      reason: 'rate_limit',
      now,
    });

    // Advance clock past the 2m backoff window.
    now = now + RETRY_BACKOFFS_MS[0]! + 1_000;

    const produceImpl = vi.fn();
    const records = [sourceRecord('a')];
    const producer = flakyPurposeProducer((rec) => {
      produceImpl();
      return { purpose: 'inquiry', confidence: 0.5, target: rec.target_id };
    });
    const task = buildEnrichmentProducerTask({ producer, walker: stubWalker(records) });

    // Stale-sweep should pick the retry-armed row up + re-run produce().
    const result = await stepWith(task, { kind: 'complete' });
    expect(result.status).toBe('complete');
    expect(produceImpl).toHaveBeenCalledTimes(1);

    // Successful re-derive cleared the failure state.
    const row = store.getByRecord('purpose', 'mail', 'a', enrichmentProducerAuthoredBy('purpose'))!;
    expect(row.failure_attempt_count).toBe(0);
    expect(row.lifecycle_action_pending).toBeNull();
    expect(row.staleness_class).toBe('fresh');
    expect(row.value).toEqual({ purpose: 'inquiry', confidence: 0.5, target: 'a' });
  });

  it('skips permanently_failed rows indefinitely', async () => {
    // Seed a row + escalate to permanently_failed.
    for (let i = 0; i < 5; i += 1) {
      store.recordProducerFailure({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'a',
        authored_by: enrichmentProducerAuthoredBy('purpose'),
        reason: 'fatal',
        now,
      });
    }
    const seeded = store.getByRecord('purpose', 'mail', 'a', enrichmentProducerAuthoredBy('purpose'))!;
    expect(seeded.lifecycle_action_pending).toBe('permanently_failed');

    // Advance clock arbitrarily — permanently_failed rows never re-attempt.
    now += 365 * 24 * 60 * 60 * 1000;

    const produceImpl = vi.fn();
    const records = [sourceRecord('a')];
    const producer = flakyPurposeProducer((rec) => {
      produceImpl();
      return { purpose: 'inquiry', confidence: 0.5, target: rec.target_id };
    });
    const task = buildEnrichmentProducerTask({ producer, walker: stubWalker(records) });
    await stepWith(task, { kind: 'complete' });
    expect(produceImpl).not.toHaveBeenCalled();
  });
});

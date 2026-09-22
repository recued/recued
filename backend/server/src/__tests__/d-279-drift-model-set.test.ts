/** D-279 — the drift producer withholds a verdict across a model change.
 *
 *  ⛔⛔ WHY. PSI asks whether one distribution moved relative to another.
 *  That is only a question about the WORLD while the producer is held
 *  fixed; swap the model underneath and the two windows are samples from
 *  two different instruments, so a large PSI says "the config changed",
 *  which the user already knows. The D-133 query filtered on topic and
 *  time window only, while `data_enrichment` has carried `model_id`
 *  since D-136 P2 — the column needed to tell the two apart was already
 *  there and simply unread.
 *
 *  🔑 AND IT SPENDS MONEY. D-136 P4 turns a `'significant'` fire into a
 *  recompute of every row of the topic, so reading a model swap as drift
 *  bills the user for news they made themselves.
 *
 *  🔑 WITHHOLDING, NOT CORRECTING. Rescaling across two models would need
 *  a mapping between their confidence scales and there is none — D-278
 *  measured one prompt wording produce [0.85, 0.9, 0.95] and another
 *  produce [0, 0.9] from the same model. A comparison that cannot be made
 *  honestly is not made, which is the same choice the sample floors
 *  already express. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfidenceDriftSignal, ServerEvent } from '@recued/contracts';

import {
  CONFIDENCE_DRIFT_TOPIC,
  DRIFT_BASELINE_WINDOW_MS,
  DRIFT_RECENT_WINDOW_MS,
  MIN_SAMPLE_COUNT_BASELINE,
  MIN_SAMPLE_COUNT_RECENT,
  processOneConfidenceDriftTopic,
} from '../housekeeping/index.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';
import type { EventBus, ServerEventInput } from '../events/bus.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let now = 1_700_000_000_000;
let bus: EventBus;

/** Seeds one `purpose` row, then forces BOTH fields the producer reads
 *  and the store stamps for itself: `authored_at` (window membership)
 *  and `model_id` (the subject of this suite). `null` is a real case —
 *  a row written before the model was stamped. */
const seed = (
  authored_at: number,
  confidence: number,
  target_id: string,
  model_id: string | null,
): void => {
  store.upsert({
    topic: 'purpose',
    scope: 'mail',
    target_id,
    value: { category: 'request', confidence, reasoning: 'stub' },
    authored_by: 'system.housekeeping.purpose',
    event_at: authored_at,
  });
  db.prepare(
    `UPDATE data_enrichment SET authored_at = ?, model_id = ?
      WHERE topic = 'purpose' AND target_id = ?`,
  ).run(authored_at, model_id, target_id);
};

const seedMany = (
  count: number, authored_at: number, confidence: number, prefix: string,
  model: string | null | ((i: number) => string | null),
): void => {
  for (let i = 0; i < count; i += 1) {
    seed(authored_at + i, confidence, `${prefix}_${i}`,
      typeof model === 'function' ? model(i) : model);
  }
};

const BASELINE_START = () => now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
const RECENT_START = () => now - DRIFT_RECENT_WINDOW_MS / 2;

/** Baseline and recent differ sharply in confidence, so PSI is large and
 *  a verdict WOULD be produced — every skip below is therefore the model
 *  check and not a quiet lack of signal. */
const seedDrifting = (
  baselineModel: string | null | ((i: number) => string | null),
  recentModel: string | null | ((i: number) => string | null),
): void => {
  seedMany(MIN_SAMPLE_COUNT_BASELINE, BASELINE_START(), 0.9, 'b', baselineModel);
  seedMany(MIN_SAMPLE_COUNT_RECENT, RECENT_START(), 0.2, 'r', recentModel);
};

const ctx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
  eventBus: bus,
});

const storedSignal = (): ConfidenceDriftSignal | undefined => {
  const rows = store.list({ topic: CONFIDENCE_DRIFT_TOPIC, limit: 5 });
  return rows[0]?.value as ConfidenceDriftSignal | undefined;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-279-drift-model-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
  now = 1_700_000_000_000;
  bus = { emit: vi.fn(), subscribe: () => () => undefined, dispose: () => undefined } as unknown as EventBus;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-279 — the control arm: one model, a verdict is produced', () => {
  it('computes when both windows came from the same model, and stamps it', () => {
    seedDrifting('groq:llama-3.1-70b', 'groq:llama-3.1-70b');
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);

    // ⛔ Without this arm every "skipped" below could just mean the
    // harness never produces a verdict at all.
    expect(result.processed).toBe(true);
    const signal = storedSignal();
    expect(signal?.psi).toBeGreaterThan(0);
    expect(signal?.model_ids).toEqual(['groq:llama-3.1-70b']);
  });

  it('computes when both windows span the SAME mixed set — a pool is not a change', () => {
    // free_then_byok rotating across two entries is the steady state, not
    // a config change. Comparing {A,B} to {A,B} is a fair comparison.
    const mixed = (i: number) => (i % 2 === 0 ? 'groq:a' : 'openai:b');
    seedDrifting(mixed, mixed);
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.processed).toBe(true);
    expect(storedSignal()?.model_ids).toEqual(['groq:a', 'openai:b']);
  });
});

describe('D-279 — withheld across a model change', () => {
  it('skips when the recent window came from a different model', () => {
    seedDrifting('groq:llama-3.1-70b', 'anthropic:claude-haiku-4-5');
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.processed).toBe(false);
    expect(result.fired).toBeNull();
    // Nothing stored: a verdict that cannot be made honestly is not made.
    expect(storedSignal()).toBeUndefined();
  });

  it('skips when the pool WIDENED — {A} then {A,B} is still two instruments', () => {
    seedDrifting('groq:a', (i) => (i % 2 === 0 ? 'groq:a' : 'openai:b'));
    expect(processOneConfidenceDriftTopic(ctx(), 'purpose', now).processed).toBe(false);
  });

  it('⛔ treats an UNSTAMPED row as its own bucket, not as a wildcard', () => {
    // A pre-D-136 row has model_id NULL. Merging that into whatever the
    // other window used would let exactly the comparison this guard
    // exists to prevent slip through as "same set".
    seedDrifting(null, 'groq:a');
    expect(processOneConfidenceDriftTopic(ctx(), 'purpose', now).processed).toBe(false);
  });

  it('and compares NULL to NULL as equal — unstamped throughout is one instrument', () => {
    seedDrifting(null, null);
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.processed).toBe(true);
    // The empty-string bucket is what an unstamped row reads as.
    expect(storedSignal()?.model_ids).toEqual(['']);
  });
});

describe('D-279 — the fire is what a false verdict would have cost', () => {
  it('a model change emits no realtime event and enqueues no recompute', () => {
    seedDrifting('groq:a', 'anthropic:b');
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    // 🔑 D-136 P4 would recompute EVERY row of the topic on a
    // `'significant'` fire. Withholding is what stops a config change
    // from billing the user.
    expect((bus.emit as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    const pending = db
      .prepare(`SELECT COUNT(*) AS n FROM data_enrichment
                 WHERE lifecycle_action_pending IS NOT NULL`)
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });
});

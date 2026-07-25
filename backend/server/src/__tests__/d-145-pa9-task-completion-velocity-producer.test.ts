/** D-145 PA9 — `task_completion_velocity` producer tests.
 *
 *  Fourteenth D-145 PA9 producer impl + second PSI-eligible producer
 *  after [[commitment_followthrough_score]]. Validates the PSI shape
 *  precedent applied to a non-ratio score: velocity emits tasks-per-day
 *  (raw rate), while followthrough emitted a 0..1 ratio. Both share the
 *  `PsiEligibleScoreValue` schema; PSI iterates the score distribution
 *  per-version regardless of normalization.
 *
 *  Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration / static producer_version_hash)
 *    - Declaration + registry producer_kind / emits_confidence alignment
 *    - computeVelocityConfidence pure cases (linear ramp, saturation,
 *      non-finite defensive)
 *    - countCompletedTasksForContact SQL (assigned filter, done filter,
 *      completed_at NOT NULL, window filter, tombstone exclusion,
 *      empty-id short-circuit, MAX(completed_at) for event_at)
 *    - produce() integration: sample-floor abstention, raw-rate math
 *      (tasks per day), event_at stamping, cross-contact isolation
 *    - Registry value_schema acceptance round-trip */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  TASK_COMPLETION_VELOCITY_DECLARATION,
  type ContactRecord,
  type PsiEligibleScoreValue,
} from '@recued/contracts';

import {
  computeVelocityConfidence,
  countCompletedTasksForContact,
  TASK_COMPLETION_VELOCITY_CONFIDENCE_SATURATION,
  TASK_COMPLETION_VELOCITY_PRODUCER_VERSION_HASH,
  TASK_COMPLETION_VELOCITY_SAMPLE_FLOOR,
  TASK_COMPLETION_VELOCITY_WINDOW_DAYS,
  TASK_COMPLETION_VELOCITY_WINDOW_MS,
  taskCompletionVelocityProducer,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import { TASK_TABLE } from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-velocity-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Minimal task table — only the columns the producer reads.
  db.exec(`
    CREATE TABLE ${TASK_TABLE} (
      id                   TEXT PRIMARY KEY,
      assigned_contact_id  TEXT,
      done                 INTEGER NOT NULL DEFAULT 0,
      completed_at         INTEGER,
      sync_state           TEXT NOT NULL DEFAULT 'live',
      deleted_at           INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface TaskRow {
  id: string;
  assigned_contact_id?: string | null;
  done?: 0 | 1;
  completed_at?: number | null;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertTask = (row: TaskRow): void => {
  db.prepare(
    `INSERT INTO ${TASK_TABLE}
       (id, assigned_contact_id, done, completed_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.assigned_contact_id ?? null,
    row.done ?? 0,
    row.completed_at ?? null,
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

const buildCtx = (now: number = NOW): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const fakeContact = (email: string): ContactRecord => ({
  _id: email,
  _collection: 'contact',
  email,
  first_seen: NOW - 365 * DAY,
  last_interaction: NOW - DAY,
  interaction_count: 1,
  source: 'email_from',
  created_at: NOW - 365 * DAY,
  updated_at: NOW - DAY,
});

const sourceFor = (contact: ContactRecord): SourceRecord<ContactRecord> => ({
  target_id: contact.email,
  data: contact,
  cursor_token: contact.email,
});

/** Seed `count` completed tasks for the contact spread across the past
 *  `daySpread` days (so MAX(completed_at) = NOW when daySpread ≤ window). */
const seedCompletedTasks = (
  email: string,
  count: number,
  daySpread: number = 30,
  idPrefix: string = 'done',
): void => {
  for (let i = 0; i < count; i++) {
    insertTask({
      id: `${idPrefix}_${email}_${i}`,
      assigned_contact_id: email,
      done: 1,
      completed_at: NOW - (i % daySpread) * DAY,
    });
  }
};

const expectValue = async (
  ctx: HousekeepingContext,
  contact: ContactRecord,
): Promise<PsiEligibleScoreValue> => {
  const out = await taskCompletionVelocityProducer.produce(ctx, sourceFor(contact));
  if (out === null) throw new Error(`expected producer output for ${contact.email}, got null`);
  return out.value as PsiEligibleScoreValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('taskCompletionVelocityProducer surface contract', () => {
  it('targets the task_completion_velocity registry topic', () => {
    expect(taskCompletionVelocityProducer.topic).toBe('task_completion_velocity');
  });

  it('targets the contact source scope', () => {
    expect(taskCompletionVelocityProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(taskCompletionVelocityProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(taskCompletionVelocityProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(taskCompletionVelocityProducer.ai_surface).toBeUndefined();
  });

  it('declares a static producer_version_hash so PSI drift iterates per-version', () => {
    expect(taskCompletionVelocityProducer.producer_version_hash).toBe(
      TASK_COMPLETION_VELOCITY_PRODUCER_VERSION_HASH,
    );
    expect(TASK_COMPLETION_VELOCITY_PRODUCER_VERSION_HASH.startsWith('fnv1a:')).toBe(true);
  });

  it('declares scope_read for contact + task with the load-bearing fields', () => {
    const decls = taskCompletionVelocityProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual([
      'data.contact',
      'data.task',
    ]);
    expect(decls.find((e) => e.collection === 'data.task')!.sample_field_paths).toEqual([
      'assigned_contact_id',
      'done',
      'completed_at',
    ]);
  });

  it('exposes window + sample-floor + saturation constants', () => {
    expect(TASK_COMPLETION_VELOCITY_WINDOW_DAYS).toBe(30);
    expect(TASK_COMPLETION_VELOCITY_WINDOW_MS).toBe(30 * DAY);
    expect(TASK_COMPLETION_VELOCITY_SAMPLE_FLOOR).toBe(30);
    expect(TASK_COMPLETION_VELOCITY_CONFIDENCE_SATURATION).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────
// PSI-eligible declaration + registry alignment
// ────────────────────────────────────────────────────────────────

describe('PSI-eligible alignment', () => {
  it('declaration carries confidence_kind: "emits_confidence" (PSI-eligible)', () => {
    expect(TASK_COMPLETION_VELOCITY_DECLARATION.confidence_kind).toBe('emits_confidence');
  });

  it('declaration carries sample_floor ≥ 30 (PSI calibration baseline)', () => {
    expect(TASK_COMPLETION_VELOCITY_DECLARATION.sample_floor).toBeGreaterThanOrEqual(30);
  });

  it('registry entry carries emits_confidence: true so D-133 drift task picks it up', () => {
    expect(
      (ENRICHMENT_REGISTRY.task_completion_velocity as { emits_confidence?: boolean })
        .emits_confidence,
    ).toBe(true);
  });

  it('registry entry carries producer_kind: "housekeeping"', () => {
    expect(ENRICHMENT_REGISTRY.task_completion_velocity.producer_kind).toBe('housekeeping');
  });

  it('registry preserves valid_scopes: ["contact"]', () => {
    expect(ENRICHMENT_REGISTRY.task_completion_velocity.valid_scopes).toEqual(['contact']);
  });
});

// ────────────────────────────────────────────────────────────────
// computeVelocityConfidence pure cases
// ────────────────────────────────────────────────────────────────

describe('computeVelocityConfidence', () => {
  it('scales linearly with sample size below saturation', () => {
    expect(computeVelocityConfidence(30)).toBeCloseTo(0.3, 10);
    expect(computeVelocityConfidence(50)).toBeCloseTo(0.5, 10);
    expect(computeVelocityConfidence(99)).toBeCloseTo(0.99, 10);
  });

  it('saturates at 1.0 at and above the saturation cap', () => {
    expect(computeVelocityConfidence(100)).toBe(1);
    expect(computeVelocityConfidence(500)).toBe(1);
  });

  it('returns 0 for zero or negative sample sizes (defensive)', () => {
    expect(computeVelocityConfidence(0)).toBe(0);
    expect(computeVelocityConfidence(-5)).toBe(0);
  });

  it('returns 0 for non-finite inputs (defensive)', () => {
    expect(computeVelocityConfidence(Number.NaN)).toBe(0);
    expect(computeVelocityConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('honours an overridden saturation point (future tunable_params lift)', () => {
    expect(computeVelocityConfidence(50, 200)).toBeCloseTo(0.25, 10);
    expect(computeVelocityConfidence(200, 200)).toBe(1);
  });

  it('returns 0 for non-positive saturation override', () => {
    expect(computeVelocityConfidence(50, 0)).toBe(0);
    expect(computeVelocityConfidence(50, -1)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// countCompletedTasksForContact SQL
// ────────────────────────────────────────────────────────────────

describe('countCompletedTasksForContact', () => {
  const SINCE = NOW - TASK_COMPLETION_VELOCITY_WINDOW_MS;

  it('returns zero counts for an empty contact email', () => {
    expect(countCompletedTasksForContact(buildCtx(), '', SINCE)).toEqual({
      completed_count: 0,
      latest_completed_at: null,
    });
  });

  it('counts completed tasks assigned to the contact', () => {
    seedCompletedTasks('alice@example.com', 5);
    const counts = countCompletedTasksForContact(buildCtx(), 'alice@example.com', SINCE);
    expect(counts.completed_count).toBe(5);
    expect(counts.latest_completed_at).toBe(NOW);
  });

  it('excludes open tasks (done = 0)', () => {
    insertTask({
      id: 't_open',
      assigned_contact_id: 'alice@example.com',
      done: 0,
      completed_at: null,
    });
    expect(countCompletedTasksForContact(buildCtx(), 'alice@example.com', SINCE).completed_count).toBe(0);
  });

  it('excludes done tasks with NULL completed_at (defensive — should not happen but guard against)', () => {
    insertTask({
      id: 't_done_no_ts',
      assigned_contact_id: 'alice@example.com',
      done: 1,
      completed_at: null,
    });
    expect(countCompletedTasksForContact(buildCtx(), 'alice@example.com', SINCE).completed_count).toBe(0);
  });

  it('excludes tasks completed outside the rolling window', () => {
    insertTask({
      id: 't_old',
      assigned_contact_id: 'alice@example.com',
      done: 1,
      completed_at: NOW - 60 * DAY, // outside 30d window
    });
    expect(countCompletedTasksForContact(buildCtx(), 'alice@example.com', SINCE).completed_count).toBe(0);
  });

  it('excludes tombstoned tasks', () => {
    insertTask({
      id: 't_deleted',
      assigned_contact_id: 'alice@example.com',
      done: 1,
      completed_at: NOW,
      deleted_at: NOW,
    });
    insertTask({
      id: 't_tombstoned',
      assigned_contact_id: 'alice@example.com',
      done: 1,
      completed_at: NOW,
      sync_state: 'tombstoned',
    });
    expect(countCompletedTasksForContact(buildCtx(), 'alice@example.com', SINCE).completed_count).toBe(0);
  });

  it('returns MAX(completed_at) across contributing rows', () => {
    insertTask({
      id: 't_older',
      assigned_contact_id: 'alice@example.com',
      done: 1,
      completed_at: NOW - 10 * DAY,
    });
    insertTask({
      id: 't_newer',
      assigned_contact_id: 'alice@example.com',
      done: 1,
      completed_at: NOW - 2 * DAY,
    });
    const counts = countCompletedTasksForContact(buildCtx(), 'alice@example.com', SINCE);
    expect(counts.latest_completed_at).toBe(NOW - 2 * DAY);
  });

  it('isolates by contact (no cross-contact bleed)', () => {
    seedCompletedTasks('alice@example.com', 5);
    seedCompletedTasks('bob@example.com', 5);
    expect(
      countCompletedTasksForContact(buildCtx(), 'alice@example.com', SINCE).completed_count,
    ).toBe(5);
    expect(
      countCompletedTasksForContact(buildCtx(), 'bob@example.com', SINCE).completed_count,
    ).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('taskCompletionVelocityProducer.produce', () => {
  it('returns null when the contact has fewer than 30 completed tasks in window', async () => {
    seedCompletedTasks('alice@example.com', 20);
    const result = await taskCompletionVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('alice@example.com')),
    );
    expect(result).toBeNull();
  });

  it('returns null when the contact has zero completed tasks', async () => {
    const result = await taskCompletionVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('alice@example.com')),
    );
    expect(result).toBeNull();
  });

  it('returns null when the contact email is empty', async () => {
    const result = await taskCompletionVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('')),
    );
    expect(result).toBeNull();
  });

  it('emits a tasks-per-day rate at the sample floor (30 tasks / 30 days = 1.0/day)', async () => {
    seedCompletedTasks('alice@example.com', 30);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.score).toBeCloseTo(1, 10);
    expect(value.sample_count).toBe(30);
    expect(value.confidence).toBeCloseTo(0.3, 10);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits a higher rate as sample_count grows above the floor', async () => {
    seedCompletedTasks('alice@example.com', 60);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    // 60 tasks in 30 days = 2 tasks/day.
    expect(value.score).toBeCloseTo(2, 10);
    expect(value.sample_count).toBe(60);
    expect(value.confidence).toBeCloseTo(0.6, 10);
  });

  it('saturates confidence at 1.0 when sample_count reaches the saturation cap', async () => {
    seedCompletedTasks('alice@example.com', 100);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.sample_count).toBe(100);
    expect(value.confidence).toBe(1);
    // 100 tasks in 30 days ≈ 3.33 tasks/day. Score is NOT saturated —
    // only confidence saturates; score is raw rate.
    expect(value.score).toBeCloseTo(100 / 30, 5);
  });

  it('stamps event_at to MAX(completed_at) across contributing rows', async () => {
    seedCompletedTasks('alice@example.com', 30);
    const out = await taskCompletionVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('alice@example.com')),
    );
    expect(out?.event_at).toBe(NOW);
  });

  it('excludes tasks completed before the 30d window from the rate', async () => {
    // Seed 30 in-window + 50 ancient.
    seedCompletedTasks('alice@example.com', 30, 29, 'recent');
    for (let i = 0; i < 50; i++) {
      insertTask({
        id: `ancient_${i}`,
        assigned_contact_id: 'alice@example.com',
        done: 1,
        completed_at: NOW - 90 * DAY,
      });
    }
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.sample_count).toBe(30);
    expect(value.score).toBeCloseTo(1, 10);
  });

  it('isolates per contact across the cycle', async () => {
    seedCompletedTasks('alice@example.com', 30);
    seedCompletedTasks('bob@example.com', 60);
    const a = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    const b = await expectValue(buildCtx(), fakeContact('bob@example.com'));
    expect(a.sample_count).toBe(30);
    expect(b.sample_count).toBe(60);
    expect(a.score).toBeCloseTo(1, 10);
    expect(b.score).toBeCloseTo(2, 10);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('registry value_schema acceptance', () => {
  it('accepts a {score, sample_count, confidence, computed_at} payload via PsiEligibleScoreSchema', () => {
    const def = ENRICHMENT_REGISTRY.task_completion_velocity;
    const result = def.value_schema({
      score: 1.5,
      sample_count: 45,
      confidence: 0.45,
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

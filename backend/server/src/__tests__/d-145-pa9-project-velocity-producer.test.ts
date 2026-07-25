/** D-145 PA9 — `project_velocity` producer tests.
 *
 *  Fifteenth D-145 PA9 producer impl + third PSI-eligible producer
 *  after [[commitment_followthrough_score]] +
 *  [[task_completion_velocity]]. Per-project sibling to
 *  [[task_completion_velocity]] — same math, same window, same PSI
 *  shape; the source axis swaps `assigned_contact_id` for
 *  `parent_project_id`. Closes the PSI velocity axis (contact +
 *  project).
 *
 *  Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration / static producer_version_hash)
 *    - Declaration + registry producer_kind / emits_confidence alignment
 *    - computeProjectVelocityConfidence pure cases (linear ramp,
 *      saturation, non-finite defensive)
 *    - countCompletedTasksForProject SQL (parent_project_id filter,
 *      done filter, completed_at NOT NULL, window filter, tombstone
 *      exclusion, empty-id short-circuit, MAX(completed_at) for
 *      event_at)
 *    - produce() integration: active-state gate (paused / completed /
 *      archived abstention), sample-floor abstention, raw-rate math
 *      (tasks per day), event_at stamping, cross-project isolation
 *    - Registry value_schema acceptance round-trip */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  PROJECT_VELOCITY_DECLARATION,
  type Project,
  type PsiEligibleScoreValue,
} from '@recued/contracts';

import {
  computeProjectVelocityConfidence,
  countCompletedTasksForProject,
  PROJECT_VELOCITY_CONFIDENCE_SATURATION,
  PROJECT_VELOCITY_PRODUCER_VERSION_HASH,
  PROJECT_VELOCITY_SAMPLE_FLOOR,
  PROJECT_VELOCITY_WINDOW_DAYS,
  PROJECT_VELOCITY_WINDOW_MS,
  projectVelocityProducer,
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
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-project-velocity-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Minimal task table — only the columns the producer reads.
  db.exec(`
    CREATE TABLE ${TASK_TABLE} (
      id                 TEXT PRIMARY KEY,
      parent_project_id  TEXT,
      done               INTEGER NOT NULL DEFAULT 0,
      completed_at       INTEGER,
      sync_state         TEXT NOT NULL DEFAULT 'live',
      deleted_at         INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface TaskRow {
  id: string;
  parent_project_id?: string | null;
  done?: 0 | 1;
  completed_at?: number | null;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertTask = (row: TaskRow): void => {
  db.prepare(
    `INSERT INTO ${TASK_TABLE}
       (id, parent_project_id, done, completed_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parent_project_id ?? null,
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

const fakeProject = (overrides: Partial<Project> & { id: string }): Project => ({
  id: overrides.id,
  title: overrides.title ?? `Project ${overrides.id}`,
  state: overrides.state ?? 'active',
  created_at: overrides.created_at ?? NOW - 365 * DAY,
  updated_at: overrides.updated_at ?? NOW - DAY,
  last_activity_at: overrides.last_activity_at ?? NOW - DAY,
  related_contact_ids: overrides.related_contact_ids ?? [],
  source_id: overrides.source_id ?? 'src_recued',
  source_record_id: overrides.source_record_id ?? overrides.id,
  source_updated_at: overrides.source_updated_at ?? NOW - DAY,
  last_seen_at: overrides.last_seen_at ?? NOW - DAY,
  sync_state: overrides.sync_state ?? 'live',
  conflict_policy: overrides.conflict_policy ?? 'source_wins',
  source_record_hash: overrides.source_record_hash ?? 'h_proj',
});

const sourceFor = (project: Project): SourceRecord<Project> => ({
  target_id: project.id,
  data: project,
  cursor_token: project.id,
});

/** Seed `count` completed tasks for the project spread across the past
 *  `daySpread` days (so MAX(completed_at) = NOW when daySpread ≤ window). */
const seedCompletedTasks = (
  project_id: string,
  count: number,
  daySpread: number = 30,
  idPrefix: string = 'done',
): void => {
  for (let i = 0; i < count; i++) {
    insertTask({
      id: `${idPrefix}_${project_id}_${i}`,
      parent_project_id: project_id,
      done: 1,
      completed_at: NOW - (i % daySpread) * DAY,
    });
  }
};

const expectValue = async (
  ctx: HousekeepingContext,
  project: Project,
): Promise<PsiEligibleScoreValue> => {
  const out = await projectVelocityProducer.produce(ctx, sourceFor(project));
  if (out === null) throw new Error(`expected producer output for ${project.id}, got null`);
  return out.value as PsiEligibleScoreValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('projectVelocityProducer surface contract', () => {
  it('targets the project_velocity registry topic', () => {
    expect(projectVelocityProducer.topic).toBe('project_velocity');
  });

  it('targets the project source scope', () => {
    expect(projectVelocityProducer.source_scope).toBe('project');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(projectVelocityProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(projectVelocityProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(projectVelocityProducer.ai_surface).toBeUndefined();
  });

  it('declares a static producer_version_hash so PSI drift iterates per-version', () => {
    expect(projectVelocityProducer.producer_version_hash).toBe(
      PROJECT_VELOCITY_PRODUCER_VERSION_HASH,
    );
    expect(PROJECT_VELOCITY_PRODUCER_VERSION_HASH.startsWith('fnv1a:')).toBe(true);
  });

  it('declares scope_read for project + task with the load-bearing fields', () => {
    const decls = projectVelocityProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual([
      'data.project',
      'data.task',
    ]);
    expect(decls.find((e) => e.collection === 'data.project')!.sample_field_paths).toEqual([
      'id',
      'state',
    ]);
    expect(decls.find((e) => e.collection === 'data.task')!.sample_field_paths).toEqual([
      'parent_project_id',
      'done',
      'completed_at',
    ]);
  });

  it('exposes window + sample-floor + saturation constants', () => {
    expect(PROJECT_VELOCITY_WINDOW_DAYS).toBe(30);
    expect(PROJECT_VELOCITY_WINDOW_MS).toBe(30 * DAY);
    expect(PROJECT_VELOCITY_SAMPLE_FLOOR).toBe(30);
    expect(PROJECT_VELOCITY_CONFIDENCE_SATURATION).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────
// PSI-eligible declaration + registry alignment
// ────────────────────────────────────────────────────────────────

describe('PSI-eligible alignment', () => {
  it('declaration carries confidence_kind: "emits_confidence" (PSI-eligible)', () => {
    expect(PROJECT_VELOCITY_DECLARATION.confidence_kind).toBe('emits_confidence');
  });

  it('declaration carries sample_floor ≥ 30 (PSI calibration baseline)', () => {
    expect(PROJECT_VELOCITY_DECLARATION.sample_floor).toBeGreaterThanOrEqual(30);
  });

  it('registry entry carries emits_confidence: true so D-133 drift task picks it up', () => {
    expect(
      (ENRICHMENT_REGISTRY.project_velocity as { emits_confidence?: boolean })
        .emits_confidence,
    ).toBe(true);
  });

  it('registry entry carries producer_kind: "housekeeping"', () => {
    expect(ENRICHMENT_REGISTRY.project_velocity.producer_kind).toBe('housekeeping');
  });

  it('registry preserves valid_scopes: ["project"]', () => {
    expect(ENRICHMENT_REGISTRY.project_velocity.valid_scopes).toEqual(['project']);
  });
});

// ────────────────────────────────────────────────────────────────
// computeProjectVelocityConfidence pure cases
// ────────────────────────────────────────────────────────────────

describe('computeProjectVelocityConfidence', () => {
  it('scales linearly with sample size below saturation', () => {
    expect(computeProjectVelocityConfidence(30)).toBeCloseTo(0.3, 10);
    expect(computeProjectVelocityConfidence(50)).toBeCloseTo(0.5, 10);
    expect(computeProjectVelocityConfidence(99)).toBeCloseTo(0.99, 10);
  });

  it('saturates at 1.0 at and above the saturation cap', () => {
    expect(computeProjectVelocityConfidence(100)).toBe(1);
    expect(computeProjectVelocityConfidence(500)).toBe(1);
  });

  it('returns 0 for zero or negative sample sizes (defensive)', () => {
    expect(computeProjectVelocityConfidence(0)).toBe(0);
    expect(computeProjectVelocityConfidence(-5)).toBe(0);
  });

  it('returns 0 for non-finite inputs (defensive)', () => {
    expect(computeProjectVelocityConfidence(Number.NaN)).toBe(0);
    expect(computeProjectVelocityConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('honours an overridden saturation point (future tunable_params lift)', () => {
    expect(computeProjectVelocityConfidence(50, 200)).toBeCloseTo(0.25, 10);
    expect(computeProjectVelocityConfidence(200, 200)).toBe(1);
  });

  it('returns 0 for non-positive saturation override', () => {
    expect(computeProjectVelocityConfidence(50, 0)).toBe(0);
    expect(computeProjectVelocityConfidence(50, -1)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// countCompletedTasksForProject SQL
// ────────────────────────────────────────────────────────────────

describe('countCompletedTasksForProject', () => {
  const SINCE = NOW - PROJECT_VELOCITY_WINDOW_MS;

  it('returns zero counts for an empty project_id', () => {
    expect(countCompletedTasksForProject(buildCtx(), '', SINCE)).toEqual({
      completed_count: 0,
      latest_completed_at: null,
    });
  });

  it('counts completed tasks parented to the project', () => {
    seedCompletedTasks('proj_a', 5);
    const counts = countCompletedTasksForProject(buildCtx(), 'proj_a', SINCE);
    expect(counts.completed_count).toBe(5);
    expect(counts.latest_completed_at).toBe(NOW);
  });

  it('excludes open tasks (done = 0)', () => {
    insertTask({
      id: 't_open',
      parent_project_id: 'proj_a',
      done: 0,
      completed_at: null,
    });
    expect(countCompletedTasksForProject(buildCtx(), 'proj_a', SINCE).completed_count).toBe(0);
  });

  it('excludes done tasks with NULL completed_at (defensive — should not happen but guard against)', () => {
    insertTask({
      id: 't_done_no_ts',
      parent_project_id: 'proj_a',
      done: 1,
      completed_at: null,
    });
    expect(countCompletedTasksForProject(buildCtx(), 'proj_a', SINCE).completed_count).toBe(0);
  });

  it('excludes tasks completed outside the rolling window', () => {
    insertTask({
      id: 't_old',
      parent_project_id: 'proj_a',
      done: 1,
      completed_at: NOW - 60 * DAY, // outside 30d window
    });
    expect(countCompletedTasksForProject(buildCtx(), 'proj_a', SINCE).completed_count).toBe(0);
  });

  it('excludes tombstoned tasks', () => {
    insertTask({
      id: 't_deleted',
      parent_project_id: 'proj_a',
      done: 1,
      completed_at: NOW,
      deleted_at: NOW,
    });
    insertTask({
      id: 't_tombstoned',
      parent_project_id: 'proj_a',
      done: 1,
      completed_at: NOW,
      sync_state: 'tombstoned',
    });
    expect(countCompletedTasksForProject(buildCtx(), 'proj_a', SINCE).completed_count).toBe(0);
  });

  it('returns MAX(completed_at) across contributing rows', () => {
    insertTask({
      id: 't_older',
      parent_project_id: 'proj_a',
      done: 1,
      completed_at: NOW - 10 * DAY,
    });
    insertTask({
      id: 't_newer',
      parent_project_id: 'proj_a',
      done: 1,
      completed_at: NOW - 2 * DAY,
    });
    const counts = countCompletedTasksForProject(buildCtx(), 'proj_a', SINCE);
    expect(counts.latest_completed_at).toBe(NOW - 2 * DAY);
  });

  it('isolates by project (no cross-project bleed)', () => {
    seedCompletedTasks('proj_a', 5);
    seedCompletedTasks('proj_b', 5);
    expect(
      countCompletedTasksForProject(buildCtx(), 'proj_a', SINCE).completed_count,
    ).toBe(5);
    expect(
      countCompletedTasksForProject(buildCtx(), 'proj_b', SINCE).completed_count,
    ).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('projectVelocityProducer.produce', () => {
  it('returns null when the project_id is empty', async () => {
    const result = await projectVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeProject({ id: '' })),
    );
    expect(result).toBeNull();
  });

  it('returns null when the project is paused', async () => {
    seedCompletedTasks('proj_a', 30);
    const result = await projectVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'paused' })),
    );
    expect(result).toBeNull();
  });

  it('returns null when the project is completed', async () => {
    seedCompletedTasks('proj_a', 30);
    const result = await projectVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'completed' })),
    );
    expect(result).toBeNull();
  });

  it('returns null when the project is archived', async () => {
    seedCompletedTasks('proj_a', 30);
    const result = await projectVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'archived' })),
    );
    expect(result).toBeNull();
  });

  it('returns null when the active project has fewer than 30 completed tasks in window', async () => {
    seedCompletedTasks('proj_a', 20);
    const result = await projectVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeProject({ id: 'proj_a' })),
    );
    expect(result).toBeNull();
  });

  it('returns null when the active project has zero completed tasks', async () => {
    const result = await projectVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeProject({ id: 'proj_a' })),
    );
    expect(result).toBeNull();
  });

  it('emits a tasks-per-day rate at the sample floor (30 tasks / 30 days = 1.0/day)', async () => {
    seedCompletedTasks('proj_a', 30);
    const value = await expectValue(buildCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.score).toBeCloseTo(1, 10);
    expect(value.sample_count).toBe(30);
    expect(value.confidence).toBeCloseTo(0.3, 10);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits a higher rate as sample_count grows above the floor', async () => {
    seedCompletedTasks('proj_a', 60);
    const value = await expectValue(buildCtx(), fakeProject({ id: 'proj_a' }));
    // 60 tasks in 30 days = 2 tasks/day.
    expect(value.score).toBeCloseTo(2, 10);
    expect(value.sample_count).toBe(60);
    expect(value.confidence).toBeCloseTo(0.6, 10);
  });

  it('saturates confidence at 1.0 when sample_count reaches the saturation cap', async () => {
    seedCompletedTasks('proj_a', 100);
    const value = await expectValue(buildCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.sample_count).toBe(100);
    expect(value.confidence).toBe(1);
    // 100 tasks in 30 days ≈ 3.33 tasks/day. Score is NOT saturated —
    // only confidence saturates; score is raw rate.
    expect(value.score).toBeCloseTo(100 / 30, 5);
  });

  it('stamps event_at to MAX(completed_at) across contributing rows', async () => {
    seedCompletedTasks('proj_a', 30);
    const out = await projectVelocityProducer.produce(
      buildCtx(),
      sourceFor(fakeProject({ id: 'proj_a' })),
    );
    expect(out?.event_at).toBe(NOW);
  });

  it('excludes tasks completed before the 30d window from the rate', async () => {
    // Seed 30 in-window + 50 ancient.
    seedCompletedTasks('proj_a', 30, 29, 'recent');
    for (let i = 0; i < 50; i++) {
      insertTask({
        id: `ancient_${i}`,
        parent_project_id: 'proj_a',
        done: 1,
        completed_at: NOW - 90 * DAY,
      });
    }
    const value = await expectValue(buildCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.sample_count).toBe(30);
    expect(value.score).toBeCloseTo(1, 10);
  });

  it('isolates per project across the cycle', async () => {
    seedCompletedTasks('proj_a', 30);
    seedCompletedTasks('proj_b', 60);
    const a = await expectValue(buildCtx(), fakeProject({ id: 'proj_a' }));
    const b = await expectValue(buildCtx(), fakeProject({ id: 'proj_b' }));
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
    const def = ENRICHMENT_REGISTRY.project_velocity;
    const result = def.value_schema({
      score: 1.5,
      sample_count: 45,
      confidence: 0.45,
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

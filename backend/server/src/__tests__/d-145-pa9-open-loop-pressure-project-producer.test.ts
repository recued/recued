/** D-145 PA9 — `open_loop_pressure` per-project producer tests.
 *
 *  Companion to [[d-145-pa9-open-loop-pressure-producer]] which covers
 *  the per-contact scope. This file covers the per-project scope that
 *  rides the multi-scope task-id substrate slice (third per-record
 *  producer on `walker_kind: 'project'` after [[project_next_action_gap]]
 *  + [[project_stall_signal]]).
 *
 *  Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / three-collection scope_read shape — no mail row)
 *    - aggregateOpenCommitmentsForProject SQL (json_each membership,
 *      direction filter, lifecycle filter, tombstone exclusion,
 *      empty-id short-circuit, age weighting, clock-skew clamp)
 *    - aggregateOpenTasksForProject SQL (parent_project_id narrow,
 *      done filter, tombstone exclusion, empty-id short-circuit)
 *    - produce() integration: not-active abstention (paused / completed
 *      / archived), sample-floor abstention (zero open), mixed
 *      two-source fold, pressure-score saturation
 *    - Pure helper reuse (importing from per-contact module)
 *
 *  No registry-acceptance test — that's already covered in the
 *  per-contact suite; the value shape is identical across scopes. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type OpenLoopPressureValue,
  type Project,
} from '@recued/contracts';

import {
  aggregateOpenCommitmentsForProject,
  aggregateOpenTasksForProject,
  openLoopPressureProjectProducer,
  OPEN_LOOP_PRESSURE_SATURATION_DAYS,
  computePressureScore,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import { COMMITMENT_TABLE, TASK_TABLE } from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-pressure-project-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Minimal commitment table — only the columns the producer reads.
  // `blocks_project_ids` is a JSON TEXT column matching the
  // work-entity-store schema; `json_each` narrows membership.
  db.exec(`
    CREATE TABLE ${COMMITMENT_TABLE} (
      id                       TEXT PRIMARY KEY,
      direction                TEXT NOT NULL,
      lifecycle_state          TEXT NOT NULL DEFAULT 'pending',
      blocks_project_ids       TEXT NOT NULL DEFAULT '[]',
      state_changed_at         INTEGER NOT NULL,
      sync_state               TEXT NOT NULL DEFAULT 'live',
      deleted_at               INTEGER
    );
  `);
  // Minimal task table — only the columns the producer reads.
  db.exec(`
    CREATE TABLE ${TASK_TABLE} (
      id                   TEXT PRIMARY KEY,
      parent_project_id    TEXT,
      done                 INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL,
      sync_state           TEXT NOT NULL DEFAULT 'live',
      deleted_at           INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CommitmentRow {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  lifecycle_state?: 'pending' | 'fulfilled' | 'cancelled' | 'expired';
  blocks_project_ids?: readonly string[];
  state_changed_at?: number;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertCommitment = (row: CommitmentRow): void => {
  db.prepare(
    `INSERT INTO ${COMMITMENT_TABLE}
       (id, direction, lifecycle_state, blocks_project_ids, state_changed_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.direction,
    row.lifecycle_state ?? 'pending',
    JSON.stringify(row.blocks_project_ids ?? []),
    row.state_changed_at ?? NOW,
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

interface TaskRow {
  id: string;
  parent_project_id?: string | null;
  done?: 0 | 1;
  updated_at?: number;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertTask = (row: TaskRow): void => {
  db.prepare(
    `INSERT INTO ${TASK_TABLE}
       (id, parent_project_id, done, updated_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parent_project_id ?? null,
    row.done ?? 0,
    row.updated_at ?? NOW,
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

const stubCtx = (now: number = NOW): HousekeepingContext => ({
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
  created_at: overrides.created_at ?? NOW - 30 * DAY,
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
  ...(overrides.description !== undefined ? { description: overrides.description } : {}),
  ...(overrides.target_completion_at !== undefined
    ? { target_completion_at: overrides.target_completion_at }
    : {}),
  ...(overrides.parent_project_id !== undefined
    ? { parent_project_id: overrides.parent_project_id }
    : {}),
  ...(overrides.connection_id !== undefined ? { connection_id: overrides.connection_id } : {}),
  ...(overrides.deleted_at !== undefined ? { deleted_at: overrides.deleted_at } : {}),
  ...(overrides.source_extension_blob !== undefined
    ? { source_extension_blob: overrides.source_extension_blob }
    : {}),
});

const sourceFor = (project: Project): SourceRecord<Project> => ({
  target_id: project.id,
  data: project,
  cursor_token: project.id,
});

const expectValue = async (
  ctx: HousekeepingContext,
  project: Project,
): Promise<OpenLoopPressureValue> => {
  const out = await openLoopPressureProjectProducer.produce(ctx, sourceFor(project));
  if (out === null) throw new Error(`expected producer output for ${project.id}, got null`);
  return out.value as OpenLoopPressureValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('openLoopPressureProjectProducer surface contract', () => {
  it('targets the open_loop_pressure registry topic (shared with per-contact)', () => {
    expect(openLoopPressureProjectProducer.topic).toBe('open_loop_pressure');
  });

  it('targets the project source scope', () => {
    expect(openLoopPressureProjectProducer.source_scope).toBe('project');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(openLoopPressureProjectProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(openLoopPressureProjectProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(openLoopPressureProjectProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for project + commitment + task (no mail — projects are not mail-scoped)', () => {
    const decls = openLoopPressureProjectProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual([
      'data.project',
      'data.commitment',
      'data.task',
    ]);
    expect(decls.find((e) => e.collection === 'data.commitment')!.sample_field_paths).toEqual([
      'blocks_project_ids',
      'lifecycle_state',
      'direction',
      'state_changed_at',
    ]);
    expect(decls.find((e) => e.collection === 'data.task')!.sample_field_paths).toEqual([
      'parent_project_id',
      'done',
      'updated_at',
    ]);
  });

  it('shares the 60-day saturation cap with the per-contact scope', () => {
    expect(OPEN_LOOP_PRESSURE_SATURATION_DAYS).toBe(60);
  });
});

// ────────────────────────────────────────────────────────────────
// aggregateOpenCommitmentsForProject SQL
// ────────────────────────────────────────────────────────────────

describe('aggregateOpenCommitmentsForProject', () => {
  it('returns zero aggregate for an empty project_id', () => {
    expect(aggregateOpenCommitmentsForProject(stubCtx(), '', NOW)).toEqual({
      count: 0,
      age_weighted: 0,
    });
  });

  it('counts open inbound + outbound commitments linked via blocks_project_ids', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 5 * DAY,
    });
    insertCommitment({
      id: 'c2',
      direction: 'outbound',
      blocks_project_ids: ['proj_a', 'proj_b'],
      state_changed_at: NOW - 10 * DAY,
    });
    const agg = aggregateOpenCommitmentsForProject(stubCtx(), 'proj_a', NOW);
    expect(agg.count).toBe(2);
    expect(agg.age_weighted).toBeCloseTo(15, 5);
  });

  it('excludes internal-direction commitments', () => {
    insertCommitment({
      id: 'c1',
      direction: 'internal',
      blocks_project_ids: ['proj_a'],
    });
    expect(aggregateOpenCommitmentsForProject(stubCtx(), 'proj_a', NOW).count).toBe(0);
  });

  it('excludes non-pending lifecycle states', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      lifecycle_state: 'fulfilled',
      blocks_project_ids: ['proj_a'],
    });
    insertCommitment({
      id: 'c2',
      direction: 'outbound',
      lifecycle_state: 'cancelled',
      blocks_project_ids: ['proj_a'],
    });
    insertCommitment({
      id: 'c3',
      direction: 'outbound',
      lifecycle_state: 'expired',
      blocks_project_ids: ['proj_a'],
    });
    expect(aggregateOpenCommitmentsForProject(stubCtx(), 'proj_a', NOW).count).toBe(0);
  });

  it('excludes tombstoned commitments', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      blocks_project_ids: ['proj_a'],
      deleted_at: NOW,
    });
    insertCommitment({
      id: 'c2',
      direction: 'inbound',
      blocks_project_ids: ['proj_a'],
      sync_state: 'tombstoned',
    });
    expect(aggregateOpenCommitmentsForProject(stubCtx(), 'proj_a', NOW).count).toBe(0);
  });

  it('ignores commitments not linked to this project', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      blocks_project_ids: ['proj_b'],
    });
    expect(aggregateOpenCommitmentsForProject(stubCtx(), 'proj_a', NOW).count).toBe(0);
  });

  it('clamps age weight to 0 for future-dated commitments (clock skew)', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW + 10 * DAY,
    });
    const agg = aggregateOpenCommitmentsForProject(stubCtx(), 'proj_a', NOW);
    expect(agg.count).toBe(1);
    expect(agg.age_weighted).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// aggregateOpenTasksForProject SQL
// ────────────────────────────────────────────────────────────────

describe('aggregateOpenTasksForProject', () => {
  it('returns zero aggregate for an empty project_id', () => {
    expect(aggregateOpenTasksForProject(stubCtx(), '', NOW)).toEqual({
      count: 0,
      age_weighted: 0,
    });
  });

  it('counts open tasks parented to this project', () => {
    insertTask({
      id: 't1',
      parent_project_id: 'proj_a',
      updated_at: NOW - 3 * DAY,
    });
    insertTask({
      id: 't2',
      parent_project_id: 'proj_a',
      updated_at: NOW - 7 * DAY,
    });
    const agg = aggregateOpenTasksForProject(stubCtx(), 'proj_a', NOW);
    expect(agg.count).toBe(2);
    expect(agg.age_weighted).toBeCloseTo(10, 5);
  });

  it('excludes done tasks', () => {
    insertTask({
      id: 't1',
      parent_project_id: 'proj_a',
      done: 1,
    });
    expect(aggregateOpenTasksForProject(stubCtx(), 'proj_a', NOW).count).toBe(0);
  });

  it('excludes tasks parented to other projects', () => {
    insertTask({
      id: 't1',
      parent_project_id: 'proj_b',
    });
    expect(aggregateOpenTasksForProject(stubCtx(), 'proj_a', NOW).count).toBe(0);
  });

  it('excludes tombstoned tasks', () => {
    insertTask({
      id: 't1',
      parent_project_id: 'proj_a',
      deleted_at: NOW,
    });
    insertTask({
      id: 't2',
      parent_project_id: 'proj_a',
      sync_state: 'tombstoned',
    });
    expect(aggregateOpenTasksForProject(stubCtx(), 'proj_a', NOW).count).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('produce() integration', () => {
  it('abstains on paused projects (intentionally dormant)', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', updated_at: NOW - 5 * DAY });
    const result = await openLoopPressureProjectProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'paused' })),
    );
    expect(result).toBeNull();
  });

  it('abstains on completed projects (intentionally finished)', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', updated_at: NOW - 5 * DAY });
    const result = await openLoopPressureProjectProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'completed' })),
    );
    expect(result).toBeNull();
  });

  it('abstains on archived projects', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', updated_at: NOW - 5 * DAY });
    const result = await openLoopPressureProjectProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'archived' })),
    );
    expect(result).toBeNull();
  });

  it('abstains on active project with zero open work (sample floor unmet)', async () => {
    const result = await openLoopPressureProjectProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a' })),
    );
    expect(result).toBeNull();
  });

  it('folds open commitments + open tasks into the pressure value', async () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 6 * DAY,
    });
    insertTask({ id: 't1', parent_project_id: 'proj_a', updated_at: NOW - 3 * DAY });
    insertTask({ id: 't2', parent_project_id: 'proj_a', updated_at: NOW - 5 * DAY });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.open_count).toBe(3); // 1 commitment + 2 tasks
    expect(value.age_weighted_score).toBeCloseTo(14, 5); // 6 + 3 + 5
    expect(value.pressure_score).toBeCloseTo(14 / 60, 10);
    expect(value.computed_at).toBe(NOW);
  });

  it('saturates pressure_score at 1.0 for >= 60 person-days of open loop', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', updated_at: NOW - 100 * DAY });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.open_count).toBe(1);
    expect(value.age_weighted_score).toBeCloseTo(100, 5);
    expect(value.pressure_score).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helper reuse from per-contact module
// ────────────────────────────────────────────────────────────────

describe('shared pure helpers', () => {
  it('per-project producer composes pressure via the per-contact computePressureScore', () => {
    // Sanity check that the import linkage works + saturation matches.
    expect(computePressureScore(30)).toBeCloseTo(0.5, 10);
    expect(computePressureScore(60)).toBe(1);
  });
});

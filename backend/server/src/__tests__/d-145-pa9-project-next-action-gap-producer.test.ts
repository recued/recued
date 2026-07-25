/** D-145 PA9 — `project_next_action_gap` producer tests.
 *
 *  Sixth D-145 PA9 producer impl + third per-record producer on a
 *  work-entity scope (`walker_kind: 'project'`, following note + task
 *  walker patterns). First cross-entity reader — produce() reads
 *  tasks / commitments / notes per project via ctx.db. Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration four-collection shape)
 *    - countOpenTasksForProject SQL (parent_project_id narrow, done=0
 *      filter, tombstone exclusion, empty-id short-circuit)
 *    - countPendingCommitmentsForProject SQL (blocks_project_ids JSON
 *      array membership via json_each, lifecycle_state='pending'
 *      filter, tombstone exclusion)
 *    - countRecentNotesForProject SQL (related_project_ids JSON
 *      membership, last_user_action_at window, tombstone exclusion)
 *    - computeGapSignals pure cases (zero-count → matching token,
 *      multi-signal ordering, all-three-zero, all-three-present)
 *    - produce() integration: not-active abstention, empty-id
 *      abstention, gap_present:true with subset signals, gap_present:
 *      false with all children present
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
  PROJECT_NEXT_ACTION_GAP_DECLARATION,
  type Project,
  type ProjectNextActionGapValue,
} from '@recued/contracts';

import {
  PROJECT_NEXT_ACTION_GAP_RECENT_NOTE_WINDOW_MS,
  PROJECT_NEXT_ACTION_GAP_SIGNALS,
  computeGapSignals,
  countOpenTasksForProject,
  countPendingCommitmentsForProject,
  countRecentNotesForProject,
  projectNextActionGapProducer,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import {
  COMMITMENT_TABLE,
  NOTE_TABLE,
  TASK_TABLE,
} from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-gap-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Minimal schemas — mirror the columns the producer reads, no more.
  // `sync_state` defaults to 'live' so undecorated inserts pass the
  // `sync_state IN ('live','stale_unreachable')` filter without setting
  // it explicitly.
  db.exec(`
    CREATE TABLE ${TASK_TABLE} (
      id                  TEXT PRIMARY KEY,
      parent_project_id   TEXT,
      done                INTEGER NOT NULL DEFAULT 0,
      sync_state          TEXT NOT NULL DEFAULT 'live',
      deleted_at          INTEGER
    );
  `);
  db.exec(`
    CREATE TABLE ${COMMITMENT_TABLE} (
      id                  TEXT PRIMARY KEY,
      lifecycle_state     TEXT NOT NULL DEFAULT 'pending',
      blocks_project_ids  TEXT NOT NULL DEFAULT '[]',
      sync_state          TEXT NOT NULL DEFAULT 'live',
      deleted_at          INTEGER
    );
  `);
  db.exec(`
    CREATE TABLE ${NOTE_TABLE} (
      id                   TEXT PRIMARY KEY,
      related_project_ids  TEXT NOT NULL DEFAULT '[]',
      last_user_action_at  INTEGER NOT NULL,
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
  parent_project_id?: string | null;
  done?: 0 | 1;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertTask = (row: TaskRow): void => {
  db.prepare(
    `INSERT INTO ${TASK_TABLE} (id, parent_project_id, done, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parent_project_id ?? null,
    row.done ?? 0,
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

interface CommitmentRow {
  id: string;
  lifecycle_state?: 'pending' | 'fulfilled' | 'cancelled' | 'expired';
  blocks_project_ids?: readonly string[];
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertCommitment = (row: CommitmentRow): void => {
  db.prepare(
    `INSERT INTO ${COMMITMENT_TABLE}
       (id, lifecycle_state, blocks_project_ids, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.lifecycle_state ?? 'pending',
    JSON.stringify(row.blocks_project_ids ?? []),
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

interface NoteRow {
  id: string;
  related_project_ids?: readonly string[];
  last_user_action_at?: number;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertNote = (row: NoteRow): void => {
  db.prepare(
    `INSERT INTO ${NOTE_TABLE}
       (id, related_project_ids, last_user_action_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    JSON.stringify(row.related_project_ids ?? []),
    row.last_user_action_at ?? NOW,
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
  created_at: overrides.created_at ?? NOW - 30 * ONE_DAY,
  updated_at: overrides.updated_at ?? NOW - ONE_DAY,
  last_activity_at: overrides.last_activity_at ?? NOW - ONE_DAY,
  related_contact_ids: overrides.related_contact_ids ?? [],
  source_id: overrides.source_id ?? 'src_recued',
  source_record_id: overrides.source_record_id ?? overrides.id,
  source_updated_at: overrides.source_updated_at ?? NOW - ONE_DAY,
  last_seen_at: overrides.last_seen_at ?? NOW - ONE_DAY,
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
): Promise<ProjectNextActionGapValue> => {
  const out = await projectNextActionGapProducer.produce(ctx, sourceFor(project));
  if (out === null) throw new Error(`expected producer output for ${project.id}, got null`);
  return out.value as ProjectNextActionGapValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('projectNextActionGapProducer surface contract', () => {
  it('targets the project_next_action_gap registry topic', () => {
    expect(projectNextActionGapProducer.topic).toBe('project_next_action_gap');
  });

  it('targets the project source scope (novel walker_kind: "project" — third work-entity scope)', () => {
    expect(projectNextActionGapProducer.source_scope).toBe('project');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(projectNextActionGapProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(projectNextActionGapProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(projectNextActionGapProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for project + task + commitment + note with the load-bearing fields', () => {
    const decls = projectNextActionGapProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual([
      'data.project',
      'data.task',
      'data.commitment',
      'data.note',
    ]);
    expect(decls.find((e) => e.collection === 'data.project')!.sample_field_paths).toEqual([
      'id',
      'state',
    ]);
    expect(decls.find((e) => e.collection === 'data.task')!.sample_field_paths).toEqual([
      'parent_project_id',
      'done',
    ]);
    expect(decls.find((e) => e.collection === 'data.commitment')!.sample_field_paths).toEqual([
      'blocks_project_ids',
      'lifecycle_state',
    ]);
    expect(decls.find((e) => e.collection === 'data.note')!.sample_field_paths).toEqual([
      'related_project_ids',
      'last_user_action_at',
    ]);
  });

  it('window constant is 14 days (matches stalled-projects pack semantics)', () => {
    expect(PROJECT_NEXT_ACTION_GAP_RECENT_NOTE_WINDOW_MS).toBe(14 * ONE_DAY);
  });

  it('exposes a closed list of gap_signal tokens', () => {
    expect(PROJECT_NEXT_ACTION_GAP_SIGNALS).toEqual([
      'no_open_task',
      'no_pending_commitment',
      'no_recent_note',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Producer-kind alignment (declaration + registry both housekeeping)
// ────────────────────────────────────────────────────────────────

describe('producer_kind alignment', () => {
  it('declaration carries producer_kind: "housekeeping" (per the reactive-harness-lift deferral)', () => {
    expect(PROJECT_NEXT_ACTION_GAP_DECLARATION.producer_kind).toBe('housekeeping');
  });

  it('registry entry carries producer_kind: "housekeeping" so buildEnrichmentProducerTask accepts it', () => {
    expect(ENRICHMENT_REGISTRY.project_next_action_gap.producer_kind).toBe('housekeeping');
  });
});

// ────────────────────────────────────────────────────────────────
// computeGapSignals pure cases
// ────────────────────────────────────────────────────────────────

describe('computeGapSignals', () => {
  it('returns empty when every count is non-zero', () => {
    expect(computeGapSignals(1, 1, 1)).toEqual([]);
  });

  it('emits no_open_task when open task count is zero', () => {
    expect(computeGapSignals(0, 1, 1)).toEqual(['no_open_task']);
  });

  it('emits no_pending_commitment when pending commitment count is zero', () => {
    expect(computeGapSignals(1, 0, 1)).toEqual(['no_pending_commitment']);
  });

  it('emits no_recent_note when recent note count is zero', () => {
    expect(computeGapSignals(1, 1, 0)).toEqual(['no_recent_note']);
  });

  it('emits multiple signals in declaration order (task → commitment → note)', () => {
    expect(computeGapSignals(0, 0, 1)).toEqual(['no_open_task', 'no_pending_commitment']);
    expect(computeGapSignals(1, 0, 0)).toEqual(['no_pending_commitment', 'no_recent_note']);
  });

  it('emits all three when no children exist (empty project)', () => {
    expect(computeGapSignals(0, 0, 0)).toEqual([
      'no_open_task',
      'no_pending_commitment',
      'no_recent_note',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// countOpenTasksForProject SQL helper
// ────────────────────────────────────────────────────────────────

describe('countOpenTasksForProject', () => {
  it('counts only tasks for the matching project_id', () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a' });
    insertTask({ id: 't2', parent_project_id: 'proj_b' });
    insertTask({ id: 't3', parent_project_id: 'proj_a' });
    expect(countOpenTasksForProject(stubCtx(), 'proj_a')).toBe(2);
    expect(countOpenTasksForProject(stubCtx(), 'proj_b')).toBe(1);
  });

  it('excludes done tasks', () => {
    insertTask({ id: 't_open', parent_project_id: 'proj_a', done: 0 });
    insertTask({ id: 't_done', parent_project_id: 'proj_a', done: 1 });
    expect(countOpenTasksForProject(stubCtx(), 'proj_a')).toBe(1);
  });

  it('excludes tasks with null parent_project_id even when project_id is empty string', () => {
    insertTask({ id: 't_orphan', parent_project_id: null });
    expect(countOpenTasksForProject(stubCtx(), '')).toBe(0);
  });

  it('excludes tombstoned tasks', () => {
    insertTask({ id: 't_live', parent_project_id: 'proj_a' });
    insertTask({ id: 't_tomb', parent_project_id: 'proj_a', sync_state: 'tombstoned' });
    expect(countOpenTasksForProject(stubCtx(), 'proj_a')).toBe(1);
  });

  it('excludes tasks with deleted_at set even when sync_state still live (pre-tombstone race)', () => {
    insertTask({ id: 't_live', parent_project_id: 'proj_a' });
    insertTask({ id: 't_del', parent_project_id: 'proj_a', deleted_at: NOW });
    expect(countOpenTasksForProject(stubCtx(), 'proj_a')).toBe(1);
  });

  it('includes stale_unreachable tasks (matches walker filter)', () => {
    insertTask({ id: 't_stale', parent_project_id: 'proj_a', sync_state: 'stale_unreachable' });
    expect(countOpenTasksForProject(stubCtx(), 'proj_a')).toBe(1);
  });

  it('returns 0 for empty project_id (defensive short-circuit)', () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a' });
    expect(countOpenTasksForProject(stubCtx(), '')).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// countPendingCommitmentsForProject SQL helper
// ────────────────────────────────────────────────────────────────

describe('countPendingCommitmentsForProject', () => {
  it('counts pending commitments whose blocks_project_ids JSON contains the project id', () => {
    insertCommitment({ id: 'c1', blocks_project_ids: ['proj_a'] });
    insertCommitment({ id: 'c2', blocks_project_ids: ['proj_b'] });
    insertCommitment({ id: 'c3', blocks_project_ids: ['proj_a', 'proj_b'] });
    expect(countPendingCommitmentsForProject(stubCtx(), 'proj_a')).toBe(2);
    expect(countPendingCommitmentsForProject(stubCtx(), 'proj_b')).toBe(2);
  });

  it('excludes non-pending commitments', () => {
    insertCommitment({ id: 'c_pending', blocks_project_ids: ['proj_a'], lifecycle_state: 'pending' });
    insertCommitment({ id: 'c_fulfilled', blocks_project_ids: ['proj_a'], lifecycle_state: 'fulfilled' });
    insertCommitment({ id: 'c_cancelled', blocks_project_ids: ['proj_a'], lifecycle_state: 'cancelled' });
    insertCommitment({ id: 'c_expired', blocks_project_ids: ['proj_a'], lifecycle_state: 'expired' });
    expect(countPendingCommitmentsForProject(stubCtx(), 'proj_a')).toBe(1);
  });

  it('excludes commitments whose blocks_project_ids array does not contain the project id', () => {
    insertCommitment({ id: 'c_unrelated', blocks_project_ids: ['proj_x', 'proj_y'] });
    expect(countPendingCommitmentsForProject(stubCtx(), 'proj_a')).toBe(0);
  });

  it('excludes commitments with empty blocks_project_ids array', () => {
    insertCommitment({ id: 'c_empty', blocks_project_ids: [] });
    expect(countPendingCommitmentsForProject(stubCtx(), 'proj_a')).toBe(0);
  });

  it('excludes tombstoned commitments', () => {
    insertCommitment({ id: 'c_live', blocks_project_ids: ['proj_a'] });
    insertCommitment({
      id: 'c_tomb',
      blocks_project_ids: ['proj_a'],
      sync_state: 'tombstoned',
    });
    expect(countPendingCommitmentsForProject(stubCtx(), 'proj_a')).toBe(1);
  });

  it('excludes commitments with deleted_at set (pre-tombstone race)', () => {
    insertCommitment({ id: 'c_live', blocks_project_ids: ['proj_a'] });
    insertCommitment({ id: 'c_del', blocks_project_ids: ['proj_a'], deleted_at: NOW });
    expect(countPendingCommitmentsForProject(stubCtx(), 'proj_a')).toBe(1);
  });

  it('returns 0 for empty project_id (defensive short-circuit)', () => {
    insertCommitment({ id: 'c1', blocks_project_ids: ['proj_a'] });
    expect(countPendingCommitmentsForProject(stubCtx(), '')).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// countRecentNotesForProject SQL helper
// ────────────────────────────────────────────────────────────────

describe('countRecentNotesForProject', () => {
  it('counts notes whose related_project_ids contains the project id AND last_user_action_at >= since', () => {
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    insertNote({
      id: 'n2',
      related_project_ids: ['proj_b'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    insertNote({
      id: 'n3',
      related_project_ids: ['proj_a', 'proj_b'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const since = NOW - 14 * ONE_DAY;
    expect(countRecentNotesForProject(stubCtx(), 'proj_a', since)).toBe(2);
    expect(countRecentNotesForProject(stubCtx(), 'proj_b', since)).toBe(2);
  });

  it('excludes notes outside the recent window', () => {
    insertNote({
      id: 'n_old',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 60 * ONE_DAY,
    });
    insertNote({
      id: 'n_recent',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const since = NOW - 14 * ONE_DAY;
    expect(countRecentNotesForProject(stubCtx(), 'proj_a', since)).toBe(1);
  });

  it('includes notes exactly on the window boundary (>= since)', () => {
    insertNote({
      id: 'n_boundary',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 14 * ONE_DAY,
    });
    const since = NOW - 14 * ONE_DAY;
    expect(countRecentNotesForProject(stubCtx(), 'proj_a', since)).toBe(1);
  });

  it('excludes notes with empty related_project_ids array', () => {
    insertNote({
      id: 'n_orphan',
      related_project_ids: [],
      last_user_action_at: NOW,
    });
    const since = NOW - 14 * ONE_DAY;
    expect(countRecentNotesForProject(stubCtx(), 'proj_a', since)).toBe(0);
  });

  it('excludes tombstoned notes', () => {
    insertNote({
      id: 'n_live',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW,
    });
    insertNote({
      id: 'n_tomb',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW,
      sync_state: 'tombstoned',
    });
    const since = NOW - 14 * ONE_DAY;
    expect(countRecentNotesForProject(stubCtx(), 'proj_a', since)).toBe(1);
  });

  it('excludes notes with deleted_at set (pre-tombstone race)', () => {
    insertNote({
      id: 'n_live',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW,
    });
    insertNote({
      id: 'n_del',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW,
      deleted_at: NOW,
    });
    const since = NOW - 14 * ONE_DAY;
    expect(countRecentNotesForProject(stubCtx(), 'proj_a', since)).toBe(1);
  });

  it('returns 0 for empty project_id (defensive short-circuit)', () => {
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW,
    });
    expect(countRecentNotesForProject(stubCtx(), '', NOW - 14 * ONE_DAY)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('projectNextActionGapProducer.produce()', () => {
  it('returns null for projects with empty id (defensive)', async () => {
    const out = await projectNextActionGapProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: '' })),
    );
    expect(out).toBeNull();
  });

  it('returns null for paused projects (engine drives next-action only on active)', async () => {
    const out = await projectNextActionGapProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'paused' })),
    );
    expect(out).toBeNull();
  });

  it('returns null for completed projects', async () => {
    const out = await projectNextActionGapProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'completed' })),
    );
    expect(out).toBeNull();
  });

  it('returns null for archived projects', async () => {
    const out = await projectNextActionGapProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'archived' })),
    );
    expect(out).toBeNull();
  });

  it('emits gap_present: true with all three signals for an empty project', async () => {
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.gap_present).toBe(true);
    expect(value.gap_signals).toEqual([
      'no_open_task',
      'no_pending_commitment',
      'no_recent_note',
    ]);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits gap_present: false when every child kind has at least one matching row', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', done: 0 });
    insertCommitment({ id: 'c1', blocks_project_ids: ['proj_a'], lifecycle_state: 'pending' });
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.gap_present).toBe(false);
    expect(value.gap_signals).toEqual([]);
  });

  it('emits the no_open_task signal when only tasks are missing', async () => {
    insertCommitment({ id: 'c1', blocks_project_ids: ['proj_a'] });
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.gap_present).toBe(true);
    expect(value.gap_signals).toEqual(['no_open_task']);
  });

  it('emits the no_pending_commitment signal when only commitments are missing', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', done: 0 });
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.gap_present).toBe(true);
    expect(value.gap_signals).toEqual(['no_pending_commitment']);
  });

  it('emits the no_recent_note signal when only notes are missing', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', done: 0 });
    insertCommitment({ id: 'c1', blocks_project_ids: ['proj_a'] });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.gap_present).toBe(true);
    expect(value.gap_signals).toEqual(['no_recent_note']);
  });

  it('treats a done task as "no open task"', async () => {
    insertTask({ id: 't_done', parent_project_id: 'proj_a', done: 1 });
    insertCommitment({ id: 'c1', blocks_project_ids: ['proj_a'] });
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.gap_signals).toEqual(['no_open_task']);
  });

  it('treats a fulfilled commitment as "no pending commitment"', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', done: 0 });
    insertCommitment({
      id: 'c1',
      blocks_project_ids: ['proj_a'],
      lifecycle_state: 'fulfilled',
    });
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.gap_signals).toEqual(['no_pending_commitment']);
  });

  it('treats a note older than 14 days as "no recent note"', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', done: 0 });
    insertCommitment({ id: 'c1', blocks_project_ids: ['proj_a'] });
    insertNote({
      id: 'n_old',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 30 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(value.gap_signals).toEqual(['no_recent_note']);
  });

  it('isolates child counts per project — other projects do not contribute', async () => {
    insertTask({ id: 't_a', parent_project_id: 'proj_a', done: 0 });
    insertTask({ id: 't_b', parent_project_id: 'proj_b', done: 0 });
    insertCommitment({ id: 'c_a', blocks_project_ids: ['proj_a'] });
    insertCommitment({ id: 'c_b', blocks_project_ids: ['proj_b'] });
    insertNote({
      id: 'n_a',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    // proj_b has tasks + commitments but no recent notes.
    const valueB = await expectValue(stubCtx(), fakeProject({ id: 'proj_b' }));
    expect(valueB.gap_signals).toEqual(['no_recent_note']);
    // proj_a has everything.
    const valueA = await expectValue(stubCtx(), fakeProject({ id: 'proj_a' }));
    expect(valueA.gap_signals).toEqual([]);
  });

  it('emits computed_at from ctx.now() (deterministic clock)', async () => {
    const ctx = stubCtx(NOW + 999);
    const value = await expectValue(ctx, fakeProject({ id: 'proj_a' }));
    expect(value.computed_at).toBe(NOW + 999);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('ENRICHMENT_REGISTRY.project_next_action_gap.value_schema', () => {
  it('accepts a producer-shaped value', () => {
    const def = ENRICHMENT_REGISTRY.project_next_action_gap;
    const result = def.value_schema({
      gap_present: true,
      gap_signals: ['no_open_task', 'no_recent_note'],
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts gap_present: false with empty signals list', () => {
    const def = ENRICHMENT_REGISTRY.project_next_action_gap;
    const result = def.value_schema({
      gap_present: false,
      gap_signals: [],
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects values missing computed_at', () => {
    const def = ENRICHMENT_REGISTRY.project_next_action_gap;
    const result = def.value_schema({
      gap_present: true,
      gap_signals: ['no_open_task'],
    });
    expect(result.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry shape alignment
// ────────────────────────────────────────────────────────────────

describe('ENRICHMENT_REGISTRY.project_next_action_gap shape', () => {
  it('declares shape: per_record + scope: project', () => {
    const def = ENRICHMENT_REGISTRY.project_next_action_gap;
    expect(def.shape).toBe('per_record');
    if (def.shape === 'per_record') {
      expect(def.valid_scopes).toEqual(['project']);
    }
  });

  it('declares aggregates_from across the four child scopes', () => {
    const def = ENRICHMENT_REGISTRY.project_next_action_gap;
    expect(def.aggregates_from).toEqual(['project', 'task', 'note', 'commitment']);
  });

  it('declares 24h recompute cadence', () => {
    const def = ENRICHMENT_REGISTRY.project_next_action_gap;
    expect(def.recompute_cadence).toBe('24h');
  });

  it('declares temporal_class: stable_truth + identity_aggregation: scenario (snapshot semantics)', () => {
    const def = ENRICHMENT_REGISTRY.project_next_action_gap;
    expect(def.temporal_class).toBe('stable_truth');
    expect(def.identity_aggregation).toBe('scenario');
  });

  it('declares lifecycle_policy: recompute_on_drift (re-derives on child cascade)', () => {
    const def = ENRICHMENT_REGISTRY.project_next_action_gap;
    expect(def.lifecycle_policy).toBe('recompute_on_drift');
  });
});

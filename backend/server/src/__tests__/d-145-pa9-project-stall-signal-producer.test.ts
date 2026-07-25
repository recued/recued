/** D-145 PA9 — `project_stall_signal` producer tests.
 *
 *  Eighth D-145 PA9 producer impl + second per-record producer on
 *  `walker_kind: 'project'`, after [[project_next_action_gap]]. Shares
 *  the project walker + cross-entity read pattern; differs in temporal
 *  framing — this producer carries recency (MAX child timestamps vs
 *  the cutoff) rather than structural counts. Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration four-collection shape)
 *    - maxTaskActivityForProject SQL (parent_project_id narrow,
 *      tombstone exclusion, empty-id short-circuit, null on no rows)
 *    - maxCommitmentActivityForProject SQL (blocks_project_ids JSON
 *      array membership, all-lifecycle inclusion, tombstone exclusion)
 *    - maxNoteActivityForProject SQL (related_project_ids JSON
 *      membership, tombstone exclusion)
 *    - composeStallSignals pure cases (null → token, old → token,
 *      fresh → no token, mixed orderings)
 *    - effectiveLastActivity helper (MAX defense + all-null returns
 *      null)
 *    - produce() integration: not-active abstention, empty-id
 *      abstention, stalled:true with all signals, fresh project,
 *      project-rollup-drift defense
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
  PROJECT_STALL_SIGNAL_DECLARATION,
  type Project,
  type ProjectStallSignalValue,
} from '@recued/contracts';

import {
  PROJECT_STALL_SIGNAL_WINDOW_MS,
  PROJECT_STALL_SIGNAL_TOKENS,
  composeStallSignals,
  effectiveLastActivity,
  maxCommitmentActivityForProject,
  maxNoteActivityForProject,
  maxTaskActivityForProject,
  projectStallSignalProducer,
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
const CUTOFF = NOW - PROJECT_STALL_SIGNAL_WINDOW_MS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-stall-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Minimal schemas — mirror the columns the producer reads, no more.
  db.exec(`
    CREATE TABLE ${TASK_TABLE} (
      id                  TEXT PRIMARY KEY,
      parent_project_id   TEXT,
      updated_at          INTEGER NOT NULL,
      sync_state          TEXT NOT NULL DEFAULT 'live',
      deleted_at          INTEGER
    );
  `);
  db.exec(`
    CREATE TABLE ${COMMITMENT_TABLE} (
      id                   TEXT PRIMARY KEY,
      blocks_project_ids   TEXT NOT NULL DEFAULT '[]',
      state_changed_at     INTEGER NOT NULL,
      sync_state           TEXT NOT NULL DEFAULT 'live',
      deleted_at           INTEGER
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
  updated_at?: number;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertTask = (row: TaskRow): void => {
  db.prepare(
    `INSERT INTO ${TASK_TABLE} (id, parent_project_id, updated_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parent_project_id ?? null,
    row.updated_at ?? NOW,
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

interface CommitmentRow {
  id: string;
  blocks_project_ids?: readonly string[];
  state_changed_at?: number;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertCommitment = (row: CommitmentRow): void => {
  db.prepare(
    `INSERT INTO ${COMMITMENT_TABLE}
       (id, blocks_project_ids, state_changed_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    JSON.stringify(row.blocks_project_ids ?? []),
    row.state_changed_at ?? NOW,
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
): Promise<ProjectStallSignalValue> => {
  const out = await projectStallSignalProducer.produce(ctx, sourceFor(project));
  if (out === null) throw new Error(`expected producer output for ${project.id}, got null`);
  return out.value as ProjectStallSignalValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('projectStallSignalProducer surface contract', () => {
  it('targets the project_stall_signal registry topic', () => {
    expect(projectStallSignalProducer.topic).toBe('project_stall_signal');
  });

  it('targets the project source scope (shared with project_next_action_gap)', () => {
    expect(projectStallSignalProducer.source_scope).toBe('project');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(projectStallSignalProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(projectStallSignalProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(projectStallSignalProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for project + task + commitment + note with the load-bearing fields', () => {
    const decls = projectStallSignalProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual([
      'data.project',
      'data.task',
      'data.commitment',
      'data.note',
    ]);
    expect(decls.find((e) => e.collection === 'data.project')!.sample_field_paths).toEqual([
      'id',
      'state',
      'last_activity_at',
    ]);
    expect(decls.find((e) => e.collection === 'data.task')!.sample_field_paths).toEqual([
      'parent_project_id',
      'updated_at',
    ]);
    expect(decls.find((e) => e.collection === 'data.commitment')!.sample_field_paths).toEqual([
      'blocks_project_ids',
      'state_changed_at',
    ]);
    expect(decls.find((e) => e.collection === 'data.note')!.sample_field_paths).toEqual([
      'related_project_ids',
      'last_user_action_at',
    ]);
  });

  it('window constant is 14 days (matches stalled-projects pack semantics + project_next_action_gap)', () => {
    expect(PROJECT_STALL_SIGNAL_WINDOW_MS).toBe(14 * ONE_DAY);
  });

  it('exposes a closed list of stall-signal tokens in canonical order', () => {
    expect(PROJECT_STALL_SIGNAL_TOKENS).toEqual([
      'no_recent_task_activity',
      'no_recent_commitment_activity',
      'no_recent_note_activity',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Producer-kind alignment (declaration + registry both housekeeping)
// ────────────────────────────────────────────────────────────────

describe('producer_kind alignment', () => {
  it('declaration carries producer_kind: "housekeeping"', () => {
    expect(PROJECT_STALL_SIGNAL_DECLARATION.producer_kind).toBe('housekeeping');
  });

  it('registry entry carries producer_kind: "housekeeping" so buildEnrichmentProducerTask accepts it', () => {
    expect(ENRICHMENT_REGISTRY.project_stall_signal.producer_kind).toBe('housekeeping');
  });
});

// ────────────────────────────────────────────────────────────────
// composeStallSignals pure cases
// ────────────────────────────────────────────────────────────────

describe('composeStallSignals', () => {
  it('returns empty when every MAX is fresh (>= cutoff)', () => {
    expect(composeStallSignals(CUTOFF, NOW, NOW, NOW)).toEqual([]);
  });

  it('emits no_recent_task_activity when task MAX is null', () => {
    expect(composeStallSignals(CUTOFF, null, NOW, NOW)).toEqual(['no_recent_task_activity']);
  });

  it('emits no_recent_task_activity when task MAX is older than cutoff', () => {
    expect(composeStallSignals(CUTOFF, CUTOFF - 1, NOW, NOW)).toEqual([
      'no_recent_task_activity',
    ]);
  });

  it('emits no_recent_commitment_activity when commitment MAX is null', () => {
    expect(composeStallSignals(CUTOFF, NOW, null, NOW)).toEqual([
      'no_recent_commitment_activity',
    ]);
  });

  it('emits no_recent_note_activity when note MAX is null', () => {
    expect(composeStallSignals(CUTOFF, NOW, NOW, null)).toEqual(['no_recent_note_activity']);
  });

  it('emits multiple signals in declaration order (task → commitment → note)', () => {
    expect(composeStallSignals(CUTOFF, null, null, NOW)).toEqual([
      'no_recent_task_activity',
      'no_recent_commitment_activity',
    ]);
    expect(composeStallSignals(CUTOFF, NOW, null, null)).toEqual([
      'no_recent_commitment_activity',
      'no_recent_note_activity',
    ]);
  });

  it('emits all three when every source is null (empty project)', () => {
    expect(composeStallSignals(CUTOFF, null, null, null)).toEqual([
      'no_recent_task_activity',
      'no_recent_commitment_activity',
      'no_recent_note_activity',
    ]);
  });

  it('treats a MAX exactly equal to cutoff as fresh (>= cutoff comparison)', () => {
    expect(composeStallSignals(CUTOFF, CUTOFF, CUTOFF, CUTOFF)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// effectiveLastActivity helper
// ────────────────────────────────────────────────────────────────

describe('effectiveLastActivity', () => {
  it('returns null when every input is null', () => {
    expect(effectiveLastActivity(null, null, null, null)).toBeNull();
  });

  it('returns the single non-null when only one source has activity', () => {
    expect(effectiveLastActivity(NOW, null, null, null)).toBe(NOW);
    expect(effectiveLastActivity(null, NOW, null, null)).toBe(NOW);
    expect(effectiveLastActivity(null, null, NOW, null)).toBe(NOW);
    expect(effectiveLastActivity(null, null, null, NOW)).toBe(NOW);
  });

  it('returns the maximum across multiple sources', () => {
    expect(effectiveLastActivity(NOW - 5, NOW - 3, NOW - 7, NOW - 1)).toBe(NOW - 1);
  });

  it('treats the project rollup column as just one candidate (defensive over drift)', () => {
    // Project rollup says "stale" but a child is actually fresh — the
    // helper re-anchors on the fresh child.
    expect(effectiveLastActivity(NOW - 30 * ONE_DAY, NOW, null, null)).toBe(NOW);
  });
});

// ────────────────────────────────────────────────────────────────
// maxTaskActivityForProject SQL helper
// ────────────────────────────────────────────────────────────────

describe('maxTaskActivityForProject', () => {
  it('returns null when no matching task exists', () => {
    expect(maxTaskActivityForProject(stubCtx(), 'proj_a')).toBeNull();
  });

  it('returns the MAX updated_at across tasks for the matching project_id', () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', updated_at: NOW - 5 * ONE_DAY });
    insertTask({ id: 't2', parent_project_id: 'proj_a', updated_at: NOW - 1 * ONE_DAY });
    insertTask({ id: 't3', parent_project_id: 'proj_a', updated_at: NOW - 9 * ONE_DAY });
    expect(maxTaskActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 1 * ONE_DAY);
  });

  it('isolates per project — other projects do not contribute', () => {
    insertTask({ id: 't_a', parent_project_id: 'proj_a', updated_at: NOW - 10 * ONE_DAY });
    insertTask({ id: 't_b', parent_project_id: 'proj_b', updated_at: NOW - 1 * ONE_DAY });
    expect(maxTaskActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 10 * ONE_DAY);
  });

  it('excludes tombstoned tasks', () => {
    insertTask({ id: 't_live', parent_project_id: 'proj_a', updated_at: NOW - 5 * ONE_DAY });
    insertTask({
      id: 't_tomb',
      parent_project_id: 'proj_a',
      updated_at: NOW - 1 * ONE_DAY,
      sync_state: 'tombstoned',
    });
    expect(maxTaskActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 5 * ONE_DAY);
  });

  it('excludes tasks with deleted_at set (pre-tombstone race)', () => {
    insertTask({ id: 't_live', parent_project_id: 'proj_a', updated_at: NOW - 5 * ONE_DAY });
    insertTask({
      id: 't_del',
      parent_project_id: 'proj_a',
      updated_at: NOW - 1 * ONE_DAY,
      deleted_at: NOW,
    });
    expect(maxTaskActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 5 * ONE_DAY);
  });

  it('includes stale_unreachable tasks (matches walker filter)', () => {
    insertTask({
      id: 't_stale',
      parent_project_id: 'proj_a',
      updated_at: NOW - 1 * ONE_DAY,
      sync_state: 'stale_unreachable',
    });
    expect(maxTaskActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 1 * ONE_DAY);
  });

  it('includes done and open tasks alike (broad recency)', () => {
    // The producer's signal is "any task activity" — done-task closure
    // bumps `updated_at`, that's real work signal.
    insertTask({ id: 't_done', parent_project_id: 'proj_a', updated_at: NOW - 1 * ONE_DAY });
    expect(maxTaskActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 1 * ONE_DAY);
  });

  it('returns null for empty project_id (defensive short-circuit)', () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', updated_at: NOW });
    expect(maxTaskActivityForProject(stubCtx(), '')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// maxCommitmentActivityForProject SQL helper
// ────────────────────────────────────────────────────────────────

describe('maxCommitmentActivityForProject', () => {
  it('returns null when no commitment links to the project', () => {
    expect(maxCommitmentActivityForProject(stubCtx(), 'proj_a')).toBeNull();
  });

  it('returns the MAX state_changed_at across commitments via blocks_project_ids', () => {
    insertCommitment({
      id: 'c1',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 5 * ONE_DAY,
    });
    insertCommitment({
      id: 'c2',
      blocks_project_ids: ['proj_a', 'proj_b'],
      state_changed_at: NOW - 1 * ONE_DAY,
    });
    expect(maxCommitmentActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 1 * ONE_DAY);
    expect(maxCommitmentActivityForProject(stubCtx(), 'proj_b')).toBe(NOW - 1 * ONE_DAY);
  });

  it('excludes commitments whose blocks_project_ids does not contain the project id', () => {
    insertCommitment({
      id: 'c_unrelated',
      blocks_project_ids: ['proj_x'],
      state_changed_at: NOW,
    });
    expect(maxCommitmentActivityForProject(stubCtx(), 'proj_a')).toBeNull();
  });

  it('excludes commitments with empty blocks_project_ids', () => {
    insertCommitment({ id: 'c_empty', blocks_project_ids: [], state_changed_at: NOW });
    expect(maxCommitmentActivityForProject(stubCtx(), 'proj_a')).toBeNull();
  });

  it('excludes tombstoned commitments', () => {
    insertCommitment({
      id: 'c_live',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 5 * ONE_DAY,
    });
    insertCommitment({
      id: 'c_tomb',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 1 * ONE_DAY,
      sync_state: 'tombstoned',
    });
    expect(maxCommitmentActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 5 * ONE_DAY);
  });

  it('excludes commitments with deleted_at set (pre-tombstone race)', () => {
    insertCommitment({
      id: 'c_live',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 5 * ONE_DAY,
    });
    insertCommitment({
      id: 'c_del',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 1 * ONE_DAY,
      deleted_at: NOW,
    });
    expect(maxCommitmentActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 5 * ONE_DAY);
  });

  it('includes all lifecycle states (fulfilled / cancelled / expired all real signal)', () => {
    // state_changed_at bumps on any lifecycle transition. The producer
    // wants the broad recency lens — fulfillment is real work signal,
    // not just pending churn.
    insertCommitment({
      id: 'c_fulfilled',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 1 * ONE_DAY,
    });
    expect(maxCommitmentActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 1 * ONE_DAY);
  });

  it('returns null for empty project_id (defensive short-circuit)', () => {
    insertCommitment({ id: 'c1', blocks_project_ids: ['proj_a'], state_changed_at: NOW });
    expect(maxCommitmentActivityForProject(stubCtx(), '')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// maxNoteActivityForProject SQL helper
// ────────────────────────────────────────────────────────────────

describe('maxNoteActivityForProject', () => {
  it('returns null when no note links to the project', () => {
    expect(maxNoteActivityForProject(stubCtx(), 'proj_a')).toBeNull();
  });

  it('returns the MAX last_user_action_at across notes via related_project_ids', () => {
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 5 * ONE_DAY,
    });
    insertNote({
      id: 'n2',
      related_project_ids: ['proj_a', 'proj_b'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    expect(maxNoteActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 1 * ONE_DAY);
    expect(maxNoteActivityForProject(stubCtx(), 'proj_b')).toBe(NOW - 1 * ONE_DAY);
  });

  it('excludes notes with empty related_project_ids', () => {
    insertNote({ id: 'n_orphan', related_project_ids: [], last_user_action_at: NOW });
    expect(maxNoteActivityForProject(stubCtx(), 'proj_a')).toBeNull();
  });

  it('excludes tombstoned notes', () => {
    insertNote({
      id: 'n_live',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 5 * ONE_DAY,
    });
    insertNote({
      id: 'n_tomb',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
      sync_state: 'tombstoned',
    });
    expect(maxNoteActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 5 * ONE_DAY);
  });

  it('excludes notes with deleted_at set (pre-tombstone race)', () => {
    insertNote({
      id: 'n_live',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 5 * ONE_DAY,
    });
    insertNote({
      id: 'n_del',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
      deleted_at: NOW,
    });
    expect(maxNoteActivityForProject(stubCtx(), 'proj_a')).toBe(NOW - 5 * ONE_DAY);
  });

  it('returns null for empty project_id (defensive short-circuit)', () => {
    insertNote({ id: 'n1', related_project_ids: ['proj_a'], last_user_action_at: NOW });
    expect(maxNoteActivityForProject(stubCtx(), '')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('projectStallSignalProducer.produce()', () => {
  it('returns null for projects with empty id (defensive)', async () => {
    const out = await projectStallSignalProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: '' })),
    );
    expect(out).toBeNull();
  });

  it('returns null for paused projects (engine drives stall reasoning only on active)', async () => {
    const out = await projectStallSignalProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'paused' })),
    );
    expect(out).toBeNull();
  });

  it('returns null for completed projects', async () => {
    const out = await projectStallSignalProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'completed' })),
    );
    expect(out).toBeNull();
  });

  it('returns null for archived projects', async () => {
    const out = await projectStallSignalProducer.produce(
      stubCtx(),
      sourceFor(fakeProject({ id: 'proj_a', state: 'archived' })),
    );
    expect(out).toBeNull();
  });

  it('emits stalled: false + all signals for a freshly-created empty project', async () => {
    // Project just created today — last_activity_at is fresh. No
    // children exist yet. Stalled is false (recent), but per-source
    // signals enumerate the missing kinds.
    const value = await expectValue(stubCtx(), fakeProject({ id: 'proj_a', last_activity_at: NOW }));
    expect(value.stalled).toBe(false);
    expect(value.signals).toEqual([
      'no_recent_task_activity',
      'no_recent_commitment_activity',
      'no_recent_note_activity',
    ]);
    expect(value.last_activity_at).toBe(NOW);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits stalled: true + all signals for an old empty project', async () => {
    const value = await expectValue(
      stubCtx(),
      fakeProject({ id: 'proj_a', last_activity_at: NOW - 60 * ONE_DAY }),
    );
    expect(value.stalled).toBe(true);
    expect(value.signals).toEqual([
      'no_recent_task_activity',
      'no_recent_commitment_activity',
      'no_recent_note_activity',
    ]);
    expect(value.last_activity_at).toBe(NOW - 60 * ONE_DAY);
  });

  it('emits stalled: false + empty signals when every source has recent activity', async () => {
    insertTask({ id: 't1', parent_project_id: 'proj_a', updated_at: NOW - 1 * ONE_DAY });
    insertCommitment({
      id: 'c1',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 2 * ONE_DAY,
    });
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 3 * ONE_DAY,
    });
    const value = await expectValue(
      stubCtx(),
      fakeProject({ id: 'proj_a', last_activity_at: NOW - 1 * ONE_DAY }),
    );
    expect(value.stalled).toBe(false);
    expect(value.signals).toEqual([]);
    expect(value.last_activity_at).toBe(NOW - 1 * ONE_DAY);
  });

  it('emits no_recent_task_activity when only tasks are missing/stale', async () => {
    insertCommitment({
      id: 'c1',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 1 * ONE_DAY,
    });
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const value = await expectValue(
      stubCtx(),
      fakeProject({ id: 'proj_a', last_activity_at: NOW - 1 * ONE_DAY }),
    );
    expect(value.signals).toEqual(['no_recent_task_activity']);
    expect(value.stalled).toBe(false);
  });

  it('treats a stale task (older than 14d) as "no recent task activity"', async () => {
    insertTask({ id: 't_old', parent_project_id: 'proj_a', updated_at: NOW - 30 * ONE_DAY });
    insertCommitment({
      id: 'c1',
      blocks_project_ids: ['proj_a'],
      state_changed_at: NOW - 1 * ONE_DAY,
    });
    insertNote({
      id: 'n1',
      related_project_ids: ['proj_a'],
      last_user_action_at: NOW - 1 * ONE_DAY,
    });
    const value = await expectValue(
      stubCtx(),
      fakeProject({ id: 'proj_a', last_activity_at: NOW - 1 * ONE_DAY }),
    );
    expect(value.signals).toEqual(['no_recent_task_activity']);
  });

  it('re-anchors stalled on child timestamps when project rollup column has drifted', async () => {
    // Defense-in-depth: project's `last_activity_at` says 60d ago
    // (rollup drift / migration backfill / pre-tombstone race), but a
    // task was actually updated yesterday. Effective last activity is
    // the fresh task, so stalled flips to false.
    insertTask({ id: 't_fresh', parent_project_id: 'proj_a', updated_at: NOW - 1 * ONE_DAY });
    const value = await expectValue(
      stubCtx(),
      fakeProject({ id: 'proj_a', last_activity_at: NOW - 60 * ONE_DAY }),
    );
    expect(value.stalled).toBe(false);
    expect(value.last_activity_at).toBe(NOW - 1 * ONE_DAY);
    // Commitment + note still absent → per-source signals enumerate.
    expect(value.signals).toEqual([
      'no_recent_commitment_activity',
      'no_recent_note_activity',
    ]);
  });

  it('isolates child timestamps per project — other projects do not bleed into effective last activity', async () => {
    insertTask({ id: 't_a', parent_project_id: 'proj_a', updated_at: NOW - 30 * ONE_DAY });
    insertTask({ id: 't_b', parent_project_id: 'proj_b', updated_at: NOW - 1 * ONE_DAY });
    const valueA = await expectValue(
      stubCtx(),
      fakeProject({ id: 'proj_a', last_activity_at: NOW - 30 * ONE_DAY }),
    );
    expect(valueA.stalled).toBe(true);
    expect(valueA.last_activity_at).toBe(NOW - 30 * ONE_DAY);
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

describe('ENRICHMENT_REGISTRY.project_stall_signal.value_schema', () => {
  it('accepts a producer-shaped value', () => {
    const def = ENRICHMENT_REGISTRY.project_stall_signal;
    const result = def.value_schema({
      stalled: true,
      signals: ['no_recent_task_activity'],
      last_activity_at: NOW - 60 * ONE_DAY,
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts stalled: false with empty signals + null last_activity_at (empty project)', () => {
    const def = ENRICHMENT_REGISTRY.project_stall_signal;
    const result = def.value_schema({
      stalled: false,
      signals: [],
      last_activity_at: null,
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects values missing computed_at', () => {
    const def = ENRICHMENT_REGISTRY.project_stall_signal;
    const result = def.value_schema({
      stalled: true,
      signals: ['no_recent_task_activity'],
      last_activity_at: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry shape alignment
// ────────────────────────────────────────────────────────────────

describe('ENRICHMENT_REGISTRY.project_stall_signal shape', () => {
  it('declares shape: per_record + scope: project', () => {
    const def = ENRICHMENT_REGISTRY.project_stall_signal;
    expect(def.shape).toBe('per_record');
    if (def.shape === 'per_record') {
      expect(def.valid_scopes).toEqual(['project']);
    }
  });

  it('declares aggregates_from across the four child scopes', () => {
    const def = ENRICHMENT_REGISTRY.project_stall_signal;
    expect(def.aggregates_from).toEqual(['project', 'task', 'note', 'commitment']);
  });

  it('declares 24h recompute cadence', () => {
    const def = ENRICHMENT_REGISTRY.project_stall_signal;
    expect(def.recompute_cadence).toBe('24h');
  });

  it('declares temporal_class: stable_truth + identity_aggregation: scenario (snapshot semantics)', () => {
    const def = ENRICHMENT_REGISTRY.project_stall_signal;
    expect(def.temporal_class).toBe('stable_truth');
    expect(def.identity_aggregation).toBe('scenario');
  });

  it('declares lifecycle_policy: recompute_on_drift (re-derives on child cascade)', () => {
    const def = ENRICHMENT_REGISTRY.project_stall_signal;
    expect(def.lifecycle_policy).toBe('recompute_on_drift');
  });
});

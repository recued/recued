/** D-145 PA9 — `task_duplicate_candidate` producer tests.
 *
 *  Fifth D-145 PA9 producer impl + second per-record producer on a
 *  work-entity scope (`walker_kind: 'task'`, following note-walker
 *  pattern). Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration)
 *    - normalizeTaskTitle pure cases (lowercase / trim / whitespace
 *      collapse / unicode pass-through)
 *    - computeDedupConfidence pure cases (band-cascade — exact wins
 *      over probable; one-side-null due_at / assignee handling;
 *      empty-title abstention; low-band same-project + prefix gate)
 *    - selectStrongestBand pure cases (mixed-band consolidation;
 *      empty input)
 *    - matchTaskAgainstCrossSourceCandidates (cross-source narrowing
 *      via store fake; no-source abstention; assignee-narrow vs
 *      unassigned scan; LIMIT respected)
 *    - produce() integration: abstention on empty id / missing store
 *      / no candidates; emission with correct band + set
 *    - Registry value_schema acceptance round-trip
 *    - Registry shape + cadence + scope alignment */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type Task,
  type TaskDedupeConfidence,
  type TaskDuplicateCandidateValue,
} from '@recued/contracts';

import {
  TASK_DUPLICATE_CANDIDATE_LIMIT,
  TASK_DUPLICATE_EXACT_DUE_WINDOW_MS,
  TASK_DUPLICATE_LOW_PREFIX_LEN,
  TASK_DUPLICATE_PROBABLE_DUE_WINDOW_MS,
  computeDedupConfidence,
  matchTaskAgainstCrossSourceCandidates,
  normalizeTaskTitle,
  selectStrongestBand,
  taskDuplicateCandidateProducer,
  type TaskDedupeFields,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

const fakeTask = (overrides: Partial<Task> & { id: string }): Task => ({
  id: overrides.id,
  title: overrides.title ?? `Task ${overrides.id}`,
  done: overrides.done ?? false,
  created_at: overrides.created_at ?? NOW - ONE_DAY,
  updated_at: overrides.updated_at ?? NOW - ONE_DAY,
  blocks_task_ids: overrides.blocks_task_ids ?? [],
  source_id: overrides.source_id ?? 'src_recued',
  source_record_id: overrides.source_record_id ?? overrides.id,
  source_updated_at: overrides.source_updated_at ?? NOW - ONE_DAY,
  last_seen_at: overrides.last_seen_at ?? NOW - ONE_DAY,
  sync_state: overrides.sync_state ?? 'live',
  conflict_policy: overrides.conflict_policy ?? 'source_wins',
  source_record_hash: overrides.source_record_hash ?? 'h_task',
  ...(overrides.body !== undefined ? { body: overrides.body } : {}),
  ...(overrides.due_at !== undefined ? { due_at: overrides.due_at } : {}),
  ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
  ...(overrides.completed_at !== undefined ? { completed_at: overrides.completed_at } : {}),
  ...(overrides.assigned_contact_id !== undefined
    ? { assigned_contact_id: overrides.assigned_contact_id }
    : {}),
  ...(overrides.parent_calendar_event_id !== undefined
    ? { parent_calendar_event_id: overrides.parent_calendar_event_id }
    : {}),
  ...(overrides.linked_mail_thread_id !== undefined
    ? { linked_mail_thread_id: overrides.linked_mail_thread_id }
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

interface FakeStoreCall {
  exclude_source_id: string;
  exclude_task_id: string;
  assigned_contact_id: string | null;
  limit: number;
}

interface FakeStore extends Pick<WorkEntityStore, 'findCrossSourceTaskCandidates'> {
  calls: FakeStoreCall[];
  setCandidates: (rows: Task[]) => void;
}

const buildFakeStore = (initial: Task[] = []): FakeStore => {
  let cannedRows: Task[] = initial;
  const calls: FakeStoreCall[] = [];
  return {
    calls,
    setCandidates(rows) {
      cannedRows = rows;
    },
    findCrossSourceTaskCandidates(opts) {
      calls.push({
        exclude_source_id: opts.exclude_source_id,
        exclude_task_id: opts.exclude_task_id,
        assigned_contact_id: opts.assigned_contact_id,
        limit: opts.limit,
      });
      return cannedRows.slice(0, opts.limit);
    },
  };
};

/** D-205 #3.5 — the producer now reads the CONTACT MERGE GRAPH off `ctx.db`, to
 *  resolve the focal assignee's whole address set (two addresses can be the same
 *  person once their contacts are merged). `db: {} as never` used to be
 *  survivable only because nothing on this path had ever touched the handle; it
 *  is a real `better-sqlite3` database now.
 *
 *  Deliberately left WITHOUT a `contacts` table: these cases exercise the
 *  un-merged world, where a contact's address set is exactly `[its address]` and
 *  banding falls back to strict address equality. The merge-group banding is
 *  pinned separately in `d-205-contact-merge-group-reverse-reads.test.ts`. */
const stubCtx = (
  now: number = NOW,
  store?: Pick<WorkEntityStore, 'findCrossSourceTaskCandidates'>,
): HousekeepingContext => ({
  db: new Database(':memory:') as never,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
  // The producer only reads `findCrossSourceTaskCandidates` off the
  // store — cast through `WorkEntityStore` for the typed-context shape.
  // Production wires the full store via `wire-housekeeping-substrate.ts`.
  ...(store !== undefined ? { workEntityStore: store as WorkEntityStore } : {}),
});

const sourceFor = (task: Task): SourceRecord<Task> => ({
  target_id: task.id,
  data: task,
  cursor_token: task.id,
});

const expectValue = async (
  ctx: HousekeepingContext,
  task: Task,
): Promise<TaskDuplicateCandidateValue> => {
  const out = await taskDuplicateCandidateProducer.produce(ctx, sourceFor(task));
  if (out === null) throw new Error(`expected producer output for ${task.id}, got null`);
  return out.value as TaskDuplicateCandidateValue;
};

const dedupe = (overrides: Partial<TaskDedupeFields> = {}): TaskDedupeFields => ({
  title: overrides.title ?? 'Send Q3 report',
  due_at: overrides.due_at ?? null,
  assigned_contact_id: overrides.assigned_contact_id ?? null,
  parent_project_id: overrides.parent_project_id ?? null,
});

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('taskDuplicateCandidateProducer surface contract', () => {
  it('targets the task_duplicate_candidate registry topic', () => {
    expect(taskDuplicateCandidateProducer.topic).toBe('task_duplicate_candidate');
  });

  it('targets the task source scope (novel walker_kind: "task" — second work-entity scope)', () => {
    expect(taskDuplicateCandidateProducer.source_scope).toBe('task');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(taskDuplicateCandidateProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(taskDuplicateCandidateProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(taskDuplicateCandidateProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for data.task with the load-bearing fields', () => {
    const decls = taskDuplicateCandidateProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual(['data.task']);
    const taskEntry = decls.find((e) => e.collection === 'data.task')!;
    expect(taskEntry.sample_field_paths).toEqual([
      'title',
      'due_at',
      'assigned_contact_id',
      'parent_project_id',
      'source_id',
    ]);
  });

  it('exposes constants for the per-task candidate cap + match windows', () => {
    expect(TASK_DUPLICATE_CANDIDATE_LIMIT).toBe(100);
    expect(TASK_DUPLICATE_EXACT_DUE_WINDOW_MS).toBe(ONE_DAY);
    expect(TASK_DUPLICATE_PROBABLE_DUE_WINDOW_MS).toBe(7 * ONE_DAY);
    expect(TASK_DUPLICATE_LOW_PREFIX_LEN).toBe(8);
  });
});

// ────────────────────────────────────────────────────────────────
// normalizeTaskTitle pure cases
// ────────────────────────────────────────────────────────────────

describe('normalizeTaskTitle', () => {
  it('lowercases', () => {
    expect(normalizeTaskTitle('Send Q3 Report')).toBe('send q3 report');
  });

  it('trims leading + trailing whitespace', () => {
    expect(normalizeTaskTitle('   foo bar   ')).toBe('foo bar');
  });

  it('collapses internal whitespace runs', () => {
    expect(normalizeTaskTitle('foo   bar\t\nbaz')).toBe('foo bar baz');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeTaskTitle('   ')).toBe('');
    expect(normalizeTaskTitle('')).toBe('');
  });

  it('preserves non-ASCII characters (unicode pass-through)', () => {
    expect(normalizeTaskTitle('Café résumé')).toBe('café résumé');
  });
});

// ────────────────────────────────────────────────────────────────
// computeDedupConfidence pure cases
// ────────────────────────────────────────────────────────────────

describe('computeDedupConfidence — exact band', () => {
  it('returns exact when titles match + due_at within 24h + same assignee', () => {
    const focal = dedupe({
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const cand = dedupe({
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY + 3 * 3600_000, // +3h
      assigned_contact_id: 'alice@example.com',
    });
    expect(computeDedupConfidence(focal, cand)).toBe('exact');
  });

  it('treats case + whitespace differences as exact match', () => {
    const focal = dedupe({ title: 'SEND  Q3  REPORT', due_at: NOW + 7 * ONE_DAY });
    const cand = dedupe({ title: 'send q3 report', due_at: NOW + 7 * ONE_DAY });
    expect(computeDedupConfidence(focal, cand)).toBe('exact');
  });

  it('returns exact when both sides have null due_at + null assignee', () => {
    const focal = dedupe({ title: 'Untitled' });
    const cand = dedupe({ title: 'untitled' });
    expect(computeDedupConfidence(focal, cand)).toBe('exact');
  });

  it('demotes to probable when due_at delta exceeds 24h but stays inside 7d', () => {
    const focal = dedupe({
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const cand = dedupe({
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY + 3 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    expect(computeDedupConfidence(focal, cand)).toBe('probable');
  });

  it('demotes to probable when assignees mismatch even on identical titles + due', () => {
    const focal = dedupe({
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const cand = dedupe({
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'bob@example.com',
    });
    expect(computeDedupConfidence(focal, cand)).toBe('probable');
  });

  it('demotes to probable when one side has null due_at and the other does not', () => {
    const focal = dedupe({ title: 'Send Q3 report', due_at: NOW + 7 * ONE_DAY });
    const cand = dedupe({ title: 'Send Q3 report' });
    expect(computeDedupConfidence(focal, cand)).toBe('probable');
  });
});

describe('computeDedupConfidence — probable band', () => {
  it('returns probable when one title contains the other + close due_at', () => {
    const focal = dedupe({ title: 'Send report', due_at: NOW });
    const cand = dedupe({ title: 'Send report to the client', due_at: NOW + 2 * ONE_DAY });
    expect(computeDedupConfidence(focal, cand)).toBe('probable');
  });

  it('returns probable for the reverse containment direction', () => {
    const focal = dedupe({ title: '[URGENT] Q3 review', due_at: NOW });
    const cand = dedupe({ title: 'Q3 review', due_at: NOW + 2 * ONE_DAY });
    expect(computeDedupConfidence(focal, cand)).toBe('probable');
  });

  it('does not return probable when due_at delta exceeds 7d', () => {
    const focal = dedupe({ title: 'Send report', due_at: NOW });
    const cand = dedupe({ title: 'Send report to client', due_at: NOW + 8 * ONE_DAY });
    expect(computeDedupConfidence(focal, cand)).toBeNull();
  });

  it('returns probable even when assignees differ (assignee only gates exact)', () => {
    const focal = dedupe({
      title: 'Send report',
      due_at: NOW,
      assigned_contact_id: 'alice@example.com',
    });
    const cand = dedupe({
      title: 'Send report to the client',
      due_at: NOW + 2 * ONE_DAY,
      assigned_contact_id: 'bob@example.com',
    });
    expect(computeDedupConfidence(focal, cand)).toBe('probable');
  });
});

describe('computeDedupConfidence — low band', () => {
  it('returns low when same project + 8-char prefix match (no overlap, no exact)', () => {
    const focal = dedupe({
      title: 'Q3 plan review for engineering',
      parent_project_id: 'proj_eng',
      due_at: NOW,
    });
    const cand = dedupe({
      title: 'Q3 plan summary for product',
      parent_project_id: 'proj_eng',
      due_at: NOW + 20 * ONE_DAY,
    });
    expect(computeDedupConfidence(focal, cand)).toBe('low');
  });

  it('does NOT return low when parent_project_id mismatches (project anchor required)', () => {
    const focal = dedupe({
      title: 'Q3 plan review',
      parent_project_id: 'proj_eng',
    });
    const cand = dedupe({
      title: 'Q3 plan summary',
      parent_project_id: 'proj_marketing',
    });
    expect(computeDedupConfidence(focal, cand)).toBeNull();
  });

  it('does NOT return low when both sides have null parent_project_id', () => {
    const focal = dedupe({ title: 'Q3 plan review for engineering' });
    const cand = dedupe({ title: 'Q3 plan summary for product' });
    expect(computeDedupConfidence(focal, cand)).toBeNull();
  });

  it('does NOT return low when normalized prefix differs in the first 8 chars', () => {
    const focal = dedupe({ title: 'Send Q3 report', parent_project_id: 'p1' });
    const cand = dedupe({ title: 'Send Q4 report', parent_project_id: 'p1' });
    // Both pass 8-char prefix? 'send q3 ' vs 'send q4 ' → differ at index 6.
    expect(computeDedupConfidence(focal, cand)).toBeNull();
  });

  it('does NOT return low for titles shorter than 8 chars', () => {
    const focal = dedupe({ title: 'Q3', parent_project_id: 'p1' });
    const cand = dedupe({ title: 'Q3', parent_project_id: 'p1' });
    // Short titles can't shoot through the prefix gate even when identical;
    // they'd already hit the exact path when both null-due-null-assignee.
    // Use mismatched dues to force the band cascade past exact + probable.
    expect(computeDedupConfidence(
      { ...focal, due_at: NOW },
      { ...cand, due_at: NOW + 30 * ONE_DAY },
    )).toBeNull();
  });
});

describe('computeDedupConfidence — abstention', () => {
  it('returns null for empty focal title', () => {
    expect(computeDedupConfidence(dedupe({ title: '' }), dedupe({ title: 'Foo' }))).toBeNull();
  });

  it('returns null for empty candidate title', () => {
    expect(computeDedupConfidence(dedupe({ title: 'Foo' }), dedupe({ title: '' }))).toBeNull();
  });

  it('returns null for whitespace-only titles', () => {
    expect(computeDedupConfidence(dedupe({ title: '   ' }), dedupe({ title: 'Foo' }))).toBeNull();
  });

  it('returns null when no band predicates are satisfied', () => {
    const focal = dedupe({ title: 'Send Q3 report', due_at: NOW });
    const cand = dedupe({ title: 'Quarterly tax filing', due_at: NOW + 30 * ONE_DAY });
    expect(computeDedupConfidence(focal, cand)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// selectStrongestBand pure cases
// ────────────────────────────────────────────────────────────────

describe('selectStrongestBand', () => {
  it('returns null for empty input', () => {
    expect(selectStrongestBand([])).toBeNull();
  });

  it('picks the strongest band when multiple are present + restricts the set to that band', () => {
    const result = selectStrongestBand([
      { id: 't_low_1', band: 'low' },
      { id: 't_probable_1', band: 'probable' },
      { id: 't_exact_1', band: 'exact' },
      { id: 't_low_2', band: 'low' },
      { id: 't_exact_2', band: 'exact' },
    ]);
    expect(result).toEqual({
      duplicate_candidate_set: ['t_exact_1', 't_exact_2'],
      dedupe_confidence: 'exact',
    });
  });

  it('preserves input order within the chosen band', () => {
    const result = selectStrongestBand([
      { id: 't_zzz', band: 'probable' },
      { id: 't_aaa', band: 'probable' },
      { id: 't_mmm', band: 'probable' },
    ]);
    expect(result?.duplicate_candidate_set).toEqual(['t_zzz', 't_aaa', 't_mmm']);
    expect(result?.dedupe_confidence).toBe('probable');
  });

  it('returns low band when only low matches', () => {
    const result = selectStrongestBand([
      { id: 't_a', band: 'low' },
      { id: 't_b', band: 'low' },
    ]);
    expect(result).toEqual({
      duplicate_candidate_set: ['t_a', 't_b'],
      dedupe_confidence: 'low',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// matchTaskAgainstCrossSourceCandidates
// ────────────────────────────────────────────────────────────────

describe('matchTaskAgainstCrossSourceCandidates', () => {
  it('returns null when focal task has no source_id', () => {
    const store = buildFakeStore();
    const focal = fakeTask({ id: 't_focal', source_id: '' });
    expect(matchTaskAgainstCrossSourceCandidates(store, focal)).toBeNull();
    expect(store.calls).toHaveLength(0);
  });

  it('queries the store with the focal task source_id excluded + assignee narrow', () => {
    const store = buildFakeStore();
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      assigned_contact_id: 'alice@example.com',
    });
    matchTaskAgainstCrossSourceCandidates(store, focal);
    expect(store.calls).toEqual([
      {
        exclude_source_id: 'src_hubspot',
        exclude_task_id: 't_focal',
        assigned_contact_id: 'alice@example.com',
        limit: TASK_DUPLICATE_CANDIDATE_LIMIT,
      },
    ]);
  });

  it('queries unassigned scan when focal task has no assignee', () => {
    const store = buildFakeStore();
    const focal = fakeTask({ id: 't_focal', source_id: 'src_recued' });
    matchTaskAgainstCrossSourceCandidates(store, focal);
    expect(store.calls[0]?.assigned_contact_id).toBeNull();
  });

  it('returns null when the store returns no candidates', () => {
    const store = buildFakeStore([]);
    const focal = fakeTask({ id: 't_focal', source_id: 'src_recued' });
    expect(matchTaskAgainstCrossSourceCandidates(store, focal)).toBeNull();
  });

  it('returns the strongest band + the matching ids when candidates land in mixed bands', () => {
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
      parent_project_id: 'proj_eng',
    });
    const exactMatch = fakeTask({
      id: 't_sf_exact',
      source_id: 'src_salesforce',
      title: 'send q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const probableMatch = fakeTask({
      id: 't_recued_probable',
      source_id: 'src_recued',
      title: 'Send Q3 report to client',
      due_at: NOW + 9 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const lowMatch = fakeTask({
      id: 't_recued_low',
      source_id: 'src_recued',
      title: 'Send Q4 followup mail',
      due_at: NOW + 60 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
      parent_project_id: 'proj_eng',
    });
    const unrelated = fakeTask({
      id: 't_recued_other',
      source_id: 'src_recued',
      title: 'Quarterly tax filing',
      due_at: NOW + 30 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const store = buildFakeStore([exactMatch, probableMatch, lowMatch, unrelated]);
    const result = matchTaskAgainstCrossSourceCandidates(store, focal);
    expect(result).toEqual({
      duplicate_candidate_set: ['t_sf_exact'],
      dedupe_confidence: 'exact',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// produce() — integration through stubCtx + fake store
// ────────────────────────────────────────────────────────────────

describe('taskDuplicateCandidateProducer.produce', () => {
  it('returns null when source_record.id is empty', async () => {
    const store = buildFakeStore();
    const out = await taskDuplicateCandidateProducer.produce(
      stubCtx(NOW, store),
      sourceFor(fakeTask({ id: '' })),
    );
    expect(out).toBeNull();
  });

  it('returns null when no workEntityStore is wired on ctx (harness fallback)', async () => {
    const out = await taskDuplicateCandidateProducer.produce(
      stubCtx(),
      sourceFor(fakeTask({ id: 't_focal', source_id: 'src_recued' })),
    );
    expect(out).toBeNull();
  });

  it('returns null when no cross-source candidates exist', async () => {
    const store = buildFakeStore([]);
    const out = await taskDuplicateCandidateProducer.produce(
      stubCtx(NOW, store),
      sourceFor(fakeTask({ id: 't_focal', source_id: 'src_recued' })),
    );
    expect(out).toBeNull();
  });

  it('emits the strongest-band set when candidates straddle bands', async () => {
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const exactA = fakeTask({
      id: 't_exact_a',
      source_id: 'src_salesforce',
      title: 'Send Q3 Report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const exactB = fakeTask({
      id: 't_exact_b',
      source_id: 'src_recued',
      title: 'send q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const probable = fakeTask({
      id: 't_probable_a',
      source_id: 'src_asana',
      title: 'Send Q3 report draft',
      due_at: NOW + 8 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const store = buildFakeStore([exactA, exactB, probable]);
    const value = await expectValue(stubCtx(NOW, store), focal);
    expect(value.dedupe_confidence).toBe('exact');
    expect(value.duplicate_candidate_set).toEqual(['t_exact_a', 't_exact_b']);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits probable when no exact matches exist', async () => {
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      title: 'Send report',
      due_at: NOW,
    });
    const probable = fakeTask({
      id: 't_recued',
      source_id: 'src_recued',
      title: 'Send report to client',
      due_at: NOW + 2 * ONE_DAY,
    });
    const store = buildFakeStore([probable]);
    const value = await expectValue(stubCtx(NOW, store), focal);
    expect(value.dedupe_confidence).toBe('probable');
    expect(value.duplicate_candidate_set).toEqual(['t_recued']);
  });

  it('emits low when only same-project prefix matches survive', async () => {
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      title: 'Q3 plan review for engineering',
      parent_project_id: 'proj_eng',
      due_at: NOW,
    });
    const low = fakeTask({
      id: 't_recued',
      source_id: 'src_recued',
      title: 'Q3 plan summary for product',
      parent_project_id: 'proj_eng',
      due_at: NOW + 30 * ONE_DAY,
    });
    const store = buildFakeStore([low]);
    const value = await expectValue(stubCtx(NOW, store), focal);
    expect(value.dedupe_confidence).toBe('low');
    expect(value.duplicate_candidate_set).toEqual(['t_recued']);
  });

  it('uses ctx.now() for computed_at so the harness clock determines staleness', async () => {
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const exact = fakeTask({
      id: 't_sf',
      source_id: 'src_salesforce',
      title: 'send q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const store = buildFakeStore([exact]);
    const later = NOW + 6 * 3600_000;
    const value = await expectValue(stubCtx(later, store), focal);
    expect(value.computed_at).toBe(later);
  });

  it('passes the candidate limit through to the store query', async () => {
    const store = buildFakeStore();
    const focal = fakeTask({ id: 't_focal', source_id: 'src_recued' });
    await taskDuplicateCandidateProducer.produce(stubCtx(NOW, store), sourceFor(focal));
    expect(store.calls[0]?.limit).toBe(TASK_DUPLICATE_CANDIDATE_LIMIT);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry round-trip
// ────────────────────────────────────────────────────────────────

describe('task_duplicate_candidate registry round-trip', () => {
  it('registry topic exists with per_record shape + task scope + housekeeping producer_kind', () => {
    const def = ENRICHMENT_REGISTRY.task_duplicate_candidate;
    expect(def).toBeDefined();
    expect(def.shape).toBe('per_record');
    expect(def.valid_scopes).toEqual(['task']);
    expect(def.producer_kind).toBe('housekeeping');
    expect(def.recompute_cadence).toBe('24h');
  });

  it('registry aggregates_from includes task so cascade fires on data.task row updates', () => {
    const def = ENRICHMENT_REGISTRY.task_duplicate_candidate;
    expect(def.aggregates_from).toEqual(['task']);
  });

  it('value_schema accepts a producer-emitted exact-band payload', async () => {
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const exact = fakeTask({
      id: 't_sf',
      source_id: 'src_salesforce',
      title: 'send q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const store = buildFakeStore([exact]);
    const value = await expectValue(stubCtx(NOW, store), focal);
    const def = ENRICHMENT_REGISTRY.task_duplicate_candidate as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    expect(def.value_schema(value).ok).toBe(true);
  });

  it('value_schema accepts a producer-emitted low-band payload', async () => {
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      title: 'Q3 plan review for engineering',
      parent_project_id: 'proj_eng',
    });
    const low = fakeTask({
      id: 't_recued',
      source_id: 'src_recued',
      title: 'Q3 plan summary for product',
      parent_project_id: 'proj_eng',
    });
    const store = buildFakeStore([low]);
    const value = await expectValue(stubCtx(NOW, store), focal);
    expect(value.dedupe_confidence).toBe('low');
    const def = ENRICHMENT_REGISTRY.task_duplicate_candidate as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    expect(def.value_schema(value).ok).toBe(true);
  });

  it('emitted dedupe_confidence is one of the closed-list bands', async () => {
    const focal = fakeTask({
      id: 't_focal',
      source_id: 'src_hubspot',
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const exact = fakeTask({
      id: 't_sf',
      source_id: 'src_salesforce',
      title: 'Send Q3 report',
      due_at: NOW + 7 * ONE_DAY,
      assigned_contact_id: 'alice@example.com',
    });
    const store = buildFakeStore([exact]);
    const value = await expectValue(stubCtx(NOW, store), focal);
    const validBands: TaskDedupeConfidence[] = ['exact', 'probable', 'low'];
    expect(validBands).toContain(value.dedupe_confidence);
  });
});

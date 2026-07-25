/** D-145 PA6 — list-view filter + sort.
 *
 *  Pin per § Phase PA6 (list/search view per Source):
 *    - filterEntitiesBySearch: case-insensitive substring on per-kind
 *      matchable fields; empty/whitespace query passes through.
 *    - sortEntitiesByDefault: per-kind canonical sort.
 *    - filterAndSortEntities: composition.
 */

import { describe, expect, it } from 'vitest';

import {
  filterAndSortEntities,
  filterEntitiesBySearch,
  sortEntitiesByDefault,
  type WorkEntity,
} from '../index.js';

const NOW = 1_700_000_000_000;

const task = (over: Partial<WorkEntity & { _kind: 'task' }>): WorkEntity =>
  ({
    _kind: 'task',
    id: over.id ?? 'task-1',
    title: 'Task title',
    body: undefined,
    done: false,
    due_at: undefined,
    priority: undefined,
    created_at: NOW,
    updated_at: NOW,
    completed_at: undefined,
    assigned_contact_id: undefined,
    parent_calendar_event_id: undefined,
    linked_mail_thread_id: undefined,
    parent_project_id: undefined,
    blocks_task_ids: [],
    source_id: 'recued.task',
    last_seen_at: NOW,
    sync_state: 'live',
    conflict_policy: 'manual_merge',
    ...over,
  } as WorkEntity);

const note = (over: Partial<WorkEntity & { _kind: 'note' }>): WorkEntity =>
  ({
    _kind: 'note',
    id: over.id ?? 'note-1',
    title: 'Note title',
    body: 'note body content',
    created_at: NOW,
    updated_at: NOW,
    last_user_action_at: NOW,
    related_contact_ids: [],
    related_calendar_event_ids: [],
    related_mail_thread_ids: [],
    related_project_ids: [],
    source_id: 'recued.note',
    last_seen_at: NOW,
    sync_state: 'live',
    conflict_policy: 'manual_merge',
    ...over,
  } as WorkEntity);

const commitment = (
  over: Partial<WorkEntity & { _kind: 'commitment' }>,
): WorkEntity =>
  ({
    _kind: 'commitment',
    id: over.id ?? 'commit-1',
    direction: 'outbound',
    statement: 'Bob owes me $500',
    promised_at: NOW,
    promised_for_at: undefined,
    lifecycle_state: 'pending',
    due_status: 'no_deadline',
    expiry_policy: 'escalate_overdue',
    created_at: NOW,
    updated_at: NOW,
    state_changed_at: NOW,
    lifecycle_changed_at: NOW,
    due_status_changed_at: NOW,
    derivation: 'user_declared',
    monetary_value: undefined,
    blocks_task_ids: [],
    blocks_project_ids: [],
    source_id: 'recued.commitment',
    last_seen_at: NOW,
    sync_state: 'live',
    conflict_policy: 'manual_merge',
    ...over,
  } as WorkEntity);

const project = (over: Partial<WorkEntity & { _kind: 'project' }>): WorkEntity =>
  ({
    _kind: 'project',
    id: over.id ?? 'project-1',
    title: 'Project A',
    description: undefined,
    state: 'active',
    created_at: NOW,
    updated_at: NOW,
    target_completion_at: undefined,
    last_activity_at: NOW,
    related_contact_ids: [],
    parent_project_id: undefined,
    source_id: 'recued.project',
    last_seen_at: NOW,
    sync_state: 'live',
    conflict_policy: 'manual_merge',
    ...over,
  } as WorkEntity);

describe('D-145 PA6 — filterEntitiesBySearch', () => {
  it('returns input unchanged for empty query', () => {
    const tasks = [task({ title: 'Buy milk' })];
    expect(filterEntitiesBySearch('task', tasks, '')).toBe(tasks);
  });

  it('returns input unchanged for whitespace-only query', () => {
    const tasks = [task({ title: 'Buy milk' })];
    expect(filterEntitiesBySearch('task', tasks, '   \t\n  ')).toBe(tasks);
  });

  it('matches case-insensitively on title', () => {
    const tasks = [
      task({ id: 'a', title: 'Buy milk' }),
      task({ id: 'b', title: 'Email Bob' }),
    ];
    const out = filterEntitiesBySearch('task', tasks, 'buy');
    expect(out.map((t) => t.id)).toEqual(['a']);

    const out2 = filterEntitiesBySearch('task', tasks, 'BOB');
    expect(out2.map((t) => t.id)).toEqual(['b']);
  });

  it('matches on body for tasks', () => {
    const tasks = [
      task({ id: 'a', title: 'X', body: 'remember to follow up with Sue' }),
      task({ id: 'b', title: 'Y' }),
    ];
    expect(
      filterEntitiesBySearch('task', tasks, 'sue').map((t) => t.id),
    ).toEqual(['a']);
  });

  it('matches on statement for commitments', () => {
    const commits = [
      commitment({ id: 'a', statement: 'Bob owes me $500' }),
      commitment({ id: 'b', statement: 'I owe Mary lunch' }),
    ];
    expect(
      filterEntitiesBySearch('commitment', commits, 'bob').map((c) => c.id),
    ).toEqual(['a']);
  });

  it('matches on title and description for projects', () => {
    const projects = [
      project({ id: 'a', title: 'Onboarding', description: 'Q3 launch plan' }),
      project({ id: 'b', title: 'Other', description: undefined }),
    ];
    expect(
      filterEntitiesBySearch('project', projects, 'q3').map((p) => p.id),
    ).toEqual(['a']);
  });

  it('returns empty when no entities match the query', () => {
    const tasks = [task({ title: 'Buy milk' })];
    expect(filterEntitiesBySearch('task', tasks, 'zzz')).toEqual([]);
  });

  it('drops rows whose _kind does not match the surface kind', () => {
    const mixed: WorkEntity[] = [task({ title: 'Buy milk' }), note({ title: 'Buy reminder' })];
    expect(
      filterEntitiesBySearch('task', mixed, 'buy').map((e) => e._kind),
    ).toEqual(['task']);
  });
});

describe('D-145 PA6 — sortEntitiesByDefault — task', () => {
  it('puts undone tasks ahead of done tasks', () => {
    const a = task({ id: 'a', done: true });
    const b = task({ id: 'b', done: false });
    expect(
      sortEntitiesByDefault('task', [a, b]).map((t) => t.id),
    ).toEqual(['b', 'a']);
  });

  it('sorts undone tasks by due_at ascending; missing due_at sinks', () => {
    const a = task({ id: 'a', done: false, due_at: 200 });
    const b = task({ id: 'b', done: false, due_at: 100 });
    const c = task({ id: 'c', done: false, due_at: undefined });
    expect(
      sortEntitiesByDefault('task', [a, b, c]).map((t) => t.id),
    ).toEqual(['b', 'a', 'c']);
  });

  it('sorts done tasks by completed_at descending', () => {
    const a = task({ id: 'a', done: true, completed_at: 100 });
    const b = task({ id: 'b', done: true, completed_at: 200 });
    expect(
      sortEntitiesByDefault('task', [a, b]).map((t) => t.id),
    ).toEqual(['b', 'a']);
  });
});

describe('D-145 PA6 — sortEntitiesByDefault — note', () => {
  it('orders notes by last_user_action_at descending', () => {
    const a = note({ id: 'a', last_user_action_at: 100 });
    const b = note({ id: 'b', last_user_action_at: 200 });
    expect(
      sortEntitiesByDefault('note', [a, b]).map((n) => n.id),
    ).toEqual(['b', 'a']);
  });
});

describe('D-145 PA6 — sortEntitiesByDefault — commitment', () => {
  it('puts pending + expired ahead of fulfilled + cancelled', () => {
    const a = commitment({ id: 'a', lifecycle_state: 'fulfilled' });
    const b = commitment({ id: 'b', lifecycle_state: 'pending' });
    const c = commitment({ id: 'c', lifecycle_state: 'expired' });
    const d = commitment({ id: 'd', lifecycle_state: 'cancelled' });
    expect(
      sortEntitiesByDefault('commitment', [a, b, c, d]).map((cm) => cm.id),
    ).toEqual(['b', 'c', 'a', 'd']);
  });

  it('within same lifecycle, orders by promised_for_at ascending; missing sinks', () => {
    const a = commitment({ id: 'a', lifecycle_state: 'pending', promised_for_at: 200 });
    const b = commitment({ id: 'b', lifecycle_state: 'pending', promised_for_at: 100 });
    const c = commitment({ id: 'c', lifecycle_state: 'pending', promised_for_at: undefined });
    expect(
      sortEntitiesByDefault('commitment', [a, b, c]).map((cm) => cm.id),
    ).toEqual(['b', 'a', 'c']);
  });
});

describe('D-145 PA6 — sortEntitiesByDefault — project', () => {
  it('orders by state precedence (active → paused → completed → archived)', () => {
    const a = project({ id: 'a', state: 'archived' });
    const b = project({ id: 'b', state: 'active' });
    const c = project({ id: 'c', state: 'completed' });
    const d = project({ id: 'd', state: 'paused' });
    expect(
      sortEntitiesByDefault('project', [a, b, c, d]).map((p) => p.id),
    ).toEqual(['b', 'd', 'c', 'a']);
  });

  it('within same state, orders by last_activity_at descending', () => {
    const a = project({ id: 'a', state: 'active', last_activity_at: 100 });
    const b = project({ id: 'b', state: 'active', last_activity_at: 200 });
    expect(
      sortEntitiesByDefault('project', [a, b]).map((p) => p.id),
    ).toEqual(['b', 'a']);
  });
});

describe('D-145 PA6 — filterAndSortEntities composes both', () => {
  it('filters then sorts', () => {
    const ts = [
      task({ id: 'a', title: 'Buy milk', done: true, completed_at: 100 }),
      task({ id: 'b', title: 'Buy bread', done: false, due_at: 200 }),
      task({ id: 'c', title: 'Email Bob', done: false, due_at: 100 }),
    ];
    expect(
      filterAndSortEntities('task', ts, 'buy').map((t) => t.id),
    ).toEqual(['b', 'a']);
  });

  it('returns empty when no rows match', () => {
    const ts = [task({ title: 'Buy milk' })];
    expect(filterAndSortEntities('task', ts, 'zzz')).toEqual([]);
  });
});

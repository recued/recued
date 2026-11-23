import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { WorkEntityProjectAttentionRpcRequest } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../work-entity-crud-handler.js';
import { handleWorkEntityProjectAttention } from '../work-entity-project-attention.js';

let directory: string, db: Database.Database, clock: number;
let store: ReturnType<typeof createWorkEntityStore>, resolver: ReturnType<typeof createWorkEntityResolver>, bus: ReturnType<typeof createWarehouseEventBus>;
const initial = Date.parse('2026-03-08T09:30:00Z');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'project-attention-')); db = new Database(join(directory, 'test.db')); db.pragma('journal_mode = WAL'); ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db); resolver = createWorkEntityResolver(store); bus = createWarehouseEventBus(); clock = initial;
  for (const kind of ['project', 'task', 'commitment'] as const) store.registerSource({ id: 'recued.' + kind, top_tier_kind: kind, source_kind: 'builtin', source_label: 'Recued', write_capable: true });
  store.writeProject({ id: 'p/二?', source_id: 'recued.project', title: 'Release <team>' }, clock - 1000);
  store.writeProject({ id: 'other', source_id: 'recued.project', title: 'Other' }, clock - 1000);
});
afterEach(() => { bus.dispose(); db.close(); rmSync(directory, { recursive: true, force: true }); });
const request = (extra: Partial<WorkEntityProjectAttentionRpcRequest> = {}) => ({ project_id: 'p/二?', time_zone: 'America/Los_Angeles', ...extra });
const deps = () => ({ store, resolver, now: () => clock });
const read = (extra: Partial<WorkEntityProjectAttentionRpcRequest> = {}) => handleWorkEntityProjectAttention(deps(), request(extra));
const task = (id: string, extra: Partial<Parameters<typeof store.writeTask>[0]> = {}) => store.writeTask({ id, source_id: 'recued.task', title: id, parent_project_id: 'p/二?', ...extra }, clock);
const promise = (id: string, extra: Partial<Parameters<typeof store.writeCommitment>[0]> = {}) => store.writeCommitment({ id, source_id: 'recued.commitment', statement: id,
  direction: 'inbound', derivation: 'user_declared', promised_at: clock, blocks_project_ids: ['p/二?'], ...extra }, clock);

it('counts all linked saved work before paging and keeps other projects and closed promises out of attention', () => {
  for (let i = 0; i < 23; i++) task('overdue-' + i, { due_at: clock - 60_000 - i });
  task('soon', { due_at: clock + 60_000 }); task('no deadline'); task('completed', { done: true, due_at: clock - 60_000 });
  task('other project', { parent_project_id: 'other', due_at: clock - 60_000 });
  promise('client approval'); promise('internal', { direction: 'internal' }); promise('fulfilled', { lifecycle_state: 'fulfilled' });
  promise('cancelled', { lifecycle_state: 'cancelled' }); promise('unlinked', { blocks_project_ids: ['other'] });
  const summary = read(); expect(summary.counts).toEqual({ open_tasks: 25, completed_tasks: 1, overdue_tasks: 23, due_soon_tasks: 1, blocking_commitments: 2 }); expect(summary.items).toEqual([]);
  const pages = [0, 10, 20].map(offset => read({ scope: 'overdue_tasks', offset, as_of: summary.as_of }));
  expect(pages.map(p => [p.items.length, p.more, p.total])).toEqual([[10, true, 23], [10, true, 23], [3, false, 23]]);
  expect(new Set(pages.flatMap(p => p.items.map(item => item.id))).size).toBe(23);
  expect(pages.every(p => p.items.every(item => item.created_at === clock && item.done === false))).toBe(true);
  expect(read({ scope: 'blocking_commitments' }).items.map(row => row.id).sort()).toEqual(['client approval', 'internal']);
});

it.each([
  { now: '2026-03-08T09:30:00Z', day: '2026-03-08', prior: '2026-03-07', before: '2026-03-15T07:00:00Z' },
  { now: '2026-11-01T08:30:00Z', day: '2026-11-01', prior: '2026-10-31', before: '2026-11-08T08:00:00Z' },
])('uses local date-only deadlines and seven calendar days across the clock change at $day', ({ now, day, prior, before }) => {
  clock = Date.parse(now); const cutoff = Date.parse(before);
  task('day due today', { due_at: Date.parse(day) }); task('day overdue', { due_at: Date.parse(prior) });
  task('timed overdue', { due_at: clock - 1 }); task('timed now', { due_at: clock });
  task('last instant', { due_at: cutoff - 1 }); task('next day excluded', { due_at: cutoff });
  task('completed today', { due_at: Date.parse(day), done: true });
  const result = read(); expect(result.upcoming_before).toBe(cutoff); expect(result.counts.overdue_tasks).toBe(2); expect(result.counts.due_soon_tasks).toBe(3);
  expect(read({ scope: 'overdue_tasks' }).items.map(row => row.id).sort()).toEqual(['day overdue', 'timed overdue']);
  expect(read({ scope: 'due_soon_tasks' }).items.map(row => row.id).sort()).toEqual(['day due today', 'last instant', 'timed now']);
});

it('excludes invisible and provider-only residue before counts and reports stale or incomplete coverage honestly', () => {
  store.registerSource({ id: 'remote.task', top_tier_kind: 'task', source_kind: 'connection', source_label: 'Provider-only tasks', write_capable: false, sync_posture: 'read_through' });
  store.registerSource({ id: 'partial.task', top_tier_kind: 'task', source_kind: 'connection', source_label: 'Partial tasks', write_capable: false });
  task('provider residue', { source_id: 'remote.task', due_at: clock - 1 }); task('orphan', { sync_state: 'orphaned', due_at: clock - 1 });
  const deleted = task('deleted', { due_at: clock - 1 }); store.deleteTask(deleted.id, { tombstone: true, now: clock });
  task('stale', { sync_state: 'stale_unreachable', due_at: clock - 1 }); task('partial', { source_id: 'partial.task', due_at: clock - 1 });
  const freshness = resolver.sourceFreshness.bind(resolver), spy = vi.spyOn(resolver, 'sourceFreshness').mockImplementation(kind =>
    [...(freshness(kind) ?? []).filter(row => row.source_id !== 'partial.task'), ...(kind === 'task' ? [{ source_id: 'partial.task', state: 'fresh' as const, list_complete: false as const }] : [])]);
  try {
    const result = read({ scope: 'overdue_tasks' }); expect(result.counts.open_tasks).toBe(2); expect(result.items.map(row => row.id).sort()).toEqual(['partial', 'stale']);
    expect(result.coverage.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_label: 'Provider-only tasks', reason: 'provider_only' }), expect.objectContaining({ source_label: 'Partial tasks', reason: 'incomplete' }), expect.objectContaining({ reason: 'stale' }),
    ])); expect(result.items.find(row => row.id === 'partial')?.source_incomplete).toBe(true);
  } finally { spy.mockRestore(); }
});

it('refuses a replaced project before counting its work and preserves a fixed window across pages until expiry', () => {
  task('timed', { due_at: clock + 1000 }); const saved = store.readProject('p/二?')!, first = read(); clock += 2000;
  expect(read({ scope: 'due_soon_tasks', as_of: first.as_of }).items.map(i => i.id)).toEqual(['timed']); expect(read().counts.overdue_tasks).toBe(1);
  clock += 15 * 60_000; expect(() => read({ as_of: first.as_of })).toThrow('expired');
  store.deleteProject(saved.id, { tombstone: false }); store.writeProject({ id: saved.id, source_id: saved.source_id, title: 'Replacement' }, clock);
  const count = vi.spyOn(store, 'countByKind'); expect(() => read({ project_identity: { source_id: saved.source_id, created_at: saved.created_at } })).toThrow('removed or replaced'); expect(count).not.toHaveBeenCalled();
});

it('holds related local reads in one WAL snapshot while another connection completes a task', () => {
  const saved = task('changes'); const otherDb = new Database(join(directory, 'test.db')); const other = createWorkEntityStore(otherDb);
  try {
    store.readSnapshot(() => {
      expect(store.countByKind('task', { parent_project_id: 'p/二?', task_filter: { completion: 'open', due: { kind: 'all' }, sort: 'default' } })).toBe(1);
      other.writeTask({ ...saved, done: true }, clock + 1);
      expect(store.readTask('changes')?.done).toBe(false);
      expect(store.countByKind('task', { parent_project_id: 'p/二?', task_filter: { completion: 'open', due: { kind: 'all' }, sort: 'default' } })).toBe(1);
    });
    expect(store.readTask('changes')?.done).toBe(true);
  } finally { otherDb.close(); }
});

it('enforces the paired-client gate before reads and validates public scope, zone and paging bounds', async () => {
  const dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => clock });
  const handlers = makeWorkEntityCrudHandlers({ ...deps(), dispatchers })!.handlers, readSpy = vi.spyOn(store, 'readSnapshot');
  await expect(handlers['work_entity.project.attention'](request(), { instance_id: null } as never)).rejects.toMatchObject({ code: 'unauthorized' }); expect(readSpy).not.toHaveBeenCalled();
  expect(await handlers['work_entity.project.attention'](request(), { instance_id: 'paired' } as never)).toMatchObject({ project: { id: 'p/二?' } });
  for (const input of [{ time_zone: 'Not/AZone' }, { scope: 'unknown' }, { offset: 1 }, { limit: 51 }, { as_of: clock + 1 }]) {
    expect(() => read(input as never)).toThrow();
  }
});

import { describe, expect, it, vi } from 'vitest';
import type { SourceRegistration, WorkEntity, WorkEntityGetRpcResponse } from '@recued/contracts';
import { createTaskDependencyReader, dependencySummary, taskDependency } from '../task-blockers.js';

const sources: SourceRegistration[] = [{ id: 'recued.task', source_kind: 'builtin', top_tier_kind: 'task', source_label: 'Recued', write_capable: true, registered_at: 1 }];
const task = (id: string, done = false): Extract<WorkEntity, { _kind: 'task' }> => ({ _kind: 'task', id, title: `Task ${id}`, done, source_id: 'recued.task',
  sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1, last_seen_at: 1, blocks_task_ids: [] });
const deferred = () => { let resolve!: (value: WorkEntityGetRpcResponse) => void; const promise = new Promise<WorkEntityGetRpcResponse>(done => { resolve = done; }); return { promise, resolve }; };

describe('task blocker status', () => {
  it('uses exact task identity and keeps missing, wrong and deleted records distinct from completion', () => {
    expect(taskDependency('a', { entity: task('a', true) }, sources, 100)).toMatchObject({ state: 'ready', title: 'Task a', source: 'Recued', done: true, current: true });
    for (const entity of [null, { ...task('a'), deleted_at: 10 }, { ...task('a'), sync_state: 'orphaned' as const }]) {
      expect(taskDependency('a', { entity }, sources, 100).state).toBe('missing');
    }
    expect(() => taskDependency('a', { entity: task('b') }, sources, 100)).toThrow('could not be confirmed');
    const project: Extract<WorkEntity, { _kind: 'project' }> = { ...task('a'), _kind: 'project', state: 'active', related_contact_ids: [], last_activity_at: 1 };
    expect(() => taskDependency('a', { entity: project }, sources, 100)).toThrow('could not be confirmed');
  });

  it('does not clear a blocker from stale, expired, partial or unconfirmed completion', () => {
    const done = task('a', true);
    const cases: WorkEntityGetRpcResponse[] = [
      { entity: { ...done, sync_state: 'stale_unreachable' } },
      { entity: { ...done, pending_write: { staged_at: 1, operation: 'update', dirty_fields: ['done'], state: 'awaiting_verify' } } },
      { entity: done, source_freshness: { source_id: done.source_id, state: 'stale' } },
      { entity: done, source_freshness: { source_id: 'other-source', state: 'local' } },
      { entity: done, source_freshness: { source_id: done.source_id, state: 'fresh', last_success_at: 1, stale_after_ms: 10 } },
      { entity: done, source_freshness: { source_id: done.source_id, state: 'fresh', list_complete: false } },
    ];
    for (const response of cases) expect(dependencySummary([taskDependency('a', response, sources, 100)])).toBe('Dependency status unavailable');
    expect(taskDependency('a', { entity: done }, [], 100).current).toBe(false);
  });

  it('counts confirmed open tasks and reserves complete for an entirely confirmed dependency set', () => {
    const open = taskDependency('a', { entity: task('a') }, sources, 100), done = taskDependency('b', { entity: task('b', true) }, sources, 100);
    const missing = taskDependency('missing', { entity: null }, sources, 100);
    expect(dependencySummary([open, open, done])).toBe('Waiting on 2 tasks');
    expect(dependencySummary([open, missing])).toBe('Waiting on 1 task · Some status unconfirmed');
    expect(dependencySummary([done])).toBe('Dependencies complete');
    expect(dependencySummary([done], true)).toBe('Dependency status unavailable');
    expect(dependencySummary([{ state: 'loading', title: '', source: '' }])).toBe('Checking dependencies…');
  });

  it('deduplicates references and bounds concurrency even while reads are queued', async () => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    const get = vi.fn(({ id }: { kind: 'task'; id: string }) => { const result = deferred(); pending.set(id, result); return result.promise; });
    const reader = createTaskDependencyReader({ get, sources: () => sources, changed: () => {} });
    reader.sync(['a', 'b', 'c', 'd', 'e', 'f', 'a']); expect(get).toHaveBeenCalledTimes(4);
    reader.sync(['a', 'b', 'c', 'd', 'e', 'f']); expect(get).toHaveBeenCalledTimes(4);
    pending.get('a')!.resolve({ entity: task('a') }); await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(5));
    pending.get('b')!.resolve({ entity: task('b') }); await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(6));
    for (const id of ['c', 'd', 'e', 'f']) pending.get(id)!.resolve({ entity: task(id) });
    await vi.waitFor(() => expect(reader.value('f').state).toBe('ready')); reader.dispose();
  });

  it('ignores an old completed read after a newer refresh confirms the task is open', async () => {
    const old = deferred(), fresh = deferred(), changed = vi.fn();
    const get = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const reader = createTaskDependencyReader({ get, changed, sources: () => sources });
    reader.sync(['a']); reader.refresh(); fresh.resolve({ entity: task('a') });
    await vi.waitFor(() => expect(reader.value('a')).toMatchObject({ state: 'ready', done: false }));
    old.resolve({ entity: task('a', true) }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(reader.value('a').done).toBe(false); expect(changed).toHaveBeenCalledTimes(2); reader.dispose();
  });

  it('keeps failed reads unknown, retries explicitly, and retires responses after leaving the view', async () => {
    const late = deferred(), get = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ entity: task('a', true) }).mockReturnValueOnce(late.promise);
    const changed = vi.fn(), reader = createTaskDependencyReader({ get, changed, sources: () => sources });
    reader.sync(['a']); expect(reader.current()).toBe(false); await vi.waitFor(() => expect(reader.value('a').state).toBe('error'));
    expect(reader.current()).toBe(false);
    reader.refresh(['a']); await vi.waitFor(() => expect(reader.value('a').done).toBe(true));
    expect(reader.current()).toBe(true);
    reader.refresh(['a']); reader.sync([]); const count = changed.mock.calls.length;
    late.resolve({ entity: task('a') }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(changed).toHaveBeenCalledTimes(count); reader.dispose();
  });

  it('expires a synced completion using its source horizon without pretending the task changed', async () => {
    let now = 100;
    const reader = createTaskDependencyReader({ get: async () => ({ entity: task('a', true), source_freshness: { source_id: 'recued.task', state: 'fresh', last_success_at: 100, stale_after_ms: 50 } }),
      sources: () => sources, now: () => now, changed: () => {} });
    reader.sync(['a']); await vi.waitFor(() => expect(reader.value('a').current).toBe(true));
    now = 151; expect(reader.value('a')).toMatchObject({ done: true, current: false }); expect(reader.current()).toBe(false); reader.dispose();
  });
});

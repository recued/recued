import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkDraftCheckpoint, createWorkRecoveryStore, parseWorkRecovery, workDraftMatchesOriginal, workDraftOriginal,
  WORK_RECOVERY_LIMITS, type WorkDraftEntity, type WorkRecoveryEntry, type WorkRecoveryStorage } from '../work-draft-recovery.js';
import { renderWorkDraftRecoveries } from '../work-draft-recovery-ui.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const memory = () => {
  const values = new Map<string, string>();
  const storage: WorkRecoveryStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  return { values, storage };
};
const entity = (kind: 'task' | 'project'): WorkDraftEntity => ({ id: 'same-id', source_id: `recued.${kind}`, source_record_id: 'provider-id',
  created_at: now - 1000, updated_at: now, last_seen_at: now, sync_state: 'live', conflict_policy: 'recued_wins',
  ...(kind === 'task' ? { _kind: 'task', title: 'Saved task', body: 'Original notes', done: false, blocks_task_ids: ['a', 'b'] }
    : { _kind: 'project', title: 'Saved project', description: 'Original description', state: 'active', related_contact_ids: ['a', 'b'], last_activity_at: now }),
});
const entry = (): WorkRecoveryEntry => ({ id: `wdr_${crypto.randomUUID()}`, revision: 1, updatedAt: now,
  sourceId: 'recued.task', original: null, status: 'editing', values: { title: 'Unfinished', body: '\n  Café 🧾 <script>literal</script>  \n',
    due_at: '2026-11-16T10:30', blocks_task: ['task-two'], provider_field: { value: 'source extension' } } });
afterEach(() => vi.useRealTimers());

describe('same-tab Task and Project recovery', () => {
  it('round trips field values independently by kind and pairing without persisting authority fields', () => {
    const { storage } = memory(), task = createWorkRecoveryStore({ kind: 'task', scope: 'pair-a', storage, now: () => now });
    const row = entry();
    expect(task.save({ ...row, values: { ...row.values, source_id: 'forged', id: 'forged', pending_write: null } })).toBe(true);
    expect(task.get(row.id)).toEqual(row);
    expect(createWorkRecoveryStore({ kind: 'project', scope: 'pair-a', storage, now: () => now }).list()).toEqual([]);
    expect(createWorkRecoveryStore({ kind: 'task', scope: 'pair-b', storage, now: () => now }).list()).toEqual([]);
    const copy = task.get(row.id)!; (copy.values.blocks_task as string[]).push('local mutation');
    expect(task.get(row.id)!.values.blocks_task).toEqual(['task-two']);
  });

  it('rejects mismatched originals, malformed field values, expired copies and unbound save attempts', () => {
    const row = entry(), original = workDraftOriginal(entity('task'));
    expect(parseWorkRecovery({ ...row, original }, now, 'task')).toEqual({ ...row, original });
    expect(parseWorkRecovery({ ...row, original }, now, 'project')).toBeNull();
    expect(parseWorkRecovery({ ...row, original: { ...original, sourceId: 'wrong' } }, now, 'task')).toBeNull();
    expect(parseWorkRecovery({ ...row, values: { title: 22 } }, now, 'task')).toBeNull();
    expect(parseWorkRecovery({ ...row, values: { body: 'x'.repeat(100_001) } }, now, 'task')).toBeNull();
    expect(parseWorkRecovery({ ...row, status: 'pending' }, now, 'task')).toBeNull();
    expect(parseWorkRecovery(row, now + WORK_RECOVERY_LIMITS.age + 1, 'task')).toBeNull();
  });

  it('checks identity, lifecycle, relationships, source fields and same-timestamp content changes before restoring', () => {
    const task = entity('task'), original = workDraftOriginal(task);
    if (task._kind !== 'task') throw new Error('Wrong fixture');
    expect(workDraftMatchesOriginal(original, { ...task, last_seen_at: now + 1, blocks_task_ids: ['b', 'a'] })).toBe(true);
    for (const patch of [{ body: 'changed' }, { done: true }, { parent_project_id: 'other' }, { source_id: 'other' },
      { source_record_id: 'reused' }, { created_at: now + 1 }, { updated_at: now + 1 }, { source_extension_blob: { changed: true } }]) {
      expect(workDraftMatchesOriginal(original, { ...task, ...patch })).toBe(false);
    }
    const project = entity('project'), base = workDraftOriginal(project);
    if (project._kind !== 'project') throw new Error('Wrong fixture');
    expect(workDraftMatchesOriginal(base, { ...project, description: 'changed', updated_at: project.updated_at })).toBe(false);
    expect(workDraftMatchesOriginal(base, { ...project, state: 'archived' })).toBe(false);
    expect(workDraftMatchesOriginal(base, { ...project, related_contact_ids: ['b', 'a'] })).toBe(true);
    expect(workDraftMatchesOriginal(base, { ...project, related_contact_ids: ['c'] })).toBe(false);
  });

  it('retains newer revisions and lost-save copies, and clears only the exact confirmed attempt', () => {
    const { storage } = memory(), store = createWorkRecoveryStore({ kind: 'task', scope: 'a', storage, now: () => now });
    const checkpoint = createWorkDraftCheckpoint({ kind: 'task', store, now: () => now });
    checkpoint.begin('recued.task', {}, null); checkpoint.flush(); expect(store.list()).toEqual([]);
    checkpoint.capture('recued.task', entry().values); const first = checkpoint.startAttempt()!;
    checkpoint.capture('recued.task', { ...entry().values, body: 'Newer edits' }); checkpoint.flush(); checkpoint.settle(first, true, 'created');
    expect(store.get(first.id)).toMatchObject({ status: 'unknown', savedId: 'created', values: { body: 'Newer edits' } });
    const second = checkpoint.startAttempt()!; checkpoint.suspend();
    expect(createWorkRecoveryStore({ kind: 'task', scope: 'a', storage, now: () => now }).get(second.id)?.status).toBe('pending');
    checkpoint.settle(first, true); expect(store.get(second.id)?.attempt).toBe(second.attempt);
    checkpoint.settle(second, true); expect(store.list()).toEqual([]);
  });

  it('reports quota failures without replacing the prior copy and keeps a failed discard available for retry', () => {
    vi.useFakeTimers(); const { storage } = memory(); let blocked = false;
    const store = createWorkRecoveryStore({ kind: 'project', scope: 'a', now: () => now, storage: { ...storage,
      setItem: (key, value) => { if (blocked) throw new Error('full'); storage.setItem(key, value); },
      removeItem: key => { if (blocked) throw new Error('blocked'); storage.removeItem(key); } } });
    const checkpoint = createWorkDraftCheckpoint({ kind: 'project', store, now: () => now });
    checkpoint.begin('recued.project', {}, null); checkpoint.capture('recued.project', { title: 'Draft', description: 'First' }); vi.advanceTimersByTime(300);
    blocked = true; checkpoint.capture('recued.project', { title: 'Draft', description: 'Latest' }); checkpoint.flush();
    expect(checkpoint.message()).toContain('Latest edits could not be kept'); expect(store.list()[0]?.values.description).toBe('First');
    expect(checkpoint.startAttempt()?.blocked).toBe(true); expect(checkpoint.status()).toBe('editing'); expect(checkpoint.discard()).toBe(false);
    blocked = false; expect(checkpoint.discard()).toBe(true); expect(store.list()).toEqual([]);
  });

  it('reports an oversized field instead of silently keeping only the remaining fields', () => {
    const { storage } = memory(), store = createWorkRecoveryStore({ kind: 'task', scope: 'a', storage, now: () => now });
    const checkpoint = createWorkDraftCheckpoint({ kind: 'task', store, now: () => now });
    checkpoint.begin('recued.task', {}, null); checkpoint.capture('recued.task', { title: 'Draft', body: 'x'.repeat(100_001) });
    expect(checkpoint.flush()).toBe(false); expect(checkpoint.message()).toContain('Latest edits could not be kept');
    expect(store.list()).toEqual([]);
    checkpoint.suspend();
  });

  it('renders escaped recovery fields for copying and disables replay of an unconfirmed create', () => {
    const row = { ...entry(), status: 'unknown' as const, attempt: crypto.randomUUID(), savedId: 'created-task' };
    const html = renderWorkDraftRecoveries({ kind: 'task', entries: [row], preview: row.id, busy: null, discard: null, notice: null, sourceLabel: () => 'My tasks' });
    expect(html).toContain('Save was not confirmed');
    expect(html).toMatch(/data-action="work-draft-resume"[^>]* disabled/);
    expect(html).toContain('Open saved task');
    expect(html).toContain('&lt;script&gt;literal&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});

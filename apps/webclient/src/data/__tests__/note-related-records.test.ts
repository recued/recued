import { describe, expect, it, vi } from 'vitest';
import type { ContactRecord, Note, WorkEntity } from '@recued/contracts';
import { createNoteRelatedRecords } from '../note-related-records.js';

const base = { id: 'note-one', source_id: 'recued.note', created_at: 100, updated_at: 200, last_seen_at: 200,
  sync_state: 'live' as const, conflict_policy: 'recued_wins' as const };
const note = (contacts = ['person@example.test'], projects = ['project-one']): Note => ({ ...base, body: 'Saved text',
  last_user_action_at: 200, related_contact_ids: contacts, related_project_ids: projects, related_calendar_event_ids: [], related_mail_thread_ids: [] });
const contact: ContactRecord = { _id: 'person@example.test', _collection: 'contact', email: 'person@example.test', contact_id: 'contact-one', name: 'Riley', source: 'manual',
  created_at: 100, updated_at: 200, first_seen: 100, last_interaction: 200, interaction_count: 0 };
const project: Extract<WorkEntity, { _kind: 'project' }> = { ...base, _kind: 'project', id: 'project-one', source_id: 'recued.project',
  title: 'Launch project', state: 'active', related_contact_ids: [], last_activity_at: 200 };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('related contacts and projects in a note', () => {
  it('reads lazily, deduplicates stored references and keeps canonical identities behind display names', async () => {
    const getContact = vi.fn(async () => ({ contact })), getProject = vi.fn(async () => ({ entity: project }));
    const model = createNoteRelatedRecords({ contact: getContact, project: getProject, changed() {} });
    model.open(note(['contact-one', 'contact-one'])); expect(getContact).not.toHaveBeenCalled();
    expect(model.view().records).toHaveLength(2); await model.load();
    expect(model.view().records).toMatchObject([{ label: 'Riley', state: 'ready' }, { label: 'Launch project', state: 'ready' }]);
    expect(getContact).toHaveBeenCalledExactlyOnceWith('contact-one');
    expect(await model.activate('contact:contact-one')).toMatchObject({ kind: 'contact', contact: { contact_id: 'contact-one' } });
    expect(getContact).toHaveBeenCalledTimes(2);
    model.open(note(['contact-one'])); await model.load(); expect(getContact).toHaveBeenCalledTimes(2);
  });

  it('shows independent results, distinguishes missing from failed reads and retries only the selected record', async () => {
    let failed = true;
    const getContact = vi.fn(async () => { if (failed) throw new Error('Offline'); return { contact }; });
    const getProject = vi.fn(async () => ({ entity: null }));
    const model = createNoteRelatedRecords({ contact: getContact, project: getProject, changed() {} });
    model.open(note()); await model.load();
    expect(model.view().records.map(row => row.state)).toEqual(['unavailable', 'missing']);
    expect(await model.activate('project:project-one')).toBeNull();
    failed = false; model.retry('contact:person@example.test');
    await vi.waitFor(() => expect(model.view().records[0]?.state).toBe('ready'));
    expect(getProject).toHaveBeenCalledTimes(1); expect(getContact).toHaveBeenCalledTimes(2);
  });

  it('bounds requests and pages large relationship lists while allowing completed rows to appear before a slow read', async () => {
    const held = deferred<{ contact: ContactRecord }>(); let running = 0, maximum = 0;
    const getContact = vi.fn(async (id: string) => {
      running++; maximum = Math.max(maximum, running);
      const result = id === 'person-0' ? await held.promise : await Promise.resolve({ contact: { ...contact, contact_id: id, name: id } });
      running--; return result;
    });
    const model = createNoteRelatedRecords({ contact: getContact, changed() {} });
    model.open(note(Array.from({ length: 25 }, (_, index) => `person-${index}`), [])); const loading = model.load();
    await vi.waitFor(() => expect(model.view().records[1]?.state).toBe('ready'));
    expect(model.view().records[0]?.state).toBe('loading'); held.resolve({ contact }); await loading;
    expect(maximum).toBeLessThanOrEqual(4); expect(getContact).toHaveBeenCalledTimes(20); expect(model.view().more).toBe(true);
    model.more(); await vi.waitFor(() => expect(model.view().records.at(-1)?.state).toBe('ready'));
    expect(getContact).toHaveBeenCalledTimes(25); expect(model.view().more).toBe(false);
  });

  it('retires reads and activations when a different note takes ownership', async () => {
    const first = deferred<{ entity: WorkEntity | null }>();
    const model = createNoteRelatedRecords({ project: () => first.promise, changed() {} });
    model.open(note([], ['project-one'])); const loading = model.load(); model.open({ ...note([], []), id: 'note-two' });
    first.resolve({ entity: project }); await loading; expect(model.view().records).toEqual([]);
    let held = false; const second = deferred<{ entity: WorkEntity | null }>();
    const active = createNoteRelatedRecords({ project: async () => held ? second.promise : { entity: project }, changed() {} });
    active.open(note([], ['project-one'])); await active.load(); held = true;
    const opening = active.activate('project:project-one'); active.reset(); second.resolve({ entity: project });
    expect(await opening).toBeNull(); expect(active.view().records).toEqual([]);
  });

  it('rechecks contact and project identity before navigation and refuses removed, stale and reused records', async () => {
    let currentContact = contact, currentProject: WorkEntity | null = project;
    const model = createNoteRelatedRecords({ contact: async () => ({ contact: currentContact }), project: async () => ({ entity: currentProject }), changed() {} });
    model.open(note()); await model.load(); currentContact = { ...contact, contact_id: 'different-person' };
    expect(await model.activate('contact:person@example.test')).toBeNull(); expect(model.view().records[0]?.state).toBe('unavailable');
    currentProject = { ...project, created_at: 999 }; expect(await model.activate('project:project-one')).toBeNull();
    for (const value of [null, { ...project, sync_state: 'stale_unreachable' as const }, { ...project, deleted_at: 300 }]) {
      const model = createNoteRelatedRecords({ project: async () => ({ entity: value }), changed() {} });
      model.open(note([], ['project-one'])); await model.load(); expect(await model.activate('project:project-one')).toBeNull();
    }
  });

  it('follows explicit contact resolution for a merged address and preserves addressless contact names', async () => {
    const canonical = { ...contact, email: 'canonical@example.test' };
    const get = vi.fn(async (id: string) => ({ contact: id === 'old@example.test' ? { ...contact, merged_into: canonical.email } : canonical }));
    const resolve = vi.fn(async () => ({ contact: canonical }));
    const model = createNoteRelatedRecords({ contact: get, resolveContact: resolve, changed() {} });
    model.open(note(['old@example.test'], [])); await model.load();
    expect(resolve).toHaveBeenCalledWith('old@example.test'); expect(get).toHaveBeenCalledWith('contact-one');
    expect(await model.activate('contact:old@example.test')).toMatchObject({ contact: { email: canonical.email } });
    const noAddress = createNoteRelatedRecords({ contact: async () => ({ contact: { ...contact, email: 'mention@_recued.invalid', name: 'A person without email' } }), changed() {} });
    noAddress.open(note(['contact-one'], [])); await noAddress.load(); expect(noAddress.view().records[0]?.label).toBe('A person without email');
  });
});

type Task = Extract<WorkEntity, { _kind: 'task' }>;
const task = (id = 'dependency', patch: Partial<Task> = {}): Task => ({ ...base, id, _kind: 'task', source_id: 'recued.task', title: id,
  done: false, blocks_task_ids: [], ...patch });
const owner = (ids = ['dependency']) => ({ ...note([], []), ...task('owner'), blocks_task_ids: ids });
const sources = () => [{ id: 'recued.task', top_tier_kind: 'task' as const, source_kind: 'builtin' as const, source_label: 'Recued', write_capable: true, registered_at: 1 }];

describe('dependencies in a task reader', () => {
  it('deduplicates canonical ids, shows confirmed status and rechecks the exact identity on activation', async () => {
    let value = task('dependency', { title: 'Same title <img>', done: true });
    const get = vi.fn(async () => ({ entity: value }));
    const model = createNoteRelatedRecords({ task: get, sources, changed() {} });
    model.open(owner(['dependency', 'dependency'])); await model.load();
    expect(get).toHaveBeenCalledExactlyOnceWith('dependency');
    expect(model.view().records).toMatchObject([{ key: 'task:dependency', label: 'Same title <img>', task: { done: true, current: true } }]);
    expect(model.dependencies()).toEqual({ summary: 'Dependencies complete', uncertain: false });
    value = { ...value, created_at: 999 };
    expect(await model.activate('task:dependency')).toBeNull();
    expect(model.view().records[0]).toMatchObject({ state: 'unavailable', message: 'The linked task changed. Try again to check it.' });
    model.retry('task:dependency'); await vi.waitFor(() => expect(model.view().records[0]?.state).toBe('ready'));
    expect(await model.activate('task:dependency')).toMatchObject({ task: { created_at: 999 } }); model.reset();
  });

  it('never treats stale, pending, missing, wrong-identity or self-referential tasks as completed', async () => {
    const get = vi.fn(async (id: string) => ({ entity: id === 'missing' ? null : id === 'wrong' ? task('another', { done: true })
      : task(id, id === 'pending' ? { done: true, pending_write: { staged_at: 1, operation: 'update', dirty_fields: ['done'], state: 'awaiting_verify' } }
        : { done: true, sync_state: 'stale_unreachable' }) }));
    const model = createNoteRelatedRecords({ task: get, sources, changed() {} });
    model.open(owner(['stale', 'pending', 'missing', 'wrong', 'owner'])); await model.load();
    expect(model.dependencies().summary).toBe('Dependency status unavailable');
    expect(model.view().records).toMatchObject([
      { state: 'ready', task: { current: false, pending: false } }, { state: 'ready', task: { current: false, pending: true } },
      { state: 'missing' }, { state: 'unavailable' }, { state: 'unavailable', message: 'This task depends on itself.' },
    ]);
    expect(get.mock.calls.flat()).not.toContain('owner');
    expect(await model.activate('task:stale')).toMatchObject({ task: { id: 'stale' } }); model.reset();
  });

  it('retires old label and activation responses when a newer refresh takes ownership', async () => {
    const held = deferred<{ entity: WorkEntity | null }>();
    let result = held.promise;
    const model = createNoteRelatedRecords({ task: () => result, sources, changed() {} });
    model.open(owner()); const oldLoad = model.load();
    result = Promise.resolve({ entity: task('dependency', { done: true }) });
    model.refreshTasks(); await model.load();
    held.resolve({ entity: task() }); await oldLoad;
    expect(model.dependencies().summary).toBe('Dependencies complete');
    const heldOpen = deferred<{ entity: WorkEntity | null }>(); result = heldOpen.promise;
    const opening = model.activate('task:dependency'); model.refreshTasks();
    result = Promise.resolve({ entity: task() }); await model.load();
    heldOpen.resolve({ entity: task('dependency', { done: true }) });
    expect(await opening).toBeNull(); expect(model.dependencies().summary).toBe('Waiting on 1 task'); model.reset();
  });

  it('keeps undisplayed dependencies unconfirmed until the bounded next page is read', async () => {
    const get = vi.fn(async (id: string) => ({ entity: task(id, { done: true }) }));
    const model = createNoteRelatedRecords({ task: get, sources, changed() {} });
    model.open(owner(Array.from({ length: 21 }, (_, i) => `task-${i}`))); await model.load();
    expect(get).toHaveBeenCalledTimes(20); expect(model.view().more).toBe(true);
    expect(model.dependencies().summary).toBe('Checking dependencies…');
    model.more(); await vi.waitFor(() => expect(model.dependencies().summary).toBe('Dependencies complete'));
    expect(get).toHaveBeenCalledTimes(21); expect(model.view().more).toBe(false); model.reset();
  });

  it('expires both dependency status and the saved owner list and cancels its expiry timer on reset', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const fresh = { source_id: 'recued.task', state: 'fresh' as const, last_success_at: 1000, stale_after_ms: 100 };
      const changed = vi.fn();
      const model = createNoteRelatedRecords({ task: async () => ({ entity: task('dependency', { done: true }), source_freshness: fresh }), sources, changed });
      model.open(owner(), { source_freshness: { ...fresh, stale_after_ms: 200 } }); await model.load();
      expect(model.dependencies().summary).toBe('Dependencies complete');
      await vi.advanceTimersByTimeAsync(101);
      expect(changed).toHaveBeenCalled(); expect(model.view().records[0]?.task?.current).toBe(false);
      expect(model.dependencies()).toEqual({ summary: 'Dependency status unavailable', uncertain: false });
      await vi.advanceTimersByTimeAsync(100); expect(model.dependencies().uncertain).toBe(true);
      model.open(owner(), { source_freshness: { ...fresh, last_success_at: 1201 } }); model.reset();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

it('bounds relationship reads across overlapping refreshes and skips superseded queued jobs', async () => {
  const held = deferred<void>(); let running = 0, maximum = 0, refreshing = false;
  const get = vi.fn(async (id: string) => {
    running++; maximum = Math.max(maximum, running); const old = !refreshing;
    if (old) await held.promise;
    running--; return { entity: task(id, { done: !old }) };
  });
  const model = createNoteRelatedRecords({ task: get, sources, changed() {} });
  model.open(owner(['a', 'b', 'c', 'd', 'e'])); const first = model.load();
  expect(get).toHaveBeenCalledTimes(4); refreshing = true; model.refreshTasks(); const latest = model.load();
  await Promise.resolve(); expect(get).toHaveBeenCalledTimes(4);
  held.resolve(); await Promise.all([first, latest]);
  expect(maximum).toBeLessThanOrEqual(4); expect(model.dependencies().summary).toBe('Dependencies complete'); model.reset();
});

it('requires a new owner read to confirm a saved dependency list after invalidation', async () => {
  const model = createNoteRelatedRecords({ task: async () => ({ entity: task('dependency', { done: true }) }), sources, changed() {} });
  model.open(owner(), {}); await model.load(); expect(model.dependencies().summary).toBe('Dependencies complete');
  model.refreshTasks({ owner: true }); await model.load();
  expect(model.dependencies()).toEqual({ summary: 'Dependency status unavailable', uncertain: true });
  model.open(owner()); expect(model.dependencies().uncertain).toBe(true);
  model.open(owner(), {}); expect(model.dependencies()).toEqual({ summary: 'Dependencies complete', uncertain: false }); model.reset();
});

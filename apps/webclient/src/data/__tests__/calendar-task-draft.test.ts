import { describe, expect, it, vi } from 'vitest';
import { CALENDAR_EVENT_EDIT_LIMITS, type CalendarEventCreateRequest, type CalendarEventCreateResult, type WorkEntity } from '@recued/contracts';
import { calendarTaskSeed, calendarTaskHref, canScheduleTask, readCalendarTaskOrigin } from '../calendar-task-draft.js';
import { createCalendarCreateSurface, CALENDAR_CREATE_FIELD } from '../calendar-create-surface.js';
import { createCalendarRecoveryStore, parseCalendarRecovery } from '../calendar-draft-recovery.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
const task = (): Task => ({ _kind: 'task', id: 'task/?二', source_id: 'read-only.task', source_record_id: 'provider-1', title: 'Plan <the launch>',
  body: 'Private task notes', blocks_task_ids: ['private-blocker'], done: false, priority: 'high', due_at: Date.parse('2026-11-01T08:30:12.345Z'), assigned_contact_id: 'contact-one',
  created_at: 1, updated_at: 1, last_seen_at: 1, sync_state: 'live', conflict_policy: 'recued_wins' });
const input = (name: string, value: string) => ({ getAttribute: (key: string) => key === CALENDAR_CREATE_FIELD ? name : null, value }) as unknown as HTMLElement;
const now = () => Date.parse('2026-10-31T18:00Z');
const created = (request: CalendarEventCreateRequest): CalendarEventCreateResult => ({
  slug: request.slug, snapshot: { incarnation: request.expected_incarnation, resource_version: 'v1', editable: false,
    record: { record_id: 'new', source_id: 'new', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} },
    event: { ...request, record_id: 'new', source_id: 'new', updated_at: 1, status: 'confirmed', is_recurring: false } },
});
const form = (recovery?: ReturnType<typeof createCalendarRecoveryStore>) => {
  const create = vi.fn(async (request: CalendarEventCreateRequest) => created(request)), onTaskCreated = vi.fn(), onTaskCancelled = vi.fn(), onCreated = vi.fn();
  const surface = createCalendarCreateSurface({ callers: { create, destinations: async () => ({ destinations: [
    { slug: 'work', calendar_id: 'primary', provider: 'gcal', incarnation: 'calendar-1', name: 'Work' },
  ], unavailable: [] }) }, recovery, now, context: () => ({ day: '2026-10-31', zone: 'America/Los_Angeles' }), render: vi.fn(), actionAttr: 'data-action',
    onTaskCreated, onTaskCancelled, onCreated });
  return { surface, create, onTaskCreated, onTaskCancelled, onCreated };
};
const loaded = async (surface: ReturnType<typeof createCalendarCreateSurface>) => vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));

describe('reviewed time for a task', () => {
  it('uses the freshly read title and an exact task link without copying dates, relationships, body or authority', () => {
    const original = task(), before = structuredClone(original), fresh = { ...original, title: 'Fresh title' };
    const seed = calendarTaskSeed(original, fresh, 'https://user:secret@recued.test/client/?token=private#views/old');
    expect(seed).toMatchObject({ summary: 'Fresh title', location: '', description: 'Task: https://recued.test/client/#data/task/task%2F%3F%E4%BA%8C',
      origin: { id: original.id, sourceId: original.source_id, sourceRecordId: 'provider-1', createdAt: 1, label: 'Fresh title' } });
    expect(calendarTaskHref(seed.origin)).toBe('#data/task/task%2F%3F%E4%BA%8C');
    for (const key of ['due_at', 'done', 'guests', 'body', 'assigned_contact_id', 'parent_project_id', 'blocks_task_ids']) expect(seed).not.toHaveProperty(key);
    expect(JSON.stringify(seed)).not.toContain(original.body); expect(original).toEqual(before);
  });
  it('refuses replaced or missing tasks before generating a draft', () => {
    const original = task();
    for (const fresh of [null, { ...original, id: 'other' }, { ...original, source_id: 'other' }, { ...original, source_record_id: 'other' }, { ...original, created_at: 2 }])
      expect(() => calendarTaskSeed(original, fresh, 'https://recued.test/')).toThrow('identity');
  });
  it('requires an open live task with confirmed state while keeping calendar authority independent of task editability', () => {
    expect(canScheduleTask(task())).toBe(true);
    for (const fresh of [{ ...task(), done: true }, { ...task(), deleted_at: 2 }, { ...task(), sync_state: 'orphaned' as const },
      { ...task(), pending_write: { operation: 'update' as const, staged_at: 2, dirty_fields: ['title'], state: 'awaiting_verify' as const } }]) {
      expect(canScheduleTask(fresh)).toBe(false); expect(() => calendarTaskSeed(task(), fresh, 'https://recued.test/')).toThrow('status');
    }
  });
  it('normalizes title lines, handles missing titles and refuses oversized or invalid navigation metadata', () => {
    expect(calendarTaskSeed(task(), { ...task(), title: 'One\r\nTwo' }, 'https://recued.test/').summary).toBe('One Two');
    expect(calendarTaskSeed(task(), { ...task(), title: ' ' }, 'https://recued.test/').summary).toBe('Task');
    expect(() => calendarTaskSeed(task(), { ...task(), title: 'x'.repeat(CALENDAR_EVENT_EDIT_LIMITS.summary + 1) }, 'https://recued.test/')).toThrow('limits');
    expect(() => calendarTaskSeed(task(), task(), 'javascript:alert(1)')).toThrow('link');
    const origin = calendarTaskSeed(task(), task(), 'https://recued.test/').origin;
    expect(readCalendarTaskOrigin({ ...origin, guests: ['hidden@example.test'] })).toBeNull();
    expect(readCalendarTaskOrigin({ ...origin, createdAt: -1 })).toBeNull();
    expect(readCalendarTaskOrigin({ ...origin, sourceRecordId: '' })).toBeNull();
  });
  it('starts with empty dates and guests, sends only reviewed calendar fields and returns task context separately', async () => {
    const original = task(), before = structuredClone(original), seed = calendarTaskSeed(original, original, 'https://recued.test/');
    const { surface, create, onTaskCreated, onCreated } = form();
    surface.openFromTask(seed); await loaded(surface);
    expect(surface.render()).toContain('Time for task'); expect(surface.render()).toContain('Times in America/Los_Angeles');
    surface.handleAction('calendar-create-save'); await Promise.resolve(); expect(create).not.toHaveBeenCalled();
    surface.handleInput(input('start', '2026-11-02T09:00')); surface.handleInput(input('end', '2026-11-02T10:00'));
    surface.handleAction('calendar-create-save'); await vi.waitFor(() => expect(onTaskCreated).toHaveBeenCalledOnce());
    const request = create.mock.calls[0]![0];
    expect(request).toMatchObject({ summary: original.title, description: seed.description, timezone: 'America/Los_Angeles',
      start_at: Date.parse('2026-11-02T17:00Z'), end_at: Date.parse('2026-11-02T18:00Z') });
    for (const key of ['task', 'origin', 'due_at', 'done', 'guests', 'assigned_contact_id']) expect(request).not.toHaveProperty(key);
    expect(onTaskCreated).toHaveBeenCalledWith(created(request), seed.origin); expect(onCreated).not.toHaveBeenCalled();
    expect(original).toEqual(before); surface.dispose();
  });
  it('preserves an existing creation draft when another task asks to schedule time', async () => {
    const { surface } = form(), seed = calendarTaskSeed(task(), task(), 'https://recued.test/');
    surface.open(); await loaded(surface); surface.handleInput(input('summary', 'Keep this ordinary draft'));
    expect(surface.openFromTask(seed)).toBe(false); expect(surface.render()).toContain('Keep this ordinary draft');
    surface.handleAction('calendar-create-cancel'); surface.handleAction('calendar-create-discard');
    surface.openFromTask(seed); await loaded(surface); surface.handleInput(input('summary', 'Keep this reviewed block'));
    expect(surface.openFromTask({ ...seed, summary: 'Overwrite' })).toBe(false); expect(surface.render()).toContain('Keep this reviewed block'); surface.dispose();
  });
  it('checks an uncertain creation with the exact same request and one source context', async () => {
    const seed = calendarTaskSeed(task(), task(), 'https://recued.test/'), { surface, create, onTaskCreated } = form();
    create.mockRejectedValueOnce(new Error('Lost reply'));
    surface.openFromTask(seed); await loaded(surface);
    surface.handleInput(input('start', '2026-11-02T09:00')); surface.handleInput(input('end', '2026-11-02T10:00'));
    surface.handleAction('calendar-create-save'); await vi.waitFor(() => expect(surface.render()).toContain('Check save'));
    surface.handleAction('calendar-create-save'); await vi.waitFor(() => expect(onTaskCreated).toHaveBeenCalledOnce());
    expect(create.mock.calls).toHaveLength(2); expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]); surface.dispose();
  });
  it('recovers an untouched task draft and returns to its task only after confirmed discard', async () => {
    const rows = new Map<string, string>(), store = createCalendarRecoveryStore({ scope: 'task', now, storage: {
      getItem: key => rows.get(key) ?? null, setItem: (key, value) => { rows.set(key, value); }, removeItem: key => { rows.delete(key); },
    } });
    const seed = calendarTaskSeed(task(), task(), 'https://recued.test/'), first = form(store).surface;
    first.openFromTask(seed); await loaded(first); first.flush(); first.dispose();
    const entry = store.list()[0]!; expect(entry.values.task).toEqual(seed.origin);
    expect(parseCalendarRecovery({ ...entry, values: { ...entry.values, task: { ...seed.origin, deadline: task().due_at } } }, now())).toBeNull();
    expect(parseCalendarRecovery({ ...entry, values: { ...entry.values, mail: { kind: 'mail', slug: 'm', recordId: 'id', receivedAt: 1, identity: null, label: 'Email' } } }, now())).toBeNull();
    const { surface, onTaskCancelled } = form(store);
    surface.handleAction('calendar-create-recovery-resume', { getAttribute: () => entry.id } as unknown as HTMLElement); await loaded(surface);
    surface.handleAction('calendar-create-cancel'); expect(onTaskCancelled).not.toHaveBeenCalled();
    surface.handleAction('calendar-create-discard'); expect(onTaskCancelled).toHaveBeenCalledWith(seed.origin);
    expect(store.list()).toEqual([]); surface.dispose();
  });
});

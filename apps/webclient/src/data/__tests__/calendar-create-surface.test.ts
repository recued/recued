import { expect, it, vi } from 'vitest';
import type { CalendarEventCreateRequest, CalendarEventCreateResult, CalendarEventDestinations } from '@recued/contracts';
import { calendarCreateTimes, createCalendarCreateSurface, CALENDAR_CREATE_FIELD, type CalendarCreateDraft } from '../calendar-create-surface.js';

const calendars: CalendarEventDestinations = { destinations: [{ slug: 'work', calendar_id: 'primary', name: 'Work', provider: 'gcal', incarnation: 'calendar-1' }], unavailable: [] };
const draft = (): CalendarCreateDraft => ({ destination: '', summary: 'Planning', description: '', location: '',
  start: '2026-10-31T09:00', end: '2026-10-31T10:00', allDay: false, startChoice: '', endChoice: '' });
const result = (request: CalendarEventCreateRequest): CalendarEventCreateResult => ({ slug: request.slug, snapshot: {
  event: { record_id: 'record-1', source_id: 'event-1', calendar_id: request.calendar_id,
    summary: request.summary, description: request.description, location: request.location, start_at: request.start_at, end_at: request.end_at,
    timezone: request.timezone, is_all_day: request.is_all_day, status: 'confirmed', is_recurring: false, updated_at: 1 },
  record: { record_id: 'record-1', source_id: 'event-1', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} },
  incarnation: request.expected_incarnation, resource_version: 'v1', editable: false,
} });
const input = (name: string, value: string) => ({ getAttribute: (key: string) => key === CALENDAR_CREATE_FIELD ? name : null, value }) as unknown as HTMLElement;
const setup = (callers: Parameters<typeof createCalendarCreateSurface>[0]['callers'] = {}) => {
  const onCreated = vi.fn(), render = vi.fn();
  const surface = createCalendarCreateSurface({ callers: { destinations: async () => calendars, create: async request => result(request), ...callers },
    actionAttr: 'data-action', context: () => ({ day: '2026-10-31', zone: 'America/Los_Angeles', preferredSlug: 'work' }),
    now: () => Date.parse('2026-10-31T12:00:00Z'), render, onCreated });
  return { surface, onCreated };
};

it('reads inclusive all-day dates across DST and requires a valid, explicit timed reading', () => {
  const values = { ...draft(), allDay: true, start: '2026-10-31', end: '2026-11-02' };
  expect(calendarCreateTimes(values, 'America/Los_Angeles')).toEqual({ start_at: Date.parse('2026-10-31T00:00:00Z'), end_at: Date.parse('2026-11-03T00:00:00Z') });
  expect(() => calendarCreateTimes({ ...values, end: '2026-10-30' }, 'America/Los_Angeles')).toThrow(/last day/);
  expect(() => calendarCreateTimes({ ...draft(), start: '2026-03-08T02:30' }, 'America/Los_Angeles')).toThrow(/daylight saving gap/);
  const repeated = { ...draft(), start: '2026-11-01T01:30', end: '2026-11-01T03:00' };
  expect(() => calendarCreateTimes(repeated, 'America/Los_Angeles')).toThrow(/repeated start/);
  expect(calendarCreateTimes({ ...repeated, startChoice: String(Date.parse('2026-11-01T09:30:00Z')) }, 'America/Los_Angeles'))
    .toEqual({ start_at: Date.parse('2026-11-01T09:30:00Z'), end_at: Date.parse('2026-11-01T11:00:00Z') });
});

it('keeps edits made during destination loading and retires a discarded form before a late list returns', async () => {
  let resolve!: (value: CalendarEventDestinations) => void;
  const { surface } = setup({ destinations: () => new Promise(done => { resolve = done; }) });
  surface.open(); surface.handleInput(input('summary', 'Keep this draft'));
  resolve(calendars);
  await vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));
  expect(surface.hasUnsavedChanges()).toBe(true);
  const resume = vi.fn(); expect(surface.beforeLeave(resume)).toBe(false);
  surface.handleAction('calendar-create-keep'); expect(resume).not.toHaveBeenCalled();
  surface.handleAction('calendar-create-reload');
  surface.handleAction('calendar-create-cancel'); surface.handleAction('calendar-create-discard');
  resolve(calendars); await Promise.resolve();
  expect(surface.isOpen()).toBe(false); expect(surface.render()).toBe('');
});

it('locks an uncertain draft and checks the original creation ID while preventing parallel saves', async () => {
  let reject!: (reason: unknown) => void;
  const create = vi.fn<(request: CalendarEventCreateRequest) => Promise<CalendarEventCreateResult>>()
    .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockImplementation(async request => result(request));
  const { surface, onCreated } = setup({ create }); surface.open();
  await vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));
  surface.handleInput(input('summary', 'Planning session'));
  surface.handleAction('calendar-create-save'); surface.handleAction('calendar-create-save');
  expect(create).toHaveBeenCalledTimes(1); expect(surface.beforeLeave(vi.fn())).toBe(false);
  reject({ code: 'timeout', message: 'Reply lost' });
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  expect(onCreated).not.toHaveBeenCalled();
  surface.handleInput(input('summary', 'Must not replace the pending request'));
  surface.handleAction('calendar-create-save');
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
  expect(create.mock.calls[1]?.[0].summary).toBe('Planning session'); expect(surface.isOpen()).toBe(false);
});

it('requires an explicit destination when the selected calendar is unavailable', async () => {
  const create = vi.fn(async (request: CalendarEventCreateRequest) => result(request));
  const { surface } = setup({ create, destinations: async () => ({ destinations: [{ slug: 'local', calendar_id: 'local',
    provider: 'local', name: 'On this server', incarnation: 'local-1' }], unavailable: [{ slug: 'work', reason: 'Needs attention' }] }) });
  surface.open();
  await vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));
  surface.handleInput(input('summary', 'Keep this on work'));
  surface.handleAction('calendar-create-save'); await Promise.resolve();
  expect(create).not.toHaveBeenCalled(); expect(surface.render()).toContain('Choose a writable calendar.');
  surface.handleInput(input('destination', JSON.stringify(['local', 'local'])), true);
  surface.handleAction('calendar-create-save');
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0]?.[0].slug).toBe('local');
});

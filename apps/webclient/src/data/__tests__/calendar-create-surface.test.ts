import { expect, it, vi } from 'vitest';
import type { CalendarEventCreateRequest, CalendarEventCreateResult, CalendarEventDestinations } from '@recued/contracts';
import { calendarCreateTimes, createCalendarCreateSurface, CALENDAR_CREATE_FIELD, type CalendarCreateDraft } from '../calendar-create-surface.js';

const calendars: CalendarEventDestinations = { destinations: [{ slug: 'work', calendar_id: 'primary', name: 'Work', provider: 'gcal', incarnation: 'calendar-1', can_invite: true }], unavailable: [] };
const draft = (): CalendarCreateDraft => ({ destination: '', summary: 'Planning', description: '', location: '',
  start: '2026-10-31T09:00', end: '2026-10-31T10:00', allDay: false, startChoice: '', endChoice: '', guests: [], guestQuery: '' });
const result = (request: CalendarEventCreateRequest): CalendarEventCreateResult => ({ slug: request.slug,
  ...(request.send_invitations ? { invitations_requested: true as const } : {}), snapshot: {
  event: { record_id: 'record-1', source_id: 'event-1', calendar_id: request.calendar_id,
    summary: request.summary, description: request.description, location: request.location, start_at: request.start_at, end_at: request.end_at,
    timezone: request.timezone, is_all_day: request.is_all_day, status: 'confirmed', is_recurring: false, updated_at: 1,
    ...(request.guests ? { attendees: request.guests.map(guest => ({ ...guest, response_status: 'needs_action' as const })) } : {}) },
  record: { record_id: 'record-1', source_id: 'event-1', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} },
  incarnation: request.expected_incarnation, resource_version: 'v1', editable: false,
} });
const input = (name: string, value: string) => ({ getAttribute: (key: string) => key === CALENDAR_CREATE_FIELD ? name : null, value }) as unknown as HTMLElement;
const setup = (callers: Parameters<typeof createCalendarCreateSurface>[0]['callers'] = {},
  searchContacts?: Parameters<typeof createCalendarCreateSurface>[0]['searchContacts']) => {
  const onCreated = vi.fn(), render = vi.fn();
  const surface = createCalendarCreateSurface({ callers: { destinations: async () => calendars, create: async request => result(request), ...callers },
    actionAttr: 'data-action', context: () => ({ day: '2026-10-31', zone: 'America/Los_Angeles', preferredSlug: 'work' }),
    now: () => Date.parse('2026-10-31T12:00:00Z'), render, onCreated, ...(searchContacts ? { searchContacts } : {}) });
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
  surface.handleInput(input('guestQuery', 'Ada@Example.com')); surface.handleAction('calendar-create-guest-add');
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
  expect(create.mock.calls[1]?.[0]).toMatchObject({ guests: [{ email: 'ada@example.com' }], send_invitations: true });
});

it('keeps the reviewed guest list when calendars or invitation permissions change and refuses unadded recipients', async () => {
  let allowed = true;
  const destinations = async (): Promise<CalendarEventDestinations> => ({ destinations: [
    { ...calendars.destinations[0]!, can_invite: allowed ? true : undefined },
    { slug: 'local', calendar_id: 'local', provider: 'local', name: 'On this server', incarnation: 'local-1' },
  ], unavailable: [] });
  const create = vi.fn(async (request: CalendarEventCreateRequest) => result(request));
  const { surface } = setup({ create, destinations }); surface.open();
  await vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));
  surface.handleInput(input('summary', 'Meeting'));
  surface.handleInput(input('guestQuery', 'ada@example.com, bob@example.com')); surface.handleAction('calendar-create-guest-add');
  expect(surface.render()).toContain('Enter one email address for each guest.');
  surface.handleInput(input('guestQuery', 'Ada@Example.com'));
  surface.handleAction('calendar-create-save'); await Promise.resolve();
  expect(create).not.toHaveBeenCalled(); expect(surface.render()).toContain('Add the guest or clear the search');
  surface.handleAction('calendar-create-guest-add');
  surface.handleInput(input('guestQuery', 'ada@example.com')); surface.handleAction('calendar-create-guest-add');
  expect(surface.render()).toContain('already on the list');
  surface.handleInput(input('guestQuery', ''));
  surface.handleInput(input('destination', JSON.stringify(['local', 'local'])), true);
  surface.handleAction('calendar-create-save'); await Promise.resolve();
  expect(create).not.toHaveBeenCalled(); expect(surface.render()).toContain('ada@example.com');
  expect(surface.render()).toContain('Choose a calendar that can send invitations');
  surface.handleInput(input('destination', JSON.stringify(['work', 'primary'])), true);
  allowed = false; surface.handleAction('calendar-create-reload');
  await vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));
  surface.handleAction('calendar-create-save'); await Promise.resolve(); expect(create).not.toHaveBeenCalled();
  allowed = true; surface.handleAction('calendar-create-reload');
  await vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));
  surface.handleAction('calendar-create-save');
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0]?.[0]).toMatchObject({ slug: 'work', guests: [{ email: 'ada@example.com' }], send_invitations: true });
});

it('ignores contact matches from an older query or a discarded form', async () => {
  const resolves: Array<(guests: Array<{ email: string; display_name?: string }>) => void> = [];
  const search = vi.fn(() => new Promise<Array<{ email: string; display_name?: string }>>(done => { resolves.push(done); }));
  const { surface } = setup({}, search); surface.open();
  await vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));
  surface.handleInput(input('guestQuery', 'Ada')); await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  surface.handleInput(input('guestQuery', 'Grace')); await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  resolves[0]!([{ email: 'ada@example.com', display_name: 'Ada' }]); await Promise.resolve();
  expect(surface.render()).not.toContain('Add Ada ·');
  resolves[1]!([{ email: 'grace@example.com', display_name: 'Grace' }]);
  await vi.waitFor(() => expect(surface.render()).toContain('Add Grace ·'));
  surface.handleAction('calendar-create-guest-pick-grace%40example.com');
  expect(surface.render()).toContain('Remove Grace');
  surface.handleInput(input('guestQuery', 'Old query')); await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(3));
  surface.handleAction('calendar-create-guest-remove-grace%40example.com');
  await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(4));
  resolves[2]!([{ email: 'superseded@example.com' }]); await Promise.resolve();
  expect(surface.render()).not.toContain('superseded@example.com');
  surface.handleAction('calendar-create-cancel'); surface.handleAction('calendar-create-discard');
  surface.open(); resolves[3]!([{ email: 'old@example.com' }]); await Promise.resolve();
  expect(surface.render()).not.toContain('old@example.com');
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

it('lets an input method confirm text without adding a guest or submitting the event', async () => {
  const create = vi.fn(async (request: CalendarEventCreateRequest) => result(request));
  const { surface } = setup({ create }); surface.open();
  await vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));
  const target = input('guestQuery', 'ada@example.com'); surface.handleInput(target);
  const preventDefault = vi.fn();
  surface.handleKeyDown({ key: 'Enter', isComposing: true, keyCode: 229, target, preventDefault } as unknown as KeyboardEvent);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(surface.render()).not.toContain('Remove ada@example.com');
  expect(create).not.toHaveBeenCalled();
  surface.handleKeyDown({ key: 'Enter', isComposing: false, keyCode: 229, target, preventDefault } as unknown as KeyboardEvent);
  expect(preventDefault).not.toHaveBeenCalled();
  surface.handleKeyDown({ key: 'Enter', isComposing: false, keyCode: 13, target, preventDefault } as unknown as KeyboardEvent);
  expect(surface.render()).toContain('Remove ada@example.com'); expect(create).not.toHaveBeenCalled();
});

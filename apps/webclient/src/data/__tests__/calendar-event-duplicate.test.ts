import { describe, expect, it, vi } from 'vitest';
import { DAY_MS, type CalendarEventSnapshot, type CalendarEventCreateRequest, type CalendarEventCreateResult } from '@recued/contracts';
import { calendarDuplicateSeed, calendarDuplicateEnd, readCalendarDuplicateOrigin } from '../calendar-event-duplicate.js';
import { calendarCreateTimes, createCalendarCreateSurface, CALENDAR_CREATE_FIELD } from '../calendar-create-surface.js';
import { createCalendarEventSurface, calendarWallClockCandidates } from '../calendar-event-surface.js';
import { createCalendarRecoveryStore } from '../calendar-draft-recovery.js';

const ref = { slug: 'work', source_id: 'original' }, id = 'cal:work:original';
const snapshot = (): CalendarEventSnapshot => ({
  event: { record_id: id, source_id: ref.source_id, calendar_id: 'primary', calendar_name: 'Work',
    summary: 'Planning', description: 'Original\r\nnotes', location: 'Room 2', timezone: 'America/New_York',
    start_at: Date.parse('2026-10-28T16:00:00Z'), end_at: Date.parse('2026-10-28T17:00:15.123Z'),
    updated_at: 1, is_all_day: false, is_recurring: true, status: 'confirmed', conference_url: 'https://meet.example.test/old',
    attendees: [{ email: 'old@example.test', response_status: 'accepted' }] },
  record: { record_id: id, source_id: ref.source_id, received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} },
  resource_version: 'v1', incarnation: 'calendar-1', editable: false,
});
const input = (name: string, value: string) => ({ getAttribute: (key: string) => key === CALENDAR_CREATE_FIELD ? name : null, value }) as unknown as HTMLElement;
const created = (request: CalendarEventCreateRequest): CalendarEventCreateResult => {
  const value = snapshot();
  return { slug: request.slug, snapshot: { ...value, incarnation: request.expected_incarnation,
    event: { ...value.event, ...request, record_id: 'cal:work:new', source_id: 'new', status: 'confirmed', is_recurring: false },
    record: { ...value.record, record_id: 'cal:work:new', source_id: 'new' } } };
};
const form = (recovery?: ReturnType<typeof createCalendarRecoveryStore>) => {
  const onCreated = vi.fn(), onCancelled = vi.fn(), create = vi.fn(async (request: CalendarEventCreateRequest) => created(request));
  const surface = createCalendarCreateSurface({ callers: { create, destinations: async () => ({ destinations: [
    { slug: 'work', calendar_id: 'primary', name: 'Work', provider: 'gcal', incarnation: 'destination-1', can_invite: true },
  ], unavailable: [] }) }, context: () => ({ day: '2026-10-31', zone: 'Asia/Tokyo' }), render: vi.fn(), actionAttr: 'data-act',
    now: () => Date.parse('2026-10-31T12:00:00Z'), recovery, onCreated, onCancelled });
  return { surface, onCreated, onCancelled, create };
};
const loaded = async (surface: ReturnType<typeof createCalendarCreateSurface>) =>
  vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));

describe('calendar duplicate data and timing', () => {
  it('copies reviewed fields without reusing guests, conference links, recurrence or provider identity', () => {
    const source = snapshot(), seed = calendarDuplicateSeed(ref, source);
    expect(seed).toMatchObject({ summary: 'Planning', description: 'Original\nnotes', location: 'Room 2', zone: 'America/New_York',
      origin: { spanMs: 3_615_123, allDay: false, keepDuration: true } });
    expect(Object.keys(seed).sort()).toEqual(['description', 'location', 'origin', 'summary', 'zone']);
    source.event.summary = 'Changed after the read'; expect(seed.summary).toBe('Planning'); expect(seed.origin.context.name).toBe('Planning');
  });

  it('preserves exact elapsed duration across a repeated hour and rejects an unchosen reading or a DST gap', () => {
    const seed = calendarDuplicateSeed(ref, snapshot());
    const draft = { destination: '', summary: seed.summary, description: seed.description, location: seed.location, start: '2030-11-03T01:30', end: '',
      allDay: false, startChoice: '', endChoice: '', guests: [], guestQuery: '' };
    expect(calendarDuplicateEnd(draft, seed.zone, seed.origin)).toBeNull();
    draft.startChoice = String(Date.parse('2030-11-03T05:30:00Z'));
    const end = calendarDuplicateEnd(draft, seed.zone, seed.origin)!;
    expect(end).toEqual({ end: '2030-11-03T01:30:15.123', endChoice: String(Date.parse('2030-11-03T06:30:15.123Z')) });
    const times = calendarCreateTimes({ ...draft, ...end }, seed.zone); expect(times.end_at - times.start_at).toBe(seed.origin.spanMs);
    expect(calendarDuplicateEnd({ ...draft, start: '2030-03-10T02:30', startChoice: '' }, seed.zone, seed.origin)).toBeNull();
  });

  it('keeps all-day copies in calendar days across DST and respects a manual end', () => {
    const value = snapshot(); Object.assign(value.event, { is_all_day: true, start_at: Date.parse('2026-10-31T00:00Z'), end_at: Date.parse('2026-11-03T00:00Z') });
    const seed = calendarDuplicateSeed(ref, value);
    const draft = { destination: '', summary: '', description: '', location: '', start: '2030-11-02', end: '',
      allDay: true, startChoice: '', endChoice: '', guests: [], guestQuery: '' };
    const end = calendarDuplicateEnd(draft, seed.zone, seed.origin)!; expect(end.end).toBe('2030-11-04');
    const times = calendarCreateTimes({ ...draft, ...end }, seed.zone); expect(times.end_at - times.start_at).toBe(3 * DAY_MS);
    expect(calendarDuplicateEnd(draft, seed.zone, { ...seed.origin, keepDuration: false })).toBeNull();
  });

  it('refuses an incomplete body, refresh failure, invalid zone and malformed time spans before creating a draft', () => {
    const partial = snapshot(); partial.event.description_truncated = true;
    expect(() => calendarDuplicateSeed(ref, partial)).toThrow('full notes');
    const stale = snapshot(); stale.refresh_error = 'Provider unavailable';
    expect(() => calendarDuplicateSeed(ref, stale)).toThrow('could not be refreshed');
    const invalid = snapshot(); invalid.event.timezone = 'Not/AZone';
    expect(() => calendarDuplicateSeed(ref, invalid)).toThrow('time zone');
    const zero = snapshot(); zero.event.end_at = zero.event.start_at;
    expect(() => calendarDuplicateSeed(ref, zero)).toThrow('time span');
    expect(readCalendarDuplicateOrigin({ ...calendarDuplicateSeed(ref, snapshot()).origin, provider_event_id: 'unreviewed' })).toBeNull();
  });

  it('reads explicit seconds and milliseconds without accepting invalid wall clocks', () => {
    expect(calendarWallClockCandidates('2026-10-31T09:00:15.1', 'America/New_York')).toEqual([Date.parse('2026-10-31T13:00:15.100Z')]);
    expect(calendarWallClockCandidates('2026-02-30T09:00:15.123', 'America/New_York')).toEqual([]);
    expect(calendarWallClockCandidates('2026-10-31T09:00:60', 'America/New_York')).toEqual([]);
  });
});

describe('duplicate source ownership', () => {
  it('rechecks fresh wording once and leaves a read-only source unchanged', async () => {
    const first = snapshot(), fresh = snapshot(); fresh.event.summary = 'Fresh planning';
    const get = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(fresh), onDuplicate = vi.fn();
    const surface = createCalendarEventSurface({ callers: { get }, onDuplicate, actionAttr: 'data-act', render: vi.fn(), onSaved: vi.fn() });
    await surface.open(ref, id); expect(surface.render()).toContain('Duplicate event');
    surface.handleAction('calendar-event-duplicate'); surface.handleAction('calendar-event-duplicate');
    await vi.waitFor(() => expect(onDuplicate).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledTimes(2); expect(onDuplicate.mock.calls[0]![1].event.summary).toBe('Fresh planning');
    const current = onDuplicate.mock.calls[0]![2]; expect(current()).toBe(true); surface.reset(); expect(current()).toBe(false);
    expect(first.event.summary).toBe('Planning'); surface.dispose();
  });

  it('keeps an existing creation draft without making a new source read', async () => {
    const get = vi.fn(async () => snapshot()), existing = vi.fn(() => true), onDuplicate = vi.fn();
    const surface = createCalendarEventSurface({ callers: { get }, onDuplicate, onExistingDuplicate: existing,
      actionAttr: 'data-act', render: vi.fn(), onSaved: vi.fn() });
    await surface.open(ref, id); surface.handleAction('calendar-event-duplicate');
    expect(existing).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(onDuplicate).not.toHaveBeenCalled(); surface.dispose();
  });

  it('retires a delayed source check when navigation or disposal changes the owner', async () => {
    for (const dispose of [false, true]) {
      let release!: (value: CalendarEventSnapshot) => void;
      const onDuplicate = vi.fn(), render = vi.fn(), get = vi.fn().mockResolvedValueOnce(snapshot()).mockImplementation(() => new Promise(done => { release = done; }));
      const surface = createCalendarEventSurface({ callers: { get }, onDuplicate, actionAttr: 'data-act', render, onSaved: vi.fn() });
      await surface.open(ref, id); surface.handleAction('calendar-event-duplicate');
      if (dispose) surface.dispose(); else surface.reset();
      const paints = render.mock.calls.length; release(snapshot()); await Promise.resolve(); await Promise.resolve();
      expect(onDuplicate).not.toHaveBeenCalled(); expect(render).toHaveBeenCalledTimes(paints); surface.dispose();
    }
  });

  it('refuses a source identity change and permits retry after a failed source read', async () => {
    const changed = snapshot(); changed.incarnation = 'replacement-calendar';
    const get = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(changed).mockRejectedValueOnce(new Error('Read interrupted')).mockResolvedValue(snapshot());
    const onDuplicate = vi.fn(), surface = createCalendarEventSurface({ callers: { get }, onDuplicate, actionAttr: 'data-act', render: vi.fn(), onSaved: vi.fn() });
    await surface.open(ref, id); surface.handleAction('calendar-event-duplicate');
    await vi.waitFor(() => expect(surface.render()).toContain('identity changed')); expect(onDuplicate).not.toHaveBeenCalled();
    surface.handleAction('calendar-event-duplicate'); await vi.waitFor(() => expect(surface.render()).toContain('Read interrupted'));
    surface.handleAction('calendar-event-duplicate'); await vi.waitFor(() => expect(onDuplicate).toHaveBeenCalledTimes(1)); surface.dispose();
  });
});

describe('duplicate creation drafts', () => {
  it('prefills a new draft with empty guests and dates, auto-shifts its end, and stops shifting after an end edit', async () => {
    const seed = calendarDuplicateSeed(ref, snapshot()), { surface, create, onCreated } = form();
    expect(surface.open(seed)).toBe(true); await loaded(surface); expect(create).not.toHaveBeenCalled();
    expect(surface.render()).toContain('Original duration: 1 hour 15.123 seconds'); expect(surface.render()).not.toContain('old@example.test');
    surface.handleInput(input('start', '2026-11-02T09:00'));
    expect(surface.render()).toContain('2026-11-02T10:00:15.123');
    surface.handleInput(input('end', '2026-11-02T10:30')); surface.handleInput(input('start', '2026-11-02T09:15'));
    surface.handleAction('calendar-create-save'); await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ summary: 'Planning', description: 'Original\nnotes', timezone: 'America/New_York',
      start_at: Date.parse('2026-11-02T14:15:00Z'), end_at: Date.parse('2026-11-02T15:30:00Z') });
    expect(create.mock.calls[0]![0].guests).toBeUndefined(); expect(create.mock.calls[0]![0].send_invitations).toBeUndefined();
    expect(onCreated.mock.calls[0]![1]).toMatchObject({ context: { recordId: id }, keepDuration: false }); surface.dispose();
  });

  it('keeps an existing ordinary draft instead of replacing it with copied details', async () => {
    const { surface } = form(); surface.open(); await loaded(surface); surface.handleInput(input('summary', 'Keep my draft'));
    expect(surface.open(calendarDuplicateSeed(ref, snapshot()))).toBe(false);
    expect(surface.render()).toContain('Keep my draft'); expect(surface.render()).not.toContain('Copy of'); surface.dispose();
  });

  it('recovers an untouched copy with its source, zone and automatic duration, then cancels back to that source', async () => {
    const rows = new Map<string, string>(), now = () => Date.parse('2026-10-31T12:00:00Z');
    const recovery = createCalendarRecoveryStore({ scope: 'duplicate', now, storage: { getItem: key => rows.get(key) ?? null,
      setItem: (key, value) => { rows.set(key, value); }, removeItem: key => { rows.delete(key); } } });
    const first = form(recovery).surface; first.open(calendarDuplicateSeed(ref, snapshot())); await loaded(first); first.flush();
    expect(recovery.list()).toHaveLength(1); expect(recovery.list()[0]!.values.duplicate?.context.recordId).toBe(id); first.dispose();
    const { surface, onCancelled } = form(recovery);
    surface.handleAction('calendar-create-recovery-resume', { getAttribute: () => recovery.list()[0]!.id } as unknown as HTMLElement); await loaded(surface);
    surface.handleInput(input('start', '2026-11-02T09:00')); expect(surface.render()).toContain('2026-11-02T10:00:15.123');
    surface.handleAction('calendar-create-cancel'); expect(onCancelled).not.toHaveBeenCalled();
    surface.handleAction('calendar-create-discard'); expect(onCancelled).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ recordId: id }) }));
    expect(recovery.list()).toEqual([]); surface.dispose();
  });
});

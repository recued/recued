/** D-407 slice 4a.2 (§4.1, Q3, Q4) — an occasion's own calendar event, bonded to it by a link Recued keeps: written
 *  into the calendar chosen once, moved, renamed, marked and alerted with the occasion, removed with it; the marking
 *  read back; the alert sent from one place only. Through the real occasion store and clock service, with a recording
 *  writer in place of the owner's calendar create, edit and delete (their provider writes are slice 4a.1's tests). */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarEventPatch, OccasionCalendarChoice, OccasionInput } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createCalendarCollection, type CalendarCollection } from '../collections/calendar/calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../collections/calendar/local-provider.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createCalendarEventCreationStore } from '../storage/calendar-event-creations.js';
import { createOccasionCalendarSync, occasionEventFields, OCCASION_EVENT_NOTE, ownerCalendarWriter, type OccasionEventFields,
  type StoredEvent } from '../situations/occasion-calendar-sync.js';
import { createOccasionClockService, type OccasionAlertMessage } from '../situations/occasion-clock-service.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const DAY = '2026-11-21';
const at = (clock: string, day = DAY): number => Date.parse(`${day}T${clock}:00Z`);
const personal: OccasionCalendarChoice = { slug: 'outlook-me', calendar_id: 'cal-personal', name: 'Personal' };
const lee = (patch: Partial<OccasionInput> = {}): OccasionInput => ({ title: 'Dr. Lee', month_day: '12-12', source_next_on: '2026-12-12', people: [],
  muted: false, rules: [], private: true, time: '10:30', time_zone: 'UTC', alert_minutes: 120, in_calendar: true, ...patch });

type Call = { op: 'create'; fields: OccasionEventFields; creation_id: string; slug: string } | { op: 'update'; source_id: string; patch: CalendarEventPatch } | { op: 'remove'; source_id: string };
const world = (options: { choice?: OccasionCalendarChoice | null; keepsPrivate?: boolean; fail?: () => boolean } = {}) => {
  const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  let current = at('07:00'); let choice: OccasionCalendarChoice | null = options.choice === undefined ? personal : options.choice;
  const calls: Call[] = []; let made = 0; const dropped: OccasionCalendarChoice[] = [];
  // Each event's private marking as the calendar keeps it: an edit that does not touch it leaves it.
  const marked = new Map<string, boolean>();
  const keeps = (value: boolean): boolean => options.keepsPrivate !== false && value;
  // D-407 slice 4b — the calendar as the owner's phone has it, and the rows Recued's copy of it has lost.
  const phone = new Map<string, StoredEvent>(); const hidden = new Set<string>(); const asked: string[] = [];
  const sync = createOccasionCalendarSync({ db, timeZone: () => 'UTC', now: () => current, choice: () => choice,
    dropsPrivate: (value) => { dropped.push(value); choice = { ...value, keeps_private: false }; },
    save: (input) => history.saveOccasion(input, current),
    writer: {
      async create(value, creation_id, fields) {
        if (options.fail?.()) throw new Error('Outlook said 503');
        calls.push({ op: 'create', fields, creation_id, slug: value.slug }); made += 1;
        marked.set(`event-${String(made)}`, keeps(fields.marked_private));
        phone.set(`event-${String(made)}`, { start_at: fields.start_at, end_at: fields.end_at, is_all_day: fields.is_all_day, timezone: fields.timezone, status: 'confirmed' });
        return { source_id: `event-${String(made)}`, marked_private: marked.get(`event-${String(made)}`)! };
      },
      async update(_slug, source_id, patch) {
        calls.push({ op: 'update', source_id, patch });
        if (patch.marked_private !== undefined) marked.set(source_id, keeps(patch.marked_private));
        const event = phone.get(source_id)!;
        phone.set(source_id, { ...event, ...(patch.start_at !== undefined ? { start_at: patch.start_at } : {}), ...(patch.end_at !== undefined ? { end_at: patch.end_at } : {}) });
        return { marked_private: marked.get(source_id) === true };
      },
      async remove(_slug, source_id) { calls.push({ op: 'remove', source_id }); phone.delete(source_id); },
      stored: (_slug, source_id) => hidden.has(source_id) ? undefined : phone.get(source_id),
      async gone(_slug, _calendar, source_id) { asked.push(source_id); return !phone.has(source_id); },
    } });
  const sent: OccasionAlertMessage[] = [];
  const clock = createOccasionClockService({ db, work, dispatchers: createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work) }),
    timeZone: () => 'UTC', now: () => current, calendarSync: sync, sendAlert: async (message) => { sent.push(message); return { delivered_to: ['in_app'] }; } });
  /** The owner in the phone: moves an event (a whole day starts at its day's UTC midnight), or deletes it. */
  const phoneDoes = {
    move: (id: string, start_at: number, end_at: number, is_all_day = false) => { phone.set(id, { ...phone.get(id)!, start_at, end_at, is_all_day }); },
    delete: (id: string) => { phone.delete(id); },
    hide: (id: string) => { hidden.add(id); },
  };
  /** The event made for a title. */
  const eventOf = (title: string): string =>
    `event-${String(calls.filter(call => call.op === 'create').findIndex(call => call.fields.summary === title) + 1)}`;
  return { history, sync, calls, dropped, sent, phone: phoneDoes, asked, eventOf, choose: (value: OccasionCalendarChoice | null) => { choice = value; },
    time: (clockTime: string, day = DAY) => { current = at(clockTime, day); return clock.tick(); } };
};

describe('D-407 slice 4 — an occasion writes its own event', () => {
  it('none until a calendar is chosen, and only for one ticked In my calendar', async () => {
    const f = world({ choice: null });
    f.history.saveOccasion(lee(), at('06:00')); f.history.saveOccasion(lee({ title: 'Haircut', in_calendar: false }), at('06:00'));
    await f.time('07:00'); expect(f.calls).toEqual([]);
    f.choose(personal); await f.time('07:01');
    expect(f.calls).toEqual([{ op: 'create', slug: 'outlook-me', creation_id: expect.stringMatching(/^[0-9a-f-]{36}$/u), fields: {
      summary: 'Dr. Lee', description: OCCASION_EVENT_NOTE, location: '', start_at: at('10:30', '2026-12-12'), end_at: at('11:30', '2026-12-12'),
      timezone: 'UTC', is_all_day: false, marked_private: true, alert_minutes: 120 } }]);
    await f.time('07:02'); expect(f.calls).toHaveLength(1);
  });

  it('another calendar chosen moves each event there; none chosen removes them; each card names the calendar it is in', async () => {
    const f = world();
    const occasion = f.history.saveOccasion(lee(), at('06:00'));
    await f.time('07:00'); expect(f.sync.events()).toEqual({ [occasion.id]: { name: 'Personal' } });
    const family: OccasionCalendarChoice = { slug: 'outlook-me', calendar_id: 'cal-family', name: 'Family' };
    f.choose(family);
    // Chosen, not yet moved: the event is still in Personal, and the card says so.
    expect(f.sync.events()).toEqual({ [occasion.id]: { name: 'Personal' } });
    await f.time('07:01');
    expect(f.calls.slice(1).map((call) => call.op)).toEqual(['remove', 'create']);
    expect(f.sync.events()).toEqual({ [occasion.id]: { name: 'Family' } });
    f.choose(null); await f.time('07:02');
    expect(f.calls.slice(3)).toEqual([{ op: 'remove', source_id: 'event-2' }]);
    expect(f.sync.events()).toEqual({});
  });

  it('a change is an edit of the same event, of what changed only; a date moved before it comes moves it; a time gained makes it again', async () => {
    const f = world();
    const occasion = f.history.saveOccasion(lee(), at('06:00')); await f.time('07:00');
    f.history.saveOccasion({ ...occasion, title: 'Dr. Lee, check-up', source_next_on: '2026-12-14', month_day: '12-14' }, at('07:30')); await f.time('08:00');
    // Never the unchanged note: Outlook keeps notes as HTML and refuses an edit that carries them (live 2026-11-21).
    expect(f.calls[1]).toEqual({ op: 'update', source_id: 'event-1', patch: { summary: 'Dr. Lee, check-up',
      start_at: at('10:30', '2026-12-14'), end_at: at('11:30', '2026-12-14') } });
    const day = f.history.saveOccasion(lee({ title: 'Clinic', time: undefined, time_zone: undefined, alert_minutes: undefined }), at('08:00')); await f.time('08:01');
    f.history.saveOccasion({ ...day, time: '09:00', time_zone: 'UTC' }, at('08:02')); await f.time('08:03');
    expect(f.calls.slice(2).map(call => call.op)).toEqual(['create', 'remove', 'create']);
    expect(f.calls[4]).toMatchObject({ fields: { is_all_day: false, start_at: at('09:00', '2026-12-12') } });
  });

  it('a calendar that drops the private marking loses that event, and gets no private occasion again', async () => {
    const f = world({ keepsPrivate: false });
    f.history.saveOccasion(lee(), at('06:00')); await f.time('07:00');
    expect(f.calls.map(call => call.op)).toEqual(['create', 'remove']);
    expect(f.dropped).toEqual([personal]);
    await f.time('07:01'); expect(f.calls).toHaveLength(2);
    f.history.saveOccasion(lee({ title: 'Reunion', private: false }), at('07:02')); await f.time('07:03');
    expect(f.calls[2]).toMatchObject({ op: 'create', fields: { summary: 'Reunion', marked_private: false } });
  });

  it('unticked or deleted, its future event goes; a past one stays; a yearly one\'s next year gets its own', async () => {
    const f = world();
    const one = f.history.saveOccasion(lee(), at('06:00')); const two = f.history.saveOccasion(lee({ title: 'Physio' }), at('06:00'));
    const yearly = f.history.saveOccasion(lee({ title: 'Anniversary dinner', source_next_on: undefined, month_day: '11-22', private: false }), at('06:00'));
    await f.time('07:00');
    f.history.saveOccasion({ ...one, in_calendar: false }, at('07:30')); f.history.deleteOccasion(two.id); await f.time('08:00');
    // Events are numbered in the order occasions are walked (by id): read each one's by its title.
    const eventOf = (title: string): string => `event-${String(f.calls.filter(call => call.op === 'create').findIndex(call => call.fields.summary === title) + 1)}`;
    expect(f.calls.filter(call => call.op === 'remove').map(call => (call as { source_id: string }).source_id).sort())
      .toEqual([eventOf('Dr. Lee'), eventOf('Physio')].sort());
    // The dinner is tomorrow: after it, next year's gets an event of its own and this year's stays.
    await f.time('09:00', '2026-11-23');
    const last = f.calls.at(-1)!;
    expect(last).toMatchObject({ op: 'create', fields: { summary: 'Anniversary dinner', start_at: at('10:30', '2027-11-22') } });
    expect(f.calls.filter(call => call.op === 'remove')).toHaveLength(2);
    void yearly;
  });

  it('a failed write is tried again after five minutes, not every minute; it says why meanwhile; a change is tried at once', async () => {
    let failing = true;
    const f = world({ fail: () => failing });
    const occasion = f.history.saveOccasion(lee(), at('06:00'));
    await f.time('07:00'); await f.time('07:01');
    expect(f.sync.events()).toEqual({ [occasion.id]: { name: 'Personal', error: 'Outlook said 503' } });
    failing = false; await f.time('07:02'); expect(f.calls).toEqual([]);
    await f.time('07:06'); expect(f.calls.map(call => call.op)).toEqual(['create']);
    expect(f.sync.events()).toEqual({ [occasion.id]: { name: 'Personal' } });
    // The owner changes another one just after its write failed: the change is not held behind the failure.
    failing = true; const other = f.history.saveOccasion(lee({ title: 'Physio' }), at('07:07')); await f.time('07:07');
    failing = false; f.history.saveOccasion({ ...f.history.occasion(other.id)!, title: 'Physio, knee' }, at('07:08')); await f.time('07:08');
    expect(f.calls.at(-1)).toMatchObject({ op: 'create', fields: { summary: 'Physio, knee' } });
  });

  it('the alert comes from one place: the event when it carries it, else Recued', async () => {
    const f = world();
    f.history.saveOccasion(lee({ source_next_on: DAY, month_day: '11-21', private: false }), at('06:00'));
    f.history.saveOccasion(lee({ title: 'Recued only', source_next_on: DAY, month_day: '11-21', private: false, in_calendar: false }), at('06:00'));
    await f.time('07:00'); await f.time('08:30');
    expect(f.sent.map(message => message.text)).toEqual(['Recued only, today at 10:30']);
    const muted = f.history.saveOccasion(lee({ title: 'Muted', muted: true }), at('08:31')); await f.time('08:32');
    expect(f.calls.find(call => call.op === 'create' && call.fields.summary === 'Muted')).toMatchObject({ fields: { alert_minutes: null } });
    void muted;
  });
});

describe('D-407 slice 4 — the writer is the owner\'s own Calendar write', () => {
  it('on a real calendar: written with its marking and alert, the same create once, edited, read as stored, then removed and gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd407-occasion-event-')); const db = new Database(':memory:');
    const instances = createInstanceStore({ db });
    instances.upsert({ platform: 'calendar', slug: 'local', adapter_type: 'local', config: {}, caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
    let collection!: CalendarCollection;
    const provider = createLocalCalendarProvider({ slug: 'local', now: () => at('07:00'), readEvent: id => collection.table.get(id)?.event ?? null });
    collection = createCalendarCollection({ db, slug: 'local', provider, bus: createWarehouseEventBus(), blobs: createBlobStore(join(dir, 'blobs')),
      gate: createStorageGate({ quota: 1024 * 1024, reservePct: 10, surface: 'collection:calendar:local' }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024, expansion_past_days: 30, expansion_future_days: 90 }) });
    cleanups.push(() => { void collection.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const writer = ownerCalendarWriter({ calendar: { instances, getCollection: (slug: string) => slug === 'local' ? collection : undefined, now: () => at('07:00') },
      creations: createCalendarEventCreationStore(db) });
    const choice: OccasionCalendarChoice = { slug: 'local', calendar_id: 'local', name: 'Recued' };
    const fields = occasionEventFields({ ...lee(), id: 'occ-1', created_at: 1, updated_at: 1 }, '2026-12-12', 'UTC');
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const made = await writer.create(choice, id, fields);
    expect(made.marked_private).toBe(true);
    expect(collection.table.get(made.source_id)?.event).toMatchObject({ summary: 'Dr. Lee', marked_private: true, reminders: [{ method: 'popup', minutes: 120 }],
      start_at: at('10:30', '2026-12-12'), end_at: at('11:30', '2026-12-12') });
    // A lost answer retried: the same event, not a second one.
    expect((await writer.create(choice, id, fields)).source_id).toBe(made.source_id);
    expect(await writer.update('local', made.source_id, { summary: 'Dr. Lee, again', marked_private: false, alert_minutes: null })).toEqual({ marked_private: false });
    const edited = collection.table.get(made.source_id)!.event;
    expect(edited.summary).toBe('Dr. Lee, again'); expect(edited.marked_private).toBeUndefined(); expect(edited.reminders).toBeUndefined();
    // D-407 slice 4b — its when as the calendar holds it, and whether it is gone, which a local calendar's own copy says.
    expect(writer.stored('local', made.source_id)).toEqual({ start_at: at('10:30', '2026-12-12'), end_at: at('11:30', '2026-12-12'), is_all_day: false,
      timezone: 'UTC', status: 'confirmed' });
    expect(await writer.gone('local', 'local', made.source_id)).toBe(false);
    await writer.remove('local', made.source_id);
    expect(writer.stored('local', made.source_id)).toBeUndefined();
    expect(await writer.gone('local', 'local', made.source_id)).toBe(true);
    expect(collection.table.get(made.source_id)).toBeNull();
    await writer.remove('local', made.source_id);
  });
});

describe('D-407 slice 4b — the event is the truth for when: moved in the phone, the occasion follows', () => {
  it('its date and time follow, and nothing is written back; a rename in Recued then sends only the rename', async () => {
    const f = world();
    const occasion = f.history.saveOccasion(lee(), at('06:00')); await f.time('07:00');
    // Moved, and made longer: the occasion takes the new when; the length stays the phone's.
    f.phone.move('event-1', at('11:00', '2026-12-14'), at('12:30', '2026-12-14'));
    await f.time('07:01');
    expect(f.history.occasion(occasion.id)).toMatchObject({ source_next_on: '2026-12-14', month_day: '12-14', time: '11:00', time_zone: 'UTC', alert_minutes: 120 });
    expect(f.calls).toHaveLength(1);
    await f.time('07:02'); expect(f.calls).toHaveLength(1);
    f.history.saveOccasion({ ...f.history.occasion(occasion.id)!, title: 'Dr. Lee, check-up' }, at('07:03')); await f.time('07:03');
    expect(f.calls[1]).toEqual({ op: 'update', source_id: 'event-1', patch: { summary: 'Dr. Lee, check-up' } });
  });

  it('moved there and changed here, Recued\'s own change wins and moves the event back', async () => {
    const f = world();
    const occasion = f.history.saveOccasion(lee(), at('06:00')); await f.time('07:00');
    f.phone.move('event-1', at('11:00', '2026-12-14'), at('12:00', '2026-12-14'));
    f.history.saveOccasion({ ...occasion, time: '09:00' }, at('07:00')); await f.time('07:01');
    expect(f.history.occasion(occasion.id)).toMatchObject({ source_next_on: '2026-12-12', time: '09:00' });
    expect(f.calls[1]).toEqual({ op: 'update', source_id: 'event-1', patch: { start_at: at('09:00', '2026-12-12'), end_at: at('10:00', '2026-12-12') } });
  });

  it('made a whole day in the phone, it loses its time and alert; a yearly one moves its yearly date', async () => {
    const f = world();
    const occasion = f.history.saveOccasion(lee(), at('06:00'));
    const yearly = f.history.saveOccasion(lee({ title: 'Reunion', source_next_on: undefined, month_day: '12-20', time: undefined, time_zone: undefined,
      alert_minutes: undefined, private: false }), at('06:00'));
    await f.time('07:00');
    const doctor = f.eventOf('Dr. Lee'); const reunion = f.eventOf('Reunion');
    f.phone.move(doctor, Date.parse('2026-12-13T00:00:00Z'), Date.parse('2026-12-14T00:00:00Z'), true);
    f.phone.move(reunion, Date.parse('2026-12-21T00:00:00Z'), Date.parse('2026-12-22T00:00:00Z'), true);
    await f.time('07:01');
    const moved = f.history.occasion(occasion.id)!;
    expect(moved).toMatchObject({ source_next_on: '2026-12-13', month_day: '12-13' });
    expect(moved.time).toBeUndefined(); expect(moved.alert_minutes).toBeUndefined();
    expect(f.history.occasion(yearly.id)).toMatchObject({ month_day: '12-21' });
    expect(f.history.occasion(yearly.id)!.source_next_on).toBeUndefined();
    // Only the alert it no longer has goes back to its event.
    expect(f.calls.filter(call => call.op !== 'create')).toEqual([{ op: 'update', source_id: doctor, patch: { alert_minutes: null } }]);
  });

  it('moved into the past, the occasion has happened and its event stays', async () => {
    const f = world();
    const occasion = f.history.saveOccasion(lee(), at('06:00')); await f.time('07:00');
    f.phone.move('event-1', at('10:30', '2026-11-20'), at('11:30', '2026-11-20'));
    await f.time('07:01');
    expect(f.history.occasion(occasion.id)).toMatchObject({ source_next_on: '2026-11-20' });
    expect(f.calls.map(call => call.op)).toEqual(['create']);
    expect(f.sync.events()).toEqual({});
  });

  it('deleted in the phone, as its calendar says, it goes on in Recued only; missing only from Recued\'s copy, nothing changes', async () => {
    const f = world();
    const occasion = f.history.saveOccasion(lee(), at('06:00')); const other = f.history.saveOccasion(lee({ title: 'Physio' }), at('06:00'));
    await f.time('07:00');
    const doctor = f.eventOf('Dr. Lee'); const physio = f.eventOf('Physio');
    f.phone.delete(doctor); f.phone.hide(physio);
    await f.time('07:01');
    expect(f.history.occasion(occasion.id)!.in_calendar).toBe(false);
    expect(f.history.occasion(other.id)!.in_calendar).toBe(true);
    expect([...f.asked].sort()).toEqual([doctor, physio].sort());
    expect(f.sync.events()).toEqual({ [other.id]: { name: 'Personal' } });
    await f.time('07:02'); expect(f.calls.map(call => call.op)).toEqual(['create', 'create']);
  });
});

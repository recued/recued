/** D-407 slice 5 (§4.1, Q4, Q5) — the *Occasion* tick, from the calendar side: an event already in the owner's calendar
 *  (a clinic's emailed invite) is wrapped by a new occasion, or made the next one of an occasion waiting for its date,
 *  the one matching its organizer or place offered first. The occasion follows the event, and the event is never
 *  written: a recording writer stands in for the owner's calendar and must see nothing. The booking the same invite made
 *  joins the occasion by the invite's iCal UID. Through the real occasion store, bond and adoption. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarEventPatch, CanonicalEvent, ExecutionSource, OccasionCalendarChoice, OccasionInput } from '@recued/contracts';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createCalendarCollection, type CalendarCollection } from '../collections/calendar/calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../collections/calendar/local-provider.js';
import { makeCollectionHandlers } from '../collections/collection-handler.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

import { createOccasionCalendarSync, occasionEventFields, occasionOwningEvent, occasionOwningInvite, openBookingsByInvite,
  type OccasionEventFields, type StoredEvent } from '../situations/occasion-calendar-sync.js';
import { createOccasionEventAdoption } from '../situations/occasion-event-adoption.js';
import { canonicalizeGraphEvent } from '../collections/calendar/graph-provider.js';
import { exchangeIdWrapping } from './helpers/exchange-meeting-id.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const DAY = '2026-11-21';
const at = (clock: string, day = DAY): number => Date.parse(`${day}T${clock}:00Z`);
const personal: OccasionCalendarChoice = { slug: 'outlook-me', calendar_id: 'cal-personal', name: 'Personal' };
const SLUG = 'outlook-me';

/** A clinic's invite on 12 December at 10:30, as Recued's copy of the owner's calendar holds it. */
const invite = (patch: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  source_id: 'invite-1', ical_uid: 'uid-clinic-1', calendar_id: 'cal-work', calendar_name: 'Work', summary: 'Dr. Lee follow-up',
  location: 'State Hospital', start_at: at('10:30', '2026-12-12'), end_at: at('11:00', '2026-12-12'), timezone: 'UTC', is_all_day: false,
  organizer: { email: 'clinic@hospital.example', display_name: 'State Hospital' },
  attendees: [{ email: 'me@example.com', is_self: true, response_status: 'accepted' }],
  status: 'confirmed', created_at: at('06:00'), updated_at: at('06:00'), ...patch,
}) as CanonicalEvent;
/** An occasion that comes back whenever the last one says, its last visit past: waiting for its next date. */
const waiting = (patch: Partial<OccasionInput> = {}): OccasionInput => ({ title: 'Dr. Lee', month_day: '06-12', source_next_on: '2026-06-12',
  after_each: true, people: [], muted: false, rules: [], private: true, ...patch });

type Call = { op: 'create' | 'update' | 'remove'; source_id?: string; patch?: CalendarEventPatch; fields?: OccasionEventFields };
const world = () => {
  const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  let current = at('07:00');
  const events = new Map<string, CanonicalEvent>([['invite-1', invite()]]);
  const calls: Call[] = []; const asked: string[] = [];
  const stored = (source_id: string): StoredEvent | undefined => {
    const event = events.get(source_id);
    return event === undefined ? undefined
      : { start_at: event.start_at, end_at: event.end_at, is_all_day: event.is_all_day, timezone: event.timezone, status: event.status };
  };
  let made = 0;
  const sync = createOccasionCalendarSync({ db, timeZone: () => 'UTC', now: () => current, choice: () => personal, dropsPrivate: () => {},
    save: (input) => history.saveOccasion(input, current),
    writer: {
      async create(_choice, _creation_id, fields) {
        calls.push({ op: 'create', fields }); made += 1; const source_id = `own-${String(made)}`;
        events.set(source_id, invite({ source_id, ical_uid: `own-uid-${String(made)}`, calendar_id: 'cal-personal', summary: fields.summary,
          start_at: fields.start_at, end_at: fields.end_at, organizer: undefined, attendees: [] }));
        return { source_id, marked_private: fields.marked_private };
      },
      async update(_slug, source_id, patch) { calls.push({ op: 'update', source_id, patch }); return { marked_private: true }; },
      async remove(_slug, source_id) { calls.push({ op: 'remove', source_id }); events.delete(source_id); },
      stored: (_slug, source_id) => stored(source_id),
      async gone(_slug, _calendar, source_id) { asked.push(source_id); return !events.has(source_id); },
    } });
  const adoption = createOccasionEventAdoption({ db, history, timeZone: () => 'UTC', now: () => current,
    event: (slug, source_id) => { const event = slug === SLUG ? events.get(source_id) : undefined; return event ? { event, calendar_name: event.calendar_name ?? slug } : undefined; },
    contactId: (email) => (email === 'dr.lee@clinic.example' ? 'contact-lee' : undefined) });
  const tick = async (): Promise<void> => { await sync.sync(history.occasions(1000), DAY); };
  /** The owner in their calendar app: moves the invite, or deletes it. */
  const calendar = {
    move: (start_at: number) => { const event = events.get('invite-1')!; events.set('invite-1', { ...event, start_at, end_at: start_at + 1_800_000 }); },
    delete: (source_id = 'invite-1') => { events.delete(source_id); },
  };
  return { db, history, sync, adoption, events, calls, asked, tick, calendar, now: (value: number) => { current = value; } };
};

describe('D-407 slice 5 — ticking Occasion on an event in the calendar', () => {
  it('wraps a new occasion around it: its title, date and time, place and organizer, Private to start; the event never written', async () => {
    const f = world();
    // Nothing waits for its next date: the tick asks nothing.
    expect(f.adoption.block(SLUG, 'invite-1')).toEqual({ waiting: [] });
    const occasion = f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true });
    expect(occasion).toMatchObject({ title: 'Dr. Lee follow-up', month_day: '12-12', source_next_on: '2026-12-12', time: '10:30', time_zone: 'UTC',
      people: ['clinic@hospital.example'], where: { name: 'State Hospital' }, private: true, muted: false });
    expect(occasion.in_calendar).toBeUndefined();
    await f.tick(); await f.tick();
    expect(f.calls).toEqual([]);
    expect(f.adoption.block(SLUG, 'invite-1')).toEqual({ owner: { occasion_id: occasion.id, title: 'Dr. Lee follow-up', private: true }, waiting: [] });
    expect(occasionOwningEvent(f.db)(SLUG, 'invite-1')).toBe(occasion.id);
    // Its own alert, never the event's: the occasion sends it.
    expect(f.sync.carriesAlert(f.history.occasion(occasion.id)!, '2026-12-12')).toBe(false);
  });

  it('the occasion follows the event moved in the calendar, and never moves it back', async () => {
    const f = world();
    const occasion = f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true });
    f.calendar.move(at('14:00', '2026-12-15'));
    await f.tick();
    expect(f.history.occasion(occasion.id)).toMatchObject({ source_next_on: '2026-12-15', month_day: '12-15', time: '14:00' });
    await f.tick();
    expect(f.calls).toEqual([]);
    expect(occasionOwningEvent(f.db)(SLUG, 'invite-1')).toBe(occasion.id);
  });

  it('is let go, never removed, when the occasion is dated otherwise in Recued, deleted, or the event is gone', async () => {
    const dated = world();
    const one = dated.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true });
    const { created_at: _c, updated_at: _u, ...input } = dated.history.occasion(one.id)!;
    dated.history.saveOccasion({ ...input, source_next_on: '2026-12-20', month_day: '12-20' }, at('07:00'));
    await dated.tick();
    expect(occasionOwningEvent(dated.db)(SLUG, 'invite-1')).toBeUndefined();
    expect(dated.events.has('invite-1')).toBe(true);
    // Let go, it is not written as the occasion's own either: that takes In my calendar.
    expect(dated.calls).toEqual([]);

    const deleted = world();
    const two = deleted.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true });
    deleted.history.deleteOccasion(two.id);
    await deleted.tick();
    expect(occasionOwningEvent(deleted.db)(SLUG, 'invite-1')).toBeUndefined();
    expect(deleted.calls).toEqual([]); expect(deleted.events.has('invite-1')).toBe(true);

    const gone = world();
    const three = gone.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true });
    gone.calendar.delete();
    await gone.tick();
    expect(gone.asked).toEqual(['invite-1']);
    expect(occasionOwningEvent(gone.db)(SLUG, 'invite-1')).toBeUndefined();
    expect(gone.history.occasion(three.id)).toMatchObject({ source_next_on: '2026-12-12' });
    expect(gone.calls).toEqual([]);
  });

  it('asks which waiting occasion it is, the one matching the organizer or the place first, and adopts it as its next one', async () => {
    const f = world();
    const dentist = f.history.saveOccasion(waiting({ title: 'A dentist' }), at('06:00'));
    const lee = f.history.saveOccasion(waiting({ title: 'Dr. Lee', people: ['clinic@hospital.example'], time: '09:00', time_zone: 'UTC', alert_minutes: 60 }), at('06:00'));
    const physio = f.history.saveOccasion(waiting({ title: 'Physio', where: f.history.place('state hospital') }), at('06:00'));
    expect(f.adoption.block(SLUG, 'invite-1')).toEqual({ waiting: [
      { occasion_id: lee.id, title: 'Dr. Lee', private: true, match: true },
      { occasion_id: physio.id, title: 'Physio', private: true, match: true },
      { occasion_id: dentist.id, title: 'A dentist', private: true },
    ] });
    // Only one waiting for its next date: a yearly occasion is not asked about, nor adopted into.
    const yearly = f.history.saveOccasion(waiting({ title: 'Birthday', after_each: undefined, source_next_on: undefined }), at('06:00'));
    expect(() => f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', occasion_id: yearly.id, private: true })).toThrow(/Birthday is not waiting for its next date/);
    const adopted = f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', occasion_id: lee.id, private: true });
    expect(adopted).toMatchObject({ id: lee.id, after_each: true, source_next_on: '2026-12-12', month_day: '12-12', time: '10:30', alert_minutes: 60 });
    await f.tick(); expect(f.calls).toEqual([]);
    // Let go: it waits for its next date again, as it was.
    expect(f.adoption.release({ slug: SLUG, source_id: 'invite-1' })).toBe('waiting');
    expect(f.history.occasion(lee.id)).toMatchObject({ source_next_on: '2026-06-12', month_day: '06-12', time: '09:00', alert_minutes: 60 });
    expect(occasionOwningEvent(f.db)(SLUG, 'invite-1')).toBeUndefined();
    expect(f.events.has('invite-1')).toBe(true);
  });

  it('a contact who is the organizer is matched by the contact', () => {
    const f = world();
    f.events.set('invite-1', invite({ organizer: { email: 'dr.lee@clinic.example' }, location: '' }));
    const lee = f.history.saveOccasion(waiting({ people: ['contact-lee'] }), at('06:00'));
    expect(f.adoption.block(SLUG, 'invite-1')?.waiting).toEqual([{ occasion_id: lee.id, title: 'Dr. Lee', private: true, match: true }]);
    // A new occasion names the organizer by the contact.
    expect(f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: false }).people).toEqual(['contact-lee']);
  });

  it('untick: an occasion the tick made goes; the event stays. Ticked again, Private changes only the privacy', async () => {
    const f = world();
    const made = f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true });
    expect(f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: false })).toMatchObject({ id: made.id, private: false, source_next_on: '2026-12-12' });
    expect(f.adoption.block(SLUG, 'invite-1')?.owner).toEqual({ occasion_id: made.id, title: 'Dr. Lee follow-up', private: false });
    expect(() => f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', occasion_id: 'another', private: true })).toThrow(/belongs to Dr\. Lee follow-up already/);
    expect(f.adoption.release({ slug: SLUG, source_id: 'invite-1' })).toBe('removed');
    expect(f.history.occasion(made.id)).toBeNull();
    expect(f.adoption.release({ slug: SLUG, source_id: 'invite-1' })).toBe('none');
    await f.tick(); expect(f.calls).toEqual([]); expect(f.events.has('invite-1')).toBe(true);
  });

  it("an occasion's own event (In my calendar) is not ticked here: changed in Yours", async () => {
    const f = world();
    const own = f.history.saveOccasion(waiting({ title: 'Haircut', after_each: undefined, source_next_on: '2026-12-01', month_day: '12-01', in_calendar: true }), at('06:00'));
    await f.tick();
    expect(f.calls.map((call) => call.op)).toEqual(['create']);
    expect(f.adoption.block(SLUG, 'own-1')).toEqual({ owner: { occasion_id: own.id, title: 'Haircut', private: true, written_by_occasion: true }, waiting: [] });
    expect(() => f.adoption.adopt({ slug: SLUG, source_id: 'own-1', private: false })).toThrow(/the occasion’s own/);
    expect(() => f.adoption.release({ slug: SLUG, source_id: 'own-1' })).toThrow(/untick In my calendar/);
  });

  it('is not offered on a cancelled, past or repeating event', () => {
    for (const patch of [{ status: 'cancelled' as const }, { start_at: at('10:30', '2026-11-20'), end_at: at('11:00', '2026-11-20') },
      { recurrence_rule: 'RRULE:FREQ=MONTHLY' }, { recurring_event_id: 'series-1' }]) {
      const f = world();
      f.events.set('invite-1', invite(patch));
      expect(f.adoption.block(SLUG, 'invite-1')).toBeUndefined();
      expect(() => f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true })).toThrow(/still to come/);
    }
  });

  it('the booking the same invite made joins the occasion, and its card shows one appointment', async () => {
    const f = world();
    f.db.exec(`CREATE TABLE data_booking (id TEXT PRIMARY KEY, title TEXT, lifecycle_state TEXT, deleted_at INTEGER, sync_state TEXT, source_extension_blob TEXT)`);
    f.db.prepare('INSERT INTO data_booking VALUES (?,?,?,?,?,?)').run('booking-1', 'Dr. Lee follow-up — State Hospital', 'confirmed', null, 'live',
      JSON.stringify({ kind: 'calendar_invite', uid: 'uid-clinic-1', match_key: 'uid-clinic-1', organizer_email: 'clinic@hospital.example' }));
    const occasion = f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true });
    expect(occasionOwningInvite(f.db)('uid-clinic-1')).toBe(occasion.id);
    expect(openBookingsByInvite(f.db, ['uid-clinic-1'])).toEqual(new Map([['uid-clinic-1', 'Dr. Lee follow-up — State Hospital']]));
    expect(f.sync.events()).toEqual({ [occasion.id]: { name: 'Work', ical_uid: 'uid-clinic-1',
      appointment: { title: 'Dr. Lee follow-up', start_at: at('10:30', '2026-12-12'), is_all_day: false, organizer: 'clinic@hospital.example' } } });
    // An occasion's own event carries no invite: nothing joins it.
    expect(occasionOwningInvite(f.db)('own-uid-1')).toBeUndefined();
  });

  it("on Outlook too: the event Exchange made from the invite carries its UID once Recued reads it out of Exchange's id", async () => {
    // Measured live 2026-11-22 on the mail realm: Graph gave the event Exchange added from an emailed invite its own
    // meeting id, wrapping the invite's UID, and Yours showed the appointment with no booking.
    const f = world();
    f.db.exec(`CREATE TABLE data_booking (id TEXT PRIMARY KEY, title TEXT, lifecycle_state TEXT, deleted_at INTEGER, sync_state TEXT, source_extension_blob TEXT)`);
    f.db.prepare('INSERT INTO data_booking VALUES (?,?,?,?,?,?)').run('booking-1', 'Dr. Lee follow-up — State Hospital', 'pending', null, 'live',
      JSON.stringify({ kind: 'calendar_invite', uid: 'uid-clinic-1', match_key: 'uid-clinic-1', organizer_email: 'clinic@hospital.example' }));
    f.events.set('invite-1', canonicalizeGraphEvent({
      id: 'invite-1', iCalUId: exchangeIdWrapping('uid-clinic-1'), subject: 'Dr. Lee follow-up',
      start: { dateTime: '2026-12-12T10:30:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-12-12T11:00:00.0000000', timeZone: 'UTC' },
      location: { displayName: 'State Hospital' }, organizer: { emailAddress: { address: 'clinic@hospital.example', name: 'State Hospital' } },
    }, 'cal-work', 'Work'));
    const occasion = f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', private: true });
    expect(f.sync.events()[occasion.id]).toMatchObject({ ical_uid: 'uid-clinic-1' });
    expect(occasionOwningInvite(f.db)('uid-clinic-1')).toBe(occasion.id);
    expect(openBookingsByInvite(f.db, ['uid-clinic-1'])).toEqual(new Map([['uid-clinic-1', 'Dr. Lee follow-up — State Hospital']]));
  });

  it("a write of the occasion's own event replaces an adopted link whole", async () => {
    const f = world();
    const lee = f.history.saveOccasion(waiting({ in_calendar: true }), at('06:00'));
    f.adoption.adopt({ slug: SLUG, source_id: 'invite-1', occasion_id: lee.id, private: true });
    // Its visit passes, and its next date is set: the next gets an event of its own.
    f.now(at('07:00', '2026-12-13'));
    const { created_at: _c, updated_at: _u, ...input } = f.history.occasion(lee.id)!;
    f.history.saveOccasion({ ...input, source_next_on: '2027-01-10', month_day: '01-10' }, at('07:00', '2026-12-13'));
    await f.sync.sync(f.history.occasions(1000), '2026-12-13');
    expect(occasionOwningEvent(f.db)(SLUG, 'invite-1')).toBeUndefined();
    await f.sync.sync(f.history.occasions(1000), '2026-12-13');
    expect(f.calls.map((call) => call.op)).toEqual(['create']);
    expect(f.adoption.block(SLUG, 'own-1')?.owner).toMatchObject({ occasion_id: lee.id, written_by_occasion: true });
    expect(occasionOwningInvite(f.db)('own-uid-1')).toBeUndefined();
    expect(f.events.has('invite-1')).toBe(true);
    // The fields an own event is written with are its own (slice 4), not the invite's.
    expect(f.calls[0]!.fields).toEqual(occasionEventFields(f.history.occasion(lee.id)!, '2027-01-10', 'UTC'));
  });
});

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
/** Yours as the server composes it, with the tick (or without, as an older server). */
const yours = (tick = true) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let occurrences: ReturnType<typeof createAssetOccurrenceService>;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work),
    onAssetChanged: async asset => { await occurrences.reconcileAsset(asset.id); }, onAssetDeleted: async asset => { await occurrences.retireAsset(asset.id); } });
  occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC' });
  const dir = mkdtempSync(join(tmpdir(), 'd407-s5-'));
  const events = new Map<string, CanonicalEvent>([['invite-1', invite()]]);
  const occasionEventAdoption = createOccasionEventAdoption({ db, history: createProactiveHistoryStore(db, createProactiveProposalStore(db)),
    timeZone: () => 'UTC', now: () => at('07:00'),
    event: (slug, source_id) => { const event = slug === SLUG ? events.get(source_id) : undefined; return event ? { event, calendar_name: 'Work' } : undefined; } });
  const service = createYoursService({ db, work, dispatchers, occurrences, annotations: createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')) }),
    situations: createSituationStore(db), isVaultUnlocked: () => true, timeZone: () => 'UTC', now: () => at('07:00'),
    ...(tick ? { occasionEventAdoption } : {}) } as never);
  cleanups.push(async () => { await service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return service;
};

describe('D-407 slice 5 — the tick, as the owner\'s Yours commands', () => {
  it('adopt and release say what became of the occasion and of the event; an older server refuses them', async () => {
    const service = yours();
    const made = await service.command({ action: 'occasion.adopt_event', slug: SLUG, source_id: 'invite-1', private: true }, owner);
    expect(made.message).toBe('Occasion made around this event, Private. It follows the event, which stays as it is in your calendar.');
    expect((await service.snapshot({})).occasions.find(occasion => occasion.id === made.id)).toMatchObject({ title: 'Dr. Lee follow-up', private: true });
    expect((await service.command({ action: 'occasion.adopt_event', slug: SLUG, source_id: 'invite-1', private: false }, owner)).message)
      .toBe('Dr. Lee follow-up is Shown by name now.');
    expect((await service.command({ action: 'occasion.release_event', slug: SLUG, source_id: 'invite-1' }, owner)).message)
      .toBe('The occasion made around this event is removed. The event stays in your calendar.');
    expect((await service.snapshot({})).occasions.find(occasion => occasion.id === made.id)).toBeUndefined();
    const lee = (await service.command({ action: 'occasion.save', occasion: waiting({ people: ['clinic@hospital.example'] }) }, owner)).id!;
    expect((await service.command({ action: 'occasion.adopt_event', slug: SLUG, source_id: 'invite-1', occasion_id: lee, private: true }, owner)).message)
      .toBe("This event is Dr. Lee's next one, Private. It stays as it is in your calendar.");
    expect((await service.command({ action: 'occasion.release_event', slug: SLUG, source_id: 'invite-1' }, owner)).message)
      .toBe('The event is let go, and its occasion waits for its next date again. The event stays in your calendar.');
    const older = yours(false);
    await expect(older.command({ action: 'occasion.adopt_event', slug: SLUG, source_id: 'invite-1', private: true }, owner))
      .rejects.toThrow('This server does not make occasions from calendar events');
  });
});

describe('D-407 slice 5 — the event read carries the tick', () => {
  it('beside the event, as the adoption reads it; absent on a server without it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd407-s5-read-')); const db = new Database(':memory:');
    const instances = createInstanceStore({ db });
    instances.upsert({ platform: 'calendar', slug: 'local', adapter_type: 'local', config: {}, caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
    let collection!: CalendarCollection;
    const provider = createLocalCalendarProvider({ slug: 'local', now: () => at('07:00'), readEvent: id => collection.table.get(id)?.event ?? null });
    collection = createCalendarCollection({ db, slug: 'local', provider, bus: createWarehouseEventBus(), blobs: createBlobStore(join(dir, 'blobs')),
      gate: createStorageGate({ quota: 1024 * 1024, reservePct: 10, surface: 'collection:calendar:local' }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024, expansion_past_days: 30, expansion_future_days: 90 }) });
    cleanups.push(() => { void collection.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    collection.table.upsert({ event: invite({ calendar_id: 'local' }), size_bytes: 0 });
    const registry = createCollectionRegistry(); registry.register(collection);
    const read = async (offered: boolean) => (await makeCollectionHandlers({ registry, calendarEnroll: { instances } as never,
      ...(offered ? { calendarEventOccasion: (slug: string, source_id: string) =>
        (slug === 'local' && source_id === 'invite-1' ? { waiting: [], marked_private: true as const } : undefined) } : {}) })!
      .handlers['collection.calendar.event.get']({ slug: 'local', source_id: 'invite-1' }, { instance_id: 'client-1' } as never)) as unknown as Record<string, unknown>;
    expect((await read(true)).occasion).toEqual({ waiting: [], marked_private: true });
    expect(await read(false)).not.toHaveProperty('occasion');
  });

  // Source-level, as the composition root's other obligations are: each piece passes its own tests without the line
  // that wires it.
  it('is composed: the adoption beside the bond, the read, Yours, and the chat\'s marks', () => {
    const at = (path: string) => readFileSync(resolve(import.meta.dirname, '..', ...path.split('/')), 'utf8');
    const context = at('serve/compose-collection-context.ts');
    expect(context).toMatch(/occasionEventAdoption = occasionCalendar && proactiveHistory \? createOccasionEventAdoption\(\{ db, history: proactiveHistory,/);
    expect(context).toMatch(/\.\.\.\(occasionEventAdoption \? \{ occasionEventAdoption \} : \{\}\),\n\s+inboundFileCollection,/);
    expect(context).toMatch(/\.\.\.\(occasionEventAdoption \? \{ occasionEventAdoption \} : \{\}\),\n\s+\.\.\.\(options\.bodyNumbers/);
    expect(context).toMatch(/eventPrivate: \(\(\) => \{ const holder = occasionOwningEvent\(db\);/);
    expect(context).toMatch(/const bookings = openBookingsByInvite\(db,/);
    expect(at('serve/compose-listeners.ts')).toMatch(/calendarEventOccasion: \(slug: string, source_id: string\) =>\s+collection\.occasionEventAdoption!\.block\(slug, source_id\)/);
  });
});

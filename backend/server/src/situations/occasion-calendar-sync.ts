/** D-407 slice 4a.2 (§4.1, Q3, Q4) — an occasion's own calendar event: an ordinary event in the one calendar the owner
 *  chose for occasions, bonded to its occasion by a link kept here (`proactive_occasion_events`). The occasion writes
 *  it, moves, renames, marks and alerts it, and removes it; *Recued only* writes none.
 *
 *  ⛔ Nothing is written until the owner chooses the calendar, and only for an occasion ticked *In my calendar*.
 *  ⛔ The marking is read back after each write (Q3): a calendar that drops it gets no private occasion again
 *  (`dropsPrivate`), and the event that lost it is removed at once.
 *  A past event stays where it is: it happened. The next one of a yearly or "when the last one says" occasion gets an
 *  event of its own; a date moved before it comes moves the event. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { calendarDayMs, isOccasionTimeZone, occasionIsPrivate, occasionNextDate, occasionTimeOn, RpcError, zoneOffsetMsAt,
  type CalendarEventPatch, type Occasion, type OccasionCalendarChoice, type OccasionInput } from '@recued/contracts';
import type { CalendarDispatcherDeps } from '../collections/calendar/calendar-dispatcher.js';
import { createOwnerCalendarEvent } from '../collections/calendar/event-create-handler.js';
import { getCalendarEvent } from '../collections/calendar/local-event-handler.js';
import { callCalendarAdapter } from '../collections/calendar/errors.js';
import { deleteOwnerCalendarEvent, readCalendarEventForEdit, updateOwnerCalendarEvent } from '../collections/calendar/remote-event-handler.js';
import type { CalendarEventCreationStore } from '../storage/calendar-event-creations.js';

/** What an occasion's event says, as written. */
export interface OccasionEventFields {
  summary: string; description: string; location: string;
  start_at: number; end_at: number; timezone: string; is_all_day: boolean;
  marked_private: boolean; alert_minutes: number | null;
}
/** The calendar writes the bond needs. The composition root makes them the owner's own create, edit and delete, so an
 *  occasion's event is written as the owner's Calendar writes any event (idempotent create, versioned edit). Each
 *  says whether the event read back still carries the private marking. */
export interface OccasionCalendarWriter {
  create(choice: OccasionCalendarChoice, creation_id: string, fields: OccasionEventFields): Promise<{ source_id: string; marked_private: boolean }>;
  update(slug: string, source_id: string, patch: CalendarEventPatch): Promise<{ marked_private: boolean }>;
  remove(slug: string, source_id: string): Promise<void>;
  /** D-407 slice 4b — the event's when as Recued's copy of its calendar holds it (no call): what a phone moved it to. */
  stored(slug: string, source_id: string): StoredEvent | undefined;
  /** D-407 slice 4b — asks the calendar itself whether the event is gone (deleted or cancelled there). Recued's copy
   *  alone never decides it: a missing row is not proof, and an occasion taken out of the calendar on a wrong guess
   *  would leave its event behind, and a second one when ticked again. */
  gone(slug: string, calendar_id: string, source_id: string): Promise<boolean>;
}
/** An event's when, as a calendar holds it. A whole-day event starts at the UTC midnight of its day. */
export interface StoredEvent { start_at: number; end_at: number; is_all_day: boolean; timezone: string; status: string }
export interface OccasionCalendarSyncDeps {
  db: Database.Database;
  writer: OccasionCalendarWriter;
  /** The calendar chosen once for occasions; null when none is. */
  choice(): OccasionCalendarChoice | null;
  /** That calendar dropped an event's private marking: no private occasion goes there again. */
  dropsPrivate(choice: OccasionCalendarChoice): void;
  /** The owner's zone, for an occasion with no time of day (a whole-day event). */
  timeZone(): string;
  now(): number;
  /** D-407 slice 4b — saves the occasion as its event moved it, or as Recued only once its event is gone. */
  save(occasion: OccasionInput): Occasion;
}
/** D-407 slice 4 — the writer the composition root gives the bond: the owner's own Calendar create (idempotent by its
 *  creation id), edit and delete, each checked as an owner's write is (connection, version). The private marking is
 *  read back from the event as Recued keeps it, which every write updates. A removal of an event Recued no longer has,
 *  or its calendar no longer has, is done.
 *  ⛔ An edit or a removal reads the event from its calendar first, as the owner's editor does, and is checked against
 *  that version. Recued's copy is the create's answer, and Outlook moves an event's version on after answering
 *  (live 2026-11-21): checked against the copy, every first edit or removal of a new event was refused. */
export const ownerCalendarWriter = (deps: { calendar: CalendarDispatcherDeps; creations: CalendarEventCreationStore }): OccasionCalendarWriter => {
  const kept = (slug: string, source_id: string): boolean => deps.calendar.getCollection(slug)?.table.get(source_id)?.event.marked_private === true;
  /** Each event asked about once per five minutes at most: a copy missing a row the calendar still has must not ask every
   *  minute. */
  const asked = new Map<string, number>();
  /** The event as its calendar has it now; a calendar that could not be read refuses the write until the next try. */
  const current = async (slug: string, source_id: string): Promise<ReturnType<typeof getCalendarEvent> | 'gone'> => {
    const read = await readCalendarEventForEdit(deps.calendar, { slug, source_id });
    if (read.missing) return 'gone';
    if (read.view.refresh_error) throw new Error(read.view.refresh_error);
    return read.view;
  };
  return {
    async create(choice, creation_id, fields) {
      const incarnation = deps.calendar.instances.getIncarnation?.('calendar', choice.slug);
      if (!incarnation) throw new Error(`The calendar ${choice.name} is not connected`);
      const { marked_private, ...rest } = fields;
      const made = await createOwnerCalendarEvent(deps.calendar, deps.creations, { slug: choice.slug, calendar_id: choice.calendar_id,
        expected_incarnation: incarnation, creation_id, ...rest, ...(marked_private ? { marked_private: true as const } : {}) });
      return { source_id: made.snapshot.event.source_id, marked_private: kept(choice.slug, made.snapshot.event.source_id) };
    },
    async update(slug, source_id, patch) {
      const fresh = await current(slug, source_id);
      if (fresh === 'gone') throw new Error('Its event is no longer in the calendar');
      await updateOwnerCalendarEvent(deps.calendar, { slug, source_id, expected_version: fresh.resource_version,
        expected_incarnation: fresh.incarnation ?? '', patch });
      return { marked_private: kept(slug, source_id) };
    },
    async remove(slug, source_id) {
      if (!deps.calendar.getCollection(slug)?.table.get(source_id)) return;
      const fresh = await current(slug, source_id);
      if (fresh === 'gone') return;
      await deleteOwnerCalendarEvent(deps.calendar, { slug, source_id, expected_version: fresh.resource_version,
        expected_incarnation: fresh.incarnation ?? '' });
    },
    stored(slug, source_id) {
      const event = deps.calendar.getCollection(slug)?.table.get(source_id)?.event;
      return event && { start_at: event.start_at, end_at: event.end_at, is_all_day: event.is_all_day, timezone: event.timezone, status: event.status };
    },
    async gone(slug, calendar_id, source_id) {
      const collection = deps.calendar.getCollection(slug);
      // Not connected now: nothing can be known, so nothing changes.
      if (!collection) return false;
      if (collection.provider.kind === 'local') {
        const row = collection.table.get(source_id);
        return !row || row.event.status === 'cancelled';
      }
      const key = `${slug}\u0000${source_id}`; const last = asked.get(key);
      if (!collection.provider.readEventForEdit || (last !== undefined && Date.now() - last < RETRY_MS)) return false;
      asked.set(key, Date.now());
      try {
        const context = await callCalendarAdapter(slug, 'read-event', () => collection.provider.readEventForEdit!(calendar_id, source_id));
        return context.payload.event.status === 'cancelled';
      } catch (error) {
        // Only the calendar's own "no such event" says it is gone; any other failure leaves it as it is.
        return error instanceof RpcError && error.code === 'not_found' && error.message.startsWith('CALENDAR_EVENT_NOT_FOUND');
      }
    },
  };
};

/** The bond's tables, made by whichever of its readers or its writer comes first. */
const ensureOccasionEventTables = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS proactive_occasion_events (occasion_id TEXT PRIMARY KEY, cycle TEXT NOT NULL, slug TEXT NOT NULL,
    calendar_id TEXT NOT NULL, name TEXT NOT NULL, source_id TEXT NOT NULL, written TEXT NOT NULL, shape TEXT NOT NULL, written_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS proactive_occasion_events_by_event ON proactive_occasion_events(slug, source_id)');
  // `tried`: what the failed write was for (the occasion as saved, and the calendar chosen), so a change is tried at once.
  db.exec('CREATE TABLE IF NOT EXISTS proactive_occasion_event_errors (occasion_id TEXT PRIMARY KEY, error TEXT NOT NULL, tried TEXT NOT NULL, at INTEGER NOT NULL)');
  // D-407 slice 5 — an event the occasion holds but did not write (`adopted`, `AdoptedEvent` as JSON), and the iCal UID
  // it carries, which the booking the same invite made carries too.
  const columns = new Set((db.prepare('PRAGMA table_info(proactive_occasion_events)').all() as Array<{ name: string }>).map(row => row.name));
  if (!columns.has('adopted')) db.exec('ALTER TABLE proactive_occasion_events ADD COLUMN adopted TEXT');
  if (!columns.has('ical_uid')) db.exec('ALTER TABLE proactive_occasion_events ADD COLUMN ical_uid TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS proactive_occasion_events_by_uid ON proactive_occasion_events(ical_uid)');
};
/** D-407 slice 5 (§4.1, Q5) — an event the occasion holds but did not write: a clinic's invite, or any event the owner
 *  ticked *Occasion* on. `made`: the tick made the occasion, so letting the event go removes it. `before`: the date an
 *  occasion waiting for its next one had, put back when the event is let go. */
export interface AdoptedEvent {
  made: boolean;
  before?: Pick<Occasion, 'month_day' | 'source_next_on' | 'time' | 'time_zone' | 'alert_minutes'>;
  /** Who sent it, as its calendar names the organizer. */
  organizer?: string;
}
/** D-407 slice 5 — what the bond holds for an event: its occasion, and how it came to hold it (`adopted` absent: the
 *  occasion wrote it). */
export const occasionHoldingEvent = (db: Database.Database): ((slug: string, source_id: string) => { occasion_id: string; adopted?: AdoptedEvent } | undefined) => {
  ensureOccasionEventTables(db);
  const row = db.prepare('SELECT occasion_id,adopted FROM proactive_occasion_events WHERE slug=? AND source_id=?');
  return (slug, source_id) => {
    const found = row.get(slug, source_id) as { occasion_id: string; adopted: string | null } | undefined;
    return found === undefined ? undefined
      : { occasion_id: found.occasion_id, ...(found.adopted ? { adopted: JSON.parse(found.adopted) as AdoptedEvent } : {}) };
  };
};
/** D-407 slice 5 — the bond takes an event the occasion did not write, in place of any it held: an occasion waiting for
 *  its next date holds none still to come (its own past event, which happened, stays in its calendar). */
export const holdAdoptedEvent = (db: Database.Database, row: { occasion_id: string; cycle: string; slug: string; calendar_id: string;
  name: string; source_id: string; fields: OccasionEventFields; adopted: AdoptedEvent; ical_uid?: string; at: number }): void => {
  ensureOccasionEventTables(db);
  db.prepare(`INSERT INTO proactive_occasion_events(occasion_id,cycle,slug,calendar_id,name,source_id,written,shape,written_at,adopted,ical_uid)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(occasion_id) DO UPDATE SET cycle=excluded.cycle,slug=excluded.slug,calendar_id=excluded.calendar_id,
    name=excluded.name,source_id=excluded.source_id,written=excluded.written,shape=excluded.shape,written_at=excluded.written_at,
    adopted=excluded.adopted,ical_uid=excluded.ical_uid`)
    .run(row.occasion_id, row.cycle, row.slug, row.calendar_id, row.name, row.source_id, JSON.stringify(row.fields),
      JSON.stringify([row.fields.is_all_day, row.fields.timezone]), row.at, JSON.stringify(row.adopted), row.ical_uid ?? null);
};
/** D-407 slice 5 — the bond lets an event go; the event stays in its calendar. */
export const releaseHeldEvent = (db: Database.Database, occasion_id: string, source_id: string): void => {
  ensureOccasionEventTables(db);
  db.prepare('DELETE FROM proactive_occasion_events WHERE occasion_id=? AND source_id=?').run(occasion_id, source_id);
};
/** D-407 slice 5 (§10.1, Q5) — the occasion an emailed invite belongs to, by its iCal UID: the booking the invite made
 *  joins the occasion that holds the invite's event, so they are one appointment, private as the occasion is. */
export const occasionOwningInvite = (db: Database.Database): ((uid: string) => string | undefined) => {
  ensureOccasionEventTables(db);
  const owner = db.prepare('SELECT occasion_id FROM proactive_occasion_events WHERE ical_uid=? AND adopted IS NOT NULL');
  return uid => (owner.get(uid) as { occasion_id: string } | undefined)?.occasion_id;
};
/** D-407 slice 5 (U2) — the open booking each invite made, by its iCal UID, read as the situations read an open booking
 *  (`sources.ts`, `OPEN_SQL`). A database with no bookings table has none. */
export const openBookingsByInvite = (db: Database.Database, uids: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  if (uids.length === 0) return out;
  try {
    const rows = db.prepare(`SELECT title, json_extract(source_extension_blob,'$.uid') AS uid FROM data_booking
      WHERE lifecycle_state IN ('pending','confirmed') AND deleted_at IS NULL AND sync_state IN ('live','stale_unreachable')
      AND json_valid(source_extension_blob) AND json_extract(source_extension_blob,'$.kind')='calendar_invite'
      AND json_extract(source_extension_blob,'$.uid') IN (${uids.map(() => '?').join(',')}) ORDER BY id`).all(...uids) as Array<{ title: string; uid: string }>;
    for (const row of rows) if (!out.has(row.uid)) out.set(row.uid, row.title);
  } catch (error) {
    if (!(error instanceof Error && /no such table/u.test(error.message))) throw error;
  }
  return out;
};
/** D-407 slice 5 — the invite a booking was made from: the iCal UID the Calendar Invites recipe keeps on it
 *  (`source_extension_blob`, `kind: calendar_invite`). */
export const bookingInviteUid = (blob: unknown): string | undefined => {
  let value = blob;
  if (typeof value === 'string') { try { value = JSON.parse(value) as unknown; } catch { return undefined; } }
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, uid } = value as { kind?: unknown; uid?: unknown };
  return kind === 'calendar_invite' && typeof uid === 'string' && uid.length > 0 ? uid : undefined;
};
/** D-407 slice 4c — the occasion an event belongs to: its own event, by the calendar it is in and its id there. Today
 *  shows the two as one line, and the event is private as its occasion is (§4.2). A past event, its link let go, stands
 *  alone. */
export const occasionOwningEvent = (db: Database.Database): ((slug: string, source_id: string) => string | undefined) => {
  ensureOccasionEventTables(db);
  const owner = db.prepare('SELECT occasion_id FROM proactive_occasion_events WHERE slug=? AND source_id=?');
  return (slug, source_id) => (owner.get(slug, source_id) as { occasion_id: string } | undefined)?.occasion_id;
};

/** What an occasion's event says it is. */
export const OCCASION_EVENT_NOTE = 'An occasion in Recued.';
/** A failed write is tried again after this long, not every minute. */
const RETRY_MS = 5 * 60_000;

/** An occasion's event on its date: at its time for an hour, else the whole day; private and alerted as it is. */
export const occasionEventFields = (occasion: Occasion, on: string, ownerZone: string): OccasionEventFields => {
  const at = occasionTimeOn(occasion, on);
  const allDay = at === undefined;
  const start = allDay ? calendarDayMs(on)! : at;
  return {
    summary: occasion.title, description: OCCASION_EVENT_NOTE, location: occasion.where?.name ?? '',
    start_at: start, end_at: allDay ? start + 86_400_000 : start + 3_600_000,
    timezone: allDay ? ownerZone : String(occasion.time_zone), is_all_day: allDay,
    marked_private: occasionIsPrivate(occasion),
    // A muted occasion's event keeps its date, and no alert.
    alert_minutes: occasion.muted ? null : occasion.alert_minutes ?? null,
  };
};

interface Link { occasion_id: string; cycle: string; slug: string; calendar_id: string; name: string; source_id: string; written: string; shape: string;
  /** D-407 slice 5 — `AdoptedEvent` as JSON: an event the occasion holds but did not write. */
  adopted: string | null; ical_uid: string | null }
/** D-407 slice 5 (U2) — an event the occasion holds but did not write, as Yours shows it: one appointment. */
export interface HeldAppointment { title: string; start_at: number; is_all_day: boolean; organizer?: string }

export interface OccasionCalendarSync {
  /** Writes what changed for each occasion; removes the future events of those gone or no longer in the calendar. */
  sync(occasions: readonly Occasion[], today: string): Promise<void>;
  /** The occasion's event for this date is written as it is now: it carries the alert, so Recued sends none. */
  carriesAlert(occasion: Occasion, on: string): boolean;
  /** Each occasion's event as last written, and why the last write failed. D-407 slice 5 — an event it holds but did
   *  not write is the appointment, with the invite's UID for the booking it made. */
  events(): Record<string, { name: string; error?: string; appointment?: HeldAppointment; ical_uid?: string }>;
}

export const createOccasionCalendarSync = (deps: OccasionCalendarSyncDeps): OccasionCalendarSync => {
  ensureOccasionEventTables(deps.db);
  const get = (id: string): Link | undefined => deps.db.prepare('SELECT occasion_id,cycle,slug,calendar_id,name,source_id,written,shape,adopted,ical_uid FROM proactive_occasion_events WHERE occasion_id=?').get(id) as Link | undefined;
  // D-407 slice 5 — a write of the occasion's own event is never an adopted one's: it clears both.
  const put = (link: Omit<Link, 'adopted' | 'ical_uid'>): void => { deps.db.prepare(`INSERT INTO proactive_occasion_events(occasion_id,cycle,slug,calendar_id,name,source_id,written,shape,written_at)
    VALUES(@occasion_id,@cycle,@slug,@calendar_id,@name,@source_id,@written,@shape,@at) ON CONFLICT(occasion_id) DO UPDATE SET cycle=excluded.cycle,slug=excluded.slug,
    calendar_id=excluded.calendar_id,name=excluded.name,source_id=excluded.source_id,written=excluded.written,shape=excluded.shape,written_at=excluded.written_at,
    adopted=NULL,ical_uid=NULL`).run({ occasion_id: link.occasion_id, cycle: link.cycle, slug: link.slug, calendar_id: link.calendar_id, name: link.name,
      source_id: link.source_id, written: link.written, shape: link.shape, at: deps.now() }); };
  // D-407 slice 5 — by the event it is for: an adoption landing while a write was under way holds another, kept.
  const drop = (link: Pick<Link, 'occasion_id' | 'source_id'>): void => {
    deps.db.prepare('DELETE FROM proactive_occasion_events WHERE occasion_id=? AND source_id=?').run(link.occasion_id, link.source_id); };
  const failed = (id: string, error: unknown, tried: string): void => { deps.db.prepare(`INSERT INTO proactive_occasion_event_errors(occasion_id,error,tried,at)
    VALUES(?,?,?,?) ON CONFLICT(occasion_id) DO UPDATE SET error=excluded.error,tried=excluded.tried,at=excluded.at`)
    .run(id, error instanceof Error ? error.message : String(error), tried, deps.now()); };
  const cleared = (id: string): void => { deps.db.prepare('DELETE FROM proactive_occasion_event_errors WHERE occasion_id=?').run(id); };
  /** A failed write waits five minutes before the same write is tried again; the owner changing the occasion or the
   *  calendar since is tried at once (live 2026-11-21: an untick waited behind the edit that had just failed). */
  const waiting = (id: string, tried: string): boolean => {
    const row = deps.db.prepare('SELECT tried,at FROM proactive_occasion_event_errors WHERE occasion_id=?').get(id) as { tried: string; at: number } | undefined;
    return row !== undefined && row.tried === tried && deps.now() - row.at < RETRY_MS;
  };
  const triedFor = (occasion: Occasion | undefined): string => JSON.stringify([occasion?.updated_at ?? 'deleted', deps.choice()]);
  const hashOf = (fields: OccasionEventFields): string => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  /** What was last written, kept whole so an edit sends only what changed. */
  const writtenOf = (fields: OccasionEventFields): string => JSON.stringify(fields);
  /** ⛔ Only the fields that changed since the last write (live, Outlook 2026-11-21): Outlook keeps an event's notes as
   *  HTML whatever was written, and its editor refuses HTML notes, so an edit carrying the unchanged note was refused
   *  whole. Sending only what changed also leaves the owner's own edits in the phone to the fields the occasion did
   *  not change. */
  const changedSince = (before: OccasionEventFields, fields: OccasionEventFields): CalendarEventPatch => ({
    ...(before.summary !== fields.summary ? { summary: fields.summary } : {}),
    ...(before.description !== fields.description ? { description: fields.description } : {}),
    ...(before.location !== fields.location ? { location: fields.location } : {}),
    ...(before.start_at !== fields.start_at ? { start_at: fields.start_at } : {}),
    ...(before.end_at !== fields.end_at ? { end_at: fields.end_at } : {}),
    ...(before.marked_private !== fields.marked_private ? { marked_private: fields.marked_private } : {}),
    ...(before.alert_minutes !== fields.alert_minutes ? { alert_minutes: fields.alert_minutes } : {}),
  });
  // An edit cannot make a whole-day event timed, or move its zone: those are written as a new event.
  const shapeOf = (fields: OccasionEventFields): string => JSON.stringify([fields.is_all_day, fields.timezone]);
  /** The same create, retried after a lost answer, is recognised by its creation id (`createOwnerCalendarEvent`). */
  const creationId = (parts: readonly string[]): string => {
    const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const wanted = (occasion: Occasion, choice: OccasionCalendarChoice | null): choice is OccasionCalendarChoice =>
    choice !== null && occasion.in_calendar === true && occasion.source === undefined && occasion.source_active !== false
    && !(choice.keeps_private === false && occasionIsPrivate(occasion));
  const removeFuture = async (link: Link, today: string): Promise<void> => {
    // A past event stays: it happened. A future one goes with its occasion.
    if (link.cycle >= today) await deps.writer.remove(link.slug, link.source_id);
    drop(link);
  };
  /** An event's when: its instant, or for a whole day the day itself. Where it is shown does not change it. */
  const whenOf = (event: Pick<StoredEvent, 'start_at' | 'is_all_day'>): string =>
    event.is_all_day ? `day:${new Date(event.start_at).toISOString().slice(0, 10)}` : `at:${String(event.start_at)}`;
  /** The occasion as its event moved it: the event's day, and its time on the occasion's own clock (a whole-day event
   *  takes the time and its alert away). A yearly occasion moves its yearly date; a dated one (one time, or "when the
   *  last one says") its date. */
  const movedTo = (occasion: Occasion, event: StoredEvent): { input: OccasionInput; on: string } => {
    const { created_at: _created, updated_at: _updated, ...input } = occasion;
    const dated = (on: string) => ({ month_day: on.slice(5), ...(occasion.source_next_on !== undefined ? { source_next_on: on } : {}) });
    if (event.is_all_day) {
      const on = new Date(event.start_at).toISOString().slice(0, 10);
      const { time: _time, time_zone: _zone, alert_minutes: _alert, ...day } = input;
      return { input: { ...day, ...dated(on) }, on };
    }
    const zone = isOccasionTimeZone(occasion.time_zone) ? occasion.time_zone : isOccasionTimeZone(event.timezone) ? event.timezone : deps.timeZone();
    const wall = new Date(event.start_at + zoneOffsetMsAt(event.start_at, zone)).toISOString();
    const on = wall.slice(0, 10);
    return { input: { ...input, ...dated(on), time: wall.slice(11, 16), time_zone: zone }, on };
  };
  /** D-407 slice 4b (§4.1 rule 2) — the event is the truth for when. Moved in the phone since Recued last wrote it, while
   *  the occasion's own when is unchanged here, the occasion takes the event's date and time; changed here too, Recued's
   *  write wins. Gone from its calendar, as the calendar itself says, the occasion goes on in Recued only. */
  const follow = async (occasion: Occasion, link: Link, on: string): Promise<Occasion | 'gone' | undefined> => {
    const before = JSON.parse(link.written) as OccasionEventFields;
    const event = deps.writer.stored(link.slug, link.source_id);
    if (event === undefined || event.status === 'cancelled') {
      if (!(await deps.writer.gone(link.slug, link.calendar_id, link.source_id))) return undefined;
      const { created_at: _created, updated_at: _updated, ...input } = occasion;
      deps.save({ ...input, in_calendar: false }); drop(link);
      return 'gone';
    }
    if (whenOf(event) === whenOf(before) || whenOf(occasionEventFields(occasion, on, deps.timeZone())) !== whenOf(before)) return undefined;
    const moved = movedTo(occasion, event);
    const saved = deps.save(moved.input);
    // The event already holds the new when: it is recorded as written, the rest as it was, so only what the owner
    // changes in Recued is sent. Its date is the link's even when the phone moved it into the past: a past event stays.
    const now = occasionEventFields(saved, moved.on, deps.timeZone());
    put({ ...link, cycle: moved.on, shape: shapeOf(now),
      written: writtenOf({ ...before, start_at: now.start_at, end_at: now.end_at, is_all_day: now.is_all_day, timezone: now.timezone }) });
    return saved;
  };
  /** D-407 slice 5 (§4.1) — an event the occasion holds but did not write (a clinic's invite it adopted): the event is
   *  the truth for when, so the occasion follows it as it follows its own (4b). ⛔ Recued never writes, moves or removes
   *  it: it is the calendar's, often an invite someone else sent. Its date changed in Recued, the event gone from its
   *  calendar, or past: the link goes, and the event stays where it is. */
  const held = async (occasion: Occasion, link: Link, today: string): Promise<void> => {
    const on = occasionNextDate(occasion, today);
    if (on === null || on !== link.cycle) { drop(link); return; }
    const before = JSON.parse(link.written) as OccasionEventFields;
    const event = deps.writer.stored(link.slug, link.source_id);
    if (event === undefined || event.status === 'cancelled') {
      if (await deps.writer.gone(link.slug, link.calendar_id, link.source_id)) drop(link);
      return;
    }
    if (whenOf(event) === whenOf(before)) return;
    const moved = movedTo(occasion, event);
    deps.save(moved.input);
    // Moved into the past: it happened, and the link goes, as for any past date.
    if (moved.on < today) { drop(link); return; }
    deps.db.prepare('UPDATE proactive_occasion_events SET cycle=?,written=?,written_at=? WHERE occasion_id=? AND source_id=?')
      .run(moved.on, writtenOf({ ...before, start_at: event.start_at, end_at: event.end_at, is_all_day: event.is_all_day, timezone: event.timezone }),
        deps.now(), link.occasion_id, link.source_id);
  };
  const one = async (input: Occasion, today: string): Promise<void> => {
    let occasion = input;
    let link = get(occasion.id);
    if (link?.adopted) { await held(occasion, link, today); return; }
    const choice = deps.choice();
    let on = occasionNextDate(occasion, today);
    if (!wanted(occasion, choice) || on === null) { if (link) await removeFuture(link, today); return; }
    if (link && link.slug === choice.slug && link.calendar_id === choice.calendar_id && link.cycle === on) {
      const followed = await follow(occasion, link, on);
      if (followed === 'gone') return;
      if (followed) {
        occasion = followed; link = get(occasion.id); on = occasionNextDate(occasion, today);
        if (on === null) { if (link) await removeFuture(link, today); return; }
      }
    }
    const fields = occasionEventFields(occasion, on, deps.timeZone());
    const written = writtenOf(fields); const shape = shapeOf(fields);
    if (link && (link.slug !== choice.slug || link.calendar_id !== choice.calendar_id || link.shape !== shape)) { await removeFuture(link, today); link = undefined; }
    // The last one happened: the next gets an event of its own.
    if (link && link.cycle !== on && link.cycle < today) { drop(link); link = undefined; }
    if (!link) {
      const made = await deps.writer.create(choice, creationId([occasion.id, on, choice.slug, choice.calendar_id, hashOf(fields)]), fields);
      if (fields.marked_private && !made.marked_private) {
        await deps.writer.remove(choice.slug, made.source_id); deps.dropsPrivate(choice); return;
      }
      put({ occasion_id: occasion.id, cycle: on, slug: choice.slug, calendar_id: choice.calendar_id, name: choice.name, source_id: made.source_id, written, shape });
      return;
    }
    if (link.written === written && link.cycle === on) return;
    const patch = changedSince(JSON.parse(link.written) as OccasionEventFields, fields);
    if (Object.keys(patch).length > 0) {
      const done = await deps.writer.update(link.slug, link.source_id, patch);
      if (fields.marked_private && !done.marked_private) {
        await removeFuture(link, today); deps.dropsPrivate(choice); return;
      }
    }
    put({ ...link, cycle: on, written });
  };
  return {
    async sync(occasions, today) {
      const seen = new Set<string>();
      for (const occasion of occasions) {
        seen.add(occasion.id);
        const tried = triedFor(occasion);
        if (waiting(occasion.id, tried)) continue;
        try { await one(occasion, today); cleared(occasion.id); } catch (error) { failed(occasion.id, error, tried); }
      }
      // An occasion deleted: its future event goes too.
      const orphans = deps.db.prepare('SELECT occasion_id,cycle,slug,calendar_id,name,source_id,written,shape,adopted,ical_uid FROM proactive_occasion_events').all() as Link[];
      for (const link of orphans) {
        const tried = triedFor(undefined);
        if (seen.has(link.occasion_id) || waiting(link.occasion_id, tried)) continue;
        // D-407 slice 5 — an event the occasion did not write stays: only the link goes.
        if (link.adopted) { drop(link); continue; }
        try { await removeFuture(link, today); cleared(link.occasion_id); } catch (error) { failed(link.occasion_id, error, tried); }
      }
    },
    carriesAlert(occasion, on) {
      const link = get(occasion.id); const choice = deps.choice();
      // D-407 slice 5 — an event the occasion did not write carries none of its alert: the occasion sends it.
      return link !== undefined && !link.adopted && choice !== null && wanted(occasion, choice) && link.cycle === on
        && link.written === writtenOf(occasionEventFields(occasion, on, deps.timeZone()));
    },
    events() {
      // Each event under the calendar it is in, which a changed choice has not moved yet; a failure under that calendar,
      // or the chosen one when nothing is written yet. With no calendar at all there is nothing to say.
      const out: Record<string, { name: string; error?: string; appointment?: HeldAppointment; ical_uid?: string }> = {};
      for (const link of deps.db.prepare('SELECT occasion_id,name,written,adopted,ical_uid FROM proactive_occasion_events').all() as
        Array<{ occasion_id: string; name: string; written: string; adopted: string | null; ical_uid: string | null }>) {
        if (!link.adopted) { out[link.occasion_id] = { name: link.name }; continue; }
        // D-407 slice 5 (U2) — the appointment it holds, as its calendar had it when last read.
        const fields = JSON.parse(link.written) as OccasionEventFields; const adopted = JSON.parse(link.adopted) as AdoptedEvent;
        out[link.occasion_id] = { name: link.name, appointment: { title: fields.summary, start_at: fields.start_at, is_all_day: fields.is_all_day,
          ...(adopted.organizer ? { organizer: adopted.organizer } : {}) }, ...(link.ical_uid ? { ical_uid: link.ical_uid } : {}) };
      }
      const chosen = deps.choice()?.name;
      for (const row of deps.db.prepare('SELECT occasion_id,error FROM proactive_occasion_event_errors').all() as Array<{ occasion_id: string; error: string }>) {
        const name = out[row.occasion_id]?.name ?? chosen;
        if (name) out[row.occasion_id] = { name, error: row.error };
      }
      return out;
    },
  };
};

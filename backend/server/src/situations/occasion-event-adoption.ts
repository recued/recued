/** D-407 slice 5 (§4.1, Q4, Q5) — the *Occasion* tick, from the calendar side. On an event already in the owner's
 *  calendar (their own habit, or a clinic's emailed invite), ticking *Occasion* wraps an occasion around it, entering
 *  nothing again; or, where an occasion is waiting for its next date, makes the event that occasion's next one. The
 *  event is never written: it stays the calendar's, and the occasion follows it (`occasion-calendar-sync.ts`, `held`).
 *  The booking the same invite made joins the occasion by the invite's iCal UID (`occasionOwningInvite`).
 *
 *  ⛔ Recued never adopts by itself (Q5): only the owner's tick does, and it asks which occasion when one is waiting,
 *  the one that matches the event's organizer or place offered first.
 *  ⛔ No kind of occasion exists to start *Private* by (Q4's "by kind"), so a new occasion starts Private: a wrong
 *  start keeps a name out of the owner's messages, where the other would put a health visit in them. */
import type Database from 'better-sqlite3';
import { assetDateAt, isOccasionTimeZone, occasionIsPrivate, occasionWaitingForNext, zoneOffsetMsAt,
  type CalendarEventOccasion, type CanonicalEvent, type Occasion, type OccasionInput, type SituationPlace } from '@recued/contracts';
import { holdAdoptedEvent, occasionHoldingEvent, releaseHeldEvent, type AdoptedEvent, type OccasionEventFields } from './occasion-calendar-sync.js';

export interface OccasionEventAdoptionDeps {
  db: Database.Database;
  history: {
    occasion(id: string): Occasion | null;
    walkOccasions(after?: string, limit?: number): Occasion[];
    saveOccasion(input: OccasionInput, at: number): Occasion;
    deleteOccasion(id: string): void;
    place(name: string): SituationPlace;
  };
  /** The event as Recued's copy of its calendar holds it, with that calendar's name; undefined when it has none. */
  event(slug: string, source_id: string): { event: CanonicalEvent; calendar_name: string } | undefined;
  /** The owner's contact for an email, by its id, when there is one. */
  contactId?(email: string): string | undefined;
  timeZone(): string;
  now(): number;
}

export interface OccasionEventAdoption {
  /** The event's *Occasion* block, or undefined where no occasion may hold it. */
  block(slug: string, source_id: string): CalendarEventOccasion | undefined;
  /** The tick: a new occasion around the event, or (`occasion_id`) the next one of an occasion waiting for its date.
   *  On an event an occasion already holds, its privacy only. */
  adopt(input: { slug: string; source_id: string; occasion_id?: string; private: boolean }): Occasion;
  /** The tick taken off: the event is let go. Returns what became of the occasion. */
  release(input: { slug: string; source_id: string }): 'removed' | 'waiting' | 'let_go' | 'none';
}

/** The most a new occasion's name takes from its event's title. */
const TITLE_MAX = 200;

export const createOccasionEventAdoption = (deps: OccasionEventAdoptionDeps): OccasionEventAdoption => {
  const holding = occasionHoldingEvent(deps.db);
  const today = (): string => assetDateAt(deps.now(), deps.timeZone());
  /** The event's date, and its time on its own clock (a whole-day event has none), as an occasion keeps them. */
  const whenOf = (event: CanonicalEvent): { on: string; time?: string; time_zone?: string } => {
    if (event.is_all_day) return { on: new Date(event.start_at).toISOString().slice(0, 10) };
    const zone = isOccasionTimeZone(event.timezone) ? event.timezone : deps.timeZone();
    const wall = new Date(event.start_at + zoneOffsetMsAt(event.start_at, zone)).toISOString();
    return { on: wall.slice(0, 10), time: wall.slice(11, 16), time_zone: zone };
  };
  /** An event an occasion may hold: not cancelled, today or later, and not one occurrence of a repeating event (a
   *  yearly series already declares its own occasion). */
  const offered = (event: CanonicalEvent): boolean => event.status !== 'cancelled'
    && event.recurrence_rule === undefined && event.recurring_event_id === undefined && whenOf(event).on >= today();
  /** The organizer, unless it is the owner: a person of the occasion. */
  const organizerOf = (event: CanonicalEvent): string | undefined => {
    const email = event.organizer?.email?.trim().toLowerCase();
    if (!email) return undefined;
    const self = event.attendees?.find(person => person.is_self === true)?.email?.trim().toLowerCase();
    return email === self ? undefined : email;
  };
  /** Whether a waiting occasion is this event's: its person is the organizer, or its place the event's. */
  const matches = (occasion: Occasion, event: CanonicalEvent): boolean => {
    const organizer = organizerOf(event);
    const contact = organizer === undefined ? undefined : deps.contactId?.(organizer);
    if (organizer !== undefined && occasion.people.some(person => person.toLowerCase() === organizer || (contact !== undefined && person === contact))) return true;
    return event.location !== undefined && event.location.trim() !== '' && occasion.where !== undefined
      && deps.history.place(event.location).key === occasion.where.key;
  };
  const waitingFor = (event: CanonicalEvent): CalendarEventOccasion['waiting'] => {
    const day = today(); const rows: Array<{ occasion: Occasion; match: boolean }> = [];
    for (let after = '', page = deps.history.walkOccasions(after, 200); page.length > 0; after = page.at(-1)!.id, page = deps.history.walkOccasions(after, 200)) {
      for (const occasion of page) if (occasionWaitingForNext(occasion, day) !== undefined) rows.push({ occasion, match: matches(occasion, event) });
    }
    rows.sort((a, b) => Number(b.match) - Number(a.match) || a.occasion.title.localeCompare(b.occasion.title));
    return rows.map(({ occasion, match }) => ({ occasion_id: occasion.id, title: occasion.title, private: occasionIsPrivate(occasion),
      ...(match ? { match: true as const } : {}) }));
  };
  /** What the bond keeps of the event as read, to see it move. */
  const fieldsOf = (event: CanonicalEvent): OccasionEventFields => ({
    summary: event.summary, description: '', location: event.location ?? '', start_at: event.start_at, end_at: event.end_at,
    timezone: event.timezone, is_all_day: event.is_all_day, marked_private: event.marked_private === true, alert_minutes: null,
  });
  const save = (input: OccasionInput): Occasion => deps.history.saveOccasion(input, deps.now());
  const inputOf = (occasion: Occasion): OccasionInput => {
    const { created_at: _created, updated_at: _updated, ...input } = occasion;
    return input;
  };

  return {
    block(slug, source_id) {
      const found = deps.event(slug, source_id);
      if (!found) return undefined;
      const { event } = found;
      const marked = event.marked_private === true ? { marked_private: true as const } : {};
      const held = holding(slug, source_id);
      const owner = held ? deps.history.occasion(held.occasion_id) : null;
      if (held && owner) {
        return { owner: { occasion_id: owner.id, title: owner.title, private: occasionIsPrivate(owner),
          ...(held.adopted ? {} : { written_by_occasion: true as const }) }, waiting: [], ...marked };
      }
      if (!offered(event)) return undefined;
      return { waiting: waitingFor(event), ...marked };
    },
    adopt({ slug, source_id, occasion_id, private: chosen }) {
      if (typeof chosen !== 'boolean') throw new Error('Choose Private or Shown by name');
      if (occasion_id !== undefined && (typeof occasion_id !== 'string' || occasion_id === '')) throw new Error('Choose the occasion');
      const found = deps.event(slug, source_id);
      if (!found) throw new Error('That event is not in Recued’s copy of its calendar');
      const { event, calendar_name } = found;
      const held = holding(slug, source_id);
      const owner = held ? deps.history.occasion(held.occasion_id) : null;
      if (held && owner) {
        // Held already: the tick's Private is its occasion's, and nothing else changes.
        if (occasion_id !== undefined && occasion_id !== owner.id) throw new Error(`That event belongs to ${owner.title} already`);
        if (!held.adopted) throw new Error('That event is the occasion’s own: change it in Yours');
        return save({ ...inputOf(owner), private: chosen });
      }
      // A link its occasion outlived: let go, so the tick holds the event afresh.
      if (held) releaseHeldEvent(deps.db, held.occasion_id, source_id);
      if (!offered(event)) throw new Error('An occasion can hold only an event still to come, and not one of a repeating series');
      const when = whenOf(event);
      const organizer = organizerOf(event);
      const timed = when.time !== undefined ? { time: when.time, time_zone: when.time_zone! } : {};
      let saved: Occasion; let adopted: AdoptedEvent;
      if (occasion_id !== undefined) {
        const occasion = deps.history.occasion(occasion_id);
        if (!occasion) throw new Error('Occasion not found');
        if (occasionWaitingForNext(occasion, today()) === undefined) throw new Error(`${occasion.title} is not waiting for its next date`);
        // Its date as it was, put back if the event is let go.
        const before: NonNullable<AdoptedEvent['before']> = { month_day: occasion.month_day,
          ...(occasion.source_next_on !== undefined ? { source_next_on: occasion.source_next_on } : {}),
          ...(occasion.time !== undefined ? { time: occasion.time, time_zone: occasion.time_zone } : {}),
          ...(occasion.alert_minutes !== undefined ? { alert_minutes: occasion.alert_minutes } : {}) };
        const { time: _time, time_zone: _zone, alert_minutes: alert, ...rest } = inputOf(occasion);
        // An alert is minutes before a time: kept with one, gone for a whole day.
        saved = save({ ...rest, ...timed, ...(when.time !== undefined && alert !== undefined ? { alert_minutes: alert } : {}),
          month_day: when.on.slice(5), source_next_on: when.on, private: chosen });
        adopted = { made: false, before, ...(organizer !== undefined ? { organizer } : {}) };
      } else {
        const person = organizer === undefined ? undefined : deps.contactId?.(organizer) ?? organizer;
        saved = save({ title: event.summary.trim().slice(0, TITLE_MAX) || 'Appointment', month_day: when.on.slice(5), source_next_on: when.on,
          people: person === undefined ? [] : [person], ...(event.location?.trim() ? { where: deps.history.place(event.location.trim()) } : {}),
          muted: false, private: chosen, rules: [], ...timed });
        adopted = { made: true, ...(organizer !== undefined ? { organizer } : {}) };
      }
      holdAdoptedEvent(deps.db, { occasion_id: saved.id, cycle: when.on, slug, calendar_id: event.calendar_id, name: calendar_name, source_id,
        fields: fieldsOf(event), adopted, ...(event.ical_uid ? { ical_uid: event.ical_uid } : {}), at: deps.now() });
      return saved;
    },
    release({ slug, source_id }) {
      const held = holding(slug, source_id);
      if (!held) return 'none';
      if (!held.adopted) throw new Error('That event is the occasion’s own: untick In my calendar in Yours');
      const occasion = deps.history.occasion(held.occasion_id);
      if (occasion && held.adopted.made && occasion.rules.some(rule => rule.enabled && rule.consequence === 'floor')) {
        throw new Error(`${occasion.title} has a safety, legal or travel clock: remove it in Yours`);
      }
      releaseHeldEvent(deps.db, held.occasion_id, source_id);
      if (!occasion) return 'none';
      if (held.adopted.made) { deps.history.deleteOccasion(occasion.id); return 'removed'; }
      const before = held.adopted.before;
      if (before === undefined) return 'let_go';
      const { time: _time, time_zone: _zone, alert_minutes: _alert, source_next_on: _next, ...rest } = inputOf(occasion);
      save({ ...rest, month_day: before.month_day, ...(before.source_next_on !== undefined ? { source_next_on: before.source_next_on } : {}),
        ...(before.time !== undefined ? { time: before.time, time_zone: before.time_zone } : {}),
        ...(before.alert_minutes !== undefined ? { alert_minutes: before.alert_minutes } : {}) });
      return 'waiting';
    },
  };
};

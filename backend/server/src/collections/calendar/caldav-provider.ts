/** D-117 Phase 5 — CalDAV calendar adapter.
 *
 *  Implements `CalendarProvider` against an RFC 4791 CalDAV server
 *  (iCloud / Fastmail / Nextcloud / SOGo / Radicale) over basic or
 *  app-password auth. No WebDAV SDK — CalDAV is HTTP + XML + iCal and
 *  shipping a general-purpose WebDAV client would dwarf the code we
 *  actually need.
 *
 *  Requests:
 *    PROPFIND   <calendar_home_url>               — list calendars
 *    REPORT     <calendar_url>                    — calendar-query →
 *                                                    { href, etag }[]
 *    GET        <event_href>                      — fetch VEVENT body
 *    PUT        <calendar_url>/<uid>.ics          — create / update
 *    DELETE     <event_href>                      — delete
 *    POST       <scheduling_outbox>               — iTIP dry-run (rsvp
 *                                                    probe)
 *
 *  Incremental sync uses ETags per event — no sync-token or deltaLink.
 *  Each tick:
 *    1. REPORT calendar-query for the window → current
 *       `{ href, etag }[]`.
 *    2. Diff against the previous `{ href → etag }` map (kept in the
 *       account store so restart doesn't drop state).
 *    3. Fetch + emit changed / new events. Removed hrefs emit
 *       `{ kind: 'deleted', source_id }`.
 *
 *  Expansion is local: the adapter parses RRULE / EXDATE from the
 *  VEVENT and expands the common freq patterns
 *  (DAILY / WEEKLY / MONTHLY / YEARLY × INTERVAL × COUNT / UNTIL ×
 *  BYDAY) inside the configured `[past_days, future_days]` window.
 *  RRULE variants we can't expand fall back to the DTSTART instance
 *  only and bump `pending_series_expansions` for visibility.
 *
 *  Mutation methods return a verified `ProviderEventPayload` on 2xx
 *  success or throw `CalendarAdapterError`. Same
 *  verified-then-reflected invariant as gcal / graph.
 *
 *  rsvp is a conditional capability — the adapter probes iTIP support
 *  once at enrollment by POSTing a no-op METHOD:REPLY to the
 *  scheduling outbox (when discovered). Success → cap `'yes'`,
 *  4xx/5xx → cap `'no'`. Probe failures do not fail enrollment; they
 *  just pin rsvp to `'no'` for the lifetime of the instance.
 */

import { createHash } from 'node:crypto';

import {
  CalendarAdapterError,
  type CanonicalEvent,
} from '@recued/contracts';
import {
  icsClock,
  readIcsDateTime,
  readIcsDuration,
  unescapeIcsText,
  type IcsClock,
  type IcsContentLine,
} from '@recued/transforms';
import { makeBoundedOriginHttpFetcher } from '../../bounded-origin-http-fetcher.js';

import {
  addComponentProperties,
  cloneComponentLines,
  componentProps,
  componentsNamed,
  createIcsEditor,
  escapeIcsText,
  firstProp,
  foldIcsLine,
  icsDateTimeValue,
  icsDateValue,
  icsLine,
  icsTimeLine,
  icsTimeLineFromWall,
  instantInForm,
  isUtcZoneName,
  parseIcsDoc,
  propParam,
  setComponentProperty,
  vtimezoneLines,
  wallInForm,
  type IcsDoc,
  type IcsDocComponent,
  type IcsEditor,
  type IcsTimeForm,
} from './caldav-ics.js';
import type {
  CalendarProvider,
  CalendarProviderHealth,
  CalendarSeriesSnapshot,
  CalendarSyncCallback,
  CalendarSyncEvent,
  CreateEventInput,
  DeleteEventInput,
  InitialScanOptions,
  ProbedCalendarCaps,
  ProviderEventPayload,
  RsvpEventInput,
  UpdateEventInput,
} from './provider.js';
import type {
  CalendarAdapterContext,
  CalendarAdapterFactory,
} from './adapter-registry.js';
import type { HttpFetcher } from '../mail/oauth.js';
import {
  startDrainingInterval,
  type ProviderPollScheduler,
  type ProviderPollStop,
} from '../draining-interval.js';

/** CalDAV REPORT responses can include event bodies, so retain the provider
 * ceiling used by mail/calendar APIs while keeping it finite. */
const defaultCalDavFetcher: HttpFetcher = makeBoundedOriginHttpFetcher({
  maxResponseBytes: 32 * 1024 * 1024,
});

// ────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────

export interface CalDavProviderConfig {
  /** Full server URL, e.g. "https://caldav.fastmail.com" (no trailing
   *  slash required — we normalise). */
  server_url: string;
  /** CalDAV username — sometimes an email, sometimes a short name. */
  username: string;
  /** Password / app-password. Never stored on the instance row —
   *  composition root sources this from the vault at construction
   *  time. */
  password: string;
  /** Calendar-home URL. Users supply this at enrollment time since
   *  `.well-known/caldav` autodiscovery is out of scope for D-117. */
  calendar_home_url: string;
  /** Optional scheduling-outbox URL for the iTIP probe. Nullable —
   *  `probe_rsvp` pins `caps.rsvp` to `'no'` when absent. */
  scheduling_outbox_url?: string;
  /** Forward expansion window in days. */
  expansion_future_days: number;
  /** Backward expansion window in days. */
  expansion_past_days: number;
  /** Poll cadence for the ongoing sync loop. */
  poll_seconds: number;
  /** Calendars to sync. Empty = every calendar discovered at home. */
  calendar_filter?: string[];
  /** When false, the iTIP RSVP probe is skipped and `caps.rsvp` is
   *  pinned to `'no'`. Servers without iTIP support can set this to
   *  avoid noisy probe attempts. Default true. */
  probe_rsvp?: boolean;
}

export interface CreateCalDavProviderOptions {
  slug: string;
  config: CalDavProviderConfig;
  fetcher?: HttpFetcher;
  etagStore: CalDavEtagStore;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  scheduler?: ProviderPollScheduler;
  /** The owner's IANA zone, read per use. A time naming no zone (a floating
   *  one) is read in the calendar's own zone, else this one; absent, UTC. */
  timeZone?: () => string | undefined;
}

/** Persistent per-event ETag cache. Keyed by `(calendar_id, href)` ↦ the
 *  resource's ETag and UID (`{"v":2,…}`; a bare ETag before 2026-10-07).
 *  Same shape as the OAuth account store so tests can share the in-memory
 *  double; production wires this to the server's account store. */
export interface CalDavEtagStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** List keys under a prefix so we can diff remote against local. */
  list(prefix: string): Promise<Array<{ key: string; value: string }>>;
}

// ────────────────────────────────────────────────────────────────
// DAV XML — narrow parser (only the shapes this adapter needs)
// ────────────────────────────────────────────────────────────────

/** Match an opening tag with optional namespace prefix. Captures are
 *  not used; the regex is consumed by indexOf + extraction below. */
const tagOpen = (name: string): RegExp =>
  new RegExp(`<(?:\\w+:)?${name}(\\s[^>]*)?>`, 'i');
const tagClose = (name: string): RegExp =>
  new RegExp(`</(?:\\w+:)?${name}\\s*>`, 'i');

const innerOf = (xml: string, tag: string): string | null => {
  const open = xml.search(tagOpen(tag));
  if (open < 0) return null;
  const afterOpen = xml.indexOf('>', open) + 1;
  const close = xml.search(tagClose(tag));
  if (close < afterOpen) return null;
  return xml.slice(afterOpen, close);
};

const allBlocks = (xml: string, tag: string): string[] => {
  const out: string[] = [];
  let cursor = 0;
  const openRegex = tagOpen(tag);
  const closeRegex = tagClose(tag);
  while (cursor < xml.length) {
    const rel = xml.slice(cursor).search(openRegex);
    if (rel < 0) break;
    const open = cursor + rel;
    const afterOpen = xml.indexOf('>', open) + 1;
    const closeRel = xml.slice(afterOpen).search(closeRegex);
    if (closeRel < 0) break;
    const close = afterOpen + closeRel;
    out.push(xml.slice(afterOpen, close));
    // Advance past the closing tag to avoid re-matching nested
    // siblings inside the same response.
    cursor = xml.indexOf('>', close) + 1;
    if (cursor <= close) cursor = close + 1;
  }
  return out;
};

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export interface CalDavCalendarEntry {
  href: string;
  displayname: string;
  /** True when the `resourcetype` includes `<calendar/>` — filters
   *  out `addressbook` collections returned by the same PROPFIND. */
  isCalendar: boolean;
}

export interface CalDavReportEntry {
  href: string;
  etag: string;
  calendarData?: string;
}

/** Parse a PROPFIND multistatus response into the subset of calendar
 *  entries we care about. */
export const parseCalendarHomePropfind = (
  xml: string,
): CalDavCalendarEntry[] => {
  const multi = innerOf(xml, 'multistatus');
  if (!multi) return [];
  const responses = allBlocks(multi, 'response');
  const out: CalDavCalendarEntry[] = [];
  for (const response of responses) {
    const href = (innerOf(response, 'href') ?? '').trim();
    if (!href) continue;
    const propstat = allBlocks(response, 'propstat');
    for (const ps of propstat) {
      const prop = innerOf(ps, 'prop');
      if (!prop) continue;
      const displayname = (innerOf(prop, 'displayname') ?? '').trim();
      const resourcetype = innerOf(prop, 'resourcetype') ?? '';
      const isCalendar = /<(?:\w+:)?calendar\s*\/>|<(?:\w+:)?calendar\s*>/i
        .test(resourcetype);
      out.push({
        href,
        displayname: decodeXml(displayname),
        isCalendar,
      });
    }
  }
  return out;
};

/** Parse a REPORT calendar-query multistatus into
 *  `{ href, etag, calendar-data? }[]`. */
export const parseCalendarQuery = (xml: string): CalDavReportEntry[] => {
  const multi = innerOf(xml, 'multistatus');
  if (!multi) return [];
  const responses = allBlocks(multi, 'response');
  const out: CalDavReportEntry[] = [];
  for (const response of responses) {
    const href = (innerOf(response, 'href') ?? '').trim();
    if (!href) continue;
    let etag = '';
    let calendarData: string | undefined;
    for (const ps of allBlocks(response, 'propstat')) {
      const prop = innerOf(ps, 'prop');
      if (!prop) continue;
      const getetag = innerOf(prop, 'getetag');
      if (getetag) etag = decodeXml(getetag.trim());
      const cd = innerOf(prop, 'calendar-data');
      if (cd) calendarData = decodeXml(cd.trim());
    }
    if (etag) {
      out.push(
        calendarData
          ? { href, etag, calendarData }
          : { href, etag },
      );
    }
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// iCalendar — an event resource read as its zones say
// ────────────────────────────────────────────────────────────────
//
// ⛔⛔ A TIME IS READ IN ITS OWN ZONE (2026-10-07). This adapter read
// `DTSTART;TZID=America/Los_Angeles:20261017T100000` as 10:00 UTC — 03:00 in
// Los Angeles — so every timed event Apple Calendar, Fastmail or Nextcloud
// wrote with its zone sat hours off in Recued, by the zone's offset. A time
// is now read the way invites are (`@recued/transforms`' `icsClock`): the
// object's own `VTIMEZONE` rules, then the IANA name, then — for a time
// naming no zone — the calendar's `X-WR-TIMEZONE`, else the owner's zone.
//
// A series is counted on its own clock: a weekly 10:00 stays 10:00 across a
// change of clocks. An occurrence's id keeps the wall clock it starts at in
// the series' zone (the digits read as UTC), which is the number this adapter
// always wrote there — so the ids of stored occurrences did not change when
// their times were corrected.

export interface ParsedAttendee {
  email: string;
  displayName?: string;
  responseStatus: 'accepted' | 'declined' | 'tentative' | 'needs_action';
  isSelf?: boolean;
}

export interface ParsedVEvent {
  uid: string;
  summary?: string;
  description?: string;
  location?: string;
  /** Unix-ms UTC of DTSTART, read in its zone. All-day → midnight UTC of the
   *  date. */
  dtstart: number;
  /** Unix-ms UTC of DTEND (or DTSTART + DURATION). */
  dtend: number;
  /** The `TZID` as written; `"UTC"` for a `Z` time; for a floating time, the
   *  zone it was read in. An all-day event keeps a `TZID` it carries, else
   *  `"UTC"`. */
  timezone: string;
  isAllDay: boolean;
  status: 'confirmed' | 'cancelled' | 'tentative';
  rrule?: string;
  /** Every EXDATE value — a line may hold several — as an instant (all-day:
   *  midnight UTC of the date). */
  exdates: number[];
  /** An override's RECURRENCE-ID, as an instant. */
  recurrenceId?: number;
  organizer?: { email: string; displayName?: string };
  attendees?: ParsedAttendee[];
  createdAt: number;
  lastModifiedAt: number;
  sequence: number;
}

/** One VEVENT as read, with what writing it back needs. */
export interface CalDavVEvent extends ParsedVEvent {
  readonly component: IcsDocComponent;
  /** How its DTSTART is written: every time written for it takes this form,
   *  so an edit keeps the zone the event's own app gave it. */
  readonly startForm: IcsTimeForm;
  /** DTSTART's wall clock in that form (`dtstart` for UTC and all-day). */
  readonly startWall: number;
  readonly exdateValues: ReadonlyArray<{ readonly at: number; readonly dateOnly: boolean }>;
  /** An override's RECURRENCE-ID, as written: a day, and its wall clock. */
  readonly recurrenceDateOnly: boolean;
  readonly recurrenceWall?: number;
}

/** One calendar object resource: its file, the clock its times are read on,
 *  the series (or single event), and the occurrences it overrides. */
export interface CalDavObject {
  readonly doc: IcsDoc;
  readonly clock: IcsClock;
  readonly uid: string;
  /** The VEVENT without a RECURRENCE-ID; `null` when the file holds only
   *  occurrences of a series kept elsewhere (an invite to one of them). */
  readonly master: CalDavVEvent | null;
  readonly overrides: readonly CalDavVEvent[];
}

export interface CalDavReadOptions {
  /** The owner's IANA zone, for a time naming no zone. */
  readonly timeZone?: string;
  readonly warn?: (message: string) => void;
}

/** A UID this adapter can keep as given (D-315 slice 7): it names the event's
 *  `.ics` file and sits in a `source_id` split on `:`, so no `:`, `/`, `%` or
 *  space. Google's, Outlook's, Apple's and the booking services' all fit. */
const CALDAV_SAFE_UID = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,254}$/;

const DAY_MS = 86_400_000;

/** The form a time in this TZID is written in. */
const zoneForm = (tzid: string | undefined, clock: IcsClock, warn?: (m: string) => void): IcsTimeForm => {
  const floating = clock.zone(undefined, false);
  if (tzid === undefined || tzid.length === 0) return { kind: 'floating', zone: floating };
  const zone = clock.zone(tzid, false);
  if (zone.basis !== 'unresolved') return { kind: 'zoned', tzid, zone };
  // ⚠ A zone nothing reads: no rules in the file and no name the platform
  // knows. The invite reader leaves such a time unread; a calendar mirror
  // must hold every event, so it is read — and written back — on the
  // calendar's, else the owner's clock, under the TZID it came with.
  warn?.(`caldav: time zone "${tzid}" is not one this server can read; its times are read in the owner's zone`);
  return { kind: 'zoned', tzid, zone: { ...floating, name: tzid } };
};

interface ReadTime {
  readonly at: number;
  readonly wall: number;
  readonly dateOnly: boolean;
  readonly form: IcsTimeForm;
}

const readTime = (
  prop: IcsContentLine,
  value: string,
  clock: IcsClock,
  warn?: (m: string) => void,
): ReadTime | null => {
  const raw = readIcsDateTime(value, propParam(prop, 'VALUE'));
  if (raw === null) return null;
  if (raw.dateOnly) return { at: raw.wall, wall: raw.wall, dateOnly: true, form: { kind: 'date' } };
  if (raw.utc) return { at: raw.wall, wall: raw.wall, dateOnly: false, form: { kind: 'utc' } };
  const form = zoneForm(propParam(prop, 'TZID')?.trim(), clock, warn);
  const at = instantInForm(raw.wall, form);
  return at === null ? null : { at, wall: raw.wall, dateOnly: false, form };
};

/** A stamp (CREATED, LAST-MODIFIED): UTC by the RFC; a floating one is read as
 *  UTC too. */
const readStamp = (prop: IcsContentLine | undefined): number | undefined => {
  if (prop === undefined) return undefined;
  const raw = readIcsDateTime(prop.value);
  return raw === null ? undefined : raw.wall;
};

const mailtoOf = (value: string): string | null => {
  const at = value.toLowerCase().indexOf('mailto:');
  if (at < 0) return null;
  const email = value.slice(at + 'mailto:'.length).trim();
  return email.length > 0 ? email : null;
};

const partstatOf = (prop: IcsContentLine): ParsedAttendee['responseStatus'] => {
  const part = (propParam(prop, 'PARTSTAT') ?? '').toUpperCase();
  return part === 'ACCEPTED'
    ? 'accepted'
    : part === 'DECLINED'
      ? 'declined'
      : part === 'TENTATIVE'
        ? 'tentative'
        : 'needs_action';
};

const attendeeOf = (prop: IcsContentLine): ParsedAttendee | null => {
  const email = mailtoOf(prop.value);
  if (email === null) return null;
  const cn = propParam(prop, 'CN');
  return { email, ...(cn ? { displayName: cn } : {}), responseStatus: partstatOf(prop) };
};

/** Read one VEVENT — its own properties only, so a reminder's DESCRIPTION or
 *  ATTENDEE stays the reminder's. `null` without a UID or a readable start. */
const readVEvent = (
  doc: IcsDoc,
  component: IcsDocComponent,
  clock: IcsClock,
  warn?: (m: string) => void,
): CalDavVEvent | null => {
  const one = (name: string): IcsContentLine | undefined => firstProp(doc, component, name);
  const uid = one('UID')?.value.trim();
  const dtstartProp = one('DTSTART');
  if (!uid || dtstartProp === undefined) return null;
  const start = readTime(dtstartProp, dtstartProp.value, clock, warn);
  if (start === null) return null;
  const isAllDay = start.dateOnly;

  let dtend = isAllDay ? start.at + DAY_MS : start.at;
  const dtendProp = one('DTEND');
  const durationProp = one('DURATION');
  if (dtendProp !== undefined) {
    const end = readTime(dtendProp, dtendProp.value, clock, warn);
    if (end !== null && end.dateOnly === isAllDay) dtend = end.at;
  } else if (durationProp !== undefined) {
    const duration = readIcsDuration(durationProp.value);
    if (duration !== null) {
      // Days on the calendar, then the exact time, on the start's own clock.
      const dayShifted = duration.days === 0
        ? start.at
        : instantInForm(start.wall + duration.days * DAY_MS, start.form);
      dtend = (dayShifted ?? start.at + duration.days * DAY_MS) + duration.ms;
    }
  }
  if (dtend < start.at) dtend = start.at;

  const exdateValues: Array<{ at: number; dateOnly: boolean }> = [];
  for (const { prop } of componentProps(doc, component, 'EXDATE')) {
    for (const item of prop.value.split(',')) {
      const t = readTime(prop, item.trim(), clock, warn);
      if (t !== null) exdateValues.push({ at: t.at, dateOnly: t.dateOnly });
    }
  }
  const ridProp = one('RECURRENCE-ID');
  const rid = ridProp === undefined ? null : readTime(ridProp, ridProp.value, clock, warn);

  const statusValue = (one('STATUS')?.value ?? '').trim().toUpperCase();
  const status: ParsedVEvent['status'] =
    statusValue === 'CANCELLED' ? 'cancelled' : statusValue === 'TENTATIVE' ? 'tentative' : 'confirmed';
  const organizerProp = one('ORGANIZER');
  const organizer = organizerProp === undefined ? null : attendeeOf(organizerProp);
  const attendees = componentProps(doc, component, 'ATTENDEE')
    .map(({ prop }) => attendeeOf(prop))
    .filter((a): a is ParsedAttendee => a !== null);
  const text = (name: string): string | undefined => {
    const prop = one(name);
    return prop === undefined ? undefined : unescapeIcsText(prop.value);
  };
  const createdAt = readStamp(one('CREATED'));
  const lastModifiedAt = readStamp(one('LAST-MODIFIED'));
  const sequence = Number((one('SEQUENCE')?.value ?? '0').trim());
  const timezone = isAllDay
    ? (propParam(dtstartProp, 'TZID')?.trim() || 'UTC')
    : start.form.kind === 'utc'
      ? 'UTC'
      : start.form.kind === 'zoned'
        ? start.form.tzid
        : start.form.kind === 'floating'
          ? start.form.zone.name
          : 'UTC';
  return {
    uid,
    summary: text('SUMMARY'),
    description: text('DESCRIPTION'),
    location: text('LOCATION'),
    dtstart: start.at,
    dtend,
    timezone,
    isAllDay,
    status,
    rrule: one('RRULE')?.value.trim() || undefined,
    exdates: exdateValues.map((e) => e.at),
    recurrenceId: rid?.at,
    organizer: organizer === null
      ? undefined
      : { email: organizer.email, ...(organizer.displayName ? { displayName: organizer.displayName } : {}) },
    attendees: attendees.length > 0 ? attendees : undefined,
    createdAt: createdAt ?? start.at,
    lastModifiedAt: lastModifiedAt ?? createdAt ?? start.at,
    sequence: Number.isFinite(sequence) && sequence >= 0 ? sequence : 0,
    component,
    startForm: start.form,
    startWall: start.wall,
    exdateValues,
    recurrenceDateOnly: rid?.dateOnly ?? false,
    ...(rid !== null ? { recurrenceWall: rid.wall } : {}),
  };
};

/** Read a calendar object resource: the series (or single event) and the
 *  occurrences it overrides. `null` when it holds no event this can read. */
export const readCalDavObject = (raw: string, opts: CalDavReadOptions = {}): CalDavObject | null => {
  const doc = parseIcsDoc(raw);
  const clock = icsClock(raw, opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {});
  const events = componentsNamed(doc, 'VEVENT')
    .map((component) => readVEvent(doc, component, clock, opts.warn))
    .filter((e): e is CalDavVEvent => e !== null);
  if (events.length === 0) return null;
  const master = events.find((e) => e.recurrenceId === undefined) ?? null;
  const uid = (master ?? events[0]!).uid;
  const overrides = events.filter((e) => e.recurrenceId !== undefined && e.uid === uid);
  return { doc, clock, uid, master, overrides };
};

/** The series' VEVENT (or the single event), else the first override. */
export const parseVEvent = (raw: string, opts: CalDavReadOptions = {}): ParsedVEvent | null => {
  const object = readCalDavObject(raw, opts);
  return object === null ? null : (object.master ?? object.overrides[0] ?? null);
};

// ────────────────────────────────────────────────────────────────
// RRULE expander (narrow — common cases only)
// ────────────────────────────────────────────────────────────────

export interface RRuleExpansionWindow {
  windowStart: number;
  windowEnd: number;
}

interface ParsedRRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'UNKNOWN';
  interval: number;
  count?: number;
  until?: number;
  byday?: Set<number>; // 0=Sunday..6=Saturday
}

const DAY_CODE: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export const parseRRuleString = (rrule: string): ParsedRRule => {
  const parts = rrule.split(';');
  const kv: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    kv[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  const freqRaw = (kv.FREQ ?? '').toUpperCase();
  const freq: ParsedRRule['freq'] =
    freqRaw === 'DAILY' ||
    freqRaw === 'WEEKLY' ||
    freqRaw === 'MONTHLY' ||
    freqRaw === 'YEARLY'
      ? freqRaw
      : 'UNKNOWN';
  const interval = Number(kv.INTERVAL ?? '1') || 1;
  const count =
    kv.COUNT !== undefined ? Math.max(0, Number(kv.COUNT)) : undefined;
  let until: number | undefined;
  if (kv.UNTIL) {
    // The digits as UTC: a `Z` UNTIL is that instant, and a series counted
    // on its own clock passes its wall-clock UNTIL to `expandRRule` instead.
    const parsed = readIcsDateTime(kv.UNTIL);
    if (parsed !== null && parsed.wall > 0) until = parsed.wall;
  }
  const byday = kv.BYDAY
    ? new Set(
        kv.BYDAY.split(',')
          .map((d) => d.trim().slice(-2).toUpperCase())
          .filter((d): d is keyof typeof DAY_CODE => d in DAY_CODE)
          .map((d) => DAY_CODE[d]),
      )
    : undefined;
  return { freq, interval, count, until, byday };
};

/** Expand an RRULE against the configured window. Returns sorted
 *  occurrence starts on the clock `dtstart` is on — unix-ms UTC for a UTC
 *  series; for a zoned or floating one, wall clocks (the digits read as UTC),
 *  which `expandCalDavObject` turns into instants so a weekly 10:00 stays
 *  10:00 across a change of clocks. Includes DTSTART only when it falls
 *  within the window.
 *
 *  Supported: FREQ × INTERVAL × {COUNT | UNTIL} × BYDAY (WEEKLY).
 *  Anything else returns only the DTSTART instance; caller should
 *  treat as a partial expansion and bump the pending-expansions
 *  counter for visibility.
 *
 *  Deliberately narrow — full RRULE expansion is a separate concern
 *  and `rrule.js` can drop in later without touching the adapter
 *  surface. */
export const expandRRule = (
  dtstart: number,
  rrule: string | undefined,
  exdates: number[],
  window: RRuleExpansionWindow,
  /** The rule's last start on the clock `dtstart` is on — a `Z` UNTIL moved
   *  onto a zoned series' wall clock. Absent: the rule's UNTIL as written. */
  bounds: { readonly until?: number } = {},
): { instances: number[]; partial: boolean } => {
  const exclude = new Set(exdates);
  if (!rrule) {
    const inWin =
      dtstart >= window.windowStart && dtstart <= window.windowEnd;
    return {
      instances: inWin && !exclude.has(dtstart) ? [dtstart] : [],
      partial: false,
    };
  }
  const parsed = parseRRuleString(rrule);
  if (parsed.freq === 'UNKNOWN') {
    const inWin =
      dtstart >= window.windowStart && dtstart <= window.windowEnd;
    return {
      instances: inWin && !exclude.has(dtstart) ? [dtstart] : [],
      partial: true,
    };
  }

  const stepMs = (base: number, n: number): number => {
    const d = new Date(base);
    switch (parsed.freq) {
      case 'DAILY':
        return d.setUTCDate(d.getUTCDate() + n * parsed.interval);
      case 'WEEKLY':
        return d.setUTCDate(d.getUTCDate() + n * 7 * parsed.interval);
      case 'MONTHLY':
        return d.setUTCMonth(d.getUTCMonth() + n * parsed.interval);
      case 'YEARLY':
        return d.setUTCFullYear(d.getUTCFullYear() + n * parsed.interval);
      default:
        return base;
    }
  };

  const out: number[] = [];
  // Hard cap iterations so a runaway RRULE can't OOM us. 10k covers
  // ~27 years of daily occurrences — plenty for meeting-scale
  // calendars with practical expansion windows.
  const HARD_CAP = 10_000;
  const limitUntil = bounds.until ?? parsed.until ?? window.windowEnd;
  const limitCount = parsed.count ?? HARD_CAP;
  let emitted = 0;
  for (let n = 0; emitted < limitCount && n < HARD_CAP; n++) {
    const at = n === 0 ? dtstart : stepMs(dtstart, n);
    if (at > limitUntil) break;
    if (parsed.freq === 'WEEKLY' && parsed.byday && parsed.byday.size > 0) {
      // BYDAY for WEEKLY — expand within the same ISO week.
      const weekStart = at; // at == dtstart for n=0, offset by n weeks otherwise
      for (let d = 0; d < 7; d++) {
        const candidate = new Date(weekStart);
        candidate.setUTCDate(candidate.getUTCDate() + d);
        const candidateMs = candidate.getTime();
        if (candidateMs > limitUntil) break;
        if (emitted >= limitCount) break;
        if (!parsed.byday.has(candidate.getUTCDay())) continue;
        if (candidateMs < dtstart) continue;
        if (exclude.has(candidateMs)) continue;
        if (
          candidateMs >= window.windowStart &&
          candidateMs <= window.windowEnd
        ) {
          out.push(candidateMs);
        }
        emitted++;
      }
    } else {
      if (exclude.has(at)) {
        emitted++;
        continue;
      }
      if (at >= window.windowStart && at <= window.windowEnd) {
        out.push(at);
      }
      emitted++;
    }
    // Early exit: if we're past the window end and not emitting into it,
    // stop.
    if (at > window.windowEnd && parsed.freq !== 'WEEKLY') break;
  }
  out.sort((a, b) => a - b);
  return { instances: out, partial: false };
};

/** Cap an RRULE so the series ends at `untilValue` (a serialised iCal
 *  DATE or UTC DATE-TIME). Strips any existing `UNTIL` and any `COUNT`
 *  — the two are mutually exclusive per RFC 5545 §3.3.10 — then
 *  appends the new `UNTIL`. Used to truncate a master series strictly
 *  before a `this_and_future` split point. Empty / whitespace parts
 *  are dropped so a trailing `;` can't produce a malformed rule. */
export const capRRuleUntil = (rrule: string, untilValue: string): string => {
  const kept = rrule
    .split(';')
    .map((p) => p.trim())
    .filter((p) => {
      if (!p) return false;
      const key = p.split('=')[0]?.toUpperCase();
      return key !== 'UNTIL' && key !== 'COUNT';
    });
  kept.push(`UNTIL=${untilValue}`);
  return kept.join(';');
};

/** The cadence the new (forward) series of a `this_and_future` split
 *  carries. UNTIL-bounded + unbounded rules split exactly with the
 *  rule verbatim. A COUNT-bounded master, though, must NOT re-run the
 *  full count from the split point — that manufactures
 *  `(occurrences-before-split)` phantom events. Recompute the tail:
 *  `remaining = COUNT − rawOccurrencesStrictlyBefore(splitAt)`. The
 *  count is over the raw RRULE (no EXDATE applied) because EXDATE'd
 *  occurrences still consume COUNT per RFC 5545 §3.3.10. */
export const newSeriesRRule = (
  rrule: string,
  masterDtstart: number,
  splitAt: number,
): string => {
  const parsed = parseRRuleString(rrule);
  if (parsed.count === undefined) return rrule;
  const before = expandRRule(masterDtstart, rrule, [], {
    windowStart: masterDtstart,
    windowEnd: splitAt - 1,
  }).instances.length;
  const remaining = Math.max(1, parsed.count - before);
  return rrule
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      p.toUpperCase().startsWith('COUNT=') ? `COUNT=${remaining}` : p,
    )
    .join(';');
};

// ────────────────────────────────────────────────────────────────
// Occurrences and canonicalization
// ────────────────────────────────────────────────────────────────

/** One occurrence: the slot it fills in its series — its key, the wall clock
 *  it starts at on the series' clock — and the VEVENT that says what it is:
 *  the series, or the override written for that slot. */
export interface CalDavOccurrence {
  readonly key: number;
  readonly event: CalDavVEvent;
  readonly start: number;
  readonly end: number;
}

/** No zone is more than 14 hours from UTC: a series is expanded this far past
 *  each end of the window on its own clock, then cut to the window by
 *  instant. */
const ZONE_SLACK_MS = 15 * 3_600_000;

const timeOfDay = (wall: number): number => ((wall % DAY_MS) + DAY_MS) % DAY_MS;

/** The key of a time naming one of a series' occurrences (an EXDATE, a
 *  RECURRENCE-ID): its wall clock on the series' clock. A day names the
 *  series' occurrence on that day. */
const occurrenceKey = (series: CalDavVEvent, at: number, dateOnly: boolean): number | null => {
  if (dateOnly) return series.startForm.kind === 'date' ? at : at + timeOfDay(series.startWall);
  if (series.startForm.kind === 'date') return Math.floor(at / DAY_MS) * DAY_MS;
  return wallInForm(at, series.startForm);
};

const overrideKey = (object: CalDavObject, override: CalDavVEvent): number | null => {
  if (override.recurrenceId === undefined) return null;
  if (object.master === null) return override.recurrenceWall ?? null;
  return occurrenceKey(object.master, override.recurrenceId, override.recurrenceDateOnly);
};

/** The series' UNTIL on its own clock: a `Z` UNTIL (the RFC's form for a
 *  zoned series) moved onto the series' wall clock. */
const untilWallOf = (series: CalDavVEvent): number | undefined => {
  const until = (series.rrule ?? '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.toUpperCase().startsWith('UNTIL='))
    ?.slice('UNTIL='.length);
  if (until === undefined) return undefined;
  const raw = readIcsDateTime(until);
  if (raw === null) return undefined;
  if (raw.dateOnly) return series.startForm.kind === 'date' ? raw.wall : raw.wall + DAY_MS - 1000;
  if (raw.utc) return wallInForm(raw.wall, series.startForm) ?? undefined;
  return raw.wall;
};

/** Every occurrence of a calendar object starting inside the window: the
 *  series counted on its own clock, each override in its slot, its EXDATEs
 *  left out. `partial` when the rule is one this cannot expand. */
export const expandCalDavObject = (
  object: CalDavObject,
  window: RRuleExpansionWindow,
): { occurrences: CalDavOccurrence[]; partial: boolean } => {
  const inWindow = (at: number): boolean => at >= window.windowStart && at <= window.windowEnd;
  const occurrences: CalDavOccurrence[] = [];
  const master = object.master;
  if (master === null) {
    for (const o of object.overrides) {
      const key = overrideKey(object, o);
      if (key !== null && inWindow(o.dtstart)) occurrences.push({ key, event: o, start: o.dtstart, end: o.dtend });
    }
    occurrences.sort((a, b) => a.start - b.start);
    return { occurrences, partial: false };
  }
  const excluded = new Set<number>();
  for (const e of master.exdateValues) {
    const key = occurrenceKey(master, e.at, e.dateOnly);
    if (key !== null) excluded.add(key);
  }
  const overrides = new Map<number, CalDavVEvent>();
  for (const o of object.overrides) {
    const key = overrideKey(object, o);
    if (key !== null && !overrides.has(key)) overrides.set(key, o);
  }
  const until = untilWallOf(master);
  const { instances, partial } = expandRRule(
    master.startWall,
    master.rrule,
    [],
    { windowStart: window.windowStart - ZONE_SLACK_MS, windowEnd: window.windowEnd + ZONE_SLACK_MS },
    until !== undefined ? { until } : {},
  );
  const duration = master.dtend - master.dtstart;
  const placed = new Set<number>();
  for (const key of instances) {
    if (excluded.has(key)) continue;
    const slot = instantInForm(key, master.startForm);
    const override = overrides.get(key);
    if (override !== undefined) {
      placed.add(key);
      if (inWindow(override.dtstart) || (slot !== null && inWindow(slot))) {
        occurrences.push({ key, event: override, start: override.dtstart, end: override.dtend });
      }
      continue;
    }
    if (slot === null || !inWindow(slot)) continue;
    occurrences.push({ key, event: master, start: slot, end: slot + duration });
  }
  // An override whose slot the expansion did not reach: moved in from outside
  // the window, or of a rule this cannot expand.
  for (const [key, o] of overrides) {
    if (placed.has(key) || excluded.has(key) || !inWindow(o.dtstart)) continue;
    occurrences.push({ key, event: o, start: o.dtstart, end: o.dtend });
  }
  occurrences.sort((a, b) => a.start - b.start);
  return { occurrences, partial };
};

/** The occurrence a key names — the series' first when `null` — as its
 *  override, else the series' slot. `null` when the object has none there. */
const occurrenceOf = (object: CalDavObject, key: number | null): CalDavOccurrence | null => {
  const master = object.master;
  if (master === null) {
    if (key === null) return null;
    const o = object.overrides.find((x) => overrideKey(object, x) === key);
    return o === undefined ? null : { key, event: o, start: o.dtstart, end: o.dtend };
  }
  const k = key ?? master.startWall;
  const override = object.overrides.find((x) => overrideKey(object, x) === k);
  if (override !== undefined) return { key: k, event: override, start: override.dtstart, end: override.dtend };
  const start = instantInForm(k, master.startForm);
  return start === null ? null : { key: k, event: master, start, end: start + (master.dtend - master.dtstart) };
};

const canonicalOf = (
  object: CalDavObject,
  occurrence: CalDavOccurrence,
  calendarId: string,
  calendarName?: string,
): CanonicalEvent => {
  const ev = occurrence.event;
  const seriesId = `${calendarId}:${object.uid}`;
  const first = object.master !== null && occurrence.key === object.master.startWall;
  const rrule = object.master?.rrule;
  return {
    source_id: first ? seriesId : `${seriesId}:${occurrence.key}`,
    ical_uid: object.uid,
    calendar_id: calendarId,
    ...(calendarName ? { calendar_name: calendarName } : {}),
    summary: ev.summary ?? '',
    ...(ev.description ? { description: ev.description } : {}),
    ...(ev.location ? { location: ev.location } : {}),
    start_at: occurrence.start,
    end_at: occurrence.end,
    timezone: ev.timezone,
    is_all_day: ev.isAllDay,
    ...(ev.organizer
      ? {
          organizer: {
            email: ev.organizer.email,
            ...(ev.organizer.displayName ? { display_name: ev.organizer.displayName } : {}),
          },
        }
      : {}),
    ...(ev.attendees && ev.attendees.length > 0
      ? {
          attendees: ev.attendees.map((a) => ({
            email: a.email,
            ...(a.displayName ? { display_name: a.displayName } : {}),
            response_status: a.responseStatus,
            ...(a.isSelf ? { is_self: true as const } : {}),
          })),
        }
      : {}),
    status: ev.status,
    ...(rrule ? { recurrence_rule: rrule } : {}),
    ...(!first ? { recurring_event_id: seriesId } : {}),
    created_at: ev.createdAt,
    updated_at: ev.lastModifiedAt,
  };
};

const payloadOf = (
  object: CalDavObject,
  occurrence: CalDavOccurrence,
  etag: string,
  calendar: { id: string; displayname: string },
  correction = false,
): ProviderEventPayload => {
  const event = canonicalOf(object, occurrence, calendar.id, calendar.displayname);
  return {
    event,
    description_bytes: event.description ? Buffer.byteLength(event.description, 'utf8') : 0,
    etag,
    ...(correction ? { correction: true } : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// What the adapter remembers per event resource
// ────────────────────────────────────────────────────────────────

/** A resource's ETag and — since its times are read in their zones
 *  (2026-10-07) — the UID it holds, so a resource gone from the server can be
 *  found among the stored rows. A value written before then is the bare ETag:
 *  `legacy`, and its resource is read once more even when unchanged, to
 *  correct its rows. */
interface StoredResource {
  readonly etag: string;
  readonly uid: string | null;
  readonly legacy: boolean;
}

const STORED_RESOURCE_VERSION = 2;

const encodeStored = (etag: string, uid: string): string =>
  JSON.stringify({ v: STORED_RESOURCE_VERSION, etag, uid });

const decodeStored = (value: string | null | undefined): StoredResource | null => {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as { v?: unknown; etag?: unknown; uid?: unknown };
      if (record.v === STORED_RESOURCE_VERSION && typeof record.etag === 'string') {
        return { etag: record.etag, uid: typeof record.uid === 'string' ? record.uid : null, legacy: false };
      }
    }
  } catch {
    // a bare ETag
  }
  return { etag: value, uid: null, legacy: true };
};

const PARTSTAT_VALUE: Readonly<Record<string, string>> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  needs_action: 'NEEDS-ACTION',
};

type EventPatch = UpdateEventInput['patch'];

// ────────────────────────────────────────────────────────────────
// Error mapping
// ────────────────────────────────────────────────────────────────

const toCalDavError = (
  status: number,
  body: string,
  operation: string,
): CalendarAdapterError => {
  if (status === 401 || status === 403) {
    return new CalendarAdapterError(
      'auth_expired',
      `caldav ${operation}: ${status} — credentials rejected`,
      body,
    );
  }
  if (status === 404) {
    return new CalendarAdapterError(
      'event_not_found',
      `caldav ${operation}: 404 — resource not found`,
      body,
    );
  }
  if (status === 412) {
    // Precondition failed — If-Match etag mismatch. Map to
    // event_not_found so the dispatcher can retry via read-through.
    return new CalendarAdapterError(
      'event_not_found',
      `caldav ${operation}: 412 — etag precondition failed (event modified remotely)`,
      body,
    );
  }
  if (status === 507) {
    return new CalendarAdapterError(
      'quota_exceeded',
      `caldav ${operation}: 507 — insufficient storage`,
      body,
    );
  }
  return new CalendarAdapterError(
    'io_error',
    `caldav ${operation}: ${status}`,
    body,
  );
};

// ────────────────────────────────────────────────────────────────
// XML request builders
// ────────────────────────────────────────────────────────────────

const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';
const DAV_NS = 'DAV:';

const calendarHomePropfindBody = (): string =>
  `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

const calendarQueryBody = (
  windowStart: number,
  windowEnd: number,
  includeData: boolean,
): string => {
  const fmt = (t: number): string => {
    const d = new Date(t);
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  };
  const body = includeData
    ? '<d:getetag/><c:calendar-data/>'
    : '<d:getetag/>';
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}">
  <d:prop>${body}</d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${fmt(windowStart)}" end="${fmt(windowEnd)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
};

// ────────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────────

const basicAuthHeader = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const calendarIdFromHref = (href: string): string =>
  createHash('sha1').update(href).digest('hex').slice(0, 24);

export const createCalDavProvider = (
  opts: CreateCalDavProviderOptions,
): CalendarProvider => {
  const fetcher = opts.fetcher ?? defaultCalDavFetcher;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  const endpointUrl = (raw: string, label: string): URL => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch (cause) {
      throw new CalendarAdapterError(
        'io_error',
        `caldav ${label}: invalid endpoint URL`,
        cause,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new CalendarAdapterError(
        'io_error',
        `caldav ${label}: endpoint must use http or https`,
      );
    }
    return parsed;
  };
  const serverBase = endpointUrl(opts.config.server_url, 'server_url');
  const trustedOrigins = new Set([
    serverBase.origin,
    endpointUrl(opts.config.calendar_home_url, 'calendar_home_url').origin,
    ...(opts.config.scheduling_outbox_url
      ? [endpointUrl(opts.config.scheduling_outbox_url, 'scheduling_outbox_url').origin]
      : []),
  ]);

  let lastSuccessfulSyncAt = 0;
  let errorCount24h = 0;
  let pendingQueueSize = 0;
  let pendingSeriesExpansions = 0;
  let pollStop: ProviderPollStop | null = null;

  const authHeader = basicAuthHeader(
    opts.config.username,
    opts.config.password,
  );

  const etagKey = (calendarId: string, href: string): string =>
    `caldav.${opts.slug}.etag.${calendarId}.${createHash('sha1')
      .update(href)
      .digest('hex')
      .slice(0, 16)}`;

  const etagPrefix = (calendarId: string): string =>
    `caldav.${opts.slug}.etag.${calendarId}.`;

  const markError = (msg: string, err: unknown): void => {
    errorCount24h++;
    opts.log?.('warn', msg, {
      err: err instanceof Error ? err.message : String(err),
    });
  };

  const davRequest = async (
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    operation: string,
  ): Promise<{ status: number; text: string; ok: boolean }> => {
    const fullHeaders: Record<string, string> = {
      ...headers,
      Authorization: authHeader,
    };
    const res = await fetcher(url, {
      method,
      headers: fullHeaders,
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw toCalDavError(res.status, text, operation);
    }
    const text = await res.text();
    return { status: res.status, text, ok: res.ok };
  };

  const discoverCalendars = async (): Promise<
    Array<{ id: string; href: string; displayname: string }>
  > => {
    const res = await davRequest(
      opts.config.calendar_home_url,
      'PROPFIND',
      {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      calendarHomePropfindBody(),
      'PROPFIND calendar-home',
    );
    const entries = parseCalendarHomePropfind(res.text).filter(
      (e) => e.isCalendar,
    );
    const filter = opts.config.calendar_filter ?? [];
    const allow = new Set(filter);
    return entries
      .filter((e) => filter.length === 0 || allow.has(e.href))
      .map((e) => ({
        id: calendarIdFromHref(e.href),
        href: e.href,
        displayname: e.displayname,
      }));
  };

  const absolute = (calendarHref: string, eventHref: string): string => {
    let resolved: URL;
    try {
      const calendarBase = new URL(calendarHref, `${serverBase.origin}/`);
      resolved = new URL(eventHref, calendarBase);
    } catch (cause) {
      throw new CalendarAdapterError(
        'io_error',
        'caldav response contained an invalid resource href',
        cause,
      );
    }
    // Calendar and event hrefs are provider-controlled response data. Never
    // let one turn the stored Basic credential into an arbitrary-origin
    // request. Explicitly authored endpoint origins remain valid.
    if (!trustedOrigins.has(resolved.origin)) {
      throw new CalendarAdapterError(
        'io_error',
        `caldav response refused resource origin '${resolved.origin}'`,
      );
    }
    return resolved.toString();
  };

  const fetchEventIcs = async (
    calendarHref: string,
    eventHref: string,
  ): Promise<{ body: string }> => {
    const res = await fetcher(absolute(calendarHref, eventHref), {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'text/calendar' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw toCalDavError(res.status, text, 'GET event');
    }
    const body = await res.text();
    return { body };
  };

  /** The owner's zone, read per use: the owner can change it. */
  const ownerZone = (): string | undefined => {
    try {
      return opts.timeZone?.();
    } catch {
      return undefined;
    }
  };

  const readObject = (raw: string): CalDavObject | null => {
    const timeZone = ownerZone();
    return readCalDavObject(raw, {
      ...(timeZone !== undefined ? { timeZone } : {}),
      warn: (message) => opts.log?.('warn', message),
    });
  };

  /** The window occurrences are expanded in, and a resource's rows inside it
   *  reconciled. */
  const expansionWindow = (): RRuleExpansionWindow => ({
    windowStart: nowOf() - opts.config.expansion_past_days * 86_400_000,
    windowEnd: nowOf() + opts.config.expansion_future_days * 86_400_000,
  });

  /** Read one event resource, hand on its occurrences, then the whole set of
   *  rows it makes in the window — so an occurrence it no longer makes (a
   *  date deleted, a series cut short, an occurrence moved away) leaves the
   *  warehouse — and remember its ETag and UID. */
  const ingestEvent = async (
    calendar: { id: string; href: string; displayname: string },
    eventHref: string,
    etag: string,
    calendarData: string | undefined,
    prior: StoredResource | null,
    window: RRuleExpansionWindow,
    emit: (payload: ProviderEventPayload) => Promise<boolean>,
    reconcile: (series: CalendarSeriesSnapshot) => Promise<void>,
  ): Promise<void> => {
    let icsBody = calendarData;
    if (!icsBody) {
      icsBody = (await fetchEventIcs(calendar.href, eventHref)).body;
    }
    const object = readObject(icsBody);
    if (object === null) {
      markError(`caldav unparseable VEVENT href=${eventHref}`, null);
      // Do not stamp this ETag or let an initial scan certify completion. The
      // provider resource is still present but has not been durably represented
      // in the collection; retaining the old/no ETag makes it retryable.
      throw new Error(`caldav event '${eventHref}' could not be parsed`);
    }
    const { occurrences, partial } = expandCalDavObject(object, window);
    if (partial) pendingSeriesExpansions++;
    // ⚠ The server's copy is the one this adapter already read: any difference
    // now is only how Recued reads it (its zones, 2026-10-07). The rows are
    // corrected without waking `updated` triggers — a reschedule tracker would
    // otherwise count every event on the calendar once.
    const correction = prior !== null && prior.legacy && prior.etag === etag;
    const keep: string[] = [];
    for (const occurrence of occurrences) {
      const payload = payloadOf(object, occurrence, etag, calendar, correction);
      keep.push(payload.event.source_id);
      if (!(await emit(payload))) return;
    }
    await reconcile({
      calendar_id: calendar.id,
      ical_uid: object.uid,
      window: { start: window.windowStart, end: window.windowEnd },
      keep,
    });
    await opts.etagStore.set(etagKey(calendar.id, eventHref), encodeStored(etag, object.uid));
  };

  // ── initial scan ────────────────────────────────────────────
  const runInitialScan = async (
    scanOpts: InitialScanOptions,
  ): Promise<void> => {
    const calendars = await discoverCalendars();
    const windowStart = nowOf() - scanOpts.backfill_days * 86_400_000;
    const windowEnd = nowOf() + scanOpts.expansion_future_days * 86_400_000;
    const window = expansionWindow();
    let aborted = false;
    for (const cal of calendars) {
      if (aborted) break;
      const res = await davRequest(
        absolute(cal.href, cal.href),
        'REPORT',
        {
          Depth: '1',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        calendarQueryBody(windowStart, windowEnd, true),
        'REPORT calendar-query (initial scan)',
      );
      const entries = parseCalendarQuery(res.text);
      const kept: string[] = [];
      for (const entry of entries) {
        if (aborted) break;
        const prior = decodeStored(await opts.etagStore.get(etagKey(cal.id, entry.href)));
        await ingestEvent(
          cal,
          entry.href,
          entry.etag,
          entry.calendarData,
          prior,
          window,
          async (payload) => {
            const cont = await scanOpts.onEvent(payload);
            lastSuccessfulSyncAt = nowOf();
            if (!cont) aborted = true;
            return cont;
          },
          async (series) => {
            kept.push(...series.keep);
            await scanOpts.onSeries?.(series);
          },
        );
      }
      // ⛔ Every resource of the calendar was read, so a stored row of it in
      // the window that none made is gone: deleted while Recued was not
      // watching, or filed by the reader before 2026-10-07 under another
      // identity — it read a VEVENT's lines up to its END, so an alert's own
      // `UID` (Apple writes one in every VALARM) replaced the event's, and
      // its rows sat under the alert's id, which no write could find. The
      // window is the one both the query and the expansion covered.
      if (!aborted) {
        await scanOpts.onCalendar?.({
          calendar_id: cal.id,
          window: { start: Math.max(window.windowStart, windowStart), end: Math.min(window.windowEnd, windowEnd) },
          keep: kept,
        });
      }
    }
  };

  // ── incremental sync tick ───────────────────────────────────
  const runSyncTick = async (cb: CalendarSyncCallback): Promise<void> => {
    const calendars = await discoverCalendars();
    const window = expansionWindow();
    const reconcile = async (series: CalendarSeriesSnapshot): Promise<void> => {
      await cb({ kind: 'series', source_id: `${series.calendar_id}:${series.ical_uid}`, series });
    };
    for (const cal of calendars) {
      const res = await davRequest(
        absolute(cal.href, cal.href),
        'REPORT',
        {
          Depth: '1',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        calendarQueryBody(window.windowStart, window.windowEnd, false),
        'REPORT calendar-query (sync tick)',
      );
      const current = parseCalendarQuery(res.text);
      const previous = await opts.etagStore.list(etagPrefix(cal.id));
      const prevMap = new Map<string, string>();
      for (const { key, value } of previous) prevMap.set(key, value);

      const currentKeys = new Set<string>();
      for (const entry of current) {
        const k = etagKey(cal.id, entry.href);
        currentKeys.add(k);
        const prior = decodeStored(prevMap.get(k));
        if (prior !== null && !prior.legacy && prior.etag === entry.etag) continue; // unchanged

        pendingQueueSize++;
        try {
          await ingestEvent(
            cal,
            entry.href,
            entry.etag,
            entry.calendarData,
            prior,
            window,
            async (payload) => {
              const sync: CalendarSyncEvent = {
                kind: 'updated',
                source_id: payload.event.source_id,
                payload,
              };
              await cb(sync);
              lastSuccessfulSyncAt = nowOf();
              return true;
            },
            reconcile,
          );
        } catch (err) {
          markError(`caldav ingest failed href=${entry.href}`, err);
        } finally {
          pendingQueueSize = Math.max(0, pendingQueueSize - 1);
        }
      }

      // A resource the window no longer lists was deleted on the server, or
      // moved or aged out of the window. Either way its rows inside the window
      // go; rows before the window stay, as history.
      for (const [k, value] of prevMap) {
        if (currentKeys.has(k)) continue;
        const stored = decodeStored(value);
        try {
          // ⚠ A value written before 2026-10-07 names no UID, so nothing it
          // made can be found: this adapter emitted a deletion keyed on the
          // href's hash, which no row ever had, so a deleted event stayed.
          if (stored?.uid) {
            await reconcile({
              calendar_id: cal.id,
              ical_uid: stored.uid,
              window: { start: window.windowStart, end: window.windowEnd },
              keep: [],
            });
          }
          // The ETag row is the only durable evidence that this href used to
          // exist. Remove it only after the collection acknowledges the delete;
          // otherwise the next REPORT has no way to replay the tombstone.
          await opts.etagStore.delete(k);
        } catch (err) {
          markError(`caldav delete-notify failed key=${k}`, err);
        }
      }
    }
  };

  const defaultScheduler: ProviderPollScheduler = (cb, intervalMs) =>
    startDrainingInterval({
      tick: cb,
      intervalMs,
      onError: (err) => markError('caldav poll tick failed', err),
    });

  // ── write-back ──────────────────────────────────────────────
  //
  // ⛔⛔ THE SERVER'S FILE IS EDITED IN PLACE, NEVER REBUILT (2026-10-07; see
  // `caldav-ics.ts`). Each write fetches the event's file, changes the lines
  // the edit names, and puts back every other line as the server sent it — its
  // zone, reminders, deleted dates and changed occurrences included.
  //
  // An occurrence of a series is edited as an override (RFC 5545 §3.8.4.4) and
  // deleted as an EXDATE: a `this_instance` edit or delete — the default —
  // rewrote, or deleted, the whole series.

  const resolveCalendarHref = async (
    calendarId: string,
    operation: string,
  ): Promise<{ id: string; href: string; displayname: string }> => {
    const calendars = await discoverCalendars();
    // Accept either the hashed id or the raw href as the calendar_id
    // so recipes can target caldav calendars by either handle.
    const match = calendars.find(
      (c) => c.id === calendarId || c.href === calendarId,
    );
    if (!match) {
      throw new CalendarAdapterError(
        'calendar_not_found',
        `caldav ${operation}: no calendar matches ${calendarId}`,
      );
    }
    return match;
  };

  // A caldav source_id's optional trailing `:${key}` names one occurrence of
  // a series: the wall clock it starts at on the series' clock, the digits
  // read as UTC. A present-but-non-numeric suffix is malformed for our format
  // — fail CLOSED rather than silently widening an occurrence's edit into a
  // whole-series edit. (A UID that itself contains ':' is a separate,
  // pre-existing convention limitation: `parts[1]` is taken as the uid, which
  // 404s for such servers — first-party UIDs are colon-free `<hash>@recued`.)
  const occurrenceSuffix = (
    parts: string[],
    source_id: string,
    verb: string,
  ): number | undefined => {
    if (parts[2] === undefined) return undefined;
    if (!/^\d+$/.test(parts[2])) {
      throw new CalendarAdapterError(
        'event_not_found',
        `caldav ${verb}: malformed occurrence suffix in source_id ${source_id}`,
      );
    }
    return Number(parts[2]);
  };

  interface WriteContext {
    readonly editor: IcsEditor;
    readonly clock: IcsClock;
    readonly now: number;
    /** Zones whose VTIMEZONE this write has added. */
    readonly addedZones: Set<string>;
  }

  const newContext = (object: CalDavObject): WriteContext => ({
    editor: createIcsEditor(object.doc),
    clock: object.clock,
    now: nowOf(),
    addedZones: new Set<string>(),
  });

  const stampValue = (at: number): string => `${icsDateTimeValue(at)}Z`;

  const calendarEndOf = (doc: IcsDoc): number =>
    doc.roots.find((c) => c.name === 'VCALENDAR')?.end ?? doc.lines.length;

  /** DTSTAMP and LAST-MODIFIED say when. SEQUENCE goes up for a change of
   *  time, rule or status (RFC 5545 §3.8.7.4), so the event's own apps take
   *  the new copy over theirs. */
  const touch = (ctx: WriteContext, component: IcsDocComponent, sequence: number, significant: boolean): void => {
    setComponentProperty(ctx.editor, component, 'DTSTAMP', icsLine('DTSTAMP', stampValue(ctx.now)));
    setComponentProperty(ctx.editor, component, 'LAST-MODIFIED', icsLine('LAST-MODIFIED', stampValue(ctx.now)));
    if (significant) setComponentProperty(ctx.editor, component, 'SEQUENCE', icsLine('SEQUENCE', String(sequence + 1)));
  };

  /** A zone's rules, before the file's first event. */
  const addVTimezone = (ctx: WriteContext, zone: string, lines: readonly string[]): void => {
    if (ctx.addedZones.has(zone)) return;
    ctx.addedZones.add(zone);
    const doc = ctx.editor.doc;
    const calendar = doc.roots.find((c) => c.name === 'VCALENDAR');
    const firstEvent = (calendar?.children ?? doc.roots).find((c) => c.name === 'VEVENT');
    ctx.editor.insertBefore(firstEvent?.begin ?? calendar?.end ?? doc.lines.length, lines);
  };

  /** The form an edited event writes its times in: its own, unless the edit
   *  names another zone, or makes it all-day or timed. A zone the file has no
   *  rules for gets them, from the platform's tables. */
  const formForWrite = (
    ctx: WriteContext,
    ev: CalDavVEvent,
    allDay: boolean,
    zone: string | undefined,
    around: number,
  ): IcsTimeForm => {
    if (allDay) return { kind: 'date' };
    const wanted = (zone ?? '').trim();
    if (ev.startForm.kind !== 'date' && (wanted === '' || wanted === ev.timezone)) return ev.startForm;
    if (wanted === '' || isUtcZoneName(wanted)) return { kind: 'utc' };
    const reader = ctx.clock.zone(wanted, false);
    if (reader.basis === 'unresolved') return { kind: 'utc' };
    if (!ctx.clock.hasRules(wanted)) {
      const rules = vtimezoneLines(wanted, around);
      if (rules === null) return { kind: 'utc' };
      addVTimezone(ctx, wanted, rules);
    }
    return { kind: 'zoned', tzid: wanted, zone: reader };
  };

  /** Replace the guest list, keeping what the file says about each guest it
   *  already had (role, RSVP, type) beyond the name and answer Recued holds. */
  const writeAttendees = (
    ctx: WriteContext,
    component: IcsDocComponent,
    attendees: NonNullable<CanonicalEvent['attendees']>,
  ): void => {
    const existing = componentProps(ctx.editor.doc, component, 'ATTENDEE');
    const byEmail = new Map<string, IcsContentLine>();
    for (const { prop } of existing) {
      const email = mailtoOf(prop.value);
      if (email !== null) byEmail.set(email.toLowerCase(), prop);
    }
    const lines = attendees.map((a) => {
      const prior = byEmail.get(a.email.toLowerCase());
      const params: Array<readonly [string, string | readonly string[]]> = [];
      const cn = a.display_name ?? (prior ? propParam(prior, 'CN') : undefined);
      if (cn) params.push(['CN', cn]);
      if (prior) {
        for (const [name, values] of prior.params) {
          if (name !== 'CN' && name !== 'PARTSTAT') params.push([name, values]);
        }
      }
      params.push(['PARTSTAT', PARTSTAT_VALUE[a.response_status] ?? 'NEEDS-ACTION']);
      return icsLine('ATTENDEE', `mailto:${a.email}`, params);
    });
    for (const { index } of existing) ctx.editor.deleteLine(index);
    addComponentProperties(ctx.editor, component, lines);
  };

  /** Apply a patch to one VEVENT's own lines. A time is written in the form
   *  the event's own app wrote it in. */
  const applyPatch = (
    ctx: WriteContext,
    ev: CalDavVEvent,
    patch: EventPatch,
    allow: { readonly rrule: boolean },
  ): void => {
    const { editor } = ctx;
    const component = ev.component;
    let significant = false;
    if (patch.summary !== undefined) {
      setComponentProperty(editor, component, 'SUMMARY', icsLine('SUMMARY', escapeIcsText(patch.summary)));
    }
    if (patch.description !== undefined) {
      setComponentProperty(editor, component, 'DESCRIPTION', patch.description ? icsLine('DESCRIPTION', escapeIcsText(patch.description)) : null);
    }
    if (patch.location !== undefined) {
      setComponentProperty(editor, component, 'LOCATION', patch.location ? icsLine('LOCATION', escapeIcsText(patch.location)) : null);
    }
    if (patch.status !== undefined && patch.status !== ev.status) {
      setComponentProperty(editor, component, 'STATUS', icsLine('STATUS', patch.status.toUpperCase()));
      significant = true;
    }
    const allDay = patch.is_all_day ?? ev.isAllDay;
    const start = patch.start_at ?? ev.dtstart;
    const end = patch.end_at ?? (patch.start_at !== undefined ? start + (ev.dtend - ev.dtstart) : ev.dtend);
    const zoneChange = patch.timezone !== undefined && patch.timezone !== '' && patch.timezone !== ev.timezone;
    if (start !== ev.dtstart || end !== ev.dtend || allDay !== ev.isAllDay || zoneChange) {
      const form = formForWrite(ctx, ev, allDay, patch.timezone, start);
      const startLine = icsTimeLine('DTSTART', start, form);
      const endLine = icsTimeLine('DTEND', Math.max(end, start), form);
      if (startLine === null || endLine === null) {
        throw new CalendarAdapterError('io_error', `caldav: the event's zone cannot write ${new Date(start).toISOString()}`);
      }
      setComponentProperty(editor, component, 'DTSTART', startLine);
      setComponentProperty(editor, component, 'DTEND', endLine);
      setComponentProperty(editor, component, 'DURATION', null);
      significant = true;
    }
    if (allow.rrule && patch.recurrence_rule !== undefined && (patch.recurrence_rule || undefined) !== ev.rrule) {
      setComponentProperty(editor, component, 'RRULE', patch.recurrence_rule ? icsLine('RRULE', patch.recurrence_rule) : null);
      significant = true;
    }
    if (patch.attendees !== undefined) writeAttendees(ctx, component, patch.attendees);
    touch(ctx, component, ev.sequence, significant);
  };

  /** The override an edit of one occurrence writes: a copy of the series'
   *  VEVENT for that occurrence (RFC 5545 §3.8.4.4), the edit applied. */
  const overrideLines = (
    ctx: WriteContext,
    object: CalDavObject,
    master: CalDavVEvent,
    key: number,
    patch: EventPatch,
  ): string[] => {
    const slot = instantInForm(key, master.startForm);
    const endLine = slot === null ? null : icsTimeLine('DTEND', slot + (master.dtend - master.dtstart), master.startForm);
    if (slot === null || endLine === null) {
      throw new CalendarAdapterError('io_error', `caldav: occurrence ${key} cannot be written on its series' clock`);
    }
    const texts = cloneComponentLines(object.doc, master.component, {
      set: new Map([
        ['RECURRENCE-ID', [icsTimeLineFromWall('RECURRENCE-ID', key, master.startForm)]],
        ['DTSTART', [icsTimeLineFromWall('DTSTART', key, master.startForm)]],
        ['DTEND', [endLine]],
      ]),
      drop: new Set(['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'DURATION']),
    });
    // The copy is edited as any event is: one reader, one writer.
    const doc = parseIcsDoc(texts.join('\r\n'));
    const copy = doc.roots[0] === undefined ? null : readVEvent(doc, doc.roots[0], ctx.clock);
    if (copy === null) throw new CalendarAdapterError('io_error', 'caldav: an occurrence copy failed to read back');
    const editor = createIcsEditor(doc);
    applyPatch({ ...ctx, editor }, copy, patch, { rrule: false });
    return editor.texts();
  };

  /** A rule's UNTIL moved by a wall-clock delta, in the form it was written. */
  const shiftedUntil = (rule: string, delta: number): string =>
    rule
      .split(';')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed.toUpperCase().startsWith('UNTIL=')) return part;
        const raw = readIcsDateTime(trimmed.slice('UNTIL='.length));
        if (raw === null) return part;
        if (raw.dateOnly) return `UNTIL=${icsDateValue(raw.wall + Math.round(delta / DAY_MS) * DAY_MS)}`;
        return `UNTIL=${icsDateTimeValue(raw.wall + delta)}${raw.utc ? 'Z' : ''}`;
      })
      .join(';');

  /** A whole-series edit, named from one of its occurrences: the series moves
   *  as far as that occurrence moves, and its deleted dates and overrides move
   *  with it, so each still names the occurrence it named. Returns the named
   *  occurrence's key after, `null` when it cannot be told. */
  const editSeries = (
    ctx: WriteContext,
    object: CalDavObject,
    master: CalDavVEvent,
    key: number,
    patch: EventPatch,
  ): number | null => {
    const moves = patch.start_at !== undefined || patch.end_at !== undefined;
    const reforms = (patch.is_all_day !== undefined && patch.is_all_day !== master.isAllDay)
      || (patch.timezone !== undefined && patch.timezone !== '' && patch.timezone !== master.timezone);
    if (!moves && !reforms) {
      applyPatch(ctx, master, patch, { rrule: true });
      return key;
    }
    if (reforms && (master.exdateValues.length > 0 || object.overrides.length > 0)) {
      throw new CalendarAdapterError(
        'rrule_unsupported',
        "caldav: a repeating event with changed or deleted occurrences keeps its zone and all-day setting here; change them in the calendar's own app",
      );
    }
    const slot = instantInForm(key, master.startForm);
    if (slot === null) throw new CalendarAdapterError('io_error', `caldav: occurrence ${key} cannot be read on its series' clock`);
    const newStart = patch.start_at ?? slot;
    const newEnd = patch.end_at ?? newStart + (master.dtend - master.dtstart);
    if (reforms) {
      // Nothing to keep in step: the series moves as far as this occurrence.
      const shift = newStart - slot;
      applyPatch(ctx, master, { ...patch, start_at: master.dtstart + shift, end_at: master.dtstart + shift + (newEnd - newStart) }, { rrule: true });
      return null;
    }
    const newWall = wallInForm(newStart, master.startForm);
    if (newWall === null) throw new CalendarAdapterError('io_error', `caldav: ${new Date(newStart).toISOString()} cannot be written on the series' clock`);
    const delta = newWall - key;
    const rule = patch.recurrence_rule !== undefined ? patch.recurrence_rule : (master.rrule ?? '');
    if (
      delta !== 0
      && /(?:^|;)\s*BY[A-Z]+=/i.test(rule)
      && Math.floor((master.startWall + delta) / DAY_MS) !== Math.floor(master.startWall / DAY_MS)
    ) {
      throw new CalendarAdapterError(
        'rrule_unsupported',
        'caldav: moving a repeating event to another day would no longer match its rule; change the rule, or move one occurrence',
      );
    }
    const masterStart = instantInForm(master.startWall + delta, master.startForm);
    if (masterStart === null) throw new CalendarAdapterError('io_error', "caldav: the series' new start cannot be read on its clock");
    applyPatch(ctx, master, {
      ...patch,
      start_at: masterStart,
      end_at: masterStart + (newEnd - newStart),
      ...(delta !== 0 && rule ? { recurrence_rule: shiftedUntil(rule, delta) } : {}),
    }, { rrule: true });
    if (delta !== 0) {
      const form = master.startForm;
      for (const { index } of componentProps(ctx.editor.doc, master.component, 'EXDATE')) ctx.editor.deleteLine(index);
      addComponentProperties(ctx.editor, master.component, master.exdateValues
        .map((e) => occurrenceKey(master, e.at, e.dateOnly))
        .filter((k): k is number => k !== null)
        .map((k) => icsTimeLineFromWall('EXDATE', k + delta, form)));
      for (const o of object.overrides) {
        const k = overrideKey(object, o);
        if (k !== null) setComponentProperty(ctx.editor, o.component, 'RECURRENCE-ID', icsTimeLineFromWall('RECURRENCE-ID', k + delta, form));
      }
    }
    return key + delta;
  };

  /** Cut a series before an occurrence. UNTIL is inclusive, so it names the
   *  last start before the split — a day for an all-day series, a floating
   *  time for a floating one, else UTC (RFC 5545 §3.3.10). The overrides of
   *  occurrences from the split on go with the half that is moving. */
  const truncateSeries = (ctx: WriteContext, object: CalDavObject, master: CalDavVEvent, splitKey: number): void => {
    const form = master.startForm;
    const splitAt = instantInForm(splitKey, form);
    if (splitAt === null) throw new CalendarAdapterError('io_error', `caldav: occurrence ${splitKey} cannot be read on its series' clock`);
    const untilValue = form.kind === 'date'
      ? icsDateValue(splitKey - DAY_MS)
      : form.kind === 'floating'
        ? icsDateTimeValue(splitKey - 1000)
        : `${icsDateTimeValue(splitAt - 1000)}Z`;
    setComponentProperty(ctx.editor, master.component, 'RRULE', icsLine('RRULE', capRRuleUntil(master.rrule ?? '', untilValue)));
    for (const o of object.overrides) {
      const k = overrideKey(object, o);
      if (k !== null && k >= splitKey) ctx.editor.deleteComponent(o.component);
    }
    touch(ctx, master.component, master.sequence, true);
  };

  /** The series from an occurrence on, as a new resource: the file's own
   *  header and zones, the series' VEVENT with a new UID, its rule carried
   *  forward, its deleted dates from the split on, the edit applied. */
  const newSeriesIcs = (
    object: CalDavObject,
    master: CalDavVEvent,
    splitKey: number,
    patch: EventPatch,
    newUid: string,
  ): string => {
    const ctx = newContext(object);
    for (const vevent of componentsNamed(object.doc, 'VEVENT')) ctx.editor.deleteComponent(vevent);
    const form = master.startForm;
    const slot = instantInForm(splitKey, form);
    const endLine = slot === null ? null : icsTimeLine('DTEND', slot + (master.dtend - master.dtstart), form);
    if (slot === null || endLine === null) {
      throw new CalendarAdapterError('io_error', `caldav: occurrence ${splitKey} cannot be written on its series' clock`);
    }
    const carried = patch.recurrence_rule !== undefined
      ? patch.recurrence_rule
      : newSeriesRRule(master.rrule ?? '', master.startWall, splitKey);
    // A moved split moves the deleted dates with it, so each still names the
    // occurrence it named; a new zone or all-day setting drops them.
    const reforms = (patch.is_all_day !== undefined && patch.is_all_day !== master.isAllDay)
      || (patch.timezone !== undefined && patch.timezone !== '' && patch.timezone !== master.timezone);
    const movedWall = patch.start_at === undefined ? splitKey : wallInForm(patch.start_at, form);
    const delta = movedWall === null ? 0 : movedWall - splitKey;
    const exdates = reforms
      ? []
      : master.exdateValues
        .map((e) => occurrenceKey(master, e.at, e.dateOnly))
        .filter((k): k is number => k !== null && k >= splitKey)
        .map((k) => icsTimeLineFromWall('EXDATE', k + delta, form));
    const set = new Map<string, readonly string[]>([
      ['UID', [icsLine('UID', newUid)]],
      ['DTSTART', [icsTimeLineFromWall('DTSTART', splitKey, form)]],
      ['DTEND', [endLine]],
      ['SEQUENCE', ['SEQUENCE:0']],
      ['DTSTAMP', [icsLine('DTSTAMP', stampValue(ctx.now))]],
    ]);
    if (carried) set.set('RRULE', [icsLine('RRULE', carried)]);
    if (exdates.length > 0) set.set('EXDATE', exdates);
    const drop = new Set(['RECURRENCE-ID', 'DURATION', 'CREATED', 'LAST-MODIFIED', 'RDATE', 'EXRULE', 'EXDATE', 'RRULE']);
    const texts = cloneComponentLines(object.doc, master.component, { set, drop });
    const doc = parseIcsDoc(texts.join('\r\n'));
    const copy = doc.roots[0] === undefined ? null : readVEvent(doc, doc.roots[0], object.clock);
    if (copy === null) throw new CalendarAdapterError('io_error', 'caldav: the new series failed to read back');
    const editor = createIcsEditor(doc);
    const { recurrence_rule: _rule, ...rest } = patch;
    void _rule;
    applyPatch({ ...ctx, editor }, copy, rest, { rrule: false });
    ctx.editor.insertBefore(calendarEndOf(object.doc), editor.texts());
    return ctx.editor.render();
  };

  const putEvent = async (
    cal: { href: string },
    href: string,
    body: string,
    operation: string,
    create = false,
  ): Promise<void> => {
    const res = await fetcher(absolute(cal.href, href), {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'text/calendar; charset=utf-8',
        ...(create ? { 'If-None-Match': '*' } : {}),
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw toCalDavError(res.status, text, operation);
    }
  };

  /** The payload of what was written, read back as a sync would read it: the
   *  occurrence the caller named, else the event's first. */
  const payloadAfterWrite = (
    ics: string,
    key: number | null,
    cal: { id: string; displayname: string },
    operation: string,
  ): ProviderEventPayload => {
    const object = readObject(ics);
    const occurrence = object === null ? null : (occurrenceOf(object, key) ?? occurrenceOf(object, null));
    if (object === null || occurrence === null) {
      throw new CalendarAdapterError(
        'io_error',
        `caldav ${operation}: locally produced VEVENT failed round-trip parse`,
      );
    }
    return payloadOf(object, occurrence, '', cal);
  };

  // CalDAV `this_and_future` UPDATE. CalDAV holds the whole series as
  // one file, so the adapter — not the dispatcher — owns the split
  // (gcal/graph defer theirs to the dispatcher per provider quirks).
  // Step 1: cut the series before the occurrence. Step 2: PUT the rest
  // as a new series (new UID) carrying the patch forward. Returns the
  // NEW series' first-occurrence payload — the event the "edit this and
  // following" gesture creates. Earlier occurrences + the cut tail
  // reconcile on the next sync tick (the adapter's existing
  // eventually-consistent mutation contract).
  const splitSeriesUpdate = async (
    cal: { id: string; href: string; displayname: string },
    uid: string,
    href: string,
    object: CalDavObject,
    master: CalDavVEvent,
    patch: EventPatch,
    splitKey: number,
  ): Promise<ProviderEventPayload> => {
    const ctx = newContext(object);
    truncateSeries(ctx, object, master, splitKey);
    await putEvent(cal, href, ctx.editor.render(), 'PUT (this_and_future truncate)');

    const newUid = `${createHash('sha1')
      .update(`${cal.id}:${nowOf()}:${patch.summary ?? master.summary ?? ''}:${splitKey}`)
      .digest('hex')}@recued`;
    const newHref = `${cal.href.replace(/\/$/, '')}/${newUid}.ics`;
    const newIcs = newSeriesIcs(object, master, splitKey, patch, newUid);
    const createRes = await fetcher(absolute(cal.href, newHref), {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'text/calendar; charset=utf-8',
        'If-None-Match': '*',
      },
      body: newIcs,
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      // The master is already truncated. Surface the partial outcome
      // explicitly (matches the gcal/graph dispatcher's contract) so
      // the recipe's fail_on branch can decide; the next sync tick
      // reflects whatever the server actually holds.
      throw new CalendarAdapterError(
        'io_error',
        `caldav this_and_future: master series ${uid} truncated but the new series PUT failed (${createRes.status}). The next sync tick will reflect provider state. ${text}`.trim(),
      );
    }
    return payloadAfterWrite(newIcs, null, cal, 'PUT (this_and_future)');
  };

  /** A new event's file. A timed event is written in its zone, with that
   *  zone's rules, so its own apps show it in the zone it was made for and a
   *  repeating one keeps its local time across a change of clocks. */
  const buildCalendarObject = (uid: string, event: CreateEventInput, now: number): string => {
    const zone = (event.timezone ?? '').trim();
    let form: IcsTimeForm = event.is_all_day ? { kind: 'date' } : { kind: 'utc' };
    let rules: string[] | null = null;
    if (!event.is_all_day && zone !== '' && !isUtcZoneName(zone)) {
      rules = vtimezoneLines(zone, event.start_at);
      if (rules !== null) form = { kind: 'zoned', tzid: zone, zone: icsClock('').zone(zone, false) };
    }
    const start = icsTimeLine('DTSTART', event.start_at, form);
    const end = icsTimeLine('DTEND', Math.max(event.end_at, event.start_at), form);
    if (start === null || end === null) {
      throw new CalendarAdapterError('io_error', `caldav PUT (create): ${zone} cannot write the event's times`);
    }
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//recued//caldav-adapter//EN',
      ...(rules ?? []),
      'BEGIN:VEVENT',
      icsLine('UID', uid),
      icsLine('DTSTAMP', stampValue(now)),
      start,
      end,
      icsLine('SUMMARY', escapeIcsText(event.summary)),
    ];
    if (event.description) lines.push(icsLine('DESCRIPTION', escapeIcsText(event.description)));
    if (event.location) lines.push(icsLine('LOCATION', escapeIcsText(event.location)));
    lines.push(icsLine('STATUS', event.status.toUpperCase()));
    if (event.organizer) {
      lines.push(icsLine(
        'ORGANIZER',
        `mailto:${event.organizer.email}`,
        event.organizer.display_name ? [['CN', event.organizer.display_name]] : [],
      ));
    }
    for (const a of event.attendees ?? []) {
      lines.push(icsLine('ATTENDEE', `mailto:${a.email}`, [
        ...(a.display_name ? [['CN', a.display_name] as const] : []),
        ['PARTSTAT', PARTSTAT_VALUE[a.response_status] ?? 'NEEDS-ACTION'],
      ]));
    }
    if (event.recurrence_rule) lines.push(icsLine('RRULE', event.recurrence_rule));
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return `${lines.flatMap(foldIcsLine).join('\r\n')}\r\n`;
  };

  return {
    kind: 'caldav',
    slug: opts.slug,

    async connect() {
      // A narrow PROPFIND on the calendar-home confirms credentials.
      await davRequest(
        opts.config.calendar_home_url,
        'PROPFIND',
        {
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        calendarHomePropfindBody(),
        'PROPFIND connect',
      );
    },

    async initialScan(scanOpts) {
      await runInitialScan(scanOpts);
    },

    async startSync(cb) {
      const scheduler = opts.scheduler ?? defaultScheduler;
      const intervalMs = Math.max(1, opts.config.poll_seconds) * 1000;
      await runSyncTick(cb);
      pollStop = scheduler(() => runSyncTick(cb), intervalMs);
      return async () => {
        const stop = pollStop;
        pollStop = null;
        await stop?.();
      };
    },

    async close() {
      const stop = pollStop;
      pollStop = null;
      await stop?.();
    },

    health(): CalendarProviderHealth {
      return {
        last_successful_sync_at: lastSuccessfulSyncAt,
        error_count_24h: errorCount24h,
        pending_queue_size: pendingQueueSize,
        pending_series_expansions: pendingSeriesExpansions,
      };
    },

    async createEvent(calendarId: string, event: CreateEventInput) {
      const cal = await resolveCalendarHref(calendarId, 'PUT (create)');
      // D-315 slice 7 — an invite's own UID is kept when it can name the
      // `.ics` file and sit in a `source_id` (`<calendar>:<uid>`, split on
      // `:`); otherwise the event gets one of ours.
      const uid = event.ical_uid !== undefined && CALDAV_SAFE_UID.test(event.ical_uid)
        ? event.ical_uid
        : `${createHash('sha1')
          .update(`${cal.id}:${nowOf()}:${event.summary}:${event.start_at}`)
          .digest('hex')}@recued`;
      const href = `${cal.href.replace(/\/$/, '')}/${uid}.ics`;
      const ics = buildCalendarObject(uid, event, nowOf());
      await putEvent(cal, href, ics, 'PUT (create)', true);
      return payloadAfterWrite(ics, null, cal, 'PUT (create)');
    },

    async updateEvent(input: UpdateEventInput) {
      const cal = await resolveCalendarHref(input.calendar_id, 'PUT (update)');
      // Source_id shape: `${cal.id}:${uid}` or `${cal.id}:${uid}:${key}`
      // — peel the uid (the .ics file) and the occurrence named.
      const parts = input.source_id.split(':');
      const uid = parts[1];
      if (!uid) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav update: malformed source_id ${input.source_id}`,
        );
      }
      const key = occurrenceSuffix(parts, input.source_id, 'update') ?? null;
      const href = `${cal.href.replace(/\/$/, '')}/${uid}.ics`;
      const existing = await fetchEventIcs(cal.href, href);
      const object = readObject(existing.body);
      if (object === null) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav update: remote VEVENT unparseable uid=${uid}`,
        );
      }
      const scope = input.scope ?? 'this_instance';
      const master = object.master;
      const ctx = newContext(object);
      let written: number | null = key;
      if (master === null) {
        // The file holds only occurrences of a series kept elsewhere.
        const override = object.overrides.find((o) => overrideKey(object, o) === key);
        if (override === undefined) {
          throw new CalendarAdapterError('event_not_found', `caldav update: no occurrence ${input.source_id}`);
        }
        applyPatch(ctx, override, input.patch, { rrule: false });
      } else if (!master.rrule) {
        applyPatch(ctx, master, input.patch, { rrule: true });
        written = null;
      } else if (scope === 'this_and_future' && key !== null && key > master.startWall) {
        return await splitSeriesUpdate(cal, uid, href, object, master, input.patch, key);
      } else if (scope === 'series' || scope === 'this_and_future') {
        // A whole-series edit — `this_and_future` from the first occurrence
        // is one.
        written = editSeries(ctx, object, master, key ?? master.startWall, input.patch);
      } else {
        // One occurrence: its override, written now if it has none.
        const k = key ?? master.startWall;
        const override = object.overrides.find((o) => overrideKey(object, o) === k);
        if (override !== undefined) applyPatch(ctx, override, input.patch, { rrule: false });
        else ctx.editor.insertBefore(calendarEndOf(object.doc), overrideLines(ctx, object, master, k, input.patch));
        written = k;
      }
      const ics = ctx.editor.render();
      await putEvent(cal, href, ics, 'PUT (update)');
      return payloadAfterWrite(ics, written, cal, 'PUT (update)');
    },

    async deleteEvent(input: DeleteEventInput) {
      const cal = await resolveCalendarHref(input.calendar_id, 'DELETE');
      const parts = input.source_id.split(':');
      const uid = parts[1];
      if (!uid) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav delete: malformed source_id ${input.source_id}`,
        );
      }
      const key = occurrenceSuffix(parts, input.source_id, 'delete') ?? null;
      const href = `${cal.href.replace(/\/$/, '')}/${uid}.ics`;
      const scope = input.scope ?? 'this_instance';
      if (scope !== 'series') {
        // Whether this removes the file or one occurrence in it depends on
        // what the file holds.
        const existing = await fetchEventIcs(cal.href, href);
        const object = readObject(existing.body);
        if (object === null) {
          throw new CalendarAdapterError(
            'event_not_found',
            `caldav delete: remote VEVENT unparseable uid=${uid}`,
          );
        }
        const master = object.master;
        if (master === null) {
          const override = object.overrides.find((o) => overrideKey(object, o) === key);
          if (override === undefined) {
            throw new CalendarAdapterError('event_not_found', `caldav delete: no occurrence ${input.source_id}`);
          }
          if (object.overrides.length > 1) {
            const ctx = newContext(object);
            ctx.editor.deleteComponent(override.component);
            await putEvent(cal, href, ctx.editor.render(), 'PUT (delete occurrence)');
            return;
          }
          // Its last occurrence: the file goes.
        } else if (master.rrule) {
          if (scope === 'this_and_future') {
            // Drop the occurrence + everything after it by capping the
            // series. From the first occurrence it is the whole series.
            if (key !== null && key > master.startWall) {
              const ctx = newContext(object);
              truncateSeries(ctx, object, master, key);
              await putEvent(cal, href, ctx.editor.render(), 'PUT (this_and_future truncate)');
              return;
            }
          } else {
            // One occurrence leaves the series as an EXDATE, its override
            // with it.
            const k = key ?? master.startWall;
            const ctx = newContext(object);
            addComponentProperties(ctx.editor, master.component, [icsTimeLineFromWall('EXDATE', k, master.startForm)]);
            for (const o of object.overrides) {
              if (overrideKey(object, o) === k) ctx.editor.deleteComponent(o.component);
            }
            touch(ctx, master.component, master.sequence, true);
            await putEvent(cal, href, ctx.editor.render(), 'PUT (delete occurrence)');
            return;
          }
        }
      }
      const res = await fetcher(absolute(cal.href, href), {
        method: 'DELETE',
        headers: { Authorization: authHeader },
      });
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => '');
        throw toCalDavError(res.status, text, 'DELETE');
      }
      if (res.status === 404) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav delete: 404 uid=${uid}`,
        );
      }
    },

    async rsvpEvent(input: RsvpEventInput): Promise<ProviderEventPayload> {
      if (!opts.config.scheduling_outbox_url) {
        throw new CalendarAdapterError(
          'permission_denied',
          'caldav rsvp: server does not expose a scheduling outbox',
        );
      }
      const cal = await resolveCalendarHref(input.calendar_id, 'rsvp');
      const parts = input.source_id.split(':');
      const uid = parts[1];
      if (!uid) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav rsvp: malformed source_id ${input.source_id}`,
        );
      }
      const key = occurrenceSuffix(parts, input.source_id, 'rsvp') ?? null;
      const href = `${cal.href.replace(/\/$/, '')}/${uid}.ics`;
      const existing = await fetchEventIcs(cal.href, href);
      const object = readObject(existing.body);
      if (object === null) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav rsvp: remote VEVENT unparseable uid=${uid}`,
        );
      }
      // The occurrence's own copy when it has one; else the series, as before.
      const named = occurrenceOf(object, key);
      const target = named !== null && named.event.recurrenceId !== undefined ? named.event : (object.master ?? named?.event ?? null);
      const selfEmail = input.self_email?.toLowerCase() ?? '';
      const mine = target === null || !selfEmail
        ? undefined
        : componentProps(object.doc, target.component, 'ATTENDEE').find((a) => mailtoOf(a.prop.value)?.toLowerCase() === selfEmail);
      if (target === null || mine === undefined) {
        throw new CalendarAdapterError(
          'attendee_not_self',
          `caldav rsvp: signed-in user is not an attendee on event ${uid}`,
        );
      }
      const ctx = newContext(object);
      const params = [...mine.prop.params].filter(([name]) => name !== 'PARTSTAT');
      ctx.editor.replaceLine(mine.index, [icsLine('ATTENDEE', mine.prop.value, [...params, ['PARTSTAT', PARTSTAT_VALUE[input.response] ?? 'NEEDS-ACTION']])]);
      touch(ctx, target.component, target.sequence, false);
      const ics = ctx.editor.render();
      // Skip the scheduling-outbox iTIP POST here — not every server
      // supports it even when the outbox is advertised. The PUT above
      // lands the PARTSTAT change locally; the server propagates it
      // to other attendees on its own cadence.
      await putEvent(cal, href, ics, 'PUT (rsvp)');
      return payloadAfterWrite(ics, key, cal, 'rsvp');
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Adapter factory
// ────────────────────────────────────────────────────────────────

export interface CreateCalDavAdapterFactoryOptions {
  etagStore: CalDavEtagStore;
  fetcher?: HttpFetcher;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  scheduler?: ProviderPollScheduler;
  /** The owner's IANA zone, read per use — a floating time is read in it. */
  timeZone?: () => string | undefined;
}

const parseCalDavConfig = (
  input: Record<string, unknown>,
): Omit<CalDavProviderConfig, 'password'> => {
  const serverUrl =
    typeof input.server_url === 'string' ? input.server_url : undefined;
  if (!serverUrl) throw new Error('caldav adapter: config.server_url is required');
  const username =
    typeof input.username === 'string' ? input.username : undefined;
  if (!username) throw new Error('caldav adapter: config.username is required');
  const calendarHome =
    typeof input.calendar_home_url === 'string'
      ? input.calendar_home_url
      : undefined;
  if (!calendarHome)
    throw new Error('caldav adapter: config.calendar_home_url is required');
  return {
    server_url: serverUrl,
    username,
    calendar_home_url: calendarHome,
    ...(typeof input.scheduling_outbox_url === 'string'
      ? { scheduling_outbox_url: input.scheduling_outbox_url }
      : {}),
    expansion_future_days:
      typeof input.expansion_future_days === 'number'
        ? input.expansion_future_days
        : 90,
    expansion_past_days:
      typeof input.expansion_past_days === 'number'
        ? input.expansion_past_days
        : 30,
    poll_seconds:
      typeof input.poll_seconds === 'number' ? input.poll_seconds : 300,
    ...(Array.isArray(input.calendar_filter)
      ? {
          calendar_filter: input.calendar_filter.filter(
            (v): v is string => typeof v === 'string',
          ),
        }
      : {}),
    ...(typeof input.probe_rsvp === 'boolean'
      ? { probe_rsvp: input.probe_rsvp }
      : {}),
  };
};

const probeCalDavCaps = async (
  cfg: Omit<CalDavProviderConfig, 'password'>,
  password: string,
  opts: CreateCalDavAdapterFactoryOptions,
): Promise<ProbedCalendarCaps> => {
  const fetcher = opts.fetcher ?? defaultCalDavFetcher;
  const authHeader = basicAuthHeader(cfg.username, password);
  const res = await fetcher(cfg.calendar_home_url, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader,
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: calendarHomePropfindBody(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw toCalDavError(res.status, body, 'PROPFIND probe');
  }
  // iTIP probe — when a scheduling outbox is configured, try a dry-run
  // POST. Any 2xx → rsvp cap 'yes', 4xx/5xx → 'no'. Defaults to 'no'
  // when no outbox or probe_rsvp:false.
  let rsvpCap: 'yes' | 'no' = 'no';
  if (cfg.probe_rsvp !== false && cfg.scheduling_outbox_url) {
    try {
      const probeRes = await fetcher(cfg.scheduling_outbox_url, {
        method: 'OPTIONS',
        headers: { Authorization: authHeader },
      });
      if (probeRes.ok) rsvpCap = 'yes';
    } catch {
      // Probe failure → leave rsvp cap as 'no'. Don't fail enrollment.
    }
  }
  return {
    read: 'yes',
    list_calendars: 'yes',
    create_event: 'yes',
    update_event: 'yes',
    delete_event: 'yes',
    rsvp: rsvpCap,
    search: 'local',
    watch: 'poll',
    auth: 'basic',
    recurrence: 'client',
  };
};

/** Resolve the caldav password from the account store. The composition
 *  root scopes `getAccountValue` to `caldav.<slug>.<key>`, so `'password'`
 *  reads back exactly what `enrollBasic` stored — no separate vault-key
 *  indirection. Throws when unset (broken state — the row exists but the
 *  credential was never written / was cleared). */
const requireCalDavPassword = async (
  ctx: CalendarAdapterContext,
): Promise<string> => {
  const pw = await ctx.getAccountValue('password');
  if (!pw) {
    throw new Error(`caldav adapter: password for '${ctx.slug}' not set`);
  }
  return pw;
};

export const createCalDavAdapterFactory = (
  opts: CreateCalDavAdapterFactoryOptions,
): CalendarAdapterFactory => ({
  kind: 'caldav',
  async probeCaps(ctx: CalendarAdapterContext) {
    const parsed = parseCalDavConfig(ctx.config);
    const password = await requireCalDavPassword(ctx);
    return probeCalDavCaps(parsed, password, opts);
  },
  create(ctx: CalendarAdapterContext): CalendarProvider {
    const parsed = parseCalDavConfig(ctx.config);
    // Synchronous create — the password resolves lazily on the first
    // request via the account store (`caldav.<slug>.password`) and is
    // cached after the first hit. We can't await inside create().
    let cached: string | null = null;
    const passwordGetter = async (): Promise<string> => {
      if (cached != null) return cached;
      cached = await requireCalDavPassword(ctx);
      return cached;
    };
    // The provider config requires a plain `password` string but the
    // real credential resolves lazily through `wrapLazyAuth` below; the
    // empty placeholder is only ever read when no Basic header is set.
    return createCalDavProvider({
      slug: ctx.slug,
      config: {
        ...parsed,
        password: '',
      },
      etagStore: opts.etagStore,
      fetcher: wrapLazyAuth(opts.fetcher, passwordGetter, parsed.username),
      now: opts.now,
      log: opts.log ?? ctx.log,
      scheduler: opts.scheduler,
      ...(opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {}),
    });
  },
});

/** Wrap the fetcher to rewrite the Authorization header lazily from a
 *  vault-sourced password. Lets the factory's synchronous `create`
 *  hand the provider a plain config while still resolving credentials
 *  on-demand. */
const wrapLazyAuth = (
  base: HttpFetcher | undefined,
  getPassword: () => Promise<string>,
  username: string,
): HttpFetcher => {
  const inner = base ?? defaultCalDavFetcher;
  return async (url, init) => {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    const current = headers.Authorization;
    if (typeof current === 'string' && current.startsWith('Basic ')) {
      const password = await getPassword();
      headers.Authorization = basicAuthHeader(username, password);
    }
    return inner(url, { ...(init ?? {}), headers });
  };
};

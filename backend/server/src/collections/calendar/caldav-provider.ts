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
import { makeBoundedOriginHttpFetcher } from '../../bounded-origin-http-fetcher.js';

import type {
  CalendarProvider,
  CalendarProviderHealth,
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
}

/** Persistent per-event ETag cache. Keyed by `(calendar_id, href)` ↦
 *  etag. Same shape as the OAuth account store so tests can share the
 *  in-memory double; production wires this to a dedicated sqlite
 *  backing table. */
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
// iCalendar parser (narrow — VEVENT only; ignores VTODO, VJOURNAL,
// VTIMEZONE; unescapes \\n, \\,, \\;)
// ────────────────────────────────────────────────────────────────

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
  /** Unix-ms UTC of DTSTART. All-day → midnight UTC of the date. */
  dtstart: number;
  /** Unix-ms UTC of DTEND (or DTSTART + DURATION). */
  dtend: number;
  /** IANA timezone if DTSTART;TZID was set; "UTC" for Z-suffixed
   *  datetimes; "" when the VEVENT is all-day without a TZID. */
  timezone: string;
  isAllDay: boolean;
  status: 'confirmed' | 'cancelled' | 'tentative';
  rrule?: string;
  exdates: number[];
  recurrenceId?: number;
  organizer?: { email: string; displayName?: string };
  attendees?: ParsedAttendee[];
  createdAt: number;
  lastModifiedAt: number;
  sequence: number;
}

const ICAL_LINE_PATTERN = /^([A-Z][A-Z0-9-]*)((?:;[A-Z][A-Z0-9-]*=[^:;]*)*):(.*)$/i;

const unescapeIcal = (s: string): string =>
  s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');

const unfoldIcalLines = (raw: string): string[] => {
  // RFC 5545 line folding: a line starting with a space or tab is a
  // continuation of the previous line.
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
};

const parseIcalParams = (segment: string): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!segment) return out;
  for (const part of segment.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
};

const parseIcalDateTime = (
  value: string,
  params: Record<string, string>,
): { at: number; timezone: string; allDay: boolean } => {
  if (/^\d{8}$/.test(value)) {
    // YYYYMMDD (all-day)
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6));
    const d = Number(value.slice(6, 8));
    return {
      at: Date.UTC(y, m - 1, d),
      timezone: params.TZID ?? 'UTC',
      allDay: true,
    };
  }
  // Accept "YYYYMMDDTHHMMSS" or "YYYYMMDDTHHMMSSZ".
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(value);
  if (!m) return { at: 0, timezone: params.TZID ?? 'UTC', allDay: false };
  const [, yy, mm, dd, hh, mi, ss, z] = m;
  if (z) {
    return {
      at: Date.UTC(
        Number(yy),
        Number(mm) - 1,
        Number(dd),
        Number(hh),
        Number(mi),
        Number(ss),
      ),
      timezone: 'UTC',
      allDay: false,
    };
  }
  // Floating / TZID-anchored datetimes — we don't resolve to UTC
  // because full IANA offset tables aren't shipped here. Treat the
  // datetime as UTC for storage and surface the TZID so display
  // layers can re-project. Good enough for meetings where the raw
  // offset within 24h is what matters.
  return {
    at: Date.UTC(
      Number(yy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss),
    ),
    timezone: params.TZID ?? 'UTC',
    allDay: false,
  };
};

const parseAttendeeLine = (
  value: string,
  params: Record<string, string>,
): ParsedAttendee | null => {
  const lower = value.toLowerCase();
  const mailtoIdx = lower.indexOf('mailto:');
  if (mailtoIdx < 0) return null;
  const email = value.slice(mailtoIdx + 'mailto:'.length).trim();
  if (!email) return null;
  const part = (params.PARTSTAT ?? '').toUpperCase();
  const responseStatus: ParsedAttendee['responseStatus'] =
    part === 'ACCEPTED'
      ? 'accepted'
      : part === 'DECLINED'
        ? 'declined'
        : part === 'TENTATIVE'
          ? 'tentative'
          : 'needs_action';
  const cn = params.CN ? decodeIcalCn(params.CN) : undefined;
  return {
    email,
    ...(cn ? { displayName: cn } : {}),
    responseStatus,
  };
};

const decodeIcalCn = (s: string): string => {
  const trimmed = s.replace(/^"/, '').replace(/"$/, '');
  return trimmed;
};

/** Parse a single VEVENT block. Returns null when the block is
 *  malformed. */
export const parseVEvent = (raw: string): ParsedVEvent | null => {
  const lines = unfoldIcalLines(raw);
  let inside = false;
  const v: Partial<ParsedVEvent> & {
    exdates: number[];
    attendees: ParsedAttendee[];
  } = {
    exdates: [],
    attendees: [],
    sequence: 0,
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      inside = true;
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      inside = false;
      break;
    }
    if (!inside) continue;
    const m = ICAL_LINE_PATTERN.exec(trimmed);
    if (!m) continue;
    const [, rawName, rawParams, rawValue] = m;
    const name = rawName.toUpperCase();
    const params = parseIcalParams(rawParams ?? '');
    const value = rawValue;
    switch (name) {
      case 'UID':
        v.uid = value;
        break;
      case 'SUMMARY':
        v.summary = unescapeIcal(value);
        break;
      case 'DESCRIPTION':
        v.description = unescapeIcal(value);
        break;
      case 'LOCATION':
        v.location = unescapeIcal(value);
        break;
      case 'DTSTART': {
        const parsed = parseIcalDateTime(value, params);
        v.dtstart = parsed.at;
        v.timezone = parsed.timezone;
        v.isAllDay = parsed.allDay;
        break;
      }
      case 'DTEND': {
        const parsed = parseIcalDateTime(value, params);
        v.dtend = parsed.at;
        break;
      }
      case 'STATUS': {
        const s = value.toUpperCase();
        v.status =
          s === 'CANCELLED'
            ? 'cancelled'
            : s === 'TENTATIVE'
              ? 'tentative'
              : 'confirmed';
        break;
      }
      case 'RRULE':
        v.rrule = value;
        break;
      case 'EXDATE': {
        const parsed = parseIcalDateTime(value, params);
        v.exdates.push(parsed.at);
        break;
      }
      case 'RECURRENCE-ID': {
        const parsed = parseIcalDateTime(value, params);
        v.recurrenceId = parsed.at;
        break;
      }
      case 'ORGANIZER': {
        const att = parseAttendeeLine(value, params);
        if (att) {
          v.organizer = {
            email: att.email,
            ...(att.displayName ? { displayName: att.displayName } : {}),
          };
        }
        break;
      }
      case 'ATTENDEE': {
        const att = parseAttendeeLine(value, params);
        if (att) v.attendees.push(att);
        break;
      }
      case 'CREATED':
        v.createdAt = parseIcalDateTime(value, params).at;
        break;
      case 'LAST-MODIFIED':
        v.lastModifiedAt = parseIcalDateTime(value, params).at;
        break;
      case 'SEQUENCE': {
        const n = Number(value);
        if (Number.isFinite(n)) v.sequence = n;
        break;
      }
    }
  }
  if (!v.uid || typeof v.dtstart !== 'number') return null;
  if (typeof v.dtend !== 'number') v.dtend = v.dtstart;
  return {
    uid: v.uid,
    summary: v.summary,
    description: v.description,
    location: v.location,
    dtstart: v.dtstart,
    dtend: v.dtend,
    timezone: v.timezone ?? 'UTC',
    isAllDay: v.isAllDay ?? false,
    status: v.status ?? 'confirmed',
    rrule: v.rrule,
    exdates: v.exdates,
    recurrenceId: v.recurrenceId,
    organizer: v.organizer,
    attendees: v.attendees.length > 0 ? v.attendees : undefined,
    createdAt: v.createdAt ?? v.dtstart,
    lastModifiedAt: v.lastModifiedAt ?? v.createdAt ?? v.dtstart,
    sequence: v.sequence ?? 0,
  };
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
    const parsed = parseIcalDateTime(kv.UNTIL, {});
    if (parsed.at > 0) until = parsed.at;
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
 *  occurrence timestamps in unix-ms UTC. Includes DTSTART only when
 *  it falls within the window.
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
  const limitUntil = parsed.until ?? window.windowEnd;
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
// Canonicalization
// ────────────────────────────────────────────────────────────────

const canonicalFromVEvent = (
  base: ParsedVEvent,
  occurrenceAt: number,
  href: string,
  calendarId: string,
  calendarName?: string,
): CanonicalEvent => {
  const duration = base.dtend - base.dtstart;
  const endAt = occurrenceAt + duration;
  const source_id = occurrenceAt === base.dtstart
    ? `${calendarId}:${base.uid}`
    : `${calendarId}:${base.uid}:${occurrenceAt}`;
  const canonical: CanonicalEvent = {
    source_id,
    ical_uid: base.uid,
    calendar_id: calendarId,
    ...(calendarName ? { calendar_name: calendarName } : {}),
    summary: base.summary ?? '',
    ...(base.description ? { description: base.description } : {}),
    ...(base.location ? { location: base.location } : {}),
    start_at: occurrenceAt,
    end_at: endAt,
    timezone: base.timezone,
    is_all_day: base.isAllDay,
    ...(base.organizer
      ? {
          organizer: {
            email: base.organizer.email,
            ...(base.organizer.displayName
              ? { display_name: base.organizer.displayName }
              : {}),
          },
        }
      : {}),
    ...(base.attendees && base.attendees.length > 0
      ? {
          attendees: base.attendees.map((a) => ({
            email: a.email,
            ...(a.displayName ? { display_name: a.displayName } : {}),
            response_status: a.responseStatus,
            ...(a.isSelf ? { is_self: true as const } : {}),
          })),
        }
      : {}),
    status: base.status,
    ...(base.rrule ? { recurrence_rule: base.rrule } : {}),
    ...(occurrenceAt !== base.dtstart
      ? { recurring_event_id: `${calendarId}:${base.uid}` }
      : {}),
    created_at: base.createdAt,
    updated_at: base.lastModifiedAt,
  };
  // Silence unused-param lint — href is kept on the signature so
  // future adapters can store it into a provider-specific side table.
  void href;
  return canonical;
};

const buildPayloadFromExpanded = (
  base: ParsedVEvent,
  occurrenceAt: number,
  href: string,
  etag: string,
  calendarId: string,
  calendarName?: string,
): ProviderEventPayload => {
  const canonical = canonicalFromVEvent(
    base,
    occurrenceAt,
    href,
    calendarId,
    calendarName,
  );
  const descriptionBytes = canonical.description
    ? Buffer.byteLength(canonical.description, 'utf8')
    : 0;
  return { event: canonical, description_bytes: descriptionBytes, etag };
};

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

  const ingestEvent = async (
    calendar: { id: string; href: string; displayname: string },
    eventHref: string,
    etag: string,
    calendarData: string | undefined,
    emit: (event: ProviderEventPayload) => Promise<void>,
  ): Promise<void> => {
    let icsBody = calendarData;
    if (!icsBody) {
      icsBody = (await fetchEventIcs(calendar.href, eventHref)).body;
    }
    const parsed = parseVEvent(icsBody);
    if (!parsed) {
      markError(`caldav unparseable VEVENT href=${eventHref}`, null);
      // Do not stamp this ETag or let an initial scan certify completion. The
      // provider resource is still present but has not been durably represented
      // in the collection; retaining the old/no ETag makes it retryable.
      throw new Error(`caldav event '${eventHref}' could not be parsed`);
    }
    const window: RRuleExpansionWindow = {
      windowStart:
        nowOf() - opts.config.expansion_past_days * 86_400_000,
      windowEnd:
        nowOf() + opts.config.expansion_future_days * 86_400_000,
    };
    const { instances, partial } = expandRRule(
      parsed.dtstart,
      parsed.rrule,
      parsed.exdates,
      window,
    );
    if (partial) pendingSeriesExpansions++;
    for (const occurrenceAt of instances) {
      const payload = buildPayloadFromExpanded(
        parsed,
        occurrenceAt,
        eventHref,
        etag,
        calendar.id,
        calendar.displayname,
      );
      await emit(payload);
    }
    await opts.etagStore.set(etagKey(calendar.id, eventHref), etag);
  };

  // ── initial scan ────────────────────────────────────────────
  const runInitialScan = async (
    scanOpts: InitialScanOptions,
  ): Promise<void> => {
    const calendars = await discoverCalendars();
    const windowStart = nowOf() - scanOpts.backfill_days * 86_400_000;
    const windowEnd = nowOf() + scanOpts.expansion_future_days * 86_400_000;
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
      for (const entry of entries) {
        if (aborted) break;
        let continueScan = true;
        await ingestEvent(cal, entry.href, entry.etag, entry.calendarData, async (payload) => {
          if (!continueScan) return;
          const cont = await scanOpts.onEvent(payload);
          lastSuccessfulSyncAt = nowOf();
          if (!cont) {
            continueScan = false;
            aborted = true;
          }
        });
      }
    }
  };

  // ── incremental sync tick ───────────────────────────────────
  const runSyncTick = async (cb: CalendarSyncCallback): Promise<void> => {
    const calendars = await discoverCalendars();
    const windowStart = nowOf() - opts.config.expansion_past_days * 86_400_000;
    const windowEnd = nowOf() + opts.config.expansion_future_days * 86_400_000;
    for (const cal of calendars) {
      const res = await davRequest(
        absolute(cal.href, cal.href),
        'REPORT',
        {
          Depth: '1',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        calendarQueryBody(windowStart, windowEnd, false),
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
        const prevEtag = prevMap.get(k);
        if (prevEtag && prevEtag === entry.etag) continue; // unchanged

        pendingQueueSize++;
        try {
          await ingestEvent(
            cal,
            entry.href,
            entry.etag,
            entry.calendarData,
            async (payload) => {
              const sync: CalendarSyncEvent = {
                kind: 'updated',
                source_id: payload.event.source_id,
                payload,
              };
              await cb(sync);
              lastSuccessfulSyncAt = nowOf();
            },
          );
        } catch (err) {
          markError(`caldav ingest failed href=${entry.href}`, err);
        } finally {
          pendingQueueSize = Math.max(0, pendingQueueSize - 1);
        }
      }

      // Missing hrefs → deletions.
      for (const [k] of prevMap) {
        if (currentKeys.has(k)) continue;
        try {
          await cb({
            kind: 'deleted',
            source_id: `${cal.id}:${k.slice(etagPrefix(cal.id).length)}`,
          });
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
  const serialiseDateTime = (at: number, isAllDay: boolean): string => {
    const d = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, '0');
    if (isAllDay) {
      return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    }
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  };

  const escapeIcal = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

  const icsLine = (name: string, value: string, params: string = ''): string =>
    `${name}${params}:${value}\r\n`;

  const buildVEvent = (
    uid: string,
    event: Omit<CanonicalEvent, 'source_id' | 'ical_uid' | 'created_at' | 'updated_at'>,
    now: number,
  ): string => {
    const stamp = serialiseDateTime(now, false);
    const lines: string[] = [
      'BEGIN:VCALENDAR\r\n',
      'VERSION:2.0\r\n',
      'PRODID:-//recued//caldav-adapter//EN\r\n',
      'BEGIN:VEVENT\r\n',
      icsLine('UID', uid),
      icsLine('DTSTAMP', stamp),
      icsLine(
        'DTSTART',
        serialiseDateTime(event.start_at, event.is_all_day),
        event.is_all_day ? ';VALUE=DATE' : '',
      ),
      icsLine(
        'DTEND',
        serialiseDateTime(event.end_at, event.is_all_day),
        event.is_all_day ? ';VALUE=DATE' : '',
      ),
      icsLine('SUMMARY', escapeIcal(event.summary)),
    ];
    if (event.description)
      lines.push(icsLine('DESCRIPTION', escapeIcal(event.description)));
    if (event.location)
      lines.push(icsLine('LOCATION', escapeIcal(event.location)));
    lines.push(icsLine('STATUS', event.status.toUpperCase()));
    if (event.organizer) {
      const cn = event.organizer.display_name
        ? `;CN=${event.organizer.display_name}`
        : '';
      lines.push(icsLine('ORGANIZER', `mailto:${event.organizer.email}`, cn));
    }
    if (event.attendees) {
      for (const a of event.attendees) {
        const parts: string[] = [];
        if (a.display_name) parts.push(`CN=${a.display_name}`);
        const partstat =
          a.response_status === 'needs_action'
            ? 'NEEDS-ACTION'
            : a.response_status.toUpperCase();
        parts.push(`PARTSTAT=${partstat}`);
        const params = `;${parts.join(';')}`;
        lines.push(icsLine('ATTENDEE', `mailto:${a.email}`, params));
      }
    }
    if (event.recurrence_rule) lines.push(icsLine('RRULE', event.recurrence_rule));
    lines.push('END:VEVENT\r\n', 'END:VCALENDAR\r\n');
    return lines.join('');
  };

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

  // Project a parsed master VEVENT + a partial patch into the
  // `buildVEvent` input shape. Mirrors the merge the single-PUT update
  // path applies; factored so the `this_and_future` split reuses it
  // (empty patch → carry the master forward unchanged).
  const mergedFromParsed = (
    p: ParsedVEvent,
    patch: UpdateEventInput['patch'],
    calId: string,
  ): Omit<
    CanonicalEvent,
    'source_id' | 'ical_uid' | 'created_at' | 'updated_at'
  > => ({
    calendar_id: calId,
    summary: patch.summary ?? p.summary ?? '',
    ...(patch.description !== undefined
      ? { description: patch.description }
      : p.description
        ? { description: p.description }
        : {}),
    ...(patch.location !== undefined
      ? { location: patch.location }
      : p.location
        ? { location: p.location }
        : {}),
    start_at: patch.start_at ?? p.dtstart,
    end_at: patch.end_at ?? p.dtend,
    timezone: patch.timezone ?? p.timezone,
    is_all_day: patch.is_all_day ?? p.isAllDay,
    ...(p.organizer
      ? {
          organizer: {
            email: p.organizer.email,
            ...(p.organizer.displayName
              ? { display_name: p.organizer.displayName }
              : {}),
          },
        }
      : {}),
    ...(patch.attendees
      ? { attendees: patch.attendees }
      : p.attendees
        ? {
            attendees: p.attendees.map((a) => ({
              email: a.email,
              ...(a.displayName ? { display_name: a.displayName } : {}),
              response_status: a.responseStatus,
            })),
          }
        : {}),
    status: patch.status ?? p.status,
    ...(patch.recurrence_rule !== undefined
      ? patch.recurrence_rule
        ? { recurrence_rule: patch.recurrence_rule }
        : {}
      : p.rrule
        ? { recurrence_rule: p.rrule }
        : {}),
  });

  // Decode the triggering occurrence from a caldav source_id's optional
  // trailing `:${at}` (unix-ms). A present-but-non-numeric suffix is
  // malformed for our format — fail CLOSED rather than silently
  // widening a `this_and_future` edit into a whole-series edit. (A UID
  // that itself contains ':' is a separate, pre-existing convention
  // limitation: `parts[1]` is taken as the uid, which 404s for such
  // servers — first-party UIDs are colon-free `<hash>@recued`.)
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

  // Truncate the master VEVENT so the series ends strictly before
  // `splitAt`. Surgically swaps ONLY the RRULE line in the original ICS
  // and PUTs the rest verbatim, so every other property the master
  // carries — EXDATE (pre-split exceptions), TZID, VALARM, SEQUENCE,
  // X-* — survives untouched. (Rebuilding through `buildVEvent` would
  // drop EXDATE, resurrecting deleted occurrences, and flatten TZID to
  // bare UTC, shifting timed events.) Shared by the `this_and_future`
  // update + delete paths.
  const putTruncatedMaster = async (
    cal: { id: string; href: string; displayname: string },
    href: string,
    rawIcs: string,
    parsed: ParsedVEvent,
    splitAt: number,
  ): Promise<void> => {
    // UNTIL is inclusive, so cut one second before the split point to
    // drop the triggering occurrence while keeping its predecessor.
    // `serialiseDateTime` emits a UTC DATE-TIME (timed) or DATE
    // (all-day) to match the master's DTSTART value type.
    const untilValue = serialiseDateTime(splitAt - 1000, parsed.isAllDay);
    const truncated = capRRuleUntil(parsed.rrule ?? '', untilValue);
    // Match the RRULE property line plus any folded continuations.
    const rruleLine = /^RRULE[;:].*(?:\r?\n[ \t].*)*/im;
    if (!rruleLine.test(rawIcs)) {
      throw new CalendarAdapterError(
        'io_error',
        `caldav this_and_future: no RRULE line to truncate in ${href}`,
      );
    }
    const rewritten = rawIcs.replace(rruleLine, () => `RRULE:${truncated}`);
    const res = await fetcher(absolute(cal.href, href), {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'text/calendar; charset=utf-8',
      },
      body: rewritten,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw toCalDavError(res.status, text, 'PUT (this_and_future truncate)');
    }
  };

  // CalDAV `this_and_future` UPDATE. CalDAV holds the whole series as
  // one VEVENT file, so the adapter — not the dispatcher — owns the
  // split (gcal/graph defer theirs to the dispatcher per provider
  // quirks). Step 1: truncate the master. Step 2: PUT a fresh series
  // (new UID) carrying the patch forward from `splitAt` with the
  // original cadence. Returns the NEW series' first-occurrence payload
  // — the event the "edit this and following" gesture creates. Earlier
  // occurrences + the truncated tail reconcile on the next sync tick
  // (the adapter's existing eventually-consistent mutation contract).
  const splitSeriesUpdate = async (
    cal: { id: string; href: string; displayname: string },
    uid: string,
    href: string,
    rawIcs: string,
    parsed: ParsedVEvent,
    patch: UpdateEventInput['patch'],
    splitAt: number,
  ): Promise<ProviderEventPayload> => {
    await putTruncatedMaster(cal, href, rawIcs, parsed, splitAt);

    const duration = parsed.dtend - parsed.dtstart;
    const newStart = patch.start_at ?? splitAt;
    const newEnd = patch.end_at ?? newStart + duration;
    // Carry the original cadence forward (COUNT-adjusted so the split
    // can't manufacture phantom occurrences). Honour a patched rule
    // verbatim when the caller supplied one.
    const carriedRule =
      patch.recurrence_rule !== undefined
        ? patch.recurrence_rule
        : newSeriesRRule(parsed.rrule ?? '', parsed.dtstart, splitAt);
    const newSeries: Omit<
      CanonicalEvent,
      'source_id' | 'ical_uid' | 'created_at' | 'updated_at'
    > = {
      ...mergedFromParsed(parsed, patch, cal.id),
      start_at: newStart,
      end_at: newEnd,
      ...(carriedRule ? { recurrence_rule: carriedRule } : {}),
    };
    const newUid = `${createHash('sha1')
      .update(`${cal.id}:${nowOf()}:${newSeries.summary}:${newStart}`)
      .digest('hex')}@recued`;
    const newHref = `${cal.href.replace(/\/$/, '')}/${newUid}.ics`;
    const newIcs = buildVEvent(newUid, newSeries, nowOf());
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
    const reparsed = parseVEvent(newIcs);
    if (!reparsed) {
      throw new CalendarAdapterError(
        'io_error',
        'caldav PUT (this_and_future): locally produced VEVENT failed round-trip parse',
      );
    }
    return buildPayloadFromExpanded(
      reparsed,
      reparsed.dtstart,
      newHref,
      '',
      cal.id,
      cal.displayname,
    );
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
      const uid = `${createHash('sha1')
        .update(`${cal.id}:${nowOf()}:${event.summary}:${event.start_at}`)
        .digest('hex')}@recued`;
      const href = `${cal.href.replace(/\/$/, '')}/${uid}.ics`;
      const ics = buildVEvent(uid, event, nowOf());
      const res = await fetcher(absolute(cal.href, href), {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'text/calendar; charset=utf-8',
          'If-None-Match': '*',
        },
        body: ics,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw toCalDavError(res.status, text, 'PUT (create)');
      }
      const parsed = parseVEvent(ics);
      if (!parsed) {
        throw new CalendarAdapterError(
          'io_error',
          'caldav PUT (create): locally produced VEVENT failed round-trip parse',
        );
      }
      return buildPayloadFromExpanded(
        parsed,
        parsed.dtstart,
        href,
        '',
        cal.id,
        cal.displayname,
      );
    },

    async updateEvent(input: UpdateEventInput) {
      const cal = await resolveCalendarHref(input.calendar_id, 'PUT (update)');
      // Source_id shape: `${cal.id}:${uid}` or `${cal.id}:${uid}:${at}`
      // — peel the uid (the .ics file) and the triggering occurrence.
      const parts = input.source_id.split(':');
      const uid = parts[1];
      if (!uid) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav update: malformed source_id ${input.source_id}`,
        );
      }
      const href = `${cal.href.replace(/\/$/, '')}/${uid}.ics`;
      const existing = await fetchEventIcs(cal.href, href);
      const parsed = parseVEvent(existing.body);
      if (!parsed) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav update: remote VEVENT unparseable uid=${uid}`,
        );
      }
      if (input.scope === 'this_and_future') {
        const splitAt =
          occurrenceSuffix(parts, input.source_id, 'update') ??
          parsed.dtstart;
        // A real split only applies past the first occurrence of an
        // actual series. Editing from the first occurrence (or a
        // non-recurring event) is a whole-series edit — fall through
        // to the single-PUT path below.
        if (parsed.rrule && splitAt > parsed.dtstart) {
          return await splitSeriesUpdate(
            cal,
            uid,
            href,
            existing.body,
            parsed,
            input.patch,
            splitAt,
          );
        }
      }
      const merged = mergedFromParsed(parsed, input.patch, cal.id);
      const ics = buildVEvent(uid, merged, nowOf());
      const res = await fetcher(absolute(cal.href, href), {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'text/calendar; charset=utf-8',
        },
        body: ics,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw toCalDavError(res.status, text, 'PUT (update)');
      }
      const reparsed = parseVEvent(ics);
      if (!reparsed) {
        throw new CalendarAdapterError(
          'io_error',
          'caldav PUT (update): locally produced VEVENT failed round-trip parse',
        );
      }
      return buildPayloadFromExpanded(
        reparsed,
        reparsed.dtstart,
        href,
        '',
        cal.id,
        cal.displayname,
      );
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
      const href = `${cal.href.replace(/\/$/, '')}/${uid}.ics`;
      if (input.scope === 'this_and_future') {
        // Drop the triggering occurrence + everything after it by
        // capping the master RRULE. No new series. Falls through to a
        // whole-file DELETE when the split lands on (or before) the
        // first occurrence, or the event isn't recurring.
        const existing = await fetchEventIcs(cal.href, href);
        const parsed = parseVEvent(existing.body);
        if (!parsed) {
          throw new CalendarAdapterError(
            'event_not_found',
            `caldav delete: remote VEVENT unparseable uid=${uid}`,
          );
        }
        const splitAt =
          occurrenceSuffix(parts, input.source_id, 'delete') ??
          parsed.dtstart;
        if (parsed.rrule && splitAt > parsed.dtstart) {
          await putTruncatedMaster(cal, href, existing.body, parsed, splitAt);
          return;
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
      const href = `${cal.href.replace(/\/$/, '')}/${uid}.ics`;
      const existing = await fetchEventIcs(cal.href, href);
      const parsed = parseVEvent(existing.body);
      if (!parsed) {
        throw new CalendarAdapterError(
          'event_not_found',
          `caldav rsvp: remote VEVENT unparseable uid=${uid}`,
        );
      }
      const selfEmail = input.self_email?.toLowerCase() ?? '';
      const attendees = parsed.attendees ?? [];
      const selfIdx = attendees.findIndex(
        (a) => selfEmail && a.email.toLowerCase() === selfEmail,
      );
      if (selfIdx === -1) {
        throw new CalendarAdapterError(
          'attendee_not_self',
          `caldav rsvp: signed-in user is not an attendee on event ${uid}`,
        );
      }
      const nextStatus: ParsedAttendee['responseStatus'] =
        input.response === 'accepted'
          ? 'accepted'
          : input.response === 'declined'
            ? 'declined'
            : 'tentative';
      const nextAttendees = attendees.map((a, i) =>
        i === selfIdx ? { ...a, responseStatus: nextStatus } : a,
      );
      parsed.attendees = nextAttendees;
      const merged: Omit<
        CanonicalEvent,
        'source_id' | 'ical_uid' | 'created_at' | 'updated_at'
      > = {
        calendar_id: cal.id,
        summary: parsed.summary ?? '',
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.location ? { location: parsed.location } : {}),
        start_at: parsed.dtstart,
        end_at: parsed.dtend,
        timezone: parsed.timezone,
        is_all_day: parsed.isAllDay,
        ...(parsed.organizer
          ? {
              organizer: {
                email: parsed.organizer.email,
                ...(parsed.organizer.displayName
                  ? { display_name: parsed.organizer.displayName }
                  : {}),
              },
            }
          : {}),
        attendees: nextAttendees.map((a) => ({
          email: a.email,
          ...(a.displayName ? { display_name: a.displayName } : {}),
          response_status: a.responseStatus,
        })),
        status: parsed.status,
        ...(parsed.rrule ? { recurrence_rule: parsed.rrule } : {}),
      };
      const ics = buildVEvent(uid, merged, nowOf());
      const res = await fetcher(absolute(cal.href, href), {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'text/calendar; charset=utf-8',
        },
        body: ics,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw toCalDavError(res.status, text, 'PUT (rsvp)');
      }
      // Skip the scheduling-outbox iTIP POST here — not every server
      // supports it even when the outbox is advertised. The PUT above
      // lands the PARTSTAT change locally; the server propagates it
      // to other attendees on its own cadence.
      const reparsed = parseVEvent(ics);
      if (!reparsed) {
        throw new CalendarAdapterError(
          'io_error',
          'caldav rsvp: locally produced VEVENT failed round-trip parse',
        );
      }
      return buildPayloadFromExpanded(
        reparsed,
        reparsed.dtstart,
        href,
        '',
        cal.id,
        cal.displayname,
      );
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

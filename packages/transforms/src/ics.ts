/** D-315 slice 7 (ruling 34) — reading an iCalendar file: a calendar invite, a
 *  reply to one, a cancellation, or a published event.
 *
 *  🔑 WHY NOT THE CALDAV PROVIDER'S READER. It reads a calendar's own events
 *  to mirror and edit them, not what one message says: `METHOD` (a guest's
 *  decline is not one more meeting), `you`, the owner's words for the time.
 *  What they share is how a time is read — since 2026-10-07 the CalDAV
 *  adapter reads its times on this module's `icsClock`. Before, it read a
 *  time written in a zone AS IF IT WERE UTC, and let a reminder's own
 *  `DESCRIPTION` overwrite the event's.
 *
 *  ⛔⛔ TIMES ARE THE WHOLE RISK. An invite says "10:00" and a zone; read in the
 *  wrong zone it is a booking hours off, and nothing downstream can tell. So a
 *  time is resolved in this order and is NEVER guessed:
 *   1. the zone's own rules, from the file's `VTIMEZONE`. This is what Outlook's
 *      zone names need — `Pacific Standard Time` is a Windows name no IANA table
 *      knows — and it is what the organizer's own client used;
 *   2. an IANA zone name, through the platform's tables (`Intl`);
 *   3. a FLOATING time (no zone at all) in the calendar's `X-WR-TIMEZONE`, else
 *      the owner's zone.
 *  A zone none of these can read leaves the event's times `null` and says so in
 *  `problems` — a consumer refuses it rather than booking the wrong hour.
 *
 *  ⚠ Lines are unfolded on BYTES, then decoded: a generator may fold a line in
 *  the middle of a multi-byte character, and decoding first would turn both
 *  halves into replacement characters.
 *
 *  ⛔ TEXT IN, VALUES OUT — this never sees a file ref. Reading the bytes is the
 *  kernel op's job (`core.storage.ics.read`), behind the same gate as every other
 *  read of a stored file; mail ingest uses `looksLikeIcs` / `icsInviteKey` on
 *  bytes it already holds. */

import { zoneOffsetMsAt, zonedWallClockToEpochMs } from '@recued/contracts';

/** A larger file is refused rather than parsed: an invite is a few kilobytes,
 *  and this bounds what a mistaken ref can make the server hold. */
export const ICS_MAX_BYTES = 1_048_576;
/** Events read from one file; the rest are counted, not returned. */
export const ICS_MAX_EVENTS = 200;
/** Guests listed per event; `attendee_count` still counts them all. */
export const ICS_MAX_ATTENDEES = 200;
/** An event's description, in characters; `description_truncated` says so. */
export const ICS_MAX_DESCRIPTION = 4000;
const ICS_MAX_SHORT_TEXT = 500;
const ICS_MAX_PROBLEMS = 20;
/** How far into a file `looksLikeIcs` looks for `BEGIN:VCALENDAR`. */
const ICS_SNIFF_BYTES = 64;

export type IcsMethod =
  | 'request' | 'cancel' | 'reply' | 'publish' | 'add' | 'refresh' | 'counter' | 'declinecounter'
  /** A `METHOD` this reader does not know. */
  | 'other'
  /** No `METHOD`: a plain calendar file (an "add to calendar" download). */
  | 'none';

export type IcsPartstat = 'needs_action' | 'accepted' | 'declined' | 'tentative' | 'delegated';
export type IcsRole = 'chair' | 'required' | 'optional' | 'non_participant';
/** `CUTYPE`. A room or a resource is booked, not invited: it is no guest. */
export type IcsAttendeeKind = 'person' | 'group' | 'room' | 'resource';

/** How an event's times were read. `unresolved` leaves them `null`. */
export type IcsTimeBasis = 'utc' | 'zone' | 'floating' | 'date' | 'unresolved';

export interface IcsPerson {
  /** Lowercased, without `mailto:`. */
  readonly email: string;
  readonly name: string | null;
}

export interface IcsAttendee extends IcsPerson {
  readonly status: IcsPartstat;
  readonly role: IcsRole;
  readonly rsvp: boolean;
  readonly kind: IcsAttendeeKind;
}

export interface IcsYou {
  /** Who the owner is in this event, by the addresses passed in. */
  readonly role: 'organizer' | 'attendee' | 'none';
  /** The owner's address as the event names it. */
  readonly email: string | null;
  /** The owner's answer, when the event lists the owner as a guest. */
  readonly status: IcsPartstat | null;
  readonly rsvp: boolean;
}

export interface IcsEvent {
  readonly uid: string;
  /** The occurrence of a series this event replaces — an ISO instant, or a
   *  `YYYY-MM-DD` day — or `null` for a series or a single event. */
  readonly recurrence_id: string | null;
  readonly sequence: number;
  readonly status: 'confirmed' | 'tentative' | 'cancelled' | null;
  readonly summary: string | null;
  readonly location: string | null;
  readonly description: string | null;
  readonly description_truncated: boolean;
  readonly url: string | null;
  readonly all_day: boolean;
  /** ISO instants, `null` when the time could not be read. */
  readonly start: string | null;
  readonly end: string | null;
  /** The same instants in ms. An all-day event spans its days from the
   *  owner's local midnight. */
  readonly start_ms: number | null;
  readonly end_ms: number | null;
  /** All-day only: the first day, and the day after the last (RFC 5545's
   *  exclusive end). */
  readonly start_date: string | null;
  readonly end_date: string | null;
  /** The zone the times were read in, as the file names it (`UTC` for a `Z`
   *  time). `null` for an all-day event. */
  readonly time_zone: string | null;
  /** The event's time as the owner reads it, in the owner's zone — "Thu 15
   *  Oct 2026, 10:00–11:00", or "Tue 20 Oct – Thu 22 Oct 2026" for days. For
   *  a recipe's words: a recipe's own date transforms read the SERVER's
   *  clock, which on a server in UTC is hours off. `null` when the time could
   *  not be read. */
  readonly when: string | null;
  readonly time_basis: IcsTimeBasis;
  readonly recurring: boolean;
  readonly rrule: string | null;
  readonly organizer: IcsPerson | null;
  readonly attendees: readonly IcsAttendee[];
  readonly attendee_count: number;
  readonly you: IcsYou;
  /** People other than the organizer and the owner — rooms and resources left
   *  out. 0 for an appointment with one person, or a published event. */
  readonly others_count: number;
  readonly problems: readonly string[];
}

export interface IcsParseResult {
  /** Whether the text is an iCalendar object at all. */
  readonly ok: boolean;
  readonly method: IcsMethod;
  readonly prodid: string | null;
  readonly events: readonly IcsEvent[];
  /** The first event that is not one occurrence of a series, else the first
   *  event, else `null`. */
  readonly event: IcsEvent | null;
  /** Every `VEVENT`, including any past `ICS_MAX_EVENTS`. */
  readonly event_count: number;
  readonly truncated: boolean;
  readonly problems: readonly string[];
}

export interface IcsParseOptions {
  /** The owner's IANA zone: a floating time and an all-day event's midnight
   *  are read there. Absent or unknown, they are read in UTC. */
  readonly timeZone?: string;
  /** The owner's own addresses, for `you` and `others_count`. */
  readonly addresses?: readonly string[];
}

// ────────────────────────────────────────────────────────────────
// Bytes
// ────────────────────────────────────────────────────────────────

const BEGIN_VCALENDAR = 'BEGIN:VCALENDAR';

const isBlankByte = (b: number | undefined): boolean => b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;

/** Whether bytes are an iCalendar object: `BEGIN:VCALENDAR` first, after an
 *  optional UTF-8 BOM and blank lines. Read by mail ingest to store an invite
 *  as `text/calendar` whatever type it was sent with — Google's own
 *  `invite.ics` is `application/ics`, and an `.ics` saved by hand is often
 *  `application/octet-stream`. */
export const looksLikeIcs = (bytes: Uint8Array): boolean => {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && i < ICS_SNIFF_BYTES && isBlankByte(bytes[i])) i += 1;
  if (bytes.length - i < BEGIN_VCALENDAR.length) return false;
  for (let k = 0; k < BEGIN_VCALENDAR.length; k += 1) {
    let b = bytes[i + k]!;
    if (b >= 0x61 && b <= 0x7a) b -= 0x20;
    if (b !== BEGIN_VCALENDAR.charCodeAt(k)) return false;
  }
  return true;
};

/** Unfold (RFC 5545 §3.1) and decode. On bytes, the fold is removed before
 *  decoding, so a character split across a fold is whole again. */
const unfold = (input: string | Uint8Array): string => {
  if (typeof input === 'string') return input.replace(/\r?\n[ \t]/g, '');
  const out = new Uint8Array(input.length);
  let n = 0;
  for (let i = 0; i < input.length; i += 1) {
    const b = input[i]!;
    if (b === 0x0d && input[i + 1] === 0x0a && (input[i + 2] === 0x20 || input[i + 2] === 0x09)) {
      i += 2;
      continue;
    }
    if (b === 0x0a && (input[i + 1] === 0x20 || input[i + 1] === 0x09)) {
      i += 1;
      continue;
    }
    out[n] = b;
    n += 1;
  }
  // The decoder drops a leading BOM by default.
  return new TextDecoder('utf-8').decode(out.subarray(0, n));
};

// ────────────────────────────────────────────────────────────────
// Content lines and components
// ────────────────────────────────────────────────────────────────

interface Prop {
  readonly name: string;
  readonly params: ReadonlyMap<string, readonly string[]>;
  readonly value: string;
}

interface Component {
  readonly name: string;
  readonly props: Prop[];
  readonly children: Component[];
}

const NAME_RE = /^[A-Z0-9-]+$/;

/** One content line: `NAME *(;PARAM=value[,value]) : value`. A parameter
 *  value may be quoted, and a quoted one may hold `:`, `;` and `,` — Google's
 *  `SENT-BY="mailto:…"` and a `CN="Doe; Jane"` both do. */
const parseLine = (line: string): Prop | null => {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ';' && line[i] !== ':') i += 1;
  if (i >= n) return null;
  const name = line.slice(0, i).trim().toUpperCase();
  if (!NAME_RE.test(name)) return null;
  const params = new Map<string, string[]>();
  while (i < n && line[i] === ';') {
    i += 1;
    const start = i;
    while (i < n && line[i] !== '=' && line[i] !== ';' && line[i] !== ':') i += 1;
    const pname = line.slice(start, i).trim().toUpperCase();
    const values: string[] = [];
    if (line[i] === '=') {
      i += 1;
      for (;;) {
        if (line[i] === '"') {
          const close = line.indexOf('"', i + 1);
          if (close < 0) return null;
          values.push(line.slice(i + 1, close));
          i = close + 1;
        } else {
          const vs = i;
          while (i < n && line[i] !== ',' && line[i] !== ';' && line[i] !== ':') i += 1;
          values.push(line.slice(vs, i));
        }
        if (line[i] === ',') {
          i += 1;
          continue;
        }
        break;
      }
    }
    if (pname.length > 0) params.set(pname, values);
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
};

const param = (prop: Prop, name: string): string | undefined => prop.params.get(name)?.[0];

/** One unfolded content line, read as this reader reads it: a quoted
 *  parameter value may hold `:`, `;` and `,`, and comes back unquoted. */
export interface IcsContentLine {
  /** Upper-cased. */
  readonly name: string;
  /** Parameter names upper-cased; values as written, unquoted. */
  readonly params: ReadonlyMap<string, readonly string[]>;
  readonly value: string;
}

/** Read one UNFOLDED content line, or `null` when it is not one. For a
 *  reader that keeps the file's own lines to write them back (the CalDAV
 *  adapter edits an event in place rather than rebuilding it). */
export const parseIcsLine = (line: string): IcsContentLine | null => parseLine(line);

/** The component tree. A property belongs to the component it is written in,
 *  so a reminder's (`VALARM`) `DESCRIPTION` and `ATTENDEE` stay the
 *  reminder's. */
const parseComponents = (text: string, problems: string[]): Component[] => {
  const roots: Component[] = [];
  const stack: Component[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (raw.trim().length === 0) continue;
    const prop = parseLine(raw);
    if (prop === null) continue;
    if (prop.name === 'BEGIN') {
      const component: Component = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(component);
      else roots.push(component);
      stack.push(component);
      continue;
    }
    if (prop.name === 'END') {
      const name = prop.value.trim().toUpperCase();
      // Close back to the matching BEGIN; an END that opened nothing is dropped.
      const at = stack.map((c) => c.name).lastIndexOf(name);
      if (at < 0) continue;
      if (at !== stack.length - 1) addProblem(problems, `"${stack[stack.length - 1]!.name}" was never closed`);
      stack.length = at;
      continue;
    }
    stack[stack.length - 1]?.props.push(prop);
  }
  if (stack.length > 0) addProblem(problems, `"${stack[stack.length - 1]!.name}" was never closed`);
  return roots;
};

const first = (c: Component, name: string): Prop | undefined => c.props.find((p) => p.name === name);

const addProblem = (problems: string[], problem: string): void => {
  if (problems.length < ICS_MAX_PROBLEMS && !problems.includes(problem)) problems.push(problem);
};

/** RFC 5545 §3.3.11 TEXT: `\n` `\N` are a line break; `\,` `\;` `\\` stand
 *  for themselves. */
const unescapeText = (s: string): string => {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      const d = s[i + 1]!;
      if (d === 'n' || d === 'N') {
        out += '\n';
        i += 1;
        continue;
      }
      if (d === ',' || d === ';' || d === '\\') {
        out += d;
        i += 1;
        continue;
      }
    }
    out += c;
  }
  return out;
};

/** A TEXT value's escapes undone (RFC 5545 §3.3.11). */
export const unescapeIcsText = (s: string): string => unescapeText(s);

const text = (prop: Prop | undefined, max: number): { value: string | null; truncated: boolean } => {
  if (prop === undefined) return { value: null, truncated: false };
  const value = unescapeText(prop.value).trim();
  if (value.length === 0) return { value: null, truncated: false };
  return value.length > max ? { value: value.slice(0, max), truncated: true } : { value, truncated: false };
};

// ────────────────────────────────────────────────────────────────
// Date and time values
// ────────────────────────────────────────────────────────────────

/** A wall clock as naive-UTC ms: the digits read as if they were UTC. */
type Wall = number;

const DAY_MS = 86_400_000;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/i;

interface RawTime {
  readonly wall: Wall;
  readonly dateOnly: boolean;
  readonly utc: boolean;
}

const readRawTime = (value: string, valueParam: string | undefined): RawTime | null => {
  const m = DATE_TIME_RE.exec(value.trim());
  if (m === null) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const dateOnly = hh === undefined || valueParam?.toUpperCase() === 'DATE';
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), dateOnly ? 0 : Number(hh), dateOnly ? 0 : Number(mi), dateOnly ? 0 : Number(ss ?? '0'));
  if (!Number.isFinite(wall)) return null;
  // `Date.UTC` rolls 31 February into March; a value that rolled is no date.
  const check = new Date(wall);
  if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null;
  return { wall, dateOnly, utc: !dateOnly && z !== undefined };
};

/** A DATE or DATE-TIME value's digits, as a wall clock: the digits read as if
 *  they were UTC (`20261017T100000` → `Date.UTC(2026, 9, 17, 10)`). `utc`
 *  says the value ended in `Z`; `dateOnly` that it is a day. `null` for a
 *  value that is not a date. */
export const readIcsDateTime = (
  value: string,
  valueParam?: string,
): { readonly wall: number; readonly dateOnly: boolean; readonly utc: boolean } | null => readRawTime(value, valueParam);

const isoDate = (wall: Wall): string => new Date(wall).toISOString().slice(0, 10);
const isoWall = (wall: Wall): string => new Date(wall).toISOString().slice(0, 19);

const OFFSET_RE = /^([+-])(\d{2})(\d{2})(\d{2})?$/;

const readOffset = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const m = OFFSET_RE.exec(value.trim());
  if (m === null) return null;
  const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? '0')) * 1000;
  return m[1] === '-' ? -ms : ms;
};

/** An IANA name `Intl` knows — or, for an old Thunderbird TZID such as
 *  `/mozilla.org/20050126_1/America/New_York`, the name inside it. */
const ianaZone = (tzid: string): string | null => {
  const tries = [tzid];
  const slash = tzid.split('/').filter((s) => s.length > 0);
  if (tzid.startsWith('/') && slash.length >= 2) tries.push(slash.slice(-2).join('/'), slash.slice(-3).join('/'));
  for (const zone of tries) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return zone;
    } catch {
      // not a zone this platform knows
    }
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// VTIMEZONE — a zone's own rules
// ────────────────────────────────────────────────────────────────

const WEEKDAYS: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const BYDAY_RE = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;
/** No zone rule needs more than this many years walked: a bound on a
 *  `COUNT` that starts in 1601. */
const MAX_RULE_YEARS = 1000;

interface YearlyRule {
  readonly interval: number;
  readonly months: readonly number[] | null;
  readonly byday: ReadonlyArray<{ readonly n: number | null; readonly wd: number }> | null;
  readonly monthdays: readonly number[] | null;
  readonly untilUtc: number | null;
  readonly untilWall: Wall | null;
  readonly count: number | null;
}

interface Observance {
  readonly start: Wall;
  readonly offsetFrom: number;
  readonly offsetTo: number;
  readonly rule: YearlyRule | null;
  readonly rdates: readonly Wall[];
}

interface Onset {
  readonly utc: number;
  readonly offsetFrom: number;
  readonly offsetTo: number;
}

/** A zone rule this reader can walk: yearly, by month and by the nth weekday
 *  or by day of month — every rule a mail client writes. Anything else is
 *  `null`, and the zone falls back to its IANA name if it has one. */
const readYearlyRule = (value: string): YearlyRule | null => {
  const parts = new Map<string, string>();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    parts.set(part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim().toUpperCase());
  }
  if (parts.get('FREQ') !== 'YEARLY') return null;
  for (const key of parts.keys()) {
    if (!['FREQ', 'INTERVAL', 'BYMONTH', 'BYDAY', 'BYMONTHDAY', 'UNTIL', 'COUNT', 'WKST'].includes(key)) return null;
  }
  const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;
  let months: number[] | null = null;
  if (parts.has('BYMONTH')) {
    months = parts.get('BYMONTH')!.split(',').map(Number);
    if (months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) return null;
  }
  let byday: Array<{ n: number | null; wd: number }> | null = null;
  if (parts.has('BYDAY')) {
    byday = [];
    for (const item of parts.get('BYDAY')!.split(',')) {
      const m = BYDAY_RE.exec(item);
      if (m === null) return null;
      const n = m[1] === undefined ? null : Number(m[1]);
      if (n !== null && (n === 0 || Math.abs(n) > 5)) return null;
      byday.push({ n, wd: WEEKDAYS[m[2]!]! });
    }
  }
  let monthdays: number[] | null = null;
  if (parts.has('BYMONTHDAY')) {
    monthdays = parts.get('BYMONTHDAY')!.split(',').map(Number);
    if (monthdays.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) return null;
  }
  // A plain weekday names a day only together with the days of the month it
  // narrows ("the Sunday among the 8th–14th"); alone it is every such weekday.
  if (byday !== null && byday.some((b) => b.n === null) && monthdays === null) return null;
  let untilUtc: number | null = null;
  let untilWall: Wall | null = null;
  if (parts.has('UNTIL')) {
    const until = readRawTime(parts.get('UNTIL')!, undefined);
    if (until === null) return null;
    if (until.utc) untilUtc = until.wall;
    else untilWall = until.dateOnly ? until.wall + DAY_MS - 1000 : until.wall;
  }
  let count: number | null = null;
  if (parts.has('COUNT')) {
    count = Number(parts.get('COUNT'));
    if (!Number.isInteger(count) || count < 1) return null;
  }
  return { interval, months, byday, monthdays, untilUtc, untilWall, count };
};

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

const nthWeekday = (y: number, m: number, n: number, wd: number): number | null => {
  const last = daysInMonth(y, m);
  if (n > 0) {
    const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const day = 1 + ((wd - firstWd + 7) % 7) + (n - 1) * 7;
    return day <= last ? day : null;
  }
  const lastWd = new Date(Date.UTC(y, m - 1, last)).getUTCDay();
  const day = last - ((lastWd - wd + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? day : null;
};

/** The wall clocks a rule names in one year, in order. */
const ruleWallsInYear = (o: Observance, rule: YearlyRule, y: number): Wall[] => {
  const start = new Date(o.start);
  const time = o.start - Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const walls: Wall[] = [];
  for (const m of rule.months ?? [start.getUTCMonth() + 1]) {
    const days = new Set<number>();
    if (rule.byday !== null) {
      for (const b of rule.byday) {
        if (b.n !== null) {
          const day = nthWeekday(y, m, b.n, b.wd);
          if (day !== null) days.add(day);
        } else {
          for (const d of rule.monthdays ?? []) {
            if (d <= daysInMonth(y, m) && new Date(Date.UTC(y, m - 1, d)).getUTCDay() === b.wd) days.add(d);
          }
        }
      }
    } else if (rule.monthdays !== null) {
      for (const d of rule.monthdays) if (d <= daysInMonth(y, m)) days.add(d);
    } else if (start.getUTCDate() <= daysInMonth(y, m)) {
      days.add(start.getUTCDate());
    }
    for (const d of days) walls.push(Date.UTC(y, m - 1, d) + time);
  }
  return walls.sort((a, b) => a - b);
};

/** The transitions an observance makes that can bear on `year`: its start,
 *  its listed dates, and its rule's onsets in the years around `year` — or,
 *  for a rule that ended, around its end. */
const observanceOnsets = (o: Observance, year: number): Onset[] => {
  const out: Onset[] = [];
  const push = (wall: Wall): void => {
    out.push({ utc: wall - o.offsetFrom, offsetFrom: o.offsetFrom, offsetTo: o.offsetTo });
  };
  push(o.start);
  for (const wall of o.rdates) push(wall);
  const rule = o.rule;
  if (rule === null) return out;
  const startYear = new Date(o.start).getUTCFullYear();
  let lastYear = year + 1;
  if (rule.untilUtc !== null) lastYear = Math.min(lastYear, new Date(rule.untilUtc).getUTCFullYear() + 1);
  if (rule.untilWall !== null) lastYear = Math.min(lastYear, new Date(rule.untilWall).getUTCFullYear());
  // A COUNT is counted from the start, so it is walked from there.
  const firstYear = rule.count !== null ? startYear : Math.max(startYear, lastYear - 3);
  let seen = 0;
  for (let y = firstYear; y <= lastYear && y - firstYear <= MAX_RULE_YEARS; y += 1) {
    if ((y - startYear) % rule.interval !== 0) continue;
    for (const wall of ruleWallsInYear(o, rule, y)) {
      if (wall < o.start) continue;
      if (rule.untilUtc !== null && wall - o.offsetFrom > rule.untilUtc) continue;
      if (rule.untilWall !== null && wall > rule.untilWall) continue;
      if (rule.count !== null) {
        if (seen >= rule.count) return out;
        seen += 1;
      }
      push(wall);
    }
  }
  return out;
};

interface ZoneRules {
  readonly observances: readonly Observance[];
}

const readZoneRules = (vtimezone: Component): ZoneRules | null => {
  const observances: Observance[] = [];
  for (const child of vtimezone.children) {
    if (child.name !== 'STANDARD' && child.name !== 'DAYLIGHT') continue;
    const dtstart = first(child, 'DTSTART');
    const start = dtstart ? readRawTime(dtstart.value, param(dtstart, 'VALUE')) : null;
    const offsetFrom = readOffset(first(child, 'TZOFFSETFROM')?.value);
    const offsetTo = readOffset(first(child, 'TZOFFSETTO')?.value);
    if (start === null || offsetFrom === null || offsetTo === null) return null;
    let rule: YearlyRule | null = null;
    const rrule = first(child, 'RRULE');
    if (rrule !== undefined) {
      rule = readYearlyRule(rrule.value);
      if (rule === null) return null;
    }
    const rdates: Wall[] = [];
    for (const rdate of child.props.filter((p) => p.name === 'RDATE')) {
      for (const item of rdate.value.split(',')) {
        // A PERIOD (`start/end`) begins at its start.
        const at = readRawTime(item.split('/')[0] ?? '', param(rdate, 'VALUE'));
        if (at === null) return null;
        rdates.push(at.wall);
      }
    }
    observances.push({ start: start.wall, offsetFrom, offsetTo, rule, rdates });
  }
  return observances.length > 0 ? { observances } : null;
};

const offsetAtUtc = (zone: ZoneRules, utc: number): number => {
  const year = new Date(utc).getUTCFullYear();
  let best: Onset | null = null;
  let earliest: Onset | null = null;
  for (const o of zone.observances) {
    for (const onset of observanceOnsets(o, year)) {
      if (onset.utc <= utc && (best === null || onset.utc > best.utc)) best = onset;
      if (earliest === null || onset.utc < earliest.utc) earliest = onset;
    }
  }
  if (best !== null) return best.offsetTo;
  // Before the zone's first listed transition it keeps the offset it had.
  return earliest?.offsetFrom ?? 0;
};

/** A wall clock in a zone given by its rules → epoch ms. Two passes, as
 *  `zonedWallClockToEpochMs` does for IANA zones: the offset depends on the
 *  instant being solved for, and the two passes differ only at a change of
 *  clocks. */
const zoneRulesWallToUtc = (zone: ZoneRules, wall: Wall): number => {
  const firstOffset = offsetAtUtc(zone, wall);
  const guess = wall - firstOffset;
  const secondOffset = offsetAtUtc(zone, guess);
  return firstOffset === secondOffset ? guess : wall - secondOffset;
};

// ────────────────────────────────────────────────────────────────
// Resolving an event's times
// ────────────────────────────────────────────────────────────────

interface CalendarContext {
  readonly zones: ReadonlyMap<string, ZoneRules | null>;
  /** The zone a floating time is read in, and whether it was the calendar's. */
  readonly floatingZone: string | null;
  readonly ownerZone: string | null;
}

/** How one zone turns a wall clock into an instant, and back. */
type ZoneReader =
  | {
    readonly basis: 'utc' | 'zone' | 'floating';
    readonly name: string;
    readonly toUtc: (wall: Wall) => number | null;
    readonly toWall: (utc: number) => Wall | null;
  }
  | { readonly basis: 'unresolved'; readonly name: string };

const UTC_READER: ZoneReader = { basis: 'utc', name: 'UTC', toUtc: (wall) => wall, toWall: (utc) => utc };

/** The wall clock an instant shows in an IANA zone. */
const ianaWall = (zone: string) => (utc: number): Wall | null => {
  try {
    const offset = zoneOffsetMsAt(utc, zone);
    return Number.isFinite(offset) ? utc + offset : null;
  } catch {
    return null;
  }
};

const zoneFor = (utc: boolean, tzid: string | undefined, ctx: CalendarContext): ZoneReader => {
  if (utc) return UTC_READER;
  if (tzid !== undefined && tzid.trim().length > 0) {
    const name = tzid.trim();
    const rules = ctx.zones.get(name);
    if (rules) {
      return {
        basis: 'zone',
        name,
        toUtc: (wall) => zoneRulesWallToUtc(rules, wall),
        toWall: (instant) => instant + offsetAtUtc(rules, instant),
      };
    }
    const iana = ianaZone(name);
    if (iana !== null) {
      return { basis: 'zone', name, toUtc: (wall) => zonedWallClockToEpochMs(isoWall(wall), iana), toWall: ianaWall(iana) };
    }
    return { basis: 'unresolved', name };
  }
  const floating = ctx.floatingZone;
  if (floating !== null) {
    return { basis: 'floating', name: floating, toUtc: (wall) => zonedWallClockToEpochMs(isoWall(wall), floating), toWall: ianaWall(floating) };
  }
  return { basis: 'floating', name: 'UTC', toUtc: (wall) => wall, toWall: (instant) => instant };
};

const zoneReader = (raw: RawTime, tzid: string | undefined, ctx: CalendarContext): ZoneReader => zoneFor(raw.utc, tzid, ctx);

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

/** A DURATION's nominal days (added to the calendar date, so a day across a
 *  change of clocks stays a day) and its exact seconds. */
const readDuration = (value: string): { days: number; ms: number } | null => {
  const m = DURATION_RE.exec(value.trim());
  if (m === null || value.trim().toUpperCase().endsWith('T') || value.trim().toUpperCase() === 'P') return null;
  const sign = m[1] === '-' ? -1 : 1;
  const days = (Number(m[2] ?? '0') * 7 + Number(m[3] ?? '0')) * sign;
  const ms = ((Number(m[4] ?? '0') * 60 + Number(m[5] ?? '0')) * 60 + Number(m[6] ?? '0')) * 1000 * sign;
  return { days, ms };
};

/** A DURATION as nominal days (added on the calendar, so a day across a
 *  change of clocks stays a day) and exact milliseconds. `null` when it is not
 *  one. */
export const readIcsDuration = (value: string): { readonly days: number; readonly ms: number } | null => readDuration(value);

const dayMidnight = (date: string, zone: string | null): number =>
  (zone !== null ? zonedWallClockToEpochMs(date, zone) : null) ?? Date.parse(`${date}T00:00:00Z`);

/** "Thu 15 Oct 2026" — a calendar day, read as written (no zone moves it).
 *  Made on first use, not at import: this module is bundled wherever the
 *  transforms are, Edge functions included. */
let dayFormats: { withYear: Intl.DateTimeFormat; noYear: Intl.DateTimeFormat } | null = null;
const formats = (): { withYear: Intl.DateTimeFormat; noYear: Intl.DateTimeFormat } => {
  dayFormats ??= {
    withYear: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
    noYear: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
  };
  return dayFormats;
};
const dayText = (wall: Wall): string => formats().withYear.format(new Date(wall)).replace(',', '');
const dayTextNoYear = (wall: Wall): string => formats().noYear.format(new Date(wall)).replace(',', '');

/** An all-day event's days: its first, and the day before its exclusive end. */
const describeDays = (startWall: Wall, endWall: Wall): string => {
  const last = endWall - DAY_MS;
  if (last <= startWall) return dayText(startWall);
  const sameYear = new Date(startWall).getUTCFullYear() === new Date(last).getUTCFullYear();
  return `${sameYear ? dayTextNoYear(startWall) : dayText(startWall)} – ${dayText(last)}`;
};

/** A timed event in the owner's zone (UTC when unknown). */
const describeTimes = (startMs: number, endMs: number, zone: string | null): string => {
  const timeZone = zone ?? 'UTC';
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone });
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  const startDay = day.format(new Date(startMs)).replace(',', '');
  const startTime = time.format(new Date(startMs));
  if (endMs <= startMs) return `${startDay}, ${startTime}`;
  const endDay = day.format(new Date(endMs)).replace(',', '');
  const endTime = time.format(new Date(endMs));
  return endDay === startDay ? `${startDay}, ${startTime}–${endTime}` : `${startDay}, ${startTime} – ${endDay}, ${endTime}`;
};

interface ResolvedTimes {
  readonly all_day: boolean;
  readonly start: string | null;
  readonly end: string | null;
  readonly start_ms: number | null;
  readonly end_ms: number | null;
  readonly start_date: string | null;
  readonly end_date: string | null;
  readonly time_zone: string | null;
  readonly time_basis: IcsTimeBasis;
  readonly when: string | null;
}

const resolveTimes = (event: Component, ctx: CalendarContext, problems: string[]): ResolvedTimes | null => {
  const dtstart = first(event, 'DTSTART');
  const start = dtstart ? readRawTime(dtstart.value, param(dtstart, 'VALUE')) : null;
  if (dtstart === undefined || start === null) {
    addProblem(problems, 'it has no start time this reader understands');
    return null;
  }
  const dtend = first(event, 'DTEND');
  const durationProp = first(event, 'DURATION');
  const duration = durationProp ? readDuration(durationProp.value) : null;
  if (durationProp !== undefined && duration === null) addProblem(problems, `its duration "${durationProp.value}" was not understood`);

  if (start.dateOnly) {
    let endWall = start.wall + DAY_MS;
    const end = dtend ? readRawTime(dtend.value, param(dtend, 'VALUE')) : null;
    if (end !== null && end.dateOnly) endWall = end.wall;
    else if (end === null && dtend === undefined && duration !== null) endWall = start.wall + duration.days * DAY_MS;
    else if (dtend !== undefined) addProblem(problems, 'its end is not a date though its start is');
    if (endWall <= start.wall) {
      addProblem(problems, 'it ends before it starts');
      endWall = start.wall + DAY_MS;
    }
    const startDate = isoDate(start.wall);
    const endDate = isoDate(endWall);
    const startMs = dayMidnight(startDate, ctx.ownerZone);
    const endMs = dayMidnight(endDate, ctx.ownerZone);
    return {
      all_day: true,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      start_ms: startMs,
      end_ms: endMs,
      start_date: startDate,
      end_date: endDate,
      time_zone: null,
      time_basis: 'date',
      when: describeDays(start.wall, endWall),
    };
  }

  const reader = zoneReader(start, param(dtstart, 'TZID'), ctx);
  if (reader.basis === 'unresolved') {
    addProblem(problems, `its time zone "${reader.name}" is not one this reader knows`);
    return {
      all_day: false, start: null, end: null, start_ms: null, end_ms: null,
      start_date: null, end_date: null, time_zone: reader.name, time_basis: 'unresolved', when: null,
    };
  }
  if (reader.basis === 'floating' && ctx.floatingZone === null) {
    addProblem(problems, 'its time names no zone, and was read in UTC');
  }
  const startMs = reader.toUtc(start.wall);
  if (startMs === null) {
    addProblem(problems, `its start could not be read in "${reader.name}"`);
    return null;
  }
  let endMs = startMs;
  const end = dtend ? readRawTime(dtend.value, param(dtend, 'VALUE')) : null;
  if (dtend !== undefined) {
    if (end === null || end.dateOnly) {
      addProblem(problems, 'its end was not understood');
    } else {
      const endReader = zoneReader(end, param(dtend, 'TZID'), ctx);
      const read = endReader.basis === 'unresolved' ? null : endReader.toUtc(end.wall);
      if (read === null) addProblem(problems, 'its end was not understood');
      else endMs = read;
    }
  } else if (duration !== null) {
    // Days on the calendar, then the exact time, in the start's own zone.
    const dayShifted = duration.days === 0 ? startMs : reader.toUtc(start.wall + duration.days * DAY_MS);
    endMs = (dayShifted ?? startMs + duration.days * DAY_MS) + duration.ms;
  }
  if (endMs < startMs) {
    addProblem(problems, 'it ends before it starts');
    endMs = startMs;
  }
  return {
    all_day: false,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    start_ms: startMs,
    end_ms: endMs,
    start_date: null,
    end_date: null,
    time_zone: reader.name,
    time_basis: reader.basis,
    when: describeTimes(startMs, endMs, ctx.ownerZone),
  };
};

/** The occurrence a `RECURRENCE-ID` names, as an ISO instant or a day. */
const recurrenceId = (event: Component, ctx: CalendarContext): string | null => {
  const prop = first(event, 'RECURRENCE-ID');
  if (prop === undefined) return null;
  const raw = readRawTime(prop.value, param(prop, 'VALUE'));
  if (raw === null) return prop.value.trim();
  if (raw.dateOnly) return isoDate(raw.wall);
  const reader = zoneReader(raw, param(prop, 'TZID'), ctx);
  const ms = reader.basis === 'unresolved' ? null : reader.toUtc(raw.wall);
  return ms === null ? isoWall(raw.wall) : new Date(ms).toISOString();
};

// ────────────────────────────────────────────────────────────────
// People
// ────────────────────────────────────────────────────────────────

const emailOf = (value: string): string | null => {
  const trimmed = value.trim();
  const at = trimmed.toLowerCase().indexOf('mailto:');
  const email = (at >= 0 ? trimmed.slice(at + 'mailto:'.length) : trimmed).trim().toLowerCase();
  return email.includes('@') && !/\s/.test(email) ? email : null;
};

const personOf = (prop: Prop): IcsPerson | null => {
  const email = emailOf(prop.value);
  if (email === null) return null;
  const cn = param(prop, 'CN')?.trim();
  return { email, name: cn !== undefined && cn.length > 0 ? cn : null };
};

const PARTSTAT: Readonly<Record<string, IcsPartstat>> = {
  'NEEDS-ACTION': 'needs_action',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
  DELEGATED: 'delegated',
};
const ROLE: Readonly<Record<string, IcsRole>> = {
  CHAIR: 'chair',
  'REQ-PARTICIPANT': 'required',
  'OPT-PARTICIPANT': 'optional',
  'NON-PARTICIPANT': 'non_participant',
};
const CUTYPE: Readonly<Record<string, IcsAttendeeKind>> = {
  INDIVIDUAL: 'person',
  GROUP: 'group',
  RESOURCE: 'resource',
  ROOM: 'room',
};

const attendeeOf = (prop: Prop): IcsAttendee | null => {
  const person = personOf(prop);
  if (person === null) return null;
  return {
    ...person,
    // RFC 5545 §3.2.12: an unstated answer is NEEDS-ACTION.
    status: PARTSTAT[(param(prop, 'PARTSTAT') ?? '').toUpperCase()] ?? 'needs_action',
    role: ROLE[(param(prop, 'ROLE') ?? '').toUpperCase()] ?? 'required',
    rsvp: (param(prop, 'RSVP') ?? '').toUpperCase() === 'TRUE',
    kind: CUTYPE[(param(prop, 'CUTYPE') ?? '').toUpperCase()] ?? 'person',
  };
};

const youIn = (organizer: IcsPerson | null, attendees: readonly IcsAttendee[], mine: ReadonlySet<string>): IcsYou => {
  const asGuest = attendees.find((a) => mine.has(a.email));
  if (organizer !== null && mine.has(organizer.email)) {
    return { role: 'organizer', email: organizer.email, status: asGuest?.status ?? null, rsvp: false };
  }
  if (asGuest !== undefined) return { role: 'attendee', email: asGuest.email, status: asGuest.status, rsvp: asGuest.rsvp };
  return { role: 'none', email: null, status: null, rsvp: false };
};

// ────────────────────────────────────────────────────────────────
// The parse
// ────────────────────────────────────────────────────────────────

const METHODS: Readonly<Record<string, IcsMethod>> = {
  REQUEST: 'request',
  CANCEL: 'cancel',
  REPLY: 'reply',
  PUBLISH: 'publish',
  ADD: 'add',
  REFRESH: 'refresh',
  COUNTER: 'counter',
  DECLINECOUNTER: 'declinecounter',
};

const NOT_ICS: IcsParseResult = {
  ok: false, method: 'none', prodid: null, events: [], event: null, event_count: 0, truncated: false, problems: [],
};

const sizeOf = (input: string | Uint8Array): number =>
  typeof input === 'string' ? new TextEncoder().encode(input).length : input.length;

const readEvent = (
  component: Component,
  ctx: CalendarContext,
  mine: ReadonlySet<string>,
  calendarProblems: string[],
): IcsEvent | null => {
  const uid = first(component, 'UID')?.value.trim() ?? '';
  if (uid.length === 0) {
    addProblem(calendarProblems, 'an event without a UID was left out');
    return null;
  }
  const problems: string[] = [];
  const times = resolveTimes(component, ctx, problems);
  if (times === null) {
    for (const p of problems) addProblem(calendarProblems, `event ${uid}: ${p}`);
    return null;
  }
  const organizerProp = first(component, 'ORGANIZER');
  const organizer = organizerProp ? personOf(organizerProp) : null;
  const all: IcsAttendee[] = [];
  const seen = new Set<string>();
  for (const prop of component.props) {
    if (prop.name !== 'ATTENDEE') continue;
    const attendee = attendeeOf(prop);
    if (attendee === null || seen.has(attendee.email)) continue;
    seen.add(attendee.email);
    all.push(attendee);
  }
  const others = all.filter((a) => (a.kind === 'person' || a.kind === 'group')
    && a.email !== organizer?.email && !mine.has(a.email));
  const sequence = Number.parseInt(first(component, 'SEQUENCE')?.value.trim() ?? '0', 10);
  const status = (first(component, 'STATUS')?.value.trim() ?? '').toUpperCase();
  const description = text(first(component, 'DESCRIPTION'), ICS_MAX_DESCRIPTION);
  const rrule = first(component, 'RRULE')?.value.trim() ?? null;
  const url = first(component, 'URL')?.value.trim() ?? '';
  return {
    uid,
    recurrence_id: recurrenceId(component, ctx),
    sequence: Number.isFinite(sequence) && sequence >= 0 ? sequence : 0,
    status: status === 'CONFIRMED' ? 'confirmed' : status === 'TENTATIVE' ? 'tentative' : status === 'CANCELLED' ? 'cancelled' : null,
    summary: text(first(component, 'SUMMARY'), ICS_MAX_SHORT_TEXT).value,
    location: text(first(component, 'LOCATION'), ICS_MAX_SHORT_TEXT).value,
    description: description.value,
    description_truncated: description.truncated,
    url: url.length > 0 ? url.slice(0, ICS_MAX_SHORT_TEXT) : null,
    ...times,
    recurring: rrule !== null || first(component, 'RDATE') !== undefined,
    rrule: rrule === null ? null : rrule.slice(0, ICS_MAX_SHORT_TEXT),
    organizer,
    attendees: all.slice(0, ICS_MAX_ATTENDEES),
    attendee_count: all.length,
    you: youIn(organizer, all, mine),
    others_count: others.length,
    problems,
  };
};

/** Read an iCalendar object. Never throws: what it cannot read it leaves out
 *  and names in `problems`. */
export const parseIcs = (input: string | Uint8Array, opts: IcsParseOptions = {}): IcsParseResult => {
  if (sizeOf(input) > ICS_MAX_BYTES) {
    return { ...NOT_ICS, problems: [`the file is larger than ${ICS_MAX_BYTES} bytes`] };
  }
  const problems: string[] = [];
  const roots = parseComponents(unfold(input), problems);
  const calendars = roots.filter((c) => c.name === 'VCALENDAR');
  if (calendars.length === 0) return NOT_ICS;

  const ownerZone = opts.timeZone !== undefined ? ianaZone(opts.timeZone) : null;
  const mine = new Set((opts.addresses ?? []).map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0));
  const methods = new Set<IcsMethod>();
  let prodid: string | null = null;
  const events: IcsEvent[] = [];
  let eventCount = 0;
  for (const calendar of calendars) {
    const methodValue = first(calendar, 'METHOD')?.value.trim().toUpperCase();
    methods.add(methodValue === undefined ? 'none' : METHODS[methodValue] ?? 'other');
    prodid ??= first(calendar, 'PRODID')?.value.trim() ?? null;
    const zones = new Map<string, ZoneRules | null>();
    for (const vtimezone of calendar.children.filter((c) => c.name === 'VTIMEZONE')) {
      const tzid = first(vtimezone, 'TZID')?.value.trim();
      if (tzid !== undefined && tzid.length > 0) zones.set(tzid, readZoneRules(vtimezone));
    }
    const wr = first(calendar, 'X-WR-TIMEZONE')?.value.trim();
    const calendarZone = wr !== undefined && wr.length > 0 ? ianaZone(wr) : null;
    const ctx: CalendarContext = { zones, floatingZone: calendarZone ?? ownerZone, ownerZone };
    for (const component of calendar.children) {
      if (component.name !== 'VEVENT') continue;
      eventCount += 1;
      if (events.length >= ICS_MAX_EVENTS) continue;
      const event = readEvent(component, ctx, mine, problems);
      if (event !== null) events.push(event);
    }
  }
  // Two calendars in one file that disagree on what they are say nothing
  // reliable about either.
  const method: IcsMethod = methods.size === 1 ? [...methods][0]! : 'other';
  if (methods.size > 1) addProblem(problems, 'the file holds calendars with different methods');
  return {
    ok: true,
    method,
    prodid,
    events,
    event: events.find((e) => e.recurrence_id === null) ?? events[0] ?? null,
    event_count: eventCount,
    truncated: eventCount > events.length,
    problems,
  };
};

// ────────────────────────────────────────────────────────────────
// The clock, for a reader that writes the file back
// ────────────────────────────────────────────────────────────────

/** How one zone turns a wall clock into an instant and back. A wall clock is
 *  a value's digits read as if they were UTC: `20261017T100000` is
 *  `Date.UTC(2026, 9, 17, 10)`. */
export interface IcsZone {
  /** `utc` for a `Z` time; `zone` for a TZID read by its rules or its IANA
   *  name; `floating` for a time naming no zone; `unresolved` for a TZID
   *  nothing reads, whose conversions are `null`. */
  readonly basis: 'utc' | 'zone' | 'floating' | 'unresolved';
  /** The zone as the file names it (`UTC` for a `Z` time); for a floating
   *  time, the calendar's or the owner's zone it is read in (`UTC` when
   *  neither is known). */
  readonly name: string;
  readonly toUtc: (wall: number) => number | null;
  /** The wall clock an instant shows in this zone. */
  readonly toWall: (utc: number) => number | null;
}

/** The zones one iCalendar object's times are read in, in `parseIcs`'s order:
 *  the object's own `VTIMEZONE` rules, then the IANA name, then — for a time
 *  naming no zone — the calendar's `X-WR-TIMEZONE`, else the owner's zone.
 *
 *  For a reader that keeps the object to write it back (the CalDAV adapter):
 *  `toWall` writes a new instant on the event's own clock, so a time edited
 *  in Recued keeps the zone the event was written in. */
export interface IcsClock {
  /** The zone of a DATE-TIME: UTC when it ends in `Z`, else the one its
   *  `TZID` names, else floating. */
  readonly zone: (tzid: string | undefined, utc: boolean) => IcsZone;
  /** Whether the object carries readable rules for this TZID. */
  readonly hasRules: (tzid: string) => boolean;
}

const UNREADABLE = (): null => null;

export const icsClock = (input: string | Uint8Array, opts: { readonly timeZone?: string } = {}): IcsClock => {
  const roots = parseComponents(unfold(input), []);
  const zones = new Map<string, ZoneRules | null>();
  let calendarZone: string | null = null;
  for (const calendar of roots.filter((c) => c.name === 'VCALENDAR')) {
    for (const vtimezone of calendar.children.filter((c) => c.name === 'VTIMEZONE')) {
      const tzid = first(vtimezone, 'TZID')?.value.trim();
      if (tzid !== undefined && tzid.length > 0 && !zones.has(tzid)) zones.set(tzid, readZoneRules(vtimezone));
    }
    const wr = first(calendar, 'X-WR-TIMEZONE')?.value.trim();
    if (calendarZone === null && wr !== undefined && wr.length > 0) calendarZone = ianaZone(wr);
  }
  const ownerZone = opts.timeZone !== undefined ? ianaZone(opts.timeZone) : null;
  const ctx: CalendarContext = { zones, floatingZone: calendarZone ?? ownerZone, ownerZone };
  return {
    zone: (tzid, utc) => {
      const reader = zoneFor(utc, tzid, ctx);
      return reader.basis === 'unresolved'
        ? { basis: 'unresolved', name: reader.name, toUtc: UNREADABLE, toWall: UNREADABLE }
        : reader;
    },
    hasRules: (tzid) => Boolean(zones.get(tzid.trim())),
  };
};

/** What one invite is, independent of how it was written: its method and,
 *  per event, `UID` + `RECURRENCE-ID` + `SEQUENCE`. Two copies of one invite
 *  in one email — Google sends the invite inline AND as `invite.ics` — have
 *  the same key whatever their line endings and folding; an update has a new
 *  one. `null` for anything that is not an iCalendar object with an event. */
export const icsInviteKey = (input: string | Uint8Array): string | null => {
  if (sizeOf(input) > ICS_MAX_BYTES) return null;
  const roots = parseComponents(unfold(input), []);
  const parts: string[] = [];
  for (const calendar of roots.filter((c) => c.name === 'VCALENDAR')) {
    const method = first(calendar, 'METHOD')?.value.trim().toUpperCase() ?? '';
    for (const event of calendar.children.filter((c) => c.name === 'VEVENT')) {
      const uid = first(event, 'UID')?.value.trim() ?? '';
      const rid = first(event, 'RECURRENCE-ID');
      const ridKey = rid === undefined ? '' : `${param(rid, 'TZID') ?? ''}:${rid.value.trim()}`;
      const sequence = first(event, 'SEQUENCE')?.value.trim() ?? '0';
      parts.push(`${method}|${uid}|${ridKey}|${sequence}`);
    }
  }
  return parts.length > 0 ? parts.sort().join('\n') : null;
};

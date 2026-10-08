/** CalDAV write-back edits the calendar's own file (2026-10-07).
 *
 *  ⛔⛔ A CALDAV EVENT IS EDITED IN PLACE, NEVER REBUILT. The adapter used to
 *  rebuild a whole event from the few fields Recued reads, so every save from
 *  Recued — a rename, a reschedule, an answer to an invite — wrote back an event
 *  with:
 *    - its zone gone and its time moved by the zone's offset (a `TZID` time had
 *      been read as if it were UTC, then written back as UTC);
 *    - its reminders (`VALARM`), its deleted dates (`EXDATE`, so they came
 *      back), its moved or edited occurrences (override `VEVENT`s), its zone's
 *      rules (`VTIMEZONE`) and everything else Recued does not read, dropped.
 *  This module keeps every line as the server sent it and changes only the
 *  lines an edit names.
 *
 *  Also here: the `VTIMEZONE` an event written in a new zone needs, made from
 *  the platform's own zone tables, and the value formats a write uses.
 *
 *  Reading a value — its zone, its date — is `@recued/transforms`' iCalendar
 *  reader, the one invites are read with, so a time the adapter reads and a
 *  time it writes go through the same rules. */

import { parseIcsLine, type IcsContentLine, type IcsZone } from '@recued/transforms';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ────────────────────────────────────────────────────────────────
// The document
// ────────────────────────────────────────────────────────────────

export interface IcsDocLine {
  /** The physical lines as received: the line, then its continuations. */
  readonly raw: readonly string[];
  /** Unfolded. */
  readonly text: string;
  readonly prop: IcsContentLine | null;
}

export interface IcsDocComponent {
  readonly name: string;
  /** Index of its BEGIN line. */
  readonly begin: number;
  /** Index of its END line — the line count when it is never closed. */
  readonly end: number;
  /** Its own property lines, not its children's (a reminder's `DESCRIPTION`
   *  is the reminder's). */
  readonly props: readonly number[];
  readonly children: readonly IcsDocComponent[];
}

export interface IcsDoc {
  readonly lines: readonly IcsDocLine[];
  readonly roots: readonly IcsDocComponent[];
}

interface MutableComponent {
  name: string;
  begin: number;
  end: number;
  props: number[];
  children: MutableComponent[];
}

/** Read an iCalendar object into its lines and components. Never throws; a
 *  line it cannot read is kept, to be written back as it came. */
export const parseIcsDoc = (input: string): IcsDoc => {
  const grouped: string[][] = [];
  for (const physical of input.split(/\r\n|\n|\r/)) {
    if ((physical.startsWith(' ') || physical.startsWith('\t')) && grouped.length > 0) {
      grouped[grouped.length - 1]!.push(physical);
      continue;
    }
    if (physical.trim().length === 0) continue;
    grouped.push([physical]);
  }
  const lines: IcsDocLine[] = grouped.map((raw) => {
    const text = raw[0]! + raw.slice(1).map((r) => r.slice(1)).join('');
    return { raw, text, prop: parseIcsLine(text) };
  });
  const roots: MutableComponent[] = [];
  const stack: MutableComponent[] = [];
  lines.forEach((line, index) => {
    const prop = line.prop;
    if (prop === null) return;
    if (prop.name === 'BEGIN') {
      const component: MutableComponent = { name: prop.value.trim().toUpperCase(), begin: index, end: -1, props: [], children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(component);
      else roots.push(component);
      stack.push(component);
      return;
    }
    if (prop.name === 'END') {
      const name = prop.value.trim().toUpperCase();
      const at = stack.map((c) => c.name).lastIndexOf(name);
      if (at < 0) return;
      // An inner component this END skipped past ends here too.
      for (let k = at; k < stack.length; k += 1) stack[k]!.end = index;
      stack.length = at;
      return;
    }
    stack[stack.length - 1]?.props.push(index);
  });
  for (const unclosed of stack) unclosed.end = lines.length;
  return { lines, roots };
};

/** Every component named `name`, at any depth, in file order. */
export const componentsNamed = (doc: IcsDoc, name: string): IcsDocComponent[] => {
  const out: IcsDocComponent[] = [];
  const walk = (components: readonly IcsDocComponent[]): void => {
    for (const c of components) {
      if (c.name === name) out.push(c);
      walk(c.children);
    }
  };
  walk(doc.roots);
  return out;
};

export interface IcsDocProp {
  readonly index: number;
  readonly prop: IcsContentLine;
}

/** A component's own properties named `name`, in file order. */
export const componentProps = (doc: IcsDoc, component: IcsDocComponent, name: string): IcsDocProp[] => {
  const out: IcsDocProp[] = [];
  for (const index of component.props) {
    const prop = doc.lines[index]!.prop;
    if (prop !== null && prop.name === name) out.push({ index, prop });
  }
  return out;
};

export const firstProp = (doc: IcsDoc, component: IcsDocComponent, name: string): IcsContentLine | undefined =>
  componentProps(doc, component, name)[0]?.prop;

export const propParam = (prop: IcsContentLine, name: string): string | undefined => prop.params.get(name)?.[0];

// ────────────────────────────────────────────────────────────────
// Editing
// ────────────────────────────────────────────────────────────────

export interface IcsEditor {
  readonly doc: IcsDoc;
  /** Write `texts` (unfolded lines) in place of line `index`. */
  readonly replaceLine: (index: number, texts: readonly string[]) => void;
  readonly deleteLine: (index: number) => void;
  /** Write `texts` before line `index`; the line count writes them last. */
  readonly insertBefore: (index: number, texts: readonly string[]) => void;
  /** Remove a component, its children with it. */
  readonly deleteComponent: (component: IcsDocComponent) => void;
  /** The object with the edits applied, as unfolded lines. */
  readonly texts: () => string[];
  /** The object with the edits applied: CRLF lines, the untouched ones
   *  exactly as they came, the new ones folded. */
  readonly render: () => string;
}

export const createIcsEditor = (doc: IcsDoc): IcsEditor => {
  const replaced = new Map<number, readonly string[]>();
  const before = new Map<number, string[]>();
  const walk = (emit: (texts: readonly string[], raw: readonly string[] | null) => void): void => {
    for (let i = 0; i < doc.lines.length; i += 1) {
      const inserted = before.get(i);
      if (inserted) emit(inserted, null);
      const replacement = replaced.get(i);
      if (replacement !== undefined) emit(replacement, null);
      else emit([doc.lines[i]!.text], doc.lines[i]!.raw);
    }
    const tail = before.get(doc.lines.length);
    if (tail) emit(tail, null);
  };
  return {
    doc,
    replaceLine: (index, texts) => {
      replaced.set(index, [...texts]);
    },
    deleteLine: (index) => {
      replaced.set(index, []);
    },
    insertBefore: (index, texts) => {
      const at = Math.min(Math.max(0, index), doc.lines.length);
      const list = before.get(at) ?? [];
      list.push(...texts);
      before.set(at, list);
    },
    deleteComponent: (component) => {
      const last = Math.min(component.end, doc.lines.length - 1);
      for (let i = component.begin; i <= last; i += 1) replaced.set(i, []);
    },
    texts: () => {
      const out: string[] = [];
      walk((texts) => {
        out.push(...texts);
      });
      return out;
    },
    render: () => {
      const out: string[] = [];
      walk((texts, raw) => {
        if (raw !== null) out.push(...raw);
        else for (const t of texts) out.push(...foldIcsLine(t));
      });
      return `${out.join('\r\n')}\r\n`;
    },
  };
};

/** Where a new property of `component` goes: before its first child (a
 *  reminder), else before its END. */
const propertyInsertPoint = (component: IcsDocComponent): number =>
  component.children.length > 0 ? component.children[0]!.begin : component.end;

/** Set a component's property `name` to one line: the first such line is
 *  replaced and any others removed; with none, it is added. `null` removes
 *  every one. */
export const setComponentProperty = (
  editor: IcsEditor,
  component: IcsDocComponent,
  name: string,
  text: string | null,
): void => {
  const existing = componentProps(editor.doc, component, name);
  if (text === null) {
    for (const { index } of existing) editor.deleteLine(index);
    return;
  }
  if (existing.length === 0) {
    editor.insertBefore(propertyInsertPoint(component), [text]);
    return;
  }
  editor.replaceLine(existing[0]!.index, [text]);
  for (const { index } of existing.slice(1)) editor.deleteLine(index);
};

/** Add property lines to a component, keeping the ones it has. */
export const addComponentProperties = (editor: IcsEditor, component: IcsDocComponent, texts: readonly string[]): void => {
  if (texts.length > 0) editor.insertBefore(propertyInsertPoint(component), texts);
};

/** A component's lines with some of its own properties replaced or dropped —
 *  for a new component made from an existing one (an occurrence's override,
 *  the second half of a split series). Its children (reminders) come as they
 *  are. A name in `set` replaces that property where it first stood, or is
 *  added. */
export const cloneComponentLines = (
  doc: IcsDoc,
  component: IcsDocComponent,
  opts: { readonly set?: ReadonlyMap<string, readonly string[]>; readonly drop?: ReadonlySet<string> },
): string[] => {
  const set = opts.set ?? new Map<string, readonly string[]>();
  const drop = opts.drop ?? new Set<string>();
  const written = new Set<string>();
  const out: string[] = [doc.lines[component.begin]!.text];
  for (const index of component.props) {
    const line = doc.lines[index]!;
    const name = line.prop?.name;
    if (name !== undefined && set.has(name)) {
      if (!written.has(name)) out.push(...set.get(name)!);
      written.add(name);
      continue;
    }
    if (name !== undefined && drop.has(name)) continue;
    out.push(line.text);
  }
  for (const [name, texts] of set) if (!written.has(name)) out.push(...texts);
  for (const child of component.children) {
    const last = Math.min(child.end, doc.lines.length - 1);
    for (let i = child.begin; i <= last; i += 1) out.push(doc.lines[i]!.text);
  }
  out.push(`END:${component.name}`);
  return out;
};

// ────────────────────────────────────────────────────────────────
// Values
// ────────────────────────────────────────────────────────────────

/** RFC 5545 §3.3.11 TEXT. */
export const escapeIcsText = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

/** A parameter value, quoted when it holds `:`, `;` or `,` (§3.2). A DQUOTE
 *  cannot appear in one at all, and a line break would end the line. */
export const icsParamValue = (value: string): string => {
  const clean = value.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
  return /[:;,]/.test(clean) ? `"${clean}"` : clean;
};

export type IcsParams = ReadonlyArray<readonly [string, string | readonly string[]]>;

/** One content line, unfolded. */
export const icsLine = (name: string, value: string, params: IcsParams = []): string => {
  const written = params
    .map(([key, v]) => `;${key}=${(typeof v === 'string' ? [v] : v).map(icsParamValue).join(',')}`)
    .join('');
  return `${name}${written}:${value}`;
};

/** Fold a line at 75 octets (§3.1); a continuation's leading space counts.
 *  Never splits a character. */
export const foldIcsLine = (line: string): string[] => {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (octets + size > 75) {
      out.push(current);
      current = ' ';
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out;
};

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `YYYYMMDD` of a wall clock (a day's midnight, read as UTC). */
export const icsDateValue = (wall: number): string => {
  const d = new Date(wall);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

/** `YYYYMMDDTHHMMSS` of a wall clock. */
export const icsDateTimeValue = (wall: number): string => {
  const d = new Date(wall);
  return `${icsDateValue(wall)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

/** How an event writes its times — the form its `DTSTART` was written in, so
 *  a time Recued writes reads the way the event's own app wrote it. */
export type IcsTimeForm =
  /** `VALUE=DATE` — an all-day event; its days are UTC midnights. */
  | { readonly kind: 'date' }
  /** `…Z`. */
  | { readonly kind: 'utc' }
  /** No zone: the wall clock in the zone it is read in. */
  | { readonly kind: 'floating'; readonly zone: IcsZone }
  /** `TZID=…`: the wall clock in that zone. */
  | { readonly kind: 'zoned'; readonly tzid: string; readonly zone: IcsZone };

/** A time property from a wall clock already in the form's zone. */
export const icsTimeLineFromWall = (name: string, wall: number, form: IcsTimeForm): string => {
  switch (form.kind) {
    case 'date':
      return icsLine(name, icsDateValue(wall), [['VALUE', 'DATE']]);
    case 'utc':
      return icsLine(name, `${icsDateTimeValue(wall)}Z`);
    case 'floating':
      return icsLine(name, icsDateTimeValue(wall));
    case 'zoned':
      return icsLine(name, icsDateTimeValue(wall), [['TZID', form.tzid]]);
  }
};

/** The wall clock an instant is written as in a form, `null` when its zone
 *  cannot say (an unreadable zone). A day's wall clock is its UTC midnight. */
export const wallInForm = (at: number, form: IcsTimeForm): number | null =>
  form.kind === 'date' || form.kind === 'utc' ? at : form.zone.toWall(at);

/** The instant a wall clock in a form is. */
export const instantInForm = (wall: number, form: IcsTimeForm): number | null =>
  form.kind === 'date' || form.kind === 'utc' ? wall : form.zone.toUtc(wall);

/** A time property from an instant, `null` when the form's zone cannot write
 *  it. */
export const icsTimeLine = (name: string, at: number, form: IcsTimeForm): string | null => {
  const wall = wallInForm(at, form);
  return wall === null ? null : icsTimeLineFromWall(name, wall, form);
};

// ────────────────────────────────────────────────────────────────
// A zone's rules, from the platform's tables
// ────────────────────────────────────────────────────────────────

/** The zones no rules are needed for: always UTC. */
const UTC_NAMES = new Set(['UTC', 'ETC/UTC', 'GMT', 'ETC/GMT', 'Z', 'ZULU', 'ETC/ZULU', 'UCT', 'ETC/UCT', 'UNIVERSAL', 'ETC/UNIVERSAL']);

export const isUtcZoneName = (zone: string): boolean => UTC_NAMES.has(zone.trim().toUpperCase());

/** An IANA zone's offset at an instant, from one formatter; `null` for a zone
 *  the platform does not know. */
const offsetReaderFor = (zone: string): ((utc: number) => number) | null => {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
  return (utc: number): number => {
    const parts = format.formatToParts(new Date(utc));
    const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
    const hour = read('hour') === 24 ? 0 : read('hour');
    const asIfUtc = Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
    // Whole seconds: the formatter drops the instant's milliseconds.
    return asIfUtc - Math.floor(utc / 1000) * 1000;
  };
};

interface Transition {
  /** The instant the clocks change. */
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** Every change of offset in `[fromUtc, toUtc)`, to the minute. */
const transitionsBetween = (offsetAt: (utc: number) => number, fromUtc: number, toUtc: number): Transition[] => {
  const out: Transition[] = [];
  let t = fromUtc;
  let previous = offsetAt(t);
  while (t < toUtc) {
    const next = Math.min(t + DAY, toUtc);
    const offset = offsetAt(next);
    if (offset !== previous) {
      let lo = t;
      let hi = next;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.max(MINUTE, Math.floor((hi - lo) / (2 * MINUTE)) * MINUTE);
        if (offsetAt(mid) === previous) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: previous, to: offset });
      previous = offset;
    }
    t = next;
  }
  return out;
};

const formatOffset = (ms: number): string => {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / HOUR);
  const m = Math.floor((abs % HOUR) / MINUTE);
  const s = Math.floor((abs % MINUTE) / 1000);
  return `${sign}${pad(h)}${pad(m)}${s > 0 ? pad(s) : ''}`;
};

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The yearly rule a run of clock changes follows — "the second Sunday of
 *  March at 02:00", "the last Sunday of October" — or `null` when they follow
 *  none this can write. */
const yearlyRuleOf = (walls: readonly number[]): string | null => {
  const facts = walls.map((wall) => {
    const d = new Date(wall);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();
    return {
      month: m + 1,
      weekday: d.getUTCDay(),
      nth: Math.ceil(day / 7),
      last: day + 7 > daysInMonth(y, m),
      time: wall - Date.UTC(y, m, day),
    };
  });
  const head = facts[0]!;
  const same = facts.every((f) => f.month === head.month && f.weekday === head.weekday && f.time === head.time);
  if (!same) return null;
  const code = WEEKDAY_CODES[head.weekday]!;
  if (facts.every((f) => f.last)) return `FREQ=YEARLY;BYMONTH=${head.month};BYDAY=-1${code}`;
  if (head.nth <= 4 && facts.every((f) => f.nth === head.nth)) return `FREQ=YEARLY;BYMONTH=${head.month};BYDAY=${head.nth}${code}`;
  return null;
};

/** Years of clock changes read to write a zone's rules: the one before the
 *  event's, so its first changes have a start, through enough after that a
 *  rule seen holding every year is the zone's rule, not a coincidence. */
const RULE_YEARS_BEFORE = 1;
const RULE_YEARS_AFTER = 8;

/** The `VTIMEZONE` for an IANA zone, written from the platform's own tables:
 *  each kind of change of clocks as a yearly rule when every year read follows
 *  it, else as the dates it happened on. `null` for a zone the platform does
 *  not know. A zone that does not change its clocks gets one `STANDARD`.
 *
 *  ⚠ RFC 5545 requires a `VTIMEZONE` for every `TZID` an object uses, and a
 *  CalDAV server may refuse an event without one. */
export const vtimezoneLines = (zone: string, aroundUtc: number): string[] | null => {
  const offsetAt = offsetReaderFor(zone);
  if (offsetAt === null) return null;
  const year = new Date(aroundUtc).getUTCFullYear();
  const from = Date.UTC(year - RULE_YEARS_BEFORE, 0, 1);
  const to = Date.UTC(year + RULE_YEARS_AFTER + 1, 0, 1);
  const transitions = transitionsBetween(offsetAt, from, to);
  const lines = ['BEGIN:VTIMEZONE', icsLine('TZID', zone)];
  if (transitions.length === 0) {
    const offset = formatOffset(offsetAt(aroundUtc));
    lines.push(
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`,
      'END:STANDARD',
      'END:VTIMEZONE',
    );
    return lines;
  }
  // One observance per kind of change (from → to), in the order first seen.
  const kinds = new Map<string, Transition[]>();
  for (const t of transitions) {
    const key = `${t.from}>${t.to}`;
    const list = kinds.get(key) ?? [];
    list.push(t);
    kinds.set(key, list);
  }
  const years = RULE_YEARS_BEFORE + RULE_YEARS_AFTER + 1;
  for (const changes of kinds.values()) {
    const { from: offsetFrom, to: offsetTo } = changes[0]!;
    // An observance's onset is written on the clock in force before it.
    const walls = changes.map((t) => t.at + offsetFrom);
    const rule = changes.length === years ? yearlyRuleOf(walls) : null;
    const name = offsetTo > offsetFrom ? 'DAYLIGHT' : 'STANDARD';
    lines.push(
      `BEGIN:${name}`,
      `DTSTART:${icsDateTimeValue(walls[0]!)}`,
      `TZOFFSETFROM:${formatOffset(offsetFrom)}`,
      `TZOFFSETTO:${formatOffset(offsetTo)}`,
    );
    if (rule !== null) lines.push(`RRULE:${rule}`);
    else if (walls.length > 1) lines.push(`RDATE:${walls.slice(1).map(icsDateTimeValue).join(',')}`);
    lines.push(`END:${name}`);
  }
  lines.push('END:VTIMEZONE');
  return lines;
};

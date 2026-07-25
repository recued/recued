/** D-210 WS3 — resolve an intake submission's fields onto a `calendar` or
 *  `contact` destination.
 *
 *  An intake form's fields are ROLE-AGNOSTIC: nothing in `{ name, type, label }`
 *  says which field is "the start time" or "the guest's name". The scheduling
 *  path never needed this — a booking row already has a typed slot — but an
 *  intake does, so the config carries a mapping and this module applies it.
 *
 *  ## Why the timezone work lives here
 *
 *  A `datetime` field arrives as a WALL CLOCK with no zone (`2026-07-20T19:30`)
 *  — that is what `<input type="datetime-local">` submits, and it is the only
 *  honest thing to collect from a visitor who is reading a form, not reasoning
 *  about offsets. The mapping's `timezone` is the single authority on which zone
 *  that wall clock belongs to.
 *
 *  ⛔ `Date.parse('2026-07-20T19:30')` reads the string in the SERVER's zone.
 *  On a UTC host a 19:30 Paris dinner booking would land at 21:30 Paris — a
 *  confidently wrong time, written to a real calendar, with nothing failing.
 *  `zonedWallClockToEpochMs` below does the offset correction explicitly.
 *
 *  ## What is deliberately NOT here
 *
 *  The contact EMAIL. A contact is keyed on the visitor's email, which is
 *  sealed at submit and must not ride the held payload — it is resolved
 *  server-side at materialize (see `resolveSealedVisitorEmail` on the
 *  projection deps). This module maps only what a visible FIELD can carry.
 *
 *  Spec: `docs/d-210-spec.md`; the config contract is
 *  `IntakeFormCalendarMapping` / `IntakeFormContactMapping`. */

import {
  CALENDAR_MAPPING_INSTANT_FIELD_TYPES,
  type IntakeFormCalendarMapping,
  type IntakeFormConfig,
  type IntakeFormContactMapping,
} from '@recued/contracts';

/** How long a day-scoped event runs when nothing else says. */
const ALL_DAY_MINUTES = 24 * 60;

/** A wall-clock string the mapping accepts: a date (`2026-07-20`) or a local
 *  datetime (`2026-07-20T19:30[:SS]`). A zone suffix is deliberately NOT
 *  accepted — the config's `timezone` is the authority, and a value carrying
 *  its own zone would silently outrank it. */
const WALL_CLOCK_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** The offset (ms) a zone was at for a given instant: `zone_local - utc`.
 *  Derived by asking `Intl` to render the instant IN the zone and reading the
 *  rendered wall clock back as if it were UTC. This is the only way to get an
 *  IANA offset in the platform — there is no `Date` API for it. */
const zoneOffsetMsAt = (epochMs: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const read = (type: string): number => {
    const raw = parts.find((p) => p.type === type)?.value;
    return raw === undefined ? Number.NaN : Number(raw);
  };
  // Some ICU builds render midnight as hour 24 under `hour12: false`.
  const hour = read('hour') === 24 ? 0 : read('hour');
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second'),
  );
  return asIfUtc - epochMs;
};

/** Interpret a zone-less wall clock IN a given IANA zone → epoch ms.
 *  `null` for a malformed string or an unknown zone (`Intl` throws a
 *  `RangeError` on a bad `timeZone`, which must not escape as a 500).
 *
 *  Two passes, because the offset depends on the very instant we are solving
 *  for: the first guess uses the offset at the naive-UTC reading, the second
 *  re-measures at that guess. They differ only across a DST transition, where
 *  the second answer is the correct one. (A wall clock inside a spring-forward
 *  gap does not exist; the correction lands it just after the jump, which is
 *  the same thing every calendar UI does.) */
export const zonedWallClockToEpochMs = (
  wallClock: string,
  timeZone: string,
): number | null => {
  const m = WALL_CLOCK_RE.exec(wallClock.trim());
  if (m === null) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const naiveUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? '0'),
    Number(mi ?? '0'),
    Number(ss ?? '0'),
  );
  if (!Number.isFinite(naiveUtc)) return null;
  try {
    const firstOffset = zoneOffsetMsAt(naiveUtc, timeZone);
    if (!Number.isFinite(firstOffset)) return null;
    const guess = naiveUtc - firstOffset;
    const secondOffset = zoneOffsetMsAt(guess, timeZone);
    if (!Number.isFinite(secondOffset)) return null;
    return firstOffset === secondOffset ? guess : naiveUtc - secondOffset;
  } catch {
    // Unknown IANA zone. The config validator does not verify zone existence
    // (the closed list is the platform's, not ours), so fail here rather than
    // let a `RangeError` surface as a crashed materialize.
    return null;
  }
};

/** The INVERSE of `zonedWallClockToEpochMs`: an instant → the wall clock a
 *  reader in `timeZone` sees, as `YYYY-MM-DDTHH:mm` (exactly what an
 *  `<input type="datetime-local">` takes and submits).
 *
 *  ⚠ It lives HERE, beside its inverse, on purpose. D-210 A.8 3d-2c renders a
 *  held slot into a datetime-local and parses the owner's edit straight back
 *  out, so these two functions form a round trip: if they ever disagree about
 *  which zone a bare wall clock belongs to, an approval silently moves the
 *  booking by the offset — no error, no red, a real appointment at the wrong
 *  hour. Split across two modules that drift is exactly how that happens.
 *
 *  `null` for a non-finite instant or an unknown IANA zone (`Intl` throws a
 *  `RangeError` on a bad `timeZone`, which must not escape as a 500). */
export const epochMsToZonedWallClock = (
  epochMs: number,
  timeZone: string,
): string | null => {
  if (!Number.isFinite(epochMs)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(epochMs));
    const read = (type: string): string | undefined =>
      parts.find((p) => p.type === type)?.value;
    const y = read('year');
    const mo = read('month');
    const d = read('day');
    const mi = read('minute');
    const rawHour = read('hour');
    if (y === undefined || mo === undefined || d === undefined
      || rawHour === undefined || mi === undefined) {
      return null;
    }
    // Some ICU builds render midnight as hour 24 under `hour12: false` —
    // the same correction `zoneOffsetMsAt` above makes. `24:00` is not a
    // value a datetime-local input accepts.
    const hh = rawHour === '24' ? '00' : rawHour.padStart(2, '0');
    return `${y}-${mo}-${d}T${hh}:${mi}`;
  } catch {
    return null;
  }
};

/** What the calendar mapping resolved to — the projection payload's calendar
 *  slots. `duration_minutes` rather than an end instant, deliberately: the
 *  projection computes `end_at = start_at + duration`, so an owner editing the
 *  start at the approval gate shifts the event and keeps its length. */
export interface IntakeCalendarSlots {
  readonly start_at: number;
  readonly duration_minutes: number;
  readonly timezone: string;
  readonly is_all_day: boolean;
}

export type IntakeCalendarMappingFailure =
  | 'start_field_missing'
  | 'start_field_unparseable'
  | 'end_field_missing'
  | 'end_field_unparseable'
  | 'end_not_after_start'
  | 'duration_field_invalid'
  | 'end_spec_missing';

export type IntakeCalendarMappingResult =
  | { readonly ok: true; readonly slots: IntakeCalendarSlots }
  | { readonly ok: false; readonly reason: IntakeCalendarMappingFailure };

const asText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

/** Resolve a submission's fields onto the calendar slots.
 *
 *  Fails (rather than defaulting) on anything it cannot read. A calendar
 *  destination whose start is unreadable must not quietly become an event at
 *  "now" or at the epoch — the caller leaves the row pending / falls back, and
 *  the owner sees an intake that did not materialize instead of a booking on
 *  the wrong day. */
export const resolveIntakeCalendarSlots = (input: {
  readonly mapping: IntakeFormCalendarMapping;
  readonly fields: Record<string, unknown>;
  readonly fieldTypes: ReadonlyMap<string, string>;
}): IntakeCalendarMappingResult => {
  const { mapping, fields, fieldTypes } = input;
  const timezone =
    typeof mapping.timezone === 'string' && mapping.timezone.trim().length > 0
      ? mapping.timezone.trim()
      : 'UTC';

  const startRaw = asText(fields[mapping.start_field]).trim();
  if (startRaw.length === 0) return { ok: false, reason: 'start_field_missing' };
  const startAt = zonedWallClockToEpochMs(startRaw, timezone);
  if (startAt === null) return { ok: false, reason: 'start_field_unparseable' };

  // The START FIELD'S TYPE decides day-scoped vs timed. The form's own shape
  // carries the decision, so there is no separate all-day flag that could
  // disagree with what the visitor was actually asked for.
  const isAllDay = fieldTypes.get(mapping.start_field) === 'date';

  // ── End spec. The config validator guarantees EXACTLY ONE is present, so
  // these are alternatives, not a precedence chain. The final `else` is a
  // fail, not a default: a mapping that reached here naming none was never
  // validated, and inventing a length would be inventing the booking.
  if (mapping.end_field !== undefined) {
    const endRaw = asText(fields[mapping.end_field]).trim();
    if (endRaw.length === 0) return { ok: false, reason: 'end_field_missing' };
    const endAt = zonedWallClockToEpochMs(endRaw, timezone);
    if (endAt === null) return { ok: false, reason: 'end_field_unparseable' };
    // For a day-scoped span the end date is the EXCLUSIVE bound, matching the
    // iCal all-day convention and how a person reads a check-out date: a stay
    // from the 20th to the 23rd is three nights, not four.
    if (endAt <= startAt) return { ok: false, reason: 'end_not_after_start' };
    return {
      ok: true,
      slots: {
        start_at: startAt,
        duration_minutes: Math.round((endAt - startAt) / 60_000),
        timezone,
        is_all_day: isAllDay,
      },
    };
  }

  if (mapping.duration_field !== undefined) {
    // HOURS — the unit a person types into "how long do you need it for?".
    // Minutes would invite a "2" that means two minutes.
    const hours = Number(asText(fields[mapping.duration_field]).trim());
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, reason: 'duration_field_invalid' };
    }
    return {
      ok: true,
      slots: {
        start_at: startAt,
        duration_minutes: Math.round(hours * 60),
        timezone,
        is_all_day: isAllDay,
      },
    };
  }

  if (mapping.default_duration_minutes !== undefined) {
    return {
      ok: true,
      slots: {
        start_at: startAt,
        duration_minutes: mapping.default_duration_minutes,
        timezone,
        is_all_day: isAllDay,
      },
    };
  }

  return { ok: false, reason: 'end_spec_missing' };
};

/** Resolve the contact display name a submission carries, if the mapping names
 *  one. The EMAIL is never resolved here — see the module header. */
export const resolveIntakeContactName = (input: {
  readonly mapping: IntakeFormContactMapping | undefined;
  readonly fields: Record<string, unknown>;
}): string | undefined => {
  const nameField = input.mapping?.contact_name_field;
  if (nameField === undefined) return undefined;
  const name = asText(input.fields[nameField]).trim();
  return name.length > 0 ? name : undefined;
};

/** Visible field name → declared type, for a config. The calendar mapping
 *  reads it to decide day-scoped vs timed. Derived from the config rather than
 *  re-listed so it cannot disagree with what the validator checked. */
export const visibleFieldTypeMap = (
  config: IntakeFormConfig,
): ReadonlyMap<string, string> =>
  new Map(config.form_definition.fields.map((f) => [f.name, f.type] as const));

/** Whether a field type can carry an instant — re-exported from the contract's
 *  closed set so this module never grows its own copy. */
export const isInstantFieldType = (type: string | undefined): boolean =>
  type !== undefined && CALENDAR_MAPPING_INSTANT_FIELD_TYPES.has(type);

/** D-117 — calendar warehouse shared types.
 *
 *  Lives alongside `collections.ts`. The calendar platform is the
 *  fourth warehouse platform after mail / file / webhook — it rides
 *  on the same `collection_instances` table + D-110 capability model,
 *  but its per-event schema has enough hot fields (start/end, status,
 *  ical_uid, is_all_day) and extra bookkeeping (`prior_payload`,
 *  `etag`) that a dedicated table + typed record-shape is cleaner
 *  than retrofitting `CollectionRecord.hot_fields`.
 *
 *  See D-117 — "Warehouse is authoritative for local
 *  operations only" and "Remote always wins — there is no local
 *  divergence to merge" are the two load-bearing invariants these
 *  types encode. Every write to a calendar warehouse row either
 *  reflects a verified provider response or a verified read from the
 *  provider; a recipe write that fails surfaces a typed
 *  `CalendarAdapterError` and leaves the warehouse untouched.
 */

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Server-side RRULE expansion window (before now), in days. */
export const CALENDAR_EXPANSION_PAST_DAYS_DEFAULT = 30;

/** Server-side RRULE expansion window (ahead of now), in days. */
export const CALENDAR_EXPANSION_FUTURE_DAYS_DEFAULT = 90;

/** Default poll cadence — calendars are low-churn; 5 min is plenty. */
export const CALENDAR_POLL_SECONDS_DEFAULT = 300;

/** Default retention window (days) — events drop out of warehouse
 *  after this, independent of the sync cadence. */
export const CALENDAR_RETENTION_DAYS_DEFAULT = 365;

/** Default quota (bytes) per calendar instance. 512 MB matches the
 *  mail-collection default at the D-106 scale. */
export const CALENDAR_QUOTA_BYTES_DEFAULT = 512 * 1024 * 1024;

// ────────────────────────────────────────────────────────────────
// Canonical event shape
// ────────────────────────────────────────────────────────────────

/** Canonical event — adapter-independent. One object per expanded
 *  instance of a series (or per one-off event). Written to the
 *  warehouse after RRULE expansion; recipes never see unexpanded
 *  series rules. */
export interface CanonicalEvent {
  /** Provider-native id for this instance. Stable per (series, time). */
  source_id: string;
  /** iCalendar UID — cross-provider identity across adapters. */
  ical_uid: string;
  /** Which calendar on the account this event lives on.
   *  gcal: calendar id. graph: calendarId. caldav: collection URL hash. */
  calendar_id: string;
  /** Optional display name for the calendar. Populated on initial
   *  sync from adapter-side metadata. */
  calendar_name?: string;

  summary: string;
  /** Body inline if ≤64 KB, else the adapter wrote to CAS and the
   *  description lives as `blob_hash` on the warehouse row. */
  description?: string;
  location?: string;

  /** Unix-ms UTC. */
  start_at: number;
  /** Unix-ms UTC. */
  end_at: number;
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  is_all_day: boolean;

  organizer?: { email: string; display_name?: string };
  attendees?: ReadonlyArray<{
    email: string;
    display_name?: string;
    response_status:
      | 'accepted'
      | 'declined'
      | 'tentative'
      | 'needs_action';
    is_self?: boolean;
  }>;

  status: 'confirmed' | 'cancelled' | 'tentative';

  /** Raw RRULE string, if the event is an instance of a series.
   *  Preserved for inspection; never used by the engine for expansion. */
  recurrence_rule?: string;
  /** Back-reference to the series parent (adapter source_id).
   *  Non-null for instances, null for one-off events. */
  recurring_event_id?: string;

  /** Best-effort conference-call URL. No per-provider normalization. */
  conference_url?: string;

  /** Reminder offsets (minutes before start) as reported by the
   *  adapter. Informational — recued does not enforce these. */
  reminders?: ReadonlyArray<{
    method: 'popup' | 'email';
    minutes: number;
  }>;

  /** Unix-ms UTC (adapter-reported). */
  created_at: number;
  /** Unix-ms UTC (adapter-reported). Identity signal for gcal/graph
   *  cursor diffs. */
  updated_at: number;
}

// ────────────────────────────────────────────────────────────────
// Warehouse record — hot fields
// ────────────────────────────────────────────────────────────────

/** Hot fields on a calendar warehouse row. These populate dedicated
 *  SQLite columns (not `json_extract`) for range + equality queries.
 *  Every field is derivable from `CanonicalEvent` — they are cached
 *  out so common list queries never parse the JSON payload. */
export interface CalendarRecordHotFields {
  calendar_id: string;
  summary: string;
  start_at: number;
  end_at: number;
  status: CanonicalEvent['status'];
  /** Organizer email only — display name stays in the full payload. */
  organizer?: string;
  ical_uid: string;
  location?: string;
  is_all_day: boolean;
  /** Derived: `recurring_event_id != null`. Cached so watcher queries
   *  can filter series vs one-off cheaply. */
  is_recurring: boolean;
}

// ────────────────────────────────────────────────────────────────
// Capability model (D-110 parity)
// ────────────────────────────────────────────────────────────────

/** Per-instance capability shape — populated at enroll time by the
 *  adapter's `probeCaps()` and cached on the `collection_instances`
 *  row. Read at parseRecipe time so cap mismatches surface as install-
 *  time errors. */
export interface CalendarCollectionCaps {
  /** Always `'yes'` — read-only is the floor for a calendar adapter. */
  read: 'yes';
  /** Whether the adapter can enumerate multiple calendars on the
   *  account. `'no'` for adapters that expose a single calendar
   *  (e.g. a read-only published-feed shim). */
  list_calendars: 'yes' | 'no';
  create_event: 'yes' | 'no';
  update_event: 'yes' | 'no';
  delete_event: 'yes' | 'no';
  /** Respond on behalf of self. CalDAV's support is conditional on
   *  iTIP handling (Fastmail ✅, iCloud ❌, Nextcloud ✅). */
  rsvp: 'yes' | 'no';
  /** Text search style — `'local'` uses the warehouse FTS5, `'remote'`
   *  hits the adapter, `'none'` means the dispatcher must refuse
   *  `calendar-search`. */
  search: 'local' | 'remote' | 'none';
  /** Change detection — `'poll'` is the only mode shipped in D-117.
   *  `'realtime'` (gcal/graph push notifications) is deferred to
   *  D-118 because it needs a publicly reachable server. */
  watch: 'poll' | 'none';
  /** Credential style. `'none'` (D-173 P4.3) is the credential-free
   *  local calendar — no OAuth, no password, warehouse-only. */
  auth: 'none' | 'oauth' | 'basic' | 'app_password';
  /** Whether the adapter emits pre-expanded instances (gcal
   *  `singleEvents=true`, graph `calendarView`) or raw series rules
   *  that the adapter expands locally via `rrule.js` (caldav). */
  recurrence: 'server' | 'client';
}

// ────────────────────────────────────────────────────────────────
// Stat shape (calendar-stat)
// ────────────────────────────────────────────────────────────────

/** `calendar-stat` output — cheap metadata read for a single event.
 *  `exists: false` collapses the provider's `event_not_found` into a
 *  non-error result (file-stat precedent). Other adapter failures
 *  throw typed `CalendarAdapterError`. */
export interface CalendarRecordStat {
  exists: boolean;
  /** Present when `exists: true`. */
  start_at?: number;
  /** Present when `exists: true`. */
  end_at?: number;
  /** Present when `exists: true`. */
  status?: CanonicalEvent['status'];
  /** Present when `exists: true`. Length of the attendees array. */
  attendee_count?: number;
  /** Present when `exists: true`. Unix-ms UTC. */
  last_modified_at?: number;
}

// ────────────────────────────────────────────────────────────────
// Error taxonomy
// ────────────────────────────────────────────────────────────────

/** Adapter-level error codes. Surface at the dispatcher and map to
 *  recipe `fail_on` branches. `io_error` is the "unknown outcome"
 *  variant — the mutation may or may not have landed on the provider
 *  and the warehouse is never written on this code. */
export type CalendarAdapterErrorCode =
  | 'event_not_found'
  | 'calendar_not_found'
  | 'permission_denied'
  | 'quota_exceeded'
  /** CalDAV series edits where the RRULE variant isn't supported by
   *  the provider. Adapter rejects before any network call. */
  | 'rrule_unsupported'
  /** `rsvp` called on an event where the signed-in user is not an
   *  attendee. */
  | 'attendee_not_self'
  | 'auth_expired'
  /** Network / 5xx / timeout / malformed response. Outcome unknown —
   *  may have succeeded on the provider side. Recipes that must
   *  distinguish a verified-failure from an ambiguous one gate on
   *  this code explicitly in `fail_on`. */
  | 'io_error';

/** Thrown from `CalendarProvider` methods and bubbles up to the
 *  dispatcher. The dispatcher maps to a `RecipeError` with one of
 *  the load-bearing codes; see `backend/server/src/collections/
 *  calendar/errors.ts` for the mapping. */
export class CalendarAdapterError extends Error {
  readonly code: CalendarAdapterErrorCode;
  readonly cause?: unknown;
  constructor(
    code: CalendarAdapterErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'CalendarAdapterError';
    this.code = code;
    this.cause = cause;
  }
}

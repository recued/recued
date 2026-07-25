/** D-117 Phase 2 — CalendarProvider interface.
 *
 *  Three concrete implementations land in Phases 3 / 4 / 5:
 *    `gcal`   — Google Calendar (OAuth + `events.list` +
 *               `singleEvents=true` + `syncToken`).
 *    `graph`  — Microsoft Graph (OAuth + `/me/calendarView/delta`).
 *    `caldav` — CalDAV (basic / app-password + `REPORT
 *               calendar-query` + per-resource ETag + local
 *               `rrule.js` expansion).
 *
 *  Each adapter owns its transport + canonicalization but presents
 *  the same narrow surface to the outer `CalendarCollection` (Phase
 *  6) so the dispatcher stays provider-agnostic.
 *
 *  Lifecycle mirrors `MailProvider` (D-106):
 *
 *    `connect()`     — bring the provider online. OAuth refresh,
 *                      CalDAV PROPFIND, etc. Called from
 *                      `CalendarCollection.sync.start()` before the
 *                      initial scan.
 *    `initialScan()` — fetch events inside
 *                      `[now - backfill_days, now + expansion_future_days]`,
 *                      firing `onEvent` per expanded instance. Returning
 *                      `false` from the callback aborts the scan —
 *                      used in tests + budget-aware ingestion.
 *    `startSync()`   — begin continuous delta polling. Returns a
 *                      stop function; `CalendarCollection` calls it
 *                      on drain.
 *    `close()`       — release connections + timers. Idempotent.
 *    `health()`      — current provider state snapshot; surfaces
 *                      via the collection's heartbeat envelope.
 *
 *  Mutation methods (`createEvent`, `updateEvent`, `deleteEvent`,
 *  `rsvpEvent`) are the write-back path for
 *  `calendar-create` / `calendar-update` / `calendar-delete` /
 *  `calendar-rsvp` ingredients. Per D-117's load-bearing rule
 *  "Warehouse never holds a version the provider hasn't
 *  acknowledged", each mutation either returns a canonical event
 *  (verified success — caller writes it into the warehouse) or
 *  throws `CalendarAdapterError` (warehouse untouched, recipe
 *  `fail_on` surfaces the error).
 *
 *  Caps probing (`probeCaps`) runs once at enrollment and returns
 *  the `CalendarCollectionCaps` cached onto the `collection_instances`
 *  row. Re-probing is a rare admin action — the dispatcher reads
 *  cached caps on every call for cheap gate enforcement.
 */

import type {
  CalendarCollectionCaps,
  CanonicalEvent,
} from '@recued/contracts';

/** Calendar adapter kinds. `gcal` / `graph` / `caldav` (D-117) match the
 *  mail launch pattern; `local` (D-173 P4.3) is the credential-free,
 *  warehouse-only calendar — see `local-provider.ts`. */
export type CalendarProviderKind = 'gcal' | 'graph' | 'caldav' | 'local';

/** A canonical event + adapter-side metadata surfaced to the
 *  `CalendarCollection` layer during sync + write-back. The outer
 *  collection decides body-storage split (inline vs CAS) by inspecting
 *  `description_bytes`; the adapter does not touch CAS itself. */
export interface ProviderEventPayload {
  event: CanonicalEvent;
  /** Size of `event.description` in bytes (UTF-8). Zero when the
   *  event has no description. The collection uses this to decide
   *  inline-vs-CAS storage. */
  description_bytes: number;
  /** CalDAV per-resource validator. Null for gcal / graph (their
   *  cursor lives on `collection_instances.config.sync_cursor`). */
  etag?: string;
}

/** One event delivered by the continuous sync loop. */
export interface CalendarSyncEvent {
  kind: 'created' | 'updated' | 'deleted';
  /** Stable identifier within this provider/account. gcal: event id,
   *  graph: message id, caldav: hash of href. The collection hashes
   *  into `record_id`. */
  source_id: string;
  /** Present on `created` / `updated`, omitted on `deleted`. */
  payload?: ProviderEventPayload;
}

export type CalendarSyncCallback = (
  event: CalendarSyncEvent,
) => Promise<void>;

/** Provider lifecycle snapshot. Folded into
 *  `CalendarCollectionHealth` alongside local counters. */
export interface CalendarProviderHealth {
  /** Unix-ms of the last successful poll tick. 0 before first
   *  success. */
  last_successful_sync_at: number;
  /** Rolling error count across the last 24 h. */
  error_count_24h: number;
  /** Depth of the adapter's internal fetch queue. 0 when idle. */
  pending_queue_size: number;
  /** Count of recurring-event series queued for re-expansion after a
   *  master-RRULE change. Bubbles up to
   *  `CalendarCollectionHealth.pending_queue_size` so operators see
   *  adapter back-pressure. */
  pending_series_expansions: number;
}

export interface InitialScanOptions {
  /** How far back to look. Combined with `expansion_past_days` on
   *  the instance row. */
  backfill_days: number;
  /** Forward window for RRULE expansion. Combined with
   *  `expansion_past_days` for the initial window. */
  expansion_future_days: number;
  expansion_past_days: number;
  /** Emits once per expanded instance. Return `false` to abort the
   *  scan (used in tests / budget-aware ingestion). */
  onEvent: (payload: ProviderEventPayload) => Promise<boolean>;
}

/** Recurrence scope for `updateEvent` / `deleteEvent` on series. */
export type CalendarMutationScope =
  | 'this_instance'
  | 'this_and_future'
  | 'series';

/** Payload for `createEvent`. Matches `CanonicalEvent` minus the
 *  provider-assigned identity fields. */
export type CreateEventInput = Omit<
  CanonicalEvent,
  'source_id' | 'ical_uid' | 'created_at' | 'updated_at'
>;

/** Payload for `updateEvent` — a partial patch on the canonical
 *  event, applied by the adapter to the provider. */
export interface UpdateEventInput {
  /** Which calendar on the account the event lives on. Resolved by
   *  the dispatcher from the warehouse row before the adapter call
   *  — adapters need it to build the provider path. */
  calendar_id: string;
  source_id: string;
  patch: Partial<CanonicalEvent>;
  /** Scope for series edits. Default `'this_instance'`. */
  scope?: CalendarMutationScope;
}

export interface DeleteEventInput {
  calendar_id: string;
  source_id: string;
  scope?: CalendarMutationScope;
}

export interface RsvpEventInput {
  calendar_id: string;
  source_id: string;
  response: 'accepted' | 'declined' | 'tentative';
  comment?: string;
  /** Email of the signed-in user, used to locate the self-attendee
   *  entry. gcal + caldav need this; graph's `/me/events/{id}/accept`
   *  endpoint infers self from the token and ignores it. */
  self_email?: string;
}

export interface CalendarProvider {
  readonly kind: CalendarProviderKind;
  readonly slug: string;

  /** Bring the provider online. Throws typed
   *  `CalendarAdapterError('auth_expired' | 'io_error')` on failure
   *  so `CalendarCollection` can stamp the right state. */
  connect(): Promise<void>;
  /** Fetch events inside the configured window, firing `onEvent`
   *  per expanded instance. Implementations stream so large
   *  calendars don't land in RAM. */
  initialScan(opts: InitialScanOptions): Promise<void>;
  /** Begin continuous delta polling. Returns a stop function that
   *  cancels timers. */
  startSync(cb: CalendarSyncCallback): Promise<() => Promise<void>>;
  /** Release connections + timers. Called from
   *  `CalendarCollection.close()` on drain. Idempotent. */
  close(): Promise<void>;
  health(): CalendarProviderHealth;

  // ── Write-back mutations ──────────────────────────────────────────
  //
  // Each returns a ProviderEventPayload on verified success. A failure
  // (any 4xx / 5xx / timeout / malformed response) throws a typed
  // `CalendarAdapterError`. The dispatcher writes to the warehouse
  // only on verified success — the warehouse never holds a version
  // the provider hasn't acknowledged.

  /** Create a new event on the named calendar. Not idempotent —
   *  re-invocation creates duplicates. Authors dedupe via
   *  `shared.*` snapshots of `ical_uid`. */
  createEvent(
    calendar_id: string,
    event: CreateEventInput,
  ): Promise<ProviderEventPayload>;
  /** Patch an event. Idempotent at the provider level — the second
   *  call is a no-op when the state already matches. Throws
   *  `event_not_found` when the source_id is unknown. */
  updateEvent(input: UpdateEventInput): Promise<ProviderEventPayload>;
  /** Remove an event. Idempotent. Throws `event_not_found` on a
   *  stale source_id so the recipe can branch. */
  deleteEvent(input: DeleteEventInput): Promise<void>;
  /** Respond to an invitation on behalf of the signed-in user.
   *  Throws `attendee_not_self` when the user is not an attendee.
   *  CalDAV adapter may throw `permission_denied` when the server
   *  lacks iTIP support. */
  rsvpEvent(input: RsvpEventInput): Promise<ProviderEventPayload>;
}

/** Minimum shape every `probeCaps` implementation must return. The
 *  registry helper validates + normalises this into
 *  `CalendarCollectionCaps` before it hits the DB. */
export type ProbedCalendarCaps = Pick<
  CalendarCollectionCaps,
  | 'read'
  | 'list_calendars'
  | 'create_event'
  | 'update_event'
  | 'delete_event'
  | 'rsvp'
  | 'search'
  | 'watch'
  | 'auth'
  | 'recurrence'
>;

/** D-117 Phase 6 — calendar dispatcher.
 *
 *  Eight kernel ingredients route through this module:
 *
 *    Reads (warehouse-only — adapter never consulted):
 *      calendar-list   → table.list({ start_since, start_until, … }), of
 *                        every calendar when it names none
 *      calendar-get    → table.get(source_id)
 *      calendar-search → table.search({ query, limit })
 *      calendar-stat   → table.stat(source_id)
 *
 *    Writes (verified-then-reflected — adapter must return a
 *    canonical event before the warehouse moves):
 *      calendar-create → provider.createEvent  → applyVerifiedUpsert
 *      calendar-update → provider.updateEvent  → applyVerifiedUpsert
 *      calendar-delete → provider.deleteEvent  → applyVerifiedDelete
 *      calendar-rsvp   → provider.rsvpEvent    → applyVerifiedUpsert
 *
 *  The dispatcher enforces three gates before the adapter call:
 *    1. Instance row exists for `(platform='calendar', slug)`.
 *    2. `auth_state === 'healthy'` (reads tolerate degraded; writes
 *       refuse it).
 *    3. `caps[op] === 'yes'` (or 'local' / 'remote' for search). Read
 *       cap is always 'yes' — we still gate to keep the message
 *       legible if a future probe ever reports 'no'.
 *
 *  `scope='this_and_future'` expansion is **dispatcher-owned** for
 *  gcal + graph: the dispatcher splits into two adapter calls (truncate
 *  master series, then create new series with the patched fields).
 *  CalDAV is **adapter-owned**: it holds the whole series as one ICS
 *  file, so its adapter does the RRULE split locally in a single call
 *  and the dispatcher just forwards `scope='this_and_future'` through.
 *  (gcal/graph still throw `rrule_unsupported` on a `this_and_future`
 *  *delete* — that scope isn't expanded for delete on those two.)
 *
 *  Mutation results map to typed `RpcError` via
 *  `calendarAdapterErrorToRpc`; `io_error` is the "outcome unknown"
 *  variant — we **never** touch the warehouse on it, leaving the next
 *  sync tick to reconcile whatever actually landed on the provider.
 */

import { collectionSourceFreshnessOf, deriveCollectionSourceFreshness, RpcError } from '@recued/contracts';
import type { CollectionSourceFreshness } from '@recued/contracts';
import type {
  CalendarCollectionCaps,
  CalendarRecordHotFields,
  CalendarRecordStat,
  CanonicalEvent,
} from '@recued/contracts';
import type { CollectionInstanceStore } from '../instance-store.js';
import {
  effectiveCaps,
  hasCap,
  type CalendarCapRequirement,
} from './caps.js';
import { CalendarAdapterError } from '@recued/contracts';
import { callCalendarAdapter } from './errors.js';
import type { CalendarCollection } from './calendar-collection.js';
import { calendarListLimit, type CalendarListQuery } from './calendar-table.js';
import type {
  CalendarMutationScope,
  CreateEventInput,
  ProviderEventPayload,
} from './provider.js';

export interface CalendarDispatcherDeps {
  instances: CollectionInstanceStore;
  /** D-236 — injectable clock for the source-freshness verdict. Defaults to
   *  `Date.now`. Mirrors `CollectionHandlerDeps.now`. */
  now?: () => number;
  /** Lookup the live `CalendarCollection` for `(platform='calendar',
   *  slug)`. Returns `undefined` when the adapter isn't started yet
   *  (enroll-in-progress, crash-loop recovery, …). The composition
   *  root in bin.ts (Phase 9) supplies this hook. */
  getCollection: (slug: string) => CalendarCollection | undefined;
}

// ────────────────────────────────────────────────────────────────
// Gate helpers
// ────────────────────────────────────────────────────────────────

const requireRow = (
  deps: CalendarDispatcherDeps,
  slug: string,
): { caps: CalendarCollectionCaps; adapter_type: string } => {
  // Instance store keys on `(platform, slug)` PRIMARY KEY — a slug
  // shared with another platform won't surface here. We get a clean
  // not_found instead of needing a cross-platform disambiguator.
  const row = deps.instances.get('calendar', slug);
  if (!row) {
    throw new RpcError(
      'not_found',
      `CALENDAR_INSTANCE_NOT_FOUND: no calendar instance '${slug}'`,
      404,
    );
  }
  const caps = effectiveCaps(
    row.caps as CalendarCollectionCaps,
    row.auth_state,
  );
  return { caps, adapter_type: row.adapter_type };
};

const requireRead = (
  deps: CalendarDispatcherDeps,
  slug: string,
): { collection: CalendarCollection; caps: CalendarCollectionCaps } => {
  const { caps } = requireRow(deps, slug);
  // Reads tolerate degraded auth — the warehouse holds canonical
  // copies even when the next adapter sync would fail. Distinguish
  // legibly from a missing instance by checking the live collection
  // separately.
  const collection = deps.getCollection(slug);
  if (!collection) {
    throw new RpcError(
      'server_not_reachable',
      `CALENDAR_ADAPTER_UNREACHABLE: instance '${slug}' is not running`,
      503,
    );
  }
  return { collection, caps };
};

const requireWrite = (
  deps: CalendarDispatcherDeps,
  slug: string,
  requirement: CalendarCapRequirement,
): { collection: CalendarCollection; caps: CalendarCollectionCaps } => {
  const { collection, caps } = requireRead(deps, slug);
  if (!hasCap(caps, requirement)) {
    throw new RpcError(
      'forbidden',
      `CALENDAR_CAPABILITY_DENIED: instance '${slug}' lacks '${requirement}'`,
      403,
    );
  }
  return { collection, caps };
};

// ────────────────────────────────────────────────────────────────
// Read handlers
// ────────────────────────────────────────────────────────────────

/** The verdict for a read across several calendars: as current as the least
 *  current of them. A calendar not running counts as never synced. */
const leastCurrent = (
  verdicts: readonly CollectionSourceFreshness[],
  now: number,
): CollectionSourceFreshness => {
  if (verdicts.length === 0) return deriveCollectionSourceFreshness(null, now);
  const neverSynced = verdicts.some((verdict) => verdict.last_success_at === null);
  return {
    last_success_at: neverSynced ? null : Math.min(...verdicts.map((verdict) => verdict.last_success_at!)),
    age_ms: neverSynced ? null : Math.max(...verdicts.map((verdict) => verdict.age_ms!)),
    degraded: verdicts.some((verdict) => verdict.degraded),
    pending: verdicts.reduce((total, verdict) => total + verdict.pending, 0),
    stale: verdicts.some((verdict) => verdict.stale),
  };
};

/** Every calendar's events (2026-10-05), for a list that names no calendar.
 *
 *  Eight shipped recipes defaulted their calendar to `primary` and read it
 *  here, and a server has no calendar by that name unless one was enrolled so:
 *  every run failed on `CALENDAR_INSTANCE_NOT_FOUND`, `today` (pre-installed)
 *  among them. The default calendar is `local`, and an owner may have several.
 *  Rows come in start order, each carrying the calendar it is in
 *  (`collection_slug`, as the cross-instance reads carry it), cut to the same
 *  limit one calendar's read is. An event on two calendars is listed for each. */
const listEveryCalendar = (
  deps: CalendarDispatcherDeps,
  query: CalendarListQuery,
  now: number,
): { records: Array<CalendarRecordHotFields & { collection_slug: string }>; source_freshness: CollectionSourceFreshness } => {
  const slugs = deps.instances.list('calendar').map((row) => row.slug).sort();
  const records: Array<CalendarRecordHotFields & { collection_slug: string }> = [];
  const verdicts: CollectionSourceFreshness[] = [];
  for (const slug of slugs) {
    const collection = deps.getCollection(slug);
    if (collection === undefined) {
      verdicts.push(deriveCollectionSourceFreshness(null, now));
      continue;
    }
    for (const record of collection.table.list(query)) records.push({ ...record, collection_slug: slug });
    verdicts.push(collectionSourceFreshnessOf(collection.health, now));
  }
  // Stable: a tie keeps calendar order, then each calendar's own order.
  records.sort((a, b) => a.start_at - b.start_at);
  return {
    records: records.slice(0, calendarListLimit(query.limit)),
    source_freshness: leastCurrent(verdicts, now),
  };
};

export const handleCalendarList = async (
  deps: CalendarDispatcherDeps,
  input: {
    /** The calendar to read. Empty or absent: every calendar. */
    slug?: string;
    calendar_id?: string;
    since?: number;
    until?: number;
    status?: CanonicalEvent['status'];
    limit?: number;
  },
): Promise<{
  records: Array<CalendarRecordHotFields & { collection_slug?: string }>;
  source_freshness: CollectionSourceFreshness;
}> => {
  const query: CalendarListQuery = {
    ...(input.calendar_id !== undefined ? { calendar_id: input.calendar_id } : {}),
    ...(input.since !== undefined ? { start_since: input.since } : {}),
    ...(input.until !== undefined ? { start_until: input.until } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
  if (input.slug === undefined || input.slug === '') {
    return listEveryCalendar(deps, query, (deps.now ?? Date.now)());
  }
  const { collection } = requireRead(deps, input.slug);
  const records = collection.table.list(query);
  // D-236 — calendar has its OWN kernel ingredients and its own dispatcher, so
  // it does NOT ride the `collection.list` path the mail/file/webhook verdict
  // travels. Its `health()` supplies the same fields (`last_indexed_at` is the
  // max of the local index and the provider's last successful sync;
  // `pending_queue_size` includes pending series expansions), so the verdict is
  // derived identically rather than approximated.
  return {
    records,
    source_freshness: collectionSourceFreshnessOf(collection.health, (deps.now ?? Date.now)()),
  };
};

export const handleCalendarGet = async (
  deps: CalendarDispatcherDeps,
  input: { slug: string; source_id: string },
): Promise<{ record: CanonicalEvent | null; source_freshness: CollectionSourceFreshness }> => {
  const { collection } = requireRead(deps, input.slug);
  const snapshot = collection.table.get(input.source_id);
  return {
    record: snapshot ? snapshot.event : null,
    source_freshness: collectionSourceFreshnessOf(collection.health, (deps.now ?? Date.now)()),
  };
};

export const handleCalendarSearch = async (
  deps: CalendarDispatcherDeps,
  input: { slug: string; query: string; limit?: number },
): Promise<{
  matches: Array<CalendarRecordHotFields & { body?: string; body_truncated?: boolean }>;
  source_freshness: CollectionSourceFreshness;
}> => {
  const { collection, caps } = requireRead(deps, input.slug);
  if (caps.search === 'none') {
    throw new RpcError(
      'forbidden',
      `CALENDAR_CAPABILITY_DENIED: instance '${input.slug}' has no search capability`,
      403,
    );
  }
  const matches = collection.table.search({
    query: input.query,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  return {
    matches: matches.map((m) => ({
      ...m.hot,
      // The event's own description, hydrated from the row — not a window over
      // it. `body_truncated` rides along so a cut body is never read as whole.
      ...(m.body !== undefined ? { body: m.body } : {}),
      ...(m.body_truncated ? { body_truncated: true } : {}),
    })),
    // D-236 — zero matches is an absence, same ambiguity as an empty list.
    source_freshness: collectionSourceFreshnessOf(collection.health, (deps.now ?? Date.now)()),
  };
};

export const handleCalendarStat = async (
  deps: CalendarDispatcherDeps,
  input: { slug: string; source_id: string },
): Promise<CalendarRecordStat> => {
  const { collection } = requireRead(deps, input.slug);
  return collection.table.stat(input.source_id);
};

// ────────────────────────────────────────────────────────────────
// Write handlers — verified-then-reflected
// ────────────────────────────────────────────────────────────────

export const handleCalendarCreate = async (
  deps: CalendarDispatcherDeps,
  input: {
    slug: string;
    calendar_id: string;
    event: CreateEventInput;
  },
): Promise<{ source_id: string; ical_uid: string }> => {
  const { collection } = requireWrite(deps, input.slug, 'create_event');
  const payload = await callCalendarAdapter(input.slug, 'calendar-create', () =>
    collection.provider.createEvent(input.calendar_id, input.event),
  );
  await collection.applyVerifiedUpsert(payload);
  return { source_id: payload.event.source_id, ical_uid: payload.event.ical_uid };
};

/** Patch an event. For `scope='this_and_future'` on gcal/graph the
 *  dispatcher splits into two adapter calls (truncate the master
 *  series + create a new series with the patched fields starting at
 *  the triggering instance). The first call lands; if the second
 *  fails, we surface `io_error` with explicit "master truncated, new
 *  series not created" messaging so the recipe's `fail_on` branch
 *  can decide. CalDAV does the same split locally inside its adapter
 *  (single call) since it holds the ICS — the dispatcher just forwards
 *  the scope through and upserts the returned new-series payload. */
export const handleCalendarUpdate = async (
  deps: CalendarDispatcherDeps,
  input: {
    slug: string;
    source_id: string;
    patch: Partial<CanonicalEvent>;
    scope?: CalendarMutationScope;
  },
): Promise<{ source_id: string }> => {
  const { collection } = requireWrite(deps, input.slug, 'update_event');
  const existing = collection.table.get(input.source_id);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `CALENDAR_EVENT_NOT_FOUND: '${input.source_id}' on instance '${input.slug}'`,
      404,
    );
  }
  const calendar_id = existing.event.calendar_id;
  const scope: CalendarMutationScope = input.scope ?? 'this_instance';

  if (scope === 'this_and_future') {
    // CalDAV holds the whole series as one ICS file, so its adapter
    // owns the split locally (truncate master + new series) in a single
    // call. gcal/graph are REST APIs with no local ICS — the dispatcher
    // splits those into two adapter calls.
    if (collection.provider.kind === 'caldav') {
      const payload = await callCalendarAdapter(
        input.slug,
        'calendar-update[this_and_future]',
        () =>
          collection.provider.updateEvent({
            calendar_id,
            source_id: input.source_id,
            patch: input.patch,
            scope: 'this_and_future',
          }),
      );
      await collection.applyVerifiedUpsert(payload);
      return { source_id: payload.event.source_id };
    }
    return executeThisAndFuture(deps, collection, input, existing.event, calendar_id);
  }

  const payload = await callCalendarAdapter(input.slug, 'calendar-update', () =>
    collection.provider.updateEvent({
      calendar_id,
      source_id: input.source_id,
      patch: input.patch,
      scope,
    }),
  );
  await collection.applyVerifiedUpsert(payload);
  return { source_id: payload.event.source_id };
};

const executeThisAndFuture = async (
  deps: CalendarDispatcherDeps,
  collection: CalendarCollection,
  input: {
    slug: string;
    source_id: string;
    patch: Partial<CanonicalEvent>;
  },
  existing: CanonicalEvent,
  calendar_id: string,
): Promise<{ source_id: string }> => {
  // Step 1 — truncate the master series. The adapter receives the
  // triggering instance's start as the patch boundary; how it builds
  // the UNTIL value lives inside gcal/graph adapters per provider
  // quirks (RFC 5545 vs Graph's own RRULE syntax).
  const masterSourceId =
    existing.recurring_event_id ?? input.source_id;
  const truncatePatch: Partial<CanonicalEvent> = {
    recurrence_rule: encodeUntilBoundary(existing),
  };
  const truncated = await callCalendarAdapter(
    input.slug,
    'calendar-update[truncate-series]',
    () =>
      collection.provider.updateEvent({
        calendar_id,
        source_id: masterSourceId,
        patch: truncatePatch,
        scope: 'series',
      }),
  );
  await collection.applyVerifiedUpsert(truncated);

  // Step 2 — create a fresh event at the triggering instance's
  // start with the requested patch applied. If this fails, the
  // master series is already truncated — surface the unverified
  // outcome explicitly via io_error.
  const newSeriesEvent = mergeCreateBody(existing, input.patch);
  let newSeries: ProviderEventPayload;
  try {
    newSeries = await callCalendarAdapter(
      input.slug,
      'calendar-update[create-new-series]',
      () => collection.provider.createEvent(calendar_id, newSeriesEvent),
    );
  } catch (err) {
    // Already an RpcError from callCalendarAdapter — wrap with the
    // partial-progress note so authors can branch.
    if (err instanceof RpcError) {
      throw new RpcError(
        err.code,
        `${err.message} — NOTE: master series '${masterSourceId}' was truncated successfully but the new series at this_and_future was not created. The next sync tick will reflect provider state.`,
        err.status ?? 502,
      );
    }
    throw err;
  }
  await collection.applyVerifiedUpsert(newSeries);
  return { source_id: newSeries.event.source_id };
};

const encodeUntilBoundary = (event: CanonicalEvent): string => {
  // The adapter handles the actual RRULE rewrite — this stub
  // surfaces the cutoff timestamp as a sentinel that gcal/graph
  // adapters parse + transform into provider-specific RRULE syntax.
  // We pass the triggering instance's start; the adapter rounds back
  // by 1 ms so the master series truly ends BEFORE the new series.
  return `RECUED:UNTIL=${event.start_at}`;
};

const mergeCreateBody = (
  existing: CanonicalEvent,
  patch: Partial<CanonicalEvent>,
): CreateEventInput => {
  // Project the existing event minus identity fields, layer patch
  // on top. `recurrence_rule` keeps the pre-truncation form so the
  // new series picks up the same cadence; the adapter computes the
  // window from the new start.
  return {
    calendar_id: existing.calendar_id,
    summary: patch.summary ?? existing.summary,
    ...(patch.description !== undefined ? { description: patch.description } : existing.description !== undefined ? { description: existing.description } : {}),
    ...(patch.location !== undefined ? { location: patch.location } : existing.location !== undefined ? { location: existing.location } : {}),
    start_at: patch.start_at ?? existing.start_at,
    end_at: patch.end_at ?? existing.end_at,
    timezone: patch.timezone ?? existing.timezone,
    is_all_day: patch.is_all_day ?? existing.is_all_day,
    ...(patch.organizer !== undefined ? { organizer: patch.organizer } : existing.organizer !== undefined ? { organizer: existing.organizer } : {}),
    ...(patch.attendees !== undefined ? { attendees: patch.attendees } : existing.attendees !== undefined ? { attendees: existing.attendees } : {}),
    status: patch.status ?? existing.status,
    ...(patch.recurrence_rule !== undefined ? { recurrence_rule: patch.recurrence_rule } : existing.recurrence_rule !== undefined ? { recurrence_rule: existing.recurrence_rule } : {}),
    ...(patch.conference_url !== undefined ? { conference_url: patch.conference_url } : existing.conference_url !== undefined ? { conference_url: existing.conference_url } : {}),
    ...(patch.reminders !== undefined ? { reminders: patch.reminders } : existing.reminders !== undefined ? { reminders: existing.reminders } : {}),
    ...(patch.calendar_name !== undefined ? { calendar_name: patch.calendar_name } : existing.calendar_name !== undefined ? { calendar_name: existing.calendar_name } : {}),
    ...(patch.recurring_event_id !== undefined ? { recurring_event_id: patch.recurring_event_id } : {}),
  };
};

export const handleCalendarDelete = async (
  deps: CalendarDispatcherDeps,
  input: {
    slug: string;
    source_id: string;
    scope?: CalendarMutationScope;
  },
): Promise<{ deleted: true; source_id: string }> => {
  const { collection } = requireWrite(deps, input.slug, 'delete_event');
  const existing = collection.table.get(input.source_id);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `CALENDAR_EVENT_NOT_FOUND: '${input.source_id}' on instance '${input.slug}'`,
      404,
    );
  }
  const calendar_id = existing.event.calendar_id;
  const scope: CalendarMutationScope = input.scope ?? 'this_instance';

  await callCalendarAdapter(input.slug, 'calendar-delete', () =>
    collection.provider.deleteEvent({
      calendar_id,
      source_id: input.source_id,
      scope,
    }),
  );
  // For `this_and_future` the triggering occurrence + its tail are gone
  // on the provider; we drop the triggering row now and let the next
  // sync tick reconcile the truncated tail (the caldav adapter does the
  // RRULE split locally — gcal/graph still throw rrule_unsupported for
  // this scope on delete, which surfaces above before we reach here).
  collection.applyVerifiedDelete(input.source_id);
  // D-210 step 3 — echo the removed event's id so the engine's D-120
  // write link can key `calendar:<source_id>` after the warehouse row is
  // gone (the manifest's `writes.id_output_field` reads it here). The
  // caller already knows the id it asked to delete; surfacing it costs
  // nothing and keeps delete symmetric with create/update.
  return { deleted: true, source_id: input.source_id };
};

export const handleCalendarRsvp = async (
  deps: CalendarDispatcherDeps,
  input: {
    slug: string;
    source_id: string;
    response: 'accepted' | 'declined' | 'tentative';
    comment?: string;
  },
): Promise<{ source_id: string; response_status: string }> => {
  const { collection } = requireWrite(deps, input.slug, 'rsvp');
  const existing = collection.table.get(input.source_id);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `CALENDAR_EVENT_NOT_FOUND: '${input.source_id}' on instance '${input.slug}'`,
      404,
    );
  }
  const calendar_id = existing.event.calendar_id;
  const selfAttendee = (existing.event.attendees ?? []).find(
    (a) => a.is_self,
  );
  const payload = await callCalendarAdapter(input.slug, 'calendar-rsvp', () =>
    collection.provider.rsvpEvent({
      calendar_id,
      source_id: input.source_id,
      response: input.response,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      ...(selfAttendee?.email ? { self_email: selfAttendee.email } : {}),
    }),
  );
  await collection.applyVerifiedUpsert(payload);
  const updatedSelf =
    payload.event.attendees?.find((a) => a.is_self) ?? selfAttendee;
  return {
    source_id: payload.event.source_id,
    response_status: updatedSelf?.response_status ?? input.response,
  };
};

// Re-export for tests + downstream wiring.
export { CalendarAdapterError };

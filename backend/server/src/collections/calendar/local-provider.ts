/** D-173 P4.3 — the `local` calendar adapter.
 *
 *  A 4th calendar adapter kind (alongside gcal / graph / caldav) whose
 *  events live ONLY in the local `data.calendar` warehouse — there is no
 *  external provider, no OAuth, no network. It exists so a user has a
 *  real calendar to put events on without connecting Google / Outlook /
 *  CalDAV: a "default calendar" is merely a preset (the boot wiring
 *  auto-creates one local instance), not an enrollment with credentials.
 *
 *  Why an adapter and not a bespoke warehouse write: the whole calendar
 *  collection (reads, the warehouse table, the watcher, the dispatcher
 *  gate matrix, the `data.calendar.*` resolver) is keyed on a
 *  `collection_instances` row + a `CalendarProvider`. Modelling the local
 *  calendar as one more provider means it inherits all of that for free —
 *  reads, list, search, the watcher (`starting_soon` / `changed_since`),
 *  and the D-145 Source registry — with the single difference that its
 *  mutations resolve locally instead of over the wire.
 *
 *  How writes land: the dispatcher's write path is
 *  `provider.createEvent(...)  →  collection.applyVerifiedUpsert(payload)`.
 *  For an external provider `createEvent` calls the API (which assigns the
 *  id) and returns the canonical event; the dispatcher then mirrors it
 *  into the warehouse. The local provider has no API, so `createEvent`
 *  simply MINTS the identity fields (`source_id` / `ical_uid` /
 *  `created_at` / `updated_at`) and returns the event — the SAME
 *  `applyVerifiedUpsert` step persists it. So the local provider never
 *  touches the warehouse itself; minting + the existing write path is the
 *  whole story, and read/list/search/watch are unchanged.
 *
 *  ## Slice 2 (2026-07-16) — update + delete
 *
 *  Slice 1 shipped create + read; `update_event` / `delete_event` were declared
 *  `'no'` so the dispatcher 403'd them before they reached the provider. That
 *  left the calendar every reception booking lands on **append-only**: a booking
 *  could never be moved or cancelled, which is most of running a day. The
 *  deferral was stated as "editing local events needs the provider to read the
 *  current warehouse row to merge a patch" — the real blocker, and this slice
 *  resolves it head-on.
 *
 *  **How, without breaking "the provider never touches the warehouse":** it does
 *  now, and that is the honest model. For an external adapter the PROVIDER holds
 *  the truth and the warehouse is a mirror; `updateEvent` posts a patch and the
 *  API merges it. **For the local adapter the warehouse IS the provider** — it
 *  is the only place a local event exists. So merging a patch against the
 *  current row is not a layering violation; it is this adapter doing exactly
 *  what Google's API does for gcal. Slice 1's invariant held only because
 *  minting a fresh event needs no read.
 *
 *  The read arrives as an injected `readEvent` seam (never a table handle) so
 *  the provider stays free of schema knowledge, and the write still goes the
 *  normal way: provider returns the merged canonical event → the dispatcher's
 *  `applyVerifiedUpsert` persists it. **This adapter never writes.**
 *
 *  `rsvp` stays `'no'` — genuinely correct, not a deferral: a local calendar has
 *  no external invitations to respond to.
 *
 *  Series scopes (`this_and_future` / `series`) are refused with
 *  `rrule_unsupported`, matching gcal/graph's own posture. A local event has no
 *  RRULE — recurrence expands pre-warehouse (D-117) and nothing writes a
 *  recurring local event — so a series edit is meaningless here rather than
 *  merely unimplemented.
 *
 *  Spec: D-173 § D7 (amended — scheduling materializes a
 *  local calendar event) + internal design notes;
 *  internal design notes § 3a (BLOCKER-1). */

import { randomUUID } from 'node:crypto';
import { CalendarAdapterError, type CanonicalEvent } from '@recued/contracts';
import type {
  CalendarAdapterContext,
  CalendarAdapterFactory,
} from './adapter-registry.js';
import type {
  CalendarProvider,
  CalendarProviderHealth,
  CalendarSyncCallback,
  CreateEventInput,
  DeleteEventInput,
  InitialScanOptions,
  ProbedCalendarCaps,
  ProviderEventPayload,
  RsvpEventInput,
  UpdateEventInput,
} from './provider.js';

/** The local calendar's capabilities. Create + read only (slice 1):
 *  mutations beyond create are declared `'no'` so the dispatcher gate
 *  rejects them before the provider is reached. `auth: 'none'` — there
 *  are no credentials; `watch: 'none'` — there is nothing external to
 *  poll (a write lands in the warehouse synchronously and the watcher
 *  reads the warehouse, so events are visible immediately). */
/** D-173 P4.3 — the reserved slug of the auto-created default local
 *  calendar instance. The boot wiring (`wire-calendar-stack.ts`)
 *  upserts one `(platform='calendar', slug='local')` row at boot, and
 *  reception scheduling materializes booking events onto it cold-start
 *  (no external calendar / OAuth). Reserved: an enroll attempt on this
 *  slug hits the store's duplicate guard. */
export const DEFAULT_LOCAL_CALENDAR_SLUG = 'local';

/** D-173 P4.3 — the `calendar_id` (calendar-within-account) the default
 *  local instance writes events under. A local calendar has no external
 *  account, so the id is a fixed opaque label — every local event lands
 *  on the one `'local'` calendar of the `'local'` instance. */
export const DEFAULT_LOCAL_CALENDAR_ID = 'local';

export const LOCAL_CALENDAR_CAPS: ProbedCalendarCaps = {
  read: 'yes',
  list_calendars: 'yes',
  create_event: 'yes',
  // Slice 2 (2026-07-16) — a local calendar you cannot edit is append-only, and
  // every reception booking lands here. Moving and cancelling ARE running a day.
  update_event: 'yes',
  delete_event: 'yes',
  // Stays 'no' on the merits, not as a deferral: there are no external
  // invitations on a local calendar to respond to.
  rsvp: 'no',
  search: 'local',
  watch: 'none',
  auth: 'none',
  recurrence: 'client',
};

/** Stable id minted for a locally-created event. UUID — the warehouse
 *  row's primary key is a hash of `(slug, source_id)`, so a fresh UUID is
 *  a fresh row. Callers that need idempotent re-creation (e.g. reception
 *  re-release) pre-check their own resolved-id slot before calling create
 *  — the local adapter does not dedupe (matching every other provider's
 *  non-idempotent `createEvent` contract). */
const mintSourceId = (): string => randomUUID();

const descriptionBytes = (event: { description?: string }): number =>
  event.description ? Buffer.byteLength(event.description, 'utf8') : 0;

export interface LocalCalendarProviderOptions {
  readonly slug: string;
  readonly now: () => number;
  /** Slice 2 — read this instance's current event, or null when unknown.
   *
   *  The merge base for `updateEvent`. For an external adapter the provider's
   *  API holds this state; for `local` the warehouse does, so the adapter must
   *  be handed a way to read it. A narrow read seam (not a table handle) keeps
   *  the provider free of schema knowledge, and it stays READ-only: the merged
   *  event is returned to the dispatcher, which persists it the same way it
   *  persists an external provider's response. This adapter never writes. */
  readonly readEvent: (source_id: string) => CanonicalEvent | null;
  readonly log?: CalendarAdapterContext['log'];
}

/** Series scopes are meaningless on a local calendar — nothing writes a
 *  recurring local event and recurrence expands pre-warehouse (D-117). Refuse
 *  rather than silently treating a series edit as a single-instance one, which
 *  would quietly do less than the caller asked. Mirrors gcal/graph. */
const refuseSeriesScope = (scope: string | undefined, op: string): void => {
  if (scope !== undefined && scope !== 'this_instance') {
    throw new CalendarAdapterError(
      'rrule_unsupported',
      `local calendar does not support ${op} with scope '${scope}' — a local event has no series`,
    );
  }
};

/** Build a `CalendarProvider` whose mutations resolve in-process. The
 *  lifecycle hooks are no-ops: there is no connection to open, no remote
 *  window to scan, and no delta stream to poll. */
export const createLocalCalendarProvider = (
  opts: LocalCalendarProviderOptions,
): CalendarProvider => {
  const { slug, now } = opts;
  return {
    kind: 'local',
    slug,

    // ── Lifecycle (all no-ops — nothing external) ───────────────────
    async connect(): Promise<void> {
      // No connection to establish.
    },
    async initialScan(_opts: InitialScanOptions): Promise<void> {
      // Nothing to backfill — the warehouse IS the source of truth for a
      // local calendar; there is no remote window to expand from.
    },
    async startSync(_cb: CalendarSyncCallback): Promise<() => Promise<void>> {
      // No delta stream. Return a no-op stop function.
      return async (): Promise<void> => {
        // nothing to cancel
      };
    },
    async close(): Promise<void> {
      // No timers / connections.
    },
    health(): CalendarProviderHealth {
      return {
        last_successful_sync_at: now(),
        error_count_24h: 0,
        pending_queue_size: 0,
        pending_series_expansions: 0,
      };
    },

    // ── Write-back mutations ────────────────────────────────────────
    async createEvent(
      calendar_id: string,
      event: CreateEventInput,
    ): Promise<ProviderEventPayload> {
      const ts = now();
      const source_id = mintSourceId();
      const minted: CanonicalEvent = {
        ...(event as Omit<
          CanonicalEvent,
          'source_id' | 'ical_uid' | 'created_at' | 'updated_at'
        >),
        calendar_id,
        source_id,
        // D-315 slice 7 — an invite added here keeps the invite's UID.
        ical_uid: event.ical_uid ?? `${source_id}@local.recued`,
        created_at: ts,
        updated_at: ts,
      };
      return { event: minted, description_bytes: descriptionBytes(minted) };
    },

    /** Slice 2 — merge a patch against the current row and return the merged
     *  event. The dispatcher persists it (`applyVerifiedUpsert`), so the
     *  "verified-then-reflected" shape is identical to an external provider's:
     *  the provider decides the resulting state, the warehouse reflects it. */
    async updateEvent(input: UpdateEventInput): Promise<ProviderEventPayload> {
      refuseSeriesScope(input.scope, 'update_event');
      const current = opts.readEvent(input.source_id);
      if (current === null) {
        // The dispatcher pre-checks existence, so this is a race or a direct
        // adapter call. Typed + fail-closed rather than minting a new event
        // from a bare patch — a "merge" with nothing to merge into would
        // silently create, and an update that invents a row is worse than one
        // that fails.
        throw new CalendarAdapterError(
          'event_not_found',
          `local calendar '${slug}': no event '${input.source_id}' to update`,
        );
      }
      // Identity + provenance are the adapter's to keep, never the caller's to
      // patch: re-keying an event through an "edit" would orphan every
      // reference to it (notably `reception_booking_request
      // .resolved_calendar_event_id`, the I-4 idempotency anchor — a re-release
      // would then mint a duplicate booking). `created_at` is history and does
      // not move. `updated_at` is stamped here because this adapter IS the
      // provider: it is the one deciding the write happened.
      const merged: CanonicalEvent = {
        ...current,
        ...input.patch,
        source_id: current.source_id,
        ical_uid: current.ical_uid,
        calendar_id: current.calendar_id,
        created_at: current.created_at,
        updated_at: now(),
      };
      return { event: merged, description_bytes: descriptionBytes(merged) };
    },

    /** Slice 2 — verify, then let the dispatcher drop the row
     *  (`applyVerifiedDelete`). Nothing to call and nothing to write: the
     *  adapter's only job is to say whether the delete is legitimate. */
    async deleteEvent(input: DeleteEventInput): Promise<void> {
      refuseSeriesScope(input.scope, 'delete_event');
      if (opts.readEvent(input.source_id) === null) {
        throw new CalendarAdapterError(
          'event_not_found',
          `local calendar '${slug}': no event '${input.source_id}' to delete`,
        );
      }
    },

    // Unreachable in normal operation — the dispatcher gates `rsvp` on caps
    // (`'no'`) and 403s first. Typed backstop rather than a silent no-op.
    async rsvpEvent(_input: RsvpEventInput): Promise<ProviderEventPayload> {
      throw new CalendarAdapterError(
        'attendee_not_self',
        `local calendar '${slug}' has no external invitations to RSVP`,
      );
    },
  };
};

/** The adapter factory registered in the calendar stack. `probeCaps`
 *  needs no network — the local caps are static. */
export const createLocalCalendarAdapterFactory = (opts: {
  now: () => number;
  /** Slice 2 — resolve one instance's current event (the `updateEvent` merge
   *  base). Keyed by `(slug, source_id)` because the factory is registered once
   *  at boot, before any instance exists, and `create(ctx)` binds it per-slug.
   *  The composition root owns HOW this reads (see `wire-calendar-stack.ts`);
   *  the adapter only knows it can ask. */
  readEvent: (slug: string, source_id: string) => CanonicalEvent | null;
}): CalendarAdapterFactory => ({
  kind: 'local',
  async probeCaps(_ctx: CalendarAdapterContext): Promise<ProbedCalendarCaps> {
    return LOCAL_CALENDAR_CAPS;
  },
  create(ctx: CalendarAdapterContext): CalendarProvider {
    return createLocalCalendarProvider({
      slug: ctx.slug,
      now: opts.now,
      readEvent: (source_id) => opts.readEvent(ctx.slug, source_id),
      ...(ctx.log !== undefined ? { log: ctx.log } : {}),
    });
  },
});

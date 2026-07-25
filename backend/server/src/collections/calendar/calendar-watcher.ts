/** D-117 Phase 8 — calendar-watcher backend handler.
 *
 *  Two modes from the manifest:
 *
 *    kind: 'starting_soon'
 *      → fire when events start in the next `minutes_ahead` window
 *        (default CALENDAR_STARTING_SOON_DEFAULT_MINUTES).
 *        No cursor — each tick is a fresh look-ahead. Deduping
 *        "already-notified" is the recipe author's job (D-103
 *        `shared.*` + `ical_uid`).
 *
 *    kind: 'changed_since'
 *      → fire when events were created, updated, or deleted after
 *        `since` (or, when omitted, the per-recipe cursor in
 *        `calendar_watcher_cursors`). On a successful emit the
 *        handler advances the cursor to the max `modified_at` seen
 *        (or `now` when the window was empty — keeps the cursor
 *        moving past stale windows).
 *
 *  Emits a uniform `{ should_run, items, last_seen_at }` envelope
 *  that the auto-run scheduler's trigger-step evaluator consumes,
 *  with `items` shaped like `CalendarWatcherItem` (unix-ms + ISO 8601
 *  + IANA TZ + parsed `prior`).
 *
 *  Reads exclusively from the warehouse (`CalendarCollectionTable`).
 *  Adapter is never consulted — the whole point of the warehouse is
 *  that watcher ticks are cheap and deterministic. Sync currency lives
 *  in the adapter's background loop.
 */

import {
  CALENDAR_STARTING_SOON_DEFAULT_MINUTES,
  type CalendarWatcherItem,
  type CanonicalEvent,
} from '@recued/contracts';
import { RpcError } from '@recued/contracts';

import type { CalendarCollection } from './calendar-collection.js';
import type { CalendarWatcherCursorStore } from './watcher-cursor-store.js';

export type CalendarWatcherKind = 'starting_soon' | 'changed_since';

export interface CalendarWatcherArgs {
  kind: CalendarWatcherKind;
  /** `starting_soon` window. Defaults to
   *  `CALENDAR_STARTING_SOON_DEFAULT_MINUTES` when omitted. */
  minutes_ahead?: number;
  /** `changed_since` override — when provided, takes precedence over
   *  the per-recipe cursor. Useful for the "run once from the start"
   *  bootstrap path. */
  since?: number;
  /** Optional filters shared by both modes. */
  calendar_id?: string;
  /** `starting_soon` — defaults to confirmed + tentative (spec
   *  §watcher-integration). `changed_since` — no default; omitting
   *  matches every status. */
  status?: CanonicalEvent['status'];
  limit?: number;
  /** `recipe_id` is stamped by the auto-run scheduler before dispatch;
   *  required for `changed_since` (carries the per-recipe cursor
   *  slot). `starting_soon` ignores it. */
  recipe_id?: string;
}

export interface CalendarWatcherDeps {
  /** Per-instance warehouse surface. The composition root owns the
   *  live map — this handler only reads. */
  getCollection: (slug: string) => CalendarCollection | undefined;
  /** Cursor persistence for `changed_since`. */
  cursors: CalendarWatcherCursorStore;
  /** `Date.now()` injection for deterministic tests. */
  now?: () => number;
}

export interface CalendarWatcherOutput {
  should_run: boolean;
  items: CalendarWatcherItem[];
  last_seen_at: number;
  [field: string]: unknown;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ────────────────────────────────────────────────────────────────
// Item mapping — warehouse snapshot → wire shape
// ────────────────────────────────────────────────────────────────

/** Format a unix-ms instant as an ISO 8601 string in the event's own
 *  IANA timezone (e.g. "2026-04-23T15:00:00-04:00"). Uses
 *  `Intl.DateTimeFormat` with `timeZoneName: 'longOffset'` to extract
 *  the offset, then composes the final string so we keep seconds +
 *  offset precision without pulling in a formatting library. */
export const formatIsoWithOffset = (unix_ms: number, timezone: string): string => {
  if (!Number.isFinite(unix_ms)) return '';
  const d = new Date(unix_ms);
  let tz = timezone;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    }).formatToParts(d);
  } catch {
    // Unknown IANA name — fall back to UTC so we still return a
    // parseable string instead of throwing into the watcher loop.
    tz = 'UTC';
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    }).formatToParts(d);
  }
  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  let hour = pick('hour');
  // Safari sometimes returns "24" for midnight; normalize to "00".
  if (hour === '24') hour = '00';
  const minute = pick('minute');
  const second = pick('second');
  const raw = pick('timeZoneName'); // "GMT-04:00", "GMT", "GMT+05:30"
  let offset = 'Z';
  if (raw !== '' && raw !== 'GMT') {
    const sign = raw.includes('-') ? '-' : '+';
    const m = raw.match(/(\d{1,2}):?(\d{2})?/);
    if (m) {
      const h = m[1].padStart(2, '0');
      const mm = (m[2] ?? '00').padStart(2, '0');
      // +00:00 collapses to "Z" per ISO 8601 convention.
      offset = (sign === '+' && h === '00' && mm === '00') ? 'Z' : `${sign}${h}:${mm}`;
    }
  }
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
};

const toItem = (
  event: CanonicalEvent,
  prior: CanonicalEvent | null,
): CalendarWatcherItem => {
  const tz = event.timezone || 'UTC';
  const item: CalendarWatcherItem = {
    source_id: event.source_id,
    ical_uid: event.ical_uid,
    calendar_id: event.calendar_id,
    summary: event.summary,
    status: event.status,
    start_at: event.start_at,
    end_at: event.end_at,
    start_iso: formatIsoWithOffset(event.start_at, tz),
    end_iso: formatIsoWithOffset(event.end_at, tz),
    timezone: tz,
    prior,
  };
  if (event.location !== undefined) item.location = event.location;
  if (event.attendees !== undefined) item.attendees = event.attendees;
  return item;
};

// ────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────

const parseArgs = (args: Record<string, unknown>): CalendarWatcherArgs => {
  const slug = args.slug;
  if (typeof slug !== 'string' || slug === '') {
    throw new RpcError('bad_request', 'calendar-watcher: `slug` is required', 400);
  }
  const kind = args.kind;
  if (kind !== 'starting_soon' && kind !== 'changed_since') {
    throw new RpcError(
      'bad_request',
      `calendar-watcher: \`kind\` must be 'starting_soon' or 'changed_since' (got ${JSON.stringify(kind)})`,
      400,
    );
  }
  const out: CalendarWatcherArgs = { kind };
  if (typeof args.minutes_ahead === 'number' && Number.isFinite(args.minutes_ahead)) {
    out.minutes_ahead = args.minutes_ahead;
  }
  if (typeof args.since === 'number' && Number.isFinite(args.since)) {
    out.since = args.since;
  }
  if (typeof args.calendar_id === 'string' && args.calendar_id !== '') {
    out.calendar_id = args.calendar_id;
  }
  if (args.status === 'confirmed' || args.status === 'cancelled' || args.status === 'tentative') {
    out.status = args.status;
  }
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    out.limit = args.limit;
  }
  if (typeof args.recipe_id === 'string' && args.recipe_id !== '') {
    out.recipe_id = args.recipe_id;
  }
  return out;
};

const resolveLimit = (raw: number | undefined): number => {
  const n = raw ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(n, MAX_LIMIT));
};

// ────────────────────────────────────────────────────────────────
// Core handler
// ────────────────────────────────────────────────────────────────

export const handleCalendarWatcher = async (
  deps: CalendarWatcherDeps,
  input: Record<string, unknown>,
): Promise<CalendarWatcherOutput> => {
  const args = parseArgs(input);
  const slug = input.slug as string;
  const now = (deps.now ?? Date.now)();

  const collection = deps.getCollection(slug);
  if (!collection) {
    // Watcher runs are best-effort — emit a no-fire envelope instead
    // of throwing so the scheduler's trigger-step evaluator treats
    // this tick as a skip rather than a crash. Surfacing it would
    // trip the auto-run circuit breaker on every tick while the
    // adapter is restarting.
    return { should_run: false, items: [], last_seen_at: now };
  }

  if (args.kind === 'starting_soon') {
    return runStartingSoon(collection, args, now);
  }
  return runChangedSince(collection, args, now, deps.cursors);
};

const runStartingSoon = (
  collection: CalendarCollection,
  args: CalendarWatcherArgs,
  now: number,
): CalendarWatcherOutput => {
  const minutes = args.minutes_ahead ?? CALENDAR_STARTING_SOON_DEFAULT_MINUTES;
  const upper = now + minutes * 60_000;
  const limit = resolveLimit(args.limit);
  const status = args.status;

  const snapshots = collection.table.listSnapshots({
    start_since: now,
    start_until: upper,
    ...(args.calendar_id !== undefined ? { calendar_id: args.calendar_id } : {}),
    ...(status !== undefined ? { status } : {}),
    order_by: 'start_at',
    direction: 'asc',
    limit,
  });

  const items: CalendarWatcherItem[] = [];
  for (const snapshot of snapshots) {
    // Skip cancelled events when the author didn't ask for them —
    // spec default is "confirmed + tentative" for starting_soon.
    if (status === undefined && snapshot.event.status === 'cancelled') continue;
    items.push(toItem(snapshot.event, snapshot.prior));
  }

  return {
    should_run: items.length > 0,
    items,
    last_seen_at: now,
  };
};

const runChangedSince = (
  collection: CalendarCollection,
  args: CalendarWatcherArgs,
  now: number,
  cursors: CalendarWatcherCursorStore,
): CalendarWatcherOutput => {
  const limit = resolveLimit(args.limit);

  // Resolution order: explicit args.since > stored cursor > "now"
  // (first-ever tick emits nothing and primes the cursor so
  // subsequent ticks have a starting point).
  const storedCursor =
    args.recipe_id !== undefined ? cursors.get(args.recipe_id) : null;
  const since =
    args.since !== undefined
      ? args.since
      : storedCursor !== null
        ? storedCursor
        : now;

  const snapshots = collection.table.listSnapshots({
    modified_since: since,
    ...(args.calendar_id !== undefined ? { calendar_id: args.calendar_id } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    order_by: 'modified_at',
    direction: 'asc',
    limit,
  });

  const items: CalendarWatcherItem[] = [];
  let maxSeen = since;
  for (const snapshot of snapshots) {
    items.push(toItem(snapshot.event, snapshot.prior));
    if (snapshot.modified_at > maxSeen) maxSeen = snapshot.modified_at;
  }

  // Advance the cursor:
  // - empty window → roll forward to `now` so a quiet calendar
  //   doesn't force us to re-scan from the same point forever.
  // - non-empty window → advance to the max `modified_at` seen so
  //   the next tick's strict `modified_at > since` filter skips
  //   these exact rows without missing any edit at the same ms.
  const nextCursor = items.length > 0 ? maxSeen : now;
  if (args.recipe_id !== undefined) {
    cursors.set(args.recipe_id, nextCursor);
  }

  return {
    should_run: items.length > 0,
    items,
    last_seen_at: nextCursor,
  };
};

/** D-117 Phase 2 — CalendarCollectionCaps validation helpers.
 *
 *  Mirrors `collections/file/caps.ts` for the calendar platform.
 *  Pure functions — no DB, no adapter wiring. Callers (enrollment
 *  rpc, parseRecipe, dispatcher) combine these with the instance-
 *  store to gate mutations.
 *
 *  `probeCaps` on an adapter returns a `ProbedCalendarCaps`; this
 *  module normalises that into the canonical `CalendarCollectionCaps`
 *  shape and persists it on the `collection_instances` row. The
 *  dispatcher reads effective caps (caps AND auth_state === 'healthy')
 *  on every call.
 */

import type {
  CalendarCollectionCaps,
  CollectionAuthState,
} from '@recued/contracts';
import type { ProbedCalendarCaps } from './provider.js';

/** Which caps a recipe step can require. `read` is implicit (every
 *  adapter has it); we only gate on mutating operations + the two
 *  surfaces whose absence changes the available ingredient set
 *  (search, rsvp, list_calendars). */
export type CalendarCapRequirement =
  | 'list_calendars'
  | 'create_event'
  | 'update_event'
  | 'delete_event'
  | 'rsvp';

export const isHealthy = (state: CollectionAuthState): boolean =>
  state === 'healthy';

/** Force mutation / watch caps to `'no'` / `'none'` when auth is
 *  not healthy. Called at dispatch time so a stale token surfaces
 *  immediately — the cached caps stay untouched so the next
 *  successful probe can restore the adapter without a re-write. */
export const effectiveCaps = (
  caps: CalendarCollectionCaps,
  auth_state: CollectionAuthState,
): CalendarCollectionCaps => {
  if (isHealthy(auth_state)) return caps;
  return {
    ...caps,
    create_event: 'no',
    update_event: 'no',
    delete_event: 'no',
    rsvp: 'no',
    watch: 'none',
  };
};

export const hasCap = (
  caps: CalendarCollectionCaps,
  requirement: CalendarCapRequirement,
): boolean => caps[requirement] === 'yes';

export class CalendarCapsValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarCapsValidationError';
  }
}

const isYesNo = (v: unknown): v is 'yes' | 'no' => v === 'yes' || v === 'no';

const isSearchMode = (
  v: unknown,
): v is CalendarCollectionCaps['search'] =>
  v === 'local' || v === 'remote' || v === 'none';

const isWatchMode = (
  v: unknown,
): v is CalendarCollectionCaps['watch'] => v === 'poll' || v === 'none';

const isAuthMode = (
  v: unknown,
): v is CalendarCollectionCaps['auth'] =>
  v === 'none' || v === 'oauth' || v === 'basic' || v === 'app_password';

const isRecurrenceMode = (
  v: unknown,
): v is CalendarCollectionCaps['recurrence'] =>
  v === 'server' || v === 'client';

/** Complete shape validation. Called at the enrollment-rpc boundary
 *  so a misbehaving adapter can't poison the DB with a malformed
 *  caps record. Throws `CalendarCapsValidationError` on the first
 *  failing field — surfaces as a developer error (factory bug), not
 *  a user-facing config error. */
export const validateCalendarCaps = (
  input: unknown,
): CalendarCollectionCaps => {
  if (!input || typeof input !== 'object') {
    throw new CalendarCapsValidationError('', 'caps must be an object');
  }
  const obj = input as Record<string, unknown>;

  if (obj.read !== 'yes') {
    throw new CalendarCapsValidationError(
      'read',
      `read must be 'yes' (got ${String(obj.read)})`,
    );
  }
  if (!isYesNo(obj.list_calendars)) {
    throw new CalendarCapsValidationError(
      'list_calendars',
      `list_calendars must be 'yes' | 'no'`,
    );
  }
  if (!isYesNo(obj.create_event)) {
    throw new CalendarCapsValidationError(
      'create_event',
      `create_event must be 'yes' | 'no'`,
    );
  }
  if (!isYesNo(obj.update_event)) {
    throw new CalendarCapsValidationError(
      'update_event',
      `update_event must be 'yes' | 'no'`,
    );
  }
  if (!isYesNo(obj.delete_event)) {
    throw new CalendarCapsValidationError(
      'delete_event',
      `delete_event must be 'yes' | 'no'`,
    );
  }
  if (!isYesNo(obj.rsvp)) {
    throw new CalendarCapsValidationError(
      'rsvp',
      `rsvp must be 'yes' | 'no'`,
    );
  }
  if (!isSearchMode(obj.search)) {
    throw new CalendarCapsValidationError(
      'search',
      `search must be 'local' | 'remote' | 'none'`,
    );
  }
  if (!isWatchMode(obj.watch)) {
    throw new CalendarCapsValidationError(
      'watch',
      `watch must be 'poll' | 'none' (realtime deferred to D-118)`,
    );
  }
  if (!isAuthMode(obj.auth)) {
    throw new CalendarCapsValidationError(
      'auth',
      `auth must be 'none' | 'oauth' | 'basic' | 'app_password'`,
    );
  }
  if (!isRecurrenceMode(obj.recurrence)) {
    throw new CalendarCapsValidationError(
      'recurrence',
      `recurrence must be 'server' | 'client'`,
    );
  }

  return {
    read: 'yes',
    list_calendars: obj.list_calendars,
    create_event: obj.create_event,
    update_event: obj.update_event,
    delete_event: obj.delete_event,
    rsvp: obj.rsvp,
    search: obj.search,
    watch: obj.watch,
    auth: obj.auth,
    recurrence: obj.recurrence,
  };
};

/** Narrow type guard for a `ProbedCalendarCaps` shape. Exists so
 *  adapter factories can assert their own return value at the call
 *  site without re-implementing the field-by-field check. */
export const isProbedCalendarCaps = (
  input: unknown,
): input is ProbedCalendarCaps => {
  try {
    validateCalendarCaps(input);
    return true;
  } catch {
    return false;
  }
};

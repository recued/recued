/** D-117 Phase 6 — calendar dispatcher error helpers.
 *
 *  Two layers of error mapping land here:
 *
 *  1. Instance / access gate (pre-adapter):
 *     - CALENDAR_INSTANCE_NOT_FOUND  (not_found)      slug not enrolled.
 *     - CALENDAR_INSTANCE_DEGRADED   (unauthorized)   auth_state !=
 *                                                     healthy.
 *     - CALENDAR_CAPABILITY_DENIED   (forbidden)      caps don't permit
 *                                                     the op.
 *     - CALENDAR_ADAPTER_UNREACHABLE (server_not_reachable) adapter not
 *                                                     running.
 *
 *  2. Adapter runtime (from CalendarAdapterError):
 *     code → RpcError mapping below. `event_not_found` collapses into
 *     `{ exists: false }` for `calendar-stat`; the other codes always
 *     surface to the recipe surface so authors can branch on them.
 *
 *  The shape mirrors `collections/file/dispatcher.ts` so future reads
 *  of either module follow the same recipe-error vocabulary.
 */

import { RpcError } from '@recued/contracts';
import {
  CalendarAdapterError,
  type CalendarAdapterErrorCode,
} from '@recued/contracts';

/** Type guard — `CalendarAdapterError` thrown across boundary serialise
 *  preserves prototype chains in the same vm; use `name` so we still
 *  catch instances that crossed e.g. a structured-clone path. */
export const isCalendarAdapterError = (
  err: unknown,
): err is CalendarAdapterError => {
  if (err instanceof CalendarAdapterError) return true;
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { name?: unknown }).name === 'CalendarAdapterError'
  );
};

/** Mapping table — adapter code → wire envelope. `io_error` is the
 *  "outcome unknown" variant: the mutation may or may not have landed.
 *  Recipe authors that care about the distinction gate on
 *  `io_error` explicitly in `fail_on`. */
const ADAPTER_ERROR_MAP: Record<
  CalendarAdapterErrorCode,
  { rpcCode: string; userCode: string; status: number }
> = {
  event_not_found: {
    rpcCode: 'not_found',
    userCode: 'CALENDAR_EVENT_NOT_FOUND',
    status: 404,
  },
  calendar_not_found: {
    rpcCode: 'not_found',
    userCode: 'CALENDAR_CALENDAR_NOT_FOUND',
    status: 404,
  },
  permission_denied: {
    rpcCode: 'forbidden',
    userCode: 'CALENDAR_PERMISSION_DENIED',
    status: 403,
  },
  quota_exceeded: {
    rpcCode: 'quota_exceeded',
    userCode: 'CALENDAR_QUOTA_EXCEEDED',
    status: 429,
  },
  rrule_unsupported: {
    rpcCode: 'bad_request',
    userCode: 'CALENDAR_RRULE_UNSUPPORTED',
    status: 400,
  },
  attendee_not_self: {
    rpcCode: 'bad_request',
    userCode: 'CALENDAR_ATTENDEE_NOT_SELF',
    status: 400,
  },
  auth_expired: {
    rpcCode: 'unauthorized',
    userCode: 'CALENDAR_AUTH_EXPIRED',
    status: 401,
  },
  io_error: {
    rpcCode: 'upstream_error',
    userCode: 'CALENDAR_IO_ERROR',
    status: 502,
  },
};

/** Translate a `CalendarAdapterError` into the RpcError the dispatcher
 *  hands back. The message preserves the slug + verb so log readers see
 *  which call exploded without having to walk the stack. */
export const calendarAdapterErrorToRpc = (
  err: CalendarAdapterError,
  slug: string,
  verb: string,
): RpcError => {
  const mapped = ADAPTER_ERROR_MAP[err.code];
  return new RpcError(
    mapped.rpcCode,
    `${mapped.userCode}: ${verb} on calendar instance '${slug}' failed — ${err.message}`,
    mapped.status,
  );
};

/** Run an adapter call and translate `CalendarAdapterError` into a
 *  classified `RpcError`. Non-CalendarAdapterError throws are unexpected
 *  (bugs) — rethrow unchanged so the outer rpc layer turns them into
 *  a 500. */
export const callCalendarAdapter = async <T>(
  slug: string,
  verb: string,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (isCalendarAdapterError(err)) {
      throw calendarAdapterErrorToRpc(err, slug, verb);
    }
    throw err;
  }
};

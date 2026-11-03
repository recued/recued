/** Owner edits reuse the dispatcher's binding and atomic local-version guard. */
import {
  CALENDAR_EVENT_EDIT_LIMITS, CALENDAR_EVENT_GUEST_LIMITS,
  DAY_MS,
  RpcError,
  type CalendarCollectionCaps,
  type CalendarEventRef,
  type CalendarEventSnapshot,
  type CalendarEventUpdateRequest,
  type CalendarEventDeleteRequest,
  type CalendarEventDeleteResult,
  type CalendarEventDeletionCheckRequest,
  type CalendarEventDeletionState,
} from '@recued/contracts';
import { resourceReviewHash, withResourceReview } from '../../resource-review.js';
import { commitLocalTransaction } from '../../local-transaction.js';
import { prepareLocalCalendarUpdate, prepareLocalCalendarDelete, type CalendarDispatcherDeps } from './calendar-dispatcher.js';
import { captureCalendarResource } from './resource-review.js';
import { snapshotToCollectionRecord } from './calendar-collection.js';

const invalid = (message: string): never => { throw new RpcError('invalid_args', message, 400); };
export const refOf = (input: CalendarEventRef): CalendarEventRef => {
  if (!input || typeof input.slug !== 'string' || !input.slug || input.slug.length > 256
    || typeof input.source_id !== 'string' || !input.source_id || input.source_id.length > 4096) {
    return invalid('A calendar and event identity are required.');
  }
  return { slug: input.slug, source_id: input.source_id };
};
const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');
const usableTimeZone = (zone: string): boolean => {
  if (typeof zone !== 'string' || !zone) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
};

export const getCalendarEvent = (deps: CalendarDispatcherDeps, input: CalendarEventRef): CalendarEventSnapshot => {
  const { slug, source_id } = refOf(input);
  const collection = deps.getCollection(slug);
  const instance = deps.instances.get('calendar', slug);
  const row = collection?.table.get(source_id);
  if (!collection || !instance || !row) throw new RpcError('not_found', 'This calendar event is unavailable. Refresh the calendar.', 404);
  const event = row.event;
  const incarnation = deps.instances.getIncarnation?.('calendar', slug) ?? null;
  const is_recurring = Boolean(event.recurrence_rule || event.recurring_event_id);
  const oversized = (Object.keys(CALENDAR_EVENT_EDIT_LIMITS) as Array<keyof typeof CALENDAR_EVENT_EDIT_LIMITS>)
    .some(key => byteLength(event[key] ?? '') > CALENDAR_EVENT_EDIT_LIMITS[key]);
  const reason = collection.provider.kind !== 'local' || instance.adapter_type !== 'local'
    ? 'Edit this event in its connected calendar.'
    : event.status === 'cancelled' ? 'Cancelled events cannot be edited.'
    : is_recurring ? 'Edit recurring events with a calendar recipe.'
    : instance.auth_state !== 'healthy' || (instance.caps as CalendarCollectionCaps).update_event !== 'yes'
      ? 'Editing is unavailable for this calendar.'
    : !incarnation || !row.resource_version ? 'Refresh the calendar before editing this event.'
    : !event.is_all_day && !usableTimeZone(event.timezone) ? 'The event’s time zone is unavailable in this editor.'
    : oversized ? 'This event exceeds the editor’s text limit. Use a calendar recipe to edit it.'
    : undefined;
  const description = event.description ?? '';
  const truncated = byteLength(description) > CALENDAR_EVENT_EDIT_LIMITS.description;
  return {
    event: {
      record_id: row.record_id, source_id, calendar_id: event.calendar_id,
      ...(event.calendar_name ? { calendar_name: event.calendar_name } : {}),
      summary: event.summary, description: truncated ? description.slice(0, 16_384) : description,
      ...(truncated ? { description_truncated: true as const } : {}),
      location: event.location ?? '', start_at: event.start_at, end_at: event.end_at, updated_at: event.updated_at,
      timezone: event.timezone, is_all_day: event.is_all_day, status: event.status, is_recurring,
      ...(event.attendees?.length ? { attendees: event.attendees.slice(0, CALENDAR_EVENT_GUEST_LIMITS.count).map(attendee => ({
        email: attendee.email, ...(attendee.display_name ? { display_name: attendee.display_name } : {}),
        response_status: attendee.response_status,
      })), attendee_count: event.attendees.length } : {}),
    },
    record: snapshotToCollectionRecord(row),
    resource_version: row.resource_version, incarnation, editable: reason === undefined,
    ...(collection.provider.kind === 'local' && instance.adapter_type === 'local' && !collection.stopped
      && !is_recurring && instance.auth_state === 'healthy' && instance.config.native_write_enabled !== false
      && (instance.caps as CalendarCollectionCaps).delete_event === 'yes' && incarnation && row.resource_version
      ? { deletable: true as const } : {}),
    ...(reason ? { read_only_reason: reason } : {}),
  };
};

export const validateCalendarEventPatch = (
  snapshot: CalendarEventSnapshot, patch: CalendarEventUpdateRequest['patch'],
): CalendarEventUpdateRequest['patch'] => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    return invalid('Choose at least one event field to update.');
  }
  const allowed = new Set(['summary', 'description', 'location', 'start_at', 'end_at']);
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) return invalid(`The event editor cannot change ${key}.`);
    if (key === 'start_at' || key === 'end_at') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
        return invalid('Choose a valid event date and time.');
      }
    } else {
      const limit = CALENDAR_EVENT_EDIT_LIMITS[key as keyof typeof CALENDAR_EVENT_EDIT_LIMITS];
      if (typeof value !== 'string' || byteLength(value) > limit) return invalid(`${key} exceeds the editor’s text limit.`);
      if (key === 'summary' && !value.trim()) return invalid('An event title is required.');
    }
  }
  const start = patch.start_at ?? snapshot.event.start_at;
  const end = patch.end_at ?? snapshot.event.end_at;
  if (end <= start) return invalid('The end must be after the start.');
  if (snapshot.event.is_all_day && (start % DAY_MS !== 0 || end % DAY_MS !== 0)) {
    return invalid('All-day events must use whole calendar days.');
  }
  return patch;
};

export const updateCalendarEvent = async (
  deps: CalendarDispatcherDeps, input: CalendarEventUpdateRequest,
): Promise<CalendarEventSnapshot> => {
  const ref = refOf(input);
  const snapshot = getCalendarEvent(deps, ref);
  if (!snapshot.editable) throw new RpcError('forbidden', snapshot.read_only_reason!, 403);
  if (typeof input.expected_version !== 'string' || typeof input.expected_incarnation !== 'string'
    || snapshot.resource_version !== input.expected_version || snapshot.incarnation !== input.expected_incarnation) {
    throw new RpcError('resource_changed', 'This event changed since you opened it. Your draft has been kept. Reload the saved event before editing again.', 409);
  }
  const patch = validateCalendarEventPatch(snapshot, input.patch);
  const dispatchInput = { ...ref, patch, scope: 'this_instance' as const };
  const resource = captureCalendarResource(deps, 'calendar-update', dispatchInput);
  // No await between snapshot and capture; the dispatcher revalidates this
  // review and applies a compare-and-swap when its provider promise resolves.
  await withResourceReview({
    schema_version: 1, operation: 'calendar-update', input_hash: resourceReviewHash(dispatchInput),
    captured_at: (deps.now ?? Date.now)(), resources: [resource],
  }, async () => {
    const prepared = await prepareLocalCalendarUpdate(deps, dispatchInput);
    commitLocalTransaction(prepared.db, () => prepared.apply());
  });
  return getCalendarEvent(deps, ref);
};

const boundLocalCalendar = (deps: CalendarDispatcherDeps, input: CalendarEventDeletionCheckRequest) => {
  const ref = refOf(input);
  if (typeof input.expected_incarnation !== 'string' || !input.expected_incarnation) {
    return invalid('The local calendar identity is required.');
  }
  const instance = deps.instances.get('calendar', ref.slug);
  if (!instance || deps.instances.getIncarnation?.('calendar', ref.slug) !== input.expected_incarnation) {
    throw new RpcError('resource_changed', 'This calendar was removed or replaced. Reopen it before deleting an event.', 409);
  }
  const collection = deps.getCollection(ref.slug);
  if (!collection || collection.stopped) throw new RpcError('unavailable', 'This calendar is unavailable. Check again when it is running.', 503);
  if (collection.provider.kind !== 'local' || instance.adapter_type !== 'local') {
    throw new RpcError('forbidden', 'Only single events on a local calendar can be deleted here.', 403);
  }
  return { ref, collection };
};

/** A read, never a retry of the write. Missing connections cannot prove deletion. */
export const checkCalendarEventDeletion = (
  deps: CalendarDispatcherDeps, input: CalendarEventDeletionCheckRequest,
): CalendarEventDeletionState => {
  const { ref, collection } = boundLocalCalendar(deps, input);
  return { ...ref, incarnation: input.expected_incarnation,
    snapshot: collection.table.get(ref.source_id) ? getCalendarEvent(deps, ref) : null };
};

export const deleteCalendarEvent = async (
  deps: CalendarDispatcherDeps, input: CalendarEventDeleteRequest,
): Promise<CalendarEventDeleteResult> => {
  const { ref } = boundLocalCalendar(deps, input);
  const snapshot = getCalendarEvent(deps, ref);
  if (!snapshot.deletable) throw new RpcError('forbidden', 'This event cannot be deleted here. Only single events on a writable local calendar are supported.', 403);
  if (typeof input.expected_version !== 'string' || !input.expected_version) return invalid('The event version is required.');
  if (snapshot.resource_version !== input.expected_version) {
    throw new RpcError('resource_changed', 'This event changed since you reviewed it. Check its saved details before deleting it.', 409);
  }
  const dispatchInput = { ...ref, scope: 'this_instance' as const };
  const resource = captureCalendarResource(deps, 'calendar-delete', dispatchInput);
  await withResourceReview({
    schema_version: 1, operation: 'calendar-delete', input_hash: resourceReviewHash(dispatchInput),
    captured_at: (deps.now ?? Date.now)(), resources: [resource],
  }, async () => {
    const prepared = await prepareLocalCalendarDelete(deps, dispatchInput);
    commitLocalTransaction(prepared.db, () => {
      // Native-write permissions can change while the provider check awaits.
      boundLocalCalendar(deps, input);
      if (!getCalendarEvent(deps, ref).deletable) throw new RpcError('forbidden', 'Deletion is no longer available for this event.', 403);
      prepared.apply();
    });
  });
  return { ...ref, incarnation: input.expected_incarnation, deleted: true };
};

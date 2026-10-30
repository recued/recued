import {
  CALENDAR_EVENT_EDIT_LIMITS, RpcError, type CalendarCollectionCaps, type CalendarEventPatch,
  type CalendarEventRef, type CalendarEventSnapshot, type CalendarEventUpdateRequest,
} from '@recued/contracts';
import type { CalendarDispatcherDeps } from './calendar-dispatcher.js';
import type { CalendarCollection } from './calendar-collection.js';
import type { ProviderEventEditContext, ProviderEventPayload } from './provider.js';
import { getCalendarEvent, updateCalendarEvent, validateCalendarEventPatch } from './local-event-handler.js';
import { normalizeCalendarMutationPatch } from './mutation-patch.js';
import { callCalendarAdapter } from './errors.js';

const fields: Array<keyof CalendarEventPatch> = ['summary', 'description', 'location', 'start_at', 'end_at'];
/** Owner edits and invitation responses share one in-process event write fence. */
export const ownerCalendarWrites = new WeakMap<CalendarCollection, Set<string>>();
const changed = (): never => { throw new RpcError('resource_changed', 'This event or calendar changed. Your draft is kept. Check the saved event before continuing.', 409); };
const updateError = (error: unknown): never => {
  // Provider version conflicts use RESOURCE_CHANGED rather than CALENDAR_.
  if (error instanceof RpcError && error.code !== 'resource_conflict' && !error.message.startsWith('CALENDAR_')) throw error;
  const code = error instanceof RpcError ? error.code : 'upstream_error';
  const copy: Record<string, [string, number]> = {
    resource_conflict: ['This event changed in its calendar. Check the saved event before trying again.', 409],
    unauthorized: ['Reconnect this calendar, then check the saved event before trying again.', 401],
    forbidden: ['Your calendar no longer permits this change. Your draft is kept.', 403],
    not_found: ['This event is no longer available in its calendar. Your draft is kept.', 404],
    quota_exceeded: ['Your calendar is busy. Check the saved event before trying again.', 429],
    upstream_error: ['The calendar could not confirm the save. Check the saved event before trying again.', 502],
  };
  const [message, status] = copy[code] ?? copy.upstream_error!;
  throw new RpcError(code, message, status);
};
const binding = (deps: CalendarDispatcherDeps, ref: CalendarEventRef, collection: CalendarCollection, incarnation: string | null, version?: string) => {
  const row = collection.table.get(ref.source_id);
  if (!incarnation || deps.getCollection(ref.slug) !== collection || !row
    || deps.instances.getIncarnation?.('calendar', ref.slug) !== incarnation
    || version !== undefined && row.resource_version !== version) changed();
};
const writeReason = (deps: CalendarDispatcherDeps, ref: CalendarEventRef, collection: CalendarCollection): string | undefined => {
  const instance = deps.instances.get('calendar', ref.slug);
  return !instance || instance.adapter_type !== collection.provider.kind || !collection.provider.readEventForEdit
    ? 'This connection cannot verify event editing.'
    : instance.auth_state !== 'healthy' ? 'Reconnect this calendar before editing.'
    : instance.config.native_write_enabled === false || (instance.caps as CalendarCollectionCaps).update_event !== 'yes'
      ? 'This calendar connection does not allow event updates.' : undefined;
};
const checkPayload = (ref: CalendarEventRef, calendar: string, payload: ProviderEventPayload) => {
  if (payload.event.source_id !== ref.source_id || payload.event.calendar_id !== calendar) {
    throw new RpcError('upstream_error', 'The calendar returned a different event. Your draft is kept.', 502);
  }
};
export const calendarEventEditView = (deps: CalendarDispatcherDeps, ref: CalendarEventRef, collection: CalendarCollection, context: ProviderEventEditContext): CalendarEventSnapshot => {
  const base = getCalendarEvent(deps, ref), { read_only_reason: _old, ...view } = base;
  let allowed = fields.filter(key => context.editable_fields.includes(key));
  let validZone = true;
  try { new Intl.DateTimeFormat('en', { timeZone: base.event.timezone }); } catch { validZone = false; }
  if (!validZone && !base.event.is_all_day) allowed = allowed.filter(key => key !== 'start_at' && key !== 'end_at');
  const oversized = (['summary', 'description', 'location'] as const).some(key => allowed.includes(key)
    && Buffer.byteLength(collection.table.get(ref.source_id)!.event[key] ?? '', 'utf8') > CALENDAR_EVENT_EDIT_LIMITS[key]);
  const versionUsable = (collection.provider.kind === 'graph' ? /^(?:W\/)?"[^"\r\n]+"$/ : /^"[^"\r\n]+"$/).test(context.payload.etag ?? '');
  const reason = writeReason(deps, ref, collection) ?? context.read_only_reason
    ?? (base.event.status === 'cancelled' ? 'Cancelled events cannot be edited.' : undefined)
    ?? (base.event.is_recurring ? 'Edit recurring events in their connected calendar.' : undefined)
    ?? (!base.incarnation || !versionUsable ? 'This event has no verifiable provider version. Refresh its calendar before editing.' : undefined)
    ?? (oversized ? 'This event exceeds the editor’s text limit. Edit it in its connected calendar.' : undefined)
    ?? (!allowed.length ? 'This event does not allow these changes.' : undefined);
  const notices = [context.edit_notice, !validZone && !base.event.is_all_day ? 'Date editing is unavailable for this event’s time zone.' : undefined].filter(Boolean);
  return { ...view, editable: !reason, editable_fields: allowed, provider_verified: true,
    ...(reason ? { read_only_reason: reason } : {}), ...(notices.length ? { edit_notice: notices.join(' ') } : {}) };
};

export const readCalendarEventForEdit = async (deps: CalendarDispatcherDeps, ref: CalendarEventRef): Promise<{
  view: CalendarEventSnapshot; context?: ProviderEventEditContext;
}> => {
  const before = getCalendarEvent(deps, ref), collection = deps.getCollection(ref.slug)!;
  if (collection.provider.kind === 'local') return { view: before };
  if (!collection.provider.readEventForEdit) return { view: before };
  let context: ProviderEventEditContext;
  try {
    context = await callCalendarAdapter(ref.slug, 'read-event', () => collection.provider.readEventForEdit!(before.event.calendar_id, ref.source_id));
  } catch {
    binding(deps, ref, collection, before.incarnation, before.resource_version);
    return { view: { ...before, editable: false, editable_fields: [],
      read_only_reason: 'Refresh this event from its connected calendar before editing.',
      refresh_error: 'The calendar could not be refreshed. Showing the last synced details.' } };
  }
  binding(deps, ref, collection, before.incarnation, before.resource_version);
  checkPayload(ref, before.event.calendar_id, context.payload);
  await collection.applyVerifiedUpsert(context.payload, before.resource_version, () => {
    binding(deps, ref, collection, before.incarnation); return true;
  });
  binding(deps, ref, collection, before.incarnation);
  return { view: calendarEventEditView(deps, ref, collection, context), context };
};

/** Editing retains the event's calendar and identity. It never creates, deletes,
 * moves, changes guests, or replaces the provider's unedited rich fields. */
export const updateOwnerCalendarEvent = async (deps: CalendarDispatcherDeps, input: CalendarEventUpdateRequest): Promise<CalendarEventSnapshot> => {
  const before = getCalendarEvent(deps, input), collection = deps.getCollection(input.slug)!;
  if (collection.provider.kind === 'local') return updateCalendarEvent(deps, input);
  if (typeof input.expected_version !== 'string' || !input.expected_version
    || typeof input.expected_incarnation !== 'string' || !input.expected_incarnation) {
    throw new RpcError('invalid_args', 'The event’s current version and connection are required.', 400);
  }
  binding(deps, input, collection, input.expected_incarnation);
  const patch = validateCalendarEventPatch(before, input.patch);
  const denied = writeReason(deps, input, collection);
  if (denied) throw new RpcError('forbidden', denied, 403);
  let pending = ownerCalendarWrites.get(collection);
  if (!pending) { pending = new Set(); ownerCalendarWrites.set(collection, pending); }
  if (pending.has(input.source_id)) throw new RpcError('conflict', 'An event update is already in progress. Check the saved event before trying again.', 409);
  pending.add(input.source_id);
  try {
    const fresh = await readCalendarEventForEdit(deps, input);
    binding(deps, input, collection, input.expected_incarnation);
    if (!fresh.context || !fresh.view.provider_verified) throw new RpcError('upstream_error', fresh.view.refresh_error ?? 'The event could not be verified.', 502);
    const row = collection.table.get(input.source_id)!;
    // Recover a lost acknowledgement as a read, without notifying guests again.
    if (Object.entries(patch).every(([key, value]) => fresh.view.event[key as keyof CalendarEventPatch] === value)) return fresh.view;
    if (before.resource_version !== input.expected_version || fresh.view.resource_version !== input.expected_version) changed();
    if (!fresh.view.editable) throw new RpcError('forbidden', fresh.view.read_only_reason!, 403);
    if (Object.keys(patch).some(key => !fresh.view.editable_fields?.includes(key as keyof CalendarEventPatch))) {
      throw new RpcError('forbidden', 'One of these fields must be edited in the connected calendar. Your draft is kept.', 403);
    }
    validateCalendarEventPatch(fresh.view, patch);
    const beforeSend = () => {
      binding(deps, input, collection, input.expected_incarnation, fresh.view.resource_version);
      const reason = writeReason(deps, input, collection);
      if (reason) throw new RpcError('forbidden', reason, 403);
    };
    beforeSend();
    const received = await callCalendarAdapter(input.slug, 'calendar-update', () => collection.provider.updateEvent({
      calendar_id: before.event.calendar_id, source_id: input.source_id,
      expected_etag: fresh.context!.payload.etag, before_send: beforeSend,
      notify_attendees: fresh.context!.notify_attendees ?? Boolean(row.event.attendees?.length),
      patch: normalizeCalendarMutationPatch(patch, row.event), scope: 'this_instance',
    })).catch(updateError);
    // An event PATCH response has no hosting-calendar display name. Keep the
    // name verified by the calendar listing immediately before this write.
    const payload = received.event.calendar_name === undefined && fresh.view.event.calendar_name !== undefined
      ? { ...received, event: { ...received.event, calendar_name: fresh.view.event.calendar_name } } : received;
    beforeSend(); checkPayload(input, before.event.calendar_id, payload);
    await collection.applyVerifiedUpsert(payload, fresh.view.resource_version, () => {
      binding(deps, input, collection, input.expected_incarnation); return true;
    });
    binding(deps, input, collection, input.expected_incarnation);
    return calendarEventEditView(deps, input, collection, { ...fresh.context, payload });
  } finally { pending.delete(input.source_id); }
};

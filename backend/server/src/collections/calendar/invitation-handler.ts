/** Paired-owner RSVP: the mirror alone is never proof of a sendable invitation. */
import {
  RpcError, type CalendarCollectionCaps, type CalendarEventRef,
  type CalendarEventSnapshot, type CalendarEventRespondRequest, type CalendarEventRespondResult,
} from '@recued/contracts';
import type { CalendarDispatcherDeps } from './calendar-dispatcher.js';
import type { CalendarCollection } from './calendar-collection.js';
import type { ProviderEventPayload } from './provider.js';
import { getCalendarEvent } from './local-event-handler.js';
import { callCalendarAdapter } from './errors.js';

const inflight = new WeakMap<CalendarCollection, Set<string>>();
const changed = (): never => { throw new RpcError('resource_changed', 'The invitation changed. Refresh its details before responding.', 409); };
const selfOf = (collection: CalendarCollection, payload: ProviderEventPayload) => {
  const email = collection.provider.accountEmail?.trim().toLowerCase();
  if (!email) return undefined;
  const attendees = payload.event.attendees?.filter(a => a.email.toLowerCase() === email) ?? [];
  return attendees.length === 1 ? attendees[0] : undefined;
};
const unavailable = (deps: CalendarDispatcherDeps, ref: CalendarEventRef, collection: CalendarCollection): string | undefined => {
  const instance = deps.instances.get('calendar', ref.slug);
  if (!instance || instance.adapter_type !== collection.provider.kind
    || !['gcal', 'graph'].includes(collection.provider.kind) || !collection.provider.readInvitation) {
    return 'This calendar has no verified way to notify the organizer from Recued.';
  }
  if (instance.auth_state !== 'healthy') return 'Reconnect this calendar before responding.';
  if (instance.config.native_write_enabled === false || (instance.caps as CalendarCollectionCaps).rsvp !== 'yes') {
    return 'This calendar does not allow invitation responses.';
  }
  return undefined;
};
const checkBinding = (
  deps: CalendarDispatcherDeps, ref: CalendarEventRef, collection: CalendarCollection,
  incarnation: string | null, version?: string,
) => {
  if (!incarnation || deps.getCollection(ref.slug) !== collection
    || deps.instances.getIncarnation?.('calendar', ref.slug) !== incarnation
    || (version !== undefined && collection.table.get(ref.source_id)?.resource_version !== version)) changed();
};
const mirror = async (
  deps: CalendarDispatcherDeps, ref: CalendarEventRef, collection: CalendarCollection,
  payload: ProviderEventPayload, incarnation: string | null, version: string,
): Promise<void> => {
  checkBinding(deps, ref, collection, incarnation, version);
  await collection.applyVerifiedUpsert(payload, version, () => {
    checkBinding(deps, ref, collection, incarnation);
    return true;
  });
  checkBinding(deps, ref, collection, incarnation);
};
const checkPayload = (ref: CalendarEventRef, calendar_id: string, payload: ProviderEventPayload) => {
  if (payload.event.source_id !== ref.source_id || payload.event.calendar_id !== calendar_id) {
    throw new RpcError('upstream_error', 'The calendar returned a different invitation.', 502);
  }
};
const invitationView = (
  deps: CalendarDispatcherDeps, ref: CalendarEventRef, collection: CalendarCollection,
  notificationSupported: boolean,
): CalendarEventSnapshot => {
  const view = getCalendarEvent(deps, ref);
  const row = collection.table.get(ref.source_id)!;
  const self = selfOf(collection, { event: row.event, description_bytes: 0 });
  const organizer = row.event.organizer;
  if (!self || !organizer?.email || organizer.email.toLowerCase() === self.email.toLowerCase()) return view;
  const reason = unavailable(deps, ref, collection)
    ?? (row.event.status === 'cancelled' ? 'This invitation was cancelled.' : undefined)
    ?? (!notificationSupported ? 'Organizer notification could not be verified for this invitation.' : undefined)
    ?? (!view.incarnation ? 'Refresh this calendar before responding.' : undefined);
  return { ...view, invitation: {
    organizer, attendee_email: self.email, response: self.response_status,
    scope: row.event.recurring_event_id ? 'occurrence' : row.event.recurrence_rule ? 'series' : 'event',
    can_respond: reason === undefined, ...(reason ? { unavailable_reason: reason } : {}),
  } };
};

export const getOwnerCalendarEvent = async (deps: CalendarDispatcherDeps, ref: CalendarEventRef): Promise<CalendarEventSnapshot> => {
  const before = getCalendarEvent(deps, ref);
  const collection = deps.getCollection(ref.slug)!;
  if (collection.provider.kind === 'local') return before;
  if (unavailable(deps, ref, collection)) return invitationView(deps, ref, collection, false);
  let context: Awaited<ReturnType<NonNullable<typeof collection.provider.readInvitation>>>;
  try {
    context = await callCalendarAdapter(ref.slug, 'read-invitation', () =>
      collection.provider.readInvitation!(before.event.calendar_id, ref.source_id));
  } catch (error) {
    // A failed remote read must neither hide the mirror nor certify its RSVP.
    checkBinding(deps, ref, collection, before.incarnation, before.resource_version);
    const message = error instanceof RpcError && error.code === 'not_found'
      ? 'This event is unavailable in its connected calendar. Showing the last synced details.'
      : 'The calendar could not be refreshed. Showing the last synced details.';
    return { ...invitationView(deps, ref, collection, false), refresh_error: message };
  }
  checkBinding(deps, ref, collection, before.incarnation, before.resource_version);
  checkPayload(ref, before.event.calendar_id, context.payload);
  await mirror(deps, ref, collection, context.payload, before.incarnation, before.resource_version);
  checkBinding(deps, ref, collection, before.incarnation);
  return { ...invitationView(deps, ref, collection, context.notification_supported), provider_verified: true };
};

export const respondToCalendarEvent = async (
  deps: CalendarDispatcherDeps, input: CalendarEventRespondRequest,
): Promise<CalendarEventRespondResult> => {
  if (!input || !['accepted', 'tentative', 'declined'].includes(input.response)
    || typeof input.expected_version !== 'string' || !input.expected_version
    || typeof input.expected_incarnation !== 'string' || !input.expected_incarnation) {
    throw new RpcError('invalid_args', 'An invitation response and its current version are required.', 400);
  }
  const before = getCalendarEvent(deps, input);
  const collection = deps.getCollection(input.slug)!;
  checkBinding(deps, input, collection, input.expected_incarnation, input.expected_version);
  const reason = unavailable(deps, input, collection);
  if (reason) throw new RpcError('forbidden', reason, 403);
  let pending = inflight.get(collection);
  if (!pending) { pending = new Set(); inflight.set(collection, pending); }
  if (pending.has(input.source_id)) throw new RpcError('conflict', 'A response is already in progress. Check the response before sending again.', 409);
  pending.add(input.source_id);
  try {
    const context = await callCalendarAdapter(input.slug, 'read-invitation', () =>
      collection.provider.readInvitation!(before.event.calendar_id, input.source_id));
    checkBinding(deps, input, collection, input.expected_incarnation, input.expected_version);
    checkPayload(input, before.event.calendar_id, context.payload);
    await mirror(deps, input, collection, context.payload, input.expected_incarnation, input.expected_version);
    const view = invitationView(deps, input, collection, context.notification_supported);
    const invitation = view.invitation;
    if (!invitation?.can_respond) throw new RpcError('forbidden', invitation?.unavailable_reason ?? 'The connected account is not an invited attendee.', 403);
    // A lost reply followed by another request must not send the same RSVP twice.
    if (invitation.response === input.response) return { removed: false, snapshot: { ...view, provider_verified: true } };
    if (view.resource_version !== input.expected_version) changed();
    const beforeSend = () => {
      checkBinding(deps, input, collection, input.expected_incarnation, view.resource_version);
      const denied = unavailable(deps, input, collection);
      if (denied) throw new RpcError('forbidden', denied, 403);
    };
    beforeSend();
    const result = await callCalendarAdapter(input.slug, 'calendar-rsvp', () => collection.provider.rsvpEvent({
      calendar_id: view.event.calendar_id, source_id: input.source_id, response: input.response,
      self_email: invitation.attendee_email, before_send: beforeSend,
      ...(context.payload.etag ? { expected_etag: context.payload.etag } : {}),
    }));
    checkBinding(deps, input, collection, input.expected_incarnation);
    if ('removed' in result) {
      if (input.response !== 'declined' || result.source_id !== input.source_id) throw new RpcError('upstream_error', 'The calendar response could not be confirmed.', 502);
      collection.applyVerifiedDelete(input.source_id, view.resource_version);
      return { removed: true, source_id: input.source_id, response: 'declined' };
    }
    checkPayload(input, view.event.calendar_id, result);
    await mirror(deps, input, collection, result, input.expected_incarnation, view.resource_version);
    checkBinding(deps, input, collection, input.expected_incarnation);
    const saved = invitationView(deps, input, collection, context.notification_supported);
    if (saved.invitation?.response !== input.response) throw new RpcError('upstream_error', 'The calendar has not confirmed your response. Check its status before sending again.', 502);
    return { removed: false, snapshot: { ...saved, provider_verified: true } };
  } finally { pending.delete(input.source_id); }
};

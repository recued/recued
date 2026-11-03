import {
  CALENDAR_EVENT_EDIT_LIMITS, DAY_MS, RpcError, normalizeCalendarEventGuests,
  type CalendarEventCreateRequest, type CalendarEventCreateResult, type CalendarEventDestinations,
} from '@recued/contracts';
import { resourceReviewHash } from '../../resource-review.js';
import type { CalendarEventCreationStore } from '../../storage/calendar-event-creations.js';
import { checkCalendarCreate, handleCalendarCreate, type CalendarDispatcherDeps } from './calendar-dispatcher.js';
import { getCalendarEvent } from './local-event-handler.js';
import type { CalendarCollection } from './calendar-collection.js';

const invalid = (message: string): never => { throw new RpcError('invalid_args', message, 400); };
const changed = (): never => { throw new RpcError('resource_changed', 'This calendar connection changed. Reload calendars before saving.', 409); };
const unknown = (): never => { throw new RpcError('outcome_unknown', 'The save could not be confirmed. Check the selected calendar before creating another event. Checking this save will not create a second event.', 409); };
const writableCollection = (deps: CalendarDispatcherDeps, slug: string): CalendarCollection => {
  const { collection } = checkCalendarCreate(deps, { slug });
  const instance = deps.instances.get('calendar', slug);
  if (instance?.adapter_type !== collection.provider.kind || instance.config.native_write_enabled === false) {
    throw new RpcError('forbidden', 'This calendar connection does not allow event creation.', 403);
  }
  return collection;
};
const assertBinding = (deps: CalendarDispatcherDeps, slug: string, incarnation: string, collection: CalendarCollection): void => {
  if (deps.getCollection(slug) !== collection || deps.instances.getIncarnation?.('calendar', slug) !== incarnation) changed();
  writableCollection(deps, slug);
};

export const listCalendarEventDestinations = async (deps: CalendarDispatcherDeps): Promise<CalendarEventDestinations> => {
  const results = await Promise.all(deps.instances.list('calendar').map(async instance => {
    const unavailable = (reason: string) => ({ destinations: [], unavailable: [{ slug: instance.slug, reason }] });
    try {
      const collection = writableCollection(deps, instance.slug);
      const incarnation = deps.instances.getIncarnation?.('calendar', instance.slug);
      if (!incarnation || !collection.provider.listWritableCalendars) return unavailable('Event creation is unavailable for this calendar.');
      const calendars = await collection.provider.listWritableCalendars();
      assertBinding(deps, instance.slug, incarnation, collection);
      const destinations = calendars.filter(cal => typeof cal.calendar_id === 'string' && cal.calendar_id.length > 0
        && cal.calendar_id.length <= 4096 && typeof cal.name === 'string').map(cal => ({
        slug: instance.slug, calendar_id: cal.calendar_id, name: cal.name.slice(0, 1024),
        provider: collection.provider.kind, incarnation,
        ...(cal.can_invite === true && collection.provider.kind !== 'local' ? { can_invite: true as const } : {}),
        ...(cal.invitation_unavailable_reason ? { invitation_unavailable_reason: cal.invitation_unavailable_reason } : {}),
      }));
      return destinations.length ? { destinations, unavailable: [] } : unavailable('No writable calendars are available on this connection.');
    } catch {
      return unavailable('Writable calendars could not be verified. Check this connection or reload calendars.');
    }
  }));
  return { destinations: results.flatMap(result => result.destinations), unavailable: results.flatMap(result => result.unavailable) };
};

const validate = (input: CalendarEventCreateRequest): CalendarEventCreateRequest => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('Enter the event details.');
  for (const key of ['slug', 'calendar_id', 'expected_incarnation', 'creation_id'] as const) {
    if (typeof input[key] !== 'string' || !input[key] || input[key].length > (key === 'calendar_id' ? 4096 : 256)) return invalid('Choose a calendar and reload its current details.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.creation_id)) return invalid('Open a new event form before saving.');
  for (const key of ['summary', 'description', 'location'] as const) {
    if (typeof input[key] !== 'string' || Buffer.byteLength(input[key], 'utf8') > CALENDAR_EVENT_EDIT_LIMITS[key]) return invalid('The event title, location or notes exceed the text limit.');
  }
  if (!input.summary.trim()) return invalid('Enter an event title.');
  if (typeof input.timezone !== 'string' || !input.timezone || input.timezone.length > 256) return invalid('Choose a valid time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { return invalid('Choose a valid time zone.'); }
  for (const at of [input.start_at, input.end_at]) {
    if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) return invalid('Choose valid event dates and times.');
  }
  if (input.end_at <= input.start_at) return invalid('The end must be after the start.');
  if (typeof input.is_all_day !== 'boolean' || input.is_all_day && (input.start_at % DAY_MS !== 0 || input.end_at % DAY_MS !== 0)) return invalid('All-day events must use whole calendar dates.');
  let guests: NonNullable<CalendarEventCreateRequest['guests']>;
  try { guests = normalizeCalendarEventGuests(input.guests ?? []); }
  catch (cause) { return invalid(cause instanceof Error ? cause.message : 'Check the guest list.'); }
  if ((input.send_invitations !== undefined && input.send_invitations !== true)
    || Boolean(guests.length) !== (input.send_invitations === true)) {
    return invalid('Review the guests and choose Create and send invitations.');
  }
  // Bind only the owner form's supported fields. Raw attendees, organizer and
  // recurrence cannot silently add recipients or change the event's identity.
  return { slug: input.slug, calendar_id: input.calendar_id, expected_incarnation: input.expected_incarnation,
    creation_id: input.creation_id, summary: input.summary, description: input.description, location: input.location,
    start_at: input.start_at, end_at: input.end_at, timezone: input.timezone, is_all_day: input.is_all_day,
    ...(guests.length ? { guests, send_invitations: true as const } : {}) };
};

export const createOwnerCalendarEvent = async (
  deps: CalendarDispatcherDeps, store: CalendarEventCreationStore, raw: CalendarEventCreateRequest,
): Promise<CalendarEventCreateResult> => {
  const input = validate(raw), hash = resourceReviewHash(input);
  const collection = deps.getCollection(input.slug);
  if (!collection) throw new RpcError('not_found', 'This calendar is unavailable. Reload calendars.', 404);
  const binding = () => assertBinding(deps, input.slug, input.expected_incarnation, collection);
  const priorResult = (): CalendarEventCreateResult | undefined => {
    const receipt = store.get(input.creation_id);
    if (!receipt) return undefined;
    if (receipt.input_hash !== hash) throw new RpcError('conflict', 'This save belongs to different event details. Open a new event form.', 409);
    if (!receipt.source_id) return unknown();
    // A completed request is a read, so it remains recoverable if write access
    // was revoked after the save. It must still refer to the same connection.
    if (deps.instances.getIncarnation?.('calendar', input.slug) !== input.expected_incarnation) changed();
    return { slug: input.slug, snapshot: getCalendarEvent(deps, { slug: input.slug, source_id: receipt.source_id }),
      ...(input.send_invitations ? { invitations_requested: true as const } : {}) };
  };
  const prior = priorResult();
  if (prior) return prior;
  binding();
  if (!collection.provider.listWritableCalendars) throw new RpcError('forbidden', 'Event creation is unavailable for this calendar.', 403);
  const calendars = await collection.provider.listWritableCalendars();
  binding();
  const destination = calendars.find(cal => cal.calendar_id === input.calendar_id);
  if (!destination) throw new RpcError('forbidden', 'This calendar is no longer writable. Reload calendars and choose another.', 403);
  if (input.send_invitations && (collection.provider.kind === 'local' || destination.can_invite !== true)) {
    throw new RpcError('forbidden', 'This calendar cannot send guest invitations here. Reload calendars and choose a calendar that supports invitations.', 403);
  }
  if (!store.claim(input.creation_id, hash, (deps.now ?? Date.now)())) return priorResult()!;
  let source: string;
  try {
    const created = await handleCalendarCreate(deps, { slug: input.slug, calendar_id: input.calendar_id,
      event: { calendar_id: input.calendar_id, summary: input.summary, description: input.description, location: input.location,
        start_at: input.start_at, end_at: input.end_at, timezone: input.timezone, is_all_day: input.is_all_day, status: 'confirmed',
        ...(input.guests?.length ? { attendees: input.guests.map(guest => ({ ...guest, response_status: 'needs_action' as const })),
          send_invitations: true as const } : {}) },
      beforeSend: binding,
    });
    source = created.source_id;
    const attendees = collection.table.get(source)?.event.attendees ?? [];
    if (input.guests?.some(guest => !attendees.some(attendee => attendee.email.trim().toLowerCase() === guest.email))) return unknown();
    store.complete(input.creation_id, hash, source);
  } catch { return unknown(); }
  return { slug: input.slug, snapshot: getCalendarEvent(deps, { slug: input.slug, source_id: source }),
    ...(input.send_invitations ? { invitations_requested: true as const } : {}) };
};

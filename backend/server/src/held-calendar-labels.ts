/** D-336 (spec §52) — how the owner knows the event a held calendar change acts on: its title
 *  and when it is, and, on a Google event with guests, that Google emails them. A change asks
 *  Google to (spec §48), as the owner's own edit does; Outlook and a CalDAV server tell guests
 *  themselves. Chat's held `calendar.update` said so (`calendarAskLabels`); a recipe's held
 *  `calendar-update` or `calendar-delete` step, the same change, did not. */

import type { CollectionRegistry } from './collections/registry.js';
import type { Collection } from './collections/types.js';
import type { CalendarCollection } from './collections/calendar/calendar-collection.js';
import { eventWhenOnTurnClock } from './chat-clock.js';

const isCalendarCollection = (c: Collection): c is CalendarCollection =>
  'table' in c && (c as Partial<CalendarCollection>).table !== undefined;

/** The event's label on an approval, or undefined where the calendar or the event is not
 *  known, or the event has no title: the id then reads as passed. `zone` is the clock its
 *  time is said on; absent, the title alone. */
export const calendarEventApprovalLabel = (
  registry: Pick<CollectionRegistry, 'list'> | undefined,
  slug: string,
  source_id: string,
  zone: string | undefined,
): string | undefined => {
  const calendar = registry?.list()
    .filter(isCalendarCollection).find((collection) => collection.slug === slug);
  const event = calendar?.table.get(source_id)?.event;
  const summary = typeof event?.summary === 'string' ? event.summary.trim() : '';
  if (summary.length === 0) return undefined;
  const when = eventWhenOnTurnClock(event, zone);
  const label = when === undefined ? summary : `${summary}, ${when}`;
  const guests = calendar?.provider?.kind === 'gcal'
    ? (event?.attendees ?? []).filter((attendee) => attendee.is_self !== true).length
    : 0;
  return guests === 0 ? label
    : `${label} (Google emails ${guests === 1 ? 'its guest' : `its ${guests} guests`})`;
};

/** The recipe steps that change one calendar event, by their built-in ingredient. */
const CALENDAR_EVENT_CHANGES: ReadonlySet<string> = new Set(['calendar-update', 'calendar-delete']);

/** A held recipe step's labels for the event it changes, read off its input (`slug`,
 *  `source_id`), for an approval's `value_labels`. Undefined for any other step. */
export const heldCalendarValueLabels = (
  ingredient_slug: string | undefined,
  input: unknown,
  describe: ((slug: string, source_id: string) => string | undefined) | undefined,
): Record<string, Record<string, string>> | undefined => {
  if (describe === undefined || ingredient_slug === undefined) return undefined;
  if (!CALENDAR_EVENT_CHANGES.has(ingredient_slug.replace(/^recued\//, ''))) return undefined;
  if (input === null || typeof input !== 'object') return undefined;
  const { slug, source_id } = input as { slug?: unknown; source_id?: unknown };
  if (typeof slug !== 'string' || typeof source_id !== 'string' || source_id === '') return undefined;
  let label: string | undefined;
  try {
    label = describe(slug, source_id);
  } catch {
    // A calendar that cannot answer costs the label, never the hold.
    return undefined;
  }
  return label === undefined ? undefined : { source_id: { [source_id]: label } };
};

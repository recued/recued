import { collectionSourceFreshnessOf, type LinkedCalendarEvent, type LinkedCalendarPage, type SavedWorkAddress } from '@recued/contracts';
import type { CollectionInstanceStore } from '../instance-store.js';
import type { CalendarCollection } from './calendar-collection.js';

/** Read the retained calendar index only; listing incoming links never contacts
 * a provider. Each account remains separately addressable, including repeats. */
export const readCalendarMailLinks = (
  stack: { instances: Pick<CollectionInstanceStore, 'list' | 'getIncarnation'>;
    listLive(): Array<Pick<CalendarCollection, 'slug' | 'table' | 'health'>> },
  target: SavedWorkAddress, limit: number, offset: number, now = Date.now(),
): LinkedCalendarPage => {
  const live = new Map(stack.listLive().map(collection => [collection.slug, collection]));
  const items: LinkedCalendarEvent[] = [], unavailable_sources: string[] = [];
  for (const instance of stack.instances.list('calendar')) {
    const calendar = live.get(instance.slug), incarnation = stack.instances.getIncarnation?.('calendar', instance.slug);
    if (!calendar || !incarnation) { unavailable_sources.push(instance.slug); continue; }
    try {
      const fresh = collectionSourceFreshnessOf(() => calendar.health(), now);
      for (const row of calendar.table.listMailLinks(target, offset + limit + 1)) {
        const event = row.event;
        items.push({ slug: instance.slug, incarnation, record_id: row.record_id, source_id: row.source_id,
          received_at: row.received_at, calendar_id: event.calendar_id, calendar_name: event.calendar_name || instance.slug,
          title: event.summary.trim().slice(0, 1024) || 'Untitled event', start_at: event.start_at, end_at: event.end_at,
          timezone: event.timezone, is_all_day: event.is_all_day, status: event.status, updated_at: row.modified_at,
          stale: instance.adapter_type !== 'local' && (fresh.stale || instance.auth_state !== 'healthy' || !instance.backfill_complete) });
      }
    } catch { unavailable_sources.push(instance.slug); }
  }
  items.sort((a, b) => b.updated_at - a.updated_at || a.slug.localeCompare(b.slug) || a.record_id.localeCompare(b.record_id));
  return { items: items.slice(offset, offset + limit), offset, more: items.length > offset + limit, unavailable_sources };
};

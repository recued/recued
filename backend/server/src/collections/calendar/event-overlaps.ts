/** Bounded owner read: retained events around a draft, with source freshness. */
import {
  DAY_MS, RpcError, collectionSourceFreshnessOf, eventSpanIn,
  type CalendarOverlapRequest, type CalendarOverlapResult, type CalendarRecordHotFields,
} from '@recued/contracts';
import type { CalendarDispatcherDeps } from './calendar-dispatcher.js';

const ROW_LIMIT = 200;
const PREVIEW_LIMIT = 12;
const invalid = (): never => { throw new RpcError('invalid_args', 'Choose a valid time range of up to one year and a time zone to check other events.', 400); };
const fingerprint = (event: Pick<CalendarRecordHotFields, 'ical_uid' | 'start_at' | 'end_at' | 'is_all_day'>): string | null => event.ical_uid?.trim()
  ? JSON.stringify([event.ical_uid, event.start_at, event.end_at, event.is_all_day]) : null;

export const readCalendarOverlaps = (
  deps: CalendarDispatcherDeps, input: CalendarOverlapRequest,
): CalendarOverlapResult => {
  if (!input || typeof input.is_all_day !== 'boolean' || typeof input.timezone !== 'string'
    || !input.timezone || input.timezone.length > 256
    || ![input.start_at, input.end_at].every(value => Number.isSafeInteger(value) && Math.abs(value) < 8.64e15 - 2 * DAY_MS)
    || input.end_at <= input.start_at || input.end_at - input.start_at > 366 * DAY_MS
    || input.is_all_day && (input.start_at % DAY_MS !== 0 || input.end_at % DAY_MS !== 0)) invalid();
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { invalid(); }
  const window = eventSpanIn(input, input.timezone);
  if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end <= window.start) invalid();
  const now = (deps.now ?? Date.now)();
  const result: CalendarOverlapResult = { start_at: input.start_at, end_at: input.end_at,
    is_all_day: input.is_all_day, timezone: input.timezone, checked_at: now, events: [], sources: [], truncated: false };
  let self: string | null = null;
  if (input.exclude !== undefined) {
    const ref = input.exclude;
    if (!ref || typeof ref.slug !== 'string' || !ref.slug || ref.slug.length > 256
      || typeof ref.source_id !== 'string' || !ref.source_id || ref.source_id.length > 4096
      || typeof ref.expected_incarnation !== 'string' || !ref.expected_incarnation || ref.expected_incarnation.length > 256) invalid();
    const row = deps.getCollection(ref.slug)?.table.get(ref.source_id);
    if (!row || deps.instances.getIncarnation?.('calendar', ref.slug) !== ref.expected_incarnation) {
      throw new RpcError('resource_changed', 'This event or calendar changed. Reload its details to check other events.', 409);
    }
    self = fingerprint(row.event);
  }
  const groups = new Map<string, CalendarOverlapResult['events'][number]>();
  for (const instance of deps.instances.list('calendar')) {
    const local = instance.adapter_type === 'local', name = local ? 'On this server' : instance.slug;
    const source: CalendarOverlapResult['sources'][number] = { slug: instance.slug, name,
      status: 'unavailable', last_synced_at: instance.last_synced_at };
    result.sources.push(source);
    try {
      const collection = deps.getCollection(instance.slug);
      if (!collection) continue;
      const fresh = collectionSourceFreshnessOf(() => collection.health(), now);
      const candidates = [false, true].flatMap(is_all_day => {
        // Floating all-day dates can lie on the other side of UTC midnight.
        // Read a padded date window, then compare real spans on the draft's clock.
        const from = window.start - (is_all_day ? 2 * DAY_MS : 0);
        const before = window.end + (is_all_day ? 2 * DAY_MS : 0);
        const rows = collection.table.list({ end_after: from, start_until: before, is_all_day,
          order_by: 'start_at', direction: 'asc', limit: ROW_LIMIT + 1 });
        if (rows.length > ROW_LIMIT) result.truncated = true;
        return rows.slice(0, ROW_LIMIT);
      }).filter(event => {
        if (event.status === 'cancelled' || instance.slug === input.exclude?.slug && event.source_id === input.exclude.source_id) return false;
        if (self && fingerprint(event) === self) return false;
        const span = eventSpanIn(event, input.timezone);
        return span.start < window.end && span.end > window.start;
      });
      source.status = local ? 'local' : fresh.stale || instance.auth_state !== 'healthy' || !instance.backfill_complete ? 'stale' : 'synced';
      source.last_synced_at = local ? null : fresh.last_success_at ?? instance.last_synced_at;
      for (const event of candidates) {
        const key = fingerprint(event) ?? JSON.stringify([instance.slug, event.source_id]);
        const label = name;
        const prior = groups.get(key);
        if (prior) { if (!prior.calendars.includes(label)) prior.calendars.push(label); continue; }
        groups.set(key, { summary: event.summary.trim().slice(0, 1024) || 'Untitled event', start_at: event.start_at,
          end_at: event.end_at, is_all_day: event.is_all_day, calendars: [label.slice(0, 1024)] });
      }
    } catch { source.status = 'unavailable'; }
  }
  const events = [...groups.values()].sort((a, b) => eventSpanIn(a, input.timezone).start - eventSpanIn(b, input.timezone).start || a.summary.localeCompare(b.summary));
  if (events.length > PREVIEW_LIMIT) result.truncated = true;
  result.events = events.slice(0, PREVIEW_LIMIT);
  return result;
};

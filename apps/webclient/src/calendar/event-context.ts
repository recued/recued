import type { CalendarEventRef, CalendarEventSnapshot } from '@recued/contracts';
import { serializeSourceRecordAddress } from '../shell/route.js';

/** Exact saved identity with labels for the composer, without an event snapshot. */
export interface SelectedCalendarEventContext {
  readonly slug: string;
  readonly sourceId: string;
  readonly recordId: string;
  readonly name: string;
  readonly calendarName: string;
  readonly incarnation?: string;
}

export const readSelectedCalendarEventContext = (raw: unknown): SelectedCalendarEventContext | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const identity = (key: string, limit: number): boolean => typeof value[key] === 'string'
    && (value[key] as string).trim().length > 0 && (value[key] as string).length <= limit
    && !/[\u0000-\u001f\u007f]/u.test(value[key] as string);
  const label = (key: string): boolean => typeof value[key] === 'string'
    && (value[key] as string).trim().length > 0 && (value[key] as string).length <= 2048;
  if (Object.keys(value).some(key => !['slug', 'sourceId', 'recordId', 'name', 'calendarName', 'incarnation'].includes(key))
    || !identity('slug', 256) || !identity('sourceId', 4096) || !identity('recordId', 4096)
    || !label('name') || !label('calendarName') || value.incarnation !== undefined && !identity('incarnation', 256)) return null;
  return { slug: value.slug as string, sourceId: value.sourceId as string, recordId: value.recordId as string,
    name: value.name as string, calendarName: value.calendarName as string,
    ...(typeof value.incarnation === 'string' ? { incarnation: value.incarnation } : {}) };
};

export const selectedCalendarEventContext = (ref: CalendarEventRef, snapshot: CalendarEventSnapshot): SelectedCalendarEventContext | null => {
  if (ref.source_id !== snapshot.event.source_id || snapshot.record.source_id !== ref.source_id
    || snapshot.record.record_id !== snapshot.event.record_id) return null;
  return readSelectedCalendarEventContext({ slug: ref.slug, sourceId: ref.source_id, recordId: snapshot.event.record_id,
    name: (snapshot.event.summary.trim() || 'Untitled event').slice(0, 2048),
    calendarName: (snapshot.event.calendar_name?.trim() || snapshot.event.calendar_id || 'Selected calendar').slice(0, 2048),
    ...(snapshot.incarnation ? { incarnation: snapshot.incarnation } : {}) });
};

export const calendarEventContextHref = (context: Pick<SelectedCalendarEventContext, 'slug' | 'recordId'>): string =>
  serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: context.slug, recordId: context.recordId });

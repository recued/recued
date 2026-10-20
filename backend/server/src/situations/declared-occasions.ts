import { createHash } from 'node:crypto';
import { assetDateAt, contactExcludedFromProactive, isContactAnnualDate,
  type OccasionInput, type SituationPlace, type SituationRef, type Sphere } from '@recued/contracts';
import type { ContactStore } from '../storage/contact-store.js';
import type { CalendarCollectionTable } from '../collections/calendar/calendar-table.js';

export const declaredOccasionId = (source: SituationRef): string => `occasion-${createHash('sha256').update(JSON.stringify([source.collection, source.id, source.field ?? null])).digest('hex')}`;
export const declaredOccasions = (deps: {
  contacts?: ContactStore;
  calendars(): ReadonlyArray<{ slug: string; table: Pick<CalendarCollectionTable, 'listSnapshots'> }>;
  timeZone(): string;
  now?(): number;
  place?(value: string): SituationPlace;
  sphere?(ref: SituationRef, source: string): Sphere | undefined;
}): OccasionInput[] => {
  const result: OccasionInput[] = [];
  if (deps.contacts) for (let cursor = ''; ;) {
    const page = deps.contacts.walkByEmail(cursor, 500); if (!page.length) break;
    for (const contact of page) {
      if (contactExcludedFromProactive(contact)) continue;
      const id = contact.contact_id ?? contact.email;
      for (const field of ['birthday', 'anniversary'] as const) {
        const value = contact[field]; if (!isContactAnnualDate(value)) continue;
        const source: SituationRef = { collection: 'contact', id, field };
        result.push({ id: declaredOccasionId(source), source, title: `${contact.name ?? contact.email} · ${field}`,
          class_id: field, month_day: value.slice(-5), people: [id], sphere: deps.sphere?.(source, `contact:${id}`), muted: false, rules: [] });
      }
    }
    cursor = page.at(-1)!.email;
  }
  const today = assetDateAt(deps.now?.() ?? Date.now(), deps.timeZone());
  for (const calendar of deps.calendars()) {
    type Snapshot = ReturnType<CalendarCollectionTable['listSnapshots']>[number];
    const all: Snapshot[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = calendar.table.listSnapshots({ order_by: 'start_at', limit: 500, offset }); all.push(...page); if (page.length < 500) break;
    }
    // A series is its master, never its UID: Graph gives each occurrence its own
    // iCalUId, which would make a new occasion every year.
    const seriesKey = (row: Snapshot) => JSON.stringify([row.hot.calendar_id, row.event.recurring_event_id ?? row.source_id]);
    const yearly = new Set(all.filter(row => /(?:^|;)FREQ=YEARLY(?:;|$)/u.test(row.event.recurrence_rule?.replace(/^RRULE:/u, '') ?? '')).map(seriesKey));
    for (const key of yearly) {
      const instances = all.filter(row => seriesKey(row) === key && row.hot.status !== 'cancelled'); if (!instances.length) continue;
      const day = (row: Snapshot) => assetDateAt(row.hot.start_at, row.hot.is_all_day ? 'UTC' : deps.timeZone());
      const next = instances.find(row => day(row) >= today); const row = next ?? instances.at(-1)!;
      const source: SituationRef = { collection: 'calendar', id: `${calendar.slug}:${row.record_id}` };
      // Only the provider/adapter's expanded instances decide the date. COUNT,
      // UNTIL, INTERVAL, moved occurrences and calendar exceptions are not
      // silently replaced by a home-grown every-year calculation.
      result.push({ id: declaredOccasionId({ collection: 'calendar', id: `${calendar.slug}:${key}` }), source,
        title: row.hot.summary, class_id: 'annual_calendar', month_day: day(row).slice(-5), source_next_on: next ? day(next) : null, people: [],
        ...(row.hot.location && deps.place ? { where: deps.place(row.hot.location) } : {}),
        sphere: deps.sphere?.(source, `calendar:${calendar.slug}:${row.hot.calendar_id}`), muted: false, rules: [] });
    }
  }
  return result;
};

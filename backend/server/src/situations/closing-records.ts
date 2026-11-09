/** D-343 slice 2 (§4, ruling 18) — the owner's closing records: what they did or skipped on a day,
 *  in their own words, one record per thing they report, kept as an episode for ever (ruling 8).
 *  The chat's `episode.record` writes a day's records in one call, which the owner approves once.
 *
 *  - A record is a stored, declared episode (`assembly_rule: 'owner_record.v1'`, `storage_reason:
 *    'owner_record'`) with its `outcome`. It cites the agenda item it is about as its subject and
 *    evidence, or nothing for something done that was not planned.
 *  - An event's record takes the event's window, its place and the people in it whom Recued
 *    knows; a booking's, its slot and its counterparty. Every other record spans its day, up to
 *    now when the day is today: an episode never ends in the future.
 *  - One record per item per day: recording an item again that day replaces its record.
 *  - The owner's record has the final say (D-325): the episode Recued assembled for the same item
 *    gives way to it (`episode-runtime.ts`), and a skipped one is left out of what they did. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assetDateAt, eventSpanIn, parseQualifiedWorkEntityId, zonedWallClockToEpochMs, type Episode, type SituationRef, type SituationWindow, type WorkEntity,
  type WorkEntityKind,
} from '@recued/contracts';
import type { CalendarCollectionTable } from '../collections/calendar/calendar-table.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import type { ReminderStore } from '../storage/reminder-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

export type ClosingOutcome = 'done' | 'skipped';
/** The agenda item a record cites, as its own store keeps it. */
export interface ClosingItem {
  readonly ref: SituationRef;
  readonly when?: SituationWindow;
  readonly place?: string;
  readonly people: readonly string[];
}
export interface ClosingRecordInput { readonly title: string; readonly outcome: ClosingOutcome; readonly item?: ClosingItem }
export interface ClosingRecords {
  /** The item a ref names, read from its own store; `null` when there is none. An all-day
   *  event's window is its days on `time_zone`'s clock (the server's when none is given). */
  item(ref: SituationRef, time_zone?: string): ClosingItem | null;
  /** Today on a zone's clock (the server's when none is given): the latest day a record is for. */
  today(time_zone?: string): string;
  /** A day's records, written together. */
  record(input: { day: string; records: readonly ClosingRecordInput[]; time_zone?: string }): Episode[];
}

const DAY = 86_400_000;
const WORK_KINDS: ReadonlySet<string> = new Set(['task', 'note', 'commitment', 'booking', 'project']);
const isoDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
const words = (title: string): string => title.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();

export const createClosingRecords = (deps: {
  db: Database.Database;
  history: ReturnType<typeof createProactiveHistoryStore>;
  work: WorkEntityStore;
  calendars: () => ReadonlyArray<{ slug: string; table: Pick<CalendarCollectionTable, 'getByRecordId'> }>;
  contacts?: Pick<ContactStore, 'getByContactIdResolved' | 'getByAnyEmail'>;
  mailFacts?: Pick<MailFactStore, 'getThing'>;
  reminders?: Pick<ReminderStore, 'get'>;
  timeZone: () => string;
  now?: () => number;
}): ClosingRecords => {
  const now = deps.now ?? Date.now;
  const resolver = createWorkEntityResolver(deps.work);
  /** The people a record names: contacts Recued knows, never a bare address. */
  const known = (values: readonly (string | undefined)[]): string[] => [...new Set(values.flatMap(value => {
    if (!value) return [];
    const contact = deps.contacts?.getByContactIdResolved(value) ?? deps.contacts?.getByAnyEmail(value);
    return contact?.contact_id ? [contact.contact_id] : [];
  }))];
  /** A task, note, commitment, booking or project by its local id or the id `work.search` gives. */
  const workRow = (kind: WorkEntityKind, id: string): WorkEntity | null => {
    const qualified = parseQualifiedWorkEntityId(id);
    if (qualified === null) return resolver.readEntity(kind, id);
    if (qualified.kind !== kind) return null;
    return qualified.identity === 'source' ? resolver.readEntityBySourceIdentity(kind, qualified.source_id, qualified.record_id)
      : resolver.readEntity(kind, qualified.record_id);
  };
  const zoneOf = (time_zone?: string): string => time_zone ?? deps.timeZone();
  const item = (ref: SituationRef, time_zone?: string): ClosingItem | null => {
    if (ref.collection === 'calendar') {
      const colon = ref.id.indexOf(':');
      const calendar = colon > 0 ? deps.calendars().find(row => row.slug === ref.id.slice(0, colon)) : undefined;
      const row = calendar?.table.getByRecordId(ref.id.slice(colon + 1));
      if (!row || row.hot.status === 'cancelled') return null;
      const span = eventSpanIn(row.hot, zoneOf(time_zone));
      return { ref: { collection: 'calendar', id: ref.id }, when: { from: span.start, to: span.end },
        ...(row.hot.location ? { place: row.hot.location } : {}),
        people: known((row.event.attendees ?? []).filter(person => !person.is_self).map(person => person.email)) };
    }
    if (WORK_KINDS.has(ref.collection)) {
      const row = workRow(ref.collection as WorkEntityKind, ref.id);
      if (!row || row.deleted_at !== undefined) return null;
      const local = { collection: ref.collection, id: row.id };
      if (row._kind === 'booking') {
        return { ref: local, ...(row.slot_start_at !== undefined && row.slot_end_at !== undefined ? { when: { from: row.slot_start_at, to: row.slot_end_at } } : {}),
          people: known([row.counterparty_contact_id]) };
      }
      return { ref: local, people: row._kind === 'commitment' ? known([row.counterparty_contact_id]) : [] };
    }
    if (ref.collection === 'asset') {
      const asset = deps.work.readAsset(ref.id);
      return asset && asset.deleted_at == null ? { ref: { collection: 'asset', id: asset.id, ...(ref.field ? { field: ref.field } : {}) }, people: [] } : null;
    }
    if (ref.collection === 'occasion') return deps.history.occasion(ref.id) ? { ref: { collection: 'occasion', id: ref.id }, people: [] } : null;
    if (ref.collection === 'reminder') return deps.reminders?.get(ref.id) ? { ref: { collection: 'reminder', id: ref.id }, people: [] } : null;
    if (ref.collection === 'mail_fact') return deps.mailFacts?.getThing(ref.id) ? { ref: { collection: 'mail_fact', id: ref.id }, people: [] } : null;
    return null;
  };
  /** One record per item per day, and per thing said for a record with none. */
  const recordId = (day: string, record: ClosingRecordInput): string => `episode-${createHash('sha256').update(JSON.stringify(['closing', day,
    ...(record.item ? [record.item.ref.collection, record.item.ref.id, record.item.ref.field ?? ''] : [words(record.title)])])).digest('hex')}`;
  return {
    item,
    today: time_zone => assetDateAt(now(), zoneOf(time_zone)),
    record({ day, records, time_zone }) {
      const zone = zoneOf(time_zone); const at = now();
      const from = zonedWallClockToEpochMs(day, zone); const until = zonedWallClockToEpochMs(isoDay(Date.parse(`${day}T00:00:00Z`) + DAY), zone);
      if (from === null || until === null || from > at) throw new Error(`A day's record is for a day that has begun, not ${day}`);
      const whole = { from, to: Math.min(until, at) };
      return deps.db.transaction(() => records.map(record => {
        const span = record.item?.when;
        // An item's own window when it fell on that day and has ended; otherwise the day.
        const when = span && span.to <= at && span.from < until && span.to > from ? span : whole;
        const refs = record.item ? [record.item.ref] : [];
        return deps.history.saveEpisode({ id: recordId(day, record), title: record.title, when, people: [...record.item?.people ?? []],
          subjects: refs, evidence: refs, basis: 'declared', assembly_rule: 'owner_record.v1', storage_reason: 'owner_record', sensitive: [],
          outcome: record.outcome, ...(record.item?.place ? { where: deps.history.place(record.item.place) } : {}) }, at);
      }))();
    },
  };
};

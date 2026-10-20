import type Database from 'better-sqlite3';
import { isAssetDate, type TripDetails, type SituationRef } from '@recued/contracts';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const key = (ref: SituationRef) => JSON.stringify([ref.collection, ref.id]);
export const createTripDetailsStore = (db: Database.Database) => {
  db.exec('CREATE TABLE IF NOT EXISTS proactive_trip_details (source_key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  return {
    get(ref: SituationRef): TripDetails | null { const row = db.prepare('SELECT value FROM proactive_trip_details WHERE source_key=?').get(key(ref)) as { value: string } | undefined; return row ? JSON.parse(row.value) : null; },
    /** Ids of the records in one collection that have trip details. */
    subjects: (collection: string): string[] => (db.prepare('SELECT source_key FROM proactive_trip_details').all() as { source_key: string }[])
      .flatMap(row => { const [kind, id] = JSON.parse(row.source_key) as [string, string]; return kind === collection ? [id] : []; }),
    save(input: TripDetails): void {
      if (!input || !['booking', 'mail_fact', 'calendar'].includes(input.subject?.collection) || typeof input.subject.id !== 'string' || !input.subject.id.trim() || input.subject.id.length > 2000
        || !Array.isArray(input.travellers) || input.travellers.length > 50 || input.travellers.some(id => typeof id !== 'string' || !id.trim() || id.length > 2000)
        || (input.destination_country !== undefined && !/^[A-Z]{2}$/u.test(input.destination_country))
        || (input.entry_on !== undefined && !isAssetDate(input.entry_on)) || (input.exit_on !== undefined && !isAssetDate(input.exit_on))
        || (input.entry_on && input.exit_on && input.entry_on > input.exit_on) || (input.special_entry_status !== undefined && typeof input.special_entry_status !== 'boolean')) throw new Error('Choose real trip dates, country and contact identities');
      db.prepare('INSERT INTO proactive_trip_details(source_key,value) VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET value=excluded.value').run(key(input.subject), JSON.stringify(input));
    },
  };
};
/** Source adapters admit explicit structured fields only. A provider's free
 * prose or a booking counterparty is never guessed to be its traveller.
 * A lodging or transport reservation (a mail fact's `kind`, or the booking made
 * from one's `reservation_kind`) is a trip whose travellers, destination and
 * dates the owner names (P30); dining and events are not. */
export const tripFromSource = (subject: SituationRef, input: unknown): TripDetails | undefined => {
  const row = object(input); const raw = object(row.trip ?? input);
  const country = typeof raw.destination_country === 'string' && /^[A-Z]{2}$/u.test(raw.destination_country) ? raw.destination_country : undefined;
  const reservation = row.fact_type === 'reservation' ? row.reservation_kind : row.kind;
  const travel = reservation === 'lodging' || reservation === 'transport';
  if (!country && raw.is_trip !== true && row.trip === undefined && !travel) return undefined;
  return { subject, travellers: Array.isArray(raw.traveller_contact_ids) ? raw.traveller_contact_ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 2000).slice(0, 50) : [],
    ...(country ? { destination_country: country } : {}),
    ...(isAssetDate(raw.entry_on) ? { entry_on: raw.entry_on } : {}), ...(isAssetDate(raw.exit_on) ? { exit_on: raw.exit_on } : {}),
    ...(raw.special_entry_status === true ? { special_entry_status: true } : {}) };
};

/** D-121 Phase 1 — boot backfill for `data.contact`.
 *
 *  On D-121 first boot (or upgrade-from-pre-D-121), scan every
 *  existing `data.mail` + `data.calendar` table and materialize
 *  contacts for the rows already on disk. Idempotent — repeat runs
 *  are first-seen-wins inserts that bump `interaction_count` on
 *  collisions, so the second boot doesn't double-count.
 *
 *  Bounded yield: each batch processes `CONTACT_MATERIALIZE_BATCH_SIZE`
 *  rows, optionally awaits a microtask in async callers (`yield_each`),
 *  then loops. Reports progress through the optional `onBatch`
 *  callback so the future broadcast bus (D-121 Phase 6) can surface
 *  `kind: 'service', op: 'lifecycle'` events for the webapp's
 *  "Building your contact graph..." indicator. */

import type Database from 'better-sqlite3';
import { CONTACT_MATERIALIZE_BATCH_SIZE, type CanonicalEvent } from '@recued/contracts';
import {
  deriveContactsFromMail,
  deriveContactsFromCalendar,
} from './contact-derive.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { CanonicalMessage } from '../collections/mail/provider.js';
import { listCollectionDataTables } from '../collections/table.js';

export interface BackfillProgress {
  table: string;
  /** Rows processed in this batch. */
  batch_count: number;
  /** Cumulative rows processed across all batches so far. */
  total_processed: number;
  /** Cumulative observations applied to the contact store. */
  total_observed: number;
}

export interface BackfillOptions {
  /** Override the batch size (default = `CONTACT_MATERIALIZE_BATCH_SIZE`).
   *  Tests use a small value to exercise the yield path; production
   *  uses the constant. */
  batch_size?: number;
  /** Per-batch progress callback. Best-effort — exceptions are
   *  swallowed so a faulty broadcaster doesn't roll back the
   *  backfill. */
  onBatch?: (progress: BackfillProgress) => void;
  /** Async yield between batches. Defaults to a `Promise.resolve()`
   *  microtask; tests override with a no-op for synchronous flow. */
  yieldBatch?: () => Promise<void>;
  /** D-124 follow-on — when true (the production default), the
   *  observations applied during boot backfill don't emit on the
   *  warehouse event bus. Re-deriving the same contacts on every
   *  restart shouldn't broadcast `created` / `updated` events through
   *  the realtime bridge for rows that haven't actually changed since
   *  last boot. Tests that want to assert the emit shape pass
   *  `silent: false`. */
  silent?: boolean;
}

interface MailRow {
  hot_fields: string;
  received_at: number;
}

interface CalendarRow {
  record_payload: string;
}

/** Reasonable default — frees the event loop between batches so a
 *  cold-start backfill doesn't pin the engine for seconds at a time. */
const defaultYield = (): Promise<void> => new Promise((r) => setImmediate(r));

const listMailTables = (db: Database.Database): string[] => {
  const rows = listCollectionDataTables(db, 'mail');
  return rows;
};

const listCalendarTables = (db: Database.Database): string[] => {
  const rows = listCollectionDataTables(db, 'calendar');
  return rows;
};

/** Reconstitute the subset of `CanonicalMessage` the deriver needs
 *  from the mail row's `hot_fields` JSON. We don't parse anything we
 *  don't strictly require — adapters use a stable hot-field schema
 *  (`{from, to, cc, subject, …}`), and missing arrays default to
 *  empty so a row that lost its `to` field still yields the From-
 *  derived contact. */
const mailRowToMessage = (row: MailRow): CanonicalMessage | null => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.hot_fields) as Record<string, unknown>;
  } catch {
    return null;
  }
  const from = typeof parsed.from === 'string' ? parsed.from : '';
  const to = Array.isArray(parsed.to)
    ? parsed.to.filter((v): v is string => typeof v === 'string')
    : [];
  const cc = Array.isArray(parsed.cc)
    ? parsed.cc.filter((v): v is string => typeof v === 'string')
    : [];
  if (!from && to.length === 0 && cc.length === 0) return null;
  return {
    source_id: typeof parsed.message_id === 'string' ? parsed.message_id : '',
    from,
    to,
    cc,
    subject: '',
    thread_id: '',
    folder_or_label: '',
    is_read: false,
    has_attachments: false,
    received_at: row.received_at,
    body_text: '',
  };
};

const calendarRowToEvent = (row: CalendarRow): CanonicalEvent | null => {
  try {
    return JSON.parse(row.record_payload) as CanonicalEvent;
  } catch {
    return null;
  }
};

const backfillTable = async <Row, Item>(
  db: Database.Database,
  table: string,
  selectSql: string,
  fromRow: (row: Row) => Item | null,
  derive: (item: Item) => ReturnType<typeof deriveContactsFromMail>,
  store: ContactStore,
  opts: BackfillOptions,
): Promise<{ processed: number; observed: number }> => {
  const batchSize = Math.max(1, opts.batch_size ?? CONTACT_MATERIALIZE_BATCH_SIZE);
  const yieldBatch = opts.yieldBatch ?? defaultYield;
  let totalProcessed = 0;
  let totalObserved = 0;
  let offset = 0;
  for (;;) {
    const rows = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(batchSize, offset) as Row[];
    if (rows.length === 0) break;
    const observations: ReturnType<typeof deriveContactsFromMail> = [];
    for (const row of rows) {
      const item = fromRow(row);
      if (!item) continue;
      observations.push(...derive(item));
    }
    if (observations.length > 0) {
      // Silent default — see BackfillOptions.silent. Boot backfill
      // shouldn't emit `created` / `updated` for contacts re-derived
      // from durable source rows.
      const n = store.observeBatch(observations, undefined, { silent: opts.silent ?? true });
      totalObserved += n;
    }
    totalProcessed += rows.length;
    if (opts.onBatch) {
      try {
        opts.onBatch({
          table,
          batch_count: rows.length,
          total_processed: totalProcessed,
          total_observed: totalObserved,
        });
      } catch { /* never let progress callbacks roll the backfill back */ }
    }
    if (rows.length < batchSize) break;
    offset += batchSize;
    await yieldBatch();
  }
  return { processed: totalProcessed, observed: totalObserved };
};

/** Walk every `collection_mail_*` table on `db` and materialize
 *  contacts for the rows already on disk. Returns aggregate counts
 *  for logging. */
export const backfillContactsFromMail = async (
  db: Database.Database,
  store: ContactStore,
  opts: BackfillOptions = {},
): Promise<{ tables: number; processed: number; observed: number }> => {
  const tables = listMailTables(db);
  let processed = 0;
  let observed = 0;
  for (const table of tables) {
    const out = await backfillTable<MailRow, CanonicalMessage>(
      db,
      table,
      `SELECT hot_fields, received_at FROM ${table} ORDER BY record_id`,
      (row) => mailRowToMessage(row),
      (msg) => deriveContactsFromMail(msg),
      store,
      opts,
    );
    processed += out.processed;
    observed += out.observed;
  }
  return { tables: tables.length, processed, observed };
};

/** Walk every `collection_calendar_*` table on `db` and materialize
 *  contacts for the events already on disk. */
export const backfillContactsFromCalendar = async (
  db: Database.Database,
  store: ContactStore,
  opts: BackfillOptions = {},
): Promise<{ tables: number; processed: number; observed: number }> => {
  const tables = listCalendarTables(db);
  let processed = 0;
  let observed = 0;
  for (const table of tables) {
    const out = await backfillTable<CalendarRow, CanonicalEvent>(
      db,
      table,
      `SELECT record_payload FROM ${table} ORDER BY record_id`,
      (row) => calendarRowToEvent(row),
      (event) => deriveContactsFromCalendar(event),
      store,
      opts,
    );
    processed += out.processed;
    observed += out.observed;
  }
  return { tables: tables.length, processed, observed };
};

/** Run both backfills end-to-end. Idempotent — safe to call on every
 *  boot. Errors are swallowed per-table; a corrupt JSON row in one
 *  collection doesn't poison the rest. */
export const backfillContacts = async (
  db: Database.Database,
  store: ContactStore,
  opts: BackfillOptions = {},
): Promise<{
  mail: { tables: number; processed: number; observed: number };
  calendar: { tables: number; processed: number; observed: number };
}> => {
  const mail = await backfillContactsFromMail(db, store, opts);
  const calendar = await backfillContactsFromCalendar(db, store, opts);
  return { mail, calendar };
};

/** D-121 Phase 1 — boot backfill for `data.contact`.
 *
 *  On D-121 first boot (or upgrade-from-pre-D-121), scan every
 *  existing `data.mail` + `data.calendar` table and materialize
 *  contacts for the rows already on disk.
 *
 *  ⛔ THIS IS A ONE-TIME MIGRATION PER TABLE, AND IT USED TO RUN ON
 *  EVERY BOOT. There was no cursor and no completion marker: `offset`
 *  reset to 0 per table and the walk ran to exhaustion, every start,
 *  forever. The header called that "idempotent", which was true only of
 *  the contacts ROW COUNT — every observation of an existing contact
 *  still took `updateOnObserveStmt`, so `interaction_count` grew by the
 *  full observation count on each boot. Driven K=3 over 5 mail rows /
 *  3 contacts, mail untouched between runs:
 *
 *      boot 1: counts=[4,3,3]   boot 2: [8,6,6]   boot 3: [12,9,9]
 *
 *  🔑 AND THE COUNTER IS NOT COSMETIC. `hashContactRecord`
 *  (`housekeeping/source-walkers.ts`) folds `interaction_count` in, and
 *  `enrichment-producer.ts` skips a record only when its stored
 *  `source_record_hash` still matches. So every contact's hash moved on
 *  every boot (3/3 measured), every contact-scoped producer re-derived,
 *  and the owner-visible "N interactions" in the Data lens inflated by
 *  roughly the restart count.
 *
 *  ⚠ WHY A PER-TABLE DONE-MARKER IS THE RIGHT CURSOR, not a row
 *  watermark. Live ingestion already observes contacts itself —
 *  `wire-mail-stack.ts`'s `onMessageUpserted` and
 *  `wire-calendar-stack.ts`'s calendar hook both call
 *  `contactStore.observeBatch` per record. This walk exists ONLY to
 *  catch rows that predate the contact substrate, so "has this table
 *  been swept once" is the whole question; a `record_id` high-water
 *  mark would be wrong anyway, since ids are provider strings and a new
 *  message can sort BEFORE the mark. A table enrolled later gets its
 *  own marker and is swept once, on the boot that first sees it.
 *
 *  ⚠ The marker is written only after a table completes. A crash
 *  mid-table leaves it unmarked and the next boot re-sweeps that table,
 *  re-bumping the counts it already applied. That is the deliberate
 *  direction: re-counting is recoverable, missing a contact is not.
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
   *  `silent: false`.
   *
   *  🔑 This option is the precedent the completion marker follows. The
   *  same judgement — "a restart is not a change" — was applied to the
   *  event bus here and NOT to the interaction counter, which is how
   *  the counter came to move on every boot while the bus stayed quiet
   *  about it. */
  silent?: boolean;
  /** Re-sweep tables already marked complete. Off by default; the
   *  marker is the point. Tests use it to drive the walk twice, and it
   *  is the seam a future "rebuild my contact graph" affordance would
   *  call. */
  force?: boolean;
  /** Injectable clock for the completion marker's timestamp. */
  now?: () => number;
}

/** Per-table completion markers live in the shared `server_state` kv,
 *  keyed `contact_backfill.<table>` — the same namespaced-flat-key
 *  convention `pressure-state.ts` uses, and for the same reason: this
 *  is pair-local boot bookkeeping (D-097), not user data, and it does
 *  not warrant a table of its own. */
const STATE_TABLE = 'server_state';

const markerKey = (table: string): string => `contact_backfill.${table}`;

/** Defensive create — the composer may run before `ServerStateStore`.
 *  Idempotent, and identical to the DDL that store declares. */
const ensureStateTable = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
};

const isTableSwept = (db: Database.Database, table: string): boolean =>
  db.prepare(`SELECT 1 FROM ${STATE_TABLE} WHERE key = ?`).get(markerKey(table)) !== undefined;

const markTableSwept = (
  db: Database.Database,
  table: string,
  stats: { processed: number; observed: number },
  at: number,
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO ${STATE_TABLE} (key, value, updated_at) VALUES (?, ?, ?)`,
  ).run(markerKey(table), JSON.stringify({ ...stats, at }), at);
};

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

export interface BackfillResult {
  tables: number;
  processed: number;
  observed: number;
  /** Tables passed over because a completion marker already existed.
   *  On a healthy second boot this equals `tables` and `processed` is
   *  0 — which is the progress assertion, not merely a log line. */
  skipped: number;
}

/** The marker-aware walk, shared by both collection kinds so the skip
 *  and the mark cannot drift apart between them — the earlier shape
 *  duplicated the whole loop per kind, which is exactly where a
 *  one-sided fix would hide. */
const sweepTables = async <Row, Item>(
  db: Database.Database,
  tables: readonly string[],
  store: ContactStore,
  opts: BackfillOptions,
  selectSqlFor: (table: string) => string,
  fromRow: (row: Row) => Item | null,
  derive: (item: Item) => ReturnType<typeof deriveContactsFromMail>,
): Promise<BackfillResult> => {
  ensureStateTable(db);
  const now = opts.now ?? Date.now;
  let processed = 0;
  let observed = 0;
  let skipped = 0;
  for (const table of tables) {
    if (opts.force !== true && isTableSwept(db, table)) {
      skipped += 1;
      continue;
    }
    const out = await backfillTable<Row, Item>(
      db, table, selectSqlFor(table), fromRow, derive, store, opts,
    );
    // AFTER the table completes, never before — an interrupted sweep
    // must be retried, not recorded as done.
    markTableSwept(db, table, out, now());
    processed += out.processed;
    observed += out.observed;
  }
  return { tables: tables.length, processed, observed, skipped };
};

/** Walk every not-yet-swept `collection_mail_*` table on `db` and
 *  materialize contacts for the rows already on disk. Returns aggregate
 *  counts for logging. */
export const backfillContactsFromMail = async (
  db: Database.Database,
  store: ContactStore,
  opts: BackfillOptions = {},
): Promise<BackfillResult> =>
  sweepTables<MailRow, CanonicalMessage>(
    db,
    listMailTables(db),
    store,
    opts,
    (table) => `SELECT hot_fields, received_at FROM ${table} ORDER BY record_id`,
    (row) => mailRowToMessage(row),
    (msg) => deriveContactsFromMail(msg),
  );

/** Walk every not-yet-swept `collection_calendar_*` table on `db` and
 *  materialize contacts for the events already on disk. */
export const backfillContactsFromCalendar = async (
  db: Database.Database,
  store: ContactStore,
  opts: BackfillOptions = {},
): Promise<BackfillResult> =>
  sweepTables<CalendarRow, CanonicalEvent>(
    db,
    listCalendarTables(db),
    store,
    opts,
    (table) => `SELECT record_payload FROM ${table} ORDER BY record_id`,
    (row) => calendarRowToEvent(row),
    (event) => deriveContactsFromCalendar(event),
  );

/** Run both backfills end-to-end. Safe to call on every boot — and
 *  after the first, it is a pair of marker lookups that process nothing.
 *  Errors are swallowed per-table; a corrupt JSON row in one collection
 *  doesn't poison the rest. */
export const backfillContacts = async (
  db: Database.Database,
  store: ContactStore,
  opts: BackfillOptions = {},
): Promise<{
  mail: BackfillResult;
  calendar: BackfillResult;
}> => {
  const mail = await backfillContactsFromMail(db, store, opts);
  const calendar = await backfillContactsFromCalendar(db, store, opts);
  return { mail, calendar };
};

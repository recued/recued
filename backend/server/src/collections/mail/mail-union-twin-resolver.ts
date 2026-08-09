/** D-139 P5 — cross-account `data.mail` exact-twin resolver.
 *
 *  `createMailTwinResolver` (D-184 Decision 2) joins CRM-email
 *  RFC822 Message-IDs against ONE `data.mail` `CollectionTable`. But
 *  `data.mail` is split one physical table per enrolled account
 *  (`collection_mail_<slug-hash>`), so the production resolver must span
 *  EVERY mail account — a Message-ID can live in any mailbox.
 *
 *  This builds a synthetic union `findByHotFieldIn` that fans the lookup
 *  across all `collection_mail_*` base tables (mirroring the established
 *  cross-account walk in `warehouse/contact-backfill.ts`), then feeds it
 *  to the existing `createMailTwinResolver` so the normalize + most-recent-
 *  wins dedup logic is shared (no second copy to drift).
 *
 *  Self-skips to an empty result when no mail accounts are enrolled — the
 *  resolver then leaves engagement rows at their as-ingested `body_state`
 *  (D-184 "Case 2"). */

import type Database from 'better-sqlite3';
import type { CollectionRecord } from '@recued/contracts';
import type { CollectionTable } from '../table.js';
import { listCollectionDataTables } from '../table.js';
import type { MailTwinResolver } from '../../storage/engagement-store.js';
import { createMailTwinResolver } from './mail-twin-resolver.js';

/** Filter key allowed into the `json_extract` path — identifier-only,
 *  matching `CollectionTable.findByHotFieldIn`'s `FILTER_KEY_PATTERN`. */
const FILTER_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface MailUnionRow {
  record_id: string;
  received_at: number;
  modified_at: number;
  hot_fields: string;
  size_bytes: number;
  source_id: string;
}

/** Enumerate the base `data.mail` data tables, excluding FTS5 artifacts
 *  (the virtual table + its `_data` / `_idx` / `_docsize` / `_config`
 *  shadows) and any other schema-drift table by matching the EXACT base
 *  name shape `collection_mail_<10-hex-hash>`.
 *
 *  This file had that predicate right while twenty-two other call sites
 *  open-coded the loose `LIKE` scan; it now shares the one helper so there is
 *  a single place to be right. */
const listMailDataTables = (db: Database.Database): string[] =>
  listCollectionDataTables(db, 'mail');

export const createMailUnionTwinResolver = (
  db: Database.Database,
): MailTwinResolver => {
  const unionTable: Pick<CollectionTable, 'findByHotFieldIn'> = {
    findByHotFieldIn: (field, values): CollectionRecord[] => {
      if (!FILTER_KEY_PATTERN.test(field)) {
        throw new Error(
          `mail-union findByHotFieldIn: invalid filter key '${field}'`,
        );
      }
      const wanted = Array.from(
        new Set(values.filter((v) => typeof v === 'string' && v.length > 0)),
      );
      if (wanted.length === 0) return [];
      const tables = listMailDataTables(db);
      if (tables.length === 0) return [];

      const placeholders = wanted.map(() => '?').join(', ');
      const merged: CollectionRecord[] = [];
      for (const table of tables) {
        // `table` comes from sqlite_master (not user input) — safe to
        // interpolate. Select exactly the columns `createMailTwinResolver`
        // observes plus the required CollectionRecord scalars.
        const rows = db
          .prepare(
            `SELECT record_id, received_at, modified_at, hot_fields, size_bytes, source_id
               FROM ${table}
              WHERE json_extract(hot_fields, '$.${field}') IN (${placeholders})`,
          )
          .all(...wanted) as MailUnionRow[];
        for (const r of rows) {
          merged.push({
            record_id: r.record_id,
            received_at: r.received_at,
            modified_at: r.modified_at,
            hot_fields: JSON.parse(r.hot_fields) as Record<string, unknown>,
            size_bytes: r.size_bytes,
            source_id: r.source_id,
          });
        }
      }
      // Re-impose the single-table ordering (`received_at DESC, record_id
      // DESC`) globally so the resolver's "first-seen wins" stays
      // "most-recent wins" across accounts.
      merged.sort(
        (a, b) =>
          b.received_at - a.received_at ||
          (a.record_id < b.record_id ? 1 : a.record_id > b.record_id ? -1 : 0),
      );
      return merged;
    },
  };
  return createMailTwinResolver(unionTable);
};

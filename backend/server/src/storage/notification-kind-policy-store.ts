/** D-269 step 2 — persistence for the per-kind notification policy.
 *
 *  One row per anchored kind, keyed on the kind itself so the table cannot hold
 *  two policies for one thing.
 *
 *  ⛔ `read()` FILLS IN THE DEFAULTS RATHER THAN RETURNING WHAT IS STORED, and
 *  that is the opposite of the timezone store's choice on purpose. There,
 *  "unset" is a state a caller must see — a wall-clock feature refuses to arm on
 *  it. Here there is nothing to refuse: every anchored kind HAS a policy the
 *  moment the feature exists, and the stored row is only the owner's deviation
 *  from it. A caller that had to remember the default would be a second place
 *  the 24h window lives. */

import type Database from 'better-sqlite3';
import {
  NOTIFICATION_ANCHORED_KINDS,
  defaultNotificationKindPolicy,
  type NotificationAnchoredKind,
  type NotificationKindPolicy,
} from '@recued/contracts';

interface Row {
  kind: string;
  enabled: number;
  offset_ms: number;
  updated_at: number;
}

export interface NotificationKindPolicyStore {
  /** Every anchored kind, stored value or default, in declaration order. */
  list(): NotificationKindPolicy[];
  /** One kind — stored value or default. Never null. */
  get(kind: NotificationAnchoredKind): NotificationKindPolicy;
  /** Upsert one kind. Fields left undefined keep their current effective value,
   *  so a caller can change the offset without restating `enabled`. */
  write(
    kind: NotificationAnchoredKind,
    patch: { enabled?: boolean; offset_ms?: number },
    now: number,
  ): NotificationKindPolicy;
}

export const ensureNotificationKindPolicySchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_kind_policy (
      kind                 TEXT PRIMARY KEY,
      enabled              INTEGER NOT NULL,
      offset_ms            INTEGER NOT NULL,
      -- ⚠ RETIRED 2026-09-13 (D-269 REV 15) and deliberately NOT dropped.
      -- Nothing reads or writes it; the DEFAULT fills it so inserts that omit it
      -- still satisfy NOT NULL. Kept because self-hosted has no deploy order: a
      -- downgraded binary still writing this column finds it, whereas a dropped
      -- column makes the downgrade fail outright. A dead column is a comment; a
      -- missing one is an outage.
      respects_quiet_hours INTEGER NOT NULL DEFAULT 1,
      updated_at           INTEGER NOT NULL
    )
  `);
  // ⛔ `CREATE TABLE IF NOT EXISTS` DOES NOT ADD A COLUMN TO AN EXISTING TABLE —
  // the reason this ALTER exists at all. It now backfills a column NOTHING READS
  // (retired in REV 15), and it stays for the downgrade direction only: a server
  // rolled back to a binary that still writes `respects_quiet_hours` must find
  // the column on a database this binary created. Removing the ALTER would make
  // the rollback fail on a fresh DB, which is a worse trade than a dead column.
  const columns = db.prepare(`PRAGMA table_info(notification_kind_policy)`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'respects_quiet_hours')) {
    db.exec(
      `ALTER TABLE notification_kind_policy
         ADD COLUMN respects_quiet_hours INTEGER NOT NULL DEFAULT 1`,
    );
  }
};

export const createNotificationKindPolicyStore = (
  db: Database.Database,
): NotificationKindPolicyStore => {
  ensureNotificationKindPolicySchema(db);

  const readStmt = db.prepare(`SELECT * FROM notification_kind_policy WHERE kind = ?`);
  const writeStmt = db.prepare(`
    INSERT INTO notification_kind_policy
      (kind, enabled, offset_ms, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(kind) DO UPDATE SET
      enabled = excluded.enabled,
      offset_ms = excluded.offset_ms,
      updated_at = excluded.updated_at
  `);

  const get = (kind: NotificationAnchoredKind): NotificationKindPolicy => {
    const row = readStmt.get(kind) as Row | undefined;
    if (!row) return defaultNotificationKindPolicy(kind);
    return {
      kind,
      enabled: row.enabled === 1,
      offset_ms: row.offset_ms,
      updated_at: row.updated_at,
    };
  };

  return {
    get,
    list: () => NOTIFICATION_ANCHORED_KINDS.map(get),
    write(kind, patch, now) {
      // ⚠ Merge over the EFFECTIVE value, not over the row: a kind that has
      // never been written has no row, and merging over nothing would write
      // `enabled: undefined` as the first stored value.
      const current = get(kind);
      const next: NotificationKindPolicy = {
        kind,
        enabled: patch.enabled ?? current.enabled,
        offset_ms: patch.offset_ms ?? current.offset_ms,
        updated_at: now,
      };
      writeStmt.run(
        kind, next.enabled ? 1 : 0, next.offset_ms,
        now,
      );
      return next;
    },
  };
};

/** D-173 P3 / D10 — `reception_inbox_subview` store.
 *
 *  The Reception Inbox is a VIEW over the D-157 gate's held
 *  `approval_required` operations (no stored row per held item — N.1).
 *  But reject / expire move an item OUT of the open view into a durable
 *  `Dismissed / Expired` SUBVIEW (D10) — the held op is consumed (its
 *  checkpoint is gone, its `ask` answered `'deny'`), so the open view no
 *  longer surfaces it; the subview is the only place that remembers it.
 *
 *  This is a tiny per-pair durable table — the concrete
 *  `ReceptionInboxSubviewStore` the inbox handler's deferred boot-wiring
 *  injects (the handler ships the interface + a unit-fake; the wire-step
 *  injects this SQLite-backed impl). It records the dismissal + supports
 *  the D10 `auto_cleanup_days` purge (which deletes subview rows AND, by
 *  construction, removes the only lingering pointer at the underlying
 *  sealed-PII reception row).
 *
 *  PII discipline (I-3). A subview row carries NO sealed visitor PII —
 *  only the `hold_id` (the held run's `Checkpoint.checkpoint_id`), the
 *  `source_record_ref` (the reception row id the dismissed item pointed
 *  at, for the open-on-demand reveal that no longer applies once
 *  dismissed), a free-text `reason`, and the timestamp. The sealed
 *  visitor PII lives in the reception source row (D-149-gated); the
 *  `auto_cleanup_days` purge of THAT row is its own retention sweep — this
 *  store's purge drops the subview pointer.
 *
 *  Spec: D-173 § D10 + N.1 (the inbox is a view; reject moves
 *  to the subview, not delete). */

import type Database from 'better-sqlite3';
import {
  isReceptionInboxTopTierKind,
  type ReceptionInboxTopTierKind,
} from '@recued/contracts';
import type { ReceptionInboxSubviewStore } from '../reception-inbox-handler.js';

const TABLE = 'reception_inbox_subview';

interface SubviewRow {
  hold_id: string;
  status: string;
  top_tier_kind: string;
  reason: string | null;
  source_record_ref: string;
  dismissed_at: number;
  door_contract_id: string | null;
}

/** Install the `reception_inbox_subview` table. Idempotent (`IF NOT
 *  EXISTS`); safe on every boot and from the store factory. Keyed on
 *  `hold_id` — a re-reject of the same hold overwrites in place (the hold
 *  is already consumed, so a second reject is a benign no-op restatement). */
export const ensureReceptionInboxSubviewStoreSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      hold_id           TEXT PRIMARY KEY,
      status            TEXT NOT NULL,
      top_tier_kind     TEXT NOT NULL DEFAULT 'commitment',
      reason            TEXT,
      source_record_ref TEXT NOT NULL,
      dismissed_at      INTEGER NOT NULL,
      door_contract_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS reception_inbox_subview_dismissed_at_idx
      ON ${TABLE} (dismissed_at DESC);
  `);
  // ⛔ The door index is created BELOW, after the additive-column block — NOT
  // here. `CREATE TABLE IF NOT EXISTS` SKIPS an existing table, so on any DB
  // created before `door_contract_id` the column does not exist yet at this
  // point, and indexing it here throws `no such column` — crashing the server on
  // boot for every existing install. Caught by the migration test; the ordering
  // is the fix.
  // `CREATE TABLE IF NOT EXISTS` skips an existing table, so a dev DB created
  // before `top_tier_kind` landed needs the additive column (pre-launch zero
  // installs — the `'commitment'` default is the legacy label, matching the
  // pre-fix subview behavior). Guarded by a PRAGMA check; mirrors the
  // annotation-store / link-table upgrade blocks.
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[]).map((c) => c.name),
  );
  if (!existing.has('top_tier_kind')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN top_tier_kind TEXT NOT NULL DEFAULT 'commitment'`);
  }
  // D-177 N.14.8 fork 3 — same additive shape as `top_tier_kind` above. NULLABLE
  // with no default on purpose: a pre-existing reject genuinely has no known
  // door, and a backfilled default would invent one. NULL therefore means
  // "unknown door", never "no door" — `countRejectsForDoor` filters on an
  // explicit id so those rows are counted for nobody rather than for everybody.
  if (!existing.has('door_contract_id')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN door_contract_id TEXT`);
  }
  // The door index, AFTER the column is guaranteed to exist on BOTH paths — a
  // fresh DB (the CREATE TABLE above declared it) and a migrated one (the ALTER
  // just added it). Unconditional + `IF NOT EXISTS`: putting it inside the
  // `if` would skip it forever on a fresh DB, where the column was never
  // missing. [[feedback_declared_is_not_backed]]
  db.exec(
    `CREATE INDEX IF NOT EXISTS reception_inbox_subview_door_idx
       ON ${TABLE} (door_contract_id, dismissed_at DESC)`,
  );
};

/** Narrow the persisted `status` string back to the closed union the
 *  handler's interface declares. A corrupt / unexpected value defaults to
 *  `'dismissed'` (the reject path is the only writer that isn't `expired`)
 *  rather than throwing — a single bad row must not crash the inbox list. */
const narrowStatus = (raw: string): 'dismissed' | 'expired' =>
  raw === 'expired' ? 'expired' : 'dismissed';

/** Narrow the persisted `top_tier_kind` back to the closed reception target
 *  union. A legacy / corrupt value defaults to `'commitment'` (the pre-fix
 *  label) rather than throwing — a single bad row must not crash the list. */
const narrowTopTierKind = (raw: string): ReceptionInboxTopTierKind =>
  isReceptionInboxTopTierKind(raw) ? raw : 'commitment';

export const createReceptionInboxSubviewStore = (
  db: Database.Database,
): ReceptionInboxSubviewStore => {
  ensureReceptionInboxSubviewStoreSchema(db);

  const recordStmt = db.prepare(
    `INSERT INTO ${TABLE}
       (hold_id, status, top_tier_kind, reason, source_record_ref, dismissed_at, door_contract_id)
       VALUES
       (@hold_id, @status, @top_tier_kind, @reason, @source_record_ref, @dismissed_at, @door_contract_id)
       ON CONFLICT (hold_id) DO UPDATE SET
         status            = excluded.status,
         top_tier_kind     = excluded.top_tier_kind,
         reason            = excluded.reason,
         source_record_ref = excluded.source_record_ref,
         dismissed_at      = excluded.dismissed_at,
         door_contract_id  = excluded.door_contract_id`,
  );
  const listStmt = db.prepare(
    `SELECT hold_id, status, top_tier_kind, reason, source_record_ref, dismissed_at, door_contract_id
       FROM ${TABLE}
       ORDER BY dismissed_at DESC LIMIT ?`,
  );
  const purgeStmt = db.prepare(`DELETE FROM ${TABLE} WHERE dismissed_at < ?`);
  // `status = 'dismissed'` ONLY — an `'expired'` row is the clock's doing, not
  // the owner's, and must never read as a rejection. A NULL door matches no id.
  const countRejectsStmt = db.prepare(
    `SELECT COUNT(*) AS count, MAX(dismissed_at) AS last_rejected_at
       FROM ${TABLE}
       WHERE door_contract_id = ? AND status = 'dismissed' AND dismissed_at >= ?`,
  );

  return {
    record(row) {
      recordStmt.run({
        hold_id: row.hold_id,
        status: row.status,
        top_tier_kind: row.top_tier_kind,
        reason: row.reason ?? null,
        source_record_ref: row.source_record_ref,
        dismissed_at: row.dismissed_at,
        door_contract_id: row.door_contract_id ?? null,
      });
    },
    list(limit) {
      const rows = listStmt.all(Math.max(0, Math.floor(limit))) as SubviewRow[];
      return rows.map((r) => ({
        hold_id: r.hold_id,
        status: narrowStatus(r.status),
        top_tier_kind: narrowTopTierKind(r.top_tier_kind),
        ...(r.reason !== null ? { reason: r.reason } : {}),
        source_record_ref: r.source_record_ref,
        dismissed_at: r.dismissed_at,
        ...(r.door_contract_id !== null ? { door_contract_id: r.door_contract_id } : {}),
      }));
    },
    countRejectsForDoor(door_contract_id, since_ms) {
      // An empty id would be a caller bug; refuse rather than count the world.
      if (door_contract_id.length === 0) return { count: 0 };
      const row = countRejectsStmt.get(door_contract_id, since_ms) as {
        count: number;
        last_rejected_at: number | null;
      };
      return {
        count: row.count,
        ...(row.last_rejected_at !== null ? { last_rejected_at: row.last_rejected_at } : {}),
      };
    },
    purgeOlderThan(cutoff_ms) {
      return purgeStmt.run(cutoff_ms).changes;
    },
  };
};

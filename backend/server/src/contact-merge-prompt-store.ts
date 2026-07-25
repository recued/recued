/** D-138 Phase 3 — `RemergePromptStore` SQLite-backed implementation.
 *
 *  This is the concrete store behind the `RemergePromptStore` interface —
 *  constructed in `wire-contact-store` and driven by the housekeeping cycle's
 *  A.10 pass. (The rpc handler's `not_configured` branch is only the dbless
 *  fallback: no db → no store.) Backing table `contact_remerge_prompt` is
 *  server-internal (no cross-cloud sync per D-097 / D-168), accessed only via
 *  this store + the `contact.merge.resolve_remerge_prompt` rpc.
 *
 *  Schema:
 *    id              TEXT PRIMARY KEY
 *    affected_email  TEXT NOT NULL   — canonical email of the row
 *                                       that lost a same-vendor link
 *    partner_email   TEXT NOT NULL   — canonical email of the rejected
 *                                       partner whose row gained one
 *    vendor          TEXT NOT NULL   — `hubspot` / `salesforce` / …
 *    fired_at        INTEGER NOT NULL — cycle close epoch ms
 *    resolved_at     INTEGER         — set when user dispatched
 *    resolution      TEXT            — `'remerge' | 'treat_as_deletion'`
 *
 *  Spec: D-138 § A.5 + § A.10. */

import type Database from 'better-sqlite3';
import {
  canonicalizeEmail,
  type RemergePromptRecord,
  type RemergePromptResolution,
} from '@recued/contracts';

import type {
  RemergePromptRow,
  RemergePromptStore,
} from './contact-merge-handler.js';

const PROMPT_TABLE = 'contact_remerge_prompt';

/** D-138 P3 — install schema. Idempotent: every statement uses
 *  `IF NOT EXISTS`. Safe to call on every boot. */
export const ensureRemergePromptSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROMPT_TABLE} (
      id              TEXT PRIMARY KEY,
      affected_email  TEXT NOT NULL,
      partner_email   TEXT NOT NULL,
      vendor          TEXT NOT NULL,
      fired_at        INTEGER NOT NULL,
      resolved_at     INTEGER,
      resolution      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_remerge_prompt_pending
      ON ${PROMPT_TABLE} (resolved_at, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_remerge_prompt_pair
      ON ${PROMPT_TABLE} (affected_email, partner_email, vendor);
  `);
};

interface RawRow {
  id: string;
  affected_email: string;
  partner_email: string;
  vendor: string;
  fired_at: number;
  resolved_at: number | null;
  resolution: RemergePromptResolution | null;
}

const rowToInternal = (row: RawRow): RemergePromptRow => ({
  id: row.id,
  affected_email: row.affected_email,
  partner_email: row.partner_email,
  vendor: row.vendor,
  fired_at: row.fired_at,
});

const rowToRecord = (row: RawRow): RemergePromptRecord => {
  const out: RemergePromptRecord = {
    id: row.id,
    affected_email: row.affected_email,
    partner_email: row.partner_email,
    vendor: row.vendor,
    fired_at: row.fired_at,
  };
  if (row.resolved_at !== null) out.resolved_at = row.resolved_at;
  if (row.resolution !== null) out.resolution = row.resolution;
  return out;
};

export interface RemergePromptInsertInput {
  id: string;
  /** Canonical email of the row that lost a same-vendor link. */
  affected_email: string;
  /** Canonical email of the rejected partner whose row gained one. */
  partner_email: string;
  vendor: string;
  fired_at: number;
}

/** D-138 P3 — extended interface beyond the P1 placeholder. The
 *  housekeeping cycle observer calls `record` to insert a prompt;
 *  Settings UI lists pending prompts via `pending`. */
export interface ServerRemergePromptStore extends RemergePromptStore {
  /** Insert a prompt row. Idempotent on
   *  `(affected_email, partner_email, vendor)` for unresolved rows —
   *  re-inserts within the same cycle window collapse onto the first
   *  insert (callers shouldn't re-fire, but the dedup makes the
   *  observer side cheap). */
  record(input: RemergePromptInsertInput): RemergePromptRow;
  /** Snapshot of every pending prompt (resolved_at IS NULL) for the
   *  Settings → Contacts UI. */
  pending(): RemergePromptRecord[];
}

export const createRemergePromptStore = (
  db: Database.Database,
): ServerRemergePromptStore => {
  ensureRemergePromptSchema(db);

  const insertStmt = db.prepare(
    `INSERT INTO ${PROMPT_TABLE}
       (id, affected_email, partner_email, vendor, fired_at,
        resolved_at, resolution)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  );
  const lookupExistingPendingStmt = db.prepare(
    `SELECT * FROM ${PROMPT_TABLE}
       WHERE affected_email = ?
         AND partner_email = ?
         AND vendor = ?
         AND resolved_at IS NULL
       LIMIT 1`,
  );
  const getStmt = db.prepare(`SELECT * FROM ${PROMPT_TABLE} WHERE id = ?`);
  const resolveStmt = db.prepare(
    `UPDATE ${PROMPT_TABLE}
        SET resolved_at = ?, resolution = ?
      WHERE id = ?`,
  );
  const pendingStmt = db.prepare(
    `SELECT * FROM ${PROMPT_TABLE}
        WHERE resolved_at IS NULL
        ORDER BY fired_at DESC`,
  );

  return {
    record(input: RemergePromptInsertInput): RemergePromptRow {
      const affected = canonicalizeEmail(input.affected_email);
      const partner = canonicalizeEmail(input.partner_email);
      if (!affected || !partner || affected === partner) {
        throw new Error(`remerge_prompt_invalid_pair: ${input.affected_email}, ${input.partner_email}`);
      }
      const vendor = input.vendor.trim();
      if (!vendor) {
        throw new Error(`remerge_prompt_invalid_vendor: '${input.vendor}'`);
      }
      // Dedup against any existing pending row for the same
      // `(affected, partner, vendor)` — same cycle observer firing
      // twice (e.g. the closer ran twice) collapses cleanly.
      const existing = lookupExistingPendingStmt.get(affected, partner, vendor) as
        | RawRow
        | undefined;
      if (existing) return rowToInternal(existing);
      insertStmt.run(input.id, affected, partner, vendor, input.fired_at);
      const row = getStmt.get(input.id) as RawRow | undefined;
      if (!row) {
        throw new Error(`remerge_prompt_persistence_failed: ${input.id}`);
      }
      return rowToInternal(row);
    },
    get(id: string): RemergePromptRow | null {
      const row = getStmt.get(id) as RawRow | undefined;
      if (!row) return null;
      // D-138 P3 (Codex review fix) — already-resolved prompts must
      // not be reprocessable. Returning null surfaces as `not_found`
      // through the rpc handler's existing `not_found` path; a
      // replayed `remerge_prompt` event therefore can't flip a
      // `treat_as_deletion` resolution into `remerge` (or vice
      // versa). Resolved rows still survive on disk for audit; the
      // pending() lookup gates them out separately.
      if (row.resolved_at !== null) return null;
      return rowToInternal(row);
    },
    resolve(id, resolution, resolved_at) {
      resolveStmt.run(resolved_at, resolution, id);
    },
    pending(): RemergePromptRecord[] {
      const rows = pendingStmt.all() as RawRow[];
      return rows.map(rowToRecord);
    },
  };
};

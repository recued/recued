/** D-192 F1 — the commitment-evidence proposal dedup ledger.
 *
 *  The capture producer consults this BEFORE firing a proposal: one
 *  row per `(full_target_id, field, value_hash)` evidence identity,
 *  written at propose time. Presence blocks re-proposal — so a
 *  re-fold of the SAME value never re-proposes, and a DECLINED
 *  proposal's evidence never re-proposes (the row persists; decline
 *  leaves it in place — the reception inbox's subview is keyed on the
 *  ephemeral hold_id and purges on a retention clock, so it cannot
 *  serve as this ledger). A CHANGED value is new evidence: a new
 *  `value_hash` → a new key → a fresh proposal.
 *
 *  Deliberately append-only at v1 — there is no un-propose. If real
 *  usage wants "ask me again", the owner edits the field to a new
 *  value (new evidence) or authors the commitment directly. */

import type Database from 'better-sqlite3';

import { fnv1aHex } from '../source-mirror/hash.js';

const LEDGER_TABLE = 'commitment_evidence_ledger';

export const ensureCommitmentEvidenceLedgerSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      dedup_key      TEXT PRIMARY KEY,
      full_target_id TEXT NOT NULL,
      field          TEXT NOT NULL,
      value_hash     TEXT NOT NULL,
      proposed_at    INTEGER NOT NULL
    );
  `);
};

/** The spec's dedup key: `(full_target_id, field, value_hash)` joined
 *  with the unit separator (the reconciler hash-tuple convention — a
 *  literal `\x1f` cannot appear in any component). */
export const commitmentEvidenceDedupKey = (
  full_target_id: string,
  field: string,
  value: string,
): { key: string; value_hash: string } => {
  const value_hash = `fnv1a:${fnv1aHex(value)}`;
  return {
    key: [full_target_id, field, value_hash].join('\x1f'),
    value_hash,
  };
};

export interface CommitmentEvidenceLedger {
  /** Claim an evidence identity. Returns true when this call inserted
   *  the row (the caller should propose); false when the identity was
   *  already claimed (already proposed — approved, declined, or
   *  pending; never re-propose). Atomic via INSERT OR IGNORE. */
  tryClaim(input: { full_target_id: string; field: string; value: string }, now: number): boolean;
  /** Release a claim whose proposal dispatch FAILED before it could be
   *  durably held (codex MEDIUM — a swallowed fire failure must not
   *  permanently consume the evidence identity; the next fold of the
   *  same value re-proposes). Only the failing claimer calls this —
   *  never a path that saw the proposal reach the gate. */
  release(input: { full_target_id: string; field: string; value: string }): void;
  /** Read-only probe (tests + diagnostics). */
  has(input: { full_target_id: string; field: string; value: string }): boolean;
}

export const createCommitmentEvidenceLedger = (
  db: Database.Database,
): CommitmentEvidenceLedger => {
  ensureCommitmentEvidenceLedgerSchema(db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${LEDGER_TABLE}
       (dedup_key, full_target_id, field, value_hash, proposed_at)
     VALUES (@dedup_key, @full_target_id, @field, @value_hash, @proposed_at)`,
  );
  const remove = db.prepare(`DELETE FROM ${LEDGER_TABLE} WHERE dedup_key = ?`);
  const probe = db.prepare(`SELECT 1 FROM ${LEDGER_TABLE} WHERE dedup_key = ?`);
  return {
    tryClaim(input, now) {
      const { key, value_hash } = commitmentEvidenceDedupKey(
        input.full_target_id,
        input.field,
        input.value,
      );
      const result = insert.run({
        dedup_key: key,
        full_target_id: input.full_target_id,
        field: input.field,
        value_hash,
        proposed_at: now,
      });
      return result.changes === 1;
    },
    release(input) {
      const { key } = commitmentEvidenceDedupKey(
        input.full_target_id,
        input.field,
        input.value,
      );
      remove.run(key);
    },
    has(input) {
      const { key } = commitmentEvidenceDedupKey(
        input.full_target_id,
        input.field,
        input.value,
      );
      return probe.get(key) !== undefined;
    },
  };
};

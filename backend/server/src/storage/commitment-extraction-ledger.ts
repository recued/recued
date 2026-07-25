/** D-192 email flagship E3 — the extraction→proposal dedup ledger.
 *
 *  The commitment-extraction funnel consults this BEFORE firing a held
 *  `commitment-propose` run for an extracted `TrackedCommitment`: one row
 *  per `commitment_id` (the D-139 content hash of the promise paraphrase +
 *  its primary source id, so re-extracting the SAME promise from the SAME
 *  source yields the SAME key). Presence blocks re-proposal — so the
 *  housekeeping `commitment_tracker` task re-running every idle cycle over
 *  an unchanged contact never re-floods the inbox, and a DECLINED proposal
 *  never re-proposes (the row persists; decline leaves it in place — the
 *  reception inbox's hold subview purges on a retention clock, so it cannot
 *  serve as this ledger).
 *
 *  Deliberately parallel to (NOT merged with) the F1
 *  `commitment-evidence-ledger.ts`: F1 keys on
 *  `(full_target_id, field, value_hash)` (a CRM field diff identity); the
 *  email flagship keys on the extraction's `commitment_id` (a
 *  paraphrase+source content hash). Two identity shapes → two tables.
 *
 *  Append-only at v1 — there is no un-propose. A commitment whose promise
 *  text or source changes hashes to a NEW `commitment_id` → a new key → a
 *  fresh proposal (the producer's own dedup already collapses re-extractions
 *  of an unchanged promise to the same id). */

import type Database from 'better-sqlite3';

const LEDGER_TABLE = 'commitment_extraction_ledger';

export const ensureCommitmentExtractionLedgerSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      commitment_id  TEXT PRIMARY KEY,
      subject_email  TEXT NOT NULL,
      proposed_at    INTEGER NOT NULL
    );
  `);
};

export interface CommitmentExtractionLedger {
  /** Claim a commitment_id. Returns true when this call inserted the row
   *  (the caller should propose); false when it was already claimed
   *  (already proposed — approved, declined, or pending; never
   *  re-propose). Atomic via INSERT OR IGNORE. */
  tryClaim(input: { commitment_id: string; subject_email: string }, now: number): boolean;
  /** Release a claim whose proposal dispatch FAILED before it could be
   *  durably held (mirrors the F1 ledger's `release`: a swallowed fire
   *  failure must not permanently consume the commitment identity; the
   *  next cycle's re-extraction re-proposes). Only the failing claimer
   *  calls this — never a path that saw the proposal reach the gate. */
  release(commitment_id: string): void;
  /** Read-only probe (tests + diagnostics). */
  has(commitment_id: string): boolean;
}

export const createCommitmentExtractionLedger = (
  db: Database.Database,
): CommitmentExtractionLedger => {
  ensureCommitmentExtractionLedgerSchema(db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${LEDGER_TABLE}
       (commitment_id, subject_email, proposed_at)
     VALUES (@commitment_id, @subject_email, @proposed_at)`,
  );
  const remove = db.prepare(`DELETE FROM ${LEDGER_TABLE} WHERE commitment_id = ?`);
  const probe = db.prepare(`SELECT 1 FROM ${LEDGER_TABLE} WHERE commitment_id = ?`);
  return {
    tryClaim(input, now) {
      const result = insert.run({
        commitment_id: input.commitment_id,
        subject_email: input.subject_email,
        proposed_at: now,
      });
      return result.changes === 1;
    },
    release(commitment_id) {
      remove.run(commitment_id);
    },
    has(commitment_id) {
      return probe.get(commitment_id) !== undefined;
    },
  };
};

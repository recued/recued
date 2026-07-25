/** D-192 messenger flagship M4 — the message→proposal dedup ledger.
 *
 *  The message-commitment funnel consults this BEFORE firing a held
 *  `commitment-propose` run for a MATCHED inbound chat message: one row per
 *  `message_id` (the bus event `record_id` — the vendor message id, or its
 *  sha256 digest when the vendor omits one). Presence blocks re-proposal — so
 *  a redelivered webhook / a message that matches several declared patterns /
 *  a listener that re-processes the same message never re-floods the inbox,
 *  and a DECLINED proposal never re-proposes (the row persists; decline leaves
 *  it in place — the reception inbox's hold subview purges on a retention
 *  clock, so it cannot serve as this ledger).
 *
 *  Deliberately parallel to (NOT merged with) the E3
 *  `commitment-extraction-ledger.ts` (keyed on the extraction `commitment_id`,
 *  a paraphrase+source content hash) and the F1
 *  `commitment-evidence-ledger.ts` (keyed on `(full_target_id, field,
 *  value_hash)`, a CRM field diff): a chat message's identity is its
 *  vendor message id, a third identity shape → a third table.
 *
 *  Append-only at v1 — there is no un-propose. A message id is stable, so the
 *  SAME message never re-proposes; an edited message arrives as a new vendor
 *  event (a new id, if the vendor emits one) → a fresh proposal. */

import type Database from 'better-sqlite3';

const LEDGER_TABLE = 'message_commitment_ledger';

export const ensureMessageCommitmentLedgerSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      message_id   TEXT PRIMARY KEY,
      vendor       TEXT NOT NULL,
      proposed_at  INTEGER NOT NULL
    );
  `);
};

export interface MessageCommitmentLedger {
  /** Claim a `message_id`. Returns true when this call inserted the row (the
   *  caller should propose); false when it was already claimed (already
   *  proposed — approved, declined, or pending; never re-propose). Atomic via
   *  INSERT OR IGNORE. */
  tryClaim(input: { message_id: string; vendor: string }, now: number): boolean;
  /** Release a claim whose proposal dispatch FAILED before it could be durably
   *  held (mirrors the E3 ledger's `release`: a swallowed fire failure must not
   *  permanently consume the message identity; a redelivery re-proposes). Only
   *  the failing claimer calls this — never a path that saw the proposal reach
   *  the gate. */
  release(message_id: string): void;
  /** Read-only probe (tests + diagnostics). */
  has(message_id: string): boolean;
}

export const createMessageCommitmentLedger = (db: Database.Database): MessageCommitmentLedger => {
  ensureMessageCommitmentLedgerSchema(db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${LEDGER_TABLE}
       (message_id, vendor, proposed_at)
     VALUES (@message_id, @vendor, @proposed_at)`,
  );
  const remove = db.prepare(`DELETE FROM ${LEDGER_TABLE} WHERE message_id = ?`);
  const probe = db.prepare(`SELECT 1 FROM ${LEDGER_TABLE} WHERE message_id = ?`);
  return {
    tryClaim(input, now) {
      const result = insert.run({
        message_id: input.message_id,
        vendor: input.vendor,
        proposed_at: now,
      });
      return result.changes === 1;
    },
    release(message_id) {
      remove.run(message_id);
    },
    has(message_id) {
      return probe.get(message_id) !== undefined;
    },
  };
};

/** D-234 § 234.4 — WHAT THE PEER SAID, WAITING FOR THE RUN THAT ASKED.
 *
 *  The asking run suspends into a `Checkpoint`. The peer's answer arrives later,
 *  on a different connection, in a different process possibly after a restart. It
 *  lands here keyed on the conversation, and the resumed op-step reads it.
 *
 *  🔑 THIS IS WHY RESUME NEEDS NO NEW ENGINE MECHANISM. `execute.ts` already
 *  documents that the gated step RE-RUNS on resume; the peer-ask op re-runs, finds
 *  a row here, and returns it as the step's result instead of pausing again.
 *  Idempotent-with-memory — the same shape as § 234.1's admission ceiling, which
 *  re-runs and finds the recorded decision.
 *
 *  ⛔⛔ NOT SINGLE-USE, AND THAT IS THE OPPOSITE OF `peer_admission_decisions`
 *  ON PURPOSE. An admission is consumed because admitting correspondence must
 *  stay a per-message judgment. An ANSWER is a FACT about one conversation: the
 *  run that asked may resume more than once (a later step gates for approval, a
 *  crash re-instantiates), and each time it re-runs the peer-ask step it must get
 *  the SAME answer. Consuming it would make the second resume pause forever
 *  waiting for a reply that already came — a hang with no error anywhere.
 *
 *  ⚠ ONE ROW PER `exchange_ref`, first write wins. A peer that answers twice does
 *  not get to change its mind after the fact: the run may already have acted on
 *  the first answer, and § 234.2's correlation admission is single-solicitation
 *  by the same reasoning.
 */
import type Database from 'better-sqlite3';

import type { PeerAnswer, PeerAskUnansweredReason } from '@recued/contracts';

export const PEER_ANSWER_TABLE = 'peer_answers';

/** Shared because peer-delivery refusal and answer insertion form one SQLite
 * arbitration. Both stores must be able to prepare a statement against the
 * answer table before either side has received its first message. */
export const ensurePeerAnswerTable = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PEER_ANSWER_TABLE} (
      exchange_ref       TEXT PRIMARY KEY,
      peer_contract_id   TEXT NOT NULL,
      answered           INTEGER NOT NULL,
      option             TEXT,
      note               TEXT,
      unanswered_because TEXT,
      at                 INTEGER NOT NULL
    );
  `);
};

export interface PeerAnswerRecord extends PeerAnswer {
  readonly exchange_ref: string;
  /** The contract that answered — recorded for the audit trail, never for
   *  matching. ⚠ The REF is the key; § 234.2 already established it is a lookup
   *  key and never a credential, and authority came from our own rows. */
  readonly peer_contract_id: string;
}

export interface PeerAnswerStore {
  /** First write wins. Returns false when a row already existed. */
  record(row: PeerAnswerRecord): boolean;
  /** What the resumed op-step reads. */
  get(exchange_ref: string): PeerAnswerRecord | null;
}

export const createPeerAnswerStore = (db: Database.Database): PeerAnswerStore => {
  ensurePeerAnswerTable(db);

  // When the outbox exists, an answer and a delivery refusal must claim the
  // exchange in mutually-exclusive single statements. SQLite serializes the
  // competing writers even when the daemon and stdio server use separate WAL
  // connections: either this INSERT lands first and refusal observes it, or
  // refusal lands first and this INSERT's WHERE clause observes the closed row.
  // Standalone/kernel-only answer stores have no outbox and retain the original
  // first-write-wins behavior.
  const hasOutboxArbiter = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'peer_ask_outbox'`,
  );

  // ⚠ `INSERT OR IGNORE`, not `REPLACE`: first write wins in ONE statement, so
  // two answers racing in cannot both believe they landed.
  const legacyInsert = db.prepare(
    `INSERT OR IGNORE INTO ${PEER_ANSWER_TABLE}
       (exchange_ref, peer_contract_id, answered, option, note, unanswered_because, at)
     VALUES (@exchange_ref, @peer_contract_id, @answered, @option, @note,
             @unanswered_because, @at)`,
  );
  let guardedInsert: Database.Statement | undefined;
  const select = db.prepare(
    `SELECT * FROM ${PEER_ANSWER_TABLE} WHERE exchange_ref = ?`,
  );

  return {
    record(row) {
      if (row.exchange_ref === '') {
        throw new Error('peer answer: exchange_ref is required — it is the only key');
      }
      // The answer store can be composed before the execute/outbox stack on a
      // second MCP process. Re-evaluate table presence at write time rather
      // than pinning that boot order forever; once the journal exists every
      // answer participates in the same SQLite compare-and-set as refusal.
      if (guardedInsert === undefined && hasOutboxArbiter.get() !== undefined) {
        guardedInsert = db.prepare(
          `INSERT OR IGNORE INTO ${PEER_ANSWER_TABLE}
             (exchange_ref, peer_contract_id, answered, option, note, unanswered_because, at)
           SELECT @exchange_ref, @peer_contract_id, @answered, @option, @note,
                  @unanswered_because, @at
            WHERE EXISTS (
              SELECT 1 FROM peer_ask_outbox
               WHERE exchange_ref = @exchange_ref
                 AND delivery_state IN ('pending', 'delivered')
            )`,
        );
      }
      return (guardedInsert ?? legacyInsert).run({
        exchange_ref: row.exchange_ref,
        peer_contract_id: row.peer_contract_id,
        answered: row.answered ? 1 : 0,
        option: row.option ?? null,
        note: row.note ?? null,
        unanswered_because: row.unanswered_because ?? null,
        at: row.at,
      }).changes > 0;
    },
    get(exchange_ref) {
      if (exchange_ref === '') return null;
      const r = select.get(exchange_ref) as {
        exchange_ref: string;
        peer_contract_id: string;
        answered: number;
        option: string | null;
        note: string | null;
        unanswered_because: string | null;
        at: number;
      } | undefined;
      if (r === undefined) return null;
      return {
        exchange_ref: r.exchange_ref,
        peer_contract_id: r.peer_contract_id,
        answered: r.answered === 1,
        at: r.at,
        ...(r.option !== null ? { option: r.option } : {}),
        ...(r.note !== null ? { note: r.note } : {}),
        ...(r.unanswered_because !== null
          ? { unanswered_because: r.unanswered_because as PeerAskUnansweredReason }
          : {}),
      };
    },
  };
};

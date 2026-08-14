/** D-234 § 234.1 — the durable answer to one peer-admission ask.
 *
 *  The ceiling (`peer_admission` on the mcp connection) can say `ask`. The owner
 *  answers once; the peer's NEXT call — a manual retry carrying its own live
 *  token — finds the decision here and is admitted or declined without asking
 *  again.
 *
 *  ⛔⛔ SINGLE-USE, AND THAT IS THE NON-LEARNABILITY RULE MADE MECHANICAL. An
 *  approval that persisted would be a LEARNED answer: the same message would run
 *  forever, and the entry ask exists precisely because admitting correspondence
 *  must stay a per-message judgment. `claim()` consumes the row in the same
 *  statement that reads it, so one approval admits exactly one run.
 *
 *  ⚠ A DECLINE IS CONSUMED THE SAME WAY, deliberately. It would be tempting to
 *  make "no" sticky, but that quietly becomes a per-message `refuse` the owner
 *  never wrote — and the ceiling already has a durable `refuse` state for people
 *  who mean it. Declining says "not this time".
 *
 *  ⚠ IDENTITY IS CONTENT, NOT THE REF. The key is `peerAdmissionIdentity` — a
 *  hash of the contract presented, the recipe asked for, and the canonical
 *  payload — computed HOST-SIDE. Keying on `exchange_ref` would be forgeable: it
 *  is caller-supplied by design so it can round-trip.
 */
import type { Database } from 'better-sqlite3';

import type { PeerAdmissionDecision } from '@recued/contracts';

const TABLE = 'peer_admission_decisions';

export interface PeerAdmissionRecord {
  readonly admission_identity: string;
  readonly decision: PeerAdmissionDecision;
  readonly contract_id: string;
  readonly recipe_id: string;
  readonly decided_at: number;
  /** The ask this answer came from — for the audit trail, never for matching. */
  readonly ask_id: string;
}

export interface PeerAdmissionStore {
  /** Record the owner's answer. Idempotent on identity: an at-least-once answer
   *  replay converges on one row rather than stacking admissions. */
  record(record: PeerAdmissionRecord): void;
  /** Read AND CONSUME the decision for this identity; `null` when none is
   *  pending. ⛔ One statement, so two concurrent retries of the same message
   *  cannot both be admitted. */
  claim(admission_identity: string): PeerAdmissionRecord | null;
  /** Non-consuming read — for surfaces that want to show what is pending. */
  peek(admission_identity: string): PeerAdmissionRecord | null;
  /** First caller reserves the one outstanding owner prompt for this message. */
  reserveAsk(admission_identity: string): boolean;
  /** Used only when durable prompt creation failed. */
  releaseAsk(admission_identity: string): void;
}

export const ensurePeerAdmissionSchema = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      admission_identity TEXT PRIMARY KEY,
      decision           TEXT NOT NULL,
      contract_id        TEXT NOT NULL,
      recipe_id          TEXT NOT NULL,
      decided_at         INTEGER NOT NULL,
      ask_id             TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS peer_admission_pending (
      admission_identity TEXT PRIMARY KEY
    );
  `);
};

const rowToRecord = (row: unknown): PeerAdmissionRecord | null => {
  if (row === null || row === undefined || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const decision = r.decision;
  // ⚠ A row whose decision is not one of the two admitted values is treated as
  // ABSENT, not as an accept. A malformed row must never be the thing that lets a
  // peer's message run.
  if (decision !== 'accepted' && decision !== 'declined') return null;
  return {
    admission_identity: String(r.admission_identity),
    decision,
    contract_id: String(r.contract_id),
    recipe_id: String(r.recipe_id),
    decided_at: Number(r.decided_at),
    ask_id: String(r.ask_id),
  };
};

export const createPeerAdmissionStore = (db: Database): PeerAdmissionStore => {
  ensurePeerAdmissionSchema(db);
  const insert = db.prepare(`
    INSERT INTO ${TABLE}
      (admission_identity, decision, contract_id, recipe_id, decided_at, ask_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(admission_identity) DO UPDATE SET
      decision = excluded.decision,
      decided_at = excluded.decided_at,
      ask_id = excluded.ask_id
  `);
  const select = db.prepare(`SELECT * FROM ${TABLE} WHERE admission_identity = ?`);
  // ⛔ RETURNING makes read-and-consume ONE statement. A read-then-delete pair
  // would let two concurrent retries of the same message both observe the row and
  // both be admitted — the peer acting twice on one approval.
  const take = db.prepare(
    `DELETE FROM ${TABLE} WHERE admission_identity = ? RETURNING *`,
  );
  const reserveAsk = db.prepare(
    `INSERT OR IGNORE INTO peer_admission_pending (admission_identity) VALUES (?)`,
  );
  const releaseAsk = db.prepare(
    `DELETE FROM peer_admission_pending WHERE admission_identity = ?`,
  );
  const recordDecision = db.transaction((record: PeerAdmissionRecord) => {
    insert.run(
      record.admission_identity,
      record.decision,
      record.contract_id,
      record.recipe_id,
      record.decided_at,
      record.ask_id,
    );
    releaseAsk.run(record.admission_identity);
  });

  return {
    record(record) {
      recordDecision(record);
    },
    claim(admission_identity) {
      return rowToRecord(take.get(admission_identity) ?? null);
    },
    peek(admission_identity) {
      return rowToRecord(select.get(admission_identity) ?? null);
    },
    reserveAsk(admission_identity) {
      if (admission_identity === '') return false;
      return reserveAsk.run(admission_identity).changes > 0;
    },
    releaseAsk(admission_identity) {
      if (admission_identity !== '') releaseAsk.run(admission_identity);
    },
  };
};

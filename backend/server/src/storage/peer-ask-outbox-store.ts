/** D-234 § 234.4 — THE ASKER'S SIDE OF AN OPEN CONVERSATION.
 *
 *  One row per question this server has sent and not yet had answered. It exists
 *  because an answer arriving from a peer has to be checked against something,
 *  and until now there was nothing on this side to check it against: the run was
 *  held, the checkpoint held `step_state`, and the ref existed only inside the
 *  hash that minted it.
 *
 *  🔑🔑 IT IS THE `offered` LIST THAT MAKES THIS NOT-OPTIONAL. `parsePeerAnswer`
 *  refuses an option we never offered — that is its whole point, because a peer
 *  that could name its own option would be choosing an outcome we never put in
 *  front of their owner. But the check needs the offered set, and the offered set
 *  lives in the authored step, behind a resolve. Recovering it from the
 *  checkpoint's recipe snapshot at answer time would re-derive authored args in a
 *  second place, differently — so it is recorded once, at the moment the question
 *  goes out, from the SAME resolved spec the wire payload was built from.
 *
 *  ⛔ AND IT IS WHAT MAKES "SOLICITED" DECIDABLE. No row ⇒ nobody here asked that
 *  question, and the answer is refused before it can resume anything. § 234.2
 *  already ruled the ref is a lookup key and never a credential; this is the
 *  lookup it is a key FOR.
 *
 *  ⚠ Not an audit surface. `ActivityEntry` (`peer_ask_*`, reserve-class) is the
 *  record of what happened; this is live state, deleted when the conversation
 *  closes. A row here means "still waiting" and nothing else — which is also what
 *  makes it the natural backing for § 234.4's "what am I waiting on, from whom,
 *  how long" surface. */
import type Database from 'better-sqlite3';

const TABLE = 'peer_ask_outbox';

/** One question sent, not yet answered. */
export interface PeerAskOutboxRow {
  /** The conversation id — derived, and the primary key. */
  readonly exchange_ref: string;
  /** The held run, so an answer can find the checkpoint to resume. */
  readonly run_id: string;
  /** The paused step. Re-instantiation starts here and the op re-runs. */
  readonly gated_step_id: string;
  /** The asker's own name for the peer connection. The answer must arrive from
   *  the contract THIS connection is bound to — that is the authentication. */
  readonly connection: string;
  readonly label: string;
  /** Exactly the option ids we put in front of their owner. */
  readonly offered: readonly string[];
  readonly deadline_at?: number;
  readonly created_at: number;
}

export interface PeerAskOutboxStore {
  /** Record an outstanding question. First write wins — a re-delivery of the
   *  same ref must not widen the offered set after the fact. */
  open(row: PeerAskOutboxRow): boolean;
  get(exchange_ref: string): PeerAskOutboxRow | null;
  /** Close the conversation. Returns false when nothing was open. */
  close(exchange_ref: string): boolean;
  /** Everything still waiting, oldest first — the "what am I waiting on" read. */
  list(): PeerAskOutboxRow[];
}

interface Raw {
  exchange_ref: string;
  run_id: string;
  gated_step_id: string;
  connection: string;
  label: string;
  offered_json: string;
  deadline_at: number | null;
  created_at: number;
}

const hydrate = (r: Raw): PeerAskOutboxRow => {
  // ⚠ TOLERANT ON READ. A row whose `offered_json` cannot be parsed yields an
  // EMPTY offered set, which makes `parsePeerAnswer` refuse every option rather
  // than accept any — the safe direction for a corrupted row.
  let offered: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.offered_json);
    if (Array.isArray(parsed)) offered = parsed.filter((o): o is string => typeof o === 'string');
  } catch { /* refuse-everything is the right failure here */ }
  return {
    exchange_ref: r.exchange_ref,
    run_id: r.run_id,
    gated_step_id: r.gated_step_id,
    connection: r.connection,
    label: r.label,
    offered,
    ...(r.deadline_at !== null ? { deadline_at: r.deadline_at } : {}),
    created_at: r.created_at,
  };
};

export const createPeerAskOutboxStore = (db: Database.Database): PeerAskOutboxStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      exchange_ref   TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL,
      gated_step_id  TEXT NOT NULL,
      connection     TEXT NOT NULL,
      label          TEXT NOT NULL,
      offered_json   TEXT NOT NULL,
      deadline_at    INTEGER,
      created_at     INTEGER NOT NULL
    );
  `);

  return {
    open(row) {
      // ⚠ `INSERT OR IGNORE`, matching `PeerAnswerStore`: first write wins in ONE
      // statement, so a re-delivery cannot race a second row in beside the first.
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO ${TABLE}
             (exchange_ref, run_id, gated_step_id, connection, label,
              offered_json, deadline_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.exchange_ref,
          row.run_id,
          row.gated_step_id,
          row.connection,
          row.label,
          JSON.stringify(row.offered),
          row.deadline_at ?? null,
          row.created_at,
        );
      return info.changes > 0;
    },
    get(exchange_ref) {
      if (exchange_ref === '') return null;
      const r = db
        .prepare(`SELECT * FROM ${TABLE} WHERE exchange_ref = ?`)
        .get(exchange_ref) as Raw | undefined;
      return r === undefined ? null : hydrate(r);
    },
    close(exchange_ref) {
      if (exchange_ref === '') return false;
      return db.prepare(`DELETE FROM ${TABLE} WHERE exchange_ref = ?`)
        .run(exchange_ref).changes > 0;
    },
    list() {
      return (db.prepare(`SELECT * FROM ${TABLE} ORDER BY created_at ASC`).all() as Raw[])
        .map(hydrate);
    },
  };
};

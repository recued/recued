/** Receiver-side idempotency anchor for peer questions.
 *
 * The sender owns `peer_ask_outbox`; this is the reciprocal receiver record.
 * It binds an authenticated peer + exchange ref to one cryptographically
 * random notification ask id before that ask is raised. A retry therefore
 * reuses the same durable ask capability, including across the crash window
 * between reserving the exchange and persisting the PendingAsk. */
import type Database from 'better-sqlite3';

const TABLE = 'peer_ask_inbox';

export type PeerAskInboxState = 'reserved' | 'raised';

export interface PeerAskInboxRow {
  readonly peer_contract_id: string;
  readonly exchange_ref: string;
  readonly request_fingerprint: string;
  /** Stable presentation name captured on first receipt. It is deliberately
   * outside the request fingerprint because a local connection rename must not
   * turn an exact peer retry into an exchange conflict. */
  readonly connection_name: string;
  readonly ask_id: string;
  readonly state: PeerAskInboxState;
  readonly created_at: number;
}

export interface PeerAskInboxReservation {
  readonly peer_contract_id: string;
  readonly exchange_ref: string;
  readonly request_fingerprint: string;
  readonly connection_name: string;
  readonly ask_id: string;
  readonly created_at: number;
}

export type PeerAskInboxReserveResult =
  | { readonly kind: 'created'; readonly row: PeerAskInboxRow }
  | { readonly kind: 'existing'; readonly row: PeerAskInboxRow }
  | { readonly kind: 'conflict'; readonly row: PeerAskInboxRow };

export interface PeerAskInboxStore {
  get(peer_contract_id: string, exchange_ref: string): PeerAskInboxRow | null;
  /** Composite-key first-write-wins reservation. */
  reserve(input: PeerAskInboxReservation): PeerAskInboxReserveResult;
  /** Marks that the matching PendingAsk is durable. Idempotent. */
  markRaised(
    peer_contract_id: string,
    exchange_ref: string,
    ask_id: string,
  ): 'marked' | 'already' | 'mismatch';
}

interface RawPeerAskInboxRow {
  peer_contract_id: string;
  exchange_ref: string;
  request_fingerprint: string;
  connection_name: string | null;
  ask_id: string;
  state: string;
  created_at: number;
}

const hydrate = (raw: RawPeerAskInboxRow): PeerAskInboxRow => ({
  peer_contract_id: raw.peer_contract_id,
  exchange_ref: raw.exchange_ref,
  request_fingerprint: raw.request_fingerprint,
  connection_name: raw.connection_name ?? raw.peer_contract_id,
  ask_id: raw.ask_id,
  state: raw.state === 'raised' ? 'raised' : 'reserved',
  created_at: raw.created_at,
});

export const createPeerAskInboxStore = (
  db: Database.Database,
): PeerAskInboxStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      peer_contract_id   TEXT NOT NULL,
      exchange_ref       TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      connection_name     TEXT,
      ask_id             TEXT NOT NULL,
      state              TEXT NOT NULL CHECK (state IN ('reserved', 'raised')),
      created_at         INTEGER NOT NULL,
      PRIMARY KEY (peer_contract_id, exchange_ref)
    );
  `);
  const hasConnectionName = (): boolean => (
    db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name?: unknown }>
  ).some((column) => column.name === 'connection_name');
  if (!hasConnectionName()) {
    try {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN connection_name TEXT`);
    } catch (error) {
      // The daemon and a stdio client can open the same older WAL together.
      // If the peer opener won this additive migration after our PRAGMA read,
      // the now-present column is the successful postcondition.
      if (!hasConnectionName()) throw error;
    }
  }

  const get = (
    peerContractId: string,
    exchangeRef: string,
  ): PeerAskInboxRow | null => {
    if (peerContractId.length === 0 || exchangeRef.length === 0) return null;
    const raw = db.prepare(
      `SELECT * FROM ${TABLE}
       WHERE peer_contract_id = ? AND exchange_ref = ?`,
    ).get(peerContractId, exchangeRef) as RawPeerAskInboxRow | undefined;
    return raw === undefined ? null : hydrate(raw);
  };

  return {
    get,
    reserve(input) {
      if (
        input.peer_contract_id.length === 0
        || input.exchange_ref.length === 0
        || input.request_fingerprint.length === 0
        || input.connection_name.length === 0
        || input.ask_id.length === 0
      ) {
        throw new Error('peer ask inbox reservation fields must be non-empty');
      }
      const inserted = db.prepare(
        `INSERT OR IGNORE INTO ${TABLE}
           (peer_contract_id, exchange_ref, request_fingerprint, connection_name, ask_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
      ).run(
        input.peer_contract_id,
        input.exchange_ref,
        input.request_fingerprint,
        input.connection_name,
        input.ask_id,
        input.created_at,
      ).changes > 0;
      const row = get(input.peer_contract_id, input.exchange_ref);
      if (row === null) {
        throw new Error('peer ask inbox reservation disappeared after insert');
      }
      if (inserted) return { kind: 'created', row };
      return row.request_fingerprint === input.request_fingerprint
        ? { kind: 'existing', row }
        : { kind: 'conflict', row };
    },
    markRaised(peerContractId, exchangeRef, askId) {
      if (peerContractId.length === 0 || exchangeRef.length === 0 || askId.length === 0) {
        return 'mismatch';
      }
      const info = db.prepare(
        `UPDATE ${TABLE}
         SET state = 'raised'
         WHERE peer_contract_id = ? AND exchange_ref = ? AND ask_id = ?
           AND state = 'reserved'`,
      ).run(peerContractId, exchangeRef, askId);
      if (info.changes > 0) return 'marked';
      const existing = get(peerContractId, exchangeRef);
      return existing?.ask_id === askId && existing.state === 'raised'
        ? 'already'
        : 'mismatch';
    },
  };
};

/** D-348 — the evidence chains are learned from, kept in the server's database.
 *
 *  Seven tables. `chain_requests`: one row per request in the owner's chats (the app's chat or a
 *  messenger chat), its key (its words, normalized and hashed: Q2), its occasion (the conversation
 *  and the UTC day, as D-329 counts one) and its words, sealed. `chain_turns`: each turn that is
 *  part of a request; a continuation that carries a held call's conversation on (D-337) is part of
 *  the request that made the call. `chain_runs`: each run a request's turn held for approval.
 *  `chain_calls`: each held call answered, its signature (sealed), the answer, and how it ended.
 *  `chain_undos`: each change a held run made that the owner undid later, and when (Q4).
 *  `chain_unheld_refs`: a chat's own call, or a run a request's turn started, that a permission let
 *  through without a hold, by its id, with its request's key and never its words; and
 *  `chain_unheld_undos`: each change one of them made that the owner undid, and when (Q4, §7.8).
 *
 *  🔑 WHY ITS OWN AND NOT D-214'S CASES. A case leaves out messenger chats, keeps no arguments, and
 *  has no "not sure it finished"; Q5 rules messenger chats in, Q3 pins recipients and records, and
 *  Q4 resets on an unsure outcome. These rows are written from the same independent sources a case
 *  reads (the owner's answer, the run's outcome), never from the model's word.
 *
 *  ⚠ LEARNING NEVER COSTS THE WORK. Every writer here is best effort: a row not kept is a chain
 *  not learned (the next call asks), never a call that fails. */

import type Database from 'better-sqlite3';
import {
  base64ToBytes,
  bytesToBase64,
  decodeCiphertext,
  decrypt,
  encodeCiphertext,
  encrypt,
} from '@recued/crypto';
import {
  chainCallSignatureHash,
  chainRequestKeyHash,
  normalizeChainRequestWords,
  type ChainCallAnswer,
  type ChainCallOutcome,
  type ChainCallSignature,
} from '@recued/contracts';

/** The chat sub-key, as the chat store and D-214's span store take it. `null` while the vault is
 *  locked; absent (no provider wired) ⇒ base64 only, the dbless-harness discipline. */
export type ChainEvidenceKeyProvider = () => Uint8Array | null;

export interface ChainEvidenceStore {
  /** The owner's request that opened a turn. Its turn joins it at once (synchronously), so a call
   *  the turn holds, and a continuation of it, find it; the sealed row is written after. Undefined
   *  when its words are empty once normalized: such a request learns nothing. */
  openRequest(input: {
    readonly request_id: string;
    readonly session_id: string;
    readonly words: string;
    readonly occasion: string;
    readonly at: number;
  }): Promise<{ readonly key_hash: string } | undefined>;
  /** A turn that is part of a request (a continuation, D-337). */
  joinTurn(turn_id: string, request_id: string): void;
  requestOfTurn(turn_id: string): string | undefined;
  /** A kept request's key: the one its turns' calls are matched under (slice 4). */
  keyOfRequest(request_id: string): string | undefined;
  /** A run a request's turn held for the owner's approval. */
  heldRun(input: { readonly run_id: string; readonly request_id: string; readonly at: number }): void;
  requestOfRun(run_id: string): string | undefined;
  /** The owner's answer to a held call of a request's run. Its first answer is kept: one told twice
   *  changes nothing. `signature` absent ⇒ a call that cannot be named: it is no evidence for any
   *  chain, but a refusal of it still spoils its occasion. A run no request held is not kept. */
  recordAnswer(input: {
    readonly checkpoint_id: string;
    readonly run_id: string;
    readonly signature?: ChainCallSignature;
    readonly answer: ChainCallAnswer;
    readonly at: number;
  }): Promise<boolean>;
  /** A held run settled: each approved call of it that has no outcome yet takes this one. */
  runSettled(run_id: string, outcome: ChainCallOutcome, at: number): void;
  /** The owner undid a change a held run made (Q4), at `at`: kept apart from how its call ended,
   *  with its own time, since it may come up to 30 days later and nothing before it counts. Kept
   *  once per change (its receipt). Undefined for a run no request held; else the request's key and
   *  the call that made the change, for a live rule that holds it to end. */
  runUndone(input: {
    readonly run_id: string;
    readonly receipt_id: string;
    /** The hold the change was approved on, when the change names it. */
    readonly checkpoint_id?: string;
    readonly at: number;
  }): ChainUndone | undefined;
  /** A chat's own call, or a run the turn started, that no hold recorded: noted with its
   *  request's key, so an undo of a change it made resets the request (Q4). The first note holds. */
  unheldRef(input: {
    /** The call's own row, or the run's id: what a change's receipt names it by. */
    readonly ref: string;
    readonly key_hash: string;
    readonly session_id: string;
    readonly at: number;
  }): void;
  /** The owner undid a change such a call or run made, at `at`: kept once per change (its
   *  receipt). Undefined when nothing was noted for it: no request of the owner's chats made it. */
  unheldUndone(input: {
    readonly ref: string;
    readonly receipt_id: string;
    readonly at: number;
  }): { readonly key_hash: string } | undefined;
  /** Forget a conversation: its requests and every turn, run, call and undo they hold (the owner's
   *  words and whom the calls reached went with the conversation). Returns the requests removed. */
  deleteSession(session_id: string): number;
}

/** An undo of a change a held run made, as kept. */
export interface ChainUndone {
  /** The key of the request the run was held for; absent when its row was not kept. */
  readonly key_hash?: string;
  /** The signature of the call that made the change: the call held at its checkpoint, or, when the
   *  change names none, the run's one approved call. Empty when it is neither (a run of several, or
   *  a call no chain can name). */
  readonly signature_hashes: readonly string[];
}

/** Seal and open what the owner reads back: the words, a call, a rule's display. Each is bound to its
 *  row (`kind`, `id`). */
export interface ChainSealing {
  seal(kind: ChainSealedKind, id: string, text: string): Promise<string>;
  open(kind: ChainSealedKind, id: string, blob: string): Promise<string>;
}

export class ChainEvidenceVaultLockedError extends Error {
  constructor(detail: string) {
    super(`chain-evidence-store: the server's FileVault is locked, cannot ${detail}`);
    this.name = 'ChainEvidenceVaultLockedError';
  }
}

export const ensureChainEvidenceSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_requests (
      request_id       TEXT PRIMARY KEY,
      key_hash         TEXT NOT NULL,
      occasion         TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      words_encrypted  TEXT NOT NULL,
      at               INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chain_requests_key ON chain_requests (key_hash, at);
    CREATE TABLE IF NOT EXISTS chain_turns (
      turn_id     TEXT PRIMARY KEY,
      request_id  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chain_runs (
      run_id      TEXT PRIMARY KEY,
      request_id  TEXT NOT NULL,
      at          INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chain_calls (
      checkpoint_id        TEXT PRIMARY KEY,
      run_id               TEXT NOT NULL,
      request_id           TEXT NOT NULL,
      signature_hash       TEXT,
      signature_encrypted  TEXT,
      is_delete            INTEGER NOT NULL DEFAULT 0,
      answer               TEXT NOT NULL CHECK (answer IN ('approved', 'approved_changed', 'refused')),
      -- 'undone' is never written: an undo is kept in chain_undos, with its own time.
      outcome              TEXT CHECK (outcome IN ('ran', 'failed', 'unknown', 'undone')),
      at                   INTEGER NOT NULL,
      settled_at           INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chain_calls_request ON chain_calls (request_id);
    CREATE INDEX IF NOT EXISTS idx_chain_calls_run ON chain_calls (run_id);
    CREATE TABLE IF NOT EXISTS chain_undos (
      receipt_id  TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      request_id  TEXT NOT NULL,
      at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chain_undos_request ON chain_undos (request_id);
    -- §7.8: a request's change no hold recorded, a permission having let it through. Only the key:
    -- such a turn writes no request row, and its words are not kept for this.
    CREATE TABLE IF NOT EXISTS chain_unheld_refs (
      ref         TEXT PRIMARY KEY,
      key_hash    TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chain_unheld_refs_session ON chain_unheld_refs (session_id);
    CREATE TABLE IF NOT EXISTS chain_unheld_undos (
      receipt_id  TEXT PRIMARY KEY,
      ref         TEXT NOT NULL,
      key_hash    TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chain_unheld_undos_key ON chain_unheld_undos (key_hash, at);
    CREATE INDEX IF NOT EXISTS idx_chain_unheld_undos_session ON chain_unheld_undos (session_id);
  `);
};

/** What is sealed: a request's words, a call's signature, a rule's display (`chain-rule-store.ts`). */
export type ChainSealedKind = 'request' | 'call' | 'rule';

/** Each sealed value is bound to its row, so a value moved onto another row does not open. */
const aadOf = (kind: ChainSealedKind, id: string): Uint8Array =>
  new TextEncoder().encode(`recued/v1/d348/${kind}/${id}`);

export const createChainEvidenceStore = (
  db: Database.Database,
  getKey?: ChainEvidenceKeyProvider,
): ChainEvidenceStore & ChainSealing => {
  ensureChainEvidenceSchema(db);
  const seal = async (kind: ChainSealedKind, id: string, text: string): Promise<string> => {
    const plaintext = new TextEncoder().encode(text);
    if (getKey === undefined) return bytesToBase64(plaintext);
    const key = getKey();
    if (!key) throw new ChainEvidenceVaultLockedError(`seal a ${kind}`);
    return encodeCiphertext(await encrypt(key, plaintext, aadOf(kind, id)));
  };
  const open = async (kind: ChainSealedKind, id: string, blob: string): Promise<string> => {
    if (getKey === undefined) return new TextDecoder().decode(base64ToBytes(blob));
    const key = getKey();
    if (!key) throw new ChainEvidenceVaultLockedError(`open a ${kind}`);
    return new TextDecoder().decode(await decrypt(key, decodeCiphertext(blob), aadOf(kind, id)));
  };

  const insertRequest = db.prepare(`INSERT OR IGNORE INTO chain_requests
    (request_id, key_hash, occasion, session_id, words_encrypted, at)
    VALUES (@request_id, @key_hash, @occasion, @session_id, @words_encrypted, @at)`);
  const insertTurn = db.prepare('INSERT OR IGNORE INTO chain_turns (turn_id, request_id) VALUES (?, ?)');
  const turnRow = db.prepare('SELECT request_id FROM chain_turns WHERE turn_id = ?');
  const requestKey = db.prepare('SELECT key_hash FROM chain_requests WHERE request_id = ?');
  const insertRun = db.prepare('INSERT OR IGNORE INTO chain_runs (run_id, request_id, at) VALUES (?, ?, ?)');
  const runRow = db.prepare('SELECT request_id FROM chain_runs WHERE run_id = ?');
  const insertCall = db.prepare(`INSERT OR IGNORE INTO chain_calls
    (checkpoint_id, run_id, request_id, signature_hash, signature_encrypted, is_delete, answer, outcome, at, settled_at)
    VALUES (@checkpoint_id, @run_id, @request_id, @signature_hash, @signature_encrypted, @is_delete, @answer,
      NULL, @at, NULL)`);
  const settleRun = db.prepare(`UPDATE chain_calls SET outcome = @outcome, settled_at = @at
    WHERE run_id = @run_id AND outcome IS NULL AND answer IN ('approved', 'approved_changed')`);
  const insertUndo = db.prepare(`INSERT OR IGNORE INTO chain_undos (receipt_id, run_id, request_id, at)
    VALUES (@receipt_id, @run_id, @request_id, @at)`);
  const approvedCallsOfRun = db.prepare(`SELECT checkpoint_id, signature_hash FROM chain_calls
    WHERE run_id = ? AND answer IN ('approved', 'approved_changed')`);
  const insertUnheld = db.prepare(`INSERT OR IGNORE INTO chain_unheld_refs (ref, key_hash, session_id, at)
    VALUES (@ref, @key_hash, @session_id, @at)`);
  const unheldRow = db.prepare('SELECT key_hash, session_id FROM chain_unheld_refs WHERE ref = ?');
  const insertUnheldUndo = db.prepare(`INSERT OR IGNORE INTO chain_unheld_undos (receipt_id, ref, key_hash, session_id, at)
    VALUES (@receipt_id, @ref, @key_hash, @session_id, @at)`);
  const deleteUnheldUndos = db.prepare('DELETE FROM chain_unheld_undos WHERE session_id = ?');
  const deleteUnheld = db.prepare('DELETE FROM chain_unheld_refs WHERE session_id = ?');
  const ofSession = 'SELECT request_id FROM chain_requests WHERE session_id = ?';
  const deleteCalls = db.prepare(`DELETE FROM chain_calls WHERE request_id IN (${ofSession})`);
  const deleteUndos = db.prepare(`DELETE FROM chain_undos WHERE request_id IN (${ofSession})`);
  const deleteRuns = db.prepare(`DELETE FROM chain_runs WHERE request_id IN (${ofSession})`);
  const deleteTurns = db.prepare(`DELETE FROM chain_turns WHERE request_id IN (${ofSession})`);
  const deleteRequests = db.prepare('DELETE FROM chain_requests WHERE session_id = ?');
  const deleteSession = db.transaction((session_id: string): number => {
    deleteCalls.run(session_id);
    deleteUndos.run(session_id);
    deleteRuns.run(session_id);
    deleteTurns.run(session_id);
    deleteUnheldUndos.run(session_id);
    deleteUnheld.run(session_id);
    return deleteRequests.run(session_id).changes;
  });

  const joinTurn: ChainEvidenceStore['joinTurn'] = (turn_id, request_id) => {
    insertTurn.run(turn_id, request_id);
  };
  const requestOf = (row: unknown): string | undefined =>
    (row as { request_id?: unknown } | undefined)?.request_id as string | undefined;
  const requestOfRun: ChainEvidenceStore['requestOfRun'] = (run_id) => requestOf(runRow.get(run_id));

  return {
    async openRequest(input) {
      const normalized = normalizeChainRequestWords(input.words);
      if (normalized === '') return undefined;
      // The turn joins its request first, and synchronously: a call it holds in its first round
      // must find the request before the sealed row below is written.
      joinTurn(input.request_id, input.request_id);
      const key_hash = chainRequestKeyHash(normalized);
      insertRequest.run({
        request_id: input.request_id,
        key_hash,
        occasion: input.occasion,
        session_id: input.session_id,
        words_encrypted: await seal('request', input.request_id, input.words.trim()),
        at: input.at,
      });
      return { key_hash };
    },
    joinTurn,
    requestOfTurn: (turn_id) => requestOf(turnRow.get(turn_id)),
    keyOfRequest: (request_id) => (requestKey.get(request_id) as { key_hash?: string } | undefined)?.key_hash,
    heldRun(input) {
      insertRun.run(input.run_id, input.request_id, input.at);
    },
    requestOfRun,
    async recordAnswer(input) {
      const request_id = requestOfRun(input.run_id);
      if (request_id === undefined) return false;
      const signature = input.signature;
      insertCall.run({
        checkpoint_id: input.checkpoint_id,
        run_id: input.run_id,
        request_id,
        signature_hash: signature !== undefined ? chainCallSignatureHash(signature) : null,
        signature_encrypted: signature !== undefined
          ? await seal('call', input.checkpoint_id, JSON.stringify(signature))
          : null,
        is_delete: signature?.delete === true ? 1 : 0,
        answer: input.answer,
        at: input.at,
      });
      return true;
    },
    runSettled(run_id, outcome, at) {
      settleRun.run({ run_id, outcome, at });
    },
    runUndone(input) {
      const request_id = requestOfRun(input.run_id);
      if (request_id === undefined) return undefined;
      insertUndo.run({ receipt_id: input.receipt_id, run_id: input.run_id, request_id, at: input.at });
      const approved = approvedCallsOfRun.all(input.run_id) as Array<{ checkpoint_id: string; signature_hash: string | null }>;
      // The call that made the change: its own hold when the change names it; else the run's one.
      const made = input.checkpoint_id !== undefined
        ? approved.filter((call) => call.checkpoint_id === input.checkpoint_id)
        : approved.length === 1 ? approved : [];
      const key_hash = (requestKey.get(request_id) as { key_hash?: string } | undefined)?.key_hash;
      return {
        ...(key_hash !== undefined ? { key_hash } : {}),
        signature_hashes: made.flatMap((call) => (call.signature_hash !== null ? [call.signature_hash] : [])),
      };
    },
    unheldRef(input) {
      insertUnheld.run({ ref: input.ref, key_hash: input.key_hash, session_id: input.session_id, at: input.at });
    },
    unheldUndone(input) {
      const row = unheldRow.get(input.ref) as { key_hash: string; session_id: string } | undefined;
      if (row === undefined) return undefined;
      insertUnheldUndo.run({ receipt_id: input.receipt_id, ref: input.ref, key_hash: row.key_hash,
        session_id: row.session_id, at: input.at });
      return { key_hash: row.key_hash };
    },
    deleteSession: (session_id) => deleteSession(session_id),
    seal,
    open,
  };
};

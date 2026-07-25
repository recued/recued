/** D-214 S0 — the durable **root-request edge**.
 *
 *  This is the slice's real cost, and the one piece of D-214 that touches
 *  existing conversational flow (build plan §0 R1). The plan's first revision
 *  claimed "the correlation chain already exists end to end"; it does not:
 *
 *    · `chat_messages` has **no `turn_id`** column — the message→turn hop the
 *      chain rested on does not exist;
 *    · the plan→message anchor binds to the *assistant* row after completion
 *      and is explicitly best-effort ("Recovery may fail to link");
 *    · the initiating *user* row is persisted with no turn link;
 *    · reads bypass plan approval entirely, so many spans have no plan row at
 *      all.
 *
 *  Reaching the root request from a plan would therefore need adjacency or time
 *  inference — exactly what §4.2 forbids ("the server must not derive a span by
 *  timestamp proximity alone"). So the edge is persisted, not inferred.
 *
 *  ⛔ **D-214-OWNED SIDE TABLES, NEVER A COLUMN ON `chat_messages`** (§0 R4).
 *  D-214 is unproven and §13 Slice 5 gates it behind a bounded experiment
 *  before default-on; that experiment is only worth running if it is
 *  reversible. Keeping the edge in its own tables makes removal a `DROP` and
 *  modifies no existing schema. (It is also why this file exists rather than
 *  extending `chat-store.ts`.)
 *
 *  Two tables, deliberately:
 *
 *    `execution_span_roots`   — one row per root request. Holds the prompt,
 *                               sealed. One copy, not one per turn.
 *    `execution_span_anchors` — one row per turn, mapping it to its root. This
 *                               is the lineage: a continuation turn (an
 *                               approval resumed on the user's next message)
 *                               anchors to the SAME root as the turn that
 *                               opened the span.
 *
 *  ⚠ **A span is a conversation, not a prompt** (§4.2). An approved plan
 *  re-issues on the user's *next* message, so any span containing an approval
 *  already spans several user turns by construction. Intermediate user messages
 *  are first-class span content, not noise — which is precisely why the anchor
 *  is per-turn and the root is not re-minted per turn.
 *
 *  ⛔ **Re-rooting is forbidden** (§8.2.2, and it is a security property, not a
 *  modelling preference). Letting a caller declare a new root when intent
 *  drifts is a *failure-laundering channel*: "let me approach this differently"
 *  is a natural conversational move that would erase the negative for the flow
 *  that just failed. Re-keying fails OPEN (a wrong root manufactures a wrong
 *  case); suppression fails SAFE (a case is merely lost). {@link anchorTurn} is
 *  therefore idempotent per turn and will not repoint an anchored turn — see
 *  its contract.
 */

import type Database from 'better-sqlite3';
import {
  base64ToBytes,
  bytesToBase64,
  decodeCiphertext,
  decrypt,
  encodeCiphertext,
  encrypt,
} from '@recued/crypto';

/** Lookup callback returning the chat sub-DEK (`HKDF(master_dek,
 *  domain='chat')`) — the same provider `chat-store.ts` takes, so the
 *  KeyManager's `keyProvider('chat')` plugs in unchanged.
 *
 *  The root request is a verbatim user prompt, so it is sealed under the chat
 *  domain rather than a D-214-specific one: it is the same secret, and minting
 *  a second domain for the same plaintext buys nothing and doubles the
 *  key-lifecycle surface.
 *
 *  `null` means FileVault is locked; callers throw upward. `undefined` (no
 *  provider wired at all) falls back to base64-only encoding, matching the
 *  `chat-store` discipline for dbless harnesses and the pre-KeyManager boot
 *  window. */
export type SpanAnchorKeyProvider = () => Uint8Array | null;

export class SpanAnchorVaultLockedError extends Error {
  constructor(detail: string) {
    super(
      `execution-span-anchor-store: server FileVault is locked, cannot ${detail}`,
    );
    this.name = 'SpanAnchorVaultLockedError';
  }
}

/** AAD binding for a sealed root request. Binds the ciphertext to its
 *  `(session_id, root_request_id)` pair, so an attacker who reorders rows in
 *  the SQLite file cannot move a sealed prompt onto a different root — which
 *  would silently re-root a span, the exact outcome §8.2.2 forbids. The `v1`
 *  sentinel doubles as a versioned label. */
const aadForRoot = (session_id: string, root_request_id: string): Uint8Array =>
  new TextEncoder().encode(
    `recued/v1/d214/span-root/${session_id}/${root_request_id}`,
  );

const requireKey = (
  getKey: SpanAnchorKeyProvider,
  op: string,
): Uint8Array => {
  const key = getKey();
  if (!key) throw new SpanAnchorVaultLockedError(op);
  return key;
};

const sealRootRequest = async (
  text: string,
  identity: { session_id: string; root_request_id: string },
  getKey?: SpanAnchorKeyProvider,
): Promise<string> => {
  const plaintext = new TextEncoder().encode(text);
  if (!getKey) return bytesToBase64(plaintext);
  const key = requireKey(getKey, 'seal a root request');
  const ct = await encrypt(
    key,
    plaintext,
    aadForRoot(identity.session_id, identity.root_request_id),
  );
  return encodeCiphertext(ct);
};

const openRootRequest = async (
  blob: string,
  identity: { session_id: string; root_request_id: string },
  getKey?: SpanAnchorKeyProvider,
): Promise<string> => {
  if (!getKey) return new TextDecoder().decode(base64ToBytes(blob));
  const key = requireKey(getKey, 'open a root request');
  const plaintext = await decrypt(
    key,
    decodeCiphertext(blob),
    aadForRoot(identity.session_id, identity.root_request_id),
  );
  return new TextDecoder().decode(plaintext);
};

/** Idempotent schema install — safe on every boot, and a `DROP` of these two
 *  tables is a complete removal of D-214's footprint on conversational flow. */
export const ensureExecutionSpanAnchorSchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_span_roots (
      root_request_id          TEXT PRIMARY KEY,
      session_id               TEXT NOT NULL,
      surface                  TEXT NOT NULL,
      root_request_encrypted   TEXT NOT NULL,
      created_at               INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_span_roots_session
      ON execution_span_roots (session_id, created_at);

    CREATE TABLE IF NOT EXISTS execution_span_anchors (
      session_id       TEXT NOT NULL,
      turn_id          TEXT NOT NULL,
      root_request_id  TEXT NOT NULL,
      -- NULL on the turn that OPENED the span; set on every continuation, and
      -- it names the turn continued FROM. Retained because "which turn
      -- resumed which" is the lineage §4.2 walks, and it is not recoverable
      -- from the root alone once several turns share one root.
      origin_turn_id   TEXT,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_id),
      FOREIGN KEY (root_request_id)
        REFERENCES execution_span_roots (root_request_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_execution_span_anchors_root
      ON execution_span_anchors (root_request_id, created_at);
  `);
};

export interface SpanRoot {
  root_request_id: string;
  session_id: string;
  surface: string;
  created_at: number;
}

export interface SpanAnchor {
  session_id: string;
  turn_id: string;
  root_request_id: string;
  origin_turn_id?: string;
  created_at: number;
}

export interface OpenSpanInput {
  root_request_id: string;
  session_id: string;
  surface: string;
  /** The verbatim initiating user message. Sealed before it lands. */
  root_request: string;
  turn_id: string;
  now?: number;
}

export interface AnchorTurnInput {
  session_id: string;
  turn_id: string;
  root_request_id: string;
  /** The turn this one continues from. Omit only for a span-opening turn,
   *  which {@link ExecutionSpanAnchorStore.openSpan} already anchors. */
  origin_turn_id?: string;
  now?: number;
}

export interface ExecutionSpanAnchorStore {
  /** Mint a root and anchor the turn that opened it. Idempotent on
   *  `root_request_id`: re-opening an existing root is a no-op that still
   *  anchors the turn, so a retried stream cannot fork a second root. */
  openSpan(input: OpenSpanInput): Promise<void>;
  /** Anchor a continuation turn to an existing root.
   *
   *  ⛔ **Will not repoint an already-anchored turn.** A second call for the
   *  same `(session_id, turn_id)` naming a DIFFERENT root is ignored, not
   *  applied — that is the §8.2.2 re-rooting prohibition enforced at the only
   *  place it can be enforced. Returns `false` when it declined. */
  anchorTurn(input: AnchorTurnInput): boolean;
  getAnchor(session_id: string, turn_id: string): SpanAnchor | undefined;
  getRoot(root_request_id: string): SpanRoot | undefined;
  /** Decrypt a root request. Compiler-side only — never a model-facing read. */
  readRootRequest(root_request_id: string): Promise<string | undefined>;
  /** Every turn anchored to a root, oldest first. The span's turn closure. */
  listAnchors(root_request_id: string): SpanAnchor[];
  /** Every root whose source closure touches a session. Used only by the
   * privacy/session-delete cascade; a continued span is removed even when the
   * deleted session did not originate it. */
  listRootsForSession(session_id: string): string[];
  /** Resolve a turn to its root request id in one hop — the lookup the
   *  compiler makes when walking back from a `chat_plans` row. */
  resolveRoot(session_id: string, turn_id: string): string | undefined;
  /** Privacy/source deletion. Foreign-key cascade removes every turn edge. */
  deleteRoot(root_request_id: string): boolean;
}

interface RootRow {
  root_request_id: string;
  session_id: string;
  surface: string;
  root_request_encrypted: string;
  created_at: number;
}

interface AnchorRow {
  session_id: string;
  turn_id: string;
  root_request_id: string;
  origin_turn_id: string | null;
  created_at: number;
}

const anchorFromRow = (row: AnchorRow): SpanAnchor => ({
  session_id: row.session_id,
  turn_id: row.turn_id,
  root_request_id: row.root_request_id,
  ...(row.origin_turn_id !== null ? { origin_turn_id: row.origin_turn_id } : {}),
  created_at: row.created_at,
});

export const createExecutionSpanAnchorStore = (
  db: Database.Database,
  getKey?: SpanAnchorKeyProvider,
): ExecutionSpanAnchorStore => {
  ensureExecutionSpanAnchorSchema(db);

  const insertRoot = db.prepare(`
    INSERT INTO execution_span_roots (
      root_request_id, session_id, surface, root_request_encrypted, created_at
    ) VALUES (
      @root_request_id, @session_id, @surface, @root_request_encrypted, @created_at
    )
    ON CONFLICT (root_request_id) DO NOTHING
  `);

  /** `DO NOTHING` rather than `DO UPDATE`: an anchored turn keeps its first
   *  root. See the re-rooting note in the file header — this clause IS the
   *  enforcement point. */
  const insertAnchor = db.prepare(`
    INSERT INTO execution_span_anchors (
      session_id, turn_id, root_request_id, origin_turn_id, created_at
    ) VALUES (
      @session_id, @turn_id, @root_request_id, @origin_turn_id, @created_at
    )
    ON CONFLICT (session_id, turn_id) DO NOTHING
  `);

  const selectRoot = db.prepare(
    'SELECT * FROM execution_span_roots WHERE root_request_id = ?',
  );
  const selectAnchor = db.prepare(
    'SELECT * FROM execution_span_anchors WHERE session_id = ? AND turn_id = ?',
  );
  const selectAnchorsByRoot = db.prepare(`
    SELECT * FROM execution_span_anchors
    WHERE root_request_id = ?
    ORDER BY created_at ASC, turn_id ASC
  `);
  const selectRootsBySession = db.prepare(`
    SELECT root_request_id
      FROM execution_span_roots
     WHERE session_id = ?
    UNION
    SELECT root_request_id
      FROM execution_span_anchors
     WHERE session_id = ?
     ORDER BY root_request_id ASC
  `);
  const deleteRoot = db.prepare(`
    DELETE FROM execution_span_roots WHERE root_request_id = ?
  `);
  const deleteAnchors = db.prepare(`
    DELETE FROM execution_span_anchors WHERE root_request_id = ?
  `);

  return {
    async openSpan(input) {
      const created_at = input.now ?? Date.now();
      const root_request_encrypted = await sealRootRequest(
        input.root_request,
        {
          session_id: input.session_id,
          root_request_id: input.root_request_id,
        },
        getKey,
      );
      insertRoot.run({
        root_request_id: input.root_request_id,
        session_id: input.session_id,
        surface: input.surface,
        root_request_encrypted,
        created_at,
      });
      insertAnchor.run({
        session_id: input.session_id,
        turn_id: input.turn_id,
        root_request_id: input.root_request_id,
        origin_turn_id: null,
        created_at,
      });
    },

    anchorTurn(input) {
      const result = insertAnchor.run({
        session_id: input.session_id,
        turn_id: input.turn_id,
        root_request_id: input.root_request_id,
        origin_turn_id: input.origin_turn_id ?? null,
        created_at: input.now ?? Date.now(),
      });
      return result.changes > 0;
    },

    getAnchor(session_id, turn_id) {
      const row = selectAnchor.get(session_id, turn_id) as
        | AnchorRow
        | undefined;
      return row ? anchorFromRow(row) : undefined;
    },

    getRoot(root_request_id) {
      const row = selectRoot.get(root_request_id) as RootRow | undefined;
      if (!row) return undefined;
      return {
        root_request_id: row.root_request_id,
        session_id: row.session_id,
        surface: row.surface,
        created_at: row.created_at,
      };
    },

    async readRootRequest(root_request_id) {
      const row = selectRoot.get(root_request_id) as RootRow | undefined;
      if (!row) return undefined;
      return openRootRequest(
        row.root_request_encrypted,
        { session_id: row.session_id, root_request_id: row.root_request_id },
        getKey,
      );
    },

    listAnchors(root_request_id) {
      const rows = selectAnchorsByRoot.all(root_request_id) as AnchorRow[];
      return rows.map(anchorFromRow);
    },

    listRootsForSession(session_id) {
      return (selectRootsBySession.all(session_id, session_id) as Array<{
        root_request_id: string;
      }>).map((row) => row.root_request_id);
    },

    deleteRoot(root_request_id) {
      return db.transaction(() => {
        deleteAnchors.run(root_request_id);
        return deleteRoot.run(root_request_id).changes === 1;
      })();
    },

    resolveRoot(session_id, turn_id) {
      const row = selectAnchor.get(session_id, turn_id) as
        | AnchorRow
        | undefined;
      return row?.root_request_id;
    },
  };
};

/** D-148 § A.2.2 — `client_tokens` table + Argon2id hash discipline.
 *
 *  Per-client bearer tokens scope by client kind. Server stores the
 *  Argon2id hash; client carries the plaintext bearer in
 *  `Authorization: Bearer <token>` at WS connect.
 *
 *  Schema mirrors the spec verbatim:
 *
 *    CREATE TABLE client_tokens (
 *      token_id TEXT PRIMARY KEY,             -- opaque public id; safe to log
 *      token_hash BLOB NOT NULL,              -- Argon2id hash of bearer
 *      client_kind TEXT NOT NULL,             -- 'bridge' | 'webclient' | 'cli'
 *      client_label TEXT,                     -- user-set label
 *      issued_at INTEGER NOT NULL,
 *      last_used_at INTEGER,
 *      revoked_at INTEGER,
 *      revocation_reason TEXT,
 *      metadata_blob JSON
 *    );
 *
 *  We store the `TokenHashRecord` (hash + salt + Argon2id params) as
 *  a JSON-encoded TEXT instead of a raw BLOB so the params travel
 *  with the hash — verify side picks them up automatically and the
 *  cost can evolve over time without re-hashing legacy rows.
 *
 *  Constant-time verify discipline: `verifyBearerToken` (from
 *  `keys/`) wraps Node's `timingSafeEqual` over the Argon2id
 *  output. The handler MUST NOT take any additional branches on the
 *  bearer's content — every bearer (valid or not) flows through the
 *  same Argon2id call so timing distributions stay flat.
 */

import type Database from 'better-sqlite3';
import { initializePreapprovalContractReads, mutatePreapprovalContractQueries, recordPreapprovalContractRead,
  refreshPreapprovalContractQueries, PREAPPROVAL_CLIENT_TOKEN_QUERY } from '../storage/preapproval-contract-reads.js';
import {
  generateBearerToken,
  hashBearerToken,
  verifyBearerToken,
  TOKEN_ARGON2_PARAMS,
  type TokenHashRecord,
} from '../keys/index.js';

export type ClientKind = 'bridge' | 'webclient' | 'cli';

export const CLIENT_KINDS: ReadonlyArray<ClientKind> = ['bridge', 'webclient', 'cli'] as const;

export const isClientKind = (v: unknown): v is ClientKind =>
  typeof v === 'string' && (CLIENT_KINDS as ReadonlyArray<string>).includes(v);

export interface ClientTokenRecord {
  token_id: string;
  client_kind: ClientKind;
  client_label: string | null;
  issued_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revocation_reason: string | null;
  metadata: Record<string, unknown> | null;
}

export interface IssueClientTokenOptions {
  client_kind: ClientKind;
  client_label?: string;
  metadata?: Record<string, unknown>;
}

/** Result of a `rotate()` call. Success carries the cleartext bearer
 *  for exactly one return — the emitter forwards it onto the bus and
 *  drops it. */
export type RotateClientTokenResult =
  | {
      ok: true;
      replaced_token_id: string;
      new_token_id: string;
      bearer: string;
      issued_at: number;
      client_kind: ClientKind;
      client_label: string | null;
      metadata: Record<string, unknown> | null;
    }
  | { ok: false; reason: 'not_found' | 'already_revoked' };

export interface ClientTokenStore {
  /** Issue a fresh token. Returns the public `token_id` + the
   *  cleartext bearer (only moment the cleartext exists in the
   *  process). The hash + salt + params are persisted; the bearer
   *  is NOT. */
  issue(opts: IssueClientTokenOptions): Promise<{ token_id: string; bearer: string }>;
  /** Verify a `token_id`+`bearer` pair. Returns the record (when
   *  found + bearer matches + not revoked) or null. Constant-time
   *  with respect to the bearer content; runs the full Argon2id
   *  verify on every call regardless of token_id existence so the
   *  oracle "is this token_id valid?" cannot be inferred from
   *  timing. */
  verify(token_id: string, bearer: string): Promise<{ ok: boolean; record: ClientTokenRecord | null }>;
  /** D-148 § A.4.4 — seamless bearer rotation. Atomic insert-new +
   *  revoke-old keyed off the existing `token_id`. The new row
   *  inherits `client_kind` / `client_label` / `metadata` so the
   *  WebclientRegistry / BridgeRegistry can rebuild presence with
   *  the same identifying tags after the targeted client reconnects.
   *  The cleartext bearer is returned exactly once for the caller
   *  to forward through the `token.rotated` broadcast; the bearer is
   *  never persisted in cleartext (only the Argon2id hash of the new
   *  bearer lands in the new row). */
  rotate(opts: { token_id: string; now?: number }): Promise<RotateClientTokenResult>;
  /** Mark a single token revoked. No-op if already revoked or
   *  unknown. */
  revoke(token_id: string, reason: string, now?: number): void;
  /** Revoke every active token. Returns the count revoked. Used by
   *  the server-identity rotation flow to force re-pair on every
   *  connected client. */
  revokeAll(reason: string, now?: number): number;
  /** Get a record by `token_id`. Returns null when missing. */
  get(token_id: string): ClientTokenRecord | null;
  /** List records. Active-only by default; pass
   *  `{ include_revoked: true }` for the full list. */
  list(opts?: { include_revoked?: boolean; client_kind?: ClientKind }): ClientTokenRecord[];
  /** Stamp `last_used_at`. Called by the WS dispatcher on every
   *  authenticated rpc; the bearer's hash record stays stable. */
  touch(token_id: string, now?: number): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS client_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash_json TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  client_label TEXT,
  issued_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revocation_reason TEXT,
  metadata_blob TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_tokens_kind ON client_tokens(client_kind);
CREATE INDEX IF NOT EXISTS idx_client_tokens_revoked ON client_tokens(revoked_at);
`;

interface RawRow {
  token_id: string;
  token_hash_json: string;
  client_kind: string;
  client_label: string | null;
  issued_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revocation_reason: string | null;
  metadata_blob: string | null;
}

const rowToRecord = (row: RawRow): ClientTokenRecord => {
  if (!isClientKind(row.client_kind)) {
    throw new Error(
      `client_tokens: row ${row.token_id} carries unknown client_kind '${row.client_kind}'`,
    );
  }
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata_blob) {
    try {
      metadata = JSON.parse(row.metadata_blob) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    token_id: row.token_id,
    client_kind: row.client_kind,
    client_label: row.client_label,
    issued_at: row.issued_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    revocation_reason: row.revocation_reason,
    metadata,
  };
};

const rowToHashRecord = (row: RawRow): TokenHashRecord | null => {
  try {
    const parsed = JSON.parse(row.token_hash_json) as TokenHashRecord;
    if (
      typeof parsed.hash_b64 !== 'string' ||
      typeof parsed.salt_b64 !== 'string' ||
      !parsed.params ||
      typeof parsed.params.t !== 'number' ||
      typeof parsed.params.m !== 'number' ||
      typeof parsed.params.p !== 'number'
    ) return null;
    return parsed;
  } catch {
    return null;
  }
};

/** Generate a public `token_id`. Distinct from the bearer — safe
 *  to log, surface in audit rows, etc. 16 random base64 chars
 *  (~96 bits of entropy) → collision-resistant in practice. */
const generateTokenId = (): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, '');
};

export interface CreateClientTokenStoreOptions {
  /** Override the Argon2id parameters. Tests pass weaker params
   *  for speed; production uses `TOKEN_ARGON2_PARAMS`. */
  argon2_params?: { t: number; m: number; p: number };
  /** Override the clock (tests). */
  now?: () => number;
}

export const createClientTokenStore = (
  db: Database.Database,
  options: CreateClientTokenStoreOptions = {},
): ClientTokenStore => {
  db.exec(SCHEMA);
  initializePreapprovalContractReads(db);
  const params = options.argon2_params ?? TOKEN_ARGON2_PARAMS;
  const clock = options.now ?? Date.now;

  // Pre-computed dummy hash record for constant-time verify on
  // unknown token_ids. The Argon2id call against a real-but-
  // unrelated bearer takes the same wall-clock as a legitimate
  // verify so timing doesn't reveal whether the token_id existed.
  //
  // Codex P3 #10 fold — initialize EAGERLY at construction (kicked
  // off async on the next tick) rather than lazily on first
  // verify. Lazy init produced a measurable cold-start timing
  // distinction on the very first verification call (known path
  // ran one Argon2id; unknown path also had to derive the dummy
  // hash for the first time). The eager kickoff makes the first
  // legitimate verify wait on the dummy preparation if it hasn't
  // landed yet, equalizing the cold-start cost across paths.
  const dummyBearer = '0'.repeat(64);
  let dummyHashRecord: TokenHashRecord | null = null;
  const dummyReady: Promise<TokenHashRecord> = hashBearerToken(dummyBearer, params)
    .then((record) => {
      dummyHashRecord = record;
      return record;
    });
  const ensureDummy = async (): Promise<TokenHashRecord> => {
    if (dummyHashRecord) return dummyHashRecord;
    return dummyReady;
  };

  const insertStmt = db.prepare(`
    INSERT INTO client_tokens (
      token_id, token_hash_json, client_kind, client_label,
      issued_at, last_used_at, revoked_at, revocation_reason, metadata_blob
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getStmt = db.prepare(`SELECT * FROM client_tokens WHERE token_id = ?`);
  const listAllStmt = db.prepare(`SELECT * FROM client_tokens`);
  const listKindStmt = db.prepare(`SELECT * FROM client_tokens WHERE client_kind = ?`);
  const revokeStmt = db.prepare(`
    UPDATE client_tokens
       SET revoked_at = ?, revocation_reason = ?
     WHERE token_id = ? AND revoked_at IS NULL
  `);
  const revokeAllStmt = db.prepare(`
    UPDATE client_tokens
       SET revoked_at = ?, revocation_reason = ?
     WHERE revoked_at IS NULL
  `);
  const touchStmt = db.prepare(`
    UPDATE client_tokens
       SET last_used_at = ?
     WHERE token_id = ?
  `);

  // D-148 § A.4.4 — atomic insert-new + revoke-old. The hash is
  // generated outside the transaction (Argon2id is async + CPU-bound;
  // SQLite better-sqlite3 transactions are synchronous), then both
  // writes commit in one step so a crash mid-rotation can never leave
  // the table with the old row revoked + no replacement.
  //
  // Codex P2 fold — race-loser detection. Two concurrent `rotate()`
  // calls for the same `token_id` both read the row as active before
  // hashing; their hashing runs in parallel; their transactions then
  // serialize. The first transaction revokes the old row + inserts
  // its replacement. The second's `revokeStmt` finds nothing to
  // revoke (`changes === 0`) because the WHERE clause filters on
  // `revoked_at IS NULL`. Without this check the second transaction
  // would still INSERT its own replacement row, leaving two active
  // bearers for one rotation target. Throwing here aborts the
  // transaction; better-sqlite3 rolls back the INSERT in the same
  // step, so the race-loser cleanly drops + the caller maps the
  // throw to `already_revoked` (the old row IS revoked, just by the
  // race-winner instead of an admin).
  const ROTATE_RACE_SENTINEL = '__rotate_lost_race__';
  const rotateTxn = db.transaction((args: {
    old_token_id: string;
    new_token_id: string;
    new_hash_json: string;
    client_kind: ClientKind;
    client_label: string | null;
    metadata_blob: string | null;
    now: number;
  }) => {
    insertStmt.run(
      args.new_token_id,
      args.new_hash_json,
      args.client_kind,
      args.client_label,
      args.now,
      null,
      null,
      null,
      args.metadata_blob,
    );
    const revokeResult = revokeStmt.run(
      args.now,
      `rotated:${args.new_token_id}`,
      args.old_token_id,
    );
    if (revokeResult.changes !== 1) {
      // 0 changes → old row was revoked between our read + commit.
      // Throw triggers better-sqlite3's automatic rollback so the
      // INSERT above is undone.
      throw new Error(ROTATE_RACE_SENTINEL);
    }
    refreshPreapprovalContractQueries(db, PREAPPROVAL_CLIENT_TOKEN_QUERY);
  });

  return {
    async issue(opts) {
      if (!isClientKind(opts.client_kind)) {
        throw new Error(`client_tokens: unknown client_kind '${opts.client_kind}'`);
      }
      const bearer = generateBearerToken();
      const token_id = generateTokenId();
      const hash = await hashBearerToken(bearer, params);
      const metadata_blob = opts.metadata ? JSON.stringify(opts.metadata) : null;
      mutatePreapprovalContractQueries(db, PREAPPROVAL_CLIENT_TOKEN_QUERY, () => insertStmt.run(
        token_id,
        JSON.stringify(hash),
        opts.client_kind,
        opts.client_label ?? null,
        clock(),
        null,
        null,
        null,
        metadata_blob,
      ));
      return { token_id, bearer };
    },

    async rotate(opts) {
      const row = getStmt.get(opts.token_id) as RawRow | undefined;
      if (!row) return { ok: false, reason: 'not_found' };
      if (!isClientKind(row.client_kind)) {
        // Malformed row — same sentinel as not_found from the caller's
        // perspective; surfacing a third reason would just churn the
        // rpc shape for a state the schema prevents under normal use.
        return { ok: false, reason: 'not_found' };
      }
      if (row.revoked_at !== null) {
        return { ok: false, reason: 'already_revoked' };
      }
      const bearer = generateBearerToken();
      const new_token_id = generateTokenId();
      const hash = await hashBearerToken(bearer, params);
      const issued_at = opts.now ?? clock();
      try {
        rotateTxn({
          old_token_id: opts.token_id,
          new_token_id,
          new_hash_json: JSON.stringify(hash),
          client_kind: row.client_kind,
          client_label: row.client_label,
          metadata_blob: row.metadata_blob,
          now: issued_at,
        });
      } catch (err) {
        // Codex P2 fold — race-loser path. Another rotate() committed
        // its revocation between our row-read + our transaction; the
        // sentinel rolls back our INSERT so no orphan row leaks.
        if (err instanceof Error && err.message === ROTATE_RACE_SENTINEL) {
          return { ok: false, reason: 'already_revoked' };
        }
        throw err;
      }
      let metadata: Record<string, unknown> | null = null;
      if (row.metadata_blob) {
        try {
          metadata = JSON.parse(row.metadata_blob) as Record<string, unknown>;
        } catch {
          metadata = null;
        }
      }
      return {
        ok: true,
        replaced_token_id: opts.token_id,
        new_token_id,
        bearer,
        issued_at,
        client_kind: row.client_kind,
        client_label: row.client_label,
        metadata,
      };
    },

    async verify(token_id, bearer) {
      // Always run an Argon2id verify even on unknown token_ids so
      // the timing-distribution match is preserved. We hash against
      // a dummy record of equivalent shape; the result is discarded.
      const row = getStmt.get(token_id) as RawRow | undefined;
      if (!row) {
        // Run a verify against the dummy record so timing holds.
        const dummy = await ensureDummy();
        await verifyBearerToken(bearer, dummy);
        return { ok: false, record: null };
      }
      const hashRecord = rowToHashRecord(row);
      if (!hashRecord) {
        // Malformed row — same constant-time discipline.
        const dummy = await ensureDummy();
        await verifyBearerToken(bearer, dummy);
        return { ok: false, record: null };
      }
      const verified = await verifyBearerToken(bearer, hashRecord);
      if (!verified) return { ok: false, record: null };
      const record = rowToRecord(row);
      if (record.revoked_at !== null) {
        return { ok: false, record: null };
      }
      return { ok: true, record };
    },

    revoke(token_id, reason, now) {
      mutatePreapprovalContractQueries(db, PREAPPROVAL_CLIENT_TOKEN_QUERY, () => revokeStmt.run(now ?? clock(), reason, token_id));
    },

    revokeAll(reason, now) {
      const result = mutatePreapprovalContractQueries(db, PREAPPROVAL_CLIENT_TOKEN_QUERY, () => revokeAllStmt.run(now ?? clock(), reason));
      return result.changes ?? 0;
    },

    get(token_id) {
      recordPreapprovalContractRead(db, PREAPPROVAL_CLIENT_TOKEN_QUERY, [token_id], true);
      const row = getStmt.get(token_id) as RawRow | undefined;
      return row ? rowToRecord(row) : null;
    },

    list(opts) {
      const kindFilter = opts?.client_kind;
      const rows = (kindFilter ? listKindStmt.all(kindFilter) : listAllStmt.all()) as RawRow[];
      const include_revoked = opts?.include_revoked ?? false;
      return rows
        .filter((r) => include_revoked || r.revoked_at === null)
        .map(rowToRecord);
    },

    touch(token_id, now) {
      touchStmt.run(now ?? clock(), token_id);
    },
  };
};

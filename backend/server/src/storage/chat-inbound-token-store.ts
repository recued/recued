/** D-137 P5 § A.9 — Bob's per-pair inbound MCP token store.
 *
 *  One row per token; persisted in Bob's per-pair SQLite db. No
 *  cross-cloud sync (D-097 / D-168 — secrets stay on the issuing
 *  server). Two indexed columns let the rpc handler look
 *  up by stable id (`token_id` — sha256-16 prefix of the bearer
 *  plaintext) and by issuance time (`created_at` for the Settings →
 *  MCP Tokens list view).
 *
 *  The bearer plaintext NEVER lands in storage. The store generates
 *  the bearer at issuance time (or accepts a caller-supplied bearer
 *  for test injection), derives the sha256 digest, persists the
 *  hex-encoded digest + the 16-hex prefix as `token_id`, and returns
 *  the plaintext exactly once via the `IssuedMcpInboundToken` envelope
 *  so Bob can copy + share it out-of-band. Subsequent reads of the
 *  row never re-surface the plaintext.
 *
 *  `verifyBearer(bearer)` derives the same sha256 digest, looks up by
 *  the 16-hex prefix, and constant-time-compares the full digest. A
 *  hit returns the row; a miss / mismatched-hash / inactive (revoked
 *  or expired) row returns `null` so the MCP port handler responds
 *  401 uniformly without leaking which condition failed.
 *
 *  Corrupted JSON in the grants/chat_mode blob falls back to "no
 *  grants, no chat-mode" + leaves `revoked_at` non-null so the row is
 *  inactive but visible in the Settings list — Bob can either restore
 *  by re-issuing or hard-delete via `deleteToken`. Never crashes the
 *  ingress surface.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { initializePreapprovalContractReads, mutatePreapprovalContractQueries, recordPreapprovalContractRead,
  PREAPPROVAL_MCP_TOKEN_QUERY } from './preapproval-contract-reads.js';
import {
  isMcpInboundConcurrencyTier,
  MCP_INBOUND_TOKEN_PREFIX,
  type IssuedMcpInboundToken,
  type McpInboundConcurrencyTier,
  type McpInboundTokenChatMode,
  type McpInboundTokenRecord,
  type ValidatedMcpInboundTokenInput,
} from '@recued/contracts';

/** Idempotent schema install. Single table keyed on `token_id`.
 *
 *  Codex review P1 fold — spec § A.9 says "Multiple tokens per peer:
 *  not supported initially. One token per peer relationship." The
 *  partial unique index on `peer_handle` WHERE the row is active
 *  (`revoked_at IS NULL` AND `peer_handle IS NOT NULL`) is the load-
 *  bearing invariant. SQLite treats NULLs as distinct under unique
 *  indexes, so tokens without a peer_handle (operator-issued; test
 *  fixtures) freely coexist; tokens with a peer_handle enforce one-
 *  active-per-peer at the SQL layer. Revoking a token clears the
 *  index entry, so Bob can immediately issue a fresh token after
 *  revoking the prior one. */
export const ensureChatInboundTokenSchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_inbound_tokens (
      token_id          TEXT PRIMARY KEY,
      bearer_hash       TEXT NOT NULL,
      label             TEXT NOT NULL,
      peer_handle       TEXT,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      revoked_at        INTEGER,
      grants_json       TEXT NOT NULL,
      concurrency_tier  INTEGER NOT NULL,
      chat_mode_json    TEXT NOT NULL,
      contract_id       TEXT,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_inbound_tokens_created_at
      ON chat_inbound_tokens (created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_inbound_tokens_peer_active
      ON chat_inbound_tokens (peer_handle)
      WHERE peer_handle IS NOT NULL AND revoked_at IS NULL;
  `);
  // D-166 P2 token↔contract binding — additive `contract_id` column. Pre-launch
  // zero-migration: the column is in the CREATE above for fresh dbs, but an
  // existing token table from a pre-binding boot needs a guarded ALTER (the
  // contact / enrichment store idiom) so it gains the column without a
  // destructive rebuild. PRAGMA-guarded ⇒ idempotent; safe on every boot.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(chat_inbound_tokens)`).all() as { name: string }[])
      .map((c) => c.name),
  );
  if (!cols.has('contract_id')) {
    db.exec(`ALTER TABLE chat_inbound_tokens ADD COLUMN contract_id TEXT`);
  }
};

/** Codex review P1 fold — error code surfaced by `issueToken` when the
 *  partial unique index would be violated. The rpc handler maps this
 *  to a domain-specific RpcError code; tests assert the prefix
 *  on the error message. */
export const PEER_HANDLE_CONFLICT_PREFIX = 'chat_inbound_token: peer_handle_conflict';

interface Row {
  token_id: string;
  bearer_hash: string;
  label: string;
  peer_handle: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  grants_json: string;
  concurrency_tier: number;
  chat_mode_json: string;
  contract_id: string | null;
  updated_at: number;
}

/** Derive the stable 16-hex `token_id` from the bearer plaintext. The
 *  full digest below remains the possession proof. */
export const deriveMcpInboundTokenId = (bearer: string): string =>
  createHash('sha256').update(bearer, 'utf8').digest('hex').slice(0, 16);

/** Derive the full sha256 hex digest used for constant-time bearer
 *  verification. */
export const hashMcpInboundTokenBearer = (bearer: string): string =>
  createHash('sha256').update(bearer, 'utf8').digest('hex');

/** Generate a fresh bearer plaintext per spec § Contract Tightening
 *  format: `recued_<base64url(32 random bytes)>`. 32 bytes ⇒ 256 bits
 *  of entropy; base64url ⇒ URL-safe / Authorization-header-safe
 *  characters. */
export const generateMcpInboundTokenBearer = (): string => {
  const raw = randomBytes(32);
  const base64url = raw
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${MCP_INBOUND_TOKEN_PREFIX}${base64url}`;
};

const parseGrantsJson = (raw: string): Record<string, boolean> => {
  const out: Record<string, boolean> = Object.create(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0) continue;
    if (typeof v !== 'boolean') continue;
    out[k] = v;
  }
  return out;
};

const parseChatModeJson = (raw: string): McpInboundTokenChatMode => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const offered = (parsed as { offered?: unknown }).offered;
  if (typeof offered !== 'boolean') return null;
  // Codex review P2 fold — fail-closed on a present-but-malformed
  // `session_cap`. The pre-fold behaviour dropped the cap silently
  // while keeping `offered: true`, converting "Bob offered chat-mode
  // with cost-controls" into "Bob offered chat-mode uncapped." The
  // cap is the cost-control field; if the persisted blob can't be
  // trusted, collapse the whole chat_mode to null so the renderer
  // surfaces "not configured" instead of "offered without limit."
  if (Object.prototype.hasOwnProperty.call(parsed, 'session_cap')) {
    const session_cap_raw = (parsed as { session_cap?: unknown }).session_cap;
    if (session_cap_raw === undefined || session_cap_raw === null) {
      return { offered };
    }
    if (
      !session_cap_raw
      || typeof session_cap_raw !== 'object'
      || Array.isArray(session_cap_raw)
    ) {
      return null;
    }
    const per_day = (session_cap_raw as { per_day?: unknown }).per_day;
    const concurrent = (session_cap_raw as { concurrent?: unknown }).concurrent;
    if (
      typeof per_day !== 'number' || !Number.isInteger(per_day) || per_day < 0
      || typeof concurrent !== 'number' || !Number.isInteger(concurrent) || concurrent < 0
    ) {
      return null;
    }
    return { offered, session_cap: { per_day, concurrent } };
  }
  return { offered };
};

const rowToRecord = (row: Row): McpInboundTokenRecord => {
  const grants = parseGrantsJson(row.grants_json);
  const chat_mode = parseChatModeJson(row.chat_mode_json);
  const concurrency_tier: McpInboundConcurrencyTier =
    isMcpInboundConcurrencyTier(row.concurrency_tier)
      ? row.concurrency_tier
      : 3;
  const record: McpInboundTokenRecord = {
    token_id: row.token_id,
    bearer_hash: row.bearer_hash,
    label: row.label,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    grants,
    concurrency_tier,
    chat_mode,
    updated_at: row.updated_at,
  };
  if (row.peer_handle !== null) record.peer_handle = row.peer_handle;
  // D-166 P2 token↔contract binding — surface the bound minted contract_id when
  // the row carries one (absent column ⇒ unbound token, unchanged behavior).
  if (row.contract_id !== null) record.contract_id = row.contract_id;
  return record;
};

const grantsToJson = (grants: Readonly<Record<string, boolean>>): string => {
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(grants).sort()) {
    if (typeof k !== 'string' || k.length === 0) continue;
    const v = grants[k];
    if (typeof v !== 'boolean') continue;
    out[k] = v;
  }
  return JSON.stringify(out);
};

const chatModeToJson = (mode: McpInboundTokenChatMode): string => {
  if (mode === null) return 'null';
  if (mode.session_cap !== undefined) {
    return JSON.stringify({
      offered: mode.offered,
      session_cap: {
        per_day: mode.session_cap.per_day,
        concurrent: mode.session_cap.concurrent,
      },
    });
  }
  return JSON.stringify({ offered: mode.offered });
};

export interface ChatInboundTokenStore {
  /** Issue a new token. The bearer plaintext is generated server-side
   *  unless `bearer_plaintext` is supplied (test injection). Returns
   *  the issued record + the plaintext exactly once. */
  issueToken(input: {
    value: ValidatedMcpInboundTokenInput;
    now: number;
    bearer_plaintext?: string;
  }): IssuedMcpInboundToken;
  /** Read one row by `token_id`. Returns `null` when no row exists.
   *  Used by the Settings UI for the per-token detail view. */
  getTokenById(token_id: string): McpInboundTokenRecord | null;
  /** Enumerate every persisted token. Used by the Settings → MCP
   *  Tokens list view + the rpc-side `chat.inbound_token.list`
   *  handler. Sorted by `created_at` DESC (newest issuance first). */
  listTokens(): ReadonlyArray<McpInboundTokenRecord>;
  /** Update a token's editable fields (Bob's checklist + Chat toggle). Stamps a
   *  fresh `updated_at`. Returns the updated record or `null` when no row exists.
   *
   *  D-171 slice 2b — BOTH `grants` and `chat_mode` are preserve-on-absent so
   *  the two edits never clobber one another: the per-tool grant checklist
   *  sends `grants` only; the Chat row sends `chat_mode` only. When present,
   *  `grants` replaces the whole map and `chat_mode` rewrites `chat_mode_json`;
   *  when absent (`undefined`), that column is left untouched. The token value
   *  never changes — clients keep working across the edit (decision 6). The rpc
   *  handler guarantees at least one of the two is present. */
  updateTokenGrants(input: {
    token_id: string;
    grants?: Readonly<Record<string, boolean>>;
    chat_mode?: McpInboundTokenChatMode;
    now: number;
  }): McpInboundTokenRecord | null;
  /** D-171 slice 3 — rebind the token's bound `contract_id` IN PLACE. Stamps a
   *  fresh `updated_at`. `contract_id` is the minted contract to bind to (the
   *  cap/expiry envelope from `collection.contract.mintContract`) or `null` to
   *  unbind. The token's bearer value NEVER changes — connected clients keep
   *  working across the rebind (decision 6); only the bound-contract column
   *  moves, so the next dispatch resolves liveness against the new (or no)
   *  contract. Returns the updated record or `null` when no row exists. */
  updateTokenContract(input: {
    token_id: string;
    contract_id: string | null;
    now: number;
  }): McpInboundTokenRecord | null;
  /** Stamp `revoked_at` so the token becomes inactive. Returns `true`
   *  iff a row was modified. Idempotent — re-revoking a revoked token
   *  preserves the original `revoked_at`. */
  revokeToken(input: { token_id: string; now: number }): boolean;
  /** Hard-delete a row. Returns `true` iff a row was removed. Used by
   *  Bob for housekeeping (e.g., clearing test tokens); revocation is
   *  the preferred path for live tokens since it preserves the audit
   *  breadcrumb. */
  deleteToken(token_id: string): boolean;
  /** Constant-time verifier. Returns the row when the bearer matches
   *  an active token; `null` otherwise (missing / expired / revoked /
   *  hash mismatch). The MCP port handler's bearer verifier closes
   *  over this method. */
  verifyBearer(input: { bearer: string; now: number }): McpInboundTokenRecord | null;
  /** Drain best-effort authority-change side effects (currently durable MCP
   * callback payload retirement). Mutators stay synchronous for transaction
   * composition; shutdown and async RPC callers use this seam to wait until
   * every admitted side effect has settled. */
  drainAuthorityChanges(): Promise<void>;
}

export interface CreateChatInboundTokenStoreOptions {
  /** Called after grants, binding, revocation, or deletion changes what a token
   * can receive. It is deliberately token-id-only: the consumer re-reads the
   * committed row and cannot act on a stale pre-mutation record. */
  onAuthorityChanged?: (token_id: string) => Promise<void> | void;
}

export const createChatInboundTokenStore = (
  db: Database.Database,
  options: CreateChatInboundTokenStoreOptions = {},
): ChatInboundTokenStore => {
  initializePreapprovalContractReads(db);
  const authorityChanges = new Set<Promise<void>>();
  const notifyAuthorityChanged = (token_id: string): void => {
    if (!options.onAuthorityChanged) return;
    let outcome: Promise<void> | void;
    try {
      outcome = options.onAuthorityChanged(token_id);
    } catch {
      return;
    }
    if (!outcome) return;
    let tracked: Promise<void>;
    tracked = Promise.resolve(outcome)
      .catch(() => undefined)
      .finally(() => authorityChanges.delete(tracked));
    authorityChanges.add(tracked);
  };
  const insertStmt = db.prepare(`
    INSERT INTO chat_inbound_tokens
      (token_id, bearer_hash, label, peer_handle, created_at, expires_at,
       revoked_at, grants_json, concurrency_tier, chat_mode_json, contract_id, updated_at)
      VALUES (@token_id, @bearer_hash, @label, @peer_handle, @created_at, @expires_at,
              @revoked_at, @grants_json, @concurrency_tier, @chat_mode_json, @contract_id,
              @updated_at)
  `);
  const selectByIdStmt = db.prepare<{ token_id: string }>(
    `SELECT * FROM chat_inbound_tokens WHERE token_id = @token_id`,
  );
  /** Codex review P1 fold — pre-flight check on issuance to surface a
   *  friendly conflict error (the partial unique index is the load-
   *  bearing guard against TOCTOU races; the pre-check produces a
   *  better message when callers race-free hit the same peer). */
  const selectActiveByPeerStmt = db.prepare<{ peer_handle: string }>(`
    SELECT token_id FROM chat_inbound_tokens
     WHERE peer_handle = @peer_handle
       AND revoked_at IS NULL
     LIMIT 1
  `);
  const listStmt = db.prepare(
    `SELECT * FROM chat_inbound_tokens ORDER BY created_at DESC, token_id ASC`,
  );
  const updateGrantsStmt = db.prepare(`
    UPDATE chat_inbound_tokens
       SET grants_json = @grants_json,
           updated_at  = @updated_at
     WHERE token_id    = @token_id
  `);
  // D-171 slice 2b — preserve-on-absent for both grants AND chat_mode: a
  // separate prepared statement per field combination so an absent field's
  // column is never written. The grants-only path (above) leaves chat_mode_json
  // untouched; the chat_mode-only path leaves grants_json untouched; the
  // both-path writes both; the touch path (neither — defensive, the rpc handler
  // requires at least one) bumps only updated_at.
  const updateChatModeStmt = db.prepare(`
    UPDATE chat_inbound_tokens
       SET chat_mode_json = @chat_mode_json,
           updated_at     = @updated_at
     WHERE token_id       = @token_id
  `);
  const updateGrantsAndChatModeStmt = db.prepare(`
    UPDATE chat_inbound_tokens
       SET grants_json    = @grants_json,
           chat_mode_json = @chat_mode_json,
           updated_at     = @updated_at
     WHERE token_id       = @token_id
  `);
  const touchStmt = db.prepare(`
    UPDATE chat_inbound_tokens
       SET updated_at = @updated_at
     WHERE token_id   = @token_id
  `);
  // D-171 slice 3 — rebind the bound contract_id in place (string ⇒ bind to a
  // minted cap/expiry contract; null ⇒ unbind). The bearer value is untouched.
  const updateContractStmt = db.prepare(`
    UPDATE chat_inbound_tokens
       SET contract_id = @contract_id,
           updated_at  = @updated_at
     WHERE token_id    = @token_id
  `);
  const revokeStmt = db.prepare(`
    UPDATE chat_inbound_tokens
       SET revoked_at = @revoked_at,
           updated_at = @updated_at
     WHERE token_id   = @token_id
       AND revoked_at IS NULL
  `);
  const deleteStmt = db.prepare(
    `DELETE FROM chat_inbound_tokens WHERE token_id = ?`,
  );

  return {
    issueToken({ value, now, bearer_plaintext }) {
      // Codex review P1 fold — spec § A.9 "Multiple tokens per peer:
      // not supported initially." Pre-check for an existing active row
      // with the same `peer_handle` so callers see a clean conflict
      // error before the unique-index constraint fires. The partial
      // unique index (`uq_chat_inbound_tokens_peer_active`) is the
      // load-bearing guard; this pre-check produces the friendly path.
      if (value.peer_handle !== undefined) {
        const conflict = selectActiveByPeerStmt.get({
          peer_handle: value.peer_handle,
        }) as { token_id: string } | undefined;
        if (conflict) {
          throw new Error(
            `${PEER_HANDLE_CONFLICT_PREFIX} (peer="${value.peer_handle}", existing_token_id="${conflict.token_id}")`,
          );
        }
      }
      const bearer = bearer_plaintext ?? generateMcpInboundTokenBearer();
      const token_id = deriveMcpInboundTokenId(bearer);
      const bearer_hash = hashMcpInboundTokenBearer(bearer);
      const record: McpInboundTokenRecord = {
        token_id,
        bearer_hash,
        label: value.label,
        created_at: now,
        revoked_at: null,
        grants: value.grants,
        concurrency_tier: value.concurrency_tier,
        chat_mode: value.chat_mode,
        updated_at: now,
      };
      if (value.peer_handle !== undefined) record.peer_handle = value.peer_handle;
      // D-166 P2 token↔contract binding — persist the bound minted contract_id
      // when supplied (absent ⇒ NULL column ⇒ unbound token).
      if (value.contract_id !== undefined) record.contract_id = value.contract_id;
      mutatePreapprovalContractQueries(db, PREAPPROVAL_MCP_TOKEN_QUERY, () => insertStmt.run({
        token_id,
        bearer_hash,
        label: value.label,
        peer_handle: value.peer_handle ?? null,
        created_at: now,
        // ⚠ The COLUMN survives (NOT NULL) and is written with the old
        // never-expires sentinel. The token no longer HAS an expiry — the
        // contract does — but dropping a column is a destructive migration with
        // no rollback, and a constant 0 is inert on every remaining read path.
        expires_at: 0,
        revoked_at: null,
        grants_json: grantsToJson(value.grants),
        concurrency_tier: value.concurrency_tier,
        chat_mode_json: chatModeToJson(value.chat_mode),
        contract_id: value.contract_id ?? null,
        updated_at: now,
      }));
      return { record, bearer_plaintext: bearer };
    },
    getTokenById(token_id) {
      const row = selectByIdStmt.get({ token_id }) as Row | undefined;
      const record = row ? rowToRecord(row) : null;
      recordPreapprovalContractRead(db, PREAPPROVAL_MCP_TOKEN_QUERY, [token_id, ...Object.keys(record?.grants ?? {}).sort()], true);
      return record;
    },
    listTokens() {
      const rows = listStmt.all() as Row[];
      return rows.map(rowToRecord);
    },
    updateTokenGrants({ token_id, grants, chat_mode, now }) {
      // Preserve-on-absent: `undefined` ⇒ that column is left untouched. Pick
      // the statement matching which fields are present so an absent field is
      // never written. (A present `chat_mode` may be `null` — that clears it.)
      const hasGrants = grants !== undefined;
      const hasChatMode = chat_mode !== undefined;
      const result = mutatePreapprovalContractQueries(db, PREAPPROVAL_MCP_TOKEN_QUERY, () => {
        if (hasGrants && hasChatMode) return updateGrantsAndChatModeStmt.run({
          token_id, grants_json: grantsToJson(grants), chat_mode_json: chatModeToJson(chat_mode), updated_at: now,
        });
        if (hasGrants) return updateGrantsStmt.run({ token_id, grants_json: grantsToJson(grants), updated_at: now });
        if (hasChatMode) return updateChatModeStmt.run({ token_id, chat_mode_json: chatModeToJson(chat_mode), updated_at: now });
        // Neither — preserve the existing touch-only semantics.
        return touchStmt.run({ token_id, updated_at: now });
      });
      if (result.changes === 0) return null;
      const row = selectByIdStmt.get({ token_id }) as Row | undefined;
      if (!row) return null;
      notifyAuthorityChanged(token_id);
      return rowToRecord(row);
    },
    updateTokenContract({ token_id, contract_id, now }) {
      // `contract_id` is already `string | null`; better-sqlite3 binds null to
      // a SQL NULL (unbind) and a string verbatim (bind). The bearer/hash/grants
      // columns are untouched, so the token value is stable across the rebind.
      const result = mutatePreapprovalContractQueries(db, PREAPPROVAL_MCP_TOKEN_QUERY, () => updateContractStmt.run({
        token_id,
        contract_id,
        updated_at: now,
      }));
      if (result.changes === 0) return null;
      const row = selectByIdStmt.get({ token_id }) as Row | undefined;
      if (!row) return null;
      notifyAuthorityChanged(token_id);
      return rowToRecord(row);
    },
    revokeToken({ token_id, now }) {
      const result = mutatePreapprovalContractQueries(db, PREAPPROVAL_MCP_TOKEN_QUERY,
        () => revokeStmt.run({ token_id, revoked_at: now, updated_at: now }));
      // Notify even on an idempotent/missing revoke so retrying the lifecycle
      // operation also retries cleanup left behind by a prior crash.
      notifyAuthorityChanged(token_id);
      return result.changes > 0;
    },
    deleteToken(token_id) {
      const result = mutatePreapprovalContractQueries(db, PREAPPROVAL_MCP_TOKEN_QUERY, () => deleteStmt.run(token_id));
      notifyAuthorityChanged(token_id);
      return result.changes > 0;
    },
    verifyBearer({ bearer, now }) {
      if (typeof bearer !== 'string' || bearer.length === 0) return null;
      const token_id = deriveMcpInboundTokenId(bearer);
      const row = selectByIdStmt.get({ token_id }) as Row | undefined;
      if (!row) return null;
      // Constant-time compare on the full sha256 digest. The 16-hex
      // prefix is the lookup key (collision-resistant for stable
      // routing); the full digest is what proves possession.
      const candidate_hash = hashMcpInboundTokenBearer(bearer);
      const expectedBuf = Buffer.from(row.bearer_hash, 'hex');
      const candidateBuf = Buffer.from(candidate_hash, 'hex');
      if (expectedBuf.length !== candidateBuf.length) return null;
      if (!timingSafeEqual(expectedBuf, candidateBuf)) return null;
      const record = rowToRecord(row);
      if (record.revoked_at !== null) return null;
      // ⛔ Expiry is the CONTRACT's, checked by `isContractLive` at each
      // consumer — the transport (`boundContractActive`, which collapses the
      // allowlist), `mcp-recipe-callback`, and `approval-resume-authority`. A
      // dead contract already yields connect-then-deny rather than a 401, and
      // an expired one now takes the same path, which is the posture that
      // preserves audit attribution.
      return record;
    },
    async drainAuthorityChanges() {
      // New callbacks may be admitted while an earlier one settles. Loop to a
      // fixed point so an async RPC response/shutdown drain never snapshots
      // only the first generation of work.
      while (authorityChanges.size > 0) {
        await Promise.all([...authorityChanges]);
      }
    },
  };
};

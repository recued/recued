/** D-137 P1 — AI Chat substrate storage scaffold.
 *
 *  The core chat tables (`chat_sessions`, `chat_messages`, `chat_plans`) are
 *  fully-shaped `CREATE TABLE IF NOT EXISTS` schemas — chat storage IS
 *  the substrate that ships first (in contrast to D-149 P1's
 *  placeholder pattern; here the rpc handler slice can drop straight
 *  into a stable schema in the next session). Per § Must Hold
 *  (D-137-equivalent of D-149 § Must Hold I-15), the tables are
 *  server-internal — no cross-cloud sync (D-097 / D-168 retired the
 *  legacy SYNC_OBJECTS substrate).
 *
 *  Per § Contract Tightening — chat content, reviewed action arguments, and
 *  terminal receipt detail are encrypted at rest via the `chat` sub-DEK;
 *  plaintext correlation metadata keeps summary/recovery reads cheap.
 *
 *  Per § A.2 — chat is the **internal channel**; the chat orchestrator
 *  writes rows directly through the engine's audit + transparency
 *  emitters. The MCP wire path NEVER writes here — external agents
 *  hit the MCP server's resolver chain, which writes its own
 *  per-request rows under the existing `mcp_dispatch` audit kind,
 *  not chat session rows.
 *
 *  Wired into `bin.ts` boot-time schema pass immediately after
 *  `ensureReceptionSchema`. Idempotent — safe to call on every boot. */

import type Database from 'better-sqlite3';
import {
  chatToolCallFromMetadata, createChatToolCallStore, settleChatToolCall,
  type ChatToolCallStore, type ChatToolCallSettlement, type StoredChatToolCall,
} from './chat-tool-call-store.js';
import {
  CHAT_MODEL_ROUTING_LAYER_SET,
  CHAT_TABLES,
  isChatDataDiagnosisIntent,
  isChatDataDiagnosisRelationship,
  isChatDataDiagnosisResolutionStatus,
  type ChatDataDiagnosisContext,
  type ChatDataDiagnosisResolution,
  type ChatHistoryCursor,
  type ChatMessage,
  type ChatEgressPacket,
  type ChatMessageAttachment,
  type ChatMessageRole,
  type ChatModelHint,
  type ChatModelRoutingLayer,
  type ChatModelSourceId,
  type ChatPickerTarget,
  type ChatProvenanceRef,
  type ChatSession,
  type ChatSessionContributor,
  type ChatSessionSummary,
  type ChatTableName,
  type ChatToolCall,
  type EntityFieldPrivacy,
  type ExecutionSource,
  type RecuedServerSignature,
  contributorForChatRole,
  executionSourceHasContract,
  isChatMessageRole,
  isChatModelHint,
  isChatModelSourceId,
  isEntityFieldPrivacy,
  isExecutionSource,
  executionSourceContractId,
} from '@recued/contracts';
import type { LLMConfig } from '@recued/llm';
import {
  base64ToBytes,
  bytesToBase64,
  decodeCiphertext,
  decrypt,
  encodeCiphertext,
  encrypt,
} from '@recued/crypto';

/** Re-exported from contracts so storage callers + tests reference a
 *  single source of truth for the chat table inventory. */
export { CHAT_TABLES };
export type { ChatTableName };

/** Idempotent schema install — safe to call on every boot. Mirrors
 *  the per-store pattern used by `ensureReceptionSchema` /
 *  `ensureCorrectionEventsStore` etc.
 *
 *  Sets `PRAGMA foreign_keys = ON` on the connection so the
 *  chat-message/action foreign keys actually fire. SQLite's FK enforcement is
 *  opt-in
 *  per-connection (not per-table); setting it inside the ensure
 *  function follows the established pattern in
 *  `ensureEnrichmentSchema` and removes the "callers must enable FK
 *  enforcement before deleting a session" footgun. Idempotent and
 *  cheap. */
export const ensureChatSchema = (db: Database.Database): void => {
  // SQLite needs `PRAGMA foreign_keys = ON` per-connection so the
  // chat-message/action cascades fire on session deletes.
  // Idempotent and cheap; same pattern as `ensureEnrichmentSchema`.
  db.exec('PRAGMA foreign_keys = ON');
  // § Contract Tightening — one row per chat conversation. Per-pair
  // only; no cross-cloud sync (D-097 / D-168). `picker_state_target` defaults to
  // `'self'` at creation; `model_routing_layer` defaults to `'byok'`
  // (D-191: "local" is a display property, not a routing layer). The
  // optional plaintext
  // `title` column lives outside the encrypted blob so the
  // `chat.sessions.list` rpc can render the sidebar without
  // decrypting every row; `title` is user-set or AI-generated from
  // the first turn (the latter only ever derives from the user's own
  // input, so it carries no third-party PII).
  //
  // `archived` defaults to 0 (active); the rpc handler flips it to 1
  // when the user archives without deleting — preserved for export
  // continuity (§ Acceptance "Chat storage round-trip").
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id                 TEXT PRIMARY KEY,
      created_at                 INTEGER NOT NULL,
      last_active_at             INTEGER NOT NULL,
      title                      TEXT,
      picker_state_target        TEXT NOT NULL DEFAULT 'self',
      model_routing_layer        TEXT NOT NULL DEFAULT 'byok',
      model_routing_model_hint   TEXT,
      model_routing_source_id    TEXT,
      model_routing_provider     TEXT,
      model_routing_model_id     TEXT,
      model_routing_overridden   INTEGER NOT NULL DEFAULT 0,
      archived                   INTEGER NOT NULL DEFAULT 0,
      content_revision           INTEGER NOT NULL DEFAULT 0,
      metadata_blob              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_active
      ON chat_sessions (last_active_at DESC)
      WHERE archived = 0;
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived
      ON chat_sessions (archived, last_active_at DESC);
  `);

  // D-167 chat provider-threading — `model_routing_overridden` distinguishes
  // an explicit per-session model-pref override (1) from inheriting the
  // per-pair global default (0). Guarded additive column for chat_sessions
  // tables created before this slice (mirrors annotation-store's pattern).
  const sessionCols = new Set(
    (db.prepare('PRAGMA table_info(chat_sessions)').all() as { name: string }[])
      .map((c) => c.name),
  );
  if (!sessionCols.has('model_routing_overridden')) {
    db.exec(
      'ALTER TABLE chat_sessions ADD COLUMN model_routing_overridden INTEGER NOT NULL DEFAULT 0',
    );
  }
  // § A.14 slot-aware chat routing — the BYOK slot capability hint
  // (fast=slot_1 / quality|thinking=slot_2) alongside the routing layer.
  // Guarded additive column for tables created before this slice.
  if (!sessionCols.has('model_routing_model_hint')) {
    db.exec(
      'ALTER TABLE chat_sessions ADD COLUMN model_routing_model_hint TEXT',
    );
  }
  // D-191 Phase 6 — `model_routing_source_id` persists the EXACT picked slot
  // (`slot_1` | `slot_2` | `free_pool`) so a manual pick PINS that slot at the
  // matcher (fail-closed, INV3). Guarded additive column for tables created
  // before this slice.
  if (!sessionCols.has('model_routing_source_id')) {
    db.exec(
      'ALTER TABLE chat_sessions ADD COLUMN model_routing_source_id TEXT',
    );
  }
  if (!sessionCols.has('content_revision')) {
    db.exec(
      'ALTER TABLE chat_sessions ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0',
    );
  }

  // D-167 / D-174 R28 Slice A — per-pair global chat-model default (a single
  // `default_model_routing_source_id` row + its `updated_at`). NOT per-session;
  // every non-overridden session resolves its effective `{layer, model_hint}`
  // from this source_id at read time (against the live LLM config), so a
  // default change re-applies uniformly. Per-pair only; no cross-cloud sync
  // (D-097 / D-168).
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  /** The rolling brief's durable home.
   *
   *  ⛔⛔ IT LIVED IN A MODULE-LEVEL `Map` AND THE FEATURE SHIPPED ON BY DEFAULT
   *  WHILE IT DID. That store's own note called itself "flag-gated experiment
   *  scaffolding … not durable … does not survive a restart. A shipped version
   *  belongs in the chat store beside the turn it describes — the constraint a
   *  brief protects is exactly the kind of thing that must not evaporate on a
   *  process bounce." Removing the flag made that precondition binding, and a
   *  supervisor respawn or an applied update would have dropped every
   *  `constraints` entry — the one class nothing can re-derive.
   *
   *  ⛔ ENCRYPTED, AND AAD-BOUND TO ITS SESSION. A brief is chat CONTENT: it
   *  holds what the owner said, in their words. It uses the same chat sub-DEK
   *  and the same `{session_id, message_id}` binding as `chat_messages`, with a
   *  synthetic message id, so a blob lifted into another session fails to
   *  decode rather than decrypting under the wrong conversation.
   *
   *  🔑 AND WHAT IS STORED IS PRE-ALIAS, WHICH IS WHY DURABILITY IS SAFE AT ALL.
   *  `chat-pii-slot-ordering.ts` is explicit that live turns were safe because
   *  "no alias ever crossed a restart boundary in a resolvable position" — after
   *  a restart the ledger is rebuilt and `pii.Person1` can mean Alice before and
   *  Danny after. `stripAliasBearing` drops alias-bearing entries BEFORE any
   *  write, and refuses outright if one survives, so what lands here holds real
   *  values like every other durable row. ⚠ That strip is now load-bearing for a
   *  PII invariant, not just for tidiness.
   *
   *  ⚠ FK CASCADE: a deleted session takes its brief with it, the same
   *  retention rule the message rows follow. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_briefs (
      session_id      TEXT PRIMARY KEY,
      brief_encrypted TEXT NOT NULL,
      updated_at      INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
    );
  `);

  // § Contract Tightening — one row per turn. The bulk message
  // payload (`content_encrypted`) is sub_dek-encrypted at rest; the
  // top-level discriminators (`role`, `target_server`, `ts`) stay
  // plaintext so the `chat.session.get` rpc + history-renderer
  // pagination can scan without decrypting every row.
  //
  // `target_server` carries either `'self'` or a `connection.mcp.
  // <name>` reference — snapshots the session's `picker_state.
  // current` at send time so cross-server reasoning across mixed-
  // picker conversations resolves correctly per § A.8.
  //
  // `tool_calls_blob` carries the per-turn `ChatToolCall[]` array
  // (provenance + tier + classification + status). It is encrypted under a
  // field-specific chat sub-DEK binding because `args` and free-form `detail`
  // are content-bearing even when a bulky result lives off-row.
  //
  // `model_used_provider` + `model_used_model_id` are plaintext so
  // the renderer's per-message "model:badge" affordance reads
  // without decrypting (Mary's per-conversation model-routing audit
  // surface per § A.14).
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      message_id                 TEXT PRIMARY KEY,
      session_id                 TEXT NOT NULL,
      role                       TEXT NOT NULL,
      ts                         INTEGER NOT NULL,
      target_server              TEXT NOT NULL,
      picker_at_send_blob        TEXT NOT NULL,
      model_used_provider        TEXT NOT NULL,
      model_used_model_id        TEXT NOT NULL,
      content_encrypted          BLOB NOT NULL,
      tool_calls_blob            TEXT,
      candidates_encrypted       BLOB,
      source_lifecycle           TEXT NOT NULL DEFAULT 'failed',
      provenance_blob            TEXT,
      attachments_blob           TEXT,
      metadata_blob              TEXT,
      contributor                TEXT,
      recall_eligibility         TEXT NOT NULL DEFAULT 'ineligible',
      recall_contract_id         TEXT,
      pair_id                    TEXT,
      turn_id                    TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions (session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_ts
      ON chat_messages (session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_role
      ON chat_messages (session_id, role, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_target_server
      ON chat_messages (session_id, target_server, ts)
      WHERE target_server != 'self';

    -- Per-message egress history: the aliased, model-bound prompt(s) actually
    -- sent to the LLM for this assistant turn — one row per AI call (the tool
    -- loop reinvokes), encrypted at rest under the same chat sub-DEK as message
    -- content. The "what we sent" transparency surface; lazy-read on expand, not
    -- loaded with the message list. FK CASCADE = retention follows its message
    -- (delete the message / session and the egress copy goes with it).
    CREATE TABLE IF NOT EXISTS chat_egress (
      message_id        TEXT    NOT NULL,
      call_index        INTEGER NOT NULL,
      prompt_encrypted  BLOB    NOT NULL,
      model_id          TEXT    NOT NULL,
      ts                INTEGER NOT NULL,
      PRIMARY KEY (message_id, call_index),
      FOREIGN KEY (message_id) REFERENCES chat_messages (message_id) ON DELETE CASCADE
    );
  `);

  // D-177 N.11 rule 5 (5.f) — server-stamped contributor on chat session
  // items. Guarded additive column for chat_messages tables created before
  // this slice; pre-stamp rows stay NULL and derive from role at read time
  // (`contributorForChatRole`), so the read facet is always present.
  const messageCols = new Set(
    (db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[])
      .map((c) => c.name),
  );
  if (!messageCols.has('contributor')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN contributor TEXT');
  }
  // D-213 A0 — guarded additive column for existing chat databases. The index
  // is created only after the column exists; placing it in the CREATE TABLE
  // batch above would fail boot on every pre-D-213 database.
  if (!messageCols.has('recall_eligibility')) {
    db.exec(
      "ALTER TABLE chat_messages ADD COLUMN recall_eligibility TEXT NOT NULL DEFAULT 'ineligible'",
    );
  }
  if (!messageCols.has('candidates_encrypted')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN candidates_encrypted BLOB');
  }
  if (!messageCols.has('source_lifecycle')) {
    db.exec(
      "ALTER TABLE chat_messages ADD COLUMN source_lifecycle TEXT NOT NULL DEFAULT 'failed'",
    );
  }
  // Guarded additive column for chat databases written before messages knew
  // their turn. ⛔ NULLABLE WITH NO BACKFILL, deliberately: nothing in an
  // existing row can reconstruct which turn wrote it, and inventing a value
  // would make an unknowable indistinguishable from a fact. Pre-column rows
  // stay NULL and read as `turn_id` absent, which the contract defines as
  // UNKNOWN rather than "no turn".
  if (!messageCols.has('pair_id')) {
    // ⛔⛔ ONE ROW PER EVENT, NOT PER CALL — and this column is what makes the
    // two-event case representable. A SYNCHRONOUS tool call is one event (ask
    // and answer at one instant) and gets one row carrying both halves.
    // A HELD dispatch is two: "I asked" at T1 and "it answered" at T2, and
    // those times genuinely disagree. Storing that as one row forces a choice
    // between a timestamp that is chronologically honest and one that is
    // cursor-safe — a trade that only exists if you insist on one row.
    //
    // 🔑 The pair is keyed on the run id, so a keyword match on EITHER half can
    // return both: the args make the ask findable, the body makes the outcome
    // findable, and neither is a truncated view of the other.
    db.exec('ALTER TABLE chat_messages ADD COLUMN pair_id TEXT');
  }
  if (!messageCols.has('recall_contract_id')) {
    // ⛔⛔ NULLABLE, AND LEGACY ROWS STAY NULL FOREVER. There is no backfill and
    // there must not be one: a row written before this column existed has no
    // recoverable governing contract, and inventing one would hand a door
    // history it never wrote. The read predicate compares with `IS`, so NULL
    // matches only a NULL scope — i.e. the owner corpus, whose rows are
    // contract-free anyway and are already separated by `recall_eligibility`.
    // A legacy CONTRACTED row is therefore reachable by nothing, which is the
    // same place it was before this column: unreachable, and fail-closed.
    db.exec('ALTER TABLE chat_messages ADD COLUMN recall_contract_id TEXT');
  }
  if (!messageCols.has('turn_id')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN turn_id TEXT');
  }
  // How many messages this session held when the owner last looked at it.
  //
  // ⛔ MESSAGE COUNT, NOT A TIMESTAMP. `last_active_at` is the obvious key and
  // the wrong one: SIX statements bump it, including the picker and model-pref
  // writes, so switching a session's model would mark it unread for something
  // that is not a message. A count moves only when a message lands.
  //
  // ⛔ NULLABLE WITH NO BACKFILL, and null means SEEN. Sessions that existed
  // before this column would otherwise all light up as unread on the first
  // boot after an upgrade — a wall of false marks is worse than no marks. New
  // sessions are stamped 0 at creation instead, so everything created from
  // here on is markable from birth without inventing a past for anything else.
  if (!sessionCols.has('last_seen_message_count')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN last_seen_message_count INTEGER');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_recall_eligibility
      ON chat_messages (recall_eligibility, ts DESC, message_id DESC);
    -- ⛔⛔ THE CORPUS PAIR, and the index above stopped covering the scan the
    -- moment "recall_contract_id" joined the predicate. Verified with EXPLAIN
    -- QUERY PLAN: on the old index SQLite seeks "recall_eligibility=?" and
    -- leaves the contract as a RESIDUAL, so a door corpus reads every OWNER row
    -- to find its own few — and that cost grows with the owner's history, not
    -- the customer's. With the pair it seeks
    -- "recall_eligibility=? AND recall_contract_id=?".
    --
    -- ⚠ "IS" rather than "=" in the query is still indexable here (the plan
    -- shows the seek), which is what lets ONE predicate serve both corpora
    -- without a NULL branch.
    --
    -- ⚠ It matters more now that tool rows are written: a turn adds p50 2 of
    -- them, so the corpus roughly doubles in rows, and the scan DECRYPTS every
    -- row it visits. A residual filter is paid per row, in AEAD.
    --
    -- The old index is kept rather than dropped: "recall_eligibility" leads
    -- both, so anything seeking on eligibility alone is still served, and
    -- dropping an index that shipped is a migration with no upside here.
    CREATE INDEX IF NOT EXISTS idx_chat_messages_recall_corpus
      ON chat_messages (recall_eligibility, recall_contract_id, ts DESC, message_id DESC);
    -- PARTIAL, and it has to be. reconcileAbandonedPending reads
    --   WHERE source_lifecycle = 'pending' AND (@session_id IS NULL OR ...)
    -- which had no index at all, so it SCANNED THE WHOLE MESSAGE TABLE -- once
    -- per call on the per-request recall path, and again on every session
    -- delete. Measured at 100k messages: 2.8ms -> 0.0ms.
    --
    -- Partial rather than a plain (source_lifecycle, session_id) index because
    -- 'pending' is a TRANSIENT state -- a row is pending only between the
    -- extraction start and its finalizer. The index therefore holds the few
    -- in-flight rows instead of one entry per message ever written, and a row
    -- LEAVES it when it settles. The predicate matches the query's own
    -- WHERE text, which is what lets SQLite use it.
    --
    -- NOTE the second conjunct stays a residual: (@x IS NULL OR col = @x) is
    -- unindexable by construction (the plan cannot depend on a bound value), so
    -- the win comes entirely from narrowing to 'pending' first.
    CREATE INDEX IF NOT EXISTS idx_chat_messages_pending_source
      ON chat_messages (session_id)
      WHERE source_lifecycle = 'pending';
  `);

  // Durable reviewed-action history. The args and terminal execution payload
  // use the chat sub-DEK in `chat-plan-store.ts`; only correlation/status
  // metadata remains plaintext so restart recovery can fail a stale `running`
  // row to `unknown` without decrypting owner content at boot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_plans (
      plan_id                    TEXT PRIMARY KEY,
      session_id                 TEXT NOT NULL,
      turn_id                    TEXT NOT NULL,
      retry_of_plan_id           TEXT,
      message_id                 TEXT,
      tool                       TEXT NOT NULL,
      tier                       INTEGER NOT NULL,
      classification             TEXT NOT NULL,
      args_encrypted             TEXT NOT NULL,
      args_hash                  TEXT NOT NULL,
      target_instance            TEXT,
      status                     TEXT NOT NULL,
      created_at                 INTEGER NOT NULL,
      resolved_at                INTEGER,
      consumed_at                INTEGER,
      execution_status           TEXT,
      execution_turn_id          TEXT,
      execution_blob_encrypted   TEXT,
      execution_updated_at       INTEGER,
      FOREIGN KEY (session_id) REFERENCES chat_sessions (session_id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES chat_messages (message_id) ON DELETE SET NULL
    );
    -- THE APPROVAL-INBOX INDEX. handlePlansPendingList (the owner's
    --   cross-session pending-approvals rpc) reads
    --     WHERE status = 'proposed' ORDER BY created_at ASC, plan_id ASC
    --   and every other index here leads with session_id, which cannot serve a
    --   query naming no session. So the approvals view SCANNED chat_plans and
    --   sorted it. Measured at 200k plans with 100 proposed: 4.62ms -> 0.06ms.
    --
    -- PARTIAL, because 'proposed' is a TRANSIENT state -- a plan is proposed
    --   only until the owner approves or rejects it. The index holds the
    --   pending approvals and nothing else (100 entries, not 200,000), and a
    --   row LEAVES it when the owner acts. The columns are that query's own
    --   ORDER BY, so the sort goes away too.
    --
    -- NOT added for the sibling boot statement (UPDATE ... WHERE
    --   execution_status = 'running'): that is crash recovery, runs ONCE per
    --   store construction, and an index maintained on every execution
    --   transition to save a single scan at boot is the wrong trade.
    CREATE INDEX IF NOT EXISTS idx_chat_plans_proposed
      ON chat_plans (created_at, plan_id) WHERE status = 'proposed';
    CREATE INDEX IF NOT EXISTS idx_chat_plans_session_created
      ON chat_plans (session_id, created_at, plan_id);
    CREATE INDEX IF NOT EXISTS idx_chat_plans_dispatch_match
      ON chat_plans (session_id, tool, args_hash, status, consumed_at);
    CREATE INDEX IF NOT EXISTS idx_chat_plans_turn
      ON chat_plans (session_id, turn_id, tool, args_hash, created_at);
  `);

  // `retry_of_plan_id` landed after the durable action table. Keep the
  // migration additive so existing encrypted rows retain their byte-identical
  // AAD (the field is included only when a new row actually carries lineage).
  const planCols = new Set(
    (db.prepare('PRAGMA table_info(chat_plans)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  if (!planCols.has('retry_of_plan_id')) {
    db.exec('ALTER TABLE chat_plans ADD COLUMN retry_of_plan_id TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_plans_retry_origin
      ON chat_plans (session_id, retry_of_plan_id, created_at);
  `);
};

// ────────────────────────────────────────────────────────────────
// D-137 P1.2 — Chat sub-DEK AEAD helpers
// ────────────────────────────────────────────────────────────────

/** Lookup callback returning the chat sub-DEK (`HKDF(master_dek,
 *  domain='chat')`). Mirrors the connection-handler pattern so the
 *  KeyManager's `keyProvider('chat')` plugs in unchanged. Returning
 *  `null` means FileVault is locked; callers throw `locked` upward.
 *  When unwired (`undefined`), the store falls back to base64-only
 *  encoding for dbless harnesses + the pre-KeyManager boot window. */
export type ChatKeyProvider = () => Uint8Array | null;

export type RecallSourceLifecycle = 'pending' | 'finalized' | 'failed';

/** Flat schema-attested source projection retained for local D-167 reharvest. */
export interface RetainedAliasCandidate {
  readonly value: string;
  readonly kind: Exclude<EntityFieldPrivacy, 'content'>;
}

interface StoredPromptPartsV1 {
  readonly format: 'prompt_parts_v1';
  readonly primary: {
    readonly source: 'framework';
    readonly role: 'content';
    readonly content_kind: 'user_message' | 'chat_tail';
    readonly text: string;
    readonly speaker: 'user' | 'assistant';
  };
}

const encodeStoredPromptParts = (
  role: ChatMessageRole,
  content: string,
): string => JSON.stringify({
  format: 'prompt_parts_v1',
  primary: {
    source: 'framework',
    role: 'content',
    content_kind: role === 'user' ? 'user_message' : 'chat_tail',
    text: content,
    speaker: role === 'user' ? 'user' : 'assistant',
  },
} satisfies StoredPromptPartsV1);

const decodeStoredPromptParts = (
  raw: string,
  expectedRole: ChatMessageRole,
): StoredPromptPartsV1 => {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('chat-store: invalid prompt_parts_v1 envelope');
  }
  const envelope = parsed as Record<string, unknown>;
  const primary = envelope.primary;
  if (
    envelope.format !== 'prompt_parts_v1'
    || Object.keys(envelope).some(
      (key) => key !== 'format' && key !== 'primary',
    )
    || primary === null
    || typeof primary !== 'object'
    || Array.isArray(primary)
  ) {
    throw new Error('chat-store: invalid prompt_parts_v1 envelope');
  }
  const part = primary as Record<string, unknown>;
  if (
    Object.keys(part).some(
      (key) =>
        key !== 'source'
        && key !== 'role'
        && key !== 'content_kind'
        && key !== 'text'
        && key !== 'speaker',
    )
    ||
    part.source !== 'framework'
    || part.role !== 'content'
    || (part.content_kind !== 'user_message' && part.content_kind !== 'chat_tail')
    || typeof part.text !== 'string'
    || (part.speaker !== 'user' && part.speaker !== 'assistant')
  ) {
    throw new Error('chat-store: invalid prompt_parts_v1 primary part');
  }
  const expectedSpeaker = expectedRole === 'user' ? 'user' : 'assistant';
  const expectedContentKind =
    expectedRole === 'user' ? 'user_message' : 'chat_tail';
  if (
    part.speaker !== expectedSpeaker
    || part.content_kind !== expectedContentKind
  ) {
    throw new Error('chat-store: prompt part role binding mismatch');
  }
  return parsed as StoredPromptPartsV1;
};

const normalizeRetainedAliasCandidates = (
  candidates: readonly RetainedAliasCandidate[] | undefined,
): readonly RetainedAliasCandidate[] => {
  if (candidates === undefined) return [];
  if (!Array.isArray(candidates) || candidates.length > 1_024) {
    throw new Error('chat-store: invalid retained candidate list');
  }
  const out: RetainedAliasCandidate[] = [];
  const seen = new Set<string>();
  let candidateBytes = 0;
  for (const candidate of candidates) {
    if (
      candidate === null
      || typeof candidate !== 'object'
      || typeof candidate.value !== 'string'
      || candidate.value.length === 0
      || !isEntityFieldPrivacy(candidate.kind)
      || candidate.kind === 'content'
      || Object.keys(candidate).some((key) => key !== 'value' && key !== 'kind')
    ) {
      throw new Error('chat-store: invalid retained alias candidate');
    }
    const key = `${candidate.kind}\u0000${candidate.value}`;
    if (seen.has(key)) continue;
    candidateBytes += new TextEncoder().encode(candidate.value).byteLength;
    if (candidateBytes > 1_048_576) {
      throw new Error('chat-store: retained candidate byte limit exceeded');
    }
    seen.add(key);
    out.push({ value: candidate.value, kind: candidate.kind });
  }
  return out;
};

const decodeRetainedAliasCandidates = (
  raw: string,
): readonly RetainedAliasCandidate[] => {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('chat-store: invalid retained candidate storage');
  }
  return normalizeRetainedAliasCandidates(
    parsed as readonly RetainedAliasCandidate[],
  );
};

/** AAD binding for chat message content. Binds each ciphertext to its
 *  `(session_id, message_id)` pair so an attacker who reorders rows in
 *  the SQLite file cannot move a `content_encrypted` between rows. The
 *  `v1` sentinel doubles as a versioned label — bumping it lets a
 *  future format re-encode in place without confusion. */
const aadForMessage = (session_id: string, message_id: string): Uint8Array =>
  new TextEncoder().encode(
    `recued/v1/chat/message/${session_id}/${message_id}`,
  );

const aadForMessageField = (
  field: 'candidates' | 'tool_calls',
  session_id: string,
  message_id: string,
): Uint8Array =>
  new TextEncoder().encode(
    `recued/v1/chat/message-${field}/${session_id}/${message_id}`,
  );

/** Sentinel error class thrown when the chat sub-DEK is unavailable
 *  because FileVault is locked / uninitialized. Distinct from generic
 *  decryption failures (which `@recued/crypto` throws with an
 *  `aead: decryption failed` message) so the `messageFromRow`
 *  graceful-degradation path can propagate locked errors while still
 *  swallowing AAD-mismatch / tampered-row cases.
 *
 *  Codex P1 fold (D-137 P1.2 review) — replaces the prior plain
 *  `Error` so caller code can `err instanceof ChatVaultLockedError`
 *  rather than match on a message substring. */
export class ChatVaultLockedError extends Error {
  constructor(detail: string) {
    super(`chat-store: server FileVault is locked, cannot ${detail}`);
    this.name = 'ChatVaultLockedError';
  }
}

const requireChatKey = (getKey: ChatKeyProvider, op: string): Uint8Array => {
  const key = getKey();
  if (!key) {
    throw new ChatVaultLockedError(op);
  }
  return key;
};

/** Encode chat message content for at-rest storage. AEAD-encrypts
 *  under the chat sub-DEK with `(session_id, message_id)` binding
 *  when a key provider is wired through. Falls back to a base64
 *  encoding when none is supplied — covers dbless harnesses + the
 *  KeyManager-not-yet-wired window per the existing `connection-handler`
 *  discipline. */
export const encodeChatContentForStorage = async (
  content: string,
  identity: { session_id: string; message_id: string },
  getKey?: ChatKeyProvider,
): Promise<string> => {
  const plaintext = new TextEncoder().encode(content);
  if (!getKey) {
    return bytesToBase64(plaintext);
  }
  const key = requireChatKey(getKey, 'encrypt chat content');
  const ct = await encrypt(key, plaintext, aadForMessage(
    identity.session_id,
    identity.message_id,
  ));
  return encodeCiphertext(ct);
};

/** Decode chat message content from at-rest ciphertext. The session-
 *  get path calls this once per row when rendering history. AAD must
 *  match the row's `(session_id, message_id)` — moving the blob
 *  between rows fails to decrypt. */
export const decodeChatContentFromStorage = async (
  blob: string,
  identity: { session_id: string; message_id: string },
  getKey?: ChatKeyProvider,
): Promise<string> => {
  if (!getKey) {
    return new TextDecoder().decode(base64ToBytes(blob));
  }
  const key = requireChatKey(getKey, 'decrypt chat content');
  const ct = decodeCiphertext(blob);
  const plaintext = await decrypt(key, ct, aadForMessage(
    identity.session_id,
    identity.message_id,
  ));
  return new TextDecoder().decode(plaintext);
};

const encodeChatMessageFieldForStorage = async (
  plaintextValue: string,
  field: 'candidates' | 'tool_calls',
  identity: { session_id: string; message_id: string },
  getKey?: ChatKeyProvider,
): Promise<string> => {
  const plaintext = new TextEncoder().encode(plaintextValue);
  if (!getKey) return bytesToBase64(plaintext);
  const key = requireChatKey(getKey, `encrypt chat ${field}`);
  const ct = await encrypt(
    key,
    plaintext,
    aadForMessageField(field, identity.session_id, identity.message_id),
  );
  return encodeCiphertext(ct);
};

const decodeChatMessageFieldFromStorage = async (
  blob: string,
  field: 'candidates' | 'tool_calls',
  identity: { session_id: string; message_id: string },
  getKey?: ChatKeyProvider,
): Promise<string> => {
  if (!getKey) return new TextDecoder().decode(base64ToBytes(blob));
  const key = requireChatKey(getKey, `decrypt chat ${field}`);
  const plaintext = await decrypt(
    key,
    decodeCiphertext(blob),
    aadForMessageField(field, identity.session_id, identity.message_id),
  );
  return new TextDecoder().decode(plaintext);
};

/** Exact plaintext-size bound available before AEAD decryption. The encrypted
 * wire adds one 12-byte IV plus one 16-byte GCM tag; the no-key test/boot
 * encoding is raw plaintext base64. Invalid base64 is handled by the caller's
 * normal corrupt-row path. */
const chatStoredPlaintextBytes = (
  blob: string,
  encrypted: boolean,
): number => {
  if (
    blob.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(blob)
  ) {
    throw new Error('chat-store: invalid base64 source field');
  }
  const padding = blob.endsWith('==') ? 2 : blob.endsWith('=') ? 1 : 0;
  const storedBytes = (blob.length / 4) * 3 - padding;
  return encrypted ? Math.max(0, storedBytes - 28) : storedBytes;
};

// ────────────────────────────────────────────────────────────────
// D-137 P1.2 — ChatStore CRUD
// ────────────────────────────────────────────────────────────────

interface SessionRow {
  session_id: string;
  created_at: number;
  last_active_at: number;
  title: string | null;
  picker_state_target: string;
  model_routing_layer: string;
  model_routing_model_hint: string | null;
  model_routing_source_id: string | null;
  model_routing_provider: string | null;
  model_routing_model_id: string | null;
  model_routing_overridden: number;
  archived: number;
  content_revision: number;
}

interface MessageRow {
  message_id: string;
  session_id: string;
  role: string;
  ts: number;
  target_server: string;
  picker_at_send_blob: string;
  model_used_provider: string;
  model_used_model_id: string;
  content_encrypted: string;
  tool_calls_blob: string | null;
  candidates_encrypted: string | null;
  source_lifecycle: string;
  provenance_blob: string | null;
  attachments_blob: string | null;
  metadata_blob: string | null;
  contributor: string | null;
  turn_id: string | null;
}

/** D-213 A2 — the only columns the recall read path may materialize. Keeping
 * this narrower than MessageRow prevents tool/provenance/attachment metadata
 * from becoming an accidental second input to interaction recall. */
type RecallMessageRow = Pick<
  MessageRow,
  'message_id' | 'session_id' | 'role' | 'ts' | 'content_encrypted'
>;

/** D-177 5.f — closed contributor vocabulary for the read-side column
 *  guard. A NULL (pre-stamp row) or off-vocabulary value derives from
 *  role — never trusted as-is. */
const CHAT_CONTRIBUTOR_SET: ReadonlySet<ChatSessionContributor> = new Set([
  'user',
  'model',
  'tool_result',
]);

interface EgressRow {
  message_id: string;
  call_index: number;
  prompt_encrypted: string;
  model_id: string;
  ts: number;
}

/** D-174 R28 Slice A — per-pair global chat-model default config keys. The
 *  persisted value is a `source_id` (`slot_1` | `slot_2` | `free_pool`); the
 *  `free_pool | byok` layer is an INTERNAL resolution detail derived at read
 *  time. `CHAT_DEFAULT_MODEL_PREF_FALLBACK` is the bare comfort layer
 *  the RESOLVED-pref read returns when no default is chosen / the pointed-at
 *  source was removed (a graceful degrade — see `resolveDefaultModelSourceId`). */
const CHAT_DEFAULT_MODEL_PREF_KEY = 'default_model_routing_source_id';
const CHAT_DEFAULT_MODEL_PREF_TS_KEY =
  'default_model_routing_source_id_updated_at';
const CHAT_DEFAULT_MODEL_PREF_FALLBACK: ChatModelRoutingLayer = 'byok';

/** Is the rolling brief carrying context across turns on this server?
 *
 *  ⛔⛔ SERVER-SCOPED IN `chat_config`, NOT A PER-PAIR `prefs` KNOB, and the
 *  scope is forced rather than chosen. The brief is keyed on `session_id` and
 *  `runChatTurn` holds NO peer identity — turns arrive with no paired client at
 *  all over MCP and the D-148 P9 inbound channels — so a per-pair value has
 *  nothing well-defined to resolve to on exactly the turns that matter most.
 *
 *  🔑 DEFAULT ON, and the case is structural rather than statistical.
 *  `CHAT_TAIL_LIMIT` is a fixed 3 ROWS, budget-independent: by turn 5 anything
 *  the user stated that no tool can re-derive is arithmetically absent from the
 *  packet. The brief is the only thing that carries it. Measured on bench 363
 *  (a user-stated figure needed after it ages out): 1/11 answered with the
 *  brief off, 11/13 with it on (one-sided Fisher p = 0.0003) — but the p-value
 *  is decoration on a determinism, not the argument.
 *
 *  ⚠ AND IT IS ~TOKEN-NEUTRAL, which is what makes ON defensible as a DEFAULT
 *  rather than an opt-in. Folds cost 11-14% of input tokens and recover about
 *  as much by shrinking every main turn: measured total input +1% (n=7/55) and
 *  -12% (n=11/13) on the two tasks with usable n. What it does cost is ROUND
 *  TRIPS: +9% to +24% more calls. ⚠ All of that is `qwen3.7-plus`; the weak-tier
 *  cell is unmeasured, and it is the one that could argue for a tier-aware
 *  default rather than a global one. */
const CHAT_ROLLING_BRIEF_KEY = 'rolling_brief_enabled';

/** D-174 R28 Slice A — resolve a persisted default `source_id` to the
 *  `{layer, model_hint}` shape the per-session inheritance path consumes,
 *  reading a LIVE `LLMConfig` snapshot (point-of-use, never stored — a slot's
 *  speed / base_url can change via field-level writes). A slot source always
 *  maps to `layer: 'byok'` (D-191: locality is a display property, not a
 *  routing layer) and carries the slot's `speed` as the § A.14 hint.
 *  `free_pool` carries no hint.
 *
 *  A stale pointer (the chosen slot was removed) or absent config falls back to
 *  the bare comfort layer with NO hint — a graceful degrade: a non-overridden
 *  turn then routes to whatever the bare `byok` layer + default tier resolves
 *  (a remaining slot, or AI_LLM_UNAVAILABLE when none). The Settings picker
 *  independently fail-louds (the stored source is no longer a configured
 *  option) so the user re-picks. NOT honest-fail at the turn — chat keeps
 *  working while a source remains. Pure. */
export const resolveDefaultModelSourceId = (
  config: LLMConfig | undefined,
  source_id: ChatModelSourceId,
): {
  layer: ChatModelRoutingLayer;
  model_hint?: ChatModelHint;
  source_id?: ChatModelSourceId;
} => {
  // D-191 Phase 6 — `source_id` echoes the chosen slot so the inheritance read
  // (`sessionFromRow`) can PIN it. `free_pool` echoes (carries no slot pin); a
  // slot echoes only when it RESOLVES — a stale pointer (slot removed) drops to
  // the bare comfort layer with NO source_id, so no pin survives a gone slot.
  if (source_id === 'free_pool') return { layer: 'free_pool', source_id: 'free_pool' };
  const slot = source_id === 'slot_1' ? config?.slot_1 : config?.slot_2;
  if (!slot) return { layer: CHAT_DEFAULT_MODEL_PREF_FALLBACK };
  return {
    layer: 'byok',
    source_id,
    ...(isChatModelHint(slot.speed) ? { model_hint: slot.speed } : {}),
  };
};

/** Resolve a session row into a `ChatSession`. `defaultPref` is the per-pair
 *  global chat-model default (layer + § A.14 slot hint); a non-overridden
 *  row INHERITS both (resolved at read time so a default change re-applies
 *  uniformly). An overridden row uses its own stored layer + hint + provider
 *  + model_id. */
const sessionFromRow = (
  row: SessionRow,
  defaultPref: {
    layer: ChatModelRoutingLayer;
    model_hint?: ChatModelHint;
    source_id?: ChatModelSourceId;
  },
): ChatSession => {
  const overridden = row.model_routing_overridden !== 0;
  // D-191 — a legacy stored override of `'local'` (force-local routing was
  // retired) normalizes to `'byok'` on read; "local" is no longer a routing
  // layer. Pre-launch → no migration, just coalesce the read.
  const storedLayer: ChatModelRoutingLayer =
    row.model_routing_layer === 'free_pool' ? 'free_pool' : 'byok';
  const current = overridden ? storedLayer : defaultPref.layer;
  // § A.14 slot hint — an overridden row uses its own stored hint; a
  // non-overridden row inherits the global default's hint (same
  // inheritance rule as the layer).
  const model_hint = overridden
    ? isChatModelHint(row.model_routing_model_hint)
      ? row.model_routing_model_hint
      : undefined
    : defaultPref.model_hint;
  // D-191 Phase 6 — the picked slot key. An overridden row uses its own stored
  // `source_id` (when it's a valid `ChatModelSourceId`); a non-overridden row
  // inherits the global default's. The turn pins `slot_1`/`slot_2`; `free_pool`
  // / null → no pin (normal routing).
  const source_id = overridden
    ? isChatModelSourceId(row.model_routing_source_id)
      ? row.model_routing_source_id
      : undefined
    : defaultPref.source_id;
  return {
    id: row.session_id,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    ...(row.title ? { title: row.title } : {}),
    picker_state: { current: row.picker_state_target as ChatPickerTarget },
    model_routing: {
      current,
      ...(model_hint ? { model_hint } : {}),
      ...(source_id ? { source_id } : {}),
      // Provider / model_id are meaningful only on an explicit override.
      // A non-overridden session inherits the global *layer* (Q1: tier
      // only, no provider), so leave them off when inheriting — the PII
      // egress context then derives the provider from the layer rather
      // than reading a stale row value.
      ...(overridden && row.model_routing_provider
        ? { provider: row.model_routing_provider }
        : {}),
      ...(overridden && row.model_routing_model_id
        ? { model_id: row.model_routing_model_id }
        : {}),
      overridden,
    },
    archived: row.archived !== 0,
  };
};

const parseToolCalls = (blob: string | null): ChatToolCall[] | undefined => {
  if (!blob) return undefined;
  try {
    const parsed = JSON.parse(blob) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatToolCall[]) : undefined;
  } catch {
    return undefined;
  }
};

const parseProvenance = (blob: string | null): ChatProvenanceRef[] | undefined => {
  if (!blob) return undefined;
  try {
    const parsed = JSON.parse(blob) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatProvenanceRef[]) : undefined;
  } catch {
    return undefined;
  }
};

const parseAttachments = (
  blob: string | null,
): ChatMessageAttachment[] | undefined => {
  if (!blob) return undefined;
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const attachments = parsed.filter((item): item is ChatMessageAttachment => {
      if (item === null || typeof item !== 'object') return false;
      const candidate = item as Record<string, unknown>;
      return (
        typeof candidate.file_id === 'string'
        && candidate.file_id.length > 0
        && typeof candidate.media_class === 'string'
        && candidate.media_class.length > 0
      );
    });
    return attachments.length > 0 ? attachments : undefined;
  } catch {
    return undefined;
  }
};

const parseDataDiagnosis = (
  blob: string | null,
): ChatDataDiagnosisContext | undefined => {
  if (!blob) return undefined;
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const value = (parsed as { data_diagnosis?: unknown }).data_diagnosis;
    if (value === null || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.kind !== 'data_verification'
      || typeof candidate.plan_id !== 'string'
      || candidate.plan_id.length === 0
      || typeof candidate.run_id !== 'string'
      || candidate.run_id.length === 0
      || (
        candidate.intent !== undefined
        && !isChatDataDiagnosisIntent(candidate.intent)
      )
      || (
        candidate.run_correlation !== 'matched'
        && candidate.run_correlation !== 'unverified'
      )
      || (
        candidate.relationship !== undefined
        && !isChatDataDiagnosisRelationship(candidate.relationship)
      )
    ) return undefined;
    return {
      kind: 'data_verification',
      plan_id: candidate.plan_id,
      run_id: candidate.run_id,
      // Rows written before explicit intent existed were explanation turns.
      // Preserve that durable meaning rather than dropping their grounding.
      intent: isChatDataDiagnosisIntent(candidate.intent)
        ? candidate.intent
        : 'explanation',
      run_correlation: candidate.run_correlation,
      ...(isChatDataDiagnosisRelationship(candidate.relationship)
        ? { relationship: candidate.relationship }
        : {}),
    };
  } catch {
    return undefined;
  }
};

const parseDataDiagnosisResolution = (
  blob: string | null,
): ChatDataDiagnosisResolution | undefined => {
  if (!blob) return undefined;
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const value = (
      parsed as { data_diagnosis_resolution?: unknown }
    ).data_diagnosis_resolution;
    if (value === null || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      !isChatDataDiagnosisResolutionStatus(candidate.status)
      || typeof candidate.resolved_at !== 'number'
      || !Number.isFinite(candidate.resolved_at)
    ) return undefined;
    return {
      status: candidate.status,
      resolved_at: candidate.resolved_at,
    };
  } catch {
    return undefined;
  }
};

const parseMessageMetadataObject = (
  blob: string | null,
): Record<string, unknown> => {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(blob) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const parsePickerAtSend = (
  blob: string,
): ChatMessage['picker_at_send'] | null => {
  try {
    const parsed = JSON.parse(blob) as ChatMessage['picker_at_send'];
    if (
      parsed
      && typeof parsed === 'object'
      && typeof (parsed as { display_name?: unknown }).display_name === 'string'
      && typeof (parsed as { signature?: unknown }).signature === 'object'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

/** Per-message decoded view. The store decrypts `content_encrypted`
 *  inline so callers handle one consistent shape; rows whose AAD
 *  doesn't validate surface as empty content rather than throwing, so
 *  a single corrupted row doesn't sink the whole conversation fetch.
 *
 *  **Codex P1 fold (D-137 P1.2 review).** Locked-vault errors (the
 *  `ChatVaultLockedError` class above) propagate up — silently
 *  returning empty content on a locked server would let
 *  `chat.session.get` / export return blank message bodies that
 *  *look* like valid empty conversation history. Only AAD-mismatch /
 *  tampered-row decode failures (the `aead: decryption failed` path)
 *  degrade gracefully. */
const messageFromRow = async (
  row: MessageRow,
  getKey?: ChatKeyProvider,
): Promise<ChatMessage> => {
  const role: ChatMessageRole = isChatMessageRole(row.role)
    ? row.role
    : 'system';
  let content = '';
  try {
    const stored = await decodeChatContentFromStorage(
      row.content_encrypted,
      { session_id: row.session_id, message_id: row.message_id },
      getKey,
    );
    content = decodeStoredPromptParts(stored, role).primary.text;
  } catch (err) {
    if (err instanceof ChatVaultLockedError) {
      // Operational failure — vault is locked; the caller must see
      // the locked signal so it can refuse the rpc with a clear
      // status rather than render blank message bodies.
      throw err;
    }
    // Corrupted / cross-binding row — surface as empty content rather
    // than aborting the whole history fetch. The renderer shows a
    // diagnostic placeholder; the audit log captures the read failure.
    content = '';
  }
  const picker = parsePickerAtSend(row.picker_at_send_blob) ?? {
    display_name: 'unknown',
    signature: {
      server_kind: 'recued' as const,
      version: '0',
      instance_id: 'unknown',
    },
  };
  let tool_calls: ChatToolCall[] | undefined;
  if (row.tool_calls_blob !== null) {
    try {
      const storedToolCalls = await decodeChatMessageFieldFromStorage(
        row.tool_calls_blob,
        'tool_calls',
        { session_id: row.session_id, message_id: row.message_id },
        getKey,
      );
      tool_calls = parseToolCalls(storedToolCalls);
    } catch (err) {
      if (err instanceof ChatVaultLockedError) throw err;
      tool_calls = undefined;
    }
  }
  const provenance = parseProvenance(row.provenance_blob);
  const tool_call = chatToolCallFromMetadata(row.metadata_blob);
  const attachments = parseAttachments(row.attachments_blob);
  const data_diagnosis = parseDataDiagnosis(row.metadata_blob);
  const data_diagnosis_resolution =
    parseDataDiagnosisResolution(row.metadata_blob);
  return {
    id: row.message_id,
    session_id: row.session_id,
    role,
    content,
    target_server: row.target_server as ChatPickerTarget,
    picker_at_send: picker,
    model_used: {
      provider: row.model_used_provider,
      model_id: row.model_used_model_id,
    },
    ...(tool_calls ? { tool_calls } : {}),
    ...(tool_call ? { tool_call } : {}),
    ...(provenance ? { provenance } : {}),
    ...(attachments ? { attachments } : {}),
    ...(data_diagnosis ? { data_diagnosis } : {}),
    ...(data_diagnosis_resolution
      ? { data_diagnosis_resolution }
      : {}),
    contributor: CHAT_CONTRIBUTOR_SET.has(
      row.contributor as ChatSessionContributor,
    )
      ? (row.contributor as ChatSessionContributor)
      : contributorForChatRole(role),
    ...(typeof row.turn_id === 'string' && row.turn_id.length > 0
      ? { turn_id: row.turn_id }
      : {}),
    ts: row.ts,
  };
};

/** Input shape for `chatStore.createSession`. The caller mints the
 *  `id` (orchestrator uses a UUID v4 today) so insert + immediate
 *  follow-up `chat_messages` writes share the same key without a
 *  round-trip. */
export interface CreateSessionInput {
  id: string;
  title?: string;
  /** Defaults to `Date.now()`. */
  now?: number;
  picker_state?: { current: ChatPickerTarget };
  model_routing?: ChatSession['model_routing'];
}

/** Input shape for `chatStore.appendMessage`. The caller passes plain
 *  content; the store handles AEAD encryption before insert. */
export interface AppendMessageInput {
  /** Host-owned lifecycle metadata; payloads stay in encrypted content. */
  tool_call?: StoredChatToolCall;
  /** Atomically close the originating call with this result row. */
  tool_call_settlements?: readonly ChatToolCallSettlement[];
  /** D-137 — the pair key for a two-event tool call: the dispatch row and the
   *  result row that eventually answers it share one `run_id`.
   *
   *  ⛔ ABSENT for a synchronous call, which is ONE event and pairs with
   *  nothing. Setting it there would invite a sibling fetch that can never
   *  succeed and would read, to whoever debugged it, as a missing row. */
  readonly pair_id?: string;
  id: string;
  session_id: string;
  role: ChatMessageRole;
  content: string;
  target_server: ChatPickerTarget;
  picker_at_send: { display_name: string; signature: RecuedServerSignature };
  model_used: { provider: string; model_id: string };
  /** D-213 A0 — the live, channel-minted source for this durable row.
   *  Optional only so an absent/unknown producer can be stamped ineligible
   *  rather than widening recall by default. */
  execution_source?: ExecutionSource;
  /** Defaults to `Date.now()`. */
  ts?: number;
  tool_calls?: ChatToolCall[];
  /** D-213 Track B — flat schema-attested values retained beside the primary
   * content under separate AEAD. */
  retained_alias_candidates?: readonly RetainedAliasCandidate[];
  /** User rows on owner chat default to pending; all other rows default to
   * finalized. Explicit use is reserved for the framework source finalizer. */
  source_lifecycle?: RecallSourceLifecycle;
  provenance?: ChatProvenanceRef[];
  attachments?: ChatMessageAttachment[];
  /** Server-normalized, evidence-only diagnosis grounding. Stored in the
   * existing message metadata column so both turn rows survive hydration. */
  data_diagnosis?: ChatDataDiagnosisContext;
  /** The turn writing this row. Optional so a caller outside a turn (or an
   *  older one not yet passing it) writes NULL rather than a fabricated id. */
  turn_id?: string;
}

export interface ChatPiiSourceRow {
  readonly message_id: string;
  readonly content: string;
  readonly candidates: readonly RetainedAliasCandidate[];
  readonly source_lifecycle: Exclude<RecallSourceLifecycle, 'pending'>;
}

export interface ChatPiiSourceHarvest {
  readonly session_id: string;
  readonly content_revision: number;
  readonly rows: readonly ChatPiiSourceRow[];
  /** A pending, unreadable, row/byte/candidate cutoff weakens enhancement
   * coverage but never makes returned raw bytes eligible for egress. */
  readonly partial: boolean;
  readonly decrypted_rows: number;
  readonly decrypted_bytes: number;
  /** Private keyset frontier for a later bounded pass. This is scan progress,
   * not a completeness assertion and never leaves the local coordinator. */
  readonly next_cursor?: ChatRecallSourceCursor;
}

/** D-213 A0 — plaintext metadata used to exclude non-owner rows before
 * decrypting chat content. The value deliberately carries both the originating
 * channel and owner-authentication outcome for the two durable chat surfaces.
 * Every other source, including an absent or malformed one, fails closed. */
export const CHAT_MESSAGE_RECALL_ELIGIBILITY = {
  OWNER_AUTHENTICATED_CHAT: 'chat:owner_authenticated',
  UNAUTHENTICATED_CHAT: 'chat:not_owner_authenticated',
  UNAUTHENTICATED_MESSENGER: 'messenger:not_owner_authenticated',
  INELIGIBLE: 'ineligible',
} as const;

export type ChatMessageRecallEligibility =
  (typeof CHAT_MESSAGE_RECALL_ELIGIBILITY)[keyof typeof CHAT_MESSAGE_RECALL_ELIGIBILITY];

export const deriveChatMessageRecallEligibility = (
  source: unknown,
): ChatMessageRecallEligibility => {
  if (!isExecutionSource(source)) {
    return CHAT_MESSAGE_RECALL_ELIGIBILITY.INELIGIBLE;
  }
  if (source.channel === 'messenger') {
    // Messenger authenticates the bound conversation, not its sender.
    return CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_MESSENGER;
  }
  if (source.channel !== 'chat') {
    return CHAT_MESSAGE_RECALL_ELIGIBILITY.INELIGIBLE;
  }
  return source.actor === 'user_self' && !executionSourceHasContract(source)
    ? CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT
    : CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_CHAT;
};

/** One tool row the packet may ADVERTISE as recallable. Deliberately carries
 *  the rendered row and nothing derived: the tool name is parsed where it is
 *  rendered (`renderToolRow`'s own module), so the write and the read of that
 *  format stay in one place and can be round-tripped by a single test. */
export interface ChatRecallableToolPointer {
  readonly item_id: string;
  readonly content: string;
  readonly turn_id: string | null;
  readonly ts: number;
}

/** D-213 A2 — private storage cursor. It is authenticated and sealed before
 * becoming a public continuation and is never accepted directly from model
 * input. */
export interface ChatRecallSourceCursor {
  readonly ts: number;
  readonly message_id: string;
}

/** One authoritative encrypted message after a bounded local read. A corrupt
 * or locked row keeps only its private locator so coverage can degrade without
 * accidentally treating empty plaintext as a valid source. */
export type ChatRecallSourceRow =
  | {
      readonly readable: true;
      readonly item_id: string;
      readonly session_id: string;
      readonly kind: 'user' | 'assistant' | 'tool';
      readonly timestamp: number;
      readonly content: string;
    }
  | {
      readonly readable: false;
      readonly item_id: string;
      readonly session_id: string;
      readonly kind: 'user' | 'assistant' | 'tool';
      readonly timestamp: number;
    };

/** The storage-side corpus selector: WHICH bucket, and WHOSE rows within it.
 *
 *  ⛔⛔ THE PAIR TRAVELS TOGETHER ON PURPOSE. Splitting it — bucket here,
 *  contract elsewhere — is what makes a contract-scoped read able to disagree
 *  with itself: the eligibility says "written under a contract" and the id says
 *  "which", and nothing then guarantees they describe the same dispatch.
 *  Callers never author this; they hand over a resolved scope
 *  (`chat-recall-scope.ts`) and it is projected here.
 *
 *  ⛔ `recall_contract_id: null` is legal ONLY for the owner bucket. The door
 *  bucket with a null id would match every LEGACY row — those written before
 *  the column existed, which carry NULL and have no recoverable owner. That is
 *  the fail-open shape this whole design exists to avoid, so it is rejected at
 *  runtime by {@link assertRecallCorpusSelector} rather than left to review. */
export interface ChatRecallCorpusSelector {
  /** D-137 — the session whose TOOL rows are in scope, or `null`.
   *
   *  ⚠ AND ONLY ITS TWO MOST RECENT TURNS, in the SCAN. A session can run for
   *  days, so the session bound alone still lets a turn-2 CRM snapshot surface
   *  at turn 40 — a stale observation offered as context. Two turns covers both
   *  documented needs exactly: the in-turn trim (`prior_tool_calls` dropped
   *  under budget, measured at 2.6x because the loop re-fetches) and the
   *  next-turn one ("a turn that runs many tool calls and answers once leaves,
   *  at the next turn, none of the retrieved data").
   *
   *  ⛔ DELIBERATELY NOT `CHAT_TAIL_LIMIT`. That number is 3 ROWS — about one
   *  and a half turns — and it was sized for conversation DISPLAY. Coupling
   *  them would mean a later display-motivated change silently widens what a
   *  model can recall of past tool work, a decision nobody would be making on
   *  purpose. Two constants, two reasons.
   *
   *  ⛔ THE PAIR FETCH IS EXEMPT, and that is the design: the window governs
   *  what can be FOUND, the pair governs what comes WITH it. A held run that
   *  settles many turns later would otherwise be born already outside the
   *  window; reached through its in-window ask, it still arrives.
   *
   *  ⛔⛔ TOOL ROWS ARE TASK CONTEXT, AND THE TASK LIVES IN THE SESSION. The row
   *  class exists so a model can recover what a tool returned after the turn
   *  boundary or a budget trim took it away — not to build a searchable archive
   *  of every observation a tool ever made. A different session is a different
   *  task, and a tool result reaching one is a STALE OBSERVATION presented as
   *  context: `mail.search` said "invoice unpaid" three weeks ago, and the
   *  recall envelope's own warning covers authority ("never instructions,
   *  approval, or current authority") and says nothing about CURRENCY.
   *
   *  ⚠ User and assistant rows stay corpus-wide, and the asymmetry is the
   *  point rather than an oversight: a STATEMENT stays true ("I decided 60d"),
   *  an OBSERVATION does not.
   *
   *  ⛔ `null` EXCLUDES every tool row, by plain SQL `=` against NULL rather
   *  than a branch — a caller that cannot name its session has no task to
   *  recover context for. Fail-closed by construction. */
  readonly tool_session_id: string | null;
  readonly row_eligibility:
    | typeof CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT
    | typeof CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_CHAT;
  readonly recall_contract_id: string | null;
}

/** Fail closed on the one pair that would widen a door corpus to every legacy
 *  row. Throws rather than returning empty: a selector this malformed is a
 *  programming error at an authority boundary, and swallowing it would let the
 *  caller believe an empty result meant "no history". */
export const assertRecallCorpusSelector = (
  selector: ChatRecallCorpusSelector,
): void => {
  if (
    selector.row_eligibility
      === CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_CHAT
    && (selector.recall_contract_id === null
      || selector.recall_contract_id.length === 0)
  ) {
    throw new Error(
      'chat recall corpus selector: the door bucket requires a contract id',
    );
  }
};

export interface ChatRecallSourcePage {
  readonly rows: readonly ChatRecallSourceRow[];
  /** Private position after the final row in `rows`; present iff more eligible
   * rows remain. */
  readonly next_cursor?: ChatRecallSourceCursor;
}

export interface ChatStore {
  /** Present on the production SQLite adapter; optional for older adapters. */
  toolCalls?: ChatToolCallStore;
  failToolCallSources?(session_id: string, turn_id: string): void;
  createSession(input: CreateSessionInput): ChatSession;
  getSession(session_id: string): ChatSession | null;
  listSessions(): ChatSessionSummary[];
  setPicker(session_id: string, target: ChatPickerTarget, now?: number): boolean;
  setModelPref(
    session_id: string,
    model_routing: ChatSession['model_routing'],
    now?: number,
  ): boolean;
  /** D-167 — drop a session's explicit model-pref override; it reverts to
   *  inheriting the per-pair global default. */
  clearModelPref(session_id: string, now?: number): boolean;
  /** D-167 / D-174 R28 Slice A — read the per-pair global chat-model default
   *  RESOLVED to the `{layer, model_hint}` shape a non-overridden session
   *  inherits, derived from the persisted `source_id` against the live LLM
   *  config (injected `getLlmConfig`). Comfort fallback `'local'` / no hint /
   *  `0` when unset or the pointed-at source was removed (a graceful degrade —
   *  see `resolveDefaultModelSourceId`). This is the INHERITANCE read —
   *  `sessionFromRow` consumes it. */
  getDefaultModelPref(): {
    layer: ChatModelRoutingLayer;
    model_hint?: ChatModelHint;
    updated_at: number;
  };
  /** D-174 R28 Slice A — read the RAW persisted default `source_id` (the
   *  slot-faithful form the Settings picker selects by exact id). `null` when
   *  no default is chosen yet (no provider). The RPC `chat.default_model_pref
   *  .get` returns this; the resolved-layer view is `getDefaultModelPref`. */
  getDefaultModelSourceId(): {
    source_id: ChatModelSourceId | null;
    updated_at: number;
  };
  /** D-174 R28 Slice A — write the per-pair global chat-model default as a
   *  `source_id`. Applies to every non-overridden session (resolved at read
   *  time against the live LLM config). */
  setDefaultModelSourceId(
    source_id: ChatModelSourceId,
    now?: number,
  ): { source_id: ChatModelSourceId; updated_at: number };
  /** Is the rolling brief enabled on this server? Server-scoped; see
   *  `CHAT_ROLLING_BRIEF_KEY`. Absent / malformed stored value reads `false`,
   *  so an un-migrated or corrupt row degrades to today's behaviour rather
   *  than silently switching a context-carrying feature on. */
  getRollingBriefEnabled(): boolean;
  setRollingBriefEnabled(enabled: boolean): boolean;
  /** The session's carried brief, decrypted. `null` when none is stored, and
   *  ALSO when the stored blob cannot be decoded — a brief that cannot be read
   *  is indistinguishable from no brief for every consumer, and surfacing a
   *  decode error into the turn would fail a conversation over lost context
   *  rather than continuing unbriefed. */
  readSessionBrief(session_id: string): Promise<string | null>;
  writeSessionBrief(session_id: string, brief_json: string, now?: number): Promise<void>;
  deleteSessionBrief(session_id: string): void;
  setTitle(session_id: string, title: string, now?: number): boolean;
  setArchived(session_id: string, archived: boolean, now?: number): boolean;
  bumpSessionLastActiveAt(session_id: string, now?: number): boolean;
  deleteSession(session_id: string): boolean;
  appendMessage(input: AppendMessageInput): Promise<ChatMessage>;
  /** Record that the owner has now seen this session's messages. Idempotent;
   *  a no-op for a session id that does not exist. */
  markSessionSeen(session_id: string): void;
  /** One bounded page of a conversation, newest-last. See `listMessagePage`. */
  listMessagePage(
    session_id: string,
    limit: number,
    before?: ChatHistoryCursor,
  ): Promise<{
    messages: ChatMessage[];
    has_more: boolean;
    oldest?: ChatHistoryCursor;
  }>;
  listMessages(session_id: string): Promise<ChatMessage[]>;
  /** The most recent `limit` conversational messages, oldest-first.
   *
   *  ⛔ WHY THIS EXISTS AS A SEPARATE READ. `buildChatTail` runs on EVERY turn
   *  and needs the last `CHAT_TAIL_LIMIT` (3) user/assistant messages — but it
   *  got them by calling `listMessages`, which reads AND DECRYPTS every message
   *  in the session. Per-turn cost therefore grew with conversation length:
   *  measured on an encrypted realm, 0.2ms at 10 turns, 3.2ms at 500, 12.3ms at
   *  2000 — all to use three of them.
   *
   *  Role filtering happens in SQL too: the tail wants only user/assistant
   *  rows, so a session heavy in tool/system rows would otherwise need a much
   *  larger fetch to find three conversational ones.
   *
   *  ⚠ Returns OLDEST-FIRST, matching `listMessages`, so callers keep the same
   *  ordering contract. The `DESC` in the query is only how the tail is
   *  selected. */
  listRecentConversational(
    session_id: string,
    limit: number,
  ): Promise<ChatMessage[]>;
  /** Complete the crash-visible pending user source and atomically advance the
   * store-owned session content revision. */
  finalizeMessageSource?(
    input: {
      readonly session_id: string;
      readonly message_id: string;
      readonly candidates: readonly RetainedAliasCandidate[];
    },
  ): Promise<boolean>;
  /** Close a pending source honestly when candidate finalization failed. */
  failMessageSource?(
    session_id: string,
    message_id: string,
  ): boolean;
  /** Exact-session source read used only by the X1-authorized PII coordinator. */
  harvestPiiSources?(
    input: {
      readonly session_id: string;
      /** Private store-issued frontier used only to advance a monotonic
       * historical-session refresh. The current session starts fresh. */
      readonly after?: ChatRecallSourceCursor;
      /** D-213 §3.8 — inclusive upper bound for a JOIN prefix read. A recalled
       * piece needs the values attested in its session UP TO its own row: a row
       * may mention someone first attested several rows earlier, and oldest-first
       * is what makes that prefix stable. Rows after the matched one are not the
       * recalled piece and must not cross. */
      readonly until?: ChatRecallSourceCursor;
      readonly max_rows: number;
      readonly max_bytes: number;
      readonly max_candidates: number;
      /** Remaining coordinator wall-clock budget. The store checks it between
       * rows and split-column decryptions; the caller also owns a hard timeout. */
      readonly max_ms?: number;
    },
  ): Promise<ChatPiiSourceHarvest>;
  /** The tool rows the packet may advertise as recallable, under the same
   *  corpus + window the scan applies. Optional for fake/older adapters. */
  listRecallableToolPointers?(
    input: ChatRecallCorpusSelector & {
      readonly exclude_turn_id?: string | null;
      readonly limit: number;
    },
  ): Promise<ReadonlyArray<ChatRecallableToolPointer>>;
  /** D-213 A2 — newest-first authoritative interaction-source page. Optional
   * only for rolling compatibility with fake/older adapters; production
   * `createChatStore` always implements it. */
  scanRecallMessagesPage?(
    input: {
      readonly row_eligibility: ChatRecallCorpusSelector['row_eligibility'];
      readonly recall_contract_id: ChatRecallCorpusSelector['recall_contract_id'];
      readonly tool_session_id: ChatRecallCorpusSelector['tool_session_id'];
      readonly after?: ChatRecallSourceCursor;
      readonly limit: number;
    },
  ): Promise<ChatRecallSourcePage>;
  /** D-213 A2 — exact source lookup under the same positive row scope. */
  /** Messages adjacent to an anchor within its own session — the reply
   *  direction (`next`) or the context direction (`prev`). Same eligibility
   *  predicate as `getRecallMessage`, so it cannot widen recall's scope. */
  getRecallNeighbours?(
    input: {
      readonly row_eligibility: ChatRecallCorpusSelector['row_eligibility'];
      readonly recall_contract_id: ChatRecallCorpusSelector['recall_contract_id'];
      readonly tool_session_id: ChatRecallCorpusSelector['tool_session_id'];
      readonly item_id: string;
      readonly next?: number;
      readonly prev?: number;
    },
  ): Promise<ChatRecallSourceRow[]>;
  /** D-137 — the paired half of a two-event tool call. Optional so a backend
   *  without it degrades to unpaired matches rather than failing. */
  getRecallPair?(
    input: {
      readonly row_eligibility: ChatRecallCorpusSelector['row_eligibility'];
      readonly recall_contract_id: ChatRecallCorpusSelector['recall_contract_id'];
      readonly tool_session_id: ChatRecallCorpusSelector['tool_session_id'];
      readonly item_id: string;
    },
  ): Promise<ChatRecallSourceRow[]>;
  getRecallMessage?(
    input: {
      readonly row_eligibility: ChatRecallCorpusSelector['row_eligibility'];
      readonly recall_contract_id: ChatRecallCorpusSelector['recall_contract_id'];
      readonly tool_session_id: ChatRecallCorpusSelector['tool_session_id'];
      readonly item_id: string;
    },
  ): Promise<ChatRecallSourceRow | null>;
  /** Patch an assistant safe-check row with the owner's latest explicit
   * closure choice while preserving all other message metadata. Optional for
   * rolling compatibility with older store adapters. Returns null when the
   * row is absent or is not itself a durable assistant safe-check answer. */
  setDataDiagnosisResolution?(
    session_id: string,
    message_id: string,
    resolution: ChatDataDiagnosisResolution,
  ): Promise<ChatMessage | null>;
  /** Persist the aliased model-bound prompt(s) sent for an assistant turn —
   *  the "what we sent" egress history, one packet per AI call. Encrypted at
   *  rest; cascades on message delete. */
  appendEgress(
    session_id: string,
    message_id: string,
    packets: ReadonlyArray<ChatEgressPacket>,
  ): Promise<void>;
  /** Read back a message's egress packets (decrypted), ordered by call. */
  getEgress(session_id: string, message_id: string): Promise<ChatEgressPacket[]>;
}

/** Build the chat store CRUD layer over the schema landed by
 *  `ensureChatSchema`. The store does NOT call `ensureChatSchema` —
 *  bin.ts has already run it at boot.
 *
 *  D-174 R28 Slice A — `getLlmConfig` is a per-use LIVE LLM-config getter
 *  (wired at `composeChatOrchestrator` off `llmManager.getConfig()`), used by
 *  `getDefaultModelPref` to resolve the persisted `source_id` to a concrete
 *  `{layer, model_hint}` at read time. Absent / returns undefined (db-less /
 *  locked) → every slot source falls back to the bare comfort layer. */
/** The tool-row recall window, in TURNS, and the SQL that applies it.
 *
 *  ⛔ ONE RULE, TWO READERS. `scanRecallMessagesStmt` decides what a search can
 *  FIND; `listToolPointersStmt` decides what the packet ADVERTISES as findable.
 *  If those ever disagree the pointer names a row the scan cannot reach and the
 *  model is sent looking for something that is not there -- strictly worse than
 *  no pointer, because a fruitless search still costs a round trip and reads to
 *  the model as "the store is empty". They therefore share this exact text
 *  rather than each spelling out a `LIMIT 2`. */
export const TOOL_ROW_RECALL_TURN_WINDOW = 2;

const RECENT_TOOL_TURN_WINDOW_SQL = `
           turn_id IN (
             SELECT turn_id FROM chat_messages
              WHERE session_id = @tool_session_id AND turn_id IS NOT NULL
                AND recall_eligibility = @row_eligibility
                AND recall_contract_id IS @recall_contract_id
              GROUP BY turn_id ORDER BY MAX(ts) DESC
              LIMIT ${TOOL_ROW_RECALL_TURN_WINDOW}
           )`;

export const createChatStore = (
  db: Database.Database,
  getKey?: ChatKeyProvider,
  getLlmConfig?: () => LLMConfig | undefined,
): ChatStore => {
  const insertSessionStmt = db.prepare(`
    INSERT INTO chat_sessions (
      session_id, created_at, last_active_at, title,
      picker_state_target, model_routing_layer, model_routing_model_hint,
      model_routing_source_id, model_routing_provider, model_routing_model_id,
      model_routing_overridden, archived, last_seen_message_count
    ) VALUES (
      @session_id, @created_at, @last_active_at, @title,
      @picker_state_target, @model_routing_layer, @model_routing_model_hint,
      @model_routing_source_id, @model_routing_provider, @model_routing_model_id,
      -- 0, not NULL: a session born after this column exists is markable from
      -- its first message. NULL is reserved for the sessions that predate it.
      @model_routing_overridden, 0, 0
    )
  `);
  const getSessionStmt = db.prepare<{ session_id: string }>(
    `SELECT * FROM chat_sessions WHERE session_id = @session_id`,
  );
  const markSessionSeenStmt = db.prepare<{ session_id: string }>(`
    UPDATE chat_sessions
       SET last_seen_message_count = (
             SELECT COUNT(*) FROM chat_messages m
              WHERE m.session_id = chat_sessions.session_id
           )
     WHERE session_id = @session_id
  `);
  const listSessionsStmt = db.prepare(`
    SELECT s.*, (
      SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.session_id
    ) AS message_count
    FROM chat_sessions s
    ORDER BY s.last_active_at DESC
  `);
  const setPickerStmt = db.prepare(`
    UPDATE chat_sessions
       SET picker_state_target = @target,
           last_active_at = @now
     WHERE session_id = @session_id
  `);
  const setModelStmt = db.prepare(`
    UPDATE chat_sessions
       SET model_routing_layer = @layer,
           model_routing_model_hint = @model_hint,
           model_routing_source_id = @source_id,
           model_routing_provider = @provider,
           model_routing_model_id = @model_id,
           model_routing_overridden = 1,
           last_active_at = @now
     WHERE session_id = @session_id
  `);
  // D-167 chat provider-threading — clear a session's explicit override so
  // it reverts to inheriting the per-pair global default. Nulls the stored
  // provider / model_id so no stale override value lingers under the
  // inherited layer.
  const clearModelStmt = db.prepare(`
    UPDATE chat_sessions
       SET model_routing_overridden = 0,
           model_routing_model_hint = NULL,
           model_routing_source_id = NULL,
           model_routing_provider = NULL,
           model_routing_model_id = NULL,
           last_active_at = @now
     WHERE session_id = @session_id
  `);
  const getConfigStmt = db.prepare<{ key: string }>(
    `SELECT value FROM chat_config WHERE key = @key`,
  );
  const setConfigStmt = db.prepare(
    `INSERT OR REPLACE INTO chat_config (key, value) VALUES (@key, @value)`,
  );
  const setTitleStmt = db.prepare(`
    UPDATE chat_sessions
       SET title = @title,
           last_active_at = @now
     WHERE session_id = @session_id
  `);
  const setArchivedStmt = db.prepare(`
    UPDATE chat_sessions
       SET archived = @archived,
           last_active_at = @now
     WHERE session_id = @session_id
  `);
  const touchStmt = db.prepare(`
    UPDATE chat_sessions
       SET last_active_at = @now
     WHERE session_id = @session_id
  `);
  const deleteSessionStmt = db.prepare(`
    DELETE FROM chat_sessions WHERE session_id = @session_id
  `);
  const insertMessageStmt = db.prepare(`
    INSERT INTO chat_messages (
      message_id, session_id, role, ts, target_server,
      picker_at_send_blob, model_used_provider, model_used_model_id,
      content_encrypted, tool_calls_blob, candidates_encrypted,
      source_lifecycle, provenance_blob, attachments_blob,
      metadata_blob, contributor, recall_eligibility, recall_contract_id, pair_id, turn_id
    ) VALUES (
      @message_id, @session_id, @role, @ts, @target_server,
      @picker_at_send_blob, @model_used_provider, @model_used_model_id,
      @content_encrypted, @tool_calls_blob, @candidates_encrypted,
      @source_lifecycle, @provenance_blob, @attachments_blob,
      @metadata_blob, @contributor, @recall_eligibility, @recall_contract_id, @pair_id, @turn_id
    )
  `);
  const bumpContentRevisionStmt = db.prepare(`
    UPDATE chat_sessions
       SET content_revision = content_revision + 1
     WHERE session_id = @session_id
  `);
  const getContentRevisionStmt = db.prepare(`
    SELECT content_revision
      FROM chat_sessions
     WHERE session_id = @session_id
  `);
  const finalizeMessageSourceStmt = db.prepare(`
    UPDATE chat_messages
       SET candidates_encrypted = @candidates_encrypted,
           source_lifecycle = 'finalized'
     WHERE session_id = @session_id
       AND message_id = @message_id
       AND source_lifecycle = 'pending'
  `);
  const failMessageSourceStmt = db.prepare(`
    UPDATE chat_messages
       SET candidates_encrypted = NULL,
           source_lifecycle = 'failed'
     WHERE session_id = @session_id
       AND message_id = @message_id
       AND source_lifecycle = 'pending'
  `);
  const listPendingSourceRowsStmt = db.prepare(`
    SELECT session_id, message_id
      FROM chat_messages
     WHERE source_lifecycle = 'pending'
       AND (@session_id IS NULL OR session_id = @session_id)
  `);
  // ⚠ TOOL ROWS ARE HARVESTED, DELIBERATELY. This statement feeds BOTH the P9
  // alias-slot ordering and the Track B candidate reharvest, and a tool row
  // carries candidates like any other — excluding it would give the historical
  // values inside a tool result allocation-order alias numbers instead of
  // stable ones, and leave them unprotected when the row is recalled.
  //
  // ⛔ Safe for P9 because the walk is OLDEST-FIRST and tool rows only ever
  // APPEND: a session that predates this class keeps its existing prefix, so
  // nothing renumbers. (A row inserted MID-prefix would renumber everything
  // after it — which is why the `pending` skip is the standing hazard here and
  // a new row class at the tail is not.)
  // ⚠ They do consume the harvest budget faster: ~7x a chat row at the median.
  const harvestPiiSourceRowsStmt = db.prepare(`
    SELECT message_id, session_id, role, ts, content_encrypted,
           candidates_encrypted, source_lifecycle
      FROM chat_messages
     WHERE session_id = @session_id
       AND recall_eligibility = @row_eligibility
       AND role IN ('user', 'assistant', 'tool')
       AND (
         @after_ts IS NULL
         OR ts > @after_ts
         OR (ts = @after_ts AND message_id > @after_message_id)
       )
       AND (
         @until_ts IS NULL
         OR ts < @until_ts
         OR (ts = @until_ts AND message_id <= @until_message_id)
       )
     ORDER BY ts ASC, message_id ASC
     LIMIT @limit
  `);
  const listMessagesStmt = db.prepare<{ session_id: string }>(
    `SELECT * FROM chat_messages WHERE session_id = @session_id ORDER BY ts ASC, message_id ASC`,
  );
  /** The newest page. DESC + LIMIT so SQLite walks the tail of the
   *  `(session_id, ts)` index instead of materializing the whole conversation
   *  and throwing away the front of it. Reversed to display order by the
   *  caller, which is cheap on a bounded array. */
  const listMessagesTailStmt = db.prepare<{
    session_id: string;
    limit: number;
  }>(
    `SELECT * FROM chat_messages
      WHERE session_id = @session_id
      ORDER BY ts DESC, message_id DESC
      LIMIT @limit`,
  );
  /** An older page. ⛔ The predicate is the LEXICOGRAPHIC pair, not `ts <`:
   *  timestamps are not unique here (the wordless-drop reply is written in the
   *  same millisecond as the message it answers), so a ts-only cursor drops
   *  every row that shares the boundary ts, and `ts <=` repeats them forever. */
  const listMessagesBeforeStmt = db.prepare<{
    session_id: string;
    ts: number;
    message_id: string;
    limit: number;
  }>(
    `SELECT * FROM chat_messages
      WHERE session_id = @session_id
        AND (ts < @ts OR (ts = @ts AND message_id < @message_id))
      ORDER BY ts DESC, message_id DESC
      LIMIT @limit`,
  );
  // The two-turn window is computed WITHIN the corpus, not across the session.
  // The outer predicate already stops a door reading an owner row (P10), so a
  // session-wide window leaks nothing -- it silently UNDER-reaches: whichever
  // corpus is chattier takes both turn slots and the other stops finding its
  // own recent tool rows, which reads exactly like "recall found nothing".
  // Every corpus is therefore bounded by itself, on both filters.
  const scanRecallMessagesStmt = db.prepare(`
    SELECT message_id, session_id, role, ts, content_encrypted
      FROM chat_messages
     WHERE recall_eligibility = @row_eligibility
       AND recall_contract_id IS @recall_contract_id
       AND role IN ('user', 'assistant', 'tool')
       AND (role <> 'tool' OR source_lifecycle = 'finalized')
       AND (
         role IN ('user', 'assistant')
         OR (
           session_id = @tool_session_id
            AND ${RECENT_TOOL_TURN_WINDOW_SQL.trim()}
         )
       )
       AND (
         @after_ts IS NULL
         OR ts < @after_ts
         OR (ts = @after_ts AND message_id < @after_message_id)
       )
     ORDER BY ts DESC, message_id DESC
     LIMIT @limit
  `);
  // Pointer source. SAME corpus predicate and SAME window fragment as the scan
  // above, plus `role = 'tool'` and an exclusion for the turn already carrying
  // its calls in `prior_tool_calls` -- a pointer to what is in the packet is
  // noise that competes with the content it points at.
  const listToolPointersStmt = db.prepare(`
    SELECT message_id, session_id, role, ts, turn_id, content_encrypted
      FROM chat_messages
     WHERE recall_eligibility = @row_eligibility
       AND recall_contract_id IS @recall_contract_id
       AND role = 'tool'
       AND source_lifecycle = 'finalized'
       AND session_id = @tool_session_id
       AND ${RECENT_TOOL_TURN_WINDOW_SQL.trim()}
       AND (@exclude_turn_id IS NULL OR turn_id IS NOT @exclude_turn_id)
     ORDER BY ts DESC, message_id DESC
     LIMIT @limit
  `);
  const getRecallMessageStmt = db.prepare(`
    SELECT message_id, session_id, role, ts, content_encrypted
      FROM chat_messages
     WHERE recall_eligibility = @row_eligibility
       AND recall_contract_id IS @recall_contract_id
       AND role IN ('user', 'assistant', 'tool')
       AND (role <> 'tool' OR source_lifecycle = 'finalized')
       AND (
         role IN ('user', 'assistant')
         OR session_id = @tool_session_id
       )
       AND message_id = @item_id
  `);
  /** D-213 — messages adjacent to an anchor WITHIN ITS OWN SESSION.
   *
   *  🔑 A conversation's answer usually repeats none of the question's words
   *  ("no lets be fair, change it to 60d"), so lexical recall cannot reach it —
   *  only stepping to the next message can. Session-scoped rather than
   *  corpus-scoped: chat has no thread_id, and the session IS the conversation.
   *
   *  Same `recall_eligibility` and role predicate as `getRecallMessageStmt`, so
   *  this can never widen what recall is allowed to see. */
  /** D-137 — the OTHER half of a two-event tool call.
   *
   *  ⛔⛔ THE CORPUS PREDICATE IS HERE, NOT AT THE CALLER, AND THAT IS THE
   *  WHOLE POINT. A sibling fetch keyed on `pair_id` alone is a scope bypass:
   *  it would return a row from any corpus that happens to share a run id.
   *  `neighbours` shipped with exactly that shape — it hardcoded the owner
   *  bucket while `search` took a scope — and it was a cross-tenant leak the
   *  moment a second corpus existed. Nothing forces this one; the predicate is
   *  written in because the lesson was.
   *
   *  ⚠ The `message_id <> @item_id` clause is a COST saving, not a correctness
   *  guard, and mutation testing says so: removing it leaves every test green,
   *  because `expandPairs` de-duplicates on `item_id` anyway — and it has to,
   *  since SQL cannot know which rows the score pass already returned when a
   *  query matches BOTH halves. What the clause buys is not fetching and
   *  AEAD-decrypting a row the caller is already holding. */
  const recallPairStmt = db.prepare(`
    SELECT message_id, session_id, role, ts, content_encrypted
      FROM chat_messages
     WHERE recall_eligibility = @row_eligibility
       AND recall_contract_id IS @recall_contract_id
       AND role IN ('user', 'assistant', 'tool')
       AND (role <> 'tool' OR source_lifecycle = 'finalized')
       AND (
         role IN ('user', 'assistant')
         OR session_id = @tool_session_id
       )
       AND pair_id IS NOT NULL
       AND pair_id = @pair_id
       AND message_id <> @item_id
     ORDER BY ts ASC, message_id ASC
     LIMIT @limit
  `);
  const recallPairKeyStmt = db.prepare(
    'SELECT pair_id FROM chat_messages WHERE message_id = @item_id',
  );
  const recallNeighboursNextStmt = db.prepare(`
    SELECT message_id, session_id, role, ts, content_encrypted
      FROM chat_messages
     WHERE recall_eligibility = @row_eligibility
       AND recall_contract_id IS @recall_contract_id
       AND role IN ('user', 'assistant', 'tool')
       AND (role <> 'tool' OR source_lifecycle = 'finalized')
       AND session_id = @session_id
       AND ts > @ts
     ORDER BY ts ASC, message_id ASC
     LIMIT @limit
  `);
  const recallNeighboursPrevStmt = db.prepare(`
    SELECT message_id, session_id, role, ts, content_encrypted
      FROM chat_messages
     WHERE recall_eligibility = @row_eligibility
       AND recall_contract_id IS @recall_contract_id
       AND role IN ('user', 'assistant', 'tool')
       AND (role <> 'tool' OR source_lifecycle = 'finalized')
       AND session_id = @session_id
       AND ts < @ts
     ORDER BY ts DESC, message_id DESC
     LIMIT @limit
  `);
  const getMessageStmt = db.prepare<{
    session_id: string;
    message_id: string;
  }>(`
    SELECT *
      FROM chat_messages
     WHERE session_id = @session_id
       AND message_id = @message_id
  `);
  const setMessageMetadataStmt = db.prepare(`
    UPDATE chat_messages
       SET metadata_blob = @metadata_blob
     WHERE session_id = @session_id
       AND message_id = @message_id
  `);
  const insertEgressStmt = db.prepare(`
    INSERT INTO chat_egress (message_id, call_index, prompt_encrypted, model_id, ts)
    VALUES (@message_id, @call_index, @prompt_encrypted, @model_id, @ts)
  `);
  const listEgressStmt = db.prepare<{ message_id: string }>(
    `SELECT * FROM chat_egress WHERE message_id = @message_id ORDER BY call_index ASC`,
  );

  // Pending ownership is process-local. Rows present when this store instance
  // starts have no surviving finalizer and are reconciled to the honest
  // deterministic-extraction-only `failed` state.
  const ownedPendingMessageIds = new Set<string>();
  const reconcileAbandonedPending = (session_id?: string): void => {
    const rows = listPendingSourceRowsStmt.all({
      session_id: session_id ?? null,
    }) as Array<{ session_id: string; message_id: string }>;
    const abandoned = rows.filter(
      (row) => !ownedPendingMessageIds.has(row.message_id),
    );
    if (abandoned.length === 0) return;
    db.transaction(() => {
      for (const row of abandoned) {
        const info = failMessageSourceStmt.run(row);
        if (info.changes > 0) bumpContentRevisionStmt.run({
          session_id: row.session_id,
        });
      }
    })();
  };
  reconcileAbandonedPending();

  // D-174 R28 Slice A — per-pair global chat-model default reads. A corrupt /
  // absent stored source_id reads back as `null` (no default chosen); the
  // timestamp falls back to 0. Never throws.
  const readDefaultSourceId = (): ChatModelSourceId | null => {
    const row = getConfigStmt.get({ key: CHAT_DEFAULT_MODEL_PREF_KEY }) as
      | { value: string }
      | undefined;
    return row && isChatModelSourceId(row.value) ? row.value : null;
  };
  const readDefaultUpdatedAt = (): number => {
    const row = getConfigStmt.get({ key: CHAT_DEFAULT_MODEL_PREF_TS_KEY }) as
      | { value: string }
      | undefined;
    const ts = row ? Number(row.value) : 0;
    return Number.isFinite(ts) ? ts : 0;
  };

  // D-174 R28 Slice A — RAW persisted read (for the Settings picker / RPC get).
  const getDefaultModelSourceId = (): {
    source_id: ChatModelSourceId | null;
    updated_at: number;
  } => ({
    source_id: readDefaultSourceId(),
    updated_at: readDefaultUpdatedAt(),
  });

  // D-174 R28 Slice A — RESOLVED inheritance read. The persisted source_id is
  // resolved to a concrete `{layer, model_hint}` against the LIVE LLM config
  // (point-of-use `getLlmConfig`, so a slot's speed/locality change reflects
  // immediately). No default chosen → the bare comfort layer, preserving the
  // prior unset behaviour (see `resolveDefaultModelSourceId` for the degrade).
  const getDefaultModelPref = (): {
    layer: ChatModelRoutingLayer;
    model_hint?: ChatModelHint;
    source_id?: ChatModelSourceId;
    updated_at: number;
  } => {
    const source_id = readDefaultSourceId();
    const updated_at = readDefaultUpdatedAt();
    if (source_id === null) {
      return { layer: CHAT_DEFAULT_MODEL_PREF_FALLBACK, updated_at };
    }
    const resolved = resolveDefaultModelSourceId(getLlmConfig?.(), source_id);
    // D-191 Phase 6 — echo the resolved `source_id` so an INHERITED session
    // (`sessionFromRow` with this as `defaultPref`) pins the global default's
    // slot. `resolved.source_id` is absent when the pointer is stale (no pin).
    return {
      layer: resolved.layer,
      ...(resolved.model_hint ? { model_hint: resolved.model_hint } : {}),
      ...(resolved.source_id ? { source_id: resolved.source_id } : {}),
      updated_at,
    };
  };

  const setDefaultModelSourceId = (
    source_id: ChatModelSourceId,
    now: number = Date.now(),
  ): { source_id: ChatModelSourceId; updated_at: number } => {
    setConfigStmt.run({ key: CHAT_DEFAULT_MODEL_PREF_KEY, value: source_id });
    setConfigStmt.run({
      key: CHAT_DEFAULT_MODEL_PREF_TS_KEY,
      value: String(now),
    });
    return { source_id, updated_at: now };
  };

  /** Rolling-brief enable read. ⛔ ONLY THE LITERAL `'0'` DISABLES — a missing
   *  row, a legacy value, or a corrupt blob all read ENABLED.
   *
   *  🔑 THE POLARITY INVERTED WHEN THE DEFAULT DID, AND THE SAFE DIRECTION WENT
   *  WITH IT. While the brief was off by default, an unreadable value had to
   *  mean OFF: switching a context-carrying feature on for an owner who never
   *  asked was the harm. Now that ON is the intended state, the harm reverses —
   *  a corrupt row that silently DISABLED the brief would restore the exact
   *  failure it exists to prevent (`CHAT_TAIL_LIMIT` is 3 ROWS, so anything the
   *  user said and no tool can re-read is gone by turn 5) while every surface
   *  still reported the feature as on.
   *
   *  ⚠ Same convention as `RECUED_CHAT_CATALOG_SMART_DEFAULTS`, deliberately:
   *  one opt-out shape for the two global chat-behaviour defaults, so an owner
   *  who learns it once knows both. */
  const getRollingBriefEnabled = (): boolean => {
    const row = getConfigStmt.get({ key: CHAT_ROLLING_BRIEF_KEY }) as
      | { value: string }
      | undefined;
    return row?.value !== '0';
  };
  const setRollingBriefEnabled = (enabled: boolean): boolean => {
    setConfigStmt.run({ key: CHAT_ROLLING_BRIEF_KEY, value: enabled ? '1' : '0' });
    return enabled;
  };

  /** ⚠ The AAD's message id is a CONSTANT, not a real message. It binds the
   *  ciphertext to `(session_id, 'rolling_brief')`, so a blob copied into
   *  another session fails to decode instead of decrypting under the wrong
   *  conversation — the same protection `chat_messages` gets from its own id. */
  const BRIEF_AAD_ID = 'rolling_brief';
  const getBriefStmt = db.prepare<{ session_id: string }>(
    `SELECT brief_encrypted FROM chat_briefs WHERE session_id = @session_id`,
  );
  const setBriefStmt = db.prepare(
    `INSERT OR REPLACE INTO chat_briefs (session_id, brief_encrypted, updated_at)
     VALUES (@session_id, @brief_encrypted, @updated_at)`,
  );
  const delBriefStmt = db.prepare(
    `DELETE FROM chat_briefs WHERE session_id = @session_id`,
  );
  const readSessionBrief = async (session_id: string): Promise<string | null> => {
    const row = getBriefStmt.get({ session_id }) as { brief_encrypted: string } | undefined;
    if (row === undefined) return null;
    try {
      return await decodeChatContentFromStorage(
        row.brief_encrypted, { session_id, message_id: BRIEF_AAD_ID }, getKey,
      );
    } catch {
      // ⛔ UNREADABLE READS AS ABSENT. A re-keyed or corrupt blob must degrade to
      //   "no carry" — the turn then runs unbriefed, which is the documented
      //   fallback — rather than throwing and failing a live conversation over
      //   context it was only ever trying to improve.
      return null;
    }
  };
  const writeSessionBrief = async (
    session_id: string, brief_json: string, now: number = Date.now(),
  ): Promise<void> => {
    const brief_encrypted = await encodeChatContentForStorage(
      brief_json, { session_id, message_id: BRIEF_AAD_ID }, getKey,
    );
    setBriefStmt.run({ session_id, brief_encrypted, updated_at: now });
  };
  const deleteSessionBrief = (session_id: string): void => {
    delBriefStmt.run({ session_id });
  };

  const createSession = (input: CreateSessionInput): ChatSession => {
    const now = input.now ?? Date.now();
    const picker = input.picker_state?.current ?? 'self';
    // Explicit `model_routing` on create = an explicit per-session override;
    // omitted = inherit the per-pair global default (resolved at read time
    // so a later default change re-applies to this session too).
    const overridden = input.model_routing !== undefined;
    // An omitted `model_routing` inherits the per-pair global default — layer
    // AND § A.14 slot hint — so the returned `ChatSession` matches what a
    // re-read via `sessionFromRow` would produce (no stale slot_1/default-tier
    // shape at the store API boundary).
    const defaultPref = getDefaultModelPref();
    const routing = input.model_routing ?? {
      current: defaultPref.layer,
      ...(defaultPref.model_hint ? { model_hint: defaultPref.model_hint } : {}),
      // D-191 Phase 6 — inherit the global default's picked slot so the optimistic
      // return matches what a `sessionFromRow` re-read produces.
      ...(defaultPref.source_id ? { source_id: defaultPref.source_id } : {}),
    };
    insertSessionStmt.run({
      session_id: input.id,
      created_at: now,
      last_active_at: now,
      title: input.title ?? null,
      picker_state_target: picker,
      model_routing_layer: routing.current,
      model_routing_model_hint: routing.model_hint ?? null,
      model_routing_source_id: routing.source_id ?? null,
      model_routing_provider: routing.provider ?? null,
      model_routing_model_id: routing.model_id ?? null,
      model_routing_overridden: overridden ? 1 : 0,
    });
    return {
      id: input.id,
      created_at: now,
      last_active_at: now,
      ...(input.title ? { title: input.title } : {}),
      picker_state: { current: picker },
      model_routing: { ...routing, overridden },
      archived: false,
    };
  };

  const getSession = (session_id: string): ChatSession | null => {
    const row = getSessionStmt.get({ session_id }) as SessionRow | undefined;
    return row ? sessionFromRow(row, getDefaultModelPref()) : null;
  };

  const listSessions = (): ChatSessionSummary[] => {
    const defaultPref = getDefaultModelPref();
    const rows = listSessionsStmt.all() as Array<SessionRow & { message_count: number }>;
    return rows.map((row) => {
      const session = sessionFromRow(row, defaultPref);
      const summary: ChatSessionSummary = {
        id: session.id,
        ...(session.title ? { title: session.title } : {}),
        created_at: session.created_at,
        last_active_at: session.last_active_at,
        message_count: row.message_count,
        // ⚠ ABSENT for a session that predates the column — which the client
        // must read as SEEN, not as "zero messages seen", or every old chat
        // lights up at once.
        ...(typeof (row as { last_seen_message_count?: unknown })
          .last_seen_message_count === 'number'
          ? {
              last_seen_message_count: (
                row as unknown as { last_seen_message_count: number }
              ).last_seen_message_count,
            }
          : {}),
        archived: session.archived,
        picker_state: session.picker_state,
        model_routing: {
          current: session.model_routing.current,
          ...(session.model_routing.model_hint
            ? { model_hint: session.model_routing.model_hint }
            : {}),
          ...(session.model_routing.provider
            ? { provider: session.model_routing.provider }
            : {}),
          ...(session.model_routing.overridden !== undefined
            ? { overridden: session.model_routing.overridden }
            : {}),
        },
      };
      return summary;
    });
  };

  const setPicker = (
    session_id: string,
    target: ChatPickerTarget,
    now: number = Date.now(),
  ): boolean => {
    const info = setPickerStmt.run({ session_id, target, now });
    return info.changes > 0;
  };

  const setModelPref = (
    session_id: string,
    model_routing: ChatSession['model_routing'],
    now: number = Date.now(),
  ): boolean => {
    const info = setModelStmt.run({
      session_id,
      layer: model_routing.current,
      model_hint: model_routing.model_hint ?? null,
      source_id: model_routing.source_id ?? null,
      provider: model_routing.provider ?? null,
      model_id: model_routing.model_id ?? null,
      now,
    });
    return info.changes > 0;
  };

  const clearModelPref = (
    session_id: string,
    now: number = Date.now(),
  ): boolean => {
    const info = clearModelStmt.run({ session_id, now });
    return info.changes > 0;
  };

  const setTitle = (
    session_id: string,
    title: string,
    now: number = Date.now(),
  ): boolean => {
    const info = setTitleStmt.run({ session_id, title, now });
    return info.changes > 0;
  };

  const setArchived = (
    session_id: string,
    archived: boolean,
    now: number = Date.now(),
  ): boolean => {
    const info = setArchivedStmt.run({
      session_id,
      archived: archived ? 1 : 0,
      now,
    });
    return info.changes > 0;
  };

  const bumpSessionLastActiveAt = (
    session_id: string,
    now: number = Date.now(),
  ): boolean => {
    const info = touchStmt.run({ session_id, now });
    return info.changes > 0;
  };

  const deleteSession = (session_id: string): boolean => {
    const pending = listPendingSourceRowsStmt.all({
      session_id,
    }) as Array<{ message_id: string }>;
    const info = deleteSessionStmt.run({ session_id });
    if (info.changes > 0) {
      for (const row of pending) ownedPendingMessageIds.delete(row.message_id);
    }
    return info.changes > 0;
  };

  const appendMessage = async (input: AppendMessageInput): Promise<ChatMessage> => {
    const ts = input.ts ?? Date.now();
    // D-177 5.f — the contributor stamp is SERVER-derived here at the one
    // persistence point, never caller-supplied: role fully determines the
    // contributor for every row shape the store accepts today.
    const contributor = contributorForChatRole(input.role);
    const recall_eligibility = deriveChatMessageRecallEligibility(
      input.execution_source,
    );
    // D-166 door corpus — WHICH contract wrote this row, stamped beside the
    // eligibility bucket and derived from the same server-held source.
    //
    // ⛔ THE RAW EXPLICIT ID, NOT THE LIVENESS-GATED ONE, AND THAT SPLIT IS THE
    //   DESIGN. Write time records IDENTITY ("door X wrote this"); read time
    //   applies AUTHORITY (`resolveContractRecallCorpusScope` asks the
    //   liveness-gating resolver). Gating here would instead bake a moment's
    //   liveness into a permanent row, so revoking a door and re-minting one
    //   would change what old rows appear to be. Contract ids are minted fresh
    //   and never reused, and revoke stamps `revoked_at` rather than deleting,
    //   so a revoked door's rows keep its id and become unreachable — inherited
    //   by nothing.
    //
    // ⚠ `undefined` for every contract-free source, which is exactly the owner
    //   corpus plus any non-owner contract-free dispatch. The read predicate
    //   compares with SQL `IS`, so those match only a `null` scope.
    const recall_contract_id =
      isExecutionSource(input.execution_source)
        ? executionSourceContractId(input.execution_source) ?? null
        : null;
    const source_lifecycle: RecallSourceLifecycle =
      input.source_lifecycle
      ?? (
        input.role === 'user'
        && recall_eligibility
          === CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT
          ? 'pending'
          : 'finalized'
      );
    if (
      source_lifecycle !== 'pending'
      && source_lifecycle !== 'finalized'
      && source_lifecycle !== 'failed'
    ) {
      throw new Error('chat-store: invalid source lifecycle');
    }
    if (
      source_lifecycle === 'pending'
      && (
        (input.role !== 'user' && !(input.role === 'tool' && input.tool_call_settlements?.length))
        || recall_eligibility
          !== CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT
      )
    ) {
      throw new Error(
        'chat-store: pending source requires an owner-authenticated user or tool-result row',
      );
    }
    const candidates = normalizeRetainedAliasCandidates(
      input.retained_alias_candidates,
    );
    if (
      recall_eligibility
        !== CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT
      && candidates.length > 0
    ) {
      throw new Error(
        'chat-store: recall-ineligible source cannot carry candidates',
      );
    }
    if (source_lifecycle !== 'finalized' && candidates.length > 0) {
      throw new Error(
        'chat-store: non-finalized source cannot carry finalized candidates',
      );
    }
    const identity = {
      session_id: input.session_id,
      message_id: input.id,
    };
    const content_encrypted = await encodeChatContentForStorage(
      encodeStoredPromptParts(input.role, input.content),
      identity,
      getKey,
    );
    const tool_calls_blob = input.tool_calls
      ? await encodeChatMessageFieldForStorage(
          JSON.stringify(input.tool_calls),
          'tool_calls',
          identity,
          getKey,
        )
      : null;
    const candidates_encrypted =
      source_lifecycle === 'finalized'
      && recall_eligibility
        === CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT
      ? await encodeChatMessageFieldForStorage(
          JSON.stringify(candidates),
          'candidates',
          identity,
          getKey,
        )
      : null;
    const row = {
      message_id: input.id,
      session_id: input.session_id,
      role: input.role,
      ts,
      target_server: input.target_server,
      picker_at_send_blob: JSON.stringify(input.picker_at_send),
      model_used_provider: input.model_used.provider,
      model_used_model_id: input.model_used.model_id,
      content_encrypted,
      tool_calls_blob,
      candidates_encrypted,
      source_lifecycle,
      provenance_blob: input.provenance
        ? JSON.stringify(input.provenance)
        : null,
      attachments_blob: input.attachments && input.attachments.length > 0
        ? JSON.stringify(input.attachments)
        : null,
      metadata_blob: input.data_diagnosis || input.tool_call
        ? JSON.stringify({
            ...(input.data_diagnosis ? { data_diagnosis: input.data_diagnosis } : {}),
            ...(input.tool_call ? { tool_call: input.tool_call } : {}),
          })
        : null,
      contributor,
      recall_eligibility,
      recall_contract_id,
      pair_id: input.pair_id ?? null,
      turn_id: input.turn_id ?? null,
    };
    db.transaction(() => {
      insertMessageStmt.run(row);
      for (const settlement of input.tool_call_settlements ?? []) {
        settleChatToolCall(db, input.session_id, settlement, ts);
      }
      if (source_lifecycle !== 'pending') {
        bumpContentRevisionStmt.run({ session_id: input.session_id });
      }
      touchStmt.run({ session_id: input.session_id, now: ts });
    })();
    if (source_lifecycle === 'pending') {
      ownedPendingMessageIds.add(input.id);
    }
    return {
      id: input.id,
      session_id: input.session_id,
      role: input.role,
      content: input.content,
      target_server: input.target_server,
      picker_at_send: input.picker_at_send,
      model_used: input.model_used,
      ...(input.tool_calls ? { tool_calls: input.tool_calls } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.data_diagnosis
        ? { data_diagnosis: input.data_diagnosis }
        : {}),
      contributor,
      ...(input.turn_id ? { turn_id: input.turn_id } : {}),
      ts,
    };
  };

  const markSessionSeen = (session_id: string): void => {
    markSessionSeenStmt.run({ session_id });
  };

  const listMessages = async (session_id: string): Promise<ChatMessage[]> => {
    const rows = listMessagesStmt.all({ session_id }) as MessageRow[];
    return Promise.all(rows.map((row) => messageFromRow(row, getKey)));
  };

  /** One page of a conversation, newest-last, plus whether older rows exist.
   *
   *  ⛔ ASKS FOR ONE MORE ROW THAN IT RETURNS. `has_more` cannot be derived
   *  from `rows.length === limit` — a conversation of exactly `limit` messages
   *  would report more and hand back a cursor that pages to nothing, which the
   *  client renders as a "load earlier" control that does nothing when
   *  pressed. The extra row is the only way to tell "full page" from "full
   *  page and there is more", and it is discarded rather than returned. */
  const listMessagePage = async (
    session_id: string,
    limit: number,
    before?: ChatHistoryCursor,
  ): Promise<{
    messages: ChatMessage[];
    has_more: boolean;
    oldest?: ChatHistoryCursor;
  }> => {
    const probe = limit + 1;
    const rows = (before === undefined
      ? listMessagesTailStmt.all({ session_id, limit: probe })
      : listMessagesBeforeStmt.all({
          session_id,
          ts: before.ts,
          message_id: before.message_id,
          limit: probe,
        })) as MessageRow[];
    const has_more = rows.length > limit;
    const page = has_more ? rows.slice(0, limit) : rows;
    // Rows arrive newest-first because that is the only way to take the TAIL
    // cheaply; the caller wants display order.
    const ordered = page.slice().reverse();
    const messages = await Promise.all(
      ordered.map((row) => messageFromRow(row, getKey)),
    );
    const oldestRow = ordered[0];
    return {
      messages,
      has_more,
      ...(oldestRow === undefined
        ? {}
        : { oldest: { ts: oldestRow.ts, message_id: oldestRow.message_id } }),
    };
  };

  const listRecentConversationalStmt = db.prepare<{ session_id: string; limit: number }>(
    `SELECT * FROM chat_messages
      -- ⛔⛔ TOOL ROWS STAY OUT OF THE TAIL, AND THIS IS NOT AN OVERSIGHT.
      -- Recall was widened to reach them (they are the point of the row class);
      -- the TAIL must not be, for the reason stated at this statement's own
      -- comment: it wants three CONVERSATIONAL rows, and a session heavy in
      -- tool rows would need a much larger fetch to find them. Measured, a
      -- tool result is ~7x a chat row at the median (490 vs 66 bytes) and a
      -- turn writes p50 2 of them, so admitting them here would evict the
      -- conversation from a tail sized for conversation.
      WHERE session_id = @session_id AND role IN ('user', 'assistant')
      ORDER BY ts DESC, message_id DESC
      LIMIT @limit`,
  );

  const listRecentConversational = async (
    session_id: string,
    limit: number,
  ): Promise<ChatMessage[]> => {
    if (limit <= 0) return [];
    const rows = (listRecentConversationalStmt.all({ session_id, limit }) as MessageRow[])
      // Selected newest-first by the query; returned oldest-first so the
      // ordering contract matches `listMessages`.
      .reverse();
    return Promise.all(rows.map((row) => messageFromRow(row, getKey)));
  };

  const finalizeMessageSource = async (
    input: {
      readonly session_id: string;
      readonly message_id: string;
      readonly candidates: readonly RetainedAliasCandidate[];
    },
  ): Promise<boolean> => {
    let changed = false;
    try {
      const candidates = normalizeRetainedAliasCandidates(input.candidates);
      const candidates_encrypted = await encodeChatMessageFieldForStorage(
        JSON.stringify(candidates),
        'candidates',
        { session_id: input.session_id, message_id: input.message_id },
        getKey,
      );
      db.transaction(() => {
        const info = finalizeMessageSourceStmt.run({
          session_id: input.session_id,
          message_id: input.message_id,
          candidates_encrypted,
        });
        changed = info.changes > 0;
        if (changed) {
          bumpContentRevisionStmt.run({ session_id: input.session_id });
        }
      })();
      return changed;
    } finally {
      // A finalizer invocation is terminal for this process even when
      // validation, encryption, or the atomic update fails. Relinquishing the
      // claim lets the next harvest reconcile a still-pending durable row.
      ownedPendingMessageIds.delete(input.message_id);
    }
  };

  const failMessageSource = (
    session_id: string,
    message_id: string,
  ): boolean => {
    let changed = false;
    try {
      db.transaction(() => {
        const info = failMessageSourceStmt.run({ session_id, message_id });
        changed = info.changes > 0;
        if (changed) bumpContentRevisionStmt.run({ session_id });
      })();
      return changed;
    } finally {
      ownedPendingMessageIds.delete(message_id);
    }
  };

  const contentRevision = (session_id: string): number => {
    const row = getContentRevisionStmt.get({ session_id }) as
      | { content_revision: number }
      | undefined;
    return row?.content_revision ?? 0;
  };

  const harvestPiiSources = async (
    input: {
      readonly session_id: string;
      readonly after?: ChatRecallSourceCursor;
      /** D-213 §3.8 — inclusive upper bound for a JOIN prefix read. */
      readonly until?: ChatRecallSourceCursor;
      readonly max_rows: number;
      readonly max_bytes: number;
      readonly max_candidates: number;
      readonly max_ms?: number;
    },
  ): Promise<ChatPiiSourceHarvest> => {
    const startedAt = Date.now();
    const boundedPositiveInteger = (
      value: number,
      ceiling: number,
    ): number => Number.isFinite(value)
      ? Math.max(1, Math.min(Math.floor(value), ceiling))
      : 1;
    const maxMs = Math.max(
      1,
      boundedPositiveInteger(input.max_ms ?? 250, 250),
    );
    reconcileAbandonedPending(input.session_id);
    const maxRows = boundedPositiveInteger(input.max_rows, 256);
    const maxBytes = boundedPositiveInteger(input.max_bytes, 1_048_576);
    const maxCandidates = boundedPositiveInteger(input.max_candidates, 1_024);
    const revisionBefore = contentRevision(input.session_id);
    const after =
      input.after !== undefined
      && Number.isFinite(input.after.ts)
      && typeof input.after.message_id === 'string'
      && input.after.message_id.length > 0
        ? input.after
        : undefined;
    const until =
      input.until !== undefined
      && Number.isFinite(input.until.ts)
      && typeof input.until.message_id === 'string'
      && input.until.message_id.length > 0
        ? input.until
        : undefined;
    const rawRows = harvestPiiSourceRowsStmt.all({
      session_id: input.session_id,
      row_eligibility:
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      after_ts: after?.ts ?? null,
      after_message_id: after?.message_id ?? null,
      until_ts: until?.ts ?? null,
      until_message_id: until?.message_id ?? null,
      limit: maxRows + 1,
    }) as Array<Pick<
      MessageRow,
      | 'message_id'
      | 'session_id'
      | 'role'
      | 'ts'
      | 'content_encrypted'
      | 'candidates_encrypted'
      | 'source_lifecycle'
    >>;
    let partial = rawRows.length > maxRows;
    let decryptedRows = 0;
    let decryptedBytes = 0;
    let candidateCount = 0;
    const rows: ChatPiiSourceRow[] = [];
    let lastAdvanced:
      | Pick<MessageRow, 'message_id' | 'ts'>
      | undefined;
    let stoppedBeforeRow = false;

    for (const row of rawRows.slice(0, maxRows)) {
      const rowByteStart = decryptedBytes;
      if (Date.now() - startedAt >= maxMs) {
        partial = true;
        stoppedBeforeRow = true;
        break;
      }
      if (row.source_lifecycle === 'pending') {
        partial = true;
        lastAdvanced = row;
        continue;
      }
      if (
        row.source_lifecycle !== 'finalized'
        && row.source_lifecycle !== 'failed'
      ) {
        partial = true;
        lastAdvanced = row;
        continue;
      }
      try {
        const contentStoredBytes = chatStoredPlaintextBytes(
          row.content_encrypted,
          getKey !== undefined,
        );
        if (decryptedBytes + contentStoredBytes > maxBytes) {
          partial = true;
          // A row that cannot fit even into an otherwise-empty pass can never
          // become readable under this ceiling; advance past it so it cannot
          // starve every later source forever. A row that merely does not fit
          // the remaining budget is retried at the start of the next page.
          if (contentStoredBytes > maxBytes) {
            lastAdvanced = row;
            continue;
          }
          stoppedBeforeRow = true;
          break;
        }
        const storedContent = await decodeChatContentFromStorage(
          row.content_encrypted,
          { session_id: row.session_id, message_id: row.message_id },
          getKey,
        );
        decryptedRows += 1;
        const contentBytes = new TextEncoder().encode(storedContent).byteLength;
        if (decryptedBytes + contentBytes > maxBytes) {
          partial = true;
          if (contentBytes > maxBytes) {
            lastAdvanced = row;
            continue;
          }
          stoppedBeforeRow = true;
          break;
        }
        decryptedBytes += contentBytes;
        if (row.role !== 'user' && row.role !== 'assistant') {
          throw new Error('chat-store: invalid harvest source role');
        }
        const content =
          decodeStoredPromptParts(storedContent, row.role).primary.text;
        let candidates: readonly RetainedAliasCandidate[] = [];
        if (row.source_lifecycle === 'finalized') {
          if (Date.now() - startedAt >= maxMs) {
            partial = true;
            break;
          }
          if (row.candidates_encrypted === null) {
            partial = true;
          } else {
            const candidateStoredBytes = chatStoredPlaintextBytes(
              row.candidates_encrypted,
              getKey !== undefined,
            );
            if (decryptedBytes + candidateStoredBytes > maxBytes) {
              partial = true;
              // Treat the whole split-column row as the unit of progress. Two
              // individually valid fields can still exceed the per-pass cap in
              // combination; retrying that row at an empty frontier would then
              // stop forever and starve every later row.
              const contentBytesForRow = decryptedBytes - rowByteStart;
              if (contentBytesForRow + candidateStoredBytes > maxBytes) {
                lastAdvanced = row;
                continue;
              }
              stoppedBeforeRow = true;
              break;
            }
            const storedCandidates = await decodeChatMessageFieldFromStorage(
              row.candidates_encrypted,
              'candidates',
              { session_id: row.session_id, message_id: row.message_id },
              getKey,
            );
            const candidateBytes =
              new TextEncoder().encode(storedCandidates).byteLength;
            if (decryptedBytes + candidateBytes > maxBytes) {
              partial = true;
              const contentBytesForRow = decryptedBytes - rowByteStart;
              if (contentBytesForRow + candidateBytes > maxBytes) {
                lastAdvanced = row;
                continue;
              }
              stoppedBeforeRow = true;
              break;
            }
            decryptedBytes += candidateBytes;
            const decoded = decodeRetainedAliasCandidates(storedCandidates);
            const available = maxCandidates - candidateCount;
            if (decoded.length > available) partial = true;
            candidates = decoded.slice(0, Math.max(0, available));
            candidateCount += candidates.length;
          }
        }
        rows.push({
          message_id: row.message_id,
          content,
          candidates,
          source_lifecycle: row.source_lifecycle,
        });
        lastAdvanced = row;
      } catch (err) {
        if (err instanceof ChatVaultLockedError) throw err;
        partial = true;
        lastAdvanced = row;
      }
    }
    if (Date.now() - startedAt > maxMs) partial = true;
    const revisionAfter = contentRevision(input.session_id);
    if (revisionAfter !== revisionBefore) partial = true;
    const pageRows = rawRows.slice(0, maxRows);
    const lastPageRow = pageRows.at(-1);
    const hasMore =
      rawRows.length > maxRows
      || stoppedBeforeRow
      || (
        lastAdvanced !== undefined
        && lastPageRow !== undefined
        && (
          lastAdvanced.ts !== lastPageRow.ts
          || lastAdvanced.message_id !== lastPageRow.message_id
        )
      );
    return {
      session_id: input.session_id,
      content_revision: revisionAfter,
      rows,
      partial,
      decrypted_rows: decryptedRows,
      decrypted_bytes: decryptedBytes,
      ...(hasMore && lastAdvanced !== undefined
        ? {
            next_cursor: {
              ts: lastAdvanced.ts,
              message_id: lastAdvanced.message_id,
            },
          }
        : {}),
    };
  };

  const decodeRecallSourceRow = async (
    row: RecallMessageRow,
  ): Promise<ChatRecallSourceRow> => {
    // ⛔ THE ROLE→KIND MAP HAS TO MOVE WITH THE SQL, and widening only the SQL
    //   is why the first cut of the tool-row slice returned nothing: the scan
    //   admitted `role: 'tool'`, this decoder threw on it, and every tool row
    //   came back `readable: false` — a silent empty result that reads exactly
    //   like "the corpus has nothing". Two filters, one question; the query is
    //   only half of it.
    const kind = row.role === 'assistant'
      ? 'assistant'
      : row.role === 'tool' ? 'tool' : 'user';
    try {
      if (
        row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool'
      ) {
        throw new Error('chat-store: invalid recall source role');
      }
      const stored = await decodeChatContentFromStorage(
        row.content_encrypted,
        { session_id: row.session_id, message_id: row.message_id },
        getKey,
      );
      const content = decodeStoredPromptParts(stored, row.role).primary.text;
      return {
        readable: true,
        item_id: row.message_id,
        session_id: row.session_id,
        kind,
        timestamp: row.ts,
        content,
      };
    } catch {
      return {
        readable: false,
        item_id: row.message_id,
        session_id: row.session_id,
        kind,
        timestamp: row.ts,
      };
    }
  };

  const listRecallableToolPointers = async (
    input: ChatRecallCorpusSelector & {
      readonly exclude_turn_id?: string | null;
      readonly limit: number;
    },
  ): Promise<ReadonlyArray<ChatRecallableToolPointer>> => {
    assertRecallCorpusSelector(input);
    const raw = listToolPointersStmt.all({
      row_eligibility: input.row_eligibility,
      recall_contract_id: input.recall_contract_id,
      tool_session_id: input.tool_session_id,
      exclude_turn_id: input.exclude_turn_id ?? null,
      limit: Math.max(1, Math.min(Math.floor(input.limit), 32)),
    }) as Array<RecallMessageRow & { turn_id: string | null }>;
    const decoded = await Promise.all(raw.map(async (row) => {
      const source = await decodeRecallSourceRow(row);
      // An unreadable row is DROPPED, never pointed at. A pointer is a promise
      // that the content can be fetched; one we could not read ourselves is a
      // promise we already know is broken.
      return source.readable
        ? {
            item_id: source.item_id,
            content: source.content,
            turn_id: row.turn_id,
            ts: row.ts,
          }
        : undefined;
    }));
    return decoded.filter((d): d is ChatRecallableToolPointer => d !== undefined);
  };

  const scanRecallMessagesPage = async (
    input: ChatRecallCorpusSelector & {
      readonly after?: ChatRecallSourceCursor;
      readonly limit: number;
    },
  ): Promise<ChatRecallSourcePage> => {
    assertRecallCorpusSelector(input);
    const limit = Math.max(1, Math.min(Math.floor(input.limit), 256));
    const raw = scanRecallMessagesStmt.all({
      row_eligibility: input.row_eligibility,
      recall_contract_id: input.recall_contract_id,
      tool_session_id: input.tool_session_id,
      after_ts: input.after?.ts ?? null,
      after_message_id: input.after?.message_id ?? null,
      limit: limit + 1,
    }) as RecallMessageRow[];
    const hasMore = raw.length > limit;
    const pageRows = hasMore ? raw.slice(0, limit) : raw;
    const rows = await Promise.all(pageRows.map(decodeRecallSourceRow));
    const last = pageRows.at(-1);
    return {
      rows,
      ...(hasMore && last
        ? {
            next_cursor: {
              ts: last.ts,
              message_id: last.message_id,
            },
          }
        : {}),
    };
  };

  const getRecallMessage = async (
    input: ChatRecallCorpusSelector & { readonly item_id: string },
  ): Promise<ChatRecallSourceRow | null> => {
    assertRecallCorpusSelector(input);
    const row = getRecallMessageStmt.get({
      row_eligibility: input.row_eligibility,
      recall_contract_id: input.recall_contract_id,
      tool_session_id: input.tool_session_id,
      item_id: input.item_id,
    }) as RecallMessageRow | undefined;
    return row ? decodeRecallSourceRow(row) : null;
  };

  /** The paired half of a two-event tool call, or `[]`.
   *
   *  ⛔ SCOPED, like every other recall read. See `recallPairStmt`. */
  const getRecallPair = async (
    input: ChatRecallCorpusSelector & { readonly item_id: string },
  ): Promise<ChatRecallSourceRow[]> => {
    assertRecallCorpusSelector(input);
    const key = recallPairKeyStmt.get({ item_id: input.item_id }) as
      | { pair_id: string | null }
      | undefined;
    if (!key?.pair_id) return [];
    const rows = recallPairStmt.all({
      row_eligibility: input.row_eligibility,
      recall_contract_id: input.recall_contract_id,
      tool_session_id: input.tool_session_id,
      pair_id: key.pair_id,
      item_id: input.item_id,
      limit: 4,
    }) as RecallMessageRow[];
    return Promise.all(rows.map(decodeRecallSourceRow));
  };

  const getRecallNeighbours = async (
    input: ChatRecallCorpusSelector & {
      readonly item_id: string;
      readonly next?: number;
      readonly prev?: number;
    },
  ): Promise<ChatRecallSourceRow[]> => {
    assertRecallCorpusSelector(input);
    const anchor = getRecallMessageStmt.get({
      row_eligibility: input.row_eligibility,
      recall_contract_id: input.recall_contract_id,
      tool_session_id: input.tool_session_id,
      item_id: input.item_id,
    }) as RecallMessageRow | undefined;
    if (!anchor) return [];
    const out: RecallMessageRow[] = [];
    const take = (stmt: typeof recallNeighboursNextStmt, limit: number): void => {
      if (limit <= 0) return;
      out.push(...stmt.all({
        row_eligibility: input.row_eligibility,
        recall_contract_id: input.recall_contract_id,
        tool_session_id: input.tool_session_id,
        session_id: anchor.session_id,
        ts: anchor.ts,
        limit,
      }) as RecallMessageRow[]);
    };
    take(recallNeighboursNextStmt, Math.min(10, Math.floor(input.next ?? 0)));
    take(recallNeighboursPrevStmt, Math.min(10, Math.floor(input.prev ?? 0)));
    // `decodeRecallSourceRow` is async (it decrypts), so this must await.
    return Promise.all(out.map(decodeRecallSourceRow));
  };

  const setDataDiagnosisResolution = async (
    session_id: string,
    message_id: string,
    resolution: ChatDataDiagnosisResolution,
  ): Promise<ChatMessage | null> => {
    const row = getMessageStmt.get({ session_id, message_id }) as
      | MessageRow
      | undefined;
    if (row === undefined) return null;
    const diagnosis = parseDataDiagnosis(row.metadata_blob);
    if (
      row.role !== 'assistant'
      || diagnosis?.intent !== 'safe_check'
    ) return null;
    const metadata = parseMessageMetadataObject(row.metadata_blob);
    const current = parseDataDiagnosisResolution(row.metadata_blob);
    const persistedResolution: ChatDataDiagnosisResolution =
      current?.status === resolution.status
        ? current
        : {
            status: resolution.status,
            // This is the final serialization point. Close the
            // same-millisecond race between two handlers that both read the
            // previous closure before either write reaches the store.
            resolved_at: Math.max(
              resolution.resolved_at,
              (current?.resolved_at ?? -1) + 1,
            ),
          };
    metadata.data_diagnosis_resolution = persistedResolution;
    const metadata_blob = JSON.stringify(metadata);
    const info = setMessageMetadataStmt.run({
      session_id,
      message_id,
      metadata_blob,
    });
    if (info.changes === 0) return null;
    return messageFromRow({ ...row, metadata_blob }, getKey);
  };

  const appendEgress = async (
    session_id: string,
    message_id: string,
    packets: ReadonlyArray<ChatEgressPacket>,
  ): Promise<void> => {
    for (const p of packets) {
      const prompt_encrypted = await encodeChatContentForStorage(
        p.prompt,
        { session_id, message_id },
        getKey,
      );
      insertEgressStmt.run({
        message_id,
        call_index: p.call_index,
        prompt_encrypted,
        model_id: p.model_id,
        ts: p.ts,
      });
    }
  };

  const getEgress = async (
    session_id: string,
    message_id: string,
  ): Promise<ChatEgressPacket[]> => {
    const rows = listEgressStmt.all({ message_id }) as EgressRow[];
    return Promise.all(rows.map(async (row) => ({
      call_index: row.call_index,
      prompt: await decodeChatContentFromStorage(
        row.prompt_encrypted,
        { session_id, message_id },
        getKey,
      ),
      model_id: row.model_id,
      ts: row.ts,
    })));
  };

  return {
    createSession,
    toolCalls: createChatToolCallStore(db, appendMessage),
    failToolCallSources: (session_id, turn_id) => {
      const pending = db.prepare(`SELECT message_id FROM chat_messages
        WHERE session_id = ? AND turn_id = ? AND role = 'tool'
          AND source_lifecycle = 'pending'`).all(session_id, turn_id) as Array<{ message_id: string }>;
      for (const row of pending) failMessageSource(session_id, row.message_id);
    },
    getSession,
    listSessions,
    setPicker,
    setModelPref,
    clearModelPref,
    getDefaultModelPref,
    getDefaultModelSourceId,
    setDefaultModelSourceId,
    getRollingBriefEnabled,
    setRollingBriefEnabled,
    readSessionBrief,
    writeSessionBrief,
    deleteSessionBrief,
    setTitle,
    setArchived,
    bumpSessionLastActiveAt,
    deleteSession,
    appendMessage,
    listMessages,
    listMessagePage,
    markSessionSeen,
    listRecentConversational,
    finalizeMessageSource,
    failMessageSource,
    harvestPiiSources,
    listRecallableToolPointers,
    scanRecallMessagesPage,
    getRecallMessage,
    getRecallPair,
    getRecallNeighbours,
    setDataDiagnosisResolution,
    appendEgress,
    getEgress,
  };
};

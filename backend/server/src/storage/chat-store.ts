/** D-137 P1 — AI Chat substrate storage scaffold.
 *
 *  P1 lands the two chat tables (`chat_sessions`, `chat_messages`) as
 *  fully-shaped `CREATE TABLE IF NOT EXISTS` schemas — chat storage IS
 *  the substrate that ships first (in contrast to D-149 P1's
 *  placeholder pattern; here the rpc handler slice can drop straight
 *  into a stable schema in the next session). Per § Must Hold
 *  (D-137-equivalent of D-149 § Must Hold I-15), the tables are
 *  server-internal — no cross-cloud sync (D-097 / D-168 retired the
 *  legacy SYNC_OBJECTS substrate).
 *
 *  Per § Contract Tightening — chat content is encrypted at rest via a
 *  new `chat` sub-DEK domain (lands with the rpc handler slice; P1
 *  schema reserves the `_encrypted` columns + plaintext metadata
 *  columns to keep summary lists cheap without decrypting every row).
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
  CHAT_MODEL_ROUTING_LAYER_SET,
  CHAT_TABLES,
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
  type RecuedServerSignature,
  contributorForChatRole,
  isChatMessageRole,
  isChatModelHint,
  isChatModelSourceId,
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
 *  `chat_messages.session_id → chat_sessions.session_id` `ON DELETE
 *  CASCADE` actually fires. SQLite's FK enforcement is opt-in
 *  per-connection (not per-table); setting it inside the ensure
 *  function follows the established pattern in
 *  `ensureEnrichmentSchema` and removes the "callers must enable FK
 *  enforcement before deleting a session" footgun. Idempotent and
 *  cheap. */
export const ensureChatSchema = (db: Database.Database): void => {
  // SQLite needs `PRAGMA foreign_keys = ON` per-connection so the
  // `chat_messages` ON DELETE CASCADE fires on session deletes.
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
  // (provenance + tier + classification + status); always plaintext
  // because each entry's bulky result body lives off-row under a
  // `result_ref` lookup keyed against the chat-side ephemeral
  // storage tier (lands with the rpc handler slice).
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
      provenance_blob            TEXT,
      attachments_blob           TEXT,
      metadata_blob              TEXT,
      contributor                TEXT,
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

/** AAD binding for chat message content. Binds each ciphertext to its
 *  `(session_id, message_id)` pair so an attacker who reorders rows in
 *  the SQLite file cannot move a `content_encrypted` between rows. The
 *  `v1` sentinel doubles as a versioned label — bumping it lets a
 *  future format re-encode in place without confusion. */
const aadForMessage = (session_id: string, message_id: string): Uint8Array =>
  new TextEncoder().encode(
    `recued/v1/chat/message/${session_id}/${message_id}`,
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
  provenance_blob: string | null;
  attachments_blob: string | null;
  metadata_blob: string | null;
  contributor: string | null;
}

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
  let content = '';
  try {
    content = await decodeChatContentFromStorage(
      row.content_encrypted,
      { session_id: row.session_id, message_id: row.message_id },
      getKey,
    );
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
  const role: ChatMessageRole = isChatMessageRole(row.role)
    ? row.role
    : 'system';
  const picker = parsePickerAtSend(row.picker_at_send_blob) ?? {
    display_name: 'unknown',
    signature: {
      server_kind: 'recued' as const,
      version: '0',
      instance_id: 'unknown',
    },
  };
  const tool_calls = parseToolCalls(row.tool_calls_blob);
  const provenance = parseProvenance(row.provenance_blob);
  const attachments = parseAttachments(row.attachments_blob);
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
    ...(provenance ? { provenance } : {}),
    ...(attachments ? { attachments } : {}),
    contributor: CHAT_CONTRIBUTOR_SET.has(
      row.contributor as ChatSessionContributor,
    )
      ? (row.contributor as ChatSessionContributor)
      : contributorForChatRole(role),
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
  id: string;
  session_id: string;
  role: ChatMessageRole;
  content: string;
  target_server: ChatPickerTarget;
  picker_at_send: { display_name: string; signature: RecuedServerSignature };
  model_used: { provider: string; model_id: string };
  /** Defaults to `Date.now()`. */
  ts?: number;
  tool_calls?: ChatToolCall[];
  provenance?: ChatProvenanceRef[];
  attachments?: ChatMessageAttachment[];
}

export interface ChatStore {
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
  setTitle(session_id: string, title: string, now?: number): boolean;
  setArchived(session_id: string, archived: boolean, now?: number): boolean;
  bumpSessionLastActiveAt(session_id: string, now?: number): boolean;
  deleteSession(session_id: string): boolean;
  appendMessage(input: AppendMessageInput): Promise<ChatMessage>;
  listMessages(session_id: string): Promise<ChatMessage[]>;
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
      model_routing_overridden, archived
    ) VALUES (
      @session_id, @created_at, @last_active_at, @title,
      @picker_state_target, @model_routing_layer, @model_routing_model_hint,
      @model_routing_source_id, @model_routing_provider, @model_routing_model_id,
      @model_routing_overridden, 0
    )
  `);
  const getSessionStmt = db.prepare<{ session_id: string }>(
    `SELECT * FROM chat_sessions WHERE session_id = @session_id`,
  );
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
      content_encrypted, tool_calls_blob, provenance_blob, attachments_blob,
      contributor
    ) VALUES (
      @message_id, @session_id, @role, @ts, @target_server,
      @picker_at_send_blob, @model_used_provider, @model_used_model_id,
      @content_encrypted, @tool_calls_blob, @provenance_blob, @attachments_blob,
      @contributor
    )
  `);
  const listMessagesStmt = db.prepare<{ session_id: string }>(
    `SELECT * FROM chat_messages WHERE session_id = @session_id ORDER BY ts ASC, message_id ASC`,
  );
  const insertEgressStmt = db.prepare(`
    INSERT INTO chat_egress (message_id, call_index, prompt_encrypted, model_id, ts)
    VALUES (@message_id, @call_index, @prompt_encrypted, @model_id, @ts)
  `);
  const listEgressStmt = db.prepare<{ message_id: string }>(
    `SELECT * FROM chat_egress WHERE message_id = @message_id ORDER BY call_index ASC`,
  );

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
    const info = deleteSessionStmt.run({ session_id });
    return info.changes > 0;
  };

  const appendMessage = async (input: AppendMessageInput): Promise<ChatMessage> => {
    const ts = input.ts ?? Date.now();
    // D-177 5.f — the contributor stamp is SERVER-derived here at the one
    // persistence point, never caller-supplied: role fully determines the
    // contributor for every row shape the store accepts today.
    const contributor = contributorForChatRole(input.role);
    const content_encrypted = await encodeChatContentForStorage(
      input.content,
      { session_id: input.session_id, message_id: input.id },
      getKey,
    );
    insertMessageStmt.run({
      message_id: input.id,
      session_id: input.session_id,
      role: input.role,
      ts,
      target_server: input.target_server,
      picker_at_send_blob: JSON.stringify(input.picker_at_send),
      model_used_provider: input.model_used.provider,
      model_used_model_id: input.model_used.model_id,
      content_encrypted,
      tool_calls_blob: input.tool_calls
        ? JSON.stringify(input.tool_calls)
        : null,
      provenance_blob: input.provenance
        ? JSON.stringify(input.provenance)
        : null,
      attachments_blob: input.attachments && input.attachments.length > 0
        ? JSON.stringify(input.attachments)
        : null,
      contributor,
    });
    bumpSessionLastActiveAt(input.session_id, ts);
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
      contributor,
      ts,
    };
  };

  const listMessages = async (session_id: string): Promise<ChatMessage[]> => {
    const rows = listMessagesStmt.all({ session_id }) as MessageRow[];
    return Promise.all(rows.map((row) => messageFromRow(row, getKey)));
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
    getSession,
    listSessions,
    setPicker,
    setModelPref,
    clearModelPref,
    getDefaultModelPref,
    getDefaultModelSourceId,
    setDefaultModelSourceId,
    setTitle,
    setArchived,
    bumpSessionLastActiveAt,
    deleteSession,
    appendMessage,
    listMessages,
    appendEgress,
    getEgress,
  };
};

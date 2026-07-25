/** D-137 W2.3 § A.1.1 + § A.10 — Mary's per-connection MCP tool
 *  annotation storage.
 *
 *  One row per `connection_name` (NOT per (kind, name) — only `mcp`
 *  connections can advertise tools, so the connection_name is unique
 *  enough across MCP enrollments). Each row carries the upstream
 *  `tools/list` snapshot + Mary's per-tool overrides + her connection-
 *  level topic-tag chips. The chat orchestrator pulls the full
 *  annotation list at every turn start to derive the Tier 3 catalog +
 *  the `disabled_tier3_names` set the main-turn catalog projection
 *  (`buildChatMainTurnTools`) consumes.
 *
 *  Per § Must Hold (D-137-equivalent) — table lives in the per-pair
 *  SQLite db; no cross-cloud sync (D-097 / D-168). Stored unencrypted
 *  (no secrets in the annotation; secrets live in the D-125
 *  `connections` row's `auth_ciphertext`).
 *
 *  Idempotent `ensureChatConnectionMcpAnnotationSchema` + a thin CRUD
 *  store with `getAnnotation / setAnnotation / listAnnotations /
 *  deleteAnnotation` operations. Reads for a connection that has no
 *  row yet return the substrate default (`buildDefaultConnection-
 *  McpAnnotation`) so callers always see a stable shape; the next
 *  `setAnnotation` materialises the row.
 *
 *  Corrupted JSON blobs fall back to the substrate default — never
 *  crash the chat surface. The store does NOT auto-rewrite bad rows
 *  (a `setAnnotation` call from the rpc handler is the only mutation
 *  path); the Settings page surfaces the empty shape until Mary
 *  re-saves.
 */

import type Database from 'better-sqlite3';
import {
  buildDefaultConnectionMcpAnnotation,
  isTier3ToolClassification,
  type ConnectionMcpAnnotationState,
  type ConnectionMcpToolOverride,
  type McpToolDescriptor,
  type ValidatedConnectionMcpAnnotationInput,
} from '@recued/contracts';

/** Idempotent schema install. Single table keyed on `connection_name`.
 *  The annotation row carries everything as a JSON blob plus a
 *  separate `updated_at` integer for fast index queries (Settings page
 *  sorts by "most recently classified"). */
export const ensureChatConnectionMcpAnnotationSchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_connection_mcp_annotations (
      connection_name  TEXT PRIMARY KEY,
      annotation_json  TEXT NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_connection_mcp_annotations_updated_at
      ON chat_connection_mcp_annotations (updated_at);
  `);
};

interface Row {
  connection_name: string;
  annotation_json: string;
  updated_at: number;
}

export interface ChatConnectionMcpStore {
  /** Read the persisted annotation for `connection_name`. Returns the
   *  substrate default (`buildDefaultConnectionMcpAnnotation`) when no
   *  row exists yet. Corrupted rows fall through to the default. */
  getAnnotation(connection_name: string): ConnectionMcpAnnotationState;
  /** Enumerate every persisted annotation. Used by the chat orchestr-
   *  ator at turn start (Tier 3 catalog projection + `disabled_tier3_-
   *  names` derivation) + Settings → Connections summary. Sorted by
   *  `updated_at` DESC (most recently classified first). Corrupted
   *  rows are filtered out (the substrate default surfaces via
   *  `getAnnotation` instead, so the listing stays clean). */
  listAnnotations(): ReadonlyArray<ConnectionMcpAnnotationState>;
  /** Persist a validated annotation. Inputs are wire-trusted at this
   *  point — the rpc handler validates via
   *  `validateConnectionMcpAnnotationInput` before calling. Returns
   *  the persisted shape with stamped `updated_at`. */
  setAnnotation(input: {
    value: ValidatedConnectionMcpAnnotationInput;
    now?: number;
  }): ConnectionMcpAnnotationState;
  /** Remove the annotation for `connection_name`. Returns true when
   *  a row was removed. Triggered when the underlying D-125 connection
   *  record is deleted (Settings → Connections → Remove). The
   *  connection-store hook wires this in a later slice; for now the
   *  method exists so the rpc handler / test harnesses can clear
   *  state. */
  deleteAnnotation(connection_name: string): boolean;
}

/** Best-effort parser for the persisted JSON blob. Returns `null` on
 *  any shape error so the caller can fall back to the substrate
 *  default — corrupted rows never crash the chat surface. */
const parseAnnotationJson = (
  connection_name: string,
  raw: string,
): ConnectionMcpAnnotationState | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // topic_tags
  const tagsRaw = obj.topic_tags;
  const topic_tags: string[] = [];
  if (Array.isArray(tagsRaw)) {
    for (const t of tagsRaw) {
      if (typeof t === 'string' && t.length > 0) topic_tags.push(t);
    }
  }
  // tool_overrides
  const overridesRaw = obj.tool_overrides;
  const tool_overrides: Record<string, ConnectionMcpToolOverride> =
    Object.create(null);
  if (overridesRaw && typeof overridesRaw === 'object' && !Array.isArray(overridesRaw)) {
    for (const [k, v] of Object.entries(overridesRaw as Record<string, unknown>)) {
      if (typeof k !== 'string' || k.length === 0) continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const vo = v as Record<string, unknown>;
      const enabled = vo.enabled;
      const classification = vo.classification;
      if (typeof enabled !== 'boolean') continue;
      if (!isTier3ToolClassification(classification)) continue;
      const entry: ConnectionMcpToolOverride = { enabled, classification };
      const custom = vo.custom_topic_tags;
      // Codex W2.3 review P2 fold — preserve an explicit empty
      // `custom_topic_tags: []` verbatim. The validator already
      // accepts the empty-array shape as "Mary cleared per-tool tags
      // to suppress connection-level topic matching for this tool";
      // dropping it on read silently falls back to connection-level
      // tags, defeating the intent. `Array.isArray` is the only gate
      // (any non-array value is dropped); off-list members inside the
      // array are still filtered out.
      if (Array.isArray(custom)) {
        const tags: string[] = [];
        for (const c of custom) {
          if (typeof c === 'string' && c.length > 0) tags.push(c);
        }
        entry.custom_topic_tags = tags;
      }
      tool_overrides[k] = entry;
    }
  }
  // tools_list_cache
  const cacheRaw = obj.tools_list_cache;
  let tools: McpToolDescriptor[] = [];
  let cached_at = 0;
  if (cacheRaw && typeof cacheRaw === 'object' && !Array.isArray(cacheRaw)) {
    const cc = cacheRaw as Record<string, unknown>;
    if (typeof cc.cached_at === 'number' && Number.isFinite(cc.cached_at) && cc.cached_at >= 0) {
      cached_at = cc.cached_at;
    }
    const toolsRaw = cc.tools;
    if (Array.isArray(toolsRaw)) {
      const seen = new Set<string>();
      for (const t of toolsRaw) {
        if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
        const to = t as Record<string, unknown>;
        const name = to.name;
        if (typeof name !== 'string' || name.length === 0) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        const desc: McpToolDescriptor = { name };
        if (typeof to.description === 'string' && to.description.length > 0) {
          desc.description = to.description;
        }
        if (to.input_schema !== undefined) desc.input_schema = to.input_schema;
        if (typeof to.destructive_hint === 'boolean') {
          desc.destructive_hint = to.destructive_hint;
        }
        tools.push(desc);
      }
    }
  }
  const updated_at_raw = obj.updated_at;
  const updated_at =
    typeof updated_at_raw === 'number'
    && Number.isFinite(updated_at_raw)
    && updated_at_raw >= 0
      ? updated_at_raw
      : 0;
  // D-137 P4 § A.3 — recued_signature (optional). The JSON blob may
  // carry the post-probe signature; defensive narrowing rejects any
  // partial / mistyped persisted shape (treats it as absent — safer
  // than letting a malformed blob surface as a "Recued peer" in the
  // picker).
  let recued_signature: ConnectionMcpAnnotationState['recued_signature'] = null;
  const sigRaw = obj.recued_signature;
  if (sigRaw === null) {
    recued_signature = null;
  } else if (sigRaw && typeof sigRaw === 'object' && !Array.isArray(sigRaw)) {
    const so = sigRaw as Record<string, unknown>;
    if (
      so.server_kind === 'recued'
      && typeof so.version === 'string' && so.version.length > 0
      && typeof so.instance_id === 'string' && so.instance_id.length > 0
    ) {
      recued_signature = {
        server_kind: 'recued',
        version: so.version,
        instance_id: so.instance_id,
      };
    }
  }
  // D-137 P5 § A.7.1 + § A.10 — chat_mode (optional). Mirrors the
  // `recued_signature` defensive narrowing: corrupted / partial shapes
  // collapse to `null` so a malformed blob never surfaces as "chat-mode
  // offered" in the picker. `null` and absent both serialize back as
  // null on the value (the merge layer applies the absent-preserves-
  // prior rule, not the parse layer).
  //
  // Codex review P2 fold — fail-closed on a present-but-malformed
  // `session_cap`. The pre-fold behaviour dropped the cap silently
  // while keeping `offered: true`, converting "chat-mode offered with
  // cost-controls" into "offered uncapped." Collapsing the whole
  // chat_mode to null is the safe default.
  let chat_mode: ConnectionMcpAnnotationState['chat_mode'] = null;
  const chatModeRaw = obj.chat_mode;
  if (chatModeRaw === null) {
    chat_mode = null;
  } else if (chatModeRaw && typeof chatModeRaw === 'object' && !Array.isArray(chatModeRaw)) {
    const cm = chatModeRaw as Record<string, unknown>;
    const offered = cm.offered;
    if (typeof offered === 'boolean') {
      const hasCap = Object.prototype.hasOwnProperty.call(cm, 'session_cap');
      if (!hasCap) {
        chat_mode = { offered };
      } else {
        const capRaw = cm.session_cap;
        if (capRaw === undefined || capRaw === null) {
          chat_mode = { offered };
        } else if (
          !capRaw
          || typeof capRaw !== 'object'
          || Array.isArray(capRaw)
        ) {
          chat_mode = null;
        } else {
          const co = capRaw as Record<string, unknown>;
          const per_day = co.per_day;
          const concurrent = co.concurrent;
          if (
            typeof per_day === 'number' && Number.isInteger(per_day) && per_day >= 0
            && typeof concurrent === 'number' && Number.isInteger(concurrent) && concurrent >= 0
          ) {
            chat_mode = { offered, session_cap: { per_day, concurrent } };
          } else {
            chat_mode = null;
          }
        }
      }
    }
  }
  return {
    connection_name,
    topic_tags,
    tool_overrides,
    tools_list_cache: { tools, cached_at },
    recued_signature,
    chat_mode,
    updated_at,
  };
};

/** Serialize an annotation for SQLite storage. The store stamps
 *  `updated_at` from a separate integer column so the blob's
 *  `updated_at` field stays informational only (used as the source of
 *  truth on read, but the indexed column is the sort key). */
const annotationToJson = (
  ann: Omit<ConnectionMcpAnnotationState, 'connection_name'> & {
    connection_name?: never;
  },
): string => JSON.stringify({
  topic_tags: ann.topic_tags,
  tool_overrides: ann.tool_overrides,
  tools_list_cache: ann.tools_list_cache,
  recued_signature: ann.recued_signature ?? null,
  chat_mode: ann.chat_mode ?? null,
  updated_at: ann.updated_at,
});

export const createChatConnectionMcpStore = (
  db: Database.Database,
): ChatConnectionMcpStore => {
  const selectStmt = db.prepare<{ connection_name: string }>(
    `SELECT * FROM chat_connection_mcp_annotations
       WHERE connection_name = @connection_name`,
  );
  const listStmt = db.prepare(
    `SELECT * FROM chat_connection_mcp_annotations
       ORDER BY updated_at DESC, connection_name ASC`,
  );
  const upsertStmt = db.prepare(`
    INSERT INTO chat_connection_mcp_annotations
      (connection_name, annotation_json, updated_at)
      VALUES (@connection_name, @annotation_json, @updated_at)
    ON CONFLICT(connection_name) DO UPDATE SET
      annotation_json = excluded.annotation_json,
      updated_at      = excluded.updated_at
  `);
  const deleteStmt = db.prepare(
    `DELETE FROM chat_connection_mcp_annotations
       WHERE connection_name = ?`,
  );

  return {
    getAnnotation(connection_name): ConnectionMcpAnnotationState {
      const row = selectStmt.get({ connection_name }) as Row | undefined;
      if (!row) return buildDefaultConnectionMcpAnnotation(connection_name);
      const parsed = parseAnnotationJson(connection_name, row.annotation_json);
      if (!parsed) {
        // Corrupted blob — surface the default with the row's
        // `updated_at` so the Settings page can show "last updated"
        // honestly while the body is empty.
        return {
          ...buildDefaultConnectionMcpAnnotation(connection_name),
          updated_at: row.updated_at,
        };
      }
      // The indexed `updated_at` column is the authoritative timestamp.
      return { ...parsed, updated_at: row.updated_at };
    },
    listAnnotations(): ReadonlyArray<ConnectionMcpAnnotationState> {
      const rows = listStmt.all() as Row[];
      const out: ConnectionMcpAnnotationState[] = [];
      for (const row of rows) {
        const parsed = parseAnnotationJson(
          row.connection_name,
          row.annotation_json,
        );
        if (!parsed) continue;
        out.push({ ...parsed, updated_at: row.updated_at });
      }
      return out;
    },
    setAnnotation({ value, now }): ConnectionMcpAnnotationState {
      const updated_at = now ?? Date.now();
      // D-137 P4 § A.3 / P5 § A.10 — merge rules for nullable optional
      // fields. Both `recued_signature` and `chat_mode` use the same
      // posture:
      //   - undefined on validated input  → preserve the prior persisted
      //     value (legacy `chat.connection_mcp.set` writes from before
      //     the field landed must not accidentally clear it).
      //   - null on validated input        → caller explicitly cleared.
      //   - object on validated input      → caller stamped fresh state.
      //
      // Both fields read from the same prior-row parse so we look up
      // once per `setAnnotation` call.
      let recued_signature: ConnectionMcpAnnotationState['recued_signature'];
      let chat_mode: ConnectionMcpAnnotationState['chat_mode'];
      const hasSig = Object.prototype.hasOwnProperty.call(value, 'recued_signature');
      const hasChatMode = Object.prototype.hasOwnProperty.call(value, 'chat_mode');
      let prior: ConnectionMcpAnnotationState | null = null;
      if (!hasSig || !hasChatMode) {
        const row = selectStmt.get({ connection_name: value.connection_name }) as Row | undefined;
        prior = row
          ? parseAnnotationJson(value.connection_name, row.annotation_json)
          : null;
      }
      recued_signature = hasSig
        ? (value.recued_signature ?? null)
        : (prior?.recued_signature ?? null);
      chat_mode = hasChatMode
        ? (value.chat_mode ?? null)
        : (prior?.chat_mode ?? null);
      const annotation: ConnectionMcpAnnotationState = {
        connection_name: value.connection_name,
        topic_tags: value.topic_tags,
        tool_overrides: value.tool_overrides,
        tools_list_cache: value.tools_list_cache,
        recued_signature,
        chat_mode,
        updated_at,
      };
      const annotation_json = annotationToJson({
        topic_tags: annotation.topic_tags,
        tool_overrides: annotation.tool_overrides,
        tools_list_cache: annotation.tools_list_cache,
        recued_signature: annotation.recued_signature,
        chat_mode: annotation.chat_mode,
        updated_at: annotation.updated_at,
      });
      upsertStmt.run({
        connection_name: value.connection_name,
        annotation_json,
        updated_at,
      });
      return annotation;
    },
    deleteAnnotation(connection_name): boolean {
      const result = deleteStmt.run(connection_name);
      return result.changes > 0;
    },
  };
};

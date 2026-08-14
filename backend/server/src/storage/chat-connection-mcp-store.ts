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
  const updated_at_raw = obj.updated_at;
  const updated_at =
    typeof updated_at_raw === 'number'
    && Number.isFinite(updated_at_raw)
    && updated_at_raw >= 0
      ? updated_at_raw
      : 0;
  // ⛔⛔ D-228 slice 6 — `tools_list_cache` / `recued_signature` / `chat_mode`
  // are GONE FROM THE ROW, not merely from the type, and that is the one place
  // this slice differs from `tool_overrides` below.
  //
  // 🔑 THE RULE: PRESERVE WHAT THE OWNER TYPED, DROP WHAT THE MACHINE CACHED.
  // `tool_overrides` was owner-authored (a classification Mary chose), so it is
  // parsed and carried until the migration drains it. These three were PROBE
  // RESULTS — the upstream tool list, the peer's `recued`/version fingerprint,
  // and what chat-mode that peer advertised. Every one is re-derivable by asking
  // the server again, which is exactly what `probeMintableDescriptors` already
  // does at mint. Carrying them would preserve a cache nothing reads and no
  // migration wants.
  //
  // ~110 lines of defensive narrowing lived here (duplicate-tool dedup, the
  // server_kind/version/instance_id triple, the fail-closed `session_cap`
  // integer check folded in from a Codex review). Deleted with their fields.
  return {
    connection_name,
    topic_tags,
    // ⛔⛔ D-228 slice 4 — `tool_overrides` LEFT THE LIVE SHAPE BUT NOT THE ROW.
    // The column is still parsed above and surfaced through
    // `legacyToolOverrides` below, because the classification MIGRATION
    // (`carryMcpToolClassifications`) reads it: deleting the field and its only
    // reader in one release would strand every owner's recorded classification
    // in a column nothing drains. A migration that cannot see what it migrates
    // is not a migration.
    ...({ [LEGACY_OVERRIDES]: tool_overrides } as Record<string, unknown>),
    updated_at,
  };
};

/** D-228 slice 4 — the key the retired `tool_overrides` map hides under.
 *
 *  ⚠ A SYMBOL-ISH STRING, not a typed field, ON PURPOSE. The field is deleted
 *  from `ConnectionMcpAnnotationState`, so nothing can read it by accident; only
 *  the migration, which asks for it by this name, can see it. When the migration
 *  retires, this and the column go together. */
export const LEGACY_OVERRIDES = '__legacy_tool_overrides';

/** D-228 slice 4 — read the retired per-tool classifications for one connection.
 *  The ONLY supported reader; every other consumer moved to the pack operation's
 *  own risk tier. */
export const legacyToolOverrides = (
  annotation: unknown,
): Readonly<Record<string, { enabled: boolean; classification: string }>> => {
  const raw = (annotation as Record<string, unknown> | null)?.[LEGACY_OVERRIDES];
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, { enabled: boolean; classification: string }>)
    : {};
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
  // ⚠ PRESERVED ON WRITE, NEVER AUTHORED. Nothing produces new overrides since
  // slice 4, but a row rewritten before the migration drained it must not lose
  // the values the migration is coming for.
  tool_overrides:
    (ann as unknown as Record<string, unknown>)[LEGACY_OVERRIDES] ?? {},
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
      // ⛔⛔ D-228 slice 6 — THE PRIOR ROW IS READ UNCONDITIONALLY, AND THAT IS A
      // FIX, NOT A REFACTOR.
      //
      // This lookup used to be gated on `!hasSig || !hasChatMode` — it existed to
      // serve the preserve-on-absent merge rule for `recued_signature` /
      // `chat_mode`. But slice 4 then hung `legacyToolOverrides(prior)` off the
      // SAME `prior`, unconditionally. A caller that sent BOTH fields left
      // `prior` null, and the overrides column the migration is coming for was
      // silently rewritten to `{}` — the exact loss slice 4's note claims to
      // prevent.
      //
      // ⚠ LATENT, NOT LIVE: the two writers that would naturally stamp the pair
      // together were `chat.picker.refresh` and the Settings → Tools panel, and
      // BOTH were clientless surfaces (that is why slices 4 and 5 could delete
      // them). Nothing was actually wiping anything.
      //
      // 🔑 WHY 41 GREEN STORE TESTS COULD NOT SEE IT: the preservation test
      // writes a value that OMITS both fields — the only shape under which the
      // guard reads `prior` at all. A fixture that never takes the branch cannot
      // show what the branch breaks. Deleting the fields removes the condition
      // and the hazard together; the assertion below pins the survivor.
      const priorRow = selectStmt.get({
        connection_name: value.connection_name,
      }) as Row | undefined;
      const prior = priorRow
        ? parseAnnotationJson(value.connection_name, priorRow.annotation_json)
        : null;
      const annotation: ConnectionMcpAnnotationState = {
        connection_name: value.connection_name,
        topic_tags: value.topic_tags,
        updated_at,
        // ⚠ Carried from the PRIOR row, never from the wire. A write can no
        // longer author a classification; it must also not erase one the
        // migration has not drained yet.
        ...({ [LEGACY_OVERRIDES]: legacyToolOverrides(prior) } as Record<string, unknown>),
      };
      const annotation_json = annotationToJson({
        topic_tags: annotation.topic_tags,
        ...({ [LEGACY_OVERRIDES]: legacyToolOverrides(prior) } as Record<string, unknown>),
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

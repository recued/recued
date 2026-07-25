/** D-137 W2.2 § A.1.1 + § P1 — Mary's per-kind catalog scope storage.
 *
 *  Singleton-per-pair row (NOT per-session) holding the closed-list
 *  `IngredientKind` set Mary has enabled for her chat agent's Tier 2
 *  catalog. The orchestrator reads this at every turn start to derive
 *  the `kindGatedTier2Names` set the main-turn catalog projection
 *  (`buildChatMainTurnTools`) consumes; the Settings → Chat → Tool
 *  Catalog Scope page reads/writes via the `chat.tool_catalog.*` rpc
 *  family.
 *
 *  Per § Must Hold (D-137-equivalent) — table lives in the per-pair
 *  SQLite db; no cross-cloud sync (D-097 / D-168). The closed-list
 *  `IngredientKind` membership is the only
 *  contract; the row stores the JSON-encoded array verbatim, never
 *  derived state — recomputing kind-gated Tier 2 names is the
 *  orchestrator's pure-function concern.
 *
 *  Idempotent `ensureChatToolCatalogSchema` + a thin CRUD store with
 *  `getScope() / setScope()`. Reads return the substrate default
 *  (`DEFAULT_CHAT_CATALOG_SCOPE`) when no row exists yet so first-boot
 *  callers always see a stable shape.
 */

import type Database from 'better-sqlite3';
import {
  DEFAULT_CHAT_CATALOG_SCOPE,
  INGREDIENT_KINDS,
  SAFE_DEFAULT_CHAT_CATALOG_KINDS,
  type ChatToolCatalogScopeState,
  type IngredientKind,
} from '@recued/contracts';

/** Idempotent schema install. Single-row table — the singleton key is
 *  the literal id `1`. Strict CHECK gates the literal-1 invariant so a
 *  bug that tries to write id=2 fails fast rather than silently
 *  creating a second scope. */
export const ensureChatToolCatalogSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_tool_catalog_scope (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      enabled_kinds_json TEXT NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);
};

interface Row {
  id: number;
  enabled_kinds_json: string;
  updated_at: number;
}

export interface ChatToolCatalogStore {
  /** Read the persisted scope. Returns the substrate default
   *  (`DEFAULT_CHAT_CATALOG_SCOPE`) when no row exists yet. */
  getScope(): ChatToolCatalogScopeState;
  /** Persist a new scope. Inputs are wire-trusted at this point —
   *  the rpc handler validates via `validateChatToolCatalogScopeInput`
   *  before calling. Returns the persisted shape (stamped
   *  `updated_at`). */
  setScope(input: {
    enabled_kinds: ReadonlyArray<IngredientKind>;
    now?: number;
  }): ChatToolCatalogScopeState;
}

/** Best-effort parser. Returns `null` on any shape error so the caller
 *  can fall back to the substrate default — corrupted rows never crash
 *  the chat surface. */
const parseEnabledKindsJson = (raw: string): ReadonlyArray<IngredientKind> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<IngredientKind>();
  for (const member of parsed) {
    if (typeof member !== 'string') return null;
    if (!INGREDIENT_KINDS.has(member as IngredientKind)) return null;
    seen.add(member as IngredientKind);
  }
  // Preserve canonical declaration order so the persisted shape stays
  // stable across re-reads regardless of insertion order.
  const ordered: IngredientKind[] = [];
  for (const k of INGREDIENT_KINDS) {
    if (seen.has(k)) ordered.push(k);
  }
  return ordered;
};

export const createChatToolCatalogStore = (
  db: Database.Database,
): ChatToolCatalogStore => {
  const selectStmt = db.prepare<{ id: number }>(
    `SELECT * FROM chat_tool_catalog_scope WHERE id = @id`,
  );
  const upsertStmt = db.prepare(`
    INSERT INTO chat_tool_catalog_scope (id, enabled_kinds_json, updated_at)
    VALUES (1, @json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      enabled_kinds_json = excluded.enabled_kinds_json,
      updated_at         = excluded.updated_at
  `);

  return {
    getScope(): ChatToolCatalogScopeState {
      const row = selectStmt.get({ id: 1 }) as Row | undefined;
      if (!row) {
        // First boot — no row written yet. Return the substrate
        // default so callers always see a stable shape; the next
        // `setScope` materialises the row.
        return {
          enabled_kinds: SAFE_DEFAULT_CHAT_CATALOG_KINDS,
          updated_at: DEFAULT_CHAT_CATALOG_SCOPE.updated_at,
        };
      }
      const parsed = parseEnabledKindsJson(row.enabled_kinds_json);
      if (!parsed) {
        // Corrupted row — surface the default. Don't auto-rewrite the
        // bad row (a setScope call from the rpc handler is the only
        // mutation path). The Settings page will re-stamp on next
        // write.
        return {
          enabled_kinds: SAFE_DEFAULT_CHAT_CATALOG_KINDS,
          updated_at: row.updated_at,
        };
      }
      return {
        enabled_kinds: parsed,
        updated_at: row.updated_at,
      };
    },
    setScope({ enabled_kinds, now }) {
      const updated_at = now ?? Date.now();
      // Canonicalize ordering so persisted state is stable regardless
      // of the caller's insertion order. Mirrors the validator's
      // canonicalization step + matches W2.1's audit-friendly
      // posture.
      const seen = new Set<IngredientKind>(enabled_kinds);
      const ordered: IngredientKind[] = [];
      for (const k of INGREDIENT_KINDS) {
        if (seen.has(k)) ordered.push(k);
      }
      upsertStmt.run({
        json: JSON.stringify(ordered),
        updated_at,
      });
      return {
        enabled_kinds: ordered,
        updated_at,
      };
    },
  };
};

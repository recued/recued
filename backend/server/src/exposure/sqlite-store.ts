/** D-148 W3.9 — SQLite-backed `ExposureStateStore` implementation.
 *
 *  Production wiring for the W3.5 state-machine substrate. W3.5 shipped
 *  an in-memory store so Mary's preset choices did not survive a server
 *  restart; W3.9 promotes the same `ExposureStateStore` contract to a
 *  single-row SQLite table so the persisted resolution + ack survive
 *  reboots.
 *
 *  Store discipline:
 *    - Singleton row keyed `id = 1` (CHECK constraint enforces literal
 *      one). Mirrors `chat_tool_catalog_scope` + every other per-pair
 *      singleton store in the server.
 *    - `state_json` carries the full `ExposureState` shape verbatim. The
 *      shape is small + closed-list (5 paths × 2 bits + ack + scalars);
 *      JSON keeps round-trip trivial without introducing column drift on
 *      every spec change.
 *    - Parse failures (corrupted JSON / unknown enum value / missing
 *      field) fall back to `null` from `load()` — the state machine's
 *      `loadOrInit` path then seeds from `DEFAULT_EXPOSURE_STATE` and
 *      the next `save()` overwrites the bad row. The store never crashes
 *      the boot path on a corrupted row.
 *    - Per-pair only — no cross-cloud sync (D-097 / D-168). The
 *      exposure state is operator gestures against the LAN/public
 *      surface of this specific server; cross-device sync would be
 *      category-incorrect.
 *
 *  Schema is idempotent (`CREATE TABLE IF NOT EXISTS`) — safe to call on
 *  every boot. Mirrors the per-store install pattern used by
 *  `ensureChatToolCatalogSchema` / `ensureReceptionSchema` /
 *  `ensureTlsDomainSchema`.
 */

import type Database from 'better-sqlite3';
import {
  EXPOSURE_PRESETS,
  PATH_ROLES,
  totalRecord,
  isAcknowledgementWellFormed,
  isPathResolution,
  type ExposurePreset,
  type ExposureState,
  type PathResolution,
  type PathRole,
  type PublicMcpAcknowledgement,
} from '@recued/contracts';
import type { ExposureStateStore } from './index.js';

/** Closed-list table inventory — W3.9 ships one row-per-server table. */
export const EXPOSURE_TABLES = ['exposure_state'] as const;
export type ExposureTableName = (typeof EXPOSURE_TABLES)[number];

/** Idempotent schema install. Single-row table — the singleton key is
 *  the literal id `1`. CHECK gates the literal-1 invariant so a stray
 *  write that tries id=2 fails fast rather than silently creating a
 *  second exposure state. */
export const ensureExposureSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exposure_state (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      state_json  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
};

interface Row {
  id: number;
  state_json: string;
  updated_at: number;
}

type DerivedPresetLabel = ExposurePreset | 'custom';

const isDerivedPresetLabel = (v: unknown): v is DerivedPresetLabel => {
  if (typeof v !== 'string') return false;
  if (v === 'custom') return true;
  return (EXPOSURE_PRESETS as ReadonlyArray<string>).includes(v);
};

const isResolution = (
  v: unknown,
): v is Record<PathRole, PathResolution> => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  for (const role of PATH_ROLES) {
    if (!isPathResolution(r[role])) return false;
  }
  return true;
};

const isPublicMcpAcknowledgement = (
  v: unknown,
): v is PublicMcpAcknowledgement => {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (typeof a.acknowledged !== 'boolean') return false;
  if (a.acknowledged_at !== undefined && typeof a.acknowledged_at !== 'number') return false;
  if (
    a.acknowledged_by_client_id !== undefined &&
    typeof a.acknowledged_by_client_id !== 'string'
  ) {
    return false;
  }
  if (
    a.free_text_confirmation !== undefined &&
    typeof a.free_text_confirmation !== 'string'
  ) {
    return false;
  }
  if (a.reason !== undefined && typeof a.reason !== 'string') return false;
  return true;
};

/** Best-effort parser. Returns `null` on any shape error so the
 *  state-machine `loadOrInit` falls back to `DEFAULT_EXPOSURE_STATE`.
 *  Corrupted rows never crash the exposure surface — the next save()
 *  re-stamps with a valid shape.
 *
 *  Codex W3.9 P1 fold — additionally rejects rows that violate the
 *  public-MCP proof invariant. The state machine enforces the
 *  acknowledgement gate on every mutation; a tampered or partially-
 *  written SQLite row could carry `acknowledged: true` without the
 *  canonical phrase OR `resolution.mcp.public: true` without an
 *  effectively-on ack. Either lets `reapply()` bind `/mcp.public`
 *  without re-running the gate at boot — a security-relevant
 *  persistence-validation gap. The two extra guards collapse those
 *  states to "corrupted row" so the state machine falls back to
 *  `DEFAULT_EXPOSURE_STATE` (lan_only, no ack) and Mary's next gesture
 *  re-stamps a valid row. */
const parseStateJson = (raw: string): ExposureState | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (!isResolution(r.resolution)) return null;
  if (!isDerivedPresetLabel(r.derived_preset_label)) return null;
  if (!isPublicMcpAcknowledgement(r.public_mcp_acknowledgement)) return null;
  if (typeof r.last_changed_at !== 'number') return null;
  if (typeof r.changed_by_client_id !== 'string') return null;
  if (r.reason !== undefined && typeof r.reason !== 'string') return null;
  // Public-MCP proof invariant — first guard: the acknowledgement record
  // must be well-formed. `acknowledged: true` without the canonical
  // free_text_confirmation phrase is rejected (mirrors
  // `isAcknowledgementWellFormed` in contracts; same predicate the rpc
  // gates use).
  if (!isAcknowledgementWellFormed(r.public_mcp_acknowledgement)) return null;
  // Public-MCP proof invariant — second guard: `resolution.mcp.public:
  // true` requires the ack to be effectively on (well-formed AND
  // acknowledged). A tampered row that sets mcp.public true without a
  // valid ack would otherwise survive load() and `reapply()` would bind
  // /mcp.public bypassing the gate.
  // ⚠ DELIBERATELY NOT `isAcknowledgementEffectivelyOn`. The guard above
  // already rejected ANY malformed acknowledgement, whether or not
  // `mcp.public` is set — strictly stronger than the composite predicate, and
  // right for a stored row: a row whose ack is malformed is corrupt even when
  // nothing is currently public. Collapsing the pair into the composite would
  // silently weaken that to "only malformed when it matters".
  if (r.resolution.mcp.public && !r.public_mcp_acknowledgement.acknowledged) {
    return null;
  }
  // Project a fresh object so future mutation of the parsed JSON
  // doesn't leak into other callers. Mirrors `cloneState` in index.ts.
  // ⚠ Bound to a const FIRST: the guards above narrow `r.resolution` off
  // `unknown`, and that narrowing does not survive into a callback. Reading it
  // inside the builder would be `unknown` again.
  const src = r.resolution;
  const resolution = totalRecord(PATH_ROLES, (role) => {
    const cell = src[role];
    return { lan: cell.lan, public: cell.public };
  });
  const out: ExposureState = {
    resolution,
    derived_preset_label: r.derived_preset_label,
    public_mcp_acknowledgement: { ...r.public_mcp_acknowledgement },
    last_changed_at: r.last_changed_at,
    changed_by_client_id: r.changed_by_client_id,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
  };
  return out;
};

/** Project the persisted shape to a serialisable JSON object. Excludes
 *  `undefined` optionals so `JSON.parse(JSON.stringify(...))` round-
 *  trips identically — important for the `load()` predicate gates
 *  which reject records carrying unexpected fields. */
const serializeState = (state: ExposureState): string => {
  const resolution = totalRecord(PATH_ROLES, (role) => {
    const cell = state.resolution[role];
    return { lan: cell.lan, public: cell.public };
  });
  const projected: Record<string, unknown> = {
    resolution,
    derived_preset_label: state.derived_preset_label,
    public_mcp_acknowledgement: { ...state.public_mcp_acknowledgement },
    last_changed_at: state.last_changed_at,
    changed_by_client_id: state.changed_by_client_id,
  };
  if (state.reason !== undefined) projected.reason = state.reason;
  return JSON.stringify(projected);
};

/** Build the SQLite-backed exposure store. Caller has already run
 *  `ensureExposureSchema(db)` at boot. The interface honours the W3.5
 *  `ExposureStateStore` contract: async `load()` returns `null` when no
 *  row is persisted yet; async `save(state)` upserts the singleton. */
export const createSqliteExposureStore = (
  db: Database.Database,
): ExposureStateStore => {
  const selectStmt = db.prepare<{ id: number }>(
    `SELECT * FROM exposure_state WHERE id = @id`,
  );
  const upsertStmt = db.prepare(`
    INSERT INTO exposure_state (id, state_json, updated_at)
    VALUES (1, @state_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);

  return {
    async load(): Promise<ExposureState | null> {
      const row = selectStmt.get({ id: 1 }) as Row | undefined;
      if (!row) return null;
      return parseStateJson(row.state_json);
    },
    async save(state: ExposureState): Promise<void> {
      upsertStmt.run({
        state_json: serializeState(state),
        updated_at: state.last_changed_at,
      });
    },
  };
};

/** Shared `audit_activities` JSON-extract helpers for connection-scope
 *  producers.
 *
 *  Lifted from A.18 `connection_health_trend` at A.19 — second caller
 *  was the trigger to extract per the codebase convention. A.20
 *  (`connection_optimal_batch_size`) will be the third.
 *
 *  Owns:
 *    - `ParsedConnectionAuditRow` shape — every field A.18 / A.19 / A.20
 *      may want, all optional except `ts`. Each producer reads only
 *      the fields it cares about.
 *    - `collectConnectionActivities` — pre-narrows on
 *      `(action, target, timestamp >= cutoff)` via `json_extract` and
 *      JSON-parses each row's `data` + `data.detail` defensively.
 *      Tolerates a missing `audit_activities` table (test harnesses
 *      without an audit collection wired) and a malformed `detail` blob
 *      (forensic case where an external write corrupted a row — the
 *      audit emitter writes well-formed JSON unconditionally).
 *    - `ACTION_FOR_CONNECTION_KIND` — single source of truth for the
 *      `action` discriminator on each connection-kind audit row. Mirrors
 *      `server-executor.ts:ACTION_FOR_CONNECTION_KIND` on the write
 *      side; centralising here keeps the read side from drifting.
 *
 *  Returned rows are NOT sorted — callers fold them into stats and
 *  track ordered signals (last_call_at, last_failure, …) separately.
 *  Sample order doesn't matter for the aggregates each caller computes. */

import type { ConnectionKind } from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';

/** Audit `ActivityEntry.action` discriminator per kind — matches the
 *  write side at `server-executor.ts:ACTION_FOR_CONNECTION_KIND`. */
export const ACTION_FOR_CONNECTION_KIND: Record<ConnectionKind, string> = {
  api: 'connection_api',
  mcp: 'connection_mcp',
  notification: 'connection_notification',
};

/** Parsed `audit_activities` row for connection-scope producers. Every
 *  optional field reflects a `ConnectionAuditDetail` field that may or
 *  may not have been emitted (older callers, direct-rpc paths, missing
 *  bytes accounting, …). Producers read only the fields they care
 *  about — A.18 reads status / duration / error; A.19 reads recipe_id;
 *  A.20 will read bytes / duration. */
export interface ParsedConnectionAuditRow {
  /** Epoch ms — `entry.timestamp`. Always present (rows missing a
   *  finite ts are dropped at parse time). */
  ts: number;
  /** `detail.status`. Defaults to `'ok'` when the detail blob lacked
   *  the field (forward-compat for callers that only need the row
   *  count, not the success/error split). */
  status: 'ok' | 'error';
  /** `detail.duration_ms`. Defaults to `0` when absent — A.18's p50/p95
   *  floor screens out rows without meaningful latency anyway. */
  duration_ms: number;
  /** `detail.error.code` when `status === 'error'` and the error block
   *  was emitted; `null` otherwise (including for status='ok' rows). */
  error_code: string | null;
  /** `detail.error.message` paired with `error_code`. */
  error_message: string | null;
  /** `detail.recipe_id` — engine-supplied recipe identity (D-127
   *  follow-on). `null` for direct-rpc callers (Settings probe, MCP
   *  agent, raw test calls). */
  recipe_id: string | null;
  /** `detail.step_id` — paired with `recipe_id` (both are present or
   *  both are absent in well-formed emissions). */
  step_id: string | null;
  /** `detail.bytes_in` when emitted, else `null`. Optional adapter-side
   *  accounting — present for HTTP-backed connections, absent for MCP. */
  bytes_in: number | null;
  /** `detail.bytes_out` when emitted, else `null`. */
  bytes_out: number | null;
}

const parseString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

const parseFiniteNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Pull every audit activity for `(kind, name)` whose timestamp is at
 *  or after `cutoff`. Each row's `data` column carries the JSON-encoded
 *  `ActivityEntry`; `data.detail` is the JSON-encoded
 *  `ConnectionAuditDetail`. Tolerates a missing `audit_activities`
 *  table (test harnesses without an audit collection wired) by
 *  returning an empty array.
 *
 *  Returned rows are NOT sorted — see file-level note. */
export const collectConnectionActivities = (
  ctx: HousekeepingContext,
  kind: ConnectionKind,
  name: string,
  cutoff: number,
): ParsedConnectionAuditRow[] => {
  const tableExists = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='audit_activities'`,
    )
    .get() as { name: string } | undefined;
  if (!tableExists) return [];

  const action = ACTION_FOR_CONNECTION_KIND[kind];
  const rows = ctx.db
    .prepare(
      `SELECT data FROM audit_activities
        WHERE json_extract(data, '$.action') = ?
          AND json_extract(data, '$.target') = ?
          AND json_extract(data, '$.timestamp') >= ?`,
    )
    .all(action, name, cutoff) as Array<{ data: string }>;

  const out: ParsedConnectionAuditRow[] = [];
  for (const row of rows) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = parseFiniteNumber(entry.timestamp);
    if (ts === null) continue;

    let detail: Record<string, unknown> = {};
    if (typeof entry.detail === 'string') {
      try {
        const parsed = JSON.parse(entry.detail) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed detail blob — skip the row entirely. The audit
        // emitter writes well-formed JSON; a parse failure here is
        // forensic but shouldn't pollute the aggregate.
        continue;
      }
    }

    const status = detail.status === 'error' ? 'error' : 'ok';
    const duration_ms = parseFiniteNumber(detail.duration_ms) ?? 0;

    let error_code: string | null = null;
    let error_message: string | null = null;
    if (
      status === 'error' &&
      detail.error !== null &&
      typeof detail.error === 'object' &&
      !Array.isArray(detail.error)
    ) {
      const err = detail.error as Record<string, unknown>;
      if (typeof err.code === 'string') error_code = err.code;
      if (typeof err.message === 'string') error_message = err.message;
    }

    out.push({
      ts,
      status,
      duration_ms,
      error_code,
      error_message,
      recipe_id: parseString(detail.recipe_id),
      step_id: parseString(detail.step_id),
      bytes_in: parseFiniteNumber(detail.bytes_in),
      bytes_out: parseFiniteNumber(detail.bytes_out),
    });
  }
  return out;
};

/** Shared connection-record helpers for connection-scope producers.
 *
 *  Lifted from A.18 `connection_health_trend` at A.19 — second caller
 *  was the trigger to extract per the codebase convention. A.20
 *  (`connection_optimal_batch_size`) will reuse the same scan + scope
 *  mapping. Future connection-scope producers should import from here
 *  rather than re-implementing.
 *
 *  Owns:
 *    - `EnrolledConnection` shape — `(kind, name)` pair as the producer
 *      identity for a connection record.
 *    - `scanEnrolledConnections` — `SELECT kind, name FROM connections`
 *      with table-missing tolerance for fresh-pair / first-boot
 *      scenarios. Newest-by-`updated_at` first so the cap loses oldest
 *      enrollments.
 *    - `SCOPE_FOR_CONNECTION_KIND` / `KIND_FOR_CONNECTION_SCOPE` — the
 *      single source of truth for the kind ↔ enrichment-scope mapping.
 *      Both producer and sweep consult these.
 *    - `MAX_CONNECTIONS_SCANNED` — defensive cap; a typical user has
 *      < 20 enrolled connections.
 *
 *  The connection records themselves live in the `connections` SQLite
 *  table (D-125 P5 — `collection.connection.*` rpc), not a memory or
 *  warehouse collection. Producers read them as enumeration roots and
 *  emit one row per `(kind, name)`. */

import type { ConnectionKind, EnrichmentScope } from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';

/** Hard cap on connections walked in one cycle. Defensive — a typical
 *  pair has fewer than 20 enrolled connections; the cap prevents a
 *  pathological setup from monopolising the housekeeping budget. */
export const MAX_CONNECTIONS_SCANNED = 200;

/** Map a `ConnectionKind` to its `EnrichmentScope`. Single source of
 *  truth — both producers and sweeps consult this. */
export const SCOPE_FOR_CONNECTION_KIND: Record<ConnectionKind, EnrichmentScope> = {
  api: 'connection.api',
  mcp: 'connection.mcp',
  notification: 'connection.notification',
};

/** Reverse lookup — used by sweeps to retire stale rows whose target
 *  connection no longer exists. Partial because non-connection scopes
 *  (`mail` / `calendar` / …) are intentionally absent. */
export const KIND_FOR_CONNECTION_SCOPE: Partial<Record<EnrichmentScope, ConnectionKind>> = {
  'connection.api': 'api',
  'connection.mcp': 'mcp',
  'connection.notification': 'notification',
};

export interface EnrolledConnection {
  kind: ConnectionKind;
  name: string;
}

/** List enrolled connection records as `(kind, name)` pairs. Tolerates
 *  a missing `connections` table — fresh pairs that haven't enrolled
 *  any connection yet skip the cycle cleanly. Newest-by-`updated_at`
 *  first so a corpus over the cap loses the oldest enrollments
 *  (acceptable: an unused stale enrollment carries no signal anyway). */
export const scanEnrolledConnections = (
  ctx: HousekeepingContext,
  limit: number = MAX_CONNECTIONS_SCANNED,
): EnrolledConnection[] => {
  const tableExists = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='connections'`,
    )
    .get() as { name: string } | undefined;
  if (!tableExists) return [];

  const rows = ctx.db
    .prepare(
      `SELECT kind, name FROM connections
        ORDER BY updated_at DESC, name ASC
        LIMIT ?`,
    )
    .all(limit) as Array<{ kind: ConnectionKind; name: string }>;

  return rows.map((r) => ({ kind: r.kind, name: r.name }));
};

/** Compose the `(scope, target_id)` membership key sweeps use to decide
 *  whether a row was refreshed this cycle. Stable across runs; a
 *  connection that retains the same `(kind, name)` hits the same key
 *  so the sweep upserts in place rather than churning. Topic-agnostic
 *  — every connection-scope producer's sweep can use the same shape. */
export const composeConnectionFreshKey = (
  scope: EnrichmentScope,
  target_id: string,
): string => `${scope} ${target_id}`;

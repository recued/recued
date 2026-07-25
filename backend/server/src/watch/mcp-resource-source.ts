/** WatchSource generalization — the mcp-resource poll source.
 *
 *  The 2nd `WatchPollSource` (after the founding connection-api poll):
 *  demand parses from enabled trigger rows whose pattern targets
 *  `data.connection.mcp.<connection_name>.resource.<encoded_uri>.…`,
 *  validates the named connection is an enrolled `connection.mcp`
 *  instance, and reads ONE resource per tick via `resources/read`
 *  (the read-only adapter primitive shipped in brick 1). The manager
 *  core hash-diffs the resource content against the persisted snapshot
 *  and emits the canonical change event — on the dedicated
 *  `connection.mcp` bus family (via `event_scope`), never the
 *  connection-api platform-reference scope.
 *
 *  Mapping onto the universal `(vendor, entity, connection)` poll key:
 *    - `vendor`  = `mcp` (sentinel — `MCP_RESOURCE_WATCH_VENDOR`);
 *    - `entity`  = `encodeMcpResourceUri(uri)` (a uri carries `/` `:`
 *                  `.`, so the base64url form rides one bus segment +
 *                  keys the watch; `poll` decodes it back for the wire);
 *    - `connection_name` = the mcp connection.
 *  `watchKeyOf('mcp', encoded, conn)` = `mcp/<encoded>/<conn>` — a
 *  namespace the connection-api source never mints, so the manager's
 *  first-claimant collision guard never trips between them.
 *
 *  Unlike connection-api, there is no higher-fidelity twin to defer to
 *  (no mcp webhook / reconciler feed), so every demand is `deferred_to:
 *  null`. And unlike `runCanonicalWatchPoll`'s `<entity>.search` walk,
 *  the fetch reads exactly one resource — a different shape, so it is a
 *  dedicated plug (`readResource`), not a reuse. */

import type { EventTrigger } from '@recued/contracts';
import {
  MCP_RESOURCE_POLL_SOURCE_ID,
  MCP_RESOURCE_WATCH_VENDOR,
  decodeMcpResourceUri,
  encodeMcpResourceUri,
  mcpResourceEventScope,
  parseMcpResourceWatchDemand,
  watchKeyOf,
} from '@recued/contracts';
import type { CanonicalPollOutcome } from './canonical-poll.js';
import type { WatchPollDemand, WatchPollSource } from './poll-manager.js';

/** Outcome of one `resources/read` fetch-plug call. The source wraps an
 *  `ok` result into the manager's single-record diff shape; an error
 *  rides straight through to the manager's error-cap bookkeeping (its
 *  `{ kind, reason }` IS the `CanonicalPollOutcome` error variant). */
export type McpResourceReadOutcome =
  | { ok: true; result: unknown }
  | { ok: false; kind: 'config' | 'policy' | 'error'; reason: string };

export interface McpResourceSourceDeps {
  /** Enrolled `connection.mcp` connection names. A pattern naming a
   *  connection NOT in this set creates no demand — same fail-quiet
   *  posture as the connection-api source filtering by enrolled api
   *  connections (the connection lifecycle hooks recompute on enroll,
   *  so a later enrollment arms the watch without restart). */
  listMcpConnections: () => string[];
  /** The fetch plug — `resources/read` of one resource via the
   *  `connection.mcp` adapter. Read-only (resources are read-only by
   *  MCP spec, so the dispatch is ungated by construction). */
  readResource: (input: {
    connection_name: string;
    uri: string;
  }) => Promise<McpResourceReadOutcome>;
}

const readIntervalPref = (trigger: EventTrigger): number | undefined => {
  // The dedicated trigger-row field (D-179 P2), shared with the
  // connection-api source's interval semantics.
  const raw = trigger.watch_interval_ms;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
};

/** Normalize a `resources/read` result into a diffable record. The MCP
 *  spec returns `{ contents: [...] }` (an object); a non-conforming
 *  server's scalar / array is wrapped so the hash-diff has a stable
 *  shape either way. */
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };

export const createMcpResourcePollSource = (
  deps: McpResourceSourceDeps,
): WatchPollSource => ({
  source_id: MCP_RESOURCE_POLL_SOURCE_ID,

  deriveDemands(triggers, opts) {
    interface Wanted {
      connection_name: string;
      encoded: string;
      recipe_ids: Set<string>;
      prefs: number[];
    }
    const wanted = new Map<string, Wanted>();
    for (const trigger of triggers) {
      const parsed = parseMcpResourceWatchDemand(trigger.pattern);
      if (parsed === null) continue;
      const encoded = encodeMcpResourceUri(parsed.uri);
      // base64url carries no `/`, connection_name no `/` — an injective
      // coalescing key for (connection, resource).
      const demandKey = `${parsed.connection_name}/${encoded}`;
      let entry = wanted.get(demandKey);
      if (entry === undefined) {
        entry = {
          connection_name: parsed.connection_name,
          encoded,
          recipe_ids: new Set(),
          prefs: [],
        };
        wanted.set(demandKey, entry);
      }
      entry.recipe_ids.add(trigger.recipe_id);
      const pref = readIntervalPref(trigger);
      if (pref !== undefined) entry.prefs.push(pref);
    }
    if (wanted.size === 0) return [];

    const enrolled = new Set(deps.listMcpConnections());
    const out: WatchPollDemand[] = [];
    for (const entry of wanted.values()) {
      if (!enrolled.has(entry.connection_name)) continue;
      const watch_key = watchKeyOf(
        MCP_RESOURCE_WATCH_VENDOR,
        entry.encoded,
        entry.connection_name,
      );
      const interval_ms = Math.max(
        opts.floorMs,
        entry.prefs.length > 0 ? Math.min(...entry.prefs) : opts.defaultMs,
      );
      out.push({
        watch_key,
        vendor: MCP_RESOURCE_WATCH_VENDOR,
        entity: entry.encoded,
        connection_name: entry.connection_name,
        recipe_ids: [...entry.recipe_ids].sort(),
        interval_ms,
        deferred_to: null,
        event_scope: mcpResourceEventScope(entry.connection_name, entry.encoded),
      });
    }
    return out;
  },

  async poll(target): Promise<CanonicalPollOutcome> {
    // `entity` is the base64url-encoded uri deriveDemands minted; decode
    // it for the wire read. A decode miss is a substrate bug (we encoded
    // it) — surface as config, never crash the tick.
    const uri = decodeMcpResourceUri(target.entity);
    if (uri === null) {
      return {
        ok: false,
        kind: 'config',
        reason: `mcp-resource: watch key carries an undecodable resource segment '${target.entity}'`,
      };
    }
    const outcome = await deps.readResource({
      connection_name: target.connection_name,
      uri,
    });
    if (!outcome.ok) return outcome;
    // ONE resource per poll → one record keyed by its raw uri (the
    // meaningful record id downstream). `truncated: false` marks a
    // complete walk; the snapshot only ever holds this uri, so a
    // `deleted` is never synthesized — a vanished resource surfaces as
    // a read error (error-cap), not a phantom delete. Content change →
    // `updated`.
    return {
      ok: true,
      records: new Map([[uri, asRecord(outcome.result)]]),
      truncated: false,
      // A single-uri MCP resource read is a complete walk of its one-record snapshot
      // (and never synthesizes a `deleted`, per above) — so `complete: true`.
      complete: true,
      skipped_no_id: 0,
    };
  },
});

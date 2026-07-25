/** WatchSource generalization — the connection-api poll source.
 *
 *  The first (and founding) `WatchPollSource`: demand parses from
 *  enabled trigger rows whose pattern targets
 *  `data.connection.api.<vendor>.<entity>.…`, fans across the vendor's
 *  enrolled api connections (a literal sixth pattern segment narrows to
 *  ONE connection), defers keys a registered kernel reconciler already
 *  covers (design § 2 fidelity layering: webhook > reconciler-bus >
 *  poll — the webhook funnel hangs OFF the reconciler, so deferring to
 *  the reconciler subsumes webhook acceleration by construction), and
 *  fetches via the gated + audited canonical poll
 *  (`runCanonicalWatchPoll`).
 *
 *  This module is a verbatim extraction of the demand half the
 *  poll-manager hardwired in slice 2 — the manager core is now
 *  source-agnostic (loops + baseline + snapshot diff + emit + error
 *  cap), and this source owns everything connection-api-specific. A
 *  future poll source (cli command exec, mcp resource poll) implements
 *  the same two methods and mints keys in its own namespace. */

import type { EventTrigger } from '@recued/contracts';
import {
  CONNECTION_API_POLL_SOURCE_ID,
  parseWatchDemandFromPattern,
  watchKeyOf,
} from '@recued/contracts';
import type { CanonicalPollOutcome } from './canonical-poll.js';
import type { WatchPollDemand, WatchPollSource } from './poll-manager.js';

export interface ConnectionApiSourceDeps {
  /** Enrolled api connections — `(name, vendor)` pairs. The seam keeps
   *  the source decoupled from the connection-store row shape. */
  listApiConnections: () => Array<{ name: string; vendor: string | undefined }>;
  /** True when a registered kernel reconciler already covers the
   *  triple (`getHousekeepingTask(reconciliationTaskId(…))`). */
  hasReconciler: (vendor: string, entity: string, connection_name: string) => boolean;
  /** The canonical poll fetch (`runCanonicalWatchPoll` bound to its
   *  deps). */
  poll: (input: {
    vendor: string;
    entity: string;
    connection_name: string;
  }) => Promise<CanonicalPollOutcome>;
}

const readIntervalPref = (trigger: EventTrigger): number | undefined => {
  // D-179 P2 — the dedicated trigger-row field (lifted out of the
  // retired `config_patch` grab-bag).
  const raw = trigger.watch_interval_ms;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
};

export const createConnectionApiPollSource = (
  deps: ConnectionApiSourceDeps,
): WatchPollSource => ({
  source_id: CONNECTION_API_POLL_SOURCE_ID,

  deriveDemands(triggers, opts) {
    interface Wanted {
      vendor: string;
      entity: string;
      /** Literal connection narrowing (pattern's sixth segment) —
       *  null = vendor-wide (the `**` form). */
      connection_name: string | null;
      recipe_ids: Set<string>;
      prefs: number[];
    }
    const wanted = new Map<string, Wanted>();
    for (const trigger of triggers) {
      const parsed = parseWatchDemandFromPattern(trigger.pattern);
      if (parsed === null) continue;
      const connection_name = parsed.connection_name ?? null;
      const demandKey = [parsed.vendor, parsed.entity, connection_name ?? '*'].join('/');
      let entry = wanted.get(demandKey);
      if (entry === undefined) {
        entry = {
          vendor: parsed.vendor,
          entity: parsed.entity,
          connection_name,
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

    const connectionsByVendor = new Map<string, string[]>();
    for (const conn of deps.listApiConnections()) {
      if (conn.vendor === undefined) continue;
      const list = connectionsByVendor.get(conn.vendor) ?? [];
      list.push(conn.name);
      connectionsByVendor.set(conn.vendor, list);
    }

    const out = new Map<string, WatchPollDemand>();
    for (const entry of wanted.values()) {
      const vendorConnections = connectionsByVendor.get(entry.vendor) ?? [];
      // A connection-narrowed pattern demands ONLY its named connection
      // (and only while that connection is enrolled under the vendor);
      // a vendor-wide pattern fans to every enrolled connection.
      const connections =
        entry.connection_name === null
          ? vendorConnections
          : vendorConnections.filter((name) => name === entry.connection_name);
      for (const connection_name of connections) {
        const watch_key = watchKeyOf(entry.vendor, entry.entity, connection_name);
        const interval_ms = Math.max(
          opts.floorMs,
          entry.prefs.length > 0 ? Math.min(...entry.prefs) : opts.defaultMs,
        );
        const existing = out.get(watch_key);
        if (existing !== undefined) {
          // A narrowed and a vendor-wide demand can land on the same
          // key — merge subscribers, keep the tighter interval.
          for (const id of entry.recipe_ids) {
            if (!existing.recipe_ids.includes(id)) existing.recipe_ids.push(id);
          }
          existing.recipe_ids.sort();
          existing.interval_ms = Math.min(existing.interval_ms, interval_ms);
          continue;
        }
        out.set(watch_key, {
          watch_key,
          vendor: entry.vendor,
          entity: entry.entity,
          connection_name,
          recipe_ids: [...entry.recipe_ids].sort(),
          interval_ms,
          deferred_to: deps.hasReconciler(entry.vendor, entry.entity, connection_name)
            ? 'reconciler'
            : null,
        });
      }
    }
    return [...out.values()];
  },

  poll: (target) => deps.poll(target),
});

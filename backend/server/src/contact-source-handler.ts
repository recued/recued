/** D-205 #2c — `contact.source.list` rpc handler: per-Source health.
 *
 *  ONE method, one join: the D-145 `SourceRegistration` rows for the `contact`
 *  top-tier kind, each married to its `contact_source_sync_state` row.
 *
 *  🔑 **This is the first thing that has ever READ the runner's cycle counts.**
 *  D-205 #1 made the contact sync runner record its own outcome — twelve counters
 *  per cycle plus an error message carrying the runner's failure SAMPLES — and the
 *  only consumer that ever looked at a contact Source's health was
 *  `source_freshness_degradation`, whose shared reader selects exactly
 *  `(last_success_at, degraded)` and nothing else. So a leaf that failed EVERY
 *  record on EVERY cycle collapsed to a single boolean, and the diagnosis sitting
 *  in the row next to it was written and never opened.
 *
 *  Read-only, and deliberately NOT MCP-reserved — see the registry entry.
 *
 *  Spec: D-205 §4.3. */

import type {
  ContactSourceHealth,
  HandlerSlice,
  ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from './ws-server.js';
import type { WorkEntityResolver } from './work-entity-resolver.js';
import {
  deriveContactSourceFreshness,
  type ContactSourceSyncState,
  type ContactSourceSyncStateStore,
} from './storage/contact-source-sync-state.js';

export interface ContactSourceRpcDeps {
  /** The D-145 Source registry. `listSources('contact')` is the contact filter. */
  resolver: Pick<WorkEntityResolver, 'listSources'>;
  /** The health rows. */
  syncState: ContactSourceSyncStateStore;
  /** Injectable clock — the staleness verdict is time-dependent, so tests pin it. */
  now?: () => number;
}

/** Join the registry to the health rows.
 *
 *  ⚠ **The REGISTRY is the spine, not the state table.** Every registered contact
 *  Source appears, even one with no state row at all — a Source that has never run
 *  is precisely the one worth seeing, and `deriveContactSourceFreshness(null)`
 *  says so (`stale: true`, never-synced). Driving the list off the state table
 *  instead would make a Source that never got as far as its first cycle simply
 *  VANISH from its own health page, which is the "reads as fine because it is
 *  absent" failure this whole family exists to end.
 *
 *  A state row with no matching registration is dropped: the Source was
 *  unregistered and the row is a tombstone the store's own `deleteForSource` is
 *  responsible for. */
export const handleContactSourceList = async (
  deps: ContactSourceRpcDeps,
): Promise<{ sources: ReadonlyArray<ContactSourceHealth> }> => {
  const now = (deps.now ?? Date.now)();
  const registrations = deps.resolver.listSources('contact');

  const stateById = new Map<string, ContactSourceSyncState>();
  for (const state of deps.syncState.list()) {
    stateById.set(state.source_id, state);
  }

  const sources: ContactSourceHealth[] = registrations.map((registration) => {
    const state = stateById.get(registration.id) ?? null;
    const freshness = deriveContactSourceFreshness(state, now);
    return {
      source_id: registration.id,
      // Pre-composed by the boot wire as `${display_name} (${connection.name})`.
      // Do NOT re-derive it by splitting `source_id`.
      source_label: registration.source_label,
      last_success_at: freshness.last_success_at,
      degraded: freshness.degraded,
      stale: freshness.stale,
      last_error_code: state?.last_error_code ?? null,
      last_error_message: state?.last_error_message ?? null,
      last_cycle: state?.last_cycle ?? null,
    };
  });

  return { sources };
};

type ContactSourceMethods = 'contact.source.list';

export const makeContactSourceHandlers = (
  deps: ContactSourceRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, ContactSourceMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['contact.source.list'],
    handlers: {
      'contact.source.list': async () => handleContactSourceList(deps),
    },
  };
};

/** D-148 § A.3.4 + D-169 P0 Slice 2B — popup "What does the bridge
 *  store?" inspector.
 *
 *  Returns a typed projection of the bridge's local state in exactly
 *  the closed-list 10-field shape per spec. Anything outside this set
 *  is a CI-gate failure (Appendix I.15) — the popup view is a user-
 *  visible promise that the bridge is structurally incapable of
 *  hiding state.
 *
 *  The popup also surfaces:
 *    - Bridge → server connection state
 *    - Active queue depth + pending-outbox depth
 *    - Idempotency cache size
 *    - Per-ingredient grant inventory (separate Settings page; this
 *      inspector returns a compact summary)
 */

import { BRIDGE_LOCAL_STORAGE_FIELDS } from '@recued/contracts';
import type { BridgeLocalState, BridgeLocalStore } from '../storage/local-store.js';
import type { BridgeFifoQueue } from '../queue/fifo-queue.js';
import type { BridgeConfirmedInspection, BridgeIdempotencyScope, BridgeInFlightInspection, IdempotencyCache } from '../idempotency/cache.js';
import type { BridgeGrantStore } from '../permissions/grants.js';

export interface BridgeStateInspection {
  /** The 10 closed-list fields. Always exactly this set. */
  local: BridgeLocalState;
  /** Live queue snapshot. */
  queue: {
    current_command_id: string | null;
    pending_depth: number;
    paused: boolean;
  };
  /** Best-effort cache size. Null means storage could not be inspected;
   *  it must not be displayed as an empty cache. Dispatch still consults
   *  the real cache and refuses an action if that lookup fails. */
  idempotency: {
    entry_count: number | null;
    /** Null means unavailable, including a corrupt marker or incomplete pair. */
    in_flight: BridgeInFlightInspection | null;
    /** Unexpired confirmed outcomes, newest recorded first. Metadata only. */
    recent_confirmed: BridgeConfirmedInspection | null;
  };
  /** Per-ingredient grant inventory — count + most-recent grant time. */
  grants: {
    count: number;
    most_recent_at: number | null;
  };
  /** Inspection timestamp. */
  inspected_at: number;
}

export interface InspectorDeps {
  local: BridgeLocalStore;
  queue: BridgeFifoQueue;
  idempotency: IdempotencyCache;
  /** Resolve from the same local snapshot the inspector returns. A re-pair
   *  must not label the old connection's markers with the new pair identity. */
  idempotencyForPair?(scope: BridgeIdempotencyScope): IdempotencyCache;
  grants: BridgeGrantStore;
  now(): number;
}

/** Build the popup view. The returned shape is exactly what the
 *  popup renders — no extra fields, no transformation. */
export const buildBridgeStateInspection = async (
  deps: InspectorDeps,
): Promise<BridgeStateInspection> => {
  const local = await deps.local.inspect();
  const queue_state = deps.queue.state();
  let idempotency_entry_count: number | null = null;
  let in_flight: BridgeInFlightInspection | null = null;
  let recent_confirmed: BridgeConfirmedInspection | null = null;
  let cache: IdempotencyCache | null = deps.idempotency;
  try {
    if (deps.idempotencyForPair) {
      cache = local.server_url && local.server_public_key && local.webclient_token?.token_id
        ? deps.idempotencyForPair({ server_public_key: local.server_public_key, token_id: local.webclient_token.token_id }) : null;
    }
  } catch {
    cache = null;
  }
  if (cache) {
    try {
      const snapshot = await cache.inspectDiagnostics();
      if (snapshot.receipts) {
        idempotency_entry_count = snapshot.receipts.count;
        recent_confirmed = snapshot.receipts.confirmed;
      }
      in_flight = snapshot.in_flight;
    } catch {
      // A failed snapshot transaction publishes no confirmation data. A
      // marker-only retry can still help diagnose the unresolved admission.
      try { in_flight = await cache.inspectInFlight(); } catch { /* Unavailable. */ }
    }
  }
  const grants = await deps.grants.list();
  let most_recent_at: number | null = null;
  for (const g of grants) {
    if (most_recent_at === null || g.granted_at > most_recent_at) {
      most_recent_at = g.granted_at;
    }
  }
  return {
    local,
    queue: {
      current_command_id: queue_state.current_command_id,
      pending_depth: queue_state.pending.length,
      paused: queue_state.paused,
    },
    idempotency: {
      entry_count: idempotency_entry_count,
      in_flight,
      recent_confirmed,
    },
    grants: {
      count: grants.length,
      most_recent_at,
    },
    inspected_at: deps.now(),
  };
};

/** Returns the closed-list keys present in `local`. Used by the
 *  no-state-proof test to assert exactly the documented fields appear. */
export const documentedLocalKeys = (): ReadonlyArray<string> =>
  BRIDGE_LOCAL_STORAGE_FIELDS;

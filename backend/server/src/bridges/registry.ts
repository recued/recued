/** D-148 § A.3.3 + § A.3.6 — server-side bridge connection registry.
 *
 *  Tracks the per-bridge connection state the server uses to:
 *
 *    - Populate `context.bridge.online` at recipe execution start.
 *    - Decide whether to dispatch a bridge-bound ingredient or
 *      return `capacity_gap: bridge_online`.
 *    - Surface bridge presence + capabilities in Settings → Bridge.
 *    - Drive the realtime broadcast bus's `bridge.*` channel
 *      (D-121's broadcast bus, widened at D-148 P3).
 *
 *  In-memory registry; survives only as long as the server process
 *  does. Bridge tokens persist (via `client_tokens` from D-148 P2);
 *  the registry repopulates on bridge reconnect.
 *
 *  Connection identity = the bridge's `client_token_id` (issued at
 *  pair time). Multiple bridges can be paired; this module tracks
 *  *connectivity* — the D-121 mode discriminator was retired in
 *  D-148 P11 along with the legacy extension/webapp surfaces.
 */

import type { BridgeCapabilityProfile } from '@recued/contracts';

export interface BridgeConnectionRecord {
  client_token_id: string;
  client_label?: string;
  /** Active WS session id; rotates on each reconnect. */
  session_id: string;
  /** Unix-ms of the current connection's start. */
  online_since: number;
  /** Last server-observed `pong` or inbound frame; the keepalive
   *  ticker advances this. */
  last_seen_at: number;
  /** Bridge's reported capabilities (from the WS auth handshake's
   *  `bridge.hello` envelope). */
  capabilities: BridgeCapabilityProfile;
}

export interface BridgeRegistry {
  /** Record a fresh connection. Replaces any prior entry for the
   *  same `client_token_id` (reconnect semantics — fresh session id
   *  is canonical). */
  attach(record: BridgeConnectionRecord): void;
  /** Drop a connection. Idempotent on absent entry. */
  detach(client_token_id: string): void;
  /** Mark a heartbeat tick. */
  touch(client_token_id: string, at: number): void;
  /** D-169 P0 — record a capability profile for an already-attached
   *  bridge without touching the connection's session_id /
   *  online_since. Mutates `capabilities` + `last_seen_at` in place on
   *  the existing record. When no record exists for this
   *  `client_token_id`, the call is a no-op (returns `false`); the
   *  capability push piggybacks on the WS-upgrade's `attach` call —
   *  auto-creating a record from a capability push alone would
   *  introduce an orphan `online_since` that the dispatcher's
   *  iteration + `buildContextBridge` both treat as live, even though
   *  no WS is attached (Codex 2026-05-28 Angle 1 fold). Returns
   *  `true` iff a record was found + updated. */
  updateCapabilities(
    client_token_id: string,
    capabilities: BridgeCapabilityProfile,
    at: number,
  ): boolean;
  /** Snapshot the current registry — used by Settings + the
   *  context.bridge injector. */
  list(): BridgeConnectionRecord[];
  /** Look up by token id. */
  get(client_token_id: string): BridgeConnectionRecord | null;
  /** Subset by client label (for "default bridge" dispatch). */
  byLabel(label: string): BridgeConnectionRecord | null;
  /** Wipe all connections (server shutdown / test reset). */
  clear(): void;
}

export const createBridgeRegistry = (): BridgeRegistry => {
  const records = new Map<string, BridgeConnectionRecord>();
  return {
    attach(record) {
      records.set(record.client_token_id, record);
    },
    detach(client_token_id) {
      records.delete(client_token_id);
    },
    touch(client_token_id, at) {
      const entry = records.get(client_token_id);
      if (entry) entry.last_seen_at = at;
    },
    updateCapabilities(client_token_id, capabilities, at) {
      const existing = records.get(client_token_id);
      if (!existing) return false;
      existing.capabilities = capabilities;
      existing.last_seen_at = at;
      return true;
    },
    list() {
      return [...records.values()];
    },
    get(client_token_id) {
      return records.get(client_token_id) ?? null;
    },
    byLabel(label) {
      for (const r of records.values()) {
        if (r.client_label === label) return r;
      }
      return null;
    },
    clear() {
      records.clear();
    },
  };
};

/** Build the `context.bridge` object from a registry snapshot. The
 *  engine merges this into the `RunContext.context` namespace at
 *  recipe execution start. */
export const buildContextBridge = (
  registry: BridgeRegistry,
  options: { preferred_label?: string } = {},
): {
  online: boolean;
  online_since?: number;
  client_label?: string;
  capabilities?: BridgeCapabilityProfile;
} => {
  // When a label is requested, route strictly — fail to "offline"
  // rather than silently dispatching to a different bridge. Labels
  // are an affinity contract; falling back would surprise the
  // recipe author who expected `work-laptop` to fire on the
  // work-laptop bridge.
  let chosen: BridgeConnectionRecord | null = null;
  if (options.preferred_label) {
    chosen = registry.byLabel(options.preferred_label);
    if (!chosen) {
      return { online: false };
    }
  } else {
    const all = registry.list();
    if (all.length === 0) {
      return { online: false };
    }
    chosen = all.reduce<BridgeConnectionRecord>(
      (best, cur) => (cur.online_since > best.online_since ? cur : best),
      all[0],
    );
  }
  return {
    online: true,
    online_since: chosen.online_since,
    client_label: chosen.client_label,
    capabilities: chosen.capabilities,
  };
};

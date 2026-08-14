/** D-145 PB1.7 — server-side composer for the capacity_spec substrate.
 *
 *  Wires every probe + the cache + the invalidation source + the
 *  audit emitter + the (no-op until PB7) transparency emitter into a
 *  single dependency bundle. Returns a `shutdown()` thunk that the
 *  bin lifecycle drains so subscriptions don't leak across reboots.
 *
 *  PB1.7 ships *only* the composer. Bin wiring + per-store publish
 *  hook installation lands at PB3 alongside the orchestrator, where
 *  the `executeRecuedRequest` entry point first invokes the walker.
 *  Until then, composing the substrate ahead of any production
 *  consumer keeps the seam typed + tested.
 *
 *  Spec: § B.4. Design: § PB1.7 + § N.12. */

import * as capacity from '@recued/middleware/capacity/index.js';

import type { CapacityInvalidationSource } from '@recued/contracts';

export interface CapacitySpecServerDeps extends capacity.CapacityProbeDeps {
  invalidationSource?: CapacityInvalidationSource;
  auditAdapter?: capacity.AuditLogAdapter;
  transparencyEmitter?: capacity.CapacityTransparencyEmitter;
  counters?: capacity.CapacityCounters;
  now?: () => number;
}

export interface ComposedCapacitySpec {
  registry: capacity.CapacityProbeRegistry;
  cache: capacity.CapacityCache;
  invalidationSource: CapacityInvalidationSource;
  audit: capacity.CapacityAuditEmitter;
  transparency: capacity.CapacityTransparencyEmitter;
  counters: capacity.CapacityCounters;
  /** Drain — unsubscribes invalidation subscribers + flushes
   *  counters. Called by bin.ts on shutdown / drain. */
  shutdown: () => void;
}

/** Default no-op audit adapter — when the composer is invoked
 *  without a real audit store (e.g. db-less harnesses) walks still
 *  succeed; emits become no-ops. */
const NOOP_AUDIT_ADAPTER: capacity.AuditLogAdapter = {
  logActivity() {
    // noop
  },
};

export const composeCapacitySpecDeps = (
  deps: CapacitySpecServerDeps,
): ComposedCapacitySpec => {
  const counters = deps.counters ?? capacity.createEmptyCounters();
  const invalidationSource =
    deps.invalidationSource ?? capacity.createCapacityInvalidationSource();

  const cache = capacity.createCapacityCache({
    invalidationSource,
    onInvalidate: (topic, count) => {
      counters.invalidations[topic] = (counters.invalidations[topic] ?? 0) + count;
    },
  });

  const registry = capacity.createCapacityProbeRegistry({
    bridgeStateProbe: deps.bridgeStateProbe,
    ingredientRegistryProbe: deps.ingredientRegistryProbe,
    permissionRegistryProbe: deps.permissionRegistryProbe,
    connectionHealthProbe: deps.connectionHealthProbe,
    sourceEnablementProbe: deps.sourceEnablementProbe,
    quotaHeadroomProbe: deps.quotaHeadroomProbe,
    warehouseRefResolver: deps.warehouseRefResolver,
    ...(deps.probeTimeoutMs !== undefined ? { probeTimeoutMs: deps.probeTimeoutMs } : {}),
  });

  const audit = capacity.createCapacityAuditEmitter(
    deps.auditAdapter ?? NOOP_AUDIT_ADAPTER,
  );
  const transparency = deps.transparencyEmitter ?? capacity.createNoopTransparencyEmitter();

  return {
    registry,
    cache,
    invalidationSource,
    audit,
    transparency,
    counters,
    shutdown: () => {
      // The cache subscribes through the invalidation source; the
      // factory's dispose() unsubscribes every topic handler.
      (cache as unknown as { dispose: () => void }).dispose();
    },
  };
};

/* ⛔ `publishSourceEnabledChange` was RETIRED here (D-187 Sources half), along
 *  with the `source.enabled_changed` topic it was the sole publisher for. It
 *  wrapped `setSourceEnabled`, which is deleted — and it never had a production
 *  caller even before that: the only references were in
 *  `d-145-phase-pb1-integration.test.ts`, which invoked it directly and was
 *  therefore green while certifying nothing about production. */


// ── PB3 publish hooks (deferred from PB1 bin wiring) ─────────────────
//
// Per the PB2 handover and § B.4 substrate notes: PB3 lands the
// per-store publish-hook installation that PB1.7's composer left as
// a seam. Each helper wraps the existing mutation paths so the cache
// invalidates immediately on change, eliminating the 30s–1h TTL
// waiting period for affected primitives.
//
// Surface contract: callers wire these into their existing mutation
// handlers. Each helper is pure dispatch — no DB reads, no async
// work, no error swallowing. Subscribers handle their own re-probe.

/** D-125 connection enroll/disable/reprobe → `connection.*` topics.
 *
 *  The connection store calls this on every state-changing rpc:
 *  `connection.enroll` / `connection.disable` / `connection.reprobe`.
 *  The cache invalidates `connection_active` rows keyed on the same
 *  `(vendor, entity)` tuple. When `connection_id` is set, the cache
 *  drops only the keyed row; when omitted, the cache drops every
 *  matching `(vendor, entity)` row (e.g. for a vendor-wide reprobe). */
export const publishConnectionStateChange = (
  invalidationSource: CapacityInvalidationSource,
  change: 'enrolled' | 'disabled' | 'reprobed',
  args: {
    vendor: string;
    entity?: string;
    connection_id?: string;
  },
): void => {
  const topic =
    change === 'enrolled'
      ? 'connection.enrolled'
      : change === 'disabled'
        ? 'connection.disabled'
        : 'connection.reprobed';
  invalidationSource.publish({
    topic,
    vendor: args.vendor,
    ...(args.entity !== undefined ? { entity: args.entity } : {}),
    ...(args.connection_id !== undefined ? { connection_id: args.connection_id } : {}),
  });
};

/** Ingredient install / uninstall / version-bump → `ingredient.*`
 *  topics. The marketplace install path calls this on every
 *  registry mutation. The cache invalidates `ingredient_installed`
 *  rows keyed on the same slug; `selector_freshness` rows also
 *  invalidate on `ingredient.bumped` (slug match). */
export const publishIngredientStateChange = (
  invalidationSource: CapacityInvalidationSource,
  change: 'installed' | 'uninstalled' | 'bumped',
  args: {
    slug: string;
  },
): void => {
  const topic =
    change === 'installed'
      ? 'ingredient.installed'
      : change === 'uninstalled'
        ? 'ingredient.uninstalled'
        : 'ingredient.bumped';
  invalidationSource.publish({
    topic,
    slug: args.slug,
  });
};

/** Permission grant / revoke → `permission.grant_changed` topic. The
 *  Chrome `chrome.permissions.onAdded` / `onRemoved` listeners call
 *  this. The cache invalidates `permission_grant` rows keyed on the
 *  same permission name. */
export const publishPermissionGrantChange = (
  invalidationSource: CapacityInvalidationSource,
  args: {
    permission: string;
  },
): void => {
  invalidationSource.publish({
    topic: 'permission.grant_changed',
    permission: args.permission,
  });
};

/** D-132 quota headroom change → `quota.headroom_changed` topic. The
 *  D-132 quota store calls this on every quota update (free or BYOK
 *  pool). The cache invalidates `pool_quota_available` rows keyed
 *  on the same pool. When `pool` is undefined, the cache drops every
 *  pool_quota_available row (defensive; covers global config flips
 *  like Pause-AI). */
export const publishQuotaHeadroomChange = (
  invalidationSource: CapacityInvalidationSource,
  args: {
    pool?: 'free' | 'byok';
  } = {},
): void => {
  invalidationSource.publish({
    topic: 'quota.headroom_changed',
    ...(args.pool !== undefined ? { pool: args.pool } : {}),
  });
};

/** Bridge online state change → `bridge.online_state_changed` topic.
 *  D-148 § A.1.4 BridgeStateProbe pushes state-change notifications
 *  through the existing PB1 probe interface; the helper here lets
 *  the bridge-state listener publish the cache invalidation. */
export const publishBridgeOnlineStateChange = (
  invalidationSource: CapacityInvalidationSource,
  args: {
    bridge_instance_id?: string;
  } = {},
): void => {
  invalidationSource.publish({
    topic: 'bridge.online_state_changed',
    ...(args.bridge_instance_id !== undefined
      ? { bridge_instance_id: args.bridge_instance_id }
      : {}),
  });
};

/** Bridge login state change → `bridge.login_state_changed` topic.
 *  Bridge reports `capacity_gap_logged_in` on a per-origin basis;
 *  the helper here lets the bridge-state listener publish to drop
 *  the matching `logged_in` cache row. */
export const publishBridgeLoginStateChange = (
  invalidationSource: CapacityInvalidationSource,
  args: {
    site: string;
    bridge_instance_id?: string;
  },
): void => {
  invalidationSource.publish({
    topic: 'bridge.login_state_changed',
    site: args.site,
    ...(args.bridge_instance_id !== undefined
      ? { bridge_instance_id: args.bridge_instance_id }
      : {}),
  });
};

/** Bridge user-refresh-login → `bridge.user_refresh_login` topic.
 *  When the user explicitly refreshes their login (e.g. clicks the
 *  re-auth CTA), this helper drops the `logged_in` cache row even
 *  though no probe-state change has fired yet. */
export const publishBridgeUserRefreshLogin = (
  invalidationSource: CapacityInvalidationSource,
  args: {
    site: string;
    bridge_instance_id?: string;
  },
): void => {
  invalidationSource.publish({
    topic: 'bridge.user_refresh_login',
    site: args.site,
    ...(args.bridge_instance_id !== undefined
      ? { bridge_instance_id: args.bridge_instance_id }
      : {}),
  });
};

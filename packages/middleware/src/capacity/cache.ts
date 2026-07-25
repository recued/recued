/** D-145 PB1.3 — per-capacity cache.
 *
 *  In-process Map keyed by `capacityKey(req) + bridge_instance_id?`.
 *  `cacheable: false` rows skip the Map entirely (the walker
 *  consults `CAPACITY_CACHE_POLICIES[kind].cacheable` before reading
 *  / writing). The cache subscribes to `CapacityInvalidationSource`
 *  topics; per-topic dispatch logic drops matching rows.
 *
 *  Spec: § B.4. Design: § PB1.3 + § N.9. */

import {
  CAPACITY_CACHE_POLICIES,
  type CapacityInvalidationPayload,
  type CapacityInvalidationSource,
  type CapacityInvalidationSubscription,
  type CapacityInvalidationTopic,
} from '@recued/contracts';

import type { CapacityCache, CapacityCacheRow, CapacityWalkContext } from './types.js';

/** Compose the in-process Map key from the capacity_key + the
 *  bridge_instance_id (when applicable). The bridge field is opt-in
 *  per § N.9 — only `bridge_online` + `logged_in` policies declare
 *  `bridge_instance_id` as a cache-key component. Other kinds drop
 *  the field even when `ctx.bridge_instance_id` is set so a single
 *  ingredient/connection cache row is shared across bridges. */
const composeMapKey = (key: string, bridge_instance_id?: string): string =>
  bridge_instance_id !== undefined ? `${key}@@${bridge_instance_id}` : key;

const usesBridgeInstanceId = (key: string): boolean => {
  // Map prefixes back to `bridge_instance_id` need: only the two
  // kinds whose cache_key_parts include `bridge_instance_id`.
  return key.startsWith('bridge_online') || key.startsWith('logged_in:');
};

/** Codex P2 fold — broader-row matching. A row whose discriminator
 *  is undefined (an aggregate / vendor-wide / entity-wide cached
 *  result) MUST drop on a payload that narrows to a specific
 *  discriminator value. The aggregate row is a *summary* over all
 *  underlying narrower units; if any one narrows, the summary is
 *  potentially stale and must be re-probed. The asymmetry is
 *  important: a payload's undefined discriminator is broad (drops
 *  everything in scope); a row's undefined discriminator is broad
 *  (it represents an aggregate that the narrow event invalidates). */
const matchesNarrowing = (
  rowField: string | undefined,
  payloadField: string | undefined,
): boolean =>
  rowField === undefined ||
  payloadField === undefined ||
  rowField === payloadField;

/** Topic → predicate: each topic matches a closed set of cache
 *  rows. The cache.invalidateByTopic dispatcher routes the payload
 *  to the right matcher. Anything not enumerated here is a no-op. */
const buildTopicPredicate = (
  payload: CapacityInvalidationPayload,
): ((row: CapacityCacheRow) => boolean) => {
  switch (payload.topic) {
    case 'bridge.online_state_changed':
      return (row) =>
        row.capacity_kind === 'bridge_online' &&
        matchesNarrowing(row.bridge_instance_id, payload.bridge_instance_id);
    case 'bridge.login_state_changed':
    case 'bridge.user_refresh_login':
      return (row) =>
        row.capacity_kind === 'logged_in' &&
        matchesNarrowing(row.bridge_instance_id, payload.bridge_instance_id) &&
        matchesNarrowing(row.site, payload.site);
    case 'ingredient.installed':
    case 'ingredient.uninstalled':
      return (row) =>
        row.capacity_kind === 'ingredient_installed' &&
        matchesNarrowing(row.slug, payload.slug);
    case 'ingredient.bumped':
      return (row) =>
        row.capacity_kind === 'selector_freshness' &&
        matchesNarrowing(row.slug, payload.slug);
    case 'permission.grant_changed':
      return (row) =>
        row.capacity_kind === 'permission_grant' &&
        matchesNarrowing(row.permission, payload.permission);
    case 'connection.enrolled':
    case 'connection.disabled':
    case 'connection.reprobed':
      // Codex P2 fold — when a connection-specific event arrives,
      // also drop aggregate rows (row.connection_id === undefined
      // for the same vendor/entity) because the aggregate's "any
      // healthy connection" answer is potentially stale.
      return (row) => {
        if (row.capacity_kind !== 'connection_active') return false;
        if (!matchesNarrowing(row.vendor, payload.vendor)) return false;
        if (!matchesNarrowing(row.entity, payload.entity)) return false;
        if (!matchesNarrowing(row.connection_id, payload.connection_id)) return false;
        return true;
      };
    case 'source.enabled_changed':
      // PA11 join — when a Source is toggled, drop every
      // connection_active row that the toggle could affect:
      //   - exact-match (row.vendor=X, row.entity=Y, row.connection_id=Z
      //     matches a payload with same X/Y/Z)
      //   - vendor-wide aggregate (row.entity === undefined) when the
      //     payload narrows to one entity within the vendor
      //   - entity-wide aggregate (row.connection_id === undefined)
      //     when the payload narrows to one connection_id
      //   - vendor aggregate (row.vendor === undefined) — defensive
      //     coverage for future requirements that span vendors
      // The publisher unpacks the Source id (`<vendor>.<connection_id>.<kind>`)
      // before publish so the cache layer doesn't re-parse.
      return (row) => {
        if (row.capacity_kind !== 'connection_active') return false;
        if (!matchesNarrowing(row.vendor, payload.vendor)) return false;
        if (!matchesNarrowing(row.entity, payload.entity)) return false;
        if (!matchesNarrowing(row.connection_id, payload.connection_id)) return false;
        return true;
      };
    case 'quota.headroom_changed':
      return (row) =>
        row.capacity_kind === 'pool_quota_available' &&
        matchesNarrowing(row.pool, payload.pool);
  }
};

export interface CreateCapacityCacheOptions {
  invalidationSource?: CapacityInvalidationSource;
  /** Optional invalidation-counter callback — counters live outside
   *  the cache; the composer threads them in. */
  onInvalidate?: (topic: CapacityInvalidationTopic, count: number) => void;
}

export const createCapacityCache = (
  options: CreateCapacityCacheOptions = {},
): CapacityCache & { dispose: () => void } => {
  const map = new Map<string, CapacityCacheRow>();
  const subscriptions: CapacityInvalidationSubscription[] = [];

  const cache: CapacityCache & { dispose: () => void } = {
    read(key, ctx) {
      const policy = CAPACITY_CACHE_POLICIES[firstKindFromKey(key) ?? 'bridge_online'];
      if (!policy.cacheable) return null;
      const bridge = usesBridgeInstanceId(key) ? ctx.bridge_instance_id : undefined;
      const mapKey = composeMapKey(key, bridge);
      return map.get(mapKey) ?? null;
    },
    write(key, ctx, row) {
      const policy = CAPACITY_CACHE_POLICIES[row.capacity_kind];
      if (!policy.cacheable) return;
      const bridge = usesBridgeInstanceId(key) ? ctx.bridge_instance_id : undefined;
      const mapKey = composeMapKey(key, bridge);
      map.set(mapKey, row);
    },
    invalidate(predicate) {
      let dropped = 0;
      for (const [k, row] of map.entries()) {
        if (predicate(row)) {
          map.delete(k);
          dropped += 1;
        }
      }
      return dropped;
    },
    invalidateByTopic(payload) {
      const predicate = buildTopicPredicate(payload);
      let dropped = 0;
      for (const [k, row] of map.entries()) {
        if (predicate(row)) {
          map.delete(k);
          dropped += 1;
        }
      }
      if (options.onInvalidate) options.onInvalidate(payload.topic, dropped);
      return dropped;
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
    dispose() {
      for (const sub of subscriptions) sub.unsubscribe();
      subscriptions.length = 0;
    },
  };

  // Subscribe to every distinct invalidation topic from the cache
  // policy registry. Each subscription routes the payload through
  // `invalidateByTopic` for unified per-kind dispatch.
  if (options.invalidationSource) {
    const topics = new Set<CapacityInvalidationTopic>();
    for (const k of Object.keys(CAPACITY_CACHE_POLICIES) as Array<
      keyof typeof CAPACITY_CACHE_POLICIES
    >) {
      for (const t of CAPACITY_CACHE_POLICIES[k].invalidation_topics) topics.add(t);
    }
    for (const topic of topics) {
      const sub = options.invalidationSource.subscribe(topic, (payload) => {
        cache.invalidateByTopic(payload);
      });
      subscriptions.push(sub);
    }
  }

  return cache;
};

/** Recover the capacity_kind from the leading segment of a
 *  capacity_key. Used by the cache.read path to look up the policy
 *  without requiring the caller to pass the kind explicitly. */
const firstKindFromKey = (
  key: string,
): keyof typeof CAPACITY_CACHE_POLICIES | undefined => {
  const idx = key.indexOf(':');
  const prefix = idx === -1 ? key : key.slice(0, idx);
  if (prefix in CAPACITY_CACHE_POLICIES) {
    return prefix as keyof typeof CAPACITY_CACHE_POLICIES;
  }
  return undefined;
};

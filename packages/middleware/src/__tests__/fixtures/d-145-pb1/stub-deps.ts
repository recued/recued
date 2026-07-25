/** D-145 PB1 — stub probe deps for tests.
 *
 *  In-memory implementations of every probe adapter that the
 *  composer wires up. Tests can mutate state through the returned
 *  `controls` object to exercise success / gap / probe-failure
 *  paths without touching real stores. */

import type { PoolKind } from '@recued/contracts';
import type * as capacity from '../../../capacity/index.js';

type BridgeStateProbe = capacity.BridgeStateProbe;
type ConnectionHealthProbe = capacity.ConnectionHealthProbe;
type IngredientRegistryProbe = capacity.IngredientRegistryProbe;
type PermissionRegistryProbe = capacity.PermissionRegistryProbe;
type QuotaHeadroomProbe = capacity.QuotaHeadroomProbe;
type SourceEnablementProbe = capacity.SourceEnablementProbe;
type WarehouseRefResolver = capacity.WarehouseRefResolver;

export interface StubProbeControls {
  bridgeOnline: boolean;
  loggedInSites: Set<string>;
  installedIngredients: Set<string>;
  permissions: Set<string>;
  // Multi-key — `(vendor, entity?, connection_id?)` → boolean.
  connectionHealth: Map<string, boolean>;
  enabledSources: Map<string, boolean>;
  poolHeadroom: Map<PoolKind, boolean>;
  warehouseRefs: Set<string>;
  // Probes can be configured to throw to exercise PB1.4's
  // try/catch + probe-error path.
  throwOnKind: Set<string>;
  // Probes can be configured to hang to exercise the per-probe
  // timeout path. The test passes a low `probeTimeoutMs` so the
  // hang resolves quickly.
  hangOnKind: Set<string>;
  // ms epoch / ttl for selector_freshness.
  bumpedAt: Map<string, number>;
  selectorTtlMs: Map<string, number>;
}

export const createStubControls = (): StubProbeControls => ({
  bridgeOnline: true,
  loggedInSites: new Set<string>(),
  installedIngredients: new Set<string>(),
  permissions: new Set<string>(),
  connectionHealth: new Map(),
  enabledSources: new Map(),
  poolHeadroom: new Map<PoolKind, boolean>([
    ['free', true],
    ['byok', true],
  ]),
  warehouseRefs: new Set<string>(),
  throwOnKind: new Set<string>(),
  hangOnKind: new Set<string>(),
  bumpedAt: new Map<string, number>(),
  selectorTtlMs: new Map<string, number>(),
});

export const connKey = (
  vendor: string,
  entity?: string,
  connection_id?: string,
): string => `${vendor}|${entity ?? '*'}|${connection_id ?? '*'}`;

const maybeThrowOrHang = (
  controls: StubProbeControls,
  kind: string,
): void | never | Promise<never> => {
  if (controls.throwOnKind.has(kind)) {
    throw new Error(`stub probe configured to throw for ${kind}`);
  }
  if (controls.hangOnKind.has(kind)) {
    return new Promise<never>(() => {
      // never resolves
    });
  }
};

export const stubBridgeStateProbe = (
  controls: StubProbeControls,
): BridgeStateProbe => ({
  getOnline() {
    const r = maybeThrowOrHang(controls, 'bridge_online');
    if (r) return r as never;
    return controls.bridgeOnline;
  },
  getLoggedIn(site: string) {
    const r = maybeThrowOrHang(controls, 'logged_in');
    if (r) return r as never;
    return controls.loggedInSites.has(site);
  },
});

export const stubIngredientRegistryProbe = (
  controls: StubProbeControls,
): IngredientRegistryProbe => ({
  isInstalled(slug: string) {
    const r = maybeThrowOrHang(controls, 'ingredient_installed');
    if (r) return r as never;
    return controls.installedIngredients.has(slug);
  },
  getBumpedAt(slug: string) {
    const r = maybeThrowOrHang(controls, 'selector_freshness');
    if (r) return r as never;
    return controls.bumpedAt.get(slug) ?? null;
  },
  getSelectorTtlMs(slug: string) {
    return controls.selectorTtlMs.get(slug) ?? null;
  },
});

export const stubPermissionRegistryProbe = (
  controls: StubProbeControls,
): PermissionRegistryProbe => ({
  hasPermission(p: string) {
    const r = maybeThrowOrHang(controls, 'permission_grant');
    if (r) return r as never;
    return controls.permissions.has(p);
  },
});

export const stubConnectionHealthProbe = (
  controls: StubProbeControls,
): ConnectionHealthProbe => ({
  isHealthy(vendor, entity, connection_id) {
    const r = maybeThrowOrHang(controls, 'connection_active');
    if (r) return r as never;
    return controls.connectionHealth.get(connKey(vendor, entity, connection_id)) ?? false;
  },
});

export const stubSourceEnablementProbe = (
  controls: StubProbeControls,
): SourceEnablementProbe => ({
  hasEnabledSource(vendor, entity, connection_id) {
    return controls.enabledSources.get(connKey(vendor, entity, connection_id)) ?? false;
  },
});

export const stubQuotaHeadroomProbe = (
  controls: StubProbeControls,
): QuotaHeadroomProbe => ({
  hasHeadroom(pool) {
    const r = maybeThrowOrHang(controls, 'pool_quota_available');
    if (r) return r as never;
    return controls.poolHeadroom.get(pool) ?? false;
  },
});

export const stubWarehouseRefResolver = (
  controls: StubProbeControls,
): WarehouseRefResolver => ({
  resolve(ref: string) {
    const r = maybeThrowOrHang(controls, 'annotation');
    if (r) return r as never;
    return controls.warehouseRefs.has(ref);
  },
});

export const buildStubProbeDeps = (
  controls: StubProbeControls,
): capacity.CapacityProbeDeps => ({
  bridgeStateProbe: stubBridgeStateProbe(controls),
  ingredientRegistryProbe: stubIngredientRegistryProbe(controls),
  permissionRegistryProbe: stubPermissionRegistryProbe(controls),
  connectionHealthProbe: stubConnectionHealthProbe(controls),
  sourceEnablementProbe: stubSourceEnablementProbe(controls),
  quotaHeadroomProbe: stubQuotaHeadroomProbe(controls),
  warehouseRefResolver: stubWarehouseRefResolver(controls),
});

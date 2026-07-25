/** D-145 PB1.4 — per-capacity probe registry + dispatcher.
 *
 *  Each probe imports its dep type from PB1.7's composer dep set;
 *  this registry's switch dispatches per-kind. The dispatcher wraps
 *  every probe call in a try/catch + per-probe timeout so thrown
 *  errors / timeouts surface to the walker as
 *  `CapacityProbeFailure { failure: 'probe_error', detail }`.
 *
 *  Spec: § B.4. Design: § PB1.4 + § N.5. */

import type {
  CapacityKind,
  CapacityProbeResult,
  CapacityRequirement,
} from '@recued/contracts';

import type {
  CapacityProbe,
  CapacityProbeRegistry,
  CapacityWalkContext,
} from '../types.js';

import {
  createBridgeOnlineProbe,
  type BridgeStateProbe,
} from './bridge-online.js';
import {
  createIngredientInstalledProbe,
  type IngredientRegistryProbe,
} from './ingredient-installed.js';
import { createLoggedInProbe } from './logged-in.js';
import {
  createAnnotationProbe,
  type WarehouseRefResolver,
} from './annotation.js';
import { createAnnotationNotRequiredProbe } from './annotation-not-required.js';
import {
  createPermissionGrantProbe,
  type PermissionRegistryProbe,
} from './permission-grant.js';
import {
  composeConnectionActivenessProbe,
  createConnectionActiveProbe,
  type ConnectionActivenessProbe,
  type ConnectionHealthProbe,
  type SourceEnablementProbe,
} from './connection-active.js';
import {
  createPoolQuotaAvailableProbe,
  type QuotaHeadroomProbe,
} from './pool-quota-available.js';
import { createSelectorFreshnessProbe } from './selector-freshness.js';

export interface CapacityProbeDeps {
  bridgeStateProbe: BridgeStateProbe;
  ingredientRegistryProbe: IngredientRegistryProbe;
  permissionRegistryProbe: PermissionRegistryProbe;
  connectionHealthProbe: ConnectionHealthProbe;
  sourceEnablementProbe: SourceEnablementProbe;
  /** Codex P1 fold (PB1): composers wiring real stores can pass a
   *  pre-composed activeness probe that performs the SQL-level join
   *  over the connection store + PA11 source registry. When omitted
   *  the dispatcher composes one from `connectionHealthProbe` +
   *  `sourceEnablementProbe` via `composeConnectionActivenessProbe`,
   *  which is precise when those adapters expose enumeration
   *  variants (`listHealthyConnectionIds` / `listEnabledConnectionIds`)
   *  and falls back to the legacy independent-predicate semantics
   *  otherwise (correct only for scoped requirements). */
  connectionActivenessProbe?: ConnectionActivenessProbe;
  quotaHeadroomProbe: QuotaHeadroomProbe;
  warehouseRefResolver: WarehouseRefResolver;
  /** Per-probe timeout in ms. Default 2000 per § N.18. The
   *  dispatcher wraps every `probe()` in `Promise.race` against this
   *  timeout; on expiration the result is mapped to
   *  `{ failure: 'probe_error', detail: 'probe_timeout' }`. */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/** Wrap a probe execution with a per-probe timeout. Resolves either
 *  with the probe's actual result or a synthesized
 *  `CapacityProbeFailure` when the timeout elapses first. The
 *  underlying probe promise is intentionally NOT cancelled on
 *  timeout — JS has no cancel primitive; the caller treats the
 *  result as failure and any latent fulfillment is harmless. */
const withTimeout = (
  promise: Promise<CapacityProbeResult>,
  timeoutMs: number,
): Promise<CapacityProbeResult> =>
  new Promise<CapacityProbeResult>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, failure: 'probe_error', detail: 'probe_timeout' });
    }, timeoutMs);
    promise.then(
      (r) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(r);
      },
      () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ ok: false, failure: 'probe_error', detail: 'probe_threw' });
      },
    );
  });

export const createCapacityProbeRegistry = (
  deps: CapacityProbeDeps,
): CapacityProbeRegistry => {
  const activenessProbe =
    deps.connectionActivenessProbe ??
    composeConnectionActivenessProbe(
      deps.connectionHealthProbe,
      deps.sourceEnablementProbe,
    );

  const probes: Record<CapacityKind, CapacityProbe> = {
    bridge_online: createBridgeOnlineProbe(deps.bridgeStateProbe),
    ingredient_installed: createIngredientInstalledProbe(deps.ingredientRegistryProbe),
    logged_in: createLoggedInProbe(deps.bridgeStateProbe),
    annotation: createAnnotationProbe(deps.warehouseRefResolver),
    annotation_not_required: createAnnotationNotRequiredProbe(),
    permission_grant: createPermissionGrantProbe(deps.permissionRegistryProbe),
    connection_active: createConnectionActiveProbe(activenessProbe),
    pool_quota_available: createPoolQuotaAvailableProbe(deps.quotaHeadroomProbe),
    selector_freshness: createSelectorFreshnessProbe(deps.ingredientRegistryProbe),
  };

  const overrides = new Map<CapacityKind, CapacityProbe>();
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return {
    async probe(req: CapacityRequirement, ctx: CapacityWalkContext) {
      const probe = overrides.get(req.kind) ?? probes[req.kind];
      try {
        return await withTimeout(probe.probe(req, ctx), timeoutMs);
      } catch {
        // Defensive — withTimeout already catches the inner probe's
        // throw. Reaching here means the wrapper itself threw, which
        // shouldn't happen but we still want a typed failure.
        return { ok: false, failure: 'probe_error', detail: 'probe_threw' };
      }
    },
    override(p: CapacityProbe) {
      overrides.set(p.kind, p);
    },
    resetOverrides() {
      overrides.clear();
    },
  };
};

export type {
  BridgeStateProbe,
  IngredientRegistryProbe,
  PermissionRegistryProbe,
  ConnectionHealthProbe,
  SourceEnablementProbe,
  ConnectionActivenessProbe,
  QuotaHeadroomProbe,
  WarehouseRefResolver,
};

export { composeConnectionActivenessProbe };

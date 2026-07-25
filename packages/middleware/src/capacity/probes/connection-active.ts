/** D-145 PB1.4 — connection_active probe.
 *
 *  Codex P1 fold: the previous implementation called
 *  `ConnectionHealthProbe.isHealthy(vendor, entity)` and
 *  `SourceEnablementProbe.hasEnabledSource(vendor, entity)`
 *  independently — two separate connections could each satisfy one
 *  predicate and the probe would falsely report `ok` even though no
 *  single connection was both healthy AND enabled. Replaced with a
 *  single coordinated probe that performs the join: returns the
 *  active connection_id when one exists, null otherwise.
 *
 *  Reason: spec § B.4 + § PA11 — "passes iff at least one D-125
 *  connection enrolled for vendor[/entity] is healthy AND at least
 *  one PA11 Source for that vendor[/entity] is enabled" must mean
 *  the SAME connection (otherwise the primitive that follows the
 *  capacity walk has no usable connection to dispatch through). */

import type { CapacityProbe } from '../types.js';

export interface ConnectionActivenessProbe {
  /** Find a single connection_id under (vendor, entity?) that is
   *  BOTH healthy AND backed by a PA11-enabled Source. Returns the
   *  connection_id when one exists, `null` otherwise.
   *
   *  When `connection_id` is supplied in the requirement, the probe
   *  filters to that specific id — returning the same id when both
   *  predicates hold for it, `null` otherwise.
   *
   *  Implementation guidance for the composer: SQL join over the
   *  connection store + PA11 source registry on `connection_id +
   *  entity_kind`, filtered by the requirement's vendor / entity /
   *  connection_id. */
  findActiveConnection(
    vendor: string,
    entity?: string,
    connection_id?: string,
  ): Promise<string | null> | string | null;
}

/** Maintained for backwards-compat with existing composer wiring +
 *  drift-resistant probe inspection. The probe registry constructs
 *  `ConnectionActivenessProbe` from these two adapters via the
 *  composer's `composeConnectionActivenessProbe` helper; tests can
 *  also pass the composed probe directly. */
export interface ConnectionHealthProbe {
  isHealthy(
    vendor: string,
    entity?: string,
    connection_id?: string,
  ): Promise<boolean> | boolean;
  /** Optional: enumerate healthy connection_ids for (vendor, entity?).
   *  When omitted, the composer falls back to the legacy
   *  `(isHealthy, hasEnabledSource)` pair which is correct only for
   *  scoped (connection_id-set) requirements. */
  listHealthyConnectionIds?(
    vendor: string,
    entity?: string,
  ): Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
}

export interface SourceEnablementProbe {
  /** Returns true iff at least one PA11 Source for this
   *  (vendor, entity?) tuple — and matching connection_id when
   *  supplied — is `enabled === true`. */
  hasEnabledSource(
    vendor: string,
    entity?: string,
    connection_id?: string,
  ): Promise<boolean> | boolean;
  /** Optional: enumerate connection_ids whose PA11 Source for
   *  (vendor, entity?) is enabled. */
  listEnabledConnectionIds?(
    vendor: string,
    entity?: string,
  ): Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
}

/** Compose the joined activeness probe from the two underlying
 *  adapters. When both adapters expose enumeration methods, the
 *  result performs a true intersection over connection_ids. When
 *  one or both don't enumerate, the join falls back to the legacy
 *  pair semantics — the spec's contract is honored only for
 *  scoped (connection_id-supplied) requirements in that case. */
export const composeConnectionActivenessProbe = (
  health: ConnectionHealthProbe,
  source: SourceEnablementProbe,
): ConnectionActivenessProbe => ({
  async findActiveConnection(vendor, entity, connection_id) {
    if (connection_id !== undefined) {
      const [healthy, enabled] = await Promise.all([
        Promise.resolve(health.isHealthy(vendor, entity, connection_id)),
        Promise.resolve(source.hasEnabledSource(vendor, entity, connection_id)),
      ]);
      return healthy && enabled ? connection_id : null;
    }
    // Aggregate path — need to find a single connection_id that
    // satisfies both. Prefer enumeration when adapters expose it.
    if (
      typeof health.listHealthyConnectionIds === 'function' &&
      typeof source.listEnabledConnectionIds === 'function'
    ) {
      const [healthyIds, enabledIds] = await Promise.all([
        Promise.resolve(health.listHealthyConnectionIds(vendor, entity)),
        Promise.resolve(source.listEnabledConnectionIds(vendor, entity)),
      ]);
      const enabledSet = new Set(enabledIds);
      for (const id of healthyIds) {
        if (enabledSet.has(id)) return id;
      }
      return null;
    }
    // Legacy fallback — independent predicates. Correct only when
    // the adapters report on at least one shared connection_id;
    // imprecise in the multi-Source case (Codex P1). Composers
    // wiring real stores SHOULD provide enumeration variants.
    const [healthy, enabled] = await Promise.all([
      Promise.resolve(health.isHealthy(vendor, entity)),
      Promise.resolve(source.hasEnabledSource(vendor, entity)),
    ]);
    return healthy && enabled ? '<unspecified>' : null;
  },
});

export const createConnectionActiveProbe = (
  active: ConnectionActivenessProbe,
): CapacityProbe => ({
  kind: 'connection_active',
  async probe(req) {
    if (req.kind !== 'connection_active') {
      return { ok: false, failure: 'probe_error', detail: 'probe_misconfigured' };
    }
    const id = await active.findActiveConnection(req.vendor, req.entity, req.connection_id);
    if (id !== null) return { ok: true };
    return { ok: false, detail: 'no_active_connection' };
  },
});

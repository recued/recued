/** D-165 P0 — per-connection operation profile store (LOCAL-ONLY).
 *
 *  Holds the `{ connection_name → { allowed_operations, risk_overrides,
 *  approval_defaults } }` grant state the catalog gateway resolves against
 *  at dispatch (see `resolveCatalogOperationPolicy`). This is the *seed*
 *  the full `contract.*` namespace formalizes in D-165 P2+ — deliberately
 *  a thin in-memory keyed map, NOT the schema-driven contract substrate.
 *
 *  P0 has no install planner (that's P3), so nothing populates this store
 *  yet: it starts empty and `get` returns null, which the gateway treats
 *  as `no_connection_profile` → deny (fail-closed; operations default OFF,
 *  Invariant 3). The P1 OAuth pilot seeds it (express the provider's
 *  operations as a profile); P3's install planner replaces hand-seeding
 *  with `InstalledAgentConnectionGrant` rows. The store is wired now so
 *  the engine's `connectionProfileResolver` hook is live end-to-end.
 *
 *  Local-only by construction — never synced cloud (D-090/D-097). An
 *  in-memory map is sufficient for P0/P1; a durable backing (SQLite) can
 *  drop in behind this interface without touching the gateway.
 *
 *  Spec: docs/d-165-spec.md § "P0 — Kernel + gateway"; § Runtime flow.
 */

import type { ConnectionOperationProfile } from '@recued/contracts';

export interface ConnectionOperationProfileStore {
  /** Resolve the profile for a connection name, or null when none is
   *  enrolled (gateway fails closed on null). */
  get(connection_name: string): ConnectionOperationProfile | null;
  /** Enroll / replace a connection's operation profile. */
  set(connection_name: string, profile: ConnectionOperationProfile): void;
  /** Drop a connection's profile (revokes all its grants). */
  delete(connection_name: string): void;
  /** Every enrolled `(connection_name, profile)` pair — the candidate
   *  universe for >1-provider pick resolution (doc §4: an unbound
   *  connection slot derives its capable candidates from the enrolled
   *  catalog-stamped profiles). Snapshot semantics; order unspecified. */
  list(): ReadonlyArray<readonly [string, ConnectionOperationProfile]>;
}

/** In-memory `ConnectionOperationProfileStore`. Optional `seed` lets boot
 *  / tests pre-populate; absent → empty (every catalog call fails closed
 *  until profiles are enrolled). */
export const createInMemoryConnectionOperationProfileStore = (
  seed?: Readonly<Record<string, ConnectionOperationProfile>>,
): ConnectionOperationProfileStore => {
  const map = new Map<string, ConnectionOperationProfile>(
    seed ? Object.entries(seed) : undefined,
  );
  return {
    get: (name) => map.get(name) ?? null,
    set: (name, profile) => {
      map.set(name, profile);
    },
    delete: (name) => {
      map.delete(name);
    },
    list: () => [...map.entries()].map(([name, profile]) => [name, profile] as const),
  };
};

/** D-192 unit-3 — LIVE vendor registry injection for the pure read-side
 *  alias resolvers.
 *
 *  The read-side aliases — D-130's cross-vendor `data.crm.<crm_alias>.*`
 *  (`connection-vendor-crm-aliases.ts`) and D-129's per-vendor
 *  `data.<vendor>.<entity>.*` (`connection-vendor-aliases.ts`) — dispatch a
 *  ref onto the canonical enrichment store by matching the path against the
 *  vendor-entity registry. Both matchers default their `registry` param to
 *  the FROZEN builtin `CONNECTION_VENDOR_ENTITIES`, so a **pack-declared**
 *  CRM (e.g. Dynamics via `community/packs/dynamics.json`) that only exists
 *  in the LIVE merged registry (`liveVendorRegistry(localManifestStore)`)
 *  can't have its `data.crm.*` / `data.<vendor>.*` refs rewritten — they
 *  resolve to undefined and fail validation. Built-in CRMs are unaffected.
 *
 *  Why a module-level resolver and not a threaded param: the two seams live
 *  in the pure `@recued/contracts` / `@recued/recipes` layer — `parseRef`
 *  (resolve.ts) is called with no context, deep inside the value system
 *  (through `resolveValue` / `resolveDeep` / `collectRefs` at 20+ engine
 *  call sites), and the public-boundary rule forbids `packages/` importing
 *  `backend/` where `liveVendorRegistry` lives. Threading a registry down
 *  every call site is invasive; instead composition (server-side, which HAS
 *  the store) sets a lazy thunk once, mirroring `role.ts`'s `setRole`. The
 *  thunk is evaluated per use (recompute-on-read), so it always reflects the
 *  currently-installed packs.
 *
 *  Unbound is the correct default everywhere the live registry is
 *  unreachable — the webclient (which only ever reaches this path via
 *  `collectRefs` and discards the CRM result), the Bridge, and every test —
 *  and yields the frozen builtin, i.e. byte-identical behaviour for the
 *  built-in vendors. Only the server binds it (see `composeAppContext`). */

import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
} from './connection-vendors.js';

let _resolver: (() => ReadonlyArray<ConnectionVendorEntity>) | null = null;

/** Inject the LIVE merged vendor registry resolver for the read-side alias
 *  rewrites. Server composition passes `() => liveVendorRegistry(store)`;
 *  pass `null` to reset (tests). The resolver is a thunk so pack installs
 *  after boot are picked up on the next resolution. */
export const setVendorAliasRegistryResolver = (
  resolver: (() => ReadonlyArray<ConnectionVendorEntity>) | null,
): void => {
  _resolver = resolver;
};

/** The vendor registry the read-side alias resolvers should dispatch
 *  against: the bound live resolver's result, or the frozen builtin when
 *  unbound. Never throws — an unbound resolver is a valid state (client /
 *  test / pre-boot). */
export const activeVendorAliasRegistry = (): ReadonlyArray<ConnectionVendorEntity> =>
  _resolver?.() ?? CONNECTION_VENDOR_ENTITIES;

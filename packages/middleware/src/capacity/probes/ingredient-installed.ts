/** D-145 PB1.4 — ingredient_installed probe.
 *
 *  Reads `IngredientRegistryProbe.isInstalled(slug)` from the
 *  install registry. Same registry is used for selector_freshness's
 *  `getBumpedAt` path. */

import type { CapacityProbe } from '../types.js';

export interface IngredientRegistryProbe {
  isInstalled(slug: string): Promise<boolean> | boolean;
  /** ms epoch of the most recent CI weekly bump. Returns null when
   *  the slug is unknown or has no recorded bump. */
  getBumpedAt(slug: string): Promise<number | null> | number | null;
  /** ms TTL for selector freshness. Substrate-managed; registries
   *  store `selector_ttl_ms` for selector-backed ingredients. */
  getSelectorTtlMs(slug: string): Promise<number | null> | number | null;
}

export const createIngredientInstalledProbe = (
  reg: IngredientRegistryProbe,
): CapacityProbe => ({
  kind: 'ingredient_installed',
  async probe(req) {
    if (req.kind !== 'ingredient_installed') {
      return { ok: false, failure: 'probe_error', detail: 'probe_misconfigured' };
    }
    const ok = await reg.isInstalled(req.slug);
    if (ok) return { ok: true };
    return { ok: false, detail: 'ingredient_missing' };
  },
});

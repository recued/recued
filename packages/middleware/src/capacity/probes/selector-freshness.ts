/** D-145 PB1.4 — selector_freshness probe.
 *
 *  Reads `IngredientRegistryProbe.getBumpedAt(slug)` + the
 *  ingredient's `selector_ttl_ms`. Walker-side cache TTL is 24h
 *  (per § N.10) — shorter than the underlying 7d ingredient TTL by
 *  design so degradation surfaces faster than the freshness window. */

import type { CapacityProbe } from '../types.js';
import type { IngredientRegistryProbe } from './ingredient-installed.js';

export const createSelectorFreshnessProbe = (
  reg: IngredientRegistryProbe,
): CapacityProbe => ({
  kind: 'selector_freshness',
  async probe(req, ctx) {
    if (req.kind !== 'selector_freshness') {
      return { ok: false, failure: 'probe_error', detail: 'probe_misconfigured' };
    }
    const bumpedAt = await reg.getBumpedAt(req.slug);
    const ttl = await reg.getSelectorTtlMs(req.slug);
    if (bumpedAt === null || ttl === null) {
      return { ok: false, detail: 'selector_unknown' };
    }
    const now = ctx.now ? ctx.now() : Date.now();
    if (now - bumpedAt < ttl) return { ok: true };
    return { ok: false, detail: 'selector_stale' };
  },
});

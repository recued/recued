/** D-145 PB1.4 — annotation probe.
 *
 *  Reads `WarehouseRefResolver.resolve(ref)`. Per § N.9 the
 *  annotation kind is non-cacheable — direct lookup is cheap and
 *  staleness is unacceptable for annotation reads (the value either
 *  exists or it doesn't; cache TTL has no value-add). */

import type { CapacityProbe } from '../types.js';

export interface WarehouseRefResolver {
  /** Returns true when the ref resolves to a non-undefined,
   *  non-null value. Substrate-internal — never returns the value
   *  itself; the annotation probe needs only existence. */
  resolve(ref: string): Promise<boolean> | boolean;
}

export const createAnnotationProbe = (
  resolver: WarehouseRefResolver,
): CapacityProbe => ({
  kind: 'annotation',
  async probe(req) {
    if (req.kind !== 'annotation') {
      return { ok: false, failure: 'probe_error', detail: 'probe_misconfigured' };
    }
    const ok = await resolver.resolve(req.ref);
    if (ok) return { ok: true };
    return { ok: false, detail: 'annotation_missing' };
  },
});

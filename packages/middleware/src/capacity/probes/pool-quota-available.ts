/** D-145 PB1.4 — pool_quota_available probe.
 *
 *  Reads `QuotaHeadroomProbe.hasHeadroom(pool)` from the D-132 LLM
 *  quota store. The `pool` discriminator is `'free' | 'byok'` at
 *  v1; future per-tier discrimination is unimplemented. */

import type { CapacityProbe } from '../types.js';
import type { PoolKind } from '@recued/contracts';

export interface QuotaHeadroomProbe {
  hasHeadroom(pool: PoolKind): Promise<boolean> | boolean;
}

export const createPoolQuotaAvailableProbe = (
  q: QuotaHeadroomProbe,
): CapacityProbe => ({
  kind: 'pool_quota_available',
  async probe(req) {
    if (req.kind !== 'pool_quota_available') {
      return { ok: false, failure: 'probe_error', detail: 'probe_misconfigured' };
    }
    const ok = await q.hasHeadroom(req.pool);
    if (ok) return { ok: true };
    return { ok: false, detail: 'quota_exhausted' };
  },
});

/** D-145 PB1.4 — logged_in probe.
 *
 *  Reads `BridgeStateProbe.getLoggedIn(site, bridge_instance_id?)`.
 *  Per-origin login state lives in the Bridge's session-storage
 *  layer; D-148 P9 lands the canonical adapter shape. */

import type { CapacityProbe } from '../types.js';
import type { BridgeStateProbe } from './bridge-online.js';

export const createLoggedInProbe = (state: BridgeStateProbe): CapacityProbe => ({
  kind: 'logged_in',
  async probe(req, ctx) {
    if (req.kind !== 'logged_in') {
      return { ok: false, failure: 'probe_error', detail: 'probe_misconfigured' };
    }
    const ok = await state.getLoggedIn(req.site, ctx.bridge_instance_id);
    if (ok) return { ok: true };
    return { ok: false, detail: 'logged_out' };
  },
});

/** D-145 PB1.4 — bridge_online probe.
 *
 *  Reads `BridgeStateProbe.getOnline(bridge_instance_id?)`. The
 *  underlying adapter ships at D-148 § A.1.4; PB1.7's composer
 *  defaults to a stub that returns `false` until D-148 lands. */

import type { CapacityProbe } from '../types.js';

export interface BridgeStateProbe {
  getOnline(bridge_instance_id?: string): Promise<boolean> | boolean;
  getLoggedIn(
    site: string,
    bridge_instance_id?: string,
  ): Promise<boolean> | boolean;
}

export const createBridgeOnlineProbe = (state: BridgeStateProbe): CapacityProbe => ({
  kind: 'bridge_online',
  async probe(_req, ctx) {
    const ok = await state.getOnline(ctx.bridge_instance_id);
    if (ok) return { ok: true };
    return { ok: false, detail: 'bridge_offline' };
  },
});

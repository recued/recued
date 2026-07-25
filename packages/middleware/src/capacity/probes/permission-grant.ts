/** D-145 PB1.4 — permission_grant probe.
 *
 *  Reads `PermissionRegistryProbe.hasPermission(permission)` from
 *  the installation registry's permission grants. */

import type { CapacityProbe } from '../types.js';

export interface PermissionRegistryProbe {
  hasPermission(permission: string): Promise<boolean> | boolean;
}

export const createPermissionGrantProbe = (
  reg: PermissionRegistryProbe,
): CapacityProbe => ({
  kind: 'permission_grant',
  async probe(req) {
    if (req.kind !== 'permission_grant') {
      return { ok: false, failure: 'probe_error', detail: 'probe_misconfigured' };
    }
    const ok = await reg.hasPermission(req.permission);
    if (ok) return { ok: true };
    return { ok: false, detail: 'permission_missing' };
  },
});

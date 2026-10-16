import { CONNECTION_NAME_REGEX, isPackReconnectWorklist, type PackReconnectGroup,
  type PackReconnectWorklist } from '@recued/contracts';
import { PACK_PERMISSION_REPAIR_ID, type PackPermissionRepair } from './pack-permission-repair.js';

export interface ReconnectWorklistRepair {
  source: 'worklist';
  id: string;
  name: string;
  label: string;
  authentication: 'direct_oauth' | 'broker';
  required_scopes: string[];
  review_fingerprint: string;
  group_id: string;
  expires_at: number;
  return_to: 'packs' | 'connections';
}
export type ConnectionPermissionRepair = PackPermissionRepair | ReconnectWorklistRepair;
export const isWorklistRepair = (r: ConnectionPermissionRepair): r is ReconnectWorklistRepair => 'source' in r && r.source === 'worklist';
export interface ReconnectWorklistReturn {
  name: string;
  verified: boolean;
  reconnect_collections?: PackPermissionRepair['reconnect_collections'];
}
export const createReconnectWorklistContinuity = (deps: { now?(): number; id?(): string } = {}) => {
  const now = deps.now ?? Date.now;
  let current: ReconnectWorklistRepair | undefined;
  let returned: (ReconnectWorklistReturn & { return_to: 'packs' | 'connections'; expires_at: number }) | undefined;
  const live = (): ReconnectWorklistRepair | undefined => {
    if (current && current.expires_at <= now()) current = undefined;
    return current;
  };
  return {
    begin(group: PackReconnectGroup, returnTo: 'packs' | 'connections'): ReconnectWorklistRepair {
      if (!isPackReconnectWorklist({ groups: [group], unresolved_packs: [] }) || !group.can_reconnect || !group.name
        || !CONNECTION_NAME_REGEX.test(group.name) || !group.required_scopes.length
        || !['direct_oauth', 'broker'].includes(group.authentication)) throw new Error('Refresh Reconnect later before reconnecting this account.');
      const id = deps.id?.() ?? 'ppr-' + crypto.randomUUID().replaceAll('-', '');
      if (!PACK_PERMISSION_REPAIR_ID.test(id)) throw new Error('The reconnect review could not be started.');
      current = { source: 'worklist', id, name: group.name, label: group.items.map(i => i.pack_name).join(', '),
        authentication: group.authentication === 'broker' ? 'broker' : 'direct_oauth', required_scopes: [...group.required_scopes],
        review_fingerprint: group.fingerprint, group_id: group.id, expires_at: now() + 30 * 60_000, return_to: returnTo };
      returned = undefined; return structuredClone(current);
    },
    read(id: string, name: string): ReconnectWorklistRepair | undefined {
      const r = live(); return r?.id === id && r.name === name ? structuredClone(r) : undefined;
    },
    finish(id: string, verified: boolean, collections?: PackPermissionRepair['reconnect_collections']): void {
      const r = live(); if (!r || r.id !== id) return;
      returned = { name: r.name, verified, return_to: r.return_to, expires_at: r.expires_at,
        ...(collections?.length ? { reconnect_collections: structuredClone(collections) } : {}) }; current = undefined;
    },
    takeReturn(route: 'packs' | 'connections'): ReconnectWorklistReturn | undefined {
      if (returned && returned.expires_at <= now()) returned = undefined;
      if (!returned || returned.return_to !== route) return undefined;
      const r = returned; returned = undefined;
      return { name: r.name, verified: r.verified, ...(r.reconnect_collections ? { reconnect_collections: r.reconnect_collections } : {}) };
    },
  };
};
export const validateWorklistRepair = (repair: ReconnectWorklistRepair, worklist: PackReconnectWorklist, now = Date.now()): string[] => {
  if (repair.expires_at <= now) throw new Error('This repair expired. Return to Reconnect later and start again.');
  if (!isPackReconnectWorklist(worklist)) throw new Error('The reconnect worklist could not be read. Return and refresh it.');
  const group = worklist.groups.find(g => g.id === repair.group_id && g.name === repair.name);
  if (!group?.can_reconnect || group.fingerprint !== repair.review_fingerprint
    || group.authentication !== repair.authentication || JSON.stringify(group.required_scopes) !== JSON.stringify(repair.required_scopes)) {
    throw new Error('Installed permissions or accounts changed. Return to Reconnect later and refresh.');
  }
  return [...group.required_scopes];
};

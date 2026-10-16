/** Reminders do not grant vendor permissions or change operation access. */
export interface PackReconnectItem {
  id: string;
  pack_slug: string;
  pack_name: string;
  version: number;
  slot: string;
  required_scopes: string[];
  missing_scopes: string[];
  coverage: 'missing' | 'unknown';
  reviewed: boolean;
}
export interface PackReconnectGroup {
  id: string;
  fingerprint: string;
  name?: string;
  display_name: string;
  authentication: 'direct_oauth' | 'broker' | 'other' | 'unknown';
  required_scopes: string[];
  items: PackReconnectItem[];
  reviewed: boolean;
  can_reconnect: boolean;
  can_mark_reviewed: boolean;
}
export interface PackReconnectWorklist {
  groups: PackReconnectGroup[];
  unresolved_packs: Array<{ slug: string; name: string; message: string }>;
}
export type PackReconnectRequest = { action: 'list' }
  | { action: 'mark_reviewed' | 'restore_review'; group_id: string; fingerprint: string };
export type PackReconnectResponse = PackReconnectWorklist & { action: PackReconnectRequest['action'] };

export const isPackReconnectWorklist = (v: unknown): v is PackReconnectWorklist => {
  const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const label = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 4096;
  const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  const scopes = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 512 && x.every(label);
  return record(v) && Array.isArray(v.groups) && v.groups.length <= 2048 && v.groups.every(g => record(g)
    && hash(g.id) && hash(g.fingerprint) && (g.name === undefined || label(g.name)) && label(g.display_name)
    && typeof g.authentication === 'string' && ['direct_oauth', 'broker', 'other', 'unknown'].includes(g.authentication) && scopes(g.required_scopes)
    && typeof g.reviewed === 'boolean' && typeof g.can_reconnect === 'boolean' && typeof g.can_mark_reviewed === 'boolean'
    && Array.isArray(g.items) && g.items.length > 0 && g.items.length <= 2048 && g.items.every(i => record(i)
      && hash(i.id) && label(i.pack_slug) && label(i.pack_name) && Number.isSafeInteger(i.version) && Number(i.version) > 0
      && label(i.slot) && scopes(i.required_scopes) && scopes(i.missing_scopes) && typeof i.coverage === 'string' && ['missing', 'unknown'].includes(i.coverage)
      && typeof i.reviewed === 'boolean' && (i.coverage !== 'missing' || !i.reviewed)))
    && Array.isArray(v.unresolved_packs) && v.unresolved_packs.length <= 2048 && v.unresolved_packs.every(p => record(p)
      && label(p.slug) && label(p.name) && label(p.message));
};

/** D-322 §25 — public account choices and exact local usage, without credentials or health claims. */
import { createHash } from 'node:crypto';
import type { ConnectionRow, ManagedOAuthAccountPreview, ManagedOAuthConnectionUse, ManagedOAuthImpactPreview } from '@recued/contracts';

export const managedOAuthImpactUses = (names: readonly string[],
  read?: (name: string) => { uses: readonly ManagedOAuthConnectionUse[]; complete: boolean }) => names.map(name => {
  try {
    const references = read?.(name);
    return { name, uses: [...(references?.uses ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
      usage_available: references?.complete ?? false };
  } catch { return { name, uses: [], usage_available: false }; }
}).sort((a, b) => a.name.localeCompare(b.name));
export const managedOAuthImpactSignature = (names: readonly string[],
  read?: Parameters<typeof managedOAuthImpactUses>[1]): string =>
  createHash('sha256').update(JSON.stringify(managedOAuthImpactUses(names, read))).digest('hex');

export const managedOAuthImpact = (args: {
  phase: ManagedOAuthImpactPreview['phase']; mode: ManagedOAuthImpactPreview['mode']; consent: ManagedOAuthImpactPreview['consent'];
  current?: ManagedOAuthAccountPreview; target: ManagedOAuthAccountPreview;
  row?: ConnectionRow; members: readonly ConnectionRow[];
  read?: Parameters<typeof managedOAuthImpactUses>[1];
  membership_known?: boolean;
}): ManagedOAuthImpactPreview => {
  const rows = new Map(args.members.map(row => [row.name, row]));
  if (args.row) rows.set(args.row.name, args.row);
  const connections = managedOAuthImpactUses([...rows.keys()], args.read).map(item => ({
    ...item, display_name: rows.get(item.name)!.display_name || item.name,
    effect: item.name === args.row?.name ? 'selected_connection' as const
      : args.consent === 'request' ? 'shared_consent' as const : 'shares_account' as const,
  }));
  const warnings = ['Usage covers this Recued server. Other tools may use the same broker account.',
    'Account details do not prove resource access or all permissions.'];
  if (connections.some(c => !c.usage_available)) warnings.push('Some local usage is unknown. Review the connection before continuing.');
  if (args.membership_known === false) warnings.push('Stable broker account identity is unavailable. Matching connections on other broker profiles may be missing.');
  if (args.mode === 'switch' && connections.some(c => c.effect === 'selected_connection' && c.uses.some(u => u.kind === 'mail' || u.kind === 'calendar'))) {
    warnings.push('Mail and Calendar bindings pin their broker account. Review and reconnect those collections after switching.');
  }
  const preview: ManagedOAuthImpactPreview = { fingerprint: '', phase: args.phase, mode: args.mode, consent: args.consent,
    ...(args.current ? { current: args.current } : {}), target: args.target, connections, warnings };
  preview.fingerprint = createHash('sha256').update(JSON.stringify(preview)).digest('hex');
  return preview;
};

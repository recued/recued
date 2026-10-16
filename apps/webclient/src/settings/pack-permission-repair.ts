/** Short-lived, paired-client handoff. No credentials or vendor URLs enter a route. */
import { CONNECTION_NAME_REGEX, isPackVendorPermissionReview,
  type BulkPackManifest, type InstallAccessTier, type InstallAudienceSelection,
  type PackListEntry, type PackVendorPermissionReview } from '@recued/contracts';
import type { InstallPreview } from './packs-install-dialog.js';

export interface PackInstallResume {
  pack: PackListEntry & { manifest: BulkPackManifest };
  marketplace: boolean;
  permissions: string[];
  access?: InstallAccessTier;
  audience?: InstallAudienceSelection;
  chosen_connection?: string;
  also_unticked: string[];
  also_connections: string[];
  webhook_picks: Array<[string, string]>;
  template_keep: Array<[string, 'recipe' | 'existing']>;
  dependency_access: Array<[string, InstallAccessTier]>;
}
export interface PackPermissionRepairRequest {
  name: string;
  review: PackVendorPermissionReview;
  resume: PackInstallResume;
}
export interface PackPermissionRepair {
  id: string;
  name: string;
  required_scopes: string[];
  review_fingerprint: string;
  authentication: 'direct_oauth' | 'broker';
  expires_at: number;
  resume: PackInstallResume;
  verified?: boolean;
  reconnect_collections?: Array<{ kind: 'mail' | 'calendar'; id: string; label: string }>;
}
export const PACK_PERMISSION_REPAIR_ID = /^ppr-[a-f0-9]{32}$/;
export const packRepairScopes = (review: PackVendorPermissionReview, name: string, resume: PackInstallResume): string[] =>
  [...new Set(review.changes.filter(change => change.connections.some(connection => connection.name === name)
    && (change.current_connections.includes(name)
      || (change.pack_slug === resume.pack.slug || change.uses_selected_connection === true) && resume.chosen_connection === name
      || change.pack_slug === resume.pack.slug && resume.also_connections.includes(name)))
    .flatMap(change => change.required_scopes))].sort();

export const createPackPermissionRepairContinuity = (deps: {
  now?(): number; id?(): string;
} = {}) => {
  const now = deps.now ?? Date.now;
  let current: PackPermissionRepair | undefined;
  const live = (): PackPermissionRepair | undefined => {
    if (current && current.expires_at <= now()) current = undefined;
    return current;
  };
  return {
    begin(request: PackPermissionRepairRequest): PackPermissionRepair {
      if (!CONNECTION_NAME_REGEX.test(request.name) || !isPackVendorPermissionReview(request.review) || !request.review.resolved) {
        throw new Error('Refresh the pack permission review before reconnecting.');
      }
      const account = request.review.changes.flatMap(change => change.connections).find(connection => connection.name === request.name);
      const scopes = packRepairScopes(request.review, request.name, request.resume);
      if (!account || !['direct_oauth', 'broker'].includes(account.authentication) || !scopes.length) {
        throw new Error('Choose a saved OAuth connection with declared pack permissions.');
      }
      const id = deps.id?.() ?? 'ppr-' + crypto.randomUUID().replaceAll('-', '');
      if (!PACK_PERMISSION_REPAIR_ID.test(id)) throw new Error('The permission repair could not be started.');
      current = { id, name: request.name, required_scopes: scopes, review_fingerprint: request.review.fingerprint,
        authentication: account.authentication === 'broker' ? 'broker' : 'direct_oauth',
        expires_at: now() + 30 * 60_000, resume: structuredClone(request.resume) };
      return structuredClone(current);
    },
    read(id: string, name: string): PackPermissionRepair | undefined {
      const value = live();
      return value?.id === id && value.name === name ? structuredClone(value) : undefined;
    },
    complete(id: string, collections?: PackPermissionRepair['reconnect_collections']): void {
      const value = live(); if (value?.id === id) { value.verified = true;
        if (collections?.length) value.reconnect_collections = structuredClone(collections); }
    },
    takeReturn(slug: string): PackPermissionRepair | undefined {
      const value = live();
      if (!value || value.resume.pack.slug !== slug) return undefined;
      current = undefined; return structuredClone(value);
    },
    clear(): void { current = undefined; },
  };
};

/** Re-read on the destination route before using any incoming permission list. */
export const validatePackPermissionRepair = (repair: PackPermissionRepair, preview: InstallPreview): string[] => {
  const review = preview.vendor_permissions;
  if (!isPackVendorPermissionReview(review) || !review.resolved || review.fingerprint !== repair.review_fingerprint) {
    throw new Error('The pack or saved accounts changed. Return to the pack, refresh its permission review, and reconnect again.');
  }
  const scopes = packRepairScopes(review, repair.name, repair.resume);
  if (JSON.stringify(scopes) !== JSON.stringify(repair.required_scopes)) throw new Error('The required permissions changed. Return to the pack and review again.');
  return scopes;
};

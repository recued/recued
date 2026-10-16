import { describe, expect, it } from 'vitest';
import { isOAuthAppsResponse } from '../foundational-oauth.js';
import { isOAuthPermissionInventory, isOAuthPermissionCleanupPreview, type OAuthPermissionInventory } from '../oauth-permission-consolidation.js';
const inventory = (): OAuthPermissionInventory => ({ fingerprint: 'a'.repeat(64), observed_at: 1000, unavailable: [], groups: [{ id: 'b'.repeat(64), app_key: 'c'.repeat(64),
  app_label: 'Work', issuer: 'google', saved_app_id: 'default', authentication: 'direct_oauth', account_label: 'Unknown account', connection_names: ['work'], native_accounts: [],
  uses: [], requirements_complete: true, grants_known: true, required_scopes: [], warnings: [],
  scopes: [{ scope: 'leftover', status: 'unused_locally', evidence: 'recorded_grant', required_by: [] }] }] });
describe('OAuth permission inventory protocol', () => {
  it('accepts a bounded inventory and the two read-only OAuth app actions', () => {
    expect(isOAuthPermissionInventory(inventory())).toBe(true);
    for (const action of ['permission_inventory', 'preview_permission_cleanup']) expect(isOAuthAppsResponse({ action, apps: [] })).toBe(true);
  });
  it.each(['duplicate group', 'unknown grants', 'incomplete requirements', 'requested only', 'required by another use', 'bad use', 'false possible use', 'bad filter', 'negative time', 'oversized scopes'])('rejects unsafe %s inventory', mode => {
    const value = inventory(); const group = value.groups[0]!;
    if (mode === 'duplicate group') value.groups = [group, group];
    if (mode === 'unknown grants') group.grants_known = false;
    if (mode === 'incomplete requirements') group.requirements_complete = false;
    if (mode === 'requested only') group.scopes = [{ ...group.scopes[0]!, evidence: 'requested_only' }];
    if (mode === 'required by another use') group.scopes = [{ ...group.scopes[0]!, required_by: [{ kind: 'pack', id: 'pack', label: 'Pack' }] }];
    if (mode === 'bad use') group.uses = [{ kind: 'token', id: 'secret', label: 'secret' } as never];
    if (mode === 'false possible use') group.uses = [{ kind: 'pack', id: 'pack', label: 'Pack', may_use: false } as never];
    if (mode === 'bad filter') value.filter = { issuer: 'google', app_id: 'arbitrary' };
    if (mode === 'negative time') value.observed_at = -1;
    if (mode === 'oversized scopes') group.scopes = Array.from({ length: 513 }, (_, i) => ({ scope: 'scope-' + i, status: 'unknown', evidence: 'requested_only', required_by: [] }));
    expect(isOAuthPermissionInventory(value)).toBe(false);
  });
  it('accepts only a preview that makes no mutation or verification claim', () => {
    const plan = { inventory_fingerprint: 'a'.repeat(64), group_id: 'b'.repeat(64), selected_scopes: ['leftover'], retained_scopes: ['read'], required_scopes: ['read'],
      connection_names: ['work'], uses: [], related_group_ids: [], method: 'google_revoke_reconnect', warnings: [], mutation: false, verification: 'not_checked' };
    expect(isOAuthPermissionCleanupPreview(plan)).toBe(true);
    for (const patch of [{ mutation: true }, { verification: 'verified' }, { selected_scopes: [] }, { retained_scopes: ['leftover'] }, { related_group_ids: ['not-a-group'] }]) {
      expect(isOAuthPermissionCleanupPreview({ ...plan, ...patch })).toBe(false);
    }
  });
});

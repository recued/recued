import { describe, expect, it } from 'vitest';
import type { BulkPackManifest, PackVendorPermissionReview } from '@recued/contracts';
import { createPackPermissionRepairContinuity, validatePackPermissionRepair,
  type PackInstallResume } from '../settings/pack-permission-repair.js';
import { connectionsPermissionRepairAddress, parseConnectionsPermissionRepair } from '../connections/connections-navigation.js';
const manifest: BulkPackManifest = { manifest_version: 1, slug: 'scope-pack', publisher: 'recued-core', name: 'Scope pack',
  description: 'Fixture', version: 1, requires: [], recipes: [{ slug: 'fixture', version: 1 }], tags: [] };
const draft = (): PackInstallResume => ({ pack: { ...manifest, installed: false, pre_install: false, recipe_count: 1,
  recipe_refs: manifest.recipes, body_visibility_grant_keys: [], body_visibility_grant_count: 0, manifest },
  marketplace: false, permissions: [], chosen_connection: 'native', also_unticked: [], also_connections: [],
  webhook_picks: [['mail-webhook', 'saved-door']], template_keep: [['mail-template', 'existing']], dependency_access: [['foundation', 'write']] });
const review = (): PackVendorPermissionReview => ({ fingerprint: 'a'.repeat(64), resolved: true, changes: [{
  pack_slug: manifest.slug, pack_name: manifest.name, slot: 'graph', required_scopes: ['Mail.Read', 'Mail.Send'],
  current_connections: [], connections: [{ name: 'native', display_name: 'Native', authentication: 'direct_oauth',
    coverage: 'missing', granted_scopes: ['Mail.Read'], missing_scopes: ['Mail.Send'] }],
}] });
describe('pack permission repair handoff', () => {
  it('carries only scoped local context, clones choices, and returns once with verification separate from installation', () => {
    const c = createPackPermissionRepairContinuity({ id: () => 'ppr-' + 'a'.repeat(32), now: () => 100 });
    const resume = draft(); const repair = c.begin({ name: 'native', review: review(), resume });
    resume.webhook_picks[0]![1] = 'changed';
    expect(c.read(repair.id, 'native')!.resume.webhook_picks).toEqual([['mail-webhook', 'saved-door']]);
    expect(c.read(repair.id, 'other')).toBeUndefined();
    expect(c.takeReturn('other-pack')).toBeUndefined();
    c.complete(repair.id);
    expect(c.takeReturn('scope-pack')).toMatchObject({ verified: true, name: 'native', required_scopes: ['Mail.Read', 'Mail.Send'] });
    expect(c.takeReturn('scope-pack')).toBeUndefined();
    const address = connectionsPermissionRepairAddress(repair.name, repair.id);
    expect(address.hash).not.toContain('Mail.Read'); expect(address.hash).not.toContain('api.nango');
    expect(parseConnectionsPermissionRepair(['others', 'repair-pack-permissions', 'api', 'native', repair.id])).toEqual({ name: 'native', id: repair.id });
    expect(parseConnectionsPermissionRepair(['others', 'repair-pack-permissions', 'api', 'native', repair.id, 'Mail.Read'])).toBeNull();
  });
  it('unions only incoming scopes assigned to this account, including inherited dependencies', () => {
    const r = review(); r.changes.push({ ...r.changes[0]!, pack_slug: 'inherited', uses_selected_connection: true, required_scopes: ['Calendars.Read'] },
      { ...r.changes[0]!, pack_slug: 'another-account-pack', current_connections: ['other'], required_scopes: ['Files.ReadWrite'] });
    const c = createPackPermissionRepairContinuity({ id: () => 'ppr-' + 'b'.repeat(32) });
    const repair = c.begin({ name: 'native', review: r, resume: draft() });
    expect(repair.required_scopes).toEqual(['Calendars.Read', 'Mail.Read', 'Mail.Send']);
    expect(validatePackPermissionRepair(repair, { resolved: true, will_enable: [], hidden_count: 0, vendor_permissions: r })).toEqual(repair.required_scopes);
    expect(() => validatePackPermissionRepair(repair, { resolved: true, will_enable: [], hidden_count: 0,
      vendor_permissions: { ...r, fingerprint: 'c'.repeat(64) } })).toThrow('changed');
  });
  it('expires and refuses unknown or unsupported authentication instead of guessing scopes', () => {
    let now = 100; const c = createPackPermissionRepairContinuity({ now: () => now, id: () => 'ppr-' + 'a'.repeat(32) });
    const repair = c.begin({ name: 'native', review: review(), resume: draft() }); now = repair.expires_at;
    expect(c.read(repair.id, 'native')).toBeUndefined();
    expect(() => c.begin({ name: 'native', review: { ...review(), resolved: false }, resume: draft() })).toThrow();
    const r = review(); r.changes[0]!.connections[0]!.authentication = 'other';
    expect(() => c.begin({ name: 'native', review: r, resume: draft() })).toThrow('OAuth');
  });
});

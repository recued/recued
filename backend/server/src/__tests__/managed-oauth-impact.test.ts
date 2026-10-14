/** D-322 §25 — stable impact signatures and incomplete read boundaries. */
import { describe, expect, it } from 'vitest';
import type { ConnectionRow, ManagedOAuthAccountPreview } from '@recued/contracts';
import { managedOAuthImpact, managedOAuthImpactSignature } from '../managed-oauth-impact.js';
const row = (name: string): ConnectionRow => ({ pk: 'api:' + name, kind: 'api', name, display_name: name,
  auth_ciphertext: 'private', config_json: '{"secret":"private"}', enrolled_at: 1, updated_at: 2 });
const target: ManagedOAuthAccountPreview = { authentication: 'broker', broker: { id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 },
  integration_id: 'sheets', connection_id: 'remote', identity: { status: 'unknown', reason: 'unsupported' } };
describe('D-322 account impact projection', () => {
  it('separates the selected connection from immediate shared consent effects', () => {
    const result = managedOAuthImpact({ phase: 'before_authorization', mode: 'switch', consent: 'request', row: row('selected'),
      members: [row('shared'), row('selected')], target, read: () => ({ complete: true, uses: [{ kind: 'pack', id: 'p', label: 'Pack' }] }) });
    expect(result.connections.map(c => [c.name, c.effect])).toEqual([['selected', 'selected_connection'], ['shared', 'shared_consent']]);
    expect(JSON.stringify(result)).not.toMatch(/private|ciphertext|config_json/);
  });
  it('does not claim failed usage reads are empty verified impact', () => {
    const result = managedOAuthImpact({ phase: 'before_save', mode: 'reauthorize', consent: 'reuse', members: [row('shared')], target,
      read: () => { throw new Error('private database error'); } });
    expect(result.connections[0]).toMatchObject({ usage_available: false, effect: 'shares_account' });
    expect(result.warnings).toContain('Some local usage is unknown. Review the connection before continuing.');
    expect(JSON.stringify(result)).not.toContain('private database error');
  });
  it('hashes dependency content regardless of reader ordering', () => {
    const refs = [{ kind: 'pack' as const, id: 'one', label: 'One' }, { kind: 'schedule' as const, id: 'two', label: 'Two' }];
    const before = managedOAuthImpactSignature(['a', 'b'], () => ({ complete: true, uses: refs }));
    expect(managedOAuthImpactSignature(['b', 'a'], () => ({ complete: true, uses: [...refs].reverse() }))).toBe(before);
    expect(managedOAuthImpactSignature(['a', 'b'], () => ({ complete: false, uses: refs }))).not.toBe(before);
  });
});

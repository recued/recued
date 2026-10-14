/** D-322 §25 — distinct identities, side effects and safe rendering. */
import { describe, expect, it } from 'vitest';
import { isManagedOAuthImpactPreview, type ManagedOAuthImpactPreview } from '@recued/contracts';
import { renderManagedOAuthImpact } from '../settings/managed-oauth-impact-view.js';
const value = (): ManagedOAuthImpactPreview => ({ fingerprint: 'a'.repeat(64), phase: 'before_authorization', mode: 'switch', consent: 'request',
  current: { authentication: 'direct_oauth', identity: { status: 'unknown', reason: 'unavailable' } },
  target: { authentication: 'broker', broker: { id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 },
    integration_id: 'graph', connection_id: 'remote', identity: { status: 'known', account_id: 'user', email: 'owner@example.test' } },
  connections: [{ name: 'work', display_name: 'Work', effect: 'selected_connection', usage_available: false,
    uses: [{ kind: 'schedule', id: 'daily', label: 'Daily', paused: true, may_use: true }] }], warnings: [] });
describe('D-322 account and impact view', () => {
  it('shows the current and selected accounts without guessing missing vendor identity', () => {
    const html = renderManagedOAuthImpact(value());
    for (const copy of ['Current saved account', 'Selected account', 'Vendor email unknown', 'owner@example.test', 'Integration:', 'Broker account:']) expect(html).toContain(copy);
    expect(html).toContain('Some local use is unknown'); expect(html).toContain('(paused)'); expect(html).toContain('(can choose this account)');
  });
  it('escapes all identity and usage fields', () => {
    const v = value(); v.target.identity.display_name = '<img src=x>'; v.connections[0]!.uses[0]!.label = '<script>bad()</script>';
    expect(renderManagedOAuthImpact(v)).not.toMatch(/<img|<script>/); expect(renderManagedOAuthImpact(v)).toContain('&lt;img');
  });
  it('refuses inconsistent wire identities and malformed discriminators', () => {
    expect(isManagedOAuthImpactPreview(value())).toBe(true);
    for (const patch of [{ fingerprint: 'bad' }, { phase: ['before_save'] }, { target: { authentication: 'broker', identity: { status: 'unknown', email: 'bad@example.test' } } }]) {
      expect(isManagedOAuthImpactPreview({ ...value(), ...patch })).toBe(false);
    }
  });
});

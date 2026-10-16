import { describe, expect, it } from 'vitest';
import { isOAuthAppUsageReview, isOAuthAppSecretRotationOutcome, type OAuthAppUsageReview } from '../oauth-app-usage.js';
const review = (): OAuthAppUsageReview => ({ id: 'u'.repeat(43), fingerprint: 'a'.repeat(64), expires_at: 10000,
  app: { id: 'default', issuer: 'google', label: 'Work', client_id: 'client', has_secret: true, revision: 1 },
  native_accounts: [{ platform: 'mail', slug: 'work' }], connections: [{ name: 'work', display_name: 'Work', origin: 'confirmed', secret_matches: true, client_id_matches: true,
    group_id: 'one', group_complete: true, selected_by_default: true, uses: [{ kind: 'pack', id: 'pack', label: 'Pack' }], usage_available: true }],
  can_rotate: true, unreadable_connections: [], warnings: [] });
describe('saved app usage protocol guards', () => {
  it('accepts a complete public usage review', () => { expect(isOAuthAppUsageReview(review())).toBe(true); });
  it.each(['duplicate', 'unconfirmed default', 'incomplete default', 'wrong nonce', 'bad scope of use', 'bad expiry'] as const)('refuses %s metadata', kind => {
    const value = review();
    if (kind === 'duplicate') value.connections = [value.connections[0]!, value.connections[0]!];
    if (kind === 'unconfirmed default') value.connections = [{ ...value.connections[0]!, origin: 'unknown' }];
    if (kind === 'incomplete default') value.connections = [{ ...value.connections[0]!, group_complete: false }];
    if (kind === 'wrong nonce') value.id = 'short';
    if (kind === 'bad scope of use') (value.connections[0]!.uses[0] as { kind: string }).kind = 'token';
    if (kind === 'bad expiry') value.expires_at = -1;
    expect(isOAuthAppUsageReview(value)).toBe(false);
  });
  it('accepts only a bounded, secret-free rotation result shape', () => {
    const value = { attempt_id: 'a'.repeat(43), issuer: 'google', app_id: 'default', status: 'applied', selected_names: ['work'], skipped_names: [], native_accounts: [], verification: 'not_checked', app_revision: 2 };
    expect(isOAuthAppSecretRotationOutcome(value)).toBe(true);
    expect(isOAuthAppSecretRotationOutcome({ ...value, selected_names: ['work', 'work'] })).toBe(false);
    expect(isOAuthAppSecretRotationOutcome({ ...value, verification: 'verified' })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isOAuthPermissionCleanupJob, isOAuthPermissionCleanupAuthorization, type OAuthPermissionCleanupJob } from '../oauth-permission-cleanup.js';
const job = (): OAuthPermissionCleanupJob => ({ id: 'a'.repeat(43), revision: 1, issuer: 'google', mode: 'cleanup', status: 'prepared',
  app: { id: 'default', issuer: 'google', label: 'My Google app', client_id: 'client', revision: 1, has_secret: true },
  targets: [{ platform: 'mail', slug: 'work', provider: 'gmail', account: { status: 'known', account_id: 'owner@example.test', email: 'owner@example.test' } }],
  selected_scopes: ['sheet'], requested_scopes: ['read'], required_scopes: ['read'], reset_confirmation: 'not_confirmed', verification: 'not_checked', updated_at: 1000 });
describe('guided permission cleanup protocol', () => {
  it('distinguishes prepared work, owner-confirmed reset and verified fresh grants', () => {
    expect(isOAuthPermissionCleanupJob(job())).toBe(true);
    const ready = { ...job(), verified_targets: [{ platform: 'mail', slug: 'work' }], status: 'ready_to_apply', reset_confirmation: 'owner_confirmed', verification: 'fresh_grant_checked', granted_scopes: ['read'], review_expires_at: 9000 };
    expect(isOAuthPermissionCleanupJob(ready)).toBe(true); expect(isOAuthPermissionCleanupJob({ ...ready, status: 'applied' })).toBe(true);
    expect(isOAuthPermissionCleanupJob({ ...ready, mode: 'restore', status: 'restored', requested_scopes: ['read', 'sheet'], granted_scopes: ['read', 'sheet'] })).toBe(true);
  });
  it.each(['selected still requested', 'selected required', 'premature completion', 'unconfirmed reset', 'retained grant', 'wrong provider', 'unknown account',
    'duplicate target', 'missing email', 'empty needs', 'missing secret', 'unbounded scopes', 'bad revision', 'mixed outcome'])('rejects %s', scenario => {
    const value = job();
    if (scenario === 'selected still requested') value.requested_scopes = ['read', 'sheet'];
    if (scenario === 'selected required') value.required_scopes = ['sheet'];
    if (scenario === 'premature completion') value.status = 'applied';
    if (scenario === 'unconfirmed reset' || scenario === 'retained grant') {
      value.status = 'ready_to_apply'; value.verification = 'fresh_grant_checked'; value.review_expires_at = 9000;
      value.granted_scopes = scenario === 'retained grant' ? ['read', 'sheet'] : ['read'];
      if (scenario === 'retained grant') value.reset_confirmation = 'owner_confirmed';
    }
    if (scenario === 'wrong provider') value.targets = [{ platform: 'mail', slug: 'work', account: value.targets[0]!.account, provider: 'gcal' }];
    if (scenario === 'unknown account') value.targets = [{ ...value.targets[0]!, account: { status: 'unknown' } }];
    if (scenario === 'duplicate target') value.targets = [value.targets[0]!, value.targets[0]!];
    if (scenario === 'missing email') value.targets = [{ ...value.targets[0]!, account: { status: 'known', account_id: 'id' } }];
    if (scenario === 'empty needs') value.required_scopes = [];
    if (scenario === 'missing secret') value.app = { ...value.app, has_secret: false };
    if (scenario === 'unbounded scopes') value.requested_scopes = Array.from({ length: 257 }, (_, i) => 'scope' + i);
    if (scenario === 'bad revision') value.revision = 0;
    if (scenario === 'mixed outcome') { value.status = 'restored'; value.verification = 'fresh_grant_checked'; value.reset_confirmation = 'owner_confirmed'; value.granted_scopes = ['read']; }
    expect(isOAuthPermissionCleanupJob(value)).toBe(false);
  });
  it('binds consent to one current cleanup, app and bounded permission list', () => {
    const value = { id: 'b'.repeat(43), job_id: job().id, revision: 2, expires_at: 9000, app: job().app, requested_scopes: ['read'], target: { platform: 'mail', slug: 'work', provider: 'gmail' } };
    expect(isOAuthPermissionCleanupAuthorization(value)).toBe(true);
    for (const patch of [{ id: 'short' }, { job_id: '' }, { expires_at: -1 }, { revision: 0 }, { requested_scopes: [] }, { target: { platform: 'mail', slug: 'work', provider: 'gcal' } }]) {
      expect(isOAuthPermissionCleanupAuthorization({ ...value, ...patch })).toBe(false);
    }
  });
  it('represents verified direct API targets without allowing broker targets or unsafe resource URLs', () => {
    const api = { platform: 'api' as const, slug: 'drive-work', provider: 'google_api' as const, display_name: 'Work Drive',
      verification_url: 'https://www.googleapis.com/drive/v3/about?fields=user', account: job().targets[0]!.account };
    expect(isOAuthPermissionCleanupJob({ ...job(), targets: [api] })).toBe(true);
    const authorization = { id: 'b'.repeat(43), job_id: job().id, revision: 2, expires_at: 9000, app: job().app,
      requested_scopes: ['read'], target: { platform: api.platform, slug: api.slug, provider: api.provider } };
    expect(isOAuthPermissionCleanupAuthorization(authorization)).toBe(true);
    for (const patch of [{ provider: 'nango' }, { slug: 'unsafe_name' }, { account: { status: 'unknown' } },
      { verification_url: 'https://evil.test/read' }, { verification_url: 'https://www.googleapis.com/drive/v3/about?token=secret' }]) {
      expect(isOAuthPermissionCleanupJob({ ...job(), targets: [{ ...api, ...patch }] })).toBe(false);
    }
    expect(isOAuthPermissionCleanupJob({ ...job(), targets: [api, api] })).toBe(false);
  });
});

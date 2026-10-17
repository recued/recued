import { describe, expect, it, vi } from 'vitest';
import type { OAuthAppRenewalVerification, OAuthAppsResponse, SavedOAuthApp } from '@recued/contracts';
import { oauthAppRenewalShortcuts, resolveOAuthAppRenewalShortcut } from '../settings/oauth-app-renewal-shortcuts.js';
import type { OAuthAppsCaller } from '../settings/oauth-apps-panel.js';

const app = (): SavedOAuthApp => ({ issuer: 'google', id: 'default', client_id: 'client', revision: 2, label: 'Work', has_secret: true });
const result = (): OAuthAppRenewalVerification => ({ id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 2,
  app_label: 'Work', started_at: 1, finished_at: 2, status: 'completed', incomplete: false,
  results: [{ id: 'a'.repeat(64), revision: 'b'.repeat(64), label: 'Shared sign-in', connections: ['one', 'two'],
    native_accounts: [{ platform: 'mail', slug: 'work' }, { platform: 'calendar', slug: 'work' }], eligible: true, status: 'failed', reason: 'grant_rejected', current: 'yes' }] });
const selection = (index = 0) => ({ grantId: 'a'.repeat(64), index });
const caller = (v = result(), apps = [app()]) => vi.fn<OAuthAppsCaller>(async () => ({ action: 'renewal_status', apps, renewal_verification: v }));

describe('renewal repair shortcuts', () => {
  it('does not import unrelated wire fields into a native-account repair destination', async () => {
    const v = result(); v.results[0]!.connections = [];
    Object.assign(v.results[0]!.native_accounts[0]!, { kind: 'connection', name: 'unreviewed', label: 'Unexpected metadata' });
    const href = await resolveOAuthAppRenewalShortcut(caller(v), v, selection());
    expect(href).toBe('#connections/mail/work/manage-authentication/from-renewal/google/default');
    expect(oauthAppRenewalShortcuts(v, v.results[0]!)[0]).toEqual({ kind: 'collection', label: 'Re-authorize Mail: work', platform: 'mail', slug: 'work' });
  });
  it.each([null, undefined])('handles an empty wire reply with the same safe error as an invalid receipt (%s)', async value => {
    const call = vi.fn<OAuthAppsCaller>(async () => value as unknown as OAuthAppsResponse);
    await expect(resolveOAuthAppRenewalShortcut(call, result(), selection())).rejects.toThrow('could not be confirmed');
  });
  it('opens each exact shared-grant account through its existing review and preserves a verification return', async () => {
    const v = result(); const call = caller();
    expect(oauthAppRenewalShortcuts(v, v.results[0]!)).toHaveLength(4);
    for (const [index, base] of ['others/review-access/api/one', 'others/review-access/api/two', 'mail/work/manage-authentication', 'calendar/work/manage-authentication'].entries()) {
      expect(await resolveOAuthAppRenewalShortcut(call, v, selection(index))).toBe('#connections/' + base + '/from-renewal/google/default');
    }
    expect(call.mock.calls.map(([r]) => r)).toEqual(Array.from({ length: 4 }, () => ({ action: 'renewal_status', id: v.id })));
  });
  it.each(['client_rejected', 'secret_mismatch', 'origin_unknown', 'shared_grant_conflict'] as const)('routes %s to the same saved app usage review', async reason => {
    const v = result(); Object.assign(v.results[0]!, { status: reason === 'client_rejected' ? 'failed' : 'unconfirmed', reason });
    expect(oauthAppRenewalShortcuts(v, v.results[0]!)).toHaveLength(1);
    expect(await resolveOAuthAppRenewalShortcut(caller(v), v, selection())).toBe('#connections/others/oauth-apps/google/default/usage/from-renewal/google/default');
  });
  it('offers missing-refresh-token reauthorization without making the group eligible for renewal', async () => {
    const v = result(); Object.assign(v.results[0]!, { status: 'unconfirmed', reason: 'missing_grant', eligible: false });
    expect(await resolveOAuthAppRenewalShortcut(caller(v), v, selection())).toContain('/review-access/api/one/');
  });
  it.each(['no', 'unknown'] as const)('does not offer or resolve a repair when current authentication is %s', async current => {
    const v = result(); const fresh = result(); fresh.results[0]!.current = current;
    expect(oauthAppRenewalShortcuts(fresh, fresh.results[0]!)).toEqual([]);
    await expect(resolveOAuthAppRenewalShortcut(caller(fresh), v, selection())).rejects.toThrow('could not be compared');
  });
  it.each(['revision', 'reason', 'target', 'grant', 'app', 'issuer', 'receipt', 'running', 'missing-app'] as const)('blocks a changed %s instead of guessing a repair', async change => {
    const original = result(); const v = result(); const apps = [app()];
    if (change === 'revision') v.results[0]!.revision = 'c'.repeat(64);
    if (change === 'reason') v.results[0]!.reason = 'client_rejected';
    if (change === 'target') v.results[0]!.connections[0] = 'reused';
    if (change === 'grant') v.results[0]!.id = 'd'.repeat(64);
    if (change === 'app') apps[0]!.revision++;
    if (change === 'issuer') v.issuer = 'microsoft';
    if (change === 'receipt') v.id = 'renewal-12345678-1234-4123-8123-123456789abd';
    if (change === 'running') { v.status = 'checking'; delete v.finished_at; }
    if (change === 'missing-app') apps.length = 0;
    await expect(resolveOAuthAppRenewalShortcut(caller(v, apps), original, selection())).rejects.toThrow();
  });
  it('reviews the current app for verification after rotation without replaying renewal or repairing a superseded grant', async () => {
    const original = result(); const fresh = result(); fresh.results[0]!.current = 'no'; const updated = app(); updated.revision++;
    const call = caller(fresh, [updated]);
    expect(await resolveOAuthAppRenewalShortcut(call, original, 'verify')).toBe('#connections/others/oauth-apps/google/default/renewal');
    expect(call).toHaveBeenCalledExactlyOnceWith({ action: 'renewal_status', id: original.id });
  });
  it('offers no repair while running, for a passed check, or for an unrelated unconfirmed result', () => {
    for (const mode of ['running', 'passed', 'paused'] as const) {
      const v = result(); const r = v.results[0]!;
      if (mode === 'running') { v.status = 'checking'; delete v.finished_at; }
      if (mode === 'passed') { r.status = 'passed'; delete r.reason; }
      if (mode === 'paused') { r.status = 'unconfirmed'; r.reason = 'paused'; }
      expect(oauthAppRenewalShortcuts(v, r)).toEqual([]);
    }
  });
  it('keeps an unavailable or malformed status fail closed', async () => {
    const original = result(); const unavailable = vi.fn<OAuthAppsCaller>(async () => { throw Error('offline'); });
    await expect(resolveOAuthAppRenewalShortcut(unavailable, original, selection())).rejects.toThrow('could not be read');
    const malformed = caller(); malformed.mockResolvedValue({ action: 'renewal_status', apps: [app()], renewal_verification: null });
    await expect(resolveOAuthAppRenewalShortcut(malformed, original, 'verify')).rejects.toThrow('could not be confirmed');
    await expect(resolveOAuthAppRenewalShortcut(caller(), original, selection(99))).rejects.toThrow();
  });
});

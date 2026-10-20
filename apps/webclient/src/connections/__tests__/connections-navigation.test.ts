import { describe, expect, it } from 'vitest';

import {
  connectionsAccountAddress,
  connectionsAddressSelection,
  connectionsEnrollAddress,
  connectionsLaneAddress,
  parseConnectionsAddress,
  connectionsReviewAccessAddress,
  connectionsFileAuthenticationAddress, parseConnectionsFileAuthentication,
  parseConnectionsReviewAccess,
  connectionsOAuthAppsAddress, parseConnectionsOAuthApps,
  connectionsOAuthAppAddress, parseConnectionsOAuthApp, connectionsAccountAuthenticationAddress, parseConnectionsAccountAuthentication,
  connectionsRenewalRepairReturn, parseConnectionsRenewalRepairReturn,
  connectionsVerifyAccessAddress, parseConnectionsVerifyAccess,
  connectionsAccessResultAddress, parseConnectionsAccessResult, connectionsAccessRepairReturn, parseConnectionsAccessRepairReturn,
  connectionsAccessCheckAddress, parseConnectionsAccessCheck, isConnectionAccessCheckReference,
  connectionsIncidentHistoryAddress, parseConnectionsIncidentHistoryView,
} from '../connections-navigation.js';
import { parseShellRoute } from '../../shell/route.js';

describe('Connections hierarchical navigation contract', () => {
  it.each([{ kind: 'all' }, { kind: 'oauth_apps' }, { kind: 'connection', name: 'filter' }, { kind: 'group', id: 'a'.repeat(64) },
    { kind: 'collection', platform: 'calendar', slug: 'filter' }, { kind: 'file_source', source_id: 'work/files' }] as const)('round-trips a filtered history address for %j', scope => {
    const filters = { search: 'École / 100%_', type: 'verification' as const, outcome: 'failed' as const, from: '2026-10-01', through: '2026-10-17' };
    const address = connectionsIncidentHistoryAddress(scope, filters); expect(parseConnectionsIncidentHistoryView(parseShellRoute(address.hash).segments)).toEqual({ scope, filters });
    expect(parseConnectionsIncidentHistoryView(parseShellRoute(connectionsIncidentHistoryAddress(scope).hash).segments)).toEqual({ scope, filters: {} });
    expect(address.hash).not.toContain('?');
  });
  it.each(['filter', 'filter/unknown/value', 'filter/type/incident/type/repair', 'filter/type/unknown', 'filter/outcome/healthy',
    'filter/search/word/extra', 'filter/search/%0Asecret', 'filter/from/2026-02-30', 'filter/from/2026-10-17/through/2026-10-01',
    'filter/search/' + 'x'.repeat(129), 'filter/type/incident/authorize', 'connection/work/filter/type/repair/from-access/token/value'])('rejects invalid or mixed history filters: %s', tail => {
    expect(parseConnectionsIncidentHistoryView(parseShellRoute('#connections/others/incident-history/' + tail).segments)).toBeNull();
  });
  const reference = { verification_id: 'verify-12345678-1234-4123-8123-123456789abc', target_id: 'a'.repeat(64) };
  it.each(['result', 'comparison'] as const)('round-trips a saved %s page with an optional exact resource', view => {
    for (const target_id of [undefined, reference.target_id]) {
      const saved = { verification_id: reference.verification_id, view, ...(target_id ? { target_id } : {}) };
      const hash = connectionsAccessCheckAddress(saved).hash;
      expect(isConnectionAccessCheckReference(saved)).toBe(true); expect(parseConnectionsAccessCheck(parseShellRoute(hash).segments)).toEqual(saved);
      expect(hash).toBe('#connections/others/access-check/' + saved.verification_id + (target_id ? '/target/' + target_id : '') + (view === 'comparison' ? '/compare' : ''));
      for (const suffix of ['/authorize', '/compare/compare', '/from-access/' + reference.verification_id + '/' + reference.target_id]) expect(parseConnectionsAccessCheck(parseShellRoute(hash + suffix).segments)).toBeNull();
    }
  });
  it('rejects malformed saved-check identities, resources and ambiguous view tails', () => {
    const prefix = '#connections/others/access-check/';
    for (const tail of ['', 'token', 'https%3A%2F%2Fvendor.test', reference.verification_id + '/target', reference.verification_id + '/target/token',
      reference.verification_id + '/compare/target/' + reference.target_id, reference.verification_id + '/target/' + reference.target_id + '/result']) {
      expect(parseConnectionsAccessCheck(parseShellRoute(prefix + tail).segments)).toBeNull();
    }
    expect(isConnectionAccessCheckReference({ ...reference, view: 'authorize' })).toBe(false);
    expect(parseConnectionsAccessCheck(['others', 'access-result', reference.verification_id])).toBeNull();
  });
  it('routes saved results with an opaque source and exact target, without resource URLs or credentials', () => {
    const hash = connectionsAccessResultAddress(reference).hash;
    expect(parseConnectionsAccessResult(parseShellRoute(hash).segments)).toEqual(reference);
    expect(parseConnectionsAccessResult(parseShellRoute(hash + '/authorize').segments)).toBeNull();
    expect(parseConnectionsAccessResult(['others', 'access-result', 'https://vendor.test', reference.target_id])).toBeNull();
    expect(parseConnectionsAccessResult(['others', 'access-result', reference.verification_id, 'token'])).toBeNull();
  });
  it.each(['#connections/others/review-access/api/work', '#connections/mail/work/manage-authentication', '#connections/calendar/work/manage-authentication',
    '#connections/others/switch-file-authentication/api/drive', '#connections/others', '#connections/others/oauth-apps', '#connections/others/oauth-apps/google/default/usage'])('keeps a saved-result return on %s', hash => {
    const base = parseShellRoute(hash).segments;
    const full = connectionsAccessRepairReturn(hash, reference);
    expect(parseConnectionsAccessRepairReturn(parseShellRoute(full).segments)).toEqual({ segments: base, reference });
    expect(parseConnectionsAccessRepairReturn(parseShellRoute(full + '/authorize').segments)).toBeNull();
    expect(parseConnectionsAccessRepairReturn(parseShellRoute(full + '/from-access/' + reference.verification_id + '/' + reference.target_id).segments)).toBeNull();
  });
  it('rejects unsupported destinations, mixed return contexts and invalid identities', () => {
    const suffix = '/from-access/' + reference.verification_id + '/' + reference.target_id;
    for (const hash of ['#connections/others/enroll/google' + suffix, '#connections/mail/work' + suffix,
      '#connections/others/review-access/api/work/from-renewal/google/default' + suffix,
      '#connections/others/review-access/api/work/from-access/token/' + reference.target_id,
      '#connections/others/review-access/api/work/from-access/' + reference.verification_id + '/https%3A%2F%2Fvendor.test']) {
      expect(parseConnectionsAccessRepairReturn(parseShellRoute(hash).segments)).toBeNull();
    }
  });
  it('routes a recheck using only its retained access-result identity', () => {
    const selection = { kind: 'verification' as const, id: 'verify-12345678-1234-4123-8123-123456789abc' };
    const hash = connectionsVerifyAccessAddress(selection).hash;
    expect(parseConnectionsVerifyAccess(parseShellRoute(hash).segments)).toEqual(selection);
    expect(parseConnectionsVerifyAccess(parseShellRoute(hash + '/target').segments)).toBeNull();
    expect(parseConnectionsVerifyAccess(['others', 'verify-access', 'verification', 'https://vendor.test'])).toBeNull();
  });
  it('routes Verify access with a typed opaque selection and rejects resource or credential tails', () => {
    const selection = { kind: 'renewal' as const, id: 'renewal-12345678-1234-4123-8123-123456789abc' };
    const hash = connectionsVerifyAccessAddress(selection).hash;
    expect(hash).toBe('#connections/others/verify-access/renewal/' + selection.id);
    expect(parseConnectionsVerifyAccess(parseShellRoute(hash).segments)).toEqual(selection);
    expect(parseConnectionsAddress(parseShellRoute(hash))).toEqual({ kind: 'lane', tab: 'others' });
    for (const bad of [hash + '/scope', hash + '/https://vendor.test', '#connections/mail/verify-access/renewal/' + selection.id,
      '#connections/others/verify-access/renewal/../secret', '#connections/others/verify-access/unknown/' + selection.id]) {
      expect(parseConnectionsVerifyAccess(parseShellRoute(bad).segments)).toBeNull();
    }
  });
  it('selects only a named saved app and a local usage or renewal review', () => {
    for (const view of ['usage', 'renewal'] as const) {
      const target = { issuer: 'microsoft' as const, id: 'default', view };
      const hash = connectionsOAuthAppAddress(target).hash;
      expect(parseConnectionsOAuthApp(parseShellRoute(hash).segments)).toEqual(target);
      expect(parseConnectionsAddress(parseShellRoute(hash))).toEqual({ kind: 'lane', tab: 'others' });
    }
    for (const segments of [['others','oauth-apps','google','../client','usage'], ['others','oauth-apps','Google','default','usage'],
      ['others','oauth-apps','google','default','authorize'], ['others','oauth-apps','google','default','usage','secret']]) {
      expect(parseConnectionsOAuthApp(segments)).toBeNull();
    }
  });
  it('opens account authentication and returns to renewal without accepting credentials or permission tails', () => {
    const base = connectionsAccountAuthenticationAddress('mail', 'work').hash;
    expect(parseConnectionsAccountAuthentication(parseShellRoute(base).segments)).toEqual({ platform: 'mail', slug: 'work' });
    const hash = connectionsRenewalRepairReturn(base, 'google', 'default');
    expect(parseConnectionsRenewalRepairReturn(parseShellRoute(hash).segments)).toEqual({ segments: ['mail','work','manage-authentication'],
      app: { issuer: 'google', id: 'default', view: 'renewal' } });
    for (const segments of [['file','work','manage-authentication'], ['mail','../work','manage-authentication'], ['mail','work','manage-authentication','scope']]) {
      expect(parseConnectionsAccountAuthentication(segments)).toBeNull();
    }
    for (const invalid of ['#connections/mail/work/from-renewal/google/default', hash + '/secret',
      '#connections/others/oauth-apps/google/default/usage/from-renewal/microsoft/default',
      '#connections/others/review-access/api/work/from-renewal/google/client-id']) {
      expect(parseConnectionsRenewalRepairReturn(parseShellRoute(invalid).segments)).toBeNull();
    }
    expect(parseConnectionsRenewalRepairReturn(parseShellRoute(connectionsRenewalRepairReturn(connectionsReviewAccessAddress('work').hash, 'google', 'default')).segments)?.segments)
      .toEqual(['others','review-access','api','work']);
  });
  it('opens only the saved-app manager without importing credentials or a callback from the route', () => {
    const address = connectionsOAuthAppsAddress(); expect(address.hash).toBe('#connections/others/oauth-apps');
    expect(parseConnectionsOAuthApps(parseShellRoute(address.hash).segments)).toBe(true);
    expect(parseConnectionsAddress(parseShellRoute(address.hash))).toEqual({ kind: 'lane', tab: 'others' });
    for (const parts of [['mail', 'oauth-apps'], ['others', 'oauth-apps', 'secret'], ['others', 'enroll']]) expect(parseConnectionsOAuthApps(parts)).toBe(false);
  });
  it('routes an exact saved-account review without importing a URL or scope from the route', () => {
    const address = connectionsReviewAccessAddress('sheets-work');
    expect(address.hash).toBe('#connections/others/review-access/api/sheets-work');
    expect(parseConnectionsReviewAccess(parseShellRoute(address.hash).segments)).toEqual({ name: 'sheets-work' });
    expect(parseConnectionsAddress(parseShellRoute(address.hash))).toEqual({ kind: 'lane', tab: 'others' });
    for (const parts of [['others', 'review-access', 'api', '../bad'], ['others', 'review-access', 'mcp', 'main'],
      ['others', 'review-access', 'api', 'main', 'scopes']]) expect(parseConnectionsReviewAccess(parts)).toBeNull();
  });
  it('routes file migration with only a validated saved connection name', () => {
    const address = connectionsFileAuthenticationAddress('work-drive');
    expect(address.hash).toBe('#connections/others/switch-file-authentication/api/work-drive');
    expect(parseConnectionsFileAuthentication(parseShellRoute(address.hash).segments)).toEqual({ name: 'work-drive' });
    expect(parseConnectionsAddress(parseShellRoute(address.hash))).toEqual({ kind: 'lane', tab: 'others' });
    for (const parts of [['others','switch-file-authentication','api','../bad'],['others','switch-file-authentication','mcp','work'],['others','switch-file-authentication','api','work','secret']]) {
      expect(parseConnectionsFileAuthentication(parts)).toBeNull();
    }
  });
  it('models lane -> account depth', () => {
    expect(connectionsLaneAddress('mail').hash).toBe('#connections/mail');
    expect(connectionsAccountAddress('mail', 'work/mail').hash)
      .toBe('#connections/mail/work%2Fmail');
    expect(connectionsAccountAddress('mail', 'work/mail').levels.map((level) => level.key))
      .toEqual(['connections-lane:mail', 'connections-account:work/mail']);
  });

  it('models the routed enrollment workspace without treating it as an account', () => {
    expect(connectionsEnrollAddress('google/calendar').hash)
      .toBe('#connections/others/enroll/google%2Fcalendar');
    expect(parseConnectionsAddress(parseShellRoute(
      '#connections/others/enroll/google%2Fcalendar',
    ))).toEqual({
      kind: 'enroll',
      vendor: 'google/calendar',
    });
  });

  it('parses account detail and degrades unknown tails to their lane', () => {
    expect(parseConnectionsAddress(parseShellRoute('#connections/file/archive')))
      .toEqual({ kind: 'account', lane: 'file', slug: 'archive' });
    expect(parseConnectionsAddress(parseShellRoute(
      '#connections/others/retry-credential-rotation/api/main',
    ))).toEqual({ kind: 'lane', tab: 'others' });
    expect(parseConnectionsAddress(parseShellRoute('#connections/unknown')))
      .toEqual({ kind: 'lane', tab: 'mail' });
  });

  it('round-trips pack and slot context while keeping the API URL out of the route', () => {
    const pack = { slug: 'google-sheets', slot: 'google' };
    const address = connectionsEnrollAddress('google', pack);
    expect(address.hash).toBe('#connections/others/enroll/google/pack/google-sheets/google');
    expect(parseConnectionsAddress(parseShellRoute(address.hash))).toEqual({ kind: 'enroll', vendor: 'google', pack });
  });

  it('projects one typed selection for route bootstrap', () => {
    expect(connectionsAddressSelection({
      kind: 'account',
      lane: 'calendar',
      slug: 'team',
    })).toEqual({
      tab: 'calendar',
      detailSlug: 'team',
      enrollVendor: null,
    });
  });
});

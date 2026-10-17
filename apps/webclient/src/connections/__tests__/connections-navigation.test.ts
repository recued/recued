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
} from '../connections-navigation.js';
import { parseShellRoute } from '../../shell/route.js';

describe('Connections hierarchical navigation contract', () => {
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

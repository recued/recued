/** SMB-finance wedge slice 1b — QuickBooks Online vendor provider.
 *
 *  QBO joins CONNECTION_VENDOR_PROVIDERS with a realm-path base composition
 *  (`realm_base` + `composeRealmBaseUrl`) instead of Salesforce's
 *  instance_url-in-token-response. It SHARES one OAuth authorize/token URL
 *  across sandbox + production (no sandbox OAuth-URL split). */

import { describe, expect, it } from 'vitest';
import {
  CONNECTION_VENDOR_PROVIDERS,
  getVendorProvider,
  resolveVendorOAuthEndpoints,
  composeRealmBaseUrl,
  assertConnectionVendorProviderRegistry,
  assertConnectionVendorProviderShape,
  QUICKBOOKS_OAUTH_AUTHORIZE_URL,
  QUICKBOOKS_OAUTH_TOKEN_URL,
  QUICKBOOKS_OAUTH_SCOPES,
  QUICKBOOKS_API_BASE_PRODUCTION,
  QUICKBOOKS_API_BASE_SANDBOX,
  type ConnectionVendorProvider,
} from '../index.js';

describe('SMB-finance slice 1b — QuickBooks provider', () => {
  const qbo = getVendorProvider('quickbooks');

  it('is registered + passes the registry shape check', () => {
    expect(qbo).not.toBeNull();
    expect(CONNECTION_VENDOR_PROVIDERS.map((p) => p.vendor)).toContain('quickbooks');
    expect(assertConnectionVendorProviderRegistry(CONNECTION_VENDOR_PROVIDERS)).toEqual([]);
  });

  it('uses the Intuit OAuth endpoints + accounting scope', () => {
    expect(qbo!.oauth.authorize_url).toBe(QUICKBOOKS_OAUTH_AUTHORIZE_URL);
    expect(qbo!.oauth.token_endpoint).toBe(QUICKBOOKS_OAUTH_TOKEN_URL);
    expect(qbo!.oauth.scopes).toEqual(QUICKBOOKS_OAUTH_SCOPES);
    expect(QUICKBOOKS_OAUTH_SCOPES).toContain('com.intuit.quickbooks.accounting');
    expect(qbo!.oauth.client_secret_required).toBe(true);
  });

  it('shares ONE OAuth URL across environments (no sandbox OAuth-URL split)', () => {
    expect(qbo!.oauth.sandbox_authorize_url).toBeUndefined();
    expect(qbo!.oauth.sandbox_token_endpoint).toBeUndefined();
    // resolve returns production URLs regardless of the sandbox flag.
    expect(resolveVendorOAuthEndpoints(qbo!, { sandbox: true })).toEqual({
      authorize_url: QUICKBOOKS_OAUTH_AUTHORIZE_URL,
      token_endpoint: QUICKBOOKS_OAUTH_TOKEN_URL,
    });
  });

  it('declares realm_base (the sandbox split is the API HOST, not OAuth)', () => {
    expect(qbo!.realm_base).toEqual({
      production: QUICKBOOKS_API_BASE_PRODUCTION,
      sandbox: QUICKBOOKS_API_BASE_SANDBOX,
      path_template: '/v3/company/{realm_id}',
    });
  });
});

describe('composeRealmBaseUrl', () => {
  const qbo = getVendorProvider('quickbooks')!;

  it('composes the production base from a realm id', () => {
    expect(composeRealmBaseUrl(qbo, '9341457273016687', false)).toBe(
      'https://quickbooks.api.intuit.com/v3/company/9341457273016687',
    );
  });

  it('composes the sandbox base when sandbox=true', () => {
    expect(composeRealmBaseUrl(qbo, '9341457273016687', true)).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9341457273016687',
    );
  });

  it('url-encodes the realm id', () => {
    expect(composeRealmBaseUrl(qbo, 'a b/c', false)).toBe(
      'https://quickbooks.api.intuit.com/v3/company/a%20b%2Fc',
    );
  });

  it('returns null for an empty realm id', () => {
    expect(composeRealmBaseUrl(qbo, '', true)).toBeNull();
  });

  it('returns null for a provider without realm_base (e.g. hubspot)', () => {
    const hs = getVendorProvider('hubspot')!;
    expect(hs.realm_base).toBeUndefined();
    expect(composeRealmBaseUrl(hs, '123', false)).toBeNull();
  });
});

describe('realm_base validation', () => {
  const base = getVendorProvider('quickbooks')!;
  const withRealm = (rb: unknown): ConnectionVendorProvider =>
    ({ ...base, realm_base: rb as ConnectionVendorProvider['realm_base'] });

  it('accepts the QuickBooks realm_base', () => {
    expect(assertConnectionVendorProviderShape(base)).toEqual([]);
  });

  it('rejects non-https hosts + a path_template missing {realm_id}', () => {
    const issues = assertConnectionVendorProviderShape(
      withRealm({ production: 'http://x', sandbox: 'ftp://y', path_template: '/v3/company/123' }),
    );
    expect(issues.some((i) => i.includes('realm_base.production'))).toBe(true);
    expect(issues.some((i) => i.includes('realm_base.sandbox'))).toBe(true);
    expect(issues.some((i) => i.includes('{realm_id}'))).toBe(true);
  });
});

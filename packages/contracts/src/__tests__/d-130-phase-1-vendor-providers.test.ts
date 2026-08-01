/** D-130 Phase 1 — Salesforce vendor provider registry tests.
 *
 *  Covers:
 *  - `CONNECTION_VENDOR_PROVIDERS` ships HubSpot + Salesforce at D-130.
 *  - Salesforce constants surface the correct OAuth scopes, sandbox-
 *    paired URL pairs, signature-header marker, and version pin.
 *  - `resolveVendorOAuthEndpoints` resolves the correct URL pair per
 *    sandbox flag — both `boolean` and `'sandbox' | 'production'`
 *    string forms supported.
 *  - HubSpot (no sandbox split) falls through to production
 *    regardless of the flag — vendors without sandbox URLs ignore
 *    the flag.
 *  - Validator catches: paired-sandbox-URL rule (both or neither),
 *    https-only on sandbox URLs.
 *  - `getVendorProvider('salesforce')` resolves D-130's new entry. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_SANDBOX_FLAG_VALUES,
  CONNECTION_VENDOR_PROVIDERS,
  HUBSPOT_OAUTH_TOKEN_URL,
  SALESFORCE_API_VERSION,
  SALESFORCE_API_BASE_PLACEHOLDER,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
  SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION,
  SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX,
  SALESFORCE_OAUTH_SCOPES,
  SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
  SALESFORCE_WEBHOOK_SIGNATURE_HEADER,
  assertConnectionVendorProviderRegistry,
  assertConnectionVendorProviderShape,
  getVendorProvider,
  resolveVendorOAuthEndpoints,
  type ConnectionVendorProvider,
} from '../index.js';

const validSalesforce = (): ConnectionVendorProvider => ({
  vendor: 'salesforce',
  display_name: 'Salesforce',
  description: 'CRM platform.',
  default_base_url: SALESFORCE_API_BASE_PLACEHOLDER,
  oauth: {
    authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION,
    token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
    sandbox_authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX,
    sandbox_token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
    scopes: SALESFORCE_OAUTH_SCOPES,
    client_secret_required: true,
  },
  webhook_signature_header: SALESFORCE_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
});

describe('D-130 P1 — CONNECTION_VENDOR_PROVIDERS gains Salesforce', () => {
  it('ships HubSpot + Salesforce (the D-130 vendors; later wedges append more, e.g. quickbooks)', () => {
    const segments = CONNECTION_VENDOR_PROVIDERS.map((p) => p.vendor);
    expect(segments).toContain('hubspot');
    expect(segments).toContain('salesforce');
  });

  it('passes the registry-level shape check', () => {
    expect(assertConnectionVendorProviderRegistry(CONNECTION_VENDOR_PROVIDERS)).toEqual([]);
  });

  it('preserves HubSpot ahead of Salesforce in insertion order', () => {
    expect(CONNECTION_VENDOR_PROVIDERS[0].vendor).toBe('hubspot');
    expect(CONNECTION_VENDOR_PROVIDERS[1].vendor).toBe('salesforce');
  });
});

describe('D-130 P1 — Salesforce constants', () => {
  it('declares the launch-required OAuth scopes', () => {
    expect(SALESFORCE_OAUTH_SCOPES).toEqual(['api', 'refresh_token', 'offline_access']);
  });

  it('uses login.salesforce.com for production OAuth', () => {
    expect(SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION).toBe(
      'https://login.salesforce.com/services/oauth2/authorize',
    );
    expect(SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION).toBe(
      'https://login.salesforce.com/services/oauth2/token',
    );
  });

  it('uses test.salesforce.com for sandbox OAuth', () => {
    expect(SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX).toBe(
      'https://test.salesforce.com/services/oauth2/authorize',
    );
    expect(SALESFORCE_OAUTH_TOKEN_URL_SANDBOX).toBe(
      'https://test.salesforce.com/services/oauth2/token',
    );
  });

  it('signature header is the CometD documentation marker — Salesforce never receives a signed POST', () => {
    expect(SALESFORCE_WEBHOOK_SIGNATURE_HEADER).toBe('X-Salesforce-Streaming-CometD');
  });

  it('default cadence matches D-128 PLATFORM_REFERENCE_DEFAULT_CADENCE', () => {
    expect(SALESFORCE_DEFAULT_RECONCILIATION_CADENCE).toBe('6h');
  });

  it('API version pinned at v60.0', () => {
    expect(SALESFORCE_API_VERSION).toBe('v60.0');
  });

  it('base URL placeholder is the production OAuth host (re-used pre-OAuth in the form)', () => {
    expect(SALESFORCE_API_BASE_PLACEHOLDER).toBe('https://login.salesforce.com');
  });
});

describe('D-130 P1 — CONNECTION_SANDBOX_FLAG_VALUES', () => {
  it('exposes the closed list of sandbox-flag string values', () => {
    expect(CONNECTION_SANDBOX_FLAG_VALUES).toEqual(['production', 'sandbox']);
  });
});

describe('D-130 P1 — getVendorProvider for salesforce', () => {
  it('returns the Salesforce entry', () => {
    const p = getVendorProvider('salesforce');
    expect(p).not.toBeNull();
    expect(p!.vendor).toBe('salesforce');
    expect(p!.display_name).toBe('Salesforce');
  });

  it('Salesforce entry carries both production + sandbox URL pairs', () => {
    const p = getVendorProvider('salesforce')!;
    expect(p.oauth.authorize_url).toBe(SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION);
    expect(p.oauth.token_endpoint).toBe(SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION);
    expect(p.oauth.sandbox_authorize_url).toBe(SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX);
    expect(p.oauth.sandbox_token_endpoint).toBe(SALESFORCE_OAUTH_TOKEN_URL_SANDBOX);
  });
});

describe('D-130 P1 — resolveVendorOAuthEndpoints', () => {
  it('Salesforce + sandbox=true picks the sandbox URL pair', () => {
    const p = getVendorProvider('salesforce')!;
    expect(resolveVendorOAuthEndpoints(p, { sandbox: true })).toEqual({
      authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX,
      token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
    });
  });

  it('Salesforce + sandbox="sandbox" string also picks the sandbox URL pair', () => {
    const p = getVendorProvider('salesforce')!;
    expect(resolveVendorOAuthEndpoints(p, { sandbox: 'sandbox' })).toEqual({
      authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX,
      token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
    });
  });

  it('Salesforce + sandbox=false picks the production URL pair', () => {
    const p = getVendorProvider('salesforce')!;
    expect(resolveVendorOAuthEndpoints(p, { sandbox: false })).toEqual({
      authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION,
      token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
    });
  });

  it('Salesforce + sandbox="production" string picks the production URL pair', () => {
    const p = getVendorProvider('salesforce')!;
    expect(resolveVendorOAuthEndpoints(p, { sandbox: 'production' })).toEqual({
      authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION,
      token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
    });
  });

  it('Salesforce + omitted sandbox flag defaults to production', () => {
    const p = getVendorProvider('salesforce')!;
    expect(resolveVendorOAuthEndpoints(p)).toEqual({
      authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION,
      token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
    });
  });

  it('HubSpot ignores the sandbox flag — no sandbox URL pair, falls through to production', () => {
    const p = getVendorProvider('hubspot')!;
    expect(resolveVendorOAuthEndpoints(p, { sandbox: true })).toEqual({
      authorize_url: p.oauth.authorize_url,
      token_endpoint: HUBSPOT_OAUTH_TOKEN_URL,
    });
    expect(resolveVendorOAuthEndpoints(p, { sandbox: 'sandbox' })).toEqual({
      authorize_url: p.oauth.authorize_url,
      token_endpoint: HUBSPOT_OAUTH_TOKEN_URL,
    });
  });
});

describe('D-130 P1 — assertConnectionVendorProviderShape sandbox rules', () => {
  it('passes a Salesforce-shaped entry with both sandbox URLs set', () => {
    expect(assertConnectionVendorProviderShape(validSalesforce())).toEqual([]);
  });

  it('rejects sandbox_authorize_url without sandbox_token_endpoint', () => {
    const broken = validSalesforce();
    delete (broken.oauth as { sandbox_token_endpoint?: string }).sandbox_token_endpoint;
    const issues = assertConnectionVendorProviderShape(broken);
    expect(issues.join(';')).toContain(
      'oauth.sandbox_authorize_url and oauth.sandbox_token_endpoint must be set together',
    );
  });

  it('rejects sandbox_token_endpoint without sandbox_authorize_url', () => {
    const broken = validSalesforce();
    delete (broken.oauth as { sandbox_authorize_url?: string }).sandbox_authorize_url;
    const issues = assertConnectionVendorProviderShape(broken);
    expect(issues.join(';')).toContain(
      'oauth.sandbox_authorize_url and oauth.sandbox_token_endpoint must be set together',
    );
  });

  it('requires https on sandbox_authorize_url', () => {
    const httpAuth = validSalesforce();
    httpAuth.oauth = {
      ...httpAuth.oauth,
      sandbox_authorize_url: 'http://test.salesforce.com/services/oauth2/authorize',
    };
    expect(assertConnectionVendorProviderShape(httpAuth).join(';')).toContain(
      'oauth.sandbox_authorize_url must be a complete HTTPS URL',
    );
  });

  it('requires https on sandbox_token_endpoint', () => {
    const httpToken = validSalesforce();
    httpToken.oauth = {
      ...httpToken.oauth,
      sandbox_token_endpoint: 'http://test.salesforce.com/services/oauth2/token',
    };
    expect(assertConnectionVendorProviderShape(httpToken).join(';')).toContain(
      'oauth.sandbox_token_endpoint must be a complete HTTPS URL',
    );
  });

  it('omitting both sandbox URLs is valid (HubSpot shape)', () => {
    const noSandbox = validSalesforce();
    delete (noSandbox.oauth as { sandbox_authorize_url?: string }).sandbox_authorize_url;
    delete (noSandbox.oauth as { sandbox_token_endpoint?: string }).sandbox_token_endpoint;
    expect(assertConnectionVendorProviderShape(noSandbox)).toEqual([]);
  });
});

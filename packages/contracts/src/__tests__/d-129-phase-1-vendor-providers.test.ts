/** D-129 Phase 1 — Connection vendor provider registry tests.
 *
 *  Covers:
 *  - `CONNECTION_VENDOR_PROVIDERS` ships HubSpot at D-129.
 *  - `getVendorProvider` / `listVendorProviders` semantics.
 *  - `assertConnectionVendorProviderShape` rejects malformed entries
 *    across every shape rule (vendor regex, https-only URLs, scope
 *    list non-empty, cadence enum).
 *  - `assertConnectionVendorProviderRegistry` catches duplicates +
 *    folds per-entry issues with vendor prefix.
 *  - HubSpot constants surface the correct OAuth scopes + endpoint
 *    URLs spec § Constants nails down. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_PROVIDERS,
  HUBSPOT_API_BASE,
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  HUBSPOT_OAUTH_AUTHORIZE_URL,
  HUBSPOT_OAUTH_SCOPES,
  HUBSPOT_OAUTH_TOKEN_URL,
  HUBSPOT_WEBHOOK_SIGNATURE_HEADER,
  PIPEDRIVE_API_BASE,
  PIPEDRIVE_DEFAULT_RECONCILIATION_CADENCE,
  PIPEDRIVE_OAUTH_AUTHORIZE_URL,
  PIPEDRIVE_OAUTH_SCOPES,
  PIPEDRIVE_OAUTH_TOKEN_URL,
  PIPEDRIVE_WEBHOOK_SIGNATURE_HEADER,
  assertConnectionVendorProviderRegistry,
  assertConnectionVendorProviderShape,
  assertConnectionVendorProviderValid,
  buildGenericVendorProvider,
  GENERIC_OAUTH_VENDOR,
  getVendorProvider,
  listVendorProviders,
  resolveVendorOAuthEndpoints,
  type ConnectionVendorProvider,
} from '../index.js';

const validHubSpot = (): ConnectionVendorProvider => ({
  vendor: 'hubspot',
  display_name: 'HubSpot',
  description: 'CRM platform.',
  default_base_url: HUBSPOT_API_BASE,
  oauth: {
    authorize_url: HUBSPOT_OAUTH_AUTHORIZE_URL,
    token_endpoint: HUBSPOT_OAUTH_TOKEN_URL,
    scopes: HUBSPOT_OAUTH_SCOPES,
    client_secret_required: true,
  },
  webhook_signature_header: HUBSPOT_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
});

describe('D-129 P1 — CONNECTION_VENDOR_PROVIDERS default', () => {
  it('ships HubSpot first; D-130 widens to a second entry (Salesforce)', () => {
    expect(CONNECTION_VENDOR_PROVIDERS.length).toBeGreaterThanOrEqual(1);
    expect(CONNECTION_VENDOR_PROVIDERS[0].vendor).toBe('hubspot');
  });

  it('passes the registry-level shape check', () => {
    expect(assertConnectionVendorProviderRegistry(CONNECTION_VENDOR_PROVIDERS)).toEqual([]);
  });

  it('listVendorProviders returns the registry in insertion order', () => {
    expect(listVendorProviders()).toEqual(CONNECTION_VENDOR_PROVIDERS);
  });
});

describe('D-129 P1 — HubSpot constants', () => {
  it('declares all read scopes the launch sequence calls out', () => {
    expect(HUBSPOT_OAUTH_SCOPES).toEqual([
      'crm.objects.deals.read',
      'crm.objects.contacts.read',
      'crm.objects.companies.read',
      'crm.schemas.deals.read',
      'crm.schemas.contacts.read',
      'crm.schemas.companies.read',
      'oauth',
    ]);
  });

  it('uses production HubSpot OAuth endpoints (not sandbox / EU variant)', () => {
    expect(HUBSPOT_OAUTH_AUTHORIZE_URL).toBe('https://app.hubspot.com/oauth/authorize');
    expect(HUBSPOT_OAUTH_TOKEN_URL).toBe('https://api.hubapi.com/oauth/v1/token');
    expect(HUBSPOT_API_BASE).toBe('https://api.hubapi.com');
  });

  it('signature header pinned to v3 — v1 + v2 are deprecated', () => {
    expect(HUBSPOT_WEBHOOK_SIGNATURE_HEADER).toBe('X-HubSpot-Signature-v3');
  });

  it('default cadence matches D-128 PLATFORM_REFERENCE_DEFAULT_CADENCE', () => {
    expect(HUBSPOT_DEFAULT_RECONCILIATION_CADENCE).toBe('6h');
  });
});

describe('D-129 P1 — getVendorProvider', () => {
  it('returns the HubSpot entry for vendor=hubspot', () => {
    const p = getVendorProvider('hubspot');
    expect(p).not.toBeNull();
    expect(p!.vendor).toBe('hubspot');
    expect(p!.display_name).toBe('HubSpot');
  });

  it('returns the Pipedrive entry for vendor=pipedrive', () => {
    const p = getVendorProvider('pipedrive');
    expect(p).not.toBeNull();
    expect(p!.vendor).toBe('pipedrive');
    expect(p!.display_name).toBe('Pipedrive');
  });

  it('returns null for unknown vendors', () => {
    expect(getVendorProvider('unknownvendor')).toBeNull();
    expect(getVendorProvider('nonsense')).toBeNull();
    expect(getVendorProvider('')).toBeNull();
  });

  it('honors a caller-supplied registry override', () => {
    const customEntry = { ...validHubSpot(), vendor: 'pipedrive' };
    expect(getVendorProvider('pipedrive', [customEntry])?.vendor).toBe('pipedrive');
    expect(getVendorProvider('hubspot', [customEntry])).toBeNull();
  });
});

describe('Pipedrive provider constants', () => {
  it('declares OAuth endpoints, scopes, base URL, and webhook verification marker', () => {
    expect(PIPEDRIVE_OAUTH_SCOPES).toEqual([
      'base',
      'deals:read',
      'deals:full',
      'contacts:read',
    ]);
    expect(PIPEDRIVE_OAUTH_AUTHORIZE_URL).toBe('https://oauth.pipedrive.com/oauth/authorize');
    expect(PIPEDRIVE_OAUTH_TOKEN_URL).toBe('https://oauth.pipedrive.com/oauth/token');
    expect(PIPEDRIVE_API_BASE).toBe('https://api.pipedrive.com');
    expect(PIPEDRIVE_WEBHOOK_SIGNATURE_HEADER).toBe('Authorization');
    expect(PIPEDRIVE_DEFAULT_RECONCILIATION_CADENCE).toBe('6h');
    expect(getVendorProvider('pipedrive')!.oauth.token_auth_style).toBe('basic');
  });
});

describe('D-129 P1 — assertConnectionVendorProviderShape', () => {
  it('passes a valid entry', () => {
    expect(assertConnectionVendorProviderShape(validHubSpot())).toEqual([]);
  });

  it('rejects vendor segments that violate the regex', () => {
    const badEntry = { ...validHubSpot(), vendor: 'HubSpot' };
    const issues = assertConnectionVendorProviderShape(badEntry);
    expect(issues).toContain("vendor must match /^[a-z][a-z0-9_]*$/: 'HubSpot'");
  });

  it('rejects vendor segments starting with a digit', () => {
    const badEntry = { ...validHubSpot(), vendor: '1pass' };
    const issues = assertConnectionVendorProviderShape(badEntry);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects empty display_name + description', () => {
    const noLabel = { ...validHubSpot(), display_name: '' };
    expect(assertConnectionVendorProviderShape(noLabel)).toContain('display_name must be non-empty');
    const noDesc = { ...validHubSpot(), description: '' };
    expect(assertConnectionVendorProviderShape(noDesc)).toContain('description must be non-empty');
  });

  it('requires https URLs across base + OAuth endpoints', () => {
    const httpBase = { ...validHubSpot(), default_base_url: 'http://api.hubapi.com' };
    expect(assertConnectionVendorProviderShape(httpBase)).toContain(
      "default_base_url must be https://: 'http://api.hubapi.com'",
    );
    const httpAuth = {
      ...validHubSpot(),
      oauth: { ...validHubSpot().oauth, authorize_url: 'http://app.hubspot.com/oauth/authorize' },
    };
    expect(assertConnectionVendorProviderShape(httpAuth).join(';')).toContain(
      'oauth.authorize_url must be a complete HTTPS URL',
    );
    const httpToken = {
      ...validHubSpot(),
      oauth: { ...validHubSpot().oauth, token_endpoint: 'http://api.hubapi.com/oauth/v1/token' },
    };
    expect(assertConnectionVendorProviderShape(httpToken).join(';')).toContain(
      'oauth.token_endpoint must be a complete HTTPS URL',
    );
    const embeddedCredentials = {
      ...validHubSpot(),
      oauth: {
        ...validHubSpot().oauth,
        token_endpoint: 'https://owner:password@api.hubapi.com/oauth/v1/token',
      },
    };
    const embeddedCredentialIssues = assertConnectionVendorProviderShape(embeddedCredentials)
      .join(';');
    expect(embeddedCredentialIssues).toContain(
      'oauth.token_endpoint must be a complete HTTPS URL',
    );
    expect(embeddedCredentialIssues).not.toContain('owner:password');
    const fragmentAuthorize = {
      ...validHubSpot(),
      oauth: {
        ...validHubSpot().oauth,
        authorize_url: 'https://app.hubspot.com/oauth/authorize#ignored',
      },
    };
    expect(assertConnectionVendorProviderShape(fragmentAuthorize).join(';')).toContain(
      'oauth.authorize_url must be a complete HTTPS URL',
    );
  });

  it('rejects an empty scope list', () => {
    const noScopes = {
      ...validHubSpot(),
      oauth: { ...validHubSpot().oauth, scopes: [] as readonly string[] },
    };
    expect(assertConnectionVendorProviderShape(noScopes)).toContain('oauth.scopes must be non-empty');
  });

  it('rejects scope entries that are empty strings', () => {
    const blankScope = {
      ...validHubSpot(),
      oauth: { ...validHubSpot().oauth, scopes: ['oauth', ''] as readonly string[] },
    };
    expect(assertConnectionVendorProviderShape(blankScope)).toContain(
      'oauth.scopes entries must be non-empty strings',
    );
  });

  it('rejects empty webhook signature header', () => {
    const noHeader = { ...validHubSpot(), webhook_signature_header: '' };
    expect(assertConnectionVendorProviderShape(noHeader)).toContain(
      'webhook_signature_header must be non-empty',
    );
  });

  it('rejects out-of-enum default_cadence values', () => {
    const badCadence = { ...validHubSpot(), default_cadence: '5m' as '1h' };
    const issues = assertConnectionVendorProviderShape(badCadence);
    expect(issues.join(';')).toContain("default_cadence must be one of '1h' | '6h' | '24h'");
  });

  it('accepts each cadence value in the allowed enum', () => {
    for (const cadence of ['1h', '6h', '24h'] as const) {
      const entry = { ...validHubSpot(), default_cadence: cadence };
      expect(assertConnectionVendorProviderShape(entry)).toEqual([]);
    }
  });
});

describe('D-129 P1 — assertConnectionVendorProviderValid', () => {
  it('throws on malformed entries with vendor name in the message', () => {
    const badEntry = { ...validHubSpot(), vendor: 'BadName' };
    expect(() => assertConnectionVendorProviderValid(badEntry)).toThrow(/'BadName'/);
  });

  it('does not throw on valid entries', () => {
    expect(() => assertConnectionVendorProviderValid(validHubSpot())).not.toThrow();
  });
});

describe('D-129 P1 — assertConnectionVendorProviderRegistry', () => {
  it('returns empty for a single-valid-entry registry', () => {
    expect(assertConnectionVendorProviderRegistry([validHubSpot()])).toEqual([]);
  });

  it('catches duplicate vendor segments', () => {
    const dup = [validHubSpot(), validHubSpot()];
    const issues = assertConnectionVendorProviderRegistry(dup);
    expect(issues).toContain("duplicate vendor segment: 'hubspot'");
  });

  it('Salesforce no longer reads as an unknown vendor (added in D-130)', () => {
    expect(getVendorProvider('salesforce')).not.toBeNull();
  });

  it('prefixes per-entry shape issues with the vendor segment', () => {
    const broken = { ...validHubSpot(), display_name: '' };
    const issues = assertConnectionVendorProviderRegistry([broken]);
    expect(issues).toContain('hubspot: display_name must be non-empty');
  });
});

describe('R14 — buildGenericVendorProvider (form-supplied OAuth)', () => {
  it('synthesizes a minimal provider from the typed authorize/token/scopes', () => {
    const p = buildGenericVendorProvider({
      authorize_url: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/oauth/token',
      scopes: ['read', 'write'],
    });
    expect(p.oauth.authorize_url).toBe('https://auth.example.com/authorize');
    expect(p.oauth.token_endpoint).toBe('https://auth.example.com/oauth/token');
    expect(p.oauth.scopes).toEqual(['read', 'write']);
    // No secret requirement (BYO public clients), no sandbox / PKCE / realm.
    expect(p.oauth.client_secret_required).toBe(false);
    expect(p.oauth.supports_pkce).toBeUndefined();
    expect(p.realm_base).toBeUndefined();
    expect(p.vendor).toBe(GENERIC_OAUTH_VENDOR);
  });

  it('keeps a caller-supplied vendor label and never collides with the registry', () => {
    const p = buildGenericVendorProvider({
      authorize_url: 'https://a/x',
      token_endpoint: 'https://a/t',
      scopes: [],
      vendor: 'my-thing',
    });
    expect(p.vendor).toBe('my-thing');
    // The generic slug + a free label both resolve to nothing in the registry.
    expect(getVendorProvider(GENERIC_OAUTH_VENDOR)).toBeNull();
    expect(getVendorProvider('my-thing')).toBeNull();
  });

  it('resolveVendorOAuthEndpoints returns the form endpoints regardless of sandbox', () => {
    const p = buildGenericVendorProvider({
      authorize_url: 'https://a/x',
      token_endpoint: 'https://a/t',
      scopes: [],
    });
    expect(resolveVendorOAuthEndpoints(p, { sandbox: true })).toEqual({
      authorize_url: 'https://a/x',
      token_endpoint: 'https://a/t',
    });
  });
});

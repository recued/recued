import { describe, expect, it } from 'vitest';

import {
  connectionOAuthCredentialReadiness,
  invalidatesConnectionOAuthResult,
  isConnectionOAuthLockedField,
} from '../connections/oauth-credentials.js';

const oauthValues = (overrides: Record<string, string> = {}): Record<string, string> => ({
  'auth.type': 'oauth2_refresh',
  ...overrides,
});

describe('provider OAuth credential readiness', () => {
  it('shares the complete in-flight lock boundary with renderer and controller', () => {
    expect(isConnectionOAuthLockedField('auth.client_id')).toBe(true);
    expect(isConnectionOAuthLockedField('auth.scopes')).toBe(true);
    expect(isConnectionOAuthLockedField('config.sandbox')).toBe(true);
    expect(isConnectionOAuthLockedField('config.base_url')).toBe(true);
    expect(isConnectionOAuthLockedField('display_name')).toBe(false);
    expect(invalidatesConnectionOAuthResult('auth.client_id')).toBe(true);
    expect(invalidatesConnectionOAuthResult('auth.scopes')).toBe(true);
    expect(invalidatesConnectionOAuthResult('config.sandbox')).toBe(true);
    expect(invalidatesConnectionOAuthResult('auth.refresh_token')).toBe(false);
    expect(invalidatesConnectionOAuthResult('config.base_url')).toBe(false);
  });

  it('does not project readiness outside an API OAuth refresh form', () => {
    expect(connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'api',
      values: { 'auth.type': 'bearer' },
    })).toBeNull();
    expect(connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'mcp',
      values: oauthValues(),
    })).toBeNull();
  });

  it('uses registered-provider metadata to require the matching app secret', () => {
    const missingId = connectionOAuthCredentialReadiness({
      vendor: 'hubspot',
      kind: 'api',
      values: oauthValues(),
    });
    expect(missingId).toMatchObject({
      providerLabel: 'HubSpot',
      ready: false,
      issue: { fieldKey: 'auth.client_id' },
    });

    const missingSecret = connectionOAuthCredentialReadiness({
      vendor: 'hubspot',
      kind: 'api',
      values: oauthValues({ 'auth.client_id': 'client-id' }),
    });
    expect(missingSecret).toMatchObject({
      ready: false,
      refreshReady: false,
      issue: { fieldKey: 'auth.client_secret' },
    });
    expect(missingSecret?.requirements).toEqual([
      { fieldKey: 'auth.client_id', label: 'Client ID', status: 'complete' },
      { fieldKey: 'auth.client_secret', label: 'Client secret', status: 'missing' },
    ]);

    expect(connectionOAuthCredentialReadiness({
      vendor: 'hubspot',
      kind: 'api',
      values: oauthValues({
        'auth.client_id': 'client-id',
        'auth.client_secret': 'client-secret',
        'auth.scopes': 'crm.objects.contacts.read oauth',
      }),
    })).toMatchObject({ ready: true, refreshReady: true, issue: null, scopeCount: 2 });
  });

  it('keeps generic client secrets optional but gates unsafe or incomplete endpoints', () => {
    const missingEndpoint = connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'api',
      values: oauthValues({ 'auth.client_id': 'public-client' }),
    });
    expect(missingEndpoint).toMatchObject({
      ready: false,
      issue: { fieldKey: 'auth.token_endpoint' },
    });
    expect(missingEndpoint?.requirements[1]).toEqual({
      fieldKey: 'auth.client_secret',
      label: 'Client secret',
      status: 'optional',
    });

    const unsafeEndpoint = connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'api',
      values: oauthValues({
        'auth.client_id': 'public-client',
        'auth.token_endpoint': 'http://provider.example/token',
        'auth.authorize_url': 'https://provider.example/authorize',
      }),
    });
    expect(unsafeEndpoint).toMatchObject({
      ready: false,
      refreshReady: false,
      issue: {
        fieldKey: 'auth.token_endpoint',
        message: expect.stringContaining('complete HTTPS URL'),
      },
    });
    expect(unsafeEndpoint?.requirements[2]).toEqual({
      fieldKey: 'auth.token_endpoint',
      label: 'Token endpoint',
      status: 'invalid',
    });

    const embeddedCredentials = connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'api',
      values: oauthValues({
        'auth.client_id': 'public-client',
        'auth.token_endpoint': 'https://user:password@provider.example/token',
        'auth.authorize_url': 'https://provider.example/authorize',
      }),
    });
    expect(embeddedCredentials?.issue?.fieldKey).toBe('auth.token_endpoint');

    const parserShorthand = connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'api',
      values: oauthValues({
        'auth.client_id': 'public-client',
        'auth.token_endpoint': 'https:provider.example/token',
        'auth.authorize_url': 'https://provider.example/authorize',
      }),
    });
    expect(parserShorthand?.issue).toMatchObject({
      fieldKey: 'auth.token_endpoint',
      message: expect.stringContaining('complete HTTPS URL'),
    });

    const fragmentEndpoint = connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'api',
      values: oauthValues({
        'auth.client_id': 'public-client',
        'auth.token_endpoint': 'https://provider.example/token#ignored',
        'auth.authorize_url': 'https://provider.example/authorize',
      }),
    });
    expect(fragmentEndpoint?.issue).toMatchObject({
      fieldKey: 'auth.token_endpoint',
      message: expect.stringContaining('no URL fragment'),
    });

    expect(connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'api',
      values: oauthValues({
        'auth.client_id': 'public-client',
        'auth.refresh_token': 'pasted-token',
        'auth.token_endpoint': 'https://provider.example/token',
      }),
    })).toMatchObject({
      refreshReady: true,
      ready: false,
      issue: { fieldKey: 'auth.authorize_url' },
    });

    expect(connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'api',
      values: oauthValues({
        'auth.client_id': 'public-client',
        'auth.token_endpoint': 'https://provider.example/token',
        'auth.authorize_url': 'https://provider.example/authorize',
      }),
    })).toMatchObject({ ready: true, refreshReady: true, issue: null });
  });

  it('never returns credential values in its live readiness projection', () => {
    const readiness = connectionOAuthCredentialReadiness({
      vendor: 'hubspot',
      kind: 'api',
      values: oauthValues({
        'auth.client_id': 'sentinel-client-id',
        'auth.client_secret': 'sentinel-client-secret',
      }),
    });
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain('sentinel-client-id');
    expect(serialized).not.toContain('sentinel-client-secret');
  });
});

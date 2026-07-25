/** SMB-finance wedge slice 3 — Google Drive (storage-gdrive) vendor provider.
 *
 *  Google joins CONNECTION_VENDOR_PROVIDERS as a plain OAuth 2.0 vendor (no
 *  realm, no sandbox split). Its one deviation is `authorize_params` — Google
 *  needs `access_type=offline` + `prompt=consent` on the authorize URL to mint
 *  a refresh token; the reserved-key validator keeps that hatch from
 *  overriding the standard OAuth-start keys. */

import { describe, expect, it } from 'vitest';
import {
  CONNECTION_VENDOR_PROVIDERS,
  getVendorProvider,
  resolveVendorOAuthEndpoints,
  composeRealmBaseUrl,
  assertConnectionVendorProviderRegistry,
  assertConnectionVendorProviderShape,
  AUTHORIZE_PARAM_RESERVED_KEYS,
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_AUTHORIZE_PARAMS,
  GOOGLE_DRIVE_API_BASE,
  type ConnectionVendorProvider,
} from '../index.js';

describe('SMB-finance slice 3 — Google Drive provider', () => {
  const google = getVendorProvider('google');

  it('is registered + passes the registry shape check', () => {
    expect(google).not.toBeNull();
    expect(CONNECTION_VENDOR_PROVIDERS.map((p) => p.vendor)).toContain('google');
    expect(assertConnectionVendorProviderRegistry(CONNECTION_VENDOR_PROVIDERS)).toEqual([]);
  });

  it('uses the Google OAuth endpoints + Drive scopes', () => {
    expect(google!.oauth.authorize_url).toBe(GOOGLE_OAUTH_AUTHORIZE_URL);
    expect(google!.oauth.token_endpoint).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(google!.oauth.scopes).toEqual(GOOGLE_OAUTH_SCOPES);
    expect(GOOGLE_OAUTH_SCOPES).toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(GOOGLE_OAUTH_SCOPES).toContain('https://www.googleapis.com/auth/drive.file');
    expect(google!.oauth.client_secret_required).toBe(true);
    expect(google!.default_base_url).toBe(GOOGLE_DRIVE_API_BASE);
  });

  it('declares authorize_params (access_type=offline + prompt=consent) for the refresh token', () => {
    expect(google!.oauth.authorize_params).toEqual(GOOGLE_OAUTH_AUTHORIZE_PARAMS);
    expect(GOOGLE_OAUTH_AUTHORIZE_PARAMS).toEqual({ access_type: 'offline', prompt: 'consent' });
  });

  it('has no realm_base and no sandbox split (plain OAuth)', () => {
    expect(google!.realm_base).toBeUndefined();
    expect(google!.oauth.sandbox_authorize_url).toBeUndefined();
    expect(google!.oauth.sandbox_token_endpoint).toBeUndefined();
    expect(resolveVendorOAuthEndpoints(google!, { sandbox: true })).toEqual({
      authorize_url: GOOGLE_OAUTH_AUTHORIZE_URL,
      token_endpoint: GOOGLE_OAUTH_TOKEN_URL,
    });
    expect(composeRealmBaseUrl(google!, '123', false)).toBeNull();
  });
});

describe('authorize_params reserved-key validation', () => {
  const base = getVendorProvider('google')!;
  const withParams = (authorize_params: Record<string, string>): ConnectionVendorProvider =>
    ({ ...base, oauth: { ...base.oauth, authorize_params } });

  it('accepts the Google authorize_params', () => {
    expect(assertConnectionVendorProviderShape(base)).toEqual([]);
  });

  it('rejects an authorize_params key that overrides a reserved OAuth-start key', () => {
    for (const reserved of AUTHORIZE_PARAM_RESERVED_KEYS) {
      const issues = assertConnectionVendorProviderShape(withParams({ [reserved]: 'x' }));
      expect(issues.some((i) => i.includes(`may not override the reserved key '${reserved}'`))).toBe(true);
    }
  });

  it('rejects an empty authorize_params value', () => {
    const issues = assertConnectionVendorProviderShape(withParams({ access_type: '' }));
    expect(issues.some((i) => i.includes('must be a non-empty string'))).toBe(true);
  });
});

/** D-192 file SOURCE family — Dropbox vendor provider.
 *
 *  Covers: the Dropbox provider is registered + shaped like the other plain
 *  OAuth vendors (Google is the template), carries the `token_access_type=
 *  offline` authorize param (the refresh-token mint), requests metadata-only
 *  scopes, and — the deliberate asymmetry — S3 has NO provider (it is
 *  basic-auth, not OAuth), so `getVendorProvider('s3')` is null. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_PROVIDERS,
  DROPBOX_API_BASE,
  DROPBOX_OAUTH_AUTHORIZE_PARAMS,
  DROPBOX_OAUTH_AUTHORIZE_URL,
  DROPBOX_OAUTH_SCOPES,
  DROPBOX_OAUTH_TOKEN_URL,
  getVendorProvider,
} from '../index.js';

describe('D-192 — Dropbox vendor provider', () => {
  const dropbox = getVendorProvider('dropbox');

  it('is registered in CONNECTION_VENDOR_PROVIDERS', () => {
    expect(CONNECTION_VENDOR_PROVIDERS.some((p) => p.vendor === 'dropbox')).toBe(true);
    expect(dropbox).not.toBeNull();
  });

  it('exposes the display metadata + fixed API base', () => {
    expect(dropbox!.display_name).toBe('Dropbox');
    expect(dropbox!.default_base_url).toBe(DROPBOX_API_BASE);
    expect(DROPBOX_API_BASE).toBe('https://api.dropboxapi.com');
  });

  it('declares the Dropbox OAuth 2.0 endpoints', () => {
    expect(dropbox!.oauth.authorize_url).toBe(DROPBOX_OAUTH_AUTHORIZE_URL);
    expect(dropbox!.oauth.token_endpoint).toBe(DROPBOX_OAUTH_TOKEN_URL);
    expect(DROPBOX_OAUTH_AUTHORIZE_URL).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(DROPBOX_OAUTH_TOKEN_URL).toBe('https://api.dropboxapi.com/oauth2/token');
  });

  it('requests metadata-only scopes (bytes are never fetched)', () => {
    expect(dropbox!.oauth.scopes).toEqual(DROPBOX_OAUTH_SCOPES);
    expect([...DROPBOX_OAUTH_SCOPES]).toEqual(['account_info.read', 'files.metadata.read']);
    // No content scope — the file SOURCE family mirrors metadata only.
    expect([...DROPBOX_OAUTH_SCOPES].some((s) => s.includes('content'))).toBe(false);
  });

  it('carries token_access_type=offline so Dropbox mints a refresh token', () => {
    expect(dropbox!.oauth.authorize_params).toEqual(DROPBOX_OAUTH_AUTHORIZE_PARAMS);
    expect(DROPBOX_OAUTH_AUTHORIZE_PARAMS).toEqual({ token_access_type: 'offline' });
  });

  it('requires a client secret + supports PKCE (BYO Dropbox app)', () => {
    expect(dropbox!.oauth.client_secret_required).toBe(true);
    expect(dropbox!.oauth.supports_pkce).toBe(true);
  });
});

describe('D-192 — S3 has no OAuth provider (basic auth)', () => {
  it('getVendorProvider(s3) is null — S3 authenticates via access-key/secret, not OAuth', () => {
    expect(getVendorProvider('s3')).toBeNull();
    expect(CONNECTION_VENDOR_PROVIDERS.some((p) => p.vendor === 's3')).toBe(false);
  });
});

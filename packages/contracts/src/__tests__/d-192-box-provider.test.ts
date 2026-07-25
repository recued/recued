/** D-192 file SOURCE family — Box vendor provider.
 *
 *  Covers: the Box provider is registered + shaped like the other plain OAuth
 *  vendors (OneDrive is the template), uses Box's OAuth 2.0 endpoints, requests
 *  the read-only `root_readonly` scope (metadata sync + lazy byte reads),
 *  and — like OneDrive — carries NO `authorize_params`: Box returns a refresh
 *  token by default (and rotates it single-use), not via an authorize query
 *  param. The registry still passes the registry-level shape check with Box
 *  appended. */

import { describe, expect, it } from 'vitest';

import {
  assertConnectionVendorProviderRegistry,
  BOX_API_BASE,
  BOX_OAUTH_AUTHORIZE_URL,
  BOX_OAUTH_SCOPES,
  BOX_OAUTH_TOKEN_URL,
  CONNECTION_VENDOR_PROVIDERS,
  getVendorProvider,
} from '../index.js';

describe('D-192 — Box vendor provider', () => {
  const box = getVendorProvider('box');

  it('is registered in CONNECTION_VENDOR_PROVIDERS', () => {
    expect(CONNECTION_VENDOR_PROVIDERS.some((p) => p.vendor === 'box')).toBe(true);
    expect(box).not.toBeNull();
  });

  it('keeps the registry structurally valid with Box appended', () => {
    expect(assertConnectionVendorProviderRegistry(CONNECTION_VENDOR_PROVIDERS)).toEqual([]);
  });

  it('exposes the display metadata + fixed Box API base', () => {
    expect(box!.display_name).toBe('Box');
    expect(box!.default_base_url).toBe(BOX_API_BASE);
    expect(BOX_API_BASE).toBe('https://api.box.com/2.0');
  });

  it('uses the Box OAuth 2.0 endpoints', () => {
    expect(box!.oauth.authorize_url).toBe(BOX_OAUTH_AUTHORIZE_URL);
    expect(box!.oauth.token_endpoint).toBe(BOX_OAUTH_TOKEN_URL);
    expect(BOX_OAUTH_AUTHORIZE_URL).toBe('https://account.box.com/api/oauth2/authorize');
    expect(BOX_OAUTH_TOKEN_URL).toBe('https://api.box.com/oauth2/token');
  });

  it('requests the read-only root scope for metadata sync and lazy byte reads', () => {
    expect(box!.oauth.scopes).toEqual(BOX_OAUTH_SCOPES);
    expect([...BOX_OAUTH_SCOPES]).toEqual(['root_readonly']);
    // Read-only — no write scope.
    expect([...BOX_OAUTH_SCOPES].some((s) => s.includes('readwrite'))).toBe(false);
  });

  it('carries NO authorize_params — Box returns a refresh token by default', () => {
    // The same asymmetry as OneDrive vs Dropbox (token_access_type=offline) /
    // Google (access_type=offline): Box has no such authorize param and rotates
    // the refresh token single-use per refresh.
    expect(box!.oauth.authorize_params).toBeUndefined();
  });

  it('requires a client secret + supports PKCE (BYO Box app)', () => {
    expect(box!.oauth.client_secret_required).toBe(true);
    expect(box!.oauth.supports_pkce).toBe(true);
  });

  it('has no introspection endpoint', () => {
    expect(box!.oauth.access_token_introspect_url).toBeUndefined();
  });

  it('has no sandbox split', () => {
    expect(box!.oauth.sandbox_authorize_url).toBeUndefined();
    expect(box!.oauth.sandbox_token_endpoint).toBeUndefined();
  });
});

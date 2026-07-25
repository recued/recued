/** D-192 file SOURCE family — OneDrive (Microsoft Graph) vendor provider.
 *
 *  Covers: the OneDrive provider is registered + shaped like the other plain
 *  OAuth vendors (Dropbox is the template), reuses the shared Microsoft
 *  `/common/` identity endpoints, requests read-only Graph scopes, and —
 *  the deliberate asymmetry vs Dropbox/Google — carries NO `authorize_params`:
 *  Microsoft mints the refresh token from the `offline_access` SCOPE, not an
 *  authorize query param. The interim-enrollment registry still passes the
 *  registry-level shape check with OneDrive appended. */

import { describe, expect, it } from 'vitest';

import {
  assertConnectionVendorProviderRegistry,
  CONNECTION_VENDOR_PROVIDERS,
  GRAPH_FILES_READ_SCOPE,
  getVendorProvider,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_GRAPH_API_BASE,
  MICROSOFT_TOKEN_URL,
  ONEDRIVE_OAUTH_SCOPES,
} from '../index.js';

describe('D-192 — OneDrive vendor provider', () => {
  const onedrive = getVendorProvider('onedrive');

  it('is registered in CONNECTION_VENDOR_PROVIDERS', () => {
    expect(CONNECTION_VENDOR_PROVIDERS.some((p) => p.vendor === 'onedrive')).toBe(true);
    expect(onedrive).not.toBeNull();
  });

  it('keeps the registry structurally valid with OneDrive appended', () => {
    expect(assertConnectionVendorProviderRegistry(CONNECTION_VENDOR_PROVIDERS)).toEqual([]);
  });

  it('exposes the display metadata + fixed Graph API base', () => {
    expect(onedrive!.display_name).toBe('OneDrive');
    expect(onedrive!.default_base_url).toBe(MICROSOFT_GRAPH_API_BASE);
    expect(MICROSOFT_GRAPH_API_BASE).toBe('https://graph.microsoft.com/v1.0');
  });

  it('reuses the shared Microsoft OAuth 2.0 endpoints (mail/cal/files share them)', () => {
    expect(onedrive!.oauth.authorize_url).toBe(MICROSOFT_AUTHORIZE_URL);
    expect(onedrive!.oauth.token_endpoint).toBe(MICROSOFT_TOKEN_URL);
    expect(MICROSOFT_AUTHORIZE_URL).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(MICROSOFT_TOKEN_URL).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    );
  });

  it('requests read-only Graph scopes for metadata sync and lazy byte reads', () => {
    expect(onedrive!.oauth.scopes).toEqual(ONEDRIVE_OAUTH_SCOPES);
    expect([...ONEDRIVE_OAUTH_SCOPES]).toEqual([
      GRAPH_FILES_READ_SCOPE,
      'offline_access',
      'User.Read',
    ]);
    expect(GRAPH_FILES_READ_SCOPE).toBe('Files.Read');
    // Read-only — no write scope (`Files.ReadWrite`).
    expect([...ONEDRIVE_OAUTH_SCOPES].some((s) => s.includes('ReadWrite'))).toBe(false);
  });

  it('carries NO authorize_params — the refresh token comes from the offline_access scope', () => {
    // The deliberate asymmetry vs Dropbox (token_access_type=offline) and Google
    // (access_type=offline + prompt=consent): Microsoft has no such authorize param.
    expect(onedrive!.oauth.authorize_params).toBeUndefined();
    // `offline_access` IS the refresh-token mechanism, and it rides the scope set.
    expect([...ONEDRIVE_OAUTH_SCOPES]).toContain('offline_access');
  });

  it('requires a client secret + supports PKCE (BYO Microsoft Entra app)', () => {
    expect(onedrive!.oauth.client_secret_required).toBe(true);
    expect(onedrive!.oauth.supports_pkce).toBe(true);
  });

  it('has no introspection endpoint (Microsoft is RFC 6749 § 3.3-compliant)', () => {
    expect(onedrive!.oauth.access_token_introspect_url).toBeUndefined();
  });

  it('has no sandbox split', () => {
    expect(onedrive!.oauth.sandbox_authorize_url).toBeUndefined();
    expect(onedrive!.oauth.sandbox_token_endpoint).toBeUndefined();
  });
});

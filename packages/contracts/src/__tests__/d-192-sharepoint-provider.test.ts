/** D-192 file SOURCE family — SharePoint (Microsoft Graph) vendor provider.
 *
 *  SharePoint is an enrollment VARIANT of OneDrive (a document library is a
 *  Graph drive → same `/delta` adapter leaf, targeted by `config.drive_id`), so
 *  this provider is shaped exactly like OneDrive — shared Microsoft `/common/`
 *  endpoints, fixed Graph base, no `authorize_params`, no introspection — with
 *  ONE deliberate difference: the read scope is `Sites.Read.All` (not OneDrive's
 *  `Files.Read`, which is scoped to the user's own OneDrive and 403s on a
 *  SharePoint site drive). */

import { describe, expect, it } from 'vitest';

import {
  assertConnectionVendorProviderRegistry,
  CONNECTION_VENDOR_PROVIDERS,
  GRAPH_FILES_READ_SCOPE,
  GRAPH_SITES_READ_ALL_SCOPE,
  getVendorProvider,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_GRAPH_API_BASE,
  MICROSOFT_TOKEN_URL,
  ONEDRIVE_OAUTH_SCOPES,
  SHAREPOINT_OAUTH_SCOPES,
} from '../index.js';

describe('D-192 — SharePoint vendor provider', () => {
  const sharepoint = getVendorProvider('sharepoint');
  const onedrive = getVendorProvider('onedrive');

  it('is registered in CONNECTION_VENDOR_PROVIDERS', () => {
    expect(CONNECTION_VENDOR_PROVIDERS.some((p) => p.vendor === 'sharepoint')).toBe(true);
    expect(sharepoint).not.toBeNull();
  });

  it('keeps the registry structurally valid with SharePoint appended', () => {
    expect(assertConnectionVendorProviderRegistry(CONNECTION_VENDOR_PROVIDERS)).toEqual([]);
  });

  it('exposes the display metadata + fixed Graph API base', () => {
    expect(sharepoint!.display_name).toBe('SharePoint');
    expect(sharepoint!.default_base_url).toBe(MICROSOFT_GRAPH_API_BASE);
  });

  it('reuses the shared Microsoft OAuth 2.0 endpoints (same as OneDrive/mail/cal)', () => {
    expect(sharepoint!.oauth.authorize_url).toBe(MICROSOFT_AUTHORIZE_URL);
    expect(sharepoint!.oauth.token_endpoint).toBe(MICROSOFT_TOKEN_URL);
  });

  it('requests Sites.Read.All for metadata sync and lazy file reads', () => {
    expect(sharepoint!.oauth.scopes).toEqual(SHAREPOINT_OAUTH_SCOPES);
    expect([...SHAREPOINT_OAUTH_SCOPES]).toEqual([
      GRAPH_SITES_READ_ALL_SCOPE,
      'offline_access',
      'User.Read',
    ]);
    expect(GRAPH_SITES_READ_ALL_SCOPE).toBe('Sites.Read.All');
    // Read-only — no write scope (`Sites.ReadWrite.All`).
    expect([...SHAREPOINT_OAUTH_SCOPES].some((s) => s.includes('ReadWrite'))).toBe(false);
  });

  it('differs from OneDrive on exactly the read scope (Sites.Read.All vs Files.Read)', () => {
    // The one intended deviation: OneDrive requests Files.Read (own OneDrive
    // only); SharePoint needs Sites.Read.All to reach a site document library.
    expect([...SHAREPOINT_OAUTH_SCOPES]).toContain(GRAPH_SITES_READ_ALL_SCOPE);
    expect([...SHAREPOINT_OAUTH_SCOPES]).not.toContain(GRAPH_FILES_READ_SCOPE);
    expect([...ONEDRIVE_OAUTH_SCOPES]).toContain(GRAPH_FILES_READ_SCOPE);
    // Everything else about the OAuth shape matches OneDrive.
    expect(sharepoint!.oauth.authorize_url).toBe(onedrive!.oauth.authorize_url);
    expect(sharepoint!.oauth.token_endpoint).toBe(onedrive!.oauth.token_endpoint);
  });

  it('carries NO authorize_params — the refresh token comes from the offline_access scope', () => {
    expect(sharepoint!.oauth.authorize_params).toBeUndefined();
    expect([...SHAREPOINT_OAUTH_SCOPES]).toContain('offline_access');
  });

  it('requires a client secret + supports PKCE (BYO Microsoft Entra app)', () => {
    expect(sharepoint!.oauth.client_secret_required).toBe(true);
    expect(sharepoint!.oauth.supports_pkce).toBe(true);
  });

  it('has no introspection endpoint + no sandbox split (RFC 6749 § 3.3-compliant)', () => {
    expect(sharepoint!.oauth.access_token_introspect_url).toBeUndefined();
    expect(sharepoint!.oauth.sandbox_authorize_url).toBeUndefined();
    expect(sharepoint!.oauth.sandbox_token_endpoint).toBeUndefined();
  });
});

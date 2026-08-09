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
  GRAPH_FILES_READWRITE_SCOPE,
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

  it('requests WRITE-CAPABLE Graph scopes — widened from read-only by owner decision', () => {
    /** ⚠⚠ INVERTED 2026-08-07, DELIBERATELY. This asserted the seed was read-only and
     *  carried NO `Files.ReadWrite`, on reasoning that still stands on its own terms: the
     *  D-192 file SOURCE family mirrors METADATA via `/delta` and fetches bytes only on an
     *  explicit read — it never writes — and the enroll form's `prefillVendorScopes`
     *  already UNIONED write in the moment a write-capable pack was installed. Measured
     *  before the change:
     *      seed alone     -> Files.Read offline_access User.Read
     *      pack installed -> Files.Read Files.ReadWrite User.Read offline_access
     *  Nothing was broken. The owner weighed a connection that is write-capable BEFORE any
     *  pack is installed against a minimal one that widens on demand, and chose the former.
     *
     *  ⛔ THE COST IS KEPT HERE RATHER THAN DELETED WITH THE OLD ASSERTION: an owner who
     *  wants only the read-only file mirror is now asked to grant file mutation they will
     *  never exercise, and their Microsoft consent screen is correspondingly broader.
     *  Recued still gates every write at approval (`RISK_APPROVAL_FLOOR`), but the TOKEN
     *  now carries the authority — approval is the only thing standing between the two.
     *  Reverting is `ONEDRIVE_OAUTH_SCOPES` plus this assertion and its sibling in
     *  `connection-scope-prefill-corpus.test.ts`. */
    expect(onedrive!.oauth.scopes).toEqual(ONEDRIVE_OAUTH_SCOPES);
    expect([...ONEDRIVE_OAUTH_SCOPES]).toEqual([
      GRAPH_FILES_READ_SCOPE,
      GRAPH_FILES_READWRITE_SCOPE,
      'offline_access',
      'User.Read',
    ]);
    expect(GRAPH_FILES_READ_SCOPE).toBe('Files.Read');
    expect(GRAPH_FILES_READWRITE_SCOPE).toBe('Files.ReadWrite');
    /** ⛔ The READ scope must SURVIVE the widening. Microsoft treats `Files.ReadWrite` as a
     *  superset, so dropping the read half would still work at the provider — and would
     *  silently diverge from what the packs declare, leaving the granted set and the
     *  disclosed set disagreeing for no benefit. */
    expect([...ONEDRIVE_OAUTH_SCOPES]).toContain('Files.Read');
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

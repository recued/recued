/** A built-in provider's sign-in form open at a NUMBERED loopback address.
 *
 *  The server's start-up log prints `http://127.0.0.1:<port>/webclient/`, so
 *  that is where owners are — and the redirect URL the form prints follows the
 *  page. HubSpot will not register a `127.0.0.1` one and the Azure portal
 *  refuses an `http` one at a number, so the owner is told to connect from
 *  `localhost` (or from app.recued.com) instead. Owner ruling 2026-10-08:
 *  tell them to switch; the callback itself is unchanged. */

import { describe, expect, it } from 'vitest';
import { CONNECTION_VENDOR_PROVIDERS, OAUTH_CLOUD_CALLBACK_URL } from '@recued/contracts';

import {
  apiSchema,
  buildConnectionSetupGuidePreview,
  initialConnectionsDialogState,
  initialConnectionsPageState,
  renderConnectionsPage,
} from '../index.js';
import type { ConnectionsDialogState, ConnectionsPageState } from '../connections/index.js';

const SWITCH = 'data-oauth-callback-switch';

const vendorForm = (
  vendor: string | null,
  oauthCallbackUrl: string | undefined,
  dialog: Partial<ConnectionsDialogState> = {},
): ConnectionsPageState => ({
  ...initialConnectionsPageState(),
  dialog: {
    ...initialConnectionsDialogState(),
    stage: 'form',
    kind: 'api',
    vendor,
    values: {
      name: vendor ?? 'custom-app',
      display_name: 'On this machine',
      ...(vendor === null ? {} : { 'config.vendor': vendor }),
      'auth.type': 'oauth2_refresh',
    },
    ...(oauthCallbackUrl === undefined ? {} : { oauthCallbackUrl }),
    ...dialog,
  },
});

describe('a built-in provider form at a numbered loopback address says to switch', () => {
  it('HubSpot at 127.0.0.1: connect from localhost on the same port, or app.recued.com', () => {
    const html = renderConnectionsPage(
      vendorForm('hubspot', 'http://127.0.0.1:7717/webclient/oauth-callback.html'),
    );
    expect(html).toContain(SWITCH);
    expect(html).toContain('Connect from <code>http://localhost:7717/webclient</code> instead.');
    expect(html).toContain('<code>127.0.0.1</code>');
    expect(html).toContain('app.recued.com, if your server has its own HTTPS address');
    expect(html).toContain('pair it once, like a new device');
  });

  it("HubSpot's note also names its Service Key, which needs no redirect URL at all", () => {
    const html = renderConnectionsPage(
      vendorForm('hubspot', 'http://127.0.0.1:7717/webclient/oauth-callback.html'),
    );
    // Quoted exactly as the How to connect dropdown shows it.
    expect(html).toContain(
      'Or choose <strong data-oauth-no-redirect-option>Service Key (recommended)</strong> '
        + 'under How to connect: it needs no redirect URL.',
    );
  });

  it('a provider whose only way in is sign-in names no other option', () => {
    const html = renderConnectionsPage(
      vendorForm('salesforce', 'http://127.0.0.1:7717/webclient/oauth-callback.html'),
    );
    expect(html).toContain(SWITCH);
    expect(html).not.toContain('data-oauth-no-redirect-option');
  });

  it('keeps the page port, and names [::1] the same way', () => {
    const html = renderConnectionsPage(
      vendorForm('hubspot', 'http://[::1]:8123/webclient/oauth-callback.html'),
    );
    expect(html).toContain('<code>http://localhost:8123/webclient</code>');
    expect(html).toContain('<code>[::1]</code>');
  });

  it.each(CONNECTION_VENDOR_PROVIDERS.map((p) => p.vendor))(
    'every built-in provider (%s) gets it at 127.0.0.1',
    (vendor) => {
      const html = renderConnectionsPage(
        vendorForm(vendor, 'http://127.0.0.1:7717/webclient/oauth-callback.html'),
      );
      expect(html).toContain(SWITCH);
    },
  );

  it.each([
    ['localhost itself', 'http://localhost:7717/webclient/oauth-callback.html'],
    ['app.recued.com', OAUTH_CLOUD_CALLBACK_URL],
    ["the server's own https name", 'https://acme.recued.net/oauth/complete'],
    ['an unset callback (off-browser)', undefined],
  ])('is absent at %s', (_label, callback) => {
    const html = renderConnectionsPage(vendorForm('hubspot', callback));
    expect(html).toContain('Add this redirect URL to your provider app');
    expect(html).not.toContain(SWITCH);
  });

  it('is absent for a custom OAuth app: its provider may take the numbered address', () => {
    const html = renderConnectionsPage(
      vendorForm(null, 'http://127.0.0.1:7717/webclient/oauth-callback.html', {
        values: {
          name: 'custom-app',
          display_name: 'Custom app',
          'auth.type': 'oauth2_refresh',
          'auth.authorize_url': 'https://oauth.example.com/authorize',
          'auth.token_endpoint': 'https://oauth.example.com/token',
        },
      }),
    );
    expect(html).toContain('Add this redirect URL to your provider app');
    expect(html).not.toContain(SWITCH);
  });

  it("the setup guide's callback step says it too", () => {
    const state = vendorForm('hubspot', 'http://127.0.0.1:7717/webclient/oauth-callback.html');
    const built = buildConnectionSetupGuidePreview(
      apiSchema,
      { ...state.dialog.values, 'config.base_url': 'https://api.hubapi.com' },
      'https://developers.hubspot.com/',
    );
    if (!built.ok) throw new Error(built.error);
    state.dialog.setupGuide = {
      stage: 'ready',
      targetUrl: built.preview.target_url,
      preview: built.preview,
      error: null,
      resumeAvailable: false,
      resumeFieldKey: null,
      result: {
        shared_context: {
          target_url: built.preview.target_url,
          auth_type: built.preview.auth_type,
          field_keys: [...built.preview.field_keys],
        },
        guide: {
          provider_name: 'HubSpot',
          overview: 'Create an app.',
          field_suggestions: [],
          steps: [{ title: 'Create the app', instruction: 'Add the redirect URL.', field_keys: [] }],
          cautions: [],
        },
      },
    };
    const html = renderConnectionsPage(state);
    const step = html.slice(html.indexOf("Register Recued's exact callback URL"));
    expect(step).toContain(SWITCH);
    expect(html.split(SWITCH)).toHaveLength(3); // the form's box and the guide's step
  });
});

/** SMB-finance wedge slice 3 — Google Drive vendor enrollment schema.
 *
 *  Variant of `apiSchema` with Google-specific OAuth fields pre-filled +
 *  the `config.vendor` discriminator locked to `'google'`. The plainest of
 *  the vendor schemas: no sandbox toggle and no per-org base URL — Drive's
 *  REST root is the fixed global `GOOGLE_DRIVE_API_BASE`. The user supplies
 *  their own Google Cloud OAuth app's client_id + client_secret (BYO OAuth,
 *  like HubSpot / QuickBooks); the in-app OAuth dance fills the refresh
 *  token. The `access_type=offline` + `prompt=consent` params Google needs
 *  to mint that refresh token live on the provider (`authorize_params`),
 *  not the form.
 *
 *  Spec: internal design notes §4. */

import {
  GOOGLE_DRIVE_API_BASE,
  GOOGLE_OAUTH_TOKEN_URL,
} from '@recued/contracts';

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const GOOGLE_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `google`, `gdrive`).',
    placeholder: 'google',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Google Drive',
  },
  // Vendor discriminator — locked + hidden (same posture as the other vendors).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'Google vendor identifier — locked at enrollment.',
    placeholder: 'google',
    hidden: true,
  },
  // Fixed global Drive REST root — hidden (no per-org / regional split).
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    help: 'Google Drive REST v3 root — fixed.',
    placeholder: GOOGLE_DRIVE_API_BASE,
    hidden: true,
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_refresh'],
    help: 'Google Drive uses OAuth 2.0 with refresh tokens.',
    hidden: true,
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID',
    type: 'text',
    help: 'From your Google Cloud app — console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application). Enable the Google Drive API.',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret',
    type: 'secret',
    help: 'From your Google Cloud OAuth 2.0 Client — the client secret.',
  },
  // Fork 1 B — editable, pre-filled OAuth scopes (Google defaults ∪ the scopes
  // your installed packs need). Blank → the server requests its defaults + the
  // installed-pack union itself; const essentials are a non-trimmable floor
  // server-side.
  {
    key: 'auth.scopes',
    label: 'Scopes',
    type: 'text',
    optional: true,
    help:
      'OAuth scopes requested at authorization. Pre-filled from Google\'s '
      + 'defaults plus the scopes your installed packs need — edit to add or trim.',
  },
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    placeholder: GOOGLE_OAUTH_TOKEN_URL,
    help: 'Google OAuth 2.0 token endpoint — fixed.',
    hidden: true,
  },
  {
    key: 'auth.refresh_token',
    label: 'Refresh Token',
    type: 'secret',
    help:
      'Long-lived refresh token from the Google OAuth flow — populated ' +
      'automatically by the in-app OAuth dance.',
  },
];

/** Initial form values keyed by dotted-path schema key. Base URL is the
 *  fixed Drive root; the token endpoint is fixed (no sandbox/environment
 *  dependence). */
export const GOOGLE_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'google',
  'config.base_url': GOOGLE_DRIVE_API_BASE,
  'auth.type': 'oauth2_refresh',
  'auth.token_endpoint': GOOGLE_OAUTH_TOKEN_URL,
};

export const googleSchema: VendorConnectionSchema = {
  vendor: 'google',
  kind: 'api',
  label: 'Google Drive',
  description:
    'Cloud file storage — list, read, and download documents from a Drive folder; uploads ask. OAuth 2.0 via your own Google Cloud app.',
  fields: GOOGLE_FIELDS,
  initialValues: GOOGLE_SCHEMA_INITIAL_VALUES,
};

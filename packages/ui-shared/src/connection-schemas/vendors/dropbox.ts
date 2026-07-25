/** D-192 file SOURCE family — Dropbox vendor enrollment schema.
 *
 *  A near-verbatim variant of the Google Drive schema: a plain OAuth 2.0
 *  vendor with no sandbox toggle and no per-org base URL (Dropbox's API root
 *  is the fixed global `DROPBOX_API_BASE`). The user supplies their own
 *  Dropbox app's client_id + client_secret (BYO OAuth, like Google/HubSpot);
 *  the in-app OAuth dance fills the refresh token. The `token_access_type=
 *  offline` param Dropbox needs to mint that refresh token lives on the
 *  provider (`authorize_params`), not the form.
 *
 *  oauth2_refresh (not bearer) is the only auth: a Dropbox access token is
 *  short-lived (~4h), so a background metadata mirror needs the auto-refreshed
 *  `oauth2_refresh` credential (`resolveBearerAccessToken` reads its
 *  `current_access_token`). The projected `config.vendor: 'dropbox'` is what
 *  the file SOURCE reconciler + the `dropbox` app pack's http ingredient both
 *  key on — one enrolled connection serves both.
 *
 *  `config.import_scope` (Fork A) is the optional path glob that scopes the
 *  metadata mirror to a subtree — see `packages/contracts/src/import-scope.ts`.
 *
 *  Spec: D-192; mirrors `google.ts`. */

import {
  DROPBOX_API_BASE,
  DROPBOX_OAUTH_TOKEN_URL,
} from '@recued/contracts';

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const DROPBOX_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `dropbox`, `dropbox-work`).',
    placeholder: 'dropbox',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Dropbox',
  },
  // Vendor discriminator — locked + hidden (same posture as the other vendors).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'Dropbox vendor identifier — locked at enrollment.',
    placeholder: 'dropbox',
    hidden: true,
  },
  // Fixed global Dropbox API root — hidden (no per-org / regional split).
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    help: 'Dropbox API root — fixed.',
    placeholder: DROPBOX_API_BASE,
    hidden: true,
  },
  // Fork A escape hatch — the optional path glob that scopes the metadata
  // mirror to a subtree. Empty = mirror the whole account.
  {
    key: 'config.import_scope',
    label: 'Scope to a subtree (optional)',
    type: 'text',
    optional: true,
    placeholder: 'Work/**',
    help:
      'Optional path glob to limit which files are mirrored — e.g. `Work/**` '
      + '(a folder) or `**/*.pdf` (a pattern). Leave blank to mirror the whole '
      + 'account. Sync mirrors metadata only; contents are fetched lazily only '
      + 'when you explicitly read a file.',
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_refresh'],
    help: 'Dropbox uses OAuth 2.0 with refresh tokens.',
    hidden: true,
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID (App key)',
    type: 'text',
    help:
      'From your Dropbox app — dropbox.com/developers/apps → your app → '
      + 'Settings → App key. Grant it the `files.metadata.read`, '
      + '`files.content.read`, and `account_info.read` scopes on the Permissions tab.',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret (App secret)',
    type: 'secret',
    help: 'From your Dropbox app — Settings → App secret.',
  },
  // Fork 1 B — editable, pre-filled OAuth scopes (Dropbox defaults ∪ the scopes
  // your installed packs need). Blank → the server requests its defaults + the
  // installed-pack union itself.
  {
    key: 'auth.scopes',
    label: 'Scopes',
    type: 'text',
    optional: true,
    help:
      'OAuth scopes requested at authorization. Pre-filled from Dropbox\'s '
      + 'defaults plus the scopes your installed packs need — edit to add or trim.',
  },
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    placeholder: DROPBOX_OAUTH_TOKEN_URL,
    help: 'Dropbox OAuth 2.0 token endpoint — fixed.',
    hidden: true,
  },
  {
    key: 'auth.refresh_token',
    label: 'Refresh Token',
    type: 'secret',
    help:
      'Long-lived refresh token from the Dropbox OAuth flow — populated '
      + 'automatically by the in-app OAuth dance.',
  },
];

/** Initial form values keyed by dotted-path schema key. Base URL + token
 *  endpoint are fixed (no sandbox/environment dependence). */
export const DROPBOX_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'dropbox',
  'config.base_url': DROPBOX_API_BASE,
  'auth.type': 'oauth2_refresh',
  'auth.token_endpoint': DROPBOX_OAUTH_TOKEN_URL,
};

export const dropboxSchema: VendorConnectionSchema = {
  vendor: 'dropbox',
  kind: 'api',
  label: 'Dropbox',
  description:
    'Cloud file storage — mirror file/folder metadata into your warehouse; file bytes stay remote and are fetched only for an explicit read. OAuth 2.0 via your own Dropbox app.',
  fields: DROPBOX_FIELDS,
  initialValues: DROPBOX_SCHEMA_INITIAL_VALUES,
};

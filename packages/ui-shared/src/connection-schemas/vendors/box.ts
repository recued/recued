/** D-192 file SOURCE family — Box vendor enrollment schema.
 *
 *  A near-verbatim variant of the OneDrive schema: a plain OAuth 2.0 vendor with
 *  no sandbox toggle and no per-org base URL (Box's REST root is the fixed global
 *  `BOX_API_BASE`). The user supplies their own Box app's client_id +
 *  client_secret (BYO OAuth, like OneDrive/Google); the in-app OAuth dance fills
 *  the refresh token. Box returns a refresh token by default (no `offline_access`
 *  scope or authorize param) and ROTATES it single-use per refresh — the
 *  file-source refresh gate captures + persists the rotated token, so the
 *  background mirror survives.
 *
 *  oauth2_refresh (not bearer) is the only auth here: a Box access token is
 *  short-lived (~60 min), so a background metadata mirror needs the
 *  auto-refreshed `oauth2_refresh` credential (`resolveBearerAccessToken` reads
 *  its `current_access_token`). This is DISTINCT from the `box` app pack, which
 *  enrolls a static bearer token for user-triggered ops. The projected
 *  `config.vendor: 'box'` is what the file SOURCE reconciler + the Box adapter
 *  leaf key on.
 *
 *  `config.import_scope` (Fork A) is the optional path glob that scopes the
 *  metadata mirror to a subtree. Box has no server-side path filter
 *  (`supports_prefix: false`), so the glob is applied CLIENT-SIDE against the
 *  path the leaf synthesizes from each item's `path_collection`.
 *
 *  `config.folder_id` (optional) bounds the full walk's tree-ROOT to one folder
 *  (Box scopes by folder id, not path); blank walks the whole account from the
 *  root folder (`0`). Mirrors OneDrive's `drive_id`.
 *
 *  Spec: D-192; mirrors `onedrive.ts`. */

import {
  BOX_API_BASE,
  BOX_OAUTH_TOKEN_URL,
} from '@recued/contracts';

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const BOX_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'A short lower-case name you use in Recipes, such as `box`, `box-team`).',
    placeholder: 'box',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Box',
  },
  // Vendor discriminator — locked + hidden (same posture as the other vendors).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'Box sets this when you connect. You cannot change it.',
    placeholder: 'box',
    hidden: true,
  },
  // Fixed global Box REST root — hidden (no per-org / regional split).
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    help: 'Box API v2 REST root — fixed.',
    placeholder: BOX_API_BASE,
    hidden: true,
  },
  // Fork A escape hatch — the optional path glob that scopes the metadata
  // mirror to a subtree. Empty = mirror the whole account. Applied client-side
  // (Box has no server-side path filter) against the leaf's synthesized path.
  {
    key: 'config.import_scope',
    label: 'Just part of it, if you want',
    type: 'text',
    optional: true,
    placeholder: 'Work/**',
    help:
      'A pattern limiting which files Recued brings in, such as `Work/**` '
      + '(a folder) or `**/*.pdf` (a pattern). Leave blank to mirror everything. '
      + 'Recued brings in only the details, not the files themselves. It fetches a file only when you '
      + 'explicitly read a file.',
  },
  // Optional — bound the full walk to one folder subtree by its Box folder id.
  // The leaf reads `config.folder_id`; blank walks the whole account from root.
  {
    key: 'config.folder_id',
    label: 'Folder ID (optional)',
    type: 'text',
    optional: true,
    help:
      'Optional — bound the mirror to one folder subtree by its Box folder id '
      + '(from the folder URL). Leave blank to mirror your whole account from the '
      + 'root folder.',
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_refresh'],
    help: 'Box asks you to sign in, and Recued stays signed in for you.',
    hidden: true,
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID',
    type: 'text',
    help:
      'From your Box app — app.box.com/developers/console → your app → '
      + 'Configuration → OAuth 2.0 Credentials → Client ID. Give the app the '
      + '"Read all files and folders stored in Box" application scope.',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret',
    type: 'secret',
    help: 'From your Box app — Configuration → OAuth 2.0 Credentials → Client Secret.',
  },
  // Fork 1 B — editable, pre-filled OAuth scopes. Box scopes are app-level (set
  // in the developer console); this optionally downscopes the authorize request.
  {
    key: 'auth.scopes',
    label: 'Scopes',
    type: 'text',
    optional: true,
    help:
      'OAuth scopes requested at authorization. Box scopes are configured on '
      + 'your Box app; leave blank to request the app defaults.',
  },
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    placeholder: BOX_OAUTH_TOKEN_URL,
    help: 'Box OAuth 2.0 token endpoint — fixed.',
    hidden: true,
  },
  {
    key: 'auth.refresh_token',
    label: 'Refresh Token',
    type: 'secret',
    // Filled by the OAuth dance (`applyVendorOAuthResultValues`), never typed.
    autofilled: true,
    help:
      'Long-lived refresh token from the Box OAuth flow — populated '
      + 'automatically by the in-app OAuth dance.',
  },
];

/** Initial form values keyed by dotted-path schema key. Base URL + token
 *  endpoint are fixed (no sandbox/environment dependence). */
export const BOX_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'box',
  'config.base_url': BOX_API_BASE,
  'auth.type': 'oauth2_refresh',
  'auth.token_endpoint': BOX_OAUTH_TOKEN_URL,
};

export const boxSchema: VendorConnectionSchema = {
  vendor: 'box',
  kind: 'api',
  label: 'Box',
  description:
    'Cloud file storage — mirror file/folder metadata into your warehouse via the Box events + folders API; file bytes stay remote and are fetched only for an explicit read. OAuth 2.0 via your own Box app.',
  fields: BOX_FIELDS,
  initialValues: BOX_SCHEMA_INITIAL_VALUES,
};

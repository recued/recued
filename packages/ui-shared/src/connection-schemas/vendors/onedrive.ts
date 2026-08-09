/** D-192 file SOURCE family — OneDrive (Microsoft Graph) vendor enrollment schema.
 *
 *  A near-verbatim variant of the Dropbox schema: a plain OAuth 2.0 vendor with
 *  no sandbox toggle and no per-org base URL (Graph's REST root is the fixed
 *  global `MICROSOFT_GRAPH_API_BASE`). The user supplies their own Microsoft
 *  Entra app's client_id + client_secret (BYO OAuth, like Google/Dropbox); the
 *  in-app OAuth dance fills the refresh token. Unlike Dropbox/Google, Microsoft
 *  mints that refresh token from the `offline_access` SCOPE, not an authorize
 *  query param — so the provider carries no `authorize_params`.
 *
 *  oauth2_refresh (not bearer) is the only auth: a Graph access token is
 *  short-lived (~1h), so a background metadata mirror needs the auto-refreshed
 *  `oauth2_refresh` credential (`resolveBearerAccessToken` reads its
 *  `current_access_token`). The projected `config.vendor: 'onedrive'` is what
 *  the file SOURCE reconciler + the OneDrive adapter leaf key on.
 *
 *  `config.import_scope` (Fork A) is the optional path glob that scopes the
 *  metadata mirror to a subtree. OneDrive's `/delta` feed has no server-side
 *  path filter (`supports_prefix: false`), so the scope is applied CLIENT-SIDE
 *  after the whole-drive walk — see `packages/contracts/src/import-scope.ts`.
 *
 *  `config.drive_id` (optional, new vs Dropbox) targets a non-default or
 *  SharePoint document-library drive; blank walks the signed-in user's default
 *  `/me/drive`.
 *
 *  Spec: D-192; mirrors `dropbox.ts`. */

import {
  MICROSOFT_GRAPH_API_BASE,
  MICROSOFT_TOKEN_URL,
} from '@recued/contracts';

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const ONEDRIVE_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `onedrive`, `onedrive-work`).',
    placeholder: 'onedrive',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'OneDrive',
  },
  // Vendor discriminator — locked + hidden (same posture as the other vendors).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'OneDrive vendor identifier — locked at enrollment.',
    placeholder: 'onedrive',
    hidden: true,
  },
  // Fixed global Graph REST root — hidden (no per-org / regional split).
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    help: 'Microsoft Graph REST v1.0 root — fixed.',
    placeholder: MICROSOFT_GRAPH_API_BASE,
    hidden: true,
  },
  // Fork A escape hatch — the optional path glob that scopes the metadata
  // mirror to a subtree. Empty = mirror the whole drive. Applied client-side
  // (Graph's /delta feed has no server-side path filter).
  {
    key: 'config.import_scope',
    label: 'Scope to a subtree (optional)',
    type: 'text',
    optional: true,
    placeholder: 'Work/**',
    help:
      'Optional path glob to limit which files are mirrored — e.g. `Work/**` '
      + '(a folder) or `**/*.pdf` (a pattern). Leave blank to mirror the whole '
      + 'drive. Sync mirrors metadata only; contents are fetched lazily only '
      + 'when you explicitly read a file.',
  },
  // Optional — target a specific (non-default / SharePoint) drive. The leaf
  // reads `config.drive_id`; blank walks the signed-in user's default drive.
  {
    key: 'config.drive_id',
    label: 'Drive ID (optional)',
    type: 'text',
    optional: true,
    help:
      'Optional — target a specific drive by its Graph drive id. Leave blank to '
      + 'mirror your default OneDrive (`/me/drive`). Reaching another drive (e.g. a '
      + 'SharePoint document library) may require broader Graph permissions on your '
      + 'Entra app than the default `Files.Read` / `Files.ReadWrite`.',
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_refresh'],
    help: 'OneDrive uses Microsoft OAuth 2.0 with refresh tokens.',
    hidden: true,
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID (Application ID)',
    type: 'text',
    help:
      'From your Microsoft Entra app — entra.microsoft.com → App registrations → '
      + 'your app → Overview → Application (client) ID. Grant it the `Files.Read`, '
      + '`Files.ReadWrite`, `offline_access`, and `User.Read` delegated Microsoft '
      + 'Graph permissions.',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret',
    type: 'secret',
    help: 'From your Microsoft Entra app — Certificates & secrets → New client secret (the Value).',
  },
  // Fork 1 B — editable, pre-filled OAuth scopes (Microsoft defaults ∪ the
  // scopes your installed packs need). Blank → the server requests its defaults
  // + the installed-pack union itself.
  {
    key: 'auth.scopes',
    label: 'Scopes',
    type: 'text',
    optional: true,
    help:
      'OAuth scopes requested at authorization. Pre-filled from Microsoft\'s '
      + 'defaults plus the scopes your installed packs need — edit to add or trim.',
  },
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    placeholder: MICROSOFT_TOKEN_URL,
    help: 'Microsoft identity platform OAuth 2.0 token endpoint — fixed.',
    hidden: true,
  },
  {
    key: 'auth.refresh_token',
    label: 'Refresh Token',
    type: 'secret',
    // Filled by the OAuth dance (`applyVendorOAuthResultValues`), never typed.
    autofilled: true,
    help:
      'Long-lived refresh token from the Microsoft OAuth flow — populated '
      + 'automatically by the in-app OAuth dance.',
  },
];

/** Initial form values keyed by dotted-path schema key. Base URL + token
 *  endpoint are fixed (no sandbox/environment dependence). */
export const ONEDRIVE_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'onedrive',
  'config.base_url': MICROSOFT_GRAPH_API_BASE,
  'auth.type': 'oauth2_refresh',
  'auth.token_endpoint': MICROSOFT_TOKEN_URL,
};

export const onedriveSchema: VendorConnectionSchema = {
  vendor: 'onedrive',
  kind: 'api',
  label: 'OneDrive',
  description:
    'Cloud file storage — mirror file/folder metadata into your warehouse via Microsoft Graph; file bytes stay remote and are fetched only for an explicit read. OAuth 2.0 via your own Microsoft Entra app.',
  fields: ONEDRIVE_FIELDS,
  initialValues: ONEDRIVE_SCHEMA_INITIAL_VALUES,
};

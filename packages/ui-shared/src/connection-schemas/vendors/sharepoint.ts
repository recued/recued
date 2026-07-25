/** D-192 file SOURCE family — SharePoint (Microsoft Graph) vendor enrollment schema.
 *
 *  An enrollment VARIANT of OneDrive, not a new adapter: a SharePoint document
 *  library is a Microsoft Graph drive, so an enrolled `sharepoint` connection
 *  rides the SAME OneDrive `/delta` adapter leaf (keyed by the `config.vendor`
 *  slug) — targeting the library through `config.drive_id`
 *  (`/drives/{drive_id}/root/delta`). The user supplies their own Microsoft
 *  Entra app's client_id + client_secret (BYO OAuth, like OneDrive); the in-app
 *  OAuth dance fills the refresh token. Microsoft mints that refresh token from
 *  the `offline_access` SCOPE, so the provider carries no `authorize_params`.
 *
 *  Two differences from the OneDrive schema — both enrollment-only:
 *    1. The library must be TARGETED (SharePoint has no `/me/drive` personal-
 *       drive default; a blank target would make the shared leaf walk the
 *       signed-in user's OneDrive — the wrong drive). The user supplies EITHER a
 *       `config.site_url` (the easy path — the server resolves the site's default
 *       library drive id via Graph at enrollment, D-192 CORE #5e) OR a
 *       hand-copied `config.drive_id` (the advanced override, for a non-default
 *       library). Enrollment requires exactly one; the resolver writes `drive_id`
 *       so the leaf always reads the same field at runtime.
 *    2. The Entra app needs the `Sites.Read.All` delegated Graph permission
 *       (OneDrive's `Files.Read` is scoped to the user's own OneDrive and 403s
 *       on a SharePoint site drive — which the leaf surfaces gracefully as a
 *       `policy` outcome, and the site→drive resolver surfaces as a clear
 *       enrollment error).
 *
 *  `config.import_scope` (Fork A) is the optional path glob that scopes the
 *  metadata mirror to a subtree — applied CLIENT-SIDE after the whole-drive walk
 *  (Graph's `/delta` feed has no server-side path filter), exactly as OneDrive.
 *
 *  Spec: D-192; mirrors `onedrive.ts`. */

import {
  MICROSOFT_GRAPH_API_BASE,
  MICROSOFT_TOKEN_URL,
} from '@recued/contracts';

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const SHAREPOINT_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `sharepoint`, `sharepoint-team-docs`).',
    placeholder: 'sharepoint',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'SharePoint',
  },
  // Vendor discriminator — locked + hidden (same posture as the other vendors).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'SharePoint vendor identifier — locked at enrollment.',
    placeholder: 'sharepoint',
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
  // mirror to a subtree. Empty = mirror the whole library. Applied client-side
  // (Graph's /delta feed has no server-side path filter).
  {
    key: 'config.import_scope',
    label: 'Scope to a subtree (optional)',
    type: 'text',
    optional: true,
    placeholder: 'Shared Documents/**',
    help:
      'Optional path glob to limit which files are mirrored — e.g. '
      + '`Shared Documents/**` (a folder) or `**/*.pdf` (a pattern). Leave blank '
      + 'to mirror the whole library. Sync mirrors metadata only; contents are '
      + 'fetched lazily only when you explicitly read a file.',
  },
  // The EASY path (D-192 CORE #5e) — paste the site URL and the server resolves
  // the default document library's Graph drive id at enrollment (one Graph call
  // after the OAuth dance). Optional because an advanced user can instead paste a
  // specific `drive_id` below; enrollment requires exactly one of the two.
  {
    key: 'config.site_url',
    label: 'SharePoint site URL',
    type: 'url',
    optional: true,
    placeholder: 'https://contoso.sharepoint.com/sites/TeamDocs',
    help:
      'Paste your SharePoint site’s URL — Recued resolves the site’s default '
      + 'document library automatically when you connect. Needs the '
      + '`Sites.Read.All` permission on your Entra app. Leave blank only if you '
      + 'paste the drive ID directly below.',
  },
  // The ADVANCED override — a hand-copied Graph drive id. Optional: leave blank
  // to have the server resolve it from the site URL above. Supply it (instead of
  // a site URL) to target a NON-default library. SharePoint has no `/me/drive`
  // default, so the leaf needs one of the two to know which drive to walk.
  {
    key: 'config.drive_id',
    label: 'Document library drive ID (advanced)',
    type: 'text',
    optional: true,
    help:
      'Advanced: the Microsoft Graph drive id of a specific document library '
      + '(a long `b!…` string). Leave blank to auto-resolve the default library '
      + 'from the site URL above. Supply it to target a non-default library — '
      + 'find it in Graph Explorer: '
      + '`GET /sites/{hostname}:/sites/{site-path}:/drives`.',
    placeholder: 'b!AbCdEf...',
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_refresh'],
    help: 'SharePoint uses Microsoft OAuth 2.0 with refresh tokens.',
    hidden: true,
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID (Application ID)',
    type: 'text',
    help:
      'From your Microsoft Entra app — entra.microsoft.com → App registrations → '
      + 'your app → Overview → Application (client) ID. Grant it the '
      + '`Sites.Read.All`, `offline_access`, and `User.Read` delegated Microsoft '
      + 'Graph permissions (SharePoint libraries need `Sites.Read.All`, not the '
      + 'OneDrive-only `Files.Read`).',
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
    help:
      'Long-lived refresh token from the Microsoft OAuth flow — populated '
      + 'automatically by the in-app OAuth dance.',
  },
];

/** Initial form values keyed by dotted-path schema key. Base URL + token
 *  endpoint are fixed (no sandbox/environment dependence). */
export const SHAREPOINT_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'sharepoint',
  'config.base_url': MICROSOFT_GRAPH_API_BASE,
  'auth.type': 'oauth2_refresh',
  'auth.token_endpoint': MICROSOFT_TOKEN_URL,
};

export const sharepointSchema: VendorConnectionSchema = {
  vendor: 'sharepoint',
  kind: 'api',
  label: 'SharePoint',
  description:
    'SharePoint document libraries — mirror file/folder metadata into your warehouse via Microsoft Graph; file bytes stay remote and are fetched only for an explicit read. Paste your site URL and Recued resolves the document library automatically. OAuth 2.0 via your own Microsoft Entra app.',
  fields: SHAREPOINT_FIELDS,
  initialValues: SHAREPOINT_SCHEMA_INITIAL_VALUES,
};

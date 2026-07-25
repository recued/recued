/** D-192 file SOURCE family — Notion vendor schema.
 *
 *  Notion authenticates with a single long-lived BEARER token — an internal
 *  integration secret (non-expiring, the low-friction default for a self-hosted
 *  single-workspace user), carried on the connection substrate's `bearer` auth
 *  (`auth.token`). The Notion file-source leaf reads it via
 *  `resolveBearerAccessToken` (`file-source-adapters/notion.ts`). There is NO
 *  `ConnectionVendorProvider` for `notion` (providers are OAuth-only) and NO
 *  `oauth2_refresh` — Notion tokens don't rotate, unlike Box/Dropbox; the enroll
 *  panel's provider consumers are all null-safe for a schema without one (the S3
 *  precedent).
 *
 *  `config.vendor: 'notion'` is what the file SOURCE reconciler + the Notion
 *  adapter key on. The leaf walks the pages/databases SHARED WITH THE
 *  INTEGRATION (POST /v1/search → recurse block children collecting file-carrying
 *  blocks), so what the mirror covers is exactly what the workspace owner granted
 *  the integration — not the whole workspace. One `notion` bearer connection also
 *  powers the `notion.json` app-pack ops (one connection, both surfaces — the Box
 *  precedent).
 *
 *  `config.import_scope` (Fork A) is the optional glob that scopes the mirror to
 *  a page-title subtree. Notion has no server-side path filter, so it's applied
 *  CLIENT-SIDE over the leaf's synthesized breadcrumb path (like Box).
 *
 *  Spec: `docs/d-192-file-source-family.md`; config shape matches
 *  `backend/server/src/file-source-adapters/notion.ts`. */

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const NOTION_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `notion`).',
    placeholder: 'notion',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Notion',
  },
  // Vendor discriminator — locked + hidden (same posture as the other vendors).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'Notion vendor identifier — locked at enrollment.',
    placeholder: 'notion',
    hidden: true,
  },
  // Fork A escape hatch — the optional glob that scopes the metadata mirror to a
  // page-title subtree. Notion exposes no server-side path filter, so this is a
  // CLIENT-SIDE filter over the synthesized breadcrumb path (unlike S3's
  // server-pushed prefix). Empty = mirror every file on every shared page.
  {
    key: 'config.import_scope',
    label: 'Page path filter (optional)',
    type: 'text',
    optional: true,
    placeholder: 'Projects/**',
    help:
      'A glob over the page-title breadcrumb (`Projects/**`, `**/*.pdf`) mirrors '
      + 'just matching files. Notion has no server-side path filter, so this is '
      + 'applied after listing. Leave blank to mirror every file on every shared '
      + 'page. Metadata only — file contents are never fetched.',
  },
  // Notion auth is always a single long-lived bearer integration token. Hidden +
  // seeded, mirroring the other vendors' locked `auth.type`.
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['bearer'],
    help: 'Notion uses a single long-lived integration token.',
    hidden: true,
  },
  {
    key: 'auth.token',
    label: 'Integration Token',
    type: 'secret',
    help:
      'An internal integration secret from notion.so/my-integrations (starts '
      + '`ntn_` or `secret_`). Share each page/database you want mirrored WITH the '
      + 'integration — the mirror only sees content shared with it.',
  },
];

/** Initial form values keyed by dotted-path schema key. No base URL (the leaf
 *  targets `api.notion.com` directly) and no token endpoint (not OAuth). */
export const NOTION_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'notion',
  'auth.type': 'bearer',
};

export const notionSchema: VendorConnectionSchema = {
  vendor: 'notion',
  kind: 'api',
  label: 'Notion',
  description:
    'Knowledge base — mirror file/attachment metadata from the Notion pages shared with your integration into your warehouse (bytes never fetched). Long-lived integration-token auth.',
  fields: NOTION_FIELDS,
  initialValues: NOTION_SCHEMA_INITIAL_VALUES,
};

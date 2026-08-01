/** Bluesky / AT Protocol enrollment with a fixed session-auth shape. */

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

export const BLUESKY_API_BASE = 'https://bsky.social';

const BLUESKY_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    placeholder: 'bluesky',
    help: 'Lowercase identifier used in recipes.',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Bluesky',
  },
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    hidden: true,
  },
  {
    key: 'config.base_url',
    label: 'PDS Base URL',
    type: 'url',
    readonly: true,
    help: 'Bluesky session and publishing endpoint, fixed by this pack.',
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['atproto_session'],
    hidden: true,
  },
  {
    key: 'auth.identifier',
    label: 'Handle or DID',
    type: 'text',
    placeholder: 'alice.bsky.social',
  },
  {
    key: 'auth.app_password',
    label: 'App Password',
    type: 'secret',
    help: 'Create an app password in Bluesky settings; do not enter your account password.',
  },
];

export const BLUESKY_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  name: 'bluesky',
  display_name: 'Bluesky',
  'config.vendor': 'bluesky',
  'config.base_url': BLUESKY_API_BASE,
  'auth.type': 'atproto_session',
};

export const blueskySchema: VendorConnectionSchema = {
  vendor: 'bluesky',
  kind: 'api',
  label: 'Bluesky',
  description: 'Publish through Bluesky using your handle and a revocable app password.',
  fields: BLUESKY_FIELDS,
  initialValues: BLUESKY_SCHEMA_INITIAL_VALUES,
};

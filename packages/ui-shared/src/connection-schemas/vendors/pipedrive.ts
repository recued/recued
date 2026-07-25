/** Pipedrive vendor enrollment schema.
 *
 *  First-party CRM vendor shape matching the Pipedrive provider registry entry.
 *  The OAuth code exchange and refresh calls use HTTP Basic client auth; the
 *  hidden `auth.token_auth_style` field persists that behavior onto the
 *  connection auth record after enrollment. */

import {
  PIPEDRIVE_API_BASE,
  PIPEDRIVE_OAUTH_TOKEN_URL,
} from '@recued/contracts';

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const PIPEDRIVE_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `pipedrive`).',
    placeholder: 'pipedrive',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Pipedrive',
  },
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'Pipedrive vendor identifier — locked at enrollment.',
    placeholder: 'pipedrive',
    hidden: true,
  },
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    help: 'Per-company Pipedrive REST root. Captured from the OAuth token response (`api_domain`); global API placeholder shown until OAuth completes.',
    placeholder: PIPEDRIVE_API_BASE,
    readonly: true,
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_refresh'],
    help: 'Pipedrive uses OAuth 2.0 with refresh tokens.',
    hidden: true,
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID',
    type: 'text',
    help: 'From your Pipedrive OAuth app.',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret',
    type: 'secret',
    help: 'From your Pipedrive OAuth app.',
  },
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    placeholder: PIPEDRIVE_OAUTH_TOKEN_URL,
    help: 'Pipedrive OAuth token endpoint — fixed.',
    hidden: true,
  },
  {
    key: 'auth.token_auth_style',
    label: 'Token Auth Style',
    type: 'select',
    options: ['basic'],
    help: 'Pipedrive token refresh uses HTTP Basic client authentication.',
    hidden: true,
  },
  {
    key: 'auth.refresh_token',
    label: 'Refresh Token',
    type: 'secret',
    help: 'Long-lived refresh token from the Pipedrive OAuth flow — populated automatically by the in-app OAuth dance.',
  },
];

export const PIPEDRIVE_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'pipedrive',
  'config.base_url': PIPEDRIVE_API_BASE,
  'auth.type': 'oauth2_refresh',
  'auth.token_endpoint': PIPEDRIVE_OAUTH_TOKEN_URL,
  'auth.token_auth_style': 'basic',
};

export const pipedriveSchema: VendorConnectionSchema = {
  vendor: 'pipedrive',
  kind: 'api',
  label: 'Pipedrive',
  description:
    'CRM platform — deals, people, and organizations. OAuth 2.0 via your own Pipedrive app; catalog-backed reads and approval-gated deal creation.',
  fields: PIPEDRIVE_FIELDS,
  initialValues: PIPEDRIVE_SCHEMA_INITIAL_VALUES,
};

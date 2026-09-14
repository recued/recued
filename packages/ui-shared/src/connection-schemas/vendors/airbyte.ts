/** Airbyte Cloud API enrollment schema.
 *
 *  Airbyte Applications issue a client id + secret. The connection adapter
 *  exchanges them at the fixed token endpoint for a short-lived bearer token;
 *  the secret never enters recipe or ingredient input. */

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

export const AIRBYTE_API_BASE = 'https://api.airbyte.com/v1';
export const AIRBYTE_TOKEN_ENDPOINT = `${AIRBYTE_API_BASE}/applications/token`;

const AIRBYTE_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'A short lower-case name you use in Recipes, such as `airbyte`).',
    placeholder: 'airbyte',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Airbyte Cloud',
  },
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    hidden: true,
  },
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    readonly: true,
    hidden: true,
    help: 'Airbyte Cloud API v1 base URL.',
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_client_credentials'],
    hidden: true,
    help: 'Airbyte Applications use the OAuth 2.0 client-credentials grant.',
  },
  {
    key: 'auth.client_id',
    label: 'Client ID',
    type: 'text',
    help: 'From Airbyte Cloud → Settings → Account → Applications.',
  },
  {
    key: 'auth.client_secret',
    label: 'Client Secret',
    type: 'secret',
    help: 'From the same Airbyte Application. Recued keeps this locked away, and Recipes never see it.',
  },
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    hidden: true,
    readonly: true,
    help: 'Fixed Airbyte access-token endpoint.',
  },
];

export const AIRBYTE_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  name: 'airbyte',
  display_name: 'Airbyte Cloud',
  'config.vendor': 'airbyte',
  'config.base_url': AIRBYTE_API_BASE,
  'auth.type': 'oauth2_client_credentials',
  'auth.token_endpoint': AIRBYTE_TOKEN_ENDPOINT,
};

export const airbyteSchema: VendorConnectionSchema = {
  vendor: 'airbyte',
  kind: 'api',
  label: 'Airbyte',
  description:
    'Data-integration control plane — sources, destinations, connections, jobs, connector definitions, deployment, and access administration.',
  fields: AIRBYTE_FIELDS,
  initialValues: AIRBYTE_SCHEMA_INITIAL_VALUES,
};

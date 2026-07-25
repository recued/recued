/** SMB-finance wedge slice 1b — QuickBooks Online vendor enrollment schema.
 *
 *  Variant of `apiSchema` with QuickBooks-specific pre-filled OAuth fields +
 *  the `config.vendor` discriminator locked to `'quickbooks'`. Differs from
 *  Salesforce in two ways:
 *
 *  1. **Single OAuth endpoint.** QuickBooks shares ONE authorize/token URL
 *     across sandbox + production (no sandbox OAuth-URL split). So
 *     `auth.token_endpoint` is a single fixed hidden field — not the
 *     `showWhen`-paired pair Salesforce needs.
 *  2. **Sandbox flag selects the API HOST.** The `config.sandbox` toggle
 *     picks the QuickBooks REST host (`sandbox-quickbooks` vs `quickbooks`)
 *     via the provider's `realm_base`; the OAuth completion handler composes
 *     `config.base_url = <host>/v3/company/<realmId>` from the callback
 *     `realmId` (QBO returns the realm on the callback, not the token
 *     response — unlike Salesforce's `instance_url`). `config.base_url` is
 *     captured automatically, same readonly channel as Salesforce.
 *
 *  Spec: internal design notes §3 / 1b. */

import {
  CONNECTION_SANDBOX_FLAG_VALUES,
  QUICKBOOKS_API_BASE_PLACEHOLDER,
  QUICKBOOKS_OAUTH_TOKEN_URL,
} from '@recued/contracts';

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const QUICKBOOKS_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `quickbooks`, `quickbooks-sandbox`).',
    placeholder: 'quickbooks',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'QuickBooks Online',
  },
  // Vendor discriminator — locked + hidden (same posture as HubSpot/Salesforce).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'QuickBooks vendor identifier — locked at enrollment.',
    placeholder: 'quickbooks',
    hidden: true,
  },
  // Sandbox/production toggle. QBO shares OAuth URLs across environments;
  // this flag selects the API HOST (via the provider `realm_base`) the
  // completion handler composes config.base_url against. Use "sandbox" with
  // Intuit Development keys + a sandbox company; "production" with Production
  // keys + a real company.
  {
    key: 'config.sandbox',
    label: 'Environment',
    type: 'select',
    options: CONNECTION_SANDBOX_FLAG_VALUES,
    help: 'Pick "sandbox" for Intuit Development keys + a sandbox company, or "production" for Production keys + a real company. Sets the QuickBooks API host.',
  },
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    help: 'Per-company QuickBooks REST root. Captured automatically from the OAuth callback (realmId); placeholder shown until OAuth completes.',
    placeholder: QUICKBOOKS_API_BASE_PLACEHOLDER,
    readonly: true,
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_refresh'],
    help: 'QuickBooks uses OAuth 2.0 with refresh tokens.',
    hidden: true,
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID',
    type: 'text',
    help: 'From your Intuit app — developer.intuit.com → your app → Keys & OAuth → Client ID (use the Development or Production keys matching the environment above).',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret',
    type: 'secret',
    help: 'From your Intuit app — Keys & OAuth → Client Secret.',
  },
  // Single token endpoint — shared across sandbox + production (unlike
  // Salesforce). Fixed + hidden.
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    placeholder: QUICKBOOKS_OAUTH_TOKEN_URL,
    help: 'QuickBooks OAuth 2.0 token endpoint — fixed (shared across environments).',
    hidden: true,
  },
  {
    key: 'auth.refresh_token',
    label: 'Refresh Token',
    type: 'secret',
    help:
      'Long-lived refresh token from the QuickBooks OAuth flow — populated ' +
      'automatically by the in-app OAuth dance.',
  },
];

/** Initial form values keyed by dotted-path schema key. Defaults the sandbox
 *  flag to `production`; the token endpoint is fixed (no toggle dependence). */
export const QUICKBOOKS_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'quickbooks',
  'config.sandbox': 'production',
  'config.base_url': QUICKBOOKS_API_BASE_PLACEHOLDER,
  'auth.type': 'oauth2_refresh',
  'auth.token_endpoint': QUICKBOOKS_OAUTH_TOKEN_URL,
};

export const quickbooksSchema: VendorConnectionSchema = {
  vendor: 'quickbooks',
  kind: 'api',
  label: 'QuickBooks Online',
  description:
    'Accounting & bookkeeping — invoices, bills, expenses, payments, customers, vendors, chart of accounts. OAuth 2.0 via your own Intuit app; sandbox + production companies.',
  fields: QUICKBOOKS_FIELDS,
  initialValues: QUICKBOOKS_SCHEMA_INITIAL_VALUES,
};

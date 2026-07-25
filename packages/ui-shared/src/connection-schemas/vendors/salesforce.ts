/** D-130 Phase 1 — Salesforce vendor enrollment schema.
 *
 *  Variant of `apiSchema` with Salesforce-specific pre-filled OAuth
 *  fields + the `config.vendor` discriminator locked to `'salesforce'`.
 *  Distinct from HubSpot in two material ways:
 *
 *  1. **Sandbox toggle.** Salesforce splits OAuth between
 *     `login.salesforce.com` (production) and `test.salesforce.com`
 *     (sandbox). The form ships a `config.sandbox` `select` with two
 *     options; `resolveVendorOAuthEndpoints` (contracts) reads the
 *     flag at OAuth time. The token endpoint surfaced in the form
 *     uses `showWhen` to render the right URL placeholder for the
 *     active sandbox-flag value — both rows write the same
 *     `auth.token_endpoint` key, so the rpc payload carries a single
 *     value.
 *
 *  2. **Profile-based granted-permission probe.** Salesforce doesn't
 *     echo a useful `scope` set in the token response (it's pinned
 *     to whatever the Connected App declared, not what the connecting
 *     user can actually read). Per-entity readability is profile-based,
 *     verified post-enrollment via per-`Object/describe` probes (P2).
 *     The schema layer captures this only as descriptive help text;
 *     no introspection URL appears on the provider entry.
 *
 *  Spec: D-130 § A.1. */

import {
  CONNECTION_SANDBOX_FLAG_VALUES,
  SALESFORCE_API_BASE_PLACEHOLDER,
  SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
} from '@recued/contracts';

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const isSandboxFlag = (v: string | undefined): boolean =>
  v === 'sandbox';

const isProductionFlag = (v: string | undefined): boolean =>
  v !== 'sandbox';

/** Form fields. Order is intentional — reads top-to-bottom in the
 *  rendered dialog. The `auth.token_endpoint` field appears twice
 *  with mutually exclusive `showWhen` predicates; only one is
 *  visible at a time, mirroring the `auth.value` pattern in
 *  `apiSchema` for header/query auth modes. */
const SALESFORCE_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `salesforce`, `salesforce-sandbox`).',
    placeholder: 'salesforce',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Salesforce Production',
  },
  // Vendor discriminator — locked. Reconciler boot-wire (P2)
  // matches on this. Initial values map sets it to 'salesforce';
  // the form renderer hides it (P1.3 — same posture as HubSpot's
  // `config.vendor` field).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'Salesforce vendor identifier — locked at enrollment.',
    placeholder: 'salesforce',
    hidden: true,
  },
  // Sandbox/production toggle. The user picks at enrollment time;
  // the OAuth code-exchange rpc receives the flag and routes the
  // token endpoint accordingly. The runtime adapter reads
  // `config.sandbox` for any subsequent vendor-side calls that
  // need the environment hint (none today — the per-org base URL
  // captured from `instance_url` is sufficient).
  {
    key: 'config.sandbox',
    label: 'Environment',
    type: 'select',
    options: CONNECTION_SANDBOX_FLAG_VALUES,
    help: 'Pick the org type your Salesforce Connected App was registered against. Sandbox apps cannot mint tokens against a production org and vice versa.',
  },
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    help: 'Per-org Salesforce REST root. Captured from the OAuth token response (`instance_url`); placeholder shown until OAuth completes.',
    placeholder: SALESFORCE_API_BASE_PLACEHOLDER,
    readonly: true,
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['oauth2_refresh'],
    help: 'Salesforce uses OAuth 2.0 with refresh tokens.',
    hidden: true,
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID',
    type: 'text',
    help: 'From your Salesforce Connected App — Setup → App Manager → View → Manage Consumer Details → Consumer Key.',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret',
    type: 'secret',
    help: 'From your Salesforce Connected App — Setup → App Manager → View → Manage Consumer Details → Consumer Secret.',
  },
  // Fork 1 B — editable, pre-filled OAuth scopes (Salesforce defaults ∪ the
  // scopes your installed packs need). Blank → the server requests its
  // defaults + the installed-pack union itself; const essentials are a
  // non-trimmable floor server-side.
  {
    key: 'auth.scopes',
    label: 'Scopes',
    type: 'text',
    optional: true,
    help:
      'OAuth scopes requested at authorization. Pre-filled from Salesforce\'s '
      + 'defaults plus the scopes your installed packs need — edit to add or trim.',
  },
  // Token endpoint — paired with `config.sandbox`. The renderer
  // shows whichever row matches the active sandbox-flag value.
  // Both write `auth.token_endpoint` so the rpc payload carries a
  // single resolved value.
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    placeholder: SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
    help: 'Salesforce production token endpoint — fixed.',
    showWhen: (v) => isProductionFlag(v['config.sandbox']),
    hidden: true,
  },
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint (Sandbox)',
    type: 'url',
    placeholder: SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
    help: 'Salesforce sandbox token endpoint — fixed.',
    showWhen: (v) => isSandboxFlag(v['config.sandbox']),
    hidden: true,
  },
  {
    key: 'auth.refresh_token',
    label: 'Refresh Token',
    type: 'secret',
    help:
      'Long-lived refresh token from the Salesforce OAuth flow. ' +
      'P1.2 will populate this automatically via the in-app OAuth dance; ' +
      'until then paste a token obtained out-of-band.',
  },
];

/** Initial form values keyed by their dotted-path schema key. The
 *  Settings → Connections dialog seeds the `values` state with this
 *  when opening the Salesforce enrollment form so locked / pre-filled
 *  fields render with the correct content from the start.
 *
 *  Defaults to `production` for the sandbox flag — the renderer
 *  picks the production token-endpoint placeholder until the user
 *  flips the toggle. P1.3 dialog rendering re-derives the
 *  `auth.token_endpoint` value when the user switches the toggle so
 *  the rpc payload carries the right URL without manual editing. */
export const SALESFORCE_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'salesforce',
  'config.sandbox': 'production',
  'config.base_url': SALESFORCE_API_BASE_PLACEHOLDER,
  'auth.type': 'oauth2_refresh',
  'auth.token_endpoint': SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
};

export const salesforceSchema: VendorConnectionSchema = {
  vendor: 'salesforce',
  kind: 'api',
  label: 'Salesforce',
  description:
    'CRM platform — opportunities, contacts, accounts. OAuth + CometD streaming acceleration via the user\'s own Salesforce Connected App. Sandbox + production orgs.',
  fields: SALESFORCE_FIELDS,
  initialValues: SALESFORCE_SCHEMA_INITIAL_VALUES,
  // Probe lands once P1.2 ships the OAuth code-exchange rpc — the
  // probe will exercise an authenticated GET against
  // `/services/data/<v>/sobjects/Opportunity/describe` to verify
  // both the token round-trip + the user's Profile permits
  // Opportunity reads (P2 reconciler-registration gate).
};

/** D-129 Phase 1 — HubSpot vendor enrollment schema.
 *
 *  Variant of `apiSchema` with HubSpot-specifics pre-filled + the
 *  `config.vendor` discriminator locked to `'hubspot'`. Two auth modes,
 *  picked by `auth.type` (the `showWhen` predicates reveal only the chosen
 *  mode's fields + drop the other's from the payload):
 *    - `bearer` (DEFAULT, recommended) — a HubSpot **Service Key** (Settings
 *      → Integrations → Service Keys), HubSpot's recommended credential for
 *      data-only integrations: paste one field, no OAuth app. Static Bearer.
 *    - `oauth2_refresh` — a BYO OAuth app (client_id + client_secret from the
 *      HubSpot Developer Portal). The OAuth code-exchange flow (P1.2) fills
 *      `auth.refresh_token`; until then paste a refresh token out-of-band.
 *
 *  Fields with `readonly: true` aren't editable in the form but are
 *  still projected into the rpc payload — this lets the schema lock
 *  identity-bearing fields like `config.vendor` so the reconciler
 *  boot-wire (P2) reliably matches `kind === 'api' && config.vendor
 *  === 'hubspot'` without depending on user-typed content.
 *
 *  Spec: D-129 § A.1. */

import {
  HUBSPOT_API_BASE,
  HUBSPOT_OAUTH_TOKEN_URL,
} from '@recued/contracts';

import type { ConnectionField, ConnectionFormValues, ConnectionSchema } from '../types.js';

/** `showWhen` predicate keyed on the selected `auth.type` (mirrors the base
 *  `api.ts` schema). A field hidden by this is excluded from the rpc payload
 *  too, so switching auth modes never smuggles the other mode's creds. */
const ifAuth = (type: string): ((v: ConnectionFormValues) => boolean) =>
  (v) => (v['auth.type'] ?? 'bearer') === type;

/** D-129 — vendor-flavored ConnectionSchema. Carries one extra field
 *  beyond the base ConnectionSchema shape: `vendor`, the canonical
 *  vendor segment matching `connection-vendor-providers.ts`. The
 *  Settings → Connections page picker (P1.3) reads this to render
 *  vendor-flavored "+ Add HubSpot" cards alongside the bare
 *  CONNECTION_KIND_CHOICES. */
export interface VendorConnectionSchema extends ConnectionSchema {
  vendor: string;
  /** D-192 S5 — the initial form-values map seeded when the enrollment
   *  dialog opens (locked discriminators, pre-filled base URL + endpoints).
   *  Attaching it here makes each schema self-describing, so
   *  `initialVendorSchemaValues` is a registry lookup instead of a per-vendor
   *  if-chain. Optional for forward-compat; a schema without it seeds `{}`. */
  initialValues?: Readonly<Record<string, string>>;
}

/** Form fields. Order is intentional — reads top-to-bottom in the
 *  rendered dialog. Hidden fields (`config.vendor`, `auth.type`,
 *  `auth.token_endpoint`) aren't user-editable but are
 *  projected into the rpc payload via the existing
 *  `projectConnectionPayload` walker. */
const HUBSPOT_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `hubspot`, `hubspot-sandbox`).',
    placeholder: 'hubspot',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'HubSpot Production',
  },
  // Vendor discriminator — locked. Reconciler boot-wire (P2) matches
  // on this. The renderer hides it while the projection still carries
  // the initial value into the rpc payload.
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'HubSpot vendor identifier — locked at enrollment.',
    placeholder: 'hubspot',
    hidden: true,
  },
  {
    key: 'config.base_url',
    label: 'Base URL',
    type: 'url',
    help: 'HubSpot REST root. Override only for non-standard regional instances.',
    placeholder: HUBSPOT_API_BASE,
  },
  // Two ways to authenticate HubSpot. `bearer` = a Service Key (HubSpot's
  // recommended credential for data-only integrations, sent as
  // `Authorization: Bearer`); `oauth2_refresh` = a BYO OAuth app. The `ifAuth`
  // predicates below show only the picked mode's fields (+ drop the other's
  // from the payload).
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    // `bearer` (Service Key) first → the default + recommended path.
    options: ['bearer', 'oauth2_refresh'],
    help: 'Service Key (recommended for data integrations) or your own OAuth app.',
  },
  // Service Key (bearer) — the recommended path.
  {
    key: 'auth.token',
    label: 'Service Key',
    type: 'secret',
    showWhen: ifAuth('bearer'),
    help:
      'A HubSpot Service Key — Settings → Integrations → Service Keys (Super Admin / '
      + 'Developer tools). The recommended credential for data-only integrations; '
      + 'sent as `Authorization: Bearer` and static (rotate manually, no OAuth refresh).',
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID',
    type: 'text',
    showWhen: ifAuth('oauth2_refresh'),
    help: 'From your HubSpot Developer Portal app — Auth → Client ID.',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret',
    type: 'secret',
    showWhen: ifAuth('oauth2_refresh'),
    help: 'From your HubSpot Developer Portal app — Auth → Client secret.',
  },
  // Fork 1 B — editable, pre-filled OAuth scopes. The panel seeds this on
  // dialog-open with HubSpot's vendor defaults UNIONed with the scopes your
  // installed packs need (so a pack's write op is requested), and the user can
  // trim the pack additions. Left blank → the server requests its defaults +
  // the installed-pack union itself (Fork 1 A). The const essentials are a
  // non-trimmable floor server-side, so trimming them here is a no-op.
  {
    key: 'auth.scopes',
    label: 'Scopes',
    type: 'text',
    optional: true,
    showWhen: ifAuth('oauth2_refresh'),
    help:
      'OAuth scopes requested at authorization. Pre-filled from HubSpot\'s '
      + 'defaults plus the scopes your installed packs need — edit to add or trim.',
  },
  {
    key: 'auth.token_endpoint',
    label: 'Token Endpoint',
    type: 'url',
    showWhen: ifAuth('oauth2_refresh'),
    help: 'HubSpot OAuth token endpoint — fixed.',
    placeholder: HUBSPOT_OAUTH_TOKEN_URL,
    hidden: true,
  },
  {
    key: 'auth.refresh_token',
    label: 'Refresh Token',
    type: 'secret',
    // Filled by the OAuth dance (`applyVendorOAuthResultValues`), never typed.
    autofilled: true,
    showWhen: ifAuth('oauth2_refresh'),
    help:
      'Long-lived refresh token from the HubSpot OAuth flow. ' +
      'P1.2 will populate this automatically via the in-app OAuth dance; ' +
      'until then paste a token obtained from the HubSpot Developer Portal.',
  },
];

/** Initial form values keyed by their dotted-path schema key. The
 *  Settings → Connections dialog seeds the `values` state with this
 *  when opening the HubSpot enrollment form so locked / pre-filled
 *  fields render with the correct content from the start. */
export const HUBSPOT_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 'hubspot',
  'config.base_url': HUBSPOT_API_BASE,
  // Default to the Service Key (bearer) path — HubSpot's recommended credential
  // for data integrations. `token_endpoint` stays seeded so switching to the
  // OAuth mode renders the fixed endpoint without a re-seed.
  'auth.type': 'bearer',
  'auth.token_endpoint': HUBSPOT_OAUTH_TOKEN_URL,
};

export const hubspotSchema: VendorConnectionSchema = {
  vendor: 'hubspot',
  kind: 'api',
  label: 'HubSpot',
  description:
    'CRM platform — deals, contacts, companies. OAuth + webhook acceleration via the user\'s own HubSpot Developer Portal app.',
  fields: HUBSPOT_FIELDS,
  initialValues: HUBSPOT_SCHEMA_INITIAL_VALUES,
  // Probe lands once P1.2 ships the OAuth code-exchange rpc — the
  // probe will exercise an authenticated GET against /crm/v3/objects/
  // deals?limit=1 to verify the token + scopes round-trip end-to-end.
  // Omitted at P1.1 so the dialog doesn't render a "Will run probe"
  // hint that wouldn't actually fire.
};

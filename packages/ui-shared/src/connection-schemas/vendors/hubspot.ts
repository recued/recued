/** D-129 Phase 1 — HubSpot vendor enrollment schema.
 *
 *  Variant of `apiSchema` with HubSpot-specifics pre-filled + the
 *  `config.vendor` discriminator locked to `'hubspot'`. Two auth modes,
 *  picked by `auth.type` (the `showWhen` predicates reveal only the chosen
 *  mode's fields + drop the other's from the payload):
 *    - `bearer` (DEFAULT, recommended) — a HubSpot **Service Key**
 *      (Development → Keys → Service keys), HubSpot's recommended credential
 *      for data-only integrations: paste one field, no OAuth app, no redirect
 *      URL, so it works from any page address. Static Bearer.
 *    - `oauth2_refresh` — a BYO OAuth app. HubSpot's developer platform makes
 *      one only through its CLI (`hs project create`), which is why it is the
 *      advanced path. The in-app Authorize flow fills `auth.refresh_token`.
 *
 *  `auth.type` is the onboarding selector: each mode gets its own setup
 *  guide (`HUBSPOT_ONBOARDING`), as the messenger forms do for theirs.
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
  HUBSPOT_OAUTH_SCOPES,
  HUBSPOT_OAUTH_TOKEN_URL,
} from '@recued/contracts';

import type {
  ConnectionField,
  ConnectionFormValues,
  ConnectionOnboarding,
  ConnectionSchema,
} from '../types.js';

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
    help: 'A short lower-case name you use in Recipes, such as `hubspot`, `hubspot-sandbox`).',
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
    help: 'HubSpot sets this when you connect. You cannot change it.',
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
  // from the payload). The option labels are what a non-technical owner
  // chooses between — never the raw auth-type names.
  {
    key: 'auth.type',
    label: 'How to connect',
    type: 'select',
    // `bearer` (Service Key) first → the default + recommended path.
    options: ['bearer', 'oauth2_refresh'],
    optionLabels: {
      bearer: 'Service Key (recommended)',
      oauth2_refresh: 'Your own HubSpot app (advanced)',
    },
    help: 'A Service Key is the easy way. Making your own app takes HubSpot’s command-line tool.',
  },
  // Service Key (bearer) — the recommended path.
  {
    key: 'auth.token',
    label: 'Service Key',
    type: 'secret',
    showWhen: ifAuth('bearer'),
    help: 'Paste the key from Development → Keys → Service keys in HubSpot.',
  },
  {
    key: 'auth.client_id',
    label: 'OAuth Client ID',
    type: 'text',
    showWhen: ifAuth('oauth2_refresh'),
    help: 'From your app’s Auth tab in HubSpot (run hs project open to get there).',
  },
  {
    key: 'auth.client_secret',
    label: 'OAuth Client Secret',
    type: 'secret',
    showWhen: ifAuth('oauth2_refresh'),
    help: 'From the same Auth tab, under Client credentials.',
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
      'What Recued asks permission for. Filled in from HubSpot\'s '
      + 'own defaults, plus whatever your installed Packs need. You can add or remove.',
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
    help: 'Filled in when you click Authorize and approve in HubSpot.',
  },
];

/** The scopes a Service Key needs for what Recued reads by default. `oauth` is
 *  an OAuth-app scope with nothing to tick on a key, so it is left out. A
 *  pack's write scopes are added by the owner when a pack needs them. */
const SERVICE_KEY_SCOPES = HUBSPOT_OAUTH_SCOPES.filter((scope) => scope !== 'oauth');

/** One setup guide per way to connect, swapped by `auth.type`. The steps
 *  follow HubSpot's own docs as of 2026-10-08: Service keys under
 *  Development → Keys, and apps made only with the HubSpot CLI. */
const HUBSPOT_ONBOARDING: ConnectionOnboarding = {
  selectorKey: 'auth.type',
  guides: [
    {
      key: 'hubspot-service-key',
      tone: 'recommended',
      badge: 'Recommended · easiest',
      title: 'Connect HubSpot with a Service Key',
      description:
        'You make a key in your HubSpot account and paste it here. There is no app to build '
        + 'and no sign-in step, so it works from any address.',
      portal: {
        label: 'HubSpot’s Service Key guide',
        url: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys',
      },
      steps: [
        {
          title: 'Open Service keys in HubSpot',
          detail: 'Development → Keys → Service keys. You need to be a Super Admin, '
            + 'or have the Developer tools permission.',
        },
        {
          title: 'Create the key',
          detail: 'Click Create service key and give it a name, such as Recued.',
        },
        {
          title: 'Tick its scopes',
          detail: `Click Add new scope and tick ${SERVICE_KEY_SCOPES.join(', ')}. `
            + 'If a Pack will change HubSpot records, tick the write scopes it names too.',
        },
        {
          title: 'Paste it below',
          detail: 'Copy the key into Service Key, then Save.',
        },
      ],
      verification:
        'Reads your HubSpot account details with the key, so a wrong or revoked key shows '
        + 'at once. It cannot see which scopes the key has: a missing one shows when a Pack first needs it.',
      note:
        'HubSpot suggests replacing a Service Key every six months. When you do, paste the new '
        + 'key into this same connection.',
      showWhen: (values) => (values['auth.type'] ?? 'bearer') === 'bearer',
    },
    {
      key: 'hubspot-app',
      tone: 'advanced',
      badge: 'Advanced · needs HubSpot’s command-line tool',
      title: 'Connect HubSpot with your own app',
      description:
        'You build a small app in HubSpot and sign in through it. In return, Recued sees '
        + 'which scopes HubSpot granted.',
      portal: {
        label: 'HubSpot’s guide to creating an app',
        url: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/create-an-app',
      },
      steps: [
        {
          title: 'Create the app with the HubSpot CLI',
          detail: 'Install the HubSpot CLI and run hs account auth. Then run hs project create, '
            + 'choose App, and pick OAuth.',
        },
        {
          title: 'Add the redirect URL and scopes',
          detail: 'In the app’s app-hsmeta.json, put the redirect URL shown below into '
            + 'redirectUrls, and the Scopes below into requiredScopes. Then run hs project upload.',
        },
        {
          title: 'Copy the client ID and secret',
          detail: 'Run hs project open, open your app, then its Auth tab. Paste both values below.',
        },
        {
          title: 'Authorize, then Save',
          detail: 'Click Authorize and approve in HubSpot. Recued fills in the rest.',
        },
      ],
      verification:
        'Authorize swaps HubSpot’s sign-in for a token and records the scopes it granted. '
        + 'Save then reads your HubSpot account details with that token.',
      showWhen: (values) => values['auth.type'] === 'oauth2_refresh',
    },
  ],
};

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
    'CRM platform — deals, contacts, companies. Connect with a Service Key, or with your own HubSpot app.',
  fields: HUBSPOT_FIELDS,
  initialValues: HUBSPOT_SCHEMA_INITIAL_VALUES,
  onboarding: HUBSPOT_ONBOARDING,
  // Probe lands once P1.2 ships the OAuth code-exchange rpc — the
  // probe will exercise an authenticated GET against /crm/v3/objects/
  // deals?limit=1 to verify the token + scopes round-trip end-to-end.
  // Omitted at P1.1 so the dialog doesn't render a "Will run probe"
  // hint that wouldn't actually fire.
};

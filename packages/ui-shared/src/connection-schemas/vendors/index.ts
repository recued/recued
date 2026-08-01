/** D-129 Phase 1 — vendor-flavored connection schema registry.
 *
 *  Vendor schemas extend the bare `apiSchema` with vendor-specific
 *  pre-filled OAuth + base-URL fields and a locked `config.vendor`
 *  discriminator. The Settings → Connections page picker (P1.3) reads
 *  this registry to render "+ Add HubSpot" cards alongside the bare
 *  CONNECTION_KIND_CHOICES.
 *
 *  D-129 ships HubSpot only; D-130 appends Salesforce. Post-launch
 *  certified-vendor program adds entries through a separate review
 *  path (each vendor schema lands here paired with its
 *  `ConnectionVendorProvider` entry in
 *  `@recued/contracts/connection-vendor-providers`).
 *
 *  Spec: D-129 § A.1. */

import {
  getVendorProvider,
  resolveVendorOAuthEndpoints,
} from '@recued/contracts';
import { hubspotSchema, type VendorConnectionSchema } from './hubspot.js';
import { salesforceSchema } from './salesforce.js';
import { pipedriveSchema } from './pipedrive.js';
import { quickbooksSchema } from './quickbooks.js';
import { googleSchema } from './google.js';
import { dropboxSchema } from './dropbox.js';
import { onedriveSchema } from './onedrive.js';
import { boxSchema } from './box.js';
import { sharepointSchema } from './sharepoint.js';
import { s3Schema } from './s3.js';
import { notionSchema } from './notion.js';
import { airbyteSchema } from './airbyte.js';
import { tavilySchema } from './tavily.js';
import { tradingviewUdfSchema } from './tradingview-udf.js';
import { blueskySchema } from './bluesky.js';
import type { ConnectionFormValues } from '../types.js';

export {
  hubspotSchema,
  HUBSPOT_SCHEMA_INITIAL_VALUES,
  type VendorConnectionSchema,
} from './hubspot.js';
export {
  salesforceSchema,
  SALESFORCE_SCHEMA_INITIAL_VALUES,
} from './salesforce.js';
export {
  pipedriveSchema,
  PIPEDRIVE_SCHEMA_INITIAL_VALUES,
} from './pipedrive.js';
export {
  quickbooksSchema,
  QUICKBOOKS_SCHEMA_INITIAL_VALUES,
} from './quickbooks.js';
export {
  googleSchema,
  GOOGLE_SCHEMA_INITIAL_VALUES,
} from './google.js';
export {
  dropboxSchema,
  DROPBOX_SCHEMA_INITIAL_VALUES,
} from './dropbox.js';
export {
  onedriveSchema,
  ONEDRIVE_SCHEMA_INITIAL_VALUES,
} from './onedrive.js';
export {
  boxSchema,
  BOX_SCHEMA_INITIAL_VALUES,
} from './box.js';
export {
  sharepointSchema,
  SHAREPOINT_SCHEMA_INITIAL_VALUES,
} from './sharepoint.js';
export {
  s3Schema,
  S3_SCHEMA_INITIAL_VALUES,
} from './s3.js';
export {
  notionSchema,
  NOTION_SCHEMA_INITIAL_VALUES,
} from './notion.js';
export {
  airbyteSchema,
  AIRBYTE_API_BASE,
  AIRBYTE_TOKEN_ENDPOINT,
  AIRBYTE_SCHEMA_INITIAL_VALUES,
} from './airbyte.js';
export {
  tavilySchema,
  TAVILY_API_BASE,
  TAVILY_SCHEMA_INITIAL_VALUES,
} from './tavily.js';
export {
  tradingviewUdfSchema,
  TRADINGVIEW_UDF_DEMO_BASE,
  TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES,
} from './tradingview-udf.js';
export {
  blueskySchema,
  BLUESKY_API_BASE,
  BLUESKY_SCHEMA_INITIAL_VALUES,
} from './bluesky.js';

/** Closed list keyed on canonical vendor segment. Insertion order
 *  drives the picker rendering. */
export const VENDOR_CONNECTION_SCHEMAS = {
  hubspot: hubspotSchema,
  salesforce: salesforceSchema,
  pipedrive: pipedriveSchema,
  quickbooks: quickbooksSchema,
  google: googleSchema,
  dropbox: dropboxSchema,
  onedrive: onedriveSchema,
  box: boxSchema,
  sharepoint: sharepointSchema,
  s3: s3Schema,
  notion: notionSchema,
  airbyte: airbyteSchema,
  tavily: tavilySchema,
  tradingview_udf: tradingviewUdfSchema,
  bluesky: blueskySchema,
} as const;

export type KnownVendor = keyof typeof VENDOR_CONNECTION_SCHEMAS;

/** Look up a vendor schema by canonical segment. Returns `undefined`
 *  when the vendor isn't registered — callers surface that as a
 *  user-visible "vendor not supported" error mirroring the
 *  `resolveConnectionSchema` contract. */
export const resolveVendorSchema = (
  vendor: string,
): import('./hubspot.js').VendorConnectionSchema | undefined => {
  if (vendor in VENDOR_CONNECTION_SCHEMAS) {
    return VENDOR_CONNECTION_SCHEMAS[vendor as KnownVendor];
  }
  return undefined;
};

/** Initial form-values map for a vendor's enrollment form. Reads the
 *  `initialValues` attached to the vendor's schema (D-192 S5), so adding a
 *  vendor is one registry entry — no per-vendor branch here. Returns `{}` for
 *  an unknown vendor (or a schema without initial values) so callers can spread
 *  unconditionally without a presence check. */
export const initialVendorSchemaValues = (
  vendor: string,
): Readonly<Record<string, string>> =>
  resolveVendorSchema(vendor)?.initialValues ?? {};

export const isVendorSandboxSelected = (
  values: Record<string, string | undefined>,
): boolean =>
  values['config.sandbox'] === 'sandbox';

/** Keep the hidden `auth.token_endpoint` form value aligned with the
 *  vendor environment toggle. This matters for Salesforce, where the
 *  user can flip production/sandbox after initial values have already
 *  seeded the production endpoint. */
export const syncVendorOAuthEndpointValue = (
  vendor: string | null | undefined,
  values: ConnectionFormValues,
): ConnectionFormValues => {
  const provider = vendor ? getVendorProvider(vendor) : null;
  if (!provider) return values;
  const { token_endpoint } = resolveVendorOAuthEndpoints(provider, {
    sandbox: isVendorSandboxSelected(values),
  });
  if (values['auth.token_endpoint'] === token_endpoint) return values;
  return { ...values, 'auth.token_endpoint': token_endpoint };
};

export interface VendorOAuthResultValuePatch {
  refresh_token: string;
  instance_url?: string;
}

/** Merge a successful vendor OAuth exchange back into form values. The
 *  optional `sandbox` argument lets callers preserve the environment
 *  used to launch the OAuth flow even if the form changed while the
 *  popup was open. */
export const applyVendorOAuthResultValues = (
  vendor: string | null | undefined,
  values: ConnectionFormValues,
  result: VendorOAuthResultValuePatch,
  opts: { sandbox?: boolean } = {},
): ConnectionFormValues => {
  const provider = vendor ? getVendorProvider(vendor) : null;
  let next: ConnectionFormValues = {
    ...values,
    'auth.refresh_token': result.refresh_token,
  };

  if (provider) {
    const sandbox = opts.sandbox ?? isVendorSandboxSelected(values);
    const { token_endpoint } = resolveVendorOAuthEndpoints(provider, { sandbox });
    const carriesSandboxFlag =
      values['config.sandbox'] !== undefined ||
      provider.oauth.sandbox_authorize_url !== undefined ||
      provider.oauth.sandbox_token_endpoint !== undefined;
    next = {
      ...next,
      'auth.token_endpoint': token_endpoint,
      ...(carriesSandboxFlag
        ? { 'config.sandbox': sandbox ? 'sandbox' : 'production' }
        : {}),
    };
  }

  if (result.instance_url) {
    next['config.base_url'] = result.instance_url;
  }
  return next;
};

/** Picker rows for the vendor cards rendered alongside the bare
 *  CONNECTION_KIND_CHOICES on the Settings → Connections kind picker.
 *  Each entry renders as a card; clicking jumps the dialog directly
 *  to the form stage (skipping subtype-picker — vendors are always
 *  kind=api). */
export const VENDOR_CONNECTION_CHOICES: ReadonlyArray<{
  vendor: KnownVendor;
  label: string;
  description: string;
}> = (
  Object.entries(VENDOR_CONNECTION_SCHEMAS) as ReadonlyArray<
    [KnownVendor, VendorConnectionSchema]
  >
).map(([vendor, schema]) => ({
  vendor,
  label: schema.label,
  description: schema.description,
}));

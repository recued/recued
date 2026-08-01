/** D-125 P7.2 — connection enrollment schemas barrel.
 *
 *  Three kinds × subtypes flatten into one resolveSchema(kind, subtype)
 *  helper so callers (the Settings → Connections enrollment dialog AND
 *  the recipe-install pre-fill path) ride a single API. */

export type {
  ConnectionField,
  ConnectionFieldType,
  ConnectionFormValues,
  ConnectionProbeSpec,
  ConnectionSchema,
} from './types.js';
export { collectHeaderRows, type HeaderRow } from './header-list.js';
export {
  collectMatchPatternRows,
  matchPatternRowsToPatterns,
  isCompleteMatchPatternRow,
  isHalfFilledMatchPatternRow,
  type MatchPatternRow,
} from './match-pattern-list.js';

export { apiSchema } from './api.js';
export { mcpSchemas, type McpSubtype } from './mcp.js';
export {
  notificationSchemas,
  MAIL_SEND_CAPABLE_INSTANCES_SOURCE,
  type NotificationSubtype,
} from './notification.js';
// D-129 P1 — vendor-flavored schemas (HubSpot at D-129; Salesforce at D-130).
export {
  VENDOR_CONNECTION_SCHEMAS,
  VENDOR_CONNECTION_CHOICES,
  resolveVendorSchema,
  initialVendorSchemaValues,
  isVendorSandboxSelected,
  syncVendorOAuthEndpointValue,
  applyVendorOAuthResultValues,
  hubspotSchema,
  HUBSPOT_SCHEMA_INITIAL_VALUES,
  salesforceSchema,
  SALESFORCE_SCHEMA_INITIAL_VALUES,
  pipedriveSchema,
  PIPEDRIVE_SCHEMA_INITIAL_VALUES,
  quickbooksSchema,
  QUICKBOOKS_SCHEMA_INITIAL_VALUES,
  googleSchema,
  GOOGLE_SCHEMA_INITIAL_VALUES,
  dropboxSchema,
  DROPBOX_SCHEMA_INITIAL_VALUES,
  onedriveSchema,
  ONEDRIVE_SCHEMA_INITIAL_VALUES,
  boxSchema,
  BOX_SCHEMA_INITIAL_VALUES,
  sharepointSchema,
  SHAREPOINT_SCHEMA_INITIAL_VALUES,
  s3Schema,
  S3_SCHEMA_INITIAL_VALUES,
  notionSchema,
  NOTION_SCHEMA_INITIAL_VALUES,
  airbyteSchema,
  AIRBYTE_API_BASE,
  AIRBYTE_TOKEN_ENDPOINT,
  AIRBYTE_SCHEMA_INITIAL_VALUES,
  tavilySchema,
  TAVILY_API_BASE,
  TAVILY_SCHEMA_INITIAL_VALUES,
  tradingviewUdfSchema,
  TRADINGVIEW_UDF_DEMO_BASE,
  TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES,
  blueskySchema,
  BLUESKY_API_BASE,
  BLUESKY_SCHEMA_INITIAL_VALUES,
  type KnownVendor,
  type VendorConnectionSchema,
  type VendorOAuthResultValuePatch,
} from './vendors/index.js';

import { MESSENGER_VENDOR_SLUGS, getMessengerVendorDeclaration } from '@recued/contracts';

import type { ConnectionSchema } from './types.js';
import { apiSchema } from './api.js';
import { mcpSchemas } from './mcp.js';
import { notificationSchemas } from './notification.js';
import {
  resolveVendorSchema as _resolveVendorSchema,
} from './vendors/index.js';

/** Look up the schema for a (kind, subtype, vendor?) triple. Vendor
 *  flavoring (D-129 P1) takes precedence — when `vendor` is set and
 *  registered, returns the vendor-flavored schema regardless of
 *  `subtype`. Bare `kind: 'api'` ignores subtype (HTTP is the only
 *  protocol). Returns `undefined` for an unknown combination —
 *  callers surface that as a user-visible "schema not found for X/Y"
 *  inline error. */
export const resolveConnectionSchema = (
  kind: 'api' | 'mcp' | 'notification',
  subtype?: string,
  vendor?: string,
): ConnectionSchema | undefined => {
  if (vendor) {
    const vendorSchema = _resolveVendorSchema(vendor);
    // Vendor schema only honored when its declared `kind` matches the
    // requested kind — `('mcp', 'sse', 'hubspot')` is a mismatched
    // call and falls through to bare mcp resolution rather than
    // returning a kind=api schema. Unregistered vendors also fall
    // through (a stale install registry still gets a usable form).
    if (vendorSchema && vendorSchema.kind === kind) return vendorSchema;
  }
  if (kind === 'api') return apiSchema;
  if (kind === 'mcp') {
    if (subtype && subtype in mcpSchemas) {
      return mcpSchemas[subtype as keyof typeof mcpSchemas];
    }
    return undefined;
  }
  if (kind === 'notification') {
    if (subtype && subtype in notificationSchemas) {
      return notificationSchemas[subtype as keyof typeof notificationSchemas];
    }
    return undefined;
  }
  return undefined;
};

/** Picker rows for the kind step. The dialog renders these as
 *  three top-level cards before drilling into a per-subtype form. */
export const CONNECTION_KIND_CHOICES = [
  {
    kind: 'api' as const,
    label: 'HTTP API',
    description: 'Connect to an online app or service through its web API.',
  },
  {
    kind: 'mcp' as const,
    label: 'MCP Server',
    description: 'Connect to an MCP server — a service that gives Recued tools it can use.',
  },
  {
    kind: 'notification' as const,
    label: 'Notification',
    // Derived so the blurb cannot go stale when a chat transport is declared.
    description: `${[
      ...MESSENGER_VENDOR_SLUGS.map((v) => getMessengerVendorDeclaration(v)?.display_name ?? v),
      'Email',
      'in-app',
    ].join(' / ')} destinations.`,
  },
];

/** Subtype picker rows. `api` carries no subtypes — the dialog skips
 *  the second picker step when kind=api. */
export const CONNECTION_SUBTYPE_CHOICES: Record<
  'mcp' | 'notification',
  ReadonlyArray<{ subtype: string; label: string; description: string }>
> = {
  mcp: [
    { subtype: 'sse', label: 'Server-Sent Events', description: mcpSchemas.sse.description },
    { subtype: 'websocket', label: 'WebSocket', description: mcpSchemas.websocket.description },
    { subtype: 'stdio', label: 'stdio (subprocess)', description: mcpSchemas.stdio.description },
  ],
  // D-192 seam 10 — the chat-transport rows are DERIVED (label = the registry's
  // `display_name`), so declaring a vendor gives it an enroll card with no edit
  // here. `email` + `in-app` are not chat transports, so they stay literal.
  notification: [
    ...MESSENGER_VENDOR_SLUGS.map((vendor) => ({
      subtype: vendor,
      // The boot cross-check guarantees a declaration for every slug, so the
      // fallback is unreachable — it exists only to satisfy the nullable accessor.
      label: getMessengerVendorDeclaration(vendor)?.display_name ?? vendor,
      description: notificationSchemas[vendor].description,
    })),
    { subtype: 'email', label: 'Email', description: notificationSchemas.email.description },
    { subtype: 'in-app', label: 'In-app', description: notificationSchemas['in-app'].description },
  ],
};

/** Connection-name regex applied at the form. Mirrors the rule
 *  `collection.connection.enroll` enforces server-side: lowercase
 *  alphanumerics + dashes, 1–48 chars. */
export const CONNECTION_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** D-125 Phase 2.1 — rpc handlers for `collection.connection.*`.
 *  D-125 Phase 2.2 — at-rest auth encryption swapped to AEAD via the
 *  `connection` HKDF sub-DEK; the pair-sync WS rpc ships the same
 *  ciphertext blob unchanged (pair clients hold the sub-DEK derivation
 *  inputs; the server is the storage authority).
 *
 *  Five methods: list / enroll / update / delete / probe. Server is
 *  authoritative — the durable SQLite row lives in `storage/
 *  connection-store.ts`; paired clients mirror via the pair sync wire.
 *  Pair sync rides on `contract.connection_record.*` (sync_transport:
 *  'pair' per D-166). D-168 retired cloud sync entirely — there is no
 *  cloud `/v1/sync` route.
 *
 *  Auth handling: the rpc accepts `ConnectionAuth` plaintext over
 *  the secure pair channel. `encodeAuthForStorage` AEAD-encrypts under
 *  the connection sub-DEK (`recued/v1/sub-dek/connection`) with AAD
 *  bound to `${kind}/${name}` so blobs cannot be moved between rows.
 *  The wire format is `iv || ct` packed and base64-encoded — same
 *  shape every other AEAD store on the server uses. When the deps
 *  omit `getEncryptionKey` entirely (dbless harnesses, the
 *  uninitialized FileVault state), the function falls back to the
 *  P2.1 base64-JSON placeholder so test fixtures and brand-new
 *  installs continue to round-trip without a Master DEK in scope.
 *  When `getEncryptionKey` is present but returns null (FileVault
 *  locked), the call throws `locked` — matching the discipline every
 *  other sub-DEK consumer enforces (blob-store, sqlite-cache-store).
 *  The `connectionViewFromRow` projection on read paths strips this
 *  field regardless, so plaintext never appears in `ConnectionView`
 *  responses.
 *
 *  Probe is per-kind in spec § 2.4 (api / mcp / notification with
 *  subtype branches). Enrollment stamps the honest pre-probe baseline
 *  (`unknown`); `collection.connection.probe` performs the live check and
 *  replaces it. The Settings "Save and probe" host calls those rpcs in
 *  sequence so a failed check never rolls back a successfully stored row. */

import {
  RpcError,
  connectionViewFromRow,
  getVendorProvider,
  buildGenericVendorProvider,
  vendorOAuthRedirectChoices,
  canonicalizeServerPublicUrl,
  canonicalizeSubresourcePath,
  SUBRESOURCE_PATH_MAX_LEN,
  validateHeaderAuthEntries,
  describeHeaderAuthIssue,
  MESSAGE_MATCH_CONFIG_KEY,
  validateMessageMatchPatterns,
  CONNECTION_INBOUND_SECRET_FIELDS,
  getMessengerVendorDeclaration,
  MESSENGER_AUTH_KIND_CONNECTION_TYPES,
  NOTIFICATION_SUBTYPES as CONTRACT_NOTIFICATION_SUBTYPES,
  resolveBearerAccessToken,
  MESSENGER_PROBE_TOKEN_PLACEHOLDER,
  vendorHasEngagement,
} from '@recued/contracts';
import type {
  ConnectionAuth,
  ConnectionDataPurgeSummary,
  ConnectionHealth,
  ConnectionKind,
  ConnectionVendorEntity,
  ConnectionView,
  HandlerSlice,
  IngredientManifest,
  MessageMatchPattern,
  MessengerVendorDeclaration,
  OperationGroupGrantView,
  ServerRpcRegistry,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import {
  encrypt,
  decrypt,
  encodeCiphertext,
  decodeCiphertext,
  bytesToBase64,
  base64ToBytes,
} from '@recued/crypto';
import type { WsClient } from './ws-server.js';
import type { RecipeRunnabilityBroadcaster } from './recipe-runnability-handler.js';
import { resolveConnectionVendor, type ConnectionStoreSqlite } from './storage/connection-store.js';
import type { ContractGrantStore } from './storage/contract-grant-store.js';
import type { ConnectionOperationProfileStore } from './connection-operation-profile.js';
import { deriveAllowedOperations } from './connection-operation-profile-boot.js';
import {
  completeVendorOAuth,
  VendorOAuthError,
  type HttpFetcher,
} from './connection-vendor-oauth.js';
import {
  startVendorOAuth,
  defaultFlowId,
  defaultClaimSecret,
  defaultCodeVerifier,
  type VendorOAuthFlowStore,
  type VendorOAuthResultStore,
  type VendorOAuthResult,
} from './connection-vendor-oauth-flow.js';
import type { ServerIdentity } from './identity/index.js';
import {
  exchangeOAuth2ClientCredentials,
  MCP_TOOL_LIST_PROBE_MAX_PAGES,
  parseMcpToolListPage,
  probeMcpStreamTools,
  refreshOAuth2,
  resolveStdioMcpLaunchSpec,
} from '@recued/ingredients';
import type { StdioSpawn, WsConnect } from '@recued/ingredients';
import { resolveSharePointDriveId } from './sharepoint-drive-resolver.js';

export interface ConnectionRpcDeps {
  store: ConnectionStoreSqlite;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
  /** Connection sub-DEK provider. Returns the unlocked key when the
   *  FileVault is open, null when locked. Omit entirely for dbless /
   *  uninitialized harnesses — the encoder falls back to opaque
   *  base64-JSON so existing test fixtures keep round-tripping. */
  getEncryptionKey?: () => Uint8Array | null;
  /** D-129 P1.2 — http fetcher for the `completeVendorOAuth` rpc.
   *  Defaults to the global `fetch`; tests inject a fake matching the
   *  narrow `HttpFetcher` shape. The same fetcher serves both the
   *  token-exchange POST and the access-token introspection GET. */
  fetcher?: HttpFetcher;
  /** A real `fetch` (full `Response` shape) for trusted connection-side token
   *  exchange and the D-192 SharePoint resolver. For SharePoint this covers the
   *  site→drive resolution at enroll: the OAuth token refresh (`refreshOAuth2`,
   *  which needs `typeof fetch`, not the narrow `HttpFetcher` above) + the Graph
   *  `/drive` call. Defaults to the global `fetch`; tests inject a fake. Only
   *  invoked on a `sharepoint` enroll that supplied a `site_url` + no `drive_id`. */
  resolveFetch?: typeof fetch;
  /** Node-backed MCP stream capabilities used by the manual health probe.
   *  Production reuses the same connector/spawner instances as live MCP
   *  execution. Optional for portable/dbless harnesses; a missing capability
   *  produces an honest `unknown` health rather than attempting a fake probe. */
  wsConnect?: WsConnect;
  spawnStdioMcp?: StdioSpawn;
  /** D-136 P6 — cascade engine reference. When wired, the delete
   *  handler invokes `cascadeForConnectionDelete(kind, name, vendor)`
   *  AFTER the row is removed from the connection store so vendor-
   *  scope enrichment rows are tombstoned alongside the scenario
   *  rows. Optional — db-less / harness paths skip cleanly; when
   *  absent the delete still removes the connection row but enrichment
   *  cleanup waits for the next housekeeping cascade fire. */
  cascadeForConnectionDelete?: (
    kind: 'api' | 'mcp' | 'notification',
    name: string,
    vendor?: string,
  ) => void;
  /** D-192 source-data-removal — the opt-in teardown purge. When wired AND
   *  the delete carries `remove_mirror_data: true`, the handler fans the
   *  per-Source hard-delete over every registry Source the connection owns
   *  (pre-bound to the warehouse stores at composition) AFTER the row is
   *  removed, and returns the summed counts on the rpc response. Best-effort +
   *  optional — absent (dbless / unwired) or unchecked, the connection is
   *  removed with its mirror records left in place (the ratified default). */
  purgeConnectionData?: (input: {
    connection_name: string;
    vendor?: string;
    /** D-192 slice 4 — messenger vendor (slack/telegram) for the contact-link
     *  retract leg on a notification connection. */
    messenger_vendor?: string;
  }) => ConnectionDataPurgeSummary;
  /** D-192 source-data-removal slice 3c — the read-only "[N] records" preview
   *  count for the removal-confirm dialog (the COUNT twin of
   *  `purgeConnectionData`). Pre-bound to the count stores at composition. When
   *  wired, `handleConnectionPreviewPurge` calls it to fill the checkbox label;
   *  absent (dbless / unwired) → the preview rpc returns 0. Read-only. */
  previewConnectionPurgeCount?: (input: {
    connection_name: string;
    vendor?: string;
    /** D-192 slice 4 — messenger vendor (slack/telegram) for the contact-link
     *  count leg on a notification connection. */
    messenger_vendor?: string;
  }) => number;
  /** D-192 — durable activity ledger for the `source_data_purged` audit row
   *  (the teardown is itself provenance; spec § 3 "Never" tier). Only written
   *  when a purge actually ran. Optional — absent → the purge still runs, just
   *  without the ledger row. */
  auditLog?: Pick<AuditLogStore, 'logActivity'>;
  /** D-165 follow-on — operation-group grant management. When wired, the
   *  `grant/revoke/listOperationGroup` rpcs persist user-manual grants to the
   *  durable `contract.grant` store (`ContractGrantStore`, keyed under the
   *  `__user__` sentinel; D-165 P3.grant migration) + re-derive the live operation
   *  profile (`profileStore` — the SAME instance the gateway's
   *  `connectionProfileResolver` reads) so a freshly-granted write group is
   *  honoured on the next dispatch. `getCatalogManifest` returns the catalog-form
   *  manifest a connection's grants operate against for the given vendor
   *  (`hubspot` / `salesforce` / …) — read live so group validation tracks it +
   *  its `slug` is the grant's `ingredient_id`; returns null/undefined for a
   *  vendor with no registered catalog. Omitted (dbless harness / surfaces without
   *  a catalog) → the three grant rpcs reject `not_configured`. */
  operationGrants?: {
    store: ContractGrantStore;
    profileStore: ConnectionOperationProfileStore;
    getCatalogManifest: (vendor: string) => IngredientManifest | null | undefined;
    /** D-170 gap #2 — resolve a connection bound to a private/local composition
     *  catalog → that catalog's manifest (connection-name → binding → local catalog).
     *  When wired, `ensureGrantableConnection` admits a local-catalog connection (no
     *  registered vendor) so its operation groups are manually grantable; the
     *  re-seed then derives the local catalog's profile. Omitted → registered-vendor
     *  catalogs only (the pre-gap-#2 behaviour). */
    resolveLocalCatalog?: (connection_name: string) => IngredientManifest | null | undefined;
  };
  /** D-148 § A.12 / D-165 enroll-host #1 — vendor OAuth-start substrate.
   *  When wired, `collection.connection.startVendorOAuth` mints a signed
   *  `state` token via `identity`, persists the pending flow (BYO client
   *  creds + the chosen redirect_uri) in `flowStore`, and returns the
   *  authorize URL + the server-identity public key the webclient caches
   *  for the cloud callback page to verify against. `serverPublicUrl`
   *  returns the server's configured public base URL (Pro DDNS host /
   *  BYO domain) — REQUIRED because the signed state carries it (the
   *  cloud page forwards the code to `<server_url>/oauth/complete`) and
   *  it forms the direct-redirect choice; null → the rpc rejects
   *  `not_configured`. Omitted entirely (dbless harness / unwired) →
   *  same `not_configured`. `newFlowId` defaults to a CSPRNG url-safe id;
   *  tests inject a deterministic generator. */
  vendorOAuthStart?: {
    identity: ServerIdentity;
    flowStore: VendorOAuthFlowStore;
    serverPublicUrl: () => string | null;
    newFlowId?: () => string;
    /** Owner-binding nonce generator (D-165 slice 3). Defaults to a 256-bit
     *  CSPRNG secret; tests inject a deterministic value. Returned ONLY on
     *  the start rpc response (to the originating client) + stamped into the
     *  flow record so `takeVendorOAuthResult` can gate the credential. */
    newClaimSecret?: () => string;
    /** PKCE code_verifier generator (RFC 7636). Defaults to a 256-bit CSPRNG
     *  verifier; tests inject a deterministic value. Used only for
     *  `supports_pkce` vendors; stamped into the flow record + never returned
     *  on the response (server-side secret like `claim_secret`). */
    newCodeVerifier?: () => string;
    /** Fork 1 — the union of `required_scopes` the INSTALLED packs need on a
     *  given vendor's connection. When wired, the registered-vendor start path
     *  requests `const-floor ∪ (client-passed scopes ?? this union)` — so a
     *  pack's write scope is requested once its pack is installed, without the
     *  user hand-typing it. Evaluated lazily (only when the client passed no
     *  explicit scope set), so the common B path (client pre-fills + passes)
     *  skips the pack scan. Absent (dbless / unwired) → const only. */
    installedPackScopeUnion?: (vendor: string) => readonly string[];
  };
  /** D-165 slice 3 — vendor OAuth result-claim substrate. When wired,
   *  `collection.connection.takeVendorOAuthResult` consumes the exchanged
   *  credential `/oauth/complete` stashed in `resultStore`, gated on the
   *  owner-binding `claim_secret` the start rpc handed the originating
   *  client. Rides the SAME `resultStore` instance the `oauthComplete
   *  PortDeps` writes (constructed once in `composeListeners`); a mismatch
   *  or absent flow returns `{ result: null }` without consuming. Omitted
   *  (dbless harness / unwired) → the rpc rejects `not_configured`. */
  vendorOAuthResult?: {
    resultStore: VendorOAuthResultStore;
  };
  /** R2 build step 4c.4 — derived-runnability broadcaster. When wired, the
   *  enroll / delete (`api` connections only) + grant / revoke handlers recompute
   *  every recipe's runnability and fan the fresh snapshot on the
   *  `recipe_runnability_changed` bus kind AFTER the mutation commits, so paired
   *  clients re-render the recipes view's status. Best-effort + optional — absent
   *  (dbless / no bus) the mutation still succeeds, just without the live signal. */
  recipeRunnabilityBroadcast?: RecipeRunnabilityBroadcaster;
  /** D-194 #6 — the installed pack slugs holding a pack-owned grant on a
   *  connection (`ContractGrantStore.listPacksForConnection`), pre-bound at
   *  composition. When wired, `handleConnectionList` stamps each api row's
   *  `bound_pack_slugs` so the connection-detail "Used by packs" list is
   *  connection-precise (two accounts of one vendor no longer both show every
   *  vendor pack). Absent (dbless / unwired) → the field is left off and the UI
   *  falls back to vendor-match. */
  boundPackSlugsForConnection?: (connection_name: string) => string[];
  /** D-192 S5 — the LIVE merged vendor registry (built-ins + installed-pack
   *  entities, via `liveVendorRegistry(localManifestStore)`), pre-bound at
   *  composition. When wired, `handleConnectionList` stamps each api row's
   *  `supports_engagement_health` (`vendorHasEngagement(vendor, registry)`) so
   *  the Settings → Connections UI shows the engagement-health affordance for
   *  any vendor that declares engagement entities — including a pack-declared
   *  CRM (e.g. Dynamics) the client's built-in-only read would miss. The same
   *  registry the engagement-health data rpc gates on, so the show-gate and the
   *  data-gate agree. Absent (dbless / unwired) → the field is left off and the
   *  UI falls back to a built-in `vendorHasEngagement` read. */
  resolveVendorRegistry?: () => ReadonlyArray<ConnectionVendorEntity>;
}

const VALID_KINDS: ReadonlySet<string> = new Set(['mcp', 'api', 'notification']);
const VALID_AUTH_TYPES: ReadonlySet<string> = new Set([
  'none',
  'bearer',
  'basic',
  'header',
  'query',
  'oauth2_refresh',
  'oauth2_client_credentials',
]);
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MCP_SUBTYPES: ReadonlySet<string> = new Set(['sse', 'websocket', 'stdio']);
/** The enrollable `notification` subtypes — the runtime gate over the contracts
 *  vocabulary (D-192 seam 10), which is itself every declared CHAT TRANSPORT plus
 *  the two that aren't one: `email` (a façade over a warehouse mail instance) and
 *  `in-app`. Seam 8 made this registry-driven so a declared vendor is enrollable
 *  at all (an unenrollable subtype can never be probed); seam 10 collapsed the
 *  local spread onto the shared const, so the type (`NotificationSubtype`), the
 *  enroll card, and this gate can no longer disagree about who exists. */
const NOTIFICATION_SUBTYPES: ReadonlySet<string> = new Set(CONTRACT_NOTIFICATION_SUBTYPES);
const CONNECTION_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,47}$/;

const isValidKind = (k: unknown): k is ConnectionKind =>
  typeof k === 'string' && VALID_KINDS.has(k);

const ensureKind = (where: string, k: unknown): ConnectionKind => {
  if (!isValidKind(k)) {
    throw new RpcError(
      'bad_request',
      `${where}: invalid kind '${String(k)}' (expected mcp / api / notification)`,
    );
  }
  return k;
};

const ensureName = (where: string, name: unknown): string => {
  if (typeof name !== 'string' || !name.trim()) {
    throw new RpcError('bad_request', `${where}: name is required`);
  }
  return name;
};

const ensureEnrollmentName = (where: string, name: unknown): string => {
  const n = ensureName(where, name).trim();
  if (!CONNECTION_NAME_REGEX.test(n)) {
    throw new RpcError(
      'bad_request',
      `${where}: name must be lowercase letters, digits, or dashes (1-48 chars)`,
    );
  }
  return n;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const ensureRecordArgs = (
  where: string,
  args: unknown,
): Record<string, unknown> => {
  if (!isRecord(args)) {
    throw new RpcError('bad_request', `${where}: args must be an object`);
  }
  return args;
};

const ensureConfig = (
  where: string,
  config: unknown,
): Record<string, unknown> => {
  if (!isRecord(config)) {
    throw new RpcError('bad_request', `${where}: config must be an object`);
  }
  return config;
};

/** D-192 M4c — reject a malformed messenger `match_patterns` at the write
 *  boundary. Subtype-agnostic (any connection declaring the field gets it —
 *  today only messenger connections do): the message→commitment funnel reads
 *  this field, and while the M2 matcher fail-closes per bad pattern (a typo
 *  just never matches), surfacing the problems HERE turns a silent no-match
 *  into an immediate, actionable enroll/update error. Absent field ⇒ no-op. */
const ensureValidMatchPatterns = (where: string, config: Record<string, unknown>): void => {
  const raw = config[MESSAGE_MATCH_CONFIG_KEY];
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw new RpcError('bad_request', `${where}: ${MESSAGE_MATCH_CONFIG_KEY} must be an array`);
  }
  const problems = validateMessageMatchPatterns(raw as MessageMatchPattern[]);
  if (problems.length > 0) {
    throw new RpcError(
      'bad_request',
      `${where}: invalid ${MESSAGE_MATCH_CONFIG_KEY} — ${problems.join('; ')}`,
    );
  }
};

/** D-192 M4c-UI — parse a connection row's `config_json` into a plain object.
 *  Tolerant: a malformed / non-object `config_json` yields `{}`. */
const parseStoredConfig = (config_json: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(config_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed → empty config */
  }
  return {};
};

/** D-192 M4c-UI — parse a connection row's stored `match_patterns`. Tolerant:
 *  a malformed config / absent field / non-array all yield `[]` (the funnel
 *  treats that as "no triggers"). The array is RAW — validated at write time
 *  (`ensureValidMatchPatterns`). Backs the `getMatchPatterns` read. */
const readStoredMatchPatterns = (config_json: string): MessageMatchPattern[] => {
  const raw = parseStoredConfig(config_json)[MESSAGE_MATCH_CONFIG_KEY];
  return Array.isArray(raw) ? (raw as MessageMatchPattern[]) : [];
};

/** D-192 M4c-UI — config keys STRIPPED from `ConnectionView` (server-side only,
 *  un-re-sendable by any client — the messenger triggers `setMatchPatterns`
 *  owns, plus the inbound-webhook secrets). A generic `update` replaces
 *  `config_json` wholesale, but the client can only rebuild `patch.config` from
 *  the STRIPPED view, so it can never include these — they must be carried over
 *  from the existing config, exactly as `subresource_path` / `granted_scopes`
 *  are preserved. Without this, editing a messenger connection's `channel_id`
 *  silently drops its triggers AND breaks inbound-webhook signature
 *  verification. */
const CONNECTION_UPDATE_PRESERVED_CONFIG_FIELDS: ReadonlyArray<string> = [
  MESSAGE_MATCH_CONFIG_KEY,
  ...CONNECTION_INBOUND_SECRET_FIELDS,
];

const ensureOptionalString = (
  where: string,
  field: string,
  value: unknown,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError(
      'bad_request',
      `${where}: ${field} must be a non-empty string when present`,
    );
  }
  return value.trim();
};

/** D-165 P3.path-picker — validate + canonicalize an optional
 *  `subresource_path`. Distinct from `ensureOptionalString`: empty /
 *  whitespace is allowed and folds to `/` (whole account) rather than
 *  throwing. Returns the canonical form when present, `undefined` when
 *  the field was omitted (so callers can preserve an existing scope on
 *  re-enroll instead of resetting). Caps raw length before
 *  canonicalization to keep pathological input out of storage. */
const ensureSubresourcePath = (
  where: string,
  value: unknown,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new RpcError(
      'bad_request',
      `${where}: subresource_path must be a string when present`,
    );
  }
  if (value.length > SUBRESOURCE_PATH_MAX_LEN) {
    throw new RpcError(
      'bad_request',
      `${where}: subresource_path exceeds ${SUBRESOURCE_PATH_MAX_LEN} characters`,
    );
  }
  return canonicalizeSubresourcePath(value);
};

/** granted-scopes — defensive caps on the optional vendor-granted scope
 *  list captured at enroll. OAuth scope strings are short and a vendor
 *  rarely exposes more than a handful; these just keep pathological input
 *  out of storage (same discipline as `SUBRESOURCE_PATH_MAX_LEN`). */
const GRANTED_SCOPES_MAX_COUNT = 512;
const GRANTED_SCOPE_MAX_LEN = 512;

/** granted-scopes — validate + normalize the optional vendor-granted OAuth
 *  scope list. Returns a trimmed, de-duped, NON-EMPTY array when present,
 *  or `undefined` when omitted OR empty-after-normalization. `undefined`
 *  is deliberately NOT the same as a stored empty set, for two reasons:
 *  (1) callers preserve an existing set on absent, so a re-enroll that
 *  omits the field never wipes a known set; (2) a vendor that returns no
 *  `scope` (and fails introspection) surfaces `[]` from `completeVendorOAuth`
 *  — persisting that as "granted nothing" would raise false "missing every
 *  scope" warnings, so an empty list folds to "unknown" (absent) instead.
 *  The readiness helper then treats absent as a soft hint, never a gate. */
const ensureGrantedScopes = (
  where: string,
  value: unknown,
): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new RpcError(
      'bad_request',
      `${where}: granted_scopes must be an array of strings when present`,
    );
  }
  if (value.length > GRANTED_SCOPES_MAX_COUNT) {
    throw new RpcError(
      'bad_request',
      `${where}: granted_scopes exceeds ${GRANTED_SCOPES_MAX_COUNT} entries`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new RpcError(
        'bad_request',
        `${where}: granted_scopes must be an array of strings when present`,
      );
    }
    if (raw.length > GRANTED_SCOPE_MAX_LEN) {
      throw new RpcError(
        'bad_request',
        `${where}: a granted_scopes entry exceeds ${GRANTED_SCOPE_MAX_LEN} characters`,
      );
    }
    const s = raw.trim();
    if (s === '' || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length > 0 ? out : undefined;
};

const ensureSubtype = (
  where: string,
  kind: ConnectionKind,
  subtype: unknown,
): string | undefined => {
  if (subtype === undefined) {
    if (kind === 'api') return undefined;
    throw new RpcError(
      'bad_request',
      `${where}: subtype is required for kind '${kind}'`,
    );
  }
  if (typeof subtype !== 'string' || !subtype.trim()) {
    throw new RpcError(
      'bad_request',
      `${where}: subtype must be a non-empty string when present`,
    );
  }
  const value = subtype.trim();
  if (kind === 'mcp' && !MCP_SUBTYPES.has(value)) {
    throw new RpcError(
      'bad_request',
      `${where}: invalid mcp subtype '${value}'`,
    );
  }
  if (kind === 'notification' && !NOTIFICATION_SUBTYPES.has(value)) {
    throw new RpcError(
      'bad_request',
      `${where}: invalid notification subtype '${value}'`,
    );
  }
  return value;
};

const requireStringField = (
  where: string,
  obj: Record<string, unknown>,
  field: string,
): void => {
  const value = obj[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError(
      'bad_request',
      `${where}: auth.${field} is required for auth.type='${String(obj.type)}'`,
    );
  }
};

const requireSafeAuthNameField = (
  where: string,
  obj: Record<string, unknown>,
  field: string,
): void => {
  requireStringField(where, obj, field);
  const value = obj[field] as string;
  if (PROTOTYPE_SENSITIVE_KEYS.has(value)) {
    throw new RpcError(
      'bad_request',
      `${where}: auth.${field} cannot be a reserved object key`,
    );
  }
};

const ensureOptionalStringField = (
  where: string,
  obj: Record<string, unknown>,
  field: string,
): void => {
  const value = obj[field];
  if (value !== undefined && typeof value !== 'string') {
    throw new RpcError(
      'bad_request',
      `${where}: auth.${field} must be a string when present`,
    );
  }
};

const ensureOptionalNumberField = (
  where: string,
  obj: Record<string, unknown>,
  field: string,
): void => {
  const value = obj[field];
  if (value !== undefined && typeof value !== 'number') {
    throw new RpcError(
      'bad_request',
      `${where}: auth.${field} must be a number when present`,
    );
  }
};

const ensureOptionalTokenAuthStyleField = (
  where: string,
  obj: Record<string, unknown>,
): void => {
  const value = obj.token_auth_style;
  if (value === undefined) return;
  if (value !== 'body' && value !== 'basic') {
    throw new RpcError(
      'bad_request',
      `${where}: auth.token_auth_style must be 'body' | 'basic' when present`,
    );
  }
};

const ensureAuth = (where: string, auth: unknown): ConnectionAuth => {
  if (!isRecord(auth) || typeof auth.type !== 'string') {
    throw new RpcError(
      'bad_request',
      `${where}: auth is required (with discriminant type)`,
    );
  }
  if (!VALID_AUTH_TYPES.has(auth.type)) {
    throw new RpcError(
      'bad_request',
      `${where}: unsupported auth.type '${auth.type}'`,
    );
  }
  switch (auth.type) {
    case 'none':
      break;
    case 'bearer':
      requireStringField(where, auth, 'token');
      break;
    case 'basic':
      requireStringField(where, auth, 'username');
      requireStringField(where, auth, 'password');
      break;
    case 'header': {
      const res = validateHeaderAuthEntries((auth as Record<string, unknown>).headers);
      if (!res.ok) {
        throw new RpcError(
          'bad_request',
          `${where}: auth.headers ${describeHeaderAuthIssue(res.issue)}`,
        );
      }
      break;
    }
    case 'query':
      requireSafeAuthNameField(where, auth, 'param_name');
      requireStringField(where, auth, 'value');
      break;
    case 'oauth2_refresh':
      requireStringField(where, auth, 'refresh_token');
      requireStringField(where, auth, 'client_id');
      requireStringField(where, auth, 'token_endpoint');
      ensureOptionalStringField(where, auth, 'client_secret');
      ensureOptionalTokenAuthStyleField(where, auth);
      ensureOptionalStringField(where, auth, 'current_access_token');
      ensureOptionalNumberField(where, auth, 'expires_at');
      break;
    case 'oauth2_client_credentials':
      requireStringField(where, auth, 'client_id');
      requireStringField(where, auth, 'client_secret');
      requireStringField(where, auth, 'token_endpoint');
      ensureOptionalTokenAuthStyleField(where, auth);
      ensureOptionalStringField(where, auth, 'scope');
      ensureOptionalStringField(where, auth, 'current_access_token');
      ensureOptionalNumberField(where, auth, 'expires_at');
      break;
  }
  return auth as unknown as ConnectionAuth;
};

/** D-192 CORE #6 make-live — a chat-transport connection must carry a credential
 *  the send path can actually use.
 *
 *  `ensureAuth` above validates an auth SHAPE in isolation (is a `bearer` well
 *  formed?). It cannot ask the only question that matters here — is this shape one
 *  the SUBTYPE can deliver with? — because it never sees the subtype. So the two
 *  passed each other, and `{kind: 'notification', subtype: 'slack', auth: {type:
 *  'oauth2_refresh', …}}` enrolled cleanly over rpc: it then probed GREEN (the
 *  prober reads `current_access_token` through `resolveBearerAccessToken`),
 *  reported READY (the readiness probe only checks the row exists), and silently
 *  dropped every send, because the credential resolver behind notify / ask /
 *  close-ask / turn / live-control returned null for any non-bearer shape.
 *
 *  Enrollment is the ONLY place this can fail loudly. Downstream is a best-effort
 *  notification fan-out that swallows errors by contract — that is exactly why the
 *  failure was silent — so the fix has to land before the row exists, not after.
 *
 *  Scoped to declared chat transports on purpose. `email` (a façade over a
 *  warehouse mail instance) and `in-app` (the broadcast bus) carry no messenger
 *  send path to be incompatible with, so they keep their own auth rules and are
 *  waved through untouched. */
const ensureMessengerAuthDeliverable = (
  where: string,
  subtype: string | undefined,
  auth: ConnectionAuth,
): void => {
  if (subtype === undefined) return;
  const declaration = getMessengerVendorDeclaration(subtype);
  if (declaration === null) return;
  // Non-empty by construction — the messenger registry's boot check refuses to
  // declare a vendor whose auth kind has no deliverable shape.
  const allowed = MESSENGER_AUTH_KIND_CONNECTION_TYPES[declaration.auth];
  if (allowed.includes(auth.type)) return;
  throw new RpcError(
    'bad_request',
    `${where}: a ${declaration.display_name} connection must use auth.type ` +
      `${allowed.map((t) => `'${t}'`).join(' or ')} (got '${auth.type}') — ` +
      'it sends with a bot token, so another credential shape would enroll, ' +
      'report healthy, and then silently never deliver a message.',
  );
};

/** AAD binding domain — separates connection-row ciphertext from
 *  every other AEAD blob on the server, AND ties each ciphertext to
 *  its (kind, name) row so an attacker who reorders rows in the SQLite
 *  file cannot move an `auth_ciphertext` between rows. The label
 *  doubles as a versioned sentinel — bumping `v1` lets a future format
 *  re-encode in place without confusion. */
const aadFor = (identity: { kind: ConnectionKind; name: string }): Uint8Array =>
  new TextEncoder().encode(`recued/v1/connection/${identity.kind}/${identity.name}`);

const requireConnectionKey = (
  getEncryptionKey: () => Uint8Array | null,
): Uint8Array => {
  const key = getEncryptionKey();
  if (!key) {
    throw new RpcError(
      'locked',
      'connection: server FileVault is locked, cannot encrypt or decrypt auth',
    );
  }
  return key;
};

/** Encode a `ConnectionAuth` for at-rest storage. AEAD-encrypts under
 *  the connection sub-DEK with AAD = `recued/v1/connection/${kind}/${name}`
 *  when a keyProvider is wired through. Falls back to the P2.1
 *  base64-JSON placeholder when none is supplied — covers dbless
 *  harnesses + the FileVault-uninitialized state per the existing
 *  `blob-store` / `sqlite-cache-store` discipline.
 *
 *  Exported so the D-125 P4.1 api handler's boot-site `persistAuth`
 *  callback can re-encode after an OAuth2 refresh — same crypto +
 *  AAD as enrollment, so a refreshed token round-trips through the
 *  sync wire alongside enrollments without divergence. */
export const encodeAuthForStorage = async (
  auth: ConnectionAuth,
  identity: { kind: ConnectionKind; name: string },
  getEncryptionKey?: () => Uint8Array | null,
): Promise<string> => {
  const plaintext = new TextEncoder().encode(JSON.stringify(auth));
  if (!getEncryptionKey) {
    return bytesToBase64(plaintext);
  }
  const key = requireConnectionKey(getEncryptionKey);
  const ct = await encrypt(key, plaintext, aadFor(identity));
  return encodeCiphertext(ct);
};

/** Decode an at-rest ciphertext blob back to a `ConnectionAuth`. The
 *  P3 adapter calls this at invoke time — never on read-only list /
 *  view paths. Mirrors the encode policy on `getEncryptionKey`:
 *  encrypted when wired, base64-JSON when not. */
export const decodeAuthFromStorage = async (
  blob: string,
  identity: { kind: ConnectionKind; name: string },
  getEncryptionKey?: () => Uint8Array | null,
): Promise<ConnectionAuth> => {
  if (!getEncryptionKey) {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(blob))) as ConnectionAuth;
  }
  const key = requireConnectionKey(getEncryptionKey);
  const ct = decodeCiphertext(blob);
  const plaintext = await decrypt(key, ct, aadFor(identity));
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConnectionAuth;
};

export const handleConnectionList = async (
  deps: ConnectionRpcDeps,
  args: { kind?: ConnectionKind } | void,
): Promise<{ connections: ConnectionView[] }> => {
  const a = args === undefined
    ? {}
    : ensureRecordArgs('collection.connection.list', args);
  if (a.kind !== undefined && !isValidKind(a.kind)) {
    throw new RpcError(
      'bad_request',
      `collection.connection.list: invalid kind '${String(a.kind)}'`,
    );
  }
  const rows = a.kind ? deps.store.list({ kind: a.kind }) : deps.store.list();
  const boundPackSlugsForConnection = deps.boundPackSlugsForConnection;
  // D-192 S5 — resolve the live merged registry once per list call (built-ins +
  // installed packs). Unwired (dbless) → the engagement stamp is skipped.
  const engagementRegistry = deps.resolveVendorRegistry?.();
  return {
    connections: rows.map((row) => {
      const view = connectionViewFromRow(row);
      // D-194 #6 — stamp the connection-precise "Used by packs" set from the
      // grant store (api rows only — pack grants are on api connections). The
      // resolver-shared `connectionViewFromRow` never sets this; it lives only on
      // the list response. Unwired (dbless) → left off → the UI falls back to
      // vendor-match.
      if (boundPackSlugsForConnection !== undefined && view.kind === 'api') {
        view.bound_pack_slugs = boundPackSlugsForConnection(view.name);
      }
      // D-192 S5 — stamp whether this connection's vendor declares engagement
      // entities (api rows only) so the UI can show the engagement-health toggle
      // for a pack-declared CRM too, not just the built-in hubspot/salesforce.
      // `view.vendor` is the flattened `config.vendor`; a vendor-less row → false.
      if (engagementRegistry !== undefined && view.kind === 'api') {
        const vendor = typeof view.vendor === 'string' ? view.vendor : '';
        view.supports_engagement_health = vendorHasEngagement(vendor, engagementRegistry);
      }
      return view;
    }),
  };
};

/** D-192 CORE #5e — SharePoint site→drive auto-resolution at enroll. A no-op for
 *  everything except a `sharepoint` connection that supplied a `config.site_url`
 *  but no `config.drive_id`: it refreshes the just-granted OAuth token ONCE (to
 *  obtain a Graph access token — Microsoft ROTATES the refresh token on refresh,
 *  so the caller MUST persist the returned auth, never the pre-refresh one) and
 *  resolves the site's default document-library drive id. Returns the config with
 *  `drive_id` filled + the auth to persist; throws a `bad_request` the dialog
 *  surfaces (missing target / auth failure / bad URL / missing Sites.Read.All /
 *  site not found). Vendor-gated, so no other enroll pays a network round-trip. */
const maybeResolveSharePointDrive = async (
  config: Record<string, unknown>,
  auth: ConnectionAuth,
  deps: ConnectionRpcDeps,
  now: () => number,
): Promise<{ config: Record<string, unknown>; auth: ConnectionAuth }> => {
  if (config.vendor !== 'sharepoint') return { config, auth };
  const siteUrl = typeof config.site_url === 'string' ? config.site_url.trim() : '';
  const hasDriveId = typeof config.drive_id === 'string' && config.drive_id.trim() !== '';
  // An explicit drive_id (the advanced override) wins — no resolution, no network.
  if (hasDriveId) return { config, auth };
  if (siteUrl === '') {
    throw new RpcError(
      'bad_request',
      'collection.connection.enroll: a SharePoint connection needs either a site URL (config.site_url) or a document library drive ID (config.drive_id).',
    );
  }
  if (auth.type !== 'oauth2_refresh') {
    throw new RpcError(
      'bad_request',
      "collection.connection.enroll: resolving a SharePoint library from a site URL needs the Microsoft OAuth connection (auth.type 'oauth2_refresh').",
    );
  }
  const fetchImpl = deps.resolveFetch ?? fetch;
  // Refresh once for a Graph access token. The rotated refresh token comes back
  // on `fresh` — we persist THAT (returned below), so the pre-refresh token
  // (which Microsoft may now invalidate) is never the one we store.
  let fresh: ConnectionAuth;
  try {
    fresh = await refreshOAuth2(auth, fetchImpl, now);
  } catch (e) {
    throw new RpcError(
      'bad_request',
      `collection.connection.enroll: couldn't authenticate to Microsoft Graph to resolve the SharePoint library (${e instanceof Error ? e.message : String(e)}) — reconnect the account and retry.`,
    );
  }
  const token = fresh.type === 'oauth2_refresh' ? fresh.current_access_token : undefined;
  if (typeof token !== 'string' || token === '') {
    throw new RpcError(
      'bad_request',
      'collection.connection.enroll: the Microsoft OAuth refresh returned no access token for the SharePoint library resolution.',
    );
  }
  // Pin the Graph host to the trusted Microsoft Graph base (the resolver's
  // default) — deliberately do NOT read `config.base_url` here: enroll accepts
  // arbitrary config, so honoring a caller-supplied base would exfiltrate the
  // freshly-minted access token (sent as a Bearer) to an attacker host. The
  // OneDrive/SharePoint leaf likewise pins the Graph host to a constant, never
  // `config.base_url`; the resolver's `graphBase` param is a test seam only.
  const resolved = await resolveSharePointDriveId({ siteUrl, token, fetchImpl });
  if (!resolved.ok) {
    throw new RpcError('bad_request', `collection.connection.enroll: ${resolved.reason}`);
  }
  return { config: { ...config, drive_id: resolved.drive_id }, auth: fresh };
};

export const handleConnectionEnroll = async (
  deps: ConnectionRpcDeps,
  args: {
    name: string;
    kind: ConnectionKind;
    subtype?: string;
    display_name: string;
    publisher_id?: string;
    config: Record<string, unknown>;
    auth: ConnectionAuth;
    subresource_path?: string;
    /** granted-scopes — the vendor-granted OAuth scopes from the just-
     *  completed dance (the dialog claims them off `completeVendorOAuth`).
     *  Omitted on a non-oauth enroll or a programmatic token-refresh
     *  re-enroll → the existing set is preserved. */
    granted_scopes?: string[];
  },
): Promise<{ connection: ConnectionView; probe?: ConnectionHealth }> => {
  const a = ensureRecordArgs('collection.connection.enroll', args);
  const name = ensureEnrollmentName('collection.connection.enroll', a.name);
  const kind = ensureKind('collection.connection.enroll', a.kind);
  const subtype = ensureSubtype('collection.connection.enroll', kind, a.subtype);
  const publisher_id = ensureOptionalString(
    'collection.connection.enroll',
    'publisher_id',
    a.publisher_id,
  );
  if (typeof a.display_name !== 'string' || !a.display_name.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.enroll: display_name is required',
    );
  }
  const config = ensureConfig('collection.connection.enroll', a.config);
  ensureValidMatchPatterns('collection.connection.enroll', config);
  const auth = ensureAuth('collection.connection.enroll', a.auth);
  ensureMessengerAuthDeliverable('collection.connection.enroll', subtype, auth);
  const now = deps.now?.() ?? Date.now();
  // D-192 CORE #5e — resolve a SharePoint document library's drive id from a
  // pasted `config.site_url` (a no-op for every other enroll). May refresh the
  // OAuth token (persisting the ROTATED refresh token as `effectiveAuth`) and
  // fill `config.drive_id`; on any failure it throws a `bad_request` the dialog
  // surfaces. Returns fresh objects — the original `config`/`auth` are unmutated.
  const resolvedSharePoint = await maybeResolveSharePointDrive(config, auth, deps, () => now);
  const effectiveConfig = resolvedSharePoint.config;
  const effectiveAuth = resolvedSharePoint.auth;
  // Preserve enrolled_at across re-enrollments — first sight wins on
  // identity, every patch refreshes updated_at. This matches the
  // `account.*` semantics pre-RIP.
  const existing = deps.store.get(kind, name);
  const enrolled_at = existing?.enrolled_at ?? now;
  // D-165 P3.path-picker — set the sub-resource scope. Preserve-on-absent:
  // a re-enroll that omits the field keeps the existing scope rather than
  // silently WIDENING it to `/` (a programmatic re-enroll for token
  // refresh must never broaden a permission boundary). Absent + no
  // existing → `/` (whole account). Explicit value always wins, so the
  // UI's "reset to root" (sending `/`) still works.
  const subresource_path = canonicalizeSubresourcePath(
    ensureSubresourcePath('collection.connection.enroll', a.subresource_path)
      ?? existing?.subresource_path,
  );
  // granted-scopes — capture the vendor-granted set from the dance. Preserve
  // on absent (a re-enroll for token refresh that omits the field keeps the
  // known set rather than wiping it to "unknown"); an explicit non-empty set
  // always wins, so a re-authorize that narrows scope persists the narrower
  // set. Empty/omitted normalizes to undefined → fall through to existing.
  const grantedFromArgs = ensureGrantedScopes(
    'collection.connection.enroll',
    a.granted_scopes,
  );
  const granted_scopes_json =
    grantedFromArgs !== undefined
      ? JSON.stringify(grantedFromArgs)
      : existing?.granted_scopes_json;
  // No network check has happened yet. Do not stamp `last_probed_at` here:
  // Settings follows enrollment with the real probe rpc, and if that call is
  // interrupted the durable row must remain honestly "never probed".
  const probe: ConnectionHealth = { status: 'unknown' };
  const auth_ciphertext = await encodeAuthForStorage(
    effectiveAuth,
    { kind, name },
    deps.getEncryptionKey,
  );
  const row = deps.store.upsert({
    name,
    kind,
    ...(subtype !== undefined ? { subtype } : {}),
    display_name: a.display_name,
    ...(publisher_id !== undefined ? { publisher_id } : {}),
    config_json: JSON.stringify(effectiveConfig),
    auth_ciphertext,
    enrolled_at,
    updated_at: now,
    health_json: JSON.stringify(probe),
    subresource_path,
    ...(granted_scopes_json !== undefined ? { granted_scopes_json } : {}),
  });
  // R2 build step 4c.4 — a new `api` connection adds a provider that can flip
  // recipes runnable; recompute + broadcast (only `api` carries a vendor profile
  // runnability reads). Best-effort, post-commit — the broadcaster swallows.
  if (kind === 'api') deps.recipeRunnabilityBroadcast?.recomputeAndEmit();
  return {
    connection: connectionViewFromRow(row),
    probe,
  };
};

export const handleConnectionUpdate = async (
  deps: ConnectionRpcDeps,
  args: {
    name: string;
    kind: ConnectionKind;
    patch: {
      display_name?: string;
      config?: Record<string, unknown>;
      auth?: ConnectionAuth;
    };
  },
): Promise<{ connection: ConnectionView }> => {
  const a = ensureRecordArgs('collection.connection.update', args);
  const name = ensureName('collection.connection.update', a.name);
  const kind = ensureKind('collection.connection.update', a.kind);
  const patch = a.patch;
  if (!isRecord(patch)) {
    throw new RpcError(
      'bad_request',
      'collection.connection.update: patch must be an object',
    );
  }
  const existing = deps.store.get(kind, name);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.connection.update: no ${kind} connection named '${name}'`,
    );
  }
  const now = deps.now?.() ?? Date.now();
  const display_name =
    patch.display_name !== undefined
      ? patch.display_name
      : existing.display_name;
  if (typeof display_name !== 'string' || !display_name.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.update: display_name must be non-empty when patched',
    );
  }
  if (
    patch.config !== undefined &&
    !isRecord(patch.config)
  ) {
    throw new RpcError(
      'bad_request',
      'collection.connection.update: config must be an object when patched',
    );
  }
  const auth =
    patch.auth !== undefined
      ? ensureAuth('collection.connection.update', patch.auth)
      : undefined;
  // The same gate on the patch path — otherwise a row enrolls as `bearer` and is
  // then patched to an undeliverable shape through the back door, landing in
  // exactly the green-ready-and-mute state the enroll gate exists to prevent.
  // `existing.subtype` (not a patched one): the subtype is identity, never patched.
  if (auth !== undefined) {
    ensureMessengerAuthDeliverable('collection.connection.update', existing.subtype, auth);
  }
  let config_json = existing.config_json;
  if (patch.config !== undefined) {
    // Carry over the view-STRIPPED, un-re-sendable config fields
    // (`CONNECTION_UPDATE_PRESERVED_CONFIG_FIELDS`: the messenger triggers +
    // the inbound-webhook secrets) that this patch omits — the same intent as
    // the `subresource_path` / `granted_scopes` row-field preservation below.
    // A caller that DOES pass one in `patch.config` keeps its explicit value.
    const merged: Record<string, unknown> = { ...patch.config };
    const existingConfig = parseStoredConfig(existing.config_json);
    for (const key of CONNECTION_UPDATE_PRESERVED_CONFIG_FIELDS) {
      if (merged[key] === undefined && existingConfig[key] !== undefined) {
        merged[key] = existingConfig[key];
      }
    }
    ensureValidMatchPatterns('collection.connection.update', merged);
    config_json = JSON.stringify(merged);
  }
  const auth_ciphertext =
    auth !== undefined
      ? await encodeAuthForStorage(auth, { kind, name }, deps.getEncryptionKey)
      : existing.auth_ciphertext;
  const row = deps.store.upsert({
    name,
    kind,
    ...(existing.subtype !== undefined ? { subtype: existing.subtype } : {}),
    display_name,
    ...(existing.publisher_id !== undefined ? { publisher_id: existing.publisher_id } : {}),
    config_json,
    auth_ciphertext,
    enrolled_at: existing.enrolled_at,
    updated_at: now,
    ...(existing.last_used_at !== undefined ? { last_used_at: existing.last_used_at } : {}),
    ...(existing.health_json !== undefined ? { health_json: existing.health_json } : {}),
    // D-165 P3.path-picker — the scope is set at enrollment and is NOT a
    // patchable field (re-scope = new connection, spec § Sub-resource
    // gating); preserve it verbatim so a config/auth patch never resets it.
    ...(existing.subresource_path !== undefined ? { subresource_path: existing.subresource_path } : {}),
    // granted-scopes — set at enroll/re-authorize, never via update; preserve
    // verbatim so a config/auth patch can't wipe the coverage set.
    ...(existing.granted_scopes_json !== undefined ? { granted_scopes_json: existing.granted_scopes_json } : {}),
  });
  return { connection: connectionViewFromRow(row) };
};

/** D-136 P6 — derive the vendor identifier from a connection row. Used by the
 *  delete cascade (vendor-entity enrichment cleanup) AND the catalog grant rpcs
 *  (`ensureGrantableConnection`). Delegates to the shared `resolveConnectionVendor`
 *  so the grant-WRITE path and the operation-profile SEED resolve a row's vendor
 *  identically — the D-165 P3.grant migration keys `contract.grant` on the vendor's
 *  catalog slug, so a divergence would strand a grant the reseed never re-merges. */
const resolveVendorFromConnection = (
  existing: { config_json: string; subtype?: string | null } | null,
): string | undefined => (existing ? resolveConnectionVendor(existing) : undefined);

/** D-192 slice 4 — the messenger vendor of a notification connection
 *  (slack / telegram), declaration-driven per the kinds-taxonomy §0 rule (a
 *  subtype that carries a `MessengerVendorDeclaration`). `undefined` for a
 *  non-messenger notification (email / in-app) or any non-notification
 *  connection — those own no `contact_platform_link` footprint to retract. */
const resolveMessengerVendor = (
  kind: ConnectionKind,
  existing: { subtype?: string | null } | null,
): string | undefined => {
  if (kind !== 'notification' || existing == null || !existing.subtype) return undefined;
  return getMessengerVendorDeclaration(existing.subtype) !== null ? existing.subtype : undefined;
};

export const handleConnectionDelete = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind; remove_mirror_data?: boolean },
): Promise<{ deleted: boolean; purged?: ConnectionDataPurgeSummary }> => {
  const a = ensureRecordArgs('collection.connection.delete', args);
  const name = ensureName('collection.connection.delete', a.name);
  const kind = ensureKind('collection.connection.delete', a.kind);
  // D-192 source-data-removal — the opt-in "also remove the [N] records"
  // checkbox (default off, ratified). Coerced strictly so any non-true value
  // preserves the mirror data.
  const removeMirrorData = a.remove_mirror_data === true;
  // D-136 P6 — capture the vendor (api connections only) BEFORE
  // dropping the row so the cascade can tombstone vendor-entity
  // enrichments. Vendor lives in `config_json.vendor` for HubSpot /
  // Salesforce / future vendors (boot wires read the same shape);
  // `subtype` is the fallback for older / non-vendor api flavors.
  // Non-api kinds skip vendor cleanup entirely.
  const existing = deps.store.get(kind, name);
  const vendor =
    kind === 'api' ? resolveVendorFromConnection(existing) : undefined;
  // D-192 slice 4 — a messenger notification connection (slack/telegram) retracts
  // its D-138 `contact_platform_link` associations on teardown. Resolved from the
  // subtype's `MessengerVendorDeclaration`; undefined for api / non-messenger.
  const messengerVendor = resolveMessengerVendor(kind, existing);
  // D-192 source-data-removal — when the user opted in, hard-delete the
  // connection's mirrored footprint. This MUST run BEFORE `store.delete`:
  // `store.delete` synchronously fires the source-boot delete hooks, which
  // `unregisterSource` every registry Source of this connection — after which
  // `purgeConnectionData`'s `listSources()` walk is blind to them and purges
  // nothing. Two disjoint footprints, gated by kind (the `(kind, name)` PK lets
  // a non-api row share a name with an api row, so each kind must reach ONLY its
  // own data):
  //   - `api` → registry Sources (work-entity/file mirror + their cascade) + the
  //     D-190 CRM platform-reference mirror (slice 3a/3b);
  //   - `notification` + messenger subtype → the D-138 contact-link associations
  //     this connection contributed (slice 4).
  // `existing !== null` gates on the row being present (get→delete is a
  // synchronous span, so a present row is guaranteed deletable below).
  // Best-effort: a purge throw never fails the delete rpc (idempotent — a re-run
  // completes it).
  const purgeable = kind === 'api' || messengerVendor !== undefined;
  let purged: ConnectionDataPurgeSummary | undefined;
  if (existing !== null && removeMirrorData && purgeable && deps.purgeConnectionData) {
    try {
      purged = deps.purgeConnectionData({
        connection_name: name,
        ...(vendor ? { vendor } : {}),
        ...(messengerVendor ? { messenger_vendor: messengerVendor } : {}),
      });
    } catch {
      // Swallow — the delete proceeds; the purge is idempotent + re-runnable.
      purged = undefined;
    }
  }
  const deleted = deps.store.delete(kind, name);
  if (deleted && deps.cascadeForConnectionDelete) {
    try {
      deps.cascadeForConnectionDelete(kind, name, vendor);
    } catch {
      // Best-effort — cascade exceptions don't fail the rpc. The next
      // housekeeping cascade fire (or a manual topic-reset) cleans up
      // any orphaned enrichment rows.
    }
  }
  // Record the `source_data_purged` provenance row once the teardown
  // completed (spec § 3 "Never" tier keeps audit / memory even as the live
  // data is removed). Best-effort — an audit failure never fails the rpc.
  if (deleted && purged && deps.auditLog) {
    try {
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: deps.now?.() ?? Date.now(),
        action: 'source_data_purged',
        target: name,
        detail: JSON.stringify({
          kind,
          ...(vendor ? { vendor } : {}),
          ...(messengerVendor ? { messenger_vendor: messengerVendor } : {}),
          ...purged,
        }),
      });
    } catch {
      // Swallow — the purge already happened; the ledger row is best-effort.
    }
  }
  // R2 build step 4c.4 — deleting an `api` connection removes a provider, which
  // can flip recipes blocked; recompute + broadcast the new snapshot (best-effort,
  // only when a row was actually removed).
  if (deleted && kind === 'api') deps.recipeRunnabilityBroadcast?.recomputeAndEmit();
  return { deleted, ...(deleted && purged ? { purged } : {}) };
};

/** D-192 source-data-removal slice 3c/4 — the read-only "[N] records" preview the
 *  removal-confirm dialog fetches on open to label its "also remove the mirrored
 *  data" checkbox. Counts exactly what a `remove_mirror_data: true` delete would
 *  purge, never mutating, matching the delete's kind-gated footprints:
 *    - `api` → per-Source mirror / work-entity + the D-190 CRM footprint (3c);
 *    - `notification` + messenger subtype → this connection's D-138 contact-link
 *      associations (slice 4).
 *  A non-purgeable (non-api, non-messenger) / missing / unwired (dbless)
 *  connection has nothing to remove → `count: 0` (the delete is likewise tolerant
 *  of a missing row, so the dialog degrades cleanly). */
export const handleConnectionPreviewPurge = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind },
): Promise<{ count: number }> => {
  const a = ensureRecordArgs('collection.connection.previewPurge', args);
  const name = ensureName('collection.connection.previewPurge', a.name);
  const kind = ensureKind('collection.connection.previewPurge', a.kind);
  if (!deps.previewConnectionPurgeCount) return { count: 0 };
  if (kind !== 'api' && kind !== 'notification') return { count: 0 };
  const existing = deps.store.get(kind, name);
  if (existing === null) return { count: 0 };
  const vendor = kind === 'api' ? resolveVendorFromConnection(existing) : undefined;
  const messengerVendor = resolveMessengerVendor(kind, existing);
  // A notification connection that isn't a messenger vendor (email / in-app)
  // owns no purgeable footprint — mirror the delete's `purgeable` gate.
  if (kind === 'notification' && messengerVendor === undefined) return { count: 0 };
  return {
    count: deps.previewConnectionPurgeCount({
      connection_name: name,
      ...(vendor ? { vendor } : {}),
      ...(messengerVendor ? { messenger_vendor: messengerVendor } : {}),
    }),
  };
};

export const handleConnectionProbe = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind },
): Promise<{ health: ConnectionHealth }> => {
  const a = ensureRecordArgs('collection.connection.probe', args);
  const name = ensureName('collection.connection.probe', a.name);
  const kind = ensureKind('collection.connection.probe', a.kind);
  const existing = deps.store.get(kind, name);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.connection.probe: no ${kind} connection named '${name}'`,
    );
  }
  const now = deps.now?.() ?? Date.now();
  const maxErrorLen = 256;
  const probeTimeoutMs = 10_000;
  const fetcher: HttpFetcher = deps.fetcher ?? (async (url, init) => {
    const res = await fetch(url, init);
    return {
      status: res.status,
      ok: res.ok,
      json: () => res.json() as Promise<unknown>,
      text: () => res.text(),
    };
  });
  const truncateError = (message: string): string =>
    message.length > maxErrorLen ? message.slice(0, maxErrorLen) : message;
  const healthOf = (
    status: ConnectionHealth['status'],
    last_error?: string,
    tools?: string[],
  ): ConnectionHealth => ({
    status,
    last_probed_at: now,
    ...(last_error ? { last_error: truncateError(last_error) } : {}),
    ...(tools !== undefined ? { tools } : {}),
  });
  const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  const fetchTimed = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
    timeoutMs = probeTimeoutMs,
  ): Promise<Awaited<ReturnType<HttpFetcher>>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetcher(url, init),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('probe_timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const readConfig = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(existing.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error('malformed_config');
  };
  const authString = (auth: ConnectionAuth, field: string): string => {
    const value = (auth as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`auth.${field}_missing`);
    }
    return value;
  };
  const authName = (auth: ConnectionAuth, field: string): string => {
    const value = authString(auth, field);
    if (PROTOTYPE_SENSITIVE_KEYS.has(value)) {
      throw new Error(`auth.${field}_reserved`);
    }
    return value;
  };
  const applyAuth = (
    auth: ConnectionAuth,
    headers: Record<string, string>,
    url: URL,
  ): void => {
    switch (auth.type) {
      case 'none':
        return;
      case 'bearer':
        headers.Authorization = `Bearer ${authString(auth, 'token')}`;
        return;
      case 'basic':
        headers.Authorization = `Basic ${btoa(`${authString(auth, 'username')}:${authString(auth, 'password')}`)}`;
        return;
      case 'header': {
        const res = validateHeaderAuthEntries((auth as Record<string, unknown>).headers);
        if (!res.ok) throw new Error(`auth.headers_${res.issue.code}`);
        // Validated header names are proto-safe — the plain-object writes are sound.
        for (const h of res.entries) headers[h.header_name] = h.value;
        return;
      }
      case 'query':
        url.searchParams.set(authName(auth, 'param_name'), authString(auth, 'value'));
        return;
      case 'oauth2_refresh':
      case 'oauth2_client_credentials':
        headers.Authorization = `Bearer ${authString(auth, 'current_access_token')}`;
        return;
    }
  };
  const classifyHttpReachability = (status: number): ConnectionHealth => {
    // API probe table: 2xx/3xx => ok; 401/403 => auth_failed; any
    // other HTTP response proves reachability, so keep ok + stamp the
    // status for the Settings surface.
    if (status === 401 || status === 403) {
      return healthOf('auth_failed', `http_status_${status}`);
    }
    if (status >= 200 && status < 400) return healthOf('ok');
    return healthOf('ok', `http_status_${status}`);
  };
  const jsonRpc = async (
    endpoint: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs = probeTimeoutMs,
  ): Promise<{ httpStatus: number; envelope?: Record<string, unknown> }> => {
    const response = await fetchTimed(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, timeoutMs);
    if (!response.ok) return { httpStatus: response.status };
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { httpStatus: response.status, envelope: parsed as Record<string, unknown> };
    }
    return { httpStatus: response.status };
  };
  const probeApi = async (auth: ConnectionAuth): Promise<ConnectionHealth> => {
    const config = readConfig();
    const base = config.base_url;
    if (typeof base !== 'string' || base.trim() === '') {
      return healthOf('unknown', 'missing_base_url');
    }
    const url = new URL(base);
    const headers: Record<string, string> = {};
    applyAuth(auth, headers, url);
    try {
      const head = await fetchTimed(url.toString(), { method: 'HEAD', headers });
      if (head.status === 405 || head.status === 501) {
        const get = await fetchTimed(url.toString(), { method: 'GET', headers });
        return classifyHttpReachability(get.status);
      }
      return classifyHttpReachability(head.status);
    } catch (err) {
      return healthOf('unreachable', errorMessage(err));
    }
  };
  const probeMcp = async (auth: ConnectionAuth): Promise<ConnectionHealth> => {
    const config = readConfig();
    // Match live execution's source of truth (`getTransport`): the row subtype
    // wins, with config.transport only as a legacy-row fallback. Probing a
    // different transport than recipes use can produce a false green.
    const transport = typeof existing.subtype === 'string'
      && MCP_SUBTYPES.has(existing.subtype)
      ? existing.subtype
      : config.transport;
    const deadline = Date.now() + probeTimeoutMs;
    const remainingProbeMs = (): number => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('probe_timeout');
      return remaining;
    };
    const streamHealth = (
      result: Awaited<ReturnType<typeof probeMcpStreamTools>>,
    ): ConnectionHealth => {
      if (result.ok) return healthOf('ok', undefined, result.tools);
      const suffix = result.stage === 'tools_list' ? 'tools_list' : 'initialize';
      return result.reason === 'jsonrpc_error'
        ? healthOf('auth_failed', `jsonrpc_${suffix}_error`)
        : healthOf('unreachable', `jsonrpc_${suffix}_${result.reason}`);
    };
    const redactProbeSecrets = (
      message: string,
      extraSecrets: readonly string[] = [],
    ): string => {
      const authRecord = auth as unknown as Record<string, unknown>;
      const secrets = [...extraSecrets];
      const add = (value: unknown): void => {
        if (typeof value === 'string' && value.length > 0) secrets.push(value);
      };
      switch (auth.type) {
        case 'bearer':
          add(authRecord.token);
          break;
        case 'basic': {
          add(authRecord.username);
          add(authRecord.password);
          if (typeof authRecord.username === 'string' && typeof authRecord.password === 'string') {
            add(btoa(`${authRecord.username}:${authRecord.password}`));
          }
          break;
        }
        case 'header':
          if (Array.isArray(authRecord.headers)) {
            for (const entry of authRecord.headers) {
              if (entry && typeof entry === 'object') {
                add((entry as Record<string, unknown>).value);
              }
            }
          }
          break;
        case 'query':
          add(authRecord.value);
          break;
        case 'oauth2_refresh':
        case 'oauth2_client_credentials':
          add(authRecord.current_access_token);
          break;
        case 'none':
          break;
      }
      const renderings = new Set<string>();
      for (const secret of secrets) {
        renderings.add(secret);
        try { renderings.add(encodeURI(secret)); } catch { /* malformed surrogate */ }
        try { renderings.add(encodeURIComponent(secret)); } catch { /* malformed surrogate */ }
        try {
          renderings.add(new URLSearchParams({ value: secret }).toString().slice('value='.length));
        } catch { /* defensive — URLSearchParams accepts strings */ }
      }
      let redacted = message;
      for (const rendering of renderings) {
        if (rendering !== '') redacted = redacted.split(rendering).join('***');
      }
      return redacted;
    };
    const streamFailure = (
      err: unknown,
      extraSecrets: readonly string[] = [],
    ): ConnectionHealth => {
      const rawMessage = errorMessage(err);
      const authStatus = /\bHTTP (401|403)\b/i.exec(rawMessage)?.[1];
      return authStatus
        ? healthOf('auth_failed', `http_status_${authStatus}`)
        : healthOf('unreachable', redactProbeSecrets(rawMessage, extraSecrets));
    };

    if (transport === 'stdio') {
      const spawnStdioMcp = deps.spawnStdioMcp;
      if (spawnStdioMcp === undefined) {
        return healthOf('unknown', 'transport_stdio_probe_unavailable');
      }
      const launch = resolveStdioMcpLaunchSpec(config);
      if (!launch.ok) return healthOf('unknown', `stdio_${launch.code}`);
      const { spec } = launch;
      try {
        return streamHealth(await probeMcpStreamTools(
          (signal) => spawnStdioMcp(spec, { signal }),
          remainingProbeMs(),
        ));
      } catch (err) {
        return streamFailure(
          err,
          spec.env === undefined ? [] : Object.values(spec.env),
        );
      }
    }

    if (transport !== 'sse' && transport !== 'websocket') {
      return healthOf(
        'unknown',
        transport === undefined
          ? 'missing_transport'
          : `transport_${transport}_probe_unsupported`,
      );
    }
    const endpoint = config.endpoint;
    if (typeof endpoint !== 'string' || endpoint.trim() === '') {
      return healthOf('unknown', 'missing_endpoint');
    }
    const url = new URL(endpoint);
    const headers: Record<string, string> = {};
    applyAuth(auth, headers, url);

    if (transport === 'websocket') {
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        return healthOf('unknown', 'websocket_endpoint_must_use_ws');
      }
      const wsConnect = deps.wsConnect;
      if (wsConnect === undefined) {
        return healthOf('unknown', 'transport_websocket_probe_unavailable');
      }
      try {
        return streamHealth(await probeMcpStreamTools(
          (signal) => wsConnect(url.toString(), { headers, signal }),
          remainingProbeMs(),
        ));
      } catch (err) {
        return streamFailure(err);
      }
    }

    headers['Content-Type'] = 'application/json';
    headers.Accept = 'application/json';
    try {
      const initialize = await jsonRpc(url.toString(), headers, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'recued-connection-probe', version: '1' },
        },
      }, remainingProbeMs());
      if (initialize.httpStatus === 401 || initialize.httpStatus === 403) {
        return healthOf('auth_failed', `http_status_${initialize.httpStatus}`);
      }
      if (!initialize.envelope) {
        return healthOf('unreachable', `http_status_${initialize.httpStatus}`);
      }
      if (initialize.envelope.error !== undefined) {
        return healthOf('auth_failed', 'jsonrpc_initialize_error');
      }
      const tools = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < MCP_TOOL_LIST_PROBE_MAX_PAGES; pageIndex += 1) {
        const toolsList = await jsonRpc(url.toString(), headers, {
          jsonrpc: '2.0',
          id: 2 + pageIndex,
          method: 'tools/list',
          params: cursor === undefined ? {} : { cursor },
        }, remainingProbeMs());
        if (toolsList.httpStatus === 401 || toolsList.httpStatus === 403) {
          return healthOf('auth_failed', `http_status_${toolsList.httpStatus}`);
        }
        if (!toolsList.envelope) {
          return healthOf('unreachable', `http_status_${toolsList.httpStatus}`);
        }
        if (toolsList.envelope.error !== undefined) {
          return healthOf('auth_failed', 'jsonrpc_tools_list_error');
        }
        const page = parseMcpToolListPage(toolsList.envelope.result);
        if (!page.ok) {
          return healthOf('unreachable', 'jsonrpc_tools_list_invalid_response');
        }
        for (const tool of page.tools) tools.add(tool);
        if (page.nextCursor === undefined) {
          return healthOf('ok', undefined, [...tools]);
        }
        if (seenCursors.has(page.nextCursor)) {
          return healthOf('unreachable', 'jsonrpc_tools_list_pagination_cycle');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return healthOf('unreachable', 'jsonrpc_tools_list_pagination_limit');
    } catch (err) {
      return healthOf('unreachable', redactProbeSecrets(errorMessage(err)));
    }
  };
  const probeJsonNotification = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    vendor: string,
    /** The credential this probe carries, if any. `last_error` is persisted to
     *  `health_json` and rendered in Settings, and the two error strings below
     *  are vendor- / fetcher-authored — so scrub the credential out of them
     *  BEFORE `healthOf` truncates (redacting after truncation could leave a
     *  token PREFIX behind). Load-bearing for the `url_token` placement, where
     *  the token is a URL path segment and any error that echoes the URL would
     *  otherwise persist it. */
    secret?: string,
  ): Promise<ConnectionHealth> => {
    const redact = (message: string): string => {
      if (!secret) return message;
      // Scrub the raw credential AND its percent-encoded renderings. Under the
      // `url_token` placement the token is a URL path segment, so an error that
      // echoes the NORMALIZED url carries it ENCODED, not raw — and which
      // encoding depends on the character: URL normalization escapes a space but
      // leaves `/` and `?` structural (that is `encodeURI`), while a fully
      // component-escaped rendering (`encodeURIComponent`) escapes those too.
      // Scrub every rendering rather than guess which one an error will carry.
      // (Today's real Slack / Telegram tokens hold no escapable character, so
      // this is hardening for a future vendor whose charset we do not control.)
      return [secret, encodeURI(secret), encodeURIComponent(secret)]
        .filter((rendering, i, all) => all.indexOf(rendering) === i)
        .reduce((message_, rendering) => message_.split(rendering).join('***'), message);
    };
    try {
      const response = await fetchTimed(url, init);
      if (response.status === 401 || response.status === 403) {
        return healthOf('auth_failed', `http_status_${response.status}`);
      }
      if (!response.ok) return healthOf('unreachable', `${vendor}_http_status_${response.status}`);
      const envelope = await response.json() as { ok?: unknown; error?: unknown; description?: unknown };
      if (envelope?.ok === false) {
        return healthOf(
          'auth_failed',
          redact(
            typeof envelope.error === 'string'
              ? envelope.error
              : (typeof envelope.description === 'string' ? envelope.description : `${vendor}_auth_failed`),
          ),
        );
      }
      return healthOf('ok');
    } catch (err) {
      return healthOf('unreachable', redact(errorMessage(err)));
    }
  };
  /** D-192 CORE #6 seam 8 — the generic chat-transport health probe. Every
   *  messenger vendor's probe is the same shape (call the vendor's cheap
   *  authenticated identity endpoint, classify the JSON envelope); the only
   *  per-vendor facts are the URL, the method, and where the credential rides —
   *  all three declared on the vendor's `health_probe` facet. A new messenger
   *  vendor is one registry entry, never an arm here. */
  const probeMessenger = async (
    declaration: MessengerVendorDeclaration,
    auth: ConnectionAuth,
  ): Promise<ConnectionHealth> => {
    const { url: template, method, auth: placement } = declaration.health_probe;
    // `resolveBearerAccessToken` is the connection layer's single credential
    // seam (bearer `token` / oauth2_refresh `current_access_token`) — reading it
    // here rather than `auth.token` directly is what lets an OAuth-auth vendor
    // (`MESSENGER_AUTH_KINDS.oauth`) join without touching this prober.
    const token = resolveBearerAccessToken(auth);
    // NB `resolveBearerAccessToken` admits a whitespace-only token (`length > 0`)
    // where the `authString` it replaces did not (`trim()`) — keep the stricter
    // guard, or a blank credential would go out on the wire instead of failing
    // closed.
    if (token === undefined || token.trim() === '') {
      // A `bearer` row with a blank/absent token is a definite misconfiguration:
      // the pre-registry arms called `authString`, which threw, and the caller
      // mapped the throw to `unknown`.
      if (auth.type === 'bearer') throw new Error('auth.token_missing');
      // Every other auth type carries no usable bearer credential — including an
      // `oauth2_refresh` row whose access token has not been minted or refreshed
      // yet (`current_access_token` is optional at enrollment). `auth_failed`
      // rather than `unknown` is load-bearing here, not cosmetic: the
      // source-freshness producer maps `auth_failed` to `permission_revoked` and
      // `unknown` to no reason at all, so downgrading it would silently drop a
      // degradation signal.
      return healthOf('auth_failed', `auth_type_${auth.type}`);
    }
    const url = placement === 'url_token'
      ? template.split(MESSENGER_PROBE_TOKEN_PLACEHOLDER).join(token)
      : template;
    // Dispatch on the declared PLACEMENT, never on the vendor (§0.5). The two header
    // placements differ by ONE word, and that word is load-bearing: Discord reads
    // `Bearer` as an OAuth2 user token, so a perfectly valid BOT token probed with
    // the wrong scheme comes back 401 and the channel reports `auth_failed` while
    // being entirely healthy — a lie indistinguishable, from the UI, from a revoked
    // credential.
    const authHeader =
      placement === 'bearer_header'
        ? `Bearer ${token}`
        : placement === 'bot_header'
          ? `Bot ${token}`
          : null;
    return probeJsonNotification(
      url,
      {
        method,
        ...(authHeader !== null ? { headers: { Authorization: authHeader } } : {}),
      },
      declaration.vendor,
      // Scrub unconditionally, not just for `url_token`: the rule "never echo a
      // credential we're holding" is the same either way, and a vendor that
      // reflects the token in an error body would leak it from the header
      // placement too.
      token,
    );
  };
  const probeNotification = async (auth: ConnectionAuth): Promise<ConnectionHealth> => {
    const subtype = existing.subtype;
    // Chat transports (D-192 CORE #6): the messenger registry drives the probe.
    // The former per-vendor `case 'slack'` / `case 'telegram'` arms differed ONLY
    // in the URL, the method + where the token rode — now all three are declared
    // facts on the vendor's `health_probe` facet.
    const messenger = subtype !== undefined ? getMessengerVendorDeclaration(subtype) : null;
    if (messenger !== null) return probeMessenger(messenger, auth);

    // Everything below is a discrete notification SURFACE, not a chat transport
    // — no `@recued/transport` Transport, absent from the messenger registry by
    // construction, and neither one makes a network call.
    switch (subtype) {
      case 'in-app':
        return healthOf('ok');
      case 'email': {
        // The `email` notification connection is a façade over a warehouse
        // mail instance (D-127): it carries no transport of its own —
        // `config.sender_mail_instance` names the `data.mail.<instance>` whose
        // IMAP/SMTP/gmail/graph provider does the actual delivery, and the
        // send path (`connection-notification.ts`) hard-fails when it's
        // missing. The connection-handler can't reach the mail collection to
        // network-probe that provider (its creds live encrypted in the mail
        // collection, not on this record), so this is a CONFIG-readiness check
        // — consistent with the `in-app` arm above + the D-163
        // `ChannelReadinessProbe`, both of which treat "configured + adapter
        // wired" as ready rather than network-verified. A missing
        // `sender_mail_instance` is a definite misconfiguration the send path
        // would reject, so it surfaces as `unreachable` (the channel can't
        // deliver) rather than `unknown`. No credential is read here, so the
        // health string never leaks one.
        let senderInstance: unknown;
        try {
          senderInstance = readConfig()['sender_mail_instance'];
        } catch {
          return healthOf('unknown', 'email_config_unreadable');
        }
        // The send path forwards the EXACT (untrimmed) value as the mail-
        // instance lookup key (connection-notification.ts), and enrollment
        // doesn't canonicalize it — so a missing, blank, OR surrounding-
        // whitespace value would fail the collection lookup at send time.
        // Surface all three as `unreachable` here rather than a misleading
        // `ok` (a probe must predict what send would do).
        if (
          typeof senderInstance !== 'string' ||
          senderInstance.trim() === '' ||
          senderInstance.trim() !== senderInstance
        ) {
          return healthOf('unreachable', 'email_no_sender_mail_instance');
        }
        return healthOf('ok');
      }
      // `smtp` / `gmail` / `graph` are NOT enrollable notification subtypes —
      // enrollment validates against NOTIFICATION_SUBTYPES (the declared
      // messenger vendors + `email` + `in-app`), so a connection carrying one of
      // those can't exist here and they fall through to the `default` `unknown`
      // arm. Their real IMAP/SMTP/gmail/graph providers live in the mail
      // collection, reached via the `email` façade above.
      default:
        return healthOf('unknown', `subtype_${String(subtype ?? 'missing')}_probe_not_implemented`);
    }
  };
  let health: ConnectionHealth;
  if (!deps.getEncryptionKey) {
    health = healthOf('unknown');
  } else {
    const key = deps.getEncryptionKey();
    if (!key) {
      health = healthOf('unknown', 'vault_locked');
    } else {
      const checkedKey = (): Uint8Array => key;
      try {
        const auth = await decodeAuthFromStorage(
          existing.auth_ciphertext,
          { kind, name },
          checkedKey,
        );
        switch (kind) {
          case 'api': {
            if (auth.type === 'oauth2_client_credentials') {
              try {
                const liveAuth = await exchangeOAuth2ClientCredentials(
                  auth,
                  deps.resolveFetch ?? globalThis.fetch.bind(globalThis),
                  () => now,
                );
                health = await probeApi(liveAuth);
              } catch {
                // Credential exchange failures are authentication failures, not
                // generic reachability failures. Keep the message non-secret.
                health = healthOf('auth_failed', 'token_exchange_failed');
              }
              break;
            }
            health = await probeApi(auth);
            break;
          }
          case 'mcp':
            health = await probeMcp(auth);
            break;
          case 'notification':
            health = await probeNotification(auth);
            break;
        }
      } catch (err) {
        health = healthOf('unknown', errorMessage(err));
      }
    }
  }
  deps.store.upsert({
    name,
    kind,
    ...(existing.subtype !== undefined ? { subtype: existing.subtype } : {}),
    display_name: existing.display_name,
    ...(existing.publisher_id !== undefined ? { publisher_id: existing.publisher_id } : {}),
    config_json: existing.config_json,
    auth_ciphertext: existing.auth_ciphertext,
    enrolled_at: existing.enrolled_at,
    updated_at: now,
    ...(existing.last_used_at !== undefined ? { last_used_at: existing.last_used_at } : {}),
    health_json: JSON.stringify(health),
    // D-165 P3.path-picker — preserve the scope across a probe re-stamp.
    ...(existing.subresource_path !== undefined ? { subresource_path: existing.subresource_path } : {}),
    // granted-scopes — preserve the coverage set across a probe re-stamp.
    ...(existing.granted_scopes_json !== undefined ? { granted_scopes_json: existing.granted_scopes_json } : {}),
  });
  return { health };
};

/** D-129 P1.2 — vendor OAuth code-exchange. The enrollment dialog
 *  drives the user through the vendor's authorize URL (P1.3 wires the
 *  in-app dance via `chrome.identity.launchWebAuthFlow` / popup
 *  window), captures the redirect `code`, and pushes it here with the
 *  user-supplied BYO Developer Portal `client_id` + `client_secret`
 *  (the privacy-axis invariant — no Recued OAuth broker, per D-062).
 *  The server exchanges the code for a refresh token via the vendor
 *  provider's `token_endpoint`, optionally introspects the freshly-
 *  minted access token to read the granted-scope set (HubSpot path,
 *  since HubSpot omits `scope` from the token response), and returns
 *  both back to the dialog so the user sees the granted scopes before
 *  clicking Save (which fires `collection.connection.enroll`). */
export const handleConnectionCompleteVendorOAuth = async (
  deps: ConnectionRpcDeps,
  args: {
    vendor: string;
    code: string;
    redirect_uri: string;
    client_id: string;
    client_secret?: string;
    /** D-130 — sandbox-mode flag. When `true` and the vendor
     *  declares sandbox OAuth URLs (Salesforce), the code
     *  exchange POSTs to the sandbox token endpoint. Vendors
     *  without a sandbox split (HubSpot) ignore the flag. */
    sandbox?: boolean;
  },
): Promise<{ refresh_token: string; granted_scopes: string[]; instance_url?: string }> => {
  const a = ensureRecordArgs('collection.connection.completeVendorOAuth', args);
  if (typeof a.vendor !== 'string' || !a.vendor.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.completeVendorOAuth: vendor is required',
    );
  }
  if (typeof a.code !== 'string' || !a.code.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.completeVendorOAuth: code is required',
    );
  }
  if (typeof a.redirect_uri !== 'string' || !a.redirect_uri.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.completeVendorOAuth: redirect_uri is required',
    );
  }
  if (typeof a.client_id !== 'string' || !a.client_id.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.completeVendorOAuth: client_id is required',
    );
  }
  if (
    a.client_secret !== undefined &&
    (typeof a.client_secret !== 'string' || !a.client_secret.trim())
  ) {
    throw new RpcError(
      'bad_request',
      'collection.connection.completeVendorOAuth: client_secret must be non-empty when present',
    );
  }
  if (a.sandbox !== undefined && typeof a.sandbox !== 'boolean') {
    throw new RpcError(
      'bad_request',
      'collection.connection.completeVendorOAuth: sandbox must be boolean when present',
    );
  }

  const provider = getVendorProvider(a.vendor);
  if (!provider) {
    throw new RpcError(
      'bad_request',
      `collection.connection.completeVendorOAuth: unknown vendor '${a.vendor}'`,
    );
  }

  if (
    provider.oauth.client_secret_required &&
    (typeof a.client_secret !== 'string' || !a.client_secret.trim())
  ) {
    throw new RpcError(
      'bad_request',
      `collection.connection.completeVendorOAuth: vendor '${a.vendor}' requires client_secret`,
    );
  }

  try {
    return await completeVendorOAuth({
      provider,
      code: a.code,
      redirect_uri: a.redirect_uri,
      client_id: a.client_id,
      ...(a.client_secret !== undefined ? { client_secret: a.client_secret } : {}),
      ...(a.sandbox !== undefined ? { sandbox: a.sandbox } : {}),
      ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
    });
  } catch (e) {
    if (e instanceof VendorOAuthError) {
      throw new RpcError(
        'bad_request',
        `collection.connection.completeVendorOAuth: ${e.message}`,
        e.status,
      );
    }
    throw e;
  }
};

/** D-148 § A.12 / D-165 enroll-host #1 — vendor OAuth-start. Mints the
 *  signed `state`, builds the vendor authorize URL, and stashes the
 *  pending flow so `/oauth/complete` (slice 2) can resolve the exchange
 *  inputs. Returns the authorize URL the webclient opens + the
 *  server-identity public key it caches for the callback page. No
 *  connection row + no token is written here. */
const handleConnectionStartVendorOAuth = async (
  deps: ConnectionRpcDeps,
  args: {
    vendor: string;
    client_id: string;
    client_secret?: string;
    redirect_uri: string;
    sandbox?: boolean;
    authorize_url?: string;
    token_endpoint?: string;
    scopes?: ReadonlyArray<string>;
  },
): Promise<{
  authorize_url: string;
  flow_id: string;
  server_identity_public_key_b64: string;
  claim_secret: string;
}> => {
  const wiring = deps.vendorOAuthStart;
  if (!wiring) {
    throw new RpcError(
      'not_configured',
      'collection.connection.startVendorOAuth: vendor OAuth-start substrate not wired',
    );
  }
  const a = ensureRecordArgs('collection.connection.startVendorOAuth', args);
  if (typeof a.vendor !== 'string' || !a.vendor.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.startVendorOAuth: vendor is required',
    );
  }
  if (typeof a.client_id !== 'string' || !a.client_id.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.startVendorOAuth: client_id is required',
    );
  }
  if (typeof a.redirect_uri !== 'string' || !a.redirect_uri.trim()) {
    throw new RpcError(
      'bad_request',
      'collection.connection.startVendorOAuth: redirect_uri is required',
    );
  }
  if (
    a.client_secret !== undefined &&
    (typeof a.client_secret !== 'string' || !a.client_secret.trim())
  ) {
    throw new RpcError(
      'bad_request',
      'collection.connection.startVendorOAuth: client_secret must be non-empty when present',
    );
  }
  if (a.sandbox !== undefined && typeof a.sandbox !== 'boolean') {
    throw new RpcError(
      'bad_request',
      'collection.connection.startVendorOAuth: sandbox must be boolean when present',
    );
  }

  // R14 — provider source. A REGISTERED vendor ALWAYS uses its registry config
  // (PKCE / scopes / sandbox endpoints / secret gate / introspection); any
  // form-supplied endpoints on a registered vendor are IGNORED so they can
  // never bypass those controls. The form-supplied path is reserved for
  // non-registry vendors (the webclient labels them with the generic sentinel),
  // where we synthesize a provider from the typed authorize/token URLs + scopes.
  const registered = getVendorProvider(a.vendor);
  const formAuthorizeUrl =
    typeof a.authorize_url === 'string' ? a.authorize_url.trim() : '';
  const formTokenEndpoint =
    typeof a.token_endpoint === 'string' ? a.token_endpoint.trim() : '';
  const isFormSupplied =
    registered === null
    && formAuthorizeUrl.length > 0
    && formTokenEndpoint.length > 0;
  // Validate the client-supplied `scopes` ONCE — both branches consume it:
  // the generic form path's requested set, and (Fork 1) the registered path's
  // editable, pre-filled override. `undefined` = the client passed none.
  let requestedScopesArg: string[] | undefined;
  if (a.scopes !== undefined) {
    if (!Array.isArray(a.scopes) || a.scopes.some((s) => typeof s !== 'string')) {
      throw new RpcError(
        'bad_request',
        'collection.connection.startVendorOAuth: scopes must be an array of strings when present',
      );
    }
    requestedScopesArg = a.scopes.map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const formScopes: string[] = requestedScopesArg ?? [];
  let provider;
  if (isFormSupplied) {
    // Require https on BOTH URLs — the server POSTs the client_secret + auth
    // code to `token_endpoint`, so plaintext is a credential-leak surface.
    for (const [label, raw] of [
      ['authorize_url', formAuthorizeUrl],
      ['token_endpoint', formTokenEndpoint],
    ] as const) {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new RpcError(
          'bad_request',
          `collection.connection.startVendorOAuth: ${label} must be a valid URL`,
        );
      }
      if (parsed.protocol !== 'https:') {
        throw new RpcError(
          'bad_request',
          `collection.connection.startVendorOAuth: ${label} must be an https URL`,
        );
      }
    }
    provider = buildGenericVendorProvider({
      authorize_url: formAuthorizeUrl,
      token_endpoint: formTokenEndpoint,
      scopes: formScopes,
      vendor: a.vendor,
    });
  } else if (registered) {
    // Fork 1 — request the vendor const (the non-trimmable FLOOR: it carries
    // the vendor essentials — `oauth` / `refresh_token` / `offline_access` —
    // plus the pack's read baseline, and is exactly today's requested set)
    // UNIONed with the pack scopes. Source of the pack scopes: the client's
    // explicit (pre-filled, possibly user-trimmed) set when passed — so the
    // user can DROP additions; else the server unions the installed packs'
    // needs itself (defense-in-depth + pre-B clients). The const floor is
    // always present, so trimming an essential in the editable field is a
    // no-op; only the pack additions beyond the const are trimmable.
    const packScopes =
      requestedScopesArg ?? wiring.installedPackScopeUnion?.(a.vendor) ?? [];
    // Set insertion order: the const verbatim first (so a no-pack enroll is
    // byte-identical to today), then the deduped pack additions. No sort.
    const requested = [...new Set([...registered.oauth.scopes, ...packScopes])];
    provider = {
      ...registered,
      oauth: { ...registered.oauth, scopes: requested },
    };
  } else {
    throw new RpcError(
      'bad_request',
      `collection.connection.startVendorOAuth: unknown vendor '${a.vendor}'`,
    );
  }
  if (
    provider.oauth.client_secret_required &&
    (typeof a.client_secret !== 'string' || !a.client_secret.trim())
  ) {
    throw new RpcError(
      'bad_request',
      `collection.connection.startVendorOAuth: vendor '${a.vendor}' requires client_secret`,
    );
  }

  const rawServerUrl = wiring.serverPublicUrl();
  if (typeof rawServerUrl !== 'string' || !rawServerUrl.trim()) {
    throw new RpcError(
      'not_configured',
      "collection.connection.startVendorOAuth: server public URL not configured — set up your server's reachable HTTPS address (Pro subdomain or your own domain) before vendor OAuth",
    );
  }
  // Canonicalize to a clean HTTPS origin BEFORE building the redirect
  // choices or signing it into the state — the cloud callback page POSTs
  // the code to `<server_url>/oauth/complete`, so a trailing slash,
  // http://, embedded credentials, or a path/query/fragment must never
  // reach that construction. The signed state + the validated choice now
  // share one canonical value.
  const serverUrl = canonicalizeServerPublicUrl(rawServerUrl);
  if (!serverUrl) {
    throw new RpcError(
      'not_configured',
      `collection.connection.startVendorOAuth: server public URL is not a clean HTTPS origin (got '${rawServerUrl}') — configure it as https://<host>`,
    );
  }
  const choices = vendorOAuthRedirectChoices(serverUrl);
  if (!choices.includes(a.redirect_uri)) {
    throw new RpcError(
      'bad_request',
      `collection.connection.startVendorOAuth: redirect_uri must be one of: ${choices.join(' | ')}`,
    );
  }

  const now = (deps.now ?? Date.now)();
  const flow_id = (wiring.newFlowId ?? defaultFlowId)();
  // Owner-binding nonce — minted here, returned ONLY on this response (to
  // the originating client), stamped into the flow record so the completion
  // result inherits it and `takeVendorOAuthResult` can gate the credential.
  const claim_secret = (wiring.newClaimSecret ?? defaultClaimSecret)();
  // PKCE verifier — minted unconditionally; `startVendorOAuth` uses it only
  // for `supports_pkce` vendors (else it's discarded). Never returned to the
  // client (server-side secret).
  const code_verifier = (wiring.newCodeVerifier ?? defaultCodeVerifier)();
  const { authorize_url, record } = startVendorOAuth({
    provider,
    client_id: a.client_id,
    ...(a.client_secret !== undefined ? { client_secret: a.client_secret } : {}),
    redirect_uri: a.redirect_uri,
    sandbox: a.sandbox === true,
    server_url: serverUrl,
    flow_id,
    claim_secret,
    code_verifier,
    now,
    sign: (bytes) => wiring.identity.signWithServerIdentity(bytes),
  });
  // Persist the form-supplied token endpoint (+ requested scopes) on the
  // record so `/oauth/complete` can exchange against it without a registry
  // lookup. Registered-vendor flows store nothing extra (the strict
  // record-shape tests assert that).
  wiring.flowStore.put(
    isFormSupplied
      ? {
          ...record,
          token_endpoint: formTokenEndpoint,
          ...(formScopes.length > 0 ? { scopes: formScopes } : {}),
        }
      : record,
  );
  return {
    authorize_url,
    flow_id,
    server_identity_public_key_b64: wiring.identity.serverIdentityKey().public_key_b64,
    claim_secret,
  };
};

/** D-165 slice 3 — vendor OAuth result-claim. The owner-bound partner to
 *  `/oauth/complete`: once the completion handler stashes the exchanged
 *  credential in the result store + fires the `{ flow_id }` completion
 *  broadcast, the originating dialog claims it here by presenting the
 *  `claim_secret` the start rpc handed it. The result store consumes +
 *  returns the credential ONLY on a constant-time secret match; a
 *  mismatch (any OTHER paired client reacting to the same broadcast) or an
 *  absent / already-claimed flow returns `{ result: null }` WITHOUT
 *  consuming — so the legitimate dialog can still claim after a probe. The
 *  broadcast carries only `flow_id`, never the credential, so this rpc is
 *  the sole path the refresh token reaches a client. */
const handleConnectionTakeVendorOAuthResult = async (
  deps: ConnectionRpcDeps,
  args: { flow_id: string; claim_secret: string },
): Promise<{ result: VendorOAuthResult | null }> => {
  const method = 'collection.connection.takeVendorOAuthResult';
  const wiring = deps.vendorOAuthResult;
  if (!wiring) {
    throw new RpcError(
      'not_configured',
      `${method}: vendor OAuth result substrate not wired`,
    );
  }
  const a = ensureRecordArgs(method, args);
  if (typeof a.flow_id !== 'string' || !a.flow_id.trim()) {
    throw new RpcError('bad_request', `${method}: flow_id is required`);
  }
  if (typeof a.claim_secret !== 'string' || !a.claim_secret.trim()) {
    throw new RpcError('bad_request', `${method}: claim_secret is required`);
  }
  return { result: wiring.resultStore.take(a.flow_id, a.claim_secret) };
};

// ─────────────────── D-165 follow-on — operation-group grants ───────────────────

/** Pull the operation-grant deps or fail with a clear `not_configured` — the
 *  three grant rpcs are no-ops on surfaces that never wired a catalog (dbless
 *  harnesses, the uninitialized FileVault path). */
const requireOperationGrants = (
  deps: ConnectionRpcDeps,
  method: string,
): NonNullable<ConnectionRpcDeps['operationGrants']> => {
  if (!deps.operationGrants) {
    throw new RpcError(
      'not_configured',
      `${method}: operation-group grants are not available on this server (no catalog wired)`,
    );
  }
  return deps.operationGrants;
};

/** Validate the target is a grantable connection — an existing `api`
 *  connection whose vendor has a registered catalog (HubSpot / Salesforce /
 *  …) — and return THAT vendor's catalog manifest for the caller to validate
 *  the group against + derive the view from. Grants are keyed by connection
 *  name; refusing vendors with no catalog (and non-`api` kinds) keeps a grant
 *  from landing on, e.g., a notification connection of the same name. */
const ensureGrantableConnection = (
  deps: ConnectionRpcDeps,
  grants: NonNullable<ConnectionRpcDeps['operationGrants']>,
  method: string,
  name: string,
  kind: ConnectionKind,
): IngredientManifest => {
  if (kind !== 'api') {
    throw new RpcError(
      'bad_request',
      `${method}: operation-group grants apply to 'api' connections (got '${kind}')`,
    );
  }
  const existing = deps.store.get(kind, name);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `${method}: no ${kind} connection named '${name}'`,
    );
  }
  const vendor = resolveVendorFromConnection(existing);
  // A registered vendor (config.vendor → catalog), OR — D-170 gap #2 — a private/
  // local composition catalog bound to this connection (resolved by connection name
  // via the install-recorded binding). Either yields the catalog manifest the group
  // is validated against + the view is derived from; the grant is keyed by
  // `manifest.slug` (the connection name keys the binding, the catalog keys the grant).
  const manifest =
    (vendor ? grants.getCatalogManifest(vendor) : undefined)
    ?? grants.resolveLocalCatalog?.(name)
    ?? undefined;
  if (!manifest) {
    throw new RpcError(
      'bad_request',
      `${method}: connection '${name}' has no operation catalog (vendor='${vendor ?? 'none'}'); operation-group grants require a connection with a registered vendor catalog (hubspot, salesforce) or a locally-installed composition catalog`,
    );
  }
  return manifest;
};

/** Compute the current grant view for a connection — pure read over the
 *  durable grant store + the connection's resolved catalog manifest. Used by
 *  all three rpcs (grant/revoke recompute it after mutating; list returns it
 *  directly). The manifest is resolved once per call by the caller (via
 *  `ensureGrantableConnection`) and threaded in. */
const computeOperationGroupView = (
  grants: NonNullable<ConnectionRpcDeps['operationGrants']>,
  connection_name: string,
  manifest: IngredientManifest,
): OperationGroupGrantView => {
  const granted_groups = grants.store.listUserGroups(manifest.slug, connection_name);
  // D-165 P3 — the effective view UNIONS the user-manual grants with every installed
  // pack's grants on this `(ingredient_id, connection_name)` (Path A), so re-deriving
  // the live profile after a user grant/revoke folds the pack-owned grants back in
  // rather than clobbering them (the boot seed does the identical union). Only
  // `allowed_operations` (what seeds the profile) takes the union; `granted_groups`
  // (the grant panel's per-group toggle state) stays user-manual-only.
  const allowed_operations = deriveAllowedOperations(manifest, [
    ...granted_groups,
    ...grants.store.listPackOwnedGroups(manifest.slug, connection_name),
  ]);
  const grantedSet = new Set(granted_groups);
  const groups = manifest?.operation_groups ?? {};
  const available_groups = Object.entries(groups).map(([group_id, spec]) => ({
    group_id,
    operations: [...(spec.operations ?? [])],
    ...(spec.risk_floor ? { risk_floor: spec.risk_floor } : {}),
    granted: grantedSet.has(group_id),
  }));
  return { connection_name, granted_groups, allowed_operations, available_groups };
};

/** Re-derive + write the live operation profile so the gateway's
 *  `connectionProfileResolver` sees the grant change immediately (the boot
 *  seed does the identical derivation on the next connection upsert, so the
 *  two paths stay consistent — including the `catalog_slug` stamp the gateway
 *  uses for the cross-vendor mismatch guard). Empty set ⇒ drop the profile
 *  (fail-closed). */
const reseedOperationProfile = (
  grants: NonNullable<ConnectionRpcDeps['operationGrants']>,
  connection_name: string,
  allowed_operations: ReadonlyArray<string>,
  catalog_slug: string,
): void => {
  if (allowed_operations.length === 0) {
    grants.profileStore.delete(connection_name);
    return;
  }
  grants.profileStore.set(connection_name, {
    allowed_operations: [...allowed_operations],
    catalog_slug,
  });
};

/** Validate `group_id` is declared by the connection's catalog — a grant for
 *  an undeclared group would silently add nothing (deriveAllowedOperations
 *  ignores unknown groups), so reject it up front for an actionable error. */
const ensureDeclaredGroup = (
  manifest: IngredientManifest,
  method: string,
  group_id: string,
): void => {
  const groups = manifest.operation_groups ?? {};
  if (!Object.prototype.hasOwnProperty.call(groups, group_id)) {
    throw new RpcError(
      'bad_request',
      `${method}: unknown operation group '${group_id}' (declared groups: ${Object.keys(groups).join(', ') || 'none'})`,
    );
  }
};

const ensureGroupId = (method: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('bad_request', `${method}: group_id is required`);
  }
  return value;
};

const handleConnectionGrantOperationGroup = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind; group_id: string },
): Promise<OperationGroupGrantView> => {
  const method = 'collection.connection.grantOperationGroup';
  const grants = requireOperationGrants(deps, method);
  const a = ensureRecordArgs(method, args);
  const name = ensureName(method, a.name);
  const kind = ensureKind(method, a.kind);
  const group_id = ensureGroupId(method, a.group_id);
  const manifest = ensureGrantableConnection(deps, grants, method, name, kind);
  ensureDeclaredGroup(manifest, method, group_id);
  grants.store.grantUserGroup(manifest.slug, name, group_id);
  const view = computeOperationGroupView(grants, name, manifest);
  reseedOperationProfile(grants, name, view.allowed_operations, manifest.slug);
  // R2 build step 4c.4 — granting an op group widens the provider's canonical
  // ops, which can flip recipes runnable; recompute + broadcast (best-effort,
  // after the profile re-seed reads correct state).
  deps.recipeRunnabilityBroadcast?.recomputeAndEmit();
  return view;
};

const handleConnectionRevokeOperationGroup = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind; group_id: string },
): Promise<OperationGroupGrantView> => {
  const method = 'collection.connection.revokeOperationGroup';
  const grants = requireOperationGrants(deps, method);
  const a = ensureRecordArgs(method, args);
  const name = ensureName(method, a.name);
  const kind = ensureKind(method, a.kind);
  const group_id = ensureGroupId(method, a.group_id);
  const manifest = ensureGrantableConnection(deps, grants, method, name, kind);
  ensureDeclaredGroup(manifest, method, group_id);
  grants.store.revokeUserGroup(manifest.slug, name, group_id);
  const view = computeOperationGroupView(grants, name, manifest);
  reseedOperationProfile(grants, name, view.allowed_operations, manifest.slug);
  // R2 build step 4c.4 — revoking an op group narrows the provider's canonical
  // ops, which can flip recipes blocked; recompute + broadcast (best-effort,
  // after the profile re-seed reads correct state).
  deps.recipeRunnabilityBroadcast?.recomputeAndEmit();
  return view;
};

const handleConnectionListOperationGroups = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind },
): Promise<OperationGroupGrantView> => {
  const method = 'collection.connection.listOperationGroups';
  const grants = requireOperationGrants(deps, method);
  const a = ensureRecordArgs(method, args);
  const name = ensureName(method, a.name);
  const kind = ensureKind(method, a.kind);
  const manifest = ensureGrantableConnection(deps, grants, method, name, kind);
  return computeOperationGroupView(grants, name, manifest);
};

/** D-192 M4c-UI — read a connection's declared messenger `match_patterns`.
 *  A dedicated read because the field is stripped from `ConnectionView`
 *  (`CONNECTION_VIEW_RESERVED_FIELDS`) so the Settings editor cannot
 *  pre-populate from the list view. `[]` when the connection declares none. */
export const handleConnectionGetMatchPatterns = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind },
): Promise<{ match_patterns: MessageMatchPattern[] }> => {
  const a = ensureRecordArgs('collection.connection.getMatchPatterns', args);
  const name = ensureName('collection.connection.getMatchPatterns', a.name);
  const kind = ensureKind('collection.connection.getMatchPatterns', a.kind);
  const existing = deps.store.get(kind, name);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.connection.getMatchPatterns: no ${kind} connection named '${name}'`,
    );
  }
  return { match_patterns: readStoredMatchPatterns(existing.config_json) };
};

/** D-192 M4c-UI — set a connection's messenger `match_patterns`. MERGES the
 *  list into the stored `config_json` (preserving `channel_id` / inbound
 *  secrets / every other config field), unlike the wholesale-replace `update` —
 *  the editor never sees those stripped fields, so it must not drive a full
 *  replace. Re-validates with the same rule the enroll/update guard uses; an
 *  empty array clears the field. Echoes the saved list. */
export const handleConnectionSetMatchPatterns = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind; match_patterns: unknown },
): Promise<{ match_patterns: MessageMatchPattern[] }> => {
  const a = ensureRecordArgs('collection.connection.setMatchPatterns', args);
  const name = ensureName('collection.connection.setMatchPatterns', a.name);
  const kind = ensureKind('collection.connection.setMatchPatterns', a.kind);
  // Existence first (mirrors `update` / `getMatchPatterns`), then payload
  // validation — an invalid write never mutates the row either way.
  const existing = deps.store.get(kind, name);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.connection.setMatchPatterns: no ${kind} connection named '${name}'`,
    );
  }
  if (a.match_patterns === undefined) {
    throw new RpcError(
      'bad_request',
      `collection.connection.setMatchPatterns: ${MESSAGE_MATCH_CONFIG_KEY} is required`,
    );
  }
  // Same array + per-pattern validation the enroll/update write boundary runs.
  ensureValidMatchPatterns('collection.connection.setMatchPatterns', {
    [MESSAGE_MATCH_CONFIG_KEY]: a.match_patterns,
  });
  const patterns = a.match_patterns as MessageMatchPattern[];
  // Merge into the existing config — never touch other fields. A malformed
  // stored config falls back to an empty object (the row is re-homed with a
  // clean config carrying only the triggers; adapter calls surfaced the
  // malformed config already).
  const config = parseStoredConfig(existing.config_json);
  if (patterns.length === 0) {
    delete config[MESSAGE_MATCH_CONFIG_KEY];
  } else {
    config[MESSAGE_MATCH_CONFIG_KEY] = patterns;
  }
  const now = deps.now?.() ?? Date.now();
  deps.store.upsert({
    name,
    kind,
    ...(existing.subtype !== undefined ? { subtype: existing.subtype } : {}),
    display_name: existing.display_name,
    ...(existing.publisher_id !== undefined ? { publisher_id: existing.publisher_id } : {}),
    config_json: JSON.stringify(config),
    auth_ciphertext: existing.auth_ciphertext,
    enrolled_at: existing.enrolled_at,
    updated_at: now,
    ...(existing.last_used_at !== undefined ? { last_used_at: existing.last_used_at } : {}),
    ...(existing.health_json !== undefined ? { health_json: existing.health_json } : {}),
    ...(existing.subresource_path !== undefined ? { subresource_path: existing.subresource_path } : {}),
    ...(existing.granted_scopes_json !== undefined
      ? { granted_scopes_json: existing.granted_scopes_json }
      : {}),
  });
  return { match_patterns: patterns };
};

type ConnectionMethods =
  | 'collection.connection.list'
  | 'collection.connection.enroll'
  | 'collection.connection.update'
  | 'collection.connection.delete'
  | 'collection.connection.previewPurge'
  | 'collection.connection.probe'
  | 'collection.connection.getMatchPatterns'
  | 'collection.connection.setMatchPatterns'
  | 'collection.connection.grantOperationGroup'
  | 'collection.connection.revokeOperationGroup'
  | 'collection.connection.listOperationGroups'
  | 'collection.connection.completeVendorOAuth'
  | 'collection.connection.startVendorOAuth'
  | 'collection.connection.takeVendorOAuthResult';

export const makeConnectionHandlers = (
  deps: ConnectionRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ConnectionMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'collection.connection.list',
      'collection.connection.enroll',
      'collection.connection.update',
      'collection.connection.delete',
      'collection.connection.previewPurge',
      'collection.connection.probe',
      'collection.connection.getMatchPatterns',
      'collection.connection.setMatchPatterns',
      'collection.connection.grantOperationGroup',
      'collection.connection.revokeOperationGroup',
      'collection.connection.listOperationGroups',
      'collection.connection.completeVendorOAuth',
      'collection.connection.startVendorOAuth',
      'collection.connection.takeVendorOAuthResult',
    ],
    handlers: {
      'collection.connection.list': async (args) =>
        handleConnectionList(deps, args as Parameters<typeof handleConnectionList>[1]),
      'collection.connection.enroll': async (args) =>
        handleConnectionEnroll(
          deps,
          args as Parameters<typeof handleConnectionEnroll>[1],
        ),
      'collection.connection.update': async (args) =>
        handleConnectionUpdate(
          deps,
          args as Parameters<typeof handleConnectionUpdate>[1],
        ),
      'collection.connection.delete': async (args) =>
        handleConnectionDelete(
          deps,
          args as Parameters<typeof handleConnectionDelete>[1],
        ),
      'collection.connection.previewPurge': async (args) =>
        handleConnectionPreviewPurge(
          deps,
          args as Parameters<typeof handleConnectionPreviewPurge>[1],
        ),
      'collection.connection.probe': async (args) =>
        handleConnectionProbe(
          deps,
          args as Parameters<typeof handleConnectionProbe>[1],
        ),
      'collection.connection.getMatchPatterns': async (args) =>
        handleConnectionGetMatchPatterns(
          deps,
          args as Parameters<typeof handleConnectionGetMatchPatterns>[1],
        ),
      'collection.connection.setMatchPatterns': async (args) =>
        handleConnectionSetMatchPatterns(
          deps,
          args as Parameters<typeof handleConnectionSetMatchPatterns>[1],
        ),
      'collection.connection.grantOperationGroup': async (args) =>
        handleConnectionGrantOperationGroup(
          deps,
          args as Parameters<typeof handleConnectionGrantOperationGroup>[1],
        ),
      'collection.connection.revokeOperationGroup': async (args) =>
        handleConnectionRevokeOperationGroup(
          deps,
          args as Parameters<typeof handleConnectionRevokeOperationGroup>[1],
        ),
      'collection.connection.listOperationGroups': async (args) =>
        handleConnectionListOperationGroups(
          deps,
          args as Parameters<typeof handleConnectionListOperationGroups>[1],
        ),
      'collection.connection.completeVendorOAuth': async (args) =>
        handleConnectionCompleteVendorOAuth(
          deps,
          args as Parameters<typeof handleConnectionCompleteVendorOAuth>[1],
        ),
      'collection.connection.startVendorOAuth': async (args) =>
        handleConnectionStartVendorOAuth(
          deps,
          args as Parameters<typeof handleConnectionStartVendorOAuth>[1],
        ),
      'collection.connection.takeVendorOAuthResult': async (args) =>
        handleConnectionTakeVendorOAuthResult(
          deps,
          args as Parameters<typeof handleConnectionTakeVendorOAuthResult>[1],
        ),
    },
  };
};

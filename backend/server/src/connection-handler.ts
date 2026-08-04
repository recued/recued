/** D-125 Phase 2.1 — rpc handlers for `collection.connection.*`.
 *  D-125 Phase 2.2 — at-rest auth encryption swapped to AEAD via the
 *  `connection` HKDF sub-DEK; the pair-sync WS rpc ships the same
 *  ciphertext blob unchanged (pair clients hold the sub-DEK derivation
 *  inputs; the server is the storage authority).
 *
 *  Core lifecycle methods: list / enroll / update / verified credential
 *  rotation / delete / probe. Server is authoritative — the durable SQLite
 *  row lives in `storage/
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

import { createHash } from 'node:crypto';

import {
  RpcError,
  connectionViewFromRow,
  connectionRowKey,
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
  CONNECTION_AUTH_TYPES,
  CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX,
  CONNECTION_CREDENTIAL_SAFE_STOP_TOKEN_REGEX,
  connectionCredentialRejectionCorrection,
  connectionCredentialRejectionTriage,
  isValidOAuthEndpointUrl,
  CONNECTION_INBOUND_SECRET_FIELDS,
  getMessengerVendorDeclaration,
  messengerVendorSupportsIngressMode,
  resolveMessengerConnectionIngressMode,
  MESSENGER_INGRESS_MODE_CONFIG_KEY,
  MESSENGER_AUTH_KIND_CONNECTION_TYPES,
  NOTIFICATION_SUBTYPES as CONTRACT_NOTIFICATION_SUBTYPES,
  resolveBearerAccessToken,
  MESSENGER_PROBE_TOKEN_PLACEHOLDER,
  vendorHasEngagement,
} from '@recued/contracts';
import type {
  ConnectionAuth,
  ConnectionCredentialPostSafeStopVerificationSummary,
  ConnectionCredentialRejectionCorrection,
  ConnectionCredentialRejectionResolution,
  ConnectionCredentialRotationActivity,
  ConnectionCredentialRotationFailureReason,
  ConnectionCredentialRotationOutcome,
  ConnectionCredentialRotationSafeStop,
  ConnectionCredentialRotationSafeStopAcknowledgement,
  ConnectionCredentialRotationSafeStopSummary,
  ConnectionCredentialRejectionTriageStage,
  ConnectionCredentialVerification,
  ConnectionDataPurgeSummary,
  ConnectionHealth,
  ConnectionKind,
  ConnectionRow,
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
import {
  resolveConnectionVendor,
  type ConnectionCredentialRotationAttemptRow,
  type ConnectionStoreSqlite,
  type ConnectionUpsert,
} from './storage/connection-store.js';
import type { ContractGrantStore } from './storage/contract-grant-store.js';
import type { ConnectionOperationProfileStore } from './connection-operation-profile.js';
import { deriveAllowedOperations } from './connection-operation-profile-boot.js';
import {
  completeVendorOAuth,
  VendorOAuthError,
  type HttpFetcher,
} from './connection-vendor-oauth.js';
import { makeBoundedOriginHttpFetcher } from './bounded-origin-http-fetcher.js';
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
  createEnsureFreshAuth,
  composeApiUrl,
  MCP_TOOL_LIST_PROBE_MAX_PAGES,
  parseMcpToolListPage,
  probeMcpStreamTools,
  refreshOAuth2,
  resolveStdioMcpLaunchSpec,
} from '@recued/ingredients';
import type { StdioSpawn, WsConnect } from '@recued/ingredients';
import type { McpToolDescriptor } from '@recued/contracts';
// D-225 Slice 2 — descriptor hashes for drift detection, computed at probe.
import {
  mcpGeneratedPackSlug,
  mcpMintedHashes,
  mcpMintedHashesFromCatalog,
  mcpPackManifest,
  mcpPackReviewRows,
  mcpToolsDriftFromHashes,
} from '@recued/ingredient-authoring';
import type { McpPackReviewRow } from '@recued/contracts';
import { resolveSharePointDriveId } from './sharepoint-drive-resolver.js';
import {
  generateConnectionSetupGuide,
  type ConnectionSetupGuideDeps,
} from './connection-setup-guide.js';
import { makeConnectionRuntimeBaseIssueSink } from './connection-runtime-base-issue.js';

export interface ConnectionRpcDeps {
  store: ConnectionStoreSqlite;
  /** Owner-triggered, read-only API setup assistant. The caller supplies the
   *  configured-model invocation; the guide module owns request minimization,
   *  prompt construction, and output validation. Absent → the UI receives an
   *  honest not-configured result rather than a synthetic guide. */
  setupGuide?: ConnectionSetupGuideDeps;
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
  /** D-225 Slice 2 — install a pack the runtime generated from this
   *  connection's `tools/list`. Supplied as a CLOSURE rather than by threading
   *  `PackInstallRpcDeps` in here: the install surface is large, the connection
   *  handler needs exactly one verb from it, and the composition site already
   *  holds the whole bundle. Same shape as `cascadeForConnectionDelete`.
   *
   *  Absent (dbless / partial harnesses) → `mcpPackCommit` refuses rather than
   *  half-succeeding. */
  installGeneratedPack?: (
    manifest: unknown,
    /** D-228 slice 3 — the install-point grant selection, forwarded verbatim to
     *  `packs.install`. Absent ⇒ its fail-closed default (authored read /
     *  `approval: ask` only). */
    install_scope?: unknown,
  ) => Promise<void>;
  /** D-225 Slice 2 — look up an INSTALLED generated pack's catalog manifest by
   *  slug, for the drift badge. A closure for the same reason
   *  `installGeneratedPack` is one: the connection handler needs a lookup, not
   *  the manifest registry's whole surface. Absent ⇒ the badge reports
   *  `unknown` rather than a false all-clear. */
  getInstalledCatalog?: (slug: string) => IngredientManifest | null;
  /** D-225 Slice 2 — tear down the generated pack when its MCP connection is
   *  deleted. Uninstalls the pack AND purges its owner rulings.
   *
   *  ⛔ The reverse direction (uninstalling the pack removes the connection)
   *  exists too, so the two could recurse. The cycle is broken STRUCTURALLY at
   *  the composition site: the deps object this closure hands the uninstall
   *  path OMITS the reverse hook, so the capability to come back here is not
   *  merely unused — it is absent. A flag would be something to forget.
   *
   *  Best-effort, like `cascadeForConnectionDelete`: a teardown failure must not
   *  fail the delete, because the connection row is already gone and refusing
   *  would leave the owner unable to retry. */
  teardownGeneratedPack?: (pack_slug: string) => Promise<void>;
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
  ...CONNECTION_AUTH_TYPES,
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
  MESSENGER_INGRESS_MODE_CONFIG_KEY,
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

/** Optional optimistic-concurrency token emitted by the Settings list view.
 * It is row metadata, never credential material. Older clients omit it and
 * retain the pre-existing last-write-wins behavior. */
const ensureExpectedConnectionUpdatedAt = (
  where: string,
  value: unknown,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RpcError(
      'bad_request',
      `${where}: expected_updated_at must be a non-negative safe integer when present`,
    );
  }
  return value as number;
};

const assertConnectionEditorIsCurrent = (
  where: string,
  expectedUpdatedAt: number | undefined,
  existing: ConnectionRow,
): void => {
  if (
    expectedUpdatedAt === undefined
    || expectedUpdatedAt === existing.updated_at
  ) return;
  throw new RpcError(
    'conflict',
    'This connection changed after you opened it. Your unsaved values were not applied; reload the latest connection before saving.',
    409,
    where,
    { existing_credential_preserved: true },
  );
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

/** OAuth refreshes POST credential material to this owner-configured
 * destination. Shape validation alone is insufficient: the RPC boundary must
 * reject plaintext, parser shorthand, and embedded userinfo before a row can
 * persist them. */
const requireOAuthEndpointField = (
  where: string,
  obj: Record<string, unknown>,
  field: 'token_endpoint',
): void => {
  requireStringField(where, obj, field);
  if (!isValidOAuthEndpointUrl(obj[field])) {
    throw new RpcError(
      'bad_request',
      `${where}: auth.${field} must be a complete HTTPS URL with no embedded username or password and no URL fragment`,
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
      ensureOptionalStringField(where, auth, 'app_token');
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
      requireOAuthEndpointField(where, auth, 'token_endpoint');
      ensureOptionalStringField(where, auth, 'client_secret');
      ensureOptionalTokenAuthStyleField(where, auth);
      ensureOptionalStringField(where, auth, 'current_access_token');
      ensureOptionalNumberField(where, auth, 'expires_at');
      break;
    case 'oauth2_client_credentials':
      requireStringField(where, auth, 'client_id');
      requireStringField(where, auth, 'client_secret');
      requireOAuthEndpointField(where, auth, 'token_endpoint');
      ensureOptionalTokenAuthStyleField(where, auth);
      ensureOptionalStringField(where, auth, 'scope');
      ensureOptionalStringField(where, auth, 'current_access_token');
      ensureOptionalNumberField(where, auth, 'expires_at');
      break;
    // D-218 — two required fields and no endpoint. ⚠ The session URLs derive
    // from the connection's `base_url` (§ 7.5b), so there is deliberately
    // nothing here to validate as a destination; the tokens are optional
    // because a freshly enrolled row has not exchanged yet. ⛔ No `expires_at`
    // — the protocol supplies no expiry and calls its tokens opaque, so storing
    // a number would be inventing one (§ 7.5a).
    case 'atproto_session':
      requireStringField(where, auth, 'identifier');
      requireStringField(where, auth, 'app_password');
      ensureOptionalStringField(where, auth, 'current_access_token');
      ensureOptionalStringField(where, auth, 'refresh_token');
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

/** Persist one explicit ingress mode on every messenger write. Current forms
 *  submit the local-first default; older clients that omit the new field keep
 *  webhook behavior. An explicit invalid value fails closed. */
const normalizeMessengerIngressConfig = (
  where: string,
  subtype: string | undefined,
  config: Record<string, unknown>,
  existingConfig?: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  if (subtype === undefined) return config;
  const declaration = getMessengerVendorDeclaration(subtype);
  if (declaration === null) return config;
  let selected = config[MESSENGER_INGRESS_MODE_CONFIG_KEY];
  if (selected === undefined) {
    // An omitted field is an older-client request. Preserve webhook behavior
    // and persist it explicitly; current UI clients always submit the local
    // declaration default from their first select option.
    selected = resolveMessengerConnectionIngressMode(declaration, existingConfig ?? {});
  }
  if (!messengerVendorSupportsIngressMode(declaration, selected)) {
    throw new RpcError(
      'bad_request',
      `${where}: config.${MESSENGER_INGRESS_MODE_CONFIG_KEY} must be one of `
        + declaration.ingress.supported_modes.map((mode) => `'${mode}'`).join(' or '),
    );
  }
  return { ...config, [MESSENGER_INGRESS_MODE_CONFIG_KEY]: selected };
};

/** Slack Socket Mode needs an app-level `xapp-…` token in addition to the bot
 *  token used for messages. Keep it in encrypted auth, never plaintext config. */
const ensureMessengerIngressCredentials = (
  where: string,
  subtype: string | undefined,
  config: Readonly<Record<string, unknown>>,
  auth: ConnectionAuth,
): void => {
  if (subtype !== 'slack') return;
  const declaration = getMessengerVendorDeclaration(subtype);
  if (declaration === null) return;
  if (resolveMessengerConnectionIngressMode(declaration, config) !== 'socket') return;
  if (
    auth.type !== 'bearer'
    || typeof auth.app_token !== 'string'
    || auth.app_token.trim().length === 0
  ) {
    throw new RpcError(
      'bad_request',
      `${where}: Slack Socket Mode requires auth.app_token (an app-level xapp token with connections:write)`,
    );
  }
};

/** A current client that explicitly selects webhook mode must provide (or, on
 * update, preserve) that vendor's verification material. Legacy callers that
 * omit `ingress_mode` retain their historical acceptance path, while runtime
 * health still reports an old incomplete row as invalid. */
const ensureMessengerWebhookVerificationMaterial = (
  where: string,
  subtype: string | undefined,
  config: Readonly<Record<string, unknown>>,
): void => {
  if (subtype === undefined) return;
  const declaration = getMessengerVendorDeclaration(subtype);
  if (
    declaration === null
    || resolveMessengerConnectionIngressMode(declaration, config) !== 'webhook'
  ) return;
  const field = declaration.ingress.secret_field;
  if (
    field === undefined
    || typeof config[field] !== 'string'
    || (config[field] as string).trim().length === 0
  ) {
    throw new RpcError(
      'bad_request',
      `${where}: webhook mode requires config.${field ?? 'verification_material'}`,
    );
  }
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

/** Decode an at-rest ciphertext blob back to a `ConnectionAuth`. The P3
 *  adapter calls this at invoke time; the list path also uses it narrowly to
 *  project the non-secret `type` discriminant needed for compatible pack
 *  reuse. No credential field enters a view. Mirrors the encode policy on
 *  `getEncryptionKey`: encrypted when wired, base64-JSON when not. */
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
): Promise<{
  connections: ConnectionView[];
  credential_rotation_safe_stops?: ConnectionCredentialRotationSafeStopSummary[];
  credential_post_safe_stop_verifications?:
    ConnectionCredentialPostSafeStopVerificationSummary[];
}> => {
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
  const listedKey = deps.getEncryptionKey?.();
  const canReadAuthType = deps.getEncryptionKey === undefined || listedKey !== null;
  const connections = await Promise.all(rows.map(async (row) => {
      const view = connectionViewFromRow(row);
      // Settings-only, non-secret revision. Keep it out of the shared resolver
      // projection so recipes cannot accidentally depend on storage metadata.
      view.updated_at = row.updated_at;
      if (canReadAuthType) {
        try {
          const auth = await decodeAuthFromStorage(
            row.auth_ciphertext,
            { kind: row.kind, name: row.name },
            deps.getEncryptionKey === undefined
              ? undefined
              : () => listedKey as Uint8Array,
          );
          view.auth_type = auth.type;
        } catch {
          // Keep a corrupt/legacy row visible. Omitting auth_type makes pack
          // reuse matching fail closed instead of guessing from the endpoint.
        }
      }
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
    }));
  const safeStopRows = deps.store.listCredentialRotationSafeStops?.(
    a.kind === undefined ? {} : { kind: a.kind as ConnectionKind },
  ) ?? [];
  const credentialRotationSafeStops = safeStopRows.flatMap((attempt) => {
    const safeStop = credentialSafeStopFromAttempt(attempt);
    return safeStop === null
      ? []
      : [{ kind: attempt.kind, name: attempt.name, ...safeStop }];
  });
  const acknowledgedSafeStopRows =
    deps.store.listAcknowledgedCredentialRotationSafeStops?.(
      a.kind === undefined ? {} : { kind: a.kind as ConnectionKind },
    );
  const rowByKey = new Map(rows.map((row) => [
    connectionRowKey(row.kind, row.name),
    row,
  ]));
  const viewByKey = new Map(connections.map((connection) => [
    connectionRowKey(connection.kind, connection.name),
    connection,
  ]));
  const credentialPostSafeStopVerifications = acknowledgedSafeStopRows
    ?.flatMap((attempt): ConnectionCredentialPostSafeStopVerificationSummary[] => {
      const acknowledgedAt = attempt.safe_stop_acknowledged_at;
      const pending = (): ConnectionCredentialPostSafeStopVerificationSummary[] => [{
        kind: attempt.kind,
        name: attempt.name,
        status: 'pending',
        acknowledged_at: acknowledgedAt,
      }];
      const key = connectionRowKey(attempt.kind, attempt.name);
      const row = rowByKey.get(key);
      const view = viewByKey.get(key);
      if (row === undefined || view === undefined) return [];
      const currentRow = deps.store.get(attempt.kind, attempt.name);
      if (
        currentRow === null
        || connectionRowFingerprint(currentRow)
          !== connectionRowFingerprint(row)
      ) {
        // Auth-type projection above is asynchronous. A connection can change
        // while that decryption is in flight, so recheck the complete durable
        // row before an old success clears work or an old rejection targets a
        // correction. A later list will project the new row exactly.
        return pending();
      }
      let health: ConnectionHealth | null = null;
      let exactPostSafeStopLineage = false;
      try {
        const parsed: unknown = JSON.parse(row.health_json ?? 'null');
        if (
          isRecord(parsed)
          && (
            parsed.status === 'ok'
            || parsed.status === 'auth_failed'
            || parsed.status === 'unreachable'
            || parsed.status === 'unknown'
          )
          && typeof parsed.last_probed_at === 'number'
          && Number.isSafeInteger(parsed.last_probed_at)
          && parsed.last_probed_at >= 0
        ) {
          health = parsed as unknown as ConnectionHealth;
          const lineage = parsed.post_safe_stop_verification;
          exactPostSafeStopLineage = isRecord(lineage)
            && lineage.acknowledged_at === acknowledgedAt
            && lineage.lineage_hash
              === credentialSafeStopAcknowledgementToken(attempt)
            && lineage.connection_updated_at === row.updated_at;
        }
      } catch {
        // A malformed/legacy health snapshot means the promised check is still
        // pending; it never becomes a fabricated success or rejection.
      }
      if (health === null || !exactPostSafeStopLineage) {
        return pending();
      }
      if (health.status === 'ok') return [];
      const correction = health.status === 'auth_failed'
        && view.auth_type !== undefined
        ? connectionCredentialRejectionCorrection(view.auth_type)
        : null;
      return [{
        kind: attempt.kind,
        name: attempt.name,
        status: health.status,
        acknowledged_at: acknowledgedAt,
        checked_at: health.last_probed_at!,
        connection_updated_at: row.updated_at,
        ...(correction !== null
          ? { credential_correction: correction }
          : {}),
      }];
    });
  return {
    connections,
    ...(credentialRotationSafeStops.length > 0
      ? { credential_rotation_safe_stops: credentialRotationSafeStops }
      : {}),
    ...(credentialPostSafeStopVerifications !== undefined
      ? {
          credential_post_safe_stop_verifications:
            credentialPostSafeStopVerifications,
        }
      : {}),
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
  const existing = deps.store.get(kind, name);
  const requestedConfig = ensureConfig('collection.connection.enroll', a.config);
  const config = normalizeMessengerIngressConfig(
    'collection.connection.enroll',
    subtype,
    requestedConfig,
    existing ? parseStoredConfig(existing.config_json) : undefined,
  );
  ensureValidMatchPatterns('collection.connection.enroll', config);
  const auth = ensureAuth('collection.connection.enroll', a.auth);
  ensureMessengerAuthDeliverable('collection.connection.enroll', subtype, auth);
  ensureMessengerIngressCredentials('collection.connection.enroll', subtype, config, auth);
  if (Object.prototype.hasOwnProperty.call(
    requestedConfig,
    MESSENGER_INGRESS_MODE_CONFIG_KEY,
  )) {
    ensureMessengerWebhookVerificationMaterial(
      'collection.connection.enroll',
      subtype,
      config,
    );
  }
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
    expected_updated_at?: number;
  },
  internal: { allowCredentialCandidate?: boolean } = {},
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
  // Credential replacement has a stricter lifecycle than ordinary metadata:
  // accepting it here would let a paired/direct caller bypass the provider
  // verification and durable-swap guarantee. Only the rotation handler may run
  // this updater against its isolated candidate store.
  if (patch.auth !== undefined && internal.allowCredentialCandidate !== true) {
    throw new RpcError(
      'credential_verification_required',
      'Replacement credentials must be verified before they can be saved. Update your client and try again; your current credentials were not changed.',
      409,
      'collection.connection.update',
      { existing_credential_preserved: true },
    );
  }
  const existing = deps.store.get(kind, name);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.connection.update: no ${kind} connection named '${name}'`,
    );
  }
  const expectedUpdatedAt = ensureExpectedConnectionUpdatedAt(
    'collection.connection.update',
    a.expected_updated_at,
  );
  if (internal.allowCredentialCandidate !== true) {
    assertConnectionEditorIsCurrent(
      'collection.connection.update',
      expectedUpdatedAt,
      existing,
    );
  }
  // A revision must advance even when two writes share a millisecond or a
  // deterministic test clock. This keeps the next editor CAS meaningful.
  const now = Math.max(
    deps.now?.() ?? Date.now(),
    existing.updated_at + 1,
  );
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
    const normalized = normalizeMessengerIngressConfig(
      'collection.connection.update',
      existing.subtype,
      merged,
      existingConfig,
    );
    ensureValidMatchPatterns('collection.connection.update', normalized);
    config_json = JSON.stringify(normalized);
  }
  const finalConfig = parseStoredConfig(config_json);
  const messengerDeclaration = existing.subtype === undefined
    ? null
    : getMessengerVendorDeclaration(existing.subtype);
  if (
    patch.config !== undefined
    && Object.prototype.hasOwnProperty.call(
      patch.config,
      MESSENGER_INGRESS_MODE_CONFIG_KEY,
    )
  ) {
    ensureMessengerWebhookVerificationMaterial(
      'collection.connection.update',
      existing.subtype,
      finalConfig,
    );
  }
  if (
    existing.subtype === 'slack'
    && messengerDeclaration !== null
    && resolveMessengerConnectionIngressMode(messengerDeclaration, finalConfig) === 'socket'
  ) {
    const finalAuth = auth ?? await decodeAuthFromStorage(
      existing.auth_ciphertext,
      { kind, name },
      deps.getEncryptionKey,
    );
    ensureMessengerIngressCredentials(
      'collection.connection.update',
      existing.subtype,
      finalConfig,
      finalAuth,
    );
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
  // D-225 Slice 2 — a generated MCP pack is an artifact OF this connection: its
  // every operation dispatches through a connection that no longer exists, so
  // leaving it installed leaves a pack that is dead in every op. Runs AFTER the
  // row is deleted, which is also what makes the reverse cascade terminate.
  if (deleted && kind === 'mcp' && deps.teardownGeneratedPack) {
    try {
      await deps.teardownGeneratedPack(await mcpGeneratedPackSlug({ kind, name }));
    } catch {
      // Best-effort — the connection is already gone and a throw here would
      // leave the owner unable to retry the delete.
    }
  }
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
  args: {
    name: string;
    kind: ConnectionKind;
    expected_updated_at?: number;
  },
): Promise<{
  health: ConnectionHealth;
  connection_updated_at: number;
  credential_correction?: ConnectionCredentialRejectionCorrection;
  descriptors?: McpToolDescriptor[];
}> => {
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
  const expectedUpdatedAt = ensureExpectedConnectionUpdatedAt(
    'collection.connection.probe',
    a.expected_updated_at,
  );
  assertConnectionEditorIsCurrent(
    'collection.connection.probe',
    expectedUpdatedAt,
    existing,
  );
  const latestAttemptAtProbeStart =
    deps.store.getLatestCredentialRotationAttempt?.(kind, name) ?? null;
  const postSafeStopLineage = latestAttemptAtProbeStart?.status === 'failed'
    && latestAttemptAtProbeStart.safe_stop_acknowledged_at !== undefined
    && credentialSafeStopFromAttempt(latestAttemptAtProbeStart, true) !== null
    ? {
        attemptId: latestAttemptAtProbeStart.attempt_id,
        acknowledgedAt:
          latestAttemptAtProbeStart.safe_stop_acknowledged_at,
        lineageHash: credentialSafeStopAcknowledgementToken(
          latestAttemptAtProbeStart,
        ),
      }
    : null;
  const probeSnapshot = connectionRowFingerprint(existing);
  const now = deps.now?.() ?? Date.now();
  // A probe is a durable row write. Keep the row revision strictly monotonic
  // without changing the provider-check timestamp used by token expiry and
  // the verification receipt.
  const connectionUpdatedAt = Math.max(now, existing.updated_at + 1);
  const maxErrorLen = 256;
  const probeTimeoutMs = 10_000;
  // Production composition does not inject a fetcher. Keep the probe's
  // deadline active through response-body consumption, cap every body, and
  // refuse cross-origin redirects before credentials can follow them. The
  // narrow injected seam remains for deterministic tests.
  const fetcher: HttpFetcher = deps.fetcher ?? makeBoundedOriginHttpFetcher({
    timeoutMs: probeTimeoutMs,
  });
  const truncateError = (message: string): string =>
    message.length > maxErrorLen ? message.slice(0, maxErrorLen) : message;
  // D-225 Slice 2 — the full descriptors behind `health.tool_hashes`, surfaced
  // so the pack-preview handler reuses THIS probe rather than running a second
  // one. `health` is unchanged; a caller that ignores this sees no difference.
  let capturedDescriptors: McpToolDescriptor[] | undefined;
  type PersistedProbeHealth = ConnectionHealth & {
    /** Server-private causal marker. It is stripped from the probe response;
     * list recovery uses it to bind one acknowledged attempt to the exact row
     * revision checked, even across clock rollback or timestamp collision. */
    post_safe_stop_verification?: {
      acknowledged_at: number;
      lineage_hash: string;
      connection_updated_at: number;
    };
  };
  const healthOf = (
    status: ConnectionHealth['status'],
    last_error?: string,
    tools?: string[],
    tool_hashes?: string[],
  ): PersistedProbeHealth => ({
    status,
    last_probed_at: now,
    ...(postSafeStopLineage !== null
      ? {
          post_safe_stop_verification: {
            acknowledged_at: postSafeStopLineage.acknowledgedAt,
            lineage_hash: postSafeStopLineage.lineageHash,
            connection_updated_at: connectionUpdatedAt,
          },
        }
      : {}),
    ...(last_error ? { last_error: truncateError(last_error) } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(tool_hashes !== undefined ? { tool_hashes } : {}),
  });
  const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  /** Keep a rejected credential distinct from a provider/network failure. The
   * exchange helpers carry only non-secret status/cause metadata; malformed
   * successful responses remain `unknown` because neither the credential nor
   * reachability is the proven cause. */
  const credentialExchangeFailureHealth = (
    err: unknown,
    reason: string,
  ): ConnectionHealth => {
    const details = isRecord(err) && isRecord(err.details) ? err.details : {};
    const status = details.status;
    if (typeof status === 'number') {
      if (status === 408 || status === 429 || status >= 500) {
        return healthOf('unreachable', reason);
      }
      if (status >= 400 && status < 500) {
        return healthOf('auth_failed', reason);
      }
    }
    if (details.cause === 'network') {
      return healthOf('unreachable', reason);
    }
    return healthOf('unknown', reason);
  };
  const fetchTimed = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
    timeoutMs = probeTimeoutMs,
  ): Promise<Awaited<ReturnType<HttpFetcher>>> => {
    // The bounded production fetcher owns one abortable deadline spanning
    // connect, headers, redirects, and body. A second Promise.race would return
    // just before its abort timer and briefly orphan the underlying request.
    if (deps.fetcher === undefined) return fetcher(url, init);
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
  // A provider may move a tenant between provider-owned origins and return the
  // replacement beside a rotated OAuth credential. Keep the candidate config
  // local until the probe has completed and the optimistic row check below has
  // passed, just like `authCiphertext`: the in-flight probe must use the new
  // origin, but a concurrent editor must still win without a partial write.
  let configJson = existing.config_json;
  const readConfig = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(configJson);
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
      // D-218 — the exchanged `accessJwt` is an ordinary bearer on the wire.
      // ⚠ A row that has never exchanged has none, so the probe reports
      // `auth_failed` rather than succeeding against an unauthenticated
      // endpoint — which is the honest answer until slice 1 can mint one.
      case 'atproto_session':
        headers.Authorization = `Bearer ${authString(auth, 'current_access_token')}`;
        return;
    }
  };
  /** Strip every credential this connection holds out of a probe error before
   *  it is persisted to `health_json` and rendered in Settings.
   *
   *  ⚠ **Hoisted out of `probeMcp` by D-218.** It lived inside the MCP probe,
   *  so `probeApi` could not reach it and returned raw transport errors — a
   *  bearer token or a basic password quoted by a failing target went straight
   *  into durable storage. `auth` is a parameter now rather than a closure
   *  capture, which is what let it move. */
    const redactProbeSecrets = (
    auth: ConnectionAuth,
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
      // D-218 — ⛔ **the site that would have leaked.** This switch has no
      // `default`, so a new auth type falls through collecting NOTHING and
      // its credentials go unredacted into probe output. For this type that
      // means the APP PASSWORD — a reusable account credential, not a
      // short-lived token. Nothing in the compiler says so; the widened union
      // produced no error here at all.
      //
      // ⚠ All three are added, not just the access token: the refresh JWT is
      // a live credential in its own right, and the app password is the one
      // that survives revoking everything else.
      case 'atproto_session':
        add(authRecord.app_password);
        add(authRecord.current_access_token);
        add(authRecord.refresh_token);
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
  const probeApi = async (
    auth: ConnectionAuth,
    authenticatedPath?: string,
  ): Promise<ConnectionHealth> => {
    const config = readConfig();
    const base = config.base_url;
    if (typeof base !== 'string' || base.trim() === '') {
      return healthOf('unknown', 'missing_base_url');
    }
    const url = authenticatedPath === undefined
      ? new URL(base)
      : composeApiUrl(base, authenticatedPath);
    const headers: Record<string, string> = {};
    applyAuth(auth, headers, url);
    try {
      // A vendor-specific path names an authenticated query, so call it as
      // GET directly. The generic endpoint probe retains its cheap HEAD → GET
      // fallback for APIs without a declared health resource.
      if (authenticatedPath !== undefined) {
        const get = await fetchTimed(url.toString(), { method: 'GET', headers });
        return classifyHttpReachability(get.status);
      }
      const head = await fetchTimed(url.toString(), { method: 'HEAD', headers });
      if (head.status === 405 || head.status === 501) {
        const get = await fetchTimed(url.toString(), { method: 'GET', headers });
        return classifyHttpReachability(get.status);
      }
      return classifyHttpReachability(head.status);
    } catch (err) {
      // ⛔ **D-218 — this catch did NOT redact, and had not since it was
      // written.** `last_error` is PERSISTED to `health_json` and rendered in
      // Settings, and a transport error frequently quotes the request it
      // failed on. Every other probe path (mcp / stream / notification) routes
      // its raw message through `redactProbeSecrets`; the api path returned it
      // verbatim, so a `bearer` token, a `basic` password or a `query` value
      // could land in durable storage and on screen.
      //
      // ⚠ **Pre-existing, and found only because a NEW auth type made it
      // matter more** — this one stores an APP PASSWORD, a reusable account
      // credential that outlives every token derived from it. The
      // status-classified paths above are unaffected: they emit
      // `http_status_<n>`, which carries nothing.
      return healthOf('unreachable', redactProbeSecrets(auth, errorMessage(err)));
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
    const streamHealth = async (
      result: Awaited<ReturnType<typeof probeMcpStreamTools>>,
    ): Promise<ConnectionHealth> => {
      const streamHashes = result.ok ? await mcpMintedHashes(result.descriptors) : undefined;
      if (result.ok) capturedDescriptors = result.descriptors;
      if (result.ok) return healthOf('ok', undefined, result.tools, streamHashes);
      const suffix = result.stage === 'tools_list' ? 'tools_list' : 'initialize';
      return result.reason === 'jsonrpc_error'
        ? healthOf('auth_failed', `jsonrpc_${suffix}_error`)
        : healthOf('unreachable', `jsonrpc_${suffix}_${result.reason}`);
    };
    const streamFailure = (
      err: unknown,
      extraSecrets: readonly string[] = [],
    ): ConnectionHealth => {
      const rawMessage = errorMessage(err);
      const authStatus = /\bHTTP (401|403)\b/i.exec(rawMessage)?.[1];
      return authStatus
        ? healthOf('auth_failed', `http_status_${authStatus}`)
        : healthOf('unreachable', redactProbeSecrets(auth, rawMessage, extraSecrets));
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
      // D-225 Slice 2 — deduped on NAME like the name set, so a tool repeated
      // across pages cannot produce two hashes that later read as drift.
      const descriptors = new Map<string, McpToolDescriptor>();
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
        for (const d of page.descriptors) if (!descriptors.has(d.name)) descriptors.set(d.name, d);
        if (page.nextCursor === undefined) {
          capturedDescriptors = [...descriptors.values()];
          return healthOf(
            'ok',
            undefined,
            [...tools],
            await mcpMintedHashes(capturedDescriptors),
          );
        }
        if (seenCursors.has(page.nextCursor)) {
          return healthOf('unreachable', 'jsonrpc_tools_list_pagination_cycle');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return healthOf('unreachable', 'jsonrpc_tools_list_pagination_limit');
    } catch (err) {
      return healthOf('unreachable', redactProbeSecrets(auth, errorMessage(err)));
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
    const botHealth = await probeJsonNotification(
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
    if (botHealth.status !== 'ok') return botHealth;

    const config = parseStoredConfig(existing.config_json);
    const ingressMode = resolveMessengerConnectionIngressMode(declaration, config);
    if (declaration.vendor !== 'slack' || ingressMode !== 'socket') return botHealth;
    if (
      auth.type !== 'bearer'
      || typeof auth.app_token !== 'string'
      || auth.app_token.trim().length === 0
    ) {
      return healthOf('auth_failed', 'slack_app_token_missing');
    }
    return probeJsonNotification(
      'https://slack.com/api/apps.connections.open',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.app_token}` },
      },
      declaration.vendor,
      auth.app_token,
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
  let health: PersistedProbeHealth;
  let authCiphertext = existing.auth_ciphertext;
  let probedAuthType: ConnectionAuth['type'] | undefined;
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
        probedAuthType = auth.type;
        const ensureFreshAuth = createEnsureFreshAuth({
          fetchImpl: deps.resolveFetch ?? globalThis.fetch.bind(globalThis),
          now: () => now,
          ...(deps.auditLog
            ? {
                onRuntimeBaseIssue: makeConnectionRuntimeBaseIssueSink(
                  deps.auditLog,
                  () => now,
                ),
              }
            : {}),
          persistAuth: async (_row, newAuth, configPatch) => {
            authCiphertext = await encodeAuthForStorage(
              newAuth,
              { kind, name },
              checkedKey,
            );
            if (configPatch !== undefined) {
              configJson = JSON.stringify({
                ...readConfig(),
                base_url: configPatch.base_url,
              });
            }
          },
        });
        switch (kind) {
          case 'api': {
            if (auth.type === 'atproto_session') {
              try {
                let liveAuth = await ensureFreshAuth(existing, auth);
                health = await probeApi(
                  liveAuth,
                  '/xrpc/com.atproto.server.getSession',
                );
                // AT Protocol tokens are opaque and carry no honest local
                // expiry. A 401 is therefore the freshness signal: force one
                // refresh/login through the same production gate, persist the
                // rotated pair, and probe once more.
                if (health.status === 'auth_failed'
                  && health.last_error === 'http_status_401') {
                  if (liveAuth.type !== 'atproto_session') {
                    throw new Error('atproto_session_exchange_changed_auth_type');
                  }
                  const retryAuth = { ...liveAuth };
                  delete retryAuth.current_access_token;
                  liveAuth = await ensureFreshAuth(existing, retryAuth);
                  health = await probeApi(
                    liveAuth,
                    '/xrpc/com.atproto.server.getSession',
                  );
                }
              } catch (err) {
                health = credentialExchangeFailureHealth(
                  err,
                  'atproto_session_exchange_failed',
                );
              }
              break;
            }
            if (
              auth.type === 'oauth2_refresh'
              || auth.type === 'oauth2_client_credentials'
            ) {
              try {
                // A stored refresh token is not itself usable at the API. Run
                // the same freshness/exchange gate as live execution so a
                // manual probe—and credential rotation in particular—verifies
                // the provider-issued replacement rather than failing on a
                // missing cached access token. The gate's persist callback
                // restamps the rotated token pair in the row written below.
                const liveAuth = await ensureFreshAuth(existing, auth);
                health = await probeApi(liveAuth);
              } catch (err) {
                health = credentialExchangeFailureHealth(err, 'token_exchange_failed');
              }
              break;
            }
            health = await probeApi(auth);
            break;
          }
          case 'mcp': {
            if (
              auth.type === 'oauth2_refresh'
              || auth.type === 'oauth2_client_credentials'
            ) {
              try {
                health = await probeMcp(await ensureFreshAuth(existing, auth));
              } catch (err) {
                health = credentialExchangeFailureHealth(err, 'token_exchange_failed');
              }
            } else {
              health = await probeMcp(auth);
            }
            break;
          }
          case 'notification': {
            // Declared messenger auth kinds currently resolve only to directly
            // usable bearer credentials; an OAuth-shaped notification row is
            // unreachable through enrollment and must keep the fail-closed
            // `auth_type_*` result rather than attempting an exchange.
            health = await probeNotification(auth);
            break;
          }
        }
      } catch (err) {
        health = healthOf('unknown', errorMessage(err));
      }
    }
  }
  const currentBeforeWrite = deps.store.get(kind, name);
  if (
    currentBeforeWrite === null
    || connectionRowFingerprint(currentBeforeWrite) !== probeSnapshot
  ) {
    throw new RpcError(
      'conflict',
      'This connection changed while Recued was checking it. The newer saved connection was preserved; check that current version again.',
      409,
      'collection.connection.probe',
      { existing_credential_preserved: true },
    );
  }
  if (postSafeStopLineage !== null) {
    const latestAttemptBeforeWrite =
      deps.store.getLatestCredentialRotationAttempt?.(kind, name) ?? null;
    if (
      latestAttemptBeforeWrite?.attempt_id !== postSafeStopLineage.attemptId
      || latestAttemptBeforeWrite.status !== 'failed'
      || latestAttemptBeforeWrite.safe_stop_acknowledged_at
        !== postSafeStopLineage.acknowledgedAt
    ) {
      throw new RpcError(
        'conflict',
        'Credential recovery changed while Recued was checking this connection. The saved connection was preserved; reload its current recovery state before checking again.',
        409,
        'collection.connection.probe',
        { existing_credential_preserved: true },
      );
    }
  }
  deps.store.upsert({
    name,
    kind,
    ...(existing.subtype !== undefined ? { subtype: existing.subtype } : {}),
    display_name: existing.display_name,
    ...(existing.publisher_id !== undefined ? { publisher_id: existing.publisher_id } : {}),
    config_json: configJson,
    auth_ciphertext: authCiphertext,
    enrolled_at: existing.enrolled_at,
    updated_at: connectionUpdatedAt,
    ...(existing.last_used_at !== undefined ? { last_used_at: existing.last_used_at } : {}),
    health_json: JSON.stringify(health),
    // D-165 P3.path-picker — preserve the scope across a probe re-stamp.
    ...(existing.subresource_path !== undefined ? { subresource_path: existing.subresource_path } : {}),
    // granted-scopes — preserve the coverage set across a probe re-stamp.
    ...(existing.granted_scopes_json !== undefined ? { granted_scopes_json: existing.granted_scopes_json } : {}),
  });
  const credentialCorrection = health.status === 'auth_failed'
    && probedAuthType !== undefined
    ? connectionCredentialRejectionCorrection(probedAuthType)
    : null;
  const {
    post_safe_stop_verification: _privatePostSafeStopLineage,
    ...publicHealth
  } = health;
  return {
    health: publicHealth,
    connection_updated_at: connectionUpdatedAt,
    ...(credentialCorrection !== null
      ? { credential_correction: credentialCorrection }
      : {}),
    ...(capturedDescriptors !== undefined ? { descriptors: capturedDescriptors } : {}),
  };
};

/** D-225 Slice 2 — is this connection's generated pack still current?
 *
 *  🔑 **Runs with NO probe.** Both sides are already at rest: the current side
 *  is `ConnectionHealth.tool_hashes` (persisted at the last probe), the minted
 *  side derives from the installed pack's own bindings. So a connections list
 *  can render a badge per row without touching the network — a badge that cost
 *  a live probe per row would either not exist or would be stale anyway.
 *
 *  ⛔ **`unknown` is a distinct status, and that is the point.** A connection
 *  never probed since `tool_hashes` landed has NO current side to compare, and
 *  reporting `current` for it would be a false all-clear on exactly the
 *  connections most likely to have drifted — the ones nobody has looked at.
 *  Absent evidence is not evidence of absence, so it gets its own answer.
 *
 *  ⚠ Drift is reported as HASH COUNTS, not tool names. The hashes name nothing
 *  a caller can act on directly; resolving them to tools requires a probe, and
 *  that is `mcpPackPreview`'s job. The badge says "something changed, re-review"
 *  — which is the whole decision it exists to prompt. */
export const handleMcpPackStatus = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind },
): Promise<{
  pack_slug: string;
  status: 'no_pack' | 'unknown' | 'current' | 'drifted';
  added: number;
  removed: number;
  last_probed_at?: number;
}> => {
  const a = ensureRecordArgs('collection.connection.mcpPackStatus', args);
  const name = ensureName('collection.connection.mcpPackStatus', a.name);
  const kind = ensureKind('collection.connection.mcpPackStatus', a.kind);
  if (kind !== 'mcp') {
    throw new RpcError(
      'bad_request',
      `collection.connection.mcpPackStatus: only an mcp connection can back a generated pack (got '${kind}')`,
    );
  }
  const existing = deps.store.get(kind, name);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.connection.mcpPackStatus: no ${kind} connection named '${name}'`,
    );
  }
  const pack_slug = await mcpGeneratedPackSlug({ kind, name });
  // ⛔ "cannot look up" and "looked up, found nothing" are DIFFERENT FACTS.
  // Collapsing them would make a host with no manifest registry report
  // `no_pack` for connections that DO have one — the same false-negative
  // mistake as reporting `current` for a connection never probed, just
  // pointing the other way.
  if (deps.getInstalledCatalog === undefined) {
    return { pack_slug, status: 'unknown', added: 0, removed: 0 };
  }
  const catalog = deps.getInstalledCatalog(pack_slug);
  if (catalog === null) {
    // Looked, found none — the resting state after an enrollment where the
    // owner never finished the chain. A real answer, and not drift.
    return { pack_slug, status: 'no_pack', added: 0, removed: 0 };
  }

  let health: { tool_hashes?: unknown; last_probed_at?: unknown } = {};
  try {
    health = JSON.parse(existing.health_json ?? '{}') as typeof health;
  } catch {
    health = {};
  }
  const current = health.tool_hashes;
  const last_probed_at = typeof health.last_probed_at === 'number'
    ? health.last_probed_at
    : undefined;
  if (!Array.isArray(current) || current.some((h) => typeof h !== 'string')) {
    return {
      pack_slug,
      status: 'unknown',
      added: 0,
      removed: 0,
      ...(last_probed_at !== undefined ? { last_probed_at } : {}),
    };
  }

  const minted = await mcpMintedHashesFromCatalog(catalog);
  const drift = mcpToolsDriftFromHashes(minted, current as string[]);
  const drifted = drift.added.length > 0 || drift.removed.length > 0;
  return {
    pack_slug,
    status: drifted ? 'drifted' : 'current',
    added: drift.added.length,
    removed: drift.removed.length,
    ...(last_probed_at !== undefined ? { last_probed_at } : {}),
  };
};

/** D-225 Slice 2 — install the generated pack. The **Save** of the owner's
 *  enrollment chain.
 *
 *  ⛔ **It does NOT write risk/approval rulings, deliberately.** Those go
 *  through the existing `contract.ownerOperation.*` rpc, which enforces
 *  `isApprovalBelowRiskFloor` and refuses a risk downgrade without
 *  `confirm_risk_downgrade` — and whose refusal payload enumerates what the
 *  downgrade unlocks. A commit path that wrote rulings itself would either
 *  duplicate those gates (and drift from them) or bypass them, and bypassing is
 *  exactly how a third-party server's tools would end up auto-running without
 *  anyone having confirmed it. So: this installs a pack whose every op is
 *  `write` + `ask` with `grant_default: off` — inert until the owner tunes it in
 *  pack detail, through the gated path built for that.
 *
 *  ⛔ **`reviewed_ops` is a TOCTOU guard, not bookkeeping.** The owner reviewed
 *  ONE tool set and is authorizing THAT one; between preview and Save the server
 *  can add, remove or reshape a tool. Because an op id is a hash of
 *  `{name, input_schema}`, comparing the freshly-probed id set against what the
 *  client reviewed is exactly "is this still the server state I showed you" —
 *  no extra machinery. A divergence REFUSES and asks for a re-review rather
 *  than installing something the owner never saw. */
export const handleMcpPackCommit = async (
  deps: ConnectionRpcDeps,
  args: {
    name: string;
    kind: ConnectionKind;
    reviewed_ops: string[];
    /** D-228 slice 3 — the install-point grant selection, forwarded verbatim to
     *  `packs.install`. Absent ⇒ its fail-closed default. */
    install_scope?: unknown;
  },
): Promise<{ pack_slug: string; operations: number }> => {
  const a = ensureRecordArgs('collection.connection.mcpPackCommit', args);
  const name = ensureName('collection.connection.mcpPackCommit', a.name);
  const kind = ensureKind('collection.connection.mcpPackCommit', a.kind);
  if (kind !== 'mcp') {
    throw new RpcError(
      'bad_request',
      `collection.connection.mcpPackCommit: only an mcp connection can back a generated pack (got '${kind}')`,
    );
  }
  const reviewed = a.reviewed_ops;
  if (!Array.isArray(reviewed) || reviewed.some((op) => typeof op !== 'string')) {
    throw new RpcError(
      'bad_request',
      'collection.connection.mcpPackCommit: reviewed_ops must be an array of operation ids',
    );
  }
  if (!deps.installGeneratedPack) {
    throw new RpcError(
      'unavailable',
      'collection.connection.mcpPackCommit: no pack installer is wired on this host',
    );
  }

  const { health, descriptors } = await handleConnectionProbe(deps, { name, kind });
  if (health.status !== 'ok' || descriptors === undefined) {
    throw new RpcError(
      'unavailable',
      `collection.connection.mcpPackCommit: probe did not return a tool list `
        + `(status '${health.status}'${health.last_error ? `: ${health.last_error}` : ''})`,
    );
  }

  const rows = await mcpPackReviewRows(descriptors);
  const fresh = rows.map((r) => r.op).sort();
  const seen = [...(reviewed as string[])].sort();
  if (fresh.length !== seen.length || fresh.some((op, i) => op !== seen[i])) {
    throw new RpcError(
      'conflict',
      `collection.connection.mcpPackCommit: the server's tools changed since you reviewed them `
        + `(${fresh.length} now, ${seen.length} reviewed). Re-open the review so you are `
        + 'authorizing what the server actually offers.',
    );
  }

  const manifest = await mcpPackManifest({ connection: { kind, name }, descriptors });
  // D-228 slice 3 — the install-point grant selection rides through to
  // `packs.install`. Absent ⇒ unchanged behaviour (authored read defaults only);
  // present ⇒ the owner's choice at the moment they are looking at the tool
  // list, which is the same consent step an ordinary pack install has.
  //
  // ⚠ GRANTS, NOT RULINGS. D-225 slice 2f settled that `mcpPackCommit` writes
  // no RULINGS — risk/approval tuning stays in the gated editor so it cannot
  // duplicate or bypass `confirm_risk_downgrade`. This is the other axis: a
  // grant says *may you ever*, a ruling says *does THIS call hold*. Threading
  // one does not reopen the other.
  await deps.installGeneratedPack(manifest, a.install_scope);
  return { pack_slug: String(manifest.slug), operations: rows.length };
};

/** D-225 Slice 2 — the pack-detail review screen's data source.
 *
 *  The owner's chain is: `#connections → mcp → create → success` → THIS →
 *  adjust risk & approval → Save. Nothing is installed here; this is the form.
 *
 *  🔑 It PROBES rather than reading a stored snapshot. The owner is about to
 *  classify what a server can do, so they must be classifying what it says NOW —
 *  a cached list could be older than the last time the server changed, and the
 *  whole point of the screen is that the owner saw what they consented to.
 *
 *  ⛔ Every returned row's `stored` value is `write` / `ask`, whatever the
 *  server claims about itself. See `mcpPackReviewRows`: a hint that reached the
 *  stored value would let a Save-without-reading hand a third party auto-run
 *  permission, chosen by the server. */
export const handleMcpPackPreview = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind },
): Promise<{
  pack_slug: string;
  connection: { kind: string; name: string };
  rows: McpPackReviewRow[];
}> => {
  const a = ensureRecordArgs('collection.connection.mcpPackPreview', args);
  const name = ensureName('collection.connection.mcpPackPreview', a.name);
  const kind = ensureKind('collection.connection.mcpPackPreview', a.kind);
  if (kind !== 'mcp') {
    throw new RpcError(
      'bad_request',
      `collection.connection.mcpPackPreview: only an mcp connection can back a generated pack (got '${kind}')`,
    );
  }
  const { health, descriptors } = await handleConnectionProbe(deps, { name, kind });
  if (health.status !== 'ok' || descriptors === undefined) {
    // ⛔ Fail rather than offer an empty form. A probe that did not succeed
    // tells us nothing about the server's tools, and a review screen showing
    // zero rows would read as "this server has no tools" — an owner could Save
    // that and believe they had reviewed something.
    throw new RpcError(
      'unavailable',
      `collection.connection.mcpPackPreview: probe did not return a tool list `
        + `(status '${health.status}'${health.last_error ? `: ${health.last_error}` : ''})`,
    );
  }
  return {
    pack_slug: await mcpGeneratedPackSlug({ kind, name }),
    connection: { kind, name },
    rows: await mcpPackReviewRows(descriptors),
  };
};

const connectionUpsertFromRow = (row: ConnectionRow): ConnectionUpsert => ({
  name: row.name,
  kind: row.kind,
  ...(row.subtype !== undefined ? { subtype: row.subtype } : {}),
  display_name: row.display_name,
  ...(row.publisher_id !== undefined ? { publisher_id: row.publisher_id } : {}),
  config_json: row.config_json,
  auth_ciphertext: row.auth_ciphertext,
  enrolled_at: row.enrolled_at,
  updated_at: row.updated_at,
  ...(row.last_used_at !== undefined ? { last_used_at: row.last_used_at } : {}),
  ...(row.health_json !== undefined ? { health_json: row.health_json } : {}),
  ...(row.subresource_path !== undefined ? { subresource_path: row.subresource_path } : {}),
  ...(row.granted_scopes_json !== undefined
    ? { granted_scopes_json: row.granted_scopes_json }
    : {}),
});

/** An in-memory, one-row store used to run the ordinary update validator and
 * the production probe without firing a durable write or any store observer.
 * Only a verified candidate is copied into the real store. */
const isolatedConnectionStore = (
  seed: ConnectionRow,
): { store: ConnectionStoreSqlite; current: () => ConnectionRow } => {
  let row = { ...seed };
  const matches = (kind: ConnectionKind, name: string): boolean =>
    row.kind === kind && row.name === name;
  const store: ConnectionStoreSqlite = {
    upsert: (input) => {
      row = { pk: connectionRowKey(input.kind, input.name), ...input };
      return row;
    },
    get: (kind, name) => (matches(kind, name) ? { ...row } : null),
    list: (query) => (query?.kind === undefined || query.kind === row.kind ? [{ ...row }] : []),
    listSince: (since) => (row.updated_at > since ? [{ ...row }] : []),
    delete: () => false,
    count: () => 1,
    addOnUpsert: () => () => {},
    addOnDelete: () => () => {},
    addBeforeDelete: () => () => {},
  };
  return { store, current: () => ({ ...row }) };
};

/** Compare every durable field, not only `updated_at`: injected clocks and
 * same-millisecond writes can legitimately share a timestamp. This closes the
 * verify-await-write race without requiring the SQLite store to grow a CAS API. */
const connectionRowFingerprint = (row: ConnectionRow): string => JSON.stringify([
  row.pk,
  row.kind,
  row.name,
  row.subtype,
  row.display_name,
  row.publisher_id,
  row.config_json,
  row.auth_ciphertext,
  row.enrolled_at,
  row.updated_at,
  row.last_used_at,
  row.health_json,
  row.subresource_path,
  row.granted_scopes_json,
]);

const assertCredentialRotationSnapshotIsCurrent = (
  method: string,
  store: ConnectionStoreSqlite,
  kind: ConnectionKind,
  name: string,
  snapshot: string,
): void => {
  const current = store.get(kind, name);
  if (current !== null && connectionRowFingerprint(current) === snapshot) return;
  throw new RpcError(
    'conflict',
    'This connection changed while Recued was preparing or verifying the replacement. Nothing from this attempt was saved; review the latest connection and try again.',
    409,
    method,
    { existing_credential_preserved: true },
  );
};

/** Project an owner-supplied replacement down to durable credential material.
 * Cached access/session tokens are server-derived state, not proof that the
 * submitted refresh token, client secret, or app password still works. Letting
 * a caller supply them would allow a fresh-looking cache to skip the exchange
 * and make an invalid durable replacement appear verified. Rebuilding every
 * variant also drops unknown surplus fields before encryption. */
const credentialCandidateFromOwnerInput = (auth: ConnectionAuth): ConnectionAuth => {
  switch (auth.type) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return {
        type: 'bearer',
        token: auth.token,
        ...(auth.app_token !== undefined ? { app_token: auth.app_token } : {}),
      };
    case 'basic':
      return { type: 'basic', username: auth.username, password: auth.password };
    case 'header':
      return {
        type: 'header',
        headers: auth.headers.map(({ header_name, value }) => ({ header_name, value })),
      };
    case 'query':
      return { type: 'query', param_name: auth.param_name, value: auth.value };
    case 'oauth2_refresh':
      return {
        type: 'oauth2_refresh',
        refresh_token: auth.refresh_token,
        client_id: auth.client_id,
        ...(auth.client_secret !== undefined ? { client_secret: auth.client_secret } : {}),
        token_endpoint: auth.token_endpoint,
        ...(auth.token_auth_style !== undefined
          ? { token_auth_style: auth.token_auth_style }
          : {}),
      };
    case 'oauth2_client_credentials':
      return {
        type: 'oauth2_client_credentials',
        client_id: auth.client_id,
        client_secret: auth.client_secret,
        token_endpoint: auth.token_endpoint,
        ...(auth.token_auth_style !== undefined
          ? { token_auth_style: auth.token_auth_style }
          : {}),
        ...(auth.scope !== undefined ? { scope: auth.scope } : {}),
      };
    case 'atproto_session':
      return {
        type: 'atproto_session',
        identifier: auth.identifier,
        app_password: auth.app_password,
      };
  }
};

/** A negative-control credential for generic API/MCP probes. A successful
 * candidate request is not proof when the configured endpoint is public and
 * ignores authentication; only a matching request with an intentionally wrong
 * static credential being rejected establishes that the check discriminates.
 * Renewable credentials are already proven by their token/session exchange. */
const invalidCredentialControlFor = (auth: ConnectionAuth): ConnectionAuth | null => {
  const invalid = 'recued-intentionally-invalid-credential';
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', token: invalid };
    case 'basic':
      return { type: 'basic', username: invalid, password: invalid };
    case 'header':
      return {
        type: 'header',
        headers: auth.headers.map(({ header_name }) => ({ header_name, value: invalid })),
      };
    case 'query':
      return { type: 'query', param_name: auth.param_name, value: invalid };
    case 'none':
    case 'oauth2_refresh':
    case 'oauth2_client_credentials':
    case 'atproto_session':
      return null;
  }
};

const credentialVerificationFailureMessage = (
  status: ConnectionHealth['status'],
): string => {
  if (status === 'auth_failed') {
    return 'The provider rejected the replacement credentials. Your saved connection was not changed.';
  }
  if (status === 'unreachable') {
    return "Recued couldn't complete the provider check for the replacement credentials. Your saved connection was not changed.";
  }
  return "Recued couldn't confirm the replacement credentials. Your saved connection was not changed.";
};

type CredentialRotationRecoveryStore = Required<Pick<
  ConnectionStoreSqlite,
  | 'claimCredentialRotationAttempt'
  | 'getCredentialRotationAttempt'
  | 'completeCredentialRotationAttempt'
  | 'failCredentialRotationAttempt'
>>;

const ensureCredentialRotationAttemptId = (
  method: string,
  value: unknown,
): string => {
  if (
    typeof value !== 'string'
    || !CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX.test(value)
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: attempt_id must be an opaque 16-128 character id`,
      400,
      method,
    );
  }
  return value;
};

const credentialRotationRecoveryStore = (
  method: string,
  store: ConnectionStoreSqlite,
): CredentialRotationRecoveryStore => {
  if (
    store.claimCredentialRotationAttempt === undefined
    || store.getCredentialRotationAttempt === undefined
    || store.completeCredentialRotationAttempt === undefined
    || store.failCredentialRotationAttempt === undefined
  ) {
    throw new RpcError(
      'not_configured',
      'Durable credential-rotation recovery is unavailable on this server. Nothing was sent to the provider.',
      503,
      method,
    );
  }
  return store as ConnectionStoreSqlite & CredentialRotationRecoveryStore;
};

const credentialRotationFailureReason = (
  error: unknown,
): ConnectionCredentialRotationFailureReason => {
  if (error instanceof RpcError) {
    const verificationStatus = error.details?.verification_status;
    if (verificationStatus === 'auth_failed') return 'auth_failed';
    if (verificationStatus === 'unreachable') return 'unreachable';
    if (error.code === 'credential_verification_failed') return 'inconclusive';
    if (error.code === 'conflict') return 'conflict';
  }
  return 'server_error';
};

/** Reduce an authoritative auth failure to the only diagnostic distinction
 * the server can prove without retaining or parsing provider prose. */
const credentialRejectionStage = (
  error: unknown,
): ConnectionCredentialRejectionTriageStage | undefined => {
  if (
    !(error instanceof RpcError)
    || error.details?.verification_status !== 'auth_failed'
  ) return undefined;
  return error.details.reason === 'token_exchange_failed'
    || error.details.reason === 'atproto_session_exchange_failed'
    ? 'credential_exchange'
    : 'provider_probe';
};

const credentialRejectionCorrectionForAttempt = (
  kind: ConnectionKind,
  authType: ConnectionAuth['type'],
  triageStage?: ConnectionCredentialRejectionTriageStage,
  resolution?: ConnectionCredentialRejectionResolution,
) => {
  const correction = connectionCredentialRejectionCorrection(authType);
  if (correction === null || triageStage === undefined) return correction;
  const triage = connectionCredentialRejectionTriage(
    kind,
    authType,
    triageStage,
    resolution,
  );
  if (triage === null) return correction;
  return {
    ...correction,
    triage,
  };
};

/** Derive a stable opaque CAS capability without exposing the browser-minted
 * attempt id. The input id is already high-entropy; binding kind/name prevents
 * moving a token between connection identities. */
export const credentialSafeStopAcknowledgementToken = (
  attempt: Pick<
    ConnectionCredentialRotationAttemptRow,
    'attempt_id' | 'kind' | 'name'
  >,
): string => createHash('sha256')
  .update(JSON.stringify([
    'recued.connection-credential-safe-stop.v1',
    attempt.kind,
    attempt.name,
    attempt.attempt_id,
  ]))
  .digest('hex');

const credentialSafeStopFromAttempt = (
  attempt: ConnectionCredentialRotationAttemptRow | null,
  includeAcknowledged = false,
): ConnectionCredentialRotationSafeStop | null => {
  if (
    attempt?.status !== 'failed'
    || attempt.failure_reason !== 'auth_failed'
    || attempt.auth_type === undefined
    || attempt.auth_rejection_resolution
      !== 'regenerate_credential_or_contact_admin'
    || (
      !includeAcknowledged
      && attempt.safe_stop_acknowledged_at !== undefined
    )
  ) return null;
  const correction = credentialRejectionCorrectionForAttempt(
    attempt.kind,
    attempt.auth_type,
    attempt.auth_rejection_triage_stage,
    attempt.auth_rejection_resolution,
  );
  if (
    correction?.triage?.resolution
      !== 'regenerate_credential_or_contact_admin'
  ) return null;
  return {
    finished_at: attempt.finished_at,
    correction,
    acknowledgement_token: credentialSafeStopAcknowledgementToken(attempt),
  };
};

const recordedCredentialRotationError = (
  method: string,
  reason: ConnectionCredentialRotationFailureReason,
  kind?: ConnectionKind,
  authType?: ConnectionAuth['type'],
  triageStage?: ConnectionCredentialRejectionTriageStage,
  resolution?: ConnectionCredentialRejectionResolution,
): RpcError => {
  if (reason === 'auth_failed') {
    const correction = kind === undefined || authType === undefined
      ? null
      : credentialRejectionCorrectionForAttempt(
          kind,
          authType,
          triageStage,
          resolution,
        );
    return new RpcError(
      'credential_verification_failed',
      credentialVerificationFailureMessage('auth_failed'),
      422,
      method,
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        ...(correction !== null ? { correction } : {}),
      },
    );
  }
  if (reason === 'unreachable') {
    return new RpcError(
      'credential_verification_failed',
      credentialVerificationFailureMessage('unreachable'),
      422,
      method,
      { verification_status: 'unreachable', existing_credential_preserved: true },
    );
  }
  if (reason === 'inconclusive') {
    return new RpcError(
      'credential_verification_failed',
      credentialVerificationFailureMessage('unknown'),
      422,
      method,
      { verification_status: 'unknown', existing_credential_preserved: true },
    );
  }
  if (reason === 'conflict') {
    return new RpcError(
      'conflict',
      'This connection changed while Recued was verifying the replacement. Nothing from this attempt was saved; review the latest connection and try again.',
      409,
      method,
      { existing_credential_preserved: true },
    );
  }
  return new RpcError(
    'credential_rotation_failed',
    'The replacement did not complete. Your saved connection was not changed; review it before trying again.',
    500,
    method,
    { existing_credential_preserved: true },
  );
};

const credentialRotationOutcomeFromAttempt = (
  attempt: ConnectionCredentialRotationAttemptRow | null,
  safeStopStillCurrent: boolean,
): ConnectionCredentialRotationOutcome => {
  if (attempt === null) return { status: 'not_found' };
  if (attempt.status === 'pending') {
    return { status: 'pending', started_at: attempt.started_at };
  }
  if (attempt.status === 'succeeded') {
    return {
      status: 'succeeded',
      started_at: attempt.started_at,
      verification: attempt.verification,
    };
  }
  const correction = attempt.failure_reason === 'auth_failed'
    && attempt.auth_type !== undefined
    ? credentialRejectionCorrectionForAttempt(
        attempt.kind,
        attempt.auth_type,
        attempt.auth_rejection_triage_stage,
        attempt.safe_stop_acknowledged_at === undefined
          && safeStopStillCurrent
          ? attempt.auth_rejection_resolution
          : undefined,
      )
    : null;
  return {
    status: 'failed',
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    reason: attempt.failure_reason,
    ...(correction !== null ? { correction } : {}),
    ...(attempt.safe_stop_acknowledged_at !== undefined
      && safeStopStillCurrent
      ? { safe_stop_acknowledged_at: attempt.safe_stop_acknowledged_at }
      : {}),
  };
};

/** Verify-before-swap credential rotation.
 *
 * The ordinary update and probe handlers run against an isolated candidate row,
 * so their validation, OAuth exchange, transport behavior, and secret redaction
 * remain the single source of truth. The real row is written exactly once—and
 * only after a green probe and an unchanged-snapshot check. */
export const handleConnectionRotateCredentials = async (
  deps: ConnectionRpcDeps,
  args: {
    attempt_id: string;
    name: string;
    kind: ConnectionKind;
    patch: {
      display_name?: string;
      config?: Record<string, unknown>;
      auth: ConnectionAuth;
    };
    expected_updated_at?: number;
    granted_scopes?: string[];
    /** Optional companion trigger edit from the same form. It is applied to
     * the isolated candidate and commits in the credential's single swap. */
    match_patterns?: MessageMatchPattern[];
  },
): Promise<{
  connection: ConnectionView;
  verification: ConnectionCredentialVerification;
}> => {
  const method = 'collection.connection.rotateCredentials';
  const a = ensureRecordArgs(method, args);
  const attemptId = ensureCredentialRotationAttemptId(method, a.attempt_id);
  const name = ensureName(method, a.name);
  const kind = ensureKind(method, a.kind);
  if (!isRecord(a.patch) || a.patch.auth === undefined) {
    throw new RpcError(
      'bad_request',
      `${method}: patch.auth is required`,
      400,
      method,
    );
  }
  // Validate before constructing the candidate so malformed auth and unsafe
  // OAuth destinations fail without ever entering a network path.
  const auth = credentialCandidateFromOwnerInput(ensureAuth(method, a.patch.auth));
  const expectedUpdatedAt = ensureExpectedConnectionUpdatedAt(
    method,
    a.expected_updated_at,
  );
  const grantedScopes = ensureGrantedScopes(method, a.granted_scopes);
  const existing = deps.store.get(kind, name);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `${method}: no ${kind} connection named '${name}'`,
      404,
      method,
    );
  }
  let candidateConfig = a.patch.config;
  if (a.match_patterns !== undefined) {
    ensureValidMatchPatterns(method, {
      [MESSAGE_MATCH_CONFIG_KEY]: a.match_patterns,
    });
    const baseConfig = candidateConfig === undefined
      ? parseStoredConfig(existing.config_json)
      : ensureConfig(method, candidateConfig);
    // Keep `[]` explicit: ordinary update preserves an omitted reserved field,
    // while an explicit empty list is the atomic "clear triggers" instruction.
    candidateConfig = {
      ...baseConfig,
      [MESSAGE_MATCH_CONFIG_KEY]: a.match_patterns,
    };
  }
  // Rotation replaces the WHOLE auth envelope, so a Slack Socket Mode row whose
  // replacement carries only the bot token would drop `app_token` and take its
  // ingress down — the supervisor stops the runner and reports `invalid`, with
  // nothing to restart it. Enroll and update both hold this invariant; hold it
  // on the third write path too, before the attempt is claimed or any network
  // call runs. The config that governs is the candidate when the rotation
  // patches one, otherwise the stored row's.
  ensureMessengerIngressCredentials(
    method,
    existing.subtype,
    candidateConfig === undefined
      ? parseStoredConfig(existing.config_json)
      : ensureConfig(method, candidateConfig),
    auth,
  );
  const snapshot = connectionRowFingerprint(existing);
  const recoveryStore = credentialRotationRecoveryStore(method, deps.store);
  // A repeated attempt id resolves its durable outcome even though a
  // successful first attempt necessarily advanced the row revision beyond the
  // editor's original expectation. Only a genuinely new attempt is CAS-gated.
  if (recoveryStore.getCredentialRotationAttempt(attemptId) === null) {
    assertConnectionEditorIsCurrent(method, expectedUpdatedAt, existing);
  }
  const startedAt = deps.now?.() ?? Date.now();
  const claim = recoveryStore.claimCredentialRotationAttempt({
    attempt_id: attemptId,
    kind,
    name,
    started_at: startedAt,
  });
  if (!claim.claimed) {
    if (claim.attempt.attempt_id !== attemptId) {
      throw new RpcError(
        'credential_rotation_owned_elsewhere',
        `Another credential replacement for ${kind}/${name} is already being checked. Wait for that outcome before taking over.`,
        409,
        method,
        { existing_credential_preserved: true },
      );
    }
    if (claim.attempt.kind !== kind || claim.attempt.name !== name) {
      throw new RpcError(
        'conflict',
        'This credential-replacement attempt id has already been used. Start a fresh replacement.',
        409,
        method,
      );
    }
    if (claim.attempt.status === 'succeeded') {
      return {
        connection: connectionViewFromRow(existing),
        verification: claim.attempt.verification,
      };
    }
    if (claim.attempt.status === 'failed') {
      const latestAttempt = deps.store.getLatestCredentialRotationAttempt?.(
        claim.attempt.kind,
        claim.attempt.name,
      );
      const safeStopStillCurrent =
        claim.attempt.safe_stop_acknowledged_at === undefined
        && latestAttempt?.attempt_id === claim.attempt.attempt_id;
      throw recordedCredentialRotationError(
        method,
        claim.attempt.failure_reason,
        claim.attempt.kind,
        claim.attempt.auth_type,
        claim.attempt.auth_rejection_triage_stage,
        safeStopStillCurrent
          ? claim.attempt.auth_rejection_resolution
          : undefined,
      );
    }
    throw new RpcError(
      'credential_rotation_in_progress',
      'This credential replacement is still being checked. Wait for its outcome instead of retrying it.',
      409,
      method,
    );
  }

  let committed = false;
  try {
    // The first editor check happens before claiming. A prior owner can finish
    // between that read and this claim; revalidate after the serialized claim
    // so a queued stale contender never sends a second credential to the
    // provider merely to discover the conflict at the final commit fence.
    assertCredentialRotationSnapshotIsCurrent(
      method,
      deps.store,
      kind,
      name,
      snapshot,
    );
    const isolated = isolatedConnectionStore(existing);
    await handleConnectionUpdate(
      { ...deps, store: isolated.store },
      {
        name,
        kind,
        patch: {
          ...(a.patch.display_name !== undefined
            ? { display_name: a.patch.display_name as string }
            : {}),
          ...(candidateConfig !== undefined
            ? { config: candidateConfig as Record<string, unknown> }
            : {}),
          auth,
        },
      },
      { allowCredentialCandidate: true },
    );
    const { health } = await handleConnectionProbe(
      { ...deps, store: isolated.store },
      { name, kind },
    );
    // Ordinary health treats any non-auth HTTP response as "reachable" and
    // records e.g. `http_status_500` alongside status=ok. That is useful for a
    // row probe but is not strong enough to authorize a credential swap: only a
    // clean provider check counts as verified.
    const verificationStatus = health.status === 'ok' && health.last_error !== undefined
      ? 'unknown'
      : health.status;
    if (verificationStatus !== 'ok') {
      const correction = verificationStatus === 'auth_failed'
        ? credentialRejectionCorrectionForAttempt(kind, auth.type)
        : null;
      throw new RpcError(
        'credential_verification_failed',
        credentialVerificationFailureMessage(verificationStatus),
        422,
        method,
        {
          verification_status: verificationStatus,
          ...(health.last_error !== undefined ? { reason: health.last_error } : {}),
          existing_credential_preserved: true,
          ...(correction !== null ? { correction } : {}),
        },
      );
    }

    const controlAuth = kind === 'api' || kind === 'mcp'
      ? invalidCredentialControlFor(auth)
      : null;
    if (controlAuth !== null) {
      const control = isolatedConnectionStore(isolated.current());
      await handleConnectionUpdate(
        { ...deps, store: control.store },
        { name, kind, patch: { auth: controlAuth } },
        { allowCredentialCandidate: true },
      );
      const { health: controlHealth } = await handleConnectionProbe(
        { ...deps, store: control.store },
        { name, kind },
      );
      if (controlHealth.status !== 'auth_failed') {
        throw new RpcError(
          'credential_verification_failed',
          "This connection's check also accepts an invalid credential, so Recued cannot safely replace the current one. Your saved connection was not changed. Use an endpoint that requires authentication, then try again.",
          422,
          method,
          {
            verification_status: 'unknown',
            reason: 'credential_check_did_not_require_auth',
            existing_credential_preserved: true,
          },
        );
      }
    }

    let candidate = isolated.current();
    if (grantedScopes !== undefined) {
      candidate = {
        ...candidate,
        granted_scopes_json: JSON.stringify(grantedScopes),
      };
    }
    candidate = {
      ...candidate,
      // The verification probe can share the original row's deterministic
      // millisecond. A successful replacement is still a new editor revision.
      updated_at: Math.max(candidate.updated_at, existing.updated_at + 1),
    };
    // Decode the already-verified candidate only to project non-secret lifecycle
    // metadata into the receipt. Failure still occurs before the real write.
    const verifiedAuth = await decodeAuthFromStorage(
      candidate.auth_ciphertext,
      { kind, name },
      deps.getEncryptionKey,
    );
    assertCredentialRotationSnapshotIsCurrent(
      method,
      deps.store,
      kind,
      name,
      snapshot,
    );

    const expiresAt = 'expires_at' in verifiedAuth
      && typeof verifiedAuth.expires_at === 'number'
      ? verifiedAuth.expires_at
      : undefined;
    const verification: ConnectionCredentialVerification = {
      status: 'verified',
      verified_at: health.last_probed_at ?? (deps.now?.() ?? Date.now()),
      auth_type: verifiedAuth.type,
      ...(expiresAt !== undefined ? { access_expires_at: expiresAt } : {}),
    };
    const row = recoveryStore.completeCredentialRotationAttempt({
      attempt_id: attemptId,
      connection: connectionUpsertFromRow(candidate),
      verification,
    });
    committed = true;
    if (kind === 'api') {
      try {
        deps.recipeRunnabilityBroadcast?.recomputeAndEmit();
      } catch {
        // The atomic row+receipt is already authoritative. A best-effort
        // readiness broadcast must never turn that committed success into an
        // error response that would tell the owner the opposite outcome.
      }
    }
    return {
      connection: connectionViewFromRow(row),
      verification,
    };
  } catch (error) {
    if (!committed) {
      let enrichedAuthFailure: RpcError | null = null;
      try {
        const failureReason = credentialRotationFailureReason(error);
        const authRejectionStage = failureReason === 'auth_failed'
          ? credentialRejectionStage(error)
          : undefined;
        const failedAttempt = recoveryStore.failCredentialRotationAttempt({
          attempt_id: attemptId,
          finished_at: deps.now?.() ?? Date.now(),
          reason: failureReason,
          ...(failureReason === 'auth_failed' ? { auth_type: auth.type } : {}),
          ...(authRejectionStage !== undefined
            ? { auth_rejection_stage: authRejectionStage }
            : {}),
        });
        if (
          failureReason === 'auth_failed'
          && error instanceof RpcError
          && failedAttempt.status === 'failed'
        ) {
          const correction = credentialRejectionCorrectionForAttempt(
            kind,
            auth.type,
            failedAttempt.auth_rejection_triage_stage,
            failedAttempt.auth_rejection_resolution,
          );
          enrichedAuthFailure = new RpcError(
            error.code,
            error.message,
            error.status,
            error.method,
            {
              ...error.details,
              ...(correction !== null ? { correction } : {}),
            },
          );
        }
      } catch {
        // A process/storage interruption may leave the durable claim pending.
        // Never forward the original (apparently terminal) provider error:
        // the client would retire its only recovery pointer and could blindly
        // retry while this claim remains unresolved.
        throw new RpcError(
          'credential_rotation_outcome_unknown',
          'The replacement outcome could not be recorded. Check its status before trying again.',
          503,
          method,
        );
      }
      if (enrichedAuthFailure !== null) throw enrichedAuthFailure;
    }
    throw error;
  }
};

/** Read the secret-free durable outcome for one interrupted rotation. Identity
 * must match the claimed connection; a mismatched opaque id is indistinguishable
 * from an unknown id so this read cannot enumerate another row's activity. */
export const handleConnectionCredentialRotationStatus = async (
  deps: ConnectionRpcDeps,
  args: { attempt_id: string; name: string; kind: ConnectionKind },
): Promise<{ outcome: ConnectionCredentialRotationOutcome }> => {
  const method = 'collection.connection.credentialRotationStatus';
  const a = ensureRecordArgs(method, args);
  const attemptId = ensureCredentialRotationAttemptId(method, a.attempt_id);
  const name = ensureName(method, a.name);
  const kind = ensureKind(method, a.kind);
  const recoveryStore = credentialRotationRecoveryStore(method, deps.store);
  const attempt = recoveryStore.getCredentialRotationAttempt(attemptId);
  if (attempt !== null && (attempt.kind !== kind || attempt.name !== name)) {
    return { outcome: { status: 'not_found' } };
  }
  // A receipt is exact, but its safe-stop resolution is connection-current.
  // A later terminal attempt can leave the saved row revision unchanged, so
  // row CAS alone cannot stop a reloaded owner from resurrecting an obsolete
  // administrator handoff. Suppress only the resolution unless this receipt
  // is still the latest causal claim; the underlying bounded failure remains
  // available for ordinary correction/recovery copy.
  const latest = attempt?.status === 'failed'
    ? deps.store.getLatestCredentialRotationAttempt?.(kind, name) ?? null
    : null;
  const safeStopStillCurrent = attempt?.status === 'failed'
    && latest?.attempt_id === attempt.attempt_id;
  return {
    outcome: credentialRotationOutcomeFromAttempt(
      attempt,
      safeStopStillCurrent,
    ),
  };
};

/** Connection-scoped ownership read for sibling-tab takeover. It intentionally
 * exposes neither the opaque attempt id nor any credential/provider detail.
 * An idle response projects the latest safe stop through the same bounded
 * correction contract used by receipt recovery. This lets sibling tabs pause
 * and offer the same regeneration/admin handoff from server authority rather
 * than trusting a BroadcastChannel hint. */
export const handleConnectionCredentialRotationActivity = async (
  deps: ConnectionRpcDeps,
  args: { name: string; kind: ConnectionKind },
): Promise<{ activity: ConnectionCredentialRotationActivity }> => {
  const method = 'collection.connection.credentialRotationActivity';
  const a = ensureRecordArgs(method, args);
  const name = ensureName(method, a.name);
  const kind = ensureKind(method, a.kind);
  const readPending = deps.store.getPendingCredentialRotationAttempt;
  if (readPending === undefined) {
    throw new RpcError(
      'not_configured',
      'Connection-scoped credential-rotation ownership is unavailable on this server.',
      503,
      method,
    );
  }
  const pending = readPending.call(deps.store, kind, name);
  if (pending?.status === 'pending') {
    return { activity: { status: 'pending', started_at: pending.started_at } };
  }
  const readLatest = deps.store.getLatestCredentialRotationAttempt;
  if (readLatest === undefined) {
    // Mixed-version/narrow test stores can still answer the original ownership
    // question, but absence of this method is not evidence that no safe stop
    // exists. Omit the additive field so current clients stay fail-closed after
    // an exact safe-stop hint.
    return { activity: { status: 'idle' } };
  }
  const latest = readLatest.call(deps.store, kind, name);
  if (latest?.status === 'pending') {
    return { activity: { status: 'pending', started_at: latest.started_at } };
  }
  return {
    activity: {
      status: 'idle',
      safe_stop: credentialSafeStopFromAttempt(latest),
    },
  };
};

/** Explicitly close one exact, still-current administrator/provider handoff.
 * The token is derived from—but does not reveal—the attempt id. The store's
 * latest-row CAS remains the final boundary if a newer paired client starts or
 * finishes another attempt between this read and the write. */
export const handleConnectionAcknowledgeCredentialRotationSafeStop = async (
  deps: ConnectionRpcDeps,
  args: {
    name: string;
    kind: ConnectionKind;
    acknowledgement_token: string;
  },
): Promise<{
  acknowledgement: ConnectionCredentialRotationSafeStopAcknowledgement;
}> => {
  const method =
    'collection.connection.acknowledgeCredentialRotationSafeStop';
  const a = ensureRecordArgs(method, args);
  const name = ensureName(method, a.name);
  const kind = ensureKind(method, a.kind);
  const token = a.acknowledgement_token;
  if (
    typeof token !== 'string'
    || !CONNECTION_CREDENTIAL_SAFE_STOP_TOKEN_REGEX.test(token)
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: acknowledgement_token must be an opaque 64-character token`,
      400,
      method,
    );
  }
  const readLatest = deps.store.getLatestCredentialRotationAttempt;
  const acknowledge = deps.store.acknowledgeCredentialRotationSafeStop;
  if (readLatest === undefined || acknowledge === undefined) {
    throw new RpcError(
      'not_configured',
      'Authoritative credential safe-stop closure is unavailable on this server.',
      503,
      method,
    );
  }
  const latest = readLatest.call(deps.store, kind, name);
  const currentSafeStop = credentialSafeStopFromAttempt(latest, true);
  if (
    latest === null
    || currentSafeStop === null
    || currentSafeStop.acknowledgement_token !== token
  ) {
    return { acknowledgement: { status: 'superseded' } };
  }
  const result = acknowledge.call(deps.store, {
    attempt_id: latest.attempt_id,
    kind,
    name,
    acknowledged_at: deps.now?.() ?? Date.now(),
  });
  if (result === null) {
    return { acknowledgement: { status: 'superseded' } };
  }
  return {
    acknowledgement: {
      status: result.status,
      acknowledged_at: result.attempt.safe_stop_acknowledged_at,
    },
  };
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

  // R26.2-for-vendors — provider source, mirroring `startVendorOAuth` exactly.
  //
  // A REGISTERED vendor ALWAYS uses its registry config and any form-supplied
  // endpoints here are IGNORED, so they can never bypass its PKCE / secret gate
  // / sandbox split. The form-supplied path is reserved for NON-registry
  // vendors, which is the only way a loopback self-serve flow can finish: the
  // owner's server has no public HTTPS URL, so `startVendorOAuth` (which
  // requires one for its signed state + cloud forward) is unreachable, and this
  // pure-exchange rpc is what the browser can call instead once the same-origin
  // callback hands it the code.
  //
  // ⚠ Same trust boundary as `startVendorOAuth`, not a new one: the server
  // POSTs the code + client_secret to this endpoint, so it gets the identical
  // complete-HTTPS/no-userinfo/no-fragment contract, enforced server-side.
  const registered = getVendorProvider(a.vendor);
  const formAuthorizeUrl =
    typeof a.authorize_url === 'string' ? a.authorize_url.trim() : '';
  const formTokenEndpoint =
    typeof a.token_endpoint === 'string' ? a.token_endpoint.trim() : '';
  let provider;
  if (registered) {
    provider = registered;
  } else if (formAuthorizeUrl.length > 0 && formTokenEndpoint.length > 0) {
    for (const [label, raw] of [
      ['authorize_url', formAuthorizeUrl],
      ['token_endpoint', formTokenEndpoint],
    ] as const) {
      if (!isValidOAuthEndpointUrl(raw)) {
        throw new RpcError(
          'bad_request',
          `collection.connection.completeVendorOAuth: ${label} must be a complete HTTPS URL with no embedded username or password and no URL fragment`,
        );
      }
    }
    provider = buildGenericVendorProvider({
      authorize_url: formAuthorizeUrl,
      token_endpoint: formTokenEndpoint,
      scopes: [],
      vendor: a.vendor,
    });
  } else {
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
    // Apply the same complete-HTTPS/no-userinfo contract used by persisted
    // connection auth. The server POSTs the client_secret + auth code to
    // `token_endpoint`, so this validation cannot be browser-only.
    for (const [label, raw] of [
      ['authorize_url', formAuthorizeUrl],
      ['token_endpoint', formTokenEndpoint],
    ] as const) {
      if (!isValidOAuthEndpointUrl(raw)) {
        throw new RpcError(
          'bad_request',
          `collection.connection.startVendorOAuth: ${label} must be a complete HTTPS URL with no embedded username or password and no URL fragment`,
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

/** Read-only AI setup assistance. No store access and no mutation: request
 *  minimization + output validation live in `connection-setup-guide.ts`, while
 *  this boundary supplies the same not-configured posture as other optional
 *  connection capabilities. */
export const handleConnectionSuggestSetup = async (
  deps: ConnectionRpcDeps,
  args: unknown,
) => {
  if (deps.setupGuide === undefined) {
    throw new RpcError(
      'not_configured',
      'Set up an AI provider in Settings → AI before asking for a connection guide.',
      503,
      'collection.connection.suggestSetup',
    );
  }
  return generateConnectionSetupGuide(deps.setupGuide, args);
};

type ConnectionMethods =
  | 'collection.connection.list'
  | 'collection.connection.suggestSetup'
  | 'collection.connection.enroll'
  | 'collection.connection.update'
  | 'collection.connection.rotateCredentials'
  | 'collection.connection.credentialRotationStatus'
  | 'collection.connection.credentialRotationActivity'
  | 'collection.connection.acknowledgeCredentialRotationSafeStop'
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
  | 'collection.connection.takeVendorOAuthResult'
  | 'collection.connection.mcpPackPreview'
  | 'collection.connection.mcpPackCommit'
  | 'collection.connection.mcpPackStatus';

export const makeConnectionHandlers = (
  deps: ConnectionRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ConnectionMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  // One owner-triggered guide at a time per server handler set. The webclient
  // already prevents duplicate clicks in one tab; this closes the cross-tab /
  // direct-paired-client cost race around a slow model call.
  let setupGuideInFlight = false;
  return {
    methods: [
      'collection.connection.list',
      'collection.connection.suggestSetup',
      'collection.connection.enroll',
      'collection.connection.update',
      'collection.connection.rotateCredentials',
      'collection.connection.credentialRotationStatus',
      'collection.connection.credentialRotationActivity',
      'collection.connection.acknowledgeCredentialRotationSafeStop',
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
      'collection.connection.mcpPackPreview',
      'collection.connection.mcpPackCommit',
      'collection.connection.mcpPackStatus',
    ],
    handlers: {
      'collection.connection.list': async (args) =>
        handleConnectionList(deps, args as Parameters<typeof handleConnectionList>[1]),
      'collection.connection.suggestSetup': async (args) => {
        if (setupGuideInFlight) {
          throw new RpcError(
            'conflict',
            'Another setup guide is already being created. Wait for it to finish.',
            409,
            'collection.connection.suggestSetup',
          );
        }
        setupGuideInFlight = true;
        try {
          return await handleConnectionSuggestSetup(deps, args);
        } finally {
          setupGuideInFlight = false;
        }
      },
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
      'collection.connection.rotateCredentials': async (args) =>
        handleConnectionRotateCredentials(
          deps,
          args as Parameters<typeof handleConnectionRotateCredentials>[1],
        ),
      'collection.connection.credentialRotationStatus': async (args) =>
        handleConnectionCredentialRotationStatus(
          deps,
          args as Parameters<typeof handleConnectionCredentialRotationStatus>[1],
        ),
      'collection.connection.credentialRotationActivity': async (args) =>
        handleConnectionCredentialRotationActivity(
          deps,
          args as Parameters<typeof handleConnectionCredentialRotationActivity>[1],
        ),
      'collection.connection.acknowledgeCredentialRotationSafeStop': async (args) =>
        handleConnectionAcknowledgeCredentialRotationSafeStop(
          deps,
          args as Parameters<
            typeof handleConnectionAcknowledgeCredentialRotationSafeStop
          >[1],
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
      'collection.connection.mcpPackPreview': async (args) =>
        handleMcpPackPreview(
          deps,
          args as Parameters<typeof handleMcpPackPreview>[1],
        ),
      'collection.connection.mcpPackCommit': async (args) =>
        handleMcpPackCommit(
          deps,
          args as Parameters<typeof handleMcpPackCommit>[1],
        ),
      'collection.connection.mcpPackStatus': async (args) =>
        handleMcpPackStatus(
          deps,
          args as Parameters<typeof handleMcpPackStatus>[1],
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

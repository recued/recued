/** D-165 P0 — provider-catalog seed (minimal).
 *
 *  P0 is the runtime-first slice: the engine detects *catalog-form*
 *  ingredients (manifests carrying an `operations` map) and routes them
 *  through the D-157 gateway with operation-level policy, instead of the
 *  wrapper's static `risk_tier`. This module holds the *minimal* typed
 *  shapes that slice needs — enough to:
 *
 *    - detect catalog-form (`isCatalogForm`),
 *    - resolve an operation's effective risk + approval + grant verdict
 *      from the catalog declaration + the local per-connection profile
 *      (`resolveCatalogOperationPolicy` — the heart of Invariant 1), and
 *    - shape the per-call gateway audit row (`GatewayCallAudit`).
 *
 *  D-165 P2 (policy slice) grows the P0/P1 seed into the full *policy*
 *  declaration — per-operation request/response schemas, sub_operations,
 *  idempotency / media, cache + timeout policy; full operation_groups
 *  (display, grant_default, upgrade_behavior); catalog-level governance
 *  (catalog_kind, marketplace_eligible, supported_media, defaults) — and a
 *  strict mechanical-invariant validator gates them all (`validateCatalogForm`
 *  in `packages/ingredients/src/validate.ts`). A subsequent P2 slice added
 *  the *surfaces* / *auth* / *execution-binding* substrate (`ProviderSurfaces`
 *  + the `AuthSpec` / `ApiExecutionBinding` / `ConnectorExecutionBinding`
 *  unions below) and the surface-dependent validator gates (scope-universe
 *  coverage, real-time-binding cache discipline, connector wire/binding
 *  match). Still pending for later P2 slices: the runtime gateway dispatch
 *  switch over `surfaces.api.executes` (supersedes `delegates_to`), the
 *  OpenAPI/GraphQL document pin + connector `describe()` cross-checks,
 *  app-pack v2, and the marketplace publish path. Entity schemas already
 *  shipped (`entity-schema.ts`).
 *  See D-165 § "Suggested phase shape" / § Operations / § Surfaces.
 *
 *  Spec: D-165 § Operations (policy) / Operation groups /
 *  Default policy / Runtime flow / Invariants 1-5; § "P0 — Kernel +
 *  gateway (runtime first)".
 */

import type { IngredientKind, RiskTier } from './ingredient.js';
import { RISK_TIER_RANK } from './ingredient.js';
import type { ServiceRestartPolicy } from './service.js';
import type { ExecutionSource } from './commits.js';
import type { ProgressContract } from './execution-lane.js';
import { canonicalizeSubresourcePath } from './connection.js';
import type { MetaFieldType } from './entity-schema.js';
import { WIRE_AUTHORITY_ARG_PATHS } from './open-projection.js';
import type { EntityFieldPrivacy } from './pii-alias.js';
import type { WebhookProfileId } from './webhook-profiles.js';
// ⚠ Type-only, and deliberately so: `op-model.ts` imports FROM this module
// (also type-only), so a value import either way would be a runtime cycle.
// Both are erased, so this is a type-level reference only.
import type { HttpUploadSpec } from './op-model.js';

/** Catalog operations reuse the existing four-tier `RiskTier` ladder —
 *  `read` < `write` < `admin` < `destructive`. Aliased (not redefined) so
 *  a future catalog-specific widening, if it ever happens, has one name to
 *  touch; today the two are identical. */
export type OperationRiskTier = RiskTier;

/** Per-operation approval intent declared by the catalog author.
 *  - `never`  — admit without preflight (read-class endpoints).
 *  - `ask`    — route through D-157 ask/checkpoint once.
 *  - `always` — always ask (destructive-class endpoints).
 *  Resolution is stricter-wins against the per-connection profile and the
 *  provider default policy — see `resolveCatalogOperationPolicy`. */
export type OperationApproval = 'never' | 'ask' | 'always';

/** D-209 §1.7 / D-211 Slice 3 — authorization posture captured after every
 *  authorization layer, but before a later review/quality lift. Consumers use
 *  this provenance instead of re-deriving authorization from risk: a live
 *  session grant may absorb `never` / `ask`, but never `always`; a standing
 *  delegation remains eligible. */
export interface AuthorizationProvenance {
  readonly pre_lift_approval: OperationApproval;
  /** ⚠ CLOSED, AND IT IS RE-VALIDATED IN TWO PLACES THAT CANNOT IMPORT THIS
   *  TYPE'S NARROWING — `isCheckpoint` (`checkpoint.ts`) and
   *  `readAuthorizationProvenance` (`preflight-reconciliation.ts`) both spell
   *  the members out against untrusted persisted JSON. Adding a member is
   *  THREE edits, and the two revalidators fail CLOSED: a reason they do not
   *  know drops the whole provenance, which silently costs a resumed hold its
   *  `pre_lift_approval` and with it its session-grant eligibility. ⇒ That cost
   *  is why D-234 § 234.4o's peer-ask lift did NOT earn a fourth member: it is
   *  an outbound send and reports `review_send`, with `ingredient_slug` already
   *  distinguishing it precisely. */
  readonly lift_reason?: 'review_send' | 'review_commitment' | 'quality';
}

/** D-201 Slice 6B3 — the complete portable declaration for provider resource
 * operations that need the owner-selected webhook URL. Request construction is
 * deliberately absent; an exact trusted server adapter owns it. */
export interface OperationBoundWebhookDeclaration {
  binding: string;
  intent: 'attach' | 'detach';
}

// ── D-165 P2 — full catalog policy shape (closed enums + numeric bounds) ──
//
//  P2 grows the P0/P1 seed `OperationSpec` / `OperationGroupSpec` /
//  catalog-level manifest from the policy-relevant subset into the full
//  *policy* declaration the strict validator gates (spec § Operations /
//  Operation groups / Timeout gates / Cache-TTL gates). Every field is
//  additive + optional, so a P0/P1 catalog declaring only risk / groups /
//  approval / delegates_to stays valid (spec § Compatibility — "additive
//  options, not a fork"). The *surfaces* / *auth* / *execution-binding*
//  layer + the OpenAPI/connector cross-checks land in a later P2 slice.

/** Media an operation accepts or produces, and the catalog handles overall
 *  (`supported_media`, per-op `accepts_media` / `produces_media`). Closed
 *  list — spec § Provider catalog manifest top-level `MediaKind`. */
export type MediaKind =
  | 'text' | 'image' | 'video' | 'audio_recorded' | 'audio_streaming'
  | 'voice_realtime_bidirectional' | 'document' | 'sticker' | 'location'
  | 'interactive_ui';
export const MEDIA_KINDS: readonly MediaKind[] = [
  'text', 'image', 'video', 'audio_recorded', 'audio_streaming',
  'voice_realtime_bidirectional', 'document', 'sticker', 'location',
  'interactive_ui',
];
export const isMediaKind = (v: unknown): v is MediaKind =>
  typeof v === 'string' && (MEDIA_KINDS as readonly string[]).includes(v);

/** Catalog governance / trust tier (spec § top-level `catalog_kind`).
 *  `private_byo` never enters marketplace publishing — its
 *  `marketplace_eligible` must be false (validator gate). */
export type CatalogKind = 'official' | 'unofficial_acknowledged' | 'private_byo';
export const CATALOG_KINDS: readonly CatalogKind[] = [
  'official', 'unofficial_acknowledged', 'private_byo',
];
export const isCatalogKind = (v: unknown): v is CatalogKind =>
  typeof v === 'string' && (CATALOG_KINDS as readonly string[]).includes(v);

/** Operation idempotency classifier (spec § Operations `idempotency`) —
 *  informs retry-safety at dispatch. */
export type OperationIdempotency = 'safe' | 'idempotent' | 'non_idempotent';
export const OPERATION_IDEMPOTENCIES: readonly OperationIdempotency[] = [
  'safe', 'idempotent', 'non_idempotent',
];
export const isOperationIdempotency = (v: unknown): v is OperationIdempotency =>
  typeof v === 'string'
  && (OPERATION_IDEMPOTENCIES as readonly string[]).includes(v);

/** Operation-group grant posture at connection enrollment (spec § Operation
 *  groups `grant_default`). `on_after_connect` auto-grants the group the
 *  moment the connection is enrolled — safe ONLY for read-tier groups
 *  (Invariant 3 + § "no admin-tier operations in a catalog claiming
 *  read-only scope"); the validator rejects a non-read operation in such a
 *  group. Defaults to `off` when omitted. */
export type GroupGrantDefault = 'off' | 'on_after_connect';
export const GROUP_GRANT_DEFAULTS: readonly GroupGrantDefault[] = [
  'off', 'on_after_connect',
];
export const isGroupGrantDefault = (v: unknown): v is GroupGrantDefault =>
  typeof v === 'string' && (GROUP_GRANT_DEFAULTS as readonly string[]).includes(v);

/** How an installed group grant treats operations added in a LATER catalog
 *  version (spec § Operation groups `upgrade_behavior` / Invariant 3).
 *  Default `new_operations_off` — an upgrade never silently grants newly
 *  added write/admin/destructive operations through an old group grant. */
export type GroupUpgradeBehavior = 'new_operations_off' | 'inherit_group_policy';
export const GROUP_UPGRADE_BEHAVIORS: readonly GroupUpgradeBehavior[] = [
  'new_operations_off', 'inherit_group_policy',
];
export const isGroupUpgradeBehavior = (v: unknown): v is GroupUpgradeBehavior =>
  typeof v === 'string'
  && (GROUP_UPGRADE_BEHAVIORS as readonly string[]).includes(v);

/** Catalog timeout / cache-TTL policy bounds (spec § Timeout gates /
 *  Cache-TTL gates). Centralized in the contract so the strict validator
 *  AND the runtime gateway's cache/timeout resolution (Invariants 6 + 7)
 *  share one source of truth.
 *
 *    - `CATALOG_DEFAULT_TIMEOUT_MS` — op timeout when the catalog omits
 *      `default_timeout_ms` (30s).
 *    - `CATALOG_MIN_OP_TIMEOUT_MS` — per-op `timeout_ms` floor (1s).
 *    - `CATALOG_OP_TIMEOUT_MULTIPLIER` — per-op ceiling = catalog default × 3.
 *    - `CATALOG_REST_TIMEOUT_SOFT_CAP_MS` — `default_timeout_ms` above this
 *      warns (REST's per-surface cap; the common case). Per-surface
 *      tightening to GraphQL 180s / connector 120s lands with the surfaces
 *      slice — until then the absolute hard cap is the loosest (GraphQL).
 *    - `CATALOG_MAX_DEFAULT_TIMEOUT_MS` — absolute hard cap (180s).
 *    - `CATALOG_MAX_CACHE_TTL_MS` — read-op cache TTL absolute cap (24h).
 *    - `CATALOG_CACHE_OUTLIER_MULTIPLIER` — read cache TTL above the catalog
 *      default × 3 warns (outlier). */
export const CATALOG_DEFAULT_TIMEOUT_MS = 30_000;
export const CATALOG_MIN_OP_TIMEOUT_MS = 1_000;
export const CATALOG_OP_TIMEOUT_MULTIPLIER = 3;
export const CATALOG_REST_TIMEOUT_SOFT_CAP_MS = 60_000;
export const CATALOG_MAX_DEFAULT_TIMEOUT_MS = 180_000;
export const CATALOG_DEFAULT_CACHE_TTL_MS = 60_000;
export const CATALOG_MAX_CACHE_TTL_MS = 86_400_000;
export const CATALOG_CACHE_OUTLIER_MULTIPLIER = 3;

// ════════════════════════════════════════════════════════════════
// Catalog vendor registry (D-165) — `config.vendor` → catalog slug
// ════════════════════════════════════════════════════════════════

/** The HubSpot catalog-form ingredient slug — the first OAuth-vendor catalog
 *  (D-165 P1). */
export const HUBSPOT_CATALOG_SLUG = 'hubspot-catalog';

/** The Salesforce catalog-form ingredient slug — the second vendor on the
 *  gateway (D-165 RUNTIME #4). Same operation/group/surface shape as
 *  `hubspot-catalog`. */
export const SALESFORCE_CATALOG_SLUG = 'salesforce-catalog';

/** The Pipedrive catalog-form ingredient slug — the third CRM vendor on the
 *  gateway. Pipedrive's native CRM entity names are `deal` / `person` /
 *  `organization`; the CRM registry maps those to deal/contact/account. */
export const PIPEDRIVE_CATALOG_SLUG = 'pipedrive-catalog';

/** The Exa web-search catalog-form ingredient slug — the first ENTITY-LESS tool
 *  vendor on the gateway (§5 tool-op pack seam, v3 §7 "cli / tool pack"). Unlike
 *  the CRM catalogs it models no `crm_alias` entity (absent from
 *  `CONNECTION_VENDOR_ENTITIES`): its single-function `web.search` op is reached
 *  through a TOOL op-step (`web.search`) that dispatches PASS-THROUGH (no
 *  canonical-field projection), governed by the same D-165 gateway. */
export const EXA_CATALOG_SLUG = 'exa-catalog';

/** Vendor (`config.vendor` segment) → catalog-form ingredient slug. The
 *  catalog gateway's grant substrate is MULTI-catalog: every `kind: 'api'`
 *  connection whose vendor is a key here resolves its operation policy + REST
 *  surface bindings from THAT vendor's catalog manifest. This is the single
 *  source of truth shared by the server boot seed
 *  (`connection-operation-profile-boot`), the grant rpcs (`connection-handler`),
 *  and the webclient grant panel (`connections-grant-panel`) — adding a vendor
 *  is one entry here plus shipping its `<slug>.json` catalog with
 *  `surfaces.api`. Read with `catalogSlugForVendor` (a `hasOwnProperty` guard —
 *  see below).
 *
 *  Vendor-generic, NOT CRM-specific: a key here just means "this vendor's
 *  connection resolves a catalog at the gateway". CRM-ness is a SEPARATE layer
 *  (`CONNECTION_VENDOR_ENTITIES` — the `crm_alias`↔entity registry). An
 *  ENTITY-LESS tool/single-function vendor (`exa`, v3 §7) belongs here too: its
 *  connection resolves `exa-catalog`'s `web.search` policy + surface, and its
 *  recipes reach the op through a TOOL op-step (the resolver routes `<family>.<verb>`
 *  to the tool path when `<family>` is not a `crm_alias` — §5 tool-op pack seam),
 *  with no entity in `CONNECTION_VENDOR_ENTITIES`. */
export const CATALOG_VENDOR_SLUGS: Readonly<Record<string, string>> = {
  hubspot: HUBSPOT_CATALOG_SLUG,
  salesforce: SALESFORCE_CATALOG_SLUG,
  pipedrive: PIPEDRIVE_CATALOG_SLUG,
  exa: EXA_CATALOG_SLUG,
};

/** The catalog slug for a vendor, or undefined when the vendor has no
 *  registered catalog. Doubles as the grantability predicate — a connection's
 *  vendor is catalog-grantable iff this returns a slug. `hasOwnProperty`-guarded
 *  because `config.vendor` is attacker-influenced: a bare
 *  `CATALOG_VENDOR_SLUGS[vendor]` would otherwise resolve `'__proto__'` /
 *  `'constructor'` to a truthy non-slug. */
export const catalogSlugForVendor = (
  vendor: string | null | undefined,
): string | undefined =>
  typeof vendor === 'string'
    && Object.prototype.hasOwnProperty.call(CATALOG_VENDOR_SLUGS, vendor)
    ? CATALOG_VENDOR_SLUGS[vendor]
    : undefined;

/** Compound-operation sub-policy (spec § Operations `sub_operations`) — a
 *  Docs `batchUpdate` / Slack Block Kit-style compound call gates its parts
 *  independently. The validator requires a valid `risk_tier` per sub-op and
 *  validates `approval` / `groups` when present. */
export interface SubOperationSpec {
  risk_tier: OperationRiskTier;
  groups?: string[];
  approval?: OperationApproval;
}

/** Per-operation request metadata (spec § Operations `request_metadata`). */
export interface OperationRequestMetadata {
  idempotency_key?: 'supported' | 'required' | 'none';
  api_version_pinned?: string;
  custom_headers?: Record<string, string>;
}

/** An operation arg that carries a query DSL (spec § Operations `args_dsl`):
 *  JQL, KQL, SQL, Notion filter, GraphQL filter, … (open vocabulary). */
export interface OperationArgsDsl {
  arg_name: string;
  dsl_kind: string;
  parser?: string;
}

/** Operation-local pagination contract. Omitted means exactly one upstream
 *  dispatch. When present, the catalog gateway walks pages behind the same
 *  admitted read operation and returns a merged logical result to the recipe.
 *
 *  This is intentionally a closed set of reviewed mechanics, not a free-form
 *  expression language: packs declare where the item array and cursor live, and
 *  the gateway owns replay safety, page ceilings, and audit disclosure. */
export type OperationPaginationStyle =
  | 'body_cursor'
  | 'next_path'
  | 'link_header'
  | 'query_token'
  | 'query_token_link'
  | 'offset'
  | 'graphql_relay'
  | 'single_page';
export const OPERATION_PAGINATION_STYLES: readonly OperationPaginationStyle[] = [
  'body_cursor',
  'next_path',
  'link_header',
  'query_token',
  'query_token_link',
  'offset',
  'graphql_relay',
  'single_page',
];
export const isOperationPaginationStyle = (v: unknown): v is OperationPaginationStyle =>
  typeof v === 'string' && (OPERATION_PAGINATION_STYLES as readonly string[]).includes(v);

export type OperationPaginationPlacement = 'query' | 'body';
export const OPERATION_PAGINATION_PLACEMENTS: readonly OperationPaginationPlacement[] = ['query', 'body'];
export const isOperationPaginationPlacement = (v: unknown): v is OperationPaginationPlacement =>
  typeof v === 'string' && (OPERATION_PAGINATION_PLACEMENTS as readonly string[]).includes(v);

export interface OperationPaginationPageSize {
  placement: OperationPaginationPlacement;
  param: string;
  /** Per-page value the gateway writes into the upstream request. */
  value: number;
  /** Provider's documented maximum for this operation. Validator requires
   *  `value <= max` when present. */
  max?: number;
}

export interface OperationPaginationCondition {
  /** Path inside the vendor body, not including the gateway's `.result` wrapper
   *  (for example Stripe `has_more`). */
  path: string;
  equals: string | number | boolean | null;
}

export interface OperationPaginationCursorSource {
  /** Path to the current page's item array inside the vendor body, not including
   *  the gateway's `.result` wrapper (for example Stripe `data`). */
  path: string;
  select: 'first' | 'last';
  /** Field path inside the selected item whose string value becomes the cursor
   *  (for example `id`). */
  field: string;
}

export interface OperationPaginationCursorTarget {
  placement: OperationPaginationPlacement;
  param: string;
}

export interface BodyCursorPaginationSpec {
  style: 'body_cursor';
  page_size?: OperationPaginationPageSize;
  /** Optional continuation predicate. If omitted, a non-empty cursor means
   *  "continue"; if present and false, the walk stops even when a cursor can be
   *  derived. */
  next_when?: OperationPaginationCondition;
  cursor_from: OperationPaginationCursorSource;
  cursor_to: OperationPaginationCursorTarget;
}

export interface NextPathPaginationSpec {
  style: 'next_path';
  page_size?: OperationPaginationPageSize;
  /** Path inside the vendor body containing the next-page path. */
  path: string;
  /** Optional terminal predicate checked before reading `path`. */
  done_when?: OperationPaginationCondition;
  /** Optional allowlist prefix for the returned root-relative path. */
  path_prefix?: string;
}

export interface LinkHeaderPaginationSpec {
  style: 'link_header';
  page_size?: OperationPaginationPageSize;
  /** Response header that carries RFC5988-style links. Defaults to `link`. */
  header?: string;
}

/** D-192 #8g — the single most common modern REST pattern: a TOP-LEVEL opaque
 *  next-page token (Todoist `next_cursor`, Google `nextPageToken`, Jira
 *  `nextPageToken`) replayed on the SAME operation as a query/body param.
 *  Distinct from `body_cursor`, whose token is a FIELD OF AN ITEM in the records
 *  array — here the token is a top-level scalar at a body path. The re-dispatch
 *  reuses the first page's input + the param (like `body_cursor`), so the op
 *  `path_template` composes through the connection-api adapter — no
 *  vendor-returned continuation path. */
export interface QueryTokenPaginationSpec {
  style: 'query_token';
  page_size?: OperationPaginationPageSize;
  /** Body path to the next-page token (`next_cursor` / `nextPageToken`), not
   *  including the gateway's `.result` wrapper. */
  token_from: string;
  /** Where the token rides on the next request. */
  token_to: OperationPaginationCursorTarget;
  /** Optional terminal predicate (e.g. `has_more == false`) checked before the
   *  token read. Absent → an empty/absent token stops the walk. */
  done_when?: OperationPaginationCondition;
}

/** A returned next-page URL whose opaque continuation token is replayed on the
 *  SAME operation. Front is the motivating shape: `_pagination.next` may use a
 *  tenant-specific hostname, but only its `page_token` query value is authority
 *  for the next request. Extracting that scalar instead of following the URL
 *  preserves the admitted method/path and cannot redirect credentials off-host. */
export interface QueryTokenLinkPaginationSpec {
  style: 'query_token_link';
  page_size?: OperationPaginationPageSize;
  /** Body path to the returned absolute or relative next-page URL. */
  link_from: string;
  /** Query-string key to extract from `link_from`. */
  query_param: string;
  /** Where the extracted token rides on the replayed request. */
  token_to: OperationPaginationCursorTarget;
  /** Optional terminal predicate checked before reading the link. */
  done_when?: OperationPaginationCondition;
}

/** D-192 #8g — page-number / record-offset increment (ClickUp `?page=N`, classic
 *  `startAt`/`maxResults`). The ONLY stateful style: the next page is COMPUTED
 *  from a running counter, not read from the response (offset APIs carry no
 *  response cursor). Terminates on `done_when`, an empty records page, or the
 *  gateway page/record ceilings (the hard backstop — offset has no natural cursor
 *  terminus). */
export interface OffsetPaginationSpec {
  style: 'offset';
  /** The per-page window. REQUIRED for `increment: 'by_page_size'` (its `value`
   *  IS the per-cycle record advance); OPTIONAL for `increment: 'page'`, where the
   *  server owns a fixed page size and the client only bumps the page NUMBER
   *  (ClickUp `?page=N` takes no size param). */
  page_size?: OperationPaginationPageSize;
  /** Where the page/offset value rides. */
  param: OperationPaginationCursorTarget;
  /** The first page's value (`0` for offset-based, `1` for page-based). */
  start: number;
  /** `page`: `param` += 1 each cycle (a page NUMBER); `by_page_size`: `param` +=
   *  `page_size.value` each cycle (a record OFFSET). */
  increment: 'page' | 'by_page_size';
  /** Optional terminal predicate (e.g. `last_page == true`) — declaring one saves
   *  the extra empty-page probe the walk otherwise needs to find the end. */
  done_when?: OperationPaginationCondition;
}

/** D-192 #8g — the Relay connection spec's `pageInfo` cursor (Linear, GitHub v4,
 *  Shopify, and every Relay-conformant GraphQL API). Unlike the REST styles the
 *  cursor rides a GraphQL VARIABLE (the POST body's `variables`), not a
 *  query/path param, so it walks inside the graphql transport. Generalized so
 *  vendor variants are pack-declarable: the `pageInfo` path, the cursor/page-size
 *  VARIABLE names, and the `hasNextPage`/`endCursor` field names are all declared
 *  (the field names default to the Relay-spec names). */
export interface GraphqlRelayPaginationSpec {
  style: 'graphql_relay';
  /** The `first:`-style page-size VARIABLE injected on each follow page (a GraphQL
   *  variable, not a wire param — hence its own shape). Absent → the caller's
   *  variables carry the page size unchanged. */
  page_size?: { variable: string; value: number };
  /** Dot-path to the connection's `pageInfo` object within the response body, not
   *  including the gateway's `.result` wrapper (`data.issues.pageInfo`). */
  page_info_path: string;
  /** The GraphQL VARIABLE the next cursor rides (`after`). */
  cursor_variable: string;
  /** Field within `pageInfo` holding the continue flag. Default `hasNextPage`. */
  has_next_field?: string;
  /** Field within `pageInfo` holding the next cursor. Default `endCursor`. */
  end_cursor_field?: string;
}

/** D-192 #8g — certify a NON-paginating operation as complete-in-one-call. A
 *  Source list op with no `pagination` honestly mirrors `list_complete:false`
 *  (#8f can't prove a bare first page is the whole set); declaring `single_page`
 *  asserts the vendor returns the WHOLE set in one response (Trello's bare array,
 *  an Azure WIQL id list). No walk — the single gated page IS the complete set,
 *  so the follower certifies `pages_fetched:1` (→ `list_complete:true`). A
 *  PACK-AUTHOR ASSERTION: declare it ONLY when any provider cap comfortably
 *  exceeds real result sizes, else leave the op honestly incomplete. An optional
 *  `page_size` lets the op request the largest single page the provider allows;
 *  a single page overflowing the record ceiling still truncates honestly. */
export interface SinglePagePaginationSpec {
  style: 'single_page';
  page_size?: OperationPaginationPageSize;
}

export type OperationPaginationSpec =
  | BodyCursorPaginationSpec
  | NextPathPaginationSpec
  | LinkHeaderPaginationSpec
  | QueryTokenPaginationSpec
  | QueryTokenLinkPaginationSpec
  | OffsetPaginationSpec
  | GraphqlRelayPaginationSpec
  | SinglePagePaginationSpec;

/** P0 subset of the D-165 `OperationSpec` (spec § Operations). Carries
 *  only the policy-relevant fields the gateway needs at dispatch — the
 *  surface bindings, request/response schemas, sub_operations, idempotency,
 *  media, and cache/timeout overrides are P2 catalog-manifest territory.
 *
 *  `operation_id` is catalog-scoped (`"recued-core/github.issues.list"`)
 *  but the engine looks operations up by the short key the recipe step
 *  passes (`"issues.list"`) — the key in the `operations` map IS the
 *  lookup key; `operation_id` is the audit-facing fully-qualified id. */
/** D-165 P3.path-picker (Slice 3) — per-operation path-scope enforcement
 *  contract (spec § Sub-resource gating via path-scoped connections). The
 *  gateway derives the call's target path from `target_path_template` + the
 *  caller's args, canonicalizes it, and checks it against the bound
 *  connection's `subresource_path` per `policy`. See `checkPathScope`. */
export interface PathScopeContract {
  /** `connection_root` — account-level operation; requires the connection
   *  itself to be unscoped (`subresource_path === '/'`) and needs no
   *  template. `connection_or_below` — the target must equal the connection's
   *  path or be a strict descendant. `descendant_only` — the target must be a
   *  strict descendant (never the connection path itself). */
  policy: 'connection_root' | 'connection_or_below' | 'descendant_only';
  /** Template the gateway resolves against the call's args to derive the
   *  target path — e.g. `/{bucket}/{key}` or `/databases/{database_id}`.
   *  `{name}` tokens reference top-level arg fields by name. REQUIRED for
   *  `connection_or_below` / `descendant_only`; ignored for
   *  `connection_root`. A token whose arg is missing/empty fails CLOSED (the
   *  gateway cannot verify scope → deny). */
  target_path_template?: string;
  /** Path comparison rule. `strict` (default) compares canonical paths
   *  exactly; `case_insensitive` lowercases both sides first (S3 keys are
   *  case-sensitive → strict; Notion ids aren't → case_insensitive). Storage
   *  canonicalization stays case-preserving regardless — this flag only
   *  affects the comparison. */
  canonicalization?: 'strict' | 'case_insensitive';
}

/** D-170 N.7 / D-173 N.6 — one user-editable operation arg (the
 *  allowlist element). Declared on the authoring op-family row
 *  (`OperationRow.editable_args`) and LOWERED onto the installed
 *  `OperationSpec.editable_args` by the decomposer (D-170 spec § "lowers
 *  onto the OperationSpec"), so the runtime can resolve a held operation's
 *  edit-form allowlist without re-reading the authoring source.
 *
 *  ONLY the args named here are editable at a D-173 review-then-approve
 *  gate; every other authored / prefilled arg is immutable. The D-173
 *  `ArgEditSchema` resolver intersects this allowlist with the
 *  operation's `request_schema` + the materialize target's entity-field
 *  facets to produce the concrete edit form; `reception.inbox.approve`
 *  REJECTS any edit key absent from it before writing
 *  `checkpoint.arg_overrides` (the N.5 security boundary).
 *
 *  The canonical definition lives here (co-located with `OperationSpec`,
 *  which `bulk-pack.ts` already imports from) so the lowering target and
 *  the authoring source share ONE shape; `bulk-pack.ts` re-exports it for
 *  the authoring-side `OperationRow`. */
export interface ArgEditField {
  /** Arg path on the operation's `request_schema` (e.g. `title`,
   *  `start_at`, `request.email`). */
  key: string;
  type: MetaFieldType;
  label?: string;
  required?: boolean;
  privacy?: EntityFieldPrivacy;
  /** Picker source (a D-170 `dynamicOptions` key — calendar list /
   *  destination Source list). */
  options_source?: string;
  /** Editing this re-resolves `approved_target` at approve time
   *  (D-173 N.5 §3) — a consciously-chosen destination / connection. */
  affects_target?: boolean;
  validation?: { min?: number; max?: number; pattern?: string };
}

export interface OperationSpec {
  operation_id: string;
  description?: string;
  /** INVARIANT 1 source of truth — the gateway derives effective risk
   *  from THIS, never from the wrapper manifest's static `risk_tier`. */
  risk_tier: OperationRiskTier;
  /** Catalog-scoped operation-group ids this operation belongs to. The
   *  first is treated as the primary group for audit attribution. */
  groups?: string[];
  /** Author-declared approval intent. When omitted, the gateway derives
   *  it from the provider default policy for the effective risk tier. */
  approval?: OperationApproval;
  /** Auth scopes the operation needs — declared for forward-compat with
   *  the P2 surface-auth cross-check; unused by the P0 gateway. */
  required_scopes?: string[];
  /** D-201 Slice 6B3 — bind this provider operation to one logical webhook
   *  requirement without making the callback URL an authored argument.
   *  Trusted server code resolves the owner-selected ingress and either
   *  injects its canonical URL (`attach`) or the adapter's fixed clear value
   *  (`detach`). The declaration carries no URL, field path, HTTP template,
   *  credential, remote id, or adapter implementation selector. */
  operation_bound_webhook?: OperationBoundWebhookDeclaration;
  // ── D-165 P2 — full operation policy (additive over the P0/P1 seed; all
  //    optional, each gated by the strict validator only when present). ──

  /** Idempotency classifier — retry-safety hint at dispatch. */
  idempotency?: OperationIdempotency;
  /** Media this operation accepts / produces. */
  accepts_media?: MediaKind[];
  produces_media?: MediaKind[];
  /** Canonical JSON-Schema request / response shapes (surfaces may override;
   *  covered by `openapi_source` when the catalog declares one). Request
   *  schemas with `additionalProperties: false` opt into the bounded,
   *  publish-validated scalar / nested-object / object-array subset enforced
   *  by the runtime gateway; other request schemas and all response schemas
   *  remain descriptive. */
  request_schema?: unknown;
  response_schema?: unknown;
  /** D-170 N.7 / D-173 N.6 — the user-editable-args allowlist, LOWERED
   *  from the authoring op-family row by the decomposer (D-170 spec
   *  § "lowers onto the OperationSpec"). The D-173 `ArgEditSchema`
   *  resolver reads it off the installed catalog to build a held
   *  operation's edit form; `reception.inbox.approve` enforces it as the
   *  N.5 boundary allowlist. Absent / empty ⇒ the operation exposes no
   *  editable args (approve-as-prefilled). */
  editable_args?: ArgEditField[];
  /** D-177 P1b (N.2) — volatile-exclusion paths removed from the commit's
   *  `canonical_payload_hash` (client timestamps, correlation tokens) so an
   *  honest exact repeat still hashes equal. Op-level only — declared HERE,
   *  at the curated catalog trust surface; never recipe-authored, never
   *  Gateway-inferred. Paths are in the operation's arg form — for a REST
   *  binding that is the connection-api wire-key form the args already use
   *  (`body.client_ts` as a literal flat key; `canonicalArgHash`'s
   *  `removePath` matches a literal own key first). Fail-closed validated
   *  against the op's authority-bearing set
   *  ({@link collectOperationAuthorityPaths} — wire-authority keys ∪
   *  `path_scope` template tokens ∪ `affects_target` editable args ∪ the
   *  op's own `authority_args`) at the validator
   *  (`validateHashExcludeArgs`). The shape hash is NOT reduced
   *  by exclusions. */
  hash_exclude_args?: string[];
  /** D-177 catalog open mode (N.11) — the operation's AUTHORITY-ARG
   *  declaration: dot-paths into the op's `args` that select a destination /
   *  entity / risk BEYOND the derivable baseline
   *  ({@link collectOperationAuthorityPaths}: wire-authority keys ∪
   *  `path_scope` template tokens ∪ `affects_target` editable args), e.g. a
   *  body-borne recipient on a send-style op. Mirrors the simple-form
   *  manifest's `authority_args` (`IngredientManifest.authority_args`) at
   *  the op level — the catalog's curated trust surface; never
   *  recipe-authored, never Gateway-inferred.
   *
   *  PRESENCE is the per-op `grant_mode: 'open'` opt-in attestation: the
   *  curator asserts the derivable baseline ∪ this list covers EVERY
   *  destination/entity selector this operation dispatches on. An empty
   *  array is a valid declaration ("the derivable set suffices"); an ABSENT
   *  field means open grants are never offered/matched/minted for this
   *  operation (fail closed — a body-borne destination could otherwise be
   *  re-aimed through open's payload freedom; the derivation alone cannot
   *  attest body-arg completeness). Declared paths also JOIN the set
   *  `hash_exclude_args` may never target (N.2 — one authority set, two
   *  consumers). */
  authority_args?: string[];
  request_metadata?: OperationRequestMetadata;
  args_dsl?: OperationArgsDsl;
  /** Compound-op sub-policy, keyed by sub-operation name. */
  sub_operations?: Record<string, SubOperationSpec>;
  /** Per-operation invocation timeout (ms); falls back to the catalog
   *  `default_timeout_ms`. Validator bounds: `CATALOG_MIN_OP_TIMEOUT_MS` ≤ t
   *  ≤ (default_timeout_ms ?? `CATALOG_DEFAULT_TIMEOUT_MS`) ×
   *  `CATALOG_OP_TIMEOUT_MULTIPLIER`. */
  timeout_ms?: number;
  /** Per-operation read-cache TTL (ms), terminal-zero semantics; falls back
   *  to the catalog `default_cache_ttl_ms`. Validator (Invariant 7): a
   *  positive TTL is allowed ONLY on a read-tier op — write/admin/
   *  destructive must be 0 or omitted. */
  cache_ttl_ms?: number;
  /** D-165 P3.path-picker (Slice 3) — sub-resource path-scope contract. When
   *  present, the gateway enforces the call's target path against the bound
   *  connection's `subresource_path` before dispatch (`checkPathScope`),
   *  denying an out-of-scope call with `failure_mode: 'path_scope_violation'`.
   *  Absent → no path gating (whole-account access, the default). */
  path_scope?: PathScopeContract;
  /** Connection-agnostic op dispatch — OPTIONAL per-op override of the
   *  surface-level `ProviderApiSurface.result_path` (where a collection op's
   *  records array sits in the raw vendor response), LOWERED from the authoring
   *  `OperationRow.result_path` by the decomposer. The install resolver already
   *  honors the per-op override when baking the read-projection ref
   *  (`effectiveResultPath`); lowering it here lets the RUNTIME gateway's
   *  pagination follower (`followPagination`) merge pages at the SAME effective
   *  envelope the projection reads (a non-empty per-op value wins over the
   *  surface default — the same precedence). Empty/absent → inherit the surface
   *  default. Consulted only for collection (search/list) ops; first-party CRM
   *  catalogs declare none (they use the surface envelope), so this is a
   *  3rd-party-pack affordance. */
  result_path?: string;
  /** Optional operation-local pagination contract. Absent means the gateway
   *  performs exactly one upstream dispatch. Present means the gateway applies
   *  any declared page size, follows the declared cursor mechanics behind the
   *  scenes for read-tier REST operations, merges records at the effective
   *  result_path, and emits `pages_fetched` / `truncated` audit metadata. */
  pagination?: OperationPaginationSpec;
}

/** D-177 — one catalog operation's AUTHORITY-BEARING arg paths: the
 *  wire-authority baseline ∪ the op's derivable destination selectors
 *  (`path_scope.target_path_template` `{token}` names + the op's
 *  `surfaces.api.executes` binding `path_template` `{{token}}` params — both
 *  the gateway resolves from top-level args to select the TARGET resource;
 *  `editable_args` entries with `affects_target: true` — editing one
 *  re-resolves `approved_target`) ∪ the op's explicit `authority_args`
 *  declaration (the open opt-in surface; its PRESENCE gates open elsewhere —
 *  this collector only widens the set).
 *
 *  The `executes.path_template` params (`pathTemplate` arg) are authority by
 *  construction: a write/destructive op's target-record id rides the path
 *  (`PATCH /contacts/{{contact_id}}`, `DELETE /deals/{{deal_id}}`), and an op
 *  that does NOT also declare `path_scope` would otherwise leave that id
 *  uncollected — so `hash_exclude_args: ['contact_id']` would de-pin the
 *  target (a grant approved to update Alice updates Bob). The caller supplies
 *  the path template(s) via {@link operationPathTemplate} because the binding
 *  lives on the manifest's `surfaces`, not the op spec.
 *
 *  ONE source of truth, two consumers (the N.2 posture): the publish-gate
 *  validator bounds `hash_exclude_args` against exactly this set (an
 *  exclusion may never target a destination/entity selector), and the
 *  runtime open-projection walk guards exactly this set (what an exclusion
 *  may never touch IS what an open grant must pin-or-classify) — the two
 *  can never drift apart, so BOTH callers pass the same `pathTemplate`.
 *
 *  Accepts the raw JSON record shape the validator walks (defensive
 *  narrowing — a malformed field contributes nothing here and fails its own
 *  gate) as well as a typed {@link OperationSpec}. Pure. */
export const collectOperationAuthorityPaths = (
  spec: OperationSpec | Readonly<Record<string, unknown>>,
  pathTemplate?: string | readonly string[] | null,
): string[] => {
  const s = spec as Readonly<Record<string, unknown>>;
  const out = [...WIRE_AUTHORITY_ARG_PATHS];
  const ps = s.path_scope;
  if (ps && typeof ps === 'object' && !Array.isArray(ps)) {
    const template = (ps as Record<string, unknown>).target_path_template;
    if (typeof template === 'string') {
      for (const match of template.matchAll(/\{([^}]+)\}/g)) out.push(match[1]);
    }
  }
  // `surfaces.api.executes` binding path params — `{{token}}` (double-brace,
  // the binding convention) or `{token}` (tolerated). The token names the
  // top-level arg the gateway substitutes into the path; that arg selects the
  // target resource, so it is authority-bearing and never excludable.
  const templates =
    pathTemplate == null ? [] : Array.isArray(pathTemplate) ? pathTemplate : [pathTemplate];
  for (const t of templates) {
    if (typeof t !== 'string') continue;
    for (const match of t.matchAll(/\{\{?([^{}]+)\}\}?/g)) {
      const token = match[1]!.trim();
      if (token.length > 0) out.push(token);
    }
  }
  if (Array.isArray(s.editable_args)) {
    for (const entry of s.editable_args) {
      if (
        entry && typeof entry === 'object' && !Array.isArray(entry)
        && (entry as Record<string, unknown>).affects_target === true
        && typeof (entry as Record<string, unknown>).key === 'string'
      ) {
        out.push((entry as Record<string, unknown>).key as string);
      }
    }
  }
  if (Array.isArray(s.authority_args)) {
    for (const entry of s.authority_args) {
      if (typeof entry === 'string' && entry.length > 0) out.push(entry);
    }
  }
  return out;
};

/** The api-surface execution binding's `path_template` for one operation, when
 *  it declares a string one (REST / non-subscription GraphQL bindings). The
 *  `{{token}}` params are authority-bearing target selectors (D-177 N.2) — fed
 *  to {@link collectOperationAuthorityPaths} as `pathTemplate`. The binding
 *  lives at `surfaces.api.executes[operationKey]`, a manifest-level map keyed
 *  by operation id (not on the op spec), so this helper centralizes the
 *  surfaces-shape access for the validator + runtime callers. Pure; defensive
 *  narrowing — a missing/odd shape yields `undefined`. */
export const operationPathTemplate = (
  manifest: { readonly surfaces?: unknown } | null | undefined,
  operationKey: string,
): string | undefined => {
  const surfaces = manifest?.surfaces;
  const api = (surfaces as { api?: unknown } | undefined)?.api;
  const executes = (api as { executes?: unknown } | undefined)?.executes;
  if (!executes || typeof executes !== 'object') return undefined;
  const binding = (executes as Record<string, unknown>)[operationKey];
  const template = (binding as { path_template?: unknown } | undefined)?.path_template;
  return typeof template === 'string' ? template : undefined;
};

/** Result of a `checkPathScope` evaluation. `ok` drives admit/deny; the
 *  canonical paths + (resolved) target feed the gateway's
 *  `path_scope_violation` audit row. */
export interface PathScopeCheck {
  ok: boolean;
  /** Why the check failed (absent when `ok`).
   *    - `connection_not_root`       — `connection_root` policy, but the
   *                                    bound connection is path-scoped.
   *    - `not_in_scope`              — target is outside the connection's path.
   *    - `unresolved_template_token` — a template token had no matching arg
   *                                    → fail closed.
   *    - `missing_template`          — policy needs a template but none was
   *                                    declared (malformed contract). */
  reason?:
    | 'connection_not_root'
    | 'not_in_scope'
    | 'path_traversal'
    | 'unresolved_template_token'
    | 'missing_template';
  /** The connection's canonicalized `subresource_path` (default `/`). */
  connection_path: string;
  /** The canonicalized target path resolved from the template. Absent for
   *  `connection_root` and when a token was unresolved. */
  target_path?: string;
}

/** True when `target` is a STRICT descendant of `base` (both canonical). Root
 *  (`/`) is the ancestor of every non-root path; otherwise descent is a
 *  `base + '/'` prefix, so `/photos` is NOT a descendant of `/photo` (no false
 *  prefix match) and equality is not descent (`/photos` vs `/photos` → false). */
const isStrictDescendantPath = (target: string, base: string): boolean =>
  base === '/' ? target !== '/' : target.startsWith(`${base}/`);

/** True when any path segment is a dot-segment (`.` / `..`). The prefix-based
 *  descendant check is only sound on dot-free paths: `canonicalizeSubresourcePath`
 *  collapses slashes but does NOT resolve `.`/`..`, so `/photos/../private`
 *  would pass `startsWith('/photos/')` yet a downstream URL / filesystem
 *  resolves it to `/private` — outside scope (the same reason `assertUrlSafe`
 *  inspects raw URLs). A real sub-resource path never contains a `.`/`..`
 *  SEGMENT (a dotted filename like `img.jpg` is a segment `img.jpg`, not `.`),
 *  so rejecting these is fail-closed with no legitimate false positives. */
const hasDotSegment = (path: string): boolean =>
  path.split('/').some((seg) => seg === '.' || seg === '..');

/** D-165 P3.path-picker (Slice 3) — evaluate an operation's `PathScopeContract`
 *  against the caller's args + the bound connection's `subresource_path`. Pure;
 *  the gateway calls it before dispatch and denies (`path_scope_violation`)
 *  when `ok` is false. Fail-closed: a policy that needs a template but lacks
 *  one, or a template token with no matching arg, returns `ok: false`. Both
 *  paths are canonicalized via `canonicalizeSubresourcePath`; the per-op
 *  `case_insensitive` flag affects only the comparison, not storage. */
export const checkPathScope = (
  scope: PathScopeContract,
  args: Record<string, unknown>,
  connectionSubresourcePath: string | undefined,
): PathScopeCheck => {
  const connection_path = canonicalizeSubresourcePath(connectionSubresourcePath);

  // Account-level op: the connection must itself be unscoped. No template.
  if (scope.policy === 'connection_root') {
    return connection_path === '/'
      ? { ok: true, connection_path }
      : { ok: false, reason: 'connection_not_root', connection_path };
  }

  // connection_or_below | descendant_only — both need a resolved target path.
  if (!scope.target_path_template) {
    return { ok: false, reason: 'missing_template', connection_path };
  }
  let unresolved = false;
  const raw = scope.target_path_template.replace(
    /\{([^}]+)\}/g,
    (_match, token: string): string => {
      const v = args[token];
      if (v === undefined || v === null || v === '') {
        unresolved = true;
        return '';
      }
      return String(v);
    },
  );
  if (unresolved) {
    return { ok: false, reason: 'unresolved_template_token', connection_path };
  }
  const target_path = canonicalizeSubresourcePath(raw);

  // Fail closed on path traversal: a `.`/`..` segment survives canonicalization
  // and would defeat the prefix-based descendant check (`/photos/../private`
  // startsWith `/photos/`) while a downstream resolver escapes the scope.
  if (hasDotSegment(target_path)) {
    return { ok: false, reason: 'path_traversal', connection_path, target_path };
  }

  const ci = scope.canonicalization === 'case_insensitive';
  const base = ci ? connection_path.toLowerCase() : connection_path;
  const tgt = ci ? target_path.toLowerCase() : target_path;

  const ok =
    scope.policy === 'connection_or_below'
      ? tgt === base || isStrictDescendantPath(tgt, base)
      : isStrictDescendantPath(tgt, base); // descendant_only
  return ok
    ? { ok: true, connection_path, target_path }
    : { ok: false, reason: 'not_in_scope', connection_path, target_path };
};

/** P0 subset of the D-165 `OperationGroupSpec` (spec § Operation groups).
 *  The full shape (display_name, grant_default, upgrade_behavior) is P2;
 *  P0 keeps only what audit + the risk floor need. */
export interface OperationGroupSpec {
  group_id: string;
  operations: string[];
  risk_floor?: OperationRiskTier;

  // ── D-165 P2 — full group declaration (additive; validator-gated when
  //    present). ──

  /** Human label + description for the install-consent + grant UI. */
  display_name?: string;
  description?: string;
  /** Grant posture at connection enrollment. `on_after_connect` is valid
   *  only for a read-tier group (the validator rejects a non-read op in
   *  such a group — Invariant 3). Defaults to `off` when omitted. */
  grant_default?: GroupGrantDefault;
  /** How an installed grant treats operations added in a later catalog
   *  version. Defaults to `new_operations_off`. */
  upgrade_behavior?: GroupUpgradeBehavior;
}

/** P0 subset of the D-165 `ProviderDefaultPolicy` (spec § Default policy).
 *  Per-tier default that applies when an operation omits its own
 *  `approval`. A tier set to `deny` denies the call outright. User /
 *  profile overrides apply last and can only be stricter, never looser. */
export interface ProviderDefaultPolicy {
  read_default?: 'allow_after_group_grant' | 'ask';
  write_default?: 'ask' | 'deny';
  admin_default?: 'ask' | 'deny';
  destructive_default?: 'always_ask' | 'deny';
}

// ── D-165 P2 — surfaces / auth / execution-binding substrate ──────────────
//
//  The *execution* layer of a catalog: WHERE an operation actually lands.
//  P0/P1 expressed execution as `OperationSpec.delegates_to` (borrow an
//  already-shipped simple-form wrapper); P2 adds the first-class `surfaces`
//  declaration the spec calls for (spec § Surfaces (execution)). A catalog
//  declares one or more of three surfaces:
//    - `api`          — Recued calls REST/GraphQL through the D-157 gateway.
//    - `connector`    — Recued spawns / connects an external process that
//                       speaks the vendor protocol (Discord, Baileys, IMAP,
//                       CometD, MCP servers, local CLIs).
//    - `notification` — outbound notification metadata only (no inbound
//                       execution bindings); maps onto D-125's
//                       `connection.notification` channel family.
//
//  This slice lands the CONTRACT types + the strict publish-time validator
//  gates that DEPEND on the surface declaration (the "surface-dependent
//  invariants"): scope-universe coverage of every operation's
//  `required_scopes`, and the real-time-binding cache discipline (a webhook
//  / queue / push binding forces its operation's `cache_ttl_ms` to 0). The
//  runtime gateway dispatch switch that CONSUMES `surfaces.api.executes`
//  (superseding `delegates_to`) is a LATER P2 slice (spec § Runtime flow).
//
//  DEFERRED to a review-time / runtime slice (not mechanical-static, so out
//  of the publish validator's reach): the OpenAPI / GraphQL document SHA-256
//  pin + shape cross-check (the `*_source` SHAPE is gated here; the fetch is
//  not), the connector `describe()` / `tools/list` introspection match, and
//  the `ProviderSideStateDecl` vendor-sync declaration.

/** D-225 Slice 2 — one row of the pack-detail review an owner completes before
 *  a generated MCP pack is installed.
 *
 *  ⛔ `stored` and `suggested` are SEPARATE fields on purpose, and the
 *  separation is the security property. `stored` is what lands if the owner
 *  changes nothing — always the conservative floor. `suggested` is a one-click
 *  offer derived from what the SERVER claims about its own tool.
 *
 *  Collapsing them would mean a server's `readOnlyHint: true` became the stored
 *  default, so an owner clicking Save without reading would hand a third party
 *  auto-run permission — chosen by the server, with one boolean, bypassing both
 *  `confirm_risk_downgrade` and the approval floor because the owner nominally
 *  consented. Built by `mcpPackReviewRows`. */
export interface McpPackReviewRow {
  /** The pack-local op id (`<label>_<descriptor-hash-8>`). */
  op: string;
  /** The real tool name — what actually goes on the wire. */
  tool: string;
  /** The server's description, for display. */
  description?: string;
  /** ⛔ What is STORED if the owner changes nothing. Always the floor. */
  stored: { risk: 'write'; approval: 'ask' };
  /** ⚠ A one-click offer, present only when the server published a usable
   *  hint. NOT applied — the owner clicks it or it does not happen. */
  suggested?: { risk: OperationRiskTier; approval: OperationApproval };
  /** The server's own claims, for an ATTRIBUTED badge. Never authority. */
  server_says?: { read_only?: boolean; destructive?: boolean };
}

/** API transport (spec § API surface).
 *
 *  D-225 Slice 1 — `'mcp'` joins `'rest'` / `'graphql'`. MCP is a TRANSPORT
 *  here, nothing more: it decides no authority, mints no vocabulary, and the
 *  op it backs is granted, tiered, and audited exactly like a REST-backed one.
 *  The other half of the word — MCP as a DOOR that issues a tool catalog — is
 *  the inbound `mcp-server.ts` surface and is untouched by this member.
 *
 *  ⚠ Unlike its two peers, an mcp binding carries NO independent write-ness
 *  signal. A REST binding's `method` and a GraphQL document's leading keyword
 *  both cross-check the author's declared `risk_tier`
 *  (`validateApiBindingRiskConsistency`); an MCP tool NAME proves nothing, and
 *  neither does `tools/list` (its `annotations.readOnlyHint` is a server's
 *  self-report, not proof). So on this transport the author's declaration is
 *  the ONLY risk signal — which is why a D-225 Slice-2 GENERATED pack must
 *  tier conservatively rather than infer. */
export type ApiTransport = 'rest' | 'graphql' | 'mcp';
export const API_TRANSPORTS: readonly ApiTransport[] = ['rest', 'graphql', 'mcp'];
export const isApiTransport = (v: unknown): v is ApiTransport =>
  typeof v === 'string' && (API_TRANSPORTS as readonly string[]).includes(v);

/** Connection-agnostic op dispatch (NEXT-1, vendor search-builder extensibility) —
 *  the catalog-declared SEARCH DIALECT a `<crm_alias>.search` op-step is translated
 *  to. A canonical search carries vendor-NEUTRAL `CanonicalSearchArgs`
 *  (`{ limit, filter, sort }`); the install resolver translates them to the vendor
 *  query via a reviewed kernel builder selected by THIS declaration — NOT by the
 *  vendor id (so the dialect is decoupled from any one vendor: a 3rd-party CRM whose
 *  search API matches a known dialect declares it and resolves with zero new code).
 *  Two structurally-different dialects ship today:
 *    - `'hubspot_search'` — HubSpot CRM Search API v3 shape: `POST …/search` with a
 *      JSON body `{ properties, filterGroups, sorts, limit }` (operator tokens
 *      `EQ`/`CONTAINS_TOKEN`/…). Emitted as connection-api `body.*` wire-key args.
 *    - `'soql'` — Salesforce SOQL: `GET …/query?q=<SELECT … FROM … WHERE … ORDER BY
 *      … LIMIT …>`. Emitted as the `query.q` wire-key arg.
 *    - `'pipedrive_filter'` — Pipedrive list endpoints: `GET /deals` /
 *      `/persons` / `/organizations` with a bounded set of query params
 *      (`owner_id`, `status`, `updated_since`, cursor, etc.). Emitted as
 *      `query.*` wire-key args.
 *  A structurally-NOVEL search API needs a new reviewed dialect builder added to the
 *  kernel's closed set (decoupled from the vendor) — the same extension model as
 *  `WebhookExecutionBinding.signature_scheme`. All value escaping / type-checking
 *  stays in the trusted builders, so the open declaration is not an injection vector.
 *  Surface-level (every search op on a vendor speaks one dialect), authored once like
 *  `result_path`; absent → a canonical `search` fails closed. Design:
 *  internal design notes. */
export type SearchStyle = 'hubspot_search' | 'soql' | 'pipedrive_filter';
export const SEARCH_STYLES: readonly SearchStyle[] = ['hubspot_search', 'soql', 'pipedrive_filter'];
export const isSearchStyle = (v: unknown): v is SearchStyle =>
  typeof v === 'string' && (SEARCH_STYLES as readonly string[]).includes(v);

/** Connection-agnostic op dispatch (write-verb reverse projection) — the WRITE
 *  body DIALECT a canonical `<crm_alias>.{create,update}` op-step's canonical
 *  field→value body is reverse-projected to. The request-side mirror of the read
 *  projection for write verbs, selected (like `SearchStyle`) by THIS catalog
 *  declaration, not the vendor id:
 *    - `'hubspot_properties'` — HubSpot CRM write: one `body.properties` object of
 *      BARE property names (the `properties.` prefix stripped from each vendor
 *      `field_path`), scalar values coerced to strings (the inverse of the read
 *      side's G2 number-from-string coercion — HubSpot stores/compares properties
 *      as strings). Emitted as the `body.properties` wire-key arg.
 *    - `'salesforce_sobject'` — Salesforce sObject write: each vendor `field_path`
 *      a flat `body.<field>` wire-key arg, values type-preserved (the sObject REST
 *      body is typed JSON). Emitted as `body.<field>` wire-key args.
 *    - `'pipedrive_json'` — Pipedrive CRM write: each vendor `field_path` is a
 *      flat top-level JSON body field (`body.title`, `body.value`, etc.),
 *      values type-preserved.
 *  A structurally-NOVEL write body needs a new reviewed dialect builder added to
 *  the kernel's closed set (decoupled from the vendor) — the same extension model
 *  as `SearchStyle` / `WebhookExecutionBinding.signature_scheme`. `delete` (a bare
 *  record selector, no body) needs no dialect. Surface-level, authored once like
 *  `search_style`; absent → a canonical `create`/`update` fails closed (other verbs
 *  unaffected). Design:
 *  internal design notes §C. */
export type WriteStyle = 'hubspot_properties' | 'salesforce_sobject' | 'pipedrive_json';
export const WRITE_STYLES: readonly WriteStyle[] = ['hubspot_properties', 'salesforce_sobject', 'pipedrive_json'];
export const isWriteStyle = (v: unknown): v is WriteStyle =>
  typeof v === 'string' && (WRITE_STYLES as readonly string[]).includes(v);

/** Connection-agnostic op dispatch (pagination) — the catalog-declared PAGINATION
 *  DIALECT the gateway follows a collection (`search`/`list`) op's vendor cursor
 *  with. A single vendor search call returns ONE page; the gateway's cursor-follow
 *  loop (`followPagination`, the runtime mirror of the read projection / search
 *  derivation) walks every page and merges the records arrays so the recipe's
 *  projection sees the FULL result set — not a silently-truncated first page. Two
 *  structurally-different dialects ship today (each its own follower; selected by
 *  THIS declaration, NOT the vendor id — a 3rd-party CRM whose pagination matches a
 *  shipped dialect declares it and paginates with zero new code):
 *    - `'hubspot_after'` — HubSpot CRM Search v3 cursor: the response carries the
 *      next-page token at `paging.next.after`; the follower re-POSTs the SAME
 *      `/search` endpoint with `body.after = <token>` until the token is absent.
 *    - `'soql_query_locator'` — Salesforce SOQL query locator: the response carries
 *      a relative next-page PATH at `nextRecordsUrl` (+ a terminal `done` flag); the
 *      follower GETs that path (a path-swap — the binding's `path_template` +
 *      `query.q` are dropped) until `done === true` / no `nextRecordsUrl`. The
 *      vendor-returned path is validated root-relative before it is followed
 *      (`followPagination` security guard).
 *    - `'pipedrive_cursor'` — Pipedrive v2 cursor: the response carries the next
 *      token at `additional_data.next_cursor`; the follower replays the same list
 *      request with `query.cursor = <token>`.
 *  A structurally-NOVEL pagination scheme needs a new reviewed follower added to the
 *  gateway's closed set (decoupled from the vendor) — the same extension model as
 *  `SearchStyle` / `WriteStyle` / `WebhookExecutionBinding.signature_scheme`. The
 *  follow loop is bounded by `PAGINATION_MAX_RECORDS` + `PAGINATION_MAX_PAGES` so a
 *  large result set (or a misbehaving cursor) can never run unbounded. Surface-level
 *  (a vendor's collection endpoints all paginate the same way), authored once like
 *  `result_path` / `search_style`; absent → the gateway returns the single first
 *  page (no follow). Design:
 *  internal design notes. */
export type PaginationStyle = 'hubspot_after' | 'soql_query_locator' | 'pipedrive_cursor';
export const PAGINATION_STYLES: readonly PaginationStyle[] = ['hubspot_after', 'soql_query_locator', 'pipedrive_cursor'];
export const isPaginationStyle = (v: unknown): v is PaginationStyle =>
  typeof v === 'string' && (PAGINATION_STYLES as readonly string[]).includes(v);

/** Connection-agnostic op dispatch (pagination) — the safety ceilings the gateway's
 *  cursor-follow loop is bounded by, under the WALK-ALL search semantics (a canonical
 *  `search`'s `limit` is a per-page size HINT, not a total cap — see
 *  `CanonicalSearchArgs.limit`). The follower walks pages until the vendor stops
 *  returning a cursor OR one of these caps is hit, whichever comes first:
 *    - `PAGINATION_MAX_RECORDS` — the total accumulated records ceiling. The
 *      canonical search digest/view use cases want "all matches", but a recipe must
 *      never pull an unbounded warehouse-scale set into a run; 1000 is generous for
 *      a digest yet bounded. The Salesforce SOQL builder also emits `LIMIT
 *      <this>` so the vendor caps the set at the source (SF has no page-size knob).
 *    - `PAGINATION_MAX_PAGES` — a hard page-count cap, defense against a misbehaving
 *      / adversarial cursor that never terminates (each page is one upstream call).
 *      At the HubSpot per-page max of 100, 25 pages already reaches the record
 *      ceiling; the page cap is the looser of the two for normal data and only binds
 *      a pathological tiny-page cursor.
 *  When a ceiling truncates the walk the gateway records it (`pages_fetched` on the
 *  audit row + a truncation flag) — never a silent cap. */
export const PAGINATION_MAX_RECORDS = 1000;
export const PAGINATION_MAX_PAGES = 25;

/** Auth scheme discriminator (spec § API surface `AuthSpec`). */
export type AuthKind = 'oauth2' | 'api_key' | 'signed_request' | 'none';
export const AUTH_KINDS: readonly AuthKind[] = ['oauth2', 'api_key', 'signed_request', 'none'];
export const isAuthKind = (v: unknown): v is AuthKind =>
  typeof v === 'string' && (AUTH_KINDS as readonly string[]).includes(v);

/** OAuth2 flow (spec § API surface `OAuth2Spec`). */
export type OAuth2Flow =
  | 'authorization_code' | 'authorization_code_pkce' | 'client_credentials';
export const OAUTH2_FLOWS: readonly OAuth2Flow[] = [
  'authorization_code', 'authorization_code_pkce', 'client_credentials',
];

/** Where the OAuth redirect URL comes from (spec § API surface). */
export type CallbackUrlStrategy = 'pro_static' | 'byo_domain' | 'manual';
export const CALLBACK_URL_STRATEGIES: readonly CallbackUrlStrategy[] = [
  'pro_static', 'byo_domain', 'manual',
];

/** Scope delimiter the provider expects on the wire (space or comma). */
export type OAuthScopeSeparator = ' ' | ',';

/** One issued OAuth token type (Slack bot/user/app_level, etc.) and the
 *  closed scope universe it can carry. */
export interface OAuth2TokenType {
  label: string;
  available_scopes: string[];
  required_for_operations?: 'all' | string[];
}

export interface OAuth2Spec {
  kind: 'oauth2';
  flow: OAuth2Flow;
  authorize_url: string;
  token_url: string;
  refresh_supported: boolean;
  scope_separator: OAuthScopeSeparator;
  pkce_required?: boolean;
  callback_url_strategy: CallbackUrlStrategy;
  /** Per-token-type scope universes. The validator's scope-coverage gate
   *  (spec § API-surface gates) checks every operation's `required_scopes`
   *  against the UNION of these. */
  token_types: Record<string, OAuth2TokenType>;
}

/** One API-key slot (Stripe pk_/sk_/rk_, etc.). `available_scopes` is
 *  optional — a slot that omits it is treated as unconstrained. */
export interface ApiKeySlot {
  label: string;
  header_name?: string;
  prefix?: string;
  query_param?: string;
  available_scopes?: string[];
  required_for_operations?: 'all' | string[];
}

export interface ApiKeySpec {
  kind: 'api_key';
  key_slots: Record<string, ApiKeySlot>;
}

export interface SignedRequestSpec {
  kind: 'signed_request';
  signing_scheme: 'aws_sigv4' | 'azure_sas' | 'gcs_hmac' | string;
  signing_material_fields: string[];
}

export interface NoAuthSpec { kind: 'none'; }

export type AuthSpec = OAuth2Spec | ApiKeySpec | SignedRequestSpec | NoAuthSpec;

/** REST HTTP verb (spec § API surface `RestExecutionBinding`). */
export type RestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const REST_METHODS: readonly RestMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** GraphQL operation type (spec § API surface `GraphQLExecutionBinding`). */
export type GraphQLOperationType = 'query' | 'mutation' | 'subscription';
export const GRAPHQL_OPERATION_TYPES: readonly GraphQLOperationType[] = [
  'query', 'mutation', 'subscription',
];

/** Queue substrate for a `QueueSubscriptionBinding`. */
export type QueueKind = 'sns_sqs' | 'gcp_pubsub' | 'azure_servicebus';
export const QUEUE_KINDS: readonly QueueKind[] = ['sns_sqs', 'gcp_pubsub', 'azure_servicebus'];

/** D-165 RUNTIME — per-queue-kind ceiling on a `QueueSubscriptionBinding`'s
 *  single-receive `poll_timeout_ms` (the long-poll wait for one batch, NOT the
 *  lifetime of the subscription). The validator rejects a binding whose
 *  `poll_timeout_ms` exceeds its kind's cap. Two provenances:
 *    - `sns_sqs` — AWS-documented HARD max: SQS `ReceiveMessage.WaitTimeSeconds`
 *      ≤ 20s, so 20_000 ms. A larger value is rejected by AWS at call time;
 *      catching it at publish turns a runtime failure into a review failure.
 *    - `gcp_pubsub` / `azure_servicebus` — Recued resource-discipline ceiling,
 *      not an invented vendor limit. Neither vendor pins a crisp universal
 *      single-receive max the way SQS does (Pub/Sub streaming pull is a
 *      different model; Azure's SDK `maxWaitTime` defaults to 60s and is
 *      caller-set), so the cap reflects Recued's own bound — no single
 *      blocking receive holds a worker longer than 60s (matches
 *      `CATALOG_REST_TIMEOUT_SOFT_CAP_MS`). */
export const QUEUE_POLL_TIMEOUT_CAP_MS: Record<QueueKind, number> = {
  sns_sqs: 20_000,
  gcp_pubsub: 60_000,
  azure_servicebus: 60_000,
};

/** Discriminator over the API execution-binding union. */
export type ApiExecutionBindingKind =
  | 'rest' | 'graphql' | 'mcp' | 'webhook_subscription' | 'queue_subscription' | 'push_channel';
export const API_EXECUTION_BINDING_KINDS: readonly ApiExecutionBindingKind[] = [
  'rest', 'graphql', 'mcp', 'webhook_subscription', 'queue_subscription', 'push_channel',
];
export const isApiExecutionBindingKind = (v: unknown): v is ApiExecutionBindingKind =>
  typeof v === 'string' && (API_EXECUTION_BINDING_KINDS as readonly string[]).includes(v);

/** The binding kinds that deliver REAL-TIME events rather than pollable
 *  reads. The validator forces `cache_ttl_ms: 0` on any operation bound to
 *  one of these, regardless of its risk tier (spec § Cache-TTL gates — the
 *  surface-dependent half of Invariant 7). Caching a subscription stream
 *  would replay stale events. */
export const REALTIME_API_BINDING_KINDS: readonly ApiExecutionBindingKind[] = [
  'webhook_subscription', 'queue_subscription', 'push_channel',
];
export const isRealtimeApiBindingKind = (v: unknown): boolean =>
  typeof v === 'string' && (REALTIME_API_BINDING_KINDS as readonly string[]).includes(v);

export interface RestExecutionBinding {
  kind: 'rest';
  method: RestMethod;
  path_template: string;
  /** D-165 RUNTIME — static query params baked into the binding: the fixed
   *  `query.*` wire bits the P1 delegate wrappers carried (e.g. HubSpot
   *  `deal.read`'s canonical property list). The gateway folds each entry
   *  into the connection-api call as `query.<k>`. Authoritative — caller
   *  `args` compose with these but the binding owns the method/path/connection
   *  triple, so a recipe cannot redirect a read to a write endpoint. */
  static_query?: Record<string, string>;
  /** D-182 (CRM Tier-P, decision-b) — the `static_query` keys whose value is a
   *  comma-separated LIST that a caller `query.<k>` arg UNIONS with (deduped,
   *  static defaults first) instead of being clobbered by the static value. The
   *  vendor-raw read ops (`recued-core.<vendor>.<entity>.read`) declare the
   *  vendor's field-select param here (`["properties"]` for HubSpot,
   *  `["fields"]` for Salesforce) so a recipe can request EXTRA / custom vendor
   *  fields on top of the binding's default set — the "pack owns how a
   *  recipe-named property maps into the request query" half. Every other
   *  `static_query` key stays authoritative (clobber), so the binding still owns
   *  the method/path/connection triple and any scoping filter. */
  merge_query?: string[];
  /** D-165 RUNTIME — static request headers baked into the binding, folded as
   *  `header.<k>`. The connection adapter injects auth AFTER these, so a
   *  binding (or caller arg) can never smuggle an Authorization value. */
  static_headers?: Record<string, string>;
  request_schema?: unknown;
  response_schema?: unknown;
  /** Opt-in exact JSON request serialization for top-level integer fields.
   *  Callers provide decimal strings (so JavaScript never rounds them); the
   *  connection adapter emits those selected values as unquoted JSON integer
   *  literals. An `[]` suffix applies the rule to every array item. */
  request_json?: RestRequestJsonSpec;
  /** Opt-in JSON response normalization for vendors whose integer identifiers
   *  may exceed JavaScript's exact-number range. Ordinary REST bindings keep
   *  the native `Response.json()` behavior. With this declaration, integer
   *  literals outside `Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER` are
   *  returned as their exact decimal strings; safe integers, floats, exponent
   *  values, booleans, and strings keep their normal JSON types. */
  response_json?: RestResponseJsonSpec;
  /** SMB-finance slice 3 (storage-gdrive) — capture the HTTP response BODY as
   *  a `data.file` ref instead of JSON-parsing it. The REST counterpart to the
   *  CLI `output_capture`: when set, the connection adapter reads the raw
   *  response bytes (`arrayBuffer`) rather than parsing JSON/text, and the
   *  gateway ingests them into the CAS (`data.file.received`) and returns
   *  `{ file_ref, filename, mime_type, status }` — the bytes transit server
   *  memory only and NEVER land in an op-step value or the audit (D-172 content
   *  isolation). Read-tier GET ops ONLY; an op with `response_capture` declares
   *  no `output` mapping (the validator enforces both — raw bytes can never be
   *  projected into a recipe field). */
  response_capture?: RestResponseCaptureSpec;
  /** D-216 / D-217 — the op's upload declaration, carried onto the RUNTIME
   *  binding.
   *
   *  ⛔ **This field states a behaviour that was already happening by
   *  accident.** `HttpOperationBind.upload` (`op-model.ts`, where D-216
   *  declared it) has no runtime consumer at all — only the authoring
   *  validator reads it. Yet the decomposer carries the whole authored `bind`
   *  object through with a cast (`decomposer.ts` — `op.bind as unknown as
   *  ApiExecutionBinding`), so `upload` HAS been arriving here untyped since
   *  D-216. Verified against the shipped `social-publishing` pack.
   *
   *  🔑 D-217's chunked walk must READ this at dispatch (§ 9.2 — for a chunked
   *  op the declaration IS the program), so it cannot rest on an untyped rider
   *  that a future sanitizing install path would drop silently, taking the
   *  whole feature with it. Typed here, and the pass-through is pinned by a
   *  decomposer test rather than assumed. */
  upload?: HttpUploadSpec;
  /** D-192 CORE #8a — the EXACT OpenAPI document path this op proves against,
   *  used ONLY by the publish-time prover when `path_template` differs from the
   *  doc in a way the surface `path_alias` can't express (an interior optional
   *  segment — azure-devops `/{organization}/{project}/{team}/_apis/wit/wiql`
   *  vs the wire's team-less path). Overrides the alias for this op; the runtime
   *  still calls `path_template`. */
  openapi_path?: string;
  /** Documentary-proof-only expansion for a documented composite path
   *  parameter. Each key names one parameter in `openapi_path`; its value is the
   *  ordered run of wire-path argument names that replaces that single segment.
   *  CircleCI, for example, documents `{project-slug}` while accepting the
   *  slash-delimited `provider/organization/project` value as three wire
   *  segments. The prover requires an exact literal/parameter match after the
   *  declared expansion; runtime dispatch still uses `path_template`. */
  openapi_path_param_expansions?: Record<string, string[]>;
  /** D-192 (azure-devops WIQL) — static request-BODY fields baked into the
   *  binding, folded by the gateway as authoritative `body.<k>` wire args.
   *  Each key is a LITERAL top-level JSON property name: the connection
   *  adapter strips the `body.` prefix and JSON-encodes the remainder as-is
   *  (`extractDotPrefix` — the same flat semantics caller `body.*` args get),
   *  so a dotted key would emit a literal `"a.b"` property, not a nested
   *  tree — the validator rejects dotted keys (widen deliberately if a
   *  literal-dotted-property vendor ever shows up; codex-review fold). The
   *  body-side sibling of `static_query`/`static_headers`: a query-DSL vendor
   *  whose fixed filter rides the POST body (Azure DevOps WIQL) bakes it here
   *  the way a GET vendor bakes JQL into `static_query` — and the graphql
   *  binding already bakes its static `query` into `body.query` at dispatch.
   *  Authoritative: a same-named caller `body.<k>` is clobbered, and a caller
   *  `body_raw` is STRIPPED whenever static_body is declared (the
   *  connection adapter gives `body_raw` precedence over composed `body.*`,
   *  so an un-stripped caller value would replace the binding-owned body
   *  wholesale). An explicitly empty object emits literal `{}` only when no
   *  dynamic `body.*` field is present; this represents a required JSON body
   *  whose documented fields are all optional. String values only (the
   *  `static_query` posture); a typed
   *  need widens deliberately. Body-carrying methods (POST/PUT/PATCH) only —
   *  the validator rejects it on GET/DELETE. */
  static_body?: Record<string, string>;
  /** Names of the connection's `body_field` auth credentials this operation
   *  wants injected into its JSON request body. Absent or empty = inject
   *  nothing, which is what every operation authored before this said.
   *
   *  ⛔ **OPT-IN PER OPERATION, because injecting everywhere is measurably
   *  wrong.** `sandbox.plaid.com` answers `UNKNOWN_FIELDS` to an unexpected
   *  body key, and Plaid's own `/link/token/create` and `/categories/get` take
   *  no `access_token` — so a connection-wide injection would break the
   *  enrollment flow of the vendor this exists for. Headers can be sent
   *  blanket-wide; body fields cannot.
   *
   *  ⚠ Names only. The VALUES live in the owner's encrypted connection record
   *  and never appear in a manifest, an arg, or an audit row. A name here that
   *  the connection does not carry FAILS the call rather than sending the
   *  request without the credential — a silently-missing credential surfaces
   *  as the vendor's generic auth error, which sends the owner to re-check a
   *  key that was never wrong.
   *
   *  ⚠ Body-carrying methods only, and the body must be JSON — a form-encoded
   *  or multipart body has no place to put one, and the adapter refuses rather
   *  than guessing an encoding. */
  auth_body_fields?: ReadonlyArray<string>;
}

/** SMB-finance slice 3 — REST response-body → `data.file` ref capture spec.
 *  Mirrors `CliOutputCaptureSpec` on the HTTP side. */
export interface RestResponseCaptureSpec {
  /** v1 captures the response body as a `data.file` ref. */
  kind: 'file_ref';
  /** mime_type fallback stamped on the ingested record when the response
   *  carries no usable `Content-Type` (server-detected type wins when present). */
  mime_type?: string;
  /** Where the ingested record's display filename comes from:
   *    - `header`  → the response `Content-Disposition` filename,
   *    - `static`  → a fixed binding value,
   *    - `arg`     → a `{token}` resolved from the op's args (e.g. a filename
   *                  the caller carried from a prior `file.list`). */
  filename_source:
    | { kind: 'header' }
    | { kind: 'static'; value: string }
    | { kind: 'arg'; arg: string };
}

/** Lossless integer handling for a REST JSON response. Closed v1 shape: the
 *  only supported normalization is exact decimal-string preservation for
 *  otherwise-unsafe integer literals. */
export interface RestResponseJsonSpec {
  unsafe_integers: 'string';
}

/** Exact decimal-string → JSON-integer request serialization. Field names are
 *  top-level body keys; `person_id` selects a scalar and `assignee_ids[]`
 *  selects every item of an array. */
export interface RestRequestJsonSpec {
  decimal_integer_fields: string[];
}

export interface GraphQLExecutionBinding {
  kind: 'graphql';
  operation_type: GraphQLOperationType;
  /** D-165 RUNTIME — POST target for the GraphQL document, relative to the
   *  connection's base_url (e.g. `/graphql`). GraphQL has a single endpoint, so
   *  every graphql binding in a catalog typically repeats the same value;
   *  declared per-binding for symmetry with `RestExecutionBinding.path_template`
   *  and so the gateway builds the connection-api `path` from the binding alone.
   *  Required — the gateway POSTs `{ query, variables }` here. */
  endpoint_path: string;
  query: string;
  variables_schema?: unknown;
  result_schema?: unknown;
  /** D-192 Gate E′ (GraphQL response envelope) — dot-path WITHIN the GraphQL
   *  response body (the connection-api `result` envelope) to THIS op's data
   *  payload. Default `'data'` (the GraphQL-spec envelope). The gateway's
   *  graphql response adapter reads the payload here for the FAIL-WHEN-NULL
   *  gate: GraphQL returns HTTP 200 even when the operation failed, so the
   *  connection-api status-only classifier can't see it — a null/absent payload
   *  is a FAILED op (the adapter surfaces the response `errors[]` and fails the
   *  step) rather than a silent empty success. Partial data (a present-but-nulls
   *  payload) is tolerated: the recipe sees the nulls and any `errors` stay on
   *  `result.errors`. The value ALSO names where a recipe's install-time
   *  projection reads its fields — default → `{{step.<id>.result.data.<field>}}`;
   *  `''` for data-at-root (`result.<field>`); `'viewer'` for a custom envelope
   *  (`result.viewer.<field>`). No hoist — the payload passes through unchanged
   *  on success. */
  result_data_path?: string;
}

/** D-225 Slice 1 — an MCP tool call, declared. The transport peer of
 *  `RestExecutionBinding` / `GraphQLExecutionBinding`: the gateway translates
 *  it into a `connection_kind: 'mcp'` dispatch (`tool` + `args`), the
 *  `connection.mcp` handler speaks JSON-RPC `tools/call`, and the op above it
 *  is an ordinary contract-granted operation.
 *
 *  🔑 **`tool` lives on the BINDING, so it is never caller data.** This is the
 *  whole security difference from the raw `connection-mcp-read` / `-write`
 *  path, where the tool name arrives as recipe input and needs a runtime
 *  anti-spoof gate to stop a read-tier wrapper from naming a write tool. Here
 *  the caller's args are quarantined into the nested `args` object and cannot
 *  reach the top-level dispatch keys at all — the property is STRUCTURAL, not
 *  a check that can be forgotten. A recipe cannot redirect a read op to a
 *  write tool for the same reason it cannot redirect a REST GET to a POST:
 *  the binding owns the call target.
 *
 *  ⚠ No `static_arguments` sibling to `RestExecutionBinding.static_query` /
 *  `static_body`. Nothing needs one yet — a generated pack derives its ops
 *  from `tools/list`, which declares no fixed argument values — and an unused
 *  field is one a corpus learns to copy. Widen deliberately if a real vendor
 *  needs it. */
export interface McpExecutionBinding {
  kind: 'mcp';
  /** the MCP tool name invoked via JSON-RPC `tools/call`. Binding-owned. */
  tool: string;
  /** JSON Schema for the tool's arguments — the MCP `inputSchema`, carried
   *  verbatim. Informational at this slice (the same posture as
   *  `GraphQLExecutionBinding.variables_schema`); D-225 Slice 2 hashes it as
   *  part of the tool DESCRIPTOR so a mutated tool re-asks instead of
   *  inheriting its grant. */
  arguments_schema?: unknown;
  /** JSON Schema for the tool's result, when the server publishes one
   *  (`outputSchema`). Informational. */
  result_schema?: unknown;
}

interface WebhookExecutionBindingBase {
  kind: 'webhook_subscription';
  handshake?: 'slack_url_verification' | 'graph_validation_token' | 'none';
}

/** D-201 Slice 0 — new catalog declarations select trusted verifier code by a
 * registered profile id.  The legacy free-string branch remains parseable for
 * already-published catalogs during migration; it does not enroll a D-201
 * ingress and must not be used for new authoring. */
export type WebhookExecutionBinding = WebhookExecutionBindingBase & (
  | {
      profile_id: WebhookProfileId;
      /** Optional only as a migration breadcrumb when a catalog temporarily
       * carries both forms.  Runtime profile selection never reads it. */
      signature_scheme?: string;
      /** Freshness/replay policy belongs to trusted profile code. */
      retry_tolerance_window_seconds?: never;
    }
  | {
      profile_id?: never;
      signature_scheme: 'hmac_sha256_v1' | 'hmac_sha256_timestamp' | 'hubspot_v3'
                      | 'graph_token' | 'stripe' | 'slack_signing_secret' | string;
      /** Legacy-only compatibility field; new profile bindings cannot set it. */
      retry_tolerance_window_seconds?: number;
    }
);

export interface QueueSubscriptionBinding {
  kind: 'queue_subscription';
  queue_kind: QueueKind;
  subscription_metadata: Record<string, unknown>;
  poll_timeout_ms?: number;
}

export interface PushChannelBinding {
  kind: 'push_channel';
  channel_lifecycle_methods: {
    create: string;
    renew?: string;
    delete: string;
  };
}

export type ApiExecutionBinding =
  | RestExecutionBinding
  | GraphQLExecutionBinding
  | McpExecutionBinding
  | WebhookExecutionBinding
  | QueueSubscriptionBinding
  | PushChannelBinding;

/** Pinned external schema document (OpenAPI / GraphQL). The SHAPE is gated at
 *  publish — `url` must be https (localhost dev exception) and `sha256` must be
 *  a 64-char lowercase hex digest (`CATALOG_SCHEMA_SOURCE_SHA256_REGEX`). The
 *  structural cross-check of declared REST operations against the fetched
 *  OpenAPI document is `crossCheckCatalogOpenApi` (pure; the marketplace
 *  publish pipeline fetches + hash-verifies the document, then feeds it in).
 *  The network fetch + SHA-256 computation stay OUT of the portable validator
 *  (no IO substrate); GraphQL document-validation remains deferred (needs a
 *  GraphQL parser) — spec § API surface "OpenAPI / GraphQL schema as
 *  cross-check". */
/** D-192 CORE #8a — reconcile a pack's WIRE op paths (relative to `http.base`)
 *  with the pinned OpenAPI document's path KEYS when they differ by a
 *  DOCUMENTED, deterministic transform. Applied by the publish-time prover
 *  (`crossCheckCatalogOpenApi`) ONLY — the runtime keeps calling `path_template`
 *  verbatim; this never changes what is called, only what PROVES. Deterministic
 *  + rigorous: a wrong alias still fails the gate (nothing is fuzzy-matched).
 *  For a structural one-off an alias can't express (an interior optional path
 *  segment), a per-op `RestExecutionBinding.openapi_path` overrides instead. */
export interface OpenApiPathAlias {
  /** A gateway/proxy prefix the WIRE path carries that the doc omits — STRIPPED
   *  from the wire path before matching (jira `/ex/jira/{{cloud_id}}`). Brace
   *  params collapse positionally, same as path matching. */
  wire_prefix?: string;
  /** A base-path the DOC's path keys carry that the wire base URL absorbs —
   *  PREPENDED to the wire path before matching (zendesk `/api/v2`, whose
   *  `http.base` ends `…/api/v2`). */
  doc_base?: string;
  /** A format suffix the WIRE path carries that the doc omits — STRIPPED from
   *  the wire path before matching (zendesk `.json`). */
  strip_suffix?: string;
}

export interface SchemaSourceRef {
  url: string;
  sha256: string;
  /** D-192 CORE #8a — OPENAPI ONLY: reconcile wire↔doc path divergence at
   *  publish-time op-proof (ignored on graphql / google_discovery pins). */
  path_alias?: OpenApiPathAlias;
}

/** D-165 RUNTIME — `SchemaSourceRef.sha256` digest format: 64 lowercase hex
 *  chars (mirrors `WEBCLIENT_BUNDLE_SHA256_REGEX`). The validator checks the
 *  format only; the caller computes + matches the hash of the fetched
 *  document (the validator does no IO/crypto). */
export const CATALOG_SCHEMA_SOURCE_SHA256_REGEX = /^[a-f0-9]{64}$/;

export interface ProviderApiSurface {
  transport: ApiTransport;
  default_base_url: string;
  auth: AuthSpec;
  executes: Record<string, ApiExecutionBinding>;
  openapi_source?: SchemaSourceRef;
  graphql_schema_source?: SchemaSourceRef;
  /** D-192 P2 — pinned Google Discovery document
   *  (`discovery#restDescription`), the official machine-readable
   *  contract format Google publishes instead of OpenAPI. Same
   *  url/sha256 pin discipline as `openapi_source`; the structural
   *  cross-check of declared REST operations against the fetched
   *  document is `crossCheckCatalogGoogleDiscovery` (pure; the
   *  marketplace publish pipeline fetches + hash-verifies + feeds it
   *  in). Admitted for `work_entity_sources`
   *  `contract_source.kind: 'google_discovery'` (owner decision
   *  2026-07-01 — the P1b Google-Discovery fork). */
  google_discovery_source?: SchemaSourceRef;
  /** Connection-agnostic op dispatch (slice 2) — the surface-level default
   *  response-envelope key where a collection (search/list) op's records array
   *  sits in the raw vendor response (HubSpot `{ results: [...] }` → `results`;
   *  Salesforce SOQL `{ records: [...] }` → `records`). A transport/surface
   *  property (every REST collection endpoint on a vendor uses the same key),
   *  authored once like `transport` / `default_base_url`. Consulted only for
   *  collection-returning ops; a per-op `OperationRow.result_path` overrides it.
   *  Absent (and no per-op override) → the response IS the array (bare array at
   *  root). Read by the install resolver to project op results to canonical
   *  fields. Design: internal design notes. */
  result_path?: string;
  /** Connection-agnostic op dispatch (NEXT-1) — the search DIALECT a canonical
   *  `<crm_alias>.search` op-step's vendor-neutral args are translated to (HubSpot
   *  filterGroups JSON body / Salesforce SOQL). The install resolver selects the
   *  reviewed query builder by THIS declaration, not by the vendor id — so a
   *  3rd-party CRM whose search API matches a shipped dialect declares it and its
   *  `search` resolves with zero new code; absent → a canonical `search` fails
   *  closed (other verbs are unaffected). Surface-level (one dialect per vendor),
   *  authored once like `result_path`. See `SearchStyle`. */
  search_style?: SearchStyle;
  /** Connection-agnostic op dispatch (write-verb reverse projection) — the WRITE
   *  body DIALECT a canonical `<crm_alias>.{create,update}` op-step's canonical
   *  body is reverse-projected to (HubSpot `body.properties` object / Salesforce
   *  flat sObject fields). Selected by THIS declaration, not the vendor id — so a
   *  3rd-party CRM whose write API matches a shipped dialect declares it and its
   *  writes resolve with zero new code; absent → a canonical `create`/`update`
   *  fails closed (`delete` carries no body, so it needs none). Surface-level, one
   *  dialect per vendor, authored once like `search_style`. See `WriteStyle`. */
  write_style?: WriteStyle;
  /** Connection-agnostic op dispatch (pagination) — the PAGINATION DIALECT the
   *  gateway follows a collection op's vendor cursor with, walking every page and
   *  merging records at `result_path` so the recipe sees the full result set (not a
   *  silently-truncated first page). Selected by THIS declaration, not the vendor id
   *  — a 3rd-party CRM whose pagination matches a shipped dialect declares it and
   *  paginates with zero new code; absent → the gateway returns the single first page
   *  (no follow). Surface-level, one dialect per vendor, authored once like
   *  `search_style`. Bounded by `PAGINATION_MAX_RECORDS` / `PAGINATION_MAX_PAGES`.
   *  See `PaginationStyle`. */
  pagination_style?: PaginationStyle;
}

/** Connector transport (spec § Connector surface `runtime.transport`). */
export type ConnectorTransport = 'stdio' | 'unix_socket' | 'http_local' | 'websocket_local';
export const CONNECTOR_TRANSPORTS: readonly ConnectorTransport[] = [
  'stdio', 'unix_socket', 'http_local', 'websocket_local',
];

/** Connector wire protocol (spec § Connector surface `runtime.wire_protocol`).
 *  `cli_invocation` binds to `CliMethodBinding`; everything else binds to
 *  `ConnectorMethodBinding` — the validator enforces the match. */
export type ConnectorWireProtocol =
  | 'mcp' | 'custom_jsonrpc' | 'custom_proprietary' | 'cli_invocation';
export const CONNECTOR_WIRE_PROTOCOLS: readonly ConnectorWireProtocol[] = [
  'mcp', 'custom_jsonrpc', 'custom_proprietary', 'cli_invocation',
];
export const isConnectorWireProtocol = (v: unknown): v is ConnectorWireProtocol =>
  typeof v === 'string' && (CONNECTOR_WIRE_PROTOCOLS as readonly string[]).includes(v);

/** Connector auth method at connect time (spec § Connector surface). */
export type ConnectorAuthMethod =
  | 'qr_scan' | 'oauth_handoff' | 'api_key_entry'
  | 'device_pairing' | 'token_paste' | 'none';
export const CONNECTOR_AUTH_METHODS: readonly ConnectorAuthMethod[] = [
  'qr_scan', 'oauth_handoff', 'api_key_entry', 'device_pairing', 'token_paste', 'none',
];

export type ReconnectPolicy = 'auto' | 'manual_only';
export const RECONNECT_POLICIES: readonly ReconnectPolicy[] = ['auto', 'manual_only'];

/** Connector execution-binding discriminator. */
export type ConnectorExecutionBindingKind = 'method_call' | 'cli_invocation';
export const CONNECTOR_EXECUTION_BINDING_KINDS: readonly ConnectorExecutionBindingKind[] = [
  'method_call', 'cli_invocation',
];

export type CliStdinHandling = 'none' | 'pipe_args' | 'pipe_body';
export const CLI_STDIN_HANDLINGS: readonly CliStdinHandling[] = ['none', 'pipe_args', 'pipe_body'];

/** D-185 — the realized SHAPE of a cli/service op's output, and (Slice 3) the
 *  SOLE output declaration on a `cli_invocation` bind — it subsumes the retired
 *  `out` / `stdout_handling` / `output_capture.kind` trio. The executor derives
 *  stdout capture from it: a VALUE shape (`text`/`json`/`jsonl`) captures stdout
 *  (`text` keeps the raw string; `json`/`jsonl` parse it into an object/array the
 *  next step consumes transparently — the value resolver + every transform/guard
 *  stay pure in-memory fast-path, D-181 §3 / D-177); `ref` discards stdout and
 *  hands back a `data.file` (`cas`) / `temp` handle (requires an `output_capture`
 *  for the `dir_arg`+`mime_type`); an OMITTED shape is exit-code-only (stdout
 *  discarded, no file). Op-intrinsic (the tool's output format), never
 *  recipe-overridable (D-185 §2). */
export type CliOutputShape = 'ref' | 'text' | 'json' | 'jsonl';
export const CLI_OUTPUT_SHAPES: readonly CliOutputShape[] = [
  'ref', 'text', 'json', 'jsonl',
];

/** D-185 Slice 2 — WHERE a `shape: 'ref'` cli op's output file lives. `cas`
 *  ingests the produced file into `data.file.received` (durable, content-
 *  addressed, Gateway-gated) and surfaces a bare `record_id` string as
 *  `result.file_ref` (today's behaviour). `temp` keeps the file at a run-scoped
 *  path (created under the OS temp root, cleaned in a `finally` at run end,
 *  never entering the durable store) and surfaces a `TempFileRef` object — the
 *  throwaway intermediate of a local pipe (the ffmpeg→whisper case). The
 *  framework default is `temp` (D-185 §2, firmed 2026-06-18). A durable output
 *  must explicitly declare `storage: 'cas'` or be kept by a later
 *  `core.storage.file.persist` step. Meaningful only for a ref-producing op
 *  (`output_capture` present); ignored on a stdout op. */
export type CliOutputStorage = 'cas' | 'temp';
export const CLI_OUTPUT_STORAGES: readonly CliOutputStorage[] = ['cas', 'temp'];

/** D-185 Slice 2 — the backing-tagged value an op surfaces as `result.file_ref`
 *  when `storage: 'temp'`. ASYMMETRIC with the `cas` backing (owner decision
 *  2026-06-18): a `cas` ref stays a bare `record_id` string (a durable,
 *  displayable, persistable handle every existing recipe already templates as a
 *  string), so ONLY the run-scoped `temp` OUTPUT backing carries this object.
 *  The ai-* doc-part realization (`resolveAiFileRef`) branches between a bare
 *  CAS string and this temp path; cli `input_materialize` additionally accepts
 *  the input-only `PinnedCasFileRef` carrier below. A `temp` ref is NOT a
 *  `data.file` row and carries no
 *  separate Gateway `file.read` gate (the producing op was already gated as its
 *  own write-tier step, D-185 §3.2); its read is confined to the producing
 *  run's scratch root. It MUST NOT outlive its run (no cross-run continuity —
 *  that requires `cas`). `mime_type` / `filename` mirror the producing op's
 *  `output_capture` so a consumer builds a content part without sniffing. */
export interface TempFileRef {
  backing: 'temp';
  /** Absolute path to the run-scoped temp file (cleaned at run end). */
  path: string;
  /** MIME type the producing op declared (its `output_capture.mime_type`). */
  mime_type: string;
  /** The produced file's basename (display + content-part hint). */
  filename: string;
}

/** Content-pinned CAS input for a cli `input_materialize` handoff. A bare CAS
 * record id remains supported for ordinary callers; this closed carrier is for
 * workflows that have already committed an exact content hash and must ensure
 * the cli receives those same bytes even when the mutable `data.file` record id
 * is concurrently repointed. The materializer hashes the exact buffer it writes
 * to the cli input file and refuses a mismatch before spawning the process. */
export interface PinnedCasFileRef {
  backing: 'cas';
  record_id: string;
  content_sha256: string;
}

export const isPinnedCasFileRef = (value: unknown): value is PinnedCasFileRef => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3
    && row.backing === 'cas'
    && typeof row.record_id === 'string'
    && /^file:[0-9a-f]{32}$/.test(row.record_id)
    && typeof row.content_sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(row.content_sha256);
};

/** D-185 Slice 2 — narrow a `result.file_ref` value to a `temp` backing. A
 *  `cas` ref is a bare string and fails this guard (the consumer then treats it
 *  as a `record_id`). Validates the FULL `TempFileRef` shape (path + mime_type +
 *  filename all non-empty) — a legit producer always sets all three, and a
 *  consumer reading `mime_type` (the doc-part content part, the persist ingest)
 *  must get a clean reject at the boundary, not a crash on a half-formed ref. */
export const isTempFileRef = (value: unknown): value is TempFileRef => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { backing?: unknown; path?: unknown; mime_type?: unknown; filename?: unknown };
  return v.backing === 'temp'
    && typeof v.path === 'string' && v.path.length > 0
    && typeof v.mime_type === 'string' && v.mime_type.length > 0
    && typeof v.filename === 'string' && v.filename.length > 0;
};
export type CliDetachedMode = 'runtime_managed';
export const CLI_DETACHED_MODES: readonly CliDetachedMode[] = ['runtime_managed'];
export type CliDetachedCompletionKind = 'marker_file';
export const CLI_DETACHED_COMPLETION_KINDS: readonly CliDetachedCompletionKind[] = ['marker_file'];
export type CliDetachedCancelKind = 'process_group';
export const CLI_DETACHED_CANCEL_KINDS: readonly CliDetachedCancelKind[] = ['process_group'];

export interface CliDetachedMarkerCompletion {
  kind: CliDetachedCompletionKind;
  /** Template resolved by the launcher after argv args are available. `{code}`
   *  is reserved for the child exit code. */
  exit_pattern: string;
  /** Optional stdout/stderr capture target for the detached child. */
  log_pattern?: string;
}

export interface CliDetachedCancelSpec {
  kind: CliDetachedCancelKind;
  /** Template resolved to the pid/process-group marker written by the launcher. */
  pid_pattern: string;
}

/** Optional keep-alive for a detached cli job. When present, the pack declares
 *  the job is a supervised long-running daemon: the server supervisor watches the
 *  pid / `.exit.<code>` marker and re-launches per `restart_policy`. Enrolling +
 *  flipping manual/auto is a UI action (pack-detail), not a recipe step — a
 *  fire-and-forget recipe can launch the job but cannot keep it alive. The
 *  `recipe run_detached` path stays for one-shot, unsupervised launches.
 *  v1 has no separate liveness probe — pid/marker IS the signal (a `health_check`
 *  may be added later). */
export interface CliDetachedSupervisionSpec {
  /** Re-launch behavior when the job exits. Mirrors `lifecycle.start.restart_policy`:
   *  `'never'` = manual (UI start/stop, no auto-restart); `'on-crash' | 'always'`
   *  = auto (supervisor keeps it alive). */
  restart_policy: ServiceRestartPolicy;
  /** Re-launch the supervised job when the server (re)starts — reconcile after a
   *  host reboot or server update. */
  restart_on_server_start?: boolean;
}

export interface CliDetachedJobSpec {
  /** Recued detaches the child when the CLI does not expose a native detach flag. */
  mode: CliDetachedMode;
  completion: CliDetachedMarkerCompletion;
  cancel?: CliDetachedCancelSpec;
  /** Present iff the pack's op is a supervised long-running daemon (UI-enrolled
   *  keep-alive). Absent = one-shot fire-and-forget detached job. */
  supervision?: CliDetachedSupervisionSpec;
}

/** Connector lifecycle numeric bounds (spec § Timeout gates). Centralized so
 *  the strict validator AND a future runtime connector supervisor share one
 *  source of truth. */
export const CATALOG_CONNECTOR_INVOKE_TIMEOUT_CAP_MS = 120_000;
export const CATALOG_CONNECTOR_STARTUP_TIMEOUT_CAP_MS = 120_000;
export const CATALOG_CONNECTOR_SHUTDOWN_TIMEOUT_CAP_MS = 60_000;
export const CATALOG_CONNECTOR_IDLE_DISCONNECT_MIN_MS = 30_000;
/** Connector auth handoff (`lifecycle.auth.wait_timeout_ms`) cap — spec
 *  § Timeout gates "auth_flow_timeouts.* each ≤ 1_800_000 (30min)". */
export const CATALOG_CONNECTOR_AUTH_WAIT_TIMEOUT_CAP_MS = 1_800_000;

export interface ConnectorRuntimeSpec {
  transport: ConnectorTransport;
  wire_protocol: ConnectorWireProtocol;
  package_ref: string;
  entry_point: string;
  expected_protocol_version: number;
}

/** D-182 §7 — the canonical `system_binary:<tool>` package-ref prefix the
 *  decomposer stamps onto a cli connector surface. */
export const CLI_SYSTEM_BINARY_PREFIX = 'system_binary:';

/** D-182 §7 — derive the TOOL a cli connector runtime invokes — the key the
 *  Local-tools universe derivers (`deriveCliToolGrant` /
 *  `enumerateCliToolUniverse`) group ingredients by (a tool maps to ≥1 cli
 *  catalog ingredient). The launched binary is the `entry_point`; when it is
 *  absent/empty the `system_binary:<tool>` `package_ref` is the fallback.
 *  `undefined` for a non-cli runtime or one with no resolvable tool (the caller
 *  then skips it). NB: the gateway no longer authorizes cli ops by TOOL — D-182
 *  §7.2 reachability keys on the INGREDIENT × OPERATION (the catalog slug + op
 *  id) — so this is display vocabulary, not an authorization key. */
export const cliToolFromConnectorRuntime = (
  runtime: ConnectorRuntimeSpec | undefined,
): string | undefined => {
  if (runtime?.wire_protocol !== 'cli_invocation') return undefined;
  if (runtime.entry_point) return runtime.entry_point;
  const ref = runtime.package_ref;
  if (typeof ref === 'string' && ref.startsWith(CLI_SYSTEM_BINARY_PREFIX)) {
    return ref.slice(CLI_SYSTEM_BINARY_PREFIX.length);
  }
  return undefined;
};

export interface ConnectorLifecycleSpec {
  auth: { method: ConnectorAuthMethod; wait_timeout_ms?: number };
  connect: { idempotent: boolean; startup_timeout_ms: number };
  invoke?: { default_method_timeout_ms?: number };
  disconnect: { graceful_shutdown_timeout_ms: number };
  reconnect_policy: ReconnectPolicy;
  persistent_connection: boolean;
  /** Kill the connector after N ms idle. Required (and 0) for
   *  `cli_invocation` wire (each call is a fresh subprocess); required + ≥
   *  `CATALOG_CONNECTOR_IDLE_DISCONNECT_MIN_MS` when `persistent_connection`
   *  is false on a non-CLI wire. */
  idle_disconnect_ms?: number;
}

export interface ConnectorMethodBinding {
  kind: 'method_call';
  method_name: string;
  args_mapping?: unknown;
}

/** D-181 Slice 3 — per-operation progress declaration for a foreground cli
 *  op (the catalog-form sibling of the simple-form
 *  `IngredientManifest.progress_contract`). Declared per binding because a
 *  catalog hosts many ops with different progress shapes (a quick `status`
 *  call vs a 20-min docling render). When omitted, the foreground cli op keeps
 *  the tight `timeout_ms` cap unchanged (behaviour-neutral); when present, the
 *  stall monitor governs the call and the tight cap is dropped (heavy ops are
 *  uncapped — progress detection + the human bound them, §6). */
export interface CliProgressSpec {
  /** How this op surfaces progress. `heartbeat` watches stdout cadence;
   *  `file-growth` polls `watch_path`'s size+mtime; `silent` is bounded only
   *  by the generous wall-clock fail-safe. `provider-event` is not meaningful
   *  for a local subprocess (it is the http/streaming contract). */
  contract: ProgressContract;
  /** `file-growth` only — the argv-template (`{arg}` refs) of the output file
   *  the op writes incrementally; the monitor polls it for growth. Resolved
   *  against the op's args at dispatch, like `argv_template` tokens. */
  watch_path?: string;
}

/** Document-toolkit — capture a foreground cli op's OUTPUT FILE as a file ref.
 *  The executor owns the `dir_arg` output location and captures exactly one
 *  produced file. Omitted `storage` yields a run-scoped `TempFileRef`, reclaimed
 *  at run end; explicit `storage: 'cas'` ingests a durable
 *  `data.file.received` record. Either carrier lets a downstream `ai-*` step
 *  consume the output through `{ file_ref }` without plaintext entering
 *  ordinary op-step values. */
export type CliOutputCaptureSpec =
  | CliOutputDirCaptureSpec
  | CliOutputInPlaceCaptureSpec;

export interface CliOutputDirCaptureSpec {
  /** The argv-template token (e.g. `output_dir`) the executor fills with the
   *  engine-managed temp dir. MUST appear as a `{dir_arg}` token in
   *  `argv_template` and MUST NOT be a user-supplied `editable_args` key — the
   *  engine owns the output location. */
  dir_arg: string;
  /** mime_type stamped on the ingested `data.file` record (the cli output's
   *  type — e.g. `text/markdown` for docling `to_markdown`). Also selects which
   *  produced file to capture when the tool emits sidecars (by extension). */
  mime_type: string;
  from_input_arg?: never;
}

/** IN-PLACE capture — the op's output IS the file `input_materialize` wrote to
 *  a throwaway temp path. For a tool that edits its input and offers no output
 *  path (`officecli batch`, `ruff --fix`, in-place `ocrmypdf`), a `dir_arg` has
 *  nothing to point at: the tool never writes into a directory we own.
 *
 *  The posture is UNCHANGED from `dir_arg` capture, and deliberately so. The
 *  path is still engine-chosen (`mkdtemp` + `materializedInputBasename`) — the
 *  caller supplies a `file_ref`, never a path. That equivalence is load-bearing,
 *  so the validators additionally REFUSE this variant the materialize
 *  passthrough lane (a literal local path / URL): with a caller-named path the
 *  tool would write to, and this capture would ingest from, a location the
 *  recipe chose. `from_input_arg` MUST equal `input_materialize.arg`, and the
 *  op MUST declare a scalar `input_materialize` (`file_ref_array` has no single
 *  path to capture). */
export interface CliOutputInPlaceCaptureSpec {
  /** The `input_materialize.arg` token whose materialized temp file the tool
   *  edited in place. MUST equal `input_materialize.arg`. */
  from_input_arg: string;
  /** mime_type stamped on the captured record. Unlike `dir_arg` capture this
   *  never selects among sidecars — the path is known — but it still stamps the
   *  record and drives the envelope assertion. */
  mime_type: string;
  dir_arg?: never;
}

/** Narrow a capture spec to the in-place variant. Presence of `from_input_arg`
 *  is the discriminator; `?: never` on each sibling keeps a both-keys literal
 *  from type-checking. */
export const isInPlaceCapture = (
  capture: CliOutputCaptureSpec,
): capture is CliOutputInPlaceCaptureSpec =>
  typeof (capture as CliOutputInPlaceCaptureSpec).from_input_arg === 'string';

/** D-189 — one argv template entry. String entries are the historical scalar
 *  tokens. `{ expand_arg }` expands an already-typed array arg into one argv
 *  element per item, preserving order and never invoking a shell/string split.
 *  v1 uses this only with `input_materialize.kind: 'file_ref_array'`. */
export type CliArgvTemplateEntry = string | { expand_arg: string };

/** Optional working-directory selector for a cli op. The value is intentionally
 *  a single `{arg}` token, not a freeform path template: the executor resolves it
 *  from the operation args at dispatch and passes it as the subprocess cwd. */
export interface CliInvocationCwdSpec {
  arg: string;
}

export interface CliMethodBinding {
  kind: 'cli_invocation';
  cwd?: CliInvocationCwdSpec;
  argv_template: CliArgvTemplateEntry[];
  stdin_handling?: CliStdinHandling;
  /** D-185 — the op's output declaration (the retired `out`/`stdout_handling`/
   *  `output_capture.kind` trio collapses into this). A VALUE shape
   *  (`text`/`json`/`jsonl`) captures stdout (`text` = raw string; `json`/`jsonl`
   *  parse it; the parsed value carries the capture size cap — a truncated
   *  capture ERRORS rather than parsing partial bytes, D-185 §3.3, so large
   *  output must declare `shape: 'ref'`); `ref` discards stdout and produces a
   *  `file_ref` (requires `output_capture`); OMITTED = exit-code-only. */
  shape?: CliOutputShape;
  /** D-185 — WHERE a `shape: 'ref'` op's file lives: `cas` (durable record_id
   *  string) or `temp` (run-scoped `TempFileRef`). Meaningful only with
   *  `output_capture` (i.e. `shape: 'ref'`); ignored otherwise. Omitted ⇒ the
   *  framework default `temp` (D-185 §2) — throwaway is the right baseline; a
   *  recipe that keeps the artifact adds an explicit `core.storage.file.persist`
   *  keep-step. */
  storage?: CliOutputStorage;
  exit_code_handling: 'zero_is_success' | { success_codes: number[] };
  detached?: CliDetachedJobSpec;
  /** D-181 Slice 3 — foreground progress / stall-detection declaration. */
  progress?: CliProgressSpec;
  /** Document-toolkit — capture the op's output file as `result.file_ref`
   *  using the selected/default storage backing. Foreground-only; mutually
   *  exclusive with `detached`. */
  output_capture?: CliOutputCaptureSpec;
  /** SMB-finance slice 3 — resolve a `file_ref` arg (a bare
   *  `data.file.received` record_id, a content-pinned CAS carrier, or a same-run
   *  `TempFileRef`) to the local path the cli reads. A pinned CAS carrier hashes
   *  the exact materialized buffer before spawn. Cleaned up in a `finally`. */
  input_materialize?: CliInputMaterializeSpec;
}

/** SMB-finance slice 3 — materialize a `file_ref` arg to a temp file for a cli
 *  op (the input counterpart of `CliOutputCaptureSpec`). A bare record id reads
 *  current CAS bytes; `PinnedCasFileRef` additionally verifies their committed
 *  SHA-256 before the same buffer is written. */
export type CliInputMaterializeSpec = CliScalarInputMaterializeSpec | CliArrayInputMaterializeSpec;

export interface CliScalarInputMaterializeSpec {
  /** v1 materializes a `data.file` ref. */
  kind: 'file_ref';
  /** The argv-template token (e.g. `source`) whose value is a `file_ref` to
   *  materialize. MUST appear as a `{arg}` token in `argv_template` and be a
   *  declared, caller-supplied `editable_args` key (unlike `output_capture`'s
   *  `dir_arg`, the input IS recipe-supplied — it's the file being parsed). */
  arg: string;
}

/** D-189 — materialize an ordered array of file refs/local paths and expand it
 *  into argv as discrete elements via `{ "expand_arg": "<arg>" }`. */
export interface CliArrayInputMaterializeSpec {
  kind: 'file_ref_array';
  /** The caller-supplied array arg to materialize and expand. */
  arg: string;
  /** Optional runtime/authoring lower bound. Defaults to 1. */
  min_items?: number;
  /** Optional runtime/authoring upper bound. Defaults to 32; must be <= 32. */
  max_items?: number;
}

export type ConnectorExecutionBinding = ConnectorMethodBinding | CliMethodBinding;

export interface ConnectorEventSpec {
  event_id: string;
  description: string;
  payload_schema: unknown;
  audit?: unknown;
}

export interface ProviderConnectorSurface {
  runtime: ConnectorRuntimeSpec;
  lifecycle: ConnectorLifecycleSpec;
  executes: Record<string, ConnectorExecutionBinding>;
  events?: Record<string, ConnectorEventSpec>;
}

/** Outbound-notification surface — metadata only, no inbound execution
 *  bindings (spec § Surfaces — "outbound notification metadata only"). Maps
 *  catalog operations onto D-125's `connection.notification` channel family.
 *  Intentionally thin; the detailed send-shape is the notification block's
 *  (D-158) concern, not the catalog's. */
export interface ProviderNotificationSurface {
  /** Channel family this surface notifies through (email / slack / telegram
   *  / in_app / …). Open vocabulary; the runtime resolves the send path. */
  channel_kind: string;
  default_target?: string;
  supports_rich_content?: boolean;
}

export interface ProviderSurfaces {
  api?: ProviderApiSurface;
  connector?: ProviderConnectorSurface;
  notification?: ProviderNotificationSurface;
  /** D-221 — core-local fixed Records substrate. This surface is emitted only
   * by the verified pack installer; it is not a public authoring cell. */
  records?: import('./records.js').ProviderRecordsSurface;
}

/** D-182 §8 + D-221 §3.3 — the hard door-exposability invariant. `cli`,
 *  `service`, and Records-surface ingredients are NEVER externally exposable:
 *  an external actor (a door / MCP-channel agent) may *trigger a recipe* that
 *  uses one internally (itself Gateway-gated), but can NEVER call it directly
 *  as a raw tool. Returns `false` for those cases, `true` otherwise.
 *
 *  The property is DERIVED (the manifest carries no literal `external_exposable`
 *  flag) so it can't drift from the kind:
 *    - `service` — the D-118 long-running-service kind (`kind: 'service'`).
 *    - `cli`     — a connector surface whose runtime invokes a local binary
 *      (`wire_protocol: 'cli_invocation'` → `cliToolFromConnectorRuntime`
 *      resolves a tool). cli is not a core `IngredientKind` enum member — it
 *      rides the connector surface — so this is the canonical cli detector.
 *
 *  This is the SINGLE source of truth §8 and D-221 §3.3 reference; every MCP per-ingredient
 *  surface (tools/list, the grant catalog, token authorization, tools/call
 *  routing) gates on it so an installed cli/service catalog can never surface as
 *  a `recued_ingredient_<slug>` tool. Records primitives likewise cannot bypass
 *  their receiving recipe's role check. Null/undefined fails closed (not
 *  exposable). */
export const isExternallyExposableIngredient = (
  manifest:
    | { kind?: IngredientKind; surfaces?: ProviderSurfaces }
    | null
    | undefined,
): boolean => {
  if (!manifest) return false;
  // D-221 §3.3 — Records operations are reached only behind a receiving
  // recipe, where pack code applies its business-role check. Exposing the
  // storage catalog or `recued_op_*` primitive would let a door skip that
  // middle link (and raw reads default on for new tokens), so both direct MCP
  // surfaces must fail the shared hard fence.
  if (manifest.surfaces?.records !== undefined) return false;
  if (manifest.kind === 'service') return false;
  return !isCliIngredient(manifest);
};

/** D-182 §8 — does this manifest dispatch a LOCAL BINARY (a `cli` ingredient)?
 *  The canonical cli detector — the cli-half of {@link isExternallyExposable
 *  Ingredient}, factored out as ONE source of truth so the two can never drift.
 *
 *  The canonical signal is the connector RUNTIME (`wire_protocol:
 *  'cli_invocation'`, what the decomposer stamps → `cliToolFromConnectorRuntime`
 *  resolves a tool). But the gateway classifies actual cli DISPATCH
 *  per-OPERATION-binding (`isCliInvocationOp` reads `executes[op].kind ===
 *  'cli_invocation'`), so a manifest carrying a cli_invocation binding under a
 *  non-cli runtime — a malformed / hand-authored local catalog the validator
 *  rejects at install but that can still reach the live registry — counts as cli
 *  too (else it slips the list/grant surfaces yet routes to the cli executor at
 *  call time). Check BOTH signals.
 *
 *  Distinct from `isExternallyExposableIngredient`, which is false for cli AND
 *  `service`. Only cli has the §7.2 per-(principal × ingredient × operation)
 *  reachability authorization path; `service` has none and stays fully fenced. So
 *  the door-cli snapshot admit (the recipe-internal cli auth path) gates on THIS
 *  predicate — a stray `cli_reachability` row written for a non-cli slug must
 *  never leak a non-cli ingredient into `allowed_tools`. Null/undefined ⇒ false
 *  (fail closed).
 *
 *  A `kind: 'service'` manifest is NEVER cli, even if it (malformedly) also
 *  carries a `cli_invocation` connector signal: a service declares itself a
 *  service, and service has no reachability auth path — so the service-kind check
 *  fires FIRST (fail-safe). A legit cli ingredient is `kind: 'connection'` (what
 *  the decomposer lowers a `kind: 'cli'` source to), never `'service'`, so this
 *  excludes only a malformed hybrid — which then stays fully fenced (its
 *  door-recipe step is denied `tool_not_in_contract`, never reaches the gateway).
 *  This keeps `isExternallyExposableIngredient` exactly behavior-preserving: a
 *  service is already `false` there via its own kind check. */
export const isCliIngredient = (
  manifest:
    | { kind?: IngredientKind; surfaces?: ProviderSurfaces }
    | null
    | undefined,
): boolean => {
  if (!manifest) return false;
  if (manifest.kind === 'service') return false;
  const connector = manifest.surfaces?.connector;
  if (cliToolFromConnectorRuntime(connector?.runtime) !== undefined) return true;
  const executes = connector?.executes;
  if (executes !== undefined) {
    for (const binding of Object.values(executes)) {
      if (binding?.kind === 'cli_invocation') return true;
    }
  }
  return false;
};


/** D-165 P0 per-connection operation profile — LOCAL-ONLY state (NOT the
 *  full `contract.*` namespace, which is P2+). Keyed per connection name
 *  by the host's profile store; the gateway resolves it at dispatch.
 *
 *    - `allowed_operations` — the grant set. Operations default OFF
 *      (Invariant 3); a call to an operation not in this set is denied.
 *    - `risk_overrides`     — per-operation risk escalation. Stricter-wins
 *      against the catalog operation's declared tier (can raise risk,
 *      never lower it — spec § Default policy "stricter, not looser").
 *    - `approval_defaults`  — per-operation approval escalation, same
 *      stricter-wins discipline.
 *    - `catalog_slug`       — the catalog-form ingredient slug this profile
 *      was seeded for (`hubspot-catalog` / `salesforce-catalog`). The grant
 *      set holds bare short keys (`contact.read`), and two vendor catalogs can
 *      declare the SAME short key — so the gateway also checks this slug
 *      against the catalog ingredient actually being dispatched: a profile
 *      seeded for vendor A's catalog must NOT satisfy a colliding operation
 *      dispatched from vendor B's catalog against A's connection (a misconfigured
 *      recipe). When unset (legacy / un-stamped), the catalog check is skipped
 *      and resolution falls back to the short-key grant check alone. */
export interface ConnectionOperationProfile {
  allowed_operations: ReadonlyArray<string>;
  risk_overrides?: Readonly<Record<string, OperationRiskTier>>;
  approval_defaults?: Readonly<Record<string, OperationApproval>>;
  catalog_slug?: string;
}

/** D-165 follow-on — one operation group's grant state for a connection, for
 *  the Settings → Connections grant UI. `granted` reflects the persisted
 *  explicit grant; `operations` + `risk_floor` come from the catalog group
 *  declaration so the UI can show what a grant unlocks + its risk. */
export interface OperationGroupGrantState {
  group_id: string;
  operations: string[];
  risk_floor?: OperationRiskTier;
  granted: boolean;
}

/** D-165 follow-on — the user-facing operation-group grant view for a
 *  connection, returned by the `collection.connection.{grant,revoke,list}
 *  OperationGroup` rpcs (the surface that makes `write→ask` reachable, since
 *  write ops are never auto-granted — Invariant 3).
 *
 *    - `granted_groups`     — the persisted explicit grant set.
 *    - `allowed_operations` — the resulting effective profile the gateway
 *      resolves against (read-tier auto-grant ∪ the granted groups' ops).
 *    - `available_groups`   — every operation group the connection's catalog
 *      declares, each flagged `granted`, so the UI can render grant toggles. */
export interface OperationGroupGrantView {
  connection_name: string;
  granted_groups: string[];
  allowed_operations: string[];
  available_groups: OperationGroupGrantState[];
}

/** Catalog-form detection — by field presence, per spec § Unified
 *  ingredient schema ("validator dispatches by field presence; catalog-
 *  form is detected via `operations` presence, not version number"). A
 *  manifest with an empty `operations` map is treated as simple-form. */
export const isCatalogForm = (
  manifest: { operations?: unknown } | null | undefined,
): boolean => {
  const ops = manifest?.operations;
  return (
    typeof ops === 'object'
    && ops !== null
    && !Array.isArray(ops)
    && Object.keys(ops as Record<string, unknown>).length > 0
  );
};

/** Verdict tri-state mirroring the D-157 `AdmissionVerdict`. The catalog
 *  gateway maps this onto the engine's pause/execute control flow:
 *  `admit` → dispatch, `ask` → throw `PreflightRequiredSignal`,
 *  `deny` → fail the step (audited). */
export type CatalogVerdict = 'admit' | 'ask' | 'deny';

/** Stable deny codes for catalog-operation resolution. `detail` is for
 *  humans; branch on the code. */
export type CatalogDenyReason =
  /** Operation not in the catalog's declared `operations` set (Inv 4 —
   *  runtime refuses operations the catalog doesn't declare). */
  | 'operation_not_declared'
  /** No per-connection profile resolved — fail-closed (Inv 3). */
  | 'no_connection_profile'
  /** D-182 §7.2 — a `cli` op is not REACHABLE for the run's principal. The cli
   *  analogue of `no_connection_profile`: a connection-less cli op is authorized
   *  by a per-(principal × cli-ingredient × operation) reachability allowlist
   *  (`resolveCliReachabilityPolicy`), NOT a connection profile, so the gateway
   *  never reaches `no_connection_profile` for a cli op — it answers
   *  `cli_reachability_disabled` when no allowlist row admits the dispatch.
   *  Fail-closed (Inv 3 — reachability defaults OFF; an absent row denies). */
  | 'cli_reachability_disabled'
  /** Operation declared + profile present, but not in `allowed_operations`. */
  | 'operation_not_granted'
  /** The connection's profile was seeded for a DIFFERENT catalog than the one
   *  dispatching this operation — a cross-vendor mismatch on a colliding short
   *  key (e.g. a recipe pointing the Salesforce catalog's `contact.read` at a
   *  HubSpot connection). Fail-closed before the grant check. */
  | 'catalog_mismatch'
  /** Provider default policy sets this risk tier to `deny`. */
  | 'policy_denied';

/** Result of resolving one catalog operation against the local profile.
 *  `effective_risk_tier` is the catalog-derived risk (Invariant 1) — it is
 *  what the audit row and any approval reason carry, never the wrapper's
 *  static `risk_tier`. */
export interface CatalogOperationResolution {
  verdict: CatalogVerdict;
  /** Canonical operation id for audit — the matched `OperationSpec`'s
   *  `operation_id` (typically catalog-scoped + fully-qualified), or the
   *  requested lookup key when the operation is not declared. */
  operation_id: string;
  effective_risk_tier: OperationRiskTier;
  /** Primary operation group (first declared), for audit attribution. */
  operation_group: string | null;
  /** Resolved approval intent. Meaningful on `admit` / `ask`; on `deny`
   *  it is the value computed before the deny short-circuit (or `never`
   *  for structural denies). */
  approval: OperationApproval;
  /** D-209 §1.7 — approval after base, trust, source/profile, and legacy
   *  owner tightening, with only later review/quality lifts stripped. */
  authorization_provenance: AuthorizationProvenance;
  granted: boolean;
  deny_reason?: CatalogDenyReason;
  /** D-211 §2 — set when a stored global owner-operation `approval` was BELOW the
   *  effective risk floor AT RESOLVE and the resolver clamped it fail-closed to
   *  the floor (`clampToFloor`): carries the stored (below-floor) value so the
   *  gateway can surface the clamp (audit `approval_clamped_from`). Fires for
   *  a hand-stored / pre-validation row. The owner RPC rejects this state;
   *  runtime clamping remains the fail-closed backstop. */
  approval_clamped_from?: OperationApproval;
}

// The strictness rank is the CANONICAL `RISK_TIER_RANK` (ingredient.ts,
// read 0 … destructive 3); aliased so the call sites below read unchanged.
const RISK_RANK = RISK_TIER_RANK;

/** Stricter (higher-rank) of two risk tiers — used so a profile
 *  `risk_overrides` entry can only escalate the catalog tier, never
 *  weaken it. */
const stricterRisk = (a: OperationRiskTier, b: OperationRiskTier): OperationRiskTier =>
  RISK_RANK[a] >= RISK_RANK[b] ? a : b;

/** True when `candidate`'s risk rank does not exceed `ceiling`'s. D-165 P1
 *  uses this at delegation dispatch to enforce that a delegate wrapper's
 *  declared risk does not OUTRANK the catalog operation's effective risk —
 *  otherwise a low-risk catalog op could execute a higher-risk wrapper
 *  under a weaker approval (Codex review HIGH#2). */
export const isRiskTierAtMost = (
  candidate: OperationRiskTier,
  ceiling: OperationRiskTier,
): boolean => RISK_RANK[candidate] <= RISK_RANK[ceiling];

/** The canonical closed `OperationApproval` vocabulary, ordered WEAKEST →
 *  STRICTEST (rank = index). THE one source every consumer derives from —
 *  `APPROVAL_RANK` below, the D-211 write gate (`contract-handler.ts`), and
 *  the global owner-operation reader (`readOwnerOperationOverride`) — so the
 *  vocabulary can never rot by hand-copy
 *  (a subset typechecks; a derived list cannot drift). */
export const OPERATION_APPROVALS = ['never', 'ask', 'always'] as const satisfies
  readonly OperationApproval[];

/** Membership guard for the canonical approval vocabulary. */
export const isOperationApproval = (v: unknown): v is OperationApproval =>
  typeof v === 'string' && (OPERATION_APPROVALS as readonly string[]).includes(v);

// Rank derived from the canonical order (never a second hand-written table).
const APPROVAL_RANK: Record<OperationApproval, number> = Object.fromEntries(
  OPERATION_APPROVALS.map((approval, rank) => [approval, rank]),
) as Record<OperationApproval, number>;

/** Stricter (higher-rank) of two approval intents — profile
 *  `approval_defaults` can only escalate, never weaken. */
const stricterApproval = (a: OperationApproval, b: OperationApproval): OperationApproval =>
  APPROVAL_RANK[a] >= APPROVAL_RANK[b] ? a : b;

/** D-209 §1.3 — the op-risk APPROVAL FLOOR: the minimum review intensity an
 *  operation of a given risk tier may resolve to. A declared `approval` is
 *  clamped UP to it (stricter-wins), never honored BELOW it — no author, recipe,
 *  grant, or override may push a `write` below `ask` or a `destructive` below
 *  `always`. read→never, write→ask, admin→ask, destructive→always. This is the
 *  SINGLE source both the runtime clamp (`baseApprovalOrDeny`) and the authoring
 *  validators (composition + universal manifest) derive from — the closed list
 *  lives here, never copied beside what it guards. */
export const RISK_APPROVAL_FLOOR: Readonly<Record<OperationRiskTier, OperationApproval>> = {
  read: 'never',
  write: 'ask',
  admin: 'ask',
  destructive: 'always',
};

/** The approval floor for a risk tier. FAIL-CLOSED to the strictest (`always`) on
 *  a malformed / future / cast tier — the value guards a trust boundary, so an
 *  unrecognized tier must never resolve a permissive floor. Mirrors the guarded
 *  `riskExceedsTrustCeiling` lookup below. */
export const approvalFloorForRisk = (risk: OperationRiskTier): OperationApproval =>
  Object.prototype.hasOwnProperty.call(RISK_APPROVAL_FLOOR, risk)
    ? RISK_APPROVAL_FLOOR[risk]
    : 'always';

/** True when an `approval` is LOOSER than the risk floor — i.e. it would need
 *  clamping at runtime. D-211 Slice 1 gives this its first consumers: the
 *  owner-operation WRITE-GATE (`contract-handler.ts` rejects a below-floor
 *  global approval with `owner_operation_below_floor`) and the
 *  RESOLVE-time fail-closed clamp (`resolveOperationPolicyAgainstSource` — a
 *  hand-stored below-floor value resolves AT the floor and surfaces via
 *  `CatalogOperationResolution.approval_clamped_from`). The AUTHORING validators
 *  (composition + universal manifest) do NOT call it until D-211 Slice 4. */
export const isApprovalBelowRiskFloor = (
  approval: OperationApproval,
  risk: OperationRiskTier,
): boolean => APPROVAL_RANK[approval] < APPROVAL_RANK[approvalFloorForRisk(risk)];

/** D-211 §2 — clamp an approval to the risk floor:
 *  `stricter(approval, floor(risk))`. The owner override's `approval` resolves
 *  through this (write-gated AND fail-closed at resolve), so a stored value can
 *  never take an op below `[floor(effective_risk)]`; values at/above the floor
 *  pass through unchanged. Fail-closed like its inputs: an unranked approval
 *  loses the comparison and yields the floor; an unrecognized risk floors at
 *  `always` (`approvalFloorForRisk`). */
export const clampToFloor = (
  approval: OperationApproval,
  risk: OperationRiskTier,
): OperationApproval => stricterApproval(approval, approvalFloorForRisk(risk));

/** D-211 §2 — the owner's global REPLACE-IF-PRESENT ruling fields for one
 *  exact operation, read from the actorless `(ingredient, operation)` row and
 *  handed to the resolvers BEFORE the legacy flow. `risk` and `approval`
 *  replace the corresponding pack-operation fields; source-profile risk and
 *  approval escalation, access, trust, and actor-scoped tightening then run
 *  unchanged. */
export interface OwnerOverridePolicy {
  risk?: OperationRiskTier;
  approval?: OperationApproval;
}

/** Base approval for an operation BEFORE the per-connection profile
 *  override: the operation's own `approval` if declared — CLAMPED UP to the risk
 *  floor (D-209 §1.3; a declared value may only tighten, never loosen below the
 *  floor) — else the provider default policy for the effective risk tier, else
 *  the built-in fallback (read → never, write/admin → ask, destructive → always).
 *  A `deny` default short-circuits to the `'deny'` sentinel. */
const baseApprovalOrDeny = (
  op: OperationSpec,
  risk: OperationRiskTier,
  policy: ProviderDefaultPolicy | undefined,
): OperationApproval | 'deny' => {
  // D-209 §1.3 / §1.6 — a declared `approval` is clamped UP to the risk floor:
  // an author `never` on a `write` becomes `ask`, an author `ask`/`never` on a
  // `destructive` becomes `always`. This is the fail-closed backstop that closes
  // the D-207 intake-door bypass at the source (a write-`never` op can no longer
  // admit silently). A malformed `op.approval` also fails closed to the floor via
  // `stricterApproval` (an unranked value loses the `>=` and yields the floor).
  if (op.approval) return stricterApproval(op.approval, approvalFloorForRisk(risk));
  switch (risk) {
    case 'read':
      return policy?.read_default === 'ask' ? 'ask' : 'never';
    case 'write':
      return policy?.write_default === 'deny' ? 'deny' : 'ask';
    case 'admin':
      return policy?.admin_default === 'deny' ? 'deny' : 'ask';
    case 'destructive':
      return policy?.destructive_default === 'deny' ? 'deny' : 'always';
  }
};

/** D-182 §6 — the structural shape an authorization source can take: a grant
 *  set plus the per-op risk/approval escalation + cross-catalog stamp. The
 *  connection profile (`ConnectionOperationProfile`, keyed by connection) is the
 *  concrete grant-set source; the cli kind authorizes by a per-(principal ×
 *  cli-ingredient × operation) reachability BOOLEAN instead (D-182 §7.2 —
 *  modelled as a presence-only source by `resolveCliReachabilityPolicy`). The
 *  resolution algebra below is identical across them, so the per-kind preflight
 *  differs ONLY in WHICH source it resolves and the fail-closed deny reason when
 *  none is present. */
interface OperationAuthorizationSource {
  allowed_operations: ReadonlyArray<string>;
  risk_overrides?: Readonly<Record<string, OperationRiskTier>>;
  approval_defaults?: Readonly<Record<string, OperationApproval>>;
  catalog_slug?: string;
}

/** D-165 / D-182 §6 — the shared catalog-operation resolution algebra, run
 *  against whichever authorization source the op's kind selects. Pure: no I/O,
 *  no clock. Identical for every kind; the public per-kind resolvers below
 *  supply only the resolved `source` (null = not authorized at all) + the
 *  fail-closed `missing_deny_reason` to use when it's absent.
 *
 *  Resolution order:
 *    1. Operation must be declared in `operations` (Inv 4) — else
 *       `operation_not_declared`.
 *    2. Read the operation defaults as pack values overlaid by the owner's
 *       global exact-operation fields. Then run the unchanged source-profile
 *       risk escalation: `stricter(owner.risk ?? op.risk_tier,
 *       source.risk_overrides[op])`.
 *    3. Grant: a source must exist (`missing_deny_reason`, fail-closed) and the
 *       operation must be in `allowed_operations` (`operation_not_granted`).
 *       Operations default OFF (Inv 3).
 *    4. Approval base runs unchanged over the overlaid operation:
 *       `owner.approval ?? op.approval` is the explicit op value (clamped to
 *       the risk floor); the provider default is consulted only when neither
 *       pack nor owner supplies an explicit approval.
 *    5. Trust-ceiling relax, then source `approval_defaults[op]` stricter-wins
 *       — both UNCHANGED by D-211, applied after the base.
 *    6. Verdict: `never` → admit; `ask` / `always` → ask. */
const resolveOperationPolicyAgainstSource = (args: {
  operations: Record<string, OperationSpec>;
  operation_id: string;
  source: OperationAuthorizationSource | null;
  missing_deny_reason: CatalogDenyReason;
  default_policy?: ProviderDefaultPolicy;
  catalog_slug?: string;
  /** D-209 Slice B (§1.4) — the dispatch's applicable STAGE-TRUST ceiling
   *  (`resolveTrustCeiling(execution_source)`). Relaxes an `ask`-class op whose
   *  effective risk is at/below it to a silent admit, BEFORE the owner tighten.
   *  Absent ⇒ no relax (fail-closed). */
  ceiling?: TrustCeiling;
  /** D-211 §2 — the owner's global replace-if-present ruling for this exact
   *  operation. The two fields replace the pack operation's defaults before
   *  the existing source-profile and trust flow. Approval remains clamped to
   *  `[floor(effective_risk), always]` (fail-closed — a
   *  below-floor stored value resolves AT the floor and surfaces via
   *  `approval_clamped_from`). Absent ⇒ authored defaults, byte-identical to
   *  pre-D-211 behavior. */
  owner_override?: OwnerOverridePolicy;
}): CatalogOperationResolution => {
  const op = args.operations[args.operation_id];
  if (!op) {
    return {
      verdict: 'deny',
      operation_id: args.operation_id,
      effective_risk_tier: 'read',
      operation_group: null,
      approval: 'never',
      authorization_provenance: { pre_lift_approval: 'never' },
      granted: false,
      deny_reason: 'operation_not_declared',
    };
  }

  // D-211 — overlay the actorless owner pair onto the pack operation FIRST.
  // Everything after this read is the pre-D-211 flow: a connection profile can
  // still escalate risk, access still gates independently, trust can relax, and
  // later tightening survives. Invalid hand-stored values are dropped so they
  // cannot weaken the pack operation.
  const ownerRisk = args.owner_override?.risk;
  const operationRisk =
    ownerRisk !== undefined && Object.prototype.hasOwnProperty.call(RISK_RANK, ownerRisk)
      ? ownerRisk
      : op.risk_tier;
  const sourceRisk = args.source?.risk_overrides?.[args.operation_id];
  const effective_risk_tier = sourceRisk
    ? stricterRisk(operationRisk, sourceRisk)
    : operationRisk;
  const operation_group =
    op.groups && op.groups.length > 0 ? op.groups[0] : null;

  // Grant check — fail-closed. Operations (+ capabilities) default OFF (Inv 3).
  if (!args.source) {
    return {
      verdict: 'deny',
      operation_id: op.operation_id,
      effective_risk_tier,
      operation_group,
      approval: 'never',
      authorization_provenance: { pre_lift_approval: 'never' },
      granted: false,
      deny_reason: args.missing_deny_reason,
    };
  }
  // Catalog-scope check — fail-closed BEFORE the grant check. A source seeded
  // for catalog A must not satisfy a colliding short key dispatched from
  // catalog B. Only engages when both the caller's dispatched slug and the
  // source's seeded slug are known.
  if (
    args.catalog_slug
    && args.source.catalog_slug
    && args.catalog_slug !== args.source.catalog_slug
  ) {
    return {
      verdict: 'deny',
      operation_id: op.operation_id,
      effective_risk_tier,
      operation_group,
      approval: 'never',
      authorization_provenance: { pre_lift_approval: 'never' },
      granted: false,
      deny_reason: 'catalog_mismatch',
    };
  }
  if (!args.source.allowed_operations.includes(args.operation_id)) {
    return {
      verdict: 'deny',
      operation_id: op.operation_id,
      effective_risk_tier,
      operation_group,
      approval: 'never',
      authorization_provenance: { pre_lift_approval: 'never' },
      granted: false,
      deny_reason: 'operation_not_granted',
    };
  }

  // Approval resolution — overlay the owner value into the pack operation,
  // then run the pinned D-209 §1.4 order unchanged:
  //     base = explicit operation approval (owner ?? pack), clamped to floor
  //            ?? provider default for effective risk
  //     → source-trust CEILING relax (Slice B, §1.4)
  //     → owner TIGHTEN (approval_defaults).
  // As before, an explicit operation approval takes precedence over the
  // provider fallback; an owner approval occupies exactly that pack-op slot.
  // Owner-tightening is LAST so a permissive ceiling can never walk back an
  // escalation (an escalation always survives the relax).
  // When the stored owner approval is BELOW the floor, the clamp resolves AT
  // the floor fail-closed and `approval_clamped_from` carries the stored value
  // so the gateway can surface the clamp. An unranked owner value is dropped
  // (falls back to the authored/default path).
  const rawOwnerApproval = args.owner_override?.approval;
  const ownerApproval =
    rawOwnerApproval !== undefined
    && Object.prototype.hasOwnProperty.call(APPROVAL_RANK, rawOwnerApproval)
      ? rawOwnerApproval
      : undefined;
  const operationWithOwnerDefaults: OperationSpec = ownerApproval === undefined
    ? op
    : { ...op, approval: ownerApproval };
  const base = baseApprovalOrDeny(
    operationWithOwnerDefaults,
    effective_risk_tier,
    args.default_policy,
  );
  if (base === 'deny') {
    return {
      verdict: 'deny',
      operation_id: op.operation_id,
      effective_risk_tier,
      operation_group,
      approval: 'never',
      authorization_provenance: { pre_lift_approval: 'never' },
      granted: true,
      deny_reason: 'policy_denied',
    };
  }
  const approvalClampedFrom =
    ownerApproval !== undefined
    && isApprovalBelowRiskFloor(ownerApproval, effective_risk_tier)
      ? ownerApproval
      : undefined;
  const baseResolution: CatalogOperationResolution = {
    verdict: base === 'never' ? 'admit' : 'ask',
    operation_id: op.operation_id,
    effective_risk_tier,
    operation_group,
    approval: base,
    authorization_provenance: { pre_lift_approval: base },
    granted: true,
    ...(approvalClampedFrom !== undefined
      ? { approval_clamped_from: approvalClampedFrom }
      : {}),
  };
  // Slice B (§1.4) — apply the dispatch's trust ceiling ONCE, here, so catalog /
  // cli / simple-form all relax UNIFORMLY (pre-D-209 only the simple-form path
  // applied the ceiling downstream, so catalog/cli over-held even on the owner's
  // own automation). An ABSENT ceiling ⇒ no relax (fail-closed): the owner-facing
  // callers always pass one — a dispatch with no `execution_source` resolves to the
  // `admin` ceiling UPSTREAM (DEF-3), never reaching here ceiling-less.
  const relaxed = args.ceiling !== undefined
    ? applyTrustCeiling(baseResolution, args.ceiling)
    : baseResolution;
  // Owner-tighten LAST (stricter-wins) — the connection profile's per-op
  // `approval_defaults` escalation. Runs AFTER the ceiling relax so it cannot be
  // undone by trust.
  const sourceApproval = args.source.approval_defaults?.[args.operation_id];
  if (!sourceApproval) return relaxed;
  const approval = stricterApproval(relaxed.approval, sourceApproval);
  return {
    ...relaxed,
    approval,
    authorization_provenance: { pre_lift_approval: approval },
    verdict: approval === 'never' ? 'admit' : 'ask',
  };
};

/** Resolve one catalog operation against the local per-connection profile
 *  — the heart of D-165 P0 (Invariant 1). The connection-keyed authorization
 *  source (the `http` / `connection` / `mcp` kinds' preflight `authorized`
 *  stage — D-182 §6). Pure: no I/O, no clock.
 *
 *  NOTE: the `(channel × actor × contract_id)` contract-matrix gate
 *  (D-157 `evaluatePreflightAdmission`) is a SEPARATE, additive axis the
 *  follow-on grant-ownership D reconciles with this resolver (spec
 *  § "What stays at the follow-on D's scope"). P0 gates on the
 *  catalog + local profile only. */
export const resolveCatalogOperationPolicy = (args: {
  operations: Record<string, OperationSpec>;
  operation_id: string;
  profile: ConnectionOperationProfile | null | undefined;
  default_policy?: ProviderDefaultPolicy;
  /** The catalog-form ingredient slug being dispatched. When supplied AND the
   *  resolved profile carries a `catalog_slug`, a mismatch fails closed
   *  (`catalog_mismatch`) — this is what keeps a profile seeded for one
   *  vendor's catalog from satisfying a colliding short key dispatched from a
   *  different vendor's catalog. Omitted / un-stamped profile → check skipped
   *  (single-catalog + legacy back-compat). */
  catalog_slug?: string;
  /** D-209 Slice B — the dispatch's stage-trust ceiling (§1.4). Threaded to the
   *  shared resolver so a catalog `ask`-op relaxes on the owner's own trust. */
  ceiling?: TrustCeiling;
  /** D-211 §2 — the owner's global exact-operation replacement
   *  (`{risk?, approval?}`), read by the gateway.
   *  Threaded to the shared resolver's replace step; absent ⇒ authored
   *  defaults, behavior byte-identical to pre-D-211. */
  owner_override?: OwnerOverridePolicy;
}): CatalogOperationResolution =>
  resolveOperationPolicyAgainstSource({
    operations: args.operations,
    operation_id: args.operation_id,
    source: args.profile ?? null,
    missing_deny_reason: 'no_connection_profile',
    ...(args.default_policy ? { default_policy: args.default_policy } : {}),
    ...(args.catalog_slug ? { catalog_slug: args.catalog_slug } : {}),
    ...(args.ceiling !== undefined ? { ceiling: args.ceiling } : {}),
    ...(args.owner_override !== undefined ? { owner_override: args.owner_override } : {}),
  });

/** D-182 §7.2 — resolve one `cli` catalog operation against the per-contract
 *  reachability allowlist (the `cli` kind's preflight `authorized` stage). The
 *  cli analogue of `resolveCatalogOperationPolicy`: identical declared / risk /
 *  approval algebra, but the authorization source is a per-(principal ×
 *  cli-ingredient × operation) reachability grant rather than a connection
 *  profile — so a connection-less by-value cli op never reaches
 *  `no_connection_profile`; an absent allowlist row denies
 *  `cli_reachability_disabled` (fail-closed, Invariant 3).
 *
 *  The reachability verdict is a single BOOLEAN (`reachable`), resolved by the
 *  engine's `cliReachabilityResolver` over the run's principal + this cli
 *  ingredient + the dispatched OPERATION id. So a reachable dispatch authorizes
 *  exactly the dispatched op (the §7.2 contract × pack-op grant row). Modelled
 *  as a source whose grant set is exactly the dispatched op: present
 *  (`reachable`) ⇒ admit, absent ⇒ `cli_reachability_disabled`. No `catalog_slug`
 *  cross-catalog guard (the reachability row's `ingredient_id` key IS the binding
 *  — a row for ingredient A can never authorize ingredient B; F5), and no per-op
 *  risk / approval overrides — `effective_risk_tier` stays the catalog op's
 *  declared risk and feeds the approval/notification stage ONLY, never admission.
 *  Pure: no I/O, no clock. */
export const resolveCliReachabilityPolicy = (args: {
  operations: Record<string, OperationSpec>;
  operation_id: string;
  reachable: boolean;
  default_policy?: ProviderDefaultPolicy;
  /** D-209 Slice B — the dispatch's stage-trust ceiling (§1.4). A reachable cli
   *  `ask`-op relaxes to admit on the owner's own trust, holds on a contracted /
   *  anonymous door. This is what makes the 82 write-`ask`-floor cli ops silent
   *  on the owner's own automation instead of over-holding everywhere. */
  ceiling?: TrustCeiling;
  /** D-211 §2 — the owner's global exact-operation replacement
   *  (`{risk?, approval?}`); same replace semantics as the catalog resolver.
   *  Reachability (the grant plane) is untouched by it — an override row has
   *  ZERO effect on admission, only on risk/approval resolution. */
  owner_override?: OwnerOverridePolicy;
}): CatalogOperationResolution =>
  resolveOperationPolicyAgainstSource({
    operations: args.operations,
    operation_id: args.operation_id,
    // Reachability is authorized by PRESENCE of an allowlist row, not a grant
    // set: a reachable dispatch's source grants exactly the dispatched op;
    // absent ⇒ `cli_reachability_disabled`, fail-closed. No `catalog_slug` (the
    // row key's ingredient_id is the binding) and no risk/approval overrides
    // (risk-tier-keyed grid, not per-op).
    source: args.reachable ? { allowed_operations: [args.operation_id] } : null,
    missing_deny_reason: 'cli_reachability_disabled',
    ...(args.default_policy ? { default_policy: args.default_policy } : {}),
    ...(args.ceiling !== undefined ? { ceiling: args.ceiling } : {}),
    ...(args.owner_override !== undefined ? { owner_override: args.owner_override } : {}),
  });

/** D-187 policy-matrix retirement (slice 3) — the op-risk APPROVAL base for a
 *  SIMPLE-FORM ingredient dispatch (a manifest with NO `operations` map: every
 *  `recued` kernel `core.*` op plus the `ai` / `dom` / `chat` / `service` /
 *  plain-`http` wrappers). The replacement for the `(channel × actor)` policy
 *  matrix's wrapper-`risk_tier` approval gate (`evaluateToolAdmissibility`'s
 *  `approval_required_tiers` lift): the matrix keyed approval off the cell, this
 *  keys it off the OPERATION's risk — exactly as the catalog path already does.
 *
 *  A simple-form ingredient IS its own single operation (one ingredient = one op),
 *  so its op-risk is the manifest `risk_tier` verbatim — there is no finer catalog
 *  operation to derive a per-op tier from and no per-op risk override, so
 *  `effective_risk_tier === args.risk_tier`. The base approval is the standard
 *  op-risk default (`baseApprovalOrDeny`: read→never, write/admin→ask,
 *  destructive→always, modulo a provider `default_policy`). This is the SAME
 *  approval algebra `resolveCatalogOperationPolicy` runs, so the contract
 *  stage-trust step (`applyTrustCeiling`, below) composes over the result
 *  identically — catalog and simple-form share one op-risk approval model.
 *
 *  APPROVAL (Layer 2) only. Like `resolveCliReachabilityPolicy`, the authorization
 *  source is PRESENCE-ONLY: ACCESS (contract × op → boolean) is gated SEPARATELY by
 *  the op-admission gate (`backend/server/src/op-admission-gate.ts`, Layer 1) and
 *  layered on by the dispatch host — never here. So the synthetic 1-op source always
 *  grants the op (`granted: true`); the verdict is `admit` / `ask`, never
 *  `operation_not_granted` / `no_connection_profile`. The one deny it can still emit
 *  is `policy_denied` (a `deny`-class `default_policy` for the tier), mirroring the
 *  catalog path. Pure: no I/O, no clock. */
export const resolveSimpleFormOperationPolicy = (args: {
  /** The ingredient slug — the synthetic operation id (audit `operation_id`). */
  slug: string;
  /** The wrapper manifest's `risk_tier` — the op-risk for a one-op ingredient. */
  risk_tier: OperationRiskTier;
  /** Provider default policy, when the manifest carries one (kernel ops do not). */
  default_policy?: ProviderDefaultPolicy;
  /** D-209 Slice B — the dispatch's stage-trust ceiling (§1.4). Applied INSIDE
   *  the shared resolver now (`op-risk-admission` no longer re-applies it — that
   *  double-apply is removed), so every op shape relaxes through one code path. */
  ceiling?: TrustCeiling;
  /** D-211 §2 — the owner's global exact-operation replacement
   *  (`{risk?, approval?}`); same replace semantics as the catalog resolver
   *  (a simple-form ingredient is its own single op, so the ruling keys on the
   *  slug). No live simple-form dispatch host passes it yet — threaded so all
   *  three resolvers share one replace step. */
  owner_override?: OwnerOverridePolicy;
}): CatalogOperationResolution =>
  resolveOperationPolicyAgainstSource({
    // The ingredient AS a degenerate single-operation catalog: op-risk = manifest
    // risk_tier, no `approval` / `groups` (so `operation_group` is null + the
    // approval base is the tier default). `OperationSpec` requires only
    // `operation_id` + `risk_tier`; every other field is optional.
    operations: { [args.slug]: { operation_id: args.slug, risk_tier: args.risk_tier } },
    operation_id: args.slug,
    // Presence-only — access is gated separately (Layer 1). Always granted here.
    source: { allowed_operations: [args.slug] },
    // Unreachable: the op is always declared + the source always present. Named for
    // the signature — the resolver only consults it on an absent source.
    missing_deny_reason: 'operation_not_declared',
    ...(args.default_policy ? { default_policy: args.default_policy } : {}),
    ...(args.ceiling !== undefined ? { ceiling: args.ceiling } : {}),
    ...(args.owner_override !== undefined ? { owner_override: args.owner_override } : {}),
  });

/** The no-approval STAGE-TRUST ceiling — the highest op-risk tier that runs WITHOUT
 *  per-call approval under a given trust relationship. `'none'` = nothing runs
 *  un-approved; `'admin'` = everything up to admin (the seeded owner default). No
 *  `'destructive'` member — destructive ALWAYS asks. Mirrors
 *  `PolicyMatrixCellValue.max_risk_without_approval` (`policy-matrix.ts`) +
 *  `ContractGrant.max_risk_without_approval` (`contract-grant-store.ts`). */
export type TrustCeiling = 'none' | 'read' | 'write' | 'admin';

const TRUST_CEILING_RANK: Readonly<Record<TrustCeiling, number>> = {
  none: -1,
  read: 0,
  write: 1,
  admin: 2,
};

/** True when `risk` outranks the trust `ceiling` — i.e. a dispatch at this op-risk
 *  needs approval. Reuses the catalog `RISK_RANK` (read<write<admin<destructive),
 *  so `destructive` outranks every ceiling (no `'destructive'` ceiling value
 *  exists — max ceiling is `admin`).
 *
 *  FAIL-CLOSED on an unrecognized `ceiling` / `risk`: the ceiling is persisted trust
 *  DATA (a contract's `max_risk_without_approval`, the owner default) at the trust
 *  boundary, so a malformed / future / cast value must never let `applyTrustCeiling`
 *  RELAX an ask-op to admit. An unknown value ⇒ `true` ("exceeds") ⇒ the base `ask` is
 *  KEPT. Mirrors the guarded ceiling comparisons in `policy-matrix-dispatch.ts`
 *  (`riskExceedsCeiling`) + `contract-dispatch.ts` — both hasOwnProperty-guard the
 *  untrusted ceiling before ranking. */
const riskExceedsTrustCeiling = (
  risk: OperationRiskTier,
  ceiling: TrustCeiling,
): boolean => {
  if (!Object.prototype.hasOwnProperty.call(TRUST_CEILING_RANK, ceiling)) return true;
  if (!Object.prototype.hasOwnProperty.call(RISK_RANK, risk)) return true;
  return RISK_RANK[risk] > TRUST_CEILING_RANK[ceiling];
};

/** D-187 policy-matrix retirement (slice 3) — compose op-risk × STAGE-TRUST. RELAX a
 *  base op-risk resolution (`resolveSimpleFormOperationPolicy` or
 *  `resolveCatalogOperationPolicy`) by the dispatch's trust `ceiling`: an `ask`-class
 *  op whose risk is AT OR BELOW the ceiling is pre-trusted and admits WITHOUT
 *  per-call approval; above the ceiling it keeps its base approval.
 *
 *  This is the op-risk replacement for the matrix's `max_risk_without_approval` cell
 *  ceiling (admit ≤ ceiling / ask above), now keyed on the op-CATALOG risk
 *  (`effective_risk_tier`) rather than the wrapper's static `risk_tier`. The ceiling
 *  is the applicable trust (the dispatch host supplies it — slice-4 wiring):
 *    - contract-less (manual / trigger / schedule / auto) → the owner / automation
 *      GLOBAL trust (default `admin` — behavior-preserving, only destructive asks);
 *    - contracted (chat / mcp / messenger) → the CONTRACT's `max_risk_without_
 *      approval`, defaulting LOW so an AI's writes surface for approval (the
 *      control-plane posture) and the owner raises trust per-contract to relax.
 *
 *  RELAX, never escalate — the deliberate OPPOSITE of `projectToResolution`'s
 *  stricter-wins ceiling: trust can only REMOVE a per-call approval, never add one.
 *  The op-risk default is the FLOOR the ceiling cannot cross:
 *    - `approval: 'always'` (a destructive op, or one the author marked always-ask) →
 *      unchanged: trust never relaxes an always-ask op (and destructive outranks every
 *      valid ceiling regardless).
 *    - `approval: 'never'` (a read, or an author opt-out) → unchanged (already admits).
 *    - `approval: 'ask'` (write / admin default) → admit IFF op-risk ≤ ceiling, else
 *      kept `ask`. The relax collapses `approval` to `never` (no approval was needed
 *      — the trust standing-granted it); `effective_risk_tier` is preserved for audit.
 *    - `verdict: 'deny'` (a deny-class `default_policy`) → unchanged (deny is maximal).
 *  Pure; never mutates `base`. */
export const applyTrustCeiling = (
  base: CatalogOperationResolution,
  ceiling: TrustCeiling,
): CatalogOperationResolution => {
  // Deny is maximal; a non-`ask` base is already settled (`never` admits, `always`
  // floors — trust relaxes neither).
  if (base.verdict === 'deny') return base;
  if (base.approval !== 'ask') return base;
  // Above the trust ceiling — keep the base `ask`. (No mutation.)
  if (riskExceedsTrustCeiling(base.effective_risk_tier, ceiling)) return base;
  // At or below the trust ceiling — pre-trusted, no per-call approval.
  return {
    ...base,
    approval: 'never',
    authorization_provenance: { pre_lift_approval: 'never' },
    verdict: 'admit',
  };
};

/** Per-call gateway audit payload (D-165 P0, Invariant 5). The engine
 *  hands one of these to `ExecutionContext.onGatewayCall` on every
 *  gateway-routed dispatch — success AND failure — and the host emits it
 *  as a `connection_gateway` activity row into the D-120 audit store with
 *  `source: 'connection.gateway'`. Carries the resolved (catalog-derived)
 *  risk tier, not the wrapper's static one. */
export interface GatewayCallAudit {
  /** Publisher-scoped catalog-form ingredient slug (spec § Audit). */
  ingredient_id: string;
  /** Canonical resolved operation id. */
  operation_id: string;
  operation_group: string | null;
  connection_name: string;
  /** Effective, catalog-derived risk tier (Invariant 1). */
  risk_tier: OperationRiskTier;
  /** api / connector / notification — best-effort; the connection
   *  transport kind today. */
  surface_kind?: string;
  approval: OperationApproval;
  /** D-211 §2 — set when a stored global owner-operation `approval` was
   *  below-floor at resolve (a hand-stored row)
   *  and resolved fail-closed AT the floor: carries the stored (below-floor)
   *  value verbatim from `CatalogOperationResolution.approval_clamped_from` so
   *  the durable `connection_gateway` row surfaces the clamp. */
  approval_clamped_from?: OperationApproval;
  /** Set when the call paused for and received preflight approval. */
  approval_id?: string;
  outcome: 'success' | 'failed';
  /** Stable failure classifier on the `failed` path: a `CatalogDenyReason`
   *  for gate denials, `'error'` for an execution throw, `'timeout'` for a
   *  killed call. */
  failure_mode?: string;
  duration_ms?: number;
  recipe_id?: string;
  step_id?: string;
  /** D-182 §6/§10 step 7 — op-level audit identity, present whether or not a
   *  recipe was the origin (a raw op the LLM calls without a recipe is audited
   *  at the op level — §8). The Gateway is the audit authority; `recipe_id` /
   *  `step_id` above stay optional (present only on a recipe-origin call), and
   *  these three carry the recipe-independent identity:
   *
   *  - `execution_source` — the `(channel × actor × contract_id)` provenance of
   *    the caller (D-153/D-161), carried verbatim. Absent on dispatch paths that
   *    wire no source onto `ExecutionContext` (dbless tests, legacy direct rpc).
   *  - `origin_unit_id` — the channel-resolved aggregation boundary the call
   *    groups under (`deriveOriginUnit`: chat turn / mcp burst / fire / run). A
   *    recipe run is just one flavor of origin unit; a raw op-burst groups here
   *    instead of under a (non-existent) recipe. Absent when no source is wired.
   *  - `canonical_arg_hash` — the D-177 `canonical_payload_hash` over the call's
   *    resolved args (volatile exclusions applied), the call's payload identity.
   *    Absent when the args are not JSON-clean (`canonicalArgHash` fail-closed) —
   *    an audit field never breaks dispatch. */
  execution_source?: ExecutionSource;
  origin_unit_id?: string;
  canonical_arg_hash?: string;
  /** Connection-agnostic op dispatch (pagination) — the number of upstream pages
   *  the gateway's cursor-follow loop fetched for a collection op (1 when the op
   *  declares no pagination dialect or the first page carried no cursor). Set on
   *  every paginated `success` row so a run's audit shows how much was walked.
   *  Absent on non-paginated ops. */
  pages_fetched?: number;
  /** Connection-agnostic op dispatch (pagination) — set `true` when the cursor-follow
   *  loop STOPPED with more data still available, so the merged result is INCOMPLETE:
   *  the record ceiling (`PAGINATION_MAX_RECORDS`) or page ceiling
   *  (`PAGINATION_MAX_PAGES`) was hit while a cursor remained, OR a next-page cursor
   *  was refused as unsafe (an off-shape Salesforce `nextRecordsUrl`). Makes a
   *  truncated walk explicit in the audit — never a silent cap (the recipe got a
   *  partial set). Absent (⇒ false) when the walk ran to genuine exhaustion. */
  truncated?: boolean;
  /** D-165 P3.path-picker (Slice 3b) — set ONLY on a `path_scope_violation`
   *  failure (a catalog op whose `path_scope` rejected the call's target).
   *  Carries the connection's canonical sub-resource path, the call's canonical
   *  target path, the template that produced it, and the `checkPathScope`
   *  reason — the audit-trail the spec requires (`:933`: "both the connection's
   *  canonicalized path AND the call's canonicalized target path AND the
   *  template"). Absent on every other outcome (no `path_scope` contract, or an
   *  in-scope admit / ask). `target_path` is itself absent when a template
   *  token was unresolved (no path could be derived). */
  path_scope?: {
    policy: PathScopeContract['policy'];
    connection_path: string;
    target_path?: string;
    template?: string;
    reason?: PathScopeCheck['reason'];
  };
}

/** The constant `source` provenance every D-165 gateway audit row carries
 *  (spec § Audit / § P0). Mirrors the `connection.<kind>` →
 *  `connection_<kind>` audit-action convention. */
export const CONNECTION_GATEWAY_AUDIT_SOURCE = 'connection.gateway' as const;

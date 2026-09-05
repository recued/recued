/** D-122 Phase 4 — bulk-install pack manifest.
 *
 *  A bulk pack is a marketplace artifact bundling N recipes (and the
 *  permission slug needed to land them all in one transaction) under a
 *  single `slug` + publisher. Stored as a JSON manifest in the
 *  marketplace, fetched by the install path, expanded into N atomic
 *  recipe installs in one transaction.
 *
 *  Phase 4 ships the contract surface only — the schema, the constants,
 *  and a structural validator. The fetch + cost-estimator layer lives
 *  at `packages/marketplace/src/bulk-pack-resolver.ts` /
 *  `cost-estimator.ts`. The atomic install transaction lives at
 *  `packages/engine/src/install.ts`. The dialog UI lives at
 *  `packages/ui-shared/src/install/bulk-pack-dialog.ts`.
 *
 *  Spec: D-122 §"Bulk-install pack format".
 */

import { findUnstorableStrings, describeUnstorable, UNSTORABLE_FINDING_LIMIT } from './storable-encoding.js';
import type {
  ApiExecutionBinding,
  ArgEditField,
  CatalogKind,
  ConnectorExecutionBinding,
  MediaKind,
  OperationApproval,
  OperationIdempotency,
  OperationPaginationSpec,
  OperationRiskTier,
} from './ingredient-catalog.js';
import type { MetaFieldType } from './entity-schema.js';
import type { EntityFieldPrivacy } from './pii-alias.js';
import type { AcctAlias, CrmAlias, DateGranularity, FieldDerivation } from './connection-vendors.js';
import type { WorkEntitySourceDeclaration } from './work-entity-sources.js';
// D-182 §4 (3b) — the two authoring tables. TYPE-only import (no runtime cycle:
// op-model imports the `SLUG_RE` value + `CanonicalWorkflowTemplate` type from
// here; this side is erased at emit). `CompositionIngredient` (below) embeds
// these as its `ingredients[]` / `operations[]` / `recipe_templates[]`.
import type { IngredientRow, PackOperationRow, RecipeTemplateRow } from './op-model.js';
import type { RecipeRunnabilityEntry, RunnabilityTransition } from './recipe-runnability.js';
import type { RecipePiiDisclosureEntry } from './recipe-pii-trace.js';
import {
  validateWebhookRequirements,
  type PackWebhookRequirement,
} from './webhook-profiles.js';
// Add-a-pack (2026-06-30) — the embedded recipe body a self-contained static pack
// carries. TYPE-only (recipe.ts does not import bulk-pack → no cycle).
import type { RecipeDefinition } from './recipe.js';
import { publisherMayDeclare } from './publisher-trust.js';
import {
  BULK_PACK_MAX_CONNECTION_HINTS,
  validateConnectionHintShape,
  type ConnectionHint,
} from './connection-hints.js';

// D-194 — pack-driven connection enrollment. The `connection_requirements[]`
// manifest field (below) is a first-party descriptor list; its shape rules live
// in one place (`validateConnectionRequirementShape`) shared with the seed's
// boot self-check. No cycle: connection-requirements imports only the
// vendor-provider + oauth constant leaves.
import {
  BULK_PACK_MAX_CONNECTION_REQUIREMENTS,
  validateConnectionRequirementShape,
} from './connection-requirements.js';
import type { ConnectionRequirement } from './connection-requirements.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Schema version for the bulk-pack manifest. Incremented when the pack
 *  format gains required fields. Marketplace + extension reject packs
 *  with a higher version than the runtime understands; the rollback path
 *  in the install transaction treats version mismatch as a hard reject. */
export const BULK_INSTALL_PACK_VERSION = 1;

/** Permission slug requested by recipes that arrive via bulk-install.
 *  The pack manifest itself requires the permission, not each recipe;
 *  granting it once at pack-install authorizes every recipe in the pack
 *  to land. Recipes inside the pack still declare their individual
 *  permissions (`read_memory`, vault scopes, etc.) which surface
 *  alongside in the disclosure block. */
export const BULK_PACK_INSTALL_PERMISSION = 'install_bulk_pack';

/** Cap on the number of recipes a single pack can carry. Prevents
 *  pathological packs ("install all 500 marketplace recipes") and bounds
 *  the install dialog's cost-estimate computation. The Personal CRM
 *  Foundation pack ships at ten. */
export const BULK_PACK_MAX_RECIPES = 50;

/** Marks an install-manifest fetch (`/packs/<slug>.json`, `/recipes/<slug>.json`)
 *  as originating from an INSTALL rather than a browse.
 *
 *  Both flow through the same apex route, so on the wire they are otherwise
 *  identical: `packs.resolveBySlug` fires on merely opening a pack detail, while
 *  `packs.installBySlug` / `recipe.installBySlug` fire on the real thing. Without
 *  this marker an edge-side count is "detail views", not installs.
 *
 *  A HEADER, deliberately — not a query param. The D-180 CDN key is derived from
 *  the URL (`cacheKeyFor`), so a param would split each listing's edge entry into
 *  browse/install variants, halving the hit rate and doubling KV reads on the
 *  route. A header leaves the cache key untouched; the worker reads it before the
 *  cache early-return, so a cached response still counts.
 *
 *  Shared here because the SENDER (`packages/marketplace/src/client.ts`,
 *  `bulk-pack-resolver.ts`) and the READER (`apps/marketplace/src/ssr/worker.ts`)
 *  are separate deploys — a drifting literal would silently stop counting.
 *
 *  Advisory, never authorization: it is trivially spoofable or omittable (a
 *  self-hosted server can strip it), so it may feed a soft popularity metric and
 *  must never gate access or billing. */
export const INSTALL_MANIFEST_MARKER_HEADER = 'x-recued-install';

/** D-139 P6.B — closed-list MCP body-content registry keys a pack
 *  install is allowed to grant. Body content access carries an
 *  outsized privacy cost (mail bodies, meeting notes, call recap
 *  text); each grant key represents an explicitly user-visible
 *  install consent. Adding a new entry requires a corresponding
 *  install-dialog UX change so the user can see + reject the grant.
 *
 *  Today: only `data.contact.engagements.body_content`, granted by
 *  the `crm-commitment-tracker` pack on install. Other packs declare
 *  the empty array (or omit the field entirely) — body access is NOT
 *  granted by accident on routine deterministic-pack installs. */
export const BULK_PACK_BODY_VISIBILITY_GRANT_KEYS = [
  'data.contact.engagements.body_content',
] as const;

/** D-139 P6.B — type alias for the closed grant-key list. */
export type BulkPackBodyVisibilityGrantKey =
  (typeof BULK_PACK_BODY_VISIBILITY_GRANT_KEYS)[number];

const BULK_PACK_BODY_VISIBILITY_GRANT_KEY_SET: ReadonlySet<string> = new Set(
  BULK_PACK_BODY_VISIBILITY_GRANT_KEYS,
);

/** D-139 P6.B — cap on `mcp_body_visibility_grants[]` length. Body
 *  content grants are individually consequential; one or two per pack
 *  is the canonical shape (the commitment-tracker pack ships exactly
 *  one). The cap bounds install-dialog UX complexity + prevents
 *  pathological packs grabbing every grant key in one install. */
export const BULK_PACK_MAX_BODY_VISIBILITY_GRANTS = 4;

// ────────────────────────────────────────────────────────────────
// Manifest shape
// ────────────────────────────────────────────────────────────────

/** One recipe entry inside a pack manifest — slug + version pinned at
 *  pack publish time. The marketplace resolves each (slug, version)
 *  pair to a `MarketplaceListing` at install time. */
export interface BulkPackRecipeRef {
  slug: string;
  version: number;
  /** Add-a-pack (2026-06-30) — OPTIONAL embedded recipe body. Present ⇒ the pack
   *  is SELF-CONTAINED at this recipe (a downloaded static pack whose generator
   *  inlined the vetted body); absent ⇒ a REF the install path resolves from the
   *  bundle (`getBundled`) or the server marketplace resolver. Both shapes are
   *  supported side by side — the pack type decides which the static file emits.
   *  The parser enforces `recipe.recipe_id === slug` (slug-confusion guard,
   *  mirroring `installPackBySlug`'s `resolveMarketplaceRecipe`); deep recipe
   *  validation still runs at install time when the body is persisted. */
  recipe?: RecipeDefinition;
}

/** Portable bulk-install pack payload. Fetched by slug from the
 *  marketplace, parsed, then expanded into N atomic recipe installs.
 *
 *  D-165 app-pack v2 (`manifest_version: 2`) layers an optional
 *  `contents[]` of typed `PackContentRef`s (recipes + catalog ingredients
 *  + operation-group grants + channel bindings + policies) over the v1
 *  recipe-only shape. `parseBulkPackManifest` accepts BOTH versions and
 *  NORMALIZES them to one shape: the parsed manifest's `recipes[]` is
 *  always populated (a v2 pack that carries recipes only in `contents[]`
 *  gets them lifted into `recipes[]` so every existing v1 consumer keeps
 *  working). See `normalizeBulkPackInstallPlan` for the full unified view. */
export interface BulkPackManifest {
  /** Schema version — `1` (recipe-only, D-122) or `2` (app-pack with
   *  `contents[]`, D-165). */
  manifest_version: BulkPackManifestVersion;
  /** URL-safe pack identifier — `personal-crm-foundation`, etc. Forms
   *  half of the marketplace pack route (`/pack/<slug>`). */
  slug: string;
  /** Publisher namespace — `recued-core` for first-party packs, third-
   *  party publishers for community packs. The same namespace gates
   *  apply as for individual recipes. */
  publisher: string;
  /** Display name surfaced in the install dialog + pack page. */
  name: string;
  /** Human-readable summary — what the pack does, what kind of records
   *  it processes, surfaces in the dialog "This pack will…" block. */
  description: string;
  /** v3 — the author's source repo URL (https). Issues, bugs, and
   *  support route THERE; the marketplace hosts no comments / issue
   *  tracking. Entered in the marketplace publish flow (Kitchen renders
   *  it read-only) and never inherited across fork-and-publish. */
  repo?: string;
  /** Monotonic integer for the pack itself. Independent of the per-
   *  recipe versions inside `recipes[]` — bumped when the pack gains /
   *  drops a recipe or rev's a constituent. */
  version: number;
  /** The recipes the pack installs, in the order they should land. The
   *  scheduler seeds backfill state in this order too, so ingestion
   *  recipes can reliably run before downstream linkers if both share
   *  the same tier. On a v1 manifest this is required + non-empty; on a
   *  v2 manifest the raw input MAY omit it (recipes can live in
   *  `contents[]` instead) but `parseBulkPackManifest` always returns it
   *  populated — recipe `contents[]` entries are lifted in (possibly
   *  empty for a pure catalog pack). */
  recipes: BulkPackRecipeRef[];
  /** Permission slugs the user must grant for the pack to install.
   *  Always contains `BULK_PACK_INSTALL_PERMISSION`; individual recipes
   *  may add their own (`read_memory`, etc.) which the install dialog
   *  surfaces in the disclosure block alongside the pack's own. */
  requires: string[];
  /** Discovery tags. Free-form per the marketplace tag convention
   *  (`pack:personal-crm`, `graph-builder`, `l1`, etc.). */
  tags: string[];
  /** D-139 P6.B — optional badge identifying the pack as a post-
   *  substrate canary. The `crm-commitment-tracker` pack sets this
   *  to `true`. Marketplace UI renders a "post-substrate canary"
   *  badge; install-dialog adds explicit "this is canary, expect
   *  refinement" copy. Pre-launch packs default to `false` / omitted. */
  post_substrate_canary?: boolean;
  /** D-139 P6.B — optional launch-flag key the marketplace consults
   *  to decide whether to surface the pack. When present + the
   *  flag's runtime value is `false`, marketplace listing hides the
   *  pack (installation paths bypassing marketplace stay open).
   *  Today: `crm-commitment-tracker` ships behind
   *  `packs.crm_commitment_tracker.enabled` per spec § P6.B
   *  sequencing; flag flips to `true` after ≥ 30d of P6.A telemetry
   *  in production. Pre-launch deterministic packs omit the field. */
  launch_flag?: string;
  /** D-139 P6.B — optional MCP body-content permission grants the
   *  install transaction writes per pack. Engine `installBulkPack`
   *  reads this field + invokes `ctx.grantBodyVisibility?(grants)`
   *  after successful per-recipe install; uninstall path revokes
   *  via `ctx.revokeBodyVisibility?(grants)`. Closed list per
   *  `BULK_PACK_BODY_VISIBILITY_GRANT_KEYS` — body grants are
   *  outsized privacy decisions, every entry must be allow-listed
   *  by the substrate. The validator rejects unknown keys (closed
   *  list) and duplicates. The `crm-commitment-tracker` pack sets
   *  this to `['data.contact.engagements.body_content']`; every
   *  other pack omits the field (or declares an empty array). */
  mcp_body_visibility_grants?: ReadonlyArray<BulkPackBodyVisibilityGrantKey>;
  /** D-145 PA10 — opt-in flag marking the pack as a foundation pack
   *  that auto-installs on first server init. Server-side boot wire
   *  (`backend/server/src/foundation-pack-pre-install.ts`) scans
   *  bundled pack manifests for this flag, runs `installBulkPackOnServer`
   *  with the bundled recipes resolved as the input, and skips
   *  packs whose recipes are already represented in the recipe
   *  store (idempotent). Only first-party publishers (`recued-core`)
   *  may declare the flag — the validator rejects third-party packs
   *  marked `pre_install: true` because the auto-install path
   *  would otherwise let any community-published pack ship without
   *  user consent. Pre-launch packs (D-122 personal-crm-foundation,
   *  D-145 personal-organizer-foundation) ship with this flag; vendor
   *  + augmentation packs leave it unset / `false`. */
  pre_install?: boolean;
  /** D-194 — connection descriptors the pack needs, one per connection. A
   *  first-party-only field (mirroring `pre_install`'s `recued-core` gate): the
   *  install screen reads it to offer an inline "Connect account" that
   *  fast-tracks the existing BYO enrollment across every auth method. Each
   *  entry declares the API `api_base` (the row-match key, §3), the file-wire
   *  `vendor` tag, the OAuth `authority`, an optional identity endpoint, and the
   *  credential method (`auth`). Version-agnostic (v1 file-source packs + v2 app
   *  packs both use it). Community packs bind a compiled-in vendor leaf by slug
   *  or fall back to the generic BYO form — they may NOT declare descriptors.
   *  The install planner reads this pack-carried form directly. A legacy
   *  compile-time fallback remains only for consumers loading pre-migration
   *  manifests with this field absent. */
  connection_requirements?: ConnectionRequirement[];
  /** D-223 — pre-fills for the generic connection form, declarable by ANY
   *  publisher. A hint sets a VALUE on a visible, editable field; it never sets
   *  schema (`hidden` / `readonly` / `showWhen`), which is what decides whether
   *  the owner can see and change it. Values pass the same admission filter the
   *  setup guide already applies to inferred suggestions — one implementation,
   *  in `connection-hints.ts`. Carrying a `connection_requirements` cell is
   *  REFUSED, not ignored. */
  connection_hints?: ConnectionHint[];
  /** D-201 — logical inbound-webhook slots this pack needs.  Entries may name
   *  only trusted built-in profile ids and carry no verifier configuration or
   *  secret values.  Install-time binding to an ingress remains owner-approved
   *  and is implemented in D-201 Slice 4; Slice 0 validates the portable
   *  requirement now so published manifests cannot invent protocol strings. */
  webhook_requirements?: PackWebhookRequirement[];

  // ── D-165 app-pack v2 — additive (validated only on manifest_version 2;
  //    a v1 manifest carrying these gets a non-blocking "ignored" warning). ──

  /** App-pack content list — typed refs to recipes, catalog/entity
   *  ingredients, operation-group grants, channel bindings, and policies.
   *  Present on v2 packs; v1 packs express their payload via `recipes[]`
   *  only. The parser merges `contents[]` recipe refs into `recipes[]`. */
  contents?: PackContentRef[];
  /** Prerequisite ingredients / packs an enhancement pack depends on.
   *  Missing prerequisites surface as `needs_dependency` at install
   *  (runtime concern; the contract validator only gates shape). */
  dependencies?: PackDependency[];
  /** Pack taxonomy (spec § Base/durability/enhancement/messenger packs).
   *  Defaults conceptually to `recipe_pack` when omitted. */
  pack_kind?: PackKind;
  /** V3 pack surface/service kind. This classifies the pack's authored
   *  capability surface (entity platform vs CLI tool vs channel/door, etc.)
   *  without adding a new ingredient kind. It is metadata for review,
   *  marketplace filtering, and install disclosure; concrete execution still
   *  lowers through `contents[]` (usually a by-value `composition`). */
  service_kind?: PackServiceKind;
  /** Marketplace artifact discriminator. When present must be `'pack'`. */
  artifact_type?: 'pack';
}

// ────────────────────────────────────────────────────────────────
// D-165 app-pack v2 — contents[] / dependencies[] substrate
// ────────────────────────────────────────────────────────────────

/** Accepted manifest versions: `1` recipe-only (D-122), `2` app-pack with
 *  `contents[]` (D-165). */
export type BulkPackManifestVersion = 1 | 2;
export const BULK_PACK_MANIFEST_VERSION_V2 = 2;
export const SUPPORTED_BULK_PACK_MANIFEST_VERSIONS: readonly BulkPackManifestVersion[] = [1, 2];

/** Cap on a v2 pack's `contents[]` length. Contents bundle recipes +
 *  catalog ingredients + operation-group grants + channel bindings +
 *  policies; the cap bounds the install dialog + blocks pathological
 *  mega-packs. Looser than `BULK_PACK_MAX_RECIPES` since one app pack can
 *  legitimately compose several ingredients + their groups + recipes. */
export const BULK_PACK_MAX_CONTENTS = 100;

/** Pack taxonomy (spec § Base/durability/enhancement/messenger packs). */
export type PackKind = 'recipe_pack' | 'app_pack' | 'foundation_pack';
export const PACK_KINDS: readonly PackKind[] = ['recipe_pack', 'app_pack', 'foundation_pack'];
export const isPackKind = (v: unknown): v is PackKind =>
  typeof v === 'string' && (PACK_KINDS as readonly string[]).includes(v);

/** Add-a-pack (2026-06-30) — provenance of an install, gating publisher/scope
 *  stamping in the (slice-2) install helper. `marketplace` (the DEFAULT when
 *  absent) keeps today's trusted `manifest.publisher` stamping and leaves bundled
 *  Discover installs unchanged; `local` marks a user-pasted file / own-URL import
 *  that must be stored as a DISTINCT copy under a local scope so it can never
 *  silently clobber a trusted marketplace install of the same identifier. The
 *  exact local-storage keying (compound `(publisher, id)` vs a slug-legal
 *  transform — `SLUG_RE` forbids the `local/` prefix) is the open slice-2 fork. */
export type PackInstallSource = 'marketplace' | 'local';
export const PACK_INSTALL_SOURCES: readonly PackInstallSource[] = ['marketplace', 'local'];
export const isPackInstallSource = (v: unknown): v is PackInstallSource =>
  v === 'marketplace' || v === 'local';

/** V3 service/surface class for a pack. Deliberately separate from
 *  `IngredientKind`: v3 marketplace artifacts are packs, and a CLI/tool pack
 *  carries its callable surface through connector composition rows rather than
 *  by publishing a one-off CLI ingredient. */
export type PackServiceKind =
  | 'entity_platform'
  | 'tool_function'
  | 'cli'
  | 'channel_door'
  | 'ai_connection'
  | 'mcp_door'
  | 'storage'
  | 'workflow';
export const PACK_SERVICE_KINDS: readonly PackServiceKind[] = [
  'entity_platform',
  'tool_function',
  'cli',
  'channel_door',
  'ai_connection',
  'mcp_door',
  'storage',
  'workflow',
];
export const isPackServiceKind = (v: unknown): v is PackServiceKind =>
  typeof v === 'string' && (PACK_SERVICE_KINDS as readonly string[]).includes(v);

/** Discriminator over the `PackContentRef` union. */
export type PackContentKind =
  | 'recipe' | 'ingredient' | 'operation_group' | 'channel_binding' | 'policy'
  | 'composition';
export const PACK_CONTENT_KINDS: readonly PackContentKind[] = [
  'recipe', 'ingredient', 'operation_group', 'channel_binding', 'policy',
  'composition',
];

/** Role an ingredient content ref plays in the pack (spec § contents). */
export type PackIngredientRole = 'entity_schema' | 'operation_wrapper' | 'producer';
export const PACK_INGREDIENT_ROLES: readonly PackIngredientRole[] = [
  'entity_schema', 'operation_wrapper', 'producer',
];

/** Channel-capability tier a `channel_binding` content ref declares —
 *  mirrors D-163 `ChannelCapability`, kept as a local literal union so the
 *  pack contract stays self-contained (the channel substrate owns the
 *  canonical type + deep conversation-policy validation). */
export type PackChannelCapability = 'inline' | 'landing-page' | 'notify-only';
export const PACK_CHANNEL_CAPABILITIES: readonly PackChannelCapability[] = [
  'inline', 'landing-page', 'notify-only',
];

export interface PackRecipeContentRef {
  type: 'recipe';
  slug: string;
  version: number;
  visible?: boolean;
}

/** Catalog / entity / producer ingredient ref. Two addressing modes (spec
 *  § contents): marketplace `slug` + `version` (+ optional `role`), OR
 *  publisher-scoped `ingredient_id` + `ingredient_version`. The validator
 *  requires EXACTLY ONE mode present. */
export interface PackIngredientContentRef {
  type: 'ingredient';
  slug?: string;
  version?: number;
  role?: PackIngredientRole;
  ingredient_id?: string;
  ingredient_version?: number;
}

export interface PackOperationGroupContentRef {
  type: 'operation_group';
  ingredient_id: string;
  group_id: string;
}

/** D-182 §7.1 — the install grant dialog's selection along the two axes the
 *  spec defines, carried on the install rpcs (`ingredient.install`,
 *  `packs.install`).
 *
 *  - **`access`** (what) — `Read` → `+Write` → `All (destructive)`: a tier
 *    CEILING selecting which derived `operation_groups` are granted on the
 *    pack's bound connection. The install path maps it to the permitted risk
 *    tiers (`read` → {read}; `write` → {read, write}; `all` → {read, write,
 *    admin, destructive}). Write/destructive grants still carry their
 *    per-action approval (`ask`) — granting the group is "granted-to-request",
 *    never a silent admit.
 *  - **`scope`** (who) — `owner` ("You only"), `all_customers`,
 *    `all_other_contracts`, or legacy `all_contracts`. The connection-level
 *    pack grant makes the op grantable for the owner (the seeded
 *    `(channel × user_self)` cells admit). Non-owner scopes fan the op-admission
 *    layer out to matching doors that exist at install time; absent ⇒ `owner`.
 *
 *  ABSENT entirely (no dialog could be shown — bulk / boot / headless, or an
 *  install rpc that omits it) ⇒ the install FAILS CLOSED for silent
 *  auto-grants: nothing is granted EXCEPT a pack's authored
 *  `composition.default_grants` for `read` / `approval: ask` ops (the §7.1 F3
 *  fold — reception cold-start). The silent derived read-tier auto-grant is
 *  removed: read tier is granted only when the owner picks it in the dialog. */
export type InstallAccessTier = 'read' | 'write' | 'all';
export const INSTALL_ACCESS_TIERS: readonly InstallAccessTier[] = ['read', 'write', 'all'];
export type InstallScopeWho =
  | 'owner'
  | 'all_customers'
  | 'all_other_contracts'
  | 'all_contracts';
export const INSTALL_SCOPE_WHO: readonly InstallScopeWho[] = [
  'owner',
  'all_customers',
  'all_other_contracts',
  'all_contracts',
];

/** D-196 install-audience checklist. Unlike the legacy single `scope`, these
 *  switches are independent: an owner can deliberately install for themselves,
 *  customers, other contracts, or any combination. The optional id lists are
 *  the expanded, narrower choices under the two broad audience rows. */
export interface InstallAudienceSelection {
  owner: boolean;
  all_customers: boolean;
  all_other_contracts: boolean;
  /** Customer-instance contracts whose Seller tier matches one of these ids. */
  customer_tier_ids?: readonly string[];
  /** Individually selected live contract ids (customer or ordinary). */
  contract_ids?: readonly string[];
}

const isNonEmptyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value)
  && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);

export const isInstallAudienceSelection = (
  value: unknown,
): value is InstallAudienceSelection => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const audience = value as Partial<InstallAudienceSelection>;
  return typeof audience.owner === 'boolean'
    && typeof audience.all_customers === 'boolean'
    && typeof audience.all_other_contracts === 'boolean'
    && (audience.customer_tier_ids === undefined
      || isNonEmptyStringArray(audience.customer_tier_ids))
    && (audience.contract_ids === undefined
      || isNonEmptyStringArray(audience.contract_ids));
};

export interface InstallGrantSelection {
  access: InstallAccessTier;
  /** Legacy single-choice wire. Omitted together with `audience` ⇒ owner-only.
   *  `all_contracts` remains accepted for pre-D-196 callers. New surfaces send
   *  `audience`; sending both is rejected as ambiguous. */
  scope?: InstallScopeWho;
  audience?: InstallAudienceSelection;
}
export const isInstallGrantSelection = (v: unknown): v is InstallGrantSelection =>
  typeof v === 'object'
  && v !== null
  && (INSTALL_ACCESS_TIERS as readonly string[]).includes((v as { access?: unknown }).access as string)
  && ((v as { scope?: unknown }).scope === undefined
    || (INSTALL_SCOPE_WHO as readonly string[]).includes((v as { scope?: unknown }).scope as string))
  && ((v as { audience?: unknown }).audience === undefined
    || isInstallAudienceSelection((v as { audience?: unknown }).audience))
  && !(
    (v as { scope?: unknown }).scope !== undefined
    && (v as { audience?: unknown }).audience !== undefined
  );

export interface PackChannelBindingContentRef {
  type: 'channel_binding';
  channel_name: string;
  capability: PackChannelCapability;
  /** ingredient_id of the catalog whose operations back the channel. */
  bound_to_catalog: string;
  /** D-160 conversation policy carried through to channel registration.
   *  The channel substrate (D-160) owns its deep validation, so the pack
   *  validator only checks it is a non-null object. */
  conversation_policy: Record<string, unknown>;
}

export interface PackPolicyContentRef {
  type: 'policy';
  policy_id: string;
}

/** A coarse `'api' | 'connector'` surface label. No longer a field on
 *  `CompositionIngredient` (the D-182 two-table model derives the surface from
 *  the ingredient's `kind`), but kept as a shared label type the rpc preview /
 *  draft summary / review projection still surface to the editor. */
export type CompositionSurface = 'api' | 'connector';

/** The auth posture label a preview / draft summary surfaces. No longer an
 *  authored field (the ingredient `kind` + per-kind config replaced the old
 *  `auth` block in the two-table model); kept for the rpc/editor label types. */
export type CompositionAuthModel = 'recued_injected' | 'cli_delegated';

/** The canonical handling templates a pack's `recipe_templates[]` instantiate
 *  (compile-time, R4 flatten). Named here because the D-182 `RecipeTemplateRow`
 *  (`op-model.ts`) imports it as a type and `op-model` is downstream of this
 *  module's `SLUG_RE` value export. */
export type CanonicalWorkflowTemplate =
  | 'review-then-approve'
  | 'notify-on-event'
  | 'conditional-operate'
  | 'scheduled-operate'
  | 'escalate';

/** D-170 N.7 / D-173 N.6 — the user-editable-args allowlist element. Its
 *  canonical definition now lives in `ingredient-catalog.ts` (co-located
 *  with the `OperationSpec.editable_args` LOWERING target the decomposer
 *  fills, D-170 spec § "lowers onto the OperationSpec"), so the authoring
 *  source (`OperationRow.editable_args`) and the installed lowering target
 *  share ONE shape. Re-exported here for the authoring-side `OperationRow`
 *  + the `@recued/contracts` barrel's historical export site. */
export type { ArgEditField };

export interface OperationRow {
  family: string;
  operation: string;
  verb: string;
  surface: CompositionSurface;
  binding: ApiExecutionBinding | ConnectorExecutionBinding;
  risk_tier: OperationRiskTier;
  approval: OperationApproval;
  group?: string;
  groups?: string[];
  reviewed: boolean;
  operation_id?: string;
  description?: string;
  required_scopes?: string[];
  idempotency?: OperationIdempotency;
  accepts_media?: MediaKind[];
  produces_media?: MediaKind[];
  request_schema?: unknown;
  response_schema?: unknown;
  editable_args?: ArgEditField[];
  timeout_ms?: number;
  cache_ttl_ms?: number;
  /** Connection-agnostic op dispatch (slice 2) — OPTIONAL per-op override of
   *  the surface-level `ProviderApiSurface.result_path` for the rare collection
   *  op whose response envelope differs from the vendor's surface default.
   *  Empty/absent → inherit the surface default. Consulted only for
   *  collection-returning (search/list) ops by the install resolver. */
  result_path?: string;
  /** Optional v3 pagination contract for this operation. Omitted means a single
   *  upstream call; present means the runtime gateway walks pages behind the
   *  scenes and returns the merged logical result to recipe op-steps. */
  pagination?: OperationPaginationSpec;
}

export interface EntityFieldRow {
  entity: string;
  field_path: string;
  type: MetaFieldType;
  maps_to: string;
  optional?: boolean;
  applies?: 'request' | 'response' | 'both' | 'req' | 'resp';
  pii?: EntityFieldPrivacy;
  source?: 'schema' | 'heuristic' | 'manual' | string;
  reviewed: boolean;
  source_operation?: string;
  description?: string;
  /** Connection-agnostic op dispatch (slice 4) — the cross-vendor logical CRM
   *  entity this entity participates in (`deal` / `contact` / `account`). An
   *  ENTITY-level annotation carried on the (flat) field rows: every row for one
   *  `entity` that declares it must agree, and within a composition (one vendor)
   *  each `crm_alias` may name at most one entity — the same invariants the
   *  registry enforces (`assertConnectionVendorRegistry`). The decomposer carries
   *  it onto `EntitySchemaIngredientInput.crm_alias`; the validator gates the
   *  closed list + checks each row's `maps_to` against the convention's canonical
   *  field set (`canonicalCrmFieldSet`). Omit for a non-CRM entity. */
  crm_alias?: CrmAlias;
  /** SMB-finance wedge slice 5b — the cross-vendor logical ACCOUNTING entity this
   *  entity participates in (`invoice` / `bill` / `customer` / …). The `acct_alias`
   *  sibling of `crm_alias`, carried the same way (an entity-level annotation on the
   *  flat field rows; the decomposer lifts it onto
   *  `EntitySchemaIngredientInput.acct_alias`, which `vendorEntitiesFromComposition`
   *  carries onto the per-install registry so a canonical `invoice.search` op-step
   *  resolves against the bound accounting vendor's pack). Mutually exclusive with
   *  `crm_alias`. Omit for a non-accounting entity. */
  acct_alias?: AcctAlias;
  /** Connection-agnostic op dispatch (G2 request-side datetime filter) — for a
   *  `type: 'datetime'` field, its date GRANULARITY (`date` | `datetime`), threaded
   *  from the registry meta-field (`entityFieldsFromRegistry`) or authored on a
   *  3rd-party composition. Drives the vendor `search` filter literal; a `datetime`
   *  field without it is not server-side filterable (the resolver fails closed). */
  date_granularity?: DateGranularity;
  /** Connection-agnostic op dispatch — a COMPUTED projection for a canonical
   *  field with no single vendor `field_path` (the G3 lift; see `FieldDerivation`).
   *  When present, the resolver projects this field via the derivation (e.g. the
   *  CRM `close_state` tri-state) instead of `{{item.<field_path>}}`, and the SELECT
   *  fetches the derivation's input paths. `field_path` carries the primary input
   *  (for safety validation / naive readers) but is not the projection source. */
  derivation?: FieldDerivation;
}

/** D-182 §4 (3b) — a by-value composition: a pack's authored capability surface
 *  expressed as the two flat tables (`ingredients[]` + `operations[]`) plus
 *  optional compile-time `recipe_templates[]`.
 *
 *  Replaces the D-170 single-surface shape (`surface` / `auth` / flat
 *  `entity_fields` / authored `operation_groups` / `grant_defaults` /
 *  `surfaces_seed` / `workflow_families` / `operation_families`). The dropped
 *  data is either factored into the tables (the ingredient's `kind` + per-kind
 *  config + nested `entities`; risk per op) or DERIVED at decompose
 *  (`operation_groups` from `(ingredient × op-family × risk-class)`,
 *  `default_grants` from the read groups). Capability lives here; authority
 *  (grant posture) is the contract/owner's, derived from op risk. */
export interface CompositionIngredient {
  schema_version: number;
  /** The catalog identity — the `ingredient_id` the decomposer stamps onto the
   *  catalog, entity schemas, grants, and operation ids. For these
   *  single-ingredient packs it equals `ingredients[0].slug`. */
  slug: string;
  catalog_kind?: CatalogKind;
  /** D-225 Slice 2 — force the CATALOG lowering even when the composition would
   *  otherwise qualify for the 1x1 plain-ingredient collapse.
   *
   *  ⛔ Not an authoring convenience. `isOneToOne` collapses a single-operation
   *  http/connection composition into a plain wrapper ingredient, which has no
   *  `operations` map and therefore NO OP ID — so nothing about it can be named
   *  by a contract grant. That is a fine trade for a hand-authored one-shot
   *  wrapper, and fatal for a GENERATED MCP pack, whose entire premise is that
   *  every tool becomes an ordinary contract-grantable operation. An MCP server
   *  publishing exactly one tool is an ordinary case, not an edge one.
   *
   *  The other levers that force the catalog branch all carry side effects a
   *  generated pack must not have: a non-`private_byo` `catalog_kind` also flips
   *  `marketplace_eligible` to true, and a fake `recipe_templates` entry would
   *  compile into a shipped recipe. Hence an explicit flag that says the one
   *  thing it means.
   *
   *  Set by the runtime when it mints a pack; a human authoring a pack should
   *  leave it alone and let the lowering choose. */
  force_catalog_lowering?: boolean;
  /** Table A — one row per ingredient: `kind` + per-kind shared config + nested
   *  vendor-surface entity schema. Single-ingredient packs carry exactly one. */
  ingredients: IngredientRow[];
  /** Table B — one row per recipe-callable op: `op` + `ingredient` join key +
   *  risk + approval + args + `bind` (the verbatim execution binding) + `out`. */
  operations: PackOperationRow[];
  /** Compile-time trigger→op rules (renamed from `workflow_families`); each
   *  expands to one recipe via a canonical template at decompose (R4 flatten). */
  recipe_templates?: RecipeTemplateRow[];
  /** Optional install-time grant OVERRIDE — derived group ids (the
   *  `<ingredient>.<op-family>.<risk>` form) to grant at install IN ADDITION to
   *  the auto-derived read-tier groups. For the rare pack whose cold-start needs
   *  a non-read group pre-granted: the D-173 reception `*.materialize` op is
   *  write + `approval:'ask'`, and must be granted at install so a trigger fire
   *  reaches the gate (then the approval gate holds it for review) with zero user
   *  setup. Every money-gate / api pack OMITS this — their derived read grants
   *  suffice, and write/destructive groups stay ungranted (the money-gate). Each
   *  entry must name a group the decomposer derives (validated). */
  default_grants?: string[];
  /** D-192 — work-entity Source sync declarations (`task` / `note` / `project`).
   *  The decomposer passes these THROUGH to the catalog manifest's
   *  `work_entity_sources`, where the fail-closed section validator
   *  (`validateWorkEntitySources`) gates them over the decomposed catalog — every
   *  named op must resolve to a `surfaces.api.executes` binding whose transport
   *  matches the `contract_source` kind, and the `contract_source.{url,sha256}`
   *  pin must EQUAL the surface pin emitted from the ingredient's `http` cell
   *  (`openapi_source` / `graphql_schema_source` / `google_discovery_source`).
   *  Omit for a pack that declares no Source. */
  work_entity_sources?: WorkEntitySourceDeclaration[];
  recipes?: BulkPackRecipeRef[];
}

export interface PackCompositionContentRef {
  type: 'composition';
  composition: CompositionIngredient;
}

export type PackContentRef =
  | PackRecipeContentRef
  | PackIngredientContentRef
  | PackOperationGroupContentRef
  | PackChannelBindingContentRef
  | PackPolicyContentRef
  | PackCompositionContentRef;

export type PackDependencyKind = 'ingredient' | 'pack';
export const PACK_DEPENDENCY_KINDS: readonly PackDependencyKind[] = ['ingredient', 'pack'];

/** Ingredient prerequisite — by `ingredient_id` OR `slug` (exactly one),
 *  optional `min_version`. */
export interface PackIngredientDependency {
  type: 'ingredient';
  ingredient_id?: string;
  slug?: string;
  min_version?: number;
}

export interface PackPackDependency {
  type: 'pack';
  slug: string;
  min_version?: number;
}

export type PackDependency = PackIngredientDependency | PackPackDependency;

/** Normalized install plan — the single shape both manifest versions
 *  collapse to (spec § Manifest extension, "one internal InstallPlan").
 *  `recipes` is the deduped recipe set (v1 `recipes[]` ∪ v2 recipe
 *  `contents` ∪ v2 `recipes[]` alias, by slug+version); `contents` is the
 *  full typed content list (a v1 manifest's recipes are lifted into recipe
 *  refs so v1 and v2 are indistinguishable downstream). */
export interface PackInstallPlan {
  recipes: BulkPackRecipeRef[];
  contents: PackContentRef[];
}

// ────────────────────────────────────────────────────────────────
// Type guards + validation
// ────────────────────────────────────────────────────────────────

/** Cheap shape predicate — does this object look like a pack manifest?
 *  Used by `parseBulkPackManifest` to bail early on totally-wrong
 *  inputs; the parser still runs full validation on shape-passers. */
export const isBulkPackManifest = (obj: unknown): obj is BulkPackManifest => {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (o.manifest_version !== BULK_INSTALL_PACK_VERSION
    && o.manifest_version !== BULK_PACK_MANIFEST_VERSION_V2) return false;
  if (typeof o.slug !== 'string' || typeof o.publisher !== 'string') return false;
  // v1 carries `recipes[]`; v2 may carry `recipes[]` and/or `contents[]`.
  return Array.isArray(o.recipes) || Array.isArray(o.contents);
};

/** Validation issue produced by `parseBulkPackManifest`. Mirrors the
 *  shape used by `parseBundle` so install paths can render bulk-pack
 *  validation errors with the same UI as recipe-level validation
 *  errors. */
export interface BulkPackIssue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

/** `parseBulkPackManifest` result — ok-form carries the typed manifest;
 *  not-ok carries issues for the install dialog to render. */
export type BulkPackParseResult =
  | { ok: true; manifest: BulkPackManifest; issues: BulkPackIssue[] }
  | { ok: false; issues: BulkPackIssue[] };

/** D-145 PA10 follow-on — structural mirror of the engine's
 *  `BulkPackInstallResult` (lives in `@recued/marketplace`'s `install.ts`).
 *  Contracts can't import from marketplace (would invert the package dep
 *  direction), so the engine result is mirrored here for use by the
 *  `packs.install` rpc registry entry + any UI / handler tests that
 *  need to type the result without pulling in the engine package. The
 *  engine's typed result is structurally assignable to this shape; the
 *  `*Like` suffix marks the type as a mirror rather than the canonical
 *  source. Field set + failure codes track the engine signature exactly. */
export interface BulkPackInstallEntryLike {
  slug: string;
  publisher_id: string;
  version: number;
  /** True when this recipe was installed as part of this transaction
   *  (and not pre-existing). */
  fresh_install: boolean;
  /** Pre-install state of this slug. Engine populates a structural
   *  `InstalledRecipeRow` mirror; typed as `unknown` here because the
   *  rollback callers don't read into it through the rpc surface. */
  prior?: unknown;
}

/** D-145 PA10 follow-on — engine result mirror for the `packs.install` rpc
 *  registry surface. The engine's `BulkPackInstallResult` is the source
 *  of truth in `@recued/marketplace`; this type lets the contracts
 *  package describe the rpc shape without inverting the dep direction. */
export interface BulkPackInstallResultLike {
  ok: boolean;
  installed: ReadonlyArray<BulkPackInstallEntryLike>;
  /** Entries the rollback path uninstalled / restored. */
  rolled_back: ReadonlyArray<BulkPackInstallEntryLike>;
  /** D-165 app-pack v2 — non-recipe contents (catalog ingredients,
   *  operation-group grants, channel bindings, policies) the manifest
   *  declared that the install transaction did NOT provision. Present
   *  (non-empty) only on the success path of a v2 pack carrying app
   *  contents; absent for v1 recipe-only packs + failed installs. The
   *  Settings → Packs / install dialog discloses these as "App
   *  capabilities"; their actual provisioning is the P3 install planner
   *  (blocked on D-166). Mirrors `BulkPackInstallResult.deferred_contents`
   *  from `@recued/marketplace`. */
  deferred_contents?: ReadonlyArray<PackContentRef>;
  /** R2 build step 4c.2 — "born blocked / degraded" install disclosure
   *  (recipe-identity doc §1.6: install discloses "born blocked — add a
   *  provider"). The FRESHLY-installed recipes whose declared capability
   *  dependencies are NOT met by the currently-bound providers, partitioned
   *  by derived runnability:
   *    - `born_blocked`  — a HARD dependency has no provider; the recipe
   *      can't run until one is bound (the install dialog surfaces "add a
   *      provider", naming `dependencies[].unprovided_ops`).
   *    - `born_degraded` — every hard dep is met but an OPTIONAL one is not;
   *      the recipe runs with that optional capability's steps degrade-skipped.
   *  DISCLOSURE, NOT enforcement — the recipe IS installed regardless (the
   *  D-157 gate fails closed at dispatch; this only surfaces the derived
   *  state, which RECOVERS the moment a provider is bound — doc §1.6). Each
   *  entry is the SAME `RecipeRunnabilityEntry` shape `recipe.runnability`
   *  returns, so a surface renders the per-dependency detail without a
   *  round-trip (mirrors the 4c.4 `recipe_runnability_changed` payload).
   *
   *  UNLIKE `deferred_contents`, these are NOT engine fields — the
   *  `packs.install` handler augments the engine result with them post-
   *  install. Present (non-empty) only on `ok: true` when ≥1 of the pack's
   *  just-installed recipes lands in that state AND the handler was wired
   *  with the runnability read (absent in dbless / no-connection-store
   *  boots); omitted otherwise. Scoped to the recipes THIS install resolved
   *  (`installed[]`) — never an unrelated blocked recipe already in the
   *  store. (NOT `fresh_install`-scoped: pack recipes are bundled, so the
   *  engine always reports `fresh_install: false`; the disclosure tracks
   *  "what this pack install put in place", and a re-install re-discloses
   *  the same current state.) The ONGOING runnability of every recipe —
   *  recovery when a provider binds — is the recipes view's
   *  `recipe.runnability` read + the 4c.4 `recipe_runnability_changed`
   *  broadcast. */
  born_blocked?: ReadonlyArray<RecipeRunnabilityEntry>;
  born_degraded?: ReadonlyArray<RecipeRunnabilityEntry>;
  /** § 7 surfacing slice — per-recipe PII posture for the recipes THIS
   *  install resolved: what the dispatch seam auto-protects at run time and
   *  what still needs the author's hand. Same augmentation contract as the
   *  born fields: handler-added post-install, success-path only, present
   *  non-empty only (recipes whose summary has nothing to disclose are
   *  omitted; a fully-clean pack omits the field). Best-effort — an
   *  assessment failure never fails the committed install. */
  pii_disclosure?: ReadonlyArray<RecipePiiDisclosureEntry>;
  /** Populated when `ok === false`. The closed-list `code` lets the
   *  Settings UI render targeted failure copy. */
  failure?: {
    code:
      | 'permission_denied'
      | 'version_mismatch'
      | 'review_stale'
      | 'validator_rejected'
      | 'unresolved'
      | 'unexpected';
    message: string;
    /** Slug + version the engine was processing when the failure hit.
     *  Empty for pack-level failures (`permission_denied` /
     *  `version_mismatch` / `unresolved`). */
    failed_at?: { slug: string; version: number };
  };
}

/** D-145 PA10 follow-on — `packs.list` rpc row.
 *
 *  One entry per bundled pack the server sees on disk. The handler
 *  reads `community/packs/*.json`, parses each as a `BulkPackManifest`,
 *  and joins with the per-pair `RecipeStore` to compute `installed`
 *  (true iff every entry in `manifest.recipes` has a stored recipe row).
 *  Malformed manifests are dropped silently — Settings → Packs only ever
 *  surfaces installable packs (the foundation-pack pre-install boot
 *  wire is the surface that logs validator failures).
 *
 *  The full `manifest` is forwarded so the Settings → Packs install
 *  dialog can render permission checkboxes + the pack details without a
 *  second rpc round-trip. The summary fields (`recipe_count` /
 *  `body_visibility_grant_count`) are cheap derivations on top of the
 *  manifest; including them avoids the panel's row renderer reaching
 *  into `manifest.recipes.length` on every paint. */
export interface PackListEntry {
  /** Pack slug — `personal-organizer-foundation`, etc. */
  slug: string;
  /** Publisher namespace — `recued-core` for first-party, third-party
   *  publishers for community packs. */
  publisher: string;
  /** Display name surfaced in the panel + install dialog. */
  name: string;
  /** Human-readable summary — drives the panel row's body copy + the
   *  install dialog's "This pack will…" block. */
  description: string;
  /** Monotonic pack-manifest version. Bumps on recipe add/drop or SI
   *  rule change. Panel surfaces alongside `installed_version`. */
  version: number;
  /** True for foundation packs (`manifest.pre_install: true`). Panel
   *  badges these + suppresses the Install button (auto-installed
   *  at boot by `foundation-pack-pre-install.ts`). */
  pre_install: boolean;
  /** True when the pack's installed content satisfies this manifest: every
   * recipe is owned at its pinned version and, when inventory exists, the
   * installed pack version is this version or newer. Empty-recipe packs read
   * that direction-aware version fact solely from inventory. */
  installed: boolean;
  /** D-182 — installed at ANY version (the pack genuinely owns its installed
   *  content), as distinct from `installed` (the owned content satisfies this
   *  incoming manifest). They diverge when the installed version is lower or
   *  its recipe set no longer matches. The Discover join also reads the
   *  inventory's real version so a marketplace install above the server bundle
   *  remains current instead of "available" or a downgrade-shaped update.
   *  Ownership-scoped, so a stale vendor-twin row (recipes owned by another pack)
   *  stays `false`. Optional — an older handler omits it (join degrades to
   *  `installed`). */
  installed_any_version?: boolean;
  /** D-211 Slice 5 — global owner rulings whose stamped operation differs from
   * this incoming pack version. Present only for an update and only when at
   * least one changed/removed overridden operation needs review. */
  owner_operation_review?: ReadonlyArray<import('./owner-operation-override.js').OwnerOperationUpdateReviewItem>;
  /** D-221 — exact live Records transition rendered before an update. */
  records_review?: import('./records.js').RecordsPackUpdateReview;
  /** Review anchor for a bundled update. For Records this binds the manifest,
   * current namespace/policy/event state, and the exact target artifacts. */
  manifest_review_hash?: string;
  /** `manifest.requires[]` forwarded verbatim — the Settings → Packs
   *  install dialog renders each entry as a permission checkbox. Always
   *  contains `BULK_PACK_INSTALL_PERMISSION` by manifest invariant. */
  requires: ReadonlyArray<string>;
  /** Length of `manifest.recipes` — cheap derivation. */
  recipe_count: number;
  /** Length of `manifest.mcp_body_visibility_grants` (0 when absent).
   *  Surfaces as a "Body content access" callout in the install dialog
   *  per D-139 P6.B's outsized-privacy-cost framing. */
  body_visibility_grant_count: number;
  /** Every recipe the manifest ships — slug + pinned version, in manifest order.
   *
   *  🔑 Added when `manifest` became installed-only. `computePackRecipeCollisions`
   *  needs the recipe refs of every pack — installed or not — to mark a Discover
   *  row "also in pack-x" before the owner installs it. Reading them off the
   *  manifest meant shipping the manifest. These are the two fields that let the
   *  collision + overlap projections keep working on the slim response, and they
   *  cost bytes in the hundreds rather than the tens of thousands. */
  recipe_refs: ReadonlyArray<{ slug: string; version: number }>;
  /** The manifest's `mcp_body_visibility_grants` keys verbatim (empty when it
   *  declares none) — the twin of {@link recipe_slugs}, for
   *  `computePackGrantOverlap`, whose second pass deliberately spans uninstalled
   *  packs so the install dialog can warn about an overlap before committing.
   *
   *  ⚠ Distinct from {@link body_visibility_grant_count}, which stays because the
   *  install-dialog copy renders a count in its heading. The array is authority;
   *  the count is presentation. */
  body_visibility_grant_keys: ReadonlyArray<string>;
  /** `manifest.service_kind`, lifted. Renders the service-kind badge on a
   *  DISCOVER row, which by definition has no manifest. */
  service_kind?: string;
  /** `manifest.repo`, lifted — the detail's author-repo link, also shown for
   *  packs that are not installed. */
  repo?: string;
  /** Forwarded manifest — the install dialog calls `packs.install` with this
   *  value as the `manifest` argument, and the installed-pack management
   *  surfaces (access controls, owner operations, grant overlap, collisions,
   *  supervision) read it directly.
   *
   *  ⛔ **OPTIONAL, and only present when `installed` is true.** It used to be
   *  unconditional, on a reason this comment stated outright: *"bundled-only
   *  packs at v1 means the manifest is already on disk + small."* That was true
   *  when it was written and is not true now. At **954** bundled packs a
   *  `packs.list` carrying every manifest serializes to **44.6 MB** — for a list
   *  whose own fields (slug / name / description / version / installed / requires
   *  / counts) come to **~1 MB**. A 43× payload for a list view, pushed over the
   *  pair WebSocket and parsed by the browser on every Packs route load.
   *
   *  🔑 The split is by INSTALL STATE because that is exactly where the need
   *  divides: the management surfaces only ever act on installed packs, so they
   *  keep the manifest they already relied on. A Discover row renders from the
   *  projected fields alone. The one consumer that needs an UNINSTALLED pack's
   *  manifest is the install dialog — and it needs exactly one, at the moment
   *  the user opens it, which is what `packs.manifest` serves.
   *
   *  ⚠ Consumers must treat `undefined` as "not installed, fetch if you truly
   *  need it", never as "empty manifest" — a `?? {}` here would silently make
   *  every uninstalled pack look like it declares no recipes, no grants and no
   *  operations. */
  manifest?: BulkPackManifest;
}

/** One installed pack's identity + version, read from the `installed_pack`
 *  inventory registry (which records EVERY install — bundled AND
 *  marketplace-installed — with slug + version + publisher). Unlike
 *  {@link PackListEntry} it carries no manifest: the inventory persists no
 *  display fields for a marketplace pack, so this is the minimal
 *  slug→version fact the Discover install-state join needs to reflect
 *  installed / upgrade-available for a marketplace-published pack whose
 *  manifest isn't bundled on disk. */
export interface InstalledPackVersion {
  /** URL-safe pack slug — the install-state join key. */
  slug: string;
  /** The installed pack version (the inventory stores it as a string; the
   *  handler parses it to a number, skipping any non-numeric row). */
  version: number;
  /** Publisher handle when the inventory recorded one (`manifest.publisher`). */
  publisher?: string;
}

/** D-145 PA10 follow-on — `packs.list` rpc result. */
export interface PacksListResult {
  packs: ReadonlyArray<PackListEntry>;
  /** D-182 — every installed pack's version from the inventory (bundled +
   *  marketplace), for the Discover upgrade join. A marketplace-installed pack
   *  has no bundled manifest so it is absent from `packs[]`; this array is how
   *  Discover still detects its installed / upgrade state. Optional — a dbless
   *  / older handler omits it and the join falls back to `packs[].installed`. */
  installed_versions?: ReadonlyArray<InstalledPackVersion>;
}

/** D-259 — one installed pack the CURRENT validator would refuse to run. */
export interface UnrunnablePackRow {
  /** Owner-facing pack slug — the `#packs/<slug>` key, NOT the catalog id the
   *  validator reports. A composition pack persists its decomposed catalog, so
   *  the validator says `codex` where the owner surface says `codex-pack`;
   *  the server joins through installed-pack inventory before reporting. */
  slug: string;
  /** Installed version when the inventory recorded one. */
  version?: number;
  /** Validator error codes, e.g. `CLI_LEGACY_SUPERVISION`. */
  codes: ReadonlyArray<string>;
  /** Human-readable first failure, for the row's tooltip / detail line. */
  detail: string;
}

/** D-259 — `packs.unrunnable` rpc result. Re-derived per call; never stored. */
export interface PacksUnrunnableResult {
  findings: ReadonlyArray<UnrunnablePackRow>;
  /** False when at least one finding could not be joined to an installed pack.
   *  The caller may still render the row, but must not link to a pack detail
   *  page it cannot prove exists — a plausible-looking dead link reads as
   *  "nothing here" and "couldn't find it" at once. */
  exact_pack_identities: boolean;
}

/** Add-a-pack (2026-07-01) — `packs.resolveBySlug` rpc result: a manifest-only
 *  server fetch that populates the install consent dialog BEFORE the user
 *  commits (the trusted `packs.installBySlug` does the actual install on
 *  confirm). Server-fetch keeps the marketplace-authoritative trust model — the
 *  webclient never fetches/trusts the manifest itself (role-boundary + the
 *  "never trust a client-supplied publisher_id" invariant). `manifest` is null
 *  on any failure, with `failure` carrying targeted copy for the dialog. */
export interface PacksResolveResult {
  manifest: BulkPackManifest | null;
  /** SHA-256 of the exact marketplace manifest rendered for consent. The pack
   * detail echoes it to `packs.installBySlug`; an update refuses if the latest
   * artifact no longer matches this review anchor. */
  manifest_review_hash?: string;
  /** D-211 Slice 5 — same pre-update review projection as `PackListEntry`, for
   * marketplace manifests resolved by slug before install acceptance. */
  owner_operation_review?: ReadonlyArray<import('./owner-operation-override.js').OwnerOperationUpdateReviewItem>;
  /** D-221 — live Records transition facts bound into manifest_review_hash. */
  records_review?: import('./records.js').RecordsPackUpdateReview;
  /** Present iff `manifest` is null.
   *   - `unresolved`  — no published pack at this slug (a clean 404)
   *   - `fetch_error` — could not reach / read the marketplace
   *   - `validation`  — the fetched manifest failed schema validation
   *   - `version`     — manifest_version newer than this runtime supports */
  failure?: {
    code: 'unresolved' | 'fetch_error' | 'validation' | 'version';
    message: string;
  };
}

/** D-145 PA10 follow-on Slice B — `packs.uninstall` rpc result.
 *
 *  Mirrors the engine's transactional shape for the install rpc
 *  (`BulkPackInstallResultLike`) but inverted: a single `ok` flag, a
 *  per-category `removed` breakdown for the post-uninstall toast / audit
 *  surface, and an optional `failure` block when the manifest could not
 *  be resolved, a cleanup safety gate refused removal, or a substrate call
 *  threw.
 *
 *  Closed failure-code list (kept narrow so the Settings panel renders
 *  targeted copy):
 *    - `not_found`   — no bundled manifest matches `pack_slug`. Either
 *      the slug is a typo or the pack file was removed from
 *      `community/packs/`. Server-side `packs.list` would not surface
 *      the row, so this is reachable only via stale UI state /
 *      concurrent removal — the UI should refresh.
 *    - `webhook_cleanup_required` — an operation-bound webhook may still be
 *      attached to workflow-owned resources, so its cleanup authority stays.
 *    - `unexpected`  — a substrate call (SI uninstall / recipe delete)
 *      threw. The result `removed` block still reports whatever
 *      succeeded BEFORE the throw — best-effort, like the install
 *      rollback path.
 *
 *  There is no `permission_denied` code: the `packs.` reserved-prefix
 *  in `MCP_RESERVED_RPC_PREFIXES` is the single auth gate (same stance
 *  as `packs.install`'s auto-added `BULK_PACK_INSTALL_PERMISSION` —
 *  invoking the reserved-prefix rpc IS the consent signal for the
 *  uninstall action).
 *
 *  Idempotency: uninstalling a pack that has nothing left to remove
 *  returns `ok: true` with zero counts. `recipeStore.delete` returns
 *  `false` for already-gone recipes — folds cleanly into the `removed`
 *  counts. Concurrent uninstall races converge to the same final state. */
export interface BulkPackUninstallResultLike {
  ok: boolean;
  removed: {
    /** Recipe IDs the per-pair `RecipeStore.delete` actually removed
     *  (returned `true`). Recipes the manifest references but that
     *  weren't in the stored set (concurrent uninstall, pre-existing
     *  drift) do not appear here. */
    recipes: ReadonlyArray<string>;
    /** D-139 P6.B — body-content MCP visibility grants the engine
     *  revoked. Today's server bin does not wire the body-grants
     *  substrate, so this is always `[]` for v1 — kept on the result
     *  shape forward-compat so future store wiring lands without an rpc
     *  signature bump. */
    body_grants: ReadonlyArray<string>;
  };
  /** D-225 Slice 2 — the MCP connection this uninstall ALSO removed, present
   *  only for a generated pack (a pack and its connection are one thing to the
   *  owner, so removing one removes the other).
   *
   *  ⚠ On the surface: the connection holds the enrolled CREDENTIAL, and
   *  deleting it reads smaller than it is from a button labelled "remove pack".
   *  This field exists so the surface can SAY what happened instead of leaving
   *  the owner to discover it later — omitting it is what makes the side effect
   *  silent. Absent for every ordinary pack. */
  removed_connection?: string;
  /** D-221 Records data disposition, present only when the uninstalled pack
   * owns a Records namespace. Retain/orphan is the default. */
  records?: {
    owner: import('./records.js').RecordsPackRef;
    disposition: 'retain' | 'export' | 'purge';
    retired_event_count: number;
    export?: import('./records.js').RecordsExportEnvelope;
  };
  /** R2 build step 4c.3 — "this disables N recipes" uninstall disclosure
   *  (recipe-identity doc §1.6). The SURVIVING recipes (NOT this pack's own
   *  — those are deleted, listed in `removed.recipes`) that go BLOCKED
   *  because uninstalling the pack removed their last provider. Two removal
   *  shapes feed the walk: the pack's local-catalog-bound connections lose
   *  their binding (WHOLE-connection removal), and a surviving
   *  registered-vendor connection loses the ops granted only via this pack's
   *  operation groups (GRANT-only shrink — the §1.6 follow-on). The doc §1.6
   *  reverse-walk returns every worsening; the handler keeps the
   *  `after === 'blocked'` subset here — a recipe that merely degrades (loses
   *  an OPTIONAL capability but keeps running) is surfaced on `would_degrade`
   *  instead. Each entry's `before` distinguishes a fully-working recipe
   *  (`runnable`) from an already-degraded one.
   *
   *  DISCLOSURE, NOT enforcement — RECOVERABLE: this never deletes the
   *  surviving recipe (the forbidden destructive failure, doc §1.6); reinstall
   *  the pack or bind another provider and the next recompute lifts it back to
   *  `runnable`. Handler-populated (NOT an engine field), computed BEFORE the
   *  uninstall mutates (the providers must still be bound). Present (non-empty)
   *  only on `ok: true` when ≥1 survivor goes blocked AND the handler was wired
   *  with the runnability read; omitted otherwise — like `born_blocked` on
   *  install. */
  would_disable?: ReadonlyArray<RunnabilityTransition>;
  /** R2 §1.6 follow-on — the DEGRADED counterpart to `would_disable`: surviving
   *  recipes whose runnability worsens to `degraded` (an OPTIONAL capability
   *  loses its last provider; the recipe keeps running with those steps
   *  skipped — the degraded run is AUTHORED, doc §1.5). Providers only shrink
   *  under removal, so these are exactly the `runnable → degraded` transitions
   *  (a `degraded` recipe can only stay or go `blocked`). Same population
   *  rules as `would_disable`: survivors only (the pack's own recipes
   *  excluded), computed pre-mutation, present non-empty on `ok: true` only. */
  would_degrade?: ReadonlyArray<RunnabilityTransition>;
  failure?: {
    code: 'not_found' | 'webhook_cleanup_required' | 'unexpected';
    message: string;
  };
}

/** Slugs (recipe + pack) follow the same URL-safe convention used by
 *  the marketplace listing layer — lowercase, digits, hyphens. Validates
 *  pack slugs at parse time + recipe slugs inside `recipes[]`. Exported as the
 *  single source of truth for the dot-free slug shape — D-182 `op-model.ts`
 *  reuses it to validate the segments of a two-tier op id + `depends_on` entry. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** v3 `repo` field — true iff the value parses as an https URL.
 *  Shared by the pack-manifest validator here and the recipe
 *  structural validator (`metadata.repo`). */
export const isHttpsRepoUrl = (value: unknown): value is string => {
  // Raw-prefix check on top of URL parsing: renderers gate on the
  // literal `https://` prefix, so parser-normalized forms (leading
  // whitespace, `HTTPS://`, `https:example.com`) must not validate —
  // they would store fine but silently fail to render.
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

// ── D-165 app-pack v2 validation helpers ──
type AddPackIssue =
  (severity: 'error' | 'warning', code: string, path: string, message: string) => void;

const PACK_CONTENT_KIND_SET: ReadonlySet<string> = new Set(PACK_CONTENT_KINDS);
const PACK_INGREDIENT_ROLE_SET: ReadonlySet<string> = new Set(PACK_INGREDIENT_ROLES);
const PACK_CHANNEL_CAPABILITY_SET: ReadonlySet<string> = new Set(PACK_CHANNEL_CAPABILITIES);

const isPositiveInt = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);


const declaredPackRecipeSlugs = (
  manifest: Record<string, unknown>,
  isV2: boolean,
): ReadonlySet<string> => {
  const slugs = new Set<string>();
  if (Array.isArray(manifest.recipes)) {
    for (const entry of manifest.recipes) {
      if (isObjectRecord(entry) && typeof entry.slug === 'string') {
        slugs.add(entry.slug);
      }
    }
  }
  if (isV2 && Array.isArray(manifest.contents)) {
    for (const entry of manifest.contents) {
      if (
        isObjectRecord(entry)
        && entry.type === 'recipe'
        && typeof entry.slug === 'string'
      ) {
        slugs.add(entry.slug);
      }
    }
  }
  return slugs;
};

/** Validate one recipe ref (slug + version), tracking per-array slug
 *  uniqueness in `seen`. Shared by the v1 `recipes[]` loop, the v2
 *  `recipes[]` alias, and recipe `contents[]` entries. Each array passes a
 *  FRESH `seen` — a recipe legitimately appearing in both `recipes[]` and
 *  `contents[]` is merged by the normalizer, not flagged as a duplicate. */
const validatePackRecipeRef = (
  entry: unknown, path: string, seen: Set<string>, add: AddPackIssue,
): void => {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    add('error', 'pack_recipe_entry_shape', path, 'recipe entry must be an object');
    return;
  }
  const r = entry as Record<string, unknown>;
  if (typeof r.slug !== 'string' || r.slug.length === 0) {
    add('error', 'pack_recipe_slug_required', `${path}.slug`, 'recipe slug is required');
  } else if (!SLUG_RE.test(r.slug)) {
    add('error', 'pack_recipe_slug_format', `${path}.slug`,
      `recipe slug must match ${SLUG_RE.source}; got ${JSON.stringify(r.slug)}`);
  } else if (seen.has(r.slug)) {
    add('error', 'pack_recipe_slug_duplicate', `${path}.slug`,
      `recipe slug ${JSON.stringify(r.slug)} appears more than once in the pack`);
  } else {
    seen.add(r.slug);
  }
  if (!isPositiveInt(r.version)) {
    add('error', 'pack_recipe_version_invalid', `${path}.version`,
      'recipe version must be a positive integer');
  }
  // Add-a-pack (2026-06-30) — OPTIONAL embedded body. When present it must be an
  // object whose `recipe_id` matches the entry's `slug` (slug-confusion guard —
  // a self-contained pack must not smuggle a body under a different slug than it
  // claims, mirroring `installPackBySlug`'s resolver check). Deep recipe-shape
  // validation is deferred to install time; here we only gate the identity link.
  if (r.recipe !== undefined) {
    if (r.recipe === null || typeof r.recipe !== 'object' || Array.isArray(r.recipe)) {
      add('error', 'pack_recipe_body_shape', `${path}.recipe`,
        'embedded recipe body must be an object');
    } else {
      const bodyId = (r.recipe as Record<string, unknown>).recipe_id;
      if (typeof r.slug === 'string' && bodyId !== r.slug) {
        add('error', 'pack_recipe_body_slug_mismatch', `${path}.recipe.recipe_id`,
          `embedded recipe body recipe_id ${JSON.stringify(bodyId)} must equal the entry slug ${JSON.stringify(r.slug)}`);
      }
    }
  }
};

/** Validate one `PackContentRef` (v2 `contents[]` entry). Recipe entries
 *  delegate to `validatePackRecipeRef` (sharing `recipeSeen`). */
const validatePackContentRef = (
  entry: unknown, path: string, recipeSeen: Set<string>, add: AddPackIssue,
): void => {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    add('error', 'pack_content_entry_shape', path, 'content entry must be an object');
    return;
  }
  const c = entry as Record<string, unknown>;
  if (typeof c.type !== 'string' || !PACK_CONTENT_KIND_SET.has(c.type)) {
    add('error', 'pack_content_type_unknown', `${path}.type`,
      `content type must be one of ${PACK_CONTENT_KINDS.join('|')}`);
    return;
  }
  switch (c.type) {
    case 'recipe':
      validatePackRecipeRef(c, path, recipeSeen, add);
      if (c.visible !== undefined && typeof c.visible !== 'boolean') {
        add('error', 'pack_content_recipe_visible_shape', `${path}.visible`,
          'recipe content visible must be a boolean when present');
      }
      break;
    case 'ingredient': {
      const bySlug = c.slug !== undefined || c.version !== undefined || c.role !== undefined;
      const byId = c.ingredient_id !== undefined || c.ingredient_version !== undefined;
      if (bySlug && byId) {
        add('error', 'pack_content_ingredient_addressing', path,
          'ingredient content must use exactly one addressing mode: (slug + version) OR (ingredient_id + ingredient_version), not both');
      } else if (!bySlug && !byId) {
        add('error', 'pack_content_ingredient_addressing', path,
          'ingredient content must declare (slug + version) or (ingredient_id + ingredient_version)');
      } else if (bySlug) {
        if (typeof c.slug !== 'string' || c.slug.length === 0 || !SLUG_RE.test(c.slug)) {
          add('error', 'pack_content_ingredient_slug', `${path}.slug`,
            `ingredient content slug must match ${SLUG_RE.source}`);
        }
        if (!isPositiveInt(c.version)) {
          add('error', 'pack_content_ingredient_version', `${path}.version`,
            'ingredient content version must be a positive integer');
        }
        if (c.role !== undefined && !PACK_INGREDIENT_ROLE_SET.has(c.role as string)) {
          add('error', 'pack_content_ingredient_role', `${path}.role`,
            `ingredient content role must be one of ${PACK_INGREDIENT_ROLES.join('|')}`);
        }
      } else {
        if (typeof c.ingredient_id !== 'string' || c.ingredient_id.length === 0) {
          add('error', 'pack_content_ingredient_id', `${path}.ingredient_id`,
            'ingredient content ingredient_id must be a non-empty string');
        }
        if (!isPositiveInt(c.ingredient_version)) {
          add('error', 'pack_content_ingredient_version', `${path}.ingredient_version`,
            'ingredient content ingredient_version must be a positive integer');
        }
      }
      break;
    }
    case 'operation_group':
      if (typeof c.ingredient_id !== 'string' || c.ingredient_id.length === 0) {
        add('error', 'pack_content_group_ingredient_id', `${path}.ingredient_id`,
          'operation_group content ingredient_id must be a non-empty string');
      }
      if (typeof c.group_id !== 'string' || c.group_id.length === 0) {
        add('error', 'pack_content_group_id', `${path}.group_id`,
          'operation_group content group_id must be a non-empty string');
      }
      break;
    case 'channel_binding':
      if (typeof c.channel_name !== 'string' || c.channel_name.length === 0) {
        add('error', 'pack_content_channel_name', `${path}.channel_name`,
          'channel_binding channel_name must be a non-empty string');
      }
      if (typeof c.capability !== 'string' || !PACK_CHANNEL_CAPABILITY_SET.has(c.capability)) {
        add('error', 'pack_content_channel_capability', `${path}.capability`,
          `channel_binding capability must be one of ${PACK_CHANNEL_CAPABILITIES.join('|')}`);
      }
      if (typeof c.bound_to_catalog !== 'string' || c.bound_to_catalog.length === 0) {
        add('error', 'pack_content_channel_catalog', `${path}.bound_to_catalog`,
          'channel_binding bound_to_catalog must be a non-empty ingredient_id');
      }
      // conversation_policy: object-shape only — the D-160 channel substrate
      // owns its deep validation at channel-registration time.
      if (c.conversation_policy == null || typeof c.conversation_policy !== 'object'
        || Array.isArray(c.conversation_policy)) {
        add('error', 'pack_content_channel_policy', `${path}.conversation_policy`,
          'channel_binding conversation_policy must be an object (the channel substrate validates its shape)');
      }
      break;
    case 'policy':
      if (typeof c.policy_id !== 'string' || c.policy_id.length === 0) {
        add('error', 'pack_content_policy_id', `${path}.policy_id`,
          'policy content policy_id must be a non-empty string');
      }
      break;
    case 'composition':
      // D-170 owns strict by-value composition validation. The pack
      // contract only admits the discriminant so pure authoring validation
      // can unwrap `content.composition`.
      break;
  }
};

/** Validate one `PackDependency` (v2 `dependencies[]` entry). */
const validatePackDependency = (entry: unknown, path: string, add: AddPackIssue): void => {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    add('error', 'pack_dependency_shape', path, 'dependency entry must be an object');
    return;
  }
  const d = entry as Record<string, unknown>;
  if (d.type !== 'ingredient' && d.type !== 'pack') {
    add('error', 'pack_dependency_type', `${path}.type`,
      `dependency type must be one of ${PACK_DEPENDENCY_KINDS.join('|')}`);
    return;
  }
  if (d.min_version !== undefined && !isPositiveInt(d.min_version)) {
    add('error', 'pack_dependency_min_version', `${path}.min_version`,
      'dependency min_version must be a positive integer when present');
  }
  if (d.type === 'pack') {
    if (typeof d.slug !== 'string' || d.slug.length === 0 || !SLUG_RE.test(d.slug)) {
      add('error', 'pack_dependency_slug', `${path}.slug`,
        `pack dependency slug must match ${SLUG_RE.source}`);
    }
  } else {
    // ingredient: exactly one of slug | ingredient_id.
    const bySlug = typeof d.slug === 'string';
    const byId = typeof d.ingredient_id === 'string';
    if (bySlug === byId) {
      add('error', 'pack_dependency_ingredient_addressing', path,
        'ingredient dependency must declare exactly one of slug or ingredient_id');
    } else if (bySlug && (d.slug as string).length > 0 && !SLUG_RE.test(d.slug as string)) {
      add('error', 'pack_dependency_slug', `${path}.slug`,
        `ingredient dependency slug must match ${SLUG_RE.source}`);
    }
  }
};

/** Collapse either manifest version to one `PackInstallPlan` (spec
 *  § Manifest extension — "one internal InstallPlan"). Recipe refs from
 *  `recipes[]` and recipe `contents[]` merge + dedup by slug+version; the
 *  `contents` list lifts v1 recipes into recipe refs so v1 and v2 are
 *  indistinguishable downstream. Pass a manifest that has PARSED ok. */
export const normalizeBulkPackInstallPlan = (manifest: BulkPackManifest): PackInstallPlan => {
  const recipeContent: PackRecipeContentRef[] = [];
  const otherContent: PackContentRef[] = [];
  const recipes: BulkPackRecipeRef[] = [];
  // key → index in `recipes`. A Map (not a Set) so a later occurrence carrying an
  // embedded body can backfill an earlier bodyless ref for the same slug+version
  // (Add-a-pack: a self-contained pack lists its bodies on `recipes[]`, which the
  // parser iterates AFTER `contents[]` — without the backfill a bodyless
  // `contents[]` recipe ref would shadow the body and it would never install).
  const recipeIndex = new Map<string, number>();
  const addRecipe = (
    slug: string,
    version: number,
    visible?: boolean,
    recipe?: RecipeDefinition,
  ): void => {
    const key = `${slug}@${version}`;
    const existing = recipeIndex.get(key);
    if (existing !== undefined) {
      if (recipe !== undefined && recipes[existing].recipe === undefined) {
        recipes[existing] = { ...recipes[existing], recipe };
      }
      return;
    }
    recipeIndex.set(key, recipes.length);
    recipes.push(recipe === undefined ? { slug, version } : { slug, version, recipe });
    recipeContent.push(visible === undefined
      ? { type: 'recipe', slug, version }
      : { type: 'recipe', slug, version, visible });
  };
  // `contents[]` is meaningful ONLY on a v2 manifest. The parser merely
  // WARNS about a stray `contents[]` on a v1 manifest (`pack_contents_ignored_v1`)
  // — it doesn't strip the field — so honor that "ignored" semantic here:
  // a non-v2 manifest contributes nothing from `contents[]`. Without this
  // guard a v1 pack smuggling `contents: [{ type: 'recipe', ... }]` would
  // see those recipes lifted into the install set (and other kinds echoed as
  // deferred contents), bypassing the v1 recipe-only disclosure. A well-formed
  // v1 pack's recipes still lift into recipe-content below via `recipes[]`, so
  // v1 and v2 stay indistinguishable downstream for legitimate manifests.
  const contents = manifest.manifest_version === BULK_PACK_MANIFEST_VERSION_V2
    ? (manifest.contents ?? [])
    : [];
  // `contents[]` is the v2-PRIMARY surface; iterate it FIRST so that when a
  // recipe appears in both `contents[]` (rich form, carries `visible`) and the
  // `recipes[]` compat alias (bare form), the contents entry wins the
  // slug+version dedup and its `visible` flag is preserved (not dropped).
  for (const c of contents) {
    if (c.type === 'recipe') addRecipe(c.slug, c.version, c.visible);
    else otherContent.push(c);
  }
  for (const r of manifest.recipes ?? []) addRecipe(r.slug, r.version, undefined, r.recipe);
  return { recipes, contents: [...recipeContent, ...otherContent] };
};

/** Parse + validate an unknown JSON payload as a bulk-pack manifest.
 *  Errors block install; warnings surface in the dialog without
 *  blocking. Caller still resolves each `recipes[]` entry against the
 *  marketplace before the atomic-install transaction starts (see
 *  `packages/marketplace/src/bulk-pack-resolver.ts`). */
export const parseBulkPackManifest = (input: unknown): BulkPackParseResult => {
  const issues: BulkPackIssue[] = [];
  const add = (severity: 'error' | 'warning', code: string, path: string, message: string): void => {
    issues.push({ severity, code, path, message });
  };

  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    add('error', 'pack_not_object', '', 'pack manifest must be an object');
    return { ok: false, issues };
  }

  // Storable-encoding sweep over the WHOLE document, before any field checks.
  // The two characters that have actually broken a publish sat at
  // `.contents[0].composition.operations[N].description` and
  // `…request_schema.properties.body.fileName.pattern` — neither is a field any
  // per-field validator inspects, so a field-scoped check would have caught
  // neither while appearing to cover them. Reaches the authoring gate for free:
  // `validatePackStructure` maps these issues through `fromBulkPackIssue`.
  const unstorable = findUnstorableStrings(input);
  for (const f of unstorable) {
    add('error', 'unstorable_encoding', f.path.replace(/^\./, ''), describeUnstorable(f));
  }
  // Never let a capped list read as "that is all of them".
  if (unstorable.length >= UNSTORABLE_FINDING_LIMIT) {
    add('error', 'unstorable_encoding_truncated', '',
      `report capped at ${UNSTORABLE_FINDING_LIMIT} findings; there may be more`);
  }

  const obj = input as Record<string, unknown>;

  // manifest_version — must be 1 (recipe-only) or 2 (app-pack w/ contents).
  if (obj.manifest_version === undefined) {
    add('error', 'pack_version_required', 'manifest_version', 'manifest_version is required');
  } else if (obj.manifest_version !== BULK_INSTALL_PACK_VERSION
    && obj.manifest_version !== BULK_PACK_MANIFEST_VERSION_V2) {
    add('error', 'pack_version_unsupported', 'manifest_version',
      `manifest_version must be ${BULK_INSTALL_PACK_VERSION} or ${BULK_PACK_MANIFEST_VERSION_V2}; got ${JSON.stringify(obj.manifest_version)}`);
  }
  // v2 enables the `contents[]` / `dependencies[]` substrate + makes
  // `recipes[]` optional (recipes can live in contents). A non-2 value
  // (including a malformed one) takes the v1 path so we don't mis-validate.
  const isV2 = obj.manifest_version === BULK_PACK_MANIFEST_VERSION_V2;

  // slug — required, URL-safe.
  if (typeof obj.slug !== 'string' || obj.slug.length === 0) {
    add('error', 'pack_slug_required', 'slug', 'slug is required');
  } else if (!SLUG_RE.test(obj.slug)) {
    add('error', 'pack_slug_format', 'slug',
      `slug must match ${SLUG_RE.source}; got ${JSON.stringify(obj.slug)}`);
  }

  // publisher — required string.
  if (typeof obj.publisher !== 'string' || obj.publisher.length === 0) {
    add('error', 'pack_publisher_required', 'publisher', 'publisher is required');
  }

  // name + description + version — required.
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    add('error', 'pack_name_required', 'name', 'name is required');
  }
  if (typeof obj.description !== 'string') {
    add('error', 'pack_description_required', 'description', 'description is required');
  }
  // repo — optional; when present must be an https URL (author's
  // source repo, where issues/support route).
  if (obj.repo !== undefined && !isHttpsRepoUrl(obj.repo)) {
    add('error', 'pack_repo_invalid', 'repo',
      'repo must be an https URL when present');
  }
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1) {
    add('error', 'pack_version_field_invalid', 'version', 'version must be a positive integer');
  }

  // recipes[] — v1: required, length 1..MAX. v2: OPTIONAL (recipes may
  // live in contents[]); validate shape + cap when present. Per-entry
  // checks share `validatePackRecipeRef` (extracted so v1 / v2-alias /
  // recipe-contents stay in lock-step).
  if (!isV2) {
    if (!Array.isArray(obj.recipes)) {
      add('error', 'pack_recipes_required', 'recipes', 'recipes must be an array');
    } else if (obj.recipes.length === 0) {
      add('error', 'pack_recipes_empty', 'recipes', 'recipes must contain at least one entry');
    } else if (obj.recipes.length > BULK_PACK_MAX_RECIPES) {
      add('error', 'pack_recipes_too_many', 'recipes',
        `recipes may contain at most ${BULK_PACK_MAX_RECIPES} entries; got ${obj.recipes.length}`);
    } else {
      const seen = new Set<string>();
      obj.recipes.forEach((entry: unknown, idx: number) =>
        validatePackRecipeRef(entry, `recipes[${idx}]`, seen, add));
    }
  } else if (obj.recipes !== undefined) {
    // v2 recipes[] alias — optional; shape + cap, no required/empty error.
    if (!Array.isArray(obj.recipes)) {
      add('error', 'pack_recipes_required', 'recipes', 'recipes must be an array when present');
    } else if (obj.recipes.length > BULK_PACK_MAX_RECIPES) {
      add('error', 'pack_recipes_too_many', 'recipes',
        `recipes may contain at most ${BULK_PACK_MAX_RECIPES} entries; got ${obj.recipes.length}`);
    } else {
      const seen = new Set<string>();
      obj.recipes.forEach((entry: unknown, idx: number) =>
        validatePackRecipeRef(entry, `recipes[${idx}]`, seen, add));
    }
  }

  // ── D-165 app-pack v2 — contents[] / dependencies[]. ──
  if (isV2) {
    if (obj.contents !== undefined) {
      if (!Array.isArray(obj.contents)) {
        add('error', 'pack_contents_shape', 'contents', 'contents must be an array when present');
      } else if (obj.contents.length > BULK_PACK_MAX_CONTENTS) {
        add('error', 'pack_contents_too_many', 'contents',
          `contents may contain at most ${BULK_PACK_MAX_CONTENTS} entries; got ${obj.contents.length}`);
      } else {
        const recipeSeen = new Set<string>();
        obj.contents.forEach((entry: unknown, idx: number) =>
          validatePackContentRef(entry, `contents[${idx}]`, recipeSeen, add));
      }
    }
    // At least one installable entry — recipes[] or contents[] non-empty.
    const recipesNonEmpty = Array.isArray(obj.recipes) && obj.recipes.length > 0;
    const contentsNonEmpty = Array.isArray(obj.contents) && obj.contents.length > 0;
    if (!recipesNonEmpty && !contentsNonEmpty) {
      add('error', 'pack_contents_required', 'contents',
        'a manifest_version 2 pack must declare at least one entry in contents[] or recipes[]');
    }
    if (obj.dependencies !== undefined) {
      if (!Array.isArray(obj.dependencies)) {
        add('error', 'pack_dependencies_shape', 'dependencies',
          'dependencies must be an array when present');
      } else {
        obj.dependencies.forEach((entry: unknown, idx: number) =>
          validatePackDependency(entry, `dependencies[${idx}]`, add));
      }
    }
  } else {
    // v1 carrying v2-only fields — ignored at install; warn so the author
    // notices the version mismatch instead of silently losing the contents.
    if (obj.contents !== undefined) {
      add('warning', 'pack_contents_ignored_v1', 'contents',
        'contents[] is ignored on manifest_version 1; bump to manifest_version 2 to compose app-pack contents');
    }
    if (obj.dependencies !== undefined) {
      add('warning', 'pack_dependencies_ignored_v1', 'dependencies',
        'dependencies[] is ignored on manifest_version 1');
    }
  }

  // pack_kind — optional enum (any version). artifact_type — optional,
  // must be 'pack' when present.
  if (obj.pack_kind !== undefined && !isPackKind(obj.pack_kind)) {
    add('error', 'pack_kind_unknown', 'pack_kind',
      `pack_kind must be one of ${PACK_KINDS.join('|')} when present`);
  }
  if (obj.service_kind !== undefined && !isPackServiceKind(obj.service_kind)) {
    add('error', 'pack_service_kind_unknown', 'service_kind',
      `service_kind must be one of ${PACK_SERVICE_KINDS.join('|')} when present`);
  }
  if (obj.artifact_type !== undefined && obj.artifact_type !== 'pack') {
    add('error', 'pack_artifact_type_invalid', 'artifact_type',
      "artifact_type must be 'pack' when present");
  }

  // D-200 Slice 6 — Seller presentation metadata only. The descriptor must
  // prove a six-recipe workflow shape inside one v2 workflow app pack; it
  // cannot carry price, provider evidence, access, or execution authority.

  // requires[] — required array, must include the install permission.
  if (!Array.isArray(obj.requires)) {
    add('error', 'pack_requires_required', 'requires', 'requires must be an array');
  } else {
    if (obj.requires.some((p) => typeof p !== 'string' || p.length === 0)) {
      add('error', 'pack_requires_shape', 'requires', 'requires entries must be non-empty strings');
    }
    if (!obj.requires.includes(BULK_PACK_INSTALL_PERMISSION)) {
      add('error', 'pack_requires_install_permission', 'requires',
        `requires must include ${JSON.stringify(BULK_PACK_INSTALL_PERMISSION)}`);
    }
  }

  // tags[] — optional but if present must be string[].
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.some((t) => typeof t !== 'string')) {
      add('error', 'pack_tags_shape', 'tags', 'tags must be an array of strings when present');
    }
  } else {
    // Tags are conventionally always present even if empty; warn so
    // marketplace UI can render a "no tags" badge without surprise.
    add('warning', 'pack_tags_missing', 'tags', 'tags is conventionally an array (may be empty)');
  }

  // D-139 P6.B — post_substrate_canary boolean (optional).
  if (obj.post_substrate_canary !== undefined && typeof obj.post_substrate_canary !== 'boolean') {
    add(
      'error',
      'pack_post_substrate_canary_shape',
      'post_substrate_canary',
      'post_substrate_canary must be a boolean when present',
    );
  }

  // D-139 P6.B — launch_flag non-empty string (optional). Format
  // convention: `packs.<slug_underscored>.<flag>` (e.g.
  // `packs.crm_commitment_tracker.enabled`); validator enforces
  // shape only — runtime flag-store decides resolution.
  if (obj.launch_flag !== undefined) {
    if (typeof obj.launch_flag !== 'string' || obj.launch_flag.length === 0) {
      add(
        'error',
        'pack_launch_flag_shape',
        'launch_flag',
        'launch_flag must be a non-empty string when present',
      );
    }
  }

  // D-145 PA10 — pre_install boolean (optional). When true, the
  // server's foundation-pack boot wire auto-installs the pack on
  // first init. The flag is reserved for first-party (`recued-core`)
  // publishers — third-party packs marked `pre_install: true` get
  // rejected so community packs can't ship without user consent.
  if (obj.pre_install !== undefined) {
    if (typeof obj.pre_install !== 'boolean') {
      add(
        'error',
        'pack_pre_install_shape',
        'pre_install',
        'pre_install must be a boolean when present',
      );
    } else if (obj.pre_install === true && !publisherMayDeclare(obj.publisher, 'pre_install')) {
      add(
        'error',
        'pack_pre_install_publisher',
        'pre_install',
        `pre_install: true is reserved for the 'recued-core' publisher; got ${JSON.stringify(obj.publisher)}`,
      );
    }
  }

  // D-194 — connection_requirements[] (optional, first-party-only). Declaring
  // connection descriptors is reserved for the `recued-core` publisher, mirroring
  // the `pre_install` gate above: a third-party pack carrying the field is
  // rejected wholesale (community packs bind a compiled-in vendor leaf by slug or
  // use the generic BYO form — they never author a descriptor). Per-entry shape
  // defers to the one source of truth, `validateConnectionRequirementShape`.
  if (obj.connection_requirements !== undefined) {
    if (!Array.isArray(obj.connection_requirements)) {
      add(
        'error',
        'pack_connection_requirements_shape',
        'connection_requirements',
        'connection_requirements must be an array when present',
      );
    } else if (
      obj.connection_requirements.length > 0
      && !publisherMayDeclare(obj.publisher, 'connection_requirements')
    ) {
      // Gate the meaningful assertion — DECLARING a descriptor (§2 "Only
      // `recued-core` packs may declare a connection descriptor") — not the mere
      // presence of the key. An empty array declares nothing, so it is a harmless
      // no-op for any publisher (mirrors `pre_install` gating `=== true`).
      add(
        'error',
        'pack_connection_requirements_publisher',
        'connection_requirements',
        `connection_requirements is reserved for the 'recued-core' publisher; got ${JSON.stringify(obj.publisher)}`,
      );
    } else if (obj.connection_requirements.length > BULK_PACK_MAX_CONNECTION_REQUIREMENTS) {
      add(
        'error',
        'pack_connection_requirements_too_many',
        'connection_requirements',
        `connection_requirements may contain at most ${BULK_PACK_MAX_CONNECTION_REQUIREMENTS} entries; got ${obj.connection_requirements.length}`,
      );
    } else {
      obj.connection_requirements.forEach((entry: unknown, idx: number) => {
        const path = `connection_requirements[${idx}]`;
        for (const msg of validateConnectionRequirementShape(entry)) {
          add('error', 'pack_connection_requirement_invalid', path, msg);
        }
      });
    }
  }

  // D-223 — connection_hints[] (optional, ANY publisher). The counterpart to the
  // gate above: a hint supplies a VALUE for a visible, editable field, so a wrong
  // or hostile one is something the owner reads and corrects. It never sets
  // schema — `hidden` / `readonly` / `showWhen` live in vendor schemas that ship
  // as code, and no manifest reaches them (D-223 § 2.1). Hence no publisher gate
  // here; the admission filter IS the control, and it is the same one the setup
  // guide applies to inferred suggestions.
  if (obj.connection_hints !== undefined) {
    if (!Array.isArray(obj.connection_hints)) {
      add(
        'error',
        'pack_connection_hints_shape',
        'connection_hints',
        'connection_hints must be an array when present',
      );
    } else if (obj.connection_hints.length > BULK_PACK_MAX_CONNECTION_HINTS) {
      add(
        'error',
        'pack_connection_hints_too_many',
        'connection_hints',
        `connection_hints may contain at most ${BULK_PACK_MAX_CONNECTION_HINTS} entries; got ${obj.connection_hints.length}`,
      );
    } else {
      obj.connection_hints.forEach((entry: unknown, idx: number) => {
        validateConnectionHintShape(entry, `connection_hints[${idx}]`, (code, path, message) => {
          add('error', code, path, message);
        });
      });
    }
  }

  // D-201 Slice 0 — portable webhook requirements.  Unlike D-194 connection
  // descriptors this field is safe for any publisher: authors choose only a
  // logical binding + registered profile ids, never crypto/URLs/secrets.  The
  // shared validator covers profile existence, event compatibility, source-
  // truth strength, registration/environment dependencies, and payload scope.
  if (obj.webhook_requirements !== undefined) {
    for (const issue of validateWebhookRequirements(obj.webhook_requirements)) {
      add(
        'error',
        issue.code === 'shape'
          ? 'pack_webhook_requirements_shape'
          : `pack_webhook_requirement_${issue.code}`,
        issue.path,
        issue.message,
      );
    }
  }

  // D-139 P6.B — mcp_body_visibility_grants[] (optional, closed list).
  if (obj.mcp_body_visibility_grants !== undefined) {
    if (!Array.isArray(obj.mcp_body_visibility_grants)) {
      add(
        'error',
        'pack_body_visibility_grants_shape',
        'mcp_body_visibility_grants',
        'mcp_body_visibility_grants must be an array when present',
      );
    } else if (obj.mcp_body_visibility_grants.length > BULK_PACK_MAX_BODY_VISIBILITY_GRANTS) {
      add(
        'error',
        'pack_body_visibility_grants_too_many',
        'mcp_body_visibility_grants',
        `mcp_body_visibility_grants may contain at most ${BULK_PACK_MAX_BODY_VISIBILITY_GRANTS} entries; got ${obj.mcp_body_visibility_grants.length}`,
      );
    } else {
      const seenGrants = new Set<string>();
      obj.mcp_body_visibility_grants.forEach((entry: unknown, idx: number) => {
        const path = `mcp_body_visibility_grants[${idx}]`;
        if (typeof entry !== 'string' || entry.length === 0) {
          add(
            'error',
            'pack_body_visibility_grant_shape',
            path,
            'each grant must be a non-empty string',
          );
          return;
        }
        if (!BULK_PACK_BODY_VISIBILITY_GRANT_KEY_SET.has(entry)) {
          add(
            'error',
            'pack_body_visibility_grant_unknown',
            path,
            `grant ${JSON.stringify(entry)} is not in the closed allow-list (BULK_PACK_BODY_VISIBILITY_GRANT_KEYS = ${BULK_PACK_BODY_VISIBILITY_GRANT_KEYS.join(', ')})`,
          );
          return;
        }
        if (seenGrants.has(entry)) {
          add(
            'error',
            'pack_body_visibility_grant_duplicate',
            path,
            `grant ${JSON.stringify(entry)} appears more than once`,
          );
          return;
        }
        seenGrants.add(entry);
      });
    }
  }

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError) return { ok: false, issues };
  // v2 — lift recipe `contents[]` into `recipes[]` so every existing v1
  // consumer (which reads `manifest.recipes`) sees the full recipe set.
  // The unified typed view is available via normalizeBulkPackInstallPlan.
  if (isV2) {
    const plan = normalizeBulkPackInstallPlan(obj as unknown as BulkPackManifest);
    return {
      ok: true,
      manifest: { ...obj, recipes: plan.recipes } as unknown as BulkPackManifest,
      issues,
    };
  }
  return { ok: true, manifest: obj as unknown as BulkPackManifest, issues };
};

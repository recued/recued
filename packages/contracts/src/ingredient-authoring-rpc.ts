/** D-170 — `ingredient.install` / `ingredient.uninstall` rpc wire types.
 *
 *  The install-integration core (N.14 / N.15 / N.16). The direct-manifest
 *  install path: a caller (Kitchen, Connection Setup, or an AI authoring one
 *  flat file) hands the server a `CompositionIngredient` body — bare (the 1×1
 *  / wide composition) or wrapped in an app_pack (`BulkPackManifest` with a
 *  `composition` content) — and the server validates (decompose + reuse the
 *  D-165 validators), persists the decomposed catalog + entity-schema bodies to
 *  the local manifest store, records `installed_pack` / `installed_ingredient`
 *  inventory, and registers the catalog into the live manifest registry so the
 *  gateway resolves its operations (N.16).
 *
 *  These types live in contracts (not the pure `@recued/ingredient-authoring`
 *  package) because the rpc registry — `SERVER_RPC_METHODS` /
 *  `ServerRpcRegistry` — is contracts-owned, mirroring how `packs.install`
 *  references `BulkPackInstallResultLike` here. Both the server handler and the
 *  webclient install dialog import them from contracts.
 *
 *  Channel-isolation: `ingredient.` is in `MCP_RESERVED_RPC_PREFIXES`. Authoring
 *  installs a callable capability (operations, risk, approval, audit, entity
 *  schemas) — an MCP-channel agent must never author / install / uninstall its
 *  own capability surface. Settings / Kitchen UI is the sole writer.
 *
 *  Spec: D-170 § N.14 (storage, install & uninstall), N.15
 *  (server-side rpc surface), N.16 (gateway resolves decomposed local
 *  manifests). */

import type {
  CompositionAuthModel,
  CompositionSurface,
  InstallGrantSelection,
  PackOperationGroupContentRef,
} from './bulk-pack.js';
import type {
  OperationApproval,
  OperationGroupSpec,
  OperationRiskTier,
} from './ingredient-catalog.js';
import type {
  EntitySchemaIngredientInput,
  MetaFieldType,
} from './entity-schema.js';
import type { IngredientManifest } from './ingredient.js';
import type { EntityFieldPrivacy } from './pii-alias.js';

/** One issue surfaced by the decompose-validator. Mirrors the pure package's
 *  `CompositionValidationIssue` (= `@recued/ingredients` `ValidationIssue`)
 *  field-for-field so the server can pass issues straight onto the wire without
 *  importing the pure package into contracts. */
export interface AuthoringValidationIssue {
  severity: 'error' | 'warn' | 'info';
  code: string;
  path: string;
  message: string;
}

/** What landed on a successful install. A 1×1 composition installs as a
 *  standalone ingredient (no pack); a wider composition installs as an app_pack
 *  whose decomposed children (catalog + entity schemas) are linked via
 *  `installed_pack.ingredient_ids`. */
export type IngredientInstalled =
  | {
      kind: 'ingredient';
      /** The decomposed ingredient slug (the composition's `slug`). */
      ingredient_id: string;
      version: number;
    }
  | {
      kind: 'pack';
      pack_slug: string;
      pack_version: number;
      /** The decomposed catalog slug (the composition's `slug`). */
      catalog_id: string;
      /** Count of entity schemas the composition decomposed into and the store
       *  persisted alongside the catalog (their live runtime consumer is the
       *  future D-167 egress / warehouse path; persisted here for inventory +
       *  uninstall cleanup). */
      entity_schema_count: number;
    };

export interface IngredientInstallArgs {
  /** A `CompositionIngredient` body (bare) OR a `BulkPackManifest` carrying a
   *  `composition` content by value. Discriminated server-side: a
   *  `manifest_version` field ⇒ pack; an `operation_families` field ⇒ bare
   *  composition. Unparseable ⇒ `bad_request`. */
  manifest: unknown;
  /** D-182 §7.1 — the install grant dialog's selection (Access × Scope).
   *  Present ⇒ grant the selected access-tier groups on the pack's bound
   *  connection (PLUS the pack's authored read/`approval: ask` defaults).
   *  ABSENT ⇒ fail closed: grant ONLY the authored read/`approval: ask`
   *  defaults; the silent derived read-tier auto-grant is removed. */
  install_scope?: InstallGrantSelection;
}

export type IngredientInstallResult =
  | {
      ok: true;
      installed: IngredientInstalled;
      /** Every ingredient id written to inventory (the catalog / standalone
       *  ingredient slug). Entity schemas share the catalog's id, so this is
       *  one id per decomposed catalog. */
      ingredient_ids: string[];
      /** Non-blocking issues (warn / info) the install proceeded past. */
      warnings: AuthoringValidationIssue[];
    }
  | {
      ok: false;
      /** `validation_failed` — decompose-validate raised ≥1 error, or the input
       *  shape is wrong for the path (nothing was written; `validated ⇒
       *  decomposable`, so this is the only pre-write failure besides
       *  `bad_request`). `slug_conflict` — the decomposed slug already names a
       *  non-locally-authored ingredient (R12: never silently overwrite a
       *  foreign artifact; save-as-new instead). `unexpected` — a store write
       *  threw after validation passed. */
      code: 'validation_failed' | 'slug_conflict' | 'unexpected';
      message: string;
      issues: AuthoringValidationIssue[];
    };

export interface IngredientUninstallArgs {
  /** Uninstall a whole app_pack (refcount-aware: a child shared by another
   *  installed pack survives). Exactly one of `pack_slug` / `ingredient_id`. */
  pack_slug?: string;
  /** Uninstall a standalone 1×1 ingredient by its slug. Refuses if any
   *  installed pack still lists it (uninstall via the pack instead). */
  ingredient_id?: string;
  /** Override the pin-dependency guard (N.14): proceed even when an installed
   *  recipe still references a child being removed. Default false → the
   *  uninstall is blocked and `blocked_by` lists the dependent recipe ids. */
  force?: boolean;
}

export type IngredientUninstallResult =
  | {
      ok: true;
      /** Ingredient ids actually removed (bodies + inventory + deregistered). */
      removed_ingredient_ids: string[];
      /** True iff an `installed_pack` row existed and was removed. */
      removed_pack: boolean;
    }
  | {
      ok: false;
      /** `pinned` — the pin-guard blocked (see `blocked_by`); retry with
       *  `force: true`. `not_found` — no such pack / ingredient. `bad_request` —
       *  neither or both of `pack_slug` / `ingredient_id`, or a pack-owned child
       *  addressed directly by `ingredient_id`. */
      code: 'pinned' | 'not_found' | 'bad_request';
      message: string;
      /** Recipe ids that still reference a child being removed (when
       *  `code: 'pinned'`). */
      blocked_by?: string[];
    };

// ────────────────────────────────────────────────────────────────
// D-170 N.4 / N.15 — draft store + test-before-save preview
// ────────────────────────────────────────────────────────────────
//
// The AUTHORING side that precedes `ingredient.install`. A draft is an
// in-progress `CompositionIngredient` the Kitchen / Connection Setup editor
// is building; `ingredient.draft.{save,list,get,delete}` persist it per-pair,
// and `ingredient.preview` runs ONE operation through the real gateway
// connection adapter so the author can confirm a read works (and review the
// redacted request target + auth source for a mutation) BEFORE committing the
// draft → installed transition (N.4 test-before-save).
//
// Same channel-isolation as install: every method is under the `ingredient.`
// prefix (in `MCP_RESERVED_RPC_PREFIXES`), so an MCP-channel agent can never
// author / preview / install a capability surface — Settings / Kitchen UI is
// the sole writer.

/** Cap on a stored draft body (serialized JSON bytes). A composition is a
 *  declarative manifest — operation families + entity fields + groups — never
 *  bulk data; 256 KB is generous headroom over the largest realistic HubSpot-
 *  scale composition. A `save` whose body serializes larger fails
 *  `too_large` (nothing is written). Analogous to the by-value composition
 *  caps the pack validator enforces (N.17). */
export const INGREDIENT_DRAFT_MAX_BYTES = 256 * 1024;

/** Cap on the number of drafts retained per pair. A *new* draft (no
 *  `draft_id`, or an id with no existing row) beyond this fails
 *  `limit_reached`; overwriting an existing draft is always allowed. Bounds
 *  the per-pair table — authoring is interactive, so a few hundred in-progress
 *  drafts is already pathological. */
export const INGREDIENT_DRAFT_MAX_COUNT = 200;

/** Cap on a preview's executed-read output payload (serialized JSON bytes)
 *  before truncation. A preview is a glance — "did the read work, what shape
 *  came back" — not a data export; an over-cap response is truncated and the
 *  result carries `truncated: true`. */
export const INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES = 16 * 1024;

/** An in-progress ingredient composition draft. `body` is the (possibly
 *  incomplete / not-yet-valid) `CompositionIngredient` the editor is
 *  authoring — typed `unknown` because validation runs at preview / install
 *  time, NOT at save (N.15 explicitly allows saving an incomplete draft). */
export interface IngredientDraft {
  draft_id: string;
  title?: string;
  body: unknown;
  created_at: number;
  updated_at: number;
}

/** Lightweight projection for `ingredient.draft.list` — never carries the
 *  full `body` (bounded list payload). The derived fields are best-effort
 *  reads off the body for display; `slug` / `surface` are null and
 *  `operation_count` is 0 when the body is too incomplete to project. */
export interface IngredientDraftSummary {
  draft_id: string;
  title?: string;
  slug: string | null;
  surface: CompositionSurface | null;
  operation_count: number;
  created_at: number;
  updated_at: number;
}

export interface IngredientDraftSaveArgs {
  /** Omit (or pass an id with no existing row) to create; pass an existing
   *  `draft_id` to overwrite in place (preserving `created_at`). */
  draft_id?: string;
  title?: string;
  /** The composition body — stored verbatim, may be incomplete. */
  body: unknown;
}

export type IngredientDraftSaveResult =
  | { ok: true; draft: IngredientDraft }
  | {
      ok: false;
      /** `bad_request` — `body` absent/non-object. `too_large` — serialized
       *  body exceeds `INGREDIENT_DRAFT_MAX_BYTES`. `limit_reached` — a NEW
       *  draft would exceed `INGREDIENT_DRAFT_MAX_COUNT`. */
      code: 'bad_request' | 'too_large' | 'limit_reached';
      message: string;
    };

export interface IngredientDraftGetArgs {
  draft_id: string;
}

export type IngredientDraftGetResult =
  | { ok: true; draft: IngredientDraft }
  | { ok: false; code: 'not_found' | 'bad_request'; message: string };

export type IngredientDraftListResult = { ok: true; drafts: IngredientDraftSummary[] };

export interface IngredientDraftDeleteArgs {
  draft_id: string;
}

export type IngredientDraftDeleteResult =
  | { ok: true; deleted: boolean }
  | { ok: false; code: 'bad_request'; message: string };

// ────────────────────────────────────────────────────────────────
// D-170 #2 — draft composition decompose RPC
// ────────────────────────────────────────────────────────────────

export interface CompositionDecomposeArgs {
  /** Draft id to validate + decompose. The draft body must be a valid
   *  `CompositionIngredient`; saving incomplete drafts is still allowed, but
   *  decompose rejects them through the validator. */
  draft_id: string;
}

export type CompositionReviewArtifactShape = '1x1' | 'multi' | 'unknown';

export interface CompositionReviewOperationFamily {
  key: string;
  surface: CompositionSurface;
  risk_tier: OperationRiskTier;
  approval_mapping: OperationApproval;
}

export interface CompositionReviewFieldPrivacy {
  path: string;
  privacy_kind: EntityFieldPrivacy;
}

export interface CompositionReviewCounts {
  compositions: number;
  operation_families: number;
  entity_fields: number;
  pii_fields: number;
  pack_contents: number;
  compiled_outputs: number;
}

export interface CompositionReviewSummary {
  catalog_slug: string | null;
  catalog_slugs: string[];
  artifact_shape: CompositionReviewArtifactShape;
  counts: CompositionReviewCounts;
}

/** Review projection produced by `@recued/ingredient-authoring`
 *  `compileForReview`. Kept structurally mirrored here so contracts owns the
 *  rpc wire type while the pure package owns the compiler. */
export interface CompositionReviewView {
  valid: boolean;
  summary: CompositionReviewSummary;
  operation_families: CompositionReviewOperationFamily[];
  field_privacy: CompositionReviewFieldPrivacy[];
  issues: AuthoringValidationIssue[];
}

export interface CompositionDecomposeArtifacts {
  /** 1x1 composition output. Mutually exclusive with `catalog` for schema v1. */
  ingredient?: IngredientManifest;
  /** Multi-operation catalog-form output. */
  catalog?: IngredientManifest;
  /** Entity schemas compiled alongside `catalog`; empty for 1x1 outputs. */
  entity_schemas: EntitySchemaIngredientInput[];
  /** Operation groups compiled alongside `catalog`; empty when none apply. */
  operation_groups: OperationGroupSpec[];
  /** Default operation-group grants compiled alongside `catalog`. */
  default_grants: PackOperationGroupContentRef[];
}

export type CompositionDecomposeResult =
  | {
      ok: true;
      draft_id: string;
      artifacts: CompositionDecomposeArtifacts;
      review: CompositionReviewView;
    }
  | {
      ok: false;
      /** `bad_request` — missing/invalid `draft_id`. `draft_not_found` — the
       *  draft id is well-formed but no draft exists. `validation_failed` —
       *  the draft body failed the composition validator; `issues` carries the
       *  validator output and no artifacts are returned. */
      code: 'bad_request' | 'draft_not_found' | 'validation_failed';
      message: string;
      issues: AuthoringValidationIssue[];
      review?: CompositionReviewView;
    };

// ────────────────────────────────────────────────────────────────
// D-170 #4 — local save-as-new publish from a draft
// ────────────────────────────────────────────────────────────────

export interface IngredientSaveAsNewArgs {
  /** Draft id to validate + decompose before persisting the compiled local
   *  manifest. This intentionally reuses `ingredient.compose.decompose`'s
   *  validation path; incomplete saved drafts fail with `validation_failed`. */
  draft_id: string;
}

export interface IngredientSavedAsNew {
  /** The resolvable manifest slug written to the local manifest store. */
  ingredient_id: string;
  version: number;
  /** `ingredient` for a 1x1 output; `catalog` for a multi-operation output. */
  kind: 'ingredient' | 'catalog';
  entity_schema_count: number;
  operation_group_count: number;
  default_grant_count: number;
}

export type IngredientSaveAsNewResult =
  | {
      ok: true;
      draft_id: string;
      saved: IngredientSavedAsNew;
      /** The manifest body persisted to `local_manifest`. Entity schemas are
       *  persisted alongside it and summarized by `entity_schema_count`. */
      manifest: IngredientManifest;
      /** Non-blocking validator/review issues. */
      warnings: AuthoringValidationIssue[];
      review: CompositionReviewView;
    }
  | {
      ok: false;
      /** `bad_request`, `draft_not_found`, and `validation_failed` mirror the
       *  #2 decompose path. `slug_conflict` prevents overwriting an existing
       *  local authored body; edit/version-bump is a later lane. `unexpected`
       *  wraps store write failures after validation succeeded. */
      code: 'bad_request' | 'draft_not_found' | 'validation_failed' | 'slug_conflict' | 'unexpected';
      message: string;
      issues: AuthoringValidationIssue[];
      review?: CompositionReviewView;
    };

/** Redacted request target for a preview (N.4 — "redacted request target,
 *  auth source, no secret values"). The `request` descriptor is built from
 *  the operation's binding + the caller's args; auth is NEVER present in it
 *  (the connection adapter injects credentials downstream, not the binding),
 *  and any auth-looking caller-supplied query param is masked defensively. */
export interface IngredientPreviewTarget {
  surface: CompositionSurface;
  /** REST method / `POST (graphql query)` / connector verb label. */
  verb: string;
  /** Redacted request descriptor — for `api`, `<METHOD> <url>` with the URL's
   *  userinfo stripped + auth-like query params masked; for `connector`, the
   *  argv / method_name. Contains no credential. */
  request: string;
  /** Auth SOURCE, never the secret: the composition's auth model + the named
   *  connection the call resolves through (and whether it is enrolled). */
  auth: {
    model: CompositionAuthModel;
    connection: string | null;
    connection_enrolled: boolean;
  };
}

/** One response→entity-field mapping shown in a preview (N.4 "mapping
 *  preview"). `sample` is populated only for an executed read (walked from the
 *  live response, bounded + redacted). */
export interface IngredientPreviewFieldMapping {
  /** Entity field the response maps INTO (`EntityFieldRow.field_path`). */
  entity_field: string;
  /** Source path the value is read FROM (`EntityFieldRow.maps_to`). */
  source_path: string;
  type: MetaFieldType;
  /** Sampled value from the live response (executed reads only). */
  sample?: unknown;
}

/** Why a preview did NOT execute the operation. The first reason —
 *  `mutation` — is the load-bearing safety invariant: a write / admin /
 *  destructive operation is NEVER executed by a preview (test-before-save
 *  never performs a blind write). The rest are honest degradations. */
export type IngredientPreviewSkipReason =
  | 'mutation' // write / admin / destructive — never executed
  | 'no_connection' // no enrolled connection to dispatch against
  | 'connector_surface' // connector / CLI surface — no api adapter path (deferred runtime)
  | 'unsupported_binding' // subscription / push / queue / connector binding — not a one-shot request
  | 'preview_unavailable'; // no execution seam wired (dbless / not booted)

/** The execution half of a preview. A `read` against an enrolled connection
 *  executes through the real connection adapter; everything else is described
 *  but not run. */
export type IngredientPreviewExecution =
  | {
      executed: true;
      outcome: 'ok';
      /** HTTP status of the executed read, when the adapter surfaced one. */
      status?: number;
      /** Redacted + bounded response body. */
      output_preview: unknown;
      /** True iff the response was truncated to fit
       *  `INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES`. */
      truncated: boolean;
      mapping_preview: IngredientPreviewFieldMapping[];
    }
  | {
      executed: true;
      outcome: 'error';
      /** The read was attempted but the endpoint / adapter failed — itself a
       *  useful test-before-save signal. Message is redacted. */
      error: { code: string; message: string };
    }
  | { executed: false; reason: IngredientPreviewSkipReason };

export interface IngredientPreviewArgs {
  draft_id: string;
  /** Which operation to preview — matches an `OperationRow.operation` in the
   *  draft's `operation_families`. */
  operation_key: string;
  /** Per-call args (path params + body fields), already in connection-api
   *  wire-key form (`body.properties`, the `{{deal_id}}` path value, …),
   *  exactly as a recipe's `args` would supply. */
  args?: Record<string, unknown>;
}

export type IngredientPreviewResult =
  | {
      ok: true;
      operation_key: string;
      risk_tier: OperationRiskTier;
      approval: OperationApproval;
      target: IngredientPreviewTarget;
      execution: IngredientPreviewExecution;
    }
  | {
      ok: false;
      /** `draft_not_found` — no draft under `draft_id`. `operation_not_found`
       *  — no operation matches `operation_key`. `invalid_draft` — the body is
       *  not a projectable composition (no `operation_families`).
       *  `bad_request` — `draft_id` / `operation_key` missing or non-string. */
      code: 'draft_not_found' | 'operation_not_found' | 'invalid_draft' | 'bad_request';
      message: string;
    };

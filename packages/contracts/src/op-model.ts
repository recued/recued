/** D-182 — Uniform Op-Step & Ingredient Model (contracts slice).
 *
 *  Finishes the SURFACE half of the D-153 reframe: one recipe op-step shape
 *  (`{ op, args, connection? }`), a two-tier op address, a pack expressed as two
 *  flat authoring tables (`ingredients[]` + `operations[]`), and one per-kind
 *  preflight lifecycle behind the existing Gateway. This module is the
 *  foundation the kernel op registry (slice 2), the pack regen (slice 3), and
 *  the per-kind handlers (slice 5) build on.
 *
 *  Spec: docs/d-182-spec.md (§3 recipe surface, §4 pack tables, §6/§7 per-kind
 *  preflight + cli first-class). Pickup:
 *  recued-project/handovers/handover_d182_build_start.md.
 *
 *  Coexistence note (slice 1): the spec (§4) names the Table-B row
 *  `OperationRow`, but the legacy D-170 `OperationRow` (`bulk-pack.ts` — the
 *  `composition.operation_families[]` element) still has a wide blast radius
 *  (imported as `OperationRow` from the barrel by many files) and is on the
 *  migration chopping block (§10 step 4). So the D-182 row is named
 *  `PackOperationRow` here and barrel-exported under that name to avoid
 *  clobbering the legacy; the migration slice deletes the legacy and renames
 *  this back to the spec's `OperationRow`. (`IngredientRow` has no clash and
 *  keeps its spec name.) Within contracts, import the D-182 row from this
 *  module directly.
 */
import type { BaseStep } from './steps.js';
import type { Actor } from './commits.js';
import { type IngredientKind, INGREDIENT_KINDS, type RiskTier } from './ingredient.js';
import type {
  OperationApproval,
  OperationBoundWebhookDeclaration,
  OperationPaginationSpec,
  OperationIdempotency,
  MediaKind,
  ArgEditField,
  SearchStyle,
  WriteStyle,
  PaginationStyle,
  SchemaSourceRef,
} from './ingredient-catalog.js';
import type { MetaFieldType } from './entity-schema.js';
import type { EntityFieldPrivacy } from './pii-alias.js';
import type { AcctAlias, CrmAlias, DateGranularity, EngagementEntityFacet, FieldDerivation } from './connection-vendors.js';
import { SLUG_RE, type CanonicalWorkflowTemplate } from './bulk-pack.js';

// ────────────────────────────────────────────────────────────────
// §3 — Two-tier op addressing
// ────────────────────────────────────────────────────────────────

/** D-182 §3 — the kernel address head. A Tier-K op id is `core.<domain>.<op>`;
 *  `core` is the KERNEL itself (not a publisher), so a Tier-K op carries no pack
 *  and appears in no `depends_on`. Deliberately distinct from the first-party
 *  *publisher* `recued-core`, which is Tier-P (declared, pack-bound). The
 *  discriminator on a parsed id is exactly `head === KERNEL_OP_PREFIX`. */
export const KERNEL_OP_PREFIX = 'core';

/** A parsed Tier-K kernel op (`core.<domain>.<op>`). */
export interface ParsedKernelOp {
  tier: 'kernel';
  /** the kernel domain (a dot-free slug): a closed kind (`ai` / `storage` /
   *  `work-entity` / `notification` / `mail` / `contact` / `memory` / `data`) OR
   *  a cross-vendor canonical convention (`crm` / `acct`; future `ticket` /
   *  `issue` / `payment` / `sponsor`). */
  domain: string;
  /** the operation remainder after `core.<domain>.` — may itself be dotted
   *  (`commitment.create`, `deal.search`, `summarize`). */
  op: string;
  raw: string;
}

/** A parsed Tier-P pack op (`<publisher>.<pack>.<operation>`). */
export interface ParsedPackOp {
  tier: 'pack';
  /** dot-free publisher handle (`recued-core`, `alice`). Publisher prefix from
   *  the start = anti-squat / no central pack-slug registry. */
  publisher: string;
  /** dot-free pack slug (`whisper`, `hubspot`). */
  pack: string;
  /** the operation remainder after `<publisher>.<pack>.` — may be dotted
   *  (`audio.transcribe`, `file.download`, `association.create`). */
  operation: string;
  /** `<publisher>.<pack>` — the `depends_on` binding key. */
  pack_ref: string;
  raw: string;
}

export type ParsedOpId = ParsedKernelOp | ParsedPackOp;

/** An OPERATION-remainder segment — the same shape as `SLUG_RE` (lowercase,
 *  alphanumeric ends, ≥2 chars) but the interior additionally admits `_`. The
 *  address HEAD (publisher / pack / domain) stays strict `SLUG_RE` (hyphen-cased,
 *  NO underscore — the anti-squat publisher/pack grammar), but an operation id
 *  mirrors the warehouse entity-id / operation vocabulary, which is
 *  underscore-bearing (`ledger_account`, the acct alias) as well as hyphen-bearing
 *  (`mark-done`). Without this an underscore alias would be un-addressable as
 *  `core.acct.<alias>.<verb>` (the `ledger_account` gap). */
const OP_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;

/** D-182 §3 — parse an op id into its tier + segments. Both tiers split on the
 *  first two dots: the two HEAD segments (publisher / pack, or `core` / domain)
 *  are strict `SLUG_RE` slugs; the operation/op remainder segments are looser
 *  (`OP_SEGMENT_RE` — also admits `_`) and the remainder MAY be dotted
 *  (`audio.transcribe`, `ledger_account.search`). A kernel op (`head === 'core'`)
 *  has shape `core.<domain>.<op>`; everything else is a pack op. Returns `null`
 *  for a malformed id (fewer than three segments, a non-slug head, or an
 *  illegal operation segment) so callers fail closed. */
export const parseOpId = (op: string): ParsedOpId | null => {
  if (typeof op !== 'string' || op.length === 0) return null;
  const segments = op.split('.');
  // Need head + (domain|pack) + at least one remainder segment.
  if (segments.length < 3) return null;
  const [head, mid, ...rest] = segments;
  // Head = the two address segments (strict SLUG_RE); rest = the operation
  // remainder (OP_SEGMENT_RE). Rejects `..`, leading/trailing dots, and illegal
  // characters per position (underscore allowed ONLY in the operation remainder).
  if (!SLUG_RE.test(head) || !SLUG_RE.test(mid)) return null;
  if (!rest.every((s) => OP_SEGMENT_RE.test(s))) return null;
  const tail = rest.join('.');
  if (head === KERNEL_OP_PREFIX) {
    return { tier: 'kernel', domain: mid, op: tail, raw: op };
  }
  return {
    tier: 'pack',
    publisher: head,
    pack: mid,
    operation: tail,
    pack_ref: `${head}.${mid}`,
    raw: op,
  };
};

/** True iff `op` is a well-formed Tier-K kernel op (`core.<domain>.<op>`). */
export const isKernelOp = (op: string): boolean => parseOpId(op)?.tier === 'kernel';

/** True iff `op` is a well-formed Tier-P pack op (`<publisher>.<pack>.<op>`). */
export const isPackOp = (op: string): boolean => parseOpId(op)?.tier === 'pack';

// ────────────────────────────────────────────────────────────────
// §3 — `depends_on` (Tier-P pack-binding list)
// ────────────────────────────────────────────────────────────────

/** A parsed `depends_on` entry. The recipe field is a list of these as strings;
 *  Tier-K `core.*` ops need none (kernel, always present). */
export interface DependsOnEntry {
  /** `<publisher>.<pack>` — the Tier-P pack binding key (matches
   *  `ParsedPackOp.pack_ref`). */
  pack_ref: string;
  publisher: string;
  pack: string;
  /** optional minimum-compatible pack version, from an `@N` suffix. */
  min_version?: number;
}

/** D-182 §3 — parse a `depends_on` entry (`<publisher>.<pack>` optionally
 *  version-pinned as `<publisher>.<pack>@<N>`). Returns `null` for a malformed
 *  entry (not exactly two slug segments, or a non-integer/<1 pin). */
export const parseDependsOn = (entry: string): DependsOnEntry | null => {
  if (typeof entry !== 'string' || entry.length === 0) return null;
  const at = entry.indexOf('@');
  const ref = at === -1 ? entry : entry.slice(0, at);
  let min_version: number | undefined;
  if (at !== -1) {
    const v = Number(entry.slice(at + 1));
    if (!Number.isInteger(v) || v < 1) return null;
    min_version = v;
  }
  const parts = ref.split('.');
  if (parts.length !== 2) return null; // exactly <publisher>.<pack>
  const [publisher, pack] = parts;
  if (!SLUG_RE.test(publisher) || !SLUG_RE.test(pack)) return null;
  return { pack_ref: ref, publisher, pack, ...(min_version === undefined ? {} : { min_version }) };
};

/** D-182 §9 — the declared-deps-cover invariant primitive: every Tier-P op a
 *  recipe references must be covered by a `depends_on` entry (Tier-K `core.*`
 *  ops are exempt — kernel, always present; malformed ids are not pack deps).
 *  Returns the de-duplicated list of UNCOVERED `pack_ref`s (empty = covered).
 *  Pure — the install + Compose validators wrap it. */
export const uncoveredOpDependencies = (
  ops: readonly string[],
  dependsOn: readonly string[],
): string[] => {
  const declared = new Set(
    dependsOn
      .map((e) => parseDependsOn(e)?.pack_ref)
      .filter((r): r is string => r !== undefined),
  );
  const missing = new Set<string>();
  for (const op of ops) {
    const parsed = parseOpId(op);
    if (parsed?.tier !== 'pack') continue; // kernel + malformed → not a Tier-P dep
    if (!declared.has(parsed.pack_ref)) missing.add(parsed.pack_ref);
  }
  return [...missing];
};

// ────────────────────────────────────────────────────────────────
// §3 — the one recipe op-step shape
// ────────────────────────────────────────────────────────────────

/** D-182 §3 — the single recipe op-step. Replaces both legacy authored forms
 *  (`ingredient:` + `input.operation`, and the bare canonical `op:`): there is
 *  no `ingredient:` field and no `input.operation`. The recipe ONLY ever names
 *  an op by its fully-qualified two-tier id. Pure transforms stay a separate
 *  `transform:` step (Fork F5) — never an op, never crosses the Gateway. */
export interface OpStep extends BaseStep {
  /** Tier-K `core.<domain>.<op>` OR Tier-P `<publisher>.<pack>.<operation>`
   *  (§3). The only way a recipe names a gated action. */
  op: string;
  /** the op's input args, resolved against `{{ref}}`s like any step input.
   *  Vendor-neutral for a Tier-K canonical op; the op's declared `args` for a
   *  Tier-P op. */
  args?: Record<string, unknown>;
  /** per-instance account binding — which Google / which acct vendor — for
   *  `http` / `connection` / `mcp` ops. A pure `{{config.<var>}}` ref. OMITTED
   *  for `cli` / `entity` / `ai` (implicit: the tool capability / the warehouse
   *  / the pool resolver respectively). §3 Fork F3 — keeps the existing name. */
  connection?: string;
  /** D-103 per-iteration dispatch over a source collection — `{{item.*}}` binds
   *  per element, carried over from the ingredient / canonical op-step. */
  foreach?: string;
  /** PII field names to hash before the op runs and restore after — the legacy
   *  step-level shorthand for hash_replace → op → hash_restore, carried over from
   *  the ingredient step (`IngredientStep.pii_fields`). Only meaningful on an `ai`
   *  op; ignored elsewhere. Distinct from the contracted-function `llm.pii_fields`
   *  args map (path → kind) — the bare-name form is the ONLY PII shorthand the
   *  uncontracted `core.ai.prompt` / multi-data `core.ai.compare` ops support, so
   *  OpStep must carry it for those steps to keep their protection through the
   *  op-step lowering. */
  pii_fields?: string[];
  /** D-113 approval-gate knobs, carried over from `IngredientStep` so a
   *  write/destructive op-step keeps its authored approval behaviour through the
   *  lowering (the engine reads these off the CONCRETE step; the lowering must
   *  copy them or they silently fall back to defaults). `timeout_ms` — approval
   *  timeout; `on_timeout` — how an expired approval resolves; `prompt` — the
   *  human-readable approval prompt. Ignored on read / AI tiers. */
  timeout_ms?: number;
  on_timeout?: 'fail' | 'approve' | 'reject';
  prompt?: string;
}

/** Narrow an arbitrary value to an `OpStep`. Mirrors the legacy
 *  `isCanonicalOpStep` discriminant — a string `op` and none of the concrete
 *  step discriminants (`transform` / `ingredient` / `guard`), so a transform
 *  step that happens to carry an `op` key is not mistaken for one. */
export const isOpStep = (step: unknown): step is OpStep => {
  if (step === null || typeof step !== 'object') return false;
  const s = step as Record<string, unknown>;
  return (
    typeof s.op === 'string' &&
    !('transform' in s) &&
    !('ingredient' in s) &&
    !('guard' in s)
  );
};

// ────────────────────────────────────────────────────────────────
// §4 — Table A: `ingredients[]`
// ────────────────────────────────────────────────────────────────

/** cli ingredient shared config — the tool + its readiness probe (§4 / §7). */
export interface IngredientCliConfig {
  /** the binary the ops invoke (`whisper`, `ffmpeg`, `magick`). */
  tool: string;
  /** readiness-probe argv — the `reachable` preflight stage runs it and treats
   *  a clean exit as "binary on PATH" (`["whisper","--help"]`). §6/§7. */
  probe: string[];
  /** `cli_delegated` profile dir (carried over from the D-170
   *  `CompositionCliProfile`). */
  config_dir?: string;
  profile?: string;
  /** the connector `surfaces_seed.package_ref` (`system_binary:whisper`) the
   *  decomposer carries onto the catalog connector surface. Derived from `tool`
   *  when omitted. */
  package_ref?: string;
  /** the connector `surfaces_seed.entry_point` (the launched binary). Derived
   *  from `tool` when omitted. */
  entry_point?: string;
}

/** http ingredient shared config — base URL + connection-kind (§4). */
export interface IngredientHttpConfig {
  /** base path/URL the ops' `bind.path` join against (`/drive/v3`). */
  base: string;
  /** the connection-KIND these ops authenticate through (`google`, `hubspot`)
   *  — the shared requirement. The per-RUN account instance is the op-step's
   *  `connection` (§3), NOT this. */
  connection?: string;
  /** surface-level default response-envelope key (the legacy
   *  `surfaces_seed.result_path`) the decomposer carries onto `surfaces.api` so
   *  the install resolver projects collection-op results. A per-op
   *  `PackOperationRow.result_path` overrides it. */
  result_path?: string;
  /** the catalog search DIALECT (legacy `surfaces_seed.search_style`) — a
   *  CRM/acct-conformant ingredient declaring a canonical `<alias>.search` op
   *  needs it so the canonical search resolves. */
  search_style?: SearchStyle;
  /** the catalog write-body DIALECT (legacy `surfaces_seed.write_style`) — a
   *  conformant ingredient declaring a canonical `<alias>.{create,update}` op
   *  needs it so the canonical write body resolves. */
  write_style?: WriteStyle;
  /** the catalog pagination DIALECT (legacy `surfaces_seed.pagination_style`) —
   *  needed when a provider cursor is surface-shaped rather than expressible as an
   *  operation-local item cursor. */
  pagination_style?: PaginationStyle;
  /** D-192 work-entity Source — the pinned schema-source document the
   *  ingredient's ops are proven against. The decomposer carries whichever is
   *  set onto `surfaces.api.<kind>_source`; a `work_entity_sources`
   *  `contract_source.{url,sha256}` must EQUAL the emitted pin (one document,
   *  one pin — `validateWorkEntitySources`). Exactly one kind per surface: REST
   *  ops pin `openapi_source` (or `google_discovery_source`), graphql ops pin
   *  `graphql_schema_source`. Omitted → the surface carries no pin (a
   *  work-entity Source cannot be declared against it). */
  openapi_source?: SchemaSourceRef;
  graphql_schema_source?: SchemaSourceRef;
  google_discovery_source?: SchemaSourceRef;
}

/** D-125 connection ingredient shared config — the named connection-kind. */
export interface IngredientConnectionConfig {
  /** the D-125 named connection-kind (api / mcp / notification) the ops
   *  dispatch through. */
  connection: string;
}

/** mcp ingredient shared config. */
export interface IngredientMcpConfig {
  /** the MCP connection record the tool calls run through. */
  connection?: string;
  /** a direct server ref when not connection-bound. */
  server?: string;
}

/** One field of an ingredient's vendor-surface entity schema — the nested form
 *  of the legacy flat `EntityFieldRow`, minus `entity` (now the map key) and
 *  `reviewed` (pre-launch — no per-row review bookkeeping). The cross-vendor
 *  `crm_alias`/`acct_alias` hoist to the entity (`IngredientEntity`), not the
 *  field. Decomposed into an `EntitySchemaIngredientInput` `MetaField`. */
export interface IngredientEntityField {
  /** the vendor response path this field reads from (`Id`, `properties.amount`). */
  field_path: string;
  /** the warehouse meta-field type. */
  type: MetaFieldType;
  /** the canonical warehouse key this maps to (`id`, `amount`). */
  maps_to: string;
  optional?: boolean;
  applies?: 'request' | 'response' | 'both' | 'req' | 'resp';
  /** D-167 egress-alias privacy tag (the field's data sensitivity — distinct
   *  from the op's `risk`). */
  pii?: EntityFieldPrivacy;
  source?: 'schema' | 'heuristic' | 'manual' | string;
  /** the op id whose response sources this field (links the entity to its
   *  read op). */
  source_operation?: string;
  description?: string;
  /** request-side datetime filter granularity (for a `datetime` field). */
  date_granularity?: DateGranularity;
  /** computed projection for a canonical field with no single vendor path. */
  derivation?: FieldDerivation;
}

/** One entity of an ingredient's vendor surface — the cross-vendor canonical
 *  alias (entity-level, was an agree-across-rows annotation on the flat field
 *  rows) + its fields. Keyed in `IngredientRow.entities` by the entity id
 *  (`invoice`, `deal`). */
export interface IngredientEntity {
  /** cross-vendor logical CRM entity (`deal` / `contact` / `account`). Omit for
   *  a non-CRM entity. Mutually exclusive with `acct_alias`. */
  crm_alias?: CrmAlias;
  /** cross-vendor logical ACCOUNTING entity (`invoice` / `bill` / …). */
  acct_alias?: AcctAlias;
  /** D-192 — engagement facet. Marks this a CRM engagement/activity entity
   *  (email / meeting / call / task / …) so a pack CRM's engagement plane
   *  (reconcile / health / coverage / score) lights up with no code edit: it
   *  rides the decompose → `EntitySchemaIngredientInput` → `liveVendorRegistry`
   *  lift (`vendorEntitiesFromComposition`). A THIRD entity category — mutually
   *  exclusive with `crm_alias` / `acct_alias`. */
  engagement?: EngagementEntityFacet;
  /** the entity's fields. */
  fields: IngredientEntityField[];
}

/** D-182 §4 Table A — one row per ingredient: its `kind` plus the config its
 *  operations share, typed by kind. `cli` → tool + probe; `http` → base +
 *  connection-kind; `ai` / `entity` / `storage` need nothing shared. The
 *  ingredient's vendor-surface entity schema (CRM/acct platform-reference
 *  fields) nests under `entities` — it is the ingredient's data shape, not
 *  pack-level data. */
export interface IngredientRow {
  /** dot-free slug (`SLUG_RE`) — the `PackOperationRow.ingredient` join key. The
   *  recipe NEVER names it (authoring-only; §4 Fork F6). */
  slug: string;
  /** the adapter kind that executes this ingredient's ops (the §6 registry
   *  key). */
  kind: OpKind;
  /** per-kind shared config — exactly the cell matching `kind` is set (and only
   *  for the kinds that need one). */
  cli?: IngredientCliConfig;
  http?: IngredientHttpConfig;
  connection?: IngredientConnectionConfig;
  mcp?: IngredientMcpConfig;
  /** the ingredient's vendor-surface entity schema, keyed by entity id. Present
   *  only for ingredients that project platform-reference entities
   *  (api/connection CRM/acct surfaces); absent for cli/ai. Decomposed into
   *  `entity_schemas`. */
  entities?: Record<string, IngredientEntity>;
}

// ────────────────────────────────────────────────────────────────
// §4 — Table B: `operations[]`
// ────────────────────────────────────────────────────────────────

/** Arg value type. A bare-string `args` entry is an implicit `'string'`. */
export type OperationArgType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'file_ref' | 'file_ref[]';

/** The `OperationArgType` values, for authoring surfaces (the pack-editor arg
 *  type picker). `as const satisfies` keeps it in lockstep with the union. */
export const OPERATION_ARG_TYPES = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'file_ref',
  'file_ref[]',
] as const satisfies readonly OperationArgType[];

/** The object form of an `args` entry — used only when an arg needs more than a
 *  required-string: a non-string `type`, or `affects_target` for D-177 authority
 *  scoping (§4). */
export interface OperationArgSpec {
  /** the arg key. */
  key: string;
  /** the arg type — defaults to `'string'` when the entry is a bare string. */
  type?: OperationArgType;
  /** Whether the caller must supply the arg. Bare-string entries are required;
   *  object entries default to optional when this is omitted. */
  required?: boolean;
  /** D-177 authority scoping — editing this re-resolves the approved target /
   *  destination at an approval gate (mirrors `ArgEditField.affects_target`). */
  affects_target?: boolean;
}

/** An `args` entry: a bare key string (= a required string arg) by default, or
 *  an `OperationArgSpec` object when it needs type, optionality, or authority
 *  annotations. */
export type OperationArgEntry = string | OperationArgSpec;

/** Normalize an `args` entry to its key (a bare string IS the key). */
export const operationArgKey = (entry: OperationArgEntry): string =>
  typeof entry === 'string' ? entry : entry.key;

/** Normalize an `args` entry to a full `OperationArgSpec` (a bare string →
 *  `{ key, type: 'string' }`; an object's omitted `type` defaults to
 *  `'string'`). */
export const normalizeOperationArg = (entry: OperationArgEntry): OperationArgSpec =>
  typeof entry === 'string' ? { key: entry, type: 'string' } : { type: 'string', ...entry };

/** cli call shape — argv + capture / materialize / stdout handling (§4). */
export interface CliOperationBind {
  /** argv with `{key}` placeholders filled from the op's args + engine-managed
   *  tokens (e.g. `{output_dir}`). */
  argv: string[];
  /** how the op's output is captured, e.g. `"file_ref@output_dir"` (capture the
   *  file written under the engine-supplied output dir as a `data.file` ref). */
  capture?: string;
  /** arg(s) whose `file_ref` value is materialized to a temp path before the
   *  cli runs (the `input_materialize` counterpart). */
  materialize?: string | string[];
  /** what to do with stdout — `discard` (file-output ops) or `capture`. */
  stdout?: 'discard' | 'capture';
}

/** http / connection call shape — method + path (§4). */
export interface HttpOperationBind {
  method: string;
  /** path joined onto the ingredient's `http.base`, with `{key}` placeholders
   *  from args (`/files/{file_id}`). */
  path: string;
  capture?: string;
}

/** entity (warehouse) call shape — collection + verb (§4). */
export interface EntityOperationBind {
  collection: string;
  verb: string;
}

/** The kind-specific call shape — an argv (cli), a path+method (http), a
 *  collection+verb (entity), etc. (§4). It is the ONE nested cell on
 *  `PackOperationRow` because it can't be scalarized: the row type treats it as
 *  opaque, and each kind's preflight/execute handler narrows it to its concrete
 *  shape (`CliOperationBind` / `HttpOperationBind` / `EntityOperationBind` / …).
 */
export type OperationBind = Record<string, unknown>;

/** D-182 §4 Table B — one row per recipe-callable op. (Spec name: `OperationRow`
 *  — transitionally `PackOperationRow`; see the module header.) Uniform columns
 *  across every kind; the only nested cell is `bind`. Risk / approval are the
 *  pack author's call (R5 — Tier-P; kernel-set for Tier-K, which are NOT pack
 *  rows).
 *
 *  Derivable / redundant columns are DROPPED vs the legacy composition row
 *  (`family` / `verb` read from the `op` id; `surface` from the ingredient
 *  `kind`; `schema_version` / `catalog_kind` from the pack header; per-op `auth`
 *  / `tool` / `base_url` factored up to Table A).
 *
 *  Long-op handling is ENGINE-decided, not on this row (R3 — reconciles D-181):
 *  no `lane` / `progress_contract` / `detached` cell. The carried cells below
 *  (`pagination` / `timeout_ms` / `cache_ttl_ms`) are NOT derivable and survive
 *  from the legacy `OperationSpec`; present only when overriding a kind default.
 */
export interface PackOperationRow {
  /** the pack-local op id — the `<operation>` segment of the Tier-P
   *  `<publisher>.<pack>.<operation>` (`audio.transcribe`). Unique within the
   *  pack (Fork ✓ — so the recipe id needs no ingredient segment). */
  op: string;
  /** join key into Table A `ingredients[]` (authoring-only — the recipe never
   *  sees it; §4 Fork F6). */
  ingredient: string;
  /** R5 — the pack author's risk classification for this op. */
  risk: RiskTier;
  /** R5 — the pack author's approval intent. */
  approval: OperationApproval;
  /** the op's input args — a bare string (a required string) or an object for a
   *  non-string type / D-177 authority arg (§4). Optional (an arg-less op omits
   *  it); primarily drives the Compose autocomplete. */
  args?: OperationArgEntry[];
  /** the kind-specific call shape (§4) — opaque on the row; the kind handler
   *  narrows it. Carries the existing `ApiExecutionBinding` /
   *  `ConnectorExecutionBinding` shape verbatim (the decomposer casts it into
   *  `surfaces.*.executes`); the slice-5 handler view narrows it. */
  bind: OperationBind;
  // D-185 Slice 3b — the legacy `out` field (the op's result-field name) is
  // RETIRED: it was vestigial (the decomposer never lowered it; the only reader
  // was a required-non-empty validator) and the result shape is now derived from
  // the cli `shape` / the binding kind. Deleted outright (pre-launch, no shim).
  // ── kept from the legacy OperationSpec (NOT derivable; lowered verbatim into
  //    the installed OperationSpec by the decomposer; §4 / R3) ──
  /** human description (feeds the installed `OperationSpec.description` + the
   *  generated ingredient name). */
  description?: string;
  /** OAuth/API scopes the op requires. */
  required_scopes?: string[];
  /** D-201 — logical ingress binding + attach/detach intent. The decomposer
   *  lowers this verbatim; URL placement remains trusted server code. */
  operation_bound_webhook?: OperationBoundWebhookDeclaration;
  /** idempotency class (`safe` / `idempotent` / `non_idempotent`). */
  idempotency?: OperationIdempotency;
  /** media kinds the op accepts / produces (multimodal sequencing). */
  accepts_media?: MediaKind[];
  produces_media?: MediaKind[];
  /** Request / response JSON schemas, carried verbatim on catalog-shaped
   *  compositions. A request schema with `additionalProperties: false` opts
   *  into the closed subset validated at publish time and enforced by the
   *  runtime gateway; the authoring gate rejects this opt-in on a 1x1 lowering,
   *  which drops operation rows. Other schemas remain informational. */
  request_schema?: unknown;
  response_schema?: unknown;
  /** D-173 review-then-approve inbox edit allowlist (`ArgEditField[]`) — a
   *  DISTINCT shape from `args`; the inbox edit-form resolver reads it off the
   *  installed catalog, so it must round-trip. */
  editable_args?: ArgEditField[];
  /** per-op response-envelope override of the ingredient `http.result_path` —
   *  for a collection op whose envelope differs from the surface default. */
  result_path?: string;
  /** walk-all pagination contract (style / cursor-path / page-param) —
   *  pack-declared, engine-implemented. Present only when overriding a kind
   *  default. */
  pagination?: OperationPaginationSpec;
  /** per-op invocation-timeout override (ms). */
  timeout_ms?: number;
  /** per-op read-cache TTL override (ms). */
  cache_ttl_ms?: number;
}

/** D-182 §4 — the two authoring tables of a pack, as a pair. Slice 3 (pack
 *  regen) embeds this in the pack manifest; the kernel `core.*` ops are NOT here
 *  (Tier-K — no pack). */
export interface PackOpTables {
  ingredients: IngredientRow[];
  operations: PackOperationRow[];
}

/** D-182 §4 (3b rename) — one shipped trigger→op rule a pack declares; the table
 *  `recipe_templates[]` compiles (at decompose, R4 "flatten") to one recipe per
 *  row via a canonical template (review-then-approve / notify-on-event /
 *  conditional-operate / scheduled-operate / escalate). The rename of the legacy
 *  `WorkflowRow` — "workflow" oversold a trigger→single-gated-op rule. (The
 *  composable / runtime `op-step = template_key` generalization is the D-183
 *  survey, not built here.) */
export interface RecipeTemplateRow {
  /** the canonical handling template the row instantiates. */
  template: CanonicalWorkflowTemplate;
  /** what fires the rule — an entity + optional field/value (reactive) or a cron
   *  (scheduled). */
  trigger: {
    entity: string;
    field?: string;
    value?: string;
    cron?: string;
  };
  /** the op the rule operates (the `<publisher>.<pack>.<op>`-local op id). */
  operation: string;
  /** optional write-back target for `review-then-approve`. */
  sync_target?: { source_id: string; write_back_op: string };
  /** optional notify target. */
  notify_target?: string;
  /** `escalate` timeout. */
  escalate_after_ms?: number;
}

// ────────────────────────────────────────────────────────────────
// §6/§7 — kind set + per-kind preflight handler registry
// ────────────────────────────────────────────────────────────────

/** D-182 §6/§7 (Fork F2) — the kind set the per-kind preflight/execute handler
 *  registry is keyed by. Historically a *superset* of the D-126 `IngredientKind`
 *  set (`IngredientKind | 'cli'`): cli was an op/execution-layer kind only while
 *  the §7 capability handler was being built. With that handler landed, `cli`
 *  graduated into the core `IngredientKind` (D-182 F2 cli gate), so `OpKind` is
 *  now an *alias* of `IngredientKind` — the two are equal. The alias is retained
 *  because the per-kind handler registry + the `createOpKindLookup` resolver +
 *  `isOpKind` are all keyed by `OpKind`; collapsing the name would be churn for
 *  no gain. A future divergence (an op-only kind with no ingredient form) would
 *  re-widen this back to a superset.
 *
 *  NOTE: the §6 handler table writes `entity` for the warehouse kind — that maps
 *  to the existing `storage` kind here (warehouse read/write), not a new kind. */
export type OpKind = IngredientKind;

/** Closed list of every `OpKind`, in canonical order. Equal to
 *  `INGREDIENT_KINDS` since `cli` graduated (D-182 F2). */
export const OP_KINDS: readonly OpKind[] = [...INGREDIENT_KINDS];

/** Membership set for the validator boundary. */
export const OP_KINDS_SET: ReadonlySet<OpKind> = new Set(OP_KINDS);

export const isOpKind = (v: unknown): v is OpKind =>
  typeof v === 'string' && OP_KINDS_SET.has(v as OpKind);

/** D-182 §6 — preflight runs three stages IN ORDER; a deny carries the first
 *  failing stage. "no network → not authorized" is just an earlier stage
 *  failing (Fork F7 — existence / reachability / authorization are one check at
 *  different stages). */
export const PREFLIGHT_STAGES = ['installed', 'reachable', 'authorized'] as const;
export type PreflightStage = (typeof PREFLIGHT_STAGES)[number];

/** The canonical deny reason per failing stage. */
export type PreflightDenyReason = 'not_installed' | 'unreachable' | 'not_authorized';

export const PREFLIGHT_STAGE_DENY_REASON: Record<PreflightStage, PreflightDenyReason> = {
  installed: 'not_installed',
  reachable: 'unreachable',
  authorized: 'not_authorized',
};

export interface PreflightAdmit {
  admit: true;
}

export interface PreflightDeny {
  admit: false;
  /** the stage that failed. */
  stage: PreflightStage;
  /** the canonical deny reason for that stage. */
  reason: PreflightDenyReason;
  /** optional human-facing detail (the missing binary, the connect-this hint). */
  detail?: string;
}

export type PreflightOutcome = PreflightAdmit | PreflightDeny;

export const preflightAdmit = (): PreflightAdmit => ({ admit: true });

export const preflightDeny = (stage: PreflightStage, detail?: string): PreflightDeny => ({
  admit: false,
  stage,
  reason: PREFLIGHT_STAGE_DENY_REASON[stage],
  ...(detail === undefined ? {} : { detail }),
});

/** Per-dispatch input to a kind handler's `preflight`. The `ctx` is kept generic
 *  — contracts cannot import the engine's `ExecutionContext`; the engine
 *  instantiates the handler with its concrete context type. */
export interface KindPreflightInput<Ctx = unknown> {
  /** the resolved Table-B operation row. */
  operation: PackOperationRow;
  /** the resolved Table-A ingredient row (carries the kind + shared config). */
  ingredient: IngredientRow;
  /** the per-instance account binding the op-step named (`http` / `connection`
   *  / `mcp`); absent for `cli` / `entity` / `ai`. */
  connection?: string;
  /** the resolved call args. */
  args: Record<string, unknown>;
  /** the actor driving the call (the Gateway passes the run's `ExecutionSource`
   *  actor — D-161). */
  actor: Actor;
  /** opaque execution context the engine threads through. */
  ctx: Ctx;
}

/** Per-dispatch input to a kind handler's `execute` (post-preflight). */
export interface KindExecuteInput<Ctx = unknown> {
  operation: PackOperationRow;
  ingredient: IngredientRow;
  connection?: string;
  args: Record<string, unknown>;
  ctx: Ctx;
}

/** D-182 §6 (Fork F2 / F7) — the per-kind handler the Gateway dispatches to.
 *  Existence, reachability, and authorization are ONE ordered preflight check
 *  (`installed → reachable → authorized`); `execute` is the post-preflight
 *  primitive. The Gateway calls `preflight()` per dispatch and stays the single
 *  audit / policy / idempotency / outbox / contract-snapshot point (D-153
 *  unchanged); what moves is only the connection-profile-only assumption → a
 *  per-kind preflight. */
export interface KindHandler<Ctx = unknown, Res = unknown> {
  /** the kind this handler services (its registry key). */
  readonly kind: OpKind;
  /** §6 — `installed → reachable → authorized`, in order; admit, or
   *  deny-at-first-failure with the failing stage. */
  preflight(input: KindPreflightInput<Ctx>): PreflightOutcome | Promise<PreflightOutcome>;
  /** the post-preflight execution primitive (the cli executor, the http fetch,
   *  the warehouse read/write, …). */
  execute(input: KindExecuteInput<Ctx>): Promise<Res>;
}

/** D-182 §6 (Fork F2) — kinds are a registry, not a hardcoded enum: the handler
 *  is selected by the ingredient's declared kind. The concrete instance (with
 *  handlers wired) lives in the engine (slice 5); this is its type. */
export type KindHandlerRegistry<Ctx = unknown, Res = unknown> = Partial<
  Record<OpKind, KindHandler<Ctx, Res>>
>;

/** Resolve a handler by kind; the caller fails closed when absent (an
 *  unregistered kind is never silently admitted). */
export const resolveKindHandler = <Ctx, Res>(
  registry: KindHandlerRegistry<Ctx, Res>,
  kind: OpKind,
): KindHandler<Ctx, Res> | undefined => registry[kind];

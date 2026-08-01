import type { RecordsRootProjection } from './records-root-projection.js';
/** D-182 — Uniform Op-Step & Ingredient Model (contracts slice).
 *
 *  Finishes the SURFACE half of the D-153 reframe: one recipe op-step shape
 *  (`{ op, args, connection? }`), a two-tier op address, a pack expressed as two
 *  flat authoring tables (`ingredients[]` + `operations[]`), and one per-kind
 *  preflight lifecycle behind the existing Gateway. This module is the
 *  foundation the kernel op registry (slice 2), the pack regen (slice 3), and
 *  the per-kind handlers (slice 5) build on.
 *
 *  Spec: D-182 (§3 recipe surface, §4 pack tables, §6/§7 per-kind
 *  preflight + cli first-class). Pickup:
 *  internal design notes.
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
import { isLockedInputKey } from './locked-input-keys.js';
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
  /** Display name for this field. Without it a surface title-cases `maps_to`,
   *  which is right for `rent` and wrong for `contract_ref` ("Contract ref"),
   *  `po_number` ("Po number") and every other acronym or term of art.
   *
   *  ⚠ NOT `description`, which is a sentence about the field ("Attendee
   *  name.") and cannot stand in for a column heading.
   *
   *  Adding one moves the pack's `declaration_hash` and leaves
   *  `storage_schema_hash` alone — `canonicalStorageProjection` picks only
   *  `{key, slot, kind, required}` — so it is a re-declaration, never a data
   *  migration. The pack still needs a version bump to re-activate. */
  label?: string;
  /** For a `ref` slot (`r1`..`r5`): the entity kind this reference points at.
   *
   *  ⛔ Without it a reference declares only that it IS one — the TARGET was
   *  discovered at write time by parsing the stored `<kind>/<id>` prefix, so a
   *  recipe writing `contract/{{item.id}}` against a `rental_contract` entity
   *  passed the validator, the corpus sweep and every artifact test, and failed
   *  only against a live store. Inside a `foreach` that arrives as a per-item
   *  failure, which never fails the run: the month reported success and billed
   *  nobody.
   *
   *  Same vocabulary D-226's `RecordsRootHop` already uses (`{field, entity}`),
   *  lifted onto the field so it holds without a root projection — 1,737
   *  entities in the corpus declare 1 hop between them.
   *
   *  Outside `canonicalStorageProjection`, so adding one re-declares and never
   *  migrates. */
  references?: string;
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
  /** D-226 — declared reverse reads. What this entity answers when someone
   *  reads FROM an identity root it orbits. Validated at install against this
   *  pack's own schema; a READ declaration, so it never touches
   *  `storage_schema_hash` and adding one is not a migration. */
  roots?: RecordsRootProjection[];
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

/** D-216 slice 0 — an op's declaration that it sends BYTES, not values.
 *
 *  The HTTP counterpart of `CliInputMaterializeSpec`: it names the arg whose
 *  `file_ref` value is resolved to bytes at dispatch. Two shapes:
 *
 *   `multipart` — the file becomes one `multipart/form-data` part named
 *                 `field`, and the op's other body values ride along as text
 *                 parts (so a caption and its image go in ONE request).
 *   `binary`    — the file IS the whole body, sent raw with the record's own
 *                 `Content-Type`.
 *
 *  🔑 Declaring it is what makes "can this op reach the network with a file"
 *  answerable from the pack MANIFEST alone, without reading any recipe. An op
 *  that does not declare `upload` cannot send bytes however it is called.
 *
 *  ⚠ The named arg carries a `file_ref`, never a PATH. A path would make this
 *  an arbitrary-file-read primitive pointed at the network — a different
 *  feature, and not this one (D-216 § 5.2). */
/** D-216 § 4 — the handler's byte ceiling for one upload. A pack op may
 *  LOWER it via `upload.max_bytes`, never raise it. 25 MB clears every
 *  in-scope target's own limit (Mastodon 40 MB video / 10 MB image, Bluesky
 *  ~1 MB blob, Facebook photo) while keeping a resolved `Buffer` bounded —
 *  the resolver returns bytes in memory, so an unbounded body is a
 *  trivially-reachable OOM. */
export const HTTP_UPLOAD_MAX_BYTES_CEILING = 25 * 1024 * 1024;

/** Engine-owned one-shot upload wire declaration. Recipe args using the
 * `__rc_*` namespace are stripped by the catalog gateway; these markers are
 * therefore proof that the manifest's executable binding, rather than an
 * arbitrary caller arg, selected the byte-egress branch. */
export const HTTP_UPLOAD_WIRE_KIND_KEY = '__rc_upload_kind';
export const HTTP_UPLOAD_WIRE_FIELD_KEY = '__rc_upload_field';
export const HTTP_UPLOAD_WIRE_MAX_BYTES_KEY = '__rc_upload_max_bytes';

export interface HttpOneShotUploadSpec {
  kind: 'multipart' | 'binary';
  /** The op arg holding the `file_ref`. Must be a declared arg of type
   *  `file_ref` (the validator checks this). */
  arg: string;
  /** `multipart` only — the form field name the target expects (`file`,
   *  `media`, `source`…). Required for `multipart`, meaningless for `binary`. */
  field?: string;
  /** Optional per-op ceiling in bytes. May only LOWER the handler default —
   *  the same direction-of-travel rule the trust ceiling uses, so a pack can
   *  tighten its own egress but never widen it. */
  max_bytes?: number;
}

// ────────────────────────────────────────────────────────────────
// D-217 slice 1 — the CHUNKED upload declaration
// ────────────────────────────────────────────────────────────────

/** D-217 § 8b — the chunked path's byte ceiling. SEPARATE from
 *  `HTTP_UPLOAD_MAX_BYTES_CEILING` on purpose: the two have different memory
 *  models. One-shot resolves the whole file into a `Buffer` (hence 25 MB);
 *  chunked stages the plaintext to disk and reads one chunk at a time (D-217
 *  slice 0), so its bound is the target's limit rather than the heap's.
 *  512 MB matches X's video ceiling. Lower-only per op, as before. */
export const HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING = 512 * 1024 * 1024;

/** A hard ceiling on a status poll's own repeat count. The poll is the ONE
 *  loop in this protocol a RESPONSE value drives (§ 8.1), so it is bounded
 *  twice: the declaration must state a literal `max_polls`, and that literal
 *  may not exceed this. */
export const CHUNKED_UPLOAD_MAX_POLLS_CEILING = 60;
/** A target may ask us to wait before polling, but a manifest must clamp that
 * response-derived delay. This keeps one hostile response from parking a lane
 * indefinitely even though the poll count itself is fixed. */
export const CHUNKED_UPLOAD_MAX_POLL_DELAY_MS = 60_000;

/** Values the ENGINE computes and substitutes into an APPEND phase. Closed
 *  set — a `{token}` outside it is a reference to something nothing will
 *  provide, which the validator rejects rather than silently sending the
 *  literal text. */
export const CHUNKED_UPLOAD_ENGINE_TOKENS = [
  'segment_index',
  'chunk_offset',
  'chunk_length',
  'chunk_count',
  'total_bytes',
] as const;

/** The one value the TARGET supplies: the handle INIT returns (X's `media_id`,
 *  LinkedIn's asset URN, YouTube's session URI). Legitimately response-derived
 *  — it addresses the request, it never counts them (§ 8a). */
export const CHUNKED_UPLOAD_SESSION_TOKEN = 'session';

/** D-217 slice 2b-ii — the engine-owned wire prefix that carries ONE chunk to
 *  `connection.api`.
 *
 *  ⛔ **A chunk rides as a REF, never as bytes, and that is not a style
 *  choice.** The commit gateway persists a dispatch's wire input as the
 *  commit's `args` (`pending.args = input`, then `writePending`) and hashes it
 *  for the action identity. Literal chunk bytes in the input would therefore
 *  write the owner's file into the durable commit log once per APPEND — a
 *  D-172 content-isolation break, and ~690 MB of commit rows for one 512 MB
 *  upload. So the wire carries a staging TOKEN plus the range, and the adapter
 *  resolves the bytes through its own injected dep — the same discipline
 *  `body_binary` already follows with a `file_ref`.
 *
 *  ⚠ The token is a CAPABILITY over staged plaintext, so it is engine-owned in
 *  the `__rc_*` sense: `buildApiDispatchInput` strips this prefix from recipe
 *  args, and a phase declaration may not name it either. */
export const CHUNKED_UPLOAD_WIRE_PREFIX = '__cu_';

/** The staging handle minted for this walk. Its presence is what selects the
 *  chunk-body branch in the adapter. */
export const CHUNKED_UPLOAD_WIRE_TOKEN_KEY = `${CHUNKED_UPLOAD_WIRE_PREFIX}staged`;
/** Byte offset of this chunk within the staged plaintext. */
export const CHUNKED_UPLOAD_WIRE_OFFSET_KEY = `${CHUNKED_UPLOAD_WIRE_PREFIX}offset`;
/** Byte length of this chunk. Fixed by the plan before the first dispatch. */
export const CHUNKED_UPLOAD_WIRE_LENGTH_KEY = `${CHUNKED_UPLOAD_WIRE_PREFIX}length`;
/** The multipart form-field name for this chunk.
 *
 *  🔑 **Presence IS the encoding** — set ⇒ the chunk goes as a named form part,
 *  absent ⇒ it is the raw body. The DECLARATION carries an explicit
 *  `chunk_encoding` because a manifest is read by humans and validators; the
 *  WIRE carries only this, because it makes `multipart`-with-no-field
 *  unrepresentable rather than merely rejected. The engine is the translator
 *  between the two, and it has already validated the pair. */
export const CHUNKED_UPLOAD_WIRE_FIELD_KEY = `${CHUNKED_UPLOAD_WIRE_PREFIX}field`;
/** The whole walk, on ONE dispatch input — see `ChunkedUploadWalkInput`.
 *
 *  ⚠ Its presence selects the walk branch at the TOP of the handler, before
 *  `method` / `path` validation, because a walk HAS no single method or path.
 *  The per-chunk keys above are what the walk then puts on each APPEND it
 *  performs; the two are mutually exclusive on one input. */
export const CHUNKED_UPLOAD_WIRE_WALK_KEY = `${CHUNKED_UPLOAD_WIRE_PREFIX}walk`;

/** One request in the protocol. `{token}` placeholders resolve from the engine
 *  token set, `{session}`, and the op's own args.
 *
 *  ⚠ The key set is CLOSED and the validator enforces that. It is the
 *  structural half of the § 8a carve-out: a future `next_offset_from` or
 *  `repeat_while` cannot be declared at all, so a response value has no
 *  syntax through which to reach the loop bound. */
export interface ChunkedUploadPhase {
  method: string;
  /** Joined onto the ingredient's `http.base`, or absolute when the phase
   *  targets a URL the INIT response handed back (`{session}`). */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, string>;
}

/** The optional post-FINALIZE poll. */
export interface ChunkedUploadStatusPhase extends ChunkedUploadPhase {
  /** LITERAL repeat bound, ≤ `CHUNKED_UPLOAD_MAX_POLLS_CEILING`. */
  max_polls: number;
  /** Dotted path into the poll response, and the value that means finished. */
  done: { path: string; equals: string };
  /** Optional target-declared terminal failure state. Without this, a target
   * saying `failed` is misreported as merely unconfirmed after max_polls. */
  failed?: { path: string; equals: string };
  /** Optional response-directed delay before the next poll. The response may
   * choose a value only inside this manifest-declared, globally-capped range. */
  retry_after?: {
    path: string;
    unit: 'seconds' | 'milliseconds';
    default_ms: number;
    max_ms: number;
  };
}

/** D-217 — an op that sends a file across MANY requests.
 *
 *  🔑 The whole shape exists so the APPEND count is
 *  `ceil(size / chunk_bytes)` and the TOTAL ceiling adds only the literal
 *  INIT, FINALIZE and maximum poll count — all locally-known numbers, fixed
 *  before the first byte leaves and unaffected by anything the target says.
 *  That is the § 8a carve-out to Invariant 1, and
 *  `chunkedUploadBoundViolations` is where it is ENFORCED rather than described.
 *
 *  ⚠ **Server-directed resume is deliberately inexpressible.** YouTube's true
 *  resumable protocol asks the server for the committed offset and continues
 *  from there — a response value driving the loop, i.e. exactly what the
 *  carve-out forbids. Under D-217 § 8d (resume out of scope) that costs
 *  nothing today; whoever revisits resume must revisit the carve-out with it,
 *  not work around it. */
export interface ChunkedUploadSpec {
  kind: 'chunked';
  /** The op arg holding the `file_ref` — same rule as the one-shot forms. */
  arg: string;
  /** LITERAL bytes per APPEND. The divisor of the APPEND count, so it may
   *  never be a reference or a template. */
  chunk_bytes: number;
  /** Lower-only against `HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING`. */
  max_bytes?: number;
  /** How ONE chunk sits in its APPEND request. Defaults to `'binary'` (the
   *  chunk IS the whole body, raw).
   *
   *  🔑 **`chunked` is NOT a peer of `multipart` / `binary` — it is
   *  ORTHOGONAL to them.** `HttpUploadSpec.kind` answers *how many requests*;
   *  this answers *how the bytes sit in each one*. Collapsing the two would
   *  make every chunked protocol raw-only, and at least one target this D
   *  exists to unblock wants its chunk as a named multipart part. */
  chunk_encoding?: 'binary' | 'multipart';
  /** `multipart` only — the form field name the target expects for the chunk
   *  (X's `media`). Required for `multipart`, meaningless for `binary`; the
   *  same direction-of-travel rule `HttpOneShotUploadSpec.field` follows. */
  chunk_field?: string;
  /** Dotted path into the INIT response yielding `{session}`. */
  session_from: string;
  init: ChunkedUploadPhase;
  append: ChunkedUploadPhase;
  finalize: ChunkedUploadPhase;
  status?: ChunkedUploadStatusPhase;
}

export type HttpUploadSpec = HttpOneShotUploadSpec | ChunkedUploadSpec;

/** The ONE dispatch input that buys a whole chunked walk.
 *
 *  🔑 **This is where the § 8a amendment becomes structure rather than
 *  discipline.** The walk runs in the connection ADAPTER, below the commit
 *  boundary, so the commit Gateway sees exactly one dispatch and the owner
 *  approves exactly one act. What makes that safe is that both request counts
 *  are fixed DATA on this input: `count` and `request_bound` are on the thing
 *  that gets approved, and the adapter refuses to walk a plan of any other
 *  size (see
 *  `runChunkedUpload`). There is no key here through which a response value
 *  could raise it, which is the same closed-vocabulary argument
 *  `chunkedUploadBoundViolations` makes about the declaration.
 *
 *  ⚠ **Every field here NAMES something, and every one is STABLE across
 *  attempts.** The commit Gateway persists a dispatch's wire input as the
 *  commit's `args` and hashes it for the action identity, so literal chunk
 *  bytes here would write the owner's decrypted file into the durable commit
 *  log. ⛔ **And a per-attempt STAGING TOKEN cannot go here either** — that was
 *  the § 8a amendment's original shape, and building it surfaced why: the hash
 *  basis (`resolveArgsForHash` → `projectResolvedArgs`) covers the full wire
 *  input and drops nothing engine-owned, so a fresh token per attempt gives a
 *  fresh `canonical_payload_hash`, and a D-177 session grant could never match
 *  an honest repeat. It would have failed CLOSED — re-asking every upload —
 *  which is why nothing would have caught it. ⇒ The wire names the FILE; the
 *  adapter stages it below the commit boundary and disposes it in a `finally`,
 *  so the owner's plaintext exists only for the walk itself. */
export interface ChunkedUploadWalkInput {
  /** The op's declaration. Re-validated at run time by `planChunkedUpload` —
   *  an installed pack may predate the predicate or have arrived through a
   *  path that skipped it. */
  spec: ChunkedUploadSpec;
  /** The warehouse file whose bytes leave. STABLE, and the right authority
   *  anchor: the action identity should bind to WHICH FILE was sent. */
  file_ref: string;
  /** The file's `content_hash` at planning time, verified over the staged
   *  plaintext before the first chunk.
   *
   *  🔑 **This is what closes the gap a token was covering.** The engine sizes
   *  the file from metadata (no decrypt) and fixes `count` from that size; the
   *  adapter stages later, and the file could in principle have changed in
   *  between. The pin refuses the walk instead of sending a plan computed for
   *  different bytes — and unlike a token it is stable, so it strengthens the
   *  action identity rather than destabilising it. */
  expect_sha256?: string;
  /** Plaintext size of the file. The dividend of the APPEND count.
   *  ⚠ Cross-checked against the staged handle's own `size_bytes` before any
   *  request goes out — a plan computed for a different size would misalign
   *  every chunk while each request still returned 200. */
  total_bytes: number;
  /** The planned APPEND count — `ceil(total_bytes / chunk_bytes)`. */
  count: number;
  /** Maximum TOTAL requests the approval authorizes: INIT + APPENDs +
   * FINALIZE + every declared status poll. The adapter re-derives and pins it
   * before any request leaves. */
  request_bound: number;
  /** The op's own declared args, for `{arg}` references in a phase. Engine
   *  tokens and `{session}` are supplied by the walk and always win. */
  args?: Record<string, unknown>;
}

/** How a chunked walk ended (D-217 § 8.1).
 *
 *  ⚠ **Three, not two.** X polls STATUS *after* FINALIZE, by which point every
 *  byte has landed and the commit succeeded. Under the fail-closed ruling
 *  `failed` means THE ASSET WAS NEVER CREATED — a still-processing asset is the
 *  opposite of that. Collapsing the poll timeout into `failed` would report a
 *  good upload as failed and invite a retry that double-posts.
 *
 *  🔑 Declared HERE rather than beside the walk because the audit names it too
 *  (`ConnectionAuditDetail.chunked_upload.outcome`), and a vocabulary copied
 *  into a second declaration rots — a subset still typechecks. */
export type ChunkedUploadOutcome =
  /** FINALIZE succeeded, and either there was no poll or the poll confirmed. */
  | 'committed'
  /** FINALIZE succeeded; the poll ran out of attempts without a terminal
   *  answer. The asset EXISTS. Do not retry. */
  | 'committed_unconfirmed'
  /** FINALIZE succeeded, then the target explicitly reported processing
   * failure. This is not the ambiguous poll-timeout state. */
  | 'processing_failed'
  /** Nothing was committed — FINALIZE was never sent. Bytes may still have
   *  left, which the audit records honestly (§ 6.3). */
  | 'failed';

/** D-217 § 6.3 — what one chunked act actually did, for the audit row.
 *
 *  ⛔ **A failed upload is NOT a no-op, and recording it as one would make the
 *  "which file left, to where" guarantee false in exactly the case an owner
 *  most needs it.** A walk that failed at chunk k has already sent k chunks to
 *  a third party. `bytes_out` carries the bytes; these carry the shape of the
 *  act around them — without `chunks_sent` a reader cannot tell a complete
 *  upload from an abandoned one that happened to move the same volume.
 *
 *  ⚠ **`outcome` is the field that keeps § 8.1 true past the adapter.** Both
 *  `committed` and `committed_unconfirmed` are `status: 'ok'` rows — the act
 *  succeeded either way — so without this the distinction the whole poll ruling
 *  turns on would die at the audit boundary. */
export interface ChunkedUploadAuditInfo {
  readonly outcome: ChunkedUploadOutcome;
  /** APPENDs that COMPLETED. Compare against `chunk_count` to see how far a
   *  failed walk got. */
  readonly chunks_sent: number;
  /** The plan's APPEND count — the multiplier the owner approved. */
  readonly chunk_count: number;
  /** Every request performed, phases included. */
  readonly requests: number;
}

/** Overall wall-clock bound for ONE chunked walk, checked before each phase.
 *
 *  ⚠ **A per-request timeout does not bound a walk.** `resolveTimeoutMs` clamps
 *  ONE call to `MAX_TIMEOUT_MS`; at 103 APPENDs that is over three hours of a
 *  held lane and a 512 MB plaintext staged on disk. This is the second bound,
 *  and it is deliberately generous rather than tight: 512 MB inside an hour is
 *  ~1.2 Mbps sustained, which a link that can plausibly finish the upload at
 *  all will clear. It exists to stop a walk running away, not to police speed.
 *
 *  ⚠ Blowing it AFTER finalize is not a failure — the reducer folds a timed-out
 *  status poll to `committed_unconfirmed`, per § 8.1. */
export const CHUNKED_UPLOAD_MAX_WALK_MS = 60 * 60 * 1000;

/** One way a declaration fails the § 8a carve-out. */
export interface ChunkedUploadBoundViolation {
  /** Dotted path within the `upload` object. */
  field: string;
  reason: string;
}

const CHUNKED_PHASE_KEYS = new Set(['method', 'path', 'query', 'headers', 'body']);
const CHUNKED_STATUS_KEYS = new Set([
  ...CHUNKED_PHASE_KEYS, 'max_polls', 'done', 'failed', 'retry_after',
]);
const CHUNKED_SPEC_KEYS = new Set([
  'kind', 'arg', 'chunk_bytes', 'max_bytes', 'session_from',
  'chunk_encoding', 'chunk_field',
  'init', 'append', 'finalize', 'status',
]);

/** Closed, and derived here so the predicate and the engine cannot drift. */
export const CHUNKED_UPLOAD_ENCODINGS = ['binary', 'multipart'] as const;

/** Tokens each phase may reference, beyond the op's own declared args. */
const CHUNKED_PHASE_TOKENS: Record<string, ReadonlySet<string>> = {
  // INIT runs before any chunk and before any session exists.
  init: new Set<string>(['total_bytes', 'chunk_count', 'chunk_length']),
  append: new Set<string>([...CHUNKED_UPLOAD_ENGINE_TOKENS, CHUNKED_UPLOAD_SESSION_TOKEN]),
  finalize: new Set<string>([
    CHUNKED_UPLOAD_SESSION_TOKEN, 'chunk_count', 'total_bytes',
  ]),
  status: new Set<string>([CHUNKED_UPLOAD_SESSION_TOKEN]),
};

const TOKEN_RE = /\{([a-zA-Z0-9_]+)\}/g;

const isLiteralPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** D-217 § 8a — **the Invariant 1 carve-out, enforced.**
 *
 *  `followPagination` refuses to re-dispatch a write op because a response
 *  cursor is attacker-influenced, and following one with a write is an
 *  amplification primitive. A chunk walk is permitted instead of forbidden
 *  ONLY while this holds:
 *
 *  > the number of requests is fixed before the first dispatch and is
 *  > independent of every value the target returns.
 *
 *  ⚠ This runs over **untrusted manifest JSON** (`unknown`), not over the
 *  narrowed TS type — a third-party pack ships JSON, and the type is what we
 *  wish were true, not what arrived. Checking the type would be a tautology;
 *  checking the JSON is a guard.
 *
 *  Three things make the bound un-influenceable, and all three are checked:
 *
 *   1. **`chunk_bytes` is a literal positive integer.** It is the divisor of
 *      the count, so a string / template / reference there is the whole attack
 *      in one field.
 *   2. **Closed key sets.** A phase may carry only `method/path/query/headers/
 *      body`. There is therefore no syntax for `next_offset_from`,
 *      `repeat_while`, `resume_at` — a response value cannot reach the loop
 *      because no key accepts one.
 *   3. **A closed token set per phase.** Every `{token}` must be one the
 *      engine will substitute. `{session}` is allowed where it addresses a
 *      request (append / finalize / status) and NOT in `init`, which runs
 *      before a session exists. An unknown token is rejected rather than sent
 *      as literal text.
 *
 *  And the one genuinely response-driven loop — the post-FINALIZE status poll
 *  (§ 8.1) — is bounded twice: a literal `max_polls`, itself ≤
 *  `CHUNKED_UPLOAD_MAX_POLLS_CEILING`.
 *
 *  Returns every violation, so an author sees the whole picture rather than
 *  fixing one at a time. An empty array means the declaration is admissible
 *  under the carve-out. */
export const chunkedUploadBoundViolations = (
  upload: unknown,
): ChunkedUploadBoundViolation[] => {
  const out: ChunkedUploadBoundViolation[] = [];
  const bad = (field: string, reason: string): void => { out.push({ field, reason }); };

  if (upload === null || typeof upload !== 'object' || Array.isArray(upload)) {
    return [{ field: '', reason: 'upload must be an object' }];
  }
  const spec = upload as Record<string, unknown>;
  if (spec.kind !== 'chunked') {
    return [{ field: 'kind', reason: "not a chunked upload declaration" }];
  }

  for (const key of Object.keys(spec)) {
    if (!CHUNKED_SPEC_KEYS.has(key)) {
      bad(key, `unknown key '${key}' — the chunked declaration's key set is closed so a response value has no syntax to reach the request count`);
    }
  }

  // 1. the divisor
  if (!isLiteralPositiveInt(spec.chunk_bytes)) {
    bad('chunk_bytes', 'chunk_bytes must be a LITERAL positive integer — it divides the request count, so a reference or template here would let a response value set how many requests are sent');
  }
  if (spec.max_bytes !== undefined) {
    if (!isLiteralPositiveInt(spec.max_bytes)) {
      bad('max_bytes', 'max_bytes must be a literal positive integer when present');
    } else if (spec.max_bytes > HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING) {
      bad('max_bytes', `max_bytes may only LOWER the ${HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING}-byte ceiling, never raise it`);
    }
  }
  if (typeof spec.session_from !== 'string' || spec.session_from.length === 0) {
    bad('session_from', 'session_from must name the INIT response path that yields {session}');
  }
  // Per-chunk encoding. Absent ⇒ `binary`, so nothing already shipped changes.
  // ⚠ The pair is validated TOGETHER: `multipart` without a field name would
  // build a form part with no name, which most targets accept and then ignore —
  // a chunk silently dropped is the failure this whole D is built to prevent.
  const encoding = spec.chunk_encoding;
  if (encoding !== undefined
    && !(CHUNKED_UPLOAD_ENCODINGS as readonly unknown[]).includes(encoding)) {
    bad('chunk_encoding', `chunk_encoding must be one of ${CHUNKED_UPLOAD_ENCODINGS.join(' | ')}`);
  } else if (encoding === 'multipart') {
    if (typeof spec.chunk_field !== 'string' || spec.chunk_field.trim().length === 0) {
      bad('chunk_field', "chunk_field must name the form field the target expects when chunk_encoding is 'multipart'");
    }
  } else if (spec.chunk_field !== undefined) {
    // Refused rather than ignored: a field name under a binary encoding means
    // the author believed a form part was being sent and it was not.
    bad('chunk_field', "chunk_field is meaningless unless chunk_encoding is 'multipart'");
  }
  if (typeof spec.arg !== 'string' || spec.arg.length === 0) {
    bad('arg', 'arg must name the op arg carrying the file_ref');
  } else if (spec.arg === 'body_binary' || spec.arg.startsWith('body_file.')) {
    // ⚠ **A chunked `arg` is NOT the one-shot form, and the difference is not
    // cosmetic.** D-216's `arg` is a wire key (`body_file.file`) because the
    // one-shot body builder reads the file out of that exact slot. A chunked
    // walk builds each request's body itself from the plan, so the same key
    // here would put a one-shot body shape on a walk's dispatch input — which
    // the adapter refuses as exclusive, at RUN time, on the one op the author
    // could least afford to have fail there. Refused at authoring instead, and
    // a plain arg key (`file`) is what a chunked op wants: it stays a normal
    // authority-bearing arg, exactly where `affects_target` expects it.
    bad(
      'arg',
      "arg must be a plain op arg key for a chunked upload (e.g. 'file') — "
      + 'the one-shot body_file.* / body_binary wire slots build a SINGLE request body, '
      + 'which a chunked walk never uses',
    );
  }

  // 2 + 3. the phases
  for (const phase of ['init', 'append', 'finalize'] as const) {
    checkPhase(spec[phase], phase, CHUNKED_PHASE_KEYS, bad);
  }
  if (spec.status !== undefined) {
    checkPhase(spec.status, 'status', CHUNKED_STATUS_KEYS, bad);
    const status = spec.status as Record<string, unknown>;
    if (!isLiteralPositiveInt(status.max_polls)) {
      bad('status.max_polls', 'status.max_polls must be a LITERAL positive integer — the poll is the one loop a response value drives, so its ceiling may not itself be response-derived');
    } else if (status.max_polls > CHUNKED_UPLOAD_MAX_POLLS_CEILING) {
      bad('status.max_polls', `status.max_polls may not exceed ${CHUNKED_UPLOAD_MAX_POLLS_CEILING}`);
    }
    const done = status.done;
    if (done === null || typeof done !== 'object' || Array.isArray(done)
      || typeof (done as Record<string, unknown>).path !== 'string'
      || typeof (done as Record<string, unknown>).equals !== 'string') {
      bad('status.done', 'status.done must be { path, equals } naming the response field that means finished');
    }
    const failed = status.failed;
    if (failed !== undefined
      && (failed === null || typeof failed !== 'object' || Array.isArray(failed)
        || Object.keys(failed).some((key) => key !== 'path' && key !== 'equals')
        || typeof (failed as Record<string, unknown>).path !== 'string'
        || typeof (failed as Record<string, unknown>).equals !== 'string')) {
      bad('status.failed', 'status.failed must be { path, equals } naming a terminal target failure');
    }
    const retry = status.retry_after;
    if (retry !== undefined) {
      if (retry === null || typeof retry !== 'object' || Array.isArray(retry)) {
        bad('status.retry_after', 'status.retry_after must be an object');
      } else {
        const r = retry as Record<string, unknown>;
        for (const key of Object.keys(r)) {
          if (!['path', 'unit', 'default_ms', 'max_ms'].includes(key)) {
            bad(`status.retry_after.${key}`, `unknown retry_after key '${key}'`);
          }
        }
        if (typeof r.path !== 'string' || r.path.length === 0) {
          bad('status.retry_after.path', 'retry_after.path must be a non-empty response path');
        }
        if (r.unit !== 'seconds' && r.unit !== 'milliseconds') {
          bad('status.retry_after.unit', "retry_after.unit must be 'seconds' or 'milliseconds'");
        }
        if (typeof r.default_ms !== 'number'
          || !Number.isSafeInteger(r.default_ms) || r.default_ms < 0) {
          bad('status.retry_after.default_ms', 'retry_after.default_ms must be a non-negative literal integer');
        }
        if (!isLiteralPositiveInt(r.max_ms)
          || (r.max_ms as number) > CHUNKED_UPLOAD_MAX_POLL_DELAY_MS) {
          bad('status.retry_after.max_ms', `retry_after.max_ms must be a positive literal integer no greater than ${CHUNKED_UPLOAD_MAX_POLL_DELAY_MS}`);
        } else if (typeof r.default_ms === 'number' && r.default_ms > r.max_ms) {
          bad('status.retry_after.default_ms', 'retry_after.default_ms may not exceed retry_after.max_ms');
        }
      }
    }
  }

  return out;
};

const checkPhase = (
  phase: unknown,
  name: string,
  allowedKeys: ReadonlySet<string>,
  bad: (field: string, reason: string) => void,
): void => {
  if (phase === null || typeof phase !== 'object' || Array.isArray(phase)) {
    bad(name, `${name} must be an object`);
    return;
  }
  const p = phase as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!allowedKeys.has(key)) {
      bad(`${name}.${key}`, `unknown key '${key}' on ${name} — the phase key set is closed, so no response value can be bound into the walk`);
    }
  }
  if (typeof p.method !== 'string' || p.method.length === 0) {
    bad(`${name}.method`, `${name}.method must be a non-empty string`);
  }
  // D-217 slice 2b — a phase's headers come from a THIRD-PARTY MANIFEST, not
  // from recipe args, so `buildApiDispatchInput`'s locked-key strip never sees
  // them. Without this a declaration could set `Authorization` and override the
  // connection's own credential — sending the owner's file to the target under
  // a header the pack chose. Same closed list the engine locks everywhere else;
  // header names are case-insensitive, so compare lowercased.
  if (p.headers !== null && typeof p.headers === 'object' && !Array.isArray(p.headers)) {
    for (const headerName of Object.keys(p.headers as Record<string, unknown>)) {
      if (isLockedInputKey(`header.${headerName.trim().toLowerCase()}`)) {
        bad(
          `${name}.headers.${headerName}`,
          `'${headerName}' is an engine-locked header — a declaration may not set it (the connection owns auth)`,
        );
      }
    }
  }
  if (typeof p.path !== 'string' || p.path.length === 0) {
    bad(`${name}.path`, `${name}.path must be a non-empty string`);
  }
  const allowedTokens = CHUNKED_PHASE_TOKENS[name] ?? new Set<string>();
  const scan = (text: unknown, where: string): void => {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(TOKEN_RE)) {
      const token = m[1]!;
      // An op's own declared args also substitute here; only ENGINE-provided
      // token names are reserved, so a collision is what we reject, not any
      // unfamiliar name. `session` outside its phases is the case that
      // matters: in `init` there is no session yet, so `{session}` there can
      // only be a mistake or an attempt to smuggle one in early.
      const reserved = token === CHUNKED_UPLOAD_SESSION_TOKEN
        || (CHUNKED_UPLOAD_ENGINE_TOKENS as readonly string[]).includes(token);
      if (reserved && !allowedTokens.has(token)) {
        bad(where, `{${token}} is not available in the '${name}' phase`);
      }
    }
  };
  scan(p.path, `${name}.path`);
  for (const bag of ['query', 'headers', 'body'] as const) {
    const v = p[bag];
    if (v === undefined) continue;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      bad(`${name}.${bag}`, `${name}.${bag} must be an object of string values`);
      continue;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val !== 'string') {
        bad(`${name}.${bag}.${k}`, `${name}.${bag}.${k} must be a string`);
        continue;
      }
      scan(val, `${name}.${bag}.${k}`);
    }
  }
};

/** http / connection call shape — method + path (§4). */
export interface HttpOperationBind {
  method: string;
  /** path joined onto the ingredient's `http.base`, with `{key}` placeholders
   *  from args (`/files/{file_id}`). */
  path: string;
  capture?: string;
  /** D-216 — present ⇒ this op sends a file. Absent ⇒ it cannot, at all. */
  upload?: HttpUploadSpec;
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
  /** D-211 Slice 4 — machine-readable author guidance explaining why an
   *  operation deliberately holds. Recommended for held reads and required by
   *  the uniform-held-read noise-fence exemption. Lowercase snake_case keeps
   *  the vocabulary extensible without turning prose into policy. */
  approval_reason?: string;
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

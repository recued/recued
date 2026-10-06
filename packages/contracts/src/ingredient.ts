import type { AiCooperativeManifestDeclaration } from './ai-cooperative.js';
import type { CommitmentEvidenceDeclaration } from './commitment-evidence.js';
import type { WorkEntitySourceDeclaration } from './work-entity-sources.js';
import type { AuthorableProgressContract } from './execution-lane.js';
import type { BridgeSurfaceKind } from './bridge.js';
import type { ValueHint } from './value-hint.js';
import type { ExecutionScope } from './execution-scope.js';
import type {
  OperationSpec,
  OperationGroupSpec,
  ProviderDefaultPolicy,
  ProviderSurfaces,
  CatalogKind,
  MediaKind,
} from './ingredient-catalog.js';

/** Slug naming convention:
 *
 *  - Marketplace ingredients: globally unique slugs (e.g. "mail-send", "hubspot-catalog").
 *    Marketplace enforces uniqueness at publish time (first-come-first-served).
 *
 *  - Local-only ingredients: prefixed with "local/" (e.g. "local/my-search").
 *    Not published, not synced across devices, used for user-created or test ingredients.
 *    Marketplace rejects publishing slugs starting with "local/".
 *
 *  - Forks: local copies of marketplace ingredients use a "local/" slug + fork_of metadata.
 *    To share a fork, rename it without the "local/" prefix and publish.
 *
 *  This namespace prevents silent override attacks: a recipe asking for "search-exa-mcp"
 *  can never resolve to a local ingredient. Marketplace recipes cannot reference "local/" slugs.
 */
export const isLocalIngredient = (slug: string): boolean => slug.startsWith('local/');

/** The reserved publisher handle for kernel ingredients. Bundled with
 *  the extension at build time, invisible in the marketplace, route
 *  through a dedicated dispatcher (server rpc, shared-store helpers,
 *  etc.) instead of HTTP / DOM / MCP / Chat. Reserved in
 *  `RESERVED_HANDLES` so no third party can claim it.
 *
 *  Source of truth for "is this manifest kernel?" — derives from the
 *  reserved author handle directly, avoiding a denormalized boolean
 *  flag that could drift from the author. */
export const KERNEL_AUTHOR = 'recued' as const;

/** True when a manifest is a kernel built-in. Kernel manifests are
 *  bundled with the extension, route through a dedicated dispatcher,
 *  and bypass the HTTP/DOM/MCP/Chat executor requirement in the
 *  validator. Equivalent to `manifest.author === KERNEL_AUTHOR`. */
export const isKernelManifest = (
  manifest: { author?: string } | null | undefined,
): boolean => manifest?.author === KERNEL_AUTHOR;

/** D-225 Slice 2 — the publisher handle for a pack the RUNTIME generated on
 *  this machine, from a third party's declaration, at the owner's enrollment.
 *  Today: MCP packs minted from a connection's `tools/list`.
 *
 *  ⛔ **It is deliberately NOT `KERNEL_AUTHOR`, and that is the whole point.**
 *  `isKernelManifest` above is not a label — it is a VALIDATOR BYPASS.
 *  `validateConnectionWrapper` returns on it before `isCatalogForm`, so a
 *  manifest authored `recued` never reaches catalog-form validation, surface
 *  validation, or any binding gate. That exemption is sound for real kernel
 *  content — bundled with the release, identical on every machine, reviewed
 *  once. A generated pack is the opposite on every axis: per-user,
 *  per-connection, minted from a third party's `tools/list`, reviewed by
 *  nobody. Publishing one under `recued` would hand the least-reviewed content
 *  in the system the exemption reserved for the most-reviewed.
 *
 *  D-225 § 4.1 originally decided `recued` here on the reasoning that "the
 *  runtime authors the derivation"; Slice 1 falsified it by discovering the
 *  bypass. `recued-local` keeps the true part of that reasoning (Recued minted
 *  it) without the false part (it was reviewed).
 *
 *  ⚠ Both privilege checks that could re-create the exemption are EXACT
 *  equality, never a `recued*` prefix — `isKernelManifest` (`=== 'recued'`) and
 *  `publisherMayDeclare` (`=== 'recued-core'`). A generated pack is therefore
 *  validated like any third-party pack and holds no reserved capability. Pinned
 *  by test; if either check ever becomes a prefix match, this handle silently
 *  becomes a bypass again. */
export const GENERATED_PACK_PUBLISHER = 'recued-local' as const;

/** True when a manifest is a D-118 `data.service` template. Service
 *  manifests describe local-process workloads (CLI tools + long-
 *  running services) and route through the server's service
 *  dispatcher rather than HTTP / DOM / MCP / Chat. They use semver
 *  `version` strings (matching the underlying binary's release
 *  scheme) and an empty top-level `output` — per-invoke outputs live
 *  on `input.service.lifecycle.invoke.<name>.output`. The validator
 *  branches on this helper to skip executor / output / integer-
 *  version checks that don't apply to service-kind manifests. */
export const isServiceManifest = (
  manifest: { kind?: IngredientKind } | null | undefined,
): boolean => manifest?.kind === 'service';

export type IngredientCategory = 'data' | 'ai' | 'action';

export type IngredientSource = 'marketplace' | 'local' | 'imported';

/** D-177 authorization risk classes on the strictness ladder
 *  `read < write < admin < destructive` (`RISK_TIER_RANK`, below). An op that
 *  should always ask — even under the owner's standing trust — but stay
 *  grantable is authored as a catalog op with `approval: 'always'` on a
 *  `write`/`admin` tier; a truly irreversible op is `destructive`. (A dedicated
 *  grant-able always-ask tier was considered — D-203 `discretionary` — and
 *  retired in favour of `approval: 'always'`; see the decisions-log.) */
export type RiskTier = 'read' | 'write' | 'admin' | 'destructive';

/** The canonical `RiskTier` ladder in strictness order — the SINGLE source of
 *  truth for the tier LIST, the strictness RANK, and the display LABEL. Retires
 *  the hand-maintained rank / order / label copies that otherwise drift apart (a
 *  missed copy silently mis-ranks or mis-renders a tier). Also the runtime
 *  values export the `RiskTier` type otherwise lacks. `read < write < admin <
 *  destructive`. */
export const RISK_TIERS = ['read', 'write', 'admin', 'destructive'] as const;

// Compile-time completeness ratchet: adding a `RiskTier` member without listing
// it in RISK_TIERS above is a TYPE ERROR HERE (at the source of truth), so every
// derived rank / order / set below — and every consumer that reuses them — stays
// complete by construction. A future 6th tier cannot silently slip through.
type _RiskTiersComplete =
  Exclude<RiskTier, (typeof RISK_TIERS)[number]> extends never
    ? true
    : ['RISK_TIERS is missing a RiskTier member', Exclude<RiskTier, (typeof RISK_TIERS)[number]>];
const _riskTiersComplete: _RiskTiersComplete = true;
void _riskTiersComplete;

/** Membership set over {@link RISK_TIERS} — `RISK_TIER_SET.has(v)` replaces the
 *  ad-hoc `new Set(['read', ...])` validity guards. */
export const RISK_TIER_SET: ReadonlySet<RiskTier> = new Set(RISK_TIERS);

/** True iff `v` is a valid `RiskTier`. */
export const isRiskTier = (v: unknown): v is RiskTier =>
  typeof v === 'string' && (RISK_TIER_SET as ReadonlySet<string>).has(v);

/** Strictness RANK of each tier — its index in {@link RISK_TIERS} (read 0 …
 *  destructive 3; higher = stricter). DERIVED, so it can never drift from the
 *  ladder. Typed permissively (`Record<string, number>`) because several call
 *  sites index an unvalidated wire string and default the miss — completeness is
 *  guaranteed by the ratchet above, not by this record's key type. Retires the
 *  local `RISK_RANK` / `riskRank` / `RISK_CEILING_RANK` copies. */
export const RISK_TIER_RANK: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(RISK_TIERS.map((tier, i) => [tier, i])),
);

/** Display LABEL per tier (title-case). Strict `Record<RiskTier, string>` —
 *  hand-written, so omitting a tier is a compile error (the drift this retires).
 *  Retires the duplicated `RISK_LABEL` / `RISK_TIER_LABEL` maps across the UI. */
export const RISK_TIER_LABELS: Readonly<Record<RiskTier, string>> = Object.freeze({
  read: 'Read',
  write: 'Write',
  admin: 'Admin',
  destructive: 'Destructive',
});

/** The display label for a tier value, with a title-case fallback for an
 *  unknown / legacy string (mirrors the retired `RISK_LABEL[r] ?? capitalize(r)`
 *  accessor). Accepts `string` — some call sites carry an unvalidated wire
 *  value. */
export const riskTierLabel = (tier: string): string =>
  (RISK_TIER_LABELS as Record<string, string>)[tier]
  ?? (tier.length > 0 ? tier.charAt(0).toUpperCase() + tier.slice(1) : tier);

/** D-126 — closed taxonomy of ingredient adapter kinds. Each kind
 *  names exactly one engine-side adapter (`AdapterRegistry[kind]`).
 *  Per-kind sub-typing (chat tab, mcp transport, connection_kind /
 *  subtype) lives inside the manifest's `input` shape, never in the
 *  enum — keeps the kind set stable and the routing surface small.
 *  Adding a kind requires a decisions-log entry.
 *
 *  Nine kinds — assigned at install:
 *    - `http`       — outbound HTTP / REST API (most CRM/messaging readers pre-D-125)
 *    - `dom`        — browser DOM extraction (extension only)
 *    - `ai`         — programmatic AI (BYOK / free pool / openai-compatible)
 *    - `chat`       — web-chat-tab AI (extension only — gemini / deepseek / chatgpt)
 *    - `mcp`        — MCP-client tool calls (pre-D-125 path)
 *    - `service`    — D-118 long-running services (server only)
 *    - `storage`    — local storage read/write (warehouse / shared / enrichment)
 *    - `connection` — D-125 outbound named endpoints (api / mcp / notification)
 *    - `cli`        — D-182 local-binary toolkit ops (whisper / docling / ffmpeg
 *                     / imagemagick); authorized by a per-tool capability grant +
 *                     binary-on-PATH preflight (§7), not a connection profile.
 *                     Graduated from `OpKind`-only into `IngredientKind` once the
 *                     §7 capability handler landed (D-182 F2 cli gate).
 */
export type IngredientKind =
  | 'http'
  | 'dom'
  | 'ai'
  | 'chat'
  | 'mcp'
  | 'service'
  | 'storage'
  | 'connection'
  | 'cli';

/** Closed set of every valid `IngredientKind`. Use for membership
 *  checks at the validator boundary; iterates in canonical order
 *  matching the type declaration. Frozen — adding a kind requires a
 *  decisions-log entry per the load-bearing rule in D-126.
 *  `cli` is last — it graduated in after the original eight (D-182 F2),
 *  matching the `OP_KINDS` append order so any persisted ordering stays
 *  stable. */
export const INGREDIENT_KINDS: ReadonlySet<IngredientKind> = new Set([
  'http',
  'dom',
  'ai',
  'chat',
  'mcp',
  'service',
  'storage',
  'connection',
  'cli',
] as const);

/** Per-kind allowed `risk_tier` set. Validator gates
 *  `manifest.risk_tier ∈ KIND_ALLOWED_TIERS[manifest.kind]` at install
 *  to catch mis-classified ingredients early — e.g. a `kind: 'ai'`
 *  manifest with `risk_tier: 'destructive'` would imply a destructive
 *  inference call, which doesn't exist at the AI layer (the
 *  destructive *tool* call belongs to `kind: 'mcp'` or
 *  `kind: 'connection'`).
 *
 *  Rationale per kind:
 *    - `ai`                 — pure programmatic inference, read-only by
 *                              construction (no DOM, no side effects).
 *    - `chat`               — read OR write. The web-chat tab is DOM-
 *                              driven: typing into the prompt field +
 *                              clicking submit IS a DOM write to the
 *                              user's browser session, even though the
 *                              underlying call is "just" inference.
 *                              Catalog: web-chat-gemini / -deepseek both
 *                              category=action, risk_tier=write.
 *    - `dom`                — local read/write only; no destructive UX
 *                              ingredients today (a DOM "click delete"
 *                              would warrant case-by-case review).
 *    - `storage`            — read/write/destructive. Warehouse ops
 *                              like `file-delete` / `shared-delete-prefix`
 *                              genuinely destroy user data. No `admin`
 *                              concept at the storage layer.
 *    - `mcp`                — tool-dependent. Most MCP tools are read
 *                              or write; a few may be admin (e.g.,
 *                              workspace mutations). Destructive is
 *                              reserved for `connection` where the
 *                              author declares full intent via
 *                              `connection_kind` + subtype.
 *    - `http` / `service` /  — full range. HTTP can call any verb;
 *      `connection`            services manage local processes;
 *                              connection records carry author intent.
 *    - `cli`                — read/write. Local-binary toolkit ops
 *                              (whisper transcribe, docling parse,
 *                              ffmpeg / imagemagick convert) either read
 *                              a file or write a derived one into an
 *                              engine-managed temp dir (the shipped
 *                              toolkit ops are all `write` today; `read`
 *                              is allowed for probe-style invocations).
 *                              No `admin` / `destructive` cli op exists —
 *                              a binary that deletes user files would
 *                              warrant case-by-case review (mirrors the
 *                              `dom` posture).
 */
export const KIND_ALLOWED_TIERS: Record<IngredientKind, ReadonlySet<RiskTier>> = {
  http: new Set<RiskTier>(['read', 'write', 'admin', 'destructive']),
  dom: new Set<RiskTier>(['read', 'write']),
  ai: new Set<RiskTier>(['read']),
  chat: new Set<RiskTier>(['read', 'write']),
  mcp: new Set<RiskTier>(['read', 'write', 'admin']),
  service: new Set<RiskTier>(['read', 'write', 'admin', 'destructive']),
  storage: new Set<RiskTier>(['read', 'write', 'destructive']),
  connection: new Set<RiskTier>(['read', 'write', 'admin', 'destructive']),
  cli: new Set<RiskTier>(['read', 'write']),
};

export type ModelHint = 'fast' | 'quality' | 'thinking';

/** Web-chat tabs the extension can automate for text-output LLM calls.
 *  Kept here (not in @recued/llm) because contracts must reference the
 *  identifier from recipe-level and ingredient-level declarations. */
export type WebChatTab = 'gemini' | 'chatgpt' | 'deepseek';

/** Ingredient's LLM demand — what the call actually needs. The resolver uses
 *  this plus recipe-side offers to pick a concrete source. Optional on the
 *  manifest; when absent the resolver derives it from existing legacy keys
 *  (`llm.model_hint`, `llm.output_format`, `llm.allow_search`) on the step
 *  input so current ingredients keep working unchanged.
 *
 *  `allow_downgrade` is the INGREDIENT AUTHOR's quality dial — author decides
 *  whether a lower tier would still produce acceptable output for this function.
 *  Default false (strict). Do NOT confuse with the recipe variable
 *  `allow_llm_upgrade`, which is the USER's cost dial. */
export interface LLMRequirements {
  speed: ModelHint;
  output_format?: 'text' | 'json';
  needs_search?: boolean;
  allow_downgrade?: boolean;
}

/** D-210 step 3 — provenance write-target declaration.
 *
 *  When an ingredient MUTATES a warehouse entity, the entity's move
 *  history has no home: the D-120 engine link emitter (`maybeEmitLinks`)
 *  only observes entities a step READ through `data.<col>.<id>` input
 *  refs, so a create / update / delete leaves `data.timeline()` silent
 *  for the thing it changed (the local calendar records nothing on a
 *  move — D-210 §6.2). This declaration closes that gap: it names the
 *  entity the ingredient writes, so the engine emits ONE D-120
 *  provenance link (`access: 'write'`) keyed on `<collection>:<id>` after
 *  the step succeeds. The link rides the SAME run correlation +
 *  audit-payload join + origin stamping every read link already does —
 *  it activates the classifier's long-dormant `access: 'write'` branch
 *  (`classifyKind`, "dormant until a future enrichment surfaces them").
 *
 *  Scoped by construction: only an ingredient that declares `writes`
 *  emits a write link; every other action ingredient is unchanged
 *  (read links from its inputs, as before). `collection` is STATIC per
 *  ingredient — an ingredient whose written collection varies at runtime
 *  (e.g. reception's `reception-materialize`, which lands calendar /
 *  task / contact by payload) does NOT use this seam; its provenance is
 *  emitted where the runtime collection is known. */
export interface IngredientWriteTarget {
  /** The warehouse collection the ingredient mutates — the timeline id
   *  prefix (`data.timeline('<collection>:<id>')`). `calendar-create` /
   *  `-update` / `-delete` all declare `'calendar'`. */
  collection: string;
  /** Key of the step's RESULT object whose value is the written entity's
   *  id. The engine reads the resolved result at this key and keys the
   *  link `<collection>:<value>`. Calendar's mutations all surface the
   *  event's `source_id` here (delete included — its result carries the
   *  id it removed). A missing / non-scalar value emits no link (the
   *  pre-D-210 default) rather than a malformed one. */
  id_output_field: string;
}

export interface IngredientManifest {
  /** Unique identifier. See isLocalIngredient and the namespace docs above. */
  slug: string;
  name: string;
  description: string;
  author: string;
  /** D-126 — required. Names the adapter that executes this
   *  ingredient (`AdapterRegistry[kind]` lookup). Closed enum
   *  (`IngredientKind`) — adding a kind requires a decisions-log
   *  entry. Drives engine routing, scope filtering
   *  (`kindToScope`), per-kind validator shape rules
   *  (`PER_KIND_REQUIRED_INPUT`, `PER_KIND_FORBIDDEN_PATTERNS`),
   *  and `risk_tier` gating (`KIND_ALLOWED_TIERS`).
   *
   *  D-118 reserved `'service'` for `data.service` template
   *  manifests; D-126 widened the field from optional `'service'`
   *  to required `IngredientKind`. Pre-launch zero installs — no
   *  inference shim, no auto-stamp on load. Manifests without a
   *  declared `kind` post-validator-hardening (D-126 P4) fail at
   *  install with `INGREDIENT_KIND_MISSING`.
   *
   *  Service-specific carve-outs still apply via `isServiceManifest`
   *  — services have empty top-level `output` and live entirely
   *  inside `input.service.*` instead of declaring an HTTP / DOM /
   *  MCP / Chat executor. Binary release version is declared
   *  separately at `input.service.binary_version` (informational;
   *  see D-118 spec for the slug-vs-metadata-vs-schema-version
   *  split). */
  kind: IngredientKind;
  /** Positive integer. The manifest schema version — increments on
   *  breaking changes to the manifest shape (new required fields,
   *  removed fields, changed defaults that affect callers). Drives
   *  recipe step pinning + the upgrade flow. For service manifests
   *  the binary release version is *not* tracked here — see
   *  `input.service.binary_version`. Parallel binary major lines
   *  (e.g. ffmpeg-v3 + ffmpeg-v4) are encoded as separate slugs
   *  collapsed under `variant_group` in marketplace UI. */
  version?: number;
  /** Minimum recipe-pinned version that's still compatible. Bump for breaking changes. */
  min_version?: number;
  category: IngredientCategory;
  risk_tier: RiskTier;
  /** ⛔⛔ D-228 slice 2 — MAY A KERNEL INGREDIENT BE OFFERED TO AN EXTERNAL AGENT?
   *  Read ONLY for `author: 'recued'` manifests (community ingredients clear the
   *  kernel fence by authorship and are governed by the KIND fence + the grant
   *  gate instead). Absent / `false` ⇒ fenced out of the MCP tool catalog.
   *
   *  🔑 WHY THIS IS A FIELD AND NOT A DERIVATION. Slice 2 first tried to derive
   *  this from `risk_tier === 'read'`, and was REVERTED: that promoted a
   *  PRESENTATION HINT into an AUTHORIZATION INPUT, and `risk_tier` is not
   *  maintained to that standard. But re-authoring `risk_tier` would not have
   *  rescued the derivation either, and this is the part worth remembering —
   *  ⛔ **`data-file-read`, the one ingredient that MUST be exposed, has exactly
   *  the same `(kind: 'storage', risk_tier: 'read')` pair as the watchers
   *  (`time-relative-watcher`, and the webhook, file and recipe watchers retired
   *  2026-10-05), which must not be.** No combination of the authored fields separated them, because the
   *  judgement simply was not written down anywhere: it lived in a
   *  `new Set(['data-file-read'])` in one server file's private scope.
   *
   *  So the fix is to WRITE IT DOWN, next to the thing it describes. That keeps
   *  what the hand-list got right (it is a judgement, made per ingredient) and
   *  fixes what it got wrong: the policy is now visible at the definition site
   *  and in publish review rather than hidden in a const, and a NEW kernel
   *  ingredient ships FENCED by omission instead of depending on someone
   *  remembering a list in another file. Fail-closed is the default; exposure is
   *  the deliberate act.
   *
   *  ⚠ GRANTABLE, NOT EXPOSED — this only clears the kernel fence. The caller
   *  still needs a per-tool grant, and since D-228 slice 6 a caller carrying no
   *  checklist is offered nothing at all. */
  mcp_exposed?: boolean;
  /** D-177 P1b (N.2) — volatile-exclusion paths removed from the commit's
   *  `canonical_payload_hash` (client timestamps, correlation tokens) so an
   *  honest exact repeat still hashes equal. SIMPLE-FORM ingredients only —
   *  a catalog-form ingredient declares exclusions per operation
   *  (`OperationSpec.hash_exclude_args`); this manifest is the simple-form
   *  ingredient's curated trust surface (the N.2 "operation row" role).
   *  Never recipe-authored, never Gateway-inferred. Dot-paths into the
   *  dispatched input; fail-closed validated against the authority-bearing
   *  key set at publish/install (`validateHashExcludeArgs`) — an exclusion
   *  may never target a destination / entity / connection / risk selector.
   *  The shape hash is NOT reduced by exclusions. */
  hash_exclude_args?: string[];
  /** D-177 P5b (N.11) — the simple-form ingredient's AUTHORITY-ARG
   *  declaration: the dot-paths into the dispatched input that select a
   *  destination / entity / risk beyond the wire-authority baseline
   *  (`WIRE_AUTHORITY_ARG_PATHS` — method/url/path/connection/…), e.g.
   *  `to` / `cc` on a mail sender. Curated trust surface, same posture as
   *  `hash_exclude_args`: never recipe-authored, never Gateway-inferred.
   *
   *  PRESENCE is the `grant_mode: 'open'` opt-in attestation — the curator
   *  asserts that the wire baseline ∪ this list covers EVERY
   *  destination/entity selector the ingredient dispatches on. An empty
   *  array is a valid declaration ("the wire keys suffice"); an ABSENT
   *  field means open grants are never offered for this ingredient (fail
   *  closed — an undeclared sender could otherwise be re-aimed through an
   *  unguarded payload arg). Declared paths also join the set
   *  `hash_exclude_args` may never target (N.2 — one authority set, two
   *  consumers). SIMPLE-FORM only: a catalog-form ingredient declares
   *  authority PER OPERATION (`OperationSpec.authority_args` — presence is
   *  that op's open opt-in; `collectOperationAuthorityPaths` joins it with
   *  the derivable baseline of `path_scope` tokens + `affects_target`
   *  editable args), where the engine catalog gate's session-grant seam
   *  consumes it. */
  authority_args?: string[];
  /** Optional — defaults to inferred from slug suffix. Set explicitly for cross-platform ingredients. */
  supported_platforms?: string[];
  tags?: string[];
  /** Ingredient input schema.
   *
   *  Keys declared with `null` value are required from the recipe; any
   *  other value is a manifest-provided default the recipe may
   *  override. Keys take dotted form matching the adapter's wire shape
   *  (`url`, `method`, `header.authorization`, `body.properties.name`,
   *  `query.filter`, `mcp.server_url`, `chat.tab`).
   *
   *  D-112 adds two refinements on top of this:
   *
   *    1. **Wildcard markers.** A key ending in `.*` with `null` value
   *       (e.g. `body.properties.*: null`) admits arbitrary children
   *       under that prefix (`body.properties.dealname`,
   *       `body.properties.amount`) without enumerating each field.
   *       Single-level only — `body.properties.*` does NOT admit
   *       `body.properties.nested.X`. Shadowing rule: explicit keys
   *       win over wildcards. See `isWildcardMarker` + `matchesWildcard`.
   *
   *    2. **Engine locks.** A hardcoded list of keys
   *       (`ENGINE_LOCKED_INPUT_KEYS` — `method`, `url`, `header.host`,
   *       `header.authorization`, `header.cookie`) is non-overridable
   *       by any recipe regardless of what the manifest declares.
   *       Ingredients that need a different network target ship as a
   *       separate ingredient; there's no per-ingredient opt-out. The
   *       invariant is "ingredient author's declared HTTP target is
   *       enforced, not suggested."
   *
   *  parseRecipe validates both at install time; the dispatch layer
   *  re-filters locks at runtime as belt-and-suspenders defence. */
  input: Record<string, unknown>;
  output: Record<string, string>;
  /** Alternative output mapping used if primary paths fail (resilience for API variations). */
  fallback?: Record<string, string>;
  /** D-210 step 3 — declares the warehouse entity this ingredient
   *  MUTATES, so the engine emits a D-120 provenance link keyed on the
   *  written entity (not just the ones the step read). Absent → no write
   *  link (the pre-D-210 default). See {@link IngredientWriteTarget}. */
  writes?: IngredientWriteTarget;
  /** Vault keys this ingredient needs at install time. Path is relative to publisher scope. */
  vault_hints?: Record<string, ValueHint>;
  /** For local forks of marketplace ingredients — tracks the original. */
  fork_of?: { slug: string; author: string; version: number };
  /** D-116 — smoke-test for vault credentials. Optional. When present,
   *  the Kitchen vault editor renders a "Test credential" button next
   *  to every vault entry this ingredient consumes. Calls the
   *  ingredient with `probe.input` (vault refs only, no config / step
   *  refs) and asserts `probe.expected_field` appears in the response.
   *
   *  Gates at validate time (see `validateProbeManifest`):
   *    - `probe_input_invalid_ref`       — input contains a non-vault ref.
   *    - `probe_expected_field_undeclared` — expected_field not declared
   *                                           in `manifest.output`. */
  probe?: {
    /** Input passed to the ingredient. May reference
     *  `{{vault.<key>}}` paths declared in `vault_hints`; may NOT
     *  reference `{{config.*}}`, `{{context.*}}`, or `{{step.*}}`. */
    input: Record<string, unknown>;
    /** Top-level field that must appear in the response for the
     *  probe to pass. Must be declared in `manifest.output`. */
    expected_field: string;
  };

  // ── Install-time metadata (stamped by the extension, NOT part of
  //    the marketplace-published manifest). Marketplace sees these as
  //    undefined; the install flow writes them onto its stored copy. ──

  /** Marketplace-verification state for the `author` claim, set when
   *  the extension installs this manifest locally. `true` means the
   *  marketplace confirmed the (slug, author) pair. `false` means the
   *  marketplace disagreed OR was unreachable — the runtime vault
   *  resolver downgrades scope to 'local' to prevent impersonation.
   *  `undefined` on manifests that haven't been through the install
   *  flow (in-memory / bundled / pre-verification legacy). */
  verified?: boolean;
  /** D-119 Phase 15 — author-declared execution scope. Optional.
   *  When present, must be a subset of the scope derived from this
   *  manifest's shape (kind / slug / DOM signals). Wider declarations
   *  error at validate time with `EXECUTION_SCOPE_TOO_WIDE`. Recipes
   *  inherit a per-ingredient effective scope from this field; the
   *  recipe's overall derived scope intersects every ingredient's
   *  derived scope. See `packages/contracts/src/execution-scope.ts`. */
  execution_scope?: ExecutionScope[];
  /** D-136 §A.4 — regen-policy declaration for AI-surface ingredients.
   *  Optional — `kind: 'ai'` manifests omitting this field default to
   *  the standard tuple
   *  (`['pii_hash_salt']`, `'temperature_zero'`,
   *  `['source_record_hash', 'producer_version_hash']`,
   *  `['source_change', 'producer_change', 'manual']`)
   *  applied at producer-wrapper time. Non-AI ingredients (kind ≠ 'ai')
   *  must omit the field — validator emits `regen_policy_unsupported_kind`.
   *  Closed-list shape; `n_sample_vote_3` resolver wrap lands in P5. */
  regen_policy?: RegenPolicy;
  /** D-145 PB5 §B.6.11 — AI-cooperative substrate declaration.
   *  Optional. Required (warn-then-error) when the ingredient matches
   *  the action-with-conflict-potential pattern (`category: 'action'`
   *  AND `risk_tier ∈ {'write', 'admin', 'destructive'}` AND
   *  `kind ∈ {'http', 'mcp', 'connection', 'storage', 'service'}`).
   *  Either declare `{ declares_alternatives: true, fixed_slots_honored: true }`
   *  for the typical pattern OR explicitly opt out with
   *  `{ declares_alternatives: false, opt_out_rationale: '...' }`.
   *
   *  Codex P3 #1 fold: imports the canonical type from
   *  `ai-cooperative.ts` (no circular dependency — that module has no
   *  imports). Previous PB5 commit declared a duplicate inline
   *  `AiCooperativeManifestDeclarationField`; collapsing eliminates
   *  the silent-drift hazard between the manifest field shape and the
   *  validator's expectations. */
  ai_cooperative?: AiCooperativeManifestDeclaration;
  /** Selector freshness window for selector-backed manifests. The
   *  capacity_spec walker reads this via
   *  `IngredientRegistryProbe.getSelectorTtlMs(slug)` and halts the
   *  walk with `mark_ingredient_degraded` when the most-recent bump
   *  is older than `selector_ttl_ms`. */
  selector_ttl_ms?: number;
  /** D-145 PB8 §C.1.1 — Bridge ingredient surface classification.
   *  D-148 § A.3.1 reserved the field on `BridgeIngredientRef`; D-145
   *  substantiates it on the ingredient manifest itself so the
   *  marketplace publishing-vs-messaging validator can consult it at
   *  submission time. Required (warn-then-error) for `kind: 'dom'`
   *  manifests; ignored for non-DOM kinds. Closed list per
   *  `BridgeSurfaceKind` — `messaging` / `private_chat` / `dm` are
   *  permanently rejected with `surface_kind_messaging_rejected` (see
   *  `packages/marketplace/src/validators/bridge-surface-kind.ts`).
   *
   *  When a `kind: 'dom'` manifest omits `surface_kind`, the four-gate
   *  validator emits a `BRIDGE_SURFACE_KIND_MISSING` warning. The
   *  marketplace gate hard-rejects post-validator-hardening; pre-launch
   *  ingredients that omit are flagged for backfill. */
  surface_kind?: BridgeSurfaceKind;
  /** D-153 P3 — slug of the tool that undoes this one. Optional.
   *  Declares a counterpart ingredient capable of compensating for a
   *  prior commit (e.g., `'schedule.delete'` on a `'schedule.create'`
   *  manifest). The substrate uses this for two paths:
   *
   *    1. **Grace-window cancel** — the Gateway admits the dispatch to
   *       a brief mutable hold (`grace_window_ms`, default 5s); a
   *       cancel arriving inside the window aborts before any external
   *       side effect. Status transitions `pending → cancelled` on the
   *       original commit row; no compensating commit is required.
   *    2. **Compensating commit (post-window)** — after the grace
   *       window closes (or for actions whose partner only acts after
   *       the fact), cognition dispatches a *fresh* commit invoking the
   *       partner slug with `predecessor_commit_id` pointing at the
   *       row being undone. Two observable commits; audit + save-as-
   *       Recipe filter the compensated pair.
   *
   *  Most tools have no `cancellation_partner` — irreversible by
   *  default. Examples that DO declare one: `schedule.create` →
   *  `schedule.delete`; `draft.save` → `draft.discard`; `shared.write` →
   *  `shared.delete`. Self-reference (a tool naming itself as its
   *  own undo) is rejected by `validateCancellationManifest`.
   *
   *  Spec: D-153 § Cancellation grace window +
   *  compensating commits. */
  cancellation_partner?: string;
  /** D-153 P3 — milliseconds the Gateway holds this tool's dispatch in
   *  the mutable grace window before firing externally. Optional;
   *  defaults to `DEFAULT_GRACE_WINDOW_MS` (5000) when
   *  `cancellation_partner` is set. Ignored — and validator-rejected —
   *  when no `cancellation_partner` exists (the grace window only has
   *  meaning when an undo path is declared). Bounded to
   *  `[0, MAX_GRACE_WINDOW_MS]` (60_000) by the validator; values
   *  outside that range raise `grace_window_ms_out_of_range`.
   *
   *  Spec: D-153 § Cancellation grace window +
   *  compensating commits. */
  grace_window_ms?: number;

  // ── D-165 P0 — catalog-form fields (optional; minimal seed) ──
  //
  //  Presence of a non-empty `operations` map makes this manifest
  //  *catalog-form*: the engine routes its calls through the D-157
  //  gateway with operation-level policy instead of the wrapper's static
  //  `risk_tier` (Invariant 1). Simple-form ingredients omit all three
  //  and dispatch through the existing adapter path unchanged — detection
  //  is by field presence, NOT a version flag (see `isCatalogForm`). D-165
  //  P2 (policy slice) grew the seed into the full policy declaration
  //  (per-op request/response schemas, sub_operations, cache/timeout
  //  policy; full operation_groups + catalog-level governance below);
  //  the strict validator gates them. Still pending: the *surfaces* /
  //  *auth* / *execution-binding* substrate + marketplace publish path.
  //  Spec: D-165 § Provider catalog manifest / "P0" / "P2".

  /** Operation policy declarations, keyed by the short operation key the
   *  recipe step passes (`"issues.list"`). Each value carries the
   *  operation's risk tier, groups, approval intent, and (P2) full policy
   *  (cache/timeout/idempotency/media/sub_operations). */
  operations?: Record<string, OperationSpec>;
  /** Operation-group declarations. */
  operation_groups?: Record<string, OperationGroupSpec>;
  /** Provider default approval policy applied when an operation omits its
   *  own `approval`. User / per-connection-profile overrides apply last
   *  and may only be stricter. */
  default_policy?: ProviderDefaultPolicy;
  /** D-165 execution layer — per-surface execution bindings (api / connector /
   *  notification). The gateway dispatches a catalog operation directly over
   *  `surfaces.api.executes[operation_id]` (the REST/GraphQL binding); the
   *  strict validator gates the surface shape + surface-dependent invariants. */
  surfaces?: ProviderSurfaces;
  /** D-192 P1 — declared work-entity Source sync contracts. Each entry
   *  makes one remote entity collection a Source for one Recued work
   *  entity kind (`task` / `note` / `project`). Requires a catalog-form
   *  manifest with `surfaces.api` + a pinned `openapi_source`; every
   *  named op must resolve to a REST-provable `surfaces.api.executes`
   *  binding. Declaration-only at P1 — validated fail-closed
   *  (`validateWorkEntitySources`), registered/synced by later phases.
   *  Spec: D-192. */
  work_entity_sources?: WorkEntitySourceDeclaration[];
  /** D-192 F1 — commitment-evidence capture declarations. Each entry
   *  turns one designated external signal (v1: a canonical CRM field)
   *  into HELD `commitment-create` proposals — NOT a Source (nothing
   *  mirrors; disjoint from `work_entity_sources`, where `commitment`
   *  stays reserved). Validated fail-closed
   *  (`validateCommitmentEvidence`); v1 runtime consumes the KERNEL
   *  declaration only — pack entries validate but stay inert until
   *  the decomposer pass-through lands. Spec: D-192
   *  § Commitment evidence (F1). */
  commitment_evidence?: CommitmentEvidenceDeclaration[];

  // ── D-165 P2 — catalog-level governance + policy defaults (additive;
  //    all optional, validator-gated when present). ──

  /** Governance / trust tier. `private_byo` is never marketplace-eligible. */
  catalog_kind?: CatalogKind;
  /** Whether this catalog may be published to the marketplace. Must be
   *  false (or omitted) when `catalog_kind: 'private_byo'`. */
  marketplace_eligible?: boolean;
  vendor_tos_url?: string;
  /** Consent warnings surfaced at install for unofficial / byo catalogs. */
  install_consent_warnings?: string[];
  /** Media kinds the catalog handles overall. */
  supported_media?: MediaKind[];
  /** Catalog-level default invocation timeout (ms); per-op `timeout_ms`
   *  overrides it. Validator caps at the absolute hard ceiling. */
  default_timeout_ms?: number;
  /** Catalog-level default read-cache TTL (ms); per-op `cache_ttl_ms`
   *  overrides it. Validator caps at 24h. */
  default_cache_ttl_ms?: number;
  provider_api_version?: string;

  // ── D-181 Slice 3 — long-op progress / stall-detection (additive,
  //    optional; both default safely when omitted). ──

  /** Per-op progress signal the stall detector observes (§6). The three
   *  signalling contracts kill (unattended) / flag (attended) on no progress
   *  for `k·T`; a `silent` op is bounded only by the generous wall-clock
   *  fail-safe. Simple-form ingredients declare it here; a catalog-form cli op
   *  declares it per binding (`CliMethodBinding.progress`), which is more
   *  specific.
   *
   *  ⛔ D-274 § 2b — THIS COMMENT USED TO SAY the monitor "falls back to the
   *  per-kind default (`resolveProgressContract`)" WHEN OMITTED. It does not:
   *  `resolveProgressContract` has no non-test caller, and the cli executor's
   *  `buildStallMonitor` returned `undefined` for an undeclared binding, so
   *  BOTH the kill arm and the attended flag arm were skipped. The prose
   *  described an intended wiring that was never built and read as reassurance
   *  for 455 of 457 shipped cli ops.
   *
   *  ⇒ What actually happens for an undeclared CLI BINDING is now D-274's
   *  host-assigned `resource` contract (report-only, never authored here).
   *  Every other kind is still governed by its own executor; if you need a
   *  per-kind default, WIRE `resolveProgressContract` — do not assume it.
   *
   *  ⚠ Typed `AuthorableProgressContract`, not `ProgressContract`: `resource`
   *  is assigned by the host and is not declarable (§ 6a). */
  progress_contract?: AuthorableProgressContract;
  /** Explicit fast-path opt-out (§3d) — a known-cheap op the deterministic
   *  publish-gate op-set walk can't *prove* cheap (so it would otherwise be
   *  gated, since misclassification fails safe). `true` makes the lane
   *  governor bypass the semaphore for this op regardless of its kind. Omit
   *  for the overwhelming majority — the kind classification is correct. */
  fast_path?: boolean;
}

/** D-136 §A.4 — pre-call invariants the producer composes into the
 *  AI input. `'pii_hash_salt'` covers `hash_replace`/`hash_restore`
 *  flows: the salt rotates per session, so ingredients touching the
 *  cycle must declare it so producer-wrapper dedup hashes the
 *  pre-replace canonical bytes (audit §27.1). Open-vocabulary
 *  reserved string list — adding a new value requires a spec amendment. */
export type RegenInputInvariant = 'pii_hash_salt';

/** D-136 §A.4 — noise model on the AI call.
 *  - `temperature_zero` — provider temperature pinned to 0; bytes drift
 *    only on model-side retraining.
 *  - `n_sample_vote_3` — N=3 parallel calls with median-of-results
 *    aggregation. Wrap lands in P5 (resolver layer); P3 declarations
 *    are lifecycle-only.
 *  - `accept_noise_floor` — author admits noise is irreducible
 *    (free-text producers — `summary` / `rewrite` / `generate`).
 *  - `configurable` — recipe author picks at call time
 *    (`ai-prompt`). */
export type RegenDeterminism =
  | 'temperature_zero'
  | 'n_sample_vote_3'
  | 'accept_noise_floor'
  | 'configurable';

/** D-136 §A.4 — closed-list trigger reasons that can fire a regen.
 *  Triggers are explicit at registration; validator rejects any value
 *  outside this set. `drift_significant` is only valid for ingredients
 *  whose downstream topic declares both `temporal_class: 'stable_truth'`
 *  AND `emits_confidence: true` — gate enforced at producer-registration
 *  time, not at ingredient-manifest time. */
export type RegenTrigger =
  | 'source_change'
  | 'producer_change'
  | 'drift_significant'
  | 'manual'
  | 'template_change'
  | 'style_change'
  | 'lang_change'
  | 'prompt_change'
  | 'model_change';

/** D-136 §A.4 — per-ingredient regen-policy block. The dedup_key list
 *  names the hash slots the producer-wrapper folds into its cache key;
 *  open-vocabulary string list (per-ingredient extras land here:
 *  `template_hash`, `style_hash`, `target_lang`, `prompt_hash`,
 *  `model_id`, `source_b_hash`). The default tuple omitting the block
 *  on an `kind: 'ai'` manifest is
 *  `(['pii_hash_salt'], 'temperature_zero',
 *    ['source_record_hash', 'producer_version_hash'],
 *    ['source_change', 'producer_change', 'manual'])`. */
export interface RegenPolicy {
  input_invariants: ReadonlyArray<RegenInputInvariant>;
  determinism: RegenDeterminism;
  dedup_key: ReadonlyArray<string>;
  regen_triggers: ReadonlyArray<RegenTrigger>;
}

/** D-136 §A.4 — closed list of `RegenTrigger` enum values for
 *  validator membership checks. Iterates in declaration order. */
export const REGEN_TRIGGERS: ReadonlyArray<RegenTrigger> = [
  'source_change',
  'producer_change',
  'drift_significant',
  'manual',
  'template_change',
  'style_change',
  'lang_change',
  'prompt_change',
  'model_change',
];

/** D-136 §A.4 — closed list of `RegenDeterminism` enum values. */
export const REGEN_DETERMINISMS: ReadonlyArray<RegenDeterminism> = [
  'temperature_zero',
  'n_sample_vote_3',
  'accept_noise_floor',
  'configurable',
];

/** D-136 §A.4 — closed list of `RegenInputInvariant` enum values. */
export const REGEN_INPUT_INVARIANTS: ReadonlyArray<RegenInputInvariant> = [
  'pii_hash_salt',
];

import type { IngredientKind, IngredientManifest, IngredientCategory, RiskTier, QueueKind } from '@recued/contracts';
import {
  INGREDIENT_KINDS,
  KIND_ALLOWED_TIERS,
  TARGET_SCOPE,
  isLocalIngredient,
  isKernelManifest,
  isServiceManifest,
  isCatalogForm,
  closedRequestSchemaDefinitionIssues,
  // D-165 P2 — catalog policy enum guards + numeric bounds (strict validator).
  isMediaKind,
  isCatalogKind,
  isOperationIdempotency,
  isGroupGrantDefault,
  isGroupUpgradeBehavior,
  CATALOG_DEFAULT_TIMEOUT_MS,
  CATALOG_MIN_OP_TIMEOUT_MS,
  CATALOG_OP_TIMEOUT_MULTIPLIER,
  CATALOG_REST_TIMEOUT_SOFT_CAP_MS,
  CATALOG_MAX_DEFAULT_TIMEOUT_MS,
  CATALOG_DEFAULT_CACHE_TTL_MS,
  CATALOG_MAX_CACHE_TTL_MS,
  CATALOG_CACHE_OUTLIER_MULTIPLIER,
  // D-165 P2 — surface/auth/binding closed lists + guards + connector bounds.
  isApiTransport,
  isAuthKind,
  isApiExecutionBindingKind,
  // D-225 Slice 1 — the message quotes the closed list rather than restating
  // it, so a widened vocabulary can never leave a stale error text telling an
  // author that a value the validator now accepts is invalid.
  API_TRANSPORTS,
  API_EXECUTION_BINDING_KINDS,
  isRealtimeApiBindingKind,
  isConnectorWireProtocol,
  // Connection-agnostic op dispatch — surface-level closed-set DIALECT guards +
  // their allowed-value arrays (search query / write body / pagination cursor). A
  // typo'd dialect silently disables the feature at runtime, so fail closed at publish.
  isSearchStyle,
  isWriteStyle,
  isPaginationStyle,
  isOperationPaginationStyle,
  isOperationPaginationPlacement,
  SEARCH_STYLES,
  WRITE_STYLES,
  PAGINATION_STYLES,
  OPERATION_PAGINATION_STYLES,
  OPERATION_PAGINATION_PLACEMENTS,
  OAUTH2_FLOWS,
  CALLBACK_URL_STRATEGIES,
  REST_METHODS,
  GRAPHQL_OPERATION_TYPES,
  QUEUE_KINDS,
  QUEUE_POLL_TIMEOUT_CAP_MS,
  CATALOG_SCHEMA_SOURCE_SHA256_REGEX,
  CONNECTOR_TRANSPORTS,
  CONNECTOR_AUTH_METHODS,
  RECONNECT_POLICIES,
  CLI_STDIN_HANDLINGS,
  CLI_OUTPUT_SHAPES,
  PROGRESS_CONTRACTS,
  CLI_DETACHED_MODES,
  CLI_DETACHED_COMPLETION_KINDS,
  CLI_DETACHED_CANCEL_KINDS,
  CATALOG_CONNECTOR_INVOKE_TIMEOUT_CAP_MS,
  CATALOG_CONNECTOR_STARTUP_TIMEOUT_CAP_MS,
  CATALOG_CONNECTOR_SHUTDOWN_TIMEOUT_CAP_MS,
  CATALOG_CONNECTOR_IDLE_DISCONNECT_MIN_MS,
  CATALOG_CONNECTOR_AUTH_WAIT_TIMEOUT_CAP_MS,
  publisherForIngredient,
  deriveIngredientScope,
  isValidExecutionScope,
  isExecutionScopeSubset,
  sortExecutionScope,
  REGEN_TRIGGERS,
  REGEN_DETERMINISMS,
  REGEN_INPUT_INVARIANTS,
  AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS,
  isLockedInputKey,
  isRecordsAction,
  recordsSlotKind,
  // D-177 P1b — fail-closed gate on declared `hash_exclude_args` (N.2).
  validateHashExcludeArgs,
  // D-177 P5b — the shared wire-authority baseline (one authority set, two
  // consumers: this publish gate + the open-projection walker — N.2/N.11).
  WIRE_AUTHORITY_ARG_PATHS,
  // D-177 catalog open mode — one op's authority-bearing set (this gate's
  // never-exclude floor + the runtime walk's guard set; one home).
  collectOperationAuthorityPaths,
  // D-177 N.2 — the op's api-binding path template (its `{{token}}` params are
  // authority target selectors), fed to `collectOperationAuthorityPaths`.
  operationPathTemplate,
  // §5 — strip the reserved `core-` kernel-capability prefix for the ai-/category
  // slug convention checks (a `core-ai-*` manifest follows the ai- convention).
  stripCorePrefix,
  // cli `argv[0]` command-pin — the declared launched binary the resolved
  // command token must equal (entry_point, else the `system_binary:` suffix).
  cliToolFromConnectorRuntime,
  // D-201 Slice 0 — new webhook bindings name a trusted portable profile;
  // legacy signature_scheme-only declarations remain parseable.
  isWebhookProfileId,
  webhookProfile,
  WEBHOOK_BINDING_RE,
  KERNEL_GRANT_PREFIX,
  declaredOperationIdReservedPrefix,
} from '@recued/contracts';
import type { ConnectorRuntimeSpec } from '@recued/contracts';
import { RISK_TIER_SET, isRiskTier } from '@recued/contracts';
import { MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, SOFT_TIMEOUT_CEILING_MS } from './timeout.js';
// cli `argv_template` SAFETY — the shared single source the authoring layer also
// uses (no drift): the command token (`argv[0]`) must be a literal pinned to the
// declared binary, and no interpreter code/eval hole turns a call-time arg into code.
// `tokenContainsTemplateHole` also backs the (literal-only) service argv[0] pin.
import { cliCommandViolation, cliInterpreterViolations, tokenContainsTemplateHole } from './cli-argv-safety.js';
// D-192 P1 — fail-closed shape validation for `work_entity_sources`
// declarations (manifest-internal; the doc-dependent op proof stays in
// `crossCheckCatalogOpenApi` below).
import { validateWorkEntitySources } from './validate-work-entity-sources.js';
// D-192 F1 — fail-closed shape validation for `commitment_evidence`
// capture declarations (fully manifest-internal — registry lookups only).
import { validateCommitmentEvidence } from './validate-commitment-evidence.js';

/** Validation severity tiers.
 *  - `error` blocks publish/install. valid === false when any error is present.
 *  - `warn`  does not block but marketplace UI should surface before publish.
 *  - `info`  advisory hint, non-blocking.
 *
 *  SCOPE BOUNDARY: this validator operates on ONE manifest in isolation.
 *  It does not and cannot check cross-manifest properties such as:
 *    - Slug uniqueness (marketplace enforces at publish; local install
 *      enforces at the collection layer).
 *    - Duplicate installed versions.
 *    - Recipe-level references to this ingredient.
 *  Those checks live in the storage / marketplace layers.
 */
export type ValidationSeverity = 'error' | 'warn' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  /** Dot path into the manifest (e.g. "input.url", "output.response.id"). */
  path: string;
  message: string;
}

export interface ValidationResult {
  /** True iff no error-severity issues. warn/info do not affect this. */
  valid: boolean;
  issues: ValidationIssue[];
}

const CATEGORIES = new Set<IngredientCategory>(['data', 'ai', 'action']);
const RISK_TIERS = RISK_TIER_SET; // canonical (contracts) — retires the local copy

const AUTHOR_PLACEHOLDERS = new Set([
  '', 'todo', 'author', 'your-name', 'your_name', 'name', 'test', 'example',
]);

/** Namespaces an ingredient must NEVER reference in its input values — those
 *  are recipe-level scopes supplied by the engine at call time. */
const RECIPE_NAMESPACES = new Set(['config', 'context', 'step', 'meta']);

/** HTTP adapter key prefixes — presence of any of these (plus a bare `url`
 *  or `method`) indicates an HTTP ingredient. */
const HTTP_KEY_PREFIXES = ['header.', 'query.', 'body.'];
const HTTP_BARE_KEYS = new Set(['url', 'method', 'body', 'timeout_ms']);

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const own = (obj: Record<string, unknown>, key: string): unknown =>
  hasOwn(obj, key) ? obj[key] : undefined;

/** Optional cross-check inputs for `validateIngredient`. The marketplace
 *  publish pipeline (D-165 P5 — not the portable validator) fetches the
 *  catalog's pinned schema document, verifies its SHA-256 against
 *  `surfaces.api.openapi_source.sha256`, parses it, and passes it here so the
 *  OpenAPI structural cross-check runs inside the SINGLE validation entry point
 *  rather than as a separately-remembered call. Local install passes nothing
 *  (offline; no document) → the cross-check is simply skipped. */
export interface ValidateIngredientOptions {
  /** Parsed, already-hash-verified OpenAPI document (see `crossCheckCatalogOpenApi`). */
  openapiDocument?: unknown;
  /** Parsed, already-hash-verified Google Discovery document
   *  (`surfaces.api.google_discovery_source` — see
   *  `crossCheckCatalogGoogleDiscovery`). D-192 P2. */
  googleDiscoveryDocument?: unknown;
}

/** Validate an ingredient manifest against all structural, security, and
 *  marketplace rules. Returns a ValidationResult with every finding. Does
 *  not throw — malformed input produces issues instead. */
export const validateIngredient = (
  input: unknown,
  opts?: ValidateIngredientOptions,
): ValidationResult => {
  const issues: ValidationIssue[] = [];
  const add = (severity: ValidationSeverity, code: string, path: string, message: string): void => {
    issues.push({ severity, code, path, message });
  };

  // ── Top-level shape ───────────────────────────────────────
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    add('error', 'manifest_not_object', '', 'manifest must be an object');
    return { valid: false, issues };
  }
  const m = Object.fromEntries(Object.entries(input as Record<string, unknown>));

  validateRequiredFields(m, add);
  validateSlug(m, add);
  validateMetadata(m, add);
  validateInput(m, add);
  validateOutput(m, add);
  validateFallback(m, add);
  validateForkOf(m, add);
  validateCategoryConsistency(m, add);
  validateExecutionScope(m, add);
  validateKindField(m, add);
  validateKindShape(m, add);
  validateKindTier(m, add);
  validateConnectionWrapper(m, add);
  validateHashExclude(m, add);
  validateAuthorityArgs(m, add);
  validateRegenPolicy(m, add);
  validateAiCooperative(m, add);
  validateAiBatch(m, add);
  validateLongOpFields(m, add);
  validateWorkEntitySources(m, add);
  validateCommitmentEvidence(m, add);

  // D-165 RUNTIME — fold the OpenAPI structural cross-check into the single
  // validation entry point when the caller supplies a fetched + hash-verified
  // document. The fetch + SHA-256 compute stay in the caller (the marketplace
  // publish pipeline) — no IO substrate enters the portable validator. Local
  // install supplies no document, so this is a no-op there.
  if (opts?.openapiDocument !== undefined) {
    for (const issue of crossCheckCatalogOpenApi(input, opts.openapiDocument).issues) {
      issues.push(issue);
    }
  }
  if (opts?.googleDiscoveryDocument !== undefined) {
    for (const issue of crossCheckCatalogGoogleDiscovery(input, opts.googleDiscoveryDocument).issues) {
      issues.push(issue);
    }
  }

  const valid = !issues.some((i) => i.severity === 'error');
  return { valid, issues };
};

type AddFn = (severity: ValidationSeverity, code: string, path: string, message: string) => void;

// ────────────────────────────────────────────────────────────────
// Section validators — each focuses on one logical group
// ────────────────────────────────────────────────────────────────

const validateRequiredFields = (m: Record<string, unknown>, add: AddFn): void => {
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

  if (!str(m.slug))        add('error', 'slug_required',        'slug',        'slug is required and must be a non-empty string');
  if (!str(m.name))        add('error', 'name_required',        'name',        'name is required and must be a non-empty string');
  if (!str(m.description)) add('error', 'description_required', 'description', 'description is required and must be a non-empty string');
  if (!str(m.author))      add('error', 'author_required',      'author',      'author is required and must be a non-empty string');

  if (typeof m.category !== 'string' || !CATEGORIES.has(m.category as IngredientCategory)) {
    add('error', 'category_invalid', 'category',
      `category must be one of: ${[...CATEGORIES].join(', ')}`);
  }
  if (typeof m.risk_tier !== 'string' || !RISK_TIERS.has(m.risk_tier as RiskTier)) {
    add('error', 'risk_tier_invalid', 'risk_tier',
      `risk_tier must be one of: ${[...RISK_TIERS].join(', ')}`);
  }

  if (!m.input || typeof m.input !== 'object' || Array.isArray(m.input)) {
    add('error', 'input_required', 'input', 'input must be an object');
  }
  if (!m.output || typeof m.output !== 'object' || Array.isArray(m.output)) {
    add('error', 'output_required', 'output', 'output must be an object');
  }
};

const validateSlug = (m: Record<string, unknown>, add: AddFn): void => {
  if (typeof m.slug !== 'string' || !m.slug) return;
  const slug = m.slug;

  if (slug !== slug.toLowerCase()) {
    add('error', 'slug_not_lowercase', 'slug', 'slug must be lowercase');
  }
  if (/\s/.test(slug)) {
    add('error', 'slug_has_whitespace', 'slug', 'slug must not contain whitespace');
  }
  if (!/^[a-z0-9/_-]+$/.test(slug)) {
    add('error', 'slug_invalid_chars', 'slug', 'slug may only contain [a-z0-9/_-]');
  }
  if (isLocalIngredient(slug)) {
    // local/ ingredients: exactly one slash at position 5
    if (slug.slice(6).includes('/')) {
      add('error', 'slug_local_nested', 'slug',
        'local/ ingredients may not contain additional slashes after the prefix');
    }
    if (slug === 'local/') {
      add('error', 'slug_local_empty', 'slug', 'local/ prefix requires a name after the slash');
    }
  } else if (slug.includes('/')) {
    add('error', 'slug_contains_slash', 'slug',
      'only local/ ingredients may contain a slash (marketplace slugs use hyphens)');
  }
};

const validateMetadata = (m: Record<string, unknown>, add: AddFn): void => {
  // Author placeholder
  if (typeof m.author === 'string') {
    const a = m.author.trim().toLowerCase();
    if (AUTHOR_PLACEHOLDERS.has(a)) {
      add('warn', 'author_placeholder', 'author',
        `author is a placeholder value '${m.author}' — use a real publisher id`);
    }
  }

  // Kernel claim. The `kernel` field was removed from the manifest type
  // (kernel routing keys off `author === 'recued'`, not a denormalized
  // flag). Reject any manifest still carrying it so a publisher who
  // copy-pasted an older example surfaces the misunderstanding instead
  // of shipping meaningless noise that an AGPL-fork might one day act on.
  if ('kernel' in m) {
    add('error', 'kernel_field_disallowed', 'kernel',
      'the `kernel` field is not part of the manifest schema — kernel routing is determined by `author: recued` (a reserved handle)');
  }

  // Versions. Manifest schema version is always a positive integer
  // (drives breaking-change detection + recipe step pinning). For
  // service manifests, the underlying binary's release semver is
  // declared separately at `input.service.binary_version` —
  // informational, never enforced.
  const ver = m.version;
  const minVer = m.min_version;
  const isService = isServiceManifest(m);
  if (ver !== undefined) {
    const okInt = typeof ver === 'number' && Number.isInteger(ver) && ver >= 1;
    if (!okInt) {
      add('error', 'version_invalid', 'version',
        'version must be a positive integer');
    }
  }
  if (minVer !== undefined) {
    if (typeof minVer !== 'number' || !Number.isInteger(minVer) || minVer < 1) {
      add('error', 'min_version_invalid', 'min_version', 'min_version must be a positive integer');
    } else if (typeof ver === 'number' && minVer > ver) {
      add('error', 'min_version_gt_version', 'min_version',
        `min_version (${minVer}) must not exceed version (${ver})`);
    }
  }

  // Tags
  if (m.tags === undefined) {
    add('warn', 'tags_missing', 'tags',
      'tags not set — add for marketplace discovery (domain + function + entity)');
  } else if (!Array.isArray(m.tags) || !m.tags.every((t) => typeof t === 'string')) {
    add('error', 'tags_shape', 'tags', 'tags must be an array of strings');
  } else if (m.tags.length === 0) {
    add('warn', 'tags_empty', 'tags', 'tags array is empty');
  } else if (m.tags.length < 3) {
    add('info', 'tags_thin', 'tags',
      `only ${m.tags.length} tag(s) — recommend 3+ covering domain + function + entity`);
  }

  // Supported platforms
  if (m.supported_platforms !== undefined) {
    if (!Array.isArray(m.supported_platforms)
        || !m.supported_platforms.every((p) => typeof p === 'string')) {
      add('error', 'platforms_shape', 'supported_platforms',
        'supported_platforms must be an array of strings');
    }
  }

  // Description thinness
  if (typeof m.description === 'string' && m.description.length < 20) {
    add('info', 'description_thin', 'description',
      `description is only ${m.description.length} chars — add detail for marketplace listing`);
  }
};

const validateInput = (m: Record<string, unknown>, add: AddFn): void => {
  if (!m.input || typeof m.input !== 'object' || Array.isArray(m.input)) return;
  const input = m.input as Record<string, unknown>;
  const author = typeof m.author === 'string' ? m.author : null;
  const slug = typeof m.slug === 'string' ? m.slug : null;

  // TARGET_SCOPE attestation: exact-match input keys must have a non-null
  // static value. null means "recipe supplies it" — never allowed for these.
  for (const key of Object.keys(input)) {
    if (TARGET_SCOPE.has(key as unknown as never)) {
      const value = input[key];
      if (value === null) {
        add('error', 'target_scope_null', `input.${key}`,
          `${key} is an attested target — must have a static default, not null (recipes cannot override)`);
      } else if (value === undefined) {
        add('error', 'target_scope_undefined', `input.${key}`,
          `${key} is an attested target — must have a static default, not undefined`);
      } else if (typeof value !== 'string') {
        add('error', 'target_scope_not_string', `input.${key}`,
          `${key} must be a string literal (possibly with {{vault.*}} interpolation)`);
      }
    }
  }

  // Recipe-namespace leak check: ingredient input values can only
  // reference vault.*. Service manifests (kind = 'service') are
  // exempt — `{{config.*}}` inside `input.service.*` refers to the
  // service's own config (declared in `service.config_schema`),
  // resolved by the service dispatcher at start / invoke time, not
  // recipe-level config. `{{input.*}}` (per-invoke args inside
  // `lifecycle.invoke.<name>.argv`) is already not in
  // `RECIPE_NAMESPACES`. Service manifests do not use
  // `{{step.*}}` / `{{meta.*}}` / `{{context.*}}` / `{{vault.*}}`
  // by spec — verified by lint over `community/ingredients/*`.
  // D-125 P5.1 — `kind: 'connection'` wrapper manifests bind
  // `input.connection` to a `{{config.<X>}}` picker by design (the
  // wrapper's config var is auto-derived from this interpolation at
  // install time). Skip the leak check on the connection field
  // specifically; everything else still gates.
  if (!isServiceManifest(m)) {
    const isConnection = m.kind === 'connection';
    walkRefs(input, 'input', (ns, refPath) => {
      if (!RECIPE_NAMESPACES.has(ns)) return;
      if (isConnection && refPath === 'input.connection' && ns === 'config') return;
      add('error', 'recipe_namespace_ref', refPath,
        `ingredient cannot reference {{${ns}.*}} — recipe-level namespaces are supplied by the engine, not the manifest`);
    });
  }

  // Vault scope: {{vault.X.Y}} — X must match the ingredient's own publisher
  if (author && slug) {
    const expectedPublisher = publisherForIngredient(slug, author);
    walkVaultRefs(input, 'input', (refPublisher, refPath) => {
      if (refPublisher !== expectedPublisher) {
        add('error', 'vault_scope_cross_publisher', refPath,
          `vault reference uses publisher '${refPublisher}' but this ingredient belongs to '${expectedPublisher}' — cross-publisher vault access is forbidden`);
      }
    });
  }

  // Timeout defaults: HTTP uses `timeout_ms`, MCP uses `mcp.timeout_ms`.
  // The runtime clamps out-of-range values at call time, but a declared
  // default should be sane so users aren't silently corrected.
  validateTimeoutField(input, 'timeout_ms', add);
  validateTimeoutField(input, 'mcp.timeout_ms', add);

  // Service manifests' optional `input.service.binary_version` —
  // publisher-declared assertion of the binary release the manifest
  // was authored against. Informational only; the runtime never
  // checks it. Must be a non-empty string when present.
  if (isServiceManifest(m)) {
    const service = own(input, 'service');
    if (service && typeof service === 'object' && !Array.isArray(service)) {
      const svc = service as Record<string, unknown>;
      if (hasOwn(svc, 'binary_version')) {
        const bv = own(svc, 'binary_version');
        if (typeof bv !== 'string' || bv.length === 0) {
          add('error', 'binary_version_invalid', 'input.service.binary_version',
            'binary_version must be a non-empty string (semver or other publisher-defined release identifier)');
        }
      }
      validateServiceCommandPin(svc, add);
    }
  }
};

/** Service lifecycle `argv[0]` is the COMMAND — it must be a non-templated
 *  literal. A `{{config.*}}`/`{{input.*}}` hole in the command position would let
 *  the service instance's config or a per-invoke input choose which binary runs
 *  (the dispatcher runs argv with `shell:false` but inherits `PATH`). This is the
 *  service-side mirror of the cli `argv[0]` pin (finding 5) — but LITERAL-ONLY:
 *  there is deliberately NO `== install_check.binary` check and NO interpreter
 *  code-hole guard, because a service legitimately runs a wrapper
 *  (`bash <fixed-script>`, data passed via env) whose `argv[0]` differs from the
 *  probed binary and whose `-c` carries a fixed literal script. Only the command
 *  token is pinned; data args stay templated (`allow_flag_like`-gated). */
const validateServiceCommandPin = (service: Record<string, unknown>, add: AddFn): void => {
  const checkArgv0 = (argv: unknown, path: string): void => {
    if (!Array.isArray(argv) || argv.length === 0) return;
    const cmd = argv[0];
    if (typeof cmd === 'string' && tokenContainsTemplateHole(cmd)) {
      add('error', 'service_command_hole', path,
        'service argv[0] (the command) must be a non-templated literal, not a call-time hole — a templated command lets config/input choose which binary runs; lock the binary and pass typed data args');
    }
  };
  const lifecycle = service.lifecycle;
  if (isObjectRecord(lifecycle)) {
    for (const key of ['start', 'stop'] as const) {
      const spec = lifecycle[key];
      if (isObjectRecord(spec)) checkArgv0(spec.argv, `input.service.lifecycle.${key}.argv`);
    }
    const invoke = lifecycle.invoke;
    if (isObjectRecord(invoke)) {
      for (const [op, spec] of Object.entries(invoke)) {
        if (isObjectRecord(spec)) checkArgv0(spec.argv, `input.service.lifecycle.invoke.${op}.argv`);
      }
    }
  }
  // Service CHECK specs are ALSO spawn surfaces (Codex review-of-fix): an
  // `exec_ok` check (install_check / health_check / each startup_check[] entry)
  // runs its own `argv` with shell:false, and `runCheck` resolves `{{config.*}}`
  // across it before dispatch — the SAME dynamic-command hole as a lifecycle
  // argv. Pin the command token of any argv-bearing check (present + future
  // kinds; a `binary_in_path` / `install_check`-alias check carries no argv and
  // is a no-op).
  const checkArgvSpec = (spec: unknown, path: string): void => {
    if (isObjectRecord(spec)) checkArgv0(spec.argv, `${path}.argv`);
  };
  checkArgvSpec(service.install_check, 'input.service.install_check');
  checkArgvSpec(service.health_check, 'input.service.health_check');
  const startup = service.startup_check;
  if (Array.isArray(startup)) {
    startup.forEach((spec, idx) => checkArgvSpec(spec, `input.service.startup_check[${idx}]`));
  }
};

/** Validate a single timeout field. Does nothing if the field is absent or null
 *  (null means "recipe supplies it"). Any declared default must be a finite
 *  number in the [MIN, MAX] range; values above the soft ceiling get a warn. */
const validateTimeoutField = (
  input: Record<string, unknown>,
  key: string,
  add: AddFn,
): void => {
  if (!hasOwn(input, key)) return;
  const value = own(input, key);
  if (value === null || value === undefined) return;
  const path = `input.${key}`;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    add('error', 'timeout_not_number', path,
      `${key} must be a finite number (milliseconds), got ${typeof value}`);
    return;
  }
  if (value < MIN_TIMEOUT_MS) {
    add('error', 'timeout_too_low', path,
      `${key} is ${value}ms — must be at least ${MIN_TIMEOUT_MS}ms`);
    return;
  }
  if (value > MAX_TIMEOUT_MS) {
    add('error', 'timeout_too_high', path,
      `${key} is ${value}ms — must not exceed the hard cap of ${MAX_TIMEOUT_MS}ms`);
    return;
  }
  if (value > SOFT_TIMEOUT_CEILING_MS) {
    add('warn', 'timeout_above_soft_ceiling', path,
      `${key} default is ${value}ms — above the ${SOFT_TIMEOUT_CEILING_MS}ms soft ceiling, consider restructuring (prefetch, pagination, or scheduled execution)`);
  }
};

const validateOutput = (m: Record<string, unknown>, add: AddFn): void => {
  if (!m.output || typeof m.output !== 'object' || Array.isArray(m.output)) return;
  const output = m.output as Record<string, unknown>;

  // Service manifests have no top-level output mapping — per-invoke
  // outputs live on `input.service.lifecycle.invoke.<name>.output`,
  // routed by the service dispatcher. Empty `output: {}` is the
  // canonical shape.
  if (Object.keys(output).length === 0) {
    if (!isServiceManifest(m)) {
      add('error', 'output_empty', 'output', 'output mapping must have at least one entry');
    }
    return;
  }

  for (const [path, field] of Object.entries(output)) {
    if (typeof field !== 'string') {
      add('error', 'output_value_not_string', `output.${path}`,
        'output mapping values must be strings (field names or the literal "trigger")');
    } else if (field.length === 0) {
      add('error', 'output_field_empty', `output.${path}`,
        'output field name must be non-empty');
    }
  }
};

const validateFallback = (m: Record<string, unknown>, add: AddFn): void => {
  if (m.fallback === undefined) return;
  if (!m.fallback || typeof m.fallback !== 'object' || Array.isArray(m.fallback)) {
    add('error', 'fallback_shape', 'fallback', 'fallback must be an object');
    return;
  }
  if (!m.output || typeof m.output !== 'object' || Array.isArray(m.output)) return;

  const output = m.output as Record<string, unknown>;
  const outputFields = new Set(
    Object.values(output).filter((v): v is string => typeof v === 'string'),
  );
  for (const field of Object.values(m.fallback as Record<string, unknown>)) {
    if (typeof field === 'string' && !outputFields.has(field)) {
      add('warn', 'fallback_orphan', 'fallback',
        `fallback maps to field '${field}' but that field is not declared in output`);
    }
  }
};

const validateForkOf = (m: Record<string, unknown>, add: AddFn): void => {
  if (m.fork_of === undefined) return;
  if (!m.fork_of || typeof m.fork_of !== 'object' || Array.isArray(m.fork_of)) {
    add('error', 'fork_of_shape', 'fork_of', 'fork_of must be an object with {slug, author, version}');
    return;
  }
  const fo = m.fork_of as Record<string, unknown>;
  if (typeof fo.slug !== 'string' || !fo.slug) {
    add('error', 'fork_of_slug', 'fork_of.slug', 'fork_of.slug is required');
  }
  if (typeof fo.author !== 'string' || !fo.author) {
    add('error', 'fork_of_author', 'fork_of.author', 'fork_of.author is required');
  }
  if (typeof fo.version !== 'number' || !Number.isInteger(fo.version) || fo.version < 1) {
    add('error', 'fork_of_version', 'fork_of.version', 'fork_of.version must be a positive integer');
  }
};

/** D-119 Phase 15 — `execution_scope` declaration must be a valid
 *  shape AND a subset of the scope derived from the manifest's own
 *  shape (kind / slug / DOM signals). Authors can narrow but never
 *  widen the derived constraint — declaring `['device', 'server']`
 *  on a `kind: service` manifest is the canonical too-wide case. */
const validateExecutionScope = (m: Record<string, unknown>, add: AddFn): void => {
  if (!('execution_scope' in m)) return;
  const declared = m.execution_scope;
  if (declared === undefined) return;
  if (!isValidExecutionScope(declared)) {
    add('error', 'execution_scope_shape', 'execution_scope',
      'execution_scope must be a non-empty array of unique values from {"device","server"}');
    return;
  }
  // Derivation needs the slug + input/output shape — reuse the typed helper.
  // Falls back to ['device','server'] when the manifest is missing fields the
  // deriver inspects (other validators surface those as separate errors).
  const derived = deriveIngredientScope(m as unknown as IngredientManifest);
  if (!isExecutionScopeSubset(declared, derived)) {
    add('error', 'EXECUTION_SCOPE_TOO_WIDE', 'execution_scope',
      `execution_scope ${JSON.stringify(sortExecutionScope(declared))} is wider than the scope derived from this manifest's shape ${JSON.stringify(derived)} — narrow the declaration or change the ingredient`);
  }
};

/** D-126 P4.3 — `kind` field presence + membership gate. Emits
 *  `INGREDIENT_KIND_MISSING` when the field is absent and
 *  `INGREDIENT_KIND_INVALID` when present but not a member of
 *  `INGREDIENT_KINDS`. Runs before `validateKindShape` /
 *  `validateKindTier` so those can short-circuit on invalid kind
 *  without emitting confusing secondary errors.
 *
 *  No kernel exemption — every manifest, kernel or not, must
 *  declare a valid `kind`. The kernel exemption in P4.1 / P4.2 is
 *  specifically about per-kind shape rules; the field itself is
 *  unconditionally required.
 */
const validateKindField = (m: Record<string, unknown>, add: AddFn): void => {
  if (!('kind' in m) || m.kind === undefined) {
    add('error', 'INGREDIENT_KIND_MISSING', 'kind',
      `manifest must declare a 'kind' field — one of: ${[...INGREDIENT_KINDS].join(', ')}`);
    return;
  }
  if (typeof m.kind !== 'string' || !INGREDIENT_KINDS.has(m.kind as IngredientKind)) {
    add('error', 'INGREDIENT_KIND_INVALID', 'kind',
      `kind '${String(m.kind)}' is not a known IngredientKind — must be one of: ${[...INGREDIENT_KINDS].join(', ')}`);
  }
};

/** D-126 P4.1 — per-kind required input keys.
 *
 *  Top-level `input` keys that must be present on every manifest of
 *  the corresponding kind. Empty array means "no kind-specific
 *  required keys; positive shape is enforced by other validators
 *  (executor_ambiguous / ai_no_llm_input / dom_no_trigger / …)
 *  or — for service manifests — by `input.service.*` schema rules
 *  on the runtime path."
 *
 *  The values diverge from spec § 4.1 to match the actual catalog +
 *  runtime contract:
 *    - `ai: []` rather than `['llm.prompt']` — only `ai-prompt` carries
 *      `llm.prompt`; the contracted ai-functions (ai-classify / -score /
 *      -extract / …) declare per-function `llm.*` shapes that the
 *      runtime composes prompts from. The "must declare ≥ 1 llm.*
 *      input key" requirement is enforced by `ai_no_llm_input` in
 *      `validateCategoryConsistency` (see line ~450).
 *    - `chat: ['chat.prompt']` rather than `['chat.tab', 'llm.prompt']`
 *      — the legacy chat runtime requires `chat.prompt`; there is no
 *      `chat.tab` input field on chat manifests.
 *    - `mcp: ['mcp.tool']` rather than `['mcp.server_url', 'mcp.tool']`
 *      — `mcp.server_url` typically rides on the server-side connection
 *      record (D-125) or a vault entry, not the manifest input.
 *
 *  Kernel manifests (`author === 'recued'`) are exempt from
 *  required-key + forbidden-pattern checks alike — they route through
 *  the kernel adapter regardless of `kind` (see `dispatch.ts:75`),
 *  carry custom internal shapes (e.g. `http-watcher` uses `target_url`
 *  not `url`), and are bundled at build-time with the engine they
 *  belong to. The exemption mirrors the existing `executor_ambiguous`
 *  carve-out at line ~467.
 */
export const PER_KIND_REQUIRED_INPUT: Record<IngredientKind, readonly string[]> = {
  http:       ['url'],
  dom:        [],
  ai:         [],
  chat:       ['chat.prompt'],
  mcp:        ['mcp.tool'],
  service:    [],
  storage:    [],
  connection: [],
  // D-182 — cli toolkit ops are addressed as Tier-P pack ops and carry their
  // shape in the pack `bind` (argv template) + `args`, not a standalone
  // manifest `input`; no required top-level input key.
  cli:        [],
};

/** D-126 P4.1 — per-kind forbidden top-level input-key patterns.
 *
 *  Each pattern matches against an `input` object's top-level key
 *  names. A `kind: 'http'` manifest carrying `chat.tab: 'gemini'` in
 *  its input fails with `INGREDIENT_KIND_FIELD_FORBIDDEN` — catches
 *  copy-paste classification errors at install / submission instead
 *  of surfacing as a runtime adapter mismatch later.
 *
 *  Regex anchors (`^`) and field-prefix dots (`chat\.`) are
 *  significant — `/^url$/` matches the bare `url` key only, while
 *  `/^chat\./` matches every `chat.*` key. The patterns are sourced
 *  verbatim from spec § 4.2.
 *
 *  Connection's `mcp.*` allowance is intentional — D-125 connections
 *  with `connection_kind: 'mcp'` legitimately carry `mcp.tool` / etc.
 *  in input. (`mcp` is *not* in connection's forbidden list.) Same
 *  for the bare `method` key — D-125 P5.1 wrappers with
 *  `connection_kind: 'api'` declare it as a manifest default the
 *  recipe never overrides; `validateConnectionWrapper` instead
 *  *requires* `method` for the api connection_kind. `url` stays
 *  forbidden — wrappers compose URLs via `path` + the connection
 *  record's `base_url`, never a bare `url`.
 */
export const PER_KIND_FORBIDDEN_PATTERNS: Record<IngredientKind, readonly RegExp[]> = {
  http:       [/^chat\./, /^llm\./, /^mcp\./, /^service\./],
  dom:        [/^url$/, /^method$/, /^chat\./, /^mcp\./, /^service\./],
  ai:         [/^url$/, /^method$/, /^chat\.tab$/, /^mcp\./, /^service\./],
  chat:       [/^url$/, /^method$/, /^mcp\./, /^service\./],
  mcp:        [/^chat\./, /^url$/, /^method$/, /^service\./],
  service:    [/^url$/, /^method$/, /^chat\./, /^llm\./, /^mcp\./],
  storage:    [/^url$/, /^method$/, /^chat\./, /^llm\./, /^mcp\./, /^service\./],
  connection: [/^url$/, /^chat\./, /^llm\./, /^service\./],
  // D-182 — a cli op carries no HTTP / chat / llm / mcp / service input keys
  // (mirrors `storage`); its tool wiring lives in the pack `cli` block + `bind`.
  cli:        [/^url$/, /^method$/, /^chat\./, /^llm\./, /^mcp\./, /^service\./],
};

/** D-126 P4.1 — per-kind input shape validation. Emits
 *  `INGREDIENT_KIND_MISSING_FIELD` per missing required key,
 *  `INGREDIENT_KIND_FIELD_FORBIDDEN` per forbidden-pattern match.
 *  Skipped when `kind` is missing or invalid (separate validator
 *  surfaces those) and when the manifest is kernel-authored. */
const validateKindShape = (m: Record<string, unknown>, add: AddFn): void => {
  const kind = own(m, 'kind');
  if (typeof kind !== 'string' || !INGREDIENT_KINDS.has(kind as IngredientKind)) return;
  if (isKernelManifest(m)) return;
  const rawInput = own(m, 'input');
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return;

  const input = rawInput as Record<string, unknown>;
  const inputKeys = Object.keys(input);

  for (const required of PER_KIND_REQUIRED_INPUT[kind as IngredientKind]) {
    if (!hasOwn(input, required)) {
      add('error', 'INGREDIENT_KIND_MISSING_FIELD', `input.${required}`,
        `kind: '${kind}' requires top-level input key '${required}'`);
    }
  }

  for (const pattern of PER_KIND_FORBIDDEN_PATTERNS[kind as IngredientKind]) {
    for (const key of inputKeys) {
      if (pattern.test(key)) {
        add('error', 'INGREDIENT_KIND_FIELD_FORBIDDEN', `input.${key}`,
          `kind: '${kind}' may not declare input key '${key}' (matches forbidden pattern ${pattern})`);
      }
    }
  }
};

/** D-126 P4.2 — per-kind risk_tier gate. Emits
 *  `INGREDIENT_KIND_TIER_MISMATCH` when `risk_tier` is not in
 *  `KIND_ALLOWED_TIERS[kind]`. Skipped when `kind` or `risk_tier` is
 *  missing/invalid (separate validators surface those) and when the
 *  manifest is kernel-authored. Catches mis-classified ingredients
 *  early — e.g. a `kind: 'ai'` manifest with
 *  `risk_tier: 'destructive'` (an inference call cannot be
 *  destructive — that belongs to `kind: 'mcp'` or
 *  `kind: 'connection'`). */
const validateKindTier = (m: Record<string, unknown>, add: AddFn): void => {
  const kind = m.kind;
  const tier = m.risk_tier;
  if (typeof kind !== 'string' || !INGREDIENT_KINDS.has(kind as IngredientKind)) return;
  if (typeof tier !== 'string' || !RISK_TIERS.has(tier as RiskTier)) return;
  if (isKernelManifest(m)) return;

  const allowed = KIND_ALLOWED_TIERS[kind as IngredientKind];
  if (!allowed.has(tier as RiskTier)) {
    add('error', 'INGREDIENT_KIND_TIER_MISMATCH', 'risk_tier',
      `risk_tier '${tier}' is not allowed for kind '${kind}' (allowed: ${[...allowed].sort().join(', ')})`);
  }
};

/** D-125 P5.1 — connection-wrapper-specific shape rules.
 *
 *  Runs only on `kind: 'connection'` manifests AND only when
 *  non-kernel. The kernel `connection` direct-adapter ingredient
 *  (`{slug:'connection', author:'recued', kind:'connection'}`) is
 *  exempt — its per-kind shape arrives flat on the recipe step input
 *  rather than the manifest, so `connection_kind` is intentionally
 *  `null` (recipe-required) and `connection` is intentionally `null`
 *  (no picker — direct callers own binding selection). Treating the
 *  kernel ingredient as a wrapper would force every direct-call
 *  recipe to declare a fake config.<X> picker.
 *
 *  Three checks for wrappers:
 *
 *    1. `input.connection_kind` must be `'api' | 'mcp' | 'notification'`.
 *       Anything else → `CONNECTION_KIND_INVALID`. Includes the
 *       missing case (no field) since wrappers stamp it as a manifest
 *       default the recipe never overrides — declaring it `null`
 *       defeats the wrapper's whole specialization.
 *
 *    2. `input.connection` must contain a `{{config.<X>}}` interpolation.
 *       Hardcoded literals (`"hubspot-prod"`) → `CONNECTION_PICKER_INVALID`
 *       because every install would land on the same global record.
 *       Other ref shapes (`{{step.X}}`, `{{vault.X}}`) likewise fail
 *       — the picker mechanism *is* `{{config.<X>}}` interpolation;
 *       the wrapper's config var is auto-derived from this field at
 *       install time. Bare null also fails (no picker to derive).
 *
 *    3. Per-`connection_kind` required input keys per spec § 5.1:
 *         api  → `method`, `path`
 *         mcp  → `tool`
 *         notification → `text`
 *       Missing key → `CONNECTION_KIND_MISSING_FIELD`. Skipped when
 *       check (1) failed — emitting both errors on the same shape
 *       just clutters the issue list with redundant signals.
 *
 *  Picker re-derivation at install time (Kitchen) reads
 *  `CONNECTION_PICKER_REGEX` against `input.connection` to extract the
 *  config var name; the validator's pattern stays in sync via the
 *  shared regex. */
export const CONNECTION_PICKER_REGEX = /\{\{config\.([a-z0-9_]+)\}\}/;

const VALID_CONNECTION_KINDS = new Set(['api', 'mcp', 'notification']);

const PER_CONNECTION_KIND_REQUIRED: Record<string, readonly string[]> = {
  api: ['method', 'path'],
  mcp: ['tool'],
  notification: ['text'],
};

/** D-127 P3.2 — notification subtype-specific required input keys.
 *  Email wrappers (`mail-post`) declare `body` instead of `text` —
 *  recipe writers picking the email channel work in body / subject /
 *  to terminology, and the runtime handler in P3.1 prefers `body`
 *  with `text` as a notification-send fan-out fallback. When a
 *  notification wrapper declares `subtype: 'email'`, the validator
 *  swaps in this subtype-specific table; subtypes with no override
 *  (slack / telegram / in-app) keep the default `text` requirement
 *  from `PER_CONNECTION_KIND_REQUIRED.notification`. */
const NOTIFICATION_SUBTYPE_REQUIRED: Record<string, readonly string[]> = {
  email: ['body'],
};

const CATALOG_APPROVALS = new Set<string>(['never', 'ask', 'always']);
/** D-165 P1 — single-endpoint wire keys a catalog-form manifest must NOT
 *  also carry. A catalog declares operations, not one wire endpoint;
 *  mixed shapes are rejected (spec § Unified ingredient schema). */
const CATALOG_FORBIDDEN_WIRE_KEYS = ['url', 'method', 'path'];
/** D-165 P2 — header names a catalog operation must NOT supply via
 *  `request_metadata.custom_headers`: auth + session headers are the
 *  gateway's to set, never the author's (spec § API-surface gates — "auth
 *  headers cannot be author-supplied in operation params"). Compared
 *  case-insensitively. */
const CATALOG_FORBIDDEN_CUSTOM_HEADERS = new Set<string>([
  'authorization', 'proxy-authorization', 'www-authenticate', 'cookie',
  'set-cookie', 'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'authentication',
]);

/** True iff `v` is an integer within `[lo, hi]` (inclusive). Catalog
 *  timeout / cache TTL fields are millisecond integers; non-integers and
 *  out-of-range values are author errors. */
const isIntInRange = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** True iff `v` is an integer ≥ `lo` (no upper bound). */
const isIntAtLeast = (v: unknown, lo: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo;

// ── D-165 P2 surfaces — local closed-list sets (built from the contract
//    arrays so the validator + the runtime share one source of truth) +
//    small shape helpers. ──
const OAUTH2_FLOW_SET = new Set<string>(OAUTH2_FLOWS);
const CALLBACK_STRATEGY_SET = new Set<string>(CALLBACK_URL_STRATEGIES);
const REST_METHOD_SET = new Set<string>(REST_METHODS);
const GRAPHQL_OP_TYPE_SET = new Set<string>(GRAPHQL_OPERATION_TYPES);
/** D-225 Slice 1 — accepted shape of an `McpExecutionBinding.tool`. The MCP
 *  spec does not constrain tool names, so this is OUR bound, chosen to cover
 *  every naming convention servers actually use (`list_files`, `project.list`,
 *  `github/create-issue`) while excluding whitespace, control characters, and
 *  anything else that would make an opaque identifier ambiguous downstream.
 *  Deliberately anchored + length-capped: Slice 2 mints these from a
 *  third-party `tools/list`. */
const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_./-]{1,128}$/;
const QUEUE_KIND_SET = new Set<string>(QUEUE_KINDS);
const CONNECTOR_TRANSPORT_SET = new Set<string>(CONNECTOR_TRANSPORTS);
const CONNECTOR_AUTH_METHOD_SET = new Set<string>(CONNECTOR_AUTH_METHODS);
const RECONNECT_POLICY_SET = new Set<string>(RECONNECT_POLICIES);
const CLI_STDIN_SET = new Set<string>(CLI_STDIN_HANDLINGS);
const CLI_OUTPUT_SHAPE_SET = new Set<string>(CLI_OUTPUT_SHAPES);
const CLI_DETACHED_MODE_SET = new Set<string>(CLI_DETACHED_MODES);
const CLI_DETACHED_COMPLETION_KIND_SET = new Set<string>(CLI_DETACHED_COMPLETION_KINDS);
const CLI_DETACHED_CANCEL_KIND_SET = new Set<string>(CLI_DETACHED_CANCEL_KINDS);
const CLI_FILE_REF_ARRAY_MAX_ITEMS = 32;
const CLI_CWD_ARG_RE = /^\{([A-Za-z_][A-Za-z0-9_.-]*)\}$/;
const WEBHOOK_HANDSHAKE_SET = new Set<string>([
  'slack_url_verification', 'graph_validation_token', 'none',
]);

const isObjectRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isCliArgvExpandEntry = (v: unknown): v is { expand_arg: string } =>
  isObjectRecord(v) && Object.keys(v).length === 1 && isNonEmptyStr(v.expand_arg);
const isCliArgvTemplate = (v: unknown): v is Array<string | { expand_arg: string }> =>
  Array.isArray(v) && v.length > 0 && v.every((x) => isNonEmptyStr(x) || isCliArgvExpandEntry(x));
const cliArgvHasScalarRef = (argv: unknown, arg: string): boolean =>
  Array.isArray(argv) && argv.some((token) => typeof token === 'string' && token.includes(`{${arg}}`));
const cliArgvHasExpandArg = (argv: unknown, arg: string): boolean =>
  Array.isArray(argv) && argv.some((token) => isObjectRecord(token) && token.expand_arg === arg);
const cliArgvExpandedArgs = (argv: unknown): string[] =>
  Array.isArray(argv)
    ? argv
      .map((token) => (isObjectRecord(token) && typeof token.expand_arg === 'string' ? token.expand_arg : undefined))
      .filter((arg): arg is string => arg !== undefined)
    : [];
const PAGINATION_SELECTOR_SET: ReadonlySet<string> = new Set(['first', 'last']);
const isJsonScalar = (value: unknown): boolean =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const validatePaginationPlacementParam = (
  raw: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  if (!isOperationPaginationPlacement(raw.placement)) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.placement`,
      `placement must be one of ${OPERATION_PAGINATION_PLACEMENTS.join('|')}`);
  }
  if (!isNonEmptyStr(raw.param)) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.param`, 'param must be a non-empty string');
  }
};

const validatePaginationPageSize = (
  raw: unknown,
  path: string,
  add: AddFn,
): void => {
  if (!isObjectRecord(raw)) {
    add('error', 'CATALOG_OPERATION_INVALID', path, 'page_size must be an object');
    return;
  }
  validatePaginationPlacementParam(raw, path, add);
  if (!Number.isInteger(raw.value) || (raw.value as number) <= 0) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.value`, 'value must be a positive integer');
  }
  if (raw.max !== undefined) {
    if (!Number.isInteger(raw.max) || (raw.max as number) <= 0) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.max`, 'max must be a positive integer when present');
    } else if (Number.isInteger(raw.value) && (raw.value as number) > (raw.max as number)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.value`, 'value must be less than or equal to max');
    }
  }
};

/** D-192 #8g — the graphql_relay page size is a GraphQL VARIABLE (`{ variable,
 *  value }`), NOT a wire placement param, so it has its own shape. */
const validateGraphqlPaginationPageSize = (
  raw: unknown,
  path: string,
  add: AddFn,
): void => {
  if (!isObjectRecord(raw)) {
    add('error', 'CATALOG_OPERATION_INVALID', path, 'page_size must be an object');
    return;
  }
  if (!isNonEmptyStr(raw.variable)) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.variable`, 'variable must be a non-empty string');
  }
  if (!Number.isInteger(raw.value) || (raw.value as number) <= 0) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.value`, 'value must be a positive integer');
  }
};

const validatePaginationCondition = (
  raw: unknown,
  path: string,
  add: AddFn,
): void => {
  if (!isObjectRecord(raw)) {
    add('error', 'CATALOG_OPERATION_INVALID', path, 'pagination condition must be an object');
    return;
  }
  if (!isNonEmptyStr(raw.path)) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.path`, 'path must be a non-empty string');
  }
  if (!hasOwn(raw, 'equals') || !isJsonScalar(raw.equals)) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.equals`, 'equals must be a JSON scalar');
  }
};

const validateOperationPagination = (
  raw: unknown,
  path: string,
  add: AddFn,
): void => {
  if (!isObjectRecord(raw)) {
    add('error', 'CATALOG_OPERATION_INVALID', path, 'pagination must be an object');
    return;
  }
  if (!isOperationPaginationStyle(raw.style)) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.style`,
      `pagination.style must be one of ${OPERATION_PAGINATION_STYLES.join('|')}`);
    return;
  }
  // The placement page-size shape covers every style EXCEPT graphql_relay, whose
  // page size is a GraphQL variable (validated inside its own branch).
  if (raw.style !== 'graphql_relay' && raw.page_size !== undefined) {
    validatePaginationPageSize(raw.page_size, `${path}.page_size`, add);
  }
  if (raw.style === 'body_cursor') {
    if (raw.next_when !== undefined) {
      validatePaginationCondition(raw.next_when, `${path}.next_when`, add);
    } else {
      add('warn', 'CATALOG_OPERATION_PAGINATION_NO_NEXT_WHEN', `${path}.next_when`,
        'body_cursor without next_when stops only on an empty final page (one extra upstream call per walk); declare the provider\'s has_more-style predicate when one exists');
    }
    if (!isObjectRecord(raw.cursor_from)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.cursor_from`, 'cursor_from must be an object');
    } else {
      if (!isNonEmptyStr(raw.cursor_from.path)) {
        add('error', 'CATALOG_OPERATION_INVALID', `${path}.cursor_from.path`, 'path must be a non-empty string');
      }
      if (typeof raw.cursor_from.select !== 'string' || !PAGINATION_SELECTOR_SET.has(raw.cursor_from.select)) {
        add('error', 'CATALOG_OPERATION_INVALID', `${path}.cursor_from.select`, 'select must be first or last');
      }
      if (!isNonEmptyStr(raw.cursor_from.field)) {
        add('error', 'CATALOG_OPERATION_INVALID', `${path}.cursor_from.field`, 'field must be a non-empty string');
      }
    }
    if (!isObjectRecord(raw.cursor_to)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.cursor_to`, 'cursor_to must be an object');
    } else {
      validatePaginationPlacementParam(raw.cursor_to, `${path}.cursor_to`, add);
    }
    return;
  }
  if (raw.style === 'query_token') {
    if (!isNonEmptyStr(raw.token_from)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.token_from`, 'token_from must be a non-empty string');
    }
    if (!isObjectRecord(raw.token_to)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.token_to`, 'token_to must be an object');
    } else {
      validatePaginationPlacementParam(raw.token_to, `${path}.token_to`, add);
    }
    if (raw.done_when !== undefined) validatePaginationCondition(raw.done_when, `${path}.done_when`, add);
    return;
  }
  if (raw.style === 'query_token_link') {
    if (!isNonEmptyStr(raw.link_from)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.link_from`, 'link_from must be a non-empty string');
    }
    if (!isNonEmptyStr(raw.query_param)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.query_param`, 'query_param must be a non-empty string');
    }
    if (!isObjectRecord(raw.token_to)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.token_to`, 'token_to must be an object');
    } else {
      validatePaginationPlacementParam(raw.token_to, `${path}.token_to`, add);
    }
    if (raw.done_when !== undefined) validatePaginationCondition(raw.done_when, `${path}.done_when`, add);
    return;
  }
  if (raw.style === 'offset') {
    if (raw.increment === 'by_page_size' && raw.page_size === undefined) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.page_size`,
        'offset pagination with increment by_page_size requires page_size (the per-cycle record advance)');
    }
    if (!isObjectRecord(raw.param)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.param`, 'param must be an object');
    } else {
      validatePaginationPlacementParam(raw.param, `${path}.param`, add);
    }
    if (!Number.isInteger(raw.start) || (raw.start as number) < 0) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.start`, 'start must be a non-negative integer');
    }
    if (raw.increment !== 'page' && raw.increment !== 'by_page_size') {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.increment`,
        'increment must be page or by_page_size');
    }
    if (raw.done_when !== undefined) validatePaginationCondition(raw.done_when, `${path}.done_when`, add);
    return;
  }
  if (raw.style === 'graphql_relay') {
    if (raw.page_size !== undefined) {
      validateGraphqlPaginationPageSize(raw.page_size, `${path}.page_size`, add);
    }
    if (!isNonEmptyStr(raw.page_info_path)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.page_info_path`,
        'page_info_path must be a non-empty string');
    }
    if (!isNonEmptyStr(raw.cursor_variable)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.cursor_variable`,
        'cursor_variable must be a non-empty string');
    }
    if (raw.has_next_field !== undefined && !isNonEmptyStr(raw.has_next_field)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.has_next_field`,
        'has_next_field must be a non-empty string when present');
    }
    if (raw.end_cursor_field !== undefined && !isNonEmptyStr(raw.end_cursor_field)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.end_cursor_field`,
        'end_cursor_field must be a non-empty string when present');
    }
    return;
  }
  if (raw.style === 'single_page') {
    // No required fields — an assertion that the whole set arrives in one call.
    // Optional page_size (validated above) lets the op request the largest page.
    return;
  }
  if (raw.style === 'next_path') {
    if (!isNonEmptyStr(raw.path)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.path`, 'path must be a non-empty string');
    }
    if (raw.done_when !== undefined) validatePaginationCondition(raw.done_when, `${path}.done_when`, add);
    if (raw.path_prefix !== undefined && !isNonEmptyStr(raw.path_prefix)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.path_prefix`, 'path_prefix must be a non-empty string when present');
    }
    return;
  }
  if (raw.header !== undefined && !isNonEmptyStr(raw.header)) {
    add('error', 'CATALOG_OPERATION_INVALID', `${path}.header`, 'header must be a non-empty string when present');
  }
};

const validateCliDetachedSpec = (
  detached: unknown,
  path: string,
  add: AddFn,
): void => {
  if (!isObjectRecord(detached)) {
    add('error', 'CATALOG_BINDING_INVALID', path,
      'cli_invocation detached must be an object when present');
    return;
  }
  if (typeof detached.mode !== 'string' || !CLI_DETACHED_MODE_SET.has(detached.mode)) {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.mode`,
      'cli_invocation detached.mode must be runtime_managed');
  }
  const completion = detached.completion;
  if (!isObjectRecord(completion)) {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.completion`,
      'cli_invocation detached.completion must be an object');
  } else {
    if (typeof completion.kind !== 'string'
      || !CLI_DETACHED_COMPLETION_KIND_SET.has(completion.kind)) {
      add('error', 'CATALOG_BINDING_INVALID', `${path}.completion.kind`,
        'cli_invocation detached.completion.kind must be marker_file');
    }
    if (!isNonEmptyStr(completion.exit_pattern)) {
      add('error', 'CATALOG_BINDING_INVALID', `${path}.completion.exit_pattern`,
        'cli_invocation detached.completion.exit_pattern must be a non-empty string');
    }
    if (completion.log_pattern !== undefined && !isNonEmptyStr(completion.log_pattern)) {
      add('error', 'CATALOG_BINDING_INVALID', `${path}.completion.log_pattern`,
        'cli_invocation detached.completion.log_pattern must be a non-empty string when present');
    }
  }
  const cancel = detached.cancel;
  if (cancel !== undefined) {
    if (!isObjectRecord(cancel)) {
      add('error', 'CATALOG_BINDING_INVALID', `${path}.cancel`,
        'cli_invocation detached.cancel must be an object when present');
    } else {
      if (typeof cancel.kind !== 'string' || !CLI_DETACHED_CANCEL_KIND_SET.has(cancel.kind)) {
        add('error', 'CATALOG_BINDING_INVALID', `${path}.cancel.kind`,
          'cli_invocation detached.cancel.kind must be process_group');
      }
      if (!isNonEmptyStr(cancel.pid_pattern)) {
        add('error', 'CATALOG_BINDING_INVALID', `${path}.cancel.pid_pattern`,
          'cli_invocation detached.cancel.pid_pattern must be a non-empty string');
      }
    }
  }
};

/** D-181 Slice 3 — manifest-level long-op fields (`progress_contract` +
 *  `fast_path`). `fast_path` is a lane-bypass escape hatch — forbid it on the
 *  RAM-scarce `service` lane (a heavy subprocess marking itself fast_path would
 *  evade RAM gating). It is redundant-but-harmless on `storage` / `ai` (those
 *  already bypass the semaphore by kind), so only `service` is rejected. */
const PROGRESS_CONTRACT_SET = new Set<string>(PROGRESS_CONTRACTS);
const validateLongOpFields = (m: Record<string, unknown>, add: AddFn): void => {
  if (m.progress_contract !== undefined
    && (typeof m.progress_contract !== 'string' || !PROGRESS_CONTRACT_SET.has(m.progress_contract))) {
    add('error', 'PROGRESS_CONTRACT_INVALID', 'progress_contract',
      'progress_contract must be one of heartbeat|file-growth|provider-event|silent');
  }
  if (m.fast_path !== undefined && typeof m.fast_path !== 'boolean') {
    add('error', 'FAST_PATH_INVALID', 'fast_path', 'fast_path must be a boolean when present');
  }
  if (m.fast_path === true && m.kind === 'service') {
    add('error', 'FAST_PATH_FORBIDDEN_KIND', 'fast_path',
      "fast_path is not allowed on kind 'service' — a local-heavy (RAM-gated) subprocess op cannot bypass the lane governor");
  }
};

/** D-181 Slice 3 — validate a foreground cli op's optional `progress` spec.
 *  Fails closed: an unknown contract, the http-only `provider-event` on a local
 *  subprocess, a `file-growth` op missing its `watch_path`, a `watch_path` on a
 *  non-`file-growth` contract, a `watch_path` arg the command never references,
 *  or `progress` on a (foreground-only) detached binding are all rejected. */
const validateCliProgressSpec = (
  binding: Record<string, unknown>,
  opKey: string,
  path: string,
  add: AddFn,
): void => {
  const progress = binding.progress;
  if (!isObjectRecord(progress)) {
    add('error', 'CATALOG_BINDING_INVALID', path,
      `cli_invocation binding for '${opKey}' progress must be an object when present`);
    return;
  }
  // progress is foreground-only — runDetached never builds a monitor.
  if (binding.detached !== undefined) {
    add('error', 'CATALOG_BINDING_INVALID', path,
      `cli_invocation binding for '${opKey}' progress (foreground stall detection) is not supported on a detached binding`);
  }
  const contract = progress.contract;
  if (typeof contract !== 'string' || !PROGRESS_CONTRACT_SET.has(contract)) {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.contract`,
      `cli_invocation binding for '${opKey}' progress.contract must be one of heartbeat|file-growth|silent`);
  } else if (contract === 'provider-event') {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.contract`,
      `cli_invocation binding for '${opKey}' progress.contract 'provider-event' is for http/streaming ops, not a local subprocess (use heartbeat|file-growth|silent)`);
  }
  const watchPath = progress.watch_path;
  if (watchPath !== undefined && !isNonEmptyStr(watchPath)) {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.watch_path`,
      `cli_invocation binding for '${opKey}' progress.watch_path must be a non-empty string when present`);
  }
  if (contract === 'file-growth' && !isNonEmptyStr(watchPath)) {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.watch_path`,
      `cli_invocation binding for '${opKey}' progress.contract 'file-growth' requires a watch_path (the output file to poll for growth)`);
  }
  if (watchPath !== undefined && contract !== 'file-growth') {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.watch_path`,
      `cli_invocation binding for '${opKey}' progress.watch_path is only valid with contract 'file-growth'`);
  }
  // The watched output file must be one the command is actually told to write —
  // every {ref} in watch_path must also appear in argv_template. Catches typo'd
  // refs and watch paths pointed at an unrelated file (a false-stall hazard).
  if (contract === 'file-growth' && isNonEmptyStr(watchPath)) {
    const argvRefs = new Set<string>();
    if (Array.isArray(binding.argv_template)) {
      for (const tok of binding.argv_template) {
        for (const ref of cliDetachedTemplateRefs(tok)) argvRefs.add(ref);
      }
    }
    for (const ref of cliDetachedTemplateRefs(watchPath)) {
      if (!argvRefs.has(ref)) {
        add('error', 'CATALOG_BINDING_INVALID', `${path}.watch_path`,
          `cli_invocation binding for '${opKey}' progress.watch_path arg '${ref}' must also appear in argv_template (the watched file must be one the command writes)`);
      }
    }
  }
};

const CLI_DETACHED_PATTERN_REF_RE = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;
const CLI_DETACHED_PATTERN_ROOT = '{result_dir}/';

const cliDetachedTemplateRefs = (template: unknown): string[] => {
  if (typeof template !== 'string') return [];
  const refs = new Set<string>();
  for (const match of template.matchAll(CLI_DETACHED_PATTERN_REF_RE)) {
    if (match[1] !== 'code') refs.add(match[1]);
  }
  return [...refs];
};

const targetEditableArgKeys = (opSpec: unknown): ReadonlySet<string> => {
  const keys = new Set<string>();
  if (!isObjectRecord(opSpec) || !Array.isArray(opSpec.editable_args)) return keys;
  for (const entry of opSpec.editable_args) {
    if (isObjectRecord(entry) && typeof entry.key === 'string' && entry.affects_target === true) {
      keys.add(entry.key);
    }
  }
  return keys;
};

const editableArgKeys = (opSpec: unknown): ReadonlySet<string> => {
  const keys = new Set<string>();
  if (!isObjectRecord(opSpec) || !Array.isArray(opSpec.editable_args)) return keys;
  for (const entry of opSpec.editable_args) {
    if (isObjectRecord(entry) && typeof entry.key === 'string') keys.add(entry.key);
  }
  return keys;
};

const objectKeysExactly = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const expectedKeys = [...expected].sort();
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, idx) => key === expectedKeys[idx]);
};

const cliCwdArgRef = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = value.match(CLI_CWD_ARG_RE);
  return match?.[1];
};

const validateCliCwdSpec = (
  binding: Record<string, unknown>,
  opSpec: unknown,
  opKey: string,
  path: string,
  add: AddFn,
): void => {
  const cwd = binding.cwd;
  if (cwd === undefined) return;
  if (!isObjectRecord(cwd) || !objectKeysExactly(cwd, ['arg'])) {
    add('error', 'CATALOG_BINDING_INVALID', path,
      `cli_invocation binding for '${opKey}' cwd must be an object with exactly { arg: "{arg_name}" } when present`);
    return;
  }
  const ref = cliCwdArgRef(cwd.arg);
  if (ref === undefined) {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.arg`,
      `cli_invocation binding for '${opKey}' cwd.arg must be a single {arg_name} template token`);
    return;
  }
  if (!targetEditableArgKeys(opSpec).has(ref)) {
    add('error', 'CATALOG_BINDING_INVALID', `${path}.arg`,
      `cli_invocation binding for '${opKey}' cwd arg '${ref}' must be declared in editable_args with affects_target: true`);
  }
};

/** Runtime contract for detached CLI marker patterns (mirrors the authoring
 *  validator + the server executor): every pattern is confined under the
 *  `result_dir` arg, so it must be rooted there, and every template arg the
 *  patterns interpolate must be human-visible at the approval surface
 *  (`editable_args` with `affects_target: true`). */
const validateCliDetachedConventions = (
  detached: unknown,
  opSpec: unknown,
  path: string,
  add: AddFn,
): void => {
  if (!isObjectRecord(detached)) return;
  const completion = isObjectRecord(detached.completion) ? detached.completion : {};
  const cancel = isObjectRecord(detached.cancel) ? detached.cancel : {};
  const patterns: ReadonlyArray<[string, unknown]> = [
    [`${path}.completion.exit_pattern`, completion.exit_pattern],
    [`${path}.completion.log_pattern`, completion.log_pattern],
    [`${path}.cancel.pid_pattern`, cancel.pid_pattern],
  ];
  const refs = new Set<string>();
  for (const [patternPath, pattern] of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue;
    if (!pattern.startsWith(CLI_DETACHED_PATTERN_ROOT)) {
      add('error', 'CATALOG_BINDING_INVALID', patternPath,
        `detached marker patterns must start with '${CLI_DETACHED_PATTERN_ROOT}' — the runtime confines them under the result_dir arg`);
    }
    for (const ref of cliDetachedTemplateRefs(pattern)) refs.add(ref);
  }
  if (refs.size === 0) return;
  const targetArgs = targetEditableArgKeys(opSpec);
  for (const ref of refs) {
    if (targetArgs.has(ref)) continue;
    add('error', 'CATALOG_BINDING_INVALID', path,
      `detached marker template arg '${ref}' must be declared in editable_args with affects_target: true`);
  }
};

/** `default_base_url` must be HTTPS, with an explicit localhost / loopback
 *  dev exception (spec § API-surface gates). */
const isHttpsOrLocalBaseUrl = (url: string): boolean =>
  url.startsWith('https://')
  || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?)/.test(url);

/** The per-surface hard cap for catalog-level `default_timeout_ms` (spec
 *  § Timeout gates: REST ≤ 60s, GraphQL ≤ 180s, connector method invoke
 *  ≤ 120s). With NO surface declared the cap is the loosest (GraphQL 180s),
 *  so a surfaceless P0/P1 catalog keeps its existing bound unchanged. When
 *  multiple surfaces are present the LOOSEST applicable cap wins —
 *  `default_timeout_ms` is catalog-wide, so a value valid for any one
 *  declared surface must not be rejected. (Per-OPERATION `timeout_ms` may
 *  still exceed this for long-poll ops — that's gated separately by the ×3
 *  rule and is intentionally allowed.) */
const surfaceDefaultTimeoutCapMs = (surfaces: unknown): number => {
  if (!isObjectRecord(surfaces)) return CATALOG_MAX_DEFAULT_TIMEOUT_MS;
  const caps: number[] = [];
  if (isObjectRecord(surfaces.api)) {
    // rest → 60s; graphql / unknown transport → loosest (180s) so a malformed
    // transport (which errors separately) doesn't falsely tighten the cap.
    caps.push(surfaces.api.transport === 'rest'
      ? CATALOG_REST_TIMEOUT_SOFT_CAP_MS
      : CATALOG_MAX_DEFAULT_TIMEOUT_MS);
  }
  if (isObjectRecord(surfaces.connector)) caps.push(CATALOG_CONNECTOR_INVOKE_TIMEOUT_CAP_MS);
  return caps.length === 0 ? CATALOG_MAX_DEFAULT_TIMEOUT_MS : Math.max(...caps);
};

/** Validate `surfaces.api.auth` per kind; return the CONSTRAINED scope
 *  universe (the union of declared scopes) for the coverage gate, or null
 *  when coverage can't / shouldn't be checked: no-auth, signed-request, an
 *  api_key with any unconstrained slot (a slot omitting `available_scopes`
 *  could authorize anything), or a structurally invalid auth (returning a
 *  partial universe would emit misleading coverage errors atop the structural
 *  ones). Errors are reported via `add` as a side effect. */
const validateAuthSpec = (rawAuth: unknown, add: AddFn): Set<string> | null => {
  if (!isObjectRecord(rawAuth)) {
    add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth', 'surfaces.api.auth must be an object');
    return null;
  }
  if (!isAuthKind(rawAuth.kind)) {
    add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.kind',
      'surfaces.api.auth.kind must be one of oauth2|api_key|signed_request|none');
    return null;
  }
  const kind = rawAuth.kind;
  if (kind === 'none') return null;
  if (kind === 'signed_request') {
    if (!isNonEmptyStr(rawAuth.signing_scheme)) {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.signing_scheme',
        'signed_request auth must declare a non-empty signing_scheme');
    }
    if (!isStrArray(rawAuth.signing_material_fields) || rawAuth.signing_material_fields.length === 0) {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.signing_material_fields',
        'signed_request auth must declare a non-empty signing_material_fields string array');
    }
    return null;
  }
  if (kind === 'oauth2') {
    let ok = true;
    if (typeof rawAuth.flow !== 'string' || !OAUTH2_FLOW_SET.has(rawAuth.flow)) {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.flow',
        'oauth2 flow must be one of authorization_code|authorization_code_pkce|client_credentials');
      ok = false;
    }
    if (!isNonEmptyStr(rawAuth.authorize_url)) {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.authorize_url',
        'oauth2 auth must declare a non-empty authorize_url'); ok = false;
    }
    if (!isNonEmptyStr(rawAuth.token_url)) {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.token_url',
        'oauth2 auth must declare a non-empty token_url'); ok = false;
    }
    if (typeof rawAuth.refresh_supported !== 'boolean') {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.refresh_supported',
        'oauth2 auth refresh_supported must be a boolean'); ok = false;
    }
    if (rawAuth.scope_separator !== ' ' && rawAuth.scope_separator !== ',') {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.scope_separator',
        "oauth2 auth scope_separator must be ' ' or ','"); ok = false;
    }
    if (typeof rawAuth.callback_url_strategy !== 'string'
      || !CALLBACK_STRATEGY_SET.has(rawAuth.callback_url_strategy)) {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.callback_url_strategy',
        'oauth2 auth callback_url_strategy must be one of pro_static|byo_domain|manual'); ok = false;
    }
    if (rawAuth.pkce_required !== undefined && typeof rawAuth.pkce_required !== 'boolean') {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.pkce_required',
        'oauth2 auth pkce_required must be a boolean'); ok = false;
    }
    const tokenTypes = rawAuth.token_types;
    if (!isObjectRecord(tokenTypes) || Object.keys(tokenTypes).length === 0) {
      add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.token_types',
        'oauth2 auth must declare a non-empty token_types map');
      return null;
    }
    const universe = new Set<string>();
    let tokenTypesOk = true;
    for (const [ttKey, rawTt] of Object.entries(tokenTypes)) {
      const ttPath = `surfaces.api.auth.token_types.${ttKey}`;
      if (!isObjectRecord(rawTt)) {
        add('error', 'CATALOG_AUTH_INVALID', ttPath, `token_type '${ttKey}' must be an object`);
        tokenTypesOk = false; continue;
      }
      if (!isNonEmptyStr(rawTt.label)) {
        add('error', 'CATALOG_AUTH_INVALID', `${ttPath}.label`,
          `token_type '${ttKey}' must declare a non-empty label`);
        tokenTypesOk = false;
      }
      if (!isStrArray(rawTt.available_scopes)) {
        add('error', 'CATALOG_AUTH_INVALID', `${ttPath}.available_scopes`,
          `token_type '${ttKey}' available_scopes must be an array of strings`);
        tokenTypesOk = false;
      } else {
        for (const s of rawTt.available_scopes) universe.add(s);
      }
      if (rawTt.required_for_operations !== undefined
        && rawTt.required_for_operations !== 'all'
        && !isStrArray(rawTt.required_for_operations)) {
        add('error', 'CATALOG_AUTH_INVALID', `${ttPath}.required_for_operations`,
          `token_type '${ttKey}' required_for_operations must be 'all' or an array of operation ids`);
        tokenTypesOk = false;
      }
    }
    return ok && tokenTypesOk ? universe : null;
  }
  // kind === 'api_key'
  const keySlots = rawAuth.key_slots;
  if (!isObjectRecord(keySlots) || Object.keys(keySlots).length === 0) {
    add('error', 'CATALOG_AUTH_INVALID', 'surfaces.api.auth.key_slots',
      'api_key auth must declare a non-empty key_slots map');
    return null;
  }
  const universe = new Set<string>();
  let anyUnconstrained = false;
  let slotsOk = true;
  for (const [slotKey, rawSlot] of Object.entries(keySlots)) {
    const slotPath = `surfaces.api.auth.key_slots.${slotKey}`;
    if (!isObjectRecord(rawSlot)) {
      add('error', 'CATALOG_AUTH_INVALID', slotPath, `key_slot '${slotKey}' must be an object`);
      slotsOk = false; continue;
    }
    if (!isNonEmptyStr(rawSlot.label)) {
      add('error', 'CATALOG_AUTH_INVALID', `${slotPath}.label`,
        `key_slot '${slotKey}' must declare a non-empty label`);
      slotsOk = false;
    }
    for (const strField of ['header_name', 'prefix', 'query_param'] as const) {
      if (rawSlot[strField] !== undefined && typeof rawSlot[strField] !== 'string') {
        add('error', 'CATALOG_AUTH_INVALID', `${slotPath}.${strField}`,
          `key_slot '${slotKey}' ${strField} must be a string`);
        slotsOk = false;
      }
    }
    if (rawSlot.required_for_operations !== undefined
      && rawSlot.required_for_operations !== 'all'
      && !isStrArray(rawSlot.required_for_operations)) {
      add('error', 'CATALOG_AUTH_INVALID', `${slotPath}.required_for_operations`,
        `key_slot '${slotKey}' required_for_operations must be 'all' or an array of operation ids`);
      slotsOk = false;
    }
    if (rawSlot.available_scopes === undefined) {
      anyUnconstrained = true;
    } else if (!isStrArray(rawSlot.available_scopes)) {
      add('error', 'CATALOG_AUTH_INVALID', `${slotPath}.available_scopes`,
        `key_slot '${slotKey}' available_scopes must be an array of strings`);
      slotsOk = false;
    } else {
      for (const s of rawSlot.available_scopes) universe.add(s);
    }
  }
  return slotsOk && !anyUnconstrained ? universe : null;
};

/** A binding path must be relative to base_url — NOT a full URL (`scheme://`)
 *  nor protocol-relative (`//host`), both of which let `new URL` silently swap
 *  the host (Codex review HIGH). The connection adapter enforces same-origin at
 *  runtime; this is the publish-time gate. */
const isAbsoluteOrProtocolRelativePath = (p: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith('//');

/** D-192 Gate E′ — a GraphQL `result_data_path` (the fail-when-data-null
 *  envelope walk) must be `''` (root — handled by the caller) or a dot-path of
 *  field names: each dot-segment is a non-empty identifier
 *  (`[A-Za-z_][A-Za-z0-9_]*`) and NOT prototype-sensitive. This rejects empty
 *  segments (`.` / `data.`) and `__proto__` / `constructor` / `prototype`, which
 *  the runtime own-property walk would otherwise have to defend against alone. */
const GRAPHQL_DATA_PATH_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GRAPHQL_DATA_PATH_PROTO_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const isSafeGraphqlDataPath = (path: string): boolean =>
  path.split('.').every(
    (seg) => GRAPHQL_DATA_PATH_SEGMENT_RE.test(seg) && !GRAPHQL_DATA_PATH_PROTO_SEGMENTS.has(seg),
  );

/** Per-kind shape gate for one API execution binding. */
const validateApiBindingShape = (
  binding: Record<string, unknown>,
  kind: string,
  baseUrlSet: boolean,
  add: AddFn,
  bPath: string,
  opKey: string,
  opSpec: unknown,
): void => {
  switch (kind) {
    case 'rest': {
      if (typeof binding.method !== 'string' || !REST_METHOD_SET.has(binding.method)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.method`,
          `rest binding for '${opKey}' method must be one of GET|POST|PUT|PATCH|DELETE`);
      }
      if (!isNonEmptyStr(binding.path_template)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.path_template`,
          `rest binding for '${opKey}' must declare a non-empty path_template`);
      } else if (baseUrlSet && isAbsoluteOrProtocolRelativePath(binding.path_template as string)) {
        // Path templates cannot be full / protocol-relative URLs when
        // default_base_url is set (spec § API-surface gates; Codex HIGH).
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.path_template`,
          `rest binding for '${opKey}' path_template must be a path, not a full or protocol-relative URL, when default_base_url is set`);
      }
      // D-192 CORE #8a — optional per-op OpenAPI-proof path override (proving-
      // only; the runtime calls `path_template`). Must be a non-empty path; the
      // prover further constrains it either to an interior segment expansion or,
      // with an explicit parameter-expansion declaration, to an exact composite
      // parameter expansion of the wire path.
      if (binding.openapi_path !== undefined
        && (!isNonEmptyStr(binding.openapi_path) || !(binding.openapi_path as string).startsWith('/'))) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.openapi_path`,
          `rest binding for '${opKey}' openapi_path must be a non-empty path starting with '/' when present`);
      }
      const openapiParamExpansions = binding.openapi_path_param_expansions;
      if (openapiParamExpansions !== undefined) {
        if (!isNonEmptyStr(binding.openapi_path)) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.openapi_path_param_expansions`,
            `rest binding for '${opKey}' openapi_path_param_expansions requires openapi_path`);
        }
        if (!isObjectRecord(openapiParamExpansions)
          || Object.keys(openapiParamExpansions).length === 0) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.openapi_path_param_expansions`,
            `rest binding for '${opKey}' openapi_path_param_expansions must be a non-empty object`);
        } else {
          const seenWireArgs = new Set<string>();
          for (const [docParam, wireArgs] of Object.entries(openapiParamExpansions)) {
            if (!/^[A-Za-z0-9._-]+$/.test(docParam)) {
              add('error', 'CATALOG_BINDING_INVALID', `${bPath}.openapi_path_param_expansions.${docParam}`,
                `rest binding for '${opKey}' OpenAPI parameter names must contain only letters, digits, dot, underscore, or hyphen`);
            }
            if (!Array.isArray(wireArgs) || wireArgs.length < 2
              || wireArgs.some((arg) => typeof arg !== 'string'
                || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg))) {
              add('error', 'CATALOG_BINDING_INVALID', `${bPath}.openapi_path_param_expansions.${docParam}`,
                `rest binding for '${opKey}' each OpenAPI parameter expansion must name at least two safe wire arguments`);
              continue;
            }
            if (new Set(wireArgs).size !== wireArgs.length
              || wireArgs.some((arg) => seenWireArgs.has(arg))) {
              add('error', 'CATALOG_BINDING_INVALID', `${bPath}.openapi_path_param_expansions.${docParam}`,
                `rest binding for '${opKey}' OpenAPI parameter expansions may not repeat a wire argument`);
            }
            wireArgs.forEach((arg) => seenWireArgs.add(arg));
          }
        }
      }
      // D-165 RUNTIME — static_query / static_headers carry the binding's fixed
      // wire bits (the `query.*` / `header.*` the gateway folds into the
      // connection-api call); D-192 adds static_body (fixed `body.*` fields —
      // the azure-devops WIQL text). All optional; when present each must be a
      // flat object of string values.
      for (const staticKey of ['static_query', 'static_headers', 'static_body'] as const) {
        const sv = binding[staticKey];
        if (sv === undefined) continue;
        if (!isObjectRecord(sv) || Object.values(sv).some((v) => typeof v !== 'string')) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.${staticKey}`,
            `rest binding for '${opKey}' ${staticKey} must be an object of string values`);
          continue;
        }
        // static_headers cannot bake an engine-locked header name (host /
        // authorization / cookie) — the connection adapter owns those (D-112).
        // Case-insensitive: HTTP header names are case-insensitive.
        if (staticKey === 'static_headers') {
          for (const hName of Object.keys(sv)) {
            if (isLockedInputKey(`header.${hName.trim().toLowerCase()}`)) {
              add('error', 'CATALOG_BINDING_INVALID', `${bPath}.static_headers.${hName}`,
                `rest binding for '${opKey}' static_headers cannot set the engine-locked header '${hName}' (host / authorization / cookie are owned by the connection adapter, D-112)`);
            }
          }
        }
      }
      // D-192 — static_body composes a JSON request body; on a bodyless method
      // (GET / DELETE) the wire silently drops it, so a declaration there is a
      // dead/misleading binding — reject at publish.
      if (binding.static_body !== undefined
        && typeof binding.method === 'string'
        && !['POST', 'PUT', 'PATCH'].includes(binding.method)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.static_body`,
          `rest binding for '${opKey}' static_body requires a body-carrying method (POST/PUT/PATCH), got ${binding.method}`);
      }
      // static_body keys are LITERAL top-level JSON property names (the
      // adapter strips `body.` and encodes the remainder as-is) — a dotted
      // key would emit a literal "a.b" property, which is almost never the
      // intended nested tree. Fail closed; widen if a literal-dotted-property
      // vendor ever appears (codex-review fold).
      if (isObjectRecord(binding.static_body)) {
        for (const bodyKey of Object.keys(binding.static_body)) {
          if (bodyKey.includes('.')) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.static_body.${bodyKey}`,
              `rest binding for '${opKey}' static_body key '${bodyKey}' contains a dot — keys are literal top-level JSON property names, not nested paths; compose nested bodies upstream or flatten the key`);
          }
        }
      }
      // Basecamp/int64 audit fold — closed opt-in JSON response normalization.
      // A typo must fail publish rather than silently reverting to lossy native
      // number parsing. Raw binary capture bypasses JSON parsing, so the two
      // response modes are mutually exclusive.
      if (binding.response_json !== undefined) {
        const specPath = `${bPath}.response_json`;
        if (!isObjectRecord(binding.response_json)
          || Object.keys(binding.response_json).length !== 1
          || binding.response_json.unsafe_integers !== 'string') {
          add('error', 'CATALOG_BINDING_INVALID', specPath,
            `rest binding for '${opKey}' response_json must be exactly { unsafe_integers: 'string' }`);
        }
        if (binding.response_capture !== undefined) {
          add('error', 'CATALOG_BINDING_INVALID', specPath,
            `rest binding for '${opKey}' cannot combine response_json with response_capture`);
        }
      }
      if (binding.request_json !== undefined) {
        const specPath = `${bPath}.request_json`;
        const spec = binding.request_json;
        const selectors = isObjectRecord(spec) ? spec.decimal_integer_fields : undefined;
        const selectorRe = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?$/;
        const shapeValid = isObjectRecord(spec)
          && Object.keys(spec).length === 1
          && isStrArray(selectors)
          && selectors.length > 0
          && new Set(selectors).size === selectors.length
          && selectors.every((field) => selectorRe.test(field));
        if (!shapeValid) {
          add('error', 'CATALOG_BINDING_INVALID', specPath,
            `rest binding for '${opKey}' request_json must be exactly { decimal_integer_fields: [unique top-level field or field[] selectors] }`);
        } else {
          const requestSchema = isObjectRecord(opSpec) && isObjectRecord(opSpec.request_schema)
            ? opSpec.request_schema
            : {};
          const properties = isObjectRecord(requestSchema.properties) ? requestSchema.properties : {};
          for (const selector of selectors) {
            const array = selector.endsWith('[]');
            const argKey = `body.${selector.replace(/\[\]$/, '')}`;
            const property = properties[argKey];
            const schemaMatches = isObjectRecord(property)
              && property.type === (array ? 'array' : 'string')
              && (!array || (isObjectRecord(property.items) && property.items.type === 'string'));
            if (!schemaMatches) {
              add('error', 'CATALOG_BINDING_INVALID', specPath,
                `rest binding for '${opKey}' request_json selector '${selector}' requires operation request_schema.properties['${argKey}'] to describe ${array ? 'an array of strings' : 'a string'}`);
            }
          }
        }
        if (typeof binding.method === 'string' && !['POST', 'PUT', 'PATCH'].includes(binding.method)) {
          add('error', 'CATALOG_BINDING_INVALID', specPath,
            `rest binding for '${opKey}' request_json requires a body-carrying method (POST/PUT/PATCH)`);
        }
        const headers = isObjectRecord(binding.static_headers) ? binding.static_headers : {};
        const contentType = Object.entries(headers)
          .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
        if (contentType !== undefined
          && (typeof contentType !== 'string'
            || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')) {
          add('error', 'CATALOG_BINDING_INVALID', specPath,
            `rest binding for '${opKey}' request_json requires application/json when static Content-Type is declared`);
        }
      }
      // D-182 (CRM Tier-P) — merge_query lists static_query keys whose value a
      // caller `query.<k>` arg UNIONS with (instead of being clobbered). Each
      // entry must name an existing static_query key (an absent key has no
      // default list to extend → a typo / dead declaration).
      {
        const mq = (binding as { merge_query?: unknown }).merge_query;
        if (mq !== undefined) {
          const sq = isObjectRecord(binding.static_query) ? binding.static_query : {};
          if (!Array.isArray(mq) || mq.some((k) => typeof k !== 'string')) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.merge_query`,
              `rest binding for '${opKey}' merge_query must be an array of static_query key names`);
          } else {
            for (const k of mq) {
              if (!Object.prototype.hasOwnProperty.call(sq, k)) {
                add('error', 'CATALOG_BINDING_INVALID', `${bPath}.merge_query`,
                  `rest binding for '${opKey}' merge_query names '${k}', which is not a declared static_query key`);
              }
            }
          }
        }
      }
      break;
    }
    case 'graphql': {
      if (typeof binding.operation_type !== 'string' || !GRAPHQL_OP_TYPE_SET.has(binding.operation_type)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.operation_type`,
          `graphql binding for '${opKey}' operation_type must be one of query|mutation|subscription`);
      } else if (binding.operation_type === 'subscription') {
        // D-165 RUNTIME — the gateway dispatches graphql as an HTTP POST; a
        // subscription needs a WS/SSE substrate that isn't built. Reject at
        // publish so it can't POST-and-fail at runtime (Codex review MEDIUM).
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.operation_type`,
          `graphql binding for '${opKey}' operation_type 'subscription' is not dispatchable over the HTTP api surface (no WS/SSE substrate yet)`);
      }
      if (!isNonEmptyStr(binding.query)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.query`,
          `graphql binding for '${opKey}' must declare a non-empty query document`);
      }
      // D-165 RUNTIME — the gateway POSTs `{ query, variables }` to this path
      // (relative to base_url). Required + same path-not-full/protocol-relative
      // gate as REST.
      if (!isNonEmptyStr(binding.endpoint_path)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.endpoint_path`,
          `graphql binding for '${opKey}' must declare a non-empty endpoint_path (POST target, e.g. '/graphql')`);
      } else if (baseUrlSet && isAbsoluteOrProtocolRelativePath(binding.endpoint_path as string)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.endpoint_path`,
          `graphql binding for '${opKey}' endpoint_path must be a path, not a full or protocol-relative URL, when default_base_url is set`);
      }
      // D-192 Gate E′ — the fail-when-data-null envelope path. Optional string
      // dot-path within the response body (default 'data'); `''` = data-at-root.
      // A non-empty path must be a safe dot-path of field names (no empty or
      // prototype-sensitive segments) — the runtime walks it own-property-only,
      // and this closes a `__proto__`/`toString` path that would mask an absent
      // payload as success.
      if (binding.result_data_path !== undefined) {
        if (typeof binding.result_data_path !== 'string') {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.result_data_path`,
            `graphql binding for '${opKey}' result_data_path must be a string dot-path (default 'data')`);
        } else if (binding.result_data_path !== '' && !isSafeGraphqlDataPath(binding.result_data_path)) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.result_data_path`,
            `graphql binding for '${opKey}' result_data_path must be '' (root) or a dot-path of field `
              + `names ([A-Za-z_][A-Za-z0-9_]*) with no empty or prototype-sensitive segments`);
        }
      }
      break;
    }
    case 'mcp': {
      // D-225 Slice 1 — `tool` is the binding's WHOLE call target, so a missing
      // or empty one is not a cosmetic omission: it is an undispatchable op.
      if (!isNonEmptyStr(binding.tool)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.tool`,
          `mcp binding for '${opKey}' must declare a non-empty tool name`);
      } else if (!MCP_TOOL_NAME_RE.test(binding.tool as string)) {
        // Bound the shape rather than accept any string. The name goes out as
        // the JSON-RPC `params.name` verbatim, and a generated pack (Slice 2)
        // will mint these from a third-party `tools/list` — so the constraint
        // exists to keep a hostile server from smuggling whitespace, control
        // characters, or a display-name-shaped string into an identifier the
        // rest of the system treats as opaque.
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.tool`,
          `mcp binding for '${opKey}' tool must be 1-128 chars of letters, digits, '_', '-', '.', or '/' `
            + `(got ${JSON.stringify(binding.tool)})`);
      }
      // No path/method/endpoint gate: an mcp binding names no URL. The server
      // endpoint is the CONNECTION record's (`config.endpoint` / the stdio
      // launch spec), which is exactly the per-connection resolution a REST
      // binding gets from `base_url` — so an mcp op is portable across two
      // enrollments of the same server for the same reason a REST op is.
      break;
    }
    case 'webhook_subscription': {
      const profileIdPresent = hasOwn(binding, 'profile_id');
      const signatureSchemePresent = hasOwn(binding, 'signature_scheme');
      const hasLegacyScheme = isNonEmptyStr(binding.signature_scheme);
      const hasRegisteredProfile = isWebhookProfileId(binding.profile_id);

      if (!profileIdPresent && !hasLegacyScheme) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.signature_scheme`,
          `webhook binding for '${opKey}' must declare a registered profile_id (legacy signature_scheme remains accepted during migration)`);
      }
      if (profileIdPresent && !hasRegisteredProfile) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.profile_id`,
          `webhook binding for '${opKey}' profile_id must name a profile in the trusted webhook registry`);
      }
      if (signatureSchemePresent && !hasLegacyScheme) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.signature_scheme`,
          `webhook binding for '${opKey}' signature_scheme must be a non-empty string when present`);
      }
      if (binding.handshake !== undefined
        && (typeof binding.handshake !== 'string' || !WEBHOOK_HANDSHAKE_SET.has(binding.handshake))) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.handshake`,
          `webhook binding for '${opKey}' handshake must be one of slack_url_verification|graph_validation_token|none`);
      }
      if (hasRegisteredProfile && binding.handshake !== undefined && binding.handshake !== 'none') {
        const profile = webhookProfile(binding.profile_id);
        if (profile !== null && !profile.handshakes.includes(binding.handshake as string)) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.handshake`,
            `webhook binding for '${opKey}' handshake '${String(binding.handshake)}' is not supported by profile '${profile.profile_id}'`);
        }
      }
      if (binding.retry_tolerance_window_seconds !== undefined
        && (typeof binding.retry_tolerance_window_seconds !== 'number'
          || !Number.isFinite(binding.retry_tolerance_window_seconds)
          || binding.retry_tolerance_window_seconds < 0)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.retry_tolerance_window_seconds`,
          `webhook binding for '${opKey}' retry_tolerance_window_seconds must be a non-negative number`);
      } else if (hasRegisteredProfile && binding.retry_tolerance_window_seconds !== undefined) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.retry_tolerance_window_seconds`,
          `webhook binding for '${opKey}' may not override replay/freshness tolerance owned by profile '${String(binding.profile_id)}'`);
      }
      break;
    }
    case 'queue_subscription': {
      if (typeof binding.queue_kind !== 'string' || !QUEUE_KIND_SET.has(binding.queue_kind)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.queue_kind`,
          `queue binding for '${opKey}' queue_kind must be one of sns_sqs|gcp_pubsub|azure_servicebus`);
      }
      if (!isObjectRecord(binding.subscription_metadata)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.subscription_metadata`,
          `queue binding for '${opKey}' must declare a subscription_metadata object`);
      }
      // poll_timeout_ms — shape (non-negative integer) + the per-queue-kind
      // ceiling (QUEUE_POLL_TIMEOUT_CAP_MS): `sns_sqs` is AWS's documented hard
      // max (WaitTimeSeconds ≤ 20s); `gcp_pubsub` / `azure_servicebus` carry
      // Recued's resource-discipline ceiling (60s) since neither vendor pins a
      // crisp universal single-receive max. The cap check is skipped when
      // `queue_kind` is itself invalid (its own error already fired above).
      const pollTimeout = binding.poll_timeout_ms;
      if (pollTimeout !== undefined) {
        if (typeof pollTimeout !== 'number' || !Number.isInteger(pollTimeout) || pollTimeout < 0) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.poll_timeout_ms`,
            `queue binding for '${opKey}' poll_timeout_ms must be a non-negative integer`);
        } else if (QUEUE_KIND_SET.has(binding.queue_kind as string)) {
          const cap = QUEUE_POLL_TIMEOUT_CAP_MS[binding.queue_kind as QueueKind];
          if (pollTimeout > cap) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.poll_timeout_ms`,
              `queue binding for '${opKey}' poll_timeout_ms ${pollTimeout} exceeds the ${binding.queue_kind} cap of ${cap}ms (spec § Timeout gates)`);
          }
        }
      }
      break;
    }
    case 'push_channel': {
      const lc = binding.channel_lifecycle_methods;
      if (!isObjectRecord(lc) || !isNonEmptyStr(lc.create) || !isNonEmptyStr(lc.delete)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.channel_lifecycle_methods`,
          `push_channel binding for '${opKey}' must declare channel_lifecycle_methods with create + delete operation ids`);
      } else if (lc.renew !== undefined && !isNonEmptyStr(lc.renew)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.channel_lifecycle_methods.renew`,
          `push_channel binding for '${opKey}' renew must be a non-empty operation id when present`);
      }
      break;
    }
  }
};

/** GraphQL *ignored-token* prefix: whitespace + line terminators + BOM (all in
 *  `\s`), COMMAS (`,` is insignificant in GraphQL), and `#` COMMENTS (body
 *  `[^\n\r]*`; its `\n`/`\r` terminator is consumed by the next `[\s,]`). The
 *  two alternatives are disjoint by first char (whitespace/comma vs `#`) and each
 *  consumes ≥1 char, so the `*` is linear — no catastrophic backtracking. */
const GRAPHQL_IGNORED_PREFIX_RE = /^(?:[\s,]|#[^\n\r]*)*/;
/** The operation keyword immediately following the ignored-token prefix. Lowercase
 *  by spec; `\b` so a field named `mutationLog` is not mistaken for the keyword. */
const GRAPHQL_LEADING_KEYWORD_RE = /^(query|mutation|subscription)\b/;

/** D-192 Gate E′ — classify a GraphQL document by the FIRST REAL token after its
 *  ignored-token prefix, so the risk gate reads what the server EXECUTES, not the
 *  sibling `operation_type` field (which a raw binding could set inconsistently).
 *  Returns:
 *    - the operation keyword (`query`/`mutation`/`subscription`);
 *    - `'query'` for an anonymous shorthand (`{ … }` — query-only by spec, a safe
 *      read);
 *    - `'unknown'` when the first real token is anything else — a leading
 *      description string (`"""…"""` / `"…"`, which the repo's `graphql` parser
 *      accepts before an operation), a leading fragment, or garbage.
 *  SECURITY (Codex CONFIRMED): the caller FAILS CLOSED on `'unknown'` (hard
 *  error) rather than assuming read — a permissive "default to query" let a
 *  mutation hide behind a leading description string / comma / CR-comment / exotic
 *  token and bypass the D-157 approval gate. This deliberately does NOT parse
 *  leading descriptions/fragments: a pack author writes the operation document, so
 *  requiring it to BEGIN with the operation keyword or `{` is an un-bypassable
 *  constraint that no real pack violates (verified against the shipped packs).
 *  Accepting exotic leading tokens would need the full `graphql` lexer the owner
 *  ruled out.
 *
 *  Classifies the FIRST operation only. Safe because the gateway dispatches
 *  without an `operationName` (`buildGraphqlDispatchInput`), so a multi-operation
 *  document (`query A {…} mutation B {…}`) cannot select a later mutation — the
 *  server rejects it ("must provide operation name…"). REVISIT this if
 *  `operationName` selection is ever added to the dispatch. */
const graphqlOperationKind = (
  query: string,
): 'query' | 'mutation' | 'subscription' | 'unknown' => {
  const prefix = GRAPHQL_IGNORED_PREFIX_RE.exec(query);
  const rest = query.slice(prefix ? prefix[0].length : 0);
  const kw = GRAPHQL_LEADING_KEYWORD_RE.exec(rest);
  if (kw) return kw[1] as 'query' | 'mutation' | 'subscription';
  if (rest.startsWith('{')) return 'query';
  return 'unknown';
};

/** The risk tiers a MUTATING operation must carry (never `read`). */
const API_WRITE_RISK_TIERS = new Set(['write', 'admin', 'destructive']);

/** D-192 Gate E′ — RISK-CONSISTENCY gate. A raw (author-authored) execution
 *  binding must not UNDER-declare its risk tier, so a mutating op can't
 *  masquerade as an auto-admitted `read` and bypass the D-157 approval gate. The
 *  transport's operation kind is the signal:
 *    - GraphQL (opaque query string → clean signal → HARD error): the op kind is
 *      the document's leading keyword. `operation_type` must match it; a
 *      `mutation` must be write/admin/destructive; a `query` (read-only by spec)
 *      must be `read`. The risk is gated on the ACTUAL keyword, not the
 *      possibly-inconsistent `operation_type` field. No SDL parse.
 *    - REST (transparent method+path → fuzzy signal → WARN): a write HTTP method
 *      (PUT/PATCH/DELETE) declared `read` is flagged but NOT blocked — a genuine
 *      dry-run/preview endpoint (e.g. Paddle `PATCH …/preview`) is read-tier by
 *      design, and POST is ambiguous (search vs create). The method+path are
 *      visible to a reviewer, so a warning suffices.
 *  Mirrors the DOM-side `dom_write_wrong_risk_tier` check. Skipped when `opRisk`
 *  is absent/invalid — the per-op risk_tier gate reports that separately (no
 *  double-report). */
const validateApiBindingRiskConsistency = (
  binding: Record<string, unknown>,
  opRisk: string,
  add: AddFn,
  bPath: string,
  opKey: string,
): void => {
  if (!isRiskTier(opRisk)) return;

  if (binding.kind === 'graphql') {
    // The shape gate already errors a missing / non-string / empty query; only
    // classify a real document here (no double-report).
    if (typeof binding.query !== 'string' || binding.query.length === 0) return;
    const actual = graphqlOperationKind(binding.query);
    if (actual === 'unknown') {
      add('error', 'CATALOG_BINDING_RISK_MISMATCH', `${bPath}.query`,
        `graphql binding for '${opKey}' — cannot determine the operation kind: the query document must begin (after whitespace / commas / comments) with 'query', 'mutation', 'subscription', or an anonymous '{' selection. A leading description string, fragment, or other token is not classifiable and could hide a mutation behind a read tier`);
      return;
    }
    const declared = binding.operation_type;
    if (
      typeof declared === 'string'
      && (declared === 'query' || declared === 'mutation' || declared === 'subscription')
      && declared !== actual
    ) {
      add('error', 'CATALOG_BINDING_RISK_MISMATCH', `${bPath}.operation_type`,
        `graphql binding for '${opKey}' declares operation_type '${declared}' but the query document is a '${actual}' — the document's leading keyword is what executes`);
    }
    if (actual === 'mutation' && !API_WRITE_RISK_TIERS.has(opRisk)) {
      add('error', 'CATALOG_BINDING_RISK_MISMATCH', `operations.${opKey}.risk_tier`,
        `operation '${opKey}' is a graphql mutation but risk_tier is '${opRisk}' — a mutation must be write/admin/destructive (a write op declared read would bypass the approval gate)`);
    } else if (actual === 'query' && opRisk !== 'read') {
      add('error', 'CATALOG_BINDING_RISK_MISMATCH', `operations.${opKey}.risk_tier`,
        `operation '${opKey}' is a graphql query (read-only) but risk_tier is '${opRisk}' — a query must be read`);
    }
    return;
  }

  if (binding.kind === 'rest') {
    const method = typeof binding.method === 'string' ? binding.method.toUpperCase() : '';
    if ((method === 'PUT' || method === 'PATCH' || method === 'DELETE') && opRisk === 'read') {
      add('warn', 'CATALOG_BINDING_RISK_MISMATCH', `operations.${opKey}.risk_tier`,
        `operation '${opKey}' uses the write HTTP method ${method} but risk_tier is 'read' — confirm this is a dry-run/preview endpoint (genuinely read-only), not a mis-tiered write that would bypass approval`);
    }
  }

  // ⚠ D-225 Slice 1 — `mcp` is DELIBERATELY absent, and the absence is the
  // finding, not an omission.
  //
  // This function's premise was that every api binding carries a signal
  // INDEPENDENT of the author's `risk_tier` to cross-check it against: a REST
  // method, a GraphQL document's leading keyword. An MCP binding carries none.
  // A tool NAME proves nothing (`run` could be either), and neither does the
  // `tools/list` entry a Slice-2 generated pack is minted from — MCP's
  // `annotations.readOnlyHint` is a value the SERVER self-reports, so trusting
  // it would let a third party tier its own write tool as a read and skip the
  // approval gate. A check built on it would be assurance-shaped and carry no
  // assurance, which is worse than none.
  //
  // ⇒ On this transport the author's declaration is the SOLE risk signal, and
  // that is a real difference in what publishing proves, not a gap to fill
  // later. The consequence belongs to whoever mints declarations without an
  // author: a generated pack must tier CONSERVATIVELY (never infer `read`),
  // because nothing downstream will catch it if it is wrong.
};

/** Validate the API surface + run the two surface-dependent invariants
 *  (real-time-binding cache discipline + scope-universe coverage). */
const validateApiSurface = (
  api: Record<string, unknown>,
  add: AddFn,
  operations: Record<string, unknown>,
  opKeys: Set<string>,
): void => {
  if (!isApiTransport(api.transport)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api.transport',
      `surfaces.api.transport must be one of ${API_TRANSPORTS.join('|')}`);
  }
  const baseUrl = api.default_base_url;
  const baseUrlSet = isNonEmptyStr(baseUrl);
  // D-225 Slice 1 — an MCP surface has NO base URL. Its server address is the
  // connection record's (`config.endpoint`, or the stdio launch spec), which is
  // the same per-connection resolution a REST surface gets — there is simply no
  // surface-level default to fall back to, because a path is never joined onto
  // anything. Requiring a URL here would make every mcp author (and every
  // Slice-2 generated pack) fabricate one that configures nothing, and a
  // fabricated field is one a corpus learns to copy. So it is required to be
  // EMPTY, not merely permitted to be: a present value would read as
  // configuring the endpoint when nothing consults it.
  if (api.transport === 'mcp') {
    if (baseUrlSet) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api.default_base_url',
        `surfaces.api.default_base_url must be '' on an mcp surface — the server address comes from the `
          + `connection record, and a value here configures nothing (got ${JSON.stringify(baseUrl)})`);
    }
  } else if (!baseUrlSet) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api.default_base_url',
      'surfaces.api.default_base_url must be a non-empty URL string');
  } else if (!isHttpsOrLocalBaseUrl(baseUrl)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api.default_base_url',
      'surfaces.api.default_base_url must be https:// (localhost / 127.0.0.1 / [::1] dev exception)');
  }
  // openapi_source / graphql_schema_source — shape + pin format. `url` must be
  // https (localhost dev exception); `sha256` must be a 64-char lowercase hex
  // digest. The structural cross-check of declared REST ops against the FETCHED
  // OpenAPI document is `crossCheckCatalogOpenApi` (pure; the marketplace
  // publish pipeline fetches + hash-verifies the document, then feeds it in).
  // The network fetch + SHA-256 compute stay OUT of the portable validator (no
  // IO substrate); GraphQL document-validation stays deferred (needs a parser).
  // `google_discovery_source` joins the loop (D-192 P2, Codex fold F2):
  // the pin must be shape-gated HERE so the marketplace worker's guarded
  // fetch never dereferences an unvalidated publisher-supplied string —
  // the same validate-before-fetch contract the OpenAPI pin carries.
  for (const srcKey of ['openapi_source', 'graphql_schema_source', 'google_discovery_source'] as const) {
    const src = api[srcKey];
    if (src === undefined) continue;
    if (!isObjectRecord(src) || !isNonEmptyStr(src.url) || !isNonEmptyStr(src.sha256)) {
      add('error', 'CATALOG_SURFACE_INVALID', `surfaces.api.${srcKey}`,
        `surfaces.api.${srcKey} must be { url: string; sha256: string }`);
      continue;
    }
    if (!isHttpsOrLocalBaseUrl(src.url)) {
      add('error', 'CATALOG_SURFACE_INVALID', `surfaces.api.${srcKey}.url`,
        `surfaces.api.${srcKey}.url must be https:// (localhost / 127.0.0.1 / [::1] dev exception)`);
    }
    if (!CATALOG_SCHEMA_SOURCE_SHA256_REGEX.test(src.sha256)) {
      add('error', 'CATALOG_SURFACE_INVALID', `surfaces.api.${srcKey}.sha256`,
        `surfaces.api.${srcKey}.sha256 must be a 64-char lowercase hex SHA-256 digest`);
    }
    // D-192 CORE #8a — shape-gate the optional `path_alias` (honored by the
    // OpenAPI op-prover only; harmless on graphql/discovery pins).
    if (src.path_alias !== undefined) {
      if (!isObjectRecord(src.path_alias)) {
        add('error', 'CATALOG_SURFACE_INVALID', `surfaces.api.${srcKey}.path_alias`,
          `surfaces.api.${srcKey}.path_alias must be an object { wire_prefix?, doc_base?, strip_suffix? }`);
      } else {
        for (const k of ['wire_prefix', 'doc_base', 'strip_suffix'] as const) {
          const v = src.path_alias[k];
          if (v !== undefined && !isNonEmptyStr(v)) {
            add('error', 'CATALOG_SURFACE_INVALID', `surfaces.api.${srcKey}.path_alias.${k}`,
              `surfaces.api.${srcKey}.path_alias.${k} must be a non-empty string when present`);
          }
        }
        // `strip_suffix` must be a DOTTED format extension (`.json`), never a
        // bare substring like `s` that would mis-strip `/users` → `/user`.
        const suffix = src.path_alias.strip_suffix;
        if (isNonEmptyStr(suffix) && !/^\.[^./]+$/.test(suffix)) {
          add('error', 'CATALOG_SURFACE_INVALID', `surfaces.api.${srcKey}.path_alias.strip_suffix`,
            `surfaces.api.${srcKey}.path_alias.strip_suffix must be a dotted format extension like '.json' (not a bare substring)`);
        }
      }
    }
  }

  // Connection-agnostic op dispatch — surface-level closed-set DIALECT fields. Each
  // is OPTIONAL, but a value outside its closed set is a typo that would SILENTLY
  // disable the feature at runtime (the resolver's search/write derivation + the
  // gateway's pagination follower just skip an unrecognized dialect, failing closed),
  // so reject it at publish instead. (`result_path` is an open envelope string, not a
  // closed set — not gated here.)
  if (api.search_style !== undefined && !isSearchStyle(api.search_style)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api.search_style',
      `surfaces.api.search_style must be one of ${SEARCH_STYLES.join('|')} when present`);
  }
  if (api.write_style !== undefined && !isWriteStyle(api.write_style)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api.write_style',
      `surfaces.api.write_style must be one of ${WRITE_STYLES.join('|')} when present`);
  }
  if (api.pagination_style !== undefined && !isPaginationStyle(api.pagination_style)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api.pagination_style',
      `surfaces.api.pagination_style must be one of ${PAGINATION_STYLES.join('|')} when present`);
  }

  const scopeUniverse = validateAuthSpec(api.auth, add);

  // executes — each binding's shape + kind; bindings must reference declared
  // operations (a binding for an UNDECLARED op is dangling). The inverse —
  // every operation needs a dispatchable binding now the P1 `delegates_to`
  // wrapper fallback is gone — is enforced at RUNTIME (gateway fails closed
  // `no_api_binding`) AND at publish-time by the op-binding coverage check in
  // `validateProviderSurfaces` (cross-surface, needs both surfaces visible).
  const bindingKindByOp: Record<string, string> = {};
  const executes = api.executes;
  if (!isObjectRecord(executes)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api.executes',
      'surfaces.api.executes must be an object keyed by operation id');
  } else {
    for (const [opKey, rawBinding] of Object.entries(executes)) {
      const bPath = `surfaces.api.executes.${opKey}`;
      if (!opKeys.has(opKey)) {
        add('error', 'CATALOG_SURFACE_INVALID', bPath,
          `execution binding references undeclared operation '${opKey}'`);
      }
      if (!isObjectRecord(rawBinding)) {
        add('error', 'CATALOG_BINDING_INVALID', bPath, `binding for '${opKey}' must be an object`);
        continue;
      }
      if (!isApiExecutionBindingKind(rawBinding.kind)) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.kind`,
          `binding for '${opKey}' kind must be one of ${API_EXECUTION_BINDING_KINDS.join('|')}`);
        continue;
      }
      bindingKindByOp[opKey] = rawBinding.kind;
      validateApiBindingShape(rawBinding, rawBinding.kind, baseUrlSet, add, bPath, opKey, operations[opKey]);
      // D-192 Gate E′ — risk-consistency: a raw binding must not under-declare
      // its tier so a graphql mutation / REST write method can't masquerade as
      // an auto-admitted read and bypass the approval gate.
      const opSpec = operations[opKey];
      const opRisk = isObjectRecord(opSpec) && typeof opSpec.risk_tier === 'string'
        ? opSpec.risk_tier
        : '';
      validateApiBindingRiskConsistency(rawBinding, opRisk, add, bPath, opKey);
    }
  }

  // GATE — real-time-binding cache discipline (spec § Cache-TTL gates): a
  // webhook / queue / push binding forces its operation's cache_ttl_ms to 0,
  // regardless of risk tier. This catches the read-tier subscription case the
  // per-op Invariant-7 gate (which lets read-tier ops cache) would let through.
  for (const [opKey, kind] of Object.entries(bindingKindByOp)) {
    if (!isRealtimeApiBindingKind(kind)) continue;
    const op = operations[opKey];
    if (!isObjectRecord(op)) continue;
    if (typeof op.cache_ttl_ms === 'number' && op.cache_ttl_ms > 0) {
      add('error', 'CATALOG_CACHE_POLICY_INVALID', `operations.${opKey}.cache_ttl_ms`,
        `operation '${opKey}' is bound to a real-time ${kind} surface; cache_ttl_ms must be 0 or omitted regardless of risk tier (spec § Cache-TTL gates)`);
    }
  }

  // GATE — scope-universe coverage (spec § API-surface gates): every
  // operation's required_scopes must be covered by the auth's declared scope
  // universe. Only enforced when a CONSTRAINED universe exists (see
  // validateAuthSpec — oauth2 always; api_key only when every slot declares
  // available_scopes); skipped for none / signed / unconstrained auth.
  if (scopeUniverse) {
    for (const [opKey, rawOp] of Object.entries(operations)) {
      if (!isObjectRecord(rawOp) || !isStrArray(rawOp.required_scopes)) continue;
      for (const scope of rawOp.required_scopes) {
        if (!scopeUniverse.has(scope)) {
          add('error', 'CATALOG_AUTH_INVALID', `operations.${opKey}.required_scopes`,
            `operation '${opKey}' requires scope '${scope}' not present in the surface auth's declared scope universe (spec § API-surface gates)`);
        }
      }
    }
  }
};

/** Validate the connector surface: runtime + lifecycle shape, the wire /
 *  binding-kind match, and the `cli_invocation` lifecycle invariant. The
 *  `describe()` / `tools/list` runtime introspection match is deferred. */
const validateConnectorSurface = (
  connector: Record<string, unknown>,
  add: AddFn,
  opKeys: Set<string>,
  operations: Record<string, unknown>,
): void => {
  let wireProtocol: string | undefined;
  const runtime = connector.runtime;
  if (!isObjectRecord(runtime)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.runtime',
      'connector surface must declare a runtime object');
  } else {
    if (typeof runtime.transport !== 'string' || !CONNECTOR_TRANSPORT_SET.has(runtime.transport)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.runtime.transport',
        'connector runtime.transport must be one of stdio|unix_socket|http_local|websocket_local');
    }
    if (!isConnectorWireProtocol(runtime.wire_protocol)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.runtime.wire_protocol',
        'connector runtime.wire_protocol must be one of mcp|custom_jsonrpc|custom_proprietary|cli_invocation');
    } else {
      wireProtocol = runtime.wire_protocol;
    }
    if (!isNonEmptyStr(runtime.package_ref)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.runtime.package_ref',
        'connector runtime.package_ref must be a non-empty registry ref (npm:/pip:/cargo:/go:/system_binary:)');
    } else if (!/^[a-z_]+:/.test(runtime.package_ref)) {
      add('warn', 'CATALOG_CONNECTOR_PACKAGE_REF_UNVERIFIABLE', 'surfaces.connector.runtime.package_ref',
        `connector package_ref '${runtime.package_ref}' has no recognizable registry scheme — the validator cannot verify it is fetchable`);
    }
    if (!isNonEmptyStr(runtime.entry_point)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.runtime.entry_point',
        'connector runtime.entry_point must be a non-empty string');
    }
    if (typeof runtime.expected_protocol_version !== 'number'
      || !Number.isInteger(runtime.expected_protocol_version) || runtime.expected_protocol_version < 0) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.runtime.expected_protocol_version',
        'connector runtime.expected_protocol_version must be a non-negative integer');
    }
  }

  const lifecycle = connector.lifecycle;
  const isCli = wireProtocol === 'cli_invocation';
  if (!isObjectRecord(lifecycle)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle',
      'connector surface must declare a lifecycle object');
  } else {
    const lcAuth = lifecycle.auth;
    if (!isObjectRecord(lcAuth) || typeof lcAuth.method !== 'string'
      || !CONNECTOR_AUTH_METHOD_SET.has(lcAuth.method)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle.auth.method',
        'connector lifecycle.auth.method must be one of qr_scan|oauth_handoff|api_key_entry|device_pairing|token_paste|none');
    }
    if (isObjectRecord(lcAuth) && lcAuth.wait_timeout_ms !== undefined
      && !isIntInRange(lcAuth.wait_timeout_ms, 1, CATALOG_CONNECTOR_AUTH_WAIT_TIMEOUT_CAP_MS)) {
      add('error', 'CATALOG_TIMEOUT_INVALID', 'surfaces.connector.lifecycle.auth.wait_timeout_ms',
        `connector lifecycle.auth.wait_timeout_ms must be a positive integer ≤ ${CATALOG_CONNECTOR_AUTH_WAIT_TIMEOUT_CAP_MS} (30min)`);
    }
    const connect = lifecycle.connect;
    if (!isObjectRecord(connect) || typeof connect.idempotent !== 'boolean') {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle.connect',
        'connector lifecycle.connect must declare a boolean idempotent + startup_timeout_ms');
    }
    if (isObjectRecord(connect)
      && !isIntInRange(connect.startup_timeout_ms, 1, CATALOG_CONNECTOR_STARTUP_TIMEOUT_CAP_MS)) {
      add('error', 'CATALOG_TIMEOUT_INVALID', 'surfaces.connector.lifecycle.connect.startup_timeout_ms',
        `connector lifecycle.connect.startup_timeout_ms must be a positive integer ≤ ${CATALOG_CONNECTOR_STARTUP_TIMEOUT_CAP_MS}`);
    }
    const disconnect = lifecycle.disconnect;
    if (!isObjectRecord(disconnect)
      || !isIntInRange(disconnect.graceful_shutdown_timeout_ms, 1, CATALOG_CONNECTOR_SHUTDOWN_TIMEOUT_CAP_MS)) {
      add('error', 'CATALOG_TIMEOUT_INVALID', 'surfaces.connector.lifecycle.disconnect.graceful_shutdown_timeout_ms',
        `connector lifecycle.disconnect.graceful_shutdown_timeout_ms must be a positive integer ≤ ${CATALOG_CONNECTOR_SHUTDOWN_TIMEOUT_CAP_MS}`);
    }
    const invoke = lifecycle.invoke;
    if (invoke !== undefined) {
      if (!isObjectRecord(invoke)) {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle.invoke',
          'connector lifecycle.invoke must be an object when present');
      } else if (invoke.default_method_timeout_ms !== undefined
        && !isIntInRange(invoke.default_method_timeout_ms, 1, CATALOG_CONNECTOR_INVOKE_TIMEOUT_CAP_MS)) {
        add('error', 'CATALOG_TIMEOUT_INVALID', 'surfaces.connector.lifecycle.invoke.default_method_timeout_ms',
          `connector lifecycle.invoke.default_method_timeout_ms must be a positive integer ≤ ${CATALOG_CONNECTOR_INVOKE_TIMEOUT_CAP_MS}`);
      }
    }
    if (typeof lifecycle.reconnect_policy !== 'string'
      || !RECONNECT_POLICY_SET.has(lifecycle.reconnect_policy)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle.reconnect_policy',
        'connector lifecycle.reconnect_policy must be one of auto|manual_only');
    }
    const persistent = lifecycle.persistent_connection;
    if (typeof persistent !== 'boolean') {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle.persistent_connection',
        'connector lifecycle.persistent_connection must be a boolean');
    }
    const idle = lifecycle.idle_disconnect_ms;
    if (isCli) {
      // cli_invocation: each call is a fresh subprocess — persistent must be
      // false + idle must be 0 (spec § Connector surface CliMethodBinding).
      if (persistent === true) {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle.persistent_connection',
          'cli_invocation connector must set persistent_connection: false (each call is a fresh subprocess)');
      }
      if (idle !== 0) {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle.idle_disconnect_ms',
          'cli_invocation connector must set idle_disconnect_ms: 0 (no persistent process to idle out)');
      }
    } else if (persistent === false) {
      // non-persistent non-CLI: idle_disconnect_ms required + ≥ the floor.
      if (idle === undefined) {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.lifecycle.idle_disconnect_ms',
          'connector idle_disconnect_ms is required when persistent_connection is false');
      } else if (!isIntAtLeast(idle, CATALOG_CONNECTOR_IDLE_DISCONNECT_MIN_MS)) {
        add('error', 'CATALOG_TIMEOUT_INVALID', 'surfaces.connector.lifecycle.idle_disconnect_ms',
          `connector idle_disconnect_ms must be an integer ≥ ${CATALOG_CONNECTOR_IDLE_DISCONNECT_MIN_MS} when set`);
      }
    } else if (idle !== undefined && !isIntAtLeast(idle, CATALOG_CONNECTOR_IDLE_DISCONNECT_MIN_MS)) {
      // persistent: idle optional, but ≥ the floor when set.
      add('error', 'CATALOG_TIMEOUT_INVALID', 'surfaces.connector.lifecycle.idle_disconnect_ms',
        `connector idle_disconnect_ms must be an integer ≥ ${CATALOG_CONNECTOR_IDLE_DISCONNECT_MIN_MS} when set`);
    }
  }

  // executes — binding kind must match wire_protocol; per-kind shape.
  const executes = connector.executes;
  if (!isObjectRecord(executes)) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.executes',
      'surfaces.connector.executes must be an object keyed by operation id');
  } else {
    const expectedBindingKind = isCli ? 'cli_invocation' : 'method_call';
    for (const [opKey, rawBinding] of Object.entries(executes)) {
      const bPath = `surfaces.connector.executes.${opKey}`;
      if (!opKeys.has(opKey)) {
        add('error', 'CATALOG_SURFACE_INVALID', bPath,
          `connector execution binding references undeclared operation '${opKey}'`);
      }
      if (!isObjectRecord(rawBinding)) {
        add('error', 'CATALOG_BINDING_INVALID', bPath, `connector binding for '${opKey}' must be an object`);
        continue;
      }
      // Wire/binding match (spec § Connector surface — validator enforces all
      // bindings match the surface's wire_protocol). Only when wire resolved.
      if (wireProtocol !== undefined && rawBinding.kind !== expectedBindingKind) {
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.kind`,
          `connector binding for '${opKey}' kind must be '${expectedBindingKind}' to match wire_protocol '${wireProtocol}'`);
        continue;
      }
      if (rawBinding.kind === 'method_call') {
        if (!isNonEmptyStr(rawBinding.method_name)) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.method_name`,
            `method_call binding for '${opKey}' must declare a non-empty method_name`);
        }
      } else if (rawBinding.kind === 'cli_invocation') {
        if (!isCliArgvTemplate(rawBinding.argv_template)) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.argv_template`,
            `cli_invocation binding for '${opKey}' must declare a non-empty argv_template array of string tokens or { expand_arg } entries`);
        } else {
          // cli `argv_template` SAFETY — the runtime/catalog mirror of the
          // authoring `validateCliArgvTemplate` guard, so a directly-published or
          // hand-crafted catalog ingredient (which bypasses the authoring table
          // and is gated by THIS validator alone) can't ship a call-time
          // command/code hole. The D-182 §7.2 reachability gate authorizes a cli
          // op by (ingredient × operation), NOT by tool — `argv[0]` is the only
          // thing that decides which binary runs, so it must be a literal pinned
          // to the declared launched binary (`runtime.entry_point`, required
          // above), and no interpreter eval/code hole may turn a call-time arg
          // into code.
          const declaredTool = cliToolFromConnectorRuntime(runtime as ConnectorRuntimeSpec | undefined);
          const cmd = cliCommandViolation(rawBinding.argv_template, declaredTool);
          if (cmd?.kind === 'command_templated') {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.argv_template`,
              `cli_invocation binding for '${opKey}' argv_template[0] (the command) must be a non-templated literal — a templated command lets a call-time arg choose which binary runs; lock the binary and pass typed data args`);
          } else if (cmd?.kind === 'command_tool_mismatch') {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.argv_template`,
              `cli_invocation binding for '${opKey}' argv_template[0] '${rawBinding.argv_template[0]}' must equal the declared launched binary '${cmd.tool}' (runtime.entry_point) — the grant authorizes that binary, not an arbitrary command`);
          }
          for (const v of cliInterpreterViolations(rawBinding.argv_template)) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.argv_template[${v.index}]`,
              v.kind === 'code_eval'
                ? `cli_invocation binding for '${opKey}' argv_template must not invoke ${v.interpreter} with code/eval flag '${v.flag}' — a call-time hole would become code; lock a script/binary and pass typed data args`
                : `cli_invocation binding for '${opKey}' argv_template must not let ${v.interpreter} choose its script path from a call-time hole — lock the script path token and pass typed data args`);
          }
        }
        validateCliCwdSpec(rawBinding, operations[opKey], opKey, `${bPath}.cwd`, add);
        // D-185 Slice 3 — `shape` (optional) replaces `stdout_handling`. When
        // present it must be a valid output shape; omitted ⇒ exit-code-only.
        const shapeOk = rawBinding.shape === undefined
          || (typeof rawBinding.shape === 'string' && CLI_OUTPUT_SHAPE_SET.has(rawBinding.shape));
        if (!shapeOk) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.shape`,
            `cli_invocation binding for '${opKey}' shape must be one of ref|text|json|jsonl`);
        }
        // D-185 Slice 3 — content-isolation invariants on the INSTALLED catalog
        // (a defense-in-depth mirror of the authoring `validateCliOutputCapture` /
        // `validateCliOutputShape` gates, so a hand-crafted pack can't combine a
        // file output with a stdout-capturing value shape):
        //   - output_capture ⟺ shape:'ref' (a value shape would ALSO capture
        //     stdout, leaking the file content into op-step values);
        //   - input_materialize must NOT declare a value shape (the materialized
        //     bytes could echo via stdout, bypassing the gated file_ref read).
        if (shapeOk) {
          const isRef = rawBinding.shape === 'ref';
          const isValueShape = rawBinding.shape === 'text' || rawBinding.shape === 'json' || rawBinding.shape === 'jsonl';
          if (rawBinding.output_capture !== undefined && !isRef) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.shape`,
              `cli_invocation binding for '${opKey}' declares output_capture and so must set shape: 'ref' (a value shape would capture stdout and leak the file content)`);
          }
          if (isRef && rawBinding.output_capture === undefined) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.output_capture`,
              `cli_invocation binding for '${opKey}' declares shape: 'ref' and so must declare an output_capture (file backing)`);
          }
          if (rawBinding.input_materialize !== undefined && isValueShape) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.shape`,
              `cli_invocation binding for '${opKey}' declares input_materialize and so must not use a value shape (the materialized bytes could echo via stdout)`);
          }
        }
        // IN-PLACE capture — installed-catalog mirror of the authoring
        // `validateCliOutputCapture` `from_input_arg` arm. The runtime's posture
        // for an in-place editor rests entirely on the captured path being
        // ENGINE-chosen, which holds only when the SAME arg is materialized from
        // a `data.file` ref. A hand-crafted pack that declares `from_input_arg`
        // without a matching scalar `input_materialize` would have the tool write
        // to, and this op ingest from, a location the recipe named — so refuse it
        // at install just as the authoring gate refuses it at publish.
        const rawCapture = rawBinding.output_capture;
        if (isObjectRecord(rawCapture) && rawCapture.from_input_arg !== undefined) {
          const fromInputArg = rawCapture.from_input_arg;
          if (rawCapture.dir_arg !== undefined) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.output_capture`,
              `cli_invocation binding for '${opKey}' output_capture declares both from_input_arg and dir_arg — declare exactly one`);
          } else if (typeof fromInputArg !== 'string' || fromInputArg.length === 0) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.output_capture.from_input_arg`,
              `cli_invocation binding for '${opKey}' output_capture.from_input_arg must be a non-empty string`);
          } else if (!isObjectRecord(rawBinding.input_materialize)) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.output_capture.from_input_arg`,
              `cli_invocation binding for '${opKey}' output_capture.from_input_arg requires an input_materialize on the same op — the captured path must be engine-chosen`);
          } else {
            const m = rawBinding.input_materialize;
            if (m.kind !== 'file_ref') {
              add('error', 'CATALOG_BINDING_INVALID', `${bPath}.output_capture.from_input_arg`,
                `cli_invocation binding for '${opKey}' output_capture.from_input_arg requires input_materialize.kind 'file_ref' — an array materialize has no single file to capture`);
            }
            if (m.arg !== fromInputArg) {
              add('error', 'CATALOG_BINDING_INVALID', `${bPath}.output_capture.from_input_arg`,
                `cli_invocation binding for '${opKey}' output_capture.from_input_arg '${fromInputArg}' must equal input_materialize.arg '${String(m.arg)}'`);
            }
          }
        }
        // D-172 I-4 — input_materialize is foreground-only: a detached job redirects
        // stdout+stderr to a log file, re-opening the content-echo channel the
        // runtime stderr-suppression closes for materialize ops. Mirrors the
        // authoring `validateCliInputMaterialize` detached gate + the output_capture
        // foreground-only rule.
        if (rawBinding.input_materialize !== undefined && rawBinding.detached !== undefined) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.detached`,
            `cli_invocation binding for '${opKey}' declares input_materialize and so must not be detached (a detached job's log file would re-open the file-content echo channel; materialize is foreground-only)`);
        }
        const expandedArgs = cliArgvExpandedArgs(rawBinding.argv_template);
        const materialize = rawBinding.input_materialize;
        if (expandedArgs.length > 0 && materialize === undefined) {
          for (const expandedArg of expandedArgs) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.argv_template`,
              `cli_invocation binding for '${opKey}' expand_arg '${expandedArg}' requires input_materialize.kind 'file_ref_array'`);
          }
        }
        if (materialize !== undefined) {
          if (!isObjectRecord(materialize)) {
            add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize`,
              `cli_invocation binding for '${opKey}' input_materialize must be an object`);
          } else {
            if (materialize.kind !== 'file_ref' && materialize.kind !== 'file_ref_array') {
              add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize.kind`,
                `cli_invocation binding for '${opKey}' input_materialize.kind must be 'file_ref' or 'file_ref_array'`);
            }
            const materializeArg = materialize.arg;
            if (!isNonEmptyStr(materializeArg)) {
              add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize.arg`,
                `cli_invocation binding for '${opKey}' input_materialize.arg must be a non-empty string`);
            } else {
              if (!editableArgKeys(operations[opKey]).has(materializeArg)) {
                add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize.arg`,
                  `cli_invocation binding for '${opKey}' input_materialize.arg must be declared in editable_args`);
              }
              if (materialize.kind === 'file_ref_array') {
                if (!cliArgvHasExpandArg(rawBinding.argv_template, materializeArg)) {
                  add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize.arg`,
                    `cli_invocation binding for '${opKey}' input_materialize.arg '${materializeArg}' must appear as an argv_template { expand_arg } entry`);
                }
                const min = materialize.min_items;
                const max = materialize.max_items;
                if (min !== undefined && (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > CLI_FILE_REF_ARRAY_MAX_ITEMS)) {
                  add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize.min_items`,
                    `cli_invocation binding for '${opKey}' input_materialize.min_items must be an integer from 1 to ${CLI_FILE_REF_ARRAY_MAX_ITEMS}`);
                }
                if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > CLI_FILE_REF_ARRAY_MAX_ITEMS)) {
                  add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize.max_items`,
                    `cli_invocation binding for '${opKey}' input_materialize.max_items must be an integer from 1 to ${CLI_FILE_REF_ARRAY_MAX_ITEMS}`);
                }
                if (typeof min === 'number' && typeof max === 'number' && Number.isInteger(min) && Number.isInteger(max) && max < min) {
                  add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize.max_items`,
                    `cli_invocation binding for '${opKey}' input_materialize.max_items must be greater than or equal to min_items`);
                }
              } else if (!cliArgvHasScalarRef(rawBinding.argv_template, materializeArg)) {
                add('error', 'CATALOG_BINDING_INVALID', `${bPath}.input_materialize.arg`,
                  `cli_invocation binding for '${opKey}' input_materialize.arg '${materializeArg}' must appear as a {${materializeArg}} token in argv_template`);
              }
              for (const expandedArg of expandedArgs) {
                if (materialize.kind !== 'file_ref_array' || expandedArg !== materializeArg) {
                  add('error', 'CATALOG_BINDING_INVALID', `${bPath}.argv_template`,
                    `cli_invocation binding for '${opKey}' expand_arg '${expandedArg}' requires matching input_materialize.kind 'file_ref_array'`);
                }
              }
            }
          }
        }
        if (rawBinding.stdin_handling !== undefined
          && (typeof rawBinding.stdin_handling !== 'string' || !CLI_STDIN_SET.has(rawBinding.stdin_handling))) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.stdin_handling`,
            `cli_invocation binding for '${opKey}' stdin_handling must be one of none|pipe_args|pipe_body`);
        }
        const exit = rawBinding.exit_code_handling;
        const exitOk = exit === 'zero_is_success'
          || (isObjectRecord(exit) && Array.isArray(exit.success_codes)
            && exit.success_codes.every((c) => typeof c === 'number' && Number.isInteger(c)));
        if (!exitOk) {
          add('error', 'CATALOG_BINDING_INVALID', `${bPath}.exit_code_handling`,
            `cli_invocation binding for '${opKey}' exit_code_handling must be 'zero_is_success' or { success_codes: number[] }`);
        }
        if (rawBinding.detached !== undefined) {
          validateCliDetachedSpec(rawBinding.detached, `${bPath}.detached`, add);
          validateCliDetachedConventions(
            rawBinding.detached, operations[opKey], `${bPath}.detached`, add,
          );
        }
        if (rawBinding.progress !== undefined) {
          validateCliProgressSpec(rawBinding, opKey, `${bPath}.progress`, add);
        }
      } else if (wireProtocol === undefined) {
        // wire unresolved — still gate the binding kind so it isn't silently ok.
        add('error', 'CATALOG_BINDING_INVALID', `${bPath}.kind`,
          `connector binding for '${opKey}' kind must be one of method_call|cli_invocation`);
      }
    }
  }

  const events = connector.events;
  if (events !== undefined) {
    if (!isObjectRecord(events)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector.events',
        'surfaces.connector.events must be an object keyed by event id when present');
    } else {
      for (const [evKey, rawEv] of Object.entries(events)) {
        const evPath = `surfaces.connector.events.${evKey}`;
        if (!isObjectRecord(rawEv)) {
          add('error', 'CATALOG_SURFACE_INVALID', evPath, `connector event '${evKey}' must be an object`);
          continue;
        }
        if (!isNonEmptyStr(rawEv.event_id)) {
          add('error', 'CATALOG_SURFACE_INVALID', `${evPath}.event_id`,
            `connector event '${evKey}' must declare a non-empty event_id`);
        }
        if (!isNonEmptyStr(rawEv.description)) {
          add('error', 'CATALOG_SURFACE_INVALID', `${evPath}.description`,
            `connector event '${evKey}' must declare a non-empty description`);
        }
        if (!('payload_schema' in rawEv)) {
          add('error', 'CATALOG_SURFACE_INVALID', `${evPath}.payload_schema`,
            `connector event '${evKey}' must declare a payload_schema`);
        }
      }
    }
  }
};

/** D-165 P2 — validate a catalog's `surfaces` block (the execution layer).
 *  Gates the SHAPE of each declared surface (api / connector / notification)
 *  plus the surface-dependent invariants. Additive: a surfaceless P0/P1
 *  catalog never reaches here (the caller guards on `surfaces` presence). */
const validateProviderSurfaces = (
  surfaces: Record<string, unknown>,
  add: AddFn,
  operations: Record<string, unknown>,
  opKeys: Set<string>,
): void => {
  const { api, connector, notification, records } = surfaces;
  for (const key of Object.keys(surfaces)) {
    if (!['api', 'connector', 'notification', 'records'].includes(key)) {
      add('error', 'CATALOG_SURFACE_INVALID', `surfaces.${key}`, `unknown provider surface '${key}'`);
    }
  }
  if (api === undefined && connector === undefined && notification === undefined && records === undefined) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces',
      'surfaces must declare at least one of api | connector | notification | records');
    return;
  }
  if (api !== undefined) {
    if (!isObjectRecord(api)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.api', 'surfaces.api must be an object');
    } else {
      validateApiSurface(api, add, operations, opKeys);
    }
  }
  if (connector !== undefined) {
    if (!isObjectRecord(connector)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.connector', 'surfaces.connector must be an object');
    } else {
      validateConnectorSurface(connector, add, opKeys, operations);
    }
  }
  if (notification !== undefined) {
    if (!isObjectRecord(notification)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.notification',
        'surfaces.notification must be an object');
    } else {
      if (!isNonEmptyStr(notification.channel_kind)) {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.notification.channel_kind',
          'notification surface must declare a non-empty channel_kind');
      }
      if (notification.default_target !== undefined && typeof notification.default_target !== 'string') {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.notification.default_target',
          'notification surface default_target must be a string');
      }
      if (notification.supports_rich_content !== undefined
        && typeof notification.supports_rich_content !== 'boolean') {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.notification.supports_rich_content',
          'notification surface supports_rich_content must be a boolean');
      }
    }
  }
  if (records !== undefined) {
    if (!isObjectRecord(records)) {
      add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.records', 'surfaces.records must be an object');
    } else {
      for (const key of Object.keys(records)) {
        if (key !== 'executes' && key !== 'schema') {
          add('error', 'CATALOG_SURFACE_INVALID', `surfaces.records.${key}`, `unknown Records surface key '${key}'`);
        }
      }
      if (!isObjectRecord(records.executes)) {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.records.executes', 'Records executes must be an object');
      } else {
        for (const opKey of opKeys) {
          const raw = records.executes[opKey];
          if (!isObjectRecord(raw) || raw.kind !== 'core.records' || !isRecordsAction(raw.action)) {
            add('error', 'CATALOG_BINDING_INVALID', `surfaces.records.executes.${opKey}`, `Records operation '${opKey}' needs a closed core.records binding`);
          }
        }
        for (const opKey of Object.keys(records.executes)) {
          if (!opKeys.has(opKey)) {
            add('error', 'CATALOG_BINDING_INVALID', `surfaces.records.executes.${opKey}`, `Records binding '${opKey}' has no declared operation`);
          }
        }
      }
      if (!isObjectRecord(records.schema) || records.schema.decimal_scale !== 4 || !isObjectRecord(records.schema.entities)) {
        add('error', 'CATALOG_SURFACE_INVALID', 'surfaces.records.schema', 'Records surface needs the fixed-scale entity schema snapshot');
      } else {
        for (const [entityKey, entity] of Object.entries(records.schema.entities)) {
          if (!isObjectRecord(entity) || entity.kind !== entityKey || !Array.isArray(entity.fields)) {
            add('error', 'CATALOG_SURFACE_INVALID', `surfaces.records.schema.entities.${entityKey}`, 'malformed Records entity snapshot');
            continue;
          }
          for (const [idx, rawField] of entity.fields.entries()) {
            if (!isObjectRecord(rawField)
              || typeof rawField.key !== 'string'
              || typeof rawField.slot !== 'string'
              || (rawField.slot !== 'pk' && recordsSlotKind(rawField.slot) === undefined)) {
              add('error', 'CATALOG_SURFACE_INVALID', `surfaces.records.schema.entities.${entityKey}.fields[${idx}]`, 'malformed Records field snapshot');
            }
          }
        }
      }
    }
  }

  // D-165 RUNTIME — when an `api` surface is present, every declared operation
  // must have SOME execution binding (in api.executes or connector.executes).
  // The publish-time mirror of the gateway's fail-closed `no_api_binding` guard
  // now that the P1 `delegates_to` wrapper fallback is gone — without it a
  // catalog publishes with an operation wired to nothing. Connector-only /
  // notification-only catalogs are exempt (no api surface).
  //
  // It counts ANY binding kind as "wired", NOT only the synchronously-
  // dispatchable rest/graphql kinds (Codex review MEDIUM proposed the latter):
  // a webhook / queue / push binding is a LEGITIMATE subscription operation
  // (the realtime cache-discipline gate above already treats such ops as
  // valid), so requiring rest/graphql would false-positive on every
  // subscription op. An agent that synchronously CALLS a subscription op is a
  // separate misuse the gateway fail-closes (`unsupported_binding_kind`) — not
  // a missing-binding gap. The real gap this catches is an op with NO binding.
  if (isObjectRecord(api)) {
    const boundOps = new Set<string>();
    for (const surface of [api, connector]) {
      if (!isObjectRecord(surface) || !isObjectRecord(surface.executes)) continue;
      for (const opKey of Object.keys(surface.executes)) boundOps.add(opKey);
    }
    for (const opKey of opKeys) {
      if (!boundOps.has(opKey)) {
        add('error', 'CATALOG_SURFACE_INVALID', `operations.${opKey}`,
          `operation '${opKey}' has no execution binding in surfaces.api.executes `
            + `(every operation in an api catalog must be wired to a binding)`);
      }
    }
  }
};

/** D-165 P2 — strict catalog-form validator. Runs IN PLACE of the
 *  connection-wrapper endpoint checks for a `kind: 'connection'` manifest
 *  that declares an `operations` map (a catalog, not a single endpoint),
 *  and gates the marketplace publish path — a declared catalog surface is
 *  the trust schema community reviewers validate mechanically (spec § "Why
 *  declarations, not runtime discovery").
 *
 *  Supersedes the P0/P1 minimal shape-check: every catalog-form field is
 *  gated when present — risk-gated cache TTL (Invariant 7), bounded
 *  timeouts (Invariant 6), closed-list enums (idempotency, media,
 *  catalog_kind, group grant/upgrade posture), compound-op sub-policy,
 *  operation-group integrity (no dangling op refs), the auto-grant safety
 *  invariant (a `grant_default: 'on_after_connect'` group may hold only
 *  read-tier ops — Invariant 3 / § "no admin-tier operations in a catalog
 *  claiming read-only scope"), and catalog governance (`private_byo` is
 *  never marketplace-eligible).
 *
 *  A subsequent slice added the `surfaces` block (api / connector /
 *  notification) — `validateProviderSurfaces` gates the surface shape plus
 *  the surface-DEPENDENT invariants: scope-universe coverage (every op's
 *  `required_scopes` ⊆ the auth's declared scope universe), real-time-binding
 *  cache discipline (a webhook / queue / push binding forces its op's
 *  `cache_ttl_ms` to 0), connector wire/binding-kind match, and the per-
 *  surface `default_timeout_ms` cap.
 *
 *  Every gate is additive: a P0/P1 catalog declaring only operation_id /
 *  risk_tier / groups / approval / delegates_to with NO `surfaces` (e.g. the
 *  HubSpot pilot) stays valid (spec § Compatibility — "additive options, not
 *  a fork"). Required-at-publish gates (catalog_kind must be present, etc.),
 *  the OpenAPI/GraphQL document pin + connector `describe()` cross-checks, and
 *  the runtime gateway dispatch over `surfaces.api.executes` land with later
 *  P2 slices. */
const validateCatalogForm = (m: Record<string, unknown>, add: AddFn): void => {
  const rawInput = own(m, 'input');
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
    ? (rawInput as Record<string, unknown>)
    : {};
  // The catalog call shape is { operation, args, connection } — the
  // manifest input declares operation + args (connection is step-level).
  for (const key of ['operation', 'args']) {
    if (!hasOwn(input, key)) {
      add('error', 'CATALOG_INPUT_SHAPE_INVALID', `input.${key}`,
        `catalog-form ingredient must declare input.${key} (the operation call shape)`);
    }
  }
  // No mixed shapes — a catalog declares operations, not a wire endpoint.
  for (const key of CATALOG_FORBIDDEN_WIRE_KEYS) {
    if (hasOwn(input, key)) {
      add('error', 'CATALOG_MIXED_SHAPE', `input.${key}`,
        `catalog-form ingredient must not also declare the single-endpoint key input.${key} — operations carry per-operation execution bindings`);
    }
  }

  // ── Catalog-level defaults (bound bases for per-op timeout / cache). A
  //    malformed default is flagged below; the bound base falls back to the
  //    contract default so per-op gates still apply meaningfully. ──
  const rawDefaultTimeout = own(m, 'default_timeout_ms');
  const catalogDefaultTimeout = isIntInRange(rawDefaultTimeout, 1, CATALOG_MAX_DEFAULT_TIMEOUT_MS)
    ? (rawDefaultTimeout as number)
    : CATALOG_DEFAULT_TIMEOUT_MS;
  const rawDefaultCache = own(m, 'default_cache_ttl_ms');
  const catalogDefaultCache = isIntInRange(rawDefaultCache, 0, CATALOG_MAX_CACHE_TTL_MS)
    ? (rawDefaultCache as number)
    : CATALOG_DEFAULT_CACHE_TTL_MS;
  // Surfaces (execution layer). A surfaceless P0/P1 catalog keeps the loosest
  // (GraphQL 180s) default-timeout cap + skips the surface gates entirely. A
  // `surfaces` key that is PRESENT but malformed (null / array / scalar) must
  // NOT take the surfaceless path — `surfacesPresent` separates "absent"
  // (legit skip) from "present but non-object" (error, below).
  const rawSurfaces = own(m, 'surfaces');
  const surfacesPresent = rawSurfaces !== undefined;
  const hasSurfaces = isObjectRecord(rawSurfaces);
  const surfaceTimeoutCap = surfaceDefaultTimeoutCapMs(rawSurfaces);

  // ── Catalog-level governance + policy defaults (gated only when present;
  //    the P0/P1 pilot omits them and stays valid). ──
  const catalogKind = own(m, 'catalog_kind');
  if (catalogKind !== undefined && !isCatalogKind(catalogKind)) {
    add('error', 'CATALOG_POLICY_INVALID', 'catalog_kind',
      'catalog_kind must be one of official|unofficial_acknowledged|private_byo');
  }
  const marketplaceEligible = own(m, 'marketplace_eligible');
  if (marketplaceEligible !== undefined && typeof marketplaceEligible !== 'boolean') {
    add('error', 'CATALOG_POLICY_INVALID', 'marketplace_eligible',
      'marketplace_eligible must be a boolean');
  }
  // `private_byo` never enters marketplace publishing (spec § top-level).
  if (catalogKind === 'private_byo' && marketplaceEligible === true) {
    add('error', 'CATALOG_POLICY_INVALID', 'marketplace_eligible',
      "catalog_kind 'private_byo' is never marketplace-eligible — marketplace_eligible must be false or omitted");
  }
  const supportedMedia = own(m, 'supported_media');
  if (supportedMedia !== undefined
    && (!Array.isArray(supportedMedia) || supportedMedia.some((mk) => !isMediaKind(mk)))) {
    add('error', 'CATALOG_POLICY_INVALID', 'supported_media',
      'supported_media must be an array of media kinds');
  }
  const consentWarnings = own(m, 'install_consent_warnings');
  if (consentWarnings !== undefined
    && (!Array.isArray(consentWarnings) || consentWarnings.some((w) => typeof w !== 'string'))) {
    add('error', 'CATALOG_POLICY_INVALID', 'install_consent_warnings',
      'install_consent_warnings must be an array of strings');
  }
  const vendorTos = own(m, 'vendor_tos_url');
  if (vendorTos !== undefined && typeof vendorTos !== 'string') {
    add('error', 'CATALOG_POLICY_INVALID', 'vendor_tos_url', 'vendor_tos_url must be a string');
  }
  // default_timeout_ms — positive integer ≤ the per-surface hard cap. With no
  // surface declared the cap is the loosest (GraphQL 180s) and a value above
  // the REST soft cap (60s) only WARNS (existing surfaceless behavior). Once a
  // surface is declared the cap tightens to that surface's category ceiling
  // (REST 60s / connector 120s; GraphQL stays 180s) and exceeding it is an
  // ERROR — the precise cap replaces the heuristic warn (spec § Timeout gates).
  if (rawDefaultTimeout !== undefined) {
    if (!isIntInRange(rawDefaultTimeout, 1, surfaceTimeoutCap)) {
      add('error', 'CATALOG_TIMEOUT_INVALID', 'default_timeout_ms',
        `default_timeout_ms must be a positive integer ≤ ${surfaceTimeoutCap}${surfaceTimeoutCap < CATALOG_MAX_DEFAULT_TIMEOUT_MS ? ' (surface-specific cap)' : ''}`);
    } else if (!hasSurfaces && (rawDefaultTimeout as number) > CATALOG_REST_TIMEOUT_SOFT_CAP_MS) {
      add('warn', 'CATALOG_TIMEOUT_HIGH', 'default_timeout_ms',
        `default_timeout_ms ${rawDefaultTimeout} exceeds the REST soft cap ${CATALOG_REST_TIMEOUT_SOFT_CAP_MS} — confirm the catalog's surface supports it`);
    }
  }
  if (rawDefaultCache !== undefined && !isIntInRange(rawDefaultCache, 0, CATALOG_MAX_CACHE_TTL_MS)) {
    add('error', 'CATALOG_CACHE_POLICY_INVALID', 'default_cache_ttl_ms',
      `default_cache_ttl_ms must be an integer in [0, ${CATALOG_MAX_CACHE_TTL_MS}] (24h)`);
  }

  // ── Operations — shape + full per-op policy. Collect declared keys + each
  //    op's risk tier for the operation-group integrity + auto-grant gates. ──
  const operations = (own(m, 'operations') ?? {}) as Record<string, unknown>;
  const opKeys = new Set(Object.keys(operations));
  const opRiskByKey: Record<string, string> = {};
  const opKeyByDeclaredId = new Map<string, string>();
  for (const [opKey, rawSpec] of Object.entries(operations)) {
    const path = `operations.${opKey}`;
    if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
      add('error', 'CATALOG_OPERATION_INVALID', path, `operation '${opKey}' must be an object`);
      continue;
    }
    const spec = rawSpec as Record<string, unknown>;
    if (typeof spec.operation_id !== 'string' || spec.operation_id.trim().length === 0) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.operation_id`,
        `operation '${opKey}' must declare a non-empty operation_id`);
    } else if (spec.operation_id !== spec.operation_id.trim()) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.operation_id`,
        `operation '${opKey}' operation_id must not have leading or trailing whitespace`);
    } else {
      const reservedPrefix = declaredOperationIdReservedPrefix(spec.operation_id);
      // A real bundled kernel manifest may own `core.*`; downloaded/catalog
      // manifests may not borrow any server-owned identity. No kernel catalog
      // ships today, but keeping the author-bound permitting case avoids making
      // the reservation an accidental ban on a future reviewed kernel catalog.
      const kernelOwnsPrefix = reservedPrefix === KERNEL_GRANT_PREFIX && isKernelManifest(m);
      if (reservedPrefix !== undefined && !kernelOwnsPrefix) {
        add('error', 'CATALOG_OPERATION_ID_RESERVED', `${path}.operation_id`,
          `operation '${opKey}' operation_id '${spec.operation_id}' starts with reserved namespace '${reservedPrefix}'`);
      }
      const priorKey = opKeyByDeclaredId.get(spec.operation_id);
      if (priorKey !== undefined) {
        add('error', 'CATALOG_OPERATION_ID_DUPLICATE', `${path}.operation_id`,
          `operation '${opKey}' reuses operation_id '${spec.operation_id}' already declared by '${priorKey}'`);
      } else {
        opKeyByDeclaredId.set(spec.operation_id, opKey);
      }
    }
    const opRisk = typeof spec.risk_tier === 'string' ? spec.risk_tier : '';
    if (!isRiskTier(opRisk)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.risk_tier`,
        `operation '${opKey}' risk_tier must be one of read|write|admin|destructive`);
    } else {
      opRiskByKey[opKey] = opRisk;
    }
    if (spec.groups !== undefined
      && (!Array.isArray(spec.groups) || spec.groups.some((g) => typeof g !== 'string'))) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.groups`,
        `operation '${opKey}' groups must be an array of strings`);
    }
    if (spec.approval !== undefined
      && (typeof spec.approval !== 'string' || !CATALOG_APPROVALS.has(spec.approval))) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.approval`,
        `operation '${opKey}' approval must be one of never|ask|always`);
    }

    // D-201 Slice 6B3 — portable operations may name only the logical webhook
    // binding and attach/detach intent. Callback field paths and request
    // construction remain in a trusted server adapter selected by the exact
    // profile/catalog/operation tuple.
    if (spec.operation_bound_webhook !== undefined) {
      const declaration = spec.operation_bound_webhook;
      if (!isObjectRecord(declaration)) {
        add('error', 'CATALOG_OPERATION_BOUND_WEBHOOK_INVALID',
          `${path}.operation_bound_webhook`,
          `operation '${opKey}' operation_bound_webhook must be an object`);
      } else {
        const keys = Object.keys(declaration).sort();
        if (keys.join(',') !== 'binding,intent') {
          add('error', 'CATALOG_OPERATION_BOUND_WEBHOOK_INVALID',
            `${path}.operation_bound_webhook`,
            `operation '${opKey}' operation_bound_webhook accepts only binding and intent`);
        }
        const bindingName = declaration.binding;
        if (typeof bindingName !== 'string'
          || !WEBHOOK_BINDING_RE.test(bindingName)
          || bindingName === '__proto__'
          || bindingName === 'constructor'
          || bindingName === 'prototype') {
          add('error', 'CATALOG_OPERATION_BOUND_WEBHOOK_INVALID',
            `${path}.operation_bound_webhook.binding`,
            `operation '${opKey}' operation-bound webhook binding is invalid or reserved`);
        }
        if (declaration.intent !== 'attach' && declaration.intent !== 'detach') {
          add('error', 'CATALOG_OPERATION_BOUND_WEBHOOK_INVALID',
            `${path}.operation_bound_webhook.intent`,
            `operation '${opKey}' operation-bound webhook intent must be attach|detach`);
        }
        if (opRisk === 'read') {
          add('error', 'CATALOG_OPERATION_BOUND_WEBHOOK_INVALID',
            `${path}.operation_bound_webhook`,
            `operation '${opKey}' operation-bound webhook mutation cannot be read-tier`);
        }
        const surface = isObjectRecord(m.surfaces) && isObjectRecord(m.surfaces.api)
          ? m.surfaces.api
          : null;
        const executes = surface !== null && isObjectRecord(surface.executes)
          ? surface.executes
          : null;
        const binding = executes !== null && isObjectRecord(executes[opKey])
          ? executes[opKey]
          : null;
        if (binding === null || binding.kind !== 'rest') {
          add('error', 'CATALOG_OPERATION_BOUND_WEBHOOK_INVALID',
            `${path}.operation_bound_webhook`,
            `operation '${opKey}' operation-bound webhook requires a REST execution binding`);
        }
      }
    }

    // D-177 catalog open mode — the per-op authority declaration (the op's
    // `grant_mode: 'open'` opt-in; presence is the attestation). Same shape
    // rules as the simple-form manifest field.
    if (spec.authority_args !== undefined) {
      checkAuthorityArgsShape(
        spec.authority_args,
        `${path}.authority_args`,
        add,
      );
    }

    // D-177 P1b — per-op volatile-exclusion declaration (N.2), gated against
    // the op's authority-bearing set derived from its OWN declarations
    // (which since the catalog open mode includes the op's `authority_args`
    // — a declared open-authority path can never be excluded) PLUS its api
    // binding's `path_template` `{{token}}` target selectors (so a
    // write/destructive op's path-borne record id — `{{contact_id}}` — can't
    // be excluded even when the op declares no `path_scope` / `authority_args`).
    checkHashExcludeArgs(
      spec.hash_exclude_args,
      collectOpAuthorityPaths(spec, operationPathTemplate(m, opKey)),
      `${path}.hash_exclude_args`,
      `operation '${opKey}'`,
      add,
    );
    if (spec.pagination !== undefined) {
      if (spec.risk_tier !== 'read') {
        add('error', 'CATALOG_OPERATION_INVALID', `${path}.pagination`,
          'pagination may only be declared on read-tier operations');
      }
      validateOperationPagination(spec.pagination, `${path}.pagination`, add);
    }

    // ── D-165 P2 — full per-op policy (each gated only when present). ──
    if (spec.idempotency !== undefined && !isOperationIdempotency(spec.idempotency)) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.idempotency`,
        `operation '${opKey}' idempotency must be one of safe|idempotent|non_idempotent`);
    }
    if (spec.required_scopes !== undefined
      && (!Array.isArray(spec.required_scopes)
        || spec.required_scopes.some((s) => typeof s !== 'string'))) {
      add('error', 'CATALOG_OPERATION_INVALID', `${path}.required_scopes`,
        `operation '${opKey}' required_scopes must be an array of strings`);
    }
    for (const mediaKey of ['accepts_media', 'produces_media'] as const) {
      const media = spec[mediaKey];
      if (media !== undefined && (!Array.isArray(media) || media.some((mk) => !isMediaKind(mk)))) {
        add('error', 'CATALOG_OPERATION_INVALID', `${path}.${mediaKey}`,
          `operation '${opKey}' ${mediaKey} must be an array of media kinds`);
      }
    }
    for (const message of closedRequestSchemaDefinitionIssues(spec.request_schema)) {
      add(
        'error',
        'CATALOG_REQUEST_SCHEMA_INVALID',
        `${path}.request_schema`,
        `operation '${opKey}' closed request schema is invalid: ${message}`,
      );
    }
    // request_metadata.custom_headers — author-supplied headers must not carry
    // auth/session material; the gateway owns those (spec § API-surface gates,
    // Codex review MED). Other request_metadata fields gate in a later slice.
    if (spec.request_metadata !== undefined) {
      if (!isObjectRecord(spec.request_metadata)) {
        add('error', 'CATALOG_OPERATION_INVALID', `${path}.request_metadata`,
          `operation '${opKey}' request_metadata must be an object`);
      } else if (spec.request_metadata.custom_headers !== undefined) {
        const headers = spec.request_metadata.custom_headers;
        if (!isObjectRecord(headers)) {
          add('error', 'CATALOG_OPERATION_INVALID', `${path}.request_metadata.custom_headers`,
            `operation '${opKey}' request_metadata.custom_headers must be an object of string values`);
        } else {
          for (const [hName, hVal] of Object.entries(headers)) {
            const hPath = `${path}.request_metadata.custom_headers.${hName}`;
            if (typeof hVal !== 'string') {
              add('error', 'CATALOG_OPERATION_INVALID', hPath,
                `operation '${opKey}' custom header '${hName}' value must be a string`);
            }
            if (CATALOG_FORBIDDEN_CUSTOM_HEADERS.has(hName.toLowerCase())) {
              add('error', 'CATALOG_OPERATION_INVALID', hPath,
                `operation '${opKey}' must not supply the auth/session header '${hName}' — the gateway owns auth headers (spec § API-surface gates)`);
            }
          }
        }
      }
    }
    // timeout_ms — bounded [MIN, catalog default × MULT] (Invariant 6).
    if (spec.timeout_ms !== undefined) {
      const ceiling = catalogDefaultTimeout * CATALOG_OP_TIMEOUT_MULTIPLIER;
      if (!isIntInRange(spec.timeout_ms, CATALOG_MIN_OP_TIMEOUT_MS, ceiling)) {
        add('error', 'CATALOG_TIMEOUT_INVALID', `${path}.timeout_ms`,
          `operation '${opKey}' timeout_ms must be an integer in [${CATALOG_MIN_OP_TIMEOUT_MS}, ${ceiling}] (catalog default × ${CATALOG_OP_TIMEOUT_MULTIPLIER})`);
      }
    }
    // cache_ttl_ms — Invariant 7: a positive TTL is read-tier only.
    if (spec.cache_ttl_ms !== undefined) {
      const c = spec.cache_ttl_ms;
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 0) {
        add('error', 'CATALOG_CACHE_POLICY_INVALID', `${path}.cache_ttl_ms`,
          `operation '${opKey}' cache_ttl_ms must be a non-negative integer (ms)`);
      } else if (isRiskTier(opRisk) && opRisk !== 'read' && c > 0) {
        // Only a VALID non-read tier (write/admin/destructive) trips this —
        // a missing/invalid risk_tier already errored above; don't pile a
        // misleading "non-read" cache error on top of it (Codex review MED).
        add('error', 'CATALOG_CACHE_POLICY_INVALID', `${path}.cache_ttl_ms`,
          `operation '${opKey}' is ${opRisk}-tier; cache_ttl_ms must be 0 or omitted — only read-tier operations cache (Invariant 7)`);
      } else if (opRisk === 'read'
        && (c > CATALOG_MAX_CACHE_TTL_MS
          || (catalogDefaultCache > 0 && c > catalogDefaultCache * CATALOG_CACHE_OUTLIER_MULTIPLIER))) {
        add('warn', 'CATALOG_CACHE_TTL_OUTLIER', `${path}.cache_ttl_ms`,
          `operation '${opKey}' cache_ttl_ms ${c} exceeds the 24h cap or ${CATALOG_CACHE_OUTLIER_MULTIPLIER}× the catalog default — likely an outlier`);
      }
    }
    // sub_operations — each carries a valid risk tier (+ approval/groups).
    if (spec.sub_operations !== undefined) {
      if (typeof spec.sub_operations !== 'object' || spec.sub_operations === null
        || Array.isArray(spec.sub_operations)) {
        add('error', 'CATALOG_OPERATION_INVALID', `${path}.sub_operations`,
          `operation '${opKey}' sub_operations must be an object`);
      } else {
        for (const [subKey, rawSub] of Object.entries(spec.sub_operations as Record<string, unknown>)) {
          const subPath = `${path}.sub_operations.${subKey}`;
          if (!rawSub || typeof rawSub !== 'object' || Array.isArray(rawSub)) {
            add('error', 'CATALOG_OPERATION_INVALID', subPath,
              `sub-operation '${subKey}' must be an object`);
            continue;
          }
          const sub = rawSub as Record<string, unknown>;
          if (typeof sub.risk_tier !== 'string' || !isRiskTier(sub.risk_tier)) {
            add('error', 'CATALOG_OPERATION_INVALID', `${subPath}.risk_tier`,
              `sub-operation '${subKey}' risk_tier must be one of read|write|admin|destructive`);
          }
          if (sub.approval !== undefined
            && (typeof sub.approval !== 'string' || !CATALOG_APPROVALS.has(sub.approval))) {
            add('error', 'CATALOG_OPERATION_INVALID', `${subPath}.approval`,
              `sub-operation '${subKey}' approval must be one of never|ask|always`);
          }
          if (sub.groups !== undefined
            && (!Array.isArray(sub.groups) || sub.groups.some((g) => typeof g !== 'string'))) {
            add('error', 'CATALOG_OPERATION_INVALID', `${subPath}.groups`,
              `sub-operation '${subKey}' groups must be an array of strings`);
          }
        }
      }
    }
  }

  // ── Operation groups — shape + enum gates + integrity (no dangling op
  //    refs) + the auto-grant safety invariant. ──
  const groups = own(m, 'operation_groups');
  if (groups !== undefined) {
    if (typeof groups !== 'object' || groups === null || Array.isArray(groups)) {
      add('error', 'CATALOG_GROUP_INVALID', 'operation_groups',
        'operation_groups must be an object keyed by group id');
    } else {
      for (const [groupKey, rawGroup] of Object.entries(groups as Record<string, unknown>)) {
        const gPath = `operation_groups.${groupKey}`;
        if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) {
          add('error', 'CATALOG_GROUP_INVALID', gPath,
            `operation group '${groupKey}' must be an object`);
          continue;
        }
        const group = rawGroup as Record<string, unknown>;
        if (typeof group.group_id !== 'string' || group.group_id.length === 0) {
          add('error', 'CATALOG_GROUP_INVALID', `${gPath}.group_id`,
            `operation group '${groupKey}' must declare a non-empty group_id`);
        }
        if (group.risk_floor !== undefined
          && (typeof group.risk_floor !== 'string' || !isRiskTier(group.risk_floor))) {
          add('error', 'CATALOG_GROUP_INVALID', `${gPath}.risk_floor`,
            `operation group '${groupKey}' risk_floor must be one of read|write|admin|destructive`);
        }
        if (group.grant_default !== undefined && !isGroupGrantDefault(group.grant_default)) {
          add('error', 'CATALOG_GROUP_INVALID', `${gPath}.grant_default`,
            `operation group '${groupKey}' grant_default must be one of off|on_after_connect`);
        }
        if (group.upgrade_behavior !== undefined && !isGroupUpgradeBehavior(group.upgrade_behavior)) {
          add('error', 'CATALOG_GROUP_INVALID', `${gPath}.upgrade_behavior`,
            `operation group '${groupKey}' upgrade_behavior must be one of new_operations_off|inherit_group_policy`);
        }
        const groupOps = group.operations;
        if (!Array.isArray(groupOps) || groupOps.some((o) => typeof o !== 'string')) {
          add('error', 'CATALOG_GROUP_INVALID', `${gPath}.operations`,
            `operation group '${groupKey}' operations must be an array of declared operation keys`);
        } else {
          for (const opRef of groupOps as string[]) {
            if (!opKeys.has(opRef)) {
              add('error', 'CATALOG_GROUP_INVALID', `${gPath}.operations`,
                `operation group '${groupKey}' references undeclared operation '${opRef}'`);
            }
          }
          // Auto-grant safety (Invariant 3 / § "no admin-tier operations in
          // a catalog claiming read-only scope") — a group auto-granted at
          // enrollment may hold ONLY read-tier operations; auto-granting a
          // write/admin/destructive op would bypass operations-default-off.
          // A dangling ref (risk unknown) is skipped — it already errored.
          if (group.grant_default === 'on_after_connect') {
            for (const opRef of groupOps as string[]) {
              const r = opRiskByKey[opRef];
              if (r !== undefined && r !== 'read') {
                add('error', 'CATALOG_AUTOGRANT_UNSAFE', `${gPath}.grant_default`,
                  `operation group '${groupKey}' is grant_default 'on_after_connect' but contains ${r}-tier operation '${opRef}' — only read-tier operations may be auto-granted at enrollment (Invariant 3)`);
              }
            }
          }
        }
      }
    }
  }

  // ── Surfaces (execution layer) — shape + the surface-dependent invariants
  //    (scope-universe coverage, real-time-binding cache discipline, connector
  //    wire/binding match). Additive: an ABSENT `surfaces` key skips this
  //    entirely; a PRESENT-but-non-object value is a hard error (else a
  //    malformed `surfaces` would bypass every gate — Codex review MED). ──
  if (surfacesPresent && !hasSurfaces) {
    add('error', 'CATALOG_SURFACE_INVALID', 'surfaces',
      'surfaces must be an object declaring at least one of api | connector | notification');
  } else if (hasSurfaces) {
    validateProviderSurfaces(rawSurfaces as Record<string, unknown>, add, operations, opKeys);
  }
};

// ────────────────────────────────────────────────────────────────
// D-177 P1b — `hash_exclude_args` (N.2 volatile exclusions)
// ────────────────────────────────────────────────────────────────

/** Wire-authority baseline — the input keys that select the call's
 *  destination / transport / connection, UNION the per-kind target-scope
 *  keys (`TARGET_SCOPE`: `url` / `mcp.tool` / `dom.match` — codex P1 fold:
 *  without them a simple-form manifest could validate
 *  `hash_exclude_args: ['mcp.tool']` and an exact-repeat grant would match
 *  across different MCP tools). An exclusion may never target one (N.2
 *  fail-closed): "exact repeat" must keep pinning where the call goes, not
 *  just what it says. Shared by the simple-form manifest gate and the
 *  per-operation catalog gate.
 *
 *  D-177 P5b — the list itself moved to `@recued/contracts`
 *  (`WIRE_AUTHORITY_ARG_PATHS`) so the open-projection walker reads the SAME
 *  baseline this gate enforces — one authority set, two consumers (N.2). */
const HASH_EXCLUDE_WIRE_AUTHORITY: readonly string[] = WIRE_AUTHORITY_ARG_PATHS;

/** Derive a catalog operation's authority-bearing arg paths. The derivation
 *  moved to `@recued/contracts` (`collectOperationAuthorityPaths`) when the
 *  catalog gate's open mode landed — the runtime walk closure guards the
 *  SAME set this gate bounds exclusions against (one source of truth, the
 *  N.2 posture; mirrors the `WIRE_AUTHORITY_ARG_PATHS` move). It now also
 *  folds in the op's explicit `authority_args` declaration ("extends the
 *  set; never shrinks it"), shape-gated separately by
 *  `checkAuthorityArgsShape` in the operation loop. */
const collectOpAuthorityPaths = collectOperationAuthorityPaths;

/** Run the contracts fail-closed gate over one declared exclusion list and
 *  surface every violation as a publish-blocking error. */
const checkHashExcludeArgs = (
  declared: unknown,
  authority: readonly string[],
  path: string,
  label: string,
  add: AddFn,
): void => {
  if (declared === undefined) return;
  if (!Array.isArray(declared) || declared.some((p) => typeof p !== 'string')) {
    add('error', 'HASH_EXCLUDE_INVALID', path,
      `${label} hash_exclude_args must be an array of dot-path strings`);
    return;
  }
  const result = validateHashExcludeArgs(declared as string[], authority);
  for (const v of result.violations) {
    const hint = v.reason === 'authority_bearing'
      ? ' — an exclusion may never target a destination / connection / target-affecting arg (N.2)'
      : v.reason === 'destination_name'
        ? ' — an exclusion may never target a recipient / channel / calendar / destination-selector arg (N.2 backstop), even undeclared'
        : '';
    add('error', 'HASH_EXCLUDE_INVALID', path,
      `${label} hash_exclude_args path '${v.path}' rejected (${v.reason})${hint}`);
  }
};

/** Manifest-level `hash_exclude_args` — the SIMPLE-FORM declaration site
 *  (the manifest is a simple-form ingredient's curated trust surface). A
 *  catalog-form manifest must declare exclusions per operation instead: the
 *  Gateway resolves a catalog surface dispatch's exclusions from the op row
 *  only, so a manifest-level list there would validate and then silently
 *  never apply — fail loud at publish. Per-op declarations are gated inside
 *  `validateCatalogForm`'s operation loop. */
const validateHashExclude = (m: Record<string, unknown>, add: AddFn): void => {
  const declared = own(m, 'hash_exclude_args');
  if (declared === undefined) return;
  if (isCatalogForm(m)) {
    add('error', 'HASH_EXCLUDE_MISPLACED', 'hash_exclude_args',
      'catalog-form ingredients declare hash_exclude_args per operation '
        + '(operations.<key>.hash_exclude_args) — a manifest-level list never '
        + 'applies to catalog surface dispatches');
    return;
  }
  // D-177 P5b — a declared `authority_args` list JOINS the never-exclude set
  // (N.2: an exclusion may never target a destination/entity selector, and
  // the manifest's own declaration names exactly those). Validated by
  // `validateAuthorityArgs`; a malformed declaration contributes nothing
  // here and fails its own gate.
  const declaredAuthority = own(m, 'authority_args');
  const authority =
    Array.isArray(declaredAuthority)
    && declaredAuthority.every((p) => typeof p === 'string')
      ? [...HASH_EXCLUDE_WIRE_AUTHORITY, ...(declaredAuthority as string[])]
      : HASH_EXCLUDE_WIRE_AUTHORITY;
  checkHashExcludeArgs(
    declared, authority, 'hash_exclude_args', 'manifest', add,
  );
};

/** Shared shape gate for ONE `authority_args` declaration — the simple-form
 *  manifest field AND the per-op catalog field run the identical rules:
 *  PRESENCE is a `grant_mode: 'open'` opt-in attestation, so the shape must
 *  be unambiguous — an array of non-empty dot-path strings, no template
 *  syntax, no wildcards, no duplicates. An EMPTY array is valid (the
 *  baseline authority set suffices). */
const checkAuthorityArgsShape = (
  declared: unknown,
  path: string,
  add: AddFn,
): void => {
  if (!Array.isArray(declared)) {
    add('error', 'AUTHORITY_ARGS_INVALID', path,
      'authority_args must be an array of dot-path strings (empty array = '
        + '"the baseline authority keys suffice"; absent = open grants never offered)');
    return;
  }
  const seen = new Set<string>();
  for (const entry of declared) {
    if (typeof entry !== 'string' || entry.length === 0) {
      add('error', 'AUTHORITY_ARGS_INVALID', path,
        'authority_args entries must be non-empty dot-path strings');
      return;
    }
    if (entry.includes('{{') || entry.includes('*')) {
      add('error', 'AUTHORITY_ARGS_INVALID', path,
        `authority_args path '${entry}' rejected — template syntax and `
          + 'wildcards are not authority paths (declare concrete arg keys)');
      continue;
    }
    if (seen.has(entry)) {
      add('error', 'AUTHORITY_ARGS_INVALID', path,
        `authority_args path '${entry}' declared twice`);
      continue;
    }
    seen.add(entry);
  }
};

/** D-177 P5b (N.11) — the simple-form `authority_args` declaration gate.
 *  PRESENCE is the `grant_mode: 'open'` opt-in attestation (the curator
 *  asserts the wire baseline ∪ this list covers every destination/entity
 *  selector). Catalog-form manifests must not declare it at the MANIFEST
 *  level — the catalog declaration site is per operation
 *  (`operations.<key>.authority_args`, gated inside `validateCatalogForm`'s
 *  operation loop), where the catalog gate's open mode consumes it (fail
 *  loud rather than validate-and-never-apply, mirroring
 *  `hash_exclude_args`). */
const validateAuthorityArgs = (m: Record<string, unknown>, add: AddFn): void => {
  const declared = own(m, 'authority_args');
  if (declared === undefined) return;
  if (isCatalogForm(m)) {
    add('error', 'AUTHORITY_ARGS_MISPLACED', 'authority_args',
      'catalog-form ingredients declare authority_args per operation '
        + '(operations.<key>.authority_args) — a manifest-level list never '
        + 'applies to catalog surface dispatches');
    return;
  }
  checkAuthorityArgsShape(declared, 'authority_args', add);
};

const validateConnectionWrapper = (m: Record<string, unknown>, add: AddFn): void => {
  if (own(m, 'kind') !== 'connection') return;
  if (isKernelManifest(m)) return;
  // D-165 P1 — catalog-form ingredients (manifest carries an `operations`
  // map) describe MULTIPLE operations, not a single wire endpoint, so the
  // wrapper shape (`connection_kind` + `method`/`path` + a `{{config.X}}`
  // picker) doesn't apply. Validate the catalog-form SHAPE instead, then
  // skip the wrapper-endpoint checks — a bare field-presence skip would
  // let a dummy `operations` map bypass manifest validation on the shared
  // marketplace publish path (Codex review HIGH#1). The executor-ambiguous
  // gate already exempts `kind: 'connection'`. The strict policy-layer
  // validator (D-165 P2) gates operations / groups / cache / timeout /
  // governance; surface + OpenAPI/connector cross-checks land in a later P2.
  if (isCatalogForm(m)) {
    validateCatalogForm(m, add);
    return;
  }
  const rawInput = own(m, 'input');
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return;

  const input = rawInput as Record<string, unknown>;
  const connectionKind = own(input, 'connection_kind');

  let kindOk = false;
  if (typeof connectionKind === 'string' && VALID_CONNECTION_KINDS.has(connectionKind)) {
    kindOk = true;
  } else {
    add('error', 'CONNECTION_KIND_INVALID', 'input.connection_kind',
      `kind: 'connection' wrapper must declare input.connection_kind as 'api' | 'mcp' | 'notification' (got ${
        connectionKind === undefined ? 'missing' : JSON.stringify(connectionKind)
      })`);
  }

  const connection = own(input, 'connection');
  if (typeof connection !== 'string' || !CONNECTION_PICKER_REGEX.test(connection)) {
    add('error', 'CONNECTION_PICKER_INVALID', 'input.connection',
      `kind: 'connection' wrapper must bind input.connection to a {{config.<X>}} picker (got ${
        connection === undefined ? 'missing' : JSON.stringify(connection)
      })`);
  }

  if (kindOk) {
    // D-127 P3.2 — notification subtype-aware required-key resolution.
    // For non-notification kinds, fall through to the default table.
    const requiredKeys = (() => {
      if (connectionKind === 'notification') {
        const subtype = own(input, 'subtype');
        if (
          typeof subtype === 'string' &&
          hasOwn(NOTIFICATION_SUBTYPE_REQUIRED, subtype)
        ) {
          return NOTIFICATION_SUBTYPE_REQUIRED[subtype];
        }
      }
      return PER_CONNECTION_KIND_REQUIRED[connectionKind as string];
    })();
    for (const required of requiredKeys) {
      if (!hasOwn(input, required)) {
        add('error', 'CONNECTION_KIND_MISSING_FIELD', `input.${required}`,
          `connection_kind: '${connectionKind}' requires top-level input key '${required}'`);
      }
    }
  }
};

const validateCategoryConsistency = (m: Record<string, unknown>, add: AddFn): void => {
  const slug = typeof m.slug === 'string' ? m.slug : null;
  const category = typeof m.category === 'string' ? m.category : null;
  const rawInput = own(m, 'input');
  const rawOutput = own(m, 'output');
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
    ? (rawInput as Record<string, unknown>)
    : null;
  const output = (rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput))
    ? (rawOutput as Record<string, unknown>)
    : null;

  if (!slug || !category || !input) return;

  const keys = Object.keys(input);
  const hasHttp = keys.some((k) => HTTP_BARE_KEYS.has(k) || HTTP_KEY_PREFIXES.some((p) => k.startsWith(p)));
  const hasDom = keys.some((k) => k.startsWith('dom.'));
  const hasMcp = keys.some((k) => k.startsWith('mcp.'));
  const hasLlm = keys.some((k) => k.startsWith('llm.'));
  const hasChat = keys.some((k) => k.startsWith('chat.'));

  // ai- slug ↔ category == 'ai'. §5 — a `core-ai-*` kernel alias follows the ai-
  // convention, so strip the reserved prefix before the slug check (otherwise
  // `core-ai-classify`, category 'ai', would draw a spurious `ai_slug_prefix` warn).
  const baseSlug = stripCorePrefix(slug);
  if (baseSlug.startsWith('ai-') && category !== 'ai') {
    add('error', 'slug_ai_category_mismatch', 'category',
      `slug starts with "ai-" but category is "${category}" — must be "ai"`);
  }
  if (category === 'ai' && !baseSlug.startsWith('ai-') && !isLocalIngredient(slug)) {
    add('warn', 'ai_slug_prefix', 'slug',
      'ai category ingredient slug should start with "ai-" by convention');
  }

  // ai category must have llm.* input keys
  if (category === 'ai' && !hasLlm) {
    add('error', 'ai_no_llm_input', 'input',
      'ai category ingredient must declare at least one llm.* input key');
  }

  // Non-ai data/action ingredients must declare an executor.
  // DOM ingredients can be identified by trigger patterns in output
  // (they route via pickAdapter's default fallback) OR by dom.* input keys.
  // Kernel ingredients (author = `recued`, the reserved kernel namespace)
  // route through a dedicated dispatcher (server rpc, shared-store
  // helpers) and skip this check. Service manifests (kind = 'service')
  // route through the server's service dispatcher and use
  // `input.service.*` instead of an HTTP/DOM/MCP/Chat executor.
  // D-125 P5.1 — `kind: 'connection'` wrappers (kind itself names the
  // adapter; `validateConnectionWrapper` enforces the per-kind shape).
  const hasTriggerInOutput = output != null && typeof output === 'object'
    && Object.values(output).some((v) => v === 'trigger');
  const isKernel = isKernelManifest(m);
  const isService = isServiceManifest(m);
  const isConnection = m.kind === 'connection';
  const surfaces = own(m, 'surfaces');
  const isRecordsCatalog = isCatalogForm(m)
    && surfaces !== null
    && typeof surfaces === 'object'
    && !Array.isArray(surfaces)
    && Object.prototype.hasOwnProperty.call(surfaces, 'records');
  if (!isKernel && !isService && !isConnection && !isRecordsCatalog && (category === 'data' || category === 'action') && !hasHttp && !hasDom && !hasMcp && !hasChat && !hasTriggerInOutput) {
    add('error', 'executor_ambiguous', 'input',
      'cannot determine executor — input must contain url (HTTP), dom.* (DOM), mcp.* (MCP), or chat.* (Chat) keys, or output must contain trigger patterns (DOM)');
  }

  // HTTP single-endpoint + static url + static method
  if (hasHttp && hasOwn(input, 'url')) {
    const url = own(input, 'url');
    if (url === null) {
      add('error', 'http_url_null', 'input.url',
        'HTTP ingredient url must have a static default, not null (attestation requirement)');
    } else if (typeof url !== 'string') {
      add('error', 'http_url_not_string', 'input.url',
        'HTTP ingredient url must be a string');
    }
    if (hasOwn(input, 'method') && own(input, 'method') === null) {
      add('error', 'http_method_null', 'input.method',
        'HTTP ingredient method must have a static default, not null');
    }
  }

  // DOM ingredient: output must declare at least one trigger URL pattern
  if (output && (hasDom || Object.values(output).includes('trigger'))) {
    const triggers = Object.entries(output).filter(([, v]) => v === 'trigger');
    if (triggers.length === 0 && hasDom) {
      add('error', 'dom_no_trigger', 'output',
        'DOM ingredient must declare a trigger URL pattern (output key → "trigger")');
    } else if (triggers.length > 1) {
      add('warn', 'dom_multiple_triggers', 'output',
        `${triggers.length} trigger entries in DOM ingredient — usually one is intended`);
    }
  }

  // DOM write entries (output value starts with "dom.") must each have a
  // matching input field — that's where the runtime reads the value it
  // writes into the selector.
  if (output) {
    const writeEntries = Object.entries(output)
      .filter(([, v]) => typeof v === 'string' && (v as string).startsWith('dom.') && v !== 'trigger')
      .map(([selector, v]) => ({ selector, field: (v as string).slice(4) }));

    for (const { selector, field } of writeEntries) {
      if (!field) {
        add('error', 'dom_write_field_empty', `output["${selector}"]`,
          `DOM write entry "${output[selector]}" is missing a field name after "dom."`);
        continue;
      }
      if (!hasOwn(input, field)) {
        add('error', 'dom_write_field_not_in_input', `output["${selector}"]`,
          `DOM write target "dom.${field}" requires a matching input key "${field}" so the recipe can supply the value`);
      }
    }

    // A DOM ingredient that writes anything should have action-category +
    // at least write risk_tier. Mixed/read-only categories are wrong.
    if (writeEntries.length > 0) {
      if (category !== 'action') {
        add('error', 'dom_write_wrong_category', 'category',
          `ingredient declares DOM write targets (dom.*) but category is "${category}" — must be "action"`);
      }
      const riskTier = m.risk_tier;
      if (riskTier === 'read') {
        add('error', 'dom_write_wrong_risk_tier', 'risk_tier',
          'ingredient declares DOM write targets but risk_tier is "read" — must be write/admin/destructive');
      }
    }
  }

  // NOTE: destructive-tier confirmation is NOT an ingredient-manifest concern.
  // `risk_tier === 'destructive'` is the only signal the engine needs — the
  // approval UI composes the confirmation text at call time from the live
  // ingredient name + resolved input values ("Delete deal 'Acme Q2'?"),
  // which is better than a static manifest string that can't reference
  // runtime context. The recipe runtime owns this UI concern, not the
  // ingredient author.
};

// ────────────────────────────────────────────────────────────────
// D-136 §A.4 — regen-policy validator (kind: 'ai' only)
// ────────────────────────────────────────────────────────────────

/** Validate the optional `regen_policy` block on an ingredient manifest.
 *
 *  Rules per D-136 §A.4:
 *    - `kind: 'ai'` manifests omitting the block fall back to the
 *      default tuple at producer-wrapper time. No issue raised.
 *    - Non-AI manifests (kind ≠ 'ai') declaring the block fail with
 *      `regen_policy_unsupported_kind` — the policy only governs AI
 *      calls.
 *    - Block present: every field is required and must match the
 *      closed-list shape (`input_invariants` / `determinism` /
 *      `dedup_key` / `regen_triggers`). Missing or unknown values
 *      raise per-field issues.
 *    - `dedup_key` is open-vocabulary string list; only shape is
 *      enforced (non-empty array of non-empty strings). Per-ingredient
 *      extras (`template_hash`, `style_hash`, `target_lang`, …) live
 *      here.
 *    - The `drift_significant` trigger gate (per audit §27.2 — only
 *      valid when downstream topic declares `temporal_class:
 *      'stable_truth'` AND `emits_confidence: true`) lives at
 *      producer-registration time, NOT here. The ingredient manifest
 *      doesn't know its consumer topic. */
const validateRegenPolicy = (m: Record<string, unknown>, add: AddFn): void => {
  const policy = m.regen_policy;
  const kind = m.kind;

  if (policy === undefined) return;

  if (kind !== 'ai') {
    add('error', 'regen_policy_unsupported_kind', 'regen_policy',
      `regen_policy is only valid on kind: 'ai' manifests; this manifest declares kind: ${JSON.stringify(kind)}`);
    return;
  }

  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    add('error', 'regen_policy_invalid_shape', 'regen_policy',
      'regen_policy must be an object with input_invariants / determinism / dedup_key / regen_triggers fields');
    return;
  }

  const p = policy as Record<string, unknown>;

  // input_invariants — non-empty array of closed-list values
  if (!Array.isArray(p.input_invariants)) {
    add('error', 'regen_policy_input_invariants_invalid', 'regen_policy.input_invariants',
      'regen_policy.input_invariants must be an array of strings');
  } else {
    if (p.input_invariants.length === 0) {
      add('error', 'regen_policy_input_invariants_empty', 'regen_policy.input_invariants',
        'regen_policy.input_invariants must list at least one invariant — typically ["pii_hash_salt"]');
    }
    for (const v of p.input_invariants) {
      if (typeof v !== 'string' || !REGEN_INPUT_INVARIANTS.includes(v as typeof REGEN_INPUT_INVARIANTS[number])) {
        add('error', 'regen_policy_input_invariant_unknown', 'regen_policy.input_invariants',
          `regen_policy.input_invariants entry ${JSON.stringify(v)} is not in the closed list: ${REGEN_INPUT_INVARIANTS.join(', ')}`);
      }
    }
  }

  // determinism — single closed-list value
  if (typeof p.determinism !== 'string' || !REGEN_DETERMINISMS.includes(p.determinism as typeof REGEN_DETERMINISMS[number])) {
    add('error', 'regen_policy_determinism_invalid', 'regen_policy.determinism',
      `regen_policy.determinism must be one of: ${REGEN_DETERMINISMS.join(', ')}`);
  }

  // dedup_key — non-empty open-vocabulary string array
  if (!Array.isArray(p.dedup_key)) {
    add('error', 'regen_policy_dedup_key_invalid', 'regen_policy.dedup_key',
      'regen_policy.dedup_key must be an array of strings');
  } else {
    if (p.dedup_key.length === 0) {
      add('error', 'regen_policy_dedup_key_empty', 'regen_policy.dedup_key',
        'regen_policy.dedup_key must list at least one hash slot — typically ["source_record_hash", "producer_version_hash"]');
    }
    for (const v of p.dedup_key) {
      if (typeof v !== 'string' || v.length === 0) {
        add('error', 'regen_policy_dedup_key_entry_invalid', 'regen_policy.dedup_key',
          'regen_policy.dedup_key entries must be non-empty strings');
      }
    }
  }

  // regen_triggers — non-empty array of closed-list values
  if (!Array.isArray(p.regen_triggers)) {
    add('error', 'regen_policy_regen_triggers_invalid', 'regen_policy.regen_triggers',
      'regen_policy.regen_triggers must be an array of strings');
  } else {
    if (p.regen_triggers.length === 0) {
      add('error', 'regen_policy_regen_triggers_empty', 'regen_policy.regen_triggers',
        'regen_policy.regen_triggers must list at least one trigger — typically ["source_change", "producer_change", "manual"]');
    }
    for (const v of p.regen_triggers) {
      if (typeof v !== 'string' || !REGEN_TRIGGERS.includes(v as typeof REGEN_TRIGGERS[number])) {
        add('error', 'regen_policy_regen_trigger_unknown', 'regen_policy.regen_triggers',
          `regen_policy.regen_triggers entry ${JSON.stringify(v)} is not in the closed list: ${REGEN_TRIGGERS.join(', ')}`);
      }
    }
  }
};

// ────────────────────────────────────────────────────────────────
// D-145 PB5 — AI-cooperative substrate validator gate (§ B.6.11)
// ────────────────────────────────────────────────────────────────

/** Risk-tiers that imply potential conflict / ambiguity at the action
 *  boundary. Combined with `category: 'action'` + adapter kind, these
 *  flag an ingredient as "action-with-conflict-potential" — the
 *  pattern that § B.6.11 names as needing an `ai_cooperative`
 *  declaration. `read` actions are by definition non-mutating + have
 *  no conflict surface. */
const AI_COOPERATIVE_RISK_TIERS = new Set<RiskTier>(['write', 'admin', 'destructive']);

/** Adapter kinds that talk to external state — typical sources of
 *  conflict / ambiguity (CRM writes, calendar bookings, MCP tool
 *  calls, named connections, long-running services, durable
 *  storage). `dom` / `chat` are excluded — DOM clicks + web-chat
 *  prompts don't return alternatives in the kernel-ingredient sense
 *  (web-chat is friendly-gesture only per § B.9 / D-145 PB9). `ai`
 *  ingredients are read-only inference per kind contract. */
const AI_COOPERATIVE_KINDS = new Set<IngredientKind>([
  'http',
  'mcp',
  'connection',
  'storage',
  'service',
]);

/** § B.6.11 — flag the manifest as action-with-conflict-potential
 *  when category + risk_tier + kind all match. PB5 ratchet test pins
 *  the predicate so future kind / risk-tier additions surface in the
 *  decisions log. */
const isActionWithConflictPotential = (m: Record<string, unknown>): boolean => {
  if (m.category !== 'action') return false;
  if (typeof m.risk_tier !== 'string') return false;
  if (!AI_COOPERATIVE_RISK_TIERS.has(m.risk_tier as RiskTier)) return false;
  if (typeof m.kind !== 'string') return false;
  return AI_COOPERATIVE_KINDS.has(m.kind as IngredientKind);
};

const validateAiCooperative = (m: Record<string, unknown>, add: AddFn): void => {
  const decl = m.ai_cooperative;
  const matches = isActionWithConflictPotential(m);

  if (decl === undefined) {
    if (matches) {
      // § B.6.11 — pattern matches but no declaration. PB5 surfaces
      // as warn (kernel catalog migration window); marketplace
      // promote-to-error after kernel ingredients declare uniformly.
      add(
        'warn',
        'ai_cooperative_declaration_missing',
        'ai_cooperative',
        "ingredient matches action-with-conflict-potential pattern but lacks 'ai_cooperative' declaration; declare " +
          "{ declares_alternatives: true, fixed_slots_honored: true } OR opt out with { declares_alternatives: false, opt_out_rationale: '<why>' }",
      );
    }
    return;
  }

  if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
    add(
      'error',
      'ai_cooperative_invalid_shape',
      'ai_cooperative',
      'ai_cooperative must be an object',
    );
    return;
  }
  const d = decl as Record<string, unknown>;
  const declares = d.declares_alternatives;
  const honored = d.fixed_slots_honored;
  const rationale = d.opt_out_rationale;

  if (typeof declares !== 'boolean') {
    add(
      'error',
      'ai_cooperative_declares_alternatives_required',
      'ai_cooperative.declares_alternatives',
      'ai_cooperative.declares_alternatives must be a boolean',
    );
    return;
  }

  if (declares === true) {
    if (honored !== true) {
      add(
        'error',
        'ai_cooperative_fixed_slots_not_honored',
        'ai_cooperative.fixed_slots_honored',
        "when declares_alternatives: true, fixed_slots_honored MUST be true (substrate-enforced runtime gate drops alternatives that drift; ingredient must respect fixed_slots per § B.6.5)",
      );
    }
    if (rationale !== undefined) {
      add(
        'error',
        'ai_cooperative_declaration_contradictory',
        'ai_cooperative.opt_out_rationale',
        "opt_out_rationale must be omitted when declares_alternatives: true",
      );
    }
    return;
  }

  // declares_alternatives === false → opt_out_rationale required.
  if (typeof rationale !== 'string') {
    add(
      'error',
      'ai_cooperative_opt_out_rationale_required',
      'ai_cooperative.opt_out_rationale',
      'when declares_alternatives: false, opt_out_rationale (string explaining why alternatives do not apply) is required',
    );
    return;
  }
  if (rationale.trim().length < AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS) {
    add(
      'error',
      'ai_cooperative_opt_out_rationale_required',
      'ai_cooperative.opt_out_rationale',
      `opt_out_rationale must be a meaningful explanation (≥ ${AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS} non-whitespace chars; rejects empty / placeholder)`,
    );
    return;
  }
  if (honored !== undefined) {
    add(
      'warn',
      'ai_cooperative_declaration_contradictory',
      'ai_cooperative.fixed_slots_honored',
      "fixed_slots_honored is meaningful only when declares_alternatives: true",
    );
  }
};

// ────────────────────────────────────────────────────────────────
// D-162 P2 — batch-mode manifest gate (§ A.6, I-6)
// ────────────────────────────────────────────────────────────────

/** D-162 — `ai-compare` is the one contracted `ai-*` slug excluded
 *  from batch mode (N.5): it is pairwise (`llm.data_a` / `llm.data_b`)
 *  with no single `llm.data` array to batch over. `llm.id_field` is
 *  the batch-mode switch — declaring it on the `ai-compare` manifest
 *  is a category error: the runtime prompt builder rejects an
 *  `ai-compare` call carrying `llm.id_field` outright (D-162 P0,
 *  `comparePrompt`), so a manifest that advertised the key would only
 *  lure a recipe author into an unsupported mode. Catch it at the
 *  manifest boundary.
 *
 *  The eight batch-capable slugs (`ai-classify` / -score / -extract /
 *  -summarize / -sentiment / -generate / -translate / -rewrite) DO
 *  declare `llm.id_field` — with a non-null default, since it is
 *  optional (single mode omits it). They need no allow-list change
 *  here: the `ai: []` per-kind input rule already admits any `llm.*`
 *  key. Only `ai-compare` is gated. */
const validateAiBatch = (m: Record<string, unknown>, add: AddFn): void => {
  if (m.slug !== 'ai-compare') return;
  const rawInput = own(m, 'input');
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return;
  if (hasOwn(rawInput as Record<string, unknown>, 'llm.id_field')) {
    add('error', 'ai_compare_id_field_forbidden', 'input.llm.id_field',
      'ai-compare does not support batch mode — it is pairwise (llm.data_a / llm.data_b) with no single llm.data array to batch over (D-162 N.5). Remove the llm.id_field input key.');
  }
};

// ────────────────────────────────────────────────────────────────
// Reference walkers
// ────────────────────────────────────────────────────────────────

/** Walk every string value in `node`, extract {{namespace.rest}} references,
 *  and invoke `onRef(namespace, path)` for each. */
const walkRefs = (
  node: unknown,
  path: string,
  onRef: (namespace: string, refPath: string) => void,
): void => {
  if (typeof node === 'string') {
    const re = /\{\{([a-z_]+)\.[^}]+\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(node)) !== null) {
      onRef(match[1], path);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkRefs(v, `${path}[${i}]`, onRef));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      walkRefs(v, `${path}.${k}`, onRef);
    }
  }
};

/** Walk {{vault.PUBLISHER.REST}} references specifically and report the publisher. */
const walkVaultRefs = (
  node: unknown,
  path: string,
  onVault: (publisher: string, refPath: string) => void,
): void => {
  if (typeof node === 'string') {
    const re = /\{\{vault\.([a-z0-9_-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(node)) !== null) {
      onVault(match[1], path);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkVaultRefs(v, `${path}[${i}]`, onVault));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      walkVaultRefs(v, `${path}.${k}`, onVault);
    }
  }
};

// ────────────────────────────────────────────────────────────────
// Convenience wrappers for callers that already have a typed manifest
// ────────────────────────────────────────────────────────────────

/** True if the manifest has no error-severity issues. */
export const isValidIngredient = (input: unknown): input is IngredientManifest =>
  validateIngredient(input).valid;

/** Throw on any error-severity issue. Useful in build/publish scripts. */
export const assertValidIngredient = (input: unknown): IngredientManifest => {
  const result = validateIngredient(input);
  if (!result.valid) {
    const errors = result.issues.filter((i) => i.severity === 'error');
    const first = errors[0];
    throw new Error(
      `Ingredient validation failed: [${first.code}] ${first.path} — ${first.message}` +
      (errors.length > 1 ? ` (+${errors.length - 1} more errors)` : ''),
    );
  }
  return input as IngredientManifest;
};

// ────────────────────────────────────────────────────────────────
// D-165 RUNTIME — OpenAPI document cross-check (pure; caller-fed document)
// ────────────────────────────────────────────────────────────────

/** Collapse a path template's parameter segments to a name-agnostic `{}`
 *  placeholder so equivalence is by position, not parameter name. Handles BOTH
 *  brace conventions in one pass because the two sides differ: a Recued REST
 *  `path_template` uses the engine's DOUBLE-brace ref syntax
 *  (`/crm/v3/objects/deals/{{deal_id}}`, resolved against args by the connection
 *  adapter), while an OpenAPI 3.x document path uses SINGLE-brace
 *  (`/crm/v3/objects/deals/{dealId}`) — both must collapse to the same
 *  `…/deals/{}`. The double-brace alternative is matched first so `{{x}}` is
 *  consumed whole rather than leaving stray braces. */
const normalizePathTemplate = (path: string): string =>
  path.replace(/\{\{[^{}]*\}\}|\{[^{}]*\}/g, '{}');

/** Unify brace STYLE while PRESERVING the parameter name: `{{ticket_id}}` and
 *  `{ticket_id}` both become `{ticket_id}`, a literal stays itself. Used only for
 *  the terminal-segment anchor in `wireIsInteriorExpansionOf`, where the fully
 *  normalized `{}` is too coarse — it makes `{id}` and `{sessionId}` fungible. */
const unifyBraceStyle = (segment: string): string =>
  segment.replace(/^\{\{(.+)\}\}$/, '{$1}');

/** D-192 CORE #8a — apply a surface `path_alias` to an ALREADY-NORMALIZED wire
 *  path, yielding the doc-relative normalized path the pinned OpenAPI document is
 *  expected to key on. Order: strip the wire gateway/proxy prefix → strip the
 *  format suffix → prepend the doc base. So zendesk `/tickets.json`
 *  `{doc_base:'/api/v2', strip_suffix:'.json'}` → `/api/v2/tickets`, and jira
 *  `/ex/jira/{}/rest/api/3/…` `{wire_prefix:'/ex/jira/{cloud_id}'}` → `/rest/api/3/…`.
 *  Prefix/base parts are normalized + trailing-slash-trimmed so brace or slash
 *  divergence never blocks the match. Pure; deterministic — a wrong alias yields
 *  a path the doc lacks and still fails the gate. */
const applyPathAlias = (
  normWirePath: string,
  alias: { wire_prefix?: unknown; doc_base?: unknown; strip_suffix?: unknown } | undefined,
): string => {
  if (!alias) return normWirePath;
  let p = normWirePath;
  if (typeof alias.wire_prefix === 'string' && alias.wire_prefix.length > 0) {
    const pfx = normalizePathTemplate(alias.wire_prefix).replace(/\/$/, '');
    // SEGMENT-BOUNDARY only: strip when `pfx` is the whole path or is followed
    // by `/`, so `/api/v1` never strips `/api/v1beta/…` (a false match).
    if (p === pfx) p = '/';
    else if (p.startsWith(`${pfx}/`)) p = p.slice(pfx.length);
  }
  // DOTTED extension only (`.json`) — never a bare substring like `s` that would
  // turn `/users` into `/user`. The shape gate rejects non-dotted suffixes too;
  // guarding here keeps the prover independently fail-closed.
  if (typeof alias.strip_suffix === 'string' && /^\.[^./]+$/.test(alias.strip_suffix)
    && p.endsWith(alias.strip_suffix)) {
    p = p.slice(0, -alias.strip_suffix.length);
  }
  if (typeof alias.doc_base === 'string' && alias.doc_base.length > 0) {
    const base = normalizePathTemplate(alias.doc_base).replace(/\/$/, '');
    p = base + (p.startsWith('/') ? p : `/${p}`);
  }
  return p;
};

/** D-192 CORE #8a — may a per-op `openapi_path` override prove the wire path
 *  against `doc`? The override exists for a wire that omits documented INTERIOR
 *  segments (azure-devops's optional `{team}` between `{project}` and `_apis`),
 *  so `doc` must expand `wire` at the INTERIOR ONLY: the first and last segments
 *  must be IDENTICAL, and every wire segment must be an in-order subsequence of
 *  `doc` (the omitted segments are inserted, never reordered). Anchoring both
 *  ends closes the two re-point classes a BARE subsequence permits — a
 *  front-prefix graft (`/tickets/{}` is a subsequence of `/evil/{}/tickets/{}`,
 *  whose PREFIX the wire lacks; that reconciliation is the surface `doc_base`
 *  alias's job, applied uniformly to every op) and a terminal swap (`/a/b` is a
 *  subsequence of `/a/b/{}`, a DIFFERENT resource). Both inputs are already
 *  brace-normalized (params are `{}`, so a wire `{}` matches any doc `{}`
 *  positionally — the literal segments are what must be preserved). Pure. */
const wireIsInteriorExpansionOf = (
  wire: string,
  doc: string,
  wireRaw: string,
  docRaw: string,
): boolean => {
  const w = wire.split('/');
  const d = doc.split('/');
  // Doc must be at least as long (an expansion only ADDS segments) and its ENDS
  // must match the wire's — only interior segments may be inserted (a differing
  // prefix belongs in the surface `doc_base` alias; a differing terminal segment
  // is a re-point at another resource, not the same op with segments omitted).
  if (w.length < 2 || d.length < w.length) return false;
  // TERMINAL ANCHOR on the RAW (un-normalized) segment, name preserved. Both `w`
  // and `d` are `{}`-normalized, which makes any param terminal match any other —
  // so `/users/{id}` would false-pass as an interior expansion of
  // `/users/{id}/sessions/{sessionId}` (a terminal APPEND onto a DIFFERENT
  // resource: both `{id}` and `{sessionId}` normalize to `{}`, defeating the
  // end-anchor). Comparing the raw terminals with only the brace style unified
  // keeps `{id}` ≠ `{sessionId}` while azure's literal `wiql` == `wiql` and a
  // genuine param-terminal insert keeps `{id}` == `{id}`.
  const wRaw = wireRaw.split('/');
  const dRaw = docRaw.split('/');
  if (unifyBraceStyle(wRaw[wRaw.length - 1]) !== unifyBraceStyle(dRaw[dRaw.length - 1])) {
    return false;
  }
  if (w[0] !== d[0] || w[1] !== d[1] || w[w.length - 1] !== d[d.length - 1]) return false;
  // In-order subsequence — every wire segment appears in `doc`, in order.
  let di = 0;
  for (const seg of w) {
    while (di < d.length && d[di] !== seg) di += 1;
    if (di >= d.length) return false;
    di += 1;
  }
  return true;
};

/** D-192 documentary proof — the wire path INSTANTIATES the documented one.
 *
 *  A vendor may document ONE templated route that its callers reach by
 *  substituting a constant. Zoho CRM documents `/{module}`,
 *  `/{module}/{recordID}`, `/{module}/upsert`; a pack that reads deals binds the
 *  literal `/Deals`, `/Deals/{deal_id}`, `/Deals/upsert`. Those ARE the
 *  documented operations — `Deals` is a value of `module`, not a different path
 *  — but no other relation here sees it: `normalizePathTemplate` collapses only
 *  BRACED segments, so a literal never meets a parameter, and
 *  {@link wireIsInteriorExpansionOf} requires the doc to be LONGER (an interior
 *  insertion) with matching ends. 98 shipped operations across two Zoho packs sat
 *  unprovable on exactly this.
 *
 *  The relation: same segment count, and at each index either the segments agree
 *  (brace style unified, so `{id}` == `{{id}}`) or the DOC segment is a parameter
 *  — which any non-empty wire segment may instantiate.
 *
 *  ⛔ OPT-IN, and that is the whole safety argument. It is reachable only through
 *  a per-op `openapi_path`, so an author must NAME the documented route they mean
 *  (`openapi_path: '/{module}'` against a wire `/Deals` is a true statement, and a
 *  reviewable one). Nothing changes for an op that declares no override: a bare
 *  literal path still has to appear in the document verbatim.
 *
 *  ⚠ It does NOT check that the substituted value is a REAL module. It cannot —
 *  the prover establishes `(method, path)` and nothing about values or fields
 *  (`api-pack-authoring-guide.md` §6), and a gate that looked like it verified
 *  more than it does would be worse than none. `/{module}` genuinely admits any
 *  segment; so does this.
 *
 *  ⚠ Direction matters: a doc PARAMETER admits a wire literal, never the reverse.
 *  A wire `/{module}` against a documented `/Deals` would be the pack claiming a
 *  breadth the document does not grant, and is refused. Pure. */
const wireInstantiatesDocParams = (wireRaw: string, docRaw: string): boolean => {
  const w = wireRaw.split('/');
  const d = docRaw.split('/');
  if (w.length !== d.length || w.length < 2) return false;
  const isParam = (seg: string): boolean => /^\{\{?.+\}?\}$/u.test(seg);
  let substituted = 0;
  for (let i = 0; i < w.length; i += 1) {
    if (unifyBraceStyle(w[i]!) === unifyBraceStyle(d[i]!)) continue;
    // Two params with DIFFERENT names are positionally equivalent — exactly what
    // `normalizePathTemplate` already grants every non-override op, so refusing
    // it here would make the override stricter than the default it relaxes
    // (`/Deals/{{deal_id}}` against `/{module}/{recordID}` is the real case).
    if (isParam(w[i]!) && isParam(d[i]!)) continue;
    // Otherwise only a doc PARAMETER may absorb a differing wire segment, and
    // only a non-empty one (an empty segment is a malformed path, not a value).
    if (!isParam(d[i]!) || w[i]!.length === 0) return false;
    substituted += 1;
  }
  // At least one substitution, else this adds nothing the equality path above
  // does not already cover — and an all-equal pair should never have reached a
  // relaxation in the first place.
  return substituted > 0;
};

/** D-192 documentary proof — verify an EXPLICIT composite-parameter expansion.
 *  This is deliberately stricter than a subsequence check: after replacing each
 *  named OpenAPI parameter with its declared ordered wire arguments, every path
 *  segment must match exactly. Literals can never be inserted, removed, or
 *  reordered; unmapped parameters remain positionally name-agnostic; mapped
 *  wire argument names must match exactly; every declaration must be consumed
 *  once. The declaration is proof-only and never changes the runtime URL. */
const wireMatchesExpandedOpenApiPath = (
  wireRaw: string,
  docRaw: string,
  expansions: unknown,
): boolean => {
  if (!isObjectRecord(expansions) || Object.keys(expansions).length === 0) return false;
  const mappedWireArgs = new Set<string>();
  const expected: Array<
    | { kind: 'literal'; value: string }
    | { kind: 'param_any' }
    | { kind: 'param_exact'; value: string }
  > = [];
  const usedDocParams = new Set<string>();
  for (const segment of docRaw.split('/')) {
    const parameter = /^\{([^{}]+)\}$/.exec(segment)?.[1];
    if (!parameter) {
      expected.push({ kind: 'literal', value: segment });
      continue;
    }
    const expansion = expansions[parameter];
    if (expansion === undefined) {
      expected.push({ kind: 'param_any' });
      continue;
    }
    if (usedDocParams.has(parameter) || !Array.isArray(expansion) || expansion.length < 2
      || expansion.some((arg) => typeof arg !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)
        || mappedWireArgs.has(arg))) return false;
    usedDocParams.add(parameter);
    for (const arg of expansion) {
      mappedWireArgs.add(arg);
      expected.push({ kind: 'param_exact', value: arg });
    }
  }
  if (usedDocParams.size !== Object.keys(expansions).length) return false;
  const wire = wireRaw.split('/');
  if (wire.length !== expected.length) return false;
  return expected.every((segment, index) => {
    const actual = wire[index] ?? '';
    if (segment.kind === 'literal') return actual === segment.value;
    const actualParam = /^\{\{([^{}]+)\}\}$/.exec(actual)?.[1]
      ?? /^\{([^{}]+)\}$/.exec(actual)?.[1];
    if (!actualParam) return false;
    return segment.kind === 'param_any' || actualParam === segment.value;
  });
};

/** OpenAPI 3.x path-item keys that denote an operation (everything else on a
 *  path item — `parameters`, `summary`, `$ref`, `servers`, … — is not a verb). */
const OPENAPI_PATH_METHODS = new Set<string>([
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace',
]);

/** D-165 RUNTIME — OpenAPI structural cross-check (spec § Marketplace
 *  validation: "For openapi_source: SHA-256 matches; every declared op exists
 *  in the document; method/path match").
 *
 *  PURE by design. The marketplace publish pipeline (a server-side, async
 *  concern — NOT this portable validator) fetches the document at
 *  `surfaces.api.openapi_source.url`, computes its SHA-256, matches it against
 *  the declared pin, parses the JSON, and passes the parsed object in here.
 *  This function does NO network IO and does NOT re-hash — it trusts the
 *  caller's pin match, the same contract as `verifyWebclientBundle`. Keeping
 *  the fetch + hash outside the validator is deliberate: the portable engine
 *  gains no IO/crypto substrate (D-165 RUNTIME "no new runtime substrate").
 *
 *  For every operation with a `rest` execution binding it verifies the
 *  binding's `(method, path_template)` resolves to a declared path + method in
 *  the document. Path params are normalized by position so parameter-name
 *  divergence is not a false mismatch. SKIPPED: GraphQL bindings (need a
 *  GraphQL schema + parser — deferred), and webhook / queue / push
 *  subscriptions (not REST document paths). Schema-shape diffing
 *  (request/response JSON Schema) is also deferred — this is the
 *  op-existence + method/path core.
 *
 *  Invoked two ways: directly, OR folded into `validateIngredient` when the
 *  caller passes `{ openapiDocument }` (so the publish path runs it as part of
 *  the one validation call, gated only on the document being supplied).
 *  Returns a `ValidationResult` (valid iff no error-severity `CATALOG_OPENAPI_*`
 *  issue). */
/** D-192 P2 — the ops named by work-entity Source declarations whose
 *  `contract_source.kind` matches, with their manifest paths for issue
 *  reporting.
 *
 *  A declaration with NO `contract_source` at all is EXCLUDED from every
 *  documentary prover (D-192 authority ladder, ratified 2026-07-14): it
 *  claims no document, so proving it against one would reject a legal
 *  Source. Its ops are proven EMPIRICALLY instead (ladder §6).
 *
 *  A declaration whose `contract_source` is PRESENT but MALFORMED still
 *  defaults to `'openapi'` (fail-closed: it CLAIMED a document, so it gets
 *  proven against the stricter default while the shape validator reports
 *  the kind error separately). A `graphql` declaration is EXCLUDED from
 *  both REST provers (D-192 Gate E′) — a graphql op has no `(method,
 *  path)`; its ops are proven against the pinned schema by
 *  `crossCheckGraphqlSchema` (worker-side) instead, so `declKind` maps to
 *  `'graphql'` and never equals either REST prover's `kind`. */
const collectSourceOpRefs = (
  manifest: Record<string, unknown>,
  kind: 'openapi' | 'google_discovery',
): Array<{ opKey: string; path: string }> => {
  const refs: Array<{ opKey: string; path: string }> = [];
  if (!Array.isArray(manifest.work_entity_sources)) return refs;
  manifest.work_entity_sources.forEach((decl, i) => {
    if (!isObjectRecord(decl) || !isObjectRecord(decl.ops)) return;
    // ABSENT-only: the Source claims no document ⇒ no documentary proof to
    // run. Concretely this is a pack whose OpenAPI covers tasks but not notes
    // — the pin is real and the note Source deliberately carries none; without
    // this it would be proven against the tasks doc and rejected at publish.
    if (decl.contract_source === undefined) return;
    const cs = isObjectRecord(decl.contract_source) ? decl.contract_source : undefined;
    const declKind = cs?.kind === 'google_discovery' ? 'google_discovery'
      : cs?.kind === 'graphql' ? 'graphql'
        : 'openapi';
    if (declKind !== kind) return;
    for (const [slot, opName] of Object.entries(decl.ops)) {
      if (typeof opName === 'string' && opName.length > 0) {
        refs.push({ opKey: opName, path: `work_entity_sources[${i}].ops.${slot}` });
      }
    }
  });
  return refs;
};

export const crossCheckCatalogOpenApi = (
  manifest: unknown,
  openapiDocument: unknown,
): ValidationResult => {
  const issues: ValidationIssue[] = [];
  const add = (severity: ValidationSeverity, code: string, path: string, message: string): void => {
    issues.push({ severity, code, path, message });
  };
  const done = (): ValidationResult => ({
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  });

  // A catalog with no api surface / no executes has nothing to cross-check.
  // The manifest reaching here has already passed `validateIngredient`; this
  // is a no-op for non-catalog or non-REST manifests, not a soundness gate.
  if (!isObjectRecord(manifest)) return done();

  // D-192 P1 — collect the ops named by work-entity Source declarations.
  // Unlike ordinary catalog ops (which are merely SKIPPED when not
  // REST-cross-checkable), a Source op MUST be provable against the pinned
  // document — an unprovable Source op corrupts sync/freshness/tombstone
  // trust, not just one call. Defense in depth with
  // `validateWorkEntitySources` (this function is also invoked standalone).
  // KIND-AWARE (D-192 P2): only declarations bound to the OPENAPI pin are
  // proven here — a `google_discovery` declaration's ops are proven by
  // `crossCheckCatalogGoogleDiscovery` against the Discovery pin instead.
  const sourceOpRefs = collectSourceOpRefs(manifest, 'openapi');

  const surfaces = manifest.surfaces;
  const api = isObjectRecord(surfaces) ? surfaces.api : undefined;
  if (!isObjectRecord(api) || !isObjectRecord(api.executes)) {
    for (const ref of sourceOpRefs) {
      add('error', 'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE', ref.path,
        `work-entity Source operation '${ref.opKey}' cannot be proven — the manifest declares no surfaces.api.executes to cross-check`);
    }
    return done();
  }

  // Collect the REST bindings — the only kind cross-checkable against OpenAPI.
  // Bindings with a malformed method/path are left to `validateIngredient`'s
  // shape gates so the cross-check does not double-report them.
  const restBindings: Array<{
    opKey: string;
    method: string;
    pathTemplate: string;
    rawMethod: string;
    openapiPath?: string;
    openapiPathParamExpansions?: unknown;
  }> = [];
  for (const [opKey, rawBinding] of Object.entries(api.executes)) {
    if (!isObjectRecord(rawBinding) || rawBinding.kind !== 'rest') continue;
    const rawMethod = typeof rawBinding.method === 'string' ? rawBinding.method : '';
    const pathTemplate = typeof rawBinding.path_template === 'string' ? rawBinding.path_template : '';
    if (!rawMethod || !pathTemplate) continue;
    // D-192 CORE #8a — per-op doc-path override (structural one-off the surface
    // `path_alias` can't express); proving-only, never changes the wire call.
    const openapiPath = typeof rawBinding.openapi_path === 'string' && rawBinding.openapi_path.length > 0
      ? rawBinding.openapi_path : undefined;
    const openapiPathParamExpansions = rawBinding.openapi_path_param_expansions;
    restBindings.push({
      opKey,
      method: rawMethod.toLowerCase(),
      pathTemplate,
      rawMethod,
      openapiPath,
      ...(openapiPathParamExpansions !== undefined ? { openapiPathParamExpansions } : {}),
    });
  }

  // D-192 P1 — every Source-declared op must be among the well-formed REST
  // bindings collected above; missing, non-REST (GraphQL/webhook/queue/push),
  // or malformed bindings are all unprovable → fail closed for Source ops.
  const restBoundOpKeys = new Set(restBindings.map((b) => b.opKey));
  for (const ref of sourceOpRefs) {
    if (!restBoundOpKeys.has(ref.opKey)) {
      add('error', 'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE', ref.path,
        `work-entity Source operation '${ref.opKey}' has no provable REST execution binding (missing, non-REST, or malformed) — a Source op must be provable against the pinned OpenAPI document`);
    }
  }

  if (restBindings.length === 0) return done();

  // The document's path table normalized to `Map<normalizedPath, Set<method>>`.
  const docPaths = isObjectRecord(openapiDocument) ? openapiDocument.paths : undefined;
  if (!isObjectRecord(docPaths)) {
    add('error', 'CATALOG_OPENAPI_DOC_INVALID', 'surfaces.api.openapi_source',
      'OpenAPI document has no `paths` object to cross-check the declared REST operations against');
    return done();
  }
  const methodsByPath = new Map<string, Set<string>>();
  for (const [docPath, pathItem] of Object.entries(docPaths)) {
    if (!isObjectRecord(pathItem)) continue;
    const norm = normalizePathTemplate(docPath);
    let methods = methodsByPath.get(norm);
    if (!methods) { methods = new Set<string>(); methodsByPath.set(norm, methods); }
    for (const key of Object.keys(pathItem)) {
      const lower = key.toLowerCase();
      if (OPENAPI_PATH_METHODS.has(lower)) methods.add(lower);
    }
  }

  // D-192 P2 (Codex fold F1) — ops CLAIMED by a google_discovery-kind
  // Source declaration prove against the DISCOVERY pin
  // (`crossCheckCatalogGoogleDiscovery`), not the OpenAPI document: a
  // mixed catalog (an OpenAPI pin for its ordinary ops + a Discovery
  // pin for a Google Source) must not fail the generic all-bindings
  // loop on paths the OpenAPI document was never meant to carry.
  const discoveryClaimedOps = new Set(
    collectSourceOpRefs(manifest, 'google_discovery').map((r) => r.opKey),
  );

  // D-192 CORE #8a — the surface `path_alias` reconciles wire↔doc path
  // divergence (proxy prefix / base-split / format suffix) across ALL ops; a
  // per-op `openapi_path` overrides it for a structural one-off; an optional
  // `openapi_path_param_expansions` map can prove one documented composite path
  // parameter as an exact ordered run of wire params. Proving-only — neither
  // declaration changes the runtime call.
  const openapiSource = isObjectRecord(api.openapi_source) ? api.openapi_source : undefined;
  const pathAlias = openapiSource && isObjectRecord(openapiSource.path_alias)
    ? openapiSource.path_alias : undefined;

  for (const b of restBindings) {
    if (discoveryClaimedOps.has(b.opKey)) continue;
    const bPath = `surfaces.api.executes.${b.opKey}`;
    const normWire = normalizePathTemplate(b.pathTemplate);
    let docRel: string;
    if (b.openapiPath !== undefined) {
      docRel = normalizePathTemplate(b.openapiPath);
      // The override may only INSERT documented INTERIOR segments the wire omits
      // (ends anchored) — never graft a prefix (that is the surface `doc_base`
      // alias's job) or re-point the op at an unrelated doc path (§0.5 rigor: no
      // false pass).
      const preservesWire = b.openapiPathParamExpansions !== undefined
        ? wireMatchesExpandedOpenApiPath(
            b.pathTemplate,
            b.openapiPath,
            b.openapiPathParamExpansions,
          )
        // Two admissible relations, tried in order. The wire may OMIT documented
        // interior segments, or it may INSTANTIATE documented parameters with
        // constants (Zoho's `/{module}` reached as `/Deals`). Both are the same
        // operation described at different levels of abstraction; neither lets an
        // op re-point at an unrelated path.
        : wireIsInteriorExpansionOf(normWire, docRel, b.pathTemplate, b.openapiPath)
          || wireInstantiatesDocParams(b.pathTemplate, b.openapiPath);
      if (!preservesWire) {
        add('error', 'CATALOG_OPENAPI_MISMATCH', bPath,
          b.openapiPathParamExpansions !== undefined
            ? `operation '${b.opKey}' openapi_path '${b.openapiPath}' and openapi_path_param_expansions do not expand exactly to the wire path '${b.pathTemplate}'`
            : `operation '${b.opKey}' openapi_path '${b.openapiPath}' does not preserve the wire path '${b.pathTemplate}' — a per-op override may INSERT documented INTERIOR segments the wire omits (ends anchored), or INSTANTIATE a documented parameter with a wire literal at the same segment index, but may not re-point at an unrelated path (a differing prefix belongs in the surface doc_base alias)`);
        continue;
      }
    } else {
      docRel = applyPathAlias(normWire, pathAlias);
    }
    // Name the reconciled doc path in the error only when it differs, so the
    // common (no-alias) message is unchanged.
    const provedAs = docRel === normWire ? '' : ` (proved as '${docRel}')`;
    const methods = methodsByPath.get(docRel);
    if (!methods) {
      add('error', 'CATALOG_OPENAPI_MISMATCH', bPath,
        `operation '${b.opKey}' REST binding path '${b.pathTemplate}'${provedAs} has no matching path in the pinned OpenAPI document`);
    } else if (!methods.has(b.method)) {
      add('error', 'CATALOG_OPENAPI_MISMATCH', bPath,
        `operation '${b.opKey}' REST binding method ${b.rawMethod} is not defined on path '${b.pathTemplate}'${provedAs} in the pinned OpenAPI document`);
    }
  }

  return done();
};

/** D-192 P2 — Google Discovery structural cross-check (owner decision
 *  2026-07-01, resolving the P1b Google-Discovery fork: Google
 *  publishes `discovery#restDescription` documents, not OpenAPI — an
 *  equally official, equally provable contract format, so it gets its
 *  own prover instead of an exclusion).
 *
 *  PURE, same contract as `crossCheckCatalogOpenApi`: the marketplace
 *  publish pipeline fetches the document at
 *  `surfaces.api.google_discovery_source.url`, hash-verifies it against
 *  the declared pin, parses it, and passes it here — no IO, no
 *  re-hash.
 *
 *  SCOPE: proves ONLY the ops named by `work_entity_sources`
 *  declarations with `contract_source.kind: 'google_discovery'`
 *  (fail-closed — a Source op that cannot be proven corrupts
 *  sync/freshness/tombstone trust). Ordinary catalog ops are NOT
 *  checked against the Discovery pin: a catalog may pin BOTH an
 *  OpenAPI and a Discovery document, and holding every REST binding to
 *  both would false-fail whichever document does not carry it.
 *
 *  Path table: Discovery methods live in a RECURSIVE `resources` tree
 *  (`resources.<name>.methods.<name>` + nested `resources`), each
 *  method carrying `httpMethod` + a `path` RELATIVE to the document's
 *  `servicePath` (plus an optional pre-flattened `flatPath` — both are
 *  admitted). Params use the same `{param}` syntax as OpenAPI, so the
 *  positional normalization is shared. */
export const crossCheckCatalogGoogleDiscovery = (
  manifest: unknown,
  discoveryDocument: unknown,
): ValidationResult => {
  const issues: ValidationIssue[] = [];
  const add = (severity: ValidationSeverity, code: string, path: string, message: string): void => {
    issues.push({ severity, code, path, message });
  };
  const done = (): ValidationResult => ({
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  });

  if (!isObjectRecord(manifest)) return done();
  const sourceOpRefs = collectSourceOpRefs(manifest, 'google_discovery');
  if (sourceOpRefs.length === 0) return done();

  const surfaces = manifest.surfaces;
  const api = isObjectRecord(surfaces) ? surfaces.api : undefined;
  const executes = isObjectRecord(api) && isObjectRecord(api.executes) ? api.executes : undefined;
  if (executes === undefined) {
    for (const ref of sourceOpRefs) {
      add('error', 'CATALOG_DISCOVERY_SOURCE_OP_UNPROVABLE', ref.path,
        `work-entity Source operation '${ref.opKey}' cannot be proven — the manifest declares no surfaces.api.executes to cross-check`);
    }
    return done();
  }

  if (!isObjectRecord(discoveryDocument) || discoveryDocument.kind !== 'discovery#restDescription') {
    add('error', 'CATALOG_DISCOVERY_DOC_INVALID', 'surfaces.api.google_discovery_source',
      "pinned document is not a Google Discovery document (`kind: 'discovery#restDescription'`)");
    return done();
  }

  // Build `Map<normalizedPath, Set<method>>` from the recursive
  // resources tree. `servicePath` may be '' (Tasks) or 'calendar/v3/'
  // (Calendar) — the binding's `path_template` is absolute, so each
  // relative method path is rooted as `/<servicePath><path>`.
  const servicePath = typeof discoveryDocument.servicePath === 'string'
    ? discoveryDocument.servicePath
    : '';
  const methodsByPath = new Map<string, Set<string>>();
  const admit = (relPath: unknown, httpMethod: unknown): void => {
    if (typeof relPath !== 'string' || relPath.length === 0) return;
    if (typeof httpMethod !== 'string' || httpMethod.length === 0) return;
    const full = `/${servicePath}${relPath}`.replace(/\/{2,}/g, '/');
    const norm = normalizePathTemplate(full);
    let methods = methodsByPath.get(norm);
    if (!methods) { methods = new Set<string>(); methodsByPath.set(norm, methods); }
    methods.add(httpMethod.toLowerCase());
  };
  const walkResources = (resources: unknown, depth: number): void => {
    if (!isObjectRecord(resources) || depth > 8) return;
    for (const resource of Object.values(resources)) {
      if (!isObjectRecord(resource)) continue;
      if (isObjectRecord(resource.methods)) {
        for (const method of Object.values(resource.methods)) {
          if (!isObjectRecord(method)) continue;
          admit(method.path, method.httpMethod);
          admit(method.flatPath, method.httpMethod);
        }
      }
      walkResources(resource.resources, depth + 1);
    }
  };
  walkResources(discoveryDocument.resources, 0);
  if (methodsByPath.size === 0) {
    add('error', 'CATALOG_DISCOVERY_DOC_INVALID', 'surfaces.api.google_discovery_source',
      'Google Discovery document carries no resource methods to cross-check the declared operations against');
    return done();
  }

  for (const ref of sourceOpRefs) {
    const binding = executes[ref.opKey];
    if (!isObjectRecord(binding) || binding.kind !== 'rest'
        || typeof binding.method !== 'string' || binding.method.length === 0
        || typeof binding.path_template !== 'string' || binding.path_template.length === 0) {
      add('error', 'CATALOG_DISCOVERY_SOURCE_OP_UNPROVABLE', ref.path,
        `work-entity Source operation '${ref.opKey}' has no provable REST execution binding (missing, non-REST, or malformed) — a Source op must be provable against the pinned Discovery document`);
      continue;
    }
    const methods = methodsByPath.get(normalizePathTemplate(binding.path_template));
    if (!methods) {
      add('error', 'CATALOG_DISCOVERY_MISMATCH', ref.path,
        `operation '${ref.opKey}' REST binding path '${binding.path_template}' has no matching method path in the pinned Discovery document`);
    } else if (!methods.has(binding.method.toLowerCase())) {
      add('error', 'CATALOG_DISCOVERY_MISMATCH', ref.path,
        `operation '${ref.opKey}' REST binding method ${binding.method} is not defined for path '${binding.path_template}' in the pinned Discovery document`);
    }
  }

  return done();
};

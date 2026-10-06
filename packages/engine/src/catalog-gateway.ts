/** D-165 P0 — catalog-form gateway routing (engine side).
 *
 *  When a recipe step targets a *catalog-form* ingredient (its manifest
 *  carries a non-empty `operations` map), the engine routes the call
 *  through this module instead of the plain adapter path. The flow:
 *
 *    1. Read `{ operation, args, connection }` off the step input.
 *    2. Resolve the LOCAL-ONLY per-connection operation profile via
 *       `ctx.connectionProfileResolver`.
 *    3. `resolveCatalogOperationPolicy` → effective (catalog-derived) risk
 *       + grant + approval verdict (Invariant 1).
 *    4. `deny`  → emit a failed gateway audit row, throw (step fails).
 *       `ask`   → throw `PreflightRequiredSignal`; the engine's step loop
 *                 catches it, snapshots `step.*`, and ends the run with
 *                 `awaiting_approval` (D-157 Flow 2 — pause/checkpoint/ask).
 *                 On resume the gated step carries
 *                 `stepMeta.preflight_admitted` and falls through to
 *                 execute (the approval the user just granted).
 *       `admit` → execute via DIRECT surface dispatch: translate the
 *                 operation's API surface binding
 *                 (`surfaces.api.executes[operation_id]`) into connection-api
 *                 wire params and dispatch the catalog ingredient under its
 *                 OWN slug, then emit a success/failed audit row.
 *
 *  D-165 RUNTIME — direct surface dispatch supersedes the P1 `delegates_to`
 *  wrapper-delegation seed. The gateway no longer borrows a pre-existing
 *  simple-form wrapper to carry the wire details; it builds the connection-api
 *  call straight from the operation's declared REST binding (method + path +
 *  static query/headers) and the caller's `args`, then dispatches the catalog
 *  ingredient (`kind: 'connection'`) so the connection adapter does the real
 *  IO. The executor routes by the ingredient's kind WITHOUT re-entering this
 *  catalog branch (catalog-form detection lives in `runStep`, upstream of
 *  `ctx.ingredientExecutor`) — no double-gate, no wrapper hop. The binding
 *  owns the method/path/connection triple (Invariant 4): caller `args` supply
 *  only the per-call payload + path params and cannot redirect the call.
 *
 *  The audit row (Invariant 5) is emitted on every attempt — gate deny, a
 *  missing/unsupported binding, execution success, and execution failure —
 *  but NOT on an `ask` pause (no call has happened yet; it audits when it
 *  actually runs after resume).
 *
 *  Spec: D-165 § Runtime flow / Invariants 1 + 4 + 5.
 */

import {
  BATCH_ARGS_PREVIEW_MAX_BYTES,
  CHUNKED_UPLOAD_WIRE_PREFIX,
  CHUNKED_UPLOAD_WIRE_WALK_KEY,
  HTTP_UPLOAD_WIRE_FIELD_KEY,
  HTTP_AUTH_BODY_FIELDS_WIRE_KEY,
  HTTP_UPLOAD_WIRE_KIND_KEY,
  HTTP_UPLOAD_WIRE_MAX_BYTES_KEY,
  D165_CONTRACT_SCHEMA,
  PAGINATION_MAX_PAGES,
  PAGINATION_MAX_RECORDS,
  RECORDS_MAX_PAGE_SIZE,
  RECORDS_MAX_SEARCH_ROWS,
  PreflightRequiredSignal,
  SESSION_GRANT_RISK_TIERS,
  canonicalArgHash,
  checkPathScope,
  closedRequestSchemaViolation,
  deriveOriginUnit,
  collectOperationAuthorityPaths,
  operationPathTemplate,
  composeForRole,
  extractScopedDestinationEmails,
  isLockedInputKey,
  isPaginationStyle,
  isPreflightRequiredSignal,
  mergeRoleResults,
  cliPrincipalFromExecutionSource,
  projectResolvedArgs,
  projectToResolution,
  readOwnerOperationOverride,
  standingClosureAdmits,
  operationSpecHash,
  PlatformRecordIdError,
  QualifiedWorkEntityIdError,
  routePlatformRecordOperationArgs,
  resolveCatalogOperationPolicy,
  resolveCliReachabilityPolicy,
  resolveTrustCeiling,
  routeQualifiedWorkEntityOperationArgs,
  CONTRACTED_DEFAULT_TRUST_CEILING,
  isRecordsExecutionBinding,
  recordsPrincipalFromExecutionSource,
} from '@recued/contracts';
// D-217 § 9.8 — the walk's plan lives in `@recued/ingredients` (the sequencer
// that drives it is the connection adapter). engine → ingredients is the
// allowed direction of the project graph; the engine reaches in only for
// `planChunkedUpload`, to size the act before it dispatches.
import { planChunkedUpload } from '@recued/ingredients';
import {
  assertNestedRunCompleted,
  assertNoRecipeCycle,
  extendHeldRecipes,
} from './local-recipe-cycle.js';
import { throwIfRunKilled } from './lane.js';
import type {
  ApiExecutionBinding,
  ApiExecutionBindingKind,
  ArgHashes,
  ChunkedUploadWalkInput,
  CatalogOperationResolution,
  CliMethodBinding,
  DispatchRole,
  GatewayCallAudit,
  GraphQLExecutionBinding,
  McpExecutionBinding,
  IngredientManifest,
  OpenProjectionComputation,
  OperationPaginationSpec,
  OperationRiskTier,
  OwnerOverridePolicy,
  PaginationStyle,
  PathScopeCheck,
  PreflightApprovedTarget,
  PreflightOverrideOffer,
  ProviderApiSurface,
  ResolutionContext,
  RestExecutionBinding,
  RiskTier,
  RecordsExecutionBinding,
  RoleComposition,
  StepMeta,
  StepOptions,
  RecipeErrorCode,
} from '@recued/contracts';
import type {
  ExecutionContext,
  PreparedOperationBoundWebhookDispatch,
} from './types.js';

/** The catalog-form call shape lifted off a resolved step input. */
interface CatalogCall {
  operation_id: string;
  /** Connection record name the operation dispatches against. */
  connection_name: string;
  /** Transport kind for audit `surface_kind`, when the input declares it
   *  (`connection_kind`). Best-effort — undefined when not present. */
  surface_kind?: string;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** D-177/D-211 catalog-gate loop — true for the tiers a session grant may
 *  absorb an `ask` for: read / write / admin. `destructive` never grants.
 *  Approval provenance separately rejects every `always`. Pre-gates lookup so a
 *  non-grantable catalog op never consults grants. */
const isSessionGrantableTier = (tier: string): boolean =>
  (SESSION_GRANT_RISK_TIERS as readonly string[]).includes(tier);

/** Coerce a value to a plain object, else `{}` — used to read the catalog
 *  call's `args` (the per-call connection-api wire payload the gateway folds
 *  into the surface dispatch input). */
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Lift the catalog-form call off the step input + the caller-resolved
 *  connection name. `connectionName` is resolved by the engine (the
 *  step-level `connection` field — a `{{ref}}` — resolved against the
 *  stores; see `runIngredient`), NOT read raw from `input` here. The
 *  `operation` key is read raw and STATIC-ONLY in P0: a `{{ref}}`-shaped
 *  operation won't match any declared key and fails closed
 *  (`operation_not_declared`). Dynamic operation selection — and the
 *  resume-binding it would require (Inv-2 hardening) — is P1+. */
const extractCatalogCall = (
  input: Record<string, unknown>,
  connectionName: string,
): CatalogCall => ({
  operation_id: asString(input.operation),
  connection_name: connectionName,
});

const surfaceKindForOperation = (
  manifest: IngredientManifest,
  operationKey: string,
): string | undefined => {
  if (manifest.surfaces?.api?.executes?.[operationKey] !== undefined) return 'api';
  if (manifest.surfaces?.connector?.executes?.[operationKey] !== undefined) return 'connector';
  if (manifest.surfaces?.records?.executes?.[operationKey] !== undefined) return 'records';
  return undefined;
};

/** True iff the op's api binding produces a synchronous HTTP dispatch
 *  (`execInput`). Delegates to the transport protocol registry
 *  (`protocolExecutorFor(...).producesDispatch`) — the SAME source the
 *  dispatch-time `execInput` computation below resolves through — so the
 *  authorization-kind discriminator and the dispatch-kind discriminator can
 *  never disagree (a `rest` binding, or a non-`subscription` `graphql` binding;
 *  a realtime subscription kind has no executor → false). */
const apiBindingProducesDispatch = (
  manifest: IngredientManifest,
  operationKey: string,
): boolean => {
  const binding = manifest.surfaces?.api?.executes?.[operationKey];
  const ex = protocolExecutorFor(binding);
  return ex !== undefined && binding !== undefined && ex.producesDispatch(binding);
};

/** D-182 §6/§7 — the gateway's per-kind discriminator. A catalog op is a `cli`
 *  op iff its connector binding is `cli_invocation` (the decomposer lowers a
 *  `kind: 'cli'` ingredient to a connector surface with `cli_invocation`
 *  bindings + `wire_protocol: 'cli_invocation'`; the manifest's top-level
 *  `kind` is always `connection` for a catalog-form ingredient, so the BINDING
 *  is the real discriminator). A `cli` op authorizes via a per-contract
 *  reachability allowlist, never a connection profile (§7.2).
 *
 *  The discriminator ALIGNS with the dispatch precedence (codex HIGH): dispatch
 *  prefers a dispatchable api binding (rest / non-subscription graphql) and only
 *  falls to the cli binding when none exists (`execInput === undefined &&
 *  connectorBinding.kind === 'cli_invocation'`). So an op carrying BOTH a
 *  dispatchable api binding AND a `cli_invocation` connector binding (not a
 *  decomposer output — surfaces are mutually exclusive there — but a possible
 *  hand-authored / malformed manifest) dispatches via the api/connection path;
 *  authorizing it via cli reachability would bypass the connection profile.
 *  Requiring `!apiBindingProducesDispatch` keeps the two in lockstep, so the
 *  worst case fails SAFE — treated as http/connection (profile-authorized,
 *  api-dispatched). cli reachability governs ONLY genuinely cli-dispatched
 *  ops. */
const isCliInvocationOp = (
  manifest: IngredientManifest,
  operationKey: string,
): boolean =>
  manifest.surfaces?.connector?.executes?.[operationKey]?.kind === 'cli_invocation'
  && !apiBindingProducesDispatch(manifest, operationKey);

/** Host-facing settlement classification for an already-resolved catalog op.
 * This deliberately reuses dispatch precedence: a malformed dual-surface op
 * that actually takes API dispatch cannot be mislabeled as detached merely
 * because it also carries a CLI binding. `operationId` may be either the
 * authored map key or its fully-qualified `OperationSpec.operation_id`. */
export const catalogOperationUsesDetachedCli = (
  manifest: IngredientManifest,
  operationId: string,
): boolean => {
  const operationKey = Object.entries(manifest.operations ?? {}).find(
    ([key, spec]) => key === operationId || spec.operation_id === operationId,
  )?.[0];
  if (operationKey === undefined || !isCliInvocationOp(manifest, operationKey)) {
    return false;
  }
  const binding = manifest.surfaces?.connector?.executes?.[operationKey];
  return binding?.kind === 'cli_invocation' && binding.detached !== undefined;
};

/** Best-effort gateway audit emission. Swallows sink exceptions — audit
 *  back-pressure must never break a recipe run (Invariant 5 is durable,
 *  but a thrown sink is the sink's bug, not the run's). */
const emitGatewayAudit = (
  ctx: ExecutionContext,
  event: GatewayCallAudit,
): void => {
  if (!ctx.onGatewayCall) return;
  try {
    ctx.onGatewayCall(event);
  } catch {
    /* audit-sink failures never break dispatch */
  }
};

/** D-182 §10 step 7 — the call's `canonical_arg_hash` for the audit (the D-177
 *  `canonical_payload_hash` over the resolved op args, the op's
 *  `hash_exclude_args` removed so it matches the grant-gate basis). Fail-OPEN:
 *  `canonicalArgHash` is fail-CLOSED for grants (it THROWS on a non-JSON-clean
 *  payload so no grant mints off an ambiguous hash), but an AUDIT field must
 *  never break dispatch — a non-hashable payload simply audits without the hash.
 *  Computed once eagerly (it is wanted on every outcome incl. the early deny,
 *  which fires before the lazy grant-hash path), so it pays one SHA-256 per
 *  gateway call — negligible against the call's own network IO. */
const auditCanonicalArgHash = (
  args: Record<string, unknown>,
  excludePaths: readonly string[] | undefined,
): string | undefined => {
  try {
    return canonicalArgHash(
      projectResolvedArgs(args),
      excludePaths ? { excludePaths } : {},
    ).canonical_payload_hash;
  } catch {
    return undefined;
  }
};

/** D-182 §6/§10 step 7 — the op-level audit identity fields derived from the
 *  execution context: the `execution_source` (carried verbatim) and the
 *  channel-resolved `origin_unit_id` (`deriveOriginUnit` — chat turn / mcp burst
 *  / fire / run). BOTH or NEITHER: the origin unit is meaningless without the
 *  source. Empty (`{}`) on a dispatch path that wires no source (dbless tests,
 *  legacy direct rpc) — the audit row then carries only the recipe/step ids it
 *  always did, so the recipe-origin path is byte-for-byte unchanged. */
const auditSourceFields = (
  ctx: ExecutionContext,
): Pick<GatewayCallAudit, 'execution_source' | 'origin_unit_id'> => {
  const source = ctx.execution_source;
  if (source === undefined) return {};
  // `deriveOriginUnit` keys some channels DIRECTLY off `run_id` / `correlation_id`
  // (mcp → the correlation id verbatim), so a source-bearing ctx that wired no
  // correlation id would derive `origin_unit_id: ''`. Today `handleExecute`
  // assigns the correlation id before building a source-bearing ctx, so this can't
  // fire — but a future caller threading `execution_source` without it must not
  // persist a meaningless empty grouping id (codex LOW). Omit when degenerate;
  // `execution_source` (the attribution) still stamps either way.
  const originUnitId = deriveOriginUnit(source, {
    run_id: ctx.run_id ?? '',
    correlation_id: ctx.correlation_id ?? '',
  }).id;
  return {
    execution_source: source,
    ...(originUnitId.length > 0 ? { origin_unit_id: originUnitId } : {}),
  };
};

/** Shared audit-row builder — fills the policy-derived fields common to
 *  every outcome from the resolution + call context. `canonicalArgHash` (D-182
 *  §10 step 7) is the call's payload identity, precomputed once at function
 *  entry (it is needed on every outcome, including the early deny that fires
 *  before the lazy grant-hash path) and threaded in; `undefined` when the
 *  payload was not JSON-clean (the audit never recomputes / never throws). */
const auditBase = (
  slug: string,
  call: CatalogCall,
  resolution: CatalogOperationResolution,
  ctx: ExecutionContext,
  stepMeta: StepMeta | undefined,
  canonicalArgHashHex: string | undefined,
): Omit<GatewayCallAudit, 'outcome'> => ({
  ingredient_id: slug,
  operation_id: resolution.operation_id,
  operation_group: resolution.operation_group,
  connection_name: call.connection_name,
  risk_tier: resolution.effective_risk_tier,
  approval: resolution.approval,
  // D-211 §2 — surface the fail-closed clamp of a hand-stored below-floor
  // owner-override approval on the durable audit row.
  ...(resolution.approval_clamped_from !== undefined
    ? { approval_clamped_from: resolution.approval_clamped_from }
    : {}),
  ...(call.surface_kind ? { surface_kind: call.surface_kind } : {}),
  ...(ctx.recipe?.recipe_id ? { recipe_id: ctx.recipe.recipe_id } : {}),
  ...(stepMeta?.step_id ? { step_id: stepMeta.step_id } : {}),
  ...auditSourceFields(ctx),
  ...(canonicalArgHashHex !== undefined ? { canonical_arg_hash: canonicalArgHashHex } : {}),
});

/** Thrown on a gate denial. A plain `Error` — the step-runner's catch
 *  records it as a `NETWORK_ERROR` `RecipeError` and halts the run; the
 *  structured deny reason rides on the gateway audit row, not the message. */
const denyError = (call: CatalogCall, resolution: CatalogOperationResolution): Error =>
  new Error(
    `D-165 gateway: operation '${resolution.operation_id}' on connection `
      + `'${call.connection_name}' denied (${resolution.deny_reason}).`,
  );

/** Thrown when a catalog operation's `path_scope` rejects the call's resolved
 *  target (D-165 P3.path-picker, Slice 3b). Like `denyError` it is a plain
 *  `Error` — the structured reason + both canonical paths ride the gateway
 *  audit row's `path_scope` detail, not the message. The message names the
 *  target (or `(unresolved)` when a template token had no arg), the connection
 *  scope, and the `checkPathScope` reason for log readability. */
const pathScopeError = (
  call: CatalogCall,
  resolution: CatalogOperationResolution,
  ps: PathScopeCheck,
): Error =>
  new Error(
    `D-165 gateway: operation '${resolution.operation_id}' target `
      + `'${ps.target_path ?? '(unresolved)'}' is outside connection `
      + `'${call.connection_name}' scope '${ps.connection_path}' `
      + `(${ps.reason ?? 'path_scope_violation'}).`,
  );

/** D-165 follow-on (op-identity binding) — true when the resume-approved
 *  target matches the re-resolved catalog call. A catalog admit-on-resume
 *  requires the FULL triple to match; an absent target (legacy / bare pause)
 *  or any drift (a `{{config.*}}` connection that changed while paused, or a
 *  re-authored operation literal at the same step id) returns false so the
 *  gate re-asks for the current call instead of honoring the stale approval. */
const catalogTargetMatches = (
  target: PreflightApprovedTarget | undefined,
  ingredient_slug: string,
  operation_id: string,
  connection_name: string,
): boolean =>
  target !== undefined
  && target.ingredient_slug === ingredient_slug
  && target.operation_id === operation_id
  && target.connection_name === connection_name;

/** Keys that would pollute the dispatched-input object's prototype if copied
 *  verbatim. Belt-and-suspenders with the null-proto base below + the
 *  connection adapter's own prototype filter (Codex review LOW). */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Translate a resolved REST surface binding + the caller's `args` into the
 *  connection-api wire params the connection adapter consumes. The binding
 *  owns the protected `method` / `path` / `connection_kind` / `connection`
 *  keys — applied LAST so caller `args` can extend the payload but never
 *  override the call target (Invariant 4). `static_query` / `static_headers`
 *  fold to `query.<k>` / `header.<k>` and are authoritative (they win over a
 *  same-named caller key) — EXCEPT a `merge_query` key, whose static list is
 *  UNIONED with the caller's `query.<k>` (D-182 CRM Tier-P, so a vendor-raw read
 *  can request extra fields). caller `args` (already in connection-api wire-key
 *  form: `body.properties`, the `{{deal_id}}` path-param value, …) carry the
 *  per-call payload. `connection` is omitted when unresolved so the adapter's
 *  own NOT_BOUND path surfaces the missing-connection error. */
/** Union two comma-separated lists — `base` (static defaults) first, then each
 *  `extra` entry not already present (case-sensitive, vendor field names are
 *  exact). Blank entries are dropped; the result has no duplicates and no empty
 *  segments. */
const unionCsv = (base: string, extra: string): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of `${base},${extra}`.split(',')) {
    const t = part.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(',');
};

const buildApiDispatchInput = (
  binding: RestExecutionBinding,
  args: Record<string, unknown>,
  connectionName: string,
): Record<string, unknown> => {
  // Null-proto base so a `__proto__` arg key (below) lands as an own property,
  // never the prototype, even before the executor's own filter runs.
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // Recipe `args`, minus prototype-sensitive keys and engine-locked keys
  // (method / url / header.host / header.authorization / header.cookie) — the
  // same D-112 guard the executor applies to step input. The check LOWERCASES
  // because arg names are UNTRUSTED and `isLockedInputKey` is case-sensitive by
  // contract; HTTP header names are case-insensitive, so a recipe `header.
  // Authorization` / `header.Cookie` / `header.Host` must still strip (Codex
  // review HIGH). The gateway applies the guard HERE because it then adds the
  // binding's TRUSTED method/path and marks `stepMeta.surface_dispatch` so the
  // executor skips its (now-redundant) re-strip — which would otherwise filter
  // the binding's own `method` back out (`method` is itself a locked key).
  for (const [k, v] of Object.entries(args)) {
    // `.trim()` before the lock check so a whitespace-padded variant
    // (`'method '`, `'header.Authorization '`) can't slip past — it would
    // otherwise fail downstream at Node's invalid-header-name throw instead of
    // being stripped explicitly here (Codex review LOW).
    if (PROTO_KEYS.has(k) || isLockedInputKey(k.trim().toLowerCase())) continue;
    // SMB-finance slice 3 — the `__rc_*` response-capture wire keys are
    // engine-owned (set below from the binding); a recipe arg can never set
    // them, so the adapter's binary-capture branch can't be forced by a recipe.
    if (k.trim().toLowerCase().startsWith('__rc_')) continue;
    // D-217 slice 2b-ii — same rule, higher stakes. The `__cu_*` keys carry a
    // STAGING TOKEN addressing a decrypted file on disk; a recipe that could
    // set one would be reading staged plaintext of the walk's choosing and
    // sending it to a connection. Stripped here, and refused again at the
    // phase builder (`buildChunkedPhaseInput`) for the manifest side.
    if (k.trim().toLowerCase().startsWith(CHUNKED_UPLOAD_WIRE_PREFIX)) continue;
    input[k] = v;
  }
  // D-182 (CRM Tier-P, decision-b) — a `merge_query` key UNIONS the binding's
  // static list with a caller-supplied `query.<k>` (deduped, static defaults
  // first, caller extras appended) so a vendor-raw read can request extra/custom
  // fields on top of the default property set; every other static_query key stays
  // authoritative (clobber), preserving the locked call target.
  const mergeKeys = new Set(binding.merge_query ?? []);
  for (const [k, v] of Object.entries(binding.static_query ?? {})) {
    const caller = input[`query.${k}`];
    input[`query.${k}`] =
      mergeKeys.has(k) && typeof caller === 'string' && caller.trim().length > 0
        ? unionCsv(v, caller)
        : v;
  }
  // static_headers are publish-validated (the validator rejects locked header
  // names), but re-check at runtime so a stale / hand-built binding can never
  // smuggle an Authorization / Cookie / Host header past the lock.
  for (const [k, v] of Object.entries(binding.static_headers ?? {})) {
    if (isLockedInputKey(`header.${k.trim().toLowerCase()}`)) continue;
    input[`header.${k}`] = v;
  }
  // D-192 — static_body folds as authoritative `body.<k>` args (the binding
  // owns its fixed request body the way static_query owns its params; the
  // azure-devops WIQL list op bakes its query text here). The connection
  // adapter gives a caller `body_raw` precedence over composed `body.*`
  // fields, so strip it whenever the binding declares a static body —
  // otherwise a caller arg could replace the binding-owned body wholesale.
  const hasStaticBody = binding.static_body !== undefined;
  const staticBody = Object.entries(binding.static_body ?? {});
  if (hasStaticBody) delete input.body_raw;
  for (const [k, v] of staticBody) {
    input[`body.${k}`] = v;
  }
  // An explicitly empty static body is still a body contract. This is the
  // truthful representation for POST/PUT APIs whose JSON request body is
  // required but whose non-credential fields are all optional: send `{}` when
  // the caller supplied no dynamic body fields, while retaining structured
  // `body.*` composition when it did. The marker is engine-owned because
  // caller `body_raw` was stripped above.
  // ⚠ ...AND NOT WHEN THE CALLER SENT A WHOLE-OBJECT `body`. `body_raw` WINS in
  // `buildConnectionApiBody`, so injecting `'{}'` here would silently replace a
  // payload the operation declares (`{ key: 'body', type: 'object' }`) with an
  // empty object — the empty-body defect this marker exists to avoid, delivered
  // by the marker itself.
  if (hasStaticBody
    && staticBody.length === 0
    && input.body == null
    && !Object.keys(input).some((key) => key.startsWith('body.'))) {
    input.body_raw = '{}';
  }
  // D-216 — the declaration is executable authority, not documentation. A
  // recipe supplies only the declared file_ref arg; the engine translates it
  // into the adapter's body slot and stamps an unforgeable marker. Without a
  // one-shot declaration no marker is emitted, and the adapter refuses raw
  // body_file/body_binary keys before resolving any bytes.
  const upload = binding.upload;
  if (upload !== undefined && upload.kind !== 'chunked') {
    const fileRef = args[upload.arg];
    if (fileRef !== undefined) {
      const target = upload.kind === 'binary'
        ? 'body_binary'
        : `body_file.${upload.field ?? ''}`;
      input[target] = fileRef;
      if (upload.arg !== target) delete input[upload.arg];
    }
    input[HTTP_UPLOAD_WIRE_KIND_KEY] = upload.kind;
    if (upload.kind === 'multipart' && upload.field !== undefined) {
      input[HTTP_UPLOAD_WIRE_FIELD_KEY] = upload.field;
    }
    if (upload.max_bytes !== undefined) {
      input[HTTP_UPLOAD_WIRE_MAX_BYTES_KEY] = upload.max_bytes;
    }
  }
  // Body-field auth opt-in. The binding — never a recipe arg — names which of
  // the connection's encrypted `body_field` credentials this operation carries;
  // recipe `__rc_*` keys were stripped above, so the marker's presence proves
  // the manifest asked. Only NAMES cross here; the adapter resolves the values
  // out of the connection record.
  const authBodyFields = binding.auth_body_fields;
  if (Array.isArray(authBodyFields) && authBodyFields.length > 0) {
    input[HTTP_AUTH_BODY_FIELDS_WIRE_KEY] = JSON.stringify(authBodyFields);
  }
  input.method = binding.method;
  input.path = binding.path_template;
  input.connection_kind = 'api';
  if (connectionName) input.connection = connectionName;
  // SMB-finance slice 3 — a `response_capture` REST op (storage-gdrive
  // `file.download`): tell the adapter to read the raw body into base64 +
  // mime + filename (instead of JSON-parsing) so the gateway can ingest the
  // bytes into the CAS and return a `file_ref`. The filename source is
  // pre-resolved here for `static`/`arg` (the adapter reads Content-Disposition
  // for `header`). These keys are engine-owned (stripped from recipe args
  // above) so a recipe can never trigger binary capture on its own.
  const capture = binding.response_capture;
  if (capture) {
    input.__rc_capture = '1';
    if (capture.mime_type) input.__rc_mime = capture.mime_type;
    const fs = capture.filename_source;
    if (fs.kind === 'static') {
      input.__rc_filename = fs.value;
    } else if (fs.kind === 'arg') {
      const fromArg = args[fs.arg];
      if (typeof fromArg === 'string' && fromArg.length > 0) input.__rc_filename = fromArg;
    }
  }
  // Basecamp/int64 audit fold — an opt-in REST response mode preserves JSON
  // integer literals outside JavaScript's safe range as exact decimal strings.
  // The engine owns this key (recipe `__rc_*` args were stripped above), so a
  // caller cannot change the binding's response semantics at invocation time.
  if (binding.response_json?.unsafe_integers === 'string') {
    input.__rc_json_unsafe_integers = 'string';
  }
  // Exact int64 request fold — the binding, never recipe input, selects which
  // top-level JSON body fields consume decimal strings and emit raw integer
  // literals. The adapter validates every selected value before serialization.
  const decimalIntegerFields = binding.request_json?.decimal_integer_fields;
  if (Array.isArray(decimalIntegerFields) && decimalIntegerFields.length > 0) {
    input.__rc_json_decimal_integer_fields = JSON.stringify(
      decimalIntegerFields,
    );
  }
  return input;
};

/** D-217 slice 2b-ii-β2 — turn a `bind.upload` CHUNKED declaration into the ONE
 *  dispatch input that buys the whole walk.
 *
 *  🔑 **For a chunked op the DECLARATION IS THE PROGRAM** (§ 9.2). D-216's
 *  `bind.upload` is a manifest disclosure — the one-shot runtime egress is
 *  driven by the op's `body_file.*` wire args and nothing reads the declaration
 *  at dispatch. A multi-request protocol has no single set of wire params, so
 *  the declaration has to cross, and this is where it does.
 *
 *  ⚠ **Everything put here is STABLE across attempts, deliberately.** The
 *  commit Gateway hashes this input for the action identity, so a per-attempt
 *  value would give every honest repeat a different `canonical_payload_hash`
 *  and no D-177 grant could ever match. That is why the staging token is NOT
 *  here — the adapter mints one below the commit boundary — and why the content
 *  hash IS: it pins which bytes the count was computed for, and it is the same
 *  every run.
 *
 *  ⚠ **`count` is the reviewable multiplier.** It is fixed here, before the
 *  first dispatch, from two locally-known numbers; the adapter re-derives it
 *  and refuses to walk any other size. One approval buys exactly N requests
 *  (§ 6.1 / § 8a).
 *
 *  🔑 The file arg is left where it was. `spec.arg` names an ordinary op arg
 *  (the predicate refuses the one-shot `body_file.*` wire slots for a chunked
 *  op), so it stays a normal authority-bearing key exactly where
 *  `affects_target` and the open-projection walk expect to find it — the walk
 *  descriptor carries its own copy rather than moving it. */
const applyChunkedUploadWalk = async (
  input: Record<string, unknown>,
  binding: ApiExecutionBinding,
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  operationId: string,
): Promise<void> => {
  if (binding.kind !== 'rest') return;
  const spec = binding.upload;
  if (spec === undefined || spec.kind !== 'chunked') return;

  const fileRef = args[spec.arg];
  if (typeof fileRef !== 'string' || fileRef.length === 0) {
    throw new Error(
      `D-165 gateway: operation '${operationId}' declares a chunked upload but arg `
      + `'${spec.arg}' carries no file_ref.`,
    );
  }
  if (ctx.describeUploadSource === undefined) {
    // Fail closed, like `no_file_ingestor` on the inbound side: a host that
    // cannot size the file cannot fix the APPEND or total request counts, and
    // an unfixed count is the one thing the § 8a carve-out does not permit.
    throw new Error(
      `D-165 gateway: operation '${operationId}' declares a chunked upload but no `
      + `upload-source reader is wired on this host.`,
    );
  }
  const source = await ctx.describeUploadSource(fileRef);
  if (source === undefined) {
    throw new Error(
      `D-165 gateway: operation '${operationId}' cannot read file '${fileRef}' for a chunked upload.`,
    );
  }
  // Sizes the walk AND re-runs the § 8a predicate over the declaration — an
  // installed pack may predate the rule. Throws rather than returning a partial
  // plan; the adapter runs the identical call and refuses any disagreement.
  const plan = planChunkedUpload({ spec, total_bytes: source.size_bytes });

  const walk: ChunkedUploadWalkInput = {
    spec,
    file_ref: fileRef,
    ...(source.content_hash.length > 0 ? { expect_sha256: source.content_hash } : {}),
    total_bytes: source.size_bytes,
    count: plan.count,
    request_bound: plan.request_bound,
    args,
  };
  input[CHUNKED_UPLOAD_WIRE_WALK_KEY] = walk;
};

/** D-217 slice 2b-ii-β2 — turn a `bind.upload` CHUNKED declaration into the ONE
 *  walk descriptor that buys the whole act.
 *
 *  🔑 **For a chunked op the DECLARATION IS THE PROGRAM** (§ 9.2). D-216's
 *  `bind.upload` is a manifest disclosure — the one-shot runtime egress is
 *  driven by the op's `body_file.*` wire args and nothing reads the declaration
 *  at dispatch. A multi-request protocol has no single set of wire params, so
 *  the declaration has to cross, and this is what builds it.
 *
 *  ⚠ **Everything it returns is STABLE across attempts, deliberately.** The
 *  commit Gateway hashes the dispatch input for the action identity, so a
 *  per-attempt value would give every honest repeat a different
 *  `canonical_payload_hash` and no D-177 grant could ever match. That is why the
 *  staging token is NOT here — the adapter mints one below the commit boundary —
 *  and why the content hash IS: it pins which bytes the count was computed for,
 *  and it is the same every run.
 *
 *  ⚠ **`count` is the reviewable multiplier.** Fixed here, before the gate, from
 *  two locally-known numbers; the ask states it and the adapter re-derives it
 *  and refuses to walk any other size. One approval buys exactly N requests
 *  (§ 6.1 / § 8a).
 *
 *  🔑 The file arg is left where it was. `spec.arg` names an ordinary op arg
 *  (the predicate refuses the one-shot `body_file.*` wire slots for a chunked
 *  op), so it stays a normal authority-bearing key exactly where
 *  `affects_target` and the open-projection walk expect to find it — the walk
 *  descriptor carries its own copy rather than moving it.
 *
 *  Returns `undefined` for every non-chunked binding, which is every op but
 *  these. Throws — before the gate — when the declaration or the file makes the
 *  walk impossible; refusing early beats asking someone to approve it first. */
const buildChunkedUploadWalk = async (
  binding: ApiExecutionBinding,
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  operationId: string,
): Promise<ChunkedUploadWalkInput | undefined> => {
  if (binding.kind !== 'rest') return undefined;
  const spec = binding.upload;
  if (spec === undefined || spec.kind !== 'chunked') return undefined;

  const fileRef = args[spec.arg];
  if (typeof fileRef !== 'string' || fileRef.length === 0) {
    throw new Error(
      `D-165 gateway: operation '${operationId}' declares a chunked upload but arg `
      + `'${spec.arg}' carries no file_ref.`,
    );
  }
  if (ctx.describeUploadSource === undefined) {
    // Fail closed, like `no_file_ingestor` on the inbound side: a host that
    // cannot size the file cannot fix the APPEND or total request counts, and
    // an unfixed count is the one thing the § 8a carve-out does not permit.
    throw new Error(
      `D-165 gateway: operation '${operationId}' declares a chunked upload but no `
      + `upload-source reader is wired on this host.`,
    );
  }
  const source = await ctx.describeUploadSource(fileRef);
  if (source === undefined) {
    throw new Error(
      `D-165 gateway: operation '${operationId}' cannot read file '${fileRef}' for a chunked upload.`,
    );
  }
  // Sizes the walk AND re-runs the § 8a predicate — an installed pack may
  // predate the rule. Throws rather than returning a partial plan; the adapter
  // runs the identical call and refuses any disagreement.
  const plan = planChunkedUpload({ spec, total_bytes: source.size_bytes });

  return {
    spec,
    file_ref: fileRef,
    ...(source.content_hash.length > 0 ? { expect_sha256: source.content_hash } : {}),
    total_bytes: source.size_bytes,
    count: plan.count,
    request_bound: plan.request_bound,
    args,
  };
};

/** SMB-finance slice 3 — pick the stable per-item id for a `response_capture`
 *  download's CAS `source_id`. A single binding path-param token keeps the
 *  original human-readable id (`/files/{{file_id}}` → `args.file_id`). When a
 *  target needs multiple path tokens or an arg-backed filename (for example an
 *  E2B volume id plus `query.path`), hash every identity component together so
 *  two foreach items cannot overwrite the same run-scoped CAS record. With no
 *  usable component the seam falls back to the response filename. */
const captureSourceIdArg = (
  binding: RestExecutionBinding,
  args: Record<string, unknown>,
): string | undefined => {
  const components = new Map<string, string>();
  const pathTokens = binding.path_template.matchAll(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
  );
  for (const match of pathTokens) {
    const key = match[1];
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) components.set(key, value);
    else if (typeof value === 'number') components.set(key, String(value));
  }
  const fs = binding.response_capture?.filename_source;
  if (fs?.kind === 'arg') {
    const v = args[fs.arg];
    if (typeof v === 'string' && v.length > 0) components.set(fs.arg, v);
  }
  if (components.size === 0) return undefined;
  if (components.size === 1) return components.values().next().value;
  const identity = Object.fromEntries(components);
  return `sha256:${canonicalArgHash(identity).canonical_payload_hash}`;
};

/** Translate a GraphQL surface binding + the caller's `args` (the GraphQL
 *  variables) into connection-api wire params: a POST to the binding's
 *  `endpoint_path` with body `{ query, variables }`. The `query` document is
 *  binding-owned (trusted); the recipe `args` ride wholesale as the `variables`
 *  JSON value — nested under `body.variables`, so they cannot override the
 *  trusted query or inject a header (no locked-key filtering needed, unlike the
 *  REST wire-key path). `method` is still POST (a locked key) so the gateway's
 *  `surface_dispatch` marker carries this past the executor's lock-strip too. */
const buildGraphqlDispatchInput = (
  binding: GraphQLExecutionBinding,
  args: Record<string, unknown>,
  connectionName: string,
): Record<string, unknown> => {
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  input.method = 'POST';
  input.path = binding.endpoint_path;
  input['body.query'] = binding.query;
  input['body.variables'] = args;
  input.connection_kind = 'api';
  if (connectionName) input.connection = connectionName;
  return input;
};

/** D-225 Slice 1 — translate an `mcp` binding + caller args into the
 *  `connection.mcp` handler's wire params (`tool` / `args`, after the
 *  connection shell strips `connection_kind` + `connection`).
 *
 *  🔑 The caller's args are QUARANTINED into the nested `args` object. Unlike
 *  the rest builder — which copies caller keys onto the top-level input and so
 *  must strip the D-112 locked keys (`method` / `url` / `header.authorization`)
 *  to stop a recipe redirecting the call — an mcp caller key cannot reach a
 *  dispatch key at all. `tool` comes from the binding and sits a level above
 *  anything a recipe can write. That is why this path needs no equivalent of
 *  the raw `connection-mcp-*` anti-spoof gate: the property is structural, not
 *  a check.
 *
 *  Prototype-sensitive keys are still dropped from the args object. They can't
 *  redirect anything here, but they serialize into the JSON-RPC params and are
 *  a hazard to whatever parses them on the far side — same posture the header
 *  and body builders take. */
const buildMcpDispatchInput = (
  binding: McpExecutionBinding,
  args: Record<string, unknown>,
  connectionName: string,
): Record<string, unknown> => {
  const toolArgs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(args)) {
    if (PROTO_KEYS.has(k.trim())) continue;
    toolArgs[k] = v;
  }
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  input.connection_kind = 'mcp';
  input.tool = binding.tool;
  input.args = toolArgs;
  if (connectionName) input.connection = connectionName;
  return input;
};

export const catalogInvocationTimeoutMs = (
  manifest: IngredientManifest,
  operationKey: string,
): number | undefined => {
  const opTimeout = manifest.operations?.[operationKey]?.timeout_ms;
  if (typeof opTimeout === 'number') return opTimeout;
  const connectorTimeout =
    manifest.surfaces?.connector?.lifecycle.invoke?.default_method_timeout_ms;
  if (typeof connectorTimeout === 'number') return connectorTimeout;
  const defaultTimeout = (manifest as { default_timeout_ms?: unknown }).default_timeout_ms;
  return typeof defaultTimeout === 'number' ? defaultTimeout : undefined;
};

/** D-166 Slice 4d.4 — the dispatch roles whose composed actor-scoped
 *  `contract.override` policy tightens a catalog resolution. D-211's global
 *  owner operation replacement is resolved before this unchanged layer.
 *  The override scope applies to five roles, but only these three feed a field
 *  that has a slot on `CatalogOperationResolution`:
 *    - `grant_resolution` → the deny-flag (`denied: true` → `allowed: false`),
 *    - `approval_composition` → stricter actor-scoped approval,
 *    - `risk_override`    → `max_risk_without_approval` (no-approval ceiling).
 *  `timeout_override` / `cache_ttl_override` carry fields
 *  with no resolution slot yet (D-166 Invariants 6/7 — "not yet wired");
 *  composing them would be dead work `projectToResolution` discards, so they
 *  are omitted until the resolution shape gains those slots (the same deferral
 *  `projectToResolution` itself documents). */
const OVERRIDE_TIGHTENING_ROLES = [
  'grant_resolution',
  'approval_composition',
  'risk_override',
] as const satisfies readonly DispatchRole[];

/** TIGHTEN the connection-keyed profile-floor `resolution` with the
 *  TIGHTEN-ONLY half of the user's `contract.override` rows for this
 *  `(actor, ingredient_id, operation_id)`.
 *
 *  The separate global D-211 owner row replaces pack defaults BEFORE
 *  resolution. This layer then composes all legacy actor-scoped restrictions
 *  through the lattice AFTER resolution, preserving the prior flow.
 *  Pure modulo the injected `ctx.contractScan`.
 *
 *  A no-op (returns the base resolution untouched) when:
 *    - no `ctx.contractScan` (dbless / unit harness — no contract store wired), or
 *    - no `ctx.actor` (a dispatch path carrying no `execution_source`) — the
 *      override scope's required `actor` segment can't be keyed, so no row matches;
 *    - the base is already `deny` — maximally restrictive, nothing is stricter
 *      (short-circuits the scan; `projectToResolution` would return it anyway).
 *
 *  `mergeRoleResults`' `conflicts` are intentionally NOT surfaced here: the only
 *  scope contributing at dispatch is `override` (`grant` / `policy_resolution`
 *  need segments this context lacks and are skipped by `composeForRole`), and
 *  `override` is `tightening_only` — a commutative+associative strict-family rule
 *  that `composeRows` never emits a conflict for. The dispatch-time merge-card UX
 *  for any future cross-scope same-precedence conflict is out of 4d.4's scope. */
export const applyCatalogOverrideTightening = (
  ctx: Pick<ExecutionContext, 'contractScan' | 'actor'>,
  resolution: CatalogOperationResolution,
  slug: string,
): CatalogOperationResolution => {
  const scan = ctx.contractScan;
  if (!scan || !ctx.actor) return resolution;
  if (resolution.verdict === 'deny') return resolution;
  const context: ResolutionContext = {
    actor: ctx.actor,
    ingredient_id: slug,
    operation_id: resolution.operation_id,
  };
  const perRole: Partial<Record<DispatchRole, RoleComposition>> = {};
  for (const role of OVERRIDE_TIGHTENING_ROLES) {
    perRole[role] = composeForRole(D165_CONTRACT_SCHEMA.composite_keys, role, context, scan);
  }
  const { policy } = mergeRoleResults(perRole);
  return projectToResolution(policy, resolution);
};

// ── Connection-agnostic pagination (collection ops) ─────────────────────────
//
//  A single vendor search/list call returns ONE page; a connection-agnostic
//  `<crm_alias>.search` is WALK-ALL (`CanonicalSearchArgs.limit` is a per-page
//  size HINT, not a total cap). When the dispatched operation declares v3
//  `pagination` (or a legacy CRM catalog still declares surface `pagination_style`)
//  AND the first page carries a vendor cursor, the gateway walks every page and
//  merges the records arrays under the effective `result_path`, so the recipe's
//  projection (`{{step.<raw>.result.<result_path>}}`) sees the full set — not a
//  silently-truncated first page. This is the runtime mirror of the pure
//  install-time read projection / search derivation; it lives here (NOT in the
//  resolver, which is install-time + pure, and NOT as a new engine loop primitive)
//  because the gate has ALREADY resolved risk/grant/approval ONCE — the follow-up
//  pages are the same operation on the same connection, so they ride the same
//  admission without re-prompting. Bounded by `PAGINATION_MAX_RECORDS` +
//  `PAGINATION_MAX_PAGES` (a large set / misbehaving cursor can never run unbounded;
//  the audit row's `pages_fetched` records the walk depth).
//
//  The catalog op dispatches through the connection-api, whose response the catalog
//  `output: { result: "result" }` map keeps under `.result` — so a page value is
//  `{ result: <vendor body> }` and the records / cursor live at `result.<…>` (the
//  same `result.` convention the resolver's projection ref uses).

/** Read a (possibly dotted) path off a plain object, null-safe. Locates the records
 *  array (`result.<result_path>`) + the dialect cursor inside an output-mapped page
 *  value (`{ result: <vendor body> }`). */
const getByPath = (obj: unknown, segments: readonly string[]): unknown => {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** Literal-dot-key-aware path read for URL-valued pagination cursors only
 *  (D-192 CORE #8f). Microsoft Graph's `@odata.nextLink` sits at the response TOP
 *  LEVEL as a single key containing a dot, NOT a nested `@odata` → `nextLink`
 *  path. Plain `getByPath` split-descends and misses it (`['@odata','nextLink']`
 *  reads undefined → a `next_path` walk silently stops after page 1 with no
 *  truncation flag). Mirrors the fetch layer's `getByDotPath`
 *  (`source-mirror/fetch.ts` — the same mechanism `@odata.etag` capture depends
 *  on; not importable here across the package boundary): try the longest
 *  dotted-literal prefix first (down to two segments), backtracking to shorter
 *  prefixes then the plain nested walk. A documented SAFE SUPERSET — an ordinary
 *  nested path resolves identically because no vendor body carries a literal
 *  dotted key colliding with a real nested path.
 *
 *  DELIBERATELY scoped to URL-valued cursors, which are never accumulated or
 *  written back. The records-array reads (`cursor_from.path`, `result_path`
 *  accumulation, `setByPath` write-back) and condition reads stay on plain
 *  `getByPath` — codex #8f fold: making cursor reads literal-first while the
 *  records envelope stayed nested was ASYMMETRIC (a literal-dot `cursor_from.path`
 *  would advance the cursor while accumulating zero rows, then falsely certify
 *  the truncated mirror as complete). Symmetry restored: the nextLink cursor is
 *  the only literal-aware read; query_token_link shares that safe URL read. */
const getByOpBodyPath = (obj: unknown, segments: readonly string[]): unknown => {
  if (segments.length === 0) return obj;
  if (obj === null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (let take = segments.length; take >= 2; take -= 1) {
    const literal = rec[segments.slice(0, take).join('.')];
    if (literal === undefined) continue;
    const resolved = getByOpBodyPath(literal, segments.slice(take));
    if (resolved !== undefined) return resolved;
  }
  const next = rec[segments[0] as string];
  if (segments.length === 1) return next;
  return getByOpBodyPath(next, segments.slice(1));
};

/** Own-property variant of `getByPath` — descends ONLY through own enumerable-or-
 *  not keys, never the prototype chain. Used for the GraphQL response envelope
 *  walk (`result_data_path`), whose path is binding-owned: the publish validator
 *  rejects prototype-sensitive segments, and this is the runtime backstop so a
 *  hand-built binding whose path names `__proto__` / `constructor` / `toString`
 *  reads `undefined` (→ fail-when-data-null) rather than a truthy inherited
 *  value that would mask an absent payload as success. */
const getOwnByPath = (obj: unknown, segments: readonly string[]): unknown => {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** Clone-and-set a (possibly dotted) path on a plain object, shallow-copying each
 *  level so the source page value is not mutated. Used to replace the records array
 *  (`result.<result_path>`) with the merged set. */
const setByPath = (obj: unknown, segments: readonly string[], value: unknown): unknown => {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments;
  const base: Record<string, unknown> =
    obj !== null && typeof obj === 'object' && !Array.isArray(obj)
      ? { ...(obj as Record<string, unknown>) }
      : {};
  base[head] = setByPath(base[head], rest, value);
  return base;
};

const asArrayValue = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const pathSegments = (path: string): string[] => path.split('.').filter((seg) => seg.length > 0);

const outputPath = (path: string): string[] => ['result', ...pathSegments(path)];

const recordsPathForResultPath = (resultPath: string): string[] =>
  resultPath.length > 0 ? outputPath(resultPath) : ['result'];

/** D-254 slice 2 — WHERE THE RECORDS SIT in the value `runCatalogOperation`
 *  returns, resolved from the manifest exactly as the pagination follower resolves
 *  it: a non-empty per-op `result_path` override wins over the surface default,
 *  then `result.` is prepended.
 *
 *  ⛔⛔ EXPORTED SO NOBODY RE-DERIVES IT. A caller that wants to read the returned
 *  records — the raw-op door, composing routable ids — cannot guess this: the
 *  leading `result` segment is an executor-envelope detail, and the override
 *  precedence is a second rule on top. Re-deriving `'result.' + result_path` at a
 *  second site would agree with this one until the day a pack declares a per-op
 *  override, and then disagree SILENTLY — the caller would read an absent path,
 *  find nothing, and emit no ids, which is indistinguishable from an op that
 *  returned no records. One rule, one function, two consumers. */
export const resolveCatalogRecordsPath = (
  manifest: IngredientManifest,
  operationKey: string,
): readonly string[] => {
  const opResultPath = manifest.operations?.[operationKey]?.result_path;
  const api = manifest.surfaces?.api;
  const resultPath =
    typeof opResultPath === 'string' && opResultPath.length > 0
      ? opResultPath
      : typeof api?.result_path === 'string'
        ? api.result_path
        : '';
  return recordsPathForResultPath(resultPath);
};

const pageParamKey = (placement: 'query' | 'body', param: string): string => `${placement}.${param}`;

/** An explicitly empty static body is lowered to `body_raw: '{}'` so a required
 *  JSON body is still sent. Once pagination adds a structured body field, that
 *  raw marker must yield or the connection adapter will send `{}` and silently
 *  discard the page size/cursor. Caller-owned non-empty raw JSON is never
 *  touched. */
const preferStructuredBodyOverEmptyRaw = (input: Record<string, unknown>): void => {
  if (input.body_raw === '{}'
    && Object.keys(input).some((key) => key.startsWith('body.'))) {
    delete input.body_raw;
  }
};

const applyOperationPaginationPageSize = (
  pagination: OperationPaginationSpec | undefined,
  input: Record<string, unknown>,
): void => {
  const pageSize = pagination?.page_size;
  // graphql_relay's page size is a GraphQL VARIABLE (`{ variable, value }`), not a
  // wire placement param — it rides `body.variables` in the follow builder, never
  // this wire-key path. Skip it here (no `placement`).
  if (pageSize === undefined || !('placement' in pageSize)) return;
  input[pageParamKey(pageSize.placement, pageSize.param)] =
    pageSize.placement === 'query' ? String(pageSize.value) : pageSize.value;
};

/** D-192 #8g (offset) — set the FIRST page's page/offset param to `start`. Offset
 *  is stateful (no response cursor); the first request must carry `start` (page 1
 *  / offset 0) so an API whose default page differs from `start` still lands on
 *  the intended first window. Read-tier only (the caller gates it). */
const applyOperationPaginationFirstOffset = (
  pagination: OperationPaginationSpec | undefined,
  input: Record<string, unknown>,
): void => {
  if (pagination?.style !== 'offset') return;
  const { placement, param } = pagination.param;
  input[pageParamKey(placement, param)] =
    placement === 'query' ? String(pagination.start) : pagination.start;
};

/** A vendor-returned next-page PATH (Salesforce `nextRecordsUrl`) is safe to follow
 *  only if it is a ROOT-RELATIVE same-origin path — the connection adapter joins it
 *  to the connection's `base_url`, so an absolute URL / protocol-relative authority /
 *  `..` traversal could redirect the call off the connection's host (exfiltration).
 *  Fail closed (denylist on the raw string, BEFORE any URL normalization — `new URL`
 *  collapses `\` → `/` and decodes `%2e%2e` → `..`, so a check that ran post-normalize
 *  would be too late). Reject: not starting with a single `/`; a protocol-relative
 *  `//` authority; a scheme (`://`); a backslash (`\`, normalized to `/` by URL / some
 *  servers); ANY percent-encoding (`%` — a real SF query-locator is plain ASCII, so
 *  `%2e%2e` / `%2f` traversal has no legitimate use here); or a literal `.`/`..`
 *  segment. A dialect that legitimately needs encoded path chars must decode-then-
 *  revalidate (none does today). The caller ALSO pins the Salesforce query-locator
 *  prefix (`/services/data/`) on top of this. (The connection adapter's own
 *  `assertUrlSafe` is the second line of defense.) An unsafe path STOPS the walk
 *  (flagged `truncated`), it is never followed. */
const isSafeNextPath = (path: unknown): path is string => {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (path.includes('://') || path.includes('\\') || path.includes('%')) return false;
  const pathOnly = path.split('?')[0];
  return !pathOnly.split('/').some((seg) => seg === '.' || seg === '..');
};

/** The result of reading one page's next-page cursor, per dialect:
 *    - `next`    — a cursor to follow (HubSpot `after` token / SF next path).
 *    - `done`    — genuine terminal: no more pages (walk ran to exhaustion).
 *    - `blocked` — a next-page cursor EXISTS but was refused as unsafe (an off-shape
 *                  Salesforce `nextRecordsUrl`). The walk stops, but — unlike `done` —
 *                  the result is INCOMPLETE, so the follower flags it `truncated`
 *                  rather than presenting a partial set as if it were the whole. */
type PaginationCursorStep =
  | { kind: 'next'; cursor: string }
  | { kind: 'done' }
  | { kind: 'blocked' };

/** A path-based continuation rebuilds the request target instead of cloning the
 * first input. Preserve binding-owned response parsing semantics and admitted
 * headers explicitly so page two cannot parse differently or silently fall back
 * to a vendor's default API version. The continuation target has already passed
 * the same-origin/path checks above. Request-body modes are not copied:
 * next_path/link_header continuations are GETs. */
const preserveAdapterResponseModes = (
  firstExecInput: Record<string, unknown>,
  next: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(firstExecInput)) {
    if (key.startsWith('header.')) next[key] = value;
  }
  if (firstExecInput.__rc_json_unsafe_integers === 'string') {
    next.__rc_json_unsafe_integers = 'string';
  }
};

/** The Salesforce query-locator prefix every `nextRecordsUrl` rides
 *  (`/services/data/<version>/query/<locator>`). The soql dialect pins the next path
 *  to this on TOP of `isSafeNextPath` — an allowlist, so a path that is root-relative
 *  yet outside the data-query API (a different SF endpoint) is refused, not followed. */
const SALESFORCE_QUERY_LOCATOR_PREFIX = '/services/data/';

/** Read the next-page cursor from one output-mapped page value, per legacy surface dialect. */
const readLegacyPaginationCursor = (style: PaginationStyle, pageValue: unknown): PaginationCursorStep => {
  if (style === 'hubspot_after') {
    // The `after` token rides a JSON body field (`body.after`), not a URL — it is
    // injection-safe, so there is no `blocked` case for this dialect.
    const after = getByPath(pageValue, ['result', 'paging', 'next', 'after']);
    return typeof after === 'string' && after.length > 0 ? { kind: 'next', cursor: after } : { kind: 'done' };
  }
  if (style === 'pipedrive_cursor') {
    // Pipedrive v2 list endpoints return the next cursor as a JSON body token under
    // `additional_data.next_cursor`; replay the same GET with `query.cursor`.
    const cursor = getByPath(pageValue, ['result', 'additional_data', 'next_cursor']);
    return typeof cursor === 'string' && cursor.length > 0 ? { kind: 'next', cursor } : { kind: 'done' };
  }
  // soql_query_locator — `done: true` is terminal even if a stale url lingers.
  if (getByPath(pageValue, ['result', 'done']) === true) return { kind: 'done' };
  const url = getByPath(pageValue, ['result', 'nextRecordsUrl']);
  if (url === undefined || url === null || url === '') return { kind: 'done' };
  // A next path EXISTS — follow ONLY a safe root-relative path that is a Salesforce
  // query locator. Anything else (off-host, traversal, a different SF endpoint) is
  // BLOCKED (stop + flag truncated), never followed.
  return isSafeNextPath(url) && url.startsWith(SALESFORCE_QUERY_LOCATOR_PREFIX)
    ? { kind: 'next', cursor: url }
    : { kind: 'blocked' };
};

/** Build the next-page dispatch input from the FIRST page's input + the cursor, per
 *  dialect. `hubspot_after` re-issues the SAME `/search` POST with the `after` token
 *  added to the body (HubSpot search pagination resends the full query + cursor);
 *  `pipedrive_cursor` re-issues the SAME list GET with `query.cursor` set;
 *  `soql_query_locator` GETs the vendor-returned next PATH (a path-swap — the
 *  binding's `path_template` + `query.q` are dropped; `nextRecordsUrl` is the full
 *  query-locator continuation). Both build a null-proto object (matching
 *  `buildApiDispatchInput`'s discipline); the first input's keys were already
 *  proto-/locked-key-filtered by `buildApiDispatchInput`. */
const buildLegacyNextPageInput = (
  style: PaginationStyle,
  firstExecInput: Record<string, unknown>,
  cursor: string,
  connectionName: string,
): Record<string, unknown> => {
  const next: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (style === 'hubspot_after') {
    for (const [k, v] of Object.entries(firstExecInput)) next[k] = v;
    // HubSpot carries the `after` token differently by TRANSPORT: the POST
    // `/crm/v3/objects/*/search` ops resend the full query in the BODY
    // (`body.after`), but the GET object-list ops (`GET /crm/v3/objects/*`) take
    // it as a QUERY param (`?after=`). connection-api DROPS the request body on
    // GET, so a GET op placing the cursor in the body can never advance — it
    // re-fetches page 1 forever until the record ceiling flags `truncated`,
    // capping the mirror at one page and silently disabling complete-walk delete
    // detection. The op's own method (preserved in `firstExecInput`) is the
    // switch; `readLegacyPaginationCursor` reads the token from the response the
    // same way for both, so only the request rebuild differs.
    if (String(next.method).toUpperCase() === 'GET') {
      next['query.after'] = cursor;
    } else {
      next['body.after'] = cursor;
    }
    return next;
  }
  if (style === 'pipedrive_cursor') {
    for (const [k, v] of Object.entries(firstExecInput)) next[k] = v;
    next['query.cursor'] = cursor;
    return next;
  }
  // soql_query_locator
  next.method = 'GET';
  next.path = cursor;
  next.connection_kind = 'api';
  if (connectionName) next.connection = connectionName;
  preserveAdapterResponseModes(firstExecInput, next);
  return next;
};

const paginationConditionMatches = (
  condition: { path: string; equals: string | number | boolean | null },
  pageValue: unknown,
): boolean => getByPath(pageValue, outputPath(condition.path)) === condition.equals;

const readHeaderValue = (headers: unknown, headerName: string): string | undefined => {
  if (headers === null || typeof headers !== 'object') return undefined;
  const normalized = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== normalized) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const stringValues = value.filter((entry): entry is string => typeof entry === 'string');
      return stringValues.length > 0 ? stringValues.join(',') : undefined;
    }
    return undefined;
  }
  return undefined;
};

const parseNextLinkHeader = (header: string): string | undefined => {
  for (const part of header.split(',')) {
    const match = part.trim().match(/^<([^>]+)>\s*;(.*)$/);
    if (!match) continue;
    const params = match[2].split(';').map((param) => param.trim().toLowerCase());
    if (params.some((param) => param === 'rel="next"' || param === "rel='next'" || param === 'rel=next')) {
      return match[1];
    }
  }
  return undefined;
};

const safeSameOriginPathFromLink = (
  rawLink: string,
  api: ProviderApiSurface | undefined,
  connectionBaseUrl: string | undefined,
): string | undefined => {
  const baseUrl =
    typeof connectionBaseUrl === 'string' && connectionBaseUrl.length > 0
      ? connectionBaseUrl
      : api?.default_base_url;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return undefined;
  }
  try {
    const base = new URL(baseUrl);
    const url = new URL(rawLink, base);
    if (url.origin !== base.origin) return undefined;
    // Origin is pinned (the SSRF boundary). `new URL` has already RESOLVED the
    // pathname — `.`/`..`/`%2e%2e` traversal is normalised away, so the residual
    // risks are a protocol-relative pathname (`//host`, which the connection
    // adapter would re-resolve off-origin) or a backslash the path walk could
    // split wrong. Validate the PATHNAME for those; PRESERVE `url.search`
    // verbatim, including percent-encoding — `@odata.nextLink` is opaque and real
    // Graph links carry `%24skiptoken` / `%2c` (codex #8f HIGH fold: the blanket
    // `isSafeNextPath` `%` rejection was designed for a RAW root-relative string,
    // not a post-`new URL` origin-pinned URL, and rejecting an encoded query
    // breaks valid pagination without adding any SSRF protection). The connection
    // adapter re-validates same-origin + runs `assertUrlSafe` on the re-resolved
    // path as the second line of defense.
    const { pathname } = url;
    if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')) {
      return undefined;
    }
    return `${pathname}${url.search}`;
  } catch {
    return undefined;
  }
};

/** Per-walk state the cursor read needs beyond the single page value. Only the
 *  stateful `offset` style reads it (the response-cursor styles ignore it):
 *  `pagesFetched` computes the next page/offset value, and `recordsPath` supplies
 *  the empty-page terminus offset lacks a response cursor for. */
interface PaginationWalkState {
  pagesFetched: number;
  recordsPath: readonly string[];
}

const readOperationPaginationCursor = (
  pagination: OperationPaginationSpec,
  pageValue: unknown,
  api: ProviderApiSurface | undefined,
  connectionBaseUrl: string | undefined,
  walk: PaginationWalkState,
): PaginationCursorStep => {
  // single_page — no walk: the single gated page IS the complete set. Returning
  // `done` immediately routes the follower through its `pages === 1 && !truncated`
  // exit → `pages_fetched: 1` (→ #8f `list_complete: true`), while the record
  // ceiling still truncates a single page that overshoots (honest).
  if (pagination.style === 'single_page') return { kind: 'done' };

  if (pagination.style === 'body_cursor') {
    if (pagination.next_when !== undefined && !paginationConditionMatches(pagination.next_when, pageValue)) {
      return { kind: 'done' };
    }
    const records = asArrayValue(getByPath(pageValue, outputPath(pagination.cursor_from.path)));
    const selected =
      pagination.cursor_from.select === 'first' ? records[0] : records[records.length - 1];
    const cursor = getByPath(selected, pathSegments(pagination.cursor_from.field));
    if (typeof cursor === 'string' && cursor.length > 0) return { kind: 'next', cursor };
    if (typeof cursor === 'number' && Number.isFinite(cursor)) return { kind: 'next', cursor: String(cursor) };
    // No advancing cursor. If `next_when` was DEFINED (and matched — we passed the
    // check above), the vendor explicitly signalled MORE pages, so a missing cursor
    // is a completeness contradiction → `blocked` (honest incompleteness), never a
    // `done` that would falsely certify the walk complete. With no `next_when`,
    // cursor-absence IS the natural terminus → `done`.
    return pagination.next_when !== undefined ? { kind: 'blocked' } : { kind: 'done' };
  }

  if (pagination.style === 'query_token') {
    // A TOP-LEVEL opaque token at a body path (Todoist `next_cursor`, Google
    // `nextPageToken`) — distinct from body_cursor's per-item token. A non-empty
    // string/number → continue (replayed on the SAME op input as `token_to`);
    // empty/absent (or a matched `done_when`) → done.
    if (pagination.done_when !== undefined && paginationConditionMatches(pagination.done_when, pageValue)) {
      return { kind: 'done' };
    }
    const token = getByPath(pageValue, outputPath(pagination.token_from));
    if (typeof token === 'string' && token.length > 0) return { kind: 'next', cursor: token };
    if (typeof token === 'number' && Number.isFinite(token)) return { kind: 'next', cursor: String(token) };
    // Token absent. For query_token, token-absence IS the standard terminus (Google
    // `nextPageToken`, Todoist `next_cursor`) → `done`. But if a `done_when` was
    // DEFINED and did NOT match (we passed the check above), the vendor explicitly
    // signalled NOT-done while giving no token — a completeness contradiction →
    // `blocked` (honest incompleteness) rather than a falsely-complete `done`.
    return pagination.done_when !== undefined ? { kind: 'blocked' } : { kind: 'done' };
  }

  if (pagination.style === 'query_token_link') {
    // Some vendors return a full next-page URL while accepting the continuation
    // as an ordinary query token on the original operation. Extract only that
    // scalar and replay the admitted method/path: unlike `next_path`, no returned
    // hostname or path can redirect the request or widen its capability.
    if (pagination.done_when !== undefined && paginationConditionMatches(pagination.done_when, pageValue)) {
      return { kind: 'done' };
    }
    const raw = getByOpBodyPath(pageValue, outputPath(pagination.link_from));
    if (raw === undefined || raw === null || raw === '') return { kind: 'done' };
    if (typeof raw !== 'string') return { kind: 'blocked' };
    try {
      const link = new URL(raw, 'https://pagination.invalid');
      const token = link.searchParams.get(pagination.query_param);
      return token !== null && token.length > 0
        ? { kind: 'next', cursor: token }
        : { kind: 'blocked' };
    } catch {
      return { kind: 'blocked' };
    }
  }

  if (pagination.style === 'offset') {
    // Stateful — the next value is COMPUTED from the running page count, not read
    // from the response. Terminate on `done_when`, an empty records page (offset's
    // only natural terminus), or the follower's ceilings.
    if (pagination.done_when !== undefined && paginationConditionMatches(pagination.done_when, pageValue)) {
      return { kind: 'done' };
    }
    if (asArrayValue(getByPath(pageValue, walk.recordsPath)).length === 0) return { kind: 'done' };
    // page-based increment bumps the page NUMBER (+1); by_page_size advances by the
    // per-page record count (validation guarantees page_size for by_page_size — the
    // `?? 1` is only a fail-safe if a malformed spec slips the gate).
    const inc =
      pagination.increment === 'by_page_size' ? pagination.page_size?.value ?? 1 : 1;
    // After `pagesFetched` pages starting at `start`, the next window is
    // `start + pagesFetched * inc` (page-based inc = 1; offset-based inc = page size).
    return { kind: 'next', cursor: String(pagination.start + walk.pagesFetched * inc) };
  }

  if (pagination.style === 'graphql_relay') {
    // Relay `pageInfo` — the cursor rides a GraphQL VARIABLE, but the response read
    // is an ordinary body-path read (the graphql body sits under the `.result`
    // envelope like every op). Field names default to the Relay spec but are
    // pack-declarable for non-conformant vendors.
    const pageInfo = getByPath(pageValue, outputPath(pagination.page_info_path));
    const hasNext = getByPath(pageInfo, pathSegments(pagination.has_next_field ?? 'hasNextPage'));
    if (hasNext !== true) return { kind: 'done' };
    const endCursor = getByPath(pageInfo, pathSegments(pagination.end_cursor_field ?? 'endCursor'));
    if (typeof endCursor === 'string' && endCursor.length > 0) return { kind: 'next', cursor: endCursor };
    // hasNextPage claims MORE but there is no cursor to advance — a malformed /
    // partial relay page. This is `blocked`, NOT `done`: the vendor has PROVEN the
    // set is incomplete, so certifying it complete (which `done` → `!truncated` →
    // #8f `list_complete: true` would do) is a completeness LIE that could feed an
    // absence-based delete diff and false-tombstone every record past this page.
    // `blocked` stops the walk AND flags `truncated` (honest incompleteness).
    return { kind: 'blocked' };
  }

  if (pagination.style === 'next_path') {
    if (pagination.done_when !== undefined && paginationConditionMatches(pagination.done_when, pageValue)) {
      return { kind: 'done' };
    }
    const raw = getByOpBodyPath(pageValue, outputPath(pagination.path));
    if (raw === undefined || raw === null || raw === '') return { kind: 'done' };
    if (typeof raw !== 'string') return { kind: 'blocked' };
    // D-192 CORE #8f — a next_path value is EITHER a root-relative path (Twilio
    // `next_page_uri`, the original contract — followed as-is, same-origin by
    // construction, no base-url dependency) OR an ABSOLUTE same-origin URL
    // (Microsoft Graph `@odata.nextLink`). The absolute form is resolved through
    // the SAME same-origin machinery `link_header` already uses
    // (`safeSameOriginPathFromLink` pins the origin against the connection base +
    // extracts pathname+search); a cross-origin or unresolvable link → undefined →
    // blocked (stop + `truncated`, never followed). A percent-encoded absolute URL
    // is refused by that helper's conservative path check → blocked → the walk
    // truncates and the Source is flagged incomplete (honest) rather than
    // following an ambiguously-encoded URL; relaxing query-encoding is a
    // deliberate future change (it also gates `link_header`'s shipped consumers).
    const nextPath = isSafeNextPath(raw)
      ? raw
      : safeSameOriginPathFromLink(raw, api, connectionBaseUrl);
    if (nextPath === undefined) return { kind: 'blocked' };
    if (pagination.path_prefix !== undefined && !nextPath.startsWith(pagination.path_prefix)) {
      return { kind: 'blocked' };
    }
    return { kind: 'next', cursor: nextPath };
  }

  if (pagination.style === 'link_header') {
    const headerName = pagination.header ?? 'link';
    const header = readHeaderValue(getByPath(pageValue, ['headers']), headerName);
    if (header === undefined || header.length === 0) return { kind: 'done' };
    const nextLink = parseNextLinkHeader(header);
    if (nextLink === undefined) return { kind: 'done' };
    const nextPath = safeSameOriginPathFromLink(nextLink, api, connectionBaseUrl);
    return nextPath !== undefined ? { kind: 'next', cursor: nextPath } : { kind: 'blocked' };
  }

  // Exhaustive over the discriminated union — an unrecognized style fails closed
  // (stop the walk, never re-dispatch off an unknown dialect).
  return { kind: 'done' };
};

const buildOperationNextPageInput = (
  pagination: OperationPaginationSpec,
  firstExecInput: Record<string, unknown>,
  cursor: string,
  connectionName: string,
): Record<string, unknown> => {
  const next: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (pagination.style === 'body_cursor') {
    for (const [k, v] of Object.entries(firstExecInput)) next[k] = v;
    applyOperationPaginationPageSize(pagination, next);
    next[pageParamKey(pagination.cursor_to.placement, pagination.cursor_to.param)] = cursor;
    preferStructuredBodyOverEmptyRaw(next);
    return next;
  }
  if (pagination.style === 'query_token' || pagination.style === 'query_token_link') {
    // Replay the SAME op input + the token param (reuses the op path_template
    // through the connection-api adapter — no vendor continuation path). The
    // link variant has already reduced the returned URL to this opaque scalar.
    for (const [k, v] of Object.entries(firstExecInput)) next[k] = v;
    applyOperationPaginationPageSize(pagination, next);
    next[pageParamKey(pagination.token_to.placement, pagination.token_to.param)] = cursor;
    preferStructuredBodyOverEmptyRaw(next);
    return next;
  }
  if (pagination.style === 'offset') {
    for (const [k, v] of Object.entries(firstExecInput)) next[k] = v;
    applyOperationPaginationPageSize(pagination, next);
    // `cursor` is the computed page/offset value — numeric in a body, string in a
    // query (mirrors the page-size convention).
    next[pageParamKey(pagination.param.placement, pagination.param.param)] =
      pagination.param.placement === 'query' ? cursor : Number(cursor);
    preferStructuredBodyOverEmptyRaw(next);
    return next;
  }
  if (pagination.style === 'graphql_relay') {
    // The cursor rides a GraphQL VARIABLE, so replay the SAME query with the
    // `after` variable set on `body.variables` (and the page-size variable when
    // declared) — never a path swap.
    for (const [k, v] of Object.entries(firstExecInput)) next[k] = v;
    const callerVars = firstExecInput['body.variables'];
    const vars: Record<string, unknown> =
      callerVars !== null && typeof callerVars === 'object' && !Array.isArray(callerVars)
        ? { ...(callerVars as Record<string, unknown>) }
        : {};
    vars[pagination.cursor_variable] = cursor;
    if (pagination.page_size !== undefined) vars[pagination.page_size.variable] = pagination.page_size.value;
    next['body.variables'] = vars;
    return next;
  }
  // next_path / link_header — GET the vendor-returned continuation PATH (a
  // path-swap; single_page never reaches here — its read returns `done`).
  next.method = 'GET';
  next.path = cursor;
  next.connection_kind = 'api';
  if (connectionName) next.connection = connectionName;
  preserveAdapterResponseModes(firstExecInput, next);
  return next;
};

interface FollowPaginationArgs {
  ctx: ExecutionContext;
  slug: string;
  output: Record<string, string> | undefined;
  stepOptions: StepOptions | undefined;
  surfaceMeta: StepMeta | undefined;
  manifest: IngredientManifest;
  /** the short operation key (`manifest.operations` / `executes` key) — used to read
   *  the op's per-op `result_path` override (the records envelope to merge at). */
  operationKey: string;
  /** the gateway-resolved effective risk tier — pagination is READ-ONLY (a write /
   *  admin / destructive op must never be auto-re-dispatched). */
  riskTier: OperationRiskTier;
  firstExecInput: Record<string, unknown>;
  firstResult: unknown;
  connectionName: string;
  connectionBaseUrl?: string | undefined;
  /** Whether the legacy surface `pagination_style` (hubspot_after / soql /
   *  pipedrive_cursor) may drive the walk. REST passes it (default true); the
   *  graphql executor passes `false` — those legacy dialects are REST-shaped
   *  (they read `result.paging.next.after` / `nextRecordsUrl` / a GET path swap),
   *  so a graphql op only ever walks its own op-local `graphql_relay` contract. */
  allowLegacyDialect?: boolean;
}

/** Walk the vendor cursor across pages (after the gated FIRST dispatch) and merge the
 *  records under `result_path`. Returns the (possibly merged) result + the page count
 *  (`pages_fetched`) + a `truncated` flag, or the first result with `pages_fetched`
 *  undefined when pagination does not apply (so the audit row omits the field for a
 *  genuinely non-paginated op). A single page (no cursor) within the ceiling returns
 *  the first result untouched.
 *
 *  READ-ONLY (SECURITY): pagination re-dispatches the SAME admitted op N times off ONE
 *  gate decision; that is only safe for a read. A write / admin / destructive op is
 *  NEVER paginated — even if its response happened to carry a cursor-shaped field, the
 *  follower must not replay the POST/PATCH/DELETE. Gated on the gateway-resolved
 *  EFFECTIVE risk tier (Invariant 1), not the op id, so an escalated read is excluded too.
 *
 *  result_path (per-op override): pagination merges at the EFFECTIVE records envelope —
 *  a NON-EMPTY per-op `OperationSpec.result_path` (lowered from the authoring
 *  `OperationRow.result_path` by the decomposer AND by `operationFamiliesFromCatalog`
 *  for the by-ref bundled-catalog path) wins over the surface-level
 *  `surfaces.api.result_path`, the SAME precedence the install resolver bakes into the
 *  read-projection ref (`effectiveResultPath`), so the follower merges at exactly the
 *  envelope the projection reads. First-party CRM catalogs declare none → the surface
 *  default. */
const followPagination = async (
  a: FollowPaginationArgs,
): Promise<{ result: unknown; pages_fetched?: number; truncated?: boolean }> => {
  const api = a.manifest.surfaces?.api;
  const operationPagination = a.manifest.operations?.[a.operationKey]?.pagination;
  const legacyStyle =
    a.allowLegacyDialect !== false
    && operationPagination === undefined
    && isPaginationStyle(api?.pagination_style)
      ? api.pagination_style
      : undefined;
  // Effective records-envelope path: a NON-EMPTY per-op `result_path` override wins
  // over the surface default — the SAME precedence the install resolver bakes into the
  // read-projection ref (`effectiveResultPath`), so the follower merges pages at
  // exactly the envelope the projection reads (a 3rd-party pack may use a per-op
  // envelope; first-party CRM catalogs declare none → the surface default).

  // Pagination applies to READ-tier ops with an operation-local contract or a
  // legacy surface dialect. Non-read op / no dialect → no follow (the gated first
  // result is returned as-is). `result_path` may be empty: that is the catalog
  // convention for a bare array at `result`. Invoked from BOTH the rest and graphql
  // protocol executors (rest for the wire-param styles + legacy dialects; graphql
  // for `graphql_relay`, whose cursor rides a body variable) — the STYLE, not the
  // binding kind, selects the follower branch, so no transport switch lives here
  // (§0.5). `single_page` passes this gate too and short-circuits to `pages_fetched:1`.
  if (
    a.riskTier !== 'read'
    || (operationPagination === undefined && legacyStyle === undefined)
  ) {
    return { result: a.firstResult };
  }

  const recordsPath = resolveCatalogRecordsPath(a.manifest, a.operationKey);
  const accumulated: unknown[] = [...asArrayValue(getByPath(a.firstResult, recordsPath))];
  let pages = 1;
  let lastPage: unknown = a.firstResult;
  let truncated = false;
  let step =
    operationPagination !== undefined
      ? readOperationPaginationCursor(operationPagination, a.firstResult, api, a.connectionBaseUrl, {
          pagesFetched: pages,
          recordsPath,
        })
      : readLegacyPaginationCursor(legacyStyle!, a.firstResult);

  while (step.kind === 'next') {
    throwIfRunKilled(a.ctx);
    // Bound BEFORE fetching the next page: a cursor still exists but we are at a
    // ceiling, so the walk is being cut short — the merged set is incomplete.
    if (pages >= PAGINATION_MAX_PAGES || accumulated.length >= PAGINATION_MAX_RECORDS) {
      truncated = true;
      break;
    }
    const nextInput =
      operationPagination !== undefined
        ? buildOperationNextPageInput(operationPagination, a.firstExecInput, step.cursor, a.connectionName)
        : buildLegacyNextPageInput(legacyStyle!, a.firstExecInput, step.cursor, a.connectionName);
    // Sequential by construction — each page's cursor comes from the prior response.
    // eslint-disable-next-line no-await-in-loop
    const pageVal = await a.ctx.ingredientExecutor(
      a.slug, nextInput, a.output, a.stepOptions, a.surfaceMeta,
    );
    throwIfRunKilled(a.ctx);
    pages += 1;
    lastPage = pageVal;
    accumulated.push(...asArrayValue(getByPath(pageVal, recordsPath)));
    step =
      operationPagination !== undefined
        ? readOperationPaginationCursor(operationPagination, pageVal, api, a.connectionBaseUrl, {
            pagesFetched: pages,
            recordsPath,
          })
        : readLegacyPaginationCursor(legacyStyle!, pageVal);
  }
  // A next-page cursor existed but was refused as unsafe — incomplete, not terminal.
  if (step.kind === 'blocked') truncated = true;

  // A single fetched page may itself overshoot the record ceiling — bound + flag.
  const overflow = accumulated.length > PAGINATION_MAX_RECORDS;
  if (overflow) truncated = true;
  const merged = overflow ? accumulated.slice(0, PAGINATION_MAX_RECORDS) : accumulated;

  // Single page that ran to genuine exhaustion (no cursor, within ceiling) → untouched
  // (also covers single-record reads whose response carries no cursor). Otherwise
  // re-shape the LAST page's output-mapped value with the merged (bounded) records so
  // the projection reads the full set. Truncation is never silent — `truncated` rides
  // the audit row.
  if (pages === 1 && !truncated) return { result: a.firstResult, pages_fetched: 1 };
  return {
    result: setByPath(lastPage, recordsPath, merged),
    pages_fetched: pages,
    ...(truncated ? { truncated: true } : {}),
  };
};

/** ⛔⛔ `pages: "all"` — A RECORDS SEARCH READ PAGE BY PAGE.
 *
 *  The store answers one page (`limit`, at most `RECORDS_MAX_PAGE_SIZE`) and
 *  returns `next_cursor` when rows were left out, and a recipe has no loop to
 *  follow it. So a search that needed more than a page stopped at the first
 *  without a word: the month-end closer lost every statement line past the
 *  200th from its counts and the accountant's CSV (2026-09-24 audit). A step
 *  that says `pages: "all"` (`StepPages`) gets every page instead, `limit` rows
 *  at a time (the most a page holds when it gives none), up to
 *  `RECORDS_MAX_SEARCH_ROWS` in all. Only a step that asks: other recipes rely
 *  on the one-page ceiling.
 *
 *  The answer keeps the store's shape: `records`, and `next_cursor` only while
 *  rows are still left, so "did I get everything" is asked the same way as of
 *  one page. The last page is sized to the cap, so that cursor sits right after
 *  the last row returned. It lives here for the reason `followPagination` does:
 *  the gate resolved the grant once, and every page is the same read on the
 *  same namespace.
 *
 *  ⚠ Pages are weakly consistent, so a row seen on two pages is kept once, by
 *  `id` (the store's rule for merging live pages). A page that adds no new row
 *  while saying more remain is not progress, and it fails the step rather than
 *  loop. */
const readRecordsSearch = async (
  args: Record<string, unknown>,
  execute: (args: Record<string, unknown>) => unknown,
  checkKilled: () => void,
): Promise<{ result: unknown; pages_fetched: number }> => {
  const size = args.limit === undefined ? RECORDS_MAX_PAGE_SIZE : args.limit;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > RECORDS_MAX_PAGE_SIZE) {
    // A page size the store would refuse reaches it as authored, and is refused
    // there in its own words.
    return { result: await execute(args), pages_fetched: 1 };
  }
  const records: unknown[] = [];
  const seen = new Set<string>();
  let prevCursor: unknown;
  let cursor: unknown = args.cursor;
  for (let pages = 1; ; pages += 1) {
    const page = (await execute({
      ...args,
      ...(cursor === undefined ? {} : { cursor }),
      limit: Math.min(size, RECORDS_MAX_SEARCH_ROWS - records.length),
    }) ?? {}) as { records?: unknown; next_cursor?: unknown; prev_cursor?: unknown };
    checkKilled();
    if (pages === 1) prevCursor = page.prev_cursor;
    const before = records.length;
    for (const record of Array.isArray(page.records) ? page.records : []) {
      const id = (record as { id?: unknown } | null)?.id;
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      records.push(record);
    }
    const next = typeof page.next_cursor === 'string' && page.next_cursor !== ''
      ? page.next_cursor
      : undefined;
    if (next === undefined || records.length >= RECORDS_MAX_SEARCH_ROWS) {
      return {
        result: {
          records,
          ...(next === undefined ? {} : { next_cursor: next }),
          ...(typeof prevCursor === 'string' ? { prev_cursor: prevCursor } : {}),
        },
        pages_fetched: pages,
      };
    }
    // Every page adds a row or fails here, and the walk ends at the cap, so it
    // cannot run on: no page count is needed on top.
    if (records.length === before) {
      throw new Error(
        `records search stopped after ${pages} pages with ${records.length} rows: a page added no new row`,
      );
    }
    cursor = next;
  }
};

// ── GraphQL response envelope (D-192 Gate E′) ───────────────────────────────
//
//  GraphQL rides the shared HTTP transport (a `graphql` binding dispatches as a
//  POST `{ query, variables }` — see `buildGraphqlDispatchInput`), but its
//  response semantics differ from REST: the server returns HTTP 200 even when
//  the operation FAILED, carrying `{ data, errors }`. The connection-api
//  status-only classifier can't see that, so without an envelope check a failed
//  GraphQL op is a silent empty success (the projection reads `result.data.*` →
//  null, no failure raised). The gateway therefore reads the op's data payload
//  at the binding's `result_data_path` (default `data`) and FAILS the step when
//  it is null/absent (fail-when-data-null), surfacing the response `errors[]`.
//  Partial data (a present-but-nulls payload) is tolerated — the recipe sees
//  the nulls and any `errors` stay on `result.errors`.

/** Summarize a GraphQL response's top-level `errors[]` for the
 *  fail-when-data-null message. Joins the first few `message` strings, bounded
 *  so a hostile / huge error list can't blow the thrown message. Returns
 *  `undefined` when there are none (a null data with no errors — an empty or
 *  malformed response). */
const GRAPHQL_ERROR_MESSAGES_MAX = 3;
const GRAPHQL_ERROR_MESSAGE_MAX_CHARS = 200;
const GRAPHQL_ERROR_DETAIL_MAX_CHARS = 500;
const graphqlErrorDetail = (body: unknown): string | undefined => {
  const errors = getOwnByPath(body, ['errors']);
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const messages = errors.slice(0, GRAPHQL_ERROR_MESSAGES_MAX).map((e) => {
    const m = e !== null && typeof e === 'object'
      ? (e as Record<string, unknown>).message
      : undefined;
    const s = typeof m === 'string' && m.length > 0 ? m : '(no message)';
    // Truncate EACH message before the join so one hostile huge `message`
    // can't allocate a giant intermediate string ahead of the final cap.
    return s.length > GRAPHQL_ERROR_MESSAGE_MAX_CHARS
      ? `${s.slice(0, GRAPHQL_ERROR_MESSAGE_MAX_CHARS)}…`
      : s;
  });
  const more = errors.length > GRAPHQL_ERROR_MESSAGES_MAX
    ? ` (+${errors.length - GRAPHQL_ERROR_MESSAGES_MAX} more)`
    : '';
  const joined = `${messages.join('; ')}${more}`;
  return joined.length > GRAPHQL_ERROR_DETAIL_MAX_CHARS
    ? `${joined.slice(0, GRAPHQL_ERROR_DETAIL_MAX_CHARS)}…`
    : joined;
};

// ── Transport protocol executors (D-192 Gate E′ Gap 4a) ─────────────────────
//
//  The pluggable transport seam (§0.5 anti-hardcoding-drift). Each API
//  execution-binding kind (`OperationBinding.kind`) that has a synchronous
//  runtime is ONE registry entry owning BOTH halves of its protocol — the
//  request-side dispatch build AND the response-side adaptation. A new protocol
//  (gRPC / OData / …) is a new entry, NEVER a `kind === 'x'` branch in the shared
//  gateway. REST is the DEFAULT protocol, not the hardcoded one. The realtime
//  subscription kinds (`webhook_subscription` / `queue_subscription` /
//  `push_channel`) and a graphql `subscription` have no synchronous runtime and
//  produce no dispatch (fail closed `unsupported_binding_kind` at the dispatch
//  site).

/** The normalized result of a protocol's response adaptation. The shared
 *  `runCatalogOperation` emits the audit row + returns/throws off this, so audit
 *  emission + the try/catch orchestration stay in ONE place — no protocol entry
 *  touches the audit sink or the `failureAudited` flag. */
type ProtocolResponseOutcome =
  | {
      readonly kind: 'ok';
      readonly result: unknown;
      readonly pages_fetched?: number;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 'fail';
      readonly failure_mode: string;
      readonly message: string;
      /** D-232 § 21 — the `RecipeErrorCode` this failure should carry.
       *
       *  ⛔⛔ WITHOUT IT THE THROW IS A BARE `Error` AND THE STEP RUNNER DEFAULTS
       *  TO `NETWORK_ERROR` — the same code a genuinely unreachable peer gets.
       *  That collapse is why "nobody answered" and "they answered and refused
       *  you" were indistinguishable to every consumer downstream, § 21's
       *  classifier included. `failure_mode` already distinguished them, but it
       *  goes only to the AUDIT row; nothing on the error the caller sees. */
      readonly error_code?: RecipeErrorCode;
    };

/** Everything a protocol's `adaptResponse` needs — the executor's first result
 *  plus the full dispatch context (structured objects, so each field read is
 *  byte-for-byte the same as the inline response blocks this replaced). */
interface ProtocolAdaptResponseArgs<B extends ApiExecutionBinding = ApiExecutionBinding> {
  readonly binding: B;
  readonly firstResult: unknown;
  readonly firstExecInput: Record<string, unknown>;
  readonly ctx: ExecutionContext;
  readonly manifest: IngredientManifest;
  readonly call: CatalogCall;
  readonly resolution: CatalogOperationResolution;
  readonly slug: string;
  readonly output: Record<string, string> | undefined;
  readonly stepOptions: StepOptions | undefined;
  readonly surfaceMeta: StepMeta | undefined;
  readonly stepMeta: StepMeta | undefined;
  readonly args: Record<string, unknown>;
  readonly connectionName: string;
  readonly connectionBaseUrl: string | undefined;
}

/** Context for the OPTIONAL pre-dispatch wire-input tweak (rest read-tier page
 *  size). */
interface ProtocolBeforeDispatchArgs {
  readonly manifest: IngredientManifest;
  readonly operationKey: string;
  readonly riskTier: OperationRiskTier;
}

/** One transport protocol's executor, keyed by `ApiExecutionBinding['kind']`.
 *  Every method receives the binding of THAT kind — the registry lookup
 *  (`protocolExecutorFor`) ties the map key to the binding subtype, and the
 *  methods are declared with METHOD syntax so their parameters stay bivariant
 *  (a `ProtocolExecutor<RestExecutionBinding>` slots into the union-keyed
 *  `PROTOCOL_EXECUTORS` with no cast). */
interface ProtocolExecutor<B extends ApiExecutionBinding = ApiExecutionBinding> {
  /** D-261 identity classification belongs to the same binding resolver that
   * constructs the live call. It does not grant permission to execute it. */
  readonly family: 'http' | 'graphql' | 'mcp';
  /** True iff a binding of this kind produces a synchronous HTTP dispatch. Drives
   *  BOTH the dispatch build AND the authorization-kind discriminator
   *  (`apiBindingProducesDispatch`) off ONE source, so the two can never disagree.
   *  (A graphql `subscription` needs an unbuilt WS/SSE substrate → false.) */
  producesDispatch(binding: B): boolean;
  /** Translate the binding + resolved args into connection-api wire params.
   *  Called ONLY when `producesDispatch(binding)` is true. */
  buildDispatchInput(
    binding: B,
    args: Record<string, unknown>,
    connectionName: string,
  ): Record<string, unknown>;
  /** OPTIONAL in-place tweak of the built wire input before dispatch (rest
   *  read-tier page size). Omitted by protocols that need none. */
  beforeDispatch?(input: Record<string, unknown>, a: ProtocolBeforeDispatchArgs): void;
  /** Adapt the executor's first result into the normalized outcome (graphql
   *  fail-when-data-null envelope; rest response_capture-or-pagination). A
   *  protocol needing no response shaping returns `{ kind: 'ok', result:
   *  firstResult }`. */
  adaptResponse(a: ProtocolAdaptResponseArgs<B>): Promise<ProtocolResponseOutcome>;
}

const REST_PROTOCOL_EXECUTOR: ProtocolExecutor<RestExecutionBinding> = {
  family: 'http',
  producesDispatch: () => true,
  buildDispatchInput: (binding, args, connectionName) =>
    buildApiDispatchInput(binding, args, connectionName),
  beforeDispatch: (input, a) => {
    const operation = a.manifest.operations?.[a.operationKey];
    // Seed a bounded FIRST page from the AUTHORED read contract even when a
    // connection/profile escalates the effective tier. The follower still gates
    // on `a.riskTier === 'read'`, so an escalation gets one bounded dispatch and
    // never an automatic replay. A genuinely authored write/admin/destructive op
    // is never page-sized.
    if (operation?.risk_tier === 'read') {
      const pagination = operation.pagination;
      applyOperationPaginationPageSize(pagination, input);
      // offset is stateful — seed the FIRST page's page/offset param to `start`.
      applyOperationPaginationFirstOffset(pagination, input);
      preferStructuredBodyOverEmptyRaw(input);
    }
  },
  adaptResponse: async (a) => {
    const { binding } = a;
    // SMB-finance slice 3 — response_capture (storage-gdrive `file.download`):
    // the adapter returned `{ status, headers, bytes_b64, mime_type, filename }`.
    // Ingest the bytes into the CAS (`data.file.received`, origin
    // `connection_download`) and return `{ file_ref, ... }` with the bytes
    // STRIPPED — the base64 transited adapter→gateway in memory only and never
    // lands in an op-step value or the audit (D-172 content isolation, mirrors
    // the CLI output_capture path). Non-collection — pagination is skipped. The
    // `source_id` keys off the target identity args the foreach binds (stable
    // across a resume, collision-free across foreach items) when present, else
    // the filename.
    if (binding.response_capture) {
      if (!a.ctx.ingestFileDownload) {
        return {
          kind: 'fail',
          failure_mode: 'no_file_ingestor',
          message:
            `D-165 gateway: operation '${a.resolution.operation_id}' declares response_capture `
            + `but no file-download ingestor is wired (no_file_ingestor).`,
        };
      }
      const r = asRecord(a.firstResult);
      const bytes_b64 = typeof r.bytes_b64 === 'string' ? r.bytes_b64 : '';
      const filename =
        typeof r.filename === 'string' && r.filename.length > 0 ? r.filename : 'download';
      const mime_type =
        typeof r.mime_type === 'string' && r.mime_type.length > 0
          ? r.mime_type
          : 'application/octet-stream';
      const idArg = captureSourceIdArg(binding, a.args);
      const source_id =
        `${a.stepMeta?.run_id ?? 'dl'}:${a.resolution.operation_id}:${idArg ?? filename}`;
      const { record_id } = await a.ctx.ingestFileDownload({
        bytes_b64, filename, mime_type, source_id,
        // The PACK declares it, on the binding — never a recipe arg.
        ...(binding.response_capture.ai_enrichment === 'opt_out'
          ? { ai_enrichment: 'opt_out' as const } : {}),
      });
      return {
        kind: 'ok',
        result: { file_ref: record_id, filename, mime_type, status: r.status },
      };
    }

    // Connection-agnostic pagination — when the surface declares a cursor dialect
    // and the first page carries a cursor, walk every page + merge the records
    // under `result_path` (bounded by PAGINATION_MAX_*). A non-paginated / single
    // page returns `firstResult` untouched (`pages_fetched` undefined → omitted
    // from the audit). READ-ONLY: the effective risk tier gates the follower so a
    // write / admin / destructive op is never auto-re-dispatched (Invariant 1).
    const paged = await followPagination({
      ctx: a.ctx,
      slug: a.slug,
      output: a.output,
      stepOptions: a.stepOptions,
      surfaceMeta: a.surfaceMeta,
      manifest: a.manifest,
      operationKey: a.call.operation_id,
      riskTier: a.resolution.effective_risk_tier,
      firstExecInput: a.firstExecInput,
      firstResult: a.firstResult,
      connectionName: a.connectionName,
      connectionBaseUrl: a.connectionBaseUrl,
    });
    return {
      kind: 'ok',
      result: paged.result,
      ...(paged.pages_fetched !== undefined ? { pages_fetched: paged.pages_fetched } : {}),
      ...(paged.truncated ? { truncated: true } : {}),
    };
  },
};

const GRAPHQL_PROTOCOL_EXECUTOR: ProtocolExecutor<GraphQLExecutionBinding> = {
  family: 'graphql',
  // graphql `subscription` needs a WS/SSE substrate (not built) — only
  // query/mutation POST-dispatch. A subscription binding produces no dispatch
  // and fails closed `unsupported_binding_kind` at the dispatch site (mirrors the
  // validator).
  producesDispatch: (binding) => binding.operation_type !== 'subscription',
  buildDispatchInput: (binding, args, connectionName) =>
    buildGraphqlDispatchInput(binding, args, connectionName),
  beforeDispatch: (input, a) => {
    // D-192 #8g — inject a declared graphql_relay page-size VARIABLE onto the
    // FIRST page's `body.variables` too, so page 1 matches every follow page (a
    // vendor whose query REQUIRES the size variable would otherwise fail page 1)
    // and the walk uses one consistent page size. Read-tier only. The follow
    // builder re-injects it on each subsequent page.
    if (a.riskTier !== 'read') return;
    const pagination = a.manifest.operations?.[a.operationKey]?.pagination;
    if (pagination?.style !== 'graphql_relay' || pagination.page_size === undefined) return;
    const vars = input['body.variables'];
    if (vars !== null && typeof vars === 'object' && !Array.isArray(vars)) {
      (vars as Record<string, unknown>)[pagination.page_size.variable] = pagination.page_size.value;
    }
  },
  adaptResponse: async (a) => {
    // D-192 Gate E′ — GraphQL response envelope (fail-when-data-null). GraphQL
    // returns HTTP 200 even when the operation failed, so a null/absent data
    // payload is a FAILED op, not a silent empty success. Read the payload at the
    // binding's `result_data_path` (default `data`) within the response body (the
    // connection-api `result` envelope); when null/undefined, surface the
    // response `errors[]` and fail the step. On success the value passes through
    // UNCHANGED (no hoist). `getOwnByPath` walks own properties only — a
    // binding-owned `result_data_path` naming `__proto__`/`toString` reads
    // `undefined` (→ fail) instead of a truthy inherited value.
    //
    // KNOWN LIMITATION (Gap 4b, deferred): this classification runs AFTER
    // `ctx.ingredientExecutor` returns, i.e. OUTSIDE the commit-gateway wrap — so
    // a graphql failure here still leaves the inner dispatch's commit `succeeded`
    // (the commit gateway treats HTTP 200 as success and cannot parse a
    // `{data,errors}` body without coupling graphql into the generic transport,
    // which §0.5 forbids). NOT a regression — before this gate a graphql
    // `data:null` was a silent success at BOTH the commit AND the step. The clean
    // fix runs graphql classification inside the per-protocol executor at the
    // dispatch/commit boundary so the commit sees the failure too. Real impact is
    // narrow (Linear returns HTTP 400 for a bad query → the transport already
    // fails the commit; only a vendor returning 200 + `{errors, data:null}` on a
    // genuine failure bites).
    const body = getOwnByPath(a.firstResult, ['result']);
    const dataPath = a.binding.result_data_path ?? 'data';
    const dataPayload = getOwnByPath(body, pathSegments(dataPath));
    if (dataPayload === null || dataPayload === undefined) {
      const detail = graphqlErrorDetail(body);
      return {
        kind: 'fail',
        failure_mode: 'graphql_error',
        message:
          `D-165 gateway: graphql operation '${a.resolution.operation_id}' on connection `
          + `'${a.call.connection_name}' returned no data at `
          + `'${dataPath === '' ? '(root)' : dataPath}'`
          + (detail ? ` — ${detail}` : '') + '.',
      };
    }
    // D-192 #8g — the first page's data payload is present; walk Relay `pageInfo`
    // pagination when the op declares `graphql_relay` (the cursor rides a body
    // VARIABLE, so it can only walk here, not in the rest executor). A non-relay /
    // single-page graphql op returns `firstResult` untouched (`pages_fetched`
    // undefined → omitted from the audit). READ-ONLY: the follower's own effective-
    // risk-tier guard bars re-dispatching a graphql mutation.
    const paged = await followPagination({
      ctx: a.ctx,
      slug: a.slug,
      output: a.output,
      stepOptions: a.stepOptions,
      surfaceMeta: a.surfaceMeta,
      manifest: a.manifest,
      operationKey: a.call.operation_id,
      riskTier: a.resolution.effective_risk_tier,
      firstExecInput: a.firstExecInput,
      firstResult: a.firstResult,
      connectionName: a.connectionName,
      connectionBaseUrl: a.connectionBaseUrl,
      // graphql only walks its own op-local `graphql_relay` contract — the legacy
      // surface dialects are REST-shaped.
      allowLegacyDialect: false,
    });
    return {
      kind: 'ok',
      result: paged.result,
      ...(paged.pages_fetched !== undefined ? { pages_fetched: paged.pages_fetched } : {}),
      ...(paged.truncated ? { truncated: true } : {}),
    };
  },
};

const MCP_PROTOCOL_EXECUTOR: ProtocolExecutor<McpExecutionBinding> = {
  family: 'mcp',
  // Every `tools/call` is a synchronous request/response. (MCP's other
  // primitives — resources, prompts, sampling — are NOT reachable from a
  // declared op: the binding's only selector is `tool`. A resource read stays
  // on the raw `connection.mcp` path, where `resource` / `resources_list` live.)
  producesDispatch: () => true,
  buildDispatchInput: (binding, args, connectionName) =>
    buildMcpDispatchInput(binding, args, connectionName),
  adaptResponse: async (a) => {
    // ⛔ A tool that RAN and RAISED must not read as success. The
    // `connection.mcp` handler maps a JSON-RPC error envelope to
    // `status: 'tool_error'` and returns HTTP-200-equivalent — so, exactly like
    // a GraphQL 200 carrying `errors`, the transport's status-only classifier
    // cannot see the failure and the step would otherwise succeed with an error
    // object in `result`. Classify it here.
    //
    // KNOWN LIMITATION (inherited from the graphql arm, same cause): this runs
    // AFTER `ctx.ingredientExecutor` returns, i.e. OUTSIDE the commit-gateway
    // wrap — so the inner dispatch's commit still records `succeeded`. The step
    // fails, the commit does not. Not a regression (before this arm existed
    // there was no mcp dispatch at all), and the clean fix is the same one that
    // arm names: classify inside the protocol executor at the dispatch/commit
    // boundary.
    const status = getOwnByPath(a.firstResult, ['status']);
    if (status === 'tool_error') {
      const detail = mcpToolErrorDetail(getOwnByPath(a.firstResult, ['result']));
      return {
        kind: 'fail',
        failure_mode: 'mcp_tool_error',
        // § 21 — REACHED AND REFUSED, which is not a network problem. This is
        // what lets `NETWORK_ERROR` go back to meaning what it says, and with it
        // `unavailable` (come back later) vs `error` (a human must look).
        error_code: 'MCP_TOOL_ERROR',
        message:
          `D-165 gateway: mcp operation '${a.resolution.operation_id}' on connection `
          + `'${a.call.connection_name}' invoked tool '${a.binding.tool}' and the server `
          + `returned an error` + (detail ? ` — ${detail}` : '') + '.',
      };
    }
    // No pagination: MCP has no transport-level cursor contract, so a tool that
    // pages does it in its own arguments and the recipe walks it. Passing the
    // envelope through UNCHANGED matches the graphql success path.
    return { kind: 'ok', result: a.firstResult };
  },
};

/** Best-effort one-line summary of an MCP tool failure, for the step-failure
 *  message. Shape-tolerant — a server that returns something else yields no
 *  detail rather than a misleading one.
 *
 *  ⛔⛔ TWO SHAPES, AND ONLY ONE OF THEM WAS READ. A tool can fail as a JSON-RPC
 *  ERROR ENVELOPE (`{message, code}`) or — far more commonly, because it is what
 *  the MCP spec defines for a tool that ran and failed — as a SUCCESSFUL result
 *  carrying `{ isError: true, content: [{ type: 'text', text }] }`. This function
 *  understood only the first, so every tool error of the second shape produced
 *  an EMPTY detail and the caller received:
 *
 *    "…invoked tool 'X' and the server returned an error."
 *
 *  with the reason discarded. The two-server drive spent three rounds on that
 *  one sentence: behind it were a missing pack dependency, a Records exposure
 *  fence about step ORDER, and finally the participant guard that was supposed
 *  to fire — each perfectly legible AT THE DOOR, each thrown away one hop later.
 *  Diagnosing any of them required bypassing this path entirely and knocking on
 *  the peer directly.
 *
 *  🔑 A REMOTE FAILURE IS ONLY AS ACTIONABLE AS THE WORST LINK IN ITS REPORTING.
 *  D-232 § 21 classifies failures so a caller can tell "they refused you" from
 *  "they were down" — and a classifier can only ever see what survived transport.
 *  This is that link. */
const MCP_TOOL_ERROR_DETAIL_MAX = 600;

const mcpToolErrorDetail = (err: unknown): string => {
  if (typeof err === 'string') return err;
  if (err === null || typeof err !== 'object') return '';
  const parts: string[] = [];
  // The MCP tool-failure shape first — it is the one servers actually send.
  const content = getOwnByPath(err, ['content']);
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const text = getOwnByPath(block, ['text']);
      if (typeof text === 'string' && text.length > 0) texts.push(text);
    }
    if (texts.length > 0) parts.push(texts.join(' '));
  }
  const message = getOwnByPath(err, ['message']);
  const code = getOwnByPath(err, ['code']);
  if (typeof message === 'string' && message.length > 0) parts.push(message);
  if (typeof code === 'number') parts.push(`code ${code}`);
  // ⚠ CAP IT — this string is PEER-SUPPLIED and lands in a step-failure message
  // and an audit row. A peer's own success envelope runs ~800 characters, and a
  // hostile or merely verbose one is unbounded. Truncation marks itself so a
  // reader knows the reason was cut rather than being that short.
  const joined = parts.join(' ');
  return joined.length > MCP_TOOL_ERROR_DETAIL_MAX
    ? `${joined.slice(0, MCP_TOOL_ERROR_DETAIL_MAX)}…`
    : joined;
};

/** The dispatchable transport registry — keyed by `ApiExecutionBinding['kind']`.
 *  ONLY the kinds with a synchronous runtime appear; a lookup for a realtime
 *  subscription kind returns undefined (→ no dispatch, fail closed). */
const PROTOCOL_EXECUTORS: Partial<Record<ApiExecutionBindingKind, ProtocolExecutor>> = {
  rest: REST_PROTOCOL_EXECUTOR,
  graphql: GRAPHQL_PROTOCOL_EXECUTOR,
  // D-225 Slice 1 — MCP is a transport like its two peers. Registering it HERE
  // is what makes the declaration live: `protocolExecutorFor` is the single
  // seam both the dispatch site and the authorization discriminator
  // (`apiBindingProducesDispatch`) resolve through, so an mcp op is authorized
  // and executed off the same source as a REST one, with no second code path.
  mcp: MCP_PROTOCOL_EXECUTOR,
};

/** Look up the transport executor for a binding, or undefined when the binding is
 *  absent or its kind has no synchronous runtime (a realtime subscription kind).
 *  The lookup is the SINGLE seam tying `binding.kind` to its executor — the two
 *  dispatch consumers (`apiBindingProducesDispatch` for authorization, the
 *  dispatch site for execution) both resolve through here, so they never
 *  diverge. */
/** D-232 — is this op an `mcp` binding with no connection, i.e. a recipe on
 *  THIS server? The two halves matter separately:
 *
 *   - `kind === 'mcp'` — the only binding whose target is a TOOL NAME, and
 *     recipe-backed tools are named `<publisher>/<recipe_id>`. A rest/graphql
 *     op with no connection is a misconfiguration, not a local call, and must
 *     keep failing the way it does today.
 *   - empty `connectionName` — the routing decision itself. A connection means
 *     someone else's server; its absence means this one.
 *
 *  ⚠ `connectionName` is engine-resolved from the step's `connection` field, so
 *  a recipe CAN choose local by omitting it. That is the intended control and
 *  it is safe: the binding still owns `tool`, so omitting a connection can only
 *  redirect the call to the same recipe on this server — never to a different
 *  recipe, and never to a different peer. */
const isLocalRecipeInvocation = (
  manifest: IngredientManifest,
  operationKey: string,
  connectionName: string,
): boolean => {
  if (connectionName) return false;
  const binding = manifest.surfaces?.api?.executes?.[operationKey];
  return binding !== undefined && binding.kind === 'mcp';
};

/** The recipe id an mcp binding names, with the publisher prefix stripped
 *  (`recued-core/peer-appointment-reply` → `peer-appointment-reply`).
 *
 *  ⛔ Read from the BINDING, never from caller args — the same structural
 *  property that makes `buildMcpDispatchInput` need no anti-spoof gate. A
 *  recipe cannot name the recipe it invokes. */
const localRecipeIdFor = (
  manifest: IngredientManifest,
  operationKey: string,
): string => {
  const binding = manifest.surfaces?.api?.executes?.[operationKey];
  const tool = binding !== undefined && binding.kind === 'mcp' ? binding.tool : '';
  const slash = tool.lastIndexOf('/');
  return slash === -1 ? tool : tool.slice(slash + 1);
};

const protocolExecutorFor = (
  binding: ApiExecutionBinding | undefined,
): ProtocolExecutor | undefined =>
  binding === undefined ? undefined : PROTOCOL_EXECUTORS[binding.kind];

export type CatalogDispatchDescription =
  | { family: 'http' | 'graphql' | 'mcp'; binding: ApiExecutionBinding; input: Record<string, unknown> }
  | { family: 'cli'; binding: CliMethodBinding; input: Record<string, unknown> }
  | { family: 'kernel'; binding: RecordsExecutionBinding; input: Record<string, unknown> };

/** Pure binding construction shared by dispatch and future-execution review.
 * Resolves the same API-before-CLI precedence; never loads a secret, invokes
 * a connector, changes admission, or evaluates an authored script. The host
 * must additionally pin the live connection/account and governed children. */
const describeCatalogApiDispatch = (
  manifest: IngredientManifest, operationKey: string,
  args: Record<string, unknown>, connectionName: string,
): Extract<CatalogDispatchDescription, { family: 'http' | 'graphql' | 'mcp' }> | null => {
  const binding = manifest.surfaces?.api?.executes?.[operationKey];
  const protocol = protocolExecutorFor(binding);
  if (binding && protocol?.producesDispatch(binding)) return {
    family: protocol.family, binding,
    input: protocol.buildDispatchInput(binding, args, connectionName),
  };
  return null;
};

export const describeCatalogDispatch = (
  manifest: IngredientManifest, operationKey: string,
  args: Record<string, unknown>, connectionName: string,
): CatalogDispatchDescription | null => {
  const api = describeCatalogApiDispatch(manifest, operationKey, args, connectionName);
  // Local recipe calls precede Records; Records precede transport dispatch in
  // runCatalogOperation. Preserve that order even for mixed-surface manifests.
  if (isLocalRecipeInvocation(manifest, operationKey, connectionName)) return api;
  const records = manifest.surfaces?.records?.executes?.[operationKey];
  if (isRecordsExecutionBinding(records)) return { family: 'kernel', binding: records, input: args };
  if (api) return api;
  const cli = manifest.surfaces?.connector?.executes?.[operationKey];
  if (cli?.kind === 'cli_invocation') return { family: 'cli', binding: cli, input: args };
  return null;
};

/** Mutates only the constructed wire request, using the live protocol's exact
 * first-page normalization. Preparation supplies the freshly resolved tier. */
export const normalizeCatalogDispatchInput = (
  manifest: IngredientManifest, operationKey: string, input: Record<string, unknown>, riskTier: OperationRiskTier,
): void => {
  protocolExecutorFor(manifest.surfaces?.api?.executes?.[operationKey])?.beforeDispatch?.(input,
    { manifest, operationKey, riskTier });
};

/** Pure authority routing, shared with preparation. Independent flags preserve
 * the dispatcher's existing precedence for mixed-surface manifests. */
export const describeCatalogAuthority = (manifest: IngredientManifest, operationKey: string, connectionName: string) => {
  const records = manifest.surfaces?.records?.executes?.[operationKey];
  const local = isLocalRecipeInvocation(manifest, operationKey, connectionName);
  return { local_recipe: local, local_recipe_id: local ? localRecipeIdFor(manifest, operationKey) : null,
    cli: isCliInvocationOp(manifest, operationKey), records: records !== undefined,
    records_binding: isRecordsExecutionBinding(records) ? records : undefined };
};

/** Route a catalog-form ingredient call through the D-165 P0 gateway.
 *  Returns the executed call's result on `admit`; throws on `deny` (step
 *  fails) or `ask` (`PreflightRequiredSignal` → engine pause).
 *
 *  `connectionName` is the engine-resolved step-level `connection` (a
 *  `{{ref}}` resolved against the stores — see `runIngredient`), NOT a raw
 *  `input` field. It drives the profile lookup + audit AND is folded back
 *  into the dispatched input so the downstream connection adapter binds
 *  the same record. */
export const runCatalogOperation = async (
  ctx: ExecutionContext, manifest: IngredientManifest, slug: string, input: Record<string, unknown>,
  connectionName: string, output: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined, stepMeta: StepMeta | undefined,
): Promise<unknown> => {
  const hooks = ctx.reviewedExecution;
  if (!hooks) return runCatalogOperationInner(ctx, manifest, slug, input, connectionName, output, stepOptions, stepMeta);
  const delegated: ExecutionContext = { ...ctx, ingredientExecutor: (delegateSlug, delegateInput, delegateOutput, options, meta) =>
    hooks.delegate({ slug: delegateSlug, input: delegateInput, stepMeta: meta },
      () => ctx.ingredientExecutor(delegateSlug, delegateInput, delegateOutput, options, meta)) };
  return hooks.invoke({ slug, input, output, catalog: true, connection_name: connectionName, stepMeta },
    // Reviewed execution never reads a cache; a step's `pages` still applies.
    () => runCatalogOperationInner(
      delegated, manifest, slug, input, connectionName, output, { ...stepOptions, cache: 'fresh' }, stepMeta,
    ));
};

const runCatalogOperationInner = async (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  slug: string,
  input: Record<string, unknown>,
  connectionName: string,
  output: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined,
  stepMeta: StepMeta | undefined,
): Promise<unknown> => {
  throwIfRunKilled(ctx);
  const rawCall = extractCatalogCall(input, connectionName);
  const call: CatalogCall = {
    ...rawCall,
    // The audit surface is derived from the catalog binding, never copied from
    // recipe input. Missing bindings keep the historical api/default failure
    // mode for back-compat with existing D-165 tests.
    surface_kind: surfaceKindForOperation(manifest, rawCall.operation_id) ?? 'api',
  };

  // D-182 §10 step 7 — the call's payload-identity hash for the gateway audit,
  // computed once from the ORIGINAL op args (before any pagination continuation
  // rewrites `input`) with the op's declared volatile exclusions, so it matches
  // the grant-gate basis and stays stable across every audited outcome.
  const originalArgs = asRecord(input.args);
  let auditArgHash = auditCanonicalArgHash(
    originalArgs,
    manifest.operations?.[call.operation_id]?.hash_exclude_args,
  );

  // D-182 §6/§7 — per-kind authorization. The Gateway stays the single audit /
  // policy / session-grant / dispatch boundary (D-153 unchanged); what's
  // per-kind is ONLY the `authorized` preflight stage — WHICH source the op's
  // grant resolves against. A `cli` op (connector `cli_invocation` binding)
  // authorizes via a per-contract REACHABILITY allowlist keyed by the dispatched
  // cli INGREDIENT + the op's risk tier (§7.2), NOT a connection profile — so a
  // connection-less by-value cli pack never reaches `no_connection_profile`; the
  // `[[project_cli_op_gateway_no_connection_profile_gap]]` dissolves by
  // construction. Every other kind (api / connection / mcp) keeps the
  // connection-keyed profile path verbatim.
  //
  // (The full §6 `KindHandler.preflight`/`.execute` registry-object model —
  // re-homing the EXECUTE primitive per kind + raw-op door exposure — is the
  // deferred §6/§8 follow-on the spec itself gates on the GatewayCallAudit
  // op-level amendment; Increment 3 lands the AUTHORIZATION-stage seam, the one
  // stage with a kind divergence today, which is where the cli gap lives.)
  // D-232 — an `mcp` binding with NO connection names a recipe on THIS server.
  // There is no separate declaration for local vs remote: the binding names a
  // recipe and the gateway routes on whether a connection was resolved. This is
  // the third connection-less kind, after `cli` and `records`, and it takes the
  // same shape they do — skip the profile, authorize by a local resolver,
  // dispatch in-process.
  const authorityTarget = describeCatalogAuthority(manifest, call.operation_id, connectionName);
  const rawRecordsBinding = manifest.surfaces?.records?.executes?.[call.operation_id];
  const isLocalRecipeOp = authorityTarget.local_recipe;
  const isCliOp = authorityTarget.cli;
  const recordsBinding = authorityTarget.records_binding;
  const isRecordsOp = authorityTarget.records;
  // ⛔ `pages: "all"` reads a Records search page by page (`StepPages`). On any
  // other operation nothing would read it, and a step that believes it read
  // everything would hold one page, so it is refused before anything runs.
  if (stepOptions?.pages === 'all' && rawRecordsBinding?.action !== 'search') {
    throw new Error(
      `pages: "all" reads a Records search page by page, and '${call.operation_id}' is not one`,
    );
  }

  // The cli kind never binds a connection — its profile / base-url resolution
  // is skipped (the per-contract reachability allowlist is its authorization
  // source instead).
  const profile = !isCliOp && !isRecordsOp && !isLocalRecipeOp && connectionName
    ? await ctx.connectionProfileResolver?.(connectionName)
    : null;
  const connectionBaseUrl = !isCliOp && !isRecordsOp && !isLocalRecipeOp && connectionName
    ? await ctx.connectionBaseUrlResolver?.(connectionName)
    : undefined;
  throwIfRunKilled(ctx);

  const recordsPrincipal = isRecordsOp
    ? recordsPrincipalFromExecutionSource(
        ctx.execution_source ?? {
          actor: ctx.actor ?? '',
          ...(ctx.contract_id !== undefined ? { contract_id: ctx.contract_id } : {}),
        },
      )
    : null;
  let recordsReachable = false;
  if (recordsBinding !== undefined) {
    try {
      recordsReachable = ctx.recordsReachabilityResolver?.(
        recordsPrincipal,
        slug,
        call.operation_id,
        recordsBinding,
      ) ?? false;
    } catch {
      recordsReachable = false;
    }
  }
  // D-232 — the local-recipe kind's authorization source. A connectionless mcp
  // op has no connection profile to resolve against, so the profile is
  // SYNTHESISED from a reachability verdict, exactly as Records does above.
  //
  // ⛔ ABSENT RESOLVER DENIES. Invariant 3 says operations default OFF, and the
  // tempting shortcut here — "the binding declared it, so admit it" — would
  // invert that for the one kind whose target is another recipe. A host that
  // has not opted in must not gain recipe-to-recipe dispatch by upgrading.
  let localRecipeReachable = false;
  if (isLocalRecipeOp) {
    try {
      localRecipeReachable = ctx.localRecipeReachabilityResolver?.(
        localRecipeIdFor(manifest, call.operation_id),
        call.operation_id,
      ) ?? false;
    } catch {
      localRecipeReachable = false;
    }
  }
  const effectiveProfile = isRecordsOp
    ? {
        allowed_operations: recordsReachable ? [call.operation_id] : [],
        catalog_slug: slug,
      }
    : isLocalRecipeOp
      ? {
          allowed_operations: localRecipeReachable ? [call.operation_id] : [],
          catalog_slug: slug,
        }
      : profile;

  // D-182 §7.2 (increment 3, ENFORCED) — the per-contract cli reachability
  // verdict: may a recipe run under THIS principal reach this cli ingredient's
  // OPERATION? cli is connection-less + pack-only, so admission is a
  // (contract × pack-op) grant keyed on the op id — NOT the risk tier. Principal =
  // the run's FULL execution source mapped via `cliPrincipalFromExecutionSource`
  // (a contract-in-force wins first; else the unrestricted owner or a complete
  // owner-schedule source; else `null` ⇒ deny). Passing the full source is
  // load-bearing: D-215 owner schedules are deliberately contract-free and are
  // distinguishable from other `system` work only by channel provenance.
  // Risk tier stays computed below ONLY for the approval/notification stage
  // (write/destructive → ask the owner) — it never gates here. An UNDECLARED op
  // (no manifest entry → no risk) is skipped (the resolver returns
  // `operation_not_declared`, ahead of any reachability deny). A throwing store
  // read fails CLOSED to not-reachable (a transient SQLite error must never
  // accidentally admit); the resolver itself maps a null principal → false.
  let cliReachable = false;
  if (isCliOp) {
    // The op must be DECLARED (carries a risk tier in the manifest) to be
    // reachable; an undeclared op short-circuits to `operation_not_declared`.
    const cliRisk = manifest.operations?.[call.operation_id]?.risk_tier;
    if (cliRisk !== undefined) {
      const cliPrincipal = cliPrincipalFromExecutionSource(
        ctx.execution_source ?? {
          actor: ctx.actor ?? '',
          ...(ctx.contract_id !== undefined ? { contract_id: ctx.contract_id } : {}),
        },
      );
      try {
        cliReachable = ctx.cliReachabilityResolver?.(cliPrincipal, slug, call.operation_id) ?? false;
      } catch {
        cliReachable = false;
      }
    }
  }

  // D-209 §1.4 — the dispatch's applicable STAGE-TRUST ceiling, derived from the FULL
  // execution_source (never reconstructed from actor/contract_id — MCP owner-vs-bound
  // needs channel + mcp_token_id). An ABSENT source FAILS CLOSED to the LOW `read`
  // ceiling (reads admit, writes HOLD) — reversing the earlier DEF-3 `admin` default.
  // Every legitimate dispatch now carries a classified source: owner-automation an
  // OWNER_CONTRACT_ID (→ read → hold), a door its door contract, housekeeping its own
  // channel, the owner-direct HID a contract-free `user`/`chat` source (→ admin →
  // relax). So a source-LESS dispatch is genuinely unattributable and a write must not
  // admit. The resolver relaxes a `write→ask` op at/below this ceiling, BEFORE the
  // contract.override tighten below.
  // D-209 #1 — `ctx.contract_snapshot` rides along so a door's AUTHORED ceiling
  // (`max_risk_without_approval`, honored only on a contract_id match) governs
  // this dispatch instead of the flat contracted default.
  const dispatchCeiling = ctx.execution_source
    ? resolveTrustCeiling(ctx.execution_source, ctx.contract_snapshot)
    : CONTRACTED_DEFAULT_TRUST_CEILING;

  // D-211 §2 — the owner's global REPLACE-IF-PRESENT ruling for this op,
  // read from the actorless exact-operation row BEFORE resolution. It travels
  // outside the legacy lattice; `applyOverrideTightening` below keeps the
  // actor-scoped restriction fields separate. The global row is keyed on the
  // fully-qualified `operation_id` (the declared spec's id — same key the
  // rpc write-site validates), using the raw call key for an
  // undeclared op (which the resolver denies regardless). NOTE: an override
  // row has ZERO effect on reachability/grants — it only feeds the resolver's
  // risk/approval replace step.
  const qualifiedOpId =
    manifest.operations?.[call.operation_id]?.operation_id ?? call.operation_id;
  const ownerOverride = readOwnerOperationOverride({
    scan: ctx.contractScan,
    ingredient_id: slug,
    operation_id: qualifiedOpId,
  });

  // Resolve the per-kind authorization floor (Invariant 1) + the owner's
  // D-211 replace-if-present ruling + the source-trust ceiling relax (D-209
  // Slice B), then TIGHTEN it with the tighten-only half of the user's
  // `contract.override` rows for this (actor, ingredient, operation) — D-166
  // Slice 4d.4. The tighten layer only ever restricts. An absent scan seam
  // leaves both layers unapplied; an absent actor skips only the legacy
  // actor-scoped tightening while the global owner row still resolves.
  const resolveWithOwnerOverride = (
    candidate: OwnerOverridePolicy | undefined,
  ): CatalogOperationResolution => applyCatalogOverrideTightening(
    ctx,
    isCliOp
      ? resolveCliReachabilityPolicy({
          operations: manifest.operations ?? {},
          operation_id: call.operation_id,
          // A reachable dispatch admits; absent allowlist row ⇒
          // `cli_reachability_disabled` (fail closed). No catalog_slug guard —
          // the reachability row's ingredient_id key IS the binding (F5).
          reachable: cliReachable,
          ceiling: dispatchCeiling,
          ...(manifest.default_policy ? { default_policy: manifest.default_policy } : {}),
          ...(candidate !== undefined ? { owner_override: candidate } : {}),
        })
      : resolveCatalogOperationPolicy({
          operations: manifest.operations ?? {},
          operation_id: call.operation_id,
          profile: effectiveProfile,
          // The dispatched catalog ingredient's slug — denies a cross-vendor
          // mismatch (a profile seeded for another catalog with a colliding
          // short key) before the grant check.
          catalog_slug: slug,
          ceiling: dispatchCeiling,
          ...(manifest.default_policy ? { default_policy: manifest.default_policy } : {}),
          ...(candidate !== undefined ? { owner_override: candidate } : {}),
        }),
    slug,
  );
  const resolution = resolveWithOwnerOverride(ownerOverride);

  // D-211 Slice 2 — offer a standing ruling only when simulating that exact
  // write proves the label truthful after provider deny, trust relaxation, and
  // profile tightening. A floor-clamped or otherwise ineffective change is
  // never offered.
  const declaredOp = manifest.operations?.[call.operation_id];
  let ownerOverrideOffer: PreflightOverrideOffer | undefined;
  if (resolution.verdict === 'ask') {
    if (declaredOp !== undefined && resolution.effective_risk_tier === 'read') {
      const candidate: OwnerOverridePolicy = {
        ...ownerOverride,
        approval: 'never',
      };
      const simulated = resolveWithOwnerOverride(candidate);
      if (simulated.verdict === 'admit' && simulated.approval === 'never') {
        ownerOverrideOffer = {
          kind: 'never_ask',
          ingredient_id: slug,
          operation_id: resolution.operation_id,
          op_hash: operationSpecHash(declaredOp),
          approval: 'never',
        };
      }
    } else if (
      resolution.effective_risk_tier === 'write'
      && declaredOp?.risk_tier === 'write'
      && declaredOp.approval === 'always'
    ) {
      const candidate: OwnerOverridePolicy = {
        ...ownerOverride,
        approval: 'ask',
      };
      const simulated = resolveWithOwnerOverride(candidate);
      if (simulated.verdict === 'ask' && simulated.approval === 'ask') {
        ownerOverrideOffer = {
          kind: 'relax_to_ask',
          ingredient_id: slug,
          operation_id: resolution.operation_id,
          op_hash: operationSpecHash(declaredOp),
          approval: 'ask',
        };
      }
    }
  }

  // ── deny ── audit the rejection, then fail the step.
  if (resolution.verdict === 'deny') {
    emitGatewayAudit(ctx, {
      ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
      outcome: 'failed',
      ...(resolution.deny_reason ? { failure_mode: resolution.deny_reason } : {}),
    });
    throw denyError(call, resolution);
  }

  // A model-facing qualified id is routing metadata, not a provider-native
  // argument. Validate the exact declared Source + selected connection and
  // unwrap it before request-schema checks, approval, grants, or dispatch. A
  // mismatch therefore cannot be approved into a wrong-provider call.
  let effectiveArgs = originalArgs;
  try {
    effectiveArgs = routeQualifiedWorkEntityOperationArgs({
      manifest,
      operation: call.operation_id,
      connection_name: call.connection_name,
      args: originalArgs,
    }).args;
  } catch (error) {
    if (error instanceof QualifiedWorkEntityIdError) {
      emitGatewayAudit(ctx, {
        ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
        outcome: 'failed',
        failure_mode: error.code === 'SOURCE_MISMATCH'
          ? 'source_mismatch'
          : 'qualified_id_invalid',
      });
    }
    throw error;
  }

  // D-254 slice 1 — the same rule for the OTHER id family. A platform-record id
  // (`<vendor>_<entity>_<connection>_<native>`) is routing metadata too, and
  // until now nothing could read it back: the composer shipped with no inverse,
  // so a record that reached a recipe step could not say which connection it
  // came from. Unwrapped HERE, beside the work-entity twin and for the identical
  // reason — a mismatch must not be approved into a wrong-account call.
  try {
    effectiveArgs = routePlatformRecordOperationArgs({
      id_arg: manifest.operations?.[call.operation_id]?.record_id_arg,
      operation: call.operation_id,
      connection_name: call.connection_name,
      args: effectiveArgs,
    }).args;
  } catch (error) {
    if (error instanceof PlatformRecordIdError) {
      emitGatewayAudit(ctx, {
        ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
        outcome: 'failed',
        // Deliberately NOT the work-entity classifier. Two id families fail for
        // the same reason and a shared code would send whoever greps it to the
        // wrong router.
        failure_mode: error.code === 'PLATFORM_ID_SOURCE_MISMATCH'
          ? 'platform_record_source_mismatch'
          : 'platform_record_connection_required',
      });
    }
    throw error;
  }

  auditArgHash = auditCanonicalArgHash(
    effectiveArgs,
    manifest.operations?.[call.operation_id]?.hash_exclude_args,
  );

  // ── closed request schema ── opt-in curated operations reject malformed,
  // missing, or undeclared args before an approval pause/session-grant match
  // can confer authority and before any provider boundary is crossed.
  const op = declaredOp;
  const requestSchemaViolation = closedRequestSchemaViolation(
    op?.request_schema,
    effectiveArgs,
  );
  if (requestSchemaViolation !== null) {
    emitGatewayAudit(ctx, {
      ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
      outcome: 'failed',
      failure_mode: 'request_schema_violation',
    });
    throw new Error(
      `D-165 gateway: operation '${resolution.operation_id}' arguments violate `
      + `its closed request schema: ${requestSchemaViolation}.`,
    );
  }

  // ── path-scope ── (D-165 P3.path-picker, Slice 3b) when the dispatched
  // operation pins the call to a sub-resource of the connection
  // (`OperationSpec.path_scope`), enforce it on BOTH the auto-`admit` and the
  // `ask` paths — placed AFTER the deny gate but BEFORE the `ask` pause so an
  // out-of-scope call is rejected WITHOUT prompting the user to approve it (the
  // path check is independent of, and stricter than, the approval gate). The
  // connection's permission boundary (`subresource_path`) is a
  // CONNECTION-RECORD attribute resolved via `ctx.connectionSubresourcePath-
  // Resolver`; absent (unscoped connection / no store wired) it canonicalizes
  // to `/` — whole-account, the pre-path-picker default, so path scope only
  // ever RESTRICTS a connection that carries a `subresource_path`. The target
  // is derived from the SAME decoded `args` the dispatch consumes
  // (`effectiveArgs`), so a transport that percent-decodes args cannot
  // reopen the literal-dot traversal bypass `checkPathScope` closes (Slice 3a).
  // The op is looked up by the SHORT key (`call.operation_id` — the `operations`
  // map key), the same key the policy + binding lookups use. A violation audits
  // `path_scope_violation` carrying both canonical paths + the template
  // (spec `:933`), then fails the step.
  if (op?.path_scope) {
    const subresourcePath = await ctx.connectionSubresourcePathResolver?.(
      call.connection_name,
    );
    throwIfRunKilled(ctx);
    const ps = checkPathScope(op.path_scope, effectiveArgs, subresourcePath);
    if (!ps.ok) {
      emitGatewayAudit(ctx, {
        ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
        outcome: 'failed',
        failure_mode: 'path_scope_violation',
        path_scope: {
          policy: op.path_scope.policy,
          connection_path: ps.connection_path,
          ...(ps.target_path !== undefined ? { target_path: ps.target_path } : {}),
          ...(op.path_scope.target_path_template !== undefined
            ? { template: op.path_scope.target_path_template }
            : {}),
          ...(ps.reason !== undefined ? { reason: ps.reason } : {}),
        },
      });
      throw pathScopeError(call, resolution, ps);
    }
  }

  // ── ask ── pause for preflight approval (D-157 Flow 2), unless the
  // user already approved this boundary crossing and the run is resuming
  // at this gated step. No per-call audit row on a pause — the call has
  // not happened; it audits when it actually executes after resume.
  //
  // D-165 follow-on (op-identity binding): on a FRESH run `preflight_admitted`
  // is absent, so an `ask` raises the normal pause. On RESUME the engine sets
  // `preflight_admitted` + `preflight_approved_target` on the gated step —
  // but the prior approval is honored ONLY when the re-resolved
  // (ingredient_slug, operation_id, connection_name) STILL matches what the
  // user approved. `connection_name` is engine-resolved from the step's
  // `connection` field (a `{{config.*}}` / `{{ref}}` that can resolve to a
  // DIFFERENT connection if config changed while paused), and a re-authored
  // recipe can change the operation literal at the same step id — either
  // drift would otherwise let an approval for connection/operation A admit a
  // now-resolved B. On a mismatch (or an absent target — a legacy / bare
  // pause), `resumeApproved` is false and we re-raise with the CURRENT
  // identity, minting a fresh checkpoint + ask for the drifted call (fail
  // closed). A re-raised pause writes no audit row here (the call has not
  // happened); it audits when it actually executes after the new approval.
  // D-173 N.5 §3 — approve-with-edits reconciliation lives at the EXACT-MATCH
  // guard below, deliberately WITHOUT a special-case engine branch. When the
  // admin-only `reception.inbox.approve` rpc approves-with-edits it
  // (re)computes `approved_target` FROM THE MERGED ARGS at approve time and
  // writes that recomputed identity onto `Checkpoint.approved_target`
  // (alongside `arg_overrides`). Both flow through the already-wired channel
  // (`buildResumeInputs` → `internal.resume_from` → `ctx.resumeFrom` →
  // `StepMeta.preflight_approved_target`), so the dispatch's re-resolved
  // `(slug, operation_id, connection_name)` — which reflects the merge,
  // applied in `runIngredient` BEFORE `resolveCatalogConnection` — is
  // verified against the recomputed target by the SAME `catalogTargetMatches`
  // call. The human consciously chose the target, so the recomputed value
  // matches and the call admits; the drift guard stays at FULL strength on
  // EVERY path (an edited resume whose `approved_target` does NOT match the
  // re-resolved identity — e.g. an independent `{{config.*}}` connection that
  // drifted out from under the approval — still re-asks, fail closed). This
  // is why N.5 §3 is sound and NOT an approval-bypass: the recompute is an
  // approve-time act of the same admin, not an engine relaxation.
  // D-177 catalog-gate loop — the action-identity hashes for a session-grant
  // match / mint, computed LAZILY (only the ask-branch + the resume mint need
  // them) and ONCE. Basis: the RESOLVED operation `args` (the same object the
  // dispatch consumes), projected to JSON wire form, with the op's
  // `hash_exclude_args` removed — a SELF-CONSISTENT basis (the gate hashes the
  // same way at mint and at match, so a grant provably matches its own
  // repeat). Fail-closed to undefined on a non-canonicalizable payload: no
  // hashes ⇒ no grant match and no mint, so the op holds as today. Op `args`
  // are the operation payload, NOT auth — the connection adapter resolves
  // `{{vault.*}}` at dispatch, so the basis is secret-free (and the strict
  // recipe validator rejects recipe-authored `{{vault.*}}` refs outright —
  // codex); a runtime-opaque arg that happened to carry a secret would only
  // re-ask on rotation (conservative), never leak (the hash is one-way).
  //
  // Known residue (codex, expected behavior): the grant pins the recipe
  // (`recipe_hash`) + operation_id + arg shape + payload, but NOT the catalog
  // manifest's wire BINDING for the operation (method/path live in the
  // manifest, not the recipe). A manifest UPGRADE that re-points an op's
  // binding is a curated, user-initiated trust event (the catalog publisher's,
  // installed by the user — not a model/agent re-aim), analogous to a recipe
  // edit; with a short-TTL session grant the practical window is negligible.
  // Recipes that pin `ingredient_version` re-ask on upgrade via `recipe_hash`.
  let catalogHashes: ArgHashes | undefined;
  // The projected wire form of the op args, memoized alongside the hashes —
  // the batch-ask member preview basis (N.10 items rendering). Set only when
  // hashing succeeded (a non-canonicalizable payload is never a batch member).
  let catalogProjectedArgs: Record<string, unknown> | undefined;
  let catalogHashesComputed = false;
  const getCatalogHashes = (): ArgHashes | undefined => {
    if (!catalogHashesComputed) {
      catalogHashesComputed = true;
      try {
        const projected = projectResolvedArgs(effectiveArgs);
        catalogHashes = canonicalArgHash(
          projected,
          op?.hash_exclude_args ? { excludePaths: op.hash_exclude_args } : {},
        );
        catalogProjectedArgs = projected;
      } catch {
        catalogHashes = undefined;
      }
    }
    return catalogHashes;
  };

  // D-177 catalog open mode (N.11) — the dispatch's open projection, computed
  // lazily at most once and only where an ask path needs it (the fire-hash
  // for the match, the raise preview, the open resume mint); admit/deny never
  // pay the walk. Gated on the host hook + the hashes (a dispatch that can't
  // canonicalize can neither match nor mint an open grant). The hook is
  // synchronous by contract, so callers inside the await-free match → consume
  // span stay await-free. `undefined` is memoized too (a refused walk is
  // refused for the whole dispatch).
  let openProjectionMemo: OpenProjectionComputation | undefined;
  let openProjectionComputed = false;
  const openProjectionOnce = (): OpenProjectionComputation | undefined => {
    if (!openProjectionComputed) {
      openProjectionComputed = true;
      if (
        ctx.catalogSessionGrants?.resolveOpenProjection !== undefined
        && getCatalogHashes() !== undefined
      ) {
        try {
          openProjectionMemo = ctx.catalogSessionGrants.resolveOpenProjection({
            ingredient_slug: slug,
            operation_id: resolution.operation_id,
            args: effectiveArgs,
            ...(stepMeta?.step_id !== undefined && stepMeta.step_id !== ''
              ? { gated_step_id: stepMeta.step_id }
              : {}),
          });
        } catch {
          openProjectionMemo = undefined; // fail closed — never a dispatch dependency
        }
      }
    }
    return openProjectionMemo;
  };

  // D-177 N.11 rule 5 (slice D) — the dispatch's canonical email destinations
  // for the `'scoped'` grant arm: the op's resolved args walked over its N.2
  // authority set (`collectOperationAuthorityPaths`), v1 email shape only
  // (5.i.3 — a non-email authority value supplies nothing and the scoped arm
  // fails closed to ask). Lazy + memoized like the open walk; only ask-branch
  // paths pay it. The op + connection axes are structurally bound by the
  // grant scope, so only the destination values need containment (5.d).
  let scopedDestinationsMemo: string[] | undefined;
  let scopedDestinationsComputed = false;
  const scopedDestinationsOnce = (): string[] | undefined => {
    if (!scopedDestinationsComputed) {
      scopedDestinationsComputed = true;
      if (op !== undefined) {
        try {
          scopedDestinationsMemo = extractScopedDestinationEmails(
            effectiveArgs,
            // D-177 N.2 — same authority set the publish validator + open walk
            // use (path-template target ids included; one source of truth).
            collectOperationAuthorityPaths(op, operationPathTemplate(manifest, call.operation_id)),
          );
        } catch {
          scopedDestinationsMemo = undefined; // fail closed — never a dispatch dependency
        }
      }
    }
    return scopedDestinationsMemo;
  };

  // D-217 slice 2b-ii-β2 — the walk descriptor, built ONCE and BEFORE the gate.
  //
  // ⛔ **The order is the requirement, not a convenience.** § 6.1 says the
  // amplification bound must be visible to the reviewer BEFORE approving, and
  // the gate below runs well ahead of the dispatch-input build — so a walk
  // computed at dispatch time could not have reached the ask at all. Computed
  // here, ONE object serves both: the ask states this `count`, and the dispatch
  // input carries this same object. Two derivations would agree right up until
  // one of them changed.
  //
  // ⚠ A second consequence worth keeping: the § 8a predicate re-check and the
  // over-ceiling refusal now happen BEFORE the owner is asked. Refusing a walk
  // that cannot run is better than asking someone to approve it first.
  //
  // ⚠ Costs one metadata read (no decrypt) on a chunked op that the gate may
  // then deny. That is the right trade — the size is part of what the denial
  // decision is about.
  const chunkedBinding = manifest.surfaces?.api?.executes?.[call.operation_id];
  const chunkedWalk = chunkedBinding !== undefined
    ? await buildChunkedUploadWalk(
        chunkedBinding, effectiveArgs, ctx, resolution.operation_id,
      )
    : undefined;
  throwIfRunKilled(ctx);

  /** Raise the catalog operation's preflight-approval hold — the original
   *  `ask` pause, factored so the failed-consume / failed-claim fallbacks
   *  re-raise the identical signal (fail closed). Attaches the action-
   *  identity hashes + the (size-capped) projected-args preview so the host
   *  can register the hold as a batch-ask member (N.10), and the open
   *  preview when the walk classified this dispatch — PRESENCE upgrades the
   *  host's `allow_session` offer to `grant_mode: 'open'` (N.11), exactly
   *  the commit Gateway's raise contract. All lazy + memoized; a fallback
   *  re-raise recomputes nothing. */
  const raiseCatalogAsk = (): never => {
    const hashes = getCatalogHashes();
    const openPreview = openProjectionOnce()?.preview;
    throw new PreflightRequiredSignal(
      `catalog operation '${resolution.operation_id}' requires approval `
        + `(risk_tier='${resolution.effective_risk_tier}') on connection `
        + `'${call.connection_name}'`,
      {
        tool_slug: resolution.operation_id,
        risk_tier: resolution.effective_risk_tier,
        // No `reason` — `approve <tier> operation '<op_id>'` restated the
        // two fields beside it, so the ask body rendered the same facts
        // twice and the word "Reason:" promised an explanation that never
        // came. The ask names the operation and what its tier means; a
        // `reason` is for a policy decision that has something to ADD.
        // op-identity binding — the resolved triple the host persists on
        // `Checkpoint.approved_target` for resume-time re-verification.
        ingredient_slug: slug,
        operation_id: resolution.operation_id,
        connection_name: call.connection_name,
        ...(hashes !== undefined
          ? {
              arg_shape_hash: hashes.arg_shape_hash,
              canonical_payload_hash: hashes.canonical_payload_hash,
            }
          : {}),
        // Byte-accurate cap (mirrors the commit Gateway): the budget is
        // durable-row bytes, not UTF-16 code units. Secret-free by
        // construction — op args are payload, not auth (the connection
        // adapter resolves `{{vault.*}}` at dispatch; the strict recipe
        // validator rejects recipe-authored vault refs outright).
        ...(hashes !== undefined
          && catalogProjectedArgs !== undefined
          && new TextEncoder().encode(JSON.stringify(catalogProjectedArgs)).length
            <= BATCH_ARGS_PREVIEW_MAX_BYTES
          ? { args_preview: catalogProjectedArgs }
          : {}),
        ...(openPreview !== undefined
          ? { open_projection_preview: openPreview }
          : {}),
        // D-217 § 6.1 — a chunked upload is the one gated call where ONE
        // approval buys MANY requests. Read off the SAME descriptor the
        // dispatch input will carry, so the number the owner is shown is the
        // number the adapter is pinned to.
        ...(chunkedWalk !== undefined
          ? {
              egress_bound: {
                requests: chunkedWalk.request_bound,
                total_bytes: chunkedWalk.total_bytes,
              },
            }
          : {}),
        ...(ownerOverrideOffer !== undefined
          ? { owner_override_offer: ownerOverrideOffer }
          : {}),
        ...(resolution.approval_clamped_from !== undefined
          ? { approval_clamped_from: resolution.approval_clamped_from }
          : {}),
        authorization_provenance: resolution.authorization_provenance,
      },
    );
  };

  const reviewedApproved = ctx.reviewedExecution ? await ctx.reviewedExecution.catalogApproved({ slug, operation_id: resolution.operation_id,
    connection_name: call.connection_name, stepMeta }) : false;
  const resumeApproved =
    !reviewedApproved && stepMeta?.preflight_admitted === true
    && catalogTargetMatches(
      stepMeta.preflight_approved_target,
      slug,
      resolution.operation_id,
      call.connection_name,
    );

  // D-177 catalog-gate loop — set when the ask-branch matched a live session
  // grant: the dispatch is grant-admitted and the gate CONSUMES one use at the
  // proceed point below (a failed consume re-raises the hold — fail closed).
  let grantAdmitContractId: string | undefined;
  // D-177 catalog open mode — the fire hash the matched grant was evaluated
  // against, kept so the proceed-point consume store-verifies an `'open'`
  // consumption against the same recomputation (defense in depth).
  let grantAdmitOpenHash: string | undefined;
  // Slice D — the destinations a `'scoped'` match was evaluated against, kept
  // so the proceed-point consume RE-VERIFIES the same containment (5.a).
  let grantAdmitDestinations: ReadonlyArray<string> | undefined;
  // D-207 follow-on — the door's owner-CONFIRMED standing closure. Read on the
  // ask branch only, BEFORE the session-grant lookup: if the owner already said
  // "this door may do exactly these ops" at bind, a grant is a second answer to
  // a question they have answered. Absent field / other contract / tier above
  // `write` / op not in the closure ⇒ false, and everything below runs as
  // before.
  const standingAdmit =
    resolution.verdict === 'ask'
    && !reviewedApproved
    && !resumeApproved
    && standingClosureAdmits(
      ctx.contract_snapshot,
      ctx.execution_source,
      resolution.operation_id,
      resolution.effective_risk_tier,
      resolution.authorization_provenance.lift_reason,
    );

  if (resolution.verdict === 'ask' && !reviewedApproved && !resumeApproved && !standingAdmit) {
    // Consult a live session grant before raising (N.4, ask-branch only): a
    // match ADMITS the dispatch instead of pausing. Gated on a grantable tier
    // (read / write / admin) and the hashes (a non-canonicalizable payload can't
    // grant-match). A throwing match is a no-match (hold — fail closed). The
    // host's `match` adds the run's channel / actor / session + recipe
    // identity to the per-op envelope.
    const hashes = getCatalogHashes();
    let grantId: string | null = null;
    let fireOpenHash: string | undefined;
    let fireDestinations: string[] | undefined;
    if (
      ctx.catalogSessionGrants !== undefined
      && hashes !== undefined
      && isSessionGrantableTier(resolution.effective_risk_tier)
    ) {
      // D-177 catalog open mode — the fire's recomputed projection hash,
      // computed BEFORE the lookup so an `'open'` grant can be matched (the
      // N.4 open arm fails closed without it); a refused walk supplies
      // nothing and only exact/batch rows remain matchable. Synchronous
      // (hook contract), so the match → consume span stays await-free.
      fireOpenHash = openProjectionOnce()?.pinned_projection_hash;
      // Slice D — the scoped arm's destination tokens, computed before the
      // lookup (the N.4 scoped arm fails closed without them). The host's
      // `match` closure pairs them with the per-session forwarded-sender
      // candidate index (5.d).
      fireDestinations = scopedDestinationsOnce();
      try {
        grantId = ctx.catalogSessionGrants.match({
          ingredient_slug: slug,
          operation_id: resolution.operation_id,
          ...(call.connection_name ? { connection_name: call.connection_name } : {}),
          risk_tier: resolution.effective_risk_tier as RiskTier,
          pre_lift_approval:
            resolution.authorization_provenance.pre_lift_approval,
          arg_shape_hash: hashes.arg_shape_hash,
          canonical_payload_hash: hashes.canonical_payload_hash,
          ...(fireOpenHash !== undefined
            ? { open_pinned_projection_hash: fireOpenHash }
            : {}),
          ...(fireDestinations !== undefined
            ? { destination_emails: fireDestinations }
            : {}),
        });
      } catch {
        grantId = null;
      }
    }
    if (grantId === null) raiseCatalogAsk();
    // `raiseCatalogAsk` threw on null; the `?? undefined` only satisfies the
    // type-narrowing (grantId is a non-null string past the guard).
    grantAdmitContractId = grantId ?? undefined;
    grantAdmitOpenHash = fireOpenHash;
    grantAdmitDestinations = fireDestinations;
  }

  // ── admit (or resumed-admitted) ── execute via direct surface dispatch,
  // audit the outcome on both branches.
  //
  // D-165 RUNTIME — the gate has resolved risk/grant/approval on the catalog
  // operation; it now performs the IO by translating the operation's REST
  // surface binding into connection-api wire params (method + path + static
  // query/headers from the binding; body + path-param values from the caller's
  // `args`) and dispatching the catalog ingredient (`kind: 'connection'`)
  // under its OWN slug. The executor routes by kind through the connection
  // adapter and does NOT re-enter this catalog branch (catalog-form detection
  // lives in `runStep`, upstream of `ctx.ingredientExecutor`) — no wrapper
  // hop, no double-gate. The catalog ingredient is itself `risk_tier: read`,
  // so the downstream adapter gate is a no-op and this gate stays the sole
  // authority. The audit attributes to the CATALOG ingredient (`slug`).
  //
  // The binding lookup is keyed by the SHORT operation key (`call.operation_id`
  // — e.g. `deal.read`), the same key `operations` + `executes` share. REST and
  // GraphQL bindings translate to a connection-api HTTP call; `cli_invocation`
  // bindings translate to the server's shell-free CLI executor. Missing or
  // non-synchronous bindings fail CLOSED: the runtime refuses to call an
  // operation it cannot translate (Invariant 4).
  const binding = manifest.surfaces?.api?.executes?.[call.operation_id];
  const connectorBinding = manifest.surfaces?.connector?.executes?.[call.operation_id];
  // D-192 Gate E′ Gap 4a — dispatch through the transport protocol registry (the
  // per-`OperationBinding.kind` executor seam), not an inline kind-ternary. REST
  // + non-subscription GraphQL have entries; a realtime subscription kind (or a
  // graphql `subscription`) resolves no executor / `producesDispatch` false →
  // `execInput` undefined → fail closed `unsupported_binding_kind` below.
  const protocolEx = protocolExecutorFor(binding);
  let dispatchArgs = effectiveArgs;
  let execInput = describeCatalogApiDispatch(manifest, call.operation_id, dispatchArgs, connectionName)?.input;
  // D-217 slice 2b-ii-β2 — attach the walk built above (before the gate, so the
  // ask could state its bound). The SAME object the owner's approval was
  // rendered from, applied BEFORE `authorityExecInput` is captured so it is part
  // of what gets hashed and persisted rather than a rider added afterwards.
  if (execInput !== undefined && chunkedWalk !== undefined) {
    execInput[CHUNKED_UPLOAD_WIRE_WALK_KEY] = chunkedWalk;
  }
  const authorityExecInput = execInput;
  const cliBinding: CliMethodBinding | undefined =
    execInput === undefined && connectorBinding?.kind === 'cli_invocation'
      ? connectorBinding
      : undefined;
  if (!execInput && !cliBinding && !recordsBinding) {
    const failure_mode =
      binding || connectorBinding || rawRecordsBinding ? 'unsupported_binding_kind' : 'no_api_binding';
    emitGatewayAudit(ctx, {
      ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
      outcome: 'failed',
      failure_mode,
    });
    throw new Error(
      `D-165 gateway: operation '${resolution.operation_id}' on connection `
        + `'${call.connection_name}' has no dispatchable REST/GraphQL/CLI surface `
        + `binding (${failure_mode}).`,
    );
  }
  if (cliBinding && !ctx.cliInvocationExecutor) {
    emitGatewayAudit(ctx, {
      ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
      outcome: 'failed',
      failure_mode: 'no_cli_executor',
    });
    throw new Error(
      `D-165 gateway: operation '${resolution.operation_id}' on connection `
        + `'${call.connection_name}' has a cli_invocation binding but no CLI executor is wired `
        + `(no_cli_executor).`,
    );
  }
  if (isLocalRecipeOp && !ctx.localRecipeInvoker) {
    throw new Error(
      `D-232 local recipe operation '${call.operation_id}' has no localRecipeInvoker.`,
    );
  }
  if (recordsBinding && !ctx.recordsOperationExecutor) {
    emitGatewayAudit(ctx, {
      ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
      outcome: 'failed',
      failure_mode: 'no_records_executor',
    });
    throw new Error(
      `D-221 Records operation '${resolution.operation_id}' has no local executor (no_records_executor).`,
    );
  }

  // Mark the dispatch trusted so the executor skips its D-112 locked-key strip
  // for the binding's `method` (the gateway already filtered the recipe args).
  // D-177 P1b — thread the SHORT operation key (the `operations` map index)
  // alongside: the surface-dispatch wire input carries no `operation` field,
  // and the downstream commit Gateway needs the op row to resolve the op-level
  // `hash_exclude_args` for the call's canonical payload hash. Same trust
  // story as `surface_dispatch` (engine-set only, never copied from recipe
  // JSON; honored downstream only when `surface_dispatch` is set). `stepMeta`
  // is otherwise UNCHANGED — dispatch is under the catalog's own slug (no
  // delegate re-point), so a resume `preflight_approved_target` already names
  // this `slug` and the downstream commit gateway's slug-bound admission
  // matches. (An undefined `stepMeta` — unit harnesses — needs no flag: their
  // stub executors don't strip.)
  const surfaceMeta: StepMeta | undefined = stepMeta
    ? { ...stepMeta, surface_dispatch: true, surface_operation_key: call.operation_id,
      surface_risk_tier: resolution.effective_risk_tier as RiskTier }
    : stepMeta;
  let providerSurfaceMeta = surfaceMeta;

  // D-177 catalog-gate loop — mint on a resume-admitted `allow_session` answer
  // (the marker the engine threaded onto the gated step). THIS dispatch's own
  // envelope is the D9 basis — the same hashes a future repeat is matched
  // against, so the grant provably matches itself. Exact and open modes mint
  // here: an `'open'` marker recomputes the projection from THIS resume
  // dispatch's own walk (the same closure future fires are matched with), and
  // a refused recompute — the op's `authority_args` opt-in withdrawn
  // mid-pause, a store mutated a walked root into an unclassifiable shape —
  // degrades to NO mint (fail closed; the human-approved resume proceeds
  // regardless). A `'batch'`/unknown-mode marker mints nothing here (the
  // batch grant is the coordinator's mint from the answered ask's member
  // snapshot — N.10). The tier the ask SHOWED must equal the resume tier (a
  // mid-pause re-classification mints nothing — the grant pins what was
  // approved). Best-effort: a refused / throwing mint never blocks the
  // approved dispatch. The downstream commit Gateway never double-mints: the
  // catalog ingredient dispatches read-tier, so its ask-branch (where its own
  // mint lives) never runs, and it strips the marker before the inner adapter.
  const markerMode = stepMeta?.preflight_session_grant?.grant_mode ?? 'exact';
  if (
    resumeApproved
    && stepMeta?.preflight_session_grant !== undefined
    && (markerMode === 'exact' || markerMode === 'open')
    && stepMeta.preflight_session_grant.risk_tier === resolution.effective_risk_tier
    && ctx.catalogSessionGrants?.mint !== undefined
    && isSessionGrantableTier(resolution.effective_risk_tier)
    && (
      resolution.authorization_provenance.pre_lift_approval === 'never'
      || resolution.authorization_provenance.pre_lift_approval === 'ask'
    )
  ) {
    const hashes = getCatalogHashes();
    const openComputation = markerMode === 'open' ? openProjectionOnce() : undefined;
    if (hashes !== undefined && (markerMode === 'exact' || openComputation !== undefined)) {
      try {
        ctx.catalogSessionGrants.mint({
          ingredient_slug: slug,
          operation_id: resolution.operation_id,
          ...(call.connection_name ? { connection_name: call.connection_name } : {}),
          risk_tier: resolution.effective_risk_tier as RiskTier,
          pre_lift_approval:
            resolution.authorization_provenance.pre_lift_approval,
          arg_shape_hash: hashes.arg_shape_hash,
          canonical_payload_hash: hashes.canonical_payload_hash,
          ttl_ms: stepMeta.preflight_session_grant.ttl_ms,
          max_uses: stepMeta.preflight_session_grant.max_uses,
          ...(markerMode === 'open' && openComputation !== undefined
            ? {
                grant_mode: 'open' as const,
                pinned_projection_hash: openComputation.pinned_projection_hash,
                open_projection: openComputation.projection,
              }
            : {}),
        });
      } catch {
        /* best-effort — the approval resumes regardless (N.5) */
      }
    }
  }

  // D-177 catalog batch (N.10) — a batch-approved RESUME carries the member-
  // claim marker: the upstream batched approval admits THIS dispatch, and the
  // named member must be atomically claimed at the proceed point (the claim
  // IS the consumption — N.4; an agent replay that claimed it first wins the
  // budget and this dispatch re-holds). Hash-verified against THIS dispatch's
  // envelope (a drifted resume re-asks, never spends the member); no hashes /
  // no hook / a throwing claim all re-raise — fail closed, the marker never
  // dispatches unclaimed. Gated on the `'ask'` verdict like the commit
  // Gateway's claim: a resume that re-evaluates to `'admit'` (policy loosened
  // mid-ask) needs no approval authority, so no member burns — the unclaimed
  // member stays absorbable.
  if (
    resolution.verdict === 'ask'
    && resumeApproved
    && stepMeta?.preflight_batch_claim !== undefined
  ) {
    let claimed = false;
    try {
      const hashes = getCatalogHashes();
      claimed =
        hashes !== undefined
        && ctx.catalogSessionGrants?.claimBatchMember !== undefined
        && ctx.catalogSessionGrants.claimBatchMember(
          stepMeta.preflight_batch_claim.contract_id,
          stepMeta.preflight_batch_claim.member_id,
          {
            arg_shape_hash: hashes.arg_shape_hash,
            canonical_payload_hash: hashes.canonical_payload_hash,
          },
        );
    } catch {
      claimed = false;
    }
    if (!claimed) raiseCatalogAsk();
  }

  // D-177 catalog-gate loop — consume the matched grant's use at the proceed
  // point, synchronously before dispatch. The whole match → consume span is
  // AWAIT-FREE (the binding build + the open walk hook are sync), so two
  // concurrent dispatches can't both match-then-consume a final use; the
  // exact-mode store consume is a plain decrement that trusts the match's
  // hash verification (same posture as the commit Gateway's exact consume —
  // codex). A `'batch'`-row consume atomically claims the member the envelope
  // hash selects; an `'open'`-row consume is store-verified against the
  // fire's recomputed projection hash (defense in depth). A failed / throwing
  // consume — the grant was revoked / expired / exhausted between match and
  // here — re-raises the hold: no use spent on a dead grant, no dispatch, no
  // audit row. Fail closed.
  //
  // Known residue (codex, theoretical): the catalog ingredient dispatches
  // read-tier downstream, which auto-admits at the commit Gateway in EVERY
  // baseline cell, so no second hold. A non-baseline cell/overlay that made
  // read-tier ASK (not expressible today — reads pass the gate, D7) could
  // re-hold the downstream read AFTER this consume spent a use — conservative
  // (a wasted use + a re-ask, never an unauthorized action), the same "use
  // burned on a subsequently-held dispatch" posture the commit Gateway carries.
  if (grantAdmitContractId !== undefined) {
    let consumed = false;
    try {
      const hashes = getCatalogHashes();
      consumed =
        hashes !== undefined
        && ctx.catalogSessionGrants !== undefined
        && ctx.catalogSessionGrants.consume(grantAdmitContractId, {
          canonical_payload_hash: hashes.canonical_payload_hash,
          ...(grantAdmitOpenHash !== undefined
            ? { pinned_projection_hash: grantAdmitOpenHash }
            : {}),
          // Slice D — the scoped arm's containment is RE-VERIFIED at the
          // store (5.a); the host closure pairs these with the live sender
          // candidate index.
          ...(grantAdmitDestinations !== undefined
            ? { destination_emails: grantAdmitDestinations }
            : {}),
        });
    } catch {
      consumed = false;
    }
    if (!consumed) raiseCatalogAsk();
  }

  // D-196 direct-MCP usage admission. This host hook is deliberately after
  // every catalog grant/approval check and grant consumption, but before the
  // first CLI/API dispatch action. A usage denial throws and crosses no
  // provider boundary; normal recipe contexts leave the hook absent.
  throwIfRunKilled(ctx);
  ctx.onCatalogDispatchProceed?.({
    ingredient_slug: slug,
    operation_id: resolution.operation_id,
    args: effectiveArgs,
    connection_name: call.connection_name,
  });

  const started = Date.now();
  // A failure inside the dispatch try emits ITS OWN specific-failure_mode audit
  // (e.g. graphql_error / no_file_ingestor) and sets this flag so the catch-all
  // below does not emit a SECOND generic `error` row for the same throw. An
  // unexpected executor throw leaves it false → the catch audits `error`.
  let failureAudited = false;
  let operationBoundDispatch: PreparedOperationBoundWebhookDispatch | undefined;
  let operationBoundFailurePhase: 'dispatch_preparation' | 'provider' =
    'dispatch_preparation';
  try {
    if (isLocalRecipeOp) {
      const target = localRecipeIdFor(manifest, call.operation_id);
      // ⛔ THE GUARD LIVES HERE, not in the recipe. The gateway is the single
      // dispatch boundary, so this is the only place a cycle CANNOT be authored
      // around. It runs AFTER the policy gate admitted — a refused cycle is a
      // substrate refusal, not a permission one, and conflating them would let
      // an owner "approve" their way into an infinite loop.
      assertNoRecipeCycle(target, ctx.heldRecipes);
      const result = await ctx.localRecipeInvoker!({
        recipe_id: target,
        args: effectiveArgs,
        held_recipes: extendHeldRecipes(ctx.heldRecipes, target),
        ...(stepMeta?.invocation_path ? { invocation_path: stepMeta.invocation_path } : {}),
      });
      throwIfRunKilled(ctx);
      // ⛔⛔ A NESTED RUN THAT PAUSED IS NOT A RESULT. `executeRecipe` RETURNS
      // on a preflight hold — `{success: false, errors: [], awaiting_approval}`
      // — it does not throw. Passing that object through as this step's value
      // makes the caller continue as though the callee finished, and because
      // BOTH error arrays are empty the parent then reports `success: true`
      // having done nothing. Refused loudly until nested pause/resume exists:
      // the caller's checkpoint would have to carry the callee's, and its
      // re-run would have to RESUME the callee rather than re-invoke it. A
      // wrong answer that announces itself beats a silent one.
      assertNestedRunCompleted(target, result);
      emitGatewayAudit(ctx, {
        ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
        outcome: 'success',
        duration_ms: Date.now() - started,
      });
      return result;
    }
    if (recordsBinding) {
      if (recordsPrincipal === null) {
        throw new Error(`D-221 Records operation '${resolution.operation_id}' has no derived execution principal.`);
      }
      const principal = recordsPrincipal;
      const executeRecords = (args: Record<string, unknown>): unknown => ctx.recordsOperationExecutor!({
        binding: recordsBinding,
        args,
        principal,
        ...(ctx.outputRecipeHash ? { recipe_digest: ctx.outputRecipeHash } : {}),
        ...(ctx.recordsMutationContext ?? {}),
      });
      // A step that says `pages: "all"` reads its search page by page (the
      // check above refused it on anything but a search); every other call
      // reaches the store once, exactly as before.
      const read: { result: unknown; pages_fetched?: number } = stepOptions?.pages === 'all'
        ? await readRecordsSearch(effectiveArgs, executeRecords, () => throwIfRunKilled(ctx))
        : { result: await executeRecords(effectiveArgs) };
      throwIfRunKilled(ctx);
      emitGatewayAudit(ctx, {
        ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
        outcome: 'success',
        duration_ms: Date.now() - started,
        ...(read.pages_fetched !== undefined ? { pages_fetched: read.pages_fetched } : {}),
      });
      return read.result;
    }
    const operationBound = op?.operation_bound_webhook;
    if (operationBound !== undefined) {
      if (op?.risk_tier === 'read') {
        throw new Error(
          `D-201 operation-bound webhook '${operationBound.binding}' cannot be read-tier.`,
        );
      }
      if (typeof op?.cache_ttl_ms === 'number' && op.cache_ttl_ms > 0) {
        throw new Error(
          `D-201 operation-bound webhook '${operationBound.binding}' cannot cache provider dispatch.`,
        );
      }
      if (binding?.kind !== 'rest' || cliBinding !== undefined) {
        throw new Error(
          `D-201 operation-bound webhook '${operationBound.binding}' requires a REST catalog binding.`,
        );
      }
      if (surfaceMeta === undefined || authorityExecInput === undefined) {
        throw new Error(
          `D-201 operation-bound webhook '${operationBound.binding}' requires trusted step metadata.`,
        );
      }
      if (!ctx.operationBoundWebhook) {
        throw new Error(
          `D-201 operation-bound webhook '${operationBound.binding}' has no trusted resolver.`,
        );
      }
      if (!ctx.operationBoundWebhookConsumer) {
        throw new Error(
          `D-201 operation-bound webhook '${operationBound.binding}' requires stored consumer provenance.`,
        );
      }
      const prepared = await ctx.operationBoundWebhook({
        consumer: ctx.operationBoundWebhookConsumer,
        ingredient_slug: slug,
        operation_id: call.operation_id,
        execution_binding: binding,
        logical_binding: operationBound.binding,
        intent: operationBound.intent,
        connection_name: connectionName,
        args: dispatchArgs,
      });
      throwIfRunKilled(ctx);
      if (!prepared
        || prepared.dispatch_args === null
        || typeof prepared.dispatch_args !== 'object'
        || Array.isArray(prepared.dispatch_args)
        || typeof prepared.validateDispatchInput !== 'function'
        || typeof prepared.projectResult !== 'function'
        || typeof prepared.projectError !== 'function') {
        throw new Error('D-201 operation-bound webhook resolver returned an invalid dispatch');
      }
      // Arm redaction before any code reads the injected dispatch graph. REST
      // lowering or a future protocol hook can throw, and its error must never
      // echo the canonical callback URL before the provider is reached.
      operationBoundDispatch = prepared;
      dispatchArgs = prepared.dispatch_args;
      providerSurfaceMeta = {
        ...surfaceMeta,
        surface_dispatch_authority_input: authorityExecInput,
        surface_dispatch_sensitive: true,
      };
      // Rebuild only after trusted injection. The Source-validated effective
      // args remain the request-schema, approval/grant-hash, and audit basis.
      execInput = protocolEx!.buildDispatchInput(binding, dispatchArgs, connectionName);
      prepared.validateDispatchInput(execInput);
    }
    if (cliBinding) {
      const timeout_ms = catalogInvocationTimeoutMs(manifest, call.operation_id);
      const result = await ctx.cliInvocationExecutor!({
        slug,
        operation_key: call.operation_id,
        operation_id: resolution.operation_id,
        binding: cliBinding,
        args: effectiveArgs,
        ...(timeout_ms !== undefined ? { timeout_ms } : {}),
        ...(ctx.runAbortSignal ? { signal: ctx.runAbortSignal } : {}),
        ...(stepMeta ? { stepMeta } : {}),
      });
      throwIfRunKilled(ctx);
      emitGatewayAudit(ctx, {
        ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
        outcome: 'success',
        duration_ms: Date.now() - started,
      });
      return result;
    }

    if (!execInput) {
      throw new Error(
        `D-165 gateway: operation '${resolution.operation_id}' had no API dispatch input after CLI dispatch narrowing.`,
      );
    }
    // `execInput` is defined ⇒ `protocolEx` + `binding` were both resolved above
    // (the only path that builds it); narrow for the type-checker + fail closed
    // if that invariant is ever violated (unreachable).
    if (protocolEx === undefined || binding === undefined) {
      throw new Error(
        `D-165 gateway: operation '${resolution.operation_id}' has a dispatch input but no protocol executor (unreachable).`,
      );
    }

    // D-192 Gate E′ Gap 4a — pre-dispatch protocol hook (rest read-tier page size).
    normalizeCatalogDispatchInput(manifest, call.operation_id, execInput, resolution.effective_risk_tier);
    // A future protocol hook must not rewrite an adapter-owned callback field
    // after the initial catalog lowering check above.
    operationBoundDispatch?.validateDispatchInput(execInput);
    operationBoundFailurePhase = 'provider';

    const firstResult = await ctx.ingredientExecutor(
      slug, execInput, output, stepOptions, providerSurfaceMeta,
    );
    throwIfRunKilled(ctx);

    // D-192 Gate E′ Gap 4a — response adaptation through the SAME protocol entry
    // that built the dispatch (graphql fail-when-data-null envelope; rest
    // response_capture-or-pagination). The entry returns a NORMALIZED outcome;
    // audit emission + the throw stay HERE so no protocol touches the audit sink
    // or the `failureAudited` flag, and the success/fail audit rows are emitted
    // from ONE place each. A `fail` outcome carries the specific `failure_mode`
    // (graphql_error / no_file_ingestor) so the catch-all below does not emit a
    // second generic `error` row for the same throw.
    const adapted = await protocolEx.adaptResponse({
      binding,
      firstResult,
      firstExecInput: execInput,
      ctx,
      manifest,
      call,
      resolution,
      slug,
      output,
      stepOptions,
      surfaceMeta: providerSurfaceMeta,
      stepMeta,
      args: dispatchArgs,
      connectionName,
      connectionBaseUrl,
    });
    throwIfRunKilled(ctx);
    if (adapted.kind === 'fail') {
      emitGatewayAudit(ctx, {
        ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
        outcome: 'failed',
        failure_mode: adapted.failure_mode,
        duration_ms: Date.now() - started,
      });
      failureAudited = true;
      // The step runner reads `.code` off a thrown error and uses it in place of
      // its `NETWORK_ERROR` default (see `step-runner.ts` adapterCode), so the
      // classification survives all the way to the caller instead of stopping at
      // the audit row.
      throw Object.assign(new Error(adapted.message), adapted.error_code !== undefined
        ? { code: adapted.error_code }
        : {});
    }
    const projectedResult = operationBoundDispatch === undefined
      ? adapted.result
      : await operationBoundDispatch.projectResult(adapted.result);
    throwIfRunKilled(ctx);
    emitGatewayAudit(ctx, {
      ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
      outcome: 'success',
      duration_ms: Date.now() - started,
      ...(adapted.pages_fetched !== undefined ? { pages_fetched: adapted.pages_fetched } : {}),
      ...(adapted.truncated ? { truncated: true } : {}),
    });
    return projectedResult;
  } catch (e) {
    // A preflight pause raised downstream (e.g. the commit gateway around
    // `ingredientExecutor`) is control flow, not a failed call — re-throw
    // without auditing it as an execution failure.
    if (isPreflightRequiredSignal(e)) throw e;
    // A failure that already emitted its specific-failure_mode audit above
    // (graphql_error / no_file_ingestor) does not get a second generic row.
    if (!failureAudited) {
      emitGatewayAudit(ctx, {
        ...auditBase(slug, call, resolution, ctx, stepMeta, auditArgHash),
        outcome: 'failed',
        failure_mode: 'error',
        duration_ms: Date.now() - started,
      });
    }
    throw operationBoundDispatch === undefined
      ? e
      : operationBoundDispatch.projectError(e, operationBoundFailurePhase);
  }
};

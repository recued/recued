/** Ingredient dispatcher — the factory that turns a closed-set
 *  per-kind adapter registry into a unified `IngredientExecutor`.
 *
 *  Adapter implementations live across packages:
 *    - `executeHTTP(manifest, input)`     for REST/HTTP ingredients
 *    - `executeDOM(manifest, input, ctx)` for page-scraping / DOM writes
 *    - `executeMCP(manifest, input)`      for Model Context Protocol servers
 *    - `executeLLM(manifest, input, deps)` (from @recued/llm) for AI functions
 *    - `createChatAdapter(deps)`          for web chat write→poll→read cycles
 *    - `createKernelAdapter(deps)`        for kernel-author ingredients
 *
 *  Each has a slightly different shape. The engine expects one uniform
 *  `(slug, input) → Promise<unknown>` executor. This module bridges the
 *  two: given a manifest loader and a closed-set per-kind adapter
 *  registry (D-126 P2.3), it returns a single `IngredientExecutor`
 *  that routes each call to the right adapter based on the manifest's
 *  required `kind` field (D-126 P1.1).
 *
 *  Routing rules (D-126 P2.3):
 *    1. `isKernelManifest(manifest)` (author === `recued`) → kernel
 *       adapter (passed separately as `kernelAdapter`). The kernel
 *       adapter routes internally by slug. Wins over per-kind routing
 *       for kernel-authored ingredients regardless of their stamped
 *       `kind` (today maps to `service` / `storage` / `mcp` per §A.5).
 *    2. Otherwise → `adapterRegistry[manifest.kind]`. Closed-set lookup
 *       — every kind has an entry by construction
 *       (`createAdapterRegistry` from `@recued/engine` populates
 *       unsupported kinds with placeholders that throw with kind-named
 *       diagnostics, surfacing routing problems at call time instead of
 *       silently undefined).
 *
 *  No more shape inference (`pickAdapter`) — `manifest.kind` is the
 *  single source of routing truth post-D-126 P2.2. Pre-launch zero
 *  installs means no inference shim per
 *  `feedback_pre_launch_no_migration.md`.
 *
 *  Dependency injection: the caller constructs the registry up-front
 *  (typically via `createAdapterRegistry(deps)` in the boot site).
 *  Tests pass a hand-built `Record<IngredientKind, Adapter>` directly. */

import type { IngredientKind, IngredientManifest, StepMeta } from '@recued/contracts';
import { isKernelManifest, isLockedInputKey } from '@recued/contracts';
import { IngredientError, type IngredientExecutor, type ManifestLoader, type ResolvedCall } from './types.js';
import {
  RECEPTION_LOCAL_BASE_URL,
  RECEPTION_MATERIALIZE_SLUG,
} from './kernel.js';

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** D-112 — belt-and-suspenders defence. parseRecipe already errors on
 *  locked-key overrides (`LOCKED_INPUT_KEY`), but bundled recipes +
 *  hand-assembled step input that bypass the validator must also be
 *  neutralised before the merge reaches the executor. Silent drop is
 *  intentional: parseRecipe already surfaced the user-facing message;
 *  at dispatch time we log and strip.
 *
 *  Step-input keys are UNTRUSTED, so the locked-key check lowercases first —
 *  `isLockedInputKey` is case-sensitive by contract, and HTTP header names are
 *  case-insensitive, so `header.Authorization` must still strip. */
const filterInputKeys = (
  stepInput: Record<string, unknown>,
  opts: { stripLocked: boolean },
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stepInput)) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(key)) continue;
    if (opts.stripLocked && isLockedInputKey(key.trim().toLowerCase())) continue;
    out[key] = value;
  }
  return out;
};

/** Adapter signature — receives a fully resolved call, performs transport.
 *  Adapters never reference the raw manifest. LLM's `deps` and DOM's `ctx`
 *  are bound by the caller at factory time. */
export type Adapter = (resolved: ResolvedCall) => Promise<unknown>;

/** The ONE manifest-defaults + step-input merge the dispatch layer performs
 *  before ref resolution (step wins; D-112 locked keys stripped from the
 *  UNTRUSTED step side unless the catalog gateway marked the dispatch
 *  trusted). Exported (D-177 P1b, codex P1 fold) so the commit Gateway's
 *  action-identity hash basis is computed over the SAME payload the adapter
 *  will see — a connection wrapper's `connection: '{{config.x}}'` picker
 *  lives in MANIFEST defaults, so hashing the bare step input would let an
 *  exact-repeat grant keep matching after the picker re-aims. One merge,
 *  two consumers — the executor below and the host's hash-basis closure. */
export const mergeManifestStepInput = (
  manifestInput: Record<string, unknown> | undefined,
  stepInput: Record<string, unknown>,
  opts: { trustedSurfaceDispatch: boolean },
): Record<string, unknown> => ({
  ...filterInputKeys(manifestInput ?? {}, { stripLocked: false }),
  ...filterInputKeys(stepInput, { stripLocked: !opts.trustedSurfaceDispatch }),
});

/** ⛔⛔ A manifest's `null` is a PLACEHOLDER, not a value.
 *
 *  A manifest declares an optional input with the value `null`, meaning "this
 *  input exists and has no default". `mergeManifestStepInput` spreads it under the
 *  step's args, so an input the caller OMITTED reached the adapter as `null`,
 *  indistinguishable from a `null` the caller wrote. Handlers read that `null` as a
 *  value. The 2026-09-24 audit of every kernel step found:
 *  - paid time-limited passes granted as PERMANENT access (`period_end: null` means
 *    open-ended), and plan changes refused for Stripe, Paddle and Lemon Squeezy
 *    customers;
 *  - `calendar-list` filtering `calendar_id = NULL`, so 11 shipped recipes read an
 *    empty calendar, and `link-list` / `annotation-list` / `annotation-search`
 *    matching nothing;
 *  - every shipped `project-create`, `project-update` and `work-entity-list` step
 *    throwing;
 *  - `booking-update` wiping the appointment slot.
 *
 *  Where the caller WRITES `null` it is theirs, and some handlers give it a meaning
 *  (seller `period_end` and `email`: open-ended or clear; `shared-compare-and-set`
 *  `expected_revision`: create only). So only the placeholders go: a key the manifest
 *  declares `null` that the step did not supply. A step value that resolves to
 *  `null` is the caller's and stays.
 *
 *  🔑 This shapes only what the KERNEL adapter receives (see the call site). The
 *  Gateway's action-identity basis applies it too, for the kernel slot, so the
 *  action an approval names is the one that runs (`actionIdentityBasis`, server).
 *  ⛔ It first kept the placeholders "so an approval made before this still
 *  matches", and then "omitted" and "explicitly null" hashed alike while running
 *  differently: one approval admitted a seller pass with the package's length and
 *  a permanent one (integrity audit, 2026-09-24). */
export const withoutManifestPlaceholders = (
  input: Record<string, unknown>,
  manifestInput: Record<string, unknown> | undefined,
  stepInput: Record<string, unknown>,
): Record<string, unknown> => {
  let out: Record<string, unknown> | undefined;
  for (const [key, declared] of Object.entries(manifestInput ?? {})) {
    if (declared !== null || input[key] !== null) continue;
    if (Object.prototype.hasOwnProperty.call(stepInput, key)) continue;
    out ??= { ...input };
    delete out[key];
  }
  return out ?? input;
};

/** Output selectors can be effects for DOM/chat adapters. Preparation must
 * pin the same merged mapping that the real adapter receives. */
export const mergeManifestStepOutput = (
  manifestOutput: Record<string, string> | undefined,
  stepOutput?: Record<string, string>,
): Record<string, string> => stepOutput
  ? { ...(manifestOutput ?? {}), ...stepOutput } : (manifestOutput ?? {});

/** Resolve which dispatch slot a manifest routes to. Kernel-author
 *  ingredients take the `kernel` slot regardless of their `kind`
 *  (the kernel adapter routes internally by slug); everything else
 *  routes by `manifest.kind`. Exported so tests and diagnostic tooling
 *  can check routing decisions without running the executor. Pure
 *  function — same input yields same output.
 *
 *  D-125 P3.1 carve-out: `kind: 'connection'` always routes through the
 *  `connection` adapter, even when authored by `recued`. The kernel
 *  `connection` direct-adapter-access ingredient
 *  (`{slug:'connection', author:'recued', kind:'connection'}`) and any
 *  third-party wrapper (`{kind:'connection', author:any}`) share the
 *  same adapter — recipes calling either land at the same dispatch
 *  shell, with `permission` + `risk_tier` enforced per-manifest at the
 *  engine layer. The carve-out is intentional + narrow: it fires only
 *  on the literal `connection` kind, leaving every other kernel-
 *  authored manifest (notification-send, enrichment-upsert, calendar-
 *  list, …) on the kernel slot. AI manifests likewise use the AI adapter:
 *  the bundled ai-* and core-ai-* manifests have no kernel switch case and
 *  must reach the shared provider executor, including its file-read gates.
 *  The bundled dom-read/dom-write likewise use the real DOM adapter; the
 *  kernel switch has no DOM implementation. */
export type DispatchSlot = IngredientKind | 'kernel';

export const resolveDispatchSlot = (manifest: IngredientManifest): DispatchSlot => {
  if (manifest.kind === 'connection' || manifest.kind === 'ai' || manifest.kind === 'dom') return manifest.kind;
  return isKernelManifest(manifest) ? 'kernel' : manifest.kind;
};

/** D-173 P1-dispatch — the wire keys the D-165 catalog gateway folds onto the
 *  surface-dispatch input on top of the operation's `args` (the binding's
 *  protected method/path/connection triple, per `buildApiDispatchInput`). A
 *  reception-local materialize is re-routed to the `reception-materialize`
 *  kernel ingredient, which consumes the projection-shaped `args` directly —
 *  so these gateway-added keys are stripped first to recover the clean
 *  `ReceptionMaterializeInput` the recipe step authored as `args`. `query.*`
 *  / `header.*` / `body.*` prefixed keys (not present on a reception op, but
 *  defensive) are dropped too: they are HTTP-transport projections, never
 *  projection-input fields. */
const GATEWAY_WIRE_KEYS = new Set(['method', 'path', 'connection', 'connection_kind']);
const isGatewayWireKey = (key: string): boolean =>
  GATEWAY_WIRE_KEYS.has(key)
  || key.startsWith('query.')
  || key.startsWith('header.')
  || key.startsWith('body.');

/** D-173 P1-dispatch — does this dispatch target a reception-local catalog
 *  op? True only when the call is a TRUSTED catalog-gateway surface dispatch
 *  (`stepMeta.surface_dispatch`, set strictly by the gateway — a recipe can
 *  never forge it, see `buildStepMeta`) AND the resolved manifest's api
 *  surface carries the local-only `https://reception.local` sentinel
 *  base_url. Both conditions are required: the surface_dispatch marker proves
 *  the call already passed the D-157 gate hold (the gate runs upstream in
 *  `runCatalogOperation`, before this dispatch leg), and the sentinel scopes
 *  the re-route to reception ops only — every other catalog op (HubSpot,
 *  Salesforce, …) keeps its HTTP connection-adapter dispatch. */
const isReceptionLocalSurfaceDispatch = (
  manifest: IngredientManifest,
  stepMeta: StepMeta | undefined,
): boolean =>
  stepMeta?.surface_dispatch === true
  && manifest.surfaces?.api?.default_base_url === RECEPTION_LOCAL_BASE_URL;

/** D-173 P1-dispatch — recover the projection input from the gateway's
 *  surface-dispatch input by dropping the gateway-added wire keys. The
 *  remaining keys are the operation's `args` (the recipe step's
 *  `{{context.event.payload}}` resolved + any `arg_overrides` the engine
 *  merged on approve-resume) — i.e. the `ReceptionMaterializeInput` the
 *  kernel dispatcher validates. */
const extractReceptionMaterializeInput = (
  resolvedInput: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resolvedInput)) {
    if (isGatewayWireKey(key)) continue;
    out[key] = value;
  }
  return out;
};

export interface IngredientDispatchOptions {
  manifestLoader: ManifestLoader;
  /** Closed-set per-kind adapter registry. Constructed by the boot
   *  site via `createAdapterRegistry` from `@recued/engine`. Every
   *  kind in `IngredientKind` has an entry — kinds the runtime doesn't
   *  support carry placeholders that throw with kind-named diagnostics.
   *  Tests pass a hand-built `Record<IngredientKind, Adapter>` (or any
   *  partial shape covering only the kinds the test exercises — the
   *  type permits a partial map, missing kinds throw
   *  `INGREDIENT_ADAPTER_ALL_FAILED` at call time). */
  adapterRegistry: Partial<Record<IngredientKind, Adapter>>;
  /** Kernel adapter for ingredients authored by the reserved `recued`
   *  publisher (kernel namespace), checked via `isKernelManifest`.
   *  Server runtime dispatches to the shared-store directly; ext
   *  runtime rpcs to the paired server. Takes precedence over
   *  per-kind routing. Omit when the runtime has no kernel
   *  dispatchers wired — kernel calls then surface
   *  `INGREDIENT_ADAPTER_ALL_FAILED` with `kind: 'kernel'`. */
  kernelAdapter?: Adapter;
  /** Resolve value references ({{vault.*}}, {{config.*}}) in the merged
   *  input. Called after manifest + step input merge so manifest defaults
   *  containing refs are resolved too. */
  resolveRefs?: (obj: Record<string, unknown>) => Record<string, unknown>;
}

/** Build an IngredientExecutor that routes by manifest.
 *
 *  @example
 *    import { createIngredientExecutor } from '@recued/ingredients';
 *    import { createAdapterRegistry } from '@recued/engine';
 *
 *    const registry = createAdapterRegistry({
 *      http: executeHTTP,
 *      mcp: executeMCP,
 *      dom: (call) => executeDOM(call, domCtx),
 *      ai:  (call) => executeLLM(callToManifest(call), call.input, llmDeps),
 *    });
 *
 *    const executor = createIngredientExecutor({
 *      manifestLoader: loadFromRegistry,
 *      adapterRegistry: registry,
 *      kernelAdapter: createKernelAdapter(kernelDispatchers),
 *    });
 *
 *    // Engine consumes executor directly
 *    await executeRecipe({ recipe, stores, ingredientExecutor: executor });
 */
export const createIngredientExecutor = (
  options: IngredientDispatchOptions,
): IngredientExecutor => async (slug, stepInput, stepOutput, _stepOptions, stepMeta) => {
  // `stepOptions` is consumed by the cache wrapper layer above, not here.
  // `stepMeta` (D-113 step identity, D-127 follow-on adds `recipe_id`) is
  // forwarded onto the `ResolvedCall` envelope so adapters that emit
  // per-call audit rows (kernel `mail-send`) can attribute back to the
  // originating step. Adapters that don't care leave the field untouched.
  const manifest = await options.manifestLoader(slug);
  if (!manifest) {
    throw new IngredientError(
      'INGREDIENT_NOT_FOUND',
      `No manifest found for ingredient slug '${slug}'`,
      { slug },
    );
  }

  // Merge input: manifest defaults + step overrides (step wins).
  // D-112: strip engine-locked keys from step input before merge so
  // recipes that bypassed parseRecipe can't override `url` / `method`
  // / `header.host` / `header.authorization` / `header.cookie`.
  //
  // D-165 RUNTIME exception: a catalog-gateway surface dispatch
  // (`stepMeta.surface_dispatch`) carries the catalog binding's TRUSTED
  // `method` / `path` as step input. The gateway has already stripped locked
  // keys from the recipe-supplied args, so re-stripping here would only filter
  // the binding's own `method` back out. Honor the marker — set strictly by the
  // gateway (`buildStepMeta` never copies it from recipe JSON, so a recipe
  // cannot forge a lock bypass).
  const trustedSurfaceDispatch = stepMeta?.surface_dispatch === true;
  const riskTier = trustedSurfaceDispatch && stepMeta.surface_risk_tier !== undefined
    ? stepMeta.surface_risk_tier : manifest.risk_tier;
  const mergedInput = mergeManifestStepInput(manifest.input, stepInput, {
    trustedSurfaceDispatch,
  });
  const resolvedInput = options.resolveRefs
    ? options.resolveRefs(mergedInput)
    : mergedInput;

  // Merge output: manifest base + step extensions (step wins)
  const mergedOutput = mergeManifestStepOutput(manifest.output, stepOutput);

  // D-173 P1-dispatch — LOCAL re-route for a reception catalog op's
  // `materialize`. The D-165 catalog gateway has already RESOLVED the gate
  // (deny / path-scope / ask) upstream in `runCatalogOperation` and only
  // reaches THIS dispatch leg on `admit` (a fresh approved run) or a
  // resumed-admitted run — i.e. the inbox has approved the held op. For a
  // reception core-pack op the gateway built an HTTP surface dispatch against
  // the local-only `https://reception.local` sentinel; rather than call that
  // dead host through the connection adapter, route the (edit-merged)
  // projection args to the `reception-materialize` kernel ingredient, which
  // materialises the canonical entity through its destination Source in
  // process. The gate-hold is NON-NEGOTIABLE and UNTOUCHED: it fired (or held)
  // in the gateway BEFORE this leg — this branch never sees an un-approved op
  // (a fresh `ask` threw `PreflightRequiredSignal` and ended the run without
  // ever calling the executor). `surface_dispatch` is the proof the call came
  // through the gateway (a recipe cannot forge it — `buildStepMeta` sets it
  // strictly), so a plain recipe step naming a reception catalog ingredient
  // can NEVER reach this re-route to bypass the gate.
  if (
    options.kernelAdapter
    && isReceptionLocalSurfaceDispatch(manifest, stepMeta)
  ) {
    // The kernel `reception-materialize` slug consumes the projection-shaped
    // `args` directly; strip the gateway-added wire keys (method/path/
    // connection/connection_kind) so the kernel dispatcher validates a clean
    // `ReceptionMaterializeInput`. The kernel adapter's own switch case
    // narrows + validates the shape (BAD_INPUT on a missing top_tier_kind /
    // id / title), so no input typing is asserted here.
    const receptionCall: ResolvedCall = {
      slug: RECEPTION_MATERIALIZE_SLUG,
      risk_tier: riskTier,
      input: extractReceptionMaterializeInput(resolvedInput),
      output: mergedOutput,
      ...(stepMeta ? { stepMeta } : {}),
    };
    return options.kernelAdapter(receptionCall);
  }

  // `reception-materialize` is the INTERNAL sink of the trusted branch above,
  // not a recipe-callable kernel capability. A plain ingredient step naming
  // the slug would otherwise jump directly to `runReceptionProjection` and
  // skip the catalog gateway's D-157 approval hold entirely. The legitimate
  // path never loads this manifest: it loads the reception catalog manifest,
  // proves `surface_dispatch`, then invokes the kernel adapter with a synthetic
  // call and returns above. Reject every manifest-loaded call here, including a
  // hand-built caller that tries to supply an engine-only StepMeta marker.
  if (manifest.slug === RECEPTION_MATERIALIZE_SLUG) {
    throw new IngredientError(
      'INGREDIENT_INTERNAL_ONLY',
      `Ingredient '${RECEPTION_MATERIALIZE_SLUG}' is an internal approval-resume dispatch target and cannot be invoked directly`,
      { slug: RECEPTION_MATERIALIZE_SLUG },
    );
  }

  const slot = resolveDispatchSlot(manifest);
  const adapter = slot === 'kernel'
    ? options.kernelAdapter
    : options.adapterRegistry[manifest.kind];

  if (!adapter) {
    throw new IngredientError(
      'INGREDIENT_ADAPTER_ALL_FAILED',
      `Ingredient '${slug}' requires the '${slot}' adapter, but no adapter is registered for that kind`,
      { slug, kind: slot, available: collectAvailableKinds(options) },
    );
  }

  const resolved: ResolvedCall = {
    slug: manifest.slug,
    risk_tier: riskTier,
    // Kernel steps only: their handlers are where the placeholder nulls did harm.
    // The provider adapters (ai, http, mcp, dom) were audited null-safe, and a
    // pre-approval checks that each provider call's input hashes EXACTLY to the one
    // it reviewed, which was built with the placeholders (`preapproval-execution`
    // `validateProvider`). Stripping theirs would refuse every pre-approved run.
    input: slot === 'kernel'
      ? withoutManifestPlaceholders(resolvedInput, manifest.input, stepInput)
      : resolvedInput,
    output: mergedOutput,
    fallback: manifest.fallback,
    ...(stepMeta ? { stepMeta } : {}),
  };

  return adapter(resolved);
};

/** Diagnostic helper: enumerate the kinds the registry has wired
 *  (plus 'kernel' if the kernel adapter is present). Surfaced on
 *  `INGREDIENT_ADAPTER_ALL_FAILED` errors so the message tells the
 *  user which adapters ARE available — quicker triage than "X is
 *  missing." */
const collectAvailableKinds = (options: IngredientDispatchOptions): string[] => {
  const out: string[] = Object.keys(options.adapterRegistry);
  if (options.kernelAdapter) out.push('kernel');
  return out;
};

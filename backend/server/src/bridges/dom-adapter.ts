/** D-169 P0 follow-on — DOM-ingredient runner consumer.
 *
 *  The first production caller of `BridgeDispatcher.dispatch(...)`. Sits
 *  in the engine's adapter registry as the `dom` slot on the server
 *  runtime and bridges between the engine's `ResolvedCall` envelope and
 *  the dispatcher's `DispatchRequest` shape. Without this slice the D-169
 *  P0 stack composes correctly but has no caller — DOM ingredients route
 *  to `unsupported('dom', ...)` and surface `INGREDIENT_ADAPTER_ALL_FAILED`.
 *
 *  Per-entry dispatch model. The bridge SW's content-script executor
 *  (`apps/bridge/src/actions/executor.ts`) consumes ONE
 *  `(action, selector, [value])` per `BridgeCommand` — `read_dom` returns
 *  `{ text }`, `fill` returns `{ filled: true }`, `click` returns
 *  `{ clicked: true }`. The recipe-level DOM ingredient's `output` map
 *  encodes MULTIPLE selectors (one per field name). To bridge this
 *  contract gap, the runner iterates the output map and emits one
 *  `BridgeCommand` per non-trigger entry — sequential roundtrips, but
 *  matches the bridge SW's flat-args expectation exactly. Aggregation
 *  follows `packages/ingredients/src/dom.ts:executeDOM`'s shape:
 *
 *    - reads only           → `Record<string, string | null>`
 *    - writes only          → `{ written, fields, failed }`
 *    - clicks only          → `{ clicked: N }`
 *    - any mixed shape      → `{ reads?, writes?, clicked? }`
 *
 *  Output entry → BridgeAction:
 *
 *    - value `"trigger"`              → URL pattern (drives target_domain_pattern;
 *                                       skipped in per-entry iteration)
 *    - value starts with `"dom."`     → `fill` — input field name follows the prefix;
 *                                       value pulled from `input[<field>]`
 *    - value `"click"` / `"enter"`    → `click` (no extra args needed)
 *    - anything else                  → `read_dom`; the value becomes the field
 *                                       name on the aggregated step output
 *
 *  Idempotency. The dispatcher's `idempotency_key` is the bridge's
 *  24h dedup primary — a retry of the SAME logical step should hit the
 *  bridge's idempotency cache and replay the prior result. The runner
 *  builds a STABLE per-entry key from `recipe_id:step_id:slug:entry_index`
 *  + a SHA-256 of the resolved input + the entry key/value pair, so:
 *
 *    - same step + same input on retry → same key → bridge replays
 *    - distinct steps + distinct inputs → distinct keys → fresh dispatches
 *
 *  Late binding. The dispatcher is composed inside `createWebSocketUpgrade`
 *  AFTER the executor is built. The adapter receives a `getDispatcher`
 *  thunk so the boot site can publish the live dispatcher after the WS
 *  binding is wired (parallel to `lateBound.publishExecuteDeps`). When
 *  the thunk returns undefined (test compositions without ws-server, or
 *  bridgeRegistry-less daemon paths), the adapter throws
 *  `ROLE_RESTRICTION` — same posture as the registry's default
 *  `unsupported('dom', ...)` placeholder.
 *
 *  Spec: docs/d-169-spec.md § N.3 (per-command authority retirement),
 *  § N.9 / A.8 (multi-bridge fall-through); composes with the dispatcher
 *  from `backend/server/src/bridges/dispatcher.ts` (`ce5bb9a3`). */

import { createHash } from 'node:crypto';

import type {
  BridgeAction,
  BridgeIngredientRef,
  BridgeResult,
  BridgeSurfaceKind,
  IngredientManifest,
} from '@recued/contracts';
import {
  IngredientError,
  type Adapter,
  type ResolvedCall,
} from '@recued/ingredients';
import type {
  BridgeDispatcher,
  DispatchOutcome,
  DispatchRequest,
} from './dispatcher.js';

/** Minimal manifest-registry contract the adapter needs. Mirrors the
 *  shape of `backend/server/src/manifest-loader.ts:ManifestRegistry` but
 *  declared inline so the adapter doesn't pull the whole module surface.
 *  Tests pass a hand-built `{ get }` object. */
export interface DomBridgeManifestSource {
  get(slug: string): IngredientManifest | null;
}

export interface CreateBridgeDomAdapterOptions {
  /** Synchronous manifest lookup. Throws `INGREDIENT_NOT_FOUND` from
   *  the engine's dispatch layer before reaching the adapter; this
   *  defensive read returns null only when the dispatch layer is
   *  bypassed (tests, direct rpc paths). */
  manifests: DomBridgeManifestSource;
  /** Late-bound dispatcher accessor. Resolved at every call so the
   *  boot site can publish the live dispatcher after the WS binding is
   *  built. Returns undefined when no bridge runtime is wired (test
   *  compositions, dbless harnesses); the adapter then throws
   *  `ROLE_RESTRICTION` matching the registry's default unsupported
   *  posture for browser-only ingredients on a server runtime. */
  getDispatcher: () => BridgeDispatcher | undefined;
  /** Per-call timeout override (ms). Forwarded as `request.timeout_ms`
   *  on every dispatch; the dispatcher clamps to
   *  `[1, BRIDGE_COMMAND_MAX_TIMEOUT_MS]` and falls through to the
   *  default when undefined. Optional — most callers leave it absent
   *  so the bridge's default kicks in. */
  defaultTimeoutMs?: number;
}

const DOM_WRITE_PREFIX = 'dom.';
const DOM_TRIGGER_MARKER = 'trigger';
const DOM_CLICK_MARKER = 'click';
const DOM_ENTER_MARKER = 'enter';

// ── D-182 "core.dom" — the Tier-K kernel DOM-action ops. Unlike a per-tool DOM
//    ingredient (which bakes the selector→field map into its manifest `output`),
//    `core.dom.{read,write}` lower to these two backing slugs and carry the
//    selectors/target/value as op ARGS. The adapter synthesizes the per-entry
//    dispatch directly from those args (no manifest output map), then reuses the
//    same per-entry dispatch loop / idempotency / assembly as the manifest path.
const CORE_DOM_READ_SLUG = 'dom-read';
const CORE_DOM_WRITE_SLUG = 'dom-write';
/** The synthetic input field a `core.dom.write` fill entry pulls its value from
 *  (`buildArgsForEntry` reads `input[<marker after "dom.">]`). Underscore-fenced
 *  so it never collides with a real recipe field. */
const CORE_DOM_VALUE_FIELD = '__core_dom_value';

const isCoreDomSlug = (slug: string): boolean =>
  slug === CORE_DOM_READ_SLUG || slug === CORE_DOM_WRITE_SLUG;

/** Pull a required non-empty string arg off a `core.dom` op's resolved input. */
const reqDomArg = (
  input: Record<string, unknown>,
  key: string,
  slug: string,
): string => {
  const v = input[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new IngredientError(
      'DOM_SELECTOR_MISSING',
      `core.dom op '${slug}' requires a non-empty '${key}' arg`,
      { slug, key },
    );
  }
  return v;
};

/** Synthesize the `{ domain_allowlist, entries, input }` a `core.dom.{read,write}`
 *  call dispatches, from its op args — the arg-driven counterpart to the manifest
 *  `output`-map derivation (`extractDomainAllowlist` + `collectEntries`). The
 *  `target` arg is the actuation domain (the Bridge's `domain_allowlist`); the
 *  per-entry loop then runs exactly as for a manifest DOM ingredient. */
const buildCoreDomCall = (
  slug: string,
  input: Record<string, unknown>,
): { domain_allowlist: string[]; entries: DomEntry[]; input: Record<string, unknown> } => {
  const target = reqDomArg(input, 'target', slug);
  const selector = reqDomArg(input, 'selector', slug);
  // `target` rides in the synthesized input so it folds into the per-entry
  // idempotency hash (`buildIdempotencyKey`) — two distinct calls to the same
  // selector against different domains must not share a Bridge dedup cell. The
  // underscore-fenced key is never read by `buildArgsForEntry` (which only pulls
  // the `dom.<field>` fill value), so it affects the hash only.
  if (slug === CORE_DOM_READ_SLUG) {
    // One read entry; the marker IS the output field name (`text`).
    return {
      domain_allowlist: [target],
      entries: [{ selector, marker: 'text', index: 1 }],
      input: { __core_dom_target: target },
    };
  }
  // core.dom.write — fill `value` into `selector`, then optionally press Enter on
  // `submit_selector` (the web-chat submit pattern). The fill marker is
  // `dom.<CORE_DOM_VALUE_FIELD>`, so `buildArgsForEntry` pulls the value from the
  // synthetic input below.
  const value = reqDomArg(input, 'value', slug);
  const entries: DomEntry[] = [
    { selector, marker: `${DOM_WRITE_PREFIX}${CORE_DOM_VALUE_FIELD}`, index: 1 },
  ];
  const submit = input.submit_selector;
  if (typeof submit === 'string' && submit.length > 0) {
    entries.push({ selector: submit, marker: DOM_ENTER_MARKER, index: 2 });
  }
  return {
    domain_allowlist: [target],
    entries,
    input: { [CORE_DOM_VALUE_FIELD]: value, __core_dom_target: target },
  };
};

interface DomEntry {
  /** Selector — the output map key. */
  selector: string;
  /** Output map value — drives action selection + field-name semantics. */
  marker: string;
  /** 1-based ordinal of the entry's position in the output map (after
   *  filtering out `'trigger'` entries). Used as a stable suffix in the
   *  idempotency key so multiple entries on the same step have distinct
   *  bridge dedup cells. */
  index: number;
}

interface PerEntryOutcome {
  entry: DomEntry;
  action: BridgeAction;
  /** Result.outputs as the bridge returned them. Undefined when the
   *  dispatch produced a non-throwing failure that the caller already
   *  surfaced as an `IngredientError` upstream. */
  outputs: Record<string, unknown> | undefined;
}

/** Build the bridge-runner adapter. Returns an `Adapter` that the
 *  engine's adapter registry installs at the `dom` slot. */
export const createBridgeDomAdapter = (
  options: CreateBridgeDomAdapterOptions,
): Adapter => {
  return async (resolved: ResolvedCall): Promise<unknown> => {
    const dispatcher = options.getDispatcher();
    if (!dispatcher) {
      throw new IngredientError(
        'ROLE_RESTRICTION',
        `DOM ingredient '${resolved.slug}' requires a paired Browser Bridge — none is connected`,
        { slug: resolved.slug, kind: 'dom' },
      );
    }

    const manifest = options.manifests.get(resolved.slug);
    if (!manifest) {
      // Defensive — the engine's dispatch layer (createIngredientExecutor)
      // already throws INGREDIENT_NOT_FOUND before reaching here, so this
      // branch only fires when callers build a ResolvedCall outside the
      // engine path.
      throw new IngredientError(
        'INGREDIENT_NOT_FOUND',
        `No manifest found for DOM ingredient '${resolved.slug}'`,
        { slug: resolved.slug },
      );
    }

    // core.dom.{read,write}: arg-driven — synthesize the allowlist + entries from
    // the op args (no manifest selector map). Otherwise derive them from the DOM
    // ingredient's manifest `output` map as before. `callInput` is what
    // `buildArgsForEntry` / `buildIdempotencyKey` read: the synthetic
    // `{ [CORE_DOM_VALUE_FIELD]: value }` for a core.dom write, else the resolved
    // step input.
    let domain_allowlist: string[];
    let entries: DomEntry[];
    let callInput: Record<string, unknown>;
    if (isCoreDomSlug(resolved.slug)) {
      const built = buildCoreDomCall(resolved.slug, resolved.input);
      domain_allowlist = built.domain_allowlist;
      entries = built.entries;
      callInput = built.input;
    } else {
      domain_allowlist = extractDomainAllowlist(resolved.output);
      if (domain_allowlist.length === 0) {
        throw new IngredientError(
          'DOM_PAGE_NOT_MATCHING',
          `DOM ingredient '${resolved.slug}' declares no trigger URL patterns — bridge dispatch needs at least one`,
          { slug: resolved.slug },
        );
      }

      entries = collectEntries(resolved.output);
      if (entries.length === 0) {
        // Trigger-only manifest with no actionable entries — nothing to
        // dispatch. Empty success matches `executeDOM`'s no-op return.
        return {};
      }
      callInput = resolved.input;
    }

    const ingredient = buildIngredientRef(manifest, domain_allowlist);
    const recipe_run_id = buildRecipeRunId(resolved);
    const step_id = resolved.stepMeta?.step_id ?? resolved.slug;

    // Per-entry sequential dispatch. The bridge SW handles ONE action
    // per command; the recipe-level output map can encode many. Each
    // entry gets its own dispatch + its own bridge idempotency cell.
    const outcomes: PerEntryOutcome[] = [];
    for (const entry of entries) {
      const action = classifyEntryAction(entry);
      const args = buildArgsForEntry(entry, action, callInput, resolved.slug);
      const idempotency_key = buildIdempotencyKey({
        recipe_run_id,
        step_id,
        slug: resolved.slug,
        entry,
        input: callInput,
      });
      const expects_output_keys = expectsKeysForAction(action);

      const request: DispatchRequest = {
        recipe_run_id,
        step_id,
        ingredient,
        action,
        args,
        expects_output_keys,
        idempotency_key,
        ...(options.defaultTimeoutMs !== undefined
          ? { timeout_ms: options.defaultTimeoutMs }
          : {}),
      };

      const outcome = await dispatcher.dispatch(request);
      const outputs = translateDispatchOutcome(outcome, resolved.slug, entry);
      outcomes.push({ entry, action, outputs });
    }

    return assembleStepOutput(outcomes);
  };
};

/** Classify a single output entry into the BridgeAction the bridge SW
 *  executes for it. Pure — no input lookups. Trigger entries are
 *  filtered upstream and never reach this helper. */
export const classifyEntryAction = (entry: DomEntry): BridgeAction => {
  if (entry.marker.startsWith(DOM_WRITE_PREFIX)) return 'fill';
  if (entry.marker === DOM_CLICK_MARKER || entry.marker === DOM_ENTER_MARKER) return 'click';
  return 'read_dom';
};

/** Step-level action precedence preserved for diagnostic / approval
 *  surfaces that want a single category for the whole DOM step (audit
 *  copy, capacity-gap remediation strings). The runner itself dispatches
 *  per-entry — this helper is a separate read for callers that need a
 *  representative action. Precedence is conservative: any write
 *  promotes the whole step to `'fill'`. */
export const classifyDomAction = (
  output: Record<string, string>,
): BridgeAction => {
  let hasFill = false;
  let hasClickOrEnter = false;
  for (const value of Object.values(output)) {
    if (value === DOM_TRIGGER_MARKER) continue;
    if (typeof value === 'string' && value.startsWith(DOM_WRITE_PREFIX)) {
      hasFill = true;
      continue;
    }
    if (value === DOM_CLICK_MARKER || value === DOM_ENTER_MARKER) {
      hasClickOrEnter = true;
      continue;
    }
  }
  if (hasFill) return 'fill';
  if (hasClickOrEnter) return 'click';
  return 'read_dom';
};

/** Iterate the output map, dropping `'trigger'` entries + assigning
 *  stable index numbers for idempotency-key disambiguation. Object.entries
 *  preserves insertion order in modern JS engines, so the index is
 *  deterministic per call across retries with the same manifest. */
const collectEntries = (output: Record<string, string>): DomEntry[] => {
  const out: DomEntry[] = [];
  let index = 0;
  for (const [selector, marker] of Object.entries(output)) {
    if (marker === DOM_TRIGGER_MARKER) continue;
    if (typeof marker !== 'string' || marker.length === 0) continue;
    if (selector.length === 0) continue;
    index++;
    out.push({ selector, marker, index });
  }
  return out;
};

/** Extract URL patterns from the output map. Every entry whose value is
 *  the literal `"trigger"` carries a URL pattern as its key. */
const extractDomainAllowlist = (
  output: Record<string, string>,
): string[] => {
  const out: string[] = [];
  for (const [key, value] of Object.entries(output)) {
    if (value === DOM_TRIGGER_MARKER && key.length > 0) out.push(key);
  }
  return out;
};

/** Closed set of output keys the bridge SW promises for each action.
 *  Threads into `DispatchRequest.expects_output_keys`; bridges that
 *  return out-of-set keys fail their own outbound validation. */
const expectsKeysForAction = (action: BridgeAction): string[] => {
  switch (action) {
    case 'read_dom':
      return ['text'];
    case 'fill':
      return ['filled'];
    case 'click':
      return ['clicked'];
    case 'wait_for_selector':
      return ['present'];
    case 'extract_table':
      return ['rows'];
    case 'screenshot':
      return ['data_url'];
    case 'os_notification':
      return ['notification_id'];
    default:
      return [];
  }
};

/** Build per-entry `args` matching the bridge SW's flat shape:
 *    read_dom / click → `{ selector }`
 *    fill             → `{ selector, value }` (value pulled from input[<field>])
 *
 *  Missing fill values (`input[field]` is null/undefined) raise
 *  `DOM_WRITE_FAILED` — the recipe declared the write but the resolved
 *  input doesn't carry the value. Matches `executeDOM`'s posture of
 *  failing the whole step when at least one write target failed. */
const buildArgsForEntry = (
  entry: DomEntry,
  action: BridgeAction,
  input: Record<string, unknown>,
  slug: string,
): Record<string, unknown> => {
  if (action === 'fill') {
    const field = entry.marker.slice(DOM_WRITE_PREFIX.length);
    const raw = field.length > 0 ? input[field] : undefined;
    if (raw == null) {
      throw new IngredientError(
        'DOM_WRITE_FAILED',
        `DOM ingredient '${slug}' write target '${field}' has no value in step input`,
        { slug, field, selector: entry.selector },
      );
    }
    return { selector: entry.selector, value: String(raw) };
  }
  return { selector: entry.selector };
};

/** Map a bridge-side `BridgeErrorCode` to a recipe-error code. Falls
 *  through to `INGREDIENT_ADAPTER_ALL_FAILED` for codes the catalog
 *  doesn't yet enumerate so a new bridge error variant surfaces with a
 *  legible (not undefined-property) diagnostic. */
const mapBridgeErrorCode = (
  code: BridgeResult['error'] extends infer E
    ? E extends { code: infer C }
      ? C
      : never
    : never,
): string => {
  switch (code) {
    case 'selector_not_found':
      return 'DOM_SELECTOR_NOT_FOUND';
    case 'tab_navigation_blocked':
      return 'DOM_CROSS_ORIGIN';
    case 'capacity_gap_logged_in':
    case 'capacity_gap_tab_unavailable':
    case 'capacity_gap_permission_missing':
      // Per-bridge capacity gaps only surface inside the dispatcher's
      // single-attempt path (preferred_bridge_label). Multi-bridge
      // fall-through aggregates these and emits aggregate_capacity_gap;
      // this branch is the strict-label-mode passthrough.
      return 'ROLE_RESTRICTION';
    case 'authority_invalid':
    case 'authority_expired':
    case 'authority_invalid_grant_scope':
    case 'ingredient_domain_signature_invalid':
      return 'INGREDIENT_SCOPE_INSUFFICIENT';
    case 'idempotency_violation':
    case 'mv3_lifecycle_killed':
    case 'unknown':
    default:
      return 'INGREDIENT_ADAPTER_ALL_FAILED';
  }
};

/** Build the `BridgeIngredientRef` from a manifest. `version` becomes a
 *  string ("1", "2") matching the spec's per-version domain-grant
 *  model; pre-launch manifests with no `version` default to "1". */
const buildIngredientRef = (
  manifest: IngredientManifest,
  domain_allowlist: string[],
): BridgeIngredientRef => {
  const surface_kind: BridgeSurfaceKind = manifest.surface_kind ?? 'reading';
  return {
    slug: manifest.slug,
    publisher_id: manifest.author,
    version: String(manifest.version ?? 1),
    surface_kind,
    domain_allowlist,
    // Pre-launch: publish-time signing isn't wired yet. The bridge's
    // signature gate no-ops on empty strings during the dev window;
    // post-launch this slot is populated by the marketplace validator.
    domain_allowlist_signature: '',
  };
};

/** Build a stable `recipe_run_id`. The engine doesn't yet thread a true
 *  per-invocation run id through `ResolvedCall`/`StepMeta` (separate
 *  follow-on); for v0 we synthesize from `stepMeta.recipe_id`+`step_id`
 *  so audit cross-reference + cancellation routing have a deterministic
 *  prefix to anchor on. The dispatcher's `inflight` map keys by
 *  `command_id` (a per-dispatch random) so colliding run_id strings
 *  across concurrent step retries can't cross-talk on cancel. */
const buildRecipeRunId = (resolved: ResolvedCall): string => {
  const recipe_id = resolved.stepMeta?.recipe_id ?? 'dom';
  const step_id = resolved.stepMeta?.step_id ?? resolved.slug;
  return `${recipe_id}:${step_id}`;
};

/** Build a STABLE idempotency key. Hashed inputs:
 *
 *    - recipe_run_id (deterministic from stepMeta)
 *    - step_id
 *    - slug
 *    - entry.index + entry.selector + entry.marker (per-entry uniqueness)
 *    - resolved.input (input value drift = fresh dedup cell)
 *
 *  Two retries of the SAME logical step produce the SAME key →
 *  the bridge's 24h `idempotency_key → result` cache replays the prior
 *  outcome instead of re-executing the side effect. Input drift (page
 *  context changed, retry with new context) yields a fresh dedup cell.
 *
 *  SHA-256 hex → 16-char prefix is collision-safe for the per-bridge
 *  command space (24h sliding window).
 *
 *  Codex 2026-05-28 Angle 3 fold (DOM-runner consumer slice) — replaces
 *  the per-call random nonce that defeated the idempotency contract. */
const buildIdempotencyKey = (input: {
  recipe_run_id: string;
  step_id: string;
  slug: string;
  entry: DomEntry;
  input: Record<string, unknown>;
}): string => {
  const payload = JSON.stringify({
    recipe_run_id: input.recipe_run_id,
    step_id: input.step_id,
    slug: input.slug,
    entry_index: input.entry.index,
    entry_selector: input.entry.selector,
    entry_marker: input.entry.marker,
    input: input.input,
  });
  const digest = createHash('sha256').update(payload).digest('hex');
  return `${input.recipe_run_id}:${input.entry.index}:${digest.slice(0, 16)}`;
};

/** Translate a `DispatchOutcome` to the bridge result's `outputs` block,
 *  or throw an `IngredientError`. Pure — separated so tests can exercise
 *  the mapping table without spinning up a dispatcher.
 *
 *  Codex 2026-05-28 Angle 1 fold (DOM-runner consumer slice):
 *  unified timeout-flavor mapping — both bridge `status: 'timeout'`
 *  AND dispatcher `outcome.kind === 'timeout'` map to
 *  `INGREDIENT_ADAPTER_ALL_FAILED` with explicit "timed out" messaging.
 *  Pre-fold the bridge path defaulted to the generic recipe code while
 *  the dispatcher path returned the misleading `DOM_SELECTOR_NOT_FOUND`. */
export const translateDispatchOutcome = (
  outcome: DispatchOutcome,
  slug: string,
  entry: DomEntry,
): Record<string, unknown> | undefined => {
  if (outcome.kind === 'completed') {
    const { result } = outcome;
    if (result.status === 'ok') {
      return result.outputs ?? {};
    }
    if (result.status === 'cancelled') {
      throw new IngredientError(
        'ROLE_RESTRICTION',
        `DOM ingredient '${slug}' was cancelled by the bridge (selector '${entry.selector}')`,
        {
          slug,
          status: result.status,
          bridge_client_token_id: outcome.bridge_client_token_id,
          selector: entry.selector,
        },
      );
    }
    if (result.status === 'rejected') {
      throw new IngredientError(
        'INGREDIENT_SCOPE_INSUFFICIENT',
        `DOM ingredient '${slug}' was rejected by the bridge (out of grant scope; selector '${entry.selector}')`,
        {
          slug,
          bridge_client_token_id: outcome.bridge_client_token_id,
          selector: entry.selector,
        },
      );
    }
    if (result.status === 'timeout') {
      throw new IngredientError(
        'INGREDIENT_ADAPTER_ALL_FAILED',
        `DOM ingredient '${slug}' timed out at the bridge (selector '${entry.selector}')`,
        {
          slug,
          bridge_client_token_id: outcome.bridge_client_token_id,
          selector: entry.selector,
          ...(result.error?.code ? { bridge_error_code: result.error.code } : {}),
        },
      );
    }
    // status: 'error'
    const code = result.error?.code;
    const recipe_code = code ? mapBridgeErrorCode(code) : 'INGREDIENT_ADAPTER_ALL_FAILED';
    throw new IngredientError(
      recipe_code,
      result.error?.message ?? `DOM ingredient '${slug}' bridge error (selector '${entry.selector}')`,
      {
        slug,
        bridge_client_token_id: outcome.bridge_client_token_id,
        selector: entry.selector,
        bridge_error_code: code,
        ...(result.error?.detail ? { detail: result.error.detail } : {}),
      },
    );
  }
  if (outcome.kind === 'capacity_gap') {
    throw new IngredientError(
      'ROLE_RESTRICTION',
      `DOM ingredient '${slug}' cannot run — ${outcome.reason} (selector '${entry.selector}')`,
      {
        slug,
        reason: outcome.reason,
        capacity_gap: outcome.capacity_gap,
        selector: entry.selector,
      },
    );
  }
  if (outcome.kind === 'aggregate_capacity_gap') {
    throw new IngredientError(
      'ROLE_RESTRICTION',
      `DOM ingredient '${slug}' cannot run — every paired bridge reported a capacity gap (selector '${entry.selector}')`,
      {
        slug,
        selector: entry.selector,
        bridges: outcome.aggregate.bridges.map((b) => ({
          bridge_id: b.bridge_id,
          bridge_label: b.bridge_label,
          gap_reason: b.gap_reason,
        })),
      },
    );
  }
  // outcome.kind === 'timeout' — server-side wait timeout (bridge never
  // returned in time). Mirror the bridge-side timeout mapping above so
  // recipe error policy treats both timeout flavors uniformly.
  throw new IngredientError(
    'INGREDIENT_ADAPTER_ALL_FAILED',
    `DOM ingredient '${slug}' timed out waiting for the bridge (selector '${entry.selector}')`,
    {
      slug,
      command_id: outcome.command_id,
      attempts: outcome.attempts,
      selector: entry.selector,
    },
  );
};

/** Aggregate per-entry outcomes into the `executeDOM`-shaped step output:
 *
 *    - reads only           → `Record<string, string | null>`
 *    - writes only          → `{ written, fields, failed }`
 *    - clicks only          → `{ clicked: N }`
 *    - any mixed shape      → `{ reads?, writes?, clicked? }`
 *
 *  Mirrors `packages/ingredients/src/dom.ts:executeDOM`'s return shape
 *  so existing recipes that reference `{{step.X.field}}` (reads),
 *  `{{step.X.written}}` (writes), or `{{step.X.clicked}}` (clicks) keep
 *  resolving without recipe changes when their backing manifest's
 *  dispatch flips from the legacy content-script executor to the
 *  bridge runner. */
const assembleStepOutput = (
  outcomes: PerEntryOutcome[],
): unknown => {
  const reads: Record<string, string | null> = {};
  let readsCount = 0;
  const writtenFields: string[] = [];
  const failedFields: string[] = [];
  let writesCount = 0;
  let clickCount = 0;

  for (const o of outcomes) {
    if (o.action === 'read_dom') {
      const fieldName = o.entry.marker; // value-as-field-name, per CLAUDE.md DOM pattern
      const text = o.outputs && typeof o.outputs.text === 'string'
        ? o.outputs.text
        : null;
      reads[fieldName] = text;
      readsCount++;
      continue;
    }
    if (o.action === 'fill') {
      // marker is `dom.<field>` — recover field name for the
      // executeDOM-shaped writes block.
      const field = o.entry.marker.slice(DOM_WRITE_PREFIX.length);
      const filled = o.outputs && o.outputs.filled === true;
      writesCount++;
      if (filled) writtenFields.push(field);
      else failedFields.push(field);
      continue;
    }
    if (o.action === 'click') {
      const clicked = o.outputs && o.outputs.clicked === true;
      if (clicked) clickCount++;
      continue;
    }
  }

  // Match executeDOM's return-shape branching exactly so recipes that
  // referenced legacy step outputs don't need to re-author.
  const hasReads = readsCount > 0;
  const hasWrites = writesCount > 0;
  const hasClicks = clickCount > 0;
  const writeResult = hasWrites
    ? { written: writtenFields.length, fields: writtenFields, failed: failedFields }
    : null;

  if (hasReads && !hasWrites && !hasClicks) return reads;
  if (!hasReads && hasWrites && !hasClicks) return writeResult;
  if (!hasReads && !hasWrites && hasClicks) return { clicked: clickCount };

  return {
    ...(hasReads ? { reads } : {}),
    ...(writeResult ? { writes: writeResult } : {}),
    ...(hasClicks ? { clicked: clickCount } : {}),
  };
};

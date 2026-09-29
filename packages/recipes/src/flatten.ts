/** D-120 Phase 2 — recipe → flattened action summary.
 *
 *  Produces the AI-readable JSON shape the spec defines (
 *  `recipe_insights.flattened` column). The shape captures recipe
 *  *form* only — step ids, ingredients, classified action kinds,
 *  declared input refs, output namespace — never the data flowing
 *  through. Two users running the same recipe form get byte-identical
 *  flattens; cross-user pattern queries (L3+) can join on hash.
 *
 *  Manifest enrichment is optional. Without manifests we produce a
 *  deterministic baseline (slug + heuristic action_kind from slug
 *  shape). With manifests, we narrow the action_kind via `category`
 *  + `risk_tier` and pull `external_call` host out of declared
 *  HTTP / MCP / chat input shapes.
 *
 *  Size cap: serialized bytes are checked against
 *  `RECIPE_INSIGHT_FLATTENED_MAX_BYTES`. Oversize payloads truncate
 *  the per-step `input_refs` array first, then drop step-level extras
 *  (`categories`, `external_call`), then return a marked truncated
 *  envelope as a last resort. Insert paths refuse anything still over
 *  the cap.
 *
 *  Spec: D-120.
 */

import {
  RECIPE_INSIGHT_FLATTENED_MAX_BYTES,
  collectRefs,
  stripCorePrefix,
  type IngredientManifest,
  type RecipeDefinition,
  type RecipeStep,
  type PrefetchStep,
} from '@recued/contracts';
import { extractContextRecipeRefs } from './context-recipe-refs.js';

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const own = (obj: Record<string, unknown>, key: string): unknown =>
  hasOwn(obj, key) ? obj[key] : undefined;

const ownArray = <T>(obj: Record<string, unknown>, key: string): T[] => {
  const value = own(obj, key);
  return Array.isArray(value) ? value as T[] : [];
};

/** Trigger summary for the flatten root.
 *
 *  - `auto_run` — D-115 reactive recipe; carries the interval the
 *    scheduler ticks at.
 *  - `event` — recipe declares warehouse `event_triggers`; carries
 *    only the count (the binding shape itself is recipe-shape too).
 *  - `url` — classic URL-trigger recipe (page-context recipes); we
 *    strip the patterns themselves so two users with the same URL
 *    pattern produce identical hashes.
 *  - `manual` — no auto_run, no event_triggers, no URL trigger.
 *    Classic on-demand recipe. */
export type FlattenedTrigger =
  | { type: 'auto_run'; interval_ms?: number; trigger_step_count: number }
  | { type: 'event'; event_count: number }
  | { type: 'url'; pattern_count: number }
  | { type: 'manual' };

/** Step-level action classification. Distilled from the engine's
 *  step type (`transform`/`guard`/`ingredient`) plus, when a manifest
 *  is available, `category` + `risk_tier`. AI ingredients narrow
 *  further into `ai_function` (contracted) vs `ai_prompt` (escape
 *  hatch). */
export type FlattenedActionKind =
  | 'transform'
  | 'guard'
  | 'read'
  | 'write'
  | 'destructive'
  | 'ai_function'
  | 'ai_prompt'
  | 'external_action';

/** One step in the flattened action summary. Field presence depends
 *  on the step kind: ingredient steps carry `ingredient`; transform
 *  steps carry `transform`; guard steps carry `guard`. The shared
 *  `action_kind` lets downstream consumers reason uniformly.
 *
 *  `input_refs` is the deduped list of fully-qualified refs the step
 *  reads (`data.mail.unread`, `config.threshold`, `step.score`); used
 *  by Phase 3 link emission to know which entities the step touched
 *  before resolution runs. `output_namespace` is always
 *  `step.<step_id>` and is included so consumers can chain
 *  step-to-step writes without parsing the recipe again. */
export interface FlattenedStep {
  step_id: string;
  ingredient?: string;
  transform?: string;
  guard?: string;
  action_kind: FlattenedActionKind;
  input_refs?: string[];
  external_call?: string;
  categories?: string[];
  output_namespace: string;
}

/** Root of the flattened insight payload stored in
 *  `recipe_insights.flattened` (JSON-serialized). Size budget is
 *  `RECIPE_INSIGHT_FLATTENED_MAX_BYTES`; payloads larger than the
 *  budget set `truncated: true` after the size-reduction passes
 *  documented in `flattenRecipe` below. */
export interface FlattenedInsight {
  trigger: FlattenedTrigger;
  steps: FlattenedStep[];
  prefetch_steps?: FlattenedStep[];
  trigger_steps?: FlattenedStep[];
  /** D-120 Phase 4.5 — sorted set of step IDs the recipe reads from
   *  prior-run state via `{{context.recipe.<step_id>}}`. Captured at
   *  install / upgrade so the engine knows what to snapshot at run
   *  end without re-walking the recipe; survives recipe-version
   *  upgrades (overlapping step IDs continue, removed step IDs
   *  orphan their snapshot which next run trims). Omitted entirely
   *  when the recipe doesn't reference the namespace. */
  context_recipe_refs?: string[];
  truncated?: true;
}

/** Optional enrichment input for `flattenRecipe`. Manifests are
 *  looked up by ingredient slug; absent entries fall back to the
 *  no-manifest heuristic path. */
export interface FlattenOptions {
  manifests?: ReadonlyMap<string, IngredientManifest>;
}

/** Pure function — convert a `RecipeDefinition` into the AI-readable
 *  action summary. Same recipe form always produces same output;
 *  manifests change the surface (action_kind narrowing,
 *  external_call host) but never the determinism — the function is
 *  total over `(recipe, manifests)`.
 *
 *  Size handling:
 *    1. Build the full payload (every ref, every category, every
 *       external_call host).
 *    2. Serialize and measure.
 *    3. If over the cap, drop `input_refs` arrays
 *       (highest-volume contributor on ref-heavy recipes).
 *    4. If still over, drop step-level `categories` + `external_call`.
 *    5. If still over, mark `truncated: true` and return.
 *
 *  Insert callers (Phase 2 install hook + Phase 2 backfill) check
 *  the post-truncation size against the cap and refuse anything
 *  still over — pathological recipes shouldn't bloat the table. */
export const flattenRecipe = (
  recipe: RecipeDefinition,
  opts: FlattenOptions = {},
): FlattenedInsight => {
  const manifests = opts.manifests;
  const recipeRecord = recipe as unknown as Record<string, unknown>;
  const flattenedSteps = ownArray<RecipeStep>(recipeRecord, 'steps').map((s) =>
    flattenStep(s, manifests),
  );
  const flattenedPrefetch = ownArray<PrefetchStep>(recipeRecord, 'prefetch_steps').map((s) =>
    flattenStep(s, manifests),
  );
  const flattenedTriggerSteps = ownArray<RecipeStep | PrefetchStep>(recipeRecord, 'trigger_steps').map((s) =>
    flattenStep(s, manifests),
  );

  const insight: FlattenedInsight = {
    trigger: deriveTrigger(recipe),
    steps: flattenedSteps,
  };
  if (flattenedPrefetch.length > 0) insight.prefetch_steps = flattenedPrefetch;
  if (flattenedTriggerSteps.length > 0) insight.trigger_steps = flattenedTriggerSteps;

  // D-120 Phase 4.5 — `context.recipe.*` snapshot manifest. Empty
  // for the vast majority of recipes; only digest / pipeline / cross-
  // run-aware shapes reference the namespace at all. Stored alongside
  // the flattened payload so the engine can read it at run end without
  // a second recipe walk.
  const contextRecipeRefs = extractContextRecipeRefs(recipe);
  if (contextRecipeRefs.length > 0) insight.context_recipe_refs = contextRecipeRefs;

  return shrinkToFit(insight);
};

/** Serialize + size-check a flattened insight. Convenience wrapper
 *  for callers that want both the JSON string and the byte count
 *  without a second JSON.stringify pass. */
export const serializeFlattenedInsight = (
  insight: FlattenedInsight,
): { json: string; bytes: number; over_cap: boolean } => {
  const json = JSON.stringify(insight);
  // Byte length is what bounds the SQLite TEXT column (UTF-8 stored).
  // Use TextEncoder when available so multi-byte characters cost what
  // SQLite actually stores; fall back to length on environments that
  // lack the encoder (legacy callers — never hit in our supported
  // runtimes but cheap insurance).
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const bytes = encoder ? encoder.encode(json).length : json.length;
  return { json, bytes, over_cap: bytes > RECIPE_INSIGHT_FLATTENED_MAX_BYTES };
};

// ────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────

const deriveTrigger = (recipe: RecipeDefinition): FlattenedTrigger => {
  const recipeRecord = recipe as unknown as Record<string, unknown>;
  const autoRun = own(recipeRecord, 'auto_run');
  const triggerSteps = ownArray<RecipeStep | PrefetchStep>(recipeRecord, 'trigger_steps');
  if (autoRun && typeof autoRun === 'object' && !Array.isArray(autoRun)) {
    const intervalMs = own(autoRun as Record<string, unknown>, 'interval_ms');
    return {
      type: 'auto_run',
      ...(typeof intervalMs === 'number' ? { interval_ms: intervalMs } : {}),
      trigger_step_count: triggerSteps.length,
    };
  }
  const eventTriggers = ownArray<unknown>(recipeRecord, 'event_triggers');
  if (eventTriggers.length > 0) {
    return { type: 'event', event_count: eventTriggers.length };
  }
  const trigger = ownArray<unknown>(recipeRecord, 'trigger');
  if (trigger.length > 0) {
    return { type: 'url', pattern_count: trigger.length };
  }
  return { type: 'manual' };
};

const flattenStep = (
  step: RecipeStep | PrefetchStep,
  manifests: ReadonlyMap<string, IngredientManifest> | undefined,
): FlattenedStep => {
  const stepRecord = step as unknown as Record<string, unknown>;
  const rawId = own(stepRecord, 'id');
  const step_id = typeof rawId === 'string' ? rawId : '';
  const output_namespace = `step.${step_id}`;

  const transform = own(stepRecord, 'transform');
  if (typeof transform === 'string') {
    const refs = extractRefs(step);
    const out: FlattenedStep = {
      step_id,
      transform,
      action_kind: 'transform',
      output_namespace,
    };
    if (refs.length > 0) out.input_refs = refs;
    return out;
  }

  const guard = own(stepRecord, 'guard');
  if (typeof guard === 'string') {
    const refs = extractRefs(step);
    const out: FlattenedStep = {
      step_id,
      guard,
      action_kind: 'guard',
      output_namespace,
    };
    if (refs.length > 0) out.input_refs = refs;
    return out;
  }

  // Ingredient step (covers both RecipeStep IngredientStep and PrefetchStep —
  // both expose `ingredient` + `input` of the same shape).
  const rawIngredient = own(stepRecord, 'ingredient');
  const ingredientSlug = typeof rawIngredient === 'string' ? rawIngredient : '';
  const manifest = manifests?.get(ingredientSlug);
  const refs = extractRefs(step);
  const out: FlattenedStep = {
    step_id,
    ingredient: ingredientSlug,
    action_kind: classifyIngredient(ingredientSlug, manifest),
    output_namespace,
  };
  if (refs.length > 0) out.input_refs = refs;

  // ai-classify carries its category whitelist directly on the step
  // input (`input.llm.categories`). Capture it for L3+ pattern
  // queries that want to know "what categories did this user score
  // mail into across the past quarter" without re-parsing the recipe.
  // §5 — `core-ai-classify` extracts categories like the bare slug.
  if (stripCorePrefix(ingredientSlug) === 'ai-classify') {
    const categories = readCategories(step);
    if (categories) out.categories = categories;
  }

  const externalCall = deriveExternalCall(step, manifest);
  if (externalCall) out.external_call = externalCall;

  return out;
};

/** Classify an ingredient step's action kind. Slug heuristics first
 *  (so we get a sensible answer without manifests), manifest narrows
 *  when available. */
const classifyIngredient = (
  slug: string,
  manifest: IngredientManifest | undefined,
): FlattenedActionKind => {
  // §5 — classify a `core-ai-*` kernel alias like its bare slug (ai-prompt has no
  // core alias, so this only ever maps `core-ai-*` → ai_function).
  const base = stripCorePrefix(slug);
  if (base === 'ai-prompt') return 'ai_prompt';
  if (base.startsWith('ai-')) return 'ai_function';

  if (!manifest) {
    // Conservative default without manifest knowledge: assume the
    // ingredient has some external side effect. The L3 consumers
    // care most about reads vs side-effects, so erring on the side
    // of "external" is fine for unannotated installs.
    return 'external_action';
  }

  if (manifest.category === 'ai') {
    return slug === 'ai-prompt' ? 'ai_prompt' : 'ai_function';
  }
  if (manifest.category === 'data') return 'read';
  if (manifest.category === 'action') {
    if (manifest.risk_tier === 'destructive') return 'destructive';
    if (manifest.risk_tier === 'write') return 'write';
    return 'external_action';
  }
  return 'external_action';
};

/** Extract a deduped list of fully-qualified refs from a step's
 *  inputs. Ignores skip_when / fail_on / stop_when (those are
 *  caller-controlled gates, not entity touches). Returns `data.x.y` style
 *  strings ready for L3+ link reasoning. */
const extractRefs = (step: RecipeStep | PrefetchStep): string[] => {
  // Pull just the writable surfaces a step uses for data flow:
  //   - transforms keep their params at the top level (RecipeStep
  //     spreads `Record<string, unknown>` over BaseStep), so we
  //     copy the whole record minus the well-known control fields.
  //   - ingredients/guards put params under `input`.
  // skip_when / fail_on / stop_when / cache / id are control fields, never
  // entity-emitting; strip them so the ref scan stays focused.
  const target: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step)) {
    if (
      key === 'id' ||
      key === 'skip_when' ||
      key === 'fail_on' ||
      key === 'stop_when' ||
      key === 'cache' ||
      key === 'optional' ||
      key === 'transform' ||
      key === 'guard' ||
      key === 'ingredient' ||
      key === 'ingredient_version' ||
      key === 'output' ||
      key === 'pii_fields' ||
      key === 'timeout_ms' ||
      key === 'on_timeout' ||
      key === 'prompt' ||
      key === 'pages' ||
      PROTOTYPE_SENSITIVE_KEYS.has(key)
    ) {
      continue;
    }
    target[key] = value;
  }
  const refs = collectRefs(target);
  return [...new Set(refs.map((r) => `${r.ns}.${r.path}`))].sort();
};

/** Try to derive the external host the ingredient calls into. Best-
 *  effort — if we can't tell, leave it absent. Manifests with literal
 *  HTTP URLs in `input.url` give us the host directly; chat
 *  ingredients use `input.chat.tab` (the tab name *is* the host
 *  surface for L3 reasoning); MCP ingredients use
 *  `input.mcp.server_url`. AI ingredients are routed at runtime, so
 *  we deliberately omit the field — the runtime audit captures the
 *  actual host on `output_string` per Phase 7. */
const deriveExternalCall = (
  step: RecipeStep | PrefetchStep,
  manifest: IngredientManifest | undefined,
): string | undefined => {
  if (!manifest) return undefined;
  const manifestInput = own(manifest as unknown as Record<string, unknown>, 'input');
  if (!manifestInput || typeof manifestInput !== 'object' || Array.isArray(manifestInput)) {
    return undefined;
  }
  const input = manifestInput as Record<string, unknown>;
  const url = own(input, 'url');
  if (typeof url === 'string') {
    const host = parseHost(url);
    if (host) return host;
  }
  // chat.tab is itself the host-of-interest (gemini / chatgpt / …).
  // We surface the literal tab name so L3 queries can group calls by
  // chat surface.
  const chat = own(input, 'chat');
  if (chat && typeof chat === 'object' && !Array.isArray(chat)) {
    const tab = own(chat as Record<string, unknown>, 'tab');
    if (typeof tab === 'string') return tab;
  }
  // MCP server URLs land in input.mcp.server_url. Recipe-step input
  // (D-112 lock list) cannot override the manifest's choice for
  // these paths, so the manifest-side value is authoritative.
  const mcp = own(input, 'mcp');
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    const serverUrl = own(mcp as Record<string, unknown>, 'server_url');
    if (typeof serverUrl === 'string') return parseHost(serverUrl) ?? undefined;
  }
  // Step-level fallback: some ingredient manifests leave url
  // templated (`{{config.host}}`); peek at the step's input.url for
  // a literal value when present.
  const stepInput = own(step as unknown as Record<string, unknown>, 'input');
  if (stepInput && typeof stepInput === 'object' && !Array.isArray(stepInput)) {
    const stepUrl = own(stepInput as Record<string, unknown>, 'url');
    if (typeof stepUrl !== 'string') return undefined;
    const host = parseHost(stepUrl);
    if (host) return host;
  }
  return undefined;
};

const parseHost = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

const readCategories = (step: RecipeStep | PrefetchStep): string[] | undefined => {
  const input = own(step as unknown as Record<string, unknown>, 'input');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const llm = own(input as Record<string, unknown>, 'llm');
  if (!llm || typeof llm !== 'object' || Array.isArray(llm)) return undefined;
  const categories = own(llm as Record<string, unknown>, 'categories');
  if (Array.isArray(categories) && categories.every((c) => typeof c === 'string')) {
    return categories as string[];
  }
  return undefined;
};

/** Iteratively shrink the insight until it fits within
 *  `RECIPE_INSIGHT_FLATTENED_MAX_BYTES`, OR mark it truncated and
 *  hand back the smallest representable form. Pure — produces a
 *  copy at every step so the input is never mutated. */
const shrinkToFit = (insight: FlattenedInsight): FlattenedInsight => {
  const initial = serializeFlattenedInsight(insight);
  if (!initial.over_cap) return insight;

  // Pass 1: drop input_refs from every step (largest contributor on
  // ref-heavy recipes; refs are derivable by re-parsing the
  // recipe.json elsewhere if a consumer truly needs them).
  const noRefs: FlattenedInsight = {
    ...insight,
    steps: insight.steps.map(stripRefs),
    ...(insight.prefetch_steps && {
      prefetch_steps: insight.prefetch_steps.map(stripRefs),
    }),
    ...(insight.trigger_steps && {
      trigger_steps: insight.trigger_steps.map(stripRefs),
    }),
  };
  if (!serializeFlattenedInsight(noRefs).over_cap) return noRefs;

  // Pass 2: drop step-level categories + external_call too.
  const minimal: FlattenedInsight = {
    ...noRefs,
    steps: noRefs.steps.map(stripExtras),
    ...(noRefs.prefetch_steps && {
      prefetch_steps: noRefs.prefetch_steps.map(stripExtras),
    }),
    ...(noRefs.trigger_steps && {
      trigger_steps: noRefs.trigger_steps.map(stripExtras),
    }),
  };
  if (!serializeFlattenedInsight(minimal).over_cap) return minimal;

  // Pass 3: mark and return as-is. Insert callers will reject the
  // payload if it's still over the cap; truncation is best-effort.
  return { ...minimal, truncated: true };
};

const stripRefs = (step: FlattenedStep): FlattenedStep => {
  if (!step.input_refs) return step;
  const { input_refs: _, ...rest } = step;
  return rest;
};

const stripExtras = (step: FlattenedStep): FlattenedStep => {
  if (!step.categories && !step.external_call) return step;
  const { categories: _c, external_call: _e, ...rest } = step;
  return rest;
};

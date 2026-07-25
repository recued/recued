import type { RecipeStep, PrefetchStep, PrefetchOpStep } from './steps.js';
import type { ValueHint } from './value-hint.js';
import type { AutoRunSpec } from './reactive.js';
import type { AnnotationPolicy } from './annotation.js';
import type { ExecutionScope } from './execution-scope.js';
import type { RunMode } from './memory.js';
import type { RecipeWebhookRequirement, RecipeWebhookTrigger } from './webhook-profiles.js';
import type { PaidDocumentDirectCheckoutClaimConfiguration } from './paid-document-direct-checkout-config.js';

/** The well-known recipe variable name that, when declared by a recipe,
 *  gives end users the cost-upgrade toggle. Read by the LLM resolver at
 *  runtime from `config.<recipe_id>.allow_llm_upgrade`; falls through to
 *  the user-level global default. Ingredient authors do NOT control this. */
export const ALLOW_UPGRADE_VARIABLE = 'allow_llm_upgrade';

/** Declarative warehouse-event subscription on a recipe.
 *
 *  Unlike the persisted `EventTrigger` row (triggers.ts) which the
 *  user manages manually in the UI, `RecipeEventTrigger` is baked
 *  into the recipe JSON. The server's declarative reconciler scans
 *  every installed recipe for `event_triggers` and materializes live
 *  trigger rows automatically — declarative, not stateful.
 *
 *  TWO authored forms, exactly one per entry (`validateRecipeEventTriggerEntry`):
 *
 *  RAW — a literal bus pattern, optionally filtered:
 *    { "event": "data.connection.api.hubspot.deal.**.updated",
 *      "filter": { "record.stage": "negotiation" } }
 *  `filter` keys are dot-paths into the dispatch payload; values are
 *  scalar literals (AND across entries). Evaluated read-free at
 *  dispatch; a missing path PASSES (fidelity layering — see
 *  `matchesTriggerDispatchFilter` in trigger-sugar.ts).
 *
 *  SUGAR — the canonical `on:` subscriber form (design § 3/§ 4),
 *  compiled down to raw pattern(s) + dispatch filter at
 *  materialization (`compileTriggerSugarEntry`):
 *    { "on": "deal.changed",            // <crm_alias>.<verb> — cross-vendor fan
 *      "connection": "my-hubspot",      // optional literal narrowing
 *      "fields": ["stage", "amount"],   // fire only when THESE canonical fields change
 *      "where": { "id": "{{…}}-free literal" } }  // id / record-field conditions
 *  Also `on: "<vendor>.<entity>.<verb>"` (single vendor — what compiled
 *  workflow recipes mint), `on: "message.received"` (messenger),
 *  `on: "reception.request"` (visitor mutation), and
 *  `on: "form_response.accepted"` (⚠ a SUBMITTED intake response — NOT an
 *  approved one; D-210 WS2 moved the log write to submit. See `trigger-sugar.ts`.). Verbs:
 *  created | changed | removed.
 *
 *  DOM watch sugar — `on: "element.changed"` + `url` + `selector`:
 *    { "on": "element.changed",
 *      "url": "https://app.hubspot.com/contacts/*",  // Chrome match pattern
 *      "selector": "#deal-amount" }                  // CSS selector
 *  compiles to `data.dom.element.<base64url(url+selector)>.updated` (the
 *  poll source reads the selector's text on a bridge-served tab and fires
 *  on change). Local/unpublished only — a self-serve PUBLISHED recipe
 *  carrying a dom watch is rejected by the §5 publish gate (an
 *  arbitrary-domain DOM read has no signed pack declaration; ship it in a
 *  pack instead). `where` (content filter) applies; `connection` / `fields`
 *  do not. */
export interface RecipeEventTrigger {
  /** RAW form — warehouse-bus pattern. Same syntax as
   *  `EventTriggerPattern`: dot-delimited segments plus `*` and `**`
   *  wildcards. Exactly one of `event` / `on`. */
  event?: string;
  /** RAW form — dispatch filter. Keys are dot-paths into the event
   *  payload; values are literal matches (scalar equal, AND). Omitted
   *  means "fire on any match". */
  filter?: Record<string, unknown>;
  /** SUGAR form — canonical `on:` value (see the interface doc).
   *  Exactly one of `event` / `on`. */
  on?: string;
  /** SUGAR form — literal connection narrowing: the platform-reference
   *  connection segment, or the messenger vendor (D-163 I-4: the
   *  notification row name IS the vendor). Literal only — config refs
   *  cannot resolve at dispatch time. Not valid for `reception.request` or
   *  `form_response.accepted`. */
  connection?: string;
  /** SUGAR form — canonical field keys; fire only when the event's
   *  `changed_fields` intersects. Entity-change forms only. */
  fields?: string[];
  /** SUGAR form — record conditions: `id` matches the record id (every
   *  source carries it); any other key matches the canonical projection
   *  field `record.<key>` (fat poll-sourced events; doorbell-shaped
   *  reconciler events pass — the recipe's own gates stay the
   *  correctness boundary). Scalar literals only. The fixed
   *  `form_response.accepted` event admits only string `id`, `endpoint_id`,
   *  and `form_definition_id` narrowing because those paths are guaranteed
   *  on its privacy-minimized routing record. */
  where?: Record<string, string | number | boolean>;
  /** DOM-watch SUGAR form (`on: "element.changed"`) — the Chrome match
   *  pattern naming the tab/origin to watch (e.g.
   *  `https://app.hubspot.com/contacts/*`). Literal only; required for the
   *  dom form, rejected on every other form. */
  url?: string;
  /** DOM-watch SUGAR form — the CSS selector whose text is polled for
   *  change. Literal only; required for the dom form, rejected elsewhere. */
  selector?: string;
}

/** The closed block vocabulary a recipe's `output.render` may declare.
 *
 *  ⛔ THE LIST IS THE SOURCE OF TRUTH — `OutputType` DERIVES from it, and so
 *  does the recipe validator's admission set (`packages/recipes`
 *  `validate/constants.ts`) and the renderer's `SectionKind`. A hand-written
 *  second copy of a closed vocabulary is how `door_types` silently drifted out
 *  of its schema (D-207 slice 1c): a `Set<OutputType>` missing a member
 *  TYPECHECKS FINE, so the drift surfaces as a recipe that fails validation for
 *  no legible reason. Add a kind HERE and every consumer widens with it. */
export const OUTPUT_TYPES = [
  'checklist',
  'table',
  'summary',
  'ai_analysis',
  'text',
  'copyable',
  'button',
  /** D-200 — one or more immutable file cards. The resolved data carries
   *  server-derived file metadata and may include a hash-pinned recipe action;
   *  authenticated preview/download remains a host-owned interaction. */
  'file_artifact',
  /** D-196 § 4.5 / D-207 slice 2 — plain outbound navigation: label + absolute
   *  HTTPS URL + optional description (`ReceptionLinkButton`). The ONE block
   *  that navigates, and the only actionable one a visitor-facing surface can
   *  honour: `button` carries a `recipe.run` descriptor a stranger has no way
   *  to run, whereas this is just an anchor. It is what makes "Proceed to
   *  payment → [Checkout]" and D-196's Subscribe page the SAME block. */
  'link_button',
  /** Raw structured data from a step result — the DETAIL behind a curated
   *  `summary` / `table`.
   *
   *  ⛔ A DECLARATION, not a presentation directive. Like every kind in this
   *  list it says what the data IS and leaves rendering to the consuming
   *  channel: the HTML surfaces collapse it behind native disclosure
   *  (`packages/renderer`), an MCP / chat caller receives the `{type, data}`
   *  block verbatim and never calls the renderer at all, and a D-163
   *  notify-only channel may render nothing. Do not read `json` as an
   *  instruction to print JSON at a reader.
   *
   *  ⚠ WHY THIS EXISTS AT ALL: `output.render` is the ONLY channel by which a
   *  run's data reaches ANY reader. `ExecuteResponse.steps[]` carries
   *  id/type/skipped/duration_ms/error and no values — the response builder
   *  projects them away — and every surface (webclient result panel, MCP, chat,
   *  messenger, reception) reads `render` and nothing else. So a step result
   *  absent from `render` is unreachable by every consumer, human AND model.
   *  This kind is how detail becomes reachable at all.
   *
   *  ⛔ NOT `copyable`, which lifts a `.content` field out of any object handed
   *  to it: a payload that happens to carry one (a Contentful entry, a Freshdesk
   *  ticket) would render as that ONE field with the rest silently dropped —
   *  wrong, and quiet about it. This kind is faithful; what the step produced is
   *  what it shows. */
  'json',
] as const;

export type OutputType = typeof OUTPUT_TYPES[number];

export interface OutputSection {
  type: OutputType;
  source: string;
  /** Display label for copyable blocks. */
  label?: string;
}

export interface RecipeOutput {
  /** Canonical D-195 render surface. Parsers normalize legacy sidebar-only
   *  authored recipes into this field before execution. */
  render?: OutputSection[];
  /** Legacy migration alias. Parsers normalize this into render before
   *  execution when authored by old recipes. */
  sidebar?: OutputSection[];
}

/** THE rule for which sections a recipe actually renders — `render`, else the
 *  legacy `sidebar` alias, else none.
 *
 *  ⛔ ONE COPY. This was a private const in the engine, and D-207 slice 2 needed
 *  a second caller: the reception submit path has to know whether a paired
 *  recipe's response carries anything, because that decides whether a rejected
 *  submission may still be told "Submission received". If that answer ever
 *  disagreed with the answer the ENGINE gives when it builds `output.render`,
 *  the rule would fire on the wrong forms — silently, and in the direction of
 *  lying to someone.
 *
 *  ⚠ NOTE THE PRECEDENCE, which a naive re-derivation gets wrong: an EMPTY
 *  `render: []` beats a populated `sidebar`, because `Array.isArray([])` is
 *  true. `render` present at all means the author moved off the legacy alias, so
 *  an empty one means "renders nothing" — not "fall back to sidebar". */
export const recipeOutputSections = (recipe: {
  output?: { render?: OutputSection[]; sidebar?: OutputSection[] };
}): OutputSection[] =>
  Array.isArray(recipe.output?.render)
    ? recipe.output.render
    : Array.isArray(recipe.output?.sidebar)
      ? recipe.output.sidebar
      : [];

export type RecipeOutputAction = {
  kind: 'recipe.run';
  label: string;
  recipe_id: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  variant?: 'primary' | 'secondary' | 'danger';
  confirm?: string;
};

export interface RecipeMetadata {
  name: string;
  description: string;
  author: string;
  supported_platforms: string[];
  /** D-195 — namespaced identity of the BulkPackManifest that owns this
   *  recipe's install flow. Shape: <pack.publisher>/<pack.slug>; omit when the
   *  recipe is independently installable or has no single carrier. */
  recipe_bundle?: string;
  variant_group?: string;
  tags?: string[];
  fork_of?: { recipe_id: string; author: string; version: number };
  /** Long-form documentation in Markdown. Rendered on the marketplace
   *  detail page. Max 10,000 characters. Optional — description is
   *  the card/search preview, readme is the detail page explainer. */
  readme?: string;
  /** v3 — the author's source repo URL (https). Issues, bugs, and
   *  support route THERE; the marketplace hosts no comments / issue
   *  tracking. Entered in the marketplace publish flow (Kitchen renders
   *  it read-only) and never inherited across fork-and-publish. */
  repo?: string;
  /** Wall-clock execution budget in milliseconds. When set, the engine
   *  aborts the run with RECIPE_BUDGET_EXCEEDED if the recipe hasn't
   *  completed within this many ms of start. Approval waits are excluded
   *  from the budget (users take their own time). Required for context /
   *  auto-run recipes (must respond fast); optional for manual + scheduled. */
  budget_ms?: number;
  /** D-119 Phase 13 — annotation eviction policy.
   *  `'keep_stale'` (default) renders a `⚠ stale` badge on the
   *  per-record ref but never deletes; `'evict_on_stale'` drops the
   *  row at next read through the per-record ref. Recipes opt in
   *  explicitly because eviction is destructive. */
  annotation_policy?: AnnotationPolicy;
  /** D-119 Phase 15 — author-declared execution scope.
   *  Optional. When present, must be a subset of the scope derived
   *  from the recipe's ingredient manifests at install time. Wider-
   *  than-derived declarations error with `EXECUTION_SCOPE_TOO_WIDE`.
   *  Marketplace UI shows the narrower of (declared, derived); the
   *  install gate uses the derived constraint to refuse incompatible
   *  installs (`EXECUTION_SCOPE_INCOMPATIBLE`). See
   *  `packages/contracts/src/execution-scope.ts`. */
  execution_scope?: ExecutionScope[];
  /** D-200 — optional owner-local direct-checkout deployment locators. The
   * complete block is part of the saved recipe and therefore of the exact
   * form/recipe pair revision. It carries no product/economic terms, Seller
   * identity, hosted provider result, quantity, or total. */
  paid_document_direct_checkout?: PaidDocumentDirectCheckoutClaimConfiguration;
}

/** Recipe variable: shorthand primitive (default value) OR full hint for
 *  richer UI. `null` means "required, no default" — preflight surfaces
 *  the variable as missing when the caller's config omits it. */
export type VariableDefault = number | boolean | string | string[] | ValueHint | null;

/** D-116 — declarative error-handler binding on a recipe.
 *
 *  When a recipe declares `on_failure`, the install path:
 *    1. Resolves `recipe_id` in the local install registry. Missing →
 *       `ON_FAILURE_HANDLER_UNKNOWN`.
 *    2. Verifies the handler is reactive (has `trigger_steps`). Missing
 *       → `ON_FAILURE_HANDLER_NOT_REACTIVE`.
 *    3. Verifies the handler has a `recipe-watcher` step in
 *       `trigger_steps`. Missing → `ON_FAILURE_HANDLER_MISSING_WATCHER`.
 *
 *  At runtime the handler's recipe-watcher filter is augmented so the
 *  handler fires only on failures of THIS source recipe. Handler input
 *  sees `{{trigger.failure.*}}` with `recipe_id`, `process_id`,
 *  `error_class`, `step_id`, `at`. */
export interface OnFailureBinding {
  /** Recipe_id of the handler. Must already be installed when THIS
   *  recipe installs. Pointing at `recipe_id` itself is rejected —
   *  failures of the handler would re-fire it. */
  recipe_id: string;
  /** Optional config patch merged onto the handler at dispatch.
   *  (Historically "same shape as `event_triggers.config_patch`" —
   *  that trigger field was retired by D-179 P2 in favor of dish
   *  overlays; this binding-local patch is unaffected.) */
  config?: Record<string, unknown>;
}

export interface RecipeDefinition {
  recipe_id: string;
  version: number;
  ttl: number;
  trigger?: string[];
  metadata: RecipeMetadata;
  /** User-configurable variables. Persist as config.{recipe_id}.{key}.
   *  Recipes that want to expose a per-install LLM-upgrade toggle declare
   *  a variable named `allow_llm_upgrade` (boolean). See ALLOW_UPGRADE_VARIABLE. */
  variables: Record<string, VariableDefault>;
  /** Override ingredient vault_hints for the same path. Lets recipes customize credential prompts. */
  vault_hints?: Record<string, ValueHint>;
  /** Warehouse-event subscriptions. When present, the server's
   *  event-trigger binder registers each entry with the warehouse
   *  bus on recipe install. Recipes without this field are
   *  manual-only (URL-trigger + approval-only). */
  event_triggers?: RecipeEventTrigger[];
  /** D-201 — owner-local webhook requirements.  Published pack recipes usually
   *  inherit requirements from their owning pack; a standalone local recipe
   *  may carry this same portable shape itself. */
  webhook_requirements?: RecipeWebhookRequirement[];
  /** D-201 — strict logical-binding + exact-event trigger grammar.  This is
   *  intentionally separate from `event_triggers`: no vendor type is embedded
   *  in a warehouse topic and no missing-path filter can pass. */
  webhook_triggers?: RecipeWebhookTrigger[];
  /** D-116 — declarative error-handler binding. When THIS recipe
   *  fails, the engine fires the bound handler recipe (which must
   *  already be installed + reactive + have a recipe-watcher step).
   *  One-hop only — chains compose by binding handlers on handlers. */
  on_failure?: OnFailureBinding;
  /** D-115 — reactive recipes. When present, the engine treats this
   *  recipe as auto-running on a short interval. The extension SW
   *  drives ticks via `chrome.alarms` (clamped to 30s / ~1m floor);
   *  the server uses `setTimeout` (sub-second supported). Pairs with
   *  `trigger_steps` to gate firings — `auto_run` without
   *  `trigger_steps` would tick unconditionally, which is allowed but
   *  rare. Coexists with cron `schedule` rows (different regime). */
  auto_run?: AutoRunSpec;
  /** D-115 — gate phase that runs before `prefetch_steps` on every
   *  `auto_run` tick. All steps must yield `TriggerOutput.should_run
   *  === true` for the tick to proceed; any false short-circuits
   *  silently (no audit entry, no side effect). Outputs surface as
   *  `{{trigger.<step_id>.<field>}}` to downstream phases. Forbidden
   *  without `auto_run` — would never fire. */
  trigger_steps?: RecipeStep[];
  /** D-182 Slice 4 — a prefetch entry is EITHER a concrete `PrefetchStep`
   *  (`ingredient` + input) OR a `PrefetchOpStep` (a two-tier `op` id). The
   *  op-step lowering (`lowerOpStepRecipe`) concretizes every `PrefetchOpStep`
   *  into a `PrefetchStep` BEFORE the engine runs, so the engine prefetch runner
   *  only ever executes concrete steps (it narrows + throws on any survivor). */
  prefetch_steps: Array<PrefetchStep | PrefetchOpStep>;
  steps: RecipeStep[];
  output: RecipeOutput;
  /** D-120 Phase 3 — provenance opt-out. Default `true` (engine emits
   *  causal entity↔memory links for every step touch — the substrate
   *  L3+ pattern detection consumes). Explicit `false` silences
   *  emission for the entire run; marketplace surfaces a "No
   *  provenance" badge so users can see the recipe declines tracing.
   *  Use only for genuinely ephemeral recipes (one-shot search /
   *  scratch) — durable workflows should leave it on so the warehouse
   *  carries the why-trail alongside the what. */
  provenance?: boolean;
  /** D-120 Phase 4 — staged-trust permission requests. Recipes that
   *  reference `{{data.memory.*}}` (or its `data.audit.*` alias)
   *  must declare `requires: ['read_memory']` so the install dialog
   *  can surface the permission for explicit user approval. Same
   *  pattern as vault scoping — default-deny; the validator hard-
   *  errors when a recipe reads from the memory namespace without the
   *  permission declared. Unrecognised entries are warned (forward-
   *  compat: future permissions surface alongside without a hard
   *  break). */
  requires?: string[];
  /** D-120 Phase 7.5 — declarative run-mode override. Authors set
   *  `'backfill'` on cursor-loop recipes that walk historical data;
   *  the engine stamps `audit_log.run_mode` accordingly so backfill
   *  links use `event_at` rather than today's timestamp on
   *  `data.timeline()` ordering. Default when absent: engine infers
   *  `'manual'` for chat / Run-Now / UI triggers, `'live'` for cron /
   *  reactive / auto_run. */
  run_mode?: RunMode;
  /** D-137 § A.1.1 (amended 2026-07-02) — Tier 2 chat-catalog exposure
   *  flag. Explicit `true` surfaces the recipe in the chat agent's tool
   *  catalog under `<publisher_id>/<recipe_id>`; explicit `false` keeps
   *  it runnable via `recipe.run` Tier 1 + URL trigger + scheduler
   *  without polluting the chat catalog.
   *
   *  An ABSENT flag falls to a SOURCE-DEPENDENT default
   *  (`isRecipeChatExposed` in @recued/recipes): EXPOSED for
   *  user-authored recipes (stored `source: 'inline'` — a person who
   *  authored a recipe intends to use it), HIDDEN for pack-bundled /
   *  distributed content (at 300-pack scale every silently-exposed
   *  recipe inflates every installer's cached catalog prefix ~160
   *  tok/entry — pack authors declare exposure deliberately). The
   *  pre-flip corpus was grandfathered with explicit `true`. */
  chat_exposed?: boolean;
  /** D-182 §3 — the Tier-P packs whose ops this recipe uses
   *  (`<publisher>.<pack>`, optionally `@N` version-pinned). Tier-K `core.*`
   *  ops need NONE (kernel — always present). Distinct from `requires`
   *  (permissions). The install + Compose validators confirm every Tier-P
   *  `op` a step names is covered by an entry here
   *  (`uncoveredOpDependencies`). Replaces the dropped capability-keyed
   *  `{capability, ops, optional}` DI graph (§3 / §5); Tier-K `core.*` runnability
   *  is now kernel-derived (R1 verb-split), not declared. Omit when the recipe
   *  calls only Tier-K kernel ops. */
  depends_on?: string[];
}

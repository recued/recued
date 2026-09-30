/** D-137 Wave 2.1 — pure helpers for projecting an installed recipe
 *  into the chat agent's Tier 2 catalog.
 *
 *  Three concerns live here, deliberately separated so callers can pick
 *  what they need:
 *
 *    - **`isRecipeChatExposed(recipe, opts?)`** — closed boolean
 *      projection over `RecipeDefinition.chat_exposed`. Absent flag →
 *      source-dependent default (§ A.1.1 amended 2026-07-02): exposed
 *      only for user-authored recipes; pack/bundled content hidden.
 *
 *    - **`deriveRecipeRequiresKinds(recipe, lookup)`** — step-graph
 *      walker that returns the closed `IngredientKind[]` the recipe's
 *      ingredient steps touch. Used by Mary's per-kind catalog scope
 *      toggle (§ A.1.1) to gate Tier 2 entries off when the recipe
 *      transitively touches a kind Mary has unchecked. Sorted +
 *      deduplicated.
 *
 *    - **`buildTier2ToolEntry(entry, lookup)`** — projects a single
 *      `Tier2RecipeEntry` (recipe + publisher_id) into the contract-
 *      shape `ToolEntry` with `tier: 2` set. Honors the chat_exposed
 *      filter (returns `null` when opted out). Uses recipe metadata
 *      for description + tags.
 *
 *  All three are pure: same inputs → same outputs, no clock, no I/O,
 *  no module-level state. The substrate-level test ratchet asserts
 *  deterministic ordering + that the projection never references a
 *  non-existent manifest kind.
 *
 *  Tier 2 dispatch path (the actual recipe-engine invocation that fires
 *  when the chat agent calls a Tier 2 entry) lives behind the engine's
 *  `InternalToolRegistry` factory — `buildTier2ToolEntry` produces the
 *  catalog metadata only.
 *
 *  Spec: § A.1.1 (Tier 2 surface enumeration) + § P1 phase notes.
 */

import type {
  IngredientKind,
  IngredientManifest,
  PrefetchStep,
  RecipeDefinition,
  RecipeStep,
  ToolEntry,
  ValueHint,
  VariableDefault,
} from '@recued/contracts';
import {
  INGREDIENT_KINDS,
  getKernelDomain,
  isCliIngredient,
  kernelOpBackingSlug,
  parseOpId,
  rankSearchable,
} from '@recued/contracts';

/** Spec § A.1.1, amended 2026-07-02 (the 300-pack-wave default flip) —
 *  chat exposure default is SOURCE-DEPENDENT:
 *
 *  - **Pack-bundled / distributed content** (bundled `community/recipes`
 *    files, pack-installed rows): default `false` — the AUTHOR declares
 *    chat exposure deliberately with `chat_exposed: true`. Rationale:
 *    at 300-pack scale every silently-exposed recipe inflates every
 *    installer's cached catalog prefix (~160 tok/entry, measured by the
 *    bench scaling lane); exposure-as-intent means the author states it.
 *    The pre-flip corpus was grandfathered by a one-time sweep adding
 *    explicit `true` to every then-exposed bundled recipe.
 *  - **User-authored recipes** (`source: 'inline'` — Kitchen / compose /
 *    seeded-authored): default `true` — a person who authored a recipe
 *    intends to use it; hiding it unless they learn a flag would be a
 *    substrate-support trap.
 *
 *  Recipes with `chat_exposed: false` stay runnable via `recipe.run` /
 *  URL trigger / scheduler but do not pollute the chat catalog. */
export const DEFAULT_PACK_RECIPE_CHAT_EXPOSED = false;
export const DEFAULT_AUTHORED_RECIPE_CHAT_EXPOSED = true;

/** Synchronous lookup from ingredient slug → kind. Concrete impl is
 *  caller-supplied (server wraps its manifest loader; tests inject a
 *  Map). Returning `null` for a missing slug is OK — the projection
 *  drops that kind contribution (best-effort) rather than throwing. */
export type IngredientKindLookup = (slug: string) => IngredientKind | null;

/** Helper for callers that already have full `IngredientManifest`s in
 *  memory — projects to the narrower `IngredientKindLookup`. The
 *  underlying registry typically already resolves slugs lazily, so this
 *  is a convenience for tests + harnesses that build a Map upfront. */
export const createManifestKindLookup = (
  resolve: (slug: string) => IngredientManifest | null | undefined,
): IngredientKindLookup => (slug) => {
  const manifest = resolve(slug);
  if (!manifest || typeof manifest !== 'object') return null;
  // D-182 — a decomposed cli toolkit catalog (whisper / docling / ffmpeg /
  // imagemagick) is stamped `kind: 'connection'` by the decomposer; its
  // cli-ness lives in the `cli_invocation` connector runtime, not the manifest
  // `kind`. Surface it as the `cli` kind so the catalog gate's "Local tools"
  // toggle governs it — not "Outbound connections" (which would be wrong: a
  // local binary is not an outbound endpoint).
  if (isCliIngredient(manifest)) return 'cli';
  const kind = (manifest as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return null;
  if (!INGREDIENT_KINDS.has(kind as IngredientKind)) return null;
  return kind as IngredientKind;
};

/** D-182 F2 — resolve an `op:` id → its `IngredientKind`, for the NON-kernel ops
 *  `deriveRecipeRequiresKinds` cannot resolve inline (a kernel closed-kind op
 *  resolves via `kernelOpBackingSlug`; this covers the rest). Returns `null` when
 *  the op contributes no determinable kind. */
export type OpKindLookup = (op: string) => IngredientKind | null;

/** D-182 F2 — build an `OpKindLookup` for canonical-convention + Tier-P ops:
 *   - **canonical-convention** (`core.crm.*` / `core.acct.*`) → `connection` —
 *     every CRM / acct vendor catalog is a `connection`-kind ingredient, so a
 *     canonical op always needs the `connection` capability;
 *   - **Tier-P pack op** (`<publisher>.<pack>.<operation>`) → the kind of the
 *     installed pack's decomposed catalog ingredient, via
 *     `resolveCatalogSlug(pack_ref)` → `lookup(slug)` (an `http` vendor op → `http`,
 *     a `service` toolkit op → `service`, a CRM catalog → `connection`).
 *     `resolveCatalogSlug` is the caller's lazy bridge to install state (pack_ref →
 *     the decomposed catalog slug); it returns null for an uninstalled /
 *     unresolvable pack, and the op then contributes no kind (best-effort, same
 *     posture as a missing manifest).
 *  Kernel closed-kind ops return `null` here — they are resolved inline by
 *  `deriveRecipeRequiresKinds`, so this resolver never double-counts them.
 *
 *  cli (D-182 F2 cli gate): a pack whose catalog declares `kind: 'cli'` (whisper
 *  / docling / imagemagick) now resolves to the `cli` kind — `cli` graduated into
 *  `IngredientKind`, so `lookup` (guarded on `INGREDIENT_KINDS`) returns it like
 *  any other kind. A cli Tier-P op therefore contributes `cli` to the recipe's
 *  `requires_kinds`, and Mary's "Local tools" toggle gates it. */
export const createOpKindLookup = (deps: {
  lookup: IngredientKindLookup;
  resolveCatalogSlug: (packRef: string) => string | null;
}): OpKindLookup => (op) => {
  const parsed = parseOpId(op);
  if (parsed === null) return null;
  if (parsed.tier === 'kernel') {
    return getKernelDomain(parsed.domain)?.class === 'canonical_convention' ? 'connection' : null;
  }
  if (parsed.tier === 'pack') {
    const slug = deps.resolveCatalogSlug(parsed.pack_ref);
    return slug ? deps.lookup(slug) : null;
  }
  return null;
};

/** Spec § A.1.1 (amended 2026-07-02) — Tier 2 entries are recipes whose
 *  chat exposure resolves `true`. Explicit `chat_exposed: true | false`
 *  always wins; an ABSENT (or malformed non-boolean — the validator
 *  rejects those at install, so this is defense-in-depth) flag falls to
 *  the source-dependent default: `true` only for user-authored recipes
 *  (`opts.user_authored`), `false` for pack-bundled/distributed content.
 *  Callers that cannot know the source (e.g. the pack validator gate,
 *  which by definition renders PACK content) omit `opts` and get the
 *  pack default. */
export const isRecipeChatExposed = (
  recipe: RecipeDefinition,
  opts?: { user_authored?: boolean },
): boolean => {
  if (recipe.chat_exposed === true) return true;
  if (recipe.chat_exposed === false) return false;
  return opts?.user_authored
    ? DEFAULT_AUTHORED_RECIPE_CHAT_EXPOSED
    : DEFAULT_PACK_RECIPE_CHAT_EXPOSED;
};

/** Spec § A.1.1 — derive the closed `IngredientKind[]` set the recipe's
 *  ingredient + op steps touch. Walks `prefetch_steps`, `steps`, and
 *  `trigger_steps`; transforms + guards are skipped (no ingredient / op
 *  field). Missing manifests are skipped silently — the gate is
 *  best-effort; a recipe that references an unknown ingredient is
 *  already broken at install + preflight time, and we don't want a
 *  missing manifest to bypass Mary's kind gate either (the unknown
 *  kind would surface in the empty set, treating the recipe as
 *  kind-free).
 *
 *  D-182 op-steps (`op:`) — a KERNEL closed-kind op (`core.<domain>.<op>`)
 *  resolves to its backing kernel ingredient slug (`core.dom.read` →
 *  `dom-read` → kind `dom`), so the kind gate still fires after a recipe
 *  is migrated off `ingredient:`. A canonical-convention op (`core.crm.*` /
 *  `core.acct.*`) or a Tier-P pack op contributes NO kind here — it resolves
 *  to a vendor / pack catalog kind (the `http` / `cli` / `connection` the bound
 *  vendor or installed pack declares) only with binding context this pure
 *  projection lacks. Pass the caller-supplied `opKindLookup` (a pack/vendor
 *  op→kind resolver) to close that — e.g. a Tier-P `cli` op then gates on the
 *  `cli` kind (D-182 F2 cli gate).
 *
 *  Deduplicated; output preserves the canonical `IngredientKind`
 *  declaration order from contracts (so callers see a stable, audit-
 *  friendly projection rather than insertion order). */
export const deriveRecipeRequiresKinds = (
  recipe: RecipeDefinition,
  lookup: IngredientKindLookup,
  opKindLookup?: OpKindLookup,
): ReadonlyArray<IngredientKind> => {
  const found = new Set<IngredientKind>();
  const visitStep = (step: RecipeStep | PrefetchStep | undefined | null): void => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return;
    // Concrete ingredient step → its declared kind.
    const ingredient = (step as { ingredient?: unknown }).ingredient;
    if (typeof ingredient === 'string' && ingredient) {
      const kind = lookup(ingredient);
      if (kind !== null) found.add(kind);
      return;
    }
    // D-182 op-step → a kernel closed-kind op maps to its backing kernel
    // ingredient's kind (inline). A non-kernel op (canonical-convention / Tier-P)
    // is resolved by the caller-supplied `opKindLookup` (binding context this pure
    // walk lacks); absent it, those contribute no kind (best-effort).
    const op = (step as { op?: unknown }).op;
    if (typeof op === 'string' && op) {
      const backing = kernelOpBackingSlug(op);
      if (backing !== undefined) {
        const kind = lookup(backing);
        if (kind !== null) found.add(kind);
      } else if (opKindLookup) {
        const kind = opKindLookup(op);
        if (kind !== null) found.add(kind);
      }
    }
  };
  const visitArray = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const s of steps) visitStep(s as RecipeStep | PrefetchStep);
  };
  visitArray(recipe.prefetch_steps);
  visitArray(recipe.steps);
  visitArray(recipe.trigger_steps);
  if (found.size === 0) return [];
  // Preserve canonical IngredientKind declaration order from contracts.
  const ordered: IngredientKind[] = [];
  for (const k of INGREDIENT_KINDS) {
    if (found.has(k)) ordered.push(k);
  }
  return ordered;
};

/** Spec § A.1.1 — Tier 2 catalog entry input: a recipe + its publisher
 *  scope. The `<publisher_id>/<recipe_id>` composite forms the Tier 2
 *  `ToolEntry.name`. Publisher scope is tracked at the install layer
 *  (`InstallRegistry` / `RecipeStore.listStored().publisher_id`); the
 *  caller threads it through. */
export interface Tier2RecipeEntry {
  recipe_id: string;
  publisher_id: string;
  recipe: RecipeDefinition;
  /** 2026-07-02 default flip — `true` when the recipe is user-authored
   *  (stored `source: 'inline'`): an absent `chat_exposed` then defaults
   *  EXPOSED. Absent/false = pack-bundled/distributed content: an absent
   *  flag defaults HIDDEN. Explicit `chat_exposed` always wins. */
  user_authored?: boolean;
}

/** Spec § A.1.1 — the chat-facing Tier 2 entry name format. `<publisher>
 *  /<slug>` — slash separator matches the contracts-level docstring on
 *  `ToolEntry.name` and the in-product display ("recued-core/draft-
 *  followup"). */
export const formatTier2ToolName = (
  publisher_id: string,
  recipe_id: string,
): string => `${publisher_id}/${recipe_id}`;

/** D-137 — map ONE recipe variable (its `VariableDefault`) to a JSON-
 *  Schema property for the Tier 2 tool's `arg_schema`. Returns `null`
 *  for credential hints (`ValueHint` type `'secret'` / `'oauth'`) — the
 *  AI never supplies secrets / OAuth tokens as recipe config; the vault
 *  resolves those at run time, so they are NOT AI-settable args.
 *
 *  Type mapping: primitive shorthand → that JSON type + the value as
 *  `default` (optional, since it has one); `null` → required `string`
 *  (no default, type unknown — preflight surfaces it as missing if the
 *  caller omits it); `ValueHint` → typed from `.type` (`enum` carries
 *  `.options`), `description` from `help`/`label`, required unless
 *  `.optional`. */
/** Lever-4 (2026-07-02) — cap oversized defaults OUT of the model-bound arg
 *  schema. Embedding a default is a courtesy (the model imitates the shape /
 *  learns it may omit the arg); the default is filled server-side at preflight
 *  regardless, so omitting the embed never changes execution. Without a cap a
 *  data-table default rides every chat packet of every installer — measured:
 *  one 50-state statute map = ~1.1k tokens, 6× the median WHOLE entry.
 *  `required` stays keyed on the HINT's default (preflight semantics), never
 *  on whether the embed was capped. */
const MAX_EMBEDDED_DEFAULT_JSON_CHARS = 256;
const embedDefault = (schema: Record<string, unknown>, value: unknown): void => {
  try {
    if (JSON.stringify(value).length <= MAX_EMBEDDED_DEFAULT_JSON_CHARS) {
      schema.default = value;
    }
  } catch {
    // non-serializable default (circular) — omit the embed
  }
};

const variableToArgProp = (
  def: VariableDefault,
): { schema: Record<string, unknown>; required: boolean } | null => {
  if (def === null) return { schema: { type: 'string' }, required: true };
  if (Array.isArray(def)) {
    // A `string[]` default is an enum/choice — the allowed values, first
    // element the default (internal design notes; the structural
    // validator + engine default to `def[0]`), NOT an array-valued arg.
    const schema: Record<string, unknown> = { type: 'string' };
    if (def.length > 0) {
      schema.enum = [...def];
      embedDefault(schema, def[0]);
    }
    return { schema, required: false };
  }
  if (typeof def === 'number') return { schema: { type: 'number', default: def }, required: false };
  if (typeof def === 'boolean') return { schema: { type: 'boolean', default: def }, required: false };
  if (typeof def === 'string') {
    const schema: Record<string, unknown> = { type: 'string' };
    embedDefault(schema, def);
    return { schema, required: false };
  }
  // ValueHint — the richer object form. Community recipes author hint
  // types beyond the `ValueHintType` union (`'array'` on today.weekdays /
  // notification `channels`; `'service_ref'` / `'file_ref'` / `'connection'`
  // from D-118/D-125/D-172) — the structural validator accepts them, so the
  // projection reads the type as a plain string. CONTRACT_GAP: ValueHintType
  // lags the authored set.
  const hint = def as ValueHint;
  const hintType = hint.type as string;
  if (hintType === 'secret' || hintType === 'oauth') return null; // vault-resolved, never AI-set
  const schema: Record<string, unknown> = {};
  if (hintType === 'number') schema.type = 'number';
  else if (hintType === 'boolean') schema.type = 'boolean';
  else if (hintType === 'array') {
    // Without this mapping an array-valued variable shipped as
    // `type:"string"` with an ARRAY default — a wrong shape the model
    // would imitate (it can't know whether to emit a string or a list).
    schema.type = 'array';
  } else if (hintType === 'datetime') {
    // D-193 — a stable, unambiguous date input. Advertise JSON-Schema
    // `date-time` (ISO 8601 / RFC 3339) so the model emits a parseable
    // absolute timestamp instead of guessing raw epoch-ms (which LLMs
    // get wrong). The recipe body still normalizes via `date_parse` +
    // a fail_on guard, so an ignored hint fails closed rather than
    // silently mis-scheduling.
    schema.type = 'string';
    schema.format = 'date-time';
  } else if (hintType === 'date') {
    // A calendar DAY (`value-hint.ts`): JSON-Schema `date` is `YYYY-MM-DD`,
    // which is exactly the value — no time for the model to invent, and no
    // zone for it to guess.
    schema.type = 'string';
    schema.format = 'date';
  } else if (hintType === 'object') {
    // Mirror the `array` case: an object-valued variable — a vendor JSON
    // body the recipe pure-refs into an object arg (Contentful `fields`,
    // Greenhouse `application`, Replicate `input`) or the D-192 create's
    // `container_names` ref→name map — shipped as `type:"string"` tells the
    // model to emit a string for what the recipe binds as an object, the
    // same wrong-shape trap the array mapping closes. Advertise `object`.
    schema.type = 'object';
  } else if (hintType === 'json') {
    // ⛔⛔ NO `type` AT ALL — AND THAT IS THE POINT. `json` means "any JSON
    // value": an object, an array, or a scalar, decided per call. The `else`
    // branch below would have shipped it as `type: 'string'`, which is the same
    // wrong-shape trap the `array` and `object` mappings above were added to
    // close — this is the third member of that family, and it was missed because
    // nothing drove a `json` variable over a real wire.
    //
    // 🔑 IT BROKE THE ONE CASE THAT CANNOT BE A STRING. `peer-project-update-reply`
    // declares `errors: { type: 'json' }` — the D-232 § 21 envelope field the
    // engine ALWAYS sends as an ARRAY — so alice's door refused every peer's
    // refusal with `arguments.errors must be a string`, and the write leg went
    // silent in the direction § 19.4 calls the worst outcome: the answer arrived
    // and was turned away at the last gate. A live two-server drive found it,
    // after two other fixes stopped masking it.
    //
    // ⚠ An absent `type` is JSON Schema's "any", and `validateMcpSchemaValue`
    // already reads it that way (`case undefined: return null`). Constraining it
    // to the union of shapes seen so far would re-create the same trap one
    // authored payload later.
  } else {
    schema.type = 'string';
    if (hintType === 'enum' && Array.isArray(hint.options) && hint.options.length > 0) {
      schema.enum = [...hint.options];
    }
  }
  const desc = hint.help?.trim() || hint.label?.trim();
  if (desc) schema.description = desc;
  if (hint.default !== undefined) embedDefault(schema, hint.default);
  // ⛔⛔ A `connection` VARIABLE IS NEVER REQUIRED OF A CALLER, BECAUSE NO CALLER
  // CAN KNOW IT. It names a row in THIS server's connection store, bound at
  // INSTALL (the pack's `chosen_connection` / the dish overlay) — so demanding
  // it on the wire asks a stranger for a local fact.
  //
  // 🔑 THE COST WAS SEVEN SHIPPED RECEIVERS DEAD ON ARRIVAL, and the symptom
  // named the wrong side. `peer-request-appointment` declares
  // `peer_connection: { type: 'connection' }`, so this projection marked it
  // required, and every peer's appointment request was refused
  // `arguments.peer_connection is required` at the far door — an asker being
  // told they omitted something they could not have supplied. D-232 § 20.17
  // exists precisely because the answer's route is a property of the
  // RELATIONSHIP: absent, the engine resolves the connection from the caller's
  // contract, and `require_connection: true` fails loudly if that finds nothing.
  // The variable is the install's OVERRIDE of that, not an input.
  //
  // ⚠ STILL ADVERTISED, NOT DROPPED — unlike `secret` / `oauth`, which return
  // null above. An owner's own local call may legitimately name a connection,
  // and hiding the key would make that unstatable; what changes is only that its
  // absence is no longer a refusal.
  //
  // ⚠ A GUARD STILL OUTRANKS THIS. `guardRequiredVariables` unions in anything a
  // recipe refuses to run without, so a receiver that genuinely cannot proceed
  // without a named connection keeps saying so — from the guard, which is the
  // authority, rather than from the shape of the declaration.
  if (hintType === 'connection') return { schema, required: false };
  // D-315 §5.2 — a `mail_template` names a template minted on THIS server, which
  // the recipe's own setting holds; a caller cannot know it, so it is never
  // asked of one. Advertised, like a connection: the owner may name another.
  if (hintType === 'mail_template') return { schema, required: false };
  // A hint with a `default` is filled by preflight, so it is not required even
  // when `.optional` is unset (preflight treats a present default as supplied).
  return { schema, required: hint.optional !== true && hint.default === undefined };
};

/** D-137 — derive a Tier 2 recipe tool's `arg_schema` from its manifest
 *  `variables` (the recipe's config schema; recipe steps reference these
 *  as `{{config.*}}`). Closes the same gap the Tier-1 fix (`d935652b`)
 *  did: an empty `{ type: 'object' }` shows the model NO keys, so it
 *  invents recipe-config field names. Credential variables are dropped
 *  (see `variableToArgProp`); keys are sorted for the deterministic-
 *  projection ratchet. */
/** Variables a GUARD refuses the run without — i.e. genuinely required, whatever
 *  the declaration says.
 *
 *  ⛔⛔ THE GUARD ALREADY KNOWS. A recipe that refuses to run when
 *  `{{config.x}}` is empty has stated that `x` is required; the model-facing
 *  schema was deriving requiredness from a DIFFERENT fact — whether the author
 *  wrote a `default` — and the two disagreed. `open-rental-contract` guarded on
 *  `start_date` while declaring `default: ''`, so the schema said optional, a
 *  live turn omitted it, and the run died on `RECIPE_GUARD_TRIGGERED`. Reading
 *  the guard is strictly better than asking every author to remember: the
 *  requirement is already written down, in the one place that enforces it.
 *
 *  ⚠ ONLY A GUARD / `fail_on`, never a `skip_when`. Emptiness that SKIPS a step
 *  is a documented optional path — `publish-post-social.media_file` is labelled
 *  "Image or video (optional)" and its absence skips the upload. Marking that
 *  required would break behaviour the help text promises.
 *
 *  ⚠ ONE HOP, because every real case routes through a named boolean: an `all`
 *  transform collects the conditions, and a `guard` step reads that boolean. A
 *  check that looked only at direct references would miss all of them.
 *
 *  Pure: same recipe → same set. Shared with the `variable_optional_but_required`
 *  validator rule rather than restated, so a schema and its warning can never
 *  disagree about what the guard said. */
export const guardRequiredVariables = (
  recipe: RecipeDefinition,
): ReadonlySet<string> => {
  const steps: Array<Record<string, unknown>> = [
    ...((recipe.prefetch_steps ?? []) as unknown as Array<Record<string, unknown>>),
    ...((recipe.steps ?? []) as unknown as Array<Record<string, unknown>>),
  ];
  // Step ids whose boolean gates the RUN, plus the guard steps themselves.
  const gating = new Set<string>();
  for (const step of steps) {
    for (const field of ['guard', 'fail_on'] as const) {
      if (step[field] === undefined) continue;
      const blob = JSON.stringify(step[field]);
      for (const other of steps) {
        const id = typeof other.id === 'string' ? other.id : '';
        if (id && blob.includes(`{{step.${id}}}`)) gating.add(id);
      }
      if (typeof step.id === 'string') gating.add(step.id);
    }
  }
  const required = new Set<string>();
  for (const key of Object.keys(recipe.variables ?? {})) {
    // ⛔ A NON-EMPTY DEFAULT ALREADY SATISFIES THE GUARD, so requiredness is
    // moot — preflight fills it and the run proceeds. Marking it required would
    // force the caller to restate a working default (`import-expenses` defaults
    // `column_date` to 'Date' and guards `is_not_empty` on it). Only an
    // EMPTY-or-absent default leaves the guard reachable by omission.
    const declared = (recipe.variables ?? {})[key] as unknown;
    const filled = (declared !== null && typeof declared === 'object' && !Array.isArray(declared))
      ? ('default' in (declared as Record<string, unknown>)
        && (declared as Record<string, unknown>).default !== ''
        && (declared as Record<string, unknown>).default !== null)
      : (declared !== '' && declared !== null && declared !== undefined
        && typeof declared !== 'object');
    if (filled) continue;
    const ref = `{{config.${key}}}`;
    for (const step of steps) {
      const id = typeof step.id === 'string' ? step.id : '';
      const direct = (['guard', 'fail_on'] as const).some((f) =>
        step[f] !== undefined && JSON.stringify(step[f]).includes(ref));
      const viaBoolean = step.conditions !== undefined
        && JSON.stringify(step.conditions).includes(ref)
        && gating.has(id);
      if (!direct && !viaBoolean) continue;
      // `is_not_empty` on the value, or a `fail_on` that trips when it IS empty.
      const text = JSON.stringify([step.conditions, step.guard, step.fail_on]);
      const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`${esc}\\s+is_(not_)?empty`).test(text)) required.add(key);
      break;
    }
  }
  return required;
};

export const deriveTier2ArgSchema = (
  recipe: RecipeDefinition,
): Record<string, unknown> => {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const vars = recipe.variables ?? {};
  // ⛔ The GUARD is the authority on requiredness, not the presence of a default.
  // See {@link guardRequiredVariables}: a recipe that refuses to run without a
  // value has already said it is required, and deriving that from whether the
  // author wrote `default: ''` is how the schema came to invite calls the recipe
  // then rejected.
  const guardRequired = guardRequiredVariables(recipe);
  for (const key of Object.keys(vars).sort()) {
    const prop = variableToArgProp(vars[key]);
    if (!prop) continue; // credential → not an AI-settable arg
    properties[key] = prop.schema;
    if (prop.required || guardRequired.has(key)) required.push(key);
  }
  // D-196 R4 — Tier-2 recipe tools have a complete variable-derived argument
  // surface. Close the schema so a model cannot smuggle server-owned execution
  // carriers (vault/context/credential fields) or arbitrary config keys beside
  // the declared variables. Runtime gateway validation consumes this same
  // projection immediately before dispatch.
  //
  // ⚠ D-232 § 21 — THE EXCHANGE ENVELOPE IS EXEMPT AT THE DOOR, NOT DECLARED
  // HERE. `EXCHANGE_ENVELOPE_KEYS` rides on every cross-server answer, and the
  // MCP argument validator admits it against that same closed list — the way
  // `undeclaredConfigArguments` already does at the config boundary. Spelling
  // the five keys into `properties` instead was tried and reverted: it would add
  // them to EVERY recipe tool's advertised schema on every catalog read, paying
  // a per-entry token cost across the whole chat surface for a protocol
  // allowance that concerns one path. One closed list, two readers.
  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required;
  return schema;
};

/** Spec § A.1.1 — Build a single Tier 2 `ToolEntry` from a recipe +
 *  publisher pair. Returns `null` when the recipe is opted out via
 *  `chat_exposed: false` so the catalog assembler can flat-map without
 *  a separate filter step.
 *
 *  Description sourcing: prefers the recipe's `metadata.description`
 *  (already authored for marketplace surfaces); falls back to the
 *  bare recipe name when description is missing.
 *
 *  Topic-tag sourcing: recipe metadata `tags` (already declared per
 *  D-122 substrate). Per § A.1.1's "topic_tags come from the recipe
 *  manifest" note. Empty when missing (filter-tools then treats the
 *  recipe as topic-free; recipe still surfaces when intent matches).
 *
 *  Classification: defaults to `'unknown'` since recipes can be either
 *  read or write depending on internal step shape. The dispatch
 *  envelope re-classifies on each invocation against the resolved
 *  recipe's manifest (P3 plan-approval gate; § A.11). */
export const buildTier2ToolEntry = (
  entry: Tier2RecipeEntry,
  lookup: IngredientKindLookup,
  opKindLookup?: OpKindLookup,
  /** D-247 D8 — include a recipe whose `chat_exposed` is false.
   *
   *  ⛔⛔ WITHOUT THIS THE FLAG IS STILL A GATE, WHICH IS THE THING D-247 SET OUT
   *  TO STOP. The owner's `recipe.*` grant is authoritative, but it is applied
   *  AFTER this projection — so a hidden recipe the owner explicitly granted was
   *  dropped here before any grant could be consulted, and the grant did nothing.
   *  A filter downstream can only ever NARROW what the projection produced; the
   *  grant has to be able to WIDEN past the author's default.
   *
   *  ⚠ Callers that are NOT owner-governed must leave this false. The door path
   *  has no `recipe.*` axis (its Tier-2 authority is its inbound token), so
   *  including hidden recipes there would widen `tools/list` with nothing left to
   *  narrow it. */
  includeHidden = false,
): ToolEntry | null => {
  if (
    !includeHidden
    && !isRecipeChatExposed(entry.recipe, { user_authored: entry.user_authored ?? false })
  ) {
    return null;
  }
  const meta = entry.recipe.metadata;
  const description = meta?.description?.trim()
    ? meta.description.trim()
    : (meta?.name?.trim() ?? entry.recipe_id);
  const tags: ReadonlyArray<string> = Array.isArray(meta?.tags)
    ? meta.tags.filter(
        (t): t is string => typeof t === 'string' && t.trim().length > 0,
      )
    : [];
  const requires_kinds = deriveRecipeRequiresKinds(entry.recipe, lookup, opKindLookup);
  const toolEntry: ToolEntry = {
    name: formatTier2ToolName(entry.publisher_id, entry.recipe_id),
    tier: 2,
    description,
    arg_schema: deriveTier2ArgSchema(entry.recipe),
    topic_tags: tags,
    classification: 'unknown',
    // D-164 § 6 — Tier 2 catalog entries are sealed sequential today.
    // Classification above is hardcoded `'unknown'` (the dispatch
    // envelope re-classifies on each invocation against the resolved
    // recipe manifest before § A.11's plan-approval gate), so a write-
    // capable recipe could be hidden behind the umbrella — sequential
    // is the safer default. No recipe manifest carries a
    // `concurrency_safe` declaration yet; when that metadata lands, a
    // future fold flips known-safe entries (read recipes; known-safe
    // writes against separate scopes) into the parallel path.
    concurrency_safe: false,
  };
  if (requires_kinds.length > 0) {
    (toolEntry as { requires_kinds?: ReadonlyArray<IngredientKind> })
      .requires_kinds = requires_kinds;
  }
  return toolEntry;
};

/** Spec § A.1.1 — build the full Tier 2 catalog from a snapshot of
 *  installed recipes. Opted-out recipes drop silently; the result is
 *  sorted by Tier 2 name (`<publisher>/<slug>` ascending) for
 *  deterministic ordering downstream — `filter-tools` already sorts
 *  its catalog input by slug, but a deterministic source-side order
 *  keeps the registry's `list()` output stable across calls. */
export const buildTier2Catalog = (
  entries: ReadonlyArray<Tier2RecipeEntry>,
  lookup: IngredientKindLookup,
  opKindLookup?: OpKindLookup,
  /** D-247 D8 — see {@link buildTier2ToolEntry}. Owner-governed callers pass
   *  `true` and let the `recipe.*` grant decide; every other caller must not. */
  includeHidden = false,
): ReadonlyArray<ToolEntry> => {
  const projected: ToolEntry[] = [];
  for (const e of entries) {
    const entry = buildTier2ToolEntry(e, lookup, opKindLookup, includeHidden);
    if (entry) projected.push(entry);
  }
  projected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return projected;
};

/** Lever-2 (2026-07-02) — pure ranked search over a tool catalog, backing
 *  the `tools.search` Tier-1 meta-tool. Index mode ships a thin catalog
 *  (slug + summary, no arg schema); the model calls `tools.search` to
 *  recover the FULL entries for a capability, and this scores them.
 *
 *  Deliberately in-memory term-overlap rather than FTS5: the catalog is a
 *  live, per-call-reprojected in-memory array of at most a few hundred
 *  entries, so a linear scan is sub-millisecond and needs zero index /
 *  persistence. FTS5 (a persistent virtual table) + D-131 embeddings are
 *  the scale/fuzzy path if the catalog grows into the thousands or
 *  semantic recall is needed — a later slice, not the prototype.
 *
 *  Scoring: per query term, +3 if it is a substring of the slug, +2 a
 *  topic tag, +1 the description — so a slug hit dominates a description
 *  hit. Entries scoring 0 drop. Ties break on name ascending, so the
 *  result is fully deterministic (safe for ratcheting). Pure: same inputs
 *  → same output, no clock, no I/O.
 *
 *  Query terms shorter than 2 characters are dropped: a single character
 *  (the stopwords "a" / "I", a stray digit) matches as a substring almost
 *  everywhere and would pull unrelated tools into the tail. Substring (not
 *  whole-word) matching is deliberate — it keeps plural/stem recall
 *  ("email" finds "emails") at the cost of some 2-char noise, which stays
 *  low-ranked; whole-word + embeddings is the precision refinement. */
/** ⛔ THE SCORER LIVES IN `@recued/contracts` (`scoreSearchable`), NOT HERE.
 *  The owner's Data → Find surface searches the same installed recipes through
 *  its own projection; two scorers with matching weights are two rules that
 *  agree only until someone edits one, and the symptom — "the assistant found it
 *  and my search did not" — is invisible from either side. */

export const searchToolCatalog = (
  entries: ReadonlyArray<ToolEntry>,
  query: string,
  limit: number,
): ReadonlyArray<ToolEntry> => rankSearchable(
  entries,
  (entry) => ({
    name: entry.name,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    tags: entry.topic_tags,
  }),
  query,
  limit,
);

import type {
  EnrichmentDeclaration,
  EntityRef,
  IngredientKind,
  SuggestDirective,
  ToolEntry,
} from '@recued/contracts';

/** Opaque branded string for request_start/request_end envelope correlation. */
export type EnvelopeId = string & { readonly __brand: 'EnvelopeId' };

/** Coerce a raw string into the branded EnvelopeId. The brand is nominal-only;
 *  callers (engine envelope emitter, gate orchestrator) mint ids here so call
 *  sites don't litter `as EnvelopeId` casts. */
export const mintEnvelopeId = (s: string): EnvelopeId => s as EnvelopeId;

/** The 6-section discriminator for catalog assembly. */
export type CatalogSection =
  | 'entity-query'
  | 'entity-action'
  | 'memory-recall'
  | 'enrichment'
  | 'recipes'
  | 'other';

/** NER template kind — render vs structural planning split (design O-6).
 *
 *  Two distinct caching strategies the gate dispatches on:
 *    - `'render_template'` — deterministic short-circuit-eligible. The
 *      template carries a `body` format string + slot grammar; the
 *      renderer interpolates a probe snapshot into `body` and `ctx.resolve`
 *      replaces the LLM call. Validator-gated at registration: no `ai-*`
 *      / no mutations / no nested-template references.
 *    - `'structural_plan'` — NOT short-circuit-eligible. Caches the
 *      ROUTING decision (which sequence of tools to dispatch) but the
 *      plan still replays through the main executor / gateway / audit /
 *      approval path. P4f scope is render-only; structural plan is a
 *      placeholder for future slices and carries no body. */
export type TemplateKind = 'render_template' | 'structural_plan';

/** Universal slot vocabulary — extend here as the slot registry grows. */
export type SlotName =
  | 'entity.name'
  | 'entity.email'
  | 'date'
  | 'time';
// extend here

/** NER-template record carried in the unified library — discriminated
 *  on `kind`. Consumers narrow with `template.kind === 'render_template'`
 *  before reading the `body` field; the type-system enforces it.
 *
 *  Common fields across both kinds:
 *    - `template_hash` — composite-recipe-hash from the lookup key (NER
 *      slots + verb pattern + locale). Stable identifier audit logs +
 *      cache stores key on.
 *    - `slot_grammar` — the NER slot kinds the template requires. The
 *      library matches templates against extracted slots by comparing
 *      this set.
 *    - `action_class` — read-only at current scope (design § 3 Invariant 1:
 *      NER vocabulary can't reach mutations). Future extensions add
 *      `'write'` / `'destructive'`; the gate would then enforce action-class
 *      mismatch as pass-through.
 *    - `short_circuit_eligible` — fixed per kind. `render_template` is
 *      always `true` (deterministic by construction); `structural_plan`
 *      is always `false` (replays through executor). Carrying the flag
 *      on each variant lets the gate make the dispatch decision without
 *      re-checking `kind`. */
export type Template = RenderTemplate | StructuralPlan;

/** A render template carries the body format string the renderer
 *  interpolates against a `DataSnapshot`. The body uses `{{path}}`
 *  placeholders that resolve via dot-notation into `snapshot.data`.
 *
 *  Validation at registration (per design § 3 Invariant 2 — deterministic
 *  by construction): every `{{path}}` referenced in the body must resolve
 *  to a string-typed value when the snapshot is supplied. Templates with
 *  malformed bodies / unknown paths are rejected at promotion / bundle
 *  load time; the renderer assumes a validated template at call time and
 *  throws on any runtime path miss (the throw is the bug signal, not the
 *  user-visible behavior — the gate's pass-through layer is the safety
 *  net). */
export interface RenderTemplate {
  readonly template_hash: string;
  readonly kind: 'render_template';
  readonly slot_grammar: readonly SlotName[];
  readonly action_class: 'read';
  readonly short_circuit_eligible: true;
  readonly body: string;
}

/** A structural plan caches the routing/tool-dispatch sequence the LLM
 *  would otherwise have to recompose each turn. Placeholder shape for
 *  P4f; the steps schema lands when the structural-plan executor wires
 *  in (post-P4 series). The kind is reserved here so the discriminated
 *  union is closed + the library / validator can pattern-match safely. */
export interface StructuralPlan {
  readonly template_hash: string;
  readonly kind: 'structural_plan';
  readonly slot_grammar: readonly SlotName[];
  readonly action_class: 'read';
  readonly short_circuit_eligible: false;
}

/** Type guard: narrow `Template` to `RenderTemplate`. */
export const isRenderTemplate = (template: Template): template is RenderTemplate => (
  template.kind === 'render_template'
);

/** Type guard: narrow `Template` to `StructuralPlan`. */
export const isStructuralPlan = (template: Template): template is StructuralPlan => (
  template.kind === 'structural_plan'
);

/** Composite NER + verb-pattern cache key. */
export interface CacheKey {
  readonly entity: EntityRef | null;
  readonly verb: string;
  readonly locale: string;
}

/** Hash-pinned template bundle manifest downloaded from recued.com. */
export interface TemplateBundle {
  readonly template_hash: string;
  readonly source_version: string;
  /** Payload schema is greenfield — typed as unknown until P4. */
  readonly payload: unknown;
}

// ────────────────────────────────────────────────────────────────
// D-164 P3 — catalog substrate shapes
// ────────────────────────────────────────────────────────────────

/** One tool entry inside a SectionAssembly.
 *
 *  - `name` matches `ToolEntry.name` for registry-sourced sections
 *    (entity-query / entity-action / memory-recall / recipes / other);
 *    matches the enrichment topic for the enrichment section.
 *  - `description` is the LLM-facing one-liner. Sourced per-tool from
 *    the registry for non-enrichment sections; sourced from the caller-
 *    supplied `enrichmentDescriptions` map for the enrichment section.
 *  - `return_shape` carries the bench-style `{field: type}` annotation
 *    only for the enrichment section; omitted on registry-sourced
 *    sections whose tools advertise via `arg_schema` instead.
 *  - `concurrency_safe` reflects the D-160 batch-dispatch contract per
 *    D-164 § 6. Enrichment entries pull this from the declaration;
 *    registry-sourced entries pull this per-entry off the source
 *    ToolEntry (Tier 1 from the closed-list `TIER1_CONCURRENCY_SAFE`,
 *    Tier 2 sealed `false` by `buildTier2ToolEntry` until recipe-
 *    manifest concurrency metadata lands, Tier 3 sealed `false` by
 *    `buildTier3ToolEntry` until per-vendor override metadata lands).
 *    The section assemblers no longer apply a section-level default —
 *    every contributing surface owns its own value.
 *  - `suggest_directive` is the producer's default NOT-FOUND fallback;
 *    populated only on enrichment entries. `null` means no fallback. */
export interface CatalogToolEntry {
  readonly name: string;
  readonly description: string;
  readonly concurrency_safe: boolean;
  readonly return_shape?: string;
  readonly suggest_directive?: SuggestDirective | null;
}

/** A single catalog section with its framing description + tool list.
 *
 *  Section descriptions are the prompt-rendering substrate's primary
 *  navigational signal per bench HANDOFF §1 (per-section labels lifted
 *  target-topic intent 0% → 67-100% on smoke). Tools within a section
 *  are listed in stable order — alphabetical by `name` for
 *  registry-sourced sections, alphabetical by topic for enrichment. */
export interface SectionAssembly {
  readonly section: CatalogSection;
  readonly description: string;
  readonly tools: ReadonlyArray<CatalogToolEntry>;
}

/** Output of `assembleCatalog` — the 6-section catalog the prompt
 *  renderer (P4) consumes. Sections appear in bench-validated display
 *  order: enrichment first (fast track), entity-query second (safe
 *  path / resolver), followed by the four extrapolation sections. */
export interface SectionedCatalog {
  readonly sections: ReadonlyArray<SectionAssembly>;
}

/** Per-user/per-server capability snapshot the catalog assembler reads
 *  to filter visible tools.
 *
 *  - `connectedVendors` — set of `connection.api.<vendor>` names the
 *    user has provisioned (e.g. `'hubspot'`, `'salesforce'`). Drives
 *    the `other` section's visibility of vendor APIs.
 *  - `enabledKinds` — per-`IngredientKind` toggles from D-137 § A.1.1
 *    catalog scope. Used by `entity-action` to hide recipes whose
 *    `requires_kinds` includes any disabled kind.
 *  - `enabledEnrichmentTopics` — per-topic membership from D-132
 *    enrichment_trust (caller resolves `trust_state` ∈ `'manual'` /
 *    `'auto'` to set membership). The enrichment section filters by
 *    this set; topics absent from the set are hidden entirely. */
export interface CatalogCapabilities {
  readonly connectedVendors: ReadonlySet<string>;
  readonly enabledKinds: ReadonlySet<IngredientKind>;
  readonly enabledEnrichmentTopics: ReadonlySet<string>;
}

/** Input to `assembleCatalog`.
 *
 *  - `registryTools` — the post-D-137-filter union of Tier 1 / Tier 2
 *    / Tier 3 entries from `InternalToolRegistry.list()`. The catalog
 *    substrate partitions this list by section using each entry's
 *    `name` + `tier` + `classification`.
 *  - `enrichmentDeclarations` — per-topic declarations keyed by topic
 *    name. Sourced from `D145_PRODUCER_DECLARATIONS` (plus future
 *    declarations); the enrichment section reads `return_shape`,
 *    `concurrency_safe`, and `suggest_directive` directly.
 *  - `enrichmentDescriptions` — per-topic LLM-facing one-liner keyed
 *    by topic name. P4 sources from `ENRICHMENT_REGISTRY[topic].description`;
 *    callers may supply richer per-topic copy. Topics absent from this
 *    map default to a short placeholder so the catalog assembler never
 *    omits a topic for missing copy.
 *  - `capabilities` — per-user filter inputs. */
export interface CatalogAssemblyInput {
  readonly registryTools: ReadonlyArray<ToolEntry>;
  readonly enrichmentDeclarations: ReadonlyMap<string, EnrichmentDeclaration>;
  readonly enrichmentDescriptions: ReadonlyMap<string, string>;
  readonly capabilities: CatalogCapabilities;
}

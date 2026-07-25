/**
 * Connection-agnostic op dispatch (slice 2) — the install-path resolver
 * `resolveOpStepRecipes` (R1 install-time rewrite).
 *
 * Proves the install path's op-step handling, with the field mapping sourced
 * from the REGISTRY (slice-2 decision — `entityFieldsFromRegistry`, frozen):
 *   - resolve   — an op-step recipe rewrites to a concrete vendor-bound recipe
 *     (`<id>__raw` catalog fetch + `<id>` projection map) using REGISTRY field
 *     paths, and the rewritten recipe RUNS through the real engine producing
 *     canonical-named projection;
 *   - fast path — a recipe set with no op-steps passes through untouched;
 *   - hard-block (per the three-layer gate "op-step + no registry entry → block")
 *     — unknown vendor catalog / no bound connection / op the pack doesn't model
 *     / op-step in prefetch_steps;
 *   - WARN      — a collection op resolving to no result_path (bare array);
 *   - override  — a per-op `result_path` wins over the surface default.
 * Spec: internal design notes.
 */
import { describe, it, expect } from 'vitest';
import type {
  ConnectionOperationProfile,
  IngredientManifest,
  NamespaceStores,
  OperationRow,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import { executeRecipe, type ExecutionContext, type IngredientExecutor } from '@recued/engine';
import {
  resolveBundledPackRecipes,
  resolveOpStepRecipes,
  resolvePerSlotOpStepRecipe,
} from '../install-composition.js';

// ── The ONE canonical, connection-agnostic recipe (vendor-neutral) ──
const canonicalRecipe = (groupField: string): RecipeDefinition => ({
  recipe_id: 'surface-open-deals-canonical',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'surface-open-deals-canonical',
    description: 'slice-2 test — connection-agnostic canonical recipe',
    author: 'test',
    supported_platforms: [],
  },
  variables: { group_field: groupField },
  prefetch_steps: [],
  steps: [
    { id: 'deals', op: 'deal.search', args: { limit: 200 } } as unknown as RecipeStep,
    {
      id: 'open',
      transform: 'filter',
      array: '{{step.deals}}',
      field: 'stage',
      operator: 'not_equal',
      value: 'closed_won',
    } as unknown as RecipeStep,
    {
      id: 'grouped',
      transform: 'group_by',
      array: '{{step.open}}',
      field: '{{config.group_field}}',
      aggregate: {
        deal_count: { operator: 'count' },
        total_value: { field: 'amount', operator: 'sum' },
      },
    } as unknown as RecipeStep,
  ],
  output: { sidebar: [] },
});

// A concrete (no op-step) recipe — exercises the fast path.
const plainRecipe = (): RecipeDefinition => ({
  recipe_id: 'plain-concrete',
  version: 1,
  ttl: 300,
  metadata: { name: 'plain', description: 'no op-steps', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'x', ingredient: 'deal-list-reader-hubspot', input: {} } as unknown as RecipeStep,
  ],
  output: { sidebar: [] },
});

const dealSearchOp = (resultPath?: string): OperationRow => ({
  family: 'deal',
  operation: 'deal.search',
  verb: 'post',
  surface: 'api',
  binding: { kind: 'rest', method: 'POST', path_template: '/crm/v3/objects/deals/search' },
  risk_tier: 'read',
  approval: 'never',
  groups: ['deal.read'],
  reviewed: true,
  ...(resultPath !== undefined ? { result_path: resultPath } : {}),
});

// default-shaped vendor resolver: reverse of CATALOG_VENDOR_SLUGS.
const vendorForCatalog = (slug: string): string | undefined =>
  slug === 'hubspot-catalog' ? 'hubspot' : undefined;

const baseInputs = {
  packSlug: 'pack/recued-core/hubspot',
  catalogSlug: 'hubspot-catalog',
  connection: 'hubspot1' as string | undefined,
  surfaceResultPath: 'results',
  // NEXT-1 — the catalog-declared search dialect selects the resolver's query
  // builder; a `deal.search` op-step fails closed without it.
  searchStyle: 'hubspot_search' as const,
  operationFamilies: [dealSearchOp()],
};

const stepById = (recipe: RecipeDefinition, id: string): Record<string, unknown> =>
  recipe.steps.find((s) => s.id === id) as unknown as Record<string, unknown>;

describe('resolveOpStepRecipes (slice 2 — R1 install-time rewrite, registry-sourced fields)', () => {
  it('rewrites an op-step recipe → concrete fetch + projection using REGISTRY field paths', () => {
    const res = resolveOpStepRecipes(vendorForCatalog, [canonicalRecipe('stage')], baseInputs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recipe = res.recipes[0];
    // op-step 'deals' expands to a '__raw' fetch + a 'deals' projection (keeps id).
    expect(recipe.steps.map((s) => s.id)).toEqual(['deals__raw', 'deals', 'open', 'grouped']);

    const raw = stepById(recipe, 'deals__raw');
    expect(raw.ingredient).toBe('hubspot-catalog');
    expect(raw.connection).toBe('hubspot1');
    // NEXT-1: the canonical `{ limit: 200 }` is derived into the HubSpot search
    // POST body — `body.limit` + `body.properties` (the registry SELECT, bare
    // property names). The COMPUTED `close_state` (a closed_state derivation) IS
    // projected, and its two input flags (hs_is_closed + hs_is_closed_won) are
    // SELECTed. Walk-all: `body.limit` is the per-PAGE size, clamped to HubSpot's
    // hard per-request max (100); the gateway walks `paging.next.after` for the set.
    const rawInput = raw.input as { operation: string; args: Record<string, unknown> };
    expect(rawInput.operation).toBe('deal.search');
    expect(rawInput.args['body.limit']).toBe(100);
    expect(rawInput.args['body.properties']).toEqual(
      expect.arrayContaining([
        'dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'closedate', 'createdate',
        'hs_is_closed', 'hs_is_closed_won',
      ]),
    );

    const proj = stepById(recipe, 'deals');
    expect(proj.transform).toBe('map');
    // surface default result_path, under the connection-api `.result` envelope.
    expect(proj.array).toBe('{{step.deals__raw.result.results}}');
    const expr = proj.expression as Record<string, unknown>;
    // projection uses REGISTRY source paths (nested properties.*), not pack-authored.
    expect(expr.name).toBe('{{item.properties.dealname}}');
    // G2: a number-typed canonical field coerces a string vendor value at the projection.
    expect(expr.amount).toBe('{{item.properties.amount | number}}');
    expect(expr.stage).toBe('{{item.properties.dealstage}}');
    // a DOTTED canonical field (key_dates.*) nests in the projection template so a
    // dotted `{{item.key_dates.close_date}}` read downstream resolves (not a flat key).
    // G2 datetime unify: a `date_ms`/datetime field coerces (epoch-ms | ISO) → unix-ms.
    expect(expr.key_dates).toEqual({
      close_date: '{{item.properties.closedate | date_ms}}',
      created_at: '{{item.properties.createdate | date_ms}}',
      next_activity_at: '{{item.properties.notes_next_activity_date | date_ms}}',
      last_activity_at: '{{item.properties.notes_last_contacted | date_ms}}',
    });
    // The COMPUTED `close_state` (closed_state derivation, the G3 lift) projects to a
    // nested $ternary over the two vendor flags: closed ? (won ? "won" : "lost") : "open".
    expect(expr.close_state).toEqual({
      $ternary: {
        if: '{{item.properties.hs_is_closed}}',
        then: { $ternary: { if: '{{item.properties.hs_is_closed_won}}', then: 'won', else: 'lost' } },
        else: 'open',
      },
    });
    expect(res.warnings).toEqual([]);
  });

  it('the rewritten recipe RUNS through the real engine → canonical-named projection', async () => {
    const res = resolveOpStepRecipes(vendorForCatalog, [canonicalRecipe('stage')], baseInputs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // raw HubSpot search envelope: { results: [{ id, properties: {...} }] }.
    const RAW = {
      results: [
        { id: '1', properties: { dealname: 'D1', amount: 100, dealstage: 'Prospect', hubspot_owner_id: 'o1', pipeline: 'default', closedate: 1700000000000 } },
        { id: '2', properties: { dealname: 'D2', amount: 200, dealstage: 'Prospect', hubspot_owner_id: 'o2', pipeline: 'default' } },
        { id: '3', properties: { dealname: 'D3', amount: 300, dealstage: 'closed_won', hubspot_owner_id: 'o1', pipeline: 'default' } },
      ],
    };
    const manifest = {
      slug: 'hubspot-catalog', name: 'HubSpot', description: 't', author: 'recued-core',
      kind: 'connection', version: 1, category: 'data', risk_tier: 'read',
      input: { operation: null, args: null }, output: { result: 'result' },
      operations: { 'deal.search': { operation_id: 'recued-core/hubspot-catalog.deal.search', risk_tier: 'read', groups: ['deal.read'], approval: 'never', required_scopes: ['crm.objects.deals.read'] } },
      surfaces: { api: { transport: 'rest', default_base_url: 'https://api.hubapi.com', auth: { kind: 'none' }, executes: { 'deal.search': { kind: 'rest', method: 'POST', path_template: '/crm/v3/objects/deals/search' } } } },
    } as unknown as IngredientManifest;

    const stores: NamespaceStores = { vault: {}, config: { group_field: 'stage' }, context: {}, meta: {}, step: {} };
    const ingredientExecutor: IngredientExecutor = async (slug) => {
      // Model the connection-api dispatch shape: `{ status, headers, result }`
      // with the catalog `output: { result: "result" }` keeping the vendor body
      // under `.result` — so the projection reads `{{step.deals__raw.result.results}}`.
      if (slug === 'hubspot-catalog') return { result: RAW };
      throw new Error(`unexpected ingredient '${slug}'`);
    };
    const ctx: ExecutionContext = {
      recipe: res.recipes[0],
      stores,
      ingredientExecutor,
      manifestGetter: (slug: string) => (slug === 'hubspot-catalog' ? manifest : null),
      connectionProfileResolver: (): ConnectionOperationProfile => ({
        allowed_operations: ['deal.search'],
        catalog_slug: 'hubspot-catalog',
      }),
    };
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);
    // canonical projection: raw properties.* → canonical names, type-preserved.
    const projected = result.steps.find((s) => s.id === 'deals')?.result as Array<Record<string, unknown>>;
    expect(projected).toHaveLength(3);
    expect(projected[0]).toMatchObject({ name: 'D1', amount: 100, stage: 'Prospect', owner: 'o1' });
    expect(typeof projected[0].amount).toBe('number');
    // dotted canonical field nests in the runtime output (not a flat 'key_dates.close_date' key).
    expect(projected[0].key_dates).toMatchObject({ close_date: 1700000000000 });
    // open deals (stage != closed_won) grouped by stage → one 'Prospect' group, sum 300.
    const grouped = result.steps.find((s) => s.id === 'grouped')?.result as Array<Record<string, unknown>>;
    const prospect = grouped.find((g) => g.stage === 'Prospect');
    expect(prospect?.deal_count).toBe(2);
    expect(prospect?.total_value).toBe(300);
  });

  it('fast path — a recipe set with no op-steps passes through untouched', () => {
    const plain = plainRecipe();
    const res = resolveOpStepRecipes(vendorForCatalog, [plain], baseInputs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recipes[0]).toBe(plain); // same reference — unchanged
    expect(res.warnings).toEqual([]);
  });

  it('hard-block — catalog has no known vendor', () => {
    const res = resolveOpStepRecipes(
      () => undefined,
      [canonicalRecipe('stage')],
      { ...baseInputs, catalogSlug: 'mystery-catalog' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('not a known catalog vendor');
  });

  it('hard-block — no bound connection', () => {
    const res = resolveOpStepRecipes(
      vendorForCatalog,
      [canonicalRecipe('stage')],
      { ...baseInputs, connection: undefined },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('no bound connection');
  });

  it('hard-block — the pack does not model the canonical op', () => {
    const res = resolveOpStepRecipes(
      vendorForCatalog,
      [canonicalRecipe('stage')],
      { ...baseInputs, operationFamilies: [] }, // no deal.search
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('surface-open-deals-canonical');
    expect(res.message).toContain('no operation');
  });

  it('hard-block — a (malformed) op-step in prefetch_steps (defensive — unsupported)', () => {
    // `prefetch_steps` is typed `PrefetchStep[]` (always carries `ingredient`), so
    // an op-step can only reach it via malformed JSON — cast through `unknown` to
    // simulate that and prove the defensive guard fires rather than persisting it.
    const r = canonicalRecipe('stage');
    const withPrefetch = {
      ...r,
      prefetch_steps: [{ id: 'pf', op: 'deal.search', args: {} }],
    } as unknown as RecipeDefinition;
    const res = resolveOpStepRecipes(vendorForCatalog, [withPrefetch], baseInputs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('prefetch_steps');
  });

  it('WARN — a collection op resolves to no result_path (bare array at root)', () => {
    const res = resolveOpStepRecipes(
      vendorForCatalog,
      [canonicalRecipe('stage')],
      { ...baseInputs, surfaceResultPath: '', operationFamilies: [dealSearchOp()] },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings.map((w) => w.code)).toContain('authoring_install_op_no_result_path');
    // the projection reads the connection-api `.result` body directly (no envelope key).
    expect(stepById(res.recipes[0], 'deals').array).toBe('{{step.deals__raw.result}}');
  });

  it('per-op result_path override wins over the surface default (no WARN)', () => {
    const res = resolveOpStepRecipes(
      vendorForCatalog,
      [canonicalRecipe('stage')],
      { ...baseInputs, surfaceResultPath: 'results', operationFamilies: [dealSearchOp('data')] },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(stepById(res.recipes[0], 'deals').array).toBe('{{step.deals__raw.result.data}}');
    expect(res.warnings).toEqual([]);
  });

  it('an EMPTY per-op result_path inherits the surface default (decided "empty = inherit", not bare array)', () => {
    const res = resolveOpStepRecipes(
      vendorForCatalog,
      [canonicalRecipe('stage')],
      { ...baseInputs, surfaceResultPath: 'results', operationFamilies: [dealSearchOp('')] },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // '' per-op does NOT force a bare array — it inherits the non-empty surface default.
    expect(stepById(res.recipes[0], 'deals').array).toBe('{{step.deals__raw.result.results}}');
    expect(res.warnings).toEqual([]);
  });
});

// ── A3 (slice 3) — resolveBundledPackRecipes: the marketplace-path entry that
//    derives the resolution context from the pack's composition. The decompose+
//    resolve happy path is covered end-to-end by the packs.install test
//    (d-170-packs-install-composition.test.ts); here we cover the two pure
//    branches that don't need a composition fixture.
describe('resolveBundledPackRecipes (slice 3 / A3)', () => {
  it('fast path — no op-step recipes passes through even without a composition', () => {
    const plain = plainRecipe();
    const res = resolveBundledPackRecipes(undefined, 'pack/x', [plain]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recipes[0]).toBe(plain); // same reference — untouched
    expect(res.warnings).toEqual([]);
  });

  it('hard-block — an op-step recipe with no composition to bind against', () => {
    const res = resolveBundledPackRecipes(undefined, 'pack/x', [canonicalRecipe('stage')]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('no composition to bind');
  });
});

// ── Per-operand connection slots (R2 build step 5, doc §1.3) ──
describe('resolveOpStepRecipes — per-operand connection slots (R2 step 5)', () => {
  const connVar = () => {
    const def = { label: 'CRM', type: 'connection', connection_kind: 'api', default: '' };
    return def as unknown as RecipeDefinition['variables'][string];
  };

  /** canonicalRecipe with declared connection variables + per-step slots. */
  const slottedRecipe = (
    variables: Record<string, RecipeDefinition['variables'][string]>,
    stepSlots: Record<string, string | undefined>,
  ): RecipeDefinition => {
    const base = canonicalRecipe('stage');
    const steps = base.steps.map((s) => {
      const slot = stepSlots[(s as { id: string }).id];
      return slot === undefined ? s : ({ ...s, connection: slot } as unknown as RecipeStep);
    });
    return { ...base, variables: { ...base.variables, ...variables }, steps };
  };

  it('an explicit slot beats the pack default; a slot-less sibling op-step keeps it', () => {
    const base = canonicalRecipe('stage');
    const twoOps: RecipeDefinition = {
      ...base,
      variables: { ...base.variables, crm_a: connVar() },
      steps: [
        { id: 'deals', op: 'deal.search', args: { limit: 200 }, connection: '{{config.crm_a}}' } as unknown as RecipeStep,
        { id: 'more_deals', op: 'deal.search', args: { limit: 1 } } as unknown as RecipeStep,
      ],
    };
    const res = resolveOpStepRecipes(vendorForCatalog, [twoOps], baseInputs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(stepById(res.recipes[0], 'deals__raw').connection).toBe('{{config.crm_a}}');
    expect(stepById(res.recipes[0], 'more_deals__raw').connection).toBe('hubspot1');
  });

  it('AMBIGUITY OUTRANKS THE PACK DEFAULT — multi-var recipe with a slot-less op-step hard-blocks even with auth.connection (codex M1)', () => {
    const recipe = slottedRecipe({ crm_a: connVar(), crm_b: connVar() }, {});
    const res = resolveOpStepRecipes(vendorForCatalog, [recipe], baseInputs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('2 connection variables');
    expect(res.message).toContain("op-step 'deals' must name its slot explicitly");
  });

  it('a fully-slotted multi-var recipe resolves under a pack default (each slot wins)', () => {
    const recipe = slottedRecipe(
      { crm_a: connVar(), crm_b: connVar() },
      { deals: '{{config.crm_b}}' },
    );
    const res = resolveOpStepRecipes(vendorForCatalog, [recipe], baseInputs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(stepById(res.recipes[0], 'deals__raw').connection).toBe('{{config.crm_b}}');
  });

  it('a connection-less pack + a single-connection-variable recipe binds {{config.<var>}} (the lift)', () => {
    const recipe = slottedRecipe({ crm: connVar() }, {});
    const res = resolveOpStepRecipes(vendorForCatalog, [recipe], {
      ...baseInputs,
      connection: undefined,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(stepById(res.recipes[0], 'deals__raw').connection).toBe('{{config.crm}}');
  });

  it('a connection-less pack + a zero-variable recipe hard-blocks with the combined message', () => {
    const res = resolveOpStepRecipes(vendorForCatalog, [canonicalRecipe('stage')], {
      ...baseInputs,
      connection: undefined,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('has no connection to bind');
    expect(res.message).toContain("declares no type:'connection'");
  });

  it('recipes with DIFFERENT single connection variables each bind their own ref (cross-recipe rule retired)', () => {
    const a = { ...slottedRecipe({ crm_a: connVar() }, {}), recipe_id: 'recipe-a' };
    const b = { ...slottedRecipe({ crm_b: connVar() }, {}), recipe_id: 'recipe-b' };
    const res = resolveOpStepRecipes(vendorForCatalog, [a, b], {
      ...baseInputs,
      connection: undefined,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(stepById(res.recipes[0], 'deals__raw').connection).toBe('{{config.crm_a}}');
    expect(stepById(res.recipes[1], 'deals__raw').connection).toBe('{{config.crm_b}}');
  });

  it('hard-blocks an invalid slot ref with the recipe/step-scoped message', () => {
    const recipe = slottedRecipe({ crm_a: connVar() }, { deals: 'hubspot1' });
    const res = resolveOpStepRecipes(vendorForCatalog, [recipe], baseInputs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("op-step 'deals' has an invalid connection slot 'hubspot1'");
  });

  it('hard-blocks a slot naming an undeclared variable AT THE PLAN LAYER (not the resolver fallback)', () => {
    const recipe = slottedRecipe({ crm_a: connVar() }, { deals: '{{config.ghost}}' });
    const res = resolveOpStepRecipes(vendorForCatalog, [recipe], baseInputs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The PLAN's message shape (`recipe '<id>' op-step '<id>' connection slot …`),
    // NOT the resolver wrapper's (`recipe '<id>': canonical op '<op>' (step '<id>') …`)
    // — pins that the install plan checks declaration ITSELF rather than leaning
    // on the resolver's defense-in-depth re-check.
    expect(res.message).toContain(
      "recipe 'surface-open-deals-canonical' op-step 'deals' connection slot names variable 'ghost'",
    );
    expect(res.message).not.toContain('canonical op');
    expect(res.message).toContain("not declared as a type:'connection' variable");
  });
});

// §5 tool-op pack seam (brick 2) — the DISPATCH-side per-operand resolver must
// take the resolver's TOOL branch for a non-crm_alias op family AND, crucially,
// NOT emit the collection-op `authoring_install_op_no_result_path` warning for it
// (a tool op has verb 'search' + an intentionally empty result_path — the
// pass-through raw response IS the output; the warning is gated on
// `op_kind !== 'tool'`). Regression guard for the second warning site.
describe('resolvePerSlotOpStepRecipe — §5 tool op (entity-less, pass-through)', () => {
  const exaToolRecipe = (): RecipeDefinition => ({
    recipe_id: 'search-web-exa',
    version: 1,
    ttl: 300,
    metadata: { name: 'web search', description: 'tool op', author: 'test', supported_platforms: [] },
    variables: {
      exa: { label: 'Exa', type: 'connection', connection_kind: 'api', default: '' } as unknown as RecipeDefinition['variables'][string],
    },
    prefetch_steps: [],
    steps: [
      { id: 'search', op: 'web.search', args: { 'body.query': 'acme news' } } as unknown as RecipeStep,
    ],
    output: { sidebar: [] },
  });

  const exaCatalogManifest = (): IngredientManifest => ({
    slug: 'exa-catalog',
    name: 'Exa catalog',
    description: 'entity-less tool catalog',
    author: 'recued-core',
    kind: 'connection',
    version: 1,
    category: 'data',
    risk_tier: 'read',
    input: { operation: null, args: null },
    output: { result: 'result' },
    operations: {
      'web.search': { operation_id: 'recued-core/exa.web.search', risk_tier: 'read', groups: ['recued-core/exa.web.read'] },
    },
    // A surface result_path is declared (Exa wraps in `results`), but a TOOL op
    // dispatches pass-through with a FIXED empty binding result_path — so the
    // collection-op warning must NOT fire regardless of this surface value.
    surfaces: { api: { transport: 'rest', default_base_url: 'https://api.exa.ai', result_path: 'results', auth: { kind: 'none' }, executes: { 'web.search': { kind: 'rest', method: 'POST', path_template: '/search' } } } },
  } as unknown as IngredientManifest);

  const exaVendor = (slug: string): string | undefined => (slug === 'exa-catalog' ? 'exa' : undefined);

  it('resolves to a single pass-through fetch with NO result_path warning', () => {
    const catalogBySlot = new Map([['exa', exaCatalogManifest()]]);
    const res = resolvePerSlotOpStepRecipe(exaToolRecipe(), catalogBySlot, 'pack/recued-core/exa', exaVendor);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Single-step (no `search__raw` split, no projection step) — the tool path.
    const ids = res.recipe.steps.map((s) => s.id);
    expect(ids).toEqual(['search']);
    const fetch = res.recipe.steps[0] as unknown as Record<string, unknown>;
    expect(fetch.ingredient).toBe('exa-catalog');
    expect(fetch.connection).toBe('{{config.exa}}');
    expect(fetch.input).toMatchObject({ operation: 'web.search', args: { 'body.query': 'acme news' } });
    // The gate: a tool op's verb is 'search' + result_path '' but op_kind 'tool'
    // → the collection-op missing-result_path warning is suppressed at this site.
    expect(res.warnings).toEqual([]);
  });
});

/** Per-operand connection slots (R2 build step 5, recipe-identity doc §1.3).
 *
 *  Resolver-level coverage of the lift from "a pack binds one connection" to
 *  per-operand slots:
 *    - `CanonicalOpStep.connection` (a pure `{{config.<var>}}` ref) overrides
 *      the ctx default per step; the slot must name a DECLARED
 *      `type:'connection'` variable (fail-closed at the resolver layer too,
 *      independent of the recipe validator — the codex M2 fold);
 *    - `resolveConnectionAgnosticRecipe` accepts a per-step ctx SELECTOR, so a
 *      multi-operand recipe resolves each op-step against its own
 *      vendor/catalog context (the cross-vendor compare shape);
 *    - `connectionVariableNames` + `opStepConnectionSlots` — the shared slot
 *      vocabulary/derivation the validator, install plan, and dispatch use.
 */
import { describe, expect, it } from 'vitest';
import {
  CanonicalOpResolutionError,
  connectionVariableNames,
  opStepConnectionSlots,
  resolveConnectionAgnosticRecipe,
} from '@recued/recipes';
import type {
  CanonicalOpStep,
  EntityFieldRow,
  IngredientStep,
  OperationRow,
  PackResolutionContext,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';

const operationRow = (operation: string, httpVerb: 'get' | 'post' = 'post'): OperationRow => {
  const family = operation.slice(0, operation.indexOf('.'));
  return {
    family,
    operation,
    verb: httpVerb,
    surface: 'api',
    binding: {
      kind: 'rest',
      method: httpVerb === 'get' ? 'GET' : 'POST',
      path_template: `/mock/${operation}`,
    },
    risk_tier: 'read',
    approval: 'never',
    groups: [`${family}.read`],
    reviewed: true,
  };
};

const entityField = (
  row: Pick<EntityFieldRow, 'entity' | 'field_path' | 'maps_to'> & Partial<EntityFieldRow>,
): EntityFieldRow => ({
  type: 'string',
  reviewed: true,
  ...row,
});

const hubspotCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/hubspot',
  vendor: 'hubspot',
  connection: 'hubspot1',
  catalog_slug: 'hubspot-full',
  result_path: 'results',
  search_style: 'hubspot_search',
  operation_families: [operationRow('deal.search')],
  entity_fields: [
    entityField({ entity: 'Deal', field_path: 'properties.dealname', maps_to: 'name' }),
    entityField({ entity: 'Deal', field_path: 'properties.amount', maps_to: 'amount', type: 'number' }),
  ],
  ...overrides,
});

const salesforceCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/salesforce',
  vendor: 'salesforce',
  connection: 'salesforce1',
  catalog_slug: 'salesforce-full',
  result_path: 'records',
  search_style: 'soql',
  operation_families: [operationRow('opportunity.search', 'get')],
  entity_fields: [
    entityField({ entity: 'Opportunity', field_path: 'Name', maps_to: 'name' }),
    entityField({ entity: 'Opportunity', field_path: 'Amount', maps_to: 'amount', type: 'number' }),
  ],
  ...overrides,
});

/** A connection-picker variable def (the ValueHint object form). */
const connectionVariable = (): RecipeDefinition['variables'][string] => {
  const def = { label: 'CRM connection', type: 'connection', connection_kind: 'api', default: '' };
  return def as unknown as RecipeDefinition['variables'][string];
};

const testRecipe = (
  steps: RecipeStep[],
  variables: RecipeDefinition['variables'] = {},
): RecipeDefinition => ({
  recipe_id: 'per-operand-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Per-operand test',
    description: 'Test recipe',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables,
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const opStep = (overrides: Partial<CanonicalOpStep> = {}): CanonicalOpStep => ({
  id: 'deals',
  op: 'deal.search',
  args: { limit: 200 },
  ...overrides,
});

const fetchStep = (recipe: RecipeDefinition, id: string): IngredientStep =>
  recipe.steps.find((s) => s.id === id) as IngredientStep;

const expectThrows = (fn: () => unknown, messageSubstring: string): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(CanonicalOpResolutionError);
  expect((thrown as Error).message).toContain(messageSubstring);
};

describe('per-step connection slot override (resolver)', () => {
  it('an explicit slot wins over the ctx default; a slot-less step keeps the ctx default', () => {
    const recipe = testRecipe(
      [
        opStep({ id: 'a_deals', connection: '{{config.crm_a}}' }),
        opStep({ id: 'b_deals' }),
      ],
      { crm_a: connectionVariable() },
    );
    const { recipe: resolved, bindings } = resolveConnectionAgnosticRecipe(recipe, hubspotCtx());
    expect(fetchStep(resolved, 'a_deals__raw').connection).toBe('{{config.crm_a}}');
    expect(fetchStep(resolved, 'b_deals__raw').connection).toBe('hubspot1');
    expect(bindings.map((b) => b.connection)).toEqual(['{{config.crm_a}}', 'hubspot1']);
  });

  it('two explicit slots bind independently and are recorded per binding', () => {
    const recipe = testRecipe(
      [
        opStep({ id: 'a_deals', connection: '{{config.crm_a}}' }),
        opStep({ id: 'b_deals', connection: '{{config.crm_b}}' }),
      ],
      { crm_a: connectionVariable(), crm_b: connectionVariable() },
    );
    const { recipe: resolved } = resolveConnectionAgnosticRecipe(recipe, hubspotCtx());
    expect(fetchStep(resolved, 'a_deals__raw').connection).toBe('{{config.crm_a}}');
    expect(fetchStep(resolved, 'b_deals__raw').connection).toBe('{{config.crm_b}}');
  });

  it('a delete op-step carries its slot on the single fetch step', () => {
    const recipe = testRecipe(
      [opStep({ id: 'drop', op: 'deal.delete', args: { id: 'D1' }, connection: '{{config.crm_b}}' })],
      { crm_b: connectionVariable() },
    );
    const ctx = hubspotCtx({
      operation_families: [operationRow('deal.delete')],
      write_style: 'hubspot_properties',
    });
    const { recipe: resolved } = resolveConnectionAgnosticRecipe(recipe, ctx);
    expect(fetchStep(resolved, 'drop').connection).toBe('{{config.crm_b}}');
  });

  it.each([
    ['a literal connection name', 'hubspot1'],
    ['another namespace ref', '{{step.target}}'],
    ['an interpolated string', 'crm {{config.crm_a}}'],
    ['a dotted config path', '{{config.crm.name}}'],
    ['a vault ref', '{{vault.crm_a}}'],
  ])('fails closed on %s as a slot', (_label, slot) => {
    const recipe = testRecipe(
      [opStep({ connection: slot })],
      { crm_a: connectionVariable() },
    );
    expectThrows(
      () => resolveConnectionAgnosticRecipe(recipe, hubspotCtx()),
      'invalid connection slot',
    );
  });

  it('fails closed when the slot names an UNDECLARED variable (resolver-layer check)', () => {
    const recipe = testRecipe([opStep({ connection: '{{config.ghost}}' })], {
      crm_a: connectionVariable(),
    });
    expectThrows(
      () => resolveConnectionAgnosticRecipe(recipe, hubspotCtx()),
      "names variable 'ghost', which is not declared as a type:'connection' variable",
    );
  });

  it('fails closed when the slot names a variable that is not type:connection', () => {
    const recipe = testRecipe([opStep({ connection: '{{config.top_n}}' })], {
      top_n: { label: 'How many', type: 'number', default: 10 } as unknown as
        RecipeDefinition['variables'][string],
    });
    expectThrows(
      () => resolveConnectionAgnosticRecipe(recipe, hubspotCtx()),
      "not declared as a type:'connection' variable",
    );
  });

  it('fails closed when a slot-less op-step has no ctx default', () => {
    const recipe = testRecipe([opStep()]);
    const ctx = hubspotCtx();
    delete (ctx as { connection?: string }).connection;
    expectThrows(
      () => resolveConnectionAgnosticRecipe(recipe, ctx),
      'has no connection to bind',
    );
  });
});

describe('per-step ctx selector (cross-vendor resolve)', () => {
  it('resolves each op-step against its own vendor context — the compare shape', () => {
    const recipe = testRecipe(
      [
        opStep({ id: 'hs_deals', connection: '{{config.crm_a}}' }),
        opStep({ id: 'sf_deals', connection: '{{config.crm_b}}' }),
      ],
      { crm_a: connectionVariable(), crm_b: connectionVariable() },
    );
    const { recipe: resolved, bindings } = resolveConnectionAgnosticRecipe(
      recipe,
      (step) => (step.id === 'hs_deals' ? hubspotCtx() : salesforceCtx()),
    );

    const hs = fetchStep(resolved, 'hs_deals__raw');
    const sf = fetchStep(resolved, 'sf_deals__raw');
    expect(hs.ingredient).toBe('hubspot-full');
    expect(hs.connection).toBe('{{config.crm_a}}');
    expect((hs.input as { operation: string }).operation).toBe('deal.search');
    expect(sf.ingredient).toBe('salesforce-full');
    expect(sf.connection).toBe('{{config.crm_b}}');
    expect((sf.input as { operation: string }).operation).toBe('opportunity.search');

    // Each projection reads ITS vendor's field paths into the SAME canonical names.
    const hsProjection = resolved.steps.find((s) => s.id === 'hs_deals') as Record<string, unknown>;
    const sfProjection = resolved.steps.find((s) => s.id === 'sf_deals') as Record<string, unknown>;
    expect((hsProjection.expression as Record<string, unknown>).name).toBe('{{item.properties.dealname}}');
    expect((sfProjection.expression as Record<string, unknown>).name).toBe('{{item.Name}}');
    expect((hsProjection.array as string)).toBe('{{step.hs_deals__raw.result.results}}');
    expect((sfProjection.array as string)).toBe('{{step.sf_deals__raw.result.records}}');

    expect(bindings.map((b) => [b.vendor, b.connection])).toEqual([
      ['hubspot', '{{config.crm_a}}'],
      ['salesforce', '{{config.crm_b}}'],
    ]);
  });

  it('a plain ctx object still resolves every op-step against the one context', () => {
    const recipe = testRecipe([opStep({ id: 'a' }), opStep({ id: 'b' })]);
    const { bindings } = resolveConnectionAgnosticRecipe(recipe, hubspotCtx());
    expect(bindings.map((b) => b.catalog_slug)).toEqual(['hubspot-full', 'hubspot-full']);
  });
});

describe('connectionVariableNames', () => {
  it('collects only object-form variables with type connection, in declaration order', () => {
    expect(
      connectionVariableNames({
        variables: {
          crm_b: connectionVariable(),
          top_n: { label: 'n', type: 'number', default: 10 } as unknown as
            RecipeDefinition['variables'][string],
          crm_a: connectionVariable(),
        },
      }),
    ).toEqual(['crm_b', 'crm_a']);
  });

  it('tolerates bare-literal and null variable defaults (a null default means required-from-caller)', () => {
    expect(
      connectionVariableNames({
        variables: {
          plain: 'x',
          n: 5,
          flag: true,
          list: ['a'],
          required: null,
        } as unknown as RecipeDefinition['variables'],
      }),
    ).toEqual([]);
  });

  it('returns [] when variables is absent', () => {
    expect(connectionVariableNames({})).toEqual([]);
  });
});

describe('opStepConnectionSlots (dispatch slot derivation)', () => {
  it('maps explicit slots and the single-variable default; distinct variables dedupe in order', () => {
    const recipe = testRecipe(
      [
        opStep({ id: 'a', connection: '{{config.crm_a}}' }),
        opStep({ id: 'b', connection: '{{config.crm_b}}' }),
        opStep({ id: 'c', connection: '{{config.crm_a}}' }),
      ],
      { crm_a: connectionVariable(), crm_b: connectionVariable() },
    );
    const slots = opStepConnectionSlots(recipe);
    expect(slots.ok).toBe(true);
    if (!slots.ok) return;
    expect([...slots.slotByStepId.entries()]).toEqual([
      ['a', 'crm_a'],
      ['b', 'crm_b'],
      ['c', 'crm_a'],
    ]);
    expect(slots.variables).toEqual(['crm_a', 'crm_b']);
  });

  it('a slot-less op-step falls back to the recipe single connection variable', () => {
    const recipe = testRecipe([opStep({ id: 'a' })], { crm: connectionVariable() });
    const slots = opStepConnectionSlots(recipe);
    expect(slots.ok).toBe(true);
    if (!slots.ok) return;
    expect(slots.slotByStepId.get('a')).toBe('crm');
    expect(slots.variables).toEqual(['crm']);
  });

  it('fails when a slot-less op-step has zero declared connection variables', () => {
    const slots = opStepConnectionSlots(testRecipe([opStep()]));
    expect(slots.ok).toBe(false);
    if (slots.ok) return;
    expect(slots.reason).toContain("declares no type:'connection' variable");
  });

  it('fails when a slot-less op-step is ambiguous (multiple connection variables)', () => {
    const recipe = testRecipe([opStep({ id: 'a' })], {
      crm_a: connectionVariable(),
      crm_b: connectionVariable(),
    });
    const slots = opStepConnectionSlots(recipe);
    expect(slots.ok).toBe(false);
    if (slots.ok) return;
    expect(slots.reason).toContain("op-step 'a' must name its slot explicitly");
    expect(slots.reason).toContain('crm_a, crm_b');
  });

  it('fails on an invalid slot ref and on an undeclared slot variable', () => {
    const invalid = opStepConnectionSlots(
      testRecipe([opStep({ connection: 'hubspot1' })], { crm: connectionVariable() }),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toContain('invalid connection slot');

    const undeclared = opStepConnectionSlots(
      testRecipe([opStep({ connection: '{{config.ghost}}' })], { crm: connectionVariable() }),
    );
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.reason).toContain("names variable 'ghost'");
    }
  });

  it('fails when the slot names a declared variable that is NOT type:connection', () => {
    const recipe = testRecipe([opStep({ connection: '{{config.top_n}}' })], {
      top_n: { label: 'n', type: 'number', default: 10 } as unknown as
        RecipeDefinition['variables'][string],
    });
    const slots = opStepConnectionSlots(recipe);
    expect(slots.ok).toBe(false);
    if (slots.ok) return;
    expect(slots.reason).toContain("names variable 'top_n'");
    expect(slots.reason).toContain("not declared as a type:'connection' variable");
  });

  it('derives zero slots for a recipe whose op-steps live only in prefetch (rejected elsewhere)', () => {
    const recipe = testRecipe([]);
    (recipe as { prefetch_steps: unknown[] }).prefetch_steps = [
      { id: 'pre', op: 'deal.search' },
    ];
    const slots = opStepConnectionSlots(recipe);
    expect(slots.ok).toBe(true);
    if (!slots.ok) return;
    expect(slots.slotByStepId.size).toBe(0);
    expect(slots.variables).toEqual([]);
  });
});

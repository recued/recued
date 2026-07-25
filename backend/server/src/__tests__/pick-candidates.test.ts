/** Doc section 4 - pick-candidate derivation unit tests. */

import { CATALOG_VENDOR_SLUGS } from '@recued/contracts';
import type {
  ConnectionOperationProfile,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';
import type { PickCandidate } from '@recued/gateway';
import { describe, expect, it, vi } from 'vitest';

import {
  buildPickAskInputForSlot,
  derivePickCandidates,
  type PickCandidateDeps,
} from '../pick-candidates.js';

const HUBSPOT_CATALOG = CATALOG_VENDOR_SLUGS.hubspot;
const SALESFORCE_CATALOG = CATALOG_VENDOR_SLUGS.salesforce;

const connectionVar = () => ({
  label: 'CRM',
  type: 'connection',
  connection_kind: 'api',
  default: '',
});

const opSpec = (operation: string): Record<string, unknown> => ({
  operation_id: `test/${operation}`,
  risk_tier: 'read',
  groups: [],
  required_scopes: [],
});

const manifest = (
  slug: string,
  operations?: readonly string[],
): IngredientManifest => {
  const base = {
    slug,
    name: `${slug} fixture`,
    description: 'pick-candidates unit fixture',
    author: 'test',
    kind: 'connection',
    category: 'data',
    risk_tier: 'read',
    version: 1,
    input: { operation: null, args: null },
    output: { result: 'result' },
  };
  if (operations === undefined) return base as unknown as IngredientManifest;
  return {
    ...base,
    operations: Object.fromEntries(operations.map((operation) => [
      operation,
      opSpec(operation),
    ])),
  } as unknown as IngredientManifest;
};

const recipeForOps = (
  operations: readonly string[],
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition =>
  ({
    recipe_id: 'pick-candidates-unit',
    version: 1,
    ttl: 300,
    metadata: {
      name: 'Pick candidates unit',
      description: 'unit',
      author: 'test',
      supported_platforms: [],
    },
    variables: { crm: connectionVar() },
    prefetch_steps: [],
    steps: operations.map((op, index) => ({
      id: `op_${index}`,
      op,
      args: {},
    })),
    output: { sidebar: [] },
    ...overrides,
  }) as unknown as RecipeDefinition;

const twoSlotRecipe = (): RecipeDefinition =>
  ({
    recipe_id: 'pick-candidates-two-slot',
    version: 1,
    ttl: 300,
    metadata: {
      name: 'Two slot fixture',
      description: 'unit',
      author: 'test',
      supported_platforms: [],
    },
    variables: {
      source_crm: connectionVar(),
      dest_crm: connectionVar(),
    },
    prefetch_steps: [],
    steps: [
      {
        id: 'source_search',
        op: 'deal.search',
        args: {},
        connection: '{{config.source_crm}}',
      },
      {
        id: 'dest_create',
        op: 'deal.create',
        args: {},
        connection: '{{config.dest_crm}}',
      },
    ],
    output: { sidebar: [] },
  }) as unknown as RecipeDefinition;

const profile = (catalog_slug?: string): ConnectionOperationProfile => ({
  allowed_operations: [],
  ...(catalog_slug === undefined ? {} : { catalog_slug }),
});

const depsWith = (
  profiles: ReadonlyArray<readonly [string, ConnectionOperationProfile]>,
  manifests: Readonly<Record<string, IngredientManifest | null | undefined>>,
): PickCandidateDeps & {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} => {
  const list = vi.fn(() => profiles);
  const get = vi.fn((slug: string) => manifests[slug] ?? null);
  return {
    profiles: { list },
    manifests: { get },
    list,
    get,
  };
};

describe('derivePickCandidates', () => {
  it('qualifies a connection only when its stamped catalog serves every slot operation', () => {
    const deps = depsWith(
      [
        ['sf-partial', profile(SALESFORCE_CATALOG)],
        ['hubspot-complete', profile(HUBSPOT_CATALOG)],
      ],
      {
        [SALESFORCE_CATALOG]: manifest(SALESFORCE_CATALOG, ['opportunity.search']),
        [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['deal.search', 'deal.create']),
      },
    );

    const result = derivePickCandidates(
      recipeForOps(['deal.search', 'deal.create']),
      'crm',
      deps,
    );

    expect(result.operations).toEqual(['deal.search', 'deal.create']);
    expect(result.candidates).toEqual([
      {
        connection_name: 'hubspot-complete',
        catalog_slug: HUBSPOT_CATALOG,
        vendor: 'hubspot',
      },
    ]);
  });

  it('lowers a D-182 core.crm.* op before deriving candidates (else alias `core` suppresses all)', () => {
    // Without the Increment-2b lowering, `core.crm.deal.search` parses to alias
    // `core` (not a crm_alias) → zero candidates. Lowering strips the head to
    // `deal.search` so the slot-op parse + catalog op-set check match the vendor.
    const deps = depsWith(
      [['hubspot1', profile(HUBSPOT_CATALOG)]],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['deal.search']) },
    );
    const result = derivePickCandidates(recipeForOps(['core.crm.deal.search']), 'crm', deps);
    expect(result.operations).toEqual(['deal.search']);
    expect(result.candidates).toEqual([
      { connection_name: 'hubspot1', catalog_slug: HUBSPOT_CATALOG, vendor: 'hubspot' },
    ]);
  });

  it('yields no candidates for a Tier-P pack op (lowering throws under the empty map)', () => {
    const deps = depsWith(
      [['hubspot1', profile(HUBSPOT_CATALOG)]],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['deal.search']) },
    );
    const result = derivePickCandidates(recipeForOps(['recued-core.whisper.audio.transcribe']), 'crm', deps);
    expect(result).toEqual({ candidates: [], operations: [] });
  });

  it('skips profiles without usable first-party registered catalog manifests', () => {
    const deps = depsWith(
      [
        ['no-catalog', profile()],
        ['third-party', profile('third-party-catalog')],
        ['missing-manifest', profile(SALESFORCE_CATALOG)],
        ['no-operations', profile(HUBSPOT_CATALOG)],
      ],
      {
        'third-party-catalog': manifest('third-party-catalog', ['deal.search']),
        [SALESFORCE_CATALOG]: null,
        [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG),
      },
    );

    const result = derivePickCandidates(recipeForOps(['deal.search']), 'crm', deps);

    expect(result).toEqual({ candidates: [], operations: ['deal.search'] });
    expect(deps.get).toHaveBeenCalledTimes(2);
    expect(deps.get).toHaveBeenNthCalledWith(1, SALESFORCE_CATALOG);
    expect(deps.get).toHaveBeenNthCalledWith(2, HUBSPOT_CATALOG);
  });

  it('returns no candidates for an unknown crm_alias but preserves the derived operation list', () => {
    const deps = depsWith(
      [['hubspot1', profile(HUBSPOT_CATALOG)]],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['ticket.search']) },
    );

    const result = derivePickCandidates(recipeForOps(['ticket.search']), 'crm', deps);

    expect(result).toEqual({ candidates: [], operations: ['ticket.search'] });
    expect(deps.list).not.toHaveBeenCalled();
  });

  it('returns no candidates for a malformed operation without a dot', () => {
    const deps = depsWith(
      [['hubspot1', profile(HUBSPOT_CATALOG)]],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['deal']) },
    );

    expect(derivePickCandidates(recipeForOps(['deal']), 'crm', deps)).toEqual({
      candidates: [],
      operations: ['deal'],
    });
    expect(deps.list).not.toHaveBeenCalled();
  });

  it('sorts candidate results by connection_name', () => {
    const deps = depsWith(
      [
        ['z-hubspot', profile(HUBSPOT_CATALOG)],
        ['a-hubspot', profile(HUBSPOT_CATALOG)],
      ],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['deal.search']) },
    );

    const result = derivePickCandidates(recipeForOps(['deal.search']), 'crm', deps);

    expect(result.candidates.map((candidate) => candidate.connection_name)).toEqual([
      'a-hubspot',
      'z-hubspot',
    ]);
  });

  it('maps the canonical account alias to HubSpot company operations', () => {
    const accountOnly = depsWith(
      [['hubspot1', profile(HUBSPOT_CATALOG)]],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['account.search']) },
    );
    expect(
      derivePickCandidates(recipeForOps(['account.search']), 'crm', accountOnly),
    ).toEqual({ candidates: [], operations: ['account.search'] });

    const companyMapped = depsWith(
      [['hubspot1', profile(HUBSPOT_CATALOG)]],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['company.search']) },
    );
    expect(
      derivePickCandidates(recipeForOps(['account.search']), 'crm', companyMapped),
    ).toEqual({
      operations: ['account.search'],
      candidates: [
        {
          connection_name: 'hubspot1',
          catalog_slug: HUBSPOT_CATALOG,
          vendor: 'hubspot',
        },
      ],
    });
  });

  it('derives operations per explicit connection slot without leaking the other slot', () => {
    const deps = depsWith(
      [['hubspot1', profile(HUBSPOT_CATALOG)]],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['deal.search']) },
    );
    const recipe = twoSlotRecipe();

    expect(derivePickCandidates(recipe, 'source_crm', deps)).toEqual({
      operations: ['deal.search'],
      candidates: [
        {
          connection_name: 'hubspot1',
          catalog_slug: HUBSPOT_CATALOG,
          vendor: 'hubspot',
        },
      ],
    });
    expect(derivePickCandidates(recipe, 'dest_crm', deps)).toEqual({
      operations: ['deal.create'],
      candidates: [],
    });
  });

  it('returns empty candidates and empty operations when the slot walk fails', () => {
    const recipe = recipeForOps(['deal.search'], {
      steps: [
        {
          id: 'bad_slot',
          op: 'deal.search',
          args: {},
          connection: '{{config.ghost}}',
        },
      ],
    } as unknown as Partial<RecipeDefinition>);
    const deps = depsWith(
      [['hubspot1', profile(HUBSPOT_CATALOG)]],
      { [HUBSPOT_CATALOG]: manifest(HUBSPOT_CATALOG, ['deal.search']) },
    );

    expect(derivePickCandidates(recipe, 'crm', deps)).toEqual({
      candidates: [],
      operations: [],
    });
  });
});

describe('buildPickAskInputForSlot', () => {
  it('preserves the recipe identity mode, mints unique pick ids, and snapshots operation and candidate arrays', () => {
    const recipe = recipeForOps(['deal.search']);
    const operations = ['deal.search'];
    const candidates: PickCandidate[] = [
      {
        connection_name: 'hubspot1',
        catalog_slug: HUBSPOT_CATALOG,
        vendor: 'hubspot',
      },
    ];

    const byId = buildPickAskInputForSlot({
      recipe,
      byId: true,
      variable: 'crm',
      config: { limit: 10 },
      candidates,
      operations,
    });
    const inline = buildPickAskInputForSlot({
      recipe,
      byId: false,
      variable: 'crm',
      config: { limit: 10 },
      candidates,
      operations,
    });

    expect(byId.recipe_id).toBe('pick-candidates-unit');
    expect(byId).not.toHaveProperty('recipe');
    // The display label reads `metadata.name` (the shipped-recipe shape),
    // falling back to recipe_id when absent.
    expect(byId.recipe_label).toBe('Pick candidates unit');
    expect(inline.recipe).toBe(recipe);
    expect(inline).not.toHaveProperty('recipe_id');
    expect(byId.pick_id).not.toBe(inline.pick_id);

    operations.push('deal.create');
    candidates.push({
      connection_name: 'salesforce1',
      catalog_slug: SALESFORCE_CATALOG,
      vendor: 'salesforce',
    });

    expect(byId.operations).toEqual(['deal.search']);
    expect(inline.operations).toEqual(['deal.search']);
    expect(byId.candidates).toEqual([
      {
        connection_name: 'hubspot1',
        catalog_slug: HUBSPOT_CATALOG,
        vendor: 'hubspot',
      },
    ]);
    expect(inline.candidates).toEqual([
      {
        connection_name: 'hubspot1',
        catalog_slug: HUBSPOT_CATALOG,
        vendor: 'hubspot',
      },
    ]);
  });
});

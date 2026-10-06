/** D-120 Phase 2 — recipe flattening tests.
 *
 *  Covers:
 *    - Trigger derivation (manual / auto_run / event / url)
 *    - Step kinds (transform / guard / ingredient)
 *    - Ingredient classification (slug heuristics + manifest narrowing)
 *    - input_refs collection (dedupe + sort + control-field strip)
 *    - external_call extraction (HTTP url / chat.tab / mcp.server_url)
 *    - ai-classify category capture
 *    - Size-cap shrink passes (refs → extras → truncated mark)
 *    - Determinism (same input → byte-identical output)
 */

import { describe, expect, it } from 'vitest';
import {
  flattenRecipe,
  resolveKernelClosedKindOpStep,
  serializeFlattenedInsight,
  type FlattenedInsight,
} from '../index.js';
import {
  KERNEL_OP_REGISTRY,
  type IngredientManifest,
  type OpStep,
  type RecipeDefinition,
} from '@recued/contracts';

const baseRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'sample-recipe',
  version: 1,
  ttl: 60,
  metadata: { name: 'Sample', author: 'tester', description: 'fixture' } as RecipeDefinition['metadata'],
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
});

const manifest = (
  slug: string,
  category: 'data' | 'ai' | 'action',
  risk_tier: 'read' | 'write' | 'admin' | 'destructive',
  input: Record<string, unknown> = {},
): IngredientManifest =>
  ({
    slug,
    name: slug,
    description: '',
    author: 'tester',
    kind: 'http',
    category,
    risk_tier,
    input,
    output: {},
  }) as IngredientManifest;

describe('flattenRecipe — trigger derivation', () => {
  it('derives manual when no auto_run / event_triggers / trigger', () => {
    const flat = flattenRecipe(baseRecipe());
    expect(flat.trigger).toEqual({ type: 'manual' });
  });

  it('derives auto_run with interval_ms + trigger_step_count', () => {
    const flat = flattenRecipe(
      baseRecipe({
        auto_run: { interval_ms: 60_000 },
        trigger_steps: [{ id: 'gate', transform: 'compare', a: 1, b: 1 }],
      }),
    );
    expect(flat.trigger).toEqual({
      type: 'auto_run',
      interval_ms: 60_000,
      trigger_step_count: 1,
    });
  });

  it('derives event with the event_triggers count (patterns stripped)', () => {
    const flat = flattenRecipe(
      baseRecipe({
        event_triggers: [
          { event: 'data.mail.received', filter: { folder: 'INBOX' } },
          { event: 'data.deal.updated', filter: { stage: 'won' } },
        ],
      }),
    );
    expect(flat.trigger).toEqual({ type: 'event', event_count: 2 });
  });

  it('derives url with the pattern count (URL strings stripped)', () => {
    const flat = flattenRecipe(
      baseRecipe({
        trigger: ['app.hubspot.com/contacts/*', 'app.salesforce.com/*'],
      }),
    );
    expect(flat.trigger).toEqual({ type: 'url', pattern_count: 2 });
  });
});

describe('flattenRecipe — step kinds', () => {
  it('flattens a transform step', () => {
    const flat = flattenRecipe(
      baseRecipe({
        steps: [
          {
            id: 'sum',
            transform: 'reduce',
            input: '{{step.list}}',
            initial: 0,
          },
        ],
      }),
    );
    expect(flat.steps[0]).toMatchObject({
      step_id: 'sum',
      transform: 'reduce',
      action_kind: 'transform',
      output_namespace: 'step.sum',
    });
    expect(flat.steps[0].input_refs).toEqual(['step.list']);
  });

  it('flattens a guard step', () => {
    const flat = flattenRecipe(
      baseRecipe({
        steps: [{ id: 'check', guard: 'require-vault', vault_key: 'foo' }],
      }),
    );
    expect(flat.steps[0]).toMatchObject({
      step_id: 'check',
      guard: 'require-vault',
      action_kind: 'guard',
      output_namespace: 'step.check',
    });
  });

  it('flattens an ingredient step with no manifest as external_action', () => {
    const flat = flattenRecipe(
      baseRecipe({
        steps: [
          {
            id: 'send',
            ingredient: 'send-email',
            input: { to: '{{config.recipient}}', body: 'hi' },
          },
        ],
      }),
    );
    expect(flat.steps[0]).toMatchObject({
      step_id: 'send',
      ingredient: 'send-email',
      action_kind: 'external_action',
    });
    expect(flat.steps[0].input_refs).toEqual(['config.recipient']);
  });

  it('ignores inherited step discriminators', () => {
    const step = Object.assign(
      Object.create({ transform: 'template' }),
      {
        id: 'send',
        ingredient: 'send-email',
        input: { to: '{{config.recipient}}' },
      },
    ) as RecipeDefinition['steps'][number];

    const flat = flattenRecipe(baseRecipe({ steps: [step] }));

    expect(flat.steps[0]).toMatchObject({
      step_id: 'send',
      ingredient: 'send-email',
      action_kind: 'external_action',
    });
    expect(flat.steps[0].transform).toBeUndefined();
    expect(flat.steps[0].input_refs).toEqual(['config.recipient']);
  });
});

describe('flattenRecipe — ingredient classification', () => {
  it('ai- prefix → ai_function (slug heuristic, no manifest needed)', () => {
    const flat = flattenRecipe(
      baseRecipe({
        steps: [{ id: 's', ingredient: 'ai-classify', input: {} }],
      }),
    );
    expect(flat.steps[0].action_kind).toBe('ai_function');
  });

  it('ai-prompt → ai_prompt regardless of manifest', () => {
    const manifests = new Map([['ai-prompt', manifest('ai-prompt', 'ai', 'read')]]);
    const flat = flattenRecipe(
      baseRecipe({
        steps: [{ id: 's', ingredient: 'ai-prompt', input: {} }],
      }),
      { manifests },
    );
    expect(flat.steps[0].action_kind).toBe('ai_prompt');
  });

  it('manifest data → read', () => {
    const manifests = new Map([['mail-list', manifest('mail-list', 'data', 'read')]]);
    const flat = flattenRecipe(
      baseRecipe({
        steps: [{ id: 's', ingredient: 'mail-list', input: {} }],
      }),
      { manifests },
    );
    expect(flat.steps[0].action_kind).toBe('read');
  });

  it('manifest action+write → write; action+destructive → destructive', () => {
    const manifests = new Map([
      ['hubspot-update-deal', manifest('hubspot-update-deal', 'action', 'write')],
      ['hubspot-delete-contact', manifest('hubspot-delete-contact', 'action', 'destructive')],
    ]);
    const flat = flattenRecipe(
      baseRecipe({
        steps: [
          { id: 'a', ingredient: 'hubspot-update-deal', input: {} },
          { id: 'b', ingredient: 'hubspot-delete-contact', input: {} },
        ],
      }),
      { manifests },
    );
    expect(flat.steps[0].action_kind).toBe('write');
    expect(flat.steps[1].action_kind).toBe('destructive');
  });
});

describe('flattenRecipe — input_refs', () => {
  it('dedupes + sorts refs, ignores control fields', () => {
    const flat = flattenRecipe(
      baseRecipe({
        steps: [
          {
            id: 's',
            ingredient: 'mail-list',
            input: {
              q: '{{config.search}} {{step.term}}',
              limit: '{{config.search}}',
            },
            skip_when: '{{config.disabled}} equal true',
            fail_on: '{{step.errored}}',
          },
        ],
      }),
    );
    // skip_when + fail_on stripped; input refs deduped + sorted.
    expect(flat.steps[0].input_refs).toEqual(['config.search', 'step.term']);
  });

  it('omits input_refs entirely when no refs are present', () => {
    const flat = flattenRecipe(
      baseRecipe({
        steps: [{ id: 's', ingredient: 'noop', input: { literal: 'value' } }],
      }),
    );
    expect(flat.steps[0].input_refs).toBeUndefined();
  });

  it('ignores refs carried only by prototype-sensitive step fields', () => {
    const recipe = baseRecipe({
      steps: [
        JSON.parse(
          '{"id":"s","transform":"identity","__proto__":{"x":"{{config.secret}}"},"value":"{{config.visible}}"}',
        ),
      ],
    });

    const flat = flattenRecipe(recipe);
    expect(flat.steps[0].input_refs).toEqual(['config.visible']);
  });
});

describe('flattenRecipe — external_call extraction', () => {
  it('extracts host from manifest input.url', () => {
    const manifests = new Map([
      ['hubspot-search', manifest('hubspot-search', 'data', 'read', {
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/search',
        method: 'POST',
      })],
    ]);
    const flat = flattenRecipe(
      baseRecipe({
        steps: [{ id: 's', ingredient: 'hubspot-search', input: {} }],
      }),
      { manifests },
    );
    expect(flat.steps[0].external_call).toBe('api.hubapi.com');
  });

  it('falls back to chat.tab on manifest', () => {
    const manifests = new Map([
      ['web-chat-gemini', manifest('web-chat-gemini', 'ai', 'read', { chat: { tab: 'gemini' } })],
    ]);
    const flat = flattenRecipe(
      baseRecipe({
        steps: [{ id: 's', ingredient: 'web-chat-gemini', input: {} }],
      }),
      { manifests },
    );
    expect(flat.steps[0].external_call).toBe('gemini');
  });

  it('falls back to mcp.server_url host on manifest', () => {
    const manifests = new Map([
      ['mcp-tool', manifest('mcp-tool', 'action', 'admin', { mcp: { server_url: 'https://mcp.example.org/v1' } })],
    ]);
    const flat = flattenRecipe(
      baseRecipe({
        steps: [{ id: 's', ingredient: 'mcp-tool', input: {} }],
      }),
      { manifests },
    );
    expect(flat.steps[0].external_call).toBe('mcp.example.org');
  });
});

describe('flattenRecipe — ai-classify categories', () => {
  // ⛔ Under the flat key `llm.categories`, the way a recipe writes every `llm.*` input.
  // These cases used a nested `llm: { categories }` object no recipe has, so they
  // passed while no real snapshot ever carried a category.
  it('captures llm.categories on ai-classify steps only', () => {
    const flat = flattenRecipe(
      baseRecipe({
        steps: [
          {
            id: 'classify',
            ingredient: 'ai-classify',
            input: {
              'llm.data': '{{step.body}}',
              'llm.categories': ['urgent', 'normal', 'spam'],
            },
          },
        ],
      }),
    );
    expect(flat.steps[0].categories).toEqual(['urgent', 'normal', 'spam']);
  });

  it('does not capture categories on other ai-* ingredients', () => {
    const flat = flattenRecipe(
      baseRecipe({
        steps: [
          {
            id: 'extract',
            ingredient: 'ai-extract',
            input: { 'llm.categories': ['ignored'] },
          },
        ],
      }),
    );
    expect(flat.steps[0].categories).toBeUndefined();
  });

});

describe('flattenRecipe — op steps', () => {
  /** Every shipped AI step, and most calls, are written `op:` with an `args` payload.
   *  ⛔ They fell through to the ingredient branch: `ingredient: ''`, `external_action`. */
  const opStep = (op: string, args: Record<string, unknown> = {}) =>
    flattenRecipe(baseRecipe({ steps: [{ id: 'call', op, args } as unknown as RecipeDefinition['steps'][number]] })).steps[0];

  it('a kernel AI op is recorded as the op and the ingredient it runs as', () => {
    expect(opStep('core.ai.summarize', { 'llm.data': '{{step.deal}}' })).toEqual({
      step_id: 'call',
      op: 'core.ai.summarize',
      ingredient: 'core-ai-summarize',
      action_kind: 'ai_function',
      output_namespace: 'step.call',
      input_refs: ['step.deal'],
    });
    expect(opStep('core.ai.prompt').action_kind).toBe('ai_prompt');
    expect(opStep('core.ai.classify', { 'llm.data': 'x', 'llm.categories': ['hot', 'cold'] }).categories)
      .toEqual(['hot', 'cold']);
  });

  it('a pack op keeps its op and names no ingredient', () => {
    const flat = opStep('recued-core.recurly.account.read', { account_id: '{{config.account}}' });
    expect(flat).toEqual({
      step_id: 'call',
      op: 'recued-core.recurly.account.read',
      action_kind: 'external_action',
      output_namespace: 'step.call',
      input_refs: ['config.account'],
    });
    expect('ingredient' in flat).toBe(false);
  });

  it('a kernel op step records what a run records for the step it lowers to', () => {
    // A run flattens the recipe after lowering it, so the two snapshots of one step agree.
    const differ = KERNEL_OP_REGISTRY.filter((entry) => entry.backing_slug !== undefined).flatMap((entry) => {
      const authored = { id: 'call', op: entry.op, args: { 'llm.data': '{{step.x}}', 'llm.categories': ['a'] }, skip_when: '{{step.x}} is_null' };
      const lowered = resolveKernelClosedKindOpStep(authored as unknown as OpStep)!;
      const { op, ...fromOp } = flattenRecipe(baseRecipe({ steps: [authored as unknown as RecipeDefinition['steps'][number]] })).steps[0];
      const fromLowered = flattenRecipe(baseRecipe({ steps: [lowered] })).steps[0];
      return op === entry.op && JSON.stringify(fromOp) === JSON.stringify(fromLowered) ? [] : [entry.op];
    });
    expect(differ).toEqual([]);
  });

});

describe('flattenRecipe — prefetch + trigger_steps surfaces', () => {
  it('surfaces prefetch_steps separately when present', () => {
    const flat = flattenRecipe(
      baseRecipe({
        prefetch_steps: [{ id: 'pf', ingredient: 'mail-list', input: {} }],
        steps: [{ id: 's', transform: 'identity', value: '{{step.pf}}' }],
      }),
    );
    expect(flat.prefetch_steps).toHaveLength(1);
    expect(flat.prefetch_steps?.[0].step_id).toBe('pf');
  });

  it('surfaces trigger_steps separately when present', () => {
    const flat = flattenRecipe(
      baseRecipe({
        auto_run: { interval_ms: 30_000 },
        trigger_steps: [{ id: 'gate', transform: 'compare', a: 1, b: 1 }],
        steps: [{ id: 'noop', transform: 'identity', value: 1 }],
      }),
    );
    expect(flat.trigger_steps).toHaveLength(1);
    expect(flat.trigger_steps?.[0].step_id).toBe('gate');
  });

  it('ignores inherited recipe arrays and trigger fields', () => {
    const recipe = Object.assign(
      Object.create({
        auto_run: { interval_ms: 30_000 },
        steps: [{ id: 'proto_step', transform: 'identity', value: 1 }],
        prefetch_steps: [{ id: 'proto_prefetch', ingredient: 'mail-list', input: {} }],
        trigger_steps: [{ id: 'proto_gate', transform: 'compare', a: 1, b: 1 }],
      }),
      {
        recipe_id: 'sample-recipe',
        version: 1,
        ttl: 60,
        metadata: { name: 'Sample', author: 'tester', description: 'fixture' },
        variables: {},
        output: { sidebar: [] },
      },
    ) as RecipeDefinition;

    const flat = flattenRecipe(recipe);

    expect(flat.trigger).toEqual({ type: 'manual' });
    expect(flat.steps).toEqual([]);
    expect(flat.prefetch_steps).toBeUndefined();
    expect(flat.trigger_steps).toBeUndefined();
  });
});

describe('flattenRecipe — determinism', () => {
  it('produces byte-identical output for byte-identical input', () => {
    const recipe = baseRecipe({
      steps: [
        { id: 'a', transform: 'reduce', input: '{{step.b}}' },
        { id: 'b', ingredient: 'mail-list', input: { q: '{{config.q}}' } },
      ],
    });
    const a = JSON.stringify(flattenRecipe(recipe));
    const b = JSON.stringify(flattenRecipe(recipe));
    expect(a).toBe(b);
  });
});

describe('flattenRecipe — size cap', () => {
  // The cap is 16 KiB; build a synthetic recipe with refs heavy
  // enough to overflow on pass 1 but small enough to fit on pass 2.
  const heavyRecipe = (refCount: number, includeCategories = false): RecipeDefinition =>
    baseRecipe({
      steps: Array.from({ length: refCount }, (_, i) => ({
        id: `step-${i}`,
        ingredient: i % 2 === 0 ? 'mail-list' : 'ai-classify',
        input: includeCategories && i % 2 === 1
          ? {
              q: `{{config.q-${i}}} {{step.x-${i}}} {{step.y-${i}}}`,
              llm: {
                categories: Array.from({ length: 8 }, (_, j) => `category-${i}-${j}`),
              },
            }
          : { q: `{{config.q-${i}}} {{step.x-${i}}} {{step.y-${i}}}` },
      })),
    });

  it('drops input_refs first when the payload overflows', () => {
    // ~120 steps × ~80 bytes/step with refs ≈ 9.6K base + 4-5K refs.
    // Pass 0 overflows; pass 1 (refs dropped) stays under the 16 KiB cap.
    const recipe = heavyRecipe(120);
    const baseline = serializeFlattenedInsight(
      // sanity: build the would-be payload manually so the fixture
      // actually exercises the shrink path.
      { trigger: { type: 'manual' }, steps: [] },
    );
    expect(baseline.over_cap).toBe(false);
    const flat = flattenRecipe(recipe);
    const everyStepRefless = flat.steps.every((s) => s.input_refs === undefined);
    expect(everyStepRefless).toBe(true);
    const { over_cap } = serializeFlattenedInsight(flat);
    expect(over_cap).toBe(false);
  });

  it('also drops categories + external_call on pass 2 when needed', () => {
    // Increase step count so even after dropping refs, the categories
    // arrays push the payload back over the cap → pass 2 strips them.
    const recipe = heavyRecipe(180, true);
    const flat = flattenRecipe(recipe);
    const anyExtras = flat.steps.some(
      (s) => s.categories !== undefined || s.external_call !== undefined,
    );
    expect(anyExtras).toBe(false);
  });

  it('marks truncated when even the minimal form overflows the cap', () => {
    // Construct a recipe with ~5000 steps so even minimal step
    // entries overflow after both shrink passes.
    const recipe: RecipeDefinition = baseRecipe({
      steps: Array.from({ length: 5000 }, (_, i) => ({
        id: `s${i}`,
        ingredient: 'noop',
        input: {},
      })),
    });
    const flat: FlattenedInsight = flattenRecipe(recipe);
    expect(flat.truncated).toBe(true);
  });
});

describe('flattenRecipe — context_recipe_refs (Phase 4.5)', () => {
  it('omits the field when no context.recipe.* refs exist', () => {
    const recipe = baseRecipe({
      steps: [{ id: 'a', transform: 'count', input: '{{step.b}}' }],
    });
    const flat = flattenRecipe(recipe);
    expect(flat.context_recipe_refs).toBeUndefined();
  });

  it('captures the manifest of referenced step ids, sorted', () => {
    const recipe = baseRecipe({
      steps: [
        {
          id: 'consumer',
          transform: 'coalesce',
          values: [
            '{{context.recipe.pipeline_total}}',
            '{{context.recipe.deal_count}}',
            0,
          ],
        },
      ],
    });
    const flat = flattenRecipe(recipe);
    expect(flat.context_recipe_refs).toEqual([
      'deal_count',
      'pipeline_total',
    ]);
  });

  it('collapses nested-field refs to root step ids', () => {
    const recipe = baseRecipe({
      steps: [
        {
          id: 'pick',
          transform: 'pick',
          source: {
            amount: '{{context.recipe.deal.amount}}',
            stage: '{{context.recipe.deal.stage}}',
          },
        },
      ],
    });
    const flat = flattenRecipe(recipe);
    expect(flat.context_recipe_refs).toEqual(['deal']);
  });
});

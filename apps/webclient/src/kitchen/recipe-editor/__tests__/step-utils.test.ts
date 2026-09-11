/** Tests for the pure step-editing helpers.
 *
 *  Every function under test is pure — no DOM, no module state, no
 *  async. We test each helper directly against its input/output
 *  contract, with particular attention to the edge cases that broke
 *  in the past (empty-condition semantics, reserved step ids, the
 *  ref-rewriter's non-identifier lookahead, reorder bounds).
 */

import { describe, it, expect } from 'vitest';
import {
  parseStepFieldValue,
  parseOpArgValue,
  applyFieldToStep,
  generateStepId,
  extractRecipeInputParams,
  extractTransformParams,
  createBlankStep,
  createBlankOpStep,
  createBlankPrefetchStep,
  removeStepById,
  reorderSteps,
  renameInRefString,
  renameInBareSource,
  renameStepIdInRecipe,
  formatCondition,
  parseCSV,
  formatCSV,
  validateStepIdRename,
} from '../step-utils.js';
import type { IngredientManifest, RecipeDefinition, RecipeStep, PrefetchStep } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// parseStepFieldValue
// ────────────────────────────────────────────────────────────────

describe('parseStepFieldValue', () => {
  it('returns undefined for empty conditions so the handler can delete the field', () => {
    expect(parseStepFieldValue('', 'string', true)).toBeUndefined();
    expect(parseStepFieldValue('   ', 'string', true)).toBeUndefined();
  });

  it('keeps a whitespace string when the field is NOT a condition', () => {
    expect(parseStepFieldValue('', 'string', false)).toBe('');
  });

  it('coerces numeric input via Number() and falls back to raw when NaN', () => {
    expect(parseStepFieldValue('42', 'number', false)).toBe(42);
    expect(parseStepFieldValue('3.14', 'number', false)).toBe(3.14);
    expect(parseStepFieldValue('abc', 'number', false)).toBe('abc');
  });

  it('parses boolean from checkbox-style "true" / "on" and nothing else', () => {
    expect(parseStepFieldValue('true', 'boolean', false)).toBe(true);
    expect(parseStepFieldValue('on', 'boolean', false)).toBe(true);
    expect(parseStepFieldValue('false', 'boolean', false)).toBe(false);
    expect(parseStepFieldValue('', 'boolean', false)).toBe(false);
  });

  it('passes strings + enums through unchanged', () => {
    expect(parseStepFieldValue('hello', 'string', false)).toBe('hello');
    expect(parseStepFieldValue('option_a', 'enum', false)).toBe('option_a');
    // Unknown types default to string passthrough.
    expect(parseStepFieldValue('x', 'weird-type', false)).toBe('x');
  });
});

// ────────────────────────────────────────────────────────────────
// parseOpArgValue
// ────────────────────────────────────────────────────────────────

describe('parseOpArgValue', () => {
  it('keeps an empty input as an empty string', () => {
    expect(parseOpArgValue('')).toBe('');
    expect(parseOpArgValue('   ')).toBe('');
  });

  it('parses JSON literals to their typed value', () => {
    expect(parseOpArgValue('200')).toBe(200);
    expect(parseOpArgValue('true')).toBe(true);
    expect(parseOpArgValue('false')).toBe(false);
    expect(parseOpArgValue('null')).toBeNull();
    expect(parseOpArgValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseOpArgValue('{"k":1}')).toEqual({ k: 1 });
    // A quoted JSON string parses to the bare string.
    expect(parseOpArgValue('"200"')).toBe('200');
  });

  it('keeps a template ref / bare word as the verbatim string', () => {
    expect(parseOpArgValue('{{config.deal_id}}')).toBe('{{config.deal_id}}');
    expect(parseOpArgValue('{{step.x.value}}')).toBe('{{step.x.value}}');
    expect(parseOpArgValue('closed_won')).toBe('closed_won');
  });
});

// ────────────────────────────────────────────────────────────────
// applyFieldToStep
// ────────────────────────────────────────────────────────────────

describe('applyFieldToStep', () => {
  const steps: RecipeStep[] = [
    { id: 's1', transform: 'filter' } as unknown as RecipeStep,
    { id: 's2', transform: 'sort' } as unknown as RecipeStep,
  ];

  it('updates only the matching step by id', () => {
    const result = applyFieldToStep(steps, 's2', 'param:order', 'desc');
    expect((result[0] as unknown as Record<string, unknown>).order).toBeUndefined();
    expect((result[1] as unknown as Record<string, unknown>).order).toBe('desc');
  });

  it('does not mutate the input array or the target step object', () => {
    const result = applyFieldToStep(steps, 's1', 'param:x', 1);
    expect(result).not.toBe(steps);
    expect(result[0]).not.toBe(steps[0]);
    expect((steps[0] as unknown as Record<string, unknown>).x).toBeUndefined();
  });

  it('strips skip_when when value is undefined', () => {
    const withCond = [{ id: 's1', transform: 'sort', skip_when: '{{x}} is_null' } as unknown as RecipeStep];
    const result = applyFieldToStep(withCond, 's1', 'skip_when', undefined);
    expect((result[0] as unknown as Record<string, unknown>).skip_when).toBeUndefined();
    expect('skip_when' in (result[0] as object)).toBe(false);
  });

  it('sets skip_when when value is defined', () => {
    const result = applyFieldToStep(steps, 's1', 'skip_when', '{{x}} is_null');
    expect((result[0] as unknown as Record<string, unknown>).skip_when).toBe('{{x}} is_null');
  });

  it('merges input:* under the step.input object instead of overwriting it', () => {
    const withInput = [
      { id: 's1', ingredient: 'reader', input: { existing: 'keep' } } as unknown as RecipeStep,
    ];
    const result = applyFieldToStep(withInput, 's1', 'input:new', 'added');
    const input = (result[0] as unknown as { input: Record<string, string> }).input;
    expect(input).toEqual({ existing: 'keep', new: 'added' });
  });

  it('seeds step.input when the param prefix is input:* and no input object exists', () => {
    const result = applyFieldToStep(steps, 's1', 'input:k', 'v');
    expect((result[0] as unknown as { input: Record<string, string> }).input).toEqual({ k: 'v' });
  });

  it('merges arg:* under the op-step.args object instead of overwriting it', () => {
    const withArgs = [
      { id: 'o1', op: 'deal.search', args: { existing: 'keep' } } as unknown as RecipeStep,
    ];
    const result = applyFieldToStep(withArgs, 'o1', 'arg:limit', 200);
    const args = (result[0] as unknown as { args: Record<string, unknown> }).args;
    expect(args).toEqual({ existing: 'keep', limit: 200 });
  });

  it('seeds op-step.args when the arg:* prefix lands and no args object exists', () => {
    const bare = [{ id: 'o1', op: 'deal.search' } as unknown as RecipeStep];
    const result = applyFieldToStep(bare, 'o1', 'arg:query', '{{config.q}}');
    expect((result[0] as unknown as { args: Record<string, unknown> }).args).toEqual({
      query: '{{config.q}}',
    });
  });

  it('ignores unknown field prefixes (no-op)', () => {
    const result = applyFieldToStep(steps, 's1', 'unknown:field', 'v');
    // s1 is still a shallow copy (so !==) but has no `field` property set.
    expect((result[0] as unknown as Record<string, unknown>).field).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// generateStepId
// ────────────────────────────────────────────────────────────────

describe('generateStepId', () => {
  it('returns the sanitised base when it is unused', () => {
    expect(generateStepId([], 'filter_deals')).toBe('filter_deals');
  });

  it('lowercases and replaces non-identifier characters', () => {
    expect(generateStepId([], 'Filter Deals!')).toBe('filter_deals');
  });

  it('appends _N until it finds an unused id', () => {
    expect(generateStepId(['filter', 'filter_1'], 'filter')).toBe('filter_2');
  });

  it('falls back to new_step when base is empty or reserved', () => {
    expect(generateStepId([], '')).toBe('new_step');
    expect(generateStepId([], 'step')).toBe('new_step');
    expect(generateStepId([], 'vault')).toBe('new_step');
  });

  it('does not return a reserved id even via the _N suffix', () => {
    // Forcing the base to hit every reserved id via suffix isn't possible
    // since the reserved set is a fixed list — just sanity-check that
    // the returned id is never in the reserved set.
    const id = generateStepId([], 'item');
    expect(id).not.toBe('item');
    expect(['vault', 'config', 'context', 'meta', 'step', 'item']).not.toContain(id);
  });
});

// ────────────────────────────────────────────────────────────────
// extractRecipeInputParams
// ────────────────────────────────────────────────────────────────

describe('extractRecipeInputParams', () => {
  const mkManifest = (input: Record<string, unknown>): IngredientManifest => ({
    slug: 's', name: 'n', description: 'd', author: 'a', kind: 'http', category: 'data', risk_tier: 'read',
    input, output: { body: 'body' },
  } as IngredientManifest);

  it('returns undefined when manifest.input is missing', () => {
    expect(extractRecipeInputParams(undefined)).toBeUndefined();
  });

  it('filters out http infrastructure keys', () => {
    const manifest = mkManifest({
      method: 'GET',
      url: 'https://api.x/y',
      'header.Authorization': 'Bearer X',
      'query.limit': 10,
      limit: 10,
      filter: null,
    });
    const result = extractRecipeInputParams(manifest);
    expect(result).toEqual({ limit: 10, filter: null });
  });

  it('returns undefined when every key is filtered out', () => {
    const manifest = mkManifest({ method: 'GET', url: 'u' });
    expect(extractRecipeInputParams(manifest)).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// extractTransformParams
// ────────────────────────────────────────────────────────────────

describe('extractTransformParams', () => {
  it('returns an empty object for unknown transforms', () => {
    expect(extractTransformParams('does-not-exist')).toEqual({});
  });

  it('seeds required params with null (non-enum)', () => {
    // 'filter' is a well-known transform with required fields.
    const params = extractTransformParams('filter');
    // We don't assert the exact shape (schema can evolve) but confirm
    // that every produced value is either null or a schema enum default
    // (string). No undefined / NaN values should leak through.
    for (const v of Object.values(params)) {
      if (v !== null) expect(typeof v).toBe('string');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// createBlankStep / createBlankPrefetchStep
// ────────────────────────────────────────────────────────────────

describe('createBlankStep', () => {
  it('seeds transform steps with schema-derived params', () => {
    const step = createBlankStep('transform', 'filter', 'f1') as unknown as Record<string, unknown>;
    expect(step.id).toBe('f1');
    expect(step.transform).toBe('filter');
  });

  it('builds guard steps with an empty guard string', () => {
    const step = createBlankStep('guard', 'n/a', 'g1') as unknown as Record<string, unknown>;
    expect(step).toEqual({ id: 'g1', guard: '' });
  });

  it('builds ingredient steps with manifest-derived input when available', () => {
    const manifest = {
      slug: 'deal-reader',
      name: 'Deal reader',
      description: 'd',
      author: 'a',
      kind: 'http',
      category: 'data',
      risk_tier: 'read',
      input: { method: 'GET', url: 'u', id: null },
      output: { body: 'body' },
    } as IngredientManifest;
    const step = createBlankStep('ingredient', 'deal-reader', 'i1', manifest) as unknown as Record<string, unknown>;
    expect(step.id).toBe('i1');
    expect(step.ingredient).toBe('deal-reader');
    // method + url are filtered out; `id` is user-facing and preserved.
    expect(step.input).toEqual({ id: null });
  });

  it('omits input entirely when the manifest has no user-facing keys', () => {
    const step = createBlankStep('ingredient', 'bare', 'b1') as unknown as Record<string, unknown>;
    expect(step.input).toBeUndefined();
  });
});

describe('createBlankOpStep', () => {
  it('mints an op-step with the given op id and an empty args map', () => {
    expect(createBlankOpStep('core.crm.deal.search', 'search'))
      .toEqual({ id: 'search', op: 'core.crm.deal.search', args: {} });
  });

  it('keeps the op id verbatim (validation is the save seam\'s job)', () => {
    const step = createBlankOpStep('deal.search', 'q') as unknown as Record<string, unknown>;
    expect(step.op).toBe('deal.search');
  });
});

describe('createBlankPrefetchStep', () => {
  it('builds a prefetch step with manifest input when provided', () => {
    const manifest = {
      slug: 's', name: 'n', description: 'd', author: 'a', kind: 'http', category: 'data', risk_tier: 'read',
      input: { entity_id: null }, output: { body: 'body' },
    } as IngredientManifest;
    expect(createBlankPrefetchStep('reader', 'load', manifest))
      .toEqual({ id: 'load', ingredient: 'reader', input: { entity_id: null } });
  });

  it('omits input when no user-facing keys exist', () => {
    expect(createBlankPrefetchStep('bare', 'load'))
      .toEqual({ id: 'load', ingredient: 'bare' });
  });
});

// ────────────────────────────────────────────────────────────────
// removeStepById / reorderSteps
// ────────────────────────────────────────────────────────────────

describe('removeStepById', () => {
  it('filters out the matching id', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(removeStepById(list, 'b')).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('returns the original reference when no id matches (cheap no-op)', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    expect(removeStepById(list, 'missing')).toBe(list);
  });
});

describe('reorderSteps', () => {
  it('moves an item to a later index', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(reorderSteps(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item to an earlier index', () => {
    expect(reorderSteps(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when from === to', () => {
    const list = ['a', 'b'];
    expect(reorderSteps(list, 1, 1)).toBe(list);
  });

  it('is a no-op when either index is out of range', () => {
    const list = ['a', 'b'];
    expect(reorderSteps(list, -1, 0)).toBe(list);
    expect(reorderSteps(list, 0, 5)).toBe(list);
    expect(reorderSteps(list, 5, 0)).toBe(list);
  });
});

// ────────────────────────────────────────────────────────────────
// renameInRefString
// ────────────────────────────────────────────────────────────────

describe('renameInRefString', () => {
  it('rewrites an exact ref', () => {
    expect(renameInRefString('{{step.foo}}', 'foo', 'bar')).toBe('{{step.bar}}');
  });

  it('rewrites nested field paths (foo.data → bar.data)', () => {
    expect(renameInRefString('{{step.foo.data}}', 'foo', 'bar')).toBe('{{step.bar.data}}');
  });

  it('is a fast no-op when the source has no {{ or no oldId', () => {
    expect(renameInRefString('hello', 'foo', 'bar')).toBe('hello');
    expect(renameInRefString('{{step.other}}', 'foo', 'bar')).toBe('{{step.other}}');
  });

  it('does NOT rewrite partial-matching identifiers (foo vs foo_bar)', () => {
    expect(renameInRefString('{{step.foo_bar}}', 'foo', 'X')).toBe('{{step.foo_bar}}');
    expect(renameInRefString('{{step.fooX}}', 'foo', 'Y')).toBe('{{step.fooX}}');
  });

  it('rewrites multiple occurrences in one pass', () => {
    expect(renameInRefString('{{step.foo}} and {{step.foo.data}}', 'foo', 'x'))
      .toBe('{{step.x}} and {{step.x.data}}');
  });

  it('respects the namespace argument (e.g. config)', () => {
    expect(renameInRefString('{{config.threshold}}', 'threshold', 'limit', 'config'))
      .toBe('{{config.limit}}');
    // Default namespace='step' should not rewrite config refs.
    expect(renameInRefString('{{config.threshold}}', 'threshold', 'limit'))
      .toBe('{{config.threshold}}');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renameInRefString('{{ step.foo }}', 'foo', 'bar')).toBe('{{ step.bar }}');
  });
});

// ────────────────────────────────────────────────────────────────
// renameInBareSource
// ────────────────────────────────────────────────────────────────

describe('renameInBareSource', () => {
  it('rewrites the step prefix when it matches exactly', () => {
    expect(renameInBareSource('step.summary', 'summary', 'overview'))
      .toBe('step.overview');
  });

  it('rewrites even when a dotted path follows (step.X.y)', () => {
    expect(renameInBareSource('step.deals[0].name', 'deals', 'items'))
      .toBe('step.items[0].name');
  });

  it('does not rewrite when the prefix is followed by identifier chars', () => {
    expect(renameInBareSource('step.summary_v2', 'summary', 'overview'))
      .toBe('step.summary_v2');
  });

  it('leaves unrelated sources untouched', () => {
    expect(renameInBareSource('step.other', 'summary', 'overview'))
      .toBe('step.other');
    expect(renameInBareSource('context.url', 'summary', 'overview'))
      .toBe('context.url');
  });
});

// ────────────────────────────────────────────────────────────────
// renameStepIdInRecipe
// ────────────────────────────────────────────────────────────────

describe('renameStepIdInRecipe', () => {
  const mkRecipe = (over: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
    recipe_id: 'r1', version: 1, ttl: 300,
    metadata: { name: 'R', description: 'd', author: 'local', supported_platforms: [] },
    variables: {},
    prefetch_steps: [],
    steps: [],
    output: { render: [] },
    ...over,
  });
  it('preserves special JSON property names while rewriting nested values', () => {
    const payload: unknown = JSON.parse('{"__proto__":{"value":"{{step.read}}"}}');
    const renamed = renameStepIdInRecipe(mkRecipe({
      steps: [{ id: 'read', op: 'core.records.create', args: { payload } }],
    }), 'read', 'fetch');
    expect(JSON.stringify(renamed.steps[0])).toContain('"__proto__":{"value":"{{step.fetch}}"}');
  });

  it('no-ops when oldId === newId (returns the same reference)', () => {
    const r = mkRecipe();
    expect(renameStepIdInRecipe(r, 'x', 'x')).toBe(r);
  });

  it('renames the step\'s own id in both prefetch and sequential sections', () => {
    const r = mkRecipe({
      prefetch_steps: [{ id: 'load', ingredient: 'reader' } as PrefetchStep],
      steps: [{ id: 'score', transform: 'math', expression: '1 + 1' } as unknown as RecipeStep],
    });
    const renamed = renameStepIdInRecipe(r, 'load', 'fetch');
    expect(renamed.prefetch_steps?.[0].id).toBe('fetch');

    const renamed2 = renameStepIdInRecipe(r, 'score', 'compute');
    expect(renamed2.steps?.[0].id).toBe('compute');
  });

  it('rewrites {{step.OLD.*}} refs across variables, prefetch, and steps', () => {
    const r = mkRecipe({
      variables: {
        template: '{{step.load.value}} goes here',
      } as unknown as Record<string, never>,
      prefetch_steps: [{ id: 'load', ingredient: 'reader' } as PrefetchStep],
      steps: [
        { id: 'downstream', transform: 'math', expression: '{{step.load.value}} * 2' } as unknown as RecipeStep,
      ],
    });
    const renamed = renameStepIdInRecipe(r, 'load', 'fetch');
    expect((renamed.variables as Record<string, unknown>).template).toBe('{{step.fetch.value}} goes here');
    expect((renamed.steps![0] as unknown as { expression: string }).expression)
      .toBe('{{step.fetch.value}} * 2');
  });

  it('rewrites output.render source paths that start with step.OLD', () => {
    const r = mkRecipe({
      steps: [{ id: 'score' } as unknown as RecipeStep],
      output: { render: [
        { type: 'summary', source: 'step.score' },
        { type: 'summary', source: 'step.score.breakdown' },
        { type: 'summary', source: 'step.other' },
      ] },
    });
    const renamed = renameStepIdInRecipe(r, 'score', 'rated');
    expect(renamed.output?.render?.[0].source).toBe('step.rated');
    expect(renamed.output?.render?.[1].source).toBe('step.rated.breakdown');
    expect(renamed.output?.render?.[2].source).toBe('step.other');
    expect(renamed.output?.sidebar).toBeUndefined();
  });

  it('renames trigger steps and their references across later phases', () => {
    const r = mkRecipe({
      auto_run: { interval_ms: 1000 },
      trigger_steps: [{ id: 'gate', ingredient: 'watch', input: {} }],
      output: { render: [{ type: 'summary', source: 'trigger.gate.value' }] },
      steps: [{ id: 'copy', transform: 'coalesce', values: ['{{trigger.gate.value}}', '{{step.gate.value}}'] }],
    });
    const renamed = renameStepIdInRecipe(r, 'gate', 'watcher');
    expect(renamed.trigger_steps?.[0].id).toBe('watcher');
    expect(renamed.output.render?.[0].source).toBe('trigger.watcher.value');
    expect(renamed.steps[0]).toMatchObject({ values: ['{{trigger.watcher.value}}', '{{step.watcher.value}}'] });
    expect(r.trigger_steps?.[0].id).toBe('gate');
  });

  it('preserves exchange output and rewrites its step references during rename', () => {
    const r = mkRecipe({
      steps: [{ id: 'reply', transform: 'coalesce', values: ['value'] }],
      output: { exchange: { ref: '{{step.reply}}', deliver_to: 'peer.reply', data: { answer: '{{step.reply}}' } } },
    });
    const renamed = renameStepIdInRecipe(r, 'reply', 'answer');
    expect(renamed.output).toEqual({ exchange: {
      ref: '{{step.answer}}', deliver_to: 'peer.reply', data: { answer: '{{step.answer}}' },
    } });
  });

  it('converts legacy output.sidebar sources to canonical render on edit', () => {
    const r = mkRecipe({
      steps: [{ id: 'score' } as unknown as RecipeStep],
      output: { sidebar: [
        { type: 'summary', source: 'step.score' },
        { type: 'summary', source: 'step.other' },
      ] },
    });
    const renamed = renameStepIdInRecipe(r, 'score', 'rated');
    expect(renamed.output?.render?.map((section) => section.source)).toEqual([
      'step.rated',
      'step.other',
    ]);
    expect(renamed.output?.sidebar).toBeUndefined();
  });

  it('prefers output.render over a legacy sidebar alias during rename', () => {
    const r = mkRecipe({
      steps: [{ id: 'score' } as unknown as RecipeStep],
      output: {
        render: [{ type: 'summary', source: 'step.score' }],
        sidebar: [{ type: 'summary', source: 'step.legacy' }],
      },
    });
    const renamed = renameStepIdInRecipe(r, 'score', 'rated');
    expect(renamed.output?.render?.map((section) => section.source)).toEqual([
      'step.rated',
    ]);
    expect(renamed.output?.sidebar).toBeUndefined();
  });

  it('does not mutate the original recipe', () => {
    const r = mkRecipe({
      steps: [
        { id: 'score', transform: 'math', expression: '{{step.load.value}}' } as unknown as RecipeStep,
      ],
    });
    const snapshot = JSON.stringify(r);
    renameStepIdInRecipe(r, 'load', 'fetch');
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});

// ────────────────────────────────────────────────────────────────
// formatCondition
// ────────────────────────────────────────────────────────────────

describe('formatCondition', () => {
  it('returns empty when both field and operator are empty', () => {
    expect(formatCondition({ field: '', operator: '', value: '' })).toBe('');
    expect(formatCondition({ field: '  ', operator: '  ' })).toBe('');
  });

  it('returns empty when only the operator is set (no field — nothing to guard on)', () => {
    expect(formatCondition({ field: '', operator: 'equal', value: 'x' })).toBe('');
  });

  it('returns the field alone when operator is missing', () => {
    expect(formatCondition({ field: '{{step.x}}', operator: '', value: '' }))
      .toBe('{{step.x}}');
  });

  it('omits the trailing value for unary ops', () => {
    expect(formatCondition({ field: '{{step.x}}', operator: 'is_null' }))
      .toBe('{{step.x}} is_null');
  });

  it('formats a full binary condition', () => {
    expect(formatCondition({ field: '{{step.x}}', operator: 'equal', value: 'closed_won' }))
      .toBe('{{step.x}} equal closed_won');
  });

  it('returns "field operator" when value is empty but operator is binary', () => {
    expect(formatCondition({ field: '{{step.x}}', operator: 'equal', value: '' }))
      .toBe('{{step.x}} equal');
  });
});

// ────────────────────────────────────────────────────────────────
// parseCSV / formatCSV
// ────────────────────────────────────────────────────────────────

describe('parseCSV / formatCSV', () => {
  it('parseCSV splits + trims + drops empty entries', () => {
    expect(parseCSV('a, b ,,  c')).toEqual(['a', 'b', 'c']);
    expect(parseCSV('')).toEqual([]);
    expect(parseCSV('   ')).toEqual([]);
  });

  it('formatCSV joins array with ", "', () => {
    expect(formatCSV(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('formatCSV coerces non-strings via String()', () => {
    expect(formatCSV([1, true, null])).toBe('1, true, null');
  });

  it('formatCSV returns empty string for non-array input', () => {
    expect(formatCSV(null)).toBe('');
    expect(formatCSV('not-an-array')).toBe('');
    expect(formatCSV({})).toBe('');
  });

  it('round-trips a well-formed string', () => {
    expect(formatCSV(parseCSV('a, b, c'))).toBe('a, b, c');
  });
});

// ────────────────────────────────────────────────────────────────
// validateStepIdRename
// ────────────────────────────────────────────────────────────────

describe('validateStepIdRename', () => {
  it('ok when newId === oldId (no-op)', () => {
    expect(validateStepIdRename(['a', 'b'], 'a', 'a')).toEqual({ ok: true });
  });

  it('rejects empty strings (after trim)', () => {
    const r = validateStepIdRename(['a'], 'a', '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cannot be empty');
  });

  it('rejects uppercase / non-identifier-start ids', () => {
    expect(validateStepIdRename([], 'a', 'Upper').ok).toBe(false);
    expect(validateStepIdRename([], 'a', '1leading').ok).toBe(false);
    expect(validateStepIdRename([], 'a', 'has-dash').ok).toBe(false);
  });

  it('rejects reserved namespace ids', () => {
    const r = validateStepIdRename([], 'a', 'step');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('reserved');
  });

  it('rejects collisions with an existing step id', () => {
    const r = validateStepIdRename(['existing', 'other'], 'a', 'existing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'existing'");
  });

  it('accepts a valid new id', () => {
    expect(validateStepIdRename(['a', 'b'], 'a', 'renamed_step')).toEqual({ ok: true });
  });
});

import { describe, expect, it } from 'vitest';
import {
  classifyRecordsMigrationRecipe,
  RecordsMigrationRouteError,
  selectRecordsMigrationRoute,
  type RecordsMigrationPlan,
} from '../migration.js';

const recipe = (from_v = 1, new_v = 2): unknown => ({
  recipe_id: `migrate-v${from_v}-v${new_v}`,
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Migrate records',
    description: 'Closed migration plan',
    author: 'publisher-a',
    supported_platforms: [],
    recipe_bundle: 'publisher-a/board',
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'move-title',
      op: 'core.records.migrate',
      args: {
        kind: 'job', from_v, new_v,
        field_mapping: [
          { op: 'move', from: 'title', to: 'summary' },
          { op: 'default', to: 'archived', value: false },
        ],
      },
    },
    { id: 'verify', op: 'core.records.verify-migration', args: { kind: 'job', from_v, new_v } },
    { id: 'finalize', op: 'core.records.finalize-migration', args: { from_v, new_v } },
  ],
  output: { render: [] },
  chat_exposed: false,
});

const classify = (value: unknown, from_v = 1, new_v = 2) =>
  classifyRecordsMigrationRecipe(
    { slug: `migrate-v${from_v}-v${new_v}`, version: 1, visible: false },
    value,
    'publisher-a/board',
  );

const plan = (from_v: number, new_v: number, suffix = ''): RecordsMigrationPlan => {
  const result = classify(recipe(from_v, new_v), from_v, new_v);
  if (result.kind !== 'migration') throw new Error(`fixture failed: ${result.kind}`);
  return { ...result.plan, recipe_digest: `${result.plan.recipe_digest}${suffix}` };
};

describe('D-221 migration classifier', () => {
  it('classifies only the exact hidden, literal, single-edge whole recipe', () => {
    const result = classify(recipe());
    expect(result).toMatchObject({
      kind: 'migration',
      plan: { from_v: 1, new_v: 2, steps: [{ id: 'move-title' }, { id: 'verify' }] },
    });
  });

  it.each([
    ['visible ref', (value: any) => value, { visible: true }],
    ['extra root key', (value: any) => { value.auto_run = { interval_ms: 1 }; return value; }, {}],
    ['dynamic default', (value: any) => { value.steps[0].args.field_mapping[1].value = '{{config.secret}}'; return value; }, {}],
    ['namespace selector', (value: any) => { value.steps[0].args.field_mapping[1].value = { publisher: 'other' }; return value; }, {}],
    ['execution knob', (value: any) => { value.steps[0].connection = 'x'; return value; }, {}],
    ['non-last finalizer', (value: any) => { value.steps.reverse(); return value; }, {}],
  ])('rejects %s before it can contribute a route', (_name, mutate, refOverride) => {
    const value = mutate(structuredClone(recipe()));
    const result = classifyRecordsMigrationRecipe(
      { slug: 'migrate-v1-v2', version: 1, visible: false, ...refOverride },
      value,
      'publisher-a/board',
    );
    expect(result.kind).toBe('invalid');
  });

  it('treats an ordinary recipe as business but refuses any malformed privileged recipe', () => {
    const business = structuredClone(recipe()) as any;
    business.steps = [{ id: 'send', ingredient: 'mail', input: {} }];
    expect(classify(business)).toEqual({ kind: 'business' });
    const mixed = structuredClone(recipe()) as any;
    mixed.steps.splice(1, 0, { id: 'send', op: 'mail.send', args: {} });
    expect(classify(mixed).kind).toBe('invalid');
  });

  it('rejects accessor-backed candidates without invoking their getters', () => {
    const value = structuredClone(recipe()) as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(value, 'steps', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return [];
      },
    });
    expect(classify(value)).toMatchObject({ kind: 'invalid', issue: expect.stringContaining('accessor-backed') });
    expect(getterCalls).toBe(0);
  });

  it('selects a unique shortest monotonic chain and refuses ambiguity/gaps', () => {
    expect(selectRecordsMigrationRoute([plan(1, 2), plan(2, 3)], 1, 3)
      .map((entry) => [entry.from_v, entry.new_v])).toEqual([[1, 2], [2, 3]]);
    expect(() => selectRecordsMigrationRoute([
      plan(1, 2, 'a'), plan(2, 4, 'a'), plan(1, 3, 'b'), plan(3, 4, 'b'),
    ], 1, 4)).toThrowError(RecordsMigrationRouteError);
    expect(() => selectRecordsMigrationRoute([plan(1, 2)], 1, 3))
      .toThrow(/no complete/);
  });
});

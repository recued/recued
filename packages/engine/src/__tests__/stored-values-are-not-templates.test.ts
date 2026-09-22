/** A value that ARRIVES AS DATA is never re-parsed as a template.
 *
 *  Resolution is a SINGLE PASS over the authored recipe document: `resolveDeep`
 *  walks the recipe's own strings and substitutes values into them, and
 *  `String.replace` with a function does not rescan its own replacement. A step
 *  result is data, not template source, so there is no second pass for a stored
 *  `{{…}}` to be caught by.
 *
 *  ⛔⛔ WHY THIS NEEDS A TEST AT ALL. It holds today because of the SHAPE of the
 *  resolver rather than because anything asserts it, and the way it would break
 *  is silent: a "resolve deeply" or "resolve until stable" change would turn
 *  every stored string into template source, and nothing in the suite would go
 *  red. The blast radius is the whole store — D-282 shipped a bug that wrote the
 *  literal text `{{item}}` into Records as document labels, and a corpus of
 *  mail bodies, file names and CRM fields is full of text nobody screened for
 *  braces.
 *
 *  ⛔ AND WHY THE FIXTURE COMES FROM THE EXECUTOR. The first version of this
 *  probe planted the template text in a `coalesce` literal — which is AUTHORED
 *  document text, where `{{config.*}}` is SUPPOSED to resolve. It appeared to
 *  demonstrate injection and demonstrated nothing. A store read returns a step
 *  RESULT; that is the only path that answers the question. */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

/** What a poisoned row looks like coming out of a store — or an honest one, after
 *  a transform failed to resolve and wrote its own template text as data. */
const STORED = {
  records: [
    { label: '{{config.secret}}', note: 'row one' },
    { label: '{{vault.api_key}}', note: 'row two' },
  ],
};

const rendered = async (
  steps: unknown[],
  watch: readonly string[],
): Promise<Record<string, unknown>> => {
  const recipe = {
    recipe_id: 'stored-values', version: 1, ttl: 0,
    metadata: {
      name: 'Stored values', description: 'x', author: 'test', supported_platforms: [],
    },
    variables: {}, prefetch_steps: [], steps, requires: [],
    output: {
      render: watch.map((id) => ({ type: 'json', label: id, source: `step.${id}` })),
    },
  } as unknown as RecipeDefinition;
  // The store stands in for every `data.*` read: the rows enter as a RESULT.
  const ingredientExecutor: IngredientExecutor = async () => STORED as never;
  const ctx = {
    recipe,
    stores: {
      vault: { api_key: 'VAULT-SECRET' },
      config: { secret: 'CONFIG-SECRET' },
      context: {}, meta: {}, step: {},
    },
    ingredientExecutor,
  } as never as ExecutionContext;
  const result = await executeRecipe(ctx);
  const out: Record<string, unknown> = {};
  for (const section of (result.output?.render ?? []) as Array<Record<string, unknown>>) {
    out[String(section.label)] = section.data;
  }
  return out;
};

const READ = { id: 'read', ingredient: 'store', input: {} };

describe('a stored value carrying template text', () => {
  /** ⛔⛔ THE POSITIVE CONTROL, AND THE TEST IS WORTHLESS WITHOUT IT. Every
   *  assertion below is a NEGATIVE — "the secret did not appear" — and a
   *  resolver that had stopped working entirely would satisfy all of them. This
   *  is the one that proves the mechanism is alive: the same reference, in the
   *  same run, in AUTHORED text, resolves. */
  it('CONTROL: the same reference in authored text does resolve', async () => {
    const out = await rendered([
      { id: 'authored', transform: 'template', template: 'secret is {{config.secret}}' },
    ], ['authored']);
    expect(out.authored).toBe('secret is CONFIG-SECRET');
  });

  it('stays literal when interpolated into authored text', async () => {
    const out = await rendered([
      READ,
      { id: 'text', transform: 'template',
        template: 'the label is [{{step.read.records.0.label}}]' },
    ], ['text']);
    expect(out.text).toBe('the label is [{{config.secret}}]');
  });

  it('stays literal through a map expression, pathed and interpolated', async () => {
    const out = await rendered([
      READ,
      { id: 'out', transform: 'map', array: '{{step.read.records}}',
        expression: { copied: '{{item.label}}', sentence: 'label {{item.label}}' } },
    ], ['out']);
    expect(out.out).toEqual([
      { copied: '{{config.secret}}', sentence: 'label {{config.secret}}' },
      { copied: '{{vault.api_key}}', sentence: 'label {{vault.api_key}}' },
    ]);
  });

  /** D-282 made a bare `{{item}}` resolve to the ELEMENT. That is a new way for
   *  a stored string to reach a template position, so it gets its own case
   *  rather than riding on the pathed one above. */
  it('stays literal when a bare {{item}} carries it', async () => {
    const out = await rendered([
      READ,
      // A map rather than a pluck: what matters is that the strings come OUT
      // of the stored rows, and this is the shape the corpus actually uses.
      { id: 'labels', transform: 'map', array: '{{step.read.records}}', expression: '{{item.label}}' },
      { id: 'whole', transform: 'map', array: '{{step.labels}}', expression: '{{item}}' },
      { id: 'inside', transform: 'map', array: '{{step.labels}}', expression: 'say {{item}}' },
    ], ['whole', 'inside']);
    expect(out.whole).toEqual(['{{config.secret}}', '{{vault.api_key}}']);
    expect(out.inside).toEqual(['say {{config.secret}}', 'say {{vault.api_key}}']);
  });

  /** ⛔ The one that matters most, and it has to exercise BOTH BRANCHES.
   *
   *  ⚠ A first version used only `template: '{{step.read.records.1.label}}'` —
   *  a PURE ref, where the whole string is one reference. `resolveValue` splits
   *  there: a pure ref short-circuits to `resolveRef` and never reaches the
   *  interpolation `String.replace` at all. Mutating the interpolation branch
   *  to resolve twice left this test GREEN while the sibling above went red, so
   *  it was claiming "by any path" while covering one. Both branches now. */
  it('never resolves a stored reference out of data, by either branch', async () => {
    const out = await rendered([
      READ,
      // Pure ref — `resolveRef`.
      { id: 'pure_vault', transform: 'template', template: '{{step.read.records.1.label}}' },
      { id: 'pure_config', transform: 'template', template: '{{step.read.records.0.label}}' },
      // Interpolated — the `String.replace` path.
      { id: 'woven_vault', transform: 'template',
        template: 'key [{{step.read.records.1.label}}] end' },
      { id: 'woven_config', transform: 'template',
        template: 'key [{{step.read.records.0.label}}] end' },
      { id: 'mapped', transform: 'map', array: '{{step.read.records}}',
        expression: { v: '{{item.label}}' } },
    ], ['read', 'pure_vault', 'pure_config', 'woven_vault', 'woven_config', 'mapped']);

    expect(out.pure_vault).toBe('{{vault.api_key}}');
    expect(out.pure_config).toBe('{{config.secret}}');
    expect(out.woven_vault).toBe('key [{{vault.api_key}}] end');
    expect(out.woven_config).toBe('key [{{config.secret}}] end');
    // And nothing anywhere in the run's output carries either secret.
    expect(JSON.stringify(out)).not.toContain('VAULT-SECRET');
    expect(JSON.stringify(out)).not.toContain('CONFIG-SECRET');
  });
});

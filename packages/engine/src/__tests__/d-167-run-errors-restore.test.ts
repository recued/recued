/**
 * D-167 Slice 3, for a run's ERRORS (2026-10-06).
 *
 * A step's error message can quote the data it failed on — a provider rejecting a
 * draft names the address it was given — and that data may be an alias this run's
 * `pii-protect` minted. The rendered output and the fired exchange were restored at
 * the end of the run; the errors were not, so `m1@d1.invalid` reached the owner's run
 * view, the audit row and a chat turn, where it names no one.
 *
 * Pinned through the real `executeRecipe`, on BOTH exit paths (no budget, and the
 * budget race), in `errors` and on the failed step's log — the host hands on both.
 */
import { describe, expect, it } from 'vitest';

import { resolveDeep } from '@recued/contracts';

import { executeRecipe } from '../execute.js';
import type { ExecutionContext } from '../types.js';

const RAW = { from: 'dana@northwind.example', name: 'Dana Whitfield' };

const recipe = (budget_ms?: number) => ({
  recipe_id: 'drafter',
  version: 1,
  metadata: {
    name: 'a', description: '', author: 'x', supported_platforms: [],
    ...(budget_ms !== undefined ? { budget_ms } : {}),
  },
  variables: {},
  steps: [
    {
      id: 'protect',
      transform: 'pii-protect',
      data: '{{context.raw}}',
      fields: [{ path: 'from', kind: 'email' }, { path: 'name', kind: 'name' }],
    },
    // No pii-restore before it: the draft goes out with the aliases, and the
    // provider's rejection quotes them.
    { id: 'draft', ingredient: 'mail-draft', input: { to: '{{step.protect.aliased.from}}', greeting: 'Hi {{step.protect.aliased.name}}' } },
  ],
  output: { sidebar: [] },
}) as any;

const run = async (budget_ms?: number) => {
  const stores = { vault: {}, config: {}, step: {}, context: { raw: structuredClone(RAW) }, meta: {} } as any;
  const sent: Record<string, unknown>[] = [];
  const ctx: ExecutionContext = {
    recipe: recipe(budget_ms),
    stores,
    ingredientExecutor: async (_slug, input) => {
      // As the dispatch layer would: resolve the step's refs against the run's stores.
      const resolved = resolveDeep(input, stores) as { to: string; greeting: string };
      sent.push(resolved);
      throw new Error(`Gmail rejected the draft (400): Invalid To header "${resolved.to}" for "${resolved.greeting}"`);
    },
  } as ExecutionContext;
  const result = await executeRecipe(ctx);
  return { result, sent };
};

describe('a failed run\'s errors are restored like its output', () => {
  for (const [path, budget] of [['the no-budget path', undefined], ['the budget path', 60_000]] as const) {
    it(`an error quoting an alias carries the real value — ${path}`, async () => {
      const { result, sent } = await run(budget);
      // The step really received the aliases; the restore is what changes the error.
      expect(sent).toEqual([{ to: 'm1@d1.invalid', greeting: expect.stringMatching(/^Hi pii\.Person\d+$/u) }]);
      expect(result.success).toBe(false);
      const expected = `Gmail rejected the draft (400): Invalid To header "${RAW.from}" for "Hi ${RAW.name}"`;
      expect(result.errors.map((e) => e.message)).toEqual([expected]);
      expect(result.steps.find((s) => s.id === 'draft')?.error?.message).toBe(expected);
      // Errors only: a step's own `result` stays the aliased data it produced (the
      // host hands on step ids and errors, never results).
      expect(JSON.stringify(result.errors) + JSON.stringify(result.steps.map((s) => s.error)))
        .not.toMatch(/m1@d1\.invalid|pii\.Person/u);
    });
  }

  it('a run that aliased nothing returns its errors as they were', async () => {
    const stores = { vault: {}, config: {}, step: {}, context: {}, meta: {} } as any;
    const ctx: ExecutionContext = {
      recipe: { ...recipe(), steps: [{ id: 'draft', ingredient: 'mail-draft', input: { to: 'pii.Person1' } }] },
      stores,
      ingredientExecutor: async () => { throw new Error('rejected: pii.Person1'); },
    } as ExecutionContext;
    const result = await executeRecipe(ctx);
    // A literal that only looks like an alias is not this run's to restore.
    expect(result.errors.map((e) => e.message)).toEqual(['rejected: pii.Person1']);
  });
});

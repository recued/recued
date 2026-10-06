/** D-193 amendment (2026-10-05) — no recipe step can schedule another recipe.
 *
 *  The owner's ruling: "take out core.schedule.recipe, not to be used in recipe
 *  step". `core.schedule.recipe` is now a NATIVE op (the grant for chat's
 *  `recipe.schedule` tool) and the `schedule-recipe` ingredient is gone. Neither
 *  has anything to lower to, so a recipe naming either would fail only at
 *  install or on its first run; the validator refuses it where it is written,
 *  and says where scheduling lives instead.
 *
 *  Native ops are derived from the registry, so a native op added later is
 *  refused in a step without anyone remembering this file. */

import { describe, expect, it } from 'vitest';
import { KERNEL_OP_REGISTRY } from '@recued/contracts';

import { validateRecipe } from '../validate.js';

type R = Record<string, unknown>;

const mkRecipe = (overrides: R): R => ({
  recipe_id: 'schedule-my-digest',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Schedule my digest',
    description: 'Tries to schedule another recipe from a step.',
    author: 'acme',
    supported_platforms: [],
    tags: ['schedule'],
  },
  variables: {},
  steps: [],
  dependencies: [],
  output: { sidebar: [] },
  ...overrides,
});

const issuesAt = (recipe: R, code: string) =>
  validateRecipe(recipe).issues.filter((i) => i.code === code && i.severity === 'error');

const SCHEDULE_STEP = { id: 'arm', op: 'core.schedule.recipe', args: { recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * *' } };

describe('a recipe step cannot schedule another recipe', () => {
  it('⛔ refuses core.schedule.recipe in steps, and says where scheduling lives', () => {
    const [issue, ...rest] = issuesAt(mkRecipe({ steps: [SCHEDULE_STEP] }), 'native_op_in_step');
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ path: 'steps[0].op' });
    expect(issue!.message).toMatch(/no recipe step can schedule another recipe/);
    expect(issue!.message).toMatch(/recipe\.schedule/);
    expect(issue!.message).toMatch(/Automation/);
  });

  it('⛔ refuses it in prefetch_steps too', () => {
    expect(issuesAt(mkRecipe({ prefetch_steps: [SCHEDULE_STEP] }), 'native_op_in_step'))
      .toEqual([expect.objectContaining({ path: 'prefetch_steps[0].op' })]);
  });

  it('⛔ refuses the retired schedule-recipe ingredient in steps and prefetch_steps', () => {
    const step = { id: 'arm', ingredient: 'schedule-recipe', input: { recipe_id: 'daily-digest' } };
    expect(issuesAt(mkRecipe({ steps: [step] }), 'retired_ingredient'))
      .toEqual([expect.objectContaining({ path: 'steps[0].ingredient', message: expect.stringMatching(/retired/) })]);
    expect(issuesAt(mkRecipe({ prefetch_steps: [step] }), 'retired_ingredient'))
      .toEqual([expect.objectContaining({ path: 'prefetch_steps[0].ingredient' })]);
  });
});

describe('every native op is a grant, not a step', () => {
  const natives = KERNEL_OP_REGISTRY.filter((entry) => (entry as { native?: boolean }).native === true);

  it('the registry has native ops, and core.schedule.recipe is one of them', () => {
    expect(natives.map((entry) => entry.op)).toContain('core.schedule.recipe');
  });

  it.each(natives.map((entry) => entry.op))('refuses %s in a step', (op) => {
    expect(issuesAt(mkRecipe({ steps: [{ id: 'x', op }] }), 'native_op_in_step')).toHaveLength(1);
  });

  it('leaves a kernel op with something to run alone', () => {
    // The control: a backed op (a real ingredient behind it) is not refused.
    const backed = KERNEL_OP_REGISTRY.find((entry) =>
      (entry as { native?: boolean }).native !== true && entry.op === 'core.notification.send');
    expect(backed).toBeDefined();
    expect(issuesAt(mkRecipe({ steps: [{ id: 'x', op: backed!.op, args: { text: 'hi' } }] }), 'native_op_in_step'))
      .toEqual([]);
  });
});

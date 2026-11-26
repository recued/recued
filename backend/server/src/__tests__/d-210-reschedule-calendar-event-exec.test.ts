/** D-210 R-4 — the reschedule-calendar-event recipe (the owner's move ignition),
 *  executed WHOLE through the real engine.
 *
 *  Structural validity is proven by the community-recipe corpus; this proves the
 *  recipe's data flow — the required-args guard and the exact `calendar-update`
 *  patch — by lowering the `op:` step and running it against a captured executor.
 *  Mirrors the D-195 / D-210 §7 exec harness.
 *
 *  Spec: D-210 §7 / Appendix A (R-4). */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveDeep, type RecipeDefinition } from '@recued/contracts';
import { lowerOpStepRecipe } from '@recued/recipes';
import { executeRecipe, type ExecutionContext, type IngredientExecutor } from '@recued/engine';

const RECIPE: RecipeDefinition = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../community/recipes/reschedule-calendar-event.json', import.meta.url),
    ),
    'utf8',
  ),
);

const NEW_START = 1_700_003_600_000;
const NEW_END = 1_700_007_200_000;

type Call = { slug: string; input: Record<string, unknown> };
type Handler = (slug: string, input: Record<string, unknown>) => unknown;

const run = async (
  config: Record<string, unknown>,
  handler: Handler,
  context: Record<string, unknown> = {},
): Promise<{ calls: Call[]; success: boolean; step: (id: string) => unknown }> => {
  const calls: Call[] = [];
  const stores: ExecutionContext['stores'] = { vault: {}, config, context, meta: {}, step: {} };
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    const resolved = resolveDeep(input, stores) as Record<string, unknown>;
    calls.push({ slug, input: resolved });
    return handler(slug, resolved);
  };
  const ctx: ExecutionContext = {
    recipe: lowerOpStepRecipe(RECIPE, new Map()),
    stores,
    ingredientExecutor,
  };
  const result = await executeRecipe(ctx);
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return { calls, success: result.success, step: (id) => result.steps.find((s) => s.id === id)?.result };
};

const CONFIG = {
  calendar_slug: 'local',
  event_source_id: 'evt-1',
  new_start_at: NEW_START,
  new_end_at: NEW_END,
};
const updateCalls = (calls: Call[]): Call[] => calls.filter((c) => c.slug === 'calendar-update');

describe('D-210 R-4 — reschedule-calendar-event (whole-recipe exec)', () => {
  it('patches calendar-update with the slug, source_id, and new start/end', async () => {
    const { calls, success } = await run(CONFIG, (slug) =>
      slug === 'calendar-update' ? { source_id: 'evt-1' } : null,
    );
    expect(success).toBe(true);
    const updates = updateCalls(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.slug).toBe('local');
    expect(updates[0]!.input.source_id).toBe('evt-1');
    // The patch carries ONLY the new times (identity is preserved provider-side).
    expect(updates[0]!.input.patch).toEqual({ start_at: NEW_START, end_at: NEW_END });
  });

  /** 2026-10-07 — the card said `{{config.new_start_at:date}}`: a timed move
   *  lost its time, and an all-day one showed the day before west of UTC (a day
   *  is stored as its UTC midnight). It now reads the event back as the
   *  calendar holds it and says when, on the owner's clock. */
  it("the card says the new time as the calendar now holds it, on the owner's clock", async () => {
    const DAY = Date.UTC(2026, 11, 31);
    const moved = (record: Record<string, unknown>) => (slug: string) =>
      slug === 'calendar-update' ? { source_id: 'evt-1' } : slug === 'calendar-get' ? { record } : null;
    const owner = { server: { available: true, time_zone: 'America/Los_Angeles' } };
    const allDay = await run(CONFIG, moved({ start_at: DAY, end_at: DAY + 86_400_000, is_all_day: true }), owner);
    expect(allDay.step('new_time')).toBe('2026-12-31, all day');
    const timed = await run(CONFIG, moved({ start_at: DAY + 18 * 3_600_000, end_at: DAY + 19 * 3_600_000, is_all_day: false }), owner);
    expect(timed.step('new_time')).toBe('2026-12-31 10:00–11:00');
    // It reads the event it moved, from the calendar it moved it on.
    expect(timed.calls.find((c) => c.slug === 'calendar-get')?.input).toEqual({ slug: 'local', source_id: 'evt-1' });
  });

  it('nothing moved: nothing is read back, and the card has no time', async () => {
    const { calls, step } = await run({ ...CONFIG, new_end_at: null }, () => ({ source_id: 'evt-1' }));
    expect(calls.some((c) => c.slug === 'calendar-get')).toBe(false);
    expect(step('new_time')).toBeNull();
  });

  it('missing new_start_at: the guard closes, no move', async () => {
    const { calls, success } = await run({ ...CONFIG, new_start_at: null }, () => ({
      source_id: 'evt-1',
    }));
    expect(success).toBe(true);
    expect(updateCalls(calls)).toHaveLength(0);
  });

  it('missing new_end_at (both times required): the guard closes, no move', async () => {
    const { calls } = await run({ ...CONFIG, new_end_at: null }, () => ({ source_id: 'evt-1' }));
    expect(updateCalls(calls)).toHaveLength(0);
  });

  it('missing event_source_id: the guard closes, no move', async () => {
    const { calls } = await run({ ...CONFIG, event_source_id: '' }, () => ({ source_id: 'evt-1' }));
    expect(updateCalls(calls)).toHaveLength(0);
  });

  it('missing calendar_slug: the guard closes, no move', async () => {
    const { calls } = await run({ ...CONFIG, calendar_slug: '' }, () => ({ source_id: 'evt-1' }));
    expect(updateCalls(calls)).toHaveLength(0);
  });
});

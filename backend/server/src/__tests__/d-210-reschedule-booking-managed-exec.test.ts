/** D-210 Appendix B / A.2 — the `reschedule-booking-managed` recipe (the
 *  ignition behind the public `/reception/manage` door), executed WHOLE through
 *  the real engine.
 *
 *  It is the `reschedule-booking` move MINUS `output.render` — the no-output
 *  variant that can back a public reception door (a door whose recipe renders
 *  output cannot carry a write; the manage HANDLER owns the response).
 *  This proves the two things that matter for a door recipe: the SAME single
 *  `booking-update` patch fires, and the recipe renders NOTHING.
 *
 *  ⚠ Was `reschedule-calendar-event-managed`, patching `calendar-update` on an
 *  `event_source_id`, until A.2 made booking ⟂ calendar. A visitor rescheduling
 *  their own reservation now moves the BOOKING's slot pair.
 *
 *  Spec: D-210 Appendix B + § A.2. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveDeep, type RecipeDefinition } from '@recued/contracts';
import { lowerOpStepRecipe } from '@recued/recipes';
import { executeRecipe, type ExecutionContext, type IngredientExecutor } from '@recued/engine';

const RECIPE: RecipeDefinition = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../community/recipes/reschedule-booking-managed.json',
        import.meta.url,
      ),
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
): Promise<{ calls: Call[]; success: boolean }> => {
  const calls: Call[] = [];
  const stores: ExecutionContext['stores'] = { vault: {}, config, context: {}, meta: {}, step: {} };
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
  return { calls, success: result.success };
};

const CONFIG = {
  booking_id: 'bk-1',
  new_start_at: NEW_START,
  new_end_at: NEW_END,
};
const updateCalls = (calls: Call[]): Call[] => calls.filter((c) => c.slug === 'booking-update');

describe('D-210 Appendix B — reschedule-booking-managed (whole-recipe exec)', () => {
  it('renders nothing — it is the door-safe no-output variant', () => {
    // The single reason this recipe exists over R-4: an anonymous write on a
    // door holds and returns no output, so a rendering door would show a bare
    // page. `bindReceptionDoor` refuses a rendering-and-writing door; this one
    // renders nothing so the manage handler owns the response.
    expect(RECIPE.output?.render ?? []).toEqual([]);
  });

  it('patches booking-update with the id and BOTH slot fields', async () => {
    const { calls, success } = await run(CONFIG, (slug) =>
      slug === 'booking-update' ? { booking: { id: 'bk-1' } } : null,
    );
    expect(success).toBe(true);
    const updates = updateCalls(calls);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.id).toBe('bk-1');
    // ⚠ BOTH, always. `booking-update` refuses a half-supplied move, so a
    // recipe that sent only the start would fail the visitor's reschedule
    // outright — and one that "helpfully" dropped the refusal would silently
    // resize their booking instead.
    expect(updates[0]!.input.slot_start_at).toBe(NEW_START);
    expect(updates[0]!.input.slot_end_at).toBe(NEW_END);
    // Nothing else is patched — identity, lifecycle and provenance untouched.
    expect(Object.keys(updates[0]!.input).sort()).toEqual(
      ['id', 'slot_end_at', 'slot_start_at'],
    );
  });

  it('missing new_start_at: the guard closes, no move', async () => {
    const { calls, success } = await run({ ...CONFIG, new_start_at: null }, () => ({
      booking: { id: 'bk-1' },
    }));
    expect(success).toBe(true);
    expect(updateCalls(calls)).toHaveLength(0);
  });

  it('missing new_end_at (both times required): the guard closes, no move', async () => {
    const { calls } = await run({ ...CONFIG, new_end_at: null }, () => ({ booking: { id: 'bk-1' } }));
    expect(updateCalls(calls)).toHaveLength(0);
  });

  it('missing booking_id: the guard closes, no move', async () => {
    const { calls } = await run({ ...CONFIG, booking_id: '' }, () => ({ booking: { id: 'bk-1' } }));
    expect(updateCalls(calls)).toHaveLength(0);
  });
});

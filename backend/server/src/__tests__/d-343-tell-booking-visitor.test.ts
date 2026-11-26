/** D-343 (§353) — the chat can tell a reception booking's visitor of a change it made. The chat's
 *  booking change says the visitor was not told and how to tell them; the reception pack's
 *  "Tell a booking's visitor about a change" (`tell-booking-visitor`, chat-exposed) sends the
 *  owner's message through `notify-booking-visitor`, which resolves the sealed address from the
 *  booking server-side, so the address is never an argument, and is an outbound send the owner
 *  approves. Executed whole through the real engine, as `d-210-notify-visitor-recipe-exec` drives
 *  the reschedule. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveDeep, type RecipeDefinition } from '@recued/contracts';
import { lowerOpStepRecipe } from '@recued/recipes';
import { executeRecipe, type ExecutionContext } from '@recued/engine';

const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));
const RECIPE: RecipeDefinition = read('../../../../community/recipes/tell-booking-visitor.json');

const run = async (config: Record<string, unknown>, notify: unknown = { notified: true }) => {
  const calls: Array<{ slug: string; input: Record<string, unknown> }> = [];
  const stores: ExecutionContext['stores'] = { vault: {}, config, context: {}, meta: {}, step: {} };
  const result = await executeRecipe({ recipe: lowerOpStepRecipe(RECIPE, new Map()), stores,
    ingredientExecutor: async (slug, input) => {
      const resolved = resolveDeep(input, stores) as Record<string, unknown>;
      calls.push({ slug, input: resolved });
      return slug === 'notify-booking-visitor' ? notify : null;
    } });
  return { calls, result, step: stores.step as Record<string, any> };
};
const CONFIG = { booking_id: 'bk-1', message: 'Your consultation on Thursday is cancelled. Sorry for the change.', sender_mail_instance: 'work' };

describe('D-343 — telling a reception booking\'s visitor of a change the chat made', () => {
  it('is a chat recipe of the reception pack, bundled with it', () => {
    expect(RECIPE).toMatchObject({ chat_exposed: true, metadata: { name: "Tell a booking's visitor about a change" } });
    const pack = read('../../../../community/packs/recued-core/reception-scheduling.json');
    expect(pack.recipes).toContainEqual({ slug: 'tell-booking-visitor', version: 1 });
  });

  it('sends the owner\'s message by the booking, never by an address', async () => {
    const { calls, result, step } = await run(CONFIG);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const notify = calls.filter(c => c.slug === 'notify-booking-visitor');
    expect(notify).toHaveLength(1);
    expect(notify[0]!.input).toEqual({ booking_id: 'bk-1', sender_mail_instance: 'work', subject: 'About your booking', body: CONFIG.message });
    expect(step.told).toBe(true);
  });

  it('says why nothing went for a booking with no visitor, and sends nothing without a message', async () => {
    const own = await run(CONFIG, { notified: false, reason: 'not_a_reception_booking' });
    expect(own.step).toMatchObject({ told: false, why_not: 'not_a_reception_booking' });
    const empty = await run({ ...CONFIG, message: '' });
    expect(empty.result.success).toBe(false);
    expect(empty.calls.filter(c => c.slug === 'notify-booking-visitor')).toHaveLength(0);
  });
});

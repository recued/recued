/** D-210 §7 — telling the visitor their booking moved, executed WHOLE through
 *  the real engine.
 *
 *  ⚠ RE-POINTED 2026-07-20 (code audit finding 4). This file used to run
 *  `notify-visitor-on-reschedule.json`, feeding it a hand-built
 *  `data.work.booking.item.updated` payload. Every test passed — and the recipe
 *  could never run in production: no `event_triggers`, no `trigger`, no
 *  `booking_id` variable (so no manual run could name a booking), not
 *  chat-exposed, and the only file in the repo referencing `data.work.booking.*`
 *  — zero subscribers. Executed with an empty context it reported
 *  `success: true` and dispatched nothing.
 *
 *  🔑 THE HARNESS ITSELF WAS THE TELL: it MANUFACTURED the `context.event` no
 *  fire path ever delivered, so it proved the recipe's internal LOGIC while
 *  saying nothing about whether anything invoked it. (This file had already been
 *  the site of one masking bug — see the struck header note about a fabricated
 *  top-level `start_at`. Same class, one layer up.)
 *  ⇒ [[a_call_site_is_not_a_wired_seam]] · [[a_green_test_over_a_hollow_seam]]
 *
 *  The notification is now an OWNER TICK on the reschedule itself
 *  (`reschedule-booking`), mirroring the mint's `notify_visitor` — the same
 *  owner-decides posture the trigger removal (`262fb7905`) was protecting, since
 *  event-trigger rows install `enabled DEFAULT 1` and armed an un-opted-in
 *  mailer. So this file drives THAT recipe, through the same
 *  lower-then-`executeRecipe` path, with no synthesized event anywhere.
 *
 *  Claims carried over (they were about the op contract, not the trigger): the op
 *  receives the booking id and never the address; a hand-entered booking is a
 *  clean no-op; missing sender config leaves the send inert. Claims retired with
 *  the trigger: the dedup marker and its idempotency arms — a per-occasion owner
 *  tick has no repeat-fire to suppress, so a second send is the owner asking for
 *  one.
 *
 *  Spec: D-210 §7. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveDeep, type RecipeDefinition } from '@recued/contracts';
import { lowerOpStepRecipe } from '@recued/recipes';
import { executeRecipe, type ExecutionContext, type IngredientExecutor } from '@recued/engine';

const RECIPE: RecipeDefinition = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../community/recipes/reschedule-booking.json', import.meta.url),
    ),
    'utf8',
  ),
);

const NEW_START = 1_700_003_600_000;
const NEW_END = NEW_START + 30 * 60_000;

type Call = { slug: string; input: Record<string, unknown> };
type Handler = (slug: string, input: Record<string, unknown>) => Promise<unknown> | unknown;

const run = async (
  config: Record<string, unknown>,
  handler: Handler,
): Promise<{ calls: Call[]; success: boolean }> => {
  const calls: Call[] = [];
  const stores: ExecutionContext['stores'] = {
    vault: {},
    config,
    // ⛔ No `context.event`, deliberately. The old file had to build one. If a
    // future edit reintroduces a `{{context.event.*}}` reference it resolves
    // undefined here and the notify silently stops firing — which is precisely
    // the failure this file now exists to keep from recurring.
    context: {},
    meta: {},
    step: {},
  };
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
  notify_visitor: true,
  sender_mail_instance: 'owner@own.example',
};

const handlerWith = (opts: { notify?: unknown } = {}): Handler => (slug) => {
  if (slug === 'booking-update') return { booking: { id: 'bk-1' } };
  if (slug === 'notify-booking-visitor') return opts.notify ?? { notified: true };
  return null;
};

const notifyCalls = (calls: Call[]): Call[] =>
  calls.filter((c) => c.slug === 'notify-booking-visitor');
const updateCalls = (calls: Call[]): Call[] =>
  calls.filter((c) => c.slug === 'booking-update');

describe('D-210 §7 — reschedule tells the visitor on the owner tick (whole-recipe exec)', () => {
  it('moves the booking AND reaches notify-booking-visitor with the booking id', async () => {
    const { calls, success } = await run(CONFIG, handlerWith());

    expect(success).toBe(true);
    // The move still happens, atomically, exactly as before.
    expect(updateCalls(calls)).toHaveLength(1);
    expect(updateCalls(calls)[0]!.input).toMatchObject({
      id: 'bk-1',
      slot_start_at: NEW_START,
      slot_end_at: NEW_END,
    });
    // …and the visitor is told, on the SAME run.
    const notify = notifyCalls(calls);
    expect(notify).toHaveLength(1);
    // The address is never an argument — only the booking id. The op resolves the
    // sealed address server-side from the booking's own `reception_record_id`.
    expect(notify[0]!.input).toMatchObject({
      booking_id: 'bk-1',
      sender_mail_instance: 'owner@own.example',
    });
    expect(Object.hasOwn(notify[0]!.input, 'to')).toBe(false);
    expect(String(notify[0]!.input.subject)).toContain('moved');
  });

  it('is OFF unless the owner ticks it — and the move still happens', async () => {
    // ⛔ The property the trigger removal was protecting. A message to someone
    // else is a judgement the owner makes per occasion; the default must not send.
    const { calls } = await run({ ...CONFIG, notify_visitor: false }, handlerWith());

    expect(updateCalls(calls)).toHaveLength(1);
    expect(notifyCalls(calls)).toEqual([]);
  });

  it('missing sender config: the booking still moves, nothing is sent', async () => {
    // Carried over. Without a send-capable sender there is nothing to send FROM,
    // and a half-configured notify must never fail the move itself.
    const { calls, success } = await run(
      { ...CONFIG, sender_mail_instance: '' },
      handlerWith(),
    );

    expect(success).toBe(true);
    expect(updateCalls(calls)).toHaveLength(1);
    expect(notifyCalls(calls)).toEqual([]);
  });

  it('a hand-entered booking (not_a_reception_booking) is a clean no-op, not a failure', async () => {
    // Carried over. A booking the owner typed has nobody sealed behind it; the op
    // reports `notified:false` with a coarse reason and the run still succeeds.
    const { calls, success } = await run(
      CONFIG,
      handlerWith({ notify: { notified: false, reason: 'not_a_reception_booking' } }),
    );

    expect(success).toBe(true);
    expect(notifyCalls(calls)).toHaveLength(1);
  });

  it('an incomplete config dispatches neither the move nor a notify', async () => {
    // The `ready` gate refuses outright — a notify naming no booking could only
    // mis-target, and a move with no id could only fail late.
    const { calls } = await run({ ...CONFIG, booking_id: '' }, handlerWith());

    expect(updateCalls(calls)).toEqual([]);
    expect(notifyCalls(calls)).toEqual([]);
  });
});

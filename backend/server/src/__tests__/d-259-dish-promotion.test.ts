/** D-259 §6.1 RETIRED (2026-10-05) — chat no longer keeps a run as a dish.
 *
 *  "Keep as dish" froze the settings one chat run used into a standing dish.
 *  A chat run's settings are worked out from that conversation (the prompt and
 *  what earlier tools returned), so a frozen copy of them had nowhere to go.
 *  Worse, a recipe's first dish becomes its MAIN one, and the main dish's
 *  settings fill in whatever a later run leaves out: after keeping "turn on the
 *  kitchen light", a vague "turn the light on" could quietly reuse the kitchen
 *  light instead of asking. The owner ruled it out. Dishes made on purpose in
 *  Recipes and Automation are unchanged.
 *
 *  Pinned so it cannot come back unannounced: the rpc is gone from the dish
 *  slice and from the server's method list (an older webclient pressing the
 *  old button is refused as an unknown method). That a successful chat call is
 *  no longer marked for it is pinned in `d-182-chat-run-failed.test.ts`. */

import { describe, expect, it } from 'vitest';

import { SERVER_RPC_METHOD_SET } from '@recued/contracts';

import type { DishStore } from '../dish-store.js';
import { makeDishHandlers } from '../dish-handler.js';

describe('D-259 §6.1 retired — chat no longer keeps a run as a dish', () => {
  it('the dish rpc slice offers no run-to-dish promotion', () => {
    const slice = makeDishHandlers({ store: {} as DishStore })!;
    expect(slice.methods).not.toContain('dishes.createFromRun');
    expect(slice.handlers).not.toHaveProperty('dishes.createFromRun');
    // What a dish is made by stays: the owner's own switch-on and its edits.
    expect(slice.methods).toEqual(expect.arrayContaining(['dishes.create', 'dishes.update', 'dishes.delete']));
  });

  it('the server registry has no such method', () => {
    expect(SERVER_RPC_METHOD_SET.has('dishes.createFromRun')).toBe(false);
    expect(SERVER_RPC_METHOD_SET.has('dishes.create')).toBe(true);
  });
});

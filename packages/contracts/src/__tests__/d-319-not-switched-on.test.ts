/** D-319 §5.4 — "Not switched on": a recipe that starts on its own and has no
 *  dish. One rule, read by Automation and by the server's one-time notice about
 *  the auto-run timers the update stopped (`auto-run-switch-on-notice.ts`). */

import { describe, expect, it } from 'vitest';

import { isNotSwitchedOn, startsOnItsOwn, type RecipeDefinition } from '../index.js';

type Starts = Pick<RecipeDefinition, 'auto_run' | 'event_triggers'>;

const onTimer: Starts = { auto_run: { interval_ms: 60_000 } };
const onTrigger: Starts = { event_triggers: [{ event: 'data.mail.*.created' }] as RecipeDefinition['event_triggers'] };
const manual: Starts = {};

describe('startsOnItsOwn', () => {
  it('a timer or a declared trigger starts a recipe on its own; nothing else does', () => {
    expect(startsOnItsOwn(onTimer)).toBe(true);
    expect(startsOnItsOwn(onTrigger)).toBe(true);
    expect(startsOnItsOwn(manual)).toBe(false);
    // An empty trigger list declares nothing.
    expect(startsOnItsOwn({ event_triggers: [] })).toBe(false);
  });
});

describe('isNotSwitchedOn', () => {
  it('a recipe that starts on its own and has no dish is not switched on', () => {
    expect(isNotSwitchedOn({ recipe: onTimer, dishes: 0 })).toBe(true);
    expect(isNotSwitchedOn({ recipe: onTrigger, dishes: 0 })).toBe(true);
  });

  it('any dish, on or off, is the recipe switched on: the dish carries the switch', () => {
    expect(isNotSwitchedOn({ recipe: onTimer, dishes: 1 })).toBe(false);
    expect(isNotSwitchedOn({ recipe: onTrigger, dishes: 2 })).toBe(false);
    expect(isNotSwitchedOn({ recipe: onTimer, dishes: 1, dishlessTimer: true })).toBe(false);
  });

  it('a recipe that runs only when the owner runs it has nothing to switch on', () => {
    expect(isNotSwitchedOn({ recipe: manual, dishes: 0 })).toBe(false);
  });

  it('without the definition, the server’s dishless timer row says it', () => {
    expect(isNotSwitchedOn({ recipe: undefined, dishes: 0, dishlessTimer: true })).toBe(true);
    expect(isNotSwitchedOn({ recipe: undefined, dishes: 0 })).toBe(false);
    expect(isNotSwitchedOn({ recipe: undefined, dishes: 0, dishlessTimer: false })).toBe(false);
  });
});

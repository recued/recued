/** D-160 P2 — the `personal-recipes` stream-middleware adapter (§ P2).
 *
 *  Registers the D-145 PB11 Person-Specific Automation dispatcher as a
 *  D-160 stream middleware. Lifecycle footprint: `update` (`after-turn`)
 *  — the dispatcher reads the turn's composed `AIOutput.events[]`, so it
 *  runs post-AI-call. The adapter runs `dispatchPersonalRecipes` (pure,
 *  no AI call) and writes the matched (event, entry) pairs back to
 *  `ctx.state`.
 *
 *  Scaffold scope (D-160 P2): the dispatcher input — the turn's
 *  extraction events plus a per-contact `PersonalRecipeEntry` lookup
 *  closure — rides `ctx.state` (`PERSONAL_RECIPES_INPUT_STATE_KEY`). A
 *  future producer / the deferred D-137-chat refactor (D-160 O-5)
 *  threads the turn's events + storage `getPersonalRecipes` in; absent
 *  one the hook is a faithful no-op.
 *
 *  Spec: docs/d-160-spec.md § P2.
 */

import type { Middleware, TurnResult } from '@recued/middleware';

import {
  dispatchPersonalRecipes,
  type DispatchPersonalRecipesInput,
} from './index.js';

/** `ctx.state` key — the `DispatchPersonalRecipesInput` (the turn's
 *  events + the per-contact lookup closure). */
export const PERSONAL_RECIPES_INPUT_STATE_KEY = 'personal-recipes:input';
/** `ctx.state` key — where the adapter writes the
 *  `DispatchPersonalRecipesResult`. */
export const PERSONAL_RECIPES_MATCHES_STATE_KEY = 'personal-recipes:matches';

/** Read the dispatcher input off `ctx.state`. Requires an `events`
 *  array and a `lookupPersonalRecipes` function; anything else (or an
 *  absent key) yields `undefined` and the hook no-ops. */
const readDispatchInput = (
  state: TurnResult['state'],
): DispatchPersonalRecipesInput | undefined => {
  const raw = state.get(PERSONAL_RECIPES_INPUT_STATE_KEY);
  if (raw === null || typeof raw !== 'object') return undefined;
  const snapshot = raw as { events?: unknown; lookupPersonalRecipes?: unknown };
  if (
    !Array.isArray(snapshot.events)
    || typeof snapshot.lookupPersonalRecipes !== 'function'
  ) {
    return undefined;
  }
  return raw as DispatchPersonalRecipesInput;
};

/** The `personal-recipes` middleware — registers enabled (D-160 P2). */
export const personalRecipesMiddleware: Middleware = {
  id: 'personal-recipes',
  update(ctx: TurnResult): void {
    const input = readDispatchInput(ctx.state);
    if (input === undefined) return; // faithful no-op — no dispatch input
    ctx.state.set(
      PERSONAL_RECIPES_MATCHES_STATE_KEY,
      dispatchPersonalRecipes(input),
    );
  },
};

/** D-405 slice 8 (2026-11-19) — the hint keys the earlier answers of a call's conversation carried, for
 *  ruling P3's "never the same hint twice in one conversation" wherever a hint is made.
 *
 *  Slices 1, 2 and 6 checked it for the steps the turn makes itself (from the owner's words, from the
 *  model's search of a feature). The steps the model's own searches add did not: "Add a Passport",
 *  "Set up <pack>" and "Get <pack>" came again under every answer whose turn searched. The owner, shown
 *  that: *"agree with #1, go ahead"*.
 *
 *  🔑 READ WHERE THE STEP IS MADE, NOT AFTER THE TURN. A step from a search travels with a sentence the
 *  model reads in the search's own result (D-404: "the model is told in the result it reads"). Left out
 *  after the turn, the row would go while the model's answer still pointed at it. So each place that
 *  offers a hint from a search asks this when it runs, and leaves a carried one out the way "Not now"
 *  leaves one out: its row and its sentence together (slice 3).
 *
 *  Read once a turn: the turn's own state (`turn_state`) holds the read, so every search of the turn
 *  shares it. The answer being made is not saved yet, so it is never its own earlier answer. A call with
 *  no conversation (`session_id`) has none. */

import type { ChatDispatchContext } from '@recued/contracts';

import { setupStepKeysOf } from './prompt-steps.js';

/** How far back an earlier answer's step means none now (ruling P3). */
export const HINT_HISTORY_MESSAGES = 200;

/** Where a turn's read is held in its `turn_state`. */
const TURN_STATE_KEY = 'd405.carried_hint_keys';

export interface CarriedHintsStore {
  listMessagePage(session_id: string, limit: number): Promise<{
    readonly messages: ReadonlyArray<{ readonly role?: unknown; readonly fixes?: unknown; readonly install_offers?: unknown }>;
  }>;
}

/** The hint keys a call's conversation already carried. Rejects when the conversation cannot be read; a
 *  caller then leaves nothing out, so a hint may show twice but is never lost. */
export type CarriedHintKeys = (ctx: ChatDispatchContext) => Promise<ReadonlySet<string>>;

export const createCarriedHintKeys = (store: CarriedHintsStore): CarriedHintKeys => (ctx) => {
  if (ctx.session_id === undefined) return Promise.resolve(new Set<string>());
  const held = ctx.turn_state?.get(TURN_STATE_KEY);
  if (held instanceof Promise) return held as Promise<ReadonlySet<string>>;
  const read: Promise<ReadonlySet<string>> = store.listMessagePage(ctx.session_id, HINT_HISTORY_MESSAGES)
    .then(({ messages }) => new Set(messages.flatMap(setupStepKeysOf)));
  ctx.turn_state?.set(TURN_STATE_KEY, read);
  return read;
};

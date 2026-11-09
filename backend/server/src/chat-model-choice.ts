/** D-344 slice C — the model the owner's chat runs on reaches the model calls of the recipes its turn
 *  runs. The owner: "user can always choose which model (the selected chat model) to perform such
 *  search". Ask a web page, a batch's asks and a recipe's AI steps resolved their own model before
 *  (a `fast` hint over the free pool first), so the owner's choice of model, and its thinking
 *  (slice A), never reached them.
 *
 *  The orchestrator runs each turn inside {@link withChatModelChoice}; the server executor's model
 *  calls read {@link currentChatModelChoice} and prefer that source (`PreferredSource`, `match.ts`):
 *  tried first at whichever speed tier it is, within the layer the step's pool allows, never a pin. A
 *  run that waited for the owner's approval resumes outside the turn, and routes as before. */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatModelRoutingLayer, ChatModelSourceId } from '@recued/contracts';
import type { PreferredSource } from '@recued/llm';

const turnChoice = new AsyncLocalStorage<PreferredSource>();

/** Run `turn` with `prefer` as the model its recipes' calls prefer; none, as it is. */
export const withChatModelChoice = <T>(prefer: PreferredSource | undefined, turn: () => Promise<T>): Promise<T> =>
  prefer === undefined ? turn() : turnChoice.run(prefer, turn);

/** The model the running chat turn prefers, if a model call is made inside one. */
export const currentChatModelChoice = (): PreferredSource | undefined => turnChoice.getStore();

/** A turn's model as its own call takes it (`chat-turn-executor.ts`): a slot it selected on its own
 *  keys, else the layer it runs on. The free pool drops a slot the session carries, as the chat's
 *  call does. */
export const chatModelChoiceOf = (layer: ChatModelRoutingLayer | undefined, source_id: ChatModelSourceId | undefined)
  : PreferredSource | undefined => {
  if (layer === 'free_pool' || (layer === undefined && source_id === 'free_pool')) return { layer: 'free' };
  if (source_id === 'slot_1' || source_id === 'slot_2') return { pinSlot: source_id };
  return layer === 'byok' ? { layer: 'byok' } : undefined;
};

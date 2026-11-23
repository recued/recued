/** D-402 slice A4 — "Make a recipe" under an answer whose request worked in a web page.
 *
 *  A browser job done once in the chat, kept as a recipe to run again: the server compiles what the
 *  request did (every turn of it) into a draft kept in Kitchen as Recued's, with its notes, and the
 *  chat opens it there. Nothing is saved until the owner saves it in Kitchen.
 *
 *  Offered under an answer of the owner's own chat one of whose calls ran a recipe that acts in a web
 *  page and finished (`ChatToolCall.browser`), while the server still holds what the call did
 *  (`CHAT_BROWSER_PLAN_HOLD_MS`). One recipe is made at a time, as the server's model drafting is.
 *  What a button shows is kept by its answer, as "Copy answer" keeps its own, so an answer drawn
 *  again while its recipe is being made shows that, and then the outcome. */

import { CHAT_BROWSER_PLAN_HOLD_MS, type ChatMessage } from '@recued/contracts';
import { kitchenRecipeAddress, kitchenWorkItemAddress } from '../kitchen/kitchen-navigation.js';

/** Where a draft made here opens in Kitchen: changes to a saved recipe on the recipe itself (D-333,
 *  D-402 slice E4c), any other draft as work in progress. */
export const requestRecipeOpenHash = (draft_id: string, recipe_id?: string): string =>
  (recipe_id !== undefined ? kitchenRecipeAddress(recipe_id) : kitchenWorkItemAddress(draft_id)).hash;

export type RequestRecipeAnswer =
  | { ok: true; draft_id: string; kitchen_path: string; recipe_id?: string; issues: string[] }
  | { ok: false; reason: string; issues: string[] };

export interface RequestRecipeCallers {
  /** `chat.execution.request_recipe`. */
  readonly make: (args: { session_id: string; turn_id: string }) => Promise<RequestRecipeAnswer>;
  /** Open the draft in Kitchen. False when the owner has moved on from the chat: the draft then
   *  waits in Kitchen's In progress. D-402 slice E4c — `recipe_id` when the draft is changes to that
   *  saved recipe, which Kitchen continues on the recipe itself. */
  readonly open: (draft_id: string, recipe_id?: string) => boolean;
}

export const REQUEST_RECIPE_ATTR = 'data-chat-request-recipe';

type Answer = Pick<ChatMessage, 'role' | 'turn_id' | 'tool_calls' | 'execution_source'>;

/** Whether an answer offers "Make a recipe": an answer of the owner's own chat (one with a host
 *  execution source is a scheduled occurrence's, whose runs Recued does not keep for this), with a
 *  call that worked in a web page and finished within the hour the server holds what it did. */
export const offersRequestRecipe = (message: Answer, now: number): boolean =>
  message.role === 'assistant' && typeof message.turn_id === 'string' && message.turn_id !== ''
  && message.execution_source === undefined
  && (message.tool_calls ?? []).some((call) => call.browser === true && call.status === 'ok'
    && now - (call.completed_at ?? call.started_at) < CHAT_BROWSER_PLAN_HOLD_MS);

interface State { phase: 'making' | 'done' | 'failed'; text: string }

export const createRequestRecipe = (doc: Document, callers: RequestRecipeCallers, now: () => number = Date.now) => {
  let disposed = false;
  const states = new Map<string, State>();
  /** The button each answer was last drawn with, and its line. */
  const drawn = new Map<string, { button: HTMLButtonElement; status: HTMLElement }>();
  const paint = (key: string): void => {
    const pair = drawn.get(key); if (!pair) return;
    const state = states.get(key);
    pair.status.textContent = state?.text ?? '';
    if (state?.phase === 'making') pair.button.setAttribute('aria-disabled', 'true');
    else pair.button.removeAttribute('aria-disabled');
  };
  const make = (key: string, session_id: string, turn_id: string): void => {
    if (disposed) return;
    if ([...states.values()].some((state) => state.phase === 'making')) {
      if (states.get(key)?.phase === 'making') return;
      const pair = drawn.get(key);
      if (pair) pair.status.textContent = 'Recued is making another recipe. Try again once it is done.';
      return;
    }
    states.set(key, { phase: 'making', text: 'Making a recipe…' }); paint(key);
    const settle = (state: State): void => { if (disposed) return; states.set(key, state); paint(key); };
    void callers.make({ session_id, turn_id }).then((answer) => {
      if (disposed) return;
      if (answer.ok) {
        settle({ phase: 'done', text: callers.open(answer.draft_id, answer.recipe_id)
          ? 'Opened in Kitchen.' : 'Made: it is waiting in Kitchen, under In progress.' });
      } else {
        settle({ phase: 'failed', text: answer.issues[0] ?? 'Recued could not make a recipe of this request.' });
      }
    }, () => settle({ phase: 'failed', text: 'Recued could not make a recipe of this request. Try again.' }));
  };
  return {
    /** Adds the button to an answer's actions, when the answer offers it. */
    append(actions: HTMLElement, message: Answer, sessionId: string | undefined): void {
      if (disposed || !sessionId || !offersRequestRecipe(message, now())) return;
      const turn_id = message.turn_id!;
      const key = JSON.stringify([sessionId, turn_id]);
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'chat-answer-copy';
      button.setAttribute(REQUEST_RECIPE_ATTR, key);
      button.textContent = 'Make a recipe';
      button.title = 'Make a recipe of what this request did in your browser, to run it again. It opens in Kitchen for you to check and save.';
      const status = doc.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      button.addEventListener('click', () => make(key, sessionId, turn_id));
      actions.append(button, status);
      drawn.set(key, { button, status }); paint(key);
    },
    dispose(): void { disposed = true; states.clear(); drawn.clear(); },
  };
};

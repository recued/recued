/** 2026-11-21 (the owner: "for the case when the 10 ceiling is hit, if 10 is kept, can it be resumed manually by user
 *  (present to user on what already has and basically user can continue maybe?)") — Continue under the latest answer
 *  that stopped at its rounds. The answer names the pages the turn reached (`toolBudgetStopAnswer`, server); Continue
 *  sends "Continue.", and the next turn carries on from the results that turn reached, which ride to it. */

import { CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE } from '@recued/contracts';

/** The Continue control; the VALUE is the answer's id. */
export const CONTINUE_ANSWER_ATTR = 'data-chat-answer-continue';
/** What Continue sends. */
export const CONTINUE_MESSAGE = 'Continue.';

/** Whether an answer offers Continue: its turn ended at its round limit, and it is the conversation's latest message.
 *  An older one would carry on from whatever the latest turn left. The limit is the server's mark
 *  (`reached_round_limit`, 2026-11-21: the owner, "recued sees the limit, stop the model, show a continue"), whatever
 *  the model wrote in its last call; an answer from an earlier server shows it only as its last line, the stop reason. */
export const offersContinue = (message: { readonly role: string; readonly content: string; readonly id: string;
  readonly reached_round_limit?: true }, latestId: string | undefined): boolean => message.role === 'assistant'
  && message.id === latestId
  && (message.reached_round_limit === true || message.content.trimEnd().endsWith(CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE));

/** Adds Continue to an answer's actions. Disabled while a message is being sent; once pressed, it stays disabled. */
export const appendContinue = (doc: Document, actions: HTMLElement, message: { readonly id: string },
  send: (text: string) => void, sending: boolean): HTMLButtonElement => {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'chat-answer-copy';
  button.setAttribute(CONTINUE_ANSWER_ATTR, message.id);
  button.textContent = 'Continue';
  button.disabled = sending;
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    send(CONTINUE_MESSAGE);
  });
  // `appendChild`, as the copy action beside it (`answer-copy.ts`): the chat route's test doubles have no `append`.
  actions.appendChild(button);
  return button;
};

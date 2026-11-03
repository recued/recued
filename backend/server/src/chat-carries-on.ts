/** D-337 — which conversations carry on once a call held in them is answered, and what a call held
 *  there tells the model about it.
 *
 *  The owner's own conversations carry on (D-337 §3.1): the app's chat, a scheduled
 *  conversation (ruling 3), and a messenger or email chat of the owner's own (ruling 2). A chat
 *  under a contract does not: a resume cannot re-read its authority (D-329 §6.B), and it keeps its
 *  fixed reply. A leaf, so the held-call projections and the continuations read one rule.
 *
 *  Slice K: in such a conversation, while a call of a turn waits for the owner's answer, a further
 *  call of that turn that would ask them is not asked (`askAfterWaiting`): the model makes it once
 *  the conversation carries on with the first call's outcome. */
import type { ExecutionSource } from '@recued/contracts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The owner's own messenger or email conversation: the only other source a continuation runs
 *  as. A conversation under a contract never continues (D-329: a resume cannot re-read its
 *  authority). An email chat is one (`vendor: 'email'`, the D-318 door): its continuation's
 *  answer is emailed as a reply to the request that made the call (`mail_chat_held_result_answer_owed`). */
export const isOwnMessengerSource = (
  source: unknown,
): source is Extract<ExecutionSource, { channel: 'messenger'; actor: 'user_self' }> =>
  isRecord(source) && source.channel === 'messenger' && source.actor === 'user_self'
  && typeof source.vendor === 'string' && source.vendor.length > 0
  && typeof source.from === 'string' && source.from.length > 0
  && !('contract_id' in source);

export const isOwnAppChatSource = (source: ExecutionSource): boolean =>
  source.channel === 'chat' && source.actor === 'user_self' && source.contract_id === undefined;

/** A scheduled conversation: the owner's own chat, whose prompt the schedule sends (the owner:
 *  "just a normal chat where the user prompt injected on schedule, so there is no separate
 *  treatment"). It carries on as that chat does, as the owner's app chat. Never under a contract
 *  (`prompt_schedule` excludes `contract_id`); a scheduled RECIPE is no conversation. */
export const isOwnScheduledConversationSource = (source: ExecutionSource): boolean =>
  source.channel === 'schedule' && source.prompt_schedule !== undefined
  && typeof source.chat_session_id === 'string' && source.chat_session_id.length > 0;

/** Does a call held in this conversation carry it on once answered? Only a conversation that is
 *  named: an AI app over MCP, or a caller that names none, hears the outcome its own way. */
export const conversationCarriesOn = (source: unknown): boolean => {
  if (!isRecord(source)) return false;
  const s = source as unknown as ExecutionSource;
  return isOwnAppChatSource(s) || isOwnScheduledConversationSource(s) || isOwnMessengerSource(s);
};

/** What a held run or a held pack action, in a conversation that carries on, tells the model
 *  comes after it (`after_approval`). ⛔ Without it the model was left to guess what came next: a
 *  request ending "tell me what Recued reported" had that promised back in 1 of 3 first answers
 *  (live, 2026-11-01); with it, 3 of 3.
 *  ⛔ A step the user asked for after this one waits too, EVEN ONE THAT WOULD ITSELF ASK: asked to
 *  remove an event and, once it was gone, add another, the model proposed the add at once in 2 of
 *  3 first answers under "do not take a step that needs its result" ("Both actions are queued for
 *  your approval"), the add's own approval then free to run it first or after a no. With these
 *  words, in 1 of 6 (live, 2026-11-01).
 *  `HELD_FOR_APPROVAL_MESSAGE` is shared with MCP and byte-pinned, so this rides beside it.
 *  ⚠ Model-facing string — see `chat-prompt-optimization-log.md`. */
export const HELD_CARRIES_ON_MESSAGE =
  'Once the user answers this approval, this conversation carries on by itself: you will get this '
  + 'call and its outcome then, as if it had just returned, and can take the next step it needs. '
  + 'Until then, do not take a step that should only happen after this one, or that needs its '
  + 'result, even one that would wait for approval too: it could then run first, or run although '
  + 'this one was declined. Do not ask the user to tell you when it is done.';

/** The turn's calls that wait for the owner's answer, by tool name, in `turn_state` (one turn's
 *  process-local scratch: never stored, never sent). */
const WAITING_IN_TURN = 'd337.waiting_in_turn';

/** A call of this turn now waits for the owner's answer: a held run or pack action, or a write
 *  put to them. */
export const noteWaitingInTurn = (turn_state: Map<string, unknown> | undefined, tool_name: string): void => {
  if (turn_state === undefined) return;
  const waiting = turn_state.get(WAITING_IN_TURN);
  turn_state.set(WAITING_IN_TURN, [...(Array.isArray(waiting) ? waiting as string[] : []), tool_name]);
};

/** D-337 slice K — the call this turn already waits on, when a further call that would ask the
 *  owner must not be asked yet; `undefined` when it may be asked. Only in a conversation that
 *  carries on: there the model gets that call's outcome once the owner answers, and makes this
 *  call then if it should still happen (the owner: "AI proposes it after"). Elsewhere nothing would
 *  bring it back, and the call is asked as before.
 *  ⛔ Words did not hold it: told to wait, the model still put a step the owner asked for after a
 *  held one up for approval at once in 1 of 6 first answers (2 of 3 before slice J's words), and
 *  its approval could then run it before the first, or after a no to it. */
export const askAfterWaiting = (
  source: unknown,
  turn_state: Map<string, unknown> | undefined,
): string | undefined => {
  if (!conversationCarriesOn(source)) return undefined;
  const waiting = turn_state?.get(WAITING_IN_TURN);
  return Array.isArray(waiting) && typeof waiting[0] === 'string' ? waiting[0] : undefined;
};

/** What the model reads for a call not asked (`not_asked_yet`), naming the call it waits on.
 *  Nothing was proposed, held or run, and nothing is waiting for the owner on its account.
 *  ⚠ Model-facing string — see `chat-prompt-optimization-log.md`. */
export const notAskedYetMessage = (waiting: string): string =>
  `Not asked: an earlier call in this turn (${waiting}) is waiting for the user's approval, and `
  + 'nothing more is put to them until they answer it. Once they do, this conversation carries on '
  + 'by itself with its outcome, and you can make this call then, if it should still happen. It is '
  + 'not waiting for their approval: tell them it comes after.';

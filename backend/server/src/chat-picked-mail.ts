/** D-406 — the emails the owner picked for a message, read before the turn's first round (ruling P3).
 *
 *  The owner named each one exactly (`ChatMessage.mail_refs`), so the turn reads it with `mail.read` by its id,
 *  side by side, before the model's first round, as calls of the turn's own: recorded, audited and aliased as a
 *  model's calls are, through the same dispatch (the owner's switch and contract hold: a read they refuse says
 *  so in its result, and its fix comes under the answer). The read carries the message's place in its thread
 *  (P4, `mail.read`'s `thread`), so the model knows when there is more of its thread. The model is told
 *  the reads are there in one line. */

/** Which emails a turn reads before its first round: each picked email's mailbox and record id. */
export interface PickedMailRead {
  readonly slug: string;
  readonly record_id: string;
}

/** The turn a message's picks are read for. */
interface PickedTurn {
  readonly picker_target: string;
  readonly execution_source: { readonly channel: string; readonly actor?: string };
  readonly mail_refs?: ReadonlyArray<{ readonly slug: string; readonly record_id: string }>;
  readonly calendar_refs?: ReadonlyArray<{ readonly slug: string; readonly record_id: string }>;
  readonly mail_work?: unknown;
  readonly retry_of_plan_id?: string;
  readonly continuation_of_turn_id?: string;
  readonly held_results?: unknown;
}

/** Whether a turn reads its message's picks before its first round: the owner's own chat turn that opened with
 *  them, answered by their own model.
 *  ⛔ Never for another picker's model: a turn sent to a peer would carry the owner's mail or calendar to it. Nor
 *  for a mail-work investigation (it rereads its own seeds), a retry, a continuation or a turn opening with held
 *  results: none is the message the owner picked them for. */
const readsPicks = (turn: PickedTurn): boolean => turn.picker_target === 'self' && turn.execution_source.channel === 'chat'
  && turn.execution_source.actor === 'user_self' && !turn.mail_work && !turn.retry_of_plan_id
  && turn.continuation_of_turn_id === undefined && turn.held_results === undefined;

/** The reads a turn makes before its first round for the emails its message names (`readsPicks`), none otherwise. */
export const pickedMailReads = (turn: PickedTurn): PickedMailRead[] =>
  (readsPicks(turn) ? (turn.mail_refs ?? []).map(({ slug, record_id }) => ({ slug, record_id })) : []);

/** D-406 (Q4) — which events a turn reads before its first round: each picked event's calendar and record id. */
export interface PickedCalendarRead {
  readonly slug: string;
  readonly record_id: string;
}

/** The reads a turn makes before its first round for the calendar events its message names (`readsPicks`), each
 *  with `calendar.search` by its record id; none otherwise. */
export const pickedCalendarReads = (turn: PickedTurn): PickedCalendarRead[] =>
  (readsPicks(turn) ? (turn.calendar_refs ?? []).map(({ slug, record_id }) => ({ slug, record_id })) : []);

/** What a turn that opens holding the picked events' reads is told. ⚠ Model-facing string, see
 *  `chat-prompt-optimization-log.md`. It never says a read succeeded: each call's own result says that. */
export const pickedCalendarNote = (count: number): string => (count === 1
  ? 'The owner picked the calendar event this request is about. It was read for this request before this round with calendar.search by its record_id, and that call is in prior_tool_calls with its result'
  : `The owner picked ${String(count)} calendar events for this request. Each was read for it before this round with calendar.search by its record_id, and those calls are in prior_tool_calls with their results`)
  + '. Answer from them, and say so when a read did not succeed.';

/** What a turn that opens holding the picked emails' reads is told. ⚠ Model-facing string, see
 *  `chat-prompt-optimization-log.md`. It never says a read succeeded: each call's own result says that. */
export const pickedMailNote = (count: number): string => (count === 1
  ? 'The owner picked the email this request is about. It was read for this request before this round with mail.read, and that call is in prior_tool_calls with its result'
  : `The owner picked ${String(count)} emails for this request. Each was read for it before this round with mail.read, and those calls are in prior_tool_calls with their results`)
  + ': thread gives each one\'s place in its own thread. Answer from them; read more of its thread or the mail around it only if the request needs it, and say so when a read did not succeed.';

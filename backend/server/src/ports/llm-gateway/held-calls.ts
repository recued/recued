/** D-337 follow-up 24, design (b) — a gateway call still waiting for the owner's approval when its
 *  reply goes reaches the conversation's next request.
 *
 *  The owner: *"approval takes more than 2 minutes should be a common case"*. Design (a) keeps a
 *  request open for 2 minutes (`LLM_GATEWAY_HELD_WAIT_MS`; 25 s when it is not streamed,
 *  `LLM_GATEWAY_HELD_WAIT_UNSTREAMED_MS`); past that the reply goes, and an
 *  OpenAI-compatible gateway has no way to send anything after it. So the outcome waits for the
 *  conversation's next request, and is put in front of the model there.
 *
 *  ⛔ WHICH CONVERSATION. The gateway keeps none: the app sends the whole history with each request,
 *  a request is its own session, and one key can carry several conversations at once (an app's
 *  parallel sessions, or several people using one app). Reply text cannot tell them apart: two
 *  sessions can get the same "waiting for approval" reply word for word (the owner: *"look out for
 *  the cases when 1,2,3 sessions also have 'waiting for approval'"*). So each waiting call carries
 *  a random reference, its MCP action's (`mcpact_` + 32 hex), and Recued adds it to the reply
 *  (`llmGatewayWaitingTrailer`). The app sends that reply back in that conversation's history only.
 *
 *  🔑 THE LATEST REPLY CARRIES THE STATE. Only the history's last assistant reply is read
 *  (`waitingRefsInLatestReply`). A reference there that has settled has its outcome put in front of
 *  the model; one still waiting is added again to the new reply, so it is never lost. An outcome
 *  told is in no later reply, so it is told once; a reply regenerated over the same history hears
 *  it again, as it should, since the reply that told it was discarded.
 *
 *  The record is the MCP door's own (`McpActionStore`): created when the call is held, owned by the
 *  key (`getOwned`), and settled by the resumer when the owner answers (completed, denied, failed).
 *  ⛔ A run retired with no answer does not settle it: an approval that expired retires the run
 *  (`checkpoint-retention`), not the record. So a record still waiting is read as the door's status
 *  read reads it (`reconcileMcpAction`), from the run's durable state; without that, a conversation
 *  whose approval expired would hear "waiting" in every reply from then on. A reference another key
 *  owns, or one no store knows, is ignored. */
import type { ChatPriorToolCall } from '@recued/contracts';
import type { LLMMessage } from '@recued/llm';

import { heldResultCall, type HeldResultOutcome } from '../../chat-held-results.js';
import { isMcpActionTerminal, type McpActionRecord, type McpActionStore } from '../../mcp-action-store.js';

/** A waiting call's reference, as Recued writes it into a reply. */
const WAITING_REF = /mcpact_[0-9a-f]{32}/g;

/** What the gateway model reads for a call still waiting when its request ends, in place of the
 *  owner's own (`HELD_FOR_APPROVAL_MESSAGE`, which tells the user to answer it in the Recued app,
 *  from the bell: the owner's words, and a gateway's user is usually the owner's customer).
 *  ⚠ Model-facing string — see `chat-prompt-optimization-log.md`. */
export const LLM_GATEWAY_HELD_MESSAGE =
  'This action is queued for approval in Recued by the person who runs this service. This is '
  + 'expected, not a failure: do not call this tool again or resend it. It is not approved from '
  + 'this conversation, so do not tell the user how to approve it. Tell them it is waiting for that '
  + 'approval, and that they will hear how it went the next time they write in this conversation.';

/** The line Recued adds to a reply while calls of it wait. The app's user sees it, and the app sends
 *  it back with the history, which is how the next request finds them.
 *  ⚠ Model-facing as well, in the history of later requests. */
export const llmGatewayWaitingTrailer = (refs: readonly string[]): string =>
  `\n\n[Waiting for approval — ${refs.length > 1 ? 'refs' : 'ref'} ${refs.join(', ')}]`;

/** The note of a request that carries outcomes of calls an earlier reply left waiting. Rides the
 *  turn's `in_flight_context`. ⚠ Model-facing string — see `chat-prompt-optimization-log.md`. */
export const LLM_GATEWAY_CARRIED_NOTE =
  'Actions started earlier in this conversation waited for approval by the person who runs this '
  + 'service and have since been answered. Each comes first in prior_tool_calls with its outcome, as '
  + 'if it had just returned; this supersedes what earlier replies said about it. Tell the user how '
  + 'each went and take the next step the work needs, as well as answering their message.';

/** The note of a request whose latest reply named calls still waiting (`others`: beside ones answered
 *  since, which `LLM_GATEWAY_CARRIED_NOTE` tells). Rides the turn's `in_flight_context` too.
 *
 *  ⛔ Without it the model promised what it cannot do. Such a turn holds nothing of the call but its
 *  own earlier reply, and asked again the model answered "I will let you know as soon as I hear
 *  back" or "You will be notified once it has been processed" in 4 of 6 live runs (2026-11-02,
 *  D-337 slice S): the gateway answers only when the app writes, and nothing notifies the user.
 *  The words it gives for the user are the ones the model uses: told to say "it still waits", it
 *  answered "It still waits for approval." 6 of 6, so they are the plain ones (slice T).
 *  ⚠ Model-facing string — see `chat-prompt-optimization-log.md`. */
export const llmGatewayStillWaitingNote = (count: number, others: boolean): string => {
  const one = count === 1;
  const it = one ? 'it' : 'them';
  return `The ${others ? 'other ' : ''}${one ? 'action you said earlier was' : 'actions you said earlier were'} `
    + `waiting for approval by the person who runs this service ${one ? 'is' : 'are'} still waiting: `
    + `nothing has been decided about ${it} yet. You cannot check on ${it}, and you cannot write to the `
    + 'user first, so do not say you will let them know or that they will be notified. If the user asks, '
    + `tell them ${one ? 'it is' : 'they are'} still waiting, and that they will hear how ${one ? 'it' : 'they'} `
    + 'went when they next write in this conversation.';
};

/** The references in the conversation's latest reply, in the order they appear, once each. */
export const waitingRefsInLatestReply = (messages: ReadonlyArray<LLMMessage>): string[] => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    return [...new Set(message.content.match(WAITING_REF) ?? [])];
  }
  return [];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** An approval nobody answered in time: a raw op's record settled by retention (`expired`), or a
 *  recipe run's as the door's reconcile settles it, from the run retired with
 *  `RECIPE_APPROVAL_TIMEOUT`. */
const expiredApproval = (record: McpActionRecord): boolean => {
  if (!isRecord(record.result)) return false;
  if (record.status === 'cancelled') return record.result.expired === true;
  return record.status === 'failed' && isRecord(record.result.error)
    && record.result.error.code === 'RECIPE_APPROVAL_TIMEOUT';
};

const outcomeOf = (record: McpActionRecord): HeldResultOutcome => {
  if (record.status === 'completed') return 'ran';
  if (record.status === 'denied') return 'refused';
  if (expiredApproval(record)) return 'expired';
  return 'failed';
};

/** A settled action as the model reads it among the turn's opening calls, as the owner's own
 *  conversation reads a call that waited (`heldResultCall`). The record keeps no arguments. */
export const heldCallFromAction = (record: McpActionRecord): ChatPriorToolCall => {
  const outcome = outcomeOf(record);
  return heldResultCall({
    session_id: '',
    run_id: record.run_id,
    tool_name: record.tool_name,
    tier: 2,
    outcome,
    ...(outcome === 'ran' || outcome === 'failed' ? { result: record.result } : {}),
    called_at: record.created_at,
    settled_at: record.terminal_at ?? record.updated_at,
  });
};

export interface CarriedHeldCalls {
  /** Calls settled since the latest reply: told in this request. */
  readonly settled: ChatPriorToolCall[];
  /** Calls still waiting: their references go on the new reply. */
  readonly waiting: string[];
}

/** The latest reply's waiting calls, read for the key that sent this request. `reconcile` is the
 *  door's status read (`reconcileMcpAction`), for a record still waiting. */
export const readCarriedHeldCalls = async (
  store: Pick<McpActionStore, 'getOwned'>,
  messages: ReadonlyArray<LLMMessage>,
  principal_id: string,
  reconcile?: (record: McpActionRecord) => Promise<McpActionRecord>,
): Promise<CarriedHeldCalls> => {
  const settled: ChatPriorToolCall[] = [];
  const waiting: string[] = [];
  for (const ref of waitingRefsInLatestReply(messages)) {
    let record: McpActionRecord | null;
    try {
      record = await store.getOwned(ref, principal_id);
      if (record !== null && !isMcpActionTerminal(record.status) && reconcile !== undefined) {
        record = await reconcile(record);
      }
    } catch {
      // A store that cannot be read loses nothing: the reference stays waiting on the new reply.
      waiting.push(ref);
      continue;
    }
    if (record === null) continue;
    if (isMcpActionTerminal(record.status)) settled.push(heldCallFromAction(record));
    else waiting.push(ref);
  }
  return { settled, waiting };
};

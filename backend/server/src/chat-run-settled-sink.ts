/** The RESULT half of a paired tool call, written when a held run settles.
 *
 *  ⛔⛔ EXTRACTED FROM THE WIRE FILE SO ITS GUARDS CAN BE TESTED. Inline in
 *  `wire-chat-orchestrator.ts` this is unreachable from a test without standing
 *  up the whole composition — and it carries two authority decisions (which
 *  corpus, whose session) that must not rest on review alone. */

import { isExecutionSource, type ExecutionSource, type RecuedServerSignature } from '@recued/contracts';
import type { PreflightRunSettled } from './preflight-resumer.js';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';
import { clearPendingAfterWait } from './chat-rolling-brief.js';
import { renderToolRow, type ChatBroadcastEmitter } from './chat-orchestrator.js';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  deriveChatMessageRecallEligibility,
  type ChatStore,
} from './storage/chat-store.js';

export interface RunSettledRow {
  readonly session_id: string;
  /** The ORIGINATING turn — the one that asked, not the one that happened to be
   *  open when the run settled.
   *
   *  ⛔⛔ WITHOUT THIS THE PAIR SPLITS UNDER A TURN WINDOW. The dispatch row
   *  carries `turn_id`; the settle row did not, so a turn-scoped recall
   *  admitted the ASK and excluded the ANSWER — exactly backwards. And the
   *  originating turn is the right one on its own terms: a late settle may land
   *  with no turn open at all, and the exchange it completes belongs to the
   *  turn that started it. */
  readonly turn_id: string | null;
  readonly pair_id: string;
  readonly result: unknown;
  readonly tool_name: string;
  readonly ts: number;
  readonly execution_source: ExecutionSource;
}

/** Decide whether a settled run earns a durable row, and under which session.
 *
 *  ⛔ THE ORIGINATING SOURCE DECIDES THE CORPUS, NOT THE APPROVER'S. The
 *  resumer recovers `execution_source` off the paused audit anchor precisely so
 *  a resume runs under the authority that ASKED. A row written under whoever
 *  clicked approve would land in the wrong corpus — and for a door that is a
 *  cross-tenant write.
 *
 *  ⛔ OWNER CORPUS ONLY, matching the dispatch half. A door's tool results are
 *  not written at all, so writing a settle half for one would mint an orphan in
 *  a corpus that has no first half — a result with no ask, which reads as an
 *  outcome that nobody requested.
 *
 *  ⚠ `null` on anything unresolvable rather than a best guess: a settle whose
 *  session cannot be named is a row with no conversation to belong to. */
export const planRunSettledRow = (
  settled: PreflightRunSettled,
): RunSettledRow | null => {
  if (isNonTerminalToolResult(settled.result)) return null;
  const source = settled.execution_source;
  if (!isExecutionSource(source)) return null;
  if (
    deriveChatMessageRecallEligibility(source)
    !== CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT
  ) return null;
  // ⚠ REDUNDANT TODAY AND NOT LOAD-BEARING — mutation testing (2026-09-04)
  //   shows removing it leaves every test green, because
  //   `deriveChatMessageRecallEligibility` can only return
  //   `OWNER_AUTHENTICATED_CHAT` for the chat channel, so the gate above
  //   already implies this one. It stays as a fence against a future widening
  //   of that derivation: the field read below is chat-specific, and a new
  //   owner-authenticated channel without a `chat_session_id` would otherwise
  //   fall through to a session lookup that means nothing on it. Recorded as
  //   unexercised rather than presented as verified.
  if (source.channel !== 'chat') return null;
  const session_id = (source as { chat_session_id?: unknown }).chat_session_id;
  if (typeof session_id !== 'string' || session_id.length === 0) return null;
  if (settled.run_id.length === 0) return null;
  const turn_id = (source as { turn_id?: unknown }).turn_id;
  return {
    session_id,
    turn_id: typeof turn_id === 'string' && turn_id.length > 0 ? turn_id : null,
    pair_id: settled.run_id,
    result: settled.result,
    tool_name: settled.tool_name,
    ts: settled.ts,
    execution_source: source,
  };
};

/** Shared by production composition and the restart/lifecycle tests. */
export const createChatRunSettledSink = (
  store: ChatStore,
  signature: RecuedServerSignature,
  broadcast: ChatBroadcastEmitter,
) => async (settled: PreflightRunSettled): Promise<void> => {
  let callIds: string[] = [];
  try {
    const plan = planRunSettledRow(settled);
    if (!plan) return;
    callIds = store.toolCalls?.findByRun(plan.session_id, plan.pair_id) ?? [];
    const succeeded = plan.result !== null && typeof plan.result === 'object'
      && (plan.result as { success?: unknown }).success === true;
    // A refusal settles as `failed` too; marking it keeps "you said no" from
    // reading as "it broke", to the owner and to the model's next turn.
    const denied = !succeeded && plan.result !== null && typeof plan.result === 'object'
      && (plan.result as { denied?: unknown }).denied === true;
    const state = settled.state ?? (succeeded ? 'succeeded' as const : 'failed' as const);
    await store.appendMessage({
      id: `settle:${plan.pair_id}`, session_id: plan.session_id, role: 'tool',
      content: renderToolRow(plan.tool_name, undefined, plan.result),
      target_server: 'self', picker_at_send: { display_name: 'self', signature },
      model_used: { provider: 'recued', model_id: 'run-settled' },
      execution_source: plan.execution_source, ts: plan.ts, pair_id: plan.pair_id,
      ...(plan.turn_id !== null ? { turn_id: plan.turn_id } : {}),
      // A result delivered after the originating turn has no PII candidate
      // pass to finalize it. Keep the encrypted owner-visible result outside
      // model recall. Existing untracked pairs keep their legacy writer.
      ...(callIds.length > 0 ? { source_lifecycle: 'failed' as const } : {}),
      tool_call_settlements: callIds.map(message_id => ({ message_id, state,
        ...(denied && state === 'failed' ? { denied: true as const } : {}) })),
    });
    for (const message_id of callIds) {
      broadcast.emit({ kind: 'chat.session_changed', session_id: plan.session_id,
        field: 'tool_call', value: store.toolCalls?.get(message_id) });
    }
    // The running brief was folded while this call waited: its "still to do"
    // was written around the wait. ⚠ In its own try: the settlement above is
    // already durable, and a brief that cannot be tidied is not a failed
    // settlement — the catch below would report one and re-broadcast the calls.
    try {
      const stored = await store.readSessionBrief(plan.session_id);
      const tidied = stored === null ? null : clearPendingAfterWait(stored);
      if (tidied !== null) await store.writeSessionBrief(plan.session_id, tidied);
    } catch (error) {
      console.error('[chat] run-settled brief tidy failed', error);
    }
  } catch (error) {
    console.error('[chat] run-settled tool row append failed', error);
    // In particular, a locked vault can refuse the result encryption while
    // metadata remains writable. Leave an explicit owner-review path.
    try {
      for (const id of callIds) {
        store.toolCalls?.interrupt(id, true);
        const call = store.toolCalls?.get(id);
        if (call) broadcast.emit({ kind: 'chat.session_changed', session_id: call.session_id,
          field: 'tool_call', value: call });
      }
    } catch (writeError) { console.error('[chat] late-call interruption persistence failed', writeError); }
  }
};

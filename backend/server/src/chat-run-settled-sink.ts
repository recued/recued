/** The RESULT half of a paired tool call, written when a held run settles.
 *
 *  ⛔⛔ EXTRACTED FROM THE WIRE FILE SO ITS GUARDS CAN BE TESTED. Inline in
 *  `wire-chat-orchestrator.ts` this is unreachable from a test without standing
 *  up the whole composition — and it carries two authority decisions (which
 *  corpus, whose session) that must not rest on review alone. */

import { isExecutionSource, type ExecutionSource } from '@recued/contracts';
import type { PreflightRunSettled } from './preflight-resumer.js';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  deriveChatMessageRecallEligibility,
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

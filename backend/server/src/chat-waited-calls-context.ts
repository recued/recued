/** Where each call that stopped to wait stands now — for the model's next turn.
 *
 *  ⛔⛔ WITHOUT THIS THE MODEL REPORTS ITS OWN STALE SENTENCE AS THE STATE OF THE
 *  WORLD. A held call ends its turn with "I've queued it, it is waiting for your
 *  approval". The approval lands later, elsewhere, and the run settles through
 *  `createChatRunSettledSink` — whose row is deliberately kept OUT of model recall
 *  (a late result had no PII candidate pass; D-259 Slice 4). So nothing tells the
 *  next turn it settled, and the newest thing the model has said about it is
 *  "queued". Live 2026-10-04: a door unlocked after approval, the owner asked "Is
 *  the kitchen door unlocked now?" and the model answered "Not yet. The request is
 *  still waiting for your approval."
 *
 *  🔑 OUTCOME ONLY, NEVER THE RESULT. The state of a call (waiting, finished, not
 *  run because the owner refused it, failed, stopped part-way) is display metadata
 *  on the call record, not the encrypted result, so the recall decision above
 *  stands: the model learns THAT it happened, and reads the current state with a
 *  tool if it needs WHAT happened.
 *
 *  Rides in `in_flight_context` (the dynamic tail, outside the cacheable prefix,
 *  inside the PII alias scan — recipe names can carry personal text). Absent when
 *  this chat has no call that waited, so such a turn is byte-identical to before. */

import type { ChatToolCallRecord, ExecutionSource } from '@recued/contracts';
import type { ChatToolCallTracker } from './storage/chat-tool-call-store.js';

/** Bounded: a long chat with many approvals must not grow every turn's tail. */
export const WAITED_CALLS_CONTEXT_MAX = 5;
const LINE_MAX = 512;

/** ⚠ WHY IT NAMES THE BRIEF. Live 2026-10-04 (Qwen, n=1): with a lead saying only
 *  "newer than anything said about them earlier", the model still answered from
 *  the running brief (`context.brief`, whose findings said "awaiting approval" and
 *  whose note says "Work from it") and from its own "queued" reply: two older
 *  sources outvoted one newer line. See the prompt-optimization log, 2026-10-04. */
export const WAITED_CALLS_CONTEXT_LEAD =
  'Calls in this chat that had to wait, and where each stands now. This supersedes what earlier '
  + 'messages and the running brief say about them: a call shown here as went ahead and finished '
  + 'did run, after its wait. Their results are not shown here.';

const stateText = (call: ChatToolCallRecord): string | null => {
  switch (call.state) {
    case 'held': return 'still waiting';
    case 'succeeded': return 'went ahead and finished';
    case 'failed': return call.denied === true ? 'did not run, the owner refused it' : 'went ahead but failed';
    case 'interrupted': return 'stopped part-way, outcome unknown';
    // Running again after its go-ahead: the in-flight lines already carry it.
    case 'running': return null;
  }
};

export const renderWaitedCallsContext = (
  calls: readonly ChatToolCallRecord[],
): string | undefined => {
  const lines = [...calls]
    .filter((call) => call.held_at !== undefined)
    .sort((a, b) => a.started_at - b.started_at)
    .flatMap((call) => {
      const state = stateText(call);
      if (state === null) return [];
      const line = [
        ...(call.run_id !== undefined ? [`run=${call.run_id}`] : []),
        `recipe=${call.tool_name}`,
        `state=${state}`,
        `asked_at=${call.started_at}`,
        ...(call.state === 'held' ? [] : [`settled_at=${call.updated_at}`]),
      ].join('; ');
      return [line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1)}…`];
    });
  if (lines.length === 0) return undefined;
  return [WAITED_CALLS_CONTEXT_LEAD, ...lines].join('\n');
};

/** The owner's own chat only — the same boundary as the durable call record
 *  itself (`chat-orchestrator.ts` writes one for no other source). */
export const buildWaitedCallsContext = (
  tracker: Pick<ChatToolCallTracker, 'listWaited'> | undefined,
  source: ExecutionSource,
): string | undefined => {
  if (tracker === undefined || source.channel !== 'chat' || source.actor !== 'user_self'
    || source.contract_id !== undefined) return undefined;
  if (source.chat_session_id.length === 0) return undefined;
  return renderWaitedCallsContext(
    tracker.listWaited(source.chat_session_id, WAITED_CALLS_CONTEXT_MAX),
  );
};

/** The live-work block and this one share the field; either may be absent. */
export const joinInFlightContexts = (
  ...parts: ReadonlyArray<string | undefined>
): string | undefined => {
  const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return present.length === 0 ? undefined : present.join('\n');
};

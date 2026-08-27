/** Which chat sessions are running a turn right now.
 *
 *  The client used to have to INFER this. It tracked its own sends in a map,
 *  and after a dropped socket it had no way to tell a turn that had finished
 *  in the gap from one still running — so it guessed, and guessed toward
 *  releasing, because the alternative was a composer locked with nothing able
 *  to reopen it. The server has always known the answer; it just never said.
 *
 *  ⛔ IN-MEMORY, PER-PROCESS, AND THAT IS THE CORRECT SEMANTICS — not a
 *  shortcut around persistence. A turn lives in the process that runs it, so a
 *  restart does not interrupt a turn, it ENDS one. A `busy` column surviving
 *  that restart would come back describing work nothing is doing, and there is
 *  no later event to correct it: the turn that would have cleared the flag died
 *  with the process. An empty registry after a restart is not lost state, it is
 *  the true state. ⇒ [[feedback_name_a_durable_artifact_for_the_act_not_the_outcome]]
 *
 *  Refcounted rather than a boolean: nothing stops two turns being in flight
 *  for one session (the webclient forbids it, other surfaces do not), and a
 *  plain flag would let the first to finish declare the session idle while the
 *  second was still running.
 */

import type {
  ChatBroadcastEmitter,
  ChatOrchestrator,
} from './chat-orchestrator.js';

export interface ChatSessionBusyRegistry {
  /** Mark a turn as started. Returns the release — call it exactly once, from
   *  a `finally`, so a THROWN turn releases as surely as a returning one. */
  enter(session_id: string): () => void;
  /** Every session currently running at least one turn. The COMPLETE answer,
   *  which is what lets a caller treat an empty array as "nothing is busy"
   *  rather than "I could not tell". */
  busySessionIds(): string[];
  isBusy(session_id: string): boolean;
}

export const createChatSessionBusyRegistry = (
  broadcast?: ChatBroadcastEmitter,
): ChatSessionBusyRegistry => {
  const turnsBySession = new Map<string, number>();

  const emit = (session_id: string, value: boolean): void => {
    if (!broadcast) return;
    try {
      broadcast.emit({
        kind: 'chat.session_changed',
        session_id,
        field: 'busy',
        value,
      });
    } catch {
      // Observability-only. A broadcast that throws must never take a turn
      // down with it — the list read still reports the truth.
    }
  };

  return {
    enter(session_id: string): () => void {
      const before = turnsBySession.get(session_id) ?? 0;
      turnsBySession.set(session_id, before + 1);
      // Transition only. A second concurrent turn changes the count, not the
      // answer to "is this session busy", and re-announcing it would make
      // every client repaint for nothing.
      if (before === 0) emit(session_id, true);
      let released = false;
      return () => {
        // ⛔ Idempotent by construction. A release called twice would drop the
        // count below the number of live turns and declare a running session
        // idle — the exact stale-flag failure this registry exists to end.
        if (released) return;
        released = true;
        const current = turnsBySession.get(session_id) ?? 0;
        const next = current - 1;
        if (next > 0) {
          turnsBySession.set(session_id, next);
          return;
        }
        turnsBySession.delete(session_id);
        emit(session_id, false);
      };
    },
    busySessionIds(): string[] {
      return [...turnsBySession.keys()];
    },
    isBusy(session_id: string): boolean {
      return (turnsBySession.get(session_id) ?? 0) > 0;
    },
  };
};

/** Interface-preserving decorator over the two orchestrator entry points that
 *  run a turn against a DURABLE session.
 *
 *  🔑 Wrapping here rather than inside the orchestrator is deliberate: turn
 *  lifecycle is one `try/finally` around a 500-line body, and threading it
 *  through that body is how a release gets missed on an early return. A
 *  session stuck busy forever is worse than no busy state at all, so the
 *  release lives at the outermost edge where there is exactly one way out.
 *
 *  ⛔ `runLlmGatewayTurn` is deliberately NOT wrapped. It is the stateless
 *  contracted-customer path — no durable owner session, so there is no session
 *  for anyone to observe as busy. */
export const withChatSessionBusy = (
  orchestrator: ChatOrchestrator,
  registry: ChatSessionBusyRegistry,
): ChatOrchestrator => ({
  ...orchestrator,
  runTurn: (input) => {
    const release = registry.enter(input.session_id);
    return orchestrator.runTurn(input).finally(release);
  },
  runMessengerTurn: (input) => {
    const release = registry.enter(input.inbound.session_id);
    return orchestrator.runMessengerTurn(input).finally(release);
  },
});

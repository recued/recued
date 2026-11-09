/** D-335 slice W2 — the browser steps of the owner's chat, by the turn whose run did them.
 *
 *  Each type, pick, click, press or send the toolkit does on a page names the element it acted on
 *  (`acted_on`, Bridge 0.0.8): the page's address and title, the element as an ask names it, and a
 *  selector that finds it again another day. The DOM adapter records each under its run; the
 *  execute handler says which chat turn a run belongs to, so a resumed run (one held for approval)
 *  files under the turn that asked for it. The "Worth remembering?" offer reads a turn's steps, and
 *  the owner's "That was right" keeps them (W3).
 *
 *  In memory, and only for an hour: nothing outlives the process that the owner did not choose to
 *  keep. What was typed into a field for a password, a sign-in code or a card is never recorded:
 *  its step says only that it is secret. */

import type { ExecutionBrowserFlowStep } from '@recued/contracts';

/** A step, as the contracts name it for the owner's Learning page. */
export type BrowserFlowStep = ExecutionBrowserFlowStep;
export type BrowserFlowStepKind = BrowserFlowStep['do'];

export interface BrowserFlowTurn {
  session_id: string;
  turn_id: string;
}

export interface BrowserFlowRecorder {
  /** The chat turn a run belongs to. A run bound to none records nothing. */
  bindRun(run_id: string, turn: BrowserFlowTurn): void;
  /** One step a run did. */
  record(run_id: string, step: Omit<BrowserFlowStep, 'at'>): void;
  /** The steps of the session's turns that `inTurn` accepts, in the order they were done. */
  stepsFor(session_id: string, inTurn: (turn_id: string) => boolean): BrowserFlowStep[];
  /** Forget the steps of those turns (kept, or answered otherwise). */
  forget(session_id: string, inTurn: (turn_id: string) => boolean): void;
}

/** How long steps nobody kept are held. */
export const BROWSER_FLOW_HOLD_MS = 60 * 60_000;
/** The most steps held for one session: a long session drops its oldest first. */
export const BROWSER_FLOW_MAX_STEPS = 200;

export const createBrowserFlowRecorder = (options: { now?: () => number; holdMs?: number } = {}): BrowserFlowRecorder => {
  const now = options.now ?? Date.now;
  const holdMs = options.holdMs ?? BROWSER_FLOW_HOLD_MS;
  const runs = new Map<string, BrowserFlowTurn & { at: number }>();
  const sessions = new Map<string, Array<BrowserFlowStep & { turn_id: string }>>();
  const sweep = () => {
    const before = now() - holdMs;
    for (const [run, bound] of runs) if (bound.at < before) runs.delete(run);
    for (const [session, steps] of sessions) {
      const fresh = steps.filter((step) => step.at >= before);
      if (fresh.length === 0) sessions.delete(session);
      else if (fresh.length !== steps.length) sessions.set(session, fresh);
    }
  };
  return {
    bindRun(run_id, turn) {
      sweep();
      runs.set(run_id, { session_id: turn.session_id, turn_id: turn.turn_id, at: now() });
    },
    record(run_id, step) {
      const bound = runs.get(run_id);
      if (bound === undefined) return;
      const steps = sessions.get(bound.session_id) ?? [];
      steps.push({ ...step, at: now(), turn_id: bound.turn_id });
      sessions.set(bound.session_id, steps.slice(-BROWSER_FLOW_MAX_STEPS));
    },
    stepsFor(session_id, inTurn) {
      sweep();
      return (sessions.get(session_id) ?? []).filter((step) => inTurn(step.turn_id))
        .map(({ turn_id: _turn, ...step }) => step);
    },
    forget(session_id, inTurn) {
      const steps = sessions.get(session_id);
      if (steps === undefined) return;
      const left = steps.filter((step) => !inTurn(step.turn_id));
      if (left.length === 0) sessions.delete(session_id);
      else sessions.set(session_id, left);
    },
  };
};

/** The process's recorder, as the page read store is the process's: one server, one owner. */
export const browserFlows: BrowserFlowRecorder = createBrowserFlowRecorder();

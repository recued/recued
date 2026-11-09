/** D-188 — approving while the server is paused (the owner's rulings of 2026-11-08).
 *
 *  The owner: *"maybe it is more like you cannot perform approval during pause? because if
 *  it is a master switch, the action after approval won't work or not supposed to work,
 *  which means allowing the approval during pause will just lead to a refusal."* Then the
 *  pause became a lockdown: *"schedule/arm/trigger/manual all stopped"*, and chat with them.
 *
 *  While paused nothing runs: schedules, armed auto-runs and triggers are stopped, a run by
 *  hand is refused at its start (`handleExecute`), chat turns wait in their queue, every
 *  built-in tool call is refused, and every caller under a contract is refused at dispatch
 *  (the admission's `server_paused`). An approval could only end in a refusal, so while
 *  paused a held action can be declined, not approved: it waits, and is approved after
 *  Resume. That includes the owner's own run by hand, which the first ruling still let
 *  through: the lockdown stops it too.
 *
 *  Only a held run's approval waits. Every other ask records its answer and runs nothing
 *  now: a missed schedule's "Run them" is a grant the stopped scheduler fires after Resume,
 *  and an in-doubt "No — retry" re-sends nothing.
 *
 *  Nothing new is asked during a pause either: the catalog gateway refuses a caller the pause
 *  stops before its ask (`operationRefusal`), as the commit gateway and the raw-op door
 *  already did. What is enforced here is the answer, wherever it comes from: the block's
 *  `submitAnswer` (the webclient, the `/ask` link, email, a held chat write, the reception
 *  inbox), plus the two paths that do not pass through it (a plain chat plan, the
 *  reception inbox's ask-less release), which refuse on the same rule. */
import { RpcError } from '@recued/contracts';
import { PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import type { PendingAsk } from '@recued/notification';

/** What the owner reads when an approval waits for Resume. */
export const PAUSED_APPROVAL_REFUSAL =
  'The server is paused. Resume it to approve this; you can still deny it.';

/** …for a chat plan, whose decline is Cancel. */
export const PAUSED_PLAN_REFUSAL =
  'The server is paused. Resume it to approve this plan; you can still cancel it.';

/** The rpc error code an answer refused for the pause carries: the admission's own. */
export const PAUSED_APPROVAL_CODE = 'server_paused';

/** D-188 — the admission's `server_paused` detail: what every dispatch the pause refuses reads,
 *  a model or app as much as the owner. "Every operation": since the emergency-stop ruling the
 *  pause freezes every source, the owner's own hands included (it said "contracted and AI
 *  operations" while only those froze). Keep "until the owner resumes": it is what tells a
 *  model not to retry. */
export const SERVER_PAUSED_DETAIL = 'server is paused — every operation is halted until the owner resumes';

/** What the owner reads when a run by hand is not started during a pause (`handleExecute`). */
export const PAUSED_RUN_REFUSAL = 'The server is paused. Resume it, then run this again.';

/** …and its rpc error code: the same. */
export const PAUSED_RUN_CODE = PAUSED_APPROVAL_CODE;

/** What any other caller reads when its run is not started during a pause: a schedule, a
 *  trigger, a door's queue, an app. */
export const PAUSED_RUN_DETAIL = `${SERVER_PAUSED_DETAIL}; do not retry until then`;

/** Was this run refused at its start for now, not failed: the server is restarting (`draining`)
 *  or paused (`server_paused`)? Nothing ran, so the caller keeps its work for later (a schedule
 *  writes no run, a trigger records no fire, a queue hands its item back). */
export const isRunRefusedForNow = (error: unknown): boolean =>
  error instanceof RpcError && (error.code === 'draining' || error.code === PAUSED_RUN_CODE);

export interface PausedApprovalDeps {
  readonly isPaused: () => boolean;
}

/** The answers an approval takes while it waits for Resume: declining only. Every other
 *  option of a `gateway.preflight` ask lets the held action go ahead (approve, allow this
 *  session, a site pass, always allow, a standing override). */
export const PAUSED_APPROVAL_ANSWERS: ReadonlySet<string> = new Set(['deny']);

/** Is this open ask an approval that waits for Resume? A `gateway.preflight` ask (one hold
 *  or a batch), whoever started its run, while paused. */
export const askWaitsForResume = (
  deps: PausedApprovalDeps,
  ask: Pick<PendingAsk, 'handler_kind'>,
): boolean => ask.handler_kind === PREFLIGHT_HANDLER_KIND && deps.isPaused();

/** `NotificationBlockDeps.refuseAnswer` for the server: an answer that would let a held
 *  action go ahead, refused while paused, so the ask stays open for Resume. */
export const createPausedAnswerRefusal = (deps: PausedApprovalDeps) =>
  async (
    ask: Pick<PendingAsk, 'handler_kind'>,
    option: string,
  ): Promise<{ code: string; message: string } | undefined> => {
    if (PAUSED_APPROVAL_ANSWERS.has(option)) return undefined;
    return askWaitsForResume(deps, ask)
      ? { code: PAUSED_APPROVAL_CODE, message: PAUSED_APPROVAL_REFUSAL }
      : undefined;
  };

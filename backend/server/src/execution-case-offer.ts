/** D-219 slice 6b-ii — ASK THE OWNER whether a turn is worth remembering.
 *
 *  The recording half has existed since D-214: `chat.execution.feedback` accepts
 *  `accepted` / `corrected` / `rejected` / `undone`, and NOTHING has ever offered
 *  the choice. After slices 2–4 the substrate admits only owner-attested or
 *  verified evidence, so without an offer the corpus stays empty by design. This
 *  is the missing half.
 *
 *  ⚠ Ready-to-wire, boot wiring deferred — the same shape as
 *  `pingReceptionInbox`, whose own note says "boot wiring DEFERRED to
 *  integration". The decision and the payload are testable here without standing
 *  up the notification stack.
 */

import { type ExecutionCaseFeedbackKind } from '@recued/contracts';

import {
  type CaseSourceObservation,
  executionCaseOfferableVerdicts,
} from './execution-case-core.js';

/** Raise one owner-facing ask. Structurally identical to `RaiseInboxPingAsk`. */
export type RaiseExecutionCaseOfferAsk = (
  message: { title?: string; text: string; link_url?: string },
  options: ReadonlyArray<{ id: string; label: string }>,
  handler: { kind: string; payload: Record<string, unknown> },
) => Promise<{ ask_id: string }>;

export const EXECUTION_CASE_OFFER_ASK_KIND = 'execution_case.offer';

/** What each verdict is called to the owner. Deliberately about the RESULT and
 *  not about the machinery: the owner is answering "did this go right", not
 *  "should a case be admitted". The substrate decides what that implies. */
const VERDICT_LABELS: Record<ExecutionCaseFeedbackKind, string> = {
  accepted: 'That was right',
  corrected: 'Not quite — I fixed it',
  rejected: 'That was wrong',
  undone: 'I undid it',
};

export interface ExecutionCaseOfferDecision {
  /** Whether to interrupt the owner at all. */
  ask: boolean;
  /** The verdicts that would genuinely file. Never contains one admission would
   *  refuse — offering a button that does nothing is the assurance-shaped
   *  non-assurance this substrate exists to avoid. */
  verdicts: ExecutionCaseFeedbackKind[];
  /** Why not, when `ask` is false. Present so a diagnostic can distinguish
   *  "nothing happened" from "already known" from "not worth remembering". */
  reason?: 'not_a_candidate' | 'already_covered';
}

/** Decide whether to ask the owner about one closed turn.
 *
 *  Two gates, both deterministic:
 *
 *    1. **Is it a candidate at all** — `executionCaseOfferableVerdicts`, which
 *       carries every exclusion D-219 accumulated: a breakage or denial is not a
 *       lesson, a single call is not a procedure, a repeated tool is a retry,
 *       and a turn whose outcome contradicts acceptance cannot be accepted.
 *
 *    2. **Is it already known** — if a case already covers this request shape,
 *       the owner answering again changes nothing, so asking is pure noise. This
 *       is the rate limiter, and it is principled rather than a cadence: the ask
 *       fires when there is something to learn, not on a timer.
 *
 *  ⚠ NOT rate-limited by time or count. Slices 7 and 8 cut candidacy from
 *  "nearly every turn" to ~13% of bench traffic, which is what made a per-turn
 *  ask defensible; adding a timer on top would hide the real signal — if this
 *  still proves noisy, the honest fix is a stricter candidacy rule, not a quota
 *  that silently drops turns the substrate said were worth asking about. */
export const decideExecutionCaseOffer = (
  observation: CaseSourceObservation,
  knownCaseKeys: ReadonlySet<string>,
  caseKeyOf: (observation: CaseSourceObservation) => string,
): ExecutionCaseOfferDecision => {
  const verdicts = executionCaseOfferableVerdicts(observation);
  if (verdicts.length === 0) {
    return { ask: false, verdicts: [], reason: 'not_a_candidate' };
  }
  if (knownCaseKeys.has(caseKeyOf(observation))) {
    return { ask: false, verdicts, reason: 'already_covered' };
  }
  return { ask: true, verdicts };
};

/** Raise the offer for a decided turn. Returns null when the decision said no,
 *  so a caller can hand every closed turn here without pre-filtering.
 *
 *  `turn_id` is carried because the ANSWER routes to `chat.execution.feedback`,
 *  whose contract is *"the caller names an anchored TURN, never a case"* — the
 *  rpc resolves the durable span root itself. The observation knows its session
 *  and its root but not the turn the offer was raised for, so the lifecycle
 *  supplies it. */
export const offerExecutionCase = async (
  raiseAsk: RaiseExecutionCaseOfferAsk,
  observation: CaseSourceObservation,
  decision: ExecutionCaseOfferDecision,
  turn_id: string,
): Promise<{ ask_id: string } | null> => {
  if (!decision.ask) return null;
  return raiseAsk(
    {
      title: 'Worth remembering?',
      // ⛔ The REQUEST is not quoted back. `root_request` is raw owner text and
      // this string reaches a notification channel that may be remote (Slack,
      // Telegram). The turn is identified by what it DID, which is a closed
      // vocabulary of tool names, not by what the owner typed.
      text:
        `Recued worked through ${observation.flow_pattern.tool_sequence.length}`
        + ' steps to answer that. Telling it how the result turned out lets it'
        + ' go straight there next time.',
    },
    decision.verdicts.map((verdict) => ({
      id: verdict,
      label: VERDICT_LABELS[verdict],
    })),
    {
      kind: EXECUTION_CASE_OFFER_ASK_KIND,
      // The answer routes to the EXISTING `chat.execution.feedback` rpc, which
      // has taken these kinds since D-214. Nothing new is recorded here.
      payload: {
        session_id: observation.session_id,
        turn_id,
        observation_id: observation.observation_id,
        root_request_id: observation.root_request_id,
      },
    },
  );
};

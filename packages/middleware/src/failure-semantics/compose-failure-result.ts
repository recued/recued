/** D-145 PB15 — `composeFailureResult` helper.
 *
 *  Per § B.15.11. The single helper every orchestration policy uses to
 *  build an `OrchestrationPolicyResult` for a halt path. Centralizes:
 *
 *    1. PlanStatus → FailureClass mapping (`failure-class-map.ts`)
 *    2. PlanStatus → user_response template (`user-response-templates.ts`)
 *    3. Optional per-incident `detail` clause appended to template
 *    4. Optional `override_user_response` for paths with dynamic copy
 *       (e.g. `cancelled_no_alternative` with the AI's conflict
 *       explanation appended)
 *
 *  Returns a pinned `{ status, failure_class, user_response }` triplet
 *  the orchestrator stamps on the plan. Caller never threads
 *  failure_class manually — the substrate decides per PlanStatus.
 *
 *  Spec: § B.15.11 + § C.3.3. */

import type { FailureClass, PlanStatus } from '@recued/contracts';

import { failureClassForStatus } from './failure-class-map.js';
import {
  USER_RESPONSE_TEMPLATES,
  type HaltPlanStatus,
} from './user-response-templates.js';

/** Output of `composeFailureResult`. Mirrors the orchestrator's
 *  `OrchestrationPolicyResult` shape so callers can return it directly
 *  from their policy callback. */
export interface ComposedFailureResult {
  readonly status: PlanStatus;
  readonly failure_class: FailureClass;
  readonly user_response: string;
}

export interface ComposeFailureInput {
  readonly status: HaltPlanStatus;
  /** Optional per-incident detail appended to the template with a
   *  single space separator. Never echoed verbatim from user content —
   *  callers MUST sanitize (closed-list discriminators / error codes /
   *  numeric values only). */
  readonly detail?: string;
  /** Substrate escape hatch for paths that need dynamic user_response
   *  copy (e.g. `cancelled_no_alternative` rendering the AI's conflict
   *  explanation). When set, fully overrides the template — caller is
   *  responsible for keeping the wording truthful + actionable per
   *  § B.15.11. */
  readonly override_user_response?: string;
}

/** Build the policy-result triplet for a halt path. */
export const composeFailureResult = (input: ComposeFailureInput): ComposedFailureResult => {
  const failure_class = failureClassForStatus(input.status);
  if (failure_class === undefined) {
    throw new Error(
      `composeFailureResult called with terminal-success status '${input.status}' — pass a halt status (cancelled_* etc.)`,
    );
  }

  let user_response: string;
  if (input.override_user_response !== undefined) {
    if (input.override_user_response.length === 0) {
      throw new Error(
        `composeFailureResult: override_user_response is the empty string — engine never silently fails per § B.15.11`,
      );
    }
    user_response = input.override_user_response;
  } else {
    const template = USER_RESPONSE_TEMPLATES[input.status];
    user_response =
      input.detail !== undefined && input.detail.length > 0
        ? `${template} ${input.detail}`
        : template;
  }

  return { status: input.status, failure_class, user_response };
};

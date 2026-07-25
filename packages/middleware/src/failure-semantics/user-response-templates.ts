/** D-145 PB15 — user_response copy templates per PlanStatus.
 *
 *  Per § B.15.1-§ B.15.10. Centralized so the engine speaks with one
 *  voice across every halt path. `composeFailureResult` reads from
 *  this map; callers never write user-facing copy inline.
 *
 *  Templates are *truthful + actionable* per § B.15.11 — every line
 *  tells the user what happened in plain language AND what they can do
 *  next. Engine never silently fails; the user always gets a sentence
 *  + an option.
 *
 *  Closed map keyed on PlanStatus (excluding terminal-success values).
 *  The ratchet test asserts every cancelled_* status has a template
 *  (drift surfaces at module import via the loader-time assertion).
 *
 *  Spec: § B.15.1-§ B.15.10 + § B.15.11. */

import { PLAN_STATUS_SET, type PlanStatus } from '@recued/contracts';

/** Closed-list union of statuses that carry a user_response template
 *  (every PlanStatus except `'completed'` + `'preview_no_op'`). */
export type HaltPlanStatus = Exclude<PlanStatus, 'completed' | 'preview_no_op'>;

/** Verbatim copy per § B.15. The wording is closed-list — drift
 *  requires substrate D-spec work. Callers MAY append a per-incident
 *  detail clause (e.g. capacity-gap remediation hint) — `composeFailure-
 *  Result` exposes a `detail?: string` arg for that path. */
export const USER_RESPONSE_TEMPLATES: { readonly [K in HaltPlanStatus]: string } =
  Object.freeze({
    cancelled_by_user:
      "I won't proceed without your approval. You can ask me again if you'd like.",
    cancelled_capacity_gap:
      'I started checking your data but lost a capability mid-run — your reply uses what I had before that. You can retry once the capability is back.',
    cancelled_si_conflict:
      "Two of your Standing Instructions for this kind of request conflict — I've added them to the Conflicts queue in Settings; you can adjust one to resolve.",
    cancelled_no_alternative:
      "I couldn't find a way to do this without changing what you asked for. You can relax a constraint or rephrase the request.",
    cancelled_privacy_violation:
      "I can't complete this request without exposing context I shouldn't — please rephrase or check your privacy settings.",
    cancelled_cost_ceiling:
      'This request was costlier than your budget allowed; I stopped before going over. You can adjust your AI budget in Settings or retry on a higher tier.',
    cancelled_malformed_ai:
      'The AI gave a response I could not parse twice in a row; I stopped rather than guess. You can retry or switch to a different tier.',
  });

/** Loader-time assertion: every halt-status has a non-empty template. */
{
  const want: HaltPlanStatus[] = Array.from(PLAN_STATUS_SET).filter(
    (s): s is HaltPlanStatus => s !== 'completed' && s !== 'preview_no_op',
  );
  for (const status of want) {
    const copy = USER_RESPONSE_TEMPLATES[status];
    if (typeof copy !== 'string' || copy.length === 0) {
      throw new Error(
        `USER_RESPONSE_TEMPLATES['${status}'] is missing or empty — every halt status must carry truthful + actionable copy per § B.15.11`,
      );
    }
  }
}

/** Returns the canonical user_response for a halt-status. Throws on
 *  terminal-success statuses (callers shouldn't ask for one). */
export const userResponseForStatus = (status: HaltPlanStatus): string => {
  const copy = USER_RESPONSE_TEMPLATES[status];
  if (copy === undefined) {
    throw new Error(`USER_RESPONSE_TEMPLATES has no entry for status '${status}'`);
  }
  return copy;
};

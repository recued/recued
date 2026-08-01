/** Agent-facing projection of a recipe-run result (D-157).
 *
 *  A run HELD at the preflight gate is a THIRD outcome — not success, not
 *  failure. `handleExecute` faithfully returns `success: false` for it (the run
 *  didn't complete), which is correct for the audit (the audit row maps it to
 *  the distinct `commit_status: 'awaiting_approval'`). But handing that bare
 *  `success: false` + empty steps/errors to an AI AGENT reads as a SILENT
 *  FAILURE — and a model (especially a weaker / local one) re-sends, spawning
 *  duplicate approval asks and looping the turn until it times out.
 *
 *  So every surface that runs a recipe ON BEHALF OF AN AGENT (the chat
 *  tool-loop AND the MCP `runRecipe` / direct-ingredient paths) projects a held
 *  result through here before showing it to the agent: a clean, self-describing
 *  `awaiting_approval` shape with NO contradictory `success: false`, plus
 *  guidance to NOT retry. Non-agent callers (manual / scheduled) keep the raw
 *  `ExecuteResponse`. */

import type { ContainerPickDetail, CreatePlanDetail, RunControlTermination } from '@recued/contracts';
import type { ExecuteResponse } from './types.js';

/** The agent-facing guidance for a held-for-approval run. Channel-agnostic —
 *  works for chat (a user to tell) and MCP (an agent acting for a user).
 *
 *  D-177 N.11 rule 5 slice E (5.g) — the final sentence is the
 *  capability-truthful posture + next-step affordance: the agent CANNOT
 *  approve/bypass (true by construction — no model-reachable mint surface
 *  exists, N.9), and "fewer interruptions" routes through the approval
 *  card's own bounded options (the N.5 `allow_session` answer), never
 *  through the agent. Keeps the three pinned invariants of the 2026-06-08
 *  log entry: expected-outcome framing, do-NOT-resend, tell-the-user. */
/** What the agent is told when a recipe's trigger condition was not met.
 *
 *  ⛔ THE LOAD-BEARING SENTENCE IS "NOTHING WAS CHECKED". Without it the model
 *  reports the empty output as an answer — measured: it told an owner their
 *  commitments were "clear" when the recipe never looked. Same posture as
 *  {@link HELD_FOR_APPROVAL_MESSAGE}: expected outcome, NOT a failure, do not
 *  retry, tell the user — plus the one thing that shape needs and the others do
 *  not, which is an explicit ban on reading the empty result as data.
 *
 *  ⚠ Model-facing string — see `chat-prompt-optimization-log.md`. */
export const TRIGGER_SKIPPED_MESSAGE =
  "This recipe's trigger condition was not met, so it did NOT run and produced "
  + 'no result. This is an expected outcome, not a failure. ⛔ The empty output '
  + 'does NOT mean there is nothing to report — NOTHING WAS CHECKED. Do not '
  + 'present it as an answer, do not say the user has none of whatever this '
  + 'recipe looks for, and do not retry: the trigger will skip again. Tell the '
  + 'user the recipe did not run because its trigger condition was not met.';

export const HELD_FOR_APPROVAL_MESSAGE =
  "This action is paused and is now queued for the user's approval before it can run. "
  + 'This is the expected, successful outcome for an action that sends a message or '
  + 'changes something outside Recued — it is NOT a failure. The action is already '
  + 'queued; do NOT call this tool again or resend it. Let the user know the action '
  + 'needs their approval before it can proceed. You do not have the ability to '
  + 'approve or bypass approvals yourself; if the user wants fewer approval '
  + 'interruptions, the approval card itself may offer bounded options (such as '
  + 'allowing repeats for this session).';

/** D-181 § 9 — agent-facing message for an OWNER-cancelled run (an
 *  `execution.kill` mid-flight or an `execution.cancel` of a queued call).
 *  Model-facing (tracked in the chat prompt-optimization log). Anti-loop,
 *  same posture as {@link HELD_FOR_APPROVAL_MESSAGE}: it names the outcome as
 *  a DELIBERATE user cancellation (NOT a failure), instructs do-NOT-retry,
 *  and routes the agent to resolve WITH the user (tell them + ask how to
 *  proceed) rather than re-issuing the same tool call. Echoes WHICH tool the
 *  agent ran (`toolLabel`) — never its args (no PII through the egress seam).
 *
 *  `cancelled_before_dispatch` vs `killed` only changes the leading clause
 *  ("before it started" vs "while it was running"); the posture is identical.
 *  Each interpolation is isolated to one clause (no `${a} ${b}` adjacency). */
export const runCancellationMessage = (
  termination: RunControlTermination,
  toolLabel: string,
): string => {
  const lead =
    termination === 'cancelled_before_dispatch'
      ? `The user cancelled the "${toolLabel}" run before it started executing.`
      : `The user stopped the "${toolLabel}" run while it was running.`;
  return [
    lead,
    'This is a deliberate cancellation by the user — NOT a failure, and NOT something to retry.',
    'Do NOT run it again. Tell the user the run was cancelled, and ask how they would like to proceed.',
  ].join(' ');
};

/** D-192 Slice 6b — agent-facing guidance for a create HELD behind an ambiguous
 *  vendor container (Linear `team`, an Asana `workspace`). Model-facing (tracked
 *  in the chat prompt-optimization log). Same anti-loop posture as
 *  {@link HELD_FOR_APPROVAL_MESSAGE}: names the outcome as the EXPECTED result for
 *  an ambiguous destination (NOT a failure), instructs do-NOT-retry, and routes
 *  the agent to the USER — the agent cannot make the choice itself.
 *
 *  TWO variants, keyed on whether a D-158 pick ask was actually RAISED (the
 *  response's `container_pick_required.ask_id` is present). A single "the choice
 *  has been raised, it will finish on its own" message would LIE to a contracted
 *  (external MCP) run — for which the owner ask is deliberately not raised (the
 *  answer would dispatch under owner authority) — telling it not to resend while
 *  nothing was asked, so the create stalls forever (codex MEDIUM).
 *
 *  S4 splits the UNRAISED case further on whether the ACTING contract may create a
 *  NEW container (`container_pick_required.can_create_new_container`, computed at the
 *  catch site): GRANTED → an ACTIONABLE recovery (name it in `container_names` or a
 *  create tool, then retry — the one third-state whose guidance is DO act, not
 *  "don't resend"); a create op exists but UNGRANTED → `no_new_project_permission`
 *  (pick-only, extend the contract); no create op at all → the plain pick-only copy.
 *  The RAISED variant is unchanged (the owner is already choosing). */

/** Ask WAS raised (owner/interactive run): the user will choose; the create
 *  re-runs off the pick. Do not resend. */
export const CONTAINER_PICK_RAISED_MESSAGE =
  'This create needs the user to choose which container it belongs to (a team, '
  + 'workspace, or project), and that choice has been raised to them. This is the '
  + 'expected outcome for a create whose destination is ambiguous — it is NOT a '
  + 'failure. The create is queued and will finish on its own once the user '
  + 'chooses; do NOT call this tool again or resend it. Let the user know they '
  + 'need to choose where it goes (the options are listed below). You cannot make '
  + 'that choice yourself.';

/** No ask was raised (this run cannot prompt the user for it — e.g. a contracted
 *  agent run). The create will keep stopping here until someone sets the
 *  container for this source, so DO tell the user + do NOT retry. */
export const CONTAINER_PICK_UNRAISED_MESSAGE =
  'This create needs a container chosen (a team, workspace, or project), and that '
  + 'choice could not be raised to the user from here. This is NOT a failure — the '
  + 'create simply cannot complete until someone picks the container for this '
  + 'source. Do NOT call this tool again; it will keep stopping here until the '
  + 'container is set. Tell the user which container is needed (the options are '
  + 'listed below) and ask them to choose it — for example by creating one item '
  + 'themselves, which saves that choice as the default for future creates. You '
  + 'cannot make this choice yourself.';

/** S4 — UNRAISED + the acting contract MAY create a new container
 *  (`can_create_new_container`). Unlike every other third-state message, this one
 *  is an ACTIONABLE recovery (DO act), not a do-not-resend hold: a grant-holder
 *  must not stall on a human. Offers the `container_names` fast-track (the create
 *  runs in one step), a separate create tool, or picking an existing container. The
 *  "no separate confirmation" line attributes the smooth path to the PERMISSION
 *  (the grant IS the standing approval — S2/S3), never to naming a container
 *  (naming only disambiguates; it never bypasses approval). */
export const CONTAINER_PICK_CREATE_GRANTED_MESSAGE =
  'This create needs a container (a project, team, or workspace) chosen, and none '
  + 'was set. This is NOT a failure — and you can resolve it yourself, because you '
  + 'have permission to create a new container. Do ONE of these: (1) re-run this '
  + 'create with the new container name in `container_names` (for example '
  + '`container_names: {"project": "Roadmap"}`) — the container is created and the '
  + 'item added together; (2) if you have a separate tool for creating the '
  + 'container, create it then re-run this create; or (3) use one of the existing '
  + 'containers listed below. Your permission covers this, so it will not stop for a '
  + 'separate human confirmation. Proceed with ONE path; do NOT repeat this exact '
  + 'call unchanged (it will only stop here again).';

/** S4 — UNRAISED + a container create op EXISTS but creating a new container would
 *  NOT complete this create under the acting contract (`no_new_project_permission`):
 *  the container create op OR the target write op is ungranted. Pick-only — the agent
 *  may reuse an existing container but must not attempt (or promise the user) a new
 *  one, since the fast-track admits the WHOLE plan (target write + container create)
 *  and would refuse. Worded to the OUTCOME (creating a new one won't work), not to
 *  which specific op is missing, so it stays honest for either gap. Same anti-loop
 *  posture as the other holds; the recovery is picking an existing container or
 *  telling the user the connection's permissions must be extended. */
export const CONTAINER_PICK_NO_CREATE_PERMISSION_MESSAGE =
  'This create needs a container (a project, team, or workspace) chosen, and none '
  + 'was set. Creating a NEW container will NOT let this create succeed here — the '
  + 'permission it would require is not granted — so you can only use one of the '
  + 'existing ones listed below. This is NOT a failure: pick one of the listed '
  + 'containers and re-run this create with it selected, or tell the user that this '
  + 'needs additional permissions granted on the connection. Do NOT try to create a '
  + 'new container (it will be refused) and do NOT repeat this exact call unchanged. '
  + 'You cannot grant yourself that permission.';

/** D-192 Slice 6c — create-plan confirm WAS raised (owner/interactive run): the
 *  user will confirm creating the new container; the create then finishes. Same
 *  anti-loop posture as the container pick. */
export const CREATE_PLAN_RAISED_MESSAGE =
  'This create needs to make a new container (a project) first, and a confirmation '
  + 'has been raised to the user. This is the expected outcome — it is NOT a '
  + 'failure. The create is queued and will finish on its own once the user '
  + 'confirms; do NOT call this tool again or resend it. Let the user know a new '
  + 'container needs to be created (it is named below). You cannot confirm it '
  + 'yourself.';

/** No confirm was raised (this run cannot prompt the user — e.g. a contracted
 *  agent run). The create can't complete until someone confirms creating the
 *  container, so DO tell the user + do NOT retry. */
export const CREATE_PLAN_UNRAISED_MESSAGE =
  'This create needs a new container (a project) created first, and that could not '
  + 'be confirmed from here. This is NOT a failure — the create cannot complete '
  + 'until someone confirms creating the container (named below) for this source. '
  + 'Do NOT call this tool again; it will keep stopping here. Tell the user a new '
  + 'container needs to be created and ask them to confirm it. You cannot confirm '
  + 'it yourself.';

/** The clean agent-facing shape for a held run. */
export interface AgentHeldRunResult {
  status: 'awaiting_approval';
  awaiting_approval: true;
  recipe_id: string;
  message: string;
}

/** D-192 Slice 6b — the clean agent-facing shape for a create held behind a
 *  container choice. Carries the choice set (labels) so the agent can relay the
 *  options to the user; no `success: false` reaches the agent (anti-loop). */
export interface AgentContainerPickRequiredResult {
  status: 'container_pick_required';
  container_pick_required: true;
  recipe_id: string;
  dependency_ref: string;
  options: ContainerPickDetail['options'];
  /** S4 — whether the acting contract may create a NEW container to resolve this
   *  (the actor-aware grant computed at the catch site). `true` ⇒ the message is an
   *  actionable create path; `false` ⇒ pick-only. */
  can_create_new_container: boolean;
  message: string;
}

/** D-192 Slice 6c — the clean agent-facing shape for a create held behind a
 *  create-plan confirm. Names the container(s) to create so the agent can relay
 *  the pending write to the user; no `success: false` reaches the agent. */
export interface AgentCreatePlanRequiredResult {
  status: 'create_plan_required';
  create_plan_required: true;
  recipe_id: string;
  containers: string[];
  message: string;
}

/** D-181 § 9 — the clean agent-facing shape for an OWNER-cancelled run. */
export interface AgentCancelledRunResult {
  status: 'cancelled';
  cancelled: true;
  recipe_id: string;
  message: string;
}

/** Project a recipe-run result into its agent-facing form.
 *
 *  Two outcomes get a clean self-describing third-state shape instead of a
 *  bare `success: false` (which an agent reads as a silent failure → re-sends
 *  → loops):
 *    - **owner-cancelled** (D-181 § 9, `run_terminated` set: an
 *      `execution.kill` mid-flight / `execution.cancel` of a queued call) →
 *      `{ status: 'cancelled', cancelled: true, recipe_id, message }`. Checked
 *      FIRST — a terminal owner action wins over `awaiting_approval`.
 *    - **held for approval** (`awaiting_approval === true`) →
 *      `{ status: 'awaiting_approval', awaiting_approval: true, recipe_id,
 *      message }`.
 *  Anything else passes through unchanged.
 *
 *  This is the projection the MCP `recued_runRecipe` / direct-ingredient paths
 *  surface verbatim (`text(...)`), so both legacy MCP and registry-routed MCP
 *  agents see a cancellation as a clear non-result. The chat tool-loop has its
 *  OWN cancellation branch (`wrapRecipeRunResult` → `{ ok: false, reason:
 *  'run_cancelled' }`) that short-circuits before this projection, so chat
 *  never double-handles it.
 *
 *  Accepts `unknown` (not just `ExecuteResponse`) so it can also guard the
 *  extension-delegated MCP path, whose result is opaquely typed — a non-object
 *  or a plain result is returned by reference, so it is always safe to wrap
 *  any agent-facing recipe result through here. Pure. */
export const projectRunResultForAgent = (result: unknown): unknown => {
  if (typeof result !== 'object' || result === null) return result;
  const terminated = (result as { run_terminated?: RunControlTermination }).run_terminated;
  if (terminated !== undefined) {
    const cancelled = result as ExecuteResponse;
    return {
      status: 'cancelled',
      cancelled: true,
      recipe_id: cancelled.recipe_id,
      message: runCancellationMessage(terminated, cancelled.recipe_id),
    } satisfies AgentCancelledRunResult;
  }
  // D-192 Slice 6b — a create held behind an ambiguous container is the SAME
  // clean third-state as a held-for-approval run (not success, not failure): a
  // D-158 pick ask was raised (owner run) or the choices are relayed (contracted
  // run). Project it to a self-describing shape carrying the options so the agent
  // tells the user which container to choose instead of retrying the bare
  // `success: false`. Checked before `awaiting_approval` — the two are mutually
  // exclusive on the wire, but a create-halt is the specific outcome to name.
  const containerPick = (result as { container_pick_required?: unknown }).container_pick_required;
  if (containerPick !== null && typeof containerPick === 'object') {
    const cp = result as ExecuteResponse;
    const detail = containerPick as ContainerPickDetail & {
      ask_id?: string;
      can_create_new_container?: boolean;
    };
    const canCreateNew = detail.can_create_new_container === true;
    // Honest per path. RAISED (owner run) → "the user will choose, it finishes on
    // its own". UNRAISED (contracted run / raise failed) splits on S4's permission
    // branch: GRANTED → an actionable recovery (create via `container_names` / a
    // create tool, then retry); a create op exists but UNGRANTED → pick-only,
    // `no_new_project_permission`; no create op at all → the plain pick-only copy.
    const message = detail.ask_id !== undefined
      ? CONTAINER_PICK_RAISED_MESSAGE
      : canCreateNew
        ? CONTAINER_PICK_CREATE_GRANTED_MESSAGE
        : detail.create_op !== undefined
          ? CONTAINER_PICK_NO_CREATE_PERMISSION_MESSAGE
          : CONTAINER_PICK_UNRAISED_MESSAGE;
    return {
      status: 'container_pick_required',
      container_pick_required: true,
      recipe_id: cp.recipe_id,
      dependency_ref: detail.dependency_ref,
      options: detail.options,
      can_create_new_container: canCreateNew,
      message,
    } satisfies AgentContainerPickRequiredResult;
  }
  // D-192 Slice 6c — a create held behind a create-plan confirm is the same clean
  // third-state: a confirm was raised (owner run) or the plan is relayed (contracted
  // run). Project it to a self-describing shape naming the container(s) so the agent
  // tells the user instead of retrying the bare `success: false`.
  const createPlan = (result as { create_plan_required?: unknown }).create_plan_required;
  if (createPlan !== null && typeof createPlan === 'object') {
    const cp = result as ExecuteResponse;
    const detail = createPlan as CreatePlanDetail & { ask_id?: string };
    const message = detail.ask_id !== undefined
      ? CREATE_PLAN_RAISED_MESSAGE
      : CREATE_PLAN_UNRAISED_MESSAGE;
    return {
      status: 'create_plan_required',
      create_plan_required: true,
      recipe_id: cp.recipe_id,
      containers: detail.plans.map((p) => `${p.ref} '${p.name}'`),
      message,
    } satisfies AgentCreatePlanRequiredResult;
  }
  // ⛔⛔ A SKIPPED TRIGGER IS NOT AN EMPTY ANSWER, and this one reached the owner.
  //
  // `ExecuteResponse.success` is TRUE when `trigger_skipped` is true — the
  // engine returns early at `execute.ts` before any step runs, so a silent skip
  // is deliberately not an error. `packages/engine/src/types.ts` states the
  // consequence outright: "callers that distinguish outcomes must read
  // `trigger_skipped` FIRST, then fall back to `success`". The agent is such a
  // caller and this projection did not.
  //
  // Observed live: `open-commitments` returned
  // `{ success: true, output: { sidebar: [] }, errors: [], trigger_skipped: true }`
  // and the model told the owner *"Your open commitments view is clear. There
  // are no outstanding commitments or open loops at the moment."* Nothing was
  // checked. The empty output means NOTHING WAS PRODUCED, not that nothing
  // exists — and a flag beside an empty collection is not a sentence, so the
  // model supplied one. Same class as the 2026-06-08 `success: false` +
  // `steps: []` + `errors: []` loop, in the opposite direction: there a false
  // flag read as failure, here a true flag plus emptiness reads as a confident
  // "nothing to report".
  //
  // ⚠ Checked BEFORE `awaiting_approval` for the same reason the container-pick
  // branch is: they are mutually exclusive on the wire, and a skip is the
  // specific outcome to name.
  if ((result as { trigger_skipped?: unknown }).trigger_skipped === true) {
    const skipped = result as ExecuteResponse;
    return {
      status: 'trigger_skipped',
      trigger_skipped: true,
      recipe_id: skipped.recipe_id,
      message: TRIGGER_SKIPPED_MESSAGE,
    };
  }
  if ((result as { awaiting_approval?: unknown }).awaiting_approval !== true) {
    return result;
  }
  const held = result as ExecuteResponse;
  return {
    status: 'awaiting_approval',
    awaiting_approval: true,
    recipe_id: held.recipe_id,
    message: HELD_FOR_APPROVAL_MESSAGE,
  };
};

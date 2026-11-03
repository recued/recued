/** D-336 slice E — what the owner may change on a held write's card while approving it, and
 *  the change itself: D-137 §A.11's "Mary confirms / edits / cancels", built for a held
 *  `memory.write`'s two arguments.
 *
 *  - `claim`, the relationship its summary says (D-336 §3.5, §3.6). On the card the owner may
 *    link a name to a contact or a thing they own, correct the relation or write their own,
 *    give a save with none a relationship, or clear it.
 *  - `summary`, the words recall returns. A relationship corrected beside the agent's words
 *    still had recall tell the fact as the agent wrote it, so the owner corrects both
 *    (audit 2026-10-31). Never empty: a save with nothing to remember is declined instead.
 *
 *  - **Offered only where it is applied.** The proposal names what may change
 *    (`ChatPlanProposal.editable_args`). An older server sends none, so the card approves as
 *    shown there: that server would ignore the change and run the original.
 *  - **The owner's claim, by the owner's rules.** It is checked as their own forms' claims are
 *    (`ownerClaim`): a relation in their own words is allowed, a listed relation's ends are
 *    checked, and a linked contact or thing must still be there. Refused, nothing changes.
 *  - **Bound to what runs.** It is written onto the hold's checkpoint (`arg_overrides`,
 *    through its one narrow writer) and into the proposal's arguments before the ask is
 *    answered, so the resume runs it and the card shows it. The resume applies only these
 *    keys, and tells the tool they are the owner's (`ChatDispatchContext.owner_edits`).
 *  - **No standing trust.** An approval the owner had to change says the proposal was not
 *    right, so it is no evidence for a standing write rule (D-177 N.14's ruling).
 *
 *  ⚠ The ask is answered just after the change is written. An answer from another channel
 *  landing in between runs the change too; both answers are the owner's. Two cards answering
 *  are one at a time (`createHeldPlanAskAnswerer`, audit 2026-11-01): this runs inside that
 *  step, so what it takes back is what it read, and a second card finds the ask answered. */

import { RpcError, type ChatPlanProposal } from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import type { CheckpointStore } from '@recued/storage';

import { ownerClaim, type ClaimRecordLookups } from './memory-claim.js';

const EDITABLE: Readonly<Record<string, readonly string[]>> = {
  'memory.write': ['claim', 'summary'],
};

/** The arguments of a held call of `tool` the owner may change while approving it. */
export const heldPlanEditableArgs = (tool: string): readonly string[] | undefined =>
  Object.hasOwn(EDITABLE, tool) ? EDITABLE[tool] : undefined;

/** The owner's changes a held call of `tool` takes, read off its checkpoint's
 *  `arg_overrides`: only the keys the tool takes a change to. `undefined` when none. */
export const ownerEditsFor = (tool: string, overrides: unknown): Record<string, unknown> | undefined => {
  const editable = heldPlanEditableArgs(tool);
  if (editable === undefined || overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return undefined;
  }
  const edits = Object.fromEntries(
    Object.entries(overrides as Record<string, unknown>).filter(([key]) => editable.includes(key)),
  );
  return Object.keys(edits).length > 0 ? edits : undefined;
};

/** A change to a held proposal: what the checkpoint takes (`overrides`) and the proposal's
 *  arguments with it (`args`), which are what then runs. */
export interface HeldPlanEdit {
  readonly overrides: Record<string, unknown>;
  readonly args: Record<string, unknown>;
}

/** Read `chat.plan.approve`'s `edited_args` for `plan`. `undefined` when it changes nothing.
 *  Throws `bad_request` for an argument the plan does not take a change to, an empty summary,
 *  or a claim the owner's rules refuse, in their words. */
export const readHeldPlanEdit = (
  plan: ChatPlanProposal,
  raw: unknown,
  lookups: ClaimRecordLookups,
): HeldPlanEdit | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError('bad_request', 'chat.plan.approve: edited_args must be an object', 400);
  }
  const edited = raw as Record<string, unknown>;
  const keys = Object.keys(edited);
  if (keys.length === 0) return undefined;
  const editable = plan.hold === undefined ? undefined : heldPlanEditableArgs(plan.tool);
  const refused = keys.find((key) => editable?.includes(key) !== true);
  if (refused !== undefined) {
    throw new RpcError('bad_request', `chat.plan.approve: '${refused}' cannot be changed while approving this`, 400);
  }
  if (plan.args === null || typeof plan.args !== 'object' || Array.isArray(plan.args)) {
    throw new RpcError('bad_request', 'chat.plan.approve: this approval has no arguments to change', 400);
  }
  const args: Record<string, unknown> = { ...(plan.args as Record<string, unknown>) };
  const overrides: Record<string, unknown> = {};
  // `memory.write`'s are the only arguments any tool takes a change to today.
  if (Object.hasOwn(edited, 'summary')) {
    const summary = typeof edited.summary === 'string' ? edited.summary.trim() : '';
    if (summary.length === 0) throw new RpcError('bad_request', 'Write what to remember, or say no to saving it.', 400);
    args.summary = summary;
    overrides.summary = summary;
  }
  if (edited.claim === null) {
    delete args.claim;
    overrides.claim = null;
  } else if (edited.claim !== undefined) {
    const checked = ownerClaim(edited.claim, lookups);
    if (!checked.ok) throw new RpcError('bad_request', checked.message, 400);
    args.claim = checked.value;
    overrides.claim = checked.value;
  }
  return planApproval.computePlanArgsHash(args) === plan.args_hash ? undefined : { overrides, args };
};

/** What the card says when its hold was answered before the owner's change could be made. */
const ANSWERED_ALREADY = 'This was answered already, so your change was not made.';

/** The value a held call runs for one of its arguments, compared as the plan's hash compares
 *  arguments: a cleared claim (`null`) and none are the same. */
const sameValue = (a: unknown, b: unknown): boolean =>
  planApproval.computePlanArgsHash(a ?? null) === planApproval.computePlanArgsHash(b ?? null);

/** Audit 2026-11-01 (second) — before the yes, what the hold runs for the arguments the owner
 *  may change must be what the card shows. A change whose proposal write failed, and whose
 *  taking back failed too, would otherwise run under a card that never showed it. The hold is
 *  set back to the card: the card's arguments are what the owner is approving. */
const alignHeld = async (
  deps: Pick<HeldPlanEditorDeps, 'checkpointStore' | 'plans'>,
  plan: ChatPlanProposal,
  run_id: string,
): Promise<ChatPlanProposal> => {
  const editable = heldPlanEditableArgs(plan.tool);
  if (editable === undefined) return plan;
  const checkpoint = (await deps.checkpointStore.listByRun(run_id))
    .find((candidate) => candidate.raw_op?.tier1_tool === plan.tool);
  if (checkpoint?.raw_op === undefined) return plan;
  const current = (await deps.plans.get?.(plan.plan_id)) ?? plan;
  const shown = (current.args ?? {}) as Record<string, unknown>;
  const held = checkpoint.raw_op.op_args;
  const edits = ownerEditsFor(plan.tool, checkpoint.arg_overrides) ?? {};
  const runs = (key: string): unknown => (Object.hasOwn(edits, key) ? edits[key] : held[key]);
  if (editable.every((key) => sameValue(runs(key), shown[key]))) return current;
  const arg_overrides = Object.fromEntries(editable
    .filter((key) => !sameValue(held[key], shown[key]))
    .map((key) => [key, shown[key] ?? null]));
  try {
    await deps.checkpointStore.setArgOverrides(checkpoint.checkpoint_id, { arg_overrides });
  } catch {
    // Claimed meanwhile: it was answered elsewhere, and ran as it was.
    throw new RpcError('conflict', ANSWERED_ALREADY, 409);
  }
  return current;
};

interface HeldPlanEditorDeps {
  readonly checkpointStore: Pick<CheckpointStore, 'listByRun' | 'setArgOverrides'>;
  readonly plans: Pick<planApproval.PlanApprovalStore, 'editHeld'> & Partial<Pick<planApproval.PlanApprovalStore, 'get'>>;
}

/** `ChatRpcDeps.editHeldPlan` over the checkpoint store and the plan store. The change goes
 *  onto the hold's checkpoint first, as what runs, then into the proposal, as what the card
 *  shows. A hold already claimed (answered and run) refuses it; when the proposal could not
 *  take it, or its write failed, the checkpoint's change is taken back (audit 2026-11-01).
 *  With no change, it checks the hold runs what the card shows (`alignHeld`). */
export const createHeldPlanEditor = (deps: HeldPlanEditorDeps) => async (
  plan: ChatPlanProposal,
  edit?: HeldPlanEdit,
): Promise<ChatPlanProposal> => {
  const run_id = plan.hold?.run_id;
  if (edit === undefined) return run_id === undefined ? plan : alignHeld(deps, plan, run_id);
  if (run_id === undefined || deps.plans.editHeld === undefined) {
    throw new RpcError('not_configured', 'chat.plan.approve: this approval cannot take a change here', 501);
  }
  const checkpoint = (await deps.checkpointStore.listByRun(run_id))
    .find((candidate) => candidate.raw_op?.tier1_tool === plan.tool);
  if (checkpoint === undefined) throw new RpcError('conflict', ANSWERED_ALREADY, 409);
  try {
    await deps.checkpointStore.setArgOverrides(checkpoint.checkpoint_id, { arg_overrides: edit.overrides });
  } catch {
    // Claimed between the read and the write: it was answered, and ran as it was.
    throw new RpcError('conflict', ANSWERED_ALREADY, 409);
  }
  const takeBack = async (): Promise<void> => {
    try {
      await deps.checkpointStore.setArgOverrides(checkpoint.checkpoint_id, { arg_overrides: checkpoint.arg_overrides ?? {} });
    } catch {
      // Claimed meanwhile: nothing is left to take back. Failed: the next yes sets the hold
      // back to the card (`alignHeld`).
    }
  };
  let edited: ChatPlanProposal | undefined;
  try {
    edited = await deps.plans.editHeld(plan.plan_id, run_id, edit.args);
  } catch (error) {
    await takeBack();
    throw error;
  }
  if (edited === undefined) {
    await takeBack();
    throw new RpcError('conflict', ANSWERED_ALREADY, 409);
  }
  return edited;
};

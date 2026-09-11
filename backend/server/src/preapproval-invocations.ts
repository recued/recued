/** Shared D-261 identity and selection. Transport resolvers describe calls;
 * this module owns the single canonical representation used by every gate. */
import { createHash } from 'node:crypto';
import {
  PREAPPROVAL_LIMITS, RpcError, executionSourceContractId, parsePreapprovalHash,
  parsePreapprovalId, parsePreparePreapproval, parsePreapprovalJson, parseMailDraftContent, parseMailDraftId,
  type PreapprovalInvocationPath,
} from '@recued/contracts';
import { canonicalJSONStringifyStrict } from '@recued/crypto';
import type { PreparedFutureExecution, PreparedInvocation, PreapprovalOrigin } from './preapproval-model.js';

export const preapprovalHash = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalJSONStringifyStrict(value)).digest('hex')}`;

export const preapprovalPathKey = (path: PreapprovalInvocationPath): string => {
  if (path.length === 0 || path.length > 64) throw new RpcError('preapproval_unresolved', 'Invalid invocation path.', 400);
  return canonicalJSONStringifyStrict(path);
};

/** Tool-call/turn/socket IDs remain audit data, not the idempotency scope. */
export const preapprovalOriginKey = (origin: PreapprovalOrigin): string => {
  const sourceContract = executionSourceContractId(origin.source);
  if ((origin.mode === 'contract' && sourceContract !== origin.contract_id)
    || (origin.mode === 'owner' && sourceContract !== undefined)) {
    throw new RpcError('preapproval_authority_changed', 'Pre-approval origin does not match its authenticated source.', 403);
  }
  return preapprovalHash({
    mode: origin.mode,
    principal: origin.mode === 'contract' ? origin.contract_id : origin.owner_id,
    credential: origin.credential_id,
    door: origin.source.channel,
    entry: origin.entry,
  });
};

export const preapprovalEffectHash = (member: Omit<PreparedInvocation, 'effect_hash' | 'review'>): string =>
  preapprovalHash({
    op_id: member.op_id,
    ingredient_slug: member.ingredient_slug,
    family: member.family,
    identity_version: member.identity_version,
    definition_hash: member.definition_hash,
    binding_hash: member.binding_hash,
    ...(member.dispatch_snapshot !== undefined ? { dispatch_snapshot: member.dispatch_snapshot } : {}),
    arguments_hash: member.arguments_hash,
    output: member.output,
    condition_hash: member.condition_hash,
    resources: member.resources,
    connection_id: member.connection_id,
    account_id: member.account_id,
  });

/** ⚠ `always` AND `destructive` ARE ELIGIBLE — reversed 2026-09-06, and the rule
 *  it replaces was deliberate, so the reasoning is kept here rather than in a
 *  commit message. Spec §2.3 read: "`always`, `destructive` … remain ineligible
 *  … D-261 does not become a new escape from `always`."
 *
 *  🔑 WHAT `always` ACTUALLY PROTECTS IS DELEGATED AUTHORITY. It exists so a
 *  STANDING or SESSION grant — "this contract may do X whenever it likes" —
 *  can never bypass the owner. D-261 is not that: the owner personally reads
 *  the exact frozen effect and personally decides it. Moving that decision
 *  earlier does not weaken it, and refusing it did not make the destructive
 *  call safer — it made the scheduled run stop at 3am and wait for someone.
 *  D-177's own delegation semantics are untouched; nothing here is consulted
 *  by the session-grant path.
 *
 *  ⛔ `pre_lift_approval === null` STAYS INELIGIBLE, and is a different thing
 *  entirely. `always` is a known intent we can reason about; null is MISSING
 *  PROVENANCE — an operation whose approval intent nobody declared. Reasoning
 *  about an intent we never read is how a bypass gets built by accident.
 *
 *  ⚠ THE REVIEW MUST NOW SHOW `risk`. While destructive calls were excluded,
 *  omitting the tier from the owner's review only cost convenience; now it
 *  would hide the single fact that most changes the decision. See
 *  `PreapprovalMemberReview.risk`. */
export const isPreapprovalMemberEligible = (member: PreparedInvocation): boolean =>
  member.review.eligible && member.pre_lift_approval !== null
  && member.identity_version === 1;

const invalidGraph = (): never => {
  throw new RpcError('preapproval_unresolved', 'The execution has no valid bounded invocation graph.', 400);
};

/** Validate even host-produced plans at the persistence boundary. A broken
 * dependency resolver must never turn missing inventory into Complete. */
export const validatePreparedFutureExecution = (plan: PreparedFutureExecution): void => {
  if (plan.schema_version !== 1) return invalidGraph();
  parsePreparePreapproval(plan.request);
  preapprovalOriginKey(plan.origin);
  if (plan.draft_snapshot) {
    const draft = plan.draft_snapshot;
    parseMailDraftId(draft.draft_id); parseMailDraftContent(draft.content);
    if (plan.request.subject.kind !== 'mail_draft' || draft.draft_id !== plan.request.subject.draft_id
      || draft.revision !== plan.request.subject.draft_revision || !draft.incarnation) return invalidGraph();
  }
  if (plan.recipe_snapshots.length === 0) return invalidGraph();
  const snapshotPaths = new Set<string>();
  for (const snapshot of plan.recipe_snapshots) {
    const key = preapprovalPathKey(snapshot.invocation_path);
    const entry = snapshot.invocation_path.at(-1);
    if (snapshotPaths.has(key) || entry?.kind !== 'recipe'
      || entry.recipe_id !== snapshot.recipe_id || entry.publisher_id !== snapshot.publisher_id
      || entry.definition_hash !== snapshot.definition_hash
      || snapshot.definition.recipe_id !== snapshot.recipe_id
      || preapprovalHash(parsePreapprovalJson(snapshot.definition)) !== snapshot.dispatch_hash) return invalidGraph();
    parsePreapprovalJson(snapshot.effective_config);
    parsePreapprovalHash(snapshot.definition_hash);
    snapshotPaths.add(key);
  }
  const root = plan.recipe_snapshots[0]!;
  const targetGrant = plan.origin.target_recipe_grant_key;
  if (targetGrant !== undefined && targetGrant !== null
    && targetGrant !== `${root.publisher_id}/${root.recipe_id}`
    && targetGrant !== `recipe.${root.publisher_id}/${root.recipe_id}`) return invalidGraph();
  if (root.invocation_path.length !== 1 || root.recipe_id !== plan.recipe.recipe_id
    || root.publisher_id !== plan.recipe.publisher_id || root.definition_hash !== plan.recipe.definition_hash) return invalidGraph();
  const dependencyKeys = new Set<string>();
  for (const pin of plan.dependencies) {
    const key = preapprovalHash([pin.kind, pin.key, pin.incarnation]);
    if (dependencyKeys.has(key) || !pin.kind || !pin.key || !pin.incarnation
      || !Number.isSafeInteger(pin.revision) || pin.revision < 0
      || (pin.until_phase !== 'decision' && pin.until_phase !== 'terminal')) return invalidGraph();
    parsePreapprovalHash(pin.content_hash);
    dependencyKeys.add(key);
  }
  if (plan.members.length + plan.uncovered.length > PREAPPROVAL_LIMITS.candidate_calls
    || Buffer.byteLength(canonicalJSONStringifyStrict(plan), 'utf8') > PREAPPROVAL_LIMITS.plan_bytes) {
    throw new RpcError('preapproval_limit_exceeded', 'The execution exceeds the pre-approval review limit.', 400);
  }
  const members = new Map<string, PreparedInvocation>();
  const paths = new Set<string>();
  for (const member of plan.members) {
    parsePreapprovalId(member.member_id, 'pam');
    const path = preapprovalPathKey(member.invocation_path);
    if (members.has(member.member_id) || paths.has(path)) return invalidGraph();
    const lastRecipeIndex = member.invocation_path.map(segment => segment.kind === 'recipe').lastIndexOf(true);
    if (lastRecipeIndex < 0 || !snapshotPaths.has(preapprovalPathKey(member.invocation_path.slice(0, lastRecipeIndex + 1)))) return invalidGraph();
    members.set(member.member_id, member);
    paths.add(path);
    for (const hash of [member.definition_hash, member.binding_hash, member.arguments_hash,
      member.effect_hash, member.condition_hash]) parsePreapprovalHash(hash);
    if (member.arguments_hash !== preapprovalHash(parsePreapprovalJson(member.input))
      || member.arguments_hash !== preapprovalHash(parsePreapprovalJson(member.review.arguments))
      || preapprovalHash(member.output) !== preapprovalHash(member.review.output)
      || member.connection_id !== member.review.connection_id || member.account_id !== member.review.account_id
      || preapprovalHash(member.resources) !== preapprovalHash(member.review.resources)
      || Object.values(member.output).some(value => typeof value !== 'string')
      || member.effect_hash !== preapprovalEffectHash(member)
      || member.review.member_id !== member.member_id
      || member.review.op_id !== member.op_id
      || member.review.family !== member.family
      || member.review.parent_member_id !== member.parent_member_id
      || preapprovalPathKey(member.review.invocation_path) !== path
      || preapprovalHash(member.review.required_child_ids) !== preapprovalHash(member.required_child_ids)
      || new Set(member.required_child_ids).size !== member.required_child_ids.length
      || new Set(member.predecessor_member_ids).size !== member.predecessor_member_ids.length) return invalidGraph();
  }
  for (const call of plan.uncovered) {
    const path = preapprovalPathKey(call.invocation_path);
    if (paths.has(path)) return invalidGraph();
    paths.add(path);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (member: PreparedInvocation): void => {
    if (visiting.has(member.member_id)) return invalidGraph();
    if (visited.has(member.member_id)) return;
    visiting.add(member.member_id);
    if (member.parent_member_id !== null) {
      const parent = members.get(member.parent_member_id);
      if (!parent?.required_child_ids.includes(member.member_id)) return invalidGraph();
    }
    for (const id of member.required_child_ids) {
      const child = members.get(id);
      if (!child || child.parent_member_id !== member.member_id) return invalidGraph();
      if (child.invocation_path.length <= member.invocation_path.length
        || preapprovalPathKey(child.invocation_path.slice(0, member.invocation_path.length))
          !== preapprovalPathKey(member.invocation_path)) return invalidGraph();
      visit(child);
    }
    visiting.delete(member.member_id);
    visited.add(member.member_id);
  };
  for (const member of plan.members) visit(member);
  visiting.clear(); visited.clear();
  const visitOrder = (member: PreparedInvocation): void => {
    if (visiting.has(member.member_id)) return invalidGraph();
    if (visited.has(member.member_id)) return;
    visiting.add(member.member_id);
    for (const id of member.predecessor_member_ids) {
      const predecessor = members.get(id);
      if (!predecessor || predecessor.parent_member_id !== member.parent_member_id) return invalidGraph();
      visitOrder(predecessor);
    }
    visiting.delete(member.member_id); visited.add(member.member_id);
  };
  for (const member of plan.members) visitOrder(member);
};

/** Default to all eligible compound calls. Explicit selections expand only
 * required children and are returned in reviewed engine order. */
export const selectPreapprovalMembers = (
  plan: PreparedFutureExecution, requested?: readonly string[],
): string[] => {
  const members = new Map(plan.members.map(member => [member.member_id, member]));
  const canSelect = (id: string, ancestors = new Set<string>()): boolean => {
    const member = members.get(id);
    if (!member || ancestors.has(id) || !isPreapprovalMemberEligible(member)) return false;
    return member.required_child_ids.every(child => canSelect(child, new Set([...ancestors, id])));
  };
  const roots = requested ?? plan.members.filter(member => member.parent_member_id === null
    && canSelect(member.member_id)).map(member => member.member_id);
  const selected = new Set<string>();
  const add = (id: string): void => {
    if (!canSelect(id)) throw new RpcError('preapproval_unresolved', 'A selected operation or required child cannot be pre-approved.', 400);
    if (selected.has(id)) return;
    selected.add(id);
    for (const child of members.get(id)!.required_child_ids) add(child);
  };
  for (const id of roots) add(id);
  for (const id of selected) {
    const parent = members.get(id)!.parent_member_id;
    if (parent !== null && !selected.has(parent)) {
      throw new RpcError('preapproval_unresolved', 'A required child can only be approved with its parent operation.', 400);
    }
  }
  if (selected.size === 0) {
    const reason = plan.members.find(member => member.review.reason)?.review.reason ?? plan.uncovered[0]?.reason;
    throw new RpcError('preapproval_no_eligible_members',
      `No complete operation is eligible for pre-approval.${reason ? ` ${reason.slice(0, 500)}` : ''}`, 400);
  }
  return plan.members.filter(member => selected.has(member.member_id)).map(member => member.member_id);
};

export const preapprovalReviewDigest = (input: {
  proposal_id: string; future_execution_ref: string; revision: number;
  snapshot_hash: string; selected_member_ids: string[];
}): string => preapprovalHash(input);

/** Find by path before op ID, so an op substitution never falls through to
 * ordinary approval as though the changed call had been left uncovered. */
export const classifyPreapprovalInvocation = (
  plan: PreparedFutureExecution, path: PreapprovalInvocationPath, selected: readonly string[],
): { kind: 'covered'; member: PreparedInvocation } | { kind: 'uncovered' } => {
  const key = preapprovalPathKey(path);
  const member = plan.members.find(candidate => preapprovalPathKey(candidate.invocation_path) === key);
  if (member) return selected.includes(member.member_id) ? { kind: 'covered', member } : { kind: 'uncovered' };
  for (const call of plan.uncovered) {
    if (preapprovalPathKey(call.invocation_path) === key || (call.subtree
      && call.invocation_path.length < path.length
      && canonicalJSONStringifyStrict(path.slice(0, call.invocation_path.length)) === preapprovalPathKey(call.invocation_path))) {
      return { kind: 'uncovered' };
    }
  }
  throw new RpcError('preapproval_stale', 'An unreviewed operation appeared in the prepared execution.', 409);
};

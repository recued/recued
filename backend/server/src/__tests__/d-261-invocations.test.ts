import { describe, expect, it } from 'vitest';
import {
  classifyPreapprovalInvocation, selectPreapprovalMembers,
  validatePreparedFutureExecution, preapprovalEffectHash,
} from '../preapproval-invocations.js';
import { compoundPlan, memberPath, preparedMember, preparedPlan } from './d-261-fixtures.js';

describe('D-261 shared invocation graph', () => {
  it('selects required attachment reads in the same group and rejects an orphan read', () => {
    const plan = compoundPlan();
    validatePreparedFutureExecution(plan);
    expect(selectPreapprovalMembers(plan, [plan.members[0]!.member_id])).toEqual(plan.members.map(m => m.member_id));
    expect(() => selectPreapprovalMembers(plan, [plan.members[1]!.member_id])).toThrow(/parent/);
  });
  it('does not offer a compound operation whose child requires a fresh decision', () => {
    const plan = compoundPlan();
    // ⚠ VEHICLE CHANGED, PROPERTY UNCHANGED. This used `'always'`, which became
    // eligible on 2026-09-06 — the owner may now decide one in advance. The
    // property under test was never about `always`; it is that an ineligible
    // CHILD makes its parent unofferable. A null approval intent is the
    // ineligibility that remains: nobody declared it, so nobody can reason
    // about it. Had this been left as-is it would have passed vacuously.
    plan.members[1]!.pre_lift_approval = null;
    expect(() => selectPreapprovalMembers(plan)).toThrow(/No complete operation/);
    expect(() => selectPreapprovalMembers(plan, [plan.members[0]!.member_id])).toThrow(/required child/);
  });
  it('preserves duplicate payload occurrences and independent operation selections', () => {
    const first = preparedMember({ invocation_path: memberPath('send', 0) });
    const second = preparedMember({ invocation_path: memberPath('send', 1) });
    expect(first.effect_hash).toBe(second.effect_hash);
    const plan = preparedPlan([first, second]);
    validatePreparedFutureExecution(plan);
    expect(selectPreapprovalMembers(plan)).toHaveLength(2);
    expect(selectPreapprovalMembers(plan, [first.member_id])).toEqual([first.member_id]);
  });
  it('rejects missing child inventory, cycles, and drift between review and execution', () => {
    const plan = compoundPlan();
    expect(() => validatePreparedFutureExecution({ ...plan, members: [plan.members[0]!] })).toThrow();
    const cycle = compoundPlan();
    cycle.members[1]!.required_child_ids.push(cycle.members[0]!.member_id);
    cycle.members[0]!.parent_member_id = cycle.members[1]!.member_id;
    cycle.members[0]!.review.parent_member_id = cycle.members[1]!.member_id;
    expect(() => validatePreparedFutureExecution(cycle)).toThrow();
    const drift = compoundPlan(); drift.members[0]!.input.to = ['somebody-else@example.com'];
    expect(() => validatePreparedFutureExecution(drift)).toThrow();
  });
  it('uses the same eligibility and identity protocol for every dispatch family', () => {
    const families = ['kernel', 'http', 'graphql', 'mcp', 'cli', 'dom', 'ai'] as const;
    const members = families.map(family => preparedMember({ family, invocation_path: memberPath(family), op_id: `provider.${family}.op` }));
    const plan = preparedPlan(members);
    validatePreparedFutureExecution(plan);
    expect(selectPreapprovalMembers(plan)).toHaveLength(families.length);
    for (const member of members) expect(preapprovalEffectHash({ ...member, binding_hash: members[0]!.definition_hash })).not.toBe(member.effect_hash);
  });
  it('classifies by the planned path before allowing any ordinary uncovered path', () => {
    const plan = preparedPlan();
    const selected = selectPreapprovalMembers(plan);
    expect(classifyPreapprovalInvocation(plan, plan.members[0]!.invocation_path, selected).kind).toBe('covered');
    expect(() => classifyPreapprovalInvocation(plan, memberPath('injected-call'), selected)).toThrow(/unreviewed/);
    plan.uncovered.push({ invocation_path: memberPath('dynamic'), op_id: null, subtree: true, reason: 'Runtime model output' });
    expect(classifyPreapprovalInvocation(plan, [...memberPath('dynamic'), { kind: 'iteration', index: 4 }], selected).kind).toBe('uncovered');
  });
});

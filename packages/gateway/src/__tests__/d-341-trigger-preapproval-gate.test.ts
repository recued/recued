/** D-341 slice B1 — a trigger's standing pre-approval, at the commit gateway.
 *
 *  A held write asks the host for one only for the hold the run's own ceiling makes (no review
 *  lift), where the owner's policy could waive the ask (`never` or `ask`), below destructive, after
 *  no D-177 grant matched. The host is given the call's slug, the engine's step id and the risk,
 *  never its arguments: the pre-approval names writes, not values. One that admits lets the write
 *  through, and its commit names it; anything else asks. The catalog gate's seam is the engine's
 *  `d-341-trigger-preapproval-catalog-gate.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import {
  PreflightRequiredSignal,
  type AdmissionDecision,
  type Commit,
  type ExecutionSource,
} from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';

import {
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type GatewayInner,
  type SessionGrantHooks,
  type TriggerPreapprovalHooks,
} from '../commit-gateway.js';

const webhook: ExecutionSource = {
  channel: 'webhook', actor: 'anonymous', vendor: 'generic', webhook_secret_id: 'whi_1', contract_id: 'door-1',
};

// The hold a webhook's or a schedule's run gets for a write: its ceiling's, with no review lift.
const ask = (overrides: Partial<Extract<AdmissionDecision, { verdict: 'ask' }>> = {}): AdmissionDecision => ({
  verdict: 'ask',
  risk_tier: 'write',
  detail: 'This run sits at read; saving needs your approval.',
  authorization_provenance: { pre_lift_approval: 'never' },
  ...overrides,
} as AdmissionDecision);

const STEP = { step_id: 'save', recipe_id: 'receive-body-metrics-apple-health' };

const gate = (overrides: Partial<CommitGatewayDeps> = {}, admit: TriggerPreapprovalHooks['admit'] = () => 'tpa_1') => {
  const inner = vi.fn<GatewayInner>(async () => ({ saved: 3 }));
  const triggerPreapprovals = { admit: vi.fn(admit) };
  const commitStore = createCommitStore(createInMemoryCollection<Commit>());
  let n = 0;
  const executor = wrapWithCommitGateway(inner, {
    commitStore,
    identity: { request_id: 'run-1', source: webhook, channel_session_id: 'webhook:whi_1', correlation_id: 'c', dispatch_depth: 0 },
    getIngredientCategory: () => 'action',
    genCommitId: () => `commit-${(n += 1)}`,
    genIdempotencyKey: () => `idem-${n}`,
    evaluateAdmission: () => ask(),
    triggerPreapprovals,
    ...overrides,
  });
  return { executor, inner, admit: triggerPreapprovals.admit, commitStore };
};

const held = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(PreflightRequiredSignal);
};

describe('D-341 slice B1 — the gate asks the host for a trigger pre-approval', () => {
  it('one that admits lets the held write through, and the write\'s commit names it', async () => {
    const { executor, inner, admit, commitStore } = gate();
    await expect(executor('recued-core.body-signals.daily_metric.batch', { ops: [] }, undefined, undefined, STEP))
      .resolves.toEqual({ saved: 3 });
    expect(admit).toHaveBeenCalledWith({
      slug: 'recued-core.body-signals.daily_metric.batch', step_id: 'save', risk_tier: 'write',
    });
    expect(inner).toHaveBeenCalledTimes(1);
    expect((await commitStore.get('commit-1'))?.trigger_preapproval).toEqual({ id: 'tpa_1' });
  });

  it('none, a host that fails, or no host: the write asks, and nothing runs', async () => {
    for (const { executor, inner } of [
      gate({}, () => null),
      gate({}, () => { throw new Error('store unreadable'); }),
      gate({ triggerPreapprovals: undefined }),
    ]) {
      await held(executor('recued-core.body-signals.daily_metric.batch', {}, undefined, undefined, STEP));
      expect(inner).not.toHaveBeenCalled();
    }
  });

  it('asks the host only for the ceiling\'s hold, where the owner\'s policy leaves it waivable, below destructive', async () => {
    const cases: Array<[string, Partial<CommitGatewayDeps>]> = [
      ['always', { evaluateAdmission: () => ask({ authorization_provenance: { pre_lift_approval: 'always' } }) }],
      ['destructive', { evaluateAdmission: () => ask({ risk_tier: 'destructive' }) }],
      // Every review an op always gets, whatever the owner's policy before it.
      ...(['review_send', 'review_commitment', 'review_quote_signoff', 'review_approval_workflow', 'review_customer_payment', 'quality'] as const)
        .map((lift_reason): [string, Partial<CommitGatewayDeps>] => [lift_reason, {
          evaluateAdmission: () => ask({ authorization_provenance: { pre_lift_approval: 'never', lift_reason } }) }]),
      ['no identity', { identity: undefined }],
    ];
    for (const [name, overrides] of cases) {
      const { executor, inner, admit } = gate(overrides);
      await held(executor('recued-core.body-signals.daily_metric.batch', {}, undefined, undefined, STEP));
      expect(admit, name).not.toHaveBeenCalled();
      expect(inner, name).not.toHaveBeenCalled();
    }
  });

  it('`ask` before the lift is waivable too', async () => {
    const { executor, inner } = gate({ evaluateAdmission: () => ask({ authorization_provenance: { pre_lift_approval: 'ask' } }) });
    await expect(executor('recued-core.body-signals.daily_metric.batch', {}, undefined, undefined, STEP)).resolves.toEqual({ saved: 3 });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('a D-177 grant that matched is spent instead; a write needing no ask, or a resumed approval, spends none', async () => {
    const sessionGrants: SessionGrantHooks = { match: () => 'grant-1', consume: () => true };
    // A grant is matched on the call's hashed arguments, so the host resolves them here.
    const granted = gate({ sessionGrants, resolveArgsForHash: () => ({ ops: [] }) });
    await expect(granted.executor('recued-core.body-signals.daily_metric.batch', {}, undefined, undefined, STEP)).resolves.toEqual({ saved: 3 });
    expect(granted.admit).not.toHaveBeenCalled();
    expect((await granted.commitStore.get('commit-1'))?.trigger_preapproval).toBeUndefined();

    const allowed = gate({ evaluateAdmission: (): AdmissionDecision => ({ verdict: 'admit' }) });
    await expect(allowed.executor('recued-core.body-signals.daily_metric.batch', {}, undefined, undefined, STEP)).resolves.toEqual({ saved: 3 });
    expect(allowed.admit).not.toHaveBeenCalled();
    expect((await allowed.commitStore.get('commit-1'))?.trigger_preapproval).toBeUndefined();

    const resumed = gate();
    await expect(resumed.executor('recued-core.body-signals.daily_metric.batch', {}, undefined, undefined, {
      ...STEP, preflight_admitted: true,
      preflight_approved_target: { ingredient_slug: 'recued-core.body-signals.daily_metric.batch' },
    })).resolves.toEqual({ saved: 3 });
    expect(resumed.admit).not.toHaveBeenCalled();
  });

  it('each held write asks again: one admission covers one call', async () => {
    let left = 1;
    const { executor, inner, admit } = gate({}, () => (left-- > 0 ? 'tpa_1' : null));
    await expect(executor('recued-core.body-signals.daily_metric.batch', {}, undefined, undefined, STEP)).resolves.toEqual({ saved: 3 });
    await held(executor('recued-core.body-signals.daily_metric.batch', {}, undefined, undefined, STEP));
    expect(admit).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

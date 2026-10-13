import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_WORKFLOW_OP, APPROVAL_WORKFLOW_INGREDIENT, admitByOpRisk, PreflightRequiredSignal,
  type Commit, type Checkpoint, type ExecutionSource } from '@recued/contracts';
import { createCheckpointStore, createCommitStore, createInMemoryCollection } from '@recued/storage';
import { wrapWithCommitGateway, type CommitGatewayDeps, type SessionGrantHooks } from '../commit-gateway.js';
import { buildPreflightAsk, createPreflightAnswerHandler } from '../preflight-reconciliation.js';

const source: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' };
const plan = { endpoint_id: 'approval-1', intent_id: 'intent-1', expected_plan_hash: 'a'.repeat(64), summary: 'Complete the accepted repair.' };
const fixture = (ceiling: 'read' | 'admin', qualityMatches?: boolean) => {
  const grants: SessionGrantHooks = { match: vi.fn(() => 'broad-session-grant'), consume: vi.fn(() => true), mint: vi.fn() };
  const deps: CommitGatewayDeps = {
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    identity: { request_id: 'run', source, channel_session_id: 's', correlation_id: 'corr', dispatch_depth: 0 },
    getIngredientCategory: () => 'action', genCommitId: () => 'commit', genIdempotencyKey: () => 'idem', now: () => 1,
    evaluateAdmission: () => admitByOpRisk({ slug: APPROVAL_WORKFLOW_INGREDIENT, risk_tier: 'write', ceiling,
      source, owner_override: { approval: 'never' } }), resolveArgsForHash: () => plan, sessionGrants: grants,
    ...(qualityMatches !== undefined ? { qualityDelegations: { match: () => qualityMatches,
      getSwitches: () => ({ all_paused: false, quality_paused: false }) } } : {}),
  };
  const inner = vi.fn(async () => ({ continued: true }));
  return { executor: wrapWithCommitGateway(inner, deps), grants, inner };
};
const checkpoint = (): Checkpoint => ({ checkpoint_id: 'checkpoint-1', run_id: 'run-1', recipe_id: 'reception-approval-workflow',
  gated_step_id: 'continue', step_state: {}, created_at: 1 });

describe('each accepted workflow keeps its own owner decision', () => {
  it.each(['read', 'admin'] as const)('audit: quality delegation cannot replace workflow review at ceiling %s', async ceiling => {
    const { executor, inner } = fixture(ceiling, true);
    await expect(executor(APPROVAL_WORKFLOW_INGREDIENT, plan)).rejects.toBeInstanceOf(PreflightRequiredSignal);
    expect(inner).not.toHaveBeenCalled();
  });
  it('audit: workflow review is authorization, not a quality-learning signal', async () => {
    const { executor } = fixture('admin', false);
    const refusal = await executor(APPROVAL_WORKFLOW_INGREDIENT, plan).catch(error => error);
    expect(refusal).toBeInstanceOf(PreflightRequiredSignal);
    expect(refusal).not.toHaveProperty('quality_relevant', true);
  });
  it.each(['read', 'admin'] as const)('cannot reuse a broad session grant at ceiling %s', async ceiling => {
    const { executor, grants, inner } = fixture(ceiling);
    await expect(executor(APPROVAL_WORKFLOW_INGREDIENT, plan)).rejects.toBeInstanceOf(PreflightRequiredSignal);
    expect(grants.match).not.toHaveBeenCalled(); expect(grants.consume).not.toHaveBeenCalled(); expect(inner).not.toHaveBeenCalled();
  });
  it.each(['read', 'admin'] as const)('an approved continuation cannot mint standing authority at ceiling %s', async ceiling => {
    const { executor, grants, inner } = fixture(ceiling);
    await expect(executor(APPROVAL_WORKFLOW_INGREDIENT, plan, undefined, undefined, {
      step_id: 'continue', recipe_id: 'reception-approval-workflow', preflight_admitted: true,
      preflight_approved_target: { ingredient_slug: APPROVAL_WORKFLOW_INGREDIENT },
      preflight_session_grant: { ttl_ms: 3600000, max_uses: 10, risk_tier: 'write' },
    })).resolves.toEqual({ continued: true });
    expect(inner).toHaveBeenCalledTimes(1); expect(grants.mint).not.toHaveBeenCalled(); expect(grants.consume).not.toHaveBeenCalled();
  });
  it.each([APPROVAL_WORKFLOW_OP, APPROVAL_WORKFLOW_INGREDIENT])('offers only approve or deny for %s', operation => {
    const ask = buildPreflightAsk({ checkpoint: checkpoint(), context: { recipe_id: 'reception-approval-workflow',
      gated_step_id: 'continue', tool_slug: operation, risk_tier: 'write',
      session_grant: { ttl_ms: 3600000, max_uses: 100, risk_tier: 'write' },
      owner_override_offer: { kind: 'never_ask', approval: 'never', ingredient_id: APPROVAL_WORKFLOW_INGREDIENT,
        operation_id: APPROVAL_WORKFLOW_OP, op_hash: 'b'.repeat(64) } } });
    expect(ask.options.map(option => option.id)).toEqual(['approve', 'deny']);
    expect(ask.handler.payload).not.toHaveProperty('session_grant'); expect(ask.handler.payload).not.toHaveProperty('owner_override_offer');
  });
  it('preserves the mandatory review provenance through the durable answer', async () => {
    const cp = checkpoint(); const store = createCheckpointStore(createInMemoryCollection<Checkpoint>()); await store.write(cp);
    const provenance = { pre_lift_approval: 'never' as const, lift_reason: 'review_approval_workflow' as const };
    const ask = buildPreflightAsk({ checkpoint: cp, context: { recipe_id: cp.recipe_id, gated_step_id: cp.gated_step_id,
      tool_slug: APPROVAL_WORKFLOW_OP, risk_tier: 'write', authorization_provenance: provenance } });
    const resumeRun = vi.fn(async () => {});
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: { resumeRun, denyRun: vi.fn(async () => {}) } });
    await handler(ask.handler.payload, { option: 'approve', answered_at: 2 });
    expect(resumeRun).toHaveBeenCalledWith(cp, expect.objectContaining({ authorization_provenance: provenance }));
  });
});

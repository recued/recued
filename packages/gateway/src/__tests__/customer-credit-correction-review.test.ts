import { describe,expect,it,vi } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import { createCheckpointStore,createInMemoryCollection } from '@recued/storage';
import { buildPreflightAsk,createPreflightAnswerHandler } from '../preflight-reconciliation.js';
const checkpoint = (): Checkpoint => ({ checkpoint_id: 'cp',run_id: 'run',recipe_id: 'reception-customer-credit-correction',gated_step_id: 'correct',step_state: {},created_at: 1 });
describe('durable customer credit correction review',() => {
  it.each(['core.work-entity.customer-invoice.credit.correct','customer-invoice-credit-correct','core-customer-invoice-credit-correct'])('offers only this credit’s approve/deny decision for %s',tool_slug => {
    const cp = checkpoint();const ask = buildPreflightAsk({ checkpoint: cp,context: { recipe_id: cp.recipe_id,gated_step_id: cp.gated_step_id,tool_slug,risk_tier: 'destructive',
      authorization_provenance: { pre_lift_approval: 'never',lift_reason: 'review_customer_payment' },
      session_grant: { ttl_ms: 3600000,max_uses: 10,risk_tier: 'destructive' },
      owner_override_offer: { kind: 'never_ask',approval: 'never',ingredient_id: 'customer-invoice-credit-correct',operation_id: 'core.work-entity.customer-invoice.credit.correct',op_hash: 'a'.repeat(64) } } });
    expect(ask.options.map(option => option.id)).toEqual(['approve','deny']);expect(ask.handler.payload).not.toHaveProperty('session_grant');expect(ask.handler.payload).not.toHaveProperty('owner_override_offer');
  });
  it('preserves the mandatory review reason through checkpoint answer/resume',async () => {
    const cp = checkpoint();const store = createCheckpointStore(createInMemoryCollection<Checkpoint>());await store.write(cp);
    const provenance = { pre_lift_approval: 'never' as const,lift_reason: 'review_customer_payment' as const };
    const ask = buildPreflightAsk({ checkpoint: cp,context: { recipe_id: cp.recipe_id,gated_step_id: cp.gated_step_id,tool_slug: 'core.work-entity.customer-invoice.credit.correct',risk_tier: 'destructive',authorization_provenance: provenance } });
    const resumeRun = vi.fn(async () => {});const handler = createPreflightAnswerHandler({ checkpointStore: store,resumer: { resumeRun,denyRun: vi.fn(async () => {}) } });
    await handler(ask.handler.payload,{ option: 'approve',answered_at: 2 });expect(resumeRun).toHaveBeenCalledWith(cp,expect.objectContaining({ authorization_provenance: provenance }));
  });
});

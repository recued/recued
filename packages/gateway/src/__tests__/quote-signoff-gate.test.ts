import { describe, expect, it, vi } from 'vitest';
import { admitByOpRisk, PreflightRequiredSignal, type Commit, type ExecutionSource } from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { wrapWithCommitGateway, type CommitGatewayDeps, type SessionGrantHooks } from '../commit-gateway.js';

const source: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' };
const plan = { signoff_id: 'frozen-quote', expected_plan_hash: 'a'.repeat(64), summary: 'Accepted terms and fixed release plan.' };
const fixture = (ceiling: 'read' | 'admin',slug = 'quote-signoff-release') => {
  const grants: SessionGrantHooks = { match: vi.fn(() => 'broad-session-grant'),
    consume: vi.fn(() => true), mint: vi.fn() };
  const deps: CommitGatewayDeps = {
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    identity: { request_id: 'run', source, channel_session_id: 's', correlation_id: 'corr', dispatch_depth: 0 },
    getIngredientCategory: () => 'action', genCommitId: () => 'commit', genIdempotencyKey: () => 'idem', now: () => 1,
    evaluateAdmission: () => admitByOpRisk({ slug, risk_tier: slug === 'customer-payment-correct' ? 'destructive' : 'write', ceiling,
      source, owner_override: { approval: 'never' } }),
    resolveArgsForHash: () => plan, sessionGrants: grants,
  };
  const inner = vi.fn(async () => ({ released: true }));
  return { executor: wrapWithCommitGateway(inner, deps), grants, inner };
};

describe('customer sign-off release always needs its own owner decision', () => {
  it.each(['read', 'admin'] as const)('does not match or consume a session grant to skip review at ceiling %s', async (ceiling) => {
    const { executor, grants, inner } = fixture(ceiling);
    await expect(executor('quote-signoff-release', plan)).rejects.toBeInstanceOf(PreflightRequiredSignal);
    expect(grants.match).not.toHaveBeenCalled(); expect(grants.consume).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });
  it.each(['read', 'admin'] as const)('executes an explicitly resumed release without minting authority at ceiling %s', async (ceiling) => {
    const { executor, grants, inner } = fixture(ceiling);
    await expect(executor('quote-signoff-release', plan, undefined, undefined, {
      step_id: 'release', recipe_id: 'reception-quote-signoff-release', preflight_admitted: true,
      preflight_approved_target: { ingredient_slug: 'quote-signoff-release' },
      preflight_session_grant: { ttl_ms: 3_600_000, max_uses: 10, risk_tier: 'write' },
    })).resolves.toEqual({ released: true });
    expect(inner).toHaveBeenCalledTimes(1); expect(grants.match).not.toHaveBeenCalled();
    expect(grants.mint).not.toHaveBeenCalled(); expect(grants.consume).not.toHaveBeenCalled();
  });
});


describe('customer completion review requires its own owner decision',() => {
  it.each(['read','admin'] as const)('cannot use a broad session grant at ceiling %s',async ceiling => {
    const { executor,grants,inner } = fixture(ceiling,'quote-completion-review');
    await expect(executor('quote-completion-review',plan)).rejects.toBeInstanceOf(PreflightRequiredSignal);
    expect(inner).not.toHaveBeenCalled();expect(grants.match).not.toHaveBeenCalled();expect(grants.consume).not.toHaveBeenCalled();
  });
  it('resumes the explicit owner decision without minting reusable authority',async () => {
    const { executor,grants,inner } = fixture('admin','quote-completion-review');
    await expect(executor('quote-completion-review',plan,undefined,undefined,{
      step_id: 'review',recipe_id: 'reception-quote-completion-review',preflight_admitted: true,
      preflight_approved_target: { ingredient_slug: 'quote-completion-review' },
      preflight_session_grant: { ttl_ms: 3_600_000,max_uses: 10,risk_tier: 'write' },
    })).resolves.toEqual({ released: true });
    expect(inner).toHaveBeenCalledTimes(1);expect(grants.mint).not.toHaveBeenCalled();
  });
});


describe('customer payment corrections cannot borrow session authority',() => {
  it.each(['read','admin'] as const)('holds the correction for its own decision at %s',async ceiling => {
    const { executor,grants,inner } = fixture(ceiling,'customer-payment-correct');
    await expect(executor('customer-payment-correct',plan)).rejects.toBeInstanceOf(PreflightRequiredSignal);
    expect(grants.match).not.toHaveBeenCalled();expect(grants.consume).not.toHaveBeenCalled();expect(inner).not.toHaveBeenCalled();
  });
  it('executes an explicitly resumed correction without minting a reusable grant',async () => {
    const { executor,grants,inner } = fixture('admin','customer-payment-correct');
    await expect(executor('customer-payment-correct',plan,undefined,undefined,{
      step_id: 'correct',recipe_id: 'reception-customer-payment-correction',preflight_admitted: true,
      preflight_approved_target: { ingredient_slug: 'customer-payment-correct' },
      preflight_session_grant: { ttl_ms: 3600000,max_uses: 10,risk_tier: 'destructive' },
    })).resolves.toEqual({ released: true });
    expect(inner).toHaveBeenCalledOnce();expect(grants.mint).not.toHaveBeenCalled();expect(grants.consume).not.toHaveBeenCalled();
  });
});

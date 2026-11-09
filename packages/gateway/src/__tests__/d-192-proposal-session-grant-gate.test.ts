/** D-192 F1 invariant 3 with D-177 — the owner reviews every proposed commitment, so no session grant
 *  stands in for that review: the gate matches none against a held proposal, whoever runs it and under
 *  any ceiling, and mints none from an "Allow this session" answer. As a quote's release, a job a
 *  customer accepted and a customer payment already were (`quote-signoff-gate.test.ts`).
 *
 *  ⛔ Found 2026-11-09: those three were excluded by name at the gate's mint and match; the proposal's
 *  review was not, so its ask offered "Allow this session", and the grant it minted (bound to the
 *  conversation, or for a scheduled or reactive recipe to every later run of it) admitted the next
 *  identical proposal unseen. */
import { describe, expect, it, vi } from 'vitest';
import { admitByOpRisk, PreflightRequiredSignal, type Commit, type ExecutionSource } from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { wrapWithCommitGateway, type CommitGatewayDeps, type SessionGrantHooks } from '../commit-gateway.js';

const chat: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' };
const scheduled: ExecutionSource = { channel: 'schedule', actor: 'system', schedule_id: 'sch_1', cron: '0 7 * * *',
  source_recipe: 'capture-commitments' };
const proposal = { direction: 'outbound', statement: 'Send Dana the deck by Friday', idempotency_key: 'deck-1' };

const fixture = (source: ExecutionSource, ceiling: 'read' | 'admin') => {
  const grants: SessionGrantHooks = { match: vi.fn(() => 'a-session-grant'), consume: vi.fn(() => true), mint: vi.fn() };
  const deps: CommitGatewayDeps = {
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    identity: { request_id: 'run', source, channel_session_id: 'session', correlation_id: 'corr', dispatch_depth: 0 },
    getIngredientCategory: () => 'action', genCommitId: () => 'commit', genIdempotencyKey: () => 'idem', now: () => 1,
    evaluateAdmission: () => admitByOpRisk({ slug: 'commitment-propose', risk_tier: 'write', ceiling, source }),
    resolveArgsForHash: () => proposal, sessionGrants: grants,
  };
  const inner = vi.fn(async () => ({ commitment: { id: 'c1' } }));
  return { executor: wrapWithCommitGateway(inner, deps), grants, inner };
};

describe('a proposed commitment is reviewed every time: no session grant stands in for it', () => {
  it.each([['the owner\'s chat', chat, 'admin'], ['a scheduled recipe', scheduled, 'read']] as const)(
    'held in %s, it asks: no grant is matched or spent', async (_where, source, ceiling) => {
      const { executor, grants, inner } = fixture(source, ceiling);
      await expect(executor('commitment-propose', proposal)).rejects.toBeInstanceOf(PreflightRequiredSignal);
      expect(grants.match).not.toHaveBeenCalled();
      expect(grants.consume).not.toHaveBeenCalled();
      expect(inner).not.toHaveBeenCalled();
    });

  it.each([['the owner\'s chat', chat, 'admin'], ['a scheduled recipe', scheduled, 'read']] as const)(
    'approved in %s with "Allow this session", it is added once and mints nothing', async (_where, source, ceiling) => {
      const { executor, grants, inner } = fixture(source, ceiling);
      await expect(executor('commitment-propose', proposal, undefined, undefined, {
        step_id: 'propose', recipe_id: 'capture-commitments', preflight_admitted: true,
        preflight_approved_target: { ingredient_slug: 'commitment-propose' },
        preflight_session_grant: { ttl_ms: 3_600_000, max_uses: 10, risk_tier: 'write' },
      })).resolves.toEqual({ commitment: { id: 'c1' } });
      expect(inner).toHaveBeenCalledTimes(1);
      expect(grants.mint).not.toHaveBeenCalled();
      expect(grants.match).not.toHaveBeenCalled();
    });
});

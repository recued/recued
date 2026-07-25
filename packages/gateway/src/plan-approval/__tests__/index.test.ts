/** D-137 P3 § A.11 — Plan-approval substrate tests.
 *
 *  Covers `requiresPlanApproval` predicate, `buildPlanProposal`
 *  constructor, in-memory store lifecycle, args-hash binding +
 *  closed risk-tier list (Codex P3 fold). */

import type { ChatPlanProposal, ToolEntry } from '@recued/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildPlanProposal,
  computePlanArgsHash,
  createPlanApprovalStore,
  PLAN_APPROVAL_CONSUMPTION_TTL_MS,
  PLAN_APPROVAL_WRITE_RISK_TIERS,
  requiresPlanApproval,
} from '../index.js';

const entry = (overrides: Partial<ToolEntry> = {}): ToolEntry => ({
  name: 'test.tool',
  tier: 1,
  description: 'test',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'read',
  concurrency_safe: false,
  ...overrides,
});

describe('D-137 P3 § A.11 — requiresPlanApproval predicate', () => {
  it('read tools never gate', () => {
    expect(requiresPlanApproval(entry({ classification: 'read' }))).toBe(false);
  });

  it('write tools always gate', () => {
    expect(requiresPlanApproval(entry({ classification: 'write' }))).toBe(true);
  });

  it('unknown classification gates on every canonical write-class risk_tier (Codex P3 P2 fold)', () => {
    // Codex P3 review P2 fold — the predicate now keys on the real
    // `RiskTier` taxonomy ('write' | 'admin' | 'destructive'). The
    // prior `'review'` literal didn't exist anywhere in the recipe /
    // ingredient registry, so write-capable Tier 2 entries silently
    // bypassed the gate once the store was wired.
    expect(
      requiresPlanApproval(entry({ classification: 'unknown' })),
    ).toBe(false);
    for (const tier of PLAN_APPROVAL_WRITE_RISK_TIERS) {
      expect(
        requiresPlanApproval(
          entry({ classification: 'unknown', risk_tier: tier }),
        ),
      ).toBe(true);
    }
    // 'read' is the only non-gated risk_tier.
    expect(
      requiresPlanApproval(
        entry({ classification: 'unknown', risk_tier: 'read' }),
      ),
    ).toBe(false);
    // Garbage / unknown literals don't gate (defensive — the
    // taxonomy is closed at the contract level but the predicate
    // accepts ToolEntry's free-form string risk_tier slot).
    expect(
      requiresPlanApproval(
        entry({ classification: 'unknown', risk_tier: 'review' }),
      ),
    ).toBe(false);
  });

  it('unknown classification gates iff destructive_hint: true', () => {
    expect(
      requiresPlanApproval(
        entry({ classification: 'unknown', destructive_hint: true }),
      ),
    ).toBe(true);
    expect(
      requiresPlanApproval(
        entry({ classification: 'unknown', destructive_hint: false }),
      ),
    ).toBe(false);
  });

  it('PLAN_APPROVAL_WRITE_RISK_TIERS exports the closed write-class list', () => {
    expect(Array.from(PLAN_APPROVAL_WRITE_RISK_TIERS).sort()).toEqual([
      'admin',
      'destructive',
      'write',
    ]);
  });
});

describe('D-137 P3 § A.11 — computePlanArgsHash (Codex P3 P1 fold #2)', () => {
  it('returns 16-hex-char digest', () => {
    const h = computePlanArgsHash({ to: 'a@b.com' });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is canonical: object key order does not affect hash', () => {
    const h1 = computePlanArgsHash({ a: 1, b: 2 });
    const h2 = computePlanArgsHash({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('different args → different hash', () => {
    expect(computePlanArgsHash({ to: 'alice' })).not.toBe(
      computePlanArgsHash({ to: 'attacker' }),
    );
  });

  it('handles undefined / non-finite numbers / non-serialisables defensively', () => {
    // Should not throw + should produce a stable hash.
    const a = computePlanArgsHash({ x: undefined });
    const b = computePlanArgsHash({ x: NaN });
    const c = computePlanArgsHash(null);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(c).toMatch(/^[0-9a-f]{16}$/);
  });

  it('arrays preserve order', () => {
    const h1 = computePlanArgsHash([1, 2, 3]);
    const h2 = computePlanArgsHash([3, 2, 1]);
    expect(h1).not.toBe(h2);
  });
});

describe('D-137 P3 § A.11 — buildPlanProposal', () => {
  it('mints a fully-shaped proposal with status: "proposed" + args_hash', () => {
    let idCounter = 0;
    const proposal = buildPlanProposal({
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool: 'mail.send',
      tier: 1,
      classification: 'write',
      args: { to: 'a@b.com' },
      mintId: () => `plan-${++idCounter}`,
      now: () => 100,
    });
    expect(proposal.plan_id).toBe('plan-1');
    expect(proposal.session_id).toBe('sess-1');
    expect(proposal.turn_id).toBe('turn-1');
    expect(proposal.tool).toBe('mail.send');
    expect(proposal.tier).toBe(1);
    expect(proposal.classification).toBe('write');
    expect(proposal.args).toEqual({ to: 'a@b.com' });
    expect(proposal.status).toBe('proposed');
    expect(proposal.created_at).toBe(100);
    // Codex P3 P1 fold #2 — args_hash is load-bearing for the gate
    // binding; assert shape (16 hex chars) + stability.
    expect(proposal.args_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(proposal.args_hash).toBe(computePlanArgsHash({ to: 'a@b.com' }));
  });

  it('threads optional target_instance when supplied', () => {
    const proposal = buildPlanProposal({
      session_id: 's',
      turn_id: 't',
      tool: 'mail.send',
      tier: 1,
      classification: 'write',
      args: {},
      target_instance: 'bob-mail',
      mintId: () => 'p1',
      now: () => 0,
    });
    expect(proposal.target_instance).toBe('bob-mail');
  });
});

describe('D-137 P3 § A.11 — PlanApprovalStore lifecycle', () => {
  // sha256('{}') first 16 hex chars per `computePlanArgsHash` over an
  // empty-object args payload (canonical JSON: '{}').
  const HASH_EMPTY = '44136fa355b3678a';
  const proposal = (overrides: Partial<ChatPlanProposal> = {}): ChatPlanProposal => ({
    plan_id: 'p1',
    session_id: 's1',
    turn_id: 't1',
    tool: 'mail.send',
    tier: 1,
    classification: 'write',
    args: {},
    args_hash: HASH_EMPTY,
    status: 'proposed',
    created_at: 100,
    ...overrides,
  });

  it('persists + retrieves by plan_id', () => {
    const store = createPlanApprovalStore();
    const p = proposal();
    store.put(p);
    expect(store.get('p1')).toEqual(p);
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('does not replace reviewed arguments on a repeated plan_id', () => {
    const store = createPlanApprovalStore();
    const original = proposal({ args: { to: 'owner@example.com' } });
    store.put(original);
    store.put(proposal({
      args: { to: 'attacker@example.com' },
      args_hash: 'different-hash',
    }));

    expect(store.get('p1')).toEqual(original);
  });

  it('rechecks approval freshness at the atomic dispatch spend', () => {
    const store = createPlanApprovalStore();
    store.put(proposal());
    store.resolve('p1', 'approved', 500);

    expect(
      store.consumeForDispatch(
        'p1',
        500 + PLAN_APPROVAL_CONSUMPTION_TTL_MS + 1,
        'turn-execution',
      ),
    ).toBeUndefined();
    expect(store.get('p1')?.consumed_at).toBeUndefined();
  });

  it('binds terminal receipts to the execution turn that spent approval', () => {
    const store = createPlanApprovalStore();
    store.put(proposal());
    store.resolve('p1', 'approved', 500);
    store.consumeForDispatch('p1', 600, 'turn-execution');

    expect(
      store.recordExecution('p1', {
        status: 'completed',
        turn_id: 'turn-other',
        result_ref: 'result:other',
      }),
    ).toBeUndefined();
    expect(store.listForSession('s1')[0]?.execution).toEqual({
      status: 'running',
      turn_id: 'turn-execution',
    });
  });

  it('listPending filters by session + status: "proposed"', () => {
    const store = createPlanApprovalStore();
    store.put(proposal({ plan_id: 'p1', created_at: 100 }));
    store.put(proposal({ plan_id: 'p2', created_at: 200 }));
    store.put(
      proposal({
        plan_id: 'p3',
        created_at: 50,
        session_id: 'other-session',
      }),
    );
    store.put(proposal({ plan_id: 'p4', status: 'approved', created_at: 300 }));
    const pending = store.listPending('s1');
    expect(pending.map((p) => p.plan_id)).toEqual(['p1', 'p2']);
  });

  it('findLatest scopes to (session, turn, tool, args_hash) + picks newest', () => {
    const store = createPlanApprovalStore();
    store.put(proposal({ plan_id: 'p1', created_at: 100 }));
    store.put(proposal({ plan_id: 'p2', created_at: 200 }));
    store.put(
      proposal({
        plan_id: 'p3',
        created_at: 300,
        turn_id: 'different-turn',
      }),
    );
    const found = store.findLatest('s1', 't1', 'mail.send', HASH_EMPTY);
    expect(found?.plan_id).toBe('p2');
    expect(store.findLatest('s1', 't1', 'other.tool', HASH_EMPTY)).toBeUndefined();
    // Codex P3 fold #2 — different args_hash returns undefined even
    // when (session, turn, tool) match an existing approved plan.
    expect(
      store.findLatest('s1', 't1', 'mail.send', 'different-hash'),
    ).toBeUndefined();
  });

  it('resolve flips status + stamps resolved_at', () => {
    const store = createPlanApprovalStore();
    store.put(proposal());
    const resolved = store.resolve('p1', 'approved', 500);
    expect(resolved?.status).toBe('approved');
    expect(resolved?.resolved_at).toBe(500);
    expect(store.get('p1')?.status).toBe('approved');
  });

  it('resolve is one-way (terminal state)', () => {
    const store = createPlanApprovalStore();
    store.put(proposal());
    store.resolve('p1', 'approved', 500);
    const second = store.resolve('p1', 'cancelled', 600);
    // Returns existing record unchanged.
    expect(second?.status).toBe('approved');
    expect(store.get('p1')?.status).toBe('approved');
  });

  it('resolve returns undefined for unknown plan_id', () => {
    const store = createPlanApprovalStore();
    expect(store.resolve('nonexistent', 'approved', 100)).toBeUndefined();
  });

  it('resolve supports cancel path', () => {
    const store = createPlanApprovalStore();
    store.put(proposal());
    const resolved = store.resolve('p1', 'cancelled', 700);
    expect(resolved?.status).toBe('cancelled');
    expect(resolved?.resolved_at).toBe(700);
  });
});

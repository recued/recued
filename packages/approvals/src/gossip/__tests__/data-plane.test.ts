/** D-113 — Gossip data plane tests.
 *
 *  Covers merge + match + tiebreaker + observer/stakeholder rule
 *  + TTL sweeps + timeout detection + worker-dispatch adoption +
 *  convergence under partition. Pure-logic; no network, no clocks
 *  — each test controls `now` explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  PAIR_TTL_MS,
  ITEM_TTL_MS,
  OWNER_GRACE_WINDOW_MS,
  DISPATCH_EXPIRY_MS,
  type ApprovalPendingRecord,
  type ApprovalResolutionRecord,
  type WorkerDispatch,
} from '@recued/contracts';
import {
  createLocalState,
  mergeRemote,
  pickEffective,
  scanForTimeouts,
  adoptWorkerDispatch,
  applyTimeoutPolicy,
  computeEffectiveDecision,
  extractContribution,
} from '../data-plane.js';

// ── Fixtures ─────────────────────────────────────────────────────

const mkPending = (
  id: string,
  overrides: Partial<ApprovalPendingRecord> = {},
): ApprovalPendingRecord => ({
  approval_id: id,
  initiator_instance: 'inst-A',
  recipe_id: 'recipe-1',
  step_id: 'confirm',
  prompt: 'Do the thing?',
  created_at: 1_000_000,
  timeout_at: 1_900_000,
  ...overrides,
});

const mkAction = (
  id: string,
  overrides: Partial<ApprovalResolutionRecord> = {},
): ApprovalResolutionRecord => ({
  approval_id: id,
  created_by_instance: 'inst-A',
  kind: 'user_action',
  decision: 'approve',
  actor: { channel: 'extension', identifier: 'user@x' },
  resolved_at: 1_100_000,
  ...overrides,
});

// ── Merge + match ────────────────────────────────────────────────

describe('mergeRemote — pending insertion', () => {
  it('inserts new pendings into local state', () => {
    const local = createLocalState();
    const p = mkPending('ap-1');
    const res = mergeRemote(
      local,
      { pending: [p], action: [] },
      { self: { instance_id: 'inst-A' }, now: 1_000_100 },
    );
    expect(res.state.pending.get('ap-1')).toEqual(p);
    expect(res.newly_resolved).toEqual([]);
    expect(res.popped).toEqual([]);
  });

  it('later created_at wins on conflicting pending', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1', { created_at: 100 }));
    const res = mergeRemote(
      local,
      { pending: [mkPending('ap-1', { created_at: 200, prompt: 'Updated?' })], action: [] },
      { self: { instance_id: 'inst-A' }, now: 300 },
    );
    expect(res.state.pending.get('ap-1')?.prompt).toBe('Updated?');
  });

  it('earlier created_at loses on conflicting pending', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1', { created_at: 200, prompt: 'Newer' }));
    const res = mergeRemote(
      local,
      { pending: [mkPending('ap-1', { created_at: 100, prompt: 'Older' })], action: [] },
      { self: { instance_id: 'inst-A' }, now: 300 },
    );
    expect(res.state.pending.get('ap-1')?.prompt).toBe('Newer');
  });

  it('additively merges channel_handles across peers', () => {
    const local = createLocalState();
    local.pending.set(
      'ap-1',
      mkPending('ap-1', {
        channel_handles: {
          slack: [{ workspace_slug: 'ws', channel_id: 'C1', message_ts: 'ts1', posted_at: 1 }],
        },
      }),
    );
    const incoming = mkPending('ap-1', {
      created_at: mkPending('ap-1').created_at,  // same age
      channel_handles: {
        telegram: [{ chat_slug: 'tg', chat_id: 5, message_id: 9, posted_at: 2 }],
      },
    });
    const res = mergeRemote(
      local,
      { pending: [incoming], action: [] },
      { self: { instance_id: 'inst-A' }, now: 1_000 },
    );
    const merged = res.state.pending.get('ap-1')!;
    expect(merged.channel_handles?.slack).toHaveLength(1);
    expect(merged.channel_handles?.telegram).toHaveLength(1);
  });
});

describe('mergeRemote — action insertion + dedup', () => {
  it('inserts new actions into local state', () => {
    const local = createLocalState();
    const res = mergeRemote(
      local,
      { pending: [], action: [mkAction('ap-1')] },
      { self: { instance_id: 'inst-B' }, now: 1_000 },
    );
    expect(res.state.action.get('ap-1')).toHaveLength(1);
  });

  it('dedups identical action re-emissions (same instance + timestamp + decision)', () => {
    const local = createLocalState();
    local.action.set('ap-1', [mkAction('ap-1')]);
    const res = mergeRemote(
      local,
      { pending: [], action: [mkAction('ap-1')] },  // identical
      { self: { instance_id: 'inst-B' }, now: 1_000 },
    );
    expect(res.state.action.get('ap-1')).toHaveLength(1);
  });

  it('keeps distinct actions with different decisions', () => {
    const local = createLocalState();
    const res = mergeRemote(
      local,
      {
        pending: [],
        action: [
          mkAction('ap-1', { created_by_instance: 'inst-A', decision: 'approve' }),
          mkAction('ap-1', { created_by_instance: 'inst-B', decision: 'reject' }),
        ],
      },
      { self: { instance_id: 'inst-C' }, now: 1_000 },
    );
    expect(res.state.action.get('ap-1')).toHaveLength(2);
  });
});

// ── Pickeffective tiebreaker ────────────────────────────────────

describe('pickEffective — deterministic tiebreaker', () => {
  it('returns earliest resolved_at', () => {
    const winner = pickEffective([
      mkAction('ap-1', { resolved_at: 200 }),
      mkAction('ap-1', { resolved_at: 100 }),  // earlier wins
      mkAction('ap-1', { resolved_at: 150 }),
    ]);
    expect(winner.resolved_at).toBe(100);
  });

  it('ties on resolved_at → lex-smallest created_by_instance', () => {
    const winner = pickEffective([
      mkAction('ap-1', { resolved_at: 100, created_by_instance: 'inst-B' }),
      mkAction('ap-1', { resolved_at: 100, created_by_instance: 'inst-A' }),
    ]);
    expect(winner.created_by_instance).toBe('inst-A');
  });

  it('ties on instance + time → lex-smallest actor.identifier', () => {
    const winner = pickEffective([
      mkAction('ap-1', {
        resolved_at: 100,
        created_by_instance: 'inst-A',
        actor: { channel: 'extension', identifier: 'user-b@x' },
      }),
      mkAction('ap-1', {
        resolved_at: 100,
        created_by_instance: 'inst-A',
        actor: { channel: 'extension', identifier: 'user-a@x' },
      }),
    ]);
    expect(winner.actor?.identifier).toBe('user-a@x');
  });

  it('throws on empty input', () => {
    expect(() => pickEffective([])).toThrow(/empty/);
  });

  it('all peers agree on the same winner given the same input set', () => {
    const candidates = [
      mkAction('ap-1', { resolved_at: 100, created_by_instance: 'inst-B' }),
      mkAction('ap-1', { resolved_at: 100, created_by_instance: 'inst-A' }),
      mkAction('ap-1', { resolved_at: 100, created_by_instance: 'inst-C' }),
    ];
    // Peer X receives in order A,B,C; peer Y receives in C,B,A.
    const xWinner = pickEffective([...candidates]);
    const yWinner = pickEffective([...candidates].reverse());
    expect(xWinner.created_by_instance).toBe(yWinner.created_by_instance);
  });
});

// ── Newly-resolved emission ─────────────────────────────────────

describe('mergeRemote — newly_resolved detection', () => {
  it('emits a newly_resolved entry when a pending gets its first matching action', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1'));
    const res = mergeRemote(
      local,
      { pending: [], action: [mkAction('ap-1')] },
      { self: { instance_id: 'inst-A' }, now: 1_100_000 },
    );
    expect(res.newly_resolved).toHaveLength(1);
    expect(res.newly_resolved[0]!.approval_id).toBe('ap-1');
    expect(res.newly_resolved[0]!.effective.decision).toBe('approve');
  });

  it('does NOT re-emit newly_resolved when both already present pre-merge', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1'));
    local.action.set('ap-1', [mkAction('ap-1')]);
    const res = mergeRemote(
      local,
      { pending: [], action: [mkAction('ap-1', { note: 'late-arriving' })] },
      { self: { instance_id: 'inst-A' }, now: 1_100_000 },
    );
    expect(res.newly_resolved).toEqual([]);
  });
});

// ── Observer/stakeholder propagation ─────────────────────────────

describe('sweepTtl — observer vs stakeholder', () => {
  it('initiator (stakeholder) retains matched pair until PAIR_TTL', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1', { initiator_instance: 'inst-A' }));
    local.action.set('ap-1', [mkAction('ap-1', { resolved_at: 1_100_000 })]);
    const res = mergeRemote(
      local,
      { pending: [], action: [] },
      { self: { instance_id: 'inst-A' }, now: 1_100_000 + PAIR_TTL_MS - 1 },
    );
    expect(res.state.pending.has('ap-1')).toBe(true);
    expect(res.state.action.has('ap-1')).toBe(true);
    expect(res.popped).not.toContain('ap-1');
  });

  it('action creator (stakeholder) retains matched pair until PAIR_TTL', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1', { initiator_instance: 'inst-A' }));
    local.action.set('ap-1', [
      mkAction('ap-1', { created_by_instance: 'inst-B', resolved_at: 1_100_000 }),
    ]);
    const res = mergeRemote(
      local,
      { pending: [], action: [] },
      { self: { instance_id: 'inst-B' }, now: 1_100_000 + PAIR_TTL_MS - 1 },
    );
    expect(res.state.pending.has('ap-1')).toBe(true);
  });

  it('pure observer pops matched pair immediately', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1', { initiator_instance: 'inst-A' }));
    local.action.set('ap-1', [
      mkAction('ap-1', { created_by_instance: 'inst-B', resolved_at: 1_100_000 }),
    ]);
    const res = mergeRemote(
      local,
      { pending: [], action: [] },
      { self: { instance_id: 'inst-C' }, now: 1_100_000 + 100 },
    );
    expect(res.state.pending.has('ap-1')).toBe(false);
    expect(res.popped).toContain('ap-1');
  });

  it('stakeholder pops matched pair once PAIR_TTL exceeded', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1', { initiator_instance: 'inst-A' }));
    local.action.set('ap-1', [mkAction('ap-1', { resolved_at: 1_100_000 })]);
    const res = mergeRemote(
      local,
      { pending: [], action: [] },
      { self: { instance_id: 'inst-A' }, now: 1_100_000 + PAIR_TTL_MS + 1 },
    );
    expect(res.state.pending.has('ap-1')).toBe(false);
    expect(res.popped).toContain('ap-1');
  });
});

describe('sweepTtl — unmatched item TTL', () => {
  it('unmatched pending drops at ITEM_TTL_MS', () => {
    const local = createLocalState();
    local.pending.set('ap-1', mkPending('ap-1', { created_at: 1_000_000 }));
    const res = mergeRemote(
      local,
      { pending: [], action: [] },
      { self: { instance_id: 'inst-A' }, now: 1_000_000 + ITEM_TTL_MS + 1 },
    );
    expect(res.state.pending.has('ap-1')).toBe(false);
  });

  it('unmatched pending drops past timeout_at', () => {
    const local = createLocalState();
    local.pending.set(
      'ap-1',
      mkPending('ap-1', { created_at: 1_000_000, timeout_at: 1_005_000 }),
    );
    const res = mergeRemote(
      local,
      { pending: [], action: [] },
      { self: { instance_id: 'inst-A' }, now: 1_005_000 + 1 },
    );
    expect(res.state.pending.has('ap-1')).toBe(false);
  });

  it('unmatched pending kept while within both ITEM_TTL and timeout_at', () => {
    const local = createLocalState();
    local.pending.set(
      'ap-1',
      mkPending('ap-1', { created_at: 1_000_000, timeout_at: 1_900_000 }),
    );
    const res = mergeRemote(
      local,
      { pending: [], action: [] },
      { self: { instance_id: 'inst-A' }, now: 1_000_000 + 5_000 },
    );
    expect(res.state.pending.has('ap-1')).toBe(true);
  });

  it('orphan actions (no matching pending) get cleaned', () => {
    const local = createLocalState();
    local.action.set('ap-1', [mkAction('ap-1')]);
    const res = mergeRemote(
      local,
      { pending: [], action: [] },
      { self: { instance_id: 'inst-A' }, now: 2_000_000 },
    );
    expect(res.state.action.has('ap-1')).toBe(false);
  });
});

// ── Timeout detection ───────────────────────────────────────────

describe('scanForTimeouts', () => {
  it('owner emits executor_timeout immediately at timeout_at', () => {
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1', { timeout_at: 1_900_000 }));
    const emitted = scanForTimeouts(state, {
      self: { instance_id: 'inst-A' },  // owner
      now: 1_900_000,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.kind).toBe('executor_timeout');
    expect(emitted[0]!.created_by_instance).toBe('inst-A');
  });

  it('peer waits OWNER_GRACE_WINDOW before emitting', () => {
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1', { timeout_at: 1_900_000 }));
    const justPast = scanForTimeouts(state, {
      self: { instance_id: 'inst-B' },  // peer, not owner
      now: 1_900_000 + OWNER_GRACE_WINDOW_MS - 1,
    });
    expect(justPast).toHaveLength(0);

    const pastGrace = scanForTimeouts(state, {
      self: { instance_id: 'inst-B' },
      now: 1_900_000 + OWNER_GRACE_WINDOW_MS,
    });
    expect(pastGrace).toHaveLength(1);
    expect(pastGrace[0]!.created_by_instance).toBe('inst-B');
  });

  it('does not emit when pending is already resolved', () => {
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1'));
    state.action.set('ap-1', [mkAction('ap-1')]);
    const emitted = scanForTimeouts(state, {
      self: { instance_id: 'inst-A' },
      now: 9_000_000,
    });
    expect(emitted).toHaveLength(0);
  });

  it('does not emit before timeout_at', () => {
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1', { timeout_at: 1_900_000 }));
    const emitted = scanForTimeouts(state, {
      self: { instance_id: 'inst-A' },
      now: 1_800_000,
    });
    expect(emitted).toHaveLength(0);
  });
});

// ── Timeout policy ──────────────────────────────────────────────

describe('applyTimeoutPolicy + computeEffectiveDecision', () => {
  it('applyTimeoutPolicy maps the three policy values', () => {
    expect(applyTimeoutPolicy('approve')).toBe('approve');
    expect(applyTimeoutPolicy('reject')).toBe('reject');
    expect(applyTimeoutPolicy('fail')).toBe('expired');
  });

  it('computeEffectiveDecision maps user_action decisions', () => {
    expect(computeEffectiveDecision(mkAction('ap', { decision: 'approve' }), 'fail')).toBe('approve');
    expect(computeEffectiveDecision(mkAction('ap', { decision: 'reject' }), 'fail')).toBe('reject');
    expect(computeEffectiveDecision(mkAction('ap', { decision: 'cancel' }), 'fail')).toBe('cancelled');
  });

  it('computeEffectiveDecision applies timeout policy to executor_timeout', () => {
    const timeout = mkAction('ap', { kind: 'executor_timeout', decision: undefined });
    expect(computeEffectiveDecision(timeout, 'fail')).toBe('expired');
    expect(computeEffectiveDecision(timeout, 'approve')).toBe('approve');
    expect(computeEffectiveDecision(timeout, 'reject')).toBe('reject');
  });

  it('computeEffectiveDecision maps all executor_* cancellation kinds to cancelled', () => {
    for (const kind of ['executor_cancelled', 'executor_cascade', 'executor_killed'] as const) {
      const r = mkAction('ap', { kind, decision: undefined });
      expect(computeEffectiveDecision(r, 'fail')).toBe('cancelled');
    }
  });
});

// ── Worker dispatch adoption ────────────────────────────────────

describe('adoptWorkerDispatch', () => {
  type ActionDispatch = Extract<WorkerDispatch, { kind: 'approval_action' }>;
  const dispatch = (overrides: Partial<ActionDispatch> = {}): ActionDispatch => ({
    request_id: 'req-1',
    target_instance_id: 'inst-A',
    kind: 'approval_action',
    payload: {
      approval_id: 'ap-1',
      decision: 'approve',
      actor_channel: 'email',
      actor_identifier: 'user@x',
      note: 'looks good',
      nonce: 'abc',
    },
    created_at: 500,
    expires_at: 500 + DISPATCH_EXPIRY_MS,
    ...overrides,
  });

  it('returns a user_action resolution under the adopting peer', () => {
    const res = adoptWorkerDispatch(dispatch(), {
      self: { instance_id: 'inst-A' },
      now: 600,
    });
    expect(res).not.toBeNull();
    expect(res!.kind).toBe('user_action');
    expect(res!.created_by_instance).toBe('inst-A');
    expect(res!.decision).toBe('approve');
    expect(res!.actor?.channel).toBe('email');
    expect(res!.actor?.identifier).toBe('user@x');
    expect(res!.resolved_at).toBe(500);  // preserves dispatch created_at
  });

  it('returns null for non-action dispatch kinds', () => {
    const base = { request_id: 'r', target_instance_id: 'inst-A', created_at: 500, expires_at: 500 + DISPATCH_EXPIRY_MS };
    const listed = adoptWorkerDispatch(
      { ...base, kind: 'approval_list', payload: {} },
      { self: { instance_id: 'inst-A' }, now: 600 },
    );
    expect(listed).toBeNull();

    const status = adoptWorkerDispatch(
      { ...base, kind: 'approval_status', payload: { approval_id: 'ap-1' } },
      { self: { instance_id: 'inst-A' }, now: 600 },
    );
    expect(status).toBeNull();
  });

  it('tiebreaker collapses duplicate adoptions from two peers', () => {
    // Same dispatch hits two live instances; both adopt; each emits
    // their own resolution; tiebreaker on the combined set picks the
    // lex-smaller instance id deterministically.
    const d = dispatch();
    const a = adoptWorkerDispatch(d, { self: { instance_id: 'inst-A' }, now: 600 });
    const b = adoptWorkerDispatch(d, { self: { instance_id: 'inst-B' }, now: 600 });
    const winner = pickEffective([a!, b!]);
    expect(winner.created_by_instance).toBe('inst-A');  // both resolved_at equal, lex-smaller
  });
});

// ── Contribution extraction ─────────────────────────────────────

describe('extractContribution', () => {
  it('flattens local state into pending + action arrays for heartbeat outbound', () => {
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1'));
    state.pending.set('ap-2', mkPending('ap-2'));
    state.action.set('ap-1', [mkAction('ap-1'), mkAction('ap-1', { created_by_instance: 'inst-B' })]);
    const c = extractContribution(state);
    expect(c.pending).toHaveLength(2);
    expect(c.action).toHaveLength(2);
  });
});

// ── Convergence under partition ─────────────────────────────────

describe('gossip convergence under partition', () => {
  it('three peers each observing different subsets converge on the same effective', () => {
    // Peer A sees pending + its own action; peer B sees pending + B's
    // action; peer C sees both actions but no pending; when peers
    // eventually merge, everyone picks the same effective.
    const pending = mkPending('ap-1', { initiator_instance: 'inst-A' });
    const aAction = mkAction('ap-1', { created_by_instance: 'inst-A', resolved_at: 1_100_000 });
    const bAction = mkAction('ap-1', {
      created_by_instance: 'inst-B', resolved_at: 1_100_000, decision: 'reject',
    });

    // Everyone ends up with full view after gossip converges.
    const viewA = mergeRemote(
      createLocalState(),
      { pending: [pending], action: [aAction, bAction] },
      { self: { instance_id: 'inst-A' }, now: 1_100_500 },
    );
    const viewB = mergeRemote(
      createLocalState(),
      { pending: [pending], action: [bAction, aAction] },  // different order
      { self: { instance_id: 'inst-B' }, now: 1_100_500 },
    );
    // Both peers' newly_resolved list picks the same effective.
    expect(viewA.newly_resolved[0]!.effective.created_by_instance)
      .toBe(viewB.newly_resolved[0]!.effective.created_by_instance);
    expect(viewA.newly_resolved[0]!.effective.decision).toBe('approve');  // A is lex-smaller, wins
  });
});

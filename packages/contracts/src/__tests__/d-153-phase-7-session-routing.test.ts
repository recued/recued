/** D-153 P7 — Session routing substrate.
 *
 *  Pins the pure contracts from packages/contracts/src/session-routing.ts:
 *  lifecycle state ordering and transitions, pre-commit input-pool caps,
 *  deterministic message routing, routing-classifier output narrowing,
 *  routing-effect consequences, and the lifecycle broadcast registration.
 *
 *  Spec: D-153 § Routing — what happens when a new message
 *  arrives (lines 553-573). */

import { describe, expect, it } from 'vitest';

import {
  ALL_BROADCAST_EVENT_KINDS,
  DEFAULT_SUBSCRIPTIONS,
  INPUT_POOL_COMMIT_REASONS,
  INPUT_POOL_MAX_MESSAGES,
  INPUT_POOL_WINDOW_MS,
  LIFECYCLE_TRANSITIONS,
  MESSAGE_ROUTINGS,
  MESSAGE_ROUTING_BY_STATE,
  ROUTING_DISPOSITIONS,
  ROUTING_EFFECTS,
  SESSION_LIFECYCLE_STATES,
  assertSessionRoutingInvariants,
  canTransitionLifecycle,
  evaluateInputPool,
  isInputPoolCommitReason,
  isMessageRouting,
  isRoutingClassification,
  isRoutingDisposition,
  isSessionLifecycleState,
  isTerminalLifecycleState,
  lookupRoutingEffect,
  openInputPool,
  resolveMessageRouting,
  type InputPoolCommitReason,
  type MessageRouting,
  type RoutingDisposition,
  type RoutingEffect,
  type SessionLifecycleState,
} from '@recued/contracts';

const EXPECTED_SESSION_LIFECYCLE_STATES: readonly SessionLifecycleState[] = [
  'intent_forming',
  'intent_committed',
  'executing',
  'intent_satisfied',
  'closed',
] as const;

const EXPECTED_LIFECYCLE_TRANSITIONS: Record<
  SessionLifecycleState,
  readonly SessionLifecycleState[]
> = {
  intent_forming: ['intent_committed', 'closed'],
  intent_committed: ['executing', 'intent_satisfied', 'closed'],
  executing: ['intent_satisfied', 'closed'],
  intent_satisfied: ['closed'],
  closed: [],
};

const EXPECTED_INPUT_POOL_COMMIT_REASONS: readonly InputPoolCommitReason[] = [
  'count_cap',
  'window_elapsed',
] as const;

const EXPECTED_MESSAGE_ROUTINGS: readonly MessageRouting[] = [
  'append_to_pool',
  'classify',
  'new_session',
] as const;

const EXPECTED_MESSAGE_ROUTING_BY_STATE: Record<SessionLifecycleState, MessageRouting> = {
  intent_forming: 'append_to_pool',
  intent_committed: 'classify',
  executing: 'classify',
  intent_satisfied: 'new_session',
  closed: 'new_session',
};

const EXPECTED_ROUTING_DISPOSITIONS: readonly RoutingDisposition[] = [
  'refinement',
  'switch',
  'parallel',
  'meta',
] as const;

const EXPECTED_ROUTING_EFFECTS: Record<RoutingDisposition, RoutingEffect> = {
  refinement: { opens_new_session: false, closes_active_session: false },
  switch: { opens_new_session: true, closes_active_session: true },
  parallel: { opens_new_session: true, closes_active_session: false },
  meta: { opens_new_session: false, closes_active_session: false },
};

const tryRuntimeMutation = (mutate: () => void): void => {
  try {
    mutate();
  } catch {
    /* strict mode throws — frozen registry */
  }
};

describe('D-153 P7 — SESSION_LIFECYCLE_STATES / isSessionLifecycleState', () => {
  it('SESSION_LIFECYCLE_STATES is the exact forward-order closed list', () => {
    // This would fail if a lifecycle state was added, removed, or reordered.
    expect(SESSION_LIFECYCLE_STATES).toEqual(EXPECTED_SESSION_LIFECYCLE_STATES);
  });

  it('isSessionLifecycleState accepts every closed-list value', () => {
    // This would fail if the predicate drifted from the exported lifecycle list.
    for (const state of EXPECTED_SESSION_LIFECYCLE_STATES) {
      expect(isSessionLifecycleState(state)).toBe(true);
    }
  });

  it('isSessionLifecycleState rejects unknown strings and non-strings', () => {
    // This would fail if arbitrary strings or JSON values were accepted as states.
    for (const value of [
      'intent-forming',
      'intent_pending',
      'closed ',
      '',
      42,
      null,
      undefined,
      {},
      [],
    ]) {
      expect(isSessionLifecycleState(value)).toBe(false);
    }
  });
});

describe('D-153 P7 — terminal lifecycle state', () => {
  it('isTerminalLifecycleState returns true only for closed', () => {
    // This would fail if any non-final state became terminal or closed stopped being terminal.
    for (const state of EXPECTED_SESSION_LIFECYCLE_STATES) {
      expect(isTerminalLifecycleState(state)).toBe(state === 'closed');
    }
  });
});

describe('D-153 P7 — LIFECYCLE_TRANSITIONS / canTransitionLifecycle', () => {
  it('LIFECYCLE_TRANSITIONS is the exact lifecycle adjacency', () => {
    // This would fail if any legal edge was added, removed, or moved to the wrong state.
    expect(LIFECYCLE_TRANSITIONS).toEqual(EXPECTED_LIFECYCLE_TRANSITIONS);
  });

  it('canTransitionLifecycle returns true for every legal edge', () => {
    // This would fail if the predicate stopped reading the legal adjacency.
    for (const [from, targets] of Object.entries(EXPECTED_LIFECYCLE_TRANSITIONS)) {
      for (const to of targets) {
        expect(canTransitionLifecycle(from as SessionLifecycleState, to)).toBe(true);
      }
    }
  });

  it('canTransitionLifecycle rejects self-edges, backward edges, skip-forward edges, and closed exits', () => {
    // This would fail if the lifecycle started permitting regressions or illegal shortcuts.
    for (const state of EXPECTED_SESSION_LIFECYCLE_STATES) {
      expect(canTransitionLifecycle(state, state)).toBe(false);
    }

    for (let fromIndex = 1; fromIndex < EXPECTED_SESSION_LIFECYCLE_STATES.length; fromIndex += 1) {
      const from = EXPECTED_SESSION_LIFECYCLE_STATES[fromIndex];
      for (let toIndex = 0; toIndex < fromIndex; toIndex += 1) {
        expect(canTransitionLifecycle(from, EXPECTED_SESSION_LIFECYCLE_STATES[toIndex]))
          .toBe(false);
      }
    }

    expect(canTransitionLifecycle('intent_forming', 'executing')).toBe(false);
    expect(canTransitionLifecycle('intent_forming', 'intent_satisfied')).toBe(false);
    for (const to of EXPECTED_SESSION_LIFECYCLE_STATES) {
      expect(canTransitionLifecycle('closed', to)).toBe(false);
    }
  });

  it('every lifecycle edge moves strictly forward in the state order', () => {
    // This would fail if the registry gained a hidden backward edge despite type compatibility.
    const order = Object.fromEntries(
      EXPECTED_SESSION_LIFECYCLE_STATES.map((state, index) => [state, index]),
    ) as Record<SessionLifecycleState, number>;
    for (const from of EXPECTED_SESSION_LIFECYCLE_STATES) {
      const fromIndex = order[from];
      for (const to of LIFECYCLE_TRANSITIONS[from]) {
        expect(order[to]).toBeGreaterThan(fromIndex);
      }
    }
  });

  it('closed is reachable from every non-closed lifecycle state', () => {
    // This would fail if a non-terminal branch became a dead end.
    for (const start of EXPECTED_SESSION_LIFECYCLE_STATES.filter((state) => state !== 'closed')) {
      const seen = new Set<SessionLifecycleState>();
      const queue: SessionLifecycleState[] = [start];
      while (queue.length > 0) {
        const state = queue.shift();
        if (!state || seen.has(state)) continue;
        seen.add(state);
        queue.push(...LIFECYCLE_TRANSITIONS[state]);
      }
      expect(seen.has('closed')).toBe(true);
    }
  });

  it('freezes the transition registry and each adjacency array against runtime mutation', () => {
    // This would fail if the boot-time graph could be corrupted after module load.
    expect(Object.isFrozen(LIFECYCLE_TRANSITIONS)).toBe(true);
    for (const state of EXPECTED_SESSION_LIFECYCLE_STATES) {
      expect(Object.isFrozen(LIFECYCLE_TRANSITIONS[state])).toBe(true);
    }

    const beforeRegistryValue = LIFECYCLE_TRANSITIONS.intent_forming;
    tryRuntimeMutation(() => {
      (LIFECYCLE_TRANSITIONS as unknown as Record<string, SessionLifecycleState[]>)
        .intent_forming = ['executing'];
    });
    expect(LIFECYCLE_TRANSITIONS.intent_forming).toBe(beforeRegistryValue);

    for (const state of EXPECTED_SESSION_LIFECYCLE_STATES) {
      const beforeTargets = [...LIFECYCLE_TRANSITIONS[state]];
      tryRuntimeMutation(() => {
        (LIFECYCLE_TRANSITIONS[state] as unknown as SessionLifecycleState[]).push('closed');
      });
      expect(LIFECYCLE_TRANSITIONS[state]).toEqual(beforeTargets);
    }
  });
});

describe('D-153 P7 — input-pool constants / commit reasons', () => {
  it('pins the input-pool cap constants', () => {
    // This would fail if the placeholder cap calibration changed without review.
    expect(INPUT_POOL_MAX_MESSAGES).toBe(5);
    expect(INPUT_POOL_WINDOW_MS).toBe(30_000);
  });

  it('INPUT_POOL_COMMIT_REASONS is the exact two-reason closed list', () => {
    // This would fail if a new force-commit reason entered the audit surface.
    expect(INPUT_POOL_COMMIT_REASONS).toEqual(EXPECTED_INPUT_POOL_COMMIT_REASONS);
  });

  it('isInputPoolCommitReason accepts every closed-list value', () => {
    // This would fail if the predicate drifted from the exported reason list.
    for (const reason of EXPECTED_INPUT_POOL_COMMIT_REASONS) {
      expect(isInputPoolCommitReason(reason)).toBe(true);
    }
  });

  it('isInputPoolCommitReason rejects unknown strings and non-strings', () => {
    // This would fail if arbitrary commit reasons were accepted from the wire.
    for (const value of ['count', 'elapsed', 'window-elapsed', '', 42, null, undefined, {}, []]) {
      expect(isInputPoolCommitReason(value)).toBe(false);
    }
  });
});

describe('D-153 P7 — openInputPool', () => {
  it('opens a pool at now with the session-creating message already counted', () => {
    // This would fail if the first message was lost from the count cap.
    const now = 1_700_000_000_000;
    expect(openInputPool(now)).toEqual({
      opened_at: now,
      message_count: 1,
    });
  });
});

describe('D-153 P7 — evaluateInputPool', () => {
  it('force-commits with count_cap as soon as message_count reaches the cap', () => {
    // This would fail if the boundary was off by one or count commits were ignored.
    const openedAt = 10_000;
    const result = evaluateInputPool(
      { opened_at: openedAt, message_count: INPUT_POOL_MAX_MESSAGES - 1 },
      1,
      openedAt + 1_000,
    );

    expect(result).toEqual({
      next_state: {
        opened_at: openedAt,
        message_count: INPUT_POOL_MAX_MESSAGES,
      },
      should_commit: true,
      commit_reason: 'count_cap',
      commit_due_at: openedAt + INPUT_POOL_WINDOW_MS,
    });
  });

  it('force-commits with window_elapsed once now reaches the window cap', () => {
    // This would fail if the timer tick path failed to close an old input pool.
    const openedAt = 10_000;
    const result = evaluateInputPool(
      { opened_at: openedAt, message_count: INPUT_POOL_MAX_MESSAGES - 1 },
      0,
      openedAt + INPUT_POOL_WINDOW_MS,
    );

    expect(result).toEqual({
      next_state: {
        opened_at: openedAt,
        message_count: INPUT_POOL_MAX_MESSAGES - 1,
      },
      should_commit: true,
      commit_reason: 'window_elapsed',
      commit_due_at: openedAt + INPUT_POOL_WINDOW_MS,
    });
  });

  it('uses count_cap when count and window caps are hit in the same evaluation', () => {
    // This would fail if simultaneous caps produced nondeterministic or window-first reasons.
    const openedAt = 10_000;
    const result = evaluateInputPool(
      { opened_at: openedAt, message_count: INPUT_POOL_MAX_MESSAGES - 1 },
      1,
      openedAt + INPUT_POOL_WINDOW_MS,
    );

    expect(result.should_commit).toBe(true);
    expect(result.commit_reason).toBe('count_cap');
    expect(result.next_state.message_count).toBe(INPUT_POOL_MAX_MESSAGES);
  });

  it('returns no commit before both caps and preserves the previous state object', () => {
    // This would fail if evaluateInputPool mutated the caller's persisted state or committed early.
    const prev = { opened_at: 20_000, message_count: 2 };
    const result = evaluateInputPool(prev, 1, prev.opened_at + INPUT_POOL_WINDOW_MS - 1);

    expect(result).toEqual({
      next_state: {
        opened_at: prev.opened_at,
        message_count: 3,
      },
      should_commit: false,
      commit_reason: null,
      commit_due_at: prev.opened_at + INPUT_POOL_WINDOW_MS,
    });
    expect(prev).toEqual({ opened_at: 20_000, message_count: 2 });
    expect(result.next_state).not.toBe(prev);
  });

  it('clamps malformed messages_arrived values before updating message_count', () => {
    // This would fail if negative, fractional, NaN, or Infinity counts polluted the pool state.
    const prev = { opened_at: 30_000, message_count: 2 };
    const now = prev.opened_at + 1_000;

    expect(evaluateInputPool(prev, -3, now).next_state.message_count).toBe(2);
    expect(evaluateInputPool(prev, 1.9, now).next_state.message_count).toBe(3);

    for (const arrived of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluateInputPool(prev, arrived, now);
      expect(Number.isFinite(result.next_state.message_count)).toBe(true);
      expect(result.next_state.message_count).toBe(2);
      expect(result.should_commit).toBe(false);
      expect(result.commit_reason).toBeNull();
    }
  });

  it('does not trigger the window cap when now is earlier than opened_at', () => {
    // This would fail if clock skew was treated as elapsed age.
    const prev = { opened_at: 50_000, message_count: 1 };
    expect(evaluateInputPool(prev, 0, prev.opened_at - 1)).toEqual({
      next_state: prev,
      should_commit: false,
      commit_reason: null,
      commit_due_at: prev.opened_at + INPUT_POOL_WINDOW_MS,
    });
  });

  it('derives should_commit solely from whether commit_reason is present', () => {
    // This would fail if the boolean and reason could disagree.
    const openedAt = 60_000;
    const cases = [
      evaluateInputPool({ opened_at: openedAt, message_count: 1 }, 0, openedAt),
      evaluateInputPool(
        { opened_at: openedAt, message_count: INPUT_POOL_MAX_MESSAGES - 1 },
        1,
        openedAt,
      ),
      evaluateInputPool(
        { opened_at: openedAt, message_count: 1 },
        0,
        openedAt + INPUT_POOL_WINDOW_MS,
      ),
    ];

    for (const result of cases) {
      expect(result.should_commit).toBe(result.commit_reason !== null);
    }
  });
});

describe('D-153 P7 — MESSAGE_ROUTINGS / resolveMessageRouting', () => {
  it('MESSAGE_ROUTINGS is the exact three-routing closed list', () => {
    // This would fail if the outer deterministic dispatch grew an unreviewed route.
    expect(MESSAGE_ROUTINGS).toEqual(EXPECTED_MESSAGE_ROUTINGS);
  });

  it('isMessageRouting accepts every closed-list value', () => {
    // This would fail if the predicate drifted from the exported routing list.
    for (const routing of EXPECTED_MESSAGE_ROUTINGS) {
      expect(isMessageRouting(routing)).toBe(true);
    }
  });

  it('isMessageRouting rejects unknown strings and non-strings', () => {
    // This would fail if arbitrary message-routing values were accepted.
    for (const value of ['append', 'classify ', 'new-session', '', 42, null, undefined, {}, []]) {
      expect(isMessageRouting(value)).toBe(false);
    }
  });

  it('MESSAGE_ROUTING_BY_STATE maps every lifecycle state to the documented route', () => {
    // This would fail if a lifecycle state routed to the wrong deterministic branch.
    expect(MESSAGE_ROUTING_BY_STATE).toEqual(EXPECTED_MESSAGE_ROUTING_BY_STATE);
  });

  it('resolveMessageRouting returns the documented route for every lifecycle state', () => {
    // This would fail if the resolver diverged from the state-routing registry.
    for (const state of EXPECTED_SESSION_LIFECYCLE_STATES) {
      expect(resolveMessageRouting(state)).toBe(EXPECTED_MESSAGE_ROUTING_BY_STATE[state]);
    }
  });
});

describe('D-153 P7 — ROUTING_DISPOSITIONS / isRoutingClassification', () => {
  it('ROUTING_DISPOSITIONS is the exact four-disposition closed list', () => {
    // This would fail if cognition could emit an unreviewed structural disposition.
    expect(ROUTING_DISPOSITIONS).toEqual(EXPECTED_ROUTING_DISPOSITIONS);
  });

  it('isRoutingDisposition accepts every closed-list value', () => {
    // This would fail if the predicate drifted from the exported disposition list.
    for (const disposition of EXPECTED_ROUTING_DISPOSITIONS) {
      expect(isRoutingDisposition(disposition)).toBe(true);
    }
  });

  it('isRoutingDisposition rejects unknown strings and non-strings', () => {
    // This would fail if arbitrary classifier dispositions were accepted.
    for (const value of ['cancel', 'refine', 'parallel ', '', 42, null, undefined, {}, []]) {
      expect(isRoutingDisposition(value)).toBe(false);
    }
  });

  it('isRoutingClassification accepts valid classifier output shapes', () => {
    // This would fail if optional confidence / reasoning metadata was rejected at valid bounds.
    for (const classification of [
      { disposition: 'refinement' },
      { disposition: 'switch', confidence: 0, reasoning: '' },
      { disposition: 'parallel', confidence: 1, reasoning: 'new independent intent' },
      { disposition: 'meta', confidence: 0.5 },
    ]) {
      expect(isRoutingClassification(classification)).toBe(true);
    }
  });

  it('isRoutingClassification rejects invalid disposition values', () => {
    // This would fail if cognition output could bypass the disposition closed list.
    for (const classification of [
      { disposition: 'cancel' },
      { disposition: 'refinement ' },
      { disposition: 42 },
      {},
      null,
      [],
    ]) {
      expect(isRoutingClassification(classification)).toBe(false);
    }
  });

  it('isRoutingClassification rejects out-of-range or non-finite confidence', () => {
    // This would fail if confidence stopped being a finite [0, 1] score.
    for (const confidence of [
      -0.001,
      1.001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '0.5',
    ]) {
      expect(isRoutingClassification({
        disposition: 'refinement',
        confidence,
      })).toBe(false);
    }
  });

  it('isRoutingClassification rejects non-string reasoning', () => {
    // This would fail if structured or null reasoning leaked into the audit-facing shape.
    for (const reasoning of [42, null, {}, []]) {
      expect(isRoutingClassification({
        disposition: 'meta',
        reasoning,
      })).toBe(false);
    }
  });
});

describe('D-153 P7 — ROUTING_EFFECTS / lookupRoutingEffect', () => {
  it('ROUTING_EFFECTS stores the exact structural effect for every disposition', () => {
    // This would fail if a disposition opened or closed sessions differently.
    expect(ROUTING_EFFECTS).toEqual(EXPECTED_ROUTING_EFFECTS);
  });

  it('lookupRoutingEffect returns each disposition effect from the registry', () => {
    // This would fail if the lookup synthesized, cloned, or mis-keyed an effect.
    for (const disposition of EXPECTED_ROUTING_DISPOSITIONS) {
      expect(lookupRoutingEffect(disposition)).toBe(ROUTING_EFFECTS[disposition]);
      expect(lookupRoutingEffect(disposition)).toEqual(EXPECTED_ROUTING_EFFECTS[disposition]);
    }
  });

  it('closes_active_session always implies opens_new_session', () => {
    // This would fail if a bare cancel entered the routing-effect surface.
    for (const disposition of EXPECTED_ROUTING_DISPOSITIONS) {
      const effect = ROUTING_EFFECTS[disposition];
      if (effect.closes_active_session) {
        expect(effect.opens_new_session).toBe(true);
      }
    }
  });
});

describe('D-153 P7 — assertSessionRoutingInvariants', () => {
  it('does not throw on the shipped P7 registries', () => {
    // This would fail if the exported registries violated their boot-time invariants.
    expect(() => assertSessionRoutingInvariants()).not.toThrow();
  });
});

describe('D-153 P7 — session_lifecycle broadcast registration', () => {
  it('registers session_lifecycle as a known broadcast event kind', () => {
    // This would fail if paired clients could not subscribe to lifecycle transitions.
    expect(ALL_BROADCAST_EVENT_KINDS).toContain('session_lifecycle');
  });

  it('subscribes paired clients to session_lifecycle by default', () => {
    // This would fail if paired clients had to poll for session spinner / done-badge updates.
    expect(DEFAULT_SUBSCRIPTIONS).toContain('session_lifecycle');
  });
});

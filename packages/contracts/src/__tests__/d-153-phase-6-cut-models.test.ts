/** D-153 P6 — Cut models per channel.
 *
 *  Pins the pure contracts from packages/contracts/src/cut-models.ts:
 *  cut-authority narrowing, per-channel cut-model registry, authority
 *  resolution, active-tree quiescence, debounce and plan-completion
 *  evaluators, scheduling classification, and derived-session links.
 *
 *  Spec: D-153 § Cut models — three modes (lines
 *  535-551). */

import { describe, expect, it } from 'vitest';

import {
  CHANNELS,
  CHANNEL_CUT_MODELS,
  CUT_AUTHORITIES,
  FRESH_DEBOUNCE_STATE,
  SCHEDULING_CLASSES,
  assertCutModelInvariants,
  classifyChildScheduling,
  evaluateDebounceCut,
  evaluatePlanCompletionCut,
  isCutAuthority,
  isDerivedSession,
  isSchedulingClass,
  isTreeActive,
  isTreeQuiescent,
  lookupCutModel,
  resolveCutAuthority,
  type ActiveTreeState,
  type Channel,
  type ChannelCutModel,
  type CutAuthority,
  type DebounceTrackerState,
  type SchedulingClass,
} from '@recued/contracts';

const EXPECTED_CUT_AUTHORITIES: readonly CutAuthority[] = [
  'debounce',
  'plan_completion',
  'cognition_driven',
] as const;

const EXPECTED_CHANNELS: readonly Channel[] = [
  'user',
  'chat',
  'mcp',
  'messenger',
  'reception',
  'webhook',
  'schedule',
  'reactive',
  'housekeeping',
] as const;

const EXPECTED_CHANNEL_CUT_MODELS: Record<Channel, ChannelCutModel> = {
  user: {
    channel: 'user',
    base_authority: 'debounce',
    cognition_eligible: false,
    debounce_threshold_ms: 600_000,
  },
  chat: {
    channel: 'chat',
    base_authority: 'debounce',
    cognition_eligible: true,
    debounce_threshold_ms: 1_800_000,
  },
  mcp: {
    channel: 'mcp',
    base_authority: 'debounce',
    cognition_eligible: false,
    debounce_threshold_ms: 900_000,
  },
  messenger: {
    channel: 'messenger',
    base_authority: 'debounce',
    cognition_eligible: true,
    debounce_threshold_ms: 1_800_000,
  },
  reception: {
    channel: 'reception',
    base_authority: 'debounce',
    cognition_eligible: false,
    debounce_threshold_ms: 300_000,
  },
  webhook: {
    channel: 'webhook',
    base_authority: 'plan_completion',
    cognition_eligible: false,
    debounce_threshold_ms: null,
  },
  schedule: {
    channel: 'schedule',
    base_authority: 'plan_completion',
    cognition_eligible: false,
    debounce_threshold_ms: null,
  },
  reactive: {
    channel: 'reactive',
    base_authority: 'plan_completion',
    cognition_eligible: false,
    debounce_threshold_ms: null,
  },
  housekeeping: {
    channel: 'housekeeping',
    base_authority: 'plan_completion',
    cognition_eligible: false,
    debounce_threshold_ms: null,
  },
};

const EXPECTED_SCHEDULING_CLASSES: readonly SchedulingClass[] = [
  'synchronous',
  'asynchronous',
] as const;

const QUIESCENT_TREE: ActiveTreeState = {
  running_children: 0,
  pending_llm: 0,
  open_approvals: 0,
  scheduled_within_window: 0,
};

const makeTree = (
  overrides: Partial<ActiveTreeState> = {},
): ActiveTreeState => ({
  ...QUIESCENT_TREE,
  ...overrides,
});

describe('D-153 P6 — CUT_AUTHORITIES / isCutAuthority', () => {
  it('CUT_AUTHORITIES is the exact three-authority closed list', () => {
    // This would fail if unreviewed cut authorities entered the closed list.
    expect(CUT_AUTHORITIES).toEqual(EXPECTED_CUT_AUTHORITIES);
  });

  it('isCutAuthority accepts every closed-list value', () => {
    // This would fail if the predicate drifted from the exported constant.
    for (const authority of CUT_AUTHORITIES) {
      expect(isCutAuthority(authority)).toBe(true);
    }
  });

  it('isCutAuthority rejects unknown strings and non-strings', () => {
    // This would fail if arbitrary strings or JSON values were accepted as authorities.
    for (const value of [
      'plan-completion',
      'cognition',
      'unknown',
      '',
      42,
      null,
      undefined,
      {},
      [],
    ]) {
      expect(isCutAuthority(value)).toBe(false);
    }
  });
});

describe('D-153 P6 — CHANNEL_CUT_MODELS / lookupCutModel', () => {
  it('CHANNEL_CUT_MODELS is the exact nine-channel registry', () => {
    // This would fail if the registry added, removed, or reordered a channel.
    expect(CHANNELS).toEqual(EXPECTED_CHANNELS);
    expect(Object.keys(CHANNEL_CUT_MODELS)).toEqual(EXPECTED_CHANNELS);
  });

  it('CHANNEL_CUT_MODELS marks only chat and messenger as cognition_eligible', () => {
    // This would fail if cognition eligibility leaked to a non-conversational channel.
    expect(
      EXPECTED_CHANNELS.filter((channel) => CHANNEL_CUT_MODELS[channel].cognition_eligible),
    ).toEqual(['chat', 'messenger']);
  });

  it('CHANNEL_CUT_MODELS assigns exact debounce authorities and thresholds to non-system channels', () => {
    // This would fail if any non-system channel stopped using its documented debounce window.
    for (const channel of ['user', 'chat', 'mcp', 'messenger', 'reception'] as const) {
      expect(CHANNEL_CUT_MODELS[channel]).toMatchObject({
        base_authority: 'debounce',
        debounce_threshold_ms: EXPECTED_CHANNEL_CUT_MODELS[channel].debounce_threshold_ms,
      });
      expect(CHANNEL_CUT_MODELS[channel].debounce_threshold_ms).not.toBeNull();
    }
  });

  it('CHANNEL_CUT_MODELS assigns plan_completion and null thresholds to system channels', () => {
    // This would fail if a system channel accidentally inherited debounce semantics.
    for (const channel of ['webhook', 'schedule', 'reactive', 'housekeeping'] as const) {
      expect(CHANNEL_CUT_MODELS[channel]).toMatchObject({
        base_authority: 'plan_completion',
        debounce_threshold_ms: null,
        cognition_eligible: false,
      });
    }
  });

  it('CHANNEL_CUT_MODELS stores the exact documented model object for every channel', () => {
    // This would fail if a per-channel authority, threshold, or eligibility bit drifted.
    expect(CHANNEL_CUT_MODELS).toEqual(EXPECTED_CHANNEL_CUT_MODELS);
  });

  it('lookupCutModel returns the registry object for every channel', () => {
    // This would fail if lookupCutModel cloned, synthesized, or mis-keyed a channel model.
    for (const channel of EXPECTED_CHANNELS) {
      expect(lookupCutModel(channel)).toBe(CHANNEL_CUT_MODELS[channel]);
    }
  });
});

describe('D-153 P6 — resolveCutAuthority', () => {
  it('returns cognition_driven only for cognition_eligible channels with cognition in the loop', () => {
    // This would fail if cognition_in_loop upgraded an ineligible channel.
    for (const channel of EXPECTED_CHANNELS) {
      const expected = CHANNEL_CUT_MODELS[channel].cognition_eligible
        ? 'cognition_driven'
        : CHANNEL_CUT_MODELS[channel].base_authority;
      expect(resolveCutAuthority(channel, true)).toBe(expected);
    }
  });

  it('returns base_authority when cognition_in_loop is false', () => {
    // This would fail if disabled cognition still changed the resolved authority.
    for (const channel of EXPECTED_CHANNELS) {
      expect(resolveCutAuthority(channel, false))
        .toBe(CHANNEL_CUT_MODELS[channel].base_authority);
    }
  });

  it('defaults cognition_in_loop to false', () => {
    // This would fail if the default runtime accidentally became cognition-driven.
    for (const channel of EXPECTED_CHANNELS) {
      expect(resolveCutAuthority(channel))
        .toBe(CHANNEL_CUT_MODELS[channel].base_authority);
    }
  });
});

describe('D-153 P6 — assertCutModelInvariants', () => {
  it('does not throw on the shipped registry', () => {
    // This would fail if the exported registry violated its boot-time invariants.
    expect(() => assertCutModelInvariants()).not.toThrow();
  });
});

describe('D-153 P6 — isTreeActive / isTreeQuiescent', () => {
  it('isTreeActive returns true iff any activity counter is non-zero', () => {
    // This would fail if any active-tree counter stopped participating in activity.
    expect(isTreeActive(QUIESCENT_TREE)).toBe(false);
    for (const field of [
      'running_children',
      'pending_llm',
      'open_approvals',
      'scheduled_within_window',
    ] as const) {
      expect(isTreeActive(makeTree({ [field]: 1 }))).toBe(true);
      expect(isTreeActive(makeTree({ [field]: -1 }))).toBe(true);
    }
  });

  it('isTreeQuiescent returns true iff all activity counters are zero', () => {
    // This would fail if quiescence stopped being the complement of tree activity.
    expect(isTreeQuiescent(QUIESCENT_TREE)).toBe(true);
    for (const field of [
      'running_children',
      'pending_llm',
      'open_approvals',
      'scheduled_within_window',
    ] as const) {
      expect(isTreeQuiescent(makeTree({ [field]: 1 }))).toBe(false);
    }
  });
});

describe('D-153 P6 — FRESH_DEBOUNCE_STATE', () => {
  it('is the exact fresh state with no quiescence stamp', () => {
    // This would fail if new sessions started with a running debounce countdown.
    expect(FRESH_DEBOUNCE_STATE).toEqual({ quiescent_since: null });
  });
});

describe('D-153 P6 — evaluateDebounceCut', () => {
  it('resets debounce state and never cuts while the tree is active', () => {
    // This would fail if active work could leave a stale quiescent_since countdown running.
    const prev: DebounceTrackerState = { quiescent_since: 10_000 };
    expect(evaluateDebounceCut(prev, makeTree({ running_children: 1 }), 600_000, 20_000))
      .toEqual({
        next_state: { quiescent_since: null },
        should_cut: false,
        cut_at: null,
      });
    expect(prev).toEqual({ quiescent_since: 10_000 });
  });

  it('stamps now when the tree is newly quiescent', () => {
    // This would fail if the debounce clock started before the work tree went quiet.
    const now = 1_700_000_000_000;
    expect(evaluateDebounceCut(FRESH_DEBOUNCE_STATE, QUIESCENT_TREE, 600_000, now))
      .toEqual({
        next_state: { quiescent_since: now },
        should_cut: false,
        cut_at: now + 600_000,
      });
  });

  it('keeps the earlier stamp while the tree remains quiescent', () => {
    // This would fail if repeated evaluations pushed the cut window forward forever.
    const prev: DebounceTrackerState = { quiescent_since: 1_000 };
    expect(evaluateDebounceCut(prev, QUIESCENT_TREE, 600, 1_500)).toEqual({
      next_state: { quiescent_since: 1_000 },
      should_cut: false,
      cut_at: 1_600,
    });
  });

  it('cuts once now reaches quiescent_since plus threshold', () => {
    // This would fail if the debounce boundary was off by one millisecond.
    expect(evaluateDebounceCut(
      { quiescent_since: 1_000 },
      QUIESCENT_TREE,
      600,
      1_600,
    )).toEqual({
      next_state: { quiescent_since: 1_000 },
      should_cut: true,
      cut_at: 1_600,
    });
  });

  it('clamps negative thresholds to zero for immediate quiescent cuts', () => {
    // This would fail if a negative threshold delayed or backdated the cut.
    const now = 5_000;
    expect(evaluateDebounceCut(
      { quiescent_since: null },
      QUIESCENT_TREE,
      -1,
      now,
    )).toEqual({
      next_state: { quiescent_since: now },
      should_cut: true,
      cut_at: now,
    });
  });

  it('preserves a quiescent_since value of zero', () => {
    // This would fail if the reducer treated timestamp 0 as an absent stamp
    // (a `|| now` reducer would re-stamp quiescent_since to 4_000 here).
    expect(evaluateDebounceCut(
      { quiescent_since: 0 },
      QUIESCENT_TREE,
      0,
      4_000,
    )).toEqual({
      next_state: { quiescent_since: 0 },
      should_cut: true,
      cut_at: 0,
    });
  });
});

describe('D-153 P6 — evaluatePlanCompletionCut', () => {
  it('returns false when plan_dispatched is false even for a quiescent tree', () => {
    // This would fail if an idle-but-not-dispatched plan could close early.
    expect(evaluatePlanCompletionCut(QUIESCENT_TREE, false)).toBe(false);
  });

  it('returns true only when plan_dispatched is true and the tree is fully quiescent', () => {
    // This would fail if plan completion ignored any active-tree counter.
    expect(evaluatePlanCompletionCut(QUIESCENT_TREE, true)).toBe(true);
    for (const field of [
      'running_children',
      'pending_llm',
      'open_approvals',
      'scheduled_within_window',
    ] as const) {
      expect(evaluatePlanCompletionCut(makeTree({ [field]: 1 }), true)).toBe(false);
    }
  });
});

describe('D-153 P6 — SCHEDULING_CLASSES / isSchedulingClass', () => {
  it('SCHEDULING_CLASSES is the exact two-class closed list', () => {
    // This would fail if scheduling gained an unreviewed third class.
    expect(SCHEDULING_CLASSES).toEqual(EXPECTED_SCHEDULING_CLASSES);
  });

  it('isSchedulingClass accepts every closed-list value', () => {
    // This would fail if the predicate drifted from the exported constant.
    for (const schedulingClass of SCHEDULING_CLASSES) {
      expect(isSchedulingClass(schedulingClass)).toBe(true);
    }
  });

  it('isSchedulingClass rejects unknown strings and non-strings', () => {
    // This would fail if arbitrary strings or JSON values were accepted as scheduling classes.
    for (const value of ['sync', 'async', 'unknown', '', 42, null, undefined, {}, []]) {
      expect(isSchedulingClass(value)).toBe(false);
    }
  });
});

describe('D-153 P6 — classifyChildScheduling', () => {
  it('classifies children due at or before the debounce window end as synchronous', () => {
    // This would fail if the synchronous window used a strict less-than boundary.
    const reference_at = 10_000;
    expect(classifyChildScheduling(reference_at, reference_at, 600)).toBe('synchronous');
    expect(classifyChildScheduling(reference_at + 600, reference_at, 600))
      .toBe('synchronous');
  });

  it('classifies children due after the debounce window end as asynchronous', () => {
    // This would fail if async spin-offs were still retained inside the parent session.
    const reference_at = 10_000;
    expect(classifyChildScheduling(reference_at + 601, reference_at, 600))
      .toBe('asynchronous');
  });

  it('classifies overdue children as synchronous', () => {
    // This would fail if overdue work was spun off instead of treated as due now.
    expect(classifyChildScheduling(9_999, 10_000, 0)).toBe('synchronous');
  });

  it('uses max(0, threshold), making strictly-future children asynchronous at threshold zero', () => {
    // This would fail if zero or negative debounce windows still admitted future children.
    expect(classifyChildScheduling(10_001, 10_000, 0)).toBe('asynchronous');
    expect(classifyChildScheduling(10_001, 10_000, -1)).toBe('asynchronous');
  });
});

describe('D-153 P6 — isDerivedSession', () => {
  it('returns true when derived_from_session_id is a non-empty string', () => {
    // This would fail if derived-session links required a separate flag.
    expect(isDerivedSession({ derived_from_session_id: 'parent-session' })).toBe(true);
    expect(isDerivedSession({ derived_from_session_id: ' ' })).toBe(true);
  });

  it('returns false for absent, undefined, null, empty-string, and non-string values', () => {
    // This would fail if missing or malformed derived_from_session_id values counted as links.
    expect(isDerivedSession({})).toBe(false);
    expect(isDerivedSession({ derived_from_session_id: undefined })).toBe(false);
    expect(isDerivedSession({ derived_from_session_id: null })).toBe(false);
    expect(isDerivedSession({ derived_from_session_id: '' })).toBe(false);
    expect(isDerivedSession({
      derived_from_session_id: 42 as unknown as string,
    })).toBe(false);
  });
});

/** D-138 Phase 5 — contract-layer acceptance tests for the upstream-
 *  merge outbox substrate.
 *
 *  Covers:
 *    - State machine reducer (every (state, event) pair the spec
 *      defines as valid; throw on every invalid pair)
 *    - Idempotency key — order-insensitive over candidate_ids +
 *      vendor_pairs; case-insensitive over survivor_email
 *    - Backoff schedule (exponential, capped, 0 on first attempt)
 *    - Predicate helpers (terminal / recoverable / dispatchable)
 *    - Closed-list registries (UPSTREAM_MERGE_VENDORS, …,
 *      UPSTREAM_MERGE_RPC_METHODS)
 *    - MCP-catalog ratchet — `upstream_merge.*` reserved as local-UI */

import { describe, expect, it } from 'vitest';

import {
  ALL_BROADCAST_EVENT_KINDS,
  MCP_RESERVED_RPC_PREFIXES,
  MCP_TOOL_CATALOG,
  UPSTREAM_MERGE_DISPATCHABLE_OBJECT_TYPES,
  UPSTREAM_MERGE_RETRY_BACKOFF_BASE_MS,
  UPSTREAM_MERGE_RETRY_BACKOFF_CAP_MS,
  UPSTREAM_MERGE_RETRY_BUDGET,
  UPSTREAM_MERGE_RPC_METHODS,
  UPSTREAM_MERGE_STATES,
  UPSTREAM_MERGE_VENDORS,
  computeUpstreamMergeIdempotencyKey,
  isMcpToolName,
  isReservedLocalRpc,
  isUpstreamMergeDispatchable,
  isUpstreamMergeRecoverable,
  isUpstreamMergeTerminal,
  nextUpstreamMergeState,
  upstreamMergeBackoffMs,
  type UpstreamMergeIdempotencyInput,
} from '../index.js';

// Tiny stub hash — concatenates a marker so tests can assert input
// canonicalization without needing real SHA256.
const hashStub = (canonical: string): string => `sha256:${canonical.length}:${canonical}`;

describe('D-138 P5 — upstream-merge state machine reducer', () => {
  it('approval_granted is idempotent from pending_vendor_merge only', () => {
    expect(nextUpstreamMergeState('pending_vendor_merge', { type: 'approval_granted' })).toBe(
      'pending_vendor_merge',
    );
    expect(() =>
      nextUpstreamMergeState('vendor_merge_in_flight', { type: 'approval_granted' }),
    ).toThrow(/invalid_transition/);
    expect(() =>
      nextUpstreamMergeState('local_merge_committed', { type: 'approval_granted' }),
    ).toThrow(/invalid_transition/);
  });

  it('vendor_call_started transitions pending → in_flight; idempotent on in_flight', () => {
    expect(nextUpstreamMergeState('pending_vendor_merge', { type: 'vendor_call_started' })).toBe(
      'vendor_merge_in_flight',
    );
    expect(nextUpstreamMergeState('vendor_merge_in_flight', { type: 'vendor_call_started' })).toBe(
      'vendor_merge_in_flight',
    );
    expect(() =>
      nextUpstreamMergeState('vendor_merge_succeeded', { type: 'vendor_call_started' }),
    ).toThrow(/invalid_transition/);
  });

  it('vendor_call_succeeded transitions in_flight → succeeded; idempotent on succeeded', () => {
    expect(
      nextUpstreamMergeState('vendor_merge_in_flight', { type: 'vendor_call_succeeded' }),
    ).toBe('vendor_merge_succeeded');
    expect(
      nextUpstreamMergeState('vendor_merge_succeeded', { type: 'vendor_call_succeeded' }),
    ).toBe('vendor_merge_succeeded');
    expect(() =>
      nextUpstreamMergeState('pending_vendor_merge', { type: 'vendor_call_succeeded' }),
    ).toThrow(/invalid_transition/);
  });

  it('vendor_call_failed_retryable stays in_flight (driver bumps attempts)', () => {
    expect(
      nextUpstreamMergeState('vendor_merge_in_flight', {
        type: 'vendor_call_failed_retryable',
        attempt: 1,
      }),
    ).toBe('vendor_merge_in_flight');
    expect(() =>
      nextUpstreamMergeState('vendor_merge_succeeded', {
        type: 'vendor_call_failed_retryable',
        attempt: 1,
      }),
    ).toThrow(/invalid_transition/);
  });

  it('vendor_call_failed_terminal transitions in_flight or pending → failed', () => {
    expect(
      nextUpstreamMergeState('vendor_merge_in_flight', {
        type: 'vendor_call_failed_terminal',
        reason: 'budget_exhausted',
      }),
    ).toBe('vendor_merge_failed');
    expect(
      nextUpstreamMergeState('pending_vendor_merge', {
        type: 'vendor_call_failed_terminal',
        reason: 'invalid_pair',
      }),
    ).toBe('vendor_merge_failed');
    expect(() =>
      nextUpstreamMergeState('local_merge_committed', {
        type: 'vendor_call_failed_terminal',
        reason: 'whatever',
      }),
    ).toThrow(/invalid_transition/);
  });

  it('local_step transitions through to terminal local_merge_committed', () => {
    expect(
      nextUpstreamMergeState('vendor_merge_succeeded', { type: 'local_step_started' }),
    ).toBe('vendor_merge_local_pending');
    expect(
      nextUpstreamMergeState('vendor_merge_local_pending', { type: 'local_step_committed' }),
    ).toBe('local_merge_committed');
    // Idempotent re-fire — replay produces the same terminal state.
    expect(
      nextUpstreamMergeState('local_merge_committed', { type: 'local_step_committed' }),
    ).toBe('local_merge_committed');
  });

  it('local_step_started rejects from non-succeeded states', () => {
    expect(() =>
      nextUpstreamMergeState('pending_vendor_merge', { type: 'local_step_started' }),
    ).toThrow(/invalid_transition/);
    expect(() =>
      nextUpstreamMergeState('vendor_merge_in_flight', { type: 'local_step_started' }),
    ).toThrow(/invalid_transition/);
    expect(() =>
      nextUpstreamMergeState('vendor_merge_failed', { type: 'local_step_started' }),
    ).toThrow(/invalid_transition/);
  });

  it('terminal states never rewind', () => {
    expect(() =>
      nextUpstreamMergeState('local_merge_committed', { type: 'vendor_call_started' }),
    ).toThrow(/invalid_transition/);
    expect(() =>
      nextUpstreamMergeState('vendor_merge_failed', { type: 'vendor_call_started' }),
    ).toThrow(/invalid_transition/);
  });

  it('every state in UPSTREAM_MERGE_STATES has a defined predicate result', () => {
    for (const state of UPSTREAM_MERGE_STATES) {
      // Predicates must not throw — they just return booleans.
      expect(typeof isUpstreamMergeTerminal(state)).toBe('boolean');
      expect(typeof isUpstreamMergeRecoverable(state)).toBe('boolean');
    }
  });

  it('terminal + recoverable predicates partition the state space correctly', () => {
    expect(isUpstreamMergeTerminal('local_merge_committed')).toBe(true);
    expect(isUpstreamMergeTerminal('vendor_merge_failed')).toBe(true);
    expect(isUpstreamMergeTerminal('pending_vendor_merge')).toBe(false);
    // P5 fold-back (Codex F3) — `pending_vendor_merge` is potentially
    // recoverable; the store query layer applies the additional
    // `same_user_auto_approve = true` row-level filter.
    expect(isUpstreamMergeRecoverable('pending_vendor_merge')).toBe(true);
    expect(isUpstreamMergeRecoverable('vendor_merge_in_flight')).toBe(true);
    expect(isUpstreamMergeRecoverable('vendor_merge_succeeded')).toBe(true);
    expect(isUpstreamMergeRecoverable('vendor_merge_local_pending')).toBe(true);
    expect(isUpstreamMergeRecoverable('local_merge_committed')).toBe(false);
    expect(isUpstreamMergeRecoverable('vendor_merge_failed')).toBe(false);
  });
});

describe('D-138 P5 — idempotency key', () => {
  const baseInput: UpstreamMergeIdempotencyInput = {
    vendor: 'hubspot',
    object_type: 'hubspot:contact',
    candidate_ids: ['cand_b', 'cand_a'],
    survivor_email: 'BOB@x.com',
    vendor_pairs: [
      { survivor_platform_id: 'hs_2', loser_platform_id: 'hs_1' },
      { survivor_platform_id: 'hs_2', loser_platform_id: 'hs_3' },
    ],
  };

  it('candidate_ids order does not affect the key', () => {
    const k1 = computeUpstreamMergeIdempotencyKey(baseInput, hashStub);
    const k2 = computeUpstreamMergeIdempotencyKey(
      { ...baseInput, candidate_ids: ['cand_a', 'cand_b'] },
      hashStub,
    );
    expect(k1).toBe(k2);
  });

  it('vendor_pairs order does not affect the key', () => {
    const k1 = computeUpstreamMergeIdempotencyKey(baseInput, hashStub);
    const k2 = computeUpstreamMergeIdempotencyKey(
      {
        ...baseInput,
        vendor_pairs: [
          { survivor_platform_id: 'hs_2', loser_platform_id: 'hs_3' },
          { survivor_platform_id: 'hs_2', loser_platform_id: 'hs_1' },
        ],
      },
      hashStub,
    );
    expect(k1).toBe(k2);
  });

  it('survivor_email is case-folded', () => {
    const k1 = computeUpstreamMergeIdempotencyKey(baseInput, hashStub);
    const k2 = computeUpstreamMergeIdempotencyKey(
      { ...baseInput, survivor_email: 'bob@X.COM' },
      hashStub,
    );
    expect(k1).toBe(k2);
  });

  it('different vendor_pairs produce a different key', () => {
    const k1 = computeUpstreamMergeIdempotencyKey(baseInput, hashStub);
    const k2 = computeUpstreamMergeIdempotencyKey(
      {
        ...baseInput,
        vendor_pairs: [{ survivor_platform_id: 'hs_2', loser_platform_id: 'hs_4' }],
      },
      hashStub,
    );
    expect(k1).not.toBe(k2);
  });

  it('different vendors produce different keys', () => {
    const k1 = computeUpstreamMergeIdempotencyKey(baseInput, hashStub);
    const k2 = computeUpstreamMergeIdempotencyKey(
      { ...baseInput, vendor: 'salesforce', object_type: 'salesforce:lead' },
      hashStub,
    );
    expect(k1).not.toBe(k2);
  });
});

describe('D-138 P5 — backoff schedule', () => {
  it('first attempt has zero delay', () => {
    expect(upstreamMergeBackoffMs(1)).toBe(0);
    expect(upstreamMergeBackoffMs(0)).toBe(0);
    expect(upstreamMergeBackoffMs(-5)).toBe(0);
  });

  it('exponential schedule from second attempt onward', () => {
    expect(upstreamMergeBackoffMs(2)).toBe(UPSTREAM_MERGE_RETRY_BACKOFF_BASE_MS); // 1000
    expect(upstreamMergeBackoffMs(3)).toBe(UPSTREAM_MERGE_RETRY_BACKOFF_BASE_MS * 2); // 2000
    expect(upstreamMergeBackoffMs(4)).toBe(UPSTREAM_MERGE_RETRY_BACKOFF_BASE_MS * 4); // 4000
  });

  it('caps at UPSTREAM_MERGE_RETRY_BACKOFF_CAP_MS', () => {
    expect(upstreamMergeBackoffMs(20)).toBeLessThanOrEqual(UPSTREAM_MERGE_RETRY_BACKOFF_CAP_MS);
    expect(upstreamMergeBackoffMs(20)).toBe(UPSTREAM_MERGE_RETRY_BACKOFF_CAP_MS);
  });

  it('UPSTREAM_MERGE_RETRY_BUDGET is 3 per spec', () => {
    expect(UPSTREAM_MERGE_RETRY_BUDGET).toBe(3);
  });
});

describe('D-138 P5 — dispatchable predicate', () => {
  it('HubSpot contact + Salesforce lead/account dispatch', () => {
    expect(isUpstreamMergeDispatchable('hubspot:contact')).toBe(true);
    expect(isUpstreamMergeDispatchable('salesforce:lead')).toBe(true);
    expect(isUpstreamMergeDispatchable('salesforce:account')).toBe(true);
  });

  it('Salesforce contact does NOT dispatch (degraded path)', () => {
    expect(isUpstreamMergeDispatchable('salesforce:contact')).toBe(false);
  });

  it('UPSTREAM_MERGE_DISPATCHABLE_OBJECT_TYPES set excludes salesforce:contact', () => {
    expect(UPSTREAM_MERGE_DISPATCHABLE_OBJECT_TYPES.has('salesforce:contact')).toBe(false);
    expect(UPSTREAM_MERGE_DISPATCHABLE_OBJECT_TYPES.has('hubspot:contact')).toBe(true);
  });
});

describe('D-138 P5 — closed-list registries', () => {
  it('UPSTREAM_MERGE_VENDORS lists hubspot + salesforce only', () => {
    expect([...UPSTREAM_MERGE_VENDORS].sort()).toEqual(['hubspot', 'salesforce']);
  });

  it('UPSTREAM_MERGE_RPC_METHODS covers describe / request / retry / discard / list', () => {
    expect([...UPSTREAM_MERGE_RPC_METHODS].sort()).toEqual([
      'upstream_merge.describe',
      'upstream_merge.discard',
      'upstream_merge.list',
      'upstream_merge.request',
      'upstream_merge.retry',
    ]);
  });

  it('upstream_merge_failed event kind is registered in the broadcast bus enum', () => {
    expect(ALL_BROADCAST_EVENT_KINDS).toContain('upstream_merge_failed');
  });
});

describe('D-138 P5 — MCP-catalog ratchet (Reviewer #12 widening)', () => {
  it('MCP_RESERVED_RPC_PREFIXES includes upstream_merge.', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('upstream_merge.');
  });

  it('every upstream_merge.* rpc is reserved as local-UI', () => {
    for (const method of UPSTREAM_MERGE_RPC_METHODS) {
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });

  it('no upstream_merge.* rpc method appears in MCP_TOOL_CATALOG', () => {
    for (const method of UPSTREAM_MERGE_RPC_METHODS) {
      expect(isMcpToolName(method)).toBe(false);
      expect(MCP_TOOL_CATALOG).not.toContain(method);
    }
  });
});

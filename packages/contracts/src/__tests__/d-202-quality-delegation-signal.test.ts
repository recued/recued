/** D-202 Slice 1 — the reject-driven quality LEARNER's pure logic: signal→key
 *  projection, the suppression-join key derived from a minted grant, and the
 *  reject-driven threshold (default-reason approves since the last reject, ≥
 *  threshold spanning ≥ threshold distinct sessions). Spec §2 / §6 / §8 / §12.3. */

import { describe, expect, it } from 'vitest';

import {
  QUALITY_DELEGATION_SUGGEST_LOOKBACK_MS,
  QUALITY_DELEGATION_SUGGEST_SAMPLE_REFS_MAX,
  QUALITY_DELEGATION_SUGGEST_THRESHOLD,
  deriveQualityDelegationKeyFromGrant,
  evaluateQualityDelegationSuggestionGroup,
  qualityDelegationSignalKey,
  type ContractDefinition,
  type QualityDelegationSignal,
  type QualityVerdictReason,
} from '../index.js';

const NOW = 1_800_100_000_000;

let seq = 0;
const signal = (
  overrides: Partial<QualityDelegationSignal> = {},
): QualityDelegationSignal => {
  seq += 1;
  return {
    signal_id: `sig_${seq}`,
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
    ingredient_id: 'mail.send',
    channel_session_id: `session-${seq}`,
    reason: 'quality_good',
    at: NOW - 1_000,
    ...overrides,
  };
};

/** A default-reason approve at `at` in its own session (so a group of these spans
 *  distinct sessions unless a `channel_session_id` override collapses them). */
const approve = (at: number, overrides: Partial<QualityDelegationSignal> = {}) =>
  signal({ reason: 'quality_good', at, ...overrides });
const reject = (at: number, overrides: Partial<QualityDelegationSignal> = {}) =>
  signal({ reason: 'quality_bad', at, ...overrides });

const grant = (overrides: Partial<ContractDefinition> = {}): ContractDefinition =>
  ({
    contract_id: 'ct_q1',
    minted_at: NOW - 5_000,
    grant_kind: 'quality_delegation',
    bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
    scope: { actors: ['user_self'], ingredient_ids: ['mail.send'] },
    ...overrides,
  }) as unknown as ContractDefinition;

describe('qualityDelegationSignalKey', () => {
  it('projects a signal onto the (recipe, op) key, omitting an absent op', () => {
    expect(qualityDelegationSignalKey(signal())).toEqual({
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      ingredient_id: 'mail.send',
    });
  });

  it('carries the op when present', () => {
    expect(qualityDelegationSignalKey(signal({ operation_id: 'mail.send.op' }))).toEqual({
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      ingredient_id: 'mail.send',
      operation_id: 'mail.send.op',
    });
  });

  it('fails closed on missing recipe identity or ingredient', () => {
    expect(qualityDelegationSignalKey(signal({ recipe_id: '' }))).toBeUndefined();
    expect(qualityDelegationSignalKey(signal({ recipe_hash: '' }))).toBeUndefined();
    expect(qualityDelegationSignalKey(signal({ ingredient_id: '' }))).toBeUndefined();
  });
});

describe('deriveQualityDelegationKeyFromGrant (suppression join)', () => {
  it('derives the (recipe, op) key a minted quality delegation occupies', () => {
    expect(deriveQualityDelegationKeyFromGrant(grant())).toEqual({
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      ingredient_id: 'mail.send',
    });
  });

  it('carries a single op, omits an absent op', () => {
    expect(
      deriveQualityDelegationKeyFromGrant(
        grant({ scope: { actors: ['user_self'], ingredient_ids: ['mail.send'], operation_ids: ['op-x'] } }),
      ),
    ).toEqual({
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      ingredient_id: 'mail.send',
      operation_id: 'op-x',
    });
  });

  it('fails closed on a non-quality-delegation grant', () => {
    expect(deriveQualityDelegationKeyFromGrant(grant({ grant_kind: 'session' }))).toBeUndefined();
    expect(deriveQualityDelegationKeyFromGrant(grant({ grant_kind: undefined }))).toBeUndefined();
  });

  it('fails closed on missing bound_recipe', () => {
    expect(deriveQualityDelegationKeyFromGrant(grant({ bound_recipe: undefined }))).toBeUndefined();
  });

  it('fails closed on a multi-valued ingredient or op axis (not the coarse grain)', () => {
    expect(
      deriveQualityDelegationKeyFromGrant(
        grant({ scope: { actors: ['user_self'], ingredient_ids: ['a', 'b'] } }),
      ),
    ).toBeUndefined();
    expect(
      deriveQualityDelegationKeyFromGrant(
        grant({ scope: { actors: ['user_self'], ingredient_ids: ['mail.send'], operation_ids: ['x', 'y'] } }),
      ),
    ).toBeUndefined();
  });

  it('the signal key and the grant key agree (round-trip for suppression)', () => {
    expect(deriveQualityDelegationKeyFromGrant(grant())).toEqual(
      qualityDelegationSignalKey(signal()),
    );
  });
});

describe('evaluateQualityDelegationSuggestionGroup — reject-driven threshold', () => {
  it('qualifies at THRESHOLD approves spanning THRESHOLD distinct sessions', () => {
    const signals = [approve(NOW - 3_000), approve(NOW - 2_000), approve(NOW - 1_000)];
    const result = evaluateQualityDelegationSuggestionGroup(signals, NOW);
    expect(result.qualifies).toBe(true);
    if (!result.qualifies) return;
    expect(result.evidence.approve_count).toBe(3);
    expect(result.evidence.distinct_session_count).toBe(3);
    expect(result.evidence.first_at).toBe(NOW - 3_000);
    expect(result.evidence.last_at).toBe(NOW - 1_000);
  });

  it('does not qualify below the approve threshold', () => {
    const signals = [approve(NOW - 2_000), approve(NOW - 1_000)];
    expect(evaluateQualityDelegationSuggestionGroup(signals, NOW).qualifies).toBe(false);
  });

  it('does not qualify when approves span too few DISTINCT sessions (one burst)', () => {
    const signals = [
      approve(NOW - 3_000, { channel_session_id: 'same' }),
      approve(NOW - 2_000, { channel_session_id: 'same' }),
      approve(NOW - 1_000, { channel_session_id: 'same' }),
    ];
    expect(evaluateQualityDelegationSuggestionGroup(signals, NOW).qualifies).toBe(false);
  });

  it('a reject knocks confidence down: approves BEFORE the newest reject do not count', () => {
    const signals = [
      approve(NOW - 4_000),
      approve(NOW - 3_000),
      approve(NOW - 2_000),
      reject(NOW - 1_000), // newest — knocks the three prior approves down
    ];
    expect(evaluateQualityDelegationSuggestionGroup(signals, NOW).qualifies).toBe(false);
  });

  it('re-earns on fresh approves AFTER the reject', () => {
    const signals = [
      approve(NOW - 6_000),
      reject(NOW - 5_000),
      approve(NOW - 3_000),
      approve(NOW - 2_000),
      approve(NOW - 1_000), // three approves strictly after the reject
    ];
    const result = evaluateQualityDelegationSuggestionGroup(signals, NOW);
    expect(result.qualifies).toBe(true);
    if (!result.qualifies) return;
    // Only the three post-reject approves count.
    expect(result.evidence.approve_count).toBe(3);
    expect(result.evidence.first_at).toBe(NOW - 3_000);
  });

  it('an approve at the exact reject instant does NOT count (strictly-after tie-break)', () => {
    const signals = [
      approve(NOW - 2_000, { channel_session_id: 's-a' }),
      approve(NOW - 2_000, { channel_session_id: 's-b' }),
      reject(NOW - 2_000, { channel_session_id: 's-r' }),
      approve(NOW - 2_000, { channel_session_id: 's-c' }),
    ];
    // Every approve is at-or-before the reject instant → none re-earn.
    expect(evaluateQualityDelegationSuggestionGroup(signals, NOW).qualifies).toBe(false);
  });

  it('only default reasons train: an override `policy` reject does NOT knock down', () => {
    const signals: QualityDelegationSignal[] = [
      approve(NOW - 3_000),
      approve(NOW - 2_000),
      approve(NOW - 1_000),
      // a policy-coded reject routes to the authorization axis — never touches
      // quality confidence, so the three approves still qualify.
      reject(NOW - 500, { reason: 'policy' as QualityVerdictReason }),
    ];
    expect(evaluateQualityDelegationSuggestionGroup(signals, NOW).qualifies).toBe(true);
  });

  it('only default reasons train: `ship_anyway` approves do NOT count', () => {
    const signals: QualityDelegationSignal[] = [
      signal({ reason: 'ship_anyway', at: NOW - 3_000 }),
      signal({ reason: 'ship_anyway', at: NOW - 2_000 }),
      signal({ reason: 'ship_anyway', at: NOW - 1_000 }),
    ];
    expect(evaluateQualityDelegationSuggestionGroup(signals, NOW).qualifies).toBe(false);
  });

  it('stale verdicts outside the lookback window do not count', () => {
    const stale = NOW - QUALITY_DELEGATION_SUGGEST_LOOKBACK_MS - 1;
    const signals = [approve(stale), approve(stale - 1_000), approve(stale - 2_000)];
    expect(evaluateQualityDelegationSuggestionGroup(signals, NOW).qualifies).toBe(false);
  });

  it('caps + orders the evidence sample refs newest-first, preferring audit_ref', () => {
    const signals = Array.from({ length: QUALITY_DELEGATION_SUGGEST_SAMPLE_REFS_MAX + 2 }, (_, i) =>
      approve(NOW - (i + 1) * 1_000, {
        channel_session_id: `s-${i}`,
        signal_id: `sig-${i}`,
        audit_ref: `run-${i}`,
      }),
    );
    const result = evaluateQualityDelegationSuggestionGroup(signals, NOW);
    expect(result.qualifies).toBe(true);
    if (!result.qualifies) return;
    expect(result.evidence.sample_refs).toHaveLength(QUALITY_DELEGATION_SUGGEST_SAMPLE_REFS_MAX);
    // Newest-first: i=0 is the newest (at NOW - 1_000), and audit_ref is preferred.
    expect(result.evidence.sample_refs[0]).toBe('run-0');
    expect(result.evidence.approve_count).toBe(QUALITY_DELEGATION_SUGGEST_SAMPLE_REFS_MAX + 2);
  });

  it('falls back to signal_id when a verdict carries no audit_ref', () => {
    const signals = [
      approve(NOW - 3_000, { channel_session_id: 's1', signal_id: 'sig-a' }),
      approve(NOW - 2_000, { channel_session_id: 's2', signal_id: 'sig-b' }),
      approve(NOW - 1_000, { channel_session_id: 's3', signal_id: 'sig-c' }),
    ];
    const result = evaluateQualityDelegationSuggestionGroup(signals, NOW);
    expect(result.qualifies).toBe(true);
    if (!result.qualifies) return;
    expect(result.evidence.sample_refs).toEqual(['sig-c', 'sig-b', 'sig-a']);
  });

  it('the threshold constants are the D-177-aligned defaults', () => {
    expect(QUALITY_DELEGATION_SUGGEST_THRESHOLD).toBe(3);
    expect(QUALITY_DELEGATION_SUGGEST_LOOKBACK_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

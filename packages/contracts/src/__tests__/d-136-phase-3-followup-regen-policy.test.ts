/** D-136 P3 follow-up — `regen_policy` types + closed lists.
 *
 *  Locks the closed-list enum membership (any addition forces a spec
 *  amendment) + the `RegenPolicy` type shape. The validator
 *  living in `@recued/ingredients` carries the per-manifest gate test;
 *  this file is the contracts-package boundary check.
 *
 *  Spec: `docs/d-136-spec.md` §A.4 + audit §27.2. */

import { describe, expect, it } from 'vitest';

import {
  REGEN_DETERMINISMS,
  REGEN_INPUT_INVARIANTS,
  REGEN_TRIGGERS,
  type RegenDeterminism,
  type RegenInputInvariant,
  type RegenPolicy,
  type RegenTrigger,
} from '../index.js';

describe('D-136 P3 follow-up — regen_policy closed lists', () => {
  it('REGEN_TRIGGERS lists exactly the 9 closed-set values from §A.4', () => {
    const expected: ReadonlyArray<RegenTrigger> = [
      'source_change',
      'producer_change',
      'drift_significant',
      'manual',
      'template_change',
      'style_change',
      'lang_change',
      'prompt_change',
      'model_change',
    ];
    expect([...REGEN_TRIGGERS]).toEqual([...expected]);
  });

  it('REGEN_DETERMINISMS lists exactly the 4 closed-set values from §A.4', () => {
    const expected: ReadonlyArray<RegenDeterminism> = [
      'temperature_zero',
      'n_sample_vote_3',
      'accept_noise_floor',
      'configurable',
    ];
    expect([...REGEN_DETERMINISMS]).toEqual([...expected]);
  });

  it('REGEN_INPUT_INVARIANTS opens with `pii_hash_salt` (audit §27.1)', () => {
    expect([...REGEN_INPUT_INVARIANTS]).toEqual(['pii_hash_salt']);
  });
});

describe('D-136 P3 follow-up — RegenPolicy type round-trip', () => {
  it('accepts a fully-populated policy literal at the type boundary', () => {
    const policy: RegenPolicy = {
      input_invariants: ['pii_hash_salt'],
      determinism: 'temperature_zero',
      dedup_key: ['source_record_hash', 'producer_version_hash', 'template_hash'],
      regen_triggers: ['source_change', 'template_change', 'producer_change', 'manual'],
    };
    expect(policy.dedup_key).toContain('template_hash');
  });

  it('RegenInputInvariant + RegenDeterminism + RegenTrigger compile against closed-list members', () => {
    const inv: RegenInputInvariant = 'pii_hash_salt';
    const det: RegenDeterminism = 'accept_noise_floor';
    const trig: RegenTrigger = 'drift_significant';
    expect({ inv, det, trig }).toEqual({
      inv: 'pii_hash_salt',
      det: 'accept_noise_floor',
      trig: 'drift_significant',
    });
  });
});

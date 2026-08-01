/** D-214 §10 — an attrition-invalidated root must stay out of the population.
 *
 * ⛔ FOUND BY MUTATION, 2026-07-26. `assignment()` refuses an arm to a root that
 * `markRootInvalid` has excluded (`case-intervention-store.ts:701`). Deleting
 * that guard outright reddened NOTHING across the then-current D-214 + D-137
 * suite (760 tests) — the exclusion existed and no test required it.
 *
 * ⚠ It is NOT redundant with the guard at :784. They stop different things:
 *   · :701 (`assignment`)          — refuses to give an invalidated root an arm;
 *   · :784 (`commitIntervention`)  — THROWS if a record is written for one.
 * So without :701 an invalidated root is re-assigned, augmentation proceeds on
 * it, and the failure surfaces later as a thrown commit rather than as a clean
 * exclusion — turning a silent, correct no-op into an error path on a surface
 * whose whole contract is to be advisory and never to cost a turn.
 *
 * Why this rule carries weight: `markRootInvalid` IS the attrition mechanism.
 * The critic invalidates a root on a treatment render mismatch, and treatment
 * is the only arm that can reach that path — which is exactly the
 * differential-attrition shape a prior D-214 defect produced and `1da71ecc5`
 * fixed. An exclusion that can be re-entered is not an exclusion.
 *
 * ⚠ Two neighbouring rules were ALSO single-site survivors and are NOT gaps —
 * recorded so nobody re-files them. Both are enforced redundantly, so a
 * one-site mutation cannot change behaviour; killing each rule at EVERY site
 * reddened the suite:
 *   · the pre-registration lock compares hash OR json (either term alone
 *     catches a real change);
 *   · invalid roots are excluded from listings at four separate SQL joins.
 * The honest residual there is narrower: no INDIVIDUAL site is pinned, so a
 * partial regression at one of them would still pass. */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';

import {
  createCaseInterventionStore,
} from '../storage/case-intervention-store.js';
import type {
  ExecutionCaseExperimentDefinition,
} from '../execution-case-retrieval.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const keyProvider = () => () =>
  deriveSubDEK(new Uint8Array(32).fill(7), 'chat');

const store = () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return createCaseInterventionStore(
    db,
    keyProvider(),
    new TextEncoder().encode('attrition-secret'),
  );
};

const definition = (): ExecutionCaseExperimentDefinition => ({
  experiment_id: 'attrition-exp',
  surface: 'request_augmentation',
  eligible_population: 'in-scope rooted turns reaching request augmentation',
  starts_at: 0,
  ends_at: 4_102_444_800_000,
  max_roots: 64,
  max_critique_opportunities_per_root: 2,
  max_evidence: 3,
  min_relevance_score: 0,
  primary_axes: ['verified_success'],
  material_harm_bounds: { execution_failure: 0.05 },
  decision_rule: 'test-only',
  planner_fingerprint: 'planner-1',
  prompt_fingerprint: 'prompt-1',
  retrieval_fingerprint: 'retrieval-1',
  policy_fingerprint: 'policy-1',
});

describe('D-214 — an invalidated root is excluded from assignment', () => {
  it('refuses an arm to a root marked invalid', () => {
    const s = store();
    const def = definition();
    s.markRootInvalid(def.experiment_id, 'root-a', 'treatment_render_mismatch', 5);
    expect(
      s.assignment({
        experiment_id: def.experiment_id,
        root_request_id: 'root-a',
        assigned_at: 10,
        definition: def,
      }),
    ).toBeUndefined();
  });

  it('keeps refusing after invalidation, even for an ALREADY-assigned root', () => {
    // The dangerous ordering: a root is assigned, does its work, and is only
    // then invalidated. Its stable arm is already committed, so a naive
    // "return the existing assignment" would hand it straight back.
    const s = store();
    const def = definition();
    const first = s.assignment({
      experiment_id: def.experiment_id,
      root_request_id: 'root-b',
      assigned_at: 10,
      definition: def,
    });
    expect(first).toBeDefined();

    s.markRootInvalid(def.experiment_id, 'root-b', 'treatment_render_mismatch', 11);
    expect(
      s.assignment({
        experiment_id: def.experiment_id,
        root_request_id: 'root-b',
        assigned_at: 12,
        definition: def,
      }),
    ).toBeUndefined();
  });

  it('does not invalidate its neighbours', () => {
    // The mirror: an exclusion that over-reaches would silently shrink the
    // population, which biases an arm comparison just as effectively as one
    // that under-reaches.
    const s = store();
    const def = definition();
    s.markRootInvalid(def.experiment_id, 'root-c', 'treatment_render_mismatch', 5);
    expect(
      s.assignment({
        experiment_id: def.experiment_id,
        root_request_id: 'root-d',
        assigned_at: 10,
        definition: def,
      }),
    ).toBeDefined();
  });

  it('scopes invalidation to its own experiment', () => {
    const s = store();
    const def = definition();
    s.markRootInvalid('other-experiment', 'root-e', 'treatment_render_mismatch', 5);
    expect(
      s.assignment({
        experiment_id: def.experiment_id,
        root_request_id: 'root-e',
        assigned_at: 10,
        definition: def,
      }),
    ).toBeDefined();
  });
});

/** D-214 §8.2 — the admission gate's evidence vocabulary, pinned per member.
 *
 * ⛔ WHY THIS FILE EXISTS. `positiveKinds` / `negativeKinds` / `strongKinds`
 * (`execution-case-core.ts`) are three sets partitioning ONE 13-member union,
 * and each is typed `ReadonlySet<CaseEvidenceKind>` — which accepts any SUBSET.
 * Omitting a member therefore typechecks clean and `npm run build` stays green;
 * only a test can catch it. The critic also carried a fourth hand-copy for
 * material negative families. It now derives that set as strong ∩ negative,
 * while this file pins the resulting role per negative kind. This is the same
 * defect class the D-214 build already hit once, on
 * `OUTCOME_AUTHORIZATION_SEVERITY`.
 *
 * The consequence of an omission is silent and severe, because the two sets are
 * not symmetric opposites — an observation that matches NEITHER is inert:
 * `evidencePolarity` reports `{positive: false, negative: false}`, the
 * observation contributes to no counter, and the case simply never forms. A
 * dropped `negativeKinds` member does not file a weaker signal; it files
 * NOTHING.
 *
 * MEASURED 2026-07-25 — dropping each member from each set it belongs to, 20
 * mutations against the then-current 10-file / 170-test D-214 suite, FIVE
 * SURVIVED with zero reds:
 *   · positiveKinds − unverified_success   (the "none of the above" positive —
 *     the ordinary shape of a span that just worked)
 *   · negativeKinds − verification_fail    (a deterministic postcondition
 *     FAILURE silently ceasing to count as negative evidence)
 *   · negativeKinds − typed_rejection      (the user said no)
 *   · negativeKinds − typed_undo           (the user undid it)
 *   · strongKinds   − typed_undo           (floor 1 → 3, so an undo would need
 *     to happen three times before it counted)
 * `typed_undo` had ZERO occurrences in any D-214 test file, in either set.
 * Removing it from the critic's former material-negative list likewise left the
 * other 11 D-214 files / 180 tests green.
 *
 * THREE RATCHETS, deliberately:
 *  1. `EXPECTED` is a `Record<CaseEvidenceKind, …>`, so TypeScript REQUIRES an
 *     entry per union member. Adding a kind without classifying it fails
 *     `npm run typecheck:tests` — the omission is caught at the moment the
 *     union grows, not whenever someone happens to write a case for it.
 *  2. Every kind is then driven through the REAL exported functions, so what is
 *     pinned is the admission BEHAVIOUR (does it count? does it bypass the
 *     recurrence floor?) rather than set membership. A refactor that replaces
 *     the three sets with a lookup table keeps these tests meaningful.
 *  3. Every negative family is driven through the real critic classifier at
 *     one observation, pinning strong negatives as contradictions and weak
 *     negatives as non-material until recurrence. */

import { describe, expect, it } from 'vitest';
import type { ExecutionOutcome, RequestShape } from '@recued/contracts';
import { EXECUTION_CASE_RECURRENCE_FLOOR } from '@recued/contracts';

import {
  analyzeExecutionCaseRequest,
  classifyExecutionFlowCases,
  deriveExecutionFlowPattern,
  outcomeStrengthForObservations,
  rebuildExecutionCases,
  type CaseEvidenceKind,
  type CaseSourceObservation,
} from '../execution-case-core.js';

const baseShape = (
  prompt = 'send the quarterly report to the customer',
): RequestShape =>
  analyzeExecutionCaseRequest(prompt, {
    schema_version: 1,
    intent: 'send quarterly report',
    objects: ['report'],
    entities: [{ role: 'recipient', kind: 'person' }],
    constraints: ['send'],
    outcome_sought: 'customer receives report',
  }).request_shape!;

const baseOutcome = (over: Partial<ExecutionOutcome> = {}): ExecutionOutcome => ({
  model_claim: 'fulfilled',
  authorization: 'allowed',
  execution: 'succeeded',
  verification: 'unavailable',
  feedback: 'unknown',
  ...over,
});

/** One observation carrying EXACTLY ONE evidence kind. Single-kind is the whole
 *  point: a fixture with several kinds cannot attribute the outcome to any one
 *  of them, which is how the five survivors stayed invisible while the same
 *  kinds appeared in other tests' multi-kind fixtures. */
const observationOf = (
  kind: CaseEvidenceKind,
  id: string,
  over: Partial<CaseSourceObservation> = {},
): CaseSourceObservation => ({
  observation_id: id,
  report_id: `report-${id}`,
  root_request_id: `root-${id}`,
  root_request: 'send the quarterly report to the customer',
  governing_contract_id: 'owner',
  principal_key: 'user_self',
  policy_fingerprint: 'policy-a',
  request_shape: baseShape(),
  flow_pattern: deriveExecutionFlowPattern([
    { tool_name: 'file.search', risk_tier: 'read' },
    { tool_name: 'mail.send', risk_tier: 'write', dependency_ordinals: [0] },
  ]),
  flow_basis: 'executed',
  outcome: baseOutcome(),
  evidence_kinds: [kind],
  substantive_call_count: 2,
  span_closed: true,
  intent_drifted: false,
  consulted_case_keys: [],
  observed_at: 1_000,
  proposed: true,
  plan_accepted: true,
  plan_declined: false,
  executed: true,
  ...over,
});

interface KindSpec {
  /** §8.2 polarity. `inert` is legal for exactly one member — see the
   *  `model_claim` assertion below, which pins that it is the ONLY one. */
  polarity: 'positive' | 'negative' | 'inert';
  /** Strong evidence admits at ONE independent observation (§8.2 Layer 2);
   *  weak evidence must reach `EXECUTION_CASE_RECURRENCE_FLOOR` distinct
   *  root requests first. */
  strong: boolean;
  /** §10.2 treats exactly the strong-negative intersection as a material
   *  one-observation contradiction. */
  materialContradiction: boolean;
  /** Why this classification, from the spec's evidence table. */
  because: string;
}

// ⛔ `Record<CaseEvidenceKind, …>` — a new union member without an entry here
// is a TYPE error. This is the ratchet; the assertions below are the proof.
const EXPECTED: Record<CaseEvidenceKind, KindSpec> = {
  verification_pass: {
    polarity: 'positive',
    strong: true,
    materialContradiction: false,
    because: 'an objective postcondition; repetition adds nothing',
  },
  verification_fail: {
    polarity: 'negative',
    strong: true,
    materialContradiction: true,
    because: 'an objective postcondition failure',
  },
  typed_acceptance: {
    polarity: 'positive',
    strong: true,
    materialContradiction: false,
    because: '§7 requires an explicit product signal',
  },
  typed_correction: {
    polarity: 'negative',
    strong: true,
    materialContradiction: true,
    because: 'the user said what was wrong',
  },
  typed_rejection: {
    polarity: 'negative',
    strong: true,
    materialContradiction: true,
    because: 'the user said what was wrong',
  },
  typed_undo: {
    polarity: 'negative',
    strong: true,
    materialContradiction: true,
    because: 'the user said what was wrong',
  },
  gateway_denial: {
    polarity: 'negative',
    strong: true,
    materialContradiction: true,
    because: 'a policy fact under a recorded fingerprint',
  },
  execution_failure: {
    polarity: 'negative',
    strong: true,
    materialContradiction: true,
    because: 'an error is objective',
  },
  untyped_decline: {
    polarity: 'negative',
    strong: false,
    materialContradiction: false,
    because: 'ambiguous — chat.plan.cancel needs 3',
  },
  flow_superseded: {
    polarity: 'negative',
    strong: false,
    materialContradiction: false,
    because: 'correction and extension are indistinguishable',
  },
  abandoned: {
    polarity: 'negative',
    strong: false,
    materialContradiction: false,
    because: 'the user saw it and did not proceed',
  },
  unverified_success: {
    polarity: 'positive',
    strong: false,
    materialContradiction: false,
    because: 'success means no terminal error, not fulfilment — one is coincidence',
  },
  model_claim: {
    polarity: 'inert',
    strong: false,
    materialContradiction: false,
    because: 'self-report is not independent verification — never admits',
  },
};

const KINDS = Object.keys(EXPECTED) as CaseEvidenceKind[];

describe('D-214 §8.2 — evidence polarity, per kind', () => {
  for (const kind of KINDS) {
    const spec = EXPECTED[kind];
    it(`'${kind}' counts as ${spec.polarity} — ${spec.because}`, () => {
      const strength = outcomeStrengthForObservations([
        observationOf(kind, 'o1'),
      ]);
      expect(strength.positive).toBe(spec.polarity === 'positive' ? 1 : 0);
      expect(strength.negative).toBe(spec.polarity === 'negative' ? 1 : 0);
      expect(strength.evidence_families).toEqual(
        kind === 'model_claim' ? [] : [kind],
      );
    });
  }

  it('model_claim is the ONLY inert kind — every other member moves a counter', () => {
    // Guards the inverse of the ratchet: a new kind could be added to EXPECTED
    // as `inert` to make its per-kind test pass without ever classifying it.
    const inert = KINDS.filter((kind) => {
      const s = outcomeStrengthForObservations([observationOf(kind, 'i')]);
      return s.positive === 0 && s.negative === 0;
    });
    expect(inert).toEqual(['model_claim']);
  });

  it('an inert kind contributes no evidence family either', () => {
    const strength = outcomeStrengthForObservations([
      observationOf('model_claim', 'm1'),
    ]);
    expect(strength.evidence_families).toEqual([]);
  });

  it('a positive and a negative observation together read as contested', () => {
    const strength = outcomeStrengthForObservations([
      observationOf('typed_acceptance', 'p1'),
      observationOf('verification_fail', 'n1'),
    ]);
    expect(strength).toMatchObject({ positive: 1, negative: 1, contested: true });
  });

  it('intent drift suppresses a positive but never a negative', () => {
    const drifted = { intent_drifted: true };
    expect(
      outcomeStrengthForObservations([
        observationOf('typed_acceptance', 'p1', drifted),
      ]).positive,
    ).toBe(0);
    expect(
      outcomeStrengthForObservations([
        observationOf('verification_fail', 'n1', drifted),
      ]).negative,
    ).toBe(1);
  });
});

describe('D-214 §8.2 Layer 2 — strong evidence admits at one, weak needs the floor', () => {
  for (const kind of KINDS) {
    const spec = EXPECTED[kind];
    if (spec.polarity === 'inert') continue;

    it(`a single '${kind}' observation ${spec.strong ? 'MATERIALIZES' : 'does NOT materialize'} a case`, () => {
      const cases = rebuildExecutionCases([observationOf(kind, 'solo')]).cases;
      expect(cases.length).toBe(spec.strong ? 1 : 0);
    });

    if (!spec.strong) {
      it(`'${kind}' materializes once it reaches the recurrence floor of ${EXECUTION_CASE_RECURRENCE_FLOOR}`, () => {
        // Distinct ROOT REQUESTS, not repeats of one — A18 counts request
        // observations ("you have asked this three times"), so N copies of a
        // single root must not clear the floor.
        const repeated = Array.from(
          { length: EXECUTION_CASE_RECURRENCE_FLOOR },
          (_unused, index) => observationOf(kind, `r${index}`),
        );
        expect(rebuildExecutionCases(repeated).cases.length).toBe(1);

        const oneRootRepeated = Array.from(
          { length: EXECUTION_CASE_RECURRENCE_FLOOR },
          (_unused, index) =>
            observationOf(kind, `same${index}`, { root_request_id: 'one-root' }),
        );
        expect(rebuildExecutionCases(oneRootRepeated).cases.length).toBe(0);
      });
    }
  }

  it('model_claim never admits, at any volume', () => {
    const many = Array.from(
      { length: EXECUTION_CASE_RECURRENCE_FLOOR * 2 },
      (_unused, index) => observationOf('model_claim', `mc${index}`),
    );
    expect(rebuildExecutionCases(many).cases.length).toBe(0);
  });
});

describe('D-214 §10.2 — critic materiality follows the evidence partition', () => {
  // Build one reachable row, then substitute an exact-flow strength projection
  // per negative family. This isolates critic classification from admission:
  // weak negatives must not become one-observation contradictions merely
  // because some other evidence admitted the case.
  const admitted = rebuildExecutionCases([
    observationOf('typed_acceptance', 'critic-seed'),
  ]).cases[0]!;

  for (const kind of KINDS.filter((candidate) =>
    EXPECTED[candidate].polarity === 'negative')) {
    const spec = EXPECTED[kind];
    it(`a single '${kind}' family ${spec.materialContradiction ? 'IS' : 'is NOT'} a material contradiction`, () => {
      const strength = outcomeStrengthForObservations([
        observationOf(kind, `critic-${kind}`),
      ]);
      const row = {
        ...admitted,
        outcome_strength: strength,
        flows: admitted.flows.map((flow) => ({
          ...flow,
          outcome_strength: strength,
        })),
      };
      const roles = classifyExecutionFlowCases(
        observationOf(kind, `candidate-${kind}`).flow_pattern,
        [row],
      ).map((item) => item.role);
      expect(roles).toEqual(
        spec.materialContradiction ? ['contradiction'] : [],
      );
    });
  }
});

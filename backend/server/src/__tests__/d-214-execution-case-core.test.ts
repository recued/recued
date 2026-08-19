import { describe, expect, it } from 'vitest';
import type {
  ExecutionCase,
  ExecutionOutcome,
  RequestShape,
} from '@recued/contracts';

import {
  analyzeExecutionCaseRequest,
  executionCaseRefusalReason,
  classifyExecutionFlowCases,
  deriveExecutionFlowPattern,
  encodeSupersededCaseHistory,
  EXECUTION_CASE_COMPILER_VERSION,
  executionCaseKey,
  historicalOutcomeForObservations,
  isExecutionCaseIntentGrounded,
  measureRuntimeComposition,
  outcomeStrengthForObservations,
  rankExecutionCaseCandidates,
  rebuildExecutionCases,
  renderExecutionCaseCard,
  retainExecutionCases,
  requestShapeHash,
  scoreExecutionCaseRelevance,
  segmentExecutionCaseText,
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

const baseOutcome = (
  over: Partial<ExecutionOutcome> = {},
): ExecutionOutcome => ({
  model_claim: 'fulfilled',
  authorization: 'allowed',
  execution: 'succeeded',
  verification: 'unavailable',
  feedback: 'unknown',
  ...over,
});

const observation = (
  id: string,
  over: Partial<CaseSourceObservation> = {},
): CaseSourceObservation => ({
  observation_id: id,
  report_id: `report-${id}`,
  root_request_id: `root-${id}`,
  root_request: 'send the quarterly report to the customer',
  session_id: 'session-fixture',
  governing_contract_id: 'owner',
  principal_key: 'user_self',
  policy_fingerprint: 'policy-a',
  request_shape: baseShape(),
  flow_pattern: deriveExecutionFlowPattern([
    {
      tool_name: 'file.search',
      risk_tier: 'read',
    },
    {
      tool_name: 'mail.send',
      risk_tier: 'write',
      dependency_ordinals: [0],
    },
  ]),
  flow_basis: 'executed',
  outcome: baseOutcome(),
  evidence_kinds: ['unverified_success'],
    // ⚠ D-219 slice 7 — was 1. The negative floor is now 2, so a one-call
  // fixture no longer admits at all and these tests would pass vacuously.
  // The claims here are about STRENGTH, TALLIES and AUTHORIZATION states, not
  // about the call floor, so the fixture moves rather than the assertion.
  substantive_call_count: 2,
  span_closed: true,
  intent_drifted: false,
  consulted_case_keys: [],
  observed_at: Number(id.replace(/\D/g, '')) || 1,
  proposed: true,
  plan_accepted: true,
  plan_declined: false,
  executed: true,
  ...over,
});

const onlyCase = (
  observations: readonly CaseSourceObservation[],
): ExecutionCase => {
  const rows = rebuildExecutionCases(observations).cases;
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe('D-214 admission and deterministic aggregation', () => {
  it('forms nothing for no action, model-only claims, or a correct single call', () => {
    expect(rebuildExecutionCases([]).cases).toEqual([]);
    expect(rebuildExecutionCases([
      observation('1', {
        evidence_kinds: ['model_claim'],
      }),
      observation('2', {
        evidence_kinds: ['model_claim'],
      }),
      observation('3', {
        evidence_kinds: ['model_claim'],
      }),
    ]).cases).toEqual([]);
    expect(rebuildExecutionCases([
      observation('4', {
        substantive_call_count: 2,
      }),
    ]).cases).toEqual([]);
  });

  it('admits one strong observation and gates weak evidence at three roots', () => {
    const verified = onlyCase([
      observation('1', {
        evidence_kinds: ['verification_pass'],
        outcome: baseOutcome({ verification: 'passed' }),
      }),
    ]);
    expect(verified.outcome_strength).toMatchObject({
      positive: 1,
      negative: 0,
      contested: false,
    });

    const corrected = onlyCase([
      observation('2', {
        flow_basis: 'proposed',
        evidence_kinds: ['typed_correction'],
        substantive_call_count: 2,
        outcome: baseOutcome({
          authorization: 'dismissed',
          execution: 'not_executed',
          feedback: 'corrected',
        }),
        executed: false,
      }),
    ]);
    expect(corrected.outcome_strength.negative).toBe(1);

    expect(rebuildExecutionCases([
      observation('3', {
        evidence_kinds: ['untyped_decline'],
        substantive_call_count: 2,
        executed: false,
      }),
      observation('4', {
        evidence_kinds: ['untyped_decline'],
        substantive_call_count: 2,
        executed: false,
      }),
    ]).cases).toEqual([]);
    expect(onlyCase([
      observation('3', {
        evidence_kinds: ['untyped_decline'],
        substantive_call_count: 2,
        executed: false,
      }),
      observation('4', {
        evidence_kinds: ['untyped_decline'],
        substantive_call_count: 2,
        executed: false,
      }),
      observation('5', {
        evidence_kinds: ['untyped_decline'],
        substantive_call_count: 2,
        executed: false,
      }),
    ]).independent_observations).toBe(3);
  });

  it('aggregates equivalent roots once, retains multiple flows, and is byte-stable', () => {
    const alternate = deriveExecutionFlowPattern([
      { tool_name: 'crm.lookup', risk_tier: 'read' },
      {
        tool_name: 'mail.send',
        risk_tier: 'write',
        dependency_ordinals: [0],
      },
    ]);
    const source = [
      observation('1', { evidence_kinds: ['typed_acceptance'] }),
      observation('2', {
        root_request_id: 'root-1',
        report_id: 'report-1b',
        observation_id: '1b',
        flow_pattern: alternate,
        evidence_kinds: ['typed_acceptance'],
      }),
    ];
    const first = rebuildExecutionCases(source);
    const second = rebuildExecutionCases([...source].reverse());
    expect(second.cases).toEqual(first.cases);
    expect(first.cases).toHaveLength(1);
    expect(first.cases[0]).toMatchObject({
      request_observations: 1,
      independent_observations: 1,
    });
    expect(first.cases[0]!.flows).toHaveLength(2);
  });

  it('keeps conflicting and recent evidence visible as tallies', () => {
    const rows = [
      observation('1', { evidence_kinds: ['typed_acceptance'] }),
      observation('2', {
        evidence_kinds: ['typed_correction'],
        substantive_call_count: 2,
        outcome: baseOutcome({ feedback: 'corrected' }),
      }),
    ];
    const row = onlyCase(rows);
    expect(row.outcome_strength).toMatchObject({
      positive: 1,
      negative: 1,
      contested: true,
    });
    expect(row.recent).toMatchObject({
      positive: 1,
      negative: 1,
      consecutive_contradictions: 1,
    });
    expect(outcomeStrengthForObservations(rows).contested).toBe(true);
  });

  it('does not admit unsafe positive dispositions or drifted positives', () => {
    for (const outcome of [
      baseOutcome({ authorization: 'dismissed' }),
      baseOutcome({ authorization: 'expired' }),
      baseOutcome({ execution: 'in_doubt' }),
      baseOutcome({ execution: 'skipped' }),
      baseOutcome({ execution: 'not_executed' }),
    ]) {
      expect(rebuildExecutionCases([
        observation('1', {
          evidence_kinds: ['verification_pass'],
          outcome,
        }),
      ]).cases).toEqual([]);
    }
    expect(rebuildExecutionCases([
      observation('1', {
        evidence_kinds: ['verification_pass'],
        intent_drifted: true,
      }),
    ]).cases).toEqual([]);
  });

  it('excludes self-steered roots from independent recurrence', () => {
    const first = observation('1', {
      evidence_kinds: ['untyped_decline'],
      substantive_call_count: 2,
      executed: false,
    });
    const key = executionCaseKey({
      governing_contract_id: first.governing_contract_id,
      principal_key: first.principal_key,
      request_shape_hash: requestShapeHash(first.request_shape),
      policy_fingerprint: first.policy_fingerprint,
    });
    const rows = ['1', '2', '3'].map((id) =>
      observation(id, {
        evidence_kinds: ['untyped_decline'],
        substantive_call_count: 2,
        executed: false,
        consulted_case_keys: id === '3' ? [key] : [],
      }));
    expect(rebuildExecutionCases(rows).cases).toEqual([]);
  });

  it('excludes self-steered outcomes from card, recent, flow, and critic strength', () => {
    const independent = observation('1', {
      evidence_kinds: ['verification_pass'],
      outcome: baseOutcome({ verification: 'passed' }),
    });
    const key = executionCaseKey({
      governing_contract_id: independent.governing_contract_id,
      principal_key: independent.principal_key,
      request_shape_hash: requestShapeHash(independent.request_shape),
      policy_fingerprint: independent.policy_fingerprint,
    });
    const steeredFailures = ['2', '3', '4'].map((id) =>
      observation(id, {
        evidence_kinds: ['verification_fail'],
        outcome: baseOutcome({
          execution: 'failed',
          verification: 'failed',
        }),
        consulted_case_keys: [key],
      }));
    const row = onlyCase([independent, ...steeredFailures]);
    expect(row).toMatchObject({
      request_observations: 4,
      independent_observations: 1,
      outcome_strength: {
        positive: 1,
        negative: 0,
        contested: false,
        evidence_families: ['verification_pass'],
      },
      recent: {
        window: 1,
        positive: 1,
        negative: 0,
        consecutive_contradictions: 0,
      },
    });
    expect(row.flows[0]!.outcome_strength).toEqual({
      positive: 1,
      negative: 0,
      contested: false,
      evidence_families: ['verification_pass'],
    });
    expect(row.flows[0]).toMatchObject({
      executed: 4,
      verified_successes: 1,
      verification_failures: 0,
    });
    expect(row.history_outcome).toEqual({
      authorization: 'allowed',
      execution: 'succeeded',
      verification: 'passed',
      feedback: 'unknown',
    });
    expect(classifyExecutionFlowCases(
      independent.flow_pattern,
      [row],
    ).map((item) => item.role)).toEqual(['support']);
  });

  it('does not manufacture a successful alternative from a self-steered flow', () => {
    const failed = observation('1', {
      evidence_kinds: ['verification_fail'],
      outcome: baseOutcome({
        execution: 'failed',
        verification: 'failed',
      }),
    });
    const key = executionCaseKey({
      governing_contract_id: failed.governing_contract_id,
      principal_key: failed.principal_key,
      request_shape_hash: requestShapeHash(failed.request_shape),
      policy_fingerprint: failed.policy_fingerprint,
    });
    const steeredAlternative = observation('2', {
      flow_pattern: deriveExecutionFlowPattern([
        { tool_name: 'crm.lookup', risk_tier: 'read' },
        { tool_name: 'mail.send', risk_tier: 'write' },
      ]),
      evidence_kinds: ['verification_pass'],
      outcome: baseOutcome({ verification: 'passed' }),
      consulted_case_keys: [key],
    });
    const row = onlyCase([failed, steeredAlternative]);
    const unseen = deriveExecutionFlowPattern([
      { tool_name: 'calendar.search', risk_tier: 'read' },
      { tool_name: 'mail.send', risk_tier: 'write' },
    ]);
    expect(row.flows.find((flow) =>
      flow.tools[0] === 'crm.lookup')).toMatchObject({
      executed: 1,
      verified_successes: 0,
      outcome_strength: {
        positive: 0,
        negative: 0,
        contested: false,
        evidence_families: [],
      },
    });
    expect(classifyExecutionFlowCases(unseen, [row])).toEqual([]);
  });

  it('forks and links policy history without putting flow in the key', () => {
    const first = observation('1', {
      evidence_kinds: ['typed_acceptance'],
      policy_fingerprint: 'policy-a',
    });
    const second = observation('2', {
      evidence_kinds: ['typed_acceptance'],
      policy_fingerprint: 'policy-b',
    });
    const result = rebuildExecutionCases([first, second]).cases;
    expect(result).toHaveLength(2);
    const old = result.find((row) => row.policy_fingerprint === 'policy-a')!;
    const current = result.find((row) => row.policy_fingerprint === 'policy-b')!;
    expect(old.superseded_by).toBe(current.case_id);
    expect(current.supersedes).toBe(old.case_id);
  });

  it('makes the most recently observed policy current across an A-B-A return', () => {
    const result = rebuildExecutionCases([
      observation('1', {
        observed_at: 100,
        evidence_kinds: ['typed_acceptance'],
        policy_fingerprint: 'policy-a',
      }),
      observation('2', {
        observed_at: 200,
        evidence_kinds: ['typed_acceptance'],
        policy_fingerprint: 'policy-b',
      }),
      observation('3', {
        observed_at: 300,
        evidence_kinds: ['typed_acceptance'],
        policy_fingerprint: 'policy-a',
      }),
    ]).cases;
    const policyA = result.find((row) =>
      row.policy_fingerprint === 'policy-a')!;
    const policyB = result.find((row) =>
      row.policy_fingerprint === 'policy-b')!;
    expect(policyA).toMatchObject({
      last_seen_at: 300,
      supersedes: policyB.case_id,
    });
    expect(policyA.superseded_by).toBeUndefined();
    expect(policyB.superseded_by).toBe(policyA.case_id);
  });

  it('keeps compiler-version projections distinct and classifies only material alternatives', () => {
    const versions = rebuildExecutionCases([
      observation('1', {
        compiler_version: 1,
        evidence_kinds: ['typed_acceptance'],
      }),
      observation('2', {
        compiler_version: 2,
        evidence_kinds: ['typed_acceptance'],
      }),
    ]).cases;
    expect(new Set(versions.map((row) => row.compiler_version)))
      .toEqual(new Set([1, 2]));
    expect(new Set(versions.map((row) => row.case_id)).size).toBe(2);

    const negativeObservation = observation('3', {
        evidence_kinds: ['verification_fail'],
        outcome: baseOutcome({
          execution: 'failed',
          verification: 'failed',
        }),
      });
    const negative = onlyCase([negativeObservation]);
    const unrelatedCandidate = deriveExecutionFlowPattern([
      { tool_name: 'mail.send', risk_tier: 'write' },
    ]);
    expect(classifyExecutionFlowCases(
      unrelatedCandidate,
      [negative],
    )).toEqual([]);
    expect(classifyExecutionFlowCases(
      negativeObservation.flow_pattern,
      [negative],
    ).map((item) => item.role)).toEqual(['contradiction']);
    expect(classifyExecutionFlowCases(
      negativeObservation.flow_pattern,
      [{ ...negative, superseded_by: 'current-case' }],
    )).toEqual([]);
  });

  it('materializes the exact modal history tuple and breaks ties by recency', () => {
    const allowed = observation('1', {
      observed_at: 100,
      outcome: baseOutcome({
        authorization: 'allowed',
        verification: 'passed',
        feedback: 'accepted',
      }),
      evidence_kinds: ['verification_pass', 'typed_acceptance'],
    });
    const dismissed = observation('2', {
      observed_at: 200,
      outcome: baseOutcome({
        authorization: 'dismissed',
        execution: 'not_executed',
        verification: 'unavailable',
        feedback: 'corrected',
      }),
      evidence_kinds: ['untyped_decline', 'typed_correction'],
      flow_basis: 'proposed',
      plan_accepted: false,
      plan_declined: true,
      executed: false,
    });
    const newerAllowed = observation('3', {
      observed_at: 300,
      outcome: baseOutcome({
        authorization: 'allowed',
        verification: 'passed',
        feedback: 'accepted',
      }),
      evidence_kinds: ['verification_pass', 'typed_acceptance'],
    });

    expect(historicalOutcomeForObservations([allowed, dismissed])).toEqual({
      authorization: 'dismissed',
      execution: 'not_executed',
      verification: 'unavailable',
      feedback: 'corrected',
    });
    const materialized = onlyCase([allowed, dismissed, newerAllowed]);
    expect(materialized.compiler_version)
      .toBe(EXECUTION_CASE_COMPILER_VERSION);
    expect(materialized.history_outcome).toEqual({
      authorization: 'allowed',
      execution: 'succeeded',
      verification: 'passed',
      feedback: 'accepted',
    });
  });

  it('retains the historical authorization states without defaulting to allowed', () => {
    // ⚠ D-219 slice 3 — `denied` no longer appears. A `gateway_denial`
    // observation is EXCLUDED from becoming a case (a denial is a judgement
    // about a moment, to be surfaced and asked again, not a standing fact), so
    // there is no case left to carry that state. The other states are unchanged,
    // which is what this still guards: nothing silently collapses to `allowed`.
    //
    // ⚠ D-219 slice 10 — `expired` goes the same way, and its three source rows
    // are KEPT below on purpose: they sit at the recurrence floor, they used to
    // form a case, and they now form none. An unanswered approval is silence,
    // and silence is not a verdict about the approach.
    const sources: CaseSourceObservation[] = [
      observation('10', {
        policy_fingerprint: 'policy-not-required',
        outcome: baseOutcome({
          authorization: 'not_required',
          verification: 'passed',
        }),
        evidence_kinds: ['verification_pass'],
        proposed: false,
        plan_accepted: false,
      }),
      observation('20', {
        policy_fingerprint: 'policy-allowed',
        outcome: baseOutcome({
          authorization: 'allowed',
          feedback: 'accepted',
        }),
        evidence_kinds: ['typed_acceptance'],
      }),
      observation('30', {
        policy_fingerprint: 'policy-denied',
        outcome: baseOutcome({
          authorization: 'denied',
          execution: 'not_executed',
        }),
        evidence_kinds: ['gateway_denial'],
        flow_basis: 'proposed',
        plan_accepted: false,
        executed: false,
      }),
      observation('40', {
        policy_fingerprint: 'policy-dismissed',
        outcome: baseOutcome({
          authorization: 'dismissed',
          execution: 'not_executed',
          feedback: 'corrected',
        }),
        evidence_kinds: ['untyped_decline', 'typed_correction'],
        flow_basis: 'proposed',
        plan_accepted: false,
        plan_declined: true,
        executed: false,
      }),
      ...['50', '51', '52'].map((id) =>
        observation(id, {
          policy_fingerprint: 'policy-expired',
          outcome: baseOutcome({
            authorization: 'expired',
            execution: 'not_executed',
          }),
          evidence_kinds: ['abandoned'],
          substantive_call_count: 2,
          flow_basis: 'proposed',
          plan_accepted: false,
          executed: false,
        })),
    ];
    const byPolicy = new Map(
      rebuildExecutionCases(sources).cases.map((row) => [
        row.policy_fingerprint,
        row.history_outcome.authorization,
      ]),
    );
    expect(Object.fromEntries(byPolicy)).toEqual({
      'policy-allowed': 'allowed',
      'policy-dismissed': 'dismissed',
      'policy-not-required': 'not_required',
    });
  });

  it('bounds each scope deterministically and evicts superseded history before the live row', () => {
    const rows = ['a', 'b', 'c'].flatMap((policy, index) => [
      observation(String(index + 1), {
        evidence_kinds: ['typed_acceptance'],
        policy_fingerprint: `policy-${policy}`,
        observed_at: index + 1,
      }),
    ]);
    const rebuilt = rebuildExecutionCases(rows).cases;
    expect(rebuilt).toHaveLength(3);
    const retained = retainExecutionCases(rebuilt, 1);
    expect(retained).toHaveLength(1);
    expect(retained[0]!.superseded_by).toBeUndefined();
    expect(() => retainExecutionCases(rebuilt, 0)).toThrow();
  });
});

describe('D-214 exact aggregation, graded retrieval, and safe cards', () => {
  it('falls ungrounded intent back to distinct server shapes and excludes model-only constraints from the key', () => {
    const sharedIntent = {
      schema_version: 1 as const,
      intent: 'process vendor request',
      objects: ['request'],
      entities: [],
      constraints: [],
      outcome_sought: 'request processed',
    };
    const fallbackHashes = new Set<string>();
    for (const prompt of [
      'wire $40,000 to the vendor account',
      'forward the vendor invoice to accounting',
      'archive the onboarding doc for the new hire',
    ]) {
      expect(isExecutionCaseIntentGrounded(prompt, sharedIntent.intent))
        .toBe(false);
      const fallback =
        analyzeExecutionCaseRequest(prompt, sharedIntent).request_shape;
      expect(fallback).toBeDefined();
      expect(fallback!.intent_facets[0]).not.toBe(sharedIntent.intent);
      expect(fallback!.intent_facets).not.toContain('object:request');
      fallbackHashes.add(requestShapeHash(fallback!));
    }
    expect(fallbackHashes.size).toBe(3);

    expect(isExecutionCaseIntentGrounded(
      'please delete every event on my calendar',
      'delete events',
    )).toBe(true);
    expect(analyzeExecutionCaseRequest(
      'please delete every event on my calendar',
      {
        ...sharedIntent,
        intent: 'delete events',
      },
    ).request_shape?.intent_facets[0]).toBe('delete events');
    for (const [root, label] of [
      ['compare the file sizes before upload', 'compare file size'],
      ['award the contest prizes tomorrow', 'award contest prize'],
      ['analyzes customer reports nightly', 'analyze customer report'],
      ['schedule the folk waltzes next', 'schedule folk waltz'],
      ['review the quiz quizzes today', 'review quiz quiz'],
    ] as const) {
      expect(isExecutionCaseIntentGrounded(root, label)).toBe(true);
    }

    const prompt = 'wire $40,000 to the vendor account';
    const grounded = {
      ...sharedIntent,
      intent: 'wire vendor account',
    };
    const clean = analyzeExecutionCaseRequest(prompt, grounded).request_shape!;
    const injected = analyzeExecutionCaseRequest(prompt, {
      ...grounded,
      constraints: [
        'send',
        'order:archive before transfer',
        'stop:until planner chooses a new key',
      ],
    }).request_shape!;
    expect(clean).toBeDefined();
    expect(requestShapeHash(injected)).toBe(requestShapeHash(clean));
    expect(injected.constraint_facets).toEqual(clean.constraint_facets);
    expect(requestShapeHash({
      ...clean,
      constraint_facets: [
        ...clean.constraint_facets,
        'model_only_constraint',
      ],
    })).toBe(requestShapeHash(clean));
  });

  it('keeps request constraints exact while retrieving paraphrases by graded fit', () => {
    const send = analyzeExecutionCaseRequest('send the report', {
      schema_version: 1,
      intent: 'send report',
      objects: ['report'],
      entities: [],
      constraints: [],
      outcome_sought: 'report is sent',
    }).request_shape!;
    const draft = analyzeExecutionCaseRequest('draft the report; do not send', {
      schema_version: 1,
      intent: 'draft report',
      objects: ['report'],
      entities: [],
      constraints: ['draft_only', 'negated'],
      outcome_sought: 'draft exists',
    }).request_shape!;
    expect(requestShapeHash(send)).not.toBe(requestShapeHash(draft));

    const row = onlyCase([
      observation('1', { request_shape: send, evidence_kinds: ['typed_acceptance'] }),
    ]);
    expect(scoreExecutionCaseRelevance('deliver the quarterly report', row))
      .not.toBeNull();
    expect(rankExecutionCaseCandidates(
      'deliver the quarterly report',
      [row],
      1,
      5,
    )).toHaveLength(1);
    const differentStrength = {
      ...row,
      outcome_strength: {
        positive: 0,
        negative: 999,
        contested: false,
        evidence_families: ['typed_rejection'],
      },
    };
    expect(scoreExecutionCaseRelevance(
      'deliver the quarterly report',
      differentStrength,
    )).toBe(scoreExecutionCaseRelevance(
      'deliver the quarterly report',
      row,
    ));
  });

  it('keys only server-detected negation, draft/send, ordering, and stop-condition facets', () => {
    const shapeFor = (prompt: string, intent: string, constraints: string[]) =>
      analyzeExecutionCaseRequest(prompt, {
        schema_version: 1,
        intent,
        objects: ['report'],
        entities: [],
        constraints,
        outcome_sought: 'report is handled',
      }).request_shape!;
    const plain = shapeFor('send the report', 'send report', []);
    const injected = shapeFor(
      'send the report',
      'send report',
      ['negated', 'order:mail send before file search'],
    );
    expect(requestShapeHash(injected)).toBe(requestShapeHash(plain));
    const hashes = [
      plain,
      shapeFor('do not send the report', 'send report', []),
      shapeFor('draft the report', 'draft report', []),
      shapeFor(
        'send the report first, then archive it',
        'send report',
        [],
      ),
      shapeFor(
        'send the report until delivery is verified',
        'send report',
        [],
      ),
    ].map(requestShapeHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('retains old exact recipe shapes as stale evidence but never steers from them', () => {
    const version = (hash: string) => deriveExecutionFlowPattern([{
      tool_name: 'mail.send',
      recipe_id: 'mail.send',
      recipe_hash: hash,
      risk_tier: 'write',
    }]);
    const row = onlyCase([
      observation('1', {
        flow_pattern: version('recipe-v1'),
        evidence_kinds: ['typed_acceptance'],
        observed_at: 100,
      }),
      observation('2', {
        flow_pattern: version('recipe-v2'),
        evidence_kinds: ['typed_acceptance'],
        observed_at: 200,
      }),
    ]);
    expect(row.flows).toHaveLength(2);
    expect(row.flows.filter((flow) => flow.stale)).toHaveLength(1);
    expect(row.flows.find((flow) => !flow.stale)?.last_seen_at).toBe(200);
    // The card keeps the trajectory as explicitly marked history; relevance
    // and critique below use only the current flow.
    expect(renderExecutionCaseCard(row).flows.filter((flow) => flow.stale))
      .toHaveLength(1);

    const entirelyStale = {
      ...row,
      flows: row.flows.map((flow) => ({ ...flow, stale: true })),
    };
    expect(rankExecutionCaseCandidates(
      'send the quarterly report',
      [entirelyStale],
      1,
      5,
    )).toEqual([]);
  });

  it('segments CJK consistently and never depends on whitespace tokens', () => {
    const terms = segmentExecutionCaseText('顧客に四半期報告書を送信してください');
    expect(terms.length).toBeGreaterThan(0);
    expect(segmentExecutionCaseText('顧客に四半期報告書を送信してください'))
      .toEqual(terms);
  });

  it('renders bounded argument-free cards with no report-only fields', () => {
    const row = onlyCase([
      observation('1', { evidence_kinds: ['typed_acceptance'] }),
    ]);
    const card = renderExecutionCaseCard(row);
    expect(card.flows[0]!.tools).toEqual(['file.search', 'mail.send']);
    expect(JSON.stringify(card)).not.toContain('customer@example.com');
    expect(Object.hasOwn(card, 'open_items')).toBe(false);
    expect(Object.hasOwn(card, 'model_claim')).toBe(false);
    expect(Object.hasOwn(card, 'tool_args')).toBe(false);
    expect(card.applicability_notes.join(' ')).toContain('Gateway');
  });

  it('run-length encodes adjacent history only and keeps separated axes', () => {
    const outcomeA = {
      authorization: 'allowed' as const,
      execution: 'succeeded' as const,
      verification: 'passed' as const,
      feedback: 'accepted' as const,
    };
    const outcomeB = {
      authorization: 'denied' as const,
      execution: 'not_executed' as const,
      verification: 'unavailable' as const,
      feedback: 'unknown' as const,
    };
    const encoded = encodeSupersededCaseHistory([
      ...[1, 2, 3].map((at) => ({
        case_id: `a${at}`,
        at,
        outcome: outcomeA,
        superseded_reason: 'policy_fingerprint' as const,
      })),
      {
        case_id: 'b',
        at: 4,
        outcome: outcomeB,
        superseded_reason: 'policy_fingerprint' as const,
      },
      ...[5, 6, 7, 8].map((at) => ({
        case_id: `a${at}`,
        at,
        outcome: outcomeA,
        superseded_reason: 'policy_fingerprint' as const,
      })),
    ]);
    expect(encoded.runs.map((run) => run.occurrences)).toEqual([4, 1, 3]);
    expect(encoded.runs.every((run) =>
      !Object.hasOwn(run.outcome, 'model_claim'))).toBe(true);
  });
});

describe('D-214 A26 runtime composition diagnostics', () => {
  it('separates installed, dynamic, inline, and direct routes and packages only recurring dynamic topology', () => {
    const diagnostics = measureRuntimeComposition([
      {
        root_request_id: 'r1',
        ordinal: 0,
        route_kind: 'installed_recipe',
        tool_name: 'vendor/installed',
        recipe_id: 'vendor/installed',
        recipe_hash: 'h1',
        operation_ids: ['installed.op'],
        dependency_ordinals: [],
      },
      ...['r1', 'r2', 'r3'].map((root_request_id) => ({
        root_request_id,
        ordinal: 1,
        route_kind: 'dynamic_ingredient' as const,
        tool_name: 'run-ingredient',
        operation_ids: ['mail.send'],
        dependency_ordinals: [0],
      })),
      {
        root_request_id: 'r4',
        ordinal: 0,
        route_kind: 'inline_recipe',
        tool_name: 'inline-recipe',
        operation_ids: ['search', 'send'],
        dependency_ordinals: [],
      },
      {
        root_request_id: 'r5',
        ordinal: 0,
        route_kind: 'direct_tool',
        tool_name: 'mail.search',
        operation_ids: ['mail.search'],
        dependency_ordinals: [],
      },
    ]);
    expect(diagnostics.route_kind_counts).toEqual({
      installed_recipe: 1,
      dynamic_ingredient: 3,
      inline_recipe: 1,
      direct_tool: 1,
    });
    expect(diagnostics.recurring_dynamic_inline_subgraphs).toHaveLength(1);
    expect(diagnostics.recurring_dynamic_inline_subgraphs[0]!
      .independent_roots).toBe(3);
    expect(diagnostics.recurring_dynamic_inline_subgraphs.some((row) =>
      row.signature.includes('vendor/installed'))).toBe(false);
  });
});

describe('slice 8 keys on the OPERATION, not the transport that carried it', () => {
  // ⛔ `recipe.run` is a DISPATCHER. Two DIFFERENT recipes sent through it both
  // record the string `recipe.run` in `tool_sequence`, so a real procedure read
  // as one tool called twice and was excluded as a retry. Measured on bench 181:
  // a lean-core run reached add-customer, list-customers and
  // open-rental-contract through the dispatcher and lost its observation to
  // `repeated_tool` with nothing retried.
  //
  // ⚠ MODE-COUPLED, which is why it went unnoticed for so long: under a `full`
  // catalog the model calls recipes by SLUG (which names itself), so only the
  // catalog mode that ships by default paid for it. The identity has been on the
  // flow since V21 (`recipe_steps`) for the CARD to render — this gate simply
  // never read it.
  // ⚠ Built through the REAL `deriveExecutionFlowPattern` rather than a
  // hand-written FlowPattern literal. A literal has to be padded with every
  // field the type carries (and drifts the day one is added), and — more to the
  // point — `recipe_steps` is exactly what the compiler DERIVES from the steps,
  // so hand-writing it would test the fixture rather than the derivation.
  const viaFlow = (
    steps: Array<{ tool: string; recipe?: string }>,
  ) => observation('9', {
    flow_pattern: deriveExecutionFlowPattern(
      steps.map((st, i) => ({
        tool_name: st.tool,
        risk_tier: 'write' as const,
        dependency_ordinals: i === 0 ? [] : [i - 1],
        ...(st.recipe ? { recipe_id: st.recipe } : {}),
      })),
    ),
    substantive_call_count: steps.length,
  });

  it('does NOT refuse a flow because our OWN bookkeeping tool ran twice', () => {
    // ⛔ MEASURED across 34 live runs: 11 flows were refused as `repeated_tool`
    // and 5 of them ONLY because `request.dissection` appeared twice — 15% of
    // all runs losing an execution case to a classification marker that
    // performs none of the requested work, with nothing retried. It was the
    // single largest cause of refusal, ahead of every real recipe repeat
    // combined. Same argument that already exempts `tools.search`.
    expect(executionCaseRefusalReason(viaFlow([
      { tool: 'request.dissection' }, { tool: 'recued-core/list-buildings' },
      { tool: 'request.dissection' }, { tool: 'recued-core/add-unit' },
    ]))).not.toBe('repeated_tool');
  });

  it('still refuses a REAL repeat sitting beside the exempt bookkeeping', () => {
    // The exemption must not become cover for the shape slice 8 exists to catch.
    expect(executionCaseRefusalReason(viaFlow([
      { tool: 'request.dissection' }, { tool: 'recued-core/add-unit' },
      { tool: 'request.dissection' }, { tool: 'recued-core/add-unit' },
    ]))).toBe('repeated_tool');
  });

  it('does NOT call three distinct dispatched recipes a repeat', () => {
    // The defect: `recipe.run` is a DISPATCHER, so `tool_sequence` records that
    // one name for every recipe and three distinct operations read as one tool
    // called three times. Measured on bench 181 — a lean-core run reached
    // add-customer, list-customers and open-rental-contract this way and lost
    // its observation to `repeated_tool` with nothing retried.
    expect(executionCaseRefusalReason(viaFlow([
      { tool: 'recipe.run', recipe: 'recued-core/add-customer' },
      { tool: 'recipe.run', recipe: 'recued-core/list-customers' },
      { tool: 'recipe.run', recipe: 'recued-core/open-rental-contract' },
    ]))).not.toBe('repeated_tool');
  });

  it('still refuses the SAME recipe dispatched twice — the shape slice 8 exists for', () => {
    expect(executionCaseRefusalReason(viaFlow([
      { tool: 'recipe.run', recipe: 'recued-core/add-unit' },
      { tool: 'recipe.run', recipe: 'recued-core/add-unit' },
    ]))).toBe('repeated_tool');
  });

  it('catches a repeat that MIXES routes — slug once, dispatcher once', () => {
    // What the bare-id normalisation is for: a slug step records
    // `recued-core/add-unit` while the dispatched one may be qualified
    // differently, and without it the same recipe would read as two operations.
    expect(executionCaseRefusalReason(viaFlow([
      { tool: 'recued-core/add-unit' },
      { tool: 'recipe.run', recipe: 'rental-book/add-unit' },
    ]))).toBe('repeated_tool');
  });
});

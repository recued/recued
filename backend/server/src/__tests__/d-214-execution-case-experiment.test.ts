import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  InternalToolRegistry,
  ToolEntry,
  ToolTier,
} from '@recued/contracts';

import {
  createExecutionCaseAugmentationSource,
  EXECUTION_CASE_ELIGIBLE_POPULATION,
  EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY,
  readExecutionCaseContext,
  validateExecutionCaseExperimentDefinition,
  type ExecutionCaseExperimentDefinition,
} from '../execution-case-retrieval.js';
import {
  createExecutionCaseProposalCritic,
} from '../execution-case-critic.js';
import {
  createExecutionCaseExperimentReporter,
} from '../execution-case-experiment.js';
import type {
  ExecutionCaseCompiler,
  ResolvedExecutionSpan,
} from '../execution-case-compiler.js';
import {
  analyzeExecutionCaseRequest,
  deriveExecutionFlowPattern,
  EXECUTION_CASE_COMPILER_VERSION,
  rebuildExecutionCases,
  type CaseSourceObservation,
} from '../execution-case-core.js';
import {
  readExecutionCaseExperimentEnv,
} from '../composition/bin/wire-execution-cases.js';
import {
  createCaseInterventionStore,
} from '../storage/case-intervention-store.js';
import {
  createExecutionCaseStore,
} from '../storage/execution-case-store.js';
import {
  createExecutionSpanAnchorStore,
} from '../storage/execution-span-anchor-store.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const keyProvider = (): D214KeyProvider => {
  const key = new Uint8Array(32).fill(19);
  return () => key;
};

const mailEntry: ToolEntry = {
  name: 'mail.send',
  tier: 2,
  description: 'send mail',
  arg_schema: {},
  topic_tags: ['mail'],
  classification: 'write',
  risk_tier: 'write',
  concurrency_safe: false,
};

const fileEntry: ToolEntry = {
  name: 'file.search',
  tier: 1,
  description: 'search',
  arg_schema: {},
  topic_tags: ['files'],
  classification: 'read',
  risk_tier: 'read',
  concurrency_safe: true,
};

const registry: InternalToolRegistry = {
  list: () => [fileEntry, mailEntry],
  listByTier: (tier: ToolTier) =>
    [fileEntry, mailEntry].filter((entry) => entry.tier === tier),
  getByName: (name) =>
    [fileEntry, mailEntry].find((entry) => entry.name === name) ?? null,
  dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
  subscribeRefresh: () => () => {},
};

const experiment = (
  over: Partial<ExecutionCaseExperimentDefinition> = {},
): ExecutionCaseExperimentDefinition => {
  const surface = over.surface ?? 'proposal_critique';
  return {
    experiment_id: 'exp-1',
    surface,
    eligible_population:
      over.eligible_population
      ?? EXECUTION_CASE_ELIGIBLE_POPULATION[surface],
    starts_at: 0,
    ends_at: 10_000,
    max_roots: 100,
    max_critique_opportunities_per_root: 2,
    max_evidence: 3,
    min_relevance_score: 1,
    primary_axes: ['explicit_correction'],
    material_harm_bounds: { execution_failure: 0.1 },
    decision_rule: 'ship only when treatment improves a primary axis',
    planner_fingerprint: 'planner-v1',
    prompt_fingerprint: 'prompt-v1',
    retrieval_fingerprint: 'retrieval-v1',
    policy_fingerprint: 'policy-v1',
    ...over,
  };
};

const admittedCase = () => {
  const requestShape = analyzeExecutionCaseRequest(
    'send the quarterly report to the customer',
    {
      schema_version: 1,
      intent: 'send quarterly report',
      objects: ['report'],
      entities: [{ role: 'recipient', kind: 'person' }],
      constraints: ['send'],
      outcome_sought: 'customer receives report',
    },
  ).request_shape!;
  const source: CaseSourceObservation = {
    observation_id: 'obs-1',
    report_id: 'report-1',
    root_request_id: 'historical-root',
    root_request: 'send the quarterly report to the customer',
    governing_contract_id: 'owner',
    principal_key: 'user_self',
    policy_fingerprint: 'policy-v1',
    request_shape: requestShape,
    flow_pattern: deriveExecutionFlowPattern([
      { tool_name: 'mail.send', risk_tier: 'write' },
    ]),
    flow_basis: 'executed',
    outcome: {
      model_claim: 'fulfilled',
      authorization: 'allowed',
      execution: 'failed',
      verification: 'failed',
      feedback: 'unknown',
    },
    evidence_kinds: ['verification_fail'],
    substantive_call_count: 2,
    span_closed: true,
    intent_drifted: false,
    consulted_case_keys: [],
    observed_at: 100,
    proposed: true,
    plan_accepted: true,
    plan_declined: false,
    executed: true,
  };
  return rebuildExecutionCases([
    source,
    {
      ...source,
      observation_id: 'obs-2',
      report_id: 'report-2',
      root_request_id: 'historical-root-2',
      flow_pattern: deriveExecutionFlowPattern([
        { tool_name: 'file.search', risk_tier: 'read' },
        { tool_name: 'mail.send', risk_tier: 'write' },
      ]),
      observed_at: 101,
    },
  ]).cases[0]!;
};

const fixture = async () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const key = keyProvider();
  const anchorStore = createExecutionSpanAnchorStore(db, key);
  const caseStore = createExecutionCaseStore(db, key);
  const interventionStore = createCaseInterventionStore(
    db,
    key,
    new TextEncoder().encode('experiment-secret'),
  );
  const row = admittedCase();
  await caseStore.replaceMaterialized(
    [row],
    new Map([[row.case_id, ['report-1']]]),
    new Map([[row.case_id, 'send the quarterly report to the customer']]),
  );
  return { db, anchorStore, caseStore, interventionStore, row };
};

const findArmRoot = (
  store: ReturnType<typeof createCaseInterventionStore>,
  arm: 'control' | 'treatment',
  definition: ExecutionCaseExperimentDefinition = experiment(),
): string => {
  for (let i = 0; i < 100; i += 1) {
    const root = `root-${arm}-${i}`;
    if (store.assignment({
      experiment_id: definition.experiment_id,
      root_request_id: root,
      assigned_at: 1,
      definition,
      max_roots: 100,
    }) === arm) return root;
  }
  throw new Error(`could not find ${arm} root`);
};

const anchor = async (
  f: Awaited<ReturnType<typeof fixture>>,
  root: string,
  turn: string,
) => {
  await f.anchorStore.openSpan({
    root_request_id: root,
    session_id: 's1',
    surface: 'chat',
    root_request: 'send the quarterly report to the customer',
    turn_id: turn,
    now: 10,
  });
};

const makeCritic = (
  f: Awaited<ReturnType<typeof fixture>>,
  over: Partial<Parameters<typeof createExecutionCaseProposalCritic>[0]> = {},
) => {
  let id = 0;
  return createExecutionCaseProposalCritic({
    anchorStore: f.anchorStore,
    caseStore: f.caseStore,
    interventionStore: f.interventionStore,
    registry,
    experiment: experiment(),
    resolveScope: () => ({
      governing_contract_id: 'owner',
      principal_key: 'user_self',
      active: true,
    }),
    now: () => 500,
    newInterventionId: () => `intervention-${++id}`,
    ...over,
  });
};

const proposal = {
  tool: 'mail.send',
  args: {
    recipient: 'alice@example.com',
    body: 'raw secret body',
  },
};

const emptySpan = (root_request_id: string): ResolvedExecutionSpan => ({
  root_request_id,
  activities: [],
  recipe_runs: [],
  plans: [],
  feedback: [],
  verifications: [],
  typed_correction_plan_ids: new Set(),
  first_event_id: `root:${root_request_id}`,
  last_event_id: `root:${root_request_id}`,
  pending: false,
  has_substantive_flow: false,
  has_strong_signal: false,
  has_compilable_signal: false,
});

const emptyCompiler = (): ExecutionCaseCompiler => ({
  resolveSpan: emptySpan,
  runtimeCompositionDiagnostics: () => ({
    corpus_roots: 0,
    dispatches: 0,
    route_kind_counts: {
      installed_recipe: 0,
      dynamic_ingredient: 0,
      inline_recipe: 0,
      direct_tool: 0,
    },
    recurring_dynamic_inline_subgraphs: [],
    source_coverage: {
      audit_activity_rows: 0,
      recipe_run_rows: 0,
      paired_recipe_runs: 0,
      unpaired_recipe_runs: 0,
    },
  }),
}) as unknown as ExecutionCaseCompiler;

describe('D-214 bounded experiment definition', () => {
  it('fails malformed pre-registration closed and keeps malformed env dark', () => {
    expect(() => validateExecutionCaseExperimentDefinition(experiment()))
      .not.toThrow();
    for (const invalid of [
      { surface: 'both' },
      { planner_fingerprint: '' },
      { primary_axes: ['correction', 'correction'] },
      { material_harm_bounds: {} },
      { material_harm_bounds: { correction: -1 } },
      { min_relevance_score: -1 },
      { max_evidence: 6 },
      { max_critique_opportunities_per_root: 9 },
      { primary_axes: ['not_reported'] },
      { primary_axes: ['critique_flow_revised'] },
      { material_harm_bounds: { not_reported: 0 } },
      { material_harm_bounds: { verified_success: 0 } },
      { material_harm_bounds: { execution_failure: 1.01 } },
      { eligible_population: 'owners' },
    ]) {
      expect(() => validateExecutionCaseExperimentDefinition(
        experiment(invalid as Partial<ExecutionCaseExperimentDefinition>),
      )).toThrow(/incomplete/);
    }
    const validEnv = {
      RECUED_D214_EXPERIMENT_ID: 'bad-exp',
      RECUED_D214_EXPERIMENT_SURFACE: 'proposal_critique',
      RECUED_D214_EXPERIMENT_START_MS: '10',
      RECUED_D214_EXPERIMENT_END_MS: '50',
      RECUED_D214_EXPERIMENT_MAX_ROOTS: '10',
      RECUED_D214_EXPERIMENT_MAX_CRITIQUES_PER_ROOT: '2',
      RECUED_D214_EXPERIMENT_MAX_EVIDENCE: '3',
      RECUED_D214_EXPERIMENT_MIN_RELEVANCE_SCORE: '1',
      RECUED_D214_EXPERIMENT_ELIGIBLE_POPULATION:
        EXECUTION_CASE_ELIGIBLE_POPULATION.proposal_critique,
      RECUED_D214_EXPERIMENT_DECISION_RULE: 'pre-registered rule',
      RECUED_D214_EXPERIMENT_PLANNER_FINGERPRINT: 'planner',
      RECUED_D214_EXPERIMENT_PROMPT_FINGERPRINT: 'prompt',
      RECUED_D214_EXPERIMENT_RETRIEVAL_FINGERPRINT: 'retrieval',
      RECUED_D214_EXPERIMENT_POLICY_FINGERPRINT: 'policy',
      RECUED_D214_EXPERIMENT_PRIMARY_AXES: 'explicit_correction',
      RECUED_D214_EXPERIMENT_MATERIAL_HARM_BOUNDS:
        '{"execution_failure":0.1}',
      RECUED_D214_EXPERIMENT_SECRET: 'server-owned-secret',
    } as NodeJS.ProcessEnv;
    expect(readExecutionCaseExperimentEnv(validEnv)).toMatchObject({
      experiment_id: 'bad-exp',
      surface: 'proposal_critique',
    });
    expect(readExecutionCaseExperimentEnv({
      ...validEnv,
      RECUED_D214_EXPERIMENT_END_MS: '5',
    })).toBeUndefined();
    expect(readExecutionCaseExperimentEnv({
      ...validEnv,
      RECUED_D214_EXPERIMENT_SECRET: '',
    })).toBeUndefined();
    expect(readExecutionCaseExperimentEnv({
      ...validEnv,
      RECUED_D214_EXPERIMENT_MATERIAL_HARM_BOUNDS:
        '{"execution_failure":0.1,"silently_dropped":"not-a-number"}',
    })).toBeUndefined();
  });

  it('repairs a legacy nullable intervention sequence before indexing it', () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    db.exec(`
      CREATE TABLE case_interventions (
        opportunity_key        TEXT PRIMARY KEY,
        intervention_id        TEXT NOT NULL UNIQUE,
        experiment_id          TEXT NOT NULL,
        root_request_id        TEXT NOT NULL,
        governing_contract_id  TEXT NOT NULL,
        principal_key          TEXT NOT NULL,
        surface                TEXT NOT NULL,
        assignment             TEXT NOT NULL,
        recorded_at            INTEGER NOT NULL,
        recorded_sequence      INTEGER,
        payload_encrypted      TEXT NOT NULL,
        planner_egress_at      INTEGER,
        span_closed_at         INTEGER
      );
      INSERT INTO case_interventions VALUES
        ('op-1', 'i-1', 'exp', 'root', 'owner', 'user_self',
         'proposal_critique', 'control', 10, NULL, 'sealed-1', NULL, NULL),
        ('op-2', 'i-2', 'exp', 'root', 'owner', 'user_self',
         'proposal_critique', 'control', 10, NULL, 'sealed-2', NULL, NULL);
    `);

    createCaseInterventionStore(
      db,
      keyProvider(),
      new TextEncoder().encode('migration-secret'),
    );

    expect((db.prepare(`
      SELECT recorded_sequence
        FROM case_interventions
       ORDER BY rowid
    `).all() as Array<{ recorded_sequence: number }>)
      .map((row) => row.recorded_sequence)).toEqual([1, 2]);
    expect((db.prepare(`
      PRAGMA index_list(case_interventions)
    `).all() as Array<{ name: string }>).map((row) => row.name))
      .toContain('idx_case_interventions_root_sequence');
  });

  it('locks the complete definition before assignment and rejects relabeling', async () => {
    const f = await fixture();
    const definition = experiment({ experiment_id: 'exp-locked' });
    expect(f.interventionStore.assignment({
      experiment_id: definition.experiment_id,
      root_request_id: 'locked-root',
      assigned_at: 10,
      definition,
    })).toBeDefined();
    expect(() => f.interventionStore.assertDefinition({
      ...definition,
      decision_rule: 'changed after assignment',
    })).toThrow(/definition mismatch/);
    expect(() => f.interventionStore.assignment({
      experiment_id: definition.experiment_id,
      root_request_id: 'second-root',
      assigned_at: 11,
      definition: {
        ...definition,
        primary_axes: ['different-axis'],
      },
    })).toThrow(/definition mismatch/);
    expect(f.interventionStore.listAssignments(definition.experiment_id))
      .toHaveLength(1);

    await anchor(f, 'locked-root', 'locked-turn');
    await makeCritic(f, {
      experiment: definition,
      newInterventionId: () => 'locked-intervention',
    }).critique({
      session_id: 's1',
      turn_id: 'locked-turn',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    });
    const committed = (await f.interventionStore.listForRoot(
      definition.experiment_id,
      'locked-root',
    ))[0]!.record;
    await expect(f.interventionStore.put({
      ...committed,
      intervention_id: 'relabelled-intervention',
      turn_id: 'relabelled-turn',
      planner_fingerprint: 'post-hoc-planner',
    })).rejects.toThrow(/intervention definition mismatch/);
  });
});

describe('D-214 A25 proposal-critique attribution', () => {
  it('commits treatment before one advisory, then lets the repeated hash fall through', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, root, 't1');
    const critic = makeCritic(f);
    const state = new Map<string, unknown>();

    const first = await critic.critique({
      session_id: 's1',
      turn_id: 't1',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state,
    });
    expect(first).not.toBeNull();
    const committed = await f.interventionStore.listForRoot('exp-1', root);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.record.selected_evidence).toEqual(
      committed[0]!.record.shown_evidence,
    );
    expect(first!.critique.contradictions).toHaveLength(1);
    expect(state.get(EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY)).toEqual(
      new Set([committed[0]!.record.intervention_id]),
    );
    const consulted = state.get('d214:consulted-case-keys');
    expect(consulted).toEqual(new Set([f.row.case_key]));

    await expect(critic.critique({
      session_id: 's1',
      turn_id: 't1',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state,
    })).resolves.toBeNull();
    expect(await f.interventionStore.listForRoot('exp-1', root)).toHaveLength(1);

    f.interventionStore.markPlannerEgress(
      committed[0]!.record.intervention_id,
      600,
    );
    f.interventionStore.markSpanClosed(root, 700);
    const aggregate = await f.interventionStore.aggregate('exp-1');
    expect(aggregate.arms.treatment).toMatchObject({
      opportunities: 1,
      roots_with_opportunity: 1,
      selected_nonempty: 1,
      shown_nonempty: 1,
      planner_egress: 1,
      span_closed: 1,
      missing_egress: 0,
      missing_span_close: 0,
      critique_opportunities: 1,
    });
    expect(JSON.stringify(aggregate)).not.toContain(f.row.case_id);
    expect(await f.interventionStore.deleteForCase(f.row.case_id)).toBe(1);
    expect(await f.interventionStore.listForRoot('exp-1', root)).toEqual([]);
  });

  it('runs identical bounded selection in control but exposes nothing and consults nothing', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'control');
    await anchor(f, root, 't-control');
    const state = new Map<string, unknown>();
    const result = await makeCritic(f).critique({
      session_id: 's1',
      turn_id: 't-control',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state,
    });
    expect(result).toBeNull();
    const committed = (await f.interventionStore.listForRoot(
      'exp-1',
      root,
    ))[0]!;
    expect(committed.record.selected_evidence).toHaveLength(1);
    expect(committed.record.shown_evidence).toEqual([]);
    expect(state.has('d214:consulted-case-keys')).toBe(false);
    expect(state.has(EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY)).toBe(false);
  });

  it('records zero-evidence opportunities and deduplicates replay with the original id', async () => {
    const f = await fixture();
    f.caseStore.clearMaterialized();
    const root = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, root, 't-zero');
    const critic = makeCritic(f);
    await expect(critic.critique({
      session_id: 's1',
      turn_id: 't-zero',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    })).resolves.toBeNull();
    await expect(critic.critique({
      session_id: 's1',
      turn_id: 't-zero',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    })).resolves.toBeNull();
    const rows = await f.interventionStore.listForRoot('exp-1', root);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.record.qualifying_evidence).toEqual([]);
    expect(rows[0]!.record.selected_evidence).toEqual([]);
  });

  it('does not reinvoke for support-only evidence or advertise a negative-only flow as an alternative', async () => {
    const supportFixture = await fixture();
    const supportRow = {
      ...supportFixture.row,
      supersedes: 'superseded-negative',
      superseded_by: undefined,
      flows: supportFixture.row.flows.map((flow) => ({
        ...flow,
        verified_successes: 1,
        verification_failures: 0,
        execution_failures: 0,
        outcome_strength: {
          positive: 1,
          negative: 0,
          contested: false,
          evidence_families: ['verification_pass'],
        },
      })),
      outcome_strength: {
        positive: 1,
        negative: 0,
        contested: false,
        evidence_families: ['verification_pass'],
      },
    };
    const supersededNegative = {
      ...supportFixture.row,
      case_id: 'superseded-negative',
      case_key: 'superseded-negative-key',
      superseded_by: supportRow.case_id,
      supersedes: undefined,
    };
    await supportFixture.caseStore.replaceMaterialized(
      [supersededNegative, supportRow],
      new Map([
        [supersededNegative.case_id, ['report-negative']],
        [supportRow.case_id, ['report-support']],
      ]),
      new Map([
        [
          supersededNegative.case_id,
          'send the quarterly report to the customer',
        ],
        [
          supportRow.case_id,
          'send the quarterly report to the customer',
        ],
      ]),
    );
    const supportRoot = findArmRoot(
      supportFixture.interventionStore,
      'treatment',
    );
    await anchor(supportFixture, supportRoot, 't-support-only');
    const supportState = new Map<string, unknown>();
    await expect(makeCritic(supportFixture).critique({
      session_id: 's1',
      turn_id: 't-support-only',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: supportState,
    })).resolves.toBeNull();
    expect((await supportFixture.interventionStore.listForRoot(
      'exp-1',
      supportRoot,
    ))[0]!.record.qualifying_evidence).toEqual([]);
    expect(supportState.has(EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY))
      .toBe(false);

    const negativeFixture = await fixture();
    const negativeRoot = findArmRoot(
      negativeFixture.interventionStore,
      'treatment',
    );
    await anchor(negativeFixture, negativeRoot, 't-negative-alternative');
    await expect(makeCritic(negativeFixture).critique({
      session_id: 's1',
      turn_id: 't-negative-alternative',
      prompt: 'send the quarterly report to the customer',
      calls: [
        proposal,
        { tool: 'file.search', args: { query: 'confirm' } },
      ],
      state: new Map(),
    })).resolves.toBeNull();
    expect((await negativeFixture.interventionStore.listForRoot(
      'exp-1',
      negativeRoot,
    ))[0]!.record.qualifying_evidence).toEqual([]);
  });

  it('reports a post-critique topology revision separately from outcome quality', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, root, 't-revision');
    const critic = makeCritic(f);
    const state = new Map<string, unknown>();
    const first = await critic.critique({
      session_id: 's1',
      turn_id: 't-revision',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state,
    });
    const second = await critic.critique({
      session_id: 's1',
      turn_id: 't-revision',
      prompt: 'send the quarterly report to the customer',
      calls: [{
        tool: 'file.search',
        args: { query: 'quarterly report' },
      }, proposal],
      state,
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    for (const item of await f.interventionStore.listForRoot('exp-1', root)) {
      f.interventionStore.markPlannerEgress(
        item.record.intervention_id,
        600,
      );
    }
    f.interventionStore.markSpanClosed(root, 601);
    const report = await createExecutionCaseExperimentReporter({
      compiler: emptyCompiler(),
      interventionStore: f.interventionStore,
      caseStore: f.caseStore,
      now: () => 700,
    }).report(experiment());
    expect(
      report.eligibility_intent_to_treat.treatment.axes
        .critique_flow_revised,
    ).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(
      report.eligibility_intent_to_treat.treatment.axes
        .first_flow_survived,
    ).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(report.opportunity_measures.treatment.opportunities_per_root)
      .toMatchObject({ numerator: 2 });
  });

  it('does not call different proposals in different turns a critique revision', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, root, 'cross-turn-1');
    const critic = makeCritic(f);
    await critic.critique({
      session_id: 's1',
      turn_id: 'cross-turn-1',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    });
    const first = (await f.interventionStore.listForRoot(
      'exp-1',
      root,
    ))[0]!;
    f.interventionStore.markPlannerEgress(first.record.intervention_id, 600);
    expect(f.anchorStore.anchorTurn({
      root_request_id: root,
      session_id: 's1',
      turn_id: 'cross-turn-2',
      origin_turn_id: 'cross-turn-1',
      now: 601,
    })).toBe(true);
    await critic.critique({
      session_id: 's1',
      turn_id: 'cross-turn-2',
      prompt: 'send the quarterly report to the customer',
      calls: [
        { tool: 'file.search', args: { query: 'quarterly report' } },
        proposal,
      ],
      state: new Map(),
    });
    f.interventionStore.markSpanClosed(root, 699);
    const report = await createExecutionCaseExperimentReporter({
      compiler: emptyCompiler(),
      interventionStore: f.interventionStore,
      caseStore: f.caseStore,
      now: () => 700,
    }).report(experiment());
    expect(
      report.eligibility_intent_to_treat.treatment.axes
        .critique_flow_revised,
    ).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
  });

  it('does not call a control-arm post-dispatch proposal a critique revision', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'control');
    await anchor(f, root, 'control-sequence');
    const critic = makeCritic(f);
    await critic.critique({
      session_id: 's1',
      turn_id: 'control-sequence',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    });
    await critic.critique({
      session_id: 's1',
      turn_id: 'control-sequence',
      prompt: 'send the quarterly report to the customer',
      calls: [
        { tool: 'file.search', args: { query: 'quarterly report' } },
        proposal,
      ],
      state: new Map(),
    });
    f.interventionStore.markSpanClosed(root, 600);
    const baseCompiler = emptyCompiler();
    const compiler = {
      ...baseCompiler,
      resolveSpan: (root_request_id: string): ResolvedExecutionSpan => ({
        ...emptySpan(root_request_id),
        activities: [{
          activity_id: 'control-terminal-dispatch',
          timestamp: 600,
          session_id: 's1',
          turn_id: 'control-sequence',
          tool_name: 'mail.send',
          status: 'ok',
        }],
        first_event_id: 'control-terminal-dispatch',
        last_event_id: 'control-terminal-dispatch',
        has_substantive_flow: true,
      }),
    } as ExecutionCaseCompiler;
    const report = await createExecutionCaseExperimentReporter({
      compiler,
      interventionStore: f.interventionStore,
      caseStore: f.caseStore,
      now: () => 700,
    }).report(experiment());

    expect(
      report.eligibility_intent_to_treat.control.axes
        .first_flow_survived,
    ).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(
      report.eligibility_intent_to_treat.control.axes
        .critique_flow_revised,
    ).toMatchObject({ numerator: 0, denominator: 0, rate: null });
  });

  it('keeps assignment stable across candidates, enforces the root cap, and stores no raw args', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, root, 't1');
    const assigned = f.interventionStore.assignment({
      experiment_id: 'exp-1',
      root_request_id: root,
      assigned_at: 999,
      definition: experiment(),
      max_roots: 1,
    });
    expect(assigned).toBe('treatment');
    expect(f.interventionStore.assignment({
      experiment_id: 'exp-cap',
      root_request_id: 'cap-1',
      assigned_at: 1,
      definition: experiment({ experiment_id: 'exp-cap' }),
      max_roots: 1,
    })).toBeDefined();
    expect(f.interventionStore.assignment({
      experiment_id: 'exp-cap',
      root_request_id: 'cap-2',
      assigned_at: 2,
      definition: experiment({ experiment_id: 'exp-cap' }),
      max_roots: 1,
    })).toBeUndefined();

    await makeCritic(f).critique({
      session_id: 's1',
      turn_id: 't1',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    });
    const raw = f.db.prepare(`
      SELECT payload_encrypted FROM case_interventions
       WHERE root_request_id = ?
    `).get(root) as { payload_encrypted: string };
    expect(raw.payload_encrypted).not.toContain('alice@example.com');
    expect(raw.payload_encrypted).not.toContain('raw secret body');
    const decoded = (await f.interventionStore.listForRoot('exp-1', root))[0]!
      .record;
    expect(Object.hasOwn(decoded, 'prompt')).toBe(false);
    expect(Object.hasOwn(decoded, 'args')).toBe(false);
  });

  it('enforces the critique opportunity cap atomically across continuation streams', async () => {
    const f = await fixture();
    const definition = experiment({
      experiment_id: 'exp-atomic-critique-cap',
      max_critique_opportunities_per_root: 1,
    });
    const root = findArmRoot(
      f.interventionStore,
      'treatment',
      definition,
    );
    await anchor(f, root, 'cap-turn-1');
    expect(f.anchorStore.anchorTurn({
      root_request_id: root,
      session_id: 's1',
      turn_id: 'cap-turn-2',
      origin_turn_id: 'cap-turn-1',
      now: 11,
    })).toBe(true);
    const critic = makeCritic(f, { experiment: definition });

    await Promise.all([
      critic.critique({
        session_id: 's1',
        turn_id: 'cap-turn-1',
        prompt: 'send the quarterly report to the customer',
        calls: [proposal],
        state: new Map(),
      }),
      critic.critique({
        session_id: 's1',
        turn_id: 'cap-turn-2',
        prompt: 'send the quarterly report to the customer',
        calls: [
          { tool: 'file.search', args: { query: 'quarterly report' } },
          proposal,
        ],
        state: new Map(),
      }),
    ]);

    expect(await f.interventionStore.listForRoot(
      definition.experiment_id,
      root,
    )).toHaveLength(1);
    expect(f.interventionStore.health(definition.experiment_id))
      .toBeUndefined();
  });

  it('fails unsteered and marks health when attribution cannot commit', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, root, 't-fail');
    const broken = {
      ...f.interventionStore,
      put: async () => {
        throw new Error('disk full');
      },
    };
    const result = await makeCritic(f, {
      interventionStore: broken,
    }).critique({
      session_id: 's1',
      turn_id: 't-fail',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    });
    expect(result).toBeNull();
    expect(f.interventionStore.health('exp-1')).toMatchObject({
      healthy: false,
      last_failure: 'record_write_failed',
    });
    expect(f.interventionStore.listAssignments('exp-1')).toEqual([]);
    expect(await f.interventionStore.aggregate('exp-1')).toMatchObject({
      assigned_roots: { control: 0, treatment: 0 },
      invalid_roots: { control: 0, treatment: 1 },
    });
  });

  it('does not disguise a missing intervention commit as a cap race', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, root, 't-missing-commit');
    const broken = {
      ...f.interventionStore,
      put: async () => false,
      getForOpportunity: async () => undefined,
    };
    await expect(makeCritic(f, {
      interventionStore: broken,
    }).critique({
      session_id: 's1',
      turn_id: 't-missing-commit',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    })).resolves.toBeNull();
    expect(f.interventionStore.health('exp-1')).toMatchObject({
      healthy: false,
      last_failure: 'record_write_failed',
    });
    expect(f.interventionStore.listAssignments('exp-1')).toEqual([]);
    expect(await f.interventionStore.aggregate('exp-1')).toMatchObject({
      assigned_roots: { control: 0, treatment: 0 },
      invalid_roots: { control: 0, treatment: 1 },
    });
  });

  it('invalidates a treatment that cannot be rendered and never queues egress', async () => {
    const f = await fixture();
    const root = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, root, 't-render-fail');
    const put = f.interventionStore.put.bind(f.interventionStore);
    const renderBreakingStore = {
      ...f.interventionStore,
      async put(record: Parameters<typeof put>[0]) {
        const inserted = await put(record);
        f.caseStore.clearMaterialized();
        return inserted;
      },
    };
    const state = new Map<string, unknown>();
    await expect(makeCritic(f, {
      interventionStore: renderBreakingStore,
    }).critique({
      session_id: 's1',
      turn_id: 't-render-fail',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state,
    })).resolves.toBeNull();
    expect(state.has(EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY)).toBe(false);
    expect(f.interventionStore.listAssignments('exp-1')).toEqual([]);
    expect(await f.interventionStore.aggregate('exp-1')).toMatchObject({
      invalid_roots: { control: 0, treatment: 1 },
    });
  });
});

describe('D-214 A25 request augmentation attribution', () => {
  it('renders only a committed treatment selection and fails closed on revocation', async () => {
    const f = await fixture();
    const definition = experiment({
      experiment_id: 'exp-aug',
      surface: 'request_augmentation',
    });
    const root = findArmRoot(
      f.interventionStore,
      'treatment',
      definition,
    );
    await anchor(f, root, 't-aug');
    let active = true;
    const source = createExecutionCaseAugmentationSource(() => ({
      anchorStore: f.anchorStore,
      caseStore: f.caseStore,
      candidateSource: {
        id: 'fixture-source',
        findCandidates: async () => ({
          candidates: [f.row.case_id],
          partial: true,
        }),
      },
      interventionStore: f.interventionStore,
      experiment: definition,
      resolveScope: () => ({
        governing_contract_id: 'owner',
        principal_key: 'user_self',
        active,
      }),
      now: () => 500,
      newInterventionId: () => 'aug-intervention',
    }));
    const state = new Map<string, unknown>();
    const ctx = {
      surface: 'chat',
      session_id: 's1',
      turn_id: 't-aug',
      history: [{
        role: 'user',
        text: 'send the quarterly report to the customer',
      }],
      state,
    } as never;
    await source.prompt!(ctx);
    expect(readExecutionCaseContext(state)?.cards).toHaveLength(1);
    const committed = (await f.interventionStore.listForRoot(
      definition.experiment_id,
      root,
    ))[0]!;
    expect(committed.record).toMatchObject({
      candidate_source_id: 'fixture-source',
      candidate_source_partial: true,
    });
    expect(committed.record.shown_evidence)
      .toEqual(committed.record.selected_evidence);
    f.interventionStore.markPlannerEgress(
      committed.record.intervention_id,
      600,
    );
    f.interventionStore.markSpanClosed(root, 700);
    const report = await createExecutionCaseExperimentReporter({
      compiler: emptyCompiler(),
      interventionStore: f.interventionStore,
      caseStore: f.caseStore,
      now: () => 800,
    }).report(definition);
    expect(
      report.opportunity_measures.treatment
        .augmentation_candidate_count_distribution,
    ).toEqual({
      denominator: 1,
      min: 1,
      max: 1,
      mean: 1,
      histogram: [{ candidate_count: 1, opportunities: 1 }],
    });
    expect(
      report.opportunity_measures.treatment.augmentation_partial_source,
    ).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(
      report.opportunity_measures.treatment.treatment_exposure,
    ).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });

    active = false;
    const revokedState = new Map<string, unknown>();
    await source.prompt!({
      ...(ctx as object),
      state: revokedState,
    } as never);
    expect(readExecutionCaseContext(revokedState)).toBeUndefined();
  });

  it('renders source-derived history axes and adjacent-edge supersession reasons', async () => {
    const f = await fixture();
    const definition = experiment({
      experiment_id: 'exp-aug-history',
      surface: 'request_augmentation',
      policy_fingerprint: 'policy-2',
    });
    const root = findArmRoot(
      f.interventionStore,
      'treatment',
      definition,
    );
    await anchor(f, root, 't-aug-history');

    const specifications = [
      {
        id: 'history-not-required',
        policy: 'policy-0',
        compiler: 1,
        authorization: 'not_required' as const,
        execution: 'succeeded' as const,
        at: 100,
      },
      {
        id: 'history-allowed',
        policy: 'policy-0',
        compiler: 1,
        authorization: 'allowed' as const,
        execution: 'succeeded' as const,
        at: 200,
      },
      {
        id: 'history-dismissed',
        policy: 'policy-1',
        compiler: 1,
        authorization: 'dismissed' as const,
        execution: 'not_executed' as const,
        at: 300,
      },
      {
        id: 'history-expired',
        policy: 'policy-2',
        compiler: 1,
        authorization: 'expired' as const,
        execution: 'not_executed' as const,
        at: 400,
      },
      {
        id: 'history-denied',
        policy: 'policy-2',
        compiler: 2,
        authorization: 'denied' as const,
        execution: 'not_executed' as const,
        at: 500,
      },
    ];
    const historical = specifications.map((item, index) => ({
      ...f.row,
      case_id: item.id,
      case_key: `key-${item.id}`,
      compiler_version: item.compiler,
      policy_fingerprint: item.policy,
      history_outcome: {
        authorization: item.authorization,
        execution: item.execution,
        verification: 'unavailable' as const,
        feedback: 'unknown' as const,
      },
      // Deliberately erase the lossy aggregate signal. The builder must read
      // `history_outcome`, not reverse-engineer these axes from families.
      outcome_strength: {
        positive: 0,
        negative: 1,
        contested: false,
        evidence_families: [],
      },
      supersedes: specifications[index - 1]?.id,
      superseded_by: specifications[index + 1]?.id ?? 'history-current',
      first_seen_at: item.at,
      last_seen_at: item.at,
    }));
    const current = {
      ...f.row,
      case_id: 'history-current',
      case_key: 'key-history-current',
      compiler_version: EXECUTION_CASE_COMPILER_VERSION,
      policy_fingerprint: 'policy-2',
      supersedes: historical.at(-1)!.case_id,
      superseded_by: undefined,
      first_seen_at: 600,
      last_seen_at: 600,
    };
    const rows = [...historical, current];
    await f.caseStore.replaceMaterialized(
      rows,
      new Map(rows.map((row) => [row.case_id, [`report-${row.case_id}`]])),
      new Map(rows.map((row) => [
        row.case_id,
        'send the quarterly report to the customer',
      ])),
    );

    const state = new Map<string, unknown>();
    await createExecutionCaseAugmentationSource(() => ({
      anchorStore: f.anchorStore,
      caseStore: f.caseStore,
      candidateSource: {
        id: 'fixture-source',
        findCandidates: async () => ({
          candidates: [current.case_id],
          partial: false,
        }),
      },
      interventionStore: f.interventionStore,
      experiment: definition,
      resolveScope: () => ({
        governing_contract_id: 'owner',
        principal_key: 'user_self',
        active: true,
      }),
      now: () => 500,
      newInterventionId: () => 'aug-history',
    })).prompt!({
      surface: 'chat',
      session_id: 's1',
      turn_id: 't-aug-history',
      history: [{
        role: 'user',
        text: 'send the quarterly report to the customer',
      }],
      state,
    } as never);

    expect(readExecutionCaseContext(state)?.cards[0]?.history.map((run) => ({
      authorization: run.outcome.authorization,
      superseded_reason: run.superseded_reason,
    }))).toEqual([
      {
        authorization: 'denied',
        superseded_reason: 'compiler_upgrade',
      },
      {
        authorization: 'expired',
        superseded_reason: 'compiler_upgrade',
      },
      {
        authorization: 'dismissed',
        superseded_reason: 'policy_fingerprint',
      },
      {
        authorization: 'allowed',
        superseded_reason: 'policy_fingerprint',
      },
      {
        authorization: 'not_required',
        superseded_reason: 'flow_forked',
      },
    ]);
  });

  it('records the same bounded selection in control without rendering and deduplicates replay', async () => {
    const f = await fixture();
    const definition = experiment({
      experiment_id: 'exp-aug-control',
      surface: 'request_augmentation',
    });
    const root = findArmRoot(
      f.interventionStore,
      'control',
      definition,
    );
    await anchor(f, root, 't-aug-control');
    let minted = 0;
    const middleware = createExecutionCaseAugmentationSource(() => ({
      anchorStore: f.anchorStore,
      caseStore: f.caseStore,
      candidateSource: {
        id: 'fixture-source',
        findCandidates: async () => ({
          candidates: [f.row.case_id],
          partial: false,
        }),
      },
      interventionStore: f.interventionStore,
      experiment: definition,
      resolveScope: () => ({
        governing_contract_id: 'owner',
        principal_key: 'user_self',
        active: true,
      }),
      now: () => 500,
      newInterventionId: () => `aug-${++minted}`,
    }));
    const run = async () => {
      const state = new Map<string, unknown>();
      await middleware.prompt!({
        surface: 'chat',
        session_id: 's1',
        turn_id: 't-aug-control',
        history: [{
          role: 'user',
          text: 'send the quarterly report to the customer',
        }],
        state,
      } as never);
      return state;
    };
    expect(readExecutionCaseContext(await run())).toBeUndefined();
    expect(readExecutionCaseContext(await run())).toBeUndefined();
    const rows = await f.interventionStore.listForRoot(
      definition.experiment_id,
      root,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.record.selected_evidence).toHaveLength(1);
    expect(rows[0]!.record.shown_evidence).toEqual([]);
  });

  it('withholds oversized qualifying evidence from both advisory surfaces', async () => {
    const f = await fixture();
    const oversized = {
      ...f.row,
      request_shape: {
        ...f.row.request_shape,
        surface_terms: [
          ...f.row.request_shape.surface_terms,
          'x'.repeat(30_000),
        ],
      },
    };
    await f.caseStore.replaceMaterialized(
      [oversized],
      new Map([[oversized.case_id, ['report-1']]]),
      new Map([[
        oversized.case_id,
        'send the quarterly report to the customer',
      ]]),
    );

    const augmentationExperiment = experiment({
      experiment_id: 'exp-aug-oversized',
      surface: 'request_augmentation',
    });
    const augmentationRoot = findArmRoot(
      f.interventionStore,
      'treatment',
      augmentationExperiment,
    );
    await anchor(f, augmentationRoot, 't-aug-oversized');
    const augmentationState = new Map<string, unknown>();
    await createExecutionCaseAugmentationSource(() => ({
      anchorStore: f.anchorStore,
      caseStore: f.caseStore,
      candidateSource: {
        id: 'fixture-source',
        findCandidates: async () => ({
          candidates: [oversized.case_id],
          partial: false,
        }),
      },
      interventionStore: f.interventionStore,
      experiment: augmentationExperiment,
      resolveScope: () => ({
        governing_contract_id: 'owner',
        principal_key: 'user_self',
        active: true,
      }),
      now: () => 500,
      newInterventionId: () => 'aug-oversized',
    })).prompt!({
      surface: 'chat',
      session_id: 's1',
      turn_id: 't-aug-oversized',
      history: [{
        role: 'user',
        text: 'send the quarterly report to the customer',
      }],
      state: augmentationState,
    } as never);
    expect(readExecutionCaseContext(augmentationState)).toBeUndefined();
    const augmentationRecord = (await f.interventionStore.listForRoot(
      augmentationExperiment.experiment_id,
      augmentationRoot,
    ))[0]!.record;
    expect(augmentationRecord.qualifying_evidence).toHaveLength(1);
    expect(augmentationRecord.selected_evidence).toEqual([]);
    expect(augmentationRecord.shown_evidence).toEqual([]);

    const critiqueExperiment = experiment({
      experiment_id: 'exp-critique-oversized',
      surface: 'proposal_critique',
    });
    const critiqueRoot = findArmRoot(
      f.interventionStore,
      'treatment',
      critiqueExperiment,
    );
    await anchor(f, critiqueRoot, 't-critique-oversized');
    const critique = createExecutionCaseProposalCritic({
      anchorStore: f.anchorStore,
      caseStore: f.caseStore,
      interventionStore: f.interventionStore,
      registry,
      experiment: critiqueExperiment,
      resolveScope: () => ({
        governing_contract_id: 'owner',
        principal_key: 'user_self',
        active: true,
      }),
      now: () => 500,
      newInterventionId: () => 'critique-oversized',
    });
    await expect(critique.critique({
      session_id: 's1',
      turn_id: 't-critique-oversized',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    })).resolves.toBeNull();
    const critiqueRecord = (await f.interventionStore.listForRoot(
      critiqueExperiment.experiment_id,
      critiqueRoot,
    ))[0]!.record;
    expect(critiqueRecord.qualifying_evidence).toHaveLength(1);
    expect(critiqueRecord.selected_evidence).toEqual([]);
    expect(critiqueRecord.shown_evidence).toEqual([]);
  });
});

describe('D-214 owner experiment reporting', () => {
  it('reports missing planner-round telemetry as missing, never as zero', async () => {
    const f = await fixture();
    const definition = experiment({ experiment_id: 'exp-missing-rounds' });
    const root = 'root-without-turn-metric';
    const assignment = f.interventionStore.assignment({
      experiment_id: definition.experiment_id,
      root_request_id: root,
      assigned_at: 10,
      definition,
    });
    expect(assignment).toBeDefined();

    const report = await createExecutionCaseExperimentReporter({
      compiler: emptyCompiler(),
      interventionStore: f.interventionStore,
      caseStore: f.caseStore,
      now: () => 999,
    }).report(definition);
    const arm = report.all_opportunity_rollout[assignment!];
    expect(arm.operational.planner_rounds).toEqual({
      available: false,
      total: 0,
      denominator_roots: 0,
      mean_per_root: null,
    });
  });

  it('keeps open spans out of outcome denominators until closure is durable', async () => {
    const f = await fixture();
    const definition = experiment({
      experiment_id: 'exp-open-span-denominator',
    });
    const root = findArmRoot(
      f.interventionStore,
      'treatment',
      definition,
    );
    await anchor(f, root, 'open-span-turn');
    await makeCritic(f, { experiment: definition }).critique({
      session_id: 's1',
      turn_id: 'open-span-turn',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    });
    const reporter = createExecutionCaseExperimentReporter({
      compiler: emptyCompiler(),
      interventionStore: f.interventionStore,
      caseStore: f.caseStore,
      now: () => 999,
    });

    const open = await reporter.report(definition);
    expect(
      open.eligibility_intent_to_treat.treatment.axes.explicit_acceptance,
    ).toMatchObject({ numerator: 0, denominator: 0, rate: null });
    expect(open.opportunity_measures.treatment.record_to_closed_span)
      .toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(
      open.eligibility_intent_to_treat.treatment.operational.governed_calls,
    ).toEqual({ total: 0, denominator_roots: 0, mean_per_root: null });

    f.interventionStore.markSpanClosed(root, 1_000);
    const closed = await reporter.report(definition);
    expect(
      closed.eligibility_intent_to_treat.treatment.axes.explicit_acceptance,
    ).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(
      closed.eligibility_intent_to_treat.treatment.axes.execution_failure,
    ).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(
      closed.eligibility_intent_to_treat.treatment.axes.authorization_denial,
    ).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(
      closed.eligibility_intent_to_treat.treatment.operational.governed_calls,
    ).toEqual({ total: 0, denominator_roots: 1, mean_per_root: 0 });
  });

  it('reports separated causal axes with denominators, uncertainty, and no raw roots', async () => {
    const f = await fixture();
    const controlRoot = findArmRoot(f.interventionStore, 'control');
    const treatmentRoot = findArmRoot(f.interventionStore, 'treatment');
    await anchor(f, controlRoot, 't-control-report');
    await anchor(f, treatmentRoot, 't-treatment-report');
    const critic = makeCritic(f);
    await critic.critique({
      session_id: 's1',
      turn_id: 't-control-report',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    });
    await critic.critique({
      session_id: 's1',
      turn_id: 't-treatment-report',
      prompt: 'send the quarterly report to the customer',
      calls: [proposal],
      state: new Map(),
    });
    expect(f.interventionStore.recordPlannerRounds({
      root_request_id: controlRoot,
      session_id: 's1',
      turn_id: 't-control-report',
      rounds: 2,
    })).toBe(1);
    expect(f.interventionStore.recordPlannerRounds({
      root_request_id: controlRoot,
      session_id: 's1',
      turn_id: 't-control-report',
      rounds: 4,
    })).toBe(1);
    expect(f.interventionStore.recordPlannerRounds({
      root_request_id: treatmentRoot,
      session_id: 's1',
      turn_id: 't-treatment-report',
      rounds: 3,
    })).toBe(1);
    const treatmentIntervention = (await f.interventionStore.listForRoot(
      'exp-1',
      treatmentRoot,
    ))[0]!;
    f.interventionStore.markPlannerEgress(
      treatmentIntervention.record.intervention_id,
      700,
    );
    f.interventionStore.markSpanClosed(controlRoot, 701);
    f.interventionStore.markSpanClosed(treatmentRoot, 701);

    const span = (
      root: string,
      accepted: boolean,
    ): ResolvedExecutionSpan => {
      const turn = accepted ? 't-treatment-report' : 't-control-report';
      const planId = `plan-${accepted ? 'treatment' : 'control'}`;
      return {
        root_request_id: root,
        activities: [{
          activity_id: `activity-${root}`,
          timestamp: 600,
          session_id: 's1',
          turn_id: turn,
          tool_name: 'mail.send',
          status: accepted ? 'ok' : 'error',
        }],
        recipe_runs: [],
        plans: [{
          plan_id: planId,
          session_id: 's1',
          turn_id: turn,
          retry_of_plan_id: null,
          tool: 'mail.send',
          classification: 'write',
          status: accepted ? 'approved' : 'cancelled',
          created_at: 500,
          resolved_at: 510,
          consumed_at: accepted ? 520 : null,
          execution_status: accepted ? 'completed' : null,
          execution_turn_id: accepted ? turn : null,
          execution_updated_at: accepted ? 600 : null,
        }],
        feedback: [{
          feedback_id: `feedback-${root}`,
          root_request_id: root,
          session_id: 's1',
          kind: accepted ? 'accepted' : 'corrected',
          ...(!accepted ? { source_plan_id: planId } : {}),
          recorded_at: 650,
        }],
        verifications: [{
          verification_id: `verification-${root}`,
          root_request_id: root,
          session_id: 's1',
          kind: accepted ? 'passed' : 'failed',
          postcondition_key: 'mail-delivery',
          source_event_id: `provider-${root}`,
          recorded_at: 660,
        }],
        typed_correction_plan_ids:
          accepted ? new Set() : new Set([planId]),
        first_event_id: `activity-${root}`,
        last_event_id: `verification-${root}`,
        pending: false,
        has_substantive_flow: true,
        has_strong_signal: true,
        has_compilable_signal: true,
      };
    };
    const compiler = {
      resolveSpan: (root: string) =>
        span(root, root === treatmentRoot),
      runtimeCompositionDiagnostics: () => ({
        corpus_roots: 2,
        dispatches: 2,
        route_kind_counts: {
          installed_recipe: 1,
          dynamic_ingredient: 0,
          inline_recipe: 0,
          direct_tool: 1,
        },
        recurring_dynamic_inline_subgraphs: [],
        source_coverage: {
          audit_activity_rows: 2,
          recipe_run_rows: 1,
          paired_recipe_runs: 1,
          unpaired_recipe_runs: 0,
        },
      }),
    } as unknown as ExecutionCaseCompiler;
    const report = await createExecutionCaseExperimentReporter({
      compiler,
      interventionStore: f.interventionStore,
      caseStore: f.caseStore,
      now: () => 999,
    }).report(experiment());

    expect(report.eligibility_intent_to_treat.control.cohort_roots).toBe(1);
    expect(report.eligibility_intent_to_treat.treatment.cohort_roots).toBe(1);
    expect(report.eligibility_intent_to_treat.control.axes)
      .toMatchObject({
        explicit_correction: { numerator: 1, denominator: 1, rate: 1 },
        explicit_acceptance: { numerator: 0, denominator: 1, rate: 0 },
        verification_failure: { numerator: 1, denominator: 1, rate: 1 },
        plan_declined: { numerator: 1, denominator: 1, rate: 1 },
      });
    expect(report.eligibility_intent_to_treat.treatment.axes)
      .toMatchObject({
        explicit_acceptance: { numerator: 1, denominator: 1, rate: 1 },
        explicit_correction: { numerator: 0, denominator: 1, rate: 0 },
        verified_success: { numerator: 1, denominator: 1, rate: 1 },
        plan_accepted: { numerator: 1, denominator: 1, rate: 1 },
      });
    expect(
      report.eligibility_intent_to_treat.control.axes
        .explicit_correction.uncertainty_95,
    ).toMatchObject({ method: 'wilson' });
    expect(
      report.eligibility_intent_to_treat.control.operational.planner_rounds,
    ).toEqual({
      available: true,
      total: 4,
      denominator_roots: 1,
      mean_per_root: 4,
    });
    expect(
      report.eligibility_intent_to_treat.treatment.operational.planner_rounds,
    ).toMatchObject({
      available: true,
      total: 3,
      denominator_roots: 1,
      mean_per_root: 3,
    });
    expect(report.treatment_exposure_descriptive.cohort_roots).toBe(1);
    expect(report.readiness.case_density_per_scope).toEqual({
      total_cases: 1,
      denominator_scopes: 1,
      mean: 1,
      min: 1,
      max: 1,
    });
    expect(
      report.opportunity_measures.treatment.record_to_egress,
    ).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(
      report.eligibility_intent_to_treat.treatment.axes
        .approval_binding_survived,
    ).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(
      report.eligibility_intent_to_treat.treatment.axes
        .critique_flow_revised,
    ).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(report.eligibility_itt_by_fingerprint).toHaveLength(1);
    expect(report.recipe_topology_diagnostic).toMatchObject({
      corpus_roots: 2,
      dispatches: 2,
      route_kind_counts: {
        installed_recipe: 1,
        direct_tool: 1,
      },
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(controlRoot);
    expect(serialized).not.toContain(treatmentRoot);
    expect(serialized).not.toContain('false_positive');
    expect(serialized).not.toContain('unnecessary_call');
    expect(serialized).not.toContain('"score"');
  });
});

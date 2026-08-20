import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatDispatchContext,
  InternalToolRegistry,
  ToolEntry,
  ToolTier,
} from '@recued/contracts';

import {
  createExecutionCaseCompiler,
} from '../execution-case-compiler.js';
import {
  createExecutionCaseFeedbackRecorder,
} from '../execution-case-feedback.js';
import {
  createExecutionCaseVerificationRecorder,
} from '../execution-case-verification.js';
import {
  createExecutionCaseLifecycle,
  parseOutcomeReportArgs,
  wrapRegistryWithExecutionCaseTools,
  OUTCOME_REPORT_TOOL_NAME,
  REQUEST_DISSECTION_TOOL_NAME,
} from '../chat-execution-case-tools.js';
import {
  createD213ScanCaseCandidateSource,
  createNullCaseCandidateSource,
  EXECUTION_CASE_ELIGIBLE_POPULATION,
  EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY,
  type ExecutionCaseExperimentDefinition,
} from '../execution-case-retrieval.js';
import {
  EXECUTION_CASE_COMPILER_VERSION,
  rankExecutionCaseCandidates,
  rebuildExecutionCases,
  renderExecutionCaseCard,
} from '../execution-case-core.js';
import {
  createCaseInterventionStore,
} from '../storage/case-intervention-store.js';
import {
  createExecutionCaseFeedbackStore,
} from '../storage/execution-case-feedback-store.js';
import {
  createExecutionCaseStore,
} from '../storage/execution-case-store.js';
import {
  createExecutionReportStore,
} from '../storage/execution-report-store.js';
import {
  createExecutionSpanAnchorStore,
} from '../storage/execution-span-anchor-store.js';
import {
  createExecutionSpanDissectionStore,
} from '../storage/execution-span-dissection-store.js';
import {
  createExecutionCaseVerificationStore,
} from '../storage/execution-case-verification-store.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';
import {
  composeExecutionCases,
} from '../composition/bin/wire-execution-cases.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const keyProvider = (): D214KeyProvider => {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i += 1) key[i] = (i * 13 + 9) & 0xff;
  return () => key;
};

const experimentDefinition = (
  experiment_id: string,
  surface: ExecutionCaseExperimentDefinition['surface'] =
    'proposal_critique',
): ExecutionCaseExperimentDefinition => ({
  experiment_id,
  surface,
  eligible_population:
    EXECUTION_CASE_ELIGIBLE_POPULATION[surface],
  starts_at: 0,
  ends_at: 10_000,
  max_roots: 100,
  max_critique_opportunities_per_root: 2,
  max_evidence: 3,
  min_relevance_score: 1,
  primary_axes: ['verified_success'],
  material_harm_bounds: { execution_failure: 0 },
  decision_rule: 'fixture',
  planner_fingerprint: 'planner-v1',
  prompt_fingerprint: 'prompt-v1',
  retrieval_fingerprint: 'retrieval-v1',
  policy_fingerprint: 'policy-v1',
});

const entries: ToolEntry[] = [
  {
    name: 'file.search',
    tier: 1,
    description: 'search files',
    arg_schema: {},
    topic_tags: ['files'],
    classification: 'read',
    risk_tier: 'read',
    concurrency_safe: true,
  },
  {
    name: 'mail.send',
    tier: 2,
    description: 'send mail',
    arg_schema: {},
    topic_tags: ['mail'],
    classification: 'write',
    risk_tier: 'write',
    concurrency_safe: false,
  },
  {
    name: 'peer.tool',
    tier: 3,
    description: 'peer tool',
    arg_schema: {},
    topic_tags: ['peer'],
    classification: 'read',
    risk_tier: 'read',
    concurrency_safe: true,
  },
  {
    name: 'recipe.run',
    tier: 1,
    description: 'run inline recipe',
    arg_schema: {},
    topic_tags: ['recipe'],
    classification: 'write',
    risk_tier: 'write',
    concurrency_safe: false,
  },
];

const registry = (): InternalToolRegistry => ({
  list: () => [...entries],
  listByTier: (tier: ToolTier) => entries.filter((entry) => entry.tier === tier),
  getByName: (name: string) =>
    entries.find((entry) => entry.name === name) ?? null,
  dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
  subscribeRefresh: () => () => {},
});

const schema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE audit_activities (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE audit_entries (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE chat_plans (
      plan_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      retry_of_plan_id TEXT,
      tool TEXT NOT NULL,
      classification TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      consumed_at INTEGER,
      execution_status TEXT,
      execution_turn_id TEXT,
      execution_updated_at INTEGER
    );
    CREATE TABLE correction_events (
      event_id TEXT PRIMARY KEY,
      source_plan_id TEXT,
      kind TEXT NOT NULL,
      payload_blob TEXT NOT NULL
    );
  `);
};

const addRecipeRun = (
  db: Database.Database,
  input: {
    id: string;
    at: number;
    session?: string;
    turn?: string;
    recipe: string;
    hash?: string;
    status?: string;
    errorCodes?: string[];
    /** D-237 P2 run yield, written onto the raw audit row exactly as the engine
     *  stamps it — so a test of the outcome reading starts where the value is
     *  BORN and has to survive the compiler's own parse boundary. */
    runYield?: unknown;
  },
): void => {
  const row = {
    run_id: input.id,
    recipe_id: input.recipe,
    recipe_hash: input.hash ?? `hash-${input.id}`,
    started_at: input.at,
    finished_at: input.at + 1,
    commit_status: input.status ?? 'succeeded',
    ...(input.runYield !== undefined ? { run_yield: input.runYield } : {}),
    errors: (input.errorCodes ?? []).map((code) => ({ code })),
    execution_source: {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: input.session ?? 's1',
      user_id: 'owner',
      turn_id: input.turn ?? 't1',
    },
  };
  db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run(
    input.id,
    JSON.stringify(row),
  );
};

const addActivity = (
  db: Database.Database,
  input: {
    id: string;
    at: number;
    session?: string;
    turn?: string;
    tool: string;
    status?: 'ok' | 'error';
    reason?: string;
  },
): void => {
  const activity = {
    activity_id: input.id,
    timestamp: input.at,
    action: 'chat_tool_call',
    target:
      `${input.session ?? 's1'}:${input.turn ?? 't1'}:${input.tool}`,
    detail: JSON.stringify({
      status: input.status ?? 'ok',
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  };
  db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
    input.id,
    JSON.stringify(activity),
  );
};

const fixture = async () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  schema(db);
  const key = keyProvider();
  const anchorStore = createExecutionSpanAnchorStore(db, key);
  const reportStore = createExecutionReportStore(db, key);
  const caseStore = createExecutionCaseStore(db, key);
  const dissectionStore = createExecutionSpanDissectionStore(db, key);
  const interventionStore = createCaseInterventionStore(
    db,
    key,
    new TextEncoder().encode('integration-assignment-secret'),
  );
  const feedbackStore = createExecutionCaseFeedbackStore(db);
  const verificationStore = createExecutionCaseVerificationStore(db);
  const tools = registry();
  const compiler = createExecutionCaseCompiler({
    db,
    anchorStore,
    reportStore,
    caseStore,
    dissectionStore,
    feedbackStore,
    verificationStore,
    registry: tools,
  });
  let clock = 1_000;
  const lifecycle = createExecutionCaseLifecycle({
    anchorStore,
    reportStore,
    caseStore: undefined as never,
    dissectionStore,
    compiler,
    registry: tools,
    interventionStore,
    now: () => clock++,
    newReportId: () => 'report-1',
  } as Parameters<typeof createExecutionCaseLifecycle>[0]);
  const feedbackRecorder = createExecutionCaseFeedbackRecorder({
    anchorStore,
    reportStore,
    caseStore,
    feedbackStore,
    interventionStore,
    compiler,
    now: () => clock++,
  });
  const verificationRecorder = createExecutionCaseVerificationRecorder({
    anchorStore,
    reportStore,
    caseStore,
    verificationStore,
    compiler,
    now: () => clock++,
  });
  return {
    db,
    anchorStore,
    reportStore,
    caseStore,
    dissectionStore,
    interventionStore,
    feedbackStore,
    verificationStore,
    compiler,
    lifecycle,
    feedbackRecorder,
    verificationRecorder,
  };
};

const open = async (
  f: Awaited<ReturnType<typeof fixture>>,
  input: {
    root?: string;
    session?: string;
    turn?: string;
    prompt?: string;
  } = {},
) => {
  await f.anchorStore.openSpan({
    root_request_id: input.root ?? 'r1',
    session_id: input.session ?? 's1',
    surface: 'chat',
    root_request:
      input.prompt ?? 'send the quarterly report to the customer',
    turn_id: input.turn ?? 't1',
    now: 100,
  });
};

const context = (
  state = new Map<string, unknown>(),
  input: { session?: string; turn?: string } = {},
): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: input.session ?? 's1',
  turn_id: input.turn ?? 't1',
  turn_state: state,
});

describe('D-214 report and feedback lifecycle', () => {
  it('consumes pending advisory attribution at the next planner egress only', async () => {
    const f = await fixture();
    const state = new Map<string, unknown>([[
      EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY,
      new Set(['intervention-next-packet']),
    ]]);
    f.lifecycle.markPlannerEgress(state, 100);
    expect(state.has(EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY)).toBe(false);
    f.lifecycle.markPlannerEgress(state, 101);
    expect(state.has(EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY)).toBe(false);
  });

  it('accepts only claim/open_items and server-binds root, range, scope, and consulted keys', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'file.search' });
    addActivity(f.db, { id: 'a2', at: 102, tool: 'mail.send' });

    expect(parseOutcomeReportArgs({
      claim: 'fulfilled',
      case_key: 'model-controlled',
    })).toBeNull();
    expect(parseOutcomeReportArgs({
      claim: 'fulfilled',
      open_items: ['waiting for delivery receipt'],
    })).toEqual({
      claim: 'fulfilled',
      open_items: ['waiting for delivery receipt'],
    });

    const state = new Map<string, unknown>([
      ['d214:consulted-case-keys', new Set(['case-a', 'case-a', 'case-b'])],
    ]);
    const result = await f.lifecycle.dispatchOutcome(
      {
        claim: 'fulfilled',
        open_items: ['waiting for delivery receipt'],
      },
      context(state),
    );
    expect(result).toMatchObject({ ok: true });
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
      state,
    });
    const stored = (await f.reportStore.listForRoot('r1'))[0]!;
    expect(stored.report).toMatchObject({
      root_request_id: 'r1',
      root_request: 'send the quarterly report to the customer',
      event_range: {
        first_event_id: 'a1',
        last_event_id: 'a2',
      },
      consulted_case_keys: ['case-a', 'case-b'],
    });
    expect(await f.caseStore.listAll()).toEqual([]);

    const raw = f.db.prepare(`
      SELECT root_request_encrypted, open_items_encrypted
        FROM execution_reports WHERE report_id = 'report-1'
    `).get() as {
      root_request_encrypted: string;
      open_items_encrypted: string;
    };
    expect(raw.root_request_encrypted).not.toContain('quarterly');
    expect(raw.open_items_encrypted).not.toContain('delivery');

    expect(await f.feedbackRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'accepted',
    })).toEqual({ ok: true, recorded: true });
    expect(await f.feedbackRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'accepted',
    })).toEqual({ ok: true, recorded: false });
    const cases = await f.caseStore.listAll();
    expect(cases).toHaveLength(1);
    expect(cases[0]!.outcome_strength.evidence_families)
      .toContain('typed_acceptance');
    const card = (await f.caseStore.get(cases[0]!.case_id))!;
    expect(Object.hasOwn(card, 'open_items')).toBe(false);
    expect(await f.caseStore.listScope({
      governing_contract_id: 'other',
      principal_key: 'user_self',
    })).toEqual([]);

    await f.compiler.deleteSource('report-1');
    expect(await f.caseStore.listAll()).toEqual([]);
    expect(await f.reportStore.get('report-1')).toBeUndefined();
  });

  it('retracts one strong typed feedback fact and removes its durable precedent', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'retract-a1', at: 101, tool: 'file.search' });
    addActivity(f.db, { id: 'retract-a2', at: 102, tool: 'mail.send' });
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context());
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    expect(await f.caseStore.listAll()).toEqual([]);

    await expect(f.feedbackRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'rejected',
    })).resolves.toEqual({ ok: true, recorded: true });
    expect(await f.caseStore.listAll()).toEqual([
      expect.objectContaining({
        outcome_strength: expect.objectContaining({
          positive: 0,
          negative: 1,
          evidence_families: expect.arrayContaining(['typed_rejection']),
        }),
      }),
    ]);
    const admittedCase = (await f.caseStore.listAll())[0]!;
    let treatmentExperiment: ExecutionCaseExperimentDefinition | undefined;
    for (let index = 0; index < 100; index += 1) {
      const definition = experimentDefinition(`retract-exp-${index}`);
      if (f.interventionStore.assignment({
        experiment_id: definition.experiment_id,
        root_request_id: 'future-critique-root',
        assigned_at: 103,
        definition,
      }) === 'treatment') {
        treatmentExperiment = definition;
        break;
      }
    }
    expect(treatmentExperiment).toBeDefined();
    const evidence = [{
      case_id: admittedCase.case_id,
      case_key: admittedCase.case_key,
      role: 'contradiction' as const,
    }];
    await f.interventionStore.put({
      schema_version: 1,
      intervention_id: 'retract-dependent-intervention',
      experiment_id: treatmentExperiment!.experiment_id,
      root_request_id: 'future-critique-root',
      session_id: 'future-session',
      turn_id: 'future-turn',
      governing_contract_id: 'user_self',
      principal_key: 'user_self',
      assignment: 'treatment',
      qualifying_evidence: evidence,
      selected_evidence: evidence,
      shown_evidence: evidence,
      planner_fingerprint: treatmentExperiment!.planner_fingerprint,
      prompt_fingerprint: treatmentExperiment!.prompt_fingerprint,
      retrieval_fingerprint: treatmentExperiment!.retrieval_fingerprint,
      policy_fingerprint: treatmentExperiment!.policy_fingerprint,
      compiler_version: EXECUTION_CASE_COMPILER_VERSION,
      recorded_at: 104,
      surface: 'proposal_critique',
      candidate_flow_hash: 'future-flow',
    });
    expect(await f.interventionStore.listForRoot(
      treatmentExperiment!.experiment_id,
      'future-critique-root',
    )).toHaveLength(1);

    await expect(f.feedbackRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'accepted',
    })).resolves.toEqual({ ok: true, recorded: true });
    expect(await f.interventionStore.listForRoot(
      treatmentExperiment!.experiment_id,
      'future-critique-root',
    )).toHaveLength(1);
    await expect(f.feedbackRecorder.retract({
      session_id: 's1',
      turn_id: 't1',
      kind: 'accepted',
    })).resolves.toEqual({ ok: true, retracted: true });
    expect(await f.caseStore.listAll()).toHaveLength(1);
    expect(await f.interventionStore.listForRoot(
      treatmentExperiment!.experiment_id,
      'future-critique-root',
    )).toHaveLength(1);

    await expect(f.feedbackRecorder.retract({
      session_id: 's1',
      turn_id: 't1',
      kind: 'corrected',
    })).resolves.toEqual({ ok: true, retracted: false });
    expect(await f.caseStore.listAll()).toHaveLength(1);
    await expect(f.feedbackRecorder.retract({
      session_id: 's1',
      turn_id: 'missing-turn',
      kind: 'rejected',
    })).resolves.toEqual({ ok: false, reason: 'span_not_found' });
    await expect(f.feedbackRecorder.retract({
      session_id: 's1',
      turn_id: 't1',
      kind: 'rejected',
      source_plan_id: 'plan-outside-span',
    })).resolves.toEqual({ ok: false, reason: 'plan_not_in_span' });
    await expect(f.feedbackRecorder.retract({
      session_id: 's1',
      turn_id: 't1',
      kind: 'rejected',
    })).resolves.toEqual({ ok: true, retracted: true });
    await expect(f.feedbackRecorder.retract({
      session_id: 's1',
      turn_id: 't1',
      kind: 'rejected',
    })).resolves.toEqual({ ok: true, retracted: false });

    expect(f.feedbackStore.listForRoot('r1')).toEqual([]);
    expect(await f.caseStore.listAll()).toEqual([]);
    expect(await f.interventionStore.listForRoot(
      treatmentExperiment!.experiment_id,
      'future-critique-root',
    )).toEqual([]);
    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.evidence_kinds)
      .toContain('unverified_success');
    expect(observations[0]!.evidence_kinds)
      .not.toContain('typed_rejection');
  });

  it('falls an ungrounded stored dissection back without suppressing a strong negative', async () => {
    const f = await fixture();
    await open(f, {
      prompt: 'wire $40,000 to the vendor account',
    });
    expect(await f.lifecycle.dispatchDissection({
      schema_version: 1,
      intent: 'archive onboarding doc',
      objects: ['doc'],
      entities: [],
      constraints: [],
      outcome_sought: 'doc is archived',
    }, context())).toMatchObject({
      ok: true,
      result: { recorded: true },
    });
    addActivity(f.db, {
      id: 'grounding-denial',
      at: 101,
      tool: 'mail.send',
      status: 'error',
      reason: 'policy_denied',
    });
    await f.lifecycle.dispatchOutcome({ claim: 'unfulfilled' }, context());
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });

    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      request_shape: {
        intent_facets: [
          expect.stringMatching(/^wire\b/u),
        ],
      },
      // The strong negative this test is named for is `gateway_denial`, and it
      // still fires. `execution_failure` was dropped from this expectation
      // deliberately: a DENIAL is not a FAILURE, and asserting both here
      // contradicted the `execution: 'not_executed'` two lines below — the same
      // conflation the derivation bench found and V7 removed.
      evidence_kinds: expect.arrayContaining(['gateway_denial']),
      outcome: {
        authorization: 'denied',
        execution: 'not_executed',
      },
    });
    expect(observations[0]!.evidence_kinds).not.toContain('execution_failure');
    expect(observations[0]!.request_shape.intent_facets)
      .not.toContain('archive onboarding doc');
    // ⚠ D-219 slice 3 — the OBSERVATION assertions above are the point and are
    // unchanged; the compiler must still derive the right evidence. What changed
    // is that `gateway_denial` and `execution_failure` are now EXCLUSIONS, so a
    // correctly-derived denial or breakage no longer becomes a case.
    expect(await f.caseStore.listAll()).toEqual([]);
    expect(f.caseStore.compiledReportVersions().get('report-1'))
      .toBe(EXECUTION_CASE_COMPILER_VERSION);

    // Simulate V4's completed zero-observation projection. V5 must replay the
    // retained report/dissection and restore the negative automatically.
    expect(f.caseStore.deleteObservation('report-1')).toBe(true);
    expect(f.reportStore.clearObservation('report-1')).toBe(true);
    await f.caseStore.replaceMaterialized([], new Map(), new Map());
    f.caseStore.markReportCompiled('report-1', 4);
    f.caseStore.setCompilerVersion(4);

    await f.compiler.ensureCurrent();

    expect(await f.caseStore.listObservations()).toHaveLength(1);
    // ⚠ D-219 slice 3 — the OBSERVATION assertions above are the point and are
    // unchanged; the compiler must still derive the right evidence. What changed
    // is that `gateway_denial` and `execution_failure` are now EXCLUSIONS, so a
    // correctly-derived denial or breakage no longer becomes a case.
    expect(await f.caseStore.listAll()).toEqual([]);
    expect(f.caseStore.compiledReportVersions().get('report-1'))
      .toBe(EXECUTION_CASE_COMPILER_VERSION);
    await expect(f.compiler.diagnostics()).resolves.toMatchObject({
      request_shape_source_reports: {
        grounded_dissection: 0,
        ungrounded_dissection_fallback: 1,
        missing_dissection_fallback: 0,
      },
    });
  });

  it('stamps the deduplicated union of cases shown across continuation streams', async () => {
    const f = await fixture();
    const root = 'consulted-root';
    await open(f, {
      root,
      session: 'consulted-origin',
      turn: 'origin-turn',
    });
    expect(f.anchorStore.anchorTurn({
      root_request_id: root,
      session_id: 'consulted-next',
      turn_id: 'continued-turn',
      origin_turn_id: 'origin-turn',
      now: 101,
    })).toBe(true);
    addActivity(f.db, {
      id: 'consulted-activity',
      at: 102,
      session: 'consulted-next',
      turn: 'continued-turn',
      tool: 'mail.send',
    });

    let experimentId = '';
    for (let index = 0; index < 100; index += 1) {
      const candidate = `consulted-exp-${index}`;
      if (f.interventionStore.assignment({
        experiment_id: candidate,
        root_request_id: root,
        assigned_at: 103,
        definition: experimentDefinition(candidate, 'request_augmentation'),
      }) === 'treatment') {
        experimentId = candidate;
        break;
      }
    }
    expect(experimentId).not.toBe('');
    const shown = [
      {
        case_id: 'prior-case',
        case_key: 'case-prior',
        role: 'augmentation' as const,
      },
      {
        case_id: 'shared-case',
        case_key: 'case-shared',
        role: 'augmentation' as const,
      },
    ];
    await f.interventionStore.put({
      schema_version: 1,
      intervention_id: 'prior-stream-intervention',
      experiment_id: experimentId,
      root_request_id: root,
      session_id: 'consulted-origin',
      turn_id: 'origin-turn',
      governing_contract_id: 'user_self',
      principal_key: 'user_self',
      assignment: 'treatment',
      qualifying_evidence: shown,
      selected_evidence: shown,
      shown_evidence: shown,
      planner_fingerprint: 'planner-v1',
      prompt_fingerprint: 'prompt-v1',
      retrieval_fingerprint: 'retrieval-v1',
      policy_fingerprint: 'policy-v1',
      compiler_version: 1,
      recorded_at: 104,
      surface: 'request_augmentation',
      candidate_source_id: 'd213-scan',
      candidate_source_count: 2,
      candidate_source_partial: false,
    });
    expect(f.interventionStore.markPlannerEgress(
      'prior-stream-intervention',
      105,
    )).toBe(true);
    // A later instrumentation failure excludes the root from experiment
    // reporting, but cannot erase an advisory that already reached the model
    // from learning-contamination provenance.
    f.interventionStore.markRootInvalid(
      experimentId,
      root,
      'later_record_failure',
      106,
    );

    const state = new Map<string, unknown>([
      [
        'd214:consulted-case-keys',
        new Set(['case-current', 'case-shared']),
      ],
    ]);
    await expect(f.lifecycle.dispatchOutcome(
      { claim: 'fulfilled' },
      context(state, {
        session: 'consulted-next',
        turn: 'continued-turn',
      }),
    )).resolves.toMatchObject({ ok: true });
    await f.lifecycle.finalizeTurn({
      session_id: 'consulted-next',
      turn_id: 'continued-turn',
      state,
    });

    expect((await f.reportStore.listForRoot(root))[0]!.report
      .consulted_case_keys).toEqual([
      'case-current',
      'case-prior',
      'case-shared',
    ]);
  });

  it('accepts typed feedback and verification on an exact cross-session continuation anchor', async () => {
    const f = await fixture();
    const root = 'cross-session-signal-root';
    await open(f, {
      root,
      session: 'signal-origin',
      turn: 'origin-turn',
    });
    expect(f.anchorStore.anchorTurn({
      root_request_id: root,
      session_id: 'signal-continuation',
      turn_id: 'continued-turn',
      origin_turn_id: 'origin-turn',
      now: 101,
    })).toBe(true);

    await expect(f.feedbackRecorder.record({
      session_id: 'signal-continuation',
      turn_id: 'continued-turn',
      kind: 'accepted',
    })).resolves.toEqual({ ok: true, recorded: true });
    await expect(f.verificationRecorder.record({
      session_id: 'signal-continuation',
      turn_id: 'continued-turn',
      kind: 'passed',
      postcondition_key: 'provider-readback',
      source_event_id: 'cross-session-readback',
    })).resolves.toEqual({ recorded: true });

    expect(f.feedbackStore.listForRoot(root)).toEqual([
      expect.objectContaining({
        root_request_id: root,
        session_id: 'signal-continuation',
        kind: 'accepted',
      }),
    ]);
    expect(f.verificationStore.listForRoot(root)).toEqual([
      expect.objectContaining({
        root_request_id: root,
        session_id: 'signal-continuation',
        kind: 'passed',
      }),
    ]);
  });

  it('fails span closure closed when one execution turn names multiple origin roots', async () => {
    const f = await fixture();
    await open(f, {
      root: 'local-root',
      session: 'ambiguous-session',
      turn: 'execution-turn',
    });
    await open(f, {
      root: 'origin-root-a',
      session: 'ambiguous-session',
      turn: 'origin-turn-a',
    });
    await open(f, {
      root: 'origin-root-b',
      session: 'ambiguous-session',
      turn: 'origin-turn-b',
    });
    const insert = f.db.prepare(`
      INSERT INTO chat_plans (
        plan_id, session_id, turn_id, retry_of_plan_id, tool,
        classification, status, created_at, resolved_at, consumed_at,
        execution_status, execution_turn_id, execution_updated_at
      ) VALUES (?, 'ambiguous-session', ?, NULL, 'mail.send', 'write',
                'approved', ?, ?, ?, 'completed', 'execution-turn', ?)
    `);
    insert.run(
      'ambiguous-plan-a',
      'origin-turn-a',
      101,
      102,
      103,
      104,
    );
    insert.run(
      'ambiguous-plan-b',
      'origin-turn-b',
      105,
      106,
      107,
      108,
    );

    expect(f.compiler.resolveRootForClose(
      'ambiguous-session',
      'execution-turn',
    )).toBeUndefined();
    await expect(f.lifecycle.dispatchOutcome(
      { claim: 'fulfilled' },
      context(new Map(), {
        session: 'ambiguous-session',
        turn: 'execution-turn',
      }),
    )).resolves.toMatchObject({
      ok: true,
      result: { recorded: false },
    });
    expect(await f.reportStore.listAll()).toEqual([]);
  });

  it('closes an early outcome marker only after later tool calls are durable', async () => {
    const f = await fixture();
    await open(f);
    const result = await f.lifecycle.dispatchOutcome(
      { claim: 'unfulfilled' },
      context(),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { recorded: true, deferred: true },
    });
    const provisional = (await f.reportStore.get('report-1'))!;
    expect(provisional.closed_at).toBeUndefined();

    addActivity(f.db, { id: 'late-search', at: 101, tool: 'file.search' });
    addActivity(f.db, {
      id: 'late-send-failure',
      at: 102,
      tool: 'mail.send',
      status: 'error',
      reason: 'policy_denied',
    });
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });

    const stored = (await f.reportStore.get('report-1'))!;
    expect(stored.closed_at).toBeDefined();
    expect(stored.report.event_range).toEqual({
      first_event_id: 'late-search',
      last_event_id: 'late-send-failure',
    });
    expect(stored.policy_fingerprint).not.toBe(
      provisional.policy_fingerprint,
    );
    // ⚠ D-219 slice 3 — asserted on the OBSERVATION, not the case. This test is
    // about the span CLOSING on durable later calls; the case lookup was only a
    // convenient end-check, and a breakage no longer becomes a case. The derived
    // evidence is what the claim rests on and it is unchanged.
    const closed = await f.caseStore.listObservations();
    expect(closed).toHaveLength(1);
    // The derived strong negative here is the DENIAL, not a breakage — the
    // late event was refused, not broken. Asserted as derived rather than as
    // assumed: the first version of this line guessed `execution_failure`.
    expect(closed[0]!.evidence_kinds).toContain('gateway_denial');
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('server-finalizes every turn that did governed work, and nothing else', async () => {
    // ⚠ D-219 slice 9a REVERSED THE MIDDLE ARM. The old title was "server-
    // finalizes strong no-report signals but not direct or WEAK-ONLY turns", and
    // its rule is kept here rather than overwritten, because the reversal rests
    // on a changed premise a reader has to be able to check.
    //
    // WAS: recording required `has_compilable_signal` — a strong signal (an
    // error, a denial, typed feedback, a verification) or a weak one (a cancelled
    // plan, a supersession, an approval expiry). A plain successful flow carried
    // neither and recorded nothing. That was right while the substrate admitted
    // its own observations: a self-reported success bought precedent nothing.
    //
    // CHANGED PREMISE: after slices 2–4 the only admissible evidence is
    // owner-attested or verified, and the owner is asked ABOUT A RECORDED
    // OBSERVATION. Under the old gate the ordinary successful turn produced no
    // observation, so it could never be offered, never answered, and never become
    // a case — the offer was unreachable on exactly the traffic it exists for.
    //
    // What bounds recording now is structural, not a signal: did this span do
    // governed work at all. The first arm is that bound, and it still holds.
    const direct = await fixture();
    await open(direct);
    await direct.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    expect(await direct.reportStore.listAll()).toEqual([]);

    // The turn the old gate dropped: two governed calls, both fine, nobody has
    // said anything about them yet. It is now RECORDED…
    const plain = await fixture();
    await open(plain);
    addActivity(plain.db, { id: 'w1', at: 101, tool: 'file.search' });
    addActivity(plain.db, { id: 'w2', at: 102, tool: 'mail.send' });
    await plain.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    expect(await plain.reportStore.listAll()).toHaveLength(1);
    const plainObservations = await plain.caseStore.listObservations();
    expect(plainObservations).toHaveLength(1);
    expect(plainObservations[0]!.evidence_kinds).toContain('unverified_success');
    expect(plainObservations[0]!.substantive_call_count).toBe(2);
    // …and NOT admitted. Recording is not admission: `unverified_success` has
    // been inert since slice 2, so this observation waits for an owner answer
    // that the 6b-ii offer can now actually ask for.
    expect(await plain.caseStore.listAll()).toEqual([]);

    const strong = await fixture();
    await open(strong);
    addActivity(strong.db, {
      id: 'e1',
      at: 101,
      tool: 'mail.send',
      status: 'error',
    });
    await strong.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    const reports = await strong.reportStore.listAll();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      server_finalized: true,
      report: { model_claim: 'unknown', open_items: [] },
    });
    // ⚠ D-219 slice 3 — asserted on the OBSERVATION, not the case. The claim is
    // about SERVER FINALIZATION of a strong no-report turn; a breakage no longer
    // becomes a case, and the derived evidence still carries the signal.
    const obs = await strong.caseStore.listObservations();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.evidence_kinds).toContain('execution_failure');
    expect(await strong.caseStore.listAll()).toEqual([]);


    const verified = await fixture();
    await open(verified);
    addActivity(verified.db, { id: 'v1', at: 101, tool: 'file.search' });
    addActivity(verified.db, { id: 'v2', at: 102, tool: 'mail.send' });
    await expect(verified.verificationRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'passed',
      postcondition_key: 'mail-delivered',
      source_event_id: 'provider-readback-1',
    })).resolves.toEqual({ recorded: true });
    await verified.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    const verifiedCase = (await verified.caseStore.listAll())[0]!;
    expect(verifiedCase.outcome_strength.evidence_families)
      .toContain('verification_pass');
    expect(verifiedCase.flows[0]!.verified_successes).toBe(1);
  });

  it('⛔ D-219 9b-ii: `outcome.report` is not presented, and still answers a stale caller', async () => {
    // The model is no longer told the tool exists — the catalog entry and the
    // approval-pending nudge are both gone, because nothing reads what it
    // reported (9b took the last counter over `model_claim`) and nothing waits
    // for it (9a records every governed turn).
    const f = await fixture();
    const wrapped = wrapRegistryWithExecutionCaseTools(registry(), f.lifecycle);
    const names = wrapped.list().map((entry) => entry.name);
    expect(names).not.toContain(OUTCOME_REPORT_TOOL_NAME);
    expect(wrapped.getByName(OUTCOME_REPORT_TOOL_NAME)).toBeNull();
    expect(wrapped.listByTier(1).map((entry) => entry.name))
      .not.toContain(OUTCOME_REPORT_TOOL_NAME);
    // ⚠ THE PERMITTING WITNESS — the sibling instrumentation tool is untouched,
    // so this is one tool withdrawn rather than the wrapper going dark.
    expect(names).toContain(REQUEST_DISSECTION_TOOL_NAME);

    // ⚠ …and the DOOR STILL ANSWERS. A prompt prefix cached before this change
    // still names the tool, and a model calling it should get the old no-op
    // success rather than an unknown-tool error mid-turn.
    await open(f);
    addActivity(f.db, { id: 'stale-a1', at: 101, tool: 'file.search' });
    addActivity(f.db, { id: 'stale-a2', at: 102, tool: 'mail.send' });
    await expect(wrapped.dispatch(
      OUTCOME_REPORT_TOOL_NAME,
      { claim: 'fulfilled' },
      context(),
    )).resolves.toMatchObject({ ok: true, result: { recorded: true } });
    // And the report it wrote still closes, so a pre-upgrade pending row is
    // never stranded.
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });
    expect((await f.reportStore.get('report-1'))!.closed_at).toBeDefined();
  });

  it('a span with no governed work yields NO observation even when a report exists', async () => {
    // ⛔ D-219 slice 9a — THE POSITIVE CASE FOR THE ONE GATE THAT SURVIVED.
    //
    // Recording is bounded by `has_substantive_flow`, and what makes that safe
    // rather than merely cheap is structural: `compileReport` derives
    // observations ONLY from cancelled plans and from activity groups, so a span
    // holding neither cannot produce one. The report row the gate declines to
    // write would have been dead weight, not a lost case.
    //
    // Proven through the one path that still records such a span — the model
    // calling `outcome.report` — because the gate's own negative case (nothing
    // recorded) cannot tell "protected something" from "refused everything".
    const f = await fixture();
    await open(f);
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context());
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });
    expect((await f.reportStore.get('report-1'))!.closed_at).toBeDefined();
    expect(await f.caseStore.listObservations()).toEqual([]);
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('retains a one-call superseded flow without outcome.report and admits only at three roots', async () => {
    const f = await fixture();
    for (let index = 1; index <= 3; index += 1) {
      const root = `superseded-root-${index}`;
      const session = `superseded-session-${index}`;
      await open(f, { root, session, turn: 'initial' });
      expect(f.anchorStore.anchorTurn({
        root_request_id: root,
        session_id: session,
        turn_id: 'continuation',
        origin_turn_id: 'initial',
        now: 110 + index,
      })).toBe(true);
      addActivity(f.db, {
        id: `superseded-${index}-first`,
        at: 120 + index * 10,
        session,
        turn: 'initial',
        tool: 'file.search',
      });
      addActivity(f.db, {
        id: `superseded-${index}-next`,
        at: 121 + index * 10,
        session,
        turn: 'continuation',
        tool: 'mail.send',
      });
      await f.lifecycle.finalizeTurn({
        session_id: session,
        turn_id: 'continuation',
      });
      expect(await f.reportStore.listForRoot(root)).toHaveLength(1);
      if (index < 3) expect(await f.caseStore.listAll()).toEqual([]);
    }

    // ⚠ D-219 slice 7 — THE CASE-LEVEL HALF OF THIS TEST IS RETIRED.
    //
    // The graded flow here is ONE call, and candidacy is now uniform at >1: a
    // case is for a procedure worth short-circuiting, and one call is not one.
    // What this used to assert about the resulting row — observation counts,
    // flow tools, outcome tallies — describes a case that no longer forms at
    // any number of roots.
    //
    // Everything ABOVE is untouched and is what still matters: the report is
    // created, the span closes, and the supersession / abandonment projection
    // is derived correctly. Only admission changed.
    expect(await f.caseStore.listAll()).toEqual([]);
    expect((await f.caseStore.listObservations()).length).toBeGreaterThan(0);
  });

  it('emits distinct turn flows and suppresses a drifted later positive', async () => {
    const f = await fixture();
    await open(f);
    expect(f.anchorStore.anchorTurn({
      root_request_id: 'r1',
      session_id: 's1',
      turn_id: 't2',
      origin_turn_id: 't1',
      now: 101,
    })).toBe(true);
    await f.dissectionStore.putFirst('r1', {
      schema_version: 1,
      intent: 'send quarterly report',
      objects: ['report'],
      entities: [{ role: 'recipient', kind: 'person' }],
      constraints: ['send'],
      outcome_sought: 'customer receives report',
    }, 102);
    await f.dissectionStore.putForTurn('r1', 's1', 't2', {
      schema_version: 1,
      intent: 'schedule customer meeting',
      objects: ['meeting'],
      entities: [{ role: 'attendee', kind: 'person' }],
      constraints: ['schedule'],
      outcome_sought: 'meeting is booked',
    }, 103);
    addActivity(f.db, {
      id: 'drift-first',
      at: 104,
      turn: 't1',
      tool: 'file.search',
    });
    addActivity(f.db, {
      id: 'drift-next-1',
      at: 105,
      turn: 't2',
      tool: 'file.search',
    });
    addActivity(f.db, {
      id: 'drift-next-2',
      at: 106,
      turn: 't2',
      tool: 'mail.send',
    });
    await f.verificationRecorder.record({
      session_id: 's1',
      turn_id: 't2',
      kind: 'passed',
      postcondition_key: 'provider-readback',
      source_event_id: 'verify-drift',
    });
    await f.lifecycle.dispatchOutcome(
      { claim: 'fulfilled' },
      context(new Map(), { turn: 't2' }),
    );
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't2',
    });

    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(2);
    expect(observations[0]!.evidence_kinds).toContain('flow_superseded');
    expect(observations[1]).toMatchObject({
      intent_drifted: true,
      evidence_kinds: expect.arrayContaining(['verification_pass']),
    });
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('replays legacy observations from authoritative stores before retrieval and preserves a compiler-upgrade fork', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'replay-a1', at: 101, tool: 'file.search' });
    addActivity(f.db, { id: 'replay-a2', at: 102, tool: 'mail.send' });
    await f.verificationRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'failed',
      postcondition_key: 'provider-readback',
      source_event_id: 'replay-verification',
    });
    await f.lifecycle.dispatchOutcome(
      { claim: 'fulfilled' },
      context(),
    );
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });

    const authoritative = (await f.caseStore.listObservations())[0]!;
    expect(authoritative).toMatchObject({
      compiler_version: EXECUTION_CASE_COMPILER_VERSION,
      outcome: { verification: 'failed' },
    });
    const legacy = {
      ...authoritative,
      compiler_version: 1,
      request_shape: {
        ...authoritative.request_shape,
        intent_facets: ['legacy compiler intent'],
      },
      outcome: {
        ...authoritative.outcome,
        model_claim: 'fulfilled' as const,
        execution: 'succeeded' as const,
        verification: 'passed' as const,
      },
      evidence_kinds: ['verification_pass' as const],
    };
    expect(f.caseStore.deleteObservation(authoritative.report_id)).toBe(true);
    expect(await f.caseStore.putObservation(legacy)).toBe(true);
    const attached = (await f.reportStore.get(
      authoritative.report_id,
    ))!.observation!;
    expect(await f.reportStore.attachObservation(
      authoritative.report_id,
      {
        ...attached,
        compiler_version: 1,
        outcome: {
          ...attached.outcome,
          verification: 'passed',
        },
      },
    )).toBe(true);
    const legacyProjection = rebuildExecutionCases([legacy], 1);
    await f.caseStore.replaceMaterialized(
      legacyProjection.cases,
      legacyProjection.source_report_ids_by_case,
      new Map(legacyProjection.cases.map((row) => [
        row.case_id,
        legacy.root_request,
      ])),
    );
    f.caseStore.setCompilerVersion(1);

    await f.compiler.ensureCurrent();

    const replayed = await f.caseStore.listObservations();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      compiler_version: EXECUTION_CASE_COMPILER_VERSION,
      request_shape: authoritative.request_shape,
      outcome: { verification: 'failed' },
      evidence_kinds: expect.arrayContaining(['verification_fail']),
    });
    expect((await f.reportStore.get(
      authoritative.report_id,
    ))!.observation).toMatchObject({
      compiler_version: EXECUTION_CASE_COMPILER_VERSION,
      outcome: { verification: 'failed' },
    });
    expect(f.caseStore.compilerVersion())
      .toBe(EXECUTION_CASE_COMPILER_VERSION);
    const cases = await f.caseStore.listAll();
    const current = cases.find((row) => row.superseded_by === undefined)!;
    const archived = cases.find((row) => row.compiler_version === 1)!;
    expect(current).toMatchObject({
      compiler_version: EXECUTION_CASE_COMPILER_VERSION,
      supersedes: archived.case_id,
    });
    expect(archived.superseded_by).toBe(current.case_id);
  });

  it('leaves no current-version stamp when an authoritative replay is interrupted', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'replay-interrupted', at: 101, tool: 'mail.send' });
    await f.lifecycle.dispatchOutcome(
      { claim: 'unfulfilled' },
      context(),
    );
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    f.caseStore.setCompilerVersion(1);

    const originalGet = f.reportStore.get;
    f.reportStore.get = async () => {
      throw new Error('simulated replay interruption');
    };
    await expect(f.compiler.recompileAll())
      .rejects.toThrow('simulated replay interruption');
    expect(f.caseStore.compilerVersion()).toBeUndefined();

    f.reportStore.get = originalGet;
    await expect(f.compiler.ensureCurrent()).resolves.toBeUndefined();
    expect(f.caseStore.compilerVersion())
      .toBe(EXECUTION_CASE_COMPILER_VERSION);
    expect(await f.caseStore.listObservations()).toHaveLength(1);
  });

  it('replays a closed report whose derived rows disappeared under a current version stamp', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'coverage-gap', at: 101, tool: 'mail.send' });
    await f.lifecycle.dispatchOutcome(
      { claim: 'unfulfilled' },
      context(),
    );
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    expect(f.caseStore.compilerVersion())
      .toBe(EXECUTION_CASE_COMPILER_VERSION);
    expect(f.caseStore.deleteObservation('report-1')).toBe(true);
    // Simulate the dangerous crash shape: the singleton version survived, but
    // this closed report no longer has a completed per-report projection.
    f.caseStore.setCompilerVersion(EXECUTION_CASE_COMPILER_VERSION);

    await f.compiler.ensureCurrent();

    expect(await f.caseStore.listObservations()).toHaveLength(1);
    expect(
      f.caseStore.compiledReportVersions().get('report-1'),
    ).toBe(EXECUTION_CASE_COMPILER_VERSION);
  });

  it('keeps a superseded flow and a same-intent verified flow in one case', async () => {
    const f = await fixture();
    await open(f);
    expect(f.anchorStore.anchorTurn({
      root_request_id: 'r1',
      session_id: 's1',
      turn_id: 't2',
      origin_turn_id: 't1',
      now: 101,
    })).toBe(true);
    const sameIntent = {
      schema_version: 1 as const,
      intent: 'send quarterly report',
      objects: ['report'],
      entities: [{ role: 'recipient', kind: 'person' }],
      constraints: ['send'],
      outcome_sought: 'customer receives report',
    };
    await f.dissectionStore.putFirst('r1', sameIntent, 102);
    await f.dissectionStore.putForTurn('r1', 's1', 't2', sameIntent, 103);
    addActivity(f.db, {
      id: 'same-first',
      at: 104,
      turn: 't1',
      tool: 'file.search',
    });
    addActivity(f.db, {
      id: 'same-next-1',
      at: 105,
      turn: 't2',
      tool: 'file.search',
    });
    addActivity(f.db, {
      id: 'same-next-2',
      at: 106,
      turn: 't2',
      tool: 'mail.send',
    });
    await f.verificationRecorder.record({
      session_id: 's1',
      turn_id: 't2',
      kind: 'passed',
      postcondition_key: 'mail-delivered',
      source_event_id: 'verify-same-intent',
    });
    await f.lifecycle.dispatchOutcome(
      { claim: 'fulfilled' },
      context(new Map(), { turn: 't2' }),
    );
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't2',
    });

    // ⚠ D-219 slice 7 — THE CASE-LEVEL HALF OF THIS TEST IS RETIRED.
    //
    // The graded flow here is ONE call, and candidacy is now uniform at >1: a
    // case is for a procedure worth short-circuiting, and one call is not one.
    // What this used to assert about the resulting row — observation counts,
    // flow tools, outcome tallies — describes a case that no longer forms at
    // any number of roots.
    //
    // Everything ABOVE is untouched and is what still matters: the report is
    // created, the span closes, and the supersession / abandonment projection
    // is derived correctly. Only admission changed.
    // ⚠ …but a case DOES still form here, from the multi-call half. What slice 7
    // removes is the ONE-CALL flow that used to sit beside it, so the case is
    // now single-flow rather than two.
    const rows = await f.caseStore.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.flows).toHaveLength(1);
  });

  it('projects a D-157 approval expiry as an abandoned weak negative', async () => {
    const f = await fixture();
    for (let index = 1; index <= 3; index += 1) {
      const root = `abandoned-root-${index}`;
      const session = `abandoned-session-${index}`;
      const plan = `abandoned-plan-${index}`;
      await open(f, { root, session });
      f.db.prepare(`
        INSERT INTO chat_plans (
          plan_id, session_id, turn_id, retry_of_plan_id, tool,
          classification, status, created_at, resolved_at, consumed_at,
          execution_status, execution_turn_id, execution_updated_at
        ) VALUES (?, ?, 't1', NULL, 'mail.send', 'write', 'approved',
                  ?, ?, ?, 'held', 't1', ?)
      `).run(plan, session, 200 + index, 201 + index, 202 + index, 203 + index);
      addActivity(f.db, {
        id: `abandoned-activity-${index}`,
        at: 204 + index,
        session,
        tool: 'mail.send',
      });
      addRecipeRun(f.db, {
        id: `abandoned-run-${index}`,
        at: 205 + index,
        session,
        recipe: 'mail.send',
        status: 'failed',
        errorCodes: ['RECIPE_APPROVAL_TIMEOUT'],
      });
      await f.lifecycle.finalizeTurn({ session_id: session, turn_id: 't1' });
      if (index < 3) expect(await f.caseStore.listAll()).toEqual([]);
    }
    // ⚠ D-219 slice 7 — THE CASE-LEVEL HALF OF THIS TEST IS RETIRED.
    //
    // The graded flow here is ONE call, and candidacy is now uniform at >1: a
    // case is for a procedure worth short-circuiting, and one call is not one.
    // What this used to assert about the resulting row — observation counts,
    // flow tools, outcome tallies — describes a case that no longer forms at
    // any number of roots.
    //
    // Everything ABOVE is untouched and is what still matters: the report is
    // created, the span closes, and the supersession / abandonment projection
    // is derived correctly. Only admission changed.
    expect(await f.caseStore.listAll()).toEqual([]);
    expect((await f.caseStore.listObservations()).length).toBeGreaterThan(0);
  });

  it('keeps an abandoned flow and later same-intent success as distinct flows in one case', async () => {
    const f = await fixture();
    await open(f);
    expect(f.anchorStore.anchorTurn({
      root_request_id: 'r1',
      session_id: 's1',
      turn_id: 't2',
      origin_turn_id: 't1',
      now: 101,
    })).toBe(true);
    const sameIntent = {
      schema_version: 1 as const,
      intent: 'send quarterly report',
      objects: ['report'],
      entities: [{ role: 'recipient', kind: 'person' }],
      constraints: ['send'],
      outcome_sought: 'customer receives report',
    };
    await f.dissectionStore.putFirst('r1', sameIntent, 102);
    await f.dissectionStore.putForTurn('r1', 's1', 't2', sameIntent, 103);
    f.db.prepare(`
      INSERT INTO chat_plans (
        plan_id, session_id, turn_id, retry_of_plan_id, tool,
        classification, status, created_at, resolved_at, consumed_at,
        execution_status, execution_turn_id, execution_updated_at
      ) VALUES (
        'abandoned-plan', 's1', 't1', NULL, 'mail.send',
        'write', 'approved', 104, 105, 106, 'held', 't1', 107
      )
    `).run();
    addActivity(f.db, {
      id: 'abandoned-first',
      at: 108,
      turn: 't1',
      tool: 'mail.send',
    });
    addRecipeRun(f.db, {
      id: 'abandoned-first-run',
      at: 109,
      turn: 't1',
      recipe: 'mail.send',
      status: 'failed',
      errorCodes: ['RECIPE_APPROVAL_TIMEOUT'],
    });
    addActivity(f.db, {
      id: 'successful-search',
      at: 120,
      turn: 't2',
      tool: 'file.search',
    });
    addActivity(f.db, {
      id: 'successful-send',
      at: 121,
      turn: 't2',
      tool: 'mail.send',
    });
    await f.verificationRecorder.record({
      session_id: 's1',
      turn_id: 't2',
      kind: 'passed',
      postcondition_key: 'mail-delivered',
      source_event_id: 'verify-after-abandonment',
    });
    await f.lifecycle.dispatchOutcome(
      { claim: 'fulfilled' },
      context(new Map(), { turn: 't2' }),
    );
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't2',
    });

    // ⚠ D-219 slice 7 — THE CASE-LEVEL HALF OF THIS TEST IS RETIRED.
    //
    // The graded flow here is ONE call, and candidacy is now uniform at >1: a
    // case is for a procedure worth short-circuiting, and one call is not one.
    // What this used to assert about the resulting row — observation counts,
    // flow tools, outcome tallies — describes a case that no longer forms at
    // any number of roots.
    //
    // Everything ABOVE is untouched and is what still matters: the report is
    // created, the span closes, and the supersession / abandonment projection
    // is derived correctly. Only admission changed.
    // ⚠ …but a case DOES still form here, from the multi-call half. What slice 7
    // removes is the ONE-CALL flow that used to sit beside it, so the case is
    // now single-flow rather than two.
    const rows = await f.caseStore.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.flows).toHaveLength(1);
  });

  it('defers explicit closure while a correlated plan is pending', async () => {
    const f = await fixture();
    await open(f);
    f.db.prepare(`
      INSERT INTO chat_plans (
        plan_id, session_id, turn_id, retry_of_plan_id, tool,
        classification, status, created_at, resolved_at, consumed_at,
        execution_status, execution_turn_id, execution_updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)
    `).run(
      'p1',
      's1',
      't1',
      'mail.send',
      'write',
      'proposed',
      101,
      'held',
    );
    const result = await f.lifecycle.dispatchOutcome(
      { claim: 'unknown' },
      context(),
    );
    expect(result).toMatchObject({ ok: true, result: { deferred: true } });
    expect((await f.reportStore.get('report-1'))!.closed_at).toBeUndefined();

    f.db.prepare(`
      UPDATE chat_plans
         SET status = 'cancelled', execution_status = 'cancelled',
             resolved_at = 200
       WHERE plan_id = 'p1'
    `).run();
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    expect((await f.reportStore.get('report-1'))!.closed_at)
      .toBeDefined();
  });
});

describe('D-214 retrieval and storage mechanism guards', () => {
  it('supports null and bounded d213-scan sources without an FTS/search index', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'file.search' });
    addActivity(f.db, { id: 'a2', at: 102, tool: 'mail.send' });
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context());
    await f.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    await f.feedbackRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'accepted',
    });

    await expect(createNullCaseCandidateSource().findCandidates({
      prompt: 'quarterly report',
      scope: {
        governing_contract_id: 'user_self',
        principal_key: 'user_self',
      },
      limit: 5,
    })).resolves.toEqual({ candidates: [], partial: false });

    const scan = createD213ScanCaseCandidateSource(f.caseStore, {
      max_cases: 16,
      max_ms: 1_000,
    });
    const found = await scan.findCandidates({
      prompt: 'quarterly customer report',
      scope: {
        governing_contract_id: 'user_self',
        principal_key: 'user_self',
      },
      limit: 5,
    });
    expect(found.candidates).toHaveLength(1);
    expect(found.partial).toBe(false);
    await expect(scan.findCandidates({
      prompt: 'quarterly customer report',
      scope: {
        governing_contract_id: 'other',
        principal_key: 'user_self',
      },
      limit: 5,
    })).resolves.toEqual({ candidates: [], partial: false });

    const objects = f.db.prepare(`
      SELECT type, name, sql FROM sqlite_master
       WHERE name LIKE '%execution_case%' OR sql LIKE '%execution_case%'
    `).all() as Array<{ type: string; name: string; sql: string | null }>;
    expect(objects.some((row) =>
      /fts|virtual table|tokenize/i.test(row.sql ?? ''))).toBe(false);

    // ⚠ THIS USED TO ASSERT "no indexes at all", and that was too strong for
    // what the test is named after. The claim is that D-213 scan works with no
    // SEARCH structure — no FTS, nothing indexing the text it matches on. It
    // proved that by observing the tables carried no indexes whatsoever, which
    // was true until D-219's by-root/by-report lookup indexes landed; those are
    // identifier B-trees for cascade deletes and say nothing about search.
    //
    // Re-expecting to the observed index list would have written those five
    // names down as the contract and stopped guarding anything. What the test
    // actually needs to forbid is an index over the ENCRYPTED TEXT columns —
    // `representative_prompt_encrypted` / `payload_encrypted` — since indexing
    // either is what a search structure would look like here.
    const searchIndexes = objects.filter((row) =>
      row.type === 'index'
      && !row.name.startsWith('sqlite_autoindex')
      && /prompt|payload|_encrypted/i.test(row.sql ?? ''));
    expect(searchIndexes).toEqual([]);
  });

  it('round-trips Japanese text through candidate generation, slot fit, and card rendering', async () => {
    const f = await fixture();
    const prompt = '顧客に四半期報告書を送信してください';
    await open(f, {
      root: 'cjk-root',
      session: 'cjk-session',
      prompt,
    });
    addActivity(f.db, {
      id: 'cjk-search',
      at: 101,
      session: 'cjk-session',
      tool: 'file.search',
    });
    addActivity(f.db, {
      id: 'cjk-send',
      at: 102,
      session: 'cjk-session',
      tool: 'mail.send',
    });
    await f.verificationRecorder.record({
      session_id: 'cjk-session',
      turn_id: 't1',
      kind: 'passed',
      postcondition_key: 'mail-delivered',
      source_event_id: 'cjk-provider-readback',
    });
    await f.lifecycle.finalizeTurn({
      session_id: 'cjk-session',
      turn_id: 't1',
    });
    const row = (await f.caseStore.listAll())[0]!;
    const source = createD213ScanCaseCandidateSource(f.caseStore);
    const result = await source.findCandidates({
      prompt,
      scope: {
        governing_contract_id: 'user_self',
        principal_key: 'user_self',
      },
      limit: 5,
    });
    expect(result.candidates).toContain(row.case_id);
    const ranked = rankExecutionCaseCandidates(prompt, [row], 1, 5);
    expect(ranked).toHaveLength(1);
    expect(renderExecutionCaseCard(ranked[0]!.row).flows)
      .toHaveLength(1);
  });

  it('resolves experiment scope from the exact anchored owner turn and real source', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    schema(db);
    const key = keyProvider();
    const anchorStore = createExecutionSpanAnchorStore(db, key);
    const composed = composeExecutionCases({
      db,
      chatKeyProvider: key,
      registry: registry(),
      getSpanAnchorDeps: () => ({
        store: anchorStore,
        mintRootRequestId: () => 'unused',
      }),
      experiment: experimentDefinition(
        'scope-resolution',
        'request_augmentation',
      ),
      experimentSecret: 'scope-resolution-secret',
    });
    await anchorStore.openSpan({
      root_request_id: 'scope-root',
      session_id: 'scope-session',
      surface: 'chat',
      root_request: 'send the report',
      turn_id: 'scope-turn',
      now: 100,
    });
    const augmentationDeps =
      composed.getExecutionCaseAugmentationDeps?.();
    expect(augmentationDeps).toBeDefined();
    const resolveScope = augmentationDeps!.resolveScope;
    expect(resolveScope({
      session_id: 'scope-session',
      turn_id: 'scope-turn',
      source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'scope-session',
        user_id: 'local',
        turn_id: 'scope-turn',
      },
    })).toEqual({
      governing_contract_id: 'user_self',
      principal_key: 'user_self',
      active: true,
    });
    expect(resolveScope({
      session_id: 'scope-session',
      turn_id: 'scope-turn',
    }).active).toBe(false);
    expect(resolveScope({
      session_id: 'scope-session',
      turn_id: 'scope-turn',
      source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'scope-session',
        user_id: 'local',
      },
    }).active).toBe(false);
    expect(resolveScope({
      session_id: 'scope-session',
      turn_id: 'scope-turn',
      source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'scope-session',
        user_id: 'local',
        turn_id: 'other-turn',
      },
    }).active).toBe(false);
    expect(resolveScope({
      session_id: 'scope-session',
      turn_id: 'scope-turn',
      source: {
        channel: 'chat',
        actor: 'contracted_user',
        chat_session_id: 'scope-session',
        user_id: 'outside',
        contract_id: 'contract-outside',
        turn_id: 'scope-turn',
      },
    }).active).toBe(false);
    expect(resolveScope({
      session_id: 'scope-session',
      turn_id: 'other-turn',
      source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'scope-session',
        user_id: 'local',
        turn_id: 'other-turn',
      },
    }).active).toBe(false);
  });

  it('keeps decrypted scan text out of SQLite temp files and every on-disk artifact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'd214-scan-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const db = new Database(join(directory, 'realm.sqlite'));
    cleanups.push(() => db.close());
    schema(db);
    db.pragma('temp_store = FILE');
    const key = keyProvider();
    const anchorStore = createExecutionSpanAnchorStore(db, key);
    const composed = composeExecutionCases({
      db,
      chatKeyProvider: key,
      registry: registry(),
      getSpanAnchorDeps: () => ({
        store: anchorStore,
        mintRootRequestId: () => 'unused',
      }),
    });
    const secretPrompt = '機密の四半期報告書を顧客に送信する';
    await anchorStore.openSpan({
      root_request_id: 'disk-root',
      session_id: 'disk-session',
      surface: 'chat',
      root_request: secretPrompt,
      turn_id: 'disk-turn',
      now: 100,
    });
    addActivity(db, {
      id: 'disk-search',
      at: 101,
      session: 'disk-session',
      turn: 'disk-turn',
      tool: 'file.search',
    });
    addActivity(db, {
      id: 'disk-send',
      at: 102,
      session: 'disk-session',
      turn: 'disk-turn',
      tool: 'mail.send',
    });
    await composed.verificationRecorder.record({
      session_id: 'disk-session',
      turn_id: 'disk-turn',
      kind: 'passed',
      postcondition_key: 'mail-delivered',
      source_event_id: 'disk-readback',
    });
    await composed.lifecycle.finalizeTurn({
      session_id: 'disk-session',
      turn_id: 'disk-turn',
    });
    const before = readdirSync(directory).sort();
    await createD213ScanCaseCandidateSource(composed.caseStore)
      .findCandidates({
        prompt: secretPrompt,
        scope: {
          governing_contract_id: 'user_self',
          principal_key: 'user_self',
        },
        limit: 5,
      });
    expect(readdirSync(directory).sort()).toEqual(before);
    for (const name of readdirSync(directory)) {
      expect(readFileSync(join(directory, name)).includes(
        Buffer.from(secretPrompt),
      )).toBe(false);
    }
  });

  it('measures real anchored chat history by route kind without arguments', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'mail.send' });
    addRecipeRun(f.db, {
      id: 'run-installed',
      at: 101,
      recipe: 'mail.send',
      hash: 'installed-hash',
    });
    addActivity(f.db, { id: 'a2', at: 102, tool: 'peer.tool' });
    addRecipeRun(f.db, {
      id: 'run-dynamic',
      at: 102,
      recipe: 'run-ingredient',
      hash: 'dynamic-hash',
    });
    addActivity(f.db, { id: 'a3', at: 103, tool: 'recipe.run' });
    addRecipeRun(f.db, {
      id: 'run-inline',
      at: 103,
      recipe: 'inline-generated',
      hash: 'inline-hash',
    });
    addActivity(f.db, { id: 'a4', at: 104, tool: 'file.search' });
    // Tier 2 is a catalog-routing tier, not proof that this second mail call
    // traversed an installed recipe. With no paired audit run it is direct.
    addActivity(f.db, { id: 'a5', at: 105, tool: 'mail.send' });
    const measured = f.compiler.runtimeCompositionDiagnostics();
    expect(measured.corpus_roots).toBe(1);
    expect(measured.route_kind_counts).toEqual({
      installed_recipe: 1,
      dynamic_ingredient: 1,
      inline_recipe: 1,
      direct_tool: 2,
    });
    expect(measured.source_coverage).toEqual({
      audit_activity_rows: 5,
      recipe_run_rows: 3,
      paired_recipe_runs: 3,
      unpaired_recipe_runs: 0,
    });
    expect(JSON.stringify(measured)).not.toContain('arg');
  });

  it('privacy deletion removes the root and every D-214 derivative then rebuilds', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    schema(db);
    const key = keyProvider();
    const anchorStore = createExecutionSpanAnchorStore(db, key);
    const composed = composeExecutionCases({
      db,
      chatKeyProvider: key,
      registry: registry(),
      getSpanAnchorDeps: () => ({
        store: anchorStore,
        mintRootRequestId: () => 'unused',
      }),
    });
    await anchorStore.openSpan({
      root_request_id: 'privacy-root',
      session_id: 's1',
      surface: 'chat',
      root_request: 'send the quarterly report to the customer',
      turn_id: 't1',
      now: 100,
    });
    await expect(composed.lifecycle.dispatchDissection({
      schema_version: 1,
      intent: 'send quarterly report',
      objects: ['report'],
      entities: [],
      constraints: [],
      outcome_sought: 'customer receives report',
    }, context())).resolves.toMatchObject({
      ok: true,
      result: { recorded: true },
    });
    addActivity(db, { id: 'p1', at: 101, tool: 'file.search' });
    addActivity(db, { id: 'p2', at: 102, tool: 'mail.send' });
    await composed.lifecycle.dispatchOutcome(
      { claim: 'fulfilled' },
      context(),
    );
    await composed.lifecycle.finalizeTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    await composed.feedbackRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'accepted',
    });
    const caseRow = (await composed.caseStore.listAll())[0]!;
    const measurementRoot = 'different-measurement-root';
    const assignment = composed.interventionStore.assignment({
      experiment_id: 'privacy-exp',
      root_request_id: measurementRoot,
      assigned_at: 200,
      definition: experimentDefinition(
        'privacy-exp',
        'request_augmentation',
      ),
    })!;
    const evidence = [{
      case_id: caseRow.case_id,
      case_key: caseRow.case_key,
      role: 'augmentation' as const,
    }];
    await composed.interventionStore.put({
      schema_version: 1,
      intervention_id: 'privacy-intervention',
      experiment_id: 'privacy-exp',
      root_request_id: measurementRoot,
      session_id: 'measurement-session',
      turn_id: 'measurement-turn',
      governing_contract_id: 'user_self',
      principal_key: 'user_self',
      assignment,
      qualifying_evidence: evidence,
      selected_evidence: evidence,
      shown_evidence: assignment === 'treatment' ? evidence : [],
      planner_fingerprint: 'planner-v1',
      prompt_fingerprint: 'prompt-v1',
      retrieval_fingerprint: 'retrieval-v1',
      policy_fingerprint: 'policy-v1',
      compiler_version: 1,
      recorded_at: 200,
      surface: 'request_augmentation',
      candidate_source_id: 'd213-scan',
      candidate_source_count: 1,
      candidate_source_partial: false,
    });

    const removed = await composed.deleteRoot('privacy-root');
    expect(removed).toMatchObject({
      reports: 1,
      observations: 1,
      feedback: 1,
      interventions: 1,
      root: true,
    });
    expect(anchorStore.getRoot('privacy-root')).toBeUndefined();
    expect(anchorStore.listAnchors('privacy-root')).toEqual([]);
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM execution_span_dissections
    `).get() as { count: number }).count).toBe(0);
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM execution_turn_dissections
    `).get() as { count: number }).count).toBe(0);
    expect(await composed.reportStore.listAll()).toEqual([]);
    expect(await composed.caseStore.listObservations()).toEqual([]);
    expect(composed.caseStore.compiledReportVersions().size).toBe(0);
    expect(composed.caseStore.compilerVersion())
      .toBe(EXECUTION_CASE_COMPILER_VERSION);
    expect(await composed.caseStore.listAll()).toEqual([]);
    expect(await composed.interventionStore.listForRoot(
      'privacy-exp',
      measurementRoot,
    )).toEqual([]);
  });

  it('deletes every derived root whose closure touches a deleted session', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    schema(db);
    const key = keyProvider();
    const anchorStore = createExecutionSpanAnchorStore(db, key);
    const composed = composeExecutionCases({
      db,
      chatKeyProvider: key,
      registry: registry(),
      getSpanAnchorDeps: () => ({
        store: anchorStore,
        mintRootRequestId: () => 'unused',
      }),
    });
    await anchorStore.openSpan({
      root_request_id: 'session-root',
      session_id: 'origin-session',
      surface: 'chat',
      root_request: 'send the report',
      turn_id: 'origin-turn',
      now: 100,
    });
    expect(anchorStore.anchorTurn({
      root_request_id: 'session-root',
      session_id: 'continued-session',
      turn_id: 'continued-turn',
      origin_turn_id: 'origin-turn',
      now: 101,
    })).toBe(true);

    await expect(composed.deleteSession('continued-session'))
      .resolves.toBe(1);
    expect(anchorStore.getRoot('session-root')).toBeUndefined();
    expect(anchorStore.listAnchors('session-root')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// The outcome reading — a run that COMPLETED and a run that DID SOMETHING
// stop being the same evidence.
//
// WHY THIS EXISTS. The compiler learns from `commit_status`, and a `foreach` is
// continue-on-error by design, so a run whose every item was refused reaches
// `'succeeded'`. D-237 P2 already made that visible on the audit row and in the
// owner's logs; nothing in this substrate READ it. The learner therefore
// recorded "nothing happened" as a clean success — the one label a system that
// admits on evidence about its own behaviour must never invent for itself.
//
// ⛔ EVERY TEST HERE STARTS AT THE RAW AUDIT ROW, NOT AT A PARSED SHAPE. The
// field was previously dropped at the compiler's own parse boundary, so a test
// that handed the decision site a ready-made `ParsedRecipeAuditEntry` would
// have passed against the severed wiring and proved nothing.
// ────────────────────────────────────────────────────────────────

describe('D-237 P2 yield — the execution case reads the OUTCOME, not just the status', () => {
  it('⛔ an all-refused run is EXECUTION FAILURE, though its status says succeeded', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'mail.send' });
    addRecipeRun(f.db, {
      id: 'refused-run',
      at: 101,
      recipe: 'mail.send',
      status: 'succeeded',
      runYield: { steps_run: 1, steps_skipped: 0, items_total: 12, items_failed: 12 },
    });
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });

    const obs = await f.caseStore.listObservations();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.evidence_kinds).toContain('execution_failure');
    expect(obs[0]!.evidence_kinds).not.toContain('unverified_success');
  });

  it('a PARTIAL failure stays a success — the items that went through really did', async () => {
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'mail.send' });
    addRecipeRun(f.db, {
      id: 'partial-run',
      at: 101,
      recipe: 'mail.send',
      status: 'succeeded',
      runYield: { steps_run: 1, steps_skipped: 0, items_total: 12, items_failed: 11 },
    });
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });

    const obs = await f.caseStore.listObservations();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.evidence_kinds).not.toContain('execution_failure');
  });

  it('⛔ a run with NO yield is unchanged — absent is pre-D-237, never "produced nothing"', async () => {
    // Every audit row written before D-237 has no yield. If absence read as a
    // refusal, this change would retroactively relabel the entire history as
    // failure, in one predicate, with nothing to notice it.
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'mail.send' });
    addRecipeRun(f.db, {
      id: 'legacy-run',
      at: 101,
      recipe: 'mail.send',
      status: 'succeeded',
    });
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });

    const obs = await f.caseStore.listObservations();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.evidence_kinds).not.toContain('execution_failure');
  });

  it('⛔ THE PARSE BOUNDARY: the two runs differ ONLY in the yield', async () => {
    // The composition check. Both rows carry `commit_status: 'succeeded'` and
    // identical everything else, so the differing verdict can only have come
    // from a value that survived the compiler's projection of the audit row.
    const refused = await fixture();
    await open(refused);
    addActivity(refused.db, { id: 'a1', at: 101, tool: 'mail.send' });
    addRecipeRun(refused.db, {
      id: 'r1',
      at: 101,
      recipe: 'mail.send',
      status: 'succeeded',
      runYield: { steps_run: 1, steps_skipped: 0, items_total: 5, items_failed: 5 },
    });
    await refused.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });

    const worked = await fixture();
    await open(worked);
    addActivity(worked.db, { id: 'a1', at: 101, tool: 'mail.send' });
    addRecipeRun(worked.db, {
      id: 'r1',
      at: 101,
      recipe: 'mail.send',
      status: 'succeeded',
      runYield: { steps_run: 1, steps_skipped: 0, items_total: 5, items_failed: 0 },
    });
    await worked.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });

    const refusedObs = await refused.caseStore.listObservations();
    const workedObs = await worked.caseStore.listObservations();
    expect(refusedObs[0]!.evidence_kinds).toContain('execution_failure');
    expect(workedObs[0]!.evidence_kinds).not.toContain('execution_failure');
  });

  it('an approval expiry is still NOT an execution failure, yield or no yield', async () => {
    // The pre-existing carve-out must survive: an abandoned approval is a
    // different fact from a refused item, and the yield must not smuggle it in.
    const f = await fixture();
    await open(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'mail.send' });
    addRecipeRun(f.db, {
      id: 'expired-run',
      at: 101,
      recipe: 'mail.send',
      status: 'succeeded',
      errorCodes: ['RECIPE_APPROVAL_TIMEOUT'],
      runYield: { steps_run: 1, steps_skipped: 0, items_total: 3, items_failed: 3 },
    });
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });

    const obs = await f.caseStore.listObservations();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.evidence_kinds).not.toContain('execution_failure');
  });
});

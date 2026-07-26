/** D-214 additive runtime composition.
 *
 * Observation/reporting is always composed on owner chat. Steering remains
 * absent unless a complete bounded experiment definition is supplied.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  OWNER_CONTRACT_ID,
  executionSourceContractId,
  type ExecutionSource,
  type InternalToolRegistry,
} from '@recued/contracts';

import {
  createExecutionCaseLifecycle,
  wrapRegistryWithExecutionCaseTools,
  type ExecutionCaseLifecycle,
} from '../../chat-execution-case-tools.js';
import {
  createExecutionCaseCompiler,
  type ExecutionCaseCompiler,
} from '../../execution-case-compiler.js';
import {
  createExecutionCaseProposalCritic,
  type ExecutionCaseProposalCritic,
} from '../../execution-case-critic.js';
import {
  createExecutionCaseFeedbackRecorder,
  type ExecutionCaseFeedbackRecorder,
} from '../../execution-case-feedback.js';
import {
  createExecutionCaseExperimentReporter,
  type CaseExperimentReport,
  type ExecutionCaseExperimentReporter,
} from '../../execution-case-experiment.js';
import {
  createExecutionCaseVerificationRecorder,
  type ExecutionCaseVerificationRecorder,
} from '../../execution-case-verification.js';
import {
  createD213ScanCaseCandidateSource,
  validateExecutionCaseExperimentDefinition,
  type ExecutionCaseExperimentDefinition,
  type RequestAugmentationDeps,
} from '../../execution-case-retrieval.js';
import {
  createCaseInterventionStore,
  type CaseInterventionStore,
} from '../../storage/case-intervention-store.js';
import {
  createExecutionCaseFeedbackStore,
  type ExecutionCaseFeedbackStore,
} from '../../storage/execution-case-feedback-store.js';
import {
  createExecutionCaseStore,
  type ExecutionCaseStore,
} from '../../storage/execution-case-store.js';
import {
  createExecutionReportStore,
  type ExecutionReportStore,
} from '../../storage/execution-report-store.js';
import {
  createExecutionSpanDissectionStore,
} from '../../storage/execution-span-dissection-store.js';
import {
  createExecutionCaseVerificationStore,
  type ExecutionCaseVerificationStore,
} from '../../storage/execution-case-verification-store.js';
import type {
  D214KeyProvider,
} from '../../storage/d214-sealed-json.js';
import type {
  SpanAnchorDeps,
} from '../../chat-span-anchor-middleware.js';

export interface ComposedExecutionCases {
  registry: InternalToolRegistry;
  lifecycle: ExecutionCaseLifecycle;
  getExecutionCaseLifecycle: () => ExecutionCaseLifecycle;
  getExecutionCaseAugmentationDeps?:
    () => RequestAugmentationDeps | undefined;
  getExecutionCaseProposalCritic?:
    () => ExecutionCaseProposalCritic | undefined;
  feedbackRecorder: ExecutionCaseFeedbackRecorder;
  verificationRecorder: ExecutionCaseVerificationRecorder;
  caseStore: ExecutionCaseStore;
  reportStore: ExecutionReportStore;
  feedbackStore: ExecutionCaseFeedbackStore;
  verificationStore: ExecutionCaseVerificationStore;
  interventionStore: CaseInterventionStore;
  compiler: ExecutionCaseCompiler;
  experimentReporter: ExecutionCaseExperimentReporter;
  /** Present only for a complete pre-registered experiment definition. */
  activeExperimentReport?: () => Promise<CaseExperimentReport>;
  /** Privacy/source deletion coordinator for every D-214-owned derivative. */
  deleteRoot(root_request_id: string): Promise<{
    reports: number;
    observations: number;
    feedback: number;
    verifications: number;
    interventions: number;
    root: boolean;
  }>;
  /** Session privacy cascade. Returns the number of D-214 roots removed. */
  deleteSession(session_id: string): Promise<number>;
}

const finiteInteger = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

/** Requires every pre-registration decision field. Incomplete config stays
 * dark rather than inventing a population or decision rule at runtime. */
export const readExecutionCaseExperimentEnv = (
  env: NodeJS.ProcessEnv = process.env,
): ExecutionCaseExperimentDefinition | undefined => {
  const experiment_id = env.RECUED_D214_EXPERIMENT_ID;
  const surface = env.RECUED_D214_EXPERIMENT_SURFACE;
  const starts_at = finiteInteger(env.RECUED_D214_EXPERIMENT_START_MS);
  const ends_at = finiteInteger(env.RECUED_D214_EXPERIMENT_END_MS);
  const max_roots = finiteInteger(env.RECUED_D214_EXPERIMENT_MAX_ROOTS);
  const maxCritiques = finiteInteger(
    env.RECUED_D214_EXPERIMENT_MAX_CRITIQUES_PER_ROOT,
  );
  const max_evidence = finiteInteger(
    env.RECUED_D214_EXPERIMENT_MAX_EVIDENCE,
  );
  const minScore = finiteInteger(
    env.RECUED_D214_EXPERIMENT_MIN_RELEVANCE_SCORE,
  );
  const primaryAxes = env.RECUED_D214_EXPERIMENT_PRIMARY_AXES
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !experiment_id
    || (
      surface !== 'request_augmentation'
      && surface !== 'proposal_critique'
    )
    || starts_at === undefined
    || ends_at === undefined
    || max_roots === undefined
    || maxCritiques === undefined
    || max_evidence === undefined
    || minScore === undefined
    || !env.RECUED_D214_EXPERIMENT_ELIGIBLE_POPULATION
    || !env.RECUED_D214_EXPERIMENT_DECISION_RULE
    || !env.RECUED_D214_EXPERIMENT_PLANNER_FINGERPRINT
    || !env.RECUED_D214_EXPERIMENT_PROMPT_FINGERPRINT
    || !env.RECUED_D214_EXPERIMENT_RETRIEVAL_FINGERPRINT
    || !env.RECUED_D214_EXPERIMENT_POLICY_FINGERPRINT
    || !env.RECUED_D214_EXPERIMENT_SECRET?.trim()
    || !primaryAxes?.length
  ) return undefined;
  let harmBounds: Record<string, number>;
  try {
    const parsed = JSON.parse(
      env.RECUED_D214_EXPERIMENT_MATERIAL_HARM_BOUNDS ?? '',
    ) as unknown;
    if (
      parsed === null
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
    ) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([key, value]) =>
      key.trim().length === 0
      || typeof value !== 'number'
      || !Number.isFinite(value)
    )) return undefined;
    harmBounds = Object.fromEntries(entries) as Record<string, number>;
  } catch {
    return undefined;
  }
  const definition: ExecutionCaseExperimentDefinition = {
    experiment_id,
    surface,
    eligible_population:
      env.RECUED_D214_EXPERIMENT_ELIGIBLE_POPULATION,
    starts_at,
    ends_at,
    max_roots,
    max_critique_opportunities_per_root: maxCritiques,
    max_evidence,
    min_relevance_score: minScore,
    primary_axes: primaryAxes,
    material_harm_bounds: harmBounds,
    decision_rule: env.RECUED_D214_EXPERIMENT_DECISION_RULE,
    planner_fingerprint:
      env.RECUED_D214_EXPERIMENT_PLANNER_FINGERPRINT,
    prompt_fingerprint:
      env.RECUED_D214_EXPERIMENT_PROMPT_FINGERPRINT,
    retrieval_fingerprint:
      env.RECUED_D214_EXPERIMENT_RETRIEVAL_FINGERPRINT,
    policy_fingerprint:
      env.RECUED_D214_EXPERIMENT_POLICY_FINGERPRINT,
  };
  try {
    validateExecutionCaseExperimentDefinition(definition);
  } catch {
    return undefined;
  }
  return definition;
};

export const composeExecutionCases = (input: {
  db: Database.Database;
  chatKeyProvider?: D214KeyProvider;
  registry: InternalToolRegistry;
  getSpanAnchorDeps: () => SpanAnchorDeps;
  experiment?: ExecutionCaseExperimentDefinition;
  experimentSecret?: string;
}): ComposedExecutionCases => {
  if (input.experiment) {
    validateExecutionCaseExperimentDefinition(input.experiment);
    if (!input.experimentSecret?.trim()) {
      throw new Error(
        'd214 active experiment requires a server assignment secret',
      );
    }
  }
  const anchorStore = input.getSpanAnchorDeps().store;
  const reportStore = createExecutionReportStore(
    input.db,
    input.chatKeyProvider,
  );
  const caseStore = createExecutionCaseStore(
    input.db,
    input.chatKeyProvider,
  );
  const dissectionStore = createExecutionSpanDissectionStore(
    input.db,
    input.chatKeyProvider,
  );
  const feedbackStore = createExecutionCaseFeedbackStore(input.db);
  const verificationStore =
    createExecutionCaseVerificationStore(input.db);
  const secret = createHash('sha256')
    .update(input.experimentSecret ?? 'd214-dark-unassigned')
    .digest();
  const interventionStore = createCaseInterventionStore(
    input.db,
    input.chatKeyProvider,
    secret,
  );
  const compiler = createExecutionCaseCompiler({
    db: input.db,
    anchorStore,
    dissectionStore,
    reportStore,
    caseStore,
    feedbackStore,
    verificationStore,
    registry: input.registry,
  });
  const lifecycle = createExecutionCaseLifecycle({
    anchorStore,
    dissectionStore,
    reportStore,
    compiler,
    registry: input.registry,
    interventionStore,
  });
  const registry = wrapRegistryWithExecutionCaseTools(
    input.registry,
    lifecycle,
  );
  const experiment = input.experiment;
  const resolveOwnerScope = (context: {
    session_id: string;
    turn_id: string;
    source?: ExecutionSource;
  }) => {
    const anchor = anchorStore.getAnchor(
      context.session_id,
      context.turn_id,
    );
    const root = anchor
      ? anchorStore.getRoot(anchor.root_request_id)
      : undefined;
    const source = context.source;
    const ownerSource =
      source?.channel === 'chat'
      && source.actor === 'user_self'
      && source.chat_session_id === context.session_id
      && source.turn_id === context.turn_id;
    return {
      governing_contract_id:
        ownerSource
          ? executionSourceContractId(source) ?? OWNER_CONTRACT_ID
          : OWNER_CONTRACT_ID,
      principal_key: 'user_self',
      active: ownerSource && root?.surface === 'chat',
    };
  };
  const augmentationDeps =
    experiment?.surface === 'request_augmentation'
      ? {
          anchorStore,
          caseStore,
          candidateSource: createD213ScanCaseCandidateSource(caseStore),
          interventionStore,
          experiment,
          ensureCasesCurrent: compiler.ensureCurrent,
          resolveScope: resolveOwnerScope,
        } satisfies RequestAugmentationDeps
      : undefined;
  const proposalCritic =
    experiment?.surface === 'proposal_critique'
      ? createExecutionCaseProposalCritic({
          anchorStore,
          caseStore,
          interventionStore,
          registry: input.registry,
          experiment,
          ensureCasesCurrent: compiler.ensureCurrent,
          resolveScope: resolveOwnerScope,
        })
      : undefined;
  const feedbackRecorder = createExecutionCaseFeedbackRecorder({
    anchorStore,
    feedbackStore,
    reportStore,
    caseStore,
    interventionStore,
    compiler,
  });
  const verificationRecorder = createExecutionCaseVerificationRecorder({
    anchorStore,
    verificationStore,
    reportStore,
    caseStore,
    compiler,
  });
  const experimentReporter = createExecutionCaseExperimentReporter({
    compiler,
    interventionStore,
    caseStore,
  });
  const deleteRoot = async (root_request_id: string) => {
    // Keep a crash between source removal and reprojection from leaving a
    // current-version stamp over an unsupported materialized case.
    caseStore.clearCompilerVersion();
    const reports = await reportStore.listForRoot(root_request_id);
    const observations = (await caseStore.listObservations())
      .filter((item) => item.root_request_id === root_request_id).length;
    const affectedCaseIds = new Set<string>();
    for (const stored of reports) {
      for (const caseId of caseStore.deleteUnsupported(
        stored.report.report_id,
      )) {
        affectedCaseIds.add(caseId);
      }
      reportStore.delete(stored.report.report_id);
    }
    const feedback = feedbackStore.deleteForRoot(root_request_id);
    const verifications =
      verificationStore.deleteForRoot(root_request_id);
    let interventions =
      interventionStore.deleteForRoot(root_request_id);
    dissectionStore.delete(root_request_id);
    const root = anchorStore.deleteRoot(root_request_id);
    await compiler.rebuild();
    for (const caseId of affectedCaseIds) {
      if (await caseStore.get(caseId)) continue;
      interventions += await interventionStore.deleteForCase(caseId);
    }
    return {
      reports: reports.length,
      observations,
      feedback,
      verifications,
      interventions,
      root,
    };
  };
  return {
    registry,
    lifecycle,
    getExecutionCaseLifecycle: () => lifecycle,
    ...(augmentationDeps
      ? {
          getExecutionCaseAugmentationDeps: () => augmentationDeps,
        }
      : {}),
    ...(proposalCritic
      ? {
          getExecutionCaseProposalCritic: () => proposalCritic,
        }
      : {}),
    feedbackRecorder,
    verificationRecorder,
    caseStore,
    reportStore,
    feedbackStore,
    verificationStore,
    interventionStore,
    compiler,
    experimentReporter,
    ...(experiment
      ? {
          activeExperimentReport: () =>
            experimentReporter.report(experiment),
        }
      : {}),
    deleteRoot,
    async deleteSession(session_id) {
      const roots = anchorStore.listRootsForSession(session_id);
      for (const rootRequestId of roots) {
        await deleteRoot(rootRequestId);
      }
      return roots.length;
    },
  };
};

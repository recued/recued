/** D-214 additive runtime composition.
 *
 * Observation/reporting is always composed on owner chat. Steering remains
 * absent unless a complete bounded experiment definition is supplied.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  OWNER_CONTRACT_ID,
  executionSourceContractId,
  type ExecutionSource,
  type InstancePrefs,
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
  createExecutionCaseOfferLifecycle,
  executionCaseOfferEnabled,
  type ExecutionCaseOfferLifecycle,
  type ExecutionCaseOfferNotifier,
} from '../../execution-case-offer-lifecycle.js';
import {
  executionCaseKey,
  requestShapeHash,
} from '../../execution-case-core.js';
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
import type {
  ExecutionCasePrecedentDeps,
  ExecutionCasePrecedentObservation,
} from '../../execution-case-precedent.js';
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
  createExecutionCaseArgumentStore,
  type ExecutionCaseArgumentStore,
} from '../../storage/execution-case-argument-store.js';
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
  /** D-219 slice 9c — resolves only once a notification block has been
   *  published. Until then the finalizer middleware's offer halves are no-ops:
   *  there is nowhere to raise an ask, and inventing a surface here would be
   *  worse than staying silent. */
  getExecutionCaseOfferLifecycle: () => ExecutionCaseOfferLifecycle | undefined;
  /** D-219 slice 9c — boot hand-off, called ONCE by the composer that owns the
   *  notification block (which is built after the chat substrate). Building the
   *  lifecycle here rather than lazily per turn is deliberate: this is also
   *  where the ANSWER handler registers, and the block's boot recovery
   *  re-dispatches answered-but-unhandled asks exactly once — an answer given
   *  while the server was down would be lost if registration waited for the
   *  first live turn. */
  publishExecutionCaseOfferNotifier(
    notifier: ExecutionCaseOfferNotifier,
  ): void;
  getExecutionCaseAugmentationDeps?:
    () => RequestAugmentationDeps | undefined;
  /** D-219 — the ordinary-path precedent surface. Present iff NO experiment is
   *  configured; the two are mutually exclusive by construction, so a reader can
   *  tell which surface a server is running from this object alone. */
  getExecutionCasePrecedentDeps?:
    () => ExecutionCasePrecedentDeps | undefined;
  /** D-219 — per-boot retrieval tally. Present exactly when the precedent
   *  surface is, so its absence on `chat.execution.diagnostics` is the same
   *  fact as "an experiment is configured", not a missing feature. */
  precedentObservation?: () => ExecutionCasePrecedentObservation;
  getExecutionCaseProposalCritic?:
    () => ExecutionCaseProposalCritic | undefined;
  feedbackRecorder: ExecutionCaseFeedbackRecorder;
  verificationRecorder: ExecutionCaseVerificationRecorder;
  caseStore: ExecutionCaseStore;
  reportStore: ExecutionReportStore;
  feedbackStore: ExecutionCaseFeedbackStore;
  verificationStore: ExecutionCaseVerificationStore;
  interventionStore: CaseInterventionStore;
  /** D-219 capture-only argument buffer. Surfaced so the retention pruner and
   *  the privacy cascade can reach it; ⛔ no read path consumes it. */
  argumentStore: ExecutionCaseArgumentStore;
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
  /** D-219 slice 9c — every paired device's `chat.execution_case_offer`, read
   *  LIVE per candidate turn. Resolved off-anywhere-wins by
   *  `executionCaseOfferEnabled`; absent ⇒ the ask stays ON (the registry
   *  default), because a missing roster is not an opt-out. */
  getOfferPrefsRoster?: () => ReadonlyArray<Partial<InstancePrefs> | undefined>;
  /** D-219 — the owner's contact index, for skeleton matching's hole predicate.
   *  Absent ⇒ no skeleton signal; the surface degrades to lexical ranking. */
  getContactStore?: () => { list(input: {
    name_contains: string;
    limit?: number;
  }): ReadonlyArray<{ name?: string | null }> } | undefined;
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
  // D-219 — CAPTURE-ONLY argument buffer. Fire-and-forget at the dispatch seam:
  // a slow or failing write must never delay or fail a tool call, and a missed
  // capture costs a future lesson rather than a turn. ⛔ Nothing reads it.
  const argumentStore = createExecutionCaseArgumentStore(
    input.db,
    input.chatKeyProvider,
  );
  const registry = wrapRegistryWithExecutionCaseTools(
    input.registry,
    lifecycle,
    (captured) => {
      void argumentStore.capture({
        capture_id: randomUUID(),
        session_id: captured.session_id,
        turn_id: captured.turn_id,
        tool_name: captured.tool_name,
        captured_at: Date.now(),
        args: captured.args,
      }).catch(() => {
        // Best-effort by contract — see the store header.
      });
    },
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
  // D-219 — THE ORDINARY PATH, and the only reader the corpus has on a normal
  // self-hosted server. Composed when NO experiment is configured at all.
  //
  // ⛔ `!experiment`, not `experiment?.surface !== 'request_augmentation'`. A
  // `proposal_critique` pre-registration measures a fixed prompt too: adding a
  // precedent block to every turn of both its arms changes the prompt the study
  // recorded a fingerprint for, which invalidates the study without failing
  // anything. One study at a time, and the study wins.
  // Per-boot retrieval tally, surfaced on `chat.execution.diagnostics`. In RAM
  // and never persisted: it is an operational read for whoever is looking at a
  // server now, not a metric with a retention story, and the D-219 arc has
  // enough stores already.
  // ⛔⛔ THE PRECEDENT CARD IS REMOVED FROM THE CHAT SURFACE — MEASURED HARM,
  // NOT A PREFERENCE. Three pre-registered A/B rounds found no benefit and the
  // last two found the opposite: a card multiplied INVENTED ARGUMENTS at ~5.5x
  // odds (round 2 11/60 vs 2/60, p = 0.016; round 3 29/60 vs 8/60, p = 0.00006).
  //
  // The mechanism is not subtle. A card names tools and, by design, omits their
  // arguments — SHAPE WITHOUT VALUES. A model told "this route was right" runs
  // the route AT ONCE: single-round turns went 31/61 with a card vs 17/63
  // without (p = 0.0096), and every one of the 73 invented arguments observed
  // across both arms was issued INSIDE such a batch, beside the very read that
  // would have supplied its value. The invention is then carried onward.
  //
  // 🔑 AND THERE IS NO REMAINING SCENARIO. V22 admits only flows with three
  // distinct non-core rounds — the one depth a shape-only card could have
  // helped with — and bench 181 showed the model does not PRODUCE that depth:
  // handed a chain that cannot be batched (`list-buildings` → building_id →
  // `add-unit` → unit_id → `open-rental-contract`) it batched anyway and
  // invented the joins, `building_1` and then the placeholder `__first__`.
  // Depth 1 where the chain is 3.
  //
  // ⚠ WHAT SURVIVES, DELIBERATELY: case compilation, the "Worth remembering?"
  // offer, Settings → Privacy → Learning, and the two-press recipe draft. Every
  // one of those is OWNER-REVIEWED — the owner reads and presses, and a draft
  // lands UNSAVED in the Kitchen editor. The card was the only surface that
  // acted on the corpus with no human in the loop, which is why it is the one
  // removed. Restoring it means re-running the A/B, not re-adding a builder.
  //
  // The deps builder is DELETED rather than left unsupplied: an inert
  // constructor still typechecks, still reads as live, and invites a future
  // edit to re-wire it without re-measuring.
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
  // D-219 slice 9c — the offer lifecycle, built when (and only when) a
  // notification block is published. The key an observation would file under is
  // derived here rather than inside the lifecycle so that module stays free of
  // the compiler's hashing internals.
  let offerLifecycle: ExecutionCaseOfferLifecycle | undefined;
  const publishExecutionCaseOfferNotifier = (
    notifier: ExecutionCaseOfferNotifier,
  ): void => {
    // Idempotent: a second publish would register a SECOND answer handler for
    // the same kind and record the owner's one verdict twice.
    if (offerLifecycle) return;
    offerLifecycle = createExecutionCaseOfferLifecycle({
      notifier,
      compiler,
      caseStore,
      feedback: feedbackRecorder,
      caseKeyOf: (observation) => executionCaseKey({
        governing_contract_id: observation.governing_contract_id,
        principal_key: observation.principal_key,
        request_shape_hash: requestShapeHash(observation.request_shape),
        policy_fingerprint: observation.policy_fingerprint,
      }),
      ...(input.getOfferPrefsRoster
        ? {
            isOfferEnabled: () =>
              executionCaseOfferEnabled(input.getOfferPrefsRoster!()),
          }
        : {}),
    });
    offerLifecycle.registerAnswerHandler();
  };
  const deleteRoot = async (root_request_id: string) => {
    // Keep a crash between source removal and reprojection from leaving a
    // current-version stamp over an unsupported materialized case.
    caseStore.clearCompilerVersion();
    const reports = await reportStore.listForRoot(root_request_id);
    const observations =
      (await caseStore.listObservationsForRoot(root_request_id)).length;
    const affectedCaseIds = new Set<string>();
    for (const stored of reports) {
      for (const caseId of caseStore.deleteUnsupported(
        stored.report.report_id,
      )) {
        affectedCaseIds.add(caseId);
      }
      reportStore.delete(stored.report.report_id);
    }
    // ⛔ D-219 — the capture buffer joins the privacy cascade. A captured
    // argument that outlived a forget request would be the worst version of
    // this feature: raw values, kept after the record they belong to is gone.
    argumentStore.deleteForTurns(
      anchorStore.listAnchors(root_request_id).map((anchor) => ({
        session_id: anchor.session_id,
        turn_id: anchor.turn_id,
      })),
    );
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
    getExecutionCaseOfferLifecycle: () => offerLifecycle,
    publishExecutionCaseOfferNotifier,
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
    argumentStore,
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
      // ⚠ Session-wide, AFTER the per-root sweep: a capture whose turn was
      // never anchored (no root — the span anchor skips a turn with no user
      // text) has no root to be deleted by, and forgetting a session must not
      // leave it behind.
      argumentStore.deleteForSession(session_id);
      return roots.length;
    },
  };
};

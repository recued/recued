/** D-214 pure compiler/retrieval core.
 *
 * All durable inputs are projected into {@link CaseSourceObservation} before
 * reaching this module. The functions below are deliberately deterministic:
 * no wall clock reads, random ids, database order, model calls, or current
 * policy decisions occur here. Rebuilding a fixed source snapshot therefore
 * produces byte-equivalent cases.
 */

import { createHash } from 'node:crypto';

import {
  EXECUTION_CASE_MIN_CALLS_NEGATIVE,
  EXECUTION_CASE_MIN_CALLS_POSITIVE,
  EXECUTION_CASE_RECURRENCE_FLOOR,
  type ExecutionCase,
  type ExecutionCaseCard,
  type ExecutionCaseFlow,
  type ExecutionOutcome,
  type FlowBasis,
  type FlowCritique,
  type FlowPattern,
  type HistoricalExecutionOutcome,
  type OutcomeStrength,
  type RequestAnalysis,
  type RequestDissection,
  type RequestShape,
  type RuntimeCompositionDispatch,
  type RuntimeCompositionRouteKind,
  type SupersededCaseRun,
  type SupersededReason,
} from '@recued/contracts';
import {
  extractPromptCacheNer as extractNer,
} from '@recued/middleware-prompt-cache';

/** V5 falls ungrounded root dissections back to the server-owned request shape
 * while keeping later-turn drift fail-closed, and finishes the independent
 * evidence boundary for historical outcome axes. */
export const EXECUTION_CASE_COMPILER_VERSION = 5;
export const EXECUTION_CASE_RECENT_WINDOW = 12;
export const EXECUTION_CASE_MAX_CARD_FLOWS = 5;
export const EXECUTION_CASE_MAX_HISTORY_RUNS = 8;
export const EXECUTION_CASE_MAX_PER_SCOPE = 256;
/** Hard ceiling for one D-214 advisory block. Oversized evidence stays
 * qualifying but is withheld from `selected_evidence`, so advisory context can
 * never turn a valid chat request into a context-length failure. */
export const EXECUTION_CASE_MAX_ADVISORY_BYTES = 24 * 1024;

export const executionCaseAdvisoryFits = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), 'utf8')
    <= EXECUTION_CASE_MAX_ADVISORY_BYTES;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
};

export const hashExecutionCaseValue = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');

export const normalizeExecutionCaseText = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

export const segmentExecutionCaseText = (value: string): string[] => {
  const normalized = normalizeExecutionCaseText(value);
  if (normalized.length === 0) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const terms: string[] = [];
  for (const segment of segmenter.segment(normalized)) {
    if (segment.isWordLike) terms.push(segment.segment);
  }
  return [...new Set(terms.length > 0 ? terms : [normalized])];
};

const localeCandidatesFor = (prompt: string): string[] => {
  const extracted = extractNer(prompt);
  return extracted?.localeCandidates.length
    ? [...extracted.localeCandidates]
    : ['und'];
};

const slotKind = (kind: string): string => {
  if (kind.startsWith('entity.')) return kind.slice('entity.'.length);
  return kind;
};

const fallbackEntitySlots = (
  prompt: string,
): Array<{ role: string; kind: string }> =>
  (extractNer(prompt)?.slots ?? []).map((slot, index) => ({
    role: `entity_${index + 1}`,
    kind: slotKind(slot.kind),
  }));

const CONSTRAINT_PATTERNS: ReadonlyArray<{
  facet: string;
  pattern: RegExp;
}> = [
  { facet: 'negated', pattern: /\b(?:not|never|without|don['’]t|do not|no)\b/iu },
  { facet: 'draft_only', pattern: /\b(?:draft|compose|prepare)\b/iu },
  { facet: 'send', pattern: /\b(?:send|submit|publish|post)\b/iu },
  { facet: 'ordered', pattern: /\b(?:first|then|after|before|next|finally)\b/iu },
  { facet: 'stop_condition', pattern: /\b(?:until|unless|stop when|only if)\b/iu },
  { facet: 'all', pattern: /\b(?:all|every|each)\b/iu },
  { facet: 'single', pattern: /\b(?:one|single|once)\b/iu },
];

const deterministicConstraints = (prompt: string): string[] =>
  CONSTRAINT_PATTERNS
    .filter(({ pattern }) => pattern.test(prompt))
    .map(({ facet }) => facet);

const SERVER_CONSTRAINT_FACETS = [
  ...new Set(CONSTRAINT_PATTERNS.map(({ facet }) => facet)),
] as const;
const SERVER_CONSTRAINT_FACET_SET = new Set<string>(
  SERVER_CONSTRAINT_FACETS,
);

const canonicalServerConstraintFacet = (
  value: string,
): string | undefined => {
  const candidate = normalizeExecutionCaseText(value).replace(/\s+/gu, '_');
  return SERVER_CONSTRAINT_FACET_SET.has(candidate)
    ? candidate
    : undefined;
};

/** Function words that cannot, by themselves, attest what action/object the
 * user requested. This is deliberately a small multilingual glue list rather
 * than a semantic vocabulary: the server is proving lexical grounding, not
 * pretending to understand arbitrary workflows. */
const INTENT_GROUNDING_GLUE = new Set([
  // English
  'a', 'an', 'and', 'at', 'by', 'can', 'could', 'do', 'for', 'from', 'i',
  'in', 'it', 'me', 'my', 'never', 'no', 'not', 'of', 'on', 'or', 'our',
  'please', 'that', 'the', 'this', 'to', 'we', 'will', 'with', 'without',
  'would', 'you', 'your',
  // German / Spanish / French / Portuguese
  'das', 'de', 'del', 'der', 'die', 'du', 'el', 'en', 'et', 'für', 'la',
  'las', 'le', 'les', 'los', 'mit', 'o', 'para', 'por', 'pour', 'que', 'un',
  'une', 'und', 'von', 'y',
  // Japanese / Chinese particles and conjunctions
  'から', 'が', 'で', 'と', 'に', 'の', 'は', 'へ', 'まで', 'も', 'を',
  '与', '了', '和', '把', '的', '给',
]);

const isIntentGroundingTerm = (term: string): boolean =>
  !INTENT_GROUNDING_GLUE.has(term)
  && !/\p{N}/u.test(term);

/** A deliberately bounded English inflection fold for lexical grounding.
 *
 * This is not semantic stemming and never contributes to the case key. It only
 * lets a model label such as "delete events" attest the literal request
 * "delete every event" without treating synonyms or reordered terms as proof.
 */
const intentGroundingInflectionVariants = (term: string): string[] => {
  const variants = new Set([term]);
  if (!/^[a-z]+$/u.test(term)) return [...variants];
  if (term.length > 4 && term.endsWith('ies')) {
    variants.add(`${term.slice(0, -3)}y`);
  }
  if (
    term.length > 4
    && /(?:sses|shes|ches|xes)$/u.test(term)
  ) {
    variants.add(term.slice(0, -2));
  }
  // A terminal `zes` is ambiguous without a lexicon: `sizes`/`prizes`/
  // `analyzes` drop only `s`, while `waltzes` drops `es`. Keep both bounded
  // forms for the grounding comparison rather than choosing an asymmetric
  // pseudo-stem. `quizzes` additionally undoubles its terminal z.
  if (term.length > 4 && term.endsWith('zes')) {
    variants.add(term.slice(0, -1));
    variants.add(term.slice(0, -2));
    if (term.endsWith('zzes')) variants.add(term.slice(0, -3));
  }
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) {
    variants.add(term.slice(0, -1));
  }
  return [...variants];
};

const intentGroundingTerms = (value: string): string[][] =>
  segmentExecutionCaseText(value)
    .filter(isIntentGroundingTerm)
    .map(intentGroundingInflectionVariants);

const groundingTermsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => left.some((term) => right.includes(term));

const isOrderedSubsequence = (
  needle: readonly (readonly string[])[],
  haystack: readonly (readonly string[])[],
): boolean => {
  let cursor = 0;
  for (const term of haystack) {
    const expected = needle[cursor];
    if (expected && groundingTermsOverlap(term, expected)) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return needle.length === 0;
};

/** A model label may key evidence only when the sealed root request attests it.
 *
 * The gate is intentionally fail-closed. At least two content terms must occur
 * in root-request order, and the label must begin with the root's first content
 * term (after bounded glue/numeric removal). That prevents a model from routing
 * unrelated requests through a shared generic object label. A genuine one-word
 * request remains eligible only through an exact normalized match.
 *
 * This is a consistency proof, not the case key: the root surface text is never
 * hashed into `request_shape_hash`.
 */
export const isExecutionCaseIntentGrounded = (
  prompt: string,
  intent: string,
): boolean => {
  const normalizedPrompt = normalizeExecutionCaseText(prompt);
  const normalizedIntent = normalizeExecutionCaseText(intent);
  if (!normalizedPrompt || !normalizedIntent) return false;
  if (normalizedPrompt === normalizedIntent) return true;
  const promptTerms = intentGroundingTerms(prompt);
  const intentTerms = intentGroundingTerms(intent);
  return (
    promptTerms.length >= 2
    && intentTerms.length >= 2
    && groundingTermsOverlap(intentTerms[0]!, promptTerms[0]!)
    && isOrderedSubsequence(intentTerms, promptTerms)
  );
};

const inferredIntent = (prompt: string): string => {
  const terms = segmentExecutionCaseText(prompt);
  return terms.slice(0, 8).join(' ') || 'unknown';
};

/** Convert model-supplied classification into the common storage shape.
 *
 * Values are normalized here and all hashes are computed later by the server.
 * A supplied intent must first be grounded in the sealed root request. An
 * ungrounded classification is ignored in full and the server-owned fallback
 * shape is used, so an imperfect or malicious label can neither key evidence
 * nor suppress the span's negatives. No model-supplied constraint enters the
 * aggregation core.
 */
export const analyzeExecutionCaseRequest = (
  prompt: string,
  dissection?: RequestDissection,
): RequestAnalysis => {
  const groundedDissection =
    dissection && isExecutionCaseIntentGrounded(prompt, dissection.intent)
      ? dissection
      : undefined;
  const surfaceTerms = segmentExecutionCaseText(prompt);
  const constraints = deterministicConstraints(prompt);
  const entities =
    groundedDissection?.entities
      .map((entity) => ({
        role: normalizeExecutionCaseText(entity.role),
        kind: normalizeExecutionCaseText(entity.kind),
      }))
      .filter((entity) => entity.role.length > 0 && entity.kind.length > 0)
    ?? fallbackEntitySlots(prompt);
  const intent = normalizeExecutionCaseText(
    groundedDissection?.intent ?? inferredIntent(prompt),
  );
  const objectFacets = (groundedDissection?.objects ?? [])
    .map(normalizeExecutionCaseText)
    .filter(Boolean)
    .map((object) => `object:${object}`);
  const outcomeFacet = normalizeExecutionCaseText(
    groundedDissection?.outcome_sought ?? '',
  );
  const shape: RequestShape = {
    schema_version: 1,
    locale_candidates: localeCandidatesFor(prompt),
    surface_terms: surfaceTerms,
    segmented_terms: surfaceTerms,
    entity_slots: entities,
    intent_facets: [
      intent,
      ...objectFacets,
      ...(outcomeFacet ? [`outcome:${outcomeFacet}`] : []),
    ],
    constraint_facets: [...new Set(constraints)],
    // Risk belongs to flow evidence. The fallback request analyzer has no
    // authoritative request-only risk classifier, so it leaves this empty.
    risk_facets: [],
  };
  return {
    schema_version: 1,
    route: 'unknown',
    request_shape: shape,
  };
};

/** Exact aggregation core: normalized intent plus syntactic constraints only. */
export const canonicalRequestShapeCore = (
  shape: RequestShape,
): {
  intent: string;
  constraints: string[];
} => {
  const presentConstraints = new Set(
    shape.constraint_facets.flatMap((facet) => {
      const canonical = canonicalServerConstraintFacet(facet);
      return canonical ? [canonical] : [];
    }),
  );
  return {
    intent: normalizeExecutionCaseText(shape.intent_facets[0] ?? 'unknown'),
    // Re-project through the server vocabulary even for replayed/hand-built
    // shapes. A legacy model-authored string or argument-order mutation cannot
    // survive into the aggregation key.
    constraints: SERVER_CONSTRAINT_FACETS.filter((facet) =>
      presentConstraints.has(facet)),
  };
};

export const requestShapeHash = (shape: RequestShape): string =>
  hashExecutionCaseValue(canonicalRequestShapeCore(shape));

export const executionCaseKey = (input: {
  governing_contract_id: string;
  principal_key: string;
  request_shape_hash: string;
  policy_fingerprint: string;
}): string =>
  hashExecutionCaseValue([
    input.governing_contract_id,
    input.principal_key,
    input.request_shape_hash,
    input.policy_fingerprint,
  ]);

export interface FlowStepInput {
  tool_name: string;
  operation_ids?: readonly string[];
  recipe_id?: string;
  recipe_hash?: string;
  dependency_ordinals?: readonly number[];
  approval_boundary?: 'none' | 'held' | 'approved' | 'denied';
  verification_boundary?: 'none' | 'passed' | 'failed' | 'unavailable';
  risk_tier?: string;
  entity_kinds?: readonly string[];
  topic_tags?: readonly string[];
}

const abstractStepFor = (step: FlowStepInput): string => {
  if (step.approval_boundary === 'denied') return 'DENY';
  if (step.approval_boundary === 'held') return 'APPROVAL';
  if (step.verification_boundary === 'passed'
    || step.verification_boundary === 'failed') return 'VERIFY';
  if (
    step.risk_tier === 'write'
    || step.risk_tier === 'admin'
    || step.risk_tier === 'destructive'
  ) return 'WRITE';
  return 'READ';
};

/** Build an argument-free flow pattern. Tool arguments are not accepted. */
export const deriveExecutionFlowPattern = (
  steps: readonly FlowStepInput[],
): FlowPattern => {
  const exactInput = steps.map((step, ordinal) => ({
    ordinal,
    tool_name: step.tool_name,
    operation_ids: [...(step.operation_ids ?? [])],
    ...(step.recipe_id ? { recipe_id: step.recipe_id } : {}),
    ...(step.recipe_hash ? { recipe_hash: step.recipe_hash } : {}),
    dependency_ordinals: [...(step.dependency_ordinals ?? [])],
    approval_boundary: step.approval_boundary ?? 'none',
    verification_boundary: step.verification_boundary ?? 'unavailable',
  }));
  return {
    schema_version: 1,
    exact_signature: hashExecutionCaseValue(exactInput),
    abstract_steps: steps.map(abstractStepFor),
    operation_ids: [...new Set(steps.flatMap((step) => step.operation_ids ?? []))],
    recipe_refs: [
      ...new Map(
        steps.flatMap((step) =>
          step.recipe_id && step.recipe_hash
            ? [[
                `${step.recipe_id}\0${step.recipe_hash}`,
                { recipe_id: step.recipe_id, recipe_hash: step.recipe_hash },
              ] as const]
            : []),
      ).values(),
    ],
    approval_boundaries: steps.flatMap((step, ordinal) =>
      step.approval_boundary && step.approval_boundary !== 'none'
        ? [ordinal]
        : []),
    verification_steps: steps.flatMap((step, ordinal) =>
      step.verification_boundary
      && step.verification_boundary !== 'none'
      && step.verification_boundary !== 'unavailable'
        ? [ordinal]
        : []),
    risk_tier:
      steps.find((step) => step.risk_tier === 'destructive')?.risk_tier
      ?? steps.find((step) => step.risk_tier === 'admin')?.risk_tier
      ?? steps.find((step) => step.risk_tier === 'write')?.risk_tier
      ?? steps.find((step) => step.risk_tier)?.risk_tier
      ?? 'read',
    entity_kinds: [...new Set(steps.flatMap((step) => step.entity_kinds ?? []))],
    topic_tags: [
      ...new Set([
        ...steps.map((step) => `tool:${step.tool_name}`),
        ...steps.flatMap((step) => step.topic_tags ?? []),
      ]),
    ],
  };
};

export type CaseEvidenceKind =
  | 'verification_pass'
  | 'verification_fail'
  | 'typed_acceptance'
  | 'typed_correction'
  | 'typed_rejection'
  | 'typed_undo'
  | 'gateway_denial'
  | 'execution_failure'
  | 'untyped_decline'
  | 'flow_superseded'
  | 'abandoned'
  | 'unverified_success'
  | 'model_claim';

export interface CaseSourceObservation {
  /** Stable per-flow identity. One source report may yield several rows. */
  observation_id: string;
  report_id: string;
  root_request_id: string;
  root_request: string;
  governing_contract_id: string;
  principal_key: string;
  /** Compiler that derived this projection from the authoritative span stores.
   * Legacy rows omit it and are replayed before they may materialize. */
  compiler_version?: number;
  policy_fingerprint: string;
  request_shape: RequestShape;
  flow_pattern: FlowPattern;
  flow_basis: FlowBasis;
  outcome: ExecutionOutcome;
  evidence_kinds: CaseEvidenceKind[];
  substantive_call_count: number;
  span_closed: boolean;
  /** Positive evidence suppresses on drift; negative evidence still files. */
  intent_drifted: boolean;
  consulted_case_keys: string[];
  observed_at: number;
  proposed: boolean;
  plan_accepted: boolean;
  plan_declined: boolean;
  executed: boolean;
}

const positiveKinds: ReadonlySet<CaseEvidenceKind> = new Set([
  'verification_pass',
  'typed_acceptance',
  'unverified_success',
]);
const negativeKinds: ReadonlySet<CaseEvidenceKind> = new Set([
  'verification_fail',
  'typed_correction',
  'typed_rejection',
  'typed_undo',
  'gateway_denial',
  'execution_failure',
  'untyped_decline',
  'flow_superseded',
  'abandoned',
]);
const strongKinds: ReadonlySet<CaseEvidenceKind> = new Set([
  'verification_pass',
  'verification_fail',
  'typed_acceptance',
  'typed_correction',
  'typed_rejection',
  'typed_undo',
  'gateway_denial',
  'execution_failure',
]);

const evidencePolarity = (
  observation: CaseSourceObservation,
): { positive: boolean; negative: boolean } => {
  const negative = observation.evidence_kinds.some((kind) =>
    negativeKinds.has(kind));
  const positive = !observation.intent_drifted
    && observation.evidence_kinds.some((kind) => positiveKinds.has(kind));
  return { positive, negative };
};

export const outcomeStrengthForObservations = (
  observations: readonly CaseSourceObservation[],
): OutcomeStrength => {
  let positive = 0;
  let negative = 0;
  const families = new Set<string>();
  for (const observation of observations) {
    const polarity = evidencePolarity(observation);
    if (polarity.positive) positive += 1;
    if (polarity.negative) negative += 1;
    for (const kind of observation.evidence_kinds) {
      if (kind !== 'model_claim') families.add(kind);
    }
  }
  return {
    positive,
    negative,
    contested: positive > 0 && negative > 0,
    evidence_families: [...families].sort(),
  };
};

/** §9.2 — select one outcome tuple that actually occurred. Counting the four
 * axes independently could synthesize a combination no observation carried;
 * inferring them from `evidence_families` loses authorization states entirely.
 * The modal tuple wins, with the most recent occurrence as the deterministic
 * tie-breaker. */
export const historicalOutcomeForObservations = (
  observations: readonly CaseSourceObservation[],
): HistoricalExecutionOutcome => {
  if (observations.length === 0) {
    throw new Error('cannot derive execution-case history from no observations');
  }
  const tallies = new Map<string, {
    outcome: HistoricalExecutionOutcome;
    occurrences: number;
    last_at: number;
    last_observation_id: string;
  }>();
  for (const observation of observations) {
    const outcome: HistoricalExecutionOutcome = {
      authorization: observation.outcome.authorization,
      execution: observation.outcome.execution,
      verification: observation.outcome.verification,
      feedback: observation.outcome.feedback,
    };
    const key = JSON.stringify(outcome);
    const existing = tallies.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (
        observation.observed_at > existing.last_at
        || (
          observation.observed_at === existing.last_at
          && observation.observation_id > existing.last_observation_id
        )
      ) {
        existing.last_at = observation.observed_at;
        existing.last_observation_id = observation.observation_id;
      }
    } else {
      tallies.set(key, {
        outcome,
        occurrences: 1,
        last_at: observation.observed_at,
        last_observation_id: observation.observation_id,
      });
    }
  }
  return [...tallies.values()].sort((left, right) =>
    right.occurrences - left.occurrences
    || right.last_at - left.last_at
    || right.last_observation_id.localeCompare(left.last_observation_id)
  )[0]!.outcome;
};

const isStructurallyEligible = (
  observation: CaseSourceObservation,
): boolean => {
  if (!observation.span_closed) return false;
  if (
    !observation.governing_contract_id
    || !observation.principal_key
    || !observation.request_shape.intent_facets[0]
    || observation.flow_pattern.exact_signature.length === 0
  ) return false;
  const polarity = evidencePolarity(observation);
  if (!polarity.positive && !polarity.negative) return false;
  const minimum = polarity.negative
    ? EXECUTION_CASE_MIN_CALLS_NEGATIVE
    : EXECUTION_CASE_MIN_CALLS_POSITIVE;
  if (observation.substantive_call_count < minimum) return false;
  if (
    polarity.positive
    && (
      observation.outcome.authorization === 'dismissed'
      || observation.outcome.authorization === 'expired'
      || observation.outcome.execution === 'in_doubt'
      || observation.outcome.execution === 'skipped'
      || observation.outcome.execution === 'not_executed'
    )
  ) return false;
  return true;
};

const emptyFlow = (
  observation: CaseSourceObservation,
): ExecutionCaseFlow => ({
  tools: observation.flow_pattern.exact_signature.length > 0
    ? observation.flow_pattern.topic_tags
        .filter((tag) => tag.startsWith('tool:'))
        .map((tag) => tag.slice('tool:'.length))
    : [],
  flow_basis: observation.flow_basis,
  proposed: 0,
  accepted: 0,
  declined: 0,
  executed: 0,
  execution_failures: 0,
  reported_fulfilled: 0,
  verified_successes: 0,
  verification_failures: 0,
  user_acceptances: 0,
  user_corrections: 0,
  user_rejections: 0,
  user_undos: 0,
  outcome_strength: {
    positive: 0,
    negative: 0,
    contested: false,
    evidence_families: [],
  },
  stale: false,
  first_seen_at: observation.observed_at,
  last_seen_at: observation.observed_at,
});

const flowTools = (observation: CaseSourceObservation): string[] => {
  const explicit = observation.flow_pattern.topic_tags
    .filter((tag) => tag.startsWith('tool:'))
    .map((tag) => tag.slice('tool:'.length));
  return explicit.length > 0 ? explicit : observation.flow_pattern.operation_ids;
};

const aggregateFlow = (
  observations: readonly CaseSourceObservation[],
  independentOutcomeObservations: readonly CaseSourceObservation[],
): ExecutionCaseFlow => {
  const first = observations[0]!;
  const flow = emptyFlow(first);
  flow.tools = flowTools(first);
  for (const observation of observations) {
    if (observation.proposed) flow.proposed += 1;
    if (observation.plan_accepted) flow.accepted += 1;
    if (observation.plan_declined) flow.declined += 1;
    if (observation.executed) flow.executed += 1;
    flow.first_seen_at = Math.min(flow.first_seen_at, observation.observed_at);
    flow.last_seen_at = Math.max(flow.last_seen_at, observation.observed_at);
  }
  for (const observation of independentOutcomeObservations) {
    const kinds = new Set(observation.evidence_kinds);
    if (kinds.has('execution_failure')) flow.execution_failures += 1;
    if (observation.outcome.model_claim === 'fulfilled') {
      flow.reported_fulfilled += 1;
    }
    if (kinds.has('verification_pass')) flow.verified_successes += 1;
    if (kinds.has('verification_fail')) flow.verification_failures += 1;
    if (kinds.has('typed_acceptance')) flow.user_acceptances += 1;
    if (kinds.has('typed_correction')) flow.user_corrections += 1;
    if (kinds.has('typed_rejection')) flow.user_rejections += 1;
    if (kinds.has('typed_undo')) flow.user_undos += 1;
  }
  // Deterministic lifecycle counters describe what happened. Every outcome
  // counter and the persuasive strength projection are narrower: a run that
  // consumed this same case cannot reinforce or contradict the flow it saw.
  flow.outcome_strength = outcomeStrengthForObservations(
    independentOutcomeObservations,
  );
  return flow;
};

export interface RebuiltExecutionCases {
  cases: ExecutionCase[];
  source_report_ids_by_case: Map<string, string[]>;
}

/** Deterministically rebuild admitted materialized cases from source rows. */
export const rebuildExecutionCases = (
  source: readonly CaseSourceObservation[],
  compilerVersion = EXECUTION_CASE_COMPILER_VERSION,
): RebuiltExecutionCases => {
  const ordered = [...source].sort((left, right) =>
    left.observed_at - right.observed_at
    || left.observation_id.localeCompare(right.observation_id));
  const groups = new Map<string, CaseSourceObservation[]>();
  for (const observation of ordered) {
    if (!isStructurallyEligible(observation)) continue;
    const shapeHash = requestShapeHash(observation.request_shape);
    const caseKey = executionCaseKey({
      governing_contract_id: observation.governing_contract_id,
      principal_key: observation.principal_key,
      request_shape_hash: shapeHash,
      policy_fingerprint: observation.policy_fingerprint || 'none',
    });
    const observationCompilerVersion =
      observation.compiler_version ?? compilerVersion;
    const key = `${caseKey}\0${observationCompilerVersion}`;
    const list = groups.get(key);
    if (list) list.push(observation);
    else groups.set(key, [observation]);
  }

  const cases: ExecutionCase[] = [];
  const source_report_ids_by_case = new Map<string, string[]>();
  for (const [groupKey, observations] of [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const separator = groupKey.lastIndexOf('\0');
    const caseKey = groupKey.slice(0, separator);
    const groupCompilerVersion = Number(groupKey.slice(separator + 1));
    const independentObservations = observations.filter((observation) =>
      !observation.consulted_case_keys.includes(caseKey));
    const independentRoots = new Set(
      independentObservations.map((observation) =>
        observation.root_request_id),
    );
    const hasStrong = independentObservations.some((observation) =>
      observation.evidence_kinds.some((kind) => strongKinds.has(kind)));
    if (
      !hasStrong
      && independentRoots.size < EXECUTION_CASE_RECURRENCE_FLOOR
    ) continue;

    const first = observations[0]!;
    const caseId = `case_${hashExecutionCaseValue([
      caseKey,
      groupCompilerVersion,
    ]).slice(0, 32)}`;
    const flowGroups = new Map<string, CaseSourceObservation[]>();
    for (const observation of observations) {
      const flowKey = `${observation.flow_basis}\0${observation.flow_pattern.exact_signature}`;
      const list = flowGroups.get(flowKey);
      if (list) list.push(observation);
      else flowGroups.set(flowKey, [observation]);
    }
    const flowEntries = [...flowGroups.entries()].map(([signature, items]) => ({
      signature,
      flow: aggregateFlow(
        items,
        items.filter((observation) =>
          !observation.consulted_case_keys.includes(caseKey)),
      ),
    }));
    // A changed exact recipe/op/approval pattern with the same public tool
    // sequence remains historical evidence but must not steer. The newest exact
    // pattern stays current; no case fork occurs because flows are content.
    const entriesByPublicFlow = new Map<string, typeof flowEntries>();
    for (const entry of flowEntries) {
      const key = JSON.stringify([
        entry.flow.flow_basis,
        entry.flow.tools,
      ]);
      const list = entriesByPublicFlow.get(key);
      if (list) list.push(entry);
      else entriesByPublicFlow.set(key, [entry]);
    }
    for (const entries of entriesByPublicFlow.values()) {
      if (entries.length < 2) continue;
      entries.sort((left, right) =>
        right.flow.last_seen_at - left.flow.last_seen_at
        || left.signature.localeCompare(right.signature));
      for (const entry of entries.slice(1)) entry.flow.stale = true;
    }
    const flows = flowEntries.map((entry) => entry.flow);
    // "Recent evidence" means recent independent evidence, not the most recent
    // runs after this case had already entered the planner packet.
    const recentSource = independentObservations
      .slice(-EXECUTION_CASE_RECENT_WINDOW);
    const recentStrength = outcomeStrengthForObservations(recentSource);
    let consecutiveContradictions = 0;
    for (let i = recentSource.length - 1; i >= 0; i -= 1) {
      if (!evidencePolarity(recentSource[i]!).negative) break;
      consecutiveContradictions += 1;
    }
    const reportIds = [...new Set(observations.map((item) => item.report_id))];
    const requestRoots = new Set(
      observations.map((observation) => observation.root_request_id),
    );
    const caseRow: ExecutionCase = {
      case_id: caseId,
      case_key: caseKey,
      schema_version: 1,
      compiler_version: groupCompilerVersion,
      governing_contract_id: first.governing_contract_id,
      principal_key: first.principal_key,
      request_shape: first.request_shape,
      request_shape_hash: requestShapeHash(first.request_shape),
      policy_fingerprint: first.policy_fingerprint || 'none',
      request_observations: requestRoots.size,
      independent_observations: independentRoots.size,
      flows,
      outcome_strength: outcomeStrengthForObservations(
        independentObservations,
      ),
      history_outcome: historicalOutcomeForObservations(
        independentObservations,
      ),
      recent: {
        window: recentSource.length,
        positive: recentStrength.positive,
        negative: recentStrength.negative,
        consecutive_contradictions: consecutiveContradictions,
        ...(consecutiveContradictions > 0
          ? {
              last_contradiction_at:
                [...recentSource]
                  .reverse()
                  .find((item) => evidencePolarity(item).negative)
                  ?.observed_at,
            }
          : {}),
      },
      source_report_count: reportIds.length,
      representative_source_report_ids: reportIds.slice(0, 8),
      first_seen_at: observations[0]!.observed_at,
      last_seen_at: observations.at(-1)!.observed_at,
    };
    cases.push(caseRow);
    source_report_ids_by_case.set(caseId, reportIds);
  }

  // Policy/compiler forks form append-only history. Flow changes do not. A
  // returning policy regime is current again, so currentness follows the most
  // recent observation rather than the first time a fingerprint appeared.
  const lineages = new Map<string, ExecutionCase[]>();
  for (const row of cases) {
    const lineageKey = [
      row.governing_contract_id,
      row.principal_key,
      row.request_shape_hash,
    ].join('\0');
    const list = lineages.get(lineageKey);
    if (list) list.push(row);
    else lineages.set(lineageKey, [row]);
  }
  for (const lineage of lineages.values()) {
    lineage.sort((a, b) =>
      a.last_seen_at - b.last_seen_at
      || a.first_seen_at - b.first_seen_at
      || a.case_id.localeCompare(b.case_id));
    for (let index = 1; index < lineage.length; index += 1) {
      const prior = lineage[index - 1]!;
      const current = lineage[index]!;
      prior.superseded_by = current.case_id;
      current.supersedes = prior.case_id;
    }
  }

  return { cases, source_report_ids_by_case };
};

const historyRunKey = (
  item: Pick<SupersededCaseRun, 'outcome' | 'superseded_reason'>,
): string => JSON.stringify({
  outcome: item.outcome,
  superseded_reason: item.superseded_reason,
});

export interface HistoricalCaseDigest {
  case_id: string;
  at: number;
  outcome: SupersededCaseRun['outcome'];
  superseded_reason: SupersededReason;
}

/** Run-length encode adjacent history only; non-adjacent equal runs survive. */
export const encodeSupersededCaseHistory = (
  history: readonly HistoricalCaseDigest[],
  maxRuns = EXECUTION_CASE_MAX_HISTORY_RUNS,
): { runs: SupersededCaseRun[]; truncatedOccurrences: number } => {
  const runs: SupersededCaseRun[] = [];
  for (const item of [...history].sort((a, b) =>
    a.at - b.at || a.case_id.localeCompare(b.case_id))) {
    const shape = {
      outcome: item.outcome,
      superseded_reason: item.superseded_reason,
    };
    const prior = runs.at(-1);
    if (
      prior
      && historyRunKey(prior) === historyRunKey(shape)
    ) {
      prior.occurrences += 1;
      prior.last_at = item.at;
      prior.case_ref = item.case_id;
    } else {
      runs.push({
        ...shape,
        occurrences: 1,
        first_at: item.at,
        last_at: item.at,
        case_ref: item.case_id,
      });
    }
  }
  const newest = runs.reverse();
  const omitted = newest.slice(maxRuns)
    .reduce((count, run) => count + run.occurrences, 0);
  return {
    runs: newest.slice(0, maxRuns),
    truncatedOccurrences: omitted,
  };
};

const flowWeight = (flow: ExecutionCaseFlow): number =>
  flow.outcome_strength.positive - flow.outcome_strength.negative;

export const renderExecutionCaseCard = (
  row: ExecutionCase,
  history: readonly HistoricalCaseDigest[] = [],
  unresolvedHistoryOccurrences = 0,
): ExecutionCaseCard => {
  const encoded = encodeSupersededCaseHistory(history);
  const historyTruncated =
    encoded.truncatedOccurrences
    + Math.max(0, unresolvedHistoryOccurrences);
  return {
    request_shape: row.request_shape,
    flows: [...row.flows]
      .sort((a, b) =>
        flowWeight(b) - flowWeight(a)
        || b.last_seen_at - a.last_seen_at)
      .slice(0, EXECUTION_CASE_MAX_CARD_FLOWS),
    outcome_strength: row.outcome_strength,
    recent: row.recent,
    request_observations: row.request_observations,
    last_seen_at: row.last_seen_at,
    superseded: row.superseded_by !== undefined,
    history: encoded.runs,
    ...(historyTruncated > 0
      ? { history_truncated: historyTruncated }
      : {}),
    applicability_notes: [
      'Historical evidence only.',
      'Judge applicability to the current request.',
      'Current contract and Gateway policy still apply.',
    ],
  };
};

/** Deterministic per-scope storage-pressure retention.
 *
 * Current, strong, uncontested and recent rows survive before superseded,
 * weak/contested and old rows. Source observations remain authoritative, so a
 * later rebuild with a larger cap can rematerialize an evicted projection.
 */
export const retainExecutionCases = (
  rows: readonly ExecutionCase[],
  maxPerScope = EXECUTION_CASE_MAX_PER_SCOPE,
): ExecutionCase[] => {
  if (!Number.isSafeInteger(maxPerScope) || maxPerScope <= 0) {
    throw new Error('execution-case retention cap must be a positive integer');
  }
  const scopes = new Map<string, ExecutionCase[]>();
  for (const row of rows) {
    const key = `${row.governing_contract_id}\0${row.principal_key}`;
    const scoped = scopes.get(key);
    if (scoped) scoped.push(row);
    else scopes.set(key, [row]);
  }
  const retained: ExecutionCase[] = [];
  for (const scoped of scopes.values()) {
    retained.push(...scoped.sort((left, right) => {
      const leftLive = left.superseded_by === undefined ? 1 : 0;
      const rightLive = right.superseded_by === undefined ? 1 : 0;
      const leftCurrentFlow = left.flows.some((flow) => !flow.stale) ? 1 : 0;
      const rightCurrentFlow = right.flows.some((flow) => !flow.stale) ? 1 : 0;
      const leftStrength =
        left.outcome_strength.positive + left.outcome_strength.negative;
      const rightStrength =
        right.outcome_strength.positive + right.outcome_strength.negative;
      return rightLive - leftLive
        || rightCurrentFlow - leftCurrentFlow
        || Number(left.outcome_strength.contested)
          - Number(right.outcome_strength.contested)
        || rightStrength - leftStrength
        || right.last_seen_at - left.last_seen_at
        || left.case_id.localeCompare(right.case_id);
    }).slice(0, maxPerScope));
  }
  return retained.sort((left, right) =>
    left.case_key.localeCompare(right.case_key));
};

const hasContradictoryConstraint = (
  promptTerms: ReadonlySet<string>,
  shape: RequestShape,
): boolean => {
  const shapeConstraints = new Set(
    shape.constraint_facets.flatMap((facet) => {
      const canonical = canonicalServerConstraintFacet(facet);
      return canonical ? [canonical] : [];
    }),
  );
  const promptNegated = [...promptTerms].some((term) =>
    ['not', 'never', 'without', 'no'].includes(term));
  if (promptNegated !== shapeConstraints.has('negated')) return true;
  const promptDraft = promptTerms.has('draft') || promptTerms.has('compose');
  const promptSend = promptTerms.has('send') || promptTerms.has('publish');
  if (promptDraft && shapeConstraints.has('send')) return true;
  if (promptSend && shapeConstraints.has('draft_only')) return true;
  return false;
};

export interface ScoredExecutionCase {
  row: ExecutionCase;
  score: number;
}

/** Graded stage-2 relevance. Outcome strength is deliberately not read. */
export const scoreExecutionCaseRelevance = (
  prompt: string,
  row: ExecutionCase,
): number | null => {
  const terms = new Set(segmentExecutionCaseText(prompt));
  if (hasContradictoryConstraint(terms, row.request_shape)) return null;
  const stored = new Set([
    ...row.request_shape.segmented_terms,
    ...row.request_shape.surface_terms,
    ...row.request_shape.intent_facets.flatMap(segmentExecutionCaseText),
  ]);
  let overlap = 0;
  for (const term of terms) {
    if (stored.has(term)) overlap += 1;
  }
  const nerKinds = new Set(
    (extractNer(prompt)?.slots ?? []).map((slot) => slotKind(slot.kind)),
  );
  const requiredKinds = new Set(
    row.request_shape.entity_slots.map((slot) => slot.kind),
  );
  let slotFit = 0;
  for (const kind of requiredKinds) {
    if (nerKinds.has(kind)) slotFit += 1;
  }
  const intent = normalizeExecutionCaseText(
    row.request_shape.intent_facets[0] ?? '',
  );
  const phrase = normalizeExecutionCaseText(prompt).includes(intent) ? 4 : 0;
  const score = overlap * 2 + slotFit * 3 + phrase;
  return score > 0 ? score : null;
};

export const rankExecutionCaseCandidates = (
  prompt: string,
  candidates: readonly ExecutionCase[],
  minScore: number,
  limit: number,
): ScoredExecutionCase[] =>
  candidates
    .flatMap((row): ScoredExecutionCase[] => {
      if (row.flows.every((flow) => flow.stale)) return [];
      const score = scoreExecutionCaseRelevance(prompt, row);
      return score !== null && score >= minScore ? [{ row, score }] : [];
    })
    .sort((a, b) =>
      b.score - a.score
      || b.row.last_seen_at - a.row.last_seen_at
      || a.row.case_id.localeCompare(b.row.case_id))
    .slice(0, Math.max(0, limit));

export interface ClassifiedExecutionFlowCase {
  row: ExecutionCase;
  role: 'support' | 'contradiction' | 'alternative';
  material_difference?: string[];
}

// A one-observation contradiction is material for exactly the evidence that is
// both independently negative and strong enough to bypass recurrence. Derive
// this projection from the admission partition so the critic cannot silently
// reinterpret a kind (for example, admit `typed_undo` at one but decline to
// surface it as a contradiction).
const materialNegativeFamilies: ReadonlySet<CaseEvidenceKind> = new Set(
  [...strongKinds].filter((kind) => negativeKinds.has(kind)),
);

const isMaterialContradiction = (flow: ExecutionCaseFlow): boolean =>
  flow.outcome_strength.negative > flow.outcome_strength.positive
  && (
    flow.outcome_strength.negative >= EXECUTION_CASE_RECURRENCE_FLOOR
    || flow.outcome_strength.evidence_families.some((family) =>
      materialNegativeFamilies.has(family as CaseEvidenceKind))
  );

const isSuccessfulAlternative = (flow: ExecutionCaseFlow): boolean =>
  flow.outcome_strength.positive > 0
  && flow.outcome_strength.positive > flow.outcome_strength.negative;

/** Structural classification only. Callers must first scope and relevance-rank
 * the cases against the current request; this function never broadens that
 * candidate set. */
export const classifyExecutionFlowCases = (
  candidate: FlowPattern,
  cases: readonly ExecutionCase[],
): ClassifiedExecutionFlowCase[] => {
  const candidateTools = candidate.topic_tags
    .filter((tag) => tag.startsWith('tool:'))
    .map((tag) => tag.slice('tool:'.length));
  const classified: ClassifiedExecutionFlowCase[] = [];
  for (const row of cases) {
    if (row.superseded_by) continue;
    const currentFlows = row.flows.filter((flow) => !flow.stale);
    const exact = currentFlows.find((flow) =>
      JSON.stringify(flow.tools) === JSON.stringify(candidateTools));
    if (exact && exact.outcome_strength.positive > exact.outcome_strength.negative) {
      classified.push({ row, role: 'support' });
    } else if (exact && isMaterialContradiction(exact)) {
      classified.push({ row, role: 'contradiction' });
    } else if (
      currentFlows.some(isSuccessfulAlternative)
    ) {
      classified.push({
        row,
        role: 'alternative',
        material_difference: ['tool_sequence'],
      });
    }
  }
  return classified;
};

export const critiqueExecutionFlow = (
  candidate: FlowPattern,
  cases: readonly ExecutionCase[],
): FlowCritique | null => {
  const classified = classifyExecutionFlowCases(candidate, cases);
  const support: ExecutionCaseCard[] = classified
    .filter((item) => item.role === 'support')
    .map((item) => renderExecutionCaseCard(item.row));
  const contradictions: ExecutionCaseCard[] = classified
    .filter((item) => item.role === 'contradiction')
    .map((item) => renderExecutionCaseCard(item.row));
  const alternatives: FlowCritique['alternatives'] = classified
    .filter((item) => item.role === 'alternative')
    .map((item) => ({
      case: renderExecutionCaseCard(item.row),
      material_difference: item.material_difference ?? ['tool_sequence'],
    }));
  if (
    contradictions.length === 0
    && alternatives.length === 0
  ) return null;
  return {
    candidate_pattern: candidate,
    support,
    contradictions,
    alternatives,
  };
};

export interface RuntimeCompositionDiagnostics {
  corpus_roots: number;
  dispatches: number;
  /** Compiler-populated coverage over the two durable audit substrates. The
   * pure topology helper omits it because it intentionally knows no storage. */
  source_coverage?: {
    audit_activity_rows: number;
    recipe_run_rows: number;
    paired_recipe_runs: number;
    unpaired_recipe_runs: number;
  };
  route_kind_counts: Record<RuntimeCompositionRouteKind, number>;
  exact_signature_recurrence: Array<{
    signature: string;
    independent_roots: number;
  }>;
  recurring_dynamic_inline_subgraphs: Array<{
    signature: string;
    independent_roots: number;
  }>;
}

/** A26 diagnostic: arguments are absent by input type and installed recipes
 * never become dynamic packaging candidates merely because they repeat. */
export const measureRuntimeComposition = (
  dispatches: readonly RuntimeCompositionDispatch[],
): RuntimeCompositionDiagnostics => {
  const roots = new Set(dispatches.map((dispatch) => dispatch.root_request_id));
  const route_kind_counts: Record<RuntimeCompositionRouteKind, number> = {
    installed_recipe: 0,
    dynamic_ingredient: 0,
    inline_recipe: 0,
    direct_tool: 0,
  };
  const signatures = new Map<string, Set<string>>();
  const dynamic = new Map<string, Set<string>>();
  for (const dispatch of dispatches) {
    route_kind_counts[dispatch.route_kind] += 1;
    const signature = hashExecutionCaseValue({
      route_kind: dispatch.route_kind,
      tool_name: dispatch.tool_name,
      recipe_id: dispatch.recipe_id,
      recipe_hash: dispatch.recipe_hash,
      operation_ids: dispatch.operation_ids,
      dependency_ordinals: dispatch.dependency_ordinals,
    });
    const rootSet = signatures.get(signature) ?? new Set<string>();
    rootSet.add(dispatch.root_request_id);
    signatures.set(signature, rootSet);
    if (
      dispatch.route_kind === 'dynamic_ingredient'
      || dispatch.route_kind === 'inline_recipe'
    ) {
      const dynamicSet = dynamic.get(signature) ?? new Set<string>();
      dynamicSet.add(dispatch.root_request_id);
      dynamic.set(signature, dynamicSet);
    }
  }
  const rows = (source: Map<string, Set<string>>, minimum: number) =>
    [...source.entries()]
      .filter(([, rootSet]) => rootSet.size >= minimum)
      .map(([signature, rootSet]) => ({
        signature,
        independent_roots: rootSet.size,
      }))
      .sort((a, b) =>
        b.independent_roots - a.independent_roots
        || a.signature.localeCompare(b.signature));
  return {
    corpus_roots: roots.size,
    dispatches: dispatches.length,
    route_kind_counts,
    exact_signature_recurrence: rows(signatures, 2),
    recurring_dynamic_inline_subgraphs:
      rows(dynamic, EXECUTION_CASE_RECURRENCE_FLOOR),
  };
};

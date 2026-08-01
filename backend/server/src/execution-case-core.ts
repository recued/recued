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
  ERROR_MESSAGES,
  type RecipeErrorCode,
  EXECUTION_CASE_MIN_CALLS_NEGATIVE,
  EXECUTION_CASE_MIN_CALLS_POSITIVE,
  EXECUTION_CASE_MIN_DISTINCT_ROUNDS,
  nonCoreRoundDepth,
  EXECUTION_CASE_RECURRENCE_FLOOR,
  type ExecutionCase,
  type ExecutionCaseFeedbackKind,
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

/** V19 (D-219 consumer) carries `tool_sequence` onto the COMPILED FLOW, so a
 * model-bound card can render the shape of a procedure instead of inferring it.
 *
 * V15 recorded the sequence on the observation's flow PATTERN, where slice 8
 * needed it to spot a repeated tool. The card never saw it: `ExecutionCaseFlow`
 * carried only `tools`, a `topic_tags` projection that DEDUPLICATES and whose
 * order is a by-product of `Set` insertion. Those two agree on every case
 * admitted today — but only because slice 8 excludes repeat-bearing flows, which
 * is accidental agreement, and it stops holding the moment that exclusion is
 * relaxed. The renderer cannot re-derive it either: it is handed an
 * `ExecutionCase`, never the observations the pattern lives on.
 *
 * ⛔ The bump is REQUIRED, for V17's reason. Materialized cases are sealed JSON
 * and the renderer ships `row.flows` verbatim, so adding a field to the
 * interface changes only what is WRITTEN NEXT: every case compiled under V18
 * would render an ABSENT sequence — an empty shape card, which reads as "this
 * precedent used no tools" rather than as a missing field. Re-deriving is what
 * populates it.
 *
 * V18 (D-219 slice 10) excludes `abandoned` — an approval that expired
 * unanswered. Silence is not a verdict: filing it as a negative concludes
 * something about the approach from an absence, which the contracts already
 * refuse ("no later complaint is not evidence"). The bump re-derives the corpus
 * so cases already filed from a timeout stop being served as precedent.
 *
 * ⚠ Ruled NARROWLY (2026-07-28). `flow_superseded` was examined in the same
 * breath and KEPT: a later turn running a different flow is something that
 * HAPPENED in the span, not an inference from absence.
 *
 * V17 (D-219 slice 9b) drops `execution_failures` and `reported_fulfilled` from
 * the flow — the last place the system's own account of a turn reached the card.
 * The bump is REQUIRED rather than cosmetic: materialized cases are stored as
 * sealed JSON and the renderer ships `row.flows` verbatim, so a case compiled
 * under V16 keeps both fields in its stored payload and would keep presenting
 * them to the model even though the type no longer declares them. Re-deriving is
 * what actually removes them.
 *
 * V16 (D-219 slice 9a) records an observation for EVERY turn that did governed
 * work, not only for turns already carrying a signal. Recording used to require
 * `has_compilable_signal` — evidence already present, or the model calling
 * `outcome.report` — which after slices 2–4 was circular: the only admissible
 * evidence is owner-attested, the owner is asked about an OBSERVATION, and an
 * ordinary successful turn produced none. The bump re-derives the corpus under
 * the wider recording rule; it does not admit anything new on its own, since
 * every D-219 exclusion and both call floors still apply downstream.
 *
 * V15 (D-219 slice 8) records `tool_sequence` — tool names in order, repeats
 * preserved — and excludes any flow that repeats a tool. A repeat is a retry or
 * a loop, not a procedure. 16.4%% of otherwise-eligible candidates repeat.
 *
 * V14 (D-219 slice 5) records `session_id` on every observation. Nothing reads
 * it yet; it unblocks an owner-iteration filter whose value cannot be measured
 * on existing traffic. The bump re-derives the corpus so the field is populated
 * rather than empty on everything already stored.
 *
 * V13 (D-219 slice 7) raises MIN_CALLS_NEGATIVE from 1 to 2, making candidacy
 * uniform: a turn is a case candidate when the model made MORE THAN ONE governed
 * call between the request and its answer. Measured across 1148 bench turns,
 * 15.9%% qualify. The bump re-derives the corpus so single-call negatives filed
 * under the old floor stop being served.
 *
 * V12 (D-219 slice 4) removes the attribution gate slice 2 put in the compiler.
 * It suppressed the `execution_failure` derivation for env-only failures, which
 * changed no admission outcome once slice 3 excluded that kind outright — but it
 * made the stored observation claim no failure had occurred when one had. The
 * bump re-derives those observations so the record says what happened.
 *
 * V11 (D-219 slice 3) makes `execution_failure` and `gateway_denial` EXCLUSIONS
 * rather than negative evidence — an observation carrying either is not a case.
 * Together they leave no negative the system observed about itself: only
 * owner-typed kinds and `verification_fail` survive. The bump forces the
 * existing corpus to be re-derived, which is the point — otherwise every case
 * already filed from a breakage or a denial keeps being served as precedent.
 *
 * V10 (D-219 slice 2) retires `unverified_success` from `positiveKinds`, making
 * it INERT. Precedent's positive half was the system asserting its own success —
 * measured, every positive case that formed rested on it. The bump is required,
 * not bookkeeping: `ensureCurrent` skips all work while the stored version
 * matches, so without it the change would reach only NEW spans while every
 * existing case kept its self-reported positive.
 *
 * ⚠ Expect the corpus to SHRINK sharply. Until verification or owner acceptance
 * exists, no positive case forms at all — the intended interim state of D-219.
 *
 * V9 puts the failure REASON on the card. Through V8 a card recorded THAT a
 * flow failed and never WHY — measured on substrate-bench 161, where a card
 * carrying `execution_failure` for the exact action about to be repeated
 * changed nothing (baseline 24/24 and card-shown 13/13 both walked into the
 * same known-failing send). "Change the recipient" is not inferable from "this
 * flow has an execution failure". Cases compiled under V8 carry no
 * `failure_codes` and must be re-derived to gain one.
 *
 * V8 also detected a PREFLIGHT denial. V7 separated denial from failure only
 * for ACTIVITY-reason refusals; `denied` read `activity.reason`, and an owner
 * refusing a HELD run carries no reason — it arrives as
 * `recipe_error_codes: ['RECIPE_POLICY_DENIED']`. So the commonest real refusal
 * kept filing as `execution_failure`. Cases compiled under V7 still carry that.
 *
 * V7 stopped filing a DENIAL as an execution failure. A denied activity was
 * deriving both `gateway_denial` and `execution_failure` — two strong negatives
 * for one event, either of which bypasses the recurrence floor — so the card
 * could not distinguish a flow the owner DECLINED from one that BROKE. Cases
 * compiled under V6 carry that conflation and must be re-derived.
 *
 * V6 paired a publisher-qualified dispatch (`<publisher>/<slug>`) with its
 * bare-id audit row, which V5 could not do — so a FAILED installed recipe left
 * its run unpaired, `failed` stayed false, and the evidence deriver filed
 * `unverified_success`, a POSITIVE kind. Every case compiled under V5 from an
 * installed-recipe span therefore carries the OPPOSITE polarity of the truth
 * and would keep being served as precedent that a refused flow worked.
 *
 * The bump is the point, not bookkeeping: `ensureCurrent` skips all work while
 * the stored version matches and coverage is current, so without it the fix
 * would only reach NEW spans and the existing corpus would stay poisoned. A
 * changed version forces `recompileAll()`, which re-derives every observation's
 * evidence through the corrected pairing.
 *
 * V5 fell ungrounded root dissections back to the server-owned request shape
 * while keeping later-turn drift fail-closed, and finished the independent
 * evidence boundary for historical outcome axes.
 *
 * V20 adds `round_ordinals` to the compiled flow — which tool-loop round each
 * step was emitted in. ⚠ The bump here is NOT about repairing stored data: no
 * pre-V20 audit row carries a round, so recompiling recovers nothing for the
 * existing corpus and every old flow correctly gets an EMPTY array. It is about
 * the SEALED PAYLOAD: a V19 case has no such field at runtime whatever the
 * interface says, so without a bump a reader could not tell "this flow was one
 * batch" from "this flow predates the field" — the same trap V17 and V19 each
 * hit, where deleting or adding a field changed what is WRITTEN and never what
 * was already written.
 *
 * V21 adds `recipe_steps` to the compiled flow — WHICH recipe each step
 * dispatched, keyed by ordinal. Unlike V20 this bump DOES repair stored data:
 * the per-step `recipe_id` has been on the observation's flow pattern all
 * along (`pairRecipeRuns` attaches it), and only the compiled flow dropped it,
 * so recompiling recovers the identity for the whole existing corpus.
 *
 * What it fixes: `recipe.run` is the DISPATCHER, and a card rendering the bare
 * string says a recipe ran without saying which one. `loadOrigin` already
 * reached the identity because it re-reads the source observations; the
 * renderer is handed a sealed `ExecutionCase` and could not.
 *
 * ⚠ Scope is the `recipe.run` route only — 98 live invocations against 1359 by
 * SLUG, so ~7% of recipe traffic. A slug step already names its own recipe.
 * ⛔ An earlier revision of this comment claimed the route was universal; that
 * came from counting the bench's `tool.dispatch` events, which record Tier-1
 * core tools only and never saw a slug call at all. */
/* V22 (D-219) — `tool_tiers` on the flow pattern, so admission can measure
 * DEPTH IN NON-CORE ROUNDS rather than raw call count. See
 * `EXECUTION_CASE_MIN_DISTINCT_ROUNDS` for the evidence. Recompiling recovers
 * the field for the existing corpus; until a row is recompiled its empty
 * `tool_tiers` reads as "cannot judge" and it raises no new offer. */
export const EXECUTION_CASE_COMPILER_VERSION = 22;
export const EXECUTION_CASE_RECENT_WINDOW = 12;
export const EXECUTION_CASE_MAX_CARD_FLOWS = 5;
export const EXECUTION_CASE_MAX_HISTORY_RUNS = 8;
export const EXECUTION_CASE_MAX_PER_SCOPE = 256;
/** ⛔ D-219 — how long a source report + its observations live when they back NO
 *  materialized case.
 *
 *  Slice 9a made recording unconditional, so the corpus now grows on ~87% of
 *  turns while `execution_reports` and `execution_case_observations` had no age
 *  or size retention at all — the only deletion path was the privacy cascade.
 *  Cases are capped at `EXECUTION_CASE_MAX_PER_SCOPE`; their sources were not.
 *
 *  ⚠ THIS WINDOW CHANGES ONE SEMANTIC, deliberately. `EXECUTION_CASE_RECURRENCE_
 *  FLOOR` counts distinct roots sharing a request shape, and after slice 10 the
 *  only reachable kind it still gates is `flow_superseded`. With sources pruned,
 *  that floor reads "three times WITHIN THE WINDOW" rather than "three times
 *  ever". For a recency-shaped signal that is arguably the better meaning, but it
 *  is a change and not a side effect to discover later. */
export const EXECUTION_CASE_SOURCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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

/** Terms that carry no topical information, for RETRIEVAL relevance.
 *
 *  ⛔ MEASURED, not assumed. `scoreExecutionCaseRelevance` counted every shared
 *  token equally, so one shared word cleared `MIN_RELEVANCE = 2` exactly — and
 *  reading the overlap terms out of a real corpus showed what those matches were
 *  actually made of: across a 5-case corpus and 8 topically unrelated prompts,
 *  EVERY noise match was function words (`the` x18, `is` x3, `to` x3, `it` x2,
 *  `a` x2) and NOT ONE contained a content word, while every correct match
 *  carried content words. 7 of 8 unrelated prompts were shown a card. On real
 *  in-distribution turn text, 22% of shown cards had an overlap that was
 *  entirely function words.
 *
 *  ⛔ RAISING THE THRESHOLD WAS TRIED FIRST AND IS THE WRONG INSTRUMENT: noise
 *  scales with how many function words two sentences happen to share (`a` + `the`
 *  already scores 4), so a floor high enough to exclude it also demands three
 *  content words of a genuine match. Corpus-derived document frequency was tried
 *  too and is worse — over 248 real turns a 10% cut still KEEPS `with`, `you`,
 *  `that`, `in`, `it`, `have`, `are`, `from`, because frequency cannot see what
 *  linguistic knowledge encodes and a few hundred short documents cannot
 *  estimate function-word frequency. Over the CASE corpus it is hopeless: at ten
 *  cases no term appears in all ten, and at two it discards everything.
 *
 *  🔑 Filtering also RECOVERS a retrieval the noise was displacing. Ties at the
 *  floor are broken by `last_seen_at`, so three unrelated cases tied at 2 on
 *  `from`/`the` took both card slots from the case that matched on a real name.
 *
 *  ⚠ DERIVED from {@link INTENT_GROUNDING_GLUE}, never copied — one list drifts
 *  from two. The additions are the copulas, auxiliaries and interrogatives that
 *  list omits because it was tuned for intent GROUNDING, where a verb never
 *  carried the label. `is` is the one the measurement caught: *"What **is** the
 *  weather forecast for Tokyo?"* retrieved a contact-lookup case on it alone.
 *
 *  ⚠ LANGUAGE-BOUND, and the incompleteness is the point of the diagnostics
 *  counters: a term nobody listed stays "meaningful" and fires silently. The
 *  glue list covers en/de/es/fr/pt + ja/zh particles; these additions are
 *  English. An unlisted language degrades to the PREVIOUS behaviour — noise —
 *  never to a lost card, so this is a strict improvement everywhere. */
const RELEVANCE_GLUE: ReadonlySet<string> = new Set([
  ...INTENT_GROUNDING_GLUE,
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had', 'did', 'does', 'done',
  'what', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'which',
  'any', 'some', 'all', 'each', 'every',
]);

/** A term that can carry topical relevance. Exported for the diagnostics
 *  counters, which report how many cards were shown on a single such term —
 *  the weakest match that still attaches. */
export const isRelevanceBearingTerm = (term: string): boolean =>
  !RELEVANCE_GLUE.has(term);

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
  /** D-219 V20 — the tool-loop round that emitted this step. Absent on
   *  pre-V20 audit rows and on any dispatch outside the chat tool loop; the
   *  flow then carries an EMPTY `round_ordinals` rather than a guess. */
  round_index?: number;
  /** D-219 V22 — the tool's TIER (1 = core entity primitive, 2 = installed
   *  recipe, 3 = MCP passthrough). Absent when the registry does not know the
   *  tool; the flow then carries an EMPTY `tool_tiers` rather than a guess. */
  tier?: number;
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
    tool_sequence: steps.map((step) => step.tool_name),
    // V20 — positionally aligned with `tool_sequence`. EMPTY unless EVERY step
    // knows its round: a partial array would be read positionally and silently
    // mis-align, which is worse than admitting the flow predates the field.
    round_ordinals: steps.every((step) => step.round_index !== undefined)
      ? steps.map((step) => step.round_index!)
      : [],
    // V22 — ALL-OR-NOTHING, exactly like `round_ordinals` above. One unknown
    // tier makes the whole array empty, because a partial array read
    // positionally would classify the wrong step as core and silently admit (or
    // refuse) the wrong case.
    tool_tiers: steps.every((step) => step.tier !== undefined)
      ? steps.map((step) => step.tier!)
      : [],
    abstract_steps: steps.map(abstractStepFor),
    operation_ids: [...new Set(steps.flatMap((step) => step.operation_ids ?? []))],
    // V21 — ordinal-keyed and SPARSE, unlike `recipe_refs` below, which dedupes
    // and so cannot say which STEP ran what. Both are kept: `loadOrigin` wants
    // the distinct set with hashes, the card wants the per-step identity.
    recipe_steps: steps.flatMap((step, ordinal) =>
      step.recipe_id ? [{ ordinal, recipe_id: step.recipe_id }] : []),
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
  /** D-219 slice 5 — the chat session the turn belonged to.
   *
   *  Recorded so a later owner-ITERATION filter can ask "did the same owner,
   *  in the same session, re-ask within N minutes with a flow that extends this
   *  one" — the shape where the first attempt was a DRAFT and the owner simply
   *  refined the request, not a lesson about the substrate.
   *
   *  ⚠ NOTHING CONSUMES IT YET, and that is deliberate. The filter is not built
   *  because its residual is not measurable on any traffic that exists: the
   *  bench uses one session per query turn for independence, and its seed
   *  sessions are identical repeats, so it contains no owner-refinement at all.
   *  Measured anyway — 1 of 43 multi-call turns in multi-turn sessions was a
   *  strict extension, and that one was the same flow REPEATED (a retry), not a
   *  refinement. Building the filter on that would be building blind. */
  session_id: string;
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
  /** Closed-vocabulary error codes explaining WHY a run in this flow failed.
   * Codes only — never the thrown message, which interpolates values. */
  failure_codes?: string[];
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

/** D-219 slice 2 — `unverified_success` RETIRED from this set.
 *
 *  It meant "the span reached the end without a terminal error", which the
 *  original ratchet already described as *"success means no terminal error, not
 *  fulfilment — one is coincidence"*. It was nonetheless the ONLY positive that
 *  forms in practice: measured, every positive case admitted at the recurrence
 *  floor rested on it, so precedent's entire positive half was the system
 *  asserting its own success.
 *
 *  It is not moved to `negativeKinds` — it is now INERT, like `model_claim`. A
 *  kind in neither set contributes to no counter and the case never forms, which
 *  is the intent: an unwitnessed success is not evidence, in either direction.
 *
 *  ⇒ Until verification or owner acceptance exists in a corpus, NO positive case
 *  forms at all. That is the intended interim state of D-219, not a regression. */
const positiveKinds: ReadonlySet<CaseEvidenceKind> = new Set([
  'verification_pass',
  'typed_acceptance',
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

/** Everything admission requires that the OWNER cannot supply by answering:
 *  the span closed, the identity is present, the flow is real, and the
 *  observation is not one of the excluded kinds. Split out so offerability and
 *  eligibility cannot drift — a prompt that offers what admission would refuse
 *  is worse than no prompt, because the owner answers and nothing happens. */
const passesStructuralGate = (
  observation: CaseSourceObservation,
): boolean => {
  if (!observation.span_closed) return false;
  if (
    !observation.governing_contract_id
    || !observation.principal_key
    || !observation.request_shape.intent_facets[0]
    || observation.flow_pattern.exact_signature.length === 0
  ) return false;
  // ⛔ D-219 slice 3 — EXCLUSIONS. An observation carrying either of these is
  // not a case AT ALL, rather than a case with negative evidence.
  //
  // `execution_failure`: a flow that BROKE tells you nothing about whether the
  // approach was right — it never finished, so there is no lesson in it either
  // way. Filing it as a STRONG negative — which the negative floor of the day
  // allowed at a SINGLE observation — is how a bench corpus came to be
  // two-thirds stopwatch noise and how a card came to say "you tried this
  // before" about a flow that was never at fault. (⚠ History, not the current
  // rule: slice 7 raised that floor. Stated as a relationship rather than a
  // number so it cannot go stale in place a second time.)
  //
  // `gateway_denial`: firm — the owner's policy refused — but a denial is a
  // judgement about a MOMENT, to be surfaced and asked again, not a standing
  // fact about the approach. The same owner asking tomorrow may well decide
  // differently. Surfacing does not require a case.
  //
  // ⛔ D-219 slice 10 — `abandoned`: SILENCE IS NOT EVIDENCE.
  //
  // It is derived from `RECIPE_APPROVAL_TIMEOUT` — an approval that expired
  // without an answer. Filing that as a negative concludes something about the
  // APPROACH from the owner not having replied, which is the same reasoning the
  // contracts already refuse one layer up: *"approving a proposal is permission
  // to try, not acceptance of the eventual result, and no later complaint is not
  // evidence."* An unanswered ask creates no evidence; an unanswered APPROVAL
  // cannot create any either. The owner was busy, or away, or the moment passed.
  //
  // ⚠ Ruled 2026-07-28, and NARROWLY: `flow_superseded` was examined alongside it
  // and KEPT. A later turn running a different flow is something that HAPPENED in
  // the span, not an inference from absence — the model tried A, then tried B,
  // and both are recorded. Only the argument-from-silence is refused here.
  //
  // ⚠ SLICE 3's CLAIM ABOVE WAS TOO BROAD as written: `flow_superseded` and
  // `abandoned` both survived it, so system-observed negatives did NOT all go.
  // With `abandoned` excluded, `flow_superseded` is the one that remains, and it
  // remains deliberately.
  if (
    observation.evidence_kinds.includes('execution_failure')
    || observation.evidence_kinds.includes('gateway_denial')
    || observation.evidence_kinds.includes('abandoned')
  ) return false;
  // ⛔ D-219 slice 8 — A REPEATED TOOL IS A RETRY, NOT A PROCEDURE.
  //
  // `[send, send]`, `[search, send, search, send]`, `[search, write] × 5`: the
  // model went round again, and there is nothing in that worth short-circuiting.
  // Measured on bench traffic, 16.4% of otherwise-eligible candidates repeat a
  // tool, and every observed shape was floundering rather than discovery.
  //
  // ⚠ NO "UNLESS STRONG EVIDENCE" ESCAPE, deliberately. Six of the nine
  // surviving evidence kinds are strong and they are the only ones that admit in
  // practice, so the exception would fire on essentially every real case and
  // neutralise the rule. It also could not discriminate the case worth
  // protecting: a legitimate `[send, send]` to two different recipients looks
  // identical to a double-send retry, because the difference is in ARGUMENTS the
  // observation does not record. Excluding is the conservative direction — a
  // missing case costs nothing, a case that teaches "send it twice" does not.
  const sequence = observation.flow_pattern.tool_sequence ?? [];
  const seen = new Set<string>();
  for (const tool of sequence) {
    if (seen.has(tool)) return false;
    seen.add(tool);
  }
  return true;
};

const isStructurallyEligible = (
  observation: CaseSourceObservation,
): boolean => {
  if (!passesStructuralGate(observation)) return false;
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

/** D-219 slice 6 — WHICH VERDICTS, IF THE OWNER GAVE ONE, WOULD ACTUALLY ADMIT.
 *
 *  After slices 2–4 the substrate admits almost nothing on its own: an
 *  unwitnessed success is inert, a breakage and a denial are excluded, and the
 *  only remaining signals are owner-typed or verified. That is intended — and it
 *  leaves the corpus empty until someone ASKS. The rpc to record an answer
 *  (`chat.execution.feedback`) has existed all along; nothing has ever offered
 *  the choice.
 *
 *  This returns the verdicts that would genuinely file, not a boolean, because
 *  the answers are not interchangeable: `accepted` is additionally refused when
 *  the recorded outcome CONTRADICTS it (see the exclusion list below), so a turn
 *  can be correctable while acceptance would be a lie. Offering a button that
 *  silently does nothing is exactly the assurance-shaped non-assurance this
 *  substrate is supposed to avoid: the owner answers, believes they have taught
 *  it something, and nothing was learned.
 *
 *  ⚠ This paragraph used to justify the list by a POLARITY SPLIT in the call
 *  floors ("2 against 1 — so a one-call turn can be corrected but cannot be
 *  accepted"). Slice 7 made the floors uniform and that sentence became FALSE in
 *  place while still reading as a live rule: under equal floors a one-call turn
 *  can be NEITHER. ⛔ Do not restate either floor's VALUE here — read the
 *  constants. A comment that names a number goes stale silently; one that names
 *  a relationship does not.
 *
 *  ⛔ Deliberately NOT offered:
 *    · an excluded observation (breakage, denial) — nothing to learn either way;
 *    · a turn whose span never closed, or that carries no real flow;
 *    · `accepted`, when the recorded outcome contradicts it (dismissed, expired,
 *      in-doubt, skipped, not-executed) — the same guard admission applies, so
 *      the prompt cannot invite an attestation the compiler would then refuse.
 *
 *  Pure, like everything else in this module: no clock, no storage, no policy. */
export const executionCaseOfferableVerdicts = (
  observation: CaseSourceObservation,
): ExecutionCaseFeedbackKind[] => {
  if (!passesStructuralGate(observation)) return [];
  // ⛔⛔ DEPTH GATE — the floor that call count could not express. A flow whose
  // non-core depth is under `EXECUTION_CASE_MIN_DISTINCT_ROUNDS` is work the
  // model already does unprompted: the prefetch absorbs the entity layer and
  // batching absorbs the width, so a card over it teaches nothing and measurably
  // HARMS (single-round collapse 31/61 vs 17/63, p = 0.0096; fabrication 5.8x
  // odds). Runs BEFORE the call floors, which now only refuse a vacuous flow.
  //
  // ⚠ FAIL CLOSED. `nonCoreRoundDepth` returns 0 when the positional arrays are
  // missing or misaligned — a pre-V22 row, or a dispatch outside the chat tool
  // loop — and 0 refuses. An admission gate that cannot judge must not admit;
  // recompiling the row recovers the fields and the offer returns.
  if (nonCoreRoundDepth(observation.flow_pattern)
    < EXECUTION_CASE_MIN_DISTINCT_ROUNDS) return [];
  const calls = observation.substantive_call_count;
  const verdicts: ExecutionCaseFeedbackKind[] = [];
  const positiveContradicted =
    observation.outcome.authorization === 'dismissed'
    || observation.outcome.authorization === 'expired'
    || observation.outcome.execution === 'in_doubt'
    || observation.outcome.execution === 'skipped'
    || observation.outcome.execution === 'not_executed';
  if (calls >= EXECUTION_CASE_MIN_CALLS_POSITIVE && !positiveContradicted) {
    verdicts.push('accepted');
  }
  if (calls >= EXECUTION_CASE_MIN_CALLS_NEGATIVE) {
    verdicts.push('corrected', 'rejected', 'undone');
  }
  return verdicts;
};

const emptyFlow = (
  observation: CaseSourceObservation,
): ExecutionCaseFlow => ({
  tools: observation.flow_pattern.exact_signature.length > 0
    ? observation.flow_pattern.topic_tags
        .filter((tag) => tag.startsWith('tool:'))
        .map((tag) => tag.slice('tool:'.length))
    : [],
  // ⚠ Copied, not aliased: `tool_sequence` is a mutable array on a shared
  // pattern object, and a compiled flow must not hand a reference back into
  // the observation it was derived from.
  tool_sequence: [...(observation.flow_pattern.tool_sequence ?? [])],
  // ⚠ Copied for the same reason, and read `?? []` for V19's reason: a case
  // compiled before V20 has no such field AT RUNTIME whatever the interface
  // says, because materialized cases are sealed JSON.
  round_ordinals: [...(observation.flow_pattern.round_ordinals ?? [])],
  // ⚠ Copied and read `?? []` for the same two reasons as the two fields above:
  // a shared pattern object must not be aliased into a compiled flow, and a
  // case compiled before V21 has no such field AT RUNTIME whatever the
  // interface says, because materialized cases are sealed JSON.
  recipe_steps: (observation.flow_pattern.recipe_steps ?? [])
    .map((step) => ({ ...step })),
  flow_basis: observation.flow_basis,
  proposed: 0,
  accepted: 0,
  declined: 0,
  executed: 0,
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
  // ⚠ NOT re-derived from `flow.tools`. That projection deduplicates and gets
  // its order from a Set, which is why `tool_sequence` exists; deriving one from
  // the other would reinstate exactly the loss the field was added to end.
  flow.tool_sequence = [...(first.flow_pattern.tool_sequence ?? [])];
  const failureCodes = new Set<string>();
  for (const observation of observations) {
    for (const code of observation.failure_codes ?? []) failureCodes.add(code);
    if (observation.proposed) flow.proposed += 1;
    if (observation.plan_accepted) flow.accepted += 1;
    if (observation.plan_declined) flow.declined += 1;
    if (observation.executed) flow.executed += 1;
    flow.first_seen_at = Math.min(flow.first_seen_at, observation.observed_at);
    flow.last_seen_at = Math.max(flow.last_seen_at, observation.observed_at);
  }
  for (const observation of independentOutcomeObservations) {
    const kinds = new Set(observation.evidence_kinds);
    // ⛔ D-219 slice 9b — the two SELF-REPORT tallies are gone from the flow.
    // `execution_failure` is an exclusion (slice 3), so its counter was
    // structurally always 0; `model_claim === 'fulfilled'` is the model's own
    // account, which slice 2 already made inert as evidence. Only what the owner
    // concluded and what a check found are counted below.
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
  // Sorted so a rebuild of the same sources is byte-identical — this module is
  // deterministic by contract and a Set's insertion order is not a guarantee.
  if (failureCodes.size > 0) flow.failure_codes = [...failureCodes].sort();
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

/** How strongly a flow is attested, net. Exported because the D-219 precedent
 *  renderer orders flows the same way and a second copy of the expression is
 *  how the two would silently disagree about which flow leads a card. */
export const executionCaseFlowWeight = (flow: ExecutionCaseFlow): number =>
  flow.outcome_strength.positive - flow.outcome_strength.negative;

const flowWeight = executionCaseFlowWeight;

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
      // ⛔ WITHOUT THIS, A DECLINE IS EFFECTIVELY INVISIBLE. Measured on a real
      // card: every legible counter reads `declined: 0` — that counter tracks
      // approval-PLAN declines, not gateway denials, so it is actively WRONG
      // here — `recent` carries no authorization axis, and the only trace of
      // the refusal is the literal string `gateway_denial` buried in
      // `outcome_strength.evidence_families`.
      //
      // That matters because a decline is the one kind of evidence a model
      // CANNOT act on by picking a different tool. It is only usable by
      // reasoning, so it has to be legible as prose, not inferable from a
      // family list. The reasoning bench measured the consequence: responses
      // were VERBATIM IDENTICAL with and without a denial card.
      //
      // Phrased as a question, deliberately. A decline is a judgement about a
      // MOMENT, not a standing rule — the same owner asking again may well
      // decide differently, and the card must not read as a prohibition. It
      // sits alongside "Gateway policy still apply", which keeps enforcement
      // where it belongs.
      // ⛔ THE DIAGNOSIS. Measured on substrate-bench 161: a card recording
      // that this exact flow had already FAILED changed nothing — baseline
      // 24/24 and card-shown 13/13 both walked into the same known-failing
      // action. The card said THAT it failed and never WHY, and no model can
      // infer "change the recipient" from "this flow has an execution
      // failure".
      //
      // ⚠ SCOPE THIS PRECISELY — the first reading of that run was wrong, and
      // the wrong version ("precedent records outcomes, not diagnoses") sounds
      // like a design choice this layer made. It was not. The reason was
      // missing because the ENGINE erased it: `step-runner.ts` allow-listed
      // four carriers and coded every other ingredient throw `NETWORK_ERROR`,
      // so `MAIL_SEND_SELF_LOOP_TO` never reached the compiler at all. The
      // codes flow now, and this renderer was already correct — it had nothing
      // to render. What 161 actually measured is narrower and still true: a
      // card recording an UNEXPLAINED failure changes nothing.
      //
      // ⚠ `ERROR_MESSAGES[code]`, never the thrown message. The thrown text
      // interpolates values — MAIL_SEND_SELF_LOOP_TO renders as "...send mail
      // to itself (someone@example.com)..." — so shipping it would put a
      // recipient address on a model-bound card. The contracts table is static
      // and carries the same remedy verbatim.
      ...[...new Set(
        row.flows.flatMap((flow) => flow.failure_codes ?? []),
      )].sort().flatMap((code) => {
        const reason = ERROR_MESSAGES[code as RecipeErrorCode];
        return reason ? [`A previous attempt failed — ${reason}`] : [];
      }),
      ...(row.outcome_strength.evidence_families.includes('gateway_denial')
        ? [
            'You previously declined a request like this. '
            + 'Consider whether to proceed, adjust the approach, or ask.',
          ]
        : []),
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
  // ⛔ Glue does not count. See {@link RELEVANCE_GLUE} — every measured noise
  // match was made of it, and nothing else was.
  let overlap = 0;
  for (const term of terms) {
    if (stored.has(term) && isRelevanceBearingTerm(term)) overlap += 1;
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
  // ⛔ SLOT FIT COMPARES KINDS, NEVER VALUES — so on its own it says only "both
  // texts contain an email address", which is not evidence of relevance.
  // Measured: a stored "Email orla@cardglen.example regarding quarterly renewal
  // paperwork" scored 5 against "Ping wren@elsewhere.example about tomorrow
  // morning football" — and the SAME probe with the address removed scored
  // null, so the address was the whole match. At 3 points it cleared the floor
  // of 2 by itself, with no lexical overlap at all.
  //
  // It stays as a RANKING bonus, because two requests that both name a date or
  // an address genuinely are more alike than two that do not — but it can no
  // longer ATTACH a card on its own. Value-aware matching would be the real
  // fix and is not available here: `entity_slots` stores `{role, kind}` and
  // discards the value, and putting values back into the shape would re-key
  // every stored case (the shape feeds `requestShapeHash`) as well as reopening
  // the boundary acceptance #47 closed.
  const slotBonus = overlap > 0 ? slotFit : 0;
  const intent = normalizeExecutionCaseText(
    row.request_shape.intent_facets[0] ?? '',
  );
  const phrase = normalizeExecutionCaseText(prompt).includes(intent) ? 4 : 0;
  const score = overlap * 2 + slotBonus * 3 + phrase;
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

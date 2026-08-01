/** D-219 — the corpus gets a READER.
 *
 *  Everything before this file records precedent: a plain turn is observed, the
 *  owner is asked what they concluded, and their answer files a case. Nothing
 *  read the result. The two model-facing surfaces that existed
 *  (`execution-case-retrieval`'s request augmentation and
 *  `execution-case-critic`'s proposal critique) are both gated on a complete
 *  pre-registered experiment definition — 16 required env fields, fail-closed —
 *  so on an ordinary self-hosted server no case ever reached a model or a
 *  screen. Answering "was that right?" changed nothing the owner could observe.
 *
 *  This is the ordinary path: no experiment, no assignment, no intervention
 *  record. Retrieve, render SHAPE ONLY, put it in the per-turn tail.
 *
 *  ⛔ **NOT a widening of the experiment config.** That framework is
 *  pre-registration machinery — arms, fingerprints, decision rules — and bending
 *  it into a feature flag is the same defect the offer switch already refused
 *  when it took a `prefs` knob instead of an env var. This surface is composed
 *  when no experiment is, and not composed when one is.
 *
 *  ⛔ **AND IT IS NOT A SECOND ARM.** If a pre-registration IS running, this
 *  path stays dark: a control arm that received precedent from somewhere else is
 *  not a control arm, and the measurement would be silently void.
 */

import {
  EXECUTION_CASE_CARD_NOTICE,
  type CaseCandidateSource,
  type ExecutionCase,
  type ExecutionCaseFlow,
  type ExecutionCaseLearnedEntry,
  type ExecutionCasePrecedentCard,
  type ExecutionCasePrecedentContext,
  type ExecutionSource,
} from '@recued/contracts';
import type { Middleware, TurnContext } from '@recued/middleware';

import {
  alignSkeleton,
  isSkeletonMatch,
  SKELETON_MAX_HOLES,
} from './execution-case-skeleton.js';
import {
  executionCaseFlowWeight,
  isRelevanceBearingTerm,
  rankExecutionCaseCandidates,
  segmentExecutionCaseText,
} from './execution-case-core.js';
// ⛔ ONE consulted-keys Set, shared with the experiment surface. The compiler
// reads a single state key when it closes the report, so A31 has to hold
// whichever surface showed the card; a second key here would leave one of the
// two surfaces able to reinforce the case it had just been believed on.
import {
  EXECUTION_CASE_CONSULTED_KEYS_STATE_KEY,
} from './execution-case-retrieval.js';
import type {
  ExecutionCaseStore,
} from './storage/execution-case-store.js';
import type {
  ExecutionSpanAnchorStore,
} from './storage/execution-span-anchor-store.js';

export const EXECUTION_CASE_PRECEDENT_MIDDLEWARE_ID = 'd219-precedent';
export const EXECUTION_CASE_PRECEDENT_STATE_KEY = 'd219:precedent:context';

/** ⚠ Deliberately far below the experiment surface's `EXECUTION_CASE_MAX_
 *  EVIDENCE = 5` and its 24 KB block. That ceiling was sized for a bounded
 *  study; this one is paid on EVERY chat turn, and the arc's own measurement is
 *  that a bigger card bought nothing — bench 161 showed a rich card carrying
 *  `tools`, counters and evidence families changing no behaviour at all. Two
 *  short cards is the smallest thing that can be legible AND carry a
 *  counter-example alongside a precedent. */
export const EXECUTION_CASE_PRECEDENT_MAX_CARDS = 2;
/** Per card. One flow is the procedure; the second is what makes a contradiction
 *  visible ("that route was rejected, this one accepted"). */
export const EXECUTION_CASE_PRECEDENT_MAX_FLOWS = 2;
export const EXECUTION_CASE_PRECEDENT_MAX_INTENTS = 3;
/** Hard ceiling on the whole block. Advisory context must never turn a valid
 *  request into a context-length failure, and on this path the cost recurs. */
export const EXECUTION_CASE_PRECEDENT_MAX_BYTES = 2 * 1024;
/** Stage-2 relevance floor. The experiment surface takes this from its
 *  pre-registration; the ordinary path has no such document, so it is a
 *  constant. Set at the bottom of `scoreExecutionCaseRelevance`'s scale (one
 *  overlapping term scores 2) — recall-oriented, because a card the model judges
 *  inapplicable costs a few tokens while a missed one costs the whole feature.
 *  ⚠ Not measured against live traffic; the corpus to measure it on does not
 *  exist until this ships. */
export const EXECUTION_CASE_PRECEDENT_MIN_RELEVANCE = 2;

/** What a turn's retrieval did, reported once per turn that reached ranking.
 *
 *  ⛔ THIS EXISTS BECAUSE THE FILTER IS LANGUAGE-BOUND AND FAILS OPEN.
 *  `RELEVANCE_GLUE` covers en/de/es/fr/pt + ja/zh particles; a deployment
 *  writing in Korean, Arabic or Hindi gets the PREVIOUS behaviour — function
 *  words counting as topical evidence — with nothing failing and nobody
 *  noticing. A rate nobody can see is a rate nobody will fix, so the residual
 *  is surfaced rather than assumed away.
 *
 *  `single_term_cards` is the weakest match that still attaches: one shared
 *  relevance-bearing term. On the bench's own traffic that class is dominated by
 *  DOMAIN vocabulary (`email` in 23% of real turns, `account` 14%, `find` 14%),
 *  which no stopword list can remove and which lexical matching cannot
 *  distinguish from genuine relevance. It is the honest ceiling of this
 *  approach, so it is counted rather than claimed to be solved. */
export interface ExecutionCasePrecedentObservation {
  /** Ranking ran — an anchored, in-scope owner turn with candidate rows. */
  ranked: number;
  /** At least one card was composed into the packet. */
  attached: number;
  /** Cards whose overlap with the turn was a SINGLE relevance-bearing term. */
  single_term_cards: number;
}

export interface ExecutionCasePrecedentDeps {
  anchorStore: ExecutionSpanAnchorStore;
  caseStore: ExecutionCaseStore;
  candidateSource: CaseCandidateSource;
  ensureCasesCurrent?: () => Promise<void>;
  /** Absent → no counting, exactly as before. Never fails the turn. */
  observe?: (delta: ExecutionCasePrecedentObservation) => void;
  /** D-219 — which of these tokens name someone in the OWNER's contact index.
   *
   *  ⛔ THE PERMISSION PREDICATE FOR SKELETON MATCHING, and the reason it can be
   *  deterministic. Alignment finds WHERE two requests differ; it cannot say
   *  whether that difference is a value or a verb — permitting any single
   *  substitution accepted `delete the invoice` ~ `send the invoice`. Contact
   *  membership types a hole positively, in any language, with no NER (so none
   *  of its framing fragility: "Who is our Cardglen contact?" extracts nothing).
   *
   *  ⚠ BATCHED ON PURPOSE. Called ONCE per turn with every hole token across
   *  every candidate — at most `SKELETON_MAX_HOLES` x candidates, so ~32 — and
   *  never once per hole, which would be 32 index reads on a path that already
   *  runs before the model call on every owner chat turn.
   *
   *  Absent ⇒ no skeleton signal at all. The surface degrades to plain lexical
   *  ranking rather than half-working. */
  knownContactTokens?: (
    tokens: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  resolveScope(input: {
    session_id: string;
    turn_id: string;
    source?: ExecutionSource;
  }): {
    governing_contract_id: string;
    principal_key: string;
    active: boolean;
  };
}

/** What the owner concluded, or what a check found — in the reader's language.
 *
 *  ⛔ EVERY LINE HERE IS SOMEONE ELSE'S ASSERTION. That is the whole D-219
 *  principle: precedent records what the owner concluded, never what the system
 *  observed about itself. There is deliberately no line for "it seemed to work"
 *  (`unverified_success`, inert since slice 2) or for the model's own claim
 *  (`model_claim`, inert and now unreadable).
 *
 *  ⚠ Counts, not adjectives. "you confirmed this twice" is a fact the model can
 *  weigh; "strong evidence" is this layer doing the weighing for it. */
const outcomeProse = (flow: ExecutionCaseFlow): string[] => {
  const lines: string[] = [];
  const say = (count: number, sentence: string): void => {
    if (count <= 0) return;
    lines.push(count === 1 ? sentence : `${sentence} (${count} times)`);
  };
  // Positives first, then negatives: the order a reader would want, and it never
  // decides anything — both are always present when both occurred.
  say(flow.user_acceptances, 'You confirmed this was right.');
  say(flow.verified_successes, 'A check confirmed it worked.');
  say(flow.user_corrections, 'You corrected the result.');
  say(flow.user_rejections, 'You rejected the result.');
  say(flow.user_undos, 'You undid the result.');
  say(flow.verification_failures, 'A check found it had not worked.');
  // The one system-observed kind D-219 kept, and it is kept because it is an
  // EVENT rather than an inference from absence: a later turn of the same
  // request ran a different route. Rendered as the ambiguity it is — slice 10
  // reaffirmed that correction and extension are indistinguishable here — so the
  // model weighs it rather than reading it as a verdict.
  if (flow.outcome_strength.evidence_families.includes('flow_superseded')) {
    lines.push(
      'A later attempt at the same request took a different route; '
      + 'whether that was a correction or a continuation is not recorded.',
    );
  }
  return lines;
};

/** ⛔ A FLOW WITH NOTHING TO SAY IS DROPPED, NOT RENDERED SILENT.
 *
 *  A bare tool sequence reads as a recommendation. Render one with no
 *  attestation and the route the owner REJECTED arrives looking exactly like the
 *  one they accepted — the substrate would be teaching the mistake it recorded.
 *  Reachable for a real reason, not just defensively: A31 excludes an
 *  observation that CONSUMED this case from reinforcing it, so a flow whose only
 *  evidence came from a turn that was shown this very card has zero counters. */
/** The row flows that are ELIGIBLE to be shown, in the order they are shown.
 *
 *  ⛔ Exported because `loadOrigin` has to resolve the SAME flow the owner and
 *  the model are looking at. It used to re-derive its target from the card's
 *  `tool_sequence` and then take the lexically-first source report's first
 *  observation — so the moment a case had two flows those two disagreed, and a
 *  draft was built from one flow's request beside another's recipe. Sharing the
 *  ordering is what makes them agree by construction rather than by luck.
 *
 *  ⚠ Returns the ROW flow, not the card flow: the card is shape-only and drops
 *  `flow_basis`, which the origin join needs. */
export const eligiblePrecedentRowFlows = (
  row: ExecutionCase,
): ExecutionCaseFlow[] =>
  [...row.flows]
    // ⛔ Stale means the exact pattern was superseded OR a tool it names is no
    // longer available. Proposing a procedure through a tool that no longer
    // exists is worse than proposing nothing.
    //
    // ⛔ `?? []` is NOT defensive noise, and the type saying `string[]` is not
    // an argument against it. Materialized cases are SEALED JSON: a case
    // compiled under V18 has no `tool_sequence` in its stored payload at all,
    // and adding the field to the interface changed only what is written NEXT.
    // Reading `.length` off it directly throws — which this module's seam guard
    // would then swallow into a silent no-card, hiding an upgrade that had not
    // finished re-deriving. Dropping the flow is the honest outcome.
    .filter((flow) => !flow.stale && (flow.tool_sequence ?? []).length > 0)
    .sort((a, b) =>
      executionCaseFlowWeight(b) - executionCaseFlowWeight(a)
      || b.last_seen_at - a.last_seen_at);

/** V21 — name the recipe a step dispatched, instead of the dispatcher.
 *
 *  ⛔ `recipe.run` is a DISPATCHER. A card rendering the bare string reports
 *  that a recipe ran without reporting which one — the one thing about that
 *  step worth learning. Measured from what the model itself emits, the
 *  `recipe.run` route is 98 live invocations against 1359 by SLUG — ~7% of
 *  recipe traffic. The slug route already names its recipe in `tool_sequence`
 *  and the suppression below correctly leaves it alone; this closes the
 *  remaining route rather than all of them.
 *
 *  ⛔ Keyed by ORDINAL, never matched by name against the deduped `recipe_refs`
 *  — a flow can pair one dispatch and leave another unpaired, and a single
 *  deduped ref then attaches to whichever step you guess. Naming the WRONG
 *  recipe is worse than naming none.
 *
 *  ⚠ Applied to any step that carries an identity, not just `recipe.run`. A
 *  Tier-2 slug step already names its recipe, so the annotation is a no-op
 *  there — special-casing the tool NAME would make this silently wrong the day
 *  a third dispatch route appears. `?? []` for the sealed-JSON reason: a case
 *  compiled before V21 has no such field at runtime, and renders as it does
 *  today. */
const annotateRecipeSteps = (flow: ExecutionCaseFlow): string[] => {
  const byOrdinal = new Map(
    (flow.recipe_steps ?? []).map((step) => [step.ordinal, step.recipe_id]),
  );
  return flow.tool_sequence.map((tool, ordinal) => {
    const recipeId = byOrdinal.get(ordinal);
    // ⚠ EXACT, or exact after the `<publisher>/` prefix — NOT a substring
    // test. `'recipe.run'.includes('run')` is true, so a recipe named `run`
    // would suppress its own annotation and the card would silently go back to
    // naming the dispatcher.
    const alreadyNamed = tool === recipeId || tool.endsWith(`/${recipeId}`);
    return recipeId === undefined || alreadyNamed
      ? tool
      : `${tool} (${recipeId})`;
  });
};

const precedentFlows = (
  row: ExecutionCase,
): ExecutionCasePrecedentCard['flows'] =>
  eligiblePrecedentRowFlows(row)
    .flatMap((flow) => {
      const outcome = outcomeProse(flow);
      return outcome.length === 0
        ? []
        : [{
          // ⛔ DEDUPED AND SORTED, not sequenced. The card names WHICH ops a
          // request may need, so a tool repeated across rounds is one candidate,
          // and the sort keeps a rebuild byte-identical.
          //
          // ⚠ This REPLACED a `groupStepsByRound` renderer committed hours
          // earlier (74ceb7479), which joined same-round steps with ` + ` so the
          // card would stop asserting an order it never observed. That was the
          // right fix to the wrong artifact: the measurement that followed showed
          // the card should not describe a RUN at all. Both the helper and its
          // tests are deleted rather than left exported-but-uncalled — a helper
          // nothing calls still passes its own tests, which is how dead code
          // reads as covered.
          tools_that_may_be_needed:
            [...new Set(annotateRecipeSteps(flow))].sort(),
          outcome,
        }];
    })
    .slice(0, EXECUTION_CASE_PRECEDENT_MAX_FLOWS);

export const renderExecutionCasePrecedentCard = (
  row: ExecutionCase,
): ExecutionCasePrecedentCard | undefined => {
  const flows = precedentFlows(row);
  if (flows.length === 0) return undefined;
  return {
    request: row.request_shape.intent_facets
      .slice(0, EXECUTION_CASE_PRECEDENT_MAX_INTENTS),
    flows,
  };
};

/** D-219 item 2 — the OWNER's view of one learned case.
 *
 *  ⛔ **Built from `precedentFlows`, the same function the model-bound card
 *  uses.** Writing a second renderer here would be the obvious shape and the
 *  wrong one: this page exists to answer *"what does it know about me"*, and an
 *  audit surface maintained separately from the thing it audits drifts from it
 *  silently — the first time either renderer changes, the owner is reading a
 *  faithful-looking account of a corpus that no longer matches.
 *
 *  ⚠ An entry is returned even when nothing renders. A case whose flows are all
 *  stale or unattested is REAL and retained; it simply reaches no model. Hiding
 *  it would make the page under-report what is stored, which is the opposite of
 *  what it is for — so it is listed with `shown_to_model: false` instead. */
export const executionCaseLearnedEntry = (
  row: ExecutionCase,
  /** Recipes already authored from this case, looked up by the caller on
   *  `row.case_key`. ⚠ Optional so every existing caller — the draft prompt
   *  builder among them — keeps working unchanged and simply carries no
   *  annotation. */
  authored?: ExecutionCaseLearnedEntry['authored'],
): ExecutionCaseLearnedEntry => {
  const flows = precedentFlows(row);
  return {
    case_id: row.case_id,
    request: row.request_shape.intent_facets
      .slice(0, EXECUTION_CASE_PRECEDENT_MAX_INTENTS),
    flows,
    shown_to_model: flows.length > 0,
    request_observations: row.request_observations,
    last_seen_at: row.last_seen_at,
    ...(authored !== undefined && authored.length > 0 ? { authored } : {}),
  };
};

const precedentContext = (
  cards: ExecutionCasePrecedentCard[],
): ExecutionCasePrecedentContext => ({
  // ⛔ By reference. See the constant's own header: a fresh literal passes every
  // substring assertion and is the exact way the three copies came to differ.
  notice: EXECUTION_CASE_CARD_NOTICE,
  cards,
});

const precedentFits = (context: ExecutionCasePrecedentContext): boolean =>
  Buffer.byteLength(JSON.stringify(context), 'utf8')
    <= EXECUTION_CASE_PRECEDENT_MAX_BYTES;

export const readExecutionCasePrecedentContext = (
  state: Map<string, unknown> | undefined,
): ExecutionCasePrecedentContext | undefined => {
  const value = state?.get(EXECUTION_CASE_PRECEDENT_STATE_KEY);
  if (
    value === null
    || typeof value !== 'object'
    || !Array.isArray(
      (value as Partial<ExecutionCasePrecedentContext>).cards,
    )
  ) return undefined;
  return value as ExecutionCasePrecedentContext;
};

const latestUserText = (ctx: TurnContext): string => {
  for (let index = ctx.history.length - 1; index >= 0; index -= 1) {
    const entry = ctx.history[index];
    if (entry?.role === 'user') return entry.text;
  }
  return '';
};

/** The before-turn hook. Runs on every owner chat turn once composed.
 *
 *  ⛔ **IT CANNOT THROW.** The framework does not swallow a middleware throw —
 *  the finalizer carries its own try/catch for exactly this reason — and unlike
 *  the experiment surface this one is not dark by default. Retrieval is advisory
 *  end to end (#13/#23): a locked vault, a corrupt row or a slow scan must cost
 *  the card, never the turn. The guard is at the SEAM rather than asserted in a
 *  doc comment, which is the shape the argument-capture hook was caught in.
 */
/** How many relevance-bearing terms a prompt shares with a stored shape.
 *
 *  ⚠ Mirrors `scoreExecutionCaseRelevance`'s overlap half deliberately rather
 *  than being returned from it: the scorer is a pure `(prompt, row) => number`
 *  used by ranking, and widening its return type to carry diagnostics would put
 *  a reporting concern in the hot path every candidate goes through. The shared
 *  part that must not drift — which terms count — IS shared, via
 *  `isRelevanceBearingTerm`. */
const relevanceBearingOverlap = (
  prompt: string,
  row: ExecutionCase,
): number => {
  const stored = new Set([
    ...row.request_shape.segmented_terms,
    ...row.request_shape.surface_terms,
    ...row.request_shape.intent_facets.flatMap(segmentExecutionCaseText),
  ]);
  let count = 0;
  for (const term of new Set(segmentExecutionCaseText(prompt))) {
    if (stored.has(term) && isRelevanceBearingTerm(term)) count += 1;
  }
  return count;
};

/** Move exact-shape matches to the front, then cut to the card budget.
 *
 *  ⛔ A RANKING SIGNAL, NEVER AN ADMISSION ONE. A skeleton match already clears
 *  the relevance floor by construction — every non-hole token is identical — so
 *  this changes WHICH cases are shown, never WHETHER one is. Letting it admit
 *  would hand a structural rule the power to put a card on a turn lexical
 *  relevance had rejected.
 *
 *  ⚠ Inert without a stored prompt or a contact index: no promotion, plain
 *  lexical order, exactly as before.
 *
 *  ⚠ ONE batched index read per turn. Hole tokens are collected across every
 *  candidate first; asking per hole would be ~32 reads before the model call. */
/** ⚠ Exported for coverage: promotion only changes anything with more
 *  candidates than card slots, and driving that through the middleware needs a
 *  fixture larger than the property under test. */
export const promoteSkeletonMatchesForTest = async (
  ranked: ReadonlyArray<{ row: ExecutionCase; score: number }>,
  prompt: string,
  storedPrompts: Record<string, string> | undefined,
  knownContactTokens: ExecutionCasePrecedentDeps['knownContactTokens'],
): Promise<Array<{ row: ExecutionCase; score: number }>> =>
  promoteSkeletonMatches(ranked, prompt, storedPrompts, knownContactTokens);

const promoteSkeletonMatches = async (
  ranked: ReadonlyArray<{ row: ExecutionCase; score: number }>,
  prompt: string,
  storedPrompts: Record<string, string> | undefined,
  knownContactTokens: ExecutionCasePrecedentDeps['knownContactTokens'],
): Promise<Array<{ row: ExecutionCase; score: number }>> => {
  const budget = ranked.slice(0, EXECUTION_CASE_PRECEDENT_MAX_CARDS);
  if (!storedPrompts || !knownContactTokens || ranked.length === 0) return budget;
  const promptTerms = segmentExecutionCaseText(prompt);
  // Pass 1 — alignment only, which is free. Collect the holes worth typing.
  const aligned: Array<{
    row: ExecutionCase;
    score: number;
    holes: ReadonlyArray<readonly [string, string]>;
    storedTerms: string[];
  }> = [];
  const tokens = new Set<string>();
  for (const item of ranked) {
    const stored = storedPrompts[item.row.case_id];
    if (stored === undefined) continue;
    const storedTerms = segmentExecutionCaseText(stored);
    const { holes, shapeDrift } = alignSkeleton(storedTerms, promptTerms);
    if (shapeDrift > 0 || holes.length > SKELETON_MAX_HOLES) continue;
    for (const [a, b] of holes) { tokens.add(a); tokens.add(b); }
    aligned.push({ ...item, holes, storedTerms });
  }
  if (aligned.length === 0) return budget;
  let known: ReadonlySet<string>;
  try {
    known = await knownContactTokens([...tokens]);
  } catch {
    // A failed index read is not a reason to lose the turn's card.
    return budget;
  }
  const isMatch = (item: (typeof aligned)[number]): boolean => isSkeletonMatch({
    promptTerms,
    storedTerms: item.storedTerms,
    // The stored text is the WHOLE request here — it came from the candidate
    // scan, not from the eight-term intent facet.
    storedIsComplete: true,
    isValueHole: ([a, b]) => known.has(a) && known.has(b),
  });
  const matched = new Set(aligned.filter(isMatch).map((item) => item.row.case_id));
  if (matched.size === 0) return budget;
  return [...ranked]
    .sort((a, b) => {
      const am = matched.has(a.row.case_id) ? 1 : 0;
      const bm = matched.has(b.row.case_id) ? 1 : 0;
      // Stable within each class: relevance order is preserved, and only the
      // match/no-match partition is new.
      return bm - am;
    })
    .slice(0, EXECUTION_CASE_PRECEDENT_MAX_CARDS);
};

export const createExecutionCasePrecedentSource = (
  getDeps: () => ExecutionCasePrecedentDeps | undefined,
): Middleware => ({
  id: EXECUTION_CASE_PRECEDENT_MIDDLEWARE_ID,
  async prompt(ctx) {
    try {
      if (ctx.surface !== 'chat') return;
      const deps = getDeps();
      if (!deps) return;
      const prompt = latestUserText(ctx);
      if (prompt.trim().length === 0) return;
      // The span anchor is the turn's identity. Without one there is no rooted
      // owner turn to scope against, and scoping is what keeps one principal's
      // precedent away from another's.
      const anchor = deps.anchorStore.getAnchor(ctx.session_id, ctx.turn_id);
      if (!anchor) return;
      const scope = deps.resolveScope({
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        ...(ctx.source ? { source: ctx.source } : {}),
      });
      if (!scope.active) return;
      await deps.ensureCasesCurrent?.();
      const candidateResult = await deps.candidateSource.findCandidates({
        prompt,
        scope,
        limit: Math.max(EXECUTION_CASE_PRECEDENT_MAX_CARDS * 8, 16),
      });
      const candidateRows: ExecutionCase[] = [];
      for (const caseId of candidateResult.candidates) {
        const row = await deps.caseStore.get(caseId);
        // Scope is re-checked on the ROW, never trusted from the candidate
        // source: stage 1 is a replaceable port that returns ids only.
        if (
          row
          && row.governing_contract_id === scope.governing_contract_id
          && row.principal_key === scope.principal_key
          && row.superseded_by === undefined
        ) candidateRows.push(row);
      }
      // Rank WIDER than the card budget, so a skeleton match can be promoted
      // into a slot a merely-lexical match would otherwise have taken. Slicing
      // first would decide the question before the strong signal is consulted.
      const ranked = await promoteSkeletonMatches(
        rankExecutionCaseCandidates(
          prompt,
          candidateRows,
          EXECUTION_CASE_PRECEDENT_MIN_RELEVANCE,
          EXECUTION_CASE_PRECEDENT_MAX_CARDS * 4,
        ),
        prompt,
        candidateResult.prompts,
        deps.knownContactTokens,
      );
      const cards: ExecutionCasePrecedentCard[] = [];
      const consulted: string[] = [];
      let singleTermCards = 0;
      for (const { row } of ranked) {
        const card = renderExecutionCasePrecedentCard(row);
        if (!card) continue;
        if (relevanceBearingOverlap(prompt, row) === 1) singleTermCards += 1;
        // Grow the block one card at a time and stop at the ceiling, rather
        // than rendering everything and truncating: the second card is the one
        // that carries a contradiction, so dropping a whole card is honest
        // where dropping half of one would not be.
        if (!precedentFits(precedentContext([...cards, card]))) break;
        cards.push(card);
        consulted.push(row.case_key);
      }
      // Counted BEFORE the early return, so `ranked` is a real denominator:
      // "how often did a turn get this far" is exactly the question the attach
      // rate is a fraction of, and counting only on success would make every
      // deployment look like it attaches on 100% of turns.
      // ⛔ ITS OWN try/catch, not the middleware's. The surrounding handler
      // catches and RETURNS, so a throwing counter would silently cost the turn
      // its card — a reporting hook deciding whether precedent reaches the
      // model. The deps comment promises this; a promise in a comment is not
      // enforcement, and the test that says so caught exactly this.
      try {
        deps.observe?.({
          ranked: 1,
          attached: cards.length > 0 ? 1 : 0,
          single_term_cards: singleTermCards,
        });
      } catch {
        // Advisory. A tally nobody reads is better than a turn nobody gets.
      }
      if (cards.length === 0) return;
      ctx.state.set(
        EXECUTION_CASE_PRECEDENT_STATE_KEY,
        precedentContext(cards),
      );
      // ⛔ A31 — a turn that CONSUMED a case cannot then reinforce it. The
      // compiler reads these keys off the same turn state when it closes the
      // report, and without them an owner accepting a turn that was shown this
      // card would file evidence FOR the card that produced it: a case that
      // grows more persuasive every time it is believed.
      addConsultedCaseKeys(ctx.state, consulted);
    } catch {
      // Advisory. The turn runs without precedent.
    }
  },
});

const addConsultedCaseKeys = (
  state: Map<string, unknown>,
  values: readonly string[],
): void => {
  const existing = state.get(EXECUTION_CASE_CONSULTED_KEYS_STATE_KEY);
  const set = existing instanceof Set
    ? existing as Set<string>
    : new Set<string>();
  for (const value of values) set.add(value);
  state.set(EXECUTION_CASE_CONSULTED_KEYS_STATE_KEY, set);
};

/** Pick the observation whose turn produced the flow the owner is looking at.
 *
 *  ⛔ EXTRACTED so the rule is testable. Inline in the composition it was
 *  unreachable by any test, which is how "return the first lexical match"
 *  survived: the display orders flows by weight then RECENCY, so an arbitrary
 *  first match stitched one turn's request to another turn's recipe example, and
 *  the owner paid for a draft built from mixed provenance.
 *
 *  ⚠ Matched on `flow_basis` + `tool_sequence`, NOT `exact_signature`.
 *  `ExecutionCaseFlow` does not carry the signature — only the observation's
 *  `flow_pattern` does — so an exact join means adding a field to a sealed
 *  materialized shape and bumping the compiler version. Two flows with the same
 *  basis AND the same tool sequence but different recipes therefore remain
 *  indistinguishable; that residual is why this is "narrowed", not "solved".
 *
 *  Returns the newest MATCH, else the newest non-match as a last resort: an
 *  origin from a different flow still gives the draft the owner's request, which
 *  beats drafting from shape alone. */
export const selectOriginObservation = <
  T extends {
    flow_basis: string;
    flow_pattern: { tool_sequence?: readonly string[] };
    observed_at: number;
  },
>(
  observations: readonly T[],
  target: Pick<ExecutionCaseFlow, 'flow_basis' | 'tool_sequence'> | undefined,
): T | undefined => {
  let best: T | undefined;
  let fallback: T | undefined;
  for (const observation of observations) {
    if (fallback === undefined || observation.observed_at > fallback.observed_at) {
      fallback = observation;
    }
    if (target === undefined) continue;
    const sequence = observation.flow_pattern.tool_sequence ?? [];
    const wanted = target.tool_sequence ?? [];
    const matches = observation.flow_basis === target.flow_basis
      && sequence.length === wanted.length
      && sequence.every((tool, index) => tool === wanted[index]);
    if (!matches) continue;
    if (best === undefined || observation.observed_at > best.observed_at) {
      best = observation;
    }
  }
  return best ?? fallback;
};

/** D-219 V21 — `recipe_steps`: which recipe a step actually ran.
 *
 *  `recipe.run` is a DISPATCHER. A card that renders the bare string reports
 *  that a recipe ran without reporting WHICH — the one thing about that step
 *  worth learning. Measured on the bench corpus from what the model EMITS
 *  (`ai.result.body.tool_calls`): 98 live `recipe.run` invocations against 1359
 *  by slug, so this closes ~7% of recipe traffic — the remaining route, not all
 *  of them. A slug step names its own recipe and is left alone.
 *
 *  ⛔ An earlier count claimed the reverse and was an artifact: it read the
 *  bench's `tool.dispatch` events, which record TIER-1 CORE TOOLS ONLY, so the
 *  1201 `bench/send-email` calls were invisible to it.
 *
 *  The identity was never missing from the substrate: `pairRecipeRuns` attaches
 *  it to the observation's flow pattern, and `loadOrigin` reads it back by
 *  re-loading the source observations. Only the COMPILED flow dropped it, and
 *  the renderer is handed a sealed `ExecutionCase` it cannot re-derive from. */
import { describe, expect, it } from 'vitest';

import { deriveExecutionFlowPattern } from '../execution-case-core.js';
import { renderExecutionCasePrecedentCard } from '../execution-case-precedent.js';
import type { ExecutionCase, ExecutionCaseFlow } from '@recued/contracts';

const step = (tool_name: string, recipe_id?: string) => ({
  tool_name,
  ...(recipe_id !== undefined ? { recipe_id, recipe_hash: `h_${recipe_id}` } : {}),
});

describe('D-219 V21 — deriveExecutionFlowPattern.recipe_steps', () => {
  it('records WHICH recipe each dispatching step ran, keyed by ordinal', () => {
    const flow = deriveExecutionFlowPattern([
      step('contact.search'),
      step('recipe.run', 'send-email'),
    ]);
    expect(flow.tool_sequence).toEqual(['contact.search', 'recipe.run']);
    expect(flow.recipe_steps).toEqual([{ ordinal: 1, recipe_id: 'send-email' }]);
  });

  it('is SPARSE — a flow with no recipe step carries an empty list', () => {
    // The permitting witness for the ordinal guard below: without this, "always
    // empty" would pass every other assertion in this file.
    expect(deriveExecutionFlowPattern([
      step('contact.search'), step('mail.search'),
    ]).recipe_steps).toEqual([]);
  });

  it('⛔ keeps the ORDINAL that recipe_refs throws away', () => {
    // The reason this field exists at all rather than the card reading
    // `recipe_refs`. Two dispatches, only ONE of which paired to a run row —
    // reachable whenever a dispatch produced no run (an error before the
    // runtime started, or an approval hold). `recipe_refs` dedupes to a single
    // entry with no ordinal, so a card matching by name attaches `send-email`
    // to WHICHEVER of the two steps it guesses. Naming the wrong recipe is
    // worse than naming none.
    const flow = deriveExecutionFlowPattern([
      step('recipe.run', 'send-email'),
      step('digest.run'),
    ]);
    expect(flow.recipe_refs).toHaveLength(1);
    expect(flow.recipe_steps).toEqual([{ ordinal: 0, recipe_id: 'send-email' }]);
    // …and the mirror image: the SAME `recipe_refs`, the OTHER step. A
    // name-matched render cannot tell these two flows apart; an ordinal can.
    const mirrored = deriveExecutionFlowPattern([
      step('digest.run'),
      step('recipe.run', 'send-email'),
    ]);
    expect(mirrored.recipe_refs).toEqual(flow.recipe_refs);
    expect(mirrored.recipe_steps).toEqual([{ ordinal: 1, recipe_id: 'send-email' }]);
  });

  it('records one entry per step, even when two steps ran the SAME recipe', () => {
    // `recipe_refs` dedupes on (id, hash) — so it reports one. Both steps still
    // need naming.
    const flow = deriveExecutionFlowPattern([
      step('recipe.run', 'send-email'),
      step('mail.search'),
      step('recipe.run', 'send-email'),
    ]);
    expect(flow.recipe_refs).toHaveLength(1);
    expect(flow.recipe_steps).toEqual([
      { ordinal: 0, recipe_id: 'send-email' },
      { ordinal: 2, recipe_id: 'send-email' },
    ]);
  });
});

/** Build a flow directly. The card renderer takes a sealed `ExecutionCase`, and
 *  what is under test here is the RENDER, so the flow is stated rather than
 *  compiled — including the pre-V21 shape, which no compiler can still emit. */
const flowWith = (over: Partial<ExecutionCaseFlow>): ExecutionCaseFlow => ({
  tools: [],
  tool_sequence: [],
  round_ordinals: [],
  recipe_steps: [],
  flow_basis: 'executed',
  proposed: 0,
  accepted: 0,
  declined: 0,
  executed: 1,
  verified_successes: 0,
  verification_failures: 0,
  user_acceptances: 1,
  user_corrections: 0,
  user_rejections: 0,
  user_undos: 0,
  outcome_strength: {
    positive: 1, negative: 0, contested: false, evidence_families: ['typed'],
  },
  stale: false,
  first_seen_at: 1,
  last_seen_at: 1,
  ...over,
});

const renderSequence = (flow: ExecutionCaseFlow): string[] | undefined =>
  renderExecutionCasePrecedentCard({
    request_shape: { intent_facets: ['send the report'] },
    flows: [flow],
  } as unknown as ExecutionCase)?.flows[0]?.tools_that_may_be_needed;

// ⚠ V22 — the card renders a DEDUPED, SORTED candidate set, not a sequence, so
// these expectations are order-independent by construction. The annotation
// behaviour each test is about is unchanged; only the container is.

describe('D-219 V21 — the card names the recipe, not the dispatcher', () => {
  it('annotates `recipe.run` with what it ran', () => {
    expect(renderSequence(flowWith({
      tool_sequence: ['contact.search', 'recipe.run'],
      recipe_steps: [{ ordinal: 1, recipe_id: 'send-email' }],
    }))).toEqual(['contact.search', 'recipe.run (send-email)']);
  });

  it('annotates the RIGHT step when a flow dispatches twice', () => {
    // The defect the ordinal keying exists to prevent, at the render layer.
    expect(renderSequence(flowWith({
      tool_sequence: ['recipe.run', 'mail.search', 'recipe.run'],
      recipe_steps: [
        { ordinal: 0, recipe_id: 'triage-inbox' },
        { ordinal: 2, recipe_id: 'send-email' },
      ],
    // ⚠ SORTED — the card is a candidate set, so the two dispatches survive as
    // DISTINCT entries (the point of ordinal keying: they must not collapse into
    // one `recipe.run`) while their positions no longer assert an order.
    }))).toEqual([
      'mail.search', 'recipe.run (send-email)', 'recipe.run (triage-inbox)',
    ]);
  });

  it('⛔ renders a pre-V21 case exactly as it does today', () => {
    // Materialized cases are SEALED JSON: a case compiled under V20 has no
    // `recipe_steps` AT RUNTIME whatever the interface says. The bump
    // re-derives them; until it does, the card must degrade to the old string
    // rather than throw and take the whole card down with it.
    const sealed = flowWith({ tool_sequence: ['contact.search', 'recipe.run'] });
    delete (sealed as Partial<ExecutionCaseFlow>).recipe_steps;
    expect(renderSequence(sealed)).toEqual(['contact.search', 'recipe.run']);
  });

  it('does NOT annotate a step that already names its own recipe', () => {
    // A Tier-2 slug call puts the identity in `tool_sequence` itself, in both
    // the qualified and bare forms — `RecipeStore` is keyed BARE and
    // `resolveRecipeId` strips a prefix, so both resolve and both reach here.
    // `bench/send-email (send-email)` is noise.
    expect(renderSequence(flowWith({
      tool_sequence: ['bench/send-email', 'send-email'],
      recipe_steps: [
        { ordinal: 0, recipe_id: 'send-email' },
        { ordinal: 1, recipe_id: 'send-email' },
      ],
    }))).toEqual(['bench/send-email', 'send-email']);
  });

  it('⛔ suppresses on an EXACT name, never a substring', () => {
    // `'recipe.run'.includes('run')` is true. A substring test would let a
    // recipe named `run` suppress its own annotation, and the card would
    // silently go back to naming the dispatcher — the exact defect V21 fixes,
    // reappearing only for one recipe and only in production.
    expect(renderSequence(flowWith({
      tool_sequence: ['recipe.run'],
      recipe_steps: [{ ordinal: 0, recipe_id: 'run' }],
    }))).toEqual(['recipe.run (run)']);
    // A `/`-suffix match must be the WHOLE segment, not any tail.
    expect(renderSequence(flowWith({
      tool_sequence: ['bench/resend-email'],
      recipe_steps: [{ ordinal: 0, recipe_id: 'send-email' }],
    }))).toEqual(['bench/resend-email (send-email)']);
  });

  it('⛔ annotates by ordinal, not by tool name', () => {
    // Nothing here special-cases the string `recipe.run`: the day a third
    // dispatch route appears, a name check would silently drop its identity.
    expect(renderSequence(flowWith({
      tool_sequence: ['workflow.dispatch'],
      recipe_steps: [{ ordinal: 0, recipe_id: 'send-email' }],
    }))).toEqual(['workflow.dispatch (send-email)']);
  });

  it('ignores an ordinal past the end of the sequence', () => {
    expect(renderSequence(flowWith({
      tool_sequence: ['recipe.run'],
      recipe_steps: [{ ordinal: 7, recipe_id: 'send-email' }],
    }))).toEqual(['recipe.run']);
  });
});

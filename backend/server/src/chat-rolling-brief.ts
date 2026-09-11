/** The ROLLING BRIEF — one model-written carry-forward that replaces a turn's
 *  accumulated tool results before they force a trim.
 *
 *  ⛔⛔ WHY THIS EXISTS, MEASURED RATHER THAN ARGUED. On
 *  internal benchmarks task 342 at a 40,000-token budget (22,005 tokens of
 *  working room, 55% — not a floor artifact):
 *
 *    - a turn accumulates ~4.5 read-sized results before the ladder must act;
 *    - the elision rung then keeps ALL of them at 2,048 chars each, so eight
 *      elided results still cost 19,155 bytes — half the room — AFTER the trim;
 *    - those 2,048 chars are a HEAD truncation, and the model said so twice in
 *      its own prose: *"I can see the operational notes for rings 05-08, but
 *      they contain operational detail"* — the value it needed was at the END
 *      of a 9.2 KB body;
 *    - and the model re-fetches what was taken, four cycles, 0/7 runs answered.
 *
 *  ⚠ DROPPING THE PREVIEWS ENTIRELY IS WORSE, AND THAT WAS MEASURED TOO. At
 *  `preview = 0` the entries fall to ~213 bytes (19,155 → 1,696 for eight) but
 *  the model does strictly MORE work: rounds 9-13 → 17-19, elided rounds 1-4 →
 *  10-11, one run reaching 19 accumulated elisions. Freeing the room without
 *  putting anything useful in it converts a fast failure into a slow one.
 *
 *  🔑 SO THE ROOM IS REAL AND ONLY THE CONTENT IS WRONG. A head truncation is
 *  the worst of both: it costs like content and reads like noise. This replaces
 *  it with something SELECTED — what the user asked for, what they constrained,
 *  what is still outstanding, and what has been found so far.
 *
 *  ⚠ AND IT IS ROLLING BECAUSE IT CANNOT BE ANYTHING ELSE. Briefing a turn's
 *  whole history at the trim point does not fit: nine raw results are ~49,481
 *  est tokens, over budget even with the catalog dropped. One brief plus the
 *  few results since it is ~19,374 — which fits with room. The recurrence is a
 *  feasibility constraint, not a preference. */

import { TIER1_CLASSIFICATIONS } from '@recued/contracts';
import type { ChatPriorToolCall } from '@recued/contracts';

/** What a brief carries forward. Structured, NOT prose.
 *
 *  ⛔ THE STRUCTURE IS THE DEFENCE AGAINST GENERATIONAL DECAY. Each brief
 *  summarises the previous brief, so specificity erodes across generations —
 *  and it erodes FIRST on exactly the facts that matter most, because those are
 *  the non-re-derivable ones. `689` survives one generation as a number and by
 *  the third is "a running total was established". A field that must hold a
 *  value is far harder to soften than a sentence, so constraints and findings
 *  get their own slots rather than living inside a paragraph. */
export interface RollingBrief {
  /** What the user is working on right now, in their terms — the anchor a fold
   *  writes the rest of the brief against.
   *
   *  ⛔⛔ IT DRIFTS, AND THAT IS CORRECT. This said "survives every generation
   *  unchanged — the one thing that cannot become stale", and nothing in the
   *  system asks for that: the model-facing instruction is `'string — what the
   *  user asked for'`, with no fidelity or stability requirement at all.
   *  Measured over 407 distinct intents in the stored corpus — **23% change
   *  turn-to-turn** (316/1372), only **6%** of runs end on the intent they
   *  started with, median 5 distinct intents per run. A 20-turn conversation
   *  has more than one thing being asked for, and pinning turn 1's forever
   *  would anchor the brief to something the owner finished with.
   *
   *  🔑 IT TRACKS THE PHASE OF WORK, NOT EACH MESSAGE, which is the distinction
   *  the old line was reaching for. Only **5%** of intents restate the current
   *  user message and **77%** carry content that message does not — so it is
   *  neither a frozen goal nor a copy of `user_message`, and both of those
   *  would be useless in the packet for opposite reasons.
   *
   *  ⚠ WHAT THE OLD CLAIM WAS PROTECTING STILL MATTERS, it just does not live
   *  here: the arc-level framing an owner states once ("Priya has me pricing the
   *  Meridian job") migrates into `constraints`, which IS permanent and IS
   *  copied exactly. `hasAnchor` refuses to persist a brief with an empty
   *  intent for the same reason — a fold with no anchor evicts the turn that
   *  stated the goal and cannot restate it later.
   *
   *  ⚠ AND IT IS AN INTERPRETATION, NOT A QUOTE. Unlike `constraints` ("copied
   *  exactly"), nothing requires the model to preserve the owner's wording here,
   *  so a repair of an unclear ask is permitted and would be invisible. Driven
   *  twice (bench probes 375/376) without inducing one — given a flagrant
   *  contradiction the model copied the user VERBATIM, and under 164 words of
   *  compression pressure it preserved a directional slip rather than
   *  "correcting" it. Unexercised at this tier, not closed. */
  readonly intent: string;
  /** Values and rules the USER supplied that appear in no tool result.
   *  ⛔ THE HIGHEST-VALUE FIELD. Measured on 342: the model lost the user's
   *  "252 surcharge" and said so — *"I don't currently have the earlier cost
   *  figures or the surcharge rate in view"*. A tool can re-derive a ring cost;
   *  nothing can re-derive what the user said. */
  readonly constraints: readonly string[];
  /** ACTIONS still to perform — each one FINISHABLE. Without it a model that
   *  lost its results cannot tell finished work from unstarted work, and redoes
   *  both.
   *
   *  ⛔⛔ TASKS ONLY, AND THE BOUNDARY IS RETIRABILITY. This field REPLACES on
   *  every fold (see `mergeBriefs`), which is right for work that gets done and
   *  catastrophic for anything durable. The instruction used to say "what is
   *  still outstanding NOW" — and a standing rule IS still outstanding in the
   *  ordinary sense, so the model filed rules here too.
   *
   *  🔑 MEASURED (task 343, run `15-19-06-591Z`). The rule "do not sum" landed
   *  in BOTH fields: brief 2 put it in `constraints` AND in `pending`; brief 4
   *  carried two copies in `pending`; brief 5 replaced the list with one item
   *  and both pending copies died. The rule survived ONLY because a duplicate
   *  had happened to reach `constraints`, where the union keeps it — luck, not
   *  mechanism, and the instruction it protects ("do not add the surcharge
   *  yet") is the whole point of that task.
   *
   *  ⚠ The boundary does not fix omission: a genuine TASK the model simply
   *  fails to restate still vanishes (rings 05-08 did). That needs explicit
   *  retirement, which is separate work. */
  readonly pending: readonly string[];
  /** Facts established so far — the answers, not the raw results. */
  readonly findings: readonly string[];
  /** Side-effecting calls this turn ALREADY COMPLETED — derived in code from
   *  the folded dispatches, never authored by the model.
   *
   *  ⛔⛔ THE RE-DERIVABILITY RULE GOVERNS READS, NOT WRITES, AND CONFLATING
   *  THEM COST A LIVE TURN. A read earns a slot here only if it cannot be
   *  recomputed — a model that CAN re-read WILL re-read, and that is cheap and
   *  correct. A WRITE is a side effect: the question is not "can this be
   *  recomputed" but "is re-running it free", and it is not.
   *
   *  🔑 MEASURED (task 343, forced budget 34,000, run `17-21-08-818Z`).
   *  `memory.write` SUCCEEDED (`ok: true`), then a mid-turn fold replaced
   *  `prior_tool_calls` wholesale and erased the record of it. The brief kept
   *  the surcharge FACT perfectly — and the model, reading its own
   *  `pending: "Confirm the 252-unit quarterly rig surcharge is held"`,
   *  re-attempted the write, fabricated `provenance_entity_ids[0] =
   *  "m1.dana.reyes@d1.invalid"`, was refused, and retried the identical
   *  refused call SEVEN more times until the turn timed out. Nine model calls,
   *  zero dispatches. Preserving the fact was never enough; the ACT had to be
   *  recorded too. */
  readonly completed: readonly string[];
}

/** Serialized size of a brief, for the budget arithmetic. */
export const briefBytes = (brief: RollingBrief): number =>
  JSON.stringify(brief).length;

/** Serialized size of the results a brief would replace. */
export const priorToolCallBytes = (
  calls: readonly ChatPriorToolCall[],
): number => JSON.stringify(calls).length;

/** Why a fold did not happen, or did. Four states that currently collapse into
 *  one absence in the report.
 *
 *  ⛔⛔ THE SILENT FALLBACK MAKES "FAILED" AND "NEVER TRIGGERED" IDENTICAL, AND
 *  THAT HAS ALREADY COST TWO INVESTIGATIONS. When the parse read the wrong
 *  reply field, the brief fired twice, produced perfect output, and was
 *  discarded — the run looked exactly like one where the trigger never met its
 *  threshold. It was found only by counting `carried_forward` occurrences in
 *  the raw report, a signal that exists by accident.
 *
 *  🔑 A NEGATIVE MUST NAME ITS CAUSE. `not_triggered`, `capacity_refused`,
 *  `call_failed` and `parse_failed` want different fixes — a smaller trigger, a
 *  partial fold, a retry, a prompt change — and are indistinguishable from the
 *  outcome alone. */
export type BriefOutcome =
  | 'folded'
  | 'not_triggered'
  | 'too_few_calls'
  | 'no_room'
  | 'capacity_refused'
  | 'call_failed'
  | 'parse_failed'
  /** The turn returned a `memory.search` / `recall.search` result, so every
   *  packet in it must carry a valid `recall_context`. See `shouldBrief`. */
  | 'recall_bearing_skip'
  /** No retainable result to fold. The brief's own instruction says findings
   *  come from `tool_results_since` ONLY, so with that empty there is nothing
   *  a truthful brief could add — and a fold attempted anyway can only invent.
   *  See `shouldBrief`. */
  | 'nothing_to_fold'
  /** The payload is smaller than the brief that would replace it, so the fold
   *  cannot shrink the packet and is a pure cost. See `shouldBrief`. */
  | 'nothing_to_shrink';

/** The only outcomes a turn-end `force` may waive.
 *
 *  ⛔⛔ A WHITELIST, NOT A BLACKLIST, AND THE DIFFERENCE IS THE BUG THIS FIXES.
 *  The first cut waived everything except one special-cased outcome, so
 *  `recall_bearing_skip` — a PRIVACY decision — was overridden by a flag that
 *  exists to waive a BUDGET one. Measured 2026-09-06: after nine correct skips
 *  the turn-end fold called anyway and was rejected by the egress guard with
 *  `recall-bearing packet has invalid recall_context`.
 *
 *  🔑 THE TEST FOR IT PASSED, WHICH IS WHY THE SHAPE MATTERS. It asserted that
 *  the skip outranks `force` by calling `shouldBrief` directly — and the force
 *  path never consults that result. A rule enforced at one end and bypassed at
 *  the other, with a green test covering the end that works.
 *
 *  As a whitelist, an outcome added later is non-waivable until someone
 *  deliberately adds it here. `force` closes a turn's carry; it does not
 *  overrule why a fold was refused. */
export const FORCE_WAIVABLE_OUTCOMES: ReadonlySet<BriefOutcome> = new Set<BriefOutcome>([
  // Budget-shaped: the turn is ending, so "not big enough yet" no longer applies.
  'not_triggered',
  'too_few_calls',
  // ⛔ WAIVED AT TURN END ON PURPOSE. The closing fold is about COMPLETENESS —
  //   "the stored brief covers everything up to the boundary" — not economics.
  //   Suppressing a small payload here would drop exactly the user statement the
  //   accumulator exists to preserve, to save a call. Mid-turn it is pure cost;
  //   at the boundary it is the record.
  'nothing_to_shrink',
]);

/** Should this turn brief-and-clear before composing the next round?
 *
 *  ⛔⛔ DERIVED FROM THE LADDER'S OWN ARITHMETIC, NOT A SHARE. An earlier cut
 *  used "half the room" and that was a guess — measured against the real
 *  numbers it fires at ~2 accumulated results when ~3 is safe, spending an
 *  extra model round every turn for nothing.
 *
 *  🔑 THE TWO CAPACITIES ARE DIFFERENT, AND THAT IS THE WHOLE MECHANISM:
 *
 *      main packet  = budget − catalog − system      →  21,819 est  (~4 results)
 *      brief call   = budget − system − instruction  →  36,950 est  (~7 results)
 *
 *  The brief call reads 15,131 est MORE than the main packet can hold, purely
 *  because a summarisation call needs no tool catalog — 39% of the budget on
 *  the measured configuration. That headroom is what lets the brief run at the
 *  cliff instead of well before it, so no safety fraction is needed.
 *
 *  The only slack required is ONE RESULT: they arrive in ~4,843-est jumps, so
 *  triggering exactly at `room` risks the next one landing first and forcing
 *  the trim the brief exists to pre-empt.
 *
 *  ⚠ AND THE BRIEF'S OWN CAPACITY IS A GUARD, NOT A COMMENT. If a turn has
 *  already accumulated more than the brief call can READ — one tool returning
 *  something far larger than a note — then briefing is impossible and the
 *  ladder must be left to do what it does today. Failing to check that would
 *  break the mechanism at exactly the moment it is most needed, and silently:
 *  the brief call would be the thing that overflows. */
export const shouldBrief = (input: {
  readonly priorToolCalls: readonly ChatPriorToolCall[];
  /** The trim budget in tokens. */
  readonly budgetTokens: number;
  /** Est tokens the catalog occupies — the caller reads this from the SAME
   *  composition the ladder measures, so the trigger cannot drift from the
   *  ladder's real behaviour when the catalog mode steps down. */
  readonly catalogTokens: number;
  /** Est tokens of system prompt + fixed envelope. */
  readonly overheadTokens: number;
  /** Est tokens the CHAT TAIL occupies.
   *
   *  ⛔ NOT OPTIONAL, AND OMITTING IT WAS A BUG. The room a turn has for
   *  results is what the budget leaves after the catalog, the system prompt AND
   *  the conversation so far — the tail is not free, and it GROWS across turns
   *  while the catalog does not. Measured on 342 it is small (1-421 est), which
   *  is exactly why leaving it out looked harmless in that scenario and would
   *  not in a long conversation: the trigger would fire late by however much
   *  the tail had grown, which is precisely when a turn can least afford it. */
  readonly tailTokens: number;
  /** The brief this fold would inherit, if any.
   *
   *  ⛔ ITS SIZE IS MEASURED, NOT ASSUMED, BECAUSE THE MERGE MAKES IT GROW.
   *  `findings` and `constraints` now UNION across folds, so a brief is ~200
   *  est after one turn and ~900 after twelve. The capacity arithmetic used a
   *  fixed `BRIEF_RENDERED_TOKENS`, which under-reserves exactly when the brief
   *  has grown enough to matter — and the failure would be the brief call
   *  overflowing, i.e. the mechanism breaking at its own maturity. */
  readonly previous?: RollingBrief | null;
  /** Has a recall tool returned anything into this turn?
   *
   *  ⛔⛔ WHEN TRUE THE BRIEF IS SKIPPED, AND THAT IS A PRIVACY DECISION, NOT A
   *  BUDGET ONE. `hasRegisteredRecallResult` is per-TURN fail-closed state: once
   *  a `memory.search` or `recall.search` result lands, EVERY provider packet in
   *  that turn must carry a valid `recall_context`, which binds recalled PII to
   *  the piece it came from. A packet carrying recalled content without that
   *  binding is the cross-session leak the guard exists to stop — its own
   *  comment: *"emitting bare session ids is what let a whole source session's
   *  values cross and retroactively alias values the recalling session had
   *  already disclosed"*.
   *
   *  Measured 2026-09-06: the brief call was rejected three times with
   *  `chat privacy protection failed: recall-bearing packet has invalid
   *  recall_context`, and the downstream `capacity_refused` at 51,559 est was a
   *  SYMPTOM of those failures — accumulation that would have been folded.
   *
   *  🔑 PASSING THE TURN'S `recall_context` THROUGH WOULD SATISFY THE GUARD AND
   *  IS THE WRONG TRADE HERE. A brief PERSISTS ACROSS TURNS, so anything
   *  recalled that reached its `findings` would outlive the turn whose
   *  `recall_context` bound it — the precise shape of bleed that comment warns
   *  about, and one ordinary packets never have. Declining to brief costs a
   *  carry; getting the binding wrong costs a leak that propagates forward. */
  readonly recallBearing?: boolean;
  /** The recall dispatches available to carry into the brief call. */
  readonly recallContext?: readonly ChatPriorToolCall[];
  readonly minCalls?: number;
  /** Count of RETAINABLE results this fold would summarise — the non-recall
   *  arm of `partitionPriorToolCalls`, i.e. exactly what reaches
   *  `tool_results_since`. Defaults to the raw call count for callers that do
   *  not partition. */
  readonly newResultCount?: number;
}): { readonly brief: boolean; readonly outcome: BriefOutcome; readonly reason: string } => {
  // ⛔ A RECALL-BEARING TURN IS NOW BRIEFABLE, PROVIDED THE CALL CAN CARRY THE
  //   TURN'S `recall_context`. The skip remains for the case where it cannot —
  //   the guard is fail-closed and a packet that would be rejected must not be
  //   attempted, which is what produced nine correct skips followed by one
  //   rejected call before `FORCE_WAIVABLE_OUTCOMES` existed.
  if (input.recallBearing === true && (input.recallContext?.length ?? 0) === 0) {
    return {
      brief: false, outcome: 'recall_bearing_skip',
      reason: 'a recall tool returned into this turn but no recall_context is '
        + 'available to carry — the egress guard would reject the brief call',
    };
  }
  // ⛔⛔ NOTHING TO SUMMARISE MEANS NOTHING TO SAY, AND THE MODEL SAID SOMETHING
  //   ANYWAY. Measured (task 343, run `2026-09-06T19-02-39-435Z`): brief 6 ran
  //   with `tool_results_since` EMPTY and emitted
  //   "Kestrel ring 05 checkpoint cost: 184 units" and
  //   "Kestrel ring 06 checkpoint cost: 229 units" — the true values are 176
  //   and 205, and neither number appears anywhere in the seed. It invented two
  //   costs out of an empty input.
  //
  //   🔑 THIS IS THE WORST FAILURE THE BRIEF CAN HAVE, NOT A MINOR ONE. A LOST
  //   fact makes the model re-read; a FABRICATED fact enters `findings`, unions
  //   forward permanently, and is believed by every later turn — with the raw
  //   results already discarded, so nothing can contradict it. The instruction
  //   already forbids it in as many words ("Do not invent … a wrong number here
  //   becomes a wrong answer with nothing left to check it against"); this
  //   removes the opportunity rather than repeating the request.
  //
  //   ⚠ CHECKED BEFORE `minCalls`, because a recall-only turn clears that
  //   threshold on calls whose results are non-retainable and therefore absent
  //   from `tool_results_since`.
  if ((input.newResultCount ?? input.priorToolCalls.length) === 0) {
    return {
      brief: false, outcome: 'nothing_to_fold',
      reason: 'no retainable result to fold — findings could only be invented',
    };
  }
  const minCalls = input.minCalls ?? BRIEF_MIN_CALLS;
  if (input.priorToolCalls.length < minCalls) {
    return {
      brief: false, outcome: 'too_few_calls',
      reason: `only ${String(input.priorToolCalls.length)} call(s)`,
    };
  }
  const room = input.budgetTokens - input.catalogTokens - input.overheadTokens
    - input.tailTokens;
  if (room <= 0) {
    return {
      brief: false, outcome: 'no_room',
      reason: 'no room at all — the floor exceeds the budget',
    };
  }
  const accumulated = priorToolCallBytes(input.priorToolCalls) / 2;
  // The next result is likely to resemble the biggest one this turn already
  // produced; a fixed margin would under-reserve on a turn reading large things.
  const largest = Math.max(
    ...input.priorToolCalls.map((c) => JSON.stringify(c).length / 2),
  );
  // ⛔ CAN THE BRIEF CALL STILL READ THIS? Checked BEFORE the trigger, because
  // a "yes, brief" on content the brief cannot hold is worse than never
  // briefing: it spends a round and overflows.
  //
  // ⚠ THIS IS NOT A GUARD ON ACCUMULATION, AND AN EARLIER COMMENT IMPLIED IT
  //   WAS. Accumulated results live in the MAIN packet between rounds, so they
  //   are bounded by ITS room (~21,819 est on the measured configuration) —
  //   well under this capacity, which is therefore never reached by a turn
  //   accreting normal-sized results. What it actually catches is ONE HUGE
  //   RESULT: a CSV, an export, a whole document arriving in a single call and
  //   exceeding the brief call's own reach. That case cannot be briefed at all
  //   and needs its own treatment (summarise via a recipe, strip columns,
  //   narrow the query) rather than a carry-forward.
  const carriedTokens = input.previous == null
    ? 0
    : Math.ceil(JSON.stringify(input.previous).length / 2);
  const briefCapacity = input.budgetTokens - input.overheadTokens
    - BRIEF_INSTRUCTION_TOKENS - Math.max(BRIEF_RENDERED_TOKENS, carriedTokens);
  if (accumulated > briefCapacity) {
    return {
      brief: false, outcome: 'capacity_refused',
      reason: `accumulated ${String(Math.round(accumulated))} est exceeds what the brief `
        + `call can read (${String(briefCapacity)}) — leave it to the ladder`,
    };
  }
  // ⛔⛔ A FOLD THAT CANNOT SHRINK THE PACKET IS PURE COST. `BRIEF_MIN_CALLS`
  //   bounds the fold's COUNT; nothing bounded its SIZE, so a turn could hold
  //   three small results and still pay a full model call to replace them.
  //
  //   🔑 MEASURED (bench 369, fold #2): folded 291 B of results into a 301 B
  //   brief — it made the packet BIGGER — and cost 1,933 tokens to do it. Across
  //   that run the folds cost 14,077 tokens to save 15,084, so a single
  //   non-shrinking fold was ~14% of the entire fold bill for negative return.
  //
  //   ⚠ THE FLOOR IS THE BRIEF'S OWN RENDERED SIZE, NOT A TUNED CONSTANT. Below
  //   it the replacement is larger than the thing replaced, which is not a
  //   judgement call about whether the trade is good — it is arithmetic saying
  //   there is no trade. Costs no model call to decide.
  if (accumulated < BRIEF_RENDERED_TOKENS) {
    return {
      brief: false, outcome: 'nothing_to_shrink',
      reason: `accumulated ${String(Math.round(accumulated))} est is below the `
        + `~${String(BRIEF_RENDERED_TOKENS)} est a brief renders at — folding `
        + `would not shrink the packet`,
    };
  }
  // ⛔⛔ THE TRIGGER IS min(LADDER-EVICTS, BRIEF-CAN-STILL-INGEST). It was only
  //   the first term, and that term is RIGHT — `room - largest` is the point at
  //   which one more result of the size THIS TURN IS ACTUALLY READING would
  //   overflow, so folding there preserves what the ladder would otherwise
  //   elide. An earlier cut used half the room and fired at ~2 accumulated
  //   results where ~3 was safe; reserving the largest is what fixed it, and
  //   `Math.max -> Math.min` is mutation-covered.
  //
  //   🔑 THE SECOND CEILING IS THE ONE THAT WAS MISSING, AND WHICH ONE BINDS
  //   DEPENDS ON THE SHAPE OF THE PACKET:
  //     `room - largest` — where the LADDER will evict. Folding later is too
  //                        late: the ladder has already discarded the material.
  //     `briefCapacity`  — what the brief call can still READ. Folding later is
  //                        IMPOSSIBLE, and the material is permanently unfoldable.
  //   ⚠ WHICH ONE BINDS IS EXACTLY `catalog − INSTR − max(RENDERED, carried)`,
  //   and the driver is THE CARRY, not the head. Subtracting the tail from
  //   `briefCapacity` would cancel — `room` already subtracts it — so the head
  //   never changes the ordering. What does:
  //       carried      0 → briefCapacity 36,909 vs room 21,419   ladder binds
  //       carried 15,000 → briefCapacity 22,309 vs room 21,419   ladder binds
  //       carried 16,000 → briefCapacity 21,309 vs room 21,419   BRIEF binds
  //   The brief's ceiling takes over once the carry passes catalog − INSTR
  //   (~15,490 est on the measured configuration).
  //
  //   ⛔⛔ THE MIN IS INERT, AND I CLAIMED OTHERWISE TWICE BEFORE COMPUTING IT.
  //   `capacity_refused` is checked ABOVE this line and fires first:
  //       refusal    when carry > (budget − overhead − INSTR)/2 = 18,654
  //       min binds  when carry > catalog + tail + largest − INSTR = 19,890
  //   After a fold `prior_tool_calls` IS the brief pseudo-call, so `accumulated`
  //   ≈ `carried`; both sides grow together and the refusal always arrives
  //   ~1,200 est earlier. The min therefore never decides anything in any
  //   configuration this ships with. It is kept because it is correct and free,
  //   and because the ordering it guards is real — but it guards nothing today.
  //
  //   ⛔ THE LONG-SESSION DEATH IS UNGUARDED. `constraints` / `findings` union
  //   with no cap, so `carried` grows monotonically until `capacity_refused`
  //   fires and then fires FOREVER — the fold stops working permanently and
  //   silently in exactly the sessions where carrying matters most. NO trigger
  //   arithmetic can prevent that; only bounding the carry can (tool-derived
  //   findings are recomputable and evictable, user-stated facts expire when
  //   their intent closes).
  //
  //   ⇒ The real fix upstream is bounding the carry (tool-derived findings are
  //   recomputable and evictable; user-stated facts expire when their intent
  //   closes). This min is the guard that keeps the mechanism alive until then.
  const trigger = Math.min(room - largest, briefCapacity);
  return accumulated >= trigger
    ? {
        brief: true, outcome: 'folded',
        reason: `accumulated ${String(Math.round(accumulated))} est >= trigger `
          + `${String(Math.round(trigger))} (room ${String(room)} − largest `
          + `${String(Math.round(largest))}, brief_capacity `
          + `${String(Math.round(briefCapacity))})`,
      }
    : {
        brief: false, outcome: 'not_triggered',
        reason: `accumulated ${String(Math.round(accumulated))} est < trigger ${String(Math.round(trigger))}`,
      };
};

/** Two results are not a history worth compressing. */
export const BRIEF_MIN_CALLS = 3;
/** Est tokens of {@link BRIEF_INSTRUCTION}, charged against the brief call's
 *  own capacity. */
export const BRIEF_INSTRUCTION_TOKENS = 250;
/** Floor for the space a rendered brief occupies. The ACTUAL carried brief is
 *  measured when one exists (see `previous`); this is the reserve for the one
 *  this fold is about to produce. */
export const BRIEF_RENDERED_TOKENS = 400;

/** The instruction the brief call carries.
 *
 *  ⛔⛔ THE PROHIBITION ON NEW ARITHMETIC IS MEASURED, AND THE EVIDENCE STAYS
 *  HERE RATHER THAN IN THE PROMPT. On 2026-09-06 a brief written after only
 *  half the inputs were read filed a premature total — `689 + 252 = 941` — as
 *  a FINDING. It was wrong, it was the exact answer two earlier baseline runs
 *  had produced, and a finding reads as decided where a raw result can be
 *  re-read and corrected.
 *
 *  ⚠ THE FIRST FIX QUOTED THAT ARITHMETIC IN THE INSTRUCTION ITSELF, which put
 *  a specific wrong number into the model's context on every brief call. The
 *  briefs stayed clean, so nothing was primed — but writing a wrong answer into
 *  a prompt to warn against wrong answers is a hazard invented while fixing
 *  one. The rule is stated as a rule; the incident lives in this comment.
 *
 *  ⚠ IT ASKS FOR WHAT CANNOT BE RE-DERIVED, IN PRIORITY ORDER. A ring cost can
 *  be re-read; a user's surcharge cannot. Telling the model to preserve
 *  "important details" gets a summary weighted by prose salience, which is the
 *  wrong axis — the rule is RECOVERABILITY, and it has to be stated. */
/** ⛔⛔ CUT BACK TO WHAT IS MEASURED. This block carried a three-tier recovery
 *  ranking, an anti-calculation paragraph and an anti-fabrication rule — most of
 *  it added while chasing failures that turned out to be a missing `work.search`
 *  FTS index and a pre-seed index that never probed work entities. With those
 *  fixed, the bulk stopped paying for itself.
 *
 *  🔑 MEASURED over 255 paired replays of REAL stored brief packets
 *  (qwen3.7-plus, the model the lane runs), wrong ring-cost claims / claims:
 *    elaborate (the full block)          8.2%   — user value kept 81/99
 *    minimal (4 lines)                  16.8%   — user value kept 87/99
 *    minimal + the USER-VALUE sentence  12.6%   — user value kept 87/99
 *  A vs C: 12 packets better vs 4, p = 0.077 — NO measured difference, on a
 *  pre-registered primary. One sentence closes about half the gap; the rest of
 *  the block did not earn its ~250 tokens per fold across two experiments.
 *
 *  ⚠ AND IT LOST ON ITS OWN OBJECTIVE. The three-tier ranking exists to protect
 *  user-stated values, and both minimal arms preserved the user's "252" MORE
 *  often than it did (87/99 vs 81/99).
 *
 *  ⚠ p = 0.077 is underpowered, not a demonstrated null. The honest claim is
 *  that 255 paired packets failed to show the block earning its cost — not that
 *  it is useless. Restoring it needs evidence, not preference.
 *
 *  ⛔ THE TWO FIELD RULES STAY: they are not bulk, they describe merge
 *  behaviour the model cannot infer, and one of them replaced a live
 *  self-contradiction. */
export const BRIEF_INSTRUCTION =
  'You are compressing your own working context mid-task, because the tool '
  + 'results below no longer fit and are about to be discarded. Write the '
  + 'carry-forward that lets you finish without them.\n\n'
  + '⛔ `constraints` and `findings` in `carried_forward` ARE ALREADY KEPT. Do '
  + 'not repeat them, do not re-rank them, do not drop them — they are merged '
  + 'for you and cannot be lost. Report only what is NEW in '
  + '`tool_results_since`.\n\n'
  + '⛔⛔ `pending` WORKS DIFFERENTLY. Restate EVERY action still outstanding, '
  + 'carried ones included — repeats are de-duplicated, so repeating costs '
  + 'nothing, and omitting removes nothing either.\n\n'
  + 'Anything the USER stated — amounts, rules, names, preferences — no tool '
  + 'can return these. Losing one is unrecoverable; copy them EXACTLY, digits '
  + 'and all, never paraphrased or rounded.\n\n'
  // ⛔ 27% of measured turns do no tool work, so no fold runs and this call
  //   sees only the CURRENT `user_message`. The backlog arrives here instead.
  + '`pending_user_statements`, when present, is what the user said on earlier '
  + 'turns that no brief has recorded yet. It is a PARTIAL, BOUNDED list, not a '
  + 'history: it starts wherever the last brief left off and drops entries once '
  + 'it is full, so its first item is NOT the start of the conversation and you '
  + 'cannot tell from it what came before. Treat each one exactly like the '
  + 'current request: anything durable in them belongs in `constraints`.\n\n'
  // ⚠ `stripAliasBearing` drops alias-bearing entries AFTER the fact. Saying so
  //   here turns a silently-dropped finding into one the model never writes.
  + '`recall_context`, when present, is recalled material. Record plain facts '
  + 'from it — an amount, a date, a rule the user set. Do NOT copy names or '
  + 'identifiers out of it; an entry carrying one is discarded.\n\n'
  // ⛔⛔ KEPT DESPITE THE CUT, BECAUSE THE MEASUREMENT COULD NOT SEE IT. The
  //   three-arm replay scored `ring NN: X units` claims; a fabricated TOTAL is
  //   not a ring claim, so this rule's whole benefit was invisible to it. Both
  //   classes were observed live today — "1727 units." and "1589 units." as
  //   final answers against a true 1695 — and a brief that computes a total the
  //   conversation never reached writes it into `findings`, where it unions
  //   forward and cannot be refuted once the raw results are gone.
  //
  //   ⚠ Deleting this on that evidence would have been the exact error the
  //   prompt log records for the bytes-per-token constant: a corpus that never
  //   exercises a content class reports it as ABSENT, not as SAFE.
  + '⛔⛔ DO NOT CALCULATE ANYTHING NEW. You are recording what is already '
  + 'known, not making progress on the task. Never compute a total the '
  + 'conversation has not already reached.\n\n'
  + 'Emit ONLY the JSON object, no prose around it.';

/** The brief call's user body: the previous brief, then what has happened
 *  since. */
export const buildBriefPrompt = (input: {
  readonly userMessage: string;
  readonly previous: RollingBrief | null;
  readonly since: readonly ChatPriorToolCall[];
  /** The turn's recall dispatches, verbatim from `partitionPriorToolCalls`.
   *
   *  ⛔ CARRIED SO THE EGRESS GUARD ADMITS THIS CALL. `hasRegisteredRecallResult`
   *  is per-TURN: once a recall result lands, EVERY packet in the turn must
   *  carry a valid `recall_context` binding recalled PII to its source piece.
   *  Passing the composer's own value through means this call is aliased by the
   *  same pass as every other packet — reuse, not construction.
   *
   *  ⚠ The model therefore READS recalled content. It must not REMEMBER it:
   *  `stripAliasBearing` runs before anything persists. */
  readonly recallContext?: readonly ChatPriorToolCall[];
  /** ⛔ USER MESSAGES FROM EARLIER TURNS THAT NO FOLD EVER SAW — the backlog
   *  from `peekUnfoldedUserMessages`. A tool-free turn runs no closing fold
   *  (27% of measured turns), and this call otherwise receives only the CURRENT
   *  `userMessage`, so without this a rule stated on such a turn reaches no
   *  brief and `chat_tail` forgets it in ~2 turns. Oldest first. */
  readonly earlierUserMessages?: readonly string[];
}): string =>
  JSON.stringify({
    user_request: input.userMessage,
    ...(input.earlierUserMessages !== undefined
      && input.earlierUserMessages.length > 0
      ? { pending_user_statements: input.earlierUserMessages }
      : {}),
    ...(input.recallContext !== undefined && input.recallContext.length > 0
      ? { recall_context: input.recallContext }
      : {}),
    // ⚠ The previous brief leads, so a model that must drop something drops the
    // NEW material it can still see rather than the carried material it cannot.
    carried_forward: input.previous,
    tool_results_since: input.since,
    emit: {
      intent: 'string — what the user asked for',
      constraints: 'string[] — NEW values, facts and STANDING RULES the USER '
        + 'gave, copied exactly — including anything they told you NOT to do. '
        + 'These are kept permanently. Do not repeat ones already in '
        + 'carried_forward; they are kept for you. If the user CHANGES one that '
        + 'is already there — a new amount, a reversed rule — restate it as the '
        + 'single current version and say what it replaces, for example '
        + '"levy is now 340 units (was 318)". Do not add a second entry beside '
        + 'the old one: both would be kept and nothing would say which is live.',
      // ⛔⛔ "NEW ACTIONS … do not repeat" EMPTIED THIS FIELD COMPLETELY.
      //   Inverting the merge to a union was right; ALSO telling the model to
      //   stop reporting carried work was not, and the two were shipped
      //   together. The model reads "new" as "not already mentioned", finishes
      //   each turn's work inside that turn, and so has nothing new to report:
      //   measured on task 343, produced `pending` went from [2,2,4,2,2,2,1]
      //   to [0,0,0,0,0] and retirement had nothing to act on.
      //
      //   🔑 THE UNION ALREADY MAKES REPETITION FREE. The model should report
      //   everything outstanding, exactly as it did before, and the code
      //   de-duplicates — the same division of labour `findings` uses.
      pending: 'string[] — ACTIONS still to perform. Every entry must be '
        + 'something that can be FINISHED, like "Report ring 05 cost". If it '
        + 'can never be finished — a standing rule such as "do not sum yet" — '
        + 'it is NOT pending: put it in constraints, where it is kept. Include '
        + 'EVERY action still outstanding; repeat carried ones freely, they are '
        + 'de-duplicated for you.',
      // A_minimal. Five instruction variants were measured and NONE beat any
      // other (all paired contrasts p=1.0), so the simplest is used: elaborate
      // framing — stating the deletion consequence, demanding evidence, hedging
      // with "when in doubt leave it out" — bought nothing.
      findings: 'string[] — VALUES you extracted from tool_results_since: a '
        + 'number, a name, a date, a status. NOT record ids, and NOT a '
        + 'description of what you did — "read the full note", "the preview was '
        + 'truncated" and a bare uuid are all things you can obtain again in one '
        + 'call, and they crowd out the values that cannot be. These are '
        + 'REGENERATED each time: restate every value you still need, including '
        + 'ones you reported before.',
    },
  });

/** Parse a brief out of a model reply. Returns null on anything malformed —
 *  a partial brief is more dangerous than none, because the turn would carry
 *  forward a confident subset with the rest silently missing. */
export const parseBrief = (raw: unknown): RollingBrief | null => {
  // ⛔⛔ TWO SHAPES, AND READING ONLY THE STRING ONE COST A LIVE RUN. The call
  //   is made with `llm.output_format: 'json'`, so the layer PARSES the reply
  //   and hands back the object as the body — there is no `response` string to
  //   read. The first cut reached for `body.response`, got `undefined`, and
  //   returned null on a brief the model had produced PERFECTLY
  //   (`keys: [constraints, findings, intent, pending]`). The silent fallback
  //   then did its job and the turn ran unbriefed, so nothing looked wrong.
  //
  //   🔑 A WIRING BUG WAS INDISTINGUISHABLE FROM A MODEL FAILURE, which is the
  //   exact risk the silent fallback carries. Accepting both shapes is the fix;
  //   the string path stays because providers differ and `coerceAIOutput`
  //   exists for that reason.
  const parsed: unknown = ((): unknown => {
    if (raw !== null && typeof raw === 'object') return raw;
    const text = typeof raw === 'string' ? raw : '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  })();
  if (parsed === null || typeof parsed !== 'object') return null;
  const outer = parsed as Record<string, unknown>;
  // ⚠ THE MODEL MIRRORS THE PACKET. `buildBriefPrompt` names the four fields
  //   under an `emit` key, and qwen3.7-plus sometimes replies with that same
  //   key wrapped around them — `{"emit":{"intent":…}}` — which parsed as a
  //   brief with every field missing. Same class as the markdown fence the
  //   AIOutput parser already tolerates (2026-06-08): the instruction says one
  //   thing, the model echoes the shape it was shown, and the parser is the
  //   reliable place to absorb it.
  //
  //   ⛔ DESCEND ONE LEVEL, AND ONLY WHEN THE OUTER OBJECT HAS NO `intent` OF
  //   ITS OWN. A present-but-wrong-typed field must still FAIL rather than be
  //   masked by a nested copy — the same limit `coerceAIOutput` carries, which
  //   fills only MISSING fields and never overrides a present bad one.
  const emit = outer['emit'];
  const o: Record<string, unknown> =
    !('intent' in outer) && emit !== null && typeof emit === 'object'
      ? (emit as Record<string, unknown>)
      : outer;
  // ⛔⛔ THE MODEL ECHOES THE SCHEMA BLOCK BACK AS THE VALUES, and only three
  //   of the four fields catch it BY LUCK OF THEIR TYPE. Observed on task 343
  //   (2026-09-07): fields came back holding their own description —
  //   `constraints: 'string[] — NEW values, facts and STANDING RULES …'` —
  //   which `strings()` refuses only because a string is not an array.
  //
  //   ⛔ `intent` IS GUARDED BY `typeof === 'string'` ALONE, SO THE SAME ECHO
  //   PASSES IT, and that is the field least able to survive being wrong. It is
  //   the only one that cannot be RECOMPUTED — findings can be re-fetched,
  //   `pending` is regenerated each fold, but no tool returns "what the user
  //   asked for" and the trim ladder evicts the turn that stated it. Observed
  //   live (report 2026-09-08T01-37-30, run 2 brief 4): intent echoed ALONE
  //   with all three arrays well-formed, a brief the parser accepted. Because
  //   `mergeBriefs` takes the newest NON-EMPTY intent, that placeholder wins
  //   the ternary and overwrites the anchor for every later fold.
  //
  //   🔑 SO AN ECHOED INTENT IS EMPTIED, NOT A REASON TO DROP THE BRIEF —
  //   exactly as `stripAliasBearing` already rules for an alias-bearing intent
  //   ("the facts are still worth keeping"). Empty is the one value that is
  //   SAFE here: the merge reads it as "nothing to say" and carries the
  //   previous intent, so the anchor survives AND the fold's real findings do
  //   too. Dropping the brief would protect the anchor equally and throw the
  //   findings away for nothing.
  //
  //   ⚠ THE PREFIX IS OURS, NOT A HEURISTIC, AND IT IS THE ONLY THING CHECKED.
  //   `buildBriefPrompt` renders the schema as `{field: '<type> — <desc>'}`, so
  //   this tests a format THIS FILE emits, not the wording, which is tuned
  //   often. Nothing else is asked of `intent`: it stays a plain string with no
  //   format to satisfy, because it is the last field we want the model to be
  //   able to get wrong.
  const isSchemaEcho = (v: string): boolean => /^string(\[\])? — /.test(v);
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  const rawIntent = typeof o['intent'] === 'string' ? o['intent'] : null;
  const intent = rawIntent !== null && isSchemaEcho(rawIntent) ? '' : rawIntent;
  const constraints = strings(o['constraints']);
  const pending = strings(o['pending']);
  const findings = strings(o['findings']);
  if (intent === null || constraints === null || pending === null || findings === null) {
    return null;
  }
  // ⛔ `completed` IS DELIBERATELY NOT READ FROM THE MODEL. It is a record of
  //   what the SERVER dispatched, derived in `completedActionRecords` from
  //   `status: 'ok'` on the folded calls. Letting a reply supply it would put
  //   the one field that exists to stop re-execution under the control of the
  //   thing that re-executes — and this model has already been observed filing
  //   a COMPLETED write as outstanding work.
  return { intent, constraints, pending, findings, completed: [] };
};

/** Render a brief for the packet — one synthetic prior-tool-call-shaped entry
 *  so the model reads it where its results used to be, not somewhere new. */
/** Drop anything from a brief that carries a PII alias, BEFORE it persists.
 *
 *  ⛔⛔ THIS IS THE WHOLE REASON A RECALL-BEARING TURN CAN BE BRIEFED AT ALL, AND
 *  IT RESTS ON A PROPERTY THE SUBSTRATE ALREADY HAS. `chat-pii-slot-ordering.ts`
 *  is explicit that live turns were never wrong because *"no alias ever crossed
 *  a restart boundary in a resolvable position"* — `restoreChatAiResult` runs in
 *  the same request that allocated. A persisted brief holding `pii.Person1`
 *  would be the FIRST thing in the system to break that, changing the threat
 *  model rather than fitting into it.
 *
 *  ⚠ D-167's deterministic slot ordering makes numbering stable across
 *  restarts, and it is TEMPTING to conclude that makes a persisted alias safe.
 *  Its own docstring refuses that reading: *"This is a transparency/legibility
 *  fix, not a leak fix."* It was not designed to make aliases durable, so it
 *  cannot be leaned on to do it.
 *
 *  🔑 SO THE BRIEF SEES RECALLED CONTENT AND REMEMBERS NONE OF IT. The call
 *  carries the turn's `recall_context` (satisfying the egress guard, aliased by
 *  the same pass as every other packet), the model reasons over the full
 *  picture, and anything alias-bearing is dropped before the result is stored.
 *  Alias-free facts — a cost, a total, a rule the user stated — survive.
 *
 *  ⚠ `hasPotentialPiiAliasLiteral` is the substrate's own CONSERVATIVE gate: it
 *  over-reports rather than under. That is the correct direction here — a
 *  dropped finding costs a carry, a kept alias costs a mis-binding — and it is
 *  the reason this uses the shared detector instead of a local pattern that
 *  would drift from what the egress actually allocates. */
export const stripAliasBearing = (
  brief: RollingBrief,
  hasAlias: (text: string) => boolean,
): { readonly brief: RollingBrief; readonly dropped: number } => {
  let dropped = 0;
  const keep = (xs: readonly string[]): string[] => xs.filter((x) => {
    if (!hasAlias(x)) return true;
    dropped += 1;
    return false;
  });
  const constraints = keep(brief.constraints);
  const findings = keep(brief.findings);
  const pending = keep(brief.pending);
  // ⚠ Machine-derived, but NOT exempt: a record carries the call's own summary
  //   text, and this model was measured writing `pii.Person1.dana.reyes` into
  //   a `memory.write` summary. Server-authored is not the same as alias-free.
  const completed = keep(brief.completed);
  // ⚠ `intent` is the user's own words, not tool output — but it is checked too,
  //   because a model paraphrasing a recalled name into the intent line would
  //   persist an alias by the back door. An alias-bearing intent is emptied
  //   rather than dropping the brief: the facts are still worth keeping.
  const intent = hasAlias(brief.intent) ? ((dropped += 1), '') : brief.intent;
  return { brief: { intent, constraints, findings, pending, completed }, dropped };
};

/** Per-call timeout for the brief's model call, in milliseconds.
 *
 *  ⛔⛔ THE ONLY CHAT CALL THAT EARNS A TIMER, AND THE POLICY IT OPTS OUT OF IS
 *  RIGHT FOR EVERY OTHER ONE. `packages/llm/src/timeout.ts` installs no timer by
 *  default because aborting mid-stream does not un-bill the tokens already
 *  generated: on the main turn you would burn the user's money AND throw away
 *  the answer they asked for. "Equivalent to setting money on fire."
 *
 *  🔑 THE BRIEF INVERTS THE TRADE. Its result is OPTIONAL — a failed fold logs
 *  `rolling brief unusable` and the turn continues unbriefed, working exactly
 *  as it did before the mechanism existed — but its latency sits on the USER'S
 *  critical path. It is the one call where abandoning costs almost nothing and
 *  waiting costs the whole turn. Billing is unchanged either way; what a timer
 *  buys is that the turn survives.
 *
 *  ⚠ SIZED FROM MEASURED CALLS, NOT GUESSED. 250 brief calls across every
 *  stored bench report: median 23.9s, p90 35.4s, p99 60.0s, max 65.1s. This is
 *  ~2x the slowest one that ever RETURNED, so a brief hitting it has not merely
 *  been slow. The motivating failure is one that never returned at all — bench
 *  report 2026-09-08T01-37-30 run 0, still open when the harness cut the turn
 *  at 360s, which voided the whole run. Main-turn calls legitimately reach
 *  303.9s, which is why this is on the brief ALONE and not the executor. */
export const BRIEF_CALL_TIMEOUT_MS = 120_000;

/** Should a failed CLOSING fold fail the turn?
 *
 *  ⛔⛔ EXTRACTED SO THE RULE IS TESTABLE. Inline in `runChatTurn` it was
 *  covered by nothing — reverting it to silent degradation turned zero tests
 *  red, which is a poor state for a change whose entire purpose is that a
 *  failure must not pass unnoticed.
 *
 *  ⛔ ONLY THE CLOSING FOLD. A mid-turn fold that fails is repaired by the
 *  turn-end fold, which runs regardless and reads the same `user_request`. The
 *  closing fold has no successor, so its failure is the only one that loses a
 *  user statement irrecoverably — `chat_tail` is 3 rows, fixed, so the
 *  statement is gone from the packet within ~2 turns.
 *
 *  ⚠ Gated on `propagate_typed_errors` because a caller that cannot receive a
 *  typed error would otherwise get an unhandled throw instead of a degraded
 *  turn, which is strictly worse than the behaviour being replaced. */
export const shouldFailOnCaptureFailure = (input: {
  readonly closing: RollingBrief | null;
  readonly isClosingFold: boolean;
  readonly propagateTypedErrors: boolean;
}): boolean => (
  input.closing === null
  && input.isClosingFold
  && input.propagateTypedErrors
);

/** Does this brief carry a goal? A brief with no `intent` is anchorless.
 *
 *  ⛔⛔ THE FALLBACK THAT MAKES AN EMPTY INTENT SAFE IS NOT UNIVERSAL. Two paths
 *  empty `intent` rather than dropping the brief — `stripAliasBearing` for an
 *  alias-bearing one, `parseBrief` for one that echoes the schema — and both
 *  rely on `mergeBriefs` reading '' as "nothing to say" and carrying the
 *  previous value. On the FIRST brief there is no previous: `mergeBriefs(null,
 *  produced)` returns `produced` untouched, and '' is simply the intent.
 *
 *  🔑 `intent` IS THE ONE FIELD THAT CANNOT BE RECOMPUTED. Findings can be
 *  re-fetched and `pending` is regenerated every fold, but no tool returns what
 *  the user asked for, and the trim ladder evicts the turn that said it. So the
 *  caller refuses to PERSIST an anchorless brief: refusing leaves the turn
 *  unfolded with that turn still in the window, where the goal can still be
 *  captured. Persisting one folds first and asks a later brief to restate an
 *  intent it can no longer see. */
export const hasAnchor = (brief: RollingBrief): boolean =>
  brief.intent.trim().length > 0;

/** Fold a newly-produced brief onto the one it inherits.
 *
 *  ⛔⛔ THE MODEL IS NO LONGER ASKED TO RE-EMIT WHAT IT ALREADY PRODUCED, AND
 *  THAT IS THE WHOLE FIX. Every brief received the SAME instruction — rank by
 *  recoverability, findings are re-readable so they are the first thing to drop
 *  — and `carried_forward` was just more input to that ranking. There was no
 *  notion that a carried fact had already been paid for, so the model dropped
 *  inherited findings exactly as instructed.
 *
 *  Measured 2026-09-06: brief 1 held rings 01, 02, 03, 04. Brief 2 was handed
 *  brief 1 plus five new results and came back with rings 03 and 04 ONLY,
 *  filing 01 and 02 as `pending`. The model then obeyed its own brief and
 *  re-read them — so the re-fetch loop was not the model ignoring the brief, it
 *  was the model OBEYING a brief that had forgotten. Brief 3 restored all four,
 *  which is decay and recovery by luck, not a mechanism.
 *
 *  🔑 SO THE RECURRENCE MOVES OUT OF THE PROMPT AND INTO CODE. The model does
 *  ONE job — summarise what is NEW — and the union is deterministic. A fact
 *  cannot be dropped by a summariser that is never asked to repeat it.
 *
 *  ⚠ THE FIELDS MERGE DIFFERENTLY, AND THE ASYMMETRY IS DELIBERATE:
 *    - `constraints` and `findings` UNION. Once true, still true; these are the
 *      facts the brief exists to protect, and they only ever accumulate.
 *    - `pending` REPLACES. It is current STATE, not an accumulation — unioning
 *      it would leave finished work outstanding forever, which is how a model
 *      ends up redoing what it has already done.
 *    - `intent` takes the newest non-empty. The user's ask evolves across
 *      turns; the latest statement of it is the live one. */
/** Does this finding carry anything the model could not obtain in one call?
 *
 *  ⛔ A BARE RECORD ID IS NOT A FINDING. `work.search` returns ids on demand and
 *  the pre-seed index names the store that holds them, so "block 01 note id
 *  8e5af6ae-…" costs a carried slot forever to save a lookup the model has to
 *  do anyway before it can use the id. 12 of 22 findings in the measured run
 *  were exactly this, 1,476 b of a 4,810 b carry.
 *
 *  ⚠ CONSERVATIVE ON PURPOSE: a finding that carries an id AND a value keeps
 *  its slot. "block 01 (id 8e5af6ae-…) checkpoint cost: 137 units" is a fact
 *  with provenance attached, and dropping it to save the uuid would throw away
 *  the number. Only an id with NO other content is refused. */
export const isSubstantiveFinding = (finding: string): boolean => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // Nothing is dropped unless an identifier is actually present. A finding with
  // no id is always kept, whatever else it says.
  if (!UUID.test(finding)) return true;
  const residual = finding.replace(new RegExp(UUID.source, 'gi'), ' ');
  // ⚠ THE DISCRIMINATOR IS A 3+ DIGIT RUN, AND 2 IS NOT ENOUGH. An entity label
  //   carries small ordinals — "block 01", "ring 05" — so a 2-digit test reads
  //   every id line as a value and the filter drops nothing. Amounts, costs and
  //   counts worth carrying are three digits or more in every observed finding.
  //   The cost of the cut-off is a 2-digit value that shares a line with an id;
  //   it is recomputable, and keeping the id line instead is the wrong error.
  return /\d{3,}/.test(residual);
};


export const mergeBriefs = (
  previous: RollingBrief | null,
  produced: RollingBrief,
): RollingBrief => {
  if (previous === null) return produced;
  const union = (a: readonly string[], b: readonly string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of [...a, ...b]) {
      const key = x.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
    return out;
  };
  return {
    intent: produced.intent.trim().length > 0 ? produced.intent : previous.intent,
    constraints: union(previous.constraints, produced.constraints),
    // ⛔⛔ FINDINGS STILL UNION, BUT THE JUNK NEVER ENTERS. They were 81% of the
    //   carry and 98% of them were not facts. Measured on the 7-fold run of task
    //   363, final carry 4,810 b: findings 3,911 b (81%), constraints 265 b (6%),
    //   intent 264 b, pending 297 b, completed 2 b. Classifying the 22 findings:
    //       12 items 1,476 b  a bare UUID ("block 01 note id 8e5af6ae-…")
    //        9 items 2,309 b  action narration ("full text read", "truncated")
    //        1 item     82 b  an extracted VALUE — the thing the field is for
    //   and `completed`, the server-derived record of performed actions, was
    //   EMPTY while findings carried that content in prose.
    //
    //   🔑 GROWTH IS WHAT KILLS THE SESSION: constraints ~30 b/fold, findings
    //   ~645 b/fold, intent/pending ~0 (they replace). `capacity_refused` fires
    //   at a ~37,300 b carry, so unioning both dies at ~55 folds — an ordinary
    //   session, not a messenger edge case.
    //
    //   ⛔ AND REGENERATING FINDINGS IS THE WRONG FIX — I TRIED IT AND THE TEST
    //   ABOVE REFUSED IT. Omission was measured at 12.4% per fold, which
    //   compounds: 26.6% of facts survive 10 folds, 7.1% survive 20. Decay
    //   empties the carry faster than capacity ends it, and silently. The union
    //   is what makes the model's silence safe, and it stays.
    //
    //   ⇒ SO FILTER THE INPUT INSTEAD OF WEAKENING THE MERGE. A finding whose
    //   only content is a record id carries nothing the model can act on — it
    //   cannot use `8e5af6ae-…` without a read, and `work.search` returns ids on
    //   demand. Dropped in CODE because the instruction is the half that does
    //   not hold: five instruction variants moved this model's brief behaviour
    //   not at all (all paired contrasts p=1.0). The narration half (60%) has no
    //   safe deterministic test, so the instruction asks and this does not
    //   enforce — an honest split, not a complete one.
    findings: union(
      previous.findings.filter(isSubstantiveFinding),
      produced.findings.filter(isSubstantiveFinding),
    ),
    // ⛔⛔ OMISSION REMOVES NOTHING. `pending` used to be REPLACED by whatever
    //   the model emitted, so an item it simply failed to restate was DELETED —
    //   measured at 12.4% of carried tasks destroyed that way. It now UNIONS and
    //   shrinks only on an explicit `retired` claim, so the model's silence
    //   preserves work instead of discarding it.
    //
    //   🔑 THE MODEL IS NO MORE RELIABLE UNDER THIS DESIGN; ITS UNRELIABILITY IS
    //   JUST CHEAPER. Retire precision measured 72-81% across five instruction
    //   variants (all null against each other — wording does not move it), so
    //   roughly a quarter of claims are wrong. But a wrong retire requires an
    //   ACTIVE false claim, while the old failure needed only forgetting:
    //   wrong-deletion fell to 5.5-8.8% against omission's 12.4% in every arm.
    // ⛔⛔ REGENERATED, NOT CARRIED — AND I HAD THIS BACKWARDS FOR MOST OF A DAY.
    //   `pending` is a piece of BRIEF INFO the model produces each fold from the
    //   state it can see; it was never a durable, movable object. It is
    //   RE-DERIVABLE: `intent` says the goal and `findings` says what is known,
    //   so "what is left" follows from the two fields that ARE carried.
    //
    //   🔑 THE MEASUREMENT THAT MISLED ME. I scored carried `pending` items that
    //   vanished as "12.4% silently deleted" and built a union plus a `retired`
    //   op to stop it. They were not deletions — they were the model correctly
    //   re-assessing a shorter list. The union then guaranteed the opposite
    //   failure and I did not measure it: task 343 briefs went 2 -> 4 -> 6 -> 8
    //   items with six already done, an undifferentiated backlog the model
    //   cannot act on. The one brief that worked cleanly emitted `pending: []`.
    //
    //   ⚠ SAME RULE, THIRD APPLICATION. A read earns a carried slot only if it
    //   cannot be recomputed (receipts); a WRITE earns one because re-running it
    //   is not free (`completed`); a DERIVED VIEW earns none at all. `pending`
    //   is the third case, and treating it as the first is what produced the
    //   retirement machinery that never fired.
    pending: produced.pending,
    // ⛔ UNIONS, NEVER REPLACES. A completed act stays completed; this is the
    //   one field where forgetting causes the work to happen AGAIN rather than
    //   merely being looked up again.
    completed: union(previous.completed, produced.completed),
  };
};

/** Prefix identifying the incompleteness note this module writes into
 *  `pending`. Exported so the note can be recognised and replaced rather than
 *  stacked — two notes would double-count one gap. */
export const UNFOLDED_PENDING_PREFIX = 'Unfolded from an earlier turn:';

/** Keep a carry that could not be extended, and say so in `pending`.
 *
 *  ⛔⛔ THIS REPLACES A `clearSessionBrief` THAT DESTROYED VERIFIED FACTS. The
 *  turn-end fold used to wipe the whole session carry whenever its closing
 *  brief failed to parse, reasoned as "a stale brief is worse than no brief".
 *  That collapsed two different things:
 *
 *    - STALE      — the brief's claims are now FALSE.
 *    - INCOMPLETE — the brief's claims are all still TRUE; it just does not
 *                   cover the newest results.
 *
 *  A failed fold produces the second, never the first. `findings` and
 *  `constraints` are monotone accumulations of established fact — ring 01
 *  costing 137 units does not become false because a LATER brief failed to
 *  parse. Only `pending` is current state, which is exactly why `mergeBriefs`
 *  replaces that field and unions the others.
 *
 *  🔑 MEASURED, NOT REASONED (2026-09-06, task 343). Brief 4 held rings 01, 02,
 *  05 and 06 and emitted `{"emit":{…}}` — the schema wrapper echoed back — so
 *  `parseBrief` refused it and the carry was cleared. Brief 5 opened with
 *  nothing, and the turn-7 answer was "I don't have the individual costs for
 *  rings 01 through 08 in my current context". Clearing GUARANTEED the loss it
 *  was meant to prevent; the facts it threw away were never in question.
 *
 *  ⚠ The original worry was real and is what the note answers: a carry that
 *  silently omits a turn tells the model it has everything. So the facts stay
 *  and the GAP is declared, in the one field whose job is to say what is still
 *  outstanding. */
export const markCarryIncomplete = (
  previous: RollingBrief | null,
  unfoldedCount: number,
): RollingBrief | null => {
  if (previous === null || unfoldedCount <= 0) return previous;
  return {
    ...previous,
    pending: [
      ...previous.pending.filter(
        (entry) => !entry.startsWith(UNFOLDED_PENDING_PREFIX),
      ),
      `${UNFOLDED_PENDING_PREFIX} ${String(unfoldedCount)} tool result(s) could `
      + 'not be folded into this brief. Everything above is still accurate, but '
      + 'it does NOT cover that work — re-read anything you need from it rather '
      + 'than treating this brief as complete.',
    ],
  };
};

/** Derive the `completed` records for a fold, from the dispatches themselves.
 *
 *  ⛔⛔ THE PREDICATE IS `!== 'read'`, NOT `=== 'write'`, AND THE OBVIOUS ONE
 *  MISSES THE MOTIVATING CASE. `TIER1_CLASSIFICATIONS['memory.write']` is
 *  **`'unknown'`**, not `'write'` — deliberately, per D-198 §3: a memory write
 *  is soft, reversible and grant-gated, and `unknown` opts it out of the
 *  plan-approval gate so a granted customer can contribute autonomously. So the
 *  single tool whose re-execution produced the measured failure is not labelled
 *  a write at all. Anything not KNOWN to be a read is treated as potentially
 *  side-effecting, which also fails in the safe direction: a read wrongly
 *  recorded costs one line in the brief; a write wrongly omitted costs a
 *  re-execution.
 *
 *  ⚠ Only `status: 'ok'` calls are recorded. A refused call did NOT happen, and
 *  recording it would tell the model its work was done when nothing was
 *  written — the inverse failure, and a worse one. */
/** Is this fold's turn recall-bearing? Combines the AUTHORITATIVE per-turn
 *  signal with the fold-slice scan.
 *
 *  ⛔⛔ EXTRACTED SO THE COMPOSITION IS TESTABLE, NOT JUST THE RULE. The first
 *  cut of this fix computed it inline in the executor and the unit tests called
 *  `shouldBrief` directly — so reverting the executor to the slice-only signal
 *  left the whole suite GREEN. That is the same shape this module's own
 *  `FORCE_WAIVABLE_OUTCOMES` docstring already records: a rule enforced at one
 *  end and bypassed at the other, with a passing test at the end that was not
 *  the one that mattered.
 *
 *  🔑 WHY THE OR. `registered` is per-TURN and monotonic — once a recall result
 *  lands, every packet in the turn must carry a valid `recall_context` for the
 *  rest of the turn. `sliceHasRecall` sees only the calls THIS fold consumes,
 *  and the first fold empties the accumulator, so every later slice reads clean
 *  while the turn is still bound. The slice arm is kept because it can see a
 *  recall the per-turn state has not registered yet, and because a caller that
 *  wires no signal must keep today's behaviour. */
export const isFoldRecallBearing = (input: {
  readonly registered?: boolean;
  readonly sliceHasRecall: boolean;
}): boolean => input.registered === true || input.sliceHasRecall;

export const completedActionRecords = (
  calls: readonly ChatPriorToolCall[],
): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.status !== 'ok') continue;
    const classification = (
      TIER1_CLASSIFICATIONS as Readonly<Record<string, 'read' | 'write' | 'unknown'>>
    )[call.tool_name];
    if (classification === 'read') continue;
    // The brief's own synthetic entry is not an action the model took.
    if (call.tool_name === 'context.brief') continue;
    const args = call.args as Record<string, unknown> | null | undefined;
    // `summary` is what makes the record connectable to the `pending` item it
    // should retire; the bare tool name was too thin to link them.
    const summary = args !== null && typeof args === 'object'
      && typeof args['summary'] === 'string'
      ? args['summary']
      : undefined;
    const record = summary === undefined
      ? `${call.tool_name} — completed`
      : `${call.tool_name} — completed: ${summary.slice(0, 160)}`;
    const key = record.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
};

/** Attach newly-derived completed-action records to a folded brief. Runs AFTER
 *  `mergeBriefs`, so the inherited records survive and the new ones join them. */
export const withCompletedActions = (
  brief: RollingBrief,
  calls: readonly ChatPriorToolCall[],
): RollingBrief => {
  const fresh = completedActionRecords(calls);
  if (fresh.length === 0) return brief;
  const seen = new Set(brief.completed.map((x) => x.toLowerCase()));
  const added = fresh.filter((x) => !seen.has(x.toLowerCase()));
  return added.length === 0
    ? brief
    : { ...brief, completed: [...brief.completed, ...added] };
};

export const briefAsPriorToolCall = (brief: RollingBrief): ChatPriorToolCall =>
  ({
    tool_name: 'context.brief',
    tier: 1,
    args: {},
    status: 'ok',
    result: {
      note:
        'Your earlier tool results for this turn were compressed into this '
        + 'brief to fit the context window. They are gone; this is what you '
        + 'kept. Work from it — re-running those calls will produce results '
        + 'too large to keep and they will be compressed again. '
        // ⛔ THE ONE THING THE MODEL MUST NOT INFER FROM AN ABSENT RESULT. A
        //   read it repeats is merely wasteful; a WRITE it repeats happens
        //   twice. `completed` lists calls that already SUCCEEDED — measured
        //   live, a model that lost this record re-attempted a completed
        //   `memory.write`, invented an identifier for it, and burned the turn.
        + '`completed` lists actions that ALREADY SUCCEEDED in this turn. Do '
        + 'not perform them again — treat any pending item they satisfy as '
        + 'done.',
      ...brief,
    },
  }) as unknown as ChatPriorToolCall;

// ────────────────────────────────────────────────────────────────
// Cross-turn carry
// ────────────────────────────────────────────────────────────────

/** Briefs held between turns, by session.
 *
 *  ⛔⛔ WITHOUT THIS THE MECHANISM CANNOT DO ITS JOB, AND THE FIRST LIVE RUN
 *  PROVED IT. `runChatTurn` is called once per USER TURN, so a brief scoped
 *  inside it starts every turn at null — "rolling" rolled only within a turn.
 *  Measured 2026-09-06: turn 1's brief carried the user's 252-unit surcharge
 *  correctly; turn 2's brief began with no predecessor and its `constraints`
 *  came back EMPTY. The run still passed, because the model's own prose in the
 *  chat tail happened to carry the number — which is luck, not the mechanism,
 *  and is exactly what fails under a budget tight enough to evict the tail.
 *
 *  ⚠ MODULE-LEVEL STATE, AND DELIBERATELY MINIMAL. This is flag-gated
 *  experiment scaffolding: it is bounded, it is not durable, and it does not
 *  survive a restart. A shipped version belongs in the chat store beside the
 *  turn it describes — the constraint a brief protects is exactly the kind of
 *  thing that must not evaporate on a process bounce. */
const SESSION_BRIEFS = new Map<string, RollingBrief>();
/** Bound, so a long-lived server cannot accumulate briefs for every session it
 *  has ever seen. Insertion-ordered, so the oldest goes first. */
const SESSION_BRIEF_LIMIT = 32;

export const getSessionBrief = (session_id: string): RollingBrief | null =>
  SESSION_BRIEFS.get(session_id) ?? null;

export const setSessionBrief = (session_id: string, brief: RollingBrief): void => {
  SESSION_BRIEFS.delete(session_id);
  SESSION_BRIEFS.set(session_id, brief);
  while (SESSION_BRIEFS.size > SESSION_BRIEF_LIMIT) {
    const oldest = SESSION_BRIEFS.keys().next();
    if (oldest.done === true) break;
    SESSION_BRIEFS.delete(oldest.value);
  }
};

/** Drop a session's carry.
 *
 *  ⛔ Called when a turn ends with results that could NOT be folded. Leaving the
 *  previous brief in place would hand the next turn a carry-forward that claims
 *  completeness while missing a turn's work — and a stale brief is worse than
 *  none, because without one the model knows it has nothing. */
export const clearSessionBrief = (session_id: string): void => {
  SESSION_BRIEFS.delete(session_id);
};

/** Test seam — the map is module state and would otherwise leak between cases. */
export const __clearSessionBriefs = (): void => { SESSION_BRIEFS.clear(); };

/** ⛔⛔ USER STATEMENTS FROM TURNS THAT NEVER GOT A FOLD.
 *
 *  The closing fold runs only when a turn did RETAINABLE tool work. Measured
 *  across 844 bench turns: 65% qualify, 8% are recall-only (declined), and
 *  **27% did no tool work at all** — for those the fold never runs, no trail
 *  line is written, and `buildBriefPrompt` only ever receives the CURRENT
 *  turn's `user_message`. So a rule the user stated on a tool-free turn is
 *  captured by NOTHING, and `chat_tail` (3 rows, fixed) forgets it in ~2 turns.
 *
 *  🔑 THAT IS THE FIELD THE INSTRUCTION CALLS UNRECOVERABLE — *"no tool can
 *  return these"*. A tool result can be re-read; a user's "the levy is now 340"
 *  cannot. So the message ACCUMULATES here and the next fold — whenever it
 *  fires — ingests the backlog. Accumulating rather than forcing a fold on
 *  every tool-free turn keeps the cost at zero extra model calls.
 *
 *  ⚠ ON OVERFLOW THE OLDEST ARE KEPT, NOT THE NEWEST — the reverse of the usual
 *  ring-buffer instinct, and deliberately so: the NEWEST messages are still in
 *  `chat_tail`, so dropping them loses nothing the fold cannot still see. The
 *  oldest are the ones the tail has already forgotten. */
interface PendingStatement {
  readonly text: string;
  /** The append ordinal when this was recorded. Age is measured in APPENDS —
   *  i.e. user turns — not wall time, which is the same axis `chat_tail` uses
   *  and the reason the tail degrades gracefully across a resumed session. */
  readonly seq: number;
}
const SESSION_UNFOLDED_MESSAGES = new Map<string, PendingStatement[]>();
const SESSION_STATEMENT_SEQ = new Map<string, number>();

/** ⛔⛔ HOW LONG A STATEMENT MAY SIT UNCLASSIFIED.
 *
 *  The backlog is a HOLDING PEN, not a store: it keeps a user statement visible
 *  until a fold can decide whether it is DURABLE (a levy, a standing rule →
 *  `constraints`) or merely conversational ("read blocks 3 and 4").
 *
 *  ⛔ WITHOUT A DEADLINE THE PEN ASSERTS RELEVANCE IT HAS NOT EARNED. A
 *  statement would ride every packet until some fold happened to run — so a
 *  session resumed a month later would still be carrying an unclassified line
 *  from before, which is STRICTLY WORSE than `chat_tail`: the tail would have
 *  let it go. The tail degrades gracefully because it never claims more than
 *  "this was just said".
 *
 *  🔑 SO THE DEADLINE IS WHERE THE FOLD EARNS ITS PLACE. When a statement is
 *  about to age out unclassified, a fold is exactly the right spend: the content
 *  is USER-STATED and therefore unrecoverable (measured on 363 — brief OFF 0/2,
 *  ON 2/2), and one call converts "held indefinitely" into "durable or dropped".
 *  That is far rarer than folding on every tool-free turn, which is the cost
 *  this backlog exists to avoid. */
export const MAX_PENDING_STATEMENT_TURNS = 3;
/** Per-session ceiling. Generous enough that overflow is rare (a fold clears
 *  the list), small enough that the backlog cannot dominate the fold's input. */
export const UNFOLDED_MESSAGE_LIMIT = 12;
export const UNFOLDED_MESSAGE_BYTES = 4096;

/** Record a user message as not-yet-folded. No-op for blank input. */
export const appendUnfoldedUserMessage = (
  session_id: string,
  message: string,
): void => {
  if (message.trim().length === 0) return;
  const seq = (SESSION_STATEMENT_SEQ.get(session_id) ?? 0) + 1;
  SESSION_STATEMENT_SEQ.set(session_id, seq);
  const list = SESSION_UNFOLDED_MESSAGES.get(session_id) ?? [];
  list.push({ text: message, seq });
  // Keep the OLDEST — see the note above; the tail still holds the newest.
  while (
    list.length > UNFOLDED_MESSAGE_LIMIT
    || list.map((e) => e.text).join('').length > UNFOLDED_MESSAGE_BYTES
  ) {
    if (list.length <= 1) break;
    list.pop();
  }
  SESSION_UNFOLDED_MESSAGES.set(session_id, list);
  // ⛔⛔ THE SAME PER-SERVER BOUND `SESSION_BRIEFS` ALREADY HAS, AND ITS ABSENCE
  //   HERE WAS THE BUG. That map caps itself at `SESSION_BRIEF_LIMIT` with the
  //   reason stated outright — "so a long-lived server cannot accumulate briefs
  //   for every session it has ever seen" — while this one bounded only the
  //   CONTENT of a session (12 messages / 4 KB) and never the NUMBER of
  //   sessions. The pen is cleared only by a SUCCESSFUL fold, so every session
  //   that ends without one left up to 4 KB resident until the process bounced.
  //   ⇒ when two stores hold the same kind of per-session scratch and only one
  //   is bounded, the unbounded one is the defect, not the design.
  //
  //   ⚠ Evicting drops an unclassified statement. That is the same trade
  //   `setSessionBrief` already makes, on the least-recently-touched session —
  //   and an unbounded map is the worse failure.
  while (SESSION_UNFOLDED_MESSAGES.size > SESSION_BRIEF_LIMIT) {
    const oldest = SESSION_UNFOLDED_MESSAGES.keys().next();
    if (oldest.done === true) break;
    SESSION_UNFOLDED_MESSAGES.delete(oldest.value);
    SESSION_STATEMENT_SEQ.delete(oldest.value);
  }
};

/** The un-folded backlog, oldest first. Does NOT clear — a fold that fails must
 *  not silently consume the statements it failed to record. */
export const peekUnfoldedUserMessages = (
  session_id: string,
): readonly string[] =>
  (SESSION_UNFOLDED_MESSAGES.get(session_id) ?? []).map((e) => e.text);

/** How many user turns the OLDEST unclassified statement has been waiting, or 0
 *  when the pen is empty. See {@link MAX_PENDING_STATEMENT_TURNS}. */
export const oldestPendingStatementAge = (session_id: string): number => {
  const list = SESSION_UNFOLDED_MESSAGES.get(session_id) ?? [];
  const first = list[0];
  if (first === undefined) return 0;
  return (SESSION_STATEMENT_SEQ.get(session_id) ?? first.seq) - first.seq;
};

/** True when a statement has waited too long to be classified — the point at
 *  which a fold is worth its cost rather than a waste. */
export const hasStalePendingStatement = (session_id: string): boolean =>
  oldestPendingStatementAge(session_id) >= MAX_PENDING_STATEMENT_TURNS;

/** Clear the backlog — call ONLY after a fold has successfully stored a brief
 *  that ingested it.
 *
 *  ⛔ DROPS THE SEQ COUNTER TOO. It used to delete only the message list, so
 *  `SESSION_STATEMENT_SEQ` kept one entry per session FOREVER — never cleared
 *  anywhere in production, only by the test helper below. Tiny per session and
 *  strictly unbounded across them, on a server designed to run for months.
 *  ⚠ Safe to reset: the age is a DIFFERENCE within the pen
 *  (`current_seq - first.seq`), so a counter restarting at 1 beside an empty
 *  list yields the same 0 as one continuing from 7. */
export const clearUnfoldedUserMessages = (session_id: string): void => {
  SESSION_UNFOLDED_MESSAGES.delete(session_id);
  SESSION_STATEMENT_SEQ.delete(session_id);
};

/** A user-stated FIGURE the brief does not carry. Three digits or more.
 *
 *  ⛔⛔ THE THRESHOLD IS A HEURISTIC AND ITS BLIND SPOTS ARE REAL — stated here
 *  rather than discovered later. It protects the class that measurably fails
 *  (318 / 274 / 145 / 226 / 252 — user-stated charges no tool can return) and
 *  excludes the class that would jam the pen open (`blocks 05 and 06`, `ring
 *  04` — one- and two-digit ordinals that appear in almost every turn and are
 *  never durable). It does NOT protect a two-digit value ("the fee is 40
 *  units") or a non-numeric standing rule ("never email the broker"). Those
 *  stay at the mercy of the fold's judgement, exactly as before.
 *
 *  🔑 WHY NOT PROTECT EVERYTHING: a statement is retained until something
 *  promotes it, so a rule that retains conversational turns would never clear
 *  the pen — it would ride every packet until the 4 KB cap, spending tokens on
 *  "read blocks 05 and 06" forever. The asymmetry says protect the
 *  unrecoverable and let the rest go. */
const unpromotedFigures = (text: string, carried: string): readonly string[] =>
  [...new Set(text.match(/\b\d{3,}\b/g) ?? [])].filter((v) => !carried.includes(v));

/** Clear the backlog of everything the fold DEMONSTRABLY carried, and keep what
 *  it did not.
 *
 *  ⛔⛔ IT USED TO CLEAR THE WHOLE PEN ON ANY SUCCESSFUL FOLD, and that is how a
 *  user-stated charge was lost at 40 turns (bench 377). The pen is the ONLY
 *  unmediated copy of what the owner said — `appendUnfoldedUserMessage` takes
 *  the raw `user_message` at turn start, no model in the loop — while
 *  `constraints` is the model's INTERPRETATION of it (measured: just 10% of
 *  constraint entries are exact substrings of a user message; 66% near-copies;
 *  25% genuinely reworded). Discarding the verbatim copy because a fold
 *  SUCCEEDED conflates "a brief was produced" with "this statement is in it".
 *
 *  🔑 THE OLD RULE WAS WRITTEN FOR A COMPRESSION FEATURE, where clearing eagerly
 *  is free and the worst case is re-summarising. For a retention feature the
 *  worst case is silent loss of the one thing nothing can re-derive.
 *
 *  ⚠ RETAINED STATEMENTS ARE RE-OFFERED to the next fold, which is the recovery:
 *  a fold that failed to promote gets another chance rather than one attempt.
 *  Bounded by the existing 12-entry / 4 KB cap and the per-server LRU, so an
 *  entry that is never promoted still cannot accumulate without limit. */
export const clearIngestedUserMessages = (
  session_id: string,
  brief: RollingBrief,
): { cleared: number; retained: readonly string[] } => {
  const list = SESSION_UNFOLDED_MESSAGES.get(session_id) ?? [];
  if (list.length === 0) {
    SESSION_STATEMENT_SEQ.delete(session_id);
    return { cleared: 0, retained: [] };
  }
  // ⚠ The WHOLE brief, not just `constraints`: a figure the fold recorded under
  //   `findings` is carried just as durably, and treating that as unpromoted
  //   would retain a statement the brief already holds.
  const carried = JSON.stringify(brief);
  const keep = list.filter((e) => unpromotedFigures(e.text, carried).length > 0);
  if (keep.length === 0) {
    SESSION_UNFOLDED_MESSAGES.delete(session_id);
    SESSION_STATEMENT_SEQ.delete(session_id);
  } else {
    SESSION_UNFOLDED_MESSAGES.set(session_id, keep);
  }
  return {
    cleared: list.length - keep.length,
    retained: keep.map((e) => e.text),
  };
};

export const __clearUnfoldedUserMessages = (): void => {
  SESSION_UNFOLDED_MESSAGES.clear();
  SESSION_STATEMENT_SEQ.clear();
};

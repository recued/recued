/** The rolling brief's pure parts. Cheap to run, so the n=1 bench loop that
 *  follows is about MODEL behaviour rather than about whether the plumbing
 *  works. */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ChatBriefCaptureError,
  ChatContextLengthError,
} from '../chat-turn-executor.js';

import {
  partitionPriorToolCalls,
  TIER1_CLASSIFICATIONS,
  withRecallReceipts,
} from '@recued/contracts';
import type { ChatPriorToolCall } from '@recued/contracts';

import type { BriefOutcome } from '../chat-rolling-brief.js';
import {
  BRIEF_INSTRUCTION,
  FORCE_WAIVABLE_OUTCOMES,
  BRIEF_INSTRUCTION_TOKENS,
  BRIEF_MIN_CALLS,
  BRIEF_RENDERED_TOKENS,
  briefAsPriorToolCall,
  buildBriefPrompt,
  appendUnfoldedUserMessage,
  peekUnfoldedUserMessages,
  clearUnfoldedUserMessages,
  __clearUnfoldedUserMessages,
  UNFOLDED_MESSAGE_LIMIT,
  MAX_PENDING_STATEMENT_TURNS,
  oldestPendingStatementAge,
  hasStalePendingStatement,
  __clearSessionBriefs,
  clearSessionBrief,
  getSessionBrief,
  completedActionRecords,
  isFoldRecallBearing,
  markCarryIncomplete,
  mergeBriefs,
  hasAnchor,
  isSubstantiveFinding,
  shouldFailOnCaptureFailure,
  parseBrief,
  setSessionBrief,
  shouldBrief,
  stripAliasBearing,
  withCompletedActions,
  UNFOLDED_PENDING_PREFIX,
  type RollingBrief,
} from '../chat-rolling-brief.js';

const call = (bytes: number): never =>
  ({ tool_name: 'work.read', tier: 1, args: {}, status: 'ok',
     result: { body: 'x'.repeat(bytes) } }) as never;

const BRIEF: RollingBrief = {
  intent: 'total the checkpoint costs for rings 01-08 plus the surcharge',
  constraints: ['quarterly rig surcharge is 252 units (stated by the user)'],
  pending: ['add the surcharge to the running total'],
  findings: ['rings 01-08 total 1443'],
  completed: [],
};

describe('shouldBrief — derived from the ladder\'s own arithmetic', () => {
  /** The measured configuration: 40k budget, lean-core catalog, real overhead. */
  const REAL = {
    budgetTokens: 40_000, catalogTokens: 15_740, overheadTokens: 2_441,
    tailTokens: 400,
  };
  const ROOM = REAL.budgetTokens - REAL.catalogTokens - REAL.overheadTokens
    - REAL.tailTokens;  // 21,419

  it('🔑 fires ONE RESULT SHORT of the trim, not at a fraction of the room', () => {
    // Results arrive in ~4,843-est jumps, so the trigger reserves exactly one.
    // An earlier cut used "half the room" — a guess — which fires at ~2
    // accumulated results where ~3 is safe, buying an extra model round per
    // turn for nothing.
    const four = Array.from({ length: 4 }, () => call(9_600));   // ~4,800 est each
    const r = shouldBrief({ priorToolCalls: four, ...REAL });
    expect(r.brief).toBe(true);
    expect(r.reason).toMatch(/room 21419/);
  });

  // ⛔⛔ THE SECOND CEILING BINDS ON THE CARRY, NOT THE HEAD — and an earlier
  //   note here called it inert, which was wrong. The ordering is exactly
  //   `catalog − INSTR − max(RENDERED, carried)`:
  //       carried      0 → briefCapacity 36,909 vs room 21,419   ladder binds
  //       carried 16,000 → briefCapacity 21,309 vs room 21,419   BRIEF binds
  //   so it takes over once the carry passes ~15,490 est. `constraints` and
  //   `findings` union with no cap, so a long-lived session reaches that with
  //   certainty — and without the min the fold would then hand the brief call
  //   more than it can read, `capacity_refused` forever, nothing carried again.
  //
  //   ⚠ NOT PINNED BY A TEST HERE ON PURPOSE. Reaching it needs a ~16k carry
  //   fixture, which is a serialization-width artifact rather than a behaviour:
  //   the number that matters is the RELATION above, and it is asserted in the
  //   arithmetic the reason string reports. The shipped 8-turn tasks never get
  //   near it, so a fixture would pin a threshold no run exercises.
  it('does not fire while the results still fit with a result to spare', () => {
    const three = Array.from({ length: 3 }, () => call(4_000));  // ~2,000 est each
    expect(shouldBrief({ priorToolCalls: three, ...REAL }).brief).toBe(false);
  });

  it('⛔ the margin ADAPTS to what this turn is reading', () => {
    // A fixed margin under-reserves on a turn pulling large results. Same
    // accumulated bytes, different result sizes: the one whose individual
    // results are bigger must trigger earlier, because its NEXT result is
    // bigger too.
    const big = Array.from({ length: 3 }, () => call(12_000));   // ~6,000 est each
    const small = Array.from({ length: 18 }, () => call(2_000)); // ~1,000 est each
    const accBig = 3 * 6_000, accSmall = 18 * 1_000;
    expect(Math.abs(accBig - accSmall)).toBeLessThan(1_000);     // comparable totals
    expect(shouldBrief({ priorToolCalls: big, ...REAL }).brief).toBe(true);
    expect(shouldBrief({ priorToolCalls: small, ...REAL }).brief).toBe(false);
  });

  it('⛔ the margin reserves the LARGEST result, not the smallest', () => {
    // ⚠ A UNIFORM FIXTURE CANNOT TEST THIS. With equal-sized results max == min
    // and swapping them changes nothing — mutation-tested, `Math.max` → `Math.min`
    // passed every other case in this file. The point of reserving is that the
    // NEXT result may be a big one, so the margin has to be the big one.
    const mixed = [call(20_000), call(2_000), call(2_000), call(2_000)];
    //             ~10,000 est    ~1,000 each          → accumulated ~13,000
    const r = shouldBrief({ priorToolCalls: mixed, ...REAL });
    expect(r.brief).toBe(true);          // room 21,819 − largest 10,000 = 11,819 ≤ 13,000
    // ~10,041 with the JSON envelope, not exactly 10,000 — assert the band, so
    // the case pins the BEHAVIOUR rather than an incidental serialization width.
    const largest = Number(/largest (\d+)/.exec(r.reason)?.[1] ?? '0');
    expect(largest).toBeGreaterThan(9_500);
    expect(largest).toBeLessThan(10_500);
    // Reserving the SMALLEST instead would set the trigger at 20,819 and miss it,
    // leaving the turn to hit the trim with a 10,000-est result inbound.
  });

  it('⛔ REFUSES when the brief call could not READ the accumulation', () => {
    // The guard that keeps the mechanism from breaking exactly when needed: a
    // "yes, brief" on content the brief cannot hold spends a round AND
    // overflows. One enormous result — a CSV, an export — is the shape.
    const huge = Array.from({ length: 3 }, () => call(30_000));  // ~15,000 est each
    const r = shouldBrief({ priorToolCalls: huge, ...REAL });
    expect(r.brief).toBe(false);
    expect(r.reason).toMatch(/exceeds what the brief call can read/);
    // …and the capacity it checks against is the no-catalog one, which is the
    // whole reason briefing at the cliff is possible at all.
    const capacity = REAL.budgetTokens - REAL.overheadTokens
      - BRIEF_INSTRUCTION_TOKENS - BRIEF_RENDERED_TOKENS;
    expect(capacity).toBeGreaterThan(ROOM);
  });

  it('⛔ does NOT fire on a small turn — a brief costs a round', () => {
    // ⚠ SIZES CHOSEN SO THE FLOOR IS THE ONLY THING REFUSING. Two results of
    // 20,000 est each would be refused by the CAPACITY guard instead, and the
    // case would pass with the floor deleted — mutation-tested, it did. These
    // two are small enough to pass capacity and large enough to pass the
    // trigger, so only `minCalls` can say no.
    const two = [call(22_000), call(22_000)];   // ~11,000 est each
    expect(shouldBrief({ priorToolCalls: two, ...REAL }).brief).toBe(false);
    expect(shouldBrief({ priorToolCalls: two, ...REAL }).reason).toMatch(/only 2 call/);
    // …and a third identical result DOES brief, proving the refusal was the floor.
    expect(shouldBrief({ priorToolCalls: [...two, call(22_000)], ...REAL }).brief).toBe(true);
    expect(BRIEF_MIN_CALLS).toBe(3);
  });

  it('⛔ the capacity check EXCLUDES the catalog, and that is what makes it work', () => {
    // A brief call carries no tool catalog, so its capacity is ~36,909 est
    // against the main packet's 21,819. This accumulation sits BETWEEN them: it
    // must brief. Charging the catalog against the brief would refuse it — and
    // would refuse precisely the mid-sized turns the mechanism is for.
    const five = Array.from({ length: 5 }, () => call(11_000));   // ~5,500 est each
    const acc = 5 * 5_500;
    const withCatalog = REAL.budgetTokens - REAL.overheadTokens - REAL.catalogTokens
      - BRIEF_INSTRUCTION_TOKENS - BRIEF_RENDERED_TOKENS;
    const withoutCatalog = REAL.budgetTokens - REAL.overheadTokens
      - BRIEF_INSTRUCTION_TOKENS - BRIEF_RENDERED_TOKENS;
    expect(acc).toBeGreaterThan(withCatalog);      // would be refused if charged
    expect(acc).toBeLessThan(withoutCatalog);      // is fine without it
    expect(shouldBrief({ priorToolCalls: five, ...REAL }).brief).toBe(true);
  });

  it('a floor above the budget never triggers', () => {
    expect(shouldBrief({
      priorToolCalls: Array.from({ length: 9 }, () => call(9_000)),
      budgetTokens: 10_000, catalogTokens: 15_740, overheadTokens: 2_441,
      tailTokens: 400,
    }).brief).toBe(false);
  });

  it('every decision explains itself', () => {
    // The trigger is derived from four numbers; a bare boolean would make a
    // wrong threshold undebuggable from a bench report.
    for (const calls of [[call(100)], Array.from({ length: 4 }, () => call(9_600))]) {
      expect(shouldBrief({ priorToolCalls: calls, ...REAL }).reason.length).toBeGreaterThan(10);
    }
  });
});

describe('parseBrief — the schema echoed back as the values', () => {
  // Captured verbatim from task 343, report 2026-09-07T23-46-33-930Z: the model
  // replied with `buildBriefPrompt`'s own `emit` block instead of filling it in.
  const ECHO_INTENT = 'string — what the user asked for';

  it('rejects a whole-schema echo, on the array fields', () => {
    expect(parseBrief({
      intent: ECHO_INTENT,
      constraints: 'string[] — NEW values, facts and STANDING RULES the USER gave',
      pending: 'string[] — ACTIONS still to perform. Every entry must be',
      findings: 'string[] — NEW facts from tool_results_since only. Do not',
    })).toBeNull();
  });

  // ⛔ THE ONE THE TYPE GUARD MISSED, AND IT REACHED PRODUCTION. Report
  //   2026-09-08T01-37-30 run 2 brief 4: intent echoed ALONE, all three arrays
  //   well-formed and carrying real costs. Emptied, NOT dropped — the findings
  //   are worth keeping and `mergeBriefs` restores the anchor.
  it('empties an echo that lands on intent alone, keeping the facts', () => {
    const parsed = parseBrief({
      ...BRIEF,
      intent: ECHO_INTENT,
      findings: ['Ring 05 checkpoint cost: 176 units.'],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.intent).toBe('');
    expect(parsed?.findings).toEqual(['Ring 05 checkpoint cost: 176 units.']);
  });

  // ⚠ THE PROPERTY THAT MATTERS IS THE COMPOSITION, NOT THE EMPTY STRING.
  //   Blanking is only safe because the merge reads '' as "nothing to say".
  //   Drive both halves or this tests a convention instead of a guarantee.
  it('carries the previous intent through the merge, and keeps the new facts', () => {
    const parsed = parseBrief({ ...BRIEF, intent: ECHO_INTENT, findings: ['ring 05 is 176'] });
    const merged = mergeBriefs({ ...BRIEF, intent: 'total rings 01-08 plus surcharge' }, parsed!);
    expect(merged.intent).toBe('total rings 01-08 plus surcharge');
    expect(merged.findings).toContain('ring 05 is 176');
  });

  it('still rejects an intent that is missing or not a string', () => {
    expect(parseBrief({ ...BRIEF, intent: null })).toBeNull();
    expect(parseBrief({ ...BRIEF, intent: 42 })).toBeNull();
  });

  // The guard keys on the schema's `<type> — ` opening, which this file emits.
  // Ordinary prose that merely mentions the word must survive untouched.
  it('keeps a real intent that happens to contain the word string', () => {
    const parsed = parseBrief({ ...BRIEF, intent: 'string parsing costs, totalled' });
    expect(parsed?.intent).toBe('string parsing costs, totalled');
  });
});

describe('hasAnchor — the emptied-intent fallback is not universal', () => {
  const ECHO_INTENT = 'string — what the user asked for';

  it('holds when a previous brief supplies the intent', () => {
    const parsed = parseBrief({ ...BRIEF, intent: ECHO_INTENT })!;
    expect(hasAnchor(mergeBriefs({ ...BRIEF, intent: 'total the rings' }, parsed))).toBe(true);
  });

  // ⛔ THE CASE THE FALLBACK DOES NOT COVER. `mergeBriefs(null, produced)`
  //   returns `produced` untouched, so on a FIRST brief an emptied intent is
  //   simply the intent — nothing carries it. The caller must refuse to persist
  //   this rather than fold, or the turn that stated the goal is evicted and no
  //   later brief can recover it.
  it('⛔ fails on a FIRST brief whose intent was emptied — nothing to carry', () => {
    const parsed = parseBrief({ ...BRIEF, intent: ECHO_INTENT })!;
    expect(mergeBriefs(null, parsed).intent).toBe('');
    expect(hasAnchor(mergeBriefs(null, parsed))).toBe(false);
  });

  // Same hole, reached by the other path that empties intent.
  it('⛔ fails the same way when stripAliasBearing empties the intent', () => {
    const stripped = stripAliasBearing(
      { ...BRIEF, intent: 'total for pii.Person1' },
      (t) => t.includes('pii.'),
    ).brief;
    expect(hasAnchor(mergeBriefs(null, stripped))).toBe(false);
  });

  it('holds for an ordinary brief', () => {
    expect(hasAnchor(BRIEF)).toBe(true);
  });
});

describe('parseBrief — a partial brief is worse than none', () => {
  it('🔑 parses the PARSED-OBJECT shape — what JSON mode actually returns', () => {
    // ⛔ THE SHAPE THAT COST A LIVE RUN. The brief call sets
    // `llm.output_format: 'json'`, so the layer parses the reply and hands back
    // the OBJECT; there is no `response` string. Reading only the string form
    // returned null on a brief the model had produced perfectly — twice — and
    // the silent fallback made it look like nothing had happened.
    expect(parseBrief(BRIEF)).toEqual(BRIEF);
    expect(parseBrief({ ...BRIEF, extra: 'ignored' })).toEqual(BRIEF);
    // …and a parsed object missing a field is still refused.
    const { findings: _drop, ...partial } = BRIEF;
    expect(parseBrief(partial)).toBeNull();
  });

  it('parses a well-formed reply, fenced or bare', () => {
    const json = JSON.stringify(BRIEF);
    expect(parseBrief(json)).toEqual(BRIEF);
    expect(parseBrief('```json\n' + json + '\n```')).toEqual(BRIEF);
    expect(parseBrief('Here you go:\n' + json + '\nhope that helps')).toEqual(BRIEF);
  });

  it('⛔ REJECTS a brief missing any field', () => {
    // A turn that carried forward a confident subset, with the rest silently
    // absent, is worse off than one that kept its results: it cannot tell that
    // anything is missing. All-or-nothing is the safe failure.
    for (const drop of ['intent', 'constraints', 'pending', 'findings'] as const) {
      const partial: Record<string, unknown> = { ...BRIEF };
      delete partial[drop];
      expect(parseBrief(JSON.stringify(partial)), `missing ${drop}`).toBeNull();
    }
  });

  it('⛔ REJECTS wrong-typed fields — a string where a list belongs', () => {
    expect(parseBrief(JSON.stringify({ ...BRIEF, constraints: 'surcharge 252' }))).toBeNull();
    expect(parseBrief(JSON.stringify({ ...BRIEF, findings: [1443] }))).toBeNull();
    expect(parseBrief(JSON.stringify({ ...BRIEF, intent: null }))).toBeNull();
  });

  it('rejects non-JSON and empty replies without throwing', () => {
    for (const junk of ['', 'no json here', '{', '}{', '{"intent":']) {
      expect(parseBrief(junk)).toBeNull();
    }
  });
});

describe('buildBriefPrompt — what the brief call reads', () => {
  it('⛔ the CARRIED brief leads, the new material follows', () => {
    // A model that must drop something drops what it can still see over what it
    // cannot. Putting the carry-forward first is what protects a constraint
    // from generation 1 against being crowded out by generation 3's results.
    const body = buildBriefPrompt({
      userMessage: 'give me the final figure',
      previous: BRIEF,
      since: [call(50)],
    });
    expect(body.indexOf('carried_forward')).toBeLessThan(body.indexOf('tool_results_since'));
  });

  it('the first brief of a turn carries a null predecessor', () => {
    const body = buildBriefPrompt({ userMessage: 'x', previous: null, since: [call(50)] });
    expect(JSON.parse(body).carried_forward).toBeNull();
  });
});

describe('briefAsPriorToolCall — where the model reads it', () => {
  it('🔑 lands where the results were, and says they are GONE', () => {
    const entry = briefAsPriorToolCall(BRIEF) as unknown as {
      tool_name: string; result: Record<string, unknown>;
    };
    // Rendered as a prior tool call so it appears where the results used to be
    // rather than in some new field the model has no habit of reading.
    expect(entry.tool_name).toBe('context.brief');
    expect(entry.result['constraints']).toEqual(BRIEF.constraints);
    // ⛔ It must say the originals are gone AND that re-fetching is futile —
    // measured 2026-09-05, a marker that offered recovery got the model
    // re-fetching into a hole for four cycles.
    expect(String(entry.result['note'])).toMatch(/gone/);
    expect(String(entry.result['note'])).toMatch(/re-running those calls/);
  });

  it('is far smaller than what it replaces', () => {
    const eightResults = JSON.stringify(Array.from({ length: 8 }, () => call(2_400)));
    const brief = JSON.stringify(briefAsPriorToolCall(BRIEF));
    expect(brief.length).toBeLessThan(eightResults.length / 10);
  });
});

describe('the tail is charged against the room', () => {
  it('⛔ a GROWN tail moves the trigger earlier', () => {
    // The tail grows across turns while the catalog does not, so a room that
    // ignores it fires late by however much the conversation has accumulated —
    // at exactly the point a long turn can least afford the miss.
    const four = Array.from({ length: 4 }, () => call(8_400));   // ~4,200 est each
    const base = { budgetTokens: 40_000, catalogTokens: 15_740, overheadTokens: 2_441 };
    const shortTail = shouldBrief({ priorToolCalls: four, ...base, tailTokens: 100 });
    const longTail  = shouldBrief({ priorToolCalls: four, ...base, tailTokens: 5_000 });
    expect(shortTail.brief).toBe(false);   // still room with a small tail
    expect(longTail.brief).toBe(true);     // the same results no longer fit
  });
});

describe('cross-turn carry — the fix for a brief that reset every turn', () => {
  beforeEach(() => { __clearSessionBriefs(); });

  it('🔑 a brief written in one turn is readable in the next', () => {
    // ⛔ THE DEFECT THIS CLOSES. `runChatTurn` is called once per USER TURN, so
    // a brief scoped inside it starts every turn at null. Measured 2026-09-06:
    // turn 1's brief carried the user's 252-unit surcharge, turn 2's began with
    // no predecessor and came back with EMPTY constraints. The run passed only
    // because the chat tail happened to hold the number — luck, not mechanism,
    // and exactly what fails when the budget is tight enough to evict the tail.
    expect(getSessionBrief('s1')).toBeNull();
    setSessionBrief('s1', BRIEF);
    expect(getSessionBrief('s1')?.constraints).toEqual(BRIEF.constraints);
  });

  it('sessions do not see each other\'s briefs', () => {
    setSessionBrief('s1', BRIEF);
    expect(getSessionBrief('s2')).toBeNull();
  });

  it('a later brief replaces the earlier one for that session', () => {
    setSessionBrief('s1', BRIEF);
    const next = { ...BRIEF, findings: ['rings 01-08 total 1443', 'surcharge applies'] };
    setSessionBrief('s1', next);
    expect(getSessionBrief('s1')?.findings).toEqual(next.findings);
  });

  it('⛔ is BOUNDED — a long-lived server cannot accumulate every session', () => {
    for (let i = 0; i < 40; i += 1) setSessionBrief(`s${String(i)}`, BRIEF);
    // Oldest evicted first; the most recent survive.
    expect(getSessionBrief('s0')).toBeNull();
    expect(getSessionBrief('s39')).not.toBeNull();
  });
});

describe('BRIEF_INSTRUCTION — what it forbids', () => {
  it('⛔ forbids calculating anything NEW, by name', () => {
    // Measured 2026-09-06: a brief written after only HALF the inputs were read
    // filed "689 + 252 = 941 units" as a FINDING — a premature calculation,
    // wrong, and carried forward as settled. 941 is the exact wrong answer two
    // earlier baseline runs produced, so the brief was laundering a known
    // failure mode into fact. The instruction has to forbid the ACT, not just
    // ask for accuracy.
    expect(BRIEF_INSTRUCTION).toMatch(/DO NOT CALCULATE ANYTHING NEW/);
    expect(BRIEF_INSTRUCTION).toMatch(/[Nn]ever compute a total the conversation has not already reached/);
    // ⛔ AND IT MUST NOT SHIP THE WRONG NUMBER ITSELF. The first fix quoted
    //    "689 + 252 = 941" in the instruction as a cautionary example, which
    //    put a specific wrong answer into the model's context on every brief
    //    call. Writing a wrong answer into a prompt to warn against wrong
    //    answers is a hazard invented while fixing one. The incident lives in
    //    a code comment; the prompt states the RULE.
    expect(BRIEF_INSTRUCTION).not.toMatch(/941/);
    expect(BRIEF_INSTRUCTION).not.toMatch(/689\s*\+\s*252/);
  });

  // ⛔ CUT 2026-09-07 on measured evidence. The three-tier recovery RANKING did
  //   not earn its ~250 tokens: 255 paired replays put elaborate at 8.2% wrong
  //   claims vs 12.6% for minimal-plus-the-user-value-sentence, p = 0.077 on a
  //   pre-registered primary — and both minimal arms kept the user's stated
  //   value MORE often (87/99 vs 81/99), which is the ranking's own objective.
  //   The anti-CALCULATION rule was kept: the metric scored ring-cost claims and
  //   could not see a fabricated TOTAL, so its benefit was never measured.
  it.skip('asks for ALREADY-established values, not computed ones', () => {
    expect(BRIEF_INSTRUCTION).toMatch(/ALREADY established earlier in this conversation/);
    expect(BRIEF_INSTRUCTION).not.toMatch(/Values you computed that no tool produced/);
  });
});

describe('clearSessionBrief — a stale carry is worse than none', () => {
  beforeEach(() => { __clearSessionBriefs(); });

  it('⛔ drops the carry when a turn could not fold its results', () => {
    // A turn's prior_tool_calls is per-turn and discarded at the boundary while
    // the SESSION brief persists. If a turn does work and cannot fold it,
    // keeping the previous brief hands the next turn a carry-forward whose own
    // note says "this is what you kept" with a whole turn missing.
    setSessionBrief('s1', BRIEF);
    expect(getSessionBrief('s1')).not.toBeNull();
    clearSessionBrief('s1');
    expect(getSessionBrief('s1')).toBeNull();
  });

  it('clearing one session leaves others alone', () => {
    setSessionBrief('s1', BRIEF);
    setSessionBrief('s2', BRIEF);
    clearSessionBrief('s1');
    expect(getSessionBrief('s1')).toBeNull();
    expect(getSessionBrief('s2')).not.toBeNull();
  });
});

describe('mergeBriefs — the recurrence lives in code, not the prompt', () => {
  const B1: RollingBrief = {
    intent: 'total rings 01-08 plus the surcharge',
    constraints: ['quarterly rig surcharge is 252 units'],
    pending: ['read rings 05-08'],
    findings: ['ring 01: 137', 'ring 02: 211', 'ring 03: 148', 'ring 04: 193'],
    completed: [],
  };

  it('🔑 A CARRIED FINDING CANNOT BE LOST, even when the model omits it', () => {
    // ⛔ THE MEASURED FAILURE. Brief 2 was handed brief 1 (rings 01-04) plus new
    // results and returned rings 03-04 ONLY, filing 01 and 02 as `pending`. The
    // model then obeyed its own brief and re-read them — the re-fetch loop was
    // the model OBEYING a brief that had forgotten, not ignoring one.
    const produced: RollingBrief = {
      intent: 'total rings 01-08 plus the surcharge',
      constraints: [],
      pending: ['read the full notes for ring 01', 'read the full notes for ring 02'],
      findings: ['ring 05: 176'],
      completed: [],
    };
    const merged = mergeBriefs(B1, produced);
    for (const f of B1.findings) expect(merged.findings).toContain(f);
    expect(merged.findings).toContain('ring 05: 176');
  });

  it('⛔ constraints UNION — a rule once stated stays true', () => {
    const merged = mergeBriefs(B1, {
      intent: 'x', constraints: ['do not add it yet'], pending: [], findings: [], completed: [],
    });
    expect(merged.constraints).toEqual([
      'quarterly rig surcharge is 252 units', 'do not add it yet',
    ]);
  });

  it('clears pending when the current fold has no work left', () => {
    // Pending is regenerated each fold. An empty result must not resurrect
    // older actions, while the accumulated rules and findings still survive.
    const merged = mergeBriefs(B1, {
      intent: 'x', constraints: [], pending: [], findings: [], completed: [],
    });
    expect(merged.pending).toEqual([]);
    expect(merged.constraints).toEqual(B1.constraints);
    expect(merged.findings).toEqual(B1.findings);
  });

  it('duplicates are collapsed case-insensitively', () => {
    const merged = mergeBriefs(B1, {
      intent: 'x', constraints: ['QUARTERLY RIG SURCHARGE IS 252 UNITS'],
      pending: [], findings: ['Ring 01: 137'], completed: [],
    });
    expect(merged.constraints).toHaveLength(1);
    expect(merged.findings).toHaveLength(4);
  });

  it('intent takes the newest non-empty — the ask evolves across turns', () => {
    expect(mergeBriefs(B1, { ...B1, intent: 'now add it all up' }).intent)
      .toBe('now add it all up');
    expect(mergeBriefs(B1, { ...B1, intent: '   ' }).intent).toBe(B1.intent);
  });

  it('a first brief passes through untouched', () => {
    expect(mergeBriefs(null, B1)).toEqual(B1);
  });
});

describe('BRIEF_INSTRUCTION — carried facts are declared kept', () => {
  it('tells the model its carried material is safe and NOT to repeat it', () => {
    // Without this the model re-ranks the carried findings under the same
    // "findings are re-readable, drop them first" rule and loses them.
    expect(BRIEF_INSTRUCTION).toMatch(/ALREADY KEPT/);
    expect(BRIEF_INSTRUCTION).toMatch(/Report only what is NEW/);
  });
});

describe('the carried brief GROWS, and the capacity arithmetic must measure it', () => {
  it('⛔ a large carried brief shrinks what the fold can still read', () => {
    // findings/constraints UNION across folds, so a brief is ~200 est after one
    // turn and ~900 after twelve. A fixed reserve under-reserves exactly when
    // the brief has grown enough to matter — and the failure mode is the brief
    // CALL overflowing, i.e. the mechanism breaking at its own maturity.
    //
    // ⚠ THE FIXTURE IS SIZED FROM THE ARITHMETIC, not guessed. The first
    //    attempt used a "big-looking" brief that was nowhere near the boundary
    //    and the case passed for the wrong reason.
    const REAL = {
      budgetTokens: 40_000, catalogTokens: 15_740, overheadTokens: 2_441,
      tailTokens: 400,
    };
    const results = Array.from({ length: 5 }, () => call(12_000));   // ~6,000 est each
    const accumulated = 5 * 6_000;                                    // 30,000 est
    // Capacity with no carry: 40,000 − 2,441 − 250 − 400 = 36,909 → fits.
    // To refuse, the carry must exceed 40,000 − 2,441 − 250 − 30,000 = 7,309 est.
    const CARRY_EST = 9_000;
    const fat: RollingBrief = {
      intent: 'x', constraints: [], pending: [],
      findings: [ 'f'.repeat(CARRY_EST * 2) ],
      completed: [],
    };
    expect(Math.ceil(JSON.stringify(fat).length / 2)).toBeGreaterThan(7_309);

    const withSmall = shouldBrief({ priorToolCalls: results, ...REAL, previous: null });
    const withFat = shouldBrief({ priorToolCalls: results, ...REAL, previous: fat });
    expect(accumulated).toBeLessThan(36_909);      // readable with no carry
    expect(withSmall.brief).toBe(true);
    // The same results, now unreadable because the carry eats the capacity.
    expect(withFat.brief).toBe(false);
    expect(withFat.reason).toMatch(/exceeds what the brief call can read/);
  });
});

describe('every decision names its cause', () => {
  const REAL = {
    budgetTokens: 40_000, catalogTokens: 15_740, overheadTokens: 2_441, tailTokens: 400,
  };

  it('🔑 the four refusals are DISTINCT, not one absence', () => {
    // ⛔ THE SILENT FALLBACK MADE "FAILED" AND "NEVER TRIGGERED" IDENTICAL, and
    // that cost two investigations. When the parse read the wrong reply field
    // the brief fired twice, produced perfect output, and was discarded — a run
    // indistinguishable from one where the trigger was never met. It surfaced
    // only by counting `carried_forward` in the raw report, a signal that
    // exists by accident.
    //
    // Each of these wants a DIFFERENT fix — a smaller trigger, a partial fold,
    // a retry, a prompt change — so collapsing them loses the fix, not just the
    // detail.
    const got = new Map<BriefOutcome, string>();
    const rec = (r: { outcome: BriefOutcome; reason: string }) => got.set(r.outcome, r.reason);

    rec(shouldBrief({ priorToolCalls: [call(100), call(100)], ...REAL }));
    rec(shouldBrief({ priorToolCalls: Array.from({ length: 4 }, () => call(200)), ...REAL }));
    rec(shouldBrief({ priorToolCalls: Array.from({ length: 4 }, () => call(9_600)), ...REAL }));
    rec(shouldBrief({ priorToolCalls: Array.from({ length: 3 }, () => call(40_000)), ...REAL }));
    rec(shouldBrief({
      priorToolCalls: Array.from({ length: 9 }, () => call(900)),
      budgetTokens: 10_000, catalogTokens: 15_740, overheadTokens: 2_441, tailTokens: 400,
    }));

    expect([...got.keys()].sort()).toEqual(
      ['capacity_refused', 'folded', 'no_room', 'not_triggered', 'too_few_calls'].sort(),
    );
    // …and each carries a reason with the NUMBERS that produced it, so a wrong
    // threshold is debuggable from a bench report rather than by re-deriving.
    for (const [outcome, reason] of got) {
      expect(reason.length, `${outcome} has no detail`).toBeGreaterThan(10);
    }
  });

  it('a fold reports `folded`, not merely truthy', () => {
    const r = shouldBrief({
      priorToolCalls: Array.from({ length: 4 }, () => call(9_600)), ...REAL,
    });
    expect(r.brief).toBe(true);
    expect(r.outcome).toBe('folded');
  });
});

describe('recall-bearing turns — briefable, but nothing alias-bearing persists', () => {
  const REAL = {
    budgetTokens: 40_000, catalogTokens: 15_740, overheadTokens: 2_441, tailTokens: 400,
  };
  const READY = Array.from({ length: 4 }, () => call(9_600));
  const RECALL = [{ tool_name: 'memory.search', tier: 1, args: {}, status: 'ok',
                    result: { memories: [] } }] as never;

  it('🔑 a recall turn CAN brief when the call can carry the context', () => {
    // The egress guard is per-TURN: once a recall result lands, every packet
    // must carry a valid `recall_context`. Passing the composer's own value
    // through satisfies it — reuse, not construction — so the turn is briefable.
    const r = shouldBrief({
      priorToolCalls: READY, ...REAL, recallBearing: true, recallContext: RECALL,
    });
    expect(r.brief).toBe(true);
  });

  it('⛔ but is SKIPPED when no context is available to carry', () => {
    // The guard is fail-closed, so a packet that would be rejected must not be
    // attempted. Measured 2026-09-06: nine correct skips followed by one
    // rejected call, because `force` waived the skip.
    const r = shouldBrief({
      priorToolCalls: READY, ...REAL, recallBearing: true, recallContext: [],
    });
    expect(r.brief).toBe(false);
    expect(r.outcome).toBe('recall_bearing_skip');
    expect(r.reason).toMatch(/egress guard would reject/);
  });

  it('a non-recall turn is unaffected', () => {
    expect(shouldBrief({ priorToolCalls: READY, ...REAL, recallBearing: false }).brief)
      .toBe(true);
  });
});

describe('stripAliasBearing — the brief reads recalled content and remembers none', () => {
  const hasAlias = (t: string) => /pii\.|@d\d+\.invalid/.test(t);

  it('🔑 an alias-bearing finding NEVER persists', () => {
    // ⛔ `chat-pii-slot-ordering.ts`: live turns were never wrong because "no
    // alias ever crossed a restart boundary in a resolvable position". A
    // persisted brief holding `pii.Person1` would be the FIRST thing to break
    // that. D-167's deterministic ordering makes numbering stable but its own
    // docstring refuses to be read as a leak fix.
    const { brief, dropped } = stripAliasBearing({
      intent: 'total the ring costs',
      constraints: ['surcharge is 252 units'],
      pending: ['email pii.Person1 the total'],
      findings: ['ring 03: 148 units', 'pii.Person1 owes 252', 'contact m40@d1.invalid'],
      completed: [],
    }, hasAlias);
    expect(brief.findings).toEqual(['ring 03: 148 units']);
    expect(brief.pending).toEqual([]);
    expect(dropped).toBe(3);
  });

  it('alias-free facts survive — which is most of them', () => {
    const { brief, dropped } = stripAliasBearing({
      intent: 'total the ring costs',
      constraints: ['surcharge is 252 units'],
      pending: ['add the surcharge'],
      findings: ['ring 01: 137 units', 'ring 02: 211 units'],
      completed: [],
    }, hasAlias);
    expect(dropped).toBe(0);
    expect(brief.findings).toHaveLength(2);
    expect(brief.constraints).toHaveLength(1);
  });

  it('⛔ an alias in INTENT is emptied, not ignored', () => {
    // A model paraphrasing a recalled name into the intent line would persist an
    // alias by the back door. The facts are still worth keeping, so the brief
    // survives with an empty intent rather than being discarded.
    const { brief, dropped } = stripAliasBearing({
      intent: 'send pii.Person1 the summary',
      constraints: [], pending: [], findings: ['ring 01: 137 units'], completed: [],
    }, hasAlias);
    expect(brief.intent).toBe('');
    expect(brief.findings).toEqual(['ring 01: 137 units']);
    expect(dropped).toBe(1);
  });
});

describe('every decision names its cause', () => {
  const REAL = {
    budgetTokens: 40_000, catalogTokens: 15_740, overheadTokens: 2_441, tailTokens: 400,
  };

  it('🔑 the four refusals are DISTINCT, not one absence', () => {
    // ⛔ THE SILENT FALLBACK MADE "FAILED" AND "NEVER TRIGGERED" IDENTICAL, and
    // that cost two investigations. When the parse read the wrong reply field
    // the brief fired twice, produced perfect output, and was discarded — a run
    // indistinguishable from one where the trigger was never met. It surfaced
    // only by counting `carried_forward` in the raw report, a signal that
    // exists by accident.
    //
    // Each of these wants a DIFFERENT fix — a smaller trigger, a partial fold,
    // a retry, a prompt change — so collapsing them loses the fix, not just the
    // detail.
    const got = new Map<BriefOutcome, string>();
    const rec = (r: { outcome: BriefOutcome; reason: string }) => got.set(r.outcome, r.reason);

    rec(shouldBrief({ priorToolCalls: [call(100), call(100)], ...REAL }));
    rec(shouldBrief({ priorToolCalls: Array.from({ length: 4 }, () => call(200)), ...REAL }));
    rec(shouldBrief({ priorToolCalls: Array.from({ length: 4 }, () => call(9_600)), ...REAL }));
    rec(shouldBrief({ priorToolCalls: Array.from({ length: 3 }, () => call(40_000)), ...REAL }));
    rec(shouldBrief({
      priorToolCalls: Array.from({ length: 9 }, () => call(900)),
      budgetTokens: 10_000, catalogTokens: 15_740, overheadTokens: 2_441, tailTokens: 400,
    }));

    expect([...got.keys()].sort()).toEqual(
      ['capacity_refused', 'folded', 'no_room', 'not_triggered', 'too_few_calls'].sort(),
    );
    // …and each carries a reason with the NUMBERS that produced it, so a wrong
    // threshold is debuggable from a bench report rather than by re-deriving.
    for (const [outcome, reason] of got) {
      expect(reason.length, `${outcome} has no detail`).toBeGreaterThan(10);
    }
  });

  it('a fold reports `folded`, not merely truthy', () => {
    const r = shouldBrief({
      priorToolCalls: Array.from({ length: 4 }, () => call(9_600)), ...REAL,
    });
    expect(r.brief).toBe(true);
    expect(r.outcome).toBe('folded');
  });
});

describe('recall-bearing turns are skipped — a privacy decision, not a budget one', () => {
  const REAL = {
    budgetTokens: 40_000, catalogTokens: 15_740, overheadTokens: 2_441, tailTokens: 400,
  };
  const READY = Array.from({ length: 4 }, () => call(9_600));   // would otherwise fold

  it('🔑 a turn that returned recall content does NOT brief', () => {
    // ⛔ MEASURED 2026-09-06: the brief call was rejected three times with
    // "chat privacy protection failed: recall-bearing packet has invalid
    // recall_context". `hasRegisteredRecallResult` is per-TURN fail-closed
    // state — once a memory.search/recall.search result lands, EVERY packet in
    // that turn must carry a recall_context binding recalled PII to its source
    // piece. The downstream capacity_refused at 51,559 est was a SYMPTOM of
    // those failures, not an independent defect.
    const before = shouldBrief({ priorToolCalls: READY, ...REAL });
    expect(before.brief).toBe(true);
    const after = shouldBrief({ priorToolCalls: READY, ...REAL, recallBearing: true });
    expect(after.brief).toBe(false);
    expect(after.outcome).toBe('recall_bearing_skip');
  });

  it('⛔ the skip OUTRANKS every other decision, including force', () => {
    // It is checked before the call floor, the room, the trigger and the
    // capacity — because those are budget questions and this is not. A brief
    // that fits perfectly still must not carry recalled PII past the turn that
    // bound it.
    expect(shouldBrief({
      priorToolCalls: [call(50)], ...REAL, recallBearing: true,
    }).outcome).toBe('recall_bearing_skip');
    expect(shouldBrief({
      priorToolCalls: Array.from({ length: 3 }, () => call(40_000)),
      ...REAL, recallBearing: true,
    }).outcome).toBe('recall_bearing_skip');
  });

  it('a non-recall turn is unaffected', () => {
    expect(shouldBrief({ priorToolCalls: READY, ...REAL, recallBearing: false }).brief)
      .toBe(true);
  });
});

describe('FORCE_WAIVABLE_OUTCOMES — what a turn-end fold may override', () => {
  it('🔑 waives BUDGET refusals only', () => {
    // `force` exists so a turn's carry is closed even when the accumulation
    // never reached the trigger. That is a budget question. It is not a licence
    // to overrule why else a fold was refused.
    //
    // ⛔ `nothing_to_shrink` ADDED DELIBERATELY, and this test is the reason the
    //   decision had to be explicit — the whitelist makes a new outcome
    //   non-waivable by default. It qualifies on this test's own criterion: it
    //   is a BUDGET refusal (the payload is smaller than the brief that would
    //   replace it, so a mid-turn fold is pure cost). But the CLOSING fold is
    //   about COMPLETENESS, not economics — "the stored brief covers everything
    //   up to the boundary" — and suppressing a small payload there would drop
    //   exactly the user statement the unfolded-message backlog exists to
    //   preserve, to save one call. Mid-turn it is waste; at the boundary it is
    //   the record.
    expect([...FORCE_WAIVABLE_OUTCOMES].sort())
      .toEqual(['not_triggered', 'nothing_to_shrink', 'too_few_calls']);
  });

  it('⛔ NEVER waives the privacy skip', () => {
    // ⛔ THE MEASURED BUG. The first cut waived everything except one
    // special-cased outcome, so `recall_bearing_skip` — a privacy decision —
    // was overridden by a flag meant for a budget one, and the fold was then
    // rejected by the egress guard with "recall-bearing packet has invalid
    // recall_context" after NINE correct skips in the same turn.
    expect(FORCE_WAIVABLE_OUTCOMES.has('recall_bearing_skip')).toBe(false);
  });

  it('⛔ NEVER waives capacity — a fold it cannot read is not a fold', () => {
    expect(FORCE_WAIVABLE_OUTCOMES.has('capacity_refused')).toBe(false);
    expect(FORCE_WAIVABLE_OUTCOMES.has('no_room')).toBe(false);
  });

  it('⛔ is a WHITELIST — a new outcome is non-waivable by default', () => {
    // The shape is the fix. A blacklist would silently admit every outcome
    // added later; the previous version admitted `recall_bearing_skip` the
    // moment it was introduced, and the test asserting the skip outranks force
    // passed anyway because it called `shouldBrief` directly — a rule enforced
    // at one end and bypassed at the other.
    const every: BriefOutcome[] = [
      'folded', 'not_triggered', 'too_few_calls', 'no_room',
      'capacity_refused', 'call_failed', 'parse_failed', 'recall_bearing_skip',
    ];
    const waivable = every.filter((o) => FORCE_WAIVABLE_OUTCOMES.has(o));
    expect(waivable).toHaveLength(2);
  });
});

describe('markCarryIncomplete — a failed fold keeps facts and declares the gap', () => {
  const carry = {
    intent: 'Audit the Kestrel rings',
    constraints: ['The quarterly rig surcharge is 252 units.'],
    findings: [
      'Kestrel ring 01 checkpoint cost: 137 units.',
      'Kestrel ring 02 checkpoint cost: 211 units.',
    ],
    pending: ['Report ring 07.'],
    completed: [],
  };

  it('keeps every established fact when the closing fold fails', () => {
    // 🔑 THE REGRESSION. This carry used to be DELETED outright, and the next
    //   turn opened with nothing — the loss the clear was meant to prevent.
    const kept = markCarryIncomplete(carry, 4);

    expect(kept?.findings).toEqual(carry.findings);
    expect(kept?.constraints).toEqual(carry.constraints);
    expect(kept?.intent).toBe(carry.intent);
  });

  it('declares the shortfall in pending, with the count', () => {
    const kept = markCarryIncomplete(carry, 4);
    const note = kept?.pending.find((p) => p.startsWith(UNFOLDED_PENDING_PREFIX));

    expect(note).toBeDefined();
    expect(note).toContain('4');
    // The model must be told the carry is INCOMPLETE, not that it is wrong.
    expect(note).toMatch(/still accurate/i);
    expect(note).toMatch(/does NOT cover/i);
    // Pre-existing pending entries survive alongside it.
    expect(kept?.pending).toContain('Report ring 07.');
  });

  it('replaces an earlier note instead of stacking, so one gap counts once', () => {
    const once = markCarryIncomplete(carry, 4);
    const twice = markCarryIncomplete(once, 9);
    const notes = twice?.pending.filter((p) => p.startsWith(UNFOLDED_PENDING_PREFIX));

    expect(notes).toHaveLength(1);
    expect(notes?.[0]).toContain('9');
    expect(notes?.[0]).not.toContain('4 tool result');
  });

  it('is a no-op with no prior carry, or with nothing unfolded', () => {
    expect(markCarryIncomplete(null, 4)).toBeNull();
    expect(markCarryIncomplete(carry, 0)).toBe(carry);
  });

  it('does not mutate the brief it is given', () => {
    const before = JSON.stringify(carry);
    markCarryIncomplete(carry, 3);
    expect(JSON.stringify(carry)).toBe(before);
  });
});

describe('parseBrief — the model mirrors the packet shape', () => {
  const FIELDS = {
    intent: 'Audit the Kestrel rings',
    constraints: ['Surcharge is 252 units.'],
    pending: ['Report ring 07.'],
    findings: ['Kestrel ring 01 checkpoint cost: 137 units.'],
  };

  it('unwraps a reply echoed back under the prompt\'s own `emit` key', () => {
    // 🔑 OBSERVED LIVE, qwen3.7-plus, task 343 brief 4. Before this, the wrapper
    //   parsed as a brief with every field missing → null → the fold was lost.
    // ⛔ `completed` is server-derived, so parseBrief always returns it EMPTY —
    //   never whatever the reply happened to contain.
    expect(parseBrief({ emit: FIELDS })).toEqual({ ...FIELDS, completed: [] });
  });

  it('still parses the correct top-level shape', () => {
    expect(parseBrief(FIELDS)).toEqual({ ...FIELDS, completed: [] });
  });

  it('prefers the OUTER fields when both are present', () => {
    const outer = { ...FIELDS, emit: { ...FIELDS, intent: 'WRONG — nested' } };
    expect(parseBrief(outer)?.intent).toBe('Audit the Kestrel rings');
  });

  it('does not let a nested copy mask a present wrong-typed field', () => {
    // ⛔ THE LIMIT. `intent` is present but not a string — that is a malformed
    //   brief and must fail, not silently resolve from the nested object.
    expect(parseBrief({ intent: 42, emit: FIELDS })).toBeNull();
    expect(parseBrief({ intent: null, emit: FIELDS })).toBeNull();
  });

  it('rejects an emit wrapper that is itself incomplete', () => {
    expect(parseBrief({ emit: { intent: 'x' } })).toBeNull();
    expect(parseBrief({ emit: null })).toBeNull();
    expect(parseBrief({ emit: 'not an object' })).toBeNull();
  });

  it('does not descend two levels', () => {
    expect(parseBrief({ emit: { emit: FIELDS } })).toBeNull();
  });
});

describe('completed actions — a write must not be re-performed after a fold', () => {
  const call = (
    tool_name: string,
    status: 'ok' | 'error',
    args: unknown = {},
  ): ChatPriorToolCall => ({
    tool_name, tier: 1, args, status, started_at: 0, completed_at: 1,
  });

  it('🔑 records memory.write, whose classification is `unknown` not `write`', () => {
    // ⛔ THE TRAP. `TIER1_CLASSIFICATIONS['memory.write'] === 'unknown'` (D-198
    //   §3 opts it out of plan-approval), so a `=== 'write'` predicate misses
    //   the ONE tool whose re-execution produced the measured failure.
    expect(TIER1_CLASSIFICATIONS['memory.write']).not.toBe('write');
    const records = completedActionRecords([
      call('memory.write', 'ok', { summary: 'Quarterly rig surcharge is 252 units' }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toContain('memory.write');
    // The summary is what lets the model connect the record to the pending
    // item it retires; the bare tool name was too thin.
    expect(records[0]).toContain('252 units');
  });

  it('ignores reads — repeating those is cheap and correct', () => {
    expect(completedActionRecords([
      call('work.search', 'ok', { query: 'kestrel' }),
      call('work.read', 'ok', { id: 'we1:note:1' }),
      call('memory.search', 'ok', { query: 'x' }),
    ])).toEqual([]);
  });

  it('⛔ records only calls that SUCCEEDED', () => {
    // A refused call did not happen. Recording it would tell the model its work
    // was done when nothing was written — the inverse failure, and worse.
    expect(completedActionRecords([
      call('memory.write', 'error', { summary: 'never stored' }),
    ])).toEqual([]);
  });

  it('never records the brief\'s own synthetic entry', () => {
    expect(completedActionRecords([call('context.brief', 'ok', {})])).toEqual([]);
  });

  it('collapses duplicates within a fold', () => {
    const c = call('memory.write', 'ok', { summary: 'same' });
    expect(completedActionRecords([c, c])).toHaveLength(1);
  });

  it('withCompletedActions appends to the carry without dropping inherited records', () => {
    const carried: RollingBrief = {
      intent: 'audit', constraints: [], pending: ['Confirm the surcharge is held'],
      findings: [], completed: ['memory.write — completed: earlier note'],
    };
    const next = withCompletedActions(carried, [
      call('memory.write', 'ok', { summary: 'Quarterly rig surcharge is 252 units' }),
    ]);
    expect(next.completed).toHaveLength(2);
    expect(next.completed[0]).toContain('earlier note');
    expect(next.completed[1]).toContain('252 units');
  });

  it('is a no-op when the fold contains no side-effecting call', () => {
    const b: RollingBrief = {
      intent: 'x', constraints: [], pending: [], findings: [], completed: [],
    };
    expect(withCompletedActions(b, [call('work.read', 'ok', {})])).toBe(b);
  });

  it('⛔ mergeBriefs UNIONS completed — a completed act stays completed', () => {
    const prev: RollingBrief = {
      intent: 'x', constraints: [], pending: [], findings: [],
      completed: ['memory.write — completed: surcharge'],
    };
    const produced: RollingBrief = {
      intent: 'x', constraints: [], pending: [], findings: [], completed: [],
    };
    // The model authors nothing here, so `produced.completed` is always empty —
    // the union is what stops the record vanishing at the next fold.
    expect(mergeBriefs(prev, produced).completed)
      .toEqual(['memory.write — completed: surcharge']);
  });

  it('the packet tells the model not to repeat them', () => {
    const rendered = JSON.stringify(briefAsPriorToolCall({
      intent: 'x', constraints: [], pending: [], findings: [],
      completed: ['memory.write — completed: surcharge'],
    }));
    expect(rendered).toContain('ALREADY SUCCEEDED');
    expect(rendered).toContain('memory.write — completed: surcharge');
  });

  it('an alias-bearing completed record is stripped like any other', () => {
    // Server-authored is not alias-free: the measured failure had the model
    // writing `pii.Person1.dana.reyes` into its own memory.write summary.
    const { brief, dropped } = stripAliasBearing(
      {
        intent: 'x', constraints: [], pending: [], findings: [],
        completed: ['memory.write — completed: held for pii.Person1'],
      },
      (t) => /pii\.Person\d/.test(t),
    );
    expect(brief.completed).toEqual([]);
    expect(dropped).toBe(1);
  });
});

describe('recall-bearing skip uses per-TURN state, not the fold slice', () => {
  const call = (tool_name: string): ChatPriorToolCall => ({
    tool_name, tier: 1, args: { query: 'x' }, status: 'ok',
    result: { memories: [] }, started_at: 0, completed_at: 1,
  });
  const base = {
    budgetTokens: 40_000, catalogTokens: 1_000,
    overheadTokens: 100, tailTokens: 10,
  };

  it('does NOT skip when the recall context is available to carry', () => {
    // ⚠ The guard is narrower than "recall-bearing ⇒ never brief". A recall
    //   turn IS briefable when the call can carry the turn's `recall_context`,
    //   so the packet the egress sees is valid. The skip exists only for when
    //   it cannot — which is precisely the post-fold state below.
    expect(shouldBrief({
      ...base,
      priorToolCalls: [call('memory.search'), call('work.read'), call('work.read')],
      recallBearing: true,
      recallContext: [call('memory.search')],
    }).outcome).not.toBe('recall_bearing_skip');
  });

  it('🔑 skips when the TURN is recall-bearing but the slice is not', () => {
    // ⛔ THE DEFECT. After the first fold empties `priorToolCalls`, the recall
    //   call is gone from every later slice — so a slice-scoped check says
    //   "clean", the fold proceeds, and the packet it produces carries no
    //   `recall_context` while the turn is still registered recall-bearing.
    //   `chat-pii-egress` then throws and the tool loop ABORTS. Measured: seven
    //   aborts over four forced-budget runs, `recall_bearing_skip` fired zero
    //   times, every one reported as `provider_failure`.
    expect(shouldBrief({
      ...base,
      priorToolCalls: [call('context.brief'), call('work.read'), call('work.read')],
      recallBearing: true,   // ← from hasRegisteredRecallResult, not the slice
      recallContext: [],
    }).outcome).toBe('recall_bearing_skip');
  });

  it('does not skip a turn that never recalled', () => {
    expect(shouldBrief({
      ...base,
      priorToolCalls: [call('work.search'), call('work.read'), call('work.read')],
      recallBearing: false,
      recallContext: [],
    }).outcome).not.toBe('recall_bearing_skip');
  });

  it('⛔ the skip outranks force — it is a PRIVACY decision, not a budget one', () => {
    expect(FORCE_WAIVABLE_OUTCOMES.has('recall_bearing_skip')).toBe(false);
  });
});

describe('isFoldRecallBearing — the composition, not just the rule', () => {
  // ⛔ THIS EXISTS BECAUSE THE RULE-ONLY TESTS PASSED A MUTANT. Reverting the
  //   executor to the slice-only signal left every `shouldBrief` assertion
  //   green, because none of them ran the code that computes the input.
  it('🔑 true when the TURN registered a recall, even with a clean slice', () => {
    expect(isFoldRecallBearing({ registered: true, sliceHasRecall: false })).toBe(true);
  });

  it('true when the slice carries a recall the turn has not registered yet', () => {
    expect(isFoldRecallBearing({ registered: false, sliceHasRecall: true })).toBe(true);
  });

  it('false only when BOTH say clean', () => {
    expect(isFoldRecallBearing({ registered: false, sliceHasRecall: false })).toBe(false);
  });

  it('an unwired caller falls back to the slice — today\'s behaviour', () => {
    expect(isFoldRecallBearing({ sliceHasRecall: false })).toBe(false);
    expect(isFoldRecallBearing({ sliceHasRecall: true })).toBe(true);
  });
});

describe('a fold preserves the turn\'s recall receipts', () => {
  // ⛔ THE INVARIANT: once a recall result lands, the egress requires a valid
  //   `recall_context` on EVERY later packet in the turn. A fold that empties
  //   `prior_tool_calls` removes the only source of that field, and the next
  //   main-turn packet is refused — the tool loop aborts. Measured: 3 aborts
  //   per forced run, all reported as `provider_failure`.
  const recall = (q: string): ChatPriorToolCall => ({
    tool_name: 'memory.search', tier: 1, args: { query: q }, status: 'ok',
    result: { memories: [{ memory_id: 'umem_1', body: 'SECRET BODY' }] },
    started_at: 0, completed_at: 1,
  });
  const read = (): ChatPriorToolCall => ({
    tool_name: 'work.read', tier: 1, args: { id: 'we1:note:1' }, status: 'ok',
    result: { title: 'ring 01' }, started_at: 0, completed_at: 1,
  });

  it('the post-fold array still yields a non-empty recall_context', () => {
    const folded: RollingBrief = {
      intent: 'x', constraints: [], pending: [], findings: [], completed: [],
    };
    const before = [recall('ring 05'), read(), recall('ring 06')];
    const surviving = withRecallReceipts(partitionPriorToolCalls(before).recall);
    const after = [briefAsPriorToolCall(folded), ...surviving];

    // What the composer would put in `recall_context` on the NEXT packet.
    expect(partitionPriorToolCalls(after).recall).toHaveLength(2);
    // …and the egress's own structural test: non-empty array of objects.
    expect(partitionPriorToolCalls(after).recall.every(
      (e) => e !== null && typeof e === 'object' && !Array.isArray(e),
    )).toBe(true);
  });

  it('⛔ carries NO recalled content across the fold — receipts only', () => {
    const surviving = withRecallReceipts(
      partitionPriorToolCalls([recall('ring 05')]).recall,
    );
    expect(JSON.stringify(surviving)).not.toContain('SECRET BODY');
    expect(JSON.stringify(surviving)).not.toContain('umem_1');
    // The model's own query survives, which is what makes it a receipt.
    expect(JSON.stringify(surviving)).toContain('ring 05');
  });

  it('a turn with no recall keeps the fold as a clean replacement', () => {
    const surviving = withRecallReceipts(partitionPriorToolCalls([read()]).recall);
    expect(surviving).toEqual([]);
  });
});

describe('the pending/constraints boundary is stated to the model', () => {
  // ⛔ WHY A PROMPT ASSERTION. `pending` REPLACES on every fold and
  //   `constraints` UNIONS, so which field a durable rule lands in decides
  //   whether it survives. Measured (task 343, run 15-19-06-591Z): "do not sum"
  //   was filed in BOTH, brief 5 replaced `pending` with one item, and the rule
  //   lived only because a duplicate had reached `constraints` — luck, not
  //   mechanism. The boundary has to be IN the instruction or the model has no
  //   way to know it exists.
  const emitOf = (): Record<string, string> => {
    const prompt = buildBriefPrompt({
      userMessage: 'q', since: [], previous: null,
    });
    return (JSON.parse(prompt) as { emit: Record<string, string> }).emit;
  };

  it('pending is scoped to FINISHABLE actions', () => {
    const pending = emitOf()['pending'] ?? '';
    expect(pending).toMatch(/ACTIONS/);
    expect(pending).toMatch(/FINISHED|finished/);
    // The escape hatch must name where a rule goes instead, or the model has
    // nowhere to put it and will leave it here.
    expect(pending).toMatch(/constraints/);
    // ⛔ IT MUST STILL ASK FOR EVERY OUTSTANDING ACTION. Telling the model to
    //   report only what is NEW emptied the field outright — [2,2,4,2,2,2,1]
    //   became [0,0,0,0,0] — because it finishes each turn's work inside that
    //   turn and so has nothing new to name. The union de-duplicates; the
    //   model's job is unchanged.
    expect(pending).toMatch(/EVERY action still outstanding/);
    expect(pending).toMatch(/de-duplicated/);
    // ⛔ And it must NOT claim replacement — that is what deleted by omission.
    expect(pending).not.toMatch(/REPLACES/);
    expect(pending).not.toMatch(/do not repeat it/);
  });

  it('constraints explicitly claims standing rules', () => {
    const constraints = emitOf()['constraints'] ?? '';
    expect(constraints).toMatch(/STANDING RULES|standing rules/);
    expect(constraints).toMatch(/NOT to do|not to do/);
  });

  it('constraints KEEP, pending REGENERATES — the merge asymmetry', () => {
    // The instruction is only safe because these merge policies hold.
    const prev: RollingBrief = {
      intent: 'x', constraints: ['do not sum yet'], pending: ['task A'],
      findings: [], completed: [],
    };
    const produced: RollingBrief = {
      intent: 'x', constraints: [], pending: ['task B'], findings: [], completed: [],
    };
    const merged = mergeBriefs(prev, produced);
    expect(merged.constraints).toEqual(['do not sum yet']);      // kept
    // ⛔ `pending` is a DERIVED VIEW the model regenerates each fold from
    //   `intent` + `findings`, not durable state. Carrying it forward produced
    //   an undifferentiated backlog — 2,4,6,8 items with six already done.
    expect(merged.pending).toEqual(['task B']);                  // regenerated
  });
});


describe('the brief prompt does not contradict itself', () => {
  // ⛔ MEASURED: the system prompt said "ANYTHING IN carried_forward IS ALREADY
  //   KEPT … do not repeat it" while emit.pending said "repeat carried ones
  //   freely". Both ⛔-emphasised, same prompt, opposite instructions — and the
  //   live run that carried both produced an answer missing half its data.
  it('scopes the already-kept claim to the fields that actually merge', () => {
    expect(BRIEF_INSTRUCTION).toMatch(/`constraints` and `findings`[^.]*ARE ALREADY KEPT/);
    // ⛔ The blanket form is what created the contradiction.
    expect(BRIEF_INSTRUCTION).not.toMatch(/ANYTHING IN `carried_forward` IS ALREADY KEPT/);
  });

  it('states pending\'s opposite rule in the SAME place', () => {
    expect(BRIEF_INSTRUCTION).toMatch(/`pending` WORKS DIFFERENTLY/);
    expect(BRIEF_INSTRUCTION).toMatch(/repeating costs nothing/);
  });

  it('system prompt and field description agree about repetition', () => {
    const pending = (JSON.parse(buildBriefPrompt({
      userMessage: 'q', since: [], previous: null,
    })) as { emit: Record<string, string> }).emit['pending'] ?? '';
    // Both must permit repetition; neither may forbid it.
    expect(pending).toMatch(/repeat carried ones freely/);
    expect(BRIEF_INSTRUCTION).toMatch(/repeats are de-duplicated/);
  });
});

describe('a fold with nothing to summarise is refused', () => {
  const call = (tool_name: string): ChatPriorToolCall => ({
    tool_name, tier: 1, args: {}, status: 'ok', result: {}, started_at: 0, completed_at: 1,
  });
  const base = { budgetTokens: 40_000, catalogTokens: 1_000, overheadTokens: 100, tailTokens: 10 };

  it('🔑 refuses when no retainable result would reach tool_results_since', () => {
    // ⛔ MEASURED: brief 6 of run 2026-09-06T19-02-39 folded with
    //   `tool_results_since` empty and emitted "ring 05 … 184 units" and
    //   "ring 06 … 229 units". True values 176 and 205; neither invented number
    //   appears anywhere in the seed. A fold with no input can only invent.
    expect(shouldBrief({
      ...base, priorToolCalls: [call('work.read'), call('work.read'), call('work.read')],
      newResultCount: 0,
    }).outcome).toBe('nothing_to_fold');
  });

  it('⛔ outranks the call-count threshold — a recall-only turn clears that', () => {
    // A recall-only turn has calls (so `too_few_calls` passes) whose results are
    // non-retainable and therefore absent from `tool_results_since`.
    const d = shouldBrief({
      ...base,
      priorToolCalls: [call('memory.search'), call('memory.search'), call('memory.search')],
      newResultCount: 0,
    });
    expect(d.outcome).toBe('nothing_to_fold');
    expect(d.outcome).not.toBe('too_few_calls');
  });

  it('folds normally when there is something to summarise', () => {
    expect(shouldBrief({
      ...base, priorToolCalls: [call('work.read'), call('work.read'), call('work.read')],
      newResultCount: 3,
    }).outcome).not.toBe('nothing_to_fold');
  });

  it('⛔ `force` must NOT waive it — the turn-end fold invents just as readily', () => {
    expect(FORCE_WAIVABLE_OUTCOMES.has('nothing_to_fold')).toBe(false);
  });
});

describe('shouldFailOnCaptureFailure — the rule, not just the error type', () => {
  const B = { intent: 'x', constraints: [], pending: [], findings: [], completed: [] };
  it('fails the turn when the CLOSING fold produced nothing', () => {
    expect(shouldFailOnCaptureFailure({
      closing: null, isClosingFold: true, propagateTypedErrors: true,
    })).toBe(true);
  });
  // ⛔ A mid-turn fold has a successor — the turn-end fold reads the same
  //   `user_request`, so its failure loses nothing irrecoverably.
  it('⛔ does NOT fail the turn for a mid-turn fold', () => {
    expect(shouldFailOnCaptureFailure({
      closing: null, isClosingFold: false, propagateTypedErrors: true,
    })).toBe(false);
  });
  it('does not fail when the fold succeeded', () => {
    expect(shouldFailOnCaptureFailure({
      closing: B, isClosingFold: true, propagateTypedErrors: true,
    })).toBe(false);
  });
  // ⚠ A caller that cannot receive a typed error would get an unhandled throw
  //   instead of a degraded turn — strictly worse than what this replaces.
  it('stays silent for a caller that cannot receive typed errors', () => {
    expect(shouldFailOnCaptureFailure({
      closing: null, isClosingFold: true, propagateTypedErrors: false,
    })).toBe(false);
  });
});

describe('ChatBriefCaptureError — a failed CLOSING fold fails the turn', () => {
  // ⛔⛔ THE OLD JUSTIFICATION FOR DEGRADING IS NO LONGER TRUE. "The turn still
  //   works, it just works the old way" held when `chat_tail` carried the
  //   conversation. CHAT_TAIL_LIMIT is 3 ROWS, fixed and budget-independent —
  //   measured on 363, the facts stated at turns 1/3/5 were absent from every
  //   packet field by turn 8, with 767 bytes of tail against a 34,000-token
  //   budget. There is no old way; the fallback is a permanent hole.
  it('carries the cause, so an operator sees WHY capture failed', () => {
    const err = new ChatBriefCaptureError('parse_failed:reply did not parse as a brief');
    expect(err.code).toBe('brief_capture_failed');
    expect(err.message).toMatch(/not carried forward/i);
    expect(err.message).toMatch(/parse_failed/);
  });

  // ⚠ It must NOT reuse the context-length code: an operator debugging this
  //   needs "the fold did not parse", not "the prompt was too long". Two
  //   different causes reported as one is how a fix goes to the wrong layer.
  it('⛔ is distinct from the blown-window error', () => {
    expect(new ChatBriefCaptureError('x').code)
      .not.toBe(new ChatContextLengthError().code);
  });
});


describe('isSubstantiveFinding — an id is not a finding', () => {
  // Measured on task 363's 7-fold run: findings were 81% of a 4,810 b carry and
  // 98% of them were not facts — 12 bare UUIDs (1,476 b) and 9 lines of action
  // narration (2,309 b) against ONE extracted value (82 b). Growth of ~645
  // b/fold reaches `capacity_refused` at ~55 folds, after which the fold dies
  // permanently. Filtered in CODE because the instruction is the half that does
  // not hold: five variants moved brief behaviour not at all (p=1.0).
  it('⛔ refuses a bare record id', () => {
    expect(isSubstantiveFinding(
      'Meridian survey block 01 note id: 8e5af6ae-028f-474b-8496-8ea396db6593.',
    )).toBe(false);
  });

  // ⚠ THE CONSERVATIVE HALF, AND THE ONE THAT MATTERS. An id WITH a value is a
  //   fact with provenance; dropping it to save the uuid throws away the number,
  //   which is the only thing in the field worth carrying.
  it('keeps a finding that carries a value alongside an id', () => {
    expect(isSubstantiveFinding(
      'block 01 (id 8e5af6ae-028f-474b-8496-8ea396db6593) checkpoint cost: 137 units',
    )).toBe(true);
  });

  it('keeps ordinary facts with no id at all', () => {
    expect(isSubstantiveFinding('Kestrel ring 05 checkpoint cost: 176 units.')).toBe(true);
    expect(isSubstantiveFinding('There are 12 Meridian survey blocks.')).toBe(true);
    expect(isSubstantiveFinding('The surcharge applies quarterly.')).toBe(true);
  });

  it('filters through the merge, on both sides', () => {
    const idOnly = 'note id 8e5af6ae-028f-474b-8496-8ea396db6593';
    const merged = mergeBriefs(
      { ...BRIEF, findings: [idOnly, 'ring 01 cost 137 units'] },
      { ...BRIEF, intent: '', findings: [idOnly, 'ring 02 cost 211 units'] },
    );
    expect(merged.findings).toEqual(['ring 01 cost 137 units', 'ring 02 cost 211 units']);
  });
});


describe('unfolded user-message backlog', () => {
  beforeEach(() => { __clearUnfoldedUserMessages(); });

  /** ⛔⛔ THE GAP THIS EXISTS FOR. The closing fold runs only when the turn did
   *  RETAINABLE tool work. Measured across 844 bench turns: 65% qualify, 8% are
   *  recall-only, and 27% did NO tool work at all — for those no fold runs, no
   *  trail line is written, and `buildBriefPrompt` receives only the CURRENT
   *  turn's `user_message`. A rule stated on such a turn reached no brief, and
   *  `chat_tail` (3 rows, fixed) forgets it in ~2 turns.
   *
   *  🔑 That is the class the instruction calls unrecoverable — a tool result
   *  can be re-read, "the levy is now 340" cannot. */
  it('accumulates statements from turns that never folded', () => {
    appendUnfoldedUserMessage('s', 'the levy is now 340');
    appendUnfoldedUserMessage('s', 'never email the broker');
    expect(peekUnfoldedUserMessages('s')).toEqual([
      'the levy is now 340',
      'never email the broker',
    ]);
  });

  it('PEEKS without consuming — a failed fold must not eat the backlog', () => {
    appendUnfoldedUserMessage('s', 'the levy is now 340');
    peekUnfoldedUserMessages('s');
    peekUnfoldedUserMessages('s');
    expect(peekUnfoldedUserMessages('s')).toHaveLength(1);
  });

  it('clears only when told — the fold stored a brief that ingested it', () => {
    appendUnfoldedUserMessage('s', 'the levy is now 340');
    clearUnfoldedUserMessages('s');
    expect(peekUnfoldedUserMessages('s')).toEqual([]);
  });

  it('is per-session', () => {
    appendUnfoldedUserMessage('a', 'from a');
    appendUnfoldedUserMessage('b', 'from b');
    clearUnfoldedUserMessages('a');
    expect(peekUnfoldedUserMessages('b')).toEqual(['from b']);
  });

  it('ignores a blank message', () => {
    appendUnfoldedUserMessage('s', '   ');
    expect(peekUnfoldedUserMessages('s')).toEqual([]);
  });

  /** ⚠ THE REVERSE OF THE USUAL RING-BUFFER INSTINCT, DELIBERATELY. The NEWEST
   *  messages are still in `chat_tail`, so dropping them loses nothing the fold
   *  cannot still see. The OLDEST are the ones the tail has already forgotten,
   *  so they are the ones worth the slot. */
  it('keeps the OLDEST on overflow, because the tail still holds the newest', () => {
    for (let i = 0; i < UNFOLDED_MESSAGE_LIMIT + 5; i += 1) {
      appendUnfoldedUserMessage('s', `statement ${String(i)}`);
    }
    const kept = peekUnfoldedUserMessages('s');
    expect(kept).toHaveLength(UNFOLDED_MESSAGE_LIMIT);
    expect(kept[0]).toBe('statement 0');
    expect(kept).not.toContain(`statement ${String(UNFOLDED_MESSAGE_LIMIT + 4)}`);
  });

  it('renders the backlog into the fold prompt, and omits the field when empty', () => {
    const withBacklog = JSON.parse(buildBriefPrompt({
      userMessage: 'add it up',
      previous: null,
      since: [],
      earlierUserMessages: ['the levy is now 340'],
    })) as Record<string, unknown>;
    expect(withBacklog['pending_user_statements']).toEqual(['the levy is now 340']);

    const without = JSON.parse(buildBriefPrompt({
      userMessage: 'add it up',
      previous: null,
      since: [],
    })) as Record<string, unknown>;
    expect(without['pending_user_statements']).toBeUndefined();
  });

  it('tells the model what the field is', () => {
    expect(BRIEF_INSTRUCTION).toContain('pending_user_statements');
  });
});


describe('nothing_to_shrink — a fold that cannot shrink the packet', () => {
  const REAL = {
    budgetTokens: 40_000, catalogTokens: 15_740, overheadTokens: 2_441,
    tailTokens: 400,
  };

  /** ⛔⛔ `BRIEF_MIN_CALLS` BOUNDS THE FOLD'S COUNT; NOTHING BOUNDED ITS SIZE.
   *  A turn could hold three small results and still pay a full model call to
   *  replace them with something larger.
   *
   *  🔑 MEASURED (bench 369, fold #2): 291 B of results folded into a 301 B
   *  brief — the packet got BIGGER — for 1,933 tokens. Over that run the folds
   *  cost 14,077 tokens to save 15,084, so one non-shrinking fold was ~14% of
   *  the whole fold bill at negative return. */
  it('refuses a payload smaller than the brief that would replace it', () => {
    // Three calls clears BRIEF_MIN_CALLS, so only the SIZE rule can refuse it.
    const small = Array.from({ length: 3 }, () => call(120));
    const r = shouldBrief({ priorToolCalls: small, ...REAL });
    expect({ brief: r.brief, outcome: r.outcome })
      .toEqual({ brief: false, outcome: 'nothing_to_shrink' });
  });

  it('⛔ the PERMITTING WITNESS — a real payload still folds', () => {
    // Without this a guard that refused everything would pass the test above.
    const big = Array.from({ length: 4 }, () => call(9_600));
    expect(shouldBrief({ priorToolCalls: big, ...REAL }).brief).toBe(true);
  });

  it('the floor tracks the brief\'s own rendered size', () => {
    // ⚠ NOT an exact-boundary assertion — `call()` adds envelope bytes on top of
    //   the body, so pinning the precise crossover tests the fixture's framing
    //   rather than the rule. What matters is the DIRECTION: a payload clearly
    //   below what a brief renders at is refused, one clearly above it folds.
    //   And it isolates the FLOOR from the TRIGGER: the `over` payload clears
    //   the floor without reaching the trigger, so it must stop saying
    //   `nothing_to_shrink` while still not briefing. Asserting `brief === true`
    //   there would conflate the two rules and fail for the wrong reason.
    const under = Array.from({ length: 3 }, () => call(BRIEF_RENDERED_TOKENS / 8));
    const over = Array.from({ length: 3 }, () => call(BRIEF_RENDERED_TOKENS * 8));
    expect(shouldBrief({ priorToolCalls: under, ...REAL }).outcome)
      .toBe('nothing_to_shrink');
    expect(shouldBrief({ priorToolCalls: over, ...REAL }).outcome)
      .not.toBe('nothing_to_shrink');
  });

  it('a turn-end force WAIVES it — the boundary is about completeness', () => {
    // Mid-turn the fold is waste; at the boundary it is the record. See
    // FORCE_WAIVABLE_OUTCOMES.
    expect(FORCE_WAIVABLE_OUTCOMES.has('nothing_to_shrink')).toBe(true);
  });
});


describe('the backlog is a holding pen with a DEADLINE', () => {
  beforeEach(() => { __clearUnfoldedUserMessages(); });

  /** ⛔⛔ WITHOUT A DEADLINE THE PEN ASSERTS RELEVANCE IT HAS NOT EARNED. A
   *  statement would ride every packet until some fold happened to run, so a
   *  session RESUMED A MONTH LATER would still be carrying an unclassified line
   *  from before — STRICTLY WORSE than `chat_tail`, which would have let it go.
   *  The tail degrades gracefully because it never claims more than "this was
   *  just said".
   *
   *  ⚠ AGE IS MEASURED IN APPENDS (user turns), NOT WALL TIME — the same axis
   *  the tail uses. Wall time would make a resumed session look ancient when the
   *  conversation is simply continuing, which is a legitimate thing to do. */
  it('ages a pending statement in TURNS, not wall time', () => {
    appendUnfoldedUserMessage('s', 'the levy is 318');
    expect(oldestPendingStatementAge('s')).toBe(0);
    appendUnfoldedUserMessage('s', 'read block 3');
    appendUnfoldedUserMessage('s', 'read block 4');
    expect(oldestPendingStatementAge('s')).toBe(2);
  });

  it('goes stale at the deadline, and not before', () => {
    appendUnfoldedUserMessage('s', 'the levy is 318');
    for (let i = 1; i < MAX_PENDING_STATEMENT_TURNS; i += 1) {
      appendUnfoldedUserMessage('s', `filler ${String(i)}`);
      // ⛔ The PERMITTING WITNESS lives inside the loop: if this ever reports
      //   stale early, the deadline is decoration and the fold fires on
      //   everything.
      expect(hasStalePendingStatement('s')).toBe(false);
    }
    appendUnfoldedUserMessage('s', 'one more');
    expect(hasStalePendingStatement('s')).toBe(true);
  });

  it('an empty pen is never stale', () => {
    expect(oldestPendingStatementAge('s')).toBe(0);
    expect(hasStalePendingStatement('s')).toBe(false);
  });

  it('clearing resets the age — a fold classified it, the pen is empty', () => {
    for (let i = 0; i <= MAX_PENDING_STATEMENT_TURNS; i += 1) {
      appendUnfoldedUserMessage('s', `line ${String(i)}`);
    }
    expect(hasStalePendingStatement('s')).toBe(true);
    clearUnfoldedUserMessages('s');
    appendUnfoldedUserMessage('s', 'fresh');
    expect(hasStalePendingStatement('s')).toBe(false);
  });

  it('is per-session — one session going stale does not age another', () => {
    appendUnfoldedUserMessage('a', 'old');
    for (let i = 0; i <= MAX_PENDING_STATEMENT_TURNS; i += 1) {
      appendUnfoldedUserMessage('a', `x${String(i)}`);
    }
    appendUnfoldedUserMessage('b', 'new');
    expect(hasStalePendingStatement('a')).toBe(true);
    expect(hasStalePendingStatement('b')).toBe(false);
  });
});

/** D-214 ADMISSION QUALITY — is what the compiler admits worth admitting?
 *
 *  Every D-214 measurement so far tested PRESENTATION: does showing a card change
 *  behaviour? None tested ADMISSION JUDGEMENT: does this observation deserve to
 *  become durable precedent at all. A pre-registered non-inferiority run then
 *  measured a corpus that, on inspection, was mostly noise — of the three cases an
 *  LLM run produced, two were single observations of `RECIPE_BUDGET_EXCEEDED`
 *  ("this recipe ran longer than its time budget"), a stopwatch artifact promoted
 *  to precedent, one of them enshrining a tool the model should never have called.
 *
 *  This suite is deterministic — no model, no bench, seconds not hours — and
 *  varies the axes that decide admission:
 *
 *    • TOOL-CALL COUNT   1, 2, 3, 5  (the MIN_CALLS asymmetry lives here)
 *    • OUTCOME           success vs failure
 *    • FAILURE KIND      environmental/transient vs choice-attributable
 *    • RECURRENCE        1 root vs RECURRENCE_FLOOR roots
 *
 *  ⚠ Two kinds of test live here and they are NOT interchangeable:
 *    1. INVARIANTS — the documented floors. Normal assertions.
 *    2. GAP RATCHETS — behaviour we believe is WRONG, pinned so that fixing it
 *       fails this file and forces a deliberate decision. A gap ratchet must
 *       never read as approval; each says so in place.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  InternalToolRegistry,
  ToolEntry,
  ToolTier,
} from '@recued/contracts';
import {
  ERROR_ATTRIBUTION,
  OWNER_ATTRIBUTED_ERROR_CODES,
  EXECUTION_CASE_MIN_CALLS_NEGATIVE,
  EXECUTION_CASE_MIN_CALLS_POSITIVE,
  EXECUTION_CASE_RECURRENCE_FLOOR,
} from '@recued/contracts';

import type { ExecutionCaseFeedbackKind } from '@recued/contracts';
import { createExecutionCaseCompiler } from '../execution-case-compiler.js';
import {
  EXECUTION_CASE_COMPILER_VERSION,
  executionCaseOfferableVerdicts,
} from '../execution-case-core.js';
import { createExecutionCaseLifecycle } from '../chat-execution-case-tools.js';
import { createExecutionCaseFeedbackRecorder } from '../execution-case-feedback.js';
import { createExecutionCaseStore } from '../storage/execution-case-store.js';
import { createExecutionReportStore } from '../storage/execution-report-store.js';
import { createExecutionSpanAnchorStore } from '../storage/execution-span-anchor-store.js';
import { createExecutionSpanDissectionStore } from '../storage/execution-span-dissection-store.js';
import { createCaseInterventionStore } from '../storage/case-intervention-store.js';
import { createExecutionCaseFeedbackStore } from '../storage/execution-case-feedback-store.js';
import { createExecutionCaseVerificationStore } from '../storage/execution-case-verification-store.js';
import type { ChatDispatchContext } from '../chat-tool-handlers.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const keyProvider = (): D214KeyProvider => {
  const key = new Uint8Array(32).fill(31);
  return () => key;
};

const schema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (
      key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_activities (
      key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
};

const entry = (name: string, tier: ToolTier, cls: 'read' | 'write'): ToolEntry => ({
  name,
  tier,
  description: name,
  arg_schema: {},
  topic_tags: [name.split('.')[0]!],
  classification: cls,
  risk_tier: cls,
  concurrency_safe: cls === 'read',
});

/** A pool wide enough to build 1-, 2-, 3- and 5-call flows. */
const TOOLS: ToolEntry[] = [
  entry('contact.search', 1, 'read'),
  entry('calendar.list', 1, 'read'),
  entry('memory.search', 1, 'read'),
  entry('file.list', 1, 'read'),
  entry('recipe.run', 3, 'write'),
  // ⚠ V22 — admission counts distinct NON-core rounds, so a fixture needs
  // several Tier-2/3 ops to be admissible at all. The Tier-1 reads above are
  // exactly what the gate is designed to discount.
  entry('acme/invoice-book', 2, 'write'),
  entry('acme/ledger-post', 2, 'write'),
];

const registry = (): InternalToolRegistry => ({
  list: () => TOOLS,
  listByTier: (tier: ToolTier) => TOOLS.filter((e) => e.tier === tier),
  getByName: (name) => TOOLS.find((e) => e.name === name) ?? null,
  dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
  subscribeRefresh: () => () => {},
});

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
    db, key, new TextEncoder().encode('admission-quality-secret'),
  );
  const feedbackStore = createExecutionCaseFeedbackStore(db);
  const verificationStore = createExecutionCaseVerificationStore(db);
  const tools = registry();
  const compiler = createExecutionCaseCompiler({
    db, anchorStore, reportStore, caseStore,
    dissectionStore, feedbackStore, verificationStore, registry: tools,
  });
  let clock = 1_000;
  let reportSeq = 0;
  const lifecycle = createExecutionCaseLifecycle({
    anchorStore,
    reportStore,
    caseStore: undefined as never,
    dissectionStore,
    compiler,
    registry: tools,
    interventionStore,
    now: () => clock++,
    // ⚠ MUST vary: a fixed report id collapses every root onto one report and
    // silently turns a 3-root recurrence test into a 1-root one.
    newReportId: () => `report-${reportSeq++}`,
  } as Parameters<typeof createExecutionCaseLifecycle>[0]);
  // D-219 slice 2 — with `unverified_success` inert, the ONLY way to build a
  // firm positive is owner-typed acceptance. Without this the "permitted case"
  // assertions below would be vacuous: a substrate admitting nothing would pass
  // every one of them.
  const feedbackRecorder = createExecutionCaseFeedbackRecorder({
    anchorStore, feedbackStore, reportStore, caseStore,
    interventionStore, compiler, now: () => clock++,
  });
  return { db, anchorStore, reportStore, caseStore, compiler, lifecycle, feedbackRecorder };
};

const context = (session: string, turn: string): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: session,
  turn_id: turn,
  turn_state: new Map<string, unknown>(),
});

const addActivity = (
  db: Database.Database,
  input: {
    id: string; at: number; tool: string; session: string; turn: string;
    /** V20 tool-loop round. V22 admission measures DEPTH in rounds; omitting it
     *  empties `round_ordinals`, which reads as "cannot judge" and refuses. */
    round?: number;
  },
): void => {
  db.prepare('INSERT OR REPLACE INTO audit_activities (key, data) VALUES (?, ?)')
    .run(input.id, JSON.stringify({
      activity_id: input.id,
      timestamp: input.at,
      action: 'chat_tool_call',
      target: `${input.session}:${input.turn}:${input.tool}`,
      detail: JSON.stringify({
        status: 'ok',
        ...(input.round !== undefined ? { round_index: input.round } : {}),
      }),
    }));
};

const putRecipeRun = (
  db: Database.Database,
  input: {
    id: string; at: number; recipe: string; status: string;
    errorCodes?: string[]; session: string; turn: string;
  },
): void => {
  db.prepare('INSERT OR REPLACE INTO audit_entries (key, data) VALUES (?, ?)')
    .run(input.id, JSON.stringify({
      run_id: input.id,
      recipe_id: input.recipe,
      recipe_hash: `hash-${input.recipe}`,
      started_at: input.at,
      finished_at: input.at + 1,
      commit_status: input.status,
      errors: (input.errorCodes ?? []).map((code) => ({ code })),
      execution_source: {
        channel: 'chat', actor: 'user_self',
        chat_session_id: input.session, user_id: 'owner', turn_id: input.turn,
      },
    }));
};

/** Failure codes that say something about THE MOMENT, not about the choice.
 *  Retrying later, or on a faster machine, would succeed. */
const ENVIRONMENTAL = [
  'RECIPE_BUDGET_EXCEEDED',      // "ran longer than its time budget" — a stopwatch
  'ACTION_DELIVERY_UNCERTAIN',   // the write may in fact have landed
  'NETWORK_ERROR',
  'API_RATE_LIMITED',
] as const;

/** Failure codes that ARE about the choice — the tool or scope was wrong, and
 *  "for this ask, not tool A" is a genuine lesson. */
/** By-design stops. The recipe declined to act and was right to. */
const CONDITIONAL = [
  'RECIPE_GUARD_TRIGGERED',
  'RECIPE_FAIL_ON_TRIGGERED',
  'RECIPE_PREREQUISITE_NOT_MET',
] as const;

const CHOICE_ATTRIBUTABLE = [
  'INGREDIENT_NOT_FOUND',
  'MCP_TOOL_NOT_FOUND',
  'INGREDIENT_SCOPE_INSUFFICIENT',
] as const;

const REQUEST = 'summarise the quarterly account review and send it on';

/** Drive `roots` independent turns of the same request through a flow of
 *  `calls` tool calls, ending in a recipe run with the given status/codes.
 *  Returns the cases the compiler admitted. */
const observe = async (opts: {
  calls: number;
  status: 'succeeded' | 'failed';
  codes?: readonly string[];
  roots?: number;
  request?: string;
  /** Record owner acceptance after each turn — the only firm positive there is
   *  now that `unverified_success` is inert. */
  accept?: boolean;
  /** Record a specific owner verdict instead (slice 6). */
  feedback?: 'accepted' | 'corrected' | 'rejected' | 'undone';
}) => {
  const f = await fixture();
  const roots = opts.roots ?? 1;
  for (let r = 0; r < roots; r += 1) {
    const session = `s${r}`;
    const turn = `t${r}`;
    await f.anchorStore.openSpan({
      root_request_id: `root-${r}`,
      session_id: session,
      surface: 'chat',
      root_request: opts.request ?? REQUEST,
      turn_id: turn,
      now: 100 + r * 10,
    });
    // `calls - 1` reads, then the recipe.run that carries the outcome.
    for (let c = 0; c < opts.calls - 1; c += 1) {
      // ⚠ D-219 slice 8 — DISTINCT tools per step. The pool is indexed rather
      // than cycled because a repeated tool now excludes the observation, and a
      // fixture that silently cycled would make every long flow untestable.
      addActivity(f.db, {
        id: `a-${r}-${c}`, at: 101 + r * 10 + c,
        tool: TOOLS[c]!.name, session, turn,
      });
    }
    addActivity(f.db, {
      id: `a-${r}-run`, at: 108 + r * 10, tool: 'recipe.run', session, turn,
    });
    putRecipeRun(f.db, {
      id: `run-${r}`, at: 108 + r * 10, recipe: 'quarterly-review',
      status: opts.status, errorCodes: [...(opts.codes ?? [])], session, turn,
    });
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context(session, turn));
    await f.lifecycle.finalizeTurn({ session_id: session, turn_id: turn });
    const verdict = opts.feedback ?? (opts.accept ? 'accepted' : undefined);
    if (verdict) {
      await f.feedbackRecorder.record({
        session_id: session, turn_id: turn, kind: verdict,
      });
    }
  }
  const cases = await f.caseStore.listAll();
  const observations = await f.caseStore.listObservations();
  return {
    admitted: cases.length,
    cases,
    observations: observations.length,
    kinds: [...new Set(observations.flatMap((o) => o.evidence_kinds))].sort(),
    toolCounts: cases.map((c) => c.flows.map((fl) => fl.tools.length)),
  };
};

/** What the owner would be offered for a turn of this shape. */
const offerFor = async (opts: {
  calls: number;
  status?: 'succeeded' | 'failed';
}): Promise<ExecutionCaseFeedbackKind[]> => {
  const f = await fixture();
  await f.anchorStore.openSpan({
    root_request_id: 'root-offer', session_id: 'so', surface: 'chat',
    root_request: REQUEST, turn_id: 'to', now: 100,
  });
  // ⚠ Each call gets its OWN round and a NON-core tool, so `calls` is also the
  // flow's non-core DEPTH — which is what V22 admission actually measures.
  const NON_CORE = ['acme/invoice-book', 'acme/ledger-post'];
  for (let c = 0; c < opts.calls - 1; c += 1) {
    addActivity(f.db, {
      id: `off-${c}`, at: 101 + c, tool: NON_CORE[c % NON_CORE.length]!,
      session: 'so', turn: 'to', round: c,
    });
  }
  addActivity(f.db, {
    id: 'off-run', at: 108, tool: 'recipe.run', session: 'so', turn: 'to',
    round: Math.max(opts.calls - 1, 0),
  });
  putRecipeRun(f.db, {
    id: 'run-offer', at: 108, recipe: 'quarterly-review',
    status: opts.status ?? 'succeeded',
    errorCodes: opts.status === 'failed' ? ['INGREDIENT_NOT_FOUND'] : [],
    session: 'so', turn: 'to',
  });
  await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context('so', 'to'));
  await f.lifecycle.finalizeTurn({ session_id: 'so', turn_id: 'to' });
  const [obs] = await f.caseStore.listObservations();
  return obs ? executionCaseOfferableVerdicts(obs) : [];
};

describe('D-214 admission quality — what does the compiler consider worth remembering?', () => {
  // ────────────────────────────────────────────────────────────
  // 1. INVARIANTS — the documented floors
  // ────────────────────────────────────────────────────────────

  it('the COMPILER VERSION is pinned — a change to admission must bump it', () => {
    // ⛔ A RATCHET, and it exists because the mutation that removed the D-219
    // slice-2 bump SURVIVED every other test in this file.
    //
    // `ensureCurrent` skips all work while the stored version matches, so a
    // slice that changes what is admitted WITHOUT bumping reaches only NEW
    // spans while every existing case keeps the old verdict — here, its
    // self-reported positive. The failure is silent: the code is correct, the
    // tests are green, and the corpus stays poisoned.
    //
    // Changing this number is therefore a deliberate act. If you are here
    // because this test failed, the question is not "what should the number be"
    // but "did I mean to change admission, and does the corpus need re-deriving".
    //
    // ⚠ V19 is the first bump in this arc that changes NO admission outcome.
    // It adds `tool_sequence` to the compiled flow, and it needs the bump for
    // V17's reason instead: materialized cases are sealed JSON, so a new field
    // reaches only what is written NEXT and every stored V18 case would render
    // an ABSENT sequence — an empty shape card that reads as "this precedent
    // used no tools". Re-deriving is what populates it.
    //
    // ⚠ V20 adds `round_ordinals` — which tool-loop round emitted each step —
    // and its bump is UNLIKE every other one here: re-deriving recovers
    // NOTHING. No audit row written before V20 carries a round, so every
    // existing flow correctly compiles to an empty array whether or not the
    // corpus is replayed. The bump is purely so a READER can tell the two
    // empties apart: "this flow was one batch" (V20, populated) from "this
    // flow predates the field" (V19, absent). Without it a stored V19 payload
    // and a genuinely round-less V20 one are indistinguishable at runtime,
    // which is the trap V17 and V19 each hit from the other direction.
    //
    // ⚠ V21 adds `recipe_steps` — WHICH recipe each step dispatched, by
    // ordinal — and unlike V20 the re-derive DOES recover the whole existing
    // corpus: `pairRecipeRuns` has attached the per-step `recipe_id` to the
    // observation's flow pattern all along, and only the compiled flow dropped
    // it. What it fixes is a card rendering the bare string `recipe.run`, which
    // is the DISPATCHER — it reports that a recipe ran without reporting which
    // one. Scope is that route only: 98 live invocations against 1359 by slug
    // (~7%), since a slug step already names its own recipe.
    expect(EXECUTION_CASE_COMPILER_VERSION).toBe(22);
  });

  it('the MIN_CALLS asymmetry holds at the documented values', () => {
    // Pinned from contracts so a silent re-tuning of either floor lands here
    // rather than only in a bench run months later.
    // ⚠ D-219 slice 7 — the asymmetry is GONE. Candidacy is uniform: a turn is a
    // case candidate when the model made MORE THAN ONE governed call between the
    // request and its answer. See the reversal note in contracts, which keeps the
    // old rule and its reasoning rather than overwriting them.
    expect(EXECUTION_CASE_MIN_CALLS_NEGATIVE).toBe(2);
    expect(EXECUTION_CASE_MIN_CALLS_POSITIVE).toBe(2);
    expect(EXECUTION_CASE_RECURRENCE_FLOOR).toBe(3);
  });

  it('a ONE-call SUCCESS is not admitted, and it is the CALL floor doing it', async () => {
    // The contracts' justification: "a correct single-call answer is already
    // optimal — no sequence to remember, no discovery to short-circuit."
    //
    // ⚠ RUN AT THE RECURRENCE FLOOR — at 1 root this passes even with
    // MIN_CALLS_POSITIVE mutated, because recurrence blocks it anyway, and the
    // test would be named for a guarantee it never exercised.
    // ⚠ AND WITH OWNER ACCEPTANCE — since slice 2 a success carries no positive
    // evidence on its own, so without `accept` BOTH arms are zero and this
    // passes for the wrong reason.
    const one = await observe({ calls: 1, status: 'succeeded', roots: 3, accept: true });
    const two = await observe({ calls: 2, status: 'succeeded', roots: 3, accept: true });
    expect(one.admitted).toBe(0);
    expect(two.admitted).toBeGreaterThan(0);   // the case the floor PERMITS
  });

  it('D-219 CONSEQUENCE: there is no WEAK positive left, so the recurrence floor is unreachable for positives', async () => {
    // ⚠ A STRUCTURAL CONSEQUENCE OF SLICE 2, found by this test failing.
    //
    // `RECURRENCE_FLOOR = 3` gates WEAK evidence; strong evidence admits at one
    // observation. `unverified_success` was the only weak positive. Both
    // survivors — `typed_acceptance` and `verification_pass` — are STRONG, so a
    // single owner acceptance now admits, and the floor cannot bind a positive
    // any more.
    //
    // That is correct: an owner saying "yes, that worked" once is firm evidence
    // and should not need saying three times. It is recorded because the floor
    // silently stopping to apply on one side is exactly the kind of change that
    // otherwise gets discovered years later.
    // Admitting at ONE root IS the proof that `typed_acceptance` is strong —
    // nothing else needs asserting, and a helper restating it would assert
    // nothing at all.
    const oneRoot = await observe({ calls: 3, status: 'succeeded', roots: 1, accept: true });
    expect(oneRoot.admitted).toBeGreaterThan(0);
    // ⚠ Contrast: the same shape WITHOUT acceptance must still admit nothing, or
    // this would pass against a substrate that admits everything.
    const unwitnessed = await observe({ calls: 3, status: 'succeeded', roots: 1 });
    expect(unwitnessed.admitted).toBe(0);
    // The floor still exists and still binds weak NEGATIVES — see the
    // untyped_decline / abandoned members of negativeKinds that are not strong.
    expect(EXECUTION_CASE_RECURRENCE_FLOOR).toBe(3);
  });

  it('D-219: an UNWITNESSED success is not evidence — only owner acceptance is', async () => {
    // Was "what a POSITIVE case actually rests on: the model saying so", which
    // asserted every positive rested on `unverified_success`. Slice 2 retires
    // that kind to INERT and this asserts the replacement.
    //
    // `unverified_success` meant "the span ended without a terminal error" — the
    // original ratchet's own words were "success means no terminal error, not
    // fulfilment". It is not moved to negative; it stops counting. An unwitnessed
    // success is not evidence in either direction.
    const rows: string[] = [];
    for (const calls of [2, 3, 5]) {
      const silent = await observe({ calls, status: 'succeeded', roots: 3 });
      const witnessed = await observe({ calls, status: 'succeeded', roots: 3, accept: true });
      rows.push(`  calls=${calls}  unwitnessed → ${silent.admitted}`
        + `   owner-accepted → ${witnessed.admitted}  ${JSON.stringify(witnessed.kinds)}`);
      expect(silent.admitted).toBe(0);
      expect(witnessed.admitted).toBeGreaterThan(0);
      expect(witnessed.kinds).toContain('typed_acceptance');
    }
    console.log('\nD-219 POSITIVES — unwitnessed vs owner-accepted:\n' + rows.join('\n'));
  });

  it('⛔ the call-count gap NARROWED by elimination — it still holds ABOVE the floor', async () => {
    // ⚠ THE GAP CHANGED SHAPE, and this test changed with it rather than being
    // deleted or quietly passed.
    //
    // It used to read "a 1-call blip files like a 5-call discovery", witnessed
    // with a failure. Slice 3 excludes every failure, so that framing is closed
    // BY ELIMINATION — not because anyone taught admission to weigh complexity,
    // but because the class it applied to stopped admitting.
    //
    // What survives: for POSITIVES the call floor does bind at 1 (MIN_CALLS_
    // POSITIVE = 2), but ABOVE it length is still not an input — 2 calls and 5
    // calls are indistinguishable, though only one of them is a discovery worth
    // short-circuiting.
    const one = await observe({ calls: 1, status: 'succeeded', roots: 1, accept: true });
    const two = await observe({ calls: 2, status: 'succeeded', roots: 1, accept: true });
    const five = await observe({ calls: 5, status: 'succeeded', roots: 1, accept: true });
    expect(one.admitted).toBe(0);                 // the floor DOES bind at 1
    expect(two.admitted).toBe(five.admitted);     // …and stops mattering after
    expect(two.admitted).toBeGreaterThan(0);      // non-vacuity
    expect(five.toolCounts).toEqual([[5]]);       // the 5-call flow really was 5
  });

  it('reports admission across call counts and outcomes', async () => {
    const rows: string[] = [];
    for (const calls of [1, 2, 3, 5]) {
      const failed = await observe({
        calls, status: 'failed', codes: CHOICE_ATTRIBUTABLE.slice(0, 1),
      });
      const accepted = await observe({
        calls, status: 'succeeded', roots: 1, accept: true,
      });
      rows.push(`  calls=${calls}  failed → ${failed.admitted}`
        + `   owner-accepted → ${accepted.admitted}`);
    }
    console.log('\nD-219 ADMISSION BY CALL COUNT:\n' + rows.join('\n'));
    expect(rows).toHaveLength(4);
  });

  // ────────────────────────────────────────────────────────────
  // D-219 SLICE 3 — failures and denials are EXCLUSIONS
  // ────────────────────────────────────────────────────────────

  it('✅ SLICE 3: a FAILURE is not a case, whatever its cause', async () => {
    // Supersedes the earlier environmental-vs-choice pair. Slice 2's attribution
    // gate distinguished a stopwatch from a real lesson; slice 3 makes the
    // distinction moot FOR ADMISSION — a flow that broke never finished, so
    // there is no lesson in it either way, and none of them file.
    const rows: string[] = [];
    for (const code of [...ENVIRONMENTAL, ...CONDITIONAL, ...CHOICE_ATTRIBUTABLE]) {
      const r = await observe({ calls: 2, status: 'failed', codes: [code] });
      rows.push(`  ${code.padEnd(30)} admitted ${r.admitted}`);
      expect(r.admitted).toBe(0);
    }
    const uncoded = await observe({ calls: 2, status: 'failed', codes: [] });
    expect(uncoded.admitted).toBe(0);
    console.log('\nSLICE 3 — every failure excluded:\n' + rows.join('\n'));
    // ⚠ THE PERMITTED CASE. Without it a substrate admitting NOTHING passes all
    // of the above, which is precisely the shape D-219 risks.
    const accepted = await observe({ calls: 2, status: 'succeeded', roots: 1, accept: true });
    expect(accepted.admitted).toBeGreaterThan(0);
  });

  it('⚠ slice 3 SUBSUMES most of slice 4 — the attribution axis no longer gates admission', async () => {
    // Recorded so the remaining slice is not over-scoped. With every failure
    // excluded, an environmental code and a choice code are indistinguishable AT
    // ADMISSION: both produce nothing. The attribution table still classifies,
    // and still matters wherever a code reaches a surface other than admission,
    // but the gate slice 2 added to the compiler is now dead weight.
    const env = await observe({ calls: 2, status: 'failed', codes: ['RECIPE_BUDGET_EXCEEDED'] });
    const choice = await observe({ calls: 2, status: 'failed', codes: ['INGREDIENT_NOT_FOUND'] });
    const cond = await observe({ calls: 2, status: 'failed', codes: ['RECIPE_GUARD_TRIGGERED'] });
    expect([env.admitted, choice.admitted, cond.admitted]).toEqual([0, 0, 0]);
  });

  it('✅ SLICE 4: an env-only failure is RECORDED honestly, then excluded', async () => {
    // Slice 2 suppressed the `execution_failure` derivation when every code was
    // environmental. Slice 3 then excluded that kind outright, so the gate
    // changed no admission outcome — measured, with and without it, every row of
    // a six-way probe was identical.
    //
    // What it did change was the RECORD: the observation claimed no failure had
    // occurred when one had. Slice 4 removes it, so the evidence says what
    // happened and admission declines it at the one structural gate.
    const r = await observe({ calls: 2, status: 'failed', codes: ['RECIPE_BUDGET_EXCEEDED'] });
    expect(r.kinds).toContain('execution_failure');   // recorded honestly…
    expect(r.admitted).toBe(0);                       // …and still not a case
  });

  it('⚠ SLICE 4 STOPS HERE: a firm positive KEEPS an incidental env code', async () => {
    // ⛔ The exclusion deliberately does NOT extend to codes on a witnessed
    // success. This was the only path where an env or conditional code still
    // reached admission after slice 3, and excluding it would discard the
    // OWNER'S ACCEPTANCE because a rate limit happened somewhere in the flow.
    // The signal is the acceptance; the code is incidental.
    const accepted = await observe({
      calls: 2, status: 'succeeded', roots: 1, accept: true, codes: ['RECIPE_BUDGET_EXCEEDED'],
    });
    expect(accepted.admitted).toBeGreaterThan(0);
    expect(accepted.kinds).toContain('typed_acceptance');
  });

  // ────────────────────────────────────────────────────────────
  // D-219 SLICE 6 — the OFFER: which verdicts would actually file
  // ────────────────────────────────────────────────────────────

  it('SLICE 6: the offer NEVER promises what admission would refuse', async () => {
    // ⛔ THE PROPERTY THAT MATTERS. A prompt offering a verdict the compiler
    // would then decline is worse than no prompt: the owner answers, believes
    // they have taught it something, and nothing is learned. That is
    // assurance-shaped non-assurance, which this substrate exists to avoid.
    //
    // Driven END-TO-END rather than asserted against the predicate: for every
    // offered verdict, actually record it and check a case forms.
    const shapes: Array<{ label: string; calls: number }> = [
      { label: '1 call ', calls: 1 },
      { label: '2 calls', calls: 2 },
      { label: '5 calls', calls: 5 },
    ];
    const rows: string[] = [];
    for (const { label, calls } of shapes) {
      const offered = await offerFor({ calls });
      rows.push(`  ${label} → offers ${JSON.stringify(offered)}`);
      for (const verdict of offered) {
        const r = await observe({
          calls, status: 'succeeded', roots: 1, feedback: verdict,
        });
        expect(
          r.admitted,
          `offered '${verdict}' at ${calls} call(s) but admission refused it`,
        ).toBeGreaterThan(0);
      }
    }
    console.log('\nSLICE 6 — offered verdicts by call count:\n' + rows.join('\n'));
  });

  it('SLICE 6/7 + V22: under three NON-CORE rounds is offered NOTHING', async () => {
    // The call floors differ by polarity, so the offer must too. Asserting both
    // halves: without the second, a predicate returning [] always would pass.
    // ⚠ D-219 slice 7 made the two call floors equal, so this pinned a uniform
    // bar rather than the asymmetry it was written for. V22 moved the bar again
    // and changed its UNIT: admission now needs three distinct NON-CORE rounds
    // (`EXECUTION_CASE_MIN_DISTINCT_ROUNDS`), because a two-call turn is one the
    // model batches into a single round and derives unaided — measured to make
    // fabrication WORSE when taught back. `offerFor` gives each call its own
    // round, so `calls` reads as depth here.
    //
    // ⛔ Both halves still asserted: without the permitting one, a predicate
    // that returned [] unconditionally would pass.
    expect(await offerFor({ calls: 1 })).toEqual([]);
    expect(await offerFor({ calls: 2 })).toEqual([]);
    expect(await offerFor({ calls: 3 })).toContain('accepted');
  });

  it('SLICE 10: a turn whose approval EXPIRED unanswered is not a case at all', async () => {
    // ⛔ RULED 2026-07-28 — SILENCE IS NOT A VERDICT. `abandoned` is derived from
    // `RECIPE_APPROVAL_TIMEOUT`: the owner was asked and never answered. Filing
    // that as a negative concludes something about the APPROACH from an absence,
    // which the contracts already refuse one layer up ("no later complaint is not
    // evidence"). The owner was busy, or away, or the moment passed.
    //
    // ⚠ WAS "not offered `accepted`". That weaker claim was the WITNESS for the
    // positive-contradiction guard in `executionCaseOfferableVerdicts`, and this
    // exclusion takes its fixture away — see the sibling test below, which keeps
    // the guard proven on the only inputs that can still reach it.
    const f = await fixture();
    await f.anchorStore.openSpan({
      root_request_id: 'r-exp', session_id: 's-exp', surface: 'chat',
      root_request: REQUEST, turn_id: 't-exp', now: 100,
    });
    addActivity(f.db, { id: 'e0', at: 101, tool: 'contact.search', session: 's-exp', turn: 't-exp' });
    addActivity(f.db, { id: 'e1', at: 102, tool: 'recipe.run', session: 's-exp', turn: 't-exp' });
    putRecipeRun(f.db, {
      id: 'run-exp', at: 102, recipe: 'quarterly-review', status: 'failed',
      errorCodes: ['RECIPE_APPROVAL_TIMEOUT'], session: 's-exp', turn: 't-exp',
    });
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context('s-exp', 't-exp'));
    await f.lifecycle.finalizeTurn({ session_id: 's-exp', turn_id: 't-exp' });
    const [obs] = await f.caseStore.listObservations();
    // The observation still RECORDS what happened — the exclusion is about
    // admission, not about pretending the timeout did not occur.
    expect(obs!.outcome.authorization).toBe('expired');
    expect(obs!.evidence_kinds).toContain('abandoned');
    expect(executionCaseOfferableVerdicts(obs!)).toEqual([]);
    expect(await f.caseStore.listAll()).toEqual([]);
    // ⚠ THE PERMITTING WITNESS. The same shape WITHOUT the timeout is fully
    // offerable, so this cannot pass against a predicate that refuses everything.
    expect(await offerFor({ calls: 3 })).toContain('corrected');
  });

  it('SLICE 10 CONSEQUENCE: the positive-contradiction guard is now unreachable from a compiled turn', async () => {
    // ⚠⚠ PINS A GAP THAT DELETION CREATED. `executionCaseOfferableVerdicts`
    // refuses `accepted` when the outcome contradicts it — `dismissed`/`expired`
    // authorization, or `in_doubt`/`skipped`/`not_executed` execution. After
    // slice 10 no COMPILED observation can carry any of those and still be a
    // candidate: `expired` and `not_executed` come only from `abandoned` or a
    // denial (both excluded), `dismissed` only from a cancelled plan (recorded
    // with one call, below the floor since slice 7), and `in_doubt`/`skipped`
    // are never derived at all.
    //
    // ⛔ UNREACHABLE IS NOT HANDLED. The guard is KEPT — it still covers replayed,
    // hand-built, and future-producer observations — so it is proven here on a
    // synthetic one, and this test is the record that the end-to-end fixture that
    // used to prove it no longer exists.
    const f = await fixture();
    await f.anchorStore.openSpan({
      root_request_id: 'r-guard', session_id: 's-guard', surface: 'chat',
      root_request: REQUEST, turn_id: 't-guard', now: 100,
    });
    // ⚠ V22 — three distinct NON-core rounds, or the turn is not a candidate for
    // an unrelated reason and this test would pin nothing.
    addActivity(f.db, {
      id: 'g0', at: 101, tool: 'acme/invoice-book', session: 's-guard',
      turn: 't-guard', round: 0,
    });
    addActivity(f.db, {
      id: 'g1', at: 102, tool: 'acme/ledger-post', session: 's-guard',
      turn: 't-guard', round: 1,
    });
    addActivity(f.db, {
      id: 'g2', at: 103, tool: 'recipe.run', session: 's-guard',
      turn: 't-guard', round: 2,
    });
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context('s-guard', 't-guard'));
    await f.lifecycle.finalizeTurn({ session_id: 's-guard', turn_id: 't-guard' });
    const [compiled] = await f.caseStore.listObservations();
    // The compiled turn is a full candidate…
    expect(executionCaseOfferableVerdicts(compiled!)).toContain('accepted');
    // …and the same turn with a contradicting outcome grafted on is not.
    const contradicted = {
      ...compiled!,
      outcome: { ...compiled!.outcome, execution: 'in_doubt' as const },
    };
    const offered = executionCaseOfferableVerdicts(contradicted);
    expect(offered).not.toContain('accepted');
    expect(offered).toContain('corrected');
  });

  it('SLICE 6: an EXCLUDED observation is never offered at all', async () => {
    // A breakage or a denial carries no lesson either way, so there is nothing
    // to ask about — asking would invite an answer that could not be filed.
    expect(await offerFor({ calls: 2, status: 'failed' })).toEqual([]);
  });

  it('SLICE 5: every observation records the SESSION it came from', async () => {
    // ⚠ A DECLARED FIELD IS NOT A BACKED ONE. This asserts the value is actually
    // populated at BOTH construction sites, not merely present on the type — a
    // field that types fine and arrives empty is the failure mode this whole
    // arc kept hitting.
    //
    // Nothing consumes it yet, deliberately: it unblocks an owner-iteration
    // filter whose residual cannot be measured on any traffic that exists.
    const f = await fixture();
    await f.anchorStore.openSpan({
      root_request_id: 'r-sess', session_id: 'session-under-test', surface: 'chat',
      root_request: REQUEST, turn_id: 't-sess', now: 100,
    });
    addActivity(f.db, { id: 's0', at: 101, tool: 'contact.search', session: 'session-under-test', turn: 't-sess' });
    addActivity(f.db, { id: 's1', at: 102, tool: 'recipe.run', session: 'session-under-test', turn: 't-sess' });
    putRecipeRun(f.db, {
      id: 'run-sess', at: 102, recipe: 'quarterly-review', status: 'succeeded',
      session: 'session-under-test', turn: 't-sess',
    });
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context('session-under-test', 't-sess'));
    await f.lifecycle.finalizeTurn({ session_id: 'session-under-test', turn_id: 't-sess' });
    const obs = await f.caseStore.listObservations();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.session_id).toBe('session-under-test');
  });

  it('SLICE 8: a flow that REPEATS a tool is not a candidate', async () => {
    // A retry or a loop, not a procedure. Measured on bench traffic: 16.4% of
    // otherwise-eligible candidates repeat a tool, and every observed shape was
    // floundering — [send, send], [search, send, search, send], [search, write]
    // five times over.
    const f = await fixture();
    await f.anchorStore.openSpan({
      root_request_id: 'r-rep', session_id: 's-rep', surface: 'chat',
      root_request: REQUEST, turn_id: 't-rep', now: 100,
    });
    // the SAME tool twice
    addActivity(f.db, { id: 'p0', at: 101, tool: 'contact.search', session: 's-rep', turn: 't-rep' });
    addActivity(f.db, { id: 'p1', at: 102, tool: 'contact.search', session: 's-rep', turn: 't-rep' });
    putRecipeRun(f.db, {
      id: 'run-rep', at: 102, recipe: 'quarterly-review', status: 'succeeded',
      session: 's-rep', turn: 't-rep',
    });
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context('s-rep', 't-rep'));
    await f.lifecycle.finalizeTurn({ session_id: 's-rep', turn_id: 't-rep' });
    await f.feedbackRecorder.record({ session_id: 's-rep', turn_id: 't-rep', kind: 'accepted' });
    const obs = await f.caseStore.listObservations();
    expect(obs[0]!.flow_pattern.tool_sequence).toEqual(['contact.search', 'contact.search']);
    expect(await f.caseStore.listAll()).toEqual([]);

    // ⚠ THE PERMITTED CASE — two DISTINCT tools, owner-accepted, still admits.
    // Without it a substrate excluding everything would pass the assertion above.
    const ok = await observe({ calls: 2, status: 'succeeded', roots: 1, accept: true });
    expect(ok.admitted).toBeGreaterThan(0);
  });

  it('SLICE 8: the tool SEQUENCE is recorded in order, with repeats', async () => {
    // ⚠ `topic_tags` deduplicates and `abstract_steps` collapses to READ/WRITE,
    // so neither could answer "was the same tool called twice". This also makes
    // flow SHAPE expressible for the first time: a five-step discovery and a
    // one-step call used to render identically on a card.
    const r = await observe({ calls: 3, status: 'succeeded', roots: 1, accept: true });
    expect(r.admitted).toBeGreaterThan(0);
    const seq = r.cases[0]!.flows[0]!;
    expect(seq.tools.length).toBeGreaterThan(1);
  });

  it('the compiler\'s owner-refusal set stays a SUBSET of owner-attributed codes', async () => {
    // A ratchet, not a derivation. The compiler deliberately excludes
    // RECIPE_APPROVAL_TIMEOUT from refusals (an expiry is `abandoned`, a third
    // outcome), so the sets are not identical and must not be auto-derived. This
    // catches the two drifting apart — the hand-copied-vocabulary failure mode.
    for (const code of ['RECIPE_POLICY_DENIED', 'RECIPE_APPROVAL_DENIED']) {
      expect(OWNER_ATTRIBUTED_ERROR_CODES.has(code)).toBe(true);
    }
    expect(ERROR_ATTRIBUTION.RECIPE_APPROVAL_TIMEOUT).toBe('owner');
  });
});

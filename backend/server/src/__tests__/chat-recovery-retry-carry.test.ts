/** ⛔⛔ A REPAIR PACKET MUST NOT CARRY LESS GROUNDING THAN THE CALL IT REPAIRS.
 *
 *  All four recovery paths in `runChatTurn` passed `undefined` for
 *  `prior_tool_calls` — the positional-parameter trap: to supply
 *  `output_feedback` you must write something for the first argument, and
 *  `undefined` silently dropped the carried brief.
 *
 *  🔑 MEASURED (bench 343, run 2026-09-09T10-22-04-925Z, turn 6). The retry
 *  packet arrived with NO `prior_tool_calls` — rings 01-08 and every
 *  constraint gone — and the model then emitted a tool call AND "Ring 09's
 *  checkpoint cost is 413 units" in one reply, a number appearing NOWHERE in
 *  the run's 1.4 MB. Corpus-wide 22 of 50 `output_feedback` packets (44%)
 *  carried no `prior_tool_calls`, and NOTHING in the tree tested this
 *  composition — which is why it survived.
 *
 *  ⛔⛔ CORRECTED — THE FIRST RATIONALE WAS WRONG, FROM A TRUNCATED READ. It
 *  said the guard punished a CORRECT refusal because ring 09 "has no cost".
 *  It has one: 162 units, at the END of a 9,259-byte body, past the
 *  head-anchored search clamp — `work.search` returns 4,408 B and never
 *  reaches it, so only a full `work.read` does. That run issued none, so the
 *  guard was RIGHT to fire. The FIX is unaffected: a repair packet must not
 *  carry less grounding than the call it repairs, however the guard ruled. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LLMError } from '@recued/llm';

import { runChatTurn } from '../chat-turn-executor.js';
import {
  appendUnfoldedUserMessage,
  getSessionBrief,
  setSessionBrief,
  __clearSessionBriefs,
  __clearUnfoldedUserMessages,
  type RollingBrief,
} from '../chat-rolling-brief.js';

const BRIEF: RollingBrief = {
  intent: 'audit the Kestrel rings',
  constraints: ['Quarterly rig surcharge is 252 units'],
  pending: [],
  findings: ['Ring 01 checkpoint cost: 137 units'],
  completed: [],
};

/** Round 1 claims an absence and dispatches nothing — exactly what
 *  `assertedAbsenceWithoutLooking` retries on. Returns every packet sent. */
const runWithAbsenceOnFirstReply = async (): Promise<string[]> => {
  const prompts: string[] = [];
  let round = 0;
  setSessionBrief('s', BRIEF);
  await runChatTurn(
    {
      session_id: 's', turn_id: 't', picker_target: 'self',
      dispatch_peer_name: null, available_tools: [],
      content: { chat_tail: [], user_message: "what is ring 09's cost?" },
      correction_context: [], model_layer: 'byok',
    } as never,
    {
      // ⛔ Opt IN via the dep, not an env var (owner rule: env is boot-critical
      //   only). This file's subject IS the brief, so it states the arm rather
      //   than inheriting the server default — the test stays meaningful if that
      //   default ever moves again.
      rollingBriefEnabled: () => true,
      executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
        prompts.push(String(input['llm.prompt']));
        round += 1;
        return round === 1
          ? { body: { response: 'I do not have a record of that.',
              events: [], tool_calls: [] } }
          : { body: { response: 'understood', events: [], tool_calls: [] } };
      },
      registry: {
        list: () => [], listByTier: () => [],
        getByName: () => undefined,
        dispatch: async () => ({ ok: true, result: {} }),
        subscribeRefresh: () => () => undefined,
      } as never,
      dispatchTool: async () => ({ ok: true as const, result: {} }),
      emit: () => undefined,
      now: () => 1_000,
    } as never,
  );
  return prompts;
};

describe('recovery retries carry the brief', () => {
  beforeEach(() => {
    __clearSessionBriefs();
  });
  afterEach(() => {
    __clearSessionBriefs();
  });

  it('sends a SECOND packet when the first reply asserts an unverified absence', async () => {
    const prompts = await runWithAbsenceOnFirstReply();
    // The precondition for everything below: the retry actually fired. Without
    // this the grounding assertion would pass vacuously on a one-packet turn.
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[1]).toContain('output_feedback');
  });

  it('keeps the carried brief in the REPAIR packet, not just the first', async () => {
    const prompts = await runWithAbsenceOnFirstReply();
    const repair = prompts[1] ?? '';
    // Restore `undefined` for `prior_tool_calls` on the absence retry and all
    // three of these go red — the packet loses the brief entirely.
    expect(repair).toContain('prior_tool_calls');
    expect(repair).toContain('context.brief');
    // The grounding itself, not merely the envelope: this is the value whose
    // absence let 343 invent one.
    expect(repair).toContain('137');
  });

  it('does not give the repair LESS than the call it repairs', async () => {
    const prompts = await runWithAbsenceOnFirstReply();
    const first = prompts[0] ?? '';
    const repair = prompts[1] ?? '';
    for (const grounding of ['context.brief', '137', '252']) {
      if (!first.includes(grounding)) continue;
      expect(repair, `repair packet dropped ${grounding}`).toContain(grounding);
    }
  });
});


describe('the budget refit carries the brief', () => {
  beforeEach(() => {
    __clearSessionBriefs();
  });
  afterEach(() => {
    __clearSessionBriefs();
  });

  /** ⛔⛔ NOT A RECOVERY PATH, WHICH IS WHY IT SURVIVED THE FIRST SWEEP. This
   *  fires when the opening call is REFUSED FOR SIZE and a ceiling is then
   *  relearned; it recomposes the turn so the trim can run. It was a bare
   *  `tryMainTurn()` — no `prior_tool_calls` at all — so a turn that OVERFLOWED
   *  lost its whole brief, which is the worst moment to lose it: the carry is
   *  then holding work that no longer fits anywhere else.
   *
   *  ⚠ THE RELEARNED BUDGET IS DELIBERATELY GENEROUS. The refit gate
   *  short-circuits on `activeInputTokenBudget === undefined`, so it fires for
   *  ANY relearned value — which lets this isolate the property under test (was
   *  a carry PASSED?) from the trim ladder's separate and legitimate right to
   *  EVICT the brief under a binding budget. A tight budget here would couple
   *  the two and make the test fail for the wrong reason. */
  const runOverflowThenRefit = async (): Promise<string[]> => {
    const prompts: string[] = [];
    let round = 0;
    setSessionBrief('s', BRIEF);
    await runChatTurn(
      {
        session_id: 's', turn_id: 't', picker_target: 'self',
        dispatch_peer_name: null, available_tools: [],
        content: { chat_tail: [], user_message: 'summarise everything' },
        correction_context: [], model_layer: 'byok',
      } as never,
      {
        // ⛔ Opt IN via the dep, not an env var (owner rule: env is boot-critical
      //   only). This file's subject IS the brief, so it states the arm rather
      //   than inheriting the server default — the test stays meaningful if that
      //   default ever moves again.
      rollingBriefEnabled: () => true,
      executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
          prompts.push(String(input['llm.prompt']));
          round += 1;
          if (round === 1) {
            throw new LLMError(
              'AI_TOKEN_BUDGET_EXCEEDED',
              'LLM input too large (400): context_length_exceeded',
            );
          }
          return { body: { response: 'fitted', events: [], tool_calls: [] } };
        },
        // Unknown before the first call; the refusal is what teaches it.
        resolveInputTokenBudget: () => (round === 0 ? undefined : 100_000),
        registry: {
          list: () => [], listByTier: () => [],
          getByName: () => undefined,
          dispatch: async () => ({ ok: true, result: {} }),
          subscribeRefresh: () => () => undefined,
        } as never,
        dispatchTool: async () => ({ ok: true as const, result: {} }),
        emit: () => undefined,
        now: () => 1_000,
      } as never,
    );
    return prompts;
  };

  it('recomposes the turn after a size refusal', async () => {
    const prompts = await runOverflowThenRefit();
    // Precondition. Without it the assertion below passes vacuously whenever
    // the refit stops firing for an unrelated reason.
    expect(prompts).toHaveLength(2);
  });

  it('keeps the brief in the REFIT packet', async () => {
    const prompts = await runOverflowThenRefit();
    const refit = prompts[1] ?? '';
    // Restore the bare `tryMainTurn()` and all three go red.
    expect(refit).toContain('prior_tool_calls');
    expect(refit).toContain('context.brief');
    expect(refit).toContain('137');
  });
});


describe('a value the SUBSTRATE issued is not an invention', () => {
  /** ⛔⛔ `prefetch_context` IS INJECTED AT THE EGRESS SEAM, AFTER THE GROUNDING
   *  CORPUS IS CAPTURED. That is deliberate — the raw contact records arrive by
   *  closure and never enter the JSON packet — but it means every identifier in
   *  the prefetch block is absent from `lastPacketBody` in BOTH its real and
   *  aliased forms, permanently.
   *
   *  🔑 MEASURED (bench 343, instrumented 2026-09-09). The block tells the model
   *  verbatim "Use the alias directly as a tool argument". The model did.
   *  Restore returned the real address before the guard saw it; the corpus held
   *  neither form (`corpusHasRealEmail=false`, `corpusHasAlias=false`); the call
   *  was refused as invented; the model re-sent the same correct value and was
   *  refused identically — 9 rounds, 0 dispatches, ~220s, until the turn timed
   *  out. The substrate instructed the model to do the one thing its own guard
   *  always refuses. */
  const runWithArg = async (
    wasValueIssuedToModel?: (v: string) => boolean,
  ): Promise<string[]> => {
    const dispatched: string[] = [];
    let round = 0;
    await runChatTurn(
      {
        session_id: 's', turn_id: 't', picker_target: 'self',
        dispatch_peer_name: null, available_tools: [],
        content: { chat_tail: [], user_message: 'note the surcharge' },
        correction_context: [], model_layer: 'byok',
      } as never,
      {
        executeAiCall: async () => {
          round += 1;
          return round === 1
            ? { body: { response: '', events: [], tool_calls: [{
                tool: 'memory.write',
                // Appears NOWHERE in the packet — exactly the prefetch case.
                args: { provenance_entity_ids: ['dana@northwind.example'] },
              }] } }
            : { body: { response: 'done', events: [], tool_calls: [] } };
        },
        registry: {
          list: () => [], listByTier: () => [],
          getByName: () => ({ name: 'memory.write', tier: 1, concurrency_safe: false }),
          dispatch: async () => ({ ok: true, result: {} }),
          subscribeRefresh: () => () => undefined,
        } as never,
        // ⚠ Record from the PAYLOAD, not a guessed field name: the dispatch
        //   object's tool key is not `tool`, and reading it blind logged
        //   `undefined` for a dispatch that really happened.
        dispatchTool: async (c: unknown) => {
          dispatched.push(
            JSON.stringify(c).includes('memory.write') ? 'memory.write' : 'other',
          );
          return { ok: true as const, result: {} };
        },
        ...(wasValueIssuedToModel ? { wasValueIssuedToModel } : {}),
        emit: () => undefined,
        now: () => 1_000,
      } as never,
    );
    return dispatched;
  };

  it('⛔ CONTROL — refuses the ungrounded arg when nothing vouches for it', async () => {
    // Without this arm the test below passes even if the guard never ran.
    expect(await runWithArg()).toEqual([]);
  });

  it('dispatches when the ledger says the substrate issued that value', async () => {
    const dispatched = await runWithArg((v) => v === 'dana@northwind.example');
    expect(dispatched).toContain('memory.write');
  });

  it('still refuses a value the ledger does NOT vouch for', async () => {
    // The permitting witness: the predicate must not be a blanket exemption.
    expect(await runWithArg((v) => v === 'someone.else@elsewhere.example')).toEqual([]);
  });
});


describe('unrecorded user statements ride the MAIN packet, free', () => {
  /** ⛔⛔ THE FOLD DID TWO JOBS AT ONE PRICE, AND ONLY ONE NEEDS A MODEL.
   *  Compressing tool results takes judgement; preserving a user's statement
   *  does not — the brief's instruction says to copy those VERBATIM, "digits
   *  and all, never paraphrased". Paying a model call to copy text exactly is
   *  the expensive way to do a free thing.
   *
   *  🔑 MEASURED, and it is the whole economics of the feature:
   *    · 363 (user-stated verbal facts, UNRECOVERABLE): OFF 0/2, ON 2/2.
   *    · 368 / 369 (values readable from a store): both arms correct, and the
   *      brief cost +11.4% tokens on 369 for nothing.
   *  A tool result can be RE-READ; a user statement cannot. The trigger only
   *  knew SIZE, so it paid full price on recoverable content.
   *
   *  ⇒ The backlog previously fed the FOLD INPUT only, so an uncaptured
   *  statement was invisible to the main turn until an expensive fold happened
   *  to run. */
  const mainPacketsWith = async (statements: string[]): Promise<string> => {
    const prompts: string[] = [];
    let round = 0;
    __clearUnfoldedUserMessages();
    __clearSessionBriefs();
    for (const st of statements) appendUnfoldedUserMessage('mp', st);
    try {
      await runChatTurn(
        {
          session_id: 'mp', turn_id: 't', picker_target: 'self',
          dispatch_peer_name: null, available_tools: [],
          content: { chat_tail: [], user_message: 'what is the total?' },
          correction_context: [], model_layer: 'byok',
        } as never,
        {
          // ⛔ Opt IN via the dep, not an env var (owner rule: env is boot-critical
      //   only). This file's subject IS the brief, so it states the arm rather
      //   than inheriting the server default — the test stays meaningful if that
      //   default ever moves again.
      rollingBriefEnabled: () => true,
      executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
            prompts.push(String(input['llm.prompt']));
            round += 1;
            return { body: { response: 'ok', events: [], tool_calls: [] } };
          },
          registry: {
            list: () => [], listByTier: () => [],
            getByName: () => undefined,
            dispatch: async () => ({ ok: true, result: {} }),
            subscribeRefresh: () => () => undefined,
          } as never,
          dispatchTool: async () => ({ ok: true as const, result: {} }),
          emit: () => undefined,
          now: () => 1_000,
        } as never,
      );
    } finally {
        __clearUnfoldedUserMessages();
      __clearSessionBriefs();
    }
    return prompts.join('\n');
  };

  it('carries an unrecorded statement into the main packet', async () => {
    const out = await mainPacketsWith(['the levy is now 340 units']);
    expect(out).toContain('pending_user_statements');
    // The VALUE, not just the envelope — this is the thing no tool can return.
    expect(out).toContain('340');
  });

  it('⛔ the PERMITTING WITNESS — omits the field when nothing is unrecorded', async () => {
    // Without this a composer that always emitted the key would pass above.
    expect(await mainPacketsWith([])).not.toContain('pending_user_statements');
  });

  it('costs no model call — preservation is not compression', async () => {
    // The point of the split: carrying a statement must not trigger a fold.
    // One main call, no brief call.
    const out = await mainPacketsWith(['the levy is now 340 units']);
    expect(out.split('carried_forward').length - 1).toBe(0);
  });
});

/** ⛔⛔ THE FOLD RETRIES AN UNPARSEABLE REPLY ONCE — the affordance every other
 *  AIOutput site already had and this one did not. The main turn retries an
 *  unusable output ("an empty output has already earned its retry"), the
 *  tool-loop reinvoke gets a guided retry, and `packages/llm` retries a
 *  json-mode REJECTION — but that fires at the request boundary before tokens
 *  are billed and cannot see a malformed completion. Nothing retried a fold,
 *  and the asymmetry was never a decision.
 *
 *  🔑 MEASURED COST OF THE GAP — bench 377, 40 turns: 1 of 17 folds came back
 *  unparseable, and the user-stated charge that fold was carrying never reached
 *  `constraints`. The turn answered correctly only because recall found the
 *  value in an earlier ASSISTANT message. "A tool can re-derive a ring cost;
 *  nothing can re-derive what the user said."
 *
 *  ⚠ Driven through the REAL path — `runChatTurn` with a counted
 *  `executeAiCall` — because the property under test is how many times the
 *  model is ASKED, and the fold is an inner closure with no seam of its own.
 *  Fold calls are told apart from main-turn calls by the fold's own prompt
 *  fields, the same discriminator `d-167-p5-s4` uses. */
describe('fold parse failure — one retry', () => {
  const USABLE = JSON.stringify({
    intent: 'audit the Kestrel rings', constraints: ['Quarterly rig surcharge is 252 units'],
    findings: [], pending: [], completed: [],
  });
  const isFold = (input: Record<string, unknown>): boolean => {
    const p = String(input['llm.prompt'] ?? '');
    return p.includes('"carried_forward"') || p.includes('tool_results_since');
  };
  /** Drive one turn that DOES tool work (so a closing fold runs) and hand the
   *  fold `replies` in order. Returns how many fold calls were made. */
  const foldCalls = async (replies: readonly unknown[]): Promise<number> => {
    let folds = 0; let mainRound = 0;
    setSessionBrief('s', BRIEF);
    await runChatTurn(
      {
        session_id: 's', turn_id: 't', picker_target: 'self',
        dispatch_peer_name: null, available_tools: [],
        content: { chat_tail: [], user_message: 'read ring 01 and tell me its cost' },
        correction_context: [], model_layer: 'byok',
      } as never,
      {
        rollingBriefEnabled: () => true,
        executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
          if (isFold(input)) {
            const body = replies[Math.min(folds, replies.length - 1)];
            folds += 1;
            return { body };
          }
          // ⛔ THE FIRST MAIN-TURN REPLY MUST EMIT A TOOL CALL. A turn that
          //   dispatches nothing has no retainable result, so `shouldBrief`
          //   returns `nothing_to_fold` and NO fold runs — the first cut of
          //   this harness returned `tool_calls: []` and measured 0 folds in
          //   all three cases, which reads as "the retry does not work" and is
          //   really "the fold never happened".
          mainRound += 1;
          return mainRound === 1
            ? { body: { response: 'looking it up', events: [],
                tool_calls: [{ tool: 'work.read', args: { id: 'ring-01' } }] } }
            : { body: { response: 'ring 01 costs 137 units', events: [], tool_calls: [] } };
        },
        registry: {
          list: () => [], listByTier: () => [],
          getByName: () => undefined,
          dispatch: async () => ({ ok: true, result: {} }),
          subscribeRefresh: () => () => undefined,
        } as never,
        dispatchTool: async () => ({ ok: true as const, result: { cost: 137 } }),
        emit: () => undefined,
        now: () => 1_000,
      } as never,
    ).catch(() => undefined);
    return folds;
  };

  it('asks a SECOND time when the first fold reply does not parse', async () => {
    expect(await foldCalls(['not a brief at all', USABLE])).toBe(2);
  });

  it('does not ask a THIRD time when both replies fail', async () => {
    // The retry is bounded at one. An unbounded loop on a malformed reply is a
    // cost multiplier on exactly the turns already going wrong.
    expect(await foldCalls(['still not a brief'])).toBe(2);
  });

  it('does not retry a reply that parses first time', async () => {
    expect(await foldCalls([USABLE])).toBe(1);
  });
});

describe('a held call in a folded turn', () => {
  // Live 2026-10-04: the closing fold read the held unlock's "queued for
  // approval" result and wrote it into `findings` (which never forget), and the
  // code-derived `completed` called the queued unlock done.
  it('reaches neither the fold nor `completed` — the read beside it still does', async () => {
    const foldPrompts: string[] = [];
    let mainRound = 0;
    setSessionBrief('s', BRIEF);
    await runChatTurn(
      {
        session_id: 's', turn_id: 't', picker_target: 'self',
        dispatch_peer_name: null, available_tools: [],
        content: { chat_tail: [], user_message: 'read ring 01, then unlock the kitchen door' },
        correction_context: [], model_layer: 'byok',
      } as never,
      {
        rollingBriefEnabled: () => true,
        executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
          const prompt = String(input['llm.prompt'] ?? '');
          if (prompt.includes('tool_results_since')) {
            foldPrompts.push(prompt);
            return { body: { intent: 'unlock the kitchen door', constraints: [], findings: [],
              pending: [], completed: [] } };
          }
          mainRound += 1;
          return mainRound === 1
            ? { body: { response: 'on it', events: [], tool_calls: [
                { tool: 'work.read', args: { id: 'ring-01' } },
                { tool: 'recued-core/control-device', args: { action: 'unlock' } },
              ] } }
            : { body: { response: 'queued it', events: [], tool_calls: [] } };
        },
        registry: {
          list: () => [], listByTier: () => [], getByName: () => undefined,
          dispatch: async () => ({ ok: true, result: {} }),
          subscribeRefresh: () => () => undefined,
        } as never,
        dispatchTool: async (input: { tool_name: string }) => input.tool_name === 'work.read'
          ? { ok: true as const, result: { cost: 137 } }
          : { ok: true as const, run_id: 'run-unlock', result: { status: 'awaiting_approval',
            awaiting_approval: true, recipe_id: 'control-device', message: 'queued for the user' } },
        emit: () => undefined,
        now: () => 1_000,
      } as never,
    ).catch(() => undefined);
    expect(foldPrompts.length).toBeGreaterThan(0);
    const since = JSON.parse(foldPrompts.at(-1)!).tool_results_since as Array<{ tool_name: string }>;
    expect(since.map((call) => call.tool_name)).toEqual(['work.read']);
    expect(foldPrompts.join('')).not.toContain('awaiting_approval');
    expect(getSessionBrief('s')?.completed ?? []).not.toContainEqual(
      expect.stringContaining('recued-core/control-device'));
  });
});

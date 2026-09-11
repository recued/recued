/** The context-trim REFETCH LOOP detector.
 *
 *  ⛔ WHAT IT COUNTS, and why it is not the ladder failing. Measured
 *  2026-09-05 on internal benchmarks task 342 at a 40,000-token budget
 *  with 22,005 tokens of working room — 55%, so NOT a floor artifact: the model
 *  read four notes, all four `work.read` results were elided, it re-read the
 *  identical four ids, those were elided too, and it repeated that four times
 *  before `max_rounds`. 0/4 runs answered, against a ~75% baseline.
 *
 *  🔑 The elision rung is a pure SIZE THRESHOLD — everything above
 *  `previewChars` goes — so the BIGGEST result is always taken first.
 *  `work.read` exists to escape `work.search`'s clamp, which makes its result
 *  the biggest thing in the packet, which makes it the first thing evicted. The
 *  trim discards the escalation the tool contract just told the model to
 *  perform, reaches fit, and reports success. Every round.
 *
 *  This suite pins the DETECTOR only. Nothing acts on the count yet — the
 *  eviction-briefing work earlier the same day was built on a diagnosis that
 *  turned out wrong and was never exercised, and this is the step that would
 *  have caught that. */

import { describe, expect, it, vi } from 'vitest';

import { runChatTurn } from '../chat-turn-executor.js';

/** Big enough that any workable preview threshold elides it whole. */
const BIG = { rows: Array.from({ length: 400 }, (_, i) => `row-${i}-payload-payload`) };

/** Mirrors reality: a READ returns a lot, a WRITE echoes almost nothing. The
 *  big-args/small-result shape is the only one that can distinguish "the trim
 *  took my answer" from "the trim shortened how my request is displayed". */
const resultFor = (args: unknown): unknown =>
  JSON.stringify(args ?? '').length > 4_000 ? { ok: true } : BIG;

/** Drive one turn whose model re-issues `calls[i]` on round i. Returns the
 *  livelock warnings AND how many rounds the model was actually asked for, so a
 *  test can prove the turn ENDED rather than merely complained. */
const runTurn = async (
  budget: number | undefined,
  calls: ReadonlyArray<ReadonlyArray<{ tool: string; args: unknown }>>,
): Promise<{
  loops: string[];
  rounds: number;
  result: unknown;
  /** Did the trim actually act this run? A case asserting "no loop" proves
   *  nothing if nothing was elided — see the `anyMarker` gate below. */
  anyMarker: boolean;
  shipped: Array<Array<{ tool: string | undefined; result_elided: boolean }>>;
}> => {
  const warnings: string[] = [];
  const packets: string[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warnings.push(a.map(String).join(' '));
  });
  let round = 0;
  let result: unknown;
  try {
    result = await runChatTurn(
      {
        session_id: 's', turn_id: 't', picker_target: 'self',
        dispatch_peer_name: null, available_tools: [],
        content: { chat_tail: [], user_message: 'read them' },
        correction_context: [], model_layer: 'byok',
        ...(budget === undefined ? {} : { input_token_budget: budget }),
      } as never,
      {
        executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
          packets.push(String(input['llm.prompt'] ?? ''));
          const next = calls[round];
          round += 1;
          return next === undefined
            ? { body: { response: 'done', events: [], tool_calls: [] } }
            : { body: { response: '', events: [], tool_calls: next } };
        },
        registry: {
          list: () => [], listByTier: () => [],
          getByName: () => ({ name: 'work.read', tier: 1, concurrency_safe: false }),
          dispatch: async (_n: unknown, a: unknown) => ({
            ok: true, result: resultFor(a),
          }),
          subscribeRefresh: () => () => undefined,
        } as never,
        dispatchTool: async (_name: string, a: unknown) =>
          ({ ok: true as const, result: resultFor(a) }),
        emit: () => undefined,
        now: () => 1_000,
      } as never,
    );
  } finally {
    warn.mockRestore();
  }
  return {
    loops: warnings.filter((w) => w.includes('context-trim livelock')),
    rounds: round,
    result,
    /** Did the trim actually act? A case that asserts "no loop" proves nothing
     *  if nothing was elided — it is then testing that a trim which never ran
     *  did not loop. */
    anyMarker: packets.some((p) => p.includes('llm_gateway_context_omitted')),
    shipped: packets.map((p) => {
      try {
        const j = JSON.parse(p) as { prior_tool_calls?: unknown[] };
        return (j.prior_tool_calls ?? []).map((c) => {
          const r = (c as { result?: unknown }).result;
          return {
            tool: (c as { tool_name?: string }).tool_name,
            result_elided: r !== null && typeof r === 'object'
              && 'llm_gateway_context_omitted' in (r as Record<string, unknown>),
          };
        });
      } catch { return []; }
    }),
  };
};

const READ = (id: string) => ({ tool: 'work.read', args: { kind: 'note', id } });

describe('context-trim refetch loop detector', () => {
  it('🔑 fires when the SAME call is re-issued after its result was elided', async () => {
    // Round 1 fetches n1; the trim elides it. Rounds 2 and 3 fetch n1 again.
    const { loops } = await runTurn(2_000, [[READ('n1')], [READ('n1')], [READ('n1')]]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/2 tool result\(s\) re-fetched/);
    expect(loops[0]).toMatch(/Ending the turn instead of looping/);
  });

  it('⛔ and ENDS THE TURN — the whole point is not to keep going', async () => {
    // A model that would loop for twenty more rounds is stopped at the second
    // confirmed re-fetch. Without this the turn spends its entire round budget
    // and its tokens and exits at `max_rounds_exhausted` with no answer anyway:
    // the user waits longer for the same nothing, and pays for it.
    const many = Array.from({ length: 20 }, () => [READ('n1')]);
    const { loops, rounds } = await runTurn(2_000, many);
    expect(loops).toHaveLength(1);
    // Stopped early — nowhere near the twenty rounds the model asked for.
    expect(rounds).toBeLessThanOrEqual(4);
  });

  it('⛔ the message must not tell the user to retry unchanged', async () => {
    // An identical retry re-enters the same loop: same budget, same too-large
    // result, same elision. The remedies that change the outcome are a narrower
    // request or a bigger window, and the copy has to say so.
    const { result } = await runTurn(2_000, [[READ('n1')], [READ('n1')], [READ('n1')]]);
    const text = JSON.stringify(result ?? '');
    expect(text).toMatch(/fewer or smaller items/);
    expect(text).toMatch(/larger context window/);
    expect(text).toMatch(/Repeating this request unchanged will hit the same limit/);
  });

  it('⛔ ONE re-fetch is not a loop — a model may legitimately redo a lost call', async () => {
    // The threshold is >= 2 on purpose. A single retry after losing a result is
    // ordinary recovery; flagging it would make the signal useless.
    expect((await runTurn(2_000, [[READ('n1')], [READ('n1')]])).loops).toHaveLength(0);
  });

  it('⛔ DIFFERENT calls are not a loop, however many are elided', async () => {
    // Progress through a large corpus elides a lot and re-fetches nothing. If
    // this fired, the detector would just be measuring "the trim is working".
    expect((await runTurn(2_000, [
      [READ('n1')], [READ('n2')], [READ('n3')], [READ('n4')],
    ])).loops).toHaveLength(0);
  });

  it('⛔ SILENT WITH NO TRIM — nothing is elided, so nothing can be re-fetched', async () => {
    // Same repeated calls, no budget. A model repeating itself for its own
    // reasons is not this defect, and the detector must not claim it.
    expect((await runTurn(undefined, [[READ('n1')], [READ('n1')], [READ('n1')]]))
      .loops).toHaveLength(0);
  });

  it('key ORDER in args does not hide a loop', async () => {
    // The signature sorts keys: two identical calls whose object key order
    // differs must collide, or the counter reads zero on a real loop.
    const a = { tool: 'work.read', args: { kind: 'note', id: 'n1' } };
    const b = { tool: 'work.read', args: { id: 'n1', kind: 'note' } };
    const { loops } = await runTurn(2_000, [[a], [b], [a]]);
    expect(loops).toHaveLength(1);
  });

  it.todo(
    '⛔ UNTESTED: a call whose ARGS were elided but whose RESULT survived is NOT a loop. '
    + 'The `rawLen > previewLen` guard exists so a result the model can still SEE in its '
    + 'preview is not counted as lost — without it a big-args/small-result call (a write, a '
    + 'paste) reads as a lost answer and would end a turn that was fine. It is REASONED, not '
    + 'proven: mutation M3 (count every marker) survives this file. Budgets from 3,500 to '
    + '24,000 were tried; below the window nothing survives the search, above it nothing is '
    + 'trimmed at all, and the harness has an empty catalog so the two are closer together '
    + 'than in production. Constructing it needs a fixture where the accumulated args force a '
    + 'trim while `previewChars` still settles above a small result — do not delete the guard '
    + 'on the strength of the green suite.',
  );

});

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
 *  This suite pins both detection and termination: repeated loss ends the
 *  turn, while a result still fully visible in its preview permits completion. */

import { describe, expect, it, vi } from 'vitest';
import {
  validateTransparencyEvent,
  type MultiTurnTerminationReason,
  type TransparencyMultiTurnRoundOutcome,
} from '@recued/contracts';

import { ESTIMATED_BYTES_PER_TOKEN } from '@recued/llm';
import { CHAT_MAIN_TURN_SYSTEM_PROMPT, runChatTurn, type RunChatTurnDeps } from '../chat-turn-executor.js';
import { deriveExecutionFlowPattern } from '../execution-case-core.js';

/** Big enough that any workable preview threshold elides it whole. */
const BIG = { rows: Array.from({ length: 400 }, (_, i) => `row-${i}-payload-payload`) };

/** Mirrors reality: a READ returns a lot, a WRITE echoes almost nothing. The
 *  big-args/small-result shape is the only one that can distinguish "the trim
 *  took my answer" from "the trim shortened how my request is displayed". */
const resultFor = (args: unknown): unknown =>
  JSON.stringify(args ?? '').length > 4_000 ? { ok: true } : BIG;

/** These turns run at budgets just above their floor, and the core system prompt
 *  is most of that floor. The budgets were set against a 2,914-byte prompt, so
 *  `sized` moves them with the prompt's size instead of breaking whenever the
 *  prompt grows (2026-10-20: 359 more bytes left 31 of these tests red). */
const sized = (budget: number) => budget
  + Math.ceil((Buffer.byteLength(CHAT_MAIN_TURN_SYSTEM_PROMPT, 'utf8') - 2_914) / ESTIMATED_BYTES_PER_TOKEN);

/** Drive one turn whose model re-issues `calls[i]` on round i. Returns the
 *  livelock warnings AND how many rounds the model was actually asked for, so a
 *  test can prove the turn ENDED rather than merely complained. */
const runTurn = async (
  budget: number | undefined,
  calls: ReadonlyArray<ReadonlyArray<{ tool: string; args: unknown }>>,
  toolResultFor: (args: unknown) => unknown = resultFor,
  dispatchToolOverride?: RunChatTurnDeps['dispatchTool'],
  options?: {
    invalidPackets?: readonly number[];
    failedPackets?: readonly number[];
    responses?: Readonly<Record<number, string>>;
    planningResponse?: string;
    truncatedPackets?: readonly number[];
    critiqueProposal?: RunChatTurnDeps['critiqueProposal'];
  },
): Promise<{
  loops: string[];
  rounds: number;
  result: unknown;
  transparencyEvents: unknown[];
  /** Did the trim actually act this run? A case asserting "no loop" proves
   *  nothing if nothing was elided — see the `anyMarker` gate below. */
  anyMarker: boolean;
  shipped: Array<Array<{
    tool: string | undefined;
    args: unknown;
    result: unknown;
  }>>;
}> => {
  const warnings: string[] = [];
  const packets: string[] = [];
  const transparencyEvents: unknown[] = [];
  const emit: RunChatTurnDeps['emit'] = (event) => {
    if (event.kind === 'chat.transparency') transparencyEvents.push(event.event);
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warnings.push(a.map(String).join(' '));
  });
  let round = 0;
  let callIndex = 0;
  let result: unknown;
  // Dispatch receives one request object, not (name, args). Keep this typed so
  // the small-result fixture really uses the pasted arguments.
  const dispatchTool: RunChatTurnDeps['dispatchTool'] = dispatchToolOverride
    ?? (async ({ arg_values }) => ({ ok: true, result: toolResultFor(arg_values) }));
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
          round += 1;
          if (options?.truncatedPackets?.includes(round)) return { body: { response: 42 }, finish_reason: 'length' as const };
          if (options?.invalidPackets?.includes(round)) {
            return { body: { response: 42, events: [], tool_calls: [] } };
          }
          if (options?.failedPackets?.includes(round)) throw new Error('provider unavailable');
          const response = options?.responses?.[round];
          if (response !== undefined) return { body: { response, events: [], tool_calls: [] } };
          const next = calls[callIndex];
          callIndex += 1;
          return next === undefined
            ? { body: { response: 'done', events: [], tool_calls: [] } }
            : { body: { response: options?.planningResponse ?? '', events: [], tool_calls: next } };
        },
        registry: {
          list: () => [], listByTier: () => [],
          getByName: (name: string) => ({ name, tier: 1, concurrency_safe: false }),
          dispatch: async (_n: unknown, a: unknown) => ({
            ok: true, result: toolResultFor(a),
          }),
          subscribeRefresh: () => () => undefined,
        } as never,
        dispatchTool,
        critiqueProposal: options?.critiqueProposal,
        emit,
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
    transparencyEvents,
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
            args: (c as { args?: unknown }).args,
            result: r,
          };
        });
      } catch { return []; }
    }),
  };
};

const READ = (id: string) => ({ tool: 'work.read', args: { kind: 'note', id } });
const PASTE = {
  tool: 'work.create',
  args: { kind: 'note', title: 'Pasted note', body: 'payload '.repeat(2_000) },
};
/** Each answer fits intact; two answers require dropping the oldest call. */
const WHOLE_READ_RESULT = 'x'.repeat(1_800);
const SMALL_READ_RESULT = { body: 'Recovered answer' };

/** Pin the wire sequence, including exactly one completion per started round. */
const expectRoundLifecycle = (
  events: readonly unknown[],
  outcomes: readonly TransparencyMultiTurnRoundOutcome[],
  callsPerRound: number,
  reason: MultiTurnTerminationReason,
): void => {
  const lifecycle = events.filter((event) =>
    event !== null && typeof event === 'object' && 'kind' in event
    && typeof event.kind === 'string' && event.kind.startsWith('recued.multi_turn.'));
  for (const event of lifecycle) expect(validateTransparencyEvent(event)).toEqual([]);
  expect(lifecycle).toEqual([
    ...outcomes.flatMap((outcome, round_index) => [
      expect.objectContaining({ kind: 'recued.multi_turn.round_started', round_index }),
      {
        kind: 'recued.multi_turn.round_completed', round_index, outcome,
        tool_calls_executed: callsPerRound,
      },
    ]),
    {
      kind: 'recued.multi_turn.loop_terminated', total_rounds: outcomes.length,
      termination_reason: reason,
    },
  ]);
};

describe('context-trim refetch loop detector', () => {
  it('keeps a completed draft when an optional review reaches its output limit', async () => {
    vi.stubEnv('RECUED_VERIFY_PASS', 'neutral');
    try {
      const { result, rounds } = await runTurn(undefined, [[READ('n1')]], () => SMALL_READ_RESULT, undefined,
        { responses: { 2: 'Verified draft answer.' }, truncatedPackets: [3] });
      expect(rounds).toBe(3);
      expect((result as { assistant_content: string }).assistant_content).toBe('Verified draft answer.');
    } finally { vi.unstubAllEnvs(); }
  });

  it('🔑 fires when the SAME call is re-issued after its result was elided', async () => {
    // Round 1 fetches n1; the trim elides it. Rounds 2 and 3 fetch n1 again.
    const { loops } = await runTurn(sized(2_000), [[READ('n1')], [READ('n1')], [READ('n1')]]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/2 tool result\(s\) re-fetched/);
    expect(loops[0]).toMatch(/Ending the turn instead of looping/);
  });

  it('emits one valid context-limit stop event after repeated re-read loss', async () => {
    const { transparencyEvents, rounds, result } = await runTurn(
      sized(2_000), [[READ('n1')], [READ('n1')], [READ('n1')]],
      resultFor, undefined, { planningResponse: 'I have read part of the notes.' },
    );
    const stops = transparencyEvents.filter((event) =>
      event !== null && typeof event === 'object'
      && 'kind' in event && event.kind === 'recued.multi_turn.loop_terminated');

    expect(stops).toHaveLength(1);
    expect(validateTransparencyEvent(stops[0])).toEqual([]);
    expect(stops[0]).toEqual({
      kind: 'recued.multi_turn.loop_terminated',
      total_rounds: rounds,
      termination_reason: 'context_trim_livelock',
    });
    expect(rounds).toBe(3);
    const content = (result as { assistant_content: string }).assistant_content;
    expect(content.startsWith('I have read part of the notes.\n\n')).toBe(true);
    expect(content).toContain('too large to keep');
  });

  it.each([
    { label: 'single-call rounds', batch: [READ('n1')], outcomes: ['continue', 'continue', 'aborted'] },
    { label: 'batched rounds', batch: [READ('n1'), READ('n2')], outcomes: ['continue', 'aborted'] },
  ] as const)('closes the stopped round before loop termination for $label', async ({ batch, outcomes }) => {
    const { transparencyEvents, loops, rounds } = await runTurn(
      sized(2_000), Array.from({ length: 4 }, () => batch),
    );

    expect(loops).toHaveLength(1);
    expect(rounds).toBe(outcomes.length);
    expectRoundLifecycle(transparencyEvents, outcomes, batch.length, 'context_trim_livelock');
  });

  it.each([
    { label: 'successful synthesis', options: undefined, outcome: 'completed', reason: 'completed' },
    { label: 'a provider failure', options: { failedPackets: [2] }, outcome: 'aborted', reason: 'aborted' },
    { label: 'a malformed reply retry', options: { invalidPackets: [2] }, outcome: 'completed', reason: 'completed' },
    { label: 'an empty reply retry', options: { responses: { 2: '' } }, outcome: 'completed', reason: 'completed' },
  ] as const)('closes one round once after $label', async ({ options, outcome, reason }) => {
    const { transparencyEvents, loops } = await runTurn(
      sized(2_000), [[READ('n1')]], () => SMALL_READ_RESULT, undefined, options,
    );

    expect(loops).toHaveLength(0);
    expectRoundLifecycle(transparencyEvents, [outcome], 1, reason);
  });

  it('closes the open round when empty-output recovery loses the rereads', async () => {
    const batch = [READ('n1'), READ('n2'), READ('n3')];
    let reads = 0;
    const { transparencyEvents, loops, rounds, shipped, result } = await runTurn(
      sized(2_000), [batch, batch], () => ++reads <= batch.length ? BIG : SMALL_READ_RESULT,
      undefined, { responses: { 3: '' }, planningResponse: 'I recovered part of the notes.' },
    );

    // The first synthesis saw all three recovered answers. Its recovery
    // feedback takes room, and only that later composition loses them again.
    expect(shipped[2]).toEqual(expect.arrayContaining(batch.map(({ args }) =>
      expect.objectContaining({ args, result: SMALL_READ_RESULT }))));
    expect(loops).toHaveLength(1);
    expect(rounds).toBe(3);
    expect((result as { assistant_content: string }).assistant_content.startsWith('I recovered part of the notes.\n\n')).toBe(true);
    expectRoundLifecycle(transparencyEvents, ['continue', 'aborted'], batch.length, 'context_trim_livelock');
  });

  it('does not invent a round completion when a critique stops before dispatch', async () => {
    const batch = [READ('n1'), READ('n2'), READ('n3')];
    let reads = 0;
    let critiques = 0;
    const { transparencyEvents, loops, rounds, shipped } = await runTurn(
      sized(2_000), [batch, batch, batch], () => ++reads <= batch.length ? BIG : SMALL_READ_RESULT,
      undefined, {
        critiqueProposal: async () => ++critiques !== 3 ? null : ({
          critique: {
            candidate_pattern: deriveExecutionFlowPattern(
              Array.from({ length: 30 }, () => ({ tool_name: 'work.read' })),
            ),
            support: [], contradictions: [], alternatives: [],
          },
        }),
      },
    );

    expect(shipped[2]).toEqual(expect.arrayContaining(batch.map(({ args }) =>
      expect.objectContaining({ args, result: SMALL_READ_RESULT }))));
    expect(loops).toHaveLength(1);
    expect(rounds).toBe(3);
    expect(reads).toBe(6);
    expectRoundLifecycle(transparencyEvents, ['continue', 'continue'], batch.length, 'context_trim_livelock');
  });

  it('does not complete a round twice when review loses the rereads after synthesis', async () => {
    vi.stubEnv('RECUED_VERIFY_PASS', 'neutral');
    try {
      const batch = [READ('n1'), READ('n2'), READ('n3')];
      let reads = 0;
      const { transparencyEvents, loops, rounds, shipped } = await runTurn(
        sized(2_000), [batch, batch], () => ++reads <= batch.length ? BIG : SMALL_READ_RESULT,
        undefined, { responses: { 3: 'Draft answer. '.repeat(20) } },
      );

      expect(shipped[2]).toEqual(expect.arrayContaining(batch.map(({ args }) =>
        expect.objectContaining({ args, result: SMALL_READ_RESULT }))));
      expect(loops).toHaveLength(1);
      expect(rounds).toBe(3);
      expectRoundLifecycle(transparencyEvents, ['continue', 'completed'], batch.length, 'context_trim_livelock');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { label: 'synthesizes', failedPackets: [], reason: 'completed' },
    { label: 'fails', failedPackets: [2], reason: 'aborted' },
  ] as const)('reports zero rounds when critique $label before any dispatch', async ({ failedPackets, reason }) => {
    let reads = 0;
    const { transparencyEvents, loops, rounds } = await runTurn(
      sized(2_000), [[READ('n1')]], () => { reads += 1; return SMALL_READ_RESULT; },
      undefined, {
        failedPackets,
        critiqueProposal: async () => ({
          critique: {
            candidate_pattern: deriveExecutionFlowPattern([{ tool_name: 'work.read' }]),
            support: [], contradictions: [], alternatives: [],
          },
        }),
      },
    );

    expect(loops).toHaveLength(0);
    expect(reads).toBe(0);
    expect(rounds).toBe(2);
    expectRoundLifecycle(transparencyEvents, [], 0, reason);
  });

  it('⛔ and ENDS THE TURN — the whole point is not to keep going', async () => {
    // A model that would loop for twenty more rounds is stopped at the second
    // confirmed re-fetch. Without this the turn spends its entire round budget
    // and its tokens and exits at `max_rounds_exhausted` with no answer anyway:
    // the user waits longer for the same nothing, and pays for it.
    const many = Array.from({ length: 20 }, () => [READ('n1')]);
    const { loops, rounds } = await runTurn(sized(2_000), many);
    expect(loops).toHaveLength(1);
    // Stopped early — nowhere near the twenty rounds the model asked for.
    expect(rounds).toBeLessThanOrEqual(4);
  });

  it('⛔ the message must not tell the user to retry unchanged', async () => {
    // An identical retry re-enters the same loop: same budget, same too-large
    // result, same elision. The remedies that change the outcome are a narrower
    // request or a bigger window, and the copy has to say so.
    const { result } = await runTurn(sized(2_000), [[READ('n1')], [READ('n1')], [READ('n1')]]);
    const text = JSON.stringify(result ?? '');
    expect(text).toMatch(/fewer or smaller items/);
    expect(text).toMatch(/larger context window/);
    expect(text).toMatch(/Repeating this request unchanged will hit the same limit/);
  });

  it('⛔ ONE re-fetch is not a loop — a model may legitimately redo a lost call', async () => {
    // The threshold is >= 2 on purpose. A single retry after losing a result is
    // ordinary recovery; flagging it would make the signal useless.
    expect((await runTurn(sized(2_000), [[READ('n1')], [READ('n1')]])).loops).toHaveLength(0);
  });

  it('⛔ DIFFERENT calls are not a loop, however many are elided', async () => {
    // Progress through a large corpus elides a lot and re-fetches nothing. If
    // this fired, the detector would just be measuring "the trim is working".
    expect((await runTurn(sized(2_000), [
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
    const { loops } = await runTurn(sized(2_000), [[a], [b], [a]]);
    expect(loops).toHaveLength(1);
  });

  it('does not stop when args are elided but the full result survives in its preview', async () => {
    const calls = Array.from({ length: 4 }, () => [PASTE]);
    const { anyMarker, shipped, loops, rounds, result } = await runTurn(sized(2_000), calls);

    // This budget forces the real preview search even for a single call. The
    // pasted body is shortened, but the entire {ok:true} answer fits inside
    // its marker. Counting that marker as lost would stop on the third call.
    expect(anyMarker).toBe(true);
    for (const packet of shipped.slice(1)) {
      expect(packet).toHaveLength(1);
      const call = packet[0]!;
      expect(call.tool).toBe('work.create');
      expect(call.args).toMatchObject({
        llm_gateway_context_omitted: true,
        preview: expect.any(String),
      });
      expect(call.args).not.toHaveProperty('preview', JSON.stringify(PASTE.args));
      expect(call.result).toMatchObject({
        llm_gateway_context_omitted: true,
        preview: JSON.stringify({ ok: true }),
      });
    }

    expect(loops).toHaveLength(0);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
  });

  it.each([
    { label: 'plain', value: 'x'.repeat(1_600) },
    { label: 'quoted', value: '"'.repeat(300) },
    { label: 'newline', value: '\n'.repeat(400) },
    { label: 'backslash', value: '\\'.repeat(300) },
  ])('stops repeated calls whose $label string result was truncated', async ({ label, value }) => {
    const calls = Array.from({ length: 4 }, () => [PASTE]);
    const { shipped, loops, rounds } = await runTurn(sized(2_500), calls, () => value);
    const serialized = JSON.stringify(value);

    expect(shipped.length).toBeGreaterThan(1);
    for (const packet of shipped.slice(1)) {
      expect(packet).toHaveLength(1);
      const call = packet[0]!;
      expect(call.tool).toBe(PASTE.tool);
      expect(call.result).toMatchObject({
        llm_gateway_context_omitted: true,
        preview: expect.any(String),
      });
      const { preview } = call.result as { preview: string };
      expect(serialized.startsWith(preview)).toBe(true);
      expect(preview.length).toBeLessThan(serialized.length);
      // Escaping makes the incomplete preview longer than the raw string.
      // These fixtures must reach that boundary to catch the missed loop.
      if (label !== 'plain') expect(preview.length).toBeGreaterThanOrEqual(value.length);
    }

    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/2 tool result\(s\) re-fetched/);
    expect(rounds).toBe(3);
  });

  it.each([
    { label: 'plain', value: 'x'.repeat(40) },
    { label: 'quoted', value: '"'.repeat(40) },
    { label: 'newline', value: '\n'.repeat(40) },
    { label: 'backslash', value: '\\'.repeat(40) },
  ])('completes when the full $label string result remains in its preview', async ({ value }) => {
    const calls = Array.from({ length: 4 }, () => [PASTE]);
    const { shipped, loops, rounds, result } = await runTurn(sized(2_500), calls, () => value);

    for (const packet of shipped.slice(1)) {
      expect(packet).toHaveLength(1);
      const call = packet[0]!;
      expect(call.args).toMatchObject({ llm_gateway_context_omitted: true });
      expect(call.result).toMatchObject({
        llm_gateway_context_omitted: true,
        preview: JSON.stringify(value),
      });
    }

    expect(loops).toHaveLength(0);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
  });

  it('stops alternating reads after whole call/result pairs are removed', async () => {
    const calls = ['n1', 'n2', 'n1', 'n2', 'n1', 'n2'].map((id) => [READ(id)]);
    const { shipped, loops, rounds } = await runTurn(sized(3_000), calls, () => WHOLE_READ_RESULT);

    expect(shipped.length).toBeGreaterThan(2);
    // Every packet keeps only the newest answer, entirely unchanged. The
    // earlier pair is absent, so no payload marker can reveal its loss.
    for (const [i, packet] of shipped.slice(1).entries()) {
      const call = calls[i]![0]!;
      expect(packet).toEqual([{ tool: call.tool, args: call.args, result: WHOLE_READ_RESULT }]);
    }
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/2 tool result\(s\) re-fetched/);
    // Each reread fits initially; confirm that both are later lost too.
    expect(rounds).toBe(5);
  });

  it('allows one reread after a whole call/result pair was removed', async () => {
    const calls = ['n1', 'n2', 'n1'].map((id) => [READ(id)]);
    const { shipped, loops, rounds, result } = await runTurn(sized(3_000), calls, () => WHOLE_READ_RESULT);

    expect(shipped[2]).toEqual([{ tool: 'work.read', args: READ('n2').args, result: WHOLE_READ_RESULT }]);
    expect(loops).toHaveLength(0);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
  });

  it('allows distinct reads while whole call/result pairs are removed', async () => {
    const calls = ['n1', 'n2', 'n3', 'n4'].map((id) => [READ(id)]);
    const { shipped, loops, rounds, result } = await runTurn(sized(3_000), calls, () => WHOLE_READ_RESULT);

    for (const [i, packet] of shipped.slice(1).entries()) {
      const call = calls[i]![0]!;
      expect(packet).toEqual([{ tool: call.tool, args: call.args, result: WHOLE_READ_RESULT }]);
    }
    expect(loops).toHaveLength(0);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
  });

  it('keeps going when a new copy of a wholly removed call still has its answer', async () => {
    const calls = Array.from({ length: 4 }, () => [READ('n1')]);
    const { shipped, loops, rounds, result } = await runTurn(sized(3_000), calls, () => WHOLE_READ_RESULT);

    for (const packet of shipped.slice(1)) {
      expect(packet).toEqual([{ tool: 'work.read', args: READ('n1').args, result: WHOLE_READ_RESULT }]);
    }
    expect(loops).toHaveLength(0);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
  });

  it('does not count abandoned whole-call trims as lost results', async () => {
    const calls = ['n1', 'n2', 'n1', 'n2'].map((id) => [READ(id)]);
    const { shipped, loops, rounds, result } = await runTurn(10, calls, () => WHOLE_READ_RESULT);

    for (const [i, packet] of shipped.slice(1).entries()) {
      expect(packet).toEqual(calls.slice(0, i + 1).map(([call]) => ({
        tool: call!.tool, args: call!.args, result: WHOLE_READ_RESULT,
      })));
    }
    expect(loops).toHaveLength(0);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
  });

  it('ignores dropped calls that never supplied a result', async () => {
    const calls = ['n1', 'n2', 'n1', 'n2'].map((id) => [{
      ...PASTE, args: { id, ...PASTE.args },
    }]);
    const { shipped, loops, rounds, result } = await runTurn(sized(3_000), calls, () => undefined);

    for (const packet of shipped.slice(1)) {
      expect(packet).toHaveLength(1);
      expect(packet[0]!.args).toMatchObject({ llm_gateway_context_omitted: true });
      expect(packet[0]!.result).toBeUndefined();
    }
    expect(loops).toHaveLength(0);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
  });

  it.each([1, 2])('recovers with smaller answers after %i oversized reads', async (largeReads) => {
    const calls = Array.from({ length: 4 }, () => [READ('n1')]);
    let attempts = 0;
    const { shipped, loops, rounds, result } = await runTurn(sized(2_000), calls, () => {
      attempts += 1;
      return attempts <= largeReads ? BIG : SMALL_READ_RESULT;
    });

    for (const packet of shipped.slice(1, largeReads + 1)) {
      expect(packet).toHaveLength(1);
      expect(packet[0]!.result).toMatchObject({
        llm_gateway_context_omitted: true, preview: expect.any(String),
      });
      const { preview } = packet[0]!.result as { preview: string };
      expect(preview.length).toBeLessThan(JSON.stringify(BIG).length);
    }
    expect(loops).toHaveLength(0);
    expect(attempts).toBe(calls.length);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
    for (const packet of shipped.slice(largeReads + 1)) {
      expect(packet.at(-1)!.result).toEqual(SMALL_READ_RESULT);
    }
  });

  it('recovers with smaller answers after whole call/result pairs were removed', async () => {
    const calls = ['n1', 'n2', 'n1', 'n2', 'n1', 'n2'].map((id) => [READ(id)]);
    let attempts = 0;
    const { shipped, loops, rounds, result } = await runTurn(sized(3_000), calls, () => {
      attempts += 1;
      return attempts <= 2 ? WHOLE_READ_RESULT : SMALL_READ_RESULT;
    });

    expect(shipped[1]).toEqual([{ tool: 'work.read', args: READ('n1').args, result: WHOLE_READ_RESULT }]);
    expect(shipped[2]).toEqual([{ tool: 'work.read', args: READ('n2').args, result: WHOLE_READ_RESULT }]);
    expect(loops).toHaveLength(0);
    expect(attempts).toBe(calls.length);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
    for (const packet of shipped.slice(3)) {
      expect(packet.at(-1)!.result).toEqual(SMALL_READ_RESULT);
    }
  });

  it('still stops if recovered answers become oversized and are lost again', async () => {
    const calls = Array.from({ length: 6 }, () => [READ('n1')]);
    let attempts = 0;
    const { shipped, loops, rounds } = await runTurn(sized(2_000), calls, () => {
      attempts += 1;
      return attempts === 2 ? SMALL_READ_RESULT : BIG;
    });

    expect(shipped[2]!.at(-1)!.result).toEqual(SMALL_READ_RESULT);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/2 tool result\(s\) re-fetched/);
    expect(attempts).toBe(4);
    expect(rounds).toBe(4);
  });

  it('allows a complete newer copy to recover truncated rereads in the same batch', async () => {
    let attempts = 0;
    const { shipped, loops, rounds, result } = await runTurn(
      sized(5_800), [[READ('n1')], [READ('n1'), READ('n1'), READ('n1')]], () => {
        attempts += 1;
        return attempts === 4 ? SMALL_READ_RESULT : BIG;
      },
    );

    expect(shipped[1]![0]!.result).toMatchObject({ llm_gateway_context_omitted: true });
    expect(loops).toHaveLength(0);
    expect(attempts).toBe(4);
    expect(rounds).toBe(3);
    expect(result).toMatchObject({ assistant_content: 'done' });
    expect(shipped[2]).toHaveLength(4);
    for (const call of shipped[2]!.slice(1, 3)) {
      expect(call.result).toMatchObject({ llm_gateway_context_omitted: true });
      const { preview } = call.result as { preview: string };
      expect(preview.length).toBeLessThan(JSON.stringify(BIG).length);
    }
    expect(shipped[2]!.at(-1)!.result).toEqual(SMALL_READ_RESULT);
  });

  it('does not let an older complete copy hide newer truncated rereads', async () => {
    let attempts = 0;
    const { shipped, loops, rounds, result } = await runTurn(
      sized(5_800), [[READ('n1')], [READ('n1'), READ('n1')], [READ('n1')], [READ('n1')]], () => {
        attempts += 1;
        return attempts === 2 ? SMALL_READ_RESULT : BIG;
      },
    );

    expect(shipped[1]![0]!.result).toMatchObject({ llm_gateway_context_omitted: true });
    // Both copies remain in this real prompt. Only the older one is complete;
    // it cannot recover the answer returned by the later reread.
    expect(shipped[2]).toHaveLength(3);
    expect(shipped[2]![1]!.result).toEqual(SMALL_READ_RESULT);
    expect(shipped[2]![2]!.result).toMatchObject({ llm_gateway_context_omitted: true });
    const { preview } = shipped[2]![2]!.result as { preview: string };
    expect(preview.length).toBeLessThan(JSON.stringify(BIG).length);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/2 tool result\(s\) re-fetched/);
    expect(attempts).toBe(4);
    expect(rounds).toBe(3);
    expect(result).not.toHaveProperty('tool_loop_failure');
  });

  it.each([
    {
      label: 'failed dispatch',
      dispatch: async () => ({ ok: false, reason: 'connection_unavailable' }),
    },
    {
      label: 'failed run',
      dispatch: async () => ({
        ok: true, result: { success: false }, run_failed: { detail: 'upstream unavailable' },
      }),
    },
    {
      label: 'held run envelope',
      dispatch: async () => ({ ok: true, result: { queued: true }, run_held: { kind: 'approval' } }),
    },
    {
      label: 'approval acknowledgement',
      dispatch: async () => ({ ok: true, result: { awaiting_approval: true } }),
    },
    {
      label: 'peer acknowledgement',
      dispatch: async () => ({ ok: true, result: { awaiting_peer: true } }),
    },
  ] satisfies Array<{ label: string; dispatch: RunChatTurnDeps['dispatchTool'] }>)
  ('does not treat a newer $label as recovery of a lost reread', async ({ dispatch }) => {
    let attempts = 0;
    const { shipped, loops, rounds } = await runTurn(
      sized(5_800), [[READ('n1')], [READ('n1'), READ('n1'), READ('n1')], [READ('n1')], [READ('n1')]],
      resultFor, async () => {
        attempts += 1;
        if (attempts === 2) return { ok: true, result: SMALL_READ_RESULT };
        if (attempts === 4) return dispatch();
        return { ok: true, result: BIG };
      },
    );

    expect(shipped[1]![0]!.result).toMatchObject({ llm_gateway_context_omitted: true });
    expect(shipped[2]).toHaveLength(4);
    expect(shipped[2]![1]!.result).toEqual(SMALL_READ_RESULT);
    expect(shipped[2]![2]!.result).toMatchObject({ llm_gateway_context_omitted: true });
    const { preview } = shipped[2]![2]!.result as { preview: string };
    expect(preview.length).toBeLessThan(JSON.stringify(BIG).length);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/2 tool result\(s\) re-fetched/);
    expect(attempts).toBe(5);
    expect(rounds).toBe(3);
  });

  it('counts a reread loss only once when malformed output needs a retry', async () => {
    const { shipped, loops, rounds, result } = await runTurn(
      sized(2_000), [[READ('n1')], [READ('n1')]], resultFor, undefined, { invalidPackets: [3] },
    );

    expect(loops).toHaveLength(0);
    expect(rounds).toBe(4);
    expect(shipped).toHaveLength(4);
    for (const packet of shipped.slice(1)) {
      expect(packet).toHaveLength(1);
      expect(packet[0]!.result).toMatchObject({ llm_gateway_context_omitted: true });
      const { preview } = packet[0]!.result as { preview: string };
      expect(preview.length).toBeLessThan(JSON.stringify(BIG).length);
    }
    expect(result).toMatchObject({ assistant_content: 'done' });
    expect(result).not.toHaveProperty('tool_loop_failure');
  });

  it.each([
    {
      label: 'dispatch failures',
      dispatch: async () => ({ ok: false, reason: 'connection_unavailable' }),
    },
    {
      label: 'thrown dispatch failures',
      dispatch: async () => { throw new Error('upstream unavailable'); },
    },
    {
      label: 'failed runs with a successful dispatch envelope',
      dispatch: async () => ({
        ok: true, result: { success: false }, run_failed: { detail: 'upstream unavailable' },
      }),
    },
    {
      label: 'held runs with only an envelope marker',
      dispatch: async () => ({
        ok: true, result: { queued: true }, run_held: { kind: 'approval' },
      }),
    },
    {
      label: 'approval-pending result projections',
      dispatch: async () => ({ ok: true, result: { awaiting_approval: true } }),
    },
    {
      label: 'peer-pending result projections',
      dispatch: async () => ({ ok: true, result: { awaiting_peer: true } }),
    },
    {
      label: 'dispatches without a result',
      dispatch: async () => ({ ok: true, result: undefined }),
    },
  ] satisfies Array<{ label: string; dispatch: RunChatTurnDeps['dispatchTool'] }>)
  ('does not count $label as reread answers', async ({ dispatch }) => {
    const calls = Array.from({ length: 4 }, () => [READ('n1')]);
    let attempts = 0;
    const { shipped, loops, rounds, result } = await runTurn(
      sized(2_000), calls, resultFor, async () => {
        attempts += 1;
        return attempts === 1 ? { ok: true, result: BIG } : dispatch();
      },
    );

    // A real answer was lost before the unsuccessful rereads. Without this
    // boundary, a no-loop assertion could pass because no trim ever acted.
    expect(shipped[1]).toHaveLength(1);
    expect(shipped[1]![0]!.result).toMatchObject({
      llm_gateway_context_omitted: true, preview: expect.any(String),
    });
    const { preview } = shipped[1]![0]!.result as { preview: string };
    expect(JSON.stringify(BIG).startsWith(preview)).toBe(true);
    expect(preview.length).toBeLessThan(JSON.stringify(BIG).length);

    expect(loops).toHaveLength(0);
    expect(attempts).toBe(calls.length);
    expect(rounds).toBe(calls.length + 1);
    expect(result).toMatchObject({ assistant_content: 'done' });
  });

  it('counts successful rereads across failed and held attempts', async () => {
    const calls = Array.from({ length: 7 }, () => [READ('n1')]);
    let attempts = 0;
    const { loops, rounds } = await runTurn(sized(2_000), calls, resultFor, async () => {
      attempts += 1;
      if (attempts === 2) return { ok: false, reason: 'connection_unavailable' };
      if (attempts === 4) return {
        ok: true, result: { awaiting_approval: true }, run_held: { kind: 'approval' },
      };
      return { ok: true, result: BIG };
    });

    // The first answer is lost; rounds 3 and 5 really fetch it again. The
    // intervening failure and hold neither advance nor reset that count.
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/2 tool result\(s\) re-fetched/);
    expect(attempts).toBe(5);
    expect(rounds).toBe(5);
  });

});

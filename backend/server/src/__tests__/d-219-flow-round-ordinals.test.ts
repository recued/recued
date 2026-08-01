/** D-219 V20 — `round_ordinals`: the fact timestamps cannot recover.
 *
 *  A flow's steps are ordered by audit timestamp, so two tools the model
 *  emitted TOGETHER in one tool-loop round and two it emitted in SEQUENCE
 *  across two rounds compile to the same ordered pair. Measured on a real llm
 *  run: one prompt, four repeats, and the same two tools came back batched
 *  three times and sequenced once — with the batched turns' recorded ORDER
 *  differing between themselves, because for a concurrency-safe batch the order
 *  is completion scheduling rather than a decision.
 *
 *  That difference is the substance of what a procedure is worth learning FOR:
 *  a batched pair costs one model round-trip, a sequenced pair costs two. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { deriveExecutionFlowPattern } from '../execution-case-core.js';
import { parseChatToolActivityForTest } from '../execution-case-compiler.js';
import { runChatTurn } from '../chat-turn-executor.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const step = (tool_name: string, round_index?: number) => ({
  tool_name,
  ...(round_index !== undefined ? { round_index } : {}),
});

describe('D-219 V20 — round_ordinals', () => {
  it('distinguishes a BATCHED pair from a SEQUENCED one', () => {
    // The whole point, and neither `tool_sequence` nor `abstract_steps` can say
    // it: both flows below are the same two tools in the same order.
    const batched = deriveExecutionFlowPattern([
      step('contact.search', 0), step('mail.search', 0),
    ]);
    const sequenced = deriveExecutionFlowPattern([
      step('contact.search', 0), step('mail.search', 1),
    ]);
    expect(batched.tool_sequence).toEqual(sequenced.tool_sequence);
    expect(batched.round_ordinals).toEqual([0, 0]);
    expect(sequenced.round_ordinals).toEqual([0, 1]);
  });

  it('aligns positionally with tool_sequence', () => {
    const flow = deriveExecutionFlowPattern([
      step('a', 0), step('b', 0), step('c', 1), step('d', 2),
    ]);
    expect(flow.tool_sequence).toHaveLength(flow.round_ordinals.length);
    expect(flow.round_ordinals).toEqual([0, 0, 1, 2]);
  });

  it('⛔ is EMPTY when ANY step lacks a round, never partial', () => {
    // A partial array would be read positionally and silently mis-align — a
    // wrong batching claim, which is worse than admitting no information. The
    // mixed case is the reachable one: a turn whose dispatches straddle the
    // upgrade, or a tool-loop call beside a resumed run.
    expect(deriveExecutionFlowPattern([
      step('a', 0), step('b'), step('c', 1),
    ]).round_ordinals).toEqual([]);
    // …and the permitting witness, so this is not "always empty".
    expect(deriveExecutionFlowPattern([
      step('a', 0), step('b', 0), step('c', 1),
    ]).round_ordinals).toEqual([0, 0, 1]);
  });

  it('is EMPTY for a pre-V20 flow, which is the honest reading', () => {
    // No audit row written before V20 carries a round. An empty array means
    // "no information"; defaulting to zeros would assert that every historical
    // flow was one batch.
    const flow = deriveExecutionFlowPattern([step('a'), step('b')]);
    expect(flow.round_ordinals).toEqual([]);
    expect(flow.tool_sequence).toEqual(['a', 'b']);
  });

  it('does not disturb the rest of the pattern', () => {
    // `exact_signature` feeds flow identity; a new field changing it would
    // re-key every flow silently rather than through the version bump.
    const withRounds = deriveExecutionFlowPattern([step('a', 0), step('b', 0)]);
    const without = deriveExecutionFlowPattern([step('a'), step('b')]);
    expect(withRounds.exact_signature).toBe(without.exact_signature);
  });
});

describe('D-219 V20 — the audit row carries the round', () => {
  /** The real `chat_tool_call` row shape the compiler parses. */
  const activityJson = (detail: Record<string, unknown>): string =>
    JSON.stringify({
      activity_id: 'a1',
      timestamp: 101,
      action: 'chat_tool_call',
      target: 's1:t1:contact.search',
      detail: JSON.stringify(detail),
    });

  it('reads round_index out of the detail blob', () => {
    // `detail` is an open JSON object the compiler reads by named key, which is
    // why this needed no schema migration — but "the writer puts it there" and
    // "the reader takes it out" are two claims, and this is the second.
    const parsed = parseChatToolActivityForTest(
      activityJson({ status: 'ok', round_index: 2 }),
    );
    expect(parsed?.round_index).toBe(2);
  });

  it('⛔ treats a missing or malformed round as ABSENT, not as zero', () => {
    // A pre-V20 row has no round. Coercing that to 0 would assert every
    // historical pair was batched — a claim the substrate never observed.
    expect(parseChatToolActivityForTest(activityJson({ status: 'ok' }))?.round_index)
      .toBeUndefined();
    for (const bad of [-1, 1.5, '0', null]) {
      expect(
        parseChatToolActivityForTest(activityJson({ status: 'ok', round_index: bad }))
          ?.round_index,
      ).toBeUndefined();
    }
  });
});

describe('D-219 V20 — the executor passes the round it is in', () => {
  /** Drive the real tool loop with a spy dispatch, and record the round each
   *  call was issued with. This is the link a type cannot check: `round_index`
   *  is one line in a large call object, and dropping it would leave every
   *  audit row round-less with nothing failing — the flow would simply go back
   *  to an empty `round_ordinals` and read as "predates the field". */
  const roundsFor = async (
    rounds: Array<Array<{ tool: string; args: unknown }>>,
  ): Promise<Array<number | undefined>> => {
    const seen: Array<number | undefined> = [];
    let call = 0;
    const registry = {
      list: () => [],
      listByTier: () => [],
      getByName: () => ({ name: 'x', tier: 1, concurrency_safe: true }),
      dispatch: async () => ({ ok: true, result: {} }),
      subscribeRefresh: () => () => undefined,
    } as never;
    await runChatTurn(
      {
        session_id: 's', turn_id: 't', picker_target: 'self',
        dispatch_peer_name: null, available_tools: [],
        content: { chat_tail: [], user_message: 'do the thing' },
        correction_context: [], model_layer: 'byok',
      } as never,
      {
        executeAiCall: (async () => {
          const tool_calls = rounds[call] ?? [];
          call += 1;
          return { body: { response: 'ok', events: [], tool_calls } };
        }) as never,
        registry,
        dispatchTool: (async ({ round_index }: { round_index?: number }) => {
          seen.push(round_index);
          return { ok: true, result: { ok: true } };
        }) as never,
        emit: () => undefined,
        now: () => 0,
      } as never,
    );
    return seen;
  };

  it('gives every call in ONE round the same index', async () => {
    const seen = await roundsFor([
      [{ tool: 'contact.search', args: {} }, { tool: 'mail.search', args: {} }],
    ]);
    expect(seen).toEqual([0, 0]);
  });

  it('increments across rounds, which is what makes a batch distinguishable', async () => {
    const seen = await roundsFor([
      [{ tool: 'contact.search', args: {} }],
      [{ tool: 'mail.search', args: {} }],
    ]);
    expect(seen).toEqual([0, 1]);
  });
});

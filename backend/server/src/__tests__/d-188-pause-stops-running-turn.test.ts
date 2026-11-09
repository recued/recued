/** D-188 — the emergency stop reaches a chat turn already running when the owner pauses: it ends
 *  at its next model call, in plain words, and calls the model no more (the owner, 2026-11-09:
 *  "cover the gap"). The chat's model call refuses while paused (`executeChatAiCall` throws
 *  `ChatServerPausedError`); this is what the turn makes of that. */
import { describe, expect, it } from 'vitest';

import { ChatServerPausedError, runChatTurn, SERVER_PAUSED_TURN_RESPONSE } from '../chat-turn-executor.js';

type Reply = 'tool' | 'paused' | 'answer';

/** Drive the real turn with a model that answers each call as `replies` says. */
const turnWith = async (replies: readonly Reply[]) => {
  let calls = 0;
  const dispatched: string[] = [];
  const events: Array<{ kind?: string; event?: { kind?: string } }> = [];
  const registry = {
    list: () => [],
    listByTier: () => [],
    getByName: () => ({ name: 'mail.search', tier: 1, concurrency_safe: true }),
    dispatch: async () => ({ ok: true, result: {} }),
    subscribeRefresh: () => () => undefined,
  } as never;
  const result = await runChatTurn(
    {
      session_id: 's', turn_id: 't', picker_target: 'self',
      dispatch_peer_name: null, available_tools: [],
      content: { chat_tail: [], user_message: 'find the latest invoice' },
      correction_context: [], model_layer: 'byok',
    } as never,
    {
      executeAiCall: (async () => {
        const reply = replies[calls] ?? 'answer';
        calls += 1;
        if (reply === 'paused') throw new ChatServerPausedError();
        if (reply === 'tool') {
          return { body: { response: 'Looking.', events: [], tool_calls: [{ tool: 'mail.search', args: { query: 'invoice' } }] } };
        }
        return { body: { response: 'Here it is.', events: [], tool_calls: [] } };
      }) as never,
      registry,
      dispatchTool: (async ({ tool_name }: { tool_name: string }) => {
        dispatched.push(tool_name);
        return { ok: true, result: { ok: true } };
      }) as never,
      emit: (event: never) => { events.push(event); },
      now: () => 0,
    } as never,
  );
  return { result, calls, dispatched, events };
};

const failureEvents = (events: ReadonlyArray<{ event?: { kind?: string } }>) =>
  events.filter((entry) => entry.event?.kind === 'engine.decoder_unavailable');

describe('a chat turn running when the owner pauses', () => {
  it('ends at its next model call, saying so, and calls the model no more', async () => {
    const { result, calls, dispatched, events } = await turnWith(['tool', 'paused', 'answer']);
    expect(dispatched).toEqual(['mail.search']);
    expect(result.assistant_content).toBe(SERVER_PAUSED_TURN_RESPONSE);
    // Two calls: the one before the pause, and the one the pause refused. None after it.
    expect(calls).toBe(2);
    // Not a provider failure: no "the AI provider failed" notice, nothing recorded as one.
    expect(result.decoder_failure).toBeUndefined();
    expect(result.tool_loop_failure).toBeUndefined();
    expect(failureEvents(events)).toEqual([]);
  });

  it('answers the same when the pause refuses its very first call', async () => {
    const { result, calls, dispatched } = await turnWith(['paused']);
    expect(result.assistant_content).toBe(SERVER_PAUSED_TURN_RESPONSE);
    expect(calls).toBe(1);
    expect(dispatched).toEqual([]);
  });

  it('runs as ever when nothing is paused', async () => {
    const { result, calls } = await turnWith(['tool', 'answer']);
    expect(result.assistant_content).toBe('Here it is.');
    expect(calls).toBe(2);
  });
});

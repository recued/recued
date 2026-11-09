/** The owner's 3a (2026-11-07) — in the owner's own app chat, a call held for their approval waits in
 *  its round for their answer, and the model carries on from the call's outcome in the same round.
 *
 *  The owner: "go ahead with ... 3a". Task J measured an answered approval at about 44 s: a model
 *  round writing that the call waits (27 s), then a continuation turn (17 s), for an answer the
 *  owner gave in 2. Through the REAL orchestrator and chat store, as the LLM gateway's wait is
 *  tested (`d-337-llm-gateway-held-wait.test.ts`): the run's settlement comes through the same
 *  waiters the server feeds, and the model's next round reads the result in place of "waiting". */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AIOutput, ChatDispatchResult, InternalToolRegistry, RecuedServerSignature, ToolEntry } from '@recued/contracts';

import { OWNER_CHAT_HELD_WAIT_MS } from '../chat-carries-on.js';
import { createChatOrchestrator, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { createHeldRunWaiters, settledHeldCallResult } from '../held-run-waiters.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const SIGNATURE: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'owner-chat-held-wait' };
const RECIPE = 'kitchen/put-file-into-page';
const ENTRY: ToolEntry = {
  name: RECIPE, tier: 2, description: 'Put one of the user\'s files into a page.',
  arg_schema: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
  topic_tags: [], classification: 'unknown', concurrency_safe: false,
};
const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);

/** What the run's dispatch returns while it waits for the owner. */
const held = (run_id: string): ChatDispatchResult => ({
  ok: true,
  result: { status: 'awaiting_approval', awaiting_approval: true, message: 'Held for the owner.' },
  run_held: { kind: 'approval' },
  run_id,
});
/** The run's own response once the owner approved it and it ran. */
const ran = {
  success: true, recipe_id: 'put-file-into-page', errors: [],
  steps: [{ id: 'put', status: 'ok', result: { put: 'cv.pdf' } }],
  output: { sidebar: [], render: [{ type: 'summary', fields: [{ label: 'Done', value: 'File Uploaded! 1794_cv.pdf' }] }] },
};
const settledFor = (run_id: string, result: unknown): PreflightRunSettled => ({
  execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local' },
  run_id, tool_name: RECIPE, result, ts: NOW + 2_000,
});

/** One turn of the owner's app chat. The model calls the recipe, then answers; `settle` runs once
 *  the call is held, as the owner's answer would come. */
const turn = async (options: { settle?: (waiters: ReturnType<typeof createHeldRunWaiters>) => void; quickTimeout?: boolean }) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 's1', now: NOW - 10_000 });
  const packets: string[] = [];
  const rounds: AIOutput[] = [
    { response: '', events: [], tool_calls: [{ tool: RECIPE, args: { file: 'file:0123456789abcdef0123456789abcdef' } }] },
    { response: 'It is uploaded: the page shows File Uploaded!', events: [], tool_calls: [] },
  ];
  const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
    packets.push(String(aiInput['llm.prompt']));
    return { body: rounds[Math.min(packets.length, rounds.length) - 1]! };
  });
  // The turn's clock: a wait's deadline is counted on it.
  const waiters = createHeldRunWaiters({ now: () => NOW });
  const dispatch = vi.fn<InternalToolRegistry['dispatch']>(async () => {
    // The owner answers once the call is held: on the next tick, while the round waits.
    if (options.settle !== undefined) setTimeout(() => options.settle!(waiters), 10);
    return held('run-1');
  });
  const registry: InternalToolRegistry = {
    list: () => [ENTRY], listByTier: (tier) => (tier === 2 ? [ENTRY] : []),
    getByName: (name) => (name === RECIPE ? ENTRY : null), dispatch, subscribeRefresh: () => () => undefined,
  };
  const settleHeldCall = vi.fn(async (call: { run_id: string; held: ChatDispatchResult; until: number; signal?: AbortSignal }) => {
    if (options.quickTimeout === true) return undefined;
    const settled = await waiters.wait(call.run_id, call.until, call.signal);
    return settled === undefined ? undefined : settledHeldCallResult(settled, call.held);
  });
  const orchestrator = createChatOrchestrator({ chatStore: store, registry, selfSignature: SIGNATURE, executeAiCall,
    now: () => NOW, settleHeldCall } as never);
  await orchestrator.runTurn({ session_id: 's1', picker_state: { current: 'self' }, message: 'Upload my CV to the form.' } as never);
  db.close();
  return { packets, settleHeldCall, dispatch };
};

describe('the owner\'s 3a — a held call waits in its round for the owner\'s answer', () => {
  it('answered while the round waits: the model\'s next round reads what the call returned, not that it waits', async () => {
    const { packets, settleHeldCall } = await turn({ settle: (waiters) => waiters.settled(settledFor('run-1', ran)) });
    expect(settleHeldCall).toHaveBeenCalledTimes(1);
    expect(settleHeldCall.mock.calls[0]![0]).toMatchObject({ run_id: 'run-1', until: NOW + OWNER_CHAT_HELD_WAIT_MS });
    expect(packets[1]).toContain('File Uploaded! 1794_cv.pdf');
    expect(packets[1]).not.toContain('awaiting_approval');
  });

  it('refused while the round waits: the model reads that the owner said no', async () => {
    const { packets } = await turn({ settle: (waiters) => waiters.settled(settledFor('run-1', { success: false, denied: true })) });
    expect(packets[1]).not.toContain('awaiting_approval');
    expect(packets[1]).toMatch(/plan_cancelled/);
  });

  it('not answered in time: the call stays held, as before', async () => {
    const { packets, settleHeldCall } = await turn({ quickTimeout: true });
    expect(settleHeldCall).toHaveBeenCalledTimes(1);
    expect(packets[1]).toContain('awaiting_approval');
  });
});

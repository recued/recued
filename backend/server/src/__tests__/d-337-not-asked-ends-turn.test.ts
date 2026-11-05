import { describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchResult,
  InternalToolRegistry,
  ToolCall,
  ToolEntry,
} from '@recued/contracts';

import { notAskedYetMessage } from '../chat-carries-on.js';
import { runChatTurn } from '../chat-turn-executor.js';

/** D-337 — told once that a call is not asked while one before it in the turn waits for the
 *  owner's approval (`not_asked_yet`), a model that makes another such call ends the turn: the
 *  conversation carries on by itself with the first call's outcome once the owner answers.
 *  ⛔ Measured: in a browser search the model sent the same click 8 more times over 4½ minutes while
 *  its first click waited, each one not asked. These drive the REAL `runChatTurn`, so a loop that
 *  stops counting turns them red. */
const entry = (name: string, classification: 'read' | 'write'): ToolEntry => ({
  name,
  tier: 2,
  description: name,
  arg_schema: {},
  topic_tags: ['records'],
  classification,
  risk_tier: classification,
  concurrency_safe: classification === 'read',
});
const TOOLS = [
  entry('click-web-element', 'write'),
  entry('add-calendar-event', 'write'),
  entry('read-web-page', 'read'),
];

const registry: InternalToolRegistry = {
  list: () => TOOLS,
  listByTier: () => TOOLS,
  getByName: (name) => TOOLS.find((tool) => tool.name === name) ?? null,
  dispatch: async () => ({ ok: true, result: {} }),
  subscribeRefresh: () => () => {},
};

const input = {
  session_id: 's1',
  turn_id: 't1',
  picker_target: 'self' as const,
  dispatch_peer_name: null,
  available_tools: TOOLS.map((tool) => ({ recipe_slug: tool.name, args_schema: {} })),
  content: { chat_tail: [], user_message: 'search the page for Ada Lovelace and add it to my calendar' },
  correction_context: [] as string[],
  model_layer: 'byok' as const,
};

const call = (tool: string): ToolCall => ({ tool, args: {} });
const calls = (...tools: string[]): AIOutput => ({ response: '', events: [], tool_calls: tools.map(call) });
const answer = (text: string): AIOutput => ({ response: text, events: [], tool_calls: [] });

/** The model answers with `outputs` in order. The first call that would ask the owner waits for
 *  them; every later one is not asked, as the chat's dispatcher answers it; a read runs. */
const turn = async (outputs: AIOutput[]) => {
  let asked = false;
  const dispatchTool = vi.fn(async ({ tool_name }: { tool_name: string }): Promise<ChatDispatchResult> => {
    if (tool_name === 'read-web-page') return { ok: true, result: { text: 'Ada Lovelace' } };
    if (!asked) {
      asked = true;
      return { ok: true, result: { status: 'awaiting_approval' } };
    }
    return { ok: false, reason: 'not_asked_yet', detail: notAskedYetMessage('click-web-element') };
  });
  let n = 0;
  const executeAiCall = vi.fn(async () => ({ body: outputs[Math.min(n++, outputs.length - 1)]! }));
  const events: Array<Record<string, unknown>> = [];
  const result = await runChatTurn(input as never, {
    registry,
    dispatchTool,
    executeAiCall,
    emit: (event: { kind: string; event?: Record<string, unknown> }) => {
      if (event.kind === 'chat.transparency' && event.event) events.push(event.event);
    },
    now: () => 0,
  } as never);
  const ended = events.find((event) => event.kind === 'recued.multi_turn.loop_terminated');
  return { result, dispatchTool, executeAiCall, ended };
};

describe('D-337 — a turn whose rest waits for an approval ends there', () => {
  it('ends at the second round with a call not asked, before the model is called again', async () => {
    const { result, dispatchTool, executeAiCall, ended } = await turn([
      calls('click-web-element'),
      // Told nothing yet: the click waits for the owner.
      calls('click-web-element'),
      // Told once it is not asked; sends it again.
      { response: 'Let me click Search again.', events: [], tool_calls: [call('click-web-element')] },
      // Never reached: the turn ended at the call before.
      calls('click-web-element'),
    ]);
    expect(dispatchTool).toHaveBeenCalledTimes(3);
    expect(executeAiCall).toHaveBeenCalledTimes(3);
    expect(ended).toMatchObject({ termination_reason: 'waiting_for_approval', total_rounds: 3 });
    // The model's own words stay, and the owner reads why nothing more happened.
    expect(result.assistant_content).toBe('Let me click Search again.\n\nThe rest of this request waits for '
      + 'your answer to the approval. Once you answer it, this conversation carries on by itself.');
  });

  /** 🔑 THE PERMITTING WITNESS: a model that reads the refusal and answers is not cut off. */
  it('lets a model that was told once answer from it', async () => {
    const { result, executeAiCall, ended } = await turn([
      calls('click-web-element'),
      calls('click-web-element'),
      answer('I asked to click Search; once you approve it I will read the result.'),
    ]);
    expect(executeAiCall).toHaveBeenCalledTimes(3);
    expect(ended).toMatchObject({ termination_reason: 'completed' });
    expect(result.assistant_content).toBe('I asked to click Search; once you approve it I will read the result.');
  });

  it('counts a round, not a call: two calls not asked together are told once', async () => {
    const { result, dispatchTool, ended } = await turn([
      calls('click-web-element'),
      calls('click-web-element', 'add-calendar-event'),
      answer('Both come after your approval.'),
    ]);
    expect(dispatchTool).toHaveBeenCalledTimes(3);
    expect(ended).toMatchObject({ termination_reason: 'completed' });
    expect(result.assistant_content).toBe('Both come after your approval.');
  });

  it('counts the turn, not a run of rounds: a read between the two does not reset it', async () => {
    const { dispatchTool, ended } = await turn([
      calls('click-web-element'),
      calls('click-web-element'),
      calls('read-web-page'),
      calls('add-calendar-event'),
      answer('never reached'),
    ]);
    expect(dispatchTool.mock.calls.map(([dispatch]) => dispatch.tool_name)).toEqual([
      'click-web-element', 'click-web-element', 'read-web-page', 'add-calendar-event',
    ]);
    expect(ended).toMatchObject({ termination_reason: 'waiting_for_approval', total_rounds: 4 });
  });

  /** Any other refusal is not a wait: a model correcting a bad call keeps its rounds. */
  it('does not count another refusal', async () => {
    let n = 0;
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => (n++ < 3
      ? { ok: false, reason: 'execution_error', detail: 'the page did not answer' }
      : { ok: true, result: {} }));
    const outputs = [calls('click-web-element'), calls('click-web-element'), calls('click-web-element'),
      calls('click-web-element'), answer('Clicked.')];
    let m = 0;
    const executeAiCall = vi.fn(async () => ({ body: outputs[Math.min(m++, outputs.length - 1)]! }));
    const result = await runChatTurn(input as never, {
      registry, dispatchTool, executeAiCall, emit: () => {}, now: () => 0,
    } as never);
    expect(dispatchTool).toHaveBeenCalledTimes(4);
    expect(result.assistant_content).toBe('Clicked.');
  });
});

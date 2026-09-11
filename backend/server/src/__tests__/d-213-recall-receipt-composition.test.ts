/** D-213 — the recall receipt AT THE COMPOSITION BOUNDARY.
 *
 *  The contracts tests pin the projection; this one pins what the model
 *  actually reads. A receipt that never reaches the composed body would leave
 *  the defect live with the unit tests green, so these assertions run through
 *  `composeChatMainTurnPromptParts` rather than around it.
 */
import { describe, it, expect } from 'vitest';
import type { ChatPriorToolCall, ChatTailMessage } from '@recued/contracts';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';

const SECRET = 'Dana Reyes drew 1695 units at the ring 09 checkpoint';

const recallCall = (query: string): ChatPriorToolCall => ({
  tool_name: 'memory.search',
  tier: 1,
  args: { query },
  status: 'ok',
  result: { memories: [{ memory_id: 'umem_1', body: SECRET }] },
  started_at: 0,
  completed_at: 1,
});

const TAIL: ChatTailMessage[] = [{ role: 'user', content: 'earlier' }];

const compose = (calls: readonly ChatPriorToolCall[]) =>
  composeChatMainTurnPromptParts({
    available_tools: [],
    content: { chat_tail: TAIL, user_message: 'rings 05 and 06?' },
    prior_tool_calls: calls,
  } as Parameters<typeof composeChatMainTurnPromptParts>[0]);

describe('D-213 recall receipt — composed packet', () => {
  it('emits prior_tool_calls when every accumulated call was a recall', () => {
    // Before the receipt this body carried NO `prior_tool_calls` key at all.
    const { body } = compose([
      recallCall('ring 05 checkpoint cost'),
      recallCall('ring 06 checkpoint cost'),
    ]);
    const parsed = JSON.parse(body) as {
      prior_tool_calls?: ChatPriorToolCall[];
      recall_context?: ChatPriorToolCall[];
    };

    expect(parsed.prior_tool_calls).toHaveLength(2);
    expect(parsed.prior_tool_calls?.[0]?.args)
      .toEqual({ query: 'ring 05 checkpoint cost' });
    // The recalled content still reaches the model by its typed field only.
    expect(parsed.recall_context).toHaveLength(2);
  });

  it('keeps recalled content out of the receipt lane', () => {
    const { body } = compose([recallCall('ring 09 cost')]);
    const parsed = JSON.parse(body) as { prior_tool_calls?: unknown };

    expect(JSON.stringify(parsed.prior_tool_calls)).not.toContain(SECRET);
    expect(JSON.stringify(parsed.prior_tool_calls)).not.toContain('umem_1');
    // …while the query the model itself wrote is exactly what it can now see.
    expect(JSON.stringify(parsed.prior_tool_calls)).toContain('ring 09 cost');
  });

  it('keeps the cacheable prefix a literal prefix of the body', () => {
    const { cacheable_prefix, body } = compose([recallCall('q')]);
    expect(body.startsWith(cacheable_prefix)).toBe(true);
  });
});

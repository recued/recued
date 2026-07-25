import { describe, expect, it } from 'vitest';

import {
  MEMORY_RECALL_TOOL_NAMES,
  partitionPriorToolCalls,
  type ChatPriorToolCall,
} from '../index.js';

const call = (tool_name: string, detail: string): ChatPriorToolCall => ({
  tool_name,
  tier: 1,
  args: { query: detail },
  status: 'ok',
  result: { detail },
  detail,
  started_at: 0,
  completed_at: 1,
});

describe('D-167 recall prior tool partition', () => {
  it('routes memory.search to recall and other tool names to prior while preserving per-arm order', () => {
    const contact = call('contact.search', 'contact');
    const memoryA = call('memory.search', 'memory-a');
    const mail = call('mail.search', 'mail');
    const memoryB = call('memory.search', 'memory-b');
    const recipe = call('recipe.run', 'recipe');

    const partitioned = partitionPriorToolCalls([
      contact,
      memoryA,
      mail,
      memoryB,
      recipe,
    ]);

    expect(MEMORY_RECALL_TOOL_NAMES.has('memory.search')).toBe(true);
    expect(partitioned.prior).toEqual([contact, mail, recipe]);
    expect(partitioned.recall).toEqual([memoryA, memoryB]);
  });

  it('returns empty prior and recall arms for empty input', () => {
    expect(partitionPriorToolCalls([])).toEqual({ prior: [], recall: [] });
  });
});

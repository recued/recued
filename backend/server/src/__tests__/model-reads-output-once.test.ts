/** D-335 slice Q — a run's output reaches a model once. The engine writes every section twice,
 *  `output.render` and the old `output.sidebar` (the same array, `renderOutput` in
 *  `packages/engine/src/execute.ts`), and both went into the chat's `prior_tool_calls` and into an
 *  MCP agent's text: every recipe result a model read cost it twice. The chat's own call and the
 *  result a client reads keep both; the web app's result panel reads `sidebar`. */
import { describe, expect, it } from 'vitest';
import type { ChatPriorToolCall } from '@recued/contracts';

import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { withoutRenderAlias } from '../run-result-agent-projection.js';

const SECTION = { type: 'json', label: 'Page', data: { outline: '# Ada Lovelace\nShe wrote the notes.' } };
const RUN = { recipe_id: 'inspect-web-page', success: true, output: { render: [SECTION], sidebar: [SECTION] }, steps: [], errors: [] };

describe('D-335 slice Q — a model reads a run\'s output once', () => {
  it('drops the sidebar copy when it is render, and nothing else', () => {
    expect(withoutRenderAlias(RUN)).toEqual({ ...RUN, output: { render: [SECTION] } });
    // The same array, as the engine writes it.
    const shared = [SECTION];
    expect(withoutRenderAlias({ output: { render: shared, sidebar: shared } })).toEqual({ output: { render: shared } });
    // A sidebar that says something else, or anything that is not a run, is left as it is.
    const different = { output: { render: [SECTION], sidebar: [{ ...SECTION, label: 'Other' }] } };
    expect(withoutRenderAlias(different)).toBe(different);
    for (const other of [null, 'text', [1], { output: 'x' }, { output: { render: [SECTION] } }]) expect(withoutRenderAlias(other)).toBe(other);
    // The result it was given is not changed: its row and its clients keep both.
    expect(RUN.output.sidebar).toEqual([SECTION]);
  });

  it('the chat sends each earlier call\'s output once, and keeps the call as it was', () => {
    const call: ChatPriorToolCall = { tool_name: 'kitchen/inspect-web-page', tier: 2, args: { page: '7:DOC1' }, status: 'ok',
      result: RUN, started_at: 1, completed_at: 2 };
    const { body } = composeChatMainTurnPromptParts({ available_tools: [],
      content: { chat_tail: [], user_message: 'what does the page say' }, prior_tool_calls: [call] });
    expect(body.split('She wrote the notes.')).toHaveLength(2);
    const sent = (JSON.parse(body) as { prior_tool_calls: Array<{ result: { output: Record<string, unknown> } }> }).prior_tool_calls[0]!;
    expect(Object.keys(sent.result.output)).toEqual(['render']);
    expect((call.result as typeof RUN).output.sidebar).toEqual([SECTION]);
  });
});

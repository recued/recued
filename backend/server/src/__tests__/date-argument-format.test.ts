/** A model's date argument is checked at every door, not only the contracted
 *  gateway.
 *
 *  ⛔ WHY. A recipe tool advertises `format: date` / `date-time` for its `date`
 *  and `datetime` settings (`deriveTier2ArgSchema`), and only the contracted
 *  gateway looked: the owner's own chat and MCP handed the recipe whatever the
 *  model wrote — `2026-02-30`, which `Date.parse` reads as 2 March, or a time
 *  where a day belongs. */
import { describe, expect, it, vi } from 'vitest';

import type { ChatDispatchContext, RecipeDefinition } from '@recued/contracts';

import { createChatTier2Dispatch, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { dateFormatIssue, recipeDateArgumentIssue } from '../date-argument-format.js';
import type { ExecuteRequest, ExecuteResponse } from '../types.js';

describe('dateFormatIssue', () => {
  it('a `date` is a day that exists, written YYYY-MM-DD', () => {
    expect(dateFormatIssue('date', '2026-10-01', 'due')).toBeNull();
    expect(dateFormatIssue('date', '2024-02-29', 'due')).toBeNull();
    expect(dateFormatIssue('date', '2026-02-30', 'due')).toBe('due must be a date as YYYY-MM-DD');
    expect(dateFormatIssue('date', '2026-10-01T09:00', 'due')).toBe('due must be a date as YYYY-MM-DD');
    expect(dateFormatIssue('date', 'next friday', 'due')).toBe('due must be a date as YYYY-MM-DD');
  });

  it('a `date-time` is anything `Date.parse` reads — a bare day included', () => {
    expect(dateFormatIssue('date-time', '2026-10-01T09:30:00+02:00', 'at')).toBeNull();
    expect(dateFormatIssue('date-time', '2026-10-01T09:30', 'at')).toBeNull();
    expect(dateFormatIssue('date-time', '2026-10-01', 'at')).toBeNull();
    expect(dateFormatIssue('date-time', 'tomorrow at five', 'at'))
      .toBe('at must be an ISO 8601 date-time string');
  });

  it('a blank is no value, not a bad one — `datetime` settings say "leave blank"', () => {
    expect(dateFormatIssue('date', '', 'due')).toBeNull();
    expect(dateFormatIssue('date-time', '  ', 'at')).toBeNull();
  });

  it('checks nothing it was not asked to', () => {
    expect(dateFormatIssue(undefined, 'anything', 'x')).toBeNull();
    expect(dateFormatIssue('email', 'anything', 'x')).toBeNull();
  });
});

const recipe = (variables: Record<string, unknown>): RecipeDefinition => ({
  recipe_id: 'dated',
  version: 1,
  metadata: { name: 'dated', description: 'Test', author: 'recued-core', tags: [] },
  chat_exposed: true,
  variables,
  steps: [],
} as unknown as RecipeDefinition);

describe('recipeDateArgumentIssue', () => {
  const dated = recipe({
    target: { label: 'Target', type: 'date', optional: true },
    meeting_at: { label: 'Meeting', type: 'datetime', optional: true },
    note: { label: 'Note', type: 'string', optional: true },
    days: 7,
  });

  it('names the first date setting whose string is not one', () => {
    expect(recipeDateArgumentIssue(dated, { target: '2026-02-30' }))
      .toBe('target must be a date as YYYY-MM-DD');
    expect(recipeDateArgumentIssue(dated, { meeting_at: 'soon' }))
      .toBe('meeting_at must be an ISO 8601 date-time string');
  });

  it('leaves other types, and values that are not strings, to the recipe', () => {
    expect(recipeDateArgumentIssue(dated, {
      target: '2026-10-01', meeting_at: 1_790_000_000_000, note: '2026-02-30', days: 'x',
    })).toBeNull();
  });
});

describe('the owner\'s chat and MCP refuse a malformed date before the recipe runs', () => {
  const owned = recipe({ target: { label: 'Target', type: 'date', optional: true } });
  const dispatchWith = () => {
    const execute = vi.fn(async (req: ExecuteRequest) => ({
      success: true, recipe_id: req.recipe_id, steps: [], output: { render: [] },
    }) as unknown as ExecuteResponse);
    const dispatch = createChatTier2Dispatch({
      getExecuteRecipe: () => execute,
      getRecipeStore: () => ({
        ids: () => ['dated'],
        get: (id: string) => (id === 'dated' ? owned : null),
        getStored: () => null,
        listStored: () => [],
      }),
    } as unknown as ChatToolHandlerDeps);
    return { dispatch, execute };
  };
  const chat: ChatDispatchContext = { channel: 'internal_function_call', session_id: 's', turn_id: 't' };
  const mcp: ChatDispatchContext = { channel: 'mcp_wire', mcp_token_id: 'stdio_local' };

  it.each([['owner chat', chat], ['MCP', mcp]])('%s: a day that does not exist', async (_door, ctx) => {
    const { dispatch, execute } = dispatchWith();
    const result = await dispatch('recued-core/dated', { target: '2026-02-30' }, ctx);
    expect(result).toEqual({
      ok: false, reason: 'invalid_args', detail: 'target must be a date as YYYY-MM-DD',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('a real day runs the recipe with it', async () => {
    const { dispatch, execute } = dispatchWith();
    const result = await dispatch('recued-core/dated', { target: '2026-10-01' }, chat);
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ config: { target: '2026-10-01' } }));
  });
});

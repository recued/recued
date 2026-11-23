/** D-402 slice F5 (§7.9) — a chat call that a standing permission of the owner's chats ran without
 *  asking carries the recipe "Stop allowing" ends, so its line in the chat offers the button: read off
 *  the run's own record of what let each write through (`let_through`), never off its words. Not for a
 *  run "Yes, this time" alone let through, nor an AI app's, nor a trigger's. The webclient's side is
 *  `apps/webclient/src/__tests__/chat-stop-allowing.test.ts`. */
import { describe, expect, it } from 'vitest';
import type { ChatDispatchResult, RunLetThrough } from '@recued/contracts';

import { stopAllowingOfRun, wrapRecipeRunResult } from '../chat-tool-handlers.js';
import { toolCallProvenanceEntry } from '../chat-turn-executor.js';
import type { ExecuteResponse } from '../types.js';

const run = (let_through?: RunLetThrough, over: Partial<ExecuteResponse> = {}): ExecuteResponse =>
  ({ recipe_id: 'add-morning-note', success: true, errors: [], ...(let_through !== undefined ? { let_through } : {}), ...over }) as ExecuteResponse;
const owner = (by: RunLetThrough['writes'][number]['by'], count = 1): RunLetThrough =>
  ({ caller: { kind: 'owner_chat' }, writes: [{ by, count }] });

type ProvenanceArgs = Parameters<typeof toolCallProvenanceEntry>;
const entry = (result: ChatDispatchResult) => toolCallProvenanceEntry(
  { tool: 'recipe.run', args: { recipe_id: 'add-morning-note' } } as ProvenanceArgs[0], result, {} as ProvenanceArgs[2],
  1, 2, 'sess', 'turn', 2);

describe('D-402 slice F5 — which chat calls offer "Stop allowing"', () => {
  it('a write an "Always", a site pass, a grant or a rule of the owner\'s chats let through', () => {
    for (const by of ['always', 'site_pass', 'grant', 'rule'] as const) {
      expect(stopAllowingOfRun(run(owner(by))), by).toEqual({ stop_allowing_recipe_id: 'add-morning-note' });
    }
    // Among others, one is enough.
    expect(stopAllowingOfRun(run({ caller: { kind: 'owner_chat' }, writes: [{ by: 'this_run', count: 2 }, { by: 'always', count: 1 }] })))
      .toEqual({ stop_allowing_recipe_id: 'add-morning-note' });
  });

  it('none for "Yes, this time" alone, the switch, a trigger\'s, an AI app\'s, a count of none, or no record', () => {
    expect(stopAllowingOfRun(run(owner('this_run')))).toEqual({});
    expect(stopAllowingOfRun(run(owner('switch')))).toEqual({});
    expect(stopAllowingOfRun(run({ writes: [{ by: 'trigger', count: 3 }] }))).toEqual({});
    expect(stopAllowingOfRun(run({ caller: { kind: 'ai_app', contract_id: 'k-claude' }, writes: [{ by: 'always', count: 1 }] }))).toEqual({});
    expect(stopAllowingOfRun(run(owner('always', 0)))).toEqual({});
    expect(stopAllowingOfRun(run())).toEqual({});
  });

  it('rides the dispatch result of a run that worked, failed, held or was cancelled: each may have written', () => {
    const through = owner('always');
    expect(wrapRecipeRunResult(run(through))).toMatchObject({ ok: true, stop_allowing_recipe_id: 'add-morning-note' });
    expect(wrapRecipeRunResult(run(through, { success: false, errors: [{ code: 'NETWORK_ERROR', message: 'x' }] as never })))
      .toMatchObject({ ok: true, run_failed: {}, stop_allowing_recipe_id: 'add-morning-note' });
    expect(wrapRecipeRunResult(run(through, { success: false, awaiting_approval: true })))
      .toMatchObject({ ok: true, run_held: { kind: 'approval' }, stop_allowing_recipe_id: 'add-morning-note' });
    expect(wrapRecipeRunResult(run(through, { success: false, run_terminated: 'killed' }), 'add-morning-note'))
      .toMatchObject({ ok: false, reason: 'run_cancelled', stop_allowing_recipe_id: 'add-morning-note' });
    expect(wrapRecipeRunResult(run(owner('this_run')))).not.toHaveProperty('stop_allowing_recipe_id');
    // What the model reads is unchanged: it hears of it in `ran_without_asking`, as before.
    expect(JSON.stringify((wrapRecipeRunResult(run(through)) as { result: unknown }).result)).not.toContain('stop_allowing_recipe_id');
  });

  it('is kept on the answer\'s call, whatever the call came to', () => {
    const recipe = { stop_allowing_recipe_id: 'add-morning-note' };
    expect(entry({ ok: true, result: {}, ...recipe })).toMatchObject({ status: 'ok', ...recipe });
    expect(entry({ ok: true, result: {}, run_failed: { detail: 'x' }, ...recipe })).toMatchObject({ status: 'error', ...recipe });
    expect(entry({ ok: false, reason: 'run_cancelled', ...recipe })).toMatchObject({ status: 'error', ...recipe });
    expect(entry({ ok: true, result: {} })).not.toHaveProperty('stop_allowing_recipe_id');
  });
});

/** D-182 — the chat activity row surfaces a failed run's concise error line
 *  (e.g. the cli "not found" message) for an `execution_error`, while other
 *  reasons keep their bare slug. */

import { describe, expect, it } from 'vitest';

import { projectInFlightActivity } from '../chat/activity.js';

const turnWith = (call: Record<string, unknown>): Parameters<typeof projectInFlightActivity>[0] =>
  ({ transparency: [], tool_calls: [call] }) as unknown as Parameters<typeof projectInFlightActivity>[0];

const toolText = (call: Record<string, unknown>): string | undefined =>
  projectInFlightActivity(turnWith(call)).find((r) => r.kind === 'tool')?.text;

describe('D-182 — chat activity error line', () => {
  it('an execution_error with detail renders the error line, not the bare slug', () => {
    expect(toolText({
      tool_name: 'recipe.run', tier: 2, args: {}, status: 'error',
      reason: 'execution_error', detail: "cli tool 'whisper' was not found",
    })).toBe("couldn't run recipe.run: cli tool 'whisper' was not found");
  });

  it('a non-execution_error reason keeps its slug (the detail is not surfaced)', () => {
    expect(toolText({
      tool_name: 'recipe.run', tier: 2, args: {}, status: 'error',
      reason: 'run_cancelled', detail: 'a long do-not-retry posture message …',
    })).toBe("couldn't run recipe.run: run cancelled");
  });

  it('an execution_error without a detail falls back to the slug', () => {
    expect(toolText({
      tool_name: 'recipe.run', tier: 2, args: {}, status: 'error', reason: 'execution_error',
    })).toBe("couldn't run recipe.run: execution error");
  });

  it('a very long detail is truncated to one capped line', () => {
    const text = toolText({
      tool_name: 'tool', tier: 2, args: {}, status: 'error',
      reason: 'execution_error', detail: 'x'.repeat(300),
    }) ?? '';
    expect(text.length).toBeLessThan(200);
    expect(text.endsWith('…')).toBe(true);
  });

  it('D-337 — a call not asked while one before it waits reads as left for later, not as an error', () => {
    const row = projectInFlightActivity(turnWith({
      tool_name: 'calendar.create', tier: 1, args: {}, status: 'error',
      reason: 'not_asked_yet', detail: 'Not asked: an earlier call in this turn (recipe.run) is waiting …',
    })).find((r) => r.kind === 'tool');
    expect(row).toMatchObject({
      text: 'left until you answer the approval before it: calendar.create',
      // Nothing failed, so nothing "Needs attention"; nothing runs, so nothing is ongoing.
      status: 'ok',
    });
  });
});

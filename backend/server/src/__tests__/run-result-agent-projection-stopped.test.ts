/** A run a step's `stop_when` ended early SUCCEEDED, and the steps up to that one
 *  ran — so, unlike a skipped trigger, its output is a real answer and stays. What
 *  the agent needs beside it is the sentence: `success: true` next to a short
 *  output otherwise reads as "that is everything there is", when the recipe in
 *  fact decided the rest was not needed. */
import { describe, expect, it } from 'vitest';
import { projectRunResultForAgent, runStoppedMessage } from '../run-result-agent-projection.js';
import type { ExecuteResponse } from '../types.js';

const stoppedRun = {
  recipe_id: 'mail-triage',
  recipe_hash: 'a1b2c3d4',
  success: true,
  output: { render: [{ type: 'text', data: 'no new mail' }], sidebar: [] },
  steps: [
    { id: 'new_mail', type: 'transform', skipped: false, duration_ms: 1, error: null, stopped: true },
  ],
  errors: [],
  duration_ms: 3,
  stopped: { step_id: 'new_mail', condition: '{{step.new_mail}} is_empty' },
} as unknown as ExecuteResponse;

describe('a run a stop_when ended — agent projection', () => {
  it('keeps the output and adds one sentence naming the step', () => {
    const out = projectRunResultForAgent(stoppedRun) as Record<string, unknown>;
    expect(out.status).toBe('stopped');
    expect(out.message).toBe(runStoppedMessage('new_mail'));
    expect(out.success).toBe(true);
    expect(out.output).toEqual(stoppedRun.output);
    expect(out.stopped).toEqual(stoppedRun.stopped);
  });

  it('says it was expected, not a failure, and not to run it again', () => {
    const message = runStoppedMessage('new_mail');
    expect(message).toContain('"new_mail"');
    expect(message).toMatch(/expected outcome, not a failure/u);
    expect(message).toMatch(/Do not run it again/u);
  });

  it('lets a refused-items tally win when both hold — the more urgent sentence', () => {
    const both = {
      ...stoppedRun,
      steps: [
        ...stoppedRun.steps,
        { id: 'save', type: 'op', skipped: false, duration_ms: 1, error: null, foreach: { items: 2, failed: 2 } },
      ],
    } as unknown as ExecuteResponse;
    expect((projectRunResultForAgent(both) as { status: string }).status).toBe('items_refused');
  });

  it('leaves a run that went to the end untouched, by reference', () => {
    const { stopped: _stopped, ...plain } = stoppedRun as unknown as Record<string, unknown>;
    expect(projectRunResultForAgent(plain)).toBe(plain);
  });
});

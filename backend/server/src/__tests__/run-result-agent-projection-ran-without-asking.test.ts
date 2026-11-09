/** D-341 slice A — a run whose browser writes the owner's chat let through without asking ("Don't
 *  ask about browser actions") says so in its answer, which the model reads: one sentence, first,
 *  whatever else the run's result says. The count it comes from is the server's, never the model's. */
import { describe, expect, it } from 'vitest';
import { projectRunResultForAgent, RAN_WITHOUT_ASKING_MESSAGE } from '../run-result-agent-projection.js';
import type { ExecuteResponse } from '../types.js';

const run = (fields: Partial<ExecuteResponse> & Record<string, unknown> = {}): ExecuteResponse => ({
  recipe_id: 'act-on-web-page',
  recipe_hash: 'a1b2c3d4',
  success: true,
  output: { render: [{ type: 'text', data: 'sent' }], sidebar: [] },
  steps: [{ id: 'act', type: 'op', skipped: false, duration_ms: 1, error: null }],
  errors: [],
  duration_ms: 3,
  ...fields,
}) as unknown as ExecuteResponse;

describe('a run the chat\'s switch let through — agent projection', () => {
  it('says it ran without asking, first, and drops the count', () => {
    const out = projectRunResultForAgent(run({ request_pass_writes: 2 })) as Record<string, unknown>;
    expect(Object.keys(out)[0]).toBe('ran_without_asking');
    expect(out.ran_without_asking).toBe(RAN_WITHOUT_ASKING_MESSAGE);
    expect(out).not.toHaveProperty('request_pass_writes');
    expect(out.output).toEqual({ render: [{ type: 'text', data: 'sent' }], sidebar: [] });
  });

  it('names the switch, and says the user was not asked', () => {
    expect(RAN_WITHOUT_ASKING_MESSAGE).toContain('“Don’t ask about browser actions”');
    expect(RAN_WITHOUT_ASKING_MESSAGE).toContain('without asking the user');
  });

  it('a run held at a later step still says what it did without asking, beside the hold', () => {
    const out = projectRunResultForAgent(run({ success: false, awaiting_approval: true, request_pass_writes: 1 })) as
      Record<string, unknown>;
    expect(out).toMatchObject({ status: 'awaiting_approval', ran_without_asking: RAN_WITHOUT_ASKING_MESSAGE });
  });

  it('a failed run keeps its errors and says it too', () => {
    const out = projectRunResultForAgent(run({ success: false, errors: [{ message: 'no such element' }], request_pass_writes: 1 })) as
      Record<string, unknown>;
    expect(out).toMatchObject({ success: false, errors: [{ message: 'no such element' }], ran_without_asking: RAN_WITHOUT_ASKING_MESSAGE });
  });

  it('a run nothing let through, or a count of none, says nothing of it', () => {
    expect(projectRunResultForAgent(run())).not.toHaveProperty('ran_without_asking');
    const none = projectRunResultForAgent(run({ request_pass_writes: 0 })) as Record<string, unknown>;
    expect(none).not.toHaveProperty('ran_without_asking');
    expect(none).not.toHaveProperty('request_pass_writes');
  });
});

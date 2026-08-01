/** A recipe whose TRIGGER condition was not met is a clean third-state, not a
 *  successful run with an empty answer. `ExecuteResponse.success` is TRUE on a
 *  skip by contract (`packages/engine/src/types.ts`: "a silent-skip is not an
 *  error"), and the engine returns early before any step runs — so the empty
 *  output means NOTHING WAS PRODUCED, never that nothing exists. */

import { describe, expect, it } from 'vitest';

import {
  TRIGGER_SKIPPED_MESSAGE,
  projectRunResultForAgent,
} from '../run-result-agent-projection.js';
import type { ExecuteResponse } from '../types.js';

/** ⛔ VERBATIM from a live dispatch: `open-commitments` returned exactly this and
 *  the model told the owner "Your open commitments view is clear. There are no
 *  outstanding commitments or open loops at the moment." Nothing was checked. */
const SKIPPED = {
  recipe_id: 'open-commitments',
  recipe_hash: 'dc537045',
  success: true,
  output: { sidebar: [] },
  steps: [{ id: 'active_window', type: 'ingredient', skipped: false, duration_ms: 1, error: null }],
  errors: [],
  duration_ms: 2,
  trigger_skipped: true,
} as unknown as ExecuteResponse;

describe('a skipped trigger is named, not passed through as success', () => {
  it('projects it to a self-describing third state', () => {
    const out = projectRunResultForAgent(SKIPPED) as Record<string, unknown>;
    expect(out['status']).toBe('trigger_skipped');
    expect(out['trigger_skipped']).toBe(true);
    expect(out['recipe_id']).toBe('open-commitments');
    expect(out['message']).toBe(TRIGGER_SKIPPED_MESSAGE);
  });

  /** ⛔⛔ THE EMPTY OUTPUT MUST NOT SURVIVE AS AN ANSWER. Leaving `output` on the
   *  projection is how the model reports "no commitments" — the sidebar is an
   *  absence of production, not an absence of data. */
  it('does not carry the empty output through', () => {
    const out = projectRunResultForAgent(SKIPPED) as Record<string, unknown>;
    expect(out['output']).toBeUndefined();
    expect(out['success']).toBeUndefined();
  });

  it('⛔ the message forbids reporting it as an answer, and forbids retrying', () => {
    expect(TRIGGER_SKIPPED_MESSAGE).toMatch(/NOTHING WAS CHECKED/);
    expect(TRIGGER_SKIPPED_MESSAGE).toMatch(/do not present it as an answer/i);
    expect(TRIGGER_SKIPPED_MESSAGE).toMatch(/do not retry/i);
    // ⚠ Same posture as the held-for-approval message: an expected outcome, so
    // the model neither treats it as a fault nor hides it from the owner.
    expect(TRIGGER_SKIPPED_MESSAGE).toMatch(/not a failure/i);
    expect(TRIGGER_SKIPPED_MESSAGE).toMatch(/tell the user/i);
  });
});

describe('what it must NOT capture', () => {
  /** ⛔ THE PERMITTING WITNESS. Without it this suite cannot tell a
   *  trigger-skip projection from one that rewrites every run. */
  it('leaves an ORDINARY successful run untouched', () => {
    const ok = {
      recipe_id: 'open-commitments',
      recipe_hash: 'dc537045',
      success: true,
      output: { sidebar: [{ type: 'list', data: {} }] },
      steps: [{ id: 'active_window' }],
      errors: [],
    } as unknown as ExecuteResponse;
    expect(projectRunResultForAgent(ok)).toBe(ok);
  });

  it('leaves an ordinary FAILURE untouched — it has its own errors to explain it', () => {
    const failed = {
      recipe_id: 'surface-stalling-deals-crm',
      success: false,
      steps: [],
      errors: [{ error_id: 'budget-1', message: 'budget exceeded' }],
    } as unknown as ExecuteResponse;
    expect(projectRunResultForAgent(failed)).toBe(failed);
  });

  /** ⚠ `trigger_skipped: false` is the ordinary path and must not be caught by a
   *  truthiness test — the check is `=== true`. */
  it('is not fooled by an explicit trigger_skipped: false', () => {
    const ran = {
      recipe_id: 'x', success: true, output: { sidebar: [] }, steps: [], errors: [],
      trigger_skipped: false,
    } as unknown as ExecuteResponse;
    expect(projectRunResultForAgent(ran)).toBe(ran);
  });
});

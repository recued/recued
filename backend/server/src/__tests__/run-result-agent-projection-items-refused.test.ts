/** A `foreach` is CONTINUE-ON-ERROR, so a step that refused every single item
 *  still returns `success: true` with an EMPTY `errors[]`. The engine reports
 *  the fact as a per-step tally (`step-runner.ts`: `foreach: { items, failed }`)
 *  and deliberately keeps it OUT of `errors[]`. Both human surfaces already read
 *  that tally — `console-output.ts` prints "Items refused: N of M — every one",
 *  `recipe-result-panel.ts` renders the same badge — and the agent projection
 *  did not, so a model was handed `success: true` with a counter buried in the
 *  steps array and no sentence anywhere. */

import { describe, expect, it } from 'vitest';

import {
  ITEMS_ALL_REFUSED_MESSAGE,
  ITEMS_PARTIALLY_REFUSED_MESSAGE,
  projectRunResultForAgent,
} from '../run-result-agent-projection.js';
import type { ExecuteResponse } from '../types.js';

const run = (
  steps: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): ExecuteResponse => ({
  recipe_id: 'invoice-intake-watch',
  recipe_hash: 'a1b2c3d4',
  success: true,
  output: { summary: 'processed' },
  steps,
  errors: [],
  duration_ms: 12,
  ...extra,
} as unknown as ExecuteResponse);

describe('every item refused — the run wrote nothing and said success', () => {
  const ALL = run([
    { id: 'stage_files', type: 'op', skipped: false, duration_ms: 9, error: null,
      foreach: { items: 10, failed: 10 } },
  ]);

  it('names it, and says every item went', () => {
    const out = projectRunResultForAgent(ALL) as Record<string, unknown>;
    expect(out['status']).toBe('items_refused');
    const detail = out['items_refused'] as Record<string, unknown>;
    expect(detail['total_items']).toBe(10);
    expect(detail['total_failed']).toBe(10);
    expect(detail['every_item']).toBe(true);
    expect(detail['steps']).toEqual([{ step_id: 'stage_files', items: 10, failed: 10 }]);
    expect(out['message']).toBe(ITEMS_ALL_REFUSED_MESSAGE);
  });

  /** ⛔⛔ THE OPPOSITE RULE TO THE TRIGGER-SKIPPED BRANCH, AND IT IS DELIBERATE.
   *  A skipped trigger DROPS `output`/`success` because the empty render block
   *  is the whole defect there. A refused run RAN — the items that landed are
   *  still the answer the model has to report from — so this branch ANNOTATES.
   *  Replacing the body here would destroy real output. */
  it('augments rather than replaces — the original result survives intact', () => {
    const out = projectRunResultForAgent(ALL) as Record<string, unknown>;
    // ⛔ BOTH HALVES, OR THIS TEST IS VACUOUS. Asserting only that the original
    // fields survive is satisfied by a plain pass-through — i.e. by the very
    // defect this branch fixes. Caught by mutation: severing the branch left
    // this test GREEN until the annotation assertion was added.
    expect(out['status']).toBe('items_refused');
    expect(out['items_refused']).toBeDefined();
    expect(out['success']).toBe(true);
    expect(out['output']).toEqual({ summary: 'processed' });
    expect(out['recipe_id']).toBe('invoice-intake-watch');
    expect(out['errors']).toEqual([]);
    expect(Array.isArray(out['steps'])).toBe(true);
  });

  it('does not mutate the input', () => {
    projectRunResultForAgent(ALL);
    expect((ALL as unknown as Record<string, unknown>)['status']).toBeUndefined();
    expect((ALL as unknown as Record<string, unknown>)['items_refused']).toBeUndefined();
  });
});

describe('a partial refusal is a different sentence from a total one', () => {
  it('selects the partial message and leaves every_item false', () => {
    const out = projectRunResultForAgent(run([
      { id: 'stage_files', foreach: { items: 10, failed: 3 } },
    ])) as Record<string, unknown>;
    const detail = out['items_refused'] as Record<string, unknown>;
    expect(detail['every_item']).toBe(false);
    expect(detail['total_failed']).toBe(3);
    expect(out['message']).toBe(ITEMS_PARTIALLY_REFUSED_MESSAGE);
  });

  /** ⛔ `every_item` spans ALL foreach steps, not just the refusing one. Step A
   *  wrote 10 of 10; the run emphatically did NOT write nothing, and telling the
   *  model it did would be this projection's own false statement. */
  it('a fully-successful sibling step keeps every_item false', () => {
    const out = projectRunResultForAgent(run([
      { id: 'write_records', foreach: { items: 10, failed: 0 } },
      { id: 'notify', foreach: { items: 5, failed: 5 } },
    ])) as Record<string, unknown>;
    const detail = out['items_refused'] as Record<string, unknown>;
    expect(detail['total_items']).toBe(15);
    expect(detail['total_failed']).toBe(5);
    expect(detail['every_item']).toBe(false);
    // Only the refusing step is itemised — a clean step is not a finding.
    expect(detail['steps']).toEqual([{ step_id: 'notify', items: 5, failed: 5 }]);
  });

  it('sums across several refusing steps', () => {
    const out = projectRunResultForAgent(run([
      { id: 'a', foreach: { items: 4, failed: 4 } },
      { id: 'b', foreach: { items: 6, failed: 6 } },
    ])) as Record<string, unknown>;
    const detail = out['items_refused'] as Record<string, unknown>;
    expect(detail['total_items']).toBe(10);
    expect(detail['total_failed']).toBe(10);
    expect(detail['every_item']).toBe(true);
  });
});

describe('what it must NOT capture', () => {
  /** ⛔ THE PERMITTING WITNESS. Identity, not equality — without it this suite
   *  cannot tell an annotation from a projection that rewrites every run, and a
   *  gratuitous copy would break callers that compare by reference. */
  it('leaves an ordinary successful run untouched, BY REFERENCE', () => {
    const ok = run([{ id: 'write_records', foreach: { items: 10, failed: 0 } }]);
    expect(projectRunResultForAgent(ok)).toBe(ok);
  });

  it('leaves a run with no foreach steps at all untouched', () => {
    const ok = run([{ id: 'fetch', type: 'ingredient', skipped: false, error: null }]);
    expect(projectRunResultForAgent(ok)).toBe(ok);
  });

  it('leaves a run with no steps array untouched', () => {
    const odd = { recipe_id: 'x', success: true } as unknown as ExecuteResponse;
    expect(projectRunResultForAgent(odd)).toBe(odd);
  });

  /** ⚠ A tally whose counters are not numbers must be SKIPPED, never coerced —
   *  `NaN` totals would produce a confident, meaningless refusal report. */
  it('ignores a malformed tally instead of coercing it', () => {
    const odd = run([
      { id: 'a', foreach: { items: 'ten', failed: 'all' } },
      { id: 'b', foreach: null },
    ]);
    expect(projectRunResultForAgent(odd)).toBe(odd);
  });

  /** ⛔ A HELD RUN'S OWN INSTRUCTION WINS. "It is queued, do not resend" is the
   *  only thing that matters at a gate; a refusal tally alongside would compete
   *  with it, and the hold is checked first for exactly that reason. */
  it('does not annotate a run held for approval', () => {
    const held = run(
      [{ id: 'stage_files', foreach: { items: 10, failed: 10 } }],
      { awaiting_approval: true },
    );
    const out = projectRunResultForAgent(held) as Record<string, unknown>;
    expect(out['status']).toBe('awaiting_approval');
    expect(out['items_refused']).toBeUndefined();
  });

  /** ⛔ Same for the other stopped-run third states — a cancelled run's clean
   *  shape must not grow a tally from steps that ran before the kill. */
  it('does not annotate an owner-cancelled run', () => {
    const cancelled = run(
      [{ id: 'stage_files', foreach: { items: 10, failed: 10 } }],
      { run_terminated: 'killed' },
    );
    const out = projectRunResultForAgent(cancelled) as Record<string, unknown>;
    expect(out['status']).toBe('cancelled');
    expect(out['items_refused']).toBeUndefined();
  });
});

describe('the messages carry the posture the surrounding branches use', () => {
  it('⛔ the all-refused message forbids reporting it as done and names the cause', () => {
    expect(ITEMS_ALL_REFUSED_MESSAGE).toMatch(/NOTHING WAS WRITTEN/);
    expect(ITEMS_ALL_REFUSED_MESSAGE).toMatch(/do not report this as done/i);
    expect(ITEMS_ALL_REFUSED_MESSAGE).toMatch(/tell the user/i);
    expect(ITEMS_ALL_REFUSED_MESSAGE).toMatch(/do not repeat this exact call/i);
    // The recovery is the USER's — a permission or an unconfigured connection.
    expect(ITEMS_ALL_REFUSED_MESSAGE).toMatch(/permission|connection/i);
  });

  /** ⛔⛔ THE DUPLICATION CLAUSE IS THE LOAD-BEARING HALF OF THE PARTIAL COPY.
   *  A `foreach` create with no stable identity doubles the rows that already
   *  succeeded on every re-run, so "retry the failed ones" is the one piece of
   *  advice a model must not follow here. */
  it('⛔ the partial message forbids a blind retry on duplication grounds', () => {
    expect(ITEMS_PARTIALLY_REFUSED_MESSAGE).toMatch(/do not report the action as fully completed/i);
    expect(ITEMS_PARTIALLY_REFUSED_MESSAGE).toMatch(/how many/i);
    expect(ITEMS_PARTIALLY_REFUSED_MESSAGE).toMatch(/duplicate/i);
  });

  it('the two messages are distinct — "nothing happened" is not "half happened"', () => {
    expect(ITEMS_ALL_REFUSED_MESSAGE).not.toBe(ITEMS_PARTIALLY_REFUSED_MESSAGE);
  });
});

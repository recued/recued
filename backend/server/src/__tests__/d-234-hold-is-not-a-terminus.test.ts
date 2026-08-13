/** D-234 § 234.4 — a PEER hold is not a terminus either.
 *
 *  ⛔⛔ THE HOLE THIS CLOSES OPENED THE MOMENT `awaiting_peer` EXISTED, and no
 *  test would have found it: D-232 rule 3 said "a hold is not a terminus" and
 *  named exactly one way to be held. A recipe that asks a peer mid-run AND
 *  declares `output.exchange` would, while SUSPENDED, have fired its terminal
 *  exchange — sending a conclusion drawn from an answer nobody has given yet,
 *  and then sending it AGAIN on resume. Two letters, the first of them a
 *  fabrication, both reported as success. */
import { describe, expect, it } from 'vitest';

import { fireExchangeOutput } from '@recued/engine';

const ctx = {
  recipe: {
    recipe_id: 'r',
    output: { exchange: { ref: 'ref_1', deliver_to: 'recued-core/somewhere' } },
  },
  stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
  // ⚠ Deliberately present: if the guard failed, this WOULD be called, and the
  // test would see the fabricated send rather than an absence.
  exchangeFireHandler: async () => {
    throw new Error('the exchange fired from a HELD run');
  },
};

const result = (over: Record<string, unknown>) => ({
  recipe_id: 'r', recipe_hash: 'h', success: false, output: { render: [] },
  steps: [], errors: [], duration_ms: 1, validation_issues: [], ...over,
});

describe('§ 234.4 — rule 3 covers both holds', () => {
  it('does not fire while held for a PEER', async () => {
    const out = await fireExchangeOutput(ctx as never, result({
      awaiting_peer: { gated_step_id: 's', step_state: {}, exchange_ref: 'x',
                       spec: { connection: 'c', label: 'l', question: 'q',
                               options: [{ id: 'a', label: 'A' }], on_timeout: 'wait' } },
    }) as never);
    expect(out.errors).toEqual([]);
  });

  it('still does not fire while held for an APPROVAL', async () => {
    const out = await fireExchangeOutput(ctx as never, result({
      awaiting_approval: { gated_step_id: 's', step_state: {} },
    }) as never);
    expect(out.errors).toEqual([]);
  });

  it('⚠ and DOES fire on a finished run — the guard is not just always-true', async () => {
    // Without this the two assertions above pass on a `fireExchangeOutput` that
    // never fires at all, which is the vacuous-green shape.
    const out = await fireExchangeOutput(ctx as never, result({ success: true }) as never);
    expect(JSON.stringify(out.errors)).toContain('fired from a HELD run');
  });
});

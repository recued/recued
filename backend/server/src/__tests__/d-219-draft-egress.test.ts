/** D-219 item 2b — the owner's request, made safe to hand an authoring model.
 *
 *  Recued aliases user content on both its existing LLM boundaries. Drafting a
 *  recipe is a third, and these pin that it behaves like the other two — plus
 *  the two places it must NOT, both of which are inversions of a sibling.
 */

import { describe, expect, it, vi } from 'vitest';
import { piiEgress } from '@recued/gateway';

import {
  aliasCasePromptForAuthoring,
  DRAFT_EGRESS_MAX_ROWS,
  type CaseDraftEgressDeps,
} from '../execution-case-draft-egress.js';

const PROMPT = 'email Delphine Rowntree the quarterly report';

const deps = (over: Partial<CaseDraftEgressDeps> = {}): CaseDraftEgressDeps => ({
  harvest: (async () => ({
    rows: [{
      candidates: [
        { value: 'Delphine Rowntree', kind: 'name' as const },
      ],
    }],
  })) as unknown as CaseDraftEgressDeps['harvest'],
  ledgers: piiEgress.createSessionLedgerStore(),
  ...over,
});

describe('D-219 — the request reaches the authoring model aliased', () => {
  it('replaces a name the session attested, and says it aliased', async () => {
    const result = await aliasCasePromptForAuthoring(
      deps(), { session_id: 's1', prompt: PROMPT },
    );
    expect(result.aliased).toBe(true);
    // ⛔ The real name is gone…
    expect(result.prompt).not.toMatch(/delphine|rowntree/iu);
    // …and something stands in its place, so this cannot pass against a build
    // that simply emptied the string.
    expect(result.prompt).toMatch(/pii\./u);
    // The INTENT survives, which is the whole point — the model needs it.
    expect(result.prompt).toContain('quarterly report');
  });

  it('🔑 leaves an alias where a VARIABLE belongs', async () => {
    // Not incidental. A model reading `email pii.Person1 the quarterly report`
    // has been handed the strongest possible cue that the recipient is a
    // PARAMETER — which is exactly the `{{config.*}}` variable it should
    // declare. Privacy and recipe quality point the same way here.
    const result = await aliasCasePromptForAuthoring(
      deps(), { session_id: 's1', prompt: PROMPT },
    );
    expect(result.prompt.startsWith('email pii.')).toBe(true);
  });

  it('harvests the session\'s OWN rows, within the declared bounds', async () => {
    // ⚠ X1 governs the PII layer reading OTHER sessions. The ledger, the
    // harvest and the text are all one session here, which is the same
    // own-session read the slot-ordering seeder already performs.
    const harvest = vi.fn(
      async (_input: { session_id: string; max_rows: number }) =>
        ({ rows: [] }),
    );
    await aliasCasePromptForAuthoring(
      deps({ harvest: harvest as never }),
      { session_id: 's-target', prompt: PROMPT },
    );
    expect(harvest).toHaveBeenCalledTimes(1);
    expect(harvest.mock.calls[0]![0]).toMatchObject({
      session_id: 's-target',
      max_rows: DRAFT_EGRESS_MAX_ROWS,
    });
  });

  it('seeds the numbering so an alias means the same person as in the transcript', async () => {
    const seedSlotOrdering = vi.fn(
      async (_ledger: unknown, _session_id: string) => {},
    );
    await aliasCasePromptForAuthoring(
      deps({ seedSlotOrdering }), { session_id: 's1', prompt: PROMPT },
    );
    expect(seedSlotOrdering).toHaveBeenCalledTimes(1);
    expect(seedSlotOrdering.mock.calls[0]![1]).toBe('s1');
  });
});

describe('D-219 — the two inversions', () => {
  it('⛔ FAILS CLOSED when the harvest fails — never the raw text', async () => {
    // ⛔⛔ THE INVERSION. `createChatPiiSlotOrderingSeeder` fails OPEN by
    // design: an unseeded ledger degrades legibility and gates no leak. Here
    // the harvest IS the protection, so "we could not tell which spans are
    // personal" must never resolve to "send it anyway".
    for (const harvest of [
      (async () => { throw new Error('vault locked'); }),
      (async () => { throw new Error('store gone'); }),
    ]) {
      const result = await aliasCasePromptForAuthoring(
        deps({ harvest: harvest as never }),
        { session_id: 's1', prompt: PROMPT },
      );
      expect(result.aliased).toBe(false);
      expect(result.prompt).toBe('');
      expect(result.prompt).not.toMatch(/delphine|rowntree/iu);
    }
    // The permitting witness: a WORKING harvest still yields the text, so this
    // cannot pass against a build that returns nothing unconditionally.
    const ok = await aliasCasePromptForAuthoring(
      deps(), { session_id: 's1', prompt: PROMPT },
    );
    expect(ok.aliased).toBe(true);
    expect(ok.prompt.length).toBeGreaterThan(0);
  });

  it('⛔ never restores — the draft must not carry a real value back', async () => {
    // The chat path restores aliases before anything durable sees them. Here
    // that is the defect: a restored draft bakes a real address into a recipe
    // the owner then SAVES. The module has no restore path at all, which is the
    // structural version of this claim — asserted on the returned text, which
    // is the only thing that leaves.
    const result = await aliasCasePromptForAuthoring(
      deps(), { session_id: 's1', prompt: PROMPT },
    );
    expect(result.prompt).not.toContain('Delphine');
    // …and asking twice does not resolve it either.
    const again = await aliasCasePromptForAuthoring(
      deps(), { session_id: 's1', prompt: result.prompt },
    );
    expect(again.prompt).not.toMatch(/delphine|rowntree/iu);
  });

  it('an empty request is aliased-by-vacuity, not a failure', async () => {
    const result = await aliasCasePromptForAuthoring(
      deps(), { session_id: 's1', prompt: '   ' },
    );
    expect(result).toEqual({ prompt: '', aliased: true });
  });
});

describe('D-219 — a PARTIAL harvest is a failure, not a weaker success', () => {
  it('⛔ fails closed when the scan was truncated', async () => {
    // ⛔⛔ CODEX FOUND THIS, AND MY OWN TESTS MISSED IT because they only
    // exercised a THROWN harvest. A scan truncated at 256 rows / 1 MiB / 250 ms
    // — or one whose row failed finalization — RETURNS SUCCESSFULLY with that
    // row's candidates absent. The aliaser is seed-driven with no fresh-value
    // discovery, so an unlisted address is simply not aliased: the request went
    // out byte-for-byte RAW while reporting `aliased: true`.
    //
    // The store's own contract names the rule: a cutoff "weakens enhancement
    // coverage but NEVER MAKES RETURNED RAW BYTES ELIGIBLE FOR EGRESS".
    const result = await aliasCasePromptForAuthoring(
      deps({
        harvest: (async () => ({
          // Note the candidate IS present — this is not a no-match case. The
          // point is that a partial scan cannot vouch for what it did NOT read.
          rows: [{ candidates: [{ value: 'Delphine Rowntree', kind: 'name' }] }],
          partial: true,
        })) as never,
      }),
      { session_id: 's1', prompt: PROMPT },
    );
    expect(result.aliased).toBe(false);
    expect(result.prompt).toBe('');
  });

  it('the permitting witness: a COMPLETE harvest still aliases and returns', async () => {
    // Without this the test above passes against a build that refuses
    // everything — which would silently disable the whole feature.
    const result = await aliasCasePromptForAuthoring(
      deps({
        harvest: (async () => ({
          rows: [{ candidates: [{ value: 'Delphine Rowntree', kind: 'name' }] }],
          partial: false,
        })) as never,
      }),
      { session_id: 's1', prompt: PROMPT },
    );
    expect(result.aliased).toBe(true);
    expect(result.prompt).not.toMatch(/delphine|rowntree/iu);
    expect(result.prompt).toMatch(/pii\./u);
  });
});

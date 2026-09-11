/** D-202 × D-261 — an ask answered inside a pre-approved run trains nothing.
 *
 *  ⛔ WHY THIS IS A RULE AND NOT A PREFERENCE. The learner's own justification is
 *  that these are "precisely the asks a quality delegation would remove, so the
 *  owner's own reviews are the non-circular learning signal". That holds for a
 *  manual run, where the owner meets the ask cold. It does not hold inside a
 *  D-261 execution they have ALREADY approved: the covered members are going to
 *  fire either way, and the only thing left to answer is an uncovered call in
 *  the middle of a run they have committed to. That is approval under momentum —
 *  a different distribution from the ask the delegation would later suppress.
 *
 *  🔑 THE LEAK IS CONCRETE. Signals key on `(recipe, ingredient, operation)` —
 *  the same grain `quality-gate-resolver` matches on — so an approve earned in
 *  the pre-approved frame helps mint a standing delegation that then
 *  auto-accepts that pair in MANUAL runs. Approval given in the easy frame would
 *  buy silence in the hard one.
 *
 *  Tested at the capture function rather than through the resumer: the guard
 *  lives here, and `preflight-resumer` fail-closes on a preapproval-bound
 *  checkpoint without a wired runtime, which is a different property. The e2e
 *  file already proves the resumer calls this. */

import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import type { AuditEntry } from '@recued/storage';

import { captureQualityDelegationSignal } from '../quality-delegation-signal-capture.js';
import type { QualityDelegationSignalStore } from '../storage/quality-delegation-signal-store.js';

const NOW = 1_760_000_000_000;

const store = () => {
  const rows: unknown[] = [];
  return { rows, store: { append: (signal: unknown) => { rows.push(signal); } } as unknown as QualityDelegationSignalStore };
};

const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'cp-1', run_id: 'run-1', recipe_id: 'send-thank-you-email',
  gated_step_id: 'send', approved_target: { ingredient_slug: 'recued-core/mail-send' },
  step_state: {}, quality_relevant: true, created_at: NOW, ...over,
} as Checkpoint);

const anchor = { recipe_id: 'send-thank-you-email', recipe_hash: 'rh-1',
  channel_session_id: 'chat:sess-A' } as unknown as AuditEntry;

describe('a pre-approved run does not train the quality learner', () => {
  /** The control. Without it, every assertion below could pass because the
   *  fixture never records anything at all. */
  it('records a signal for an ORDINARY ask — the control', () => {
    const { rows, store: signalStore } = store();
    captureQualityDelegationSignal({ signalStore }, { checkpoint: checkpoint(), anchor, outcome: 'approve', at: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'quality_good', ingredient_id: 'recued-core/mail-send' });
  });

  it('records nothing when the checkpoint is bound to a reviewed execution', () => {
    const { rows, store: signalStore } = store();
    captureQualityDelegationSignal({ signalStore },
      { checkpoint: checkpoint({ preapproval_execution_ref: 'pae_1' }), anchor, outcome: 'approve', at: NOW });
    expect(rows).toEqual([]);
  });

  /** ⚠ DENIES ARE EXCLUDED TOO, deliberately. A reject inside a committed run is
   *  arguably a STRONGER signal than an ordinary one — but the defect is mixing
   *  two distributions, not the sign of either, and a rule that keeps whichever
   *  half looks convenient is not a rule. */
  it('records nothing on deny either', () => {
    const { rows, store: signalStore } = store();
    captureQualityDelegationSignal({ signalStore },
      { checkpoint: checkpoint({ preapproval_execution_ref: 'pae_1' }), anchor, outcome: 'reject', at: NOW });
    expect(rows).toEqual([]);
  });

  /** The auto-run candidate half of the same binding — a poll that has claimed
   *  its group is just as committed as a claimed run. */
  it('records nothing for a pre-approval candidate poll', () => {
    const { rows, store: signalStore } = store();
    captureQualityDelegationSignal({ signalStore },
      { checkpoint: checkpoint({ preapproval_candidate_ref: 'pac_1' }), anchor, outcome: 'approve', at: NOW });
    expect(rows).toEqual([]);
  });
});

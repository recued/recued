/** D-234 § 234.4 — the inbound door, composed: admit → raise → record. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { peerLabelGrantEntry } from '@recued/contracts';

import { receivePeerAsk } from '../peer-ask-inbound.js';
import type { InboundPeerAsk } from '../peer-ask-receiver.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore } from '../storage/contract-store.js';

/** D-234 § 234.4j — the one gate: `peer.label.<label>` on the caller's contract.
 *  The real store, so the KEY derivation is under test and not assumed. */
const labelGrant = (open = true) => {
  const store = createContractGrantEntryStore(createContractStore(new Database(':memory:')));
  if (open) store.set('ctr_alice', peerLabelGrantEntry('review'), true, 1);
  return (c: string, l: string) => store.get(c, peerLabelGrantEntry(l)) === true;
};

const ask = (over: Partial<InboundPeerAsk> = {}): InboundPeerAsk => ({
  peer_contract_id: 'ctr_alice',
  connection_name: 'peer-alice',
  exchange_ref: 'ref_1',
  label: 'review',
  question: 'Approve this?',
  options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
  ...over,
});

const harness = (open = true) => {
  const rows: { action: string; target: string; detail: string }[] = [];
  return {
    rows,
    deps: {
      isLabelGranted: labelGrant(open),
      notifier: { ask: vi.fn(async () => ({ ask_id: 'ask_7' })) },
      logActivity: (r: { action: string; target: string; detail: string }) => { rows.push(r); },
    },
  };
};

describe('§ 234.4 — the inbound door', () => {
  it('raises the ask and records it', async () => {
    const h = harness();
    const out = await receivePeerAsk(ask(), h.deps);

    expect(out).toEqual({ accepted: true, ask_id: 'ask_7' });
    expect(h.deps.notifier.ask).toHaveBeenCalledTimes(1);
    expect(h.rows.map((r) => r.action)).toEqual(['peer_ask_received']);
    expect(h.rows[0]!.target).toBe('ctr_alice/review');
  });

  it('⛔ AN UNEXPOSED PEER RAISES NOTHING — and is still recorded', async () => {
    // The refusal row is the one that matters most: "someone tried to reach me
    // and was turned away" is where an investigation starts, and it is exactly
    // the row an attacker would prefer went unwritten.
    const h = harness(false);
    const out = await receivePeerAsk(ask(), h.deps);

    expect(out).toMatchObject({ accepted: false, refusal: 'not_exposed' });
    expect(h.deps.notifier.ask).not.toHaveBeenCalled();
    expect(h.rows.map((r) => r.action)).toEqual(['peer_ask_refused']);
  });

  it('⛔ RAISES BEFORE IT RECORDS — a failed raise records nothing received', async () => {
    // Writing `peer_ask_received` before the ask exists would record a question
    // nobody was ever shown, and the caller would be told it landed.
    const h = harness();
    h.deps.notifier.ask = vi.fn(async () => { throw new Error('channel down'); });
    await expect(receivePeerAsk(ask(), h.deps)).rejects.toThrow(/channel down/);
    expect(h.rows).toEqual([]);
  });

  it('⛔⛔ A LEDGER FAILURE DOES NOT CHANGE THE ANSWER TO THE PEER', async () => {
    // The ask is already durable and on the owner's screen by this point. The
    // first cut let the ledger write throw, so an ADMITTED, RAISED question came
    // back to the asker as an error — they would have asked again while their
    // correspondent was already looking at it.
    //
    // ⚠ AND THE FIRST VERSION OF THIS TEST ASSERTED THE THROW, i.e. wrote the bug
    // down as the contract. The comment on `logActivity` said best-effort and the
    // code disagreed; re-expecting the test to the observed behaviour would have
    // made the disagreement permanent and invisible.
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await receivePeerAsk(ask(), {
      ...h.deps,
      logActivity: () => { throw new Error('ledger full'); },
    });
    expect(out).toEqual({ accepted: true, ask_id: 'ask_7' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/** D-234 § 234.4 — the inbound door, composed: admit → raise → record. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { peerLabelGrantEntry } from '@recued/contracts';

import { receivePeerAsk, type PeerAskInboundDeps } from '../peer-ask-inbound.js';
import type { InboundPeerAsk } from '../peer-ask-receiver.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createPeerAskInboxStore } from '../storage/peer-ask-inbox-store.js';

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
  const inbox = createPeerAskInboxStore(new Database(':memory:'));
  const notifierAsk = vi.fn<PeerAskInboundDeps['notifier']['ask']>(
    async () => ({ ask_id: 'ask_7' }),
  );
  return {
    rows,
    deps: {
      isLabelGranted: labelGrant(open),
      notifier: { ask: notifierAsk },
      inbox,
      mintAskId: () => 'ask_7',
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

  it('marks the reciprocal inbox raised at the notifier persistence boundary', async () => {
    const h = harness();
    h.deps.notifier.ask = vi.fn(async (
      _message,
      _options,
      _handler,
      _channels,
      extras,
    ) => {
      expect(h.deps.inbox.get('ctr_alice', 'ref_1')).toMatchObject({ state: 'reserved' });
      await extras?.on_persisted?.('ask_7');
      expect(h.deps.inbox.get('ctr_alice', 'ref_1')).toMatchObject({ state: 'raised' });
      return { ask_id: 'ask_7' };
    });

    await expect(receivePeerAsk(ask(), h.deps))
      .resolves.toEqual({ accepted: true, ask_id: 'ask_7' });
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

  it('replays one accepted exchange without raising a second owner ask', async () => {
    const h = harness();

    await expect(receivePeerAsk(ask(), h.deps))
      .resolves.toEqual({ accepted: true, ask_id: 'ask_7' });
    await expect(receivePeerAsk(ask(), h.deps))
      .resolves.toEqual({ accepted: true, ask_id: 'ask_7' });

    expect(h.deps.notifier.ask).toHaveBeenCalledTimes(1);
    expect(h.rows.map((row) => row.action)).toEqual(['peer_ask_received']);
  });

  it('reuses a pre-raise reservation after a crash instead of minting again', async () => {
    const h = harness();
    const input = ask();
    const { peerAskRequestFingerprint } = await import('../peer-ask-inbound.js');
    h.deps.inbox.reserve({
      peer_contract_id: input.peer_contract_id,
      exchange_ref: input.exchange_ref,
      request_fingerprint: peerAskRequestFingerprint(input),
      connection_name: input.connection_name,
      ask_id: 'ask_reserved',
      created_at: 1,
    });
    const notifier = {
      ask: vi.fn<PeerAskInboundDeps['notifier']['ask']>(
        async () => ({ ask_id: 'ask_reserved' }),
      ),
    };

    await expect(receivePeerAsk(
      { ...input, connection_name: 'peer-alice-renamed-locally' },
      { ...h.deps, notifier },
    ))
      .resolves.toEqual({ accepted: true, ask_id: 'ask_reserved' });
    expect(notifier.ask).toHaveBeenCalledOnce();
    expect(notifier.ask.mock.calls[0]?.[0]).toMatchObject({
      text: 'peer-alice asks: Approve this?',
    });
    expect((notifier.ask.mock.calls[0] as unknown[] | undefined)?.[4]).toMatchObject({
      reserved_ask_id: 'ask_reserved',
    });
  });

  it('renders the first-writer connection name when another process wins reservation', async () => {
    const h = harness();
    const input = ask();
    const { peerAskRequestFingerprint } = await import('../peer-ask-inbound.js');
    const durableInbox = h.deps.inbox;
    durableInbox.reserve({
      peer_contract_id: input.peer_contract_id,
      exchange_ref: input.exchange_ref,
      request_fingerprint: peerAskRequestFingerprint(input),
      connection_name: 'peer-alice-first-writer',
      ask_id: 'ask_first_writer',
      created_at: 1,
    });
    let firstRead = true;
    const racedInbox = {
      get(peerContractId: string, exchangeRef: string) {
        if (firstRead) {
          firstRead = false;
          return null;
        }
        return durableInbox.get(peerContractId, exchangeRef);
      },
      reserve: durableInbox.reserve,
      markRaised: durableInbox.markRaised,
    };
    const notifier = {
      ask: vi.fn<PeerAskInboundDeps['notifier']['ask']>(
        async () => ({ ask_id: 'ask_first_writer' }),
      ),
    };

    await expect(receivePeerAsk(
      { ...input, connection_name: 'peer-alice-racing-writer' },
      { ...h.deps, inbox: racedInbox, notifier },
    )).resolves.toEqual({ accepted: true, ask_id: 'ask_first_writer' });

    expect(notifier.ask.mock.calls[0]?.[0]).toMatchObject({
      text: 'peer-alice-first-writer asks: Approve this?',
    });
  });

  it('joins a concurrent accepted reservation instead of returning a revoked-grant refusal', async () => {
    const h = harness(false);
    const input = ask();
    const { peerAskRequestFingerprint } = await import('../peer-ask-inbound.js');
    const durableInbox = h.deps.inbox;
    durableInbox.reserve({
      peer_contract_id: input.peer_contract_id,
      exchange_ref: input.exchange_ref,
      request_fingerprint: peerAskRequestFingerprint(input),
      connection_name: input.connection_name,
      ask_id: 'ask_concurrent_winner',
      created_at: 1,
    });
    let reads = 0;
    const racedInbox = {
      get(peerContractId: string, exchangeRef: string) {
        reads += 1;
        return reads === 1 ? null : durableInbox.get(peerContractId, exchangeRef);
      },
      reserve: durableInbox.reserve,
      markRaised: durableInbox.markRaised,
    };
    const notifier = {
      ask: vi.fn<PeerAskInboundDeps['notifier']['ask']>(
        async () => ({ ask_id: 'ask_concurrent_winner' }),
      ),
    };

    await expect(receivePeerAsk(input, {
      ...h.deps,
      inbox: racedInbox,
      notifier,
    })).resolves.toEqual({ accepted: true, ask_id: 'ask_concurrent_winner' });

    expect(notifier.ask).toHaveBeenCalledOnce();
    expect(h.rows.map((row) => row.action)).toEqual(['peer_ask_received']);
  });

  it('refuses reuse of an exchange ref for different question content', async () => {
    const h = harness();
    await receivePeerAsk(ask(), h.deps);

    const out = await receivePeerAsk(ask({ question: 'A different question?' }), h.deps);

    expect(out).toMatchObject({ accepted: false, refusal: 'exchange_conflict' });
    expect(h.deps.notifier.ask).toHaveBeenCalledTimes(1);
  });
});

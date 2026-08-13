/** D-234 § 234.4 slice 4 — the receiving side of a remote hold.
 *
 *  A peer's question becomes a durable ask on this server, or it becomes a
 *  refusal. Nothing else happens: no recipe runs, no checkpoint is minted, no
 *  data is read. The surface is small on purpose, so the tests are about the two
 *  things that can go wrong — who gets through the door, and what the card
 *  carries once they do. */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  PEER_ASK_OPTIONS_MAX,
  PEER_ASK_QUESTION_MAX,
  peerLabelGrantEntry,
} from '@recued/contracts';

import {
  PEER_ASK_HANDLER_KIND,
  admitPeerAsk,
  peerAskLedgerTarget,
  type InboundPeerAsk,
} from '../peer-ask-receiver.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore } from '../storage/contract-store.js';

/** D-234 § 234.4j — the label grants an owner has written, read the way the door
 *  reads them. Was a `peer_exposures` store until § 234.4j; the properties below
 *  are unchanged because the QUESTION is unchanged — only the store that answers
 *  it moved onto the peer's own contract.
 *
 *  ⚠ THE REAL GRANT STORE, NOT A PREDICATE DOUBLE, because the thing most likely
 *  to break here is the KEY: a door reading `peer.label.x` against rows written
 *  as `label.x` admits nobody, and a hand-rolled `(c, l) => set.has(...)` double
 *  would pass on both spellings. `peerLabelGrantEntry` is the one derivation. */
const granted = (pairs: [string, string][] = [['ctr_alice', 'review:contract']]) => {
  const store = createContractGrantEntryStore(createContractStore(new Database(':memory:')));
  for (const [c, l] of pairs) store.set(c, peerLabelGrantEntry(l), true, 1);
  const check = (c: string, l: string) => store.get(c, peerLabelGrantEntry(l)) === true;
  return Object.assign(check, {
    // ⛔ REVOKE WRITES `false`, IT DOES NOT DELETE. The three-state read
    // (undefined / true / false) is what keeps an owner's explicit "no" from
    // being re-seeded by the boot reconcile, so the off-switch has to be a row.
    revoke: (c: string, l: string) => store.set(c, peerLabelGrantEntry(l), false, 2),
  });
};

const ask = (over: Partial<InboundPeerAsk> = {}): InboundPeerAsk => ({
  peer_contract_id: 'ctr_alice',
  connection_name: 'peer-alice',
  exchange_ref: 'ref_1',
  label: 'review:contract',
  question: 'Does the Friday deadline read as too firm?',
  options: [{ id: 'approved', label: 'Approve' }, { id: 'rejected', label: 'Reject' }],
  ...over,
});

describe('§ 234.4 — who gets through the door', () => {
  it('admits a granted peer under the granted label', () => {
    const r = admitPeerAsk(ask(), granted());
    expect(r.admitted).toBe(true);
  });

  it('⛔ DEFAULT CLOSED — an ungranted peer raises NOTHING', () => {
    const r = admitPeerAsk(ask(), granted([]));
    expect(r).toMatchObject({ admitted: false, refusal: 'not_exposed' });
  });

  it('⛔ the label is a CAPABILITY, not a category', () => {
    // Granting contract reviews must not grant payroll ones. Exact match or
    // nothing — the whole reason the label is free-form rather than a registry.
    const r = admitPeerAsk(ask({ label: 'review:payroll' }), granted());
    expect(r).toMatchObject({ admitted: false, refusal: 'not_exposed' });
  });

  it('⛔ a DIFFERENT peer cannot borrow a grant', () => {
    const r = admitPeerAsk(ask({ peer_contract_id: 'ctr_mallory' }), granted());
    expect(r).toMatchObject({ admitted: false, refusal: 'not_exposed' });
  });

  it('⛔⛔ THE DOOR IS CHECKED BEFORE THE PAYLOAD — a refusal must not leak shape', () => {
    // An ungranted caller sending garbage learns only that it is ungranted. If
    // validation ran first, the refusal would tell a stranger which fields this
    // server wants and how long they may be — a free probing surface, handed out
    // to exactly the callers who should learn nothing.
    const r = admitPeerAsk(
      ask({ question: '', options: [], exchange_ref: '' }),
      granted([]),
    );
    expect(r).toMatchObject({ admitted: false, refusal: 'not_exposed' });
    expect((r as { reason: string }).reason).not.toMatch(/required|option|character/i);
  });

  it('says the same thing for never-granted and for revoked', () => {
    // ⚠ A KNOWN LIMITATION, PINNED SO IT IS NOT MISTAKEN FOR WORKING. § 234.4
    // wants a revoke distinguishable on the wire so a stale catalog self-heals
    // rather than retrying blindly. A revoked grant IS a distinct row (`false`,
    // not absent) so the receiver could tell them apart — but the refusal it
    // sends deliberately does not, because that distinction is exactly what a
    // stranger probing for valid labels wants. Needs a signal the ASKER can trust
    // without handing one to everyone else; deferred.
    // ⚠ COMPARE LIKE WITH LIKE — the first version of this test compared a
    // refusal for `review:payroll` against one for `review:contract` and failed,
    // because the message names the label. That was the TEST being wrong, and it
    // was worth having: the property is that for ONE label, never-exposed and
    // revoked are indistinguishable, which needs two stores rather than two
    // labels.
    const neverGranted = granted([]);
    const revoked = granted();
    revoked.revoke('ctr_alice', 'review:contract');
    expect(revoked('ctr_alice', 'review:contract'), 'revoke did not take').toBe(false);

    const a = admitPeerAsk(ask(), neverGranted) as { reason: string };
    const b = admitPeerAsk(ask(), revoked) as { reason: string };
    expect(b.reason).toBe(a.reason);
  });
});

describe('§ 234.4 — what the card carries', () => {
  const admitted = (over: Partial<InboundPeerAsk> = {}) => {
    const r = admitPeerAsk(ask(over), granted());
    if (!r.admitted) throw new Error(`expected admission, got ${r.refusal}: ${r.reason}`);
    return r;
  };

  it('attributes the question to the peer, verbatim', () => {
    // An unattributed question read on a phone is indistinguishable from one
    // this server generated itself.
    const r = admitted();
    expect(r.message.text).toContain('peer-alice asks:');
    expect(r.message.text).toContain('Does the Friday deadline read as too firm?');
  });

  it('⛔⛔ RENDERS THE DEADLINE — the field an invented property silently ate', () => {
    // The first cut put this in `text_suffix`, which is NOT a field of
    // `NotificationMessage` ({ title?, text, link_url? }). It typechecked only
    // because the object carried a whole-object `as NotificationMessage` cast,
    // which suppresses the excess-property check. Every card would have shipped
    // without the date the asker promised to act on, and nothing would have said
    // so. This assertion is the thing that would have caught it.
    const at = Date.parse('2026-08-14T00:00:00.000Z');
    expect(admitted({ deadline_at: at }).message.text).toContain('2026-08-14');
  });

  it('omits the deadline line entirely when there is none', () => {
    expect(admitted().message.text).not.toMatch(/Needed by/);
  });

  it('offers exactly the peer\'s options', () => {
    expect(admitted().options).toEqual([
      { id: 'approved', label: 'Approve' },
      { id: 'rejected', label: 'Reject' },
    ]);
  });

  it('⛔ THE HANDLER PAYLOAD IS CORRELATION ONLY — no question, no options', () => {
    // This row sits in the ask store for as long as the owner takes to answer,
    // and the ask id IS a bearer capability travelling through Slack / Telegram
    // / WhatsApp. Anything in the payload becomes readable by whoever holds the
    // link.
    const r = admitted();
    expect(r.handler.kind).toBe(PEER_ASK_HANDLER_KIND);
    expect(Object.keys(r.handler.payload).sort())
      .toEqual(['exchange_ref', 'label', 'peer_contract_id']);
    expect(JSON.stringify(r.handler.payload)).not.toContain('Friday');
  });
});

describe('§ 234.4 — a malformed payload from an ADMITTED peer', () => {
  const refuse = (over: Partial<InboundPeerAsk>) =>
    admitPeerAsk(ask(over), granted()) as { admitted: false; refusal: string; reason: string };

  it('refuses an empty question, ref, or option set', () => {
    expect(refuse({ question: '   ' }).refusal).toBe('malformed');
    expect(refuse({ exchange_ref: '' }).refusal).toBe('malformed');
    expect(refuse({ options: [] }).refusal).toBe('malformed');
  });

  it('bounds what the far side may put on the owner\'s screen', () => {
    // The peer wrote this and it travels through every messenger channel; a
    // verbose or hostile correspondent is otherwise unbounded.
    expect(refuse({ question: 'x'.repeat(PEER_ASK_QUESTION_MAX + 1) }).refusal)
      .toBe('malformed');
    expect(refuse({
      options: Array.from({ length: PEER_ASK_OPTIONS_MAX + 1 }, (_, i) => ({
        id: `o${i}`, label: `O${i}`,
      })),
    }).refusal).toBe('malformed');
  });

  it('refuses duplicate option ids — the answer would be ambiguous', () => {
    expect(refuse({
      options: [{ id: 'yes', label: 'Approve' }, { id: 'yes', label: 'Reject' }],
    }).reason).toMatch(/duplicate/);
  });

  it('refuses an on_timeout it does not know', () => {
    expect(refuse({ on_timeout: 'nag_forever' }).refusal).toBe('malformed');
  });
});

describe('§ 234.4 — the ledger target', () => {
  it('is stable across the ask\'s whole life', () => {
    // One grep answers "what has this peer asked me, and what did I say" —
    // which is the months-later question the reserve class exists to protect.
    expect(peerAskLedgerTarget('ctr_alice', 'review:contract'))
      .toBe('ctr_alice/review:contract');
  });
});


describe('D-234 § 234.4h/j — the label lives on the CONTRACT, and only there', () => {
  const inbound = {
    peer_contract_id: 'ctr_alice',
    connection_name: 'peer-alice',
    exchange_ref: 'ref-h',
    label: 'review:draft',
    question: 'Does this read as too firm?',
    options: [{ id: 'yes', label: 'Yes' }],
  };

  it('admits on the GRANT alone — no pack, no recipe, no second store', () => {
    // ⛔ THE POINT OF § 234.4h. Before it, opting in meant installing
    // `peer-exchange-out` for one recipe whose whole job was to write one row —
    // which contradicted § 234.4's headline "the receiver installs nothing".
    // § 234.4j then deleted that row's store entirely: this is now the only way
    // a peer is admitted, so there is no second path to keep in step.
    const v = admitPeerAsk(inbound, (c, l) => c === 'ctr_alice' && l === 'review:draft');
    expect(v.admitted).toBe(true);
  });

  it('⛔ MATCHED EXACTLY — a near-miss label is not a grant', () => {
    const v = admitPeerAsk(inbound, (_c, l) => l === 'review:drafts');
    expect(v).toMatchObject({ admitted: false, refusal: 'not_exposed' });
  });

  it('⛔ AND KEYED ON THE CALLER — another peer\'s grant is not yours', () => {
    const v = admitPeerAsk(inbound, (c) => c === 'ctr_mallory');
    expect(v).toMatchObject({ admitted: false, refusal: 'not_exposed' });
  });

  it('⛔ ONLY `true` ADMITS — a three-state read cannot be coerced', () => {
    // The grant store answers undefined / true / false, and the door compares
    // against `true` rather than testing truthiness. A checker that leaks
    // anything else through would admit on a row that says NO.
    for (const answer of [undefined, false, null, 0, '', 'true'] as unknown[]) {
      const v = admitPeerAsk(inbound, (() => answer) as never);
      expect(v, `admitted on ${JSON.stringify(answer)}`).toMatchObject({ admitted: false });
    }
  });
});

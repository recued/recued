/** D-234 § 234.4 — the return leg's SENDING half, which had no test at all.
 *
 *  ⛔⛔ THE FILE NEXT TO THIS ONE COVERS `receiveAnswer` NINE WAYS AND
 *  `sendPeerAnswerHome` ZERO. Both halves live in `peer-answer-return.ts`, both
 *  are exported from it, and the suite named after it reads only the door. So
 *  the half that makes a NETWORK CALL — the half where transient failure is the
 *  norm rather than the exception — was the untested one, and the defect below
 *  survived in it.
 *
 *  🔑 THE DEFECT: a refusal came back as an ordinary RESULT and was read as a
 *  delivery. `receiveAnswer` answers `{accepted:false, refusal}` as content, on
 *  purpose (an error envelope would make "not yours" and "the server fell over"
 *  the same fact). `sendPeerAnswerHome` wrapped the call in a `try` and treated
 *  "did not throw" as arrival — so an owner's decision could be refused at the
 *  far door and filed here as `peer_ask_answered`. The § 234.4n withdrawal
 *  notice had already found and fixed exactly this, one file over, on this same
 *  wire: *"A refusal is a RESULT, not an error envelope, and enumerating
 *  refusals is how you miss the next one: assert the POSITIVE."*
 *
 *  ⚠ These assert on the ACTIVITY ROW as well as on the throw, because the two
 *  outcomes that must not be confused — "refused, and no retry will fix it" and
 *  "delivered" — are distinguishable only there. A test that checked the throw
 *  alone would pass on a version that recorded every refusal as a delivery. */
import { describe, expect, it } from 'vitest';

import { sendPeerAnswerHome } from '../peer-answer-return.js';

const PEER = 'ctr_bob';
const REF = 'ref-send-1';

const harness = (reply: unknown | (() => never)) => {
  const activity: { action: string; target: string; detail: string }[] = [];
  const sent: Record<string, unknown>[] = [];
  return {
    activity,
    sent,
    deps: {
      connectionForContract: (c: string) => (c === PEER ? 'peer-alice' : undefined),
      call: async (_connection: string, args: Record<string, unknown>) => {
        sent.push(args);
        if (typeof reply === 'function') (reply as () => never)();
        return reply;
      },
      logActivity: (row: { action: string; target: string; detail: string }) => {
        activity.push(row);
      },
      now: () => 500,
    },
  };
};

const payload = { peer_contract_id: PEER, exchange_ref: REF, label: 'review:contract' };
const answer = { option: 'yes', answered_at: 400 };

describe('§ 234.4 — carrying the owner\'s answer home', () => {
  it('an accepted answer is sent once and filed as answered', async () => {
    const h = harness({ accepted: true, resumed: true });
    await sendPeerAnswerHome(payload, answer, h.deps);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ exchange_ref: REF, answered: true, option: 'yes' });
    expect(h.activity.map((a) => a.action)).toEqual(['peer_ask_answered']);
  });

  it('§ 234.4e — the written reason travels with the decision', async () => {
    const h = harness({ accepted: true, resumed: true });
    await sendPeerAnswerHome(payload, { ...answer, note: 'the clause is unclear' }, h.deps);
    expect(h.sent[0]?.note).toBe('the clause is unclear');
  });

  it('⛔⛔ A REFUSAL IS NOT A DELIVERY — `not_solicited` is recorded as refused', async () => {
    // The asker's deadline already closed the conversation. Our owner DID
    // answer; the answer has nowhere to land. That must not read as delivered.
    const h = harness({ accepted: false, refusal: 'not_solicited', reason: 'no open conversation' });
    await sendPeerAnswerHome(payload, answer, h.deps);
    expect(h.activity.map((a) => a.action)).toEqual(['peer_ask_answer_refused']);
    expect(h.activity[0]?.detail).toContain('not_solicited');
  });

  it('⛔ and a permanent refusal does NOT throw — re-dispatching it forever fixes nothing', async () => {
    // The distinction the two branches encode: throwing leaves the ask
    // `answered` so the boot sweep retries, which is right for something that
    // may succeed later and wrong for a refusal that never will.
    const h = harness({ accepted: false, refusal: 'wrong_peer', reason: 'not who we asked' });
    await expect(sendPeerAnswerHome(payload, answer, h.deps)).resolves.toBeUndefined();
    expect(h.activity[0]?.action).toBe('peer_ask_answer_refused');
  });

  it('`already_answered` IS delivery — our answer is home, by this attempt or an earlier one', async () => {
    // ⚠ The one refusal that means success. A boot-sweep re-dispatch of an
    // answer that DID land arrives here, and filing it as refused would turn
    // idempotent recovery into a false alarm.
    const h = harness({ accepted: false, refusal: 'already_answered', reason: 'first wins' });
    await sendPeerAnswerHome(payload, answer, h.deps);
    expect(h.activity.map((a) => a.action)).toEqual(['peer_ask_answered']);
  });

  it('⛔ AN UNRECOGNISED ANSWER IS UNDELIVERED, NOT DELIVERED — the positive is what counts', async () => {
    // A door that changed, a tool error, a shape nobody anticipated. Enumerating
    // refusals is how you miss the next one, so anything that is not an explicit
    // acceptance throws — leaving the ask `answered` for the boot sweep.
    const h = harness({ some: 'shape we have never seen' });
    await expect(sendPeerAnswerHome(payload, answer, h.deps)).rejects.toThrow(/did not accept/);
    expect(h.activity).toHaveLength(0);
  });

  it('a transport failure throws, so the owner\'s decision survives for the boot sweep', async () => {
    const h = harness((() => { throw new Error('ECONNREFUSED'); }) as () => never);
    await expect(sendPeerAnswerHome(payload, answer, h.deps)).rejects.toThrow(/ECONNREFUSED/);
    expect(h.activity).toHaveLength(0);
  });

  it('⛔ no connection reaches the peer ⇒ throw BEFORE sending, never a silent drop', async () => {
    const h = harness({ accepted: true });
    await expect(
      sendPeerAnswerHome({ ...payload, peer_contract_id: 'ctr_stranger' }, answer, h.deps),
    ).rejects.toThrow(/no connection reaches peer contract/);
    expect(h.sent).toHaveLength(0);
  });
});

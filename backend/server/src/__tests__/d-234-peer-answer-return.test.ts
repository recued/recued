/** D-234 § 234.4 — the return leg's gate.
 *
 *  Going out, the gate is EXPOSURE. Coming back it is CORRELATION, and this file
 *  is the whole of it: an answer is admitted iff WE opened that conversation,
 *  the caller is the peer we addressed it to, and the option is one we offered.
 *
 *  ⚠ Every refusal here is asserted BY CODE, not merely by "it didn't accept" —
 *  four distinct codes exist precisely so a peer can tell "you never asked me
 *  this" from "that is not one of the options", and collapsing them is the § 30
 *  mistake this arc has now made once already. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { receiveAnswer } from '../peer-answer-return.js';
import { PEER_HOLD_ABANDONER } from '../peer-hold-abandoner.js';
import { createPeerAnswerStore } from '../storage/peer-answer-store.js';
import { createPeerAskOutboxStore } from '../storage/peer-ask-outbox-store.js';

const REF = 'ref-1';
const PEER = 'ctr_bob';

const setup = (over: { openRow?: boolean; actionRef?: string } = {}) => {
  const db = new Database(':memory:');
  const outbox = createPeerAskOutboxStore(db);
  const answers = createPeerAnswerStore(db);
  if (over.openRow !== false) {
    const row = {
      exchange_ref: REF,
      run_id: 'run_1',
      gated_step_id: 'verdict',
      connection: 'peer-bob',
      label: 'review:contract',
      offered: ['yes', 'no'],
      created_at: 1,
    } as const;
    if (over.actionRef === undefined) {
      outbox.open(row);
    } else {
      outbox.stage({
        ...row,
        checkpoint_id: 'peer-checkpoint-1',
        action_ref: over.actionRef,
        delivery: {
          recipient_fingerprint: 'peer-bob-fingerprint',
          spec: {
            connection: row.connection,
            label: row.label,
            question: 'Approve this?',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
            on_timeout: 'wait',
            via: 'direct',
          },
        },
      });
      outbox.activate(REF);
      outbox.markDelivered(REF);
    }
  }
  const resumed: { run_id: string; gated_step_id: string }[] = [];
  return {
    outbox,
    answers,
    resumed,
    deps: {
      outbox,
      answers,
      contractForConnection: (c: string) => (c === 'peer-bob' ? PEER : undefined),
      resume: async (row: { run_id: string; gated_step_id: string }) => {
        resumed.push(row);
      },
      now: () => 100,
    },
  };
};

describe('§ 234.4 — an answer coming home', () => {
  it('accepts the answer we asked for, records it, resumes, and closes the conversation', async () => {
    const s = setup();
    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      s.deps,
    );
    expect(r).toEqual({ accepted: true, resumed: true });
    expect(s.answers.get(REF)?.option).toBe('yes');
    // ⛔ CLOSED — a conversation that has been answered must stop advertising
    // itself as open, or the "what am I waiting on" surface lies.
    expect(s.outbox.get(REF)).toBeNull();
    expect(s.resumed).toEqual([{
      run_id: 'run_1',
      gated_step_id: 'verdict',
      exchange_ref: REF,
    }]);
  });

  it('acknowledges an exact durable replay after the completed route is closed', async () => {
    const s = setup();
    const input = {
      peer_contract_id: PEER,
      exchange_ref: REF,
      raw: { answered: true, option: 'yes', note: 'same words', at: 50 },
    };
    await expect(receiveAnswer(input, s.deps)).resolves.toEqual({
      accepted: true,
      resumed: true,
    });
    expect(s.outbox.get(REF)).toBeNull();

    await expect(receiveAnswer(input, s.deps)).resolves.toMatchObject({
      accepted: false,
      refusal: 'already_answered',
    });
    expect(s.resumed).toHaveLength(1);
  });

  it('keeps every non-identical missing-route answer indistinguishable as not solicited', async () => {
    const s = setup();
    await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes', at: 50 } },
      s.deps,
    );

    for (const input of [
      { peer_contract_id: 'ctr_mallory', exchange_ref: REF, raw: { answered: true, option: 'yes', at: 50 } },
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'no', at: 50 } },
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes', at: 51 } },
      { peer_contract_id: PEER, exchange_ref: 'never-opened', raw: { answered: true, option: 'yes', at: 50 } },
    ]) {
      await expect(receiveAnswer(input, s.deps)).resolves.toMatchObject({
        accepted: false,
        refusal: 'not_solicited',
      });
    }
    expect(s.resumed).toHaveLength(1);
  });

  it('⛔ REFUSES A REF WE NEVER OPENED — nothing recorded, nothing resumed', async () => {
    // The unsolicited-push case. Without the outbox row there is no evidence
    // this server ever asked, and an answer to a question nobody asked must not
    // be able to resume anything.
    const s = setup({ openRow: false });
    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      s.deps,
    );
    expect(r).toMatchObject({ accepted: false, refusal: 'not_solicited' });
    expect(s.answers.get(REF)).toBeNull();
    expect(s.resumed).toEqual([]);
  });

  it('⛔⛔ REFUSES A DIFFERENT PEER ANSWERING OUR CONVERSATION', async () => {
    // THE ONE THAT MATTERS MOST. The ref is a lookup key, never a credential
    // (§ 234.2) — so knowing it must not be enough. Authentication is that the
    // answer arrives from the contract the connection we ASKED THROUGH is bound
    // to; without this clause any enrolled peer could answer any other peer's
    // question by naming its ref.
    const s = setup();
    const r = await receiveAnswer(
      { peer_contract_id: 'ctr_mallory', exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      s.deps,
    );
    expect(r).toMatchObject({ accepted: false, refusal: 'wrong_peer' });
    expect(s.answers.get(REF)).toBeNull();
    expect(s.resumed).toEqual([]);
    // …and the conversation stays OPEN, so the peer we did ask can still answer.
    expect(s.outbox.get(REF)).not.toBeNull();
  });

  it('⛔ REFUSES AN OPTION WE NEVER OFFERED', async () => {
    // A peer that could name its own option would be choosing an outcome their
    // owner was never shown. The offered set is read off OUR row, not theirs.
    const s = setup();
    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'approve_and_send' } },
      s.deps,
    );
    expect(r).toMatchObject({ accepted: false, refusal: 'unreadable' });
    expect(s.resumed).toEqual([]);
  });

  it('§ 234.4e — carries the WRITTEN REASON through to the store', async () => {
    // The wire→store hop for the note. The drive proves collection + wire and
    // the pause test proves store→`{{step.verdict.note}}`; this is the join
    // between them, and without it the three legs never meet in any test.
    const s = setup();
    const r = await receiveAnswer(
      {
        peer_contract_id: PEER,
        exchange_ref: REF,
        raw: { answered: true, option: 'no', note: 'the penalty clause is not fine' },
      },
      s.deps,
    );
    expect(r).toEqual({ accepted: true, resumed: true });
    expect(s.answers.get(REF)?.note).toBe('the penalty clause is not fine');
  });

  it('⚠ a note is bounded — the far side wrote it', async () => {
    const s = setup();
    await receiveAnswer(
      {
        peer_contract_id: PEER,
        exchange_ref: REF,
        raw: { answered: true, option: 'yes', note: 'x'.repeat(5000) },
      },
      s.deps,
    );
    // `parsePeerAnswer` caps at PEER_ASK_QUESTION_MAX (600) on entry — a hostile
    // or merely verbose correspondent cannot write 5 KB into our answer row.
    expect((s.answers.get(REF)?.note ?? '').length).toBe(600);
  });

  it('carries a no-answer with its reason — `answered: false` is an ordinary outcome', async () => {
    const s = setup();
    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: false, unanswered_because: 'declined' } },
      s.deps,
    );
    expect(r).toEqual({ accepted: true, resumed: true });
    expect(s.answers.get(REF)).toMatchObject({ answered: false, unanswered_because: 'declined' });
  });

  it('first answer wins — a duplicate delivery is not a second answer', async () => {
    // At-least-once delivery is the norm on this path (the notification block
    // re-dispatches unanswered handlers at boot), so a redelivery must be inert
    // rather than resuming the run twice.
    const s = setup();
    await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      { ...s.deps, resume: async () => { throw new Error('interrupted'); } },
    );
    // The retry anchor remains open because the first continuation failed.
    const again = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'no' } },
      s.deps,
    );
    expect(again).toMatchObject({ accepted: false, refusal: 'already_answered' });
    expect(s.answers.get(REF)?.option).toBe('yes');
    expect(s.resumed).toHaveLength(1);
  });

  it('keeps the outbox retry anchor after resume failure and an exact replay finishes it', async () => {
    // Refusing here would tell the peer their answer was rejected when we have
    // in fact kept it, and they would reasonably send it again.
    const s = setup();
    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      { ...s.deps, resume: async () => { throw new Error('boom'); } },
    );
    expect(r).toEqual({ accepted: true, resumed: false });
    expect(s.answers.get(REF)?.option).toBe('yes');
    expect(s.outbox.get(REF)).not.toBeNull();

    const retried = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      s.deps,
    );
    expect(retried).toEqual({ accepted: true, resumed: true });
    expect(s.resumed).toEqual([{
      run_id: 'run_1',
      gated_step_id: 'verdict',
      exchange_ref: REF,
    }]);
    expect(s.outbox.get(REF)).toBeNull();
  });

  it('single-flights concurrent exact deliveries into one resume', async () => {
    const s = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const resume = vi.fn(async () => { await held; });
    const deps = { ...s.deps, resume };

    const first = receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes', at: 50 } },
      deps,
    );
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    const second = receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes', at: 50 } },
      deps,
    );
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(1);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { accepted: true, resumed: true },
      { accepted: true, resumed: true },
    ]);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(s.outbox.get(REF)).toBeNull();
  });

  it('reconciles the peer handoff receipt before resuming and closing', async () => {
    const s = setup({ actionRef: 'action-1' });
    const order: string[] = [];
    const gatedActions = {
      get: vi.fn(async () => ({
        action_ref: 'action-1',
        run_id: 'run_1',
        gated_step_id: 'verdict',
        current_checkpoint_id: 'peer-checkpoint-1',
      })),
      confirmPeerHandoff: vi.fn(async () => {
        order.push('receipt');
        return {
          status: 'dispatched' as const,
          handoff: { kind: 'peer_exchange', ref: REF },
        };
      }),
    };
    const originalClose = s.outbox.close.bind(s.outbox);
    vi.spyOn(s.outbox, 'close').mockImplementation((ref) => {
      order.push('close');
      return originalClose(ref);
    });

    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      {
        ...s.deps,
        gatedActions,
        resume: async () => { order.push('resume'); },
      },
    );

    expect(r).toEqual({ accepted: true, resumed: true });
    expect(order).toEqual(['receipt', 'resume', 'close']);
    expect(gatedActions.get).toHaveBeenCalledWith('action-1');
    expect(gatedActions.confirmPeerHandoff).toHaveBeenCalledWith('action-1', {
      run_id: 'run_1',
      gated_step_id: 'verdict',
      exchange_ref: REF,
      status_message: expect.any(String),
    });
  });

  it('continues a late authenticated answer without rewriting a terminal receipt', async () => {
    const s = setup({ actionRef: 'action-1' });
    const resume = vi.fn(async () => undefined);

    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      {
        ...s.deps,
        resume,
        gatedActions: {
          get: async () => ({
            action_ref: 'action-1',
            run_id: 'run_1',
            gated_step_id: 'verdict',
            current_checkpoint_id: 'peer-checkpoint-1',
          }),
          confirmPeerHandoff: async () => ({ status: 'in_doubt' }),
        },
      },
    );

    expect(r).toEqual({ accepted: true, resumed: true });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(s.outbox.get(REF)).toBeNull();
  });

  it('retains the retry anchor when receipt reconciliation remains nonterminal', async () => {
    const s = setup({ actionRef: 'action-1' });
    const resume = vi.fn(async () => undefined);

    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      {
        ...s.deps,
        resume,
        gatedActions: {
          get: async () => ({
            action_ref: 'action-1',
            run_id: 'run_1',
            gated_step_id: 'verdict',
            current_checkpoint_id: 'peer-checkpoint-1',
          }),
          confirmPeerHandoff: async () => ({ status: 'dispatching' }),
        },
      },
    );

    expect(r).toEqual({ accepted: true, resumed: false });
    expect(resume).not.toHaveBeenCalled();
    expect(s.outbox.get(REF)).not.toBeNull();
  });

  it('does not reconcile or resume through a receipt owned by another checkpoint', async () => {
    const s = setup({ actionRef: 'action-1' });
    const resume = vi.fn(async () => undefined);
    const confirmPeerHandoff = vi.fn(async () => ({ status: 'dispatched' as const }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      {
        ...s.deps,
        resume,
        gatedActions: {
          get: async () => ({
            action_ref: 'action-1',
            run_id: 'run_1',
            gated_step_id: 'verdict',
            current_checkpoint_id: 'later-checkpoint',
          }),
          confirmPeerHandoff,
        },
      },
    );

    expect(r).toEqual({ accepted: true, resumed: false });
    expect(confirmPeerHandoff).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(s.outbox.get(REF)).not.toBeNull();
    warn.mockRestore();
  });

  it('does not borrow a same-subject receipt for a legacy row with no action ref', async () => {
    const s = setup();
    const get = vi.fn(async () => ({
      action_ref: 'later-action',
      run_id: 'run_1',
      gated_step_id: 'verdict',
      current_checkpoint_id: 'later-checkpoint',
    }));
    const confirmPeerHandoff = vi.fn(async () => ({ status: 'dispatched' as const }));

    await expect(receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      { ...s.deps, gatedActions: { get, confirmPeerHandoff } },
    )).resolves.toEqual({ accepted: true, resumed: true });

    expect(get).not.toHaveBeenCalled();
    expect(confirmPeerHandoff).not.toHaveBeenCalled();
    expect(s.outbox.get(REF)).toBeNull();
  });

  it('does not steal a local abandonment claim or resume its deleted dish', async () => {
    const s = setup();
    s.answers.record({
      exchange_ref: REF,
      peer_contract_id: PEER_HOLD_ABANDONER,
      answered: false,
      unanswered_because: 'withdrawn',
      at: 90,
    });

    const r = await receiveAnswer(
      { peer_contract_id: PEER, exchange_ref: REF, raw: { answered: true, option: 'yes' } },
      s.deps,
    );

    expect(r).toMatchObject({ accepted: false, refusal: 'not_solicited' });
    expect(s.resumed).toHaveLength(0);
    expect(s.outbox.get(REF)).not.toBeNull();
    expect(s.answers.get(REF)).toMatchObject({
      peer_contract_id: PEER_HOLD_ABANDONER,
      unanswered_because: 'withdrawn',
    });
  });
});

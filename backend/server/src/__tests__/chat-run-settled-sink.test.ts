/** ⛔⛔ THE SINK CARRIES TWO AUTHORITY DECISIONS and they must not rest on
 *  review. Which corpus a settled run's row lands in, and which session it
 *  belongs to, are both derived from the ORIGINATING execution source — the one
 *  the preflight resumer recovers off the paused audit anchor, not the one
 *  belonging to whoever clicked approve. Get that wrong and a door's customer
 *  writes into the owner's corpus, or the owner's result lands in a door's. */
import { describe, expect, it } from 'vitest';
import { planRunSettledRow } from '../chat-run-settled-sink.js';

const settled = (over: Record<string, unknown> = {}) => ({
  execution_source: {
    channel: 'chat', actor: 'user_self',
    chat_session_id: 'sess-1', user_id: 'local',
  },
  run_id: 'run-77',
  tool_name: 'acme/send-invoice',
  result: { sent: true },
  ts: 99_000,
  ...over,
} as never);

describe('planRunSettledRow', () => {
  it.each([
    { success: false, awaiting_approval: true },
    { success: false, awaiting_peer: true },
    { ok: true, run_held: { kind: 'approval' } },
  ])('does not close a call that pauses again: %j', result => {
    expect(planRunSettledRow(settled({ result }))).toBeNull();
  });

  it('writes into the session that ASKED, keyed on the run', () => {
    const plan = planRunSettledRow(settled());
    expect(plan).not.toBeNull();
    expect(plan!.session_id).toBe('sess-1');
    expect(plan!.pair_id).toBe('run-77');
    expect(plan!.ts).toBe(99_000);
  });

  it('⛔⛔ carries the ORIGINATING turn, so the pair survives a turn window', () => {
    // The dispatch row has always carried `turn_id`; the settle row did not,
    // so a turn-scoped recall admitted the ASK and excluded the ANSWER —
    // exactly backwards. The originating turn is also right on its own terms:
    // a late settle may land with no turn open at all, and the exchange it
    // completes belongs to the turn that started it.
    const plan = planRunSettledRow(settled({
      execution_source: {
        channel: 'chat', actor: 'user_self',
        chat_session_id: 'sess-1', user_id: 'local', turn_id: 'turn-7',
      },
    }));
    expect(plan!.turn_id).toBe('turn-7');
  });

  it('⚠ a source with no turn yields null rather than a guess', () => {
    // Such a row is unreachable by the windowed scan — but still arrives
    // through its ask, because the pair fetch is exempt from the window.
    expect(planRunSettledRow(settled())!.turn_id).toBeNull();
  });

  it('⛔⛔ REFUSES a contracted source — a door has no dispatch half to pair', () => {
    // A door's tool results are never written, so a settle half for one would
    // be an orphan: a result with no ask, reading as an outcome nobody
    // requested. And it would be a cross-tenant write into that door's corpus.
    expect(planRunSettledRow(settled({
      execution_source: {
        channel: 'chat', actor: 'contracted_user',
        chat_session_id: 'sess-1', user_id: 'customer', contract_id: 'door-a',
      },
    }))).toBeNull();
  });

  it('⛔ REFUSES a non-chat source — messenger has no chat session to write to', () => {
    expect(planRunSettledRow(settled({
      execution_source: {
        channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1',
      },
    }))).toBeNull();
  });

  it('⚠ REFUSES rather than guessing when the session cannot be named', () => {
    // A settle whose session is unresolvable is a row with no conversation to
    // belong to. Inventing one would put a real result in front of the wrong
    // person on their next recall.
    for (const source of [
      { channel: 'chat', actor: 'user_self', user_id: 'local' },
      { channel: 'chat', actor: 'user_self', chat_session_id: '', user_id: 'local' },
      undefined,
      { nonsense: true },
    ]) {
      expect(planRunSettledRow(settled({ execution_source: source })), JSON.stringify(source))
        .toBeNull();
    }
  });

  it('⚠ REFUSES an empty run id — an unpairable half is worse than none', () => {
    expect(planRunSettledRow(settled({ run_id: '' }))).toBeNull();
  });
});

/** ⛔⛔ A DENIAL IS TERMINAL AND CLOSES THE PAIR. Only the approve path was
 *  hooked at first, so a rejected run kept nothing but its dispatch row and
 *  recall reported "I asked to email Pat" indefinitely — reading as STILL
 *  PENDING. A stale answer is worse than a missing one: the model would tell
 *  the owner something awaits their approval that they declined weeks ago. */
describe('a denied run settles too', () => {
  it('plans a row under the ORIGINATING source, keyed on the same run', () => {
    const plan = planRunSettledRow({
      execution_source: {
        channel: 'chat', actor: 'user_self',
        chat_session_id: 'sess-1', user_id: 'local',
      },
      run_id: 'run-99',
      tool_name: 'acme/send-invoice',
      result: { denied: true, message: 'The owner denied the pending action.' },
      ts: 120_000,
    } as never);
    expect(plan).not.toBeNull();
    // Same key as the dispatch half, so the two join.
    expect(plan!.pair_id).toBe('run-99');
    expect(JSON.stringify(plan!.result)).toContain('denied');
  });

  it('⛔ a denial for a CONTRACTED source is still refused', () => {
    // The deny path must not become a back door into a corpus the approve path
    // refuses — a door has no dispatch half for it to pair with either way.
    expect(planRunSettledRow({
      execution_source: {
        channel: 'chat', actor: 'contracted_user',
        chat_session_id: 'sess-1', user_id: 'customer', contract_id: 'door-a',
      },
      run_id: 'run-99',
      tool_name: 'acme/send-invoice',
      result: { denied: true },
      ts: 120_000,
    } as never)).toBeNull();
  });
});

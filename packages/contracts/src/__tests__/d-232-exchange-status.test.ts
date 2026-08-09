/** D-232 § 23 — what happened to my letter. */
import { describe, expect, it } from 'vitest';
import { deriveExchangeStatus, type ExchangeStatusRow } from '../source-primitive.js';

const classify = (errors: readonly unknown[]) => ({
  kind: 'unavailable' as const,
  reason: String((errors[0] as { message?: string } | undefined)?.message ?? ''),
});
const CB = 'peer-project-update-reply';
const row = (recipe_id: string, status: string, errors?: unknown[]): ExchangeStatusRow =>
  ({ recipe_id, status, ...(errors ? { errors } : {}) });

/** D-232 § 30 — a row carrying what the PEER said on its own tool result. */
const refused = (
  recipe_id: string,
  kind?: 'config' | 'policy' | 'unavailable' | 'error',
): ExchangeStatusRow => ({
  recipe_id,
  status: 'succeeded',
  peer_ack: {
    ref: 'r',
    accepted: false,
    ...(kind !== undefined ? { kind } : {}),
    reason: 'their outbound connection is not bound',
    ...(kind === 'unavailable' ? { retrying: true } : {}),
  },
});

describe('D-232 § 23 — exchange delivery status', () => {
  it('nothing filed under the ref is `unknown`, not `awaiting`', () => {
    // ⚠ The distinction matters: `awaiting` invites patience, `unknown` invites
    // checking the ref. Reporting an unsent exchange as awaiting would have the
    // caller wait forever for something that was never posted.
    expect(deriveExchangeStatus('r', [], CB, classify))
      .toMatchObject({ status: 'unknown', runs: 0 });
  });

  it('sent with nothing back is `awaiting` — not a failure', () => {
    // The state an exchange spends most of its life in. The peer's owner may
    // legitimately take days; § 21's whole point is that this is not an error.
    const out = deriveExchangeStatus('r', [
      row('request-peer-project-update', 'succeeded'),
      row('run-ingredient', 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('awaiting');
  });

  it('the callback landing makes it `answered`', () => {
    const out = deriveExchangeStatus('r', [
      row('request-peer-project-update', 'succeeded'),
      row('run-ingredient', 'succeeded'),
      row(CB, 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('answered');
  });

  it("⛔ a run that is not the CALLBACK is never an answer", () => {
    /** Both servers file under the same ref, so on the ASKER's server the rows
     *  already include her own asking recipe and her own carrier. Counting "some
     *  other succeeded run" as the answer would report every exchange answered
     *  the moment it was sent — the failure mode this argument names. */
    const out = deriveExchangeStatus('r', [
      row('request-peer-project-update', 'succeeded'),
      row('run-ingredient', 'succeeded'),
      row('something-else-entirely', 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('awaiting');
  });

  it('⛔⛔ a FAILED declaring run is still DELIVERED — only the carrier says otherwise', () => {
    /** THE ONE MOST LIKELY TO BE GOT WRONG. § 19.4 fires a failed run's answer
     *  deliberately ("a reply is always owed"), so the declaring run failing is
     *  routine and says nothing about delivery. Reading any failure as
     *  undeliverable would report a DELIVERED REFUSAL as a LOST LETTER — the
     *  precise confusion § 21 spent four commits removing. */
    const out = deriveExchangeStatus('r', [
      row('peer-apply-project-update', 'failed', [{ message: 'refused' }]),
      row('run-ingredient', 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('awaiting');
  });

  it('a failed CARRIER is `undeliverable`, classified', () => {
    const out = deriveExchangeStatus('r', [
      row('request-peer-project-update', 'succeeded'),
      row('run-ingredient', 'failed', [{ code: 'NETWORK_ERROR', message: 'ECONNREFUSED' }]),
    ], CB, classify);
    expect(out).toMatchObject({ status: 'undeliverable', kind: 'unavailable' });
    expect(out.reason).toContain('ECONNREFUSED');
  });

  it('⛔ accepts the WIRE NAME the caller actually holds, not just the bare id', () => {
    /** The caller passes the `callback_op` from their own `output.exchange`,
     *  which is `<publisher>/<recipe_id>`; audit rows carry the bare id. Raw
     *  comparison reports `awaiting` for an answered exchange — it looks like
     *  patience is warranted when the answer already arrived. Every earlier test
     *  here passed the bare id because I wrote both sides; a recipe calling it
     *  for real is what exposed this. */
    const rows = [row('run-ingredient', 'succeeded'), row(CB, 'succeeded')];
    expect(deriveExchangeStatus('r', rows, `recued-core/${CB}`, classify).status).toBe('answered');
    expect(deriveExchangeStatus('r', rows, CB, classify).status).toBe('answered');
  });

  it('an answer outranks a failed carrier — a retry that eventually landed', () => {
    const out = deriveExchangeStatus('r', [
      row('run-ingredient', 'failed', [{ message: 'first attempt died' }]),
      row(CB, 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('answered');
  });

  // ── D-232 § 30 — delivered, and the peer cannot reply ──────────────

  it('✅✅ § 30 — a peer that REFUSED to reply is `unanswerable`, never `awaiting`', () => {
    /** THE WHOLE POINT. Before § 30 this exact row set read `awaiting`: the
     *  carrier succeeded (it did — the message arrived), no callback landed, and
     *  the verdict the peer had already handed us was nowhere in the fold. The
     *  caller was told to be patient about a conversation that had ended. */
    const out = deriveExchangeStatus('r', [
      refused('request-peer-project-update', 'config'),
      row('run-ingredient', 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('unanswerable');
    expect(out.kind).toBe('config');
    expect(out.reason).toContain('not bound');
  });

  it('⛔⛔ § 30 — `unanswerable` is NOT `undeliverable`, and the difference is a RETRY', () => {
    /** Our letter ARRIVED. Calling that undeliverable would be false about the
     *  delivery AND would arm `planExchangeRetry`, which fires on exactly
     *  `undeliverable` + a retryable kind — re-sending OUR ask because THEIR
     *  reply failed, making the peer act twice on one request. Pinned as a
     *  literal so a future edit cannot quietly fold the two states together. */
    const out = deriveExchangeStatus('r', [
      refused('request-peer-project-update', 'unavailable'),
      row('run-ingredient', 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('unanswerable');
    expect(out.status).not.toBe('undeliverable');
  });

  it('⛔ § 30 — OUR carrier failing outranks THEIR reply failing', () => {
    /** Both are "no answer is coming", but only one is fixable by re-sending,
     *  and only the carrier's failure means our message never left. If both are
     *  somehow present the more fundamental one wins. */
    const out = deriveExchangeStatus('r', [
      refused('request-peer-project-update', 'unavailable'),
      row('run-ingredient', 'failed', [{ message: 'ECONNREFUSED' }]),
    ], CB, classify);
    expect(out.status).toBe('undeliverable');
  });

  it('⛔ § 30 — an ANSWER outranks an earlier "I cannot reply"', () => {
    /** A peer whose outbound was down when they received us may fix it and
     *  answer later. The answer is ground truth; the verdict was a snapshot. */
    const out = deriveExchangeStatus('r', [
      refused('request-peer-project-update', 'unavailable'),
      row('run-ingredient', 'succeeded'),
      row(CB, 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('answered');
  });

  it('⛔ § 30 — a peer that ACCEPTED changes nothing; only a refusal is a verdict', () => {
    /** `accepted: true` is the ordinary case and must stay `awaiting` — the
     *  answer is still coming. Reading any peer ack as terminal would end every
     *  healthy exchange the moment it was sent. */
    const out = deriveExchangeStatus('r', [
      { recipe_id: 'request-peer-project-update', status: 'succeeded',
        peer_ack: { ref: 'r', accepted: true } },
      row('run-ingredient', 'succeeded'),
    ], CB, classify);
    expect(out.status).toBe('awaiting');
  });
});
